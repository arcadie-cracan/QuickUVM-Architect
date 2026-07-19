// Cross-probing editor->diagrama (docs/05, faza 4) — MODUL PUR, partajat de
// host (extension.ts: urmarirea cursorului + comanda Reveal in Diagram) si de
// webview (main.ts: maparea tintei pe id-urile vederii curente). Testat in
// test:locmap pe modelul real (examples/model.json), fara DOM si fara vscode.

import type { ProjectModel } from "./model";
import type { XprobeTarget } from "./protocol";

/** o pozitie sursa cunoscuta de model, cu tinta ei de cross-probing */
export interface LocEntry {
  /** fisierul exact ca in model (relativ la cwd-ul slang; host-ul il rezolva
   *  absolut cu resolveLocPath si il normalizeaza pentru comparare) */
  file: string;
  line: number;
  target: XprobeTarget;
  /** porturile se potrivesc DOAR exact pe linia declaratiei (decl de o
   *  linie); instantele si antetele de modul se potrivesc si ca „cel mai
   *  apropiat deasupra" — cursorul in corpul unei instantieri multi-linie
   *  sau al unui modul cade pe elementul care il cuprinde */
  exactOnly: boolean;
}

/** indexul loc->tinta al modelului: fisier (verbatim din model) -> intrari
 *  sortate pe linie. Instantele generate impart aceeasi linie sursa —
 *  raman intrari separate, resolveLoc le intoarce pe toate. */
export function buildLocIndex(model: ProjectModel): Map<string, LocEntry[]> {
  const idx = new Map<string, LocEntry[]>();
  const add = (e: LocEntry): void => {
    const list = idx.get(e.file);
    if (list) {
      list.push(e);
    } else {
      idx.set(e.file, [e]);
    }
  };
  for (const [name, def] of Object.entries(model.modules)) {
    if (def.loc) {
      add({
        file: def.loc.file,
        line: def.loc.line,
        target: { kind: "module", module: name },
        exactOnly: false,
      });
    }
    for (const p of def.ports) {
      if (p.loc) {
        add({
          file: p.loc.file,
          line: p.loc.line,
          target: { kind: "port", module: name, port: p.name },
          exactOnly: true,
        });
      }
    }
    for (const ip of def.iface_ports) {
      if (ip.loc) {
        add({
          file: ip.loc.file,
          line: ip.loc.line,
          target: { kind: "port", module: name, port: ip.name },
          exactOnly: true,
        });
      }
    }
  }
  for (const inst of model.instances) {
    if (inst.loc) {
      add({
        file: inst.loc.file,
        line: inst.loc.line,
        target: { kind: "instance", path: inst.path },
        exactOnly: false,
      });
    }
  }
  for (const list of idx.values()) {
    list.sort((a, b) => a.line - b.line);
  }
  return idx;
}

/** rangul de preferinta la potrivirea EXACTA pe linie: portul e mai specific
 *  decat instanta, instanta decat antetul de modul (stil ANSI pe o linie:
 *  `module m(input a);` — antetul si primul port impart linia) */
const KIND_RANK: Record<XprobeTarget["kind"], number> = {
  port: 0,
  instance: 1,
  module: 2,
};

/**
 * Tinta (tintele) de sub cursor: potrivire exacta pe linie (cel mai specific
 * fel castiga), altfel cel mai apropiat element DEASUPRA dintre cele care
 * cuprind (instante/module; porturile doar exact). Mai multe tinte doar cand
 * cea mai buna linie poarta mai multe intrari de acelasi fel — instantele
 * generate impart linia sursa (`g_ch[0..2].u_ch`), toate se evidentiaza.
 */
export function resolveLoc(
  entries: LocEntry[] | undefined,
  line: number
): XprobeTarget[] {
  if (!entries?.length) {
    return [];
  }
  const exact = entries.filter((e) => e.line === line);
  if (exact.length) {
    const best = Math.min(...exact.map((e) => KIND_RANK[e.target.kind]));
    return exact
      .filter((e) => KIND_RANK[e.target.kind] === best)
      .map((e) => e.target);
  }
  let bestLine = -1;
  for (const e of entries) {
    if (!e.exactOnly && e.line <= line && e.line > bestLine) {
      bestLine = e.line;
    }
  }
  if (bestLine < 0) {
    return [];
  }
  const at = entries.filter((e) => !e.exactOnly && e.line === bestLine);
  const best = Math.min(...at.map((e) => KIND_RANK[e.target.kind]));
  return at
    .filter((e) => KIND_RANK[e.target.kind] === best)
    .map((e) => e.target);
}

// ------------------------------------------------ maparea pe vederea curenta

