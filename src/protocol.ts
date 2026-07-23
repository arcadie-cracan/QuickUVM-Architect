// The extension <-> webview message protocol, versioned (v: 1).
// The source of truth for the message shapes: docs/05-ui-si-protocol.md — any
// new message is added FIRST there, then here. The file is shared by the host
// (src/) and the webview (src/webview/), so it does not import anything from `vscode`.
//
// State of the contract (phases 0-3b completed): all the messages and actions
// below are implemented and strictly typed, with TWO exceptions declared
// to fix the contract but not yet handled — reserved for the level
// 2/3 overrides of phase 4 (docs/04): `ports/reordered` (the pin order) and
// `edge/override` (waypoints; payload `unknown`, refined at
// implementation time, D7: only on demonstrated demand).

import type { ProjectModel } from "./model";

export const PROTOCOL_VERSION = 1 as const;

export type Side = "north" | "south" | "east" | "west";

/** display mode of an RTL view (docs/05): the symbol or the schematic */
import type { QuvmConfig } from "./quickuvm";

/** "tb" = the verification (TB) view (phase 3b, docs/05), the key `tb:<config-path>` */
export type ViewMode = "symbol" | "schematic" | "tb";

/** the lasso semantics (docs/05): only the objects fully contained
 *  ("window selection", the default) or also the ones touched ("crossing") */
export type LassoMode = "contain" | "intersect";

/** the UI preferences from the extension settings (the ui/config message) */
export interface UiConfig {
  lasso: LassoMode;
  /** the drawing vocabulary (slash+width on buses, junction dots) is visible;
   *  false = hidden (the quickuvm.schematicDecorations setting, docs/04) */
  decorations: boolean;
}

/** Actions requested by the webview that touch the YAML or the sources (doc. 05). */
export type ActionKind =
  | "setDut"
  | "createAgentFromPins"
  | "createAgentFromIface"
  | "createSubenv"
  | "ignorePort"
  | "unignorePort"
  | "generate"
  | "openSource"
  // the verification (TB) view (phase 3b, slice 2): adding TB components
  | "addScoreboard"
  | "addCoverage"
  | "addVirtualSequence"
  // slice 2: deletion (with confirmation/cascade) and editing of properties
  | "deleteComponent"
  | "editScoreboard"
  | "editAgent"
  // P2: bench-level configuration (RAL + regression)
  | "addRegisterModel"
  | "removeRegisterModel"
  | "editRegisterModel"
  | "toggleRegress"
  | "editRegress"
  // slice 3: whitebox probe (K2) from a net selected in the schematic view
  | "createProbe"
  // slice 3: derived composition — H1 connections from the view's nets
  | "wireConnections"
  // slice 3: composes the current block + its siblings into the parent bench
  | "composeIntoParent"
  // drill into the composed block: opens the subenv's config with the default
  // editor (per-file TB diagram, slice 4)
  | "openSubenvConfig";

// ---------------------------------------------------- the layout sidecar

/** the position (and the fold/flip state) of a node, owned by the
 *  user (docs/04); x/y may be missing on nodes with other overrides
 *  but not yet moved */
export interface SidecarNode {
  x?: number;
  y?: number;
  /** only for generated folds; absent = default (folded) */
  collapsed?: boolean;
  /** horizontal flip: the west<->east sides swapped (docs/04) */
  flipH?: boolean;
  /** vertical flip: the pin order reversed on each side */
  flipV?: boolean;
}

// the camera (pan/zoom) is NOT part of the sidecar: it is session state of the
// webview (docs/04) — the first opening of a view always fits;
// the frame is preserved only between switches within the same session

export interface SidecarView {
  nodes?: Record<string, SidecarNode>;
  /** the level-4 override (docs/04): wire <-> label per net; absent =
   *  the suggestion from the model (render computed from fan-out) */
  nets?: Record<string, { render: "wire" | "label" }>;
}

/** orphan override: the key disappeared from the model (graceful invalidation) */
export interface SidecarOrphan {
  view: string;
  node: string;
  value: SidecarNode | { render: "wire" | "label" };
  /** the kind of the orphan key; absent = node (compatibility) */
  kind?: "net";
  /** the date of the last valid view (ISO 8601) */
  lastSeen: string;
}

/** the content of the sidecar file (docs/04); only overrides, nothing derived */
export interface SidecarData {
  schema_version: 1;
  views: Record<string, SidecarView>;
  orphans: SidecarOrphan[];
}

// ------------------------------------------------- the configuration overlay

/** the role of a port in the overlay (apart from belonging to an agent) */
export type PortRole = "clock" | "reset" | "ignored";

/** the number of distinct colors (and shapes) for agents in the webview */
export const AGENT_PALETTE = 8;

export interface OverlayAgent {
  name: string;
  /** the index of the color/shape in the webview palette (AGENT_PALETTE mod) */
  color: number;
  /** the names of the DUT ports claimed by the agent */
  pins: string[];
}

export interface OverlayCoverage {
  total: number;
  mapped: number;
  unmapped: string[];
}

/** the state derived from the QuickUVM YAML (the overlay/config message, doc. 05) */
export interface OverlayConfig {
  /** the DUT module name from the YAML (dut.name) or null without a configuration */
  dut: string | null;
  /** the path of the configuration file, for display in the inspector */
  configPath: string | null;
  agents: OverlayAgent[];
  roles: Record<string, PortRole>;
  coverage: OverlayCoverage;
  /** agent ports that no longer exist in the model (orphans, docs/03) */
  orphans: string[];
}

// ------------------------------------------------- cross-probing editor->diagram

