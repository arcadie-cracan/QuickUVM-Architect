// The signal-name heuristics (pure, no vscode) — testable in Node
// (scripts/test-heuristics.mjs). The real pitfall (CLAUDE.md): the
// active-low suffixes include _ni/_bi (the PULP convention for active-low
// inputs, e.g. src_rst_ni) — narrowing the regex to _n|_b silently wrote
// reset_active_low wrong (a regression caught on common_cells).

/** names that suggest a clock (on 1-bit inputs) */
export const CLOCK_RE = /clk|clock/i;

/** names that suggest a reset (on 1-bit inputs) */
export const RESET_RE = /rst|reset/i;

/** active-low suffixes: classic _n/_b + _ni/_bi (the PULP convention) */
export const ACTIVE_LOW_RE = /(_n|_b|_ni|_bi)$/i;

/**
 * Active-low by name, for a RESET: the suffixes above, or the reset token
 * fused with `n` — AXI's `aresetn`, `rstn`, `resetn_i` (docs/08 R24, review:
 * `ACTIVE_LOW_RE` alone wrote `aresetn` as active HIGH, unattended).
 */
export function resetIsActiveLow(name: string): boolean {
  return ACTIVE_LOW_RE.test(name) || /(?:rst|reset)n(?:_[a-z]{1,2})?$/i.test(name);
}

/**
 * A clock-RELATED control that is not a clock: an enable, a gate, a select, a
 * "stable" / "locked" flag (a divided or gated clock — `clk_div2`, `clk_gated`
 * — IS a clock and is not excluded). `clk_en_i` matches the clock
 * regex and is a data pin — counted as a clock it made a single-clock module
 * "multi-clock" and got a clock generator on its enable (review finding).
 */
export const CLOCK_QUALIFIER_RE =
  /(^|_)(en|ena|enable|gate|gating|sel|select|req|ack|stable|locked|lock|valid|ready)(_|\d|$)/i;

/** valid SystemVerilog identifier (agent/probe/subenv name) */
export const SV_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** SystemVerilog keywords a GENERATED identifier must never be (an agent named
 *  `reg` or `input` compiles nowhere) — the common ones; a preset name that hits
 *  one falls back to the input box (docs/08 R12) */
export const SV_KEYWORDS = new Set([
  "always", "and", "assert", "assign", "assume", "automatic", "begin", "bit", "break",
  "buf", "byte", "case", "class", "const", "continue", "cover", "default", "disable",
  "do", "edge", "else", "end", "enum", "event", "export", "extends", "for", "force",
  "forever", "fork", "function", "generate", "genvar", "if", "import", "initial",
  "inout", "input", "int", "integer", "interface", "join", "localparam", "logic",
  "longint", "module", "nand", "negedge", "new", "nor", "not", "null", "or", "output",
  "package", "packed", "parameter", "posedge", "program", "property", "real", "ref",
  "reg", "repeat", "return", "sequence", "shortint", "signed", "static", "string",
  "struct", "super", "supply0", "supply1", "task", "this", "time", "tri", "type",
  "typedef", "union", "unsigned", "var", "virtual", "void", "wait", "while", "wire",
  "xnor", "xor",
]);

/** a trailing direction/polarity token on a port name: PULP `_i/_o/_io`,
 *  `_in/_out`, active-low `_n/_ni/_no` — not a group of its own (docs/08 R12) */
export const DIR_SUFFIX_RE = /_(i|o|io|in|out|n|ni|no)$/i;
