// The types of the QuickUVM config subset that the extension touches.
// Schema reference: the Pydantic models in quick_uvm/models.py (v1.0.0) and
// docs/quickuvm-schema-reference.md (probed empirically on the 1.0.0 build);
// docs/03-mapare-quickuvm.md remains the gesture mapping. Fields are optional —
// the YAML is also written by hand; the authoritative validation stays in QuickUVM
// (Pydantic), the extension only prevents model<->YAML divergences (docs/03).

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
}

/** declarative analysis C1/A2: scoreboard with a source stream (+ monitor at A2) */
export interface QuvmScoreboard {
  name?: string;
  source?: string;
  monitor?: string;
  match?: "in_order" | "out_of_order";
  match_key?: string;
  max_latency?: number;
}

export interface QuvmAnalysis {
  /** the names of the agents that get a coverage collector */
  coverage?: string[];
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
  project?: { name?: string };
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
