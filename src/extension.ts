// Punctul de intrare al extensiei: orchestreaza backend-ul, tree view-ul,
// panelul de diagrama, serviciul de configurare QuickUVM si comenzile.
// Regula (docs/01): tot ce poate fi UI nativ VSCode este nativ; webview-ul
// primeste doar diagrama si inspectorul.

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
  const vtree = new VerificationProvider();
  const backend = new Backend(context, log, slangDiags);
  const config = new ConfigService(log, configDiags);
  const actions = new Actions(() => model, config, log);
  const generator = new Generator(config, log, generateDiags);
  const layout = new LayoutStore(log);
  context.subscriptions.push(
    log, slangDiags, configDiags, generateDiags, tree, vtree, backend, config, layout
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
    // felia 4 (D22): diagrama TB ca editor implicit al `*.quickuvm.yaml`, cu
    // fallback text (reopenWith). Layout-ul re-foloseste sidecar-ul comun,
    // gesturile de editare aplica pe DOCUMENT (via TbEditTarget)
    vscode.window.registerCustomEditorProvider(
      QuvmConfigEditor.viewType,
      new QuvmConfigEditor(context, layout, actions, log),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  /** id-ul de vedere al testbench-ului config-ului activ (docs/05) */
  const tbViewId = (): string | undefined => {
    const uri = config.configUri;
    return uri ? `tb:${vscode.workspace.asRelativePath(uri)}` : undefined;
  };

  /** nivelul (focus) curent al vederii de verificare, pentru reveal */
  let tbFocus = "";

  /**
   * Sincronizarea diagrama TB -> ierarhia verificarii (D24): reveal-ul se
   * face pe identitatea `<focus>|<bloc>` (tbtree si diagrama impart nivelurile
   * si id-urile). Fara id (drill), evidentiaza containerul nivelului.
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
   * Sincronizarea diagrama -> ierarhie (docs/05): primul id din selectie
   * care se rezolva la o instanta se evidentiaza in tree view. Candidatii,
   * in ordine: id-ul ca atare (blocul vederii de context poarta calea
   * completa), prefixat cu vederea curenta (nodurile vederii-schema
   * sunt relative), instanta-proprietar a unui pin (fara ultimul segment),
   * iar pentru pliaje — primul membru (`g_ch[0..2]` -> `g_ch[0]`).
   * Fara niciun id rezolvabil (selectie goala, net, steag de granita),
   * se evidentiaza instanta vederii curente: ierarhia reflecta mereu ce
   * arata diagrama, inclusiv dupa comutarea de mod sau dupa drill.
   */
  const revealInstance = (
    ids: string[],
    viewId: string | undefined,
    mode?: string
  ): void => {
    if (!model || !treeView.visible) {
      return; // fara reveal cand ierarhia nu e vizibila (nu deschidem sidebar)
    }
    // simbolul top-ului apartine radacinii sintetice „top module", nu nodului
    // instantei (aceeasi cale, vederi diferite — docs/05)
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
    // decoratiile de stare quick-uvm (docs/05): validari + ultimul generate
    getStatus: () => ({ decos: config.decorations, generate: generator.status }),
    layout: {
      get: () => layout.sidecar,
      positionsSnapshotted: (v, nodes) => layout.positionsSnapshotted(v, nodes),
      foldToggled: (v, f, c) => layout.foldToggled(v, f, c),
      nodeFlipped: (v, n, fh, fv) => layout.nodeFlipped(v, n, fh, fv),
      relayout: (v) => layout.relayout(v),
      netRender: (v, n, r) => layout.netRender(v, n, r),
    },
    onTbFocus: (focus, select) => {
      // webview a navigat pe niveluri (drill/breadcrumb): host-ul tine
      // nivelul curent + evidentiaza in arborele de verificare (D24)
      tbFocus = focus;
      revealTbNode(select ? [select] : []);
    },
    onSelection: (ids, viewId, mode) => {
      if (viewId?.startsWith("tb:")) {
        revealTbNode(ids); // vederea de verificare -> arborele verificarii
      } else {
        revealInstance(ids, viewId, mode); // vederile RTL -> ierarhia designului
      }
    },
    onAction: (action: ActionKind, args, viewId) => {
      const pins = Array.isArray(args.pins) ? (args.pins as string[]) : [];
      // gesturile pe pinii unui bloc copil trimit viewId-ul blocului in
      // args (docs/05): agentii se creeaza pentru config-ul acelui modul
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
          // drill in blocul compus: calea config-ului copil (din drill), cu
          // editorul implicit
          void actions.openSubenvConfig(
            typeof args.config === "string" ? args.config : ""
          );
          break;
        case "generate":
          void generator.generate();
          break;
        case "openSource":
          break; // tratat direct in panel (are nevoie de model); nu ajunge aici
        default: {
          // garda de exhaustivitate: un ActionKind nou fara handler aici e
          // eroare de COMPILARE, nu un log inghitit tacit la rulare
          const missing: never = action;
          log.appendLine(`[panel] unhandled action: ${missing as string}`);
        }
      }
    },
  };

  // ---- cross-probing editor->diagrama (docs/05): indexul loc->tinta al
  // modelului, pe cai ABSOLUTE normalizate (lower + slash — pe Windows caile
  // difera prin caz, aceeasi capcana ca isComposedChild)
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
  /** tintele de sub cursorul unui editor de sursa SV (goale = niciuna) */
  const targetsAt = (
    doc: vscode.TextDocument,
    line0: number
  ): XprobeTarget[] => {
    const entries = locIndex.get(normPath(doc.uri.fsPath));
    return resolveLoc(entries, line0 + 1); // modelul numara liniile de la 1
  };

  backend.onModel((m) => {
    model = m;
    rebuildLocIndex(m);
    tree.setModel(m);
    config.setModel(m);
    layout.setModel(m); // invalidare gratioasa a sidecar-ului (docs/04)
    DiagramPanel.current?.postModel(m);
  });
  layout.onExternalChange((sidecar) => {
    DiagramPanel.current?.postLayout(sidecar);
  });
  // cipul de stare generate se actualizeaza dupa fiecare rulare (docs/05)
  context.subscriptions.push(
    generator.onStatus(() => DiagramPanel.current?.postStatus())
  );
  backend.onStale((errors) => {
    DiagramPanel.current?.postStale(errors);
    if (!model) {
      // fara model anterior, esecul ar fi altfel invizibil (arborele ramane
      // pe ecranul de bun-venit, erorile doar in Problems)
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
    DiagramPanel.current?.postConfig(); // vederea de verificare (docs/05)
    DiagramPanel.current?.postStatus(); // decoratiile de stare (docs/05)
    // ierarhia verificarii: arborele derivat din configuratia curenta
    vtree.setConfig(
      config.configUri ? config.current : null,
      config.configUri ? vscode.workspace.asRelativePath(config.configUri) : null
    );
  });

  // urmarirea cursorului (docs/05): debounced, non-invaziv — doar haloul
  // .xprobe din vederea curenta; fisier necunoscut modelului = stinge
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

  /** vederea care CONTINE o instanta: cea mai lunga cheie de vedere care ii e
   *  prefix propriu; null pentru top-uri (fara parinte) */
  const containingView = (path: string): string | null => {
    let best: string | null = null;
    for (const v of Object.keys(model?.views ?? {})) {
      if (path.startsWith(v + ".") && (!best || v.length > best.length)) {
        best = v;
      }
    }
    return best;
  };
  /** instanta preferata a unui modul: cea a vederii curente daca se
   *  potriveste, altfel prima din model */
  const instanceOf = (module: string): string | null => {
    const cur = DiagramPanel.current?.currentView;
    const curInst = model?.instances.find((i) => i.path === cur);
    if (curInst?.module === module) {
      return curInst.path;
    }
    return model?.instances.find((i) => i.module === module)?.path ?? null;
  };

  // ------------------------------------------------------------ comenzi

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
          // explicit „symbol": fara comutator, modul nu se mai mosteneste din
          // starea webview-ului (radacina „top module" -> simbolul top-ului)
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

    // reciproca navigationala a cross-probing-ului (docs/05): din sursa SV,
    // deschide diagrama la elementul de sub cursor — instanta -> schema
    // vederii care o contine + selectie; port/modul -> vederea instantei
    // modulului (preferand vederea curenta)
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
          // toate tintele (instantele generate impart linia) cad in aceeasi
          // vedere: selectam toate caile relative
          const rels = targets
            .filter((x): x is Extract<XprobeTarget, { kind: "instance" }> =>
              x.kind === "instance" && x.path.startsWith(view + "."))
            .map((x) => x.path.slice(view.length + 1));
          DiagramPanel.show(context, panelDeps, view, "schematic", rels);
        } else {
          // top (fara vedere-parinte): schema lui daca exista — antetul unui
          // modul dezvaluie interiorul, consecvent cu celelalte module
          // (recenzia adversariala; simbolul ramane pentru frunze)
          const mode: ViewMode = model.views[t.path] ? "schematic" : "symbol";
          DiagramPanel.show(context, panelDeps, t.path, mode);
        }
        return;
      }
      const inst = instanceOf(t.module);
      if (!inst) {
        return; // modul fara instanta elaborata: nimic de aratat
      }
      const mode: ViewMode = model.views[inst] ? "schematic" : "symbol";
      const select = t.kind === "port" ? [`<port>.${t.port}`] : undefined;
      DiagramPanel.show(context, panelDeps, inst, mode, select);
    }),

    // ---- faza 2: configurarea QuickUVM

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

    vscode.commands.registerCommand("quickuvm.generate", () => {
      void generator.generate();
    }),

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
        // click pe un nod din ierarhia verificarii: deschide vederea TB la
        // nivelul lui (focus) si selecteaza blocul (selectId) — D24
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
      await config.refresh(); // prima invocare poate precede descoperirea
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
      // exporta tab-ul de diagrama ACTIV (panou RTL/TB sau editorul
      // per-fisier); daca activ e alt tab (Welcome, fisier sursa), nu face
      // nimic si indruma spre butonul ⤓ din header-ul diagramei
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

  // ------------------------------------------------------- evenimente

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
        // setari pur de UI: se retrimit webview-ului, fara re-elaborare
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

  // prima incarcare: doar daca top-ul e deja setat (altfel viewsWelcome
  // ghideaza utilizatorul catre "Incarca modelul", care cere top-ul)
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
  // curatenia e facuta de context.subscriptions
}
