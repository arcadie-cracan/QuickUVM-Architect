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

/** Adds a coverage collector for an agent (`analysis.coverage`); idempotent. */
export function addCoverage(text: string, agent: string): string {
  const doc = parse(text);
  const existing = doc.getIn(["analysis", "coverage"]);
  if (isSeq(existing)) {
    for (const item of existing.items) {
      if ((item as { value?: unknown }).value === agent) {
        return doc.toString(TO_STRING); // already present
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

/** Deletes an agent's coverage collector from `analysis.coverage`
 *  (the list of scalar names); cleans up the empty block. Idempotent (no-op = original
 *  byte-identical text). */
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
  // coverage: scalar names
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

export type ScoreboardField =
  | "source"
  | "monitor"
  | "match"
  | "match_key"
  | "max_latency";

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
      if (isMap(item) && item.get("name") === name) {
        const isDefault =
          value === undefined ||
          value === "" ||
          (field === "match" && value === "in_order");
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
        }
        return doc.toString(TO_STRING);
      }
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
