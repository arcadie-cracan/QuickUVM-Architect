// Hand-routed wires — level 3 of the routing overrides (docs/04, decision
// D27). Pure module, without DOM — testable in Node (scripts/test-wireroute.mjs).
// The webview only draws what this module computes and forwards the gestures.
//
// The model (the decisions, each asked of the user):
// - a manual route is a SKELETON: the interior segments of an orthogonal wire,
//   in order from the source pin to the target pin. A wire leaves and enters
//   its pins horizontally, so the interior alternates vertical, horizontal,
//   …, vertical — an odd count. Each segment stores ONE number: the offset of
//   its line from the pin at one end of the edge (`source` or `target`), on the
//   segment's own axis. Never an absolute coordinate: moving a block carries
//   the segments anchored to its pin, and the ones in between stretch;
// - the override is stored per EDGE, the gesture works on the wire GROUP — the
//   edges that share a net or a pin: a trunk several branches run on is
//   dragged as one wire, and the whole group is frozen at the first gesture,
//   so what the user saw is what stays;
// - a skeleton that no longer makes sense where the blocks stand now — it
//   would leave its pin backwards, or cut through a block — is DORMANT: that
//   edge is routed automatically, the override is kept and comes back when it
//   fits again. Nothing is deleted without a gesture of the user's;
// - a hand-placed segment may cross texts and other wires (it is the user's
//   hand), never a block: such a drop is refused.

export interface Pt {
  x: number;
  y: number;
}

/** an end of an edge: the point the wire attaches to + the direction the pin
 *  leaves its node in (+1 east, -1 west) — the router's anchor */
export interface WireAnchor {
  x: number;
  y: number;
  dir: 1 | -1;
}

export type RouteEnd = "source" | "target";

/** one interior segment of a skeleton: its line sits `offset` px from the pin
 *  at `anchor`, on the segment's axis (x for a vertical one, y for a horizontal) */
export interface RouteSeg {
  anchor: RouteEnd;
  offset: number;
}

/** the interior segments, source to target: even index = vertical, odd =
 *  horizontal; the count is odd */
export type WireRoute = RouteSeg[];

/** what the grouping and the validity need to know about an edge */
export interface WireEdge {
  id: string;
  net: string | null;
  source: string;
  sourcePort: string | null;
  target: string;
  targetPort: string | null;
}

/** a wall: a block's box (with the id of its node, so an edge's own pin stubs
 *  may touch it) or an anonymous solid (a select / concat chip) */
export interface WireRect {
  x: number;
  y: number;
  w: number;
  h: number;
  id?: string;
  /** a boundary flag the router does not treat as an obstacle (the
   *  verification view): an automatic wire may bend right at it, so the edges
   *  that END at it may touch it with any segment, not only with their stub */
  flag?: boolean;
}

/** an edge as it is drawn now: its ends, its polyline, and its skeleton when
 *  the polyline came from one */
export interface WireGeom {
  edge: WireEdge;
  s: WireAnchor;
  t: WireAnchor;
  pts: Pt[];
  route: WireRoute | null;
  /** the edge HAS a stored skeleton, dormant now: what is drawn (and what a
   *  gesture would freeze) is the router's line, not the user's */
  asleep?: boolean;
}

export type WireState = "ok" | "reversed" | "blocked";

/** the longest skeleton kept (a routed wire has a handful of bends; a file is
 *  hand-editable, and a thousand segments must not reach the drawing code) */
export const ROUTE_MAX_SEGS = 41;
/** the largest offset kept, px */
export const ROUTE_MAX_OFFSET = 100_000;
/** the length of the pin stub a jog leaves at its pin, px (two grid cells) */
export const JOG_STUB = 16;
/** the clearance a hand-placed segment keeps from a block's box, px: on the
 *  grid of 8 a segment one cell away is clear, one ON the box's edge is not */
export const WALL_CLEAR = 4;
/** how far against its pin's direction a wire's first line may sit and still
 *  not be "backwards", px: where the anchors are off the grid (the
 *  verification view's stubs) a route that bends at its pin lands half a cell
 *  behind it */
export const REVERSE_SLACK = 4;

const EPS = 0.5;
const same = (a: number, b: number): boolean => Math.abs(a - b) < EPS;

