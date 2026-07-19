// Panelul webview cu diagrama: un singur panel reutilizat, cu
// retainContextWhenHidden (docs/01). Host-ul e singura autoritate pe
// fisiere; webview-ul cere actiuni prin `action/request` (docs/05), pe care
// panelul le dispecerizeaza catre handler-ul primit din extension.ts.

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

/** interfata ingusta catre LayoutStore (sidecar-ul de layout, docs/04) */
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
  /** configuratia parsata + calea ei, pentru vederea de verificare */
  getConfig?: () => { configPath: string | null; config: QuvmConfig };
  /** decoratiile de stare quick-uvm (docs/05): validari + ultimul generate */
  getStatus?: () => { decos: StatusDeco[]; generate: GenerateStatus | null };
  /** sidecar-ul de layout; absent doar in teste */
  layout?: LayoutDeps;
  /** actiunile de configurare; openSource ramane tratat in panel */
  onAction: (
    action: ActionKind,
    args: Record<string, unknown>,
    viewId: string | undefined
  ) => void;
  /** selectia din diagrama (id-uri relative la vedere) — pentru
   *  sincronizarea cu ierarhia (docs/05); `mode` distinge simbolul de schema
   *  la reveal (radacina „top module" vs nodul instantei) */
  onSelection?: (
    ids: string[],
    viewId: string | undefined,
    mode?: ViewMode
  ) => void;
  /** navigare locala pe niveluri in vederea de verificare (D24): host-ul
   *  tine nivelul curent si evidentiaza in arborele de verificare */
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

// Exporter-ul ACTIV: comanda din paleta trebuie sa exporte tab-ul de diagrama
// vizibil (panou RTL/TB SAU editorul per-fisier al `*.quickuvm.yaml`), NU un
// panou din fundal — altfel exportul mergea si cand era activ tab-ul Welcome
// sau un fisier sursa (regresie prinsa la validare). Fiecare suprafata se
// inregistreaza cand devine `active` si se scoate cand pierde focusul/dispare;
// identitatea token-ului tine clear-ul precis (nu sterge un alt exporter).
let activeExporter: { run: () => void } | undefined;
export function setActiveExporter(e: { run: () => void }): void {
  activeExporter = e;
}
export function clearActiveExporter(e: { run: () => void }): void {
  if (activeExporter === e) {
    activeExporter = undefined;
  }
}
/** exporta tab-ul de diagrama activ; false daca niciunul nu e activ */
export function runActiveExport(): boolean {
  if (activeExporter) {
    activeExporter.run();
    return true;
  }
  return false;
}

export class DiagramPanel {
  static current: DiagramPanel | undefined;

  /** Creeaza sau readuce in fata panelul si cere vederea data. */
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
  /** modul curent al vederii RTL (symbol/schematic) — pentru reveal-ul
   *  corect al radacinii „top module" vs nodul instantei (docs/05) */
  currentMode: ViewMode | undefined;
  /** selectia curenta din webview (ID-uri relative la vederea curenta) */
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
    // exporter activ: doar cand ACEST panou e tab-ul vizibil (docs/05)
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

  /** configuratia pentru vederea de verificare (docs/05): la ready si la
   *  orice schimbare a YAML-ului */
  postConfig(): void {
    if (this.ready) {
      const c = this.deps.getConfig?.();
      if (c) {
        this.post({ v: 1, type: "config/full", ...c });
      }
    }
  }

  /** sidecar schimbat in afara gestului curent (extern/invalidare/curatare) */
  postLayout(sidecar: SidecarData): void {
    if (this.ready) {
      this.post({ v: 1, type: "layout/full", sidecar });
    }
  }

  /** preferintele UI din setari (docs/05): la ready si la schimbari */
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

  /** navigare pe niveluri in vederea de verificare (D24): deschide nivelul */
  navigateTb(focus: string, select: string | null): void {
    if (this.ready) {
      this.post({ v: 1, type: "tb/navigate", focus, select });
    } else {
      this.pendingTbNav = { focus, select };
    }
  }

