// The map between the QuickUVM YAML text and the verification-view elements
// (docs/08 R4) — a PURE module (no vscode), tested in Node
// (scripts/test-yamlmap.mjs). Two directions:
//
//   elementAtOffset(text, offset) — the TB element whose YAML entry contains the
//   caret: the reverse of a gesture, so moving through the file lights the
//   matching box (the editor→diagram halo, like the SV cross-probing);
//
//   elementRange(text, id) — the YAML span of a TB element: what the editor
//   reveals and highlights when the box is selected (the Android "Split" view,
//   Umple's click-a-state-highlight-its-code).
//
// The ids are the ones `buildTbScene`/`buildTbTree` use (agent:<name>, sb:<name>,
// cov:<agent>, sub:<name>, vsqr, probes, dut), with the level (`focus`) the
// element lives on. Everything comes from the `yaml` CST ranges — never from
// re-serialized text — so the offsets are exact on the user's own formatting,
// comments included.

import { isMap, isSeq, parseDocument, type Document, type Node, type Pair } from "yaml";
import { coveredAgent } from "./coverage";

export interface YamlElement {
  /** the TB node id (buildTbScene / buildTbTree, minus the tree's `v:` prefix) */
  id: string;
  /** the TB level the element is drawn on: `""` (root) or `env` */
  focus: string;
}

export interface YamlSpan {
  start: number;
  end: number;
}

/** [start, end) of a yaml node — the full node incl. trailing content (`range[2]`) */
function spanOf(node: unknown): YamlSpan | null {
  const r = (node as { range?: [number, number, number] } | null)?.range;
  return r ? { start: r[0], end: r[2] } : null;
}

/** the span of a map entry: from its key to the end of its value */
function pairSpan(p: Pair): YamlSpan | null {
  const k = spanOf(p.key);
  const v = spanOf(p.value);
  if (!k) {
    return null;
  }
  return { start: k.start, end: Math.max(k.end, v?.end ?? k.end) };
}

/** the span without its trailing whitespace/newlines: `range[2]` runs past the
 *  node's last line, and a highlight that spills onto the next line misleads */
function trimSpan(text: string, s: YamlSpan | null): YamlSpan | null {
  if (!s) {
    return null;
  }
  let end = Math.min(s.end, text.length);
  while (end > s.start && /\s/.test(text[end - 1])) {
    end--;
  }
  return { start: s.start, end };
}

function contains(s: YamlSpan | null, offset: number): boolean {
  return !!s && offset >= s.start && offset < s.end;
}

