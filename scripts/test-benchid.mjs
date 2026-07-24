// Node tests for the pure bench-identity guards (src/benchid.ts): which `layout:` /
// `kind:` values a config may be switched to, and why not. Each rule mirrors an
// explicit QuickUVM validator error — the panel disables the option instead of
// writing a config the generator refuses. No DOM, no vscode.
//   npm run test:benchid

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-benchid-"));
const outFile = join(outDir, "benchid.mjs");
await esbuild.build({
  entryPoints: ["src/benchid.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { layoutBlockers, kindBlockers } = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

/** a minimal valid-looking bench config */
const bench = (extra = {}) => ({
  project: { name: "d" },
  dut: { name: "d" },
  agents: [{ name: "a" }],
  tests: [{ name: "test1" }],
  ...extra,
});

test("layoutBlockers: a plain bench can go either way", () => {
  assert.deepEqual(layoutBlockers(bench(), "flat"), []);
  assert.deepEqual(layoutBlockers(bench(), "packaged"), []);
});

test("layoutBlockers: subenvs and a non-bench kind pin the layout to packaged", () => {
  const withSub = bench({ subenvs: [{ name: "s" }], layout: "packaged" });
  assert.equal(layoutBlockers(withSub, "flat").length, 1);
  assert.match(layoutBlockers(withSub, "flat")[0], /subenvs/);
  assert.deepEqual(layoutBlockers(withSub, "packaged"), []);

  const vip = bench({ kind: "vip", layout: "packaged" });
  assert.match(layoutBlockers(vip, "flat")[0], /kind: vip/);
  // both reasons at once are both reported (the message must not hide one)
  const both = bench({ kind: "selftest", subenvs: [{ name: "s" }], layout: "packaged" });
  assert.equal(layoutBlockers(both, "flat").length, 2);
});

test("layoutBlockers: agent `instances` (C3) pin the layout to flat", () => {
  const c3 = bench({ agents: [{ name: "ch", instances: [{ name: "ch0" }] }] });
  assert.deepEqual(layoutBlockers(c3, "flat"), []);
  assert.equal(layoutBlockers(c3, "packaged").length, 1);
  assert.match(layoutBlockers(c3, "packaged")[0], /instances.*flat/s);
  assert.match(layoutBlockers(c3, "packaged")[0], /ch/); // names the offending agent
});

test("layoutBlockers: a `from_vip` agent pins the layout to packaged", () => {
  // consuming an agent by reference means the VIP is an external PACKAGE; flat folds
  // everything into one tb_pkg and has nothing to chain
  const consumer = bench({
    layout: "packaged",
    agents: [{ name: "io", from_vip: "../vip/gen/io.qvip" }],
  });
  assert.deepEqual(layoutBlockers(consumer, "packaged"), []);
  const why = layoutBlockers(consumer, "flat");
  assert.equal(why.length, 1);
  assert.match(why[0], /from_vip.*packaged/s);
  assert.match(why[0], /io/); // names the offending agent
});

test("kindBlockers: `bench` is always available; vip/selftest need packaged", () => {
  assert.deepEqual(kindBlockers(bench({ kind: "vip" }), "bench"), []);
  assert.match(kindBlockers(bench(), "vip")[0], /layout: packaged/);
  assert.match(kindBlockers(bench(), "selftest")[0], /layout: packaged/);
  assert.deepEqual(kindBlockers(bench({ layout: "packaged" }), "selftest"), []);
});

test("kindBlockers: vip lists the bench-layer sections that would be DROPPED", () => {
  const rich = bench({
    layout: "packaged",
    register_model: { package: "p", block: "b", bus_agent: "a" },
    probes: [{ name: "p" }],
    regress: {},
    analysis: { scoreboards: [{ name: "sbd", source: "a" }], coverage: ["a"] },
  });
  const [msg] = kindBlockers(rich, "vip");
  for (const s of [
    "register_model",
    "probes",
    "regress",
    "analysis.scoreboards",
    "analysis.coverage",
  ]) {
    assert.ok(msg.includes(s), `${s} lipseste din mesaj: ${msg}`);
  }
  // clean vip candidate: nothing bench-layer present
  assert.deepEqual(kindBlockers(bench({ layout: "packaged" }), "vip"), []);
});

test("kindBlockers: the untouched default test list is NOT a vip blocker", () => {
  // QuickUVM fences a USER-DECLARED test list only ("tests != [TestConfig(test1)]")
  const dflt = bench({ layout: "packaged", tests: [{ name: "test1" }] });
  assert.deepEqual(kindBlockers(dflt, "vip"), []);
  const declared = bench({ layout: "packaged", tests: [{ name: "smoke_test" }] });
  assert.match(kindBlockers(declared, "vip")[0], /tests/);
  // ABSENT `tests:` IS the default (QuickUVM compares against the field's default
  // value), so it must not block — while an explicit `tests: []` differs and does
  const absent = bench({ layout: "packaged" });
  delete absent.tests;
  assert.deepEqual(kindBlockers(absent, "vip"), []);
  assert.match(kindBlockers(bench({ layout: "packaged", tests: [] }), "vip")[0], /tests/);
  // ... and neither is a RICH coverage entry (it renders into the agent package)
  const richCov = bench({
    layout: "packaged",
    analysis: { coverage: [{ agent: "a", coverpoints: [] }] },
  });
  assert.deepEqual(kindBlockers(richCov, "vip"), []);
});

console.log(`\ntest-benchid: ${passed} tests passed.`);
