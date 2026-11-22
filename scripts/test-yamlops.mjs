// Node tests for the pure YAML mutations (src/yamlops.ts).
// yamlops does not import `vscode`, so it is bundled with esbuild and run directly:
//   npm run test:yamlops
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-yamlops-"));
const outFile = join(outDir, "yamlops.mjs");
await esbuild.build({
  entryPoints: ["src/yamlops.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  // the CJS package `yaml` requires builtins: the standard esbuild shim
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const ops = await import(pathToFileURL(outFile));

const DUT = {
  module: "soc_top",
  clock: "clk",
  reset: "rst_n",
  resetActiveLow: true,
  combinational: false,
};

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
  }
}

test("new skeleton: valid YAML with project/clock/tests", () => {
  const text = ops.newConfigText("demo");
  const cfg = ops.parseQuvm(text);
  assert.equal(cfg.project.name, "demo");
  assert.equal(cfg.clock.period, 10);
  assert.equal(cfg.tests[0].name, "demo_test");
});

test("setDut: writes the dut and keeps the rest", () => {
  const text = ops.setDut(ops.newConfigText("demo"), DUT);
  const cfg = ops.parseQuvm(text);
  assert.equal(cfg.dut.name, "soc_top");
  assert.equal(cfg.dut.clock, "clk");
  assert.equal(cfg.dut.reset, "rst_n");
  // a reset port no agent declares is driven by the testbench top — ALWAYS
  // written: without it quick-uvm wires the DUT to `<first agent>_if_inst.rst_n`,
  // a signal that interface does not have (exit 0, elaboration fails)
  assert.deepEqual(cfg.reset, { external: true });
  assert.equal(cfg.project.name, "demo");
});

test("setDut: the reset deviations go into the TOP-LEVEL `reset:` key (1.0)", () => {
  let text = ops.setDut(ops.newConfigText("demo"), {
    ...DUT, resetActiveLow: false,
  });
  assert.deepEqual(ops.parseQuvm(text).reset,
    { active_low: false, external: true });
  // the old keys on dut are NO longer written (1.0 rejects them with a guide-error)
  assert.ok(!/reset_active_low|external_reset/.test(text));
  // returning to the default polarity drops `active_low`; `external` stays
  text = ops.setDut(text, DUT);
  assert.deepEqual(ops.parseQuvm(text).reset, { external: true });
  // a DUT without a reset port: the whole block disappears
  text = ops.setDut(text, { ...DUT, reset: null });
  assert.equal(ops.parseQuvm(text).reset, undefined);
  assert.equal(ops.parseQuvm(text).dut.reset, "");
});

test("setDut: `external` is DERIVED — an agent that declares the reset port drives it", () => {
  // the agent-driven shape (quick-uvm's own `init` scaffold): the reset is a
  // field of that agent's sequence item. `external: true` next to it is a hard
  // generator error ("An external reset must not also be an agent port").
  let text = ops.setDut(ops.newConfigText("demo"), DUT);
  text = ops.createAgent(text, {
    name: "cmd",
    inputs: [{ name: "rst_n", width: 1 }, { name: "din", width: 8 }],
    outputs: [],
  });
  text = ops.setDut(text, DUT);
  assert.equal(ops.parseQuvm(text).reset, undefined, "external next to an agent-declared reset");
  // on any side: a sampled/bidirectional declaration also puts the signal on the interface
  for (const side of ["outputs", "inouts"]) {
    let t = ops.setDut(ops.newConfigText("demo"), DUT);
    t = ops.createAgent(t, { name: "a", inputs: [], outputs: [], [side]: [{ name: "rst_n", width: 1 }] });
    assert.equal(ops.parseQuvm(ops.setDut(t, DUT)).reset, undefined, side);
  }
  // an agent that declares OTHER ports changes nothing
  let other = ops.setDut(ops.newConfigText("demo"), DUT);
  other = ops.createAgent(other, { name: "a", inputs: [{ name: "din", width: 8 }], outputs: [] });
  assert.deepEqual(ops.parseQuvm(ops.setDut(other, DUT)).reset, { external: true });
});

test("setDut (review): a null `reset:`, aliased ports, `reset_port`, `kind: selftest`", () => {
  // `reset:` with no value used to throw "Expected YAML collection at reset" —
  // on EVERY DUT with a reset, now that `external` is always written
  for (const empty of ["reset:\n", "reset: ~\n", "reset: 5\n"]) {
    const t = ops.setDut(ops.newConfigText("demo") + empty, DUT);
    assert.deepEqual(ops.parseQuvm(t).reset, { external: true }, JSON.stringify(empty));
  }
  // ... and stays absent when there is nothing to write
  assert.equal(
    ops.parseQuvm(ops.setDut(ops.newConfigText("demo") + "reset:\n", { ...DUT, reset: null })).reset,
    undefined
  );
  // an ALIASED mapping is not rewritten (the anchor has other users)
  const aliased = "common: &r { active_low: false }\nreset: *r\n";
  const kept = ops.setDut(ops.newConfigText("demo") + aliased, DUT);
  assert.ok(kept.includes("reset: *r"), kept);

  // ports through an anchor: read the way the generator reads them
  const anchored = [
    "ports_a: &p",
    "  inputs: [ { name: rst_n }, { name: din, width: 8 } ]",
    "agents:",
    "  - { name: a, interface: a_if, sequence_item: a_item, ports: *p }",
    "",
  ].join("\n");
  assert.equal(ops.parseQuvm(ops.setDut(anchored, DUT)).reset, undefined,
    "external next to an agent-declared reset (aliased ports)");

  // `reset_port`: an agent-driven reset — quick-uvm refuses `external: true` next to it
  let rp = ops.createAgent(ops.newConfigText("demo"), {
    name: "a", inputs: [{ name: "arst", width: 1 }], outputs: [],
  });
  rp = ops.setAgentField(rp, "a", "reset_port", "arst");
  assert.equal(ops.parseQuvm(rp).agents[0].reset_port, "arst");
  assert.equal(ops.parseQuvm(ops.setDut(rp, DUT)).reset, undefined);

  // `kind: selftest`: a DUT-less top that never connects the reset its drivers
  // would wait on
  const st = ops.setDut(ops.newConfigText("demo") + "kind: selftest\nlayout: packaged\n", DUT);
  assert.equal(ops.parseQuvm(st).reset, undefined);
  // a VIP keeps it (it decides whether the VIP's interfaces take the reset)
  const vip = ops.setDut(ops.newConfigText("demo") + "kind: vip\nlayout: packaged\n", DUT);
  assert.deepEqual(ops.parseQuvm(vip).reset, { external: true });
});

test("setBenchField kind (review): the reset driver follows the kind", () => {
  let t = ops.setDut(ops.newConfigText("demo"), { ...DUT, resetActiveLow: false });
  t = ops.setBenchField(t, "layout", "packaged");
  assert.deepEqual(ops.parseQuvm(t).reset, { active_low: false, external: true });
  // bench -> selftest drops `external` (the polarity stays)
  const st = ops.setBenchField(t, "kind", "selftest");
  assert.deepEqual(ops.parseQuvm(st).reset, { active_low: false });
  // selftest -> vip / back to bench restores it
  assert.deepEqual(ops.parseQuvm(ops.setBenchField(st, "kind", "vip")).reset,
    { active_low: false, external: true });
  assert.deepEqual(ops.parseQuvm(ops.setBenchField(st, "kind", "bench")).reset,
    { active_low: false, external: true });
  // an emptied mapping disappears; a reset LIST is never touched
  const plain = ops.setBenchField(ops.setDut(ops.newConfigText("demo"), DUT), "kind", "selftest");
  assert.equal(ops.parseQuvm(plain).reset, undefined);
  const list = ops.addResetDomain(ops.setDut(ops.newConfigText("demo"), DUT), "srst_n");
  assert.deepEqual(ops.parseQuvm(ops.setBenchField(list, "kind", "selftest")).reset,
    ops.parseQuvm(list).reset);
  // the other bench fields do not touch the reset
  assert.equal(ops.parseQuvm(ops.setBenchField(plain, "top_name", "my_top")).reset, undefined);
});

test("setResetDomainField (review): `external: true` is refused where quick-uvm refuses it", () => {
  const comb = ops.setDut(ops.newConfigText("demo"), { ...DUT, clock: null, combinational: true });
  assert.throws(() => ops.setResetDomainField(comb, "rst_n", "external", true), /combinational/);
  const st = ops.setDut(ops.newConfigText("demo") + "kind: selftest\n", DUT);
  assert.throws(() => ops.setResetDomainField(st, "rst_n", "external", true), /selftest/);
  let owned = ops.setDut(ops.newConfigText("demo"), { ...DUT, reset: null });
  owned = ops.createAgent(owned, { name: "a", inputs: [{ name: "rst_n", width: 1 }], outputs: [] });
  owned = ops.setDut(owned, DUT);
  assert.throws(() => ops.setResetDomainField(owned, "rst_n", "external", true), /agent's ports/);
  const rp = ops.setAgentField(
    ops.createAgent(ops.setDut(ops.newConfigText("demo"), { ...DUT, reset: null }), {
      name: "a", inputs: [{ name: "arst", width: 1 }], outputs: [],
    }), "a", "reset_port", "arst");
  assert.throws(() => ops.setResetDomainField(ops.setDut(rp, DUT), "rst_n", "external", true), /reset_port/);
  // turning it OFF is never refused (it is how one gets out of a refused state)
  const on = ops.setDut(ops.newConfigText("demo"), DUT);
  assert.equal(ops.parseQuvm(ops.setResetDomainField(on, "rst_n", "external", false)).reset, undefined);
});

test("clearDutReset (review): dut.reset '' and the dead single mapping; no-op = same text", () => {
  const t = ops.setDut(ops.newConfigText("demo"), { ...DUT, resetActiveLow: false });
  const cleared = ops.clearDutReset(t);
  assert.equal(ops.parseQuvm(cleared).dut.reset, "");
  assert.equal(ops.parseQuvm(cleared).reset, undefined);
  assert.equal(ops.clearDutReset(cleared), cleared, "no-op: byte-identical");
  // the generator's default made explicit: an ABSENT key becomes ''
  const absent = "project: {name: demo}\ndut:   {name: demo, clock: clk}\n";
  assert.equal(ops.parseQuvm(ops.clearDutReset(absent)).dut.reset, "");
  // under a domain list dut.reset must name a domain — refused, not half-applied
  const list = ops.addResetDomain(ops.setDut(ops.newConfigText("demo"), DUT), "srst_n");
  assert.throws(() => ops.clearDutReset(list), /domain list/);
});

test("setDut: a combinational DUT never gets `external` (quick-uvm refuses the pair)", () => {
  // "dut.combinational and `reset: {external: true}` are mutually exclusive"
  const text = ops.setDut(ops.newConfigText("demo"), { ...DUT, clock: null, combinational: true });
  assert.equal(ops.parseQuvm(text).reset, undefined);
  // ... and switching a clocked DUT to combinational takes it away
  const back = ops.setDut(ops.setDut(ops.newConfigText("demo"), DUT),
    { ...DUT, clock: null, reset: null, combinational: true });
  assert.equal(ops.parseQuvm(back).reset, undefined);
});

test("setDut: a hand-written `reset:` LIST is not touched", () => {
  // (the base has no reset port, so no `reset:` mapping is there to collide with)
  const withList = ops.setDut(ops.newConfigText("demo"), { ...DUT, reset: null }) +
    "reset:\n  - {name: rst_n}\n  - {name: wrst_n, clock: wclk}\n";
  const text = ops.setDut(withList, { ...DUT, resetActiveLow: false });
  const cfg = ops.parseQuvm(text);
  assert.ok(Array.isArray(cfg.reset));
  // no `external`, no `active_low` smuggled into the list or next to it
  assert.deepEqual(cfg.reset, [{ name: "rst_n" }, { name: "wrst_n", clock: "wclk" }]);
});

test("setDut combinational: empty reset + combinational true", () => {
  const text = ops.setDut(ops.newConfigText("demo"), {
    ...DUT,
    module: "adder",
    clock: null,
    reset: null,
    combinational: true,
  });
  const cfg = ops.parseQuvm(text);
  assert.equal(cfg.dut.reset, "");
  assert.equal(cfg.dut.combinational, true);
});

test("setDut keeps the comments and the unknown fields", () => {
  const src = [
    "# my important comment",
    "project: {name: x}",
    "analysis:",
    "  coverage: [a]   # to be kept",
    "unknown_field: {k: v}",
    "",
  ].join("\n");
  const text = ops.setDut(src, DUT);
  assert.match(text, /my important comment/);
  assert.match(text, /to be kept/);
  assert.match(text, /unknown_field/);
  assert.equal(ops.parseQuvm(text).dut.name, "soc_top");
});

test("createAgent: the shape from docs/03, flow style on the ports", () => {
  const text = ops.createAgent(ops.newConfigText("demo"), {
    name: "drv",
    inputs: [
      { name: "din", width: 8 },
      { name: "en", width: 1 },
    ],
    outputs: [{ name: "sum", width: 8 }],
  });
  const cfg = ops.parseQuvm(text);
  const a = cfg.agents[0];
  assert.equal(a.interface, "drv_if");
  assert.equal(a.sequence_item, "drv_seq_item");
  assert.deepEqual(a.ports.inputs[0], { name: "din", width: 8 });
  assert.deepEqual(a.ports.inputs[1], { name: "en" }); // width 1 omitted
  assert.deepEqual(a.ports.outputs[0], {
    name: "sum",
    width: 8,
    randomize: false,
  });
  assert.match(text, /\{ name: din, width: 8 \}/); // flow style, one line
});

test("createAgent: duplicate name => error", () => {
  const text = ops.createAgent(ops.newConfigText("demo"), {
    name: "drv",
    inputs: [],
    outputs: [],
  });
  assert.throws(() => ops.createAgent(text, { name: "drv", inputs: [], outputs: [] }),
    /already exists/);
});

test("createAgent: an inout port goes into ports.inouts (schema §1.5)", () => {
  const text = ops.createAgent(ops.newConfigText("demo"), {
    name: "sda",
    inputs: [{ name: "scl_i", width: 1 }],
    outputs: [],
    inouts: [
      { name: "sda", width: 1 },
      { name: "bus", width: 4 },
    ],
  });
  const cfg = ops.parseQuvm(text);
  const a = cfg.agents[0];
  assert.deepEqual(a.ports.inouts[0], { name: "sda" }); // width 1 omitted
  assert.deepEqual(a.ports.inouts[1], { name: "bus", width: 4 });
  // an inout is NOT a read-only observation, so no randomize:false is added
  assert.equal(a.ports.inouts[0].randomize, undefined);
  assert.ok(/inouts:/.test(text), `inouts was not written:\n${text}`);
  assert.ok(/\{ name: bus, width: 4 \}/.test(text), "the inout is not flow style");
});

test("createAgent: without inouts the key is not emitted (byte-identical to the old shape)", () => {
  const spec = { name: "drv", inputs: [{ name: "din", width: 8 }], outputs: [] };
  const withUndef = ops.createAgent(ops.newConfigText("demo"), spec);
  const withEmpty = ops.createAgent(ops.newConfigText("demo"), { ...spec, inouts: [] });
  assert.ok(!/inouts:/.test(withUndef), "inouts must not be emitted without ports");
  assert.equal(withEmpty, withUndef); // [] and undefined produce identical YAML
});

test("ignorePorts: sorted union, no duplicates; unignore cleans the block", () => {
  let text = ops.ignorePorts(ops.newConfigText("demo"), ["scan_en", "dbg"]);
  text = ops.ignorePorts(text, ["dbg", "test_mode"]);
  assert.deepEqual(ops.parseQuvm(text).dut.unverified_ports, [
    "dbg",
    "scan_en",
    "test_mode",
  ]);
  text = ops.unignorePorts(text, ["dbg", "scan_en", "test_mode"]);
  // the key disappears; the `dut` block (mandatory configuration) stays
  assert.equal(ops.parseQuvm(text).dut?.unverified_ports, undefined);
});

test("setAgentPortWidth: an inout port is found too (docs/08 R16: the reset on an inout threw)", () => {
  const text = "agents:\n  - name: cmd\n    ports:\n      inouts:\n        - { name: io, width: 8 }\n";
  const out = ops.setAgentPortWidth(text, "cmd", "io", 1);
  assert.ok(!/width/.test(out), "width 1 is the default: the key goes");
  assert.ok(/width: 4/.test(ops.setAgentPortWidth(out, "cmd", "io", 4)));
});

test("setAgentPortWidth: updates, and knows to omit width=1", () => {
  let text = ops.createAgent(ops.newConfigText("demo"), {
    name: "drv",
    inputs: [{ name: "din", width: 8 }],
    outputs: [],
  });
  text = ops.setAgentPortWidth(text, "drv", "din", 16);
  assert.equal(ops.parseQuvm(text).agents[0].ports.inputs[0].width, 16);
  text = ops.setAgentPortWidth(text, "drv", "din", 1);
  assert.equal(ops.parseQuvm(text).agents[0].ports.inputs[0].width, undefined);
  assert.throws(() => ops.setAgentPortWidth(text, "drv", "no_such_port", 4),
    /does not exist/);
});

test("createSubenvs: flow params only when there are values, comments kept, duplicates refused", () => {
  let text = ops.setDut(ops.newConfigText("soc"), DUT);
  text = ops.createSubenvs(text, [
    { name: "u_add", config: "adder.quickuvm.yaml", params: { W: 8 } },
    { name: "g_ch_0_u_ch", config: "chan.quickuvm.yaml", params: {} },
  ]);
  const cfg = ops.parseQuvm(text);
  assert.equal(cfg.subenvs.length, 2);
  assert.deepEqual(cfg.subenvs[0], {
    name: "u_add",
    config: "adder.quickuvm.yaml",
    params: { W: 8 },
  });
  // empty params is omitted entirely
  assert.deepEqual(cfg.subenvs[1], {
    name: "g_ch_0_u_ch",
    config: "chan.quickuvm.yaml",
  });
  // params on a single line (flow map) and the skeleton comments intact
  assert.ok(/params: \{ ?W: 8 ?\}/.test(text), `params is not flow style:\n${text}`);
  assert.ok(text.includes("# QuickUVM configuration — created by QuickUVM Architect"));
  // composition requires layout: packaged (validated by QuickUVM) — ensured by the mutation
  assert.equal(cfg.layout, "packaged");
  // incremental addition to the existing list
  text = ops.createSubenvs(text, [
    { name: "u_inv", config: "inverter.quickuvm.yaml", params: {} },
  ]);
  assert.equal(ops.parseQuvm(text).subenvs.length, 3);
  // duplicate: refused with a clear message
  assert.throws(
    () => ops.createSubenvs(text, [
      { name: "u_add", config: "x.yaml", params: {} },
    ]),
    /already exists/
  );
});

test("topConfigPaths: the children's scaffolds do not become the active config", () => {
  // the real regression scenario: chan.quickuvm.yaml (createSubenv scaffold)
  // wins alphabetically, but is referenced by demo_top -> the top stays demo_top
  let top = ops.setDut(ops.newConfigText("demo_top"), DUT);
  top = ops.createSubenvs(top, [
    { name: "g_ch_0_u_ch", config: "chan.quickuvm.yaml", params: { W: 16 } },
  ]);
  const chan = ops.setDut(ops.newConfigText("chan"), {
    module: "chan", clock: null, reset: null,
    resetActiveLow: true, combinational: true,
  });
  const tops = ops.topConfigPaths([
    { path: "C:\\ws\\examples\\chan.quickuvm.yaml", text: chan },
    { path: "C:\\ws\\examples\\demo_top.quickuvm.yaml", text: top },
  ]);
  assert.deepEqual(tops, ["C:\\ws\\examples\\demo_top.quickuvm.yaml"]);
  // relative paths with ../ and different case (Windows) resolve to the same file
  const tops2 = ops.topConfigPaths([
    { path: "C:\\ws\\blocks\\Chan.quickuvm.yaml", text: chan },
    {
      path: "C:\\ws\\top\\demo.quickuvm.yaml",
      text: ops.createSubenvs(ops.newConfigText("d"), [
        { name: "u", config: "../blocks/chan.quickuvm.yaml", params: {} },
      ]),
    },
  ]);
  assert.deepEqual(tops2, ["C:\\ws\\top\\demo.quickuvm.yaml"]);
  // without references: all are candidates (the alphabetical choice remains with the host)
  const tops3 = ops.topConfigPaths([
    { path: "a.quickuvm.yaml", text: chan },
    { path: "b.quickuvm.yaml", text: chan },
  ]);
  assert.equal(tops3.length, 2);
});

test("isComposedChild: the composed child is detected (the K2 #2 warning)", () => {
  let top = ops.setDut(ops.newConfigText("demo_top"), DUT);
  top = ops.createSubenvs(top, [
    { name: "g_ch_0_u_ch", config: "chan.quickuvm.yaml", params: { W: 16 } },
  ]);
  const chan = ops.setDut(ops.newConfigText("chan"), {
    module: "chan", clock: null, reset: null,
    resetActiveLow: true, combinational: true,
  });
  const files = [
    { path: "C:\\ws\\examples\\chan.quickuvm.yaml", text: chan },
    { path: "C:\\ws\\examples\\demo_top.quickuvm.yaml", text: top },
  ];
  // the child referenced as subenvs[].config -> composed; the top -> not
  assert.equal(ops.isComposedChild(files, "C:\\ws\\examples\\chan.quickuvm.yaml"), true);
  assert.equal(ops.isComposedChild(files, "C:\\ws\\examples\\demo_top.quickuvm.yaml"), false);
  // normalized comparison (case + separators — fsPath on Windows may
  // differ in case from the path found by findFiles; a raw includes() misses it)
  assert.equal(ops.isComposedChild(files, "c:/WS/Examples/DEMO_TOP.quickuvm.yaml"), false);
  assert.equal(ops.isComposedChild(files, "c:/ws/examples/CHAN.quickuvm.yaml"), true);
  // a single file: there is no one to compose it
  assert.equal(ops.isComposedChild([files[0]], files[0].path), false);
});

test("addScoreboard: two-stream OOO, flow map, duplicate name refused", () => {
  let text = ops.setDut(ops.newConfigText("soc"), DUT);
  text = ops.addScoreboard(text, {
    name: "sbd",
    source: "cmd",
    monitor: "rsp",
    match: "out_of_order",
    matchKey: "id",
  });
  const cfg = ops.parseQuvm(text);
  assert.deepEqual(cfg.analysis.scoreboards[0], {
    name: "sbd",
    source: "cmd",
    monitor: "rsp",
    match: "out_of_order",
    match_key: "id",
  });
  assert.ok(/- \{ ?name: sbd/.test(text), `the scoreboard is not flow style:\n${text}`);
  // single-stream: monitor/match omitted
  text = ops.addScoreboard(text, { name: "sb2", source: "cmd", match: "in_order" });
  assert.deepEqual(ops.parseQuvm(text).analysis.scoreboards[1], {
    name: "sb2",
    source: "cmd",
  });
  assert.throws(
    () => ops.addScoreboard(text, { name: "sbd", source: "x" }),
    /already exists/
  );
});

test("addCoverage: idempotent, keeps the scoreboards", () => {
  let text = ops.addScoreboard(ops.setDut(ops.newConfigText("s"), DUT), {
    name: "sbd",
    source: "cmd",
  });
  text = ops.addCoverage(text, "cmd");
  text = ops.addCoverage(text, "cmd"); // idempotent
  text = ops.addCoverage(text, "rsp");
  const cfg = ops.parseQuvm(text);
  assert.deepEqual(cfg.analysis.coverage, ["cmd", "rsp"]);
  assert.equal(cfg.analysis.scoreboards.length, 1);
});

test("addVirtualSequence: mode parallel, flow steps, sequential omits mode", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addVirtualSequence(text, {
    name: "smoke",
    mode: "parallel",
    steps: [
      { agent: "cmd", sequence: "cmd_seq" },
      { agent: "rsp", sequence: "rsp_seq" },
    ],
  });
  const v = ops.parseQuvm(text).virtual_sequences[0];
  assert.equal(v.name, "smoke");
  assert.equal(v.mode, "parallel");
  assert.deepEqual(v.body, [
    { agent: "cmd", sequence: "cmd_seq" },
    { agent: "rsp", sequence: "rsp_seq" },
  ]);
  assert.ok(/- \{ ?agent: cmd/.test(text), `the steps are not flow style:\n${text}`);
  // sequential: mode omitted (byte-identical with the default)
  text = ops.addVirtualSequence(text, {
    name: "seq2",
    mode: "sequential",
    steps: [{ agent: "cmd", sequence: "cmd_seq" }],
  });
  assert.equal(ops.parseQuvm(text).virtual_sequences[1].mode, undefined);
  assert.throws(
    () => ops.addVirtualSequence(text, { name: "smoke", mode: "sequential", steps: [] }),
    /already exists/
  );
});

test("round-trip: the generated YAML goes through parseQuvm semantically unaltered", () => {
  let text = ops.newConfigText("demo");
  text = ops.setDut(text, DUT);
  text = ops.createAgent(text, {
    name: "bus",
    inputs: [{ name: "addr", width: 6 }],
    outputs: [{ name: "rdata", width: 8 }],
  });
  text = ops.ignorePorts(text, ["scan_en"]);
  const again = ops.parseQuvm(text);
  assert.equal(again.dut.name, "soc_top");
  assert.equal(again.agents.length, 1);
  assert.deepEqual(again.dut.unverified_ports, ["scan_en"]);
});

test("removeScoreboard: deletes by name, KEEPS the empty analysis block, idempotent", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addScoreboard(text, { name: "sbd", source: "cmd" });
  text = ops.addScoreboard(text, { name: "sb2", source: "rsp" });
  text = ops.removeScoreboard(text, "sbd");
  assert.deepEqual(
    ops.parseQuvm(text).analysis.scoreboards.map((s) => s.name),
    ["sb2"]
  );
  // delete the last one too -> the list disappears, BUT the `analysis` block stays (empty):
  // without the `analysis` key, QuickUVM falls into DEFAULT mode and revives a
  // scoreboard + auto-wired coverage (proven in test:e2e — see keepAnalysis)
  text = ops.removeScoreboard(text, "sb2");
  assert.deepEqual(ops.parseQuvm(text).analysis, {});
  assert.ok(!/scoreboards:/.test(text), `the empty list was not cleaned up:\n${text}`);
  assert.ok(/analysis:/.test(text), `the analysis block was deleted:\n${text}`);
  // idempotent: nonexistent name -> unchanged text (apply becomes a no-op)
  const fix = ops.setDut(ops.newConfigText("s"), DUT);
  assert.equal(ops.removeScoreboard(fix, "nope"), fix);
});

test("removeCoverage: deletes one agent, keeps the rest and the empty analysis block", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addCoverage(text, "cmd");
  text = ops.addCoverage(text, "rsp");
  text = ops.removeCoverage(text, "cmd");
  assert.deepEqual(ops.parseQuvm(text).analysis.coverage, ["rsp"]);
  text = ops.removeCoverage(text, "rsp");
  // the `analysis` block stays empty (otherwise QuickUVM revives the defaults)
  assert.deepEqual(ops.parseQuvm(text).analysis, {});
  assert.ok(/analysis:/.test(text), `the analysis block was deleted:\n${text}`);
});

test("removeVirtualSequence: deletes by name, cleans up the empty key", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addVirtualSequence(text, {
    name: "smoke", mode: "sequential", steps: [{ agent: "cmd", sequence: "cmd_seq" }],
  });
  text = ops.addVirtualSequence(text, {
    name: "stress", mode: "sequential", steps: [{ agent: "rsp", sequence: "rsp_seq" }],
  });
  text = ops.removeVirtualSequence(text, "smoke");
  assert.deepEqual(
    ops.parseQuvm(text).virtual_sequences.map((v) => v.name),
    ["stress"]
  );
  text = ops.removeVirtualSequence(text, "stress");
  assert.equal(ops.parseQuvm(text).virtual_sequences, undefined);
});

