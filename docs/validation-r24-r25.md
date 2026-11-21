# Manual validation — R24 (templates, Signals) and R25 (simulation results)

The two rows of `docs/08-ux-inspiration.md` that shipped without a pass in a
real VS Code window. Everything below was checked piece by piece — the pure
modules by their suites, the drawing in the webview harness — but the parts
that only exist in VS Code were never walked: the **QuickPick flow** and the
**tree's drag-and-drop** (R24), the **file watcher, the commands and the
report** (R25).

**How to read it.** Every step says what to do and what to expect. The
expected texts were *computed* — the templates and the Signals tree by running
`src/templates.ts` / `src/signals.ts` on the real model of each example, the
results by running `src/results.ts` on the fixtures — not observed in VS Code.
A difference is a finding either way: tick the box or write down what you saw.

**Before you start**

- `npm run build`, then F5 with the launch configuration named in each part.
- No `*.quickuvm.yaml` is tracked (the pattern is git-ignored), so the example
  folders start without a configuration. If one is left from an earlier
  session, delete it first — part A depends on the files not existing.
- All shell commands are PowerShell, run from the repository root.

---

## Part A — "New Testbench…" (R24)

### A1. One agent per interface, and the composition — `examples/`

Launch **"Run the extension (examples/: demo_top regression design)"**.

- [ ] **A1.1 Where the command is.** *Design Hierarchy* shows a
  "New Testbench…" button in its title bar, and the same entry in the context
  menu of every instance node (next to "Set as DUT"). The *Signals* section
  is empty and its welcome text offers a "New Testbench…" link.
- [ ] **A1.2 A module no template fits.** Right-click **`demo_top`** → "New
  Testbench…". The QuickPick is titled "New testbench for demo_top" and lists
  three entries, all with the ⊘ icon and "not for this module":
  - One agent per interface — *the module has no port an agent could carry*
  - One agent per clock domain — *the module has no clock input*
  - Composition from the sub-blocks — *the module has one sub-block —
    quick-uvm composes two or more*

  Picking one shows an information message with that reason; no file appears.
- [ ] **A1.3 The offers on `u_soc`.** Right-click **`u_soc`** → "New
  Testbench…" ("New testbench for soc_top"):
  - One agent per interface — available: *DUT soc_top: clock clk, reset rst_n
    (active low) • agent "bus": 3 driven, 0 sampled*
  - One agent per clock domain — not available: *the module has one clock
    (clk) — one domain needs no template*
  - Composition from the sub-blocks — available: *5 subenvs: u_add, u_inv,
    g_ch_0_u_ch, g_ch_1_u_ch, g_ch_2_u_ch • …*
- [ ] **A1.4 Escape writes nothing.** Press Escape on the QuickPick: no file,
  no message.
- [ ] **A1.5 The composition, previewed.** Pick **Composition from the
  sub-blocks**. With `quickuvm.previewEdits` at its default (`ask`) a modal
  asks "Create soc_top.quickuvm.yaml (4 file(s)) from the template?" and its
  detail lists what is created and, under "Left out:":
  - three lines `g_ch_N_u_ch: W=16 — the block configuration uses the
    elaborated widths; no \`params:\` are passed`
  - `the design draws no connection between these blocks`

  The modal has **Create** and **Preview changes**. Choose **Preview
  changes**: four diff tabs open (`soc_top`, `adder`,
  `inverter`, `chan`), each against an empty left side, the top
  configuration's tab on top. A QuickPick over them asks again.
- [ ] **A1.6 Cancel after the preview.** Cancel that QuickPick (Escape): the
  four tabs close, no file was created.
- [ ] **A1.7 Create.** Repeat A1.5 and confirm with **Create**. Four files
  appear next to the sources. `soc_top.quickuvm.yaml` has `layout: packaged`,
  five `subenvs` (three of them pointing at `chan.quickuvm.yaml`), a `dut`
  with `reset: ""` and `combinational: true`, and **no** `agents`, `analysis`,
  `connections` or `params`. Each block file has one agent named `<module>_a`.
  The message says "soc_top.quickuvm.yaml created and made the active
  configuration — 4 note(s) in the Output panel", and the Output channel lists
  the four notes.
- [ ] **A1.8 It is the active bench.** *Verification Hierarchy* fills in; the
  verification view of `soc_top` draws five `sub:` boxes and no DUT.
  *Signals* shows `Clocks › clk — 10 ns` with no agent under it, and
  `Resets › no reset (dut.reset is empty)`.
- [ ] **A1.9 It generates.** "Generate testbench" finishes without an error
  (quick-uvm 1.2.0 exits 0 on these four files).
- [ ] **A1.10 A template never overwrites.** "New Testbench…" on `u_soc`
  again: an information message says `soc_top.quickuvm.yaml already exists — a
  template never overwrites a configuration`, with an **Open it** button that
  opens the file. The same for a channel instance (`g_ch[0].u_ch` →
  `chan.quickuvm.yaml already exists`).
