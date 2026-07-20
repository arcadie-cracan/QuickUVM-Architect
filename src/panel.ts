// The webview panel with the diagram: a single reused panel, with
// retainContextWhenHidden (docs/01). The host is the sole authority on
// files; the webview requests actions through `action/request` (docs/05), which
// the panel dispatches to the handler received from extension.ts.

import * as vscode from "vscode";
import { resolveLocPath } from "./filelistops";
import { Loc, ProjectModel } from "./model";
import type { QuvmConfig } from "./quickuvm";
import {
  ActionKind,
  GenerateStatus,
  HostMessage,
  LassoMode,
  OverlayConfig,
  SidecarData,
  StatusDeco,
  ViewMode,
  WebviewMessage,
  XprobeTarget,
} from "./protocol";

/** the narrow interface to LayoutStore (the layout sidecar, docs/04) */
export interface LayoutDeps {
  get(): SidecarData;
  positionsSnapshotted(
    viewId: string,
    nodes: Record<string, { x: number; y: number }>
  ): void;
  foldToggled(viewId: string, foldId: string, collapsed: boolean): void;
  nodeFlipped(
    viewId: string,
    nodeId: string,
    flipH: boolean,
    flipV: boolean
  ): void;
  relayout(viewId: string): void;
  netRender(viewId: string, net: string, render: "wire" | "label"): void;
}

export interface PanelDeps {
  getModel: () => ProjectModel | undefined;
  getOverlay: () => OverlayConfig | null;
  /** the parsed configuration + its path, for the verification (TB) view */
  getConfig?: () => { configPath: string | null; config: QuvmConfig };
  /** the quick-uvm status decorations (docs/05): validations + the last generate */
  getStatus?: () => { decos: StatusDeco[]; generate: GenerateStatus | null };
  /** the layout sidecar; absent only in tests */
  layout?: LayoutDeps;
  /** the configuration actions; openSource stays handled in the panel */
  onAction: (
    action: ActionKind,
    args: Record<string, unknown>,
    viewId: string | undefined
  ) => void;
  /** the selection from the diagram (ids relative to the view) — for
   *  the synchronization with the hierarchy (docs/05); `mode` distinguishes the symbol from the schematic
   *  at reveal (the "top module" root vs the instance node) */
  onSelection?: (
    ids: string[],
    viewId: string | undefined,
    mode?: ViewMode
  ) => void;
  /** local level navigation in the verification (TB) view (D24): the host
   *  keeps the current level and highlights in the verification tree */
  onTbFocus?: (focus: string, select: string | null) => void;
}

const EMPTY_OVERLAY: OverlayConfig = {
  dut: null,
  configPath: null,
  agents: [],
  roles: {},
  coverage: { total: 0, mapped: 0, unmapped: [] },
  orphans: [],
};

// The ACTIVE exporter: the palette command must export the visible diagram
// tab (RTL/TB panel OR the per-file editor of `*.quickuvm.yaml`), NOT a
// background panel — otherwise the export also ran when the Welcome tab
// or a source file was active (a regression caught at validation). Each surface
// registers when it becomes `active` and is removed when it loses focus/disappears;
// the token identity keeps the clear precise (does not remove another exporter).
let activeExporter: { run: () => void } | undefined;
export function setActiveExporter(e: { run: () => void }): void {
  activeExporter = e;
}
export function clearActiveExporter(e: { run: () => void }): void {
  if (activeExporter === e) {
    activeExporter = undefined;
  }
}
/** exports the active diagram tab; false if none is active */
export function runActiveExport(): boolean {
  if (activeExporter) {
    activeExporter.run();
    return true;
  }
  return false;
}

export class DiagramPanel {
  static current: DiagramPanel | undefined;

  /** Creates or brings the panel to the front and requests the given view. */
  static show(
    context: vscode.ExtensionContext,
    deps: PanelDeps,
    viewId?: string,
    mode?: ViewMode,
    select?: string[]
  ): DiagramPanel {
    if (!DiagramPanel.current) {
      DiagramPanel.current = new DiagramPanel(context, deps);
    }
    const p = DiagramPanel.current;
    p.panel.reveal(vscode.ViewColumn.Active, true);
    if (viewId) {
      p.showView(viewId, mode, select);
    }
    return p;
  }

