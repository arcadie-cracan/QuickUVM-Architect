// Derivarea conexiunilor H1 dintre blocuri compuse (felia 3, docs/03/06) din
// net-urile vederii-schema a parintelui: un net care leaga IESIREA unui bloc
// copil de INTRAREA altuia e exact o intrare `connections: [{from, to}]`.
// Modul PUR (nu importa `vscode`, nu atinge YAML-ul): host-ul il foloseste, iar
// testele il ruleaza in Node (`npm run test:compose`).
//
// Contractul e sondat empiric pe quick-uvm 0.9.2 (`SubenvConnection` +
// `validate_subenv_composition`): `from` = un port de IESIRE al blocului sursa,
// `to` = un port de INTRARE al blocului destinatie, latimile EGALE, un singur
// driver per destinatie, iar agentul blocului DESTINATIE trebuie sa fie PASIV.
// Primul token al capatului e NUMELE SUBENV-ului (= numele instantei copil).

import { SV_IDENT_RE } from "./heuristics";
import type { Dir, ProjectModel } from "./model";
import type { QuvmSubenv } from "./quickuvm";
import { addConnections, parseQuvm, setAgentActive } from "./yamlops";

export interface ParentComposition {
  /** calea instantei parinte (bench-ul in care se compune blocul curent) */
  parentPath: string;
  /** rel-urile copiilor-bloc DIRECTI ai parintelui, relative la el */
  childRels: string[];
}

/**
 * Parintele-bench imediat al unei vederi-bloc + copiii-bloc DIRECTI ai lui
 * (pentru „Compose into parent bench", felia 3). Parintele = cea mai lunga
 * instanta care e prefix STRICT al vederii (sare peste domeniile de generate,
 * care nu-s instante in model); copiii directi = cei fara alta instanta intre
 * ei si parinte. Interfetele se exclud. null daca vederea e un modul top.
 */
export function parentComposition(
  model: ProjectModel,
  viewId: string
): ParentComposition | null {
  const cur = model.instances.find((i) => i.path === viewId);
  if (!cur) {
    return null;
  }
  let parent: { path: string } | null = null;
  for (const i of model.instances) {
    if (i.path !== cur.path && cur.path.startsWith(`${i.path}.`)) {
      if (!parent || i.path.length > parent.path.length) {
        parent = i;
      }
    }
  }
  if (!parent) {
    return null; // modul top: fara parinte
  }
  const p = parent;
  const childRels: string[] = [];
  for (const i of model.instances) {
    if (i.iface || !i.path.startsWith(`${p.path}.`)) {
      continue;
    }
    const between = model.instances.some(
      (j) =>
        j.path !== p.path &&
        j.path !== i.path &&
        j.path.startsWith(`${p.path}.`) &&
        i.path.startsWith(`${j.path}.`)
    );
    if (!between) {
      childRels.push(i.path.slice(p.path.length + 1));
    }
  }
  return { parentPath: p.path, childRels };
}

/** `g_ch[1].u_ch` -> `g_ch_1_u_ch` (identificator SV pentru subenvs[].name) */
export function subenvName(rel: string): string {
  const s = rel
    .replace(/\[(\d+)\]/g, "_$1")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return SV_IDENT_RE.test(s) ? s : `subenv_${s || "block"}`;
}

export interface SubenvMapping {
  /** rel-copil -> numele subenv-ului compus (doar cele neambigue) */
  subenvOf: Map<string, string>;
  /** numele revendicate de MAI MULTI rel — excluse din cablare */
  ambiguous: string[];
}

/**
 * Reconstituie maparea rel-copil -> nume subenv prin conventia createSubenvs
 * (nume = subenvName(rel)). Rel poate fi ADANC (membru de generate:
 * `g_ch[0].u_ch`) — NU se filtreaza dupa `.` (invariantul #3 al compunerii,
 * calit la recenzia adversariala). `subenvName` e many-to-one, iar
 * `createSubenvs` a dedus coliziunile cu `_2` — reconstructia prin recalcul
 * nu stie care rel a primit varianta, deci numele revendicate de mai multi
 * rel se EXCLUD si se avertizeaza (mai bine nimic decat o conexiune
 * misrutata).
 */
