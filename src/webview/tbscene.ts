// The verification view's scene (phase 3b — docs/05): pure function QuvmConfig ->
// FLAT PER LEVEL scene, without DOM, testable in Node
// (scripts/test-tbscene.mjs).
//
// Model (the user's decision, Jul. 2026): detailing by levels, like
// Symbol/Schematic at RTL. Each level shows its blocks as UML BOXES
// (stereotype + text compartments with internal structure), interconnected,
// with boundary flags for the connections that cross the level.
// Double-click on a block with structure (`drill`) descends to its level:
//   ""            (testbench)  -> DUT + Env
//   "env"                      -> agents, scoreboards, coverage, vsqr, subenvs, probes
//   "agent:<name>"             -> sequencer / driver / monitor with interconnections
// The subenvs show UML info; their drill (`config:<name>`) asks the host to
// open the child config with the default editor (docs/05).
//
// Fail-soft construction: the YAML entries that reference nonexistent agents are
// drawn as much as possible; the authoritative validation stays in ConfigService.

import { coveredAgent } from "../coverage";
import { isCrossBlockSb } from "../quickuvm";
import type { QuvmConfig, QuvmScoreboard } from "../quickuvm";

// quick-uvm >= 1.0.0: the cross-block scoreboards NO longer have their own key
// `subenv_scoreboards` — they are `analysis.scoreboards` entries with
// qualified endpoints `<subenv>.<agent>`. The local/cross separation decides what is drawn
// as `sb:` (in Env) and what as `xsb:` (at the testbench level).
/** The agents with a coverage collector. An `analysis.coverage` entry is either a
 *  BARE agent name or a RICH `{agent, coverpoints…}` mapping (docs/07 P3b) — reading
 *  the list as strings would label the node `[object Object]`. */
function coveredAgents(config: QuvmConfig): string[] {
  const names = (config.analysis?.coverage ?? [])
    .map((c) => coveredAgent(c))
    .filter((n): n is string => Boolean(n));
  return [...new Set(names)];
}

function subenvNameSet(config: QuvmConfig): Set<string> {
  return new Set(
    (config.subenvs ?? [])
      .map((s) => s.name)
      .filter((n): n is string => Boolean(n))
  );
}
function localSbs(config: QuvmConfig): QuvmScoreboard[] {
  const names = subenvNameSet(config);
  return (config.analysis?.scoreboards ?? []).filter(
    (s) => s.source && !isCrossBlockSb(s, names)
  );
}
function crossSbs(config: QuvmConfig): QuvmScoreboard[] {
  const names = subenvNameSet(config);
  return (config.analysis?.scoreboards ?? []).filter((s) =>
    isCrossBlockSb(s, names)
  );
}
import type { SceneNodeKind } from "./scene";

/** a UML compartment: optional title + text lines */
export interface TbCompartment {
  title?: string;
  items: string[];
}

/** port on a TB block's boundary */
export interface TbPort {
  id: string;
  port: string;
  side: "WEST" | "EAST";
  label: string;
  iface: boolean;
  note: string | null;
}

/** a level's block: UML box with compartments; `drill` = the descent's focus */
export interface TbNode {
  id: string;
  kind: SceneNodeKind;
  label: string;
  stereotype: string | null;
  compartments: TbCompartment[];
  ports: TbPort[];
  /** the level's focus on double-click (block with structure); null = leaf */
  drill: string | null;
  tooltip: string;
}

/** boundary flag: a connection that crosses the level (like `<port>` at RTL) */
export interface TbBoundary {
  id: string;
  label: string;
  side: "WEST" | "EAST";
  iface: boolean;
  note: string | null;
  /** the direction relative to the level, deduced from edges: `in` = only source (the data
   *  ENTERS the diagram), `out` = only target (the data EXITS), `inout` = both
   *  (bidirectional interface). The flag shows it through the tip's orientation. */
  dir?: "in" | "out" | "inout";
}

export interface TbEdge {
  id: string;
  net: string | null;
  kind: "wire" | "iface" | "ref";
  source: string;
  sourcePort: string | null;
  target: string;
  targetPort: string | null;
}

