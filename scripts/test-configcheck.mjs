// Node tests for the PURE core of the model<->YAML validations
// (src/configcheck.ts): npm run test:configcheck
// The stake: emitting the diagnostics was completely untested — a regression here
// SILENTLY turns off the validation feedback in the editor (including the hard error
// that the generator refuses only at `generate`). NOTE 1.0: the subenvs+agents
// hybrid is LEGAL (H2 boundary agents) — the test checks the absence.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
// the same `yaml` instance from node_modules; node identity is on
// Symbol.for (global), so parseDocument from here + isMap from the bundle coexist
import { parseDocument } from "yaml";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-configcheck-"));
const outFile = join(outDir, "configcheck.mjs");
await esbuild.build({
  entryPoints: ["src/configcheck.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const { checkConfig, undrivenReset, RESET_CODE, WIDTH_CODE } = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

/** runs checkConfig on a YAML text + a minimal model */
function check(text, model) {
  const ydoc = parseDocument(text);
  return { ...checkConfig(ydoc, ydoc.toJS() ?? {}, model), text };
}

const MODEL = {
  modules: {
    soc_top: {
      ports: [
        { name: "clk", width: 1 },
        { name: "din", width: 8 },
        { name: "dout", width: 16 },
      ],
    },
  },
};

// The fixtures below say `reset: ''` on purpose: an ABSENT dut.reset is the
// generator's default `rst_n`, and MODEL's soc_top has no such port — which is the
// `reset-undriven` finding (its own tests are at the end of this file).
const kinds = (r) => r.findings.map((f) => f.kind);

test("clean config: zero findings, zero orphans", () => {
  const r = check(
    `dut: { name: soc_top, clock: clk, reset: '' }
agents:
  - name: a
    ports:
      inputs: [ { name: din, width: 8 } ]
`,
    MODEL
  );
  assert.deepEqual(kinds(r), []);
  assert.deepEqual(r.orphans, []);
});

test("hybrid subenvs + agents (H2 boundary agents): NO diagnostic", () => {
  const r = check(
    `dut: { name: top, reset: '' }
subenvs:
  - { name: u_a, config: a.quickuvm.yaml }
  - { name: u_b, config: b.quickuvm.yaml }
agents:
  - name: cmd
`,
    undefined
  );
  // quick-uvm >= 1.0.0 ACCEPTS composition with own agents at top
  assert.ok(!r.findings.some((f) => f.kind === "hybrid"),
    "the 'hybrid' diagnostic no longer exists (1.0: boundary agents are legal)");
});

test("wrong width: a warning with the quick-fix's code", () => {
  const r = check(
    `dut: { name: soc_top, reset: '' }
agents:
  - name: a
    ports:
      inputs: [ { name: din, width: 16 } ]
`,
    MODEL
  );
  const w = r.findings.find((f) => f.kind === "width-mismatch");
  assert.ok(w, "width-mismatch is missing");
  assert.equal(w.severity, "warning");
  assert.equal(w.code, `${WIDTH_CODE}:a:din:8`);
  // `agent` entered params for the status decorations (src/status.ts)
  assert.deepEqual(w.params, { port: "din", declared: 16, expected: 8, agent: "a" });
  // the span falls on the port entry
  assert.match(r.text.slice(w.span[0], w.span[1]), /din/);
});

test("default width: no width in the YAML means 1 (a mismatch on din=8)", () => {
  const r = check(
    `dut: { name: soc_top, reset: '' }
agents:
  - name: a
    ports:
      inputs: [ { name: din } ]
`,
    MODEL
  );
  const w = r.findings.find((f) => f.kind === "width-mismatch");
  assert.equal(w?.params.declared, 1);
  assert.equal(w?.params.expected, 8);
});

test("a port claimed by two agents: an ERROR on the second", () => {
  const r = check(
    `dut: { name: soc_top, reset: '' }
agents:
  - name: a
    ports:
      inputs: [ { name: din, width: 8 } ]
  - name: b
    ports:
      inputs: [ { name: din, width: 8 } ]
`,
    MODEL
  );
  const c = r.findings.find((f) => f.kind === "port-claimed");
  assert.ok(c, "port-claimed is missing");
  assert.equal(c.severity, "error");
  assert.deepEqual(c.params, { port: "din", agent: "a" });
});

test("a port gone from the model: warning + orphan (graceful invalidation)", () => {
  const r = check(
    `dut: { name: soc_top, reset: '' }
agents:
  - name: a
    ports:
      inputs: [ { name: gone, width: 4 } ]
`,
    MODEL
  );
  const o = r.findings.find((f) => f.kind === "port-orphan");
  assert.ok(o);
  assert.equal(o.severity, "warning");
  assert.deepEqual(r.orphans, ["gone"]);
});

test("waived + mapped: an ERROR on dut.unverified_ports (the 1.0 wall)", () => {
  const r = check(
    `dut: { name: soc_top, reset: '', unverified_ports: [ din ] }
agents:
  - name: a
    ports:
      inputs: [ { name: din, width: 8 } ]
`,
    MODEL
  );
  const i = r.findings.find((f) => f.kind === "ignored-and-mapped");
  assert.ok(i);
  // quick-uvm 1.0 REFUSES at generate ("connected by agent ... Remove it from
  // one side") -> the diagnostic replicates the wall with error severity
  assert.equal(i.severity, "error");
  assert.deepEqual(i.params, { port: "din", agent: "a" });
});

test("a dut that does not exist in the model: warning; without a model, silence", () => {
  // (`reset: ''`: the reset rule is YAML-internal and has its own tests below)
  const r = check(`dut: { name: nope, reset: '' }\n`, MODEL);
  assert.deepEqual(kinds(r), ["dut-missing"]);
  const noModel = check(`dut: { name: nope, reset: '' }\n`, undefined);
  assert.deepEqual(kinds(noModel), []);
});

// --- docs/08 R3: analysis endpoints that name no agent --------------------------
test("R3: scoreboard source/monitor and coverage naming an unknown agent are errors", () => {
  const r = check(
    `dut: { name: soc_top, reset: '' }
agents:
  - name: a
    ports:
      inputs: [ { name: din, width: 8 } ]
analysis:
  scoreboards:
    - { name: sbd, source: a, monitor: ghost }
    - { name: x, source: blk.p, monitor: blk.q }
  coverage: [ a, { agent: nobody, coverpoints: [] } ]
subenvs: [ { name: blk, config: blk.quickuvm.yaml } ]
`,
    MODEL
  );
  const sb = r.findings.filter((f) => f.kind === "sb-unknown-agent");
  assert.equal(sb.length, 1, "the cross-block scoreboard (blk.p / blk.q) is NOT checked here");
  assert.equal(sb[0].severity, "error");
  assert.deepEqual(sb[0].params, { sb: "sbd", field: "monitor", agent: "ghost", named: 1, node: "sbd" });
  assert.ok(sb[0].span, "the span points at the offending entry");
  const cov = r.findings.filter((f) => f.kind === "cov-unknown-agent");
  assert.equal(cov.length, 1, "the plain `a` entry is fine, the rich `nobody` one is not");
  assert.deepEqual(cov[0].params, { agent: "nobody" });
  assert.equal(cov[0].severity, "error");
});

test("R3: no finding when every endpoint names a declared agent; works without a model", () => {
  const text = `dut: { name: soc_top, reset: '' }
agents:
  - { name: a, ports: { inputs: [ { name: din, width: 8 } ] } }
  - { name: b, ports: { outputs: [ { name: sum, width: 8 } ] } }
analysis:
  scoreboards: [ { name: sbd, source: a, monitor: b } ]
  coverage: [ b ]
`;
  assert.deepEqual(kinds(check(text, MODEL)).filter((k) => /unknown/.test(k)), []);
  const noModel = check(text.replace("monitor: b", "monitor: zz"), undefined);
  assert.deepEqual(kinds(noModel), ["sb-unknown-agent"], "a YAML-internal rule, model or not");
});

test("R3 (review): an UNNAMED scoreboard is reported as un-named, with the diagram id of its box", () => {
  const r = check(
    `dut: { name: soc_top, reset: '' }
agents:
  - { name: a, ports: { inputs: [ { name: din, width: 8 } ] } }
analysis:
  scoreboards:
    - { name: sbd, source: a }
    - { source: ghost }
    - { monitor: ghost }
`,
    MODEL
  );
  const f = r.findings.filter((x) => x.kind === "sb-unknown-agent");
  assert.equal(f.length, 2);
  // #2 is unnamed: drawn as the SECOND `sbd` -> `sb:sbd#2`; a by-name delete must not be offered
  assert.deepEqual(f[0].params, { sb: "sbd", field: "source", agent: "ghost", named: 0, node: "sbd#2" });
  // #3 has no source: not drawn at all (no `node`), still reported
  assert.deepEqual(f[1].params, { sb: "sbd", field: "monitor", agent: "ghost", named: 0 });
});

// --- reset-undriven (Nov 2026): the tutorial bench did not elaborate. quick-uvm
// 1.1.0 wires the DUT's reset to `<first agent>_if_inst.<reset>` unless the
// single-reset mapping is `external: true` or an agent declares the port — and
// validates none of it (exit 0). Every shape below was generated and inspected.

const RST_MODEL = {
  modules: {
    buf: {
      ports: [
        { name: "clk", width: 1 },
        { name: "rst_n", width: 1 },
        { name: "din", width: 8 },
      ],
    },
  },
};
const AGENT = `agents:
  - name: cmd
    ports:
      inputs: [ { name: din, width: 8 } ]
`;
const undriven = (r) => r.findings.filter((f) => f.kind === "reset-undriven");

test("reset-undriven: the OLD Architect shape (dut.reset set, nobody drives it) is an error with a fix", () => {
  const r = check(`dut: { name: buf, clock: clk, reset: rst_n }\n${AGENT}`, RST_MODEL);
  const f = undriven(r);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "error", "the bench does not elaborate");
  assert.deepEqual(f[0].params, { port: "rst_n", repair: "external" });
  assert.equal(f[0].code, `${RESET_CODE}:external:rst_n`, "the quick-fix reads repair + port from the code");
  // the span is the `dut.reset` VALUE — where the Problems entry lands
  assert.equal(r.text.slice(f[0].span[0], f[0].span[1]), "rst_n");
  // a YAML-internal rule: the same without a model, and with zero agents yet
  assert.equal(undriven(check(`dut: { name: buf, reset: rst_n }\n${AGENT}`, undefined)).length, 1);
  assert.equal(undriven(check(`dut: { name: buf, reset: rst_n }\n`, RST_MODEL)).length, 1);
  // polarity alone does not drive anything
  assert.equal(
    undriven(check(`dut: { name: buf, reset: rst_n }\nreset: { active_low: false }\n${AGENT}`, RST_MODEL)).length,
    1
  );
});

test("reset-undriven: the three driven shapes are clean", () => {
  // 1. the testbench top drives it — what setDut writes now
  assert.deepEqual(
    kinds(check(`dut: { name: buf, clock: clk, reset: rst_n }\nreset: { external: true }\n${AGENT}`, RST_MODEL)),
    []
  );
  // 2. an agent declares the port, on any side (the interface then has the signal)
  for (const side of ["inputs", "outputs", "inouts"]) {
    const r = check(
      `dut: { name: buf, reset: rst_n }
agents:
  - name: cmd
    ports:
      inputs: [ { name: din, width: 8 } ]
  - name: rsp
    ports:
      ${side}: [ { name: rst_n } ]
`,
      RST_MODEL
    );
    assert.deepEqual(undriven(r), [], `declared in a NON-primary agent's ${side}`);
  }
  // 3. a reset LIST: tb_top drives every domain
  assert.deepEqual(
    undriven(check(`dut: { name: buf, reset: rst_n }\nreset:\n  - { name: rst_n }\n${AGENT}`, RST_MODEL)),
    []
  );
  // no reset port at all
  assert.deepEqual(undriven(check(`dut: { name: buf, reset: '' }\n${AGENT}`, RST_MODEL)), []);
});

test("reset-undriven: an ABSENT dut.reset is the generator's default `rst_n`", () => {
  // quick-uvm defaults the key to rst_n and emits the same dangling reference
  const absent = check(`dut: { name: buf, clock: clk }\n${AGENT}`, RST_MODEL);
  assert.deepEqual(undriven(absent).map((f) => f.params.port), ["rst_n"]);
  assert.ok(undriven(absent)[0].span, "no dut.reset node: the span falls back to dut.name");
});

test("reset-undriven (review): a port the model's DUT does not have is STILL reported, with the other repair", () => {
  // The generated top is just as broken (`.rst_n(cmd_if_inst.rst_n)`, exit 0) —
  // the first cut stayed silent here and hid the very bug. But `external: true`
  // cannot repair a pin that is not there: the repair is `dut.reset: ''`.
  for (const text of [
    `dut: { name: soc_top, clock: clk }\n${AGENT}`, // key absent -> rst_n
    `dut: { name: soc_top, reset: rst_n }\n${AGENT}`,
  ]) {
    const f = undriven(check(text, MODEL));
    assert.equal(f.length, 1);
    assert.deepEqual(f[0].params, { port: "rst_n", repair: "clear", why: "no-port" });
    assert.equal(f[0].code, `${RESET_CODE}:clear:rst_n`);
    assert.equal(f[0].severity, "error");
  }
  // a typo is the same shape (the DUT has `clk`, `din`, `dout`)
  assert.deepEqual(
    undriven(check(`dut: { name: soc_top, reset: rstn }\n${AGENT}`, MODEL))[0].params,
    { port: "rstn", repair: "clear", why: "no-port" }
  );
  // the pure subsystem shells of the other tests (`dut: { name: top }` + subenvs)
  // stay silent: they instantiate no DUT of their own
  assert.deepEqual(
    undriven(check(`dut: { name: soc_top }\nsubenvs: [ { name: u, config: u.yaml } ]\n`, MODEL)),
    []
  );
});

test("reset-undriven (review): `reset_port` — the top cannot be the answer, clear dut.reset", () => {
  // an agent drives the reset through its own port; quick-uvm REFUSES
  // `external: true` next to it, so that repair would trade one error for another
  const text = `dut: { name: buf, clock: clk }
agents:
  - name: cmd
    reset_port: arst
    ports:
      inputs: [ { name: din, width: 8 }, { name: arst } ]
`;
  const f = undriven(check(text, undefined));
  assert.deepEqual(f.map((x) => x.params), [{ port: "rst_n", repair: "clear", why: "reset-port" }]);
  // naming the port the agent drives is clean (the agent declares it)
  assert.deepEqual(undriven(check(text.replace("clock: clk", "clock: clk, reset: arst"), undefined)), []);
  assert.deepEqual(undriven(check(text.replace("clock: clk", "clock: clk, reset: ''"), undefined)), []);
});

test("reset-undriven: a plain reset mapping under a clock LIST (docs/08 R24's hazard) is reported", () => {
  // quick-uvm's multi-domain path reads only a reset list or `external: true`:
  // with the plain mapping it generates no reset at all, exit 0. The same
  // finding names it, and its `external` repair is one of the two ways out.
  const cfg = {
    dut: { name: "bridge", clock: "clk", reset: "rst_n" },
    clock: [{ name: "clk" }, { name: "fast_clk" }],
    agents: [{ name: "a", clock: "fast_clk", ports: { inputs: [{ name: "req", width: 1 }] } }],
  };
  assert.deepEqual(undrivenReset(cfg), { port: "rst_n", repair: "external" });
  assert.equal(undrivenReset({ ...cfg, reset: { external: true } }), null);
  assert.equal(undrivenReset({ ...cfg, reset: [{ name: "rst_n", clock: "clk" }] }), null);
});

test("reset-undriven: silent where the YAML cannot tell, or the generator wires no reset", () => {
  // combinational: quick-uvm connects no reset and REFUSES `external: true` on it
  assert.equal(undrivenReset({ dut: { name: "buf", reset: "rst_n", combinational: true } }), null);
  // (review) kind: selftest has a DUT-less top, kind: vip has no top at all
  for (const kind of ["selftest", "vip"]) {
    assert.equal(
      undrivenReset({ kind, dut: { name: "buf", reset: "rst_n" }, agents: [{ name: "a" }] }),
      null,
      kind
    );
  }
  // (review) hostile shapes do not throw: null entries, ports as plain strings
  assert.deepEqual(
    undrivenReset({ dut: { name: "buf", reset: "rst_n" }, agents: [null, { name: "a", ports: { inputs: ["din", null] } }] }),
    { port: "rst_n", repair: "external" }
  );
  // (review) `external: yes` is a boolean to the generator's YAML 1.1 loader
  assert.equal(
    undrivenReset({ dut: { name: "buf", reset: "rst_n" }, reset: { external: "yes" }, agents: [{ name: "a" }] }),
    null
  );
  assert.equal(undrivenReset({ dut: { name: "buf", reset: "rst_n" }, reset: null, agents: [{ name: "a" }] })?.port, "rst_n");
  // a PURE subsystem top instantiates no DUT of its own (its dut.reset is ignored) ...
  assert.equal(
    undrivenReset({ dut: { name: "sys", reset: "rst_n" }, subenvs: [{ name: "u_a", config: "a.yaml" }] }),
    null
  );
  // ... a HYBRID top (boundary agents) does
  assert.deepEqual(
    undrivenReset({
      dut: { name: "sys", reset: "rst_n" },
      subenvs: [{ name: "u_a", config: "a.yaml" }],
      agents: [{ name: "edge", ports: { inputs: [{ name: "z" }] } }],
    }),
    { port: "rst_n", repair: "external" }
  );
  // a `from_vip` agent: its ports live in the VIP manifest, not in this file
  assert.equal(
    undrivenReset({ dut: { name: "buf", reset: "rst_n" }, agents: [{ name: "io", from_vip: "v.qvip" }] }),
    null
  );
  // no dut yet: nothing to say
  assert.equal(undrivenReset({}), null);
  assert.equal(undrivenReset({ dut: {} }), null);
});

console.log(`\ntest-configcheck: ${passed} tests passed.`);
