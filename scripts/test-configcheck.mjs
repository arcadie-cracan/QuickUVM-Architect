// Teste Node pentru nucleul PUR al validarilor model<->YAML
// (src/configcheck.ts): npm run test:configcheck
// Miza: emiterea diagnosticelor era complet netestata — o regresie aici
// stinge TACIT feedback-ul de validare din editor (inclusiv eroarea dura de
// hibrid, pe care generatorul o refuza abia la `generate`).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
// aceeasi instanta `yaml` din node_modules; identitatea nodurilor e pe
// Symbol.for (global), deci parseDocument de aici + isMap din bundle coexista
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

/** ruleaza checkConfig pe un text YAML + un model minimal */
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

test("hibrid: subenvs + agents nevid = EROARE pe blocul agents", () => {
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
  const hy = r.findings.find((f) => f.kind === "hybrid");
  assert.ok(hy, "lipseste finding-ul de hibrid");
  assert.equal(hy.severity, "error");
  // span-ul acopera blocul agents (nu inceputul documentului)
  assert.ok(hy.span, "hibridul trebuie ancorat pe blocul agents");
  const spanText = r.text.slice(hy.span[0], hy.span[1]);
  assert.match(spanText, /name: cmd/);
});

test("hibrid: agents gol sau absent + subenvs = OK (nu e hibrid)", () => {
  const empty = check(
    `subenvs:\n  - { name: u_a, config: a.quickuvm.yaml }\nagents: []\n`,
    undefined
  );
  assert.ok(!kinds(empty).includes("hybrid"), "agents: [] nu e hibrid");
  const absent = check(
    `subenvs:\n  - { name: u_a, config: a.quickuvm.yaml }\n`,
    undefined
  );
  assert.ok(!kinds(absent).includes("hybrid"));
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
  // `agent` a intrat in params pentru decoratiile de stare (src/status.ts)
  assert.deepEqual(w.params, { port: "din", declared: 16, expected: 8, agent: "a" });
  // span-ul cade pe intrarea portului
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

test("ignorat + mapat: warning pe blocul ignored_ports", () => {
  const r = check(
    `dut: { name: soc_top }
agents:
  - name: a
    ports:
      inputs: [ { name: din, width: 8 } ]
x_quickuvm_architect:
  ignored_ports: [ din ]
`,
    MODEL
  );
  const i = r.findings.find((f) => f.kind === "ignored-and-mapped");
  assert.ok(i);
  assert.deepEqual(i.params, { port: "din", agent: "a" });
});

test("dut inexistent in model: warning; fara model, tacere", () => {
  const r = check(`dut: { name: nope }\n`, MODEL);
  assert.deepEqual(kinds(r), ["dut-missing"]);
  const noModel = check(`dut: { name: nope }\n`, undefined);
  assert.deepEqual(kinds(noModel), []);
});

console.log(`\ntest-configcheck: ${passed} teste au trecut.`);
