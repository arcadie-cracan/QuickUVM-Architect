// Per-view filter rules (docs/08 R23) — pure, no DOM.
//
// A rule is `effect x kind x name pattern`: show / hide / dim / a colour, on the
// elements of one kind (or any), whose name matches a regular expression (or
// any). The rules are PRESENTATION over the same scene: nothing is laid out
// again, nothing is removed from the model, and the YAML never hears of them —
// they live in the layout sidecar, per view, like the positions.
//
// Hidden wires are hidden dependencies (the criticism the research records
// against Grasshopper and Node-RED), so the design is deliberately explicit:
// rules exist only because the user wrote them, the view always SAYS how many
// elements they hide, and one switch (`off`) lifts them all without deleting
// them. A wire is never hidden on its own: it goes with a hidden END.
//
// Tested in `npm run test:filters`.

import {
  ANNOT_COLORS,
  type AnnotColor,
  type FilterEffect,
  type FilterRule,
  type ViewFilters,
} from "../protocol";

export type { FilterEffect, FilterRule, ViewFilters };

/** an element of the view a rule can match: a block, a flag */
export interface FilterItem {
  id: string;
  kind: string;
  name: string;
}

export interface FilterResult {
  hidden: Set<string>;
  dimmed: Set<string>;
  colors: Map<string, AnnotColor>;
  /** per rule: how many elements it matched (0 for a rule that could not run) */
  counts: number[];
  /** per rule: why it could not run (a bad pattern), or null */
  errors: (string | null)[];
}

export const FILTER_EFFECTS: readonly FilterEffect[] = ["hide", "dim", "show", ...ANNOT_COLORS];
export const MAX_RULES = 24;
const NAME_MAX = 120;

const isEffect = (e: unknown): e is FilterEffect =>
  typeof e === "string" && (FILTER_EFFECTS as readonly string[]).includes(e);
const isColor = (e: FilterEffect): e is AnnotColor =>
  (ANNOT_COLORS as readonly string[]).includes(e);

export function emptyFilters(): ViewFilters {
  return { rules: [] };
}

/**
 * What a sidecar file or a message may contain, reduced to what a rule is: a
 * known effect, an optional kind and pattern (both strings, trimmed, bounded).
 * Anything else is dropped — the file is hand-editable and the message crosses
 * a process boundary. A rule with neither kind nor pattern is kept: "dim
 * everything" is a legitimate, if blunt, rule.
 */
export function sanitizeFilters(raw: unknown): ViewFilters {
  const out: ViewFilters = { rules: [] };
  if (raw === null || typeof raw !== "object") {
    return out;
  }
  const r = raw as { rules?: unknown; off?: unknown };
  for (const x of Array.isArray(r.rules) ? r.rules : []) {
    if (out.rules.length >= MAX_RULES) {
      break;
    }
    if (x === null || typeof x !== "object") {
      continue;
    }
    const rule = x as { effect?: unknown; kind?: unknown; name?: unknown };
    if (!isEffect(rule.effect)) {
      continue;
    }
    const clean: FilterRule = { effect: rule.effect };
    if (typeof rule.kind === "string" && rule.kind.trim()) {
      clean.kind = rule.kind.trim().slice(0, 40);
    }
    if (typeof rule.name === "string" && rule.name.trim()) {
      clean.name = rule.name.trim().slice(0, NAME_MAX);
    }
    out.rules.push(clean);
  }
  if (r.off === true && out.rules.length) {
    out.off = true;
  }
  return out;
}

/** the compiled pattern of a rule, or the reason it does not compile */
function pattern(rule: FilterRule): { re: RegExp | null; error: string | null } {
  if (!rule.name) {
    return { re: null, error: null };
  }
  try {
    return { re: new RegExp(rule.name, "i"), error: null };
  } catch (e) {
    return {
      re: null,
      error: `not a regular expression: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Applies the rules to the elements of a view.
 *
 * VISIBILITY (show / hide / dim): the FIRST rule that matches an element
 * decides — so an exception is written before the rule it carves into ("show
 * ^cmd$" above "hide agents" keeps `cmd`). COLOUR: the first colour rule that
 * matches, independently of visibility. A rule whose pattern does not compile
 * matches nothing and reports why; with `off`, nothing is applied at all (the
 * counts are still computed, so the editor can show what each rule WOULD do).
 */
export function applyFilters(
  items: readonly FilterItem[],
  filters: ViewFilters | null | undefined
): FilterResult {
  const rules = filters?.rules ?? [];
  const compiled = rules.map(pattern);
  const res: FilterResult = {
    hidden: new Set(),
    dimmed: new Set(),
    colors: new Map(),
    counts: rules.map(() => 0),
    errors: compiled.map((c) => c.error),
  };
  const live = !filters?.off;
  for (const it of items) {
    let visibility = false;
    let colour = false;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const c = compiled[i];
      if (c.error || (rule.kind && rule.kind !== it.kind) || (c.re && !c.re.test(it.name))) {
        continue;
      }
      res.counts[i]++;
      if (isColor(rule.effect)) {
        if (!colour) {
          colour = true;
          if (live) {
            res.colors.set(it.id, rule.effect);
          }
        }
      } else if (!visibility) {
        visibility = true;
        if (live && rule.effect === "hide") {
          res.hidden.add(it.id);
        } else if (live && rule.effect === "dim") {
          res.dimmed.add(it.id);
        }
      }
    }
  }
  return res;
}

/**
 * What a wire does given its two ends: hidden with a hidden end (a wire into
 * nothing would be a lie), dimmed with a dimmed end, drawn otherwise.
 */
export function edgeEffect(
  res: Pick<FilterResult, "hidden" | "dimmed">,
  source: string,
  target: string
): "hide" | "dim" | null {
  if (res.hidden.has(source) || res.hidden.has(target)) {
    return "hide";
  }
  if (res.dimmed.has(source) || res.dimmed.has(target)) {
    return "dim";
  }
  return null;
}

/** the indicator's sentence: what the rules do to THIS view right now ("" = nothing to say) */
export function filterSummary(filters: ViewFilters | null | undefined, res: FilterResult): string {
  const n = filters?.rules.length ?? 0;
  if (!n) {
    return "";
  }
  if (filters?.off) {
    return `Filters off (${n} rule${n === 1 ? "" : "s"})`;
  }
  const parts: string[] = [];
  if (res.hidden.size) {
    parts.push(`${res.hidden.size} hidden`);
  }
  if (res.dimmed.size) {
    parts.push(`${res.dimmed.size} dimmed`);
  }
  if (res.colors.size) {
    parts.push(`${res.colors.size} coloured`);
  }
  return `Filters: ${parts.length ? parts.join(", ") : "no match"}`;
}
