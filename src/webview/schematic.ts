// Vederea de interior: layout ELK (layered, stanga->dreapta, rutare
// ortogonala) si desen SVG pentru scena construita de scene.ts. Muchiile
// vin din ELK la layoutul complet — ruterul independent de pozitii e pasul
// urmator al fazei 3 (docs/04); aici pozitiile sunt inca cele calculate.

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

/** eticheta de port ca <text> cu dimensiunile packed/unpacked intr-o nuanta
 *  discreta (tspan `.dim`), numele in culoarea plina — compacta (fara spatii),
 *  dar lizibila prin contrast de nuanta (cererea utilizatorului, iul. 2026).
 *  Nuanta e `fill-opacity` pe tspan, deci urmeaza culoarea numelui la
 *  hover/select/iface, nu o culoare fixa. */
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

/** centreaza vertical semnul `{}`/`[]` in dreptunghiul chip-ului, DUPA randare
 *  (getBBox cere elementele in DOM). `dominant-baseline: central` centreaza
 *  corect in fontul de fallback, dar depinde de metrica fontului si poate lasa
 *  parantezele usor descentrate in unele fonturi de editor — masuram cutia
 *  reala a semnului si a dreptunghiului si nudge-uim. Idempotent per randare
 *  (semnele se recreeaza la fiecare desen cu y=py, deci nu se acumuleaza). */
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
        // getBBox poate esua daca elementul nu e inca randat; ignoram
      }
    });
}

/** lungimea liniei de pin in afara dreptunghiului, in vederea-schema */
const STUB = 10;
/** geometria chip-ului concat/select: GAP fata de capatul stub-ului, latime,
 *  inaltime (folosite si de MARKER_STUB si de ancora firului) */
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
/** capatul stub-ului SI ancora firului pentru pinii cu marcator concat/select:
 *  dincolo de chip (STUB+GAP+CW=36) cu MARKER_TAIL (=48, pe grila). Astfel:
 *  (1) trunchiul fanout-ului se leaga dincolo de marcator (nu-l mai taie pe
 *  verticala), iar stub-ul orizontal il traverseaza in directia portului;
 *  (2) tranzitia de grosime stub-port (subtire) -> muchie-net (gros) cade la
 *  VARF, coliniara cu firul (fara colt), deci nu produce imbinari rupte —
 *  nota veche „tranzitia sub chip" e INLOCUITA de cererea mai noua (pinul
 *  vizibil dincolo de chip bate ascunderea tranzitiei) */
const MARKER_STUB = STUB + MARKER_GAP + MARKER_CW + MARKER_TAIL;
/** inaltimea unui port de granita (centrul la multiplu de 8, ca pinii) */
const BPORT_H = 16;

// Geometria pinilor pe grila de 8 (conventia EDA: pinii se agata de grila,
// nu cutia). Porturile sunt FIXED_POS, calculate aici — ELK nu ofera control
// suficient (portsSurrounding e ignorat la plasare, etichetele INSIDE umfla
// pasul); pretul e ca pinii raman in ordinea declaratiei, ceea ce e chiar
// norma din schematics (override-urile de ordine vin in faza 4, nivelul 2).
// Colt pe grila => toti pinii pe grila => pin aliniat = fir drept.
/** centrul primului pin, sub banda de titlu (multiplu de 8) */
const PIN_TOP = 40;
/** pasul dintre centrele pinilor. MULTIPLU DE 8 obligatoriu (pin pe grila =
 *  fir drept, docs/04); 24 (nu 16) da aer decoratiilor — latimi `/N`, glife
 *  const/split-join, cercuri nc — care la 16 se calcau intre randuri
 *  (observatie la validare) */
const PIN_PITCH = 24;

/** rotunjire in sus la multiplu de grila */
function ceilGrid(v: number): number {
  return Math.ceil(v / 8) * 8;
}

