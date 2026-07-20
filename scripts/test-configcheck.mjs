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
const { checkConfig, WIDTH_CODE } = await import(pathToFileURL(outFile));

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
  const r = check(`dut: { name: nope }\n`, MODEL);
  assert.deepEqual(kinds(r), ["dut-missing"]);
  const noModel = check(`dut: { name: nope }\n`, undefined);
  assert.deepEqual(kinds(noModel), []);
});

console.log(`\ntest-configcheck: ${passed} teste au trecut.`);
