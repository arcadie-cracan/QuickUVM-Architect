// Generation-state detection (docs/07 line 1): which verification-tree / TB-diagram
// elements have NO generated code behind them yet. PURE (no `vscode`), testable in
// Node (scripts/test-genstate.mjs).
//
// The input is the `quick-uvm manifest` JSON (QuickUVM >= 1.1.0): a map of config
// ELEMENT (owner) -> generated files, each with an on-disk `exists` flag when the
// manifest was produced with `-o`. This is the ROBUST detection source — the owner
// is captured where the element is known in the generator, so it is correct even
// where the filename drops the element's name (a flat scoreboard `sbd` ->
// `<dut>_scoreboard.svh`). We never re-derive the element->file map from filenames.

import type { QuvmConfig } from "./quickuvm";

export interface ManifestFile {
  file: string;
  exists: boolean;
}

export interface ManifestElement {
  owner: string;
  files: ManifestFile[];
}

export interface Manifest {
  version: string;
  layout: string;
  kind: string;
  output_dir: string;
  elements: ManifestElement[];
}

/**
 * Map a manifest OWNER to the verification-tree / TB-diagram element id it
 * decorates, or `null` when the owner has no decoratable node:
 *   - `agent:<name>`      -> `agent:<name>`   (direct)
 *   - `scoreboard:<name>` -> `sb:<name>`      (the diagram/tree uses the `sb:` prefix)
 *   - `probes`            -> `probes`
 *   - `vseq:<name>`       -> `vsqr`           (all vseqs share the one vsqr node)
 *   - `aggregate` / `test:` / `register_model` / `vip` -> null
 *     (whole-config files, or elements with no dedicated TB node yet)
 * `cov:<agent>` is deliberately not mapped: `<agent>_cov.svh` is emitted
 * unconditionally and lives under `agent:<name>`, so it is a weak proxy (docs/07).
 */
export function ownerToNodeId(owner: string): string | null {
  if (owner.startsWith("agent:")) return owner;
  if (owner.startsWith("scoreboard:")) return "sb:" + owner.slice("scoreboard:".length);
  if (owner === "probes") return "probes";
  if (owner.startsWith("vseq:")) return "vsqr";
  return null;
}

/**
 * The set of element ids that are NOT fully generated — any owned file whose
 * `exists` flag is false. Owners with no decoratable node (see `ownerToNodeId`)
 * are ignored; several vseq owners collapse onto the single `vsqr` node.
 */
export interface ElementStates {
  /** elements with a file that does not exist on disk yet */
  missing: Set<string>;
  /** elements generated from an OLDER version of the config — the generated code
   *  is behind what the config now says */
  stale: Set<string>;
}

/**
 * Classify each decoratable element as `missing` (some owned file absent),
 * `stale` (all present, but generated from a different config content) or
 * up-to-date (in neither set). Missing wins when several owners collapse onto one
 * node (vseq → vsqr).
 *
 * `present` is the set of filenames that exist in the output dir. `generatedHash`
 * maps an element id to the config HASH it was last generated from (recorded by the
 * extension when it generates); `configHash` is the config's current hash.
 *
 * Staleness is content-based ON PURPOSE. File mtimes cannot express it: quick-uvm
 * deliberately does NOT rewrite a file whose content is unchanged (that is what keeps
 * downstream builds from recompiling), so after a regeneration the mtimes of unchanged
 * files stay old — an mtime heuristic would latch "stale" forever. An element with no
 * recorded hash is NOT claimed stale (we cannot know), so the badge never lies.
 */
