// Selection and arrangement geometry (docs/08 R7) — pure, no DOM:
//
//  - the marquee's modifiers: what a lasso does to the selection it started
//    from (replace / add / subtract / toggle), and which targets a rectangle
//    picks (fully enclosed, or merely touched);
//  - align / distribute on a multi-selection of blocks and flags;
//  - straighten: move blocks vertically until the wires between them are
//    straight (the y of the two pin centres made equal).
//
// Everything works in diagram coordinates on the 8px grid (docs/04) and returns
// ONLY the positions that change; the caller persists them as one total
// `layout/snapshot` (D21) with one undo entry, exactly like a drag end.
//
// Tested in `npm run test:arrange`.

// ------------------------------------------------------------- the marquee

/** what a lasso does to the selection it started from */
export type MarqueeOp = "replace" | "add" | "subtract" | "toggle";

/**
 * The lasso's operation from the modifiers held at the press — the Blueprints
 * set: plain = replace, Shift = add, Alt = subtract, Ctrl/Cmd = toggle.
 *
 * Ctrl TOGGLES (it does not subtract) because Ctrl+click already toggles one
 * element, and one modifier must not mean two things. Subtract is Alt. With
 * several held, the most specific intent wins: Alt, then Shift, then Ctrl.
 */
export function marqueeOp(mods: {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}): MarqueeOp {
  if (mods.alt) {
    return "subtract";
  }
  if (mods.shift) {
    return "add";
  }
  if (mods.ctrl) {
    return "toggle";
  }
  return "replace";
}

/**
 * The selection a lasso produces: `base` is the selection at the press (frozen
 * for the whole drag, so the result is stable while the pointer moves — sweeping
 * back OFF an element restores it), `hits` what the rectangle picks right now.
 */
export function marqueeSelection(
  base: ReadonlySet<string>,
  hits: Iterable<string>,
  op: MarqueeOp
): Set<string> {
  if (op === "replace") {
    return new Set(hits);
  }
  const out = new Set(base);
  for (const id of hits) {
    if (op === "add") {
      out.add(id);
    } else if (op === "subtract") {
      out.delete(id);
    } else if (base.has(id)) {
      out.delete(id);
    } else {
      out.add(id);
    }
  }
  return out;
}

/** which targets a lasso rectangle picks */
export type LassoRule = "contain" | "intersect";

/**
 * The rule for this drag from the `quickuvm.lassoMode` setting. "direction" is
 * the CAD convention: dragged left-to-right the rectangle is a window (only
 * what it fully encloses), right-to-left it is a crossing (also what it merely
 * touches). `dx` is the pointer's horizontal travel since the press.
 */
export function lassoRule(
  mode: "contain" | "intersect" | "direction",
  dx: number
): LassoRule {
  if (mode === "direction") {
    return dx < 0 ? "intersect" : "contain";
  }
  return mode;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** the ids of the candidates the rectangle picks under `rule` */
export function lassoHits(
  rect: Box,
  candidates: readonly { id: string; r: Box }[],
  rule: LassoRule
): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    const hit =
      rule === "intersect"
        ? c.r.left < rect.right &&
          c.r.right > rect.left &&
          c.r.top < rect.bottom &&
          c.r.bottom > rect.top
        : c.r.left >= rect.left &&
          c.r.right <= rect.right &&
          c.r.top >= rect.top &&
          c.r.bottom <= rect.bottom;
    if (hit) {
      out.push(c.id);
    }
  }
  return out;
}

// ------------------------------------------------------ align / distribute

export interface ArrangeItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PosMap = Record<string, { x: number; y: number }>;

export type AlignOp = "left" | "right" | "top" | "bottom" | "hcenter" | "vcenter";

const snap = (v: number, grid: number): number => Math.round(v / grid) * grid;

/**
 * Aligns the items on one edge or centre line of their common bounding box;
 * the other axis is untouched. `hcenter` puts the centres on one VERTICAL line
 * (same x centre), `vcenter` on one HORIZONTAL line. Returns only the items
 * that move; fewer than two items align to nothing.
 */
export function alignItems(
  items: readonly ArrangeItem[],
  op: AlignOp,
  grid = 8
): PosMap {
  const out: PosMap = {};
  if (items.length < 2) {
    return out;
  }
  const minX = Math.min(...items.map((i) => i.x));
  const maxX = Math.max(...items.map((i) => i.x + i.w));
  const minY = Math.min(...items.map((i) => i.y));
  const maxY = Math.max(...items.map((i) => i.y + i.h));
  for (const it of items) {
    // only the axis the operation works on is snapped: the other one is the
    // user's, exactly as it is
    let x = it.x;
    let y = it.y;
    switch (op) {
      case "left":
        x = snap(minX, grid);
        break;
      case "right":
        x = snap(maxX - it.w, grid);
        break;
      case "top":
        y = snap(minY, grid);
        break;
      case "bottom":
        y = snap(maxY - it.h, grid);
        break;
      case "hcenter":
        x = snap((minX + maxX) / 2 - it.w / 2, grid);
        break;
      case "vcenter":
        y = snap((minY + maxY) / 2 - it.h / 2, grid);
        break;
    }
    if (x !== it.x || y !== it.y) {
      out[it.id] = { x, y };
    }
  }
  return out;
}

/**
 * Distributes the items along one axis with EQUAL GAPS between neighbours: the
 * two outermost stay where they are, the ones between are spaced out. Needs
 * three items (two have nothing between them). Overlapping items get an equal
 * (negative) gap rather than a refusal. The other axis is untouched.
 */
