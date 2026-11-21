# 05 — Views, UI flows and the extension↔webview protocol

## The views

The extension has three views: two of the RTL design (the symbol and the
schematic, described below) and one of the verification configuration (the
verification view, phase 3b — see the end of the section).

## The two views of the design

Terminology (decision D18): the views carry the names established in EDA, in
English — **Symbol view** („vederea-simbol", historically „vederea de
context", the context view) and **Schematic view** („vederea-schemă",
historically „vederea de interior", the interior view), as in
Verdi/Vivado/DVT. The terminology is adopted in full: UI, protocol
(`ViewMode: symbol | schematic`), commands
(`quickuvm.openSymbolView`/`openSchematicView`), code
(`src/webview/schematic.ts`) and documentation.

**The symbol view (Symbol view)** — a module as a rectangle with the pins on
its sides (inputs left, outputs right, clock/reset grouped bottom-left). It is
the view in which the QuickUVM configuration is done, because the QuickUVM unit
of work is exactly this: a DUT and its ports. Visual encoding: the width on the pin
(`din[15:0]`, a slashed line for a bus), the interfaces as thick pins
(colour + hatching — never colour alone, for accessibility), the unpacked
arrays with the multiplicity shown separately from the element width.

**The schematic view (Schematic view)** — the instances of a module and the
interconnect; a breadcrumb for going up. The instances show the effective parameters (`chan #(W=16)`);
the generated instances with the same module+parameters are folded by default
(`ch[0..2]`), expandable on request.

**The descent gesture (uniform, by target, not by view):** a double-click on
a block = "go into it" — the schematic if the instance has one, and at the
leaves the module's source itself (the descent continues naturally into the
implementation); in the symbol view, the symbol is the block of the current
instance, so a double-click switches to its schematic. `Ctrl`+double-click =
the module's source, anywhere. A double-click on a pin = the port's
declaration; on a fold = expansion.

Level-of-detail: above a threshold of visible pins, the groups with a common
prefix (`axi_*`) become foldable automatically.

**The verification view** (phase 3b, decision D16) — the diagram of the TB
environment derived from the QuickUVM YAML. Slice 1 (read-only) is specified
here; the editing (palette, connecting with the mouse, deletion with
confirmation) adds its messages here as well, at implementation time.

- **The view's key**: `tb:<config path relative to the workspace>` (e.g.
  `tb:demo_top.quickuvm.yaml`); the display mode: `ViewMode: "tb"`.
  The positions/flips live in the sidecar under this key, with all the
  existing mechanics (drag, the D21 total snapshot, ⟲, interactive ELK);
  graceful invalidation does NOT touch the `tb:` views (their keys come from
  the YAML, not from the RTL model — their validation is added together with
  the editing).
- **A model on levels** (D24, revised Jul 2026): the scene is **flat per
  level** (`src/webview/tbscene.ts` → `TbScene` with `focus` + `breadcrumb`;
  layout+drawing in `src/webview/tbschematic.ts`, isolated from the RTL view).
  Every block is a **UML box** (name + the stereotype `«active agent»` +
  text compartments with the internal structure), interconnected, with
  **boundary flags** for the connections that cross the level (like `<port>`
  in RTL). A block with structure (`drill`) opens on a **double-click**,
  descending one level. The levels (`focus`): `""` testbench (DUT + Env), `env`
  (agents, scoreboards, coverage, vsqr, subenvs, probes; boundaries = the DUT
  interface), `agent:<name>` (sequencer/driver/monitor with their
  interconnections; boundaries = if/ap/sqr). The active agent shows
  sequencer+driver+monitor in the "components" compartment and, on a drill,
  their real blocks connected (sqr→sequencer→driver→if; if→monitor→ap); the
  passive one only the monitor. A subenv = a UML box with config/params (the
  drill into another config is deferred).
- **Flat layout**: ELK layered (like the schematic view), FIXED_POS ports on
  the grid, FIRST/LAST_SEPARATE flags, the shared A* router with the nodes as
  obstacles; the positions rounded to the grid of 8. **Drag + positions** like
  the RTL schematic view, keyed **per level** (`tb:<config>|<focus>` — the node
  ids repeat between agent levels), with interactive ELK seeds, D21 total
  (the flags included) and the ⟲ button; a clickable breadcrumb for going up,
  the "Design" button in the header returns to the design views (RTL).
- **Navigation** (D24): webview → host `tb/focus {focus, select?}` (a local
  drill/breadcrumb — the host keeps the current level and highlights in the
  verification tree); host → webview `tb/navigate {focus, select?}` (a reveal
  from the tree: it opens the level + selects). The diagram↔tree
  synchronization is done on the identity `<focus>|<block>` (the tree and the
  scene share the levels and the ids).
- **Protocol**: host→webview `config/full {configPath, config, resolved?,
  parseError?}` — the parsed QuvmConfig subset (agents, analysis,
  virtual_sequences, probes, subenvs, connections), sent at `ready` and on
  every change of the YAML (like `overlay/config`); `view/show {viewId:
  "tb:…", mode: "tb"}`. `parseError` (docs/08 R8) is `{message, line}` when
  the YAML does not parse — `config` is then only what could be read; see
  "Invalid configuration and empty states" below.
- **`resolved` — the effective topology** (Aug 2026): the output of `quick-uvm
  resolve` (>= 1.1.0), from which the view draws the **inferred** components
  (the ghosts — see docs/07). It travels on the SAME message as `config`, never
  on one of its own: a re-render landing between two messages would pair one
  bench's ghosts with another's configuration. Since it comes from a
  subprocess it is never awaited on the render path — the message carries
  whatever is cached (at most one edit behind), and a completed `resolve`
  re-posts `config/full` to every surface showing that config (panel, sidebar,
  and the per-file editor, which subscribes to `ResolveService.onDidChange`
  for its own uri). Absent (or `null`) on an older quick-uvm or for a
  configuration that does not resolve: then no ghost is drawn, never a broken
  diagram.
- **Editing — adding** (slice 2, Jul 2026): in QuickUVM the connections are
  NOT free edges — `source`/`monitor` are fields, so "add" creates the
  component already connected. The "Add component" palette in the inspector
  (the selected agent preloads the source) sends `action/request` with
  `addScoreboard {source?}`, `addCoverage {agent?}`, `addVirtualSequence`;
  the host completes it through QuickPicks (source/monitor/match, agent, mode +
  agents) and applies the yamlops mutation (`addScoreboard`/`addCoverage`/
  `addVirtualSequence`) as a `WorkspaceEdit`; the re-sent `config/full`
  re-renders the diagram.
- **Editing — deletion and properties** (slice 2, Jul 2026):
  `deleteComponent {kind, name}` (kind ∈ scoreboard | coverage | vseq |
  agent | probe) — three paths to the same gesture: the Delete button in the
  inspector, the `Delete`/`Backspace` key on the selected component and the
  context menu (right-click); the host confirms **modally** (for an agent,
  `detail` summarizes the cascade) and applies `removeScoreboard`/`removeCoverage`/
  `removeVirtualSequence`/`removeAgent`/`removeProbe`.
  `editScoreboard {name, field, value}` edits inline (one `WorkspaceEdit`
  per field) through `setScoreboardField`.
- **Context menu in the RTL views** (from the quick-wins validation, Jul 2026):
  a right-click offers the target's actions — on a **child block** in the
  schematic: "Open schematic" (only if it has a schematic), "Go to source" (the
  module's definition), "Flip horizontal/vertical"; on a **fold**: "Expand
  group" + "Go to source" (the members share the same module — the folding
  criterion — so the definition is opened through the first member,
  `g_ch[0..2].u_ch` → `g_ch[0].u_ch`; + Flip), and on an expanded member
  "Re-fold group"; on a **pin or boundary flag**: "Go to source" (the port's
  declaration — the same owner resolution as on a double-click); on **the
  symbol view's block**: "Go to source". On the background and on targets
  without actions (the pins of folds) the native menu remains. A right-click on
  an element outside the selection selects it (the editors' convention, as in
  TB); closings: Escape, a pointerdown outside, zoom and **the webview losing
  the focus** (`blur` — a click in Design Hierarchy / the editor produces no
  pointerdown in the iframe, so `blur` is the only way to close the menu).
- **The temporary wire** (docs/08 R10/R11, Oct 2026): a press on a port's
  hotspot starts a dashed orthogonal wire that follows the pointer; the DROP
  decides, and every rule of what a drop means lives in the pure module
  `src/webview/wiring.ts` (`wireOriginOf` / `wireTargets` / `wireChoices` /
  `wireChoicesOnCanvas` / `rtlWireChoices`, `npm run test:wiring`). Hotspots: in
  the TB view a transparent disc (`.tb-porthit`, `data-port` / `data-node`) at
  the tip of every TLM port of a non-ghost box; in the RTL views the `.pin`
  groups (the symbol's pins, a child block's pins in the schematic — NOT the
  boundary flags: a drag on a flag moves it, docs/04; not clock/reset/ignored
  pins, nor pins an agent already claims — port-claimed is an error — and, in
  the schematic, not the label inside the block, which keeps dragging the
  block). Drop on EMPTY canvas → a filtered menu at the drop point (R10): from an
  agent's `<ap>` → "Scoreboard fed by X" / "Coverage on X" — the latter only
  while X has no collector — (`addScoreboard {source}` / `addCoverage {agent}`;
  the webview keeps a `pendingDrop` and the next `renderTb` of the same layout
  key places the first node of that kind that was NOT in the scene before
  (ghosts excluded: a declared scoreboard may take a ghost's id) at the drop
  point, over any stale seed under the same id, then pins the whole view
  through `layout/snapshot` — total seeds, D21); from a scoreboard's `source` / `monitor` → the legal agents
  (`editScoreboard`); from a DUT pin → "Agent from pin X" / "Agent from the N
  selected pins" (`createAgentFromPins {pins, viewId}`; the selection travels
  only when the origin is part of it) / "Agent from interface X"
  (`createAgentFromIface`). Drop on a LEGAL target (R11) → ONE outcome applies
  directly, several open the menu: `<ap>` on a scoreboard box or input →
  `editScoreboard {name, field: source|monitor, value: agent}`; a scoreboard
  input on an agent → the same retarget; a DUT pin on a pin an agent already
  claims (the overlay colors it — the symbol view) → `addPinsToAgent {agent,
  pins, viewId}`. Legality is computed ONCE at the press and shown before the
  drop (`.drop-ok` / `.drop-bad` on boxes and hotspots, the reason as a hint
  under the pointer and as the toast of an illegal drop): already an endpoint,
  source ≠ monitor, an unnamed or duplicate-named scoreboard (endpoints are set
  BY NAME — the first entry of that name), a cross-block scoreboard (edit `<subenv>.<agent>` in Properties), a ghost
  (nothing in the YAML), a coverage collector (one agent each). The nearest
  legal hotspot within 20 px snaps. Escape, the webview's `blur` and a press
  outside the canvas cancel. TB only: a plain click on a hotspot ARMS
  click-click mode (the wire follows the pointer until the next press — R11's
  keyboard/touch fallback); in RTL a click on a pin keeps selecting it. NOT
  wired by the gesture yet: `connections` between subenvs (they need a host
  action with the children's widths — "Wire connections from design" stays in
  the inspector).
