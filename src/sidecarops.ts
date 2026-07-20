// The pure mutations of the layout sidecar (docs/04): YAML parsing/serialization
// and the operations on the structure, without `vscode` — testable in Node
// (scripts/test-sidecar.mjs). The src/sidecar.ts service wraps them with
// files, watcher and commands.
//
// Principles (docs/04):
// - the file contains ONLY overrides (positions, folds, flips) —
//   never
//   data derived from the model; entries without content are removed;
// - graceful invalidation: keys that disappeared from the model migrate into `orphans`
//   with the date of the last valid view; keys that reappear (a temporary
//   compilation error, revert) are restored automatically from orphans;
// - deterministic serialization (sorted keys) for stable git diffs.

import { parse, stringify } from "yaml";
import type { ProjectModel } from "./model";
import type {
  SidecarData,
  SidecarNode,
  SidecarOrphan,
  SidecarView,
} from "./protocol";
import { buildSchematicScene } from "./webview/scene";

export const SIDECAR_VERSION = 1;

export function emptySidecar(): SidecarData {
  return { schema_version: SIDECAR_VERSION, views: {}, orphans: [] };
}

/**
 * Parses the content of the sidecar file. Throws on invalid YAML or on an
 * unknown schema version — the caller decides what to do with the file
 * (the service keeps it as .bak, does not overwrite it blindly).
 */
export function parseSidecar(text: string): SidecarData {
  if (!text.trim()) {
    return emptySidecar();
  }
  const data = parse(text) as Record<string, unknown> | null;
  if (data === null || typeof data !== "object") {
    throw new Error("sidecar-ul nu este un obiect YAML");
  }
  if (data.schema_version !== SIDECAR_VERSION) {
    throw new Error(
      `versiune de sidecar necunoscuta: ${String(data.schema_version)}`
    );
  }
  return {
    schema_version: SIDECAR_VERSION,
    views:
      typeof data.views === "object" && data.views !== null
        ? (data.views as Record<string, SidecarView>)
        : {},
    orphans: Array.isArray(data.orphans)
      ? (data.orphans as SidecarOrphan[])
      : [],
  };
}

/** deterministic serialization: the views and nodes sorted by key */
export function serializeSidecar(data: SidecarData): string {
  const views: Record<string, SidecarView> = {};
  for (const viewId of Object.keys(data.views).sort()) {
    const v = data.views[viewId];
    const out: SidecarView = {};
    if (v.nodes && Object.keys(v.nodes).length) {
      const nodes: Record<string, SidecarNode> = {};
      for (const k of Object.keys(v.nodes).sort()) {
        nodes[k] = v.nodes[k];
      }
      out.nodes = nodes;
    }
    if (v.nets && Object.keys(v.nets).length) {
      const nets: NonNullable<SidecarView["nets"]> = {};
      for (const k of Object.keys(v.nets).sort()) {
        nets[k] = v.nets[k];
      }
      out.nets = nets;
    }
    views[viewId] = out;
  }
  return stringify(
    { schema_version: data.schema_version, views, orphans: data.orphans },
    { lineWidth: 0 }
  );
}

// ------------------------------------------------------------------ mutations

function viewOf(data: SidecarData, viewId: string): SidecarView {
  const v = data.views[viewId] ?? {};
  data.views[viewId] = v;
  return v;
}

function nodeOf(data: SidecarData, viewId: string, nodeId: string): SidecarNode {
  const view = viewOf(data, viewId);
  const nodes = view.nodes ?? {};
  view.nodes = nodes;
  const n = nodes[nodeId] ?? {};
  nodes[nodeId] = n;
  return n;
}

/** deletes the entries left without content (the file holds only overrides) */
function prune(data: SidecarData, viewId: string, nodeId?: string): void {
  const view = data.views[viewId];
  if (!view) {
    return;
  }
  if (view.nets && Object.keys(view.nets).length === 0) {
    delete view.nets;
  }
  if (nodeId && view.nodes) {
    const n = view.nodes[nodeId];
    if (
      n &&
      n.x === undefined &&
      n.collapsed === undefined &&
      n.flipH === undefined &&
      n.flipV === undefined
    ) {
      delete view.nodes[nodeId];
    }
    if (Object.keys(view.nodes).length === 0) {
      delete view.nodes;
    }
  }
  if (!view.nodes && !view.nets) {
    delete data.views[viewId];
  }
}

export function setNodePos(
  data: SidecarData,
  viewId: string,
  nodeId: string,
  x: number,
  y: number
): SidecarData {
  const n = nodeOf(data, viewId, nodeId);
  n.x = x;
  n.y = y;
  return data;
}

export function setFold(
  data: SidecarData,
  viewId: string,
  foldId: string,
  collapsed: boolean
): SidecarData {
  const n = nodeOf(data, viewId, foldId);
  if (collapsed) {
    delete n.collapsed; // folded = the default; not persisted
  } else {
    n.collapsed = false;
  }
  prune(data, viewId, foldId);
  return data;
}

export function setFlip(
  data: SidecarData,
  viewId: string,
  nodeId: string,
  flipH: boolean,
  flipV: boolean
): SidecarData {
  const n = nodeOf(data, viewId, nodeId);
  if (flipH) {
    n.flipH = true;
  } else {
    delete n.flipH; // not-flipped = the default; not persisted
  }
  if (flipV) {
    n.flipV = true;
  } else {
    delete n.flipV;
  }
  prune(data, viewId, nodeId);
  return data;
}

/**
 * The level-4 override (docs/04): wire <-> label per net. `suggestion`
 * is the model's suggestion — a choice equal to the suggestion deletes the override
 * (the file holds only deviations from the default).
 */
