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
const {
  agentRows, scoreboardRows, portRows, isBenchScope,
  fieldGroups, summarizeValue, AGENT_SPEC, SCOREBOARD_SPEC, PORT_SPEC,
} = await import(pathToFileURL(outFile));

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

// docs/08 R16 — the PROVENANCE rule: declared first (bold + reset), then the
// common rows with the default dimmed, then the rare ones
test("fieldGroups: an agent's declared keys come first, in the editor's order, bold when off the default", () => {
  const agent = {
    name: "cmd", interface: "cmd_if", sequence_item: "cmd_item",
    active: false, mode: "responder", request_valid: "req", replicas: 2,
    ports: { inputs: [{ name: "a" }] },
  };
  const g = fieldGroups(agentRows(agent), agent, AGENT_SPEC);
  assert.deepEqual(g.declared.map((f) => f.id), ["active", "mode", "request_valid", "replicas"]);
  assert.deepEqual(g.common.map((f) => f.id), ["respond", "request_ready"], "the relevant rows not declared");
  assert.deepEqual(g.all.map((f) => f.id), ["seq_item_style", "emit_when", "proactive"], "the rare rows not declared");
  assert.deepEqual(g.other, [
    { key: "interface", summary: "cmd_if", required: true, modified: false },
    { key: "sequence_item", summary: "cmd_item", required: true, modified: false },
  ], "declared keys without a row, read-only; name and ports live elsewhere");
  const by = Object.fromEntries(g.declared.map((f) => [f.id, f]));
  assert.equal(by.active.modified, true, "false differs from the default true");
  assert.equal(by.request_valid.modified, true, "no default: any value is a change");
  assert.ok(g.declared.every((f) => f.resettable), "none of them is required");
  const respond = g.common.find((f) => f.id === "respond");
  assert.equal(respond.placeholder, "on_request", "the generator's default, to be shown dimmed");
  assert.equal(respond.declared, false);
});

test("fieldGroups: a declared key equal to the default is declared, not modified, still resettable", () => {
  const agent = { name: "cmd", active: true, ports: {} };
  const g = fieldGroups(agentRows(agent), agent, AGENT_SPEC);
  assert.deepEqual(g.declared.map((f) => [f.id, f.modified, f.resettable]), [["active", false, true]]);
  assert.deepEqual(g.common.map((f) => f.id), ["mode"]);
});

test("fieldGroups: a declared key relevance would HIDE still shows, after the visible ones", () => {
  // `respond: pipelined` on an initiator — the generator refuses it; the file says it
  const agent = { name: "cmd", mode: "initiator", respond: "pipelined", emit_when: "v" };
  const g = fieldGroups(agentRows(agent), agent, AGENT_SPEC);
  assert.deepEqual(g.declared.map((f) => f.id), ["mode", "emit_when", "respond"], "visible first (basic, advanced), hidden last");
  assert.ok(!g.common.some((f) => f.id === "respond") && !g.all.some((f) => f.id === "respond"));
});

test("fieldGroups: a scoreboard's required source is declared but never reset; nested keys resolve", () => {
  const sb = { name: "pkt_sb", source: "cmd", window: { boundary: "done", length: 4 }, reference_model: { language: "sv" } };
  const g = fieldGroups(scoreboardRows(sb), sb, SCOREBOARD_SPEC);
  const by = Object.fromEntries(g.declared.map((f) => [f.id, f]));
  assert.deepEqual(Object.keys(by), ["source", "reference_model.language", "window.boundary", "window.length"], "the editor's order: basic, then advanced");
  assert.equal(by.source.resettable, false);
  assert.equal(by.source.modified, false, "required: there is no default to differ from");
  assert.equal(by["reference_model.language"].modified, false, "sv is the default");
  assert.equal(by["window.length"].modified, true);
  assert.deepEqual(g.other, [], "window and reference_model are covered by their dotted rows");
  assert.deepEqual(g.common.map((f) => f.id), ["monitor"]);
  assert.deepEqual(g.all.map((f) => f.id), ["max_latency"]);
  const two = { name: "sbd", source: "cmd", monitor: "rsp", match: "out_of_order", match_key: "id" };
  const g2 = fieldGroups(scoreboardRows(two), two, SCOREBOARD_SPEC);
  assert.deepEqual(g2.declared.map((f) => f.id), ["source", "monitor", "match", "match_key"]);
  assert.equal(g2.common.find((f) => f.id === "match")?.placeholder, undefined, "match is declared");
});

test("fieldGroups: a port without a width shows the default 1 dimmed; a declared width is bold", () => {
  const bare = { name: "a" };
  const g = fieldGroups(portRows("in", bare), bare, PORT_SPEC);
  assert.deepEqual(g.declared, []);
  assert.equal(g.common.find((f) => f.id === "width")?.placeholder, "1");
  const wide = { name: "d", width: 8, packed_dims: [2] };
  const g2 = fieldGroups(portRows("in", wide), wide, PORT_SPEC);
  assert.deepEqual(g2.declared.map((f) => [f.id, f.modified]), [["width", true]]);
  assert.deepEqual(g2.other, [{ key: "packed_dims", summary: "1 item", required: false, modified: true }]);
  assert.ok(g2.all.some((f) => f.id === "type_specifier_hint"), "a hint row is never declared");
});

