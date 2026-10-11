// The sidebar "Properties" view: the ONE inspector. It used to be the config-editing
// half of a pair, with the diagram's `<aside>` keeping the drawing tools; the split
// cost a whole column of horizontal space and had already drifted (the aside grew
// Set as DUT / Agent from selection / Wire connections — config edits, not canvas
// tools — and duplicated Generate testbench). The aside is gone; everything renders
// here.
//
// The drawing gestures still need a canvas, so they are RELAYED: this view posts
// them, the host forwards them to the panel, and the panel applies them exactly as
// if they had come from its own inspector. If no panel is open they are dropped —
// nothing in this view depends on their effect.
//
// It is a SEPARATE bundle from the diagram: no SVG, no layout, no ELK. That is the
// whole reason the inspector was extracted first — the sidebar view is always open,
// so it must not carry the diagram's weight. The two SCENE builders it does pull in
// (tbscene, scene) are the same pure ones the diagram uses, so the two surfaces
// cannot disagree about what exists.

import { buildSchematicScene, hasSchematic, netOfPin as sceneNetOfPin } from "./scene";
import { buildTbScene } from "./tbscene";
import { renderInspector } from "./inspector-view";
import { pinIdentities } from "../inspector";
import type {
  ActionKind,
  HostMessage,
  SidecarData,
  WebviewMessage,
} from "../protocol";
import type { State } from "./state";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState():
    | { viewId?: string; mode?: string; openSections?: string[] }
    | undefined;
  setState(state: Record<string, unknown>): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById("inspector") as HTMLElement;

const state: State = {
  model: undefined,
  viewId: undefined,
  // the diagram owns the mode; until a view/show arrives there is no RTL view to
  // inspect, and "tb" is the only thing renderable from the config alone
  mode: "tb",
  selection: new Set<string>(),
  overlay: null,
  config: null,
  configPath: null,
  childAgents: {},
  resolved: null,
  tbFocus: "",
  tx: 0,
  ty: 0,
  k: 1,
};

/** the layout sidecar — needed for the per-net render overrides and the fold state,
 *  so the scene built here is the one the diagram is actually showing */
let sidecar: SidecarData = { schema_version: 1, views: {}, orphans: [] };

/** the explicitly expanded folds per view, mirrored from the sidecar exactly as the
 *  diagram does it: a fold changes node/pin IDs, so a disagreement here would make
 *  the relayed selection resolve to nothing */
function expandedFor(viewId: string): Set<string> {
  const out = new Set<string>();
  for (const [nodeId, n] of Object.entries(sidecar.views[viewId]?.nodes ?? {})) {
    if (n.collapsed === false) {
      out.add(nodeId);
    }
  }
  return out;
}

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

function postAction(action: ActionKind, args: Record<string, unknown>): void {
  post({ v: 1, type: "action/request", action, args });
}

function render(): void {
  if (!root) {
    return;
  }
  // Both scenes come from the same pure builders the diagram uses, so the two
  // surfaces cannot disagree about what exists.
  const tbScene = state.config
    ? (buildTbScene(state.config, state.tbFocus, state.configPath, state.resolved) ?? undefined)
    : undefined;
  const viewId = state.viewId;
  // A LEAF module has no `views` entry, so "Open Schematic View" on one leaves the host
  // reporting mode "schematic" while the DIAGRAM has fallen back to drawing the symbol
  // (main.ts does exactly this normalization before rendering). Mirror it, or the two
  // surfaces disagree about what is on screen: `scene` would be null AND `pins` empty,
  // so nothing resolves the selection and every pin-driven action ("Agent from
  // selection", "Ignore selection") sits disabled on a perfectly good selection.
  if (
    state.mode === "schematic" &&
    !(state.model && viewId && hasSchematic(state.model, viewId))
  ) {
    state.mode = "symbol";
  }
  const netsOv = viewId ? (sidecar.views[viewId]?.nets ?? {}) : {};
  const scene =
    state.mode === "schematic" && state.model && viewId
      ? buildSchematicScene(
          state.model,
          viewId,
          expandedFor(viewId),
          new Map(Object.entries(netsOv).map(([n, o]) => [n, o.render as "wire" | "label"]))
        )
      : null;
  // in the symbol view the selectable pins are the module's own ports; in the
  // schematic they are the boundary flags, which the inspector reads off the scene
  const def =
    state.mode === "symbol" && state.model && viewId
      ? state.model.modules[
          state.model.instances.find((i) => i.path === viewId)?.module ?? ""
        ]
      : undefined;

  renderInspector({
    root,
    state,
    tbScene,
    scene,
    pins: def ? pinIdentities(def) : [],
    post,
    postAction,
    vscode,
    // The drawing gestures need a canvas this view does not have, so they are
    // relayed: the host forwards each to the panel, which applies it as if its own
    // inspector had sent it. With no panel open they are dropped — nothing here
    // depends on their effect.
    onOpen: (drill) => post({ v: 1, type: "tb/focus", focus: drill }),
    onFlip: (id, axis) =>
      post({ v: 1, type: "relay/flip", nodeId: id, axis }),
    onSelectPins: (names) => post({ v: 1, type: "relay/selectPins", names }),
    findInstance: (v) => state.model?.instances.find((i) => i.path === v),
    tbAvailable: () => Boolean(state.config),
    openTbView: () => post({ v: 1, type: "relay/openTb" }),
    netOfPin: (id) => (scene ? sceneNetOfPin(scene, id) : null),
    sidecar,
    toggleNetRender: (net) => post({ v: 1, type: "relay/netRender", net }),
    toggleFold: (id) => post({ v: 1, type: "relay/fold", foldId: id }),
    hasSchematic: (_model, v) => Boolean(state.model && hasSchematic(state.model, v)),
    navigateTo: (v, mode) =>
      post({ v: 1, type: "nav/drill", instancePath: v, mode }),
  });
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case "config/full":
      state.config = m.config;
      state.configPath = m.configPath;
      state.childAgents = m.childAgents ?? {};
      state.resolved = m.resolved ?? null;
      break;
    case "overlay/config":
      state.overlay = m;
      break;
    case "tb/navigate":
      state.tbFocus = m.focus;
      break;
    // the diagram owns the selection; the host relays it here so both surfaces
    // agree on what is being inspected
    case "select/reveal":
      state.selection = new Set(m.ids);
      break;
    case "view/show":
      state.viewId = m.viewId;
      // the mode decides which half of the inspector is meaningful (RTL actions vs
      // the TB component editors); without it the sidebar was pinned to "tb" and
      // could never show Set as DUT / Agent from selection
      if (m.mode) {
        state.mode = m.mode;
      }
      break;
    case "model/full":
      state.model = m.model;
      break;
    case "layout/full":
      sidecar = m.sidecar;
      break;
    default:
      return; // everything else is diagram business
  }
  render();
});

post({ v: 1, type: "ready" });
render();
