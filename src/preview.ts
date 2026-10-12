// The YAML diff preview before a destructive or multi-file gesture (docs/08
// R19) — the PURE part (no vscode), tested in Node (scripts/test-preview.mjs).
//
// A gesture's mutation is a function old text -> new text, so its effect can be
// computed BEFORE it is applied: what the host shows in the diff editor is
// exactly the text the WorkspaceEdit would write. This module only decides
// which files actually change and how to describe the change in one line; the
// diff tabs and the question are the host's part (src/previewdiff.ts).

import { minimalEdit } from "./textedit";

export interface FileChange {
  /** the display name (the file's basename) */
  label: string;
  oldText: string;
  newText: string;
  /** the gesture CREATES the file (`oldText` is the empty "before") */
  created?: boolean;
}

export interface ChangeSummary {
  added: number;
  removed: number;
}

/** the number of lines a text slice touches: a partial last line counts as one */
function lines(s: string): number {
  if (s.length === 0) {
    return 0;
  }
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      n++;
    }
  }
  return s.endsWith("\n") ? n : n + 1;
}

/**
 * The lines the MINIMAL edit (R4) removes from the old text and adds in the new
 * one — the same measure the editor highlights after the gesture, so the
 * summary in the confirmation and the flash in the YAML agree. Identical texts
 * are {0, 0}.
 */
export function summarize(oldText: string, newText: string): ChangeSummary {
  const e = minimalEdit(oldText, newText);
  if (!e) {
    return { added: 0, removed: 0 };
  }
  return { removed: lines(oldText.slice(e.start, e.end)), added: lines(e.text) };
}

/** the files the gesture actually changes, in the given order (a created file always counts) */
export function changedFiles<T extends FileChange>(changes: readonly T[]): T[] {
  return changes.filter((c) => c.created || c.oldText !== c.newText);
}

/** one line for a confirmation: `top.quickuvm.yaml (+3 -1), chan.quickuvm.yaml (new, +12)` */
export function changesLabel(changes: readonly FileChange[]): string {
  return changedFiles(changes)
    .map((c) => {
      if (c.created) {
        return `${c.label} (new, +${lines(c.newText)})`;
      }
      const s = summarize(c.oldText, c.newText);
      return `${c.label} (+${s.added} -${s.removed})`;
    })
    .join(", ");
}