test("review: a key another key REQUIRES is declared but never reset, nor bold; the enabler resets with a note", () => {
  const r = { name: "cmd", mode: "responder", request_valid: "req", respond: "pipelined", reorder_by: "id" };
  const g = fieldGroups(agentRows(r), r, AGENT_SPEC);
  const by = Object.fromEntries(g.declared.map((f) => [f.id, f]));
  assert.deepEqual([by.request_valid.resettable, by.request_valid.modified, by.request_valid.required], [false, false, true]);
  assert.deepEqual([by.reorder_by.resettable, by.reorder_by.required], [false, true]);
  assert.equal(by.mode.resettable, true, "the enabling key resets: its cascade drops the dependents");
  assert.match(by.mode.resetNote, /responder-only keys/);
  assert.match(by.respond.resetNote, /reorder_by/);
  // an initiator with a stray request_valid: not required there, so it resets
  const i = { name: "cmd", request_valid: "req" };
  const gi = fieldGroups(agentRows(i), i, AGENT_SPEC);
  assert.equal(gi.declared.find((f) => f.id === "request_valid")?.resettable, true);
  const sb = { name: "s", source: "a", monitor: "b", match: "out_of_order", match_key: "k" };
  const bs = Object.fromEntries(fieldGroups(scoreboardRows(sb), sb, SCOREBOARD_SPEC).declared.map((f) => [f.id, f]));
  assert.equal(bs.match_key.resettable, false, "required by out_of_order");
  assert.equal(bs.match.resettable, true);
  assert.match(bs.match.resetNote, /match_key/);
  const win = { name: "w", source: "a", window: { boundary: "done", length: 4 } };
  const bw = Object.fromEntries(fieldGroups(scoreboardRows(win), win, SCOREBOARD_SPEC).declared.map((f) => [f.id, f]));
  assert.equal(bw["window.length"].resettable, false, "a window without a length is invalid: no reset");
  assert.equal(bw["window.boundary"].resettable, true);
  assert.match(bw["window.boundary"].resetNote, /whole window/);
});

test("review: the read-only rows know the schema defaults — assertions: false and idle: {} are not modified", () => {
  const a = { name: "cmd", assertions: false, idle: {}, sequences: [{ name: "s" }], interface: "i", rand: 1 };
  const g = fieldGroups(agentRows(a), a, AGENT_SPEC);
  assert.deepEqual(g.other.map((o) => [o.key, o.modified, o.required]), [
    ["assertions", false, false],
    ["idle", false, false],
    ["sequences", true, false],
    ["interface", false, true],
    ["rand", true, false],
  ], "a key with no known default is modified by any value");
});

test("summarizeValue: scalars as text, lists by count, maps by keys", () => {
  assert.equal(summarizeValue("x"), "x");
  assert.equal(summarizeValue(3), "3");
  assert.equal(summarizeValue(false), "false");
  assert.equal(summarizeValue([1, 2]), "2 items");
  assert.equal(summarizeValue({ a: 1, b: 2 }), "{a, b}");
  assert.equal(summarizeValue({}), "{}");
});

test("isBenchScope: bench sections show only with NO component selected", () => {
  assert.equal(isBenchScope(undefined), true); // the tree root selects nothing
  for (const kind of ["tbagent", "tbsb", "tbcov", "tbsubenv"]) {
    assert.equal(isBenchScope(kind), false, kind);
  }
});

// --- the delete gate (src/webview/inspector-view.ts) ------------------------------
// `tbDeleteTarget` is the ONE id->name resolution behind the inspector's Delete
// button, the Delete key on the diagram and the context menu — so a component it
// refuses is refused on all three paths at once. That is why the ghost gate lives
// there and is tested here: a ghost has no YAML entry, so a delete would find
// nothing to remove and the gesture would report success having done nothing.
//
// Only the ghost branch is exercised: it returns before touching the module's
// render context, while every other branch reads `ctx.state.config`, which exists
// only under a real render. Testing the gate, not the resolution.
const ivFile = join(mkdtempSync(join(tmpdir(), "quickuvm-iv-")), "iv.mjs");
await esbuild.build({
  entryPoints: ["src/webview/inspector-view.ts"],
  outfile: ivFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { tbDeleteTarget } = await import(pathToFileURL(ivFile));

test("a ghost is not deletable on ANY path (button, Delete key, context menu)", () => {
  for (const node of [
    { id: "sb:sbd", kind: "tbsb", label: "sbd", inferred: true },
    { id: "cov:pkt", kind: "tbcov", label: "pkt_cov", inferred: true },
  ]) {
    assert.equal(
      tbDeleteTarget(node),
      null,
      `${node.id}: an inferred component has no YAML entry to delete`
    );
  }
});

console.log(`\ntest-inspector: ${passed} tests passed.`);
