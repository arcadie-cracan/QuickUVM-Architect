// The diff preview of a gesture before it is applied (docs/08 R19) — the host
// side: a TextDocumentContentProvider that serves two virtual snapshots per
// file (the live buffer's text and the mutation's), one `vscode.diff` tab per
// changed file, and the ONE confirmation flow every previewed gesture goes
// through.
//
// The rule of the row: a step is added only where a confirmation already stood
// (a destructive gesture's modal gains a "Preview changes" button) or where the
// effect lands in files the user is not looking at (a multi-file gesture); a
// single-file, non-destructive gesture is never previewed — immediacy wins.
// `quickuvm.previewEdits` chooses: `ask` (the button), `always` (the preview
// opens by itself and a QuickPick confirms), `never` (the modal as before; a
// multi-file gesture applies directly).
//
// Two facts from the adversarial review shape the mechanics: (1) the custom
// editor's `*.quickuvm.yaml` selector matches the BASENAME of a resource on
// ANY scheme, and on VS Code before the diff-priority normalisation a diff
// side with a matching name opened the TB webview instead of a text diff — so
// both sides are virtual and their paths end in `.preview.yaml`; (2) a
// notification toast with buttons is NOT sticky (a warning auto-hides after
// 12 s with its promise pending) — so the question after the preview is a
// QuickPick with `ignoreFocusOut`, which stays while the tabs are read.

import * as vscode from "vscode";
import { changedFiles, changesLabel, type FileChange } from "./preview";

export const PREVIEW_SCHEME = "quickuvm-preview";

export type PreviewEdits = "ask" | "always" | "never";

export function previewSetting(): PreviewEdits {
  const v = vscode.workspace.getConfiguration("quickuvm").get<string>("previewEdits", "ask");
  return v === "always" || v === "never" ? v : "ask";
}

export interface GestureConfirm {
  /** the question of the modal (`Delete agent "cmd"?`) */
  message: string;
  /** the cascade summary, under the question */
  detail?: string;
  /** the affirmative button ("Delete") */
  verb: string;
  /** the title of the preview tabs ("Delete agent cmd") */
  title: string;
  changes: readonly FileChange[];
  /** `destructive`: a modal in every mode; `multi-file`: a question only when
   *  more than one file changes, and none on `never` */
  kind: "destructive" | "multi-file";
}

/** an opened preview: whether any of its tabs is still open, and the closer */
export interface OpenPreview {
  isOpen(): boolean;
  close(): Promise<void>;
}

export class PreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly texts = new Map<string, string>();
  private seq = 0;
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, this);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.registration.dispose();
    this.texts.clear();
  }

  /**
   * Opens one diff tab per changed file and returns the opened preview. The
   * tabs are opened in REVERSE order — the last opened tab is the visible one,
   * so the first file ends on top — and never as preview tabs (a preview tab
   * replaces the previous one: two files would show one tab). A tab that fails
   * to open closes the ones already open before the error propagates.
   */
  async show(changes: readonly FileChange[], title: string): Promise<OpenPreview> {
    const token = String(++this.seq);
    const keys: string[] = [];
    const mine = new Set<string>();
    const virtual = (i: number, side: string, c: FileChange, text: string): vscode.Uri => {
      // never a name the custom editor's selector matches (see the header);
      // `.yaml` keeps the colouring, the index keeps two children with the same
      // basename apart (they collided on one uri — review finding)
      const uri = vscode.Uri.from({
        scheme: PREVIEW_SCHEME,
        path: `/${token}/${i}/${side}/${c.label}.preview.yaml`,
      });
      this.texts.set(uri.toString(), text);
      keys.push(uri.toString());
      return uri;
    };
    const tabsOf = (): vscode.Tab[] =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => {
          const input = t.input;
          return input instanceof vscode.TabInputTextDiff && mine.has(input.modified.toString());
        });
    const preview: OpenPreview = {
      isOpen: () => tabsOf().length > 0,
      close: async () => {
        const tabs = tabsOf();
        if (tabs.length) {
          await vscode.window.tabGroups.close(tabs, true);
        }
        for (const k of keys) {
          this.texts.delete(k);
        }
      },
    };
    const list = changedFiles(changes);
    try {
      for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i];
        const before = virtual(i, "before", c, c.oldText);
        const after = virtual(i, "after", c, c.newText);
        mine.add(after.toString());
        const label = c.created ? `${c.label} (${vscode.l10n.t("new file")})` : c.label;
        await vscode.commands.executeCommand("vscode.diff", before, after, `${label} ↔ ${title}`, {
          preview: false,
          preserveFocus: i !== 0,
        });
      }
    } catch (e) {
      await preview.close();
      throw e;
    }
    return preview;
  }
}

/**
 * The question over an open preview: a QuickPick that stays while the user
 * reads the tabs (`ignoreFocusOut`). Closing every preview tab by hand is an
 * answer too — a cancel.
 */
function askOverPreview(question: string, summary: string, verb: string, open: OpenPreview): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const qp = vscode.window.createQuickPick();
    const yes: vscode.QuickPickItem = { label: `$(check) ${verb}` };
    const no: vscode.QuickPickItem = { label: `$(close) ${vscode.l10n.t("Cancel")}` };
    qp.title = question;
    qp.placeholder = summary;
    qp.items = [yes, no];
    qp.ignoreFocusOut = true;
    let done = false;
    let tabs: vscode.Disposable | undefined;
    const finish = (v: boolean): void => {
      if (done) {
        return;
      }
      done = true;
      tabs?.dispose();
      qp.dispose();
      resolve(v);
    };
    qp.onDidAccept(() => finish(qp.selectedItems[0]?.label === yes.label));
    qp.onDidHide(() => finish(false));
    tabs = vscode.window.tabGroups.onDidChangeTabs(() => {
      if (!open.isOpen()) {
        finish(false);
      }
    });
    qp.show();
  });
}

/**
 * The confirmation of a previewable gesture; true when it may be applied. The
 * texts are the gesture's own (old -> new through its mutation), so what is
 * shown is what will be written; the caller still applies through its usual
 * path (the minimal edit, the refresh) — after checking that the documents
 * still hold the previewed texts.
 */
export async function confirmGesture(provider: PreviewProvider, g: GestureConfirm): Promise<boolean> {
  const changed = changedFiles(g.changes);
  if (!changed.length) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("QuickUVM Architect: nothing to change — {0}.", g.title)
    );
    return false;
  }
  const mode = previewSetting();
  const multi = g.kind === "multi-file";
  if (multi && changed.length < 2) {
    return true; // one file: an immediate gesture, never previewed (the row's own caveat)
  }
  if (mode === "never") {
    if (multi) {
      return true;
    }
    const pick = await vscode.window.showWarningMessage(g.message, { modal: true, detail: g.detail }, g.verb);
    return pick === g.verb;
  }
  const summary = vscode.l10n.t("Changes: {0}", changesLabel(changed));
  if (mode === "ask") {
    const PREVIEW = vscode.l10n.t("Preview changes");
    const pick = await vscode.window.showWarningMessage(
      g.message,
      { modal: true, detail: [g.detail, summary].filter(Boolean).join("\n") },
      g.verb,
      PREVIEW
    );
    if (pick !== PREVIEW) {
      return pick === g.verb;
    }
  }
  // `always`, or "Preview changes" picked: the diff tabs, then the question
  // over them (a modal would block the very tabs the user is reading)
  const open = await provider.show(changed, g.title);
  try {
    return await askOverPreview([g.message, g.detail].filter(Boolean).join(" "), summary, g.verb, open);
  } finally {
    await open.close();
  }
}
