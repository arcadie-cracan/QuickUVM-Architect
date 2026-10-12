// Node tests for the temporary-wire rules of the verification view
// (src/webview/wiring.ts — docs/08 R10 + R11): what a drag from a port means,
// which targets are legal and why not, and what a drop writes.
//   npm run test:wiring
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-wiring-"));
const build = async (entry, name) => {
  const out = join(outDir, name);
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  return import(pathToFileURL(out));
};
const { buildTbScene } = await build("src/webview/tbscene.ts", "tbscene.mjs");
const { wireOriginOf, wireTargets, wireChoices, wireChoicesOnCanvas, rtlWireChoices } = await build(
  "src/webview/wiring.ts",
  "wiring.mjs"
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const CFG = {
  project: { name: "demo" },
  dut: { name: "soc_top", clock: "clk", reset: "rst_n" },
  agents: [
    { name: "cmd", interface: "cmd_if", ports: { inputs: [{ name: "din", width: 8 }] } },
    { name: "rsp", interface: "rsp_if", active: false, ports: { outputs: [{ name: "dout", width: 8 }] } },
    { name: "aux", interface: "aux_if", ports: { inputs: [{ name: "x" }] } },
  ],
  analysis: {
    coverage: ["cmd"],
    scoreboards: [
      { name: "sbd", source: "cmd", monitor: "rsp" },
      { name: "single", source: "aux" },
      { source: "cmd" }, // unnamed: drawn as sb:sbd#2
    ],
  },
};
const scene = buildTbScene(CFG, "env", null);

test("origin: an agent's ap and a named scoreboard's inputs start a wire; nothing else does", () => {
  assert.deepEqual(wireOriginOf(scene, CFG, "agent:cmd.ap"), {
    kind: "agent-ap", nodeId: "agent:cmd", agent: "cmd",
  });
  assert.deepEqual(wireOriginOf(scene, CFG, "sb:sbd.monitor"), {
    kind: "sb-port", nodeId: "sb:sbd", sbName: "sbd", named: true, field: "monitor",
  });
  const unnamed = wireOriginOf(scene, CFG, "sb:sbd#2.source");
  assert.equal(unnamed.named, false, "an unnamed entry is an origin, but every target will say why not");
  assert.equal(wireOriginOf(scene, CFG, "agent:cmd.if"), null, "an interface is not a TLM endpoint");
  assert.equal(wireOriginOf(scene, CFG, "cov:cmd.ap"), null, "a collector's input cannot be retargeted");
  assert.equal(wireOriginOf(scene, CFG, "nope"), null);
});

test("agent origin: scoreboard ports are legal unless already wired; the rest says why not", () => {
  const t = wireTargets(scene, CFG, wireOriginOf(scene, CFG, "agent:cmd.ap"));
  assert.equal(t.get("sb:sbd.source"), "already the source");
  assert.equal(t.get("sb:sbd.monitor"), "the source cannot also be the monitor");
  assert.equal(t.get("sb:sbd"), "already the source", "no legal port: the node carries a reason");
  assert.equal(t.get("sb:single.source"), null, "cmd can replace aux as the source");
  assert.equal(t.get("sb:single.monitor"), null, "cmd can become the monitor of aux's scoreboard");
  assert.equal(t.get("sb:single"), null);
  assert.match(t.get("sb:sbd#2"), /name the scoreboard first/);
  assert.match(t.get("cov:cmd"), /belongs to one agent/);
  assert.match(t.get("agent:rsp"), /through a scoreboard/);
  assert.equal(t.has("agent:cmd"), false, "the origin is never a target");
});

test("agent origin: the drop choices follow the legal ports; on a node both are offered", () => {
  const o = wireOriginOf(scene, CFG, "agent:rsp.ap");
  assert.deepEqual(wireChoices(scene, CFG, o, "sb:single"), [
    { label: "Set rsp as source of single", action: "editScoreboard", args: { name: "single", field: "source", value: "rsp" } },
    { label: "Set rsp as monitor of single", action: "editScoreboard", args: { name: "single", field: "monitor", value: "rsp" } },
  ]);
  assert.deepEqual(wireChoices(scene, CFG, o, "sb:single.monitor").map((c) => c.args.field), ["monitor"]);
  assert.deepEqual(wireChoices(scene, CFG, o, "sb:sbd.monitor"), [], "rsp is already the monitor of sbd");
  assert.deepEqual(wireChoices(scene, CFG, o, "cov:cmd"), [], "illegal target: no choice");
});

test("agent origin on empty canvas: the two create gestures, each with its seed kind", () => {
  const o = wireOriginOf(scene, CFG, "agent:aux.ap");
  assert.deepEqual(wireChoicesOnCanvas(scene, CFG, o), [
    { label: "Scoreboard fed by aux", action: "addScoreboard", args: { source: "aux" }, creates: "tbsb" },
    { label: "Coverage on aux", action: "addCoverage", args: { agent: "aux" }, creates: "tbcov" },
  ]);
});

test("scoreboard origin: agents are legal unless already an endpoint; others are not agents", () => {
  const o = wireOriginOf(scene, CFG, "sb:sbd.monitor");
  const t = wireTargets(scene, CFG, o);
  assert.equal(t.get("agent:rsp"), "already the monitor");
  assert.equal(t.get("agent:cmd"), "the source cannot also be the monitor");
  assert.equal(t.get("agent:aux"), null);
  assert.equal(t.get("cov:cmd"), "not an agent");
  assert.deepEqual(wireChoices(scene, CFG, o, "agent:aux"), [
    { label: "Use aux as monitor of sbd", action: "editScoreboard", args: { name: "sbd", field: "monitor", value: "aux" } },
  ]);
  assert.deepEqual(wireChoicesOnCanvas(scene, CFG, o).map((c) => c.args.value), ["aux"],
    "on empty canvas: the legal agents as a menu");
});

test("an unnamed scoreboard's input retargets nothing: every target names the rule", () => {
  const o = wireOriginOf(scene, CFG, "sb:sbd#2.source");
  const t = wireTargets(scene, CFG, o);
  for (const [, reason] of t) {
    assert.match(reason, /name the scoreboard first/);
  }
  assert.deepEqual(wireChoicesOnCanvas(scene, CFG, o), []);
});

test("ghosts are never targets, and never origins", () => {
  const implicit = { project: { name: "y" }, dut: { name: "d" }, agents: [{ name: "pkt", interface: "pkt_if" }] };
  const resolved = {
    version: "1.1.0", dut: "d",
    analysis: { mode: "implicit", scoreboards: [{ name: "sbd", source: "pkt", origin: "inferred" }], coverage: [{ agent: "pkt", origin: "inferred" }] },
    tests: [], virtual_sequences: [], agents: [], guards: [],
  };
  const s = buildTbScene(implicit, "env", null, resolved);
  const o = wireOriginOf(s, implicit, "agent:pkt.ap");
  const t = wireTargets(s, implicit, o);
  assert.match(t.get("sb:sbd"), /inferred by quick-uvm/);
  assert.match(t.get("cov:pkt"), /inferred by quick-uvm/);
  assert.equal(wireOriginOf(s, implicit, "sb:sbd.source"), null, "a ghost's port starts nothing");
});

test("RTL pin on empty canvas: an agent from the pin, or from the selection it belongs to", () => {
  const din = { port: "din", owner: "demo_top.u_soc", iface: false };
  assert.deepEqual(rtlWireChoices(din, [], null), [
    { label: "Agent from pin din", action: "createAgentFromPins", args: { pins: ["<port>.din"], viewId: "demo_top.u_soc" } },
  ]);
  const both = rtlWireChoices(din, ["din", "en"], null);
  assert.deepEqual(both.map((c) => c.label), ["Agent from the 2 selected pins", "Agent from pin din"]);
  assert.deepEqual(both[0].args.pins, ["<port>.din", "<port>.en"]);
  // a selection the origin is NOT part of does not travel with the wire
  assert.equal(rtlWireChoices(din, ["en", "we"], null).length, 1);
  assert.deepEqual(rtlWireChoices({ port: "bus_i", owner: "demo_top", iface: true }, [], null), [
    { label: "Agent from interface bus_i", action: "createAgentFromIface", args: { port: "bus_i", viewId: "demo_top" } },
  ]);
});

test("RTL pin on a pin an agent claims: the pins join that agent; an interface cannot", () => {
  const din = { port: "din", owner: "demo_top", iface: false };
  assert.deepEqual(rtlWireChoices(din, [], "cmd"), [
    { label: "Add din to agent cmd", action: "addPinsToAgent", args: { agent: "cmd", pins: ["<port>.din"], viewId: "demo_top" } },
  ]);
  assert.deepEqual(rtlWireChoices(din, ["din", "en"], "cmd").map((c) => c.label), [
    "Add the 2 selected pins to agent cmd",
    "Add din to agent cmd",
  ]);
  assert.deepEqual(rtlWireChoices({ port: "bus_i", owner: "demo_top", iface: true }, [], "cmd"), []);
});

console.log(`\ntest-wiring: ${passed} tests passed.`);
