// Designer assistance (docs/08 R12) — the proposals a bench could accept, computed
// on the HOST from the model, the configuration and the resolved topology. PURE
// (no vscode), tested in Node (scripts/test-proposals.mjs); the webview only
// renders the strip and sends back what the user checked (`applyProposals`).
//
// The rules follow the SoC assemblers the pattern comes from (Vivado's Designer
// Assistance, SmartDesign's Auto Connect, Platform Designer's BFM per exported
// interface): NEVER automatic — every proposal is accepted or dismissed by the
// user — and ambiguous ⇒ NO proposal (SmartDesign's rule), because a wrong
// heuristic applied once costs more than a missing hint. Every proposal is an
// existing host action with its arguments filled in, so accepting one writes the
// YAML through the same path the palette buttons use.
//
// Four sources:
//   agent-iface  — a DUT interface port with no agent yet (`createAgentFromIface`);
//   agent-group  — DUT pins sharing a prefix (`in_*`, `out0_*`, `s_axi_*`: the
//                  name up to its LAST underscore), two or more, none claimed by an
//                  agent, none a clock/reset/waived port: an agent named after the
//                  prefix (`createAgentFromPins` with the name preset);
//   connections  — a subsystem (two or more subenvs) whose composed blocks are
//                  wired in the design but not in the YAML (`wireConnections`,
//                  through `deriveConnections` — the same derivation the gesture runs);
//   materialize  — on an implicit-mode bench (no `analysis:` key) the components
//                  quick-uvm INFERS (the ghosts, src/resolved.ts): "write them into
//                  the YAML". Accepting materialises the WHOLE inferred set at once
//                  and the unchecked members become absent — `analysis:` is written,
//                  so the generator leaves implicit mode. These are the two sharp
//                  edges docs/07 asked to design for before ghosts became editable.

import { deriveConnections, subenvMapping } from "./compose";
import { CLOCK_RE, DIR_SUFFIX_RE, RESET_RE, SV_IDENT_RE } from "./heuristics";
import type { Instance, ModuleDef, Port, ProjectModel } from "./model";
import type { Proposal, ProposalSet, ViewMode } from "./protocol";
import type { QuvmAgent, QuvmConfig } from "./quickuvm";
import { inferredComponents, type ResolvedConfig } from "./resolved";

/**
 * The interface instance connected to `portName` of `inst`: through the parent's
 * view when the connection is known, otherwise the sole instance of that
 * interface type in the design (two candidates = unknown, never a guess).
 * Shared by the proposals and by `createAgentFromIface` (src/actions.ts).
 */