// ------------------------------------------------------------ text form

/**
 * The file form of a skeleton: one line, `source+40 target-24 target-16` — a
 * token per interior segment. Returns null for anything that is not a route
 * (the file is hand-editable and merged by git; the message crosses a process
 * boundary).
 */
export function parseRoute(text: unknown): WireRoute | null {
  if (typeof text !== "string") {
    return null;
  }
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 1 || tokens.length > ROUTE_MAX_SEGS || tokens.length % 2 === 0) {
    return null;
  }
  const route: WireRoute = [];
  for (const tok of tokens) {
    const m = /^(source|target)([+-]\d{1,6}(?:\.\d{1,3})?)$/.exec(tok);
    if (!m) {
      return null;
    }
    const offset = Number(m[2]);
    if (!Number.isFinite(offset) || Math.abs(offset) > ROUTE_MAX_OFFSET) {
      return null;
    }
    route.push({ anchor: m[1] as RouteEnd, offset: offset === 0 ? 0 : offset });
  }
  return route;
}

export function formatRoute(route: WireRoute): string {
  return route
    .map((seg) => {
      const o = Math.round(seg.offset * 100) / 100;
      return `${seg.anchor}${o < 0 ? "" : "+"}${o === 0 ? 0 : o}`;
    })
    .join(" ");
}

// ------------------------------------------------------------- geometry

/** the absolute coordinate of segment `k`'s line (x if vertical, y if horizontal) */
function coordOf(route: WireRoute, k: number, s: WireAnchor, t: WireAnchor): number {
  const a = route[k].anchor === "source" ? s : t;
  return (k % 2 === 0 ? a.x : a.y) + route[k].offset;
}

function coordsOf(route: WireRoute, s: WireAnchor, t: WireAnchor): number[] {
  return route.map((_, k) => coordOf(route, k, s, t));
}

/** sets segment `k`'s line to the absolute coordinate `c`, keeping its anchor */
function setCoord(route: WireRoute, k: number, c: number, s: WireAnchor, t: WireAnchor): void {
  const a = route[k].anchor === "source" ? s : t;
  route[k] = { anchor: route[k].anchor, offset: c - (k % 2 === 0 ? a.x : a.y) };
}

/**
 * The polyline of a skeleton between the current ends: n + 3 points for n
 * interior segments — the source pin, the corners, the target pin. Segment 0
 * of the polyline is the source stub, segments 1..n the interior ones,
 * segment n + 1 the target stub. Zero-length segments are kept (the indices
 * mean something); `simplifyPoly` drops them for drawing.
 */
export function resolveRoute(route: WireRoute, s: WireAnchor, t: WireAnchor): Pt[] {
  const c = coordsOf(route, s, t);
  const pts: Pt[] = [{ x: s.x, y: s.y }];
  for (let k = 0; k < c.length; k++) {
    if (k % 2 === 0) {
      pts.push({ x: c[k], y: k === 0 ? s.y : c[k - 1] });
    } else {
      pts.push({ x: c[k - 1], y: c[k] });
    }
  }
  pts.push({ x: c[c.length - 1], y: t.y }, { x: t.x, y: t.y });
  return pts;
}

/** a polyline without repeated points and without a vertex in the middle of a
 *  straight run — what is drawn */
export function simplifyPoly(pts: readonly Pt[]): Pt[] {
  // a spur that returns onto its own line leaves a repeated point behind: to
  // a fixpoint (a handful of passes at most)
  let cur = simplifyOnce(pts);
  for (let prev = pts.length; cur.length < prev; ) {
    prev = cur.length;
    cur = simplifyOnce(cur);
  }
  return cur;
}

function simplifyOnce(pts: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const n = out.length;
    if (n >= 1 && same(out[n - 1].x, p.x) && same(out[n - 1].y, p.y)) {
      continue;
    }
    if (
      n >= 2 &&
      ((same(out[n - 2].x, out[n - 1].x) && same(out[n - 1].x, p.x)) ||
        (same(out[n - 2].y, out[n - 1].y) && same(out[n - 1].y, p.y)))
    ) {
      out[n - 1] = { x: p.x, y: p.y };
    } else {
      out.push({ x: p.x, y: p.y });
    }
  }
  return out;
}