  private readonly panel: vscode.WebviewPanel;
  private ready = false;
  private pendingView:
    | { viewId: string; mode?: ViewMode; select?: string[] }
    | undefined;
  currentView: string | undefined;
  /** the current mode of the RTL view (symbol/schematic) — for the
   *  correct reveal of the "top module" root vs the instance node (docs/05) */
  currentMode: ViewMode | undefined;
  /** the current selection from the webview (IDs relative to the current view) */
  selection: string[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: PanelDeps
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "quickuvm.diagram",
      "QuickUVM Architect",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "dist"),
          vscode.Uri.joinPath(context.extensionUri, "media"),
        ],
      }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m: WebviewMessage) =>
      this.onMessage(m)
    );
    // active exporter: only when THIS panel is the visible tab (docs/05)
    setActiveExporter(this.exporter);
    this.panel.onDidChangeViewState(() => {
      if (this.panel.active) {
        setActiveExporter(this.exporter);
      } else {
        clearActiveExporter(this.exporter);
      }
    });
    this.panel.onDidDispose(() => {
      clearActiveExporter(this.exporter);
      DiagramPanel.current = undefined;
    });
  }

  private readonly exporter = { run: (): void => this.requestExport() };

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  postModel(model: ProjectModel): void {
    if (this.ready) {
      this.post({ v: 1, type: "model/full", model });
    }
  }

  postStale(errors: number): void {
    if (this.ready) {
      this.post({ v: 1, type: "model/stale", errors });
    }
  }

  postTheme(): void {
    if (this.ready) {
      this.post({ v: 1, type: "theme/changed" });
    }
  }

  postOverlay(overlay: OverlayConfig | null): void {
    if (this.ready) {
      this.post({ v: 1, type: "overlay/config", ...(overlay ?? EMPTY_OVERLAY) });
    }
  }

  /** the configuration for the verification (TB) view (docs/05): at ready and on
   *  any change of the YAML */
  postConfig(): void {
    if (this.ready) {
      const c = this.deps.getConfig?.();
      if (c) {
        this.post({ v: 1, type: "config/full", ...c });
      }
    }
  }

  /** sidecar changed outside the current gesture (external/invalidation/cleanup) */
  postLayout(sidecar: SidecarData): void {
    if (this.ready) {
      this.post({ v: 1, type: "layout/full", sidecar });
    }
  }

  /** the UI preferences from settings (docs/05): at ready and on changes */
  postUiConfig(): void {
    if (this.ready) {
      const cfg = vscode.workspace.getConfiguration("quickuvm");
      const lasso: LassoMode =
        cfg.get<string>("lassoMode", "contain") === "intersect"
          ? "intersect"
          : "contain";
      const decorations = cfg.get<boolean>("schematicDecorations", true);
      this.post({ v: 1, type: "ui/config", lasso, decorations });
    }
  }

  private pendingTbNav: { focus: string; select: string | null } | undefined;

  /** level navigation in the verification (TB) view (D24): opens the level */
  navigateTb(focus: string, select: string | null): void {
    if (this.ready) {
      this.post({ v: 1, type: "tb/navigate", focus, select });
    } else {
      this.pendingTbNav = { focus, select };
    }
  }

  /** requests from the webview the SVG serialization of the current view (docs/05, phase 4) */
  requestExport(): void {
    if (this.ready) {
      this.post({ v: 1, type: "export/request" });
    }
  }

  /** the last cross-probing target sent, so we do not repost identically on
   *  every cursor move inside the same element */
  private lastProbe = "";

  /** the quick-uvm status decorations (docs/05): badges + the generate chip */
  postStatus(): void {
    const s = this.deps.getStatus?.();
    if (this.ready && s) {
      this.post({
        v: 1,
        type: "status/decorations",
        decos: s.decos,
        generate: s.generate,
      });
    }
  }

  /** editor->diagram cross-probing (docs/05): the .xprobe halo in the webview */
  postProbe(targets: XprobeTarget[]): void {
    if (!this.ready) {
      return; // without a ready panel there is no diagram to highlight
    }
    const key = JSON.stringify(targets);
    if (key === this.lastProbe) {
      return;
    }
    this.lastProbe = key;
    this.post({ v: 1, type: "probe/highlight", targets });
  }

  showView(viewId: string, mode?: ViewMode, select?: string[]): void {
    this.currentView = viewId;
    this.currentMode = mode;
    this.panel.title = `QuickUVM Architect — ${viewId}`;
    if (this.ready) {
      this.post({ v: 1, type: "view/show", viewId, mode });
      if (select?.length) {
        // reveal from the tree: the selection is applied after view/show — the render
        // triggered by view/show draws it (state.selection persists)
        this.post({ v: 1, type: "select/reveal", ids: select });
      }
    } else {
      this.pendingView = { viewId, mode, select };
    }
  }

  private onMessage(m: WebviewMessage): void {
    switch (m.type) {
      case "ready": {
        this.ready = true;
        // a reloaded webview has lost its cross-probing halo: without
        // resetting the dedupe, the next identical target would be swallowed and
        // the halo would no longer light up again (adversarial review of the synchronization)
        this.lastProbe = "";
        // the sidecar BEFORE the model (docs/05): the first render must
        // have the position seeds, otherwise an arranged view would flicker
        // first with the automatic layout
        if (this.deps.layout) {
          this.post({ v: 1, type: "layout/full", sidecar: this.deps.layout.get() });
        }
        const model = this.deps.getModel();
        if (model) {
          this.post({ v: 1, type: "model/full", model });
        }
        this.postUiConfig();
        this.postOverlay(this.deps.getOverlay());
        this.postConfig();
        this.postStatus(); // the status decorations (docs/05)
        if (this.pendingView) {
          const { select, ...vs } = this.pendingView;
          this.post({ v: 1, type: "view/show", ...vs });
          if (select?.length) {
            this.post({ v: 1, type: "select/reveal", ids: select });
          }
          this.pendingView = undefined;
        }
        if (this.pendingTbNav) {
          this.post({ v: 1, type: "tb/navigate", ...this.pendingTbNav });
          this.pendingTbNav = undefined;
        }
        break;
      }
      case "layout/snapshot":
        this.deps.layout?.positionsSnapshotted(m.viewId, m.nodes);
        break;
      case "export/result":
        void saveExportedSvg(m.viewId, m.svg);
        break;
      case "fold/toggled":
        this.deps.layout?.foldToggled(m.viewId, m.foldId, m.collapsed);
        break;
      case "node/flipped":
        this.deps.layout?.nodeFlipped(m.viewId, m.nodeId, m.flipH, m.flipV);
        break;
      case "net/render":
        this.deps.layout?.netRender(m.viewId, m.net, m.render);
        break;
      case "relayout/request":
        if (m.scope === "all") {
          this.deps.layout?.relayout(m.viewId);
        }
        break;
      case "select/changed":
        this.selection = m.ids;
        this.deps.onSelection?.(m.ids, this.currentView, this.currentMode);
        break;
      case "tb/focus":
        this.deps.onTbFocus?.(m.focus, m.select ?? null);
        break;
      case "nav/drill":
        // the webview navigated locally; the host keeps the title and the current view
        // up to date and aligns the hierarchy to the new view (docs/05); `mode` distinguishes
        // the top's symbol (root) from its schematic (the instance node)
        this.currentView = m.instancePath;
        this.currentMode = m.mode;
        this.panel.title = `QuickUVM Architect — ${m.instancePath}`;
        this.deps.onSelection?.([], m.instancePath, m.mode);
        break;
      case "action/request":
        if (m.action === "openSource") {
          void this.openSource(m.args);
        } else {
          this.deps.onAction(m.action, m.args, this.currentView);
        }
        break;
      default:
        // the messages declared but not yet implemented (phase 4, docs/04):
        // ports/reordered (level 2), edge/override (level 3) — they are ignored
        break;
    }
  }

  /**
   * Jump-to-source requested from the diagram: for a pin (`port`) the port
   * declaration is opened; without `port`, the definition of the view module.
   */
  private async openSource(args: Record<string, unknown>): Promise<void> {
    const model = this.deps.getModel();
    const viewId =
      typeof args.viewId === "string" ? args.viewId : this.currentView;
    if (!model || !viewId) {
      return;
    }
    const inst = model.instances.find((i) => i.path === viewId);
    const def = inst ? model.modules[inst.module] : undefined;
    if (!def) {
      return;
    }
    let loc: Loc | null = def.loc;
    if (typeof args.port === "string") {
      const p =
        def.ports.find((x) => x.name === args.port) ??
        def.iface_ports.find((x) => x.name === args.port);
      loc = p?.loc ?? loc;
    }
    if (!loc) {
      return;
    }
    if (args.peek === true) {
      // cross-probing on hover (phase 4): non-intrusive — only the editors
      // already visible; the quickuvm.hoverCrossProbe setting can turn it off
      const on = vscode.workspace
        .getConfiguration("quickuvm")
        .get<boolean>("hoverCrossProbe", true);
      if (on) {
        revealLocPeek(loc);
      }
      return;
    }
    await openLoc(loc);
  }

  private html(): string {
    return diagramHtml(this.panel.webview, this.context.extensionUri);
  }
}

