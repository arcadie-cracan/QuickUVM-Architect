// Node tests for the quick-uvm status decorations (src/status.ts):
//   npm run test:status
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-status-"));
const outFile = join(outDir, "status.mjs");
await esbuild.build({
  entryPoints: ["src/status.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { decosFromFindings, statusIdsRtl, statusIdsTb, statusIdsTree } = await import(
  pathToFileURL(outFile)
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const F = (kind, severity, params) => ({ kind, severity, params, span: null });

test("decosFromFindings: each kind finds its semantic target", () => {
  const decos = decosFromFindings([
    F("dut-missing", "warning", { module: "ghost" }),
    F("port-claimed", "error", { port: "clk", agent: "cmd" }),
    F("port-orphan", "warning", { port: "gone", dut: "chan", agent: "cmd" }),
    F("width-mismatch", "warning", {
      port: "din", declared: 8, expected: 16, agent: "cmd",
    }),
    F("ignored-and-mapped", "warning", { port: "x", agent: "rsp" }),
  ]);
  const scopes = decos.map((d) => d.scope);
  // dut-missing -> env; port-claimed -> port+agent; port-orphan ->
  // ONLY agent (the pin no longer exists); width-mismatch -> port+agent;
  // ignored-and-mapped -> port (the "hybrid" kind no longer exists: 1.0
  // accepts boundary agents at a composition)
  assert.deepEqual(scopes, [
    "env", "port", "agent", "agent", "port", "agent", "port",
  ]);
  assert.ok(decos[2].message.includes("clk"));
  assert.ok(decos[3].message.includes("gone"));
  assert.ok(decos[4].message.includes("width 8"));
});

test("statusIdsRtl: the DUT's view -> boundary flag; the DUT instances -> pins", () => {
  const decos = decosFromFindings([
    F("width-mismatch", "warning", {
      port: "din", declared: 8, expected: 16, agent: "cmd",
    }),
  ]);
  // the view ITSELF is the DUT (its symbol or schematic)
  const own = statusIdsRtl(decos, { viewModule: "chan", dut: "chan", nodes: [] });
  assert.deepEqual([...own.keys()], ["<port>.din"]);
  assert.equal(own.get("<port>.din").severity, "warning");
  // parent view with DUT instances (including a fold)
  const parent = statusIdsRtl(decos, {
    viewModule: "soc_top",
    dut: "chan",
    nodes: [
      { id: "u_add", module: "adder" },
      { id: "g_ch[0..2].u_ch", module: "chan" },
    ],
  });
  assert.deepEqual([...parent.keys()], ["g_ch[0..2].u_ch.din"]);
});

test("statusIdsRtl: without a DUT or an unrelated view -> nothing", () => {
  const decos = decosFromFindings([
    F("port-claimed", "error", { port: "clk", agent: "cmd" }),
  ]);
  assert.equal(statusIdsRtl(decos, { viewModule: "x", dut: null, nodes: [] }).size, 0);
  assert.equal(
    statusIdsRtl(decos, { viewModule: "adder", dut: "chan", nodes: [] }).size,
    0
  );
});

test("statusIdsTb: agent present -> its block; env -> the env node", () => {
  const decos = decosFromFindings([
    // fabricated env-scoped ERROR (the former role of the "hybrid"): the test checks
    // the severity PRECEDENCE at aggregation, not the realism of the finding
    F("dut-missing", "error", { module: "ghost" }),
    F("width-mismatch", "warning", {
      port: "din", declared: 8, expected: 16, agent: "cmd",
    }),
  ]);
  // the env level: agents visible, env not
  const envLevel = statusIdsTb(decos, new Set(["agent:cmd", "agent:rsp"]));
  assert.deepEqual([...envLevel.keys()], ["agent:cmd"]);
  // the root level: env visible, agents not -> bubble-up with the agent prefix
  const root = statusIdsTb(decos, new Set(["dut", "env"]));
  assert.deepEqual([...root.keys()], ["env"]);
  const env = root.get("env");
  assert.equal(env.severity, "error"); // the env error beats width (warning)
  assert.equal(env.messages.length, 2);
  assert.ok(env.messages.some((m) => m.startsWith("cmd: ")));
});

test("statusIdsTb: aggregation — two problems on the same agent, one badge", () => {
  const decos = decosFromFindings([
    F("width-mismatch", "warning", {
      port: "din", declared: 8, expected: 16, agent: "cmd",
    }),
    F("port-claimed", "error", { port: "clk", agent: "cmd" }),
  ]);
  const m = statusIdsTb(decos, new Set(["agent:cmd"]));
  assert.equal(m.size, 1);
  const a = m.get("agent:cmd");
  assert.equal(a.severity, "error");
  assert.equal(a.messages.length, 2);
});

test("statusIdsTb: the ports do not decorate the TB; empty decos -> nothing", () => {
  const decos = decosFromFindings([
    F("ignored-and-mapped", "warning", { port: "x", agent: "rsp" }),
  ]);
  // the only target is port -> nothing in TB (the agent is NOT targeted by ignored)
  assert.equal(statusIdsTb(decos, new Set(["agent:rsp", "env"])).size, 0);
  assert.equal(statusIdsTb([], new Set(["env"])).size, 0);
});

// --- docs/08 R3: the new scopes, the repairs, the tree mapping ---------------
test("R3: the unknown-agent findings target the scoreboard/coverage box with a repair", () => {
  const decos = decosFromFindings([
    F("sb-unknown-agent", "error", { sb: "sbd", field: "monitor", agent: "ghost", named: 1, node: "sbd" }),
    F("cov-unknown-agent", "error", { agent: "nobody" }),
  ]);
  const sb = decos.find((d) => d.scope === "scoreboard");
  assert.equal(sb.name, "sbd");
  assert.equal(sb.severity, "error");
  assert.match(sb.message, /monitor names agent "ghost"/);
  assert.deepEqual(sb.fixes.map((f) => [f.action, f.args]), [
    ["deleteComponent", { kind: "scoreboard", name: "sbd" }],
  ]);
  const cov = decos.find((d) => d.scope === "coverage");
  assert.equal(cov.agent, "nobody");
  assert.deepEqual(cov.fixes[0], {
    label: 'Delete coverage for "nobody"',
    action: "deleteComponent",
    args: { kind: "coverage", name: "nobody" },
  });
});

test("reset-undriven: the reset PIN and the Env box, both with the editReset repair", () => {
  const decos = decosFromFindings([F("reset-undriven", "error", { port: "rst_n", repair: "external" })]);
  assert.deepEqual(decos.map((d) => d.scope), ["port", "env"]);
  assert.equal(decos[0].port, "rst_n");
  for (const d of decos) {
    assert.equal(d.severity, "error");
    assert.match(d.message, /rst_n.*driven by nobody/);
    // the SAME gesture as the inspector's "Driven by: the testbench top" row
    assert.deepEqual(d.fixes.map((f) => [f.action, f.args]), [
      ["editReset", { op: "set", name: "rst_n", field: "external", value: "true" }],
    ]);
  }
  // RTL: the badge lands on the DUT's reset pin (symbol view and parent schematic)
  const rtl = statusIdsRtl(decos, {
    viewModule: "buf", dut: "buf", nodes: [{ id: "u_buf", module: "buf" }],
  });
  assert.equal(rtl.get("<port>.rst_n").severity, "error");
  assert.equal(rtl.get("u_buf.rst_n").severity, "error");
  // (review) ... and the pin's badge OFFERS the repair: the RTL view is where
  // "Set as DUT" leaves the user (the port decos used to drop their fixes there)
  assert.equal(rtl.get("<port>.rst_n").fixes[0].action, "editReset");
  assert.equal(rtl.get("u_buf.rst_n").fixes.length, 1);
  // TB root: on Env, with the repair one click away; the tree mirrors it
  const tb = statusIdsTb(decos, new Set(["dut", "env"]));
  assert.equal(tb.get("env").fixes[0].action, "editReset");
  assert.equal(statusIdsTree(decos).get("env").fixes.length, 1);
});

test("reset-undriven (review): `repair: clear` offers dut.reset: '' — never external", () => {
  for (const why of ["no-port", "reset-port"]) {
    const decos = decosFromFindings([
      F("reset-undriven", "error", { port: "rst_n", repair: "clear", why }),
    ]);
    for (const d of decos) {
      assert.deepEqual(d.fixes.map((f) => [f.action, f.args]), [["editReset", { op: "clear" }]]);
      assert.match(d.fixes[0].label, /no reset port/);
    }
    assert.match(decos[0].message, why === "no-port" ? /not a port of the DUT/ : /reset_port/);
  }
});

test("R3: the width repair rides on both the pin and the agent; ignored gets un-ignore", () => {
  const decos = decosFromFindings([
    F("width-mismatch", "warning", { port: "din", declared: 8, expected: 16, agent: "cmd" }),
    F("ignored-and-mapped", "error", { port: "x", agent: "cmd" }),
  ]);
  const fix = { action: "editAgentPort", args: { agent: "cmd", port: "din", field: "width", value: "16" } };
  for (const d of decos.filter((d) => /din/.test(d.message))) {
    assert.equal(d.fixes.length, 1);
    assert.equal(d.fixes[0].action, fix.action);
    assert.deepEqual(d.fixes[0].args, fix.args);
  }
  const ign = decos.find((d) => d.scope === "port" && d.port === "x");
  assert.deepEqual(ign.fixes[0].args, { pins: ["x"] });
  assert.equal(ign.fixes[0].action, "unignorePort");
});

test("R3: statusIdsTb lands on sb:/cov: when present, bubbles onto Env otherwise, keeps fixes", () => {
  const decos = decosFromFindings([
    F("sb-unknown-agent", "error", { sb: "sbd", field: "source", agent: "ghost", named: 1, node: "sbd" }),
    F("cov-unknown-agent", "error", { agent: "nobody" }),
    F("width-mismatch", "warning", { port: "din", declared: 8, expected: 16, agent: "cmd" }),
  ]);
  const env = statusIdsTb(decos, new Set(["sb:sbd", "cov:nobody", "agent:cmd", "env"]));
  assert.equal(env.get("sb:sbd").severity, "error");
  assert.equal(env.get("sb:sbd").fixes.length, 1);
  assert.equal(env.get("cov:nobody").fixes[0].args.name, "nobody");
  assert.equal(env.get("agent:cmd").fixes[0].action, "editAgentPort");
  assert.ok(!env.has("env"), "nothing bubbles while the boxes are on screen");
  const root = statusIdsTb(decos, new Set(["env"]));
  assert.equal(root.size, 1);
  assert.deepEqual(
    root.get("env").messages.map((m) => m.split(":")[0]),
    ["sbd", "nobody_cov", "cmd"],
    "bubbled onto Env, prefixed with the owner"
  );
  assert.equal(root.get("env").severity, "error");
  assert.equal(root.get("env").fixes.length, 3, "the repairs bubble with the messages");
});

test("R3: statusIdsTree decorates the rows AND Env; ports have no row", () => {
  const decos = decosFromFindings([
    F("sb-unknown-agent", "error", { sb: "sbd", field: "source", agent: "ghost", named: 1, node: "sbd" }),
    F("ignored-and-mapped", "error", { port: "x", agent: "cmd" }),
    F("port-orphan", "warning", { port: "gone", dut: "chan", agent: "cmd" }),
  ]);
  const tree = statusIdsTree(decos);
  assert.deepEqual([...tree.keys()].sort(), ["agent:cmd", "env", "sb:sbd"]);
  assert.equal(tree.get("agent:cmd").severity, "warning");
  assert.equal(tree.get("env").severity, "error", "the error child wins on Env");
  assert.equal(tree.get("env").messages.length, 2);
});

test("R3 (review): no delete repair on an unnamed scoreboard; the `#n` key lands on the right box", () => {
  const decos = decosFromFindings([
    F("sb-unknown-agent", "error", { sb: "sbd", field: "source", agent: "ghost", named: 0, node: "sbd#2" }),
    F("sb-unknown-agent", "error", { sb: "sbd", field: "monitor", agent: "ghost", named: 0 }),
  ]);
  assert.deepEqual(decos.map((d) => d.fixes.length), [0, 0], "a by-name delete would hit nothing or the WRONG entry");
  const m = statusIdsTb(decos, new Set(["sb:sbd", "sb:sbd#2", "env"]));
  assert.ok(m.has("sb:sbd#2"), "the badge sits on the second box, like its broken stub");
  assert.ok(!m.has("sb:sbd"), "the valid first box is untouched");
  assert.ok(m.has("env"), "the undrawn entry bubbles onto Env");
  assert.equal(statusIdsTree(decos).has("sb:sbd#2"), true);
});

test("R3 (review, D19): the message override feeds the tree with localized text", () => {
  const decos = decosFromFindings(
    [F("width-mismatch", "warning", { port: "din", declared: 8, expected: 16, agent: "cmd" })],
    (f) => `LOCALIZED ${f.kind}`
  );
  assert.ok(decos.every((d) => d.message === "LOCALIZED width-mismatch"));
  assert.equal(decos[0].fixes.length, 1, "the repairs are untouched by the override");
});

console.log(`\ntest-status: ${passed} tests passed.`);
