// Secondary notation (docs/08 R21) — pure, no DOM: frames, sticky notes and
// node colours of ONE view, as plain data in and plain data out.
//
// These are annotations of the VIEW, never of the verification model
// (decision D25): they live in the layout sidecar, the QuickUVM YAML never
// hears of them, and the generator's output does not change by a byte.
//
//  - a FRAME stores its members, not a rectangle. Its box is the members'
//    bounding box plus padding, recomputed on every draw — so it survives a
//    re-arrangement, a collapse or a renamed block, and dragging it is dragging
//    its members. A member id that is not on screen is inert, not removed.
//  - a NOTE is text at a position; it can be a member of a frame.
//  - a COLOUR is a name from the theme's chart palette on a node, a frame or a
//    note.
//
// Every function returns a NEW `ViewAnnotations` (the input is never mutated):
// the caller keeps the previous value as its undo entry.
//
// Tested in `npm run test:annotations`.

import {
  ANNOT_NOTE_MAX,
  ANNOT_TITLE_MAX,
  type AnnotColor,
  type SidecarFrame,
  type SidecarNote,
  type ViewAnnotations,
} from "../protocol";

export interface ARect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** the air between a frame's border and its members */
export const FRAME_PAD = 16;
/** the extra band at the top of a frame, where its title tab sits */
export const FRAME_TITLE_H = 24;
/** a note's width: fixed (a multiple of the grid), the height follows the text */
export const NOTE_W = 176;
export const NOTE_PAD = 8;
export const NOTE_LINE = 14;
export const NOTE_MAX_LINES = 24;

export function emptyAnnotations(): ViewAnnotations {
  return { frames: {}, notes: {}, colors: {} };
}

export function cloneAnnotations(a: ViewAnnotations): ViewAnnotations {
  const out = emptyAnnotations();
  for (const [id, f] of Object.entries(a.frames)) {
    out.frames[id] = { ...f, members: [...f.members] };
  }
  for (const [id, n] of Object.entries(a.notes)) {
    out.notes[id] = { ...n };
  }
  out.colors = { ...a.colors };
  return out;
}

export function sameAnnotations(a: ViewAnnotations, b: ViewAnnotations): boolean {
  const norm = (v: ViewAnnotations): string => {
    const sorted = <T>(o: Record<string, T>): [string, T][] =>
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]]);
    return JSON.stringify([sorted(v.frames), sorted(v.notes), sorted(v.colors)]);
  };
  return norm(a) === norm(b);
}

export const isFrameId = (id: string): boolean => id.startsWith("frame:");
export const isNoteId = (id: string): boolean => id.startsWith("note:");

/** the next free id of a kind: the smallest `<kind>:<n>` (n >= 1) not in use */
export function nextId(kind: "frame" | "note", existing: Iterable<string>): string {
  const used = new Set(existing);
  let n = 1;
  while (used.has(`${kind}:${n}`)) {
    n++;
  }
  return `${kind}:${n}`;
}

/** frame / note ids in the order of their numbers (`frame:2` before
 *  `frame:10`) — the order the host's sanitiser resolves a double claim in */
export function byNumber(ids: Iterable<string>): string[] {
  const n = (id: string): number => Number(id.slice(id.indexOf(":") + 1));
  return [...ids].sort((p, q) => n(p) - n(q));
}

/** the frame a member belongs to (a member is in ONE frame), or null; on a
 *  double claim (a hand-edited file) the lower-numbered frame, as on the host */
export function frameOf(a: ViewAnnotations, memberId: string): string | null {
  for (const id of byNumber(Object.keys(a.frames))) {
    if (a.frames[id].members.includes(memberId)) {
      return id;
    }
  }
  return null;
}

/**
 * The box of a frame around its members' rectangles: their bounding box plus
 * `FRAME_PAD`, with the title band on top. null when no member is on screen —
 * then the frame is not drawn (and not deleted: its members may come back).
 */
export function frameRect(members: readonly ARect[]): ARect | null {
  if (!members.length) {
    return null;
  }
  const minX = Math.min(...members.map((m) => m.x));
  const minY = Math.min(...members.map((m) => m.y));
  const maxX = Math.max(...members.map((m) => m.x + m.w));
  const maxY = Math.max(...members.map((m) => m.y + m.h));
  return {
    x: minX - FRAME_PAD,
    y: minY - FRAME_PAD - FRAME_TITLE_H,
    w: maxX - minX + 2 * FRAME_PAD,
    h: maxY - minY + 2 * FRAME_PAD + FRAME_TITLE_H,
  };
}

/** the box of every drawable frame, from the rectangle of each member id */
export function frameRects(
  a: ViewAnnotations,
  rectOf: (id: string) => ARect | null
): Map<string, ARect> {
  const out = new Map<string, ARect>();
  for (const [id, f] of Object.entries(a.frames)) {
    const rects: ARect[] = [];
    for (const m of f.members) {
      const r = rectOf(m);
      if (r) {
        rects.push(r);
      }
    }
    const box = frameRect(rects);
    if (box) {
      out.set(id, box);
    }
  }
  return out;
}

