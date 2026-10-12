// The per-FILE graphical editor for `*.quickuvm.yaml` (slice 4, D22): the TB
// verification diagram becomes the DEFAULT editor of the file, via
// `CustomTextEditorProvider`. The YAML remains the source of truth (invariant 2):
// each gesture produces a `WorkspaceEdit` on the DOCUMENT (native undo/diff/text
// editing), and any text change re-renders the diagram from the YAML.
//
// The TB diagram is config-driven (it does not need the RTL model — `renderTb` does
// not touch it), so it is rendered from the document text. The TB editing gestures
// (add/delete/edit) go through the SAME methods in `actions.ts`, but with the target =
// the document (`DocumentEditTarget`), not the active config — see `TbEditTarget`.

import * as vscode from "vscode";
import type { Actions } from "./actions";
import type { ResolveService } from "./resolve-service";
import { applyTextChange, type TbEditTarget } from "./config";
import type { YamlLink } from "./yamllink";
import {
  clearActiveExporter,
  diagramHtml,
  saveExportedSvg,
  setActiveExporter,
} from "./panel";
import type { ActionKind, HostMessage, LassoMode, ProposalApply, WebviewMessage } from "./protocol";
import { ghostProposals } from "./proposals";
import type { QuvmConfig } from "./quickuvm";
import { parseQuvm } from "./yamlops";
import type { LayoutStore } from "./sidecar";

/** `TbEditTarget` bound to a TextDocument: the config is its current text,
 *  and `apply` writes a WorkspaceEdit on it (like `ConfigService.apply`, but on
 *  the open document, not the active config). */
class DocumentEditTarget implements TbEditTarget {
  constructor(private readonly doc: vscode.TextDocument) {}

  get current(): QuvmConfig {
    return parseQuvm(this.doc.getText());
  }

  get configUri(): vscode.Uri {
    return this.doc.uri;
  }

  async apply(mutate: (text: string) => string): Promise<boolean> {
    const oldText = this.doc.getText();
    let newText: string;
    try {
      newText = mutate(oldText);
    } catch (e) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          "QuickUVM Architect: {0}",
          String(e instanceof Error ? e.message : e)
        )
      );
      return false;
    }
    // docs/08 R4 — the same MINIMAL edit as ConfigService.apply, through one
    // helper (autosave included), so the two editing surfaces cannot disagree
    // about what a gesture writes or whether it leaves the file dirty
    return applyTextChange(this.doc, oldText, newText);
  }
}

/** docs/08 R4 — the live per-file editors by document uri, so the host can
 *  light a box in them from the YAML caret (`probe/highlight`) the way it does
 *  in the panel; registered at resolve, forgotten at dispose */
const liveEditors = new Map<string, Set<vscode.Webview>>();

export function postToConfigEditors(uri: vscode.Uri, message: HostMessage): void {
  for (const w of liveEditors.get(uri.toString()) ?? []) {
    void w.postMessage(message);
  }
}

