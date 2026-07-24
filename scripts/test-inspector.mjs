// Node tests for the pure inspector information-architecture (src/inspector.ts):
// which rows are relevant, which are merely rare, and which disappear entirely.
// The rule under test is "simple by default, powerful when needed": a row hidden by
// RELEVANCE must have a neighbouring control that reveals it, and a row hidden by
// RARITY must still be reachable under `advanced`. No DOM, no vscode.
//   npm run test:inspector

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-inspector-"));
const outFile = join(outDir, "inspector.mjs");
await esbuild.build({
  entryPoints: ["src/inspector.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { agentRows, scoreboardRows, portRows, isBenchScope } = await import(
  pathToFileURL(outFile)
);

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}
const all = (r) => [...r.basic, ...r.advanced];

test("agentRows: an initiator shows NO responder knob", () => {
  const r = agentRows({ name: "cmd" });
  for (const hidden of [
    "respond",
    "request_valid",
    "request_ready",
    "reorder_by",
    "reorder_policy",
    "proactive",
  ]) {
    assert.ok(!all(r).includes(hidden), `${hidden} nu ar trebui aratat pe un initiator`);
  }
  // `mode` IS the discovery point, so it must stay visible and basic
  assert.ok(r.basic.includes("mode"));
  assert.ok(r.basic.includes("active"));
});

test("agentRows: responder reveals its knobs, `respond` gates the rest", () => {
  const onReq = agentRows({ name: "rd", mode: "responder" }); // respond defaults on_request
  assert.ok(onReq.basic.includes("request_valid"), "required by responder");
  assert.ok(onReq.basic.includes("request_ready"), "on_request publishes the request");
  assert.ok(onReq.advanced.includes("proactive"), "hybrid needs on_request");
  assert.ok(!all(onReq).includes("reorder_by"), "reorder is pipelined-only");

  const pipe = agentRows({ name: "rd", mode: "responder", respond: "pipelined" });
  assert.ok(pipe.basic.includes("reorder_by"), "required by pipelined");
  assert.ok(pipe.advanced.includes("reorder_policy"));
  assert.ok(pipe.basic.includes("request_ready"), "pipelined publishes the request too");
  assert.ok(!all(pipe).includes("proactive"), "proactive requires on_request");

  const comb = agentRows({ name: "rd", mode: "responder", respond: "combinational" });
  assert.ok(!all(comb).includes("request_ready"), "the driver reads the request itself");
  assert.ok(!all(comb).includes("proactive"));
});

test("agentRows: rare-but-always-valid knobs stay reachable under advanced", () => {
  const r = agentRows({ name: "cmd" });
  for (const rare of ["seq_item_style", "replicas"]) {
    assert.ok(r.advanced.includes(rare), `${rare} trebuie sa ramana accesibil`);
    assert.ok(!r.basic.includes(rare), `${rare} nu e o alegere de zi cu zi`);
  }
});

test("scoreboardRows: the stream count decides match/window, and they never coexist", () => {
  const single = scoreboardRows({ name: "sbd", source: "cmd" });
  assert.ok(single.advanced.includes("window.boundary"), "windows need one stream");
  assert.ok(!all(single).includes("match"), "match needs two streams");
  assert.ok(!all(single).includes("window.length"), "no boundary yet => not a window");

  const windowed = scoreboardRows({
    name: "sbd", source: "cmd", window: { boundary: "done", length: 64 },
  });
  assert.ok(windowed.advanced.includes("window.length"));

  const two = scoreboardRows({ name: "sbd", source: "cmd", monitor: "rsp" });
  assert.ok(two.basic.includes("match"));
  assert.ok(!all(two).includes("window.boundary"), "a two-stream sb is strictly 1:1");
  assert.ok(!all(two).includes("match_key"), "match_key is out_of_order only");

  const ooo = scoreboardRows({
    name: "sbd", source: "cmd", monitor: "rsp", match: "out_of_order",
  });
  assert.ok(ooo.basic.includes("match_key"), "required by out_of_order");
});

test("portRows: open drain only on a 1-bit inout, pullup only once it is on", () => {
  assert.ok(!all(portRows("in", { name: "din", width: 8 })).includes("open_drain"));
  assert.ok(!all(portRows("inout", { name: "bus", width: 4 })).includes("open_drain"),
    "per-bit open drain on a vector needs a generate loop");
  const sda = portRows("inout", { name: "sda", width: 1 });
  assert.ok(sda.basic.includes("open_drain"));
  assert.ok(!sda.basic.includes("pullup"), "no pullup control until open drain is on");
  const od = portRows("inout", { name: "sda", width: 1, open_drain: true });
  assert.ok(od.basic.includes("pullup"), "mandatory once open drain is on");
});

test("portRows: enum yields to a hand-written type specifier", () => {
  const plain = portRows("in", { name: "op", width: 2 });
  assert.ok(plain.advanced.includes("enum"));
  assert.ok(!all(plain).includes("type_specifier_hint"));
  // enum/type/packed_dims/struct are exclusive: offering enum here would only earn a
  // refusal, so the row becomes an explanation instead
  const packed = portRows("in", { name: "op", width: 2, packed_dims: [2, 4] });
  assert.ok(packed.advanced.includes("type_specifier_hint"));
  assert.ok(!all(packed).includes("enum"));
});

test("isBenchScope: bench sections show only with NO component selected", () => {
  assert.equal(isBenchScope(undefined), true); // the tree root selects nothing
  for (const kind of ["tbagent", "tbsb", "tbcov", "tbsubenv"]) {
    assert.equal(isBenchScope(kind), false, kind);
  }
});

console.log(`\ntest-inspector: ${passed} tests passed.`);
