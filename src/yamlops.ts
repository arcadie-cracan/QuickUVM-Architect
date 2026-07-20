// Mutatiile YAML-ului QuickUVM: functii pure text -> text, pe Document-ul
// bibliotecii `yaml` (decizia D14) — comentariile, formatarea si campurile
// necunoscute raman intacte ("editari chirurgicale", docs/03). Fisierul NU
// importa `vscode`: host-ul (config.ts) aplica rezultatul ca WorkspaceEdit,
// iar testele il ruleaza direct in Node (scripts/test-yamlops.mjs).

import { Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from "yaml";
import type { QuvmConfig } from "./quickuvm";

/** Optiunile de serializare: latime mai mare ca portii flow sa nu se franga. */
const TO_STRING = { lineWidth: 100 } as const;

export interface DutSpec {
  module: string;
  /** numele portului de ceas; null => DUT combinational (cadenta ramane clk) */
  clock: string | null;
  /** numele portului de reset; null => fara reset ('' in YAML, ca in exemple) */
  reset: string | null;
  resetActiveLow: boolean;
  externalReset: boolean;
  combinational: boolean;
}

export interface AgentPortSpec {
  name: string;
  width: number;
}

export interface AgentSpec {
  name: string;
  /** intrarile DUT pe care agentul le conduce (perspectiva DUT, docs/03) */
  inputs: AgentPortSpec[];
  /** iesirile DUT pe care agentul le observa: primesc randomize: false */
  outputs: AgentPortSpec[];
  seqItemStyle?: "manual" | "field_macros";
}

function parse(text: string): Document {
  const doc = parseDocument(text || "{}\n");
  if (!isMap(doc.contents)) {
    // document gol sau scalar: se porneste de la o mapare goala
    doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  }
  return doc;
}

export function parseQuvm(text: string): QuvmConfig {
  try {
    return (parseDocument(text).toJS() as QuvmConfig) ?? {};
  } catch {
    return {};
  }
}

/** Scheletul unei configuratii noi; dut/agents vin din operatiile dedicate. */
export function newConfigText(projectName: string): string {
  return [
    "# Configuratie QuickUVM — creata de QuickUVM Architect, editabila si manual.",
    "# Extensia pastreaza comentariile si campurile pe care nu le cunoaste.",
    "project:",
    `  name: ${projectName}`,
    "",
    "clock:",
    "  period: 10",
    "  unit: ns",
    "",
    "tests:",
    `  - {name: ${projectName}_test}`,
    "",
  ].join("\n");
}

/** Seteaza sectiunea dut (si project.name daca lipseste). */
export function setDut(text: string, spec: DutSpec): string {
  const doc = parse(text);
  if (!doc.hasIn(["project", "name"])) {
    doc.setIn(["project", "name"], spec.module);
  }
  doc.setIn(["dut", "name"], spec.module);
  // cadenta de ceas exista si la DUT combinational (docs QuickUVM / exemple)
  doc.setIn(["dut", "clock"], spec.clock ?? "clk");
  doc.setIn(["dut", "reset"], spec.reset ?? "");
  // quick-uvm >= 1.0.0: polaritatea/externalitatea stau in cheia TOP-LEVEL
  // `reset:` (dut.reset e doar numele portului); vechile chei pe `dut` sunt
  // RESPINSE de generator cu eroare-ghid. Maparea se scrie doar la abatere de
  // la implicituri si dispare cand redevine implicita. O LISTA `reset:` scrisa
  // de mana (domenii multi-reset, cu active_low propriu per domeniu) NU se
  // atinge; deleteIn se apara de intermediar lipsa (yaml arunca altfel).
  if (!isSeq(doc.getIn(["reset"]))) {
    const setOrDrop = (key: string, value: boolean | undefined): void => {
      if (value !== undefined) {
        doc.setIn(["reset", key], value);
      } else if (isMap(doc.getIn(["reset"]))) {
        doc.deleteIn(["reset", key]);
      }
    };
    setOrDrop("active_low",
      spec.reset !== null && !spec.resetActiveLow ? false : undefined);
    setOrDrop("external", spec.externalReset ? true : undefined);
    const resetBlock = doc.getIn(["reset"]);
    if (isMap(resetBlock) && resetBlock.items.length === 0) {
      doc.deleteIn(["reset"]);
    }
  }
  setOrDelete(doc, ["dut", "combinational"],
    spec.combinational ? true : undefined);
  return doc.toString(TO_STRING);
}

/** Adauga un agent nou; arunca Error la nume duplicat. */
export function createAgent(text: string, spec: AgentSpec): string {
  const doc = parse(text);
  const existing = doc.getIn(["agents"]);
  if (isSeq(existing)) {
    for (const item of existing.items) {
      if (isMap(item) && item.get("name") === spec.name) {
        throw new Error(`agentul „${spec.name}" exista deja in configuratie`);
      }
    }
  }

  const port = (p: AgentPortSpec, out: boolean) => ({
    name: p.name,
    ...(p.width > 1 ? { width: p.width } : {}),
    ...(out ? { randomize: false } : {}),
  });
  const agent: Record<string, unknown> = {
    name: spec.name,
    interface: `${spec.name}_if`,
    sequence_item: `${spec.name}_seq_item`,
    ...(spec.seqItemStyle && spec.seqItemStyle !== "manual"
      ? { seq_item_style: spec.seqItemStyle }
      : {}),
    ports: {
      inputs: spec.inputs.map((p) => port(p, false)),
      outputs: spec.outputs.map((p) => port(p, true)),
    },
  };
  const node = doc.createNode(agent) as YAMLMap;
  flowPortMaps(node);

  if (isSeq(existing)) {
    existing.add(node);
  } else {
    const seq = doc.createNode([]) as YAMLSeq;
    seq.add(node);
    doc.setIn(["agents"], seq);
  }
  return doc.toString(TO_STRING);
}

export interface SubenvSpec {
  /** identificator SV (calea relativa sanitizata, docs/03) */
  name: string;
  /** calea config-ului blocului, relativa la config-ul top */
  config: string;
  /** doar valori intregi: schema QuickUVM cere dict[str, int] */
  params: Record<string, number>;
}

/** Adauga subenv-uri (compunere H1, docs/03); arunca la nume duplicat.
 *  Compunerea cere `layout: packaged` (validat de QuickUVM: fiecare bloc
 *  copil e un pachet env reutilizabil) — mutatia il asigura pe top. */
export function createSubenvs(text: string, specs: SubenvSpec[]): string {
  const doc = parse(text);
  if (doc.getIn(["layout"]) !== "packaged") {
    doc.setIn(["layout"], "packaged");
  }
  // Un top de subsistem PUR (fara agenti proprii) e un INVELIS combinational
  // (conventia corpusului QuickUVM: `dut: {combinational: true, reset: ''}`):
  // quick-uvm >= 1.0.0 REFUZA la generate un ceas de top pe care nimic nu-l
  // conecteaza la DUT (garda de ceas-fantoma din tb_top). Un top HIBRID
  // (agenti de granita, H2) isi pastreaza ceasul — agentii il leaga.
  const agentsNode = doc.getIn(["agents"]);
  const hasAgents = isSeq(agentsNode) && agentsNode.items.length > 0;
  if (!hasAgents) {
    doc.setIn(["dut", "combinational"], true);
    doc.setIn(["dut", "reset"], "");
    // configul de reset al unui port care nu mai exista e decoratie moarta
    if (isMap(doc.getIn(["reset"]))) {
      doc.deleteIn(["reset"]);
    }
  }
  const existing = doc.getIn(["subenvs"]);
  const names = new Set<string>();
  if (isSeq(existing)) {
    for (const item of existing.items) {
      if (isMap(item) && typeof item.get("name") === "string") {
        names.add(String(item.get("name")));
      }
    }
  }
  const seq = isSeq(existing) ? existing : (doc.createNode([]) as YAMLSeq);
  for (const spec of specs) {
    if (names.has(spec.name)) {
      throw new Error(`subenv-ul „${spec.name}" exista deja in configuratie`);
    }
    names.add(spec.name);
    const entry: Record<string, unknown> = {
      name: spec.name,
      config: spec.config,
      ...(Object.keys(spec.params).length ? { params: spec.params } : {}),
    };
    const node = doc.createNode(entry) as YAMLMap;
    const params = node.get("params", true);
    if (isMap(params)) {
      params.flow = true; // params pe o linie: `params: {W: 16}`
    }
    seq.add(node);
  }
  if (!isSeq(existing)) {
    doc.setIn(["subenvs"], seq);
  }
  return doc.toString(TO_STRING);
}

export interface ConnSpec {
  /** `<subenv>.<port>` — portul de iesire al blocului sursa */
  from: string;
  /** `<subenv>.<port>` — portul de intrare al blocului destinatie */
  to: string;
}

/**
 * Adauga conexiuni inter-bloc H1 in `connections` (felia 3, docs/03); idempotent
 * pe (from, to). `connections` e o listă de prim nivel care NU comută moduri
 * (absența ei e byte-identică — sondat pe 0.9.2), spre deosebire de `analysis`.
 * Intoarce textul original byte-identic daca nu are nimic nou de adaugat.
 */
export function addConnections(text: string, conns: ConnSpec[]): string {
  const doc = parse(text);
  const existing = doc.getIn(["connections"]);
  const seen = new Set<string>();
  if (isSeq(existing)) {
    for (const item of existing.items) {
      if (isMap(item)) {
        seen.add(`${item.get("from")}\0${item.get("to")}`);
      }
    }
  }
  const fresh = conns.filter((c) => !seen.has(`${c.from}\0${c.to}`));
  if (fresh.length === 0) {
    return text; // nimic nou -> text neschimbat (apply devine no-op)
  }
  const seq = isSeq(existing) ? existing : (doc.createNode([]) as YAMLSeq);
  for (const c of fresh) {
    const node = doc.createNode({ from: c.from, to: c.to }) as YAMLMap;
    node.flow = true; // conexiune pe o linie: `- {from: p1.dout, to: c1.din}`
    seq.add(node);
  }
  if (!isSeq(existing)) {
    doc.setIn(["connections"], seq);
  }
  return doc.toString(TO_STRING);
}

/**
 * Seteaza `active` pe un agent (felia 3: blocul DESTINATIE al unei conexiuni H1
 * trebuie pasiv — un port de intrare condus de fir nu poate fi si condus de
 * propriul agent). `active=false` scrie `active: false`; `active=true` sterge
 * cheia (implicitul QuickUVM e activ). Arunca daca agentul lipseste; no-op
 * byte-identic daca e deja la valoarea ceruta.
 */
export function setAgentActive(
  text: string,
  agentName: string,
  active: boolean
): string {
  const doc = parse(text);
  const agents = doc.getIn(["agents"]);
  if (isSeq(agents)) {
    for (const item of agents.items) {
      if (isMap(item) && item.get("name") === agentName) {
        const cur = item.get("active");
        const curActive = cur === undefined ? true : cur !== false;
        if (curActive === active) {
          return text; // deja la valoarea ceruta -> text neschimbat
        }
        if (active) {
          item.delete("active");
        } else {
          item.set("active", false);
        }
        return doc.toString(TO_STRING);
      }
    }
  }
  throw new Error(`agentul „${agentName}" nu exista in configuratie`);
}

/** Sterge o conexiune (dupa perechea from/to) din `connections`. Idempotent. */
export function removeConnection(text: string, from: string, to: string): string {
  const doc = parse(text);
  const seq = doc.getIn(["connections"]);
  if (!isSeq(seq)) {
    return text;
  }
  const idx = seq.items.findIndex(
    (i) => isMap(i) && i.get("from") === from && i.get("to") === to
  );
  if (idx < 0) {
    return text;
  }
  seq.delete(idx);
  pruneEmptySeq(doc, ["connections"]);
  return doc.toString(TO_STRING);
}

// ---------------------------------------------- vederea de verificare (3b)

export interface ScoreboardSpec {
  name: string;
  /** agentul flux-sursa (stimul) → predictor (docs/03, A2) */
  source: string;
  /** agentul flux-raspuns (two-stream); absent = single-stream */
  monitor?: string;
  match?: "in_order" | "out_of_order";
  /** cheia de potrivire, ceruta la out_of_order */
  matchKey?: string;
}

/** Adauga un scoreboard in `analysis.scoreboards` (C1/A2); arunca la nume duplicat. */
export function addScoreboard(text: string, spec: ScoreboardSpec): string {
  const doc = parse(text);
  const existing = doc.getIn(["analysis", "scoreboards"]);
  if (isSeq(existing)) {
    for (const item of existing.items) {
      if (isMap(item) && item.get("name") === spec.name) {
        throw new Error(`scoreboard-ul „${spec.name}" exista deja in configuratie`);
      }
    }
  }
  const entry: Record<string, unknown> = {
    name: spec.name,
    source: spec.source,
    ...(spec.monitor ? { monitor: spec.monitor } : {}),
    ...(spec.match && spec.match !== "in_order" ? { match: spec.match } : {}),
    ...(spec.matchKey ? { match_key: spec.matchKey } : {}),
  };
  const node = doc.createNode(entry) as YAMLMap;
  node.flow = true; // scoreboard pe o linie: `- {name: sbd, source: cmd}`
  const seq = isSeq(existing) ? existing : (doc.createNode([]) as YAMLSeq);
  seq.add(node);
  if (!isSeq(existing)) {
    doc.setIn(["analysis", "scoreboards"], seq);
  }
  return doc.toString(TO_STRING);
}

/** Adauga un colector de coverage pentru un agent (`analysis.coverage`); idempotent. */
export function addCoverage(text: string, agent: string): string {
  const doc = parse(text);
  const existing = doc.getIn(["analysis", "coverage"]);
  if (isSeq(existing)) {
    for (const item of existing.items) {
      if ((item as { value?: unknown }).value === agent) {
        return doc.toString(TO_STRING); // deja prezent
      }
    }
    existing.add(agent);
    existing.flow = true;
    return doc.toString(TO_STRING);
  }
  const seq = doc.createNode([agent]) as YAMLSeq;
  seq.flow = true;
  doc.setIn(["analysis", "coverage"], seq);
  return doc.toString(TO_STRING);
}

export interface VseqSpec {
  name: string;
  mode: "sequential" | "parallel";
  /** pasii: fiecare porneste o sub-secventa pe sequencer-ul unui agent (C2) */
  steps: { agent: string; sequence: string }[];
}

/** Adauga o secventa virtuala in `virtual_sequences` (C2); arunca la nume duplicat. */
export function addVirtualSequence(text: string, spec: VseqSpec): string {
  const doc = parse(text);
  const existing = doc.getIn(["virtual_sequences"]);
  if (isSeq(existing)) {
    for (const item of existing.items) {
      if (isMap(item) && item.get("name") === spec.name) {
        throw new Error(
          `secventa virtuala „${spec.name}" exista deja in configuratie`
        );
      }
    }
  }
  const entry: Record<string, unknown> = {
    name: spec.name,
    ...(spec.mode !== "sequential" ? { mode: spec.mode } : {}),
    body: spec.steps.map((s) => ({ agent: s.agent, sequence: s.sequence })),
  };
  const node = doc.createNode(entry) as YAMLMap;
  const body = node.get("body", true);
  if (isSeq(body)) {
    for (const item of body.items) {
      if (isMap(item)) {
        item.flow = true; // pasi pe o linie: `- {agent: cmd, sequence: cmd_seq}`
      }
    }
  }
  const seq = isSeq(existing) ? existing : (doc.createNode([]) as YAMLSeq);
  seq.add(node);
  if (!isSeq(existing)) {
    doc.setIn(["virtual_sequences"], seq);
  }
  return doc.toString(TO_STRING);
}

/** Sterge un scoreboard dupa nume din `analysis.scoreboards` (felia 2); curata
 *  blocul ramas gol. Idempotent: daca nu exista, intoarce textul ORIGINAL
 *  byte-identic (apply devine no-op; nu re-serializeaza, deci nu atinge alte
 *  blocuri goale scrise de mana). */
export function removeScoreboard(text: string, name: string): string {
  const doc = parse(text);
  if (!removeNamedFromSeq(doc, ["analysis", "scoreboards"], name)) {
    return text; // nimic de sters -> text neschimbat
  }
  pruneEmptySeq(doc, ["analysis", "scoreboards"]);
  // ATENTIE: blocul `analysis` NU se sterge chiar daca ramane gol — vezi
  // `keepAnalysis` de mai jos (prezenta cheii comuta QuickUVM implicit->explicit)
  return doc.toString(TO_STRING);
}

/** Sterge colectorul de coverage al unui agent din `analysis.coverage`
 *  (lista de nume scalare); curata blocul gol. Idempotent (no-op = text
 *  original byte-identic). */
export function removeCoverage(text: string, agent: string): string {
  const doc = parse(text);
  const seq = doc.getIn(["analysis", "coverage"]);
  let removed = false;
  if (isSeq(seq)) {
    for (let i = seq.items.length - 1; i >= 0; i--) {
      if ((seq.items[i] as { value?: unknown }).value === agent) {
        seq.delete(i);
        removed = true;
      }
    }
  }
  if (!removed) {
    return text;
  }
  pruneEmptySeq(doc, ["analysis", "coverage"]);
  // blocul `analysis` ramane chiar gol — vezi `keepAnalysis`
  return doc.toString(TO_STRING);
}

/** Sterge o secventa virtuala dupa nume din `virtual_sequences`. Idempotent
 *  (no-op = text original byte-identic). */
export function removeVirtualSequence(text: string, name: string): string {
  const doc = parse(text);
  if (!removeNamedFromSeq(doc, ["virtual_sequences"], name)) {
    return text;
  }
  pruneEmptySeq(doc, ["virtual_sequences"]);
  return doc.toString(TO_STRING);
}

/** Sterge un agent (dupa nume) si TOATE referintele lui, in cascada (C1):
 *  intrarea lui de coverage, scoreboard-urile al caror `source` SAU `monitor`
 *  e agentul (un flux disparut face scoreboard-ul fara sens — se sterge
 *  intreg, nu se degradeaza) si pasii de vseq care-l folosesc (secventa dispare
 *  daca TOTI pasii ei erau ai agentului). scoreboard-urile cross-bloc (intrari `analysis.scoreboards`) folosesc chei
 *  `bloc.port`, nu nume de agenti, deci nu e atins. Idempotent daca agentul nu
 *  exista (text original byte-identic). Se curata doar blocurile pe care ACEASTA
 *  operatie le-a golit — un `virtual_sequences: [{body: []}]` scris de mana
 *  ramane intact (nu se sterge un vseq gol care nu referea agentul). */
export function removeAgent(text: string, name: string): string {
  const doc = parse(text);
  if (!removeNamedFromSeq(doc, ["agents"], name)) {
    return text; // agentul nu exista -> nimic de facut (nici cascada)
  }
  pruneEmptySeq(doc, ["agents"]);
  // coverage: nume scalare
  const cov = doc.getIn(["analysis", "coverage"]);
  let covChanged = false;
  if (isSeq(cov)) {
    for (let i = cov.items.length - 1; i >= 0; i--) {
      if ((cov.items[i] as { value?: unknown }).value === name) {
        cov.delete(i);
        covChanged = true;
      }
    }
  }
  // scoreboards: source sau monitor == agent
  const sbs = doc.getIn(["analysis", "scoreboards"]);
  let sbChanged = false;
  if (isSeq(sbs)) {
    for (let i = sbs.items.length - 1; i >= 0; i--) {
      const it = sbs.items[i];
      if (isMap(it) && (it.get("source") === name || it.get("monitor") === name)) {
        sbs.delete(i);
        sbChanged = true;
      }
    }
  }
  // curata doar containerele pe care le-a golit ACEASTA operatie; blocul
  // `analysis` ramane chiar daca a ramas gol (vezi `keepAnalysis`)
  if (covChanged) {
    pruneEmptySeq(doc, ["analysis", "coverage"]);
  }
  if (sbChanged) {
    pruneEmptySeq(doc, ["analysis", "scoreboards"]);
  }
  // vseq: scoate pasii care folosesc agentul; secventa dispare doar daca s-au
  // scos pasi SI corpul a ramas gol (un `body: []` pre-existent ramane)
  const vseqs = doc.getIn(["virtual_sequences"]);
  let vseqChanged = false;
  if (isSeq(vseqs)) {
    for (let i = vseqs.items.length - 1; i >= 0; i--) {
      const vs = vseqs.items[i];
      if (!isMap(vs)) {
        continue;
      }
      const body = vs.get("body", true);
      if (isSeq(body)) {
        let stepsRemoved = 0;
        for (let j = body.items.length - 1; j >= 0; j--) {
          const st = body.items[j];
          if (isMap(st) && st.get("agent") === name) {
            body.delete(j);
            stepsRemoved += 1;
          }
        }
        if (stepsRemoved > 0) {
          vseqChanged = true;
          if (body.items.length === 0) {
            vseqs.delete(i);
          }
        }
      }
    }
  }
  if (vseqChanged) {
    pruneEmptySeq(doc, ["virtual_sequences"]);
  }
  return doc.toString(TO_STRING);
}

export type ScoreboardField =
  | "source"
  | "monitor"
  | "match"
  | "match_key"
  | "max_latency";

/** Editeaza un camp al unui scoreboard (identificat prin nume); arunca daca
 *  scoreboard-ul lipseste (`setAgentPortWidth` e precedentul). Valoarea
 *  implicita se sterge — `match=in_order` sau camp gol/undefined — ca YAML-ul
 *  sa ramana canonic, exact ca omisiunile din `addScoreboard`. Nu forteaza
 *  flow: stilul existent al intrarii (flow sau bloc scris de mana) ramane. */
export function setScoreboardField(
  text: string,
  name: string,
  field: ScoreboardField,
  value: string | number | undefined
): string {
  // `source` e obligatoriu (A2): a-l goli ar produce un scoreboard invalid —
  // se refuza, ca la celelalte erori de configurare (nu se corupe YAML-ul)
  if (field === "source" && (value === undefined || value === "")) {
    throw new Error(`source-ul scoreboard-ului „${name}" este obligatoriu`);
  }
  const doc = parse(text);
  const seq = doc.getIn(["analysis", "scoreboards"]);
  if (isSeq(seq)) {
    for (const item of seq.items) {
      if (isMap(item) && item.get("name") === name) {
        const isDefault =
          value === undefined ||
          value === "" ||
          (field === "match" && value === "in_order");
        if (isDefault) {
          item.delete(field);
          // curatare in cascada: fara monitor, un scoreboard e single-stream,
          // deci match/match_key n-au sens; la match=in_order, match_key n-are
          // sens (schema QuickUVM cere match_key doar la out_of_order)
          if (field === "monitor") {
            item.delete("match");
            item.delete("match_key");
          } else if (field === "match") {
            item.delete("match_key");
          }
        } else {
          item.set(field, value);
        }
        return doc.toString(TO_STRING);
      }
    }
  }
  throw new Error(`scoreboard-ul „${name}" nu exista in configuratie`);
}

export interface ProbeSpec {
  /** identificator SV (sanitizat din numele netului, vezi src/probe.ts) */
  name: string;
  /** calea XMR relativa la instanta DUT (quick-uvm o lipeste dupa `dut_inst.`) */
  path: string;
  /** omisa la 1 — implicitul QuickUVM (ProbeConfig.width = 1) */
  width?: number;
  /** coverage functional pe proba: creeaza `<dut>_probe_monitor` in env */
  coverage?: boolean;
}

/**
 * Adauga o proba whitebox in `probes` (K2, docs/03); arunca la nume duplicat.
 * `probes` e o lista de PRIM NIVEL (ca `virtual_sequences`), nu o mapare care
 * comuta moduri: absenta ei e byte-identica pentru generator (sondat pe 0.9.2),
 * spre deosebire de `analysis` — vezi `keepAnalysis`. Deci lista goala SE
 * curata linistit (`removeProbe`).
 */
export function addProbe(text: string, spec: ProbeSpec): string {
  const doc = parse(text);
  const existing = doc.getIn(["probes"]);
  if (isSeq(existing)) {
    for (const item of existing.items) {
      if (isMap(item) && item.get("name") === spec.name) {
        throw new Error(`proba „${spec.name}" exista deja in configuratie`);
      }
    }
  }
  const entry: Record<string, unknown> = {
    name: spec.name,
    path: spec.path,
    ...(spec.width && spec.width !== 1 ? { width: spec.width } : {}),
    ...(spec.coverage ? { coverage: true } : {}),
  };
  const node = doc.createNode(entry) as YAMLMap;
  node.flow = true; // proba pe o linie: `- {name: lvl, path: u.lvl, width: 3}`
  const seq = isSeq(existing) ? existing : (doc.createNode([]) as YAMLSeq);
  seq.add(node);
  if (!isSeq(existing)) {
    doc.setIn(["probes"], seq);
  }
  return doc.toString(TO_STRING);
}

/** Sterge o proba dupa nume din `probes`. Idempotent (no-op = text original). */
export function removeProbe(text: string, name: string): string {
  const doc = parse(text);
  if (!removeNamedFromSeq(doc, ["probes"], name)) {
    return text;
  }
  pruneEmptySeq(doc, ["probes"]);
  return doc.toString(TO_STRING);
}

/** normalizare de cale pentru comparatii: separatoare unice + ./ si ../ */
function normPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "." || seg === "") {
      continue;
    }
    if (seg === ".." && out.length && out[out.length - 1] !== "..") {
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join("/").toLowerCase();
}

