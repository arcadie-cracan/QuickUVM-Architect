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
const { decosFromFindings, statusIdsRtl, statusIdsTb } = await import(
  pathToFileURL(outFile)
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const F = (kind, severity, params) => ({ kind, severity, params, span: null });

test("decosFromFindings: fiecare fel isi gaseste tinta semantica", () => {
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

test("statusIdsRtl: vederea DUT-ului -> steag; instantele de DUT -> pini", () => {
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

test("statusIdsRtl: fara DUT sau vedere nelegata -> nimic", () => {
  const decos = decosFromFindings([
    F("port-claimed", "error", { port: "clk", agent: "cmd" }),
  ]);
  assert.equal(statusIdsRtl(decos, { viewModule: "x", dut: null, nodes: [] }).size, 0);
  assert.equal(
    statusIdsRtl(decos, { viewModule: "adder", dut: "chan", nodes: [] }).size,
    0
  );
});

test("statusIdsTb: agent prezent -> blocul lui; env -> nodul env", () => {
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

test("statusIdsTb: agregare — doua probleme pe acelasi agent, un badge", () => {
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

test("statusIdsTb: porturile nu decoreaza TB; decos gol -> nimic", () => {
  const decos = decosFromFindings([
    F("ignored-and-mapped", "warning", { port: "x", agent: "rsp" }),
  ]);
  // the only target is port -> nothing in TB (the agent is NOT targeted by ignored)
  assert.equal(statusIdsTb(decos, new Set(["agent:rsp", "env"])).size, 0);
  assert.equal(statusIdsTb([], new Set(["env"])).size, 0);
});

console.log(`\ntest-status: ${passed} teste au trecut.`);