export function subenvMapping(
  model: ProjectModel,
  parentPath: string,
  subenvNames: readonly (string | undefined)[]
): SubenvMapping {
  const names = new Set(
    subenvNames.filter((n): n is string => Boolean(n))
  );
  const subenvOf = new Map<string, string>();
  for (const inst of model.instances) {
    if (!inst.path.startsWith(`${parentPath}.`)) {
      continue;
    }
    const rel = inst.path.slice(parentPath.length + 1);
    const name = subenvName(rel);
    if (names.has(name)) {
      subenvOf.set(rel, name);
    }
  }
  const perName = new Map<string, number>();
  for (const n of subenvOf.values()) {
    perName.set(n, (perName.get(n) ?? 0) + 1);
  }
  const ambiguous = [...perName].filter(([, c]) => c > 1).map(([n]) => n);
  for (const [rel, n] of [...subenvOf]) {
    if (ambiguous.includes(n)) {
      subenvOf.delete(rel);
    }
  }
  return { subenvOf, ambiguous };
}

export interface DerivedConn {
  /** `<subenv>.<port>` — portul de iesire al blocului sursa */
  from: string;
  /** `<subenv>.<port>` — portul de intrare al blocului destinatie */
  to: string;
  /** latimea comuna (biti); pentru diagnosticul nepotrivirilor */
  width: number | null;
}

export interface ComposeResult {
  connections: DerivedConn[];
  /** subenv-urile destinatie: agentul lor TREBUIE pus pasiv (`active: false`) */
  sinks: string[];
  /** probleme care ar face `generate` sa refuze (multi-driver, latimi) */
  warnings: string[];
}

interface Endpoint {
  rel: string;
  module: string;
  port: string;
  dir: Dir;
  width: number | null;
}

/**
 * Conexiunile inter-bloc dintre subenv-urile date (map rel-copil -> nume subenv).
 * Doar net-urile pur inter-bloc conteaza: unul care atinge un port PROPRIU al
 * vederii (`<port>.X`) e o legatura de granita a DUT-ului, nu intre blocuri.
 */
export function deriveConnections(
  model: ProjectModel,
  viewId: string,
  subenvOf: ReadonlyMap<string, string>
): ComposeResult {
  const view = model.views[viewId];
  const out: ComposeResult = { connections: [], sinks: [], warnings: [] };
  if (!view) {
    return out;
  }
  const sinkSet = new Set<string>();
  for (const net of view.nets) {
    // capetele care sunt pini de bloc-copil COMPUS ca subenv. NU se sare
    // net-ul care atinge si un port propriu al vederii (`<port>.X`): un net de
    // feedthrough (portul parintelui condus de un copil SI citit de altul) e o
    // conexiune reala inter-bloc — capatul `<port>.X` cade oricum la filtrul
    // per-capat (rel `<port>` nu e cheie in subenvOf), iar net-urile pur de
    // granita cad la testul 0-drivere/0-sink de mai jos
    const eps: Endpoint[] = [];
    for (const ep of net.endpoints) {
      const dot = ep.lastIndexOf(".");
      if (dot < 0) {
        continue;
      }
      const rel = ep.slice(0, dot);
      if (!subenvOf.has(rel)) {
        continue; // capat catre un bloc necompus / port propriu: se ignora
      }
      const inst = model.instances.find((i) => i.path === `${viewId}.${rel}`);
      const p = inst
        ? model.modules[inst.module]?.ports.find((x) => x.name === ep.slice(dot + 1))
        : undefined;
      if (!inst || !p) {
        continue; // semnal de interfata / port necunoscut: nesondabil ca fir
      }
      eps.push({
        rel,
        module: inst.module,
        port: ep.slice(dot + 1),
        dir: p.dir,
        width: p.elem_width ?? p.width,
      });
    }
    if (eps.length < 2) {
      continue;
    }
    const drivers = eps.filter((e) => e.dir === "out" || e.dir === "inout");
    const sinks = eps.filter((e) => e.dir === "in");
    if (drivers.length === 0 || sinks.length === 0) {
      continue; // fara pereche iesire->intrare intre subenv-uri
    }
    if (drivers.length > 1) {
      // quick-uvm cere un singur driver per destinatie — nu ghicim sursa
      out.warnings.push(
        `net "${net.name}" has ${drivers.length} drivers among composed blocks — not wired (needs a single driver)`
      );
      continue;
    }
    const drv = drivers[0];
    for (const snk of sinks) {
      if (subenvOf.get(snk.rel) === subenvOf.get(drv.rel)) {
        continue; // acelasi subenv (feedback intern / nume-ambiguu): nu se cableaza
      }
      // latimea vine din DEFINITIA modulului (per nume), care e comuna la mai
      // multe elaborari — pentru DOUA instante ale ACELUIASI modul cu parametri
      // diferiti latimea partajata e nesigura, deci NU verificam aici (quick-uvm
      // face oricum verificarea autoritara la generare). Pentru module DIFERITE
      // latimea e de incredere: nepotrivirea o avertizam, dar tot cablam (nu
      // aruncam o conexiune reala — generatorul decide).
      if (
        drv.module !== snk.module &&
        drv.width !== null &&
        snk.width !== null &&
        drv.width !== snk.width
      ) {
        out.warnings.push(
          `net "${net.name}": ${drv.rel}.${drv.port} is ${drv.width}b but ${snk.rel}.${snk.port} is ${snk.width}b — width mismatch (quick-uvm will reject)`
        );
      }
      out.connections.push({
        from: `${subenvOf.get(drv.rel)}.${drv.port}`,
        to: `${subenvOf.get(snk.rel)}.${snk.port}`,
        width: drv.width ?? snk.width,
      });
      sinkSet.add(subenvOf.get(snk.rel) as string);
    }
  }
  out.sinks = [...sinkSet];
  return out;
}

