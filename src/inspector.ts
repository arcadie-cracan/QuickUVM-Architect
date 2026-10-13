// Which inspector rows are worth showing (docs/07 UX: "simple by default, powerful
// when needed"). PURE (no DOM, no `vscode`), testable in Node
// (scripts/test-inspector.mjs) — the DOM half in webview/main.ts only renders what
// these decide.
//
// Two distinct rules, deliberately not one:
//
//   RELEVANCE — a field whose enabling control sits right next to it is HIDDEN until
//   that control makes it meaningful. Nothing is lost: the enabling control is itself
//   the discovery point (pick `mode: responder` and the responder rows appear). This
//   is what QuickUVM's validators already encode as walls, so a hidden row is one the
//   generator would have rejected anyway.
//
//   RARITY — a field that is always valid but seldom touched goes under `advanced`.
//   It stays one disclosure away, never disabled and never removed, because there is
//   no other control that would reveal it.
//
// A field that is neither irrelevant nor rare is `basic`. Anything blocked by a
// choice made ELSEWHERE (a different section) keeps a visible hint instead — the user
// cannot discover the fix from here.
//
//   PROVENANCE (docs/08 R16) — a third rule, orthogonal to the two above: where a
//   row's VALUE comes from. A key the component's YAML mapping declares is shown
//   FIRST, whatever relevance or rarity say (it is in the file, and a key the
//   generator would refuse is a problem to see, not to hide), in bold when its
//   value differs from the generator's default, with a reset that deletes the key;
//   the relevant rows the YAML does not declare come next ("Common") with the
//   default as a dimmed placeholder, never written; the rare ones last ("All").
//   Android's Declared / Common / All attributes, Qt's bold-and-reset.

import type { ModuleDef } from "./model";
import type { QuvmAgent, QuvmPort, QuvmScoreboard } from "./quickuvm";

/**
 * The pin identities the inspector reasons about: a name and whether it is an
 * INTERFACE port (the two gestures differ — "Agent from selection" takes signal
 * pins, "Agent from interface" takes a single interface pin).
 *
 * The diagram's own `buildPins` produces far more (label, side, bus, measured
 * width) because it also lays the symbol out; the inspector never asks for any of
 * it, and it is looked up through a by-name map, so ORDER is not part of the
 * contract. Extracted so the sidebar can build the same list without the diagram's
 * DOM text measurement.
 */
export function pinIdentities(def: ModuleDef): { name: string; iface: boolean }[] {
  return [
    ...def.ports.map((p) => ({ name: p.name, iface: false })),
    ...def.iface_ports.map((p) => ({ name: p.name, iface: true })),
  ];
}

export interface Rows {
  /** shown immediately */
  basic: string[];
  /** shown under the "Advanced" disclosure */
  advanced: string[];
}

/**
 * The agent property rows. `mode` is the discovery point for every responder knob,
 * so an initiator shows none of them; `respond` is in turn the discovery point for
 * the pipelined/hybrid ones. Each hidden row corresponds to an explicit QuickUVM
 * "only valid with …" error, so hiding it removes a row the generator would refuse.
 */
export function agentRows(agent: QuvmAgent): Rows {
  if (agent.from_vip) {
    // a VIP reference takes `{name, from_vip}` only (extra keys rejected): nothing to edit
    return { basic: [], advanced: [] };
  }
  const basic = ["active", "mode"];
  // `emit_when` gates what the MONITOR publishes (A2): with it, idle and
  // pipeline-fill cycles never reach the scoreboard. Always valid, seldom needed —
  // a stream that carries a transaction every cycle wants nothing here — so by the
  // RARITY rule it is advanced, not hidden: no other control would reveal it.
  const advanced = ["seq_item_style", "emit_when", "replicas"];
  if (agent.mode === "responder") {
    const respond = agent.respond ?? "on_request";
    basic.push("respond", "request_valid");
    // the READY half exists only for the shapes whose monitor publishes the request
    if (respond === "on_request" || respond === "pipelined") {
      basic.push("request_ready");
    }
    if (respond === "pipelined") {
      basic.push("reorder_by"); // required by pipelined
      advanced.push("reorder_policy");
    }
    // a hybrid's liveness is the on_request request-FIFO drain
    if (respond === "on_request") {
      advanced.push("proactive");
    }
  }
  return { basic, advanced };
}

/**
 * The scoreboard property rows. `monitor` decides the stream count, which is the
 * discovery point: `match`/`match_key` need two streams, `window` needs one (a
 * two-stream scoreboard is strictly 1:1 and cannot fold N samples into one verdict).
 * `window.length` appears only once a boundary is chosen — a window with no boundary
 * is not a window.
 */
