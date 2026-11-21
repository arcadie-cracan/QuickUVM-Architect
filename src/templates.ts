// "New testbench" templates (docs/08 R24) — pure, no vscode.
//
// Three starting points for a bench, each a FOLD of the existing text
// mutations over the skeleton of a new configuration — never a hand-written
// YAML: what a template writes is exactly what the corresponding gestures would
// have written one by one (`setDut`, `createAgent`, `addClockDomain`,
// `createSubenvs`, `addConnections`, …), so the result is the same readable
// YAML, without a key the user did not ask for.
//
//   per-interface  one agent per interface port and per pin group (the R12
//                  proposals), or one agent for the whole boundary when the
//                  names offer no group
//   per-clock      a `clock:` list with one domain per clock port, one agent per
//                  domain (the pins that carry the domain's tag), reset domains
//                  when the resets are per domain too
//   composition    the direct sub-blocks as subenvs, a block configuration with
//                  a boundary agent for each new one, the inter-block
//                  connections derived from the design
//
// Every plan says what it left out (`notes`); nothing is decided silently.
// Tested in `npm run test:templates` (and generated for real in `test:e2e`).

import {
  deriveConnections,
  directBlockChildren,
  planWireEdits,
  subenvMapping,
  subenvName,
} from "./compose";
import {
  CLOCK_QUALIFIER_RE,
  CLOCK_RE,
  DIR_SUFFIX_RE,
  RESET_RE,
  resetIsActiveLow,
  SV_IDENT_RE,
  SV_KEYWORDS,
} from "./heuristics";
import type { IfacePort, Instance, ModuleDef, Port, ProjectModel } from "./model";
import { agentProposals, connectedIface } from "./proposals";
import * as ops from "./yamlops";

export type TemplateId = "per-interface" | "per-clock" | "composition";

export const TEMPLATE_IDS: readonly TemplateId[] = ["per-interface", "per-clock", "composition"];

export const TEMPLATE_TITLES: Readonly<Record<TemplateId, string>> = {
  "per-interface": "One agent per interface",
  "per-clock": "One agent per clock domain",
  composition: "Composition from the sub-blocks",
};

export interface TemplateFile {
  /** the file name, next to the top configuration (`<module>.quickuvm.yaml`) */
  file: string;
  module: string;
  text: string;
  /** the file does not exist yet (false: an existing block config the plan edits) */
  created: boolean;
}

export interface TemplatePlan {
  id: TemplateId;
  /** the module the bench is for */
  module: string;
  /** the top configuration's file name and text */
  file: string;
  text: string;
  /** the block configurations (composition only) */
  children: TemplateFile[];
  /** what the plan creates, one line each */
  summary: string[];
  /** what it left out, and why — shown before anything is written */
  notes: string[];
}

export interface TemplateOffer {
  id: TemplateId;
  title: string;
  available: boolean;
  /** what it would create, or why it cannot */
  detail: string;
}

export interface TemplateOptions {
  seqItemStyle?: "manual" | "field_macros";
  /** block configurations that already exist next to the top one: file name ->
   *  text. They are never recreated; the composition may set their agents
   *  passive (as "Wire connections from design" does). */
  existing?: ReadonlyMap<string, string>;
}

/** a template that does not apply to this module — the message says why */
export class TemplateError extends Error {}

export const configFileOf = (module: string): string => `${module}.quickuvm.yaml`;

// ------------------------------------------------------------ shared pieces

const oneBitIn = (p: Port): boolean => p.dir === "in" && p.width === 1;
/** a reset by name. A name that says both (`clk_rst_n`, Qsys' `clk_reset_reset_n`)
 *  is a RESET: it resets, whatever clock it belongs to */
export const isResetPin = (p: Port): boolean => oneBitIn(p) && RESET_RE.test(p.name);
/** a clock by name — not a reset, and not a clock's enable / gate / select
 *  (`clk_en_i` is a data pin; `CLOCK_QUALIFIER_RE`) */
export const isClockPin = (p: Port): boolean =>
  oneBitIn(p) &&
  CLOCK_RE.test(p.name) &&
  !RESET_RE.test(p.name) &&
  !CLOCK_QUALIFIER_RE.test(p.name);

