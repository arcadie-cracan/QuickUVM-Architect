# 06 — Phased plan, risks and the decision journal

## Phases

### Phase 0 — backend validation (CLOSED)

A working pyslang extractor (`backend/svmodel.py`) that produces the complete
project model, validated on `examples/soc_top.sv` (a regression design derived
from the QuickUVM examples, with propagated parameters, generate, an unpacked
array, an interface with modports, concat/select connections). The
verification criteria: CLAUDE.md.

### Phase 1 — extension skeleton + read-only symbol view (CLOSED)

Closed in Jul 2026: implemented and verified on the regression design
(pytest green, the webview validated on a real model), and the closure
criterion was ticked interactively on a real Bender project — common_cells,
top `cdc_fifo_gray` (`examples-bender/`): hierarchy, the symbol view,
jump-to-source from a pin.

- a `yo code` TypeScript skeleton; the backend started as a child process,
  with a debounce on save; the model parsed against the schema;
- the hierarchy tree view (native) from `instances[]`;
- a webview with the symbol view of a module: full ELK layout, pins on the
  sides, widths, pan/zoom, simple selection; the VSCode theme;
- Bender integration (`bender script flist-plus`, with +incdir/+define) with
  a glob/.f fallback;
- tests: pytest on the extractor (the criteria in CLAUDE.md), a snapshot of
  the example's JSON model.

Closure criterion: you open a real Bender project, you see the hierarchy and
the symbol diagram of any module, with jump-to-source from a pin.

### Phase 2 — QuickUVM configuration (the core of the value) (CLOSED)

Closed in Jul 2026: the YAML mutations have Node tests (`npm run test:yamlops`),
the DUT→agent→generate flow runs end to end on `examples/` against the real
quick-uvm 0.9.1 (`npm run test:e2e`), the overlay + the inspector are validated
on a real model in a browser harness, and the closure criterion was ticked
interactively in the Extension Development Host: the DUT set from the diagram,
an agent from a pin selection, an ignored port, a generated testbench — with no
hand-written YAML.

- the configuration overlay from the YAML (parsing, agent colours, the
  coverage indicator); `WorkspaceEdit` for: setDut, createAgentFromPins,
  ignorePort; the validations of doc. 03 as diagnostics;
- the side inspector (agents, tests, project/clock);
- the `quick-uvm generate` task + parsing of the errors;
- an agent from an interface (expanding the modport).

Closure criterion: from a real DUT to a QuickUVM testbench that runs, without
writing YAML by hand (but with the YAML readable and correct at the end).

### Phase 3 — the schematic view + user-owned positions (CLOSED)

Closed in Jul 2026. The criterion was ticked on common_cells
(`examples-bender/`, top `cdc_fifo_gray`): the automatic part by the harness
sweep on the real model (8/8 schematic views and 24/24 symbols without
exceptions, zero edges through blocks, drag → total snapshot D21, exact
reopening), and the interactive part by the user in the Extension Development
Host — which caught, and led to the fixing of, five real regressions (the
discovery of the active config, the silent abort in checkDut, the `_ni`
heuristic, the recursive flow of the composition, the gestures on the non-DUT
views) — see the journal below and the notes in this section.

- the schematic view from `views` (instances, interconnect, generate fold) —
  **implemented read-only** (Jul 2026): a pure scene tested in Node
  (`test:scene`), ELK layered layout with the boundary ports on dedicated
  layers, drill/breadcrumb/switch navigation, a browser harness;
- node drag + the sidecar — **implemented** (Jul 2026): pure mutations in
  `src/sidecarops.ts` (`test:sidecar`), a host service with atomic writing
  (temp+rename), a watcher for external edits, graceful invalidation with the
  restoring of orphans that reappear, the command "Clean Orphaned Layout
  Overrides", drag with snap to the grid and naive orthogonal re-routing of the
  edges (the ELK routes remain only on views without overrides), persisted
  folds (the camera is session state — the first opening always fits the view);
  the pins on the grid by construction (`FIXED_POS` ports, pitch 16 — an
  aligned pin = a straight wire) and H/V flip per node (reassigning the pin
  slots, persisted in the sidecar, the H/V keys + the inspector);
- interactive ELK for new elements + an explicit "Re-arrange all" —
  **implemented** (Jul 2026): the user's positions become seeds
  (INTERACTIVE strategies, without cycleBreaking — a conflict with
  LAST_SEPARATE), they are forced exactly after the layout, only the new
  elements receive positions; the ⟲ button + `relayout/request` delete the
  view's positions (folds/flips remain). The whole block above (drag, grid,
  flip, lasso, fit, interactive ELK, orphans) **ticked interactively** in the
  Extension Development Host on examples/ (Jul 2026);
- the interconnect router: **the own Lee/A* grid prototype implemented**
  (Jul 2026) — `src/webview/router.ts` (a pure module, `test:router`), the
  fixed interface `route(obstacles, requests, constraints) -> polylines`, A*
  with the state (cell, direction), a penalty on bends, inflated obstacles, a
  free corridor at the anchors; strict orthogonality on the grid (the anchors
  are inserted, they do not replace the grid points) and per-cell occupancy by
  orientation: a parallel overlap with another net is practically forbidden
  (penalty 8/cell), a perpendicular crossing is allowed but rare (2), only the
  block boxes are absolute walls — the halo is a high cost (6/cell),
  traversable when the blocks stand closer than two halos (the wire squeezes
  through the gap, not through the blocks); a
  proximity penalty on the ring around the halo (1/cell — at equal cost, the
  route prefers the wide channel, not hugging the blocks), the edges of the
  same net share the trunk freely (fan-out); the requests are routed
  shortest-first; a configurable halo around the obstacles (16px by default,
  with its own corridor at the anchors) plus text obstacles for the pins'
  labels/annotations — the routes of other nets do not pass over the port
  names: the texts are SOFT obstacles (cost 10/cell when crossed, not a wall —
  in tight channels the router passes over a label instead of falling back
  through the blocks), they enter the layout as `elk.margins` margins, and the
  ELK spacings are correlated with the halo (88 between layers, 48 between
  nodes — between two halos a wire corridor always fits); the router is the
  single source of routes in all the schematic views (the world on the grid is
  universal, ELK gives only the positions), with a naive per-edge fallback
  when there is no path; ~2ms per full re-route during a drag on the
  regression design. The libavoid vs. own decision: closed — D20 (the own
  router). Override level 4 (wire↔label per net) implemented
  (Jul 2026): a click on the route or on the net's label → the Net section of
  the inspector with the "Show as label"/"Show as wire" switch; the message
  `net/render` (docs/05), persistence in the sidecar under `nets.<net>.render`
  only when it departs from the model's suggestion, graceful invalidation with
  `kind: net` (docs/04); tests in `test:sidecar` and `test:scene`. Level 1
  (style) postponed: there is a single style (orthogonal), the override would
  be a setting without options;
- createSubenv from an instance — implemented (Jul 2026, the mapping in
  docs/03): the "Create subenv" button of the inspector on the blocks selected
  in the schematic view (+ the command `quickuvm.createSubenv` in the palette),
  the folds are expanded into their members, a multi-select confirmation with
  the summary of the new configs (skeleton + heuristic dut) and of QuickUVM's
  H1 constraints (`params` require `parameters:` in the block's agent; clocked
  children accepted since the M1 clocked-subenv slice — single-clock, at most
  one reset); the `createSubenvs` mutation in yamlops (sanitized SV names,
  `params` integers only, `layout: packaged` ensured, duplicates refused);
  tests in `test:yamlops` and composition scenario 3 in `test:e2e` (a top + 2
  combinational blocks + 1 clocked block, built exclusively through yamlops →
  `quick-uvm generate` produces the per-block env packages, the top env, the
  virtual sequencer and tb_top; validated on QuickUVM HEAD, Jul 2026);
  `createSubenv` ticked interactively (summary) in the Extension Development
  Host — which also caught a regression: the block scaffolds won the discovery
  of the active config alphabetically and "stole" the overlay/the actions;
  fixed by stable discovery + excluding the children referenced as
  `subenvs[].config` (`topConfigPaths`, docs/03; a tooltip on the disabled
  buttons with the reason).
  The validation on common_cells caught three more: (1) `ConfigService.apply`
  refreshed debounced, so `checkDut` read stale state right after "Set this
  module as DUT" and the action aborted silently — apply now refreshes
  synchronously; (2) the active-low heuristic missed the PULP suffixes
  `_ni`/`_bi` (`src_rst_ni` proposed active-high) — the regex was extended;
  (3) the recursive flow had no clean path: "Set as DUT" on another module
  overwrote the DUT of the active config — it now asks explicitly (overwrite
  vs. a new block config), and the command "Choose Active Config" switches
  between configs through `quickuvm.configFile` (docs/03). In addition, the
  "Create subenv" gesture is now autonomous on the non-DUT views: the button
  is active whenever blocks are selected, and the DUT mismatch is resolved in
  the flow (the offer of a config dedicated to the block + Set as DUT, then
  the proposals continue in the same gesture).
  Also from here: the agent gestures work in the schematic view too, on the
  boundary flags AND on the pins of the child blocks (a block's pins = the
  ports of its module — the agent is created for the block's config, with the
  block's `viewId` in `args` and the DUT resolved in the flow, as for a
  subenv; the restriction to the symbol view was a phase 2 inheritance, not a
  decision); a mixed selection disables the gesture, the pin actions receive
  only the resolved pins (the blocks are filtered out), Ignore/Un-ignore
  included.