/**
 * Config-urile "top" dintr-o multime de fisiere *.quickuvm.yaml: cele care NU
 * sunt referite ca `subenvs[].config` de un alt fisier din multime (docs/03 —
 * scaffold-urile blocurilor copil nu trebuie sa devina config-ul activ).
 * Comparatia e case-insensitive (Windows); caile relative se rezolva fata de
 * fisierul care refera.
 */
export function topConfigPaths(
  files: { path: string; text: string }[]
): string[] {
  const referenced = new Set<string>();
  for (const f of files) {
    const dir = f.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    for (const s of parseQuvm(f.text).subenvs ?? []) {
      if (typeof s.config === "string" && s.config) {
        referenced.add(normPath(`${dir}/${s.config}`));
      }
    }
  }
  return files.map((f) => f.path).filter((p) => !referenced.has(normPath(p)));
}

/**
 * Config-ul de la `activePath` e COMPUS ca subenv al altui bench din multime?
 * Capcana K2 #2 (CLAUDE.md): probele unui bloc-frunza compus se genereaza dar
 * NU se cableaza in tb_top-ul subsistemului (exit 0, rupt tacit) — host-ul
 * avertizeaza pe baza acestui predicat.
 */
export function isComposedChild(
  files: { path: string; text: string }[],
  activePath: string
): boolean {
  if (files.length < 2) {
    return false;
  }
  return !topConfigPaths(files).some(
    (p) => normPath(p) === normPath(activePath)
  );
}

