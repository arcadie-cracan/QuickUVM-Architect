// Layout + drawing for the verification view, FLAT PER LEVEL (phase 3b,
// docs/05, decision D24): ELK layered (like the RTL schematic view), blocks
// drawn as UML BOXES (stereotype + text compartments), boundary
// flags for the connections that cross the level, edges routed with
// the common A* router. No compound/nesting — a block's internal structure
// is discovered by double-click (drill), at the next level.

import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import { Rect, route, RouteRequest } from "./router";
import { el } from "./svg";
import type { TbBoundary, TbEdge, TbNode, TbPort, TbScene } from "./tbscene";

interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

const STUB = 10;
const BPORT_H = 16;
const PIN_TOP = 40; // the first port below the title band (multiple of 8)
const PIN_PITCH = 16;
const LINE_H = 13; // the height of a compartment line

function ceilGrid(v: number): number {
  return Math.ceil(v / 8) * 8;
}

/** the UML box's size: title + stereotype + compartments, and min for ports */
function boxSize(
  n: TbNode,
  measure: (t: string) => number
): { w: number; h: number } {
  let textH = 22; // the title band
  if (n.stereotype) {
    textH += 14;
  }
  let maxTextW = Math.max(
    measure(n.label),
    n.stereotype ? measure(n.stereotype) : 0
  );
  for (const c of n.compartments) {
    textH += 4; // separator
    if (c.title) {
      textH += 12;
      maxTextW = Math.max(maxTextW, measure(c.title) + 8);
    }
    textH += c.items.length * LINE_H;
    for (const it of c.items) {
      maxTextW = Math.max(maxTextW, measure(it) + 12);
    }
  }
  const west = n.ports.filter((p) => p.side === "WEST").length;
  const east = n.ports.filter((p) => p.side === "EAST").length;
  const portH = PIN_TOP + Math.max(west, east, 1) * PIN_PITCH;
  const portW = n.ports.reduce((m, p) => Math.max(m, measure(p.label)), 0);
  const w = Math.max(ceilGrid(maxTextW + 20), ceilGrid(portW * 2 + 24), 96);
  const h = ceilGrid(Math.max(textH + 8, portH));
  return { w, h };
}

/** the ports' geometry on the grid (centers at PIN_TOP + i*PITCH, on each side) */
function portGeometry(
  n: TbNode,
  size: { w: number; h: number }
): { ports: { id: string; x: number; y: number; side: "WEST" | "EAST" }[] } {
  const bySide = { WEST: [] as string[], EAST: [] as string[] };
  for (const p of n.ports) {
    bySide[p.side].push(p.id);
  }
  const out: { id: string; x: number; y: number; side: "WEST" | "EAST" }[] = [];
  for (const side of ["WEST", "EAST"] as const) {
    bySide[side].forEach((id, i) => {
      out.push({
        id,
        x: side === "WEST" ? 0 : size.w,
        y: PIN_TOP + i * PIN_PITCH,
        side,
      });
    });
  }
  return { ports: out };
}

export interface TbPlaced {
  node: TbNode;
  x: number;
  y: number;
  w: number;
  h: number;
  ports: Map<string, { x: number; y: number; side: "WEST" | "EAST" }>;
}

export interface TbBPlaced {
  b: TbBoundary;
  x: number;
  y: number;
  w: number;
  /** local horizontal flip (D24): mirrors the shape around its own
   *  center and moves the anchor to the flag's opposite side — does NOT change the ELK side
   *  (the position stays, so FIRST/LAST_SEPARATE is not violated). At an inout flag
   *  (symmetric hexagon) only the anchor jumps from one tip to the other. */
  flipH?: boolean;
}

export interface TbLayout {
  nodes: Map<string, TbPlaced>;
  boundary: Map<string, TbBPlaced>;
  width: number;
  height: number;
}

/** the flip of a TB block/flag (like RTL): H = the west<->east sides, V =
 *  the ports' order on each side (docs/04) */
export interface Flip {
  h: boolean;
  v: boolean;
}

/** a node's ports after flipping: the sides swapped at H, the order
 *  reversed on each side at V (the same logic as `layoutSchematic`) */
function flipPorts(ports: TbPort[], flip: Flip): TbPort[] {
  if (!flip.h && !flip.v) {
    return ports;
  }
  const west = ports.filter((p) => p.side === "WEST");
  const east = ports.filter((p) => p.side === "EAST");
  let effWest = flip.h ? east : west;
  let effEast = flip.h ? west : east;
  if (flip.v) {
    effWest = [...effWest].reverse();
    effEast = [...effEast].reverse();
  }
  return [
    ...effWest.map((p) => ({ ...p, side: "WEST" as const })),
    ...effEast.map((p) => ({ ...p, side: "EAST" as const })),
  ];
}

