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
import type { TbEditTarget } from "./config";
import {
  clearActiveExporter,
  diagramHtml,
  saveExportedSvg,
  setActiveExporter,
} from "./panel";
import type { ActionKind, LassoMode, WebviewMessage } from "./protocol";
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
    if (newText === oldText) {
      return false; // no-op: no WorkspaceEdit (like ConfigService.apply)
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.doc.uri,
      new vscode.Range(
        this.doc.positionAt(0),
        this.doc.positionAt(oldText.length)
      ),
      newText
    );
    return vscode.workspace.applyEdit(edit);
  }
}

export class QuvmConfigEditor implements vscode.CustomTextEditorProvider {
  static readonly viewType = "quickuvm.configEditor";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly layout: LayoutStore,
    private readonly actions: Actions,
    private readonly log: vscode.OutputChannel
  ) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): void {
    const webview = webviewPanel.webview;
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
        void webview.postMessage({
          v: 1,
          type: "config/full",
          configPath,
          config: parseQuvm(document.getText()),
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
        // tb/focus (local drill) and select/changed have no tree synchronization
        // in the per-file editor — they are ignored
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
      default:
        this.log.appendLine(
          `[customeditor] action not available in the config editor: ${action}`
        );
    }
  }
}
