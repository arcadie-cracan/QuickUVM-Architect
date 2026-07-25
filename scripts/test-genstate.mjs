// Node tests for the pure generation-state detector (src/genstate.ts): the
// `quick-uvm manifest` element→files map + the files present on disk + the
// per-element "generated from this config hash" records -> the `missing` (absent)
// and `stale` (generated from a different config) element-id sets. No DOM, no vscode.
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
const {
  ownerToNodeId,
  classify,
  declaredElements,
  scopedFilesFor,
  primaryFile,
} = await import(
  pathToFileURL(outFile)
);

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

// a manifest element owning the given files (the `exists` flag is unused by
// classify — the caller's `present` set drives it — but kept to match the real
// manifest shape)
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

test("classify: a missing file -> `missing`; all present & same hash -> generated", () => {
  const m = manifest([
    el("agent:cmd", ["a", "b"]),
    el("scoreboard:sbd", ["c"]),
  ]);
  const present = new Set(["a", "b"]); // c absent
  const gen = new Map([["agent:cmd", "H1"]]); // generated from the current config
  const { missing, stale } = classify(m, present, gen, "H1");
  assert.deepEqual([...missing], ["sb:sbd"]);
  assert.equal(stale.size, 0); // agent:cmd present & same hash -> generated
});

test("classify: all present but generated from another config hash -> `stale`", () => {
  const m = manifest([el("agent:cmd", ["a", "b"])]);
  const present = new Set(["a", "b"]);
  const { missing, stale } = classify(m, present, new Map([["agent:cmd", "OLD"]]), "H1");
  assert.equal(missing.size, 0);
  assert.deepEqual([...stale], ["agent:cmd"]);
});

test("classify: regenerating clears `stale` even if no file content changed", () => {
  // the bug this design fixes: quick-uvm does not rewrite unchanged files, so an
  // mtime-based check latched `stale` forever. Re-recording the hash clears it.
  const m = manifest([el("agent:cmd", ["a"])]);
  const present = new Set(["a"]);
  assert.deepEqual([...classify(m, present, new Map([["agent:cmd", "OLD"]]), "H1").stale], [
    "agent:cmd",
  ]);
  const after = classify(m, present, new Map([["agent:cmd", "H1"]]), "H1"); // markGenerated
  assert.equal(after.stale.size, 0);
});

test("classify: no record for an element -> never claimed stale", () => {
  // generated outside the extension (CLI): we cannot know, so we do not badge it
  const m = manifest([el("agent:cmd", ["a"])]);
  const { missing, stale } = classify(m, new Set(["a"]), new Map(), "H1");
  assert.equal(missing.size, 0);
  assert.equal(stale.size, 0);
});

test("classify: aggregate/test owners are ignored even if missing", () => {
  const m = manifest([el("aggregate", ["x"]), el("test:t1", ["y"])]);
  const { missing, stale } = classify(m, new Set(), new Map(), "H1"); // both absent
  assert.equal(missing.size, 0);
  assert.equal(stale.size, 0);
});

test("classify: vseqs collapse onto vsqr — missing wins over stale", () => {
  const m = manifest([el("vseq:a", ["a"]), el("vseq:b", ["b"])]);
  // a is stale (old hash), b is missing -> vsqr should be MISSING, not stale
  const gen = new Map([["vsqr", "OLD"]]);
  const { missing, stale } = classify(m, new Set(["a"]), gen, "H1");
  assert.deepEqual([...missing], ["vsqr"]);
  assert.equal(stale.size, 0);
});

test("declaredElements: mirrors the tree's nodes, from the IN-MEMORY config", () => {
  assert.deepEqual(declaredElements({}), []);
  // OWNER ids, the vocabulary the manifest speaks
  assert.deepEqual(
    declaredElements({
      agents: [{ name: "cmd" }, { name: "rsp" }, {}],
      analysis: { scoreboards: [{ name: "sbd", source: "cmd" }, { source: "rsp" }] },
      probes: [{ name: "p" }],
    }).sort(),
    ["agent:cmd", "agent:rsp", "scoreboard:sbd", "scoreboard:sbd", "probes", "vseq:auto"].sort()
  );
  // vsqr: an explicit vseq naming a real agent, else the auto vseq at >= 2 active
  const hasVseq = (cfg) => declaredElements(cfg).some((o) => o.startsWith("vseq:"));
  assert.deepEqual(
    declaredElements({
      agents: [{ name: "cmd" }],
      virtual_sequences: [{ name: "v", body: [{ agent: "cmd", sequence: "s" }] }],
    }),
    ["agent:cmd", "vseq:v"]
  );
  assert.ok(!hasVseq({
    agents: [{ name: "cmd" }],
    virtual_sequences: [{ name: "v", body: [{ agent: "nope", sequence: "s" }] }],
  }), "un vseq care nu numeste niciun agent real nu coordoneaza nimic");
  assert.ok(!hasVseq({ agents: [{ name: "a" }, { name: "b" }], auto_virtual_sequences: false }));
  assert.ok(hasVseq({ agents: [{ name: "a" }, { name: "b" }] }));
  assert.ok(!hasVseq({ agents: [{ name: "a" }, { name: "b", active: false }] }),
    "auto vseq cere >= 2 agenti ACTIVI");
});