- [ ] **A1.11 One agent per interface.** Delete the four `*.quickuvm.yaml`
  files (and `tb/`) — reload the window if the old bench still shows — then
  "New Testbench…" on `u_soc` → **One agent per interface**. One file changes,
  and the confirmation is asked all the same (creating a bench always asks). The confirmation lists `agent "bus": 3 driven, 0
  sampled` and, under "Left out:":
  - `without an agent (no name group): din, sum, inv`
  - `ref / unsized / unpacked ports are not guessed: ch_out — add them from
    the diagram`

  After **Create**: one file, an agent `bus` with `addr` (6), `wdata` (8) and
  `we`, a top-level `reset:` with `external: true`; it generates, and
  `tb/tb_top.sv` connects `.rst_n(bus_if_inst.rst_n)`; in the symbol view of `soc_top` the three
  bus pins take the agent's colour and `din`, `sum`, `inv`, `ch_out` stay
  unmapped — exactly the ports the note named.

### A2. One agent per clock domain — common_cells

Launch **"Run the extension (Bender: common_cells)"** (top `cdc_fifo_gray`).

- [ ] **A2.1 The offers.** "New Testbench…" on the top instance:
  - One agent per interface — available (*agent "src": 2 driven, 1 sampled •
    agent "dst": 1 driven, 2 sampled*). Pick it only to read its confirmation,
    then cancel: under "Left out:" it says *more clock / reset inputs than the
    bench declares: dst_rst_ni, dst_clk_i* — the reason the next template
    exists.
  - One agent per clock domain — available: *clock domains: src_clk_i,
    dst_clk_i • reset domains: src_rst_ni (src_clk_i), dst_rst_ni (dst_clk_i)
    • agent "src": 2 driven, 1 sampled, on src_clk_i • agent "dst": 1 driven,
    2 sampled, on dst_clk_i*
  - Composition — not available (one sub-block).
- [ ] **A2.2 Create the per-clock bench.** Pick **One agent per clock
  domain** and create it. The file has `clock:` and `reset:` as **lists** (two
  entries each, each reset with its `clock:`), and each agent has its own
  `clock:` and `reset:`. No "Left out:" section this time.
- [ ] **A2.3 It generates**, and `tb/tb_top.sv` connects both reset ports of
  the DUT: `.src_rst_ni(src_rst_ni)` and `.dst_rst_ni(dst_rst_ni)`.

---

## Part B — the Signals view (R24)

Continue in the common_cells window, with the bench of A2.2 active.

- [ ] **B1 The tree.** *Signals* shows:

  ```
  Clocks
    src_clk_i — 10 ns
      src
    dst_clk_i — 10 ns
      dst
    Unconnected — none — quick-uvm puts these on src_clk_i, the first domain
  Resets
    src_rst_ni — active low, released on src_clk_i — the DUT's reset port
      src
    dst_rst_ni — active low, released on dst_clk_i
      dst
    Unconnected — none — quick-uvm gives each the reset released on its clock, else src_rst_ni
  ```
- [ ] **B2 Drop on an agent.** Drag `dst` (under `dst_clk_i`) onto the agent
  **`src`** under `src_clk_i` — a drop on an agent means its domain. The YAML's
  `dst` agent now says `clock: src_clk_i` — one edit, one undo step — and the
  tree shows `src` and `dst` under `src_clk_i`, nothing under `dst_clk_i`. With
  the YAML visible, the changed line flashes. Nothing under *Resets* moves.
- [ ] **B3 Already there.** Drag `dst` onto `src_clk_i` itself: nothing is
  written and there is no message.
- [ ] **B4 Unconnected removes the key.** Drag `dst` onto **Clocks ›
  Unconnected**: the agent's `clock:` line is gone, and the tree lists `dst`
  there with `→ src_clk_i` (where quick-uvm will put it).
- [ ] **B5 The two reset rules.** With `dst` still without a `clock:`, drag
  it (from under `dst_rst_ni`) onto **Resets › Unconnected** too: its `reset:`
  line goes, and it is listed there with `→ src_rst_ni` (the reset released on
  the clock it falls on). Now drag `dst` from *Clocks › Unconnected* back onto
  `dst_clk_i`: only `clock: dst_clk_i` is written, and the *reset* folder's
  arrow changes to `→ dst_rst_ni` by itself — the reset follows the agent's
  clock.
- [ ] **B6 A wrong target says why.** Drag an agent from *Clocks* onto the
  **Clocks** or **Resets** group header: an information message says "drop an
  agent on a clock or reset domain"; nothing is written.
- [ ] **B7 Several at once.** Select both agents under *Clocks* (Ctrl+click)
  and drag them onto one domain: one edit moves both.
