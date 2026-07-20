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
  externalReset: false,
  combinational: false,
};

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures++;
    console.error(`  ESEC  ${name}\n        ${e.message}`);
  }
}

test("schelet nou: YAML valid cu project/clock/tests", () => {
  const text = ops.newConfigText("demo");
  const cfg = ops.parseQuvm(text);
  assert.equal(cfg.project.name, "demo");
  assert.equal(cfg.clock.period, 10);
  assert.equal(cfg.tests[0].name, "demo_test");
});

test("setDut: scrie dut-ul si pastreaza restul", () => {
  const text = ops.setDut(ops.newConfigText("demo"), DUT);
  const cfg = ops.parseQuvm(text);
  assert.equal(cfg.dut.name, "soc_top");
  assert.equal(cfg.dut.clock, "clk");
  assert.equal(cfg.dut.reset, "rst_n");
  assert.equal(cfg.reset, undefined); // defaults -> no `reset:` block
  assert.equal(cfg.project.name, "demo");
});

test("setDut: abaterile de reset merg in cheia TOP-LEVEL `reset:` (1.0)", () => {
  let text = ops.setDut(ops.newConfigText("demo"), {
    ...DUT, resetActiveLow: false, externalReset: true,
  });
  assert.deepEqual(ops.parseQuvm(text).reset,
    { active_low: false, external: true });
  // the old keys on dut are NO longer written (1.0 rejects them with a guide-error)
  assert.ok(!/reset_active_low|external_reset/.test(text));
  // returning to defaults deletes the block
  text = ops.setDut(text, DUT);
  assert.equal(ops.parseQuvm(text).reset, undefined);
});

test("setDut: o LISTA `reset:` scrisa de mana nu se atinge", () => {
  const withList = ops.setDut(ops.newConfigText("demo"), DUT) +
    "reset:\n  - {name: wrst_n, clock: wclk}\n";
  const text = ops.setDut(withList, { ...DUT, resetActiveLow: false });
  assert.ok(Array.isArray(ops.parseQuvm(text).reset));
});

