// The interior view: ELK layout (layered, left->right, orthogonal
// routing) and SVG drawing for the scene built by scene.ts. The edges
// come from ELK at full layout — the position-independent router is the
// next step of phase 3 (docs/04); here the positions are still the computed ones.

import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import type {
  NoteKind,
  SceneEdge,
  SchematicScene,
  SceneBPort,
  SceneNode,
  ScenePin,
} from "./scene";
import { splitLabel } from "./scene";
import { Rect, route, RouteRequest } from "./router";
import { el } from "./svg";

/** a port label as <text> with the packed/unpacked dimensions in a subtle
 *  shade (tspan `.dim`), the name in the full color — compact (without spaces),
 *  but readable through the shade contrast (user request, Jul. 2026).
 *  The shade is `fill-opacity` on the tspan, so it follows the name's color at
 *  hover/select/iface, not a fixed color. */
export function portLabelText(
  attrs: Record<string, string>,
  label: string,
  name: string
): SVGElement {
  const parts = splitLabel(label, name);
  const spans: SVGElement[] = [];
  if (parts.packed) {
    spans.push(el("tspan", { class: "dim" }, parts.packed));
  }
  spans.push(el("tspan", {}, parts.name));
  if (parts.unpacked) {
    spans.push(el("tspan", { class: "dim" }, parts.unpacked));
  }
  return el("text", attrs, ...spans);
}

/** vertically centers the `{}`/`[]` sign in the chip's rectangle, AFTER rendering
 *  (getBBox requires the elements in the DOM). `dominant-baseline: central` centers
 *  correctly in the fallback font, but depends on the font metrics and can leave
 *  the brackets slightly off-center in some editor fonts — we measure the real box
 *  of the sign and of the rectangle and nudge. Idempotent per render
 *  (the signs are recreated on every draw with y=py, so they don't accumulate). */
export function centerChipSigns(root: ParentNode): void {
  root
    .querySelectorAll<SVGTextElement>("text.split-sign")
    .forEach((sign) => {
      const rect = sign.parentElement?.querySelector<SVGGraphicsElement>(
        "rect.split-join"
      );
      if (!rect) {
        return;
      }
      try {
        const sc = sign.getBBox();
        const rc = rect.getBBox();
        const delta = rc.y + rc.height / 2 - (sc.y + sc.height / 2);
        if (Math.abs(delta) > 0.4) {
          const y = parseFloat(sign.getAttribute("y") ?? "0");
          sign.setAttribute("y", String(y + delta));
        }
      } catch {
        // getBBox may fail if the element is not yet rendered; we ignore
      }
    });
}

/** the length of the pin line outside the rectangle, in the schematic view */
const STUB = 10;
/** the concat/select chip geometry: GAP from the stub's end, width,
 *  height (used by MARKER_STUB and the wire anchor too) */
const MARKER_GAP = 8;
const MARKER_CW = 18;
const MARKER_CH = 14;
/** stub segment BEYOND the chip's outer face: the pin sticks out ~12px past the
 *  marker, and the wire (or the label in show-as-label) anchors at the tip. The
 *  stub does NOT pierce the chip — it is drawn as two segments touching its faces
 *  (drawPin); on a wide bus a thick stub through `{}`/`[]` reads as a wire passing
 *  through the decorator (user request, Jul 2026, superseding the older note "the
 *  pin visibly pierces the rectangle"). 12 puts the tip at 48 = a multiple of 8,
 *  so the wire anchor lands ON THE GRID (docs/04) */
const MARKER_TAIL = 12;
/** the stub's end AND the wire anchor for the concat/select marker pins:
 *  beyond the chip (STUB+GAP+CW=36) with MARKER_TAIL (=48, on the grid). Thus:
 *  (1) the fanout trunk connects beyond the marker (no longer cutting it on the
 *  vertical), and the horizontal stub traverses it toward the port;
 *  (2) the stub-port thickness transition (thin) -> net-edge (thick) falls at the
 *  TIP, collinear with the wire (no corner), so it produces no broken joints —
 *  the old note "the transition under the chip" is SUPERSEDED by the newer request (the pin
 *  visible beyond the chip beats hiding the transition) */
const MARKER_STUB = STUB + MARKER_GAP + MARKER_CW + MARKER_TAIL;
/** the height of a boundary port (center at a multiple of 8, like the pins) */
const BPORT_H = 16;

// The pin geometry on the grid of 8 (EDA convention: pins snap to the grid,
// not the box). The ports are FIXED_POS, computed here — ELK does not offer
// enough control (portsSurrounding is ignored at placement, the INSIDE labels
// inflate the step); the price is that the pins stay in declaration order, which is
// exactly the norm in schematics (the order overrides come in phase 4, level 2).
// Corner on the grid => all pins on the grid => aligned pin = straight wire.
/** the center of the first pin, below the title band (multiple of 8) */
const PIN_TOP = 40;
/** the step between pin centers. MULTIPLE OF 8 mandatory (pin on the grid =
 *  straight wire, docs/04); 24 (not 16) gives room to the decorations — `/N` widths,
 *  const/split-join glyphs, nc circles — which at 16 trod on each other between rows
 *  (observation at validation) */
const PIN_PITCH = 24;

/** round up to a multiple of the grid */
function ceilGrid(v: number): number {
  return Math.ceil(v / 8) * 8;
}

/**
 * The CSS class for grading by width classes (docs/04, drawing vocabulary): a
 * bus wire/pin is thicker the wider the signal is. `null`/1 =
 * simple wire (no class). Thresholds: 2-8 (w-s), 9-16 (w-m), >16 (w-l).
 */
export function widthClass(w: number | null): string {
  if (w === null || w <= 1) {
    return "";
  }
  if (w <= 8) {
    return "w-s";
  }
  if (w <= 16) {
    return "w-m";
  }
  return "w-l";
}

/** the width of the annotation glyph (const-box, split/join chip) beyond the text, in
 *  px — it also covers the GAP by which the concat/select chip distances itself from the port */
const GLYPH_W = 22;

