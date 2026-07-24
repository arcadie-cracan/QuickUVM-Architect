// The sidebar "Properties" view (docs/07 UX slice 2): the CONFIG-editing half of the
// inspector, rendered next to the Hierarchy and Verification trees instead of inside
// the diagram. It reuses inspector-view.ts verbatim — the only difference is
// `canvas: false`, which drops the drawing tools (flip, fold, net render, pin
// selection, cone) that can only act on a canvas this view does not have.
//
// It is a SEPARATE bundle from the diagram: no SVG, no layout, no ELK. That is the
// whole reason the inspector was extracted first — the sidebar view is always open,
// so it must not carry the diagram's weight.

import { buildTbScene } from "./tbscene";
import { renderInspector } from "./inspector-view";
import type { HostMessage, WebviewMessage, ActionKind } from "../protocol";
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
  mode: "tb",
  selection: new Set<string>(),
  overlay: null,
  config: null,
  configPath: null,
  childAgents: {},
  tbFocus: "",
  tx: 0,
  ty: 0,
  k: 1,
};

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
  // the TB scene is derived from the config by the same pure builder the diagram
  // uses, so the two views cannot disagree about what exists
  const tbScene = state.config
    ? (buildTbScene(state.config, state.tbFocus, state.configPath) ?? undefined)
    : undefined;
  renderInspector({
    canvas: false, // no drawing surface here: the canvas tools stay with the diagram
    root,
    state,
    tbScene,
    scene: null,
    pins: [],
    post,
    postAction,
    vscode,
    // Navigation and drawing gestures belong to the diagram. From here they are
    // relayed as messages; the host forwards them to the panel (which may not even
    // be open, in which case they are simply dropped — nothing here depends on them).
    onOpen: (drill) => post({ v: 1, type: "tb/focus", focus: drill }),
    onFlip: () => undefined,
    onSelectPins: () => undefined,
    findInstance: () => undefined,
    tbAvailable: () => Boolean(state.config),
    // the diagram is what has a TB view to open; from here it is a no-op
    openTbView: () => undefined,
    netOfPin: () => null,
    sidecar: null,
    toggleNetRender: () => undefined,
    toggleFold: () => undefined,
    hasSchematic: () => false,
    navigateTo: () => undefined,
  });
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case "config/full":
      state.config = m.config;
      state.configPath = m.configPath;
      state.childAgents = m.childAgents ?? {};
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
      break;
    default:
      return; // everything else is diagram business
  }
  render();
});

post({ v: 1, type: "ready" });
render();