The closing validation on common_cells (`examples-bender/`, top
`cdc_fifo_gray`, Jul 2026) — the automatic part, through the harness on the
real model (`bender script flist-plus` → `svmodel` →
`examples-bender/model-cdc.json`, regenerable at any time): all 8 schematic
views render without any exception and with **zero edge segments through
blocks** (the router's quality metric), all 24 symbols render, the drag
persists the total snapshot (10/10 elements — D21 on a real model), the
wire↔label switch works with the correct persistence message; the design has
no generated folds (the behaviour of the folds stays covered by demo_top).
The interactive step that remains: the launch configuration "Run the
extension (Bender: common_cells)" — drag + reopening (sidecar), navigation,
then phase 3 can be declared closed.

Closure criterion: on a real Bender project, every schematic view opens clean
(no edges through blocks), the arranged positions survive reopening, and the
configuration actions (agents, subenvs) work from the diagram.

### Phase 3b — the verification view: a graphical editor of the QuickUVM configuration (CLOSED)

Objective (added in Jul 2026, decision D16): the third view of the extension —
besides symbol and schematic (both of the RTL) — is the diagram of **the
verification environment itself**, derived from the YAML: the DUT with the
mapped ports, the agents (active/passive, the overlay's colours), the
scoreboards with the source/monitor flows, the coverage collectors, the
virtual sequencer, and for the composed benches (H1) the subenvs with
`connections` and the cross-block scoreboards. Editing **directly on the
diagram**, not only visualization:

- a component palette: scoreboard, coverage, virtual sequence — insertion by
  drag onto the diagram → a YAML edit (new yamlops for `analysis`, `tests`,
  `virtual_sequences`);
- connecting with the mouse: an agent→scoreboard edge (source/monitor),
  agent→coverage; the properties of the edge/component (match, match_key,
  max_latency…) in the inspector;
- deletion with confirmation; every gesture = one `WorkspaceEdit` (native
  undo/redo);
- stable IDs: the names of the agents/scoreboards; the view key
  `tb:<config-path>`; the node positions in the sidecar, as for the other
  views;
- live validations in ConfigService (a reference to a non-existent agent,
  monitor == source etc.) as diagnostics on the YAML;
- whitebox probes from the diagram (QuickUVM 0.9.2, the K2 slice, Jul 2026):
  `probes: [{name, path, width, enum?, clock?, coverage?}]` observes,
  OBSERVE-only, internal signals through XMR, with `path` relative to the DUT
  instance — designed explicitly for external tools to emit it. The
  extension's gesture: you select a net (in any view under the DUT) → "Create
  probe"; the path = the elaborated path of the net minus the path of the DUT
  instance (invariant 4 gives it directly), the width from the model. The
  model gap: svmodel does not emit the enum types of the nets today — typed
  probes (symbolic coverage on an FSM) require extending the extractor;
  started with width-only. A QuickUVM constraint: probes do not work yet on
  subsystem benches (H1);
- the composition derived from the model (an idea from the validation of
  phase 3, Jul 2026): the nets between the child instances in the parent's
  schematic view are exactly the entries
  `connections: [{from: block.port, to: block.port}]` of the H1 composition (and
  the candidates for cross-block `subenv_scoreboards`) — the extension can
  generate them from the model instead of having them written by hand; plus
  the optional step "Compose into parent bench" when a block bench is created
  (it ensures the config + the `subenvs` entry on every intermediate level, on
  the known path from the root bench to the current view);
- the final packaging: a `CustomEditor` on `*.quickuvm.yaml` (the TB diagram
  as the default editor of the file, with a text fallback).

A hard dependency on phase 3: it reuses the multi-node rendering, the
interconnect router, the drag with persistence and the graceful invalidation
— which is why it comes after it. The YAML remains the source of truth; the
diagram is an editable projection, just like the overlay of phase 2.

Design references: journal entry D22 — bigUML as a map of patterns
(generic handlers driven by metadata, edge type hints, property palette,
text↔diagram synchronization), GLSP/Sprotty rejected as a stack; the external
precedents validated there (AWS Workflow Studio, drawio, Structurizr/LikeC4)
confirm the combination `CustomTextEditorProvider` + minimal `WorkspaceEdit` +
geometry sidecar.

Additional references (a survey of Jul 2026, four parallel investigations):

- **Kaoto + Apache KIE Tools** (Red Hat) — the only production graphical
  designer over hand-maintained YAML in VSCode; the wiring to copy:
  gesture → `WorkspaceEdit.replace` on the TextDocument (VSCode owns the undo),
  echo suppression by stop-listening/resubscribe, any
  `onDidChangeTextDocument` → re-render. Their weaknesses (full
  re-serialization; they keep only the leading comments) are exactly the
  strengths of `yamlops.ts`.
- **The canonical Accellera UVM 1.2 notation** (+ the ClueLogic/ChipVerify
  cookbook dialect): square = a port on the producer, circle = an export on
  the consumer, diamond = an analysis port on the monitor, the sequencer drawn
  above the driver, passive = monitor only, dotted references from the virtual
  sequencer to the agents' sequencers — the glyphs that are mandatory for the
  diagram to be instantly familiar to verification engineers.
- **DVT / Sigasi / Questa Visualizer** — the principle "only the vital
  information" (no uvm_root/phase internals); the config/factory details in
  the inspector (aspect views, Verdi), not on the canvas; a click on the
  analysis edge → the YAML lines that created it (Sigasi); mandatory
  unconnected ports in an error style with a quick-fix (Riviera-PRO).
- **UVMF `yaml2uvmf`** (Siemens) — the semantic checklist of the objects that
  the 3b editor must express (active/passive + initiator/responder agents,
  predictors, scoreboards with exports named expected/actual, explicit
  analysis connections, nested subenvs); the placement of the agent in the env
  (own/top/shared) as a property, not as a gesture (Doulos Easier UVM).
- **Gestures**: the pin-drop create menu (Unreal Blueprints — a drag from a
  pin onto empty canvas → a filtered menu of legal creations, the node appears
  already connected; the basic gesture of 3b: from the DUT pins → "New
  active/passive agent / Connect to scoreboard"); splicing a node onto a wire
  + heal on deletion (Node-RED/Blender); the monitor×scoreboard connectivity
  matrix as a bulk alternative to drawing edges (DVCon 2021); live validation
  during the drag (`isValidConnection`, React Flow); undo at gesture level
  with Escape = cancel (tldraw): one gesture = one WorkspaceEdit = one undo
  step.

The order of implementation (started in Jul 2026):

1. **Slice 1 — the read-only view** (implemented, Jul 2026): the
   **hierarchical** TB scene (`src/webview/tbscene.ts` → `TbScene` with the
   canonical UVM containment; hierarchical layout+drawing in
   `src/webview/tbschematic.ts` — ELK compound `INCLUDE_CHILDREN`, flattening
   onto the grid, the A* router reused with the leaves as obstacles), the
   message `config/full`, `ViewMode: "tb"`, the key `tb:<config-path>`, the
   command `openVerificationView`; tests `test:tbscene`.
   Containment: Testbench › {DUT, Env › {agent › {sequencer/driver/monitor},
   scoreboard, coverage, vsqr, subenv, probes}} — the agent is in the Env, not
   in the DUT (the answer to the user's remark: the agent CONNECTS to the DUT,
   it does not contain it). **Drag + TB positions implemented** (Jul 2026):
   the same mechanics as RTL, keyed per level (`tb:<config>|<focus>`),
   interactive ELK seeds, total D21, ⟲.
2. Slice 2 — editing. **Adding implemented** (Jul 2026): the "Add component"
   palette of the TB inspector (coverage/scoreboard/virtual sequence), the
   selected agent preloads the source; connections are not free edges in
   QuickUVM (source/monitor are fields), so the gesture creates the component
   already connected; the yamlops mutations `addScoreboard`/`addCoverage`/
   `addVirtualSequence` (flow maps, unique names, idempotent) through
   `WorkspaceEdit`; native QuickPicks for the parameters (source/monitor/
   match+key, agents, mode); tests `test:yamlops` + the extended e2e scenario
   (coverage + scoreboard added → `generate` produces their files).
   **Deletion + property editing implemented** (Jul 2026): the pure mutations
   `removeScoreboard`/`removeCoverage`/`removeVirtualSequence`,
   `removeAgent` (cascade: the agent's coverage, the scoreboards with
   `source`/`monitor`==agent, the vseq steps + the sequences left empty) and
   `setScoreboardField` (source/monitor/match/match_key/max_latency, with a
   cascading cleanup: an empty monitor → single-stream deletes match+match_key;
   match=in_order deletes match_key), all with the cleanup of the emptied
   blocks (`pruneEmptySeq`/`pruneEmptyMap`) and idempotent on a missing target
   (`test:yamlops`).
   The host actions `deleteComponent` (a **modal** confirmation with the
   summary of the cascade for an agent) and `editScoreboard` (**inline**
   editing in the inspector: a `<select>`/`<input>` per field → one
   `WorkspaceEdit` per change). The TB inspector: a Delete button per selected
   component (scoreboard/coverage/agent; vsqr → a Delete per sequence) + the
   scoreboard's property editor. **Three paths to the same deletion**, all
   through `tbDeleteTarget` (the single source of id→name resolution) and the
   same modal confirmation of the host: the inspector's button, the
   `Delete`/`Backspace` **key** on the selected component, and the **context
   menu** (right-click → Open / Flip H / Flip V / Delete, with the deletion
   marked by colour; on `vsqr` one entry per sequence; on a boundary flag only
   Flip H; on DUT/Env no Delete). The key handler is armoured NOT to fire
   while you are editing a field of the inspector
   (`INPUT`/`SELECT`/`TEXTAREA`). Validated in
   `scripts/harness.html?mode=tb` (the `deleteComponent`/`editScoreboard`
   messages correct on all the types, Delete on the DUT = a no-op, the keys
   blocked in fields, the menu closes on Escape/click-outside/zoom).
   **The e2e deletion scenario** (`test:e2e`, scenario 4) closes the slice
   against the real generator: `removeAgent` with its cascade → `quick-uvm
   generate` exits 0 (a dead reference — a scoreboard with `monitor` == the
   deleted agent — would have been refused by Pydantic) and the agent's
   artefacts disappear. **It caught a regression that the pure tests could not
   see**: the `analysis:` block switches QuickUVM between implicit mode (no
   key → it auto-wires a scoreboard + coverage onto the "primary agent") and
   declared mode (with the key, even `{}` → it wires exactly what is listed).
   Cleaning away the emptied block would have *resurrected* the components
   just deleted; the mutations now keep `analysis: {}` (see `keepAnalysis` in
   `yamlops.ts` and the pitfall in CLAUDE.md).
   **The verification hierarchy** (the second section of the sidebar, Jul
   2026): "Verification Hierarchy" next to "Design Hierarchy" — the tree of
   the TB environment derived from the config (the pure `tbtree-build.ts` +
   `tbtree.ts`), the mirror of the TB diagram, with symmetric tree↔diagram
   navigation (common ids from `buildTbScene`); test `test:tbtree`.
3. Slice 3 — the gestures derived from the model. **The whitebox probe (K2)
   implemented** (Jul 2026): a net selected in the schematic view → "Create
   probe" (`createProbe {net}`); all the deduction lives in the **pure** module
   `src/probe.ts` (`proposeProbe`): it resolves the DUT instance (the YAML
   gives the MODULE name, not the path), computes the XMR path relative to it,
   derives the width and refuses with an explicit reason exactly where the
   generator would refuse (an H1 subsystem, unpacked, an interface, a port
   already mapped onto an agent, a view outside the DUT); the mutations
   `addProbe`/`removeProbe`; tests `test:probe` (15, on the real model) +
   `test:e2e` scenario 5 (the XMR `assign probe_if.x = dut_inst.<path>` reaches
   tb_top; `coverage: true` → `probe_monitor`; H1 confirmed empirically).
   **Two real limits, discovered by probing the generator** (detailed in
   CLAUDE.md): the width is not in the model and the naive derivation is wrong
   (`select`/`concat` lie), and the PURE internal signals (state registers,
   wires from an `assign`) cannot be probed — the model emits nets only from
   the port connections of the child instances; extending this would require
   changing the extractor.
   **The derived composition implemented** (Jul 2026): `deriveConnections` in
   the **pure** module `src/compose.ts` (`test:compose`) turns the inter-block
   nets of the subsystem's schematic view (a net without a `<port>.X` endpoint,
   with one output → one+ inputs between subenvs) into
   `connections: [{from, to}]`, with the direction from `port.dir` and the
   width from the model; it refuses multi-driver nets and width mismatches. The
   gesture "Wire connections from design" (a button in Actions on a subsystem)
   writes `connections` through `addConnections` AND **automatically sets
   passive** the agents of the destination blocks (`setAgentActive(false)` on
   the child configs) — one ATOMIC `WorkspaceEdit` over several files (a
   single undo); if a child does not have an agent yet, it warns you to
   configure it passive. It is a gesture SEPARATE from `createSubenv` because
   the wires connect agent interface ports, so the children must have agents
   first. `test:e2e` scenario 6: `addConnections` → a physical inter-block
   `assign` in tb_top; **an ACTIVE destination agent is refused by the
   generator, and `setAgentActive(passive)` repairs it** (the proof that the
   flip produces a bench that generates); `removeConnection` → the wire
   disappears. The contract (endpoint = `<subenv>.<port>`, passive dest, equal
   widths) was re-probed empirically on the current build (pitfalls in
   CLAUDE.md). **"Compose into parent bench" implemented** (Jul 2026), but
   RECONCILED with the hardened composition rules of quick-uvm (probed
   empirically): (a) a subsystem requires **≥2 subenvs** (1 → refused), so
   "compose the path with one subenv per level" of the original plan is
   INVALID; (b) a bench with `subenvs` **cannot have agents of its own** (the
   hybrid is forbidden — a composition level is a PURE subsystem); (c) nesting
   WORKS (a subenv can itself be a subsystem). The decision (chosen by the
   user): the gesture is "one level, from the child" — from a block's view, it
   composes the block + its block SIBLINGS into the immediate parent (the pure
   `parentComposition` in `src/compose.ts`, `test:compose`; it delegates to
   `createSubenv`), refusing when the parent has <2 composable blocks. No
   recursive cascade (it would hit ≥2 at the levels with a single child).
   **The "hybrid forbidden" divergence tackled** (Jul 2026): because the
   current quick-uvm rejects a bench with `subenvs` + agents of its own
   (`agents: []` is OK, only non-empty + subenvs is refused — probed), the
   extension (a) puts a **hard diagnostic** on the `agents` block when a
   config is a hybrid (`ConfigService`, universal detection: for hand-written
   YAML too), (b) **warns modally** in `createSubenv`/`composeIntoParent`
   before it composes into a config that already has agents, (c) corrects the
   comments that described the hybrid as valid (`hasDut`, CLAUDE.md).
   `test:e2e` locks the rule (hybrid → `generate` fails). **Slice 3 is
   CLOSED.**
4. Slice 4 — the `CustomTextEditorProvider` packaging on `*.quickuvm.yaml`
   (the Kaoto/KIE wiring of D22) + the closing validation. **Implemented** (Jul
   2026): `QuvmConfigEditor` (`src/customeditor.ts`) is the DEFAULT editor
   (`priority: default`) of `*.quickuvm.yaml` — you open the file → you see the
   TB verification diagram, with the native text fallback ("Reopen Editor
   With… → Text Editor"). The TB diagram is config-driven (`renderTb` does not
   touch the RTL model), so it is rendered from the document's text; the layout
   (drag/flip/fold) goes through the COMMON sidecar (keyed `tb:<path>`), and
   the editing gestures (add/delete/edit) apply to the DOCUMENT through
   `WorkspaceEdit` — native undo/diff/text editing (invariant 2). The key of
   the refactor: the **`TbEditTarget`** interface
   (`current`/`configUri`/`apply`), which ConfigService satisfies (the ACTIVE
   config) and `DocumentEditTarget` implements (the open document), while the
   TB editing gestures in `actions.ts` take a parameter `cfg: TbEditTarget =
   this.config` — so THE SAME methods (the QuickPicks included) work on either
   target, zero duplication. Any text change (an edit, an undo, the own
   gesture) → `config/full` → re-render (idempotent, no loop). Validated in the
   harness with `?nomodel=1` (the TB view + the editing work from the config
   ALONE).
   **A step-by-step tutorial for the manual validation**:
   `docs/tutorial-yapp-buffer.md` (the fixture `examples-yapp/yapp_buffer.sv` +
   the launch configuration "tutorial: yapp_buffer"; both were named
   `yapp_router` until Jul 2026, colliding with the real demux in
   `QuickUVM/examples/yapp`); the steps are verified
   empirically — the design parses with svmodel and the resulting config
   generates clean with quick-uvm (both scoreboard variants). **The manual
   closing step is TICKED** (16 Jul 2026): the user went through the whole
   tutorial in the Extension Development Host; along the way two real
   refinements came out as well (the constant alignment of the pin labels on a
   flip; the fan-out/fan-in overlap near the common end in the router —
   `fanoutRadius`, docs/04), both implemented and tested.

Closure criterion: an environment with ≥2 agents, a two-stream scoreboard and a
coverage collector, built and re-arranged entirely graphically (without a text
editor), with readable YAML at the end and a clean `quick-uvm generate`.
**Ticked — the MVP is validated** (16 Jul 2026, the yapp_buffer tutorial).

After the closure a **hardening pass over the test net** was run (16 Jul
2026, a multi-agent audit + adversarial review): the systematic gap was that
the orchestration that imports `vscode` had no coverage at all, and a few
regressions PROVEN real had no guard. Fixed by extractions-to-pure, without
changes of behaviour: `filelistops.ts` (the .f quoting, the outputDir
exclusion, `resolveLocPath` — `test:filelist`), `heuristics.ts` (the name
regexes, including the `_ni/_bi` pitfall — `test:heuristics`),
`configcheck.ts` (the core of the model↔YAML validations as structured
findings, the l10n messages stay in the host per D19 — `test:configcheck`),
`subenvMapping`+`planWireEdits` in `compose.ts` (the rel→subenv mapping + the
plan of the multi-file edit of the H1 wiring, with invariants #3/#4 locked in
tests — `test:compose`), `edgeObstacles` in `schematic.ts` (pitfalls 13/14 —
`test:router`), `probeCoverageAllowed` (`test:probe`) and `isComposedChild`
(`test:yamlops`, with a normalized path comparison — the old
`includes(fsPath)` missed the case differences on Windows).
The adversarial review of the refactors confirmed the semantic equivalence
(a diff against the old code, two suspicions rejected with evidence) and found
**one real pre-existing bug**, double-confirmed on the installed generator:
the passivation handled only the FIRST agent of a destination block — with
driven ports owned by different agents, the second one stayed active,
`generate` refused, and the gesture reported success. Fixed in
`planWireEdits` (`filter`, not `find`; all the owning agents become passive)
+ a regression test; the pitfall is in CLAUDE.md (invariant #5 of the
composition).

After the hardening came a **cleanup pass over the loose ends** (16 Jul
2026, from a parallel audit of the MVP's state): (a) the `node/moved` message
was **withdrawn from the contract** — dead after D21 (the drag sends only
`layout/snapshot`), removed from protocol/panel/customeditor/sidecar/harness +
docs/05; (b) the header of `protocol.ts` (the contract) and the remaining
"not implemented" comments were brought up to date, and the `default` in
`onAction` (host) is now an **exhaustiveness guard** (`never`) that catches at
compile time a new `ActionKind` without a handler; (c) the leftovers of the
"QuickXray" name after D17 (the `QuvmXQuickuvmArchitect` interface, the D15
note); (d) **the drill into a subenv** — the only real navigation gap: a
`«subenv»` block with a config is drillable, and double-click/Open sends
`openSubenvConfig` with **the path of the config** (not the name), which the
host opens with the default editor (the per-file TB diagram, slice 4); it
works from the panel and from the per-file editor (H1 nesting). The
adversarial review confirmed 3 real defects, all fixed: the drill carried the
name (duplicate names → it silently opened the wrong file) — it now carries
the path + a deduplicated node id (`#n`, like `usedSb`); the absolute paths
were glued on as relative (`Uri.joinPath`) — now `path.isAbsolute` →
`Uri.file`, like `pathlib` in quick-uvm; and a stale reference to
`node/moved` in CLAUDE.md. All 12 suites + typecheck/build green; the drill
validated in the harness (a duplicate name + an absolute path).

### Phase 4 — polish

- level-2 overrides (the pin order) — still open; level 3 (routes relative to
  the pins) only on demonstrated demand — **IMPLEMENTED** (Nov 2026, D27: wires
  dragged by hand in the schematic and verification views; docs/04);
- an enriched drawing vocabulary — **the core IMPLEMENTED** (Jul 2026, chosen
  by the user from the audit): **slash+width labels on buses with grading by
  class** (`ScenePin`/`SceneBPort`/`SceneEdge` carry `width`; the pin/flag
  shows `/N` — combined `/16×3` for unpacked —, and the wire/stub thickens by
  the classes w-s/w-m/w-l through `widthClass`; the net's width on the edge is
  derived through `netWidth` from `probe.ts`, ONLY from an end with the same
  signal, never through select/concat) and **junction dots only at a T**
  (the pure `junctionDots` in `schematic.ts`, consumed in `routeEdges`: for
  each vertex of the net it counts the distinct cardinal directions — T =
  exactly 3, never 2=bend or 4=crossing; grouped per net, so the crossings of
  two different nets produce no dot; `test:scene`+`test:router`). **What
  remains**: split/join glyphs for slice/concat + constant boxes (netlistsvg —
  they require structured fields on `ScenePin`), titled pin sections in the
  symbol view (symbolator — they require an un-modelled taxonomy, a design
  decision). **The annotation glyphs — IMPLEMENTED** (Jul 2026):
  `ScenePin.noteKind` (a pure discriminator, `noteOf` in scene.ts) chooses the
  glyph — `const` = a tie-cell box, slice/concat = **an accent chip with the
  SV brackets** (`{}` concat / `[]` select), `nc` = a circle; `estPinText`
  reserves `GLYPH_W` in the margins AND the obstacles; `test:scene` (noteKind
  on the real model). The chip replaced the initial netlistsvg split/join
  wedge during the polish (Jul 2026): the wedge was filled and converges
  towards the block, so it read as a second **arrowhead** on top of the wires'
  direction arrow. An adversarial triage over 8 families of solutions (a
  multi-agent workflow, an "arrow-confusability" score): the conclusion — the
  culprit is the filled tip oriented along the wire, not the shape in itself;
  only the shapes without a tip / categorically non-wire escape. The first
  iteration was a diamond with a width sign `+`/`−`, but the sign required a
  mnemonic; replaced with **the literal SV brackets** (`{}`/`[]`) in an accent
  chip — the syntax itself, zero mnemonic. The text `{…}`/`[hi:lo]` remains
  the carrier of meaning under "decorations off" (the chip is decoration,
  hidden there; the note is not removed). Also during the polish, the vertical
  centring of the brackets on the wire (`dominant-baseline: central`) and the
  legibility (a chip with an OPAQUE background — `color-mix` with
  `editor-background`, not `transparent` — which masks the wire underneath,
  like the constant's tie-cell) were repaired. **The port label** moved to the
  SystemVerilog declaration order (the pure `portLabel`, `test:scene`): the
  packed dimensions before the name (from `elem_width`), the unpacked ones
  after it (from the `type` suffix after `$`) — `[15:0]ch_out[0:2]` instead of
  `ch_out[15:0]`, which presented an unpacked array as a flat 16-bit vector
  and contradicted the selects `[0]`/`[1]`/`[2]`; the tooltip was cleaned of
  the internal `$` separator. The width annotation on the wire stays (`16×3`,
  the user's choice — the total width visible at a glance). The label is
  **compact (no spaces)** with **the dimensions coloured discreetly** (the
  pure `portLabelText` + `splitLabel`; a `.dim` tspan with
  `fill-opacity: 0.55` that follows the colour of the name) — it saves width
  without losing legibility (the user's request). In the same pass a width bug
  was caught too: `measurer` measured the monospace labels with the
  proportional UI font (narrower) → underestimation → overlapping west/east
  ports; `measurer(mono)` now measures with the editor's font. Both views
  (schematic + symbol) use `portLabel`.
  Later refinements of the concat/select chip (the user's request): a `GAP`
  from the port (it no longer overlaps the width label / the note), an opaque
  background (it masks the wire), and `centerChipSigns` — a post-render pass
  that measures the real boxes and centres the `{}`/`[]` sign in the
  rectangle, independently of the font's metrics. **The direction arrow of the
  RTL wires was removed** (`marker-end` from `edgeElement`) — the direction is
  implicit from the port's side (west=input, east=output); in the TB view the
  arrows stay (in/out/inout).
  **The wire crosses the concat/select marker HORIZONTALLY** (the user's
  request): the pins with a marker have their stub extended to `MARKER_STUB`
  and the routing anchor moved there as well, so the trunk of the fan-out
  joins beyond the chip (it no longer cuts it vertically) and only the
  horizontal stub crosses it. The first attempt (a routing obstacle to push
  the trunk away) was rejected — the obstacle also repelled the horizontal
  branch, the wire went around the chip. **The pin visibly pierces the chip**
  (the user's request, 19 Jul 2026): `MARKER_TAIL` (=12px) extends the stub
  beyond the outer edge of the chip (36→48, a multiple of 8 — tip/anchor ON
  THE GRID); before, the stub stopped exactly at the edge and seemed hidden
  under the rectangle, the wire seemed to spring from the chip. The stub→net
  thickness transition now falls at the tip, collinear (no corner), so without
  broken joins (docs/04). **The boundary flags were compacted** (padding 26→16
  in width), tighter margins between the label and the edges. **Junction dots
  at a merge** (the user's request): `junctionDots` now marks ≥3 directions at
  a vertex (a T or a 4-way merge of the same net), not only Ts, and **the
  fan-in of a bus is drawn as a COMB** (the pure `combPolys`, `test:router`):
  a vertical trunk + one horizontal tap per end, with a dot at every interior
  T — instead of a STAR that converges in the sink (a 4-way). It is applied
  only when the taps do not cut through blocks (`combClear`). The spine (the
  top tap + the trunk + the bottom tap) is a single polyline, so that the end
  corners have a join (miter), with no gap at the joint. **Navigation &
  arrangement** (the user's request): **the arrow keys scroll** the viewport
  (pan from the keyboard, the scroll convention, a large step with Shift,
  persisted as for the mouse), and during a **drag, alignment guides appear on
  the PIN TIPS** (the pure `alignSnap`+`pinTipOffsets`, `test:router`; the
  user's request): the pin tips (the ends of the stubs, with the `{}`/`[]`
  markers) of the grabbed block align to the nearest pin tip of another block
  (~6px on screen, on top of the grid snap) with a dotted line `.align-guide`
  — two tips at the same y ⇒ a straight horizontal wire, and the vertical
  guide passes through the pin tips, NOT through the block's edges.
  **Minimap** (the user's request, 19 Jul 2026): an overview navigator in the
  bottom-right corner (RTL + TB) — the thumbnail of the scene through
  `<use href="#viewport">` (a live copy, zero re-rendering) + the rectangle of
  the visible area; click/drag centres the camera, the M key toggles it; it
  does not enter the SVG export. The pure geometry is in
  `src/webview/minimap.ts` (`test:minimap`, 6 tests — fitting, the transform
  `U = M ∘ V⁻¹`, the round trip jump↔view rectangle). **The adversarial review
  of the minimap** (19 Jul 2026, 5 dimensions × sceptical verifiers): 7 raw
  findings → 3 real defects confirmed, all repaired + verified empirically in
  the harness (do not reintroduce them): (1) `mmDragging` stayed stuck at
  `true` without `pointercancel`/`lostpointercapture` and when the hit rect
  (the only one that reset it at pointerup) disappeared mid-drag on a
  re-render/M toggle — a hover without a button panned the camera; the flag is
  now reset on all the cancellation paths AND when the minimap is
  rebuilt/removed. (2) `stopPropagation` on `pointerup` was unconditional: a
  below-threshold canvas gesture (lasso/drag < DRAG_MIN, not yet captured)
  released over the minimap lost its cleanup → a phantom marquee/drag; the
  propagation is now stopped ONLY when the gesture is the minimap's
  (`mmDragging`). (3) drag-end updated the minimap but left `contentBounds` at
  the pre-drag bounds → a resize with autoCam fitted differently from the
  minimap; drag-end now recomputes `contentBounds` too (like `fitView`).
  The pure maths came out clean (the composition `U = M ∘ V⁻¹` verified
  algebraically by the reviewer). **The editor→diagram synchronization** (the
  user's request, 19 Jul 2026; the decisions through AskUserQuestion:
  highlighting only + a command, a separate persistent halo): following the
  cursor in the SV sources lights an `.xprobe` halo (yellow, distinct from the
  selection, only in the current view — non-invasive), and the command "Reveal
  in Diagram" (the editor's context menu) navigates to the element. A new
  message `probe/highlight` (docs/05); the (file,line)→target resolution and
  the target→view-ids mapping are pure (`src/locmap.ts`:
  `buildLocIndex`/`resolveLoc`/`probeIds`; `test:locmap`, 14 tests on the real
  model — exact-on-line with port>instance>module, enclosure from above, the
  generated instances on the same line, folds through `memberPaths`); the halo
  is recomputed in `applySelectionClasses`, so it survives re-renders and is
  remapped when the fold is expanded.
  **The adversarial review of the synchronization** (19 Jul 2026, 5
  dimensions × sceptics): 13 raw → 8 distinct defects confirmed, all repaired
  (do not reintroduce them): (1) the SVG export baked the `.xprobe` halo into
  the file — removed from the clone like `.selected`; (2) "Reveal in Diagram"
  on the generate line navigated but selected NOTHING with the fold closed —
  `remapSelection` (pure) in `presentScene` remaps the members' rels onto the
  fold; (3) `select/reveal` did not echo — `postSelection()` keeps the host in
  sync; (4) the fixture `examples/model.json` was ALREADY out of date against
  soc_top.sv (a pre-existing drift: the empty line 22 added on 11 Jul; the
  backend's pytest gate was red) — regenerated, test-locmap updated (g_ch on
  24), pytest green; (5) `lastProbe` was not reset when the webview reloaded —
  the halo lost on identical targets; (6) the top's header revealed the symbol
  although it had a schematic; (7) the menu's regex was case-sensitive (`.SV`
  without an entry); (8) the path→module map was rebuilt per
  `applySelectionClasses` (per pointermove during a lasso) — memoized on the
  model's reference. A known limitation, documented in docs/04: the enclosure
  does not see the boundaries between modules (no end-loc in the model).
  **The quick-uvm status decorations** (the user's request, 19 Jul 2026; the
  decisions through AskUserQuestion: both sources, a badge in the corner + a
  tooltip): the model↔YAML validations as ⚠/✕ badges on the targeted elements
  (the DUT's RTL pins, the TB agent blocks, Env with bubble-up to the root) +
  the result of the last generate as a `✓/✕ generate` chip in the header
  (ENOENT included). A new message `status/decorations` (docs/05); the
  findings→decorations derivation and the decorations→ids mapping are pure
  (`src/status.ts`, `test:status`, 6 tests); `checkConfig` now also emits
  `agent` in the params for `width-mismatch`/`port-orphan` (targeting the
  agent block). The badges do not enter the SVG export; the details are in
  docs/04. The polish series went through a **multi-agent adversarial review**
  (19 Jul 2026: 6 dimensions — the stub/anchor/tip consistency,
  comb+junctions, guides, labels+measuring, interaction/camera, invariants —
  every finding counter-verified by an independent sceptic): 4 raw findings,
  all refuted, 0 confirmed. A KNOWN and accepted limitation (by design, not a
  bug): an alignment on X between tips with DIFFERENT stubs (marker 36 vs
  normal 10, or west↔east) falls off-grid and settles at the next render
  within ≤4px (the world on the grid is universal — rounding to GRID is the
  invariant, not sub-grid fidelity); the usual alignments (the same stub, the
  same side) and ALL the alignments on Y stay exact (the y offsets are
  multiples of 8).
  **Pin sections by role — IMPLEMENTED** (Jul 2026): in the symbol view, the
  clock/reset group (already separated by `buildPins`) gets a gap + a dotted
  divider + the label "clock / reset" (`draw` shifts the group, enlarges the
  box); only when the module has a clock/reset. **The drawing vocabulary is
  CLOSED.**
  **Validated
  visually in the EDH** (Jul 2026), with four refinements: (a) the wire uses
  an OPAQUE colour mixed with the background, not `opacity` — the wires of the
  same net that share the trunk (the fan-out waiver) accumulated their
  transparency and gave a gradient effect where they overlapped; (b) the
  setting `quickuvm.schematicDecorations` (on by default) hides the
  slash/`/N`/junction dots through the `decor-off` class on the canvas (the
  thickness grading stays); (c) the wire/label switch is discoverable from any
  pin/flag (the inspector derives the net from the edges/the label); (d) an
  anti-overlap nudge when a fold is expanded on arranged views (D21 pins the
  neighbours → the new members move to a free place with `freeSpot`, without
  touching the user's blocks);
- interactive tracing: **Shift+click = the upstream/downstream cone —
  IMPLEMENTED** (Jul 2026): the pure `netCone`+`coneOf` in `scene.ts` (a BFS
  over the wire edges by direction + iface in both directions + `render=label`
  nets through `pin.nets`/`bport.nets`; `test:scene`), the Shift(+Alt) gesture
  in the schematic view; **cross-probing on hover — IMPLEMENTED** (a dwell of
  ~300 ms → a non-intrusive reveal in the already visible editors,
  `openSource {peek}`, the setting `quickuvm.hoverCrossProbe`); equidistant
  alignment guides and a minimap for large views — remain;
- **SVG export — IMPLEMENTED** (Jul 2026): the ⤓ button / the command
  `quickuvm.exportSvg` → a standalone SVG (computed styles inlined on a clone
  attached off-screen — no baked `:hover`/`:selected`; `viewBox` on the
  content; a baked background); **PDF postponed** — the SVG converts cleanly
  with external tools, and a PDF library in the webview does not justify its
  weight (D5 anticipated the "trivial" vector export — right in substance, but
  trivial only after the inlining of the styles);
- editor→diagram synchronization (reveal from the cursor position) — remains;
- an enriched drawing vocabulary, alignment guides, a minimap, `quick-uvm
  status` decorations — remain;
- level 2/3 overrides — level 2 remains; **level 3 (hand-routed wires) is
  implemented** (Nov 2026, D27 — the demand D7 waited for came from the user
  arranging diagrams by hand; docs/04, "Level 3 — hand-routed wires");
- performance on large projects (measuring before optimizing).

**The manual validation of the quick wins** (Extension Development Host, 16
Jul 2026) confirmed the gestures and brought three findings, all resolved:
(1) the export from the welcome screen opened the save dialog —
`render()` leaves the viewport populated under the overlay, so the emptiness
gate is now taken from the visible overlay, not only from the DOM (under a
**banner** the export stays allowed: underneath is the last valid drawing,
invariant 5); (2) **a context menu in the RTL views** — a right-click offers
"Go to source" on blocks/pins/flags (the same resolution as the double-click),
"Open schematic" on the blocks with a schematic, Expand/Re-fold on folds and
Flip H/V (docs/05); (3) **undo/redo of positions** — Ctrl+Z/Ctrl+Shift+Z (or
Ctrl+Y): a session history per layout key (RTL per view, TB per level) that
undoes the block moves and ⟲, every restored step being persisted through
`layout/snapshot` (docs/04); validated in the harness (a simulated drag → undo
to the exact position → redo; the menu on all the targets; the empty export on
the welcome screen).

The three quick wins went through an **adversarial review** (Jul 2026, 3
reviewers × verifiers): 7 real defects confirmed, all fixed — the most
important one, the cone through `render=label` nets did not see the boundary
flags (`SceneBPort` got `nets`, `netCone` traverses them with the inverse
rule: the view's INPUT port drives), and Shift+click on the inside of a pin
became a non-existent net that destroyed the selection (`coneOf` classifies
the target robustly). Plus, in the export: `text-transform`/`text-decoration`
were missing from the inlined styles (lowercase TB titles, ignored ports
without the line-through), `:hover` was baked into the artefact (solved by
reading on the off-screen clone), and the cancelling of the peek on
`pointerdown`/`pointerleave`.

**The second round of validation** (Extension Development Host) brought three
more: (1) the export from the palette also worked with the Welcome/source tab
active — the command now targets **the ACTIVE exporter** (a session registry
in `panel.ts`: the RTL/TB panel and the per-file editor register on
`onDidChangeViewState` when they are `active`, they are removed on
blur/dispose; the command exports only the visible diagram tab); (2) the RTL
context menu stayed open when you changed the selection in Design Hierarchy —
a click in the tree is outside the iframe, so it produces no pointerdown in
the webview; it now also closes on `blur` (docs/05); (3) "Go to source" was
missing on **folds** (they have no `instPath` of their own) — the members of
a fold share the same module (the criterion of folding), so the definition is
opened through the first member derived from the id (`g_ch[0..2].u_ch` →
`g_ch[0].u_ch`).
A new fixture for cross-probing: `examples-probe/deep_pipe.sv` — 8 modules in
a single file (ports at lines 19…195), instantiated in a chain by
`deep_pipe`, so that the hover on the pins `u_a…u_h` visibly scrolls the
source (the launch configuration "cross-probing: deep_pipe").

### Phase 5 — post-MVP (the generation feedback loop + schema parity)

The MVP (Phases 0–4) is closed. The continuation of the plan — three
directions requested by the user (decorating the ungenerated elements,
incremental per-element generation, the GUI ↔ QuickUVM schema parity) — is
detailed separately in [`docs/07-plan-post-mvp.md`](07-plan-post-mvp.md): a
common foundation (the QuickUVM generation manifest) unblocks lines 1–2, and
line 3 (parity) proceeds in parallel, starting with the negative-parity
repairs (inout/hybrid agents blocked by guards gone stale since 1.0).

## Main risks and mitigations

| Risk | Mitigation |
|---|---|
| a large dump/model on industrial designs | the model is already compact (not the raw AST); if needed, per-view emission on request |
| slang whole-design on every save | debounce + measuring; slang is fast; only then a cache/incremental |
| the pyslang AST/API schema changes between versions | a version pinned in `requirements.txt`; the regression tests catch the divergences |
| code that does not compile while being edited | `model/stale`: the last valid model stays; not blocking for the MVP |
| routing becomes a time sink | the order 1→4→2→(3); level 4 (labels) cuts most of the hard cases |
| a functional overlap with TerosHDL perceived as duplication | clear positioning: the diagram→config loop is the differentiator; the visualization is a means |

## Decision journal

| # | Decision | Reason (summary) | Rejected alternative |
|---|---|---|---|
| D1 | semantic backend = slang (pyslang) | full elaboration: numeric widths, generate unrolled, parameters per instance, semantic interfaces/modports; robust on incomplete code; the fastest/most conformant (the ChipsAlliance suite) | sv-parser+svinst: parse-only, symbolic widths would have required an evaluator of our own; svinst unmaintained since 2022. Verible: no elaboration, the CST declared unstable. Surelog/UHDM: heavy integration (Cap'n Proto/VPI), slower |
| D2 | the JSON project model as the stable contract, the backend behind an adapter | the backend is replaceable without touching the UI; the pyslang prototype does not block a future C++ tool on libslang | direct coupling UI↔slang API |
| D3 | Bender as the source of the file list | manifest+lock already standard in the targeted flow; it separates the RTL from the generated environment through targets | guessing by glob (it remains the fallback) |
| D4 | layout: ELK layered initially + user-owned positions + interactive ELK for new elements | the mental model of schematics (the tool proposes, the human disposes); the spatial memory protected | continuous automatic re-layout; yFiles/GoJS (licence); React Flow (a React dependency, no native orthogonal routing); JointJS (a data model of its own — to be re-evaluated if the need for interactive routing appears) |
| D5 | our own SVG rendering in the webview | native hit-testing, overlay through CSS, vector export; the data model stays ours | canvas; diagramming frameworks |
| D6 | an interconnect router separate from the layout | free positions invalidate the ELK routing | routing only at a total re-layout |
| D7 | routing overrides on 4 levels, implemented 1→4→2→(3) | level 4 (wire↔label) is the EDA practice and eliminates most of the hard cases cheaply; waypoints only relative | absolute waypoints (fragile); automatic routing only |
| D8 | the QuickUVM YAML = the source of truth; the UI edits through WorkspaceEdit | no hidden state; undo/diff/collaboration for free; the validation stays in QuickUVM (Pydantic) | a project format of the extension's own |
| D9 | stable IDs = elaborated hierarchical paths | keys for the sidecar, the overlay, the protocol; stable across re-parsing | synthetic per-session IDs |
| D10 | graceful invalidation (orphans) for overrides and for failed compilations | a typo does not destroy the arranging work; consistent with the fail-closed of QuickUVM | aggressive automatic cleanup |
| D11 | the name of the extension = QuickXray (id `quickxray`) | the Quick* family ties the extension to the existing QuickUVM brand; the X-ray metaphor describes exactly the interior view; no collisions at verification (Jul 2026); short, pronounced identically in RO/EN; findability is ensured through the subtitle and `keywords` | QuickInspect (2 active commercial products, ™), QuickBench (the historical EDA tool of Chronology + a disk benchmark), QuickSchem (a ™ mark of Trace Software, electrical schematics software — a direct category collision, which also weakens QuickSchematic by proximity), QuickEnv (an existing Rust tool + "env" = environment variables for the general public), QuickScope (gaming slang + Mitutoyo), QuickRTL/QuickHDL (proximity to the former Mentor family), DUTscope and RTL Canvas (good, but outside the brand family) |
| D12 | build with esbuild: CJS host (`dist/extension.js`) + IIFE webview (`dist/webview.js`), elkjs linked statically into the webview's bundle | two targets from a single command; the format used by the official extension templates; the framework-less webview needs only bundling, and the `elk.bundled.js` variant (without a worker) avoids any additional infrastructure | `tsc` only (it does not link elkjs for the browser); webpack (heavier configuration, no gain at this scale); loading elkjs as a separate `<script>` (two artefacts to keep in sync) |
| D13 | the validation of the model in the host = a gate on `schema_version` + a light structural check (`validateModel`); the full validation against the JSON schema stays in the backend's pytest tests | the contract is guarded at the source (the backend is tested with `jsonschema` on every pytest run); the host only has to refuse unknown versions (docs/02) and obviously broken shapes, without a runtime dependency | `ajv` in the extension (an extra dependency and duplicated validation; to be re-evaluated if third-party backends that emit the model appear) |
| D14 | editing the QuickUVM YAML through the `yaml` library (eemeli), on a `Document` with the comments preserved; applied as a single `WorkspaceEdit` | the mutations touch only the targeted nodes — the comments, the formatting and the fields the extension does not understand stay intact (the "surgical edits" requirement of docs/03); undo/redo stays native | full serialization with js-yaml (it loses comments and format); regex edits on the text (fragile against the equivalent YAML styles) |
| D15 | the "explicitly ignored" state of the ports is persisted in the QuickUVM YAML, under the own block `x_quickuvm_architect.ignored_ports` (initially named `x_quickxray`, renamed mechanically by D17) | it is a decision of the verification's configuration, so it belongs to the source of truth (not to the layout sidecar); the Pydantic v2 of QuickUVM ignores unknown fields — validated empirically with `generate --dry-run` on 0.9.1 | the layout sidecar (it would mix verification with geometry); YAML comments as a data carrier (fragile under manual editing) |
| D16 | a complete graphical editor of the QuickUVM configuration as a dedicated phase (3b): "the verification view" — the diagram of the TB environment (agents, scoreboards, coverage, vsqr, subenvs) with direct editing (palette, connecting with the mouse), after phase 3 | an objective expressed by the user (Jul 2026); the configuration beyond the mapping onto ports (analysis, subenvs) has no geometric representation today — only a form; phase 3 brings exactly the necessary infrastructure (multi-node, router, drag, sidecar), so the order 3→3b minimizes rework; the `CustomEditor` on `*.quickuvm.yaml` (mentioned as post-MVP in doc 05) becomes the packaging of this view | only a read-only view with editing in a form (it covers ~80% of the value, but not the requested objective); an editor before phase 3 (edges without a router → rework); a separate tool outside the extension |
| D20 | the interconnect router = **our own A\* grid router** (`src/webview/router.ts`); the libavoid-WASM comparison closed on the basis of evidence, without a complete prototype | our own prototype was hardened on three real scenarios found at the interactive validation (each became a regression test): channels walled in by halos+texts, pins facing each other with adjacent blocks, blocks closer than two halos; ~2ms per full re-route on the regression design; zero dependencies; a terrain with costs that can be calibrated in a single place (bends 4, overlap 8, crossing 2, halo 6, labels 10, proximity 1) — exactly the "total control of the aesthetics" anticipated in docs/04; a libavoid-WASM prototype would have required an Emscripten buildchain + ~400KB of WASM just for confirmation. **Conditions for re-evaluation**: mature nudging of the parallel segments, or junctions, become a requirement; degraded performance on large designs; systematically unroutable scenarios | libavoid-WASM (heavy integration, a large dependency, costs that cannot be finely calibrated); postponing the decision (the router is on the critical path of phase 3b) |
| D21 | the seeds of interactive ELK are **total or none**: the first position gesture persists the snapshot of the whole view (`layout/snapshot` — nodes, folds, boundary flags), and when an arranged view is rendered, the elements without a seed are pinned immediately at the position inserted by ELK; the views not visited by any gesture stay completely automatic | a real regression reported at the interactive validation: with partial seeds (only the dragged elements), INTERACTIVE mode re-places the non-persisted elements differently from the full layout the user saw — proven headless: the boundary flags jumped by up to 384px vertically on reopening, deterministically (the repro `scratchpad/repro-port-drift.mjs`); the audit of the re-render paths showed that ANY trigger (overlay, theme, fold, net/render, recompilation) could move the untouched elements once the seeds were partial; docs/04 already promised "the positions (computed or moved) are persisted" — the implementation persisted only the moved ones | persisting only the dragged elements (the bug); a snapshot at the first opening of any view (it fills the sidecar for views that were only visited); a full re-layout at every reopening (it breaks invariant 3) |
| D22 | design references for phase 3b (research of Jul 2026, three parallel investigations): **bigUML as a map of UX patterns and declarative architecture; GLSP/Sprotty rejected as a technical stack** | GLSP is server-authoritative: the live model sits in `ModelState` on the server, undo/redo is the server's own command stack, the VSCode integration is a **non-text** custom editor (Ctrl+Z delegated as an `UndoAction` to the server — verified in `glsp-vscode-connector`), saving = a full rewrite; the file is "dead" while the diagram is open — the head-on opposite of invariant 2 (the YAML as the source of truth, minimal `WorkspaceEdit`, native text undo, concurrent manual editing). Adopting it would replace D5/D20/D21 without any new capability (~6–9MB, ~15 packages, Inversify on both sides, snabbdom in the webview) and cannot express our split: the diagram is the projection of the SV design, the edits target ANOTHER file. **What we borrow from bigUML**: generic operation handlers driven by metadata (palette, creation paths, defaults, legality rules generated from a declarative source — for us the QuickUVM YAML schema), edge type hints with legality feedback during two-step connecting, text-vs-diagram version counters for synchronization, the property palette as a separate VSCode view gated on a context key, keybindings in `package.json` with when-clauses. **External precedents**: AWS Workflow Studio proves `CustomTextEditorProvider`+`WorkspaceEdit` at production scale, but with full replacement and a YAML→JSON→YAML round trip that loses the comments — the surgical edits through the CST in `yamlops.ts` remain the differentiator, unsolved by any tool in the survey; Structurizr/LikeC4 independently validate the geometry sidecar (LikeC4 migrated from comments in the source to separate `.snap` files); drawio shows the echo suppression (flag + normalization) in dual text+diagram editing and the explicit forwarding of the undo from the webview to the host. The consequence for D16: the packaging of 3b is a `CustomTextEditorProvider` on `*.quickuvm.yaml`, not a non-text custom editor | adopting GLSP+Sprotty (rewriting the rendering, the protocol and the router; non-text undo); client-only sprotty without a GLSP server (it would still replace our own SVG of D5 and the router of D20); a non-text custom editor with an undo of its own (it loses the native undo/diff/manual editing of the YAML) |
| D23 | **draw.io / mxGraph rejected as the editing engine for the verification view; kept as a UX reference** (a question of principle, Jul 2026) | the same underlying rationale as D22 (GLSP), plus what is specific to draw.io: (1) **it would invert the source of truth** — mxGraph is designed to own the model (the cell model) and to serialize it into its own XML; either mxGraph becomes the authority (the YAML derived → `quick-uvm generate` from XML, the manual editing/diff/comments are lost, it breaks invariant 2), or the YAML stays canonical and has to be synchronized bidirectionally with an engine that wants to be the authority ("fighting the framework"); (2) **the TB diagram is a semantic projection, not a free drawing** — the nodes/edges derive from the config, and the "connection" in QuickUVM is the `source`/`monitor` field, not a free edge; the gesture is "add a scoreboard" = a YAML mutation, not "drag a rectangle"; draw.io is a generic drawing editor, it would have to be constrained massively (custom shapes, connection validation, blocking the free drawing); (3) **it would throw away the hardened infrastructure for no net gain** — hierarchical ELK layout (the UVM containment), the A* grid router (D20), drag+sidecar with total seeds (D21), a versioned protocol; draw.io has its own generic layout/routing, either I accept them (I lose the aesthetic control of D5/D20), or I disable them by imposing our positions (draw.io becomes a heavy ~1–2MB renderer, with no reason to use it); it goes against D5. **What we borrow** (as from bigUML): draw.io interaction patterns — colour-coded fixed/floating endpoints, editing waypoints by segment-drag, connection points, the directional clone menu. **Condition for re-evaluation**: only if the TB view were to become a free-form drawing canvas where the user places geometry that does NOT map 1:1 onto the YAML — but that would be another product, one that sacrifices the differentiator "the YAML is the source of truth" | draw.io as a complete editor application (it replaces the webview; mxGraph the authority over the model); mxGraph as a diagramming library we build on (a large dependency, it owns the model, against D5); the `.drawio` format as storage (irrelevant — the YAML is the format) |
| D25 | **the testbench top drives the DUT's reset: `setDut` writes `reset: {external: true}`, derived from the document, with no checkbox** (Nov 2026) | the MVP was declared validated on `quick-uvm generate`'s exit code; the first real compile of the tutorial bench (Xcelium 25.09) failed at elaboration — `tb_top` connected the DUT to `cmd_if_inst.rst_n`, a signal `cmd_if` does not have. Probed on quick-uvm 1.1.0 (docs/quickuvm-schema-reference.md §1.4.1): a single-reset bench works when the top drives the reset (`external: true`) or when an agent declares the port; the third shape — neither — validates, exits 0 and does not elaborate. Architect excludes reset pins from agents by design (the reset role, docs/03), so the third shape was EVERY Architect bench with a reset, and the "External reset" checkbox, unchecked by default, chose it. Deriving the flag (a reset port, a clocked DUT, no agent declaring it) removes the wrong answer instead of defaulting away from it; the hand-written agent-driven shape stays legal and `setDut` respects it. The derivation stops where the generator's own walls are (a combinational DUT, `kind: selftest`, an agent with `reset_port` — docs/03). Existing configs get the `reset-undriven` error with a one-click repair (`external: true`, or `dut.reset: ''` where the top cannot drive the reset). `npm run test:e2e` now lints the generated top (every signal connected to a DUT port must be declared) on every scenario, and compares the tutorial's YAML listing with what the mutations write | keeping the checkbox with the default flipped (the unchecked state is still a bench that does not elaborate — a choice with one valid answer is not a choice); putting the reset pin into the primary agent's `inputs` (quick-uvm's `init` shape: the reset becomes a randomised field of that agent's sequence item, changes the transaction and the coverage, and contradicts the reset role); waiting for the generator to refuse the config (the gap is reported upstream, `docs/upstream-quickuvm-reset-undriven.md`, but installed 1.x versions stay as they are) |
| D24 | **unified navigation by levels, without the Symbol/Schematic switch** (a UX revision, Jul 2026) — it partially replaces D18: the separate "Symbol" mode disappears | the symbol of a block is already visible as its representation (a box with pins) in any schematic in which it appears, so a stand-alone symbol view of every module is redundant, and the mode switch produced confusion. A single model: every diagram (DESIGN and TB) shows **the current level** with its blocks as interconnected symbols; **a double-click on a block** descends into its structure (the schematic of the child instances for RTL; sequencer/driver/monitor for an agent; the agents for the Env), with the selection synchronized in the tree panel and a breadcrumb for going up. **The DESIGN root** = the symbol of the top (one block) with a "Set top module" button; **the TB root** = the Testbench (DUT + Env). A leaf (a module without internal instances) remains jump-to-source on double-click. What disappears: the Symbol/Schematic switch in the header, the stand-alone symbol view of the internal modules, the "Open symbol" button of the inspector. What stays: the drawing of a block as a symbol (a box with pins) in any schematic + the root = the symbol of the top. The terminology of D18 (Symbol/Schematic) stays for glyphs/code, but it is no longer a switchable mode. **Implementation** (Jul 2026): the DESIGN root is a synthetic node "top module" DISTINCT from the node of the top instance — a click on "top module" → the symbol of the top, a click on the top node (and on any named module) → the internal schematic; this way the symbol/schematic distinction is reflected in the tree's selection even at the top level (a refinement requested by the user, otherwise the symbol and the schematic of the top had no distinct nodes to select). `nav/drill.mode` carries the mode to the host for the correct reveal (the synthetic root vs the instance node); `model/full` does NOT re-send `nav/drill` at the first opening (it would race with the host's explicit `view/show`) | keeping the Symbol/Schematic switch (the original D18 — a source of confusion confirmed by the user); the DESIGN root = the schematic of the top directly (the user explicitly wants the symbol of the top as the entry point + set-top); a symbol view on leaves (it reintroduces a redundant empty level) |
| D27 | **a wire can be routed by hand: level 3 of the routing overrides (D7) is a SKELETON anchored to the pins, stored per edge, edited per wire, dormant when it no longer fits** (Nov 2026; six choices, each asked of the user) | D7 deferred level 3 to "demonstrated demand", and level 4 (wire ↔ label) did take most of it away; the demand that remained came from hand-arranged diagrams (tutorial figures): the user could move every block and flag and still could not move a wire. The shape of the answer: (1) **relative means "an offset from a pin"** — a route is the list of the wire's interior segments, each storing the distance of its line from the pin at one end of the edge (`route: source+16 source-40 target-16`), so moving a block carries the segments measured from its pin and stretches the rest, moving both ends moves everything, and the file holds no coordinate and nothing derived (the rule of the sidecar); (2) **per edge in the file, per wire in the hand** — an edge id names two pins, which is what orphaning needs, but a net with fan-out is several edges on one trunk: a gesture freezes the whole wire group as drawn (WYSIWYG — nothing else jumps), moves a straight run as one line, and makes the segments sharing a run follow the pin their edges have in common, or one block move would split the trunk; (3) **dormant, not deleted, not clamped** — a skeleton that would leave its pin backwards or cut a block where the blocks stand now is not drawn: the router takes that edge, the override stays in the file and returns when it fits (a trial flip costs nothing), in the spirit of invariant 5; (4) **blocks are walls for a hand, texts and other wires are not** — a drop that cuts a box is refused with a reason, so the file never holds a route that was invalid when it was made; (5) the hand-placed routes occupy their cells in the router FIRST, so automatic wires of other nets keep off them; (6) reset is explicit (context menu, inspector, palette) and "Re-arrange all" discards the routes with the positions they were drawn for. Built on our own router and SVG (D5, D20) — the re-evaluation towards a diagramming library that docs/04 reserved for this case was not needed: ~700 lines of pure rules with their own suite (`test:wireroute`) | the docs/04 sketch `{segment, offset}` relative to the AUTOMATIC route (the automatic route changes its number of segments on almost any move — "segment 1" means something else each time); a pinned segment handed to A\* as a constraint with the rest routed automatically (more adaptive, but the rest of the wire jumps while one segment is dragged, and a constraint that stops making sense produces loops instead of a clean fallback); absolute waypoints (rejected since D7: a moved block leaves its wire behind); clamping an invalid route to the nearest legal position (routes that neither the user nor the router drew); deleting an invalid route (a trial flip loses the work); routes stored per net (a net's edge set changes with a fold and with every new sink — per edge, the unaffected edges keep theirs); a diagramming library (JointJS, the reserve D5 named) |
| D26 | **secondary notation (frames, sticky notes, node colours) is an annotation of the VIEW, kept in the layout sidecar — never part of the verification model** (docs/08 R21, Nov 2026; the author's explicit answer to the re-evaluation condition of D23) | D23 rejected a generic drawing engine because the TB diagram is a semantic projection of the YAML, and named "geometry that does not map 1:1 onto YAML" as the point where that must be decided again. Frames, notes and colours are exactly such geometry — and they are what Green & Petre call secondary notation: layout, grouping and comments that carry meaning for the READER and none for the generator. The line is therefore drawn by WHERE they live and what they can do: (1) the sidecar, next to the positions, under the same per-view (per-level) key — invariant 2 is untouched, the YAML stays the only source of truth for verification, and `quick-uvm generate` does not change by a byte; (2) a frame stores its MEMBERS, not a rectangle — its box is derived from where the members are, so it cannot become a free shape; (3) nothing in them is read back into the model: no frame means "a subenv", no colour means "an error", no note is parsed; (4) they are invalidated gracefully, like every override (invariant 5): a coloured node that disappears migrates with its colour, a frame with no live member and a vanished view's frames and notes migrate whole and come back with their targets. Free drawing (arbitrary shapes, connectors that are not wires, text on wires) stays out: it would be a second, unvalidated model on the same canvas | storing them in the QuickUVM YAML under an extension key (rejected by quick-uvm 1.0: unknown keys are refused, and it would put view state into the verification source — the rule from D15's promotion: intent → schema key, view state → sidecar); frames as stored rectangles with resize handles (free geometry that outlives its content and breaks on every re-arrangement); a separate annotations file (a second file to keep in step with the same views); no secondary notation at all (the criticism the research records against node editors without it) |
| D18 | the EDA terminology adopted **in full**, in English: **Symbol view** (historically "the context view", „vederea de context") and **Schematic view** (historically "the interior view", „vederea de interior") — in the UI, the protocol (`ViewMode: symbol\|schematic`), the commands (`quickuvm.openSymbolView`/`openSchematicView`), the files (`src/webview/schematic.ts`) and the documentation ("the symbol view"/"the schematic view" — „vederea-simbol"/„vederea-schemă" in the Romanian documentation of the time); a decision taken in two steps on the same day (first only the UI, then extended to everything, at the user's request) | the target audience comes from Verdi/Vivado/DVT and recognizes the pair instantly; "context" could wrongly suggest "where the module is used"; a partial adoption would have left a permanent translation layer between the docs, the UI and the code; the moment is the cheapest in the project's history (pre-git, pre-Marketplace, pre-sidecar — the vocabulary chosen now is the one that will be persisted on disk), the reasoning of D17 | only UI labels with the identifiers `context`/`interior` (the initial variant — a permanent translation layer); keeping "Context/Interior" in the UI (it required explanation — a sign that the name was wrong); Romanianizing to „Simbol/Schemă" in the UI (replaced by D19, the UI entirely English) |
| D19 | the UI language of the extension = **English**, with localization through the native VSCode mechanisms: `package.nls.json` (+`package.nls.ro.json`) for contributions, `vscode.l10n.t()` + `l10n/bundle.l10n.ro.json` for the host; **Romanian shipped as the first translation** of the native part; the webview stays monolingual English in the MVP (the extraction into a string table is done when a second language appears); the logs (Output) are not localized; the documentation and the code comments stay in Romanian (the existing convention) | the Marketplace audience is international — English is the de facto default language; the l10n plumbing installed now costs little and avoids the retrofit; the existing Romanian strings are not lost, they become the official translation | a Romanian UI with an English translation later (a restricted audience by default); full i18n including the webview from the start (an effort out of proportion for the MVP; VSCode offers no native mechanism for the webview) |
| D17 | a rename: QuickXray → **QuickUVM Architect** (id `quickuvm-architect`, technical namespace `quickuvm.*`, palette prefix `QuickUVM Architect:`); it replaces D11, which stays as history | the extension by D16 changes the identity of the product from a diagnostic instrument (X-ray = looking) into a bidirectional workbench (looking + designing); "architect" is the real role in the industry (verification architect) and the standard phrase "UVM testbench architecture" — exactly what 3b edits; a sub-brand of QuickUVM = no collisions by construction + a unitary ecosystem with the generator; the moment is cheap (pre-Marketplace, pre-git). The consequent mechanical renames: the YAML block `x_quickxray` → `x_quickuvm_architect` (D15), the planned sidecar `*.quickxray.yaml` → `*.quickuvm-architect.yaml` (doc 04), the schema's `$id`/`title` | QuickUVM-design/QuickDesignUVM ("design" = the DUT in verification jargon — confusing); QuickUVM Sketch ("sketch" = a rough draft, unsuited to a precision editor); QuickUVM Studio/Canvas (correct but generic; "Architect" names the activity, not the room); QuickCanvas/QuickHarness/QuickBlueprint as standalone siblings (they lose the explicit link with QuickUVM; Canvas is crowded in other categories) |
