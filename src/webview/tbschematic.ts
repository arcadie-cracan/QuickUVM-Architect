// Layout + desen pentru vederea de verificare, PLAT PER NIVEL (faza 3b,
// docs/05, decizia D24): ELK layered (ca vederea-schema RTL), blocuri
// desenate ca CUTII UML (stereotip + compartimente text), steaguri de
// granita pentru conexiunile care traverseaza nivelul, muchii rutate cu
// ruterul A* comun. Fara compound/nesting — structura interna a unui bloc
// se descopera prin dublu-clic (drill), la nivelul urmator.

import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import { Rect, route, RouteRequest } from "./router";
import { el } from "./svg";
import type { TbBoundary, TbEdge, TbNode, TbPort, TbScene } from "./tbscene";

interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

const STUB = 10;
const BPORT_H = 16;
const PIN_TOP = 40; // primul port sub banda de titlu (multiplu de 8)
const PIN_PITCH = 16;
const LINE_H = 13; // inaltimea unei linii de compartiment

function ceilGrid(v: number): number {
  return Math.ceil(v / 8) * 8;
}

/** dimensiunea cutiei UML: titlu + stereotip + compartimente, si min pentru porturi */
function boxSize(
  n: TbNode,
  measure: (t: string) => number
): { w: number; h: number } {
  let textH = 22; // banda de titlu
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

/** geometria porturilor pe grila (centre la PIN_TOP + i*PITCH, pe fiecare latura) */
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
  /** rasturnare locala pe orizontala (D24): oglindeste forma in jurul centrului
   *  propriu si muta ancora pe latura opusa a steagului — NU schimba latura ELK
   *  (pozitia ramane, deci nu se incalca FIRST/LAST_SEPARATE). La un steag inout
   *  (hexagon simetric) doar ancora sare de la un varf la celalalt. */
  flipH?: boolean;
}

export interface TbLayout {
  nodes: Map<string, TbPlaced>;
  boundary: Map<string, TbBPlaced>;
  width: number;
  height: number;
}

/** rasturnarea unui bloc/steag TB (ca RTL): H = laturile vest<->est, V =
 *  ordinea porturilor pe fiecare latura (docs/04) */
export interface Flip {
  h: boolean;
  v: boolean;
}

/** porturile unui nod dupa rasturnare: laturile schimbate la H, ordinea
 *  inversata pe fiecare latura la V (aceeasi logica ca `layoutSchematic`) */
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

