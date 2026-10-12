// Node tests for the YAML <-> TB-element map (src/yamlmap.ts — docs/08 R4):
// the caret position -> the element it is in, and the element -> its YAML span.
//   npm run test:yamlmap
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-yamlmap-"));
const outFile = join(outDir, "yamlmap.mjs");
await esbuild.build({
  entryPoints: ["src/yamlmap.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const { elementAtOffset, elementRange } = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const TEXT = `# a bench, hand-formatted
project: { name: demo }
clock: { period: 10, unit: ns }
dut:
  name: soc_top
  clock: clk
agents:
  - name: cmd
    interface: cmd_if
    ports:
      inputs: [ { name: din, width: 8 } ]   # the stimulus side
  - name: rsp
    active: false
analysis:
  coverage: [ cmd, { agent: rsp, coverpoints: [] } ]
  scoreboards:
    - { name: sbd, source: cmd, monitor: rsp }
    - { source: cmd }
virtual_sequences:
  - { name: smoke, body: [ { agent: cmd, sequence: cmd_seq } ] }
subenvs:
  - { name: blk, config: blk.quickuvm.yaml }
probes:
  - { name: lvl, path: u.lvl, width: 3 }
`;
const at = (needle) => TEXT.indexOf(needle);
const slice = (span) => TEXT.slice(span.start, span.end);

test("caret -> element: every drawn block, including nested positions", () => {
  assert.deepEqual(elementAtOffset(TEXT, at("name: soc_top")), { id: "dut", focus: "" });
  assert.deepEqual(elementAtOffset(TEXT, at("width: 8")), { id: "agent:cmd", focus: "env" },
    "a port inside the agent still means the agent");
  assert.deepEqual(elementAtOffset(TEXT, at("active: false")), { id: "agent:rsp", focus: "env" });
  assert.deepEqual(elementAtOffset(TEXT, at("monitor: rsp")), { id: "sb:sbd", focus: "env" });
  assert.deepEqual(elementAtOffset(TEXT, at("{ source: cmd }") + 3), { id: "sb:sbd", focus: "env" },
    "an unnamed scoreboard is drawn as `sbd`, like the scene does");
  assert.deepEqual(elementAtOffset(TEXT, at("coverpoints")), { id: "cov:rsp", focus: "env" });
  assert.deepEqual(elementAtOffset(TEXT, at("[ cmd,") + 2), { id: "cov:cmd", focus: "env" });
  assert.deepEqual(elementAtOffset(TEXT, at("name: smoke")), { id: "vsqr", focus: "env" });
  assert.deepEqual(elementAtOffset(TEXT, at("config: blk")), { id: "sub:blk", focus: "env" });
  assert.deepEqual(elementAtOffset(TEXT, at("path: u.lvl")), { id: "probes", focus: "env" });
});

test("caret -> null where the view draws nothing: comments, clock, project, blank", () => {
  assert.equal(elementAtOffset(TEXT, 3), null, "the leading comment");
  assert.equal(elementAtOffset(TEXT, at("period: 10")), null);
  assert.equal(elementAtOffset(TEXT, at("name: demo")), null);
  assert.equal(elementAtOffset(TEXT, TEXT.length), null);
  assert.equal(elementAtOffset("not: [valid", 3), null, "a broken document never throws");
  assert.equal(elementAtOffset("", 0), null);
});

test("element -> span: the entry itself, on the user's own formatting", () => {
  assert.equal(slice(elementRange(TEXT, "agent:rsp")), "name: rsp\n    active: false");
  assert.match(slice(elementRange(TEXT, "agent:cmd")), /^name: cmd[\s\S]*the stimulus side$/,
    "the agent's whole item, trailing comment included");
  assert.equal(slice(elementRange(TEXT, "sb:sbd")), "{ name: sbd, source: cmd, monitor: rsp }");
  assert.equal(slice(elementRange(TEXT, "cov:rsp")), "{ agent: rsp, coverpoints: [] }");
  assert.equal(slice(elementRange(TEXT, "cov:cmd")), "cmd");
  assert.equal(slice(elementRange(TEXT, "sub:blk")), "{ name: blk, config: blk.quickuvm.yaml }");
  assert.match(slice(elementRange(TEXT, "vsqr")), /^virtual_sequences:/);
  assert.match(slice(elementRange(TEXT, "probes")), /^probes:/);
  assert.match(slice(elementRange(TEXT, "dut")), /^dut:\n  name: soc_top\n  clock: clk/);
});

test("element -> span: internals, de-duplicated ids and absent elements", () => {
  assert.deepEqual(elementRange(TEXT, "agent:cmd:u.driver"), elementRange(TEXT, "agent:cmd"),
    "an agent-internal leaf belongs to the agent");
  assert.deepEqual(elementRange(TEXT, "sb:sbd#2"), elementRange(TEXT, "sb:sbd"));
  assert.equal(elementRange(TEXT, "agent:ghost"), null);
  assert.equal(elementRange(TEXT, "env"), null, "a level node has no YAML of its own");
  assert.equal(elementRange(TEXT, "cov:nobody"), null);
  assert.equal(elementRange("agents: []\n", "agent:cmd"), null);
});

test("round trip: the caret anywhere inside an element's span resolves to that element", () => {
  for (const id of ["agent:cmd", "agent:rsp", "sb:sbd", "cov:rsp", "sub:blk"]) {
    const span = elementRange(TEXT, id);
    for (const off of [span.start, Math.floor((span.start + span.end) / 2), span.end - 1]) {
      assert.equal(elementAtOffset(TEXT, off)?.id, id, `${id} @ ${off}`);
    }
  }
});

console.log(`\ntest-yamlmap: ${passed} tests passed.`);
