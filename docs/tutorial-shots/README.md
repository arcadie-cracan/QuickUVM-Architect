# Tutorial captures — YAPP router

Live captures of the QuickUVM Architect webview, driven by the YAPP-router
example config (a `pkt` agent + `sbd` scoreboard + `pkt_cov` coverage). They back
the "Build a UVM testbench for the YAPP router" walkthrough.

These are **real renders of the shipped webview bundles** (`dist/properties.js`,
`dist/webview.js`), not mockups — produced headlessly from the config plus the
host messages the extension normally sends, so no live VS Code GUI is needed.

| File | View |
|------|------|
| `1-properties-panel.png` | Properties sidebar (bench scope) — Add-component palette + Generate testbench |
| `2-schematic-top.png`    | Verification View — testbench top (DUT ↔ Env through `pkt_if`) |
| `3-schematic-env.png`    | Verification View — inside the Env (agent · scoreboard · coverage) |
| `4-schematic-agent.png`  | Verification View — inside the agent (sequencer · driver · monitor) |
| `contact-sheet.png`      | all four, labelled, stacked |

The two schematic-top / agent views are clean thanks to the endpoint-label
de-duplication (`dedupeEdgeLabels`, PR #28).
