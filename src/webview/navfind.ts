// Keyboard navigation helpers of the diagram (docs/08 R5) — a PURE module (no
// DOM, no vscode), tested in Node (scripts/test-navfind.mjs): the view history
// behind Ctrl+[ / Ctrl+], the ranking behind Ctrl+F, the "up one level" rules
// behind U / PageUp, and the union of rectangles behind G (fit selection).
//
// Why a module: main.ts is the DOM glue; every rule that can be wrong on its own
// (a history that records a re-render as a new entry, a search that ranks a
// substring above a prefix, a parent path that stops on a generate block) is
// cheaper to pin here than to reproduce in the harness.

/** a view the user was looking at: mode + view id (+ the TB level) */
export interface NavEntry {
  mode: string;
  viewId: string;
  /** the TB level (`""`, `env`, `agent:<name>`); `""` outside the TB view */
  focus: string;
}

export function sameEntry(a: NavEntry | null, b: NavEntry | null): boolean {
  return (
    !!a && !!b && a.mode === b.mode && a.viewId === b.viewId && a.focus === b.focus
  );
}

/**
 * The session's navigation history (Blueprints/Houdini/Simulink Back-Forward).
 * `visit` is idempotent on the current entry — a re-render of the same view
 * (config edit, theme change, drag) records nothing — and, like a browser,
 * a new visit after going back DROPS the forward entries.
 */
export class NavHistory {
  private entries: NavEntry[] = [];
  private idx = -1;

  constructor(private readonly max = 50) {}

  get current(): NavEntry | null {
    return this.entries[this.idx] ?? null;
  }

  get canBack(): boolean {
    return this.idx > 0;
  }

  get canForward(): boolean {
    return this.idx < this.entries.length - 1;
  }

  /** records a view change; no-op when it is the current entry */
  visit(e: NavEntry): void {
    if (sameEntry(this.current, e)) {
      return;
    }
    this.entries.splice(this.idx + 1); // a new branch forgets the forward history
    this.entries.push({ ...e });
    if (this.entries.length > this.max) {
      this.entries.shift();
    }
    this.idx = this.entries.length - 1;
  }

  back(): NavEntry | null {
    if (!this.canBack) {
      return null;
    }
    this.idx -= 1;
    return this.current;
  }

  forward(): NavEntry | null {
    if (!this.canForward) {
      return null;
    }
    this.idx += 1;
    return this.current;
  }
}

/** something the Ctrl+F box can land on: a node, a flag, a pin */
export interface FindItem {
  id: string;
  label: string;
}

/**
 * The matches of a query, best first: exact label, then label prefix, then a
 * word-start inside the label (after `.`, `_`, `[`, a space), then any substring
 * of the label or of the id. Case-insensitive; ties keep the scene order, so
 * the result is stable across re-renders. An empty query matches nothing.
 */
export function findMatches(
  items: readonly FindItem[],
  query: string,
  limit = 20
): FindItem[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [];
  }
  const scored: { item: FindItem; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const label = item.label.toLowerCase();
    const id = item.id.toLowerCase();
    let score: number;
    if (label === q) {
      score = 0;
    } else if (label.startsWith(q)) {
      score = 1;
    } else if (new RegExp(`[._\\[ ]${escapeRe(q)}`).test(label)) {
      score = 2;
    } else if (label.includes(q) || id.includes(q)) {
      score = 3;
    } else {
      return;
    }
    scored.push({ item, score, order });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.item);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The parent level of a TB focus (D24): `agent:<name>` -> `env`, `env` -> `""`
 * (the testbench root), the root -> null (nothing above).
 */
export function tbParentFocus(focus: string): string | null {
  if (focus === "") {
    return null;
  }
  return focus === "env" ? "" : "env";
}

/**
 * The parent VIEW of an RTL instance path: the longest proper prefix that is an
 * instance. Generate blocks are path segments without an instance of their own
 * (`demo_top.u_soc.g_ch[1].u_ch` -> `demo_top.u_soc`, not `...g_ch[1]`), so the
 * walk skips them. The top (no instance above) -> null.
 */
export function rtlParentPath(
  path: string,
  isInstance: (p: string) => boolean
): string | null {
  const segs = path.split(".");
  for (let n = segs.length - 1; n >= 1; n--) {
    const prefix = segs.slice(0, n).join(".");
    if (isInstance(prefix)) {
      return prefix;
    }
  }
  return null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** the smallest rectangle enclosing all of `rects`; null when there is none */
export function unionBounds(rects: readonly Rect[]): Rect | null {
  if (!rects.length) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** a stored camera (quick mark): translation + zoom */
export interface Camera {
  tx: number;
  ty: number;
  k: number;
}

/**
 * Quick marks (Houdini Ctrl+1..5): five camera slots PER layout key, session
 * state like the camera itself. Shift+<digit> stores, <digit> jumps; a jump to
 * an empty slot is a no-op (never moves the camera somewhere arbitrary).
 */
export class QuickMarks {
  private readonly marks = new Map<string, Camera>();

  set(layoutKey: string, slot: number, cam: Camera): void {
    this.marks.set(`${layoutKey}#${slot}`, { ...cam });
  }

  get(layoutKey: string, slot: number): Camera | null {
    const c = this.marks.get(`${layoutKey}#${slot}`);
    return c ? { ...c } : null;
  }
}
