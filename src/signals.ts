// The "Signals" view's model (docs/08 R24) — pure, no vscode.
//
// The bench's clock and reset domains as a tree, with the agents under the
// domain they are on. Under a domain LIST an agent without a `clock:` /
// `reset:` of its own is in an "Unconnected" folder: quick-uvm puts it on the
// FIRST domain of the list (probed on 1.1.0 — the first entry, not the one
// `dut.clock` names), and the folder says so instead of hiding the default.
// Dragging an agent onto a domain writes that key; onto "Unconnected", removes
// it. With a single clock or reset (a mapping) there is nothing to assign.
//
// Tested in `npm run test:signals`.

import type { QuvmAgent, QuvmConfig } from "./quickuvm";

export type SignalField = "clock" | "reset";

export interface SignalNode {
  id: string;
  kind: "group" | "domain" | "unassigned" | "agent" | "note";
  label: string;
  description?: string;
  /** group / domain / unassigned / agent: which key the subtree is about */
  field?: SignalField;
  /** domain: its name; unassigned: "" */
  domain?: string;
  /** agent: its name */
  agent?: string;
  /** agent: why it cannot be dragged (a VIP reference takes no `clock:`) */
  fixed?: string;
  children: SignalNode[];
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

interface DomainInfo {
  name: string;
  description: string;
}

/** the declared clock domains; `listed` = a LIST (agents can be assigned) */
function clockDomains(cfg: QuvmConfig): { listed: boolean; domains: DomainInfo[] } {
  const describe = (d: Record<string, unknown>): string =>
    `${typeof d.period === "number" ? d.period : 10} ${typeof d.unit === "string" ? d.unit : "ns"}` +
    (d.source === "dut" ? " — driven by the DUT" : "");
  const raw = cfg.clock as unknown;
  if (Array.isArray(raw)) {
    return {
      listed: true,
      domains: raw
        .filter(isObj)
        .filter((d) => typeof d.name === "string" && d.name)
        .map((d) => ({ name: d.name as string, description: describe(d) })),
    };
  }
  const map = isObj(raw) ? raw : {};
  const name =
    (typeof map.name === "string" && map.name) ||
    (typeof cfg.dut?.clock === "string" && cfg.dut.clock) ||
    "clk";
  return { listed: false, domains: [{ name, description: describe(map) }] };
}

function resetDomains(cfg: QuvmConfig): { listed: boolean; domains: DomainInfo[] } {
  const raw = cfg.reset as unknown;
  const polarity = (d: Record<string, unknown>): string =>
    d.active_low === false ? "active high" : "active low";
  if (Array.isArray(raw)) {
    return {
      listed: true,
      domains: raw
        .filter(isObj)
        .filter((d) => typeof d.name === "string" && d.name)
        .map((d) => ({
          name: d.name as string,
          description:
            polarity(d) +
            (typeof d.clock === "string" && d.clock ? `, released on ${d.clock}` : "") +
            (cfg.dut?.reset === d.name ? " — the DUT's reset port" : ""),
        })),
    };
  }
  const name = typeof cfg.dut?.reset === "string" ? cfg.dut.reset : "";
  if (!name) {
    return { listed: false, domains: [] };
  }
  const map = isObj(raw) ? raw : {};
  return {
    listed: false,
    domains: [
      {
        name,
        description: polarity(map) + (map.external === true ? ", external (not driven by the bench)" : ""),
      },
    ],
  };
}

function group(
  field: SignalField,
  label: string,
  info: { listed: boolean; domains: DomainInfo[] },
  agents: readonly QuvmAgent[],
  empty: string
): SignalNode {
  const root: SignalNode = { id: field, kind: "group", label, field, children: [] };
  if (!info.domains.length) {
    root.children.push({ id: `${field}:none`, kind: "note", label: empty, children: [] });
    return root;
  }
  const agentNode = (a: QuvmAgent, parent: string, description?: string): SignalNode => ({
    id: `${parent}/${a.name}`,
    kind: "agent",
    label: a.name ?? "?",
    description,
    field,
    agent: a.name,
    ...(a.from_vip ? { fixed: "a VIP reference: its clocking is the VIP's" } : {}),
    children: [],
  });
  const named = agents.filter((a) => a.name);
  if (!info.listed) {
    // one domain: every agent is on it, by construction — nothing to assign
    const d = info.domains[0];
    root.children.push({
      id: `${field}:${d.name}`,
      kind: "domain",
      label: d.name,
      description: d.description,
      field,
      domain: d.name,
      children: named.map((a) => agentNode(a, `${field}:${d.name}`)),
    });
    return root;
  }
  const declared = new Set(info.domains.map((d) => d.name));
  const own = (a: QuvmAgent): string => {
    const v = (a as Record<string, unknown>)[field];
    return typeof v === "string" ? v : "";
  };
  for (const d of info.domains) {
    root.children.push({
      id: `${field}:${d.name}`,
      kind: "domain",
      label: d.name,
      description: d.description,
      field,
      domain: d.name,
      children: named
        .filter((a) => own(a) === d.name)
        .map((a) => agentNode(a, `${field}:${d.name}`)),
    });
  }
  // no key of their own — or one naming a domain that is not declared, which
  // quick-uvm refuses: shown here with what it says, never dropped from the tree
  const loose = named.filter((a) => !declared.has(own(a)));
  root.children.push({
    id: `${field}:`,
    kind: "unassigned",
    label: "Unconnected",
    description: `${loose.length ? "" : "none — "}quick-uvm puts these on ${info.domains[0].name}, the first domain`,
    field,
    domain: "",
    children: loose.map((a) =>
      agentNode(
        a,
        `${field}:`,
        own(a) ? `${field}: ${own(a)} — not a declared domain` : a.from_vip ? "VIP reference" : undefined
      )
    ),
  });
  return root;
}

/** the tree: a "Clocks" and a "Resets" group; [] without a configuration */
export function buildSignalsTree(config: QuvmConfig | null | undefined): SignalNode[] {
  if (!config || !config.dut?.name) {
    return [];
  }
  const agents = list<QuvmAgent>(config.agents).filter(isObj) as QuvmAgent[];
  return [
    group("clock", "Clocks", clockDomains(config), agents, "no clock"),
    group("reset", "Resets", resetDomains(config), agents, "no reset (dut.reset is empty)"),
  ];
}

export type DropPlan =
  | { ok: true; field: SignalField; value: string; agents: string[] }
  | { ok: false; reason: string };

/**
 * What dropping agents on a node writes: the node decides the KEY (a clock
 * domain sets `clock:`, a reset domain `reset:`) and the value ("" on
 * "Unconnected": the key goes). Refused where there is nothing to assign — a
 * single clock or reset — and for a VIP reference; an agent already there is
 * left out, and a drop that changes nothing is refused rather than written.
 */
export function dropPlan(
  config: QuvmConfig | null | undefined,
  target: Pick<SignalNode, "kind" | "field" | "domain"> | undefined,
  agentNames: readonly string[]
): DropPlan {
  if (!config || !target || !target.field || (target.kind !== "domain" && target.kind !== "unassigned")) {
    return { ok: false, reason: "drop an agent on a clock or reset domain" };
  }
  const field = target.field;
  const info = field === "clock" ? clockDomains(config) : resetDomains(config);
  if (!info.listed) {
    return {
      ok: false,
      reason: `the bench has one ${field}: every agent is on it — add a ${field} domain first`,
    };
  }
  const value = target.kind === "unassigned" ? "" : target.domain ?? "";
  if (value && !info.domains.some((d) => d.name === value)) {
    return { ok: false, reason: `${value} is not a declared ${field} domain` };
  }
  const byName = new Map(
    (list<QuvmAgent>(config.agents).filter(isObj) as QuvmAgent[]).map((a) => [a.name, a])
  );
  const agents: string[] = [];
  for (const n of new Set(agentNames)) {
    const a = byName.get(n);
    if (!a) {
      continue;
    }
    if (a.from_vip) {
      return { ok: false, reason: `${n} is a VIP reference: its ${field} is the VIP's` };
    }
    const cur = (a as Record<string, unknown>)[field];
    if ((typeof cur === "string" ? cur : "") !== value) {
      agents.push(n);
    }
  }
  if (!agents.length) {
    return { ok: false, reason: "already there" };
  }
  return { ok: true, field, value, agents };
}
