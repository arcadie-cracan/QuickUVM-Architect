// The types of the QuickUVM config subset that the extension touches.
// Schema reference: the Pydantic models in quick_uvm/models.py (v1.0.0) and
// docs/quickuvm-schema-reference.md (probed empirically on the 1.0.0 build);
// docs/03-mapare-quickuvm.md remains the gesture mapping. Fields are optional —
// the YAML is also written by hand; the authoritative validation stays in QuickUVM
// (Pydantic), the extension only prevents model<->YAML divergences (docs/03).

import type { CoverageModel } from "./coverage";

export interface QuvmPort {
  name?: string;
  /** defaults to 1 in QuickUVM; the extension omits width on 1-bit ports */
  width?: number;
  randomize?: boolean;
}

export interface QuvmAgent {
  name?: string;
  interface?: string;
  sequence_item?: string;
  seq_item_style?: "manual" | "field_macros";
  active?: boolean;
  ports?: { inputs?: QuvmPort[]; outputs?: QuvmPort[] };
  /** reactive agents (docs/07 P1). The responder-only keys below are enforced as
   *  such by QuickUVM's validators — see §1.5 of the schema reference. */
  mode?: "initiator" | "responder";
  /** responder: the sampled 1-bit port meaning "the DUT issued a request" (required
   *  by `mode: responder`) */
  request_valid?: string;
  /** responder + `respond: on_request|pipelined`: the READY half of the handshake */
  request_ready?: string;
  respond?: "on_request" | "prefetch" | "combinational" | "pipelined";
  /** `respond: pipelined` only (and required by it): the sampled ID field */
  reorder_by?: string;
  reorder_policy?: "priority" | "round_robin" | "random";
  /** hybrid: a responder that ALSO takes proactive stimulus (`respond: on_request`) */
  proactive?: boolean;
  /** replicate the agent N× onto one vectored DUT; needs `reset: {external: true}` */
  replicas?: number;
  /** multi-clock/multi-reset: which declared domain this agent samples/is gated by */
  clock?: string;
  reset?: string;
  /** C3 per-instance parameter overrides; they pin the bench to `layout: flat` */
  instances?: { name?: string }[];
  /** F2' — this agent is CONSUMED BY REFERENCE from a generated VIP: the entry
   *  carries only `name` + `from_vip`, and the bench must be `layout: packaged` */
  from_vip?: string;
}

export interface QuvmDut {
  name?: string;
  clock?: string;
  reset?: string;
  combinational?: boolean;
  /** DUT ports deliberately taken out of the verification scope (waiver, quick-uvm
   *  >= 1.0.0; replaces the old `x_quickuvm_architect.ignored_ports` block
   *  that 1.0 rejects — extra="forbid" everywhere) */
  unverified_ports?: string[];
}

/** the single-reset config — the TOP-LEVEL `reset:` key (quick-uvm >= 1.0.0):
 *  polarity/externality NO longer live on `dut` (dut.reset is only the port
 *  name, like dut.clock); the list form = multi-reset domains */
export interface QuvmReset {
  active_low?: boolean;
  external?: boolean;
}

export interface QuvmTest {
  name?: string;
  num_items?: number;
  /** per-test seed count in the regression matrix; requires a `regress:` block */
  seeds?: number;
  /** the virtual sequence this test runs (instead of the per-agent default) */
  vseq?: string;
}

/** declarative analysis C1/A2: scoreboard with a source stream (+ monitor at A2) */
export interface QuvmScoreboard {
  name?: string;
  source?: string;
  monitor?: string;
  match?: "in_order" | "out_of_order";
  match_key?: string;
  max_latency?: number;
  /** windowed N:1 statistic check — SINGLE-stream only (a two-stream scoreboard is
   *  strictly 1:1 and cannot fold N samples into one verdict). `boundary` is a
   *  sampled port of the source agent: the DUT strobe that closes a window. */
  window?: { boundary?: string; length?: number };
  /** per-scoreboard predict() language; `c` also generates a DPI-C bridge + stub */
  reference_model?: { language?: "sv" | "c" };
}

export interface QuvmAnalysis {
  /** Coverage entries in EITHER form: a bare agent name (pure env routing) or a
   *  rich `{agent, coverpoints[], crosses[], goal}` model that also generates the
   *  covergroup content (docs/07 P3b). Read them through `coveredAgent`. */
  coverage?: (string | CoverageModel)[];
  scoreboards?: QuvmScoreboard[];
}