/** FLAT layout: ELK layered with FIXED_POS ports and FIRST/LAST_SEPARATE flags. */
export async function layoutTb(
  elk: ElkLike,
  scene: TbScene,
  measure: (t: string) => number,
  seeds?: ReadonlyMap<string, { x: number; y: number }>,
  flips?: ReadonlyMap<string, Flip>
): Promise<TbLayout> {
  const children: ElkNode[] = [];
  const sizes = new Map<string, { w: number; h: number }>();
  const geoms = new Map<
    string,
    { id: string; x: number; y: number; side: "WEST" | "EAST" }[]
  >();

  // The flags do NOT flip: their side is dictated by the edge's direction
  // (FIRST_SEPARATE = no incoming edges, LAST_SEPARATE = no outgoing
  // edges — ELK THROWS otherwise, in interactive mode). A `flips` with a flag
  // id (an old seed) is ignored. An INOUT flag (both directions, e.g.
  // `<if>` at the agent level: driver->if->monitor) cannot satisfy EITHER
  // of the constraints, so it does NOT receive a layerConstraint — ELK places it in a
  // middle layer (without throwing, and without the earlier if->monitor detour).
  // NOTE (empirically proven, Jul. 2026): even WITHOUT a layerConstraint, ELK layered
  // places a directional flag on the side required by the edge (source->left,
  // target->right) and IGNORES a seed on the opposite side — so moving a
  // directional flag to the other side is not achievable via seeds.
  for (const b of scene.boundary) {
    children.push({
      id: b.id,
      width: ceilGrid(measure(b.label) + 26),
      height: BPORT_H,
      layoutOptions:
        b.dir === "inout"
          ? {}
          : {
              "elk.layered.layering.layerConstraint":
                b.side === "WEST" ? "FIRST_SEPARATE" : "LAST_SEPARATE",
            },
    });
  }
  const effNode = new Map<string, TbNode>();
  for (const n0 of scene.nodes) {
    const flip = flips?.get(n0.id);
    const n =
      flip && (flip.h || flip.v)
        ? { ...n0, ports: flipPorts(n0.ports, flip) }
        : n0;
    effNode.set(n0.id, n);
    const size = boxSize(n, measure);
    sizes.set(n.id, size);
    const geo = portGeometry(n, size);
    geoms.set(n.id, geo.ports);
    children.push({
      id: n.id,
      width: size.w,
      height: size.h,
      ports: geo.ports.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y - 4,
        width: 8,
        height: 8,
      })),
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    });
  }

  // the positions owned by the user become seeds for interactive ELK
  // (docs/04, like the RTL schematic view): the known nodes stay in place, only
  // the new elements receive positions inserted in context
  if (seeds?.size) {
    for (const c of children) {
      const s = seeds.get(c.id ?? "");
      if (s) {
        c.x = s.x;
        c.y = s.y;
      }
    }
  }
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.separateConnectedComponents": "false",
      // with seeds: interactive mode (the given positions order the layers/
      // rows); cycleBreaking stays default (INTERACTIVE would come into
      // conflict with LAST_SEPARATE on flags — see layoutSchematic)
      ...(seeds?.size
        ? {
            "elk.interactive": "true",
            "elk.layered.layering.strategy": "INTERACTIVE",
            "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
            "elk.layered.nodePlacement.strategy": "INTERACTIVE",
          }
        : { "elk.layered.layering.strategy": "LONGEST_PATH" }),
      "elk.layered.spacing.nodeNodeBetweenLayers": "88",
      "elk.spacing.nodeNode": "48",
      "elk.padding": "[top=10,left=10,bottom=10,right=10]",
    },
    children,
    edges: scene.edges.map((e) => ({
      id: e.id,
      sources: [e.sourcePort ?? e.source],
      targets: [e.targetPort ?? e.target],
    })),
  };
  const out = await elk.layout(graph);

  const g8 = (v: number): number => Math.round(v / 8) * 8;
  const nodes = new Map<string, TbPlaced>();
  const boundary = new Map<string, TbBPlaced>();
  const bset = new Set(scene.boundary.map((b) => b.id));
  for (const c of out.children ?? []) {
    const x = g8(c.x ?? 0);
    const y = g8(c.y ?? 0);
    if (bset.has(c.id ?? "")) {
      const b = scene.boundary.find((bb) => bb.id === c.id);
      if (b) {
        // the local flip does not touch ELK (the position stays); it's purely geometric,
        // consumed by drawBoundary/anchor
        boundary.set(b.id, {
          b,
          x,
          y,
          w: c.width ?? 0,
          flipH: Boolean(flips?.get(b.id)?.h),
        });
      }
      continue;
    }
    const n = effNode.get(c.id ?? ""); // the flipped copy (ports re-placed)
    if (!n) {
      continue;
    }
    const geo = geoms.get(n.id) ?? [];
    const ports = new Map<
      string,
      { x: number; y: number; side: "WEST" | "EAST" }
    >();
    for (const p of geo) {
      // offset RELATIVE to the node's origin (like ELK's ports): the anchor is
      // computed from the current n.x/n.y (see `anchor`), so the ports follow
      // the node on drag without re-layout
      ports.set(p.id, { x: p.x, y: p.y, side: p.side });
    }
    nodes.set(n.id, {
      node: n,
      x,
      y,
      w: c.width ?? 0,
      h: c.height ?? 0,
      ports,
    });
  }
  return {
    nodes,
    boundary,
    width: out.width ?? 0,
    height: out.height ?? 0,
  };
}

