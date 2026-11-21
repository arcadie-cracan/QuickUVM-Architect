// Node tests for the "New testbench" templates (src/templates.ts — docs/08
// R24): one agent per interface, one agent per clock domain, composition from
// the sub-blocks. Each plan is a fold of the existing text mutations; the tests
// check WHAT it writes (and that it writes nothing nobody asked for) on the
// regression model and on small hand-made models. The plans are generated for
// real in `npm run test:e2e`.
//   npm run test:templates
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-templates-"));
async function build(entry) {
  const out = join(outDir, entry.replace(/\W/g, "_") + ".mjs");
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  return import(pathToFileURL(out));
}
const T = await build("src/templates.ts");
const { parseQuvm } = await build("src/yamlops.ts");
const model = JSON.parse(readFileSync("examples/model.json", "utf8"));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const port = (name, dir, width = 1, extra = {}) => ({
  name, dir, type: "logic", width, unpacked_dims: null, elem_width: null, loc: null, ...extra,
});
/** a one-module model: the module is its own top instance */
function single(module, ports, iface_ports = []) {
  return {
    schema_version: 1,
    tops: [module],
    modules: { [module]: { ports, iface_ports, loc: null } },
    instances: [{ path: module, module, params: {}, loc: null }],
    views: {},
  };
}
const offer = (m, view, id) => T.templateOffers(m, view).find((o) => o.id === id);
const keys = (text) => Object.keys(parseQuvm(text));

const CDC = single("cdc_fifo", [
  port("src_clk_i", "in"), port("src_rst_ni", "in"),
  port("src_data_i", "in", 8), port("src_valid_i", "in"), port("src_ready_o", "out"),
  port("dst_clk_i", "in"), port("dst_rst_ni", "in"),
  port("dst_data_o", "out", 8), port("dst_valid_o", "out"), port("dst_ready_i", "in"),
]);

// ------------------------------------------------------------------ offers
test("offers: each template says what it would create, or why it cannot", () => {
  const top = T.templateOffers(model, "demo_top");
  assert.deepEqual(top.map((o) => [o.id, o.available]), [
    ["per-interface", false], ["per-clock", false], ["composition", false],
  ]);
  assert.match(top[2].detail, /one sub-block/);
  const soc = T.templateOffers(model, "demo_top.u_soc");
  assert.deepEqual(soc.map((o) => o.available), [true, false, true]);
  assert.match(soc[0].detail, /agent "bus"/);
  assert.match(soc[1].detail, /one clock \(clk\)/);
  assert.match(soc[2].detail, /5 subenvs/);
  assert.throws(() => T.planTemplate(model, "no.such.path", "per-interface"), T.TemplateError);
  assert.throws(() => T.planTemplate(model, "demo_top.bus_i", "per-interface"), T.TemplateError, "an interface instance is not a module");
});

// ---------------------------------------------------------- per interface
test("per-interface: the DUT by heuristic, one agent per interface, what is left is SAID", () => {
  const p = T.planTemplate(model, "demo_top.u_soc", "per-interface");
  assert.equal(p.file, "soc_top.quickuvm.yaml");
  const cfg = parseQuvm(p.text);
  assert.deepEqual(cfg.dut, { name: "soc_top", clock: "clk", reset: "rst_n" });
  assert.deepEqual(cfg.agents.map((a) => a.name), ["bus"]);
  assert.deepEqual(cfg.agents[0].ports.inputs.map((x) => x.name), ["addr", "wdata", "we"], "the modport's signals, the DUT's directions");
  assert.deepEqual(keys(p.text), ["project", "clock", "tests", "dut", "agents"], "no key nobody asked for");
  assert.ok(p.notes.some((n) => /without an agent.*din/.test(n)), "the ungrouped pins are named");
  assert.ok(p.notes.some((n) => /unpacked.*ch_out/.test(n)), "an unpacked array is not guessed");
  assert.equal(p.children.length, 0);
});

