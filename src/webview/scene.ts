// Building the schematic-view scene (docs/05): pure functions, no DOM,
// testable in Node (scripts/test-scene.mjs). Consumes the project model
// (docs/02) and produces nodes, boundary ports and edges ready for layout.
//
// The view policies that are NOT in the model (docs/02) apply here:
// - folding generated instances with the same module+params (`g_ch[0..2].u_ch`),
//   with the `name[lo..hi]` notation from docs/04;
// - mapping net -> source->destination edges, with dedup on folds;
// - `render=label` nets and wire nets without two drawable endpoints
//   become labels on pins, not routes.

import type { Conn, Dir, ModuleDef, ProjectModel } from "../model";
import { netWidth } from "../probe";

export type SceneNodeKind =
  | "instance"
  | "iface"
  | "fold"
  // the verification-view nodes (phase 3b, docs/05; scene in tbscene.ts)
  | "tbdut"
  | "tbagent"
  | "tbsb"
  | "tbcov"
  | "tbvsqr"
  | "tbprobe"
  | "tbsubenv"
  // containers (canonical UVM containment): Testbench, Env, and the agent's
  // internals (sequencer/driver/monitor)
  | "tbtb"
  | "tbenv"
  | "tbunit";

export interface ScenePin {
  /** stable ID relative to the view: `u_add.din`, `g_ch[0..2].u_ch.din` */
  id: string;
  port: string;
  dir: Dir;
  side: "WEST" | "EAST";
  iface: boolean;
  bus: boolean;
  /** the signal width (elem_width ?? width); null for interfaces. Feed for
   *  the slash `/N` label and the visual grading by width classes (docs/04) */
  width: number | null;
  mult: string | null;
  label: string;
  /** the names of the nets shown as a label at the pin's end (or null) */
  netLabel: string | null;
  /** the same nets, machine-readable (netLabel is a display join): the pin's
   *  connectivity through the render=label nets, which have NO edges — netCone
   *  traverses through them too */
  nets: string[];
  /** short annotation of the connection: `[1]` select, `=1'b1` const, `nc` floating */
  note: string | null;
  /** the kind of annotation — CHOOSES the glyph (const-box, split/join) without
   *  re-parsing `note`; null = no annotation (docs/04, vocabulary) */
  noteKind: NoteKind | null;
  tooltip: string;
}

export interface SceneNode {
  /** stable ID relative to the view: the relative path or the fold's ID */
  id: string;
  kind: SceneNodeKind;
  /** the displayed name (the relative path in the view) */
  name: string;
  /** the subtitle: the module with its effective params (`chan #(W=16)`) */
  sub: string;
  /** the full hierarchical path, for drill/source; null for folds */
  instPath: string | null;
  /** the instance has a schematic (double-click descends; otherwise source) */
  hasView: boolean;
  /** the number of folded instances (1 for simple nodes) */
  foldCount: number;
  /** the ID of the fold an expanded member is part of (re-folding) */
  foldId: string | null;
  /** the paths of a fold's member instances (cross-probing editor->diagram:
   *  targeting a member lights up the fold; docs/05); absent for simple nodes */
  memberPaths?: string[];
  pins: ScenePin[];
  tooltip: string;
}

/** port of the view's module, on the diagram's boundary */
export interface SceneBPort {
  /** stable ID: `<port>.din` (docs/02) */
  id: string;
  name: string;
  dir: Dir;
  side: "WEST" | "EAST";
  iface: boolean;
  bus: boolean;
  /** the width of the view's port (elem_width ?? width); null for interfaces */
  width: number | null;
  mult: string | null;
  label: string;
  /** the render=label nets the flag participates in (without edges):
   *  netCone traverses through them — otherwise a label-net that touches a
   *  boundary would lose its boundary end from the cone */
  nets: string[];
  tooltip: string;
}