export function scoreboardRows(sb: QuvmScoreboard): Rows {
  const basic = ["source", "monitor"];
  const advanced: string[] = ["max_latency", "reference_model.language"];
  if (sb.monitor) {
    basic.push("match");
    if (sb.match === "out_of_order") {
      basic.push("match_key"); // required by out_of_order
    }
  } else {
    advanced.push("window.boundary");
    if (sb.window?.boundary) {
      advanced.push("window.length");
    }
  }
  return { basic, advanced };
}

/**
 * The rows of one agent port. `open_drain` is offered only on a 1-bit INOUT (per-bit
 * open drain on a vector needs a generate loop), and `pullup` only once open drain is
 * on — QuickUVM makes the pullup mandatory there, so it is not a free choice and the
 * renderer shows it as a fixed statement rather than a control.
 */
export function portRows(kind: "in" | "out" | "inout", port: QuvmPort): Rows {
  const basic = ["width"];
  const advanced = ["randomize", "constraint"];
  const rich = port as { packed_dims?: unknown; struct?: unknown };
  // enum is exclusive with the hand-written specifiers; offering it there would only
  // produce a refusal, so it becomes a hint instead
  advanced.push(rich.packed_dims || rich.struct ? "type_specifier_hint" : "enum");
  if (kind === "inout" && (port.width ?? 1) === 1) {
    basic.push("open_drain");
    if ((port as { open_drain?: boolean }).open_drain) {
      basic.push("pullup");
    }
  }
  return { basic, advanced };
}

// ---------------------------------------------------------------- docs/08 R16

/** what the editor knows about a component kind's fields */
export interface FieldSpec {
  /** every row id the editor can render (the relevance rules pick from these) */
  rows: readonly string[];
  /** the generator's default by row id (schema reference §1.5 / §1.6); a row
   *  absent here has no default — "none" */
  defaults: Readonly<Record<string, unknown>>;
  /** keys the generator requires: declared always, never reset */
  required: readonly string[];
  /** keys ANOTHER key makes required (`request_valid` under `mode: responder`):
   *  while the predicate holds, declared but never reset — deleting it alone
   *  leaves a config the generator refuses, and no validation finding says so */
  requiredWhen?: Readonly<Record<string, (mapping: Record<string, unknown>) => boolean>>;
  /** what a reset ALSO removes (the mutation's cascade), for the ⟲ tooltip */
  resetNotes?: Readonly<Record<string, string>>;
  /** top-level keys the panel shows elsewhere (the title, the ports): never "other" */
  elsewhere: readonly string[];
}

export interface FieldInfo {
  id: string;
  /** the key is present in the YAML mapping */
  declared: boolean;
  /** the generator requires it (always, or while another key's value holds) */
  required: boolean;
  /** what the reset also removes, when the mutation cascades */
  resetNote?: string;
  /** declared, not required, and different from the generator's default: bold */
  modified: boolean;
  /** declared and not required: the reset (= delete the key) is offered */
  resettable: boolean;
  /** the generator's default as text, for the dimmed placeholder (undefined = none) */
  placeholder: string | undefined;
}

/** a declared key the editor has no row for: shown read-only, value summarised */
export interface OtherField {
  key: string;
  summary: string;
  required: boolean;
  /** differs from the schema default (unknown default = any value differs) */
  modified: boolean;
}

export interface FieldGroups {
  /** the declared rows, the editor's order first, the ones relevance hides last */
  declared: FieldInfo[];
  /** the relevant (`basic`) rows the YAML does not declare */
  common: FieldInfo[];
  /** the rare (`advanced`) rows the YAML does not declare */
  all: FieldInfo[];
  other: OtherField[];
}

export const AGENT_SPEC: FieldSpec = {
  rows: [
    "active", "mode", "seq_item_style", "respond", "request_valid", "request_ready",
    "reorder_by", "reorder_policy", "proactive", "emit_when", "replicas", "clock", "reset",
  ],
  defaults: {
    active: true,
    mode: "initiator",
    seq_item_style: "manual",
    respond: "on_request",
    reorder_policy: "priority",
    proactive: false,
    replicas: 1,
    // the keys without a row (read-only), so their rows know the default too
    assertions: false,
    idle: {},
    sequences: [],
    fields: [],
    constraints: [],
    parameters: [],
    instances: [],
  },
  required: ["interface", "sequence_item"],
  requiredWhen: {
    request_valid: (m) => m.mode === "responder",
    reorder_by: (m) => m.respond === "pipelined",
  },
  resetNotes: {
    mode: "back to initiator, the responder-only keys go too (respond, request_valid, request_ready, reorder_by, reorder_policy, proactive, idle)",
    respond: "back to on_request, reorder_by and reorder_policy go too",
  },
  elsewhere: ["name", "ports"],
};

