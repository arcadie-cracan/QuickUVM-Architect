// The minimal text edit between two versions of a document (docs/08 R4) — a PURE
// module (no vscode), tested in Node (scripts/test-textedit.mjs).
//
// Every gesture produces a new YAML text through a surgical `yaml` Document
// mutation, but the host used to apply it as a whole-document replace. That hid
// the one fact the user most wants to see after a gesture — WHAT changed — and
// made the undo stack and the editor's view churn on the unchanged lines. The
// common prefix/suffix of the two texts gives the smallest single replacement
// that turns the old text into the new one; its new range is what the editor
// highlights (R4) and the only range the WorkspaceEdit touches.

export interface MinimalEdit {
  /** offset in the OLD text where the replacement starts */
  start: number;
  /** offset in the OLD text where the replaced span ends (exclusive) */
  end: number;
  /** the replacement text; empty for a pure deletion */
  text: string;
}

const NL = "\n";

/**
 * The smallest single replacement turning `oldText` into `newText`, or null
 * when they are identical. The suffix never overlaps the prefix: for
 * `"aa" -> "aaa"` the prefix takes both `a`, and the insertion lands at the
 * end. Pure insertions and deletions are then slid to a line boundary when an
 * equivalent position exists (see `alignToLines`).
 */
export function minimalEdit(oldText: string, newText: string): MinimalEdit | null {
  if (oldText === newText) {
    return null;
  }
  const oldLen = oldText.length;
  const newLen = newText.length;
  let prefix = 0;
  const maxPrefix = Math.min(oldLen, newLen);
  while (prefix < maxPrefix && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix = 0;
  const maxSuffix = Math.min(oldLen, newLen) - prefix;
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldLen - 1 - suffix) === newText.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++;
  }
  return alignToLines(oldText, {
    start: prefix,
    end: oldLen - suffix,
    text: newText.slice(prefix, newLen - suffix),
  });
}

/**
 * Slides a pure insertion or a pure deletion to a LINE boundary when an
 * equivalent position exists. The common-prefix walk stops at the first
 * differing character, which for a new list item lands mid-line: inserting
 * "  - name: mid" + newline before "  - name: rsp" is first found as
 * "mid" + newline + "  - name: " after the shared "  - name: " — the same edit,
 * but a highlight starting at "mid" and ending inside the next entry.
 * Replacements are left alone. The nearest aligned position wins (left first).
 */
function alignToLines(oldText: string, e: MinimalEdit): MinimalEdit {
  const lineStart = (i: number): boolean => i === 0 || oldText[i - 1] === NL;
  if (e.end === e.start && e.text.length) {
    // insertion: an equivalent position one step LEFT exists when the char
    // before it equals the last inserted char (rotate it to the front)
    let best: MinimalEdit | null = null;
    let start = e.start;
    let text = e.text;
    const check = (): void => {
      if (!best && lineStart(start) && text.endsWith(NL)) {
        best = { start, end: start, text };
      }
    };
    check();
    while (!best && start > 0 && oldText[start - 1] === text[text.length - 1]) {
      text = oldText[start - 1] + text.slice(0, -1);
      start--;
      check();
    }
    start = e.start;
    text = e.text;
    while (!best && start < oldText.length && oldText[start] === text[0]) {
      text = text.slice(1) + oldText[start];
      start++;
      check();
    }
    return best ?? e;
  }
  if (e.text === "" && e.end > e.start) {
    // deletion: moving the window left by one keeps the result when the char
    // entering it equals the char leaving it
    let best: MinimalEdit | null = null;
    let start = e.start;
    let end = e.end;
    const check = (): void => {
      if (!best && lineStart(start) && oldText[end - 1] === NL) {
        best = { start, end, text: "" };
      }
    };
    check();
    while (!best && start > 0 && oldText[start - 1] === oldText[end - 1]) {
      start--;
      end--;
      check();
    }
    start = e.start;
    end = e.end;
    while (!best && end < oldText.length && oldText[start] === oldText[end]) {
      start++;
      end++;
      check();
    }
    return best ?? e;
  }
  return e;
}

/**
 * The span of the change in the NEW text — what to highlight after the edit.
 * A pure deletion has an empty span at `start`; the editor still gets a
 * position to reveal.
 */
export function changedSpan(edit: MinimalEdit): { start: number; end: number } {
  return { start: edit.start, end: edit.start + edit.text.length };
}

/**
 * Widens a span to whole lines of `text` (start of the first line, end of the
 * last line, newline excluded): a gesture's change is read as YAML lines, and a
 * highlight that starts mid-key is harder to see than the whole entry.
 */
export function wholeLines(
  text: string,
  span: { start: number; end: number }
): { start: number; end: number } {
  let start = Math.min(span.start, text.length);
  while (start > 0 && text[start - 1] !== NL) {
    start--;
  }
  let end = Math.min(Math.max(span.end, span.start), text.length);
  // a span ending right after a newline belongs to the previous line, not the next
  if (end > start && text[end - 1] === NL) {
    end--;
    if (end > start && text[end - 1] === "\r") {
      end--;
    }
  }
  while (end < text.length && text[end] !== NL && text[end] !== "\r") {
    end++;
  }
  return { start, end };
}