/**
 * Clasa CSS de gradare pe clase de latime (docs/04, vocabular de desen): un
 * fir/pin de bus e cu atat mai gros cu cat semnalul e mai lat. `null`/1 =
 * fir simplu (fara clasa). Praguri: 2-8 (w-s), 9-16 (w-m), >16 (w-l).
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

/** latimea glifei de adnotare (const-box, chip split/join) dincolo de text, in
 *  px — acopera si GAP-ul cu care chip-ul concat/select se departeaza de port */
const GLYPH_W = 22;

/**
 * Glifele adnotarii unui pin la capatul liber al stub-ului (vocabular de desen,
 * docs/04): `nc` cerc gol, `const` cutie tie-cell cu valoarea, `select`/`concat`
 * pana netlistsvg (split ingusteaza spre exterior, join largeste) + eticheta,
 * restul (`expr`/`mixed`) text simplu. Alege glifa dupa `noteKind`, nu dupa
 * textul notei. `xOut` = capatul liber; `west` = latura vest (glifa spre stanga).
 */
function drawAnnotation(
  spec: ScenePin,
  xOut: number,
  py: number,
  west: boolean
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
    // cutie tie-cell cu valoarea (fara `=`), lipita de capatul stub-ului
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
    // chip cu perechea de paranteze SV (decizia de vocabular, iul. 2026):
    // concat = `{}` (acolade), select = `[]` (paranteze drepte) — chiar
    // operatorii din sursa, fara mnemonic. Contur de accent, categoric
    // adnotare (nu fir), fara varf orientat de-a lungul firului -> nu se
    // confunda cu sageata de directie a firelor (pana plina veche o facea).
    // Textul {…}/[hi:lo] ramane purtatorul de sens la `decorations off`
    // (chip-ul e decoratie, ascuns acolo; nota nu se scoate).
    // chip departat de capatul stub-ului cu MARKER_GAP (altfel coltul de sus se
    // suprapunea cu eticheta de latime / nota); dimensiunile si stub-ul extins
    // vin din constantele de modul MARKER_*
    const brackets = kind === "concat" ? "{}" : "[]";
    const inner = xOut + out * MARKER_GAP; // marginea dinspre bloc a chip-ului
    const cx = inner + out * (MARKER_CW / 2);
    const bx = west ? inner - MARKER_CW : inner;
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
          x: String(cx),
          // y aproximativ centrat ca fallback; centrarea fina o face
          // `centerChipSigns` dupa randare. NU folosim `dominant-baseline`:
          // getBBox + dominant-baseline difera intre versiuni de Chromium
          // (harness vs webview VSCode), iar nudge-ul iesea gresit; cu baseline
          // alfabetic getBBox e fiabil peste tot
          y: String(py + 3),
          "text-anchor": "middle",
        },
        brackets
      ),
      noteText(inner + out * (MARKER_CW + 3)),
    ];
  }
  // expr / mixed / alta nota fara glifa dedicata: text simplu
  return spec.note ? [noteText(xOut + out * 3)] : [];
}

/** estimarea latimii textelor exterioare ale unui pin (eticheta de net +
 *  adnotarea de conexiune), fara masurator DOM — suficient pentru margini
 *  si obstacole de rutare. Glifele de adnotare (const/select/concat) adauga
 *  o alocare fixa peste text, ca ELK sa lase margine si ruterul sa le rezerve */