- [ ] **B8 Undo.** Ctrl+Z in the YAML editor undoes the last drop in one
  step; the tree follows.
- [ ] **B9 Add a domain.** The inline button on the **Clocks** header ("Add
  Clock Domain") opens an input box "New clock domain" (prefilled `sck`; an
  existing name is refused while you type) and adds a list entry; the tree
  shows it, empty. The same on **Resets**. Undo both.
- [ ] **B10 A single clock has nothing to assign.** In the `examples/` window
  with the per-interface bench of A1.11 (one clock, a reset mapping), drag
  `bus` onto `clk`: the message says "the bench has one clock: every agent is
  on it — add a clock domain first".
- [ ] **B11 The hazard is named.** In that same bench, use **Add Clock
  Domain** (accept `sck`). The clock becomes a list, `bus` moves to *Clocks ›
  Unconnected* with `→ clk`, and the reset stays a mapping: its row reads
  `rst_n — active low, driven by the testbench top` and must **not** say "NOT
  GENERATED". Then, in the YAML, delete the `external: true` line: the row
  gains **NOT GENERATED: with a clock list quick-uvm needs the reset driven by
  the testbench top (external: true) or declared as a domain (Add Reset
  Domain)**, and Problems reports the undriven reset with its quick-fix. Undo
  both edits.

---

## Part C — simulation results on the diagram (R25)

The extension only *reads* what a regression left under `<outputDir>/out`. A
real `make regress` needs the simulator; the steps below put the logs of two
real Xcelium regressions of the tutorial bench (the test fixtures) into place
one file at a time, which is what the watcher sees during a real run. C12 is
the same with a real regression, if you want it.

Launch **"Run the extension (tutorial: yapp_buffer)"**.

### Setting up

The fixtures are of the tutorial's bench — agents `cmd` and `rsp`, scoreboard
`pkt_sb`, coverage on `cmd`. Build it by the tutorial's steps 1–6, or write the
tutorial's own listing:

```powershell
[regex]::Match((Get-Content -Raw docs\tutorial-yapp-buffer.md), '(?s)```yaml\r?\n(.*?)```').Groups[1].Value | Set-Content -NoNewline examples-yapp\yapp_buffer.quickuvm.yaml
```

Then **"Generate testbench"** in the extension window (`examples-yapp/tb/`
appears), and define the two staging helpers in a terminal at the repository
root:

```powershell
function Stage-Run([string]$Set, [string]$Run, [switch]$NoStatus) {
  $src = "scripts\fixtures\results\$Set\runs\$Run"
  $dst = "examples-yapp\tb\out\runs\$Run"
  New-Item -ItemType Directory -Force $dst | Out-Null
  # the verdict file last, as the generated Makefile writes it
  foreach ($f in (Get-ChildItem $src | Sort-Object { $_.Name -eq 'status' })) {
    if ($NoStatus -and $f.Name -eq 'status') { continue }
    Copy-Item $f.FullName $dst -Force
    (Get-Item (Join-Path $dst $f.Name)).LastWriteTime = Get-Date
  }
}
function Stage-Cov([string]$Set) {
  New-Item -ItemType Directory -Force examples-yapp\tb\out\cov | Out-Null
  Copy-Item "scripts\fixtures\results\$Set\cov\summary.txt" examples-yapp\tb\out\cov -Force
  (Get-Item examples-yapp\tb\out\cov\summary.txt).LastWriteTime = Get-Date
}
```

(The helpers stamp the copies with the current time: a plain copy keeps the
fixture's date, which is older than the configuration, and everything would
read as stale from the first step.)

Open the **verification view in the diagram panel** — from *Verification
Hierarchy*, or "Open Verification View". Results are sent to the panel only;
the per-file editor (the diagram a `*.quickuvm.yaml` opens in by default) is
not expected to show them — worth a look, and a finding if you think it should.

### The checks

- [ ] **C1 Nothing yet.** No chip in the header. Command palette → "Refresh
  Simulation Results": an information message says there are no simulation
  results under `tb\out` and that the extension only reads them. "Show
  Simulation Results Report": "there are no simulation results to report".
- [ ] **C2 The first run appears by itself.** Without touching VS Code:

  ```powershell
  Stage-Run fatal yapp_buffer_test.1; Stage-Cov fatal
  ```

  Within a second or two the header shows a red chip **"Runs: 0/1 passed"**.
  *This is the watcher on a folder that did not exist when the window opened —
  the least certain point of the feature. If nothing appears, run "Refresh
  Simulation Results" and note that the watcher missed it.*
