// The diff preview of a gesture before it is applied (docs/08 R19) — the host
// side: a TextDocumentContentProvider that serves the "after" text of each
// file, one `vscode.diff` tab per file (the real document on the left, so an
// unsaved buffer diffs against what the user sees), and the ONE confirmation
// flow every previewed gesture goes through.
//
// The rule of the row: a step is added only where a confirmation already stood
// (a destructive gesture's modal gains a "Preview changes" button) or where the
// effect lands in files the user is not looking at (a multi-file gesture); a
// single-file, non-destructive gesture is never previewed — immediacy wins.
// `quickuvm.previewEdits` chooses: `ask` (the button), `always` (the preview
// opens by itself and a notification confirms), `never` (the modal as before;
// a multi-file gesture applies directly).

import * as vscode from "vscode";
import { changedFiles, changesLabel, type FileChange } from "./preview";

export const PREVIEW_SCHEME = "quickuvm-preview";

export type PreviewEdits = "ask" | "always" | "never";

export function previewSetting(): PreviewEdits {
  const v = vscode.workspace.getConfiguration("quickuvm").get<string>("previewEdits", "ask");
  return v === "always" || v === "never" ? v : "ask";
}

/** a file of a gesture: the change plus the document it applies to (none for a created file) */
export interface PreviewFile extends FileChange {
  uri?: vscode.Uri;
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
  changes: readonly PreviewFile[];
  /** `destructive`: a modal in every mode; `multi-file`: a question only when
   *  more than one file changes, and none on `never` */
  kind: "destructive" | "multi-file";
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
   * Opens one diff tab per changed file (the first takes the focus, the rest
   * open behind it, none as a preview tab — a preview tab would replace the
   * previous one) and returns the closer: the tabs go when the question is
   * answered, whichever way.
   */
  async show(changes: readonly PreviewFile[], title: string): Promise<() => Promise<void>> {
    const token = String(++this.seq);
    const mine: string[] = [];
    const virtual = (side: string, c: PreviewFile, text: string): vscode.Uri => {
      // the label last: the tab is named after the file and the YAML language is picked
      const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${token}/${side}/${c.label}` });
      this.texts.set(uri.toString(), text);
      mine.push(uri.toString());
      return uri;
    };
    let first = true;
    for (const c of changedFiles(changes)) {
      const before = c.uri && !c.created ? c.uri : virtual("before", c, c.oldText);
      const after = virtual("after", c, c.newText);
      const label = c.created ? `${c.label} (${vscode.l10n.t("new file")})` : c.label;
      await vscode.commands.executeCommand("vscode.diff", before, after, `${label} ↔ ${title}`, {
        preview: false,
        preserveFocus: !first,
      });
      first = false;
    }
    return async () => {
      const tabs = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => {
          const input = t.input;
          return input instanceof vscode.TabInputTextDiff && mine.includes(input.modified.toString());
        });
      if (tabs.length) {
        await vscode.window.tabGroups.close(tabs, true);
      }
      for (const k of mine) {
        this.texts.delete(k);
      }
    };
  }
}

/**
 * The confirmation of a previewable gesture; true when it may be applied. The
 * texts are the gesture's own (old -> new through its mutation), so what is
 * shown is what will be written; the caller still applies through its usual
 * path (the minimal edit, the refresh).
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
  // `always`, or "Preview changes" picked: the diff tabs, then a NON-modal
  // question — a modal would block the very tabs the user is reading
  const close = await provider.show(changed, g.title);
  try {
    const pick = await vscode.window.showWarningMessage(
      [g.message, g.detail, summary].filter(Boolean).join(" "),
      g.verb,
      vscode.l10n.t("Cancel")
    );
    return pick === g.verb;
  } finally {
    await close();
  }
}