/** The HTML of the diagram webview, shared by the panel and the CustomTextEditor. */
export function diagramHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.js")
  );
  const style = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "webview.css")
  );
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>QuickUVM Architect</title>
</head>
<body>
<div id="banner" hidden></div>
<header id="head"></header>
<div id="main">
  <svg id="canvas" xmlns="http://www.w3.org/2000/svg"></svg>
  <aside id="inspector"></aside>
</div>
<div id="empty">${vscode.l10n.t('Select an instance from the "Hierarchy" view.')}</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

/**
 * Saves the self-contained SVG exported by the webview (export/result, docs/05):
 * a save dialog with a name derived from the view, writing to disk. Shared by the panel
 * and the per-file editor (customeditor).
 */
export async function saveExportedSvg(
  viewId: string,
  svg: string
): Promise<void> {
  if (!svg) {
    // the view has nothing to draw (banner/welcome screen)
    void vscode.window.showInformationMessage(
      vscode.l10n.t("QuickUVM Architect: nothing to export in this view.")
    );
    return;
  }
  const root = vscode.workspace.workspaceFolders?.[0];
  const name = `${(viewId || "view").replace(/[^\w.-]+/g, "_")}.svg`;
  const uri = await vscode.window.showSaveDialog({
    defaultUri: root ? vscode.Uri.joinPath(root.uri, name) : undefined,
    filters: { SVG: ["svg"] },
  });
  if (!uri) {
    return; // cancelled
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(svg, "utf8"));
  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      "QuickUVM Architect: exported {0}",
      vscode.workspace.asRelativePath(uri, false)
    )
  );
}

