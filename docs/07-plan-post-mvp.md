# 07 — Post-MVP plan: the generation feedback loop + schema parity

Continues `docs/06-plan-mvp.md` (MVP closed, Phase 4 finished). Three directions
requested by the user (Jul 2026), investigated empirically in **both** repos (QuickUVM
the generator + QuickUVM Architect the extension). The schema reference used
throughout: `docs/quickuvm-schema-reference.md` (the v1.0.0 surface).

**The architectural finding** (confirmed independently by the investigations of line 1
and of line 2): directions 1 and 2 BOTH need the same primitive — an authoritative
mapping **config element → generated files**. Hard-coding this mapping in TypeScript
drifts (the generated names are lossy with respect to the config: a flat scoreboard
loses its name → `<dut>_scoreboard.svh`, `<agent>_cov.svh` is emitted unconditionally,
the packaged/subsystem layouts multiply the cases). So the common foundation is a
**generation manifest emitted by QuickUVM**, a single source of truth. It unblocks
both the decoration (line 1) and the incremental trigger (line 2). Line 3 (GUI
parity) is independent and can proceed in parallel.

The global order: **Track A (the QuickUVM manifest) → Line 1 → Line 2**; **Line 3**
in parallel, starting with the negative-parity repairs (bugs).

---

## UX principle — "simple by default, powerful when needed"

The same philosophy as the generator's ([[quickuvm-design-philosophy]]), applied to
the inspector. Encoded PURELY and tested in `src/inspector.ts` (`npm run test:inspector`),
so that the rules do not live scattered through inline conditions in the DOM.

Three rules, deliberately distinct:

1. **SCOPE.** The inspector shows the properties of WHAT IS SELECTED, nothing else.
   The bench-level sections (RAL, regression, clocks, resets, tests, identity)
   appear only in *bench scope* — no component selected, exactly what selecting the
   root node of the verification tree produces (`selectId` null). Before, they were
   rendered under ANY selection: ~55 irrelevant rows under every click.
2. **RELEVANCE ⇒ hide.** A field whose switch sits right next to it is hidden until
   it becomes useful (`mode: responder` reveals the responder rows). Nothing is lost:
   the switch IS the point of discovery. Every hidden row corresponds to a QuickUVM
   validator wall — it would have refused it anyway.
3. **RARITY ⇒ "Advanced".** A field that is always valid but rarely touched sits under
   a disclosure, never disabled and never removed — there is no other control that
   would bring it to light. The open/closed state is remembered (`vscode.setState`).

Corollary: **a disabled control is permanent noise.** It is used only when the block
comes from ANOTHER section (e.g. "In use by spi" on a clock domain), where the user
cannot deduce from here how to unblock it.

Effect measured on a realistic bench (RAL + regression + 2 clock domains + 1 reset +
2 tests, an agent with 4 ports selected): **~100 controls → under 30**.

---

## The inference gap — the config understates the artifact