/** which end the middle segment follows: the nearer one on its axis (a tie
 *  goes to the source) */
function nearerEnd(k: number, c: number, s: WireAnchor, t: WireAnchor): RouteEnd {
  const ds = Math.abs(c - (k % 2 === 0 ? s.x : s.y));
  const dt = Math.abs(c - (k % 2 === 0 ? t.x : t.y));
  return ds <= dt ? "source" : "target";
}

/** can the file form say this skeleton? (`parseRoute`'s limits — a route
 *  that cannot be read back would DELETE the stored one at the host) */
function fitsFile(route: WireRoute): boolean {
  return (
    route.length >= 1 &&
    route.length <= ROUTE_MAX_SEGS &&
    route.length % 2 === 1 &&
    route.every((seg) => Number.isFinite(seg.offset) && Math.abs(seg.offset) <= ROUTE_MAX_OFFSET)
  );
}

/** a skeleton from absolute coordinates: the first half follows the source
 *  pin, the second half the target pin, the middle segment the nearer one */
function fromCoords(c: readonly number[], s: WireAnchor, t: WireAnchor): WireRoute {
  const mid = (c.length - 1) / 2;
  return c.map((v, k) => {
    const anchor: RouteEnd = k < mid ? "source" : k > mid ? "target" : nearerEnd(k, v, s, t);
    const a = anchor === "source" ? s : t;
    return { anchor, offset: v - (k % 2 === 0 ? a.x : a.y) };
  });
}

/**
 * Freezes a drawn polyline into a skeleton. The polyline must be orthogonal
 * and run from `s` to `t`; a wire that leaves or enters its pin vertically (the
 * router's immediate bend) gets a zero-length stub, a straight pin-to-pin wire
 * a zero-length trunk at `grid`-snapped mid-span. Returns null when the
 * polyline is not something a skeleton can say (oblique, too many bends).
 */
export function freezeRoute(
  pts: readonly Pt[],
  s: WireAnchor,
  t: WireAnchor,
  grid = 8
): WireRoute | null {
  const clean: Pt[] = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || !same(last.x, p.x) || !same(last.y, p.y)) {
      clean.push(p);
    }
  }
  if (clean.length < 2) {
    return null;
  }
  const a0 = clean[0];
  const a1 = clean[clean.length - 1];
  if (!same(a0.x, s.x) || !same(a0.y, s.y) || !same(a1.x, t.x) || !same(a1.y, t.y)) {
    return null;
  }
  // runs: orientation + the coordinate of the line, collinear runs merged
  const runs: { h: boolean; c: number }[] = [];
  for (let i = 0; i + 1 < clean.length; i++) {
    const p = clean[i];
    const q = clean[i + 1];
    const h = same(p.y, q.y);
    if (!h && !same(p.x, q.x)) {
      return null; // oblique
    }
    const c = h ? p.y : p.x;
    const last = runs[runs.length - 1];
    if (last && last.h === h) {
      if (!same(last.c, c)) {
        return null; // cannot happen on a connected polyline
      }
      continue;
    }
    runs.push({ h, c });
  }
  if (!runs[0].h) {
    runs.unshift({ h: true, c: s.y });
  }
  if (!runs[runs.length - 1].h) {
    runs.push({ h: true, c: t.y });
  }
  if (!same(runs[0].c, s.y) || !same(runs[runs.length - 1].c, t.y)) {
    return null;
  }
  let coords = runs.slice(1, -1).map((r) => r.c);
  if (coords.length === 0) {
    // a straight wire: its trunk has no length yet — it appears, mid-span,
    // when the pins stop being level
    coords = [Math.round((s.x + t.x) / 2 / grid) * grid];
  }
  if (coords.length > ROUTE_MAX_SEGS || coords.length % 2 === 0) {
    return null;
  }
  const route = fromCoords(coords, s, t);
  return fitsFile(route) ? route : null;
}

/**
 * Drops the bends that have no length where the pins stand now: a segment
 * between two neighbours on the same line merges them. A skeleton never goes
 * below one segment.
 */
