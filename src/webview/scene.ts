// Construirea scenei vederii-schema (docs/05): functii pure, fara DOM,
// testabile in Node (scripts/test-scene.mjs). Consuma modelul de proiect
// (docs/02) si produce noduri, porturi de granita si muchii gata de layout.
//
// Politicile de vedere care NU sunt in model (docs/02) se aplica aici:
// - plierea instantelor generate cu acelasi modul+parametri (`g_ch[0..2].u_ch`),
//   cu notatia `nume[lo..hi]` din docs/04;
// - maparea net -> muchii sursa->destinatie, cu dedup pe pliaje;
// - net-urile `render=label` si net-urile wire fara doua capete desenabile
//   devin etichete pe pini, nu trasee.

import type { Conn, Dir, ModuleDef, ProjectModel } from "../model";
import { netWidth } from "../probe";

export type SceneNodeKind =
  | "instance"
  | "iface"
  | "fold"
  // nodurile vederii de verificare (faza 3b, docs/05; scena in tbscene.ts)
  | "tbdut"
  | "tbagent"
  | "tbsb"
  | "tbcov"
  | "tbvsqr"
  | "tbprobe"
  | "tbsubenv"
  // containere (containment UVM canonic): Testbench, Env, si internele
  // agentului (sequencer/driver/monitor)
  | "tbtb"
  | "tbenv"
  | "tbunit";

export interface ScenePin {
  /** ID stabil relativ la vedere: `u_add.din`, `g_ch[0..2].u_ch.din` */
  id: string;
  port: string;
  dir: Dir;
  side: "WEST" | "EAST";
  iface: boolean;
  bus: boolean;
  /** latimea semnalului (elem_width ?? width); null la interfete. Feed pentru
   *  eticheta slash `/N` si gradarea vizuala pe clase de latime (docs/04) */
  width: number | null;
  mult: string | null;
  label: string;
  /** numele net-urilor afisate ca eticheta la capatul pinului (sau null) */
  netLabel: string | null;
  /** aceleasi net-uri, masina (netLabel e join de afisare): conectivitatea
   *  pinului prin net-urile cu render=label, care NU au muchii — netCone
   *  traverseaza si prin ele */
  nets: string[];
  /** adnotare scurta a conexiunii: `[1]` select, `=1'b1` const, `nc` flotant */
  note: string | null;
  /** felul adnotarii — ALEGE glifa (const-box, split/join) fara sa reparseze
   *  `note`; null = fara adnotare (docs/04, vocabular) */
  noteKind: NoteKind | null;
  tooltip: string;
}

export interface SceneNode {
  /** ID stabil relativ la vedere: calea relativa sau ID-ul pliajului */
  id: string;
  kind: SceneNodeKind;
  /** numele afisat (calea relativa in vedere) */
  name: string;
  /** subtitlul: modulul cu parametrii efectivi (`chan #(W=16)`) */
  sub: string;
  /** calea ierarhica completa, pentru drill/sursa; null pentru pliaje */
  instPath: string | null;
  /** instanta are schema (dublu-click coboara; altfel sursa) */
  hasView: boolean;
  /** numarul de instante pliate (1 pentru noduri simple) */
  foldCount: number;
  /** ID-ul pliajului din care face parte un membru expandat (re-pliere) */
  foldId: string | null;
  /** caile instantelor membre ale unui pliaj (cross-probing editor->diagrama:
   *  tinta pe un membru aprinde pliajul; docs/05); absent la noduri simple */
  memberPaths?: string[];
  pins: ScenePin[];
  tooltip: string;
}

/** port al modulului vederii, pe granita diagramei */
export interface SceneBPort {
  /** ID stabil: `<port>.din` (docs/02) */
  id: string;
  name: string;
  dir: Dir;
  side: "WEST" | "EAST";
  iface: boolean;
  bus: boolean;
  /** latimea portului vederii (elem_width ?? width); null la interfete */
  width: number | null;
  mult: string | null;
  label: string;
  /** net-urile cu render=label la care participa steagul (fara muchii):
   *  netCone traverseaza prin ele — altfel un net-eticheta care atinge o
   *  granita si-ar pierde capatul de granita din con */
  nets: string[];
  tooltip: string;
}

