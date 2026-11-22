// Node tests for the leveled verification tree (src/tbtree-build.ts —
// pure, no vscode): npm run test:tbtree
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-tbtree-"));
const outFile = join(outDir, "tbtree.mjs");
await esbuild.build({
  entryPoints: ["src/tbtree-build.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { buildVTree } = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}
function find(nodes, pred) {
  for (const n of nodes) {
    if (pred(n)) return n;
    const f = find(n.children, pred);
    if (f) return f;
  }
  return null;
}

const CFG = {
  project: { name: "demo" },
  dut: { name: "soc_top", clock: "clk" },
  agents: [{ name: "cmd" }, { name: "rsp", active: false }],
  analysis: {
    coverage: ["cmd"],
    scoreboards: [{ name: "sbd", source: "cmd", monitor: "rsp" }],
  },
  probes: [{ name: "lvl", path: "u.lvl", width: 3 }],
};

const { roots, byFocus, byIdent } = buildVTree(CFG, "demo.quickuvm.yaml");

test("the Testbench root, with DUT + Env; Env with agents", () => {
  assert.equal(roots.length, 1);
  assert.equal(roots[0].label, "demo (tb)");
  assert.equal(roots[0].focus, "");
  const kids = roots[0].children.map((c) => c.label);
  assert.ok(kids.includes("soc_top") && kids.includes("Env"));
  const env = find(roots, (n) => n.focus === "env" && n.selectId === null);
  const agentCmd = env.children.find((c) => c.focus === "agent:cmd");
  assert.ok(agentCmd);
  assert.deepEqual(
    agentCmd.children.map((c) => c.label).sort(),
    ["driver", "monitor", "sequencer"]
  );
});

test("nav: the containers open their own level; the leaves open the parent + select", () => {
  const env = find(roots, (n) => n.label === "Env");
  assert.equal(env.focus, "env");
  assert.equal(env.selectId, null); // click on Env -> opens the env level
  const seq = find(roots, (n) => n.label === "sequencer");
  assert.equal(seq.focus, "agent:cmd"); // opens the agent level
  assert.equal(seq.selectId, "u.sequencer"); // and selects the sequencer
  const sb = find(roots, (n) => n.label === "sbd");
  assert.equal(sb.focus, "env");
  assert.equal(sb.selectId, "sb:sbd");
  const dut = find(roots, (n) => n.label === "soc_top");
  assert.equal(dut.focus, "");
  assert.equal(dut.selectId, "dut");
});

test("reveal indexes: byFocus (drill) + byIdent (selection)", () => {
  assert.ok(byFocus.get("") && byFocus.get("env") && byFocus.get("agent:cmd"));
  // reveal the selected agent:cmd block at the env level
  assert.equal(byIdent.get("env|agent:cmd")?.focus, "agent:cmd");
  // reveal the selected sequencer at the agent level
  assert.equal(byIdent.get("agent:cmd|u.sequencer")?.label, "sequencer");
  // reveal dut at the top level
  assert.equal(byIdent.get("|dut")?.label, "soc_top");
});

test("passive agent: monitor only; empty config -> empty tree", () => {
  const rsp = find(roots, (n) => n.focus === "agent:rsp");
  assert.deepEqual(rsp.children.map((c) => c.label), ["monitor"]);
  assert.deepEqual(buildVTree({}, null).roots, []);
});

console.log(`\ntest-tbtree: ${passed} tests passed.`);
