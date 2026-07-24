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

import type { QuvmAgent, QuvmPort, QuvmScoreboard } from "./quickuvm";

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
  const basic = ["active", "mode"];
  const advanced = ["seq_item_style", "replicas"];
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
