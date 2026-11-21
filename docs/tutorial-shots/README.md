# Tutorial captures

Captures of the QuickUVM Architect webview for the two tutorials:

- the **YAPP router** walkthrough, [`../yapp-router-walkthrough.html`](../yapp-router-walkthrough.html)
  — the eight files of this folder;
- the **`yapp_buffer`** closure tutorial, [`../tutorial-yapp-buffer.md`](../tutorial-yapp-buffer.md)
  — the files under [`yapp-buffer/`](yapp-buffer/).

They are **real renders of the shipped webview bundle** (`dist/webview.js`, through
`scripts/harness.html`), photographed by a headless Chrome / Edge at 2x — header,
canvas, minimap and the Properties panel as they are. Nothing is mocked up:

- the project model is a real `backend/svmodel.py` run on the fixture's RTL;
- the configuration is the YAML the real mutations write, gesture by gesture, as
  the tutorial's steps do;
- the overlay, the proposal strip and the results come from the same pure modules
  the extension uses; the inferred components from a real `quick-uvm resolve`;
  the simulation results (`yapp-buffer/07-results.png`) from the logs of a real
  Xcelium regression of that bench (`scripts/fixtures/results/`).

What they are NOT: captures of a VS Code window. There is no activity bar, no
tree view and no QuickPick in them; the panel captures use the side bar's own
styling.

## Regenerating

```
npm run build
npm run shots                 # every figure
npm run shots -- --only env   # the ones whose name contains "env"
npm run shots -- --arrange    # serve the views for arranging by hand, then open http://localhost:8140/
```

The router's figures need its RTL, which lives in the QuickUVM repository
(`../QuickUVM`, or `QUICKUVM_REPO`); without it they are skipped.

[`layouts.json`](layouts.json) holds the **hand arrangement** of the views that
have one — the positions and flips saved by `--arrange`, in the layout sidecar's
own format, one sidecar per bench. A view without an entry is captured with the
automatic layout. Edit it by arranging, not by hand.

## The router walkthrough

| File | View (walkthrough step) |
|------|-------------------------|
| `5-rtl-symbol.png`          | RTL — the `yapp_router` symbol, i.e. the "top module" node (Step 2) |
| `8-rtl-leaf-ports.png`      | RTL — the same module from INSIDE: ports as boundary flags, "ports only" (Step 2) |
| `6-rtl-symbol-selected.png` | RTL — the symbol with the 9 data ports selected (Step 3) |
| `7-properties-agent.png`    | Properties — agent selected: Declared / Common / All, per-port fields (Step 4) |
| `4-schematic-agent.png`     | Verification View — inside the agent: sequencer · driver · monitor (Step 4) |
| `1-properties-panel.png`    | Properties (bench scope) — Add-component palette + Generate (Step 5) |
| `2-schematic-top.png`       | Verification View — testbench top: DUT ↔ Env through `pkt_if` (Step 6) |
| `3-schematic-env.png`       | Verification View — inside the Env: agent · scoreboard · coverage (Step 6) |
| `contact-sheet.png`         | all eight, labelled, stacked |

## The `yapp_buffer` tutorial

| File | View (tutorial step) |
|------|----------------------|
| `yapp-buffer/01-set-as-dut.png`          | the symbol after "Set as DUT", with the proposal strip (step 1) |
| `yapp-buffer/02-select-cmd-pins.png`     | the four command pins selected: "Agent from selection (4)" (step 2) |
| `yapp-buffer/03-agents-mapped.png`       | both agents: every data pin in its agent's colour (step 3) |
| `yapp-buffer/04-testbench-root.png`      | the testbench root: DUT and Env (step 4) |
| `yapp-buffer/05-env.png`                 | inside the Env: agents, scoreboard, collector (steps 5–6) |
| `yapp-buffer/06-scoreboard-selected.png` | the scoreboard selected: its editor and its pills (step 5) |
| `yapp-buffer/07-results.png`             | a real regression's results on the blocks (step 10) |