export interface QuvmVseqStep {
  agent?: string;
  sequence?: string;
}

/** virtual sequence C2: coordinates per-agent sub-sequences through the vsqr */
export interface QuvmVseq {
  name?: string;
  mode?: "sequential" | "parallel";
  body?: QuvmVseqStep[];
}

/** whitebox probe K2 (observe-only, path relative to the DUT instance) */
export interface QuvmProbe {
  name?: string;
  path?: string;
  width?: number;
  coverage?: boolean;
  real?: boolean;
  clock?: string;
  /** the observed field reuses the PortConfig type machinery (S1) */
  enum?: Record<string, number>;
  type?: string;
  packed_dims?: number[];
  struct?: unknown[];
}

/** wire between composed blocks (H1): `<bloc>.<port>` -> `<bloc>.<port>` */
export interface QuvmConnection {
  from?: string;
  to?: string;
}

/** composition H1: a child block referenced through its config path (docs/03) */
export interface QuvmSubenv {
  name?: string;
  config?: string;
  /** the QuickUVM schema requires dict[str, int] */
  params?: Record<string, number>;
  namespace?: boolean | string;
}

export interface QuvmConfig {
  project?: QuvmProject;
  dut?: QuvmDut;
  /** an object (today) or a list of domains (M1 multi-clock) */
  clock?: { period?: number; unit?: string } | unknown[];
  /** mapping (the single reset) or a list of domains — a 1-element list is NOT
   *  collapsed into a mapping: the forms have different semantics (schema-reference) */
  reset?: QuvmReset | unknown[];
  agents?: QuvmAgent[];
  tests?: QuvmTest[];
  analysis?: QuvmAnalysis;
  /** on by default in QuickUVM: vseq synthesized at >=2 active agents */
  auto_virtual_sequences?: boolean;
  virtual_sequences?: QuvmVseq[];
  probes?: QuvmProbe[];
  subenvs?: QuvmSubenv[];
  connections?: QuvmConnection[];
  /** RAL mode (docs/07 P2): PRESENCE switches it on — the block adds the adapter,
   *  the CSR tests and their env wiring. The RAL package itself is user input. */
  register_model?: QuvmRegisterModel;
  /** presence generates the regression `Makefile` and is what makes `tests[].seeds`
   *  legal (QuickUVM rejects seeds without it) */
  regress?: QuvmRegress;
  layout?: "flat" | "packaged";
  kind?: "bench" | "vip" | "selftest";
  top_name?: string;
  auto_vseq_mode?: "parallel" | "sequential";
}

export interface QuvmProject {
  name?: string;
  author?: string;
  year?: number;
  uvm_version?: "1.1d" | "1.2";
  version?: string;
  /** extra package imports for the generated tb package */
  imports?: string[];
}

export interface QuvmRegisterModel {
  package?: string;
  block?: string;
  map?: string;
  /** must name an INITIATOR agent — a responder cannot carry register traffic */
  bus_agent?: string;
  adapter?: string;
  use_predictor?: boolean;
  reg_test?: boolean;
  csr_tests?: string[];
  coverage?: boolean;
  backdoor_root?: string;
  reg_test_door?: "frontdoor" | "backdoor";
  frontdoor?: string;
}

export interface QuvmRegress {
  simulator?: string;
  filelist?: string;
  seeds?: number;
  coverage?: boolean;
}

/** A cross-block scoreboard = an `analysis.scoreboards` entry with endpoints
 *  qualified `<subenv>.<agent>` (quick-uvm >= 1.0.0 — the top-level
 *  `subenv_scoreboards` key NO longer exists; 1.0 rejects it with a teaching error). */
export function isCrossBlockSb(
  sb: QuvmScoreboard,
  subenvNames: ReadonlySet<string>
): boolean {
  const dotted = (s: string | undefined): boolean => {
    if (!s) return false;
    const first = s.split(".")[0];
    return subenvNames.has(first) && first.length < s.length - 1;
  };
  return dotted(sb.source) || dotted(sb.monitor);
}

/** An agent's ports, flattened (name -> declared width). */
export function agentPorts(agent: QuvmAgent): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of [
    ...(agent.ports?.inputs ?? []),
    ...(agent.ports?.outputs ?? []),
  ]) {
    if (p.name) {
      out.set(p.name, p.width ?? 1);
    }
  }
  return out;
}