export function normalizeRoute(route: WireRoute, s: WireAnchor, t: WireAnchor): WireRoute {
  let r = route.map((seg) => ({ ...seg }));
  for (let guard = 0; guard < ROUTE_MAX_SEGS; guard++) {
    const n = r.length;
    if (n < 3) {
      break;
    }
    const c = coordsOf(r, s, t);
    let cut = -1;
    if (same(s.y, c[1])) {
      cut = 0; // the first vertical has no length: the stub runs into segment 1
    } else if (same(c[n - 2], t.y)) {
      cut = n - 2; // the last vertical has no length
    } else {
      for (let k = 1; k <= n - 2; k++) {
        if (same(c[k - 1], c[k + 1])) {
          cut = k; // k has no length: k-1 and k+1 are one line — keep k-1
          break;
        }
      }
    }
    if (cut < 0) {
      break;
    }
    r = [...r.slice(0, cut), ...r.slice(cut + 2)];
  }
  return r;
}

/**
 * Does the skeleton make sense between the current ends? `reversed`: the wire
 * would leave (or enter) a pin against the pin's direction, through its own
 * block. `blocked`: a segment cuts through a wall — the two pin stubs may touch
 * the box of their OWN node, nothing else may come within `WALL_CLEAR` of a box.
 */
export function routeState(
  route: WireRoute,
  s: WireAnchor,
  t: WireAnchor,
  rects: readonly WireRect[],
  edge: Pick<WireEdge, "source" | "target">
): WireState {
  const c = coordsOf(route, s, t);
  const n = c.length;
  if ((c[0] - s.x) * s.dir < -REVERSE_SLACK || (c[n - 1] - t.x) * t.dir < -REVERSE_SLACK) {
    return "reversed";
  }
  const pts = resolveRoute(route, s, t);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (same(a.x, b.x) && same(a.y, b.y)) {
      continue;
    }
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    for (const r of rects) {
      if (r.id !== undefined) {
        if ((i === 0 && r.id === edge.source) || (i === n + 1 && r.id === edge.target)) {
          continue; // a pin stub touches its own box
        }
        if (r.flag && (r.id === edge.source || r.id === edge.target)) {
          continue; // the flag the wire ends at
        }
      }
      if (
        x0 < r.x + r.w + WALL_CLEAR &&
        x1 > r.x - WALL_CLEAR &&
        y0 < r.y + r.h + WALL_CLEAR &&
        y1 > r.y - WALL_CLEAR
      ) {
        return "blocked";
      }
    }
  }
  return "ok";
}

// --------------------------------------------------------------- groups

const pinKey = (node: string, port: string | null): string => `${node}\u0000${port ?? ""}`;

/**
 * The wire group of `seed`: the edges connected to it through a shared net or
 * a shared pin (transitively). A net with fan-out is one group; so are the
 * differently-named wires that leave the same analysis port in the
 * verification view and run on one trunk. Returns the edge ids, in the order
 * of `edges`.
 */
export function wireGroup(edges: readonly WireEdge[], seed: string): string[] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== undefined && parent.get(r) !== r) {
      r = parent.get(r) as string;
    }
    parent.set(k, r);
    return r;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b));
  };
  for (const e of edges) {
    const me = `e\u0000${e.id}`;
    union(me, `s\u0000${pinKey(e.source, e.sourcePort)}`);
    union(me, `t\u0000${pinKey(e.target, e.targetPort)}`);
    // a pin is one electrical point whichever end of an edge it is
    union(`s\u0000${pinKey(e.source, e.sourcePort)}`, `p\u0000${pinKey(e.source, e.sourcePort)}`);
    union(`t\u0000${pinKey(e.target, e.targetPort)}`, `p\u0000${pinKey(e.target, e.targetPort)}`);
    if (e.net !== null) {
      union(me, `n\u0000${e.net}`);
    }
  }
  if (!edges.some((e) => e.id === seed)) {
    return [];
  }
  const root = find(`e\u0000${seed}`);
  return edges.filter((e) => find(`e\u0000${e.id}`) === root).map((e) => e.id);
}

// ------------------------------------------------------------- drawing

export interface ManualWire {
  route: WireRoute;
  /** the polyline to draw (simplified) */
  pts: Pt[];
  state: WireState;
}

/**
 * The edges drawn from their skeletons. `routes` is the view's stored set
 * (file form); an edge whose skeleton is invalid where the blocks stand now is
 * DORMANT — reported, not placed, so the caller routes it automatically.
 * `force` (the live preview of a drag) places an edge whatever its state.
 */