/** a port an agent can carry as it is: sized, not `ref`, not an unpacked array
 *  (the interactive flow ASKS about those; a template does not guess) */
const usable = (p: Port): boolean =>
  p.dir !== "ref" && p.width !== null && !p.unpacked_dims;

/**
 * The DUT section a module's ports suggest: the first clock-like and the first
 * reset-like 1-bit input, polarity from the name. The heuristic of "Set as DUT"
 * and of the subenv skeletons — one function, so the three cannot disagree.
 */
export function dutGuess(module: string, def: ModuleDef | undefined): ops.DutSpec {
  const ports = def?.ports ?? [];
  const clock = ports.find(isClockPin)?.name ?? null;
  const reset = ports.find(isResetPin)?.name ?? null;
  return {
    module,
    clock,
    reset,
    resetActiveLow: reset ? resetIsActiveLow(reset) : true,
    externalReset: false,
    combinational: !clock,
  };
}

interface PortSpecs {
  inputs: ops.AgentPortSpec[];
  outputs: ops.AgentPortSpec[];
  inouts: ops.AgentPortSpec[];
}

/** DUT pins as agent ports — the YAML directions are the DUT's (docs/03) */
function pinSpecs(ports: readonly Port[]): PortSpecs {
  const out: PortSpecs = { inputs: [], outputs: [], inouts: [] };
  for (const p of ports) {
    if (!usable(p)) {
      continue;
    }
    const spec = { name: p.name, width: p.width as number };
    (p.dir === "in" ? out.inputs : p.dir === "out" ? out.outputs : out.inouts).push(spec);
  }
  return out;
}

/** the signals of an interface port's modport as agent ports (the rules of
 *  "Agent from interface": the interface clock is the DUT's, not a port) */
function ifaceSpecs(
  model: ProjectModel,
  inst: Instance,
  ifp: IfacePort
): { specs: PortSpecs | null; skipped: string[] } {
  const iface = connectedIface(model, inst, ifp.name, ifp.interface)?.iface;
  const modport = iface?.modports[ifp.modport ?? ""];
  if (!iface || !modport) {
    return { specs: null, skipped: [] };
  }
  const widths = new Map(iface.signals.map((s) => [s.name, s.width]));
  const out: PortSpecs = { inputs: [], outputs: [], inouts: [] };
  // what the interactive flow reports as skipped is reported here too
  const skipped: string[] = [];
  for (const [signal, dir] of Object.entries(modport)) {
    const width = widths.get(signal) ?? null;
    if (width === 1 && CLOCK_RE.test(signal)) {
      continue; // the interface clock is the DUT's clock, by rule — not a port
    }
    if (width === null) {
      skipped.push(`${signal} (no fixed size)`);
    } else if (dir === "in") {
      out.inputs.push({ name: signal, width });
    } else if (dir === "out") {
      out.outputs.push({ name: signal, width });
    } else {
      skipped.push(`${signal} (${dir} in a modport is not supported)`);
    }
  }
  return { specs: out.inputs.length + out.outputs.length ? out : null, skipped };
}

const count = (s: PortSpecs): number => s.inputs.length + s.outputs.length + s.inouts.length;

const describe = (name: string, s: PortSpecs): string =>
  `agent "${name}": ${s.inputs.length} driven, ${s.outputs.length} sampled` +
  (s.inouts.length ? `, ${s.inouts.length} inout` : "");

/** a name an agent can have: an SV identifier, not a keyword, not taken */
const nameOk = (n: string, taken: ReadonlySet<string>): boolean =>
  SV_IDENT_RE.test(n) && !SV_KEYWORDS.has(n) && !taken.has(n);

/** the agent that carries a block's whole boundary; the module name is in it
 *  because composed blocks share ONE namespace (agent / interface / sequence
 *  item names must differ between block configurations) */
export const boundaryAgentName = (module: string): string => `${module}_a`;

function viewOf(model: ProjectModel, viewId: string): { inst: Instance; def: ModuleDef } {
  const inst = model.instances.find((i) => i.path === viewId);
  const def = inst && !inst.iface ? model.modules[inst.module] : undefined;
  if (!inst || !def) {
    throw new TemplateError("not a module of the design");
  }
  return { inst, def };
}