export class QuvmConfigEditor implements vscode.CustomTextEditorProvider {
  static readonly viewType = "quickuvm.configEditor";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly layout: LayoutStore,
    private readonly actions: Actions,
    private readonly log: vscode.OutputChannel,
    /** docs/07 — the effective topology, for the inferred (ghost) components. Keyed
     *  per document: this editor can hold a config that is NOT the active one. */
    private readonly resolve?: ResolveService,
    /** docs/08 R4 — the diagram <-> YAML link (open beside, reveal the entry) */
    private readonly yamlLink?: YamlLink
  ) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): void {
    const webview = webviewPanel.webview;
    const liveKey = document.uri.toString();
    let live = liveEditors.get(liveKey);
    if (!live) {
      live = new Set();
      liveEditors.set(liveKey, live);
    }
    live.add(webview);
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    webview.html = diagramHtml(webview, this.context.extensionUri);

    const configPath = vscode.workspace.asRelativePath(document.uri);
    const viewId = `tb:${configPath}`;
    const target = new DocumentEditTarget(document);
    let ready = false;

    const postConfig = (): void => {
      if (ready) {
        const config = parseQuvm(document.getText());
        const resolved = this.resolve?.resolvedFor(document.uri) ?? null;
        void webview.postMessage({ v: 1, type: "config/full", configPath, config, resolved });
        // docs/08 R12 — the per-file editor has no model: only the inferred
        // components can be proposed here (materialise them into THIS document)
        void webview.postMessage({
          v: 1,
          type: "proposals/full",
          viewId,
          mode: "tb",
          items: ghostProposals(config, resolved),
        });
      }
    };

    // Any change to the document (text editing, undo/redo, or a gesture's own
    // WorkspaceEdit) re-renders the diagram from the current YAML.
    // Idempotent, no loop: `config/full` -> render emits no other edit.
    const disposables: vscode.Disposable[] = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString()) {
          postConfig();
        }
      }),
      // `resolve` reads the file on DISK, so the ghosts can only follow a SAVE.
      // Between an edit and its save the scene's live-mode guard keeps them honest
      // (src/webview/tbscene.ts) — it drops every ghost the moment the open document
      // declares an `analysis:` block, whatever the cache still says.
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.uri.toString() === document.uri.toString()) {
          void this.resolve?.refresh(document.uri, false);
        }
      }),
      // A finished `resolve` for THIS document re-posts, whoever started it. The
      // save handler's own `refresh` is not enough: ConfigService refreshes the
      // ACTIVE config on the same save (file watcher, debounced), ResolveService
      // keeps only the newest in-flight request per uri, and a Python subprocess
      // outlives the 200 ms debounce — so the editor's request was routinely
      // superseded. Re-posting from its `.then` then carried the PREVIOUS cache,
      // while the winner's result reached the panel and the sidebar but never this
      // webview: ghosts one save late, in the default editor of the file.
      ...(this.resolve
        ? [
            this.resolve.onDidChange((uri) => {
              if (uri.toString() === document.uri.toString()) {
                postConfig();
              }
            }),
          ]
        : []),
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (ready) {
          void webview.postMessage({ v: 1, type: "theme/changed" });
        }
      }),
    ];
    // active exporter (the palette command): only when THIS editor is the
    // visible tab — otherwise the export would also run from Welcome/a source file
    const exporter = {
      run: (): void => {
        if (ready) {
          void webview.postMessage({ v: 1, type: "export/request" });
        }
      },
    };
    if (webviewPanel.active) {
      setActiveExporter(exporter);
    }
    disposables.push(
      webviewPanel.onDidChangeViewState(() => {
        if (webviewPanel.active) {
          setActiveExporter(exporter);
        } else {
          clearActiveExporter(exporter);
        }
      })
    );
    webviewPanel.onDidDispose(() => {
      liveEditors.get(liveKey)?.delete(webview);
      clearActiveExporter(exporter);
      for (const d of disposables) {
        d.dispose();
      }
    });

    webview.onDidReceiveMessage((m: WebviewMessage) => {
      switch (m.type) {
        case "ready": {
          ready = true;
          void webview.postMessage({
            v: 1,
            type: "layout/full",
            sidecar: this.layout.sidecar,
          });
          const quvm = vscode.workspace.getConfiguration("quickuvm");
          const lasso: LassoMode =
            quvm.get<string>("lassoMode", "contain") === "intersect"
              ? "intersect"
              : "contain";
          const decorations = quvm.get<boolean>("schematicDecorations", true);
          void webview.postMessage({ v: 1, type: "ui/config", lasso, decorations });
          postConfig();
          // The inferred components need a subprocess, so the first paint cannot
          // wait for them: post the config now; `onDidChange` above re-posts once
          // `resolve` lands (a cached, unchanged answer was already in the post).
          // Without this the ghosts appeared only after the first SAVE, which reads
          // as "the feature is broken" on a config opened and merely looked at.
          void this.resolve?.refresh(document.uri, false);
          void webview.postMessage({
            v: 1,
            type: "view/show",
            viewId,
            mode: "tb",
          });
          break;
        }
        // the layout (drag/flip/fold/re-arrange) goes into the SHARED sidecar,
        // keyed on `tb:<cale>` — the same mechanics as the panel
        case "layout/snapshot":
          this.layout.positionsSnapshotted(m.viewId, m.nodes);
          break;
        case "export/result":
          void saveExportedSvg(m.viewId, m.svg);
          break;
        case "fold/toggled":
          this.layout.foldToggled(m.viewId, m.foldId, m.collapsed);
          break;
        case "node/flipped":
          this.layout.nodeFlipped(m.viewId, m.nodeId, m.flipH, m.flipV);
          break;
        case "relayout/request":
          if (m.scope === "all") {
            this.layout.relayout(m.viewId);
          }
          break;
        case "action/request":
          this.onAction(m.action, m.args, target);
          break;
        case "select/changed":
          // docs/08 R4 — diagram -> text: the selected box reveals its YAML entry
          // in the text editors that already show THIS document (never opens one)
          if (m.ids.length === 1) {
            this.yamlLink?.revealElement(document.uri, document.getText(), m.ids[0]);
          }
          break;
        // tb/focus (local drill) has no tree synchronization in the per-file
        // editor — it is ignored
        default:
          break;
      }
    });
  }

  /** The TB EDITING gestures, applied on the DOCUMENT (not on the active config).
   *  The DESIGN gestures (createProbe/wireConnections/…) do not appear in the TB view. */
  private onAction(
    action: ActionKind,
    args: Record<string, unknown>,
    target: TbEditTarget
  ): void {
    const s = (k: string): string => (typeof args[k] === "string" ? (args[k] as string) : "");
    switch (action) {
      case "addScoreboard":
        void this.actions.addScoreboard(s("source") || undefined, target);
        break;
      case "addCoverage":
        void this.actions.addCoverage(s("agent") || undefined, target);
        break;
      case "addVirtualSequence":
        void this.actions.addVirtualSequence(target);
        break;
      case "deleteComponent":
        void this.actions.deleteComponent(s("kind"), s("name"), target);
        break;
      case "renameComponent":
        void this.actions.renameComponent(s("kind"), s("name"), s("newName"), target);
        break;
      case "editScoreboard":
        void this.actions.editScoreboard(s("name"), s("field"), s("value"), target);
        break;
      case "editAgent":
        void this.actions.editAgent(s("name"), s("field"), s("value"), target);
        break;
      case "addRegisterModel":
        void this.actions.addRegisterModel(target);
        break;
      case "removeRegisterModel":
        void this.actions.removeRegisterModel(target);
        break;
      case "editRegisterModel":
        void this.actions.editRegisterModel(s("field"), s("value"), target);
        break;
      case "toggleRegress":
        void this.actions.toggleRegress(s("value") === "true", target);
        break;
      case "editRegress":
        void this.actions.editRegress(s("field"), s("value"), target);
        break;
      case "editCoverage":
        void this.actions.editCoverage(
          s("op"),
          args as Parameters<typeof this.actions.editCoverage>[1],
          target
        );
        break;
      case "editClock":
        void this.actions.editClock(
          s("op"),
          args as Parameters<typeof this.actions.editClock>[1],
          target
        );
        break;
      case "editReset":
        void this.actions.editReset(
          s("op"),
          args as Parameters<typeof this.actions.editReset>[1],
          target
        );
        break;
      case "editAgentPort":
        void this.actions.editAgentPort(
          args as Parameters<typeof this.actions.editAgentPort>[0],
          target
        );
        break;
      case "addVipAgent":
        void this.actions.addVipAgent(target);
        break;
      case "editSubenvNamespace":
        void this.actions.editSubenvNamespace(s("subenv"), s("mode"), target);
        break;
      case "addTest":
        void this.actions.addTest(target);
        break;
      case "removeTest":
        void this.actions.removeTest(s("name"), target);
        break;
      case "editTest":
        void this.actions.editTest(s("name"), s("field"), s("value"), target);
        break;
      case "editBench":
        void this.actions.editBench(s("field"), s("value"), target);
        break;
      case "openSubenvConfig":
        // drill into subenv from the per-file editor: the config path relative
        // to the DOCUMENT (the H1 nesting descends level by level through files)
        void this.actions.openSubenvConfig(s("config"), target);
        break;
      case "applyProposals":
        // docs/08 R12 — only the materialize rows exist in this editor (no model)
        void this.actions.applyProposals(
          undefined,
          (Array.isArray(args.items) ? (args.items as ProposalApply[]) : []).filter(
            (i) => i.kind === "materialize"
          ),
          target.configUri ? this.resolve?.resolvedFor(target.configUri) ?? null : null,
          target
        );
        break;
      case "openConfigBeside":
        // docs/08 R4 — THIS document as text, beside its diagram
        if (target.configUri) {
          void this.yamlLink?.openBeside(target.configUri);
        }
        break;
      default:
        this.log.appendLine(
          `[customeditor] action not available in the config editor: ${action}`
        );
    }
  }
}