// ------------------------------------------------------------------ drawing

const CLASS: Record<string, string> = {
  tbdut: "tb-dut",
  tbenv: "tb-env",
  tbagent: "tb-agent",
  tbunit: "tb-unit",
  tbsb: "tb-sb",
  tbcov: "tb-cov",
  tbvsqr: "tb-vsqr",
  tbsubenv: "tb-subenv",
  tbprobe: "tb-probe",
};

export function drawTb(
  scene: TbScene,
  layout: TbLayout,
  viewport: SVGGElement
): SVGGElement {
  for (const p of layout.boundary.values()) {
    viewport.append(drawBoundary(p));
  }
  for (const p of layout.nodes.values()) {
    viewport.append(drawBox(p));
  }
  // the edges' group above the nodes, reusable when re-routing from drag
  const edges = el("g", { class: "tb-edges" });
  viewport.append(edges);
  drawTbEdges(scene, layout, edges);
  return edges;
}

function drawBox(p: TbPlaced): SVGGElement {
  const n = p.node;
  const drill = n.drill !== null;
  const g = el("g", {
    class: `tbnode ${CLASS[n.kind] ?? ""}${drill ? " drill" : ""}`,
    transform: `translate(${p.x},${p.y})`,
  });
  g.dataset.id = n.id;
  if (n.drill) {
    g.dataset.drill = n.drill;
  }
  g.append(
    el("rect", {
      class: "tb-box",
      x: "0",
      y: "0",
      rx: "3",
      width: String(p.w),
      height: String(p.h),
    })
  );
  let y = 15;
  g.append(
    el(
      "text",
      { class: "tb-name", x: String(p.w / 2), y: String(y) },
      drill ? `${n.label} ⊟` : n.label
    )
  );
  y += 4;
  if (n.stereotype) {
    y += 12;
    g.append(
      el(
        "text",
        { class: "tb-stereotype", x: String(p.w / 2), y: String(y) },
        n.stereotype
      )
    );
  }
  y += 6;
  for (const c of n.compartments) {
    g.append(
      el("line", {
        class: "tb-sep",
        x1: "0",
        y1: String(y),
        x2: String(p.w),
        y2: String(y),
      })
    );
    y += 3;
    if (c.title) {
      y += 11;
      g.append(
        el("text", { class: "tb-comp-title", x: "6", y: String(y) }, c.title)
      );
    }
    for (const it of c.items) {
      y += LINE_H;
      g.append(el("text", { class: "tb-comp", x: "8", y: String(y) }, it));
    }
    y += 2;
  }
  // the ports: short line + label on the side
  for (const port of n.ports) {
    const a = p.ports.get(port.id);
    if (!a) {
      continue;
    }
    const west = port.side === "WEST";
    const py = a.y; // port relative to the node's origin (the group already has translate)
    g.append(
      el("line", {
        class: `tb-stub${port.iface ? " iface" : ""}`,
        x1: String(west ? 0 : p.w),
        y1: String(py),
        x2: String(west ? -STUB : p.w + STUB),
        y2: String(py),
      }),
      el(
        "text",
        {
          class: "tb-pin",
          x: String(west ? -STUB - 2 : p.w + STUB + 2),
          // the label always ABOVE the port (not on the wire's row: the wire exits
          // horizontally at py, so it does not cross the name), on BOTH sides — the vertical
          // alignment is CONSTANT under flipping (H changes the west<->east side,
          // but not top/bottom; the user's request). The anchor (end at west,
          // start at east) keeps the label on the block's outer side, so
          // the ports that face each other stay horizontally separated
          y: String(py - 5),
          "text-anchor": west ? "end" : "start",
        },
        port.note ? `${port.label} ${port.note}` : port.label
      )
    );
  }
  return g;
}