  /** cere webview-ului serializarea SVG a vederii curente (docs/05, faza 4) */
  requestExport(): void {
    if (this.ready) {
      this.post({ v: 1, type: "export/request" });
    }
  }

  /** ultima tinta de cross-probing trimisa, ca sa nu repostam identic la
   *  fiecare miscare de cursor in interiorul aceluiasi element */
  private lastProbe = "";

  /** decoratiile de stare quick-uvm (docs/05): badge-uri + cipul generate */
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

  /** cross-probing editor->diagrama (docs/05): haloul .xprobe din webview */
  postProbe(targets: XprobeTarget[]): void {
    if (!this.ready) {
      return; // fara panel gata nu exista diagrama de evidentiat
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
        // reveal din arbore: selectia se aplica dupa view/show — render-ul
        // declansat de view/show o deseneaza (state.selection persista)
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
        // un webview reincarcat si-a pierdut haloul de cross-probing: fara
        // resetul dedupe-ului, urmatoarea tinta identica ar fi inghitita si
        // haloul nu s-ar mai reaprinde (recenzia adversariala a sincronizarii)
        this.lastProbe = "";
        // sidecar-ul INAINTEA modelului (docs/05): prima randare trebuie sa
        // aiba semintele de pozitii, altfel o vedere aranjata ar licari
        // intai cu layout-ul automat
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
        this.postStatus(); // decoratiile de stare (docs/05)
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
        // webview-ul a navigat local; host-ul tine titlul si vederea curenta
        // la zi si aliniaza ierarhia la noua vedere (docs/05); `mode` distinge
        // simbolul top-ului (radacina) de schema lui (nodul instantei)
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
        // mesajele declarate dar inca neimplementate (faza 4, docs/04):
        // ports/reordered (nivelul 2), edge/override (nivelul 3) — se ignora
        break;
    }
  }

  /**
   * Salt-la-sursa cerut din diagrama: pentru un pin (`port`) se deschide
   * declaratia portului; fara `port`, definitia modulului vederii.
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
      // cross-probing la hover (faza 4): ne-intruziv — doar editoarele
      // deja vizibile; setarea quickuvm.hoverCrossProbe il poate stinge
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

/** HTML-ul webview-ului diagramei, partajat de panel si de CustomTextEditor. */
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
 * Salveaza SVG-ul autonom exportat de webview (export/result, docs/05):
 * save dialog cu nume derivat din vedere, scriere pe disc. Partajat de panel
 * si de editorul per-fisier (customeditor).
 */
export async function saveExportedSvg(
  viewId: string,
  svg: string
): Promise<void> {
  if (!svg) {
    // vederea nu are nimic de desenat (banner/ecran de bun-venit)
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
    return; // anulat
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(svg, "utf8"));
  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      "QuickUVM Architect: exported {0}",
      vscode.workspace.asRelativePath(uri, false)
    )
  );
}

// starea cross-probing-ului la hover: decoratia (creata lenes, o singura
// instanta), editorul evidentiat curent si timer-ul de stingere
let peekDecoration: vscode.TextEditorDecorationType | undefined;
let peekEditor: vscode.TextEditor | undefined;
let peekTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Cross-probing la hover (faza 4, docs/05): reveleaza `loc` DOAR intr-un
 * editor DEJA vizibil — hover-ul nu deschide tab-uri si nu fura focusul —
 * si evidentiaza scurt linia (decoratie tranzitorie, ~1.2s). Saltul complet
 * (deschidere + cursor) ramane pe dublu-click (openLoc).
 */
export function revealLocPeek(loc: Loc): void {
  const root = vscode.workspace.workspaceFolders?.[0];
  const abs = resolveLocPath(root?.uri.fsPath ?? "", loc.file);
  const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
  const editor = vscode.window.visibleTextEditors.find(
    (e) => norm(e.document.uri.fsPath) === norm(abs)
  );
  if (!editor) {
    return; // fisierul nu e deschis: hover-ul ramane fara efect
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

/** Deschide fisierul unui `loc` (relativ la radacina workspace-ului) la linie. */
export async function openLoc(loc: Loc): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  // reconstituirea caii relativizate de slang: filelistops (pur, testat)
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
