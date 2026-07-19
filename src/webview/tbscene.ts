// Scena vederii de verificare (faza 3b — docs/05): functie pura QuvmConfig ->
// scena PLATA PER NIVEL, fara DOM, testabila in Node
// (scripts/test-tbscene.mjs).
//
// Model (decizia utilizatorului, iul. 2026): detaliere pe niveluri, ca
// Symbol/Schematic la RTL. Fiecare nivel arata blocurile lui ca CUTII UML
// (stereotip + compartimente text cu structura interna), interconectate,
// cu steaguri de granita pentru conexiunile care traverseaza nivelul.
// Dublu-clic pe un bloc cu structura (`drill`) coboara la nivelul lui:
//   ""            (testbench)  -> DUT + Env
//   "env"                      -> agenti, scoreboards, coverage, vsqr, subenvs, probes
//   "agent:<nume>"             -> sequencer / driver / monitor cu interconexiuni
// Subenv-urile arata info UML; drill-ul lor (`config:<nume>`) cere host-ului
// deschiderea config-ului copil cu editorul implicit (docs/05).
//
// Constructie fail-soft: intrarile YAML care refera agenti inexistenti se
// deseneaza cat se poate; validarea autoritara ramane in ConfigService.

import type { QuvmConfig, QuvmScoreboard } from "../quickuvm";
import type { SceneNodeKind } from "./scene";

/** un compartiment UML: titlu optional + linii de text */
export interface TbCompartment {
  title?: string;
  items: string[];
}

/** port pe granita unui bloc TB */
export interface TbPort {
  id: string;
  port: string;
  side: "WEST" | "EAST";
  label: string;
  iface: boolean;
  note: string | null;
}

/** bloc al unui nivel: cutie UML cu compartimente; `drill` = focus-ul coborarii */
export interface TbNode {
  id: string;
  kind: SceneNodeKind;
  label: string;
  stereotype: string | null;
  compartments: TbCompartment[];
  ports: TbPort[];
  /** focus-ul nivelului la dublu-clic (bloc cu structura); null = frunza */
  drill: string | null;
  tooltip: string;
}

/** steag de granita: conexiune care traverseaza nivelul (ca `<port>` la RTL) */
export interface TbBoundary {
  id: string;
  label: string;
  side: "WEST" | "EAST";
  iface: boolean;
  note: string | null;
  /** directia fata de nivel, dedusa din muchii: `in` = doar sursa (datele
   *  INTRA in diagrama), `out` = doar tinta (datele IES), `inout` = ambele
   *  (interfata bidirectionala). Steagul o arata prin orientarea varfului. */
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
  /** nivelul curent: focus-ul + firimiturile pentru breadcrumb */
  focus: string;
  breadcrumb: { label: string; focus: string }[];
  nodes: TbNode[];
  boundary: TbBoundary[];
  edges: TbEdge[];
}

// ------------------------------------------------------------- ajutatoare

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

/** numele agentilor coordonati de virtual sequences (sau auto la >=2 activi) */
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

// ----------------------------------------------------------- constructia

