# 01 — General architecture

## Purpose and differentiator

The extension offers two related things: (a) the visualization of a
SystemVerilog project as a navigable block diagram and (b) the definition, by
direct selection on the diagram, of the YAML configuration for QuickUVM.
Visualization on its own exists in other tools (TerosHDL with Yosys, the
hierarchy view in svlangserver); the diagram → verification configuration loop
exists nowhere and is the reason for the project. Every design decision is
judged by how well it serves this loop.

## Components and responsibilities

```
┌────────────────────────────────────────────────────────────────────┐
│ VSCode                                                             │
│  ┌──────────────────────┐  JSON messages   ┌────────────────────┐  │
│  │ extension host (TS)  │◄────────────────►│ webview            │  │
│  │ - hierarchy tree view│   (versioned     │ - SVG diagram      │  │
│  │ - commands, QuickPick│    protocol,     │ - elkjs layout     │  │
│  │ - diagnostics        │    doc. 05)      │ - selection, drag  │  │
│  │ - quick-uvm task     │                  │ - config inspector │  │
│  │ - YAML WorkspaceEdit │                  └────────────────────┘  │
│  └─────────┬────────────┘                                          │
│            │ stdio JSON                                            │
└────────────┼───────────────────────────────────────────────────────┘
             ▼
   ┌───────────────────────┐        ┌─────────────────────┐
   │ semantic backend      │  -f    │ bender              │
   │ svmodel (pyslang)     │◄───────│ file list,          │
   │ -> project model      │        │ defines, targets    │
   └───────────────────────┘        └─────────────────────┘
```

**Bender** supplies the ordered file list, the include directories and the
defines (`bender script flist-plus`; the plain `flist` format loses
`export_include_dirs`). The extension does not guess the project's composition;
for projects without Bender, the fallback is a configurable glob over the
workspace + a `.f` file written by the user.

**The semantic backend** (`backend/svmodel.py`, pyslang) compiles and
elaborates the design and emits the JSON project model. Full elaboration is the
requirement that decided the choice of slang over sv-parser: `[W-1:0]` widths
evaluated numerically, `generate` unrolled with the real parameter values,
interfaces with semantically resolved modports (the history of the comparison:
doc. 06, the decision journal). The backend is a separate process, started by
the extension when the project is opened and re-run when SV files are saved
(debounced); slang's compilation model is whole-design, but fast — it is not
optimized incrementally before a real problem has been measured.

**The extension host** (TypeScript) owns: the hierarchy tree view in the
sidebar (native), the commands ("Set as DUT", "Create Agent from Selection",
"Re-arrange", "Generate Testbench"), the QuickPicks, the diagnostics
(Problems), the `quick-uvm generate` task and all the YAML edits through
`WorkspaceEdit`. Rule: everything that can be native VSCode UI is native.

**The webview** owns only what cannot be native: the diagram (hand-generated
SVG over an elkjs layout) and the configuration inspector.
`retainContextWhenHidden` is on; `getState`/`setState` as a safety net at
restart; theming through the `--vscode-*` CSS variables.

## The main data flows

1. **Opening a project**: bender → `.f` → svmodel → JSON model → host → webview
   (full initial ELK layout) + tree view.
2. **An SV source change**: watcher → svmodel re-run → new model → diff on
   stable IDs → the webview updates incrementally (interactive ELK only for
   the new elements; doc. 04). On compilation errors: the old model stays
   displayed, the banner "View out of date (N errors)", the diagnostics go to
   Problems.
3. **QuickUVM configuration**: selection on the diagram → command →
   `WorkspaceEdit` on the YAML file → YAML parser in the host → updated overlay
   on the diagram (agent colours, coverage indicator). The YAML is the source
   of truth; doc. 03 defines the mapping, doc. 05 the UI flows.
4. **Generation**: button/command → the VSCode task `quick-uvm generate` →
   Pydantic errors parsed into Problems; later `quick-uvm status` → decorations
   on the generated files in the Explorer.

## Invariants (summary; details in CLAUDE.md)

- the JSON model = the stable contract; the backend is replaceable (the slang
  CLI `--ast-json`, a C++ tool on libslang, or another front-end) without
  touching the UI;
- the YAML = the source of truth; the UI has no configuration state of its own;
- node positions belong to the user; full auto-layout only on request;
- stable IDs = elaborated hierarchical paths;
- graceful invalidation for orphaned overrides and for code that does not
  compile.

## What is explicitly out of scope (MVP)

- schematic editing (the extension does not modify the RTL);
- post-synthesis netlists (if the requirement appears: Yosys/UHDM, a separate
  decision);
- VHDL / mixed-language support;
- a "pretty" automatic layout with continuous optimizations — it contradicts
  invariant 3.
