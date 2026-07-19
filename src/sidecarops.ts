// Mutatiile pure ale sidecar-ului de layout (docs/04): parsare/serializare
// YAML si operatiile pe structura, fara `vscode` — testabile in Node
// (scripts/test-sidecar.mjs). Serviciul src/sidecar.ts le ambaleaza cu
// fisiere, watcher si comenzi.
//
// Principii (docs/04):
// - fisierul contine DOAR override-uri (pozitii, pliaje, rasturnari) —
//   niciodata
//   date derivate din model; intrarile fara continut se elimina;
// - invalidare gratioasa: cheile disparute din model migreaza in `orphans`
//   cu data ultimei vederi valide; cheile care reapar (eroare temporara de
//   compilare, revert) se restaureaza automat din orphans;
// - serializare determinista (chei sortate) pentru diff-uri git stabile.

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
 * Parseaza continutul fisierului sidecar. Arunca la YAML invalid sau la
 * versiune de schema necunoscuta — apelantul decide ce face cu fisierul
 * (serviciul il pastreaza ca .bak, nu il suprascrie orbeste).
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

/** serializare determinista: vederile si nodurile sortate dupa cheie */
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

// ------------------------------------------------------------------ mutatii

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

/** sterge intrarile ramase fara continut (fisierul tine doar override-uri) */
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
    delete n.collapsed; // pliat = implicitul; nu se persista
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
    delete n.flipH; // ne-rasturnat = implicitul; nu se persista
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
 * Override-ul de nivel 4 (docs/04): fir <-> eticheta per net. `suggestion`
 * e sugestia din model — alegerea egala cu sugestia sterge override-ul
 * (fisierul tine doar abateri de la implicit).
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
 * Snapshot-ul pozitiilor unei vederi (docs/04): la primul gest de pozitie,
 * aranjamentul intregii vederi devine al utilizatorului — se scriu TOATE
 * pozitiile primite, peste cele existente; pliajele/rasturnarile raman.
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
 * "Re-aranjeaza tot" (docs/04): sterge pozitiile (x/y) din nodurile unei
 * vederi — plierea si rasturnarile raman; intrarile ramase fara continut
 * dispar (fisierul tine doar override-uri).
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

// ------------------------------------------------- invalidare gratioasa

/**
 * Cheile de nod valide intr-o vedere: nodurile scenei pliate implicit,
 * membrii tuturor pliajelor (utilizatorul poate avea pozitii si pentru
 * membri expandati) si steagurile granitei (`<port>.x` — mutabile si ele).
 * Intoarce null daca vederea nu exista in model.
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
 * Invalidarea gratioasa (docs/04): cheile care nu mai exista in model
 * migreaza in `orphans` cu data ultimei vederi valide; orfanele ale caror
 * chei au reaparut se restaureaza (fara a calca peste override-uri noi).
 * Intoarce true daca structura s-a schimbat.
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

  // 1. restaurarea orfanelor ale caror chei au reaparut
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
      changed = true; // orfanul dispare din lista, restaurat sau nu
    } else {
      still.push(o);
    }
  }
  data.orphans = still;

  // 2. cheile curente care nu mai exista -> orphans
  for (const viewId of Object.keys(data.views)) {
    if (viewId.startsWith("tb:")) {
      // vederea de verificare (docs/05): cheile ei vin din YAML-ul QuickUVM,
      // nu din modelul RTL — invalidarea pe model nu o atinge
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
      // vederea insasi a disparut: pozitiile au migrat in orphans (activul
      // protejat, docs/04)
      delete data.views[viewId];
      changed = true;
    } else if (!view.nodes && !view.nets) {
      delete data.views[viewId];
    }
  }
  return changed;
}