/** the skeleton + the DUT section: where every template starts */
function base(module: string, spec: ops.DutSpec): string {
  return ops.setDut(ops.newConfigText(module), spec);
}

// ------------------------------------------------------------ per interface

function planPerInterface(
  model: ProjectModel,
  viewId: string,
  opts: TemplateOptions
): TemplatePlan {
  const { inst, def } = viewOf(model, viewId);
  const module = inst.module;
  const spec = dutGuess(module, def);
  let text = base(module, spec);
  const summary: string[] = [];
  const notes: string[] = [];
  const taken = new Set<string>();
  const claimed = new Set<string>();

  // the same proposals the strip shows on the DUT's view (R12): interfaces,
  // then pin groups by prefix — computed against the bench as it stands now
  for (const p of agentProposals(model, viewId, ops.parseQuvm(text))) {
    const name = typeof p.args.name === "string" ? p.args.name : "";
    let specs: PortSpecs | null = null;
    if (p.kind === "agent-iface") {
      const ifp = def.iface_ports.find((x) => x.name === p.args.port);
      const r = ifp ? ifaceSpecs(model, inst, ifp) : { specs: null, skipped: [] };
      specs = r.specs;
      if (r.skipped.length) {
        notes.push(`interface ${name}: left out ${r.skipped.join(", ")}`);
      }
    } else if (p.kind === "agent-group") {
      const pins = new Set(
        (Array.isArray(p.args.pins) ? p.args.pins : []).map((id) =>
          String(id).replace(/^<port>\./, "")
        )
      );
      specs = pinSpecs(def.ports.filter((x) => pins.has(x.name)));
    }
    if (!specs || !count(specs)) {
      continue;
    }
    if (!nameOk(name, taken)) {
      notes.push(`"${name}" is not a usable agent name — its ${count(specs)} ports are left out`);
      continue;
    }
    text = ops.createAgent(text, { name, ...specs, seqItemStyle: opts.seqItemStyle });
    taken.add(name);
    for (const s of [...specs.inputs, ...specs.outputs, ...specs.inouts]) {
      claimed.add(s.name);
    }
    summary.push(describe(name, specs));
  }

  const free = def.ports.filter(
    (p) => !claimed.has(p.name) && p.name !== spec.clock && p.name !== spec.reset
  );
  const rest = free.filter((p) => usable(p) && !isClockPin(p) && !isResetPin(p));
  if (!taken.size && rest.length) {
    // the names offer no interface and no group: one agent for the boundary
    const name = boundaryAgentName(module);
    const specs = pinSpecs(rest);
    text = ops.createAgent(text, { name, ...specs, seqItemStyle: opts.seqItemStyle });
    taken.add(name);
    summary.push(`${describe(name, specs)} (no interface or name group: the whole boundary)`);
  } else if (rest.length) {
    notes.push(`without an agent (no name group): ${rest.map((p) => p.name).join(", ")}`);
  }
  // an interface port that got no agent (no modport, an instance that cannot be
  // resolved, nothing usable in it) is NAMED: the template's title promises one
  // agent per interface, and a missing one must not look like "none needed"
  for (const ifp of def.iface_ports) {
    if (!taken.has(ifp.name)) {
      notes.push(
        `interface port ${ifp.name} (${ifp.interface}${ifp.modport ? `.${ifp.modport}` : ", no modport"}): no agent — its signals could not be resolved; use "Agent from interface" on the diagram`
      );
    }
  }
  leftOut(notes, free);
  if (!taken.size) {
    throw new TemplateError("the module has no port an agent could carry");
  }
  summary.unshift(dutLine(spec));
  return { id: "per-interface", module, file: configFileOf(module), text, children: [], summary, notes };
}

/** the ports no template touches, said once */
function leftOut(notes: string[], free: readonly Port[]): void {
  const extra = free.filter((p) => isClockPin(p) || isResetPin(p));
  if (extra.length) {
    notes.push(
      `more clock / reset inputs than the bench declares: ${extra.map((p) => p.name).join(", ")}`
    );
  }
  const odd = free.filter((p) => !usable(p));
  if (odd.length) {
    notes.push(
      `ref / unsized / unpacked ports are not guessed: ${odd.map((p) => p.name).join(", ")} — add them from the diagram`
    );
  }
}