export interface TbScene {
  viewId: string;
  /** the current level: the focus + the crumbs for the breadcrumb */
  focus: string;
  breadcrumb: { label: string; focus: string }[];
  nodes: TbNode[];
  boundary: TbBoundary[];
  edges: TbEdge[];
}

// ------------------------------------------------------------- helpers

function port(
  nodeId: string,
  p: string,
  side: "WEST" | "EAST",
  label: string,
  opts?: { iface?: boolean; note?: string | null }
): TbPort {
  return {
    id: `${nodeId}.${p}`,
    port: p,
    side,
    label,
    iface: opts?.iface ?? false,
    note: opts?.note ?? null,
  };
}

function boundary(
  id: string,
  label: string,
  side: "WEST" | "EAST",
  iface = false,
  note: string | null = null
): TbBoundary {
  return { id, label, side, iface, note };
}

function sbSub(sb: QuvmScoreboard): string {
  const parts: string[] = [sb.match ?? "in_order"];
  if (sb.match_key) {
    parts.push(`key=${sb.match_key}`);
  }
  if (sb.max_latency !== undefined && sb.max_latency !== null) {
    parts.push(`latency≤${sb.max_latency}`);
  }
  return parts.join(" · ");
}

const agentId = (name: string): string => `agent:${name}`;
const subId = (name: string): string => `sub:${name}`;

/** the names of the agents coordinated by virtual sequences (or auto at >=2 active) */
function coordinatedAgents(config: QuvmConfig): Set<string> {
  const agents = (config.agents ?? []).filter((a) => a.name);
  const names = new Set(agents.map((a) => a.name as string));
  const vseqs = (config.virtual_sequences ?? []).filter((v) => v.name);
  const active = agents.filter((a) => a.active !== false);
  const auto =
    vseqs.length === 0 &&
    config.auto_virtual_sequences !== false &&
    active.length >= 2;
  const out = new Set<string>();
  for (const v of vseqs) {
    for (const step of v.body ?? []) {
      if (step.agent && names.has(step.agent)) {
        out.add(step.agent);
      }
    }
  }
  if (auto) {
    for (const a of active) {
      out.add(a.name as string);
    }
  }
  return out;
}

function probeNote(p: NonNullable<QuvmConfig["probes"]>[number]): string | null {
  if (p.real) return "real";
  if (p.enum) return "enum";
  if (p.type) return p.type;
  if (p.packed_dims?.length) return `[${p.packed_dims.join("][")}]`;
  if (p.struct) return "struct";
  return p.width && p.width > 1 ? `[${p.width}]` : null;
}

// ----------------------------------------------------------- construction

/**
 * Builds the FLAT scene of the `focus` level from the QuickUVM configuration.
 * `focus`: "" (testbench top), "env", "agent:<name>". Returns null at a
 * nonexistent level or a configuration with nothing drawable.
 */