export function distributeItems(
  items: readonly ArrangeItem[],
  axis: "h" | "v",
  grid = 8
): PosMap {
  const out: PosMap = {};
  if (items.length < 3) {
    return out;
  }
  const pos = (i: ArrangeItem): number => (axis === "h" ? i.x : i.y);
  const size = (i: ArrangeItem): number => (axis === "h" ? i.w : i.h);
  // by position, then by id: a tie must not depend on the selection's order
  const sorted = [...items].sort(
    (a, b) => pos(a) - pos(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const first = sorted[0];
  const last = sorted.reduce((m, i) => (pos(i) + size(i) > pos(m) + size(m) ? i : m));
  if (last === first) {
    return out; // one item spans all the others: there is no row to space out
  }
  // the last item by its FAR edge may not be the last by position (a wide box
  // that starts early): keep it at the end of the row so the span is the union
  const row = sorted.filter((i) => i !== last);
  row.push(last);
  const span = pos(last) + size(last) - pos(first);
  const total = row.reduce((s, i) => s + size(i), 0);
  const gap = (span - total) / (row.length - 1);
  let cursor = pos(first);
  for (let k = 0; k < row.length; k++) {
    const it = row[k];
    if (k > 0 && k < row.length - 1) {
      const v = snap(cursor, grid);
      if (v !== pos(it)) {
        out[it.id] = axis === "h" ? { x: v, y: it.y } : { x: it.x, y: v };
      }
    }
    cursor += size(it) + gap;
  }
  return out;
}

// ---------------------------------------------------------------- straighten

/** a wire between two items: the y of each pin centre, relative to its item */
export interface PinLink {
  a: string;
  ay: number;
  b: string;
  by: number;
}

/**
 * Straightens the wires between the items: starting from an item that STAYS,
 * each item wired to an already-placed one is moved vertically until the two
 * pin centres have the same y — the wire between them becomes one straight
 * segment. Only y changes, and only for items in `items` (the selection).
 *
 * `anchor` is the item that stays (the one the gesture was invoked on); without
 * it, or for the groups not wired to it, the leftmost item of each connected
 * group stays. When several wires join the same two items only one can be
 * straight: the first in `links` order wins (the scene's edge order, stable).
 * Pins sit on the grid by construction (docs/04), so the result stays on it;
 * the snap is a safety net for an off-grid seed.
 *
 * A move that would put the item ON another box is refused, and the item stays
 * where it is: two blocks in one column feeding the same block cannot both get
 * a straight wire (their target pins are one pin pitch apart, the blocks far
 * taller), and stacking them is never what "straighten" was asked for. Every
 * move is checked against everything else where it stands at that moment —
 * the other items (moved or not) and `others`, the boxes outside the selection
 * — with one grid step of air, so the gesture can never create an overlap.
 */
export function straightenItems(
  items: readonly ArrangeItem[],
  links: readonly PinLink[],
  anchor: string | null = null,
  grid = 8,
  others: readonly ArrangeItem[] = []
): PosMap {
  const byId = new Map(items.map((i) => [i.id, i]));
  const collides = (it: ArrangeItem, ny: number): boolean => {
    const hit = (o: ArrangeItem, oy: number): boolean =>
      it.x < o.x + o.w + grid &&
      o.x < it.x + it.w + grid &&
      ny < oy + o.h + grid &&
      oy < ny + it.h + grid;
    return (
      others.some((o) => !byId.has(o.id) && hit(o, o.y)) ||
      items.some((o) => o.id !== it.id && hit(o, y.get(o.id) ?? o.y))
    );
  };
  const y = new Map<string, number>();
  const adj = new Map<string, { other: string; own: number; theirs: number }[]>();
  for (const l of links) {
    if (l.a === l.b || !byId.has(l.a) || !byId.has(l.b)) {
      continue; // a self-loop, or a wire that leaves the selection
    }
    (adj.get(l.a) ?? adj.set(l.a, []).get(l.a)!).push({ other: l.b, own: l.ay, theirs: l.by });
    (adj.get(l.b) ?? adj.set(l.b, []).get(l.b)!).push({ other: l.a, own: l.by, theirs: l.ay });
  }
  // the roots: the anchor first, then the rest left-to-right (top-to-bottom, id)
  const order = [...items].sort(
    (p, q) => p.x - q.x || p.y - q.y || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)
  );
  if (anchor && byId.has(anchor)) {
    order.sort((p, q) => Number(q.id === anchor) - Number(p.id === anchor));
  }
  for (const root of order) {
    if (y.has(root.id) || !adj.has(root.id)) {
      continue; // already placed, or wired to nothing in the selection
    }
    y.set(root.id, root.y);
    const queue = [root.id];
    while (queue.length) {
      const cur = queue.shift() as string;
      const curY = y.get(cur) as number;
      for (const e of adj.get(cur) ?? []) {
        if (y.has(e.other)) {
          continue;
        }
        // pin centres equal: curY + own === otherY + theirs
        const it = byId.get(e.other) as ArrangeItem;
        const ny = snap(curY + e.own - e.theirs, grid);
        // refused on a collision: it stays, and the walk goes on from where it is
        y.set(e.other, collides(it, ny) ? it.y : ny);
        queue.push(e.other);
      }
    }
  }
  const out: PosMap = {};
  for (const it of items) {
    const ny = y.get(it.id);
    if (ny !== undefined && ny !== it.y) {
      out[it.id] = { x: it.x, y: ny };
    }
  }
  return out;
}

/** are any two of the items wired to each other (is "straighten" worth offering)? */
export function hasLinks(
  items: readonly ArrangeItem[],
  links: readonly PinLink[]
): boolean {
  const ids = new Set(items.map((i) => i.id));
  return links.some((l) => l.a !== l.b && ids.has(l.a) && ids.has(l.b));
}