test("removeAgent: cascade over coverage, scoreboards (source+monitor) and vseq", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, { name: "cmd", inputs: [{ name: "din", width: 8 }], outputs: [] });
  text = ops.createAgent(text, { name: "rsp", inputs: [], outputs: [{ name: "dout", width: 8 }] });
  text = ops.addCoverage(text, "cmd");
  text = ops.addCoverage(text, "rsp");
  text = ops.addScoreboard(text, { name: "sbd", source: "cmd", monitor: "rsp" });
  text = ops.addScoreboard(text, { name: "sb3", source: "rsp", monitor: "cmd" });
  text = ops.addScoreboard(text, { name: "sb2", source: "rsp" });
  text = ops.addVirtualSequence(text, {
    name: "smoke", mode: "parallel",
    steps: [{ agent: "cmd", sequence: "cmd_seq" }, { agent: "rsp", sequence: "rsp_seq" }],
  });
  text = ops.addVirtualSequence(text, {
    name: "only_cmd", mode: "sequential", steps: [{ agent: "cmd", sequence: "cmd_seq" }],
  });
  text = ops.removeAgent(text, "cmd");
  const cfg = ops.parseQuvm(text);
  assert.deepEqual(cfg.agents.map((a) => a.name), ["rsp"]);
  assert.deepEqual(cfg.analysis.coverage, ["rsp"]);
  // sbd (source=cmd) and sb3 (monitor=cmd) disappear; sb2 (source=rsp) stays
  assert.deepEqual(cfg.analysis.scoreboards.map((s) => s.name), ["sb2"]);
  // only_cmd (only cmd) disappears; smoke stays without the cmd step
  assert.deepEqual(cfg.virtual_sequences.map((v) => v.name), ["smoke"]);
  assert.deepEqual(cfg.virtual_sequences[0].body, [{ agent: "rsp", sequence: "rsp_seq" }]);
});

