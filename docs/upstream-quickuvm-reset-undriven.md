# Upstream note for QuickUVM — `generate` exits 0 with a reset nobody wires

Two gaps, the same family: a config that validates, generates with exit 0, and
yields a bench that cannot run because of how the reset is (not) connected.
**1** is the one that broke real benches; **2** was found while fixing 1.

# 1. A dangling reset reference

*A report to file against [QuickUVM](https://github.com/arcadie-cracan/QuickUVM);
written from QuickUVM Architect's side, not filed. Observed on quick-uvm 1.1.0,
Nov 2026.*

## Summary

When `dut.reset` names a port that **no agent declares** and the single-reset
mapping is **not** `external: true`, `quick-uvm generate` exits 0 and emits a
`tb_top.sv` that connects the DUT's reset to a signal of the first agent's
interface — a signal that interface does not declare. The bench does not
elaborate.

`dut.reset` defaults to `rst_n` and `reset.external` defaults to `false`, so
this is also what a config that says nothing about the reset gets.

## Minimal reproduction

```yaml
project: {name: demo}
dut: {name: demo, clock: clk, reset: rst_n}
agents:
  - name: a
    interface: a_if
    sequence_item: a_item
    ports:
      inputs: [{name: din, width: 8}]
```

```
$ quick-uvm generate -c demo.yaml -o tb ; echo $?
0
```

`tb/tb_top.sv`:

```systemverilog
  a_if a_if_inst (clk);

  demo dut_inst (
    .din(a_if_inst.din),
    .clk(clk),
    .rst_n(a_if_inst.rst_n)  );      // <-- no such signal
```

`tb/a_if.sv` — `rst_n` appears nowhere in the file:

```systemverilog
interface a_if (input clk);
  logic [7:0] din;
  ...
```

Xcelium 25.09, on the same shape with two agents (`cmd`, `rsp`):

```
    .rst_n(cmd_if_inst.rst_n)  );
xmelab: *E,CUVUNF (../tb/tb_top.sv,35|27): Hierarchical name component lookup
failed for 'rst_n' at 'tb_top'.
```

## What the neighbouring shapes do (same bench, one change each)

| change | result |
|---|---|
| `reset: {external: true}` | `logic rst_n;` + the generated `reset_generator` block in `tb_top`, interfaces `(input clk, input rst_n)` — elaborates and runs |
| `rst_n` added to an agent's `ports.inputs` | the interface declares `logic rst_n`, the driver drives it from the sequence item — consistent |
| `reset: [{name: rst_n}]` (a list) | per-domain net + generator in `tb_top` — consistent |
| `reset: {external: true}` **and** `rst_n` in an agent's ports | refused: *"An external reset must not also be an agent port"* |
| `dut.reset: ''` | no reset connection — consistent |

So the validator already knows the rule from the other side (external **and**
an agent port is an error); the complementary case — **neither** — is the one
that passes.

## A second, quieter instance: composition

A clocked leaf whose own config is in this state (reset named, not external, no
agent port), composed as a `subenvs` child: the subsystem `tb_top.sv`
instantiates the leaf DUT with its clock and **no reset connection at all**
(`la u_a_dut (.dout(...), .din(...), .clk(u_a_clk));`). No dangling reference,
so it elaborates — with the leaf's reset port floating. With
`reset: {external: true}` on the leaf, the top declares, drives and connects
`u_a_rst_n`.

A combinational DUT with a reset name (`combinational: true, reset: rst_n`)
likewise gets no reset connection; `external: true` is refused there
(*"a combinational DUT has no reset"*), which is consistent, but the named port
is silently dropped rather than reported.

The same reference dangles with an agent that uses `reset_port: arst` and a
`dut.reset` left at its default: the top connects `.arst(a_if_inst.arst)` **and**
`.rst_n(a_if_inst.rst_n)`. `dut.reset: ''` (or `dut.reset: arst`) is clean, and
`external: true` is refused there (*"reset_port is an AGENT-DRIVEN reset…"*) —
so with `reset_port` the default `dut.reset` is itself the trap.

## Suggested fix

A model validator, the mirror of the existing "external reset must not also be
an agent port" one: for a non-combinational bench with a single-reset mapping
and at least one declared (non-`from_vip`) agent, if `dut.reset` is non-empty,
`reset.external` is false and no agent declares a port of that name, raise —
for example:

> dut.reset 'rst_n' is driven by nobody: no agent declares it as a port and
> `reset: {external: true}` is not set. Either set `reset: {external: true}`
> (the testbench top generates the reset), add 'rst_n' to an agent's
> `ports.inputs` (that agent drives it), or set `dut.reset: ''` if the DUT has
> no reset port.

Alternatively, make the top-driven reset the behaviour of this shape (treat
"no agent declares the reset port" as `external: true`), which would also make
the default config elaborate; that changes generated output for existing
configs, so the validator is the conservative option.

For composition, the same check applied to each clocked leaf config would turn
the floating reset port into an error at the top's `generate`.

# 2. `kind: selftest` + `reset: {external: true}` — exit 0, and the bench hangs

```yaml
project: {name: demo}
kind: selftest
layout: packaged
reset: {external: true}
dut: {name: demo, clock: clk, reset: rst_n}
agents:
  - name: a
    interface: a_if
    sequence_item: a_item
    ports:
      inputs: [{name: din, width: 8}]
      outputs: [{name: dout, width: 8, randomize: false}]
```

`quick-uvm generate` exits 0. The generated selftest top has no DUT and no reset
net, and instantiates the interface with the clock only:

```systemverilog
  a_if a_if_inst (clk);
```

while `external: true` made the interface take the reset and the driver and
monitor wait for it:

```systemverilog
interface a_if (input clk, input rst_n);          // a_if.sv
    wait (vif.rst_n === 1'b1);                    // a_driver.svh, a_monitor.svh
```

`rst_n` is an unconnected input, so the wait never ends. (Read in the generated
text; not simulated.) Without `external: true` the same selftest has no reset
anywhere and is consistent.

Suggested fix: either refuse `kind: selftest` + `reset: {external: true}`, or
give the selftest top the same `logic rst_n` + `reset_generator` block a bench
top gets and pass it to the interfaces. The second also covers a VIP built with
`external: true` (its interfaces take `rst_n`) being self-tested as it is.

A related consistency point, not a bug in one file: a `kind: vip` built without
`external: true` has interfaces `(input clk)`, and a bench that consumes it by
reference with `external: true` instantiates them `(.clk(clk), .rst_n(rst_n))` —
nothing checks that the two agree.

## Also worth a line in the docs

`reset.external` reads as "the reset comes from outside the testbench" — which
is how QuickUVM Architect's own reference documented it ("the TB does not
generate the reset; the environment/DUT drives it") until the generated code
was read. It means *external to the agents*: `true` is the shape in which
`tb_top` **does** generate the reset.

## What Architect does meanwhile

- `setDut` writes `reset: {external: true}` whenever the DUT has a reset port
  that no agent declares (decision D25, `docs/06-plan-mvp.md`);
- existing configs get a `reset-undriven` error with a one-click repair
  (`external: true`, or `dut.reset: ''` where the top cannot drive the reset);
- a `kind: selftest` bench never carries `external: true` (the kind switch
  drops it);
- `npm run test:e2e` lints every generated top (each signal connected to a DUT
  port must be declared in the top or in the interface it is taken from), and
  keeps the reproduction above as a mutation proof — when a quick-uvm release
  refuses the config, that test reports it as fixed upstream.
