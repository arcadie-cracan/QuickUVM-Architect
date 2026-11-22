# QuickUVM Architect — a VSCode extension for visualizing SystemVerilog designs and graphically designing QuickUVM environments

A VSCode extension that displays interactive diagrams of a SystemVerilog design
(the symbol view and the schematic view) and lets you define, by selecting and
drawing directly on the diagram, the YAML configuration for
[QuickUVM](https://github.com/arcadie-cracan/QuickUVM), the generator of UVM
verification environments — up to the graphical editing of the testbench
architecture (the verification view, phase 3b).

The differentiator from the existing tools (TerosHDL, svls, verible-verilog-ls):
the **interactive diagram → verification configuration** loop, which exists in
no open-source tool; visualization is not the goal, but the specification
mechanism.

## The name

Name displayed in the Marketplace: **QuickUVM Architect — SystemVerilog schematic
viewer & UVM testbench designer**; extension identifier:
`quickuvm-architect`; the technical namespace (commands, settings, views):
`quickuvm.*`; the command prefix in the VSCode palette: `QuickUVM Architect:`.
The name puts the user in the role of the verification architect: they study
the RTL structure (the symbol and schematic views) and design the architecture
of the UVM environment (the verification view). A sub-brand of QuickUVM — the
generator and its graphical editor, findable together. History: the project was
called QuickXray until Jul 2026 (the X-ray metaphor covered only the
visualization half); the renaming and the rejected alternatives:
docs/06-plan-mvp.md, decisions D11 and D17.

## The architecture in brief

```
Bender (file list + defines)
   └─> semantic backend: pyslang/slang (full elaboration)
          └─> JSON project model  (schema/project-model.schema.json)
                 └─> TypeScript extension host (tree view, commands, diagnostics)
                        └─> webview: SVG diagram over an ELK layout
                               └─> selection -> QuickUVM YAML edit (source of truth)
                                      └─> quick-uvm generate (VSCode task)
```

The design decisions and their motivations are in `docs/` (start with
`docs/01-arhitectura.md`); the journal of the decisions already taken is in
`docs/06-plan-mvp.md`.

## Current state

**Phase 0 (backend validation) — closed**: `backend/svmodel.py` is a
working extractor that produces the complete project model — an elaborated
hierarchy with stable IDs, ports with numeric widths (unpacked arrays included),
per-instance parameters, interfaces with modports, connectivity with normalized
expressions and per-net fan-out. Validated on `examples/` (a design derived from
the QuickUVM examples `soc` and `channels`, extended with generate, parameters
and an interface with a modport) and covered by pytest tests (`backend/tests/`).

**Phase 1 (extension skeleton + read-only symbol view) — closed**:
a TypeScript extension with the backend started as a child process (debounce on
save, slang diagnostics in Problems, the last valid model kept on errors), a
hierarchy tree view with the effective parameters, a webview with the symbol
view (ELK layout, inputs left / outputs right / clock-reset bottom-left, widths
and multiplicities on the pin, hatched interfaces, pan/zoom, selection,
jump-to-source from a pin) and a file list from Bender with a `.f`/glob
fallback. The closure criterion was validated interactively on a real Bender
project (common_cells, `examples-bender/`): the hierarchy, the symbol view,
jump-to-source from a pin.

**Phase 2 (QuickUVM configuration — the core of the value) — closed**: a
configuration overlay derived from the YAML (colours + shapes on the agents'
pins, clock/reset roles, the N/M coverage indicator), the actions "Set as DUT"
(heuristics confirmed explicitly), "Create Agent from Selection" (with the
DUT→agent perspective inversion from docs/03), "Agent from interface"
(expanding the modport), "Ignore port" (persisted in
`x_quickuvm_architect.ignored_ports`) — all as surgical YAML edits through
`WorkspaceEdit` (the `yaml` library; comments and foreign fields are
preserved); model↔YAML validations as diagnostics (orphaned port, diverging
width with a quick-fix, a pin claimed by two agents); a side inspector in the
webview; the "Generate Testbench" command with the quick-uvm errors in
Problems. The DUT→agent→generated testbench flow is validated programmatically
against the real quick-uvm (`npm run test:e2e`) and ticked interactively in the
Extension Development Host.

## Quickstart

The backend alone (phase 0):

```bash
pip install pyslang            # slang 11 with the Python API
cd examples
python3 ../backend/svmodel.py adder.sv inverter.sv chan.sv soc_top.sv \
        --top demo_top -o model.json
```

`model.json` is exactly the structure the webview consumes; a generated copy
is included in `examples/model.json`.

The extension (phase 1):

```bash
npm install
npm run build                  # dist/extension.js + dist/webview.js
python -m pip install -r backend/requirements-dev.txt
python -m pytest backend/tests # 14 tests on the extractor
```

Then F5 in VSCode (the configuration "Run the extension (examples/: demo_top
regression design)"): an Extension Development Host opens on `examples/`, with
`quickuvm.top=demo_top` preset; the view "QuickUVM Architect → Design
Hierarchy" shows the tree, a click on an instance opens the symbol view, a
double-click on a pin jumps to the port's declaration.

For validation on a real Bender project there is the launch configuration
"Run the extension (Bender: common_cells)", which opens the clone in
`examples-bender/common_cells` (preset top `cdc_fifo_gray`; details and how to
recreate the clone: `examples-bender/README.md`).

## Repository structure

| Path | Contents |
|---|---|
| `backend/svmodel.py` | the model extractor (pyslang), a CLI compatible with `.f` lists from Bender |
| `backend/tests/` | the extractor's pytest tests (the CLAUDE.md criteria, snapshot, schema validation) |
| `src/` | the TypeScript extension: `extension.ts` (orchestration), `backend.ts` (child process + diagnostics), `filelist.ts` (Bender/.f/glob), `tree.ts` (the hierarchy), `panel.ts` (webview), `model.ts`/`protocol.ts` (the contract), `webview/main.ts` (the ELK+SVG diagram) |
| `media/` | webview styles (VSCode theme variables) and the icon |
| `schema/project-model.schema.json` | the JSON schema of the project model — the backend↔UI contract |
| `docs/01-arhitectura.md` | the general architecture and the responsibilities of the components |
| `docs/02-model-de-proiect.md` | the project model: semantics, stable IDs, edge cases |
| `docs/03-mapare-quickuvm.md` | the formal mapping model → QuickUVM YAML |
| `docs/04-layout-si-rutare.md` | the layout strategy (ELK + user-owned positions), the sidecar format, the hierarchy of routing overrides |
| `docs/05-ui-si-protocol.md` | the views, the configuration UI flows, the extension↔webview message protocol |
| `docs/06-plan-mvp.md` | the phased plan, risks, the decision journal |
| `docs/07-plan-post-mvp.md` | post-MVP plan: generation feedback loop, schema parity, the inference gap |
| `docs/08-ux-inspiration.md` | UX research synthesis: the tools we can learn from, the directness diagnosis, 25 prioritized recommendations |
| `examples/` | the test design + the generated `model.json` |
| `CLAUDE.md` | conventions and context for the working sessions with Claude Code |

## Requirements

- Python ≥ 3.10, `pyslang` ≥ 11 (phases 0–1)
- Node.js ≥ 20 + `@types/vscode` (phases 1+, the extension skeleton)
- optional: `bender` for file lists, `quick-uvm` for generation
