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
 *  (`quickuvm.reset-undriven:<repair>:<port>`, repair = external | clear) */
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
  /** the DUT's reset port is driven by nobody — {port, repair, why?}: `dut.reset`
   *  names a port, the single-reset mapping is not `external: true` and no agent
   *  declares the port. quick-uvm (1.1.0) accepts it, exits 0 and emits a tb_top
   *  that connects the DUT to `<first agent>_if_inst.<port>`, a signal that
   *  interface does not have — the bench does not elaborate. `repair` is what
   *  fixes it: `external` (the testbench top drives the reset) or `clear`
   *  (`dut.reset: ''`), the latter with `why`: `no-port` (the model's DUT has no
   *  such port) or `reset-port` (an agent drives the reset through `reset_port`,
   *  and quick-uvm refuses `external: true` next to it). Carries `code`. */
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
  // When the model KNOWS the DUT and it has no port of that name (typically the
  // key left to its `rst_n` default on a DUT without a reset, or a typo), the
  // generated top is just as broken — but `external: true` would not repair it
  // (the DUT has no such pin): the repair on offer is `dut.reset: ''`.
  const undriven = undrivenReset(cfg);
  if (undriven) {
    const noPort = Boolean(def) && !modelPorts.has(undriven.port);
    const repair = noPort ? "clear" : undriven.repair;
    findings.push({
      kind: "reset-undriven",
      span:
        spanOf(ydoc.getIn(["dut", "reset"], true)) ??
        spanOf(ydoc.getIn(["dut", "name"], true)),
      severity: "error",
      params: {
        port: undriven.port,
        repair,
        ...(repair === "clear" ? { why: noPort ? "no-port" : "reset-port" } : {}),
      },
      code: `${RESET_CODE}:${repair}:${undriven.port}`,
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
 * Deliberately silent where the generator wires no reset, or the YAML alone
 * cannot tell:
 *   - a combinational DUT — quick-uvm connects no reset at all and refuses
 *     `external: true` on it, so there is neither a dangling reference nor this
 *     repair (a hand-written `dut: {combinational: true}` with the key absent
 *     would otherwise be flagged for a port it does not have);
 *   - `kind: selftest` (a DUT-less top: no reset reference) and `kind: vip` (no
 *     top at all);
 *   - a PURE subsystem top (subenvs, no agents of its own) — it instantiates
 *     no DUT of its own, its `dut.reset` is ignored;
 *   - a bench with a `from_vip` agent — the referenced agent's ports live in
 *     the VIP manifest, not in this file.
 *
 * `repair` is `clear` when an agent has a `reset_port` (an agent-driven reset:
 * quick-uvm refuses `external: true` next to it, so the answer is
 * `dut.reset: ''`), `external` otherwise.
 */
export function undrivenReset(
  cfg: QuvmConfig
): { port: string; repair: "external" | "clear" } | null {
  const dut = cfg.dut;
  if (!dut?.name || dut.combinational === true) {
    return null;
  }
  if (cfg.kind === "selftest" || cfg.kind === "vip") {
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
  // `yes` / `on` are booleans to the generator's YAML 1.1 loader, strings to ours
  const external = (reset as { external?: unknown } | null | undefined)?.external;
  if (external === true || (typeof external === "string" && /^(true|yes|on|y)$/i.test(external))) {
    return null;
  }
  const agents = (cfg.agents ?? []).filter((a) => a && typeof a === "object");
  if (!agents.length && (cfg.subenvs ?? []).length) {
    return null;
  }
  let repair: "external" | "clear" = "external";
  for (const a of agents) {
    if (a.from_vip) {
      return null;
    }
    if (typeof a.reset_port === "string" && a.reset_port) {
      repair = "clear";
    }
    for (const side of ["inputs", "outputs", "inouts"] as const) {
      const list = a.ports?.[side];
      if (Array.isArray(list) && list.some((p) => p && p.name === port)) {
        return null;
      }
    }
  }
  return { port, repair };
}
