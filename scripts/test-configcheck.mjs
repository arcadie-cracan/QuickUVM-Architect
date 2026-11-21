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

const kinds = (r) => r.findings.map((f) => f.kind);

test("config curat: zero findings, zero orfani", () => {
  const r = check(
    `dut: { name: soc_top, clock: clk }
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

test("hibrid subenvs + agents (agenti de granita H2): NICIUN diagnostic", () => {
  const r = check(
    `dut: { name: top }
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
    "diagnosticul 'hybrid' nu mai exista (1.0: agenti de granita legali)");
});

test("latime gresita: warning cu codul quick-fix-ului", () => {
  const r = check(
    `dut: { name: soc_top }
agents:
  - name: a
    ports:
      inputs: [ { name: din, width: 16 } ]
`,
    MODEL
  );
  const w = r.findings.find((f) => f.kind === "width-mismatch");
  assert.ok(w, "lipseste width-mismatch");
  assert.equal(w.severity, "warning");
  assert.equal(w.code, `${WIDTH_CODE}:a:din:8`);
  // `agent` entered params for the status decorations (src/status.ts)
  assert.deepEqual(w.params, { port: "din", declared: 16, expected: 8, agent: "a" });
  // the span falls on the port entry
  assert.match(r.text.slice(w.span[0], w.span[1]), /din/);
});

test("latime implicita: fara width in YAML inseamna 1 (nepotrivire pe din=8)", () => {
  const r = check(
    `dut: { name: soc_top }
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

test("port revendicat de doi agenti: EROARE la al doilea", () => {
  const r = check(
    `dut: { name: soc_top }
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
  assert.ok(c, "lipseste port-claimed");
  assert.equal(c.severity, "error");
  assert.deepEqual(c.params, { port: "din", agent: "a" });
});

test("port disparut din model: warning + orfan (invalidare gratioasa)", () => {
  const r = check(
    `dut: { name: soc_top }
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

test("waived + mapat: EROARE pe dut.unverified_ports (zidul 1.0)", () => {
  const r = check(
    `dut: { name: soc_top, unverified_ports: [ din ] }
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

test("dut inexistent in model: warning; fara model, tacere", () => {
  // (`reset: ''`: the reset rule is YAML-internal and has its own tests below)
  const r = check(`dut: { name: nope, reset: '' }\n`, MODEL);
  assert.deepEqual(kinds(r), ["dut-missing"]);
  const noModel = check(`dut: { name: nope, reset: '' }\n`, undefined);
  assert.deepEqual(kinds(noModel), []);
});

// --- docs/08 R3: analysis endpoints that name no agent --------------------------
test("R3: scoreboard source/monitor and coverage naming an unknown agent are errors", () => {
  const r = check(
    `dut: { name: soc_top }
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
    `dut: { name: soc_top }
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
  assert.deepEqual(f[0].params, { port: "rst_n" });
  assert.equal(f[0].code, `${RESET_CODE}:rst_n`, "the quick-fix reads the port from the code");
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
  // ... but when the model KNOWS the DUT and it has no such pin, this is not the
  // defect `external: true` repairs (the config needs `dut.reset: ''`): silent
  assert.deepEqual(undriven(check(`dut: { name: soc_top, clock: clk }\n${AGENT}`, MODEL)), []);
  assert.deepEqual(undriven(check(`dut: { name: soc_top, reset: gone_n }\n${AGENT}`, MODEL)), []);
});

test("reset-undriven: silent where the YAML cannot tell, or the generator wires no reset", () => {
  // combinational: quick-uvm connects no reset and REFUSES `external: true` on it
  assert.equal(undrivenReset({ dut: { name: "buf", reset: "rst_n", combinational: true } }), null);
  // a PURE subsystem top instantiates no DUT of its own (its dut.reset is ignored) ...
  assert.equal(
    undrivenReset({ dut: { name: "sys", reset: "rst_n" }, subenvs: [{ name: "u_a", config: "a.yaml" }] }),
    null
  );
  // ... a HYBRID top (boundary agents) does
  assert.equal(
    undrivenReset({
      dut: { name: "sys", reset: "rst_n" },
      subenvs: [{ name: "u_a", config: "a.yaml" }],
      agents: [{ name: "edge", ports: { inputs: [{ name: "z" }] } }],
    }),
    "rst_n"
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

console.log(`\ntest-configcheck: ${passed} teste au trecut.`);