const dutLine = (s: ops.DutSpec): string =>
  `DUT ${s.module}: ` +
  (s.combinational ? "combinational" : `clock ${s.clock}`) +
  (s.reset ? `, reset ${s.reset} (active ${s.resetActiveLow ? "low" : "high"})` : ", no reset");

// ---------------------------------------------------------- per clock domain

/** the name with its trailing direction / polarity tokens gone (`src_rst_ni` → `src_rst`) */
function stemOf(name: string): string {
  let s = name;
  for (let i = 0; i < 2; i++) {
    s = s.replace(DIR_SUFFIX_RE, "");
  }
  return s;
}

/**
 * What is left of a clock / reset name once the clock / reset token is out: the
 * domain's TAG (`src_clk_i` → `src`, `clk_a` → `a`, `wclk` → `w`, `clk` → "").
 * `fused` says the token was glued to the tag (`wclk`), which makes the tag a
 * bare prefix of the domain's pins (`wdata`) instead of a `_`-separated one.
 */
export function domainTag(name: string, kind: "clock" | "reset"): { tag: string; fused: boolean } {
  const token = kind === "clock" ? "clock|clk" : "resetn|reset|rstn|rst";
  const stem = stemOf(name);
  const sep = new RegExp(`(^|_)(?:${token})(_|$)`, "i");
  const trim = (s: string): string => s.replace(/^_+|_+$/g, "");
  if (sep.test(stem)) {
    return { tag: trim(stem.replace(sep, (_m, a: string, b: string) => (a && b ? "_" : ""))), fused: false };
  }
  return { tag: trim(stem.replace(new RegExp(token, "i"), "")), fused: true };
}

interface Domain {
  clock: string;
  tag: string;
  fused: boolean;
  reset: string | null;
  pins: Port[];
}

/** the domain a pin belongs to by its name: null when no tag fits, "ambiguous"
 *  when several do and none is the longest */
function domainOf(pin: string, domains: readonly Domain[]): Domain | "ambiguous" | null {
  const stem = stemOf(pin).toLowerCase();
  const fits = (d: Domain): boolean => {
    const t = d.tag.toLowerCase();
    if (!t) {
      return false;
    }
    return d.fused
      ? stem.startsWith(t)
      : stem === t || stem.startsWith(`${t}_`) || stem.endsWith(`_${t}`);
  };
  const hits = domains.filter(fits);
  if (hits.length <= 1) {
    return hits[0] ?? null;
  }
  // nested tags (`a` and `a_b`): the longest one that fits, if it is alone
  const longest = Math.max(...hits.map((d) => d.tag.length));
  const best = hits.filter((d) => d.tag.length === longest);
  return best.length === 1 ? best[0] : "ambiguous";
}

