// Decoratiile de stare quick-uvm (docs/05, faza 4) — MODUL PUR, partajat de
// host (config.ts: findings -> decoratii semantice) si de webview (main.ts:
// decoratii -> id-urile vederii curente). Testat in test:status, fara DOM si
// fara vscode. Mesajele decoratilor sunt ENGLEZA: webview-ul e monolingv in
// MVP (D19) — diagnosticele localizate raman pe fisierul YAML (config.ts).

import type { Finding } from "./configcheck";
import type { StatusDeco, StatusSeverity } from "./protocol";

/**
 * Traduce findings-urile structurate ale validarii model<->YAML (checkConfig)
 * in decoratii SEMANTICE pentru diagrama: tinte port/agent/env, nu span-uri de
 * text. Port-level -> si portul (pinul RTL), si agentul proprietar (blocul
 * TB); `port-orphan` NU tinteste portul (a disparut din model — nu exista pin
 * de decorat), doar agentul.
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
      case "hybrid":
        out.push({
          scope: "env",
          severity: f.severity,
          message:
            "a bench with subenvs must not define its own agents (hybrid rejected by quick-uvm)",
        });
        break;
      case "port-claimed": {
        const msg = `port "${port}" is already claimed by agent "${agent}"`;
        out.push({ scope: "port", port, severity: f.severity, message: msg });
        out.push({ scope: "agent", agent, severity: f.severity, message: msg });
        break;
      }
      case "port-orphan":
        // portul nu mai exista in model — nu exista pin de decorat; doar
        // agentul care il revendica (invalidare gratioasa, docs/03)
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

/** starea agregata a unui element decorat: severitatea maxima + mesajele */
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
      cur.severity = "error"; // eroarea bate avertismentul
    }
  } else {
    map.set(id, { severity, messages: [message] });
  }
}

/** un nod al vederii RTL curente, cat ii trebuie maparii de status */
export interface StatusRtlCtx {
  /** modulul vederii curente (schema: al instantei; simbol: cel desenat) */
  viewModule: string | null;
  /** modulul DUT din YAML (overlay.dut); null fara configuratie */
  dut: string | null;
  /** nodurile scenei (doar schema): pinii instantelor de DUT se decoreaza */
  nodes: { id: string; module: string }[];
}

/**
 * Maparea decoratilor pe id-urile unei vederi RTL: porturile DUT-ului se
 * decoreaza pe steagul/pinul `<port>.X` cand vederea INSASI e DUT-ul si pe
 * pinii `<nod>.X` ai instantelor de DUT dintr-o vedere-parinte. Decoratiile
 * agent/env nu au corespondent RTL.
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
 * Maparea decoratilor pe id-urile scenei TB curente (`presentIds` = nodurile
 * nivelului): agent -> `agent:<nume>`; env -> nodul "env"; la nivelul-radacina
 * (agentii NU sunt vizibili, env da), problemele agentilor se agrega pe Env
 * (bubble-up) — altfel radacina ar parea curata cu agenti stricati dedesubt.
 */
export function statusIdsTb(
  decos: StatusDeco[],
  presentIds: ReadonlySet<string>
): Map<string, ElementStatus> {
  const out = new Map<string, ElementStatus>();
  for (const d of decos) {
    if (d.scope === "port") {
      continue; // porturile DUT n-au element propriu in vederea TB
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