/** Adauga porturi la waiver-ul `dut.unverified_ports` (D15; quick-uvm >= 1.0.0 —
 *  cheie de schema de prim rang, fostul bloc `x_quickuvm_architect` e respins). */
export function ignorePorts(text: string, ports: string[]): string {
  const doc = parse(text);
  const current = readIgnored(doc);
  const merged = [...new Set([...current, ...ports])].sort();
  writeIgnored(doc, merged);
  return doc.toString(TO_STRING);
}

/** Scoate porturi din lista ignoratelor; blocul dispare cand ramane gol. */
export function unignorePorts(text: string, ports: string[]): string {
  const doc = parse(text);
  const drop = new Set(ports);
  writeIgnored(doc, readIgnored(doc).filter((p) => !drop.has(p)));
  return doc.toString(TO_STRING);
}

/** Actualizeaza latimea unui port de agent (quick-fix-ul din docs/03). */
export function setAgentPortWidth(
  text: string,
  agentName: string,
  portName: string,
  width: number
): string {
  const doc = parse(text);
  const agents = doc.getIn(["agents"]);
  if (!isSeq(agents)) {
    throw new Error("configuratia nu are agenti");
  }
  for (const item of agents.items) {
    if (!isMap(item) || item.get("name") !== agentName) {
      continue;
    }
    for (const side of ["inputs", "outputs"]) {
      const list = item.getIn(["ports", side]);
      if (!isSeq(list)) {
        continue;
      }
      for (const p of list.items) {
        if (isMap(p) && p.get("name") === portName) {
          if (width > 1) {
            p.set("width", width);
          } else {
            p.delete("width");
          }
          return doc.toString(TO_STRING);
        }
      }
    }
  }
  throw new Error(
    `portul „${portName}" al agentului „${agentName}" nu exista in YAML`
  );
}