test("per-interface: pin groups by prefix (the R12 proposals); no group at all = one boundary agent", () => {
  const grouped = single("buf", [
    port("clk", "in"), port("rst_n", "in"),
    port("in_data", "in", 8), port("in_valid", "in"), port("in_ready", "out"),
    port("out_data", "out", 8), port("out_valid", "out"), port("out_ready", "in"),
    port("reg_addr", "in", 4), port("reg_wdata", "in", 8),
    port("irq", "out"),
  ]);
  const p = T.planTemplate(grouped, "buf", "per-interface", { seqItemStyle: "field_macros" });
  const cfg = parseQuvm(p.text);
  assert.deepEqual(cfg.agents.map((a) => a.name), ["in", "out"]);
  assert.deepEqual(cfg.agents[0].ports.inputs.map((x) => x.name), ["in_data", "in_valid"]);
  assert.deepEqual(cfg.agents[0].ports.outputs.map((x) => [x.name, x.randomize]), [["in_ready", false]]);
  assert.equal(cfg.agents[0].seq_item_style, "field_macros");
  // `reg` is an SV keyword: an agent of that name compiles nowhere — refused, and said
  assert.ok(p.notes.some((n) => /"reg" is not a usable agent name/.test(n)));
  assert.ok(p.notes.some((n) => /without an agent.*reg_addr.*irq|without an agent.*irq/.test(n)));

  const flat = T.planTemplate(model, "demo_top.u_soc.u_add", "per-interface");
  const add = parseQuvm(flat.text);
  assert.deepEqual(add.agents.map((a) => a.name), ["adder_a"], "the module name is in it (a shared namespace when composed)");
  assert.equal(add.dut.combinational, true);
  assert.match(flat.summary.join("\n"), /the whole boundary/);
});

// --------------------------------------------------------- per clock domain
test("domain tag: what is left of a clock / reset name without its token", () => {
  const tag = (n, k) => T.domainTag(n, k);
  assert.deepEqual(tag("src_clk_i", "clock"), { tag: "src", fused: false });
  assert.deepEqual(tag("clk_a", "clock"), { tag: "a", fused: false });
  assert.deepEqual(tag("clk", "clock"), { tag: "", fused: false });
  assert.deepEqual(tag("wclk", "clock"), { tag: "w", fused: true });
  assert.deepEqual(tag("fast_clock_i", "clock"), { tag: "fast", fused: false });
  assert.deepEqual(tag("src_rst_ni", "reset"), { tag: "src", fused: false });
  assert.deepEqual(tag("rst_n", "reset"), { tag: "", fused: false });
  assert.deepEqual(tag("wrst_n", "reset"), { tag: "w", fused: true });
  assert.deepEqual(tag("aresetn", "reset"), { tag: "a", fused: true });
});

test("per-clock: a clock list, a reset list bound to it, one agent per domain", () => {
  const p = T.planTemplate(CDC, "cdc_fifo", "per-clock");
  const cfg = parseQuvm(p.text);
  assert.deepEqual(cfg.dut, { name: "cdc_fifo", clock: "src_clk_i", reset: "src_rst_ni" });
  assert.deepEqual(cfg.clock, [
    { name: "src_clk_i", period: 10, unit: "ns" },
    { name: "dst_clk_i" },
  ], "the first domain keeps the skeleton's period; the others take the generator's default");
  assert.deepEqual(cfg.reset, [
    { name: "src_rst_ni", clock: "src_clk_i" },
    { name: "dst_rst_ni", clock: "dst_clk_i" },
  ]);
  assert.deepEqual(
    cfg.agents.map((a) => [a.name, a.clock, a.reset, a.ports.inputs.map((x) => x.name), a.ports.outputs.map((x) => x.name)]),
    [
      ["src", "src_clk_i", "src_rst_ni", ["src_data_i", "src_valid_i"], ["src_ready_o"]],
      ["dst", "dst_clk_i", "dst_rst_ni", ["dst_ready_i"], ["dst_data_o", "dst_valid_o"]],
    ]
  );
  assert.deepEqual(keys(p.text), ["project", "clock", "tests", "dut", "reset", "agents"]);
  assert.deepEqual(p.notes, []);
});

