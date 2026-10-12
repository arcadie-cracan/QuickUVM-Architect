// Node tests for the designer-assistance proposals (src/proposals.ts — docs/08
// R12): interfaces without an agent, pin groups by prefix, unwired subsystems
// and the inferred components of an implicit-mode bench. Never automatic,
// ambiguous = no proposal.
//   npm run test:proposals
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-proposals-"));
const outFile = join(outDir, "proposals.mjs");
await esbuild.build({
  entryPoints: ["src/proposals.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  // compose.ts reaches yamlops (the CJS `yaml` package): the standard shim
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const { agentProposals, connectionsProposal, ghostProposals, proposalsFor } = await import(
  pathToFileURL(outFile)
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const MODEL = JSON.parse(readFileSync("examples/model.json", "utf8"));
const SOC = "demo_top.u_soc";
const port = (name, dir, width) => ({
  name, dir, type: "logic", width, unpacked_dims: null, elem_width: null, loc: null,
});

test("regression model: the DUT's interface port without an agent is proposed, nothing else", () => {
  const cfg = { dut: { name: "soc_top", clock: "clk", reset: "rst_n" }, agents: [] };
  const items = agentProposals(MODEL, SOC, cfg);
  assert.deepEqual(items.map((i) => i.id), ["iface:bus"], "ch_out alone is no group");
  const bus = items[0];
  assert.equal(bus.kind, "agent-iface");
  assert.equal(bus.action, "createAgentFromIface");
  assert.deepEqual(bus.args, { viewId: SOC, port: "bus", name: "bus" });
  assert.match(bus.label, /from interface reg_bus\.slave/);
  assert.match(bus.detail, /addr/);
});

test("an interface is covered by an agent of the port's name, or by one declaring its modport signals", () => {
  const dut = { name: "soc_top", clock: "clk", reset: "rst_n" };
  assert.deepEqual(agentProposals(MODEL, SOC, { dut, agents: [{ name: "bus" }] }), []);
  const regs = { name: "regs", ports: { inputs: [{ name: "addr", width: 8 }, { name: "wdata", width: 8 }, { name: "we" }] } };
  assert.deepEqual(agentProposals(MODEL, SOC, { dut, agents: [regs] }), []);
  // an agent on DUT pins does not cover the interface
  const cmd = { name: "cmd", ports: { inputs: [{ name: "din", width: 8 }] } };
  assert.deepEqual(agentProposals(MODEL, SOC, { dut, agents: [cmd] }).map((i) => i.id), ["iface:bus"]);
});

test("only the DUT's own view proposes agents", () => {
  const cfg = { dut: { name: "adder" }, agents: [] };
  assert.deepEqual(agentProposals(MODEL, SOC, cfg), []);
  assert.deepEqual(agentProposals(MODEL, "demo_top", { dut: { name: "soc_top" } }), []);
  assert.deepEqual(agentProposals(MODEL, SOC, { agents: [] }), [], "no DUT at all");
});

// a YAPP-like router: prefixed pin groups, a clock/reset by name, a lone pin,
// an unsized port
const ROUTER = {
  schema_version: 1,
  tops: ["router"],
  modules: {
    router: {
      ports: [
        port("clock", "in", 1), port("reset", "in", 1),
        port("in_data", "in", 8), port("in_addr", "in", 2), port("in_valid", "in", 1), port("in_suspend", "out", 1),
        port("out0_data", "out", 8), port("out0_valid", "out", 1), port("out0_suspend", "in", 1),
        port("error", "out", 1), port("mem", "in", null),
      ],
      iface_ports: [],
      loc: null,
    },
  },
  instances: [{ path: "router", module: "router", params: {}, loc: null }],
  views: {},
};

test("pin groups by prefix: in_* and out0_*; clock/reset by name, a lone pin and an unsized port stay out", () => {
  const items = agentProposals(ROUTER, "router", { dut: { name: "router" }, agents: [] });
  assert.deepEqual(items.map((i) => i.id), ["group:in", "group:out0"]);
  assert.equal(items[0].kind, "agent-group");
  assert.equal(items[0].action, "createAgentFromPins");
  assert.deepEqual(items[0].args, {
    viewId: "router",
    pins: ["<port>.in_data", "<port>.in_addr", "<port>.in_valid", "<port>.in_suspend"],
    name: "in",
  });
  assert.equal(items[0].label, 'Agent "in" from 4 pins in_*');
  assert.deepEqual(items[1].args.pins, ["<port>.out0_data", "<port>.out0_valid", "<port>.out0_suspend"]);
});

test("claimed pins leave their group; a waived pin too; an agent of the prefix's name that claims nothing = ambiguous, skipped", () => {
  const dut = { name: "router", clock: "clock", reset: "reset" };
  const inAgent = { name: "in", ports: { inputs: [{ name: "in_data", width: 8 }, { name: "in_addr", width: 2 }, { name: "in_valid" }], outputs: [{ name: "in_suspend" }] } };
  assert.deepEqual(agentProposals(ROUTER, "router", { dut, agents: [inAgent] }).map((i) => i.id), ["group:out0"]);
  assert.deepEqual(
    agentProposals(ROUTER, "router", { dut, agents: [{ name: "in" }] }).map((i) => i.id),
    ["group:out0"],
    "the name is taken by an agent that does not claim the pins: no proposal for it"
  );
  const waived = { dut: { ...dut, unverified_ports: ["out0_suspend", "out0_valid"] }, agents: [] };
  const items = agentProposals(ROUTER, "router", waived);
  assert.deepEqual(items.map((i) => i.id), ["group:in"], "a group of one is no group");
  // two claimed out of four still leave a pair
  const two = { name: "x", ports: { inputs: [{ name: "in_data", width: 8 }, { name: "in_addr", width: 2 }] } };
  assert.deepEqual(
    agentProposals(ROUTER, "router", { dut, agents: [two] }).find((i) => i.id === "group:in").args.pins,
    ["<port>.in_valid", "<port>.in_suspend"]
  );
});

// the composition fixture of test-compose: a producer wired to a consumer
function mkModel(view) {
  const modules = {};
  const instances = [{ path: "top", module: "sys", params: {}, loc: null }];
  for (const [rel, m] of Object.entries(view.children)) {
    instances.push({ path: `top.${rel}`, module: m.module, params: {}, loc: null });
    modules[m.module] = { ports: m.ports.map((p) => port(p.name, p.dir, p.width)), iface_ports: [], loc: null };
  }
  modules.sys = { ports: [], iface_ports: [], loc: null };
  return { schema_version: 1, tops: ["top"], modules, instances, views: { top: { module: "sys", pins: [], nets: view.nets } } };
}
const PIPE = mkModel({
  children: {
    u_prod: { module: "producer", ports: [{ name: "dout", dir: "out", width: 8 }] },
    u_cons: { module: "consumer", ports: [{ name: "din", dir: "in", width: 8 }] },
  },
  nets: [{ name: "stream", endpoints: ["u_prod.dout", "u_cons.din"], fanout: 2, render: "wire" }],
});

test("an unwired subsystem proposes the derived connections; a wired one, or a single subenv, does not", () => {
  const dut = { name: "sys" };
  const subenvs = [{ name: "u_prod", config: "a.yaml" }, { name: "u_cons", config: "b.yaml" }];
  const items = connectionsProposal(PIPE, "top", { dut, subenvs });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "connections");
  assert.equal(items[0].action, "wireConnections");
  assert.deepEqual(items[0].args, { viewId: "top" });
  assert.equal(items[0].label, "Wire 1 connection between the composed blocks");
  assert.equal(items[0].detail, "u_prod.dout → u_cons.din");
  assert.deepEqual(connectionsProposal(PIPE, "top", { dut, subenvs, connections: [{ from: "u_prod.dout", to: "u_cons.din" }] }), []);
  assert.deepEqual(connectionsProposal(PIPE, "top", { dut, subenvs: [subenvs[0]] }), []);
  assert.deepEqual(connectionsProposal(PIPE, "top", { dut: { name: "other" }, subenvs }), [], "not the DUT's view");
});

const RESOLVED = {
  version: "1.1.0",
  dut: "d",
  analysis: {
    mode: "implicit",
    scoreboards: [{ name: "sbd", source: "pkt", origin: "inferred" }],
    coverage: [{ agent: "pkt", origin: "inferred" }],
  },
  tests: [],
  virtual_sequences: [],
  agents: [],
  guards: [],
};

test("an implicit-mode bench proposes its inferred components; a declared one proposes nothing", () => {
  const cfg = { dut: { name: "d" }, agents: [{ name: "pkt" }] };
  const items = ghostProposals(cfg, RESOLVED);
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [["ghost:sb:sbd", "materialize"], ["ghost:cov:pkt", "materialize"]]);
  assert.equal(items[0].label, 'Scoreboard "sbd" fed by pkt');
  assert.equal(items[1].label, "Coverage on pkt");
  assert.deepEqual(ghostProposals({ ...cfg, analysis: {} }, RESOLVED), [], "declared mode: nothing inferred");
  assert.deepEqual(ghostProposals(cfg, null), [], "nothing resolved: nothing to propose");
});

test("proposalsFor picks the source by view: ghosts in the TB view, agents in the RTL views, nothing without a config", () => {
  const cfg = { dut: { name: "soc_top", clock: "clk", reset: "rst_n" }, agents: [] };
  assert.deepEqual(proposalsFor(MODEL, "tb:x.yaml", "tb", cfg, RESOLVED).items.map((i) => i.id), ["ghost:sb:sbd", "ghost:cov:pkt"]);
  const rtl = proposalsFor(MODEL, SOC, "symbol", cfg, RESOLVED);
  assert.deepEqual(rtl.items.map((i) => i.id), ["iface:bus"]);
  assert.deepEqual(rtl, { viewId: SOC, mode: "symbol", items: rtl.items });
  assert.deepEqual(proposalsFor(MODEL, SOC, "schematic", null, RESOLVED).items, []);
  assert.deepEqual(proposalsFor(undefined, SOC, "symbol", cfg, null).items, [], "no model: no RTL proposals");
});

console.log(`\ntest-proposals: ${passed} tests passed.`);
