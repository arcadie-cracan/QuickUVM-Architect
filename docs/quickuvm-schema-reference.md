# QuickUVM schema & behavior reference — for QuickUVM Architect

Answer to `docs/context-architect-for-quickuvm.md`. Every statement below was
derived from the QuickUVM source at the stated commit and **verified by
execution** (Pydantic introspection, `model_validate`/`from_yaml` probes, real
`Generator.generate_all` runs, real `quick-uvm` CLI invocations, and two Xcelium
`xrun -compile` runs for the bug reproductions). Error messages are quoted
verbatim. Anything not verified is listed at the end under
[open questions](#open-questions--unverified).

## 0. Version header + breaking-changes summary {#version-header}

| | |
|---|---|
| Commit | `3dacf5ab95f05a51fc768d0a693de627a94bce6d` (branch `main`) |
| Version string | `0.9.2` (`pyproject.toml` and `quick_uvm/__init__.py`) |
| Probed | 2026-07-19/20, Python venv of the repo, Xcelium 25.09 |

> **⚠ The version string was NOT a reliable discriminator at the probed
> commit.** The package still reported `0.9.2` while the schema had been
> through a large consolidation campaign since Architect's July-2026 probe
> (`models.py` grew ~3216 → ~4600 lines). **Fixed immediately after: the
> follow-up commits bump to `0.10.0` (`feat/unverified-ports`) and then
> `1.0.0` (the stable release, schema frozen with a teaching-error deprecation
> policy).** Architect can gate on `quick-uvm --version` ≥ 1.0.0 for
> everything in this document, including `dut.unverified_ports`.

Changes that break or invalidate an Architect assumption, most impactful first:

| A# | What changed | New contract |
|----|--------------|--------------|
| **A24** | **Unknown keys are now REJECTED at every level** (`extra="forbid"` on all config classes). `x_quickuvm_architect` fails validation — and stays rejected. | **RESOLVED in v0.10.0** by promotion, not an escape hatch: the waiver concept is now the first-class key `dut.unverified_ports: [..]` (validated: SV identifiers, no duplicates, no agent-connected port, no clock/reset; rendered as a comment above `dut_inst`). Architect must write/read that key and drop the `x_` machinery. See [§2-A24](#a24). |
| **A9** | **The hybrid ban is LIFTED.** A bench with `subenvs` MAY declare its own `agents` (they become *boundary agents* wired at the composition top — the "chip_env" shape). | Architect's hard diagnostic on `agents`+`subenvs` and the `hasDut` "invalid but drawn honestly" branch are now wrong: the config is *valid*. |
| **A15** | `subenv_scoreboards:` **no longer exists** — cross-block scoreboards moved to `analysis.scoreboards` with dotted endpoints (`<subenv>.<agent>`) or bare boundary-agent names. Old key = teaching error. | `xsb:` nodes, `removeAgent`'s qualified-name logic, and any writer of `subenv_scoreboards` must migrate. |
| **A2** | `interface:` and `sequence_item:` are **required** on every agent — there is no defaulting from the agent name. | Architect always writes them, so its own output is fine; only the assumption is wrong. |
| — | **Reset grammar moved**: `dut.reset_active_low` / `dut.external_reset` / top-level `resets:` are all rejected with teaching errors. New: top-level `reset:` (mapping or list), mirroring `clock:`. `dut.reset` = port name only. | Any mutation writing the old spellings now produces an invalid file. |
| — | **Renames** (old key = teaching error): agent `trans_style`→`seq_item_style`, `transaction`→`sequence_item`, `count`→`replicas`; top-level `coverage_models`→rich `analysis.coverage` entries, `reference_model`→per-scoreboard `analysis.scoreboards[].reference_model`, `agent_refs`→`agents[]` entries with `from_vip`, `clocks`→list under `clock:`. | Full ledger in [§1.12](#internal-and-renamed-keys). |
| **A20** | Probes + **multi-clock** now allowed (per-probe `clock:` selects the domain). Probes + `replicas` allowed. Probes + `instances:` still refused. | `proposeProbe`'s refusal list can drop the >1-clock-domain rule. |
| **A23** | `struct` + `coverage` **no longer crashes** — generates and compiles clean (xrun, 0 errors). | The Architect workaround can be retired. |
| **A3** | `max_latency` now works with **both** match modes (`in_order` too), not only `out_of_order`. Scoreboard entries also gained `window:` and per-scoreboard `reference_model:`. | If `configcheck` replicates the old wall, relax it. |
| **A26** | Validation stderr is now prefixed: `Error: Invalid config: N validation error(s) for ProjectConfig`. | Both grep patterns still match as substrings (they now co-occur on one line). |

Still broken, reproduced on this commit: **A21** (packaged + probe `coverage`
→ `env_pkg` misses the include, xrun `*E,NOIPRT`) and **A22** (leaf probes
composed as subenv → probe files generated but unwired and unfilelisted, exit 0).

---

## 1. Complete schema reference {#schema-reference}

Method: every class/field below comes from enumerating `model_fields` on all
Pydantic models in `quick_uvm/models.py` at the stated commit — not from reading
docs. "Rules" lists the principal validators with their verbatim messages (the
schema has ~245 value validators; every one reaches stderr in the same
`Error: Invalid config: …` format, so unlisted ones parse identically).
Internal (loader-set) fields are in [§1.12](#internal-and-renamed-keys).

### 1.1 Top level (`ProjectConfig`) {#top-level}

| key | type | default | notes |
|-----|------|---------|-------|
| `project` | mapping | **required** | see §1.2 |
| `dut` | mapping | **required** | see §1.3 |
| `clock` | mapping **or list** | `{name: clk, period: 10, unit: ns}` | union; see §1.4 |
| `reset` | mapping **or list** | `{active_low: true, external: false}` | union; see §1.4 |
| `agents` | list | `[]` | declared agents or `{name, from_vip}` references; see §1.5 |
| `tests` | list | **`[{name: test1}]`** | see §1.9. **ABSENCE ≠ empty list**: absent ⇒ the default `test1`; `tests: []` is accepted and yields ZERO tests (only `<dut>_base_test.svh` — nothing runnable). |
| `analysis` | mapping \| absent | absent | **presence switches modes** — see §3 |
| `register_model` | mapping \| absent | absent | see §1.7 |
| `probes` | list | `[]` | absent ≡ `[]` (byte-identical, proven); see §1.8 |
| `regress` | mapping \| absent | absent | presence adds a `Makefile`; see §1.9 |
| `virtual_sequences` | list | `[]` | see §1.10 |
| `auto_virtual_sequences` | bool | `true` | with ≥2 agents and no explicit vseq, generates+wires `<dut>_vseq` into tests; see §3 |
| `auto_vseq_mode` | `parallel` \| `sequential` | `parallel` | body shape of the auto vseq |
| `layout` | `flat` \| `packaged` | `flat` | `packaged` = per-agent/env/test packages + chained `.f` filelists |
| `kind` | `bench` \| `vip` \| `selftest` | `bench` | `vip` emits only agent package(s) + `.qvip` manifest; `selftest` a DUT-less loopback top |
| `top_name` | str | `tb_top` | name of the generated top module/file |
| `subenvs` | list | `[]` | composition; requires `layout: packaged`; see §1.11 and §4 |
| `connections` | list | `[]` | inter-block wiring; absent ≡ `[]` (proven); see §1.11 |

### 1.2 `project:` (`ProjectMeta`)

| key | type | default |
|-----|------|---------|
| `name` | str | **required** |
| `author` | str | `''` |
| `year` | int | `2026` |
| `uvm_version` | `1.1d` \| `1.2` | `1.2` |
| `version` | str | `0.1.0` |
| `imports` | list[str] | `[]` (extra package imports for the tb package) |

### 1.3 `dut:` (`DutConfig`)

| key | type | default | notes |
|-----|------|---------|-------|
| `name` | str | **required** | module name; a stub `<name>.sv` is generated (see §6) |
| `clock` | str | `clk` | **port name only** |
| `reset` | str | `rst_n` | **port name only**; `''` disables the reset port |
| `combinational` | bool | `false` | no clocked processes assumed; subsystem container tops use `combinational: true, reset: ''` |
| `unverified_ports` | list[str] | `[]` | *(v0.10.0)* port-coverage waiver — DUT ports deliberately out of scope (scan/test pins). Not checked against the RTL; walls: legal SV identifiers, `unverified_ports has duplicate entries: […]`, `dut.unverified_ports '<p>' is connected by agent '<a>' — a port cannot be both verified (an agent drives/monitors it) and declared unverified. Remove it from one side.`, `dut.unverified_ports '<p>' is the bench clock/reset net — the bench itself drives it; only DUT data ports can be waived.` Renders `// Deliberately UNVERIFIED DUT ports …` above `dut_inst`. **This replaces `x_quickuvm_architect.ignored_ports`.** |

Reset polarity/externality does **not** live here anymore (see §1.4). Old keys
teach:

```
Value error, dut key 'external_reset:' moved to the top-level `reset:` block — `reset: {external: ...}` (dut.reset is just the port name, like dut.clock).
Value error, dut key 'reset_active_low:' moved to the top-level `reset:` block — `reset: {active_low: ...}` (dut.reset is just the port name, like dut.clock).
```

### 1.4 `clock:` and `reset:` unions {#clock-reset}

Both accept a **mapping** (the single domain's config) or a **list** (multiple
domains). The port names stay on `dut`. **A single-entry list is NOT the same
as the mapping** — declaring a list engages the multi-domain machinery
(per-domain nets/clkgen; proven: scalar vs `[{name: clk}]` differ in
`clkgen.sv` and `tb_top.sv`). Never "simplify" a 1-element list to a mapping.

`clock:` mapping / list entries (`ClockConfig`):

| key | type | default | rule (verbatim excerpt) |
|-----|------|---------|------|
| `name` | str | `clk` | |
| `period` | int | `10` | `clock 'clk': period must be >= 1 (got 0) — period 0 generates a zero-delay infinite loop that hangs at t=0.` |
| `unit` | str | `ns` | `clock 'clk': unknown unit 'sec' (one of ['fs', 'ms', 'ns', 'ps', 's', 'us']).` |
| `drive_offset_pct` | int | `20` | bounds-checked 1..99 |
| `source` | `tb` \| `dut` | `tb` | `dut` = the DUT *outputs* this clock (SPI sck style); the TB then must not generate it |

`reset:` mapping keys — closed set, unknown keys teach:

```
Value error, `reset:` (single-reset mapping) accepts ['active_low', 'external'] — got ['polarity']. For multiple reset domains use a LIST of {name, active_low, clock} entries; the port name is dut.reset.
```

| key | type | default |
|-----|------|---------|
| `active_low` | bool | `true` |
| `external` | bool | `false` (`true`: the TB does not generate the reset; the environment/DUT drives it) |

`reset:` list entries (`ResetConfig`): `{name: str (required), active_low: bool = true, clock: str|null}`.
Under a list, `dut.reset` must name one of the domains:

```
Value error, dut.reset 'rst_n' is not one of the declared `resets:` domains ['wrst_n'] — under a resets: list, dut.reset selects which domain binds the DUT's reset port (it would otherwise be silently ignored).
```

### 1.5 `agents[]` (`AgentConfig`) {#agents}

Two entry shapes in one list — **declared** (full config) or **reference**
(`{name, from_vip}`, everything else from the VIP manifest; extra keys rejected).

| key | type | default | notes |
|-----|------|---------|-------|
| `name` | str | **required** | SV identifier |
| `interface` | str | **required** | no defaulting from `name` |
| `sequence_item` | str | **required** | no defaulting from `name` |
| `seq_item_style` | `manual` \| `field_macros` | `manual` | |
| `active` | bool | `true` | |
| `ports` | `{inputs:[], outputs:[], inouts:[]}` | all `[]` | see §1.5.1 |
| `sequences` | list | `[]` | `{name (req), kind: random|incrementing|directed|reset|error|nested = random, count: 100, field, steps[]}` |
| `fields` | list | `[]` | extra non-port item fields: `{name (req), element_width: 8, kind: dynamic|queue, randomize: true, min_size: 0, max_size: 64, bound_size: true}` |
| `constraints` | list[str] | `[]` | verbatim SV constraint bodies |
| `emit_when` | str \| null | null | monitor gating expression |
| `parameters` | list | `[]` | `{name (req), type: int, default (req int)}` |
| `instances` | list | `[]` | per-instance param overrides `{name (req), values: {param: int}}`; requires `parameters` (`agent 'ch': `instances` requires `parameters` — each instance overrides the agent's parameter values.`) |
| `replicas` | int | `1` | replicate the agent N× onto one vectored DUT; needs `reset: {external: true}` (`` `replicas` (agent 'cmd') needs `reset: {external: true}` — a shared vectored DUT binds the top-level reset net. ``) |
| `clock` | str \| null | null | multi-clock: which `clock:` domain this agent samples |
| `reset` | str \| null | null | multi-reset: which reset domain gates this agent |
| `reset_port` / `reset_port_active_low` | str/bool \| null | null | agent-side reset output port |
| `assertions` | bool | `false` | interface SVA scaffold |
| `mode` | `initiator` \| `responder` | `initiator` | reactive agents |
| `request_valid` | str \| null | null | **`mode: responder` only** (validator-enforced); names a SAMPLED (`outputs`) 1-bit port. **Required** by `mode: responder`. |
| `request_ready` | str \| null | null | **`mode: responder` only** (validator-enforced) + needs `respond: on_request`\|`pipelined` (the shapes whose monitor publishes the request). The READY half of the request handshake — may name a driven OR a sampled port, must differ from `request_valid`. *(was documented here as initiator-side — wrong; `examples/axi_handshake` puts it on a responder.)* |
| `respond` | `on_request` \| `prefetch` \| `combinational` \| `pipelined` | `on_request` | responder timing contract; **`mode: responder` only** — a non-default value on an initiator is now an error (it used to be accepted and silently ignored). |
| `reorder_by` | str \| null | null | **`respond: pipelined` only** (and hence responder-only); **required** by `pipelined`. A SAMPLED port, ≤ 31 bits, ≠ `request_valid`. |
| `reorder_policy` | `priority` \| `round_robin` \| `random` | `priority` | non-default is **`respond: pipelined` only** |
| `proactive` | bool | `false` | hybrid: a responder that also takes proactive stimulus. **`mode: responder` + `respond: on_request` only**, and incompatible with `idle`. |
| `idle` | dict[str,int] | `{}` | idle port values driven between items; **`mode: responder` only** (it selects the continuous, non-blocking responder driver) and incompatible with `proactive` |
| `from_vip` | path | — | *reference entries only*; resolved by `from_yaml` relative to the config file |

Reference entries outside `from_yaml` fail loudly:

```
Value error, `from_vip` reference entries are resolved by ProjectConfig.from_yaml (it reads the VIP manifest relative to the config file); a bare model_validate cannot resolve them.
```

Missing manifest (CLI): `Error: Invalid config: agent 'io': VIP manifest not found: /abs/path/nope.qvip. Generate the VIP first (kind: vip).`

#### 1.5.1 Ports (`PortConfig`)

| key | type | default | notes |
|-----|------|---------|-------|
| `name` | str | **required** | |
| `width` | int | `1` | |
| `width_param` | str \| null | null | width from a declared parameter |
| `randomize` / `rand_mode` | bool | `true` | |
| `open_drain` | bool | `false` | inouts; `pullup: false` — a pullup is mandatory for open-drain nets (validator-enforced) |
| `enum` | dict[str,int] \| null | null | symbolic values (also drives symbolic coverage bins) |
| `type` | str \| null | null | user SV type name |
| `packed_dims` | list[int] \| null | null | |
| `struct` | list \| null | null | inline struct members `{name, width: 1, packed_dims, struct, enum}` (recursive) |
| `constraint` | str \| null | null | per-port constraint expression |

### 1.6 `analysis:` {#analysis}

**Presence — even `{}` — switches from implicit to declared wiring** (see §3).
Keys:

| key | type | default | notes |
|-----|------|---------|-------|
| `coverage` | list | `[]` | entries are **bare agent names** (routing: instantiate+connect that agent's `<agent>_cov`) **or rich mappings** `{agent (req), coverpoints[], crosses[], goal}` which also generate covergroup content |
| `scoreboards` | list | `[]` | see below |

Rich coverage entry internals: `coverpoints[] = {field (req), bins[], illegal_bins[], ignore_bins[], transitions[], at_least, auto_bin_max}`;
bin = `{name (req), value | range: [lo,hi] | values: [..]}`; transition = `{name, seq}`;
`crosses[]` = list-of-fields shorthand **or** `{fields (req), name, bins[]}` with
cross-bin `{name, kind: bins|ignore_bins|illegal_bins, select}`.

Scoreboard entries (`ScoreboardSpec`):

| key | type | default | rule (verbatim) |
|-----|------|---------|------|
| `name` | str | `sbd` | |
| `source` | str | **required** | agent name, or on compositions `<subenv>.<agent>` / a boundary-agent name. `analysis.scoreboards 'sbd' references unknown source agent 'nope'.` |
| `monitor` | str \| null | null | absent ⇒ single-stream. `analysis.scoreboards 'sbd': monitor must differ from source (a two-stream scoreboard needs distinct in/out streams); omit monitor for a single-stream scoreboard.` |
| `match` | `in_order` \| `out_of_order` | `in_order` | |
| `match_key` | str \| null | null | `scoreboard 'sbd': match_key is only used with match='out_of_order'.` |
| `max_latency` | int \| null | null | **works with both match modes** (new); `scoreboard 'sbd': max_latency must be >= 1 cycle.` |
| `window` | `{boundary (req), length (req)}` \| null | null | windowed N:1 statistic checking (single-stream only) |
| `reference_model` | `{language: sv|c}` | `{language: sv}` | per-scoreboard predict() language (C via DPI bridge) |

### 1.7 `register_model:` (`RegisterModelConfig`)

| key | type | default |
|-----|------|---------|
| `package` | str | **required** (external RAL package name) |
| `block` | str | **required** (uvm_reg_block class) |
| `map` | str | `default_map` |
| `bus_agent` | str | **required** (must be an initiator agent) |
| `adapter` | str | `reg_adapter` |
| `use_predictor` | bool | `true` |
| `reg_test` | bool | `true` |
| `csr_tests` | list of `hw_reset` \| `bit_bash` \| `rw` \| `mem_walk` \| `shared` | `[]` |
| `coverage` | bool | `false` (generates a RAL-driven per-register coverage collector) |
| `backdoor_root` | str \| null | null |
| `reg_test_door` | `frontdoor` \| `backdoor` | `frontdoor` |
| `frontdoor` | str \| null | null (custom `uvm_reg_frontdoor` class) |

Presence adds `reg_adapter.svh` + `<dut>_reg_test.svh` (proven by diff) and RAL
wiring in env/test; the RAL package itself is user-provided input.

### 1.8 `probes[]` (`ProbeConfig`) {#probes}

| key | type | default | notes |
|-----|------|---------|-------|
| `name` | str | **required** | shares the tb_top/config-DB namespace (collision rules below) |
| `path` | str | **required** | glued verbatim: `assign probe_if.pp = dut_inst.u_core.state_q[3];` (proven); **not validated** — a wrong path passes silently |
| `width` | int | `1` | no width-vs-path check: a wide signal silently truncates |
| `enum` / `type` / `packed_dims` / `struct` | as ports | null | `enum` gives symbolic coverage bins |
| `real` | bool | `false` | real-valued probe (SVA-only, no coverage) |
| `clock` | str \| null | null | **multi-clock benches: selects the sampling domain** (this is what lifted the old >1-clock refusal) |
| `coverage` | bool | `false` | generates `<dut>_probe_monitor.svh` (⚠ A21 packaged bug, §2) |

Refusals (verbatim):

```
Value error, whitebox `probes` are not yet supported on a subsystem bench (`subenvs`): paths are relative to one DUT instance, but a composed bench has per-leaf DUTs. Probe the leaf block's own config instead.
Value error, probe 'clk' collides with a clock net — probe names share the tb_top / config-DB namespace; rename the probe.
Value error, probe 'cmd_req' collides with agent 'cmd' port — probe names share the tb_top / config-DB namespace; rename the probe.
Value error, probe 'cmd_if' collides with agent 'cmd' interface — probe names share the tb_top / config-DB namespace; rename the probe.
Value error, whitebox `probes` are not yet supported with multi-instantiated agents (`instances`): there is no single DUT instance to resolve paths against.
```

Allowed now (proven by generation): probes + multi-clock (with per-probe
`clock:`), probes + `replicas`.

### 1.9 `tests[]` and `regress:`

`TestConfig`: `{name (req), num_items: 100, sequence: {agent (req), name (req), count} | null, vseq: str | null, seeds: int | null}`.
`seeds` without a `regress:` block is rejected:

```
Value error, tests ['t'] set `seeds`, but there is no `regress:` block — seeds is the per-test seed count in the regression matrix and renders nothing without one.
```

`RegressConfig`: `{simulator: xcelium, filelist: '../sim/xrun.f', seeds: 1, coverage: true}`.
Presence generates a `Makefile` (elaborate-once tests×seeds matrix + coverage
merge). Note: `xrun` exits 0 on `UVM_ERROR` — the Makefile's verdict block
greps severities; Architect should not infer pass/fail from exit code either.

### 1.10 `virtual_sequences[]` (`VseqConfig`)

`{name (req), mode: sequential|parallel = sequential, body: [{agent (req), sequence (req)}]}`.
Steps are validated against the agent's sequence library:

```
Value error, vsequence 'v': step references unknown agent 'nope'.
Value error, vsequence 'smoke_vseq': step sequence 'cmd_random_seq' is not a library sequence of agent 'cmd' (nor its default 'cmd_sequence').
```

The default per-agent sequence is **`<agent>_sequence`**. A test runs a vseq
only if `tests[].vseq` names it. With **no** explicit vseqs, ≥2 agents, and
`auto_virtual_sequences: true` (default), the generator emits
`<dut>_base_vseq.svh` + `<dut>_vseq.svh` + `<dut>_virtual_sequencer.svh` and
wires `<dut>_vseq` into the generated tests (see §3 — a deletion hazard).

### 1.11 `subenvs[]` / `connections[]` {#subenvs}

`SubenvConfig`: `{name (req: instance name), config (req: path relative to the top yaml), params: dict[str,int] = {}, namespace: bool|str|null}`.
`params` values must parse as int (Pydantic `int_parsing` error otherwise), and
each key must be a declared parameter of some agent in the child:

```
Value error, subenv 'u_a': params override 'W' is not a declared parameter of any agent in block 'blka' (declared: []).
```

`namespace`: two subenvs sharing the **same** config file are auto-namespaced
by subenv name (`lo_*`/`hi_*` class/file prefixes — proven); `namespace` lets
you force/name that behavior explicitly.

`SubenvConnection`: canonical keys **`src`/`dst`**; the 0.9.2 spelling
**`from`/`to` is still accepted** (proven) and error texts use `'from'`/`'to'`
labels. Endpoint grammar `<subenv>.<port>` (first token = `subenvs[].name`);
with boundary agents, a top-level agent's port can be an endpoint too. Rules
(verbatim):

```
Value error, connection 'to' 'u_b.blkb_in': block 'u_b' agent 'blkb_a' is active and would drive 'blkb_in', conflicting with the connection — make it passive (active: false).
Value error, connection 'u_a.blka_out' -> 'u_w.w_in': width mismatch (8-bit output driving a 4-bit input) — would silently truncate/pad.
```

Generates a physical assign in tb_top (proven):
`assign u_bp_blkbp_if_inst.bp_in = u_a_blka_if_inst.blka_out;`

Composition rule messages are in [§4](#composition-rules).

### 1.12 Internal fields & the rename/move ledger {#internal-and-renamed-keys}

Runtime-only fields (`exclude=True`, set by the loader; **rejected as user
input** with the messages shown): top-level `clocks`, `resets`,
`subenv_scoreboards`, `subenv_configs`, `subenv_namespaces`,
`original_dut_name`, `coverage_models` (under `analysis`), agent
`original_name`/`is_reference`/`ref_filelist`, dut
`reset_active_low`/`external_reset` (now internal storage for the `reset:`
union).

Full teaching-error ledger (old spelling → verbatim rejection; all reach stderr
in the standard format, so Architect can regex them for migration quick-fixes):

| old | verbatim error (core) |
|-----|------------------------|
| top `scoreboards:` | plain `Extra inputs are not permitted` (never existed as a top key) |
| top `subenv_scoreboards:` | `top-level key 'subenv_scoreboards:' is internal (set by the loader) and is not valid user configuration — cross-block scoreboards moved under `analysis.scoreboards` (same {name, source, monitor} shape; endpoints may be dotted leaf paths or a bare boundary-agent name).` |
| top `coverage_models:` | `…moved INTO analysis.coverage — a rich entry {agent, coverpoints, crosses, goal} declares the routing and the covergroup content in one place.` |
| top `reference_model:` | ``…moved ONTO the scoreboard it configures: `analysis: {scoreboards: [{name: sbd, source: <agent>, reference_model: {language: c}}]}` — the language governs one predict() body, never the bench.`` |
| top `agent_refs:` | ``…moved INTO `agents:` as reference entries — {name: <agent>, from_vip: <path to .qvip>} (an agent is declared OR referenced, in one list).`` |
| top `resets:` | ``…declare reset config under the top-level `reset:` key — a MAPPING for the single reset ({active_low, external}) or a LIST of domains (was `resets:`), mirroring `clock:`.`` |
| top `clocks:` | ``…declare multiple clocks as a LIST under `clock:`.`` |
| dut `external_reset:` / `reset_active_low:` | see §1.3 |
| agent `trans_style:` | `agent key 'trans_style:' was renamed to 'seq_item_style:' — update the config (the old key would otherwise be silently ignored).` |
| agent `transaction:` | `…renamed to 'sequence_item:' —…` |
| agent `count:` | `…renamed to 'replicas:' —…` |

---

## 2. Verdicts A1–A26 {#verdicts}

**A1 — CONFIRMED.** `dut: {name (req), clock: 'clk', reset: 'rst_n', combinational: false}`.
Combinational DUT: `combinational: true` (probe accepted; `reset: ''` disables
the reset port). Polarity/externality moved out (see A-reset row in §0).

**A2 — PARTLY WRONG.** `name`, `ports.{inputs,outputs,inouts}[] {name, width=1}`,
`active: true` default, `parameters:` — all confirmed. **WRONG**: `interface`
and `sequence_item` do NOT default from the agent name — both are required
(probe: `Field required`; even the README quickstart spells them out).

**A3 — CHANGED.** Scoreboards live at `analysis.scoreboards` (top-level
`scoreboards:` never validates). Shape confirmed (`source` req, `monitor`
optional ⇒ single-stream, `match` default `in_order`, `match_key` only with
`out_of_order` — wall confirmed verbatim) **plus** new: `max_latency` valid in
both modes, `window:`, per-scoreboard `reference_model:`, `name` default `sbd`.

**A4 — CONFIRMED**, with the step-validation rules quoted in §1.10.

**A5 — CONFIRMED.** Verbatim:
`` `subenvs` require `layout: packaged` (each child block is a reusable env package that the top composes). ``

**A6 — CONFIRMED.** `dict[str,int]` enforced by Pydantic (`int_parsing` error on
strings); undeclared-parameter wall quoted in §1.11.

**A7 — CONFIRMED** (diff-proven). No `analysis:` → env contains
`// Scoreboard (wired to primary agent: cmd)` + `duta_scoreboard sbd;` and
`cmd_cov cov;` with both connected. `analysis: {}` → neither is created;
comment reads `// Declared analysis connectivity (per analysis: block)`.
The extension's `keepAnalysis` rule stands.

**A8 — CONFIRMED.** `<agent>_cov.svh` is generated in both modes; `analysis`
controls only env wiring.

**A9 — WRONG NOW (was true at 0.9.2).** `agents` + `subenvs` is **accepted**:
top-level agents become *boundary agents* at the composition top (probe:
ACCEPTED; committed example family exists). The "hybrid is forbidden" hard
diagnostic must be removed; boundary agents can also be `connections` endpoints
and cross-block scoreboard endpoints (bare name).

**A10 — CONFIRMED.** Verbatim:
`a subsystem bench composes >=2 child block envs (declare at least two `subenvs`).`

**A11 — CONFIRMED + refined.** Distinct configs share a namespace. Two
distinct collision walls, both verbatim:

```
subenv 'u_c': block name 'blka' (dut.name) collides with another block or the top — each must be unique.
subenv 'u_d': agent name 'blka_a' collides with another block — composed blocks share a namespace, so agent names/interfaces/transactions/sequences must be unique across them.
```

Two subenvs → the **same** config file: OK and now **auto-namespaced** per
instance (`lo_blka_a_agent.svh`, `hi_…` — proven), controllable via
`subenvs[].namespace`.

**A12 — CONFIRMED.** A subenv whose config is itself a subsystem generates
(74-file probe). Each level needs ≥2.

**A13 — CONFIRMED.** Verbatim:
`subenv 'u_m': a composed clocked block must be single-clock (a nested multi-clock leaf is not supported yet).`

**A14 — CONFIRMED + additions.** Endpoint = `<subenv instance>.<port>`; output→
input; equal widths (wall quoted §1.11); single driver; destination agent must
be passive (wall quoted §1.11 — note it fires **per destination agent**, so
Architect's "passivate ALL owning agents" invariant remains right); physical
assign in tb_top (quoted). Additions: canonical keys are `src`/`dst` but
`from`/`to` still validate; boundary agents add a top-agent endpoint kind.

**A15 — CHANGED.** `subenv_scoreboards:` is gone (teaching error, §1.12). Same
`{name, source, monitor}` shape now lives in `analysis.scoreboards` with
`<subenv>.<agent>` dotted endpoints (agent-keyed, as before) or a bare
boundary-agent name. Cross-block scoreboard generation proven: emits
`<top-dut>_<name>_{scoreboard,predictor,comparator,reference_model}.svh`.

**A16 — CONFIRMED** for `connections` (absent ≡ `[]`, byte-identical, proven).
For cross-block scoreboards the container is now `analysis` — so the
**`keepAnalysis` rule applies to them too** (child list `scoreboards: []` may
be emptied; the `analysis` mapping itself must stay).

**A17 — CONFIRMED.** `width` default 1; no path-vs-width check; silent
truncation unchanged.

**A18 — CONFIRMED.** Proven output:
`assign probe_if.pp = dut_inst.u_core.state_q[3];` — path verbatim after
`dut_inst.`, never validated.

**A19 — CONFIRMED.** `probes: []` ≡ absent, byte-identical (proven). Safe to
clean up.

**A20 — CHANGED.** Still refused: probes+`subenvs` (new, clearer message —
§1.8), name collisions (clock/port/interface — §1.8), probes+`instances`
(§1.8). **No longer refused**: >1 clock domain (per-probe `clock:` selects the
sampling domain), and probes+`replicas` (generates cleanly).

**A21 — STILL BROKEN** (reproduced + compiled). `layout: packaged` + probe
`coverage: true`: `<dut>_probe_monitor.svh` is generated and `<dut>_env.svh`
references it, but no package includes it. Xcelium:

```
xmvlog: *E,NOIPRT (duta_env.svh,25|19): Unrecognized declaration 'duta_probe_monitor' of unknown type, …
```

(Flat layout is fine — `<dut>_tb_pkg.sv` includes it.) Keep the Architect
workaround (no probe `coverage` on packaged configs).

**A22 — STILL BROKEN** (reproduced). A leaf with probes composed as a subenv:
the subsystem generates `blkp_probe_if.sv`, but tb_top has **no** `probe_if`
instance/XMR/config_db and no filelist mentions it — generation exits 0.
Keep the composition-time warning. (Note the related **top-level** wall — probes
on the *composing* bench — is now fail-closed; only the *child-probe* case is
silent.)

**A23 — FIXED.** `struct` + coverage (bare `analysis.coverage` entry over an
agent with a struct port) generates and **compiles clean** (xrun, 0 errors).
Probe-side struct+`coverage: true` also validates and generates.

**A24 — WRONG NOW (headline).** All config classes are `extra="forbid"`.
Verbatim, top level:

```
x_quickuvm_architect
  Extra inputs are not permitted [type=extra_forbidden, input_value={'ignored_ports': []}, input_type=dict]
```

Same `extra_forbidden` at every nesting level (dut/agent/test/scoreboard —
all probed). **No escape hatch exists, by design — and none was added.**
**Resolution (QuickUVM v0.10.0)**: the one datum Architect stored under
`x_quickuvm_architect` was promoted to the first-class, validated key
`dut.unverified_ports` (§1.3). Architect's migration: repoint the five
readers/writers (`yamlops.ts`, `configcheck.ts`, `config.ts`, `quickuvm.ts`,
`webview/main.ts`) from `["x_quickuvm_architect","ignored_ports"]` to
`["dut","unverified_ports"]` and delete the `x_` pruning logic. Rule going
forward: verification intent → propose a real schema key; view state → the
sidecar. No `x_` middle bin.

**A25 — CONFIRMED.** Flat output contains `<dut>.sv` (a stub module definition
that would shadow the real RTL) and `.svh` sources requiring `uvm_macros.svh`.
Excluding `quickuvm.outputDir` from source globs remains mandatory. Also note
regeneration writes `<file>.bak` backups by default (more files in outputDir).

**A26 — CONFIRMED with one format change.** `quick-uvm generate -c <yaml>
-o <dir>`; nonzero exit on failure. Validation errors now arrive as
`Error: Invalid config: N validation error(s) for ProjectConfig` — i.e. both
patterns Architect greps (`Error:` and `N validation error(s) for
ProjectConfig`) **co-occur on one line** and still substring-match. Unicode
`→` on stdout confirmed (keep `PYTHONUTF8=1`). Full contract in [§5](#cli-contract).

---

## 3. Mode-switching inventory {#mode-switching}

What deletion mutations may clean up. "Proven" = byte-identical diff of
generated trees on this commit.

| key | absence vs empty | evidence | extension guidance |
|-----|------------------|----------|--------------------|
| `analysis:` | **absence ≠ presence** — absent auto-wires primary-agent scoreboard + coverage; present (even `{}`) wires only what's listed | env diff §2-A7 | **never delete the mapping**; empty only the child lists (`scoreboards: []`, `coverage: []`). Cross-block scoreboards now live here too. |
| `probes:` | `[]` ≡ absent | byte-identical | safe to clean up |
| `connections:` | `[]` ≡ absent | byte-identical | safe to clean up |
| `subenvs:` | `[]` ≡ absent (bench is flat/leaf) | byte-identical | safe to clean up (composition rules stop applying) |
| `tests:` | absent ⇒ **default `[{name: test1}]`**; `tests: []` ⇒ **zero tests** (accepted; generates only `<dut>_base_test.svh`, so the bench has nothing to run) | introspection + generate probe | the two are NOT the same mode. Deleting the last test should drop the whole `tests:` key (falling back to the runnable `test1`) and say so — writing `[]` silently yields a bench with no test |
| `virtual_sequences:` | absent + ≥2 agents + `auto_virtual_sequences: true` ⇒ an **auto** `<dut>_vseq` is generated and wired into tests | file-set diff §1.10 | deleting the last explicit vseq can *resurrect the auto vseq* (delete-something-get-more-back, same trap class as `analysis`). Offer `auto_virtual_sequences: false` alongside the deletion. |
| `auto_virtual_sequences:` | `true` is the default; `false` removes auto files + unwires test1 | file-set diff (`duo_base_vseq/vseq/virtual_sequencer` + env/tb_pkg/test1 differ) | value-level knob, no presence semantics |
| `regress:` | presence adds `Makefile` (+ enables `tests[].seeds`) | file-set diff | removing it orphans `tests[].seeds` → now a **validation error** (§1.9); remove the seeds too |
| `register_model:` | presence adds `reg_adapter.svh`, `<dut>_reg_test.svh` + env/test wiring | file-set diff | plain content key; safe to remove as a unit |
| `clock:` / `reset:` | **mapping vs LIST are different modes** even at length 1 (list engages multi-domain nets/clkgen; proven: `clkgen.sv`+`tb_top.sv` differ) | tree diff | never collapse a 1-element list to a mapping (or vice versa) as a "cleanup" |
| `layout:` / `kind:` / `top_name:` | plain value knobs | — | no presence semantics |

---

## 4. Composition rules (current) {#composition-rules}

1. `subenvs` ⇒ `layout: packaged` (wall, §2-A5).
2. **≥2 subenvs** per level (wall, §2-A10). Nesting OK; the ≥2 rule applies per
   level (§2-A12).
3. **Hybrid is legal (new)**: the top may declare its own `agents` (boundary
   agents). A pure subsystem (no agents) remains the common case; the container
   `dut` there is a combinational shell (`combinational: true, reset: ''`).
   Note: a synthetic top with a clocked `dut` and no boundary agents fails
   generation's phantom-clock self-check
   (`tb_top.sv: clock 'clk' is not connected to the DUT …` — a *generation-time*
   error, after validation).
4. **Namespace**: `dut.name`s unique across blocks and vs the top;
   agent/interface/transaction/sequence names unique across **distinct**
   configs (both walls verbatim in §2-A11). Same-config reuse is auto-namespaced
   per subenv instance.
5. **Params**: int-only, must name a declared parameter of a child agent
   (§1.11).
6. **Clocked leaves**: composed blocks must be single-clock (wall §2-A13); a
   clocked leaf gets pathname-prefixed clock/reset nets + its own clkgen in the
   flattened tb_top.
7. **Connections**: §1.11 (endpoints, direction, equal width, single driver,
   passive destination — all with quoted walls; `src`/`dst` canonical,
   `from`/`to` accepted).
8. **Cross-block scoreboards**: `analysis.scoreboards` with
   `<subenv>.<agent>` endpoints or bare boundary-agent names (§2-A15).
9. **Probes**: forbidden on the composing bench (wall §1.8); child probes are
   the A22 silent break — warn.

---

## 5. CLI contract {#cli-contract}

Commands: `generate`, `list`, `status`, `init`, `add-test` (click-based; `-h`,
`-V` global).

`generate` options: `-c/--config YAML` (required), `-o/--output DIR` (default:
`project.output_dir` or `./tb`), `--dry-run`, `--only FILENAME`,
`--allow-drop` (default **fail closed** when regeneration would orphan
user-pragma content), `--no-backup` (default writes `<file>.bak` before
overwriting).
`init` options: `-n/--name` (required), `-o/--output FILE`, `--dut MODULE`.
`list -c <yaml>`: template→output table, writes nothing.
`status -c <yaml> -o <dir>`: drift report (`Clean: every file matches the generator (no user edits, no drift).`).

Exit codes and streams (all captured live):

| case | exit | stream | verbatim shape |
|------|------|--------|----------------|
| success | 0 | stdout | `QuickUVM  0.9.2  →  <outdir>` then per-file `  [+]  <path>` (`[+]` new, other markers for overwrite/skip); stderr empty. Unicode `→` — keep `PYTHONUTF8=1`. |
| invalid config (Pydantic, N errors) | 1 | stderr | `Error: Invalid config: 2 validation errors for ProjectConfig` followed by the standard Pydantic per-error stanzas (`<loc>` line, `  Value error, …` / `  Extra inputs are not permitted …`, `    For further information visit https://errors.pydantic.dev/…`). Singular: `1 validation error`. |
| loader error (e.g. missing VIP manifest) | 1 | stderr | `Error: Invalid config: agent 'io': VIP manifest not found: <abs path>. Generate the VIP first (kind: vip).` (single line, no Pydantic stanza) |
| missing config file | 1 | stderr | `Error: Config file not found: nope.yaml` |
| bad flag / usage | 2 | stderr | click usage text (`Usage: quick-uvm generate [OPTIONS]` / `Try 'quick-uvm generate --help' for help.`) |

**Partially valid config: nothing is written.** Validation completes before any
file I/O; the output directory is not even created (proven).

Grep guidance: match `^Error: ` for any failure line; the substring
`validation error` + `for ProjectConfig` still identifies the Pydantic class of
failure. Teaching errors (renames/moves) arrive as ordinary Pydantic
`Value error, …` stanzas — their text is stable enough to power quick-fixes
(ledger in §1.12).

## 6. Generated-output structure {#generated-output}

All shapes proven by real generation on this commit. `<d>` = dut name, `<a>` =
agent name.

**Flat bench** (23 files for 1 agent): `clkgen.sv`, `<d>.sv` (**DUT stub — the
file to exclude**), `tb_top.sv`, `<a>_if.sv`, per-agent classes
(`<a>_{agent,cfg,cov,driver,monitor,seq,seq_item,sequencer}.svh`), bench
classes (`<d>_{base_test,comparator,env,env_cfg,predictor,reference_model,scoreboard}.svh`),
`test1.svh`, `<d>_tb_pkg.sv`, and filelists `pkg.f` + `run.f`. With ≥2 agents +
auto vseq: `<d>_{base_vseq,vseq,virtual_sequencer}.svh`. Explicit vseqs:
`<name>.svh`. RAL: `reg_adapter.svh`, `<d>_reg_test.svh`. Probes:
`<d>_probe_if.sv` (+ `<d>_probe_monitor.svh` with coverage). Regress:
`Makefile`.

**Packaged bench**: same classes but per-scope packages + chained filelists —
`<a>_pkg.sv` + `<a>_pkg.f` (self-compiling agent VIP), `<d>_env_pkg.sv` +
`<d>_env_pkg.f` (chains `-f <a>_pkg.f`), `<d>_test_pkg.sv` + `<d>_test_pkg.f`,
`run.f` (root). Filelists carry `+incdir+.`, relative paths, and *editable
pragma regions* for extra sources (`agent_pkg_extra_files`,
`env_pkg_extra_files`). Referenced VIPs are chained with **`-F`** (relative to
the consuming filelist) vs `-f` (relative to invocation).

**Subsystem** (2 leaf blocks: 50 files): per-block agent+env packages
(`<blk>_a_pkg.*`, `<blk>_env_pkg.*`, `<blk>_if.sv`), one flattened `tb_top.sv`
instantiating all leaf DUT stubs, top test package, `run.f`. Shared-config
subenvs prefix everything per instance (`lo_*`/`hi_*`). Cross-block
scoreboards: `<top>_<sb>_{scoreboard,predictor,comparator,reference_model}.svh`.

**VIP** (`kind: vip`): agent package only + **`<name>.qvip` manifest** — no tb,
no test, no DUT stub. **Selftest** (`kind: selftest`): loopback bench — tb_top +
env/test packages, **no DUT stub** (nothing to exclude but the tb itself).

To exclude from a real-design compile: the whole output dir (stub `<d>.sv`,
`uvm_macros.svh` dependencies, plus `.bak` backup copies regeneration leaves by
default). User code lives in `// pragma quickuvm custom <name> begin/end`
regions preserved across regens; a regen that would orphan such a region
**fails closed** unless `--allow-drop`.

## 7. Minimal examples {#examples}

All four valid examples generated cleanly on this commit via
`quick-uvm generate -c <file> -o <tmp>` (exit 0).

**(a) Leaf bench — 2 agents, two-stream scoreboard, rich coverage entry:**

```yaml
project: {name: duo_tb}
dut: {name: duo, clock: clk, reset: rst_n}
agents:
  - name: cmd
    interface: cmd_if
    sequence_item: cmd_seq_item
    ports:
      inputs:  [{name: cmd_i, width: 8}]
      outputs: [{name: cmd_o, width: 8}]
  - name: rsp
    interface: rsp_if
    sequence_item: rsp_seq_item
    active: false
    ports:
      inputs: [{name: rsp_i, width: 8}]
analysis:
  scoreboards:
    - {name: sbd, source: cmd, monitor: rsp, match: out_of_order, match_key: cmd_i}
  coverage:
    - agent: cmd
      coverpoints:
        - field: cmd_i
          bins: [{name: low, range: [0, 127]}, {name: high, range: [128, 255]}]
```

**(b) Pure subsystem — 2 subenvs + connection + cross-block scoreboard:**

```yaml
project: {name: top_tb}
layout: packaged
dut: {name: sys, combinational: true, reset: ''}
subenvs:
  - {name: u_a,  config: ../blk_a/a.yaml}    # active leaf
  - {name: u_bp, config: ../blk_bp/bp.yaml}  # its agent: active: false
connections:
  - {src: u_a.blka_out, dst: u_bp.bp_in}
analysis:
  scoreboards:
    - {name: xsb, source: u_a.blka_a, monitor: u_bp.blkbp_a}
```

**(c) Probes bench:**

```yaml
project: {name: duta_tb}
dut: {name: duta, clock: clk, reset: rst_n}
agents:
  - name: cmd
    interface: cmd_if
    sequence_item: cmd_seq_item
    ports:
      inputs:  [{name: creq, width: 8}]
      outputs: [{name: cack, width: 8}]
probes:
  - {name: pp, path: u_core.state_q[3], width: 4}
```

**(d) Modern grammar in one place — `reset:` union + VIP reference:**

```yaml
project: {name: con_tb}
dut: {name: con, clock: clk, reset: rst_n}
reset: {active_low: true, external: false}
agents:
  - name: io                                # consumed BY REFERENCE from a VIP
    from_vip: ../f2_iovip/gen/f2_iovip.qvip
  - name: local
    interface: local_if
    sequence_item: local_seq_item
    ports: {inputs: [{name: l_i, width: 4}]}
```

Three invalid examples with their exact stderr (each `exit 1`):

1. `x_quickuvm_architect: {…}` + `clock: {period: 0}` →
   `Error: Invalid config: 2 validation errors for ProjectConfig` then the two
   stanzas quoted in §5 (multi-error format).
2. Top-level `resets: [{name: rst_n}]` →
   `Error: Invalid config: 1 validation error for ProjectConfig` + the `resets:`
   teaching stanza (§1.12).
3. `agents: [{name: io, from_vip: ../nope/nope.qvip}]` →
   `Error: Invalid config: agent 'io': VIP manifest not found: … Generate the VIP first (kind: vip).`

## 8. Changelog vs 0.9.2-as-probed {#changelog}

**Breaking** (rejects formerly-accepted input): unknown keys forbidden
everywhere incl. `x_*` (A24); reset grammar moved (`resets:`,
`dut.external_reset`, `dut.reset_active_low` → `reset:` union); renames
`trans_style`/`transaction`/`count`/`agent_refs`/`coverage_models`/top
`reference_model`/`subenv_scoreboards` (ledger §1.12); new value walls —
`period >= 1`, unit whitelist, `drive_offset_pct` bounds, `max_latency >= 1`,
`tests[].seeds` requires `regress:`, RAL `bus_agent` must be an initiator,
respond-knobs invalid on initiators, vseq steps validated against sequence
libraries.

**Behavioral**: hybrid composition legal (boundary agents, A9); probes ×
multi-clock and × replicas now allowed (A20); `max_latency` on `in_order`
(A3); struct+coverage fixed (A23); generation-time self-checks — phantom-clock
guard (§4), pragma-orphan fail-closed (`--allow-drop`); generated runtime
guards the extension may want to surface from logs: `UNCHECKED_AGENT`
(uvm_warning: driven-but-unscoreboarded agent), `DEAD_RESPONDER` /
`STRANDED_REQUESTS` / request-drain liveness (responder benches),
`SB_LATENCY`, `SB_LEFTOVER`.

**Additive** (new keys since Architect's probe): agent — `mode: responder`,
`respond:` (`on_request`/`prefetch`/`combinational`/`pipelined`),
`request_valid`, `request_ready`, `reorder_by`, `reorder_policy`,
`proactive`, `idle`, `replicas`, `instances`+`parameters` refinements,
`inouts` ports (`open_drain`/`pullup`), rich port types
(`enum`/`type`/`packed_dims`/`struct`/`constraint`), per-agent
`clock`/`reset`; top — `reset:` union, `clock:` list (multi-clock),
`kind: vip|selftest`, `top_name`, `regress:`, `auto_vseq_mode`; analysis —
rich coverage entries, `window:`, per-scoreboard `reference_model:
{language: c}`; probes — `clock`, `real`, `enum`/`struct` types;
register_model — `coverage: true` (RAL-driven register coverage),
`reg_test_door`, `frontdoor`; subenv — `namespace`.

## Open questions / unverified {#open-questions--unverified}

- ~~The `x_quickuvm_architect` break needs a product decision~~ **Decided and
  shipped (v0.10.0)**: `dut.unverified_ports` is the first-class replacement
  (§1.3, §2-A24); the Architect-side repoint is the remaining work.
- Marker legend of `generate` stdout beyond `[+]` (overwrite/skip markers) not
  exhaustively enumerated — parse leniently (`^\s+\[.\]\s+`).
- `probes` + `replicas` generates, but the probe/replica interaction at
  simulation runtime was not exercised (compile/elab not run for that shape).
- Windows-specific CLI behavior (script location, cp1252) not re-verified from
  this Linux environment; the `PYTHONUTF8=1` need is confirmed by the `→` on
  stdout.
- The exhaustive list of all ~245 validator messages is not reproduced here;
  the format contract (§5) covers how any of them reaches the extension.