function scalar(node: unknown): string | undefined {
  const v = (node as { value?: unknown } | null)?.value;
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

/** the items of a sequence node, with their spans */
function seqItems(node: unknown): { node: Node; span: YamlSpan | null }[] {
  if (!isSeq(node)) {
    return [];
  }
  return node.items.map((it) => ({ node: it as Node, span: spanOf(it) }));
}

/** `name:` of a map item, or undefined */
function nameOf(node: unknown): string | undefined {
  return isMap(node) ? scalar(node.get("name", true)) : undefined;
}

/** the coverage agent of a sequence item (a string, or a `{agent}` map) */
function covAgentOf(doc: Document, node: unknown): string | undefined {
  if (isMap(node)) {
    return coveredAgent(node.toJS(doc) as unknown);
  }
  return scalar(node);
}

/**
 * The TB element whose YAML entry contains `offset`, or null (a comment, a key
 * the view does not draw, `clock:`, `tests:` …). Nested positions resolve to
 * the owning element: a port inside `agents[i].ports` is still `agent:<name>`.
 */
export function elementAtOffset(text: string, offset: number): YamlElement | null {
  const doc = parseDocument(text);
  const root = doc.contents;
  if (!isMap(root)) {
    return null;
  }
  for (const p of root.items) {
    const key = scalar(p.key);
    if (!key || !contains(pairSpan(p), offset)) {
      continue;
    }
    switch (key) {
      case "dut":
        return { id: "dut", focus: "" };
      case "agents":
        for (const it of seqItems(p.value)) {
          const name = nameOf(it.node);
          if (name && contains(it.span, offset)) {
            return { id: `agent:${name}`, focus: "env" };
          }
        }
        return null;
      case "analysis": {
        if (!isMap(p.value)) {
          return null;
        }
        for (const q of p.value.items) {
          const k = scalar(q.key);
          if (!contains(pairSpan(q), offset)) {
            continue;
          }
          if (k === "scoreboards") {
            // the scene de-duplicates repeated names: `sb:sbd`, `sb:sbd#2`, …
            const seen = new Map<string, number>();
            for (const it of seqItems(q.value)) {
              const name = nameOf(it.node) ?? "sbd";
              const n = (seen.get(name) ?? 0) + 1;
              seen.set(name, n);
              if (contains(it.span, offset)) {
                return { id: n === 1 ? `sb:${name}` : `sb:${name}#${n}`, focus: "env" };
              }
            }
          } else if (k === "coverage") {
            for (const it of seqItems(q.value)) {
              const agent = covAgentOf(doc, it.node);
              if (agent && contains(it.span, offset)) {
                return { id: `cov:${agent}`, focus: "env" };
              }
            }
          }
        }
        return null;
      }
      case "subenvs":
        for (const it of seqItems(p.value)) {
          const name = nameOf(it.node);
          if (name && contains(it.span, offset)) {
            return { id: `sub:${name}`, focus: "env" };
          }
        }
        return null;
      case "virtual_sequences":
        return { id: "vsqr", focus: "env" };
      case "probes":
        return { id: "probes", focus: "env" };
      default:
        return null;
    }
  }
  return null;
}

/**
 * The YAML span of a TB element id, or null when the file has no such entry
 * (an inferred ghost, a level node like `env`, a renamed element). `vsqr` and
 * `probes` map to their whole block; an agent maps to its list item.
 */
export function elementRange(text: string, id: string): YamlSpan | null {
  const doc = parseDocument(text);
  const root = doc.contents;
  if (!isMap(root)) {
    return null;
  }
  const top = (key: string): Pair | undefined =>
    root.items.find((p) => scalar(p.key) === key);
  /** the n-th (1-based) item whose name is `name` — `#n` ids count duplicates */
  const itemNamed = (
    seq: unknown,
    pick: (node: unknown) => string | undefined,
    name: string,
    nth = 1
  ): YamlSpan | null => {
    let k = 0;
    for (const it of seqItems(seq)) {
      if (pick(it.node) === name && ++k === nth) {
        return trimSpan(text, it.span);
      }
    }
    return null;
  };

  if (id === "dut" || id === "vsqr" || id === "probes") {
    const p = top(id === "dut" ? "dut" : id === "vsqr" ? "virtual_sequences" : "probes");
    return p ? trimSpan(text, pairSpan(p)) : null;
  }
  const colon = id.indexOf(":");
  if (colon < 0) {
    return null;
  }
  const kind = id.slice(0, colon);
  // `sb:<name>#2` (a de-duplicated node id) is the SECOND entry named <name>
  const rest = id.slice(colon + 1);
  const dup = /#(\d+)$/.exec(rest);
  const name = dup ? rest.slice(0, dup.index) : rest;
  const nth = dup ? Number(dup[1]) : 1;
  if (kind === "agent") {
    // `agent:<name>:u.driver` (an agent-internal leaf) belongs to the agent
    return itemNamed(top("agents")?.value, nameOf, name.split(":")[0]);
  }
  if (kind === "sub") {
    return itemNamed(top("subenvs")?.value, nameOf, name);
  }
  const analysis = top("analysis")?.value;
  if (!isMap(analysis)) {
    return null;
  }
  if (kind === "sb" || kind === "xsb") {
    return itemNamed(
      analysis.get("scoreboards", true),
      (n) => nameOf(n) ?? "sbd",
      name,
      nth
    );
  }
  if (kind === "cov") {
    return itemNamed(analysis.get("coverage", true), (n) => covAgentOf(doc, n), name);
  }
  return null;
}