test("classify: a JUST-ADDED element is UNSAVED, its own state (● green)", () => {
  // the tree is built from the in-memory document, the manifest from the file on
  // DISK. A component added but not saved is absent from the manifest — and that is
  // not merely "ungenerated": the DECLARATION itself would be lost in a crash, so it
  // gets its own badge rather than borrowing the "not generated" one.
  const m = manifest([el("agent:cmd", ["a"])]);
  const present = new Set(["a"]);
  const gen = new Map([["agent:cmd", "H1"]]);
  const saved = classify(m, present, gen, "H1");
  assert.equal(saved.unsaved.size, 0);
  assert.equal(saved.missing.size, 0, "starea salvata e curata");

  const dirty = classify(m, present, gen, "H1", ["agent:cmd", "vseq:v"]);
  assert.deepEqual([...dirty.unsaved], ["vsqr"]);
  assert.equal(dirty.missing.size, 0, "un element nesalvat NU e si `missing`");
  assert.equal(dirty.stale.size, 0);
});

test("classify: precedence is unsaved > missing > stale on a shared node", () => {
  // every vseq collapses onto the single `vsqr` node, so one node can qualify for
  // several states at once; the most urgent must win, or the badge understates it.
  const m = manifest([el("vseq:a", ["a"]), el("vseq:b", ["b"])]);
  // `a` is stale (old hash), `b` is missing (absent file), and a THIRD vseq is
  // declared but unsaved -> vsqr is UNSAVED. The node was already known, so this
  // only works because declarations are matched at OWNER level.
  const gen = new Map([["vsqr", "OLD"]]);
  const all = classify(m, new Set(["a"]), gen, "H1", ["vseq:a", "vseq:b", "vseq:c"]);
  assert.deepEqual([...all.unsaved], ["vsqr"]);
  assert.equal(all.missing.size, 0);
  assert.equal(all.stale.size, 0);
  // without the declaration it falls back to missing, still ahead of stale
  const noDecl = classify(m, new Set(["a"]), gen, "H1");
  assert.deepEqual([...noDecl.missing], ["vsqr"]);
  assert.equal(noDecl.stale.size, 0);
});

test("scopedFilesFor: element's own files + the aggregate co-regen set", () => {
  const m = manifest([
    el("agent:cmd", ["cmd_agent.svh", "cmd_driver.svh"]),
    el("agent:rsp", ["rsp_agent.svh"]),
    el("aggregate", ["d_tb_pkg.sv", "pkg.f"]),
  ]);
  const files = scopedFilesFor(m, "agent:cmd");
  assert.deepEqual(files.sort(), [
    "cmd_agent.svh",
    "cmd_driver.svh",
    "d_tb_pkg.sv",
    "pkg.f",
  ]); // cmd's files + aggregate, NOT rsp's
});

test("scopedFilesFor: vseqs collapse -> all vseq files + aggregate", () => {
  const m = manifest([
    el("vseq:a", ["a.svh"]),
    el("vseq:b", ["b.svh"]),
    el("aggregate", ["run.f"]),
  ]);
  assert.deepEqual(scopedFilesFor(m, "vsqr").sort(), ["a.svh", "b.svh", "run.f"]);
});

test("scopedFilesFor: unknown element -> null", () => {
  const m = manifest([el("agent:cmd", ["x"]), el("aggregate", ["y"])]);
  assert.equal(scopedFilesFor(m, "sb:nope"), null);
});

test("primaryFile: picks the representative file by suffix, ignores aggregate", () => {
  const m = manifest([
    el("agent:cmd", ["cmd_if.sv", "cmd_agent.svh", "cmd_driver.svh"]),
    el("aggregate", ["cmd_agent.svh_decoy", "tb_pkg.sv"]),
  ]);
  assert.equal(primaryFile(m, "agent:cmd"), "cmd_agent.svh"); // _agent.svh, not the if/driver
  const sb = manifest([el("scoreboard:sbd", ["d_predictor.svh", "d_scoreboard.svh"])]);
  assert.equal(primaryFile(sb, "sb:sbd"), "d_scoreboard.svh");
  const pr = manifest([el("probes", ["d_probe_if.sv", "d_probe_monitor.svh"])]);
  assert.equal(primaryFile(pr, "probes"), "d_probe_if.sv");
});

test("primaryFile: no suffix match -> first own file; unknown -> null", () => {
  const m = manifest([el("agent:cmd", ["cmd_if.sv", "cmd_cfg.svh"])]);
  assert.equal(primaryFile(m, "agent:cmd"), "cmd_if.sv"); // no _agent.svh -> first
  assert.equal(primaryFile(m, "sb:nope"), null);
});

console.log(`\ntest-genstate: ${passed} tests passed.`);
