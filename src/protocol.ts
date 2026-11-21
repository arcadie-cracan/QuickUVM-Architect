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
import type { ResolvedConfig } from "./resolved";
import type { ResultsSnapshot } from "./results";

/** "tb" = the verification (TB) view (phase 3b, docs/05), the key `tb:<config-path>` */
export type ViewMode = "symbol" | "schematic" | "tb";

/** the lasso semantics (docs/05): only the objects fully contained
 *  ("window selection", the default) or also the ones touched ("crossing") */
/** what the selection lasso picks: only the fully enclosed, also the touched,
 *  or — docs/08 R7 — by the drag's direction (left-to-right encloses,
 *  right-to-left touches; the CAD convention) */
export type LassoMode = "contain" | "intersect" | "direction";

/** the UI preferences from the extension settings (the ui/config message) */
export interface UiConfig {
  lasso: LassoMode;
  /** the drawing vocabulary (slash+width on buses, junction dots) is visible;
   *  false = hidden (the quickuvm.schematicDecorations setting, docs/04) */
  decorations: boolean;
  /** docs/08 R20: the generated code follows the selection in the TB view
   *  (the quickuvm.codeFollowsSelection setting; the palette row toggles it) */
  codeFollow: boolean;
  /** docs/08 R6: the zoom below which a multi-node view drops to the overview
   *  level of detail (the quickuvm.lodZoomThreshold setting; 0 = never) */
  lodThreshold: number;
}

/** Actions requested by the webview that touch the YAML or the sources (doc. 05). */
export type ActionKind =
  | "setDut"
  // docs/08 R24 — a bench for the view's module from a template (the host asks which)
  | "newTestbench"
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
  // docs/08 R9: one field on SEVERAL components at once, `{names[], field,
  // value}` — the fields of `MULTI_FIELDS` (src/inspector.ts) only; ONE
  // WorkspaceEdit, so one undo step
  | "editAgents"
  | "editScoreboards"
  // P2: bench-level configuration (RAL + regression)
  | "addRegisterModel"
  | "removeRegisterModel"
  | "editRegisterModel"
  | "toggleRegress"
  | "editRegress"
  | "editCoverage"
  | "editClock"
  | "editReset"
  | "editAgentPort"
  | "addVipAgent"
  | "editSubenvNamespace"
  | "addTest"
  | "removeTest"
  | "editTest"
  | "editBench"
  // slice 3: whitebox probe (K2) from a net selected in the schematic view
  | "createProbe"
  // slice 3: derived composition — H1 connections from the view's nets
  | "wireConnections"
  // docs/08 R11: one hand-drawn connection between two composed blocks
  | "addConnection"
  // docs/08 R22: one `connections` entry removed (the matrix editor's cell
  // toggled off) — `{from, to}`; the destination's agents are left as they are
  | "removeConnection"
  // slice 3: composes the current block + its siblings into the parent bench
  | "composeIntoParent"
  // drill into the composed block: opens the subenv's config with the default
  // editor (per-file TB diagram, slice 4)
  | "openSubenvConfig"
  // docs/08 R4: the "YAML" header button — the configuration as text, beside
  // the diagram, focus kept on the diagram
  | "openConfigBeside"
  // docs/08 R10: a wire from a DUT pin dropped on a pin an agent already claims
  // — the dragged pins join that agent (`addAgentPorts`)
  | "addPinsToAgent"
  // docs/08 R12: the proposals the user CHECKED in the designer-assistance strip
  // (`{items: ProposalApply[]}`), applied in order through the flows above
  | "applyProposals"
  // docs/08 R14: in-place rename `{kind: agent|scoreboard|subenv, name, newName}`
  // — the host validates the identifier and renames with the cascade
  | "renameComponent"
  // docs/08 R15: the element's generated code, BESIDE the diagram (`{id, label}`;
  // the host offers to generate it first when it is missing)
  | "openGeneratedCode"
  // docs/08 R20: the code view follows the selection (a host setting toggle);
  // the traceability report (a markdown document)
  | "toggleCodeFollow"
  | "traceabilityReport"
  // docs/08 R25: the simulation results the diagram shows — the report (a
  // read-only document), a re-read of the results directory, and the source
  // line a report came from (`{file, line}`, as the simulator printed it)
  | "showResults"
  | "refreshResults"
  | "openResultSource"
  // docs/08 R8: the configuration in the TEXT editor — from the per-file editor
  // its own tab is reopened as text (`vscode.openWith … "default"`), from the
  // panel the active configuration opens beside; no args
  | "openConfigAsText"
  // docs/08 R8: the empty state's next action when there is no design model —
  // the host's `quickuvm.setTop` input box; no args
  | "setTop";

// ------------------------------------------- "what will this generate" (R15)