export interface SceneEdge {
  id: string;
  /** the net's name (stable ID in the view's scope); null for interfaces */
  net: string | null;
  /** the net's width (derived via netWidth — ONLY from an endpoint with the same
   *  signal, never through select/concat); null when not derivable. Visual
   *  grading of the wire by width classes (docs/04) */
  width: number | null;
  /** "ref" = dotted reference (vsqr->sqr, dut->probes; the verification view) */
  kind: "wire" | "iface" | "ref";
  /** node ID (the boundary nodes have no ELK ports: sourcePort null) */
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

// ------------------------------------------------------- conn description

/** the readable text of a connection expression, for tooltips */
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

/** the kind of a pin's annotation — the discriminator that CHOOSES the glyph in
 *  the drawing layer (docs/04, vocabulary): the drawing layer NO longer sniffs the note text */
export type NoteKind =
  | "select"
  | "const"
  | "concat"
  | "nc"
  | "expr"
  | "mixed"; // fold with divergent connections (`≠`)

/** the short annotation drawn at the pin's end (docs/02: visual consequence):
 *  the display text + the kind (for the glyph). `kind: null` = no annotation */
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

/** a port's label in SystemVerilog declaration order: the packed
 *  dimensions before the name (from elem_width), unpacked after (from the
 *  `type` suffix after the internal `$` separator, so it keeps the exact
 *  declared interval, e.g. `[0:2]`) -> `[15:0]ch_out[0:2]`. A 1-bit signal without
 *  an array = just the name. Compact (WITHOUT spaces between dimensions and name):
 *  readability comes from coloring the dimensions differently at draw time
 *  (`splitLabel` + tspan `.dim`), not from spaces — it saves width. */
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

/** splits a port's compact label (`[15:0]ch_out[0:2]`) into the packed/unpacked
 *  dimensions and name, after the first occurrence of the name — SV identifiers
 *  do not appear in `[N:0]` (only digits / `:` / brackets), so the split is
 *  unambiguous. For coloring the dimensions differently at draw time. */
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

// --------------------------------------------------------------- folds

interface ChildInfo {
  rel: string;
  module: string;
  params: Record<string, string>;
  instPath: string;
  iface: boolean;
}

/** `g_ch[0].u_ch` -> `g_ch[*].u_ch` (the fold's grouping key) */
function foldPattern(rel: string): string {
  return rel.replace(/\[\d+\]/g, "[*]");
}

/** the index of the first generated dimension in a relative path (or null) */
function firstIndex(rel: string): number | null {
  const m = /\[(\d+)\]/.exec(rel);
  return m ? Number(m[1]) : null;
}

/** the fold notation from docs/04: `g_ch[lo..hi].u_ch` */
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

// ----------------------------------------------------------- build

/**
 * Builds the schematic-view scene for `viewId`.
 *
 * `expanded` = the IDs of the folds explicitly unfolded by the user; the rest
 * of the generated groups stay folded implicitly (docs/05). Returns null if
 * the instance has no schematic in the model.
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

  // -- the view's children, in order of first appearance in pins (stable order)
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

  // -- grouping the folds: same generate pattern + same module+params
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

  /** member rel -> the ID of the node representing it in the scene */
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

  // -- the view's module ports, on the boundary
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