export function buildTbScene(
  config: QuvmConfig,
  focus: string,
  configPath: string | null
): TbScene | null {
  const viewId = `tb:${configPath ?? ""}`;
  const agents = (config.agents ?? []).filter((a) => a.name);
  const subenvs = (config.subenvs ?? []).filter((s) => s.name);
  const dutName = config.dut?.name;
  // Draws the DUT when there is a dut.name AND it is verified directly: either a leaf
  // config (without subenvs), or hybrid (has its own agents on top). ATTENTION:
  // the current quick-uvm FORBIDS the hybrid (subenvs + own agents — `generate`
  // refuses it; ConfigService puts a hard diagnostic). The hybrid branch stayed so
  // that we honestly draw an invalid config too (its agents do not silently disappear from
  // the diagram), not because it would be valid. We omit the DUT at PURE subsystems
  // (subenvs without agents), where dut.name is just the packaging container.
  const hasDut =
    Boolean(dutName) && (subenvs.length === 0 || agents.length > 0);
  if (!dutName && agents.length === 0 && subenvs.length === 0) {
    return null;
  }

  let level: { nodes: TbNode[]; boundary: TbBoundary[]; edges: TbEdge[] } | null;
  if (focus === "") {
    level = levelTop(config, hasDut, dutName, agents, subenvs);
  } else if (focus === "env") {
    level = levelEnv(config, hasDut, agents, subenvs);
  } else if (focus.startsWith("agent:")) {
    const name = focus.slice("agent:".length);
    const a = agents.find((x) => x.name === name);
    level = a ? levelAgent(config, name, a.active !== false, hasDut) : null;
  } else {
    level = null;
  }
  if (!level) {
    return null;
  }

  // breadcrumb (progressive disclosure): top > env > agent
  const crumb: { label: string; focus: string }[] = [
    { label: config.project?.name ? `${config.project.name} (tb)` : "Testbench", focus: "" },
  ];
  if (focus === "env" || focus.startsWith("agent:")) {
    crumb.push({ label: "Env", focus: "env" });
  }
  if (focus.startsWith("agent:")) {
    crumb.push({ label: focus.slice("agent:".length), focus });
  }

  // the direction of each boundary flag, deduced from edges (source/target):
  // `in` = the data enters the diagram, `out` = it exits, `inout` = bidirectional
  // interface (e.g. `<if>`: the driver drives it, the monitor samples it)
  for (const b of level.boundary) {
    const isSource = level.edges.some((e) => e.source === b.id);
    const isTarget = level.edges.some((e) => e.target === b.id);
    b.dir =
      isSource && isTarget ? "inout" : isTarget ? "out" : "in";
  }

  return { viewId, focus, breadcrumb: crumb, ...level };
}

/** the testbench level: DUT + Env (Env with drill) */
function levelTop(
  config: QuvmConfig,
  hasDut: boolean,
  dutName: string | undefined,
  agents: NonNullable<QuvmConfig["agents"]>,
  subenvs: NonNullable<QuvmConfig["subenvs"]>
): { nodes: TbNode[]; boundary: TbBoundary[]; edges: TbEdge[] } {
  const nodes: TbNode[] = [];
  const edges: TbEdge[] = [];
  const probes = (config.probes ?? []).filter((p) => p.name);

  // Env: UML box with the listed components + drill
  const analysisItems = [
    ...localSbs(config).map((s) => `${s.name ?? "sbd"} (scoreboard)`),
    ...coveredAgents(config).map((a) => `${a} (coverage)`),
  ];
  const envComp: TbCompartment[] = [];
  if (agents.length) {
    envComp.push({
      title: "agents",
      items: agents.map((a) =>
        `${a.name}${a.active === false ? " (passive)" : ""}`
      ),
    });
  }
  if (subenvs.length) {
    envComp.push({ title: "sub-envs", items: subenvs.map((s) => s.name as string) });
  }
  if (analysisItems.length) {
    envComp.push({ title: "analysis", items: analysisItems });
  }
  const hasEnv =
    agents.length > 0 || subenvs.length > 0 || analysisItems.length > 0;
  const envPorts: TbPort[] = agents.map((a) =>
    port("env", `${a.name}_if`, hasDut ? "WEST" : "EAST", `${a.name}_if`, { iface: true })
  );
  if (probes.length && hasDut && hasEnv) {
    envPorts.push(port("env", "internals", "EAST", "internals"));
  }
  if (hasEnv) {
    nodes.push({
      id: "env",
      kind: "tbenv",
      label: "Env",
      stereotype: "«uvm_env»",
      compartments: envComp,
      ports: envPorts,
      drill: "env",
      tooltip: "verification environment — double-click to open",
    });
  }

  if (hasDut && dutName) {
    const dutPorts: TbPort[] = agents.map((a) =>
      port("dut", `${a.name}_if`, "EAST", `${a.name}_if`, { iface: true })
    );
    if (probes.length && hasEnv) {
      dutPorts.push(port("dut", "internals", "WEST", "internals"));
    }
    nodes.push({
      id: "dut",
      kind: "tbdut",
      label: dutName,
      stereotype: "«DUT»",
      compartments: [
        {
          items: [
            config.dut?.combinational
              ? "combinational"
              : `clock: ${config.dut?.clock ?? "clk"}`,
            ...(config.dut?.reset ? [`reset: ${config.dut.reset}`] : []),
          ],
        },
      ],
      ports: dutPorts,
      drill: null,
      tooltip: "DUT — design under test (hardware)",
    });
    // interface: env <-> dut, per agent
    for (const a of agents) {
      edges.push({
        id: `e:if:${a.name}`,
        net: `${a.name}_if`,
        kind: "iface",
        source: "env",
        sourcePort: `env.${a.name}_if`,
        target: "dut",
        targetPort: `dut.${a.name}_if`,
      });
    }
    if (probes.length && hasEnv) {
      edges.push({
        id: "e:internals",
        net: null,
        kind: "ref",
        source: "dut",
        sourcePort: "dut.internals",
        target: "env",
        targetPort: "env.internals",
      });
    }
  }
  return { nodes, boundary: [], edges };
}