export interface SceneEdge {
  id: string;
  /** numele net-ului (ID stabil in scope-ul vederii); null pentru interfete */
  net: string | null;
  /** latimea netului (derivata prin netWidth — DOAR de la un capat cu acelasi
   *  semnal, niciodata prin select/concat); null cand nederivabila. Gradare
   *  vizuala a firului pe clase de latime (docs/04) */
  width: number | null;
  /** "ref" = referinta punctata (vsqr->sqr, dut->probes; vederea de verificare) */
  kind: "wire" | "iface" | "ref";
  /** ID de nod (nodurile granitei nu au porturi ELK: sourcePort null) */
  source: string;
  sourcePort: string | null;
  target: string;
  targetPort: string | null;
}

export interface SchematicScene {
  viewId: string;
  module: string;
  nodes: SceneNode[];
  boundary: SceneBPort[];
  edges: SceneEdge[];
}

export function hasSchematic(
  model: ProjectModel | undefined,
  viewId: string | undefined
): boolean {
  return Boolean(model && viewId && model.views[viewId]);
}

// ------------------------------------------------------- descrierea conn

/** textul lizibil al unei expresii de conexiune, pentru tooltip-uri */
export function connText(conn: Conn): string {
  if (conn === null) {
    return "unconnected";
  }
  switch (conn.kind) {
    case "net":
      return conn.net;
    case "select":
      return `${connText(conn.base)}[${conn.index ?? conn.text ?? "?"}]`;
    case "concat":
      return `{${conn.parts.map(connText).join(", ")}}`;
    case "const":
      return conn.value;
    case "iface":
      return conn.ref;
    case "expr":
      return conn.text ?? "expression";
  }
}

/** felul adnotarii unui pin — discriminatorul care ALEGE glifa in stratul de
 *  desen (docs/04, vocabular): stratul de desen NU mai adulmeca textul notei */
export type NoteKind =
  | "select"
  | "const"
  | "concat"
  | "nc"
  | "expr"
  | "mixed"; // fold cu conexiuni divergente (`≠`)

/** adnotarea scurta desenata la capatul pinului (docs/02: consecinta vizuala):
 *  textul de afisare + felul (pentru glifa). `kind: null` = fara adnotare */
function noteOf(conn: Conn): { note: string | null; kind: NoteKind | null } {
  if (conn === null) {
    return { note: "nc", kind: "nc" };
  }
  switch (conn.kind) {
    case "net":
    case "iface":
      return { note: null, kind: null };
    case "select":
      return { note: `[${conn.index ?? conn.text ?? "?"}]`, kind: "select" };
    case "const":
      return { note: `=${conn.value}`, kind: "const" };
    case "concat":
      return { note: "{…}", kind: "concat" };
    case "expr":
      return { note: "ƒ(…)", kind: "expr" };
  }
}

/** eticheta unui port in ordinea de declarare SystemVerilog: dimensiunile
 *  packed inaintea numelui (din elem_width), unpacked dupa (din sufixul
 *  `type` de dupa separatorul intern `$`, ca sa pastreze intervalul exact
 *  declarat, ex. `[0:2]`) -> `[15:0]ch_out[0:2]`. Semnal de 1 bit fara
 *  tablou = doar numele. Compact (FARA spatii intre dimensiuni si nume):
 *  lizibilitatea vine din colorarea diferita a dimensiunilor la desen
 *  (`splitLabel` + tspan `.dim`), nu din spatii — economiseste latime. */
export function portLabel(p: {
  name: string;
  type?: string | null;
  elem_width?: number | null;
  width?: number | null;
}): string {
  const elemW = p.elem_width ?? p.width;
  const packed = elemW != null && elemW > 1 ? `[${elemW - 1}:0]` : "";
  const t = p.type ?? "";
  const dollar = t.indexOf("$");
  const unpacked = dollar >= 0 ? t.slice(dollar + 1) : "";
  return `${packed}${p.name}${unpacked}`;
}

/** desparte eticheta compacta a unui port (`[15:0]ch_out[0:2]`) in dimensiunile
 *  packed/unpacked si nume, dupa prima aparitie a numelui — identificatorii SV
 *  nu apar in `[N:0]` (doar cifre / `:` / paranteze), deci despartirea e
 *  neambigua. Pentru colorarea diferentiata a dimensiunilor la desen. */