// ------------------------------------------------------------------ intern

function setOrDelete(
  doc: Document,
  path: (string | number)[],
  value: unknown
): void {
  if (value === undefined) {
    doc.deleteIn(path);
  } else {
    doc.setIn(path, value);
  }
}

/** Sterge din seq-ul de la `path` prima intrare-mapare cu `name` dat; intoarce
 *  `true` daca a sters ceva (no-op + `false` daca seq-ul lipseste sau numele
 *  nu se gaseste — apelantul se poate scurtcircuita la text neschimbat). */
function removeNamedFromSeq(
  doc: Document,
  path: (string | number)[],
  name: string
): boolean {
  const seq = doc.getIn(path);
  if (!isSeq(seq)) {
    return false;
  }
  const idx = seq.items.findIndex((i) => isMap(i) && i.get("name") === name);
  if (idx < 0) {
    return false;
  }
  seq.delete(idx);
  return true;
}

/** Sterge seq-ul de la `path` daca a ramas gol (curatare de blocuri, ca in
 *  `writeIgnored`) — YAML-ul nu pastreaza `scoreboards: []` orfan. */
function pruneEmptySeq(doc: Document, path: (string | number)[]): void {
  const seq = doc.getIn(path);
  if (isSeq(seq) && seq.items.length === 0) {
    doc.deleteIn(path);
  }
}