/** the card of one TB element (`card/request` -> `card/full`): the YAML entry it
 *  stands for (the R4 map), the files it owns in the generated bench (the cached
 *  manifest — never a generator run) and the representative file to open */
export interface ElementCard {
  id: string;
  /** the element's own YAML entry, verbatim; null = no entry of its own */
  yaml: string | null;
  files: { file: string; exists: boolean }[];
  /** absolute path of the file "Open generated code" opens; null = none yet */
  primary: string | null;
  /** `ok` = the files come from the cached manifest; `unavailable` = no manifest
   *  (quick-uvm < 1.1.0, an invalid config); `inactive` = this document is not
   *  the active config, whose manifest it is — the card says which */
  manifest: "ok" | "unavailable" | "inactive";
}

// ---------------------------------------------- designer assistance (R12)

export type ProposalKind = "agent-iface" | "agent-group" | "connections" | "materialize";

/** one proposal of src/proposals.ts: an existing host action with its arguments
 *  filled in (`materialize` rows are applied together, see ProposalApply) */
export interface Proposal {
  /** stable: `iface:<port>`, `group:<prefix>`, `connections`, `ghost:<node id>` */
  id: string;
  kind: ProposalKind;
  label: string;
  detail?: string;
  action: ActionKind;
  args: Record<string, unknown>;
}

/** the proposals of ONE view (`proposals/full`): the webview shows the strip
 *  only while it displays that view */
export interface ProposalSet {
  viewId: string;
  mode: ViewMode;
  items: Proposal[];
}

/** what the strip sends back: the checked proposals; the `materialize` item
 *  carries the ghost ids to KEEP — the unchecked inferred components become
 *  absent once `analysis:` is written (docs/07) */
export interface ProposalApply {
  kind: ProposalKind;
  args: Record<string, unknown>;
  accept?: string[];
}

// ---------------------------------------------------- the layout sidecar

/** the position (and the fold/flip state) of a node, owned by the
 *  user (docs/04); x/y may be missing on nodes with other overrides
 *  but not yet moved */
/** docs/08 R21 — the tint of a node, a frame or a note: a NAME from the theme's
 *  chart palette (never a raw colour, so it follows the theme) */
export type AnnotColor = "blue" | "green" | "yellow" | "orange" | "red" | "purple";

export const ANNOT_COLORS: readonly AnnotColor[] = [
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
];

/**
 * docs/08 R21 — a FRAME: a titled box drawn around its members. It stores WHO
 * is in it, never a rectangle: the box is derived from the members' positions
 * on every draw, so it survives a re-arrangement, a collapse or a resize, and
 * dragging it is dragging its members. A member id that is not in the view
 * (deleted, renamed outside the diagram, a broken build) is inert, not removed.
 */
export interface SidecarFrame {
  title: string;
  color?: AnnotColor;
  /** node ids, boundary-flag ids and note ids (`note:<n>`) of the same view */
  members: string[];
}

/** docs/08 R21 — a sticky note: free text at a position of the view */
export interface SidecarNote {
  x: number;
  y: number;
  text: string;
  color?: AnnotColor;
}

/** the longest frame title / note text kept (the SAME limits on both sides: a
 *  host that cut what the webview kept showed the cut only after a reload) */
export const ANNOT_TITLE_MAX = 80;
export const ANNOT_NOTE_MAX = 2000;

/** docs/08 R21 — the secondary notation of ONE view, as the webview edits it
 *  (`colors` live on the node entries in the file) */
export interface ViewAnnotations {
  frames: Record<string, SidecarFrame>;
  notes: Record<string, SidecarNote>;
  colors: Record<string, AnnotColor>;
}

/** docs/08 R23 — what a filter rule does to the elements it matches */
export type FilterEffect = "show" | "hide" | "dim" | AnnotColor;

/** docs/08 R23 — one rule of a view: effect x kind x name pattern */
export interface FilterRule {
  effect: FilterEffect;
  /** an element kind of the view ("agent", "instance", …); absent = any */
  kind?: string;
  /** a regular expression on the element's name, case-insensitive; absent = any */
  name?: string;
}

/** docs/08 R23 — the filter rules of ONE view: presentation only, never model */
export interface ViewFilters {
  rules: FilterRule[];
  /** the rules are kept but not applied (the "lift all" switch) */
  off?: true;
}

