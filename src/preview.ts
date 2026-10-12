// The YAML diff preview before a destructive or multi-file gesture (docs/08
// R19) — the PURE part (no vscode), tested in Node (scripts/test-preview.mjs).
//
// A gesture's mutation is a function old text -> new text, so its effect can be
// computed BEFORE it is applied: what the host shows in the diff editor is
// exactly the text the WorkspaceEdit would write. This module only decides
// which files actually change and how to describe the change in one line; the
// diff tabs and the question are the host's part (src/previewdiff.ts).

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

/** the number of lines of a text: a partial last line counts as one */
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
 * The lines a change removes from the old text and adds in the new one, counted
 * the way the diff editor counts the hunk: the lines before the first differing
 * line and after the last one are common, the rest is removed / added. An
 * in-line change is 1/1, a block deletion counts its lines and adds none, an
 * insertion adds its lines and removes none. (The character-level minimal edit
 * of R4 is the wrong measure here — review finding: it counted the newline a
 * deletion takes from the previous line in a file without a final newline as a
 * line, and an in-line insertion as +1 -0.) Identical texts are {0, 0}.
 */
export function summarize(oldText: string, newText: string): ChangeSummary {
  if (oldText === newText) {
    return { added: 0, removed: 0 };
  }
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const maxPrefix = Math.min(a.length, b.length);
  let p = 0;
  while (p < maxPrefix && a[p] === b[p]) {
    p++;
  }
  const maxSuffix = maxPrefix - p;
  let q = 0;
  while (q < maxSuffix && a[a.length - 1 - q] === b[b.length - 1 - q]) {
    q++;
  }
  return { removed: a.length - p - q, added: b.length - p - q };
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