test("addVipAgent / setSubenvNamespace: consumption by reference + H1 prefixing", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addVipAgent(text, "io", "../vip/gen/f2_iovip.qvip");
  // an entry by REFERENCE carries ONLY name + from_vip (the rest comes from the manifest)
  assert.deepEqual(ops.parseQuvm(text).agents[0], {
    name: "io", from_vip: "../vip/gen/f2_iovip.qvip",
  });
  assert.ok(/\{ name: io, from_vip: /.test(text), `the entry is not flow style:\n${text}`);
  // consumption by reference requires `layout: packaged` (the VIP IS an external package) —
  // the op sets it, like `createSubenvs`, instead of failing only at generation
  assert.equal(ops.parseQuvm(text).layout, "packaged");
  assert.throws(() => ops.addVipAgent(text, "io", "x.qvip"), /already exists/);
  // it coexists with the normally declared agents
  text = ops.createAgent(text, { name: "cmd", inputs: [{ name: "din", width: 8 }], outputs: [] });
  assert.deepEqual(ops.parseQuvm(text).agents.map((a) => a.name), ["io", "cmd"]);

  // namespace: absent = auto (prefixes only when the same config is composed >=2 times)
  let top = ops.setDut(ops.newConfigText("sys"), { ...DUT, combinational: true });
  top = ops.createSubenvs(top, [
    { name: "u_a", config: "blk.quickuvm.yaml", params: {} },
    { name: "u_b", config: "blk.quickuvm.yaml", params: {} },
  ]);
  assert.equal("namespace" in ops.parseQuvm(top).subenvs[0], false, "auto = the key is absent");
  top = ops.setSubenvNamespace(top, "u_a", true);
  assert.equal(ops.parseQuvm(top).subenvs[0].namespace, true);
  top = ops.setSubenvNamespace(top, "u_a", "blkA");
  assert.equal(ops.parseQuvm(top).subenvs[0].namespace, "blkA");
  top = ops.setSubenvNamespace(top, "u_a", false);
  assert.equal(ops.parseQuvm(top).subenvs[0].namespace, false);
  top = ops.setSubenvNamespace(top, "u_a", undefined); // back to auto
  assert.equal("namespace" in ops.parseQuvm(top).subenvs[0], false);
  assert.throws(() => ops.setSubenvNamespace(top, "nope", true), /does not exist/);
});

test("setAgentPortField: open_drain pulls the pullup along and does not let it be removed", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, {
    name: "i2c", inputs: [], outputs: [], inouts: [{ name: "sda", width: 1 }, { name: "bus", width: 4 }],
  });
  // open_drain: true turns the pullup on TOO — an open-drain line without a pullup floats
  // to X when everyone releases it (the QuickUVM validator: "not a style preference")
  text = ops.setAgentPortField(text, "i2c", "sda", "open_drain", true);
  let p = ops.parseQuvm(text).agents[0].ports.inouts[0];
  assert.equal(p.open_drain, true);
  assert.equal(p.pullup, true, "the pullup must come with open_drain");
  // removing the pullup from an open-drain port is REFUSED
  assert.throws(() => ops.setAgentPortField(text, "i2c", "sda", "pullup", false), /floats to X/);
  // open_drain on 1 bit only
  assert.throws(
    () => ops.setAgentPortField(text, "i2c", "bus", "open_drain", true),
    /1-bit only/
  );
  // turning open_drain off takes the pullup too
  text = ops.setAgentPortField(text, "i2c", "sda", "open_drain", false);
  p = ops.parseQuvm(text).agents[0].ports.inouts[0];
  assert.equal("open_drain" in p, false);
  assert.equal("pullup" in p, false);
  assert.throws(() => ops.setAgentPortField(text, "i2c", "nope", "pullup", true), /does not exist/);
});

test("setAgentPortField: enum/type are EXCLUSIVE; randomize/constraint", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, {
    name: "cmd", inputs: [{ name: "op", width: 2 }], outputs: [{ name: "dout", width: 8 }],
  });
  text = ops.setAgentPortField(text, "cmd", "op", "enum", { IDLE: 0, BUSY: 1 });
  assert.deepEqual(ops.parseQuvm(text).agents[0].ports.inputs[0].enum, { IDLE: 0, BUSY: 1 });
  assert.ok(/enum: \{ IDLE: 0, BUSY: 1 \}/.test(text), `the enum is not flow style:\n${text}`);
  // setting `type` removes `enum` (exclusive specifiers)
  text = ops.setAgentPortField(text, "cmd", "op", "type", "pkg::op_e");
  let p = ops.parseQuvm(text).agents[0].ports.inputs[0];
  assert.equal(p.type, "pkg::op_e");
  assert.equal("enum" in p, false, "enum should have been removed by type");
  text = ops.setAgentPortField(text, "cmd", "op", "type", "");
  assert.equal("type" in ops.parseQuvm(text).agents[0].ports.inputs[0], false);

  // a hand-written `packed_dims` is not lost silently: setting enum is REFUSED
  const hand = text.replace(/\{ name: op, width: 2 \}/, "{ name: op, width: 2, packed_dims: [2, 4] }");
  assert.notEqual(hand, text, "the packed_dims fixture was not applied");
  assert.throws(() => ops.setAgentPortField(hand, "cmd", "op", "enum", { A: 0 }), /exclusive/);

  // randomize: true is the default -> the key disappears; constraint is written verbatim
  text = ops.setAgentPortField(text, "cmd", "op", "randomize", false);
  assert.equal(ops.parseQuvm(text).agents[0].ports.inputs[0].randomize, false);
  text = ops.setAgentPortField(text, "cmd", "op", "randomize", true);
  assert.equal("randomize" in ops.parseQuvm(text).agents[0].ports.inputs[0], false);
  text = ops.setAgentPortField(text, "cmd", "op", "constraint", "op inside {[0:2]}");
  assert.equal(ops.parseQuvm(text).agents[0].ports.inputs[0].constraint, "op inside {[0:2]}");
});

test("clock domains: mapping <-> list, add/edit/remove, cascade onto the agents", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  // newConfigText writes clock: {period, unit} (a MAPPING)
  assert.equal(Array.isArray(ops.parseQuvm(text).clock), false);

  // the first add converts the mapping into a LIST, carrying the current clock as the first domain
  text = ops.addClockDomain(text, "sck");
  let clk = ops.parseQuvm(text).clock;
  assert.ok(Array.isArray(clk), "clock should have become a list");
  assert.deepEqual(clk.map((d) => d.name), ["clk", "sck"]);
  assert.equal(clk[0].period, 10); // the mapping's fields were kept
  assert.equal(clk[0].unit, "ns");
  assert.throws(() => ops.addClockDomain(text, "sck"), /already exists/);

  text = ops.setClockDomainField(text, "sck", "period", 20);
  text = ops.setClockDomainField(text, "sck", "source", "dut");
  clk = ops.parseQuvm(text).clock;
  assert.equal(clk[1].period, 20);
  assert.equal(clk[1].source, "dut");
  text = ops.setClockDomainField(text, "sck", "source", "tb"); // default -> deleted
  assert.equal("source" in ops.parseQuvm(text).clock[1], false);
  // rename: unique, required
  assert.throws(() => ops.setClockDomainField(text, "sck", "name", "clk"), /already exists/);
  assert.throws(() => ops.setClockDomainField(text, "sck", "name", ""), /is required/);

  // an agent that uses the domain blocks the deletion (QuickUVM refuses an unknown clock)
  let used = text.replace(/(\n\s+)interface: cmd_if/, "$1clock: sck$1interface: cmd_if");
  // the DUT has no "cmd" agent here; we build one with clock: sck by direct editing
  used = ops.createAgent(text, { name: "spi", inputs: [{ name: "din", width: 8 }], outputs: [] });
  used = ops.setAgentField(used, "spi", "clock", "sck");
  assert.throws(() => ops.removeClockDomain(used, "sck"), /is used by/);

  // remove is fine when nobody uses it
  text = ops.removeClockDomain(text, "sck");
  assert.deepEqual(ops.parseQuvm(text).clock.map((d) => d.name), ["clk"]);
  // the last domain: it is not deleted, it is collapsed
  assert.throws(() => ops.removeClockDomain(text, "clk"), /is the only (?:clock|reset) domain/);
  assert.equal(ops.removeClockDomain(text, "nope"), text); // byte-identical no-op

  // collapse: a list of 1 -> mapping, the redundant name disappears
  text = ops.collapseClocks(text);
  assert.equal(Array.isArray(ops.parseQuvm(text).clock), false);
  assert.equal("name" in ops.parseQuvm(text).clock, false);
  const twoAgain = ops.addClockDomain(text, "sck");
  assert.throws(() => ops.collapseClocks(twoAgain), /exactly one clock domain/);
});

