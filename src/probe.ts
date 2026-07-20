// Proposal of a whitebox probe (K2, docs/03/06) from a net selected in the
// schematic view: resolving the DUT instance, the XMR path relative to it and
// the net WIDTH. PURE module (does not import `vscode`, does not touch the YAML): the host
// (actions.ts) uses it to build `probes[]`, and the tests
// run it directly in Node (`npm run test:probe`).
//
// The constraints below are NOT invented — they are probed empirically on
// quick-uvm 0.9.2 (`quick_uvm/models.py` ProbeConfig + validate_probes):
//   - `probes` + `subenvs` => hard error (H1: they don't work on a subsystem bench);
//   - the probe name collides in the tb_top/config-DB namespace with the names
//     of the agent interfaces and ports, with the clock and with the reset;
//   - `path` is glued VERBATIM after `dut_inst.` in tb_top, so it is relative to
//     the DUT instance and is not validated by the generator (a wrong path passes silently).

import type { Instance, ProjectModel } from "./model";
import type { QuvmConfig } from "./quickuvm";

export interface ProbeProposal {
  /** the probe name: SV identifier derived from the net name */
  name: string;
  /** the XMR path RELATIVE to the DUT instance (quick-uvm glues it after `dut_inst.`) */
  path: string;
  /** the width in bits; null = not derivable from the model (the host requires it) */
  width: number | null;
  /** names already taken: other probes + agent interfaces/ports + clock + reset */
  taken: string[];
}

export type ProbeCheck =
  | { ok: true; proposal: ProbeProposal }
  | { ok: false; reason: string };

/**
 * The DUT instance under which the current view lies. The YAML gives the DUT as a
 * MODULE NAME, not as an instance (docs/03), and a module can be instantiated
 * multiple times: only the instances that are an ancestor-or-itself of the view are
 * chosen, and among them the LONGEST one (the closest ancestor, for a nested module).
 */
export function resolveDutInstance(
  model: ProjectModel,
  dutModule: string,
  viewId: string
): Instance | null {
  const cands = model.instances.filter(
    (i) =>
      i.module === dutModule &&
      (viewId === i.path || viewId.startsWith(`${i.path}.`))
  );
  if (!cands.length) {
    return null;
  }
  return cands.reduce((a, b) => (b.path.length > a.path.length ? b : a));
}

/** The probe path: the elaborated path of the net MINUS the DUT instance path. */
export function probePath(
  viewId: string,
  dutPath: string,
  netName: string
): string | null {
  if (viewId === dutPath) {
    return netName;
  }
  if (viewId.startsWith(`${dutPath}.`)) {
    return `${viewId.slice(dutPath.length + 1)}.${netName}`;
  }
  return null; // the view is not under the DUT: the path makes no sense
}

/**
 * The width of a net. It is NOT in the model (`ViewNet` = {name, endpoints, fanout,
 * render}), so it is DERIVED — and the naive derivation is WRONG:
 *
 *   - `ch_out` has 48 bits (soc_top's port), but all the pin-endpoints are
 *     16-bit ports touched through `select`;
 *   - `din` has 8 bits, but the pin `g_ch[0].u_ch.din` is a 16-bit port through
 *     `concat {din,din}`.
 *
 * (proof in `examples/model.json`). So the width is taken ONLY from an endpoint
 * that is the SAME signal: the view module's own port (svmodel names
 * the net with the port name) or a child pin connected with the WHOLE NET
 * (`conn.kind === "net"`) — never through select/concat/expr.
 */
export function netWidth(
  model: ProjectModel,
  viewId: string,
  netName: string
): { width: number | null; unpacked: boolean } {
  const view = model.views[viewId];
  const net = view?.nets.find((n) => n.name === netName);
  if (!view || !net) {
    return { width: null, unpacked: false };
  }
  // (a) the view module's own port: authoritative (the same declared signal)
  if (net.endpoints.includes(`<port>.${netName}`)) {
    const p = model.modules[view.module]?.ports.find((x) => x.name === netName);
    if (p) {
      return { width: p.width, unpacked: Boolean(p.unpacked_dims?.length) };
    }
  }
  // (b) a child pin tied to the WHOLE net
  for (const ep of net.endpoints) {
    if (ep.startsWith("<port>.")) {
      continue;
    }
    const pin = view.pins.find((p) => p.pin === ep);
    if (pin?.conn?.kind !== "net" || pin.conn.net !== netName) {
      continue; // select / concat / expr: the port width is NOT the net's
    }
    const dot = ep.lastIndexOf(".");
    if (dot < 0) {
      continue;
    }
    const inst = model.instances.find(
      (i) => i.path === `${viewId}.${ep.slice(0, dot)}`
    );
    const p = inst
      ? model.modules[inst.module]?.ports.find(
          (x) => x.name === ep.slice(dot + 1)
        )
      : undefined;
    if (p) {
      return { width: p.width, unpacked: Boolean(p.unpacked_dims?.length) };
    }
  }
  return { width: null, unpacked: false }; // all endpoints pass through select/concat
}