/**
 * Geometry of a concat/select marker chip on the EXTENDED pin. The pin extension
 * runs from the block (`x0`) to the tip (`x0 + out*MARKER_STUB`), where the wire
 * anchors. The chip is CENTERED on the extension that REMAINS after reserving
 * `wReserve` near the block for the bus-width marker (`16`/slash), so the two never
 * overlap; a stub runs past the chip to the tip (user request, Jul 2026 — keep the
 * pin extension, anchor the wire at its tip). `out` = -1 west / +1 east.
 */
function markerChip(
  x0: number,
  out: number,
  wReserve: number
): { tip: number; chipOuter: number; chipInner: number; center: number } {
  const tip = x0 + out * MARKER_STUB; // wire anchor / stub tip
  const zoneInner = x0 + out * wReserve; // block-side end of the chip zone
  const center = (tip + zoneInner) / 2; // centered on the remaining extension
  return {
    tip,
    center,
    chipOuter: center + out * (MARKER_CW / 2), // toward the tip
    chipInner: center - out * (MARKER_CW / 2), // toward the block
  };
}

/** the bus-width-marker reserve near the block (the `16`/slash zone the chip must
 *  clear), capped so the chip + a short tip stub always fit inside MARKER_STUB */
function widthReserve(wtxt: string): number {
  return Math.min(
    MARKER_STUB - MARKER_CW - 4,
    wtxt ? STUB / 2 + wtxt.length * 6.5 + 2 : STUB / 2
  );
}

/**
 * The glyphs of a pin's annotation at the stub's free end (drawing vocabulary,
 * docs/04): `nc` empty circle, `const` tie-cell box with the value, `select`/`concat`
 * netlistsvg wedge (split narrows outward, join widens) + label,
 * the rest (`expr`/`mixed`) plain text. Chooses the glyph by `noteKind`, not by
 * the note's text. `xOut` = the free end; `west` = the west side (glyph toward the left).
 */
function drawAnnotation(
  spec: ScenePin,
  xOut: number,
  py: number,
  west: boolean,
  wReserve: number
): SVGElement[] {
  const kind: NoteKind | null = spec.noteKind;
  const out = west ? -1 : 1;
  if (kind === "nc") {
    return [
      el("circle", {
        class: "nc", cx: String(xOut + out * 4), cy: String(py), r: "3",
      }),
    ];
  }
  const noteText = (x: number): SVGElement =>
    el(
      "text",
      {
        class: "conn-note",
        x: String(x),
        y: String(py - 4),
        "text-anchor": west ? "end" : "start",
      },
      spec.note ?? ""
    );
  if (kind === "const") {
    // tie-cell box with the value (without `=`), stuck to the stub's end
    const val = (spec.note ?? "").replace(/^=/, "");
    const bw = Math.max(16, val.length * 6 + 8);
    const bx = west ? xOut - bw : xOut;
    return [
      el("rect", {
        class: "const-box",
        x: String(bx), y: String(py - 7), width: String(bw), height: "14",
        rx: "2",
      }),
      el(
        "text",
        {
          class: "const-val",
          x: String(bx + bw / 2), y: String(py + 3),
          "text-anchor": "middle",
        },
        val
      ),
    ];
  }
  if (kind === "select" || kind === "concat") {
    // chip with the pair of SV brackets (vocabulary decision, Jul. 2026):
    // concat = `{}` (braces), select = `[]` (square brackets) — the very
    // operators from the source, without a mnemonic. Accent outline, decidedly
    // an annotation (not a wire), without a tip oriented along the wire -> it is not
    // confused with the wires' direction arrow (the old solid wedge did that).
    // The {…}/[hi:lo] text remains the carrier of meaning at `decorations off`
    // (the chip is decoration, hidden there; the note is not removed).
    // chip distanced from the stub's end by MARKER_GAP (otherwise the top corner
    // overlapped with the width label / note); the dimensions and the extended stub
    // come from the module constants MARKER_*
    const brackets = kind === "concat" ? "{}" : "[]";
    // The chip is centered on the pin extension that remains after the bus-width
    // marker's reserve (markerChip); the wire anchors at the tip past it, and a
    // short stub separates the chip from the tip. drawAnnotation gets the plain-
    // stub end `xOut`, so recover the block edge x0 = xOut - out*STUB.
    const chip = markerChip(xOut - out * STUB, out, wReserve);
    const bx = west ? chip.chipOuter : chip.chipInner; // rect left edge
    return [
      el("rect", {
        class: "split-join",
        x: String(bx),
        y: String(py - MARKER_CH / 2),
        width: String(MARKER_CW),
        height: String(MARKER_CH),
        rx: "3",
      }),
      el(
        "text",
        {
          class: "split-sign",
          x: String(chip.center),
          // y approximately centered as a fallback; the fine centering is done by
          // `centerChipSigns` after rendering. We do NOT use `dominant-baseline`:
          // getBBox + dominant-baseline differ between Chromium versions
          // (harness vs webview VSCode), and the nudge came out wrong; with the
          // alphabetic baseline getBBox is reliable everywhere
          y: String(py + 3),
          "text-anchor": "middle",
        },
        brackets
      ),
      // the {…}/[hi:lo] note goes ABOVE the chip (the tip side carries the
      // wire/label, the block side the bus-width marker)
      el(
        "text",
        {
          class: "conn-note",
          x: String(chip.center),
          y: String(py - MARKER_CH / 2 - 3),
          "text-anchor": "middle",
        },
        spec.note ?? ""
      ),
    ];
  }
  // expr / mixed / another note without a dedicated glyph: plain text
  return spec.note ? [noteText(xOut + out * 3)] : [];
}

/** estimating the width of a pin's exterior texts (net label +
 *  connection annotation), without a DOM measurer — enough for margins
 *  and routing obstacles. The annotation glyphs (const/select/concat) add
 *  a fixed allocation on top of the text, so ELK leaves a margin and the router reserves them */
