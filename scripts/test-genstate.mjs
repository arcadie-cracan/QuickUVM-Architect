// Node tests for the pure generation-state detector (src/genstate.ts): the
// `quick-uvm manifest` JSON -> the set of verification elements with no generated
// code behind them. No DOM, no vscode.
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
const { ownerToNodeId, ungeneratedNodeIds } = await import(
  pathToFileURL(outFile)
);

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

// a manifest element with all files existing or all missing
const el = (owner, exists, files = ["f1", "f2"]) => ({
  owner,
  files: files.map((f) => ({ file: f, exists })),
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

test("ungeneratedNodeIds: missing files -> node id; existing -> not listed", () => {
  const m = manifest([
    el("agent:cmd", false), // ungenerated
    el("agent:rsp", true), // generated
    el("scoreboard:sbd", false), // ungenerated -> sb:sbd
    el("aggregate", false), // no node -> ignored even though missing
  ]);
  const out = ungeneratedNodeIds(m);
  assert.deepEqual([...out].sort(), ["agent:cmd", "sb:sbd"]);
});

test("ungeneratedNodeIds: partial (one of many files missing) counts as ungenerated", () => {
  const m = manifest([
    {
      owner: "agent:cmd",
      files: [
        { file: "cmd_agent.svh", exists: true },
        { file: "cmd_driver.svh", exists: false }, // one missing
      ],
    },
  ]);
  assert.deepEqual([...ungeneratedNodeIds(m)], ["agent:cmd"]);
});

test("ungeneratedNodeIds: several vseq owners collapse onto one vsqr node", () => {
  const m = manifest([el("vseq:a", true), el("vseq:b", false)]);
  assert.deepEqual([...ungeneratedNodeIds(m)], ["vsqr"]); // b missing -> vsqr starred
});

test("ungeneratedNodeIds: nothing missing -> empty set", () => {
  const m = manifest([el("agent:cmd", true), el("scoreboard:sbd", true)]);
  assert.equal(ungeneratedNodeIds(m).size, 0);
});

console.log(`\ntest-genstate: ${passed} tests passed.`);
