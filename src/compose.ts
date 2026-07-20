// Deriving the H1 connections between composed blocks (slice 3, docs/03/06) from
// the nets of the parent's schematic view: a net that links the OUTPUT of a child
// block to the INPUT of another is exactly a `connections: [{from, to}]` entry.
// PURE module (does not import `vscode`, does not touch the YAML): the host uses it, and
// the tests run it in Node (`npm run test:compose`).
//
// The contract is empirically probed on quick-uvm 0.9.2 (`SubenvConnection` +
// `validate_subenv_composition`): `from` = an OUTPUT port of the source block,
// `to` = an INPUT port of the destination block, EQUAL widths, a single
// driver per destination, and the DESTINATION block's agent must be PASSIVE.
// The endpoint's first token is the SUBENV NAME (= the child instance name).

import { SV_IDENT_RE } from "./heuristics";
import type { Dir, ProjectModel } from "./model";
import type { QuvmSubenv } from "./quickuvm";
import { addConnections, parseQuvm, setAgentActive } from "./yamlops";

export interface ParentComposition {
  /** the parent instance path (the bench into which the current block is composed) */
  parentPath: string;
  /** the rels of the parent's DIRECT block children, relative to it */
  childRels: string[];
}

/**
 * The immediate parent bench of a block view + its DIRECT block children
 * (for "Compose into parent bench", slice 3). The parent = the longest
 * instance that is a STRICT prefix of the view (skips over the generate domains,
 * which are not instances in the model); the direct children = those with no other instance between
 * them and the parent. The interfaces are excluded. null if the view is a top module.
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
    return null; // top module: no parent
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

/** `g_ch[1].u_ch` -> `g_ch_1_u_ch` (SV identifier for subenvs[].name) */
export function subenvName(rel: string): string {
  const s = rel
    .replace(/\[(\d+)\]/g, "_$1")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return SV_IDENT_RE.test(s) ? s : `subenv_${s || "block"}`;
}

export interface SubenvMapping {
  /** child-rel -> the composed subenv's name (only the unambiguous ones) */
  subenvOf: Map<string, string>;
  /** the names claimed by MULTIPLE rels — excluded from wiring */
  ambiguous: string[];
}

/**
 * Reconstitutes the child-rel -> subenv name mapping via the createSubenvs convention
 * (name = subenvName(rel)). Rel can be DEEP (a generate member:
 * `g_ch[0].u_ch`) — it is NOT filtered by `.` (invariant #3 of the composition,
 * hardened at the adversarial review). `subenvName` is many-to-one, and
 * `createSubenvs` disambiguated the collisions with `_2` — the reconstruction by recompute
 * does not know which rel received the variant, so the names claimed by multiple
 * rels are EXCLUDED and warned about (better nothing than a misrouted
 * connection).
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
  /** `<subenv>.<port>` — the source block's output port */
  from: string;
  /** `<subenv>.<port>` — the destination block's input port */
  to: string;
  /** the common width (bits); for the mismatch diagnostic */
  width: number | null;
}