export function setNetRender(
  data: SidecarData,
  viewId: string,
  net: string,
  render: "wire" | "label",
  suggestion: "wire" | "label"
): SidecarData {
  const view = viewOf(data, viewId);
  if (render === suggestion) {
    if (view.nets) {
      delete view.nets[net];
    }
  } else {
    (view.nets ??= {})[net] = { render };
  }
  prune(data, viewId);
  return data;
}

/**
 * The position snapshot of a view (docs/04): on the first position gesture,
 * the arrangement of the whole view becomes the user's — ALL the received
 * positions are written, over the existing ones; the folds/flips remain.
 */
export function setPositions(
  data: SidecarData,
  viewId: string,
  nodes: Record<string, { x: number; y: number }>
): SidecarData {
  for (const [nodeId, p] of Object.entries(nodes)) {
    setNodePos(data, viewId, nodeId, p.x, p.y);
  }
  return data;
}

export function cleanOrphans(data: SidecarData): SidecarData {
  data.orphans = [];
  return data;
}

/**
 * "Re-arrange all" (docs/04): deletes the positions (x/y) from the nodes of a
 * view — the folding and the flips remain; the entries left without content
 * disappear (the file holds only overrides).
 */
export function clearPositions(data: SidecarData, viewId: string): SidecarData {
  const nodes = data.views[viewId]?.nodes ?? {};
  for (const id of Object.keys(nodes)) {
    delete nodes[id].x;
    delete nodes[id].y;
    prune(data, viewId, id);
  }
  prune(data, viewId);
  return data;
}

// ------------------------------------------------- graceful invalidation

/**
 * The valid node keys in a view: the scene nodes folded by default,
 * the members of all the folds (the user can have positions for expanded
 * members too) and the boundary flags (`<port>.x` — mutable as well).
 * Returns null if the view does not exist in the model.
 */
export function validNodeKeys(
  model: ProjectModel,
  viewId: string
): Set<string> | null {
  const collapsed = buildSchematicScene(model, viewId, new Set());
  if (!collapsed) {
    return null;
  }
  const keys = new Set<string>();
  const folds = new Set<string>();
  for (const b of collapsed.boundary) {
    keys.add(b.id);
  }
  for (const n of collapsed.nodes) {
    keys.add(n.id);
    if (n.kind === "fold") {
      folds.add(n.id);
    }
  }
  if (folds.size) {
    const expanded = buildSchematicScene(model, viewId, folds);
    for (const n of expanded?.nodes ?? []) {
      keys.add(n.id);
    }
  }
  return keys;
}

/**
 * Graceful invalidation (docs/04): the keys that no longer exist in the model
 * migrate into `orphans` with the date of the last valid view; the orphans whose
 * keys have reappeared are restored (without stepping over new overrides).
 * Returns true if the structure changed.
 */
export function invalidate(
  data: SidecarData,
  model: ProjectModel,
  today: string
): boolean {
  let changed = false;
  const valid = new Map<string, Set<string> | null>();
  const keysFor = (viewId: string): Set<string> | null => {
    if (!valid.has(viewId)) {
      valid.set(viewId, validNodeKeys(model, viewId));
    }
    return valid.get(viewId) ?? null;
  };

  // 1. restoring the orphans whose keys have reappeared
  const still: SidecarOrphan[] = [];
  for (const o of data.orphans) {
    if (o.kind === "net") {
      const nets = model.views[o.view]?.nets ?? [];
      if (nets.some((n) => n.name === o.node)) {
        const view = viewOf(data, o.view);
        if (!view.nets?.[o.node]) {
          (view.nets ??= {})[o.node] = o.value as { render: "wire" | "label" };
        }
        changed = true;
      } else {
        still.push(o);
      }
      continue;
    }
    const keys = keysFor(o.view);
    if (keys?.has(o.node)) {
      const existing = data.views[o.view]?.nodes?.[o.node];
      if (!existing) {
        const n = nodeOf(data, o.view, o.node);
        Object.assign(n, o.value as Record<string, unknown>);
      }
      changed = true; // the orphan disappears from the list, restored or not
    } else {
      still.push(o);
    }
  }
  data.orphans = still;

  // 2. the current keys that no longer exist -> orphans
  for (const viewId of Object.keys(data.views)) {
    if (viewId.startsWith("tb:")) {
      // the verification view (docs/05): its keys come from the QuickUVM YAML,
      // not from the RTL model — model invalidation does not touch it
      continue;
    }
    const keys = keysFor(viewId);
    const view = data.views[viewId];
    const netNames = new Set(
      (model.views[viewId]?.nets ?? []).map((n) => n.name)
    );
    for (const net of Object.keys(view.nets ?? {})) {
      if (netNames.has(net)) {
        continue;
      }
      data.orphans.push({
        view: viewId,
        node: net,
        kind: "net",
        value: view.nets![net],
        lastSeen: today,
      });
      delete view.nets![net];
      changed = true;
    }
    if (view.nets && Object.keys(view.nets).length === 0) {
      delete view.nets;
    }
    for (const nodeId of Object.keys(view.nodes ?? {})) {
      if (keys?.has(nodeId)) {
        continue;
      }
      data.orphans.push({
        view: viewId,
        node: nodeId,
        value: view.nodes![nodeId],
        lastSeen: today,
      });
      delete view.nodes![nodeId];
      changed = true;
    }
    if (view.nodes && Object.keys(view.nodes).length === 0) {
      delete view.nodes;
    }
    if (keys === null) {
      // the view itself disappeared: the positions migrated into orphans (the
      // protected asset, docs/04)
      delete data.views[viewId];
      changed = true;
    } else if (!view.nodes && !view.nets) {
      delete data.views[viewId];
    }
  }
  return changed;
}
