# Upstream note for QuickUVM — `resolve` reports inferred components that `generate` does not produce

*Written from QuickUVM Architect's side; observed on quick-uvm 1.2.0, Nov 2026.
Filed upstream on 28 Nov 2026 as [arcadie-cracan/QuickUVM#121](https://github.com/arcadie-cracan/QuickUVM/issues/121);
the issue's text is at the end of this note. Open at the time of writing.*

## Summary

`quick-uvm resolve` says what a configuration *means*: the effective topology,
with `origin: inferred` on what the generator supplies. For a bench without an
`analysis:` key it reports a scoreboard `sbd` and a coverage collector, both on
the first agent.

It reports them for **every** bench that has an agent and no `analysis:`. On
three shapes the generator produces neither — and **refuses both** once they
are written into the configuration:

| shape | `resolve` reports | `generate`, as written | `generate`, with the reported set declared |
|---|---|---|---|
| a plain bench (control) | `sbd` + coverage on `cmd` | env declares `sbd` and `cov` | exit 0 |
| `replicas: 3` on the agent | `sbd` + coverage on `cmd` | env declares neither | **refused**: "`replicas` (agent 'cmd') does not yet wire coverage" |
| `kind: vip` | `sbd` + coverage on `cmd` | no env is generated at all | **refused**: "these sections would be silently dropped from the output" |
| a composition (`subenvs`) with a boundary agent | `sbd` + coverage on `topcmd` | the top env declares neither | **refused**: "a `subenvs` top does not wire `analysis.coverage`" |

So on those shapes the answer to "what will I get" is wrong, and the answer is
not even a configuration the generator accepts.

(An agent with `instances` takes the same env branch as `replicas` — by reading
the template; not reproduced here, the fixture needs `parameters`. A pure
subsystem top, with no agent, is reported correctly: nothing.)

## Minimal reproduction

```yaml
# replicas.quickuvm.yaml
project: {name: buf}
clock: {period: 10, unit: ns}
dut: {name: buf, clock: clk, reset: rst_n}
reset: {external: true}
agents:
  - name: cmd
    interface: cmd_if
    sequence_item: cmd_seq_item
    replicas: 3
    ports:
      inputs: [{name: d, width: 8}]
      outputs: [{name: q, width: 8, randomize: false}]
```

```
$ quick-uvm resolve -c replicas.quickuvm.yaml
  "analysis": {
    "mode": "implicit",
    "scoreboards": [{"name": "sbd", "source": "cmd", "origin": "inferred"}],
    "coverage": [{"agent": "cmd", "origin": "inferred"}]
  }

$ quick-uvm generate -c replicas.quickuvm.yaml -o tb      # exit 0
$ grep -E "_scoreboard +sbd;|_cov.* cov;" tb/buf_env.svh  # nothing
```

Append what `resolve` reported —

```yaml
analysis:
  scoreboards: [{name: sbd, source: cmd}]
  coverage: [cmd]
```

— and `generate` exits 1:

```
Value error, `replicas` (agent 'cmd') does not yet wire coverage — the
per-instance env path omits the collectors (declare it on a non-count bench
for now).
```

Remove `replicas: 3` and all three steps agree: the env declares
`buf_scoreboard sbd;` and `cmd_cov cov;`, and the declared form generates.

The four cases of the table are scripted in one file that needs only quick-uvm
(kept with the Architect session's tools as `upstream-repro.py`).

## The cause

`ProjectConfig.resolved()` (`quick_uvm/models.py`) mirrors ONE of the three
branches of `env.svh.j2`, unconditionally:

```python
elif primary is not None:
    # the `{% else %}` branch of env.svh.j2: one scoreboard literally named
    # `sbd`, plus `cov`, both on the primary agent
    scoreboards = [{"name": "sbd", "source": primary, "origin": "inferred"}]
    coverage = [{"agent": primary, "origin": "inferred"}]
```

but the template reaches that `{% else %}` only when the two branches before it
do not apply, and two whole paths never render it:

- `env.svh.j2`: `{% if has_instances %}` (replicas / instances — per-instance
  scoreboards, no collector) → `{% elif analysis %}` → `{% else %}` (the
  implicit pair). `has_instances` is `bool(cfg.instance_views)`.
- a composition renders `subenv_top_env.svh.j2`, which has no implicit branch;
- `kind: vip` emits agent packages and a manifest, no env.

The sibling property `uncovered_agents`, a few lines above, already knows one
of them: it returns `[]` when `self.subenvs`.

## Suggested fix

Gate the inferred branch of `resolved()` on the conditions under which the
implicit pair is really rendered:

```python
elif primary is not None and not self.subenvs and not self.is_vip and not self.instance_views:
```

and say what IS generated instead where that is knowable — for a replicated
agent, the per-instance scoreboards are real components nobody declared
(`origin: inferred` fits them). A test per shape in `test_resolved_config.py`
that compares the reported set with the generated env would keep the two from
drifting again: the property the command exists for is that the two agree.

## Why it matters to a consumer

`resolve` was added so that a consumer can draw and act on inferred components
"without reimplementing these rules" (the method's own docstring). QuickUVM
Architect did exactly that, and on these shapes:

- drew ghost boxes for components that are not in the bench;
- offered to *materialise* them — to write them into `analysis:` — producing a
  configuration `generate` refuses;
- and, when its add-scoreboard / add-coverage gestures learned to keep the
  inferred set (Architect #84), kept it there too, turning benches that
  generated into benches that do not.

## What Architect does meanwhile

`inferenceIsReal(config)` in `src/resolved.ts` fences the three shapes
(`subenvs` non-empty, `kind: vip`, an agent with `replicas` > 1 or
`instances`): no ghost, no materialise offer, and the plain add gesture. It is
the one place the extension knows something about *where* inference happens —
the kind of knowledge `resolve` was meant to make unnecessary.

`test:e2e` scenario 17 locks each shape with four legs against the generator
(what resolve answers · the bench as written generates without the components
· the plain gesture generates · the pair 1.2.0 reported, declared, is refused
with that shape's message). The second leg accepts both answers — the
over-report, or nothing inferred — and the suite's last line says which
generator it met.

The fence does NOT go when the fix is released: quick-uvm 1.2.0 and older keep
over-reporting, and Architect supports them. It is needed there and harmless
on a fixed generator (which reports nothing on these shapes anyway). It can be
deleted — with the callers that pass the live config to `inferredComponents`
for its sake — only when the minimum supported quick-uvm is one with the fix.

---

## The issue, as filed

**Title:** `resolve` reports an inferred scoreboard and collector on benches where `generate` produces neither (replicas, `kind: vip`, compositions)

**Body:**

`quick-uvm resolve` reports `sbd` and a coverage collector on the first agent, `origin: inferred`, for every bench that has an agent and no `analysis:` key. On three shapes `generate` produces neither, and refuses both once they are declared — so the resolved view is not what the bench is, and is not even a configuration the generator accepts. Seen on 1.2.0.

| shape | `resolve` reports | `generate`, as written | `generate`, with the reported set declared |
|---|---|---|---|
| a plain bench (control) | `sbd` + coverage on `cmd` | env declares `sbd` and `cov` | exit 0 |
| `replicas: 3` | `sbd` + coverage on `cmd` | env declares neither | refused: "`replicas` (agent 'cmd') does not yet wire coverage" |
| `kind: vip` | `sbd` + coverage on `cmd` | no env generated | refused: "these sections would be silently dropped from the output" |
| `subenvs` + a boundary agent | `sbd` + coverage on `topcmd` | the top env declares neither | refused: "a `subenvs` top does not wire `analysis.coverage`" |

**Reproduce** (the smallest of the three):

```yaml
project: {name: buf}
clock: {period: 10, unit: ns}
dut: {name: buf, clock: clk, reset: rst_n}
reset: {external: true}
agents:
  - name: cmd
    interface: cmd_if
    sequence_item: cmd_seq_item
    replicas: 3
    ports:
      inputs: [{name: d, width: 8}]
      outputs: [{name: q, width: 8, randomize: false}]
```

1. `quick-uvm resolve -c f.yaml` → `analysis.mode: implicit`, `scoreboards: [{name: sbd, source: cmd, origin: inferred}]`, `coverage: [{agent: cmd, origin: inferred}]`.
2. `quick-uvm generate -c f.yaml -o tb` → exit 0; `tb/buf_env.svh` declares no `sbd` and no `cov`.
3. Append `analysis: {scoreboards: [{name: sbd, source: cmd}], coverage: [cmd]}` → `generate` exits 1: "`replicas` (agent 'cmd') does not yet wire coverage".

Without `replicas: 3` all three agree.

**Cause.** `ProjectConfig.resolved()` mirrors the `{% else %}` branch of `env.svh.j2` whenever `analysis` is absent and there is an agent. The template reaches that branch only after `{% if has_instances %}` (replicas / instances) and `{% elif analysis %}`; a composition renders `subenv_top_env.svh.j2`, which has no implicit branch; `kind: vip` emits no env. `uncovered_agents`, just above, already returns `[]` for `self.subenvs`.

**Suggested fix.** Gate the inferred branch on the conditions under which the pair is rendered — `not self.subenvs and not self.is_vip and not self.instance_views` — and, where it is knowable, report what is generated instead (the per-instance scoreboards of a replicated agent are real, undeclared components). A test per shape comparing the reported set with the generated env would keep `resolved()` and the templates from drifting: that agreement is what the command is for.

**Impact.** A consumer that trusts `resolve` — QuickUVM Architect draws the inferred components and can write them into `analysis:` — shows components that do not exist and produces configurations `generate` refuses. Architect fences the three shapes on its side until this is fixed.