export function splitLabel(
  label: string,
  name: string
): { packed: string; name: string; unpacked: string } {
  const i = label.indexOf(name);
  if (i < 0) {
    return { packed: "", name: label, unpacked: "" };
  }
  return {
    packed: label.slice(0, i),
    name,
    unpacked: label.slice(i + name.length),
  };
}

// --------------------------------------------------------------- pliaje

interface ChildInfo {
  rel: string;
  module: string;
  params: Record<string, string>;
  instPath: string;
  iface: boolean;
}

/** `g_ch[0].u_ch` -> `g_ch[*].u_ch` (cheia de grupare a pliajului) */
function foldPattern(rel: string): string {
  return rel.replace(/\[\d+\]/g, "[*]");
}

/** indicele primei dimensiuni generate dintr-o cale relativa (sau null) */
function firstIndex(rel: string): number | null {
  const m = /\[(\d+)\]/.exec(rel);
  return m ? Number(m[1]) : null;
}

/** notatia pliajului din docs/04: `g_ch[lo..hi].u_ch` */
function foldId(pattern: string, members: ChildInfo[]): string {
  const idx = members
    .map((m) => firstIndex(m.rel))
    .filter((i): i is number => i !== null)
    .sort((a, b) => a - b);
  const lo = idx[0] ?? 0;
  const hi = idx[idx.length - 1] ?? 0;
  return pattern.replace("[*]", `[${lo}..${hi}]`);
}

function paramText(params: Record<string, string>): string {
  const t = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return t ? ` #(${t})` : "";
}

// ----------------------------------------------------------- construire

/**
 * Construieste scena vederii-schema pentru `viewId`.
 *
 * `expanded` = ID-urile pliajelor desfacute explicit de utilizator; restul
 * grupurilor generate raman pliate implicit (docs/05). Intoarce null daca
 * instanta nu are schema in model.
 */