*(Analysis, Aug 2026, prompted by a real walkthrough run. Open against QuickUVM as
[#115](https://github.com/arcadie-cracan/QuickUVM/issues/115) and
[#116](https://github.com/arcadie-cracan/QuickUVM/issues/116); no Architect work is
scheduled until #116 lands.)*

### The observation

The verification view renders the config **as written**; quick-uvm generates it **as
interpreted**. Defaults live in the generator, so the diagram is a view of the literal
YAML text, not of its meaning. `analysis:` absent does not mean "no analysis" — it means
"default analysis", and today the diagram draws that as nothing.

A user adding a scoreboard through the GUI therefore loses the implicit coverage
collector with no signal anywhere: not in the diagram, not in the YAML they can see, not
at generate time, not at run time.

**The extension already contradicts itself about this.** `classify` reports
`missing: ['agent:pkt', 'sb:sbd']` for a config that declares no scoreboard at all — the
generation-state layer tracks a component the tree and diagram refuse to draw.

### What is actually inferred (measured, not guessed)

Three distinct kinds, only the third of which is the problem:

1. **Defaulted values** — absent key ⇒ documented value, no topology change: `match:
   in_order`, `active: true`, `randomize: true`, `reset_active_low`, `emit_when` absent =
   every cycle, `layout: flat`, `kind: bench`. Unremarkable.
2. **Presence-switched blocks** — the presence of a key changes MODE: `analysis:`,
   `regress:`, `register_model:`, and `clock:`/`reset:` where a 1-element LIST is not a
   mapping. (`probes:` is the counterexample: absence is byte-identical.)
3. **Inferred topology** — components in the artifact that appear nowhere in the config:
   the `sbd` scoreboard and `<primary>_cov` coverage on `agents[0]`, `<dut>_vseq` + vsqr
   at >= 2 stimulus agents, the default `test1`, and `<agent>_seq` per agent. **Five.**

### Why "remove the defaults" is the wrong conclusion

QuickUVM has already had this argument and resolved it, in
`ProjectConfig.unchecked_stimulus_agents`: refusing to infer "would tax the simple case",
so the convenience is kept and the gap it opens is made **loud at runtime**, at a severity
proportionate to the harm — `UNFILLED_PREDICTOR` (fatal), `UNFILLED_WINDOW` (fatal),
`UNCHECKED_AGENT` (warning), `SB_LEFTOVER`, `SB_CMP` "compared 0 transactions".

So "simple by default" was never reconciled with transparency by making the CONFIG
complete. It was reconciled by making the RUN honest. That policy is sound and should not
be reopened.

Its hole is narrow: it covers every way inference can make a bench pass FALSELY, and
nothing that makes a bench silently WEAKER. Losing coverage is exactly the latter — hence
QuickUVM#115, an `UNCOVERED_AGENT` warning by analogy with `UNCHECKED_AGENT`.

### Why this surfaced in the GUI and not in four years of YAML

A text config may defer meaning to a generator; the reader knows they wrote a partial
spec. **A diagram claiming to be the testbench cannot.** The Architect promises "this is
your bench", and a promise that omits five component kinds is a different promise from
"this is your YAML, drawn".

### Options considered

- **A — draw the inferred components (ghosted).** Correct in principle; blocked in
  practice, because the rules would have to be reimplemented in TypeScript. That is the
  exact drift `quick-uvm manifest` was created to stop (hard-coded element→filename
  mappings drifted). And the manifest cannot rescue it: it is **byte-identical** for a
  config with and without `analysis:` — it models file ownership, not topology.
- **B — show components only after generation.** Rejected. It inverts design→generate,
  makes deletions linger until a regenerate, and duplicates a channel that already exists:
  the U/M/● badges ARE "declared vs on disk". Mechanically it would also mean recovering
  topology by parsing generated SystemVerilog.
- **C — make the GUI always declare** (write the full `analysis:` inference produces).
  Attractive — text, meaning and diagram agree, no ghosts — but it writes YAML the user
  did not ask for and takes implicit mode away from GUI users.

### Decision

**A, once QuickUVM#116 gives us the primitive**: `quick-uvm resolve -c` emitting the
effective config with provenance. The diagram then renders the RESOLVED topology, marks
inferred nodes distinctly, and the extension never mirrors a generator rule.

Two sharp edges to design for when it lands, both consequences of the mode switch:

- editing an inferred component must materialise **the whole inferred set**, or clicking
  the ghost scoreboard silently deletes the ghost coverage beside it;
- deleting an inferred component means WRITING a block (`analysis: {scoreboards: []}`) in
  order to express absence — the mirror of the existing `keepAnalysis` guard, which stops
  a deletion from resurrecting what it deleted.

**Interim, independent of #116:** when the extension writes the FIRST `analysis:` entry it
should also emit the entries inference would have provided, so a GUI gesture never
silently removes a component the user already had. Small, and justified without any
visualisation work.

### Status — shipped (Aug 2026)

QuickUVM#118 landed `resolve`, and option A is implemented **read-only**:

- `src/resolved.ts` (pure, `npm run test:resolved`) reads the provenance and returns the
  inferred components as diagram-node ids. It never re-derives what gets inferred — that
  rule stays in the generator, which is the whole point of having asked for the command.
- `ResolveService` (`src/resolve-service.ts`) runs `quick-uvm resolve` and caches **per
  config uri** — one slot would be wrong, because the custom editor can hold a config that
  is not the active one, and answering it from a shared cache pairs one bench's ghosts
  with another's diagram.
- The result travels on `config/full` (docs/05), never on a message of its own, so ghosts
  and config can never interleave. It is never awaited on the render path: the message
  carries the cache, and a completed resolve re-posts.
- `buildTbScene` draws them dashed + dimmed with an "inferred — not in the config" note,
  and the inspector replaces the property editor with an explanation of the mode switch.

**Deliberately still read-only.** Both sharp edges above are mutations, and neither is
implemented: `tbDeleteTarget` returns `null` for a ghost, which disables the inspector
button, the Delete key and the context menu in one place (they all resolve through it).
A ghost is therefore visible and explained, but not editable — the honest state until
materialisation is designed, and strictly better than the previous behaviour, where the
components were invisible.

One guard is worth remembering: `resolve` reads the file on **disk**, so between an edit
and its save the cache describes the previous text. The scene therefore drops every ghost
as soon as the LIVE config has an `analysis:` key. Without it, hand-typing `analysis:`
rendered a declared scoreboard AND the inferred ghosts at once — a bench quick-uvm cannot
produce. The guard only ever hides ghosts, never invents them.

---

### The vocabulary of the generation states

Three states, coloured and badged with VS Code's OWN vocabulary, so that there is
nothing to learn:

| state | badge | colour (token) | what it means |
|---|---|---|---|
| unsaved | `●` | green `gitDecoration.untrackedResourceForeground` | declared in the editor, not yet in the file — a crash loses it |
| ungenerated | `U` | amber `list.warningForeground` | on disk, but with no code behind it (git: *untracked*) |
| stale | `M` | blue `charts.blue` | code exists, the configuration has moved on (git: *modified*) |

`●` is exactly the mark VS Code puts on an unsaved tab; `U`/`M` are the git letters
with their git meaning. Priority: unsaved > ungenerated > stale.

Colour does the heavy lifting at a glance, the badge is the safety net: in the High
Contrast themes VS Code flattens the decoration colours, and colour alone is
unreadable for users with colour blindness — so **no channel is allowed to be the
only carrier**. That is why the glyph was not given up.

The amber (`list.warningForeground`) and the gold (`gitDecoration.modified…`) are one
step of hue apart, so they are not used on two neighbouring states; the blue
separates the third state cleanly.

The declarations are compared at the level of the **owner**, not of the node: several
`vseq:*` collapse onto the single `vsqr` node, so the question "does the node exist?"
would miss a SECOND vseq added to a bench that already has one.

### Where a control lives (UX slice 2)

The inspector is rendered by TWO surfaces, from the same module
(`src/webview/inspector-view.ts`), told apart by a single `canvas` flag:

| surface | `canvas` | what it shows |
|---|---|---|
| the "Properties" side bar (under the trees) | `false` | everything that **edits the CONFIGURATION**: agent/scoreboard/coverage/subenv properties, ports, the bench settings, the add palette, Generate |
| the diagram's aside | `true` | everything that **acts on the DRAWING**: flip, fold, net render, cone, pin selection, the schematic reading of the current view |

The criterion is *what the control acts on*, not where it looks better. Neither
renders the other's controls, so nothing is duplicated and no button is shown that
could do nothing from there. The aside HIDES when it is left empty (a TB view with no
selection), and exactly those 250px go back to the canvas.

The side bar is a SEPARATE bundle (`dist/properties.js`, **33 KB** against the
diagram's 3.6 MB): it is always open, so it must not drag ELK along with it. That was
the reason for extracting the inspector before the move.

---

## Track A — the QuickUVM generation manifest (the common foundation)

**Repo: QuickUVM.** A single slice, through the QuickUVM PR flow. Three small,
backward-compatible additions (verified in `quick_uvm/cli.py` + `quick_uvm/generator.py`):

1. **`FileSpec` gets an `owner`** — the kind + the name of the element (`agent:host`,
   `scoreboard:sbd`, `test:test1`, `env`, `top`, `aggregate`). The `specs.append`
   sites already know the element (they are in the `for agent…`/`for test…`/
   per-scoreboard loops, `generator.py:502-568, 357-455, 390-392`), so it is a field
   assignment, with no new logic. Today the element→files association exists only as
   **imperative code**, and is lost once the list is built.
2. **A `manifest` command (or `list --json`)** that emits, per element: the identity,
   the exact files it owns, AND **the global set of aggregate files**
   (`tb_pkg.sv`+`pkg.f` for flat; `*_env_pkg.*`+`*_test_pkg.*`+`run.f` for packaged;
   the subenv variants for a composition). Derived directly from `files_to_generate()`,
   so always correct for flat/packaged/subenv/VIP/selftest without the Architect
   guessing. It reuses the existence check that `list` already does
   (`cli.py:245-248`), so that the manifest also carries "exists on disk" per file —
   exactly what feeds **line 1**.
3. **`--only` becomes repeatable** (`multiple=True`; `only` becomes a set; the filter
   `spec.output not in only`). Today `--only` takes ONE single file name
   (`cli.py:77-82`, `generator.py:922-923`), so regenerating an agent (~10-12
   files) requires one invocation per file. ~3 lines, backward-compatible. Plus a
   **warning when an `--only` matches no spec** (a renamed element + the old name = a
   silent no-op today).

**Why a manifest + `--only`, not a vocabulary of elements in the CLI** (`--only-agent NAME`):
the file names encode QuickUVM's conventions (`{name}_cfg.svh`, `default_seq_name`,
scoreboard prefixes, per-parameter C3 specializations). The naming authority MUST
stay in QuickUVM. With the manifest, the Architect reads the names and sends them back
through `--only` — a single source of truth, smaller than re-encoding the mapping in
the CLI.

**Existing precedent**: `add-test` (`cli.py:280-306`) is already per-element
regeneration — it calls `generate_all(only=f"{name}.svh")` AND
`generate_all(only=f"{dut}_tb_pkg.sv")`, that is, "the element's file + the
aggregate". This rule generalizes (see Risks).

**Verified invariants**: per-file rendering is completely independent (the context
comes from the whole config through `_flat_base_ctx`, `generator.py:147-221`), so any
file can be regenerated in isolation. Pragma preservation is identical under `--only`
(`_write` → `merge(...)` fail-closed + `.bak.N` backups, `generator.py:884, 897-900`).

**Verification (mutation-proof)**: the scoped regeneration of an agent leaves the
other agents' files byte-identical; omitting the aggregates leaves `tb_pkg.sv` stale
(it documents the co-regeneration rule); a unit test on the shape of the manifest
against the committed examples (flat/packaged/subenv).

---

## Line 1 — decorating the ungenerated elements

**Repo: QuickUVM Architect.** A star/badge in the verification hierarchy (and in the
TB diagram) that marks the TB elements with no generated code behind them (they exist
in the config, but `quick-uvm generate` has not produced their file, or the config has
changed since the last generation).

**The architecture (verified)**: the ids in the verification tree
(`tbtree-build.ts`/`tbtree.ts`) = the ids in the TB diagram (`tbscene.ts`) minus
the `v:` prefix — so a single canonical space of element keys serves both
surfaces. The existing status-decoration system (`status.ts` `decosFromFindings`/
`statusIdsTb`, the SVG badge `applyStatusBadges` in `main.ts`) is the pattern to
follow, BUT "ungenerated" is a state derived from the filesystem, not a validation
finding — it is carried on a parallel channel, not overlaid on `StatusDeco`.

**Detection**: a new pure module `src/genstate.ts` (no `vscode`, tested in
`scripts/test-genstate.mjs`), with `computeGenState(config, present, opts?)` →
`generated | missing | stale` per element key. The source of truth = **the Track A
manifest** (`fromManifest`); a hard-coded name table stays as the fallback for a
pre-manifest QuickUVM. The filesystem I/O stays in the host
(`workspace.fs.readDirectory` on the output dir — `quickuvm.outputDir`, resolved as
in `generate.ts:76,111`; reading it for existence is orthogonal to excluding it from
the source globs).

**Surfaces**:
- **Tree**: `FileDecorationProvider` (idiomatic for a star/badge) — `tbtree.ts`
  sets `item.resourceUri` to a synthetic uri that encodes the element key;
  `provideFileDecoration` returns `{ badge: "★", tooltip, propagate: true }`
  (bubble-up to `env`/the root, consistent with the bubble-up in `status.ts`). A
  cheap fallback: `★` in `item.description`.
- **Diagram**: a pure `ungeneratedIdsTb(keys, presentIds)` in `status.ts` (symmetric
  with `statusIdsTb`) + a distinct star badge (`.gen-badge`) in `main.ts`, visually
  separate from the `✕`/`!` severity badges.

**Recomputation**: on a config change (`config.onOverlay`), at the end of a
generation (`generator.onStatus`), on changes in the output dir (a debounced
`FileSystemWatcher` on `<outDir>/**`, modelled on `sidecar.ts:187-217`), and when the
`quickuvm.outputDir` setting changes.

**Slices**:
- **1.1** — the pure detector `genstate.ts` + tests (the flat layout first; it catches
  the difficult cases: the dropped name of the flat scoreboard, the unconditional
  `<agent>_cov.svh`).
- **1.2** — the star in the tree (the host service `genwatch.ts` +
  `FileDecorationProvider` + `resourceUri` + `setUngenerated`). *The main deliverable.*
- **1.3** — the star badge in the diagram (the extended `status/decorations` payload +
  `ungeneratedIdsTb` + `applyGenBadges`).
- **1.4** (optional) — the `stale` state + the `fromManifest` bridge (here `stale`
  becomes reliable). **Shipped on a content hash, not on mtime**: quick-uvm does not
  rewrite files whose content has not changed (this keeps downstream builds quiet), so
  after a regeneration the mtimes stay old and the heuristic "file older than the
  config" would stay stuck on `stale` forever. The extension records in
  `workspaceState`, per element, the hash of the config it generated from; `stale` =
  recorded hash ≠ current hash. An element with no record (generated from the CLI,
  outside the extension) is not claimed `stale` — the badge never lies.

**Open decisions for the user**:
- Visual language: a star (FileDecoration) vs a dimmed row vs an icon overlay; in the
  diagram, a star glyph vs a dimmed outline.
- One state or two: "ungenerated" and "stale" collapsed into "needs generate", or
  distinct? (`stale` is unreliable WITHOUT the manifest — any touch of the YAML marks
  everything stale.)
- The DUT node: is it decorated? Its only file is the `<d>.sv` stub (a byproduct, not
  TB code) — probably excluded, or mapped onto `tb_top.sv`/`clkgen.sv`.
- Subenvs (`sub:<name>`): their code lives in the output dir of the CHILD config — a
  recursive check, or undecorated in v1?
- The coverage node: `<agent>_cov.svh` exists regardless of `analysis.coverage`, so
  the file's existence does not distinguish "coverage generated" — a coarse proxy
  until the manifest.
- Bubble-up: do `env`/the root show the star when any descendant is ungenerated?

---

## Line 2 — incremental per-element generation

**Repos: QuickUVM (capability) + QuickUVM Architect (UX).** Regenerating only the
files of one element (agent/scoreboard/test/subenv), plausibly triggered when the
user tries to descend into the code of an element not yet generated.

**The QuickUVM capability = Track A** (repeatable `--only` + the manifest). Nothing more.

**The central hazard (verified)**: the aggregate files are whole-config manifests
(`pkg.f.j2` iterates over every interface; `tb_pkg.sv.j2` includes every agent/
scoreboard/test). So:
- **A MODIFY of an existing element is SAFE** to regenerate alone (the aggregates
  refer to names, not content).
- **ADD / REMOVE / RENAME is NOT** — the aggregates (`tb_pkg.sv`+`pkg.f`, or the
  packaged/subenv variants) become stale until co-regenerated. Exactly the `add-test` rule.
Conclusion: the Architect **always adds the aggregate set** to any scoped generation
(they are a few cheap files — the generalized `add-test` rule is the safe default).

**Architect UX** (today "descending into the code" for TB elements is almost entirely
new: TB elements have no path to open their source — only RTL has `openLoc`; the
items of the TB tree have no `contextValue`, hence no context menu; BUT the element
identity exists: `VNode.focus`/`selectId`, the drill ids in `tbscene.ts`):
- **A "Generate this item" action** (context menu on the TB tree nodes) — a
  `contextValue` per VNode kind + a `view/item/context` entry gated on
  `view == quickuvm.verification` + the `quickuvm.generateItem` command.
- **The auto-offer on descent** — a distinct "Open Generated Code" action on the TB
  items. On invocation: resolve the element's files from the manifest; if any is
  missing/stale, the modal "Generate `<item>` now?" → scoped generation → `openLoc`
  into the produced file.

**Touch points**: `generate.ts` refactored with a scoped helper (arg-build +
`run()` + the ENOENT fallback + `publishDiagnostics` + the status chip, shared), plus
`generateItem(files)` which adds `--only <f>` per file + always the aggregate set;
`actions.ts` the new methods `generateItem`/`openGeneratedCode` (siblings of
`openSubenvConfig`, `actions.ts:1306`); `tbtree-build.ts`/`tbtree.ts` carry the kind +
`contextValue` (+ a `generated`/`stale` flag for line 1); `package.json` the two
commands + menus; a per-config manifest cache (invalidated when the YAML is saved).

**Slices**:
- **2.1** = Track A (QuickUVM: the manifest + repeatable `--only`).
- **2.2** — Architect: the "Generate this item" action (reads/caches the manifest,
  `contextValue`, `generate.ts` refactored into scoped-generate).
- **2.3** — Architect: the offer on descent ("Open Generated Code": missing/stale →
  modal → scoped generation → `openLoc`).
- **2.4** — convergence with line 1 (the same manifest decorates + triggers).

**Risks / open questions**:
- Stale filelists (the main risk) — ADD/REMOVE/RENAME always co-regenerate the
  aggregates; MODIFY does not. The manifest exposes the own-files AND the aggregate set.
- "Per element" vs "per file" — the UX unit is the element; the mechanism stays
  per-file through `--only`. The manifest reconciles them (and must enumerate the
  files actually EMITTED — the prefixes/specializations vary).
- Layout/composition variation — the manifest is computed from the real config; the
  Architect does not hard-code names. Open: for a composed element, per-element
  regeneration makes sense only from the TOP config (the subenv resolution happens
  there) — does the manifest express ownership across the composition tree, or does
  the Architect scope to the child config?
- Scoped regeneration reflects the pending edits (the context comes from the current
  YAML) — desirable (a single source of truth), but to be signalled in the UX: it is
  "regenerate this element from the current config", not "from a snapshot".

---

## Line 3 — GUI ↔ QuickUVM schema parity

**Repo: QuickUVM Architect.** The basic finding: the GUI authors roughly **the 0.9.2
schema** — exactly what `src/quickuvm.ts:1-6` acknowledges ("the QuickUVM config
subset that the extension touches"). Everything the 1.0 campaign added
(reactive/hybrid/replica agents, `inouts`, rich ports, rich `analysis`,
`register_model`, `regress`, `kind: vip|selftest`, `from_vip`, the multi-clock/reset
unions, `top_name`) is **unexposed**. The complete editing surface = the `ActionKind`
union with 17 members (`protocol.ts:38-62`) — there is no other write path.

### NEGATIVE parity — repaired first (the GUI is wrong, not merely silent)

- **Inout ports blocked**: `createAgentFromPins` skips inout with "inout not supported
  by the QuickUVM schema" (`actions.ts:218-223`) — stale, 1.0 supports `inouts`/
  `open_drain`/`pullup`. Unblocking + follow-on fields. High leverage (I2C/bidir).
- **Hybrid/boundary agents blocked**: `createSubenv` refuses a bench with agents +
  subenvs (`actions.ts:599-612`) — stale, A9 lifted the ban. The guard becomes an
  offer, not a refusal.
- **`QuvmProbe` is ahead of its mutation**: `enum/struct/real/clock` are modelled
  (`quickuvm.ts:77-89`) and drawn, but `addProbe` drops them (`yamlops.ts:623-628`).
  Half-wired, cheap to close.

### Gap groups (leverage × tractability)

- **Cheap — "one more yamlops mutation + one inspector control"** (the GUI's strong
  point): the agent `active` toggle (the mutation EXISTS, `yamlops.ts:264`, only the
  button is missing); scoreboard `window`/`reference_model.language`/`max_latency`-at-add;
  `register_model` (all the scalar/enum/bool fields → one form + one mutation);
  `regress` (4 scalars); `kind`/`top_name`/`auto_vseq_mode`/`layout`/`project`
  metadata; `tests[]` editing; `clock` period/unit/source + `reset` active_low/
  external as a standalone inspector; `subenvs.namespace`.
- **Medium — a nested/list editor, still pure config**: rich `coverage` entries
  (coverpoints/bins/crosses); rich port types (`enum`/`struct`/`packed_dims`/
  `type`/`constraint`); agent `parameters`+`instances`; authoring cross-block
  scoreboards with `<subenv>.<agent>` endpoints (the drawing EXISTS, `tbscene.ts:795`;
  an endpoint selector is needed).
- **Expensive — new geometry/interaction or cross-file**: multi-clock/
  multi-reset lists (a mode switch + per-agent domain assignment + per-domain
  visualization); boundary agents drawn at the top of the composition + wired as
  connection/xsb endpoints; `kind: vip` + `from_vip` consumption (a cross-file VIP flow).

### Phased roadmap P1–P5

- **P1 — the depth of agent authoring** (inspector; mostly config, little geometry).
  Today an agent is CREATED but never EDITED. An agent property inspector (the scene
  already draws/selects `tbagent`, `tbscene.ts:424`), mirroring
  `tbScoreboardEditor`. `setAgentField` over `mode`, `respond`, `request_valid`,
  `request_ready`, `reorder_by`, `reorder_policy`, `proactive`, `replicas`,
  `seq_item_style`, per-agent `clock`/`reset`; wiring the existing `setAgentActive` to
  an Active/Passive toggle. It closes the whole reactive/hybrid/replica gap.
  **DELIVERED.** `tbAgentEditor` (webview) + the `editAgent` action + the pure op
  `setAgentField`, with all the fields above. Two things came out of building it:
  (a) the schema reference documented `request_ready` as being on the *initiator* —
  wrong, the validator accepts it ONLY on the responder (`examples/axi_handshake`
  confirms it); the responder rows of §1.5 are corrected. (b) The coupling rules are
  *validator walls*, not conventions, so disabling the controls is not enough:
  `setAgentField` **cascades the deletions** (back to `initiator` ⇒ all the
  responder-only keys fall; `respond` out of `pipelined` ⇒ `reorder_*` fall). Proven
  by mutation in e2e — the same configuration with the key left behind is REFUSED by
  quick-uvm.
  Left out of the slice: `idle` (a port→value dict, needs a nested editor) and
  `instances`/`parameters` (C3).
- **P2a DELIVERED — RAL + regression.** The "Verification settings" panel (inspector,
  in TB mode, independent of the selection) authors the two *presence-switched*
  blocks: `register_model:` (add with the three mandatory fields asked for up front —
  `bus_agent` only among the INITIATOR agents — then
  map/adapter/backdoor_root/`csr_tests` multiselect/
  `coverage`/`use_predictor`/`reg_test`/`reg_test_door`, plus remove) and `regress:`
  (simulator/filelist/seeds/coverage, add/remove). The rule discovered while building:
  **deleting `regress:` must take `tests[].seeds` with it** — QuickUVM refuses
  seeds without a regression block, so `removeRegress` cascades (proven by mutation in
  e2e: the same configuration with the seeds left behind = REFUSAL). The mandatory
  fields of the RAL refuse being emptied instead of corrupting the block.
- **P2b DELIVERED — tests + the bench identity.** A `tests[]` editor (add/delete,
  `num_items`, `vseq`, `seeds` inert until `regress:` exists) and the "Bench" section
  (`layout`, `kind`, `top_name`, `auto_virtual_sequences`/`auto_vseq_mode`, `project`
  metadata). Two things that came out of building it: (a) the reference documented
  `tests` wrongly — **absence ≠ the empty list**: absent ⇒ the default `test1`
  (runnable), whereas `tests: []` is ACCEPTED and gives ZERO tests (only
  `<dut>_base_test.svh`, a bench with nothing to run); that is why deleting the last
  test removes the KEY, it does not write `[]`. (b) `layout` and `kind` have hard
  preconditions (subenvs⇒packaged, C3 `instances`⇒flat, vip throws away the whole
  bench layer), so the blocked options are DISABLED with the reason shown —
  `benchid.ts` (pure, tested) computes them, and the e2e checks in BOTH directions
  that the guard's verdict coincides with what quick-uvm actually refuses/accepts.
  Left: `tests[].sequence` (agent+name+count) and `project.imports`.
- **P2 — bench-level config forms** (pure config, form only). A "Verification
  settings" panel: `register_model` (RAL — `bus_agent` from the initiator agents,
  `csr_tests` multiselect, `coverage` bool), `regress`, `kind`/
  `top_name`/`auto_vseq_mode`/`layout`, `project` metadata, a `tests[]` editor (with
  the guards "seeds require regress" and "deleting the last test resurrects test1").
  High leverage (RAL + regression are central to real benches).
- **P3a DELIVERED — scoreboard depth.** The scoreboard editor gains `window` (the
  boundary among the SAMPLED ports of the source agent + `length`) and
  `reference_model.language` (sv / c — only the switch, not the body). Both are
  nested mappings, so `setScoreboardField` takes dotted fields
  (`window.boundary`, `reference_model.language`), and a default value deletes the
  MAPPING, not just the key. The coupling discovered: **a window requires a scoreboard
  with a single stream** — adding a `monitor` deletes it in cascade, and adding a
  window over two streams is refused at the source (proven by mutation: the same
  configuration with the window left behind = REFUSAL).
  Left for P3b: authoring rich `coverage` (a nested coverpoints/bins/
  crosses editor) and the cross-block scoreboards (the `<subenv>.<agent>` selector
  requires the host to read the children's configurations — feasible, see
  `actions.ts` at `openTextDocument(childUri)`).
- **P3b DELIVERED — authoring rich `coverage`.** A selected coverage node opens the
  nested editor: the upgrade `coverage: [cmd]` (plain routing) → rich model, then
  coverpoints (fields from the agent's ports, one per field), bins with a one-line
  mini-syntax (`5` / `0..7` / `1, 2, 3` → value/range/values), crosses over DECLARED
  coverpoints, `goal`, and the downgrade back to routing. Found while building:
  **seven places read `analysis.coverage` as a list of strings** — the diagram node
  would have ended up as `[object Object]` as soon as the feature creates the first
  rich entry; all of them now go through `coveredAgent`. The cascade: deleting a
  coverpoint takes with it the crosses that referred to it (proven by mutation). The
  edits modify the entry IN PLACE, so hand-written `illegal_bins`/`transitions`/cross
  bins are not lost (a dedicated test).
  Left for P3c: cross-block scoreboards (the `<subenv>.<agent>` selector requires
  reading the child configurations) and the deep tail (`at_least`, `auto_bin_max`,
  `illegal_bins`/`ignore_bins`/`transitions`, the `binsof` selection of the crosses).
- **P3c DELIVERED — cross-block scoreboards. P3 COMPLETE.** The endpoint selectors
  (source/monitor, at add and in the inspector) now offer, on a COMPOSITION, the
  agents of the child blocks as well, qualified `<subenv>.<agent>` — exactly what
  makes a scoreboard cross-block. As the children live in OTHER files, `ConfigService`
  reads every `subenvs[].config` at refresh and publishes `childAgents` to the webview;
  a missing or unparsable child contributes nothing (a composition is edited
  incrementally, so it is a normal intermediate state, not an error). A hand-written
  endpoint we do not know stays selectable, otherwise opening the inspector would
  silently rewrite it to the first option. The rule caught by the e2e: **composed
  blocks share ONE namespace**, so agent names must be unique ACROSS children.
  Left (the deep tail, hand-edit): `at_least`, `auto_bin_max`,
  `illegal_bins`/`ignore_bins`, `transitions`, the `binsof` selection of the crosses.
- **P3 — analysis depth** (cheap fields + a nested editor). Extends the scoreboard
  editor with `window`, `reference_model.language` (an sv/c dropdown — ONLY the
  button, not the body), `max_latency`-at-add; authoring rich `coverage`; authoring
  cross-block scoreboards (a `<subenv>.<agent>` endpoint selector).
- **P4a DELIVERED — clock domains (M1).** The "Clocks" section authors the `clock:`
  union mapping ↔ LIST of domains: adding the first domain converts the mapping into
  a list (carrying its fields into the first domain, named after the current clock),
  per-domain editing (period/unit/source/name), deletion, and collapsing back to a
  single clock from a one-element list. This makes the per-agent domain selector
  delivered in P1 usable — until now nothing created the lists it chose from.
  The cascade: a domain **used by an agent cannot be deleted** (QuickUVM refuses an
  agent `clock:` pointing to an undeclared domain) — proven by mutation. Verified that
  `source: dut` really produces an OBSERVED clock in `tb_top` (not in `clkgen`, where
  it has no business: the TB does not generate it).
  Left for P4b: RESET domains (the additional invariant `dut.reset` = the name of a
  declared domain under a list), `open_drain`/`pullup` on inouts, rich port types
  (enum/struct/packed_dims).
- **P4b DELIVERED — reset domains.** Symmetric with the clocks, plus two invariants
  the clocks do not have: under a LIST `dut.reset` names a declared DOMAIN (not a
  port), and a domain's `clock:` gate must name a declared clock domain. Three
  things that came out of building it: (a) `external` exists ONLY on the single
  mapping — list entries reject the key. **Corrected Nov 2026 (D25)**: the
  conversion of an external reset used to be REFUSED, on the reading that
  `external` meant "the TB does not drive the reset". It means the opposite (the
  testbench TOP drives it — docs/03, "Who drives the reset"), and a list is
  always top-driven, so the conversion now simply drops the key; what is refused
  instead is converting an AGENT-driven reset (quick-uvm rejects the agent port
  that collides with the domain net), and collapsing a list restores
  `external: true`; (b) renaming a domain **cascades** over `dut.reset` and over
  the agents gated by it (proven by mutation: without the cascade, quick-uvm
  refuses); (c) an all-default reset writes no `reset:` block at all, so the
  first deviation has to CREATE it — otherwise the polarity/externality rows
  would have thrown on a fresh bench (since D25 a bench with a reset port always
  has the block: `external: true`).
  A pitfall the tests caught: the default is PER FIELD (`active_low` defaults to
  true, `external` to false) — a single "falsy ⇒ default" test deleted exactly
  `active_low: false`, the deviation the user asked for.
  Left for P4c: `open_drain`/`pullup` on inouts and the rich port types
  (enum/struct/packed_dims).
- **P4c DELIVERED — port depth. P4 COMPLETE.** The agent inspector gains a "Ports"
  block per port: `width` (routed through `setAgentPortWidth`, the same path as the
  pin gesture in the diagram), `randomize`, `constraint`, a symbolic `enum`
  (mini-syntax `NAME=value, …`) and, on INOUTS, the open-drain pair. The couplings are
  enforced at the source, not at generation: (a) `open_drain: true` **also turns on
  `pullup: true`** and does not let it be removed — an open-drain line never drives 1,
  so without a pullup it floats at X from the moment everyone releases ("not a style
  preference", says the validator itself); (b) open-drain only on 1 bit; (c)
  `enum`/`type`/`packed_dims`/`struct` are EXCLUSIVE — setting one removes the other
  authored one, and over hand-written `packed_dims`/`struct` the edit is REFUSED
  instead of them being silently lost.
  The e2e reads the generated code: `1'bz` in the interface and the symbolic names in
  the seq_item.
- **P4 — port & clock depth** (medium-expensive; touches the pin gesture +
  geometry). Unblocking inouts (`actions.ts:218`) with `open_drain`/`pullup`; rich
  port types; a clock/reset inspector independent of setDut; authoring
  multi-clock/multi-reset lists with per-agent domain assignment (respecting the
  list-vs-mapping distinction).
- **P5 DELIVERED — composition & VIP. LINE 3 COMPLETE.** (a) *Consuming a VIP by
  reference*: "VIP agent (by reference)…" in the add palette opens a `.qvip` picker,
  reads the agents the manifest ships and writes `{name, from_vip}` with the path
  RELATIVE to the consuming configuration. The rule discovered by running it:
  **`from_vip` requires `layout: packaged`** (the VIP IS an external package) — the op
  sets it, like `createSubenvs`, and `layoutBlockers` blocks the return to flat.
  (b) *`subenvs.namespace`*: a selector on the subenv node, with AUTO explained in the
  label (it prefixes only when the same `config` is composed ≥2 times — a block used
  once stays byte-identical). (c) The hybrid guard had already been lifted by an
  earlier slice. Verified on generated code: the source of the referenced agent is NOT
  regenerated.
  **Finding for QuickUVM**: the header `templates/vip_manifest.qvip.j2:3` documents
  the OLD syntax (`agent_refs: {name, manifest}`), renamed in 1.0 to
  `agents: {name, from_vip}` — the generated manifests carry wrong instructions.
- **P5 — composition & VIP parity** (expensive; new geometry + cross-file). The stale
  hybrid guard (`actions.ts:599-612`) becomes a supported flow (boundary agents at the
  top, connection/xsb endpoints); authoring `kind: vip` (emits the `.qvip` manifest) +
  `from_vip` consumption (resolves the manifest, chains `-F`); `subenvs.namespace`.
  The lowest per-user frequency, the highest cost — last.

### Anti-scope (deliberate NON-parity — these stay hand-edit)

Consistent with the philosophy "the GUI edits *config*; the predict/reference-model
bodies are *code* written by a human":
- **Free SystemVerilog bodies**: `constraints: list[str]`, per-port/scoreboard
  `constraint` expressions, `emit_when`, and **the C/SV `predict()` body** of
  `reference_model`. The *language* button is exposed (P3), never the body.
- **Directed/nested sequence bodies**: `sequences[].steps[]` with `directed`/
  `nested` + a per-step `field` slide towards procedural code. At most `{name, kind:
  random|incrementing, count}`.
- **Cross-bin `select` clauses**, `idle` dictionaries, custom `frontdoor` class
  names, a free probe `path` beyond the XMR derived from the model — niche, low-
  leverage, cleaner hand-edited (`createProbe` already derives the correct XMR; a free
  path editor invites the silent-truncation pitfall).

Because `yamlops.ts` edits the `yaml` Document surgically (comments/unknown keys
preserved, `yamlops.ts:1-5`), all the anti-scope items remain **hand-editable
alongside** the GUI edits, with no loss — exactly why they do not have to be authored
from the GUI.

---

## Sequencing & dependencies

```
Track A (QuickUVM: manifest + repeatable --only)  ─┬─► Line 1 (decoration)
                                                    └─► Line 2 (incremental)

Line 3 (parity) — independent, in parallel:
   negative parity (inouts, hybrid, probe fields)    ← cheap, any time
   P1 → P2 → P3 → P4 → P5                             ← ordered, config-first
```

Track A is the only QuickUVM work; the rest is Architect. Negative parity (3
repairs of stale guards) has the best value/effort ratio and depends on nothing.
Starting recommendation: **Track A** (unblocks two directions with one PR) in parallel
with **negative parity** (three bugs to unblock), then lines 1/2 on the manifest and
P1→P2 on parity.