function estPinText(pin: {
  netLabel: string | null;
  note: string | null;
  noteKind?: NoteKind | null;
  bus?: boolean;
  width?: number | null;
  mult?: string | null;
}): number {
  const annot = [pin.netLabel, pin.note].filter(Boolean).join(" ");
  // the width label (anchored at the slash, mx = STUB/2 from the block, toward the exterior)
  const wtxt = (pin.bus && pin.width ? `${pin.width}` : "") + (pin.mult ?? "");
  if (!annot && !wtxt) {
    return 0;
  }
  const glyph =
    pin.noteKind === "const" ||
    pin.noteKind === "select" ||
    pin.noteKind === "concat"
      ? GLYPH_W
      : 0;
  const annotMargin = annot ? STUB + annot.length * 6.5 + 8 + glyph : 0;
  const widthMargin = wtxt ? STUB / 2 + wtxt.length * 6 + 4 : 0;
  return Math.max(annotMargin, widthMargin);
}

interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

// ----------------------------------------------------------------- layout

/** the flip state of a node (docs/04) */
export interface Flip {
  h: boolean;
  v: boolean;
}

/**
 * The schematic layout. Without `seeds`, a full ELK layered (first opening).
 * With `seeds` (the user-owned positions, docs/04), ELK runs in
 * interactive mode: the given positions become the seeds of the layering and
 * of the ordering, so that ONLY the new elements receive positions, inserted in
 * the context of the existing ones; the caller then forces the seeds exactly
 * (interactive ELK may shift them slightly).
 */
export async function layoutSchematic(
  elk: ElkLike,
  scene: SchematicScene,
  measure: (text: string, mono?: boolean) => number,
  flips?: ReadonlyMap<string, Flip>,
  seeds?: ReadonlyMap<string, { x: number; y: number }>
): Promise<ElkNode> {
  const children: ElkNode[] = [];

  for (const b of scene.boundary) {
    children.push({
      id: b.id,
      // width on the grid: the flag's anchor (the tip/base) falls on the grid, so
      // the routes are entirely orthogonal on the grid. The padding (16 = margin
      // + the flag's 9px tip) is tight but keeps the label from touching the
      // tip; ceilGrid rounds to 8
      width: ceilGrid(measure(b.label, true) + 16),
      height: BPORT_H,
      layoutOptions: {
        // layers dedicated exclusively to the boundary (a plain FIRST/LAST would mix
        // the instances without input edges — labeled nets — among the
        // port flags)
        "elk.layered.layering.layerConstraint":
          b.side === "WEST" ? "FIRST_SEPARATE" : "LAST_SEPARATE",
      },
    });
  }

  for (const n of scene.nodes) {
    const flip = flips?.get(n.id) ?? { h: false, v: false };
    const west = n.pins.filter((p) => p.side === "WEST");
    const east = n.pins.filter((p) => p.side === "EAST");
    // the flip reassigns the pin slots (docs/04): horizontal swaps the
    // sides between them, vertical reverses the order on each side;
    // the grid slots and the text stay unchanged
    let effWest = flip.h ? east : west;
    let effEast = flip.h ? west : east;
    if (flip.v) {
      effWest = [...effWest].reverse();
      effEast = [...effEast].reverse();
    }
    const rows = Math.max(effWest.length, effEast.length, 1);
    const height = 56 + PIN_PITCH * (rows - 1); // 56, 72, ... (grid 8)
    const maxW = Math.max(0, ...effWest.map((p) => measure(p.label, true)));
    const maxE = Math.max(0, ...effEast.map((p) => measure(p.label, true)));
    const width = ceilGrid(
      Math.max(
        measure(n.name) + 24,
        measure(n.sub) + 24,
        maxW + maxE + 48,
        110
      )
    );
    const port = (p: { id: string }, i: number, x: number): NonNullable<ElkNode["ports"]>[number] => ({
      id: p.id,
      width: 8,
      height: 8,
      x,
      y: PIN_TOP + i * PIN_PITCH - 4, // center at PIN_TOP + i*PIN_PITCH
    });
    // the exterior texts (net labels, annotations) enter as margins in the
    // layout: ELK leaves room for them between the layers, otherwise the fresh
    // channels stay too narrow for routing
    const marginW = Math.max(0, ...effWest.map(estPinText));
    const marginE = Math.max(0, ...effEast.map(estPinText));
    children.push({
      id: n.id,
      width,
      height,
      layoutOptions: {
        "elk.portConstraints": "FIXED_POS",
        "elk.margins": `[top=0,left=${marginW},bottom=0,right=${marginE}]`,
      },
      ports: [
        ...effWest.map((p, i) => port(p, i, -4)),
        ...effEast.map((p, i) => port(p, i, width - 4)),
      ],
    });
  }

  if (seeds?.size) {
    for (const c of children) {
      const s = seeds.get(c.id);
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
      // without separation by connected components: the boundary ports without edges
      // (labeled nets) must still respect FIRST/LAST, not be
      // packed separately
      "elk.separateConnectedComponents": "false",
      // with seeds: interactive mode (docs/04) — the given positions order
      // the layers and the rows, only the new elements receive positions.
      // cycleBreaking stays default: the INTERACTIVE variant reverses
      // edges by positions and conflicts with LAST_SEPARATE on
      // the boundary flags (our edge directions are anyway
      // semantically fixed, driver -> destination)
      ...(seeds?.size
        ? {
            "elk.interactive": "true",
            "elk.layered.layering.strategy": "INTERACTIVE",
            "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
            "elk.layered.nodePlacement.strategy": "INTERACTIVE",
          }
        : { "elk.layered.layering.strategy": "LONGEST_PATH" }),
      // spacings correlated with the routing halo (16px on each block):
      // between two halos at least one wire lane must fit
      "elk.layered.spacing.nodeNodeBetweenLayers": "88",
      "elk.spacing.nodeNode": "48",
      "elk.spacing.edgeNode": "18",
      "elk.spacing.edgeEdge": "10",
      "elk.padding": "[top=10,left=10,bottom=10,right=10]",
    },
    children,
    edges: scene.edges.map((e) => ({
      id: e.id,
      sources: [e.sourcePort ?? e.source],
      targets: [e.targetPort ?? e.target],
    })),
  };
  return elk.layout(graph);
}

// ------------------------------------------------------------------ drawing

export interface SchematicHooks {
  /** click on the fold/expand button of a generated fold */
  onToggleFold(foldId: string): void;
}

