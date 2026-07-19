// Euristicile pe nume de semnale (pure, fara vscode) — testabile in Node
// (scripts/test-heuristics.mjs). Capcana reala (CLAUDE.md): sufixele
// active-jos includ _ni/_bi (conventia PULP pentru intrari active-jos,
// ex. src_rst_ni) — restrangerea regexului la _n|_b scria tacit
// reset_active_low gresit (regresie prinsa pe common_cells).

/** numele care sugereaza un ceas (pe intrarile de 1 bit) */
export const CLOCK_RE = /clk|clock/i;

/** numele care sugereaza un reset (pe intrarile de 1 bit) */
export const RESET_RE = /rst|reset/i;

/** sufixele active-jos: _n/_b clasice + _ni/_bi (conventia PULP) */
export const ACTIVE_LOW_RE = /(_n|_b|_ni|_bi)$/i;

/** identificator SystemVerilog valid (nume de agent/proba/subenv) */
export const SV_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