test("reset domains: conversion, the dut.reset invariant, cascading rename", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, { name: "a", inputs: [{ name: "din", width: 8 }], outputs: [] });

  // the first add converts into a list; the first domain carries the NAME of the dut.reset port,
  // so that `dut.reset` (which under a list names a DOMAIN) stays valid
  text = ops.addResetDomain(text, "srst_n");
  let cfg = ops.parseQuvm(text);
  assert.deepEqual(cfg.reset.map((d) => d.name), ["rst_n", "srst_n"]);
  assert.equal(cfg.dut.reset, "rst_n");
  assert.throws(() => ops.addResetDomain(text, "srst_n"), /already exists/);

  // cascading RENAME: dut.reset and the agents bound to the domain follow it
  const bound = ops.setAgentField(text, "a", "reset", "srst_n");
  const renamed = ops.setResetDomainField(bound, "srst_n", "name", "sync_rst_n");
  cfg = ops.parseQuvm(renamed);
  assert.deepEqual(cfg.reset.map((d) => d.name), ["rst_n", "sync_rst_n"]);
  assert.equal(cfg.agents[0].reset, "sync_rst_n", "the agent did not follow the rename");
  const renamedDut = ops.setResetDomainField(bound, "rst_n", "name", "por_n");
  assert.equal(ops.parseQuvm(renamedDut).dut.reset, "por_n", "dut.reset did not follow the rename");

  // THE DEFAULT IS PER FIELD: active_low defaults to TRUE, external defaults to FALSE. A
  // single "falsy value => default" test would delete exactly `active_low: false`,
  // that is, the deviation the user asked for.
  text = ops.setResetDomainField(text, "srst_n", "active_low", false);
  assert.equal(ops.parseQuvm(text).reset[1].active_low, false,
    "active_low: false is a DEVIATION, not a default — it must be written");
  text = ops.setResetDomainField(text, "srst_n", "active_low", true);
  assert.equal("active_low" in ops.parseQuvm(text).reset[1], false);
  // on the plain mapping, external: false is the default and disappears
  let single = ops.setDut(ops.newConfigText("s"), DUT);
  single = ops.setResetDomainField(single, "rst_n", "external", true);
  assert.equal(ops.parseQuvm(single).reset.external, true);
  single = ops.setResetDomainField(single, "rst_n", "external", false);
  assert.equal(ops.parseQuvm(single).reset, undefined, "the emptied mapping should have been deleted");

  // deletion: blocked by dut.reset, by an agent, and on the last domain
  assert.throws(() => ops.removeResetDomain(text, "rst_n"), /dut\.reset/);
  assert.throws(() => ops.removeResetDomain(bound, "srst_n"), /is used by/);
  text = ops.removeResetDomain(text, "srst_n");
  assert.deepEqual(ops.parseQuvm(text).reset.map((d) => d.name), ["rst_n"]);
  assert.throws(() => ops.removeResetDomain(text, "rst_n"), /is the only (?:clock|reset) domain/);

  // collapse: the name becomes the dut.reset PORT again, and `reset:` on the agents disappears
  const collapsed = ops.collapseResets(ops.setAgentField(text, "a", "reset", "rst_n"));
  assert.equal(Array.isArray(ops.parseQuvm(collapsed).reset), false);
  assert.equal(ops.parseQuvm(collapsed).dut.reset, "rst_n");
  assert.equal("reset" in ops.parseQuvm(collapsed).agents[0], false,
    "`reset:` on an agent makes no sense without the domain list");
});

test("reset domains: `external: true` converts (a list is always testbench-driven)", () => {
  // The list entry schema is {name, active_low, clock} — no `external`, because
  // under a list tb_top drives EVERY domain (probed on quick-uvm 1.1.0). So the
  // conversion drops the key and loses nothing. (Until Nov 2026 it was refused,
  // on the misreading that external meant "the TB does not drive the reset" —
  // which would have blocked every Architect bench now that setDut writes it.)
  let text = ops.setDut(ops.newConfigText("s"), { ...DUT, resetActiveLow: false });
  assert.deepEqual(ops.parseQuvm(text).reset, { active_low: false, external: true });
  const list = ops.addResetDomain(text, "srst_n");
  assert.deepEqual(ops.parseQuvm(list).reset,
    [{ name: "rst_n", active_low: false }, { name: "srst_n" }]);

  // the conversion quick-uvm DOES refuse: an agent-driven reset. Under a list the
  // domain is a tb_top net of that name and the agent port collides with it.
  let driven = ops.setDut(ops.newConfigText("s"), DUT);
  driven = ops.createAgent(driven, { name: "a", inputs: [{ name: "rst_n", width: 1 }], outputs: [] });
  driven = ops.setDut(driven, DUT);
  assert.throws(() => ops.addResetDomain(driven, "srst_n"), /driven by an agent/);
});

test("reset domains: collapsing a list restores `external: true`", () => {
  // list -> mapping: tb_top drove the reset under the list; a bare mapping would
  // hand it to an agent that does not declare the port (the undriven state)
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.removeResetDomain(ops.addResetDomain(text, "srst_n"), "srst_n");
  assert.deepEqual(ops.parseQuvm(text).reset, [{ name: "rst_n" }]);
  const collapsed = ops.collapseResets(text);
  assert.deepEqual(ops.parseQuvm(collapsed).reset, { external: true });
  assert.equal(ops.parseQuvm(collapsed).dut.reset, "rst_n");
  // the polarity deviation survives next to it
  let high = ops.setResetDomainField(text, "rst_n", "active_low", false);
  high = ops.collapseResets(high);
  assert.deepEqual(ops.parseQuvm(high).reset, { active_low: false, external: true });
});

test("setResetDomainField: a no-op returns the ORIGINAL text (the reset-undriven repair)", () => {
  // the repair of an OLD-shape config (dut.reset set, no `reset:` block, no agent port)
  const old = [
    "# hand-kept comment",
    "project: {name: demo}",
    "dut:   {name: soc_top, clock: clk, reset: rst_n}",
    "agents: []",
    "",
  ].join("\n");
  const fixed = ops.setResetDomainField(old, "rst_n", "external", true);
  assert.deepEqual(ops.parseQuvm(fixed).reset, { external: true });
  assert.ok(fixed.includes("# hand-kept comment"));
  // applying it again changes nothing — byte-identical, no phantom WorkspaceEdit
  assert.equal(ops.setResetDomainField(fixed, "rst_n", "external", true), fixed);
  // a default written onto a bench with no `reset:` block is a no-op too (it used
  // to re-serialise the document — here the flow maps' spacing would have changed)
  assert.equal(ops.setResetDomainField(old, "rst_n", "external", false), old);
  assert.equal(ops.setResetDomainField(old, "rst_n", "active_low", true), old);
  // a real change still lands
  assert.equal(
    ops.parseQuvm(ops.setResetDomainField(old, "rst_n", "active_low", false)).reset.active_low,
    false
  );
});

test("rich coverage model: upgrade/downgrade, coverpoints, bins, crosses, goal", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, {
    name: "cmd",
    inputs: [{ name: "din", width: 8 }, { name: "wr", width: 1 }],
    outputs: [{ name: "dout", width: 8 }],
  });
  text = ops.addCoverage(text, "cmd");
  assert.deepEqual(ops.parseQuvm(text).analysis.coverage, ["cmd"]); // the simple form

  // upgrade: the rich model REQUIRES at least one coverpoint, so the first one comes with it
  text = ops.upgradeCoverage(text, "cmd", "din");
  assert.deepEqual(ops.parseQuvm(text).analysis.coverage[0], {
    agent: "cmd", coverpoints: [{ field: "din", bins: [] }],
  });
  assert.throws(() => ops.upgradeCoverage(text, "cmd", "wr"), /already/);

  text = ops.addCoverpoint(text, "cmd", "wr");
  assert.throws(() => ops.addCoverpoint(text, "cmd", "wr"), /already has a coverpoint/);
  // bins: exactly one of the three forms survives
  text = ops.setCoverageBin(text, "cmd", "din", "low", { range: [0, 7] });
  text = ops.setCoverageBin(text, "cmd", "din", "hi", { value: 255 });
  text = ops.setCoverageBin(text, "cmd", "wr", "both", { values: [0, 1] });
  let cp = ops.parseQuvm(text).analysis.coverage[0].coverpoints[0];
  assert.deepEqual(cp.bins, [
    { name: "low", range: [0, 7] },
    { name: "hi", value: 255 },
  ]);
  // setting the same name again REPLACES (does not duplicate) and changes the form
  text = ops.setCoverageBin(text, "cmd", "din", "low", { values: [1, 2] });
  cp = ops.parseQuvm(text).analysis.coverage[0].coverpoints[0];
  assert.equal(cp.bins.length, 2);
  assert.deepEqual(cp.bins[0], { name: "low", values: [1, 2] });
  text = ops.removeCoverageBin(text, "cmd", "din", "low");
  assert.deepEqual(
    ops.parseQuvm(text).analysis.coverage[0].coverpoints[0].bins,
    [{ name: "hi", value: 255 }]
  );

  text = ops.addCross(text, "cmd", ["din", "wr"]);
  assert.deepEqual(ops.parseQuvm(text).analysis.coverage[0].crosses, [["din", "wr"]]);
  text = ops.setCoverageGoal(text, "cmd", 90);
  assert.equal(ops.parseQuvm(text).analysis.coverage[0].goal, 90);
  assert.throws(() => ops.setCoverageGoal(text, "cmd", 0), /percentage/);
  assert.throws(() => ops.setCoverageGoal(text, "cmd", 101), /percentage/);

  // deleting a coverpoint takes with it the crosses that referenced it (QuickUVM refuses
  // a cross to an undeclared field)
  const pruned = ops.removeCoverpoint(text, "cmd", "wr");
  assert.equal("crosses" in ops.parseQuvm(pruned).analysis.coverage[0], false,
    "the cross survived the deletion of the coverpoint");
  // the last coverpoint cannot be deleted: the rich model requires >= 1
  assert.throws(() => ops.removeCoverpoint(pruned, "cmd", "din"), /is the only coverpoint/);

  text = ops.downgradeCoverage(text, "cmd");
  assert.deepEqual(ops.parseQuvm(text).analysis.coverage, ["cmd"]);
  assert.equal(ops.downgradeCoverage(text, "cmd"), text, "a repeated downgrade is not byte-identical");
  assert.throws(() => ops.addCoverpoint(text, "cmd", "din"), /has no rich coverage model/);
});

test("rich coverage model: the edits do NOT rewrite the hand-written keys", () => {
  // illegal_bins / transitions / cross-bins are not authored by the extension; an edit
  // would lose them if it rewrote the entry instead of modifying it in place
  const hand = [
    "project: { name: s }",
    "analysis:",
    "  coverage:",
    "    - agent: cmd",
    "      coverpoints:",
    "        - field: din",
    "          bins: []",
    "          illegal_bins: [{ name: bad, value: 9 }]",
    "          transitions: [{ name: t, seq: 0 => 1 }]",
    "      crosses:",
    "        - fields: [din, wr]",
    "          bins: [{ name: sel, select: binsof(din) }]",
    "",
  ].join("\n");
  const out = ops.setCoverageBin(hand, "cmd", "din", "low", { range: [0, 7] });
  const cp = ops.parseQuvm(out).analysis.coverage[0].coverpoints[0];
  assert.deepEqual(cp.bins, [{ name: "low", range: [0, 7] }]);
  assert.deepEqual(cp.illegal_bins, [{ name: "bad", value: 9 }]);
  assert.equal(cp.transitions.length, 1);
  const cross = ops.parseQuvm(out).analysis.coverage[0].crosses[0];
  assert.deepEqual(cross.fields, ["din", "wr"]);
  assert.equal(cross.bins.length, 1, "the cross's hand-written bins were lost");
});

test("tests[]: add/remove/edit; deleting the LAST test removes the `tests` key", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  const dflt = ops.parseQuvm(text).tests[0].name;
  text = ops.addTest(text, "smoke_test");
  assert.deepEqual(ops.parseQuvm(text).tests.map((t) => t.name), [dflt, "smoke_test"]);
  assert.throws(() => ops.addTest(text, "smoke_test"), /already/);
  text = ops.setTestField(text, "smoke_test", "num_items", 20);
  text = ops.setTestField(text, "smoke_test", "vseq", "smoke_vseq");
  let t = ops.parseQuvm(text).tests[1];
  assert.equal(t.num_items, 20);
  assert.equal(t.vseq, "smoke_vseq");
  text = ops.setTestField(text, "smoke_test", "num_items", 100); // default -> deleted
  assert.equal("num_items" in ops.parseQuvm(text).tests[1], false);
  assert.throws(() => ops.setTestField(text, "nope", "num_items", 5), /does not exist/);

  // `seeds` without `regress:` is REFUSED by QuickUVM -> we refuse it at the source
  assert.throws(() => ops.setTestField(text, "smoke_test", "seeds", 4), /regress/);
  const withRegress = ops.setTestField(ops.addRegress(text), "smoke_test", "seeds", 4);
  assert.equal(ops.parseQuvm(withRegress).tests[1].seeds, 4);

  // deletion: a byte-identical no-op on a nonexistent test
  assert.equal(ops.removeTest(text, "nope"), text);
  text = ops.removeTest(text, "smoke_test");
  assert.deepEqual(ops.parseQuvm(text).tests.map((t) => t.name), [dflt]);
  // the LAST test: the KEY is deleted, `tests: []` is not written — the absence falls back to
  // `test1` (runnable), whereas the empty list is accepted and gives ZERO tests
  text = ops.removeTest(text, dflt);
  assert.equal(ops.parseQuvm(text).tests, undefined);
  assert.equal(/tests:/.test(text), false, `the tests key remained:\n${text}`);
});