export function placeManual(
  ends: readonly { edge: WireEdge; s: WireAnchor; t: WireAnchor }[],
  routes: Readonly<Record<string, WireRoute>>,
  rects: readonly WireRect[],
  force?: ReadonlySet<string>
): { manual: Map<string, ManualWire>; dormant: Map<string, WireState> } {
  const manual = new Map<string, ManualWire>();
  const dormant = new Map<string, WireState>();
  for (const { edge, s, t } of ends) {
    const route = routes[edge.id];
    if (!route) {
      continue;
    }
    const state = routeState(route, s, t, rects, edge);
    if (state !== "ok" && !force?.has(edge.id)) {
      dormant.set(edge.id, state);
      continue;
    }
    manual.set(edge.id, { route, pts: simplifyPoly(resolveRoute(route, s, t)), state });
  }
  return { manual, dormant };
}

/** what the two edge drawers report back: every drawn edge with its ends and
 *  its polyline (the gestures hit-test on it), and the edges whose stored
 *  skeleton is dormant */
export interface WireDrawn {
  geoms: Map<string, WireGeom>;
  dormant: Map<string, WireState>;
  /** the forced edges (a drag's preview) whose skeleton is not valid: a drop
   *  here is refused */
  bad: Map<string, WireState>;
}

/** why a stored skeleton is not drawn — the wire's tooltip and the refusal of
 *  a drop say the same thing */
export function wireStateText(state: WireState): string {
  return state === "reversed"
    ? "it would leave its pin backwards"
    : state === "blocked"
      ? "it would cross a block"
      : "";
}

/** the forced, invalid edges of a placement */
export function badWires(manual: ReadonlyMap<string, ManualWire>): Map<string, WireState> {
  const bad = new Map<string, WireState>();
  for (const [id, m] of manual) {
    if (m.state !== "ok") {
      bad.set(id, m.state);
    }
  }
  return bad;
}

/** what the two edge drawers are given: the view's skeletons, the edges a
 *  drag is previewing (drawn from their skeleton whatever its state), and
 *  where to report */
export interface WireOpts {
  routes?: Readonly<Record<string, WireRoute>>;
  force?: ReadonlySet<string>;
  onDrawn?: (drawn: WireDrawn) => void;
}

/** the stored routes of a view (file form) parsed; what does not parse is skipped */
export function parseRoutes(
  edges: Readonly<Record<string, { route?: unknown } | undefined>> | undefined
): Record<string, WireRoute> {
  const out: Record<string, WireRoute> = {};
  for (const [id, e] of Object.entries(edges ?? {})) {
    const r = parseRoute(e?.route);
    if (r) {
      out[id] = r;
    }
  }
  return out;
}

// ------------------------------------------------------------- gestures

/** a segment of an edge's frozen skeleton taken by a grab: `index` into the
 *  skeleton, -1 = the source stub, n = the target stub */
interface GrabPart {
  edgeId: string;
  index: number;
  vertical: boolean;
}

export interface WireGrab {
  /** what the pointer holds: a vertical segment (moves left / right), a
   *  horizontal one (up / down), or a corner / junction (both) */
  kind: "v" | "h" | "corner";
  parts: GrabPart[];
  /** the group, frozen as it is drawn: every edge that can be a skeleton */
  frozen: Map<string, { geom: WireGeom; stored: WireRoute; norm: WireRoute }>;
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const u = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}

/**
 * What a press at `p` holds, among the edges of one wire group (`geoms`). The
 * nearest edge decides: its nearest vertical and its nearest horizontal segment
 * within `tol` (both = a corner). Each of them takes its whole straight RUN
 * with it — the segments of the group's other edges on the same line that
 * touch it, directly or through one another: a trunk is one line to the eye
 * wherever along it the branches leave, and it is dragged as one wire. A stub
 * pressed together with the segment it meets is left out: the corner at a pin
 * moves along one axis only. Returns null when nothing is within reach.
 */