function estPinText(pin: {
  netLabel: string | null;
  note: string | null;
  noteKind?: NoteKind | null;
  bus?: boolean;
  width?: number | null;
  mult?: string | null;
}): number {
  const annot = [pin.netLabel, pin.note].filter(Boolean).join(" ");
  // eticheta de latime (ancorata la slash, mx = STUB/2 de la bloc, spre exterior)
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

/** starea de rasturnare a unui nod (docs/04) */
export interface Flip {
  h: boolean;
  v: boolean;
}

/**
 * Layoutul schemei. Fara `seeds`, ELK layered complet (prima deschidere).
 * Cu `seeds` (pozitiile detinute de utilizator, docs/04), ELK ruleaza in
 * mod interactiv: pozitiile date devin semintele layering-ului si ale
 * ordonarii, astfel incat DOAR elementele noi primesc pozitii, inserate in
 * contextul celor existente; apelantul forteaza apoi semintele exact
 * (ELK interactiv le poate deplasa usor).
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
      // latime pe grila: ancora steagului (varful/baza) cade pe grila, ca
      // traseele sa fie integral ortogonale pe grid. Padding-ul (16 = margine
      // + varful de 9px al steagului) e strans dar lasa eticheta sa nu atinga
      // varful; ceilGrid rotunjeste la 8
      width: ceilGrid(measure(b.label, true) + 16),
      height: BPORT_H,
      layoutOptions: {
        // straturi dedicate exclusiv granitei (FIRST/LAST simplu ar amesteca
        // instantele fara muchii de intrare — net-uri etichetate — printre
        // steagurile de porturi)
        "elk.layered.layering.layerConstraint":
          b.side === "WEST" ? "FIRST_SEPARATE" : "LAST_SEPARATE",
      },
    });
  }

  for (const n of scene.nodes) {
    const flip = flips?.get(n.id) ?? { h: false, v: false };
    const west = n.pins.filter((p) => p.side === "WEST");
    const east = n.pins.filter((p) => p.side === "EAST");
    // rasturnarea reatribuie sloturile de pin (docs/04): orizontal schimba
    // laturile intre ele, vertical inverseaza ordinea pe fiecare latura;
    // sloturile de grila si textul raman neschimbate
    let effWest = flip.h ? east : west;
    let effEast = flip.h ? west : east;
    if (flip.v) {
      effWest = [...effWest].reverse();
      effEast = [...effEast].reverse();
    }
    const rows = Math.max(effWest.length, effEast.length, 1);
    const height = 56 + PIN_PITCH * (rows - 1); // 56, 72, ... (grila 8)
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
      y: PIN_TOP + i * PIN_PITCH - 4, // centrul la PIN_TOP + i*PIN_PITCH
    });
    // textele exterioare (etichete de net, adnotari) intra ca margini in
    // layout: ELK lasa loc pentru ele intre straturi, altfel canalele
    // proaspete raman prea stramte pentru rutare
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
      // fara separare pe componente conexe: porturile de granita fara muchii
      // (net-uri etichetate) trebuie sa respecte tot FIRST/LAST, nu sa fie
      // impachetate separat
      "elk.separateConnectedComponents": "false",
      // cu seminte: mod interactiv (docs/04) — pozitiile date ordoneaza
      // straturile si randurile, doar elementele noi primesc pozitii.
      // cycleBreaking ramane implicit: varianta INTERACTIVE inverseaza
      // muchii dupa pozitii si intra in conflict cu LAST_SEPARATE pe
      // steagurile granitei (directiile muchiilor noastre sunt oricum
      // fixe semantic, driver -> destinatie)
      ...(seeds?.size
        ? {
            "elk.interactive": "true",
            "elk.layered.layering.strategy": "INTERACTIVE",
            "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
            "elk.layered.nodePlacement.strategy": "INTERACTIVE",
          }
        : { "elk.layered.layering.strategy": "LONGEST_PATH" }),
      // spatieri corelate cu haloul de rutare (16px pe fiecare bloc):
      // intre doua halouri trebuie sa incapa cel putin un culoar de fir
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

// ------------------------------------------------------------------ desen

export interface SchematicHooks {
  /** click pe butonul de pliere/expandare al unui pliaj generate */
  onToggleFold(foldId: string): void;
}

/**
 * Deseneaza scena in viewport si intoarce grupul muchiilor (pentru
 * re-rutarea live in timpul drag-ului). Traseele vin intotdeauna din
 * ruterul propriu (docs/04) — un singur comportament de rutare, cu halou
 * si etichete protejate, indiferent daca vederea are sau nu override-uri;
 * ELK da doar pozitiile nodurilor.
 */