export function buildSchematicScene(
  model: ProjectModel,
  viewId: string,
  expanded: ReadonlySet<string>,
  renderOverrides?: ReadonlyMap<string, "wire" | "label">
): SchematicScene | null {
  const view = model.views[viewId];
  const parentDef = model.modules[view?.module ?? ""];
  if (!view || !parentDef) {
    return null;
  }
  const instByPath = new Map(model.instances.map((i) => [i.path, i]));

  // -- copiii vederii, in ordinea primei aparitii in pins (ordine stabila)
  const children = new Map<string, ChildInfo>();
  for (const vp of view.pins) {
    const dot = vp.pin.lastIndexOf(".");
    if (dot <= 0 || vp.pin.startsWith("<port>.")) {
      continue;
    }
    const rel = vp.pin.slice(0, dot);
    if (children.has(rel)) {
      continue;
    }
    const inst = instByPath.get(`${viewId}.${rel}`);
    children.set(rel, {
      rel,
      module: inst?.module ?? "?",
      params: inst?.params ?? {},
      instPath: inst?.path ?? `${viewId}.${rel}`,
      iface: Boolean(inst?.iface),
    });
  }

  // -- gruparea pliajelor: acelasi tipar generate + acelasi modul+parametri
  const groups = new Map<string, ChildInfo[]>();
  for (const c of children.values()) {
    const key =
      foldPattern(c.rel) + "|" + c.module + "|" + JSON.stringify(c.params);
    const g = groups.get(key);
    if (g) {
      g.push(c);
    } else {
      groups.set(key, [c]);
    }
  }

  /** rel membru -> ID-ul nodului care il reprezinta in scena */
  const nodeOf = new Map<string, string>();
  const nodes: SceneNode[] = [];
  const conns = new Map(view.pins.map((vp) => [vp.pin, vp.conn]));

  for (const [key, members] of groups) {
    const pattern = key.slice(0, key.indexOf("|"));
    const foldable = pattern.includes("[*]") && members.length > 1;
    const fid = foldable ? foldId(pattern, members) : null;
    if (foldable && fid && !expanded.has(fid)) {
      members.forEach((m) => nodeOf.set(m.rel, fid));
      nodes.push(makeFoldNode(model, fid, members, conns));
    } else {
      for (const m of members) {
        nodeOf.set(m.rel, m.rel);
        nodes.push(makeInstanceNode(model, m, fid, conns));
      }
    }
  }

  // -- porturile modulului vederii, pe granita
  const boundary: SceneBPort[] = [];
  for (const p of parentDef.ports) {
    const elemW = p.elem_width ?? p.width;
    const bus = elemW !== null && elemW > 1;
    boundary.push({
      id: `<port>.${p.name}`,
      name: p.name,
      dir: p.dir,
      side: p.dir === "in" ? "WEST" : "EAST",
      iface: false,
      bus,
      width: elemW,
      mult: p.unpacked_dims ? `×${p.unpacked_dims.join("×")}` : null,
      label: portLabel(p),
      nets: [],
      tooltip: `${p.name}: ${p.dir} ${(p.type ?? "").replace("$", " ")} — port of module ${view.module}`,
    });
  }
  for (const ip of parentDef.iface_ports) {
    boundary.push({
      id: `<port>.${ip.name}`,
      name: ip.name,
      dir: "inout",
      side: "WEST",
      iface: true,
      bus: false,
      width: null,
      mult: null,
      label: `${ip.name} : ${ip.interface}${ip.modport ? "." + ip.modport : ""}`,
      nets: [],
      tooltip:
        `${ip.name}: interface ${ip.interface}` +
        (ip.modport ? `, modport ${ip.modport}` : "") +
        ` — port of module ${view.module}`,
    });
  }
  const boundaryById = new Map(boundary.map((b) => [b.id, b]));

  // -- net-uri: muchii pentru `wire`, etichete pentru `label`
  const pinById = new Map<string, ScenePin>();
  for (const n of nodes) {
    for (const p of n.pins) {
      pinById.set(p.id, p);
    }
  }
  const dirByPin = new Map<string, Dir>();
  for (const [id, p] of pinById) {
    dirByPin.set(id, p.dir);
  }
  // Pinii instantelor de interfata nu au directie proprie: un semnal de
  // interfata nu e intrinsec intrare/iesire (directia se stabileste per
  // modport, la modulul conectat). Ii orientam dupa rolul in net (sursa ->
  // EST, destinatie -> VEST) ca firul sa iasa spre modul, nu sa ocoleasca
  // blocul pornind pe latura opusa (docs/04).
  const ifacePins = new Set<string>();
  for (const n of nodes) {
    if (n.kind === "iface") {
      for (const p of n.pins) {
        ifacePins.add(p.id);
      }
    }
  }

  interface Endpoint {
    pinId: string;
    node: string;
    port: string | null; // null = nod de granita (fara porturi ELK)
    dir: Dir;
    boundary: boolean;
  }
  const mapEndpoint = (ep: string): Endpoint | null => {
    if (ep.startsWith("<port>.")) {
      const b = boundaryById.get(ep);
      return b
        ? { pinId: ep, node: ep, port: null, dir: b.dir, boundary: true }
        : null;
    }
    const dot = ep.lastIndexOf(".");
    if (dot <= 0) {
      return null;
    }
    const rel = ep.slice(0, dot);
    const port = ep.slice(dot + 1);
    const nodeId = nodeOf.get(rel);
    if (!nodeId) {
      return null;
    }
    const pinId = `${nodeId}.${port}`;
    const dir = dirByPin.get(pinId) ?? "in";
    return { pinId, node: nodeId, port: pinId, dir, boundary: false };
  };

  const edges: SceneEdge[] = [];
  const netLabels = new Map<string, string[]>(); // pinId -> nume de net-uri
  const addLabel = (pinId: string, net: string): void => {
    const l = netLabels.get(pinId);
    if (l) {
      if (!l.includes(net)) {
        l.push(net);
      }
    } else {
      netLabels.set(pinId, [net]);
    }
  };

  for (const net of view.nets) {
    const eps: Endpoint[] = [];
    const seen = new Set<string>();
    for (const raw of net.endpoints) {
      const ep = mapEndpoint(raw);
      if (ep && !seen.has(ep.pinId)) {
        seen.add(ep.pinId);
        eps.push(ep);
      }
    }
    // nivelul 4 (docs/04): override-ul explicit fir/eticheta al
    // utilizatorului bate sugestia din model (render din fan-out)
    const render = renderOverrides?.get(net.name) ?? net.render;
    if (render === "label") {
      for (const ep of eps) {
        if (ep.boundary) {
          // steagul granitei nu poarta eticheta vizibila (E portul), dar
          // netCone are nevoie de apartenenta la net pentru con complet
          const b = boundaryById.get(ep.pinId);
          if (b && !b.nets.includes(net.name)) {
            b.nets.push(net.name);
          }
        } else {
          addLabel(ep.pinId, net.name);
        }
      }
      continue;
    }
    if (eps.length < 2) {
      // net wire fara doua capete desenabile: degradare la eticheta
      if (eps.length === 1 && !eps[0].boundary) {
        addLabel(eps[0].pinId, net.name);
      }
      continue;
    }
    // surse: porturile de intrare ale modulului si iesirile copiilor —
    // pot fi mai multe (ex. slice-uri asamblate prin select-uri, ch_out);
    // fiecare sursa se leaga de fiecare destinatie, nu sursele intre ele.
    // Fara nicio sursa sau destinatie identificabila (net condus de logica
    // interna a parintelui, respectiv doar iesiri), primul capat tine loc
    // de sursa — muchia tot se deseneaza
    let drivers = eps.filter((e) =>
      e.boundary ? e.dir === "in" : e.dir === "out"
    );
    let sinks = eps.filter((e) => !drivers.includes(e));
    if (drivers.length === 0 || sinks.length === 0) {
      // fara sursa/destinatie identificabila: prefera o instanta de interfata
      // drept sursa (semnalele curg din interfata spre modulele conectate),
      // altfel primul capat tine loc de sursa
      const i = eps.findIndex((e) => ifacePins.has(e.pinId));
      const di = drivers.length === 0 && i >= 0 ? i : 0;
      drivers = [eps[di]];
      sinks = eps.filter((_, idx) => idx !== di);
    }
    // orienteaza pinii de interfata dupa rol: sursa spre EST, destinatie spre
    // VEST (ceilalti pini pastreaza latura semantica data de directie)
    for (const d of drivers) {
      if (ifacePins.has(d.pinId)) {
        const dp = pinById.get(d.pinId);
        if (dp) {
          dp.side = "EAST";
        }
      }
    }
    for (const s of sinks) {
      if (ifacePins.has(s.pinId)) {
        const sp = pinById.get(s.pinId);
        if (sp) {
          sp.side = "WEST";
        }
      }
    }
    // latimea netului: derivata O DATA per net (netWidth din probe.ts — DOAR
    // de la un capat cu acelasi semnal, niciodata prin select/concat), pentru
    // gradarea vizuala a firului pe clase de latime (docs/04)
    const nw = netWidth(model, viewId, net.name).width;
    for (const d of drivers) {
      for (const s of sinks) {
        edges.push({
          id: `${net.name}:${d.pinId}->${s.pinId}`,
          net: net.name,
          width: nw,
          kind: "wire",
          source: d.node,
          sourcePort: d.port,
          target: s.node,
          targetPort: s.port,
        });
      }
    }
  }

  // -- conexiunile de interfata: muchii nod-interfata -> pin (conn.kind=iface)
  const ifaceSeen = new Set<string>();
  for (const vp of view.pins) {
    if (vp.conn === null || typeof vp.conn !== "object" || vp.conn.kind !== "iface") {
      continue;
    }
    const target = mapEndpoint(vp.pin);
    const source = resolveIfaceRef(vp.conn.ref, nodeOf, boundaryById);
    if (!target || !source) {
      continue;
    }
    const id = `iface:${source}->${target.pinId}`;
    if (ifaceSeen.has(id)) {
      continue; // membrii unui pliaj converg pe aceeasi muchie
    }
    ifaceSeen.add(id);
    edges.push({
      id,
      net: null,
      width: null,
      kind: "iface",
      source,
      sourcePort: null,
      target: target.node,
      targetPort: target.port,
    });
  }

  // -- etichetele de net calculate mai sus se aseaza pe pini
  for (const [pinId, nets] of netLabels) {
    const pin = pinById.get(pinId);
    if (pin) {
      pin.netLabel = nets.join(", ");
      pin.nets = nets;
    }
  }

  return { viewId, module: view.module, nodes, boundary, edges };
}

