// The extension entry point: orchestrates the backend, the tree view,
// the diagram panel, the QuickUVM configuration service and the commands.
// The rule (docs/01): everything that can be native VSCode UI is native; the webview
// gets only the diagram and the inspector.

import * as path from "path";
import * as vscode from "vscode";
import { Actions } from "./actions";
import { Backend } from "./backend";
import { ConfigService, WidthFixProvider } from "./config";
import { QuvmConfigEditor } from "./customeditor";
import { Generator } from "./generate";
import { resolveLocPath } from "./filelistops";
import { buildLocIndex, LocEntry, resolveLoc } from "./locmap";
import { ProjectModel } from "./model";
import { DiagramPanel, openLoc, PanelDeps, runActiveExport } from "./panel";
import { ActionKind, ViewMode, XprobeTarget } from "./protocol";
import { LayoutStore } from "./sidecar";
import { VerificationProvider } from "./tbtree";
import { GenStateService } from "./genstate-service";
import { GenDecorationProvider } from "./tbdecorations";
import { HierarchyProvider, InstanceNode } from "./tree";

let model: ProjectModel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("QuickUVM Architect");
  const slangDiags = vscode.languages.createDiagnosticCollection("quickuvm");
  const configDiags =
    vscode.languages.createDiagnosticCollection("quickuvm-config");
  const generateDiags =
    vscode.languages.createDiagnosticCollection("quickuvm-generate");
  const tree = new HierarchyProvider();
  // the generation state feeds the row actions (Generate / Regenerate / none)
  const vtree = new VerificationProvider(
    () => genState.missing,
    () => genState.stale
  );
  const backend = new Backend(context, log, slangDiags);
  const config = new ConfigService(log, configDiags);
  const actions = new Actions(() => model, config, log);
  const generator = new Generator(config, log, generateDiags);
  const layout = new LayoutStore(log);
  // docs/07 line 1 — the "not generated" star on the verification tree, driven by
  // `quick-uvm manifest` (which elements have no generated code behind them yet).
  const genState = new GenStateService(log, context.workspaceState);
  const genDeco = new GenDecorationProvider(
    () => genState.missing,
    () => genState.stale
  );
  // the tree star (FileDecoration), the row actions (Generate/Regenerate) and the
  // diagram badges all refresh when the generation state changes
  genState.onDidChange(() => {
    genDeco.refresh();
    vtree.refresh(); // re-render rows: contextValue carries the state
    DiagramPanel.current?.postStatus();
  });
  context.subscriptions.push(
    log, slangDiags, configDiags, generateDiags, tree, vtree, backend, config,
    layout, genState, genDeco,
    vscode.window.registerFileDecorationProvider(genDeco)
  );

  const treeView = vscode.window.createTreeView("quickuvm.hierarchy", {
    treeDataProvider: tree,
  });
  const vTreeView = vscode.window.createTreeView("quickuvm.verification", {
    treeDataProvider: vtree,
  });
  context.subscriptions.push(
    treeView,
    vTreeView,
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file", pattern: "**/*.{yaml,yml}" },
      new WidthFixProvider(),
      WidthFixProvider.metadata
    ),
    // slice 4 (D22): the TB diagram as the default editor of `*.quickuvm.yaml`, with
    // text fallback (reopenWith). The layout reuses the common sidecar,
    // the editing gestures apply on the DOCUMENT (via TbEditTarget)
    vscode.window.registerCustomEditorProvider(
      QuvmConfigEditor.viewType,
      new QuvmConfigEditor(context, layout, actions, log),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  /** the view id of the active config's testbench (docs/05) */
  const tbViewId = (): string | undefined => {
    const uri = config.configUri;
    return uri ? `tb:${vscode.workspace.asRelativePath(uri)}` : undefined;
  };

  /** the current level (focus) of the verification (TB) view, for reveal */
  let tbFocus = "";

  /**
   * The TB diagram -> verification hierarchy synchronization (D24): the reveal is
   * done on the identity `<focus>|<block>` (tbtree and the diagram share the levels
   * and the ids). Without an id (drill), it highlights the level container.
   */
  const revealTbNode = (ids: string[]): void => {
    if (!vTreeView.visible) {
      return;
    }
    const node = ids.length
      ? vtree.findByIdent(tbFocus, ids[0])
      : vtree.findByIdent(tbFocus, "");
    if (node) {
      void vTreeView.reveal(node, { select: true, focus: false });
    }
  };

  /**
   * The diagram -> hierarchy synchronization (docs/05): the first id in the selection
   * that resolves to an instance is highlighted in the tree view. The candidates,
   * in order: the id as such (the context view's block carries the full
   * path), prefixed with the current view (the schematic view nodes
   * are relative), the owner instance of a pin (without the last segment),
   * and for folds — the first member (`g_ch[0..2]` -> `g_ch[0]`).
   * Without any resolvable id (empty selection, net, boundary flag),
   * the current view's instance is highlighted: the hierarchy always reflects what
   * the diagram shows, including after a mode switch or after a drill.
   */
  const revealInstance = (
    ids: string[],
    viewId: string | undefined,
    mode?: string
  ): void => {
    if (!model || !treeView.visible) {
      return; // no reveal when the hierarchy is not visible (we don't open the sidebar)
    }
    // the top's symbol belongs to the synthetic "top module" root, not the
    // instance node (the same path, different views — docs/05)
    if (mode === "symbol" && viewId && viewId === model.tops[0]) {
      const top = tree.topRoot();
      if (top) {
        void treeView.reveal(top, { select: true, focus: false });
        return;
      }
    }
    for (const id of ids) {
      const first = id.replace(/\[(\d+)\.\.\d+\]/g, "[$1]");
      const bases = first === id ? [id] : [id, first];
      const candidates: string[] = [];
      for (const b of bases) {
        candidates.push(b);
        if (viewId) {
          candidates.push(`${viewId}.${b}`);
        }
        const dot = b.lastIndexOf(".");
        if (dot > 0 && viewId) {
          candidates.push(`${viewId}.${b.slice(0, dot)}`);
        }
      }
      for (const c of candidates) {
        const node = tree.findNode(c);
        if (node) {
          void treeView.reveal(node, { select: true, focus: false });
          return;
        }
      }
    }
    const current = viewId ? tree.findNode(viewId) : undefined;
    if (current) {
      void treeView.reveal(current, { select: true, focus: false });
    }
  };

  const panelDeps: PanelDeps = {
    getModel: () => model,
    getOverlay: () => config.lastOverlay,
    getConfig: () => ({
      configPath: config.configUri
        ? vscode.workspace.asRelativePath(config.configUri)
        : null,
      config: config.current,
    }),
    // the quick-uvm status decorations (docs/05): validations + the last generate
    getStatus: () => ({
      decos: config.decorations,
      generate: generator.status,
      genMissing: [...genState.missing],
      genStale: [...genState.stale],
    }),
    layout: {
      get: () => layout.sidecar,
      positionsSnapshotted: (v, nodes) => layout.positionsSnapshotted(v, nodes),
      foldToggled: (v, f, c) => layout.foldToggled(v, f, c),
      nodeFlipped: (v, n, fh, fv) => layout.nodeFlipped(v, n, fh, fv),
      relayout: (v) => layout.relayout(v),
      netRender: (v, n, r) => layout.netRender(v, n, r),
    },
    onTbFocus: (focus, select) => {
      // the webview navigated across levels (drill/breadcrumb): the host keeps
      // the current level + highlights in the verification tree (D24)
      tbFocus = focus;
      revealTbNode(select ? [select] : []);
    },
    onSelection: (ids, viewId, mode) => {
      if (viewId?.startsWith("tb:")) {
        revealTbNode(ids); // the verification (TB) view -> the verification tree
      } else {
        revealInstance(ids, viewId, mode); // the RTL views -> the design hierarchy
      }
    },
    onAction: (action: ActionKind, args, viewId) => {
      const pins = Array.isArray(args.pins) ? (args.pins as string[]) : [];
      // the gestures on the pins of a child block send the block's viewId in
      // args (docs/05): the agents are created for that module's config
      const target = typeof args.viewId === "string" ? args.viewId : viewId;
      switch (action) {
        case "setDut":
          void actions.setDut(target);
          break;
        case "createAgentFromPins":
          void actions.createAgentFromPins(target, pins);
          break;
        case "createAgentFromIface":
          void actions.createAgentFromIface(target, String(args.port ?? ""));
          break;
        case "createSubenv":
          void actions.createSubenv(
            viewId,
            Array.isArray(args.nodes) ? (args.nodes as string[]) : []
          );
          break;
        case "ignorePort":
          void actions.ignorePorts(pins, true);
          break;
        case "unignorePort":
          void actions.ignorePorts(pins, false);
          break;
        case "addScoreboard":
          void actions.addScoreboard(
            typeof args.source === "string" ? args.source : undefined
          );
          break;
        case "addCoverage":
          void actions.addCoverage(
            typeof args.agent === "string" ? args.agent : undefined
          );
          break;
        case "addVirtualSequence":
          void actions.addVirtualSequence();
          break;
        case "deleteComponent":
          void actions.deleteComponent(
            typeof args.kind === "string" ? args.kind : "",
            typeof args.name === "string" ? args.name : ""
          );
          break;
        case "editScoreboard":
          void actions.editScoreboard(
            typeof args.name === "string" ? args.name : "",
            typeof args.field === "string" ? args.field : "",
            typeof args.value === "string" ? args.value : ""
          );
          break;
        case "createProbe":
          void actions.createProbe(
            target,
            typeof args.net === "string" ? args.net : ""
          );
          break;
        case "wireConnections":
          void actions.wireConnections(target);
          break;
        case "composeIntoParent":
          void actions.composeIntoParent(target);
          break;
        case "openSubenvConfig":
          // drill into the composed block: the path of the child config (from the drill), with
          // the default editor
          void actions.openSubenvConfig(
            typeof args.config === "string" ? args.config : ""
          );
          break;
        case "generate":
          void generator.generate();
          break;
        case "openSource":
          break; // handled directly in the panel (it needs the model); does not reach here
        default: {
          // exhaustiveness guard: a new ActionKind without a handler here is
          // a COMPILE error, not a log silently swallowed at runtime
          const missing: never = action;
          log.appendLine(`[panel] unhandled action: ${missing as string}`);
        }
      }
    },
  };

  // ---- editor->diagram cross-probing (docs/05): the model's loc->target
  // index, on normalized ABSOLUTE paths (lower + slash — on Windows the paths
  // differ by case, the same pitfall as isComposedChild)
  const normPath = (p: string): string => p.toLowerCase().replace(/\\/g, "/");
  let locIndex = new Map<string, LocEntry[]>();
  const rebuildLocIndex = (m: ProjectModel): void => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    locIndex = new Map();
    for (const [file, entries] of buildLocIndex(m)) {
      const key = normPath(resolveLocPath(root, file));
      const list = locIndex.get(key);
      if (list) {
        list.push(...entries);
        list.sort((a, b) => a.line - b.line);
      } else {
        locIndex.set(key, entries);
      }
    }
  };
  /** the targets under the cursor of an SV source editor (empty = none) */
  const targetsAt = (
    doc: vscode.TextDocument,
    line0: number
  ): XprobeTarget[] => {
    const entries = locIndex.get(normPath(doc.uri.fsPath));
    return resolveLoc(entries, line0 + 1); // the model counts lines from 1
  };

  backend.onModel((m) => {
    model = m;
    rebuildLocIndex(m);
    tree.setModel(m);
    config.setModel(m);
    layout.setModel(m); // graceful invalidation of the sidecar (docs/04)
    DiagramPanel.current?.postModel(m);
  });
  layout.onExternalChange((sidecar) => {
    DiagramPanel.current?.postLayout(sidecar);
  });
  // the generate status chip is updated after each run (docs/05); a generate also
  // (re)creates files, so refresh the "not generated" decoration (docs/07 line 1)
  context.subscriptions.push(
    generator.onStatus(() => {
      DiagramPanel.current?.postStatus();
      void genState.refresh(config.configUri);
    })
  );
  backend.onStale((errors) => {
    DiagramPanel.current?.postStale(errors);
    if (!model) {
      // without a previous model, the failure would otherwise be invisible (the tree stays
      // on the welcome screen, the errors only in Problems)
      void vscode.window.showWarningMessage(
        errors === 1
          ? vscode.l10n.t(
              "QuickUVM Architect: compilation failed (1 error) - see the Problems panel."
            )
          : vscode.l10n.t(
              "QuickUVM Architect: compilation failed ({0} errors) - see the Problems panel.",
              errors
            )
      );
    }
  });
  config.onOverlay((overlay) => {
    DiagramPanel.current?.postOverlay(overlay);
    DiagramPanel.current?.postConfig(); // the verification (TB) view (docs/05)
    DiagramPanel.current?.postStatus(); // the status decorations (docs/05)
    // the verification hierarchy: the tree derived from the current configuration
    vtree.setConfig(
      config.configUri ? config.current : null,
      config.configUri ? vscode.workspace.asRelativePath(config.configUri) : null
    );
    // recompute the "not generated" decoration from the (possibly changed) config
    void genState.refresh(config.configUri);
  });
  // initial manifest load: onOverlay only fires on a CHANGE, so a config already
  // discovered at activation would otherwise leave the gen-state (badges + the
  // per-item generate) empty until the first edit.
  void genState.refresh(config.configUri);

  // cursor tracking (docs/05): debounced, non-invasive — only the .xprobe
  // halo of the current view; a file unknown to the model = turn off
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!DiagramPanel.current || e.textEditor.document.uri.scheme !== "file") {
        return;
      }
      clearTimeout(probeTimer);
      probeTimer = setTimeout(() => {
        DiagramPanel.current?.postProbe(
          targetsAt(e.textEditor.document, e.selections[0]?.active.line ?? 0)
        );
      }, 150);
    })
  );

  /** the view that CONTAINS an instance: the longest view key that is a proper
   *  prefix of it; null for tops (without a parent) */
  const containingView = (path: string): string | null => {
    let best: string | null = null;
    for (const v of Object.keys(model?.views ?? {})) {
      if (path.startsWith(v + ".") && (!best || v.length > best.length)) {
        best = v;
      }
    }
    return best;
  };
  /** the preferred instance of a module: that of the current view if it
   *  matches, otherwise the first in the model */
  const instanceOf = (module: string): string | null => {
    const cur = DiagramPanel.current?.currentView;
    const curInst = model?.instances.find((i) => i.path === cur);
    if (curInst?.module === module) {
      return curInst.path;
    }
    return model?.instances.find((i) => i.module === module)?.path ?? null;
  };

  // ------------------------------------------------------------ commands

  context.subscriptions.push(
    vscode.commands.registerCommand("quickuvm.reloadModel", () => {
      backend.schedule(0);
    }),

    vscode.commands.registerCommand("quickuvm.setTop", async () => {
      const cfg = vscode.workspace.getConfiguration("quickuvm");
      const top = await vscode.window.showInputBox({
        title: vscode.l10n.t("QuickUVM Architect: top module"),
        prompt: vscode.l10n.t(
          "Name of the top module for elaboration (e.g. demo_top)"
        ),
        value: cfg.get<string>("top", ""),
        placeHolder: "demo_top",
      });
      if (top !== undefined) {
        await cfg.update("top", top.trim(), vscode.ConfigurationTarget.Workspace);
        backend.schedule(0);
      }
    }),

    vscode.commands.registerCommand(
      "quickuvm.openSymbolView",
      async (arg?: string | InstanceNode) => {
        let path = typeof arg === "string" ? arg : arg?.inst?.path ?? undefined;
        if (!path) {
          path = await pickInstance();
        }
        if (path) {
          // explicit "symbol": without a toggle, the mode is no longer inherited from
          // the webview state (the "top module" root -> the top's symbol)
          DiagramPanel.show(context, panelDeps, path, "symbol");
        }
      }
    ),

    vscode.commands.registerCommand(
      "quickuvm.openSchematicView",
      async (arg?: string | InstanceNode) => {
        let path = typeof arg === "string" ? arg : arg?.inst?.path ?? undefined;
        if (!path) {
          path = await pickInstance((i) => Boolean(model?.views[i.path]));
        }
        if (path) {
          DiagramPanel.show(context, panelDeps, path, "schematic");
        }
      }
    ),

    vscode.commands.registerCommand(
      "quickuvm.openSource",
      async (arg?: InstanceNode) => {
        const loc = arg?.inst?.loc;
        if (loc) {
          await openLoc(loc);
        }
      }
    ),

    // the navigational reciprocal of cross-probing (docs/05): from the SV source,
    // opens the diagram at the element under the cursor — instance -> the schematic
    // of the view that contains it + selection; port/module -> the view of the module's
    // instance (preferring the current view)
    vscode.commands.registerCommand("quickuvm.revealInDiagram", () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || !model) {
        return;
      }
      const targets = targetsAt(ed.document, ed.selection.active.line);
      if (!targets.length) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            "QuickUVM Architect: no design element found at the cursor."
          )
        );
        return;
      }
      const t = targets[0];
      if (t.kind === "instance") {
        const view = containingView(t.path);
        if (view) {
          // all targets (the generated instances share the line) fall in the same
          // view: we select all the relative paths
          const rels = targets
            .filter((x): x is Extract<XprobeTarget, { kind: "instance" }> =>
              x.kind === "instance" && x.path.startsWith(view + "."))
            .map((x) => x.path.slice(view.length + 1));
          DiagramPanel.show(context, panelDeps, view, "schematic", rels);
        } else {
          // top (without a parent view): its schematic if it exists — a module
          // header reveals the interior, consistent with the other modules
          // (adversarial review; the symbol stays for leaves)
          const mode: ViewMode = model.views[t.path] ? "schematic" : "symbol";
          DiagramPanel.show(context, panelDeps, t.path, mode);
        }
        return;
      }
      const inst = instanceOf(t.module);
      if (!inst) {
        return; // module without an elaborated instance: nothing to show
      }
      const mode: ViewMode = model.views[inst] ? "schematic" : "symbol";
      const select = t.kind === "port" ? [`<port>.${t.port}`] : undefined;
      DiagramPanel.show(context, panelDeps, inst, mode, select);
    }),

    // ---- phase 2: the QuickUVM configuration

    vscode.commands.registerCommand(
      "quickuvm.setDut",
      (arg?: InstanceNode) => {
        const viewId = arg?.inst?.path ?? DiagramPanel.current?.currentView;
        void actions.setDut(viewId);
      }
    ),

    vscode.commands.registerCommand("quickuvm.createAgentFromSelection", () => {
      const p = DiagramPanel.current;
      void actions.createAgentFromPins(p?.currentView, p?.selection ?? []);
    }),

    vscode.commands.registerCommand("quickuvm.createSubenv", () => {
      const p = DiagramPanel.current;
      void actions.createSubenv(p?.currentView, p?.selection ?? []);
    }),

    vscode.commands.registerCommand("quickuvm.ignoreSelection", () => {
      void actions.ignorePorts(DiagramPanel.current?.selection ?? [], true);
    }),

    vscode.commands.registerCommand("quickuvm.generate", async () => {
      if (await generator.generate()) {
        // every element is now generated from THIS config — clears every ● stale
        await genState.markGenerated("all");
      }
    }),

    // docs/07 line 2 — regenerate just one element's files (+ the aggregate set),
    // from the verification-hierarchy context menu. `node` is the VNode the tree
    // yielded; its element id is the node id minus the `v:` prefix.
    // Regenerate = the same scoped generation, a distinct command purely so the row
    // can show a different icon/title (⟳ "Regenerate") once the element exists.
    vscode.commands.registerCommand(
      "quickuvm.regenerateItem",
      (node?: { id?: string; label?: string }) =>
        vscode.commands.executeCommand("quickuvm.generateItem", node)
    ),

    vscode.commands.registerCommand(
      "quickuvm.generateItem",
      async (node?: { id?: string; label?: string }) => {
        if (!node?.id) {
          return;
        }
        const nodeId = node.id.replace(/^v:/, "");
        // The manifest may not be cached yet (never refreshed, or stale) — load it
        // on demand and retry before giving up.
        let files = genState.scopedFiles(nodeId);
        if (!files) {
          await genState.refresh(config.configUri);
          files = genState.scopedFiles(nodeId);
        }
        if (!files) {
          void vscode.window.showWarningMessage(
            vscode.l10n.t(
              "QuickUVM Architect: could not resolve the files for this element — see the QuickUVM Architect output channel (needs quick-uvm >= 1.1.0)."
            )
          );
          log.show(true);
          return;
        }
        if (await generator.generateItem(node.label ?? "item", files)) {
          // this element is now generated from THIS config — clears its ● stale
          await genState.markGenerated([nodeId]);
        }
      }
    ),

    // docs/07 line 2 (2.3) — open an element's generated code; if it hasn't been
    // generated yet (line 1's `missing`), offer to generate it first, then open.
    vscode.commands.registerCommand(
      "quickuvm.openGeneratedCode",
      async (node?: { id?: string; label?: string }) => {
        if (!node?.id) {
          return;
        }
        const nodeId = node.id.replace(/^v:/, "");
        const label = node.label ?? "item";
        // load the manifest on demand if it is not cached yet (as generateItem)
        if (!genState.primaryFilePath(nodeId)) {
          await genState.refresh(config.configUri);
        }
        const primary = genState.primaryFilePath(nodeId);
        if (!primary) {
          void vscode.window.showWarningMessage(
            vscode.l10n.t(
              "QuickUVM Architect: no generated file for {0} yet — run Generate Testbench.",
              label
            )
          );
          return;
        }
        if (genState.missing.has(nodeId)) {
          const go = await vscode.window.showInformationMessage(
            vscode.l10n.t(
              "QuickUVM Architect: {0} has not been generated yet. Generate it now?",
              label
            ),
            { modal: true },
            vscode.l10n.t("Generate")
          );
          if (!go) {
            return;
          }
          const files = genState.scopedFiles(nodeId);
          if (files && (await generator.generateItem(label, files))) {
            await genState.markGenerated([nodeId]);
          }
        }
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(primary));
        } catch {
          void vscode.window.showWarningMessage(
            vscode.l10n.t(
              "QuickUVM Architect: could not open the generated file for {0} — run Generate Testbench.",
              label
            )
          );
        }
      }
    ),

    vscode.commands.registerCommand("quickuvm.openConfig", async () => {
      const uri = config.configUri;
      if (uri) {
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(uri)
        );
      } else {
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            'QuickUVM Architect: no configuration exists yet — use "Set as DUT".'
          )
        );
      }
    }),

    vscode.commands.registerCommand(
      "quickuvm.fixPortWidth",
      (agent: string, port: string, width: number) => {
        void actions.fixPortWidth(agent, port, width);
      }
    ),

    vscode.commands.registerCommand(
      "quickuvm.revealTbComponent",
      (focus?: string, selectId?: string | null) => {
        // click on a node in the verification hierarchy: opens the TB view at
        // its level (focus) and selects the block (selectId) — D24
        const viewId = tbViewId();
        if (!viewId) {
          return;
        }
        tbFocus = typeof focus === "string" ? focus : "";
        DiagramPanel.show(context, panelDeps, viewId, "tb");
        DiagramPanel.current?.navigateTb(tbFocus, selectId ?? null);
      }
    ),

    vscode.commands.registerCommand("quickuvm.openVerificationView", async () => {
      await config.refresh(); // the first invocation may precede discovery
      const uri = config.configUri;
      if (!uri) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            'QuickUVM Architect: no configuration exists yet — use "Set as DUT".'
          )
        );
        return;
      }
      DiagramPanel.show(
        context,
        panelDeps,
        `tb:${vscode.workspace.asRelativePath(uri)}`,
        "tb"
      );
    }),

    vscode.commands.registerCommand("quickuvm.exportSvg", () => {
      // exports the ACTIVE diagram tab (RTL/TB panel or the per-file
      // editor); if another tab is active (Welcome, source file), it does
      // nothing and points to the ⤓ button in the diagram header
      if (!runActiveExport()) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            "QuickUVM Architect: focus a diagram tab first (the ⤓ button in the diagram header does the same)."
          )
        );
      }
    }),

    vscode.commands.registerCommand("quickuvm.chooseConfig", async () => {
      const uris = await config.listConfigs();
      if (uris.length === 0) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            'QuickUVM Architect: no configuration exists yet — use "Set as DUT".'
          )
        );
        return;
      }
      const active = config.configUri?.fsPath;
      const items = uris.map((u) => ({
        label: path.basename(u.fsPath),
        description:
          vscode.workspace.asRelativePath(u) +
          (u.fsPath === active ? ` — ${vscode.l10n.t("active")}` : ""),
        uri: u,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t("QuickUVM Architect: active configuration"),
        placeHolder: vscode.l10n.t(
          "The choice is pinned in the quickuvm.configFile setting"
        ),
      });
      if (pick) {
        await vscode.workspace
          .getConfiguration("quickuvm")
          .update(
            "configFile",
            vscode.workspace.asRelativePath(pick.uri),
            vscode.ConfigurationTarget.Workspace
          );
      }
    }),

    vscode.commands.registerCommand("quickuvm.cleanOrphans", () => {
      const n = layout.cleanOrphans();
      void vscode.window.showInformationMessage(
        n === 0
          ? vscode.l10n.t("QuickUVM Architect: no orphaned layout overrides.")
          : n === 1
            ? vscode.l10n.t(
                "QuickUVM Architect: 1 orphaned layout override removed."
              )
            : vscode.l10n.t(
                "QuickUVM Architect: {0} orphaned layout overrides removed.",
                n
              )
      );
    })
  );

  // ------------------------------------------------------- events

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (/\.(sv|svh)$/i.test(doc.fileName)) {
        backend.schedule();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("quickuvm.lassoMode") ||
        e.affectsConfiguration("quickuvm.schematicDecorations")
      ) {
        // purely UI settings: they are resent to the webview, without re-elaboration
        DiagramPanel.current?.postUiConfig();
        return;
      }
      if (
        e.affectsConfiguration("quickuvm") &&
        !e.affectsConfiguration("quickuvm.configFile")
      ) {
        backend.schedule(0);
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      DiagramPanel.current?.postTheme();
    })
  );

  // the first load: only if the top is already set (otherwise viewsWelcome
  // guides the user toward "Load the model", which requires the top)
  const top = vscode.workspace.getConfiguration("quickuvm").get<string>("top", "");
  if (vscode.workspace.workspaceFolders?.length && top.trim()) {
    backend.schedule(0);
  }
}

async function pickInstance(
  filter?: (i: { path: string }) => boolean
): Promise<string | undefined> {
  if (!model) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("QuickUVM Architect: the model is not loaded yet.")
    );
    return undefined;
  }
  const items = model.instances.filter(filter ?? (() => true)).map((i) => {
    const params = Object.entries(i.params)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    return {
      label: i.path,
      description: i.module + (params ? ` #(${params})` : ""),
    };
  });
  const pick = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("QuickUVM Architect: symbol view"),
    placeHolder: vscode.l10n.t("Choose an instance"),
  });
  return pick?.label;
}

export function deactivate(): void {
  // cleanup is done by context.subscriptions
}
