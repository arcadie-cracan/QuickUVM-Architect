// Propunerea unei probe whitebox (K2, docs/03/06) dintr-un net selectat in
// vederea-schema: rezolvarea instantei DUT, calea XMR relativa la ea si
// LATIMEA netului. Modul PUR (nu importa `vscode`, nu atinge YAML-ul): host-ul
// (actions.ts) il foloseste ca sa construiasca `probes[]`, iar testele il
// ruleaza direct in Node (`npm run test:probe`).
//
// Constrangerile de mai jos NU sunt inventate — sunt sondate empiric pe
// quick-uvm 0.9.2 (`quick_uvm/models.py` ProbeConfig + validate_probes):
//   - `probes` + `subenvs` => eroare dura (H1: nu merg pe bench de subsistem);
//   - numele probei se ciocneste in namespace-ul tb_top/config-DB cu numele
//     interfetelor si porturilor de agent, cu ceasul si cu reset-ul;
//   - `path` e lipit VERBATIM dupa `dut_inst.` in tb_top, deci e relativ la
//     instanta DUT si nu e validat de generator (o cale gresita trece tacut).

import type { Instance, ProjectModel } from "./model";
import type { QuvmConfig } from "./quickuvm";

export interface ProbeProposal {
  /** numele probei: identificator SV derivat din numele netului */
  name: string;
  /** calea XMR RELATIVA la instanta DUT (quick-uvm o lipeste dupa `dut_inst.`) */
  path: string;
  /** latimea in biti; null = nederivabila din model (host-ul o cere) */
  width: number | null;
  /** nume deja luate: alte probe + interfete/porturi de agent + ceas + reset */
  taken: string[];
}

export type ProbeCheck =
  | { ok: true; proposal: ProbeProposal }
  | { ok: false; reason: string };

/**
 * Instanta DUT-ului sub care se afla vederea curenta. YAML-ul da DUT-ul ca NUME
 * DE MODUL, nu ca instanta (docs/03), iar un modul poate fi instantiat de mai
 * multe ori: se aleg doar instantele care sunt stramos-sau-ea-insasi a vederii,
 * iar dintre ele CEA MAI LUNGA (cel mai apropiat stramos, la modul imbricat).
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

/** Calea probei: calea elaborata a netului MINUS calea instantei DUT. */
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
  return null; // vederea nu e sub DUT: calea nu are sens
}

/**
 * Latimea unui net. NU e in model (`ViewNet` = {name, endpoints, fanout,
 * render}), deci se DERIVA — si derivarea naiva e GRESITA:
 *
 *   - `ch_out` are 48 de biti (portul lui soc_top), dar toate capetele-pin sunt
 *     porturi de 16 biti atinse prin `select`;
 *   - `din` are 8 biti, dar pinul `g_ch[0].u_ch.din` e un port de 16 prin
 *     `concat {din,din}`.
 *
 * (dovada in `examples/model.json`). Deci latimea se ia DOAR de la un capat
 * care e ACELASI semnal: portul propriu al modulului vederii (svmodel semanta
 * netul cu numele portului) sau un pin de copil conectat cu NETUL INTREG
 * (`conn.kind === "net"`) — niciodata prin select/concat/expr.
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
  // (a) portul propriu al modulului vederii: autoritar (acelasi semnal declarat)
  if (net.endpoints.includes(`<port>.${netName}`)) {
    const p = model.modules[view.module]?.ports.find((x) => x.name === netName);
    if (p) {
      return { width: p.width, unpacked: Boolean(p.unpacked_dims?.length) };
    }
  }
  // (b) un pin de copil legat cu netul INTREG
  for (const ep of net.endpoints) {
    if (ep.startsWith("<port>.")) {
      continue;
    }
    const pin = view.pins.find((p) => p.pin === ep);
    if (pin?.conn?.kind !== "net" || pin.conn.net !== netName) {
      continue; // select / concat / expr: latimea portului NU e a netului
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
  return { width: null, unpacked: false }; // toate capetele trec prin select/concat
}

/** Numele netului, sanitizat ca identificator SystemVerilog (cerinta QuickUVM). */
export function probeName(netName: string): string {
  const s = netName.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(s) ? s : `p_${s}`;
}

/**
 * Numele REZERVATE in namespace-ul probei. QuickUVM refuza o proba al carei nume
 * se ciocneste cu o interfata sau un port de agent, cu ceasul sau cu reset-ul
 * (toate ajung in acelasi tb_top / config-DB) — plus, evident, cu alta proba.
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
 * Se poate OFERI coverage functional pe o proba a acestui config? BUG real in
 * quick-uvm 0.9.2: cu `layout: packaged`, env_pkg NU include probe_monitor
 * (tipul ramane necunoscut, testbench-ul nu compileaza) — deci pe config-uri
 * packaged coverage-ul nu se ofera deloc (capcana K2 #1, CLAUDE.md).
 */
export function probeCoverageAllowed(config: QuvmConfig): boolean {
  return (config as { layout?: unknown }).layout !== "packaged";
}

/** Porturile DUT-ului deja mapate pe un agent (o proba pe ele e redundanta). */
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
 * Propune o proba pentru netul selectat, sau spune DE CE nu se poate.
 * Mesajele sunt in engleza (D19): host-ul le arata direct utilizatorului.
 */
export function proposeProbe(
  model: ProjectModel,
  config: QuvmConfig,
  viewId: string,
  netName: string
): ProbeCheck {
  // H1 (sondat pe 0.9.2): `probes` + `subenvs` => ValueError, exit 1
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
  // un port de INTERFATA nu e un semnal sondabil (proba e un vector plat)
  if (model.modules[view.module]?.iface_ports.some((p) => p.name === netName)) {
    return {
      ok: false,
      reason: `"${netName}" is an interface, not a signal — it cannot be probed.`,
    };
  }
  const isOwnPort = net.endpoints.includes(`<port>.${netName}`);
  // un port al DUT-ului deja mapat pe un agent: proba ar fi redundanta SI numele
  // s-ar ciocni in tb_top (QuickUVM refuza) — agentul il observa deja
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