export const SCOREBOARD_SPEC: FieldSpec = {
  rows: [
    "source", "monitor", "match", "match_key", "max_latency",
    "window.boundary", "window.length", "reference_model.language",
  ],
  defaults: { match: "in_order", "reference_model.language": "sv" },
  required: ["source"],
  requiredWhen: {
    match_key: (m) => m.match === "out_of_order",
    // a window without a length is invalid: the length is edited, never reset
    "window.length": (m) => valueAt(m, "window.boundary") !== undefined,
  },
  resetNotes: {
    monitor: "single-stream again: match and match_key go too",
    match: "back to in_order, match_key goes too",
    "window.boundary": "removes the whole window (boundary and length)",
    "reference_model.language": "removes the reference_model mapping",
  },
  elsewhere: ["name"],
};

export const PORT_SPEC: FieldSpec = {
  rows: ["width", "randomize", "constraint", "enum", "open_drain", "pullup"],
  defaults: { width: 1, randomize: true, rand_mode: true, open_drain: false },
  // the pullup is mandatory once open drain is on (a statement, not a choice): no reset
  required: ["pullup"],
  resetNotes: { open_drain: "the pullup goes too" },
  elsewhere: ["name"],
};

/** the value at a dotted row id (`window.boundary`), undefined when absent */
function valueAt(mapping: Record<string, unknown>, id: string): unknown {
  let v: unknown = mapping;
  for (const part of id.split(".")) {
    if (v === null || typeof v !== "object") {
      return undefined;
    }
    v = (v as Record<string, unknown>)[part];
  }
  return v === null ? undefined : v;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** a short rendering of a value the editor has no control for */
export function summarizeValue(v: unknown): string {
  if (Array.isArray(v)) {
    return `${v.length} item${v.length === 1 ? "" : "s"}`;
  }
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v as object);
    return keys.length ? `{${keys.join(", ")}}` : "{}";
  }
  return String(v);
}

/**
 * The three groups of a component's property rows (the PROVENANCE rule). `rows`
 * are the relevance/rarity verdicts for this component, `mapping` its parsed YAML
 * entry, `spec` the editor's knowledge of the kind. A declared key is ALWAYS in
 * `declared` — the ones relevance hid come after the visible ones; the `other`
 * list holds the declared keys the editor has no row for (lists, nested models),
 * so the panel still shows everything the file says.
 */
export function fieldGroups(
  rows: Rows,
  mapping: Record<string, unknown>,
  spec: FieldSpec
): FieldGroups {
  const isRequired = (id: string): boolean =>
    spec.required.includes(id) || Boolean(spec.requiredWhen?.[id]?.(mapping));
  const info = (id: string): FieldInfo => {
    const v = valueAt(mapping, id);
    const declared = v !== undefined;
    const def = spec.defaults[id];
    const required = isRequired(id);
    return {
      id,
      declared,
      required,
      resetNote: spec.resetNotes?.[id],
      modified: declared && !required && !sameValue(v, def),
      resettable: declared && !required,
      placeholder: def === undefined ? undefined : String(def),
    };
  };
  const visible = [...rows.basic, ...rows.advanced];
  const hidden = spec.rows.filter((r) => !visible.includes(r));
  const declared: FieldInfo[] = [];
  for (const id of [...visible, ...hidden]) {
    const f = info(id);
    if (f.declared && !declared.some((d) => d.id === id)) {
      declared.push(f);
    }
  }
  const common = rows.basic.map(info).filter((f) => !f.declared);
  const all = rows.advanced.map(info).filter((f) => !f.declared);
  const covered = (key: string): boolean =>
    spec.elsewhere.includes(key) || spec.rows.some((r) => r === key || r.startsWith(`${key}.`));
  const other: OtherField[] = [];
  for (const [key, v] of Object.entries(mapping)) {
    if (v !== undefined && v !== null && !covered(key)) {
      const required = isRequired(key);
      other.push({
        key,
        summary: summarizeValue(v),
        required,
        modified: !required && !(key in spec.defaults && sameValue(v, spec.defaults[key])),
      });
    }
  }
  return { declared, common, all, other };
}

/**
 * Is the inspector in BENCH scope? The bench-level sections (RAL, regression, tests,
 * clocks, resets, identity) belong to the bench, not to a component, so they render
 * only when no component is selected — which is exactly what selecting the
 * verification tree's root node produces (its `selectId` is null, so it reveals the
 * top level and selects nothing).
 */
export function isBenchScope(selectedNodeKind: string | undefined): boolean {
  return selectedNodeKind === undefined;
}