// --------------------------------------------------- conul de conectivitate

/** samanta conului: un net (click pe fir/eticheta) sau un nod/steag */
export type ConeSeed = { net: string } | { node: string };

/**
 * Conul de conectivitate al unei seminte, in directia datelor: `down` (aval)
 * = tot ce e CONDUS, tranzitiv, de samanta; `up` (amonte) = tot ce o conduce.
 * Intoarce id-urile de selectat: noduri/steaguri + nume de net-uri.
 * Traversarea urmeaza exact ce e DESENAT: muchiile wire (sursa=driver) si
 * iface (fara directie clara — se traverseaza in ambele sensuri), plus
 * net-urile cu render=label prin `pin.nets` si `bport.nets` (etichetele nu au
 * muchii; pe pinii copiilor doar `out` conduce, iar la steagurile de granita
 * regula e INVERSA — portul de INTRARE al vederii conduce net-ul in interior).
 * Graful e cel al scenei, deci pliajele generate sunt un singur nod, ca pe
 * ecran, iar steagurile de granita sunt seminte si tinte valide.
 */
export function netCone(
  scene: SchematicScene,
  seed: ConeSeed,
  dir: "up" | "down"
): Set<string> {
  const add = (m: Map<string, Set<string>>, k: string, v: string): void => {
    const s = m.get(k);
    if (s) {
      s.add(v);
    } else {
      m.set(k, new Set([v]));
    }
  };
  const netSinks = new Map<string, Set<string>>(); // net -> noduri conduse
  const netDrivers = new Map<string, Set<string>>(); // net -> noduri sursa
  const nodeOut = new Map<string, Set<string>>(); // nod -> net-uri conduse
  const nodeIn = new Map<string, Set<string>>(); // nod -> net-uri primite
  const direct = new Map<string, Set<string>>(); // iface: nod -> nod (aval)
  const directRev = new Map<string, Set<string>>();

  for (const e of scene.edges) {
    if (e.kind === "iface" || !e.net) {
      // interfetele nu au directie intrinseca: conul trece in ambele sensuri
      add(direct, e.source, e.target);
      add(directRev, e.target, e.source);
      add(direct, e.target, e.source);
      add(directRev, e.source, e.target);
      continue;
    }
    add(netDrivers, e.net, e.source);
    add(nodeOut, e.source, e.net);
    add(netSinks, e.net, e.target);
    add(nodeIn, e.target, e.net);
  }
  for (const n of scene.nodes) {
    for (const p of n.pins) {
      for (const net of p.nets) {
        // aceeasi regula ca la muchii: pe pinii copiilor doar `out` conduce
        if (p.dir === "out") {
          add(netDrivers, net, n.id);
          add(nodeOut, n.id, net);
        } else {
          add(netSinks, net, n.id);
          add(nodeIn, n.id, net);
        }
      }
    }
  }
  // steagurile de granita pe net-uri etichetate (fara muchii): regula INVERSA
  // fata de pinii copiilor — un port de INTRARE al vederii conduce net-ul in
  // interior (sursa), unul de IESIRE il primeste (ca la muchii, docs/scene)
  for (const b of scene.boundary) {
    for (const net of b.nets) {
      if (b.dir === "in") {
        add(netDrivers, net, b.id);
        add(nodeOut, b.id, net);
      } else {
        add(netSinks, net, b.id);
        add(nodeIn, b.id, net);
      }
    }
  }

  return coneWalk(seed, dir, {
    nodeOut, nodeIn, netSinks, netDrivers, direct, directRev,
  });
}