export function connectedIface(
  model: ProjectModel,
  inst: Instance,
  portName: string,
  ifaceModule: string
): Instance | undefined {
  // the parent = the longest instance path that is a proper prefix of the current path
  let parent: Instance | undefined;
  for (const i of model.instances) {
    if (
      inst.path.startsWith(i.path + ".") &&
      (!parent || i.path.length > parent.path.length)
    ) {
      parent = i;
    }
  }
  if (parent) {
    const rel = inst.path.slice(parent.path.length + 1);
    const view = model.views[parent.path];
    const pin = view?.pins.find((p) => p.pin === `${rel}.${portName}`);
    if (pin?.conn && pin.conn.kind === "iface") {
      const base = pin.conn.ref.split(".")[0];
      const found = model.instances.find(
        (i) => i.path === `${parent.path}.${base}`
      );
      if (found?.iface) {
        return found;
      }
    }
  }
  // fallback: the sole instance of that interface type in the design
  const candidates = model.instances.filter(
    (i) => i.module === ifaceModule && i.iface
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function viewInstance(
  model: ProjectModel,
  viewId: string
): { inst: Instance; def: ModuleDef } | null {
  const inst = model.instances.find((i) => i.path === viewId);
  const def = inst ? model.modules[inst.module] : undefined;
  return inst && def ? { inst, def } : null;
}

/** the port names an agent declares, on every side */
function portNames(agent: QuvmAgent): string[] {
  return [
    ...(agent.ports?.inputs ?? []),
    ...(agent.ports?.outputs ?? []),
    ...(agent.ports?.inouts ?? []),
  ]
    .map((p) => p.name)
    .filter((n): n is string => Boolean(n));
}

/**
 * The agents the DUT could still get: one per interface port without an agent,
 * one per pin group (common prefix) no agent claims. Only on the DUT's own view
 * — another module's pins are not the bench's.
 */
export function agentProposals(
  model: ProjectModel,
  viewId: string,
  config: QuvmConfig
): Proposal[] {
  const v = viewInstance(model, viewId);
  const dut = config.dut;
  if (!v || !dut?.name || dut.name !== v.inst.module) {
    return [];
  }
  const { inst, def } = v;
  const agents = (config.agents ?? []).filter(
    (a): a is QuvmAgent & { name: string } => Boolean(a.name)
  );
  const names = new Set(agents.map((a) => a.name));
  const dutPorts = new Set(def.ports.map((p) => p.name));
  const out: Proposal[] = [];

  // interfaces without an agent: covered when an agent carries the port's name
  // (the default of createAgentFromIface) or declares only modport signals —
  // and is not a pin agent whose DUT port names merely coincide with them
  for (const ifp of def.iface_ports) {
    const ifaceInst = connectedIface(model, inst, ifp.name, ifp.interface);
    const modport = ifaceInst?.iface?.modports[ifp.modport ?? ""];
    if (!modport) {
      continue; // the host flow would refuse it: no proposal (ambiguous instance / modport)
    }
    const signals = Object.keys(modport);
    const sigSet = new Set(signals);
    const covered = agents.some((a) => {
      if (a.name === ifp.name) {
        return true;
      }
      const ps = portNames(a);
      return (
        ps.length > 0 && ps.every((p) => sigSet.has(p)) && !ps.every((p) => dutPorts.has(p))
      );
    });
    if (covered) {
      continue;
    }
    out.push({
      id: `iface:${ifp.name}`,
      kind: "agent-iface",
      label: `Agent "${ifp.name}" from interface ${ifp.interface}${ifp.modport ? `.${ifp.modport}` : ""}`,
      detail: `${signals.length} signals: ${signals.join(", ")}`,
      action: "createAgentFromIface",
      args: { viewId, port: ifp.name, name: ifp.name },
    });
  }

  // pin groups by prefix (the name up to its LAST underscore): two or more free
  // pins; clocks/resets by role or by name, waived ports, ref/unsized/unpacked
  // ports stay out (the host flow would skip or ask about them)
  const claimed = new Set(agents.flatMap(portNames));
  const waived = new Set(dut.unverified_ports ?? []);
  const groups = new Map<string, Port[]>();
  for (const p of def.ports) {
    if (
      claimed.has(p.name) ||
      waived.has(p.name) ||
      p.name === dut.clock ||
      p.name === dut.reset ||
      p.dir === "ref" ||
      p.width === null ||
      p.unpacked_dims
    ) {
      continue;
    }
    if (p.dir === "in" && p.width === 1 && (CLOCK_RE.test(p.name) || RESET_RE.test(p.name))) {
      continue;
    }
    // a trailing direction token is not a group: with the bare last underscore,
    // PULP `valid_i`/`valid_o` paired an input with its own output under "valid"
    // and `src_valid_i` never reached its real group `src` (reproduced on
    // common_cells at the review — the fixture is in test:proposals)
    const stem = p.name.replace(DIR_SUFFIX_RE, "");
    const us = stem.lastIndexOf("_");
    if (us <= 0) {
      continue; // no prefix: a lone pin is not a proposal (which agent? ambiguous)
    }
    const prefix = stem.slice(0, us);
    const members = groups.get(prefix) ?? [];
    members.push(p);
    groups.set(prefix, members);
  }
  for (const [prefix, members] of groups) {
    // an agent of that name that does NOT claim these pins = ambiguous, no proposal
    if (members.length < 2 || !SV_IDENT_RE.test(prefix) || names.has(prefix)) {
      continue;
    }
    out.push({
      id: `group:${prefix}`,
      kind: "agent-group",
      label: `Agent "${prefix}" from ${members.length} pins ${prefix}_*`,
      detail: members.map((p) => p.name).join(", "),
      action: "createAgentFromPins",
      args: { viewId, pins: members.map((p) => `<port>.${p.name}`), name: prefix },
    });
  }
  return out;
}

/**
 * A subsystem (two or more subenvs) whose composed blocks the design wires but
 * the YAML does not: the same derivation the "Wire connections from design"
 * gesture runs, offered before the user looks for the button. Only when every
 * block involved already has an agent (`childAgents`, by subenv name): the wire
 * cables agent ports, and quick-uvm refuses a sink without one — a one-click
 * proposal must not lead into a config generate rejects. Ambiguous subenv
 * names or a derivation warning = no proposal.
 */
export function connectionsProposal(
  model: ProjectModel,
  viewId: string,
  config: QuvmConfig,
  childAgents: Record<string, string[]>
): Proposal[] {
  const v = viewInstance(model, viewId);
  if (!v || !config.dut?.name || config.dut.name !== v.inst.module) {
    return [];
  }
  const subenvs = (config.subenvs ?? [])
    .map((s) => s.name)
    .filter((n): n is string => Boolean(n));
  if (subenvs.length < 2 || (config.connections ?? []).length > 0) {
    return [];
  }
  const mapping = subenvMapping(model, viewId, subenvs);
  const derived = deriveConnections(model, viewId, mapping.subenvOf);
  if (!derived.connections.length || derived.warnings.length || mapping.ambiguous.length) {
    return [];
  }
  const involved = new Set(
    derived.connections.flatMap((c) => [c.from.split(".")[0], c.to.split(".")[0]])
  );
  for (const s of involved) {
    if (!(childAgents[s] ?? []).length) {
      return []; // a block without an agent cannot be wired yet
    }
  }
  const n = derived.connections.length;
  return [
    {
      id: "connections",
      kind: "connections",
      label: `Wire ${n} connection${n === 1 ? "" : "s"} between the composed blocks`,
      detail: derived.connections.map((c) => `${c.from} → ${c.to}`).join(", "),
      action: "wireConnections",
      args: { viewId },
    },
  ];
}

/**
 * On an implicit-mode bench (no `analysis:` key), the components quick-uvm
 * infers, one row each — accepting writes the `analysis:` block with the checked
 * ones (src/actions.ts `materializeInferred`). Nothing when the config already
 * declares `analysis:` (nothing is inferred then) or when nothing resolved.
 */
export function ghostProposals(
  config: QuvmConfig,
  resolved: ResolvedConfig | null | undefined
): Proposal[] {
  // undefined or null (`analysis:` with no value): both implicit, as the scene
  // draws the ghosts — the strip and the diagram must agree
  if (config.analysis != null) {
    return [];
  }
  return inferredComponents(resolved).map((c) => ({
    id: `ghost:${c.id}`,
    kind: "materialize",
    label:
      c.kind === "scoreboard"
        ? `Scoreboard "${c.name}" fed by ${c.source}`
        : `Coverage on ${c.name}`,
    detail: "inferred by quick-uvm (implicit mode) — not in the YAML",
    action: "applyProposals",
    args: {},
  }));
}

/** the proposal set of a view: ghosts in the verification view, agents and
 *  connections in the RTL views (both need the model and a configuration) */
export function proposalsFor(
  model: ProjectModel | undefined,
  viewId: string,
  mode: ViewMode | undefined,
  config: QuvmConfig | null,
  resolved: ResolvedConfig | null,
  childAgents: Record<string, string[]> = {}
): ProposalSet {
  const items: Proposal[] = [];
  if (config) {
    if (mode === "tb") {
      items.push(...ghostProposals(config, resolved));
    } else if (model) {
      items.push(
        ...agentProposals(model, viewId, config),
        ...connectionsProposal(model, viewId, config, childAgents)
      );
    }
  }
  return { viewId, mode: mode ?? "symbol", items };
}
