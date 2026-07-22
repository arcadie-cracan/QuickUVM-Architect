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
export function ungeneratedNodeIds(manifest: Manifest): Set<string> {
  const out = new Set<string>();
  for (const el of manifest.elements) {
    const nodeId = ownerToNodeId(el.owner);
    if (nodeId === null) continue;
    if (el.files.some((f) => !f.exists)) {
      out.add(nodeId);
    }
  }
  return out;
}
