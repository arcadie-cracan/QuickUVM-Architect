# Tutorial captures — YAPP router

Live captures of the QuickUVM Architect webview, driven by the YAPP-router
example (its `.quickuvm.yaml` config for the verification views, and a hand-built
project-model of the `yapp_router` module for the RTL views). They back the
[**Build a UVM testbench for the YAPP router**](../yapp-router-walkthrough.html) walkthrough.

These are **real renders of the shipped webview bundles** (`dist/properties.js`,
`dist/webview.js`), not mockups — produced headlessly from the model/config plus
the host messages the extension normally sends, so no live VS Code GUI is needed.

| File | View (tutorial step) |
|------|----------------------|
| `5-rtl-symbol.png`          | RTL Schematic — the `yapp_router` symbol / ports (Step 2) |
| `6-rtl-symbol-selected.png` | RTL Schematic — the symbol with the 9 data ports selected (Step 3) |
| `7-properties-agent.png`    | Properties — agent selected: Advanced (Emit when) + per-port MORE (Constraint, Enum) (Step 4) |
| `4-schematic-agent.png`     | Verification View — inside the agent: sequencer · driver · monitor (Step 4) |
| `1-properties-panel.png`    | Properties sidebar (bench scope) — Add-component palette + Generate (Step 5) |
| `2-schematic-top.png`       | Verification View — testbench top: DUT ↔ Env through `pkt_if` (Step 6) |
| `3-schematic-env.png`       | Verification View — inside the Env: agent · scoreboard · coverage (Step 6) |
| `contact-sheet.png`         | all six, labelled, stacked |

The verification-top and agent views are clean thanks to the endpoint-label
de-duplication (`dedupeEdgeLabels`, PR #28).