// the state of cross-probing on hover: the decoration (created lazily, a single
// instance), the currently highlighted editor and the turn-off timer
let peekDecoration: vscode.TextEditorDecorationType | undefined;
let peekEditor: vscode.TextEditor | undefined;
let peekTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Cross-probing on hover (phase 4, docs/05): reveals `loc` ONLY in an
 * ALREADY visible editor — the hover does not open tabs and does not steal focus —
 * and briefly highlights the line (transient decoration, ~1.2s). The full jump
 * (opening + cursor) stays on double-click (openLoc).
 */
export function revealLocPeek(loc: Loc): void {
  const root = vscode.workspace.workspaceFolders?.[0];
  const abs = resolveLocPath(root?.uri.fsPath ?? "", loc.file);
  const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
  const editor = vscode.window.visibleTextEditors.find(
    (e) => norm(e.document.uri.fsPath) === norm(abs)
  );
  if (!editor) {
    return; // the file is not open: the hover stays without effect
  }
  peekDecoration ??= vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
  });
  const line = Math.max(0, loc.line - 1);
  const range = new vscode.Range(line, 0, line, 0);
  editor.revealRange(
    range,
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
  peekEditor?.setDecorations(peekDecoration, []);
  editor.setDecorations(peekDecoration, [range]);
  peekEditor = editor;
  if (peekTimer) {
    clearTimeout(peekTimer);
  }
  peekTimer = setTimeout(() => {
    if (peekDecoration) {
      peekEditor?.setDecorations(peekDecoration, []);
    }
    peekEditor = undefined;
  }, 1200);
}

/** Opens the file of a `loc` (relative to the workspace root) at the line. */
export async function openLoc(loc: Loc): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  // reconstructing the path relativized by slang: filelistops (pure, tested)
  const abs = resolveLocPath(root?.uri.fsPath ?? "", loc.file);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
  const pos = new vscode.Position(Math.max(0, loc.line - 1), 0);
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(pos, pos),
    preserveFocus: false,
  });
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
