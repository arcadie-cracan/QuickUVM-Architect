// The "Signals" view's model (docs/08 R24) — pure, no vscode.
//
// The bench's clock and reset domains as a tree, with the agents under the
// domain they are on. Under a domain LIST an agent without a `clock:` /
// `reset:` of its own is in an "Unconnected" folder, which says where the
// generator puts it instead of hiding the default (probed on quick-uvm 1.1.0):
//   clock — the FIRST domain of the list (not the one `dut.clock` names);
//   reset — the reset RELEASED ON THE AGENT'S CLOCK (the entry whose `clock:`
//           is that clock), and only without one, the first entry.
// Dragging an agent onto a domain writes that key; onto "Unconnected", removes
// it. With a single clock or reset (a mapping) there is nothing to assign —
// and an agent that names one anyway is refused by the generator, so it is
// flagged. A clock list with a plain reset MAPPING generates no reset at all:
// that is said on the reset's row.
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
  /** a reset domain: the clock its release is synchronised to */
  clock?: string;
}

interface Domains {
  listed: boolean;
  domains: DomainInfo[];
  /** a mapping: the name an agent's own key may carry ("" = none is accepted) */
  declared?: string;
}

/** the declared clock domains; `listed` = a LIST (agents can be assigned) */
function clockDomains(cfg: QuvmConfig): Domains {
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
  // the row is labelled with the DUT's clock PORT; the single clock's own name
  // (what an agent's `clock:` would have to say) is `clock.name`, default "clk"
  const declared = (typeof map.name === "string" && map.name) || "clk";
  const name = (typeof cfg.dut?.clock === "string" && cfg.dut.clock) || declared;
  return { listed: false, domains: [{ name, description: describe(map) }], declared };
}

function resetDomains(cfg: QuvmConfig): Domains {
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
          ...(typeof d.clock === "string" && d.clock ? { clock: d.clock } : {}),
        })),
    };
  }
  const name = typeof cfg.dut?.reset === "string" ? cfg.dut.reset : "";
  if (!name) {
    return { listed: false, domains: [] };
  }
  const map = isObj(raw) ? raw : {};
  // quick-uvm's multi-domain path (a clock LIST) reads only a reset list, or
  // `external: true`: with the plain mapping no reset is generated and the
  // DUT's reset port stays unconnected, exit 0 (probed on 1.1.0)
  const unwired = Array.isArray(cfg.clock) && map.external !== true;
  return {
    listed: false,
    domains: [
      {
        name,
        description:
          polarity(map) +
          (map.external === true ? ", external (not driven by the bench)" : "") +
          (unwired
            ? " — NOT GENERATED: with a clock list quick-uvm needs the reset declared as a domain (Add Reset Domain)"
            : ""),
      },
    ],
    declared: "", // an agent `reset:` under a single reset is refused ("not a declared reset")
  };
}

/** the value of an agent's own `clock:` / `reset:` key ("" = none) */
const ownKey = (a: QuvmAgent, field: SignalField): string => {
  const v = (a as Record<string, unknown>)[field];
  return typeof v === "string" ? v : "";
};

function group(
  field: SignalField,
  label: string,
  info: Domains,
  agents: readonly QuvmAgent[],
  empty: string,
  /** resets only: the clock domain an agent samples (its own, or the first) */
  clockOf?: (a: QuvmAgent) => string
): SignalNode {
  const root: SignalNode = { id: field, kind: "group", label, field, children: [] };
  if (!info.domains.length) {
    root.children.push({ id: `${field}:none`, kind: "note", label: empty, children: [] });
    return root;
  }
  // a TreeItem id must be unique in the tree: two agents (or two entries) with
  // one name — a copy mid-edit — get a `#n` suffix instead of colliding
  const seen = new Map<string, number>();
  const uid = (id: string): string => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}#${n}`;
  };
  const agentNode = (a: QuvmAgent, parent: string, description?: string): SignalNode => ({
    id: uid(`${parent}/${a.name}`),
    kind: "agent",
    label: a.name ?? "?",
    description,
    field,
    agent: a.name,
    ...(a.from_vip ? { fixed: "a VIP reference: its clocking is the VIP's" } : {}),
    children: [],
  });
  const named = agents.filter((a) => a.name);
  const own = (a: QuvmAgent): string => ownKey(a, field);
  if (!info.listed) {
    // one domain: every agent is on it, by construction — nothing to assign.
    // An agent that names one ANYWAY is refused by the generator unless it is
    // the single clock's own name ("not a declared clock / reset"): flagged
    const d = info.domains[0];
    root.children.push({
      id: `${field}:${d.name}`,
      kind: "domain",
      label: d.name,
      description: d.description,
      field,
      domain: d.name,
      children: named.map((a) =>
        agentNode(
          a,
          `${field}:${d.name}`,
          own(a) && own(a) !== info.declared
            ? `${field}: ${own(a)} — not a declared ${field}: quick-uvm refuses it (remove the key)`
            : undefined
        )
      ),
    });
    return root;
  }
  const declared = new Set(info.domains.map((d) => d.name));
  for (const d of info.domains) {
    const id = uid(`${field}:${d.name}`);
    root.children.push({
      id,
      kind: "domain",
      label: d.name,
      description: d.description,
      field,
      domain: d.name,
      children: named.filter((a) => own(a) === d.name).map((a) => agentNode(a, id)),
    });
  }
  // no key of their own — or one naming a domain that is not declared, which
  // quick-uvm refuses: shown here with what it says, never dropped from the tree
  const loose = named.filter((a) => !declared.has(own(a)));
  const first = info.domains[0].name;
  // where the generator puts an agent with no key: a clock — the first domain;
  // a reset — the one released on the agent's clock, else the first
  const lands = (a: QuvmAgent): string =>
    (clockOf && info.domains.find((d) => d.clock && d.clock === clockOf(a))?.name) || first;
  root.children.push({
    id: `${field}:`,
    kind: "unassigned",
    label: "Unconnected",
    description:
      (loose.length ? "" : "none — ") +
      (clockOf
        ? `quick-uvm gives each the reset released on its clock, else ${first}`
        : `quick-uvm puts these on ${first}, the first domain`),
    field,
    domain: "",
    children: loose.map((a) =>
      agentNode(
        a,
        `${field}:`,
        own(a)
          ? `${field}: ${own(a)} — not a declared domain`
          : a.from_vip
            ? "VIP reference"
            : `→ ${lands(a)}`
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
  const clocks = clockDomains(config);
  // the clock an agent samples: its own when that is a declared domain, else
  // the first (under a mapping there is one)
  const clockNames = new Set(clocks.domains.map((d) => d.name));
  const clockOf = (a: QuvmAgent): string => {
    const own = ownKey(a, "clock");
    return clocks.listed && clockNames.has(own) ? own : clocks.domains[0]?.name ?? "";
  };
  return [
    group("clock", "Clocks", clocks, agents, "no clock"),
    group("reset", "Resets", resetDomains(config), agents, "no reset (dut.reset is empty)", clockOf),
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