test("setBenchField / setProjectField: the bench's identity, default => the key disappears", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.setBenchField(text, "layout", "packaged");
  text = ops.setBenchField(text, "kind", "vip");
  text = ops.setBenchField(text, "top_name", "my_top");
  text = ops.setBenchField(text, "auto_virtual_sequences", false);
  let cfg = ops.parseQuvm(text);
  assert.equal(cfg.layout, "packaged");
  assert.equal(cfg.kind, "vip");
  assert.equal(cfg.top_name, "my_top");
  assert.equal(cfg.auto_virtual_sequences, false);
  for (const [f, v] of [
    ["layout", "flat"], ["kind", "bench"], ["top_name", "tb_top"],
    ["auto_virtual_sequences", true],
  ]) {
    text = ops.setBenchField(text, f, v);
  }
  cfg = ops.parseQuvm(text);
  for (const k of ["layout", "kind", "top_name", "auto_virtual_sequences"]) {
    assert.equal(k in cfg, false, `${k} at its default should have been deleted`);
  }
  text = ops.setProjectField(text, "author", "Ada");
  text = ops.setProjectField(text, "year", 2026);
  assert.equal(ops.parseQuvm(text).project.author, "Ada");
  assert.equal(ops.parseQuvm(text).project.year, 2026);
  text = ops.setProjectField(text, "author", "");
  assert.equal("author" in ops.parseQuvm(text).project, false);
  assert.throws(() => ops.setProjectField(text, "name", ""), /is required/);
});

test("register_model: add/edit/remove, the required fields cannot be emptied", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, {
    name: "host", inputs: [{ name: "addr", width: 8 }], outputs: [{ name: "rdata", width: 8 }],
  });
  text = ops.addRegisterModel(text, { package: "s_ral_pkg", block: "s_reg_block", bus_agent: "host" });
  assert.deepEqual(ops.parseQuvm(text).register_model, {
    package: "s_ral_pkg", block: "s_reg_block", bus_agent: "host",
  });
  assert.throws(
    () => ops.addRegisterModel(text, { package: "x", block: "y", bus_agent: "host" }),
    /already/
  );
  text = ops.setRegisterModelField(text, "csr_tests", ["hw_reset", "rw"]);
  text = ops.setRegisterModelField(text, "coverage", true);
  text = ops.setRegisterModelField(text, "backdoor_root", "tb_top.dut_inst");
  let rm = ops.parseQuvm(text).register_model;
  assert.deepEqual(rm.csr_tests, ["hw_reset", "rw"]);
  assert.equal(rm.coverage, true);
  assert.equal(rm.backdoor_root, "tb_top.dut_inst");
  assert.ok(/csr_tests: \[/.test(text), `csr_tests is not flow style:\n${text}`);
  // default => the key disappears (canonical YAML)
  text = ops.setRegisterModelField(text, "coverage", false);
  text = ops.setRegisterModelField(text, "csr_tests", []);
  text = ops.setRegisterModelField(text, "map", "default_map");
  rm = ops.parseQuvm(text).register_model;
  for (const k of ["coverage", "csr_tests", "map"]) {
    assert.equal(k in rm, false, `${k} at its default should have been deleted`);
  }
  // the three required fields: emptying is refused, not silently written
  for (const f of ["package", "block", "bus_agent"]) {
    assert.throws(() => ops.setRegisterModelField(text, f, ""), /is required/, f);
  }
  text = ops.removeRegisterModel(text);
  assert.equal(ops.parseQuvm(text).register_model, undefined);
  assert.equal(ops.removeRegisterModel(text), text, "remove on an absent block is not byte-identical");
  assert.throws(() => ops.setRegisterModelField(text, "adapter", "a"), /has no/);
});

test("regress: add is idempotent, remove CASCADES over tests[].seeds", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addRegress(text);
  assert.deepEqual(ops.parseQuvm(text).regress, {});
  assert.equal(ops.addRegress(text), text, "the second addRegress is not byte-identical");
  text = ops.setRegressField(text, "seeds", 8);
  text = ops.setRegressField(text, "simulator", "questa");
  assert.equal(ops.parseQuvm(text).regress.seeds, 8);
  assert.equal(ops.parseQuvm(text).regress.simulator, "questa");
  text = ops.setRegressField(text, "seeds", 1); // default -> deleted
  assert.equal("seeds" in ops.parseQuvm(text).regress, false);

  // QuickUVM REFUSES `tests[].seeds` without a `regress:` block, so deleting the
  // block must take the seeds with it too (otherwise the config no longer generates)
  const withSeeds = text.replace(/(\n\s+)- \{ name: ([\w]+) \}/, "$1- { name: $2, seeds: 4 }");
  assert.notEqual(withSeeds, text, "the seeds fixture was not applied");
  assert.equal(ops.parseQuvm(withSeeds).tests[0].seeds, 4);
  const removed = ops.removeRegress(withSeeds);
  assert.equal(ops.parseQuvm(removed).regress, undefined);
  assert.equal("seeds" in ops.parseQuvm(removed).tests[0], false, "seeds survived");
  assert.equal(ops.removeRegress(removed), removed, "remove on an absent block is not byte-identical");
});

test("setAgentField: sets/resets fields, throws on a nonexistent agent", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, {
    name: "cmd",
    inputs: [{ name: "din", width: 8 }],
    outputs: [{ name: "req", width: 1 }],
  });
  text = ops.setAgentField(text, "cmd", "mode", "responder");
  text = ops.setAgentField(text, "cmd", "request_valid", "req");
  text = ops.setAgentField(text, "cmd", "respond", "pipelined");
  text = ops.setAgentField(text, "cmd", "reorder_by", "rid");
  text = ops.setAgentField(text, "cmd", "reorder_policy", "round_robin");
  let a = ops.parseQuvm(text).agents[0];
  assert.equal(a.mode, "responder");
  assert.equal(a.request_valid, "req");
  assert.equal(a.respond, "pipelined");
  assert.equal(a.reorder_by, "rid");
  assert.equal(a.reorder_policy, "round_robin");
  // numeric + boolean fields
  text = ops.setAgentField(text, "cmd", "replicas", 4);
  assert.equal(ops.parseQuvm(text).agents[0].replicas, 4);
  // resetting to the QuickUVM default DELETES the key (canonical YAML)
  text = ops.setAgentField(text, "cmd", "replicas", 1);
  text = ops.setAgentField(text, "cmd", "reorder_policy", "priority");
  a = ops.parseQuvm(text).agents[0];
  assert.equal("replicas" in a, false, "replicas: 1 should have been deleted");
  assert.equal("reorder_policy" in a, false, "reorder_policy: priority should have been deleted");
  assert.throws(() => ops.setAgentField(text, "nope", "mode", "responder"), /does not exist/);
});

test("setAgentField: the mode -> initiator cascade deletes the responder-only keys", () => {
  // QuickUVM REFUSES each of these keys on an initiator ("only valid with
  // `mode: responder`"), so the inspector must not leave them behind
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, {
    name: "cmd", inputs: [{ name: "din", width: 8 }], outputs: [{ name: "req", width: 1 }],
  });
  for (const [f, v] of [
    ["mode", "responder"], ["request_valid", "req"], ["request_ready", "rdy"],
    ["respond", "pipelined"], ["reorder_by", "rid"], ["reorder_policy", "random"],
  ]) {
    text = ops.setAgentField(text, "cmd", f, v);
  }
  text = ops.setAgentField(text, "cmd", "mode", "initiator");
  const a = ops.parseQuvm(text).agents[0];
  for (const k of [
    "mode", "respond", "request_valid", "request_ready", "reorder_by",
    "reorder_policy", "proactive", "idle",
  ]) {
    assert.equal(k in a, false, `${k} survived the switch to initiator`);
  }
  assert.equal(a.name, "cmd"); // the rest of the agent is intact
});

test("setAgentField: the respond cascade cleans up reorder_*/request_ready/proactive", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, {
    name: "cmd", inputs: [{ name: "din", width: 8 }], outputs: [{ name: "req", width: 1 }],
  });
  text = ops.setAgentField(text, "cmd", "mode", "responder");
  text = ops.setAgentField(text, "cmd", "request_valid", "req");
  text = ops.setAgentField(text, "cmd", "request_ready", "rdy");
  text = ops.setAgentField(text, "cmd", "respond", "pipelined");
  text = ops.setAgentField(text, "cmd", "reorder_by", "rid");
  // pipelined -> on_request: reorder_* is dropped ("only valid with respond: pipelined"),
  // request_ready STAYS (on_request publishes the request)
  let t = ops.setAgentField(text, "cmd", "respond", "on_request");
  let a = ops.parseQuvm(t).agents[0];
  assert.equal("reorder_by" in a, false);
  assert.equal("respond" in a, false, "on_request is the default -> the key is deleted");
  assert.equal(a.request_ready, "rdy");
  // ... -> combinational: request_ready is dropped too (the driver reads the request, it does not publish it)
  t = ops.setAgentField(text, "cmd", "respond", "combinational");
  a = ops.parseQuvm(t).agents[0];
  assert.equal(a.respond, "combinational");
  assert.equal("request_ready" in a, false);
  assert.equal("reorder_by" in a, false);
  // proactive requires on_request: moving to prefetch deletes it
  t = ops.setAgentField(text, "cmd", "proactive", true);
  assert.equal(ops.parseQuvm(t).agents[0].proactive, true);
  t = ops.setAgentField(t, "cmd", "respond", "prefetch");
  assert.equal("proactive" in ops.parseQuvm(t).agents[0], false);
});

test("setScoreboardField: sets/resets fields, throws on a nonexistent scoreboard", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addScoreboard(text, { name: "sbd", source: "cmd" });
  text = ops.setScoreboardField(text, "sbd", "monitor", "rsp");
  text = ops.setScoreboardField(text, "sbd", "match", "out_of_order");
  text = ops.setScoreboardField(text, "sbd", "match_key", "id");
  assert.deepEqual(ops.parseQuvm(text).analysis.scoreboards[0], {
    name: "sbd", source: "cmd", monitor: "rsp", match: "out_of_order", match_key: "id",
  });
  assert.ok(/- \{ ?name: sbd/.test(text), `the scoreboard is no longer flow style:\n${text}`);
  text = ops.setScoreboardField(text, "sbd", "source", "drv");
  assert.equal(ops.parseQuvm(text).analysis.scoreboards[0].source, "drv");
  // reset to default deletes the field: match=in_order, match_key empty, monitor empty
  text = ops.setScoreboardField(text, "sbd", "match", "in_order");
  text = ops.setScoreboardField(text, "sbd", "match_key", "");
  text = ops.setScoreboardField(text, "sbd", "monitor", undefined);
  assert.deepEqual(ops.parseQuvm(text).analysis.scoreboards[0], { name: "sbd", source: "drv" });
  // numeric max_latency
  text = ops.setScoreboardField(text, "sbd", "max_latency", 16);
  assert.equal(ops.parseQuvm(text).analysis.scoreboards[0].max_latency, 16);
  assert.throws(
    () => ops.setScoreboardField(text, "nope", "match", "out_of_order"),
    /does not exist/
  );
  // source is mandatory: emptying it is refused (does not corrupt the scoreboard)
  assert.throws(() => ops.setScoreboardField(text, "sbd", "source", ""), /is required/);
  assert.throws(
    () => ops.setScoreboardField(text, "sbd", "source", undefined),
    /is required/
  );
});

test("remove*: a no-op keeps the hand-written empty containers byte-identical", () => {
  // hand-written file with empty blocks: a deletion with no target must NOT
  // touch them (empty WorkspaceEdit; regression caught in the adversarial review)
  const hand = [
    "project: { name: s }",
    "agents:",
    "  - { name: cmd }",
    "analysis:",
    "  scoreboards: []",
    "  coverage: []",
    "virtual_sequences: []",
    "",
  ].join("\n");
  assert.equal(ops.removeScoreboard(hand, "nope"), hand);
  assert.equal(ops.removeCoverage(hand, "nope"), hand);
  assert.equal(ops.removeVirtualSequence(hand, "nope"), hand);
  assert.equal(ops.removeAgent(hand, "nope"), hand);
});

test("removeAgent: keeps a hand-written vseq with an empty body", () => {
  const text = [
    "agents:",
    "  - { name: cmd }",
    "  - { name: rsp }",
    "virtual_sequences:",
    "  - { name: placeholder, body: [] }",
    "  - { name: uses_cmd, body: [{ agent: cmd, sequence: cmd_seq }] }",
    "",
  ].join("\n");
  const cfg = ops.parseQuvm(ops.removeAgent(text, "cmd"));
  // uses_cmd (emptied of cmd) disappears; placeholder (pre-existing empty body) stays
  assert.deepEqual(cfg.virtual_sequences.map((v) => v.name), ["placeholder"]);
  assert.deepEqual(cfg.agents.map((a) => a.name), ["rsp"]);
});