// ------------------------------------------------- planul de editare (H1)

export interface WirePlan {
  /** textul NOU al config-ului top (identic cu intrarea = nimic de scris) */
  topText: string;
  /** cheia fisierului copil (data de host) -> textul NOU (doar schimbate) */
  childTexts: Map<string, string>;
  /** `<sink>.<agent>` puse pasive */
  passivated: string[];
  /** sinks fara config/fisier/agent — utilizatorul configureaza manual */
  manual: string[];
}

/**
 * Planifica editarea ATOMICA multi-fisier a cablarii H1 (PUR, testat in
 * test:compose): `connections` pe top + TOTI agentii blocului DESTINATIE care
 * detin porturi conduse pusi pasivi in config-ul lui copil (quick-uvm refuza
 * daca oricare ramane activ). `children` mapeaza `subenvs[].config` (textul
 * din YAML) la fisierul REZOLVAT de host: `key` identifica fisierul (URI
 * canonic), `text` e continutul lui. Invariantul #4 (calit la recenzia
 * adversariala): doua sinks pot referi ACELASI fisier copil (bloc partajat)
 * — pasivizarile se PLIAZA pe textul in evolutie, o singura intrare per
 * `key`, altfel doua inlocuiri full-range pe acelasi fisier s-ar corupe.
 */
export function planWireEdits(
  topText: string,
  subenvs: readonly QuvmSubenv[],
  derived: Pick<ComposeResult, "connections" | "sinks">,
  children: ReadonlyMap<string, { key: string; text: string }>
): WirePlan {
  const plan: WirePlan = {
    topText: addConnections(topText, derived.connections),
    childTexts: new Map(),
    passivated: [],
    manual: [],
  };
  // textul in evolutie per fisier (cheia = identitatea fisierului, nu sirul
  // `config` — doua cai relative diferite pot rezolva la acelasi fisier)
  const evolving = new Map<string, string>();
  for (const sink of derived.sinks) {
    const subenv = subenvs.find((s) => s.name === sink);
    if (!subenv?.config) {
      plan.manual.push(sink);
      continue;
    }
    const child = children.get(subenv.config);
    if (!child) {
      plan.manual.push(sink); // fisier lipsa/ilizibil
      continue;
    }
    let text = evolving.get(child.key) ?? child.text;
    const drivenPorts = new Set(
      derived.connections
        .filter((c) => c.to.startsWith(`${sink}.`))
        .map((c) => c.to.slice(sink.length + 1))
    );
    // TOTI agentii care detin un port de intrare condus (scheletul din
    // createSubenv nu creeaza agenti — atunci nu avem ce pasiviza inca).
    // filter(), NU find(): porturile conduse ale unui sink pot apartine unor
    // agenti DIFERITI, iar quick-uvm refuza generarea daca ORICARE ramane
    // activ ("agent ... is active and would drive ...") — cu find(), al
    // doilea agent ramanea activ si gestul raporta succes pe o stare rupta
    // (bug pre-existent, confirmat empiric la recenzia adversariala).
    const owners = (parseQuvm(text).agents ?? []).filter(
      (a) =>
        a.name &&
        (a.ports?.inputs ?? []).some((p) => p.name && drivenPorts.has(p.name))
    );
    if (!owners.length) {
      plan.manual.push(sink);
      continue;
    }
    for (const agent of owners) {
      text = setAgentActive(text, agent.name as string, false);
      plan.passivated.push(`${sink}.${agent.name}`);
    }
    evolving.set(child.key, text);
  }
  for (const [key, text] of evolving) {
    const orig = [...children.values()].find((c) => c.key === key)?.text;
    if (text !== orig) {
      plan.childTexts.set(key, text);
    }
  }
  return plan;
}