/**
 * Draws the scene in the viewport and returns the edges group (for
 * live re-routing during the drag). The routes always come from
 * the own router (docs/04) — a single routing behavior, with halo
 * and protected labels, regardless of whether the view has overrides or not;
 * ELK gives only the node positions.
 */
export function drawSchematic(
  scene: SchematicScene,
  layout: ElkNode,
  viewport: SVGGElement,
  hooks: SchematicHooks
): SVGGElement {
  const nodeById = new Map(scene.nodes.map((n) => [n.id, n]));
  const bportById = new Map(scene.boundary.map((b) => [b.id, b]));

  // the edges first, so the nodes draw over the routes
  const edgesGroup = el("g", { class: "edges" });
  viewport.append(edgesGroup);
  routeEdges(scene, layout, edgesGroup);

  for (const child of layout.children ?? []) {
    const x = child.x ?? 0;
    const y = child.y ?? 0;
    const bport = bportById.get(child.id);
    if (bport) {
      viewport.append(
        drawBoundaryPort(bport, x, y, child.width ?? 40, child.height ?? BPORT_H)
      );
      continue;
    }
    const node = nodeById.get(child.id);
    if (node) {
      viewport.append(drawNode(node, child, x, y, hooks));
    }
  }
  return edgesGroup;
}

// ------------------------------------------------------------------ edges

function edgeElement(spec: SceneEdge, d: string): SVGGElement {
  // grading by width class: the bus wire is thicker (docs/04)
  const g = el("g", {
    class: `edge ${spec.kind} ${widthClass(spec.width)}`.trimEnd(),
  });
  // stable ID for selection: the net's name in the view's scope
  if (spec.net) {
    g.dataset.id = spec.net;
  }
  g.append(
    // no direction arrow in the schematic view: the direction is implicit from the
    // port's side (inputs on west, outputs on east) — the user's decision. In
    // the TB view the arrows remain (the flags distinguish in/out/inout).
    el("path", {
      class: "edge-line",
      d,
    }),
    el("title", {}, spec.net ?? "interface connection")
  );
  return g;
}

interface Anchor {
  x: number;
  y: number;
  /** the horizontal direction in which the pin "exits" the node (+1 east, -1 west) */
  dir: 1 | -1;
}

/**
 * The router's obstacles, derived from the scene + layout (PURE, tested in
 * test:router): the rectangles of all nodes and flags, plus
 * the text zones outside the blocks (net labels, connection
 * annotations) — other nets' routes do not pass over the port names.
 * Two real pitfalls live here (docs/04, CLAUDE.md):
 * - the text obstacle's height = one pin step (PIN_PITCH, no more):
 *   a taller obstacle bleeds into the neighboring pin's row and forces its
 *   wire onto a useless staircase detour;
 * - the pins that are endpoints of a wire-edge do NOT become obstacles: their
 *   annotation (select `[N]`, concat) sits right on its own wire's route, as
 *   its label — otherwise the wire detours around its own label with useless
 *   bends. The annotations of pins WITHOUT a wire (const `=1'b1`, nc, net
 *   labels) remain SOFT obstacles for OTHER nets' wires.
 */
export function edgeObstacles(
  scene: SchematicScene,
  layout: ElkNode
): Rect[] {
  const childById = new Map((layout.children ?? []).map((c) => [c.id, c]));
  const obstacles: Rect[] = (layout.children ?? []).map((c) => ({
    x: c.x ?? 0,
    y: c.y ?? 0,
    w: c.width ?? 0,
    h: c.height ?? 0,
  }));
  const wirePins = new Set<string>();
  for (const e of scene.edges) {
    if (e.kind === "wire") {
      if (e.sourcePort) {
        wirePins.add(e.sourcePort);
      }
      if (e.targetPort) {
        wirePins.add(e.targetPort);
      }
    }
  }
  for (const n of scene.nodes) {
    const child = childById.get(n.id);
    if (!child) {
      continue;
    }
    const pinById = new Map(n.pins.map((p) => [p.id, p]));
    for (const port of child.ports ?? []) {
      const pin = pinById.get(port.id);
      if (!pin) {
        continue;
      }
      if (wirePins.has(port.id)) {
        continue; // the pin's own wire coexists with the pin's label
      }
      const w = estPinText(pin);
      if (!w) {
        continue;
      }
      const west =
        (port.x ?? 0) + (port.width ?? 0) / 2 < (child.width ?? 0) / 2;
      const py = (child.y ?? 0) + (port.y ?? 0) + (port.height ?? 0) / 2;
      // SOFT obstacle (cost, not wall): in narrow channels the router passes
      // over the label instead of falling to the fallback through blocks
      obstacles.push({
        x: west ? (child.x ?? 0) - w : (child.x ?? 0) + (child.width ?? 0),
        y: py - PIN_PITCH / 2,
        w,
        h: PIN_PITCH,
        cost: 10,
      });
    }
  }
  return obstacles;
}

/**
 * Re-routes all edges by the current positions in `layout.children`:
 * the A* router on the grid (docs/04) avoids the nodes, with a naive Z fallback
 * per edge with no path found. Empties and repopulates the group — callable
 * on every drag step.
 */