interface ConeMaps {
  nodeOut: Map<string, Set<string>>;
  nodeIn: Map<string, Set<string>>;
  netSinks: Map<string, Set<string>>;
  netDrivers: Map<string, Set<string>>;
  direct: Map<string, Set<string>>;
  directRev: Map<string, Set<string>>;
}

function coneWalk(seed: ConeSeed, dir: "up" | "down", m: ConeMaps): Set<string> {
  const out = new Set<string>();
  const nets: string[] = [];
  const nodes: string[] = [];
  if ("net" in seed) {
    nets.push(seed.net);
  } else {
    nodes.push(seed.node);
  }
  const nextNets = dir === "down" ? m.nodeOut : m.nodeIn;
  const nextNodes = dir === "down" ? m.netSinks : m.netDrivers;
  const nextDirect = dir === "down" ? m.direct : m.directRev;
  while (nets.length || nodes.length) {
    const net = nets.pop();
    if (net !== undefined && !out.has(net)) {
      out.add(net);
      for (const v of nextNodes.get(net) ?? []) {
        nodes.push(v);
      }
    }
    const node = nodes.pop();
    if (node !== undefined && !out.has(node)) {
      out.add(node);
      for (const v of nextNets.get(node) ?? []) {
        nets.push(v);
      }
      for (const v of nextDirect.get(node) ?? []) {
        nodes.push(v);
      }
    }
  }
  return out;
}

