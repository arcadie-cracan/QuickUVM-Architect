// The drawing of the secondary notation (docs/08 R21): frames behind the
// diagram, notes above it, tints on the boxes. Pure SVG construction over the
// data of `annotations.ts`; the gestures (drag, edit, menu, undo) are main.ts's.
//
// Layering: the frames are the FIRST child of the viewport (behind every box
// and wire — a frame is a background), the notes the LAST (a sticky note lies
// on top). Both are rebuilt whole on every draw: they are few, and a frame's
// box depends on where its members are right now.

import type { AnnotColor, ViewAnnotations } from "../protocol";
import { ANNOT_COLORS } from "../protocol";
import {
  FRAME_TITLE_H,
  NOTE_LINE,
  NOTE_PAD,
  NOTE_W,
  frameRects,
  isNoteId,
  noteSize,
  wrapText,
  type ARect,
} from "./annotations";
import { el } from "./svg";

/** the class that carries a tint (CSS maps it onto the theme's chart colour) */
export const tintClass = (c: AnnotColor | undefined): string => (c ? ` tint-${c}` : "");

/** the rectangle of every note as drawn — the notes' position holders: a drag
 *  mutates `x` / `y` in place, like a node's layout entry */
export type NoteRects = Map<string, ARect>;

/**
 * Lays the notes out (text wrapped to the fixed width, height from the lines).
 * Returns the rectangles AND the wrapped lines, so drawing does not wrap twice.
 */
export function layoutNotes(
  a: ViewAnnotations,
  measure: (s: string) => number
): { rects: NoteRects; lines: Map<string, string[]> } {
  const rects: NoteRects = new Map();
  const lines = new Map<string, string[]>();
  for (const [id, n] of Object.entries(a.notes)) {
    const ls = wrapText(n.text, NOTE_W - 2 * NOTE_PAD, measure);
    const size = noteSize(ls.length);
    lines.set(id, ls);
    rects.set(id, { x: n.x, y: n.y, w: size.w, h: size.h });
  }
  return { rects, lines };
}

/** removes what a previous draw left */
function clear(viewport: SVGGElement): void {
  viewport.querySelectorAll(":scope > .annot-frames, :scope > .annot-notes").forEach((g) => g.remove());
}

function drawFrames(
  group: SVGGElement,
  a: ViewAnnotations,
  boxes: ReadonlyMap<string, ARect>,
  measure: (s: string) => number
): void {
  group.replaceChildren();
  for (const [id, box] of boxes) {
    const f = a.frames[id];
    const g = el("g", { class: `frame${tintClass(f.color)}` });
    g.dataset.id = id;
    g.append(
      el("rect", {
        class: "frame-box",
        x: String(box.x),
        y: String(box.y),
        width: String(box.w),
        height: String(box.h),
        rx: "6",
      })
    );
    // the title tab: the frame's ONLY hit target — the box itself takes no
    // pointer events, so a lasso can start on the empty area inside a frame
    const title = f.title || "frame";
    const tabW = Math.min(box.w, Math.max(48, measure(title) + 20));
    g.append(
      el("rect", {
        class: "frame-tab",
        x: String(box.x),
        y: String(box.y),
        width: String(tabW),
        height: String(FRAME_TITLE_H - 4),
        rx: "6",
      }),
      el(
        "text",
        {
          class: `frame-title${f.title ? "" : " untitled"}`,
          x: String(box.x + 10),
          y: String(box.y + FRAME_TITLE_H - 10),
        },
        title
      )
    );
    group.append(g);
  }
}

/**
 * Draws the secondary notation of a view into its viewport and tints the
 * boxes. `rectOf` answers for nodes and flags (the layout); notes are laid out
 * here. Returns the notes' rectangles — the caller keeps them as the notes'
 * position holders and as their `rectOf`.
 */
export function drawAnnotations(
  canvas: SVGSVGElement,
  viewport: SVGGElement,
  a: ViewAnnotations,
  rectOf: (id: string) => ARect | null,
  measure: (s: string) => number
): NoteRects {
  clear(viewport);
  const { rects, lines } = layoutNotes(a, measure);
  const anyRect = (id: string): ARect | null =>
    isNoteId(id) ? rects.get(id) ?? null : rectOf(id);

  const frames = el("g", { class: "annot-frames" });
  drawFrames(frames, a, frameRects(a, anyRect), measure);
  viewport.insertBefore(frames, viewport.firstChild);

  const notes = el("g", { class: "annot-notes" });
  for (const [id, r] of rects) {
    const n = a.notes[id];
    const g = el("g", {
      class: `note${tintClass(n.color)}`,
      transform: `translate(${r.x},${r.y})`,
    });
    g.dataset.id = id;
    g.append(
      el("rect", {
        class: "note-box",
        x: "0",
        y: "0",
        width: String(r.w),
        height: String(r.h),
        rx: "2",
      })
    );
    const text = el("text", { class: "note-text", x: String(NOTE_PAD), y: String(NOTE_PAD - 3) });
    for (const line of lines.get(id) ?? []) {
      // an empty line still advances: a tspan with no text has no height
      text.append(el("tspan", { x: String(NOTE_PAD), dy: String(NOTE_LINE) }, line || " "));
    }
    g.append(text);
    notes.append(g);
  }
  viewport.append(notes);
  applyTints(canvas, a);
  return rects;
}

/** the frames' boxes only — during a drag the members move on every frame */
export function redrawFrames(
  viewport: SVGGElement,
  a: ViewAnnotations,
  rectOf: (id: string) => ARect | null,
  noteRects: NoteRects,
  measure: (s: string) => number
): void {
  const group = viewport.querySelector<SVGGElement>(":scope > .annot-frames");
  if (!group) {
    return;
  }
  const selected = new Set(
    [...group.querySelectorAll<SVGElement>(".frame.selected")].map((g) => g.dataset.id ?? "")
  );
  drawFrames(
    group,
    a,
    frameRects(a, (id) => (isNoteId(id) ? noteRects.get(id) ?? null : rectOf(id))),
    measure
  );
  group.querySelectorAll<SVGElement>(".frame").forEach((g) => {
    g.classList.toggle("selected", selected.has(g.dataset.id ?? ""));
  });
}

/** the node tints: a class on the box group (the RTL and the TB boxes alike) */
export function applyTints(canvas: SVGSVGElement, a: ViewAnnotations): void {
  canvas.querySelectorAll<SVGElement>(".inode[data-id], .tbnode[data-id]").forEach((g) => {
    const c = a.colors[g.dataset.id ?? ""];
    for (const name of ANNOT_COLORS) {
      g.classList.toggle(`tint-${name}`, name === c);
    }
  });
}
