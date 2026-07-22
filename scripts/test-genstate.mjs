// Node tests for the pure generation-state detector (src/genstate.ts): the
// `quick-uvm manifest` element→files map + on-disk mtimes + the config mtime ->
// the `missing` (absent) and `stale` (older than the config) element-id sets.
// No DOM, no vscode.
//   npm run test:genstate

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-genstate-"));
const outFile = join(outDir, "genstate.mjs");
await esbuild.build({
  entryPoints: ["src/genstate.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { ownerToNodeId, classify } = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

// a manifest element owning the given files (the `exists` flag is unused by
// classify — mtimes drive it — but present to match the real manifest shape)
const el = (owner, files) => ({
  owner,
  files: files.map((f) => ({ file: f, exists: true })),
});
const manifest = (elements) => ({
  version: "1.1.0",
  layout: "flat",
  kind: "bench",
  output_dir: "tb",
  elements,
});

test("ownerToNodeId maps the decoratable owners, null otherwise", () => {
  assert.equal(ownerToNodeId("agent:cmd"), "agent:cmd");
  assert.equal(ownerToNodeId("scoreboard:sbd"), "sb:sbd"); // scoreboard -> sb prefix
  assert.equal(ownerToNodeId("probes"), "probes");
  assert.equal(ownerToNodeId("vseq:smoke"), "vsqr"); // all vseqs -> the vsqr node
  for (const o of ["aggregate", "test:t1", "register_model", "vip"]) {
    assert.equal(ownerToNodeId(o), null, o);
  }
});

test("classify: a missing file -> `missing`; all present & newer -> generated", () => {
  const m = manifest([
    el("agent:cmd", ["a", "b"]),
    el("scoreboard:sbd", ["c"]),
  ]);
  // config at t=100; agent files newer (present), scoreboard file absent
  const mtimes = new Map([
    ["a", 200],
    ["b", 200],
  ]);
  const { missing, stale } = classify(m, mtimes, 100);
  assert.deepEqual([...missing], ["sb:sbd"]); // c absent
  assert.equal(stale.size, 0); // agent:cmd present & newer -> generated
});

test("classify: all present but a file older than config -> `stale`", () => {
  const m = manifest([el("agent:cmd", ["a", "b"])]);
  const mtimes = new Map([
    ["a", 200],
    ["b", 50], // older than config@100
  ]);
  const { missing, stale } = classify(m, mtimes, 100);
  assert.equal(missing.size, 0);
  assert.deepEqual([...stale], ["agent:cmd"]);
});

test("classify: aggregate/test owners are ignored even if missing", () => {
  const m = manifest([el("aggregate", ["x"]), el("test:t1", ["y"])]);
  const { missing, stale } = classify(m, new Map(), 100); // both absent
  assert.equal(missing.size, 0);
  assert.equal(stale.size, 0);
});

test("classify: vseqs collapse onto vsqr — missing wins over stale", () => {
  const m = manifest([el("vseq:a", ["a"]), el("vseq:b", ["b"])]);
  // a is stale (older), b is missing -> vsqr should be MISSING, not stale
  const mtimes = new Map([["a", 50]]); // b absent
  const { missing, stale } = classify(m, mtimes, 100);
  assert.deepEqual([...missing], ["vsqr"]);
  assert.equal(stale.size, 0);
});

console.log(`\ntest-genstate: ${passed} tests passed.`);