/**
 * Construieste scena PLATA a nivelului `focus` din configuratia QuickUVM.
 * `focus`: "" (testbench top), "env", "agent:<nume>". Intoarce null la
 * nivel inexistent sau configuratie fara nimic desenabil.
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
  // Deseneaza DUT-ul cand exista un dut.name SI e verificat direct: fie config
  // frunza (fara subenvs), fie hibrid (are agenti proprii pe top). ATENTIE:
  // quick-uvm curent INTERZICE hibridul (subenvs + agenti proprii — `generate`
  // il refuza; ConfigService pune un diagnostic dur). Ramura hibrida a ramas ca
  // sa desenam onest si un config invalid (agentii lui nu dispar tacit din
  // diagrama), nu fiindca ar fi valid. Omitem DUT-ul la subsistemele PURE
  // (subenvs fara agenti), unde dut.name e doar containerul de impachetare.
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

  // breadcrumb (dezvaluire progresiva): top > env > agent
  const crumb: { label: string; focus: string }[] = [
    { label: config.project?.name ? `${config.project.name} (tb)` : "Testbench", focus: "" },
  ];
  if (focus === "env" || focus.startsWith("agent:")) {
    crumb.push({ label: "Env", focus: "env" });
  }
  if (focus.startsWith("agent:")) {
    crumb.push({ label: focus.slice("agent:".length), focus });
  }

  // directia fiecarui steag de granita, dedusa din muchii (sursa/tinta):
  // `in` = datele intra in diagrama, `out` = ies, `inout` = interfata
  // bidirectionala (ex. `<if>`: driver-ul o conduce, monitorul o esantioneaza)
  for (const b of level.boundary) {
    const isSource = level.edges.some((e) => e.source === b.id);
    const isTarget = level.edges.some((e) => e.target === b.id);
    b.dir =
      isSource && isTarget ? "inout" : isTarget ? "out" : "in";
  }

  return { viewId, focus, breadcrumb: crumb, ...level };
}

/** nivelul testbench: DUT + Env (Env cu drill) */
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

  // Env: cutie UML cu componentele listate + drill
  const analysisItems = [
    ...(config.analysis?.scoreboards ?? [])
      .filter((s) => s.source)
      .map((s) => `${s.name ?? "sbd"} (scoreboard)`),
    ...[...new Set(config.analysis?.coverage ?? [])].map((a) => `${a} (coverage)`),
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
    // interfata: env <-> dut, per agent
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

/** nivelul Env: agenti + analiza + vsqr + subenvs + probes; granita = interfata DUT */
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

  // granite: interfata catre DUT (EAST) + internals (WEST) daca sunt probe
  if (hasDut) {
    for (const a of agents) {
      boundaries.push(boundary(`<if>.${a.name}`, `${a.name}_if`, "EAST", true));
    }
    if (probes.length) {
      boundaries.push(boundary("<internals>", "internals", "WEST"));
    }
  }

  // agentii: cutii UML cu componentele interne listate + drill
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
  for (const sb of (config.analysis?.scoreboards ?? []).filter((s) => s.source)) {
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
  for (const agent of new Set(config.analysis?.coverage ?? [])) {
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
        continue; // agent pasiv coordonat (config invalid): fara sqr
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

  // subenvs (H1) — cutii UML cu info; drill = deschiderea config-ului copil
  addSubenvs(config, subenvs, nodes, edges);

  // probes
  if (probes.length) {
    const ports = probes.map((p) =>
      port("probes", p.name as string, "EAST", p.name as string, {
        note: probeNote(p),
      })
    );
    // portul intern de legatura cu DUT-ul; id unic fata de numele probelor
    // (o proba numita "tap" e valida in QuickUVM)
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

/** nivelul unui agent: sequencer / driver / monitor cu interconexiuni */
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

  // granite: sqr (vest, de la vsqr), if (est, la DUT), ap (est, la analiza)
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
    // sequencer: sqr(vest) <- granita; seq_item_port(est) -> driver
    unit("u.sequencer", "sequencer", [
      ...(coordinated ? [port("u.sequencer", "sqr", "WEST", "sqr")] : []),
      port("u.sequencer", "seq", "EAST", "seq_item"),
    ]);
    // driver: seq(vest) <- sequencer; if(est) -> granita
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

  // monitor: if(vest) <- granita — `<if>` (inout) e plasat de ELK intr-un
  // strat de mijloc (driver->if->monitor), deci intra in monitor dinspre
  // STANGA (firul nu ocoleste monitorul); ap(est) -> granita
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
  const xsbs = (config.subenv_scoreboards ?? []).filter((s) => s.name);
  for (const sb of xsbs) {
    const src = endpoint(sb.source);
    const mon = endpoint(sb.monitor ?? undefined);
    if (src) addPin(src[0], src[1], "EAST");
    if (mon) addPin(mon[0], mon[1], "EAST");
  }
  const usedSub = new Set<string>();
  for (const s of subenvs) {
    const name = s.name as string;
    const nameId = subId(name); // cheia pinilor/conexiunilor (name-based)
    // dedup de id ca la usedSb/usedXsb: doua subenv-uri cu ACELASI nume (YAML
    // scris de mana, invalid pt quick-uvm dar desenat onest) primesc noduri
    // DISTINCTE — altfel selectia/drag/meniul contextual gaseau mereu primul
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
      // pinii/conexiunile sunt name-based: nodurile duplicate impart pinii
      // (onest pt un config invalid); doar id-ul de nod se distinge
      ports: pinsByBlock.get(nameId) ?? [],
      // drill in blocul compus: `config:<cale>` poarta chiar calea config-ului
      // (nu numele) — fiecare bloc deschide FISIERUL LUI, fara ambiguitate la
      // nume duplicate; prefixul `config:` il deosebeste de focus-urile locale
      // (env, agent:X). Host-ul rezolva calea si o deschide cu editorul
      // implicit (openSubenvConfig, docs/05). Un subenv fara config e frunza
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

/** toate blocurile care au drill (pentru navigare / arbore) */
export function tbDrillTargets(config: QuvmConfig): string[] {
  const out = ["", "env"];
  for (const a of config.agents ?? []) {
    if (a.name) out.push(agentId(a.name));
  }
  return out;
}