/** the Env level: agents + analysis + vsqr + subenvs + probes; boundary = DUT interface */
function levelEnv(
  config: QuvmConfig,
  hasDut: boolean,
  agents: NonNullable<QuvmConfig["agents"]>,
  subenvs: NonNullable<QuvmConfig["subenvs"]>
): { nodes: TbNode[]; boundary: TbBoundary[]; edges: TbEdge[] } {
  const nodes: TbNode[] = [];
  const edges: TbEdge[] = [];
  const boundaries: TbBoundary[] = [];
  const agentNames = new Set(agents.map((a) => a.name as string));
  const coordinated = coordinatedAgents(config);
  const probes = (config.probes ?? []).filter((p) => p.name);

  // boundaries: interface toward the DUT (EAST) + internals (WEST) if there are probes
  if (hasDut) {
    for (const a of agents) {
      boundaries.push(boundary(`<if>.${a.name}`, `${a.name}_if`, "EAST", true));
    }
    if (probes.length) {
      boundaries.push(boundary("<internals>", "internals", "WEST"));
    }
  }

  // the agents: UML boxes with the internal components listed + drill
  for (const a of agents) {
    const name = a.name as string;
    const id = agentId(name);
    const active = a.active !== false;
    const comp: TbCompartment[] = [
      {
        items: [
          `interface: ${a.interface ?? `${name}_if`}`,
          `item: ${a.sequence_item ?? `${name}_seq_item`}`,
        ],
      },
      {
        title: "components",
        items: active
          ? ["sequencer", "driver", "monitor"]
          : ["monitor"],
      },
    ];
    const ports: TbPort[] = [];
    if (coordinated.has(name) && active) {
      ports.push(port(id, "sqr", "WEST", "sqr"));
    }
    if (hasDut) {
      ports.push(port(id, "if", "EAST", "if", { iface: true }));
      edges.push({
        id: `e:${id}.if`,
        net: `${name}_if`,
        kind: "iface",
        source: id,
        sourcePort: `${id}.if`,
        target: `<if>.${name}`,
        targetPort: null,
      });
    }
    ports.push(port(id, "ap", "EAST", "ap ◆"));
    nodes.push({
      id,
      kind: "tbagent",
      label: name,
      stereotype: active ? "«active agent»" : "«passive agent»",
      compartments: comp,
      ports,
      drill: id,
      tooltip: `${name} — double-click to open the agent`,
    });
  }

  // scoreboards
  const usedSb = new Set<string>();
  for (const sb of localSbs(config)) {
    let id = `sb:${sb.name ?? "sbd"}`;
    for (let n = 2; usedSb.has(id); n++) {
      id = `sb:${sb.name ?? "sbd"}#${n}`;
    }
    usedSb.add(id);
    const ports: TbPort[] = [port(id, "source", "WEST", "source ◆")];
    if (sb.monitor) {
      ports.push(port(id, "monitor", "WEST", "monitor ◆"));
    }
    nodes.push({
      id,
      kind: "tbsb",
      label: sb.name ?? "sbd",
      stereotype: "«scoreboard»",
      compartments: [{ items: [sbSub(sb)] }],
      ports,
      drill: null,
      tooltip: `scoreboard ${sb.name ?? "sbd"}`,
    });
    const connect = (agent: string | undefined, p: string): void => {
      if (agent && agentNames.has(agent)) {
        edges.push({
          id: `e:${id}.${p}`,
          net: `${id}.${p}`,
          kind: "wire",
          source: agentId(agent),
          sourcePort: `${agentId(agent)}.ap`,
          target: id,
          targetPort: `${id}.${p}`,
        });
      }
    };
    connect(sb.source, "source");
    connect(sb.monitor ?? undefined, "monitor");
  }

  // coverage
  for (const agent of coveredAgents(config)) {
    const id = `cov:${agent}`;
    nodes.push({
      id,
      kind: "tbcov",
      label: `${agent}_cov`,
      stereotype: "«coverage»",
      compartments: [],
      ports: [port(id, "ap", "WEST", "ap ◆")],
      drill: null,
      tooltip: `functional coverage for ${agent}`,
    });
    if (agentNames.has(agent)) {
      edges.push({
        id: `e:${id}`,
        net: id,
        kind: "wire",
        source: agentId(agent),
        sourcePort: `${agentId(agent)}.ap`,
        target: id,
        targetPort: `${id}.ap`,
      });
    }
  }

  // virtual sequencer
  const vseqs = (config.virtual_sequences ?? []).filter((v) => v.name);
  if (coordinated.size) {
    const activeCoord = [...coordinated]
      .filter((a) => agents.find((x) => x.name === a)?.active !== false)
      .sort();
    const ports = activeCoord.map((a) => port("vsqr", a, "WEST", a));
    nodes.push({
      id: "vsqr",
      kind: "tbvsqr",
      label: "virtual sequencer",
      stereotype: "«vsqr»",
      compartments: vseqs.length
        ? [{ title: "sequences", items: vseqs.map((v) => v.name as string) }]
        : [{ items: ["auto virtual sequence"] }],
      ports,
      drill: null,
      tooltip: "virtual sequencer",
    });
    const activeSet = new Set(
      agents.filter((a) => a.active !== false).map((a) => a.name)
    );
    for (const a of coordinated) {
      if (!activeSet.has(a)) {
        continue; // coordinated passive agent (invalid config): without sqr
      }
      edges.push({
        id: `e:vsqr.${a}`,
        net: null,
        kind: "ref",
        source: "vsqr",
        sourcePort: `vsqr.${a}`,
        target: agentId(a),
        targetPort: `${agentId(a)}.sqr`,
      });
    }
  }

  // subenvs (H1) — UML boxes with info; drill = opening the child config
  addSubenvs(config, subenvs, nodes, edges);

  // probes
  if (probes.length) {
    const ports = probes.map((p) =>
      port("probes", p.name as string, "EAST", p.name as string, {
        note: probeNote(p),
      })
    );
    // the internal port linking to the DUT; id unique relative to the probes' names
    // (a probe named "tap" is valid in QuickUVM)
    const probeNames = new Set(probes.map((p) => p.name as string));
    let tapPort = "tap";
    while (probeNames.has(tapPort)) {
      tapPort = `_${tapPort}`;
    }
    if (hasDut) {
      ports.unshift(port("probes", tapPort, "WEST", "taps"));
    }
    nodes.push({
      id: "probes",
      kind: "tbprobe",
      label: "probes",
      stereotype: "«whitebox»",
      compartments: [
        { items: probes.map((p) => `${p.name}: ${p.path ?? "?"}`) },
      ],
      ports,
      drill: null,
      tooltip: `${probes.length} whitebox probe(s)`,
    });
    if (hasDut) {
      edges.push({
        id: "e:probes",
        net: null,
        kind: "ref",
        source: "<internals>",
        sourcePort: null,
        target: "probes",
        targetPort: `probes.${tapPort}`,
      });
    }
  }

  return { nodes, boundary: boundaries, edges };
}