/**
 * Conul pornit de la un `data-id` din diagrama (Shift+click): clasifica id-ul
 * si intoarce selectia, sau `null` daca nu se recunoaste (apelantul NU atinge
 * selectia atunci). Grupul unui pin poarta data-id = id-ul pinului, iar
 * copiii lui (numele portului, stub-ul, adnotarea, eticheta multi-net) nu au
 * data-id propriu — un click pe ei cade pe pin: se porneste din net-urile
 * pinului (eticheta ori fir), nu se transforma intr-un net inexistent.
 */
export function coneOf(
  scene: SchematicScene,
  id: string,
  dir: "up" | "down"
): Set<string> | null {
  if (
    scene.nodes.some((n) => n.id === id) ||
    scene.boundary.some((b) => b.id === id)
  ) {
    return netCone(scene, { node: id }, dir);
  }
  // nume de net: firele si etichetele mono-net poarta numele netului ca data-id
  const isNet =
    scene.edges.some((e) => e.net === id) ||
    scene.nodes.some((n) => n.pins.some((p) => p.nets.includes(id))) ||
    scene.boundary.some((b) => b.nets.includes(id));
  if (isNet) {
    return netCone(scene, { net: id }, dir);
  }
  // pin: net-urile lui vin din eticheta (pin.nets) SAU din muchii (fir);
  // conul e reuniunea; fara net identificabil, nodul proprietar tine loc
  for (const n of scene.nodes) {
    const pin = n.pins.find((p) => p.id === id);
    if (!pin) {
      continue;
    }
    const nets = new Set(pin.nets);
    for (const e of scene.edges) {
      if (e.net && (e.sourcePort === id || e.targetPort === id)) {
        nets.add(e.net);
      }
    }
    if (nets.size === 0) {
      return netCone(scene, { node: n.id }, dir);
    }
    const out = new Set<string>();
    for (const net of nets) {
      for (const x of netCone(scene, { net }, dir)) {
        out.add(x);
      }
    }
    return out;
  }
  return null;
}

/** rezolva `ref`-ul unei conexiuni de interfata la un nod sau la granita */
function resolveIfaceRef(
  ref: string,
  nodeOf: ReadonlyMap<string, string>,
  boundaryById: ReadonlyMap<string, SceneBPort>
): string | null {
  // intai instantele de interfata din vedere (ref poate purta modportul:
  // `bus_i.slave`), apoi porturile de interfata ale modulului vederii
  for (const [rel, nodeId] of nodeOf) {
    if (ref === rel || ref.startsWith(rel + ".")) {
      return nodeId;
    }
  }
  const name = ref.split(".")[0];
  const bport = boundaryById.get(`<port>.${name}`);
  return bport ? bport.id : null;
}

// ------------------------------------------------------ construirea nodurilor

interface ConnInfo {
  note: string | null;
  kind: NoteKind | null;
  tooltip: string;
}