/** The net name, sanitized as a SystemVerilog identifier (QuickUVM requirement). */
export function probeName(netName: string): string {
  const s = netName.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(s) ? s : `p_${s}`;
}

/**
 * The RESERVED names in the probe namespace. QuickUVM refuses a probe whose name
 * collides with an agent interface or port, with the clock or with the reset
 * (all end up in the same tb_top / config-DB) — plus, obviously, with another probe.
 */
export function reservedNames(config: QuvmConfig): string[] {
  const out = new Set<string>();
  for (const p of config.probes ?? []) {
    if (p.name) {
      out.add(p.name);
    }
  }
  for (const a of config.agents ?? []) {
    if (a.interface) {
      out.add(a.interface);
    }
    for (const p of [...(a.ports?.inputs ?? []), ...(a.ports?.outputs ?? [])]) {
      if (p.name) {
        out.add(p.name);
      }
    }
  }
  if (config.dut?.clock) {
    out.add(config.dut.clock);
  }
  if (config.dut?.reset) {
    out.add(config.dut.reset);
  }
  return [...out];
}

/**
 * Can functional coverage be OFFERED on a probe of this config? A real BUG in
 * quick-uvm 0.9.2: with `layout: packaged`, env_pkg does NOT include probe_monitor
 * (the type stays unknown, the testbench does not compile) — so on packaged
 * configs coverage is not offered at all (K2 pitfall #1, CLAUDE.md).
 */
export function probeCoverageAllowed(config: QuvmConfig): boolean {
  return (config as { layout?: unknown }).layout !== "packaged";
}

/** The DUT ports already mapped to an agent (a probe on them is redundant). */
function agentPortNames(config: QuvmConfig): Set<string> {
  const out = new Set<string>();
  for (const a of config.agents ?? []) {
    for (const p of [...(a.ports?.inputs ?? []), ...(a.ports?.outputs ?? [])]) {
      if (p.name) {
        out.add(p.name);
      }
    }
  }
  return out;
}

/**
 * Proposes a probe for the selected net, or says WHY it is not possible.
 * The messages are in English (D19): the host shows them directly to the user.
 */
export function proposeProbe(
  model: ProjectModel,
  config: QuvmConfig,
  viewId: string,
  netName: string
): ProbeCheck {
  // H1 (probed on 0.9.2): `probes` + `subenvs` => ValueError, exit 1
  if (config.subenvs?.length) {
    return {
      ok: false,
      reason:
        "QuickUVM does not support whitebox probes on a subsystem bench (a config with `subenvs`). Probe the block's own config instead.",
    };
  }
  const dutModule = config.dut?.name;
  if (!dutModule) {
    return { ok: false, reason: 'no DUT is configured yet — use "Set as DUT" first.' };
  }
  const view = model.views[viewId];
  if (!view) {
    return { ok: false, reason: `the view "${viewId}" has no nets in the model.` };
  }
  const net = view.nets.find((n) => n.name === netName);
  if (!net) {
    return { ok: false, reason: `net "${netName}" does not exist in this view.` };
  }
  const dut = resolveDutInstance(model, dutModule, viewId);
  if (!dut) {
    return {
      ok: false,
      reason: `the current view is not inside the DUT ("${dutModule}") — a probe path is relative to the DUT instance.`,
    };
  }
  const path = probePath(viewId, dut.path, netName);
  if (path === null) {
    return { ok: false, reason: "the current view is not inside the DUT instance." };
  }
  // an INTERFACE port is not a probeable signal (a probe is a flat vector)
  if (model.modules[view.module]?.iface_ports.some((p) => p.name === netName)) {
    return {
      ok: false,
      reason: `"${netName}" is an interface, not a signal — it cannot be probed.`,
    };
  }
  const isOwnPort = net.endpoints.includes(`<port>.${netName}`);
  // a DUT port already mapped to an agent: the probe would be redundant AND the name
  // would collide in tb_top (QuickUVM refuses) — the agent already observes it
  if (isOwnPort && viewId === dut.path && agentPortNames(config).has(netName)) {
    return {
      ok: false,
      reason: `"${netName}" is a DUT port already mapped to an agent — it is observed there; a probe would be redundant.`,
    };
  }
  const w = netWidth(model, viewId, netName);
  if (w.unpacked) {
    return {
      ok: false,
      reason: `"${netName}" is an unpacked array — a QuickUVM probe is a flat vector, so it cannot be probed.`,
    };
  }
  return {
    ok: true,
    proposal: {
      name: probeName(netName),
      path,
      width: w.width,
      taken: reservedNames(config),
    },
  };
}