function planPerClock(
  model: ProjectModel,
  viewId: string,
  opts: TemplateOptions
): TemplatePlan {
  const { inst, def } = viewOf(model, viewId);
  const module = inst.module;
  const clocks = def.ports.filter(isClockPin);
  if (clocks.length < 2) {
    throw new TemplateError(
      clocks.length
        ? `the module has one clock (${clocks[0].name}) — one domain needs no template`
        : "the module has no clock input"
    );
  }
  const domains: Domain[] = clocks.map((c) => ({
    clock: c.name,
    ...domainTag(c.name, "clock"),
    reset: null,
    pins: [],
  }));
  const notes: string[] = [];
  // an untagged clock (`clk` next to `fast_clk`) is the default domain: it
  // takes what no tag claims
  const fallback = domains.find((d) => !d.tag) ?? null;

  // resets: the one that carries a domain's tag is that domain's; an untagged
  // one is the default domain's, or — with no default — a reset every domain
  // shares. One that fits nowhere is NAMED below, never dropped.
  const resets = def.ports.filter(isResetPin);
  let shared: string | null = null;
  for (const r of resets) {
    const { tag } = domainTag(r.name, "reset");
    const d = tag ? domains.find((x) => x.tag.toLowerCase() === tag.toLowerCase()) : fallback;
    if (d && !d.reset) {
      d.reset = r.name;
    } else if (!tag && !fallback && !shared) {
      shared = r.name;
    }
  }

  const stray: string[] = [];
  const torn: string[] = [];
  for (const p of def.ports) {
    if (isClockPin(p) || isResetPin(p) || !usable(p)) {
      continue;
    }
    const hit = domainOf(p.name, domains);
    if (hit === "ambiguous") {
      torn.push(p.name); // two domains claim it: not the default domain's by default
      continue;
    }
    const d = hit ?? fallback;
    if (d) {
      d.pins.push(p);
    } else {
      stray.push(p.name);
    }
  }
  if (!domains.some((d) => d.pins.length)) {
    throw new TemplateError(
      "no pin carries a clock domain's name (" +
        domains.map((d) => d.tag || d.clock).join(", ") +
        ") — the domains cannot be told apart by name"
    );
  }

  // the bench: the first domain is the one `dut.clock` names; `addClockDomain`
  // turns the mapping into a list on the first add (the first domain keeps the
  // mapping's period and unit)
  const first = domains[0];
  // the reset entries, the DUT's first: each domain's own, then a shared one
  // (released on the first clock)
  const entries: { name: string; clock: string }[] = [
    ...domains.filter((d) => d.reset).map((d) => ({ name: d.reset as string, clock: d.clock })),
    ...(shared ? [{ name: shared, clock: first.clock }] : []),
  ];
  const dutReset = first.reset ?? shared ?? entries[0]?.name ?? null;
  entries.sort((a, b) => Number(b.name === dutReset) - Number(a.name === dutReset));
  const spec: ops.DutSpec = {
    module,
    clock: first.clock,
    reset: dutReset,
    resetActiveLow: dutReset ? resetIsActiveLow(dutReset) : true,
    externalReset: false,
    combinational: false,
  };
  let text = base(module, spec);
  for (const d of domains.slice(1)) {
    text = ops.addClockDomain(text, d.clock);
  }
  const summary = [dutLine(spec), `clock domains: ${domains.map((d) => d.clock).join(", ")}`];
  if (entries.length) {
    // ALWAYS a reset list under a clock list — even for one reset: quick-uvm's
    // multi-domain path reads only a list, and with the plain mapping it
    // generates NO reset and leaves the DUT's port unconnected, exit 0 (probed;
    // review finding). `resetAsList` names the first entry after `dut.reset`;
    // every entry says which clock its release is synchronised to.
    text = ops.resetAsList(text);
    for (const e of entries.slice(1)) {
      text = ops.addResetDomain(text, e.name);
    }
    for (const e of entries) {
      text = ops.setResetDomainField(text, e.name, "clock", e.clock);
      if (e.name !== dutReset && !resetIsActiveLow(e.name)) {
        // (the first entry carries the polarity `setDut` wrote)
        text = ops.setResetDomainField(text, e.name, "active_low", false);
      }
    }
    summary.push(`reset domains: ${entries.map((e) => `${e.name} (${e.clock})`).join(", ")}`);
  }
  const unbound = resets.filter((r) => !entries.some((e) => e.name === r.name));
  if (unbound.length) {
    notes.push(
      `reset${unbound.length === 1 ? "" : "s"} ${unbound.map((r) => r.name).join(", ")}: no clock domain by name — not declared; bind ${unbound.length === 1 ? "it" : "them"} by hand`
    );
  }

  const taken = new Set<string>();
  for (const d of domains) {
    if (!d.pins.length) {
      notes.push(`clock domain ${d.clock}: no pin carries its name — declared, without an agent`);
      continue;
    }
    const name = nameOk(d.tag, taken)
      ? d.tag
      : nameOk(stemOf(d.clock), taken)
        ? stemOf(d.clock)
        : boundaryAgentName(`${module}_${taken.size}`);
    const specs = pinSpecs(d.pins);
    text = ops.createAgent(text, { name, ...specs, seqItemStyle: opts.seqItemStyle });
    text = ops.setAgentField(text, name, "clock", d.clock);
    if (entries.length > 1 && d.reset) {
      // with one entry every agent is on it; with several, the agent's own is
      // written out (quick-uvm would pick the reset released on its clock —
      // the same one — but the YAML should not rely on a default to be read)
      text = ops.setAgentField(text, name, "reset", d.reset);
    } else if (entries.length > 1) {
      notes.push(`agent "${name}": its domain has no reset of its own — it follows ${dutReset}`);
    }
    taken.add(name);
    summary.push(`${describe(name, specs)}, on ${d.clock}`);
  }
  if (stray.length) {
    notes.push(`not on any clock domain by name: ${stray.join(", ")} — add them to an agent`);
  }
  if (torn.length) {
    notes.push(
      `claimed by more than one clock domain's name: ${torn.join(", ")} — not assigned; add them to the right agent`
    );
  }
  leftOut(notes, def.ports.filter((p) => !usable(p)));
  return { id: "per-clock", module, file: configFileOf(module), text, children: [], summary, notes };
}

