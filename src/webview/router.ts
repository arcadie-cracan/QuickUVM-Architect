// The interconnect router (docs/04): orthogonal routing with obstacle
// avoidance on the grid of 8, our own A* prototype (Lee variant with costs).
// Pure module, without DOM — testable in Node (scripts/test-router.mjs).
//
// The interface is fixed (docs/04), so the implementation is interchangeable with
// the libavoid-WASM alternative in the comparative prototype:
//   route(obstacles, pins, constraints) -> polylines
//
// Design choices, at the diagram's scale (tens of obstacles, hundreds of
// edges):
// - A* on grid cells with state (x, y, direction): the bend penalty
//   is part of the cost, so the routes come out straight when they can be straight;
// - the obstacles inflate by one cell (the routes do not touch the walls);
// - the anchors have an imposed exit/entry direction (a west pin exits toward
//   the left etc.), with a free corridor through their own obstacle;
// - no edge-to-edge avoidance in v1 — only obstacles and minimal bends.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** its own halo, in px (default: the global halo from constraints) */
  pad?: number;
  /** SOFT obstacle: traversal costs `cost` per cell instead of being
   *  forbidden — used for texts (labels/annotations): when the channels
   *  tighten, the router passes over a label instead of falling back to the fallback
   *  through blocks */
  cost?: number;
}

/** an edge's anchor: the point on the node's boundary + the exit direction */
export interface RouteAnchor {
  x: number;
  y: number;
  /** the horizontal direction of the exit from the node: +1 east, -1 west */
  dir: 1 | -1;
}

export interface RouteRequest {
  id: string;
  source: RouteAnchor;
  target: RouteAnchor;
  /** the request's group (the net): edges of the same group are allowed to share
   *  the common trunk (fan-out), without an overlap penalty */
  group?: string;
}

export interface RouteConstraints {
  /** the grid step (default 8, like the rest of the geometry — docs/04) */
  grid?: number;
  /** the cost of a bend, in cells of straight travel (default 4) */
  bendPenalty?: number;
  /** the cost of parallel overlap with another net's route, per cell
   *  (default 8 — practically forbidden when another corridor exists) */
  overlapPenalty?: number;
  /** the cost of perpendicular crossing of another net's route (default 2 —
   *  intersections are allowed, but rarer when an alternative exists) */
  crossPenalty?: number;
  /** the halo around the obstacles, in px (default 16): the routes do not enter
   *  the halo, so they do not touch the stubs and the labels stuck to the blocks;
   *  the anchors receive their own corridor through their block's halo */
  halo?: number;
  /** the cost of traveling through the one-cell ring around the halo (default
   *  1): at equal length and bends, the route prefers the wide channel
   *  instead of sticking to the blocks — the mandatory detours stay cheap */
  hugPenalty?: number;
  /** the cost of traveling THROUGH the halo (default 6): the halo is expensive, not forbidden —
   *  when the blocks stand closer than two halos, the wire slips
   *  through the gap paying the cost, instead of falling back to the fallback through blocks;
   *  only the boxes proper remain absolute walls */
  haloPenalty?: number;
  /** the radius (in cells) around its own anchors within which parallel overlap
   *  with another net is NOT penalized (default 6): the wires that start from the same
   *  source (fan-out) or converge toward the same destination (fan-in) overlap
   *  near the common end, instead of being forced onto separate corridors; far from
   *  the ends, the penalty remains (distinct nets do not stick along their length) */
  fanoutRadius?: number;
}

interface Point {
  x: number;
  y: number;
}