test("setDut combinational: reset gol + combinational true", () => {
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

test("setDut pastreaza comentariile si campurile necunoscute", () => {
  const src = [
    "# comentariul meu important",
    "project: {name: x}",
    "analysis:",
    "  coverage: [a]   # de pastrat",
    "camp_necunoscut: {k: v}",
    "",
  ].join("\n");
  const text = ops.setDut(src, DUT);
  assert.match(text, /comentariul meu important/);
  assert.match(text, /de pastrat/);
  assert.match(text, /camp_necunoscut/);
  assert.equal(ops.parseQuvm(text).dut.name, "soc_top");
});

test("createAgent: forma din docs/03, flow pe porturi", () => {
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

test("createAgent: nume duplicat => eroare", () => {
  const text = ops.createAgent(ops.newConfigText("demo"), {
    name: "drv",
    inputs: [],
    outputs: [],
  });
  assert.throws(() => ops.createAgent(text, { name: "drv", inputs: [], outputs: [] }),
    /exista deja/);
});

test("ignorePorts: uniune sortata, fara duplicate; unignore curata blocul", () => {
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

test("setAgentPortWidth: actualizeaza si stie sa omita width=1", () => {
  let text = ops.createAgent(ops.newConfigText("demo"), {
    name: "drv",
    inputs: [{ name: "din", width: 8 }],
    outputs: [],
  });
  text = ops.setAgentPortWidth(text, "drv", "din", 16);
  assert.equal(ops.parseQuvm(text).agents[0].ports.inputs[0].width, 16);
  text = ops.setAgentPortWidth(text, "drv", "din", 1);
  assert.equal(ops.parseQuvm(text).agents[0].ports.inputs[0].width, undefined);
  assert.throws(() => ops.setAgentPortWidth(text, "drv", "nu_exista", 4),
    /nu exista/);
});

test("createSubenvs: params flow doar cu valori, comentarii pastrate, duplicate refuzate", () => {
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
  assert.ok(/params: \{ ?W: 8 ?\}/.test(text), `params nu e flow:\n${text}`);
  assert.ok(text.includes("# Configuratie QuickUVM"));
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
    /exista deja/
  );
});

test("topConfigPaths: scaffold-urile copiilor nu devin config-ul activ", () => {
  // the real regression scenario: chan.quickuvm.yaml (createSubenv scaffold)
  // wins alphabetically, but is referenced by demo_top -> the top stays demo_top
  let top = ops.setDut(ops.newConfigText("demo_top"), DUT);
  top = ops.createSubenvs(top, [
    { name: "g_ch_0_u_ch", config: "chan.quickuvm.yaml", params: { W: 16 } },
  ]);
  const chan = ops.setDut(ops.newConfigText("chan"), {
    module: "chan", clock: null, reset: null,
    resetActiveLow: true, externalReset: false, combinational: true,
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

test("isComposedChild: copilul compus e detectat (avertismentul K2 #2)", () => {
  let top = ops.setDut(ops.newConfigText("demo_top"), DUT);
  top = ops.createSubenvs(top, [
    { name: "g_ch_0_u_ch", config: "chan.quickuvm.yaml", params: { W: 16 } },
  ]);
  const chan = ops.setDut(ops.newConfigText("chan"), {
    module: "chan", clock: null, reset: null,
    resetActiveLow: true, externalReset: false, combinational: true,
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

test("addScoreboard: two-stream OOO, flow map, nume duplicat refuzat", () => {
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
  assert.ok(/- \{ ?name: sbd/.test(text), `scoreboard nu e flow:\n${text}`);
  // single-stream: monitor/match omitted
  text = ops.addScoreboard(text, { name: "sb2", source: "cmd", match: "in_order" });
  assert.deepEqual(ops.parseQuvm(text).analysis.scoreboards[1], {
    name: "sb2",
    source: "cmd",
  });
  assert.throws(
    () => ops.addScoreboard(text, { name: "sbd", source: "x" }),
    /exista deja/
  );
});

test("addCoverage: idempotent, pastreaza scoreboards", () => {
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

test("addVirtualSequence: mode parallel, pasi flow, sequential omite mode", () => {
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
  assert.ok(/- \{ ?agent: cmd/.test(text), `pasii nu sunt flow:\n${text}`);
  // sequential: mode omitted (byte-identical with the default)
  text = ops.addVirtualSequence(text, {
    name: "seq2",
    mode: "sequential",
    steps: [{ agent: "cmd", sequence: "cmd_seq" }],
  });
  assert.equal(ops.parseQuvm(text).virtual_sequences[1].mode, undefined);
  assert.throws(
    () => ops.addVirtualSequence(text, { name: "smoke", mode: "sequential", steps: [] }),
    /exista deja/
  );
});

test("round-trip: YAML-ul generat trece prin parseQuvm nealterat semantic", () => {
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

test("removeScoreboard: sterge dupa nume, PASTREAZA blocul analysis gol, idempotent", () => {
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
  assert.ok(!/scoreboards:/.test(text), `lista goala nu s-a curatat:\n${text}`);
  assert.ok(/analysis:/.test(text), `blocul analysis a fost sters:\n${text}`);
  // idempotent: nonexistent name -> unchanged text (apply becomes a no-op)
  const fix = ops.setDut(ops.newConfigText("s"), DUT);
  assert.equal(ops.removeScoreboard(fix, "nope"), fix);
});

test("removeCoverage: sterge un agent, pastreaza restul si blocul analysis gol", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addCoverage(text, "cmd");
  text = ops.addCoverage(text, "rsp");
  text = ops.removeCoverage(text, "cmd");
  assert.deepEqual(ops.parseQuvm(text).analysis.coverage, ["rsp"]);
  text = ops.removeCoverage(text, "rsp");
  // the `analysis` block stays empty (otherwise QuickUVM revives the defaults)
  assert.deepEqual(ops.parseQuvm(text).analysis, {});
  assert.ok(/analysis:/.test(text), `blocul analysis a fost sters:\n${text}`);
});

test("removeVirtualSequence: sterge dupa nume, curata cheia goala", () => {
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

test("removeAgent: cascada peste coverage, scoreboards (source+monitor) si vseq", () => {
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

test("setScoreboardField: seteaza/reseteaza campuri, arunca la scoreboard inexistent", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addScoreboard(text, { name: "sbd", source: "cmd" });
  text = ops.setScoreboardField(text, "sbd", "monitor", "rsp");
  text = ops.setScoreboardField(text, "sbd", "match", "out_of_order");
  text = ops.setScoreboardField(text, "sbd", "match_key", "id");
  assert.deepEqual(ops.parseQuvm(text).analysis.scoreboards[0], {
    name: "sbd", source: "cmd", monitor: "rsp", match: "out_of_order", match_key: "id",
  });
  assert.ok(/- \{ ?name: sbd/.test(text), `scoreboard nu mai e flow:\n${text}`);
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
    /nu exista/
  );
  // source is mandatory: emptying it is refused (does not corrupt the scoreboard)
  assert.throws(() => ops.setScoreboardField(text, "sbd", "source", ""), /obligatoriu/);
  assert.throws(
    () => ops.setScoreboardField(text, "sbd", "source", undefined),
    /obligatoriu/
  );
});

test("remove*: no-op pastreaza byte-identic containerele goale scrise de mana", () => {
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

test("removeAgent: pastreaza un vseq cu body gol scris de mana", () => {
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

test("setScoreboardField: cascada — monitor gol / match in_order curata match_key", () => {
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

test("addProbe: flow map, width=1 omisa, coverage doar cand e cerut, duplicat refuzat", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addProbe(text, { name: "lvl", path: "u_fifo.level", width: 3 });
  assert.deepEqual(ops.parseQuvm(text).probes[0], {
    name: "lvl", path: "u_fifo.level", width: 3,
  });
  assert.ok(/- \{ ?name: lvl/.test(text), `proba nu e flow:\n${text}`);
  // width 1 = the QuickUVM default -> omitted; coverage only when requested
  text = ops.addProbe(text, { name: "busy", path: "u_ctl.busy", width: 1, coverage: true });
  assert.deepEqual(ops.parseQuvm(text).probes[1], {
    name: "busy", path: "u_ctl.busy", coverage: true,
  });
  assert.throws(
    () => ops.addProbe(text, { name: "lvl", path: "x" }),
    /exista deja/
  );
});

test("removeProbe: sterge dupa nume, curata lista goala, idempotent", () => {
  let text = ops.setDut(ops.newConfigText("s"), DUT);
  text = ops.addProbe(text, { name: "lvl", path: "u.lvl", width: 3 });
  text = ops.addProbe(text, { name: "busy", path: "u.busy" });
  text = ops.removeProbe(text, "lvl");
  assert.deepEqual(ops.parseQuvm(text).probes.map((p) => p.name), ["busy"]);
  // the last one -> the `probes` key disappears (unlike `analysis`, the absence
  // of the `probes` list is byte-identical for the generator — see keepAnalysis)
  text = ops.removeProbe(text, "busy");
  assert.equal(ops.parseQuvm(text).probes, undefined);
  assert.ok(!/probes:/.test(text), `lista goala nu s-a curatat:\n${text}`);
  // idempotent: missing target -> original byte-identical text
  const fix = ops.setDut(ops.newConfigText("s"), DUT);
  assert.equal(ops.removeProbe(fix, "nope"), fix);
});

test("addConnections: flow, dedup pe (from,to), no-op byte-identic", () => {
  let text = "project: {name: sys}\nlayout: packaged\nsubenvs:\n  - {name: p1, config: p.yaml}\n  - {name: c1, config: c.yaml}\n";
  text = ops.addConnections(text, [{ from: "p1.dout", to: "c1.din" }]);
  assert.deepEqual(ops.parseQuvm(text).connections, [{ from: "p1.dout", to: "c1.din" }]);
  assert.ok(/- \{ ?from: p1.dout/.test(text), `conexiunea nu e flow:\n${text}`);
  // idempotent per pair: the same (from,to) is not duplicated -> unchanged text
  assert.equal(ops.addConnections(text, [{ from: "p1.dout", to: "c1.din" }]), text);
  // a new pair is added
  text = ops.addConnections(text, [{ from: "p1.dout", to: "c1.din" }, { from: "c1.dout", to: "p1.din" }]);
  assert.deepEqual(ops.parseQuvm(text).connections.length, 2);
});

test("removeConnection: sterge perechea, curata lista goala, idempotent", () => {
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

test("setAgentActive: pasiv scrie active:false, activ sterge cheia, no-op idempotent", () => {
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
  assert.ok(!/active:/.test(text), `active nu s-a sters:\n${text}`);
  // nonexistent agent -> throws
  assert.throws(() => ops.setAgentActive(text, "nope", false), /nu exista/);
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
console.log(`\n(exemplu generat: ${join(outDir, "sample.yaml")})`);

if (failures) {
  console.error(`\n${failures} teste esuate`);
  process.exit(1);
}
console.log("toate testele yamlops au trecut");