export function grabWire(
  geoms: readonly WireGeom[],
  p: Pt,
  tol: number,
  grid = 8
): WireGrab | null {
  const frozen: WireGrab["frozen"] = new Map();
  const fresh: string[] = []; // frozen now, from what is drawn
  for (const g of geoms) {
    const stored = g.route ?? freezeRoute(g.pts, g.s, g.t, grid);
    if (stored) {
      frozen.set(g.edge.id, { geom: g, stored, norm: normalizeRoute(stored, g.s, g.t) });
      if (!g.route) {
        fresh.push(g.edge.id);
      }
    }
  }
  // A straight wire has a trunk without length, and mid-span says nothing
  // about where the REST of its wire turns: when a group-mate's vertical
  // touches its row between its pins, that is the trunk it is part of (the
  // level branch of a comb) — frozen anywhere else, the trunk appeared twice
  // the day the pins stopped being level (review finding)
  for (const id of fresh) {
    const f = frozen.get(id);
    if (!f || f.stored.length !== 1 || !same(f.geom.s.y, f.geom.t.y)) {
      continue;
    }
    const { s, t } = f.geom;
    const x = trunkThrough(frozen, id, s, t);
    if (x !== null) {
      const route = fromCoords([x], s, t);
      frozen.set(id, { geom: f.geom, stored: route, norm: route });
    }
  }
  // every segment of every edge of the group. One without a length is
  // nothing to press — but the hidden trunk of a straight wire still belongs
  // to the run it sits on, and must move with it
  interface Seg { id: string; index: number; vertical: boolean; line: number; lo: number; hi: number; d: number }
  const segs: Seg[] = [];
  for (const [id, f] of frozen) {
    const pts = resolveRoute(f.norm, f.geom.s, f.geom.t);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const flat = same(a.x, b.x) && same(a.y, b.y);
      if (flat && !(f.norm.length === 1 && i === 1)) {
        continue;
      }
      const vertical = flat || same(a.x, b.x);
      segs.push({
        id,
        index: i - 1,
        vertical,
        line: vertical ? a.x : a.y,
        lo: vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x),
        hi: vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x),
        d: flat ? Infinity : distToSeg(p, a, b),
      });
    }
  }
  const isStub = (sg: Seg): boolean =>
    sg.index < 0 || sg.index >= (frozen.get(sg.id)?.norm.length ?? 0);
  // the nearest segment of each orientation, among ALL the edges of the group:
  // a junction is a corner whichever edge happens to come first (review finding)
  const nearest = (vertical: boolean, stubs: boolean): Seg | null => {
    let got: Seg | null = null;
    for (const sg of segs) {
      if (sg.vertical !== vertical || sg.d > tol || (!stubs && isStub(sg))) {
        continue;
      }
      if (!got || sg.d < got.d) {
        got = sg;
      }
    }
    return got;
  };
  const v = nearest(true, true);
  // beside a vertical, a stub is not a corner's other half: its line is the pin's
  const h = nearest(false, !v);
  if (!v && !h) {
    return null;
  }
  const corner = Boolean(v && h);
  /** the straight RUN a segment is part of: the segments of the group on its
   *  line that touch it, directly or through one another — one line to the eye */
  const runOf = (seed: Seg): Seg[] => {
    const run = new Set<Seg>([seed]);
    let lo = seed.lo;
    let hi = seed.hi;
    for (let grew = true; grew; ) {
      grew = false;
      for (const sg of segs) {
        if (
          !run.has(sg) &&
          sg.vertical === seed.vertical &&
          same(sg.line, seed.line) &&
          sg.lo <= hi + EPS &&
          sg.hi >= lo - EPS
        ) {
          run.add(sg);
          lo = Math.min(lo, sg.lo);
          hi = Math.max(hi, sg.hi);
          grew = true;
        }
      }
    }
    return [...run];
  };
  const parts: GrabPart[] = [];
  for (const seed of [v, h]) {
    for (const sg of seed ? runOf(seed) : []) {
      // beside a vertical being moved, a stub stays out: only a stub pressed
      // on its own is lifted into a jog
      if (v && !sg.vertical && isStub(sg)) {
        continue;
      }
      parts.push({ edgeId: sg.id, index: sg.index, vertical: sg.vertical });
    }
  }
  return { kind: corner ? "corner" : v ? "v" : "h", parts, frozen };
}

/** the x of a group-mate's vertical that touches the row of the straight edge
 *  `id`, between its pins — the trunk a level branch is part of; null if none */