export interface SidecarNode {
  x?: number;
  y?: number;
  /** docs/08 R21 — the node's tint (a view annotation, like the position) */
  color?: AnnotColor;
  /** generated folds (RTL): absent = folded (the default), false = expanded.
   *  TB blocks (docs/08 R18): true = collapsed to the header, absent = expanded. */
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
  /** docs/08 R18 — the nc / ignored pins of this RTL view are hidden (absent = shown) */
  hidePins?: true;
  /** the level-4 override (docs/04): wire <-> label per net; absent =
   *  the suggestion from the model (render computed from fan-out) */
  nets?: Record<string, { render: "wire" | "label" }>;
  /** docs/08 R21 — secondary notation: annotations of the VIEW, never of the
   *  verification model (decision D26); keyed `frame:<n>` / `note:<n>` */
  frames?: Record<string, SidecarFrame>;
  notes?: Record<string, SidecarNote>;
  /** docs/08 R23 — the view's filter rules (hide / dim / colour by kind and
   *  name): presentation over the same scene, like the positions */
  filters?: ViewFilters;
}

/** orphan override: the key disappeared from the model (graceful invalidation) */
export interface SidecarOrphan {
  view: string;
  node: string;
  value:
    | SidecarNode
    | { render: "wire" | "label" }
    | SidecarFrame
    | SidecarNote
    | ViewFilters;
  /** the kind of the orphan key; absent = node (compatibility) */
  kind?: "net" | "frame" | "note" | "filters";
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
  | { kind: "module"; module: string }
  // docs/08 R4 — the caret in a `*.quickuvm.yaml` text editor: the TB element
  // whose entry contains it (src/yamlmap.ts), lit on the verification view when
  // its node is on the current level — a halo, never a navigation
  | { kind: "tb"; id: string; focus: string };

// ------------------------------------------------ the quick-uvm status decorations

/** the SEMANTIC target of a status decoration (docs/05, phase 4): the webview
 *  maps it onto the ids of the current view (statusIdsRtl/statusIdsTb, src/status.ts).
 *  The messages are in English — the webview is monolingual in the MVP (D19). */
/** docs/08 R3 — a repair the webview can offer for a finding: the SAME host
 *  action a palette button would send, with its args already filled in. The
 *  host confirms destructive ones (deleteComponent) exactly as it does today. */
export interface StatusFix {
  label: string;
  action: ActionKind;
  args: Record<string, unknown>;
}

export type StatusDeco =
  | { scope: "port"; port: string; severity: StatusSeverity; message: string; fixes?: StatusFix[] }
  | { scope: "agent"; agent: string; severity: StatusSeverity; message: string; fixes?: StatusFix[] }
  // docs/08 R3 — an analysis endpoint that names no agent of the config: the
  // scoreboard / coverage box gets a broken input and an error badge
  // `name` is the entry as written (`sbd` when unnamed); `key` is the diagram id
  // suffix (`sbd#2` on a repeated name), absent when the entry is not drawn
  | { scope: "scoreboard"; name: string; key?: string; severity: StatusSeverity; message: string; fixes?: StatusFix[] }
  | { scope: "coverage"; agent: string; severity: StatusSeverity; message: string; fixes?: StatusFix[] }
  | { scope: "env"; severity: StatusSeverity; message: string; fixes?: StatusFix[] };

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
      /** docs/08 R18 — the composed children's parsed configs, by subenv NAME
       *  (`subenvs[].name`), for the hover preview of a `sub:` box; absent in
       *  the per-file editor (it has no ConfigService) */
      children?: Record<string, QuvmConfig>;
      /** docs/07 — the effective topology from `quick-uvm resolve` (>= 1.1.0), which
       *  is what lets the view draw the components the generator INFERS and the YAML
       *  never mentions. Travels with the config it describes on purpose: a separate
       *  message could interleave and pair ghosts with the wrong bench. Absent when
       *  quick-uvm is older or the config does not resolve — then nothing is ghosted. */
      resolved?: ResolvedConfig | null;
      /** docs/07 P3c — the agents of each composed child, keyed by subenv name. A
       *  cross-block scoreboard's endpoints are `<subenv>.<agent>`, and the child's
       *  agents live in another file, so they cannot come from `config`. */
      childAgents?: Record<string, string[]>;
      /** docs/08 R8 — the YAML does not parse (a syntax error, or a top level
       *  that is not a mapping): `config` is only what could be read. The view
       *  says so in its banner and offers the text editor. Absent/null = valid. */
      parseError?: { message: string; line: number | null } | null;
    }
  | ({ v: 1; type: "overlay/config" } & OverlayConfig)
  | { v: 1; type: "view/show"; viewId: string; mode?: ViewMode }
  | ({ v: 1; type: "ui/config" } & UiConfig)
  // docs/08 R12: the designer-assistance proposals of the view the host shows
  // (src/proposals.ts); sent with the view, the model, the overlay and the
  // config, so the strip follows every change; an empty list clears it
  | ({ v: 1; type: "proposals/full" } & ProposalSet)
  | { v: 1; type: "select/reveal"; ids: string[] }
  // editor->diagram cross-probing (docs/05): the target under the cursor in the SV
  // source; the webview applies the .xprobe halo on the ids of the current view, without
  // touching the selection; empty list = turn off
  | { v: 1; type: "probe/highlight"; targets: XprobeTarget[] }
  // docs/08 R15 — the answer to `card/request`: what this element will generate
  | ({ v: 1; type: "card/full" } & ElementCard)
  // the quick-uvm status decorations (docs/05): the model<->YAML validations as
  // badges on elements + the result of the last generate as a chip in the header;
  // docs/08 R25 — the results of the last regression, READ from the files it
  // left under `<outputDir>/out` (never run by the extension): per element, by
  // diagram id. `results: null` = nothing to show (never simulated, hidden, or
  // another bench's); `stale` = the configuration changed after at least one
  // of the runs; `covStale` = the coverage summary is older than the runs or
  // than the configuration; `unparsed` = runs counted by verdict only
  | {
      v: 1;
      type: "results/full";
      results: ResultsSnapshot | null;
      at: number | null;
      stale: boolean;
      covStale: boolean;
      unparsed: number;
    }
  // the quick-uvm status decorations (validations + the last generate):
  // empty decos = clear, generate null = never run
  | {
      v: 1;
      type: "status/decorations";
      decos: StatusDeco[];
      generate: GenerateStatus | null;
      // docs/07 line 1 — TB element ids (agent:<name>, sb:<name>, probes, vsqr) with
      // declared but not yet saved (`genUnsaved`), no generated code behind them
      // (`genMissing`), or generated from an older config (`genStale`)
      genUnsaved: string[];
      genMissing: string[];
      genStale: string[];
    }
  // level navigation in the verification (TB) view (D24): opens the level
  // `focus` and, optionally, selects the block `select`
  | { v: 1; type: "tb/navigate"; focus: string; select?: string | null }
  // requests the SVG serialization of the current view (the quickuvm.exportSvg command);
  // the webview replies with export/result
  | { v: 1; type: "export/request" }
  | { v: 1; type: "theme/changed" }
  // the sidebar inspector's drawing gestures, forwarded by the host (see the
  // `relay/*` block in WebviewMessage): same names, same payloads, other direction
  | { v: 1; type: "relay/flip"; nodeId: string; axis: "h" | "v" }
  | { v: 1; type: "relay/fold"; foldId: string }
  | { v: 1; type: "relay/netRender"; net: string }
  | { v: 1; type: "relay/selectPins"; names: string[] }
  // docs/08 R18 — the sidebar's "Collapse to header" / "Expand", relayed like a flip
  | { v: 1; type: "relay/collapse"; nodeId: string }
  | { v: 1; type: "relay/openTb" };

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
  // docs/08 R18 — a TB block collapsed to its header (per level, like a flip)
  | {
      v: 1;
      type: "node/collapsed";
      viewId: string;
      nodeId: string;
      collapsed: boolean;
    }
  // docs/08 R18 — an RTL view's nc / ignored pins hidden (a view-level state)
  | { v: 1; type: "view/pins"; viewId: string; hidden: boolean }
  // docs/08 R21 — the secondary notation of a view (frames, notes, node
  // colours), sent WHOLE after every annotation gesture: the set is small, a
  // whole replace needs no per-gesture message and makes undo one message
  | ({ v: 1; type: "view/annotations"; viewId: string } & ViewAnnotations)
  // docs/08 R23 — the filter rules of a view, whole (`rules: []` clears them)
  | ({ v: 1; type: "view/filters"; viewId: string } & ViewFilters)
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
  // docs/08 R15 — the hover card asks what a TB element will generate; the host
  // answers with `card/full` from the config text and the cached manifest
  | { v: 1; type: "card/request"; id: string }
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
  | { v: 1; type: "relayout/request"; viewId: string; scope: "all" | "new" }
  // ---------------------------------------------------------------- relayed
  // The inspector lives in the SIDEBAR, which has no canvas. Its drawing gestures
  // are sent to the host, which forwards them to the panel; the panel applies them
  // against ITS current view, which is why none of these carry a viewId — the
  // sidebar must not be able to move a view the user is not looking at. With no
  // panel open they are dropped.
  | { v: 1; type: "relay/flip"; nodeId: string; axis: "h" | "v" }
  | { v: 1; type: "relay/fold"; foldId: string }
  | { v: 1; type: "relay/netRender"; net: string }
  | { v: 1; type: "relay/selectPins"; names: string[] }
  // docs/08 R18 — the sidebar's "Collapse to header" / "Expand", relayed like a flip
  | { v: 1; type: "relay/collapse"; nodeId: string }
  | { v: 1; type: "relay/openTb" };