function buildPinsFor(
  nodeId: string,
  def: ModuleDef | undefined,
  connOf: (port: string) => ConnInfo
): ScenePin[] {
  const pins: ScenePin[] = [];
  for (const p of def?.ports ?? []) {
    const elemW = p.elem_width ?? p.width;
    const bus = elemW !== null && elemW > 1;
    const c = connOf(p.name);
    pins.push({
      id: `${nodeId}.${p.name}`,
      port: p.name,
      dir: p.dir,
      side: p.dir === "in" ? "WEST" : "EAST",
      iface: false,
      bus,
      width: elemW,
      mult: p.unpacked_dims ? `×${p.unpacked_dims.join("×")}` : null,
      label: portLabel(p),
      netLabel: null,
      nets: [],
      note: c.note,
      noteKind: c.kind,
      tooltip: `${p.name}: ${p.dir} ${(p.type ?? "").replace("$", " ")}${c.tooltip}`,
    });
  }
  for (const ip of def?.iface_ports ?? []) {
    const c = connOf(ip.name);
    pins.push({
      id: `${nodeId}.${ip.name}`,
      port: ip.name,
      dir: "inout",
      side: "WEST",
      iface: true,
      bus: false,
      width: null,
      mult: null,
      label: ip.name,
      netLabel: null,
      nets: [],
      note: c.note,
      noteKind: c.kind,
      tooltip:
        `${ip.name}: interface ${ip.interface}` +
        (ip.modport ? `.${ip.modport}` : "") +
        c.tooltip,
    });
  }
  return pins;
}

function makeInstanceNode(
  model: ProjectModel,
  c: ChildInfo,
  fid: string | null,
  conns: ReadonlyMap<string, Conn>
): SceneNode {
  const def = model.modules[c.module];
  const sub = c.module + paramText(c.params);
  const connOf = (port: string): ConnInfo => {
    const conn = conns.get(`${c.rel}.${port}`);
    if (conn === undefined) {
      return { note: null, kind: null, tooltip: "" };
    }
    return { ...noteOf(conn), tooltip: `\nconnection: ${connText(conn)}` };
  };
  return {
    id: c.rel,
    kind: c.iface ? "iface" : "instance",
    name: c.rel,
    sub,
    instPath: c.instPath,
    hasView: Boolean(model.views[c.instPath]),
    foldCount: 1,
    foldId: fid,
    pins: buildPinsFor(c.rel, def, connOf),
    tooltip: `${c.instPath} — ${sub}`,
  };
}

function makeFoldNode(
  model: ProjectModel,
  fid: string,
  members: ChildInfo[],
  conns: ReadonlyMap<string, Conn>
): SceneNode {
  const first = members[0];
  const def = model.modules[first.module];
  const sub = first.module + paramText(first.params);
  const connOf = (port: string): ConnInfo => {
    const list = members.map((m) => conns.get(`${m.rel}.${port}`));
    if (list.every((c) => c === undefined)) {
      return { note: null, kind: null, tooltip: "" };
    }
    // selecturi pe acelasi net de baza -> interval agregat `[lo..hi]`
    const idx = list.map((c) =>
      c && typeof c === "object" && c.kind === "select" && c.index !== null
        ? Number(c.index)
        : null
    );
    if (idx.every((i) => i !== null && Number.isFinite(i))) {
      const sorted = [...(idx as number[])].sort((a, b) => a - b);
      const first0 = list[0];
      const base =
        first0 && typeof first0 === "object" && first0.kind === "select"
          ? connText(first0.base)
          : "";
      return {
        note: `[${sorted[0]}..${sorted[sorted.length - 1]}]`,
        kind: "select",
        tooltip: `\nconnections: ${base}[${sorted[0]}]…[${sorted[sorted.length - 1]}]`,
      };
    }
    const texts = [...new Set(list.map((c) => connText(c ?? null)))];
    if (texts.length === 1) {
      return {
        ...noteOf(list[0] ?? null),
        tooltip: `\nconnection: ${texts[0]}`,
      };
    }
    return {
      note: "≠",
      kind: "mixed",
      tooltip: `\ndiffering connections: ${texts.join(" / ")}`,
    };
  };
  return {
    id: fid,
    kind: "fold",
    name: fid,
    sub,
    instPath: null,
    hasView: false,
    foldCount: members.length,
    foldId: null,
    memberPaths: members.map((m) => m.instPath),
    pins: buildPinsFor(fid, def, connOf),
    tooltip:
      `${members.length} instances of ${sub}:\n` +
      members.map((m) => m.instPath).join("\n"),
  };
}
