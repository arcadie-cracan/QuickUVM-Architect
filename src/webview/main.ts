// The webview code: the two RTL views (docs/05) — the context of a module
// (rectangle with pins on the sides, ELK with FIXED_ORDER ports) and the schematic
// (instances + interconnect, scene from scene.ts, layout/drawing from schematic.ts).
// SVG generated manually (docs/04), pan/zoom and simple selection. No framework
// (docs/01, decision D5).

import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import type { Instance, ModuleDef, ProjectModel } from "../model";
import type {
  ActionKind,
  HostMessage,
  OverlayConfig,
  ViewMode,
  WebviewMessage,
} from "../protocol";
import type { GenerateStatus, SidecarData, SidecarNode, StatusDeco, UiConfig, XprobeTarget } from "../protocol";
import { probeIds, ProbeViewCtx, remapSelection } from "../locmap";
import { ElementStatus, statusIdsRtl, statusIdsTb } from "../status";
import { kindBlockers, layoutBlockers } from "../benchid";
import {
  coveredAgent,
  coverpointCandidates,
  crossBlockers,
  crossFields,
  crossName,
  formatBinSpec,
  isRich,
  scoreboardEndpoints,
} from "../coverage";
import type { QuvmAgent, QuvmConfig, QuvmPort, QuvmScoreboard } from "../quickuvm";
import { alignSnap, AlignPt, AlignSnap, centerChipSigns, drawSchematic, Flip, layoutSchematic, pinTipOffsets, portLabelText, routeEdges } from "./schematic";
import { cameraForMinimapPoint, minimapLayout, minimapUseTransform, minimapViewRect, MmLayout } from "./minimap";
import { buildSchematicScene, coneOf, hasSchematic, portLabel, SchematicScene } from "./scene";
import type { TbScene } from "./tbscene";
import { buildTbScene } from "./tbscene";
import { drawTb, drawTbEdges, layoutTb, TbLayout } from "./tbschematic";
import { el, measurer, SVG_NS } from "./svg";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): { viewId?: string; mode?: ViewMode } | undefined;
  setState(state: { viewId?: string; mode?: ViewMode }): void;
};

const vscode = acquireVsCodeApi();
const elk = new ELK();

const STUB = 14; // the length of the pin line, in px, outside the rectangle

// ----------------------------------------------------------------- state

interface State {
  model: ProjectModel | undefined;
  viewId: string | undefined;
  /** the display mode of the current view (docs/05) */
  mode: ViewMode;
  selection: Set<string>;
  /** the state derived from the QuickUVM YAML; null = no configuration */
  overlay: OverlayConfig | null;
  /** the parsed configuration + its path, for the verification (TB) view (docs/05) */
  config: QuvmConfig | null;
  configPath: string | null;
  /** docs/07 P3c — agents of each composed child, by subenv name (cross-block
   *  scoreboard endpoints are `<subenv>.<agent>`, declared in another file) */
  childAgents: Record<string, string[]>;
  /** the current level of the verification (TB) view (D24): "", "env", "agent:X" */
  tbFocus: string;
  // the pan/zoom transform of the view
  tx: number;
  ty: number;
  k: number;
}

const state: State = {
  model: undefined,
  viewId: vscode.getState()?.viewId,
  mode: vscode.getState()?.mode ?? "symbol",
  selection: new Set(),
  overlay: null,
  config: null,
  configPath: null,
  childAgents: {},
  tbFocus: "",
  tx: 0,
  ty: 0,
  k: 1,
};

/** the pins of the current symbol view (empty in the schematic — disables the actions) */
let currentPins: PinSpec[] = [];

/** the scene of the current schematic view, for the inspector */
let currentScene: SchematicScene | null = null;

/** the scene+layout of the verification (TB) view (hierarchical), for the inspector */
let currentTbScene: TbScene | null = null;
let currentTbLayout: TbLayout | null = null;
/** the group of TB edges, re-routed live on drag (like `currentEdgesGroup` in RTL) */
let currentTbEdgesGroup: SVGGElement | null = null;

/** the current ELK layout (the node positions; mutated during the drag) */
let currentLayout: ElkNode | null = null;

/** the SVG group of the edges, re-routed live during the drag */
let currentEdgesGroup: SVGGElement | null = null;

/** the local copy of the layout sidecar (docs/04); our own gestures keep it
 *  up to date — the host does not echo back its own moves (docs/05) */
let sidecar: SidecarData = { schema_version: 1, views: {}, orphans: [] };

function sidecarNode(viewId: string, nodeId: string): SidecarNode {
  const view = (sidecar.views[viewId] ??= {});
  const nodes = (view.nodes ??= {});
  return (nodes[nodeId] ??= {});
}

/**
 * The sidecar/camera key of the current view. RTL views use `viewId`;
 * the verification (TB) view has a `focus` (level: ""/env/agent:X) under the same
 * key `tb:<config>`, and the node ids repeat between the agent
 * levels (`u.sequencer` at agent:cmd and agent:rsp) — so the positions are keyed
 * per level: `tb:<config>|<focus>`. The key stays prefixed with `tb:`, so
 * the invalidation of the sidecar against the RTL model does not touch it (docs/04).
 */
function layoutKey(): string | undefined {
  if (!state.viewId) {
    return undefined;
  }
  return state.mode === "tb" ? `${state.viewId}|${state.tbFocus}` : state.viewId;
}

/** the rectangle that encloses the TB boxes+flags (after drags/seeds) */
function tbBounds(layout: TbLayout): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number, w: number, h: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const p of layout.nodes.values()) {
    acc(p.x, p.y, p.w, p.h);
  }
  for (const p of layout.boundary.values()) {
    acc(p.x, p.y, p.w, 16); // BPORT_H
  }
  if (minX === Infinity) {
    return { x: 0, y: 0, w: layout.width, h: layout.height };
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** the explicitly expanded folds, per view; initialized from the sidecar at
 *  layout/full, persisted through fold/toggled */
const expandedFolds = new Map<string, Set<string>>();

function expandedFor(viewId: string): Set<string> {
  let s = expandedFolds.get(viewId);
  if (!s) {
    s = new Set();
    expandedFolds.set(viewId, s);
  }
  return s;
}

/** the last design view visited (viewId + mode) — the target of the
 *  „Design" button from the header of the verification (TB) view (docs/05) */
let lastRtl: { viewId: string; mode: "symbol" | "schematic" } | null = null;

/** does the current configuration have anything drawable in the verification (TB) view? */
function tbAvailable(): boolean {
  const c = state.config;
  return Boolean(
    c && (c.dut?.name || c.agents?.length || c.subenvs?.length)
  );
}

/** the local switch to the verification (TB) view (docs/05): the key comes from
 *  the config path; the host finds out through nav/drill (title + current view) */
function openTbView(): void {
  if (state.mode === "tb" || !tbAvailable()) {
    return;
  }
  if (state.viewId && !state.viewId.startsWith("tb:")) {
    lastRtl = {
      viewId: state.viewId,
      mode: state.mode === "schematic" ? "schematic" : "symbol",
    };
  }
  state.viewId = `tb:${state.configPath ?? ""}`;
  state.mode = "tb";
  state.selection.clear();
  postSelection();
  persistState();
  post({ v: 1, type: "nav/drill", instancePath: state.viewId, mode: state.mode });
  void render(true);
}

/** the return from the verification (TB) view to the last design view (RTL) —
 *  returns to the view and mode from before entering TB (D24: there is no longer a
 *  switch, so a single „Design" button, not Symbol/Schematic) */
function leaveTbView(): void {
  const target = lastRtl?.viewId ?? state.model?.tops[0];
  if (!target) {
    return;
  }
  state.viewId = target;
  state.mode =
    lastRtl?.mode === "schematic" && hasSchematic(state.model, target)
      ? "schematic"
      : "symbol";
  state.selection.clear();
  postSelection();
  persistState();
  post({ v: 1, type: "nav/drill", instancePath: target, mode: state.mode });
  void render(true);
}

/** the UI preferences from the extension settings (the ui/config message, docs/05) */
let uiConfig: UiConfig = { lasso: "contain", decorations: true };

/** the cameras per view — SESSION state, not project state (docs/04): the first
 *  opening of a view always fits into the window; the frame is
 *  kept only when switching between views in the same session */
const sessionCameras = new Map<
  string,
  { cx: number; cy: number; zoom: number }
>();

/** the render generation: a render started later cancels the old one */
let renderGen = 0;

function persistState(): void {
  vscode.setState({ viewId: state.viewId, mode: state.mode });
}

const canvas = document.getElementById("canvas") as unknown as SVGSVGElement;
const banner = document.getElementById("banner") as HTMLDivElement;
const head = document.getElementById("head") as HTMLElement;
const empty = document.getElementById("empty") as HTMLDivElement;
let viewport: SVGGElement | undefined;

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

// ---------------------------------------------------------------- messages

window.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as HostMessage;
  switch (m.type) {
    case "model/full":
      state.model = m.model;
      hideBanner();
      // the verification (TB) view (tb:...) is not an RTL instance: recompilation does not
      // re-key it onto tops[0] (re-keying would read/pollute the sidecar of the
      // RTL view with the TB nodes — regression caught by the adversarial review)
      if (
        !state.viewId ||
        (!state.viewId.startsWith("tb:") && !findInstance(state.viewId))
      ) {
        // re-key onto top: on the first opening (viewId undefined) the host
        // sends an explicit view/show anyway right after model/full, so
        // a nav/drill from here would race with it and leave the host on top;
        // on recompilation (the current view disappeared) NO view/show comes, so
        // here we resynchronize the hierarchy ourselves (docs/05)
        const wasStaleView = Boolean(state.viewId);
        state.viewId = m.model.tops[0];
        if (state.mode === "tb") {
          state.mode = "symbol";
        }
        if (wasStaleView) {
          post({
            v: 1,
            type: "nav/drill",
            instancePath: state.viewId,
            mode: state.mode,
          });
        }
      }
      void render();
      break;
    case "model/stale":
      showBanner(
        `View out of date (${m.errors} ${m.errors === 1 ? "error" : "errors"}) — ` +
          "showing the last valid model."
      );
      break;
    case "view/show":
      state.viewId = m.viewId;
      if (m.mode) {
        state.mode = m.mode;
      } else if (m.viewId.startsWith("tb:")) {
        state.mode = "tb";
      } else if (state.mode === "tb") {
        // RTL view requested without a mode (click in the hierarchy) when the
        // verification (TB) view was open: the tb mode is not inherited
        state.mode = "symbol";
      }
      state.selection.clear();
      postSelection();
      persistState();
      void render(true);
      break;
    case "select/reveal":
      state.selection = new Set(m.ids);
      applySelectionClasses();
      renderInspector();
      // echo to the host: without it, panel.selection stayed empty after a reveal
      // and the palette commands that read it acted on nothing (the
      // adversarial review of the synchronization); the remapping onto folds is done by presentScene
      postSelection();
      break;
    case "probe/highlight":
      // cross-probing editor->diagram: persistent halo, NOT selection —
      // the user's working selection stays untouched (docs/05)
      probeTargets = m.targets;
      applySelectionClasses();
      break;
    case "status/decorations":
      // the quick-uvm status decorations (docs/05): badges + generate chip
      statusDecos = m.decos;
      genStatus = m.generate;
      genMissing = new Set(m.genMissing);
      genStale = new Set(m.genStale);
      applyStatusBadges();
      applyGenBadges();
      updateGenChip();
      break;
    case "overlay/config": {
      const { v: _v, type: _t, ...overlay } = m;
      state.overlay = overlay;
      void render();
      break;
    }
    case "tb/navigate":
      state.tbFocus = m.focus;
      state.selection = new Set(m.select ? [m.select] : []);
      if (state.mode === "tb") {
        void render(true);
      }
      break;
    case "config/full":
      state.config = m.config;
      state.configPath = m.configPath;
      state.childAgents = m.childAgents ?? {};
      if (state.mode === "tb") {
        // another active config => another view key: the positions are not written
        // under the old config's key
        const key = `tb:${m.configPath ?? ""}`;
        if (state.viewId !== key) {
          state.viewId = key;
          state.selection.clear();
          postSelection();
          persistState();
        }
        void render();
      }
      break;
    case "export/request":
      exportSvg(); // command from the palette; the ⤓ button does the same thing locally
      break;
    case "theme/changed":
      void render(); // re-measure text with the current theme's font
      break;
    case "ui/config": {
      const { v: _v2, type: _t2, ...ui } = m;
      uiConfig = ui;
      // the drawing vocabulary is hidden through a class on the canvas (CSS), without
      // re-rendering — slash+width, junction dots (docs/04)
      canvas.classList.toggle("decor-off", uiConfig.decorations === false);
      break;
    }
    case "layout/full":
      // the source of truth for positions/folds/flips: the local state is
      // reconstructed entirely (external edit, invalidation, cleanup)
      sidecar = m.sidecar;
      expandedFolds.clear();
      for (const [viewId, view] of Object.entries(sidecar.views)) {
        for (const [nodeId, n] of Object.entries(view.nodes ?? {})) {
          if (n.collapsed === false) {
            expandedFor(viewId).add(nodeId);
          }
        }
      }
      void render(true);
      break;
    default:
      break; // messages of the following phases
  }
});

// ------------------------------------------------------------ construction

interface PinSpec {
  id: string; // stable ID relative to the view: `<port>.din` (docs/02)
  name: string;
  label: string;
  side: "WEST" | "EAST";
  iface: boolean;
  bus: boolean;
  mult: string | null;
  /** the pin's section in the symbol view (grouping by role, docs/04) */
  section: "clock/reset" | "signals";
  tooltip: string;
  labelW: number;
}

function findInstance(path: string): Instance | undefined {
  return state.model?.instances.find((i) => i.path === path);
}

function isClockOrReset(name: string, dir: string, width: number | null): boolean {
  // only a placement heuristic (bottom-left grouping); the real roles are
  // established at configuration, in the following phases (docs/02, docs/03)
  return dir === "in" && width === 1 && /clk|clock|rst|reset/i.test(name);
}

function buildPins(def: ModuleDef): PinSpec[] {
  const measure = measurer();
  const west: PinSpec[] = [];
  const east: PinSpec[] = [];
  const clkRst: PinSpec[] = [];

  for (const p of def.ports) {
    const elemW = p.elem_width ?? p.width;
    const bus = elemW !== null && elemW > 1;
    const label = portLabel(p);
    const widthInfo =
      p.width === null
        ? "no fixed size"
        : `${p.width} ${p.width === 1 ? "bit" : "bits"}`;
    const cr = isClockOrReset(p.name, p.dir, p.width);
    const spec: PinSpec = {
      id: `<port>.${p.name}`,
      name: p.name,
      label,
      side: p.dir === "in" ? "WEST" : "EAST",
      iface: false,
      bus,
      mult: p.unpacked_dims ? `×${p.unpacked_dims.join("×")}` : null,
      section: cr ? "clock/reset" : "signals",
      tooltip:
        `${p.name}: ${p.dir} ${p.type} (${widthInfo})` +
        (p.loc ? `\n${p.loc.file}:${p.loc.line}` : ""),
      labelW: measure(label, true),
    };
    if (cr) {
      clkRst.push(spec);
    } else if (p.dir === "in") {
      west.push(spec);
    } else {
      east.push(spec); // out, inout, ref — on the right
    }
  }

  for (const ip of def.iface_ports) {
    const label = `${ip.name} : ${ip.interface}${ip.modport ? "." + ip.modport : ""}`;
    west.push({
      id: `<port>.${ip.name}`,
      name: ip.name,
      label,
      side: "WEST",
      iface: true,
      bus: false,
      mult: null,
      section: "signals",
      tooltip:
        `${ip.name}: interface ${ip.interface}` +
        (ip.modport ? `, modport ${ip.modport}` : "") +
        (ip.loc ? `\n${ip.loc.file}:${ip.loc.line}` : ""),
      labelW: measure(label, true),
    });
  }

  // data inputs, then interfaces, then clock/reset — bottom-left (docs/05)
  return [...west, ...clkRst, ...east];
}

async function layoutSymbol(
  moduleName: string,
  pins: PinSpec[]
): Promise<ElkNode> {
  const measure = measurer();
  const westPins = pins.filter((p) => p.side === "WEST");
  const eastPins = pins.filter((p) => p.side === "EAST");
  // FIXED_ORDER counts clockwise: EAST top->bottom, WEST bottom->top
  const index = new Map<string, number>();
  eastPins.forEach((p, i) => index.set(p.id, i));
  [...westPins].reverse().forEach((p, i) => index.set(p.id, eastPins.length + i));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: { "elk.algorithm": "layered" },
    children: [
      {
        id: "ctx",
        layoutOptions: {
          "elk.portConstraints": "FIXED_ORDER",
          "elk.nodeSize.constraints": "PORTS PORT_LABELS NODE_LABELS MINIMUM_SIZE",
          "elk.nodeSize.minimum": "(200, 100)",
          "elk.portLabels.placement": "INSIDE",
          "elk.spacing.portPort": "12",
          "elk.spacing.portsSurrounding": "[top=32,left=0,bottom=16,right=0]",
          "elk.nodeLabels.placement": "H_CENTER V_TOP INSIDE",
        },
        labels: [
          { text: moduleName, width: measure(moduleName) + 24, height: 26 },
        ],
        ports: pins.map((p) => ({
          id: p.id,
          width: 8,
          height: 8,
          layoutOptions: {
            "elk.port.side": p.side,
            "elk.port.index": String(index.get(p.id) ?? 0),
          },
          labels: [{ text: p.label, width: p.labelW + 16, height: 16 }],
        })),
      },
    ],
  };
  return elk.layout(graph);
}

// ---------------------------------------------------------------- drawing

/**
 * The view header: breadcrumb clickable on the instance segments of the path
 * (the ascent from docs/05), the module with the effective parameters and the
 * Symbol/Schematic switch (only when the instance has a schematic).
 */
