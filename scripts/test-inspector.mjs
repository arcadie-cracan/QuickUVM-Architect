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
  agentRows, scoreboardRows, portRows, isBenchScope, rtlActionTarget,
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
    assert.ok(!all(r).includes(hidden), `${hidden} should not be shown on an initiator`);
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
    assert.ok(r.advanced.includes(rare), `${rare} must stay reachable`);
    assert.ok(!r.basic.includes(rare), `${rare} is not an everyday choice`);
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
  assert.equal(by.replicas.modified, true, "2 differs from the default 1");
  assert.equal(by.request_valid.required, true, "required by mode: responder (review): declared, not bold, no reset");
  assert.deepEqual(g.declared.map((f) => f.resettable), [true, true, false, true]);
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
  assert.equal(by["window.length"].modified, false, "required next to its boundary (review): not bold");
  assert.equal(by["window.length"].resettable, false, "and no reset");
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

// ---------------------------------------------------------------- docs/08 R9
const { multiGroups, MULTI_FIELDS } = await import(pathToFileURL(outFile));
const node = (id, kind, label, extra = {}) => ({ id, kind, label, ...extra });
const MCFG = {
  agents: [
    { name: "cmd" },
    { name: "rsp", active: false },
    { name: "aux", active: true, seq_item_style: "field_macros" },
    { name: "vip", from_vip: "lib.qvip" },
  ],
  analysis: {
    scoreboards: [
      { name: "sb_a", source: "cmd", monitor: "rsp", max_latency: 4 },
      { name: "sb_b", source: "cmd", monitor: "rsp", max_latency: 4 },
      { name: "sb_c", source: "cmd" },
      { name: "dup", source: "cmd" },
      { name: "dup", source: "rsp" },
    ],
  },
};
const fieldsOf = (g) => Object.fromEntries(g.fields.map((f) => [f.id, f.value]));

test("R9: two agents with the same role share it; a differing one reads as mixed (null)", () => {
  const same = multiGroups(MCFG, [node("agent:cmd", "tbagent", "cmd"), node("agent:aux", "tbagent", "aux")]);
  assert.equal(same.length, 1);
  assert.equal(same[0].kind, "agent");
  assert.deepEqual(same[0].names, ["cmd", "aux"], "the selection's order");
  // `cmd` does not declare `active`, `aux` declares the default: the EFFECTIVE
  // value is the same, so this is not "mixed"
  assert.deepEqual(fieldsOf(same[0]), { active: "true", seq_item_style: null },
    "active agrees (undeclared == declared default); the style differs");
  const mixed = multiGroups(MCFG, [node("agent:cmd", "tbagent", "cmd"), node("agent:rsp", "tbagent", "rsp")]);
  assert.deepEqual(fieldsOf(mixed[0]), { active: null, seq_item_style: "manual" });
});

test("R9: one editable component is not a group; ghosts and VIP references are left out", () => {
  assert.deepEqual(multiGroups(MCFG, [node("agent:cmd", "tbagent", "cmd")]), []);
  assert.deepEqual(
    multiGroups(MCFG, [node("agent:cmd", "tbagent", "cmd"), node("agent:vip", "tbagent", "vip")]),
    [],
    "a VIP reference takes {name, from_vip} only: one editable agent left"
  );
  const g = multiGroups(MCFG, [
    node("agent:cmd", "tbagent", "cmd"),
    node("agent:rsp", "tbagent", "rsp"),
    node("agent:vip", "tbagent", "vip"),
    node("agent:ghost", "tbagent", "cmd", { inferred: true }),
    node("agent:gone", "tbagent", "gone"), // not in the config any more
  ]);
  assert.deepEqual(g[0].names, ["cmd", "rsp"], "only what the edit can reach");
  assert.deepEqual(multiGroups(null, [node("agent:cmd", "tbagent", "cmd")]), []);
  assert.deepEqual(multiGroups(MCFG, []), []);
});

test("R9: scoreboards share max_latency; an unset one makes it mixed, a duplicate name is left out", () => {
  const ab = multiGroups(MCFG, [node("sb:sb_a", "tbsb", "sb_a"), node("sb:sb_b", "tbsb", "sb_b")]);
  assert.equal(ab[0].kind, "scoreboard");
  assert.deepEqual(fieldsOf(ab[0]), { max_latency: "4" });
  const ac = multiGroups(MCFG, [node("sb:sb_a", "tbsb", "sb_a"), node("sb:sb_c", "tbsb", "sb_c")]);
  assert.deepEqual(fieldsOf(ac[0]), { max_latency: null }, "4 vs. unset");
  const cc = multiGroups({ analysis: { scoreboards: [{ name: "x", source: "a" }, { name: "y", source: "a" }] } },
    [node("sb:x", "tbsb", "x"), node("sb:y", "tbsb", "y")]);
  assert.deepEqual(fieldsOf(cc[0]), { max_latency: "" }, "both unset: shared, and empty (no default)");
  // `dup` exists twice: the by-name mutation would edit the first one twice
  assert.deepEqual(
    multiGroups(MCFG, [node("sb:dup", "tbsb", "dup"), node("sb:dup#2", "tbsb", "dup"), node("sb:sb_a", "tbsb", "sb_a")]),
    [],
    "neither duplicate counts: one editable scoreboard left"
  );
  // a cross-block scoreboard (xsb:) has no by-name editor here either
  assert.deepEqual(
    multiGroups(MCFG, [node("xsb:sb_a", "tbsb", "sb_a"), node("sb:sb_b", "tbsb", "sb_b")]),
    []
  );
});