const DIRS: readonly Point[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

/**
 * Routes each request orthogonally, going around the obstacles. Returns id ->
 * polyline (in the diagram coordinates); requests without a path are missing from the
 * result (the caller decides the fallback).
 */
export function route(
  obstacles: readonly Rect[],
  requests: readonly RouteRequest[],
  constraints?: RouteConstraints
): Map<string, Point[]> {
  const grid = constraints?.grid ?? 8;
  const bendPenalty = constraints?.bendPenalty ?? 4;
  const overlapPenalty = constraints?.overlapPenalty ?? 8;
  const crossPenalty = constraints?.crossPenalty ?? 2;
  const halo = constraints?.halo ?? 16;
  const hugPenalty = constraints?.hugPenalty ?? 1;
  const haloPenalty = constraints?.haloPenalty ?? 6;
  const fanoutRadius = constraints?.fanoutRadius ?? 6;

  // -- the terrain: the bbox of the obstacles and anchors + a 4-cell margin
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const o of obstacles) {
    extend(o.x, o.y);
    extend(o.x + o.w, o.y + o.h);
  }
  for (const r of requests) {
    extend(r.source.x, r.source.y);
    extend(r.target.x, r.target.y);
  }
  if (minX === Infinity) {
    return new Map();
  }
  const M = 4; // margin, in cells
  const gx0 = Math.floor(minX / grid) - M;
  const gy0 = Math.floor(minY / grid) - M;
  const gw = Math.ceil(maxX / grid) - gx0 + 2 * M;
  const gh = Math.ceil(maxY / grid) - gy0 + 2 * M;
  if (gw <= 0 || gh <= 0 || gw * gh > 1_000_000) {
    return new Map(); // degenerate or absurdly large terrain
  }

  // -- terrain maps: the hard obstacles' boxes are walls; the halo
  // around them is a large COST (traversable in a crush), the ring beyond
  // the halo is a small cost (aesthetics), the texts have their own cost
  const inflate = Math.max(1, Math.round(halo / grid));
  const blocked = new Uint8Array(gw * gh);
  const softCost = new Uint16Array(gw * gh);
  for (const o of obstacles) {
    const soft = o.cost !== undefined;
    const inf = soft
      ? Math.max(0, Math.round((o.pad ?? 0) / grid))
      : o.pad !== undefined
        ? Math.max(0, Math.round(o.pad / grid))
        : inflate;
    // the box proper (a wall for hard obstacles)
    const bx1 = Math.floor(o.x / grid) - gx0;
    const by1 = Math.floor(o.y / grid) - gy0;
    const bx2 = Math.ceil((o.x + o.w) / grid) - gx0;
    const by2 = Math.ceil((o.y + o.h) / grid) - gy0;
    // halo + proximity ring (only hard obstacles)
    const ring = soft ? 0 : 1;
    const x1 = bx1 - inf;
    const y1 = by1 - inf;
    const x2 = bx2 + inf;
    const y2 = by2 + inf;
    for (let y = Math.max(0, y1 - ring); y <= Math.min(gh - 1, y2 + ring); y++) {
      for (let x = Math.max(0, x1 - ring); x <= Math.min(gw - 1, x2 + ring); x++) {
        const idx = y * gw + x;
        if (soft) {
          softCost[idx] = Math.max(softCost[idx], o.cost ?? 0);
        } else if (x >= bx1 && x <= bx2 && y >= by1 && y <= by2) {
          blocked[idx] = 1;
        } else if (x >= x1 && x <= x2 && y >= y1 && y <= y2) {
          softCost[idx] = Math.max(softCost[idx], haloPenalty);
        } else {
          softCost[idx] = Math.max(softCost[idx], hugPenalty);
        }
      }
    }
  }

  // the occupancy of the already-routed routes, by orientation: the owner (the
  // group index) of each cell; -1 = free, -2 = used by more than one group
  const ownH = new Int32Array(gw * gh).fill(-1);
  const ownV = new Int32Array(gw * gh).fill(-1);
  const groupIdx = new Map<string, number>();
  const groupOf = (req: RouteRequest): number => {
    const key = req.group ?? req.id;
    let g = groupIdx.get(key);
    if (g === undefined) {
      g = groupIdx.size;
      groupIdx.set(key, g);
    }
    return g;
  };

  // the short ones first: they take their direct routes, the long ones go around
  const ordered = [...requests].sort(
    (a, b) =>
      Math.abs(a.source.x - a.target.x) + Math.abs(a.source.y - a.target.y) -
      (Math.abs(b.source.x - b.target.x) + Math.abs(b.source.y - b.target.y))
  );

  const result = new Map<string, Point[]>();
  for (const req of ordered) {
    const group = groupOf(req);
    const out = routeOne(req, {
      grid, bendPenalty, overlapPenalty, crossPenalty,
      corridor: inflate + 4,
      fanoutRadius,
      gx0, gy0, gw, gh, blocked, softCost, ownH, ownV, group,
    });
    if (out) {
      result.set(req.id, out.points);
      // marks the route's cells, by the orientation of each step
      for (let i = 0; i < out.cells.length - 1; i++) {
        const a = out.cells[i];
        const b = out.cells[i + 1];
        const own = a.y === b.y ? ownH : ownV;
        for (const c of [a, b]) {
          const idx = c.y * gw + c.x;
          if (own[idx] === -1) {
            own[idx] = group;
          } else if (own[idx] !== group) {
            own[idx] = -2;
          }
        }
      }
    }
  }
  return result;
}

