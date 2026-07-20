// Editor->diagram cross-probing (docs/05, phase 4) — PURE MODULE, shared by the
// host (extension.ts: cursor tracking + the Reveal in Diagram command) and the
// webview (main.ts: mapping the target onto the ids of the current view). Tested in
// test:locmap on the real model (examples/model.json), without DOM and without vscode.

import type { ProjectModel } from "./model";
import type { XprobeTarget } from "./protocol";

/** a source position known to the model, with its cross-probing target */
export interface LocEntry {
  /** the file exactly as in the model (relative to slang's cwd; the host resolves it
   *  absolutely with resolveLocPath and normalizes it for comparison) */
  file: string;
  line: number;
  target: XprobeTarget;
  /** ports match ONLY exactly on the declaration line (a one-line
   *  decl); instances and module headers also match as "the closest
   *  above" — the cursor in the body of a multi-line instantiation
   *  or of a module falls on the element that contains it */
  exactOnly: boolean;
}

/** the model's loc->target index: file (verbatim from the model) -> entries
 *  sorted by line. Generated instances share the same source line —
 *  they remain separate entries, resolveLoc returns them all. */
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

/** the preference rank on EXACT line matching: the port is more specific
 *  than the instance, the instance than the module header (ANSI style on one line:
 *  `module m(input a);` — the header and the first port share the line) */
const KIND_RANK: Record<XprobeTarget["kind"], number> = {
  port: 0,
  instance: 1,
  module: 2,
};

/**
 * The target(s) under the cursor: exact line match (the most specific
 * kind wins), otherwise the closest element ABOVE among those that
 * contain (instances/modules; ports only exact). Multiple targets only when
 * the best line carries several entries of the same kind — the generated
 * instances share the source line (`g_ch[0..2].u_ch`), all are highlighted.
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

// ------------------------------------------------ mapping onto the current view

/** a node of the current schematic view, as much as the mapping needs (the pure subset of
 *  SceneNode): folds have instPath null and carry their members in memberPaths */
export interface ProbeNode {
  id: string;
  instPath: string | null;
  module: string;
  /** the instance paths of a fold node (generated); absent on simple nodes */
  memberPaths?: string[];
}

/** the context of the webview's current view, as much as the mapping needs */
export interface ProbeViewCtx {
  mode: "symbol" | "schematic" | "tb";
  /** the view instance path (RTL); irrelevant for tb */
  viewId: string;
  /** the view module (schematic: the instance module; symbol: the drawn module) */
  viewModule: string | null;
  /** the nodes of the current scene (schematic only; the symbol has no children) */
  nodes: ProbeNode[];
}

/**
 * The ids to highlight in the CURRENT view for the given targets; empty when
 * the target is not visible here (non-invasive — no navigation). The id conventions:
 * child node = the path relative to the view (`u_add`, `g_ch[0].u_ch`, fold
 * `g_ch[0..2].u_ch`), the pin = `<node>.<port>`, the boundary port / symbol
 * pin = `<port>.<name>` (docs/02).
 */
/**
 * Remaps the ids of a requested selection (`select/reveal`) onto the current scene:
 * a generate member rel (`g_ch[1].u_ch`) sent by the host does not exist in the
 * DOM when the fold is CLOSED (the default) — the only node is the fold
 * (`g_ch[0..2].u_ch`), found through memberPaths (`viewId + "." + rel`). The ids
 * that exist (or do not belong to any fold) stay untouched; duplicates are
 * collapsed (3 members -> the fold once). Pure, tested in test:locmap — without it,
 * "Reveal in Diagram" on the line of a generated instantiation navigated correctly but
 * selected NOTHING (adversarial review of the synchronization).
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
    return []; // design cross-probing does not touch the verification (TB) view
  }
  const ids = new Set<string>();
  for (const t of targets) {
    if (t.kind === "instance") {
      if (ctx.mode !== "schematic") {
        continue; // the symbol does not show its children; the view itself does not light up
      }
      let containing: { id: string; depth: number } | null = null;
      for (const n of ctx.nodes) {
        if (n.instPath === t.path || n.memberPaths?.includes(t.path)) {
          ids.add(n.id);
          containing = null;
          break;
        }
        // target deeper than the view's children: the child that CONTAINS it
        // lights up (the deepest such child); folds are searched through their
        // members (instPath is null for a fold)
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
        // the port of the view itself: boundary flag (schematic) or pin (symbol),
        // both with the same id convention
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
      // module: all its instances in the current view
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
