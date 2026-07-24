// Node tests for the pure rich-coverage helpers (src/coverage.ts): the bin
// mini-syntax and the candidate/blocker sets the editor offers. Each rule mirrors a
// QuickUVM validator (exactly one of value/range/values; one coverpoint per field;
// a cross needs >= 2 DECLARED coverpoints and a unique name). No DOM, no vscode.
//   npm run test:coverage

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-coverage-"));
const outFile = join(outDir, "coverage.mjs");
await esbuild.build({
  entryPoints: ["src/coverage.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const cov = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

test("parseBinSpec: the three legal forms, exactly one each", () => {
  assert.deepEqual(cov.parseBinSpec("5"), { value: 5 });
  assert.deepEqual(cov.parseBinSpec(" 42 "), { value: 42 });
  assert.deepEqual(cov.parseBinSpec("0..7"), { range: [0, 7] });
  assert.deepEqual(cov.parseBinSpec("0:7"), { range: [0, 7] });
  assert.deepEqual(cov.parseBinSpec("1, 2,3"), { values: [1, 2, 3] });
});

test("parseBinSpec: refuses what QuickUVM would refuse (or SV would cover silently)", () => {
  for (const bad of ["", "   ", "abc", "-1", "1..", "..7", "1..2..3", "1,,2", "1,x", "7..3"]) {
    assert.equal(cov.parseBinSpec(bad), null, `"${bad}" ar fi trebuit respins`);
  }
});

test("formatBinSpec: round-trips every form", () => {
  for (const raw of ["5", "0..7", "1, 2, 3"]) {
    const parsed = cov.parseBinSpec(raw);
    assert.equal(cov.parseBinSpec(cov.formatBinSpec(parsed)).toString(), parsed.toString());
  }
  assert.equal(cov.formatBinSpec({ value: 5 }), "5");
  assert.equal(cov.formatBinSpec({ range: [0, 7] }), "0..7");
  assert.equal(cov.formatBinSpec({ values: [1, 2] }), "1, 2");
});

test("isRich / coveredAgent: a bare name is routing, a mapping is a model", () => {
  assert.equal(cov.isRich("cmd"), false);
  assert.equal(cov.isRich({ agent: "cmd" }), true);
  assert.equal(cov.coveredAgent("cmd"), "cmd");
  assert.equal(cov.coveredAgent({ agent: "cmd" }), "cmd");
  assert.equal(cov.coveredAgent(42), undefined);
});

test("coverpointCandidates: agent ports minus the already-covered fields", () => {
  const agent = {
    name: "cmd",
    ports: { inputs: [{ name: "din" }, { name: "wr" }], outputs: [{ name: "dout" }] },
  };
  assert.deepEqual(cov.coverpointCandidates(agent, {}), ["din", "wr", "dout"]);
  // one coverpoint per field (QuickUVM: "duplicate coverpoint for field")
  assert.deepEqual(
    cov.coverpointCandidates(agent, { coverpoints: [{ field: "din" }] }),
    ["wr", "dout"]
  );
  assert.deepEqual(cov.coverpointCandidates(undefined, {}), []);
});

test("crossName / crossFields: both the list and the object form", () => {
  assert.equal(cov.crossName(["a", "b"]), "a_x_b");
  assert.equal(cov.crossName({ fields: ["a", "b"] }), "a_x_b");
  assert.equal(cov.crossName({ fields: ["a", "b"], name: "custom" }), "custom");
  assert.deepEqual(cov.crossFields(["a", "b"]), ["a", "b"]);
  assert.deepEqual(cov.crossFields({ fields: ["a", "b"] }), ["a", "b"]);
});

test("crossBlockers: >= 2 fields, all DECLARED coverpoints, unique name", () => {
  const model = { coverpoints: [{ field: "a" }, { field: "b" }], crosses: [["a", "b"]] };
  assert.match(cov.crossBlockers(model, ["a"])[0], /at least 2/);
  assert.match(cov.crossBlockers(model, ["a", "zz"])[0], /not a declared coverpoint: zz/);
  assert.match(cov.crossBlockers(model, ["a", "b"])[0], /already exists/);
  assert.deepEqual(cov.crossBlockers({ ...model, coverpoints: [...model.coverpoints, { field: "c" }] }, ["a", "c"]), []);
});

console.log(`\ntest-coverage: ${passed} tests passed.`);
