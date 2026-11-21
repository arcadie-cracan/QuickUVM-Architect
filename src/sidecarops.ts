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
import {
  ANNOT_COLORS,
  ANNOT_NOTE_MAX,
  ANNOT_TITLE_MAX,
  type AnnotColor,
  type SidecarData,
  type SidecarFrame,
  type SidecarNode,
  type SidecarNote,
  type SidecarOrphan,
  type SidecarView,
  type ViewAnnotations,
  type ViewFilters,
} from "./protocol";
import { sanitizeFilters } from "./webview/filters";
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
    throw new Error("the sidecar is not a YAML object");
  }
  if (data.schema_version !== SIDECAR_VERSION) {
    throw new Error(
      `versiune de sidecar necunoscuta: ${String(data.schema_version)}`
    );
  }
  const views: Record<string, SidecarView> = {};
  if (typeof data.views === "object" && data.views !== null) {
    for (const [id, raw] of Object.entries(data.views as Record<string, unknown>)) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const view = raw as SidecarView;
      // docs/08 R21 — the secondary notation is read through the SAME sanitiser
      // it is written through: the file is hand-editable and merged by git, and
      // a frame without `members` (or a null entry) threw in `invalidate` on
      // every model, which the host runs BEFORE it posts the model — the diagram
      // then never saw another recompile, with no banner (review finding)
      if (view.frames !== undefined) {
        const frames = cleanFrames(view.frames);
        if (Object.keys(frames).length) {
          view.frames = frames;
        } else {
          delete view.frames;
        }
      }
      if (view.notes !== undefined) {
        const notes = cleanNotes(view.notes);
        if (Object.keys(notes).length) {
          view.notes = notes;
        } else {
          delete view.notes;
        }
      }
      if (view.nodes !== undefined && (view.nodes === null || typeof view.nodes !== "object")) {
        delete view.nodes;
      }
      if (view.filters !== undefined) {
        // docs/08 R23 — read through the same reduction it is written through
        const filters = sanitizeFilters(view.filters);
        if (filters.rules.length) {
          view.filters = filters;
        } else {
          delete view.filters;
        }
      }
      for (const n of Object.values(view.nodes ?? {})) {
        if (n && n.color !== undefined && !isColor(n.color)) {
          delete n.color;
        }
      }
      views[id] = view;
    }
  }
  return {
    schema_version: SIDECAR_VERSION,
    views,
    orphans: Array.isArray(data.orphans)
      ? (data.orphans as SidecarOrphan[]).filter(
          (o) => o !== null && typeof o === "object" && typeof o.view === "string"
        )
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
    if (v.hidePins) {
      out.hidePins = true; // docs/08 R18: a view-level override
    }
    // docs/08 R21 — the secondary notation (this function WHITELISTS what it
    // copies: a key not named here is lost at the first save)
    if (v.frames && Object.keys(v.frames).length) {
      const frames: Record<string, SidecarFrame> = {};
      for (const k of Object.keys(v.frames).sort()) {
        frames[k] = v.frames[k];
      }
      out.frames = frames;
    }
    if (v.notes && Object.keys(v.notes).length) {
      const notes: Record<string, SidecarNote> = {};
      for (const k of Object.keys(v.notes).sort()) {
        notes[k] = v.notes[k];
      }
      out.notes = notes;
    }
    if (v.filters?.rules.length) {
      out.filters = v.filters; // docs/08 R23: the rule ORDER is meaning — not sorted
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

/** does the view hold no override of any kind? Every view-level key must be
 *  named HERE: a view judged empty is deleted with whatever it still holds */
function viewEmpty(view: SidecarView): boolean {
  return (
    !view.nodes &&
    !view.nets &&
    !view.hidePins &&
    !(view.frames && Object.keys(view.frames).length) &&
    !(view.notes && Object.keys(view.notes).length) &&
    !view.filters?.rules.length
  );
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
  if (view.frames && Object.keys(view.frames).length === 0) {
    delete view.frames;
  }
  if (view.notes && Object.keys(view.notes).length === 0) {
    delete view.notes;
  }
  if (view.filters && !view.filters.rules.length) {
    delete view.filters;
  }
  if (nodeId && view.nodes) {
    const n = view.nodes[nodeId];
    if (
      n &&
      n.x === undefined &&
      n.collapsed === undefined &&
      n.flipH === undefined &&
      n.flipV === undefined &&
      n.color === undefined
    ) {
      delete view.nodes[nodeId];
    }
    if (Object.keys(view.nodes).length === 0) {
      delete view.nodes;
    }
  }
  if (viewEmpty(view)) {
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

/** docs/08 R18 — a TB block collapsed to its header: `collapsed: true` is the
 *  override, expanded is the default (not persisted). The TB keys
 *  (`tb:<config>|<focus>`) are never invalidated, so no orphan cleanup applies. */
export function setCollapsed(
  data: SidecarData,
  viewId: string,
  nodeId: string,
  collapsed: boolean
): SidecarData {
  const n = nodeOf(data, viewId, nodeId);
  if (collapsed) {
    n.collapsed = true;
  } else {
    delete n.collapsed;
  }
  prune(data, viewId, nodeId);
  return data;
}

/** docs/08 R18 — an RTL view hides its nc / ignored pins: `hidePins: true` is
 *  the override, shown is the default (not persisted) */
export function setHidePins(data: SidecarData, viewId: string, hidden: boolean): SidecarData {
  const view = viewOf(data, viewId);
  if (hidden) {
    view.hidePins = true;
  } else {
    delete view.hidePins;
  }
  prune(data, viewId);
  return data;
}

// ---------------------------------------- secondary notation (docs/08 R21)

const isColor = (c: unknown): c is AnnotColor =>
  typeof c === "string" && (ANNOT_COLORS as readonly string[]).includes(c);

/** the numeric suffix of `frame:<n>` / `note:<n>` — ids are ordered by it, so
 *  `frame:2` comes before `frame:10` on both sides of the protocol */
const idNumber = (id: string): number => Number(id.slice(id.indexOf(":") + 1));

/**
 * Frames reduced to what a frame is: an id `frame:<n>`, a title, at least one
 * member id (strings, each claimed by ONE frame — the lower-numbered frame
 * keeps a member claimed twice), a palette colour. Everything else is dropped.
 */
export function cleanFrames(raw: unknown): Record<string, SidecarFrame> {
  const out: Record<string, SidecarFrame> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  const src = raw as Record<string, unknown>;
  const claimed = new Set<string>();
  const ids = Object.keys(src)
    .filter((id) => /^frame:\d+$/.test(id))
    .sort((a, b) => idNumber(a) - idNumber(b));
  for (const id of ids) {
    const f = src[id] as Partial<SidecarFrame> | null;
    if (f === null || typeof f !== "object" || !Array.isArray(f.members)) {
      continue;
    }
    const members: string[] = [];
    for (const m of f.members as unknown[]) {
      if (typeof m === "string" && m && !claimed.has(m)) {
        claimed.add(m);
        members.push(m);
      }
    }
    if (!members.length) {
      continue;
    }
    const frame: SidecarFrame = {
      title: (typeof f.title === "string" ? f.title : "").trim().slice(0, ANNOT_TITLE_MAX),
      members,
    };
    if (isColor(f.color)) {
      frame.color = f.color;
    }
    out[id] = frame;
  }
  return out;
}

/** Notes reduced to what a note is: an id `note:<n>`, a finite position, some
 *  text (a string, bounded), a palette colour */
export function cleanNotes(raw: unknown): Record<string, SidecarNote> {
  const out: Record<string, SidecarNote> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = v as Partial<SidecarNote> | null;
    if (
      !/^note:\d+$/.test(id) ||
      n === null ||
      typeof n !== "object" ||
      typeof n.x !== "number" ||
      typeof n.y !== "number" ||
      !Number.isFinite(n.x) ||
      !Number.isFinite(n.y) ||
      typeof n.text !== "string" ||
      !n.text.trim()
    ) {
      continue;
    }
    const note: SidecarNote = { x: n.x, y: n.y, text: n.text.slice(0, ANNOT_NOTE_MAX) };
    if (isColor(n.color)) {
      note.color = n.color;
    }
    out[id] = note;
  }
  return out;
}

/** the smallest free `<kind>:<n>` among `used` */
function freeId(kind: "frame" | "note", used: Iterable<string>): string {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(`${kind}:${n}`)) {
    n++;
  }
  return `${kind}:${n}`;
}

/** the secondary notation of a view, as a detached copy (frames, notes, and
 *  the node colours gathered from the node entries) */
export function getAnnotations(data: SidecarData, viewId: string): ViewAnnotations {
  const view = data.views[viewId];
  const out: ViewAnnotations = { frames: {}, notes: {}, colors: {} };
  for (const [id, f] of Object.entries(view?.frames ?? {})) {
    out.frames[id] = { ...f, members: [...f.members] };
  }
  for (const [id, n] of Object.entries(view?.notes ?? {})) {
    out.notes[id] = { ...n };
  }
  for (const [id, n] of Object.entries(view?.nodes ?? {})) {
    if (n.color) {
      out.colors[id] = n.color;
    }
  }
  return out;
}

/**
 * Replaces the secondary notation of a view with `a` (the webview sends the
 * whole set after each gesture). What arrives is SANITISED, not trusted: the
 * file is hand-editable and the message crosses a process boundary — a frame
 * needs at least one member (an empty frame is deleted: it has nothing to draw
 * around), a note a finite position and some text, a colour a name from the
 * palette (`cleanFrames` / `cleanNotes` — the SAME reduction `parseSidecar`
 * applies to a file). A node belongs to ONE frame: on a double claim the
 * lower-numbered frame keeps it. Positions, folds and flips are untouched.
 */
export function setAnnotations(
  data: SidecarData,
  viewId: string,
  a: ViewAnnotations
): SidecarData {
  const view = viewOf(data, viewId);
  const frames = cleanFrames(a?.frames);
  const notes = cleanNotes(a?.notes);
  view.frames = frames;
  view.notes = notes;
  // the colours live on the node entries: clear the old ones, set the new
  for (const id of Object.keys(view.nodes ?? {})) {
    if (view.nodes?.[id].color !== undefined) {
      delete view.nodes[id].color;
      prune(data, viewId, id);
    }
  }
  for (const [id, c] of Object.entries(a?.colors ?? {})) {
    if (id && isColor(c)) {
      nodeOf(data, viewId, id).color = c;
    }
  }
  prune(data, viewId);
  return data;
}

/**
 * docs/08 R23 — replaces the filter rules of a view (sanitised: a known effect,
 * an optional kind and pattern, at most `MAX_RULES`). No rules, no key.
 */
export function setFilters(data: SidecarData, viewId: string, filters: unknown): SidecarData {
  const view = viewOf(data, viewId);
  const clean: ViewFilters = sanitizeFilters(filters);
  if (clean.rules.length) {
    view.filters = clean;
  } else {
    delete view.filters;
  }
  prune(data, viewId);
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
  const annotOrphans: SidecarOrphan[] = [];
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
    if (o.kind === "frame" || o.kind === "note") {
      annotOrphans.push(o); // restored below, notes BEFORE frames
      continue;
    }
    if (o.kind === "filters") {
      // docs/08 R23 — a view's rules come back with the view; rules written
      // meanwhile are the newer ones and stay
      if (keysFor(o.view) === null) {
        still.push(o);
        continue;
      }
      const view = viewOf(data, o.view);
      const clean = sanitizeFilters(o.value);
      if (!view.filters && clean.rules.length) {
        view.filters = clean;
      } else if (viewEmpty(view)) {
        delete data.views[o.view];
      }
      changed = true;
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
  // docs/08 R21 — the secondary notation comes back with its view: a note at
  // once, a frame once one of its members exists again — a node key of the
  // view, OR a note of it (which is why the notes are restored first: a frame
  // around notes only would otherwise wait forever). Frame and note ids are
  // COUNTERS, not model keys: an id reused meanwhile says nothing about the
  // orphan, so it is restored under the next free id, never dropped (for a node
  // "the newer override wins"; here that would discard a titled frame).
  const renamed = new Map<string, string>(); // `<view>\0<old note id>` -> new id
  for (const pass of ["note", "frame"] as const) {
    for (const o of annotOrphans) {
      if (o.kind !== pass) {
        continue;
      }
      const keys = keysFor(o.view);
      if (keys === null) {
        still.push(o);
        continue;
      }
      const view = viewOf(data, o.view);
      if (pass === "note") {
        const note = cleanNotes({ [o.node]: o.value })[o.node];
        if (note) {
          const id = view.notes?.[o.node] ? freeId("note", Object.keys(view.notes)) : o.node;
          (view.notes ??= {})[id] = note;
          if (id !== o.node) {
            renamed.set(`${o.view}\0${o.node}`, id);
          }
        }
        changed = true;
        continue;
      }
      const frame = cleanFrames({ [o.node]: o.value })[o.node];
      if (!frame) {
        changed = true; // nothing a frame could be: dropped
        continue;
      }
      frame.members = frame.members.map((m) => renamed.get(`${o.view}\0${m}`) ?? m);
      if (!frame.members.some((m) => keys.has(m) || Boolean(view.notes?.[m]))) {
        still.push(o);
        if (!view.nodes && !view.nets && !view.hidePins && !view.frames && !view.notes) {
          delete data.views[o.view]; // `viewOf` created it for nothing
        }
        continue;
      }
      const id = view.frames?.[o.node] ? freeId("frame", Object.keys(view.frames)) : o.node;
      (view.frames ??= {})[id] = frame;
      changed = true;
    }
  }
  data.orphans = still;
  /** an annotation orphan, replacing one already recorded for the same id (a
   *  stale whole set re-adding a dead frame must not pile up duplicates) */
  const orphanAnnot = (
    view: string,
    node: string,
    kind: "frame" | "note",
    value: SidecarFrame | SidecarNote
  ): void => {
    data.orphans = data.orphans.filter(
      (x) => !(x.view === view && x.node === node && x.kind === kind)
    );
    data.orphans.push({ view, node, kind, value, lastSeen: today });
  };

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
    // docs/08 R18 — a view-level override (`hidePins`) is not a node: it stays
    // while the view is a view. A LEAF instance has no schematic keys (`keys ===
    // null`) but its symbol is a valid view, so the override on it stays too —
    // the first cut lost the DUT's hidden pins on every recompile (review finding).
    // docs/08 R21: the same for its frames and notes (the leaf's boundary view
    // can carry them, and there are no keys to judge a frame's members by)
    const hasAnnot = !viewEmpty({
      frames: view.frames,
      notes: view.notes,
      filters: view.filters,
    });
    const leafView =
      keys === null &&
      (Boolean(view.hidePins) || hasAnnot) &&
      model.instances.some((i) => i.path === viewId);
    if (keys !== null) {
      // docs/08 R21 — a frame none of whose members is a key any more has
      // nothing to draw around: it migrates WHOLE (title, colour, members), and
      // comes back when a member does. A frame with one live member stays, its
      // dead member ids inert — they are restored with their nodes, not pruned
      for (const [id, f] of Object.entries(view.frames ?? {})) {
        const live = f.members.some((m) => keys.has(m) || Boolean(view.notes?.[m]));
        if (!live) {
          orphanAnnot(viewId, id, "frame", f);
          delete view.frames![id];
          changed = true;
        }
      }
      if (view.frames && Object.keys(view.frames).length === 0) {
        delete view.frames;
      }
    }
    if (keys === null && !leafView) {
      // the view itself disappeared: the positions migrated into orphans (the
      // protected asset, docs/04) — and so do its frames and notes (R21)
      for (const [id, f] of Object.entries(view.frames ?? {})) {
        orphanAnnot(viewId, id, "frame", f);
      }
      for (const [id, n] of Object.entries(view.notes ?? {})) {
        orphanAnnot(viewId, id, "note", n);
      }
      if (view.filters?.rules.length) {
        // docs/08 R23 — the rules are the user's work too: they wait for the view
        data.orphans = data.orphans.filter(
          (x) => !(x.view === viewId && x.kind === "filters")
        );
        data.orphans.push({
          view: viewId,
          node: "filters",
          kind: "filters",
          value: view.filters,
          lastSeen: today,
        });
      }
      delete data.views[viewId];
      changed = true;
    } else if (viewEmpty(view)) {
      delete data.views[viewId];
    }
  }
  return changed;
}