function trunkThrough(
  frozen: WireGrab["frozen"],
  id: string,
  s: WireAnchor,
  t: WireAnchor
): number | null {
  for (const [other, o] of frozen) {
    if (other === id) {
      continue;
    }
    const c = coordsOf(o.norm, o.geom.s, o.geom.t);
    const n = c.length;
    for (let k = 0; k < n; k += 2) {
      const a = k === 0 ? o.geom.s.y : c[k - 1];
      const b = k === n - 1 ? o.geom.t.y : c[k + 1];
      if (same(a, b) || s.y < Math.min(a, b) - EPS || s.y > Math.max(a, b) + EPS) {
        continue;
      }
      if (c[k] > Math.min(s.x, t.x) + EPS && c[k] < Math.max(s.x, t.x) - EPS) {
        return c[k];
      }
    }
  }
  return null;
}

/** do all of `ids` leave the same pin (`end` = source) or enter the same pin? */
function sharedEnd(
  frozen: WireGrab["frozen"],
  ids: readonly string[],
  end: RouteEnd
): boolean {
  let key: string | null = null;
  for (const id of ids) {
    const e = frozen.get(id)?.geom.edge;
    if (!e) {
      return false;
    }
    const k = end === "source" ? pinKey(e.source, e.sourcePort) : pinKey(e.target, e.targetPort);
    if (key !== null && key !== k) {
      return false;
    }
    key = k;
  }
  return key !== null;
}

/**
 * Segments of different edges that run on one line and touch are one wire to the eye:
 * they must follow the SAME pin, or moving a block would split the trunk. Where
 * the edges sharing a line all leave one pin they follow that pin (the source);
 * where they all enter one pin, the target. The lines do not move — only what
 * they are measured from.
 */
function shareAnchors(
  routes: Map<string, WireRoute>,
  frozen: WireGrab["frozen"]
): void {
  interface Span { id: string; k: number; line: number; lo: number; hi: number; vertical: boolean }
  const spans: Span[] = [];
  for (const [id, route] of routes) {
    const f = frozen.get(id);
    if (!f) {
      continue;
    }
    const { s, t } = f.geom;
    const c = coordsOf(route, s, t);
    const n = c.length;
    for (let k = 0; k < n; k++) {
      const a = k === 0 ? s.y : c[k - 1];
      const b = k === n - 1 ? t.y : c[k + 1];
      spans.push({ id, k, line: c[k], lo: Math.min(a, b), hi: Math.max(a, b), vertical: k % 2 === 0 });
    }
  }
  for (const sp of spans) {
    const ids = new Set<string>([sp.id]);
    for (const o of spans) {
      if (
        o.id !== sp.id &&
        o.vertical === sp.vertical &&
        same(o.line, sp.line) &&
        Math.min(o.hi, sp.hi) - Math.max(o.lo, sp.lo) > -EPS
      ) {
        ids.add(o.id);
      }
    }
    if (ids.size < 2) {
      continue;
    }
    const all = [...ids];
    const end: RouteEnd | null = sharedEnd(frozen, all, "source")
      ? "source"
      : sharedEnd(frozen, all, "target")
        ? "target"
        : null;
    const route = routes.get(sp.id);
    const f = frozen.get(sp.id);
    if (!end || !route || !f || route[sp.k].anchor === end) {
      continue;
    }
    const a = end === "source" ? f.geom.s : f.geom.t;
    route[sp.k] = { anchor: end, offset: sp.line - (sp.vertical ? a.x : a.y) };
  }
}

export interface WireDragResult {
  /** the skeleton of every edge of the group that has one now: the moved
   *  edges, and the ones frozen as they were drawn */
  routes: Record<string, WireRoute>;
  /** the edges this drag changed — the ones that must be valid for a drop */
  moved: string[];
}

/**
 * The group's skeletons after the grab was dragged by (`dx`, `dy`) diagram px.
 * A vertical segment takes `dx`, a horizontal one `dy`, each snapped to the
 * grid as an ABSOLUTE line (so an off-grid line lands on the grid at its first
 * move). A pin stub cannot move — its line is the pin's — so dragging it lifts
 * it: a jog is inserted that leaves `JOG_STUB` at the pin (a straight
 * pin-to-pin wire becomes a bump with a stub at each pin). Always computed
 * from the grab, never from the previous frame.
 */