function renderHeader(inst: Instance): void {
  head.replaceChildren();
  const crumbs = h("span", "crumbs");
  const segs = inst.path.split(".");
  let prefix = "";
  segs.forEach((s, i) => {
    prefix = i ? `${prefix}.${s}` : s;
    if (i) {
      crumbs.append(h("span", "sep", "."));
    }
    const target = prefix;
    if (target !== inst.path && findInstance(target)) {
      const a = h("span", "seg link", s);
      a.title = target;
      a.addEventListener("click", () =>
        navigateTo(
          target,
          hasSchematic(state.model, target) ? "schematic" : "symbol"
        )
      );
      crumbs.append(a);
    } else {
      // generate segment (g_ch[1]) or current instance: plain text
      crumbs.append(h("span", "seg", s));
    }
  });
  head.append(crumbs, h("span", "module", ` — ${inst.module}`));
  const params = Object.entries(inst.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  if (params) {
    head.append(h("span", "params", `  #(${params})`));
  }
  // no Symbol/Schematic switch (D24): the view is derived from the node
  // selected in the hierarchy — the „top module" root -> the top's symbol, the rest
  // of the modules -> internal schematic (leaves fall gracefully onto the symbol)
  const tgl = h("span", "mode-toggle");
  if (tbAvailable()) {
    // the third view (docs/05): the diagram of the verification environment of the
    // active config — a visible entry point, not just a command
    const tb = h("button", "mbtn", "Testbench");
    tb.title = "Open the verification view of the active QuickUVM config";
    tb.addEventListener("click", openTbView);
    tgl.append(tb);
  }
  const fitBtn = h("button", "mbtn", "⛶");
  fitBtn.title = "Fit to window (F)";
  fitBtn.addEventListener("click", fitView);
  tgl.append(fitBtn);
  if (state.mode === "schematic") {
    const rl = h("button", "mbtn", "⟲");
    rl.title = "Re-arrange all (discards node positions)";
    rl.addEventListener("click", relayoutAll);
    tgl.append(rl);
  }
  const ex = h("button", "mbtn", "⤓");
  ex.title = "Export view as SVG";
  ex.addEventListener("click", exportSvg);
  tgl.append(ex);
  head.append(tgl);
  updateGenChip(); // the generate status chip (docs/05)
}

/** "Re-arrange all" (docs/04): the only path to a full re-layout — deletes
 *  the view's positions (folds/flips remain) and returns to full ELK */
function relayoutAll(): void {
  const key = layoutKey();
  if (!key || state.mode === "symbol") {
    return; // the symbol has no user-owned positions
  }
  pushPosUndo(capturePositions()); // an accidental ⟲ is undone with Ctrl+Z
  const nodes = sidecar.views[key]?.nodes ?? {};
  for (const n of Object.values(nodes)) {
    delete n.x;
    delete n.y;
  }
  sessionCameras.delete(key); // fresh fit onto the new layout
  post({ v: 1, type: "relayout/request", viewId: key, scope: "all" });
  void render(true);
}

// -------------------------------------------------------------- navigation

function navigateTo(path: string, mode?: ViewMode): void {
  state.viewId = path;
  if (mode) {
    state.mode = mode;
  }
  state.selection.clear();
  postSelection();
  persistState();
  // the host updates the title, the current view and the hierarchy (docs/05); the mode
  // distinguishes the top's symbol (root) from the schematic (the instance node)
  post({ v: 1, type: "nav/drill", instancePath: path, mode: state.mode });
  void render(true);
}

function toggleFold(foldId: string): void {
  const viewId = state.viewId ?? "";
  const s = expandedFor(viewId);
  const collapsed = s.delete(foldId); // was expanded -> folds back
  if (!collapsed) {
    s.add(foldId);
  }
  // local mirror + persistence in the sidecar (docs/04)
  const n = sidecarNode(viewId, foldId);
  if (collapsed) {
    delete n.collapsed;
  } else {
    n.collapsed = false;
  }
  post({ v: 1, type: "fold/toggled", viewId, foldId, collapsed });
  void render();
}

/** flipping a block (docs/04): H = the west<->east sides, V = the order
 *  of the pins on each side; persisted in the sidecar through node/flipped */
/** level 4 (docs/04): toggles a net between wire and label; a choice
 *  equal to the model's suggestion deletes the override (the host does the same) */
/** the net a selected pin/flag belongs to (from edges or label),
 *  so that the inspector's Net section is discoverable from any endpoint */
function netOfPin(id: string): string | null {
  if (!currentScene) {
    return null;
  }
  for (const e of currentScene.edges) {
    if (!e.net) {
      continue;
    }
    // child pin (sourcePort/targetPort) or boundary flag (source/target node)
    if (e.sourcePort === id || e.targetPort === id || e.source === id || e.target === id) {
      return e.net;
    }
  }
  // labeled net (without an edge): from bport.nets / pin.nets or the port name
  if (id.startsWith("<port>.")) {
    const b = currentScene.boundary.find((bb) => bb.id === id);
    return b?.nets[0] ?? id.slice("<port>.".length);
  }
  for (const n of currentScene.nodes) {
    const p = n.pins.find((pp) => pp.id === id);
    if (p?.nets.length) {
      return p.nets[0];
    }
  }
  return null;
}

function toggleNetRender(net: string): void {
  const viewId = state.viewId;
  if (!viewId || !state.model) {
    return;
  }
  const suggestion =
    state.model.views[viewId]?.nets.find((n) => n.name === net)?.render ??
    "wire";
  const view = (sidecar.views[viewId] ??= {});
  const current = view.nets?.[net]?.render ?? suggestion;
  const next = current === "wire" ? "label" : "wire";
  if (next === suggestion) {
    if (view.nets) {
      delete view.nets[net];
    }
  } else {
    (view.nets ??= {})[net] = { render: next };
  }
  post({ v: 1, type: "net/render", viewId, net, render: next });
  void render();
}

function toggleFlip(nodeId: string, axis: "h" | "v"): void {
  const key = layoutKey(); // viewId in RTL, tb:<config>|<focus> in TB
  if (!key || state.mode === "symbol") {
    return;
  }
  const n = sidecarNode(key, nodeId);
  if (axis === "h") {
    if (n.flipH) {
      delete n.flipH;
    } else {
      n.flipH = true;
    }
  } else if (n.flipV) {
    delete n.flipV;
  } else {
    n.flipV = true;
  }
  post({
    v: 1,
    type: "node/flipped",
    viewId: key,
    nodeId,
    flipH: Boolean(n.flipH),
    flipV: Boolean(n.flipV),
  });
  void render();
}

/** the decoration of a pin, derived from the overlay (agent, role, ignored) */
interface PinDeco {
  color: number | undefined;
  role: string | undefined;
}

/** shape marker per agent: the color is doubled by the shape (accessibility) */
function agentMarker(color: number, x: number, y: number): SVGElement {
  const hollow = color >= 4;
  const attrs: Record<string, string> = {
    class: "marker",
    ...(hollow ? { fill: "none", "stroke-width": "1.6" } : { stroke: "none" }),
  };
  switch (color % 4) {
    case 0:
      return el("circle", { ...attrs, cx: String(x), cy: String(y), r: "3.6" });
    case 1:
      return el("rect", {
        ...attrs,
        x: String(x - 3.2), y: String(y - 3.2), width: "6.4", height: "6.4",
      });
    case 2: // diamond
      return el("path", {
        ...attrs,
        d: `M ${x} ${y - 4.2} L ${x + 4.2} ${y} L ${x} ${y + 4.2} L ${x - 4.2} ${y} Z`,
      });
    default: // triangle
      return el("path", {
        ...attrs,
        d: `M ${x} ${y - 4} L ${x + 4} ${y + 3.4} L ${x - 4} ${y + 3.4} Z`,
      });
  }
}

function drawPin(
  spec: PinSpec,
  nodeW: number,
  py: number,
  deco?: PinDeco
): SVGGElement {
  const west = spec.side === "WEST";
  const x0 = west ? 0 : nodeW; // the edge of the rectangle
  const xOut = west ? -STUB : nodeW + STUB; // the free end of the pin
  const mx = (x0 + xOut) / 2;

  const g = el("g", { class: `pin${spec.iface ? " iface" : ""}` });
  g.dataset.id = spec.id;
  g.dataset.port = spec.name;
  if (deco?.role) {
    g.classList.add(`role-${deco.role}`);
  }
  if (deco?.color !== undefined) {
    g.classList.add(`agent-c${deco.color}`);
  }

  if (spec.iface) {
    // thick pin: color + hatching (accessibility, docs/05)
    g.append(
      el("line", {
        class: "stub",
        x1: String(xOut), y1: String(py), x2: String(x0), y2: String(py),
      }),
      el("rect", {
        class: "hatch",
        x: String(Math.min(x0, xOut)), y: String(py - 3),
        width: String(STUB), height: "6",
      })
    );
  } else {
    g.append(
      el("line", {
        class: "stub",
        x1: String(xOut), y1: String(py), x2: String(x0), y2: String(py),
      })
    );
    if (spec.bus) {
      // the bus slash line, at the middle of the pin
      g.append(
        el("line", {
          class: "bus-slash",
          x1: String(mx - 3), y1: String(py + 4),
          x2: String(mx + 3), y2: String(py - 4),
        })
      );
    }
  }
  if (spec.mult) {
    // the multiplicity of the unpacked array; anchored on the side (not centered),
    // so it does not cut across the symbol boundary on the short stub (as in the schematic)
    g.append(
      el(
        "text",
        {
          class: "mult",
          x: String(mx),
          y: String(py - 6),
          "text-anchor": west ? "end" : "start",
        },
        spec.mult
      )
    );
  }
  if (deco?.color !== undefined) {
    // the agent marker, beyond the free end of the pin
    g.append(agentMarker(deco.color, west ? xOut - 7 : xOut + 7, py));
  }
  const roleNote =
    deco?.role === "clock"
      ? "\nrole: clock (excluded from agents)"
      : deco?.role === "reset"
        ? "\nrole: reset (excluded from agents)"
        : deco?.role === "ignored"
          ? "\ndeliberately unverified (dut.unverified_ports)"
          : "";
  g.append(
    portLabelText(
      {
        class: "pin-label",
        x: String(west ? 8 : nodeW - 8),
        y: String(py + 4),
        "text-anchor": west ? "start" : "end",
      },
      spec.label,
      spec.name
    ),
    el("title", {}, spec.tooltip + roleNote)
  );
  return g;
}

/**
 * Empties the canvas and repopulates it with the common defs (hatching for
 * interfaces, arrow for edges) and with the pan/zoom viewport group.
 */
function resetCanvas(): SVGGElement {
  canvas.replaceChildren();
  const defs = el("defs", {});
  const hatch = el("pattern", {
    id: "hatch",
    width: "5",
    height: "5",
    patternTransform: "rotate(45)",
    patternUnits: "userSpaceOnUse",
  });
  hatch.append(el("line", { x1: "0", y1: "0", x2: "0", y2: "5" }));
  const arrow = el("marker", {
    id: "arrow",
    viewBox: "0 0 8 8",
    refX: "7",
    refY: "4",
    markerWidth: "8",
    markerHeight: "8",
    // FIXED size (not scaled with the wire thickness): otherwise the thick
    // interface wire makes a huge arrow, and on hover (thinner wire)
    // the arrow shrinks
    markerUnits: "userSpaceOnUse",
    orient: "auto-start-reverse",
  });
  arrow.append(el("path", { d: "M 0 0 L 8 4 L 0 8 z" }));
  defs.append(hatch, arrow);
  canvas.append(defs);
  viewport = el("g", { id: "viewport" });
  canvas.append(viewport);
  return viewport;
}

/** the height of the gap between the pin sections in the symbol view (docs/04) */
const SECTION_GAP = 18;

function draw(inst: Instance, pins: PinSpec[], layout: ElkNode): void {
  const ctx = layout.children?.[0];
  if (!ctx) {
    return;
  }
  const nodeW = ctx.width ?? 200;
  let nodeH = ctx.height ?? 100;
  const byId = new Map(pins.map((p) => [p.id, p]));

  // pin sections by role (docs/04): clock/reset are already grouped bottom-left
  // (buildPins). We make the grouping VISIBLE — gap + divider + titles — by moving
  // the clock/reset group down (ELK FIXED_ORDER does not leave a gap per-group) and
  // enlarging the box. Only in the symbol view and only when both sections exist
  const westPorts = (ctx.ports ?? [])
    .filter((p) => byId.get(p.id)?.side === "WEST")
    .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
  let dividerY = -1;
  for (let i = 1; i < westPorts.length; i++) {
    const prev = byId.get(westPorts[i - 1].id)?.section;
    const cur = byId.get(westPorts[i].id)?.section;
    if (prev === "signals" && cur === "clock/reset") {
      dividerY = (westPorts[i - 1].y ?? 0) + 4 + SECTION_GAP / 2;
      for (let j = i; j < westPorts.length; j++) {
        westPorts[j].y = (westPorts[j].y ?? 0) + SECTION_GAP;
      }
      nodeH += SECTION_GAP;
      break;
    }
  }

  const vp = resetCanvas();
  const node = el("g", { class: "node" });
  node.dataset.id = inst.path;
  node.append(
    el("rect", {
      class: "module-box",
      x: "0", y: "0", rx: "3",
      width: String(nodeW), height: String(nodeH),
    }),
    el(
      "text",
      { class: "module-name", x: String(nodeW / 2), y: "19" },
      inst.module
    ),
    el(
      "title",
      {},
      `${inst.module} — ${inst.path}\n` +
        (hasSchematic(state.model, inst.path)
          ? "double-click: schematic; Ctrl+double-click: source"
          : "double-click: module source")
    )
  );
  vp.append(node);

  // the divider + the titles of the pin sections (role, docs/04): only when
  // the clock/reset group was separated by a gap (dividerY >= 0)
  if (dividerY >= 0) {
    node.append(
      el("line", {
        class: "sym-divider",
        x1: "8", y1: String(dividerY), x2: String(nodeW - 8), y2: String(dividerY),
      }),
      el(
        "text",
        { class: "sym-section", x: "10", y: String(dividerY + 11) },
        "clock / reset"
      )
    );
    // the top section (signals) is implicit through contrast with the
    // clock/reset label below the divider — we do not label it separately (it would compete with
    // the module name when the first pin is at the top)
  }

  // the overlay is applied only when the configuration targets the displayed module
  const ov =
    state.overlay && state.overlay.dut === inst.module ? state.overlay : null;
  const pinAgent = new Map<string, number>();
  ov?.agents.forEach((a) => a.pins.forEach((p) => pinAgent.set(p, a.color)));

  for (const port of ctx.ports ?? []) {
    const spec = byId.get(port.id);
    if (!spec) {
      continue;
    }
    const py = (port.y ?? 0) + (port.height ?? 0) / 2;
    const deco: PinDeco | undefined = ov
      ? { color: pinAgent.get(spec.name), role: ov.roles[spec.name] }
      : undefined;
    node.append(drawPin(spec, nodeW, py, deco));
  }
  applySelectionClasses();
  applyStatusBadges();
  applyGenBadges();
  refreshMinimap(); // the symbol has no minimap (it always fits) — removes it
}

// ------------------------------------------------------------ interaction

function applyTransform(): void {
  viewport?.setAttribute(
    "transform",
    `translate(${state.tx},${state.ty}) scale(${state.k})`
  );
  updateMinimap();
}

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** the content bounds at the last render (for fit) */
let contentBounds: Bounds = { x: 0, y: 0, w: 200, h: 100 };

/** the rectangle that encloses all the layout's nodes (after drags,
 *  the content can exceed the initial ELK rectangle, including toward negatives) */
function layoutBounds(layout: ElkNode): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of layout.children ?? []) {
    const x = c.x ?? 0;
    const y = c.y ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (c.width ?? 0));
    maxY = Math.max(maxY, y + (c.height ?? 0));
  }
  if (minX === Infinity) {
    return { x: 0, y: 0, w: layout.width ?? 200, h: layout.height ?? 100 };
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** the last known dimension of the canvas (for keeping the center) */
let lastVW = 0;
let lastVH = 0;

/** the current camera is an automatic fit (recomputed on resize),
 *  not a user one (pan/zoom/persisted camera) */
let autoCam = true;

function fit(b: Bounds): void {
  const vw = canvas.clientWidth || 800;
  const vh = canvas.clientHeight || 600;
  const margin = 2 * STUB + 40;
  state.k = Math.min(vw / (b.w + margin), vh / (b.h + margin), 1.5);
  state.tx = (vw - b.w * state.k) / 2 - b.x * state.k;
  state.ty = (vh - b.h * state.k) / 2 - b.y * state.k;
  lastVW = vw;
  lastVH = vh;
  autoCam = true;
  applyTransform();
}

/** fits the diagram into the window (the F key / the button in the header);
 *  the resulting camera is persisted as with any pan/zoom */
function fitView(): void {
  if (state.mode === "schematic" && currentLayout) {
    contentBounds = layoutBounds(currentLayout); // the drags moved the world
  } else if (state.mode === "tb" && currentTbLayout) {
    contentBounds = tbBounds(currentTbLayout); // same: the positions from drag/seeds
  }
  fit(contentBounds);
  scheduleCameraSave();
}

function postSelection(): void {
  post({ v: 1, type: "select/changed", ids: [...state.selection] });
}

// ------------------------------------------------------------------ minimap

// The overview navigator (docs/04): a thumbnail of the scene in a corner + the rectangle
// of the visible area; click/drag on it moves the camera. The thumbnail is a LIVE COPY through
// <use href="#viewport"> — zero re-rendering, any change (drag, selection,
// guides) appears instantly; the transform U = M ∘ V⁻¹ (minimap.ts, pure, tested in
// test:minimap) cancels the copied camera and brings the world to the minimap's scale.
// Only in the schematic views (RTL + TB) — the symbol always fits. Session state
// (like the camera), the M key toggles it.
const MM_W = 180;
const MM_H = 120;
const MM_PAD = 8;
const MM_MARGIN = 12;
let minimapOn = true;
let mmLayout: MmLayout | null = null;
/** the position of the minimap's corner in the canvas (for client->local at the pointer) */
let mmPos = { x: 0, y: 0 };
let mmDragging = false;

/** camera jump/pan from the pointer position on the minimap */
function mmJump(e: PointerEvent): void {
  if (!mmLayout) {
    return;
  }
  const cb = canvas.getBoundingClientRect();
  const cam = cameraForMinimapPoint(
    mmLayout,
    e.clientX - cb.left - mmPos.x,
    e.clientY - cb.top - mmPos.y,
    state.k,
    canvas.clientWidth || 800,
    canvas.clientHeight || 600
  );
  state.tx = cam.tx;
  state.ty = cam.ty;
  autoCam = false; // the camera is now the user's
  applyTransform();
  scheduleCameraSave();
}

/** CHEAP per-frame update (called from applyTransform): the transform
 *  of the <use> copy + the view rectangle; the geometry from minimap.ts (pure) */
function updateMinimap(): void {
  if (!mmLayout) {
    return;
  }
  const g = canvas.querySelector<SVGGElement>("#minimap");
  if (!g) {
    return;
  }
  const vw = canvas.clientWidth || 800;
  const vh = canvas.clientHeight || 600;
  // the auto-correction of the anchoring: refreshMinimap can run with the canvas still
  // hidden (the welcome screen, clientWidth=0 -> fallback); since the camera is
  // applied after the canvas becomes visible, the first pass through here sees
  // the real dimension and moves the minimap into the correct corner
  const px = vw - MM_W - MM_MARGIN;
  const py = vh - MM_H - MM_MARGIN;
  if (px !== mmPos.x || py !== mmPos.y) {
    mmPos = { x: px, y: py };
    g.setAttribute("transform", `translate(${px},${py})`);
  }
  g.querySelector<SVGGElement>(".mm-scale")?.setAttribute(
    "transform",
    minimapUseTransform(mmLayout, state)
  );
  const vr = minimapViewRect(mmLayout, state, vw, vh);
  const r = g.querySelector<SVGRectElement>(".mm-view");
  if (r) {
    r.setAttribute("x", String(vr.x));
    r.setAttribute("y", String(vr.y));
    r.setAttribute("width", String(Math.max(vr.w, 0)));
    r.setAttribute("height", String(Math.max(vr.h, 0)));
  }
}

/** (re)builds the minimap: after each render (resetCanvas empties
 *  the canvas), at drag-end/undo (the world bounds moved), at resize
 *  (repositioning in the corner) and at toggle (the M key). Outside the schematic views
 *  or without content, removes it. */
function refreshMinimap(): void {
  const old = canvas.querySelector<SVGGElement>("#minimap");
  const b = !minimapOn || !viewport
    ? null
    : state.mode === "tb"
      ? currentTbLayout && tbBounds(currentTbLayout)
      : state.mode === "schematic"
        ? currentLayout && layoutBounds(currentLayout)
        : null;
  if (!b || b.w <= 0 || b.h <= 0) {
    mmLayout = null;
    mmDragging = false; // the element that owned the gesture disappears
    old?.remove();
    return;
  }
  mmLayout = minimapLayout(b, MM_W, MM_H, MM_PAD);
  mmPos = {
    x: (canvas.clientWidth || 800) - MM_W - MM_MARGIN,
    y: (canvas.clientHeight || 600) - MM_H - MM_MARGIN,
  };
  let g = old;
  if (!g) {
    // reconstruction from scratch (resetCanvas deleted the minimap): the old hit
    // rect — the only one that reset the flag on pointerup — no longer exists, so
    // a minimap drag interrupted by re-rendering is cancelled here (the
    // adversarial review of the minimap: otherwise the buttonless hover pans the camera)
    mmDragging = false;
    g = el("g", { id: "minimap" });
    const clip = el("clipPath", { id: "mm-clip" });
    clip.append(
      el("rect", {
        x: "0", y: "0", width: String(MM_W), height: String(MM_H), rx: "4",
      })
    );
    const content = el("g", {
      class: "mm-content",
      "clip-path": "url(#mm-clip)",
    });
    const scale = el("g", { class: "mm-scale" });
    scale.append(el("use", { href: "#viewport" }));
    content.append(scale, el("rect", { class: "mm-view" }));
    const hit = el("rect", {
      class: "mm-hit",
      x: "0", y: "0", width: String(MM_W), height: String(MM_H),
    });
    // the gestures on the minimap do NOT reach the canvas (otherwise pointerdown would start
    // the lasso, and the click after it would clear the selection)
    hit.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      mmDragging = true;
      mmJump(e); // the jump first — the capture can throw (expired pointer)
      try {
        hit.setPointerCapture(e.pointerId);
      } catch {
        // without capture, the pan works as long as the pointer stays on the minimap
      }
    });
    hit.addEventListener("pointermove", (e) => {
      if (mmDragging) {
        e.stopPropagation();
        mmJump(e);
      }
    });
    hit.addEventListener("pointerup", (e) => {
      // stopPropagation ONLY when the gesture is the minimap's: a sub-threshold
      // canvas gesture (lasso/drag < DRAG_MIN, still without capture) released over
      // the minimap must reach the canvas cleanup, otherwise a ghost
      // marquee/drag remains (the adversarial review of the minimap)
      if (mmDragging) {
        mmDragging = false;
        e.stopPropagation();
      }
    });
    // the cancellation paths reset the flag only on their own pointerup: without
    // these, a pointercancel (touch/pen) or the loss of capture left
    // mmDragging stuck true -> buttonless hover pans the camera (the
    // adversarial review of the minimap)
    hit.addEventListener("pointercancel", () => {
      mmDragging = false;
    });
    hit.addEventListener("lostpointercapture", () => {
      mmDragging = false;
    });
    hit.addEventListener("click", (e) => e.stopPropagation());
    hit.addEventListener("dblclick", (e) => e.stopPropagation());
    hit.append(el("title", {}, "Overview — click or drag to move the view (M toggles)"));
    g.append(
      clip,
      el("rect", {
        class: "mm-bg",
        x: "0", y: "0", width: String(MM_W), height: String(MM_H), rx: "4",
      }),
      content,
      hit
    );
  }
  // (re)attach at the end: the render re-creates the viewport under it, and the minimap
  // must stay ABOVE the content
  canvas.append(g);
  g.setAttribute("transform", `translate(${mmPos.x},${mmPos.y})`);
  updateMinimap();
}

// --------------------------------------------------------------- export SVG