test("setScoreboardField: window + reference_model (nested fields, P3)", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, {
    name: "cmd", inputs: [{ name: "din", width: 8 }], outputs: [{ name: "done", width: 1 }],
  });
  text = ops.addScoreboard(text, { name: "sbd", source: "cmd" });

  // reference_model: `sv` is the default -> the mapping is not written at all
  text = ops.setScoreboardField(text, "sbd", "reference_model.language", "c");
  assert.deepEqual(ops.parseQuvm(text).analysis.scoreboards[0].reference_model, { language: "c" });
  text = ops.setScoreboardField(text, "sbd", "reference_model.language", "sv");
  assert.equal("reference_model" in ops.parseQuvm(text).analysis.scoreboards[0], false);

  // window: setting the boundary creates the mapping with the minimum legal length
  text = ops.setScoreboardField(text, "sbd", "window.boundary", "done");
  assert.deepEqual(ops.parseQuvm(text).analysis.scoreboards[0].window, {
    boundary: "done", length: 1,
  });
  text = ops.setScoreboardField(text, "sbd", "window.length", 512);
  assert.deepEqual(ops.parseQuvm(text).analysis.scoreboards[0].window, {
    boundary: "done", length: 512,
  });
  // emptying the length would leave an invalid window -> a byte-identical no-op
  assert.equal(ops.setScoreboardField(text, "sbd", "window.length", ""), text);

  // COUPLING: a window requires A SINGLE stream. Adding a monitor deletes it...
  const twoStream = ops.setScoreboardField(text, "sbd", "monitor", "cmd2");
  assert.equal("window" in ops.parseQuvm(twoStream).analysis.scoreboards[0], false,
    "the window survived the addition of the monitor");
  // ... and conversely, a window cannot be added to a two-stream scoreboard
  assert.throws(
    () => ops.setScoreboardField(twoStream, "sbd", "window.boundary", "done"),
    /SINGLE-stream/
  );
  assert.throws(
    () => ops.setScoreboardField(text, "nope", "window.boundary", "done"),
    /does not exist/
  );
  // empty boundary => the window disappears altogether
  text = ops.setScoreboardField(text, "sbd", "window.boundary", "");
  assert.equal("window" in ops.parseQuvm(text).analysis.scoreboards[0], false);
  assert.throws(() => ops.setScoreboardField(text, "sbd", "window.length", 4), /has no/);
});

test("setScoreboardField: cascade — empty monitor / match in_order cleans up match_key", () => {
  let text = ops.addScoreboard(ops.setDut(ops.newConfigText("s"), DUT), {
    name: "sbd", source: "cmd", monitor: "rsp", match: "out_of_order", matchKey: "id",
  });
  // match -> in_order also deletes match_key (schema: key only at out_of_order)
  let t2 = ops.setScoreboardField(text, "sbd", "match", "in_order");
  assert.deepEqual(ops.parseQuvm(t2).analysis.scoreboards[0], {
    name: "sbd", source: "cmd", monitor: "rsp",
  });
  // empty monitor (single-stream) deletes match + match_key at once
  let t3 = ops.setScoreboardField(text, "sbd", "monitor", undefined);
  assert.deepEqual(ops.parseQuvm(t3).analysis.scoreboards[0], {
    name: "sbd", source: "cmd",
  });
});

test("addProbe: flow map, width=1 omitted, coverage only when requested, duplicate refused", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addProbe(text, { name: "lvl", path: "u_fifo.level", width: 3 });
  assert.deepEqual(ops.parseQuvm(text).probes[0], {
    name: "lvl", path: "u_fifo.level", width: 3,
  });
  assert.ok(/- \{ ?name: lvl/.test(text), `the probe is not flow style:\n${text}`);
  // width 1 = the QuickUVM default -> omitted; coverage only when requested
  text = ops.addProbe(text, { name: "busy", path: "u_ctl.busy", width: 1, coverage: true });
  assert.deepEqual(ops.parseQuvm(text).probes[1], {
    name: "busy", path: "u_ctl.busy", coverage: true,
  });
  assert.throws(
    () => ops.addProbe(text, { name: "lvl", path: "x" }),
    /already exists/
  );
});

test("addProbe: the modelled fields (enum/type/packed_dims/struct/real/clock) round-trip (§1.8)", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addProbe(text, {
    name: "state",
    path: "u_core.state_q",
    width: 3,
    enum: { IDLE: 0, RUN: 1 },
    type: "state_e",
    packed_dims: [2, 4],
    struct: [{ name: "a", width: 8 }],
    real: true,
    clock: "fast",
    coverage: true,
  });
  assert.deepEqual(ops.parseQuvm(text).probes[0], {
    name: "state",
    path: "u_core.state_q",
    width: 3,
    enum: { IDLE: 0, RUN: 1 },
    type: "state_e",
    packed_dims: [2, 4],
    struct: [{ name: "a", width: 8 }],
    real: true,
    clock: "fast",
    coverage: true,
  });
  // absent/false fields stay absent: a plain probe is byte-identical to before the fix
  text = ops.addProbe(text, { name: "busy", path: "u.busy", real: false, clock: undefined });
  assert.deepEqual(ops.parseQuvm(text).probes[1], { name: "busy", path: "u.busy" });
});

test("removeProbe: deletes by name, cleans up the empty list, idempotent", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addProbe(text, { name: "lvl", path: "u.lvl", width: 3 });
  text = ops.addProbe(text, { name: "busy", path: "u.busy" });
  text = ops.removeProbe(text, "lvl");
  assert.deepEqual(ops.parseQuvm(text).probes.map((p) => p.name), ["busy"]);
  // the last one -> the `probes` key disappears (unlike `analysis`, the absence
  // of the `probes` list is byte-identical for the generator — see keepAnalysis)
  text = ops.removeProbe(text, "busy");
  assert.equal(ops.parseQuvm(text).probes, undefined);
  assert.ok(!/probes:/.test(text), `the empty list was not cleaned up:\n${text}`);
  // idempotent: missing target -> original byte-identical text
  const fix = ops.setDut(ops.newConfigText("s"), DUT);
  assert.equal(ops.removeProbe(fix, "nope"), fix);
});

test("addConnections: flow, dedup on (from,to), byte-identical no-op", () => {
  let text = "project: {name: sys}\nlayout: packaged\nsubenvs:\n  - {name: p1, config: p.yaml}\n  - {name: c1, config: c.yaml}\n";
  text = ops.addConnections(text, [{ from: "p1.dout", to: "c1.din" }]);
  assert.deepEqual(ops.parseQuvm(text).connections, [{ from: "p1.dout", to: "c1.din" }]);
  assert.ok(/- \{ ?from: p1.dout/.test(text), `the connection is not flow style:\n${text}`);
  // idempotent per pair: the same (from,to) is not duplicated -> unchanged text
  assert.equal(ops.addConnections(text, [{ from: "p1.dout", to: "c1.din" }]), text);
  // a new pair is added
  text = ops.addConnections(text, [{ from: "p1.dout", to: "c1.din" }, { from: "c1.dout", to: "p1.din" }]);
  assert.deepEqual(ops.parseQuvm(text).connections.length, 2);
});

test("removeConnection: deletes the pair, cleans up the empty list, idempotent", () => {
  let text = ops.addConnections(
    "project: {name: sys}\nlayout: packaged\nsubenvs: [{name: p1, config: p.yaml}, {name: c1, config: c.yaml}]\n",
    [{ from: "p1.dout", to: "c1.din" }]
  );
  const before = text;
  text = ops.removeConnection(text, "p1.dout", "c1.din");
  assert.equal(ops.parseQuvm(text).connections, undefined); // the last one -> the key disappears
  // idempotent: missing pair -> original byte-identical text
  assert.equal(ops.removeConnection(text, "nope", "nope"), text);
  // no-op when the pair does not match
  assert.equal(ops.removeConnection(before, "x.a", "y.b"), before);
});

test("docs/08 R11 review: parseQuvm mirrors the canonical src/dst keys into from/to; the text mutations read both", () => {
  const text = "subenvs:\n  - { name: p, config: p.yaml }\n  - { name: c, config: c.yaml }\nconnections:\n  - { src: p.q, dst: c.d }\n";
  const cfg = ops.parseQuvm(text);
  assert.deepEqual(cfg.connections, [{ src: "p.q", dst: "c.d", from: "p.q", to: "c.d" }]);
  assert.equal(ops.addConnections(text, [{ from: "p.q", to: "c.d" }]), text, "already there under src/dst: a no-op");
  const out = ops.removeConnection(text, "p.q", "c.d");
  assert.ok(!/p\.q/.test(out), "removed by the mirrored pair");
});

test("setAgentActive: a hand-written `active: true` is deleted by the reset (docs/08 R16)", () => {
  const text = "agents:\n  - name: cmd\n    active: true\n    ports: {}\n";
  const out = ops.setAgentActive(text, "cmd", true);
  assert.ok(!/active:/.test(out), "the key is gone: the idempotence is on the key, not the value");
  assert.equal(ops.setAgentActive(out, "cmd", true), out, "idempotent once canonical");
  assert.equal(ops.setAgentActive(text, "cmd", false).includes("active: false"), true);
});

test("setAgentActive: passive writes active:false, active deletes the key, idempotent no-op", () => {
  let text = ops.createAgent(ops.setDut(ops.newConfigText("s"), DUT), {
    name: "cons", inputs: [{ name: "din", width: 8 }], outputs: [],
  });
  // -> passive
  text = ops.setAgentActive(text, "cons", false);
  assert.equal(ops.parseQuvm(text).agents[0].active, false);
  // byte-identical no-op when already passive
  assert.equal(ops.setAgentActive(text, "cons", false), text);
  // -> active deletes the key (the QuickUVM default)
  text = ops.setAgentActive(text, "cons", true);
  assert.equal(ops.parseQuvm(text).agents[0].active, undefined);
  assert.ok(!/active:/.test(text), `active was not deleted:\n${text}`);
  // nonexistent agent -> throws
  assert.throws(() => ops.setAgentActive(text, "nope", false), /does not exist/);
});

// file for manual inspection, useful for debugging
writeFileSync(join(outDir, "sample.yaml"),
  ops.ignorePorts(
    ops.createAgent(ops.setDut(ops.newConfigText("demo"), DUT), {
      name: "drv",
      inputs: [{ name: "din", width: 8 }],
      outputs: [{ name: "sum", width: 8 }],
    }),
    ["scan_en"]
  ));
console.log(`\n(generated sample:${join(outDir, "sample.yaml")})`);

// --- the host's agent-field gate must cover EVERY AgentField -------------------
// `emit_when` shipped in the type, the defaults and the inspector while the host's
// hand-written allow-list still lacked it: the edit was dropped without a word and
// the control looked like it reset itself. AGENT_FIELDS is now derived from
// AGENT_DEFAULTS, and this pins BOTH halves: the list is complete, and a write
// through it actually lands.
test("AGENT_FIELDS covers every writable agent field, emit_when included", () => {
  assert.ok(ops.AGENT_FIELDS.includes("emit_when"), "emit_when missing from the gate");
  for (const f of ["mode", "respond", "request_valid", "replicas", "clock", "reset"]) {
    assert.ok(ops.AGENT_FIELDS.includes(f), `${f} missing from the gate`);
  }
  // no stray entries: `active` goes through setAgentActive, not setAgentField
  assert.ok(!ops.AGENT_FIELDS.includes("active"), "active must not be an AgentField");
});

test("setAgentField writes emit_when, and the default deletes it", () => {
  let t = ops.newConfigText("d");
  t = ops.setDut(t, {
    module: "d", clock: "clk", reset: "rst_n",
    resetActiveLow: true, combinational: false,
  });
  t = ops.createAgent(t, {
    name: "pkt",
    inputs: [{ name: "in_valid", width: 1 }],
    outputs: [{ name: "out0_valid", width: 1 }],
  });
  const set = ops.setAgentField(t, "pkt", "emit_when", "in_valid");
  assert.match(set, /emit_when: in_valid/, "emit_when was not written");
  // "— every cycle —" is the empty value: it must REMOVE the key, not write ""
  const cleared = ops.setAgentField(set, "pkt", "emit_when", "");
  assert.ok(!cleared.includes("emit_when"), "clearing must delete the key");
});
test("addAgentPorts: appends on each side, skips what the agent has, no-op stays byte-identical", () => {
  const t = ops.createAgent(ops.newConfigText("demo"), {
    name: "drv",
    inputs: [{ name: "din", width: 8 }],
    outputs: [],
  });
  const t2 = ops.addAgentPorts(t, "drv", {
    inputs: [{ name: "din", width: 8 }, { name: "en", width: 1 }],
    outputs: [{ name: "sum", width: 8 }],
    inouts: [{ name: "sda", width: 1 }],
  });
  const a = ops.parseQuvm(t2).agents[0];
  assert.deepEqual(a.ports.inputs, [{ name: "din", width: 8 }, { name: "en" }], "din kept once, en appended");
  assert.deepEqual(a.ports.outputs, [{ name: "sum", width: 8, randomize: false }]);
  assert.deepEqual(a.ports.inouts, [{ name: "sda" }], "inouts created on demand, no randomize");
  assert.match(t2, /\{ name: en \}/, "flow style, like createAgent");
  // nothing to add: the ORIGINAL text, not a re-serialization
  assert.equal(ops.addAgentPorts(t2, "drv", { inputs: [{ name: "en", width: 1 }], outputs: [] }), t2);
  assert.throws(() => ops.addAgentPorts(t2, "nope", { inputs: [{ name: "x", width: 1 }], outputs: [] }), /nope/);
});
test("materializeAnalysis: writes the kept inferred set, {} when nothing is kept, no-op on a declared bench", () => {
  const t = ops.createAgent(ops.newConfigText("demo"), {
    name: "pkt", inputs: [{ name: "din", width: 8 }], outputs: [],
  });
  const both = ops.materializeAnalysis(t, { scoreboards: [{ name: "sbd", source: "pkt" }], coverage: ["pkt"] });
  const cfg = ops.parseQuvm(both);
  assert.deepEqual(cfg.analysis.scoreboards, [{ name: "sbd", source: "pkt" }]);
  assert.deepEqual(cfg.analysis.coverage, ["pkt"]);
  assert.match(both, /- \{ name: sbd, source: pkt \}/, "flow style, like addScoreboard");
  assert.match(both, /coverage: \[ pkt \]/, "flow style, like addCoverage");
  // the sharp edge of docs/07: nothing kept = declared mode with nothing wired
  const none = ops.materializeAnalysis(t, { scoreboards: [], coverage: [] });
  assert.match(none, /analysis: \{\}/);
  assert.deepEqual(ops.parseQuvm(none).analysis, {});
  // the other member of a pair stays absent (it is no longer generated)
  const sbOnly = ops.parseQuvm(ops.materializeAnalysis(t, { scoreboards: [{ name: "sbd", source: "pkt", monitor: "rsp", match: "out_of_order" }], coverage: [] }));
  assert.deepEqual(sbOnly.analysis, { scoreboards: [{ name: "sbd", source: "pkt", monitor: "rsp", match: "out_of_order" }] });
  // declared already: byte-identical, no phantom edit
  assert.equal(ops.materializeAnalysis(both, { scoreboards: [], coverage: [] }), both);
  // `analysis:` with no value is implicit (the scene draws ghosts): it is written
  const nullKey = ops.materializeAnalysis(t + "analysis:\n", { scoreboards: [], coverage: ["pkt"] });
  assert.deepEqual(ops.parseQuvm(nullKey).analysis, { coverage: ["pkt"] });
});
test("renameAgent: the name, its conventional interface/seq_item and every reference follow; cross-block endpoints, hand-written names and a missing agent do not", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, { name: "cmd", inputs: [{ name: "din", width: 8 }], outputs: [] });
  text = ops.createAgent(text, { name: "rsp", inputs: [], outputs: [{ name: "dout", width: 8 }] });
  text = ops.addCoverage(text, "cmd");
  text = ops.addScoreboard(text, { name: "sbd", source: "cmd", monitor: "rsp" });
  text = ops.addScoreboard(text, { name: "x", source: "u_a.cmd" }); // a CHILD's agent (cross-block)
  text = ops.addVirtualSequence(text, {
    name: "smoke", mode: "parallel",
    steps: [{ agent: "cmd", sequence: "cmd_seq" }, { agent: "rsp", sequence: "rsp_seq" }],
  });
  const out = ops.renameAgent(text, "cmd", "req");
  const cfg = ops.parseQuvm(out);
  assert.deepEqual(cfg.agents.map((a) => a.name), ["req", "rsp"]);
  assert.equal(cfg.agents[0].interface, "req_if", "the conventional interface name follows");
  assert.equal(cfg.agents[0].sequence_item, "req_seq_item");
  assert.deepEqual(cfg.analysis.coverage, ["req"]);
  assert.deepEqual(cfg.analysis.scoreboards.map((s) => [s.source, s.monitor]), [["req", "rsp"], ["u_a.cmd", undefined]]);
  assert.deepEqual(cfg.virtual_sequences[0].body.map((s) => s.agent), ["req", "rsp"]);
  assert.deepEqual(cfg.virtual_sequences[0].body.map((s) => s.sequence), ["cmd_seq", "rsp_seq"], "sequence names are the user's");
  // a rich coverage entry and the RAL bus agent follow too
  const rich = text.replace("coverage: [ cmd ]", "coverage:\n    - { agent: cmd, coverpoints: [] }") + "register_model:\n  package: p\n  block: b\n  bus_agent: cmd\n";
  const rcfg = ops.parseQuvm(ops.renameAgent(rich, "cmd", "req"));
  assert.equal(rcfg.analysis.coverage[0].agent, "req");
  assert.equal(rcfg.register_model.bus_agent, "req");
  // a hand-written interface name is not the convention: left alone
  const custom = text.replace("interface: cmd_if", "interface: my_if");
  assert.equal(ops.parseQuvm(ops.renameAgent(custom, "cmd", "req")).agents[0].interface, "my_if");
  assert.equal(ops.renameAgent(text, "nope", "x"), text, "missing agent: byte-identical");
  assert.equal(ops.renameAgent(text, "cmd", "cmd"), text, "same name: byte-identical");
  assert.throws(() => ops.renameAgent(text, "cmd", "rsp"), /already exists/);
  // the review's gaps: tests[].sequence.agent, a boundary agent's `<agent>.<port>`
  // endpoints in connections and cross-block scoreboards, and a VIP reference
  const hybrid = text.replace("tests:\n  - { name: s_test }", "tests:\n  - { name: t1, sequence: { agent: cmd, name: cmd_burst } }") +
    "subenvs:\n  - { name: u_b, config: b.yaml }\n" +
    "connections:\n  - { from: cmd.dout, to: u_b.din }\n  - { from: u_b.q, to: cmd.din }\n";
  const hcfg = ops.parseQuvm(ops.renameAgent(hybrid, "cmd", "req"));
  assert.equal(hcfg.tests[0].sequence.agent, "req");
  assert.deepEqual(hcfg.connections, [{ from: "req.dout", to: "u_b.din" }, { from: "u_b.q", to: "req.din" }]);
  const boundary = text.replace("source: u_a.cmd", "source: cmd.pkt");
  assert.equal(ops.parseQuvm(ops.renameAgent(boundary, "cmd", "req")).analysis.scoreboards[1].source, "req.pkt");
  const vip = ops.addVipAgent(ops.setDut(ops.newConfigText("s"), DUT), "io", "../vip/io.qvip");
  assert.throws(() => ops.renameAgent(vip, "io", "io2"), /VIP reference/);
});