/** Layout PLAT: ELK layered cu porturi FIXED_POS si steaguri FIRST/LAST_SEPARATE. */
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

  // Steagurile NU se rastoarna: latura lor e dictata de directia muchiei
  // (FIRST_SEPARATE = fara muchii de intrare, LAST_SEPARATE = fara muchii de
  // iesire — ELK ARUNCA altfel, in modul interactiv). Un `flips` cu id de
  // steag (samanta veche) se ignora. Un steag INOUT (ambele sensuri, ex.
  // `<if>` la nivel de agent: driver->if->monitor) nu poate satisface NICIUNA
  // dintre constrangeri, deci NU primeste layerConstraint — ELK il aseaza intr-un
  // strat de mijloc (fara aruncare, si fara ocolul if->monitor de dinainte).
  // NOTA (probat empiric, iul. 2026): chiar FARA layerConstraint, ELK layered
  // aseaza un steag directional pe latura ceruta de muchie (sursa->stanga,
  // tinta->dreapta) si IGNORA o samanta pe latura opusa — deci mutarea unui
  // steag directional pe latura cealalta nu e realizabila prin seminte.
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

  // pozitiile detinute de utilizator devin seminte pentru ELK interactiv
  // (docs/04, ca vederea-schema RTL): nodurile cunoscute raman pe loc, doar
  // elementele noi primesc pozitii inserate in context
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
      // cu seminte: mod interactiv (pozitiile date ordoneaza straturile/
      // randurile); cycleBreaking ramane implicit (INTERACTIVE ar intra in
      // conflict cu LAST_SEPARATE pe steaguri — vezi layoutSchematic)
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
        // rasturnarea locala nu atinge ELK (pozitia ramane); e pur geometrica,
        // consumata de drawBoundary/anchor
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
    const n = effNode.get(c.id ?? ""); // copia rasturnata (porturi re-plasate)
    if (!n) {
      continue;
    }
    const geo = geoms.get(n.id) ?? [];
    const ports = new Map<
      string,
      { x: number; y: number; side: "WEST" | "EAST" }
    >();
    for (const p of geo) {
      // offset RELATIV la originea nodului (ca porturile ELK): ancora se
      // calculeaza din n.x/n.y curent (vezi `anchor`), deci porturile urmeaza
      // nodul la drag fara re-layout
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

// ------------------------------------------------------------------ desen

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
  // grupul muchiilor deasupra nodurilor, reutilizabil la re-rutarea din drag
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
  // porturile: linie scurta + eticheta pe latura
  for (const port of n.ports) {
    const a = p.ports.get(port.id);
    if (!a) {
      continue;
    }
    const west = port.side === "WEST";
    const py = a.y; // port relativ la originea nodului (grupul are deja translate)
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
          // eticheta mereu DEASUPRA portului (nu pe randul firului: firul iese
          // orizontal la py, deci nu taie numele), pe AMBELE laturi — alinierea
          // verticala e CONSTANTA la rasturnare (H schimba latura vest<->est,
          // dar nu si sus/jos; cererea utilizatorului). Anchorul (end la vest,
          // start la est) tine eticheta pe latura exterioara a blocului, deci
          // porturile care se privesc raman separate orizontal
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
  // rasturnarea locala (p.flipH) oglindeste forma in jurul centrului: varful si
  // baza isi schimba latura (hexagonul inout e simetric, deci ramane neschimbat)
  const west = (b.side === "WEST") !== Boolean(p.flipH);
  const pointRight = `M 0 0 H ${w - notch} L ${w} ${BPORT_H / 2} L ${w - notch} ${BPORT_H} H 0 Z`;
  const pointLeft = `M ${w} 0 H ${notch} L 0 ${BPORT_H / 2} L ${notch} ${BPORT_H} H ${w} Z`;
  // varful arata directia datelor fata de nivel: `in` -> spre interiorul
  // diagramei, `out` -> spre exterior, `inout` -> dreptunghi (bidirectional,
  // ex. interfata `<if>`, care nu are o directie unica)
  let d: string;
  if (b.dir === "inout") {
    // hexagon turtit: fuziunea varfului de iesire (dreapta) cu cel de intrare
    // (stanga) — portul bidirectional are ambele sensuri
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
    // steag de granita: iesirea e spre interior (est pentru vest, invers).
    // Rasturnarea locala (flipH) muta ancora pe latura opusa a steagului —
    // oglindita fata de centrul propriu, la fel ca forma
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
      // porturile sunt relative la originea nodului: absolut = n.x/n.y + offset
      return { x: n.x + a.x + dir * STUB, y: n.y + a.y, dir };
    }
  }
  return { x: n.x + n.w + STUB, y: n.y + n.h / 2, dir: 1 };
}

/** (re)ruteaza muchiile TB in `group` (reutilizabil la drag, ca `routeEdges`
 *  pentru RTL): golește grupul si redeseneaza traseele din pozitiile curente */
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
        // sageata la capat (tinta) pe TOATE muchiile: arata sensul datelor,
        // deci si directia porturilor (sursa = iesire, tinta = intrare); o
        // interfata are doua muchii — driver->if si if->monitor — deci ambele
        // sensuri se vad
        "marker-end": "url(#arrow)",
      }),
      el("title", {}, e.net ?? e.kind)
    );
    group.append(edge);
  }
}