export function drawSchematic(
  scene: SchematicScene,
  layout: ElkNode,
  viewport: SVGGElement,
  hooks: SchematicHooks
): SVGGElement {
  const nodeById = new Map(scene.nodes.map((n) => [n.id, n]));
  const bportById = new Map(scene.boundary.map((b) => [b.id, b]));

  // muchiile primele, ca nodurile sa se deseneze peste trasee
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

// ------------------------------------------------------------------ muchii

function edgeElement(spec: SceneEdge, d: string): SVGGElement {
  // gradare pe clasa de latime: firul de bus e cu atat mai gros (docs/04)
  const g = el("g", {
    class: `edge ${spec.kind} ${widthClass(spec.width)}`.trimEnd(),
  });
  // ID stabil pentru selectie: numele net-ului in scope-ul vederii
  if (spec.net) {
    g.dataset.id = spec.net;
  }
  g.append(
    // fara sageata de directie in vederea-schema: sensul e implicit din latura
    // portului (intrari pe vest, iesiri pe est) — decizia utilizatorului. In
    // vederea TB sagetile raman (steagurile disting in/out/inout).
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
  /** directia orizontala in care pinul "iese" din nod (+1 est, -1 vest) */
  dir: 1 | -1;
}

/**
 * Obstacolele ruterului, derivate din scena + layout (PUR, testat in
 * test:router): dreptunghiurile tuturor nodurilor si steagurilor, plus
 * zonele de text din afara blocurilor (etichete de net, adnotari de
 * conexiune) — traseele altor net-uri nu trec peste numele porturilor.
 * Doua capcane reale traiesc aici (docs/04, CLAUDE.md):
 * - inaltimea obstacolului de text = un pas de pin (PIN_PITCH, nu mai mult):
 *   un obstacol mai inalt sangereaza in randul pinului vecin si-i forteaza
 *   firul pe un ocol inutil in scara;
 * - pinii care sunt capete ale unei muchii-fir NU devin obstacole: adnotarea
 *   lor (select `[N]`, concat) sta chiar pe traseul propriului fir, ca
 *   eticheta lui — altfel firul isi ocoleste propria eticheta cu coturi
 *   inutile. Adnotarile pinilor FARA fir (const `=1'b1`, nc, etichete de
 *   net) raman obstacole MOI pentru firele ALTOR net-uri.
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
        continue; // firul propriu coexista cu eticheta pinului
      }
      const w = estPinText(pin);
      if (!w) {
        continue;
      }
      const west =
        (port.x ?? 0) + (port.width ?? 0) / 2 < (child.width ?? 0) / 2;
      const py = (child.y ?? 0) + (port.y ?? 0) + (port.height ?? 0) / 2;
      // obstacol MOALE (cost, nu zid): in canale stramte ruterul trece
      // peste eticheta in loc sa cada pe fallback prin blocuri
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
 * Re-ruteaza toate muchiile dupa pozitiile curente din `layout.children`:
 * ruterul A* pe grila (docs/04) ocoleste nodurile, cu fallback naiv in Z
 * per muchie fara drum gasit. Goleste si repopuleaza grupul — apelabila
 * la fiecare pas de drag.
 */
export function routeEdges(
  scene: SchematicScene,
  layout: ElkNode,
  group: SVGGElement
): void {
  group.replaceChildren();
  const childById = new Map((layout.children ?? []).map((c) => [c.id, c]));
  const bportById = new Map(scene.boundary.map((b) => [b.id, b]));
  // pinii cu marcator concat/select: firul se ancoreaza DINCOLO de chip
  // (MARKER_STUB), ca trunchiul sa se lege la stanga marcatorului si stub-ul
  // orizontal sa-l traverseze (cererea utilizatorului)
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
      // steag de granita: vestul iese spre dreapta, estul primeste din stanga
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
    // latura efectiva vine din geometrie (rasturnarile schimba laturile),
    // nu din semantica pinului din scena
    const west = (port.x ?? 0) + (port.width ?? 0) / 2 < cw / 2;
    const out = markerPins.has(portId) ? MARKER_STUB : 0;
    return {
      x: cx + (west ? -out : cw + out),
      y: cy + (port.y ?? 0) + (port.height ?? 0) / 2,
      dir: west ? -1 : 1,
    };
  };

  // obstacolele (noduri + texte de pini): edgeObstacles (pur, testat)
  const obstacles = edgeObstacles(scene, layout);
  const pending: { e: SceneEdge; s: Anchor; t: Anchor }[] = [];
  const requests: RouteRequest[] = [];
  for (const e of scene.edges) {
    const s = anchor(e.source, e.sourcePort);
    const t = anchor(e.target, e.targetPort);
    if (s && t) {
      pending.push({ e, s, t });
      // grupul = net-ul: muchiile aceluiasi net pot imparti trunchiul
      requests.push({ id: e.id, source: s, target: t, group: e.net ?? e.id });
    }
  }
  const routed = route(obstacles, requests);
  const draw = (e: SceneEdge, poly: Pt[]): void => {
    group.append(
      edgeElement(e, "M " + poly.map((p) => `${p.x} ${p.y}`).join(" L "))
    );
  };
  // garda pieptenelui: un segment axial nu are voie sa taie interiorul unui
  // bloc (obstacol HARD, fara cost) — altfel prizele drepte ar trece prin cutii
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
  // grupam muchiile-fir pe net: fan-in-ul unei magistrale se deseneaza ca
  // PIEPTENE (combPolys), nu ca stea care converge in sink (4-way)
  const netPolys = new Map<string, Pt[][]>();
  const byNet = new Map<string, { e: SceneEdge; s: Anchor; t: Anchor }[]>();
  for (const p of pending) {
    if (p.e.kind === "wire" && p.e.net) {
      (byNet.get(p.e.net) ?? byNet.set(p.e.net, []).get(p.e.net)!).push(p);
    } else {
      // interfata / fara net: per-muchie (fara junction dots)
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
  // punctele de jonctiune (T) ale net-urilor cu fanout (docs/04, vocabular)
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
 * Punctele de JONCTIUNE (junction dots) dintr-un set de polilinii grupate pe
 * net (PUR, testat in test:router). Conventia Eeschema: un punct DOAR unde
 * un net se RAMIFICA in T (trei directii cardinale au fir), niciodata la o
 * simpla incrucisare (patru directii = crossover — poate fi si o suprapunere
 * incidentala a doua ramuri ale ACELUIASI net) sau la un cot (doua directii).
 * Se grupeaza pe net, deci incrucisarile a DOUA net-uri diferite nu produc
 * niciodata punct. Robust la geometrie (nu presupune grila): pentru fiecare
 * varf al netului numara directiile cardinale distincte in care pleaca un
 * segment al netului; T = exact 3.
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
        // axial si nenul (un segment degenerat n-are directie)
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
            dirs.add("N"); // segmentul se intinde spre y mai mic
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
      // >=3 directii la un VARF = jonctiune reala a aceluiasi net (T cu 3, sau
      // contopire 4-way ca la fan-in-ul unei magistrale: 3 fire intr-un port).
      // Incrucisarile periculoase sunt deja excluse: net-uri DIFERITE nu-s in
      // acelasi grup, iar o incrucisare a aceluiasi net fara cot (doua fire
      // drepte) nu are varf la intersectie, deci nu ajunge aici (cererea
      // utilizatorului: puncte la contopirea dout-urilor in ch_out)
      const key = `${v.x},${v.y}`;
      if (dirs.size >= 3 && !seen.has(key)) {
        seen.add(key);
        dots.push({ x: v.x, y: v.y });
      }
    }
  }
  return dots;
}

/** Reconstruieste traseele unui net cu FAN (>=2 muchii wire, capete pe randuri
 *  diferite) ca un PIEPTENE: un trunchi vertical la `trunkX` (x-ul vertical
 *  dominant din rutarea A*, deci ocoleste obstacolele) + o priza orizontala per
 *  capat. Inlocuieste STEAUA care converge in sink (toate muchiile spre acelasi
 *  punct = 4-way) cu prize SEPARATE: fiecare capat atinge trunchiul la randul
 *  lui, iar sink-ul la randul lui (la capatul trunchiului cand e dincolo de
 *  surse -> jonctiuni curate in T, cererea utilizatorului). Intoarce null cand
 *  nu se aplica (sub 3 capete / toate pe un rand / fara verticala) -> ramane
 *  rutarea per-muchie. Pur, testat in test:router. */
export function combPolys(ends: Pt[], routed: Pt[][]): Pt[][] | null {
  if (ends.length < 3) {
    return null; // nevoie de >=2 surse + 1 sink
  }
  // trunkX = x-ul cu cea mai mare lungime verticala totala din rutare (spina)
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
    return null; // nicio verticala -> nu e trunchi vertical
  }
  const ys = ends.map((e) => e.y);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  if (y0 === y1) {
    return null; // toate capetele pe un rand
  }
  // spina = priza de sus -> trunchi -> priza de jos, ca O SINGURA polilinie:
  // colturile de capat au jonctiune (miter), nu doua capete butt separate care
  // lasa un gol la imbinare (observatia utilizatorului). Prizele INTERIOARE
  // raman separate — ating LATURA groasa a trunchiului (T), acoperite de el.
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

/** surplusul (px diagrama) cu care ghidajul depaseste porturile potrivite */
export const ALIGN_GUIDE_PAD = 24;
export interface AlignPt {
  x: number;
  y: number;
}
export interface AlignSnap {
  /** deplasarea pe X/Y care aliniaza EXACT portul tras (0 fara potrivire) */
  dx: number;
  dy: number;
  /** linia de ghidaj verticala/orizontala la aliniere (null fara potrivire) */
  vLine: { x: number; y0: number; y1: number } | null;
  hLine: { y: number; x0: number; x1: number } | null;
}

/** Ghidaje de aliniere la drag pe POZITIILE PORTURILOR (cererea utilizatorului):
 *  pentru porturile blocului TRAS `dragged` (deja mutate la pozitia bruta),
 *  cauta pe fiecare axa cea mai apropiata potrivire (in `threshold`) cu un port
 *  al altui bloc din `others`. Alinierea la PORTURI, nu la marginile blocului,
 *  tine firele drepte: doua porturi la acelasi y => fir orizontal. Intoarce
 *  deplasarea care aliniaza exact + linia de ghidaj de la portul tras la cel
 *  potrivit; 0/null pe axa fara potrivire (acolo apelantul cade pe snap-ul de
 *  grila). Pur, testat in test:router. */
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
  // ghidajul se intinde de la portul tras la cel potrivit, cu un mic surplus
  // (ALIGN_GUIDE_PAD) pe fiecare capat: ramane vizibil chiar cand cele doua
  // porturi coincid pe axa (aceeasi coloana / acelasi rand)
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

/** Offseturile CAPETELOR de pini (varfurile stub-urilor, unde se leaga firele
 *  si stau marcajele `{}`/`[]`), relativ la originea fiecarui nod — punctele de
 *  aliniere corecte (cererea utilizatorului): ghidajele verticale trec prin
 *  capetele pinilor, nu prin marginile blocului. Capatul e la `-stubLen` pe
 *  vest / `cw+stubLen` pe est, cu `stubLen = MARKER_STUB` pentru pinii cu
 *  marcator concat/select (firul se leaga dincolo de chip), altfel `STUB`.
 *  Latura vine din GEOMETRIE (ca ancora din routeEdges), deci rasturnarile o
 *  urmeaza. Pur, testat in test:router. */
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

/** traseu ortogonal in Z; la directii nefavorabile, ocol in S prin mijloc */
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

/** port al modulului vederii: steag pentagonal cu numele inauntru */
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
  // latimea busului + `×M` unpacked, deasupra steagului (fara `/` — slash-ul
  // e deja marcajul de bus; steagul e element de sine statator, deci centrat)
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
    // teanc: doua umbre decalate sugereaza instantele pliate
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
    // latura efectiva vine din geometrie: rasturnarile schimba laturile
    const west = (port.x ?? 0) + (port.width ?? 0) / 2 < w / 2;
    g.append(drawPin(spec, n, w, py, west));
  }

  // butonul de pliere/expandare (docs/05: pliate implicit, expandabile)
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
  // xOut = capatul stub-ului pentru pozitionarea chip-ului/adnotarii (STUB fix);
  // stub-ul VIZIBIL se extinde la MARKER_STUB pentru pinii cu marcator, ca firul
  // sa se lege dincolo de chip (vezi MARKER_STUB) si sa-l traverseze orizontal
  const isMarker =
    spec.noteKind === "select" || spec.noteKind === "concat";
  const xOut = west ? -STUB : nodeW + STUB;
  const stubOut = isMarker ? (west ? -MARKER_STUB : nodeW + MARKER_STUB) : xOut;
  const mx = (x0 + xOut) / 2;

  const g = el("g", {
    class: `pin${spec.iface ? " iface" : ""} ${widthClass(spec.width)}`.trimEnd(),
  });
  g.dataset.id = spec.id;
  g.dataset.port = spec.port;
  if (node.instPath) {
    g.dataset.inst = node.instPath;
  }

  if (isMarker) {
    // concat/select marker pin: the stub no longer PIERCES the chip (the old
    // "the pin sticks out visibly through the rectangle" request is SUPERSEDED —
    // on a wide bus the stub is thick and looks like a wire passing through
    // `{}`/`[]`). It is drawn as TWO segments touching the chip's faces, so
    // nothing crosses it: block -> block-side face, and tip-side face -> tip
    // (where the wire anchors, like the label in show-as-label). The faces come
    // from drawAnnotation's geometry: inner = xOut + out*GAP, outer = inner + out*CW.
    const out = west ? -1 : 1;
    const chipInner = xOut + out * MARKER_GAP;
    const chipOuter = chipInner + out * MARKER_CW;
    g.append(
      el("line", {
        class: "stub",
        x1: String(x0), y1: String(py), x2: String(chipInner), y2: String(py),
      }),
      el("line", {
        class: "stub",
        x1: String(chipOuter), y1: String(py), x2: String(stubOut), y2: String(py),
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
    // busul: slash + eticheta `/N` (netlistsvg); gradarea pe latime vine din
    // clasa w-* de pe grupul pinului
    g.append(
      el("line", {
        class: "bus-slash",
        x1: String(mx - 3), y1: String(py + 4),
        x2: String(mx + 3), y2: String(py - 4),
      })
    );
  }
  // eticheta de latime deasupra stub-ului (py-6): latimea busului + `×M`
  // unpacked (ex. `16×3`). ANCORATA la marcajul slash (mx), spre EXTERIOR
  // (anchor pe latura), NU centrata — altfel taia frontiera blocului pe stub-ul
  // scurt (observatie la validare). FARA `/`: slash-ul de pe fir e deja
  // marcajul de bus, deci `/16` ar dubla slash-ul. Marginea e rezervata in
  // estPinText (eticheta iese dincolo de stub la valori late)
  const wtxt = (spec.bus && spec.width ? `${spec.width}` : "") + (spec.mult ?? "");
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
  for (const a of drawAnnotation(spec, xOut, py, west)) {
    g.append(a);
  }
  if (spec.netLabel) {
    // net shown as a label, not as a routed wire (level 4, docs/04); a single
    // net's label is selectable (click -> the inspector's Net section, with the
    // wire/label toggle).
    // On a split/join marker pin (concat/select) the label anchors at the TIP of
    // the extended stub (stubOut = MARKER_STUB), BEYOND the chip — otherwise it
    // overlapped `{}`/`[]` (the chip sits at xOut+MARKER_GAP; user request: the
    // name at the extended port boundary, not on top of the marker). Without a
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
