// The QuickUVM YAML mutations: pure text -> text functions, on the Document of
// the `yaml` library (decision D14) — comments, formatting and unknown fields
// stay intact ("surgical edits", docs/03). The file does NOT
// import `vscode`: the host (config.ts) applies the result as a WorkspaceEdit,
// and the tests run it directly in Node (scripts/test-yamlops.mjs).

import { Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from "yaml";
import type { QuvmConfig } from "./quickuvm";

/** The serialization options: a larger width so the flow ports don't break. */
const TO_STRING = { lineWidth: 100 } as const;

export interface DutSpec {
  module: string;
  /** the clock port name; null => combinational DUT (the cadence remains clk) */
  clock: string | null;
  /** the reset port name; null => no reset ('' in YAML, as in the examples) */
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
  /** the DUT inputs the agent drives (DUT perspective, docs/03) */
  inputs: AgentPortSpec[];
  /** the DUT outputs the agent observes: they get randomize: false */
  outputs: AgentPortSpec[];
  /** the DUT bidirectional ports (schema §1.5: `ports.inouts[]`); a minimal
   *  declaration is just {name, width} — open_drain/pullup are NOT invented here */
  inouts?: AgentPortSpec[];
  seqItemStyle?: "manual" | "field_macros";
}

function parse(text: string): Document {
  const doc = parseDocument(text || "{}\n");
  if (!isMap(doc.contents)) {
    // empty or scalar document: start from an empty map
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

/** The skeleton of a new configuration; dut/agents come from the dedicated operations. */
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

/** Sets the dut section (and project.name if missing). */
export function setDut(text: string, spec: DutSpec): string {
  const doc = parse(text);
  if (!doc.hasIn(["project", "name"])) {
    doc.setIn(["project", "name"], spec.module);
  }
  doc.setIn(["dut", "name"], spec.module);
  // the clock cadence exists even for a combinational DUT (QuickUVM docs / examples)
  doc.setIn(["dut", "clock"], spec.clock ?? "clk");
  doc.setIn(["dut", "reset"], spec.reset ?? "");
  // quick-uvm >= 1.0.0: the polarity/externality live in the TOP-LEVEL key
  // `reset:` (dut.reset is only the port name); the old keys on `dut` are
  // REJECTED by the generator with a teaching error. The map is written only on a
  // deviation from the defaults and disappears when it becomes default again. A hand-written
  // `reset:` LIST (multi-reset domains, with their own active_low per domain) is NOT
  // touched; deleteIn guards against a missing intermediate (yaml throws otherwise).
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

/** Adds a new agent; throws Error on a duplicate name. */
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
      // inouts get no `randomize: false` (they are not read-only observations);
      // the key is emitted only when there is at least one, so agents without a
      // bidirectional port stay byte-identical to the pre-inout output
      ...(spec.inouts && spec.inouts.length
        ? { inouts: spec.inouts.map((p) => port(p, false)) }
        : {}),
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
  /** SV identifier (the sanitized relative path, docs/03) */
  name: string;
  /** the block's config path, relative to the top config */
  config: string;
  /** integer values only: the QuickUVM schema requires dict[str, int] */
  params: Record<string, number>;
}

/** Adds subenvs (H1 composition, docs/03); throws on a duplicate name.
 *  The composition requires `layout: packaged` (validated by QuickUVM: each child
 *  block is a reusable env package) — the mutation ensures it on the top. */
export function createSubenvs(text: string, specs: SubenvSpec[]): string {
  const doc = parse(text);
  if (doc.getIn(["layout"]) !== "packaged") {
    doc.setIn(["layout"], "packaged");
  }
  // A PURE subsystem top (without its own agents) is a combinational SHELL
  // (the QuickUVM corpus convention: `dut: {combinational: true, reset: ''}`):
  // quick-uvm >= 1.0.0 REJECTS at generate a top clock that nothing
  // connects to the DUT (the ghost-clock guard in tb_top). A HYBRID top
  // (boundary agents, H2) keeps its clock — the agents wire it.
  const agentsNode = doc.getIn(["agents"]);
  const hasAgents = isSeq(agentsNode) && agentsNode.items.length > 0;
  if (!hasAgents) {
    doc.setIn(["dut", "combinational"], true);
    doc.setIn(["dut", "reset"], "");
    // the reset config of a port that no longer exists is dead decoration
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
      params.flow = true; // params on one line: `params: {W: 16}`
    }
    seq.add(node);
  }
  if (!isSeq(existing)) {
    doc.setIn(["subenvs"], seq);
  }
  return doc.toString(TO_STRING);
}

export interface ConnSpec {
  /** `<subenv>.<port>` — the source block's output port */
  from: string;
  /** `<subenv>.<port>` — the destination block's input port */
  to: string;
}

/**
 * Adds inter-block H1 connections to `connections` (slice 3, docs/03); idempotent
 * on (from, to). `connections` is a top-level list that does NOT switch modes
 * (its absence is byte-identical — probed on 0.9.2), unlike `analysis`.
 * Returns the original text byte-identical if it has nothing new to add.
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
    return text; // nothing new -> text unchanged (apply becomes a no-op)
  }
  const seq = isSeq(existing) ? existing : (doc.createNode([]) as YAMLSeq);
  for (const c of fresh) {
    const node = doc.createNode({ from: c.from, to: c.to }) as YAMLMap;
    node.flow = true; // connection on one line: `- {from: p1.dout, to: c1.din}`
    seq.add(node);
  }
  if (!isSeq(existing)) {
    doc.setIn(["connections"], seq);
  }
  return doc.toString(TO_STRING);
}

/**
 * Sets `active` on an agent (slice 3: the DESTINATION block of an H1 connection
 * must be passive — an input port driven by a wire cannot also be driven by
 * its own agent). `active=false` writes `active: false`; `active=true` deletes
 * the key (the QuickUVM default is active). Throws if the agent is missing; byte-identical
 * no-op if it is already at the requested value.
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
          return text; // already at the requested value -> text unchanged
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

/** Deletes a connection (by the from/to pair) from `connections`. Idempotent. */
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

// ---------------------------------------------- the verification view (3b)

export interface ScoreboardSpec {
  name: string;
  /** the source-stream agent (stimulus) → predictor (docs/03, A2) */
  source: string;
  /** the response-stream agent (two-stream); absent = single-stream */
  monitor?: string;
  match?: "in_order" | "out_of_order";
  /** the match key, required for out_of_order */
  matchKey?: string;
}

/** Adds a scoreboard to `analysis.scoreboards` (C1/A2); throws on a duplicate name. */
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
  node.flow = true; // scoreboard on one line: `- {name: sbd, source: cmd}`
  const seq = isSeq(existing) ? existing : (doc.createNode([]) as YAMLSeq);
  seq.add(node);
  if (!isSeq(existing)) {
    doc.setIn(["analysis", "scoreboards"], seq);
  }
  return doc.toString(TO_STRING);
}

/** Does an `analysis.coverage` entry cover `agent`? Entries come in TWO forms — a
 *  bare scalar name (pure env routing) or a rich `{agent, coverpoints…}` mapping
 *  (docs/07 P3b) — and every consumer must accept both. */
function coversAgent(item: unknown, agent: string): boolean {
  if (isMap(item)) {
    return item.get("agent") === agent;
  }
  return (item as { value?: unknown })?.value === agent;
}

/** Adds a coverage collector for an agent (`analysis.coverage`); idempotent. */
export function addCoverage(text: string, agent: string): string {
  const doc = parse(text);
  const existing = doc.getIn(["analysis", "coverage"]);
  if (isSeq(existing)) {
    for (const item of existing.items) {
      if (coversAgent(item, agent)) {
        return doc.toString(TO_STRING); // already present, in either form
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
  /** the steps: each starts a sub-sequence on an agent's sequencer (C2) */
  steps: { agent: string; sequence: string }[];
}

/** Adds a virtual sequence to `virtual_sequences` (C2); throws on a duplicate name. */
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
        item.flow = true; // steps on one line: `- {agent: cmd, sequence: cmd_seq}`
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

/** Deletes a scoreboard by name from `analysis.scoreboards` (slice 2); cleans up
 *  the block left empty. Idempotent: if it does not exist, returns the ORIGINAL
 *  byte-identical text (apply becomes a no-op; it does not re-serialize, so it does not touch other
 *  hand-written empty blocks). */
export function removeScoreboard(text: string, name: string): string {
  const doc = parse(text);
  if (!removeNamedFromSeq(doc, ["analysis", "scoreboards"], name)) {
    return text; // nothing to delete -> text unchanged
  }
  pruneEmptySeq(doc, ["analysis", "scoreboards"]);
  // ATTENTION: the `analysis` block is NOT deleted even if it stays empty — see
  // `keepAnalysis` below (the presence of the key switches QuickUVM implicit->explicit)
  return doc.toString(TO_STRING);
}

/** Deletes an agent's coverage collector from `analysis.coverage`, in either form
 *  (bare name or rich model); cleans up the empty block. Idempotent (no-op = original
 *  byte-identical text). */
export function removeCoverage(text: string, agent: string): string {
  const doc = parse(text);
  const seq = doc.getIn(["analysis", "coverage"]);
  let removed = false;
  if (isSeq(seq)) {
    for (let i = seq.items.length - 1; i >= 0; i--) {
      if (coversAgent(seq.items[i], agent)) {
        seq.delete(i);
        removed = true;
      }
    }
  }
  if (!removed) {
    return text;
  }
  pruneEmptySeq(doc, ["analysis", "coverage"]);
  // the `analysis` block stays even when empty — see `keepAnalysis`
  return doc.toString(TO_STRING);
}

/** Deletes a virtual sequence by name from `virtual_sequences`. Idempotent
 *  (no-op = original byte-identical text). */
export function removeVirtualSequence(text: string, name: string): string {
  const doc = parse(text);
  if (!removeNamedFromSeq(doc, ["virtual_sequences"], name)) {
    return text;
  }
  pruneEmptySeq(doc, ["virtual_sequences"]);
  return doc.toString(TO_STRING);
}

/** Deletes an agent (by name) and ALL its references, in cascade (C1):
 *  its coverage entry, the scoreboards whose `source` OR `monitor`
 *  is the agent (a vanished stream makes the scoreboard meaningless — it is deleted
 *  whole, not degraded) and the vseq steps that use it (the sequence disappears
 *  if ALL its steps belonged to the agent). the cross-block scoreboards (`analysis.scoreboards` entries) use
 *  `bloc.port` keys, not agent names, so it is not touched. Idempotent if the agent does not
 *  exist (original byte-identical text). Only the blocks that THIS
 *  operation emptied are cleaned up — a hand-written `virtual_sequences: [{body: []}]`
 *  stays intact (an empty vseq that did not reference the agent is not deleted). */
export function removeAgent(text: string, name: string): string {
  const doc = parse(text);
  if (!removeNamedFromSeq(doc, ["agents"], name)) {
    return text; // the agent does not exist -> nothing to do (no cascade)
  }
  pruneEmptySeq(doc, ["agents"]);
  // coverage: bare names AND rich models
  const cov = doc.getIn(["analysis", "coverage"]);
  let covChanged = false;
  if (isSeq(cov)) {
    for (let i = cov.items.length - 1; i >= 0; i--) {
      if (coversAgent(cov.items[i], name)) {
        cov.delete(i);
        covChanged = true;
      }
    }
  }
  // scoreboards: source or monitor == agent
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
  // clean up only the containers that THIS operation emptied; the
  // `analysis` block stays even if it was left empty (see `keepAnalysis`)
  if (covChanged) {
    pruneEmptySeq(doc, ["analysis", "coverage"]);
  }
  if (sbChanged) {
    pruneEmptySeq(doc, ["analysis", "scoreboards"]);
  }
  // vseq: remove the steps that use the agent; the sequence disappears only if steps
  // were removed AND the body was left empty (a pre-existing `body: []` stays)
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

/** docs/07 line 3 (P1) — the agent fields the inspector edits. `active` is NOT here:
 *  it keeps its own op (`setAgentActive`), which the connection wiring also uses. */
export type AgentField =
  | "seq_item_style"
  | "mode"
  | "respond"
  | "request_valid"
  | "request_ready"
  | "reorder_by"
  | "reorder_policy"
  | "proactive"
  | "replicas"
  | "clock"
  | "reset";

/** The value that means "the QuickUVM default" for each field: writing it deletes the
 *  key, so an untouched agent stays byte-identical to what `createAgent` emitted. */
const AGENT_DEFAULTS: Record<AgentField, string | number | boolean> = {
  seq_item_style: "manual",
  mode: "initiator",
  respond: "on_request",
  request_valid: "",
  request_ready: "",
  reorder_by: "",
  reorder_policy: "priority",
  proactive: false,
  replicas: 1,
  clock: "",
  reset: "",
};

/**
 * Edits one field of an agent (identified by name); throws if the agent is missing
 * (`setScoreboardField` is the precedent). A default value DELETES the key, so the
 * YAML stays canonical.
 *
 * It also cascades the deletions that QuickUVM's own validators demand, so the
 * inspector cannot leave behind a key that the generator would then reject:
 *   - back to `mode: initiator` → drop every responder-only key (`respond`,
 *     `request_valid`, `request_ready`, `reorder_by`, `reorder_policy`, `proactive`,
 *     `idle`) — each of those is an explicit "only valid with `mode: responder`" error;
 *   - `respond` away from `pipelined` → drop `reorder_by`/`reorder_policy`
 *     ("only valid with `respond: pipelined`");
 *   - `respond` away from `on_request`/`pipelined` → drop `request_ready` (only those
 *     two shapes publish the request); away from `on_request` → drop `proactive`
 *     (a hybrid's liveness is the on_request request-FIFO drain).
 */
export function setAgentField(
  text: string,
  name: string,
  field: AgentField,
  value: string | number | boolean | undefined
): string {
  const doc = parse(text);
  const agents = doc.getIn(["agents"]);
  if (isSeq(agents)) {
    for (const item of agents.items) {
      if (!isMap(item) || item.get("name") !== name) {
        continue;
      }
      const isDefault =
        value === undefined || value === "" || value === AGENT_DEFAULTS[field];
      if (isDefault) {
        item.delete(field);
      } else {
        item.set(field, value);
      }
      const now = (f: string): unknown => item.get(f);
      if (field === "mode" && now("mode") !== "responder") {
        for (const k of [
          "respond",
          "request_valid",
          "request_ready",
          "reorder_by",
          "reorder_policy",
          "proactive",
          "idle",
        ]) {
          item.delete(k);
        }
      } else if (field === "respond") {
        const respond = now("respond") ?? "on_request";
        if (respond !== "pipelined") {
          item.delete("reorder_by");
          item.delete("reorder_policy");
        }
        if (respond !== "on_request" && respond !== "pipelined") {
          item.delete("request_ready");
        }
        if (respond !== "on_request") {
          item.delete("proactive");
        }
      }
      return doc.toString(TO_STRING);
    }
  }
  throw new Error(`agentul „${name}" nu exista in configuratie`);
}

// -------------------------------------- bench-level config (docs/07 line 3, P2)

export interface RegisterModelSpec {
  /** the external RAL package name (user-provided input, not generated) */
  package: string;
  /** the `uvm_reg_block` class inside that package */
  block: string;
  /** the agent whose driver the adapter talks through — must be an INITIATOR */
  bus_agent: string;
}

/** docs/07 P2 — the `register_model:` fields the settings panel edits. `package`,
 *  `block` and `bus_agent` are required by QuickUVM, so they are set at creation. */
export type RegisterModelField =
  | "package"
  | "block"
  | "map"
  | "bus_agent"
  | "adapter"
  | "use_predictor"
  | "reg_test"
  | "csr_tests"
  | "coverage"
  | "backdoor_root"
  | "reg_test_door"
  | "frontdoor";

const REGISTER_MODEL_DEFAULTS: Record<RegisterModelField, unknown> = {
  package: "",
  block: "",
  map: "default_map",
  bus_agent: "",
  adapter: "reg_adapter",
  use_predictor: true,
  reg_test: true,
  csr_tests: [],
  coverage: false,
  backdoor_root: "",
  reg_test_door: "frontdoor",
  frontdoor: "",
};

/** The three fields QuickUVM requires: emptying one would make the block invalid. */
const REGISTER_MODEL_REQUIRED: readonly RegisterModelField[] = [
  "package",
  "block",
  "bus_agent",
];

/**
 * Creates the `register_model:` block (RAL mode). Its PRESENCE is what switches
 * the mode — it adds `reg_adapter.svh` + `<dut>_reg_test.svh` and the env/test
 * wiring — so creation and deletion are separate ops from field editing.
 * Throws if one already exists (the caller edits it instead).
 */
export function addRegisterModel(text: string, spec: RegisterModelSpec): string {
  const doc = parse(text);
  if (doc.getIn(["register_model"]) !== undefined) {
    throw new Error("configuratia are deja un `register_model`");
  }
  doc.setIn(["register_model"], doc.createNode({
    package: spec.package,
    block: spec.block,
    bus_agent: spec.bus_agent,
  }));
  return doc.toString(TO_STRING);
}

/** Deletes the whole `register_model:` block (leaves RAL mode). Idempotent. */
export function removeRegisterModel(text: string): string {
  const doc = parse(text);
  if (doc.getIn(["register_model"]) === undefined) {
    return text; // byte-identical no-op
  }
  doc.deleteIn(["register_model"]);
  return doc.toString(TO_STRING);
}

/**
 * Edits one field of `register_model:`; a default value deletes the key. Throws if
 * there is no block, or if a REQUIRED field (package/block/bus_agent) is emptied —
 * QuickUVM refuses such a block, so we refuse rather than corrupt it
 * (`setScoreboardField`'s treatment of `source` is the precedent).
 */
export function setRegisterModelField(
  text: string,
  field: RegisterModelField,
  value: string | boolean | string[] | undefined
): string {
  const empty =
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);
  if (REGISTER_MODEL_REQUIRED.includes(field) && empty) {
    throw new Error(`campul „${field}" al lui register_model este obligatoriu`);
  }
  const doc = parse(text);
  const rm = doc.getIn(["register_model"]);
  if (!isMap(rm)) {
    throw new Error("configuratia nu are un `register_model`");
  }
  const def = REGISTER_MODEL_DEFAULTS[field];
  const isDefault =
    empty ||
    value === def ||
    (Array.isArray(value) && Array.isArray(def) && def.length === 0 && value.length === 0);
  if (isDefault) {
    rm.delete(field);
  } else if (Array.isArray(value)) {
    const node = doc.createNode(value) as YAMLSeq;
    node.flow = true; // `csr_tests: [hw_reset, rw]`
    rm.set(field, node);
  } else {
    rm.set(field, value);
  }
  return doc.toString(TO_STRING);
}

export type RegressField = "simulator" | "filelist" | "seeds" | "coverage";

const REGRESS_DEFAULTS: Record<RegressField, string | number | boolean> = {
  simulator: "xcelium",
  filelist: "../sim/xrun.f",
  seeds: 1,
  coverage: true,
};

/** Creates the `regress:` block (its presence generates the `Makefile`). Idempotent:
 *  an existing block is left untouched, byte-identical. */
export function addRegress(text: string): string {
  const doc = parse(text);
  if (doc.getIn(["regress"]) !== undefined) {
    return text;
  }
  // written empty: every field has a default, so the block carries no noise
  doc.setIn(["regress"], doc.createNode({}));
  return doc.toString(TO_STRING);
}

/**
 * Deletes the `regress:` block AND every `tests[].seeds` it made legal. QuickUVM
 * rejects a config whose tests set `seeds` with no `regress:` block ("seeds is the
 * per-test seed count in the regression matrix and renders nothing without one"),
 * so leaving them behind would produce a config that no longer generates — the
 * same cascade rule as the agent's responder keys. Idempotent.
 */
export function removeRegress(text: string): string {
  const doc = parse(text);
  if (doc.getIn(["regress"]) === undefined) {
    return text; // byte-identical no-op
  }
  doc.deleteIn(["regress"]);
  const tests = doc.getIn(["tests"]);
  if (isSeq(tests)) {
    for (const t of tests.items) {
      if (isMap(t)) {
        t.delete("seeds");
      }
    }
  }
  return doc.toString(TO_STRING);
}

/** Edits one field of `regress:`; a default value deletes the key. */
export function setRegressField(
  text: string,
  field: RegressField,
  value: string | number | boolean | undefined
): string {
  const doc = parse(text);
  const rg = doc.getIn(["regress"]);
  if (!isMap(rg)) {
    throw new Error("configuratia nu are un `regress`");
  }
  if (value === undefined || value === "" || value === REGRESS_DEFAULTS[field]) {
    rg.delete(field);
  } else {
    rg.set(field, value);
  }
  return doc.toString(TO_STRING);
}

/** docs/07 P2 — bench identity + project metadata (plain top-level scalars). */
export type BenchField =
  | "layout"
  | "kind"
  | "top_name"
  | "auto_vseq_mode"
  | "auto_virtual_sequences";

const BENCH_DEFAULTS: Record<BenchField, string | boolean> = {
  layout: "flat",
  kind: "bench",
  top_name: "tb_top",
  auto_vseq_mode: "parallel",
  auto_virtual_sequences: true,
};

/** Sets a top-level bench field; a default value deletes the key. */
export function setBenchField(
  text: string,
  field: BenchField,
  value: string | boolean | undefined
): string {
  const doc = parse(text);
  if (value === undefined || value === "" || value === BENCH_DEFAULTS[field]) {
    doc.deleteIn([field]);
  } else {
    doc.setIn([field], value);
  }
  return doc.toString(TO_STRING);
}

export type ProjectField = "name" | "author" | "year" | "uvm_version" | "version";

/** Sets a `project:` metadata field. `name` is required by QuickUVM, so emptying it
 *  is refused; the others delete on empty. */
export function setProjectField(
  text: string,
  field: ProjectField,
  value: string | number | undefined
): string {
  if (field === "name" && (value === undefined || value === "")) {
    throw new Error("`project.name` este obligatoriu");
  }
  const doc = parse(text);
  if (value === undefined || value === "") {
    doc.deleteIn(["project", field]);
  } else {
    doc.setIn(["project", field], value);
  }
  return doc.toString(TO_STRING);
}

export type TestField = "num_items" | "seeds" | "vseq";

const TEST_DEFAULTS: Record<TestField, string | number> = {
  num_items: 100,
  seeds: 0, // no default: any value is explicit (0 is not legal, so it never matches)
  vseq: "",
};

/** Adds a test. Throws if the name is taken — QuickUVM refuses duplicate test names
 *  (and a declared test colliding with a generated one). */
export function addTest(text: string, name: string): string {
  const doc = parse(text);
  const existing = doc.getIn(["tests"]);
  if (isSeq(existing)) {
    for (const item of existing.items) {
      if (isMap(item) && item.get("name") === name) {
        throw new Error(`testul „${name}" exista deja in configuratie`);
      }
    }
  }
  const node = doc.createNode({ name }) as YAMLMap;
  node.flow = true; // one line: `- { name: smoke_test }`
  const seq = isSeq(existing) ? existing : (doc.createNode([]) as YAMLSeq);
  seq.add(node);
  if (!isSeq(existing)) {
    doc.setIn(["tests"], seq);
  }
  return doc.toString(TO_STRING);
}

/**
 * Removes a test. Removing the LAST one deletes the whole `tests:` key rather than
 * leaving `tests: []`: absence falls back to the runnable default `test1`, while an
 * empty list is accepted and yields ZERO tests — a bench that generates only
 * `<dut>_base_test.svh` and has nothing to run (verified against the generator).
 * The caller surfaces which of the two happened. Idempotent.
 */
export function removeTest(text: string, name: string): string {
  const doc = parse(text);
  const seq = doc.getIn(["tests"]);
  if (!isSeq(seq)) {
    return text;
  }
  const idx = seq.items.findIndex((i) => isMap(i) && i.get("name") === name);
  if (idx < 0) {
    return text; // byte-identical no-op
  }
  seq.delete(idx);
  if (seq.items.length === 0) {
    doc.deleteIn(["tests"]); // NOT `tests: []` — that would be a bench with no test
  }
  return doc.toString(TO_STRING);
}

/**
 * Edits one field of a test; a default value deletes the key. `seeds` is only legal
 * with a `regress:` block (QuickUVM rejects it otherwise), so setting it without one
 * is refused here rather than written and rejected at generate time.
 */
export function setTestField(
  text: string,
  name: string,
  field: TestField,
  value: string | number | undefined
): string {
  const doc = parse(text);
  if (field === "seeds" && value !== undefined && value !== "") {
    if (doc.getIn(["regress"]) === undefined) {
      throw new Error(
        "`seeds` cere un bloc `regress:` — este numarul de seed-uri per test din matricea de regresie"
      );
    }
  }
  const seq = doc.getIn(["tests"]);
  if (isSeq(seq)) {
    for (const item of seq.items) {
      if (isMap(item) && item.get("name") === name) {
        if (value === undefined || value === "" || value === TEST_DEFAULTS[field]) {
          item.delete(field);
        } else {
          item.set(field, value);
        }
        return doc.toString(TO_STRING);
      }
    }
  }
  throw new Error(`testul „${name}" nu exista in configuratie`);
}

// ---------------------------------------- agent port depth (docs/07 line 3, P4c)

/** The port fields the inspector edits. `width` keeps its own op
 *  (`setAgentPortWidth`), which the diagram's pin gesture also uses. */
export type PortField =
  | "randomize"
  | "constraint"
  | "open_drain"
  | "pullup"
  | "enum"
  | "type";

/** Locate a port on an agent, in whichever list it lives. */
function findPort(
  doc: Document,
  agent: string,
  port: string
): { map: YAMLMap; kind: "inputs" | "outputs" | "inouts" } | null {
  const agents = doc.getIn(["agents"]);
  if (!isSeq(agents)) {
    return null;
  }
  for (const a of agents.items) {
    if (!isMap(a) || a.get("name") !== agent) {
      continue;
    }
    for (const kind of ["inputs", "outputs", "inouts"] as const) {
      const list = doc.getIn(["agents", agents.items.indexOf(a), "ports", kind]);
      if (!isSeq(list)) {
        continue;
      }
      for (const p of list.items) {
        if (isMap(p) && p.get("name") === port) {
          return { map: p, kind };
        }
      }
    }
  }
  return null;
}

/**
 * Edits one field of an agent port; a default value deletes the key.
 *
 * Two QuickUVM couplings are enforced here rather than at generate time:
 *   - an OPEN-DRAIN line needs `pullup: true`. With no pullup it floats to X the
 *     moment every driver releases, and every downstream sample is poisoned — the
 *     validator calls this out as "not a style preference". So enabling open_drain
 *     turns the pullup on with it, and taking the pullup off an open-drain port is
 *     refused.
 *   - `enum` / `type` / `packed_dims` / `struct` are EXCLUSIVE type specifiers, so
 *     setting one clears the others the editor authors (enum/type). packed_dims and
 *     struct are hand-written and are refused rather than silently dropped.
 */
export function setAgentPortField(
  text: string,
  agent: string,
  port: string,
  field: PortField,
  value: string | boolean | Record<string, number> | undefined
): string {
  const doc = parse(text);
  const found = findPort(doc, agent, port);
  if (!found) {
    throw new Error(`portul „${port}" nu exista pe agentul „${agent}"`);
  }
  const p = found.map;
  const empty =
    value === undefined ||
    value === "" ||
    (typeof value === "object" && Object.keys(value).length === 0);

  if (field === "open_drain") {
    if (value === true) {
      if ((p.get("width") ?? 1) !== 1) {
        throw new Error(
          `portul „${port}" e open-drain doar pe 1 bit — per-bit pe un vector cere un generate loop, declara cate un port pe linie`
        );
      }
      p.set("open_drain", true);
      p.set("pullup", true); // an open-drain line with no pullup floats to X
    } else {
      p.delete("open_drain");
      p.delete("pullup");
    }
    return doc.toString(TO_STRING);
  }
  if (field === "pullup") {
    if (value !== true && p.get("open_drain") === true) {
      throw new Error(
        `portul „${port}" e open-drain: fara pullup linia pluteste in X cand toti elibereaza — pullup-ul nu e optional aici`
      );
    }
    if (value === true) {
      p.set("pullup", true);
    } else {
      p.delete("pullup");
    }
    return doc.toString(TO_STRING);
  }
  if (field === "enum" || field === "type") {
    for (const hand of ["packed_dims", "struct"] as const) {
      if (p.get(hand) !== undefined && !empty) {
        throw new Error(
          `portul „${port}" are deja \`${hand}\` — enum/type/packed_dims/struct sunt exclusive; scoate-l intai din YAML`
        );
      }
    }
    if (empty) {
      p.delete(field);
    } else {
      p.delete(field === "enum" ? "type" : "enum"); // exclusive specifiers
      if (field === "enum") {
        const node = doc.createNode(value) as YAMLMap;
        node.flow = true; // `enum: { IDLE: 0, BUSY: 1 }`
        p.set("enum", node);
      } else {
        p.set("type", value);
      }
    }
    return doc.toString(TO_STRING);
  }
  // randomize defaults to true; constraint has no default
  if (empty || (field === "randomize" && value === true)) {
    p.delete(field);
  } else {
    p.set(field, value);
  }
  return doc.toString(TO_STRING);
}

// -------------------------------------- multi-clock domains (docs/07 line 3, P4)

/**
 * The clock's declared-domain name when `clock:` is a MAPPING: its explicit `name`,
 * else the DUT's clock port, else the QuickUVM default `clk`. A single mapping and a
 * one-element LIST are different modes (the list engages the multi-domain machinery),
 * so this is only used to name the domain a mapping becomes when it is converted.
 */
function singleClockName(doc: Document): string {
  const clock = doc.getIn(["clock"]);
  if (isMap(clock) && typeof clock.get("name") === "string") {
    return String(clock.get("name"));
  }
  const dutClock = doc.getIn(["dut", "clock"]);
  return typeof dutClock === "string" && dutClock ? dutClock : "clk";
}

export type ClockField = "name" | "period" | "unit" | "source" | "drive_offset_pct";

/**
 * Adds a clock DOMAIN (docs/07 P4). The first add converts the `clock:` mapping into
 * a LIST — a deliberate mode switch (a list engages per-domain nets/clkgen, and a
 * 1-element list is NOT a mapping) — carrying the mapping's fields into the first
 * domain named after the current single clock. A later add appends. Throws on a
 * duplicate domain name (QuickUVM keys domains by name).
 */
export function addClockDomain(text: string, name: string): string {
  const doc = parse(text);
  const clock = doc.getIn(["clock"]);
  if (isSeq(clock)) {
    for (const d of clock.items) {
      if (isMap(d) && d.get("name") === name) {
        throw new Error(`domeniul de ceas „${name}" exista deja`);
      }
    }
    const node = doc.createNode({ name }) as YAMLMap;
    node.flow = true;
    clock.add(node);
    return doc.toString(TO_STRING);
  }
  // mapping (or absent) -> a two-domain list: the existing single clock + the new one
  const first: Record<string, unknown> = { name: singleClockName(doc) };
  if (isMap(clock)) {
    for (const key of ["period", "unit", "source", "drive_offset_pct"]) {
      const v = clock.get(key);
      if (v !== undefined) {
        first[key] = v;
      }
    }
  }
  if (first.name === name) {
    throw new Error(`domeniul de ceas „${name}" exista deja`);
  }
  const seq = doc.createNode([first, { name }]) as YAMLSeq;
  for (const item of seq.items) {
    (item as YAMLMap).flow = true;
  }
  doc.setIn(["clock"], seq);
  return doc.toString(TO_STRING);
}

/**
 * Removes a clock domain from the list. Removing the domain an agent SAMPLES is
 * refused — QuickUVM rejects an agent `clock:` naming an undeclared domain, so the
 * op would produce a config that no longer generates (the same cascade rule as the
 * responder/coverage slices). Removing the last domain is refused too: collapse to a
 * single clock instead. No-op (byte-identical) on an unknown domain or a mapping.
 */
export function removeClockDomain(text: string, name: string): string {
  const doc = parse(text);
  const clock = doc.getIn(["clock"]);
  if (!isSeq(clock)) {
    return text;
  }
  const idx = clock.items.findIndex((d) => isMap(d) && d.get("name") === name);
  if (idx < 0) {
    return text;
  }
  if (clock.items.length <= 1) {
    throw new Error(
      `„${name}" este singurul domeniu de ceas — colapseaza la un ceas simplu in loc sa-l stergi`
    );
  }
  const users = (doc.getIn(["agents"]) as YAMLSeq | undefined)?.items?.filter(
    (a) => isMap(a) && a.get("clock") === name
  );
  if (users && users.length) {
    const who = users.map((a) => (a as YAMLMap).get("name")).join(", ");
    throw new Error(
      `domeniul de ceas „${name}" e folosit de agentul/agenții ${who} — reasignează-i întâi`
    );
  }
  clock.delete(idx);
  return doc.toString(TO_STRING);
}

/** Edits a clock domain's field. Works on a LIST domain (by name) or the single
 *  MAPPING (any name matches it). A default value deletes the key. */
export function setClockDomainField(
  text: string,
  name: string,
  field: ClockField,
  value: string | number | undefined
): string {
  const doc = parse(text);
  const clock = doc.getIn(["clock"]);
  const target = isSeq(clock)
    ? clock.items.find((d) => isMap(d) && d.get("name") === name)
    : isMap(clock)
      ? clock
      : undefined;
  if (!isMap(target)) {
    throw new Error(`domeniul de ceas „${name}" nu exista`);
  }
  // `name` is required on a list domain (QuickUVM keys by it); refuse emptying it
  if (field === "name") {
    if (value === undefined || value === "") {
      throw new Error("numele domeniului de ceas este obligatoriu");
    }
    if (isSeq(clock)) {
      for (const d of clock.items) {
        if (d !== target && isMap(d) && d.get("name") === value) {
          throw new Error(`domeniul de ceas „${value}" exista deja`);
        }
      }
    }
  }
  const defaults: Record<ClockField, string | number> = {
    name: "",
    period: 10,
    unit: "ns",
    source: "tb",
    drive_offset_pct: 20,
  };
  if (field !== "name" && (value === undefined || value === "" || value === defaults[field])) {
    target.delete(field);
  } else {
    target.set(field, value);
  }
  return doc.toString(TO_STRING);
}

/**
 * Collapses a ONE-element clock list back into a mapping (the single-clock mode).
 * Refused with >1 domain — that would drop domains — and a byte-identical no-op on a
 * mapping. The `name` is dropped (a single mapping needs none) unless it differs from
 * the DUT's clock port, in which case it is kept so the binding is not lost.
 */
export function collapseClocks(text: string): string {
  const doc = parse(text);
  const clock = doc.getIn(["clock"]);
  if (!isSeq(clock)) {
    return text;
  }
  if (clock.items.length !== 1) {
    throw new Error("colapsarea cere exact un domeniu de ceas");
  }
  const only = clock.items[0];
  if (!isMap(only)) {
    return text;
  }
  const map: Record<string, unknown> = {};
  const dutClock = doc.getIn(["dut", "clock"]);
  for (const item of only.items) {
    const key = String(item.key);
    if (key === "name" && (String(item.value) === dutClock || item.value === "clk")) {
      continue; // a plain single clock carries no redundant name
    }
    map[key] = item.value;
  }
  doc.setIn(["clock"], doc.createNode(map));
  return doc.toString(TO_STRING);
}

// -------------------------------------- multi-reset domains (docs/07 line 3, P4b)

export type ResetField = "name" | "active_low" | "clock" | "external";

/**
 * Adds a reset DOMAIN. Like the clock union, the first add converts the `reset:`
 * mapping into a LIST — but resets carry an extra invariant clocks do not: under a
 * list `dut.reset` names a declared DOMAIN (not a port), so the first domain is named
 * after the current `dut.reset` to keep that binding valid.
 *
 * Refused when the single reset is `external: true`: the LIST entry schema has no
 * `external` key (QuickUVM rejects it), so the conversion would silently drop the
 * fact that the TB does not drive the reset. That is a semantic loss, not a
 * formatting one — the user takes externality off first, deliberately.
 */
export function addResetDomain(text: string, name: string): string {
  const doc = parse(text);
  const reset = doc.getIn(["reset"]);
  if (isSeq(reset)) {
    for (const d of reset.items) {
      if (isMap(d) && d.get("name") === name) {
        throw new Error(`domeniul de reset „${name}" exista deja`);
      }
    }
    const node = doc.createNode({ name }) as YAMLMap;
    node.flow = true;
    reset.add(node);
    return doc.toString(TO_STRING);
  }
  if (isMap(reset) && reset.get("external") === true) {
    throw new Error(
      "resetul curent e `external: true`, iar intrarile din lista de domenii nu accepta `external` — scoate intai externalitatea"
    );
  }
  const dutReset = doc.getIn(["dut", "reset"]);
  const firstName =
    typeof dutReset === "string" && dutReset ? dutReset : "rst_n";
  if (firstName === name) {
    throw new Error(`domeniul de reset „${name}" exista deja`);
  }
  const first: Record<string, unknown> = { name: firstName };
  if (isMap(reset) && reset.get("active_low") !== undefined) {
    first.active_low = reset.get("active_low");
  }
  const seq = doc.createNode([first, { name }]) as YAMLSeq;
  for (const item of seq.items) {
    (item as YAMLMap).flow = true;
  }
  doc.setIn(["reset"], seq);
  // `dut.reset` now selects a DOMAIN; it already reads `firstName`, so the binding
  // survives the mode switch unchanged
  return doc.toString(TO_STRING);
}

/**
 * Removes a reset domain. Refused when an agent is gated by it, when it is the one
 * `dut.reset` binds (that would leave the DUT's reset port pointing at nothing), or
 * when it is the last one — QuickUVM rejects each of those.
 */
export function removeResetDomain(text: string, name: string): string {
  const doc = parse(text);
  const reset = doc.getIn(["reset"]);
  if (!isSeq(reset)) {
    return text;
  }
  const idx = reset.items.findIndex((d) => isMap(d) && d.get("name") === name);
  if (idx < 0) {
    return text;
  }
  if (reset.items.length <= 1) {
    throw new Error(
      `„${name}" este singurul domeniu de reset — colapseaza la un reset simplu in loc sa-l stergi`
    );
  }
  if (doc.getIn(["dut", "reset"]) === name) {
    throw new Error(
      `„${name}" e domeniul legat de portul de reset al DUT-ului (dut.reset) — leaga intai altul`
    );
  }
  const users = (doc.getIn(["agents"]) as YAMLSeq | undefined)?.items?.filter(
    (a) => isMap(a) && a.get("reset") === name
  );
  if (users && users.length) {
    const who = users.map((a) => (a as YAMLMap).get("name")).join(", ");
    throw new Error(
      `domeniul de reset „${name}" e folosit de agentul/agenții ${who} — reasignează-i întâi`
    );
  }
  reset.delete(idx);
  return doc.toString(TO_STRING);
}

/**
 * Edits a reset domain's field (list domain by name, or the single mapping). A
 * RENAME cascades: `dut.reset` and every agent gated by the domain follow it, because
 * both must name a declared domain. A domain's `clock:` must name a declared clock
 * domain — the caller offers only those.
 */
export function setResetDomainField(
  text: string,
  name: string,
  field: ResetField,
  value: string | boolean | undefined
): string {
  const doc = parse(text);
  let reset: unknown = doc.getIn(["reset"]);
  const isList = isSeq(reset);
  const domains = isList ? (reset as YAMLSeq) : undefined;
  if (!isList && !isMap(reset)) {
    // An ALL-DEFAULT single reset writes no `reset:` block at all (setDut deletes it),
    // so the mapping has to be created before the first deviation can be recorded —
    // otherwise the panel's polarity/external rows would throw on a fresh bench.
    doc.setIn(["reset"], doc.createNode({}));
    reset = doc.getIn(["reset"]);
  }
  const target = domains
    ? domains.items.find((d) => isMap(d) && d.get("name") === name)
    : isMap(reset)
      ? reset
      : undefined;
  if (!isMap(target)) {
    throw new Error(`domeniul de reset „${name}" nu exista`);
  }
  if (field === "name") {
    if (typeof value !== "string" || !value) {
      throw new Error("numele domeniului de reset este obligatoriu");
    }
    if (domains) {
      for (const d of domains.items) {
        if (d !== target && isMap(d) && d.get("name") === value) {
          throw new Error(`domeniul de reset „${value}" exista deja`);
        }
      }
    }
    target.set("name", value);
    // the two references that MUST name a declared domain follow the rename
    if (doc.getIn(["dut", "reset"]) === name) {
      doc.setIn(["dut", "reset"], value);
    }
    const agents = doc.getIn(["agents"]);
    if (isSeq(agents)) {
      for (const a of agents.items) {
        if (isMap(a) && a.get("reset") === name) {
          a.set("reset", value);
        }
      }
    }
    return doc.toString(TO_STRING);
  }
  if (field === "external" && isList) {
    // the LIST entry schema is {name, active_low, clock} — QuickUVM rejects `external`
    throw new Error(
      "`external` exista doar pe resetul SIMPLU (maparea); intrarile din lista de domenii nu au cheia"
    );
  }
  // the default is PER FIELD: active_low defaults to TRUE, external to FALSE — one
  // shared "falsy means default" test would delete `active_low: false`, the very
  // deviation the user asked for
  const isDefault =
    value === undefined ||
    value === "" ||
    (field === "active_low" ? value === true : value === false);
  if (isDefault) {
    target.delete(field);
  } else {
    target.set(field, value);
  }
  // an emptied single mapping is dead decoration
  if (!isList && isMap(reset) && reset.items.length === 0) {
    doc.deleteIn(["reset"]);
  }
  return doc.toString(TO_STRING);
}

/** Collapses a ONE-element reset list back into the single mapping. The domain's
 *  name becomes `dut.reset` (a port name again), and a `clock:` gate is dropped —
 *  the single mapping has no such key. */
export function collapseResets(text: string): string {
  const doc = parse(text);
  const reset = doc.getIn(["reset"]);
  if (!isSeq(reset)) {
    return text;
  }
  if (reset.items.length !== 1) {
    throw new Error("colapsarea cere exact un domeniu de reset");
  }
  const only = reset.items[0];
  if (!isMap(only)) {
    return text;
  }
  const name = only.get("name");
  const map: Record<string, unknown> = {};
  if (only.get("active_low") !== undefined) {
    map.active_low = only.get("active_low");
  }
  if (typeof name === "string" && name) {
    doc.setIn(["dut", "reset"], name); // back to a PORT name
  }
  // an agent's `reset:` selects a domain — meaningless without a list
  const agents = doc.getIn(["agents"]);
  if (isSeq(agents)) {
    for (const a of agents.items) {
      if (isMap(a)) {
        a.delete("reset");
      }
    }
  }
  if (Object.keys(map).length) {
    doc.setIn(["reset"], doc.createNode(map));
  } else {
    doc.deleteIn(["reset"]);
  }
  return doc.toString(TO_STRING);
}

// ----------------------------- rich functional coverage (docs/07 line 3, P3b)

/**
 * Locate an `analysis.coverage` entry for `agent`, in either form (a bare string or
 * a rich mapping). Returns the sequence and the index, or null.
 */
function findCoverageEntry(
  doc: Document,
  agent: string
): { seq: YAMLSeq; idx: number } | null {
  const seq = doc.getIn(["analysis", "coverage"]);
  if (!isSeq(seq)) {
    return null;
  }
  const idx = seq.items.findIndex((i) =>
    isMap(i) ? i.get("agent") === agent : String(i) === agent
  );
  return idx < 0 ? null : { seq, idx };
}

/** The rich mapping for `agent`, or throw — every op below edits in place, so the
 *  hand-written keys it does not manage (illegal_bins, transitions, cross bins…)
 *  are never rewritten away. */
function richCoverage(doc: Document, agent: string): YAMLMap {
  const found = findCoverageEntry(doc, agent);
  const entry = found && found.seq.get(found.idx);
  if (!isMap(entry)) {
    throw new Error(`agentul „${agent}" nu are un model de coverage bogat`);
  }
  return entry;
}

/**
 * Turns a BARE coverage entry (`coverage: [cmd]`, pure env routing) into a RICH one
 * (`{agent: cmd, coverpoints: [{field, bins: []}]}`, which also generates covergroup
 * content). QuickUVM requires at least one coverpoint in a rich model, so the first
 * one is created with the entry — an empty rich model would not validate.
 */
export function upgradeCoverage(text: string, agent: string, field: string): string {
  const doc = parse(text);
  const found = findCoverageEntry(doc, agent);
  if (!found) {
    throw new Error(`agentul „${agent}" nu are o intrare de coverage`);
  }
  if (isMap(found.seq.get(found.idx))) {
    throw new Error(`agentul „${agent}" are deja un model de coverage bogat`);
  }
  const node = doc.createNode({
    agent,
    coverpoints: [{ field, bins: [] }],
  }) as YAMLMap;
  found.seq.set(found.idx, node);
  return doc.toString(TO_STRING);
}

/** Turns a rich model back into a bare agent name (keeps the routing, drops the
 *  covergroup content). Idempotent on an already-bare entry. */
export function downgradeCoverage(text: string, agent: string): string {
  const doc = parse(text);
  const found = findCoverageEntry(doc, agent);
  if (!found || !isMap(found.seq.get(found.idx))) {
    return text; // byte-identical no-op
  }
  found.seq.set(found.idx, doc.createNode(agent));
  return doc.toString(TO_STRING);
}

/** Adds a coverpoint on `field`. Throws on a duplicate — QuickUVM gives each field
 *  exactly one coverpoint. */
export function addCoverpoint(text: string, agent: string, field: string): string {
  const doc = parse(text);
  const entry = richCoverage(doc, agent);
  const cps = entry.get("coverpoints");
  const seq = isSeq(cps) ? cps : (doc.createNode([]) as YAMLSeq);
  for (const cp of seq.items) {
    if (isMap(cp) && cp.get("field") === field) {
      throw new Error(`campul „${field}" are deja un coverpoint`);
    }
  }
  seq.add(doc.createNode({ field, bins: [] }));
  if (!isSeq(cps)) {
    entry.set("coverpoints", seq);
  }
  return doc.toString(TO_STRING);
}

/**
 * Removes a coverpoint AND every cross that referenced it — QuickUVM refuses a cross
 * naming a field that is not a declared coverpoint, so leaving them would produce a
 * config that no longer generates. Removing the LAST coverpoint is refused: a rich
 * model needs at least one (downgrade to a bare entry instead).
 */
export function removeCoverpoint(text: string, agent: string, field: string): string {
  const doc = parse(text);
  const entry = richCoverage(doc, agent);
  const cps = entry.get("coverpoints");
  if (!isSeq(cps)) {
    return text;
  }
  const idx = cps.items.findIndex((c) => isMap(c) && c.get("field") === field);
  if (idx < 0) {
    return text; // byte-identical no-op
  }
  if (cps.items.length === 1) {
    throw new Error(
      `„${field}" este singurul coverpoint — un model bogat cere cel putin unul (treci intrarea la forma simpla)`
    );
  }
  cps.delete(idx);
  const crosses = entry.get("crosses");
  if (isSeq(crosses)) {
    for (let i = crosses.items.length - 1; i >= 0; i--) {
      const c = crosses.items[i];
      const fields = isSeq(c)
        ? c.items.map((x) => String(x))
        : isMap(c) && isSeq(c.get("fields"))
          ? (c.get("fields") as YAMLSeq).items.map((x) => String(x))
          : [];
      if (fields.includes(field)) {
        crosses.delete(i);
      }
    }
    if (crosses.items.length === 0) {
      entry.delete("crosses");
    }
  }
  return doc.toString(TO_STRING);
}

/** Adds/replaces a named bin on a coverpoint. `spec` is one of the three legal
 *  value forms; the other two are deleted so exactly one survives. */
export function setCoverageBin(
  text: string,
  agent: string,
  field: string,
  binName: string,
  spec: { value?: number; range?: [number, number]; values?: number[] }
): string {
  const doc = parse(text);
  const entry = richCoverage(doc, agent);
  const cps = entry.get("coverpoints");
  if (!isSeq(cps)) {
    throw new Error(`agentul „${agent}" nu are coverpoints`);
  }
  const cp = cps.items.find((c) => isMap(c) && c.get("field") === field);
  if (!isMap(cp)) {
    throw new Error(`campul „${field}" nu are un coverpoint`);
  }
  const bins = cp.get("bins");
  const seq = isSeq(bins) ? bins : (doc.createNode([]) as YAMLSeq);
  const payload: Record<string, unknown> = { name: binName };
  if (spec.value !== undefined) {
    payload.value = spec.value;
  } else if (spec.range) {
    payload.range = spec.range;
  } else {
    payload.values = spec.values ?? [];
  }
  const node = doc.createNode(payload) as YAMLMap;
  node.flow = true; // one line: `- { name: low, range: [0, 7] }`
  const idx = seq.items.findIndex((b) => isMap(b) && b.get("name") === binName);
  if (idx >= 0) {
    seq.set(idx, node);
  } else {
    seq.add(node);
  }
  if (!isSeq(bins)) {
    cp.set("bins", seq);
  }
  return doc.toString(TO_STRING);
}

/** Removes a named bin from a coverpoint. Idempotent. */
export function removeCoverageBin(
  text: string,
  agent: string,
  field: string,
  binName: string
): string {
  const doc = parse(text);
  const entry = richCoverage(doc, agent);
  const cps = entry.get("coverpoints");
  if (!isSeq(cps)) {
    return text;
  }
  const cp = cps.items.find((c) => isMap(c) && c.get("field") === field);
  if (!isMap(cp)) {
    return text;
  }
  const bins = cp.get("bins");
  if (!isSeq(bins)) {
    return text;
  }
  const idx = bins.items.findIndex((b) => isMap(b) && b.get("name") === binName);
  if (idx < 0) {
    return text; // byte-identical no-op
  }
  bins.delete(idx);
  return doc.toString(TO_STRING);
}

/** Adds a cross over >= 2 declared coverpoints (the plain field-list form). */
export function addCross(text: string, agent: string, fields: string[]): string {
  const doc = parse(text);
  const entry = richCoverage(doc, agent);
  const crosses = entry.get("crosses");
  const seq = isSeq(crosses) ? crosses : (doc.createNode([]) as YAMLSeq);
  const node = doc.createNode(fields) as YAMLSeq;
  node.flow = true; // one line: `- [wr, din]`
  seq.add(node);
  if (!isSeq(crosses)) {
    entry.set("crosses", seq);
  }
  return doc.toString(TO_STRING);
}

/** Removes a cross by its covergroup name (`<f1>_x_<f2>` or an explicit `name`). */
export function removeCross(text: string, agent: string, name: string): string {
  const doc = parse(text);
  const entry = richCoverage(doc, agent);
  const crosses = entry.get("crosses");
  if (!isSeq(crosses)) {
    return text;
  }
  const idx = crosses.items.findIndex((c) => {
    if (isSeq(c)) {
      return c.items.map((x) => String(x)).join("_x_") === name;
    }
    if (isMap(c)) {
      const explicit = c.get("name");
      if (explicit) {
        return String(explicit) === name;
      }
      const f = c.get("fields");
      return isSeq(f) && f.items.map((x) => String(x)).join("_x_") === name;
    }
    return false;
  });
  if (idx < 0) {
    return text; // byte-identical no-op
  }
  crosses.delete(idx);
  if (crosses.items.length === 0) {
    entry.delete("crosses");
  }
  return doc.toString(TO_STRING);
}

/** Sets the covergroup closure target (`option.goal`, a percent 1..100); empty
 *  deletes it. */
export function setCoverageGoal(
  text: string,
  agent: string,
  goal: number | undefined
): string {
  const doc = parse(text);
  const entry = richCoverage(doc, agent);
  if (goal === undefined) {
    entry.delete("goal");
  } else {
    if (!Number.isInteger(goal) || goal < 1 || goal > 100) {
      throw new Error("`goal` este un procent intre 1 si 100");
    }
    entry.set("goal", goal);
  }
  return doc.toString(TO_STRING);
}

export type ScoreboardField =
  | "source"
  | "monitor"
  | "match"
  | "match_key"
  | "max_latency"
  // docs/07 P3 — nested: the windowed N:1 check and the predictor language
  | "window.boundary"
  | "window.length"
  | "reference_model.language";

/** Edits a field of a scoreboard (identified by name); throws if
 *  the scoreboard is missing (`setAgentPortWidth` is the precedent). The default
 *  value is deleted — `match=in_order` or an empty/undefined field — so that the YAML
 *  stays canonical, exactly like the omissions in `addScoreboard`. It does not force
 *  flow: the entry's existing style (flow or a hand-written block) stays. */
export function setScoreboardField(
  text: string,
  name: string,
  field: ScoreboardField,
  value: string | number | undefined
): string {
  // `source` is mandatory (A2): emptying it would produce an invalid scoreboard —
  // it is refused, as with the other configuration errors (the YAML is not corrupted)
  if (field === "source" && (value === undefined || value === "")) {
    throw new Error(`source-ul scoreboard-ului „${name}" este obligatoriu`);
  }
  const doc = parse(text);
  const seq = doc.getIn(["analysis", "scoreboards"]);
  if (isSeq(seq)) {
    for (const item of seq.items) {
      if (!isMap(item) || item.get("name") !== name) {
        continue;
      }
      const empty = value === undefined || value === "";
      // --- nested fields (docs/07 P3): `window:` and `reference_model:` are
      // mappings, so an empty value removes the whole child rather than a key
      if (field === "reference_model.language") {
        // `sv` is the default: the mapping carries nothing and is dropped
        if (empty || value === "sv") {
          item.delete("reference_model");
        } else {
          const node = doc.createNode({ language: value }) as YAMLMap;
          node.flow = true;
          item.set("reference_model", node);
        }
        return doc.toString(TO_STRING);
      }
      if (field === "window.boundary" || field === "window.length") {
        const win = item.get("window");
        if (field === "window.boundary" && empty) {
          item.delete("window"); // no boundary, no window
          return doc.toString(TO_STRING);
        }
        // a window folds N samples into ONE verdict, which only a single-stream
        // scoreboard can absorb — QuickUVM refuses it with a monitor present
        if (item.get("monitor")) {
          throw new Error(
            `scoreboard-ul „${name}": \`window\` cere un scoreboard cu UN SINGUR flux (fara \`monitor\`)`
          );
        }
        if (field === "window.length" && !isMap(win)) {
          throw new Error(`scoreboard-ul „${name}" nu are un \`window\` de configurat`);
        }
        if (isMap(win)) {
          if (empty) {
            return text; // clearing the length alone would leave an invalid window
          }
          win.set(field === "window.boundary" ? "boundary" : "length", value);
        } else {
          // creating it: BOTH fields are required by QuickUVM, so a new window gets
          // the minimum legal length until the user sets a real one
          const node = doc.createNode({ boundary: value, length: 1 }) as YAMLMap;
          node.flow = true;
          item.set("window", node);
        }
        return doc.toString(TO_STRING);
      }
      const isDefault = empty || (field === "match" && value === "in_order");
      if (isDefault) {
        item.delete(field);
        // cascade cleanup: without a monitor, a scoreboard is single-stream,
        // so match/match_key make no sense; at match=in_order, match_key makes no
        // sense (the QuickUVM schema requires match_key only for out_of_order)
        if (field === "monitor") {
          item.delete("match");
          item.delete("match_key");
        } else if (field === "match") {
          item.delete("match_key");
        }
      } else {
        item.set(field, value);
        // adding a monitor makes the scoreboard two-stream, which a window cannot
        // be (1:1 vs N:1) — QuickUVM refuses the pair, so the window goes with it
        if (field === "monitor") {
          item.delete("window");
        }
      }
      return doc.toString(TO_STRING);
    }
  }
  throw new Error(`scoreboard-ul „${name}" nu exista in configuratie`);
}

export interface ProbeSpec {
  /** SV identifier (sanitized from the net name, see src/probe.ts) */
  name: string;
  /** the XMR path relative to the DUT instance (quick-uvm appends it after `dut_inst.`) */
  path: string;
  /** omitted at 1 — the QuickUVM default (ProbeConfig.width = 1) */
  width?: number;
  /** symbolic values (also drives symbolic coverage bins) — schema §1.8 */
  enum?: Record<string, number>;
  /** user SV type name for the observed field — schema §1.8 */
  type?: string;
  /** packed dimensions of the observed field — schema §1.8 */
  packed_dims?: number[];
  /** inline struct members (recursive `{name, width, ...}`) — schema §1.8 */
  struct?: unknown[];
  /** real-valued probe (SVA-only, no coverage) — schema §1.8 */
  real?: boolean;
  /** multi-clock benches: selects the sampling domain — schema §1.8 */
  clock?: string;
  /** functional coverage on the probe: creates `<dut>_probe_monitor` in the env */
  coverage?: boolean;
}

/**
 * Adds a whitebox probe to `probes` (K2, docs/03); throws on a duplicate name.
 * `probes` is a TOP-LEVEL list (like `virtual_sequences`), not a map that
 * switches modes: its absence is byte-identical for the generator (probed on 0.9.2),
 * unlike `analysis` — see `keepAnalysis`. So the empty list IS
 * cleaned up safely (`removeProbe`).
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
  // Field order follows the schema §1.8 table (name, path, width, the rich
  // field-type keys, real, clock, coverage). Each is emitted only when present,
  // so a plain name/path/width probe stays byte-identical to the pre-fix output.
  const entry: Record<string, unknown> = {
    name: spec.name,
    path: spec.path,
    ...(spec.width && spec.width !== 1 ? { width: spec.width } : {}),
    ...(spec.enum ? { enum: spec.enum } : {}),
    ...(spec.type ? { type: spec.type } : {}),
    ...(spec.packed_dims && spec.packed_dims.length
      ? { packed_dims: spec.packed_dims }
      : {}),
    ...(spec.struct && spec.struct.length ? { struct: spec.struct } : {}),
    ...(spec.real ? { real: true } : {}),
    ...(spec.clock ? { clock: spec.clock } : {}),
    ...(spec.coverage ? { coverage: true } : {}),
  };
  const node = doc.createNode(entry) as YAMLMap;
  node.flow = true; // probe on one line: `- {name: lvl, path: u.lvl, width: 3}`
  const seq = isSeq(existing) ? existing : (doc.createNode([]) as YAMLSeq);
  seq.add(node);
  if (!isSeq(existing)) {
    doc.setIn(["probes"], seq);
  }
  return doc.toString(TO_STRING);
}

/** Deletes a probe by name from `probes`. Idempotent (no-op = original text). */
export function removeProbe(text: string, name: string): string {
  const doc = parse(text);
  if (!removeNamedFromSeq(doc, ["probes"], name)) {
    return text;
  }
  pruneEmptySeq(doc, ["probes"]);
  return doc.toString(TO_STRING);
}

/** path normalization for comparisons: single separators + ./ and ../ */
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
 * The "top" configs from a set of *.quickuvm.yaml files: those that are NOT
 * referenced as `subenvs[].config` by another file in the set (docs/03 —
 * the child-block scaffolds must not become the active config).
 * The comparison is case-insensitive (Windows); relative paths resolve against
 * the referencing file.
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
 * Is the config at `activePath` COMPOSED as a subenv of another bench in the set?
 * K2 pitfall #2 (CLAUDE.md): a composed leaf-block's probes are generated but
 * NOT wired into the subsystem's tb_top (exit 0, silently broken) — the host
 * warns based on this predicate.
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

/** Adds ports to the `dut.unverified_ports` waiver (D15; quick-uvm >= 1.0.0 —
 *  a first-class schema key, the former `x_quickuvm_architect` block is rejected). */
export function ignorePorts(text: string, ports: string[]): string {
  const doc = parse(text);
  const current = readIgnored(doc);
  const merged = [...new Set([...current, ...ports])].sort();
  writeIgnored(doc, merged);
  return doc.toString(TO_STRING);
}

/** Removes ports from the ignored list; the block disappears when it stays empty. */
export function unignorePorts(text: string, ports: string[]): string {
  const doc = parse(text);
  const drop = new Set(ports);
  writeIgnored(doc, readIgnored(doc).filter((p) => !drop.has(p)));
  return doc.toString(TO_STRING);
}

/** Updates the width of an agent port (the quick-fix from docs/03). */
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

// ------------------------------------------------------------------ internal

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

/** Deletes from the seq at `path` the first map-entry with the given `name`; returns
 *  `true` if it deleted something (no-op + `false` if the seq is missing or the name
 *  is not found — the caller can short-circuit to unchanged text). */
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

/** Deletes the seq at `path` if it was left empty (block cleanup, as in
 *  `writeIgnored`) — the YAML does not keep an orphan `scoreboards: []`. */
function pruneEmptySeq(doc: Document, path: (string | number)[]): void {
  const seq = doc.getIn(path);
  if (isSeq(seq) && seq.items.length === 0) {
    doc.deleteIn(path);
  }
}

/**
 * `keepAnalysis` — WHY the `analysis` block is NEVER deleted, not even empty
 * (proved against quick-uvm 0.9.2, `test:e2e` scenario 4):
 *
 *   - WITHOUT the `analysis:` key QuickUVM enters IMPLICIT mode and auto-wires
 *     a scoreboard AND a coverage collector to the "primary agent"
 *     (`// Scoreboard (wired to primary agent: cmd)` in the env);
 *   - WITH `analysis:` (even empty `{}`) it enters DECLARED mode and wires exactly
 *     what is listed — empty => NOTHING.
 *
 * So cleaning up the emptied block would switch explicit->implicit and would REVIVE a
 * scoreboard + coverage that the user just deleted from the diagram
 * (you delete something, you get back more). Only the child lists are cleaned up
 * (`scoreboards: []` / `coverage: []`), never the `analysis` map.
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
    // only the key disappears — the `dut` block stays (it is mandatory configuration)
    doc.deleteIn(["dut", "unverified_ports"]);
    return;
  }
  const seq = doc.createNode(ports) as YAMLSeq;
  seq.flow = true;
  doc.setIn(["dut", "unverified_ports"], seq);
}

/** The agent's ports as flow maps on one line: `- {name: din, width: 8}`. */
function flowPortMaps(agent: YAMLMap): void {
  for (const side of ["inputs", "outputs", "inouts"]) {
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