export function routeEdges(
  scene: SchematicScene,
  layout: ElkNode,
  group: SVGGElement
): void {
  group.replaceChildren();
  const childById = new Map((layout.children ?? []).map((c) => [c.id, c]));
  const bportById = new Map(scene.boundary.map((b) => [b.id, b]));
  // the concat/select marker pins: the wire anchors BEYOND the chip
  // (MARKER_STUB), so the trunk connects to the left of the marker and the
  // horizontal stub traverses it (user request)
  const markerPins = new Set<string>();
  for (const n of scene.nodes) {
    for (const p of n.pins) {
      if (p.noteKind === "select" || p.noteKind === "concat") {
        markerPins.add(p.id);
      }
    }
  }

  const anchor = (nodeId: string, portId: string | null): Anchor | null => {
    const child = childById.get(nodeId);
    if (!child) {
      return null;
    }
    const cx = child.x ?? 0;
    const cy = child.y ?? 0;
    const cw = child.width ?? 0;
    const ch = child.height ?? 0;
    if (!portId) {
      // boundary flag: the west exits to the right, the east receives from the left
      const b = bportById.get(nodeId);
      if (!b) {
        return null;
      }
      return b.side === "WEST"
        ? { x: cx + cw, y: cy + ch / 2, dir: 1 }
        : { x: cx, y: cy + ch / 2, dir: -1 };
    }
    const port = (child.ports ?? []).find((p) => p.id === portId);
    if (!port) {
      return null;
    }
    // the effective side comes from geometry (the flips change the sides),
    // not from the scene pin's semantics
    const west = (port.x ?? 0) + (port.width ?? 0) / 2 < cw / 2;
    const out = markerPins.has(portId) ? MARKER_STUB : 0;
    return {
      x: cx + (west ? -out : cw + out),
      y: cy + (port.y ?? 0) + (port.height ?? 0) / 2,
      dir: west ? -1 : 1,
    };
  };

  // the obstacles (nodes + pin texts): edgeObstacles (pure, tested)
  const obstacles = edgeObstacles(scene, layout);
  const pending: { e: SceneEdge; s: Anchor; t: Anchor }[] = [];
  const requests: RouteRequest[] = [];
  for (const e of scene.edges) {
    const s = anchor(e.source, e.sourcePort);
    const t = anchor(e.target, e.targetPort);
    if (s && t) {
      pending.push({ e, s, t });
      // the group = the net: the edges of the same net can share the trunk
      requests.push({ id: e.id, source: s, target: t, group: e.net ?? e.id });
    }
  }
  const routed = route(obstacles, requests);
  const draw = (e: SceneEdge, poly: Pt[]): void => {
    group.append(
      edgeElement(e, "M " + poly.map((p) => `${p.x} ${p.y}`).join(" L "))
    );
  };
  // the comb guard: an axial segment must not cut through the interior of a
  // block (HARD obstacle, no cost) — otherwise the straight taps would pass through boxes
  const hardRects = obstacles.filter((o) => o.cost === undefined);
  const combClear = (polys: Pt[][]): boolean =>
    polys.every((poly) => {
      for (let i = 0; i + 1 < poly.length; i++) {
        const a = poly[i];
        const b = poly[i + 1];
        const x0 = Math.min(a.x, b.x);
        const x1 = Math.max(a.x, b.x);
        const y0 = Math.min(a.y, b.y);
        const y1 = Math.max(a.y, b.y);
        if (
          hardRects.some(
            (r) => x0 < r.x + r.w && x1 > r.x && y0 < r.y + r.h && y1 > r.y
          )
        ) {
          return false;
        }
      }
      return true;
    });
  // we group the wire-edges by net: a bus's fan-in is drawn as a
  // COMB (combPolys), not as a star converging in the sink (4-way)
  const netPolys = new Map<string, Pt[][]>();
  const byNet = new Map<string, { e: SceneEdge; s: Anchor; t: Anchor }[]>();
  for (const p of pending) {
    if (p.e.kind === "wire" && p.e.net) {
      (byNet.get(p.e.net) ?? byNet.set(p.e.net, []).get(p.e.net)!).push(p);
    } else {
      // interface / no net: per-edge (without junction dots)
      const pts = routed.get(p.e.id);
      draw(p.e, pts ?? []);
      if (!pts) {
        group.append(edgeElement(p.e, zRoute(p.s, p.t)));
      }
    }
  }
  for (const [net, eds] of byNet) {
    const polysRouted = eds
      .map(({ e }) => routed.get(e.id))
      .filter((pp): pp is Pt[] => !!pp);
    const seenEnd = new Set<string>();
    const ends: Pt[] = [];
    for (const { s, t } of eds) {
      for (const a of [s, t]) {
        const k = `${a.x},${a.y}`;
        if (!seenEnd.has(k)) {
          seenEnd.add(k);
          ends.push({ x: a.x, y: a.y });
        }
      }
    }
    const comb = eds.length >= 2 ? combPolys(ends, polysRouted) : null;
    if (comb && combClear(comb)) {
      comb.forEach((poly) => draw(eds[0].e, poly));
      netPolys.set(net, comb);
    } else {
      const polys: Pt[][] = [];
      for (const { e, s, t } of eds) {
        const pts = routed.get(e.id);
        if (pts) {
          draw(e, pts);
          polys.push(pts);
        } else {
          group.append(edgeElement(e, zRoute(s, t)));
        }
      }
      netPolys.set(net, polys);
    }
  }
  // the junction points (T) of the nets with fanout (docs/04, vocabulary)
  for (const dot of junctionDots(netPolys)) {
    group.append(
      el("circle", {
        class: "junction",
        cx: String(dot.x), cy: String(dot.y), r: "3",
      })
    );
  }
}

interface Pt {
  x: number;
  y: number;
}

/**
 * The JUNCTION points (junction dots) from a set of polylines grouped by
 * net (PURE, tested in test:router). The Eeschema convention: a dot ONLY where
 * a net BRANCHES in a T (three cardinal directions have a wire), never at a
 * simple crossing (four directions = crossover — it can also be an
 * incidental overlap of two branches of the SAME net) or at a corner (two directions).
 * They are grouped by net, so the crossings of TWO different nets never produce
 * a dot. Robust to geometry (it does not assume a grid): for each
 * vertex of the net it counts the distinct cardinal directions in which a
 * segment of the net departs; T = exactly 3.
 */