test("per-clock: fused names (wclk / rclk), an active-high reset, a domain nobody is on", () => {
  const fifo = single("afifo", [
    port("wclk", "in"), port("wrst", "in"), port("wdata", "in", 8), port("winc", "in"), port("wfull", "out"),
    port("rclk", "in"), port("rrst", "in"), port("rdata", "out", 8), port("rinc", "in"), port("rempty", "out"),
    port("scan_clk", "in"),
  ]);
  const p = T.planTemplate(fifo, "afifo", "per-clock");
  const cfg = parseQuvm(p.text);
  assert.deepEqual(cfg.clock.map((d) => d.name), ["wclk", "rclk", "scan_clk"]);
  assert.deepEqual(cfg.reset, [
    { name: "wrst", active_low: false, clock: "wclk" },
    { name: "rrst", clock: "rclk", active_low: false },
  ].map((d) => ({ name: d.name, active_low: false, clock: d.clock })), "the polarity is the name's");
  assert.deepEqual(cfg.agents.map((a) => [a.name, a.clock, a.reset]), [["w", "wclk", "wrst"], ["r", "rclk", "rrst"]]);
  assert.deepEqual(cfg.agents[0].ports.inputs.map((x) => x.name), ["wdata", "winc"]);
  assert.ok(p.notes.some((n) => /scan_clk: no pin carries its name/.test(n)));
});

test("per-clock: an untagged clock is the default domain; one shared reset stays a single reset", () => {
  const m = single("bridge", [
    port("clk", "in"), port("rst_n", "in"), port("fast_clk", "in"),
    port("req", "in"), port("ack", "out"),
    port("fast_data", "in", 4), port("fast_vld", "out"),
  ]);
  const p = T.planTemplate(m, "bridge", "per-clock");
  const cfg = parseQuvm(p.text);
  assert.deepEqual(cfg.clock.map((d) => d.name), ["clk", "fast_clk"]);
  assert.equal(cfg.reset, undefined, "one reset: no list, no `reset:` on the agents");
  assert.equal(cfg.dut.reset, "rst_n");
  assert.deepEqual(
    cfg.agents.map((a) => [a.name, a.clock, a.reset, a.ports.inputs.map((x) => x.name)]),
    [["clk", "clk", undefined, ["req"]], ["fast", "fast_clk", undefined, ["fast_data"]]],
    "what no tag claims goes to the default domain"
  );
});

test("per-clock: refused with one clock, with none, and when no pin can be told apart", () => {
  assert.match(offer(model, "demo_top.u_soc", "per-clock").detail, /one clock/);
  assert.match(offer(model, "demo_top.u_soc.u_add", "per-clock").detail, /no clock input/);
  const blind = single("x", [port("a_clk", "in"), port("b_clk", "in"), port("d", "in", 8), port("q", "out", 8)]);
  const o = offer(blind, "x", "per-clock");
  assert.equal(o.available, false);
  assert.match(o.detail, /cannot be told apart by name/);
  // with a default domain there is always somewhere to put them
  const some = single("y", [port("a_clk", "in"), port("b_clk", "in"), port("a_d", "in", 8), port("q", "out", 8)]);
  const p = T.planTemplate(some, "y", "per-clock");
  assert.ok(p.notes.some((n) => /not on any clock domain by name: q/.test(n)), "a stray pin is named, never guessed");
  assert.ok(p.notes.some((n) => /b_clk: no pin carries its name/.test(n)));
});

// -------------------------------------------------------------- composition
test("composition: one subenv per direct sub-block, one block config per MODULE, a combinational shell", () => {
  const p = T.planTemplate(model, "demo_top.u_soc", "composition");
  const cfg = parseQuvm(p.text);
  assert.deepEqual(cfg.subenvs, [
    { name: "u_add", config: "adder.quickuvm.yaml" },
    { name: "u_inv", config: "inverter.quickuvm.yaml" },
    { name: "g_ch_0_u_ch", config: "chan.quickuvm.yaml" },
    { name: "g_ch_1_u_ch", config: "chan.quickuvm.yaml" },
    { name: "g_ch_2_u_ch", config: "chan.quickuvm.yaml" },
  ], "the generate members are direct sub-blocks; no params are passed");
  assert.equal(cfg.layout, "packaged");
  assert.deepEqual(cfg.dut, { name: "soc_top", clock: "clk", reset: "", combinational: true });
  assert.equal(cfg.agents, undefined);
  assert.deepEqual(p.children.map((c) => [c.file, c.created]), [
    ["adder.quickuvm.yaml", true], ["inverter.quickuvm.yaml", true], ["chan.quickuvm.yaml", true],
  ]);
  const chan = parseQuvm(p.children[2].text);
  assert.deepEqual(chan.agents.map((a) => a.name), ["chan_a"], "block agents carry the module's name: one namespace");
  assert.equal(chan.agents[0].ports.inputs[0].width, 16, "the ELABORATED width (W=16)");
  assert.ok(p.notes.some((n) => /g_ch_0_u_ch: W=16.*no `params:`/.test(n)));
  assert.ok(p.notes.some((n) => /draws no connection/.test(n)));
});