test("renameScoreboardAt: duplicates are renamed by ordinal, not by the first of that name", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, { name: "cmd", inputs: [{ name: "din", width: 8 }], outputs: [] });
  const dup = text + "analysis:\n  scoreboards:\n    - { name: x, source: cmd }\n    - { name: x, source: cmd, monitor: cmd }\n    - { name: z, source: cmd }\n";
  const second = ops.parseQuvm(ops.renameScoreboardAt(dup, 1, "y")).analysis.scoreboards;
  assert.deepEqual(second.map((s) => s.name), ["x", "y", "z"], "the SECOND entry (sb:x#2) is the one renamed");
  assert.equal(second[1].monitor, "cmd", "and it keeps its own fields");
  assert.equal(ops.renameScoreboardAt(dup, 5, "y"), dup, "out of range: byte-identical");
  assert.equal(ops.renameScoreboardAt(dup, 0, "x"), dup, "same name: byte-identical");
  assert.throws(() => ops.renameScoreboardAt(dup, 2, "x"), /already exists/, "another entry's name is taken");
});

test("renameScoreboard / renameSubenv: the key, and for a subenv the endpoints that carry its name", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.createAgent(text, { name: "cmd", inputs: [{ name: "din", width: 8 }], outputs: [] });
  text = ops.addScoreboard(text, { name: "sbd", source: "cmd" });
  text = ops.addScoreboard(text, { name: "sb2", source: "cmd" });
  assert.deepEqual(ops.parseQuvm(ops.renameScoreboard(text, "sbd", "main")).analysis.scoreboards.map((s) => s.name), ["main", "sb2"]);
  assert.equal(ops.renameScoreboard(text, "zz", "q"), text);
  assert.throws(() => ops.renameScoreboard(text, "sbd", "sb2"), /already exists/);
  const y = ops.newConfigText("s") +
    "layout: packaged\nsubenvs:\n  - { name: u_a, config: a.yaml }\n  - { name: u_b, config: b.yaml }\n" +
    "connections:\n  - { from: u_a.dout, to: u_b.din }\n" +
    "analysis:\n  scoreboards:\n    - { name: x, source: u_a.cmd, monitor: u_b.cmd }\n";
  const r = ops.parseQuvm(ops.renameSubenv(y, "u_a", "prod"));
  assert.deepEqual(r.subenvs.map((s) => s.name), ["prod", "u_b"]);
  assert.deepEqual(r.connections, [{ from: "prod.dout", to: "u_b.din" }]);
  assert.deepEqual([r.analysis.scoreboards[0].source, r.analysis.scoreboards[0].monitor], ["prod.cmd", "u_b.cmd"]);
  assert.equal(ops.renameSubenv(y, "u_zz", "q"), y);
  assert.throws(() => ops.renameSubenv(y, "u_a", "u_b"), /already exists/);
});
test("docs/08 R8: quvmParseError — null on a valid config, the FIRST syntax error with its line otherwise", () => {
  assert.equal(ops.quvmParseError("dut:\n  name: adder\nagents:\n  - name: cmd\n"), null);
  assert.equal(ops.quvmParseError(""), null, "an empty file is empty, not invalid");
  assert.equal(ops.quvmParseError("# only a comment\n"), null);
  // a tab used for indentation, on line 2
  const tab = ops.quvmParseError("dut:\n\tname: adder\n");
  assert.ok(tab, "a tab indent is a YAML error");
  assert.equal(tab.line, 2);
  assert.ok(!/at line \d+, column/.test(tab.message), "the parser's own position tail is cut: " + tab.message);
  assert.ok(!tab.message.includes("\n"), "one line");
  assert.ok(tab.message.length > 0);
  // an unclosed flow sequence further down
  const flow = ops.quvmParseError("dut:\n  name: adder\nagents:\n  - {name: cmd\ntests: []\n");
  assert.ok(flow && flow.line >= 4, "reported at or after the line that opens it: " + JSON.stringify(flow));
  // two errors: only the first is reported (the later ones are usually its echoes)
  const two = ops.quvmParseError("a: [1\nb: }\n");
  assert.ok(two && two.line === 1 || two.line === 2);
});

test("docs/08 R8: quvmParseError — a top level that is not a mapping is not a configuration", () => {
  assert.deepEqual(ops.quvmParseError("- a\n- b\n"), {
    message: "the top level must be a mapping (key: value)",
    line: 1,
  });
  assert.ok(ops.quvmParseError("just a sentence\n"));
  assert.ok(ops.quvmParseError("42\n"));
  // parseQuvm still answers with what it could read — the view draws that,
  // the error says it is partial
  const broken = "dut:\n  name: adder\nagents:\n  - {name: cmd\n";
  assert.equal(ops.parseQuvm(broken).dut?.name, "adder", "the readable part survives");
  assert.ok(ops.quvmParseError(broken));
});

test("docs/08 R8: quvmParseError — valid YAML whose shape no reader can walk (a bare dash, a non-list)", () => {
  // a bare "-" typed as the start of a new entry parses — to null
  const bare = "dut:\n  name: adder\nagents:\n  - name: cmd\n  -\n";
  assert.deepEqual(ops.quvmParseError(bare), { message: "agents: entry 2 is empty", line: 5 });
  assert.deepEqual(ops.quvmParseError("agents: foo\n"), { message: "agents must be a list", line: 1 });
  assert.deepEqual(ops.quvmParseError("agents:\n  name: a\n"), { message: "agents must be a list", line: 2 });
  assert.deepEqual(
    ops.quvmParseError("agents:\n  - name: a\nanalysis:\n  scoreboards:\n    - name: s\n      source: a\n    - just text\n"),
    { message: "analysis.scoreboards: entry 2 is not a mapping (key: value)", line: 7 }
  );
  for (const key of ["subenvs", "connections", "probes", "virtual_sequences", "tests"]) {
    assert.ok(ops.quvmParseError(key + ":\n  -\n"), key + ": a null entry is reported");
    assert.equal(ops.quvmParseError(key + ": []\n"), null, key + ": an empty list is fine");
    assert.equal(ops.quvmParseError(key + ":\n"), null, key + ": a key with no value is fine");
  }
  // what the generator accepts is NOT reported: a list of names, a mapping section
  assert.equal(ops.quvmParseError("analysis:\n  coverage: [cmd, rsp]\n"), null);
  assert.equal(ops.quvmParseError("analysis: {}\n"), null);
  assert.equal(ops.quvmParseError("analysis:\n"), null);
  // parseQuvm no longer answers {} for a non-list "connections" (its own catch
  // swallowed the iteration error and the DUT and agents went with it)
  const c = ops.parseQuvm("dut:\n  name: adder\nagents:\n  - name: cmd\nconnections: 5\n");
  assert.equal(c.dut?.name, "adder");
  assert.equal(c.agents?.length, 1);
});