/** an agent's level: sequencer / driver / monitor with interconnections */
function levelAgent(
  config: QuvmConfig,
  name: string,
  active: boolean,
  hasDut: boolean
): { nodes: TbNode[]; boundary: TbBoundary[]; edges: TbEdge[] } {
  const nodes: TbNode[] = [];
  const edges: TbEdge[] = [];
  const boundaries: TbBoundary[] = [];
  const coordinated = coordinatedAgents(config).has(name);

  // boundaries: sqr (west, from vsqr), if (east, to DUT), ap (east, to analysis)
  if (coordinated && active) {
    boundaries.push(boundary("<sqr>", "sqr", "WEST"));
  }
  if (hasDut) {
    boundaries.push(boundary("<if>", "if", "EAST", true));
  }
  boundaries.push(boundary("<ap>", "ap ◆", "EAST"));

  const unit = (
    id: string,
    label: string,
    ports: TbPort[]
  ): void => {
    nodes.push({
      id,
      kind: "tbunit",
      label,
      stereotype: null,
      compartments: [],
      ports,
      drill: null,
      tooltip: label,
    });
  };

  if (active) {
    // sequencer: sqr(west) <- boundary; seq_item_port(east) -> driver
    unit("u.sequencer", "sequencer", [
      ...(coordinated ? [port("u.sequencer", "sqr", "WEST", "sqr")] : []),
      port("u.sequencer", "seq", "EAST", "seq_item"),
    ]);
    // driver: seq(west) <- sequencer; if(east) -> boundary
    unit("u.driver", "driver", [
      port("u.driver", "seq", "WEST", "seq_item"),
      ...(hasDut ? [port("u.driver", "if", "EAST", "if", { iface: true })] : []),
    ]);
    edges.push({
      id: "e:sqr.drv",
      net: null,
      kind: "ref",
      source: "u.sequencer",
      sourcePort: "u.sequencer.seq",
      target: "u.driver",
      targetPort: "u.driver.seq",
    });
    if (coordinated) {
      edges.push({
        id: "e:sqr.bnd",
        net: null,
        kind: "ref",
        source: "<sqr>",
        sourcePort: null,
        target: "u.sequencer",
        targetPort: "u.sequencer.sqr",
      });
    }
    if (hasDut) {
      edges.push({
        id: "e:drv.if",
        net: "if",
        kind: "iface",
        source: "u.driver",
        sourcePort: "u.driver.if",
        target: "<if>",
        targetPort: null,
      });
    }
  }

  // monitor: if(west) <- boundary — `<if>` (inout) is placed by ELK in a
  // middle layer (driver->if->monitor), so it enters the monitor from the
  // LEFT (the wire does not go around the monitor); ap(east) -> boundary
  unit("u.monitor", "monitor", [
    ...(hasDut ? [port("u.monitor", "if", "WEST", "if", { iface: true })] : []),
    port("u.monitor", "ap", "EAST", "ap ◆"),
  ]);
  if (hasDut) {
    edges.push({
      id: "e:if.mon",
      net: "if",
      kind: "iface",
      source: "<if>",
      sourcePort: null,
      target: "u.monitor",
      targetPort: "u.monitor.if",
    });
  }
  edges.push({
    id: "e:mon.ap",
    net: null,
    kind: "wire",
    source: "u.monitor",
    sourcePort: "u.monitor.ap",
    target: "<ap>",
    targetPort: null,
  });

  return { nodes, boundary: boundaries, edges };
}

