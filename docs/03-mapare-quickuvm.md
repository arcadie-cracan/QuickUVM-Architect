# 03 — Mapping the project model → the QuickUVM configuration

This document defines formally how selections on the diagram are translated
into fields of the QuickUVM YAML. The QuickUVM schema reference: the README of
the QuickUVM project (the "Config format" section) and the Pydantic models in
`quick_uvm/models.py`. Principle: the YAML is the source of truth; the
extension *edits* it, it does not own it — any field the extension does not
understand is kept untouched on rewrite (surgical edits, not a full
serialization).

## Designating the DUT

Selection: a block (instance or definition) → the "Set as DUT" command.

| Source in the model | YAML field | Rule |
|---|---|---|
| `instances[].module` | `dut.name` | the definition's name, not the instance's |
| port named `clk*`/`*clk*`, width=1, dir=in | `dut.clock` + `clock:` | heuristic; a chip to confirm in the UI, never applied silently |
| port `rst*`/`*rst*`, width=1, dir=in | `dut.reset` (the port NAME only) | heuristic, confirmed like the clock; only on a clocked DUT |
| the reset's polarity | top-level `reset: {active_low: false}` | suffix `_n`/`_b`/`_ni`/`_bi` → active-low, which is QuickUVM's default and writes nothing; only an active-high reset writes the key |
| who drives the reset | top-level `reset: {external: true}` | **derived, not asked** — written whenever no agent declares the reset port (see below) |
| no clock candidate | `dut.combinational: true`, `dut.reset: ''` | proposed, confirmed by the user; a combinational DUT gets no reset |

The ports chosen as clock/reset get a distinct role in the overlay and are
excluded from the mapping onto agents.

### Who drives the reset — and what "external" means

`reset.external` is QuickUVM's word, and it does **not** mean "the reset is not
a DUT port" (the meaning this document gave it until Nov 2026, under the
pre-1.0 key `dut.external_reset`). It means *external to the agents*: the
testbench top drives the reset instead of an agent. Probed on quick-uvm 1.1.0 —
the single-reset mapping has exactly three shapes, two of which work:

