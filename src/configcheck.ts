// Validarile model<->YAML (docs/03) ca nucleu PUR (fara vscode) — testabile
// in Node (scripts/test-configcheck.mjs). Functia intoarce FINDINGS
// structurate (kind + span + parametri + cod), iar host-ul (config.ts) le
// mapeaza pe vscode.Diagnostic cu mesajele localizate prin l10n.t (D19:
// sirurile vizibile raman in host). Capcana reala blocata aici: hibridul
// `subenvs` + `agents` nevid e INTERZIS de quick-uvm curent (sondat empiric,
// docs/03) — diagnosticul dur trebuie emis pe blocul `agents`.

import { Document, isMap, isSeq } from "yaml";
import type { ProjectModel } from "./model";
import type { QuvmConfig } from "./quickuvm";

/** prefixul codului de diagnostic purtator al quick-fix-ului de latime */
export const WIDTH_CODE = "quickuvm.width";

export type FindingKind =
  /** dut.name nu exista in modelul curent — {module} */
  | "dut-missing"
  /** subenvs + agents nevid (hibrid interzis de quick-uvm) */
  | "hybrid"
  /** port revendicat de doi agenti — {port, agent} (primul proprietar) */
  | "port-claimed"
  /** port disparut din modul — {port, dut}; intra si in `orphans` */
  | "port-orphan"
  /** latime YAML != model — {port, declared, expected}; poarta `code` */
  | "width-mismatch"
  /** port si ignorat, si mapat pe agent — {port, agent} */
  | "ignored-and-mapped";

export interface Finding {
  kind: FindingKind;
  /** [start, end) in text; null = inceputul documentului */
  span: [number, number] | null;
  severity: "error" | "warning";
  params: Record<string, string | number>;
  /** codul purtator de quick-fix (`quickuvm.width:agent:port:latime`) */
  code?: string;
}

export interface CheckResult {
  findings: Finding[];
  /** porturile de agent disparute din model (invalidare gratioasa) */
  orphans: string[];
}

/** Span-ul unui nod yaml ([start, valEnd] din range), sau null. */
function spanOf(node: unknown): [number, number] | null {
  const r = (node as { range?: [number, number, number] } | null)?.range;
  return r ? [r[0], r[1]] : null;
}

/** Nodul CST al portului agents[ai].ports[side][pi], pentru span precis. */
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

/** Validarile model<->YAML; ordinea findings = ordinea de emitere istorica. */
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

  // hibridul e INTERZIS de quick-uvm curent: un bench cu `subenvs` NU poate
  // avea agenti proprii — un nivel de compunere e subsistem PUR. `agents: []`
  // sau absent e OK; doar NEVID + `subenvs` se refuza (altfel `generate`
  // esueaza). Diagnostic DUR pe blocul `agents`.
  if (cfg.subenvs?.length && cfg.agents?.length) {
    findings.push({
      kind: "hybrid",
      span: spanOf(ydoc.getIn(["agents"], true)),
      severity: "error",
      params: {},
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
            // `agent` nu apare in mesajul l10n, dar decoratiile de stare
            // (decosFromFindings, src/status.ts) tintesc blocul agentului
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
              // quick-fix-ul citeste tinta din cod (config -> CodeAction)
              code: `${WIDTH_CODE}:${agentName}:${p.name}:${expected}`,
            });
          }
        }
      });
    }
  });

  for (const ignored of cfg.x_quickuvm_architect?.ignored_ports ?? []) {
    if (claimedBy.has(ignored)) {
      findings.push({
        kind: "ignored-and-mapped",
        span: spanOf(
          ydoc.getIn(["x_quickuvm_architect", "ignored_ports"], true)
        ),
        severity: "warning",
        params: { port: ignored, agent: claimedBy.get(ignored) ?? "" },
      });
    }
  }
  return { findings, orphans };
}