interface Terrain {
  grid: number;
  bendPenalty: number;
  overlapPenalty: number;
  crossPenalty: number;
  /** the length of the free corridor from the anchors, in cells */
  corridor: number;
  /** the radius around the anchors where overlap is not penalized (fan-out/in) */
  fanoutRadius: number;
  gx0: number;
  gy0: number;
  gw: number;
  gh: number;
  blocked: Uint8Array;
  softCost: Uint16Array;
  ownH: Int32Array;
  ownV: Int32Array;
  group: number;
}

interface RouteResult {
  /** the final polyline, in the diagram coordinates */
  points: Point[];
  /** the traversed grid cells (for marking the occupancy) */
  cells: Point[];
}

function routeOne(req: RouteRequest, t: Terrain): RouteResult | null {
  const {
    grid, bendPenalty, overlapPenalty, crossPenalty, corridor, fanoutRadius,
    gx0, gy0, gw, gh, blocked, softCost, ownH, ownV, group,
  } = t;
  const sx = Math.round(req.source.x / grid) - gx0;
  const sy = Math.round(req.source.y / grid) - gy0;
  const tx = Math.round(req.target.x / grid) - gx0;
  const ty = Math.round(req.target.y / grid) - gy0;
  const sDir = req.source.dir > 0 ? 0 : 1; // the index in DIRS
  const tDir = req.target.dir > 0 ? 1 : 0; // the direction of TRAVEL toward the pin

  // free corridor at the anchors: cells along the exit/entry direction that
  // stay traversable even if they lie in the own obstacle's halo
  const free = new Set<number>();
  for (let i = 0; i <= corridor; i++) {
    free.add((sy) * gw + (sx + Math.sign(DIRS[sDir].x) * i));
    free.add((ty) * gw + (tx - Math.sign(DIRS[tDir].x) * i));
  }
  const isBlocked = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= gw || y >= gh) {
      return true;
    }
    const idx = y * gw + x;
    return blocked[idx] === 1 && !free.has(idx);
  };

  // A* with state (cell, direction); cost: 1/cell + bendPenalty/bend
  const stateCount = gw * gh * 4;
  const dist = new Float64Array(stateCount).fill(Infinity);
  const prev = new Int32Array(stateCount).fill(-1);
  const sid = (sy * gw + sx) * 4 + sDir;
  dist[sid] = 0;
  // minimal priority queue (binary heap on pairs [f, stateId])
  const heap: number[] = [];
  const push = (f: number, id: number): void => {
    heap.push(f, id);
    let i = heap.length / 2 - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p * 2] <= heap[i * 2]) {
        break;
      }
      swap(i, p);
      i = p;
    }
  };
  const swap = (a: number, b: number): void => {
    const f = heap[a * 2];
    const v = heap[a * 2 + 1];
    heap[a * 2] = heap[b * 2];
    heap[a * 2 + 1] = heap[b * 2 + 1];
    heap[b * 2] = f;
    heap[b * 2 + 1] = v;
  };
  const pop = (): number => {
    const top = heap[1];
    const n = heap.length / 2 - 1;
    swap(0, n);
    heap.length -= 2;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < n && heap[l * 2] < heap[m * 2]) {
        m = l;
      }
      if (r < n && heap[r * 2] < heap[m * 2]) {
        m = r;
      }
      if (m === i) {
        break;
      }
      swap(i, m);
      i = m;
    }
    return top;
  };
  const h = (x: number, y: number): number =>
    Math.abs(x - tx) + Math.abs(y - ty);

  push(h(sx, sy), sid);
  const goal = (ty * gw + tx) * 4 + tDir;
  let found = false;
  while (heap.length) {
    const cur = pop();
    if (cur === goal) {
      found = true;
      break;
    }
    const d = dist[cur];
    const cdir = cur % 4;
    const cell = (cur - cdir) / 4;
    const cx = cell % gw;
    const cy = (cell - cx) / gw;
    for (let nd = 0; nd < 4; nd++) {
      // no 180-degree turn
      if ((cdir ^ nd) === 1 && (cdir >> 1) === (nd >> 1)) {
        continue;
      }
      const nx = cx + DIRS[nd].x;
      const ny = cy + DIRS[nd].y;
      if (isBlocked(nx, ny)) {
        continue;
      }
      // parallel overlap with another net's route is expensive; perpendicular
      // crossing is allowed, but lightly penalized (docs/04). EXCEPTION: near
      // the OWN anchors (fan-out at the source / fan-in at the destination) overlap
      // is free — the wires that share an end gather there, instead of being
      // forced onto separate corridors (the user's request at validation)
      const idx = ny * gw + nx;
      const along = nd < 2 ? ownH[idx] : ownV[idx];
      const across = nd < 2 ? ownV[idx] : ownH[idx];
      const nearAnchor =
        Math.abs(nx - sx) + Math.abs(ny - sy) <= fanoutRadius ||
        Math.abs(nx - tx) + Math.abs(ny - ty) <= fanoutRadius;
      let occupancy = softCost[idx];
      if (along !== -1 && along !== group && !nearAnchor) {
        occupancy += overlapPenalty;
      }
      if (across !== -1 && across !== group) {
        occupancy += crossPenalty;
      }
      const cost = d + 1 + (nd === cdir ? 0 : bendPenalty) + occupancy;
      const nid = (ny * gw + nx) * 4 + nd;
      if (cost < dist[nid]) {
        dist[nid] = cost;
        prev[nid] = cur;
        push(cost + h(nx, ny), nid);
      }
    }
  }
  if (!found) {
    return null;
  }

  // reconstruction + collinear simplification, back into diagram coordinates
  const cells: Point[] = [];
  for (let cur = goal; cur !== -1; cur = prev[cur]) {
    const cell = (cur - (cur % 4)) / 4;
    const x = cell % gw;
    cells.push({ x, y: (cell - x) / gw });
    if (cur === sid) {
      break;
    }
  }
  cells.reverse();
  const pts: Point[] = [];
  const emit = (p: Point): void => {
    const n = pts.length;
    if (n >= 1 && pts[n - 1].x === p.x && pts[n - 1].y === p.y) {
      return; // exact duplicate
    }
    if (
      n >= 2 &&
      ((pts[n - 1].x === pts[n - 2].x && p.x === pts[n - 1].x) ||
        (pts[n - 1].y === pts[n - 2].y && p.y === pts[n - 1].y))
    ) {
      pts[n - 1] = p; // extends the collinear segment
    } else {
      pts.push(p);
    }
  };
  // the exact anchors are INSERTED at the ends (they do not replace the grid
  // points): the anchor shares the y with its cell, so the stub stays
  // horizontal even with a fractional x — never oblique segments
  emit({ x: req.source.x, y: req.source.y });
  for (const c of cells) {
    emit({ x: (c.x + gx0) * grid, y: (c.y + gy0) * grid });
  }
  emit({ x: req.target.x, y: req.target.y });
  return { points: pts, cells };
}