function addSubenvs(
  config: QuvmConfig,
  subenvs: NonNullable<QuvmConfig["subenvs"]>,
  nodes: TbNode[],
  edges: TbEdge[]
): void {
  const subenvNames = new Set(subenvs.map((s) => s.name as string));
  const pinsByBlock = new Map<string, TbPort[]>();
  const addPin = (block: string, p: string, side: "WEST" | "EAST"): void => {
    const id = subId(block);
    const pins = pinsByBlock.get(id) ?? [];
    if (!pins.some((pp) => pp.port === p)) {
      pins.push(port(id, p, side, p));
      pinsByBlock.set(id, pins);
    }
  };
  const endpoint = (s: string | undefined): [string, string] | null => {
    if (!s) return null;
    const first = s.split(".")[0];
    if (!subenvNames.has(first) || first.length >= s.length - 1) return null;
    return [first, s.slice(first.length + 1)];
  };
  const connections = (config.connections ?? []).filter((c) => c.from && c.to);
  for (const c of connections) {
    const from = endpoint(c.from);
    const to = endpoint(c.to);
    if (from) addPin(from[0], from[1], "EAST");
    if (to) addPin(to[0], to[1], "WEST");
  }
  const xsbs = crossSbs(config).filter((s) => s.name);
  for (const sb of xsbs) {
    const src = endpoint(sb.source);
    const mon = endpoint(sb.monitor ?? undefined);
    if (src) addPin(src[0], src[1], "EAST");
    if (mon) addPin(mon[0], mon[1], "EAST");
  }
  const usedSub = new Set<string>();
  for (const s of subenvs) {
    const name = s.name as string;
    const nameId = subId(name); // the key of the pins/connections (name-based)
    // id dedup like at usedSb/usedXsb: two subenvs with the SAME name (hand-written
    // YAML, invalid for quick-uvm but honestly drawn) receive DISTINCT
    // nodes — otherwise the selection/drag/context menu always found the first
    let id = nameId;
    for (let n = 2; usedSub.has(id); n++) {
      id = `${nameId}#${n}`;
    }
    usedSub.add(id);
    const params = Object.entries(s.params ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    nodes.push({
      id,
      kind: "tbsubenv",
      label: name,
      stereotype: "«subenv»",
      compartments: [
        { items: [`config: ${s.config ?? "?"}`, ...(params ? [`params: ${params}`] : [])] },
      ],
      // the pins/connections are name-based: the duplicate nodes share the pins
      // (honest for an invalid config); only the node id is distinguished
      ports: pinsByBlock.get(nameId) ?? [],
      // drill into the composed block: `config:<path>` carries the config's path itself
      // (not the name) — each block opens ITS FILE, without ambiguity at
      // duplicate names; the `config:` prefix distinguishes it from the local focuses
      // (env, agent:X). The host resolves the path and opens it with the default
      // editor (openSubenvConfig, docs/05). A subenv without a config is a leaf
      drill: s.config ? `config:${s.config}` : null,
      tooltip: `composed block env (H1): ${s.config ?? "?"}`,
    });
  }
  connections.forEach((c, i) => {
    const from = endpoint(c.from);
    const to = endpoint(c.to);
    if (from && to) {
      edges.push({
        id: `e:conn${i}`,
        net: `${c.from}→${c.to}`,
        kind: "wire",
        source: subId(from[0]),
        sourcePort: `${subId(from[0])}.${from[1]}`,
        target: subId(to[0]),
        targetPort: `${subId(to[0])}.${to[1]}`,
      });
    }
  });
  const usedXsb = new Set<string>();
  xsbs.forEach((sb, i) => {
    let id = `xsb:${sb.name ?? i}`;
    for (let n = 2; usedXsb.has(id); n++) {
      id = `xsb:${sb.name ?? i}#${n}`;
    }
    usedXsb.add(id);
    const ports: TbPort[] = [port(id, "source", "WEST", "source ◆")];
    if (sb.monitor) ports.push(port(id, "monitor", "WEST", "monitor ◆"));
    nodes.push({
      id,
      kind: "tbsb",
      label: sb.name ?? "xsb",
      stereotype: "«x-scoreboard»",
      compartments: [],
      ports,
      drill: null,
      tooltip: "cross-block scoreboard",
    });
    const connect = (ep: string | undefined, p: string): void => {
      const e = endpoint(ep);
      if (e) {
        edges.push({
          id: `e:${id}.${p}`,
          net: `${id}.${p}`,
          kind: "wire",
          source: subId(e[0]),
          sourcePort: `${subId(e[0])}.${e[1]}`,
          target: id,
          targetPort: `${id}.${p}`,
        });
      }
    };
    connect(sb.source, "source");
    connect(sb.monitor ?? undefined, "monitor");
  });
}

/** all the blocks that have a drill (for navigation / tree) */
export function tbDrillTargets(config: QuvmConfig): string[] {
  const out = ["", "env"];
  for (const a of config.agents ?? []) {
    if (a.name) out.push(agentId(a.name));
  }
  return out;
}