test("docs/08 R9: one field folded over several agents is ONE text change, comments kept, no-op byte-identical", () => {
  const y = [
    "# bench",
    "agents:",
    "  - name: cmd   # drives",
    "    interface: cmd_if",
    "  - name: rsp",
    "    active: false",
    "  - name: aux",
    "    active: true   # hand-written default",
    "",
  ].join("\n");
  // the host's fold: targets.reduce((acc, n) => op(acc, n), text)
  const fold = (text, names, op) => names.reduce((acc, n) => op(acc, n), text);
  const passive = fold(y, ["cmd", "rsp", "aux"], (t, n) => ops.setAgentActive(t, n, false));
  assert.deepEqual(ops.parseQuvm(passive).agents.map((a) => a.active), [false, false, false]);
  assert.ok(passive.includes("# drives") && passive.includes("# bench"), "comments survive the fold");
  // back to active: every `active` key goes (true is the default, written nowhere)
  const active = fold(passive, ["cmd", "rsp", "aux"], (t, n) => ops.setAgentActive(t, n, true));
  assert.deepEqual(ops.parseQuvm(active).agents.map((a) => "active" in a), [false, false, false]);
  // already what was asked: the fold returns the SAME text (no WorkspaceEdit at all)
  assert.equal(fold(passive, ["cmd", "rsp", "aux"], (t, n) => ops.setAgentActive(t, n, false)), passive);
  // another bulk field, and its reset
  const macros = fold(y, ["cmd", "rsp"], (t, n) => ops.setAgentField(t, n, "seq_item_style", "field_macros"));
  assert.deepEqual(ops.parseQuvm(macros).agents.map((a) => a.seq_item_style), ["field_macros", "field_macros", undefined]);
  assert.equal(
    ops.parseQuvm(fold(macros, ["cmd", "rsp"], (t, n) => ops.setAgentField(t, n, "seq_item_style", undefined))).agents[0].seq_item_style,
    undefined
  );
});

test("R24 resetAsList: the single reset as a ONE-entry list, named after dut.reset, polarity kept", () => {
  const base = ops.setDut(ops.newConfigText("d"), {
    module: "d", clock: "clk", reset: "rst", resetActiveLow: false, combinational: false,
  });
  // what setDut writes (D25): the testbench top drives the reset
  assert.deepEqual(ops.parseQuvm(base).reset, { active_low: false, external: true });
  const listed = ops.resetAsList(base);
  assert.deepEqual(ops.parseQuvm(listed).reset, [{ name: "rst", active_low: false }]);
  assert.equal(ops.parseQuvm(listed).dut.reset, "rst", "dut.reset now names the entry");
  assert.equal(ops.resetAsList(listed), listed, "already a list: the same text");
  // an active-low reset: `external: true` is DROPPED by the conversion (a list
  // is always top-driven), so the entry is just the name
  const low = ops.setDut(ops.newConfigText("d"), {
    module: "d", clock: "clk", reset: "rst_n", resetActiveLow: true, combinational: false,
  });
  assert.deepEqual(ops.parseQuvm(low).reset, { external: true });
  assert.deepEqual(ops.parseQuvm(ops.resetAsList(low)).reset, [{ name: "rst_n" }]);
  // ... and the old shape (no `reset:` block at all) converts the same way
  const bare = ops.setResetDomainField(low, "rst_n", "external", false);
  assert.equal(ops.parseQuvm(bare).reset, undefined);
  assert.deepEqual(ops.parseQuvm(ops.resetAsList(bare)).reset, [{ name: "rst_n" }]);
  // the round trip: collapsing the one-entry list gives the top-driven mapping back
  assert.deepEqual(ops.parseQuvm(ops.collapseResets(ops.resetAsList(low))).reset, { external: true });
  // the list composes with the domain mutations (the template's fold)
  const two = ops.setResetDomainField(ops.addResetDomain(ops.resetAsList(low), "b_rst_n"), "b_rst_n", "clock", "b_clk");
  assert.deepEqual(ops.parseQuvm(two).reset, [{ name: "rst_n" }, { name: "b_rst_n", clock: "b_clk" }]);
  // no reset: nothing to declare
  const none = ops.setDut(ops.newConfigText("d"), {
    module: "d", clock: "clk", reset: null, resetActiveLow: true, combinational: false,
  });
  assert.equal(ops.resetAsList(none), none);
  // an AGENT-driven reset (the port is one of an agent's ports) cannot become a
  // list entry: the domain would be a tb_top net of the same name, which
  // quick-uvm refuses — the same wall as addResetDomain
  const driven = ops.setDut(
    ops.createAgent(ops.newConfigText("d"), {
      name: "a", inputs: [{ name: "din", width: 8 }, { name: "rst_n", width: 1 }], outputs: [],
    }),
    { module: "d", clock: "clk", reset: "rst_n", resetActiveLow: true, combinational: false }
  );
  assert.equal(ops.parseQuvm(driven).reset, undefined, "an agent drives it: no external");
  assert.throws(() => ops.resetAsList(driven), /driven by an agent/);
});

test('docs/07 "Interim": the first analysis entry with what inference provided is a FOLD of the gestures', () => {
  let base = ops.createAgent(ops.newConfigText("buf"), {
    name: "cmd", inputs: [{ name: "d", width: 8 }], outputs: [{ name: "q", width: 8 }],
  });
  base = ops.createAgent(base, { name: "rsp", inputs: [{ name: "r" }], outputs: [{ name: "v" }] });
  const sb = { name: "pkt_sb", source: "cmd", monitor: "rsp", match: "out_of_order", matchKey: "v" };

  // the tutorial's case: the inferred scoreboard (same source) is replaced, its
  // coverage kept — byte for byte what "add scoreboard" then "add coverage" write
  const kept = ops.addScoreboardKeeping(base, sb, { scoreboards: [], coverage: ["cmd"] });
  assert.equal(kept, ops.addCoverage(ops.addScoreboard(base, sb), "cmd"));
  assert.deepEqual(ops.parseQuvm(kept).analysis.coverage, ["cmd"]);

  // another source: the inferred scoreboard stays beside the new one. The NEW
  // entry is FIRST — a drop gesture gives its drop point to the first node of the
  // kind that was not there before, and that must be the one the user created —
  // and the resolved entry's default `match: in_order` is not written
  const other = ops.addScoreboardKeeping(
    base,
    { name: "rsp_sb", source: "rsp" },
    { scoreboards: [{ name: "sbd", source: "cmd", match: "in_order" }], coverage: ["cmd"] }
  );
  assert.deepEqual(ops.parseQuvm(other).analysis, {
    scoreboards: [{ name: "rsp_sb", source: "rsp" }, { name: "sbd", source: "cmd" }],
    coverage: ["cmd"],
  });
  assert.equal(
    other,
    ops.addCoverage(
      ops.addScoreboard(ops.addScoreboard(base, { name: "rsp_sb", source: "rsp" }), { name: "sbd", source: "cmd" }),
      "cmd"
    )
  );

  // coverage as the first entry: the new collector first, then the inferred one
  // and the scoreboard
  const cov = ops.addCoverageKeeping(base, "rsp", {
    scoreboards: [{ name: "sbd", source: "cmd" }], coverage: ["cmd"],
  });
  assert.deepEqual(ops.parseQuvm(cov).analysis, {
    coverage: ["rsp", "cmd"],
    scoreboards: [{ name: "sbd", source: "cmd" }],
  });
  assert.equal(cov, ops.addScoreboard(ops.addCoverage(ops.addCoverage(base, "rsp"), "cmd"), { name: "sbd", source: "cmd" }));
  // the agent the gesture names may be in the kept list too: once
  assert.deepEqual(
    ops.parseQuvm(ops.addCoverageKeeping(base, "cmd", { scoreboards: [], coverage: ["cmd"] })).analysis.coverage,
    ["cmd"]
  );

  // nothing kept: exactly the plain mutations
  const none = { scoreboards: [], coverage: [] };
  assert.equal(ops.addScoreboardKeeping(base, sb, none), ops.addScoreboard(base, sb));
  assert.equal(ops.addCoverageKeeping(base, "rsp", none), ops.addCoverage(base, "rsp"));

  // `analysis:` with no value is implicit too (the scene and materializeAnalysis agree)
  const empty = base.replace(/\n*$/, "\nanalysis:\n");
  assert.equal(ops.parseQuvm(empty).analysis, null);
  assert.deepEqual(
    ops.parseQuvm(ops.addScoreboardKeeping(empty, { name: "s", source: "rsp" }, {
      scoreboards: [{ name: "sbd", source: "cmd" }], coverage: ["cmd"],
    })).analysis,
    { scoreboards: [{ name: "s", source: "rsp" }, { name: "sbd", source: "cmd" }], coverage: ["cmd"] }
  );

  // ... and the plain mutations no longer THROW on it ("Expected YAML collection
  // at analysis" — setIn cannot descend into a null scalar). The key keeps its
  // place and its comment.
  const placed = "analysis: # to fill in\n" + base;
  for (const out of [ops.addCoverage(placed, "cmd"), ops.addScoreboard(placed, { name: "s", source: "cmd" })]) {
    assert.match(out, /^analysis:/, "the key stays where the user put it");
    assert.match(out, /# to fill in/, "its comment survives");
    assert.equal(ops.parseQuvm(out).agents.length, 2);
  }
  assert.deepEqual(ops.parseQuvm(ops.addCoverage(placed, "cmd")).analysis, { coverage: ["cmd"] });

  // the caller keeps the names apart: a new scoreboard named like a kept one is refused
  assert.throws(
    () => ops.addScoreboardKeeping(base, { name: "sbd", source: "rsp" }, {
      scoreboards: [{ name: "sbd", source: "cmd" }], coverage: [],
    }),
    /already exists/
  );
  // comments and unknown keys survive the fold
  const noted = base.replace("agents:", "# my agents\nagents:");
  assert.match(ops.addCoverageKeeping(noted, "rsp", { scoreboards: [{ name: "sbd", source: "cmd" }], coverage: [] }), /# my agents/);
});

test('docs/07 "Interim": a plan made for an implicit text is NOT applied to one that declares analysis', () => {
  // the plan is computed, then a question waits (the name box, the modal) or a
  // Python process runs — and the text may have left implicit mode meanwhile
  let base = ops.createAgent(ops.newConfigText("buf"), {
    name: "cmd", inputs: [{ name: "d", width: 8 }], outputs: [],
  });
  base = ops.createAgent(base, { name: "rsp", inputs: [{ name: "r" }], outputs: [] });
  const keep = { scoreboards: [{ name: "sbd", source: "cmd" }], coverage: ["cmd"] };

  // the same gesture twice (two quick clicks): the second finds its own first
  // write — the plain mutation, whose "already there" is a no-op
  const once = ops.addCoverageKeeping(base, "rsp", keep);
  assert.equal(ops.addCoverageKeeping(once, "rsp", keep), once, "byte-identical: no second sbd, no throw");

  // the user declared an EMPTY list by hand meanwhile: nothing inferred is put back into it
  const declared = base.replace(/\n*$/, "\nanalysis:\n  scoreboards: []\n");
  assert.deepEqual(ops.parseQuvm(ops.addCoverageKeeping(declared, "rsp", keep)).analysis, {
    scoreboards: [], coverage: ["rsp"],
  });
  assert.deepEqual(
    ops.parseQuvm(ops.addScoreboardKeeping(declared, { name: "x", source: "rsp" }, keep)).analysis,
    { scoreboards: [{ name: "x", source: "rsp" }] }
  );
  // `analysis: {}` is declared mode with nothing wired — not implicit
  const braces = base.replace(/\n*$/, "\nanalysis: {}\n");
  assert.deepEqual(ops.parseQuvm(ops.addCoverageKeeping(braces, "rsp", keep)).analysis, { coverage: ["rsp"] });
});

test("addCoverage: an agent already covered returns the ORIGINAL text (the no-op invariant)", () => {
  // it returned the re-serialised document: on a hand-formatted file that is a
  // phantom edit — the spacing changes, a WorkspaceEdit is made, undo gains a step
  const hand = [
    "project: {name: x}",
    "agents:",
    "  - {name: cmd, interface: cmd_if, sequence_item: cmd_item, ports: {inputs: [{name: d}], outputs: []}}",
    "analysis:",
    "  coverage: [cmd,rsp]   # mine",
    "",
  ].join("\n");
  assert.equal(ops.addCoverage(hand, "cmd"), hand);
  assert.equal(ops.addCoverage(hand, "rsp"), hand);
  // a rich entry covers its agent too
  const rich = hand.replace("[cmd,rsp]   # mine", "[{agent: cmd, coverpoints: []}]");
  assert.equal(ops.addCoverage(rich, "cmd"), rich);
  assert.notEqual(ops.addCoverage(hand, "other"), hand, "a new agent is still added");
});

if (failures) {
  console.error(`\n${failures} tests failed`);
  process.exit(1);
}
console.log("all yamlops tests passed");