/** the target of editor->diagram cross-probing (docs/05, phase 4): the element
 *  under the cursor in the SV source. Instance = the elaborated path (unique); the port belongs to the
 *  module DEFINITION (all its instances carry it); the module = the definition
 *  header. The webview maps the target onto the ids of the current view
 *  (`probeIds`, src/locmap.ts) */
export type XprobeTarget =
  | { kind: "instance"; path: string }
  | { kind: "port"; module: string; port: string }
  | { kind: "module"; module: string };

// ------------------------------------------------ the quick-uvm status decorations

/** the SEMANTIC target of a status decoration (docs/05, phase 4): the webview
 *  maps it onto the ids of the current view (statusIdsRtl/statusIdsTb, src/status.ts).
 *  The messages are in English — the webview is monolingual in the MVP (D19). */
export type StatusDeco =
  | { scope: "port"; port: string; severity: StatusSeverity; message: string }
  | { scope: "agent"; agent: string; severity: StatusSeverity; message: string }
  | { scope: "env"; severity: StatusSeverity; message: string };

export type StatusSeverity = "error" | "warning";

/** the result of the last "Generate testbench" (null = never run) */
export interface GenerateStatus {
  ok: boolean;
  code: number;
  /** the first lines of the error (Pydantic/CLI), for the chip tooltip */
  detail: string;
  /** ISO 8601 — the moment of the run */
  at: string;
}

// ------------------------------------------------------------ host -> webview

export type HostMessage =
  | { v: 1; type: "model/full"; model: ProjectModel }
  | { v: 1; type: "model/stale"; errors: number }
  | { v: 1; type: "layout/full"; sidecar: SidecarData }
  | {
      v: 1;
      /** the parsed QuvmConfig subset, for the verification (TB) view (docs/05);
       *  sent at ready and on any change of the YAML */
      type: "config/full";
      configPath: string | null;
      config: QuvmConfig;
    }
  | ({ v: 1; type: "overlay/config" } & OverlayConfig)
  | { v: 1; type: "view/show"; viewId: string; mode?: ViewMode }
  | ({ v: 1; type: "ui/config" } & UiConfig)
  | { v: 1; type: "select/reveal"; ids: string[] }
  // editor->diagram cross-probing (docs/05): the target under the cursor in the SV
  // source; the webview applies the .xprobe halo on the ids of the current view, without
  // touching the selection; empty list = turn off
  | { v: 1; type: "probe/highlight"; targets: XprobeTarget[] }
  // the quick-uvm status decorations (docs/05): the model<->YAML validations as
  // badges on elements + the result of the last generate as a chip in the header;
  // empty decos = clear, generate null = never run
  | {
      v: 1;
      type: "status/decorations";
      decos: StatusDeco[];
      generate: GenerateStatus | null;
      // docs/07 line 1 — TB element ids (agent:<name>, sb:<name>, probes, vsqr) with
      // no generated code behind them (`genMissing`) or behind the config (`genStale`)
      genMissing: string[];
      genStale: string[];
    }
  // level navigation in the verification (TB) view (D24): opens the level
  // `focus` and, optionally, selects the block `select`
  | { v: 1; type: "tb/navigate"; focus: string; select?: string | null }
  // requests the SVG serialization of the current view (the quickuvm.exportSvg command);
  // the webview replies with export/result
  | { v: 1; type: "export/request" }
  | { v: 1; type: "theme/changed" };

// ------------------------------------------------------------ webview -> host

export type WebviewMessage =
  | { v: 1; type: "ready" }
  | { v: 1; type: "select/changed"; ids: string[] }
  // the point node moves (`node/moved`) were WITHDRAWN from the contract:
  // D21 requires total seeds, so any drag sends `layout/snapshot`
  | {
      v: 1;
      type: "layout/snapshot";
      viewId: string;
      /** the positions of the entire view, in bulk (docs/04: the arrangement is the
       *  user's; without total seeds, interactive ELK re-places the
       *  non-persisted elements otherwise than the full layout) */
      nodes: Record<string, { x: number; y: number }>;
    }
  | {
      v: 1;
      type: "fold/toggled";
      viewId: string;
      foldId: string;
      collapsed: boolean;
    }
  | {
      v: 1;
      type: "node/flipped";
      viewId: string;
      nodeId: string;
      flipH: boolean;
      flipV: boolean;
    }
  | {
      v: 1;
      type: "ports/reordered";
      viewId: string;
      port: string;
      side: Side;
      order: number;
    }
  | { v: 1; type: "edge/override"; viewId: string; edgeId: string; patch: unknown }
  | { v: 1; type: "net/render"; viewId: string; net: string; render: "wire" | "label" }
  // the SELF-CONTAINED SVG of the view (phase 4): inlined styles, viewBox on
  // the content; the host shows a save dialog and writes the file
  | { v: 1; type: "export/result"; viewId: string; svg: string }
  // `mode` accompanies the drill so the host distinguishes the top's symbol
  // (the "top module" root) from its schematic (the instance node) — the same path,
  // different views (docs/05)
  | { v: 1; type: "nav/drill"; instancePath: string; mode?: ViewMode }
  // the webview navigated locally in the verification (TB) view (drill/breadcrumb, D24):
  // the host highlights the level/block in the verification tree
  | { v: 1; type: "tb/focus"; focus: string; select?: string | null }
  | {
      v: 1;
      type: "action/request";
      action: ActionKind;
      args: Record<string, unknown>;
    }
  | { v: 1; type: "relayout/request"; viewId: string; scope: "all" | "new" };