test("R9: a config with a null list entry or a non-list section does not throw", () => {
  const holes = {
    agents: [{ name: "cmd" }, null, { name: "rsp" }],
    analysis: { scoreboards: [null, { name: "x", source: "cmd" }, { name: "y", source: "cmd" }] },
  };
  const g = multiGroups(holes, [
    node("agent:cmd", "tbagent", "cmd"), node("agent:rsp", "tbagent", "rsp"),
    node("sb:x", "tbsb", "x"), node("sb:y", "tbsb", "y"),
  ]);
  assert.deepEqual(g.map((x) => x.names), [["cmd", "rsp"], ["x", "y"]]);
  assert.deepEqual(multiGroups({ agents: "foo", analysis: { scoreboards: 5 } }, [
    node("agent:cmd", "tbagent", "cmd"), node("agent:rsp", "tbagent", "rsp"),
  ]), []);
});

test("R9: a mixed-kind selection gives one group per kind that has two", () => {
  const g = multiGroups(MCFG, [
    node("agent:cmd", "tbagent", "cmd"),
    node("sb:sb_a", "tbsb", "sb_a"),
    node("agent:rsp", "tbagent", "rsp"),
    node("sb:sb_b", "tbsb", "sb_b"),
    node("cov:cmd", "tbcov", "cmd_cov"),
  ]);
  assert.deepEqual(g.map((x) => [x.kind, x.names]), [
    ["agent", ["cmd", "rsp"]],
    ["scoreboard", ["sb_a", "sb_b"]],
  ]);
  // two agents and ONE scoreboard: only the agents
  const h2 = multiGroups(MCFG, [
    node("agent:cmd", "tbagent", "cmd"), node("agent:rsp", "tbagent", "rsp"), node("sb:sb_a", "tbsb", "sb_a"),
  ]);
  assert.deepEqual(h2.map((x) => x.kind), ["agent"]);
});

test("R9: the bulk fields stay the ones that need nothing per component", () => {
  // `mode` (needs request_valid) and `match` (needs match_key) must never be
  // bulk-editable: set on several components they leave configs the generator
  // refuses and no validation finding reports
  assert.deepEqual([...MULTI_FIELDS.agent], ["active", "seq_item_style"]);
  assert.deepEqual([...MULTI_FIELDS.scoreboard], ["max_latency"]);
  for (const f of MULTI_FIELDS.agent) {
    assert.ok(AGENT_SPEC.rows.includes(f), `${f} is a row the agent editor knows`);
  }
  for (const f of MULTI_FIELDS.scoreboard) {
    assert.ok(SCOREBOARD_SPEC.rows.includes(f));
  }
});

test("rtlActionTarget: the ONE selected instance block, else the view's own instance", () => {
  // the schematic of demo_top, as the scene hands its nodes over
  const nodes = [
    { id: "bus_i", kind: "iface", instPath: "demo_top.bus_i" },
    { id: "u_soc", kind: "instance", instPath: "demo_top.u_soc" },
    { id: "g_ch[0..2].u_ch", kind: "fold", instPath: null },
    { id: "u_add", kind: "instance", instPath: "demo_top.u_add" },
  ];
  const at = (sel, mode = "schematic", view = "demo_top") =>
    rtlActionTarget(view, mode, nodes, new Set(sel));
  // the case of the manual validation: u_soc clicked in demo_top's schematic —
  // "Set as DUT" is about u_soc, not about the view it happens to be drawn in
  assert.equal(at(["u_soc"]), "demo_top.u_soc");
  assert.equal(at([]), "demo_top", "nothing selected: the view's module");
  // what does not name ONE module to verify falls back to the view
  assert.equal(at(["bus_i"]), "demo_top", "an interface instance is not a DUT");
  assert.equal(at(["g_ch[0..2].u_ch"]), "demo_top", "a fold has no single instance");
  assert.equal(at(["u_soc", "u_add"]), "demo_top", "two blocks do not name one");
  assert.equal(at(["u_soc.clk"]), "demo_top", "a pin is not a block");
  assert.equal(at(["u_soc", "u_soc.clk"]), "demo_top", "a block and a pin: not exactly one block");
  // a symbol view has no blocks: an id that happens to match a node of another
  // view's scene must not redirect the action
  assert.equal(at(["u_soc"], "symbol"), "demo_top");
  assert.equal(rtlActionTarget("demo_top", "schematic", undefined, new Set(["u_soc"])), "demo_top", "no scene yet");
  assert.equal(rtlActionTarget(undefined, "schematic", nodes, new Set()), undefined, "no view: no target");
});

console.log(`\ntest-inspector: ${passed} tests passed.`);