- [ ] **C3 The testbench root.** **Env** is outlined in the failure colour
  with a pill **✕ 1** at its bottom-right corner; the **DUT** carries a
  coverage pill at its bottom-left, rounded — `block 71% · expr 50% · toggle
  3%`, or a shorter wording if the box is narrow — whose tooltip has the exact
  figures (71.43 % (5/7), 50 % (3/6), 2.7 % (1/37)). Hovering the Env pill
  lists the fatal (`UVM_FATAL [UNFILLED_PREDICTOR]`). The pill does not
  overflow onto the neighbouring block.
- [ ] **C4 Inside the Env.** `pkt_sb` has the **✕ 1** pill and the outline;
  `cmd_cov` shows **cg 0%**; nothing on `cmd`, `rsp` or the virtual sequencer.
- [ ] **C5 A level with nothing of its own.** Double-click `cmd` (the agent
  level): no pill on the sequencer, driver or monitor, and a second header chip
  says **"✕ 1 not on this level"** — a level never looks clean because its
  problem is drawn elsewhere.
- [ ] **C6 A run in flight.** Back at the Env level:

  ```powershell
  Remove-Item -Recurse examples-yapp\tb\out\runs\yapp_buffer_test.1; Stage-Run errors smoke_test.1 -NoStatus; Stage-Run errors yapp_buffer_test.1
  ```

  (The run without a verdict is staged first: only a `status` file or the
  coverage summary wakes the watcher, never a log.)

  The chip becomes **"Runs: 0/2 passed, 1 without a verdict"** and `pkt_sb`
  shows **✕ 204**. The run without a `status` file is *not* judged from its
  log. The chip's tooltip says the coverage summary is older than the runs
  (the `cov/summary.txt` is still the first regression's).
- [ ] **C7 It finishes.**

  ```powershell
  Stage-Run errors smoke_test.1; Stage-Cov errors
  ```

  **"Runs: 0/2 passed"**; `cmd_cov` shows **cg 100%**; at the root the DUT
  shows `block 100% · expr 100% · toggle 97%` (97.3 % (36/37) in the tooltip);
  the coverage note is gone from the chip's tooltip.
- [ ] **C8 The report.** Click the chip (or "Show Simulation Results Report"):
  a read-only document "Simulation results — yapp_buffer.quickuvm.yaml" opens,
  with the two runs (both FAIL), `sb:pkt_sb — 204 errors, 2 warnings` broken
  down as `SB_NOEXP ×62`, `ERROR ×140`, `FAILED ×2`, `SB_LEFTOVER ×2`, and the
  coverage section. Closing it does not ask to save. Clicking the chip again
  re-uses the tab.
- [ ] **C9 From a message to the generated code.** Press the **✕ 204** pill
  on `pkt_sb`: a menu lists the four message kinds and "Open the results
  report". The press neither selects nor drags the block. A click on a message
  opens `tb/yapp_buffer_comparator.svh` at the line the log names (84, 135,
  106 or 101) — found under the generated bench although the log prints
  `../tb/…`.
- [ ] **C10 Stale.** Make any edit to the configuration (toggle `active` on
  `rsp`): the chip reads **"Runs: 0/2 passed (stale)"**, the pills fade and
  get a dashed border, and the blocks lose their severity outline. It stays so
  after the file is saved (the configuration is now newer than the runs), and
  the report says so too. `Stage-Run errors yapp_buffer_test.1; Stage-Run
  errors smoke_test.1; Stage-Cov errors` — a regression newer than the
  configuration — makes them fresh again.
- [ ] **C11 Hide, and whose results they are.**
  - "Hide Simulation Results": chip and pills go, and "Show Simulation
    Results Report" still opens the report. "Refresh Simulation Results"
    brings them back at once. (Hidden is per session: after a window reload
    they show again.)
  - Hide again, then `Stage-Run errors smoke_test.1` (a newer run): the
    results show again by themselves — another regression is not the hidden
    one.
  - In the YAML, change `dut.name` to `other` and run "Refresh Simulation
    Results": the message says the results under `tb\out` are of DUT
    "yapp_buffer", not of the active configuration, and nothing is drawn.
    Undo.
- [ ] **C12 (optional) A real regression.** In the inspector's **Regression**
  section press "Add regression", generate again (`tb/Makefile` appears), copy
  `examples-yapp/` to the simulation host, run `make regress` in `tb/` there
  (convert the Makefile's line endings first), and copy `tb/out/` back while
  the window is open. Expected: what the tutorial's step 10 describes — with
  the reference model unfilled, one run stopped by `UNFILLED_PREDICTOR`.

### Cleaning up

```powershell
Remove-Item -Recurse -Force examples-yapp\tb, examples-yapp\yapp_buffer.quickuvm.yaml
```

The configurations and `tb/` folders created in `examples/` and in
`examples-bender/common_cells/` are yours to delete the same way; none of them
is tracked.

---

## Findings

| Step | What happened | Expected |
|------|---------------|----------|
|      |               |          |