// -------------------------------------------------------------- composition

function planComposition(
  model: ProjectModel,
  viewId: string,
  opts: TemplateOptions
): TemplatePlan {
  const { inst, def } = viewOf(model, viewId);
  const module = inst.module;
  const rels = directBlockChildren(model, viewId);
  if (rels.length < 2) {
    throw new TemplateError(
      rels.length
        ? "the module has one sub-block — quick-uvm composes two or more"
        : "the module has no sub-blocks to compose"
    );
  }
  const notes: string[] = [];
  const summary: string[] = [];
  const existing = opts.existing ?? new Map<string, string>();

  // one subenv per direct sub-block; two rels that sanitise to one name cannot
  // be told apart later (subenvMapping), so neither is composed
  const byName = new Map<string, string[]>();
  for (const rel of rels) {
    const n = subenvName(rel);
    byName.set(n, [...(byName.get(n) ?? []), rel]);
  }
  const chosen: { rel: string; name: string; child: Instance }[] = [];
  const carries = (mod: string): boolean =>
    (model.modules[mod]?.ports ?? []).some((p) => usable(p) && !isClockPin(p) && !isResetPin(p));
  for (const [name, list] of byName) {
    const child = model.instances.find((i) => i.path === `${viewId}.${list[0]}`);
    if (list.length > 1 || !child) {
      notes.push(`${list.join(", ")}: the same subenv name (${name}) — left out`);
      continue;
    }
    if (child.module === module) {
      // a recursive module (common_cells' popcount): its block configuration
      // would be the top's own file — composed into itself, listed twice
      notes.push(`${name}: an instance of ${module} itself — a bench cannot compose its own configuration; left out`);
      continue;
    }
    if (!existing.has(configFileOf(child.module)) && !carries(child.module)) {
      // quick-uvm refuses a block configuration without an agent ("At least
      // one agent must be defined"): composing it would write a bench that
      // does not generate
      notes.push(`${name} (${child.module}): no port an agent could carry — left out (quick-uvm refuses a block without an agent)`);
      continue;
    }
    chosen.push({ rel: list[0], name, child });
  }
  if (chosen.length < 2) {
    throw new TemplateError(
      "fewer than two sub-blocks can be composed" + (notes.length ? ` — ${notes.join("; ")}` : "")
    );
  }

  // the block configurations: one per MODULE (instances share it). A new one
  // gets the DUT section and one agent for the block's whole boundary — a
  // connection wires agent ports, so a block without an agent could not be wired
  const children = new Map<string, TemplateFile>();
  for (const c of chosen) {
    const mod = c.child.module;
    const file = configFileOf(mod);
    const same = chosen.filter((x) => x.child.module === mod);
    const params = new Set(same.map((x) => JSON.stringify(x.child.params)));
    if (children.has(mod)) {
      continue;
    }
    if (params.size > 1) {
      notes.push(
        `${mod}: its instances differ in parameters — one block configuration describes one of them (check the port widths)`
      );
    }
    const cdef = model.modules[mod];
    const old = existing.get(file);
    if (old !== undefined) {
      children.set(mod, { file, module: mod, text: old, created: false });
      continue;
    }
    const cspec = dutGuess(mod, cdef);
    let ctext = base(mod, cspec);
    const ports = (cdef?.ports ?? []).filter(
      (p) => usable(p) && !isClockPin(p) && !isResetPin(p)
    );
    // (a block with no usable port was left out above)
    const specs = pinSpecs(ports);
    const aname = boundaryAgentName(mod);
    ctext = ops.createAgent(ctext, { name: aname, ...specs, seqItemStyle: opts.seqItemStyle });
    summary.push(`${file}: ${describe(aname, specs)}`);
    if ((cdef?.ports ?? []).filter(isClockPin).length > 1) {
      notes.push(`${mod}: several clocks — quick-uvm composes single-clock blocks only`);
    }
    if (cdef?.iface_ports.length) {
      notes.push(`${mod}: its interface ports are not in the boundary agent — add them from the diagram`);
    }
    children.set(mod, { file, module: mod, text: ctext, created: true });
  }
  for (const c of chosen) {
    if (Object.keys(c.child.params).length) {
      notes.push(
        `${c.name}: ${Object.entries(c.child.params).map(([k, v]) => `${k}=${v}`).join(", ")} — the block configuration uses the elaborated widths; no \`params:\` are passed`
      );
    }
  }

  // the top: a pure subsystem shell (createSubenvs makes it combinational), then
  // the connections the design draws between the blocks — the plan of "Wire
  // connections from design", which also sets the destination agents passive
  const subenvs = chosen.map((c) => ({ name: c.name, config: configFileOf(c.child.module), params: {} }));
  let text = ops.createSubenvs(base(module, dutGuess(module, def)), subenvs);
  summary.unshift(`${chosen.length} subenvs: ${chosen.map((c) => c.name).join(", ")}`);
  const mapping = subenvMapping(model, viewId, chosen.map((c) => c.name));
  const derived = deriveConnections(model, viewId, mapping.subenvOf);
  notes.push(...derived.warnings);
  if (derived.connections.length) {
    const files = new Map(
      [...children.values()].map((c) => [c.file, { key: c.file, text: c.text }])
    );
    const plan = planWireEdits(text, subenvs, derived, files);
    text = plan.topText;
    for (const [file, t] of plan.childTexts) {
      const c = [...children.values()].find((x) => x.file === file);
      if (c) {
        c.text = t;
        (c as TemplateFile & { edited?: boolean }).edited = true;
      }
    }
    summary.push(
      `${derived.connections.length} connection${derived.connections.length === 1 ? "" : "s"}: ` +
        derived.connections.map((c) => `${c.from} → ${c.to}`).join(", ")
    );
    if (plan.passivated.length) {
      summary.push(`passive (driven by a neighbour): ${plan.passivated.join(", ")}`);
    }
    if (plan.manual.length) {
      notes.push(`no agent to set passive on: ${plan.manual.join(", ")} — quick-uvm will ask for one`);
    }
  } else {
    notes.push("the design draws no connection between these blocks");
  }
  // an existing block configuration the plan did not change is not a file of the plan
  const files = [...children.values()].filter(
    (c) => c.created || (c as TemplateFile & { edited?: boolean }).edited === true
  );
  return {
    id: "composition",
    module,
    file: configFileOf(module),
    text,
    children: files.map(({ file, module: m, text: t, created }) => ({ file, module: m, text: t, created })),
    summary,
    notes,
  };
}