/**
 * `keepAnalysis` — DE CE blocul `analysis` NU se sterge niciodata, nici gol
 * (probat contra quick-uvm 0.9.2, `test:e2e` scenariul 4):
 *
 *   - FARA cheia `analysis:` QuickUVM intra in mod IMPLICIT si auto-cableaza
 *     un scoreboard SI un colector de coverage la "primary agent"
 *     (`// Scoreboard (wired to primary agent: cmd)` in env);
 *   - CU `analysis:` (chiar `{}` gol) intra in mod DECLARAT si cableaza exact
 *     ce e listat — gol => NIMIC.
 *
 * Deci a curata blocul golit ar comuta explicit->implicit si ar REINVIA un
 * scoreboard + coverage pe care utilizatorul tocmai le-a sters din diagrama
 * (stergi ceva, primesti inapoi mai mult). Se curata doar listele-copil
 * (`scoreboards: []` / `coverage: []`), niciodata maparea `analysis`.
 */


function readIgnored(doc: Document): string[] {
  const node = doc.getIn(["dut", "unverified_ports"]);
  if (!isSeq(node)) {
    return [];
  }
  return node.items
    .map((i) => (typeof (i as { value?: unknown }).value === "string"
      ? String((i as { value: unknown }).value)
      : null))
    .filter((s): s is string => s !== null);
}

function writeIgnored(doc: Document, ports: string[]): void {
  if (ports.length === 0) {
    // doar cheia dispare — blocul `dut` ramane (e configuratie obligatorie)
    doc.deleteIn(["dut", "unverified_ports"]);
    return;
  }
  const seq = doc.createNode(ports) as YAMLSeq;
  seq.flow = true;
  doc.setIn(["dut", "unverified_ports"], seq);
}

/** Portii agentului ca mape flow pe o linie: `- {name: din, width: 8}`. */
function flowPortMaps(agent: YAMLMap): void {
  for (const side of ["inputs", "outputs"]) {
    const list = agent.getIn(["ports", side]);
    if (isSeq(list)) {
      for (const item of list.items) {
        if (isMap(item)) {
          item.flow = true;
        }
      }
    }
  }
}
