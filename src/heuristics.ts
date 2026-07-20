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

/** valid SystemVerilog identifier (agent/probe/subenv name) */
export const SV_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