| Shape | What `tb_top.sv` gets | Verdict |
|---|---|---|
| `reset: {external: true}` | `logic rst_n;`, a generated `initial` block (assert, 5 clocks, deassert — the polarity follows `active_low`), every interface declared `(input clk, input rst_n)`, drivers/monitors wait for the release | **what Architect writes** |
| not external, an agent declares the port (`ports.inputs`) | the port is a field of that agent's sequence item, driven like any stimulus; the DUT is wired to that agent's interface | legal, hand-written only (it is the shape of quick-uvm's own `init` scaffold) |
| not external, **no** agent declares the port | `.rst_n(<first agent>_if_inst.rst_n)` — a signal that interface does not have. `generate` exits 0; **elaboration fails** | the `reset-undriven` finding |

Architect keeps the reset pin out of every agent (the role above), so the third
shape is what *every* Architect bench with a reset used to be — including the
tutorial's. `setDut` (`src/yamlops.ts`) now derives `external: true` from the
document (`resetNeedsExternal`): a reset port, a clocked DUT, no agent that
declares the port. The same rule on the neighbouring gestures: collapsing a
one-domain reset list restores `external: true`; adding a reset domain drops it
(under a LIST the top drives every domain — that is what the list means, which
is why the list entry schema has no `external`) and is refused when an agent
declares the port (quick-uvm: "collides with a clock/reset net").

The walls around it, all from the generator:

- `combinational: true` + `reset: {external: true}` is **refused** ("a
  combinational DUT has no reset"), and a combinational DUT's reset port is left
  unconnected — so "Set as DUT" assigns no reset role on a combinational DUT;
  the pin stays unmapped, for an agent or a waiver.
- `external: true` + the port among an agent's ports is **refused** ("An
  external reset must not also be an agent port").
- the reset port cannot be waived (`dut.unverified_ports`): "the bench itself
  drives it".
- an agent with `reset_port` (the agent-side reset output — an agent-driven
  reset under another port name) is **refused** next to `external: true`; there
  `dut.reset` must be `''` or name that port.
- `kind: selftest` + `external: true` is **accepted and hangs**: the DUT-less
  top instantiates the interfaces with the clock only, while they take a
  `rst_n` input and the drivers wait for it. A selftest never gets the flag
  (`setBenchField("kind", …)` drops it and restores it on the way back). A
  `kind: vip` keeps it: the flag decides whether the VIP's interfaces take the
  reset, and the VIP and the bench that consumes it must agree.
- in a composition, a clocked leaf whose own config is **not** external gets no
  reset connection at all in the subsystem top (the port floats — no error);
  with `external: true` the top declares, drives and connects `<subenv>_<reset>`.

Configs written before this are repaired by the validation
(`reset-undriven` in `src/configcheck.ts`, an error): on the DUT's reset pin and
on the Env box in the diagram, in the Problems panel on `dut.reset`, with a
one-click fix. Which fix depends on whether the top CAN drive the reset:

| situation | repair |
|---|---|
| the usual one: a reset pin nobody drives | "Let the testbench top drive it" — `editReset set external true` |
| the model's DUT has no port of that name (an absent `dut.reset` is the generator's default `rst_n`; or a typo) | "Declare no reset port" — `editReset clear` → `dut.reset: ''` |
| an agent drives the reset through `reset_port` | the same `clear` (`external: true` would be refused) |

It is silent where the generator wires no reset or the YAML cannot tell: a
combinational DUT, `kind: selftest` / `kind: vip`, a pure subsystem top, and a
bench with a `from_vip` agent (its ports live in the VIP manifest).

## Agents from a pin selection

Selection: a set of the DUT's pins → "Create Agent from Selection".

The central rule (mind the inversion!): the directions in `agents[].ports` are
from the DUT's perspective, as in the QuickUVM examples — the ports the agent
*drives* are the DUT's inputs:

| DUT pin | YAML |
|---|---|
| `dir: in` (without clock/reset) | `agents[].ports.inputs[]` with `{name, width}` |
| `dir: out` | `agents[].ports.outputs[]` with `{name, width, randomize: false}` |
| `dir: inout` | not supported by the QuickUVM schema today → diagnostic; the user decides (exclude it, or handle it in a pragma) |

`width` is copied numerically from the model (post-elaboration — never an
expression). For unpacked arrays: QuickUVM has no such notion; the extension
proposes either flattening (`width = width_total`) or exclusion with a
diagnostic — an explicit decision per port.

Generated default names (editable): `interface: <agent>_if`,
`transaction: <agent>_seq_item`, `active: true`, `trans_style` from the
extension's global setting.

## Agents from SV interfaces

Selection: an `iface_port` of the DUT → "Agent from interface".

The source: the `instances[].iface` of the connected interface instance
(signals with elaborated widths) + the modport from `iface_ports[].modport`.
The expansion into `ports.inputs/outputs` uses the directions of the *DUT's*
modport, with the same inversion of perspective: a signal that is `in` in the
DUT's modport → the agent drives it → `inputs`. The interface's clock signal
(if there is one) is tied to `dut.clock`; it does not go into the agent. Known
limitation: QuickUVM generates its own `<ag>_if.sv`; the existing SV interface
is the source of the agent's *specification*, it is not reused as a file — if
reuse becomes a requirement, it is an evolution to discuss in QuickUVM, not a
problem of the extension.

## Sub-blocks → subenvs

Selection: an instance in the schematic view → "Create subenv".

| Source in the model | YAML field |
|---|---|
| the name of the instance (or of the fold `ch[0..2]`) | `subenvs[].name` |
| the path to the block's config (created when needed through the same flow, recursively) | `subenvs[].config` |
| `instances[].params` | `subenvs[].params` (a direct copy) |

The case "same definition, different parameters" (the `channels` example): the
extension detects instances of the same module and generates subenvs that share
the config, with different `params` — the auto-namespacing mechanism is already
in QuickUVM.

Implementation (Jul 2026, the `createSubenv` action):

- the selection = blocks (instances or folds) in the schematic view of the DUT
  module; a fold is expanded into its members — one subenv per instance;
- `subenvs[].name` = the relative path sanitized to an SV identifier
  (`g_ch[1].u_ch` → `g_ch_1_u_ch`); collisions get a numeric suffix; subenvs
  with the same name already present in the YAML are skipped (idempotent);
- `subenvs[].config` = `<module>.quickuvm.yaml` next to the top config; if it
  is missing, a skeleton is created (`newConfigText` + a heuristic `dut` — the
  same clock/reset heuristics as for "Set as DUT"), and the summary appears in
  the multi-select confirmation: nothing is applied silently;
- `params` = a direct copy of the elaborated parameters, but **only the integer
  values** (the QuickUVM schema requires `dict[str, int]`); the rest are
  omitted with a note;
- the mutation ensures `layout: packaged` on the top config (composition
  requires it: every child block is a reusable env package; validated by
  QuickUVM);
- the block configs that are created do not disturb the active config:
  discovery is stable (the active file stays active as long as it exists), and
  the initial choice among several files excludes those referenced as
  `subenvs[].config` by another one — the top wins, not the first
  alphabetically (a real regression caught at the interactive validation of
  `createSubenv`);
- the recursive flow is explicit: "Set as DUT" on a module other than the
  active config's DUT asks — do you overwrite the active config's DUT (the
  phase 2 semantics) or do you create a `<module>.quickuvm.yaml` dedicated to
  the block, which becomes the session's active config; switching between
  configs afterwards: the "Choose Active Config" command (it writes
  `quickuvm.configFile`);
- the "Create subenv" gesture is self-sufficient on non-DUT views too: the
  button is enabled whenever blocks are selected, and the DUT mismatch is
  resolved IN the flow — the offer "Create `<module>`.quickuvm.yaml and set its
  DUT" (the block's config becomes active, with the Set as DUT heuristics
  confirmed), then the subenv proposals continue in the same gesture; a dead
  button that needs an explanation is a badly designed gesture (reported at the
  interactive validation on common_cells).

