// Tipurile subsetului de configuratie QuickUVM pe care il atinge extensia.
// Referinta de schema: modelele Pydantic din quick_uvm/models.py (v0.9) si
// docs/03-mapare-quickuvm.md. Toate campurile sunt optionale la citire —
// YAML-ul e scris si de mana; validarea autoritara ramane in QuickUVM
// (Pydantic), extensia doar previne divergentele model<->YAML (docs/03).

export interface QuvmPort {
  name?: string;
  /** implicit 1 in QuickUVM; extensia omite width la porturile de 1 bit */
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
  reset_active_low?: boolean;
  external_reset?: boolean;
  combinational?: boolean;
}

export interface QuvmTest {
  name?: string;
  num_items?: number;
}

/** Metadatele proprii extensiei (blocul `x_quickuvm_architect`), ignorate de
 *  QuickUVM (decizia D15). */
export interface QuvmArchitectMeta {
  ignored_ports?: string[];
}

/** analiza declarativa C1/A2: scoreboard cu flux sursa (+ monitor la A2) */
export interface QuvmScoreboard {
  name?: string;
  source?: string;
  monitor?: string;
  match?: "in_order" | "out_of_order";
  match_key?: string;
  max_latency?: number;
}

export interface QuvmAnalysis {
  /** numele agentilor care primesc colector de coverage */
  coverage?: string[];
  scoreboards?: QuvmScoreboard[];
}

export interface QuvmVseqStep {
  agent?: string;
  sequence?: string;
}

/** secventa virtuala C2: coordoneaza sub-secvente per agent prin vsqr */
export interface QuvmVseq {
  name?: string;
  mode?: "sequential" | "parallel";
  body?: QuvmVseqStep[];
}

/** proba whitebox K2 (observe-only, cale relativa la instanta DUT) */
export interface QuvmProbe {
  name?: string;
  path?: string;
  width?: number;
  coverage?: boolean;
  real?: boolean;
  clock?: string;
  /** campul observat refoloseste masinaria de tipuri PortConfig (S1) */
  enum?: Record<string, number>;
  type?: string;
  packed_dims?: number[];
  struct?: unknown[];
}

/** fir intre blocuri compuse (H1): `<bloc>.<port>` -> `<bloc>.<port>` */
export interface QuvmConnection {
  from?: string;
  to?: string;
}

/** compunere H1: un bloc copil referit prin calea config-ului sau (docs/03) */
export interface QuvmSubenv {
  name?: string;
  config?: string;
  /** schema QuickUVM cere dict[str, int] */
  params?: Record<string, number>;
  namespace?: boolean | string;
}

export interface QuvmConfig {
  project?: { name?: string };
  dut?: QuvmDut;
  /** un obiect (azi) sau o lista de domenii (M1 multi-clock) */
  clock?: { period?: number; unit?: string } | unknown[];
  agents?: QuvmAgent[];
  tests?: QuvmTest[];
  analysis?: QuvmAnalysis;
  /** implicit pornit in QuickUVM: vseq sintetizat la >=2 agenti activi */
  auto_virtual_sequences?: boolean;
  virtual_sequences?: QuvmVseq[];
  probes?: QuvmProbe[];
  subenvs?: QuvmSubenv[];
  connections?: QuvmConnection[];
  subenv_scoreboards?: QuvmScoreboard[];
  x_quickuvm_architect?: QuvmArchitectMeta;
}

/** Porturile unui agent, aplatizate (nume -> latime declarata). */
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
