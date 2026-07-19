# QuickUVM Architect — context for the QuickUVM agent

**Purpose:** this document accompanies a request to describe the **QuickUVM
schema and options** (the `*.quickuvm.yaml` format + the behavior of
`quick-uvm generate`). The answer will be used as the authoritative reference
for further development of QuickUVM Architect. Please answer against the
**current build** of QuickUVM and state explicitly the **version/commit** the
answer refers to.

---

## 1. What QuickUVM Architect is

A VSCode extension for digital IC design: it visualizes a SystemVerilog design
as an interactive diagram (symbol / RTL schematic / testbench diagram) and
**generates, through gestures on the diagram, the YAML configuration for
QuickUVM**. The flow: the user selects pins/blocks on the diagram → the
extension writes/edits the YAML → the user runs `quick-uvm generate`.

Invariants relevant to you:

- **The QuickUVM YAML file is the source of truth.** The extension keeps no
  configuration state of its own: every action produces a **text edit** of the
  YAML (via `WorkspaceEdit`), so undo/redo, diff, and manual editing work
  naturally. Consequence: **the stability of key names and semantics matters a
  lot**; renames/deprecations must be flagged explicitly.
- The extension **replicates the generator's validations** ahead of generation
  (badges on the diagram, diagnostics on the YAML, refused gestures), so the
  user does not discover errors only at `generate` time. This is why we need
  the exact validation rules **and their messages**.
- The extension **parses `quick-uvm`'s stderr** to surface errors in the
  editor (we look for `N validation error(s) for ProjectConfig` and
  `Error:`), so the stderr error format is part of the contract.
- The extension writes its own extension key into the YAML:
  `x_quickuvm_architect` (today only `ignored_ports: [...]`). We assume the
  generator **ignores** unknown keys with the `x_` prefix — to be confirmed
  (see A24).

## 2. What Architect currently knows about QuickUVM — assumptions to verify

All the facts below were **probed empirically against quick-uvm 0.9.2**
(Jul 2026, `models.py` ~3216 lines). For each one, please give a verdict:
**CONFIRMED** / **CHANGED (how exactly)** / **WRONG (what the reality is)**.

### Basic structure

- **A1.** `dut:` has `name`, `clock`, `reset` (the names of the DUT's
  clock/reset ports). A combinational DUT (no clock of its own) is possible.
- **A2.** `agents[]`: `name` (SV identifier), `ports.inputs[]`/`ports.outputs[]`
  with `{name, width}`, `active: true|false` (active by default), optional
  declared `parameters:`. Interface/transaction names default from the agent
  name (`<name>_if`, `<name>_seq_item`) when not given explicitly.
- **A3.** `scoreboards[]`: `name`, `source` (agent, required), `monitor`
  (agent, optional — absent ⇒ single-stream), `match` (`in_order` default /
  `out_of_order`), `match_key` (only with `out_of_order`), `max_latency`.
- **A4.** `virtual_sequences[]`: sequences with steps that reference agents by
  name.
- **A5.** `layout: packaged` is **required** on a config that has `subenvs`.
- **A6.** `params` on a subenv is strictly `dict[str, int]` (integers only) and
  requires declared `parameters:` in the child config's agent.

### The `analysis:` block — mode switching

- **A7.** WITHOUT the `analysis:` key, the generator runs in **implicit** mode:
  it auto-wires a scoreboard AND a coverage collector to the "primary agent".
  WITH `analysis:` present — even an empty `{}` — it runs in **declared** mode:
  it wires exactly what is listed (empty ⇒ nothing). So absence vs. presence of
  the key are **not equivalent** — the extension never removes an emptied
  `analysis` mapping (only the child lists `scoreboards: []` / `coverage: []`).
- **A8.** The `<agent>_cov.svh` file is generated regardless, per agent —
  `analysis` controls only the **wiring in the env**, not the existence of the
  class.

### Composition (`subenvs`) — hard rules

- **A9.** A bench with `subenvs` **must not have agents of its own** (the
  hybrid is rejected at `generate` with the message *"a bench with `subenvs`
  ... must not define its own `agents`"*). Every composition level is a
  **pure** subsystem.
- **A10.** A subsystem bench requires **≥2 subenvs**; composing a single block
  is rejected (only at `generate`, with a clear message).
- **A11.** Composed blocks **share a namespace**: agent/interface/transaction/
  sequence names must be unique across **distinct** block configs; two
  `subenvs` pointing at the **same** config are OK (the env package is
  reused).
- **A12.** Nesting works: a subenv whose config is itself a subsystem is
  accepted (each level requires ≥2).
- **A13.** Children with a clock are accepted if they are single-clock with at
  most one reset (the M1 slice).

### Inter-block wiring (`connections`, `subenv_scoreboards`)

- **A14.** `connections: [{from: <subenv>.<port>, to: <subenv>.<port>}]` —
  valid only on a bench with `subenvs`; the first token is the **subenv
  instance name** (`subenvs[].name`), not `dut.name`; `from` = an **output**
  port of the source block, `to` = an **input** port of the destination; widths
  must be **equal**; a single driver per destination; the **destination**
  block's agent must be passive (`active: false`, otherwise refused with:
  *"agent ... is active and would drive ..."*); it generates a physical
  `assign` in tb_top. The wire connects **agent** interface ports, so the
  children must have agents defined beforehand.
