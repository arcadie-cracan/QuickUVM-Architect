// Rich functional-coverage authoring (docs/07 line 3, P3b): the pure half — the bin
// mini-syntax and the candidate sets the editor offers. No `vscode`, testable in Node
// (scripts/test-coverage.mjs).
//
// `analysis.coverage` entries are either a BARE agent name (pure env routing: connect
// that agent's <agent>_cov) or a RICH mapping {agent, coverpoints[], crosses[], goal}
// that also generates the covergroup content. The editor upgrades one to the other.

import type { QuvmAgent } from "./quickuvm";

/** One bin's value set — exactly one form, as QuickUVM's CoverageBin requires. */
export type BinSpec =
  | { value: number }
  | { range: [number, number] }
  | { values: number[] };

/** A named bin as it appears in the YAML (any of the three value forms). */
export interface NamedBin {
  name?: string;
  value?: number;
  range?: [number, number];
  values?: number[];
}

export interface Coverpoint {
  field?: string;
  bins?: NamedBin[];
  at_least?: number;
  auto_bin_max?: number;
  /** hand-written refinements the editor does not manage — never dropped */
  illegal_bins?: unknown[];
  ignore_bins?: unknown[];
  transitions?: unknown[];
}

export interface CoverageModel {
  agent?: string;
  coverpoints?: Coverpoint[];
  crosses?: (string[] | { fields?: string[]; name?: string })[];
  goal?: number;
}

/** A coverage entry is rich when it is a mapping (a bare string is routing only). */
export function isRich(entry: unknown): entry is CoverageModel {
  return typeof entry === "object" && entry !== null;
}

/** The agent an entry covers, whichever form it takes. */
export function coveredAgent(entry: unknown): string | undefined {
  return typeof entry === "string" ? entry : isRich(entry) ? entry.agent : undefined;
}

/**
 * Parse the editor's one-line bin syntax into a QuickUVM bin:
 *   `5`        -> {value: 5}
 *   `0..7`     -> {range: [0, 7]}   (also `0:7`, inclusive)
 *   `1, 2, 3`  -> {values: [1, 2, 3]}
 * Returns null when it is not a legal set (the caller keeps the old value).
 * Only non-negative integers: coverage bins name sampled values, and QuickUVM
 * range-checks them against the field's width.
 */
export function parseBinSpec(raw: string): BinSpec | null {
  const s = raw.trim();
  if (!s) {
    return null;
  }
  const int = (t: string): number | null =>
    /^\d+$/.test(t.trim()) ? Number(t.trim()) : null;

  const rangeSep = s.includes("..") ? ".." : s.includes(":") ? ":" : null;
  if (rangeSep) {
    const parts = s.split(rangeSep);
    if (parts.length !== 2) {
      return null;
    }
    const lo = int(parts[0]);
    const hi = int(parts[1]);
    // an inverted range would silently cover nothing in SV
    return lo === null || hi === null || lo > hi ? null : { range: [lo, hi] };
  }
  if (s.includes(",")) {
    const vals = s.split(",").map(int);
    return vals.some((v) => v === null) || vals.length === 0
      ? null
      : { values: vals as number[] };
  }
  const v = int(s);
  return v === null ? null : { value: v };
}

/** The inverse of `parseBinSpec`, for the input's displayed value. */
export function formatBinSpec(bin: NamedBin | undefined): string {
  if (bin?.value !== undefined) {
    return String(bin.value);
  }
  if (bin?.range) {
    return `${bin.range[0]}..${bin.range[1]}`;
  }
  return (bin?.values ?? []).join(", ");
}

/**
 * The fields that may still get a coverpoint on this agent: its ports, minus the
 * ones already covered (QuickUVM: "each field gets one coverpoint"). A coverpoint's
 * `field` must name a port on the covered agent.
 */
export function coverpointCandidates(
  agent: QuvmAgent | undefined,
  model: CoverageModel
): string[] {
  const taken = new Set((model.coverpoints ?? []).map((c) => c.field));
  return [...(agent?.ports?.inputs ?? []), ...(agent?.ports?.outputs ?? [])]
    .map((p) => p.name)
    .filter((n): n is string => Boolean(n) && !taken.has(n));
}

/** The auto-derived covergroup label of a cross, matching QuickUVM's `cross_name`. */
export function crossName(cross: string[] | { fields?: string[]; name?: string }): string {
  if (Array.isArray(cross)) {
    return cross.join("_x_");
  }
  return cross.name || (cross.fields ?? []).join("_x_");
}

/** The fields of a cross, whichever form it takes. */
export function crossFields(
  cross: string[] | { fields?: string[]; name?: string }
): string[] {
  return Array.isArray(cross) ? cross : (cross.fields ?? []);
}

/**
 * Why a cross over `fields` cannot be added (empty = it can). Mirrors QuickUVM's
 * own rules: >= 2 fields, each one a DECLARED coverpoint, and a cross name that is
 * not already used (two crosses over the same fields need an explicit `name`,
 * which the editor does not author — it offers distinct field sets instead).
 */
export function crossBlockers(model: CoverageModel, fields: string[]): string[] {
  const out: string[] = [];
  if (fields.length < 2) {
    out.push("a cross needs at least 2 coverpoints");
  }
  const declared = new Set((model.coverpoints ?? []).map((c) => c.field));
  const missing = fields.filter((f) => !declared.has(f));
  if (missing.length) {
    out.push(`not a declared coverpoint: ${missing.join(", ")}`);
  }
  const name = fields.join("_x_");
  if ((model.crosses ?? []).some((c) => crossName(c) === name)) {
    out.push(`a cross named ${name} already exists`);
  }
  return out;
}
