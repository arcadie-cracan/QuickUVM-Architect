# CLAUDE.md — context for the working sessions on QuickUVM Architect

## What the project is

A VSCode extension for the design of digital integrated circuits: it visualizes
a SystemVerilog design as an interactive diagram and generates, by selection on
the diagram, the YAML configuration for the QuickUVM testbench generator
(https://github.com/arcadie-cracan/QuickUVM). Read `README.md` and then
`docs/01-arhitectura.md` … `docs/06-plan-mvp.md` before any change — the
architectural decisions are already made and motivated there; do not reopen
them without a new reason.

## Architectural invariants (never to be broken)

1. **The JSON project model is the stable contract** between the backend and
   the UI (`schema/project-model.schema.json`). The backend (pyslang today) is
   replaceable; the UI never sees the slang API directly.
2. **The QuickUVM YAML file is the source of truth** for the verification
   configuration. The UI keeps no configuration state of its own: every action
   produces a text edit in the YAML (through `WorkspaceEdit`), so undo/redo,
   diff and manual editing work naturally.
3. **Node positions belong to the user.** A full automatic layout only at the
   first opening or at the explicit "Re-arrange" command; on design changes,
   ELK runs in interactive mode only for the new elements. The positions are
   persisted in the sidecar file (`docs/04-layout-si-rutare.md`).
4. **Stable IDs** = the elaborated hierarchical paths (`demo_top.u_soc.g_ch[1].u_ch`).
   Every addressable element (node, pin, net, view) is identified by them.
5. **Graceful invalidation**: overrides (positions, waypoints) whose targets
   disappear from the design are marked orphaned, not deleted automatically.
   The diagram does not disappear on broken code — the last valid model stays
   + a banner.

## Code conventions

- **EVERYTHING IN ENGLISH** (decision 2026-07-30 — this IS the "separate
  decision" the old rule was waiting for): not only the comments in `src/**`,
  `backend/**`, `scripts/**` (the rule of 2026-07-20, for the growth of the
  community), but also the **documentation**: `docs/**`, this file,
  `README.md`, the error messages thrown from the host and the fixture
  comments in `examples*/**`. Python backend: PEP 8.
  **The migration is complete** (Nov 2026) — the corpus was large (~3100
  lines with Romanian at the date of the decision, most of them in
  `docs/06-plan-mvp.md`, `CLAUDE.md`, `docs/07-plan-post-mvp.md`,
  `docs/04-layout-si-rutare.md`). First the documentation and the user-facing
  strings (`docs/**`, this file, `README.md`, the error messages thrown from
  the host, the header written into a new configuration), then the code's own
  text: the test names, assertion messages and summary lines of
  `scripts/*.mjs`, the comments of `media/webview.css` and
  `scripts/harness.html`, the backend's tests, the fixture comments, the
  schema's descriptions, `.gitignore` / `.gitattributes`. What stays Romanian
  ON PURPOSE: the UI bundles (`l10n/bundle.l10n.ro.json`,
  `package.nls.ro.json` — they ARE the Romanian translation) and the
  historical terms a few documents quote („vederea-simbol"). The rule for any
  session: **add no new Romanian anywhere** — comments, test names, messages,
  fixture names. A translation is a careful rewrite, not a mechanical
  substitution: the documents are dense architectural records (the pitfall
  lists, the decision journal), where an approximate rendering loses exactly
  the reason the rule exists. Translating a test file must change TEXT only:
  compare the file with its previous version once comments are removed and
  string contents blanked, and read the list of changed string literals —
  each must be a name, a message or a printed line, never data (a Romanian
  name inside a fixture is renamed consistently, input and expected value
  together, and proved by its suite).
  Communication with the user in chat stays in Romanian with diacritics.
- **The extension's UI: English** (decision D19), localized through
  `package.nls.json` (+`package.nls.ro.json`) and `vscode.l10n.t()` +
  `l10n/bundle.l10n.ro.json`; every new user-visible string in the host is
  wrapped in `l10n.t()` and gets its translation in the ro bundle; the webview
  is monolingual English in the MVP; the logs (Output) are not localized. The
  **Symbol view / Schematic view** terminology (D18) is adopted throughout: UI,
  protocol (`ViewMode: symbol|schematic`), commands
  (`quickuvm.openSymbolView`/`openSchematicView`), files
  (`src/webview/schematic.ts`), documentation ("the symbol view" / "the
  schematic view"; „vederea-simbol" / „vederea-schemă" while the documents
  were Romanian).
- The extension: strict TypeScript, no framework in the webview (hand-generated
  SVG + elkjs); the extension↔webview messages follow the versioned protocol in
  `docs/05-ui-si-protocol.md` — any new message is added there first.
- Do not introduce large dependencies without a written justification in the
  decision journal (`docs/06-plan-mvp.md`, the "Decision journal" section).

## How to run and test the backend

```bash
pip install pyslang
cd examples
python3 ../backend/svmodel.py adder.sv inverter.sv chan.sv soc_top.sv \
        --top demo_top -o model.json
```

`examples-probe/deep_pipe.sv` is a separate fixture for cross-probing (8
modules in a single file, instantiated in a chain by `deep_pipe`; their ports
are on lines far apart, so that hovering the pins visibly scrolls the source —
the launch configuration "cross-probing: deep_pipe").

`examples/soc_top.sv` is the regression design: it deliberately contains
propagated parameters, symbolic widths, `generate for`, an unpacked array of
ports, an interface with modports and connections through concatenation/select
— if a change to the extractor keeps all of them correct in `model.json`, it
is probably sound. The key checks expected:

- 8 instances, including `demo_top.u_soc.g_ch[0..2].u_ch` (NCH=3 propagated, not 2);
- `soc_top.ch_out`: `width=48`, `unpacked_dims=[3]`, `elem_width=16`;
- `chan` elaborated with `W=16`: ports `logic[15:0]`, `width=16`;
- `demo_top.bus_i`: modport `slave` with `addr/wdata/we: in`;
- in the view `demo_top.u_soc`: `din` has `fanout=9`, `render=label`;
  the pin `g_ch[1].u_ch.dout` has `conn.kind=select`, `index="1"`.

The checks are implemented as pytest tests in
`backend/tests/test_svmodel.py` (plus a snapshot against `examples/model.json`
and validation against the JSON schema). Run them after any change to the
extractor:

```bash
pip install -r backend/requirements-dev.txt
python -m pytest backend/tests
```

## How to build and run the extension

```bash
npm install
npm run build            # esbuild: dist/extension.js + dist/webview.js
npm run typecheck        # tsc --noEmit (strict)
npm run test:scene       # the schematic view's scene (Node, no DOM)
npm run test:tbscene     # the level-based scene of the verification view (phase 3b)
npm run test:tblayout    # the TB layout: the sides of the ports, flip, seeds
npm run test:tbtree      # the verification hierarchy tree (phase 3b, Node)
npm run test:yamlops     # the pure YAML mutations (+ topConfigPaths/isComposedChild)
npm run test:filelist    # the slang paths/lists: .f quoting, the outputDir exclusion, loc.file
npm run test:heuristics  # the name heuristics: clock/reset/active-low (_ni/_bi)
npm run test:configcheck # the pure core of the model<->YAML validations (hybrid, widths)
npm run test:probe       # the pure module of the K2 probes (XMR path + width, on the real model)
npm run test:compose     # the H1 composition: connections + subenvMapping + planWireEdits
npm run test:sidecar     # the pure mutations of the layout sidecar
npm run test:router      # the A* grid router + the obstacles from the pin labels
npm run test:minimap     # the minimap math (fitting, U = M ∘ V⁻¹, jump)
npm run test:locmap      # editor->diagram cross-probing: loc->target + target->ids
npm run test:status      # the status decorations: findings->decorations + decorations->ids
npm run test:navfind     # keyboard navigation (docs/08 R5): view history, Ctrl+F ranking, up-level, fit bounds; level of detail (R6): hysteresis, title fit
npm run test:textedit    # the MINIMAL edit between two YAML texts + the span to highlight (docs/08 R4)
npm run test:yamlmap     # YAML caret -> TB element and element -> YAML span (docs/08 R4)
npm run test:wiring      # the temporary-wire rules (docs/08 R10/R11): origins, legality, drop outcomes
npm run test:arrange     # selection / arrangement geometry (docs/08 R7): marquee modifiers, lasso rules, align, distribute, straighten
npm run test:wireroute   # hand-routed wires (docs/04 level 3, D27): the skeleton anchored to the pins, freeze, grab / drag / jog, validity and dormancy, wire groups, the router's fixed routes
npm run test:annotations # secondary notation (docs/08 R21): frames as member lists, notes, colours, the drop-into-frame test, note wrapping
npm run test:overlay     # the design views' configuration overlay: claimed pins (inouts included), roles, boundary coverage
npm run test:results     # simulation results (docs/08 R25): UVM log + run verdict + attribution by reporter path + imc summary + the per-level projection, on real Xcelium runs
npm run test:templates   # "New testbench" templates (docs/08 R24): per interface, per clock domain, composition — what each plan writes and what it leaves out
npm run test:signals     # the Signals view's model (docs/08 R24): clock / reset domains with their agents, the Unconnected folder, what a drop writes
npm run test:matrix      # the matrix editor's model (docs/08 R22): agents x scoreboards/coverage, block outputs x inputs, cell legality
npm run test:filters     # per-view filter rules (docs/08 R23): matching, first-rule-wins, wires with their ends, sanitising, unsafe patterns, the indicator
npm run test:proposals   # designer assistance (docs/08 R12): interfaces/pin groups without an agent, unwired subsystems, inferred ghosts
npm run test:preview     # the diff preview (docs/08 R19): the +/- line summary of a gesture, the files that change
npm run test:trace       # diagram <-> generated code (docs/08 R20): file owner, identifier pattern, lit lines, lenses, report
npm run test:e2e         # yamlops -> real quick-uvm generate + the elaboration lint of every generated top (needs quick-uvm)
npm run shots            # the tutorials' figures: the real webview, captured (docs/tutorial-shots/); `-- --arrange` to place the blocks by hand first
```

F5 in VSCode (the configuration "Run the extension (examples/: demo_top
regression design)") opens an Extension Development Host on `examples/`, where
`quickuvm.top=demo_top` is preset in `.vscode/settings.json`. The webview can
also be tried without VSCode with `scripts/harness.html` (an
`acquireVsCodeApi` stub + the regression model):
`python -m http.server 8123` from the root, then
`/scripts/harness.html?view=demo_top.u_soc&mode=schematic` (add `&nomodel=1`
to simulate the per-file editor of slice 4: the TB view from the config alone).
For the **closing validation of the MVP** there is a step-by-step tutorial —
`docs/tutorial-yapp-buffer.md` — with the fixture `examples-yapp/yapp_buffer.sv`
(the launch configuration "tutorial: yapp_buffer"); the steps are verified
empirically (svmodel parses the design, and the resulting config generates
cleanly with quick-uvm).
**The fixture is NOT the YAPP router** (renamed Jul 2026): the router is the
1→3 demux in `QuickUVM/examples/yapp/rtl/yapp_router.sv`
(`out0_*`/`out1_*`/`out2_*`, a single agent), the subject of the walkthrough
`docs/yapp-router-walkthrough.html` and of the captures in
`docs/tutorial-shots/`. The fixture is its reduction to a one-slot buffer,
because the `ready` handshake in both directions is what gives the **two**
agents the closure criterion requires. As long as both modules were named
`yapp_router`, the tutorial's steps and the captures described different
designs — do not reintroduce the name collision.

## Known pitfalls (discovered at validation)

> **The authoritative schema reference is `docs/quickuvm-schema-reference.md`**
> (probed empirically on quick-uvm 1.0.0: verdicts A1–A26, key tables, the
> error messages verbatim). The notes below mark locally what changed at 1.0;
> on a conflict, the reference wins. The extension may condition on
> `quick-uvm --version` >= 1.0.0 (the schema is frozen, the deprecations come
> with teaching errors).

- **The port waiver (D15) is the SCHEMA key `dut.unverified_ports`**
  (quick-uvm >= 1.0.0): 1.0 rejects ANY unknown key (extra="forbid", the `x_`
  prefix included), so the old `x_quickuvm_architect` block was PROMOTED into
  the schema, not worked around. The rule: verification intent → a schema key;
  view state → the sidecar; no intermediate `x_` basket. A waived port that an
  agent connects is REFUSED by the generator at generate ("connected by agent
  ... Remove it from one side") → the `ignored-and-mapped` diagnostic is now
  an ERROR, and on emptying ONLY the key disappears (the `dut` block stays —
  it is mandatory configuration).

- pyslang 11 is organised in submodules: `from pyslang.driver import Driver`,
  `from pyslang import ast`; many C++ `getX()` methods are `x` properties.
- `Driver.reportCompilation` can return unintuitive values, and with
  `quiet=True` it **swallows the diagnostics completely** (invisible errors, a
  degraded model emitted silently — a real regression caught on common_cells).
  `svmodel` uses `comp.getAllDiagnostics()` + `DiagnosticEngine.reportAll()`
  on stderr and refuses the model on errors; do not reintroduce
  `reportCompilation`.
- `bender script flist` does NOT emit `+incdir+`/`+define+` (it loses
  `export_include_dirs` from Bender.yml, the includes fail); the extension
  uses `bender script flist-plus`. The `+incdir+` paths with spaces are quoted
  on the inside: `+incdir+"path"` (validated with slang 11).
- The connections of the output ports come wrapped in an
  `AssignmentExpression` (the external side is `.left`); the inputs may come
  in a `ConversionExpression`.
- The syntactic text of the selects inside a generate keeps the genvar
  (`ch_out[g]`); the numeric index per instance is taken from
  `e.selector.constant`.
- The GitHub API is rate-limited from some environments; prefer
  `pip install pyslang` or cloning directly from `github.com`.
- `Driver.parseCommandLine` splits on spaces: the paths (files, `-f`) are
  quoted with double quotes — both on the synthetic command line in
  `build_model` and on the lines of the `.f` files the extension generates.
- slang relativizes `loc.file` to the process's cwd (it can come out as
  `..\..\...`); the host reconstructs the absolute path by a join with the
  workspace root (`resolveLocPath` in `src/filelistops.ts` — pure, tested in
  `test:filelist` —, consumed by `openLoc` in `src/panel.ts`).
- ELK `FIXED_ORDER` counts the ports clockwise: on the west side the index
  grows from bottom to top — the visual order is obtained by reversing the
  indices (`layoutSymbol` in `src/webview/main.ts`).
- ELK layered puts the nodes without incoming edges in the first layer, and
  packs the unconnected ones as separate components: the boundary ports of
  the schematic view need `layerConstraint: FIRST_SEPARATE/LAST_SEPARATE`
  **plus** `separateConnectedComponents: false` — with a plain `FIRST/LAST`,
  the flags get mixed in among the instances whose inputs are labelled nets
  (`layoutSchematic` in `src/webview/schematic.ts`).
- On the nets with several sources (slices assembled through select,
  `ch_out`), the edges are drawn from every source to every destination —
  with a single chosen "driver", the other sources would become targets and
  the layering breaks (`buildSchematicScene` in `src/webview/scene.ts`).
- The pins of the interface instances have NO direction of their own (an
  interface signal is not intrinsically in/out — the direction is given per
  modport, at the connected module); if their side stays fixed (WEST, like
  the input ports), the wire of a net without a clear driver (e.g. `clk`
  between `bus_i.clk` and `u_soc.clk`) leaves on the side opposite the target
  and goes around the whole block (384px, 4 bends). The side of the interface
  pins is oriented by their role in the net (source → EAST, destination →
  WEST), and on the nets without a clear driver the interface instance is
  preferred as the source (`buildSchematicScene`).
- The SOFT text obstacles of the pins (net labels / const annotations, drawn
  outside the block) must be limited to the HEIGHT of one pin pitch
  (`PIN_PITCH`, no more): a taller obstacle bleeds into the neighbouring
  pin's row and forces its wire onto a needless staircase detour
  (`routeEdges` in `src/webview/schematic.ts`). `PIN_PITCH` is now **24** (it
  was 16) — widened at validation, so that the decorations (`/N`, the
  const/split-join glyphs, the nc circles) have air between the rows; it
  stays a multiple of 8 (a pin on the grid = a straight wire).
- The annotation of a pin that is a wire end (the select `[N]` on `dout`, a
  concat) sits right on the path of its own wire, like its label — it must
  NOT be an obstacle for it, otherwise the wire goes around its own label
  with needless bends (e.g. `g_ch[0/2].u_ch.dout → ch_out`: 4 bends instead
  of 2, a down-then-right "hook" at the exit). `routeEdges` skips the
  obstacle of the pins that are the ends of a wire edge (`wirePins`); the
  annotations of the pins WITHOUT a wire (const `=1'b1`, nc, net labels)
  remain obstacles for the wires of OTHER nets.
- In the TB view, the port labels are always drawn ABOVE the port (`py - 5`,
  on BOTH sides), not on the wire's row (`drawBox` in
  `src/webview/tbschematic.ts`): the wire leaves horizontally at `py`, so the
  label no longer cuts across it. **The vertical alignment is CONSTANT under
  a flip** (the user's request at validation): H swaps the side west↔east,
  but NOT above/below — otherwise a flipped block would move its labels
  above↔below. The anchor (`end` on the west, `start` on the east) keeps them
  on the outer side, so the ports that face each other (DUT east ↔ Env west)
  stay separated HORIZONTALLY (~9px in the default layout, no overlap). The
  old note "east above/west below" (separation on opposite sides of the wire)
  is REPLACED — it gave an inconsistency on flip. Making the labels SOFT
  obstacles for the router was tried and REJECTED — it over-constrains the TB
  router (more crossings, not fewer).
- `cycleBreaking: INTERACTIVE` reverses edges according to the seed positions
  and throws `UnsupportedConfigurationException` in combination with
  `LAST_SEPARATE` on the boundary flags — the interactive mode uses only
  layering/crossingMinimization/nodePlacement INTERACTIVE (the directions of
  our edges are semantically fixed; `layoutSchematic`).
- The INTERACTIVE mode places the elements WITHOUT a seed differently from
  the full layout (the rows of the boundary flags get reshuffled — up to
  384px of vertical difference, deterministically): the seeds must be total
  or absent (D21). That is why drag-end sends `layout/snapshot` with ALL the
  positions of the view, and the rendering of an arranged view immediately
  pins the elements without a seed; do not reintroduce persisting only the
  dragged elements (a real regression: the ports jumped when the panel was
  reopened).
- ELK's port placement cannot be controlled finely: `portsSurrounding` is
  ignored at placement (it matters only at sizing), and the INSIDE labels
  inflate the pitch between the ports (24 instead of 16) — for the pins on
  the grid (docs/04), the ports are `FIXED_POS`, computed by `layoutSchematic`
  (`src/webview/schematic.ts`), with the node's dimensions rounded to 8.
- Measuring the text for the block's width must be done with **the font it
  is drawn with**: the pin/port labels are monospace
  (`--vscode-editor-font-family`), NOT the proportional UI font
  (`--vscode-font-family`). `measurer()` in `src/webview/svg.ts` used to
  measure everything with the proportional font, which underestimated the
  width of the (wider) monospace labels → blocks too narrow, overlapping
  west/east port labels (a real regression, exposed by the longer SV labels
  `[15:0] ch_out [0:2]`). `measurer` now takes a `mono` flag, and
  `layoutSchematic`/`buildPins` ask for the pin labels to be measured with
  `mono=true`; the names/parameters (proportional) stay on the UI font.
- The child Python processes are started with `PYTHONUTF8=1`: the Windows
  console is cp1252, and quick-uvm writes Unicode arrows (a real crash at the
  first echo); the same protection on svmodel too (the sources quoted in the
  diagnostics).
- On Windows, the `quick-uvm.exe` script can land in
  `%APPDATA%\Python\PythonXXX\Scripts` (a user install), outside the PATH;
  `generate.ts` has the fallback `python -c "from quick_uvm.cli import main; main()"`.
- The npm package `yaml` is CJS: bundling to ESM for the Node test scripts
  needs the `createRequire` shim in the banner (see `scripts/*.mjs`).
- `createSubenv` creates block configs (`<module>.quickuvm.yaml`) next to the
  top config, and the discovery of the active config (a glob on
  `**/*.quickuvm.yaml`) used to pick the first file alphabetically: the
  scaffold `chan.quickuvm.yaml` silently "stole" the active config at the
  next refresh (the DUT becomes `chan`, the overlay and the actions die on
  the soc views — inactive buttons with no explanation; a real regression
  caught at the interactive validation). The discovery is now stable (the
  active config does not change as long as its file exists) and excludes
  from the initial choice the files referenced as `subenvs[].config` by
  another config (`topConfigPaths` in `src/yamlops.ts`, tested in
  `test:yamlops`); do not reintroduce the purely alphabetical choice.
- **Gestures write the MINIMAL edit, never a whole-document replace** (docs/08
  R4, Oct 2026): `applyTextChange` in `src/config.ts` — shared by the active-config
  target and the custom editor's document target — replaces only the span
  `minimalEdit` (`src/textedit.ts`, pure) computed between the old and the new
  text, slid to a line boundary for pure insertions/deletions, and fires
  `onGestureApplied {uri, span}` for the YAML link (`src/yamllink.ts`: flash in
  the visible editors, or open beside per `quickuvm.openYamlBeside`). The old
  replace-all hid WHAT changed, churned undo and the editor's view, and would
  have made the highlight the whole file. A mutation that returns the same text
  is still no WorkspaceEdit at all (the no-op invariant).
- `ConfigService.apply` must refresh SYNCHRONOUSLY (`await refresh()`): with a
  debounced refresh, `checkDut` read the old `current` right after "Set this
  module as DUT" and `createSubenv`/`createAgent` aborted silently (a real
  regression on common_cells). The active-low suffixes include `_ni`/`_bi` (the
  PULP convention — `src_rst_ni`); do not narrow the regex to `_n|_b` —
  `ACTIVE_LOW_RE` lives in `src/heuristics.ts` (pure) and is locked by
  `test:heuristics`. NOTE 1.0: the polarity/externality are no longer written
  on `dut` (`reset_active_low`/`external_reset` are REJECTED with a teaching
  error) — `setDut` writes the TOP-LEVEL mapping `reset: {active_low, external}`
  and does not touch a hand-written `reset:` LIST (multi-reset domains);
  `external` is DERIVED, not asked (the reset pitfall below, D25).
- **The validation of composition (`subenvs`) was hardened in quick-uvm**
  (re-probed on the current build 0.9.2, Jul 2026 — the user has worked on the
  generator some more; `models.py` grew from ~2600 to 3216 lines). New HARD
  rules that the derived composition (slice 3, not yet implemented) must take
  into account: (1) `subenvs` require `layout: packaged` (already ensured by
  `createSubenvs`); (2) a subsystem bench requires **≥2 subenvs** — composing
  a SINGLE block is rejected at `generate` (a clear message, but only at
  generation); (3) the composed blocks **share a namespace**: the
  agent/interface/transaction/sequence names must be unique across DISTINCT
  block configs — two `subenvs` pointing to the SAME config (e.g.
  `g_ch[0].u_ch` and `g_ch[1].u_ch`, both `chan`) are OK (the same env-package
  reused), because `createSubenvs` names the agent `<module>_a` (distinct per
  module). **THE HYBRID IS LEGAL AGAIN** (quick-uvm >= 1.0.0, re-probed
  empirically: boundary agents, H2): a bench with `subenvs` MAY have agents of
  its own at the top — the "hybrid" diagnostic was REMOVED from ConfigService,
  and the lock in `test:e2e` now guards the opposite direction (if the
  generator forbade it again, the composition gesture with agents at the top
  would die silently). A PURE subsystem top (no agents) remains a
  combinational SHELL (`dut: {combinational: true, reset: ''}`) —
  `createSubenvs` sets it so, otherwise the phantom-clock guard of 1.0 refuses
  the generation (a top clock not connected to the DUT). **Nesting
  WORKS**: a subenv whose config is itself a subsystem is accepted
  (composition on several levels is valid, but every level requires ≥2). A
  corollary for "Compose into parent bench" (`composeIntoParent` → the pure
  `parentComposition` + `createSubenv`): a chain with a single subenv per
  level CANNOT be wired; the gesture composes the block + its SIBLINGS into
  the immediate parent (≥2). The rest of the facts about the probes (the 3
  bugs, the validation rules) remain VALID on this build — re-confirmed
  empirically.
- **`generate` exiting 0 is NOT "the bench elaborates" — and the reset is where it
  bit** (Nov 2026, D25). The MVP was validated on the generator's exit code; the
  first real compile of the tutorial bench (Xcelium 25.09) failed at
  elaboration: `tb_top` connected the DUT to `cmd_if_inst.rst_n`, a signal
  `cmd_if` does not have. Probed on quick-uvm 1.1.0 (the table is
  `docs/quickuvm-schema-reference.md` §1.4.1): a single-reset bench has two
  WORKING shapes — `reset: {external: true}` (tb_top declares the net, drives it
  from a generated `initial` block with the polarity honoured, passes it into
  every interface) or the port among an agent's ports (a field of that agent's
  sequence item) — and a third that validates, exits 0 and does not elaborate:
  neither. Architect keeps reset pins out of agents (the reset role), so the
  third shape was EVERY Architect bench with a reset. Rules that follow, each
  locked by a test: (1) `reset.external` means external to the AGENTS — `true`
  is the shape where the testbench top DOES generate the reset; the schema
  reference, docs/03 and the inspector's "Driven by" labels all had it backwards.
  (2) `setDut` DERIVES `external: true` (`resetNeedsExternal` in
  `src/yamlops.ts`: a reset port, a clocked DUT, no agent declaring the port) —
  `DutSpec.externalReset` and the "External reset" checkbox are gone; do not
  reintroduce a choice whose other answer is a broken bench. (3) Never clean
  `external: true` away as a "default": `collapseResets` restores it,
  `addResetDomain` drops it only because a LIST is always top-driven (and
  refuses an AGENT-driven reset — quick-uvm rejects the agent port that collides
  with the domain net; the old refusal of an EXTERNAL reset was the inverted
  reading, and would now block every bench). (4) The walls, each probed:
  `combinational` + `external: true` is refused and a combinational DUT's reset
  is left unconnected (so "Set as DUT" assigns no reset on a combinational DUT);
  `external: true` + an agent port is refused; an agent with `reset_port` (an
  agent-driven reset) is refused next to `external: true`; **`kind: selftest` +
  `external: true` exits 0 and hangs** — the DUT-less top instantiates
  `a_if a_if_inst (clk)` while the interface takes `input rst_n` and the drivers
  `wait (vif.rst_n === 1'b1)` (a second generator gap, in the upstream note);
  in a composition a NON-external clocked leaf gets no reset connection at all
  in the subsystem top (floating, no error). `resetNeedsExternal` and
  `externalBlocker` (`src/yamlops.ts`) hold these: `setBenchField("kind")`
  drops/restores `external` with the kind (a `vip` KEEPS it — the flag decides
  whether the VIP's interfaces take the reset, and VIP and consumer must agree),
  and `setResetDomainField(external, true)` THROWS where the generator would
  refuse. Agents are read through `doc.toJS()` there (anchors: `ports: *p`), and
  a null `reset:` is an empty mapping, not a crash ("Expected YAML collection" —
  which, once `external` is always written, would have hit every DUT with a
  reset). (5) Old configs: `reset-undriven` (`undrivenReset` in
  `src/configcheck.ts`, an ERROR, `test:configcheck`) on the reset pin and on
  Env. Its `repair` param chooses the fix: `external` (`editReset set external
  true`) or `clear` (`editReset clear` → `clearDutReset`: `dut.reset: ''`) when
  the top CANNOT be the answer — the model's DUT has no such port (`why:
  no-port`; an ABSENT `dut.reset` is the generator's default `rst_n`, so a DUT
  without a reset and without the key is the common case — the first cut stayed
  silent there and hid the very bug), or an agent has `reset_port` (`why:
  reset-port`). The badge fix (RTL pin and Env — `statusIdsRtl` passes the
  fixes on now), the Problems quick-fix (`ConfigFixProvider`, command
  `quickuvm.fixResetUndriven`) and the inspector row are ONE gesture. Silent
  for a combinational DUT, `kind: selftest|vip`, a pure subsystem top, and a
  bench with a `from_vip` agent. `setResetDomainField` and `clearDutReset`
  return the ORIGINAL text on a no-op. Consequence for fixtures: a test config
  that is not about the reset says `reset: ''` (`test:configcheck`). (6)
  `test:e2e` lints every generated top (`lintDutConnections`: each signal
  connected to a DUT port must be declared in the top or in the interface it is
  taken from — balanced parentheses, `#(...)` skipped, a clocking-block
  reference / an initialiser / a dimension / an assignment after `begin` is NOT
  a declaration; the lint has its own synthetic cases, the five holes of its
  first cut), compares the tutorial's YAML listing with what the mutations
  write, and keeps the old shape as a mutation proof — when a quick-uvm release
  refuses it, that branch says "fixed upstream" (the gaps are written up in
  `docs/upstream-quickuvm-reset-undriven.md`). The lint proves declarations,
  not behaviour: only a simulator proves the bench runs, and the extension has
  none — say "generates", never "works", about anything not compiled.
- **The `analysis:` block switches QuickUVM between implicit and declared
  mode** (probed on 0.9.2, RE-CONFIRMED on 1.0.0; `test:e2e` scenario 4):
  WITHOUT the `analysis:` key, the generator enters **implicit** mode and
  auto-wires a scoreboard AND a coverage collector onto the "primary agent"
  (`// Scoreboard (wired to primary agent: cmd)` in the env); WITH `analysis:`
  — even an empty `{}` — it enters **declared** mode and wires exactly what is
  listed (empty ⇒ nothing). So the delete mutations **are not allowed to clean
  up the emptied `analysis` block**: that would switch explicit→implicit and
  **resurrect** the scoreboard and the coverage just deleted from the diagram
  (you delete something, you get more back — a real regression, caught only by
  e2e, invisible to the pure tests). Only the child lists are cleaned
  (`scoreboards: []`/`coverage: []`), never the `analysis` mapping (see
  `keepAnalysis` in `src/yamlops.ts`). The `<agent>_cov.svh` file is generated
  anyway, per agent — `analysis` controls the **wiring in the env**, not the
  existence of the class.
- **The inferred components are drawn from `quick-uvm resolve`, never re-derived**
  (Aug. 2026, QuickUVM#118). Implicit mode wires a scoreboard AND a coverage
  collector onto the primary agent, so a config with no `analysis:` key generates
  three components where the YAML mentions one. The provenance comes from the
  generator (`src/resolved.ts` → `ResolveService` → `config/full.resolved` →
  `buildTbScene`); do NOT reimplement "implicit means sbd + cov on agents[0]" in
  TypeScript, however small it looks — it is generator policy, it has changed
  before, and a drift draws a bench that does not exist. Three invariants held by
  tests: (1) the cache is **per config uri**, because the custom editor can hold a
  config that is not the active one and a shared slot pairs one bench's ghosts with
  another's diagram; (2) `resolved` travels on `config/full`, never on its own
  message, so the two cannot interleave — and it is never awaited on the render
  path (the message carries the cache; a finished resolve re-posts); (3) `resolve`
  reads the file on **DISK**, so `buildTbScene` drops every ghost the moment the
  LIVE config has an `analysis:` key — otherwise hand-typing `analysis:` renders a
  declared scoreboard next to the inferred ghosts, a state the generator cannot
  produce. Ghosts are READ-ONLY: `tbDeleteTarget` returns `null` for them, which
  disables the inspector button, the `Delete` key and the context menu at once
  (all three resolve through it — gating the call sites separately is how one gets
  missed). The origin filter needs its OWN suite (`test:resolved`): at scene level
  it is masked by the dedup guard, and dropping it left `test:tbscene` fully green.
  Two more, caught at the merge review (Oct 2026): (4) the ghost rect has
  `fill: none`, SVG hit-testing ignores unpainted interiors, and node labels carry
  `pointer-events: none` — so the rect needs `pointer-events: all`, or the only
  clickable part of a ghost is its dashed stroke and the inspector's explainer is
  unreachable (proved in the harness); (5) the custom editor re-posts on
  `ResolveService.onDidChange` for ITS uri, not from its own `refresh().then`:
  ConfigService refreshes the active config on the same save, the newest request
  per uri wins, and the editor's own request was routinely superseded — its
  `.then` carried the previous cache and the winner's answer never reached that
  webview (ghosts one save late, in the file's default editor); (6) in
  `config.onOverlay`, `resolve.refresh` runs BEFORE the posts that read
  `resolve.current` — it moves the active pointer synchronously; posting first
  paired the new config with the old config's ghosts after a rediscovery. Known
  and accepted: drag/flip on a ghost DO persist under its id in the sidecar (D21
  total snapshot) — a later declared `sb:<name>` inherits the position; and the
  `drawn` dedup guard in `levelEnv` is unreachable by construction (no
  `analysis:` key ⇒ no declared sb/cov node), kept as a defensive wall only.
- **The whitebox probes (K2)** — probed empirically on quick-uvm 0.9.2
  (`ProbeConfig`/`validate_probes` in `quick_uvm/models.py`; `test:e2e`
  scenario 5): only `name` (an SV identifier) and `path` are mandatory; `width`
  defaults to **1** — a probe without a width silently TRUNCATES a wide
  signal, so the extension asks for it explicitly when it cannot derive it.
  `path` is pasted **verbatim** after `dut_inst.` in tb_top
  (`assign probe_if.<name> = dut_inst.<path>;`), so it is relative to the DUT
  instance and is **not validated** by the generator (a wrong path passes
  silently). Unlike `analysis:`, the `probes:` block does NOT switch modes —
  its absence is byte-identical, so the empty list is cleaned up without
  worry. Real refusals of the generator (all replicated in `proposeProbe`,
  `src/probe.ts`): `probes` + `subenvs` = a **hard error** (H1); a name that
  collides with an agent interface/port, with the clock or the reset (the same
  tb_top/config-DB namespace); multi-instantiated agents (`instances`; with
  `replicas` it works). NOTE 1.0: >1 clock domain is NO longer refused — the
  probe has a `clock:` field that chooses the sampling domain.
  **The bugs of 0.9.2, re-checked on 1.0.0** (repro + xrun): (1) `layout:
  packaged` + a probe with `coverage` → `env_pkg` does not include
  `probe_monitor` (xmvlog *E,NOIPRT, unknown type) — STILL BROKEN, we do not
  offer `coverage` on packaged configs; (2) a leaf block **composed as a
  subenv** generates its probe files, but the subsystem's tb_top has no
  `probe_if` instance, no XMR and no `config_db`, and `probe_if.sv` does not
  enter the filelist → **exit 0, silently broken** — STILL BROKEN, the
  extension warns (`isComposedChild`); (3) `struct` + `coverage` used to crash
  the generator — FIXED in 1.0 (it generates and compiles cleanly).
- **The width of a net is NOT in the model** and the naive derivation is
  WRONG: `ViewNet` has only `{name, endpoints, fanout, render}`. The width is
  taken ONLY from an endpoint that is **the same signal** — the own port of
  the view's module (svmodel seeds the net with the port's name) or a child
  pin tied to the **whole net** (`conn.kind === "net"`) — never through
  `select`/`concat`/`expr`. The proof is in `examples/model.json`: `ch_out`
  has 48 bits but all its pins are 16-bit ports through `select`; `din` has 8
  but the pin is a 16-bit port through `concat` (`netWidth` in `src/probe.ts`,
  tested in `test:probe`). Corollary: **purely internal signals cannot be
  probed** (state registers, wires from an `assign`) — the model emits nets
  only from the connections of the child instances' ports.
- **The composition keys: `connections` and the cross-block scoreboards** —
  probed empirically (1.0.0: the `subenv_scoreboards` key NO longer exists —
  it is rejected with a teaching error; a cross-block scoreboard is an
  `analysis.scoreboards` entry with qualified endpoints `<subenv>.<agent>`,
  see `isCrossBlockSb` in `src/quickuvm.ts`; `test:e2e` scenario 6): valid
  ONLY on a bench with `subenvs`; the first token of any endpoint is **the
  name of the subenv instance** (`subenvs[].name`), not `dut.name`.
  `connections: [{from: <subenv>.<port>, to: <subenv>.<port>}]` — `from` = an
  **output** port of the source block, `to` = an **input** port of the
  destination block, EQUAL widths, a single driver per destination, and the
  agent of the **destination block must be PASSIVE** (`active: false`); it
  generates a PHYSICAL `assign` in tb_top. The wire connects **agent interface
  ports**, so the children must have agents BEFOREHAND (that is why the
  derived composition is a gesture separate from `createSubenv`, whose
  skeletons for the children create no agents). The cross-block scoreboard:
  `analysis: {scoreboards: [{name, source: <subenv>.<AGENT>, monitor: <subenv>.<AGENT>}]}`
  — keyed on the **AGENT**, not the port; it falls under the `keepAnalysis`
  rule (the `analysis` mapping is not deleted). Neither switches modes
  (absence = byte-identical), so the empty lists are cleaned up without worry.
  The derivation from the model: `deriveConnections` in `src/compose.ts` (pure,
  `test:compose`) — an inter-block net = a net WITHOUT a `<port>.X` endpoint,
  with one output and one+ inputs across subenvs; the direction from
  `port.dir`, the width from the model; it refuses multi-driver. **Invariants
  hardened at the adversarial review** (do not reintroduce the regression):
  (1) a **feedthrough** net (the parent's port driven by one child AND read by
  another) is a real connection — the whole net is NOT skipped because it
  touches `<port>.X`; the boundary endpoint is dropped by the per-endpoint
  filter, the purely boundary nets by the 0-drivers/0-sinks test. (2) The width
  comes from the module's **per-name definition**, shared by several
  elaborations — for two instances of the SAME module (different parameters)
  it is unreliable, so it is not checked (quick-uvm does the authoritative
  check); for DIFFERENT modules the mismatch is warned about but **still
  wired** (do not throw a real connection away — the skip was losing
  connections). (3) `wireConnections` rebuilds rel→subenv without the `.`
  filter (the generate members have a deep rel); a name claimed by several
  rels = ambiguous (`subenvName` is many-to-one) → it is taken out + warned
  about. (4) The passivation groups the edits by **file URI** (two sinks may
  refer to the SAME child config) — a single `edit.replace` per file, with the
  passivations folded over the evolving text, otherwise two replaces on the
  same range corrupt each other. (5) **ALL the agents** of the destination
  block that own driven ports are made passive, not only the first (`filter`,
  not `find` in `planWireEdits`, `src/compose.ts`): the driven ports of a sink
  may belong to DIFFERENT agents, and quick-uvm refuses the generation if any
  of them stays active ("agent ... is active and would drive ...") — with a
  single agent made passive, the gesture reported success on a broken state (a
  pre-existing bug found and confirmed empirically at the adversarial review
  of the hardening, 16 Jul 2026; a multi-agent destination block IS a valid
  composition — with all the agents passive, the generation is clean). The
  planner of the multi-file edit is PURE (`planWireEdits` + `subenvMapping` in
  `src/compose.ts`, `test:compose`); the host in `actions.ts` only reads the
  files and builds the `WorkspaceEdit` from the plan.
- The testbench quick-uvm generates contains a **stub of the DUT** (a duplicate
  definition that wins slang's resolution → `port does not exist` on the real
  design) plus sources that need `uvm_macros.svh`: the `quickuvm.outputDir`
  folder is excluded from the source glob (`outputDirExclude` in
  `src/filelistops.ts` — pure, tested in `test:filelist` —, consumed by
  `resolveFileList` in `src/filelist.ts`), otherwise the extension poisons its
  own model after the first "Generate testbench" (a real regression: a generated
  `examples/tb/` left the hierarchy on the welcome screen with no visible
  explanation). The folder is still produced by every "Generate testbench" and
  by the e2e scenarios of the time, which wrote into the workspace; today
  `test:e2e` writes only to temporary directories (verified Oct 2026: nothing is
  left behind), so the exclusion guards the user's own generations, not the
  test run.
- **The temporary wire (docs/08 R10/R11)**: the hotspots are `.tb-porthit`
  circles appended AFTER the glyph in `drawBox` (`src/webview/tbschematic.ts`)
  — they must stay on top to take the press. A plain click on one ARMS
  click-click mode in the TB view ONLY: in RTL a click on a pin must keep
  selecting it (the lasso → "Agent from selection" flow), so `pointerup`
  without movement cancels the wire there. Boundary flags are NOT origins (a
  drag on a flag moves it, docs/04). The snapped target's id differs by view:
  a TB hotspot is keyed by `data-port` (the port id), an RTL pin by `data-id`
  — its `data-port` is the bare NAME, and keying the agents map by it made a
  drop on a claimed pin fall through to "Agent from pin" (caught in the
  harness). The drop point of a create gesture is a `pendingDrop` consumed by
  the next `renderTb` of the same layout key (120 s TTL — a scoreboard asks up
  to four QuickPicks): the first node of that kind NOT in the pre-gesture scene
  (ghosts excluded: a declared scoreboard may take a ghost's id, `sb:sbd`)
  lands there, its stale seed under the same id is dropped so the D21 loop
  persists the new position, and the WHOLE view is pinned (D21 total seeds)
  even when the view had none — pinning only the new node would leave partial
  seeds. From the adversarial review: a pin an agent already claims is no
  origin (port-claimed is an error), `addPinsToAgent` refuses ports another
  agent declares, "Coverage on X" is offered only while X has none (the host's
  `addCoverage` used to substitute the single remaining agent silently; it now
  refuses a covered preselect), a duplicate-named scoreboard (`sb:x#2`) is
  refused like an unnamed one (`setScoreboardField` edits the FIRST `x`), a
  middle/right press cancels the wire before the pan starts, and the armed
  drop captures the pointer so its click reaches the canvas. Synthetic pointer
  events in the harness never produce a `click`, so `suppressClick` stays
  armed after a scripted drop — dispatch a `click` before testing the
  selection. **The connections wire** (R11's composition half, Oct 2026): a
  `sub:` box's ports come from `config/full.children` (R18) — outputs east =
  sources, inputs west = targets — with the `signal` glyph, because a hotspot
  exists ONLY for a port with a glyph (`drawBox`): a glyph-less port starts
  and receives nothing. The legality is `subPortReason` in `wiring.ts` (another
  block, one driver per input, equal widths when both are known); the host
  re-checks in the pure `singleConnection` and writes through `applyWirePlan`,
  the tail extracted from `wireConnections` — do not add a second write path.
  A width mismatch is a WARNING that still wires (as `deriveConnections` does;
  quick-uvm has the last word), an unreadable child leaves direction and width
  unchecked with a warning; the gesture itself blocks a mismatch it can see.
  From the review: the glyph is PROVENANCE — `addPin` takes it, a cross-block
  scoreboard's endpoint pin (an AGENT name, drawn for its edge) gets `null`
  (it started a wire and, on an unreadable child, wrote `from:
  <subenv>.<agent>`), a real port found later UPGRADES an endpoint pin; a
  port with `width_param` / `packed_dims` / `struct` / `type` has an UNKNOWN
  width (`subPortWidth` and `singleConnection.lookup` return null, never 1 —
  a false hard block otherwise); a duplicate-named subenv (`sub:x#2`) shares
  the origin's name-keyed pins — skip by `label`, not only by id, or the
  origin's own input lights; `parseQuvm` mirrors `src`/`dst` into `from`/`to`
  and the text mutations (`addConnections`' dedup, `removeConnection`, the
  rename retargets) read both; the per-file editor has no children (its `sub:`
  boxes draw only the connection pins) and answers `addConnection` with a
  message.
- **Designer assistance (docs/08 R12)**: the proposals are computed on the HOST
  (`src/proposals.ts`, pure) and shipped as `proposals/full`; the webview never
  derives one — the connections proposal needs `deriveConnections` (compose.ts
  pulls the `yaml` package) and the interface proposal needs `connectedIface`,
  now shared from proposals.ts (the private copy in actions.ts is gone). The
  strip is shown only while `viewId` matches the displayed view, and an APPLIED
  set is recorded like a dismissed one: the config/overlay change re-renders
  BEFORE the host's next `proposals/full` arrives, and without the record the
  just-applied rows flashed back for a frame (caught in the harness). The
  ghost rows travel as ONE `materialize` item with the ids to KEEP — writing
  `analysis:` leaves implicit mode, so the unchecked members stop being
  generated; never send the ghosts as separate add actions (that would
  resurrect the others through `keepAnalysis`, or lose them). `createAgentFrom*`
  take an optional preset name (`agentName`: used when free and valid, else the
  input box asks with it prefilled) — the proposals name agents after the
  interface port / the pin prefix. From the adversarial review: the strip
  keeps its DOM while the same set is on screen (a rebuild on every render
  re-checked every box, so an unchecked ghost got written anyway); the flash
  snapshot is keyed by mode + layout key (the TB levels share `viewId`); the
  prefix heuristic strips a trailing direction token FIRST — on PULP names the
  last underscore separates `_i/_o`, which paired an input with its own output
  (`valid`) and never found the real `src_*`/`dst_*` groups (reproduced on
  common_cells, now a fixture in `test:proposals`); a connections proposal
  needs the children's agents (`childAgents`) and no ambiguity; a preset agent
  name falls back to the input box on an SV keyword or a scoreboard/subenv/
  probe name; materialize refuses a resolved set that references agents the
  live config no longer has (resolve reads the DISK); `analysis:` with no
  value is implicit for the strip and the mutation, as it is for the scene.
- **In-place rename (docs/08 R14)**: `.tb-name` takes pointer events (the
  title's double-click renames; everywhere else the node labels stay
  `pointer-events: none` — the ghost hit-testing note above); the click still
  bubbles to the box, so selection and drag are unchanged. `tbRenameTarget` in
  `inspector-view.ts` is the ONE resolver for F2, the double-click and the
  menu (ghost, unnamed scoreboard, derived names → null), like `tbDeleteTarget`.
  The webview carries the sidecar positions to the new ids (`agent:` + its
  `cov:` and `<if>.` flag, and the agent's own level key
  `tb:<config>|agent:<name>`) on the RENDER that shows the new id
  (`pendingRename` / `applyPendingRename`, before the seeds are read), then
  moves the selection and posts it — not before posting the action: a refused
  rename would leave orphan entries no invalidation cleans (`tb:` keys), and
  the host's copy of the selection would point at an id that never appears.
  Without a seed the renamed box lands wherever interactive ELK puts a new
  node. Scoreboards are addressed by ORDINAL (`id: sb:x#2` →
  `renameScoreboardAt`): resolving by label renamed the FIRST entry of that
  name and swapped the seats (review finding). A VIP reference (`from_vip`)
  is never offered: quick-uvm resolves it by entry name against the manifest.
  The cascade also follows `tests[].sequence.agent` and a boundary agent's
  `<agent>.<port>` endpoints (connections, cross-block scoreboards) — both
  quick-uvm walls at generate. `cancelRename` runs the editor's cancel hook
  BEFORE removing the input: a `blur` fired by the removal must not commit.
  Enter on a bad name keeps the editor (the first cut closed it, losing the
  typed text — caught in the harness); `render()` cancels an open editor (the
  DOM is rebuilt under it). The host checks the generated namespace (agents,
  scoreboards, subenvs, probes + SV keywords); a PARENT bench's
  `<subenv>.<agent>` references live in another file and are NOT updated — a
  composed config gets a warning, never a silent partial rename.
- **Inline widgets (docs/08 R13)**: pills in the SVG box, keyed by `data-*`
  and handled by delegation in the canvas `click` handler of `main.ts` AFTER
  the `suppressClick` check — a drag that starts on a widget must not toggle
  it on release. A widget has `pointer-events: none` until its box is
  `.selected` (CSS) AND the handler re-checks the selection; the second click
  of a double-click (`e.detail > 1`) is ignored and the `dblclick` handler
  returns on a widget — without both, a double-click toggled twice (two YAML
  edits) and then drilled. `boxSize` must count the widget rows
  (`WIDGET_H`), or the pills overflow the box — and measures the pill text
  MONO (the measuring trap above). Widgets exist only where the by-name action
  can land: named, non-duplicate two-stream scoreboards; non-ghost, non-VIP
  agents (`from_vip` takes `{name, from_vip}` only). From the adversarial
  review: a number input reads `""` for text the browser cannot parse (`1e`,
  `-`) — check `validity.badInput` before treating `""` as "reset", a typo
  silently DELETED `max_latency`; quick-uvm wants `max_latency >= 1` (the
  host and the panel refuse 0 now); the `match` cascade deletes `match_key`
  on the step to in_order, so the pill shows the key and its tooltip says so;
  a modifier click (Ctrl/Shift) must fall through to the selection.
- **"What will this generate" card (docs/08 R15)**: the data is requested per
  dwell (`card/request`) and answered from the config TEXT (`elementRange`,
  the R4 map) plus the CACHED manifest (`GenStateService.filesFor` /
  `hasManifest`) — never from a generator run; the webview caches `card/full`
  per id and clears the cache on `config/full` and `status/decorations`, so a
  card never shows a stale entry or a stale ●/U/M state. The card is a DOM
  overlay (`.gencard`), not a `<foreignObject>`: the SVG export must stay
  untouched and the card must sit above the R1 node-tools strip. It closes on
  every `render()` (its box is redrawn), on a press (a drag/wire/selection is
  not a dwell), on a wheel (a fixed overlay would detach), and leaves with the
  pointer unless the pointer moved ONTO the card (its buttons) or `I` pinned
  it. `manifest: false` is distinct from "no files": the card says "not
  resolved" (quick-uvm < 1.1.0, an invalid config) instead of claiming the
  element owns nothing. The per-file editor's card gets the manifest's files
  only when its document IS the active config (the manifest is the active
  config's). From the adversarial review: the ●/U/M line appears only for ids
  the badges TRACK (agents, scoreboards, probes, vsqr — `ownerToNodeId`) and
  only once a `status/decorations` snapshot arrived (the per-file editor never
  sends one) — a fall-through "✓ generated" lied for `cov:`, `env`, `dut`,
  `sub:` and the agent internals; the ids the manifest does not own map onto
  the owner that does (`ownedFilesFor`: `agent:<a>:u.driver` → the agent's
  `_driver` file, `cov:<a>` → `<a>_cov.svh`, `xsb:` → `scoreboard:`); the
  manifest is produced with `-o <outputDir>` (without it quick-uvm checks
  `exists` against its default `tb/`) and the card's flags come from the
  service's LIVE `present` set, not the manifest's snapshot; `card/full` and
  `status/decorations` re-render through `refreshCard`, which never touches
  the dwell/hide timers (an answer that cleared the pending hide left a card
  orphaned after the pointer had gone); a pinned card follows pan/zoom/drag
  (`repositionCard` in `applyTransform` and `dragReroute`); the dwell restarts
  only when the hovered BOX changes, not on every compartment crossing.
- **Action palette (docs/08 R17)**: the palette owns NO legality rule — it
  collects: `tbMenuItems(id)` / `rtlMenuItemsFor(el)` (the context menus,
  refactored into builders so right-click and the palette cannot diverge),
  `nodeToolsFor`, the node's `widgets`, and the Properties panel's enabled
  `button.btn` rows from a DETACHED render (`inspectorCtx(root, allOpen=true)`
  — `InspectorCtx.allOpen` opens every section; never set it for the visible
  panel). That render sets the inspector module's `ctx` to the detached root;
  harmless in the diagram webview (it has no `#inspector`), but the sidebar
  webview (`properties.ts`) must never call it. A proposal row is offered one
  by one EXCEPT the ghost (`materialize`) rows — those are all-or-nothing in
  the strip, and go through `applyProposalItems` like the strip's Apply (the
  flash of what was created, the set retired) — a bare `applyProposals` left
  the strip offering the applied row until the host's next set. Labels are
  de-duplicated across surfaces (trailing "(…)" hints stripped, case-folded)
  and the recency key is the NORMALISED label; the R1 "+" tools are NOT
  rows — the panel's add buttons already carry the preselected agent
  ("Scoreboard from cmd"), and the tools' titles would have doubled them.
  Recency (`paletteRecent`) rides in the webview state next to
  `openSections` — `persistState` must keep writing it, and
  `persistSections` (inspector-view) spreads the existing state so it does
  not drop it. The harness HAS an `#inspector`: a section head captures ITS
  render context (`mine`), or a click after a detached render would re-render
  into the detached root. `render()` closes the palette (its rows close over
  the old scene); the active row is scrolled into view (the list holds up to
  40 rows, the box shows ~10).
- **Diff preview (docs/08 R19)**: `confirmGesture` (`src/previewdiff.ts`) is
  the ONE confirmation flow of a previewable gesture — a destructive gesture
  goes through `Actions.confirmMutation` (the mutation on `cfg.readText()`,
  then the modal with "Preview changes"), a multi-file gesture builds its
  `FileChange[]` from its plan. The preview texts are the gesture's own, but
  the APPLY still runs through the usual path (`cfg.apply(mutate)` re-runs the
  mutation on the then-current text) after a guard that the documents still
  hold the previewed texts — `confirmMutation`, `createSubenv` and
  `wireConnections` all refuse a stale apply (the user can edit the YAML
  while the question waits). The question after the preview is a QuickPick
  with `ignoreFocusOut` (`askOverPreview`): a modal blocks the diff tabs, and
  a notification toast is NOT sticky — a warning with buttons auto-hides
  after 12 s with its promise pending (read in the VS Code bundle at the
  review), leaving the gesture armed in the bell; closing every preview tab
  by hand cancels (`tabGroups.onDidChangeTabs`). BOTH diff sides are virtual
  snapshots whose paths end in `.preview.yaml` and carry an index: the custom
  editor's `*.quickuvm.yaml` selector matches the BASENAME on any scheme, and
  on VS Code before the diff-priority normalisation (seen on 1.111) a
  matching diff side opened two TB webviews instead of a text diff, with a
  closer that found no `TabInputTextDiff` to close; two children with the
  same basename collided on one uri. The tabs are opened in REVERSE order
  (the last opened tab is the visible one, so the first file ends on top),
  with `preview: false` (a preview tab replaces the previous one — two files
  would show one tab), and closed through `tabGroups.close` on the
  `TabInputTextDiff` whose `modified` is ours; a tab that fails to open
  closes the ones already open. The rule of the row is
  encoded in `kind`: `destructive` asks in every mode, `multi-file` asks only
  when MORE than one file changes (a top-only wiring or composition stays
  immediate) and never on `previewEdits: never`. A no-op mutation (nothing to
  change) is reported, not asked. The per-file `+a -r` summary is counted
  LINE-wise, the way the diff editor counts the hunk (`summarize` in
  `src/preview.ts`): the character-level minimal edit of R4 over-counted a
  deletion at the end of a file without a final newline and counted an
  in-line insertion as +1 -0 (review finding; locked in `test:preview`).
- **Collapse / hide pins / hover preview (docs/08 R18)**: all three are VIEW
  state, never YAML. `collapsed` on a sidecar node has TWO meanings by key
  family: on an RTL view a generated fold's `collapsed: false` = expanded
  (absent = folded); on a TB level key `collapsed: true` = the block drawn as
  its header (absent = expanded) — `setFold` and `setCollapsed` are separate
  mutations, do not route one through the other (`setFold` DELETES on
  `true`). `hidePins` is a VIEW-level key: `prune` must not drop a view that
  holds only it, `serializeSidecar` must copy it (it whitelists `nodes`
  and `nets` — the first cut lost the override at the first save), and
  `invalidate` has TWO deletion branches of its own — the empty-view one and
  the `keys === null` one, which fires for every LEAF instance (its symbol is
  a view with no schematic keys) — both must spare a hidePins-only view (the
  DUT's hidden pins came back on every recompile; `test:sidecar`). A toggle
  (collapse, hidden pins) on an UN-SEEDED view first pins it
  (`pinViewIfUnseeded`, the D21 total snapshot): without seeds the next render
  is a full ELK pass and every box jumps — the row's risk, reproduced at the
  review. A waived port an agent still claims (the `ignored-and-mapped`
  ERROR) or any port with a status entry is never hidden: the diagram never
  hides a problem. `canCollapse` (tbscene.ts) is the ONE predicate behind the
  `C` key, the menu, the inspector and `toggleCollapse` itself (a header-only
  box got `collapsed: true` persisted with no way to expand it). The sidebar
  Properties view reaches the panel through `relay/collapse`, like
  `relay/flip`. The async preview keeps a `subHoverId` and a `subPreviewGen`:
  the layout is applied only while the pointer is still on that box and the
  config unchanged (an orphan preview after leaving, the wrong child on top
  after moving to another sub, a stale child cached after a save); the dwell
  is not re-armed by crossings inside the box; `exportSvg` strips
  `.tb-preview`; a rename carries `collapsed` with the seat. `boxSize`
  takes `collapsed` and `drawBox` reads `TbPlaced.collapsed`: both the size
  and the drawing skip the compartments AND the widgets, or the pills overflow
  a header-only box. The key is `C` (TB only), not the row's `H` — `H` is the
  flip since phase 3; the pins' key is `Ctrl+H` in the Ctrl block (RTL only).
  The hidden pins are REMOVED from the scene before layout (`pruneNcPins`,
  pure) and from `currentPins` in the symbol — not hidden by CSS — so the
  boxes shrink, the router sees no phantom obstacles, and the selection /
  wire origins cannot reach them. The hover preview draws with `drawTb` into
  the WORLD group (it pans/zooms with the diagram) and strips `data-id` from
  everything it drew plus `pointer-events: none` on the group: the global
  `[data-id]` queries (badges, flash, status) and the `.tbnode` dwell handler
  would otherwise find the child's boxes. It closes on `render()` (the
  viewport is rebuilt), on a press and on leaving the box; the cache is per
  child name and cleared on every `config/full`. The children's configs ride
  on `config/full` (the panel only — the per-file editor has no ConfigService).
- **Declared / Common / All inspector (docs/08 R16)**: the third rule of
  `src/inspector.ts`, PROVENANCE (`fieldGroups`, `test:inspector`), sits
  NEXT to relevance/rarity, not instead: `agentRows`/`scoreboardRows`/
  `portRows` still decide what is relevant; `fieldGroups` then lifts the
  DECLARED keys out (always shown — a declared key relevance would hide is a
  problem to see, not to hide; it comes last), keeps the undeclared relevant
  ones as "Common" (the default dimmed as the placeholder) and the rare ones
  as "All" (the persisted section key stays `agent.advanced` / `sb.advanced`).
  The defaults are the schema reference's (§1.5, §1.5.1, §1.6) in
  `AGENT_SPEC` / `SCOREBOARD_SPEC` / `PORT_SPEC` — a new editable key must be
  added to the spec's `rows`, or a declared value of it lands among the
  read-only "other" rows (which know the schema defaults of the row-less keys
  — `assertions: false`, `idle: {}`, the lists — or they read as modified).
  The reset is the editors' "empty ⇒ default" path; three exceptions, each a
  trap: `active` resets through `"true"` (`setAgentActive(true)` deletes the
  key — its idempotence is on the KEY's presence, not on the effective value:
  a hand-written `active: true` made the reset a silent no-op, review
  finding; `""` would write `false`), a port `width` through `"1"`
  (`setAgentPortWidth(1)` deletes, and it must look in `inouts` too — it
  iterated inputs/outputs only and THREW on an inout; `""` is a silent no-op
  in `editAgentPort`), and a port boolean's `""` must map to `undefined` in
  `editAgentPort` (it mapped to `false` — a reset of `randomize` wrote
  `randomize: false`). A key ANOTHER key requires — `request_valid` under
  `mode: responder`, `reorder_by` under `respond: pipelined`, `match_key`
  under `match: out_of_order`, `window.length` next to a boundary — is
  `requiredWhen` in the spec: declared, not bold, no ⟲, because deleting it
  alone leaves a config the generator refuses and `checkConfig` has no
  finding for it (the enabling key resets instead, its cascade drops the
  dependents — the ⟲ tooltip names them through `resetNotes`: a select shows
  its choice, a glyph does not). `pullup` is `required` in `PORT_SPEC` only
  to deny the reset (mandatory once open drain is on). A focused ⟲ is a
  BUTTON: the window `keydown` guard skips it like the inputs, or Tab + Delete
  deleted the component. In the view the
  row wrapper `prow` captures `cur` into a const BEFORE building the reset
  closure — a closure over the mutable `cur` would reset the LAST rendered
  row; and the `tbPropRow(` → `prow(` rename must not touch the wrapper's own
  `return tbPropRow(...)` (a self-recursion the typecheck caught). A number
  input of an undeclared key is EMPTY with the default as placeholder, not
  pre-filled with the default (pre-filled reads as declared).
- **Generated-code traceability (docs/08 R20)**: probed on quick-uvm 1.1.0 —
  the generated files carry NO element anchor (header only), so do not look
  for one: element ↔ owned file comes from the manifest (`ownerOfFile`, exact,
  inferred elements included), element ↔ lines of an aggregate file from
  `tracePattern` (the name + the stems of the owned files, word-bounded, with
  the `_<suffix>` handles the generator derives; `cov:<a>` is `<a>_cov` only,
  `agent:<a>:u.<part>` is `<a>_<part>` + the `drv/mon/sqr` abbreviation, an
  ordinal `sb:x#2` traces `x`, an id with an unknown shape is `null` —
  `agent:cmd:nope` once fell on the agent branch, caught by the suite). The
  `_<suffix>` MUST be guarded: an identifier that continues a word into
  another element's name or stem, or into a whole-config stem, is that other
  element's — a negative lookahead built from the OTHER owners' names and
  stems (`cmd(?!_rsp(?:_|\b))`, `yapp(?!_buffer_env(?:_|\b)|…)`); without it
  `cmd` lit `cmd_rsp_*` and an agent `yapp` on DUT `yapp_buffer` lit most of
  the env with its lens on the env class (review finding, both locked in
  `test:trace`). Port-name collisions (an agent `in` lights `.in_data(...)`)
  remain: approximate, as the row says. Comment-only lines never match (the
  header names the file; `// This File: x_virtual_sequencer.svh` would light
  for `vsqr`). The lit lines are drawn ONLY in aggregate files — in an owned
  file every line is the element — and only in the VISIBLE editors of the
  ACTIVE bench (under `GenStateService.outDir`, listed by the manifest); they
  REVEAL only on a selection (`apply(reveal)`): the visible-editors event and
  a manifest/resolve refresh re-light without scrolling, or a tab opening
  yanked the file being read. The per-file editor drives the trace only when
  its document is the active config, and re-posts `ui/config` on the
  settings change (it is the DEFAULT editor; posted only at ready, its toggle
  row's second click switched the mode back off). The follow mode
  (`quickuvm.codeFollowsSelection`) opens the primary file — for `cov:<a>`
  and the agent internals, the first file of R15's `ownedFilesFor` — as a
  PREVIEW tab beside with `preserveFocus`; the next selection replaces it
  while VS Code's preview tabs are enabled; it is OFF by default (nothing
  opens a tab without the user's say-so). The coverage collector is a node of
  its own: the agent's `<a>_cov` file gets a `cov:<a>` lens, an aggregate
  file a `cov:<a>` lens where it mentions `<a>_cov*`, the report a row under
  "inferred" when resolve says so (the diagram draws it as a ghost — the
  untraceable list was missing it). A cross-block scoreboard's lens maps
  `sb:<n>` → `xsb:<n>` (root level) through `scoreboardNodeIds`; every other
  lens target is at `env` (no tree lookup: agents have no `selectId` in the
  VTree, the lookup was dead code). The report is a read-only virtual
  `quickuvm-trace:` document (an untitled one is born DIRTY and prompts to
  save; `preview: true` is moot on a dirty buffer), re-rendered on each run
  through `onDidChange`. `clear()` touches only the still-visible editors (a
  closed one logs a warning per call). The CodeLens provider is registered by
  PATTERN (`**/*.{sv,svh}`), not by language: without a SystemVerilog
  extension `.sv/.svh` have no language id; the provider itself checks the
  output dir and the manifest. The lenses refresh on `genState.onDidChange`
  (a badge-STATE change, not every manifest reload — VS Code re-requests on
  edits anyway) AND `resolve.onDidChange` (the inferred flag comes from
  resolve). `trace` is constructed BEFORE the `genState.onDidChange` closure
  that references it (a TDZ otherwise).

- **Level of detail on zoom (docs/08 R6)**: the level is ONE attribute,
  `data-lod` on the root `<svg>`, and every rule sits behind
  `#canvas[data-lod="low"]` — the id is load-bearing: `exportSvg` clones the
  canvas WITHOUT its id, so no rule reaches the clone, and it takes
  `viewport.getBBox()` with the attribute lifted (the bounds ignore
  `display: none` text, so an export at the overview level would be cropped to
  the boxes). The enlarged title is a CSS transform read from a `--lod-title`
  variable on the title, applied only under the low level — a `transform`
  attribute would enlarge it at full detail too. The fit (`applyLodTitles`) is
  measured once per DOM and per switch (`lodTitlesDirty`, set by `resetCanvas`
  and by a level change), never per frame from `applyTransform`; `getBBox` on
  the title excludes its own transform, so re-measuring a fitted title is
  stable. A hover preview's boxes have no `data-id` and are skipped. The
  symbol view is exempt (`updateLod` forces `full` there — do not key the
  level on `state.k` alone). The hysteresis lives in `lodFor`; a threshold of
  0 / NaN means off and must also LEAVE the overview (a setting change while
  zoomed out — locked in `test:navfind`). What is hidden is text nobody can
  read; badges, junctions, flags and a SELECTED pin's label stay — the diagram
  never hides a problem, and the selection says which pin was asked about.
  From the adversarial review: the enlarged `.tb-name` takes NO pointer events
  at the overview level (it takes them for R14's double-click rename, and
  scaled 3x it covered a third of its box — a double-click on the box renamed
  instead of drilling, with an I-beam cursor); the hysteresis is PER VIEW
  (`lodKey`: a view entered fresh passes `"full"`, or a zoom inside the band
  drew either level depending on the view visited before); everything
  MEASURED from the DOM depends on the level — `applyStatusBadges` /
  `applyGenBadges` place from a group's `getBBox()` (the hidden port labels
  are outside the box) and `centerChipSigns` measures glyphs that are
  `display: none` at the overview — so `updateLod` redoes all three on a
  change; the setting is capped at 2 (left only above threshold x 1.15, the
  zoom stops at 5: a threshold near the cap could never be left).
- **Marquee modifiers and arrangement (docs/08 R7)**: the lasso's operation is
  frozen at the press together with `base` (`marqueeOp`): plain replaces,
  Shift adds, Ctrl TOGGLES, Ctrl+Shift subtracts — Ctrl stays what Ctrl+click
  is; do not make it "subtract" (the row's wording). And NOT Alt: a webview
  forwards its key events to the workbench, whose `ModifierKeyEmitter` clears
  "Alt alone" only on a mousedown in ITS document — Alt down, a drag inside
  the iframe, Alt up reads as a lone Alt and focuses the menu bar on
  Windows/Linux (`window.customMenuBarAltFocus`), blurring the webview. Read
  in the VS Code bundle at the review, never run; Alt+arrows (R5) is safe, the
  arrow keydown resets the emitter. No new mouse-only gesture on Alt. `lassoMode: direction` reads the
  drag's `dx` per frame, so the rectangle's class (`crossing`) and the rule
  flip together when the pointer crosses the press point. `alignItems` snaps
  ONLY the axis it works on — the first cut snapped both and moved an
  off-grid item on the axis the user did not ask about (caught by the suite).
  A centre line is pinned to the LARGEST item on the grid (`centreLine`), not
  taken raw from the bounding box: every item is snapped on its own, so the
  raw line moved once the result was measured again and a second "align
  centres" shifted a third of random layouts (review; the 400-round sweep in
  `test:arrange` locks idempotence for all six operations).
  `distributeItems` takes the LAST item by its far edge, not by position (a
  wide box that starts early), a box spanning all the others is a no-op, and
  items that do not fit in the span (a negative gap) are left alone — an
  "equal overlap" pushed a middle item past the last one's far edge.
  `pinCenterY` must agree with the routers' anchors (the TB view calls
  `anchor()` itself; in RTL an end without a port is a wire only on a boundary
  flag), or "straighten" is offered for a link that is not drawn.
  `straightenItems` refuses a move that would land on another box, with one
  grid step of air, checking against everything where it stands at that moment
  (the items already moved AND `others`, every rect of the view): found in the
  harness, where two agents in one column feeding one scoreboard were stacked
  on top of each other — their target pins are one pin pitch apart, the boxes
  far taller, so both wires cannot be straight. `applyArrange` is
  `nudgeSelection`'s path: `capturePositions` (total) merged with the changes
  → one undo entry + ONE total `layout/snapshot` (D21); an empty change set
  posts nothing, pushes no undo entry, and says so in a toast (a gesture that
  does nothing silently reads as a broken button). The context menu's icon row
  and the palette's "Arrange" group are both `arrangeActions` — one list.
- **Invalid configuration and empty states (docs/08 R8)**: `parseQuvm` never
  throws and returns whatever could be read, so a file that does not parse
  used to look like an empty or partial bench under "use Set as DUT first".
  The reason travels separately, on `config/full.parseError` (`docParseError`
  on the document ConfigService already parsed, `quvmParseError` on a text) —
  the FIRST parser error only, its "at line N, column M" tail cut (the line is
  a field), plus "the top level must be a mapping" for a list or a scalar. An
  EMPTY file is not an error. It also reports a SHAPE no reader can walk
  (`shapeError`, the sections of `MAPPING_LISTS`): valid YAML is not enough —
  a bare `-` typed as the start of a new entry parses to `null`, `agents: foo`
  to a string — and `buildTbScene`, the inspector and `multiGroups` all
  dereference the entries. A throw in `renderTb` used to leave the PREVIOUS
  diagram on screen with no banner (review, reproduced in the harness), so
  the scene builder is called in a try/catch that clears the canvas, the two
  inspector renders are guarded, and `parseQuvm` walks `connections` only when
  it is a list (`connections: 5` threw into its own catch and answered `{}` —
  a file with a DUT and agents read as empty). `analysis.coverage` is a list
  of NAMES: never add it to `MAPPING_LISTS`. The banner belongs to a view family
  (`bannerIsTb`): the RTL render hides a TB banner on the way in, and
  `model/stale` stays the design views' own. `showEmpty` replaces `#empty`'s
  children (the host's localized text is only the pre-render placeholder);
  `exportSvg` still gates on `!empty.hidden`, so every path that shows the
  empty state must be undone by `empty.hidden = true` on the next good render.
  `#empty` is `position: absolute; inset: … 0` — it needs `box-sizing:
  border-box` once it has padding, or the page scrolls horizontally (seen in
  the harness). "Open as text" must REPLACE the tab: `vscode.openWith(uri,
  "default")` only adds a text tab beside the diagram tab (a text input never
  matches a custom editor input; read in the VS Code sources at the review),
  so `reopenConfigAs` opens the wanted editor in the group showing the other
  kind and closes that tab through `tabGroups.close` — both ways, or the two
  tabs toggle. From the panel the text opens beside FOCUSED on the error's
  line (`openConfigBeside` keeps the focus on the diagram and, with the file
  already beside, did nothing one could see). The `editor/title` buttons are
  gated on `activeCustomEditorId`. The no-model empty state waits
  `EMPTY_GRACE_MS` after the webview starts (every open passes through "no
  model yet") and re-renders on `config/full`, which arrives after the
  `overlay/config` that first renders it.
- **Multi-selection editing (docs/08 R9)**: `MULTI_FIELDS` (`src/inspector.ts`)
  is the contract on BOTH sides — `multiGroups` offers only those fields and
  the host's `editAgents` / `editScoreboards` refuse any other, and re-filter
  the names against the live config (no VIP reference, no scoreboard name that
  is not unique). Do not add `mode` or `match`: `mode: responder` needs a
  per-agent `request_valid`, `match: out_of_order` a per-scoreboard
  `match_key`, and `checkConfig` has no finding for either gap. The compared
  value is the EFFECTIVE one (declared ?? schema default), or an undeclared
  `active` next to a hand-written `active: true` reads as "mixed". The edit is
  the single edit's mutation folded over the names inside ONE `cfg.apply` (one
  WorkspaceEdit, one undo step) — `agentFieldOp` / `scoreboardFieldOp` are the
  one field rule for both paths; the fold must return the SAME text when every
  component already has the value (the no-op invariant, `test:yamlops`). With
  two or more selected the panel's `selNode` is undefined: the single editor,
  the boundary section and the bench sections (`isBenchScope("multi")`) are
  all off. A number input reads `""` for text the browser cannot parse — check
  `validity.badInput` before treating `""` as a reset (the single scoreboard
  editor's latency field deleted the key on a typo; fixed with the multi one).
  The Role / Seq-item-style option lists are shared constants
  (`ROLE_OPTIONS`, `SEQ_STYLE_OPTIONS`). The sidebar mirrors the PANEL's
  selection, so a per-file editor reaches the multi edit only through the
  palette rows.

- **Secondary notation (docs/08 R21, decision D26)**: frames, sticky notes
  and node colours are annotations of the VIEW — in the sidecar under the
  layout key (`tb:<config>|<focus>` per TB level), never in the YAML, never
  read back as meaning. A FRAME stores its MEMBERS, not a rectangle: the box is
  derived at draw time (`frameRects`), which is why it survives "Re-arrange
  all", a collapse and a rename — do not add stored geometry or resize handles.
  The sidecar side repeats the R18 traps, all locked in `test:sidecar`:
  `serializeSidecar` WHITELISTS (frames and notes must be copied), `viewEmpty`
  is the ONE predicate behind `prune` and `invalidate` (a view holding only a
  note is not empty), a colour lives on the node entry and `prune` must count
  it, a leaf instance's view keeps its notes as it keeps `hidePins`.
  `view/annotations` is a WHOLE replace sent from the sender's own mirror; from
  the adversarial review: (1) the host therefore re-posts `layout/full` to every
  OTHER surface (`LayoutStore.onAnnotations` with an `origin`; the per-file
  editor never refreshed its mirror — not even on `onExternalChange` — and its
  next gesture deleted a note typed in the panel); (2) `parseSidecar` reads
  frames and notes through `cleanFrames` / `cleanNotes`, the SAME reduction
  `setAnnotations` writes through — a hand-edited frame without `members`
  threw in `invalidate`, which the host runs BEFORE posting the model, so the
  diagram never saw another recompile; (3) frame and note ids are COUNTERS:
  an orphan whose id was reused is restored under the next free id, never
  dropped like a node orphan ("the newer override wins" is wrong for a
  counter), notes are restored before frames (a frame around notes only waited
  forever for a node key), and an orphan is replaced, not duplicated; (4) a
  double claim is resolved by frame NUMBER on both sides (`byNumber`,
  `idNumber` — a lexicographic sort puts `frame:10` before `frame:2`), and the
  limits (`ANNOT_TITLE_MAX`, `ANNOT_NOTE_MAX`) are shared constants. In the
  webview: the frame key is `Shift+G`, NOT `Ctrl+G` — a webview forwards every
  keydown to the workbench whatever it does with it, and `Ctrl+G` is "Go to
  Line" there with no `when` (read in the VS Code bundle, not run; the Alt
  pitfall's sibling — check a new Ctrl chord against the workbench's global
  bindings). A frame's tab and a note are REDRAWN during their own drag, the
  browser dispatches no click for a press whose element is gone, and
  `suppressClick` then swallowed the user's next click — the drag end clears
  it on a zero timeout. An open note / title editor commits at the TOP of the
  canvas `pointerdown` (its blur comes after the handler, and the commit
  redraws the notes — a drag built first held detached elements). The editor
  is anchored in WORLD coordinates (`placeAnnotEditor` from `applyTransform`)
  and survives a render of the same view; the first cut closed and committed
  it on every render, and the keys typed next became diagram shortcuts
  (Backspace deleted the half-written note). It remembers its view
  (`commitAnnotsFor`): text typed on a view the user left lands on THAT view.
  The history is shared with the moves (`LayoutSnap`), but an annotation-only
  step has `pos: null` — undoing a colour restored all positions and so PINNED
  an un-arranged view; a rename DROPS the view's history (its entries hold the
  old ids, and an undo is a whole replace). `dropIntoFrames` joins on ENTERING
  a box (`from` outside, `rect` inside): a block taken out with "Remove from
  frame" still lies between the members and rejoined on its next nudge.
  `annotatable()` needs a drawn layout and a hidden empty state, or `N` on the
  empty state wrote a note nobody saw. The tab is drawn ABOVE the blocks
  (`annot-tabs`), the box behind them (`annot-frames`, `.frame-back`) — both
  carry the frame's `data-id`; the frame box takes no pointer events (a lasso
  starts inside a frame). A tint is a fill wash, never on a ghost (`fill:
  none` is its meaning).

- **Matrix editor (docs/08 R22)**: the table owns NO write path — a cell of
  `analysisMatrix` / `connectionsMatrix` (`src/webview/matrix.ts`, pure)
  carries the host action the canvas gesture for the same relationship sends
  (`editScoreboard`, `addCoverage`, `deleteComponent`, `addConnection`,
  `removeConnection`). Do not add a mutation behind a cell. A scoreboard's
  `source` is a RADIO: the ON cell is disabled (A2: a scoreboard needs a
  source), another row's cell moves it; a `monitor` cell toggles, and clearing
  it cascades (`match`, `match_key`) exactly as the single editor's "— none —".
  On an implicit-mode bench (`analysis` absent OR present with no value) every
  cell is disabled: `addCoverage` there would write `analysis:` and drop the
  inferred scoreboard — the trap `keepAnalysis` and R12's materialise exist
  for. A width from a parameter / packed dims / a struct is UNKNOWN
  (`subPortWidth` → null), never a reason to refuse. The overlay is rebuilt on
  every `config/full` (the host does not answer a click any other way), keeps
  the focus on the toggled cell — or on its close button when the toggle
  disabled that cell, so the next key cannot fall through to the diagram — and
  stops key propagation itself (the window `keydown` guard knows inputs and
  the inspector's buttons, not this dialog). The palette rows run on
  `pointerdown`: a scripted `click` in the harness does nothing. From the
  adversarial review: (1) the children's configs are read from OTHER files
  and are NOT shape-checked like the active one (`shapeError`) — `outputs: 5`
  or a bare `-` agent threw `list?.find is not a function` in `subPortWidth`
  / `knownPort`, and `matrixOf` runs in `renderTbHeader`, OUTSIDE the scene's
  try/catch: the port lists go through `childPorts` (wiring.ts) and
  `matrixOf` catches; (2) the focus is restored only where it WAS (a cell, a
  tab — a clicked tab is destroyed by its own rebuild and left the focus on
  `<body>`) and only while `document.hasFocus()`: a `.focus()` on every
  `config/full` pulled the focus out of the YAML editor the user was typing
  in; (3) the dialog's key handler hears a key only while the focus is inside
  it, so the window `keydown` Escape chain closes the matrix too (after the
  context menu, before the card and the selection); (4) a monitor set on a
  scoreboard with a `window` DROPS the window (`setScoreboardField`'s
  cascade, the single editor's too) — the cell is marked (`warn`) and its
  tooltip says so; `document.hasFocus()` is false for scripted events in the
  harness — test the focus with a real click.

- **Per-view filter rules (docs/08 R23)**: `effect x kind x name pattern`
  per view, in the sidecar (`filters: {rules, off?}`), applied as CLASSES on
  the drawn elements (`f-hide`, `f-dim`, a `tint-*`) — never a re-layout, never
  the YAML. The rule ORDER is meaning (the first match decides visibility; the
  first colour rule decides the tint): `serializeSidecar` copies the list
  as it is and must never sort it, and "+ Add rule" / the context-menu rules go
  FIRST. Hidden wires are hidden dependencies, so three things are load-bearing:
  a wire is hidden only WITH an end (`edgeEffect`; the edge elements carry
  `data-src` / `data-dst` for this, and a drag REDRAWS them — `applyFilterEdges`
  from `dragReroute`); the header chip exists while the view has rules, even
  lifted, even with no match (`filterSummary` returns "" only without rules);
  and an element with a finding is DIMMED, never hidden — `applyFiltersHere`
  runs after `applyStatusBadges` (which fills `statusByElement`) in both render
  tails and again on `status/decorations`. A hidden element leaves the
  selection (Delete would still reach it) and the marquee's candidates. The
  rule colours go through `applyTints(…, ruled)`: every redraw of the
  annotations re-tints from the annotations ALONE, so `commitAnnots` and the
  annotation undo call `applyFiltersHere` after it. The editor applies a
  pattern while it is typed WITHOUT rebuilding its rows (`storeFilters(next,
  typing = true)` + `updateFilterCounts`) — a rebuild takes the caret. `sanitizeFilters`
  is the one reduction on both sides (`setFilters`, `parseSidecar`, the
  webview's `viewFilters`); a rule with neither kind nor pattern is legal
  ("dim everything") but the UI never creates one by default. `view/filters`
  is a whole replace like `view/annotations` and is announced the same way
  (`LayoutStore.filtersSet` fires `onAnnotations`). No depth slider: D24's
  drill levels are the depth control. From the adversarial review: (1) the
  editor's rows hold INDICES into one view's list, so the box remembers what
  it was built from (`filterBoxKey` / `filterBoxSig`) — `syncFilterBox`, at
  the end of every `applyFiltersHere`, rebuilds it when the view or the rules
  moved (a drill with the editor open wrote the old rows' edits into the NEW
  level), and every handler checks the key first (the next render is
  asynchronous); (2) in a design view the findings are keyed by PIN
  (`<node>.<port>`), never by the block — "a finding is never hidden" tested
  the block's own id and protected nothing there; a block is protected by a
  finding on any key that starts with `<id>.`; (3) `display` is not in
  `EXPORT_PROPS`: the export clone must DROP `.f-hide`, or the file draws
  what the view hides, outside the bounds; (4) `invalidate`'s frame-orphan
  pass judged "the view `viewOf` created for nothing" with a hand-written key
  list that did not know `filters` — `viewEmpty` is the ONE predicate, use it
  for every new key family (`test:sidecar`); (5) the selection has ONE choke
  point, `applySelectionClasses`, which drops what `hiddenByFilter` says (read
  from the DOM: the element or an ancestor has `f-hide`, so a hidden block's
  pins go too) — `select/reveal` and Ctrl+F selected invisible blocks, and
  Delete reached them; the reveal says why nothing lit up; (6) JavaScript's
  matcher backtracks: `(a+)+$` on a 40-character name never returns, on every
  render, from a file that is persisted and shared — `unsafePattern` refuses
  a REPEATED group that itself repeats or alternates before the pattern is
  ever run (conservative: `(foo|bar)+` too), and `storeFilters` applies the
  rules BEFORE it posts them; (7) a pattern over `NAME_MAX` drops the RULE —
  truncating made another pattern, dropping the pattern alone made "hide
  every agent"; the input has `maxLength`; (8) typing posts through a 350 ms
  debounce (`filterPostKey`; each `view/filters` is a save plus a
  `layout/full` to every other surface), flushed on `change`, on close and
  on `pagehide`, and a `layout/full` that arrives meanwhile must NOT take the
  typed rules out of the mirror; (9) the focus after a rebuild goes back where
  it was (`data-f`, `filterFocusHint` follows a moved rule) and only while
  `document.hasFocus()`; Escape from the canvas closes the editor (the window
  chain, before the matrix); (10) a colour rule does not match what takes no
  tint (`FilterItem.noColor`: flags, ghosts) — the count said "coloured" for
  elements nobody saw coloured; `.tbnode.ghost { opacity }` has two classes
  and beat `.f-dim`; the hover preview's wires lose `data-src` / `data-dst`
  with their `data-id` (the child's ids repeat this level's); the ELK-throw
  path of `renderTb` calls `applyFiltersHere` (the header was rebuilt, the
  old drawing with its hidden elements is still on screen).

- **"New testbench" templates and the Signals view (docs/08 R24)**: a
  template is a FOLD of the existing mutations over `newConfigText`
  (`src/templates.ts`, pure) — `setDut`, `createAgent`, `addClockDomain`,
  `addResetDomain`, `createSubenvs`, `planWireEdits`. Never write template YAML
  by hand: the row's risk ("keys the user did not ask for") is answered by
  there being no second way to produce the text, and `test:templates` locks
  the top-level key set of each plan. Probed on quick-uvm 1.1.0 before the
  design: `interface` and `sequence_item` are REQUIRED on an agent
  (`createAgent` writes them); two clock domains + two reset domains (each
  entry with its `clock:`) + agents with `clock:` / `reset:` generate clean,
  and tb_top wires BOTH resets to the DUT; the clock domain names must be the
  DUT's clock PORT names (tb_top connects `.name(name)`); an agent with no
  `clock:` under a list lands on the FIRST entry of the list, whatever
  `dut.clock` says; an agent with no `reset:` gets the reset RELEASED ON ITS
  CLOCK (the entry whose `clock:` is that clock) and only without one the
  first entry — two DIFFERENT rules, which the Signals view's "Unconnected"
  folders state per agent (`→ <domain>`) and `test:e2e` (scenario 16) locks
  one key at a time (the first cut cleared both keys together, could not tell
  the rules apart, and the reset folder stated the wrong domain — review).
  Under a single clock / reset (a mapping) an agent's own key is REFUSED
  unless it is the single clock's own name (`clock.name`, default `clk` — NOT
  the DUT's clock port): the tree flags it. **A clock LIST with the plain
  reset MAPPING generates NO reset** — quick-uvm's multi-domain path reads
  only a reset list (or `external: true`): no reset net, no generator, the
  DUT's port unconnected, exit 0. So the per-clock template ALWAYS declares
  the reset as a list, one entry included (`resetAsList`; `addResetDomain`
  can only make two), and the Signals row of such a reset says "NOT
  GENERATED". Since D25 the shipped gestures no longer walk into it: `setDut`
  writes `external: true` and `collapseResets` restores it, so
  `addClockDomain` on an Architect-written bench keeps its reset; a plain
  mapping (hand-written, or older than D25) is still the hazard, and
  `reset-undriven` reports it (`test:configcheck`), its `external` repair
  being one way out. `resetAsList` DROPS `external: true` like
  `addResetDomain` (a list is always top-driven) and refuses an AGENT-driven
  reset — its first cut refused the external one, the inverted reading of
  the reset pitfall above, and would have thrown on every per-clock template
  once `setDut` writes the flag. The Signals row of a top-driven reset says
  "driven by the testbench top" (it said "external (not driven by the
  bench)").
  `dutGuess` is the ONE DUT heuristic ("Set as DUT", the subenv skeletons, the
  templates); a reset is a 1-bit input that matches the reset regex — a name
  that says both (`clk_rst_n`, Qsys' `clk_reset_reset_n`) is a RESET, as the
  old inline heuristic had it — and a clock is one that matches the clock
  regex, is not a reset and is not a clock's CONTROL (`CLOCK_QUALIFIER_RE`:
  `clk_en_i` made a single-clock module "multi-clock" with a clock generator
  on its enable; a divided or gated clock is still a clock). Polarity is
  `resetIsActiveLow`, not `ACTIVE_LOW_RE` alone (`aresetn` / `rstn` were
  written active HIGH, unattended). The per-clock template assigns pins by the clock's name TAG
  (`domainTag`: `src_clk_i` → `src`, a fused `wclk` → `w` as a bare prefix);
  what no tag claims goes to an untagged clock's domain if there is one, else
  it is NAMED in the notes; a pin two tags claim is NOT the default domain's
  and is named too; a reset no domain binds is named — a template never
  guesses silently, and every plan carries `notes` shown before a file exists
  (`confirmGesture` kind `create`: asked in every `previewEdits` mode, even
  for one file; under `always` the plan is read in a modal FIRST, whose only
  way on is the preview — the question over the diff tabs is a QuickPick
  title and flattened the notes into one line). From the same review: an
  interface port that gets no agent (no modport, an unresolved instance) and
  every skipped modport signal are noted, as the interactive flow reports
  them; `templateOffers` turns ANY error into an unavailable offer with the
  reason (a null `agents:` entry in an existing block config threw out of
  `planWireEdits` and took all three offers down, silently — the host calls
  the command with `void`); the composition leaves out an instance of the
  view's own module (a recursive module composed its config into itself and
  listed the file twice) and a block with no port an agent could carry
  (quick-uvm refuses a block config without an agent). The
  composition's block configs get ONE boundary agent `<module>_a` (the module
  name is in it: composed blocks share a namespace) — the R12 prefix groups
  would leave unprefixed pins without an agent, and a connection wires agent
  ports; no `params:` are passed (a block agent would have to declare
  `parameters:`), the elaborated widths are used and the note says so. An
  existing block config is never recreated: it is in the plan only if the
  wiring edited it (an agent set passive) — and the host SAVES such a file
  with the creation (quick-uvm reads the disk; a dirty child next to a top on
  disk does not generate). The host never overwrites
  `<module>.quickuvm.yaml` — anywhere in the workspace, not only in the
  active configuration's folder — and creates files WITHOUT `ignoreIfExists`
  (a file that appeared meanwhile fails the edit). "Made the active
  configuration" is said only when it is: `quickuvm.configFile` pins another
  one, and discovery goes back to it. `SignalsProvider` is created before
  `actions` in `activate` — its `assign` callback binds late. A drop's value
  crosses a serialisation boundary (a JSON string when it leaves the extension
  host's memory): `handleDrop` accepts both. The files written with the Write
  tool are LF; git normalises them (autocrlf).

- **Hand-routed wires (docs/04 level 3, decision D27)**: a wire dragged by
  hand is a SKELETON stored per edge — `views.<key>.edges.<edgeId>.route:
  "source+16 source-40 target-16"`, one token per interior segment, the offset
  of its line from the pin at that end of the edge; never an absolute
  coordinate, nothing derived. The rules are pure (`src/webview/wireroute.ts`,
  `test:wireroute`); the two drawers (`routeEdges`, `drawTbEdges`) place the
  valid skeletons first and report what they drew (`WireDrawn`), and `main.ts`
  only forwards gestures. Do not add a second place that decides geometry. The
  sidecar side repeats the R18 / R21 traps (`test:sidecar`, the `D27:` tests):
  `serializeSidecar` WHITELISTS (`edges` must be copied), `viewEmpty` and
  `prune` know the key, `parseSidecar` reads through `cleanEdges` — the same
  reduction `setEdgeRoutes` writes through. `edge/override` is a PATCH by edge
  id (`null` = automatic), not the view's whole set, and the undo history
  follows the same rule: a `LayoutSnap` holds the routes of the edges ITS
  gesture changed (`routePatchOf`), `null` for a block move — the first cut
  snapshot the whole set on every step, and an undo of a move in one surface
  deleted a route added in another (review). An edge id names two PINS, and a
  fold's pin is not its members' pins: `validEdgeIds` builds the scene for
  every fold combination (all of them up to five folds) with every net forced
  to a wire, or a recompile orphans the routes of a view shown with one fold
  expanded, or of a net currently shown as a label. A `tb:` level is never
  invalidated: a route whose edge is gone stays inert. From the two adversarial
  reviews, each locked by a test or noted where it cannot be: (1) the wide hit
  stroke (`.wire-hit`) is what makes a 1.3 px wire grabbable, and in the
  verification view the wires are drawn ABOVE the boxes — it covered the port
  hotspot its own stub ends in, and a press there became a segment drag instead
  of R10's temporary wire: `wireStartAt` / `wireTargetAt` / the hover cursor
  look through `belowWires` (harness-proved, no pure test). It is
  `non-scaling-stroke` (9 px on screen at any zoom) and `.tb-preview .wire-hit`
  takes no pointer events — an explicit `pointer-events` on a child beats the
  group's `none`, the `.tb-name` trap again; (2) a junction dot is drawn over
  its wire: `.junction { pointer-events: none }`, or a press on it starts a
  lasso; (3) a DORMANT edge is drawn from the router's line, so a gesture on a
  sibling froze that line and wrote it over the skeleton that was waiting —
  `WireGeom.asleep`, and `dragWire` leaves such an edge out of `routes` unless
  it is itself moved; (4) "a frozen automatic route must never be invalid":
  three walls broke it — the select / concat chip of the wire's OWN pin (with a
  bus label of three characters it ends 2 px from the stub tip, inside
  `WALL_CLEAR`; the chip rect carries its node's id now), a TB boundary flag
  (no obstacle of the router's, so a wire may bend right at it: `WireRect.flag`
  exempts the edges that end there), and the TB anchors being 2 px off the grid
  (a bend at the pin reads as 2 px backwards: `REVERSE_SLACK`); (5) the level
  branch of a fan is one straight line with a trunk WITHOUT length — frozen at
  mid-span, the trunk appeared twice once the pins stopped being level:
  `trunkThrough` puts it on the group-mate's vertical that touches its row, and
  that zero-length segment is in `runOf` (not pressable, `d = Infinity`) so it
  moves with the trunk; (6) the corner test picked its two segments from the
  first edge only, so a junction was a corner or not by edge order — the
  nearest vertical and horizontal are taken over the whole group; (7) a drag of
  less than half a cell on an axis moves nothing on it (an off-grid line was
  pulled onto the grid by a drag that went nowhere, and committed); (8) a
  result the file form cannot say (a jog on a 41-segment skeleton, an offset
  over 100000) is NOT made — read back as nothing, it deleted the stored route
  at the host (`fitsFile`); (9) `LayoutStore.relayout` clears the routes and
  must ANNOUNCE it (`annotEmitter`): the other surfaces draw from their own
  mirror and the sidebar's Net section counts the routes; (10) a render under a
  wire drag (`resetCanvas` -> `cancelWireDrag(false, true)`) drops the drag AND
  swallows the release's click — the pointer is still captured, and the click
  cleared the selection; (11) a `connections` edge is `e:conn:<from>-><to>`,
  not positional — a route is stored by edge id, and removing one connection
  moved its route onto the next; (12) in the `contextmenu` handler the wire
  check comes FIRST: an interface / reference edge has no `data-id`, and the
  annotations branch takes anything without one for the background. Also: a
  wire gesture pins an un-arranged view first (`pinViewIfUnseeded`, D21); a net
  with a hand-placed edge is never redrawn as a comb; `route()` takes the
  hand-placed polylines as `fixed` occupancy so automatic wires keep off them;
  Shift (the cone) and Ctrl (the toggle) presses are never drags; the candidate
  is dropped on a `pointermove` with no button down (the release happened
  outside the canvas, before the capture). Known and accepted: a TB rename
  leaves the old edge ids' routes inert; a trunk shared by edges with no common
  pin (two drivers, two sinks) can split when one block moves; two hand-placed
  wires of different nets on one line are not prevented; `validEdgeIds`' mixed
  fold combinations have no fixture (the regression view has one fold).

- **Simulation results on the diagram (docs/08 R25)**: the extension READS
  what `make regress` left under `<outputDir>/out` and never runs or waits
  for a simulator — do not add a process. Probed on quick-uvm 1.1.0 +
  Xcelium 25.09 (the fixtures in `scripts/fixtures/results/` are those runs;
  keep them SANITISED — no home directory, no site tool path): the generated
  Makefile writes `runs/<test>.<seed>/{status,test.txt,seed.txt,sim.log}` and
  `cov/summary.txt`. **The verdict is the `status` file's, nothing else's**:
  the Makefile writes it AFTER the simulator exits, so a run without one is
  in flight — UNKNOWN, as the Makefile's own summary skips it; judging its
  half-written log reported a running regression as failing (the watcher
  fires on each finished run while the next one's log is growing).
  Attribution is by reporter PATH first (`elementOfPath`), then by the OWNER
  of the report's source file (the manifest) when the path names nothing
  known, then the env — never by message text, never dropped. The instance
  names are generator policy and differ by MODE; they were assumed once and
  were wrong, so they are probed and listed in `elementOfPath`'s comment:
  `<agent>_agnt[.drv|.mon|.sqr]`, a sequence as `sqr@@<seq>` (strip the `@@`
  tail), a named scoreboard by name but an UNNAMED or INFERRED one as `sbd`,
  a declared collector as `<agent>_cov_h` but implicit mode's as `cov`,
  `vsqr`, `probe_mon`, and `<handle>_agnt` / `<handle>_sb` for replicas and
  instances (sole-agent benches only: quick-uvm refuses them otherwise). The
  env's instance name (`e`) is NOT assumed, only its position. The names come
  from `benchNames(config, inferred)` — pure, DEFENSIVE (it runs on every
  edit of a half-typed file: a bare `-` under `agents:` threw inside the fold
  and results stopped updating), and it needs `inferredComponents(resolve
  .current)`: `resolve` races the manifest, so `resolve.onDidChange` re-folds.
  Traps the real logs taught: the "caught UVM_ERROR" numbers of the report
  CATCHER are 0 on a failing run — only the report server's "Report counts by
  severity" block is read, and only when COMPLETE (a block cut after its
  first line read as zero errors: PASS); a REPORT line is tested before the
  `$finish` line (a message quoting it ended the run); a log without the
  block is a FAIL of a log, never a pass; an imc column NAME contains a space
  ("CoverGroup Covered"), so the table is split on two or more spaces, and
  its rows are per INSTANCE (the DUT's figure is its subtree's sum). Reports
  are FOLDED BY KIND WHILE PARSING and every kept string is copied (`own`): a
  regex capture is a slice of the whole log, and one kept warning retained
  its 8 MB log — 200 runs were gigabytes (measured at the review). The
  message cap keeps the WORST (`keep`): first-come dropped the fatal that
  ended the run behind eight earlier warnings. A unit's reports are counted
  on its agent AND under `agent:<a>:u.<unit>`: the unit keys are read ONLY at
  that agent's level (`levelResults`), or the agent would count twice.
  Coverage is never summed upwards. `levelResults` returns `elsewhere` — what
  was reported and has NO block on the level — and the header shows it: the
  env's own fatal vanished at the Env level, and a level must never look
  clean because its problems are drawn elsewhere. The service keeps what it
  READ (`raw`) apart from the attributed snapshot and caches each parsed run
  by its files' mtimes: a configuration change only re-folds (`update()`),
  and a regression's N status events do not re-read N logs each; the watcher
  is on the `status` files and the summary — what a finished run writes LAST
  — never on the logs. OWNERSHIP: `quickuvm.outputDir` is one folder for the
  workspace; the runs' `-covscope <dut>` is compared with the active
  configuration's DUT and another bench's results are not shown (the
  commands say whose they are). `results/full` is its own message, not a
  field of `status/decorations`. AGE is computed by ONE host function
  (`ageOf`) for the message and the report: `stale` = the config is dirty or
  saved after the OLDEST verdict shown (the newest let one fresh run vouch
  for the old ones); `covStale` = the summary is older than the newest
  verdict or the config. `missed` (the server counted more than was read) and
  `unparsed` are said too. The pills are placed from the `.tb-box` rect's
  `getBBox()` (the group's box includes port labels), stop their own `click`
  (it selected the block and the selection's outline replaced the
  severity's), fit their block (the DUT's three figures ran onto the Env
  block), are redrawn wherever the generation badges are (five call sites,
  `updateLod` included) and on the unreadable-config path, are stripped from
  the SVG export, and `resultByNode` is read by `applyFiltersHere`: a block
  with a failing result is dimmed, never hidden. `openResultSource` looks the
  file up by NAME under the generated bench (`findFiles`): the simulator
  prints a path relative to ITS working directory, which must never be
  resolved against the workspace. The report is a virtual document
  (`quickuvm-results:`), like the traceability report. Found by the probe,
  fixed since (D25 — the reset pitfall above — and, in the generator,
  arcadie-cracan/QuickUVM#119): with the default `reset.external: false`
  quick-uvm 1.1.0 wires `.rst_n(<primary agent>_if_inst.rst_n)` in tb_top,
  while Architect keeps reset pins out of agents — such a bench generates
  clean and fails elaboration (`*E,CUVUNF`).

- **The tutorials' figures are CAPTURED, never drawn** (`npm run shots`,
  `scripts/capture-shots.mjs`, Nov 2026): the shipped `dist/webview.js` in
  `scripts/harness.html`, fed by a SCENE file (`?scene=<url>`: model, config,
  overlay, resolved, proposals, results, selection — what a host would send,
  in the host's order) and photographed by a headless Chrome / Edge at 2x.
  The inputs are real — a `svmodel` run of the fixture, the YAML the mutations
  write gesture by gesture (the router's too: built from the walkthrough's
  steps, NOT read from QuickUVM's hand-written example, whose constraint is at
  agent level while the step sets it on the port), `overlayOf`
  (`src/overlay.ts`, extracted from `ConfigService` so both build the same
  one), `proposalsFor`, a real `quick-uvm resolve`, and for the results figure
  the Xcelium fixtures. After a UI change, re-run it and READ the figures
  against the steps' text: the walkthrough still said "MORE" / "ADVANCED"
  three months after R16 renamed them "ALL". `docs/tutorial-shots/layouts.json`
  is the user's HAND ARRANGEMENT (`--arrange`: every drag in the served
  harness is POSTed back and saved, one sidecar per bench — the views of a
  bench share it); it is keyed by the layout keys, so renaming a scene's
  config path orphans it (the keys were migrated once, by hand). The POST
  is fired for a LIST of message types in `scripts/harness.html`, after the
  blocks that apply each of them to the harness sidecar: a new sidecar
  message must be added to both, or the gesture is not saved —
  `edge/override` is in it, so a figure can carry a hand-routed wire (docs/04
  level 3). Traps: a
  headless Chrome window is never narrower than ~500 px — a 420 px capture is
  a CLIPPED 500 px layout (the panel's right edge cut); the panel captures
  need the side bar's own structure (`body.sidebar`, the panel as the page),
  not the harness's flex row; `spawnSync` of the browser blocks the script's
  own HTTP server (the browser is awaited); the first snapshot of a headless
  run needs `--virtual-time-budget` (ELK is asynchronous); the arrange server
  takes ~20 s to answer (svmodel + one `resolve` per scene come first). The
  captures are NOT VS Code windows: no activity bar, tree or QuickPick — said
  in the tutorial and in the shots' README. The overlay test that came with
  the extraction caught `agentPorts` ignoring `inouts` (an agent's inout pin
  was drawn unmapped and counted against the coverage).

- **A sidebar action has no view unless the host gives it one** (found at the
  manual validation, Nov 2026). The Properties side bar mirrors the diagram
  panel; its `action/request` reached `onWebviewAction` WITHOUT the third
  argument the panel passes (`this.currentView`), so from the day the
  configuration buttons moved there (24 Jul 2026) every action that needs the
  view — "Set as DUT", "New testbench…", "Create subenv", "Wire connections",
  "Compose into parent", "Create probe" — answered "open the symbol view of an
  instance first". Four months, unnoticed: the tree's context menu and the
  command palette pass the instance themselves, the harness IS the panel, and
  no suite reaches the host's message routing. The sidebar's handler now
  passes `DiagramPanel.current?.currentView`. Do not add a third surface
  without asking what its gestures are ABOUT. With it: "Set as DUT" and "New
  testbench…" act on the ONE instance block selected in a schematic, else on
  the view's module (`rtlActionTarget` in `src/inspector.ts`,
  `test:inspector`), and send it in `args.viewId` like the agent gestures on a
  child block — with `u_soc` clicked in `demo_top`'s schematic the tree
  highlights `u_soc` and the panel is headed by it, and acting on the VIEW
  would have made the parent the DUT. An interface instance, a fold, a pin or
  several blocks fall back to the view.

- **The first `analysis:` entry keeps what quick-uvm inferred** (docs/07
  "Interim", Nov 2026 — planned in August, found unimplemented by an audit of
  the plan, and measured with `resolve`: a first scoreboard took the inferred
  coverage away, a first coverage on another agent took the inferred
  scoreboard AND the collector, silently). "Add scoreboard" / "Add coverage"
  on an implicit bench (`analysis` absent, or present with no value) ask the
  generator what the LIVE text resolves to and write the inferred components
  with their own entry, in ONE edit. Rules, each locked by a test: (1) the rule
  is the user's — inferred coverage is always kept; an inferred scoreboard is
  kept unless the new one has the SAME source agent, then it is REPLACED
  (`keepOnFirstAnalysis`, `test:resolved`); the set is `resolve`'s, never
  re-derived. (2) The resolved view must be of the LIVE text:
  `quickuvm.autoSaveConfig` is off by default, so at the first analysis
  gesture the disk — which the cache describes — usually lacks the agents just
  created; `ResolveService.resolveText` resolves a copy from a temporary
  folder (never the workspace: a scratch `*.quickuvm.yaml` there would be
  discovered as a configuration), with a timeout and a status-bar progress
  (about a second of Python), and the plan refuses an answer whose agent list
  is not the live one's, in order (the primary agent is the first). (3) The
  text is a FOLD of `addScoreboard` / `addCoverage` (`addScoreboardKeeping` /
  `addCoverageKeeping`, `test:yamlops`) — byte for byte what the gestures made
  one by one write, so the tutorial's listing does not depend on the path
  taken; `test:e2e` scenario 17 asks the generator before and after, and keeps
  the bare mutations' loss as a mutation proof. (4) The names of the kept
  inferred scoreboards are TAKEN in the name prompt; a replaced `sbd` leaves
  its name free, which is the prompt's default. (5) An unknown inferred set is
  ASKED about in a modal before writing, never assumed, and the modal says
  WHY (`LiveResolve.why`: no `resolve` command, the configuration refused with
  its first error line, the text changed meanwhile, the process failed) — one
  text for all sent a user with an old quick-uvm to "save and try again"; what
  was kept or replaced is said afterwards. (6) `analysis:` with no value is a
  null scalar and `setIn` cannot descend into it: the two add mutations THREW
  on a file the scene draws as an implicit bench; `openAnalysis` gives it an
  empty mapping in place (position and comment kept). From the adversarial
  review, each reproduced against the generator: (7) **`resolve` over-reports**
  — 1.2.0 reports `sbd` + a collector on `agents[0]` for ANY bench without
  `analysis:`, but on a composition (`subenvs`, pure or hybrid), on `kind:
  vip` and on an agent with `replicas` > 1 / `instances` the generator
  generates neither and REFUSES both once declared; the first cut "kept" them
  and turned benches that generated into benches that do not.
  `inferenceIsReal` (`src/resolved.ts`) fences those shapes: the plain gesture
  there, and — the same lie, older — no ghost in the scene, no materialise
  row in the proposal strip (`inferredComponents(resolved, config)`: pass the
  live config wherever there is one). It is the ONE place the extension knows
  where inference happens; each shape has a four-leg lock in scenario 17
  (resolve still reports it, the implicit bench generates WITHOUT the
  components, the plain gesture generates, the reported set declared is
  refused with that shape's wall), so a quick-uvm that wires a shape, or stops
  over-reporting it, fails a leg that says which. A selftest is NOT fenced: it
  really generates `sbd`. (8) The NEW entry is written FIRST: a wire drop
  gives its drop point to the first node of the kind that was not in the
  pre-gesture scene (`renderTb`), and with the kept entry first that was the
  former ghost, which jumped and lost its seat. (9) The plan is for an
  implicit text: applied to a text that declares `analysis:` by then (a
  second click, a hand edit while the name box waited) the folds run the plain
  mutation — the second click threw "scoreboard sbd already exists", and a
  hand-declared `scoreboards: []` got an `sbd` nobody asked for. (10)
  `addCoverage` on an agent already covered returns the ORIGINAL text (it
  re-serialised: a phantom edit on a hand-formatted file). Consequence for the
  tutorial: step 5's scoreboard gesture already writes `coverage: [ cmd ]`;
  "Coverage collector" pressed afterwards has ONE candidate left (`rsp`) and
  adds it without asking. With a kept scoreboard beside the new one the
  message also says that quick-uvm renames the generated files after each
  scoreboard (`<dut>_scoreboard.svh` -> `<dut>_<name>_scoreboard.svh`): a
  prediction written in the single scoreboard's file stays in the old one.
  Still open: an inferred component cannot be deleted from the diagram (a
  ghost is read-only); the matrix editor still disables its cells on an
  implicit bench; `analysis: ""` / `analysis: []` / an anchored null still
  throw in the add mutations; the host glue (`resolveText`, the modal, the
  message) runs only in VS Code and has no test.

## Current phase

Phases 0–2 are closed: 0 (backend validation), 1 (extension skeleton + the
symbol view; ticked interactively on common_cells, `examples-bender/`),
2 (the QuickUVM configuration: the overlay from the YAML through
`ConfigService`, the actions
`setDut`/`createAgentFromPins`/`createAgentFromIface`/`ignorePort` through
`WorkspaceEdit` with pure mutations in `src/yamlops.ts`, model↔YAML
validations with a width quick-fix, the side inspector, "Generate testbench"
with the `python -c` fallback; validated with `npm run test:e2e` and ticked
interactively in the Extension Development Host). Phase 3 is in progress: the
schematic view from `views` is implemented read-only (Jul 2026) — the pure
scene in `src/webview/scene.ts` (child nodes with parameters, the generate
fold `g_ch[0..2].u_ch` with expanding/re-folding, edges from the nets with
dedup over the folds, labels for `render=label`, select/const/nc/concat
annotations, interface edges), layout and drawing in
`src/webview/schematic.ts`, full navigation (the mode derived from the
selection in the hierarchy — no Symbol/Schematic switch, D24; double-click =
enter the block — the schematic if there is one, the source at leaves;
Ctrl+double-click = the source anywhere; the breadcrumb, the command
`quickuvm.openSchematicView`, diagram→hierarchy synchronization), an extended
protocol (`view/show.mode`, `nav/drill.mode`); tests in `npm run test:scene`,
interactive validation in `scripts/harness.html`.
Drag + sidecar are implemented (Jul 2026): the positions/folds/flips are
persisted in `.vscode/quickuvm-architect.yaml` (pure mutations in
`src/sidecarops.ts`, `npm run test:sidecar`; the host service `src/sidecar.ts`
with atomic writing, a watcher and graceful invalidation with the restoring of
the orphans; the messages
`layout/full`/`layout/snapshot`/`fold/toggled`/`node/flipped` from docs/05;
the camera is session state, not project state — the first opening of a view
is always fitted into the window, docs/04); the edges of ALL the schematic
views are routed with the project's own A* grid router in `routeEdges`
(`src/webview/schematic.ts`, `src/webview/router.ts`, `npm run test:router`;
halo + text obstacles on the pin labels; a naive fallback for each edge
without a path) — ELK gives only the positions, and the world on the grid is
universal (docs/04). On recompilation, the user's positions become seeds for
interactive ELK: the known nodes stay exactly in place, only the new elements
get positions, inserted in context; the seeds are total or absent (D21, Jul
2026) — drag-end persists the snapshot of the whole view (`layout/snapshot`),
the rendering of an arranged view pins the elements without a seed, and
`layout/full` is sent before `model/full` at `ready`; "Re-arrange all"
(the ⟲ button, `relayout/request`) is the only path to a total re-layout. The
pins sit on the grid by construction (`FIXED_POS` ports, the first centre at
+40, pitch 24 (PIN_PITCH), dimensions multiples of 8 — an aligned pin = a
straight wire, docs/04), and the blocks support H/V flipping (the pin slots
are reassigned, not mirrored; the H/V keys + the inspector; `node/flipped` →
sidecar). The world on the grid is universal: all the positions, the boundary
flags included (movable, keys `<port>.x`), are rounded to the grid at every
render (docs/04). Interactive ELK for new elements + "Re-arrange all" (⟲) are
implemented. The libavoid vs. own router decision is closed — D20 (the own
router, with re-evaluation conditions in the journal). The level 4 override
(wire↔label per net) is implemented (Jul 2026): a click on the route or on the
net's label → the Net section of the inspector with "Show as label"/"Show as
wire"; the `net/render` message, persistence in the sidecar under
`nets.<net>.render` only on a deviation from the model's suggestion, graceful
invalidation with `kind: net`; level 1 (style) is postponed — there is a
single routing style. `createSubenv` is implemented (Jul 2026): the "Create
subenv" button in the inspector on the blocks selected in the schematic view
(the folds are expanded into their members), a multi-select confirmation, the
missing block configs are created as a skeleton + a heuristic dut; the
`createSubenvs` mutation in yamlops (sanitized SV names, `params` integers
only — the schema requires `dict[str,int]`, `layout: packaged` ensured on the
top); mind the H1 constraints of QuickUVM (HEAD, Jul 2026): the children with
a clock are accepted as of the M1 slice if they are single-clock with at most
one reset, `params` require `parameters:` declared in the block's agent
(docs/03); scenario 3 of `test:e2e` covers the composition, a child with a
clock included.
**Phase 3 is CLOSED** (Jul 2026, the criterion ticked on common_cells —
docs/06). **Phase 3b is in progress** — slice 1 (the read-only verification
view) is implemented as a **level-based model** (D24): the flat per-level
scene `TbScene` with `focus`+`breadcrumb` in `src/webview/tbscene.ts`; every
block = a UML box (a stereotype + text compartments with the internal
structure), a double-click on a block with `drill` descends one level (`""`
testbench → `env` → `agent:X`), with boundary flags for the connections that
cross the level. **The direction of the ports is visible** (Jul 2026): all the
edges have an arrow at the end (the sense of the data → source = output,
target = input), and the boundary flags show their direction through the
orientation of the tip — `dir` deduced from the edges in `buildTbScene` (`in`
= source only → the tip pointing inwards; `out` = target only → the tip
pointing outwards; `inout` = both → a flattened hexagon, the fusion of the
two tips). Thus `<if>` on an active agent = a hexagon (the driver drives + the
monitor samples), on a passive agent = `in` (sampling only); `<ap>` = `out`,
`<sqr>` = `in`. The monitor's `if` port sits on the EAST (like the driver's,
the DUT's side) — otherwise the wire `if→monitor` went around the monitor (4
bends/430px → 2/182px). The TB root = DUT + Env (D24); the DUT is drawn when
`dut.name` exists AND it is verified directly — a leaf config OR a hybrid:
`hasDut = dut.name && (no subenvs || has agents)`; it is omitted on the PURE
subsystems (subenvs without agents), where `dut.name` is only the packaging
container (`buildTbScene` in `src/webview/tbscene.ts`). NOTE 1.0 — the hybrid
(subenvs + agents of its own) is LEGAL (boundary agents H2): the hybrid branch
of `hasDut` draws a VALID config now; the hard diagnostic was removed (see the
updated pitfall in the composition section). Flat layout+drawing in
`src/webview/tbschematic.ts`
(ELK layered, FIXED_POS ports on the grid, the shared A* router with the nodes
as obstacles; isolated from the RTL `schematic.ts`). Navigation: `tb/focus`
(webview→host, drill/breadcrumb) + `tb/navigate` (host→webview, reveal from
the tree), synchronization on the identity `<focus>|<block>`. The
`config/full` message, `ViewMode: "tb"`, the key `tb:<config-path>` (the
sidecar invalidation does NOT touch the `tb:` views), the command
`quickuvm.openVerificationView`.
**Drag + positions in the TB view are implemented** (Jul 2026): the same
drag/sidecar/seeds/D21/camera/⟲ mechanics as the RTL schematic view, keyed
**per level** — `layoutKey()` returns `viewId` for RTL and
`tb:<config>|<focus>` for TB, because the node ids repeat between the agent
levels (`u.sequencer` at `agent:cmd` and `agent:rsp`) and would collide under
a common key. `layoutTb` receives `seeds` (interactive ELK, like
`layoutSchematic`), `renderTb` forces the seeds + pins the elements without a
seed (D21 total, the boundary flags included). The `TbPlaced` ports are now
**relative** to the node's origin (the anchor = `n.x + offset`), so the wires
follow the block on drag without a re-layout; `drawTbEdges` is reusable for
the live re-routing. The drag handles are polymorphic (`dragChild`/`dragReroute`/
`dragEachPos`/`dragSelector` branch on `state.mode`; RTL unchanged).
**Flip in TB** (Jul 2026): on **blocks**, H swaps the sides of the ports
(west↔east), V reverses the order on each side (like RTL, through `flipPorts`
in `tbschematic.ts`; `toggleFlip` uses `layoutKey()`; the H/V keys + buttons
in the inspector). On **boundary flags**, H does a **LOCAL horizontal
flip** (`TbBPlaced.flipH`, consumed by `drawBoundary`+`anchor`): it mirrors
the shape around its own centre AND moves the anchor to the opposite side of
the flag, BUT **does not change its ELK position/side** (so
`FIRST/LAST_SEPARATE` stays satisfied — no throw). On an `inout` flag (a
symmetric hexagon) the shape does not change, but the anchor jumps from one
tip to the other — useful: it chooses which connection comes out straight
(e.g. `<if>` at agent level: unflipped → `driver→if` straight and
`if→monitor` with a bend; flipped → the reverse). On a directional flag, the
mirroring + moving the anchor to the outer side produce a bend (the block is
always on the inner side) — a purely local, reversible flip (D24, the user's
explicit request). V makes no sense on a flag (a single connection). **Why
ONLY local, not a move to the opposite side** (probed empirically,
`scripts/_probe-flip*.mjs`): ELK layered fixes the side of a directional flag
by the direction of the edge (source→first layer/left, target→last
layer/right) and **ignores a seed on the opposite side** — even WITHOUT
`layerConstraint` (`<ap>`, a target, seeded at x=8 → ELK keeps it at x=792). A
flip that changed the ELK side would require `FIRST_SEPARATE` with an incoming
edge (or the reverse) → ELK **throws** (`UnsupportedConfigurationException`)
and `renderTb` used to fail SILENTLY. That is why the flip is local (pure
post-layout geometry, no ELK).
**`inout` flag + seeds**: an INOUT flag satisfies NEITHER of the constraints →
it gets NO `layerConstraint` (ELK places it in the middle; as a bonus, the
`if→monitor` detour disappears, and `monitor.if` returns to the WEST).
`renderTb` catches any throw from `layoutTb` (a banner, not a silent failure).
The arrow of the edges is `markerUnits: "userSpaceOnUse"` (a fixed size, not
scaled with the wire's thickness — otherwise the thick interface wire inflated
it, and on hover it shrank). The harness supports `mode=tb` (it injects
`config/full` + persists snapshot/`node/flipped` in `sessionStorage`).
**The DESIGN unification (D24) is implemented** (Jul 2026): the RTL view no
longer has a Symbol/Schematic switch — the mode is derived from the node
selected in the hierarchy. The Design Hierarchy tree has a **synthetic "top
module" root** (`src/tree.ts`, `InstanceNode.inst` optional, `contextValue`
`top-root` vs `instance`) immediately above the top: a click on "top module" →
the **symbol** of the top (`openSymbolView`, mode `symbol`); a click on any
named node → its internal **schematic** (`openSchematicView`; the leaves fall
back gracefully to the symbol in the webview). A "Set top module" button on
the root (inline `$(gear)` + context menu + a link in the welcome view).
`nav/drill` carries `mode` so that the host can tell the top's symbol (reveal
on the synthetic root) from its schematic (reveal on the instance's node):
`panel.ts` keeps `currentMode`, `revealInstance` in `extension.ts` chooses the
root only for `mode==="symbol" && viewId===tops[0]`.
A pitfall resolved at review: `model/full` does NOT send `nav/drill` at the
first opening (the host sends an explicit `view/show` right after anyway — a
`nav/drill` would race it and pin the host on the top); it sends it only at
the recompilation that deletes the current view (when NO `view/show` comes).
The sidebar has two sections: **Design Hierarchy**
(the RTL tree, `src/tree.ts`) and **Verification Hierarchy** (the tree of the
TB environment derived from the config, the pure `src/tbtree-build.ts` +
`src/tbtree.ts`); the ids of the verification tree coincide with those of the
TB diagram (both from `buildTbScene`), so the tree↔diagram navigation is
symmetric with no mapping (the command `quickuvm.revealTbComponent`, the
message `select/reveal`). **Slice 2 (editing) is implemented**: adding (a
palette in the inspector), **deleting** and **editing the properties** (Jul
2026). Pure mutations in `src/yamlops.ts`: `removeScoreboard`/`removeCoverage`/
`removeVirtualSequence` (leaves, idempotent on a missing target — a no-op =
unchanged text, like `addCoverage`), `removeAgent` (a cascade: the agent's
coverage, the scoreboards with `source`/`monitor`==agent — the whole
scoreboard is deleted, it is not degraded —, the vseq steps that use it + the
sequences left empty; `subenv_scoreboards` has endpoints `<subenv>.<AGENT>` —
names qualified with a subenv prefix, which refer to agents of the CHILD
configs (other files), not to the bare agents of the current config, so
`removeAgent` (which compares bare names) rightly does not touch it) and
`setScoreboardField` (a generic field; the default value is deleted —
`match=in_order` or empty; **cascade**: an empty monitor → single-stream
deletes `match`+`match_key`, `match=in_order` deletes `match_key`; it does NOT
force flow, so the hand-written style stays). The emptied blocks are cleaned
up through `pruneEmptySeq`/`pruneEmptyMap` (like `writeIgnored`). Host actions
in `src/actions.ts`: `deleteComponent` (a **modal** confirmation
`showWarningMessage {modal:true}`; for an agent, `detail` summarizes the
cascade through `agentCascade` — the sequence disappears only if ALL its steps
are the agent's, otherwise "a step in X") and `editScoreboard` (**inline**
editing: the value comes from the inspector, `max_latency`→`Number`). ID→name
in the inspector: `tbsb`→`sb.name` (looked up by label), `tbcov`→the agent in
`cov:<agent>`, `tbagent`→the label, `tbvsqr`→one Delete button per
`virtual_sequences[]`. The property editor (`tbScoreboardEditor`): `<select>`
source/monitor (the monitor excludes the source)/match (disabled without a
monitor), `<input>` match_key (disabled unless it is out_of_order)/max_latency;
`ActionKind` `deleteComponent`/`editScoreboard` (protocol.ts). Validated in
`scripts/harness.html?mode=tb` (the correct messages on scoreboard/coverage/agent/
vseq). **Invariants hardened at the adversarial review** (do not reintroduce
the regression): (1) a delete without a target returns the ORIGINAL text
byte-identical (not `doc.toString`), otherwise a no-op would re-serialize and
delete hand-written empty containers (`scoreboards: []`) → a phantom
WorkspaceEdit; `removeNamedFromSeq` returns a `bool`, the caller
short-circuits to `text`. (2) `removeAgent` cleans ONLY the containers that
THIS operation emptied (`covChanged`/`sbChanged`/`vseqChanged`), and a vseq
disappears only if steps were actually taken out of it (`stepsRemoved > 0`) —
a pre-existing `body: []` stays, consistent with what `agentCascade` promises
in the modal. (3) `setScoreboardField` REFUSES the emptying of `source`
(mandatory, A2). (4) In the editor, the Source `<select>` excludes the current
monitor (and vice versa), as at add. (5) The `tbsb` branch of the inspector is
restricted to `id.startsWith("sb:")` — the cross-block `xsb:` nodes
(`subenv_scoreboards`) have another source and have no editor/delete yet. (6)
Deleting also has a **keyboard gesture** (`Delete`/`Backspace` on the selected
TB node → the same `tbDeleteTarget` + modal confirmation as the button); the
`keydown` handler (on `window`) short-circuits if `e.target` is
`INPUT`/`SELECT`/`TEXTAREA`/contenteditable — otherwise `f`/`h`/`Delete` typed
in the inspector's fields (match_key, max_latency) would command the diagram
instead of reaching the field. (7) A **context menu** in the TB view
(`contextmenu` on the canvas): a right-click on a component → Open (if it has
`drill`) / Flip H / Flip V / Delete (marked `danger`); on `vsqr` one entry per
sequence, on a flag only Flip H, on DUT/Env no Delete; on the background
`preventDefault` is NOT called (the default menu stays). It closes on Escape
(before the selection is cleared), on a `pointerdown` outside (a listener on
`window` in the **capture** phase, so that it precedes the canvas's handlers)
and on zoom. A right-click on an element OUTSIDE the selection selects it (the
editors' convention). `tbDeleteTarget` is the single source of the id→name
resolution for the button, the key AND the menu (they cannot diverge).
**Slice 3 is in progress** — **the whitebox probe (K2) is implemented** (Jul
2026): you select a net in the schematic view → "Create probe" in the Net
section sends `createProbe {net}`; all the deduction lives in the **pure**
module `src/probe.ts` (`proposeProbe` — it resolves the DUT instance from the
MODULE name in the YAML, computes the XMR path relative to it and derives the
width correctly; `test:probe`, 15 tests on the real model). The refusals
replicate exactly what the generator rejects (see the pitfalls above). The
mutations `addProbe`/`removeProbe` in yamlops (`probes` is a top-level list,
it is cleaned up when empty — it is NOT like `analysis`); deleting the probes
is in the TB view (the `probes` node aggregates them, so one button per probe,
as for `vsqr`).
**The derived composition is implemented** (Jul 2026): `deriveConnections` in
the pure module `src/compose.ts` (`test:compose`) turns the inter-block nets
of the schematic view (a net without a `<port>.X` endpoint, one output → one+
inputs across subenvs) into `connections`, with the direction from `port.dir`
and the width from the model; the gesture "Wire connections from design"
(`wireConnections`) writes `connections` through `addConnections` AND
automatically makes the agents of the destination blocks passive
(`setAgentActive(false)`) — an ATOMIC `WorkspaceEdit` over several files (the
top + the child configs); when a child has no agent yet, it warns. `test:e2e`
scenario 6 proves the chain + that an active agent is refused and the flip
repairs it.
"Compose into parent bench" (`composeIntoParent` → the pure
`parentComposition` + `createSubenv`) is implemented (one level, from the
child; ≥2 blocks). **Slice 4 is implemented** (Jul 2026): `QuvmConfigEditor`
(`src/customeditor.ts`) is the DEFAULT editor of `*.quickuvm.yaml`
(`customEditors` `priority: default` in package.json) — you open the file →
the TB diagram, with the native text fallback. TB is config-driven (`renderTb`
does not touch `state.model` — verified; the header omits the "Design" button
without a model), so it is rendered from the document's text; the layout goes
through the SHARED sidecar (`tb:<path>`), the editing gestures apply to the
DOCUMENT. The key refactor: the `TbEditTarget` interface
(`current`/`configUri`/`apply`) — `ConfigService` satisfies it (the ACTIVE
config), `DocumentEditTarget` (in customeditor.ts) implements it (the open
document), and the TB editing gestures in `actions.ts` take
`cfg: TbEditTarget = this.config` → THE SAME methods (with their QuickPicks)
work on either target, zero duplication. `diagramHtml` (in `panel.ts`) is the
shared webview HTML. Any text change → `config/full` → re-render (no loop).
Validated in the harness with `?nomodel=1`.
**Phase 3b is CLOSED** (16 Jul 2026): the user went through the whole
tutorial `docs/tutorial-yapp-buffer.md` in the Extension Development Host —
the closure criterion (an environment with ≥2 agents + a two-stream
scoreboard + coverage, built and re-arranged entirely graphically, a readable
YAML, a clean `generate`) is ticked. **The MVP is validated.**
After the closure a **hardening pass over the test net** was run (16 Jul
2026): the regressions PROVEN real that had no guard got tests through
extractions-to-pure — `src/filelistops.ts` (.f quoting + the outputDir
exclusion + `resolveLocPath`; `test:filelist`), `src/heuristics.ts` (the name
regexes, `_ni/_bi` included; `test:heuristics`), `src/configcheck.ts` (the
core of the model↔YAML validations: `checkConfig` returns structured findings,
config.ts only maps them onto Diagnostic with l10n — D19; `test:configcheck`),
`subenvName`/`subenvMapping`/`planWireEdits` in `src/compose.ts` (the
rel→subenv mapping with the exclusion of the ambiguous ones + the plan of the
multi-file edit with folding per shared file; `test:compose`), `edgeObstacles`
in `schematic.ts` (the obstacles from the labels: PIN_PITCH height + the
exclusion of the wire pins; `test:router`), `probeCoverageAllowed` in
`probe.ts` and `isComposedChild` in `yamlops.ts` (it compares the paths
NORMALIZED — the old `includes(fsPath)` missed the case differences on
Windows). At the same time: the two raw NUL bytes in `yamlops.ts` (separators
of dedup keys) became escaped `\0` sequences — a raw NUL makes ripgrep treat
the file as BINARY and silently excludes it from searches.
**Sprint R10–R11 (docs/08) is implemented** (Oct 2026): the temporary-wire
gesture — creation from a port's hotspot into empty canvas, connection with
legality before the drop — on the pure module `src/webview/wiring.ts`
(`test:wiring`), the `addAgentPorts` mutation + `addPinsToAgent` action; see
the pitfall above and docs/05.
**R12 (docs/08) is implemented** (Oct 2026): designer assistance — the proposal
strip over the canvas (interfaces and pin groups without an agent, unwired
subsystems, the inferred ghosts materialised through `materializeAnalysis`);
`src/proposals.ts` + `test:proposals`, the `applyProposals` action.
**R14 (docs/08) is implemented** (Oct 2026): in-place rename (F2 / title
double-click / context menu) with the cascading mutations `renameAgent` /
`renameScoreboard` / `renameSubenv` (`test:yamlops`) and the `renameComponent`
action.
**R13 (docs/08) is implemented** (Oct 2026): inline widgets on the TB boxes
(`active` on agents, `match`/`latency` on two-stream scoreboards) through the
existing `editAgent`/`editScoreboard` actions; `TbNode.widgets` in
`test:tbscene`.
**R15 (docs/08) is implemented** (Oct 2026): the "what will this generate"
hover card (YAML entry, owned files from the manifest, ●/U/M state, open
generated code / YAML beside); `card/request` / `card/full`, the
`openGeneratedCode` action, `ownedFilesFor` in `test:genstate`.
**R17 (docs/08) is implemented** (Oct 2026): the contextual action palette
(Ctrl+Space / Ctrl+/ / the "Actions" header button) — the legal actions for the
selection, recent first; `rankPalette` / `pushRecent` in `test:navfind`.
**R19 (docs/08) is implemented** (Oct 2026): the YAML diff preview before a
destructive or multi-file gesture (`quickuvm.previewEdits` = ask / always /
never; `src/preview.ts` + `test:preview`, `src/previewdiff.ts`,
`TbEditTarget.readText`).
**R11's composition half is implemented** (Oct 2026): the connections wire
between `sub:` boxes (`sub-port` origin in `test:wiring`, `singleConnection`
in `test:compose`, the `addConnection` action through `applyWirePlan`).
**R18 (docs/08) is implemented** (Oct 2026): a TB block collapsed to its
header (`C`, `node/collapsed`), an RTL view's nc / ignored pins hidden
(`Ctrl+H`, `view/pins`, `pruneNcPins` in `test:scene`), the hover preview of a
composed child (`config/full.children`); `setCollapsed` / `setHidePins` in
`test:sidecar`, the collapsed height in `test:tblayout`.
**R16 (docs/08) is implemented** (Oct 2026): the Declared / Common / All
inspector — provenance per field (`fieldGroups` + the schema defaults in
`src/inspector.ts`, `test:inspector`), bold when off the default, ⟲ removes the
key, dimmed placeholders for the generator's defaults.
**R20 (docs/08) is implemented** (Oct 2026): the generated code next to the
diagram — the selection lights the element's lines in the visible generated
editors, `quickuvm.codeFollowsSelection` docks its primary file beside, a
CodeLens per generated file leads back to the verification view (inferred
elements flagged), `quickuvm.traceabilityReport`; `src/trace.ts` +
`test:trace`, `src/trace-service.ts`.
**The reset mapping was corrected** (Nov 2026, D25): the tutorial bench generated
cleanly and did not elaborate. `setDut` now writes `reset: {external: true}`
(derived), old configs get the `reset-undriven` error with its repair, and
`test:e2e` lints every generated top; see the pitfall above. "MVP validated"
means validated against the generator — a simulator compile is the user's. The
tutorial bench WAS then compiled and simulated (Xcelium 25.09-s002, 21 Nov
2026): it elaborates and, with the stub-predictor scoreboard removed, runs to
`$finish` with 0 errors; the old shape reproduces `*E,CUVUNF`. The table, and
the generator-side fix (arcadie-cracan/QuickUVM#119, released in quick-uvm
**1.2.0** on 21 Nov 2026 — 1.1.0 and older do not have it), are in
`docs/upstream-quickuvm-reset-undriven.md`. Architect still writes
`external: true` and still reports `reset-undriven`: both are right on every
1.x, and 1.2.0 is not the minimum version.
**Sprint R6–R9 (docs/08) is implemented** (Nov 2026): level of detail on zoom
(`lodFor` / `titleUpscale` in `test:navfind`, `quickuvm.lodZoomThreshold`),
marquee modifiers + align / distribute / straighten (`src/webview/arrange.ts`,
`test:arrange`, `quickuvm.lassoMode: direction`), the invalid-config banner
with "Open as text" and the empty states that name the next action
(`quvmParseError` in `test:yamlops`, `config/full.parseError`,
`quickuvm.openConfigAsText` / `openConfigAsDiagram`), multi-selection editing
in the inspector (`multiGroups` in `test:inspector`, the `editAgents` /
`editScoreboards` actions).
**R21 (docs/08) is implemented** (Nov 2026; decision D26): secondary notation
— frames (member lists with derived boxes, `Shift+G`), sticky notes (`N`) and
node colours as VIEW annotations in the sidecar; `src/webview/annotations.ts`
+ `test:annotations`, `setAnnotations` / `cleanFrames` / `cleanNotes` in
`test:sidecar`, the `view/annotations` message.
**R22 (docs/08) is implemented** (Nov 2026): the matrix editor — agents x
scoreboards / coverage and block outputs x block inputs as an overlay table
whose cells send the existing host actions; `src/webview/matrix.ts` +
`test:matrix`, the `removeConnection` action.
**R23 (docs/08) is implemented** (Nov 2026): per-view filter rules (hide /
dim / show / colour x kind x name pattern) as presentation over the same
scene, with a header chip while any rule exists; `src/webview/filters.ts` +
`test:filters`, `setFilters` in `test:sidecar`, the `view/filters` message.
**R24 (docs/08) is implemented** (Nov 2026): "New Testbench…" with three
templates (agent per interface / per clock domain / composition from the
sub-blocks) as folds of the existing mutations, and the Signals tree view with
drag-and-drop of agents onto clock / reset domains; `src/templates.ts` +
`test:templates`, `src/signals.ts` + `test:signals`, scenario 16 of
`test:e2e`, the `newTestbench` action and the `assignDomain` host flow. The
QuickPick flow and the tree's drag-and-drop still need a manual pass in the
Extension Development Host.
**R25 (docs/08) is implemented as a first slice** (Nov 2026): the last
regression's results READ from `<outputDir>/out` and shown on the verification
view — error / warning counts and severity colour on the blocks, coverage
figures on the collectors and the DUT, the runs' verdicts in the header, a
results report; `src/results.ts` + `test:results` (22 tests on real Xcelium
logs), `src/results-service.ts`, the `results/full` message, the commands
`quickuvm.refreshResults` / `showResults` / `hideResults`. The watcher, the
commands and the report need a manual pass in the Extension Development Host
against a real `make regress`.
**Level 3 of the routing overrides is implemented** (Nov 2026, decision D27):
wires dragged by hand in the schematic views and on every level of the
verification view — a segment, a corner / junction, a pin stub lifted into a
jog — stored per edge as a skeleton anchored to the pins, dormant when it no
longer fits, reset from the context menu / the inspector / ⟲;
`src/webview/wireroute.ts` + `test:wireroute` (45 tests), the `D27:` tests of
`test:sidecar`, the `edge/override` and `relay/resetRoute` messages. Verified
in `scripts/harness.html` with scripted pointer events, and **validated by the
user in the Extension Development Host** (21 Nov 2026): the gestures and the
cursor shapes in both view families, the sidebar's "Reset route" (the relay
through the host), ⟲ with its undo, and the refresh of a second surface (the
panel and a per-file editor on the same level).
The complete plan: `docs/06-plan-mvp.md`.