- **Designer assistance** (docs/08 R12, Oct 2026): a strip between the header
  and the canvas (`#assist`) lists the host's proposals (`proposals/full`) with
  checkboxes, "Apply" and "Dismiss" — never automatic (Vivado's Designer
  Assistance, SmartDesign's Auto Connect). Apply sends `applyProposals` with the
  checked rows; in the verification view the rows are the inferred ghosts and the
  button reads "Write analysis" — the checked ones are kept, the unchecked ones
  will no longer be generated (the strip says so). Dismiss hides THAT set for the
  view until the proposals change (session state, keyed by the set's signature;
  an applied set is treated the same, so a render before the host's next set does
  not re-show it). What the apply created is flashed once on the next render
  (`.flash`: the newly claimed pins in the symbol, the new boxes in the TB view —
  the ids drawn before the apply are remembered, the difference lights up).
- **In-place rename** (docs/08 R14, Oct 2026): F2 on the selected component,
  a double-click on the box's TITLE (the `.tb-name` text takes pointer events
  for this; the body still drills) or "Rename… (F2)" in the context menu opens
  an `<input>` over the SVG title — StarUML's Quick Edit, Blueprints' F2. Enter
  applies; a bad name (not an SV identifier, a keyword, a name an agent /
  scoreboard / subenv / probe already uses) is flagged live and keeps the
  editor; Escape cancels; leaving the field with a change applies. One resolver
  (`tbRenameTarget`, next to `tbDeleteTarget`) decides what can be renamed:
  agents, named scoreboards, subenvs — a ghost, an unnamed scoreboard and the
  derived names (coverage `<agent>_cov`, the aggregates) cannot; nor can a VIP
  reference (`from_vip` — its name is the manifest's) or a duplicate subenv
  name. A scoreboard is addressed by ORDINAL (`id: sb:x#2` travels with the
  action), so a duplicate renames its own entry. The webview sends
  `renameComponent {kind, name, newName, id?}` and, on the render that shows
  the new id, carries the sidecar positions of the renamed ids (`agent:` + its
  `cov:` and `<if>.` flag, `sb:`, `sub:`) and an agent's own level
  (`tb:<config>|agent:<name>`) to the new ids through `layout/snapshot` — the
  box keeps its seat — and moves the selection (deferred on purpose: a refused
  rename leaves no orphan entries). The host renames with the cascade
  (`renameAgent`: coverage bare or rich, scoreboard endpoints bare and
  `<agent>.<port>`, vseq steps, `tests[].sequence.agent`, `connections`
  endpoints of a boundary agent, `register_model.bus_agent`, the agent's own
  `<name>_if` / `<name>_seq_item` when conventional; `renameScoreboardAt`;
  `renameSubenv`: `connections` and cross-block endpoints) and reports the
  references updated.
- **Inline widgets on the boxes** (docs/08 R13, Oct 2026): the two or three
  facts a bench is tuned by sit ON the box, under its compartments, as pills
  (`TbNode.widgets`, built in `buildTbScene`; sized and drawn in
  `tbschematic.ts`): `active` / `passive` on an agent (a toggle), `match: …`
  (a cycle in_order ↔ out_of_order) and `latency: …` (a small number editor,
  empty = unbounded, at least 1 cycle — quick-uvm refuses 0) on a NAMED
  two-stream scoreboard — a single-stream entry has neither fact, an unnamed or
  duplicate-named one (`sb:x#2`) cannot be edited by name, a ghost has nothing
  in the YAML, a VIP reference (`from_vip`) takes no keys. The `match` pill
  shows the `match_key` with the mode and its tooltip says the step to in_order
  drops it (the `setScoreboardField` cascade). A bad number (a stray `e`, a
  fraction, 0) is flagged, keeps the editor on Enter and cancels on blur. A
  click sends the SAME host action the Properties panel would
  (`editAgent {name, field: active, value}` / `editScoreboard {name, field,
  value}`), so the panel and the box stay in sync through the YAML. The
  accidental-edit rule of the research: a widget takes pointer events only
  while its box is SELECTED (the first click selects, the second acts), the
  second click of a double-click is ignored (`e.detail > 1`) and a double-click
  on a widget does not drill. No protocol change.
- **"What will this generate"** (docs/08 R15, Oct 2026): a 450 ms dwell on a
  TB box opens a card beside it (`.gencard`, a DOM overlay; `I` on the selected
  box PINS it until Escape / `I` / a render): the element's own YAML entry
  (`<pre>`), its generation state as the badges say it (● new / U not generated /
  M modified / ✓ generated), the files it owns in the generated bench with their
  LIVE on-disk flags (✓ / ○; an agent's internal shows the agent's file of that
  part, a coverage box its `<agent>_cov.svh`, a level box the aggregates), and
  two actions — "Open generated code beside"
  (`openGeneratedCode {id, label}`; disabled while the manifest or the files are
  unknown) and "Show YAML beside" (`openConfigBeside {id}`). A ghost's card says
  it is inferred and asks nothing. The data is requested on demand
  (`card/request` → `card/full`, one per dwell) and cached until the YAML or the
  generation state changes; the host answers from the config text and the
  CACHED manifest — the generator is never run for a card. The card leaves with
  the pointer (onto the card itself it stays, for its buttons), on a press, on a
  wheel and on every render (it is anchored to a box that is redrawn).
- **Action palette** (docs/08 R17, Oct 2026): Ctrl+Space / Ctrl+/ (or the
  "Actions" header button) opens a palette — the find box's UI, `.findbox.palette`
  — of the actions that are LEGAL right now, recent ones first (GLSP's command
  palette, Figma's quick actions): the selected element's own actions (the
  context menu's items — `tbMenuItems` / `rtlMenuItemsFor`, the ONE list behind
  both surfaces —, the R1 "+" tools, the R13 widgets' steps, the R15 card), the
  Properties panel's ENABLED buttons (the panel is rendered into a detached
  element with every section open — `InspectorCtx.allOpen` — and its `button.btn`
  rows are collected under their heading, so the enabling rules stay in one
  place), the applicable assistance proposals (not the ghosts: those are
  all-or-nothing in the strip), and the view / config commands. Every row runs
  exactly what its surface would — the same host action, the same confirmations
  —; the palette adds no gesture of its own, and shows display names, never ids.
  Typing filters with the Ctrl+F ranking (`findMatches`); with no query the
  recent actions come first (`rankPalette` / `pushRecent` in `navfind.ts`,
  recency persisted in the webview state as `paletteRecent`). Enter runs,
  Escape closes, the arrows move. No protocol change.
- **The connections wire** (docs/08 R11, the composition half, Oct 2026): a
  `sub:` box draws its child's agent ports (from `config/full.children`) — the
  block's OUTPUTS (what its agents sample) on the east, its INPUTS (what its
  agents drive) on the west, each with a small filled square (`signal`, a
  glyph that is not TLM but gives the port a hotspot); the pins a `connections`
  entry already names keep their seat, a block whose config the host could not
  read shows only those. A press on an output starts a wire whose legal targets
  are the OTHER blocks' inputs — free (one driver per input), of the same width
  when both are known (`subPortWidth` reads the children) — lit before the drop
  with the reason on the rest; the reverse drag (from an input) targets the
  outputs, and an input already driven starts no legal wire ("remove that
  connection first"). A drop on a port writes ONE entry, on a box its legal
  ports (one applies directly, several as a menu), on the canvas every legal
  port of every other block:
  `addConnection {from, to}` (`from` = the output, `to` = the input, whichever
  end the drag started at). The host checks it again in the pure
  `singleConnection` (`src/compose.ts`, `test:compose`: a block OUTPUT to
  another block's INPUT, one driver, a width mismatch or an unreadable child =
  a warning, still wired — quick-uvm decides) and writes it through the same
  multi-file plan as "Wire connections from design" (`applyWirePlan`:
  `connections` on the top + the destination's agents set passive in their
  file, one WorkspaceEdit, previewed per R19 when more than one file changes).
  The rules live in `src/webview/wiring.ts` (`sub-port` origin, `test:wiring`).
  From the adversarial review: the glyph is PROVENANCE — a cross-block
  scoreboard's endpoint pin is an AGENT name drawn for its edge and gets no
  glyph (no hotspot, no origin, no target), and a readable child's unknown
  port is neither; a width the child cannot state (`width_param`,
  `packed_dims`, `struct`, `type`) is unknown, never 1 (no false block); a
  duplicate-named subenv shares the origin's name-keyed pins and is never a
  target; the canonical `src`/`dst` connection keys are mirrored into
  `from`/`to` by `parseQuvm`, so the "one driver per input" rule and the
  scene see them. The gesture lives in the diagram PANEL: the per-file editor
  has no children's configs (no agent ports on its `sub:` boxes) and answers
  an `addConnection` with a message, not a write.
- **Collapse, hide, preview** (docs/08 R18, Oct 2026): three view-state
  gestures, none of which touches the YAML. (1) A TB block **collapsed to its
  header** — `C` on the selection, "Collapse to header (C)" / "Expand (C)" in
  the context menu, the palette and the inspector: the box keeps its title,
  stereotype and ports (the wires still connect, re-routed by the A* router),
  the compartments and the inline widgets are not drawn, the title ends in `⋯`;
  `layoutTb` sizes it from `boxSize(n, measure, collapsed)` and marks
  `TbPlaced.collapsed`; persisted per level in the sidecar through
  `node/collapsed`, like a flip (`setCollapsed`, `test:sidecar`; the height in
  `test:tblayout`). (2) An RTL view's **nc / ignored pins hidden** — `Ctrl+H`
  (plain `H` is the flip since phase 3, so the row's "H" became `Ctrl+H`) or the
  palette's View row: in the schematic the child pins annotated `nc` go
  (`pruneNcPins` in `scene.ts`, pure, `test:scene` — an nc pin has no edge and no
  net, so nothing else refers to it), in the symbol the DUT ports whose overlay
  role is `ignored`; the boxes shrink in place (the seeds keep the positions),
  persisted per view through `view/pins`. (3) A **hover preview** of a composed
  child: `config/full.children` carries the children's parsed configs by subenv
  name (one parse with `childAgents`, in `ConfigService.loadChildAgents`; absent
  in the per-file editor), and a 450 ms dwell on a `sub:` box draws the child's
  bench at its env level (`buildTbScene` + `layoutTb`, laid out once per child
  and cached until the next `config/full`) scaled into a `<g>` above the box
  (below it when there is no room) — drawn with the TB drawer but stripped of
  `data-id` and of pointer events, so nothing in it is a hit target, a badge
  owner or a selection; it closes on leave, on a press, and on every render,
  and the async layout is applied only while the pointer is still on that box
  and the config has not changed since (`subHoverId`, `subPreviewGen`). The
  child is drawn without its `resolve` (the ghosts of an implicit child are
  not shown). The harness has `?compose=1` (two subenvs with their children).
  Three rules from the adversarial review: a toggle on an un-seeded view first
  pins it (`pinViewIfUnseeded` — the D21 total snapshot), or the next render
  would be a full ELK pass; a waived port an agent still claims (the
  `ignored-and-mapped` error) or any port with a finding is never hidden; the
  sidebar Properties view relays its button as `relay/collapse {nodeId}`, like
  `relay/flip`. The symbol and the schematic of one instance share the
  `hidePins` flag (one view key).
- **Declared / Common / All inspector** (docs/08 R16, Oct 2026): the agent,
  scoreboard and port editors of the Properties panel are structured by the
  PROVENANCE of each field — the third rule of the pure `src/inspector.ts`
  (`fieldGroups` + the `AGENT_SPEC` / `SCOREBOARD_SPEC` / `PORT_SPEC`
  defaults from the schema reference §1.5–1.6, `test:inspector`), next to
  relevance and rarity. "Declared" lists the keys present in the component's
  YAML mapping, in the editor's order, the ones relevance would hide last — a
  declared key is always shown, since it is in the file and the generator will
  refuse it; the label is bold when the value differs from the generator's
  default, and ⟲ removes the key (the existing `editAgent` / `editScoreboard` /
  `editAgentPort` actions with the empty value — `active` through its own op,
  a port width through `1`; a port boolean's "" now deletes the key too; a key
  another key requires — `request_valid` under `mode: responder`, `reorder_by`
  under `respond: pipelined`, `match_key` under `match: out_of_order`, the
  window's length — has no ⟲, the enabling key resets instead and its ⟲ names
  the cascade). The
  declared keys the editor has no control for (`interface`, `sequence_item`,
  `packed_dims`, …) are read-only rows with the value summarised. "Common"
  holds the relevant rows the YAML does not declare, their control dimmed and
  the default as the placeholder — shown, never written; "All" (the former
  "Advanced" disclosure, same persisted key) the rare ones. The ports section
  stays open (the row's own rule), each port's declared and common rows open
  and its rare ones under "All". The third provenance of the row — derived
  from the model — is not surfaced: the TB webview has no model widths (the
  overlay carries pin names only), and a width that disagrees with the design
  is already a validation finding with its quick fix. No protocol change.
- **Generated code next to the diagram** (docs/08 R20, Oct 2026): the
  selection in the TB view drives the generated code, and the generated code
  leads back to the view. Probed on quick-uvm 1.1.0: the generated files carry
  NO element anchor (only `// This File:` / `// Generated by: QuickUVM`), so
  element ↔ OWNED file is exact through the manifest (`owner` → files, docs/07
  Track A, inferred elements included), and element ↔ lines of an AGGREGATE
  file (env, tb_top, base_test, env_cfg, virtual sequencer, tb_pkg) is
  approximate: a word-bounded pattern on the element's name and on the stems of
  its owned files finds the derived identifiers (`cmd_agnt`, `cmd_if_inst`,
  `cmd_cov_h`, `pkt_sb`, `yapp_buffer_scoreboard`) — `tracePattern` /
  `traceLines` in the pure `src/trace.ts` (`test:trace`); an identifier that
  continues a name into ANOTHER element's name or stem, or into a whole-config
  stem, is refused (`cmd` does not light `cmd_rsp_agnt`, an agent `yapp` on
  DUT `yapp_buffer` does not light `yapp_buffer_env`). Host side
  (`src/trace-service.ts`): on `select/changed` with ONE TB element the lines
  light (whole-line, the range-highlight colour) in the VISIBLE generated
  editors that are aggregate files of the active bench — an owned file IS the
  element, nothing to point at — and the first is revealed (only on a
  selection: a tab opening or a manifest refresh re-lights without scrolling);
  with `quickuvm.codeFollowsSelection` the element's primary file (for
  `cov:<a>` and the agent internals, its first owned file) also opens in a
  PREVIEW tab beside the diagram, focus kept (the next selection replaces it —
  HDL Coder's Code view, with VS Code's preview tabs enabled); off by default,
  nothing opens a tab without the user's say-so. The reverse direction is a
  CodeLens in every generated file under the output dir: an owned file gets one
  at its top ("↖ agent cmd in the verification view" →
  `quickuvm.revealTbComponent`; the agent's `<a>_cov` file points at its
  coverage node), an aggregate file one per element at its first mention (the
  coverage collectors included; a cross-block scoreboard resolves to its
  `xsb:` node at the root); an element `quick-uvm resolve` reports as inferred
  — scoreboard, vseq, coverage — reads "inferred by quick-uvm, not in the YAML":
  the row's "untraceable" list, which the report also prints
  (`quickuvm.traceabilityReport`: a read-only virtual `quickuvm-trace:` markdown
  document, rendered through the markdown preview — declared elements with
  their files and on-disk flags, the inferred ones, the whole-config files).
  The per-file editor drives the trace only when its document IS the active
  config (the manifest is its), and re-posts `ui/config` on the settings
  change like the panel. Two benches sharing one `quickuvm.outputDir` share
  the lenses too: a generated file names no config, so it is read against the
  ACTIVE bench's manifest.
- **Diff preview before a gesture** (docs/08 R19, Oct 2026): a DESTRUCTIVE
  gesture (`deleteComponent` with its cascade, the covergroup downgrade,
  `removeTest`, `removeRegisterModel`, the regression block while tests set
  `seeds`) and a MULTI-FILE gesture (`wireConnections`: the top's `connections`
  plus the children's agents set passive; `createSubenv` when it creates block
  configs) can be previewed as a diff before they are applied. The mutation runs
  on the target's current text first (`TbEditTarget.readText`), so what the
  preview shows is byte-for-byte what the WorkspaceEdit would write; the host
  opens one `vscode.diff` tab per changed file between two virtual
  `quickuvm-preview:` snapshots served by `PreviewProvider` in
  `src/previewdiff.ts` — the live buffer's text (an unsaved buffer diffs
  against what the user sees) and the mutation's; a created file diffs against
  an empty "before" —, then asks with a QuickPick that stays open while the
  tabs are read (`ignoreFocusOut`; a modal would block them, and a
  notification toast auto-hides with its promise pending), closes the tabs
  whichever way the question is answered, and treats every tab closed by hand
  as a cancel. The apply is refused when the document changed meanwhile. The setting
  `quickuvm.previewEdits`: `ask` (default — the existing modal gains a "Preview
  changes" button; a multi-file gesture gets a modal with the per-file summary),
  `always` (the preview opens first), `never` (the modal as before; multi-file
  gestures apply directly). A single-file, non-destructive gesture is never
  previewed, and a multi-file gesture whose effect lands in ONE file stays
  immediate. The summary line (`top.quickuvm.yaml (+6 -0), chan.quickuvm.yaml
  (+1 -1)`) comes from the pure `src/preview.ts` (`test:preview`), counted
  line-wise the way the diff editor counts the hunk. No protocol change: the
  webview sends the same actions.
- **Level of detail on zoom** (docs/08 R6, Nov 2026): below
  `quickuvm.lodZoomThreshold` (default 0.5 — a zoom of 50 %; 0 switches it
  off) the schematic and the verification views draw the OVERVIEW: boxes,
  titles, wires, boundary flags, junctions and the status / generation badges
  (a problem is never hidden). Pin labels, net labels, connection notes, the
  bus decorations, the module subtitle, the compartment text, the stereotypes,
  the TB port labels and the inline widgets are not drawn, and each box's
  title is enlarged until it fills its box (capped at 3x) and centred in it —
  the compartments are gone, so the room is free. It is ONE attribute,
  `data-lod="low"` on the root `<svg>`, and CSS rules behind
  `#canvas[data-lod="low"]`: no re-layout and no re-render, so no box moves
  when the level changes. `lodFor` (`src/webview/navfind.ts`, pure,
  `test:navfind`) adds hysteresis — the view returns to full detail only above
  threshold x 1.15, so a wheel hovering at the threshold does not flicker —
  and `titleUpscale` fits a title to its box; the fit is measured once per
  render and per switch to the overview, never per pan/zoom frame, and applied
  by CSS through a `--lod-title` variable on the title. The threshold travels
  on `ui/config.lodThreshold` (the setting is capped at 2: the level is left
  only above threshold x 1.15 and the zoom stops at 5). The hysteresis is PER
  VIEW — a view entered fresh decides from the threshold alone, whatever level
  the previous view was at. Whatever is MEASURED from the DOM depends on the
  level (a hidden label is outside a box's bounds), so a level change re-places
  the status / generation badges and re-centres the chip signs. At the
  overview level the enlarged title takes no pointer events: it covers most of
  its box, and a double-click there must stay the DRILL, not the in-place
  rename (F2 still renames). The symbol view is exempt (it is nothing but
  its pin labels, and it always fits the window). A selected or cross-probed
  pin and a selected net label keep their text. The SVG export always carries
  full detail: the bounds are taken with the level lifted, and the export
  clone has no canvas id, so no `#canvas[data-lod]` rule reaches it.
- **Marquee modifiers and arrangement** (docs/08 R7, Nov 2026): the lasso's
  modifiers are read at the press — none replaces the selection, **Shift**
  adds, **Ctrl** toggles (unchanged: it is what Ctrl+click does to one
  element, and one modifier must not mean two things), **Ctrl+Shift**
  subtracts. The row's "Ctrl subtracts" did not become Alt: a webview forwards
  its key events to the workbench, where Alt pressed and released around a
  mouse-only gesture reads as "Alt alone" and focuses the menu bar on Windows
  and Linux (found at the review, in the VS Code sources — not run; Alt is
  ignored by the lasso). `quickuvm.lassoMode` gains
  a third value, `direction`: dragged left-to-right the rectangle is a window
  (only what it fully encloses), right-to-left a crossing (also what it
  touches) — the CAD convention; a crossing rectangle is drawn long-dashed, a
  subtracting one in the error colour. A multi-selection of blocks and flags
  can be ARRANGED: align on the left / right / top / bottom edge or on a
  centre line of the common bounding box (the line is pinned to the largest
  block sitting on the grid, so the operation is idempotent — a raw
  bounding-box centre moved when the snapped result was measured again),
  distribute with equal gaps (three or more; the two outermost stay; blocks
  that overlap, which have no even spacing, are left alone), and straighten
  the wires — each block wired
  to an already-placed one is moved vertically until the two pin centres are
  level, starting from the block the menu was opened on (from the palette: the
  leftmost of each wired group). Straighten never stacks blocks: a move that
  would land on another box, with one grid step of air, is refused and the
  block stays (two agents in one column feeding one scoreboard cannot both get
  a straight wire). The gestures are one row of icons at the top of the
  context menu opened on a member of the selection, and the "Arrange" group of
  the action palette (R17) — one list, `arrangeActions`. No new message: each
  gesture is one position-undo entry and ONE `layout/snapshot` with ALL the
  view's positions (D21), exactly like a drag end; a gesture with nothing to
  move posts nothing and says so in a toast. The geometry is pure
  (`src/webview/arrange.ts`, `test:arrange`).
- **Multi-selection editing** (docs/08 R9, Nov 2026): with two or more
  components selected in the verification view, the Properties panel shows
  the fields they have in common instead of the first component's editor —
  one group per kind with two or more EDITABLE components (a ghost, a VIP
  reference, an unnamed or duplicate-named scoreboard are left out, as the
  single editor leaves them without an edit). A field shows the shared value,
  or "mixed" when the components differ; the value compared is the EFFECTIVE
  one, so an undeclared key and a hand-written default agree. Choosing a value
  sets it on all of them: `editAgents` / `editScoreboards {names, field,
  value}` fold the single edit's mutation over the names into one text change
  — one WorkspaceEdit, one undo step. The bulk fields are deliberately few
  (`MULTI_FIELDS` in `src/inspector.ts`): agents `active` and
  `seq_item_style`, scoreboards `max_latency`. `mode: responder` needs a
  `request_valid` port of that agent and `match: out_of_order` a `match_key`
  of that scoreboard; set in bulk they would leave configurations the
  generator refuses and no validation finding reports. `multiGroups` is pure
  (`test:inspector`); the action palette offers "Set N agents passive /
  active" as one-shot rows. The Properties sidebar mirrors the PANEL's
  selection and the active configuration, so in a per-file editor the
  multi-selection edit is reached through those palette rows.
- **Secondary notation** (docs/08 R21, Nov 2026; decision D26): frames, sticky
  notes and node colours — annotations of the VIEW, on the schematic views and
  on every level of the verification view, kept in the layout sidecar (docs/04)
  and never in the YAML. **Frame**: `Shift+G` (or "Frame the selection" in the
  context menu / the palette; plain `G` fits the selection) puts a titled box
  around the selected blocks, flags and notes and opens its title for typing.
  Not `Ctrl+G`: a webview forwards every keydown to the workbench whatever it
  does with it, and `Ctrl+G` is "Go to Line" there with no `when` clause — the
  quick input took the focus and committed an empty title (found at the review,
  in the VS Code bundle; not run). The box is derived from its members; its
  title tab is its only hit target (a lasso can start on the empty area inside
  a frame) and is drawn ABOVE the blocks, so a block lying over the title band
  cannot cover it; dragging the tab moves the members. A block or a note
  dragged INTO a frame's box joins it (entering — one already inside, taken out
  with "Remove from frame", does not rejoin on a nudge); "Remove from frame"
  takes it out;
  double-click or `F2` renames, `Delete` removes the frame (its members stay).
  **Note**: `N` (at the centre of the view) or "Add note here" on the
  background's context menu opens a text field — the note exists once it has
  text; `Enter` is a new line, `Ctrl+Enter` or a click elsewhere commits,
  `Escape` discards; double-click or `F2` edits, an emptied note is deleted,
  `Delete` removes it. A note is dragged like a block, alone or with the
  selection. **Colour**: a row of six named dots (and "no colour") at the top of
  the context menu of a block, a frame or a note, and as "Color: …" rows in the
  palette (the name is the tooltip and the accessible label — never colour
  alone). All of it is ONE message, `view/annotations {viewId, frames, notes,
  colors}`, carrying the view's whole set after each gesture, and one entry of
  the same history as the moves: `Ctrl+Z` brings back a deleted note or frame
  (an annotation-only step restores no position, so undoing a colour does not
  pin an un-arranged view). The text field of a note or a title is anchored in
  the diagram and follows the camera; a re-render under it leaves it open, and
  only a change of view closes it — committing to the view it was typed on.
  Because the message is a whole replace sent from the sender's own copy of
  the sidecar, the host re-posts `layout/full` to every OTHER surface showing
  the file (the panel and a per-file editor share the `tb:` keys): without it,
  the other surface's next gesture wrote its stale copy back and deleted the
  note. Frames and notes are in the diagram's `Ctrl+F`; a frame none of whose
  members is on screen has no tab and is offered for deletion in the palette.
  A rename (R14) carries the memberships and the colours to the new ids (and
  drops the view's undo history, whose entries hold the old ids); the
  SVG export includes frames and notes; at the overview level of detail (R6) a
  note keeps its box and loses its text. The data rules are pure
  (`src/webview/annotations.ts`, `test:annotations`; the sidecar side in
  `src/sidecarops.ts`, `test:sidecar`), the drawing is
  `src/webview/annotations-view.ts`.
- **Matrix editor** (docs/08 R22, Nov 2026): a many-to-many relationship as a
  TABLE over the canvas of the verification view — the palette's "Matrix: …"
  rows, and a "Matrix" header button once a matrix reaches about 4x4 (below
  that the canvas says it better). Two matrices, each derived from the
  configuration on every `config/full` (`src/webview/matrix.ts`, pure,
  `test:matrix`): **agents x scoreboards / coverage** — one row per endpoint a
  scoreboard can name (this bench's agents, then the composed children's
  `<subenv>.<agent>`), a `source` and a `monitor` column per scoreboard, and a
  last column for the covered agents; and, on a composition, **block outputs x
  block inputs** — a cell is a `connections` entry, the ports coming from the
  children's configurations (`config/full.children`, so the panel only). A
  cell is a button that already holds the host action its click sends, the
  SAME actions the canvas gestures and the Properties panel send:
  `editScoreboard` (a source is MOVED by clicking another row and never
  cleared; a monitor is set, and cleared by clicking it — single-stream again,
  `match` and `match_key` go with it; the two are different agents),
  `addCoverage` / `deleteComponent {kind: coverage}` (the removal keeps its
  confirmation), `addConnection` (with its legality and its multi-file plan)
  and the new `removeConnection {from, to}`. A cell that cannot be toggled is
  disabled, hatched, and its tooltip says why in the generator's terms (same
  block, one driver per input, unequal widths — an UNKNOWN width is not a
  reason; an unnamed or duplicate-named scoreboard; a child's coverage, which
  belongs to its own file). On an implicit-mode bench (no `analysis:` key) the
  analysis matrix is read-only: declaring one component there would drop the
  inferred ones — the proposal strip materialises the set first. A cell
  whose click also removes something the user did not point at is marked
  (`!`) and says so in its tooltip: a monitor set on a scoreboard that has a
  `window` drops the window (a window is single-stream only). The table
  stays open across the edit and is rebuilt when the YAML comes back, keeping
  the focus where it was (the toggled cell, a tab) — but only while the
  diagram has the focus: a rebuild caused by typing in the YAML never takes
  the focus from the text editor. `Escape` closes it, from inside the table
  and from the canvas, and no key typed in it reaches the diagram. A child
  configuration whose port lists cannot be read contributes no rows.
- **Per-view filter rules** (docs/08 R23, Nov 2026): `effect x kind x name
  pattern` — **hide**, **dim**, **show** or a colour, on the elements of one
  kind (or any), whose name matches a case-insensitive regular expression (or
  any) — per view (per level in the verification view), in the layout sidecar.
  The kinds are the view's own: `instance` / `iface` / `fold` / `port` in a
  schematic; `agent`, `scoreboard`, `coverage`, `vsqr`, `probes`, `subenv`,
  `unit`, `dut`, `env`, `port` in the verification view. The FIRST rule that
  matches an element decides its visibility, so an exception is written above
  the rule it carves into (`show ^cmd$` above `hide agent`); the first colour
  rule that matches decides its tint, independently, and a colour given by hand
  (R21) wins over a rule's. It is presentation over the SAME scene: classes on
  the drawn elements, no layout pass — a hidden block keeps its place, and a
  wire is hidden or dimmed WITH one of its ends, never on its own. Because
  hidden wires are hidden dependencies, three things are fixed: rules exist
  only because the user wrote them; the header shows a chip for as long as the
  view has rules — "Filters: 3 hidden, 1 dimmed", "Filters: no match", "Filters
  off (2 rules)" — and a click on it opens the editor; and an element with a
  finding is never hidden, it is dimmed instead (the diagram never hides a
  problem; in a design view a finding on any PIN of a block protects the
  block). What a rule hides cannot be selected — not by a click, the lasso,
  Ctrl+F or a reveal from the tree, which says so instead — and is not in the
  SVG export. The editor is a small dialog under the header: one row per rule
  (effect, kind, pattern — applied while typing, sent to the host when the
  typing pauses —, how many elements of this view it matches or why the
  pattern cannot run, up / down, delete). A pattern is at most 200 characters
  and is refused, before it is ever run, when it is a repeated group that
  itself repeats or alternates (`(a+)+`, `(a|aa)*`): such a pattern can take
  exponential time, on every render, from a file that is shared. A colour
  rule matches only what can show a tint (not a flag, not an inferred ghost).
  The editor follows the view: after a drill it shows the new level's rules.
  Its buttons:
  "+ Add rule" (which starts on the kind of the selected block, never on
  "everything"), "Lift all (keep the rules)" and "Delete all rules". From the
  canvas: "Filter: hide this block" and "Filter: dim every <kind>" on a block's
  context menu, "Filters…" and "Lift all filters" on the background's and in
  the palette. One message, `view/filters {viewId, rules, off?}` (the whole
  list; the host sanitises it and re-posts `layout/full` to the other surfaces,
  as for the annotations); the rules are pure (`src/webview/filters.ts`,
  `test:filters`; the sidecar side in `test:sidecar`). The SVG export shows
  what the view shows, filters included. The row's "depth slider" is not
  implemented: since D24 a diagram shows ONE level and the drill is its depth
  control — there is no second level in a scene to fold away (a block's own
  detail is R18's collapse-to-header).
- **"New Testbench…" templates** (docs/08 R24, Nov 2026): the command
  `quickuvm.newTestbench` — the Design Hierarchy's title bar and row menu, the
  "New testbench…" button of the Properties panel (the `newTestbench {viewId}`
  action, so the palette has it too) — builds a whole bench for a module from
  one of three starting points. Each is a FOLD of the existing text mutations
  over the skeleton of a new configuration (`src/templates.ts`, pure,
  `test:templates`; generated for real in `test:e2e`), so a template writes
  what the gestures would have written one by one — the same readable YAML,
  no key nobody asked for:
  **one agent per interface** — the DUT section by heuristic (`dutGuess`, the
  one "Set as DUT" uses), then the R12 proposals: an agent per interface port
  and per pin group; a module whose names offer neither gets ONE agent for its
  whole boundary (`<module>_a`);
  **one agent per clock domain** — for a module with two or more clock inputs:
  a `clock:` LIST with one domain per clock port (named after the port, as the
  generator assumes), one agent per domain carrying the pins that bear the
  domain's TAG (`src_clk_i` → `src_*`, `wclk` → `w*`; an untagged `clk` is the
  default domain and takes what no tag claims), each with its `clock:`; the
  resets as a `reset:` LIST bound to the clocks — always a list, even for one
  shared reset (with a clock list quick-uvm generates no reset from the plain
  mapping) — and, when the resets are per domain, a `reset:` on each agent. A
  clock's enable / gate / select (`clk_en_i`) is not a clock; `aresetn` /
  `rstn` are active low;
  **composition from the sub-blocks** — the direct sub-blocks as `subenvs`
  (the top a combinational shell, `layout: packaged`), one block configuration
  per MODULE with a boundary agent (`<module>_a`: composed blocks share one
  namespace) — an existing block configuration is never recreated —, and the
  inter-block connections the design draws, through the plan of "Wire
  connections from design" (the destination's agents go passive). No `params:`
  are passed: the block configuration uses the elaborated widths.
  The QuickPick shows all three, each with what it WOULD create or why it does
  not apply to this module. The plan is confirmed before a file exists, in
  every `previewEdits` mode (`confirmGesture` kind `create`): what it creates,
  what it LEFT OUT (pins without a name group, ports it does not guess — ref /
  unsized / unpacked —, a reset it could not bind), and the files as a diff on
  request. It never overwrites: an existing `<module>.quickuvm.yaml` is offered
  to be opened instead. The new configuration becomes the active one.
- **Signals view** (docs/08 R24): a third tree in the sidebar
  (`quickuvm.signals`, collapsed by default) — a "Clocks" and a "Resets" group
  with the declared domains and, under each, the agents on it (`src/signals.ts`,
  pure, `test:signals`; the provider is `src/signals-view.ts`). With ONE clock
  or reset (a mapping) every agent is on it and there is nothing to assign.
  Under a domain LIST, an agent with no `clock:` / `reset:` of its own is in an
  **Unconnected** folder, and each such agent says where the generator puts it
  (`→ <domain>`; probed on quick-uvm 1.1.0 and locked in `test:e2e`, one key at
  a time): a clock — the FIRST domain of the list (not the one `dut.clock`
  names); a reset — the one RELEASED ON THE AGENT'S CLOCK, and only without
  such an entry the first. An agent naming a domain that is not declared is
  shown there too, with what it says. Under a single clock or reset an agent
  that carries the key anyway is flagged: the generator refuses it (the single
  clock's own name is `clock.name`, default `clk` — not the DUT's clock port).
  A single reset next to a clock LIST is marked "NOT GENERATED": quick-uvm's
  multi-domain path reads only a reset list, so the bench would have no reset
  at all (the per-clock template therefore always writes a list, even of one
  entry). **Drag an agent onto
  a domain** to assign it — the TARGET decides the key (a clock domain writes
  `clock:`, a reset domain `reset:`); onto Unconnected, the key is removed. A
  multi-selection is one edit (`assignDomain`, one WorkspaceEdit). Refused with
  a message: a single clock or reset, a VIP reference (its clocking is the
  VIP's), a domain that is not declared. A click on an agent reveals it in the
  verification view; the groups carry an inline "+" (`quickuvm.addClockDomain`
  / `addResetDomain`, the Properties panel's own flows).
- **Simulation results on the diagram** (docs/08 R25, Nov 2026): what the
  last regression left on disk, shown on the blocks of the verification view.
  The extension runs NO simulator and waits for none: it READS the files
  QuickUVM's generated Makefile writes under `<outputDir>/out` —
  `runs/<test>.<seed>/{status, test.txt, seed.txt, sim.log}` and
  `cov/summary.txt` (imc's text summary) — when they change (a watcher on the
  `status` files and the summary: what a finished run writes last), on
  "Refresh Simulation Results", and when the configuration or the resolved
  topology changes (the attribution depends on the element names; the files
  are not re-read for that, and a run whose files did not change is not parsed
  again). The parsing and the attribution are pure (`src/results.ts`,
  `test:results`, on logs of real Xcelium runs).
  **The verdict of a run is its `status` file and nothing else.** The Makefile
  writes it after the simulator exits, so a run without one is in flight (or
  was stopped): "without a verdict", exactly as the Makefile's own summary
  skips it — its half-written log is never judged. Reports are folded by KIND
  while the log is read (severity, reporter, id, source line; a log of a
  hundred thousand mismatches is a handful of entries, and nothing of its text
  is kept in memory). Only the report server's output is trusted: its report
  lines and its "Report counts by severity" block — not the report catcher's
  "caught" numbers, which are 0 on a failing run.
  **Attribution** is by the reporter's hierarchical PATH first: the
  generator's instance names follow from the configuration (probed per mode on
  quick-uvm 1.1.0): `<agent>_agnt[.drv|.mon|.sqr]` (a sequence reports as
  `sqr@@<sequence>`), a named scoreboard by its name, an unnamed or inferred
  one as `sbd`, a declared collector as `<agent>_cov_h` and the implicit
  mode's as `cov`, `vsqr`, `probe_mon`, a sub-environment by its name, and —
  on a bench whose one agent is replicated or instantiated —
  `<handle>_agnt` / `<handle>_sb`. A path that names nothing known, or is not
  under the test at all (`reporter`), goes to the OWNER of the report's source
  file (the generation manifest), and only then to the environment: a report
  is never dropped, and never matched by a pattern on its text.
  One message, `results/full {results, at, stale, covStale, unparsed}` (host →
  panel, whole, on every change; `results: null` = nothing to show). On the
  level on screen (`levelResults`): a count pill at a block's bottom-right
  corner — `✕ n` for errors and fatals, `! n` for warnings alone — with the
  block's outline in the severity's colour; the pill's tooltip lists the
  folded messages (at most 12 kinds, the WORST kept: a late fatal is not
  dropped behind earlier warnings), a click opens a menu of them (each opens
  the source line that raised it, looked up by file name under the generated
  bench — the `openResultSource {file, line}` action) and "Open the results
  report"; the click does not select the block. A coverage figure sits at the
  bottom-left of the blocks that have one, worded to fit the block: `cg` on a
  coverage collector, `block` / `expr` / `toggle` on the DUT — summed over the
  DUT's SUBTREE (imc's rows are per instance). A result is drawn on the block
  that REPRESENTS its element on that level: its own block where there is one;
  at the testbench level the Env block carries everything inside it; at an
  agent's level its units carry theirs. What was reported and has NO block on
  the level (the environment's own reports at the Env level, the rest of the
  bench inside an agent) is a second chip in the header — "✕ n not on this
  level" — so no level looks clean because its problems are drawn elsewhere.
  Coverage is never summed upwards. The header shows the runs' VERDICTS
  ("Runs: 3/4 passed, 1 without a verdict"), never an error count; a click
  opens the report — a read-only document (`quickuvm.showResults`, the
  `showResults` action): the runs, every element worst first with its folded
  messages, the coverage figures.
  What makes the picture incomplete is always SAID, never implied:
  **stale** — the configuration has unsaved edits or was saved after the
  OLDEST verdict shown (one fresh run does not vouch for the old ones): the
  chip says "(stale)", the pills are dimmed and dashed, no outline is tinted,
  the report opens with it; **old coverage** (`covStale`) — the summary is
  older than the newest verdict (a later run did not rewrite it: `COV=0`, a
  single `make run`) or than the configuration: the coverage pills are dimmed,
  the chip's tooltip and the report say so; **partial** — a log above 16 MB,
  or runs beyond the first 200, count by verdict only (`unparsed`), and
  reports the simulator counted that could not be read from the log
  (`missed`: a line format the parser does not know) are on no block — both
  on the chip's tooltip and in the report; **another bench's** — the runs say
  which DUT they covered (`-covscope`), and when that is not the active
  configuration's DUT nothing is shown (`quickuvm.outputDir` is one folder for
  the workspace; "Refresh Simulation Results" says whose results they are);
  and **absent** — with no `out/runs` there is no chip and no pill: a bench
  that was never simulated is not a bench that passed. "Hide Simulation
  Results" hides the regression that is there now; another one shows again.
  The result pills are a session's reading, not content: the SVG export leaves
  them out, and a block with a failing result is never hidden by a filter rule
  (R23) — it is dimmed. The per-file editor shows no results (and offers no
  results command): they are the ACTIVE bench's, like the generation manifest.
  Known limits of this slice: the `$finish` line, `-covscope` and the coverage
  summary are Xcelium's and imc's (the UVM report format is the
  simulator-independent part); a run without coverage cannot be told from
  another bench's; a hand-edited generated file is not "stale".
- **The whitebox probe** (slice 3, K2, Jul 2026): a **net** is selected in the
  schematic view → the "Create probe" button in the Net section sends
  `createProbe {net}` (`viewId` is injected by `postAction`). The webview
  computes NOTHING: the XMR path (relative to the DUT instance) and the width
  are derived on the host from the model, in the **pure** module `src/probe.ts`
  (`proposeProbe`), which also refuses with an explicit reason (a subsystem
  bench — H1, an unpacked array, an interface, a port already mapped onto an
  agent, a view outside the DUT). The host asks for the name (validated against
  the reserved names: other probes, agent ports/interfaces, the clock, the
  reset) and optionally `coverage`, then applies `addProbe`.
- **Derived composition** (slice 3, Jul 2026): the "Wire connections from
  design" button (Actions, on a subsystem) sends `wireConnections {}`; the host
  derives `connections: [{from, to}]` from the view's inter-block nets (the
  pure module `src/compose.ts`) and writes them through `addConnections`,
  warning which destination agents must be made passive (`active: false`). A
  gesture separate from "Create subenv" because the wires cable agent interface
  ports (the children must have agents first).
- **Compose into parent bench** (slice 3, Jul 2026): the button in Actions,
  visible on any non-top block, sends `composeIntoParent {}`; the host finds
  the immediate parent bench + its direct child blocks (`parentComposition` in
  `src/compose.ts`, pure) and delegates to `createSubenv` targeting the parent
  (it composes the block + its siblings, with confirmation in a QuickPick). A
  subsystem requires ≥2 subenvs (a quick-uvm constraint), so it is refused when
  the parent has a single composable block.
- **Drill into a subenv** (closing the loose end, Jul 2026): in the TB view,
  a `«subenv»` block with a known `config` is drillable (the ⊟ suffix, the
  drill cursor); a double-click / "Open" (context menu or inspector) sends
  `openSubenvConfig {name}`, and the host resolves `subenvs[].config` relative
  to the current config and **opens the child file with the default editor** —
  that is, Slice 4's TB diagram (a new tab; back = switching tabs). In the
  webview the drill remains a string `config:<name>` on `TbNode.drill`, told
  apart from the local focuses (`env`, `agent:X`) by its prefix; it works
  identically from the panel (the active config) and from the per-file editor
  (the open document, H1's nesting on levels). A subenv without a `config`
  remains a leaf.
- **Entry points** (a gesture that has to be explained is badly designed):
  the **Testbench** button in the header of the design views (visible when
  the active config has something drawable), the "Open
  verification view" button in the inspector's configuration section, the
  hierarchy's context menu (the configuration group, next to "Set as DUT") and
  the `quickuvm.openVerificationView` command in the palette (all of them open
  the view of the active config — a single bench — independently of the
  instance clicked).
- **The verification hierarchy** (the second section of the sidebar,
  "Verification Hierarchy", next to "Design Hierarchy"): the tree of the TB
  environment derived from the config (`src/tbtree-build.ts`, pure, testable;
  wrapped by `src/tbtree.ts`), the mirror of the TB schematic view — env → DUT,
  agents (active/passive with distinct icons), scoreboards, coverage, virtual
  sequencer, subenvs, probes. The ids of the tree's nodes coincide with those
  of the diagram (both derive from `buildTbScene`), so the navigation is
  symmetric without a mapping: a click on a node → `quickuvm.revealTbComponent`
  opens the TB view and selects the component (the `select/reveal` message,
  applied after `view/show`); the selection in the diagram → `select/changed` →
  the host highlights the node in the tree (`onSelection` dispatches on the
  `tb:` prefix). It is populated from `config/full` (the same signal as the
  overlay). From the TB view,
  the "Design" button in the header returns to the last design view visited
  (viewId + mode); the local navigation is announced to the host through
  `nav/drill` (the panel's title stays in sync). The final packaging remains
  `CustomTextEditorProvider` on `*.quickuvm.yaml` (D22).

## The configuration UI flows (summary; the exact mapping in doc. 03)

1. **Set as DUT** (context menu on a block, in the tree or on the diagram) →
   heuristic clock/reset/combinational proposals as chips to confirm.
2. **Create Agent from Selection** (lasso/Ctrl+click on pins) → the agent
   gets a colour; its pins carry it permanently in the overlay. The colour is
   doubled by a shape mark on the pin (accessibility). The gesture's target is
   deduced from the selected pins: the symbol view's pins or the boundary
   flags in the schematic = the ports of the view's module; **the pins of a
   child block** in the schematic = the ports of that block's module — the
   agent is created for the block's config (the block's `viewId` travels in
   `action/request.args`, and the DUT mismatch / missing DUT is resolved on
   the host, in the flow, as for a subenv). A mixed selection (pins from
   different blocks, or pins + boundary) disables the gesture; the blocks in
   the selection are ignored.
3. **Agent from interface** (a click on the interface pin — on the symbol,
   on the boundary flag or on the interface pin of a child block; the same
   deduction of the target).
4. **Create subenv** (the inspector button on the blocks selected in the
   schematic view — instances or folds, expanded into their members — or the
   `quickuvm.createSubenv` command in the palette); a multi-select
   confirmation with the summary of the new block configs and of the H1
   constraints (docs/03).
5. **The coverage indicator** (permanent in the inspector): "N/M ports mapped",
   with the list of the unmapped ports as a checklist; the states per port:
   agent X / clock-reset / explicitly ignored / unmapped.
6. **Generate Testbench** → the `quick-uvm generate` task; errors in Problems.

The native/webview split: tree view, commands, QuickPick, diagnostics, tasks
= native; diagram + configuration inspector = webview (a single panel with an
internal side inspector). A `CustomEditor` on `*.quickuvm.yaml` is the final
packaging of the verification view (phase 3b), not the starting point.

All the configuration actions produce a `WorkspaceEdit` on the YAML (the source
of truth): native undo/redo, a diff in git, simultaneous manual editing. The
reverse direction: when the YAML changes (by hand or by the extension), the
host re-parses and re-sends the overlay.

## The extension↔webview message protocol

JSON, versioned (`v: 1`), typed in TypeScript in a single shared file
(`src/protocol.ts`). Any new message is added here first and in this document.

### host → webview

| type | payload | meaning |
|---|---|---|
| `model/full` | `{model}` | the full model (first load / re-compilation) |
| `model/stale` | `{errors: n}` | compilation failed: keep the model, show the banner |
| `layout/full` | `{sidecar}` | the sidecar's content (doc. 04): `{schema_version, views: {<viewId>: {nodes: {<nodeId>: {x?, y?, collapsed?, flipH?, flipV?}}}}, orphans[]}` — sent at `ready` and on the changes not initiated by the webview (an external edit of the file, graceful invalidation, cleaning the orphans); its own gestures get no echo, the webview has already applied them locally. The webview applies the positions as overrides over the computed layout |
| `overlay/config` | `{dut, configPath, agents[], roles{}, coverage, orphans[]}` | the state derived from the YAML: who the DUT is, the agents' colours, the pins' roles, the coverage |
| `view/show` | `{viewId, mode?}` | navigate to the requested view (from the tree view / the editor); `mode` is optional (`symbol` \| `schematic`) — absent: the webview keeps the current mode (the symbol by default); `schematic` without a view in the model falls back gracefully to the symbol |
| `select/reveal` | `{ids[]}` | highlight elements (synchronization from the editor) |
| `proposals/full` | `{viewId, mode, items[]}` | docs/08 R12 — the designer-assistance proposals of the view the host shows (`src/proposals.ts`, pure, `test:proposals`): `items[]` = `{id, kind, label, detail?, action, args}`, every one an existing host action with its arguments filled in. Kinds: `agent-iface` (a DUT interface port without an agent → `createAgentFromIface {port, name}`), `agent-group` (DUT pins sharing a prefix — the name up to its LAST underscore, a trailing direction token `_i/_o/_io/_in/_out/_n/_ni/_no` stripped first, so PULP `src_valid_i` joins `src` while `valid_i`/`valid_o` make no group — two or more, none claimed, no clock/reset/waived/ref/unsized/unpacked port → `createAgentFromPins {pins, name}`; a lone pin is never proposed, and an agent of the prefix's name that claims nothing makes the group ambiguous → no proposal, the SmartDesign rule), `connections` (a subsystem of ≥2 subenvs whose blocks the design wires but the YAML does not, and whose children already have agents — the wire cables agent ports; ambiguous subenv names or a derivation warning = no proposal → `wireConnections`, through the same `deriveConnections`), `materialize` (on an implicit-mode bench — no `analysis:` key — the components quick-uvm infers, one row per ghost of `src/resolved.ts`). Sent by the panel after `view/show`, `model/full`, `overlay/config`, `config/full` and the drill, and by the per-file editor with its `config/full` (ghosts only — it has no model); an empty list clears the strip. The webview shows the strip only while `viewId` matches the view it displays |
| `card/full` | `{id, yaml, files[], primary, manifest}` | docs/08 R15 — the answer to `card/request`: what a TB element will generate. `yaml` = the element's own entry, verbatim (the R4 map `elementRange` on the document text; null = no entry of its own), `files[]` = `{file, exists}` the element OWNS in the generated bench (the CACHED `quick-uvm manifest`, never a generator run; the aggregates are not listed), `primary` = the absolute path "Open generated code" opens (null = none yet), `manifest` = `ok` / `unavailable` (quick-uvm < 1.1.0, an invalid config — the card says "not resolved" instead of "no files") / `inactive` (the per-file editor's document is not the active config, whose manifest it is). The per-file editor answers from ITS document, with the files only when the document is the active config |
| `probe/highlight` | `{targets[]}` | cross-probing editor→diagram (the converse of the hover, phase 4): the host follows the cursor in the SV sources (debounced) and sends the target under the cursor — `{kind: "instance", path}` \| `{kind: "port", module, port}` \| `{kind: "module", module}`; several targets only for the generated instances on the same source line. **docs/08 R4:** a fourth target kind, `{kind: "tb", id, focus}`, comes from the caret in a `*.quickuvm.yaml` TEXT editor (`elementAtOffset`, `src/yamlmap.ts`, pure, `test:yamlmap`): the verification view lights the box with that id when it is on the current level — panel and per-file editors alike — never navigating. The reverse (a selected box reveals and flashes its YAML entry in the text editors that already show the file) and the per-gesture flash of the changed lines (`onGestureApplied` in `src/config.ts`, from the MINIMAL edit of `src/textedit.ts`, `test:textedit`) are host-side and need no message; the `quickuvm.openYamlBeside` setting (ask once / always / never) decides whether a gesture opens the YAML beside the diagram when no text editor shows it. The webview maps them onto the ids of the CURRENT view (`probeIds` in `src/locmap.ts`, pure) and applies a persistent **cross-probing halo** (`.xprobe`), DISTINCT from the selection — the working selection is not touched. A target absent from the current view = no halo (non-invasive, no navigation); an empty list = turn it off. The explicit navigation is the `quickuvm.revealInDiagram` command (the editor's context menu), which uses `view/show` + `select/reveal` |
| `ui/config` | `{lasso, decorations, codeFollow, lodThreshold}` | the UI preferences from the extension settings, sent at `ready` and whenever they change; `lasso`: `contain` (default — the lasso selects only the objects it fully contains, "window selection") \| `intersect` (also the ones it touches, "crossing selection") \| `direction` (docs/08 R7: left-to-right a window, right-to-left a crossing; the `quickuvm.lassoMode` setting); `lodThreshold` (docs/08 R6): the zoom below which a multi-node view draws the overview level of detail (`quickuvm.lodZoomThreshold`, default 0.5; 0 = never); `decorations`: the drawing vocabulary (slash+width on buses, junction dots) is visible (`quickuvm.schematicDecorations`, docs/04); `codeFollow` (docs/08 R20): the generated code follows the selection in the TB view (`quickuvm.codeFollowsSelection`) — the palette row that toggles it reads its label from here |
| `export/request` | `{}` | asks for the SVG serialization of the current view (the `quickuvm.exportSvg` command in the palette); the webview answers with `export/result` |
| `theme/changed` | `{}` | re-read the CSS variables |
| `relay/flip` | `{nodeId, axis: "h"\|"v"}` | a drawing gesture that came from the inspector in the SIDEBAR, passed on by the host to the panel (see the `relay/*` block under webview→host). The panel applies it to the view IT is showing, as if it had come from its own diagram |
| `relay/fold` | `{foldId}` | ditto: expanding/re-folding a fold |
| `relay/netRender` | `{net}` | ditto: switching a net between wire and label |
| `relay/resetRoute` | `{net}` | the same path, for docs/04 level 3 (D27): "Reset route" in the sidebar's Net section — the panel puts the net's wire group back on the automatic router and sends the `edge/override` patch itself |
| `relay/selectPins` | `{names[]}` | ditto: selecting the pins from the inspector's "unmapped ports" list |
| `relay/openTb` | `{}` | ditto: "Open verification view" |
| `status/decorations` | `{decos[], generate}` | the quick-uvm status decorations (phase 4): `decos[]` = the model↔YAML validations (`checkConfig`) as SEMANTIC targets — `{scope: "port", port}` \| `{scope: "agent", agent}` \| `{scope: "env"}`, each with `severity: "error"\|"warning"` and a `message` (English — the webview is monolingual, D19); the webview maps them onto the ids of the current view (`statusIdsRtl`/`statusIdsTb` in `src/status.ts`, pure) and draws a **badge** ⚠/✕ in the element's corner, with the messages in the tooltip; at the TB root level the agents' problems aggregate onto Env (bubble-up). `generate` = the result of the last "Generate testbench" (`{ok, code, detail, at}` or `null` — never run): a **status chip** in the diagram header (✓/✕ + tooltip). Sent at `ready`, on every re-validation (together with `overlay/config`) and after every `generate`; empty lists = clear. The badges are not part of the SVG export (diagnostic state, not content). **docs/08 R3 (Oct 2026):** `decos[]` also carry `{scope: "scoreboard", name}` / `{scope: "coverage", agent}` (an analysis endpoint naming an agent that does not exist — an error; the box's input is drawn as a broken stub) and an optional `fixes[]` of `{label, action, args}`: the SAME host action a palette button would send, offered on the badge (click), in the context menu and in the Properties panel; the host mirrors the findings on the verification tree through a `FileDecorationProvider` (✕ / !, bubbled up onto Env) and sends `status/decorations` to the sidebar as well. **Nov 2026 (D25):** the `reset-undriven` finding — the DUT's reset driven by nobody, docs/03 — is a `port` deco on the reset pin plus an `env` deco, both carrying its repair: `editReset {op: "set", name, field: "external", value: "true"}` (the testbench top drives the reset) or, where the top cannot (`repair: clear`), `editReset {op: "clear"}` (`dut.reset: ''`). `statusIdsRtl` now passes a port deco's `fixes[]` on to the pin's badge (they used to be dropped in the RTL views). No message was added: `editReset` gained the `clear` op |

### webview → host

| type | payload | meaning |
|---|---|---|
| `ready` | `{v}` | the webview is initialized; the host answers with `layout/full` + `model/full` + `overlay/config` — the sidecar BEFORE the model, so that the first render has the position seeds (otherwise an arranged view would first flicker with the automatic layout) |
| `select/changed` | `{ids[]}` | the current selection (for commands, synchronization towards the editor and highlighting the instance in the hierarchy: the first id that resolves to an instance — directly, prefixed with the current view or as the owner instance of a pin — is selected in the tree view, without focus; with no resolvable id — an empty selection included, on a mode switch or Escape — the current view's instance is highlighted, so that the hierarchy always reflects what the diagram shows) |
| `layout/snapshot` | `{viewId, nodes: {id: {x, y}}}` | the positions of the whole view, in bulk (docs/04): at the end of any drag ALL the current positions are persisted (nodes, folds, boundary flags), not only the dragged elements; on the render of an already arranged view the positions of the elements that had no seed are sent (new elements from a recompilation, fold members, a partial inherited sidecar). Without total seeds, interactive ELK re-places the unpersisted elements differently from the full layout the user saw (a real regression: the port flags jumped on reopening). Host: `setPositions` in the sidecar; no echo. The position undo/redo (Ctrl+Z/Ctrl+Y, docs/04) reuses the same message: every restored step is persisted like an ordinary position gesture |
| `node/collapsed` | `{viewId, nodeId, collapsed}` | docs/08 R18: a TB block collapsed to its header (title, stereotype, ports — no compartments, no widgets) or expanded; `viewId` is the level key `tb:<config>\|<focus>`, like `node/flipped`; the host writes `collapsed: true` on the node in the sidecar (expanded = absent) |
| `view/pins` | `{viewId, hidden}` | docs/08 R18: an RTL view hides / shows its nc (not connected) child pins and its ignored (waived) DUT pins; a view-level override in the sidecar (`hidePins: true`, shown = absent) |
| `view/annotations` | `{viewId, frames, notes, colors}` | docs/08 R21: the secondary notation of a view, sent WHOLE after every annotation gesture (the set is small; a whole replace needs no per-gesture message and makes undo one message). `viewId` is the layout key (the RTL view, or the TB level `tb:<config>\|<focus>`); `frames` = `{"frame:<n>": {title, color?, members[]}}`, `notes` = `{"note:<n>": {x, y, text, color?}}`, `colors` = `{<nodeId>: <palette name>}` (stored on the node entries in the file). The host sanitises it (`setAnnotations`) and does not echo it back |
| `view/filters` | `{viewId, rules[], off?}` | docs/08 R23: the filter rules of a view, whole (`rules: []` clears them). A rule is `{effect, kind?, name?}`: `effect` = `show` \| `hide` \| `dim` \| a palette colour name, `kind` an element kind of the view, `name` a regular expression on the element's name; `off: true` keeps the rules without applying them. `viewId` is the layout key. The host sanitises the list (`setFilters` → `sanitizeFilters`: known effects, trimmed and bounded strings, at most 24 rules), does not echo it to the sender and re-posts `layout/full` to the other surfaces |
| `fold/toggled` | `{viewId, foldId, collapsed}` | expanding/re-folding a generate fold → the host persists the state in the sidecar (`nodes[foldId].collapsed`) |
| `node/flipped` | `{viewId, nodeId, flipH, flipV}` | flipping a block (doc. 04: a reassignment of the pins' sides/order, not a geometric mirroring) → the host persists `nodes[nodeId].flipH/flipV` |
| `ports/reordered` | `{viewId, port, side, order}` | pin override |
| `edge/override` | `{viewId, edges: {<edgeId>: <route> \| null}}` | docs/04 level 3 (D27): the hand-placed wire routes a gesture changed, as a PATCH by edge id — a route in its file form (`source+16 source-40 target-16`: one token per interior segment, the offset of its line from the pin at that end of the edge) or `null` = back to the automatic router. `viewId` is the layout key (the RTL view, or the TB level `tb:<config>\|<focus>`). A patch, not the view's whole set: a wire drag freezes its whole wire group, so the patch names every edge of the group, but an edge it does not name is untouched — another surface's stale mirror cannot delete a route it never saw. Sent at the end of a wire drag, by "Reset wire route" / "Reset route" / "Wires: reset all hand-placed routes", and by an undo / redo step that changes the routes. The host sanitises it (`setEdgeRoutes`: what is not a route removes the override), does not echo it back to the sender, and posts `layout/full` to every OTHER surface showing the file (the panel, a per-file editor, the sidebar), which draw their wires from their own mirror. "Re-arrange all" needs no message of its own: `relayout/request` clears the view's routes with its positions |
| `net/render` | `{viewId, net, render: "wire"\|"label"}` | the level 4 override (docs/04): switching a net between wire and label from the inspector (the net is selected by a click on its route or on its label). The webview has already applied it locally; the host persists `nets[net].render` in the sidecar — a choice equal to the model's suggestion deletes the override; no echo |
| `nav/drill` | `{instancePath, mode?}` | a double-click on an instance in the schematic view: the webview navigates locally (the schematic if the instance has one, otherwise the symbol), the host updates the panel's title, the current view and highlights the instance in the hierarchy; `mode` (D24) tells the top's symbol — a reveal on the synthetic "top module" root — from its schematic — a reveal on the instance's node (the same path, different views) |
| `action/request` | `{action, args}` | actions that touch the YAML or the sources: `setDut`, `createAgentFromPins`, `createAgentFromIface`, `createSubenv`, `ignorePort`, `unignorePort`, `generate`, `openSource`, `addScoreboard`, `addCoverage`, `addVirtualSequence`, `deleteComponent {kind, name}`, `editScoreboard {name, field, value}`, `createProbe {net}`, `wireConnections {}`, `composeIntoParent {}`, `openSubenvConfig {config}` (opens a subenv's config file — the path from `subenvs[].config`, carried by the drill — with the default editor), `openConfigBeside {}` (docs/08 R4: the "YAML" header button — the configuration as text beside the diagram, focus kept on the diagram; the host opens it, or the per-file editor opens its own document), `addPinsToAgent {agent, pins, viewId}` (docs/08 R10: a wire from a DUT pin dropped on a pin an agent already claims — the dragged pins join that agent through the `addAgentPorts` mutation, with the same port derivation as `createAgentFromPins`), `applyProposals {items: [{kind, args, accept?}]}` (docs/08 R12: the proposals the user CHECKED in the assistance strip, applied in order through the flows above — a preset agent name is used only when it is free, not an SV keyword and not a scoreboard/subenv/probe name, otherwise the input box asks; the `materialize` item carries the ghost ids to KEEP and the host writes `analysis:` from the RESOLVED inferred set through `materializeAnalysis` — the whole set at once, the unchecked members absent, `analysis: {}` when nothing is kept: docs/07's two sharp edges), `renameComponent {kind: agent|scoreboard|subenv, name, newName}` (docs/08 R14: in-place rename, validated on the host — an SV identifier, no keyword, free across agents/scoreboards/subenvs/probes — with the cascade of `renameAgent` / `renameScoreboard` / `renameSubenv`; a composed config gets a warning that the parent's `<subenv>.<agent>` references are not updated), `openGeneratedCode {id, label}` (docs/08 R15: the element's generated code BESIDE the diagram, focus kept — the `quickuvm.openGeneratedCode` flow, which offers to generate it first when it is missing), `addConnection {from, to}` (docs/08 R11: one hand-drawn connection between two composed blocks — checked by `singleConnection`, written through the multi-file wiring plan), `toggleCodeFollow {}` and `traceabilityReport {}` (docs/08 R20: the palette's View rows — the host flips `quickuvm.codeFollowsSelection` and re-posts `ui/config`, or opens the traceability report as a markdown document); `openConfigBeside` also takes an optional `id` (R15: the element's YAML entry is revealed and flashed after opening); `showResults {}`, `refreshResults {}` and `openResultSource {file, line}` (docs/08 R25: the results report, a re-read of the results directory, and the source line of a UVM report — the file is looked up by NAME under the generated bench, never resolved as a path), `newTestbench {viewId}` (docs/08 R24: the "New testbench…" button — the host's template QuickPick for the view's module), `removeConnection {from, to}` (docs/08 R22: one `connections` entry removed — the matrix editor's cell toggled off; only the top configuration changes, the destination block's agents stay passive), `editAgents {names[], field, value}` and `editScoreboards {names[], field, value}` (docs/08 R9: one field on several components — only the fields of `MULTI_FIELDS`, only the names the config still has, one WorkspaceEdit); `openConfigAsText {}` (docs/08 R8: the banner's / empty state's "Open as text" — the per-file editor reopens its own tab with the built-in text editor through `vscode.openWith … "default"`, the panel opens the active configuration as text beside) and `setTop {}` (docs/08 R8: the no-model empty state's "Set top module…", the host's `quickuvm.setTop` input box) — the webview NEVER writes files; it asks the host. `openSource` also takes `peek: true` (hover cross-probing, phase 4): the host only **reveals** the declaration in the ALREADY visible editors, with a transient highlight of the line (~1.2 s) — it opens no tab and does not steal the focus; the `quickuvm.hoverCrossProbe` setting (on by default) turns it off |
| `card/request` | `{id}` | docs/08 R15 — the hover card (a 450 ms dwell on a TB box, or `I` on the selected one) asks what the element will generate; the webview caches the answer until the next `config/full` or `status/decorations` |
| `export/result` | `{viewId, svg}` | the SELF-CONTAINED SVG of the current view (phase 4): a clone with the computed styles inlined (the colours of the VSCode theme are copied into the export — the external CSS with `var(--vscode-*)` does not travel), a `viewBox` on the content (without the session camera), the background baked in from the current theme. Emitted on the ⤓ button in the header or as the answer to `export/request`; host: save dialog + writing to disk |
| `relay/flip` \| `relay/fold` \| `relay/netRender` \| `relay/resetRoute` \| `relay/selectPins` \| `relay/openTb` | `{nodeId, axis}` \| `{foldId}` \| `{net}` \| `{net}` \| `{names[]}` \| `{}` | **the drawing gestures of the sidebar inspector** (Jul 2026). The inspector NO longer sits in the panel: the `#inspector` aside was REMOVED, and the "Properties" view in the sidebar is the only inspector — from there, a flip/fold/net-render has no canvas to act on, so they are sent to the host, which re-sends them to the panel (the same names, the opposite direction). **None of them carries a `viewId`**: the panel applies them to the view it is showing, deliberately — the sidebar must not be able to move a view the user is not looking at. With no panel open they are lost, which is correct: their only effect is what gets drawn |
| `relayout/request` | `{viewId, scope: all}` | "Re-arrange all" (the ⟲ button / docs/04): the webview has deleted the view's positions locally and gone back to the full ELK layout; the host deletes the positions (x/y) from the view's nodes in the sidecar **and the view's hand-placed wire routes** (docs/04 level 3, D27: they describe the arrangement being discarded; the webview dropped them from its mirror too, and its undo step holds them) — the folds and the flips stay; no echo. `scope: new` is reserved (new elements are inserted automatically, by interactive ELK) |

### The `overlay/config` payload (detailed in phase 2)

- `dut`: the name of the DUT module from the YAML (`dut.name`) or `null` with
  no configuration;
- `configPath`: the path of the YAML file, for display in the inspector;
- `agents[]`: `{name, color, pins[]}` — `color` = the index into the webview's
  palette of 8 colours+shapes (accessibility: the shape doubles the colour);
  `pins` = the names of the DUT ports claimed by the agent;
- `roles{}`: port → `clock` | `reset` | `ignored` (the clock/reset from `dut.*`,
  the ignored ports from `x_quickuvm_architect.ignored_ports`, decision D15);
- `coverage`: `{total, mapped, unmapped[]}` over the plain ports of the DUT
  module; the interface ports are configured through "Agent from interface"
  and are not counted (MVP);
- `orphans[]`: ports present in the YAML but absent from the model — they are
  marked, not deleted (graceful invalidation).

Protocol rules: the messages are idempotent where possible; the host is the
only authority over files (YAML, sidecar); the webview can be rebuilt entirely
from `model/full` + `layout/full` + `overlay/config` (a testable property:
kill + restore must give the same image).

## Graceful degradation and special states

- a failed compilation → `model/stale`, the last model stays interactive;
- a port in the YAML that the model does not have → the pin is marked
  "orphan" in the overlay, plus a diagnostic;
- a selection on folded elements (`ch[0..2]`) → the actions apply to the whole
  fold or ask for it to be expanded, explicitly;
- a project without Bender → the file list comes from the settings (a glob or
  a `.f` file).

### Invalid configuration and empty states (docs/08 R8, Nov 2026)

`*.quickuvm.yaml` opens as a DIAGRAM by default (the per-file editor), so a
file the diagram cannot draw needs a one-step route to its text.

- **A configuration whose YAML does not parse.** `config/full.parseError` is
  `{message, line}` — the parser's FIRST error (the later ones are usually its
  echoes), without the parser's own "at line N, column M" tail, or "the top
  level must be a mapping" for a file that is a list or a scalar
  (`quvmParseError` / `docParseError` in `src/yamlops.ts`, pure,
  `test:yamlops`). The same field reports valid YAML whose SHAPE no reader of
  a config can walk: a section that must be a list of mappings (`agents`,
  `subenvs`, `connections`, `probes`, `virtual_sequences`, `tests`,
  `analysis.scoreboards`) that is not a list, or an entry that is not a
  mapping — a bare `-` typed as the start of a new entry parses, to `null`
  ("agents: entry 2 is empty", with its line). Behind it the view has a wall
  of its own: a scene builder that throws is caught, the canvas is cleared and
  the banner says the file has an entry the diagram cannot read — before, the
  PREVIOUS diagram stayed on screen with no banner and gestures acted on boxes
  the file no longer had. `config` still carries what could be read, and the view
  draws it; the banner says that the diagram is partial ("the diagram shows
  only what could be read"), or that nothing could be drawn, names the line,
  and offers **Open as text**. A file that does not parse is never presented
  as "empty".
- **Open as text** (`openConfigAsText`): from the per-file editor the tab is
  REPLACED by the built-in text editor, the caret on the line the banner
  named. `vscode.openWith(uri, "default")` alone only ADDS a text tab next to
  the diagram tab (two inputs for one resource — the tabs then toggle), so
  `reopenConfigAs` (`src/customeditor.ts`) opens the wanted editor in the
  group that shows the other kind and closes that other tab; the document is
  shared, so nothing is lost and nothing is asked. From the panel the active
  configuration opens as text beside the diagram, focused, on the error's
  line. The commands `quickuvm.openConfigAsText` and
  `quickuvm.openConfigAsDiagram` do the same from the palette, each with a
  button in the editor title, so the route works both ways. The
  layout-failure banner offers the text editor too.
- **Empty states name the next action** and offer it as a button: no design
  model → "Set top module…" (`setTop`), plus "Open verification view" when a
  configuration exists (it needs no RTL); the verification view without a
  configuration → "Open the design views" (where "Set as DUT" creates one); a
  configuration that declares no DUT, agent or composed block → "Open the
  design views" (with a model) and "Open as text". The no-model state waits
  1.5 s after the webview starts (every open passes through "no model yet",
  and the state flashed on each of them) and is re-rendered on `config/full`,
  which is posted after the `overlay/config` that first renders it. Until
  then the host's localized placeholder is shown; the states themselves are
  English, like the rest of the webview (D19).
- A verification-view banner does not follow into the design views (a YAML
  error says nothing about the RTL); `model/stale` is the design views' own.