/** the properties inlined at export: the webview's CSS is external and
 *  themed through var(--vscode-*) — it does not travel with the file */
const EXPORT_PROPS = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray",
  "stroke-linecap", "stroke-linejoin", "stroke-opacity", "opacity",
  "font-family", "font-size", "font-weight", "font-style",
  "text-anchor", "dominant-baseline", "letter-spacing", "visibility",
  // pure-CSS markings of the texts: the TB titles (uppercase) and the ignored
  // ports (line-through) — if omitted, the export differs visibly from the screen
  "text-transform", "text-decoration",
] as const;

/**
 * Serializes the current view as a STANDALONE SVG and sends it to the host
 * (export/result, docs/05): the COMPUTED styles are inlined (the current
 * theme's colors are baked into the file), the session camera is replaced with a
 * viewBox on the content, and the theme's background is baked into a rect (a
 * transparent export is illegible on a white/black background). The styles are read on the CLONE
 * attached off-screen, NOT on the original: the clone has no `.selected` (stripped) and
 * is not under the pointer, so `:hover`/`:selected` are not baked into the export.
 */
function exportSvg(): void {
  // the welcome screen stays VISIBLE over a viewport possibly populated
  // by a previous view (render() does not empty it) — the gate is taken by
  // the overlay, not just by the DOM (a real regression caught in manual
  // validation: exporting from welcome opened the save dialog). Under a BANNER,
  // the export stays allowed: underneath is the last valid drawing (invariant 5)
  if (!viewport || !viewport.hasChildNodes() || !empty.hidden) {
    post({ v: 1, type: "export/result", viewId: state.viewId ?? "", svg: "" });
    return;
  }
  const MARGIN = 16;
  // the content's bbox in world space (getBBox ignores the viewport's
  // own transform = exactly the camera we are discarding)
  const bb = viewport.getBBox();
  const clone = canvas.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll(".selected").forEach((n) =>
    n.classList.remove("selected")
  );
  // the cross-probing halo is session state, not content: without it, the yellow
  // would be baked permanently into the file (the adversarial review of the synchronization)
  clone.querySelectorAll(".xprobe").forEach((n) =>
    n.classList.remove("xprobe")
  );
  // the status badges are a session diagnostic, not content (docs/05)
  clone.querySelectorAll(".status-badge").forEach((n) => n.remove());
  clone.removeAttribute("id"); // no `#canvas` rules + no duplicate id
  // attach off-screen: the styles resolve from the stylesheet WITHOUT :hover
  // (the pointer is on the real UI, not on the clone) and without :selected (stripped)
  clone.style.position = "absolute";
  clone.style.left = "-100000px";
  clone.style.top = "0";
  document.body.append(clone);
  // the colors from color-mix are computed as `color(srgb r g b / a)` — CSS
  // Color 4 syntax, which external SVG tools (Inkscape, PDF converters) may
  // not parse; they are normalized to classic rgba()
  const legacyColor = (v: string): string =>
    v.replace(
      /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/g,
      (_m, r, g, b, a) => {
        const c = (x: string): number => Math.round(Number(x) * 255);
        return a === undefined
          ? `rgb(${c(r)}, ${c(g)}, ${c(b)})`
          : `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${a})`;
      }
    );
  const nodes = clone.querySelectorAll<SVGElement>("*");
  const styles: string[] = [];
  for (const n of nodes) {
    const cs = getComputedStyle(n); // read (no mutations between reads)
    let style = "";
    for (const p of EXPORT_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v) {
        style += `${p}:${legacyColor(v)};`;
      }
    }
    styles.push(style);
  }
  nodes.forEach((n, i) => n.setAttribute("style", styles[i])); // write
  clone.remove();
  clone.removeAttribute("style"); // remove the off-screen positioning

  clone.querySelector<SVGGElement>("#viewport")?.removeAttribute("transform");
  // the minimap is UI chrome (navigator), not content — it does not go into the export
  clone.querySelector<SVGGElement>("#minimap")?.remove();
  clone.setAttribute("xmlns", SVG_NS);
  const w = Math.ceil(bb.width + 2 * MARGIN);
  const hh = Math.ceil(bb.height + 2 * MARGIN);
  clone.setAttribute("viewBox", `${bb.x - MARGIN} ${bb.y - MARGIN} ${w} ${hh}`);
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(hh));
  const bg = el("rect", {
    x: String(bb.x - MARGIN),
    y: String(bb.y - MARGIN),
    width: String(w),
    height: String(hh),
    fill: getComputedStyle(document.body).backgroundColor,
  });
  clone.insertBefore(bg, clone.firstChild);
  const svg =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    new XMLSerializer().serializeToString(clone);
  post({ v: 1, type: "export/result", viewId: state.viewId ?? "", svg });
}

// --- the quick-uvm status decorations (docs/05): the model<->YAML validations as
// badges on elements + the result of the last generate as a chip in the header;
// the mapping onto the current view's ids is pure (statusIdsRtl/Tb, src/status.ts)
let statusDecos: StatusDeco[] = [];
// docs/07 line 1 — TB element ids with no generated code (`genMissing`) / behind the
// config (`genStale`); drawn as a star / dot badge on the diagram node
let genMissing = new Set<string>();
let genStale = new Set<string>();
let genStatus: GenerateStatus | null = null;

/** ⚠/✕ badge in the top-right corner of each targeted element, with the messages in
 *  the tooltip; idempotent (removes the old badges), run after each render
 *  and at status/decorations */
function applyStatusBadges(): void {
  canvas.querySelectorAll(".status-badge").forEach((b) => b.remove());
  if (!statusDecos.length) {
    return;
  }
  let map: Map<string, ElementStatus>;
  if (state.mode === "tb") {
    map = statusIdsTb(
      statusDecos,
      new Set((currentTbScene?.nodes ?? []).map((n) => n.id))
    );
  } else {
    const byPath = instModuleByPath();
    map = statusIdsRtl(statusDecos, {
      viewModule:
        state.mode === "schematic"
          ? currentScene?.module ?? null
          : byPath.get(state.viewId ?? "") ?? null,
      dut: state.overlay?.dut ?? null,
      nodes:
        state.mode === "schematic"
          ? (currentScene?.nodes ?? []).map((n) => ({
              id: n.id,
              module: byPath.get(n.instPath ?? n.memberPaths?.[0] ?? "") ?? "",
            }))
          : [],
    });
  }
  canvas.querySelectorAll<SVGGraphicsElement>("[data-id]").forEach((g) => {
    const st = map.get(g.dataset.id ?? "");
    if (!st) {
      return;
    }
    let bb: DOMRect;
    try {
      bb = g.getBBox();
    } catch {
      return; // element still unattached/invisible
    }
    const cx = bb.x + bb.width;
    const cy = bb.y;
    const badge = el("g", { class: `status-badge sev-${st.severity}` });
    badge.append(
      el("circle", { cx: String(cx), cy: String(cy), r: "7" }),
      el(
        "text",
        { x: String(cx), y: String(cy + 3.5), "text-anchor": "middle" },
        st.severity === "error" ? "✕" : "!"
      ),
      el("title", {}, st.messages.join("\n"))
    );
    g.append(badge);
  });
}

/** docs/07 line 1 — the generation-state badge on a TB node: a star for an element
 *  with no generated code (`genMissing`), a dot for one behind the config
 *  (`genStale`). Top-LEFT corner, so it never collides with the status badge
 *  (top-right). TB mode only; idempotent; run with applyStatusBadges. */
function applyGenBadges(): void {
  canvas.querySelectorAll(".gen-badge").forEach((b) => b.remove());
  if (state.mode !== "tb" || (!genMissing.size && !genStale.size)) {
    return;
  }
  canvas.querySelectorAll<SVGGraphicsElement>("[data-id]").forEach((g) => {
    const id = g.dataset.id ?? "";
    const missing = genMissing.has(id);
    if (!missing && !genStale.has(id)) {
      return;
    }
    let bb: DOMRect;
    try {
      bb = g.getBBox();
    } catch {
      return;
    }
    const badge = el("g", { class: `gen-badge ${missing ? "gen-missing" : "gen-stale"}` });
    badge.append(
      el("circle", { cx: String(bb.x), cy: String(bb.y), r: "7" }),
      el(
        "text",
        { x: String(bb.x), y: String(bb.y + 3.5), "text-anchor": "middle" },
        missing ? "★" : "●"
      ),
      el(
        "title",
        {},
        missing
          ? "Not generated — run Generate Testbench"
          : "Stale — the config changed since Generate Testbench"
      )
    );
    g.append(badge);
  });
}

/** the status chip of the last „Generate testbench" from the header (docs/05);
 *  idempotent, run by both headers and at status/decorations */
function updateGenChip(): void {
  head.querySelector(".gen-chip")?.remove();
  const tgl = head.querySelector(".mode-toggle");
  if (!tgl || !genStatus) {
    return;
  }
  const s = genStatus;
  const chip = h(
    "span",
    `gen-chip ${s.ok ? "gen-ok" : "gen-fail"}`,
    s.ok ? "✓ generate" : "✕ generate"
  );
  chip.title =
    (s.ok
      ? "quick-uvm generate succeeded"
      : `quick-uvm generate failed (exit ${s.code})` +
        (s.detail ? `\n${s.detail}` : "")) + `\n${s.at}`;
  tgl.prepend(chip);
}

// --- cross-probing editor->diagram (docs/05): the .xprobe halo, DISTINCT from
// selection — the targets come through probe/highlight, the mapping onto the
// current view's ids is pure (probeIds, src/locmap.ts)
let probeTargets: XprobeTarget[] = [];

/** path->module map, memoized on the model reference: probeCtx runs in
 *  applySelectionClasses (and at lasso, per pointermove) — reconstruction per
 *  call would be O(instances) on each mouse move with the halo active */
let instModuleCache: { model: ProjectModel | undefined; map: Map<string, string> } = {
  model: undefined,
  map: new Map(),
};
function instModuleByPath(): Map<string, string> {
  if (instModuleCache.model !== state.model) {
    instModuleCache = {
      model: state.model,
      map: new Map(
        (state.model?.instances ?? []).map((i) => [i.path, i.module])
      ),
    };
  }
  return instModuleCache.map;
}

/** the current view's context for probeIds; the module of the nodes is taken from
 *  the model (SceneNode does not carry it separately from the subtitle) */
function probeCtx(): ProbeViewCtx {
  const byPath = instModuleByPath();
  if (state.mode === "schematic" && currentScene) {
    return {
      mode: "schematic",
      viewId: state.viewId ?? "",
      viewModule: currentScene.module,
      nodes: currentScene.nodes.map((n) => ({
        id: n.id,
        instPath: n.instPath,
        module:
          byPath.get(n.instPath ?? n.memberPaths?.[0] ?? "") ?? "",
        memberPaths: n.memberPaths,
      })),
    };
  }
  return {
    mode: state.mode,
    viewId: state.viewId ?? "",
    viewModule: byPath.get(state.viewId ?? "") ?? null,
    nodes: [],
  };
}

function applySelectionClasses(): void {
  // the halo is recomputed here (no cached Set is kept): the function runs
  // after each render/navigation, so the mapping always follows the current scene
  const probe = new Set(
    probeTargets.length ? probeIds(probeTargets, probeCtx()) : []
  );
  canvas.querySelectorAll<SVGElement>("[data-id]").forEach((g) => {
    g.classList.toggle("selected", state.selection.has(g.dataset.id ?? ""));
    g.classList.toggle("xprobe", probe.has(g.dataset.id ?? ""));
  });
}

canvas.addEventListener("click", (e) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const target = (e.target as Element).closest<SVGElement>("[data-id]");
  if (!target) {
    // Shift+click on the background / element without data-id (e.g. iface edge): cone
    // gesture — we do NOT clear the existing selection (otherwise a miss would erase the cone)
    if (!e.shiftKey && state.selection.size) {
      state.selection.clear();
      applySelectionClasses();
      postSelection();
      renderInspector();
    }
    return;
  }
  const id = target.dataset.id ?? "";
  if (e.shiftKey && state.mode === "schematic" && currentScene) {
    // the connectivity cone (docs/04, phase 4): Shift+click = everything driven
    // by the element (downstream); Shift+Alt+click = everything that drives it (upstream).
    // coneOf classifies the id (node/flag, net name, or pin) — a click on the
    // interior of a pin starts from its nets, not from a nonexistent net
    const cone = coneOf(currentScene, id, e.altKey ? "up" : "down");
    if (cone) {
      state.selection = cone;
      applySelectionClasses();
      postSelection();
      renderInspector();
    }
    return; // Shift is always a cone gesture; an unrecognized id => the selection stays
  }
  if (e.ctrlKey || e.metaKey) {
    if (!state.selection.delete(id)) {
      state.selection.add(id);
    }
  } else {
    state.selection.clear();
    state.selection.add(id);
  }
  applySelectionClasses();
  postSelection();
  renderInspector();
});

// cross-probing on hover (phase 4, docs/05): after a short dwell on a
// pin in the RTL views, the host reveals the port declaration in the
// ALREADY visible editors (non-intrusive: it does not open tabs, does not steal focus; the
// quickuvm.hoverCrossProbe setting turns it off in the host). The full jump = double-click.
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let hoverKey = "";
canvas.addEventListener("pointerover", (e) => {
  if (state.mode === "tb" || e.buttons !== 0) {
    return; // the TB view has no SV sources; during the drag, nothing
  }
  const pin = (e.target as Element).closest<SVGElement>(".pin, .bport");
  const port = pin?.dataset.port;
  const owner = !pin
    ? undefined
    : state.mode === "schematic"
      ? pin.dataset.inst ?? (pin.dataset.bport ? state.viewId : undefined)
      : state.viewId;
  const key = port && owner ? `${owner}|${port}` : "";
  if (key === hoverKey) {
    return; // the same pin (pointerover on its children): keep the scheduling
  }
  clearTimeout(hoverTimer);
  hoverKey = key;
  if (!key) {
    return; // exited onto the background/another element: cancel the scheduled reveal
  }
  hoverTimer = setTimeout(() => {
    post({
      v: 1,
      type: "action/request",
      action: "openSource",
      args: { viewId: owner, port, peek: true },
    });
  }, 300);
});
canvas.addEventListener("pointerleave", () => {
  // exiting the canvas does NOT trigger pointerover (only leave): without cancellation,
  // a scheduled timer would fire after the pointer has left the diagram
  clearTimeout(hoverTimer);
  hoverKey = "";
});

// double-click, single rule by target (docs/05): on a pin — the port
// declaration; on a fold — expansion; on a block — "enter it": the schematic if it
// exists, at leaves the module source itself. Ctrl+double-click on a block =
// the module source, anywhere.
canvas.addEventListener("dblclick", (e) => {
  if (state.mode === "tb") {
    // drill on a block with structure (D24): descends to its level;
    // on a subenv (`config:`), opens the config of the composed block
    const box = (e.target as Element).closest<SVGElement>(".tbnode.drill");
    if (box?.dataset.drill) {
      tbOpen(box.dataset.drill);
    }
    return;
  }
  const t = e.target as Element;
  const openSrc = (args: Record<string, unknown>): void =>
    post({ v: 1, type: "action/request", action: "openSource", args });

  const pin = t.closest<SVGElement>(".pin, .bport");
  if (pin) {
    const port = pin.dataset.port;
    // symbol: the pins belong to the view's module; schematic: to the child
    // instance (data-inst) or to the view's module (boundary); the pins of the folds do not have
    // a single source — they are ignored
    const owner =
      state.mode === "schematic"
        ? pin.dataset.inst ?? (pin.dataset.bport ? state.viewId : undefined)
        : state.viewId;
    if (port && owner) {
      openSrc({ viewId: owner, port });
    }
    return;
  }

  let instPath: string | undefined;
  if (state.mode === "schematic") {
    const node = t.closest<SVGElement>(".inode");
    if (!node) {
      return;
    }
    if (!node.dataset.inst) {
      if (node.dataset.id) {
        toggleFold(node.dataset.id); // fold: double-click = expansion
      }
      return;
    }
    instPath = node.dataset.inst;
  } else {
    if (!t.closest(".node")) {
      return;
    }
    instPath = state.viewId; // the context symbol is the current instance's block
  }
  if (!instPath) {
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    openSrc({ viewId: instPath });
  } else if (hasSchematic(state.model, instPath)) {
    navigateTo(instPath, "schematic");
  } else {
    openSrc({ viewId: instPath }); // leaf: the "schematic" is the code itself
  }
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0012);
    const k2 = Math.min(5, Math.max(0.2, state.k * factor));
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    state.tx = cx - ((cx - state.tx) * k2) / state.k;
    state.ty = cy - ((cy - state.ty) * k2) / state.k;
    state.k = k2;
    autoCam = false; // the camera is now the user's
    applyTransform();
    scheduleCameraSave();
  },
  { passive: false }
);

// ---------------------------------------------------------- drag and pan

const GRID = 8; // grid snap on drag (docs/04)
const DRAG_MIN = 5; // screen px below which the gesture stays a click

interface DragItem {
  nodeId: string;
  el: SVGGElement;
  /** the mutable holder of position + dimensions: ElkNode (RTL: width/height) or
   *  TbPlaced/TbBPlaced (TB: w/h) — both have mutable x/y */
  child: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    w?: number;
    h?: number;
  };
  origX: number; // the node, in the diagram coordinates
  origY: number;
}

interface DragState {
  items: DragItem[];
  /** the GRABBED node (under the cursor): it aligns; the group moves with it */
  primary: string;
  startX: number; // pointer, screen px
  startY: number;
  moved: boolean;
  /** the positions of the ENTIRE view at press — the undo entry of the move */
  before: PosMap | null;
}
/** the alignment threshold on drag, in SCREEN px (diagram: divided by zoom) */
const ALIGN_THRESH = 6;
let alignGuideEls: SVGElement[] = [];
let drag: DragState | undefined;
/** a finished drag must not also trigger the selection click */
let suppressClick = false;

// lasso: a selection rectangle started with a left-click on the background (docs/04);
// on the symbol it selects pins (the gesture for "Agent from selection"), on the
// schematic it selects blocks and flags; Ctrl = add to the selection
interface Marquee {
  x0: number; // pointer, screen px
  y0: number;
  /** the base of the selection: the existing one with Ctrl, empty otherwise */
  base: Set<string>;
  /** the SVG rectangle, created only after the DRAG_MIN threshold */
  rect: SVGRectElement | null;
  /** the targets with their rectangles on the screen, cached at the start */
  candidates: { id: string; r: DOMRect }[] | null;
}
let marquee: Marquee | undefined;

function marqueeCandidates(): { id: string; r: DOMRect }[] {
  const sel =
    state.mode === "schematic"
      ? ".inode[data-id], .bport[data-id]"
      : state.mode === "tb"
        ? ".tbnode[data-id], .tb-bport[data-id]"
        : ".pin[data-id]";
  return [...canvas.querySelectorAll<SVGGElement>(sel)].map((g) => ({
    id: g.dataset.id ?? "",
    r: g.getBoundingClientRect(),
  }));
}

// --- polymorphic drag: the same mechanics for the RTL schematic and the
// verification (TB) view, only the layout structure and the re-routing differ (docs/04)

/** is the current view editable by drag (the positions belong to the user)? */
function draggable(): boolean {
  return state.mode === "schematic" || state.mode === "tb";
}
/** the selector of the movable elements from the DOM, by mode */
function dragSelector(): string {
  return state.mode === "tb"
    ? ".tbnode[data-id], .tb-bport[data-id]"
    : ".inode[data-id], .bport[data-id]";
}
/** the mutable position holder of a node: ElkNode (RTL) or TbPlaced/
 *  TbBPlaced (TB) — both have mutable x/y */
function dragChild(id: string): DragItem["child"] | undefined {
  if (state.mode === "tb") {
    return currentTbLayout?.nodes.get(id) ?? currentTbLayout?.boundary.get(id);
  }
  return currentLayout?.children?.find((c) => c.id === id);
}
/** the alignment points of a node placed at (x,y): the ENDS of its pins
 *  (the tips of the stubs, `tips` from pinTipOffsets — the user's request:
 *  the guides pass through the pin ends, not through the block edges) or, if
 *  it has no pins, its center (boundary flag). RTL: the boundary flag is also an
 *  ELK node (in children); TB: TbPlaced (ports) / TbBPlaced */
function nodeAlignPts(
  id: string,
  x: number,
  y: number,
  tips: Map<string, AlignPt[]> | null
): AlignPt[] {
  if (state.mode === "tb") {
    const p = currentTbLayout?.nodes.get(id);
    if (p) {
      return [...p.ports.values()].map((pt) => ({ x: x + pt.x, y: y + pt.y }));
    }
    const b = currentTbLayout?.boundary.get(id);
    return b ? [{ x: x + b.w / 2, y: y + 8 }] : []; // BPORT_H/2
  }
  const offs = tips?.get(id);
  if (offs?.length) {
    return offs.map((o) => ({ x: x + o.x, y: y + o.y }));
  }
  const c = currentLayout?.children?.find((ch) => ch.id === id);
  return c ? [{ x: x + (c.width ?? 0) / 2, y: y + (c.height ?? 0) / 2 }] : [];
}
/** all the alignment points (pin ends + flag anchors) of the current
 *  view, EXCLUDING `exclude` — the targets for the alignment guides.
 *  Aligning to the PIN ENDS (not to the block edges) keeps the wires straight
 *  and passes the guide through the tips (docs/04) */