/** un nod al vederii-schema curente, cat ii trebuie mapArii (subsetul pur al
 *  SceneNode): pliajele au instPath null si isi poarta membrii in memberPaths */
export interface ProbeNode {
  id: string;
  instPath: string | null;
  module: string;
  /** caile instantelor unui nod-pliaj (generate); absent la noduri simple */
  memberPaths?: string[];
}

/** contextul vederii curente a webview-ului, cat ii trebuie mapArii */
export interface ProbeViewCtx {
  mode: "symbol" | "schematic" | "tb";
  /** calea instantei vederii (RTL); la tb irelevant */
  viewId: string;
  /** modulul vederii (schema: modulul instantei; simbol: modulul desenat) */
  viewModule: string | null;
  /** nodurile scenei curente (doar schema; simbolul n-are copii) */
  nodes: ProbeNode[];
}

/**
 * Id-urile de evidentiat in vederea CURENTA pentru tintele date; goale cand
 * tinta nu e vizibila aici (non-invaziv — fara navigare). Conventiile de id:
 * nodul-copil = calea relativa la vedere (`u_add`, `g_ch[0].u_ch`, pliaj
 * `g_ch[0..2].u_ch`), pinul = `<nod>.<port>`, portul de granita / pinul de
 * simbol = `<port>.<nume>` (docs/02).
 */
/**
 * Remapeaza id-urile unei selectii cerute (`select/reveal`) pe scena curenta:
 * un rel de membru de generate (`g_ch[1].u_ch`) trimis de host nu exista in
 * DOM cand pliajul e INCHIS (implicitul) — singurul nod e pliajul
 * (`g_ch[0..2].u_ch`), gasit prin memberPaths (`viewId + "." + rel`). Id-urile
 * care exista (sau nu apartin niciunui pliaj) raman neatinse; dublurile se
 * strang (3 membri -> pliajul o data). Pur, testat in test:locmap — fara el,
 * „Reveal in Diagram" pe linia unei instantieri generate naviga corect dar
 * selecta NIMIC (recenzia adversariala a sincronizarii).
 */
export function remapSelection(
  ids: string[],
  viewId: string,
  nodes: ProbeNode[]
): string[] {
  const existing = new Set(nodes.map((n) => n.id));
  const out = new Set<string>();
  for (const id of ids) {
    if (existing.has(id)) {
      out.add(id);
      continue;
    }
    const fold = nodes.find((n) =>
      n.memberPaths?.includes(`${viewId}.${id}`)
    );
    out.add(fold ? fold.id : id);
  }
  return [...out];
}

export function probeIds(
  targets: XprobeTarget[],
  ctx: ProbeViewCtx
): string[] {
  if (ctx.mode === "tb") {
    return []; // cross-probing-ul de design nu atinge vederea de verificare
  }
  const ids = new Set<string>();
  for (const t of targets) {
    if (t.kind === "instance") {
      if (ctx.mode !== "schematic") {
        continue; // simbolul nu-si arata copiii; vederea insasi nu se aprinde
      }
      let containing: { id: string; depth: number } | null = null;
      for (const n of ctx.nodes) {
        if (n.instPath === t.path || n.memberPaths?.includes(t.path)) {
          ids.add(n.id);
          containing = null;
          break;
        }
        // tinta mai adanca decat copiii vederii: se aprinde copilul care o
        // CONTINE (cel mai adanc asemenea copil); pliajele se cauta prin
        // membri (instPath e null la pliaj)
        const covers =
          (n.instPath !== null && t.path.startsWith(n.instPath + ".")) ||
          n.memberPaths?.some((m) => t.path.startsWith(m + "."));
        if (covers) {
          const depth = (n.instPath ?? n.memberPaths?.[0] ?? "").split(".").length;
          if (!containing || depth > containing.depth) {
            containing = { id: n.id, depth };
          }
        }
      }
      if (containing) {
        ids.add(containing.id);
      }
    } else if (t.kind === "port") {
      if (ctx.viewModule === t.module) {
        // portul vederii insesi: steag de granita (schema) sau pin (simbol),
        // ambele cu aceeasi conventie de id
        ids.add(`<port>.${t.port}`);
      }
      if (ctx.mode === "schematic") {
        for (const n of ctx.nodes) {
          if (n.module === t.module) {
            ids.add(`${n.id}.${t.port}`);
          }
        }
      }
    } else {
      // modul: toate instantele lui din vederea curenta
      if (ctx.mode === "schematic") {
        for (const n of ctx.nodes) {
          if (n.module === t.module) {
            ids.add(n.id);
          }
        }
      }
    }
  }
  return [...ids];
}