export function junctionDots(netPolys: Map<string, Pt[][]>): Pt[] {
  const dots: Pt[] = [];
  const seen = new Set<string>();
  for (const polys of netPolys.values()) {
    const segs: [Pt, Pt][] = [];
    const verts = new Map<string, Pt>();
    for (const poly of polys) {
      for (const p of poly) {
        verts.set(`${p.x},${p.y}`, p);
      }
      for (let i = 0; i + 1 < poly.length; i++) {
        const a = poly[i];
        const b = poly[i + 1];
        // axial and nonzero (a degenerate segment has no direction)
        if ((a.x === b.x) !== (a.y === b.y)) {
          segs.push([a, b]);
        }
      }
    }
    for (const v of verts.values()) {
      const dirs = new Set<string>();
      for (const [a, b] of segs) {
        if (a.x === b.x && v.x === a.x) {
          const lo = Math.min(a.y, b.y);
          const hi = Math.max(a.y, b.y);
          if (v.y < lo || v.y > hi) {
            continue;
          }
          if (v.y > lo) {
            dirs.add("N"); // the segment extends toward a smaller y
          }
          if (v.y < hi) {
            dirs.add("S");
          }
        } else if (a.y === b.y && v.y === a.y) {
          const lo = Math.min(a.x, b.x);
          const hi = Math.max(a.x, b.x);
          if (v.x < lo || v.x > hi) {
            continue;
          }
          if (v.x > lo) {
            dirs.add("W");
          }
          if (v.x < hi) {
            dirs.add("E");
          }
        }
      }
      // >=3 directions at a VERTEX = a real junction of the same net (T with 3, or
      // a 4-way merge as at a bus's fan-in: 3 wires into a port).
      // The dangerous crossings are already excluded: DIFFERENT nets are not in
      // the same group, and a crossing of the same net without a corner (two straight
      // wires) has no vertex at the intersection, so it does not reach here (user
      // request: dots at the merge of the douts into ch_out)
      const key = `${v.x},${v.y}`;
      if (dirs.size >= 3 && !seen.has(key)) {
        seen.add(key);
        dots.push({ x: v.x, y: v.y });
      }
    }
  }
  return dots;
}

/** Reconstructs the routes of a net with FAN (>=2 wire edges, endpoints on
 *  different rows) as a COMB: a vertical trunk at `trunkX` (the dominant
 *  vertical x from the A* routing, so it avoids the obstacles) + a horizontal tap per
 *  endpoint. Replaces the STAR that converges in the sink (all edges toward the same
 *  point = 4-way) with SEPARATE taps: each endpoint touches the trunk in its
 *  turn, and the sink in its turn (at the trunk's end when it is beyond the
 *  sources -> clean T junctions, user request). Returns null when
 *  it does not apply (below 3 endpoints / all on one row / no vertical) -> the
 *  per-edge routing remains. Pure, tested in test:router. */
export function combPolys(ends: Pt[], routed: Pt[][]): Pt[][] | null {
  if (ends.length < 3) {
    return null; // need >=2 sources + 1 sink
  }
  // trunkX = the x with the greatest total vertical length in the routing (spine)
  const vlen = new Map<number, number>();
  for (const poly of routed) {
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i];
      const b = poly[i + 1];
      if (a.x === b.x) {
        vlen.set(a.x, (vlen.get(a.x) ?? 0) + Math.abs(a.y - b.y));
      }
    }
  }
  let trunkX: number | null = null;
  let best = 0;
  for (const [x, len] of vlen) {
    if (len > best) {
      best = len;
      trunkX = x;
    }
  }
  if (trunkX === null) {
    return null; // no vertical -> there is no vertical trunk
  }
  const ys = ends.map((e) => e.y);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  if (y0 === y1) {
    return null; // all endpoints on one row
  }
  // spine = top tap -> trunk -> bottom tap, as ONE SINGLE polyline:
  // the end corners have a junction (miter), not two separate butt ends that
  // leave a gap at the joint (user observation). The INTERIOR taps
  // stay separate — they touch the thick SIDE of the trunk (T), covered by it.
  const top = ends.find((e) => e.y === y0) as Pt;
  const bottom = ends.find((e) => e.y === y1) as Pt;
  const spine: Pt[] = [];
  if (top.x !== trunkX) {
    spine.push({ x: top.x, y: y0 });
  }
  spine.push({ x: trunkX, y: y0 }, { x: trunkX, y: y1 });
  if (bottom.x !== trunkX) {
    spine.push({ x: bottom.x, y: y1 });
  }
  const polys: Pt[][] = [spine];
  for (const e of ends) {
    if (e === top || e === bottom || e.x === trunkX) {
      continue;
    }
    polys.push([{ x: e.x, y: e.y }, { x: trunkX, y: e.y }]);
  }
  return polys;
}

/** the surplus (diagram px) by which the guide overshoots the matched ports */
export const ALIGN_GUIDE_PAD = 24;
export interface AlignPt {
  x: number;
  y: number;
}
export interface AlignSnap {
  /** the X/Y displacement that aligns the dragged port EXACTLY (0 with no match) */
  dx: number;
  dy: number;
  /** the vertical/horizontal guide line at alignment (null with no match) */
  vLine: { x: number; y0: number; y1: number } | null;
  hLine: { y: number; x0: number; x1: number } | null;
}

/** Alignment guides on drag on the PORT POSITIONS (user request):
 *  for the ports of the DRAGGED block `dragged` (already moved to the raw position),
 *  it looks on each axis for the closest match (within `threshold`) with a port
 *  of another block from `others`. Aligning to PORTS, not to the block's edges,
 *  keeps the wires straight: two ports at the same y => a horizontal wire. Returns
 *  the displacement that aligns exactly + the guide line from the dragged port to the
 *  matched one; 0/null on the axis with no match (there the caller falls to the grid
 *  snap). Pure, tested in test:router. */
export function alignSnap(
  dragged: AlignPt[],
  others: AlignPt[],
  threshold: number
): AlignSnap {
  let bx: { diff: number; snap: number; dp: AlignPt; op: AlignPt } | null = null;
  let by: { diff: number; snap: number; dp: AlignPt; op: AlignPt } | null = null;
  for (const dp of dragged) {
    for (const op of others) {
      const dxDiff = op.x - dp.x;
      if (
        Math.abs(dxDiff) <= threshold &&
        (!bx || Math.abs(dxDiff) < Math.abs(bx.diff))
      ) {
        bx = { diff: dxDiff, snap: op.x, dp, op };
      }
      const dyDiff = op.y - dp.y;
      if (
        Math.abs(dyDiff) <= threshold &&
        (!by || Math.abs(dyDiff) < Math.abs(by.diff))
      ) {
        by = { diff: dyDiff, snap: op.y, dp, op };
      }
    }
  }
  const dx = bx ? bx.diff : 0;
  const dy = by ? by.diff : 0;
  // the guide extends from the dragged port to the matched one, with a small surplus
  // (ALIGN_GUIDE_PAD) on each end: it stays visible even when the two
  // ports coincide on the axis (same column / same row)
  const pad = ALIGN_GUIDE_PAD;
  return {
    dx,
    dy,
    vLine: bx
      ? {
          x: bx.snap,
          y0: Math.min(bx.dp.y + dy, bx.op.y) - pad,
          y1: Math.max(bx.dp.y + dy, bx.op.y) + pad,
        }
      : null,
    hLine: by
      ? {
          y: by.snap,
          x0: Math.min(by.dp.x + dx, by.op.x) - pad,
          x1: Math.max(by.dp.x + dx, by.op.x) + pad,
        }
      : null,
  };
}

