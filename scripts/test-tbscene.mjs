// Node tests for the FLAT PER-LEVEL scene of the verification view
// (src/webview/tbscene.ts — QuvmConfig + focus -> TbScene, no DOM):
//   npm run test:tbscene
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-tbscene-"));
const outFile = join(outDir, "tbscene.mjs");
await esbuild.build({
  entryPoints: ["src/webview/tbscene.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { buildTbScene } = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}
const nodeById = (s, id) => s.nodes.find((n) => n.id === id);

const CFG = {
  project: { name: "demo" },
  dut: { name: "soc_top", clock: "clk", reset: "rst_n" },
  agents: [
    { name: "cmd", interface: "cmd_if" },
    { name: "rsp", active: false },
  ],
  analysis: {
    coverage: ["cmd"],
    scoreboards: [{ name: "sbd", source: "cmd", monitor: "rsp",
      match: "out_of_order", match_key: "id" }],
  },
  virtual_sequences: [{ name: "smoke", body: [{ agent: "cmd", sequence: "cmd_seq" }] }],
  probes: [{ name: "lvl", path: "u.lvl", width: 3 }],
};

test("nivel testbench (focus=''): DUT + Env, Env cu drill", () => {
  const s = buildTbScene(CFG, "", "demo.quickuvm.yaml");
  assert.equal(s.viewId, "tb:demo.quickuvm.yaml");
  assert.equal(s.focus, "");
  assert.deepEqual(s.breadcrumb, [{ label: "demo (tb)", focus: "" }]);
  const ids = s.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["dut", "env"]);
  assert.equal(nodeById(s, "env").drill, "env");
  assert.equal(nodeById(s, "dut").drill, null);
  // env <-> dut interface, per agent
  assert.ok(s.edges.some((e) => e.id === "e:if:cmd" && e.kind === "iface"));
  // Env has the components listed as UML text (compartments)
  const env = nodeById(s, "env");
  assert.ok(env.compartments.some((c) => c.items.includes("cmd")));
  assert.ok(env.stereotype.includes("env"));
});

test("nivel Env (focus='env'): agenti + analiza + boundary interfata", () => {
  const s = buildTbScene(CFG, "env", "demo.quickuvm.yaml");
  assert.deepEqual(
    s.breadcrumb.map((c) => c.focus),
    ["", "env"]
  );
  const ids = s.nodes.map((n) => n.id);
  assert.ok(ids.includes("agent:cmd") && ids.includes("agent:rsp"));
  assert.ok(ids.includes("sb:sbd") && ids.includes("cov:cmd") && ids.includes("vsqr"));
  // the agent has drill + components in compartments
  const cmd = nodeById(s, "agent:cmd");
  assert.equal(cmd.drill, "agent:cmd");
  assert.ok(cmd.compartments.some((c) => c.items.includes("sequencer")));
  assert.equal(cmd.stereotype, "«active agent»");
  assert.equal(nodeById(s, "agent:rsp").stereotype, "«passive agent»");
  // boundary flags: interface to the DUT + internals (config has probes)
  const bids = s.boundary.map((b) => b.id).sort();
  assert.deepEqual(bids, ["<if>.cmd", "<if>.rsp", "<internals>"]);
  // agent.if -> boundary; agent.ap -> scoreboard
  assert.ok(s.edges.some((e) => e.source === "agent:cmd" && e.target === "<if>.cmd"));
  assert.ok(s.edges.some((e) => e.id === "e:sb:sbd.source" && e.source === "agent:cmd"));
});

test("nivel agent (focus='agent:cmd'): sequencer/driver/monitor + boundary", () => {
  const s = buildTbScene(CFG, "agent:cmd", "demo.quickuvm.yaml");
  assert.deepEqual(
    s.breadcrumb.map((c) => c.label),
    ["demo (tb)", "Env", "cmd"]
  );
  const ids = s.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["u.driver", "u.monitor", "u.sequencer"]);
  // boundaries: sqr (vsqr), if (DUT), ap
  const bids = s.boundary.map((b) => b.id).sort();
  assert.deepEqual(bids, ["<ap>", "<if>", "<sqr>"]);
  // sequencer -> driver -> if; if -> monitor -> ap
  assert.ok(s.edges.some((e) => e.source === "u.sequencer" && e.target === "u.driver"));
  assert.ok(s.edges.some((e) => e.source === "u.driver" && e.target === "<if>"));
  assert.ok(s.edges.some((e) => e.source === "<if>" && e.target === "u.monitor"));
  assert.ok(s.edges.some((e) => e.source === "u.monitor" && e.target === "<ap>"));
  // the boundaries' direction, inferred from edges: sqr = input (toward sequencer),
  // if = bidirectional interface (driver drives + monitor samples),
  // ap = output (from monitor)
  const dir = (id) => s.boundary.find((b) => b.id === id).dir;
  assert.equal(dir("<sqr>"), "in");
  assert.equal(dir("<if>"), "inout");
  assert.equal(dir("<ap>"), "out");
});

test("agent pasiv: doar monitor, fara sequencer/driver", () => {
  const s = buildTbScene(CFG, "agent:rsp", null);
  assert.deepEqual(s.nodes.map((n) => n.id), ["u.monitor"]);
  assert.ok(!s.edges.some((e) => e.source === "u.sequencer"));
});

test("nivel inexistent -> null; config gol -> null", () => {
  assert.equal(buildTbScene(CFG, "agent:xyz", null), null);
  assert.equal(buildTbScene({}, "", null), null);
});

test("bench subsystem: DUT prefix de clasa, nu se deseneaza; Env cu subenvs", () => {
  const s = buildTbScene(
    {
      dut: { name: "top" },
      subenvs: [
        { name: "u_a", config: "a.yaml" },
        { name: "u_b", config: "b.yaml", params: { W: 8 } },
      ],
      connections: [{ from: "u_a.dout", to: "u_b.din" }],
    },
    "env",
    null
  );
  assert.equal(nodeById(s, "dut"), undefined);
  assert.ok(nodeById(s, "sub:u_a") && nodeById(s, "sub:u_b"));
  assert.ok(s.edges.some((e) => e.source === "sub:u_a" && e.target === "sub:u_b"));
  // drill into the composed block (docs/05): `config:<PATH>` (the config path, not
  // the name) when the subenv has a config — each block opens ITS file
  assert.equal(nodeById(s, "sub:u_a").drill, "config:a.yaml");
  assert.equal(nodeById(s, "sub:u_b").drill, "config:b.yaml");
  // a subenv WITHOUT a config stays a leaf (nothing to open)
  const noCfg = buildTbScene(
    { dut: { name: "top" }, subenvs: [{ name: "u_x" }, { name: "u_y", config: "y.yaml" }] },
    "env",
    null
  );
  assert.equal(nodeById(noCfg, "sub:u_x").drill, null);
  assert.equal(nodeById(noCfg, "sub:u_y").drill, "config:y.yaml");
});

test("subenv-uri cu ACELASI nume: noduri distincte, fiecare cu config-ul lui", () => {
  // hand-written YAML, invalid for quick-uvm but drawn honestly: the node ids
  // dedup (#n), and the drill carries its own path — the second block does NOT
  // collapse silently into the first (adversarial review loose-ends)
  const s = buildTbScene(
    {
      dut: { name: "top" },
      subenvs: [
        { name: "ch", config: "a.quickuvm.yaml" },
        { name: "ch", config: "b.quickuvm.yaml" },
      ],
    },
    "env",
    null
  );
  const subs = s.nodes.filter((n) => n.kind === "tbsubenv");
  assert.equal(subs.length, 2);
  assert.deepEqual(subs.map((n) => n.id).sort(), ["sub:ch", "sub:ch#2"]);
  // each drill opens ITS FILE (not both on the first)
  assert.deepEqual(subs.map((n) => n.drill).sort(), [
    "config:a.quickuvm.yaml",
    "config:b.quickuvm.yaml",
  ]);
});

test("subenv cu config ABSOLUT: drill-ul poarta calea absoluta ca atare", () => {
  const s = buildTbScene(
    { dut: { name: "top" }, subenvs: [{ name: "u", config: "C:/abs/x.quickuvm.yaml" }] },
    "env",
    null
  );
  // the host (openSubenvConfig) resolves it with Uri.file, not joinPath
  assert.equal(nodeById(s, "sub:u").drill, "config:C:/abs/x.quickuvm.yaml");
  // at the top level of a PURE subsystem (subenvs, no agents): only Env
  const topS = buildTbScene(
    { dut: { name: "top" }, subenvs: [{ name: "u_a", config: "a.yaml" }] },
    "",
    null
  );
  assert.deepEqual(topS.nodes.map((n) => n.id), ["env"]);
});

test("bench hibrid (DUT + agenti + subenvs): DUT desenat + interfata env<->dut", () => {
  // demo_top: soc_top is the DUT verified directly by agent1, and the channels are
  // sub-envs — the DUT MUST appear (D24: TB root = DUT + Env)
  const cfg = {
    dut: { name: "soc_top", clock: "clk", reset: "rst_n" },
    agents: [{ name: "agent1", interface: "reg_bus" }],
    layout: "packaged",
    subenvs: [{ name: "u_ch0", config: "chan.yaml" }, { name: "u_ch1", config: "chan.yaml" }],
  };
  const top = buildTbScene(cfg, "", "demo.quickuvm.yaml");
  assert.deepEqual(top.nodes.map((n) => n.id).sort(), ["dut", "env"]);
  assert.equal(nodeById(top, "dut").label, "soc_top");
  // Env lists both the agents and the sub-envs
  const env = nodeById(top, "env");
  assert.ok(env.compartments.some((c) => c.items.includes("agent1")));
  assert.ok(env.compartments.some((c) => c.items.includes("u_ch0")));
  // env <-> dut interface (the agent drives its DUT directly)
  assert.ok(top.edges.some((e) => e.id === "e:if:agent1" && e.source === "env" && e.target === "dut"));
  // at the env level, the <if> boundary to the DUT appears (hasDut)
  const envLvl = buildTbScene(cfg, "env", "demo.quickuvm.yaml");
  assert.ok(envLvl.boundary.some((b) => b.id === "<if>.agent1"));
});

test("probe 'tap' nu colizioneaza; probele in compartiment + granita internals", () => {
  const s = buildTbScene(
    {
      dut: { name: "d" },
      agents: [{ name: "a" }],
      probes: [{ name: "tap", path: "u.s", width: 2 }],
    },
    "env",
    null
  );
  const probes = nodeById(s, "probes");
  const ids = probes.ports.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(s.boundary.some((b) => b.id === "<internals>"));
  // the internals edge targets the renamed WEST connector, not the EAST signal
  const e = s.edges.find((x) => x.id === "e:probes");
  assert.equal(e.targetPort, "probes._tap");
  assert.equal(probes.ports.find((pp) => pp.id === "probes._tap").side, "WEST");
});

test("regresie: probe fara agenti (env gol) nu produce muchie/port dangling", () => {
  const s = buildTbScene(
    { dut: { name: "fifo" }, probes: [{ name: "lvl", path: "u.p", width: 4 }] },
    "",
    null
  );
  assert.deepEqual(s.nodes.map((n) => n.id), ["dut"]);
  assert.ok(!s.edges.some((e) => e.target === "env"));
  assert.ok(!s.nodes[0].ports.some((pp) => pp.port === "internals"));
});

console.log(`\ntest-tbscene: ${passed} teste au trecut.`);