function nodePortPoints(
  exclude: Set<string>,
  tips: Map<string, AlignPt[]> | null
): AlignPt[] {
  const out: AlignPt[] = [];
  if (state.mode === "tb") {
    for (const [id, p] of currentTbLayout?.nodes ?? []) {
      if (!exclude.has(id)) out.push(...nodeAlignPts(id, p.x, p.y, tips));
    }
    for (const [id, p] of currentTbLayout?.boundary ?? []) {
      if (!exclude.has(id)) out.push(...nodeAlignPts(id, p.x, p.y, tips));
    }
    return out;
  }
  for (const c of currentLayout?.children ?? []) {
    const id = c.id ?? "";
    if (!exclude.has(id)) out.push(...nodeAlignPts(id, c.x ?? 0, c.y ?? 0, tips));
  }
  return out;
}
/** draws the alignment guides in the viewport (diagram space); clears them
 *  first. The lines are `non-scaling-stroke` (1px at any zoom) */
function renderAlignGuides(a: AlignSnap): void {
  clearAlignGuides();
  if (!viewport) {
    return;
  }
  if (a.vLine) {
    const l = el("line", {
      class: "align-guide",
      x1: String(a.vLine.x), y1: String(a.vLine.y0),
      x2: String(a.vLine.x), y2: String(a.vLine.y1),
    });
    viewport.append(l);
    alignGuideEls.push(l);
  }
  if (a.hLine) {
    const l = el("line", {
      class: "align-guide",
      x1: String(a.hLine.x0), y1: String(a.hLine.y),
      x2: String(a.hLine.x1), y2: String(a.hLine.y),
    });
    viewport.append(l);
    alignGuideEls.push(l);
  }
}
function clearAlignGuides(): void {
  for (const g of alignGuideEls) {
    g.remove();
  }
  alignGuideEls = [];
}
/** re-routes the edges to the current positions (live drag) */
function dragReroute(): void {
  if (state.mode === "tb") {
    if (currentTbScene && currentTbLayout && currentTbEdgesGroup) {
      drawTbEdges(currentTbScene, currentTbLayout, currentTbEdgesGroup);
    }
  } else if (currentScene && currentLayout && currentEdgesGroup) {
    routeEdges(currentScene, currentLayout, currentEdgesGroup);
  }
}
/** iterates all the positions of the current view (for the total snapshot D21) */
function dragEachPos(cb: (id: string, x: number, y: number) => void): void {
  if (state.mode === "tb") {
    if (currentTbLayout) {
      for (const [id, p] of currentTbLayout.nodes) {
        cb(id, p.x, p.y);
      }
      for (const [id, p] of currentTbLayout.boundary) {
        cb(id, p.x, p.y);
      }
    }
    return;
  }
  for (const c of currentLayout?.children ?? []) {
    cb(c.id ?? "", c.x ?? 0, c.y ?? 0);
  }
}

// -------------------------------------------- undo/redo of positions (docs/04)

/** the session's POSITIONS history, per layout key (RTL: viewId; TB:
 *  `tb:<config>|<focus>`): Ctrl+Z/Ctrl+Y undo/redo the block moves
 *  and the ⟲ re-arrangements. Only positions (not flip/fold) and only session —
 *  each applied step is persisted normally through `layout/snapshot`, like any
 *  position gesture (the sidecar remains the persisted source) */
type PosMap = Record<string, { x: number; y: number }>;
const posHistory = new Map<string, { undo: PosMap[]; redo: PosMap[] }>();
const POS_HISTORY_MAX = 50;

/** the current positions of the view (all, D21), or null without a layout */
function capturePositions(): PosMap | null {
  const nodes: PosMap = {};
  let count = 0;
  dragEachPos((id, x, y) => {
    if (id) {
      nodes[id] = { x, y };
      count++;
    }
  });
  return count ? nodes : null;
}

/** pushes the state BEFORE a position gesture; a new gesture clears the redo */
function pushPosUndo(before: PosMap | null): void {
  const key = layoutKey();
  if (!key || !before) {
    return;
  }
  const h = posHistory.get(key) ?? { undo: [], redo: [] };
  h.undo.push(before);
  if (h.undo.length > POS_HISTORY_MAX) {
    h.undo.shift();
  }
  h.redo.length = 0;
  posHistory.set(key, h);
}

/** applies a snapshot: sidecar mirror + persistence + re-render (the total
 *  seeds force the positions exactly; the camera stays in place) */
function applyPositions(key: string, nodes: PosMap): void {
  for (const [id, p] of Object.entries(nodes)) {
    const n = sidecarNode(key, id);
    n.x = p.x;
    n.y = p.y;
  }
  post({ v: 1, type: "layout/snapshot", viewId: key, nodes });
  void render(false);
}

function undoPositions(redo: boolean): void {
  const key = layoutKey();
  const h = key ? posHistory.get(key) : undefined;
  if (!key || !h) {
    return;
  }
  const snap = (redo ? h.redo : h.undo).pop();
  if (!snap) {
    return;
  }
  const now = capturePositions();
  if (now) {
    (redo ? h.undo : h.redo).push(now);
  }
  applyPositions(key, snap);
}

let pan: { x: number; y: number } | undefined;
canvas.addEventListener("pointerdown", (e) => {
  // any press cancels a scheduled hover peek: otherwise it would fire in the
  // middle of a drag/click just started
  clearTimeout(hoverTimer);
  hoverKey = "";
  // drag of a node or of a boundary flag in the schematic, with the left button
  // (docs/04: the positions belong to the user); the fold button keeps its
  // click
  if (e.button === 0 && draggable()) {
    const t = e.target as Element;
    const nodeEl = t.closest<SVGElement>(
      state.mode === "tb" ? ".tbnode, .tb-bport" : ".inode, .bport"
    );
    if (nodeEl && !t.closest(".foldbtn")) {
      const pressedId = nodeEl.dataset.id ?? "";
      // the convention of diagram editors: dragging a member of the selection
      // moves the whole selection; dragging an element outside it moves only
      // the element, without touching the selection
      const ids =
        state.selection.has(pressedId) && state.selection.size > 1
          ? [...state.selection]
          : [pressedId];
      const byId = new Map<string, SVGGElement>();
      canvas
        .querySelectorAll<SVGGElement>(dragSelector())
        .forEach((g) => byId.set(g.dataset.id ?? "", g));
      const items: DragItem[] = [];
      for (const id of ids) {
        const el2 = byId.get(id);
        const child = dragChild(id);
        if (el2 && child) {
          // only nodes/flags; the nets or pins in the selection are ignored
          items.push({
            nodeId: id,
            el: el2,
            child,
            origX: child.x ?? 0,
            origY: child.y ?? 0,
          });
        }
      }
      if (items.length) {
        // only a drag candidate: the pointer is NOT captured yet — capture
        // re-targets the click to the canvas (Chrome) and would break the selection;
        // the capture is done only when the DRAG_MIN threshold is exceeded (pointermove)
        drag = {
          items,
          primary: pressedId,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
          before: capturePositions(), // the undo entry (push at drag-end)
        };
        return;
      }
    }
  }
  // left-click on the background: selection lasso; the pan is reserved for
  // the middle button
  const onElement = (e.target as Element).closest("[data-id]");
  if (e.button === 0 && !onElement) {
    marquee = {
      x0: e.clientX,
      y0: e.clientY,
      base: e.ctrlKey || e.metaKey ? new Set(state.selection) : new Set(),
      rect: null,
      candidates: null,
    };
    return;
  }
  if (e.button === 1) {
    e.preventDefault(); // without the default autoscroll of the middle button
    pan = { x: e.clientX - state.tx, y: e.clientY - state.ty };
    canvas.classList.add("panning");
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (drag) {
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_MIN) {
        return; // still a click gesture, not a drag
      }
      drag.moved = true;
      canvas.setPointerCapture(e.pointerId);
    }
    // alignment to the neighbors' PORTS (guides) OR grid snap, per axis:
    // the ports of the primary (grabbed) node align to a port of another block;
    // the group moves with the same displacement, so the relative offsets between
    // the selection members are kept exactly
    const primaryId = drag.primary;
    const prim = drag.items.find((it) => it.nodeId === primaryId) ?? drag.items[0];
    const rawX = prim.origX + dx / state.k;
    const rawY = prim.origY + dy / state.k;
    const draggedIds = new Set(drag.items.map((it) => it.nodeId));
    // the RTL pin ends (stub tips, with the markers) are the alignment
    // points — the guides pass through them, not through the block edges; TB has no
    // stubs, it uses the ports directly (tips=null)
    const tips =
      state.mode === "schematic" && currentScene && currentLayout
        ? pinTipOffsets(currentScene, currentLayout)
        : null;
    const a = alignSnap(
      nodeAlignPts(primaryId, rawX, rawY, tips),
      nodePortPoints(draggedIds, tips),
      ALIGN_THRESH / state.k
    );
    // alignment if it exists (can be off-grid), otherwise grid snap
    const finalX = a.vLine ? rawX + a.dx : Math.round(rawX / GRID) * GRID;
    const finalY = a.hLine ? rawY + a.dy : Math.round(rawY / GRID) * GRID;
    const gdx = finalX - prim.origX;
    const gdy = finalY - prim.origY;
    for (const it of drag.items) {
      const nx = it.origX + gdx;
      const ny = it.origY + gdy;
      it.child.x = nx;
      it.child.y = ny;
      it.el.setAttribute("transform", `translate(${nx},${ny})`);
    }
    // the routes follow the current positions (docs/04): live re-routing (RTL or TB)
    dragReroute();
    renderAlignGuides(a); // above the re-routed edges
    return;
  }
  if (marquee) {
    const dx = e.clientX - marquee.x0;
    const dy = e.clientY - marquee.y0;
    if (!marquee.rect) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_MIN) {
        return; // still a click gesture
      }
      marquee.rect = el("rect", { class: "marquee" });
      canvas.append(marquee.rect);
      marquee.candidates = marqueeCandidates();
      canvas.setPointerCapture(e.pointerId);
    }
    const cb = canvas.getBoundingClientRect();
    const x1 = Math.min(marquee.x0, e.clientX);
    const y1 = Math.min(marquee.y0, e.clientY);
    const x2 = Math.max(marquee.x0, e.clientX);
    const y2 = Math.max(marquee.y0, e.clientY);
    marquee.rect.setAttribute("x", String(x1 - cb.left));
    marquee.rect.setAttribute("y", String(y1 - cb.top));
    marquee.rect.setAttribute("width", String(x2 - x1));
    marquee.rect.setAttribute("height", String(y2 - y1));
    // the live selection: the base (Ctrl) plus the rectangle's targets — by default
    // only those completely enclosed ("window selection"); with
    // quickuvm.lassoMode=intersect, also those merely touched ("crossing")
    const hit = new Set(marquee.base);
    for (const c of marquee.candidates ?? []) {
      const inside =
        uiConfig.lasso === "intersect"
          ? c.r.left < x2 && c.r.right > x1 && c.r.top < y2 && c.r.bottom > y1
          : c.r.left >= x1 && c.r.right <= x2 && c.r.top >= y1 && c.r.bottom <= y2;
      if (inside) {
        hit.add(c.id);
      }
    }
    state.selection = hit;
    applySelectionClasses();
    return;
  }
  if (pan) {
    state.tx = e.clientX - pan.x;
    state.ty = e.clientY - pan.y;
    autoCam = false; // the camera is now the user's
    applyTransform();
  }
});
canvas.addEventListener("pointerup", (e) => {
  if (drag) {
    const key = layoutKey();
    if (drag.moved && key) {
      pushPosUndo(drag.before); // the move becomes undoable with Ctrl+Z
      // the first position gesture makes the arrangement of the user's ENTIRE
      // view (docs/04): all the current positions are persisted, not
      // just the dragged elements — with partial seeds, interactive ELK would
      // re-place the unpersisted elements (flags, untouched nodes) differently
      // than the layout the user sees now. The key is per level
      // in TB (`tb:<config>|<focus>`), viewId in RTL
      const nodes: Record<string, { x: number; y: number }> = {};
      dragEachPos((id, x, y) => {
        const n = sidecarNode(key, id);
        n.x = x;
        n.y = y;
        nodes[id] = { x, y };
      });
      post({ v: 1, type: "layout/snapshot", viewId: key, nodes });
      suppressClick = true;
    }
    clearAlignGuides();
    drag = undefined;
    canvas.releasePointerCapture(e.pointerId);
    refreshMinimap(); // the world bounds may have moved along with the block
    // and the bounds for fit are updated (as in fitView): otherwise a
    // resize with autoCam would fit onto the PRE-drag bounds, divergent from
    // the minimap (the adversarial review of the minimap)
    if (state.mode === "schematic" && currentLayout) {
      contentBounds = layoutBounds(currentLayout);
    } else if (state.mode === "tb" && currentTbLayout) {
      contentBounds = tbBounds(currentTbLayout);
    }
    return;
  }
  if (marquee) {
    if (marquee.rect) {
      marquee.rect.remove();
      canvas.releasePointerCapture(e.pointerId);
      postSelection();
      renderInspector();
      suppressClick = true; // the click after the lasso does not clear the selection
    }
    // without the threshold exceeded: a simple click — the click handler decides
    marquee = undefined;
    return;
  }
  if (pan) {
    scheduleCameraSave();
  }
  pan = undefined;
  canvas.classList.remove("panning");
  canvas.releasePointerCapture(e.pointerId);
});

// -------------------------------------------------------------- camera

let camTimer: ReturnType<typeof setTimeout> | undefined;

/** retains the view's camera (session state) after the pan/zoom has
 *  stabilized; center-based: the visible center in diagram coordinates + zoom */
function scheduleCameraSave(): void {
  if (camTimer) {
    clearTimeout(camTimer);
  }
  camTimer = setTimeout(() => {
    const viewId = layoutKey();
    if (!viewId) {
      return;
    }
    const vw = canvas.clientWidth || 800;
    const vh = canvas.clientHeight || 600;
    const cx = (vw / 2 - state.tx) / state.k;
    const cy = (vh / 2 - state.ty) / state.k;
    sessionCameras.set(viewId, { cx, cy, zoom: state.k });
  }, 800);
}

/**
 * On panel resize: the automatic fits are recomputed, and the
 * user's cameras keep their center (without content "escaped" outside
 * the window — the first fit can run before the webview
 * has the final dimension).
 */
function onViewportResize(): void {
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight;
  if (!vw || !vh || (vw === lastVW && vh === lastVH)) {
    return;
  }
  if (autoCam) {
    fit(contentBounds);
    refreshMinimap(); // new anchoring corner after resize
    return;
  }
  if (lastVW && lastVH) {
    const cx = (lastVW / 2 - state.tx) / state.k;
    const cy = (lastVH / 2 - state.ty) / state.k;
    state.tx = vw / 2 - cx * state.k;
    state.ty = vh / 2 - cy * state.k;
    applyTransform();
  }
  lastVW = vw;
  lastVH = vh;
  refreshMinimap(); // new anchoring corner + new view rectangle
}
// both sources, deduplicated through a guard on dimensions: ResizeObserver on
// the #main container (not on the canvas — RO does not fire on SVG elements
// in Chromium) and the window.resize event (RO delivers on render
// frames, which in hidden/throttled documents do not run)
new ResizeObserver(onViewportResize).observe(
  document.getElementById("main") as HTMLElement
);
window.addEventListener("resize", onViewportResize);

window.addEventListener("keydown", (e) => {
  // the keys command the diagram only when you are NOT editing a field in the inspector
  // (match_key/max_latency/selects) — otherwise "f"/"h"/"Delete" would trigger
  // gestures instead of reaching the field
  const t = e.target as HTMLElement | null;
  if (
    t &&
    (t.tagName === "INPUT" ||
      t.tagName === "SELECT" ||
      t.tagName === "TEXTAREA" ||
      t.isContentEditable)
  ) {
    return;
  }
  if (e.key === "Escape") {
    if (ctxMenu) {
      closeCtxMenu(); // Escape closes the context menu first, not the selection
      return;
    }
    if (state.selection.size) {
      state.selection.clear();
      applySelectionClasses();
      postSelection();
      renderInspector();
      return;
    }
  }
  const key = e.key.toLowerCase();
  // undo/redo of POSITIONS (docs/04): Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y —
  // before the bail on modifiers
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (key === "z" || key === "y") {
      e.preventDefault();
      undoPositions(key === "y" || e.shiftKey);
      return;
    }
  }
  if (e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }
  // Delete/Backspace: deletes the selected TB component — the same gesture as the
  // Delete button in the inspector (host: modal confirmation + cascade to the agent). Only in
  // the TB view; RTL has no deletion (the nodes come from the design, not from the config)
  if ((key === "delete" || key === "backspace") && state.mode === "tb") {
    const node = currentTbScene?.nodes.find((n) => state.selection.has(n.id));
    const target = node ? tbDeleteTarget(node) : null;
    if (target) {
      e.preventDefault();
      postAction("deleteComponent", { kind: target.kind, name: target.name });
    }
    return;
  }
  // F: fits the diagram into the window
  if (key === "f") {
    fitView();
    return;
  }
  // M: toggles the minimap (the overview navigator, docs/04)
  if (key === "m") {
    minimapOn = !minimapOn;
    refreshMinimap();
    return;
  }
  // arrows: scroll the viewport (keyboard pan, the user's request).
  // Scroll convention: down = you see content below (the content rises).
  // Bigger step with Shift; held down -> continuous scroll (keydown repeats).
  // The camera becomes the user's and is saved as with the mouse pan.
  if (
    key === "arrowup" ||
    key === "arrowdown" ||
    key === "arrowleft" ||
    key === "arrowright"
  ) {
    e.preventDefault();
    const step = e.shiftKey ? 200 : 40;
    if (key === "arrowup") {
      state.ty += step;
    } else if (key === "arrowdown") {
      state.ty -= step;
    } else if (key === "arrowleft") {
      state.tx += step;
    } else {
      state.tx -= step;
    }
    autoCam = false;
    applyTransform();
    scheduleCameraSave();
    return;
  }
  // H/V: flipping the selected BLOCK (docs/04) — in RTL and in the TB view.
  // In the TB view, H also flips a selected boundary FLAG: LOCAL horizontal
  // flip (mirrors the shape + moves the anchor to the opposite side of the
  // flag), without changing its ELK position/side — so it does not violate
  // FIRST/LAST_SEPARATE. V makes no sense on a flag (a single connection).
  if (key === "h" || key === "v") {
    let nodeId: string | undefined;
    if (state.mode === "schematic") {
      nodeId = currentScene?.nodes.find((n) => state.selection.has(n.id))?.id;
    } else if (state.mode === "tb") {
      nodeId = currentTbScene?.nodes.find((n) => state.selection.has(n.id))?.id;
      if (!nodeId && key === "h") {
        nodeId = currentTbScene?.boundary.find((b) =>
          state.selection.has(b.id)
        )?.id;
      }
    }
    if (nodeId) {
      toggleFlip(nodeId, key);
    }
  }
});

// --------------------------------------------- context menu (the TB view)

interface CtxItem {
  label: string;
  action: () => void;
  /** destructive action (deletion): it is colored as such */
  danger?: boolean;
}

let ctxMenu: HTMLElement | null = null;

function closeCtxMenu(): void {
  ctxMenu?.remove();
  ctxMenu = null;
}

