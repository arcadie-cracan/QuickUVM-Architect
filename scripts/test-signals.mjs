// Node tests for the "Signals" view's model (src/signals.ts — docs/08 R24):
// the clock / reset domains as a tree with the agents under them, the
// "Unconnected" folder, and what a drop writes.
//   npm run test:signals
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-signals-"));
const outFile = join(outDir, "signals.mjs");
await esbuild.build({
  entryPoints: ["src/signals.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { buildSignalsTree, dropPlan } = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}
const shape = (n) => [n.kind, n.label, n.children.map(shape)];
const find = (tree, id) => {
  for (const n of tree) {
    if (n.id === id) {
      return n;
    }
    const hit = find(n.children, id);
    if (hit) {
      return hit;
    }
  }
  return undefined;
};

const SINGLE = {
  dut: { name: "d", clock: "clk", reset: "rst_n" },
  clock: { period: 4, unit: "ns" },
  agents: [{ name: "cmd" }, { name: "rsp" }],
};
const MULTI = {
  dut: { name: "cdc", clock: "src_clk_i", reset: "src_rst_ni" },
  clock: [{ name: "src_clk_i", period: 10, unit: "ns" }, { name: "dst_clk_i", source: "dut" }],
  reset: [{ name: "src_rst_ni", clock: "src_clk_i" }, { name: "dst_rst_ni", active_low: false, clock: "dst_clk_i" }],
  agents: [
    { name: "src", clock: "src_clk_i", reset: "src_rst_ni" },
    { name: "dst", clock: "dst_clk_i" },
    { name: "mon" },
    { name: "odd", clock: "gone_clk" },
    { name: "vip", from_vip: "v.yaml" },
  ],
};

test("no configuration, or no DUT: nothing to show", () => {
  assert.deepEqual(buildSignalsTree(null), []);
  assert.deepEqual(buildSignalsTree({ agents: [{ name: "a" }] }), []);
});

test("one clock, one reset: every agent is on them — no folder, nothing to assign", () => {
  const t = buildSignalsTree(SINGLE);
  assert.deepEqual(t.map(shape), [
    ["group", "Clocks", [["domain", "clk", [["agent", "cmd", []], ["agent", "rsp", []]]]]],
    ["group", "Resets", [["domain", "rst_n", [["agent", "cmd", []], ["agent", "rsp", []]]]]],
  ]);
  assert.equal(find(t, "clock:clk").description, "4 ns");
  assert.equal(find(t, "reset:rst_n").description, "active low");
  const none = buildSignalsTree({ dut: { name: "d", clock: "clk", reset: "" }, agents: [] });
  assert.deepEqual(shape(none[1]), ["group", "Resets", [["note", "no reset (dut.reset is empty)", []]]]);
  const ext = buildSignalsTree({ ...SINGLE, reset: { active_low: false, external: true } });
  assert.match(find(ext, "reset:rst_n").description, /active high, external/);
});

test("a domain list: agents under their domain, the rest in Unconnected — which says where they land", () => {
  const t = buildSignalsTree(MULTI);
  assert.deepEqual(shape(t[0]), ["group", "Clocks", [
    ["domain", "src_clk_i", [["agent", "src", []]]],
    ["domain", "dst_clk_i", [["agent", "dst", []]]],
    ["unassigned", "Unconnected", [["agent", "mon", []], ["agent", "odd", []], ["agent", "vip", []]]],
  ]]);
  assert.match(find(t, "clock:").description, /puts these on src_clk_i, the first domain/);
  assert.equal(find(t, "clock:dst_clk_i").description, "10 ns — driven by the DUT");
  assert.match(find(t, "clock:/odd").description, /gone_clk — not a declared domain/, "an undeclared domain is shown, not hidden");
  assert.ok(find(t, "clock:/vip").fixed, "a VIP reference cannot be dragged");
  assert.deepEqual(shape(t[1]), ["group", "Resets", [
    ["domain", "src_rst_ni", [["agent", "src", []]]],
    ["domain", "dst_rst_ni", []],
    ["unassigned", "Unconnected", [["agent", "dst", []], ["agent", "mon", []], ["agent", "odd", []], ["agent", "vip", []]]],
  ]]);
  assert.match(find(t, "reset:src_rst_ni").description, /active low, released on src_clk_i — the DUT's reset port/);
  assert.match(find(t, "reset:dst_rst_ni").description, /active high, released on dst_clk_i/);
  const empty = buildSignalsTree({ ...MULTI, agents: [{ name: "src", clock: "src_clk_i", reset: "src_rst_ni" }] });
  assert.match(find(empty, "clock:").description, /^none — /, "the folder stays: it is where a drop removes the key");
});

test("a drop: the TARGET decides the key; Unconnected removes it", () => {
  const t = buildSignalsTree(MULTI);
  assert.deepEqual(dropPlan(MULTI, find(t, "clock:dst_clk_i"), ["mon", "src"]), {
    ok: true, field: "clock", value: "dst_clk_i", agents: ["mon", "src"],
  });
  assert.deepEqual(dropPlan(MULTI, find(t, "reset:dst_rst_ni"), ["dst"]), {
    ok: true, field: "reset", value: "dst_rst_ni", agents: ["dst"],
  }, "an agent dragged from the Clocks group onto a reset domain sets its reset");
  assert.deepEqual(dropPlan(MULTI, find(t, "clock:"), ["src", "odd"]), {
    ok: true, field: "clock", value: "", agents: ["src", "odd"],
  });
  assert.deepEqual(dropPlan(MULTI, find(t, "clock:dst_clk_i"), ["mon", "dst", "dst", "ghost"]).agents, ["mon"],
    "already there, repeated or unknown: left out");
});

test("a drop that cannot be: refused with the reason, never written", () => {
  const t = buildSignalsTree(MULTI);
  const no = (r) => { assert.equal(r.ok, false); return r.reason; };
  assert.match(no(dropPlan(MULTI, find(t, "clock:dst_clk_i"), ["dst"])), /already there/);
  assert.match(no(dropPlan(MULTI, find(t, "clock:dst_clk_i"), ["vip"])), /VIP reference/);
  assert.match(no(dropPlan(MULTI, find(t, "clock"), ["mon"])), /on a clock or reset domain/);
  assert.match(no(dropPlan(MULTI, find(t, "clock:/mon"), ["src"])), /on a clock or reset domain/);
  assert.match(no(dropPlan(MULTI, { kind: "domain", field: "clock", domain: "nope" }, ["mon"])), /not a declared clock domain/);
  assert.match(no(dropPlan(MULTI, undefined, ["mon"])), /domain/);
  const s = buildSignalsTree(SINGLE);
  assert.match(no(dropPlan(SINGLE, find(s, "clock:clk"), ["cmd"])), /one clock: every agent is on it/);
  assert.match(no(dropPlan(SINGLE, find(s, "reset:rst_n"), ["cmd"])), /one reset/);
});

test("a shape nobody can walk never throws", () => {
  for (const cfg of [
    { dut: { name: "d" }, agents: "foo", clock: 5, reset: "x" },
    { dut: { name: "d" }, agents: [null, "s", { name: "a", clock: 7 }], clock: [null, "s", {}, { name: "c" }], reset: [{}] },
  ]) {
    assert.doesNotThrow(() => buildSignalsTree(cfg));
    assert.doesNotThrow(() => dropPlan(cfg, { kind: "domain", field: "clock", domain: "c" }, ["a"]));
  }
});

test("review: a reset's Unconnected agents land on the reset RELEASED ON THEIR CLOCK, else the first", () => {
  const t = buildSignalsTree(MULTI);
  // dst samples dst_clk_i and has no `reset:`: quick-uvm gives it dst_rst_ni
  // (probed, locked in test:e2e) — the folder used to say "src_rst_ni, the first"
  assert.equal(find(t, "reset:/dst").description, "→ dst_rst_ni");
  assert.equal(find(t, "reset:/mon").description, "→ src_rst_ni", "no clock of its own: the first clock's reset");
  assert.match(find(t, "reset:").description, /the reset released on its clock, else src_rst_ni/);
  // a clock's own rule is unchanged: the first domain
  assert.equal(find(t, "clock:/mon").description, "→ src_clk_i");
  // resets with no `clock:` bind nobody: everyone follows the first entry
  const loose = buildSignalsTree({ ...MULTI, reset: [{ name: "r0" }, { name: "r1" }], dut: { ...MULTI.dut, reset: "r0" } });
  assert.equal(find(loose, "reset:/dst").description, "→ r0");
  // an agent on an UNDECLARED clock samples the first one, so its reset follows that
  assert.match(find(t, "reset:/odd").description, /→ src_rst_ni/);
});

test("review: under a single clock / reset an agent's own key is flagged — the generator refuses it", () => {
  const cfg = {
    dut: { name: "d", clock: "clk_i", reset: "rst_n" },
    clock: { period: 10 },
    agents: [{ name: "ok" }, { name: "dflt", clock: "clk" }, { name: "port", clock: "clk_i" }, { name: "rst", reset: "rst_n" }],
  };
  const t = buildSignalsTree(cfg);
  assert.equal(find(t, "clock:clk_i/ok").description, undefined);
  assert.equal(find(t, "clock:clk_i/dflt").description, undefined, "`clk` is the single clock's own name");
  assert.match(find(t, "clock:clk_i/port").description, /clock: clk_i — not a declared clock: quick-uvm refuses it/,
    "the DUT's clock PORT is not the clock's name");
  assert.match(find(t, "reset:rst_n/rst").description, /reset: rst_n — not a declared reset/);
  const named = buildSignalsTree({ ...cfg, clock: { name: "core" }, agents: [{ name: "a", clock: "core" }] });
  assert.equal(find(named, "clock:clk_i/a").description, undefined);
});

test("review: a clock list with a plain reset mapping is said to generate NO reset", () => {
  const cfg = {
    dut: { name: "d", clock: "a_clk", reset: "rst_n" },
    clock: [{ name: "a_clk" }, { name: "b_clk" }],
    agents: [{ name: "a", clock: "a_clk" }],
  };
  assert.match(find(buildSignalsTree(cfg), "reset:rst_n").description, /NOT GENERATED: with a clock list/);
  assert.doesNotMatch(find(buildSignalsTree({ ...cfg, reset: { external: true } }), "reset:rst_n").description, /NOT GENERATED/);
  assert.doesNotMatch(find(buildSignalsTree({ ...cfg, reset: [{ name: "rst_n" }] }), "reset:rst_n").description, /NOT GENERATED/);
  assert.doesNotMatch(find(buildSignalsTree(SINGLE), "reset:rst_n").description, /NOT GENERATED/);
});

test("review: tree ids are unique even with a name written twice", () => {
  const cfg = {
    dut: { name: "d", clock: "c0", reset: "" },
    clock: [{ name: "c0" }, { name: "c0" }, { name: "c1" }],
    agents: [{ name: "a" }, { name: "a" }, { name: "b", clock: "c1" }, { name: "b", clock: "c1" }],
  };
  const ids = [];
  const walk = (n) => { ids.push(n.id); n.children.forEach(walk); };
  buildSignalsTree(cfg).forEach(walk);
  assert.equal(new Set(ids).size, ids.length, ids.join(" "));
});

console.log(`\ntest-signals: ${passed} tests passed.`);