/** The offsets of the pin ENDS (the stub tips, where the wires connect
 *  and the `{}`/`[]` markers sit), relative to each node's origin — the correct
 *  alignment points (user request): the vertical guides pass through the
 *  pin ends, not through the block's edges. The end is at `-stubLen` on the
 *  west / `cw+stubLen` on the east, with `stubLen = MARKER_STUB` for the pins with
 *  a concat/select marker (the wire connects beyond the chip), otherwise `STUB`.
 *  The side comes from GEOMETRY (like the anchor in routeEdges), so the flips
 *  follow it. Pure, tested in test:router. */
export function pinTipOffsets(
  scene: SchematicScene,
  layout: ElkNode
): Map<string, AlignPt[]> {
  const markerPins = new Set<string>();
  for (const n of scene.nodes) {
    for (const p of n.pins) {
      if (p.noteKind === "select" || p.noteKind === "concat") {
        markerPins.add(p.id);
      }
    }
  }
  const out = new Map<string, AlignPt[]>();
  for (const c of layout.children ?? []) {
    const cw = c.width ?? 0;
    const pts: AlignPt[] = [];
    for (const port of c.ports ?? []) {
      const west = (port.x ?? 0) + (port.width ?? 0) / 2 < cw / 2;
      const stubLen = markerPins.has(port.id ?? "") ? MARKER_STUB : STUB;
      pts.push({
        x: west ? -stubLen : cw + stubLen,
        y: (port.y ?? 0) + (port.height ?? 0) / 2,
      });
    }
    out.set(c.id ?? "", pts);
  }
  return out;
}

/** orthogonal Z route; at unfavorable directions, an S detour through the middle */
function zRoute(s: Anchor, t: Anchor): string {
  const off = 14;
  const forward =
    s.dir > 0 ? t.x + t.dir * off >= s.x + off : t.x + t.dir * off <= s.x - off;
  if (forward && s.dir === -t.dir) {
    const mx = (s.x + t.x) / 2;
    return `M ${s.x} ${s.y} L ${mx} ${s.y} L ${mx} ${t.y} L ${t.x} ${t.y}`;
  }
  const sx2 = s.x + s.dir * off;
  const tx2 = t.x + t.dir * off;
  const my = (s.y + t.y) / 2;
  return (
    `M ${s.x} ${s.y} L ${sx2} ${s.y} L ${sx2} ${my} ` +
    `L ${tx2} ${my} L ${tx2} ${t.y} L ${t.x} ${t.y}`
  );
}

/** port of the view's module: pentagonal flag with the name inside */
function drawBoundaryPort(
  b: SceneBPort,
  x: number,
  y: number,
  w: number,
  h: number
): SVGGElement {
  const g = el("g", {
    class: `bport${b.iface ? " iface" : ""} ${widthClass(b.width)}`.trimEnd(),
    transform: `translate(${x},${y})`,
  });
  g.dataset.id = b.id;
  g.dataset.port = b.name;
  g.dataset.bport = "1";
  g.append(
    el("polygon", {
      class: "bport-shape",
      points: `0,0 ${w - 9},0 ${w},${h / 2} ${w - 9},${h} 0,${h}`,
    })
  );
  if (b.bus) {
    g.append(
      el("line", {
        class: "bus-slash",
        x1: String(w - 4), y1: String(h / 2 + 4),
        x2: String(w + 2), y2: String(h / 2 - 4),
      })
    );
  }
  // the bus width + `×M` unpacked, above the flag (without `/` — the slash
  // is already the bus marker; the flag is a standalone element, so centered)
  const wtxt = (b.bus && b.width ? `${b.width}` : "") + (b.mult ?? "");
  if (wtxt) {
    g.append(
      el(
        "text",
        { class: "mult", x: String(w / 2), y: "-3", "text-anchor": "middle" },
        wtxt
      )
    );
  }
  g.append(
    portLabelText(
      { class: "bport-label", x: String((w - 8) / 2), y: String(h / 2 + 4) },
      b.label,
      b.name
    ),
    el("title", {}, b.tooltip)
  );
  return g;
}

function drawNode(
  n: SceneNode,
  layout: ElkNode,
  x: number,
  y: number,
  hooks: SchematicHooks
): SVGGElement {
  const w = layout.width ?? 110;
  const h = layout.height ?? 46;
  const g = el("g", {
    class: `inode ${n.kind}`,
    transform: `translate(${x},${y})`,
  });
  g.dataset.id = n.id;
  if (n.instPath) {
    g.dataset.inst = n.instPath;
  }

  if (n.kind === "fold") {
    // stack: two offset shadows suggest the folded instances
    g.append(
      el("rect", { class: "fold-shadow", x: "8", y: "8", rx: "3",
        width: String(w), height: String(h) }),
      el("rect", { class: "fold-shadow", x: "4", y: "4", rx: "3",
        width: String(w), height: String(h) })
    );
  }
  g.append(
    el("rect", {
      class: "module-box",
      x: "0", y: "0", rx: "3",
      width: String(w), height: String(h),
    }),
    el("text", { class: "inode-name", x: String(w / 2), y: "15" }, n.name),
    el("text", { class: "inode-sub", x: String(w / 2), y: "29" }, n.sub),
    el(
      "title",
      {},
      n.tooltip +
        "\n" +
        (n.kind === "fold"
          ? "double-click: expand"
          : n.hasView
            ? "double-click: schematic; Ctrl+double-click: source"
            : "double-click: module source")
    )
  );

  const pinById = new Map(n.pins.map((p) => [p.id, p]));
  for (const port of layout.ports ?? []) {
    const spec = pinById.get(port.id);
    if (!spec) {
      continue;
    }
    const py = (port.y ?? 0) + (port.height ?? 0) / 2;
    // the effective side comes from geometry: the flips change the sides
    const west = (port.x ?? 0) + (port.width ?? 0) / 2 < w / 2;
    g.append(drawPin(spec, n, w, py, west));
  }

  // the fold/expand button (docs/05: folded implicitly, expandable)
  if (n.kind === "fold") {
    g.append(foldButton(n.id, w, `×${n.foldCount} — expand`, "⊞", hooks));
  } else if (n.foldId) {
    g.append(foldButton(n.foldId, w, `collapse into ${n.foldId}`, "⊟", hooks));
  }
  return g;
}