export function dragWire(
  grab: WireGrab,
  dx: number,
  dy: number,
  grid = 8
): WireDragResult {
  const snap = (v: number): number => Math.round(v / grid) * grid;
  const out = new Map<string, WireRoute>();
  for (const [id, f] of grab.frozen) {
    out.set(id, f.stored.map((seg) => ({ ...seg })));
  }
  const moved = new Set<string>();
  const byEdge = new Map<string, GrabPart[]>();
  for (const part of grab.parts) {
    (byEdge.get(part.edgeId) ?? byEdge.set(part.edgeId, []).get(part.edgeId)!).push(part);
  }
  for (const [id, parts] of byEdge) {
    const f = grab.frozen.get(id);
    if (!f) {
      continue;
    }
    const { s, t } = f.geom;
    let route = f.norm.map((seg) => ({ ...seg }));
    const n = route.length;
    const c = coordsOf(route, s, t);
    let changed = false;
    // interior segments first: their indices are the frozen skeleton's
    for (const part of parts) {
      if (part.index < 0 || part.index >= n) {
        continue;
      }
      const delta = part.vertical ? dx : dy;
      if (Math.abs(delta) < grid / 2) {
        // not dragged on this axis: an off-grid line is NOT pulled onto the
        // grid by a drag that went nowhere, or only the other way (review)
        continue;
      }
      const next = snap(c[part.index] + delta);
      if (!same(next, c[part.index])) {
        setCoord(route, part.index, next, s, t);
        if (part.index === (n - 1) / 2) {
          // the middle segment follows the pin it is NOW nearer to (a shared
          // run is put on the common pin below)
          const anchor = nearerEnd(part.index, next, s, t);
          const pin = anchor === "source" ? s : t;
          route[part.index] = { anchor, offset: next - (part.vertical ? pin.x : pin.y) };
        }
        changed = true;
      }
    }
    // then the stubs: a lifted stub inserts a jog at its pin
    const lift = snap(dy);
    const stubs = parts.filter((part) => part.index < 0 || part.index >= n);
    if (stubs.length && lift !== 0) {
      const js = snap(s.x + s.dir * JOG_STUB);
      const jt = snap(t.x + t.dir * JOG_STUB);
      const straight = n === 1 && same(s.y, t.y);
      if (straight) {
        // the whole wire is one line: lift it between a stub at each pin
        if ((jt - js) * s.dir > EPS && (js - s.x) * s.dir > EPS && (jt - t.x) * t.dir > EPS) {
          const y = snap(s.y + dy);
          route = [
            { anchor: "source", offset: js - s.x },
            { anchor: "source", offset: y - s.y },
            { anchor: "target", offset: jt - t.x },
          ];
          changed = true;
        }
      } else {
        for (const part of stubs) {
          if (part.index < 0) {
            // room for the jog: the stub must reach past it
            if ((c[0] - js) * s.dir > EPS && (js - s.x) * s.dir > EPS) {
              route = [
                { anchor: "source", offset: js - s.x },
                { anchor: "source", offset: snap(s.y + dy) - s.y },
                ...route,
              ];
              changed = true;
            }
          } else if ((c[n - 1] - jt) * t.dir > EPS && (jt - t.x) * t.dir > EPS) {
            route = [
              ...route,
              { anchor: "target", offset: snap(t.y + dy) - t.y },
              { anchor: "target", offset: jt - t.x },
            ];
            changed = true;
          }
        }
      }
    }
    if (changed) {
      const next = normalizeRoute(route, s, t);
      if (fitsFile(next)) {
        // a route the file form cannot say (a jog on the longest skeleton) is
        // not made: read back as nothing, it would delete the stored one
        out.set(id, next);
        moved.add(id);
      }
    }
  }
  shareAnchors(out, grab.frozen);
  const routes: Record<string, WireRoute> = {};
  for (const [id, route] of out) {
    if (grab.frozen.get(id)?.geom.asleep && !moved.has(id)) {
      // its own skeleton is dormant and waits in the file: the router's line
      // it is drawn with now must not be written over it (review finding)
      continue;
    }
    routes[id] = route;
  }
  return { routes, moved: [...moved] };
}
