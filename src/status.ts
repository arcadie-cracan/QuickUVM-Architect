// The quick-uvm status decorations (docs/05, phase 4) — a PURE MODULE, shared by
// the host (config.ts: findings -> semantic decorations) and the webview (main.ts:
// decorations -> the current view's ids). Tested in test:status, without DOM and
// without vscode. The decoration messages are ENGLISH: the webview is monolingual in
// the MVP (D19) — the localized diagnostics stay on the YAML file (config.ts).

import type { Finding } from "./configcheck";
import type { StatusDeco, StatusSeverity } from "./protocol";

/**
 * Translates the structured findings of the model<->YAML validation (checkConfig)
 * into SEMANTIC decorations for the diagram: port/agent/env targets, not text
 * spans. Port-level -> both the port (the RTL pin) and the owning agent (the
 * TB block); `port-orphan` does NOT target the port (it disappeared from the model —
 * there is no pin to decorate), only the agent.
 */
export function decosFromFindings(findings: Finding[]): StatusDeco[] {
  const out: StatusDeco[] = [];
  for (const f of findings) {
    const port = String(f.params.port ?? "");
    const agent = String(f.params.agent ?? "");
    switch (f.kind) {
      case "dut-missing":
        out.push({
          scope: "env",
          severity: f.severity,
          message: `DUT module "${String(f.params.module)}" does not exist in the current design`,
        });
        break;
      case "port-claimed": {
        const msg = `port "${port}" is already claimed by agent "${agent}"`;
        out.push({ scope: "port", port, severity: f.severity, message: msg });
        out.push({ scope: "agent", agent, severity: f.severity, message: msg });
        break;
      }
      case "port-orphan":
        // the port no longer exists in the model — there is no pin to decorate; only
        // the agent that claims it (graceful invalidation, docs/03)
        if (agent) {
          out.push({
            scope: "agent",
            agent,
            severity: f.severity,
            message: `port "${port}" no longer exists in the DUT`,
          });
        }
        break;
      case "width-mismatch": {
        const msg = `port "${port}": width ${String(f.params.declared)} in YAML, ${String(f.params.expected)} in the design`;
        out.push({ scope: "port", port, severity: f.severity, message: msg });
        if (agent) {
          out.push({ scope: "agent", agent, severity: f.severity, message: msg });
        }
        break;
      }
      case "ignored-and-mapped":
        out.push({
          scope: "port",
          port,
          severity: f.severity,
          message: `port "${port}" is both ignored and mapped to agent "${agent}"`,
        });
        break;
    }
  }
  return out;
}

/** the aggregated status of a decorated element: the maximum severity + the messages */
export interface ElementStatus {
  severity: StatusSeverity;
  messages: string[];
}

function addTo(
  map: Map<string, ElementStatus>,
  id: string,
  severity: StatusSeverity,
  message: string
): void {
  const cur = map.get(id);
  if (cur) {
    cur.messages.push(message);
    if (severity === "error") {
      cur.severity = "error"; // the error beats the warning
    }
  } else {
    map.set(id, { severity, messages: [message] });
  }
}

/** a node of the current RTL view, as much as the status mapping needs */
export interface StatusRtlCtx {
  /** the current view's module (schema: the instance's; symbol: the drawn one) */
  viewModule: string | null;
  /** the DUT module from YAML (overlay.dut); null without a configuration */
  dut: string | null;
  /** the scene nodes (schema only): the pins of the DUT instances get decorated */
  nodes: { id: string; module: string }[];
}

/**
 * The mapping of decorations onto the ids of an RTL view: the DUT ports get
 * decorated on the `<port>.X` flag/pin when the view ITSELF is the DUT, and on
 * the `<node>.X` pins of the DUT instances in a parent view. The agent/env
 * decorations have no RTL counterpart.
 */
export function statusIdsRtl(
  decos: StatusDeco[],
  ctx: StatusRtlCtx
): Map<string, ElementStatus> {
  const out = new Map<string, ElementStatus>();
  if (!ctx.dut) {
    return out;
  }
  for (const d of decos) {
    if (d.scope !== "port") {
      continue;
    }
    if (ctx.viewModule === ctx.dut) {
      addTo(out, `<port>.${d.port}`, d.severity, d.message);
    }
    for (const n of ctx.nodes) {
      if (n.module === ctx.dut) {
        addTo(out, `${n.id}.${d.port}`, d.severity, d.message);
      }
    }
  }
  return out;
}

/**
 * The mapping of decorations onto the ids of the current TB scene (`presentIds` = the
 * level's nodes): agent -> `agent:<nume>`; env -> the "env" node; at the root level
 * (agents are NOT visible, but env is), the agents' problems aggregate onto Env
 * (bubble-up) — otherwise the root would look clean with broken agents underneath.
 */
export function statusIdsTb(
  decos: StatusDeco[],
  presentIds: ReadonlySet<string>
): Map<string, ElementStatus> {
  const out = new Map<string, ElementStatus>();
  for (const d of decos) {
    if (d.scope === "port") {
      continue; // the DUT ports have no element of their own in the TB view
    }
    if (d.scope === "env") {
      if (presentIds.has("env")) {
        addTo(out, "env", d.severity, d.message);
      }
      continue;
    }
    const id = `agent:${d.agent}`;
    if (presentIds.has(id)) {
      addTo(out, id, d.severity, d.message);
    } else if (presentIds.has("env")) {
      addTo(out, "env", d.severity, `${d.agent}: ${d.message}`);
    }
  }
  return out;
}