/**
 * A new frame around `members`. A member leaves the frame it was in (one frame
 * per member), and a frame emptied that way is deleted. No members, no frame.
 */
export function addFrame(
  a: ViewAnnotations,
  members: readonly string[],
  title: string
): { annotations: ViewAnnotations; id: string | null } {
  const ids = [...new Set(members)].filter((m) => m && !isFrameId(m));
  if (!ids.length) {
    return { annotations: a, id: null };
  }
  let out = cloneAnnotations(a);
  for (const m of ids) {
    out = leaveFrame(out, m);
  }
  const id = nextId("frame", Object.keys(out.frames));
  out.frames[id] = { title: title.trim().slice(0, ANNOT_TITLE_MAX), members: ids };
  return { annotations: out, id };
}

/** a member joins a frame (leaving the one it was in) */
export function joinFrame(
  a: ViewAnnotations,
  frameId: string,
  memberId: string
): ViewAnnotations {
  if (!a.frames[frameId] || isFrameId(memberId) || a.frames[frameId].members.includes(memberId)) {
    return a;
  }
  const out = leaveFrame(cloneAnnotations(a), memberId);
  if (!out.frames[frameId]) {
    return a; // it was the frame's own last member moving house: nothing to join
  }
  out.frames[frameId].members.push(memberId);
  return out;
}

/** a member leaves its frame; a frame left without members is deleted */
export function leaveFrame(a: ViewAnnotations, memberId: string): ViewAnnotations {
  const fid = frameOf(a, memberId);
  if (!fid) {
    return a;
  }
  const out = cloneAnnotations(a);
  const f = out.frames[fid];
  f.members = f.members.filter((m) => m !== memberId);
  if (!f.members.length) {
    delete out.frames[fid];
  }
  return out;
}

export function deleteFrame(a: ViewAnnotations, frameId: string): ViewAnnotations {
  if (!a.frames[frameId]) {
    return a;
  }
  const out = cloneAnnotations(a);
  delete out.frames[frameId];
  return out;
}

export function setFrameTitle(
  a: ViewAnnotations,
  frameId: string,
  title: string
): ViewAnnotations {
  const t = title.trim().slice(0, ANNOT_TITLE_MAX);
  if (!a.frames[frameId] || a.frames[frameId].title === t) {
    return a;
  }
  const out = cloneAnnotations(a);
  out.frames[frameId].title = t;
  return out;
}

/** a new note at (x, y); empty text makes no note */
export function addNote(
  a: ViewAnnotations,
  x: number,
  y: number,
  text: string
): { annotations: ViewAnnotations; id: string | null } {
  if (!text.trim()) {
    return { annotations: a, id: null };
  }
  const out = cloneAnnotations(a);
  const id = nextId("note", Object.keys(out.notes));
  out.notes[id] = { x, y, text: text.slice(0, ANNOT_NOTE_MAX) };
  return { annotations: out, id };
}

/** a note's text; EMPTY text deletes the note (there is nothing left to show) */
export function setNoteText(a: ViewAnnotations, noteId: string, text: string): ViewAnnotations {
  if (!a.notes[noteId]) {
    return a;
  }
  if (!text.trim()) {
    return deleteNote(a, noteId);
  }
  const t = text.slice(0, ANNOT_NOTE_MAX);
  if (a.notes[noteId].text === t) {
    return a;
  }
  const out = cloneAnnotations(a);
  out.notes[noteId].text = t;
  return out;
}

export function moveNotes(
  a: ViewAnnotations,
  positions: Readonly<Record<string, { x: number; y: number }>>
): ViewAnnotations {
  let out: ViewAnnotations | null = null;
  for (const [id, p] of Object.entries(positions)) {
    const n = a.notes[id];
    if (n && (n.x !== p.x || n.y !== p.y)) {
      out ??= cloneAnnotations(a);
      out.notes[id].x = p.x;
      out.notes[id].y = p.y;
    }
  }
  return out ?? a;
}

/** a note is deleted, and leaves the frame it was in */
export function deleteNote(a: ViewAnnotations, noteId: string): ViewAnnotations {
  if (!a.notes[noteId]) {
    return a;
  }
  // `leaveFrame` returns its input or a copy of it: either way a private copy
  const out = leaveFrame(cloneAnnotations(a), noteId);
  delete out.notes[noteId];
  return out;
}

/**
 * A colour (or none) on a set of ids: a frame's and a note's colour is its own
 * field, a node's goes into `colors`. Ids that are neither are node ids — the
 * caller passes only ids that are on screen.
 */
