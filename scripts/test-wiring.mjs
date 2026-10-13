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
const { wireOriginOf, wireTargets, wireChoices, wireChoicesOnCanvas, rtlWireChoices, subPortWidth } = await build(
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
    kind: "sb-port", nodeId: "sb:sbd", sbName: "sbd", blocked: null, field: "monitor",
  });
  const unnamed = wireOriginOf(scene, CFG, "sb:sbd#2.source");
  assert.match(unnamed.blocked, /name the scoreboard first/, "an unnamed entry is an origin, but every target will say why not");
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
  // cmd already has a collector: the coverage choice is NOT offered (the host
  // would cover another agent under this label — review finding)
  const c = wireOriginOf(scene, CFG, "agent:cmd.ap");
  assert.deepEqual(wireChoicesOnCanvas(scene, CFG, c).map((x) => x.label), ["Scoreboard fed by cmd"]);
});

test("duplicate-named scoreboards: the n-th entry is refused with the reason (edits land on the first)", () => {
  const cfg = {
    project: { name: "d" }, dut: { name: "d" },
    agents: [{ name: "cmd", interface: "cmd_if" }, { name: "rsp", interface: "rsp_if" }, { name: "aux", interface: "aux_if" }],
    analysis: { scoreboards: [{ name: "x", source: "cmd", monitor: "rsp" }, { name: "x", source: "aux" }] },
  };
  const s = buildTbScene(cfg, "env", null);
  assert.ok(s.nodes.some((n) => n.id === "sb:x#2"), "the fixture draws the duplicate as sb:x#2");
  const o = wireOriginOf(s, cfg, "sb:x#2.source");
  assert.match(o.blocked, /another scoreboard has this name/);
  assert.deepEqual(wireChoicesOnCanvas(s, cfg, o), []);
  const t = wireTargets(s, cfg, wireOriginOf(s, cfg, "agent:rsp.ap"));
  assert.match(t.get("sb:x#2"), /another scoreboard has this name/);
  assert.match(t.get("sb:x#2.source"), /another scoreboard has this name/);
  assert.deepEqual(wireChoices(s, cfg, wireOriginOf(s, cfg, "agent:rsp.ap"), "sb:x#2.source"), []);
  assert.equal(t.get("sb:x.monitor"), "already the monitor", "the first entry keeps its own rules");
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

// docs/08 R11 — the connections between composed blocks
const COMPOSED = {
  project: { name: "demo" },
  layout: "packaged",
  dut: { name: "soc_top", combinational: true, reset: "" },
  subenvs: [
    { name: "ch0", config: "chan.quickuvm.yaml" },
    { name: "u_add", config: "adder.quickuvm.yaml" },
    { name: "ghostly", config: "nope.quickuvm.yaml" },
  ],
  connections: [{ from: "ch0.dout", to: "u_add.b" }],
};
const CHILDREN = {
  ch0: { dut: { name: "chan" }, agents: [{ name: "chan_a", ports: { inputs: [{ name: "din", width: 16 }], outputs: [{ name: "dout", width: 16 }, { name: "flag" }] } }] },
  u_add: { dut: { name: "adder" }, agents: [{ name: "add_a", ports: { inputs: [{ name: "a", width: 16 }, { name: "b", width: 16 }, { name: "cin" }], outputs: [{ name: "s", width: 16 }] } }] },
};
const cscene = buildTbScene(COMPOSED, "env", null, null, CHILDREN);

test("sub-port: a block's output / input port is an origin with its width and its driver", () => {
  const out = wireOriginOf(cscene, COMPOSED, "sub:ch0.dout", CHILDREN);
  assert.deepEqual(out, { kind: "sub-port", nodeId: "sub:ch0", subenv: "ch0", port: "dout", dir: "out", width: 16, drivenBy: null });
  const inp = wireOriginOf(cscene, COMPOSED, "sub:u_add.b", CHILDREN);
  assert.deepEqual(inp, { kind: "sub-port", nodeId: "sub:u_add", subenv: "u_add", port: "b", dir: "in", width: 16, drivenBy: "ch0.dout" });
  assert.equal(wireOriginOf(cscene, COMPOSED, "sub:ch0.nope", CHILDREN), null, "a port the scene does not draw");
  assert.equal(subPortWidth(CHILDREN, "u_add", "cin", "in"), 1, "no width = 1");
  assert.equal(subPortWidth(CHILDREN, "ghostly", "x", "in"), null, "an unreadable child: unknown");
});

test("sub-port targets: another block's inputs — free, one driver per input, equal widths; agents are not targets", () => {
  const t = wireTargets(cscene, COMPOSED, wireOriginOf(cscene, COMPOSED, "sub:ch0.dout", CHILDREN), CHILDREN);
  assert.equal(t.get("sub:u_add.a"), null, "a free 16b input");
  assert.match(t.get("sub:u_add.b"), /already driven by ch0\.dout/);
  assert.match(t.get("sub:u_add.cin"), /width 16 ≠ 1/);
  assert.equal(t.get("sub:u_add.s"), undefined, "an output is not a target of an output");
  assert.equal(t.get("sub:u_add"), null, "the box: one legal port");
  assert.equal(t.has("sub:ch0"), false, "the origin's own block is no target");
  assert.equal(t.get("sub:ghostly"), "no input port on this block", "an unreadable child draws no ports");
  // the narrow output: every 16b input disagrees, the 1b one is free
  const n = wireTargets(cscene, COMPOSED, wireOriginOf(cscene, COMPOSED, "sub:ch0.flag", CHILDREN), CHILDREN);
  assert.equal(n.get("sub:u_add.cin"), null);
  assert.match(n.get("sub:u_add.a"), /width 1 ≠ 16/);
});

test("sub-port from an input: its sources are the other blocks' outputs; a driven input is blocked everywhere", () => {
  const free = wireTargets(cscene, COMPOSED, wireOriginOf(cscene, COMPOSED, "sub:u_add.a", CHILDREN), CHILDREN);
  assert.equal(free.get("sub:ch0.dout"), null);
  assert.match(free.get("sub:ch0.flag"), /width 16 ≠ 1/);
  assert.equal(free.get("sub:ch0.din"), undefined, "an input is not a source");
  const driven = wireTargets(cscene, COMPOSED, wireOriginOf(cscene, COMPOSED, "sub:u_add.b", CHILDREN), CHILDREN);
  assert.match(driven.get("sub:ch0.dout"), /already driven by ch0\.dout — remove that connection first/);
  assert.match(driven.get("sub:ch0"), /already driven/);
});

test("sub-port drop: on a port one connection, on the box its legal ports, on the canvas all of them; from = output, to = input", () => {
  const out = wireOriginOf(cscene, COMPOSED, "sub:ch0.dout", CHILDREN);
  assert.deepEqual(wireChoices(cscene, COMPOSED, out, "sub:u_add.a", CHILDREN), [
    { label: "Connect ch0.dout → u_add.a", action: "addConnection", args: { from: "ch0.dout", to: "u_add.a" } },
  ]);
  assert.deepEqual(wireChoices(cscene, COMPOSED, out, "sub:u_add.b", CHILDREN), [], "an illegal port: nothing (the reason is shown instead)");
  assert.deepEqual(wireChoices(cscene, COMPOSED, out, "sub:u_add", CHILDREN).map((c) => c.args.to), ["u_add.a"]);
  const inp = wireOriginOf(cscene, COMPOSED, "sub:u_add.a", CHILDREN);
  assert.deepEqual(wireChoices(cscene, COMPOSED, inp, "sub:ch0.dout", CHILDREN)[0].args, { from: "ch0.dout", to: "u_add.a" }, "the reverse drag writes the same entry");
  assert.deepEqual(wireChoicesOnCanvas(cscene, COMPOSED, out, CHILDREN).map((c) => c.args.to), ["u_add.a"]);
  assert.deepEqual(wireChoicesOnCanvas(cscene, COMPOSED, wireOriginOf(cscene, COMPOSED, "sub:u_add.b", CHILDREN), CHILDREN), [], "a driven input: no source at all");
});

console.log(`\ntest-wiring: ${passed} tests passed.`);