/** opens the menu at (x,y) — `fixed` position, fitted into the window */
function openCtxMenu(x: number, y: number, items: CtxItem[]): void {
  closeCtxMenu();
  if (!items.length) {
    return;
  }
  const m = h("div", "ctxmenu");
  for (const it of items) {
    const b = h("button", `ctxitem${it.danger ? " danger" : ""}`, it.label);
    b.addEventListener("click", () => {
      closeCtxMenu();
      it.action();
    });
    m.append(b);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  ctxMenu = m;
}

/**
 * Right-click in the RTL views (symbol/schematic, docs/05): „Go to source" on
 * any target with a known source (the same owner resolution as on
 * double-click), plus navigation/fold/flip on blocks. On the background and on
 * the targets without actions (the pins of the folds) the native menu remains.
 */
function rtlContextMenu(e: MouseEvent): void {
  const t = e.target as Element;
  const openSrc = (args: Record<string, unknown>): void =>
    post({ v: 1, type: "action/request", action: "openSource", args });
  const items: CtxItem[] = [];
  let selectId: string | null = null;

  const pin = t.closest<SVGElement>(".pin, .bport");
  const block = t.closest<SVGElement>(
    state.mode === "schematic" ? ".inode" : ".node"
  );
  if (pin) {
    const port = pin.dataset.port;
    const owner =
      state.mode === "schematic"
        ? pin.dataset.inst ?? (pin.dataset.bport ? state.viewId : undefined)
        : state.viewId;
    if (port && owner) {
      items.push({
        label: "Go to source",
        action: () => openSrc({ viewId: owner, port }),
      });
    }
    selectId = pin.dataset.id ?? null;
  } else if (block && state.mode === "schematic") {
    const id = block.dataset.id ?? "";
    selectId = id || null;
    const inst = block.dataset.inst;
    if (inst) {
      if (hasSchematic(state.model, inst)) {
        items.push({
          label: "Open schematic",
          action: () => navigateTo(inst, "schematic"),
        });
      }
      items.push({
        label: "Go to source",
        action: () => openSrc({ viewId: inst }),
      });
    } else if (id) {
      // fold: expansion is its natural action (like the double-click)
      items.push({ label: "Expand group", action: () => toggleFold(id) });
      // the members of a fold share the SAME module (the folding criterion, docs/05),
      // so the definition is opened through the first member: `g_ch[0..2].u_ch` ->
      // `g_ch[0].u_ch`. Only when the id resolves completely (without `[*]` left over
      // from a multidimensional generate)
      const memberRel = id.replace(/\[(\d+)\.\.\d+\]/, "[$1]");
      if (state.viewId && !memberRel.includes("[*]") && memberRel !== id) {
        const member = `${state.viewId}.${memberRel}`;
        items.push({
          label: "Go to source",
          action: () => openSrc({ viewId: member }),
        });
      }
    }
    const fid = currentScene?.nodes.find((n) => n.id === id)?.foldId;
    if (fid) {
      items.push({ label: "Re-fold group", action: () => toggleFold(fid) });
    }
    if (id) {
      items.push(
        { label: "Flip horizontal (H)", action: () => toggleFlip(id, "h") },
        { label: "Flip vertical (V)", action: () => toggleFlip(id, "v") }
      );
    }
  } else if (block) {
    // the symbol view: the block IS the view's module
    const vid = state.viewId;
    if (vid) {
      items.push({
        label: "Go to source",
        action: () => openSrc({ viewId: vid }),
      });
    }
  }
  if (!items.length) {
    closeCtxMenu();
    return; // background / target without actions: the native menu
  }
  e.preventDefault();
  if (selectId && !state.selection.has(selectId)) {
    state.selection = new Set([selectId]);
    applySelectionClasses();
    postSelection();
    renderInspector();
  }
  openCtxMenu(e.clientX, e.clientY, items);
}

// Right-click on a component in the verification (TB) view: Open / Flip / Delete.
// The actions are the SAME as in the inspector and on the Delete key — `tbDeleteTarget`
// remains the single source of id->name resolution, and the modal confirmation is the host's.
canvas.addEventListener("contextmenu", (e) => {
  if (state.mode !== "tb") {
    rtlContextMenu(e); // RTL views: Go to source / Open / fold / flip
    return;
  }
  const el = (e.target as Element).closest<SVGElement>(".tbnode, .tb-bport");
  const id = el?.dataset.id;
  if (!el || !id) {
    closeCtxMenu();
    return; // on the background: the default menu
  }
  e.preventDefault();
  // the editors' convention: right-click on an element OUTSIDE the selection
  // selects it; on one from the selection it keeps the selection
  if (!state.selection.has(id)) {
    state.selection = new Set([id]);
    applySelectionClasses();
    postSelection();
    renderInspector();
  }
  const items: CtxItem[] = [];
  const node = currentTbScene?.nodes.find((n) => n.id === id);
  if (node) {
    const drill = node.drill;
    if (drill) {
      items.push({ label: "Open", action: () => tbOpen(drill) });
    }
    items.push(
      { label: "Flip horizontal (H)", action: () => toggleFlip(id, "h") },
      { label: "Flip vertical (V)", action: () => toggleFlip(id, "v") }
    );
    const dt = tbDeleteTarget(node);
    if (dt) {
      items.push({
        label: dt.label,
        danger: true,
        action: () =>
          postAction("deleteComponent", { kind: dt.kind, name: dt.name }),
      });
    }
    if (node.kind === "tbvsqr") {
      // vsqr aggregates ALL the sequences: one entry per sequence
      for (const v of state.config?.virtual_sequences ?? []) {
        const vn = v.name;
        if (vn) {
          items.push({
            label: `Delete ${vn}`,
            danger: true,
            action: () =>
              postAction("deleteComponent", { kind: "vseq", name: vn }),
          });
        }
      }
    } else if (node.kind === "tbprobe") {
      // same for probes (the node aggregates them all)
      for (const p of state.config?.probes ?? []) {
        const pn = p.name;
        if (pn) {
          items.push({
            label: `Delete ${pn}`,
            danger: true,
            action: () =>
              postAction("deleteComponent", { kind: "probe", name: pn }),
          });
        }
      }
    }
  } else {
    // boundary flag: only the LOCAL horizontal flip (V makes no sense)
    items.push({
      label: "Flip horizontal (H)",
      action: () => toggleFlip(id, "h"),
    });
  }
  openCtxMenu(e.clientX, e.clientY, items);
});

// closing the menu: click outside (capture, so it precedes the canvas
// handlers) and zoom; Escape is handled in the key handler
window.addEventListener(
  "pointerdown",
  (e) => {
    if (ctxMenu && !ctxMenu.contains(e.target as Node)) {
      closeCtxMenu();
    }
  },
  true
);
canvas.addEventListener("wheel", () => closeCtxMenu(), { passive: true });
// the focus leaves the webview (click in Design Hierarchy, editor, another panel):
// the pointer events do NOT reach the webview, so `blur` is the only way to
// close the menu (otherwise it stayed open over the new selection)
window.addEventListener("blur", closeCtxMenu);

// ------------------------------------------------------------- inspector

const inspector = document.getElementById("inspector") as HTMLElement;

function postAction(action: ActionKind, args: Record<string, unknown>): void {
  post({
    v: 1,
    type: "action/request",
    action,
    args: { viewId: state.viewId, ...args },
  });
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

function button(
  label: string,
  enabled: boolean,
  onClick: () => void,
  secondary = false,
  disabledHint?: string
): HTMLButtonElement {
  const b = h("button", `btn${secondary ? " secondary" : ""}`, label);
  b.disabled = !enabled;
  if (!enabled && disabledHint) {
    b.title = disabledHint; // the reason for disabling, visible on hover
  }
  b.addEventListener("click", onClick);
  return b;
}

/** a property row in the inspector: label + control (select/input) */
function tbPropRow(label: string, control: HTMLElement): HTMLElement {
  const row = h("div", "prop-row");
  row.append(h("label", "prop-label", label), control);
  return row;
}

/**
 * The rich functional-coverage editor (docs/07 line 3, P3b). An `analysis.coverage`
 * entry is either a BARE agent name — pure env routing, connect that agent's
 * `<agent>_cov` — or a RICH model that also generates the covergroup content. This is
 * the gesture that upgrades one to the other and then authors it.
 *
 * QuickUVM's own rules are surfaced, not discovered at generate time: a rich model
 * needs at least one coverpoint (so the upgrade creates the first), each field gets
 * exactly one coverpoint, a cross needs >= 2 DECLARED coverpoints and a unique name,
 * and `goal` is a percent. Everything the editor does not author (illegal_bins,
 * ignore_bins, transitions, cross bin selections) is edited around, never rewritten.
 */
function tbCoverageEditor(agentName: string): void {
  const entries = state.config?.analysis?.coverage ?? [];
  const entry = entries.find((c) => coveredAgent(c) === agentName);
  if (entry === undefined) {
    return;
  }
  const agent = (state.config?.agents ?? []).find((a) => a.name === agentName);
  const send = (op: string, args: Record<string, unknown> = {}): void =>
    postAction("editCoverage", { op, agent: agentName, ...args });

  inspector.append(h("h3", "", "Coverage model"));

  if (!isRich(entry)) {
    // bare entry: routing only. The upgrade needs a first coverpoint, so it is
    // offered per candidate field rather than as a bare "make it rich" button.
    const candidates = coverpointCandidates(agent, {});
    inspector.append(
      h("div", "dim", "routing only — no covergroup content is generated"),
      h("div", "note", "add a first coverpoint to author bins and crosses")
    );
    if (candidates.length) {
      const sel = tbSelect(
        [["", "— add a coverpoint —"], ...candidates.map((c) => [c, c] as const)],
        "",
        (v) => {
          if (v) {
            send("upgrade", { field: v });
          }
        }
      );
      inspector.append(tbPropRow("Coverpoint", sel));
    } else {
      inspector.append(h("div", "note", "this agent has no ports to cover"));
    }
    return;
  }

  const model = entry;
  for (const cp of model.coverpoints ?? []) {
    const field = cp.field;
    if (!field) {
      continue;
    }
    inspector.append(h("div", "prop-group", field));
    for (const bin of cp.bins ?? []) {
      const binName = bin.name;
      if (!binName) {
        continue;
      }
      const inp = h("input", "prop");
      inp.value = formatBinSpec(bin);
      inp.title = "one value (5), an inclusive range (0..7) or a list (1, 2, 3)";
      inp.addEventListener("change", () =>
        send("setBin", { field, bin: binName, spec: inp.value })
      );
      const row = tbPropRow(binName, inp);
      const del = h("button", "prop-del", "×");
      del.title = `remove bin ${binName}`;
      del.addEventListener("click", () => send("removeBin", { field, bin: binName }));
      row.append(del);
      inspector.append(row);
    }
    const addBin = h("input", "prop");
    addBin.placeholder = "new bin: name = 0..7";
    addBin.addEventListener("change", () => {
      // `name = spec` on one line, so adding a bin is a single gesture
      const [rawName, ...rest] = addBin.value.split("=");
      const spec = rest.join("=");
      if (rawName.trim() && spec.trim()) {
        send("setBin", { field, bin: rawName.trim(), spec });
        addBin.value = "";
      }
    });
    inspector.append(tbPropRow("Add bin", addBin));
    inspector.append(
      button(`Remove coverpoint ${field}`, true, () => send("removeCoverpoint", { field }), true)
    );
  }

  const candidates = coverpointCandidates(agent, model);
  if (candidates.length) {
    inspector.append(
      tbPropRow(
        "Coverpoint",
        tbSelect(
          [["", "— add —"], ...candidates.map((c) => [c, c] as const)],
          "",
          (v) => {
            if (v) {
              send("addCoverpoint", { field: v });
            }
          }
        )
      )
    );
  }

  // crosses: a checkbox per declared coverpoint, added when >= 2 are ticked
  const declared = (model.coverpoints ?? [])
    .map((c) => c.field)
    .filter((f): f is string => Boolean(f));
  for (const cross of model.crosses ?? []) {
    const name = crossName(cross);
    const row = tbPropRow(name, h("div", "dim", crossFields(cross).join(" × ")));
    const del = h("button", "prop-del", "×");
    del.title = `remove cross ${name}`;
    del.addEventListener("click", () => send("removeCross", { value: name }));
    row.append(del);
    inspector.append(row);
  }
  if (declared.length >= 2) {
    const picked = new Set<string>();
    const box = h("div", "prop-checks");
    const add = h("button", "prop-add", "cross");
    add.disabled = true;
    for (const f of declared) {
      const lbl = h("label", "prop-check");
      const cb = h("input", "");
      cb.type = "checkbox";
      cb.addEventListener("change", () => {
        if (cb.checked) {
          picked.add(f);
        } else {
          picked.delete(f);
        }
        const why = crossBlockers(model, [...picked]);
        add.disabled = why.length > 0;
        add.title = why.join(" · ");
      });
      lbl.append(cb, document.createTextNode(` ${f}`));
      box.append(lbl);
    }
    add.addEventListener("click", () => {
      if (picked.size >= 2) {
        send("addCross", { fields: declared.filter((f) => picked.has(f)) });
      }
    });
    box.append(add);
    inspector.append(tbPropRow("New cross", box));
  }

  const goalIn = h("input", "prop");
  goalIn.type = "number";
  goalIn.min = "1";
  goalIn.max = "100";
  goalIn.value = model.goal != null ? String(model.goal) : "";
  goalIn.placeholder = "closure %";
  goalIn.addEventListener("change", () => send("goal", { value: goalIn.value }));
  inspector.append(tbPropRow("Goal", goalIn));

  inspector.append(
    button("Back to routing only", true, () => send("downgrade"), true)
  );
}

/**
 * The bench-level settings panel (docs/07 line 3, P2): RAL + regression. Both are
 * PRESENCE-switched blocks — `register_model:` switches the bench into RAL mode
 * (adapter + CSR tests + env wiring), `regress:` generates the Makefile and is what
 * makes `tests[].seeds` legal — so each gets an explicit enable/remove, not a field.
 * Shown regardless of selection: these belong to the bench, not to a component.
 */
function tbBenchSettings(cfg: QuvmConfig): void {
  inspector.append(h("h3", "", "Verification settings"));

  const rm = cfg.register_model;
  if (!rm) {
    inspector.append(
      h("div", "dim", "no register model (RAL)"),
      button("Add register model…", true, () => postAction("addRegisterModel", {}), true)
    );
  } else {
    const send = (field: string, value: string): void =>
      postAction("editRegisterModel", { field, value });
    const textRow = (
      label: string,
      field: string,
      cur: string,
      placeholder: string
    ): void => {
      const inp = h("input", "prop");
      inp.value = cur;
      inp.placeholder = placeholder;
      inp.addEventListener("change", () => send(field, inp.value));
      inspector.append(tbPropRow(label, inp));
    };
    textRow("RAL package", "package", rm.package ?? "", "required");
    textRow("Reg block", "block", rm.block ?? "", "required");
    textRow("Map", "map", rm.map ?? "", "default_map");
    // the bus agent must be an INITIATOR (a responder cannot carry register traffic)
    const initiators = (cfg.agents ?? [])
      .filter((a) => a.mode !== "responder" && a.name)
      .map((a) => a.name as string);
    inspector.append(
      tbPropRow(
        "Bus agent",
        tbSelect(
          initiators.map((a) => [a, a] as const),
          rm.bus_agent ?? "",
          (v) => send("bus_agent", v)
        )
      )
    );
    if (rm.bus_agent && !initiators.includes(rm.bus_agent)) {
      inspector.append(
        h("div", "note", `bus_agent “${rm.bus_agent}” is not an initiator agent — QuickUVM refuses it`)
      );
    }
    textRow("Adapter", "adapter", rm.adapter ?? "", "reg_adapter");
    textRow("Backdoor root", "backdoor_root", rm.backdoor_root ?? "", "none (frontdoor only)");

    // csr_tests: a checkbox per suite, sent back as a comma-separated list
    const suites = ["hw_reset", "bit_bash", "rw", "mem_walk", "shared"] as const;
    const chosen = new Set(rm.csr_tests ?? []);
    const box = h("div", "prop-checks");
    for (const s of suites) {
      const lbl = h("label", "prop-check");
      const cb = h("input", "");
      cb.type = "checkbox";
      cb.checked = chosen.has(s);
      cb.addEventListener("change", () => {
        const next = new Set(chosen);
        if (cb.checked) {
          next.add(s);
        } else {
          next.delete(s);
        }
        send("csr_tests", suites.filter((x) => next.has(x)).join(","));
      });
      lbl.append(cb, document.createTextNode(` ${s}`));
      box.append(lbl);
    }
    inspector.append(tbPropRow("CSR tests", box));

    for (const [label, field, cur] of [
      ["Reg coverage", "coverage", rm.coverage === true],
      ["Use predictor", "use_predictor", rm.use_predictor !== false],
      ["Reg test", "reg_test", rm.reg_test !== false],
    ] as const) {
      inspector.append(
        tbPropRow(
          label,
          tbSelect(
            [
              ["true", "Yes"],
              ["false", "No"],
            ],
            cur ? "true" : "false",
            (v) => send(field, v)
          )
        )
      );
    }
    inspector.append(
      tbPropRow(
        "Reg test door",
        tbSelect(
          [
            ["frontdoor", "Frontdoor"],
            ["backdoor", "Backdoor"],
          ],
          rm.reg_test_door ?? "frontdoor",
          (v) => send("reg_test_door", v)
        )
      )
    );
    if (rm.reg_test_door === "backdoor" && !rm.backdoor_root) {
      inspector.append(
        h("div", "note", "a backdoor reg test needs a backdoor_root (the HDL path to the DUT)")
      );
    }
    inspector.append(
      button("Remove register model", true, () => postAction("removeRegisterModel", {}), true)
    );
  }

  const rg = cfg.regress;
  const seeded = (cfg.tests ?? []).filter((t) => t.seeds !== undefined).length;
  if (!rg) {
    inspector.append(
      h("div", "dim", "no regression (Makefile)"),
      button("Add regression", true,
        () => postAction("toggleRegress", { value: "true" }), true)
    );
  } else {
    const send = (field: string, value: string): void =>
      postAction("editRegress", { field, value });
    const simIn = h("input", "prop");
    simIn.value = rg.simulator ?? "";
    simIn.placeholder = "xcelium";
    simIn.addEventListener("change", () => send("simulator", simIn.value));
    inspector.append(tbPropRow("Simulator", simIn));

    const flIn = h("input", "prop");
    flIn.value = rg.filelist ?? "";
    flIn.placeholder = "../sim/xrun.f";
    flIn.addEventListener("change", () => send("filelist", flIn.value));
    inspector.append(tbPropRow("Filelist", flIn));

    const sdIn = h("input", "prop");
    sdIn.type = "number";
    sdIn.min = "1";
    sdIn.value = String(rg.seeds ?? 1);
    sdIn.addEventListener("change", () => send("seeds", sdIn.value));
    inspector.append(tbPropRow("Seeds", sdIn));

    inspector.append(
      tbPropRow(
        "Merge coverage",
        tbSelect(
          [
            ["true", "Yes"],
            ["false", "No"],
          ],
          rg.coverage === false ? "false" : "true",
          (v) => send("coverage", v)
        )
      )
    );
    inspector.append(
      button(
        seeded
          ? `Remove regression (${seeded} test seed count(s) go too)`
          : "Remove regression",
        true,
        () => postAction("toggleRegress", { value: "false" }),
        true
      )
    );
  }

  tbClockDomains(cfg);
  tbResetDomains(cfg);
  tbTestsEditor(cfg);
  tbBenchIdentity(cfg);
}

/**
 * The reset-domains editor (docs/07 line 3, P4b). Same union shape as the clocks, plus
 * two invariants clocks do not have: under a LIST `dut.reset` names a declared DOMAIN
 * (not a port), and a domain's `clock:` gate must name a declared clock domain. The
 * single mapping also has an `external` flag the list form does not — so converting an
 * external reset is refused host-side rather than silently dropping it.
 */
function tbResetDomains(cfg: QuvmConfig): void {
  inspector.append(h("h3", "", "Resets"));
  const reset = cfg.reset;
  const isList = Array.isArray(reset);
  const single = (isList ? undefined : reset) as
    | { active_low?: boolean; external?: boolean }
    | undefined;
  const domains: { name?: string; active_low?: boolean; clock?: string }[] = isList
    ? (reset as { name?: string }[])
    : [{ name: cfg.dut?.reset || "rst_n", active_low: single?.active_low }];
  const clocks = Array.isArray(cfg.clock)
    ? (cfg.clock as { name?: string }[])
        .map((c) => c.name)
        .filter((n): n is string => Boolean(n))
    : [];

  if (!cfg.dut?.reset) {
    inspector.append(h("div", "dim", "no reset port on the DUT"));
    return;
  }

  for (const d of domains) {
    const name = d.name || "rst_n";
    inspector.append(h("div", "prop-group", name));
    const send = (field: string, value: string): void =>
      postAction("editReset", { op: "set", name, field, value });

    inspector.append(
      tbPropRow(
        "Polarity",
        tbSelect(
          [
            ["true", "Active low"],
            ["false", "Active high"],
          ],
          d.active_low === false ? "false" : "true",
          (v) => send("active_low", v)
        )
      )
    );
    if (isList) {
      const nameIn = h("input", "prop");
      nameIn.value = name;
      nameIn.title = "renaming follows through to dut.reset and any agent gated by it";
      nameIn.addEventListener("change", () => send("name", nameIn.value));
      inspector.append(tbPropRow("Name", nameIn));
      if (clocks.length) {
        // the gate must name a DECLARED clock domain, so only those are offered
        inspector.append(
          tbPropRow(
            "Clock gate",
            tbSelect(
              [["", "— none —"], ...clocks.map((c) => [c, c] as const)],
              d.clock ?? "",
              (v) => send("clock", v)
            )
          )
        );
      }
      const users = (cfg.agents ?? []).filter((a) => a.reset === name).map((a) => a.name);
      const boundToDut = cfg.dut?.reset === name;
      inspector.append(
        button(
          boundToDut
            ? `Bound to dut.reset`
            : users.length
              ? `In use by ${users.join(", ")}`
              : `Remove ${name}`,
          domains.length > 1 && !boundToDut && users.length === 0,
          () => postAction("editReset", { op: "remove", name }),
          true
        )
      );
    } else {
      inspector.append(
        tbPropRow(
          "Driven by",
          tbSelect(
            [
              ["false", "The testbench"],
              ["true", "The environment/DUT (external)"],
            ],
            single?.external ? "true" : "false",
            (v) => send("external", v)
          )
        )
      );
    }
  }

  inspector.append(
    button("Add reset domain…", true, () => postAction("editReset", { op: "add" }), true)
  );
  if (single?.external) {
    inspector.append(
      h("div", "note", "an external reset cannot become a domain list (list entries have no `external`)")
    );
  }
  if (isList && domains.length === 1) {
    inspector.append(
      button("Back to a single reset", true, () => postAction("editReset", { op: "collapse" }), true)
    );
  }
}

/**
 * The clock-domains editor (docs/07 line 3, P4). `clock:` is either a single MAPPING
 * or a LIST of domains — different modes (a list engages per-domain clkgen/nets), so
 * a 1-element list is NOT a mapping. Adding the first domain converts mapping → list;
 * collapsing a 1-element list goes back. Per-agent domain assignment lives in the
 * agent inspector (P1); this authors the domains it chooses from.
 */
function tbClockDomains(cfg: QuvmConfig): void {
  inspector.append(h("h3", "", "Clocks"));
  const clock = cfg.clock;
  const isList = Array.isArray(clock);
  const domains: { name?: string; period?: number; unit?: string; source?: string }[] =
    isList
      ? (clock as { name?: string }[])
      : [
          {
            name: cfg.dut?.clock || "clk",
            period: (clock as { period?: number })?.period,
            unit: (clock as { unit?: string })?.unit,
          },
        ];

  for (const d of domains) {
    const name = d.name || "clk";
    inspector.append(h("div", "prop-group", name));
    const send = (field: string, value: string): void =>
      // a single mapping is addressed by any name; a list domain by its own
      postAction("editClock", { op: "set", name, field, value });

    const perIn = h("input", "prop");
    perIn.type = "number";
    perIn.min = "1";
    perIn.value = d.period != null ? String(d.period) : "";
    perIn.placeholder = "10";
    perIn.addEventListener("change", () => send("period", perIn.value));
    inspector.append(tbPropRow("Period", perIn));

    inspector.append(
      tbPropRow(
        "Unit",
        tbSelect(
          ["fs", "ps", "ns", "us", "ms", "s"].map((u) => [u, u] as const),
          d.unit ?? "ns",
          (v) => send("unit", v)
        )
      )
    );
    inspector.append(
      tbPropRow(
        "Source",
        tbSelect(
          [
            ["tb", "TB drives it"],
            ["dut", "DUT outputs it"],
          ],
          d.source ?? "tb",
          (v) => send("source", v)
        )
      )
    );
    if (isList) {
      const nameIn = h("input", "prop");
      nameIn.value = name;
      nameIn.addEventListener("change", () => send("name", nameIn.value));
      inspector.append(tbPropRow("Name", nameIn));
      // a domain in use by an agent cannot be removed (the agent inspector reassigns)
      const users = (cfg.agents ?? []).filter((a) => a.clock === name).map((a) => a.name);
      const del = button(
        users.length ? `In use by ${users.join(", ")}` : `Remove ${name}`,
        domains.length > 1 && users.length === 0,
        () => postAction("editClock", { op: "remove", name }),
        true
      );
      inspector.append(del);
    }
  }

  inspector.append(
    button("Add clock domain…", true, () => postAction("editClock", { op: "add" }), true)
  );
  if (isList && domains.length === 1) {
    inspector.append(
      button("Back to a single clock", true, () => postAction("editClock", { op: "collapse" }), true)
    );
  }
}

/**
 * The `tests[]` editor (docs/07 P2). Two QuickUVM rules are surfaced rather than
 * discovered at generate time: `seeds` is only legal with a `regress:` block, and
 * removing the LAST test drops the whole key so the bench falls back to the runnable
 * default `test1` (writing `tests: []` instead is accepted and yields a bench with
 * nothing to run — verified against the generator).
 */
function tbTestsEditor(cfg: QuvmConfig): void {
  const tests = cfg.tests ?? [];
  inspector.append(h("h3", "", "Tests"));
  if (!tests.length) {
    inspector.append(h("div", "dim", "no tests declared — QuickUVM generates the default test1"));
  }
  const vseqs = (cfg.virtual_sequences ?? [])
    .map((v) => v.name)
    .filter((n): n is string => Boolean(n));
  for (const t of tests) {
    const name = t.name;
    if (!name) {
      continue;
    }
    const send = (field: string, value: string): void =>
      postAction("editTest", { name, field, value });
    inspector.append(h("div", "prop-group", name));

    const itemsIn = h("input", "prop");
    itemsIn.type = "number";
    itemsIn.min = "0";
    itemsIn.value = t.num_items != null ? String(t.num_items) : "";
    itemsIn.placeholder = "100";
    itemsIn.addEventListener("change", () => send("num_items", itemsIn.value));
    inspector.append(tbPropRow("Items", itemsIn));

    if (vseqs.length) {
      inspector.append(
        tbPropRow(
          "Vseq",
          tbSelect(
            [["", "— none —"], ...vseqs.map((v) => [v, v] as const)],
            t.vseq ?? "",
            (v) => send("vseq", v)
          )
        )
      );
    }

    const seedsIn = h("input", "prop");
    seedsIn.type = "number";
    seedsIn.min = "1";
    seedsIn.value = t.seeds != null ? String(t.seeds) : "";
    // seeds is the per-test seed count of the regression matrix: QuickUVM rejects it
    // without a `regress:` block, so the row is inert until one exists
    seedsIn.disabled = !cfg.regress;
    seedsIn.placeholder = cfg.regress ? "regress.seeds" : "needs a regression block";
    seedsIn.addEventListener("change", () => send("seeds", seedsIn.value));
    inspector.append(tbPropRow("Seeds", seedsIn));

    inspector.append(
      button(`Delete ${name}`, true, () => postAction("removeTest", { name }), true)
    );
  }
  inspector.append(button("Add test…", true, () => postAction("addTest", {}), true));
}

/**
 * Bench identity + project metadata (docs/07 P2). `layout` and `kind` options that
 * QuickUVM would refuse are DISABLED with the reason shown — `benchid.ts` computes
 * them (subenvs need packaged, C3 `instances` need flat, a VIP drops every
 * bench-layer section). The host re-checks before writing, so the two cannot drift.
 */
function tbBenchIdentity(cfg: QuvmConfig): void {
  inspector.append(h("h3", "", "Bench"));
  const send = (field: string, value: string): void =>
    postAction("editBench", { field, value });

  /** a select whose blocked options are disabled; the reasons are listed below it */
  const guarded = (
    label: string,
    field: string,
    options: readonly (readonly [string, string])[],
    cur: string,
    blockersFor: (v: string) => string[]
  ): void => {
    const sel = h("select", "prop");
    const reasons: string[] = [];
    for (const [v, lbl] of options) {
      const why = v === cur ? [] : blockersFor(v);
      const o = h("option", "", lbl);
      o.value = v;
      o.selected = v === cur;
      o.disabled = why.length > 0;
      sel.append(o);
      reasons.push(...why);
    }
    sel.addEventListener("change", () => send(field, sel.value));
    inspector.append(tbPropRow(label, sel));
    for (const r of [...new Set(reasons)]) {
      inspector.append(h("div", "note", r));
    }
  };

  guarded(
    "Layout",
    "layout",
    [
      ["flat", "Flat (one tb package)"],
      ["packaged", "Packaged (per-agent packages)"],
    ],
    cfg.layout ?? "flat",
    (v) => layoutBlockers(cfg, v as "flat" | "packaged")
  );
  guarded(
    "Kind",
    "kind",
    [
      ["bench", "Bench"],
      ["vip", "VIP (reusable agent packages)"],
      ["selftest", "Self-test (DUT-less loopback)"],
    ],
    cfg.kind ?? "bench",
    (v) => kindBlockers(cfg, v as "bench" | "vip" | "selftest")
  );

  const topIn = h("input", "prop");
  topIn.value = cfg.top_name ?? "";
  topIn.placeholder = "tb_top";
  topIn.addEventListener("change", () => send("top_name", topIn.value));
  inspector.append(tbPropRow("Top name", topIn));

  inspector.append(
    tbPropRow(
      "Auto vseq",
      tbSelect(
        [
          ["true", "On"],
          ["false", "Off"],
        ],
        cfg.auto_virtual_sequences === false ? "false" : "true",
        (v) => send("auto_virtual_sequences", v)
      )
    )
  );
  if (cfg.auto_virtual_sequences !== false) {
    inspector.append(
      tbPropRow(
        "Auto mode",
        tbSelect(
          [
            ["parallel", "Parallel"],
            ["sequential", "Sequential"],
          ],
          cfg.auto_vseq_mode ?? "parallel",
          (v) => send("auto_vseq_mode", v)
        )
      )
    );
  }

  for (const [label, field, cur, placeholder] of [
    ["Project", "project.name", cfg.project?.name ?? "", "required"],
    ["Author", "project.author", cfg.project?.author ?? "", ""],
    ["Version", "project.version", cfg.project?.version ?? "", "0.1.0"],
  ] as const) {
    const inp = h("input", "prop");
    inp.value = cur;
    inp.placeholder = placeholder;
    inp.addEventListener("change", () => send(field, inp.value));
    inspector.append(tbPropRow(label, inp));
  }
  inspector.append(
    tbPropRow(
      "UVM",
      tbSelect(
        [
          ["1.2", "1.2"],
          ["1.1d", "1.1d"],
        ],
        cfg.project?.uvm_version ?? "1.2",
        (v) => send("project.uvm_version", v)
      )
    )
  );
}

/** A `<select>` bound to one agent field: options `[value, label]`, `cur` preselected. */
function tbSelect(
  options: readonly (readonly [string, string])[],
  cur: string,
  onChange: (v: string) => void
): HTMLSelectElement {
  const sel = h("select", "prop");
  for (const [v, lbl] of options) {
    const o = h("option", "", lbl);
    o.value = v;
    o.selected = v === cur;
    sel.append(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

/**
 * The subenv property editor (docs/07 line 3, P5): per-instance class NAMESPACING.
 *
 * The default (`namespace` absent) is AUTO, and it is the interesting one: QuickUVM
 * prefixes an instance's class names only when the SAME `config` path is composed
 * twice or more, so a block used once stays byte-identical. Forcing it on/off is for
 * the cases auto cannot see — and `false` means a genuine collision fails closed
 * rather than being silently renamed.
 */
function tbSubenvEditor(name: string): void {
  const sub = (state.config?.subenvs ?? []).find((s) => s.name === name);
  if (!sub) {
    return;
  }
  const shared =
    (state.config?.subenvs ?? []).filter((s) => s.config === sub.config).length > 1;
  const ns = sub.namespace;
  const cur =
    ns === undefined ? "auto" : ns === true ? "on" : ns === false ? "off" : "custom";
  inspector.append(h("h3", "", "Subenv properties"));
  inspector.append(
    tbPropRow(
      "Namespace",
      tbSelect(
        [
          ["auto", `Auto (${shared ? "prefixed: config reused" : "no prefix: used once"})`],
          ["on", "Force (prefix = subenv name)"],
          ["custom", typeof ns === "string" ? `Custom: ${ns}` : "Custom prefix…"],
          ["off", "Off (a collision then fails)"],
        ],
        cur,
        (v) => postAction("editSubenvNamespace", { subenv: name, mode: v })
      )
    )
  );
  if (ns === false) {
    inspector.append(
      h("div", "note", "namespacing is off — a genuine class-name collision will fail the generate")
    );
  }
}

/**
 * Per-port depth on the agent inspector (docs/07 line 3, P4c): width, randomize, a
 * constraint expression, a symbolic `enum`, and — on INOUTS — the open-drain pair.
 *
 * Two QuickUVM couplings shape the rows: an open-drain line is 1 bit and needs
 * `pullup: true` (with none it floats to X the moment every driver releases, which
 * the validator calls out as "not a style preference"), and enum/type/packed_dims/
 * struct are exclusive type specifiers. The host op enforces both, so the disabled
 * controls and the op cannot drift apart.
 */
function tbAgentPorts(agent: QuvmAgent): void {
  const name = agent.name;
  if (!name) {
    return;
  }
  const groups: [string, QuvmPort[]][] = [
    ["in", agent.ports?.inputs ?? []],
    ["out", agent.ports?.outputs ?? []],
    ["inout", (agent.ports as { inouts?: QuvmPort[] })?.inouts ?? []],
  ];
  if (!groups.some(([, ps]) => ps.length)) {
    return;
  }
  inspector.append(h("h3", "", "Ports"));
  for (const [kind, ports] of groups) {
    for (const p of ports) {
      const port = p.name;
      if (!port) {
        continue;
      }
      const send = (field: string, value: string): void =>
        postAction("editAgentPort", { agent: name, port, field, value });
      inspector.append(h("div", "prop-group", `${port} (${kind})`));

      const wIn = h("input", "prop");
      wIn.type = "number";
      wIn.min = "1";
      wIn.value = String(p.width ?? 1);
      wIn.addEventListener("change", () => send("width", wIn.value));
      inspector.append(tbPropRow("Width", wIn));

      inspector.append(
        tbPropRow(
          "Randomize",
          tbSelect(
            [
              ["true", "Yes"],
              ["false", "No"],
            ],
            p.randomize === false ? "false" : "true",
            (v) => send("randomize", v)
          )
        )
      );

      const cIn = h("input", "prop");
      cIn.value = (p as { constraint?: string }).constraint ?? "";
      cIn.placeholder = "e.g. op inside {[0:2]}";
      cIn.addEventListener("change", () => send("constraint", cIn.value));
      inspector.append(tbPropRow("Constraint", cIn));

      // enum: `NAME=value, NAME=value` on one line. Black box by design — QuickUVM
      // generates the TESTBENCH's own enum, not a reference to a DUT type.
      const rich = p as { enum?: Record<string, number>; type?: string; packed_dims?: number[]; struct?: unknown };
      const eIn = h("input", "prop");
      eIn.value = Object.entries(rich.enum ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      eIn.placeholder = "IDLE=0, BUSY=1";
      // exclusive with the hand-written specifiers the editor does not author
      eIn.disabled = Boolean(rich.packed_dims || rich.struct);
      eIn.addEventListener("change", () => send("enum", eIn.value));
      inspector.append(tbPropRow("Enum", eIn));
      if (eIn.disabled) {
        inspector.append(
          h("div", "note", "this port declares packed_dims/struct — the type specifiers are exclusive")
        );
      }

      if (kind === "inout") {
        const odSel = tbSelect(
          [
            ["false", "Tri-state (drives both levels)"],
            ["true", "Open drain"],
          ],
          (p as { open_drain?: boolean }).open_drain ? "true" : "false",
          (v) => send("open_drain", v)
        );
        odSel.disabled = (p.width ?? 1) !== 1; // open-drain is per-line, 1 bit
        inspector.append(tbPropRow("Drive", odSel));
        if (odSel.disabled) {
          inspector.append(
            h("div", "note", "open drain is 1 bit — declare one port per line")
          );
        }
        const pu = (p as { pullup?: boolean }).pullup;
        const puSel = tbSelect(
          [
            ["false", "No"],
            ["true", "Yes"],
          ],
          pu ? "true" : "false",
          (v) => send("pullup", v)
        );
        // mandatory on open drain: without it the line floats to X on release
        puSel.disabled = Boolean((p as { open_drain?: boolean }).open_drain);
        inspector.append(tbPropRow("Pullup", puSel));
        if (puSel.disabled) {
          inspector.append(
            h("div", "note", "an open-drain line needs the pullup — it never drives high")
          );
        }
      }
    }
  }
}

/**
 * The property editor of an agent (docs/07 line 3, P1). Until now an agent could be
 * CREATED but never EDITED — every reactive/hybrid/replica knob meant hand-editing
 * the YAML.
 *
 * The rows mirror QuickUVM's own coupling rules (schema reference §1.5), which are
 * hard validator walls, not conventions: the responder-only keys are DISABLED on an
 * initiator, `reorder_*` only under `respond: pipelined`, `proactive` only under
 * `on_request`. Editing a field that would orphan another also cascades the deletion
 * host-side (`setAgentField`), so the inspector cannot write a config that
 * quick-uvm then refuses.
 */
function tbAgentEditor(agent: QuvmAgent): void {
  const name = agent.name;
  if (!name) {
    return; // without a name we cannot identify it for editing
  }
  const send = (field: string, value: string): void =>
    postAction("editAgent", { name, field, value });

  const sampled = agent.ports?.outputs ?? []; // DUT-driven: what the agent samples
  const driven = agent.ports?.inputs ?? []; //   what the agent drives
  const responder = agent.mode === "responder";
  const respond = agent.respond ?? "on_request";
  const pipelined = responder && respond === "pipelined";

  inspector.append(h("h3", "", "Agent properties"));

  const activeSel = tbSelect(
    [
      ["true", "Active (drives + monitors)"],
      ["false", "Passive (monitors only)"],
    ],
    agent.active === false ? "false" : "true",
    (v) => send("active", v)
  );
  inspector.append(tbPropRow("Role", activeSel));

  inspector.append(
    tbPropRow(
      "Seq item style",
      tbSelect(
        [
          ["manual", "Manual"],
          ["field_macros", "Field macros"],
        ],
        agent.seq_item_style ?? "manual",
        (v) => send("seq_item_style", v)
      )
    )
  );

  // mode: switching to responder needs a request_valid (QuickUVM refuses a responder
  // without one) — pre-pick it when the choice is unambiguous, hint otherwise
  const oneBitSampled = sampled.filter((p: QuvmPort) => (p.width ?? 1) === 1 && p.name);
  inspector.append(
    tbPropRow(
      "Mode",
      tbSelect(
        [
          ["initiator", "Initiator (drives stimulus)"],
          ["responder", "Responder (answers the DUT)"],
        ],
        agent.mode ?? "initiator",
        (v) => {
          send("mode", v);
          if (v === "responder" && !agent.request_valid && oneBitSampled.length === 1) {
            send("request_valid", oneBitSampled[0].name as string);
          }
        }
      )
    )
  );

  const respondSel = tbSelect(
    [
      ["on_request", "On request (blocking)"],
      ["prefetch", "Prefetch"],
      ["combinational", "Combinational"],
      ["pipelined", "Pipelined (out-of-order)"],
    ],
    respond,
    (v) => send("respond", v)
  );
  respondSel.disabled = !responder;
  inspector.append(tbPropRow("Respond", respondSel));

  // request_valid: a SAMPLED 1-bit port (the qualifier the DUT asserts)
  const rvSel = tbSelect(
    [
      ["", "— none —"],
      ...oneBitSampled.map((p: QuvmPort) => [p.name as string, p.name as string] as const),
    ],
    agent.request_valid ?? "",
    (v) => send("request_valid", v)
  );
  rvSel.disabled = !responder;
  inspector.append(tbPropRow("Request valid", rvSel));
  if (responder && !agent.request_valid) {
    inspector.append(
      h(
        "div",
        "note",
        oneBitSampled.length
          ? "required: a responder needs the sampled 1-bit port that means “the DUT issued a request”"
          : "this agent has no 1-bit sampled (output) port — a responder cannot be built without one"
      )
    );
  }

  // request_ready: the READY half — may be driven (slave's arready) or sampled
  const rrSel = tbSelect(
    [
      ["", "— none —"],
      ...[...sampled, ...driven]
        .filter((p: QuvmPort) => p.name && p.name !== agent.request_valid)
        .map((p: QuvmPort) => [p.name as string, p.name as string] as const),
    ],
    agent.request_ready ?? "",
    (v) => send("request_ready", v)
  );
  // only the shapes whose monitor publishes the request carry it
  rrSel.disabled = !responder || (respond !== "on_request" && respond !== "pipelined");
  inspector.append(tbPropRow("Request ready", rrSel));

  const rbSel = tbSelect(
    [
      ["", "— none —"],
      ...sampled
        .filter(
          (p: QuvmPort) =>
            p.name && p.name !== agent.request_valid && (p.width ?? 1) <= 31
        )
        .map((p: QuvmPort) => [p.name as string, p.name as string] as const),
    ],
    agent.reorder_by ?? "",
    (v) => send("reorder_by", v)
  );
  rbSel.disabled = !pipelined;
  inspector.append(tbPropRow("Reorder by", rbSel));
  if (pipelined && !agent.reorder_by) {
    inspector.append(
      h("div", "note", "required: pipelined needs the sampled ID field keying the per-ID queues")
    );
  }

  const rpSel = tbSelect(
    [
      ["priority", "Priority"],
      ["round_robin", "Round robin"],
      ["random", "Random"],
    ],
    agent.reorder_policy ?? "priority",
    (v) => send("reorder_policy", v)
  );
  rpSel.disabled = !pipelined;
  inspector.append(tbPropRow("Reorder policy", rpSel));

  const proSel = tbSelect(
    [
      ["false", "No"],
      ["true", "Yes (hybrid)"],
    ],
    agent.proactive ? "true" : "false",
    (v) => send("proactive", v)
  );
  // a hybrid's un-maskable liveness is the on_request request-FIFO drain
  proSel.disabled = !responder || respond !== "on_request";
  inspector.append(tbPropRow("Proactive", proSel));

  const repIn = h("input", "prop");
  repIn.type = "number";
  repIn.min = "1";
  repIn.value = String(agent.replicas ?? 1);
  repIn.addEventListener("change", () => send("replicas", repIn.value));
  inspector.append(tbPropRow("Replicas", repIn));
  if ((agent.replicas ?? 1) > 1) {
    inspector.append(
      h("div", "note", "replicas needs reset: {external: true} — a shared vectored DUT binds the top reset")
    );
  }

  tbAgentPorts(agent);

  // clock/reset domains: only meaningful when they were DECLARED AS LISTS (M1) —
  // a 1-element list is still multi-domain, so the gate is "is it a list?"
  const domains = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .map((d) => (d as { name?: string })?.name)
          .filter((n): n is string => Boolean(n))
      : [];
  for (const [label, field, list, cur] of [
    ["Clock domain", "clock", domains(state.config?.clock), agent.clock ?? ""],
    ["Reset domain", "reset", domains(state.config?.reset), agent.reset ?? ""],
  ] as const) {
    if (!list.length) {
      continue; // single-domain bench: the per-agent selector would be noise
    }
    inspector.append(
      tbPropRow(
        label,
        tbSelect(
          [["", "— default —"], ...list.map((d) => [d, d] as const)],
          cur,
          (v) => send(field, v)
        )
      )
    );
  }
}

/**
 * The property editor of a scoreboard (slice 2): source/monitor/match/
 * match_key/max_latency, inline editing in the inspector -> the editScoreboard action
 * (one WorkspaceEdit per change; the diagram re-renders at config/full).
 * Empty field = reset to default (the host deletes the field from the YAML).
 */
function tbScoreboardEditor(sb: QuvmScoreboard): void {
  const name = sb.name;
  if (!name) {
    return; // without a name we cannot identify it for editing
  }
  // docs/07 P3c — on a COMPOSITION the endpoints also include the composed children's
  // agents, qualified `<subenv>.<agent>`; naming one is what makes this a cross-block
  // scoreboard. The child agents come from the host (they live in other files).
  const agents = scoreboardEndpoints(
    (state.config?.agents ?? []).map((a) => a.name),
    state.childAgents
  );
  // a hand-written endpoint we do not know about must still be selectable, or opening
  // the inspector would silently rewrite it to the first option
  for (const cur of [sb.source, sb.monitor]) {
    if (cur && !agents.includes(cur)) {
      agents.push(cur);
    }
  }
  const send = (field: string, value: string): void =>
    postAction("editScoreboard", { name, field, value });

  inspector.append(h("h3", "", "Scoreboard properties"));

  const srcSel = h("select", "prop");
  for (const a of agents) {
    // the source differs from the monitor (A2), as at add — but keep the current source
    // visible even if a hand-written config has source==monitor
    if (a === sb.monitor && a !== sb.source) {
      continue;
    }
    const o = h("option", "", a);
    o.value = a;
    o.selected = a === sb.source;
    srcSel.append(o);
  }
  srcSel.addEventListener("change", () => send("source", srcSel.value));
  inspector.append(tbPropRow("Source", srcSel));

  const monSel = h("select", "prop");
  const none = h("option", "", "None (single-stream)");
  none.value = "";
  none.selected = !sb.monitor;
  monSel.append(none);
  for (const a of agents) {
    if (a === sb.source) {
      continue; // the monitor differs from the source (A2 two-stream)
    }
    const o = h("option", "", a);
    o.value = a;
    o.selected = a === sb.monitor;
    monSel.append(o);
  }
  monSel.addEventListener("change", () => send("monitor", monSel.value));
  inspector.append(tbPropRow("Monitor", monSel));

  const matchSel = h("select", "prop");
  for (const [v, lbl] of [
    ["in_order", "In order"],
    ["out_of_order", "Out of order"],
  ] as const) {
    const o = h("option", "", lbl);
    o.value = v;
    o.selected = (sb.match ?? "in_order") === v;
    matchSel.append(o);
  }
  matchSel.disabled = !sb.monitor; // match makes sense only two-stream
  matchSel.addEventListener("change", () => send("match", matchSel.value));
  inspector.append(tbPropRow("Match", matchSel));

  const keyIn = h("input", "prop");
  keyIn.value = sb.match_key ?? "";
  keyIn.placeholder = "key field";
  keyIn.disabled = sb.match !== "out_of_order"; // required only out-of-order
  keyIn.addEventListener("change", () => send("match_key", keyIn.value));
  inspector.append(tbPropRow("Match key", keyIn));

  const latIn = h("input", "prop");
  latIn.type = "number";
  latIn.min = "0";
  latIn.value = sb.max_latency != null ? String(sb.max_latency) : "";
  latIn.placeholder = "unbounded";
  latIn.addEventListener("change", () => send("max_latency", latIn.value));
  inspector.append(tbPropRow("Max latency", latIn));

  // docs/07 P3 — the windowed N:1 check. The boundary is a SAMPLED port of the source
  // agent (the DUT strobe that closes a window), and the whole feature is
  // single-stream only: a two-stream scoreboard is strictly 1:1 and would desync N
  // samples against one verdict, which QuickUVM refuses.
  const src = (state.config?.agents ?? []).find((a) => a.name === sb.source);
  const sampled = (src?.ports?.outputs ?? [])
    .map((p: QuvmPort) => p.name)
    .filter((n): n is string => Boolean(n));
  const winSel = tbSelect(
    [["", "— none —"], ...sampled.map((p) => [p, p] as const)],
    sb.window?.boundary ?? "",
    (v) => send("window.boundary", v)
  );
  winSel.disabled = Boolean(sb.monitor);
  inspector.append(tbPropRow("Window on", winSel));
  if (sb.monitor) {
    inspector.append(
      h("div", "note", "a window needs a single-stream scoreboard (remove the monitor)")
    );
  } else if (sb.window) {
    const lenIn = h("input", "prop");
    lenIn.type = "number";
    lenIn.min = "1";
    lenIn.value = String(sb.window.length ?? 1);
    lenIn.addEventListener("change", () => send("window.length", lenIn.value));
    inspector.append(tbPropRow("Samples", lenIn));
  }

  inspector.append(
    tbPropRow(
      "Predictor",
      tbSelect(
        [
          ["sv", "SystemVerilog"],
          ["c", "C (DPI bridge)"],
        ],
        sb.reference_model?.language ?? "sv",
        (v) => send("reference_model.language", v)
      )
    )
  );
}

/**
 * The deletable component of a selected TB node: `{kind, name, label}` or null.
 * The single source of truth for the Delete button in the inspector AND for the
 * Delete key — so that the id→name resolution cannot diverge between them. Returns null
 * for what is NOT deleted through a single gesture: `tbvsqr` (aggregates all
 * the sequences → per-sequence deletion in the inspector), DUT/Env/unit/subenv/probe
 * and the cross-block scoreboards `xsb:` or the ones without a name.
 */
function tbDeleteTarget(
  node: TbScene["nodes"][number]
): { kind: string; name: string; label: string } | null {
  if (node.kind === "tbsb" && node.id.startsWith("sb:")) {
    const sb = state.config?.analysis?.scoreboards?.find(
      (s) => (s.name ?? "sbd") === node.label
    );
    return sb?.name
      ? { kind: "scoreboard", name: sb.name, label: "Delete scoreboard" }
      : null;
  }
  if (node.kind === "tbcov") {
    const agent = node.id.startsWith("cov:")
      ? node.id.slice(4)
      : node.label.replace(/_cov$/, "");
    return { kind: "coverage", name: agent, label: "Delete coverage" };
  }
  if (node.kind === "tbagent") {
    return { kind: "agent", name: node.label, label: "Delete agent…" };
  }
  return null;
}

function selectPins(names: string[]): void {
  state.selection = new Set(names.map((n) => `<port>.${n}`));
  applySelectionClasses();
  postSelection();
  renderInspector();
}

/** The side inspector: configuration, DUT, agents, coverage, actions.
 *  Without own state: everything is derived from the model + overlay (invariant 2). */
function renderInspector(): void {
  if (!inspector) {
    return;
  }
  inspector.replaceChildren();
  const inst = state.viewId ? findInstance(state.viewId) : undefined;
  const ov = state.overlay;
  const matches = Boolean(ov && inst && ov.dut === inst.module);
  const sel = [...state.selection];
  const selNames = sel.map((s) => s.replace(/^<port>\./, ""));
  // the selectable pins for the agent gestures: the symbol's pins OR
  // the boundary flags from the schematic view — the ports of the view's module,
  // with the same stable IDs `<port>.x` (the restriction to the symbol was
  // a phase 2 legacy, not a design decision)
  const byName = new Map<string, { name: string; iface: boolean }>(
    currentPins.map((p) => [p.name, p])
  );
  if (state.mode === "schematic" && currentScene) {
    for (const b of currentScene.boundary) {
      byName.set(b.name, b);
    }
  }
  const selPins = selNames
    .map((n) => byName.get(n))
    .filter((p): p is { name: string; iface: boolean } => Boolean(p));
  // the pins of a CHILD BLOCK from the schematic = the ports of that block's module:
  // the agent gesture targets the block's config (the recursive flow, docs/03).
  // Conditions: no boundary pin in the selection and all pins of the same
  // instance (the folds are excluded — they have no single target instance)
  let childAgent:
    | { viewId: string; pins: { port: string; iface: boolean }[] }
    | null = null;
  if (state.mode === "schematic" && currentScene && selPins.length === 0) {
    const owners = new Set<string>();
    const pins: { port: string; iface: boolean }[] = [];
    for (const id of sel) {
      for (const n of currentScene.nodes) {
        const p = n.pins.find((sp) => sp.id === id);
        if (p) {
          owners.add(n.instPath ?? `fold:${n.id}`);
          if (n.kind === "instance" && n.instPath) {
            pins.push({ port: p.port, iface: p.iface });
          }
        }
      }
    }
    const owner = [...owners];
    if (pins.length > 0 && owner.length === 1 && !owner[0].startsWith("fold:")) {
      childAgent = { viewId: owner[0], pins };
    }
  }
  const roles = matches && ov ? ov.roles : {};

  inspector.append(
    h("h3", "", "QuickUVM configuration"),
    h("div", "cfgpath",
      ov?.configPath ?? 'no configuration yet — "Set as DUT" creates one')
  );
  if (state.mode !== "tb" && tbAvailable()) {
    inspector.append(
      button("Open verification view", true, openTbView, true)
    );
  }

  if (ov?.dut) {
    inspector.append(h("h3", "", "DUT"), h("div", "", ov.dut));
    if (inst && ov.dut !== inst.module) {
      inspector.append(
        h("div", "note",
          `current view shows "${inst.module}" — the overlay only applies ` +
            "to the DUT's views")
      );
    }
  }

  if (ov && ov.agents.length) {
    inspector.append(h("h3", "", `Agents (${ov.agents.length})`));
    const ul = h("ul", "agents");
    for (const a of ov.agents) {
      const li = h("li", "");
      li.append(
        h("span", `swatch agent-c${a.color}`),
        h("span", "", ` ${a.name} `),
        h("span", "dim", `(${a.pins.length} pins)`)
      );
      li.title = a.pins.join(", ");
      li.addEventListener("click", () => selectPins(a.pins));
      ul.append(li);
    }
    inspector.append(ul);
  }

  if (matches && ov) {
    inspector.append(
      h("h3", "", "Coverage"),
      h("div", "", `${ov.coverage.mapped}/${ov.coverage.total} ports mapped`)
    );
    if (ov.coverage.unmapped.length) {
      inspector.append(h("div", "dim", "unmapped:"));
      const ul = h("ul", "unmapped");
      for (const n of ov.coverage.unmapped) {
        const li = h("li", "", n);
        li.addEventListener("click", () => selectPins([n]));
        ul.append(li);
      }
      inspector.append(ul);
    }
    if (ov.orphans.length) {
      inspector.append(
        h("h3", "", "Orphans in YAML"),
        h("div", "note", ov.orphans.join(", "))
      );
    }
  }

  if (state.mode === "tb") {
    const selNode = currentTbScene?.nodes.find((n) =>
      state.selection.has(n.id)
    );
    // the selected agent preloads the source of the add gestures (docs/05)
    const selAgent = selNode?.kind === "tbagent" ? selNode.label : undefined;
    if (selNode) {
      inspector.append(
        h("h3", "", "Component"),
        h("div", "", selNode.label)
      );
      if (selNode.stereotype) {
        inspector.append(h("div", "dim", selNode.stereotype));
      }
      if (selNode.drill) {
        const target = selNode.drill;
        inspector.append(
          button("Open (double-click)", true, () => tbOpen(target), true)
        );
      }
      // flip (docs/04): H = the west<->east sides of the ports, V = the order
      inspector.append(
        button("Flip horizontal (H)", true, () => toggleFlip(selNode.id, "h"), true),
        button("Flip vertical (V)", true, () => toggleFlip(selNode.id, "v"), true)
      );
      // editing + deletion per component type (slice 2). Scoreboard/coverage/
      // vseq are leaves; the agent falls in cascade (host: modal confirmation).
      const del = (kind: string, dname: string): void =>
        postAction("deleteComponent", { kind, name: dname });
      // the property editor (only the scoreboards from `analysis`, id `sb:`;
      // NOT the cross-block ones `xsb:` = analysis.scoreboards with qualified endpoints)
      if (selNode.kind === "tbsb" && selNode.id.startsWith("sb:")) {
        const sb = state.config?.analysis?.scoreboards?.find(
          (s) => (s.name ?? "sbd") === selNode.label
        );
        if (sb?.name) {
          tbScoreboardEditor(sb);
        }
      } else if (selNode.kind === "tbsubenv") {
        // docs/07 P5 — per-instance class namespacing (H1 reuse)
        tbSubenvEditor(selNode.label);
      } else if (selNode.kind === "tbcov") {
        // docs/07 P3b — the rich coverage model behind this collector
        const covAgent = selNode.id.startsWith("cov:")
          ? selNode.id.slice(4)
          : selNode.label.replace(/_cov$/, "");
        tbCoverageEditor(covAgent);
      } else if (selNode.kind === "tbagent") {
        // docs/07 line 3 (P1) — an agent can now be EDITED, not only created
        const ag = state.config?.agents?.find((a) => a.name === selNode.label);
        if (ag?.name) {
          tbAgentEditor(ag);
        }
      }
      // Delete button — the SAME id->name resolution as the Delete key on the diagram
      // (tbDeleteTarget), so they cannot diverge from each other
      const dt = tbDeleteTarget(selNode);
      if (dt) {
        inspector.append(button(dt.label, true, () => del(dt.kind, dt.name), true));
      }
      // vsqr / probes aggregate ALL their entries: deletion is per-entry (the Delete
      // key on them has no single target, so the buttons remain the only way here)
      if (selNode.kind === "tbvsqr") {
        for (const v of state.config?.virtual_sequences ?? []) {
          const vn = v.name;
          if (vn) {
            inspector.append(
              button(`Delete ${vn}`, true, () => del("vseq", vn), true)
            );
          }
        }
      } else if (selNode.kind === "tbprobe") {
        for (const p of state.config?.probes ?? []) {
          const pn = p.name;
          if (pn) {
            inspector.append(
              button(`Delete ${pn}`, true, () => del("probe", pn), true)
            );
          }
        }
      }
    }
    // selected boundary flag: LOCAL horizontal flip (mirrors the
    // shape + moves the anchor to the opposite side of the flag, without changing its
    // ELK position/side). On an inout flag (hexagon) it moves only the anchored tip.
    const selB = !selNode
      ? currentTbScene?.boundary.find((b) => state.selection.has(b.id))
      : undefined;
    if (selB) {
      inspector.append(
        h("h3", "", "Boundary"),
        h("div", "", selB.label),
        h("div", "dim",
          selB.dir === "inout"
            ? "bidirectional interface"
            : selB.dir === "out"
              ? "output (to level above)"
              : "input (from level above)"),
        button("Flip horizontal (H)", true, () => toggleFlip(selB.id, "h"), true)
      );
    }
    // the add palette (slice 2, docs/05): the connections are not free
    // edges in QuickUVM — source/monitor are fields, so "add" creates the
    // component ALREADY connected (the selected agent preloads the source)
    const hasAgents = Boolean(state.config?.agents?.length);
    const hasActive = Boolean(
      state.config?.agents?.some((a) => a.active !== false)
    );
    inspector.append(h("h3", "", "Add component"));
    inspector.append(
      button(
        selAgent ? `Coverage for ${selAgent}` : "Coverage collector",
        hasAgents,
        () => postAction("addCoverage", selAgent ? { agent: selAgent } : {}),
        true
      ),
      button(
        selAgent ? `Scoreboard from ${selAgent}` : "Scoreboard",
        hasAgents,
        () => postAction("addScoreboard", selAgent ? { source: selAgent } : {}),
        true
      ),
      button("Virtual sequence", hasActive,
        () => postAction("addVirtualSequence", {}), true),
      // docs/07 P5 — consume an agent BY REFERENCE from a generated VIP (F2'):
      // its source is never regenerated, the VIP's filelist is chained instead
      button("VIP agent (by reference)…", true,
        () => postAction("addVipAgent", {}), true)
    );
    // docs/07 P2 — bench-level settings (RAL + regression): not tied to a selection
    if (state.config) {
      tbBenchSettings(state.config);
    }
    inspector.append(h("h3", "", "Actions"));
    inspector.append(
      button("Generate testbench", Boolean(ov?.dut), () =>
        postAction("generate", {})
      )
    );
    return;
  }

  if (state.mode === "schematic" && state.model && state.viewId) {
    const nets = state.model.views[state.viewId]?.nets ?? [];
    // the net is selected through the wire/label (data-id = the net's name), BUT also
    // from a pin/flag: on a selection of ONE pin we derive its net, so that
    // the wire/label toggle is discoverable from any endpoint (observation at
    // validation — B1)
    let selNet = nets.find((n) => state.selection.has(n.name));
    if (!selNet && state.selection.size === 1) {
      const nm = netOfPin([...state.selection][0]);
      selNet = nm ? nets.find((n) => n.name === nm) : undefined;
    }
    if (selNet) {
      const ov = sidecar.views[state.viewId]?.nets?.[selNet.name];
      const effective = ov?.render ?? selNet.render;
      inspector.append(
        h("h3", "", "Net"),
        h("div", "", selNet.name),
        h("div", "dim",
          `fan-out ${selNet.fanout} — shown as ${effective}` +
            (ov ? " (override)" : ""))
      );
      inspector.append(
        button(
          effective === "wire" ? "Show as label" : "Show as wire",
          true,
          () => toggleNetRender(selNet.name),
          true
        )
      );
      // whitebox probe (K2, slice 3): the XMR path and the width are derived from the model
      // on the host (src/probe.ts) — the webview sends only (viewId, net). The host
      // refuses with a reason if the net is not probeable (unpacked, interface, subsystem
      // bench, port already mapped to an agent).
      // `ov` is shadowed here by the net override: the DUT is taken from the overlay
      inspector.append(
        button(
          "Create probe",
          Boolean(state.overlay?.dut),
          () => postAction("createProbe", { net: selNet.name }),
          true,
          "set the DUT first — a probe path is relative to the DUT instance"
        )
      );
    }
  }

  if (state.mode === "schematic" && currentScene) {
    const selNode = currentScene.nodes.find((n) => state.selection.has(n.id));
    if (selNode) {
      inspector.append(
        h("h3", "", "Selection"),
        h("div", "", selNode.name),
        h("div", "dim", selNode.sub)
      );
      inspector.append(
        button("Flip horizontal (H)", true,
          () => toggleFlip(selNode.id, "h"), true),
        button("Flip vertical (V)", true,
          () => toggleFlip(selNode.id, "v"), true)
      );
      if (selNode.kind === "fold") {
        inspector.append(
          h("div", "dim", `${selNode.foldCount} folded instances`),
          button("Expand fold", true, () => toggleFold(selNode.id), true)
        );
      } else if (selNode.instPath) {
        const p = selNode.instPath;
        if (hasSchematic(state.model, p)) {
          inspector.append(
            button("Open schematic", true,
              () => navigateTo(p, "schematic"), true)
          );
        }
        inspector.append(
          button("Open symbol", true, () => navigateTo(p, "symbol"), true),
          button("Go to source", true, () =>
            post({
              v: 1,
              type: "action/request",
              action: "openSource",
              args: { viewId: p },
            }), true)
        );
      }
    }
  }

  inspector.append(h("h3", "", "Actions"));
  // the blocks selected in the schematic view (instances and folds, not interfaces):
  // the target of the "Create subenv" action (docs/03)
  const selBlocks =
    state.mode === "schematic" && currentScene
      ? currentScene.nodes.filter(
          (n) => state.selection.has(n.id) && n.kind !== "iface"
        )
      : [];
  // the agent gesture: the boundary/symbol pins target the view's module;
  // the pins of a child block target the block's module (explicit viewId in
  // args); the DUT mismatch is resolved on the host, in the flow — the buttons no
  // longer sit dead on the non-DUT views
  const agentPins = selPins.length
    ? selPins.map((p) => ({ port: p.name, iface: p.iface }))
    : childAgent?.pins ?? [];
  const agentView = selPins.length ? state.viewId : childAgent?.viewId;
  const agentArgs = (extra: Record<string, unknown>) => ({
    viewId: agentView,
    ...extra,
  });
  const selectable = agentPins.filter((p) => !p.iface);
  const ifaceSel =
    agentPins.length === 1 && agentPins[0].iface ? agentPins[0] : undefined;
  // the actions on pins receive ONLY the resolved pins — in the schematic, the selection
  // can also contain blocks/folds, which are not ports of the DUT
  const pinIds = agentPins.map((p) => `<port>.${p.port}`);
  const allIgnored =
    selPins.length > 0 && selPins.every((p) => roles[p.name] === "ignored");
  inspector.append(
    button("Set as DUT", Boolean(inst), () => postAction("setDut", {})),
    button(
      `Agent from selection${selectable.length ? ` (${selectable.length})` : ""}`,
      selectable.length > 0,
      () => postAction("createAgentFromPins", agentArgs({ pins: pinIds }))
    ),
    button("Agent from interface", Boolean(ifaceSel), () =>
      postAction("createAgentFromIface", agentArgs({ port: ifaceSel?.port }))
    ),
    button(
      `Create subenv${selBlocks.length ? ` (${selBlocks.length})` : ""}`,
      // the DUT mismatch is resolved IN the flow (a config dedicated to the block,
      // docs/03) — the button no longer sits dead on the non-DUT views
      selBlocks.length > 0,
      () => postAction("createSubenv", { nodes: selBlocks.map((n) => n.id) })
    ),
    // slice 3: composes the CURRENT block + its siblings into the immediate parent bench
    // (createSubenv initiated from the child). Only when the view has a parent (is not
    // a top module); the host computes the parent + the direct child blocks
    button(
      "Compose into parent bench",
      Boolean(
        state.model && state.viewId && !state.model.tops.includes(state.viewId)
      ),
      () => postAction("composeIntoParent", {}),
      true,
      "open a non-top block — it gets composed into its immediate parent bench"
    ),
    // the derived composition (slice 3): writes `connections` from the inter-block nets
    // of this subsystem. Only on the DUT's OWN view (`matches`) — on
    // other views it makes no sense; the host also validates that it has subenvs
    button(
      "Wire connections from design",
      matches,
      () => postAction("wireConnections", {}),
      true,
      "open the schematic of the subsystem DUT — connections are derived for the composed blocks"
    ),
    allIgnored
      ? button("Un-ignore selection", true,
          () => postAction("unignorePort",
            { pins: selPins.map((p) => `<port>.${p.name}`) }), true)
      : button("Ignore selection", matches && selPins.length > 0,
          () => postAction("ignorePort",
            { pins: selPins.map((p) => `<port>.${p.name}`) }), true),
    button("Generate testbench", Boolean(ov?.dut), () =>
      postAction("generate", {})
    )
  );
}

// ---------------------------------------------------------------- render

function showBanner(text: string): void {
  banner.textContent = text;
  banner.hidden = false;
}

function hideBanner(): void {
  banner.hidden = true;
}

async function render(refit = false): Promise<void> {
  if (state.mode === "tb") {
    return renderTb(refit);
  }
  if (!state.model || !state.viewId) {
    empty.hidden = false;
    renderInspector();
    return;
  }
  const inst = findInstance(state.viewId);
  const def = inst ? state.model.modules[inst.module] : undefined;
  if (!inst || !def) {
    showBanner(`Instance "${state.viewId}" no longer exists in the model.`);
    renderInspector();
    return;
  }
  empty.hidden = true;
  if (state.mode === "schematic" && !hasSchematic(state.model, state.viewId)) {
    // leaf without a schematic: falls gracefully onto the symbol (docs/05)
    state.mode = "symbol";
    persistState();
  }
  renderHeader(inst);
  const gen = ++renderGen;
  if (state.mode === "schematic") {
    currentPins = [];
    const netsOv = sidecar.views[state.viewId]?.nets ?? {};
    const scene = buildSchematicScene(
      state.model,
      state.viewId,
      expandedFor(state.viewId),
      new Map(Object.entries(netsOv).map(([n, o]) => [n, o.render]))
    );
    if (!scene) {
      return;
    }
    if (!(await presentScene(scene, gen))) {
      return; // a newer render has started in the meantime
    }
  } else {
    currentScene = null;
    currentLayout = null;
    currentEdgesGroup = null;
    const pins = buildPins(def);
    currentPins = pins;
    const layout = await layoutSymbol(inst.module, pins);
    if (gen !== renderGen) {
      return;
    }
    draw(inst, pins, layout);
    const ctx = layout.children?.[0];
    contentBounds = {
      x: 0,
      y: 0,
      w: ctx?.width ?? 200,
      h: ctx?.height ?? 100,
    };
  }
  renderInspector();
  applyCameraAfterRender(refit);
}

/**
 * The common pipeline of the multi-node views (the schematic view and
 * the verification (TB) view): ELK layout with the seeds/flips from the sidecar,
 * forcing the seeds, the grid world, the D21 pinning and the drawing with the own
 * router. Returns false if a newer render has started in the meantime.
 */
interface Boxed {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * The closest free spot on the grid for `child`, avoiding overlap
 * (with margin `pad`) with the other nodes; `null` if it is already free or is not
 * found within the search radius. Scans on circles of increasing radius,
 * preferring DOWN (the members of a fold naturally settle in a column below the position
 * inserted by ELK). Pure — only arithmetic on boxes.
 */
function freeSpot(
  child: Boxed,
  all: readonly Boxed[],
  pad: number
): { x: number; y: number } | null {
  const w = child.width ?? 0;
  const h = child.height ?? 0;
  const others = all.filter((c) => c !== child);
  const free = (x: number, y: number): boolean =>
    !others.some((o) => {
      const ox = o.x ?? 0;
      const oy = o.y ?? 0;
      const ow = o.width ?? 0;
      const oh = o.height ?? 0;
      return (
        x < ox + ow + pad &&
        x + w + pad > ox &&
        y < oy + oh + pad &&
        y + h + pad > oy
      );
    });
  const x0 = child.x ?? 0;
  const y0 = child.y ?? 0;
  if (free(x0, y0)) {
    return null;
  }
  for (let r = GRID; r <= 60 * GRID; r += GRID) {
    // the order prefers down, then up, then lateral/diagonals
    const cands: [number, number][] = [
      [x0, y0 + r], [x0, y0 - r], [x0 + r, y0], [x0 - r, y0],
      [x0 + r, y0 + r], [x0 - r, y0 + r], [x0 + r, y0 - r], [x0 - r, y0 - r],
    ];
    for (const [x, y] of cands) {
      if (free(x, y)) {
        return { x, y };
      }
    }
  }
  return null;
}

async function presentScene(
  scene: SchematicScene,
  gen: number
): Promise<boolean> {
  const viewId = state.viewId;
  if (!viewId) {
    return false;
  }
  // the flips enter the port geometry at layout (docs/04):
  // ELK routes toward the already-flipped positions, so its routes remain
  // valid even on flipped nodes
  const nodesOv = sidecar.views[viewId]?.nodes ?? {};
  const flips = new Map<string, Flip>(
    Object.entries(nodesOv)
      .filter(([, o]) => o.flipH || o.flipV)
      .map(([id, o]) => [id, { h: Boolean(o.flipH), v: Boolean(o.flipV) }])
  );
  // the user-owned positions become seeds for interactive ELK:
  // the known nodes stay in place, only the new elements receive positions,
  // inserted in the context of the existing ones (docs/04, invariant 3)
  const seeds = new Map<string, { x: number; y: number }>();
  for (const [id, o] of Object.entries(nodesOv)) {
    if (o.x !== undefined && o.y !== undefined) {
      seeds.set(id, { x: o.x, y: o.y });
    }
  }
  const layout = await layoutSchematic(
    elk,
    scene,
    measurer(),
    flips,
    seeds.size ? seeds : undefined
  );
  if (gen !== renderGen) {
    return false;
  }
  currentScene = scene;
  currentLayout = layout;
  // the selection requested by the host (select/reveal) can refer to FOLDED generate
  // members (rels that do not exist in the DOM): remapping onto the current scene
  // (rel -> the fold through memberPaths; pure, locmap.ts), with an echo to the host —
  // otherwise „Reveal in Diagram" navigated correctly but selected nothing
  if (state.selection.size) {
    const remapped = remapSelection(
      [...state.selection],
      state.viewId ?? "",
      scene.nodes.map((n) => ({
        id: n.id,
        instPath: n.instPath,
        module: "",
        memberPaths: n.memberPaths,
      }))
    );
    if (
      remapped.length !== state.selection.size ||
      remapped.some((id) => !state.selection.has(id))
    ) {
      state.selection = new Set(remapped);
      postSelection();
      renderInspector();
    }
  }
  // the seeds are forced exactly (interactive ELK can move them slightly);
  // with any position override, the ELK routes are no longer valid ->
  // naive re-routing
  for (const child of layout.children ?? []) {
    const s = seeds.get(child.id);
    if (s) {
      child.x = s.x;
      child.y = s.y;
    }
  }
  // the grid world is universal (docs/04): ALL positions are rounded
  // to the grid, in any view — the anchors fall on grid rows (the router
  // produces fully orthogonal routes) and pin-to-pin alignment is always
  // possible; the ELK positions are fractional, the jump is under half
  // a step
  for (const child of layout.children ?? []) {
    child.x = Math.round((child.x ?? 0) / GRID) * GRID;
    child.y = Math.round((child.y ?? 0) / GRID) * GRID;
  }
  // arranged view (has seeds): the elements WITHOUT a seed — new from
  // recompilation, fold members freshly expanded or left over from a
  // partial sidecar — are pinned now, so that the seeds remain total and
  // no future render can move them again (docs/04); the untouched
  // views (without seeds) stay completely automatic, nothing is persisted
  if (seeds.size) {
    const children = layout.children ?? [];
    // anti-overlap nudge: on an arranged view, D21 pins ALL the neighbors,
    // so interactive ELK cannot push them to make room — the members of a
    // freshly expanded fold (elements WITHOUT a seed) can land on top of pinned
    // nodes. We move them to the closest free spot on the grid, without touching
    // the user's blocks (observation at validation); the fresh view
    // (without seeds) goes through full ELK, so it does not need a nudge
    for (const child of children) {
      if (seeds.has(child.id)) {
        continue; // a user-pinned element: it does not move
      }
      const spot = freeSpot(child, children, 24);
      if (spot) {
        child.x = spot.x;
        child.y = spot.y;
      }
    }
    const fresh: Record<string, { x: number; y: number }> = {};
    for (const child of children) {
      if (!seeds.has(child.id)) {
        const x = child.x ?? 0;
        const y = child.y ?? 0;
        const n = sidecarNode(viewId, child.id);
        n.x = x;
        n.y = y;
        fresh[child.id] = { x, y };
      }
    }
    if (Object.keys(fresh).length) {
      post({
        v: 1, type: "layout/snapshot", viewId, nodes: fresh,
      });
    }
  }
  const vp = resetCanvas();
  currentEdgesGroup = drawSchematic(
    scene, layout, vp, { onToggleFold: toggleFold }
  );
  // fine centering of the {}/[] signs in the chips: immediately, then re-applied on
  // the next frame and after the editor font loads — in the webview the first
  // getBBox can run before the font is applied, leaving the sign off-center
  centerChipSigns(vp);
  requestAnimationFrame(() => centerChipSigns(canvas));
  if (document.fonts?.ready) {
    void document.fonts.ready.then(() => centerChipSigns(canvas)).catch(() => {});
  }
  applySelectionClasses();
  applyStatusBadges();
  applyGenBadges();
  contentBounds = layoutBounds(layout);
  refreshMinimap();
  return true;
}

/** the camera after the render: the view's session one or an automatic fit */
function applyCameraAfterRender(refit: boolean): void {
  const camKey = layoutKey();
  if (!camKey) {
    return;
  }
  if (refit || state.k === 1) {
    // the view's session camera has priority; otherwise automatic
    // fit. The camera is center-based: cx/cy = the visible center in
    // the diagram coordinates — robust to panel resize.
    const cam = sessionCameras.get(camKey);
    if (cam) {
      const vw = canvas.clientWidth || 800;
      const vh = canvas.clientHeight || 600;
      const tx = vw / 2 - cam.cx * cam.zoom;
      const ty = vh / 2 - cam.cy * cam.zoom;
      // safety net: a camera that would leave the content completely
      // outside the window (corrupt data, content moved radically) is ignored
      const bx = contentBounds.x * cam.zoom + tx;
      const by = contentBounds.y * cam.zoom + ty;
      const visible =
        bx < vw &&
        bx + contentBounds.w * cam.zoom > 0 &&
        by < vh &&
        by + contentBounds.h * cam.zoom > 0;
      if (visible) {
        state.k = cam.zoom;
        state.tx = tx;
        state.ty = ty;
        lastVW = vw;
        lastVH = vh;
        autoCam = false;
        applyTransform();
      } else {
        fit(contentBounds);
      }
    } else {
      fit(contentBounds);
    }
  } else {
    applyTransform();
  }
}

/**
 * The verification (TB) view (phase 3b slice 1, docs/05): the pure TB scene from
 * the QuickUVM configuration + the same layout/routing/positions pipeline as
 * the schematic view; the view key is `tb:<config-path>`, the positions live in
 * the sidecar under it, with all the D21 mechanics.
 */
async function renderTb(refit: boolean): Promise<void> {
  if (state.viewId && !state.viewId.startsWith("tb:")) {
    // mode/key desynchronization (should not happen): the RTL view
    // has priority, we do not draw the TB scene under its key
    state.mode = "symbol";
    persistState();
    return render(true);
  }
  if (!state.viewId || !state.config) {
    empty.hidden = false;
    renderInspector();
    return;
  }
  empty.hidden = true;
  const gen = ++renderGen;
  currentPins = [];
  // the current level (D24): "" testbench, "env", "agent:X". On a nonexistent
  // focus (config changed), it falls onto the root.
  let scene = buildTbScene(state.config, state.tbFocus, state.configPath);
  if (!scene && state.tbFocus !== "") {
    // the focus level disappeared (config changed): it falls onto the root and
    // notifies the host, so that the reveal from the tree does not stay on the old level
    state.tbFocus = "";
    post({ v: 1, type: "tb/focus", focus: "", select: null });
    scene = buildTbScene(state.config, "", state.configPath);
  }
  if (!scene) {
    currentScene = null;
    currentLayout = null;
    currentEdgesGroup = null;
    currentTbScene = null;
    currentTbLayout = null;
    renderTbHeader(null);
    resetCanvas();
    showBanner(
      'The QuickUVM configuration has nothing to draw yet — use "Set as DUT" first.'
    );
    renderInspector();
    return;
  }
  renderTbHeader(scene);
  hideBanner();
  // the user-owned positions (per level) become seeds for interactive
  // ELK (docs/04, the same D21 mechanics as the RTL schematic view)
  const key = layoutKey();
  const nodesOv = (key && sidecar.views[key]?.nodes) || {};
  const seeds = new Map<string, { x: number; y: number }>();
  for (const [id, o] of Object.entries(nodesOv)) {
    if (o.x !== undefined && o.y !== undefined) {
      seeds.set(id, { x: o.x, y: o.y });
    }
  }
  // the user-owned flips (H = sides, V = order), as in RTL
  const flips = new Map<string, Flip>(
    Object.entries(nodesOv)
      .filter(([, o]) => o.flipH || o.flipV)
      .map(([id, o]) => [id, { h: Boolean(o.flipH), v: Boolean(o.flipV) }])
  );
  // ELK can throw on invalid configurations (e.g. a layerConstraint
  // FIRST/LAST_SEPARATE incompatible with the edge direction): we catch the error so that
  // the render does not fail SILENTLY (the diagram would stay frozen on the old state,
  // without any explanation — a real regression caught at flip on a flag)
  let layout: TbLayout;
  try {
    layout = await layoutTb(
      elk,
      scene,
      measurer(),
      seeds.size ? seeds : undefined,
      flips.size ? flips : undefined
    );
  } catch {
    if (gen !== renderGen) {
      return;
    }
    showBanner("Could not lay out the verification view for this configuration.");
    return;
  }
  if (gen !== renderGen) {
    return; // a newer render has started in the meantime
  }
  // the seeds are forced exactly (interactive ELK can move them slightly);
  // the ports are relative, so the anchors follow the forced position
  for (const [id, s] of seeds) {
    const n = layout.nodes.get(id);
    if (n) {
      n.x = s.x;
      n.y = s.y;
    }
    const b = layout.boundary.get(id);
    if (b) {
      b.x = s.x;
      b.y = s.y;
    }
  }
  // the grid world is universal (docs/04): ALL positions are rounded to
  // the grid, in any view (like presentScene) — an external/corrupt off-grid
  // seed does not produce crooked wires, and D21 pins everything on the grid
  for (const p of layout.nodes.values()) {
    p.x = Math.round(p.x / GRID) * GRID;
    p.y = Math.round(p.y / GRID) * GRID;
  }
  for (const p of layout.boundary.values()) {
    p.x = Math.round(p.x / GRID) * GRID;
    p.y = Math.round(p.y / GRID) * GRID;
  }
  // D21: in an arranged view (has seeds), the elements WITHOUT a seed —
  // new from editing the config, left over from a partial sidecar — are
  // pinned now, so that the seeds remain total (docs/04)
  if (seeds.size && key) {
    const fresh: Record<string, { x: number; y: number }> = {};
    const pin = (id: string, x: number, y: number): void => {
      if (!seeds.has(id)) {
        const nn = sidecarNode(key, id);
        nn.x = x;
        nn.y = y;
        fresh[id] = { x, y };
      }
    };
    for (const [id, p] of layout.nodes) {
      pin(id, p.x, p.y);
    }
    for (const [id, p] of layout.boundary) {
      pin(id, p.x, p.y);
    }
    if (Object.keys(fresh).length) {
      post({ v: 1, type: "layout/snapshot", viewId: key, nodes: fresh });
    }
  }
  currentScene = null;
  currentLayout = null;
  currentEdgesGroup = null;
  currentTbScene = scene;
  currentTbLayout = layout;
  const vp = resetCanvas();
  currentTbEdgesGroup = drawTb(scene, layout, vp);
  applySelectionClasses();
  contentBounds = tbBounds(layout);
  applyStatusBadges();
  applyGenBadges();
  refreshMinimap();
  renderInspector();
  applyCameraAfterRender(refit);
}

/** navigation by levels in the verification (TB) view (drill / breadcrumb, D24) */
function tbNavigate(focus: string, select: string | null = null): void {
  state.tbFocus = focus;
  state.selection = new Set(select ? [select] : []);
  post({ v: 1, type: "tb/focus", focus, select });
  void render(true);
}

/** opens the target of a TB drill: a LOCAL level (tb/focus) or, with the
 *  `config:<subenv>` prefix, the config of the composed block — the host opens it with
 *  the default editor, that is the per-file TB diagram (slice 4, docs/05) */
function tbOpen(drill: string): void {
  if (drill.startsWith("config:")) {
    // `config:<path>` — the very path of the child config (can contain `:` on
    // Windows: `config:C:/x.yaml`); we cut ONLY the first prefix
    post({
      v: 1,
      type: "action/request",
      action: "openSubenvConfig",
      args: { config: drill.slice("config:".length) },
    });
    return;
  }
  tbNavigate(drill);
}

/** the header of the verification (TB) view: breadcrumb by levels + RTL return */
function renderTbHeader(scene: TbScene | null): void {
  head.replaceChildren();
  const crumbs = h("span", "crumbs");
  const trail = scene?.breadcrumb ?? [
    { label: state.configPath ?? "Testbench", focus: "" },
  ];
  trail.forEach((c, i) => {
    if (i) {
      crumbs.append(h("span", "sep", "›"));
    }
    if (i < trail.length - 1) {
      const a = h("span", "seg link", c.label);
      a.addEventListener("click", () => tbNavigate(c.focus));
      crumbs.append(a);
    } else {
      crumbs.append(h("span", "seg", c.label));
    }
  });
  head.append(crumbs);
  const tgl = h("span", "mode-toggle");
  if (state.model) {
    // a single button to return to the design (D24: without Symbol/Schematic)
    const back = h("button", "mbtn", "Design");
    back.title = "Back to the design views";
    back.addEventListener("click", () => leaveTbView());
    tgl.append(back);
  }
  const tb = h("button", "mbtn active", "Testbench");
  tgl.append(tb);
  const fitBtn = h("button", "mbtn", "⛶");
  fitBtn.title = "Fit to window (F)";
  fitBtn.addEventListener("click", fitView);
  tgl.append(fitBtn);
  // Re-arrange all (docs/04): deletes the level's positions and returns to ELK
  const rl = h("button", "mbtn", "⟲");
  rl.title = "Re-arrange all (discards node positions)";
  rl.addEventListener("click", relayoutAll);
  tgl.append(rl);
  const ex = h("button", "mbtn", "⤓");
  ex.title = "Export view as SVG";
  ex.addEventListener("click", exportSvg);
  tgl.append(ex);
  head.append(tgl);
  updateGenChip(); // the generate status chip (docs/05)
}

post({ v: 1, type: "ready" });