export function setColor(
  a: ViewAnnotations,
  ids: readonly string[],
  color: AnnotColor | null
): ViewAnnotations {
  const out = cloneAnnotations(a);
  for (const id of ids) {
    const target: SidecarFrame | SidecarNote | undefined = isFrameId(id)
      ? out.frames[id]
      : isNoteId(id)
        ? out.notes[id]
        : undefined;
    if (isFrameId(id) || isNoteId(id)) {
      if (target) {
        if (color) {
          target.color = color;
        } else {
          delete target.color;
        }
      }
    } else if (color) {
      out.colors[id] = color;
    } else {
      delete out.colors[id];
    }
  }
  return sameAnnotations(a, out) ? a : out;
}

/**
 * Ids renamed in the scene (docs/08 R14: an agent's rename changes `agent:`,
 * its `cov:` and its `<if>.` flag): the frame memberships and the colours follow
 * the new ids. An old id that is not referenced changes nothing.
 */
export function renameIds(
  a: ViewAnnotations,
  pairs: readonly (readonly [string, string])[]
): ViewAnnotations {
  const map = new Map(pairs.map(([o, n]) => [o, n]));
  const out = cloneAnnotations(a);
  for (const f of Object.values(out.frames)) {
    f.members = [...new Set(f.members.map((m) => map.get(m) ?? m))];
  }
  for (const [o, n] of map) {
    if (out.colors[o] !== undefined) {
      out.colors[n] = out.colors[o];
      delete out.colors[o];
    }
  }
  return sameAnnotations(a, out) ? a : out;
}

/**
 * The containment test at a drag's end: an item that was MOVED INTO a frame's
 * box — its centre outside before the drag, inside after — and belongs to no
 * frame joins that frame (the smallest one, when boxes overlap). An item
 * already in a frame never changes house by being dragged — its frame simply
 * grows to follow it; leaving is an explicit action. Frames are not members of
 * frames.
 *
 * ENTERING, not merely ending inside: a block taken out of a frame with
 * "Remove from frame" usually still lies between the frame's other members,
 * and nudging it must not put it straight back (review finding).
 *
 * `boxes` are the frames' boxes AFTER the move; `moved` the dragged items'
 * rectangles after the move and, in `from`, before it (absent = treat the item
 * as coming from outside).
 */
export function dropIntoFrames(
  a: ViewAnnotations,
  boxes: ReadonlyMap<string, ARect>,
  moved: readonly { id: string; rect: ARect; from?: ARect }[]
): ViewAnnotations {
  let out = a;
  const inside = (r: ARect, b: ARect): boolean => {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
  };
  for (const m of moved) {
    if (isFrameId(m.id) || frameOf(out, m.id)) {
      continue;
    }
    let best: string | null = null;
    let bestArea = Infinity;
    for (const [fid, b] of boxes) {
      if (inside(m.rect, b) && !(m.from && inside(m.from, b))) {
        const area = b.w * b.h;
        if (area < bestArea || (area === bestArea && best !== null && fid < best)) {
          best = fid;
          bestArea = area;
        }
      }
    }
    if (best) {
      out = joinFrame(out, best, m.id);
    }
  }
  return out;
}

// --------------------------------------------------------------- note text

/**
 * A note's text as drawn: the user's own line breaks kept, each line wrapped
 * at word boundaries to `maxWidth` (a word longer than the line is cut by
 * characters), capped at `NOTE_MAX_LINES` with an ellipsis on the last one —
 * the full text stays in the sidecar and in the editor.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
  maxLines = NOTE_MAX_LINES
): string[] {
  const lines: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    const words = para.split(/[ \t]+/).filter(Boolean);
    if (!words.length) {
      lines.push(""); // an empty line the user typed
      continue;
    }
    let cur = "";
    const flush = (): void => {
      lines.push(cur);
      cur = "";
    };
    for (let w of words) {
      const candidate = cur ? `${cur} ${w}` : w;
      if (measure(candidate) <= maxWidth) {
        cur = candidate;
        continue;
      }
      if (cur) {
        flush();
      }
      // a word wider than the whole line: cut it by characters
      while (measure(w) > maxWidth && w.length > 1) {
        let n = w.length - 1;
        while (n > 1 && measure(w.slice(0, n)) > maxWidth) {
          n--;
        }
        lines.push(w.slice(0, n));
        w = w.slice(n);
      }
      cur = w;
    }
    flush();
  }
  while (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop(); // trailing blank lines draw nothing
  }
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = `${cut[maxLines - 1].replace(/\s+$/, "")}…`;
    return cut;
  }
  return lines;
}

/** a note's size for `lines` of text: fixed width, the height on the grid */
export function noteSize(lines: number, grid = 8): { w: number; h: number } {
  const h = Math.max(1, lines) * NOTE_LINE + 2 * NOTE_PAD;
  return { w: NOTE_W, h: Math.ceil(h / grid) * grid };
}