const SYS = {
  schema_version: 1,
  tops: ["sys"],
  modules: {
    sys: { ports: [port("din", "in", 8), port("dout", "out", 8)], iface_ports: [], loc: null },
    prod: { ports: [port("d_i", "in", 8), port("q_o", "out", 8)], iface_ports: [], loc: null },
    cons: { ports: [port("d_i", "in", 8), port("q_o", "out", 8), port("aux", "in", 2)], iface_ports: [], loc: null },
  },
  instances: [
    { path: "sys", module: "sys", params: {}, loc: null },
    { path: "sys.u_p", module: "prod", params: {}, loc: null },
    { path: "sys.u_c", module: "cons", params: {}, loc: null },
  ],
  views: {
    sys: {
      module: "sys",
      pins: [],
      nets: [
        { name: "din", endpoints: ["<port>.din", "u_p.d_i"], fanout: 1, render: "wire" },
        { name: "mid", endpoints: ["u_p.q_o", "u_c.d_i"], fanout: 1, render: "wire" },
        { name: "dout", endpoints: ["<port>.dout", "u_c.q_o"], fanout: 1, render: "wire" },
      ],
    },
  },
};

test("composition: the connections the design draws, with the destination's agent passive", () => {
  const p = T.planTemplate(SYS, "sys", "composition");
  const cfg = parseQuvm(p.text);
  assert.deepEqual(cfg.connections.map((c) => [c.from, c.to]), [["u_p.q_o", "u_c.d_i"]]);
  const cons = parseQuvm(p.children.find((c) => c.module === "cons").text);
  const prod = parseQuvm(p.children.find((c) => c.module === "prod").text);
  assert.equal(cons.agents[0].active, false, "quick-uvm refuses an active agent on a driven block");
  assert.equal(prod.agents[0].active, undefined);
  assert.ok(p.summary.some((s) => /1 connection: u_p\.q_o → u_c\.d_i/.test(s)));
  assert.ok(p.summary.some((s) => /passive.*u_c\.cons_a/.test(s)));
});

test("composition: an existing block config is never recreated — edited only to go passive, else left out", () => {
  const mine = [
    "project: {name: cons}",
    "dut: {name: cons, clock: clk, reset: '', combinational: true}",
    "agents:",
    "  - name: mine",
    "    interface: mine_if",
    "    sequence_item: mine_item",
    "    ports:",
    "      inputs: [{name: d_i, width: 8}]",
    "      outputs: [{name: q_o, width: 8, randomize: false}]",
    "",
  ].join("\n");
  const p = T.planTemplate(SYS, "sys", "composition", {
    existing: new Map([["cons.quickuvm.yaml", mine], ["prod.quickuvm.yaml", "project: {name: prod}\n"]]),
  });
  assert.deepEqual(p.children.map((c) => [c.file, c.created]), [["cons.quickuvm.yaml", false]],
    "prod exists and is untouched: not a file of the plan; cons exists and goes passive");
  const cons = parseQuvm(p.children[0].text);
  assert.deepEqual(cons.agents.map((a) => [a.name, a.active]), [["mine", false]], "the user's agent, not a second one");
  assert.ok(!p.children[0].text.includes("cons_a"), "no boundary agent is added to a file that exists");
});

test("composition: refused below two blocks; names that collide are left out, and said", () => {
  assert.match(offer(model, "demo_top", "composition").detail, /one sub-block/);
  assert.match(offer(model, "demo_top.u_soc.u_add", "composition").detail, /no sub-blocks/);
  const clash = structuredClone(SYS);
  clash.instances.push(
    { path: "sys.g[0].u", module: "prod", params: {}, loc: null },
    { path: "sys.g_0_u", module: "prod", params: {}, loc: null }
  );
  const p = T.planTemplate(clash, "sys", "composition");
  assert.deepEqual(parseQuvm(p.text).subenvs.map((s) => s.name), ["u_p", "u_c"]);
  assert.ok(p.notes.some((n) => /the same subenv name \(g_0_u\)/.test(n)));
});

console.log(`\ntest-templates: ${passed} tests passed.`);