  // -- nets: edges for `wire`, labels for `label`
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
  // The pins of interface instances have no direction of their own: an
  // interface signal is not intrinsically input/output (the direction is set per
  // modport, at the connected module). We orient them by their role in the net
  // (source -> EAST, destination -> WEST) so the wire exits toward the module,
  // not around the block starting on the opposite side (docs/04).
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
    port: string | null; // null = boundary node (no ELK ports)
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
  const netLabels = new Map<string, string[]>(); // pinId -> net names
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
    // level 4 (docs/04): the user's explicit wire/label override
    // beats the model's suggestion (render from fan-out)
    const render = renderOverrides?.get(net.name) ?? net.render;
    if (render === "label") {
      for (const ep of eps) {
        if (ep.boundary) {
          // the boundary flag carries no visible label (IT is the port), but
          // netCone needs the net membership for a complete cone
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
      // wire net without two drawable endpoints: degrade to a label
      if (eps.length === 1 && !eps[0].boundary) {
        addLabel(eps[0].pinId, net.name);
      }
      continue;
    }
    // sources: the module's input ports and the children's outputs —
    // there can be several (e.g. slices assembled via selects, ch_out);
    // each source links to each destination, not the sources among themselves.
    // With no identifiable source or destination (a net driven by the parent's
    // internal logic, respectively only outputs), the first endpoint stands in
    // for the source — the edge is drawn anyway
    let drivers = eps.filter((e) =>
      e.boundary ? e.dir === "in" : e.dir === "out"
    );
    let sinks = eps.filter((e) => !drivers.includes(e));
    if (drivers.length === 0 || sinks.length === 0) {
      // with no identifiable source/destination: prefer an interface instance
      // as the source (signals flow from the interface toward the connected modules),
      // otherwise the first endpoint stands in for the source
      const i = eps.findIndex((e) => ifacePins.has(e.pinId));
      const di = drivers.length === 0 && i >= 0 ? i : 0;
      drivers = [eps[di]];
      sinks = eps.filter((_, idx) => idx !== di);
    }
    // orient the interface pins by role: source toward EAST, destination toward
    // WEST (the other pins keep the semantic side given by direction)
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
    // the net's width: derived ONCE per net (netWidth from probe.ts — ONLY
    // from an endpoint with the same signal, never through select/concat), for
    // the visual grading of the wire by width classes (docs/04)
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

  // -- the interface connections: interface-node -> pin edges (conn.kind=iface)
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
      continue; // the members of a fold converge on the same edge
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

  // -- the net labels computed above are placed on the pins
  for (const [pinId, nets] of netLabels) {
    const pin = pinById.get(pinId);
    if (pin) {
      pin.netLabel = nets.join(", ");
      pin.nets = nets;
    }
  }

  return { viewId, module: view.module, nodes, boundary, edges };
}

// --------------------------------------------------- the connectivity cone

/** the cone's seed: a net (click on wire/label) or a node/flag */
export type ConeSeed = { net: string } | { node: string };

/**
 * The connectivity cone of a seed, in the data direction: `down` (downstream)
 * = everything DRIVEN, transitively, by the seed; `up` (upstream) = everything that drives it.
 * Returns the ids to select: nodes/flags + net names.
 * The traversal follows exactly what is DRAWN: the wire edges (source=driver) and
 * iface (no clear direction — traversed in both directions), plus
 * the render=label nets through `pin.nets` and `bport.nets` (labels have no
 * edges; on the children's pins only `out` drives, while at the boundary flags
 * the rule is REVERSED — the view's INPUT port drives the net inward).
 * The graph is the scene's, so the generated folds are a single node, as on
 * screen, and the boundary flags are valid seeds and targets.
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
  const netSinks = new Map<string, Set<string>>(); // net -> driven nodes
  const netDrivers = new Map<string, Set<string>>(); // net -> source nodes
  const nodeOut = new Map<string, Set<string>>(); // node -> driven nets
  const nodeIn = new Map<string, Set<string>>(); // node -> received nets
  const direct = new Map<string, Set<string>>(); // iface: node -> node (downstream)
  const directRev = new Map<string, Set<string>>();

  for (const e of scene.edges) {
    if (e.kind === "iface" || !e.net) {
      // interfaces have no intrinsic direction: the cone passes in both directions
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
        // same rule as for edges: on the children's pins only `out` drives
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
  // the boundary flags on labeled nets (without edges): the REVERSED rule
  // versus the children's pins — the view's INPUT port drives the net
  // inward (source), an OUTPUT one receives it (as for edges, docs/scene)
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
 * The cone started from a `data-id` in the diagram (Shift+click): classifies the id
 * and returns the selection, or `null` if it is not recognized (the caller does NOT touch
 * the selection then). A pin's group carries data-id = the pin's id, while
 * its children (the port name, the stub, the annotation, the multi-net label) have no
 * data-id of their own — a click on them falls onto the pin: it starts from the
 * pin's nets (label or wire), it does not turn into a non-existent net.
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
  // net name: the wires and mono-net labels carry the net's name as data-id
  const isNet =
    scene.edges.some((e) => e.net === id) ||
    scene.nodes.some((n) => n.pins.some((p) => p.nets.includes(id))) ||
    scene.boundary.some((b) => b.nets.includes(id));
  if (isNet) {
    return netCone(scene, { net: id }, dir);
  }
  // pin: its nets come from the label (pin.nets) OR from edges (wire);
  // the cone is the union; with no identifiable net, the owner node stands in
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

/** resolves an interface connection's `ref` to a node or to the boundary */
function resolveIfaceRef(
  ref: string,
  nodeOf: ReadonlyMap<string, string>,
  boundaryById: ReadonlyMap<string, SceneBPort>
): string | null {
  // first the interface instances in the view (ref may carry the modport:
  // `bus_i.slave`), then the interface ports of the view's module
  for (const [rel, nodeId] of nodeOf) {
    if (ref === rel || ref.startsWith(rel + ".")) {
      return nodeId;
    }
  }
  const name = ref.split(".")[0];
  const bport = boundaryById.get(`<port>.${name}`);
  return bport ? bport.id : null;
}

// ------------------------------------------------------ building the nodes

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
    // selects on the same base net -> aggregated interval `[lo..hi]`
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