- **A15.** `subenv_scoreboards: [{name, source: <subenv>.<AGENT>, monitor:
  <subenv>.<AGENT>}]` — the endpoints are keyed on **agent** names (not port
  names).
- **A16.** Neither `connections` nor `subenv_scoreboards` switches modes
  (absence = byte-identical to an empty list), so the extension freely cleans
  up emptied lists.

### Whitebox probes (`probes`)

- **A17.** Only `name` (SV identifier) and `path` are required; `width`
  defaults to **1** — a probe without a width **silently truncates** a wide
  signal.
- **A18.** `path` is glued **verbatim** after `dut_inst.` in tb_top
  (`assign probe_if.<name> = dut_inst.<path>;`) — relative to the DUT instance
  and **not validated** by the generator (a wrong path passes silently).
- **A19.** The `probes:` block does NOT switch modes (unlike `analysis`).
- **A20.** Refusals: `probes` + `subenvs` = hard error; a name colliding with
  an interface/agent port/clock/reset (shared tb_top/config-DB namespace);
  multi-instantiated agents; more than one clock domain.

### Known bugs in 0.9.2 (worked around by Architect — do they still exist?)

- **A21.** `layout: packaged` + a probe with `coverage` → `env_pkg` does not
  include `probe_monitor` (unknown type, does not compile). This is why
  Architect does not offer `coverage` on probes in packaged configs.
- **A22.** A leaf block with probes, **composed as a subenv**: the probe files
  are generated, but the subsystem's tb_top has no `probe_if` instance, no
  XMR, no `config_db`, and `probe_if.sv` is not in the filelist → **exit 0,
  silently broken**. Architect warns at composition time.
- **A23.** `struct` + `coverage` crashes the generator.

### Miscellaneous

- **A24.** Unknown keys (in particular the `x_` prefix) are ignored by the
  parser/validator — correct?
- **A25.** The generated output contains a **DUT stub** (duplicate definition)
  and sources that require `uvm_macros.svh` — which is why Architect excludes
  `quickuvm.outputDir` from its source globs.
- **A26.** CLI: `quick-uvm generate -c <yaml> -o <dir>`; Pydantic errors appear
  on stderr as `N validation error(s) for ProjectConfig`, CLI errors as
  `Error: ...`; nonzero exit code on failure. It writes Unicode arrows to
  stdout (we set `PYTHONUTF8=1`).

## 3. What we are asking for — the content of the answer

1. **The complete schema reference**, key by key (ideally a table per
   section): type, required/optional, default value, allowed values, the
   validation rules **with their exact messages** (the text that reaches
   stderr), and the version each key first appeared in. Including keys that
   Architect does **not** use today — we want to know what exists beyond our
   list (tests/test flow, sequences, layout options, everything).
2. **A verdict on each assumption A1–A26**: CONFIRMED / CHANGED (with a
   description of the change) / WRONG (with the reality).
3. **The mode-switching semantics** — every place where the *presence* of a
   key changes behavior relative to its *absence* (like `analysis:`). These
   dictate what the extension's deletion mutations are allowed to clean up.
4. **The composition rules** — the complete, current list (hybrid, ≥2,
   namespace, nesting, params, clocks), plus any new rule.
5. **The CLI contract**: commands, options, exit codes, the stderr format
   (stable patterns we can parse), behavior on a partially valid config.
6. **The structure of the generated output**: which files, where, the
   filelist, what must be excluded from a compilation of the real design (the
   DUT stub etc.).
7. **Minimal YAML examples** that generate cleanly: (a) a leaf bench with 2
   agents + a two-stream scoreboard + coverage; (b) a pure subsystem with 2
   subenvs + `connections` + `subenv_scoreboards`; (c) a bench with `probes`.
   Plus 2–3 typical **invalid** examples with the exact error they produce.
8. **A changelog relative to 0.9.2** for anything touching the points above,
   and the status of bugs A21–A23.

**Format:** structured markdown (section headings, tables for keys, code
blocks for YAML and for verbatim error messages). The answer will be consumed
by an LLM agent developing Architect — precision of key names and messages
matters more than prose.