export function classify(
  manifest: Manifest,
  present: ReadonlySet<string>,
  generatedHash: ReadonlyMap<string, string>,
  configHash: string,
  declared: readonly string[] = []
): ElementStates {
  const missing = new Set<string>();
  const stale = new Set<string>();
  const known = new Set<string>();
  for (const el of manifest.elements) {
    const nodeId = ownerToNodeId(el.owner);
    if (nodeId === null) continue;
    known.add(nodeId);
    const files = el.files.map((f) => f.file);
    if (files.some((f) => !present.has(f))) {
      missing.add(nodeId);
      continue;
    }
    const was = generatedHash.get(nodeId);
    if (was !== undefined && was !== configHash) {
      stale.add(nodeId);
    }
  }
  // An element the CONFIG declares but the manifest has never heard of cannot have
  // generated files — so it is missing, by definition. This is what makes the badge
  // appear the moment a component is added, instead of waiting for a save: the tree
  // is built from the in-memory document, while `quick-uvm manifest` reads the file
  // from DISK, so between an edit and its save the manifest is one step behind.
  for (const nodeId of declared) {
    if (!known.has(nodeId)) {
      missing.add(nodeId);
    }
  }
  for (const id of missing) {
    stale.delete(id); // missing wins (e.g. one vseq missing, another stale → vsqr missing)
  }
  return { missing, stale };
}

/**
 * The decoratable element ids the CONFIG declares, derived from the in-memory
 * document rather than from the manifest. The conditions mirror `tbtree-build`
 * exactly, so a node the tree draws and this list disagree about nothing — a
 * mismatch would either badge a row that does not exist or leave a new one bare.
 */
export function declaredElements(cfg: QuvmConfig): string[] {
  const out: string[] = [];
  for (const a of cfg.agents ?? []) {
    if (a.name) {
      out.push(`agent:${a.name}`);
    }
  }
  for (const s of cfg.analysis?.scoreboards ?? []) {
    // an unnamed scoreboard is the default `sbd` (the same fallback the tree uses)
    out.push(`sb:${s.name ?? "sbd"}`);
  }
  if (cfg.probes?.length) {
    out.push("probes");
  }
  // the vsqr node exists when any agent is COORDINATED: either an explicit virtual
  // sequence names it, or the auto vseq kicks in at >= 2 active agents
  const named = (cfg.agents ?? []).filter((a) => a.name);
  const vseqs = (cfg.virtual_sequences ?? []).filter((v) => v.name);
  const coordinated = vseqs.length
    ? vseqs.some((v) =>
        (v.body ?? []).some(
          (s) => s.agent && named.some((a) => a.name === s.agent)
        )
      )
    : cfg.auto_virtual_sequences !== false &&
      named.filter((a) => a.active !== false).length >= 2;
  if (coordinated) {
    out.push("vsqr");
  }
  return out;
}

/**
 * docs/07 line 2 — the output files to regenerate for one element (`agent:cmd`,
 * `sb:sbd`, `probes`, `vsqr`): its OWN files plus the `aggregate` co-regen set.
 * Appending the aggregates always is the safe default — any structural change
 * (add/remove/rename) needs them, and they are a handful of cheap files. Returns
 * `null` if the element maps to no owner in the manifest (nothing to generate).
 */
export function scopedFilesFor(manifest: Manifest, nodeId: string): string[] | null {
  const own = new Set<string>();
  const aggregate: string[] = [];
  let found = false;
  for (const el of manifest.elements) {
    const files = el.files.map((f) => f.file);
    if (el.owner === "aggregate") {
      aggregate.push(...files);
    } else if (ownerToNodeId(el.owner) === nodeId) {
      found = true;
      for (const f of files) {
        own.add(f);
      }
    }
  }
  return found ? [...own, ...aggregate] : null;
}

/**
 * docs/07 line 2 (2.3) — the representative source file to OPEN for an element:
 * the agent class / scoreboard / probe interface / virtual sequencer, chosen by
 * suffix from the element's own files (falling back to the first). `null` if the
 * element owns no files. The aggregate files are never a "primary".
 */
export function primaryFile(manifest: Manifest, nodeId: string): string | null {
  const own: string[] = [];
  for (const el of manifest.elements) {
    if (el.owner !== "aggregate" && ownerToNodeId(el.owner) === nodeId) {
      own.push(...el.files.map((f) => f.file));
    }
  }
  if (own.length === 0) {
    return null;
  }
  const suffix = nodeId.startsWith("agent:")
    ? "_agent.svh"
    : nodeId.startsWith("sb:")
      ? "_scoreboard.svh"
      : nodeId === "probes"
        ? "_probe_if.sv"
        : nodeId === "vsqr"
          ? "_virtual_sequencer.svh"
          : "";
  return (suffix && own.find((f) => f.endsWith(suffix))) || own[0];
}