function foldButton(
  foldId: string,
  nodeW: number,
  tip: string,
  glyph: string,
  hooks: SchematicHooks
): SVGGElement {
  const g = el("g", { class: "foldbtn" });
  g.dataset.fold = foldId;
  g.append(
    el("rect", {
      x: String(nodeW - 18), y: "3", width: "15", height: "15", rx: "2",
    }),
    el("text", { x: String(nodeW - 10.5), y: "14.5" }, glyph),
    el("title", {}, tip)
  );
  g.addEventListener("click", (e) => {
    e.stopPropagation();
    hooks.onToggleFold(foldId);
  });
  return g;
}

function drawPin(
  spec: ScenePin,
  node: SceneNode,
  nodeW: number,
  py: number,
  west: boolean
): SVGGElement {
  const x0 = west ? 0 : nodeW;
  // xOut = the stub's end for positioning the chip/annotation (fixed STUB);
  // the VISIBLE stub extends to MARKER_STUB for the marker pins, so the wire
  // connects beyond the chip (see MARKER_STUB) and traverses it horizontally
  const isMarker =
    spec.noteKind === "select" || spec.noteKind === "concat";
  const xOut = west ? -STUB : nodeW + STUB;
  const stubOut = isMarker ? (west ? -MARKER_STUB : nodeW + MARKER_STUB) : xOut;
  const mx = (x0 + xOut) / 2;
  // the bus-width label (`16` / `16×3`); its reserve keeps the marker chip clear
  // of it so the chip centers on the REMAINING pin extension (see markerChip)
  const wtxt = (spec.bus && spec.width ? `${spec.width}` : "") + (spec.mult ?? "");
  const wReserve = widthReserve(wtxt);

  const g = el("g", {
    class: `pin${spec.iface ? " iface" : ""} ${widthClass(spec.width)}`.trimEnd(),
  });
  g.dataset.id = spec.id;
  g.dataset.port = spec.port;
  if (node.instPath) {
    g.dataset.inst = node.instPath;
  }

  if (isMarker) {
    // concat/select marker pin: the pin extension stays (block -> tip), the wire
    // anchors at the tip, and the chip is centered on the extension that remains
    // after the bus-width reserve (markerChip; user request, Jul 2026). The stub
    // is two segments touching the chip's faces, so nothing crosses it: block ->
    // block-side face, and tip-side face -> tip.
    const out = west ? -1 : 1;
    const chip = markerChip(x0, out, wReserve);
    g.append(
      el("line", {
        class: "stub",
        x1: String(x0), y1: String(py),
        x2: String(chip.chipInner), y2: String(py),
      }),
      el("line", {
        class: "stub",
        x1: String(chip.chipOuter), y1: String(py),
        x2: String(stubOut), y2: String(py),
      })
    );
  } else {
    g.append(
      el("line", {
        class: "stub",
        x1: String(stubOut), y1: String(py), x2: String(x0), y2: String(py),
      })
    );
  }
  if (spec.iface) {
    g.append(
      el("rect", {
        class: "hatch",
        x: String(Math.min(x0, xOut)), y: String(py - 3),
        width: String(STUB), height: "6",
      })
    );
  } else if (spec.bus) {
    // the bus: slash + `/N` label (netlistsvg); the grading by width comes from
    // the w-* class on the pin's group
    g.append(
      el("line", {
        class: "bus-slash",
        x1: String(mx - 3), y1: String(py + 4),
        x2: String(mx + 3), y2: String(py - 4),
      })
    );
  }
  // the width label above the stub (py-6): the bus width + `×M`
  // unpacked (e.g. `16×3`). ANCHORED at the slash marker (mx), toward the EXTERIOR
  // (anchor on the side), NOT centered — otherwise it cut the block's boundary on the
  // short stub (observation at validation). WITHOUT `/`: the slash on the wire is already
  // the bus marker, so `/16` would double the slash. The margin is reserved in
  // estPinText (the label sticks out beyond the stub at wide values)
  if (wtxt) {
    g.append(
      el(
        "text",
        {
          class: "mult",
          x: String(mx),
          y: String(py - 6),
          "text-anchor": west ? "end" : "start",
        },
        wtxt
      )
    );
  }
  for (const a of drawAnnotation(spec, xOut, py, west, wReserve)) {
    g.append(a);
  }
  if (spec.netLabel) {
    // net shown as a label, not as a routed wire (level 4, docs/04); a single
    // net's label is selectable (click -> the inspector's Net section, with the
    // wire/label toggle).
    // On a split/join marker pin (concat/select) the label anchors at the TIP of
    // the extended stub (stubOut = MARKER_STUB), at the extended port boundary —
    // beyond both the chip (centered mid-extension) and the tip stub. Without a
    // marker stubOut == xOut, so plain pins are unchanged.
    const labelX = west ? stubOut - 3 : stubOut + 3;
    const lbl = el(
      "text",
      {
        class: "netlabel",
        x: String(labelX),
        y: String(py + 4),
        "text-anchor": west ? "end" : "start",
      },
      spec.netLabel
    );
    if (!spec.netLabel.includes(",")) {
      lbl.dataset.id = spec.netLabel;
    }
    g.append(lbl);
  }
  g.append(
    portLabelText(
      {
        class: "pin-label",
        x: String(west ? 6 : nodeW - 6),
        y: String(py + 4),
        "text-anchor": west ? "start" : "end",
      },
      spec.label,
      spec.port
    ),
    el("title", {}, spec.tooltip)
  );
  return g;
}
