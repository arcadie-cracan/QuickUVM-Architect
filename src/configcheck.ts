// The model<->YAML validations (docs/03) as a PURE core (no vscode) — testable
// in Node (scripts/test-configcheck.mjs). The function returns structured
// FINDINGS (kind + span + params + code), and the host (config.ts) maps
// them onto vscode.Diagnostic with the messages localized via l10n.t (D19:
// the visible strings stay in the host). NOTE (quick-uvm >= 1.0.0): the hybrid
// `subenvs` + `agents` is LEGAL now (boundary agents, H2) — the old
// hard "hybrid" diagnostic was REMOVED; do not reintroduce it.

import { Document, isMap, isSeq } from "yaml";
import type { ProjectModel } from "./model";
import { coveredAgent } from "./coverage";
import { isCrossBlockSb, scoreboardNodeIds } from "./quickuvm";
import type { QuvmConfig } from "./quickuvm";

/** the prefix of the diagnostic code that carries the width quick-fix */
export const WIDTH_CODE = "quickuvm.width";
/** the prefix of the diagnostic code that carries the reset quick-fix
 *  (`quickuvm.reset-undriven:<port>`) */
export const RESET_CODE = "quickuvm.reset-undriven";

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
  | "ignored-and-mapped"
  /** analysis.scoreboards[i].{source|monitor} names no agent of this config —
   *  {sb, field, agent}; quick-uvm refuses it only at generate (docs/08 R3) */
  | "sb-unknown-agent"
  /** an analysis.coverage entry names no agent of this config — {agent} */
  | "cov-unknown-agent"
  /** the DUT's reset port is driven by nobody — {port}: `dut.reset` names a port,
   *  the single-reset mapping is not `external: true` and no agent declares the
   *  port. quick-uvm (1.1.0) accepts it, exits 0 and emits a tb_top that connects
   *  the DUT to `<first agent>_if_inst.<port>`, a signal that interface does not
   *  have — the bench does not elaborate. Carries `code` (the quick-fix). */
  | "reset-undriven";

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
  // docs/08 R3 — analysis endpoints that name no agent of THIS config. quick-uvm
  // refuses them, but only at generate; here the scoreboard / coverage box gets a
  // broken input stub and an error badge, with the repair one click away. The
  // cross-block endpoints (`<subenv>.<agent>`) live in other files — not checked.
  const agentNames = new Set(
    agents.map((a) => a.name).filter((n): n is string => Boolean(n))
  );
  const subenvNames = new Set(
    (cfg.subenvs ?? []).map((s) => s.name).filter((n): n is string => Boolean(n))
  );
  const sbsNode = ydoc.getIn(["analysis", "scoreboards"]);
  const sbIds = scoreboardNodeIds(cfg);
  (cfg.analysis?.scoreboards ?? []).forEach((sb, i) => {
    if (isCrossBlockSb(sb, subenvNames)) {
      return;
    }
    const node = isSeq(sbsNode) ? sbsNode.items[i] : undefined;
    for (const field of ["source", "monitor"] as const) {
      const agent = sb[field];
      if (agent && !agentNames.has(agent)) {
        const drawn = sbIds[i];
        findings.push({
          kind: "sb-unknown-agent",
          span: spanOf(isMap(node) ? node.get(field, true) : undefined) ?? spanOf(node),
          severity: "error",
          // `sb` names the entry for the message; `node` is the diagram id of the
          // box (the ONE scheme, `#n` on repeated names; absent when the entry is
          // not drawn); `named` says whether a by-name repair can target it
          params: {
            sb: sb.name ?? "sbd",
            field,
            agent,
            named: sb.name ? 1 : 0,
            ...(drawn ? { node: drawn.id.slice("sb:".length) } : {}),
          },
        });
      }
    }
  });
  const covNode = ydoc.getIn(["analysis", "coverage"]);
  (cfg.analysis?.coverage ?? []).forEach((entry, i) => {
    const agent = coveredAgent(entry);
    if (agent && !agentNames.has(agent)) {
      findings.push({
        kind: "cov-unknown-agent",
        span: spanOf(isSeq(covNode) ? covNode.items[i] : undefined),
        severity: "error",
        params: { agent },
      });
    }
  });
  // When the model KNOWS the DUT and it has no port of that name, this is a
  // different defect (`dut.reset` names a pin that is not there — typically the
  // key left to its `rst_n` default on a DUT without a reset); `external: true`
  // would not repair it, so it is not reported as this one.
  const undriven = undrivenReset(cfg);
  if (undriven && !(def && !modelPorts.has(undriven))) {
    findings.push({
      kind: "reset-undriven",
      span:
        spanOf(ydoc.getIn(["dut", "reset"], true)) ??
        spanOf(ydoc.getIn(["dut", "name"], true)),
      severity: "error",
      params: { port: undriven },
      code: `${RESET_CODE}:${undriven}`,
    });
  }
  return { findings, orphans };
}

/**
 * The reset port nobody drives, or null. A YAML-internal rule (model or not),
 * replicating what quick-uvm 1.1.0 GENERATES rather than what it validates — it
 * validates nothing here (probed, Nov 2026):
 *
 *   - `dut.reset` absent defaults to `rst_n`; `''` means "no reset port";
 *   - a `reset:` LIST is always driven by tb_top (one generator per domain);
 *   - `reset: {external: true}` is driven by tb_top;
 *   - a port an agent declares (inputs / outputs / inouts) is wired to that
 *     agent's interface, which then has the signal.
 *
 * Deliberately silent where the YAML alone cannot tell:
 *   - a combinational DUT — quick-uvm connects no reset at all and refuses
 *     `external: true` on it, so there is neither a dangling reference nor this
 *     repair (a hand-written `dut: {combinational: true}` with the key absent
 *     would otherwise be flagged for a port it does not have);
 *   - a PURE subsystem top (subenvs, no agents of its own) — it instantiates
 *     no DUT of its own, its `dut.reset` is ignored;
 *   - a bench with a `from_vip` agent — the referenced agent's ports live in
 *     the VIP manifest, not in this file.
 */
export function undrivenReset(cfg: QuvmConfig): string | null {
  const dut = cfg.dut;
  if (!dut?.name || dut.combinational === true) {
    return null;
  }
  const port = dut.reset === undefined || dut.reset === null ? "rst_n" : dut.reset;
  if (typeof port !== "string" || !port) {
    return null;
  }
  const reset: unknown = cfg.reset;
  if (Array.isArray(reset)) {
    return null;
  }
  if ((reset as { external?: unknown } | undefined)?.external === true) {
    return null;
  }
  const agents = cfg.agents ?? [];
  if (!agents.length && (cfg.subenvs ?? []).length) {
    return null;
  }
  for (const a of agents) {
    if (a.from_vip) {
      return null;
    }
    for (const side of ["inputs", "outputs", "inouts"] as const) {
      if ((a.ports?.[side] ?? []).some((p) => p.name === port)) {
        return null;
      }
    }
  }
  return port;
}