export interface ComposeResult {
  connections: DerivedConn[];
  /** the destination subenvs: their agent MUST be set passive (`active: false`) */
  sinks: string[];
  /** problems that would make `generate` refuse (multi-driver, widths) */
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
 * The inter-block connections between the given subenvs (map child-rel -> subenv name).
 * Only the purely inter-block nets matter: one that touches an OWN port of the
 * view (`<port>.X`) is a boundary link of the DUT, not between blocks.
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
    // the endpoints that are pins of a child block COMPOSED as a subenv. The
    // net that also touches an own port of the view (`<port>.X`) is NOT skipped: a
    // feedthrough net (the parent's port driven by one child AND read by another) is a
    // real inter-block connection — the `<port>.X` endpoint falls off anyway at the
    // per-endpoint filter (rel `<port>` is not a key in subenvOf), and the purely
    // boundary nets fall off at the 0-drivers/0-sink test below
    const eps: Endpoint[] = [];
    for (const ep of net.endpoints) {
      const dot = ep.lastIndexOf(".");
      if (dot < 0) {
        continue;
      }
      const rel = ep.slice(0, dot);
      if (!subenvOf.has(rel)) {
        continue; // endpoint towards an uncomposed block / own port: ignored
      }
      const inst = model.instances.find((i) => i.path === `${viewId}.${rel}`);
      const p = inst
        ? model.modules[inst.module]?.ports.find((x) => x.name === ep.slice(dot + 1))
        : undefined;
      if (!inst || !p) {
        continue; // interface signal / unknown port: not probeable as a wire
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
      continue; // no output->input pair between subenvs
    }
    if (drivers.length > 1) {
      // quick-uvm requires a single driver per destination — we do not guess the source
      out.warnings.push(
        `net "${net.name}" has ${drivers.length} drivers among composed blocks — not wired (needs a single driver)`
      );
      continue;
    }
    const drv = drivers[0];
    for (const snk of sinks) {
      if (subenvOf.get(snk.rel) === subenvOf.get(drv.rel)) {
        continue; // same subenv (internal feedback / ambiguous name): not wired
      }
      // the width comes from the module's DEFINITION (per name), which is common to
      // several elaborations — for TWO instances of the SAME module with different
      // parameters the shared width is unreliable, so we do NOT check here (quick-uvm
      // does the authoritative check at generation anyway). For DIFFERENT modules
      // the width is trustworthy: we warn about the mismatch, but still wire (we do not
      // discard a real connection — the generator decides).
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

// ------------------------------------------------- the edit plan (H1)

export interface WirePlan {
  /** the NEW text of the top config (identical to the input = nothing to write) */
  topText: string;
  /** the child file's key (given by the host) -> the NEW text (only changed ones) */
  childTexts: Map<string, string>;
  /** `<sink>.<agent>` set passive */
  passivated: string[];
  /** sinks without config/file/agent — the user configures manually */
  manual: string[];
}

/**
 * Plans the ATOMIC multi-file edit of the H1 wiring (PURE, tested in
 * test:compose): `connections` on the top + ALL the DESTINATION block's agents that
 * own driven ports set passive in its child config (quick-uvm refuses
 * if any stays active). `children` maps `subenvs[].config` (the text
 * from the YAML) to the file RESOLVED by the host: `key` identifies the file (canonical
 * URI), `text` is its content. Invariant #4 (hardened at the adversarial
 * review): two sinks can reference the SAME child file (shared block)
 * — the passivations FOLD onto the evolving text, a single entry per
 * `key`, otherwise two full-range replacements on the same file would corrupt it.
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
  // the evolving text per file (the key = the file identity, not the
  // `config` string — two different relative paths can resolve to the same file)
  const evolving = new Map<string, string>();
  for (const sink of derived.sinks) {
    const subenv = subenvs.find((s) => s.name === sink);
    if (!subenv?.config) {
      plan.manual.push(sink);
      continue;
    }
    const child = children.get(subenv.config);
    if (!child) {
      plan.manual.push(sink); // missing/unreadable file
      continue;
    }
    let text = evolving.get(child.key) ?? child.text;
    const drivenPorts = new Set(
      derived.connections
        .filter((c) => c.to.startsWith(`${sink}.`))
        .map((c) => c.to.slice(sink.length + 1))
    );
    // ALL the agents that own a driven input port (the skeleton from
    // createSubenv does not create agents — then we have nothing to passivate yet).
    // filter(), NOT find(): a sink's driven ports can belong to DIFFERENT
    // agents, and quick-uvm refuses generation if ANY stays
    // active ("agent ... is active and would drive ...") — with find(), the
    // second agent stayed active and the gesture reported success on a broken state
    // (pre-existing bug, empirically confirmed at the adversarial review).
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
