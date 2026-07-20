// The model<->YAML validations (docs/03) as a PURE core (no vscode) — testable
// in Node (scripts/test-configcheck.mjs). The function returns structured
// FINDINGS (kind + span + params + code), and the host (config.ts) maps
// them onto vscode.Diagnostic with the messages localized via l10n.t (D19:
// the visible strings stay in the host). NOTE (quick-uvm >= 1.0.0): the hybrid
// `subenvs` + `agents` is LEGAL now (boundary agents, H2) — the old
// hard "hybrid" diagnostic was REMOVED; do not reintroduce it.

import { Document, isMap, isSeq } from "yaml";
import type { ProjectModel } from "./model";
import type { QuvmConfig } from "./quickuvm";

/** the prefix of the diagnostic code that carries the width quick-fix */
export const WIDTH_CODE = "quickuvm.width";

export type FindingKind =
  /** dut.name does not exist in the current model — {module} */
  | "dut-missing"
  /** port claimed by two agents — {port, agent} (the first owner) */
  | "port-claimed"
  /** port that disappeared from the module — {port, dut}; also enters `orphans` */
  | "port-orphan"
  /** YAML width != model — {port, declared, expected}; carries `code` */
  | "width-mismatch"
  /** port both waived (dut.unverified_ports) and mapped to an agent — {port, agent};
   *  quick-uvm 1.0 rejects the combination at generate, so the severity is error */
  | "ignored-and-mapped";

export interface Finding {
  kind: FindingKind;
  /** [start, end) in the text; null = the start of the document */
  span: [number, number] | null;
  severity: "error" | "warning";
  params: Record<string, string | number>;
  /** the code carrying the quick-fix (`quickuvm.width:agent:port:latime`) */
  code?: string;
}

export interface CheckResult {
  findings: Finding[];
  /** the agent ports that disappeared from the model (graceful invalidation) */
  orphans: string[];
}

/** The span of a yaml node ([start, valEnd] from range), or null. */
function spanOf(node: unknown): [number, number] | null {
  const r = (node as { range?: [number, number, number] } | null)?.range;
  return r ? [r[0], r[1]] : null;
}

/** The CST node of the agents[ai].ports[side][pi] port, for a precise span. */
function getPortNode(
  agentsNode: unknown,
  ai: number,
  side: "inputs" | "outputs",
  pi: number
): unknown {
  if (!isSeq(agentsNode)) {
    return undefined;
  }
  const agent = agentsNode.items[ai];
  if (!isMap(agent)) {
    return undefined;
  }
  const list = agent.getIn(["ports", side]);
  return isSeq(list) ? list.items[pi] : undefined;
}

/** The model<->YAML validations; findings order = the historical emission order. */
export function checkConfig(
  ydoc: Document,
  cfg: QuvmConfig,
  model: ProjectModel | undefined
): CheckResult {
  const findings: Finding[] = [];
  const orphans: string[] = [];
  const dutName = cfg.dut?.name;
  const def = model && dutName ? model.modules[dutName] : undefined;

  if (model && dutName && !def) {
    findings.push({
      kind: "dut-missing",
      span: spanOf(ydoc.getIn(["dut", "name"], true)),
      severity: "warning",
      params: { module: dutName },
    });
  }

  const modelPorts = new Map((def?.ports ?? []).map((p) => [p.name, p.width]));
  const claimedBy = new Map<string, string>();
  const agentsNode = ydoc.getIn(["agents"]);
  const agents = cfg.agents ?? [];

  agents.forEach((agent, ai) => {
    const agentName = agent.name;
    if (!agentName) {
      return;
    }
    for (const side of ["inputs", "outputs"] as const) {
      const list = agent.ports?.[side] ?? [];
      list.forEach((p, pi) => {
        if (!p.name) {
          return;
        }
        const span = spanOf(getPortNode(agentsNode, ai, side, pi));

        const prev = claimedBy.get(p.name);
        if (prev && prev !== agentName) {
          findings.push({
            kind: "port-claimed",
            span,
            severity: "error",
            params: { port: p.name, agent: prev },
          });
        } else {
          claimedBy.set(p.name, agentName);
        }

        if (def && !modelPorts.has(p.name)) {
          orphans.push(p.name);
          findings.push({
            kind: "port-orphan",
            span,
            severity: "warning",
            // `agent` does not appear in the l10n message, but the status
            // decorations (decosFromFindings, src/status.ts) target the agent block
            params: { port: p.name, dut: dutName ?? "", agent: agentName },
          });
        } else if (def) {
          const expected = modelPorts.get(p.name);
          const declared = p.width ?? 1;
          if (typeof expected === "number" && expected !== declared) {
            findings.push({
              kind: "width-mismatch",
              span,
              severity: "warning",
              params: { port: p.name, declared, expected, agent: agentName },
              // the quick-fix reads the target from the code (config -> CodeAction)
              code: `${WIDTH_CODE}:${agentName}:${p.name}:${expected}`,
            });
          }
        }
      });
    }
  });

  // quick-uvm >= 1.0.0 REJECTS at generate a waived port that an agent
  // connects ("connected by agent ... Remove it from one side"), so
  // the diagnostic replicates the generator's wall: ERROR severity, not warning.
  for (const ignored of cfg.dut?.unverified_ports ?? []) {
    if (claimedBy.has(ignored)) {
      findings.push({
        kind: "ignored-and-mapped",
        span: spanOf(ydoc.getIn(["dut", "unverified_ports"], true)),
        severity: "error",
        params: { port: ignored, agent: claimedBy.get(ignored) ?? "" },
      });
    }
  }
  return { findings, orphans };
}
