// Editorul grafic per-FISIER pentru `*.quickuvm.yaml` (felia 4, D22): diagrama
// de verificare TB devine editorul IMPLICIT al fisierului, prin
// `CustomTextEditorProvider`. YAML-ul ramane sursa de adevar (invariantul 2):
// fiecare gest produce un `WorkspaceEdit` pe DOCUMENT (undo/diff/editare text
// native), iar orice schimbare de text re-randeaza diagrama din YAML.
//
// Diagrama TB e config-driven (nu are nevoie de modelul RTL — `renderTb` nu-l
// atinge), deci se randeaza din textul documentului. Gesturile de editare TB
// (add/delete/edit) trec prin ACELEASI metode din `actions.ts`, dar cu tinta =
// documentul (`DocumentEditTarget`), nu config-ul activ — vezi `TbEditTarget`.

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

/** `TbEditTarget` legat de un TextDocument: config-ul e textul lui curent,
 *  iar `apply` scrie un WorkspaceEdit pe el (ca `ConfigService.apply`, dar pe
 *  documentul deschis, nu pe config-ul activ). */
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
      return false; // no-op: fara WorkspaceEdit (ca ConfigService.apply)
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

    // Orice schimbare a documentului (editare text, undo/redo, sau propriul
    // WorkspaceEdit al unui gest) re-randeaza diagrama din YAML-ul curent.
    // Idempotent, fara bucla: `config/full` -> randare nu emite alt edit.
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
    // exporter activ (comanda din paleta): doar cand ACEST editor e tab-ul
    // vizibil — altfel exportul mergea si de pe Welcome/fisier sursa
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
        // layout-ul (drag/flip/pliaj/re-aranjare) merge in sidecar-ul COMUN,
        // cheiat pe `tb:<cale>` — aceeasi mecanica ca panelul
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
        // tb/focus (drill local) si select/changed nu au sincronizare de arbore
        // in editorul per-fisier — se ignora
        default:
          break;
      }
    });
  }

  /** Gesturile de EDITARE TB, aplicate pe DOCUMENT (nu pe config-ul activ).
   *  Gesturile de DESIGN (createProbe/wireConnections/…) nu apar in vederea TB. */
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
      case "openSubenvConfig":
        // drill in subenv din editorul per-fisier: calea config-ului relativa
        // la DOCUMENT (nesting-ul H1 coboara nivel cu nivel prin file-uri)
        void this.actions.openSubenvConfig(s("config"), target);
        break;
      default:
        this.log.appendLine(
          `[customeditor] action not available in the config editor: ${action}`
        );
    }
  }
}