Constraints inherited from QuickUVM (verified on HEAD, Jul 2026 — the M1
clocked-subenv slice lifted the combinational-only restriction): child blocks
with a clock are accepted if they are **single-clock, with at most one reset**
(the heuristic skeleton created by the extension always satisfies the
condition; multi-clock leaves remain a future slice); `params` requires the
block's agent to declare the parameter in `parameters:` (the skeleton created
by the extension has no agents yet, so `generate` fails visibly until the
block's agent is configured — the recursive flow remains the user's
responsibility); a parameterized block must be single-agent; a block with
`register_model` cannot be composed yet.

## Internal nets → probes (sketch, QuickUVM ≥0.9.2 / K2)

Selection: a net in any schematic view below the DUT → "Create probe" (a
planned gesture, phase 3b/4).

| Source in the model | YAML field |
|---|---|
| the net's name (sanitized to an SV identifier) | `probes[].name` |
| the net's elaborated path minus the DUT instance's path (invariant 4) | `probes[].path` |
| the net's width from the model | `probes[].width` |

Probes are OBSERVE-only (an XMR generated by QuickUVM in the probe interface);
`enum`/`type` (symbolic coverage on FSMs) require the extractor to emit the
nets' types — today svmodel gives only widths. QuickUVM constraint: `probes`
are not yet accepted on subsystem benches (H1).

## The rest of the configuration

`project`, `clock.period/unit`, `tests[]`, `analysis`, `register_model` have no
geometric counterpart on the design's diagram — in phases 2–3 they are edited in
the side inspector (a simple form). A useful exception: `analysis.scoreboards[].source`
and `analysis.coverage[]` can be chosen by clicking an agent in the diagram. From
phase 3b on, `analysis`, `virtual_sequences` and the `subenvs` composition get a
representation and direct editing in the verification view (docs/05, decision
D16); the mapping of the gestures onto YAML fields is added to this document at
implementation time.

## The coverage indicator and validation

An invariant displayed permanently: every port of the DUT is in exactly one of
the states {agent X, clock/reset, explicitly ignored, unmapped}. "Unmapped" is
the working state; generating with unmapped ports asks for confirmation.
Validations at edit time:

- a port in the YAML that does not exist in the model → diagnostic (Problems +
  a mark on the diagram); it is not deleted automatically (graceful
  invalidation);
- a width in the YAML ≠ the width in the model → diagnostic with the quick-fix
  "Update width of "<port>" to N";
- overlapping pins between agents → error (a pin belongs to a single agent).

## The generation cycle

"Generate Testbench" → the task `quick-uvm generate --config <yaml> --output <dir>`;
the Pydantic/CLI errors are parsed into Problems. Post-MVP: `quick-uvm status`
feeds decorations on the generated files (user-modified / orphaned /
out-of-band), making QuickUVM's fail-closed contract visible.