function drawBoundary(p: TbBPlaced): SVGGElement {
  const b = p.b;
  const g = el("g", {
    class: `tb-bport${b.iface ? " iface" : ""}`,
    transform: `translate(${p.x},${p.y})`,
  });
  g.dataset.id = b.id;
  const w = p.w;
  const notch = 6;
  // the local flip (p.flipH) mirrors the shape around the center: the tip and
  // the base swap sides (the inout hexagon is symmetric, so it stays unchanged)
  const west = (b.side === "WEST") !== Boolean(p.flipH);
  const pointRight = `M 0 0 H ${w - notch} L ${w} ${BPORT_H / 2} L ${w - notch} ${BPORT_H} H 0 Z`;
  const pointLeft = `M ${w} 0 H ${notch} L 0 ${BPORT_H / 2} L ${notch} ${BPORT_H} H ${w} Z`;
  // the tip shows the data's direction relative to the level: `in` -> toward the diagram's
  // interior, `out` -> toward the exterior, `inout` -> rectangle (bidirectional,
  // e.g. the `<if>` interface, which does not have a single direction)
  let d: string;
  if (b.dir === "inout") {
    // flattened hexagon: the fusion of the exit tip (right) with the entry tip
    // (left) — the bidirectional port has both directions
    d = `M ${notch} 0 H ${w - notch} L ${w} ${BPORT_H / 2} L ${w - notch} ${BPORT_H} H ${notch} L 0 ${BPORT_H / 2} Z`;
  } else {
    const inward = b.dir !== "out";
    d = (inward ? west : !west) ? pointRight : pointLeft;
  }
  g.append(
    el("path", { class: "tb-bport-shape", d }),
    el(
      "text",
      {
        class: "tb-bport-label",
        x: String(w / 2),
        y: String(BPORT_H / 2 + 3.5),
        "text-anchor": "middle",
      },
      b.label
    )
  );
  return g;
}

interface Anchor {
  x: number;
  y: number;
  dir: 1 | -1;
}

function anchor(
  layout: TbLayout,
  nodeId: string,
  portId: string | null
): Anchor | null {
  const b = layout.boundary.get(nodeId);
  if (b) {
    // boundary flag: the exit is toward the interior (east for west, and vice versa).
    // The local flip (flipH) moves the anchor to the flag's opposite side —
    // mirrored about its own center, the same as the shape
    const west = (b.b.side === "WEST") !== Boolean(b.flipH);
    return {
      x: west ? b.x + b.w : b.x,
      y: b.y + BPORT_H / 2,
      dir: west ? 1 : -1,
    };
  }
  const n = layout.nodes.get(nodeId);
  if (!n) {
    return null;
  }
  if (portId) {
    const a = n.ports.get(portId);
    if (a) {
      const dir: 1 | -1 = a.side === "WEST" ? -1 : 1;
      // the ports are relative to the node's origin: absolute = n.x/n.y + offset
      return { x: n.x + a.x + dir * STUB, y: n.y + a.y, dir };
    }
  }
  return { x: n.x + n.w + STUB, y: n.y + n.h / 2, dir: 1 };
}

/** (re)routes the TB edges into `group` (reusable on drag, like `routeEdges`
 *  for RTL): empties the group and redraws the routes from the current positions */
export function drawTbEdges(
  scene: TbScene,
  layout: TbLayout,
  group: SVGGElement
): void {
  group.replaceChildren();
  const obstacles: Rect[] = [];
  for (const p of layout.nodes.values()) {
    obstacles.push({ x: p.x, y: p.y, w: p.w, h: p.h, pad: 6 });
  }
  const requests: RouteRequest[] = [];
  const pending: { e: TbEdge; s: Anchor; t: Anchor }[] = [];
  for (const e of scene.edges) {
    const s = anchor(layout, e.source, e.sourcePort);
    const t = anchor(layout, e.target, e.targetPort);
    if (!s || !t) {
      continue;
    }
    requests.push({
      id: e.id,
      source: { x: s.x, y: s.y, dir: s.dir },
      target: { x: t.x, y: t.y, dir: t.dir },
      group: e.net ?? e.id,
    });
    pending.push({ e, s, t });
  }
  const routed = route(obstacles, requests);
  for (const { e, s, t } of pending) {
    const pts = routed.get(e.id);
    const mx = (s.x + t.x) / 2;
    const d = pts
      ? "M " + pts.map((q) => `${q.x} ${q.y}`).join(" L ")
      : `M ${s.x} ${s.y} L ${mx} ${s.y} L ${mx} ${t.y} L ${t.x} ${t.y}`;
    const edge = el("g", { class: `tb-edge ${e.kind}` });
    if (e.net) {
      edge.dataset.id = e.net;
    }
    edge.append(
      el("path", {
        class: "tb-edge-line",
        d,
        // arrow at the end (target) on ALL edges: shows the data's direction,
        // hence also the ports' direction (source = output, target = input); an
        // interface has two edges — driver->if and if->monitor — so both
        // directions are visible
        "marker-end": "url(#arrow)",
      }),
      el("title", {}, e.net ?? e.kind)
    );
    group.append(edge);
  }
}