// --------------------------------------------------------------- the public

/**
 * Plans a template for the module of an instance path. Throws `TemplateError`
 * when the template does not apply (the message says why).
 */
export function planTemplate(
  model: ProjectModel,
  viewId: string,
  id: TemplateId,
  opts: TemplateOptions = {}
): TemplatePlan {
  switch (id) {
    case "per-interface":
      return planPerInterface(model, viewId, opts);
    case "per-clock":
      return planPerClock(model, viewId, opts);
    case "composition":
      return planComposition(model, viewId, opts);
  }
}

/** the three templates for a module: what each would create, or why it cannot */
export function templateOffers(
  model: ProjectModel,
  viewId: string,
  opts: TemplateOptions = {}
): TemplateOffer[] {
  return TEMPLATE_IDS.map((id) => {
    try {
      const plan = planTemplate(model, viewId, id, opts);
      return { id, title: TEMPLATE_TITLES[id], available: true, detail: plan.summary.join(" • ") };
    } catch (e) {
      // a TemplateError says the template does not apply; anything else is a
      // mutation (or a shape of the user's files) refusing — an offer that
      // cannot be planned is unavailable WITH the reason, never an exception
      // that takes the other two offers down with it (review finding)
      const why = e instanceof Error ? e.message : String(e);
      return {
        id,
        title: TEMPLATE_TITLES[id],
        available: false,
        detail: e instanceof TemplateError ? why : `cannot be planned: ${why}`,
      };
    }
  });
}
