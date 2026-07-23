// End-to-end validation of the phase 2 flow (the criterion from docs/06): from a
// DUT in examples/ to a generated QuickUVM testbench, exclusively through the mutations
// that the extension's actions would produce (yamlops) — no hand-written YAML.
// Requires quick-uvm installed (or importable via python): npm run test:e2e
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

/** the full paths of the generated files (recursive) */
function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listFiles(p));
    } else {
      out.push(p);
    }
  }
  return out;
}

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-"));
await esbuild.build({
  entryPoints: ["src/yamlops.ts"],
  outfile: join(outDir, "yamlops.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const ops = await import(pathToFileURL(join(outDir, "yamlops.mjs")));

function quickUvm(args, cwd) {
  const env = { ...process.env, PYTHONUTF8: "1" };
  let r = spawnSync("quick-uvm", args, { cwd, env, encoding: "utf8" });
  if (r.error?.code === "ENOENT") {
    // the extension's fallback: the installed module, via python (generate.ts)
    r = spawnSync(
      "python",
      ["-c", "from quick_uvm.cli import main; main()", ...args],
      { cwd, env, encoding: "utf8" }
    );
  }
  return r;
}

// the variant that does NOT throw: for the scenarios that are EXPECTED to fail
// (quick-uvm constraints). Returns {status, out} for a composed top.
function quickUvmComposed(topText, producerText, consumerText) {
  const dir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-comp-"));
  writeFileSync(join(dir, "sys_top.quickuvm.yaml"), topText);
  writeFileSync(join(dir, "producer.quickuvm.yaml"), producerText);
  writeFileSync(join(dir, "consumer.quickuvm.yaml"), consumerText);
  const r = quickUvm(
    ["generate", "-c", join(dir, "sys_top.quickuvm.yaml"), "-o", join(dir, "tb")],
    dir
  );
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function generate(name, yamlText, expectFiles, extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), `quickuvm-e2e-${name}-`));
  const cfg = join(dir, `${name}.quickuvm.yaml`);
  writeFileSync(cfg, yamlText);
  // the H1 composition's child configs, next to the top config (docs/03)
  for (const [file, text] of Object.entries(extraFiles)) {
    writeFileSync(join(dir, file), text);
  }
  const r = quickUvm(["generate", "-c", cfg, "-o", join(dir, "tb")], dir);
  if (r.status !== 0) {
    console.error(r.stdout ?? "");
    console.error(r.stderr ?? "");
    throw new Error(`quick-uvm generate a esuat pentru ${name} (${r.status})`);
  }
  for (const f of expectFiles) {
    assert.ok(existsSync(join(dir, "tb", f)), `lipseste ${f} (in ${dir})`);
  }
  console.log(`  ok    ${name}: testbench generat (${expectFiles.length}+ fisiere) in ${dir}`);
  return dir;
}

// --- scenario 1: combinational adder (equivalent of the actions on examples/)
// setDut: no clock candidate -> combinational (confirmed in QuickPick);
// createAgentFromPins on {din, dout}: din -> inputs, dout -> outputs.
{
  let text = ops.newConfigText("adder");
  text = ops.setDut(text, {
    module: "adder",
    clock: null,
    reset: null,
    resetActiveLow: true,
    externalReset: false,
    combinational: true,
  });
  text = ops.createAgent(text, {
    name: "a",
    inputs: [{ name: "din", width: 8 }],
    outputs: [{ name: "dout", width: 8 }],
  });
  generate("adder", text, [
    "adder.sv",
    "a_if.sv",
    "a_seq_item.svh",
    "a_driver.svh",
    "adder_scoreboard.svh",
    "tb_top.sv",
  ]);
}

// --- scenario 2: sequential soc_top — clk/rst_n heuristic, agent on
// din/sum/inv, ch_out (unpacked array) excluded and explicitly ignored, and
// the bus interface port stays unmapped (configured separately).
{
  let text = ops.newConfigText("soc_top");
  text = ops.setDut(text, {
    module: "soc_top",
    clock: "clk",
    reset: "rst_n",
    resetActiveLow: true,
    externalReset: false,
    combinational: false,
  });
  text = ops.createAgent(text, {
    name: "datapath",
    inputs: [{ name: "din", width: 8 }],
    outputs: [
      { name: "sum", width: 8 },
      { name: "inv", width: 8 },
    ],
  });
  text = ops.ignorePorts(text, ["ch_out"]);
  // slice 2 of the verification view: a coverage collector + a single-stream
  // scoreboard added through the editing mutations (equivalent of the palette)
  text = ops.addCoverage(text, "datapath");
  text = ops.addScoreboard(text, { name: "sbd", source: "datapath" });
  generate("soc_top", text, [
    "soc_top.sv",
    "datapath_if.sv",
    "datapath_monitor.svh",
    "datapath_cov.svh",
    "soc_top_scoreboard.svh",
    "soc_top_env.svh",
    "tb_top.sv",
  ]);
}

// --- scenario 3: H1 composition (createSubenv, docs/03) — the top references three
// child blocks through their own configs, also built exclusively through
// yamlops (equivalent of the skeleton created by the action + the agent configured
// later by the user, the recursive flow). Two combinational + one with a
// clock: the clocked children (single-clock, at most one reset) are accepted by
// QuickUVM from the M1 clocked-subenv slice (verified on HEAD, Jul. 2026).
{
  const comb = (m) => ({
    module: m,
    clock: null,
    reset: null,
    resetActiveLow: true,
    externalReset: false,
    combinational: true,
  });
  const clocked = (m) => ({
    module: m,
    clock: "clk",
    reset: "rst_n",
    resetActiveLow: true,
    externalReset: false,
    combinational: false,
  });
  const child = (m, w, dut) =>
    ops.createAgent(ops.setDut(ops.newConfigText(m), dut(m)), {
      name: `${m}_a`,
      inputs: [{ name: "din", width: w }],
      outputs: [{ name: "dout", width: w }],
    });
  let top = ops.setDut(ops.newConfigText("soc_top"), {
    module: "soc_top",
    clock: "clk",
    reset: "rst_n",
    resetActiveLow: true,
    externalReset: false,
    combinational: false,
  });
  top = ops.createSubenvs(top, [
    { name: "u_add", config: "adder.quickuvm.yaml", params: {} },
    { name: "u_inv", config: "inverter.quickuvm.yaml", params: {} },
    { name: "u_ch", config: "chan.quickuvm.yaml", params: {} },
  ]);
  generate(
    "soc_top",
    top,
    [
      "tb_top.sv",
      "run.f",
      "soc_top_env.svh",
      "soc_top_virtual_sequencer.svh",
      "adder_env_pkg.sv",
      "adder_a_agent.svh",
      "inverter_env_pkg.sv",
      "inverter_scoreboard.svh",
      "chan_env_pkg.sv",
      "chan_a_agent.svh",
    ],
    {
      "adder.quickuvm.yaml": child("adder", 8, comb),
      "inverter.quickuvm.yaml": child("inverter", 8, comb),
      "chan.quickuvm.yaml": child("chan", 16, clocked),
    }
  );
}

// --- scenario 4: DELETION (slice 2 of the verification view) — removeAgent's
// cascade verified against the REAL generator. The test's value: if the
// deletion left a dead reference (a scoreboard with monitor == the deleted
// agent, an orphan coverage entry), QuickUVM's Pydantic would REFUSE the
// config and `generate` would exit != 0 — the pure yamlops tests cannot catch
// that. In addition, the artifacts of the deleted components must DISAPPEAR.
{
  const soc = {
    module: "soc_top",
    clock: "clk",
    reset: "rst_n",
    resetActiveLow: true,
    externalReset: false,
    combinational: false,
  };
  let text = ops.setDut(ops.newConfigText("soc_top"), soc);
  text = ops.createAgent(text, {
    name: "cmd",
    inputs: [{ name: "din", width: 8 }],
    outputs: [],
  });
  text = ops.createAgent(text, {
    name: "rsp",
    inputs: [],
    outputs: [
      { name: "sum", width: 8 },
      { name: "inv", width: 8 },
    ],
  });
  text = ops.ignorePorts(text, ["ch_out"]);
  text = ops.addCoverage(text, "cmd");
  text = ops.addCoverage(text, "rsp");
  // two-stream scoreboard: the monitor is `rsp` — deleting it must also take
  // the scoreboard, otherwise a dead reference remains
  text = ops.addScoreboard(text, {
    name: "sbd",
    source: "cmd",
    monitor: "rsp",
    match: "in_order",
  });
  text = ops.addVirtualSequence(text, {
    name: "smoke",
    mode: "sequential",
    steps: [{ agent: "cmd", sequence: "cmd_seq" }],
  });

  // baseline: both agents and their coverages exist
  const beforeDir = generate("soc_top", text, [
    "cmd_if.sv",
    "cmd_cov.svh",
    "rsp_if.sv",
    "rsp_cov.svh",
  ]);
  const before = listFiles(join(beforeDir, "tb")).map((f) => basename(f));
  assert.ok(before.some((f) => f.startsWith("rsp_")), "baza nu are artefacte rsp_*");

  // deleting the `rsp` agent (the gesture from the diagram), with cascade
  const afterAgent = ops.removeAgent(text, "rsp");
  const cfg = ops.parseQuvm(afterAgent);
  assert.deepEqual(cfg.agents.map((a) => a.name), ["cmd"]);
  assert.deepEqual(cfg.analysis.coverage, ["cmd"]); // rsp's coverage fell away
  assert.equal(cfg.analysis.scoreboards, undefined); // sbd had monitor=rsp
  assert.deepEqual(cfg.virtual_sequences.map((v) => v.name), ["smoke"]); // only cmd

  // the real generator ACCEPTS the remaining config (if a dead reference had
  // remained — sbd with monitor=rsp — Pydantic would have refused it), and the
  // deleted agent's artifacts disappear
  const afterDir = generate("soc_top", afterAgent, ["cmd_if.sv", "cmd_cov.svh"]);
  const orphans = listFiles(join(afterDir, "tb"))
    .map((f) => basename(f))
    .filter((f) => f.startsWith("rsp_"));
  assert.deepEqual(orphans, [], `artefacte rsp_* ramase: ${orphans.join(", ")}`);
  console.log("  ok    stergere: removeAgent(rsp) — cascada acceptata de generator, rsp_* disparute");

  // Deleting the LAST element from `analysis`: the block must stay EMPTY
  // (`analysis: {}`), so that QuickUVM stays in DECLARED mode. If we cleaned it,
  // it would fall into DEFAULT mode and REVIVE a scoreboard + a coverage
  // auto-wired to the primary agent — i.e. you delete something and get back
  // more (a real regression caught exactly here; see `keepAnalysis` in yamlops).
  const afterCov = ops.removeCoverage(afterAgent, "cmd");
  assert.deepEqual(ops.parseQuvm(afterCov).analysis, {}, "blocul analysis nu a ramas gol");
  const covDir = generate("soc_top", afterCov, ["cmd_if.sv"]);
  const envPath = listFiles(join(covDir, "tb")).find((f) =>
    basename(f).endsWith("_env.svh")
  );
  const env = readFileSync(envPath, "utf8");
  assert.ok(
    !/wired to primary agent/i.test(env),
    `QuickUVM a cazut in mod IMPLICIT si a reinviat default-urile:\n${env}`
  );
  assert.ok(
    !/\b\w+_cov\s+cov\b/.test(env),
    `colectorul de coverage sters a fost reinviat in env:\n${env}`
  );
  console.log("  ok    stergere: analysis golit ramane `{}` — fara reinvierea default-urilor");
}

// --- scenario 5: WHITEBOX PROBE (K2, slice 3) — the probe built by the
// extension's gesture (the path RELATIVE to the DUT instance, the width from the model) actually reaches
// the XMR in tb_top. Also checks the H1 constraint, which is the reason
// why `proposeProbe` refuses the gesture on a subsystem bench.
{
  const soc = {
    module: "soc_top",
    clock: "clk",
    reset: "rst_n",
    resetActiveLow: true,
    externalReset: false,
    combinational: false,
  };
  let text = ops.setDut(ops.newConfigText("soc_top"), soc);
  text = ops.createAgent(text, {
    name: "dp",
    inputs: [{ name: "din", width: 8 }],
    outputs: [{ name: "sum", width: 8 }],
  });
  text = ops.ignorePorts(text, ["ch_out", "inv"]);
  // probe on the INTERNAL adder's output: the path is relative to the DUT instance
  text = ops.addProbe(text, { name: "add_out", path: "u_add.dout", width: 8 });

  const dir = generate("soc_top", text, ["soc_top_probe_if.sv"]);
  const files = listFiles(join(dir, "tb"));
  const tb = readFileSync(
    files.find((f) => basename(f) === "tb_top.sv"),
    "utf8"
  );
  // the XMR: quick-uvm pastes the path VERBATIM after `dut_inst.`
  assert.ok(
    /assign\s+probe_if\.add_out\s*=\s*dut_inst\.u_add\.dout\s*;/.test(tb),
    `XMR-ul probei lipseste din tb_top:\n${tb}`
  );
  // without coverage: the probe monitor is NOT generated
  assert.ok(
    !files.some((f) => basename(f) === "soc_top_probe_monitor.svh"),
    "probe_monitor generat desi nicio proba nu cere coverage"
  );
  console.log("  ok    proba: XMR `probe_if.add_out = dut_inst.u_add.dout` in tb_top");

  // coverage: true on a probe => the probe monitor appears in env
  const withCov = ops.addProbe(text, {
    name: "busy",
    path: "u_inv.dout",
    width: 8,
    coverage: true,
  });
  const covDir = generate("soc_top", withCov, ["soc_top_probe_monitor.svh"]);
  assert.ok(
    listFiles(join(covDir, "tb")).some((f) => basename(f) === "soc_top_probe_if.sv"),
    "probe_if lipseste la proba cu coverage"
  );
  console.log("  ok    proba: coverage: true -> soc_top_probe_monitor.svh");

  // deleting the probe: its artifacts disappear, the rest is generated cleanly
  const noProbe = ops.removeProbe(text, "add_out");
  assert.equal(ops.parseQuvm(noProbe).probes, undefined);
  const delDir = generate("soc_top", noProbe, ["tb_top.sv"]);
  assert.ok(
    !listFiles(join(delDir, "tb")).some((f) => basename(f).startsWith("soc_top_probe")),
    "artefactele probei au ramas dupa removeProbe"
  );
  console.log("  ok    proba: removeProbe -> artefactele probei dispar");

  // H1 (the reason for proposeProbe's refusal): quick-uvm REFUSES probes+subenvs
  let h1 = ops.setDut(ops.newConfigText("soc_top"), soc);
  h1 = ops.addProbe(h1, { name: "x", path: "u_add.dout", width: 8 });
  h1 = ops.createSubenvs(h1, [
    { name: "u_add", config: "adder.quickuvm.yaml", params: {} },
  ]);
  const hd = mkdtempSync(join(tmpdir(), "quickuvm-e2e-h1-"));
  const hcfg = join(hd, "soc_top.quickuvm.yaml");
  writeFileSync(hcfg, h1);
  writeFileSync(
    join(hd, "adder.quickuvm.yaml"),
    ops.createAgent(
      ops.setDut(ops.newConfigText("adder"), {
        module: "adder",
        clock: null,
        reset: null,
        resetActiveLow: true,
        externalReset: false,
        combinational: true,
      }),
      { name: "a", inputs: [{ name: "din", width: 8 }], outputs: [{ name: "dout", width: 8 }] }
    )
  );
  const r = quickUvm(["generate", "-c", hcfg, "-o", join(hd, "tb")], hd);
  assert.notEqual(r.status, 0, "quick-uvm ar fi trebuit sa refuze probes + subenvs (H1)");
  assert.match(
    `${r.stdout ?? ""}${r.stderr ?? ""}`,
    /subsystem bench/i,
    "alt motiv de esec decat H1"
  );
  console.log("  ok    proba: H1 confirmat — probes + subenvs refuzat de generator");
}

// --- scenario 6: DERIVED COMPOSITION (slice 3) — the inter-block connections
// written by `addConnections` (equivalent of the derivation from the parent
// view's nets) reach the physical `assign` in tb_top. The DESTINATION block has
// a PASSIVE agent (quick-uvm constraint probed empirically: a `to` with an active agent
// would be refused).
{
  const producer = `project: {name: producer}
dut: {name: producer, clock: clk, reset: "", combinational: true}
agents:
  - name: prod_agent
    interface: prod_if
    sequence_item: prod_item
    ports:
      inputs: [{name: pin, width: 8}]
      outputs: [{name: dout, width: 8, randomize: false}]
`;
  const consumer = `project: {name: consumer}
dut: {name: consumer, clock: clk, reset: "", combinational: true}
agents:
  - name: cons_agent
    interface: cons_if
    sequence_item: cons_item
    active: false
    ports:
      inputs: [{name: din, width: 8}]
      outputs: [{name: cout, width: 8, randomize: false}]
`;
  // the top, built through the real MUTATIONS: setDut + createSubenvs + addConnections
  let top = ops.setDut(ops.newConfigText("sys_top"), {
    module: "sys_top", clock: "clk", reset: null,
    resetActiveLow: false, externalReset: false, combinational: true,
  });
  top = ops.createSubenvs(top, [
    { name: "p1", config: "producer.quickuvm.yaml", params: {} },
    { name: "c1", config: "consumer.quickuvm.yaml", params: {} },
  ]);
  top = ops.addConnections(top, [{ from: "p1.dout", to: "c1.din" }]);

  const dir = generate("sys_top", top, ["tb_top.sv"], {
    "producer.quickuvm.yaml": producer,
    "consumer.quickuvm.yaml": consumer,
  });
  const tb = readFileSync(
    listFiles(join(dir, "tb")).find((f) => basename(f) === "tb_top.sv"),
    "utf8"
  );
  // the physical inter-block wire: `assign <dst>_<if>_inst.din = <src>_<if>_inst.dout;`
  assert.ok(
    /assign\s+c1_\w*if\w*_inst\.din\s*=\s*p1_\w*if\w*_inst\.dout\s*;/.test(tb),
    `conexiunea inter-bloc lipseste din tb_top:\n${tb.split("\n").filter((l) => /assign|probe|connect/i.test(l)).join("\n")}`
  );
  console.log("  ok    compunere: connections -> `assign c1...din = p1...dout` in tb_top");

  // the passivity constraint: an ACTIVE destination agent is refused by
  // quick-uvm, and `setAgentActive(false)` (the flip from wireConnections)
  // repairs it — proof that the gesture produces a bench that actually generates.
  const consumerActive = `project: {name: consumer}
dut: {name: consumer, clock: clk, reset: "", combinational: true}
agents:
  - name: cons_agent
    interface: cons_if
    sequence_item: cons_item
    ports:
      inputs: [{name: din, width: 8}]
      outputs: [{name: cout, width: 8, randomize: false}]
`;
  const active = quickUvmComposed(top, producer, consumerActive);
  assert.notEqual(active.status, 0, "un agent-destinatie ACTIV ar fi trebuit refuzat");
  assert.match(active.out, /passive|active/i, "alt motiv de esec decat pasivitatea");
  // the flip: setAgentActive makes cons_agent passive -> generates cleanly
  const consumerFixed = ops.setAgentActive(consumerActive, "cons_agent", false);
  assert.equal(ops.parseQuvm(consumerFixed).agents[0].active, false);
  const fixed = quickUvmComposed(top, producer, consumerFixed);
  assert.equal(fixed.status, 0, `flip-ul la pasiv nu a reparat generarea:\n${fixed.out.slice(-400)}`);
  console.log("  ok    compunere: agent activ refuzat, setAgentActive(pasiv) repara generarea");

  // INVERTED LOCK (quick-uvm >= 1.0.0): the `subenvs` + own agents hybrid is
  // LEGAL — boundary agents (H2). The old test just did its job (it
  // caught the re-permitting), the "hybrid" diagnostic was removed from ConfigService;
  // now the lock guards the INVERSE meaning: if the generator re-forbade it,
  // the compose-with-agents-at-top gesture would die silently.
  const hybridTop = ops.createAgent(top, {
    name: "topcmd", inputs: [{ name: "z", width: 8 }], outputs: [],
  });
  const hyb = quickUvmComposed(hybridTop, producer, consumerFixed);
  assert.equal(hyb.status, 0,
    `hibridul (agenti de granita H2) ar trebui sa genereze curat:\n${hyb.out.slice(-400)}`);
  console.log("  ok    compunere: hibrid (subenvs + agenti de granita) ACCEPTAT de generator (1.0)");

  // deleting the connection: the wire disappears, the rest is generated cleanly
  const noConn = ops.removeConnection(top, "p1.dout", "c1.din");
  assert.equal(ops.parseQuvm(noConn).connections, undefined);
  const d2 = generate("sys_top", noConn, ["tb_top.sv"], {
    "producer.quickuvm.yaml": producer,
    "consumer.quickuvm.yaml": consumer,
  });
  const tb2 = readFileSync(
    listFiles(join(d2, "tb")).find((f) => basename(f) === "tb_top.sv"),
    "utf8"
  );
  assert.ok(!/assign\s+c1_\w*inst\.din/.test(tb2), "firul a ramas dupa removeConnection");
  console.log("  ok    compunere: removeConnection -> firul dispare din tb_top");
}

// --- scenario 5 (docs/07 P1): the AGENT INSPECTOR writes a config quick-uvm ACCEPTS.
// The inspector's enable/disable matrix and `setAgentField`'s cascades encode
// QuickUVM's responder coupling rules; unit tests prove the YAML shape, only the
// generator proves the rules were read right. Each step here is one inspector gesture.
{
  const base = () => {
    let t = ops.setDut(ops.newConfigText("rsp_dut"), {
      module: "rsp_dut", clock: "clk", reset: "rst_n",
      resetActiveLow: true, externalReset: false, combinational: false,
    });
    return ops.createAgent(t, {
      name: "rd",
      // inputs = what the agent DRIVES (the response), outputs = what it SAMPLES
      inputs: [{ name: "rvalid", width: 1 }, { name: "rdata", width: 32 }],
      outputs: [
        { name: "arvalid", width: 1 },
        { name: "arready", width: 1 },
        { name: "arid", width: 4 },
      ],
    });
  };

  // (a) initiator -> responder + request_valid + request_ready: accepted
  let t = base();
  t = ops.setAgentField(t, "rd", "mode", "responder");
  t = ops.setAgentField(t, "rd", "request_valid", "arvalid");
  t = ops.setAgentField(t, "rd", "request_ready", "arready");
  generate("rsp_on_request", t, ["rd_driver.svh", "tb_top.sv"]);

  // (b) ... -> pipelined + reorder_by + reorder_policy: accepted
  let pipe = ops.setAgentField(t, "rd", "respond", "pipelined");
  pipe = ops.setAgentField(pipe, "rd", "reorder_by", "arid");
  pipe = ops.setAgentField(pipe, "rd", "reorder_policy", "round_robin");
  generate("rsp_pipelined", pipe, ["rd_driver.svh"]);

  // (c) proactive hybrid on on_request: accepted
  const hybrid = ops.setAgentField(t, "rd", "proactive", true);
  generate("rsp_hybrid", hybrid, ["rd_driver.svh"]);

  // (d) THE CASCADE IS LOAD-BEARING. Going back to `mode: initiator` must drop every
  // responder-only key. Mutation proof: the SAME config with the keys left behind is
  // REFUSED by quick-uvm — so the cascade is what keeps the inspector honest.
  const backToInit = ops.setAgentField(pipe, "rd", "mode", "initiator");
  const cfgInit = ops.parseQuvm(backToInit).agents[0];
  for (const k of ["respond", "request_valid", "request_ready", "reorder_by", "reorder_policy"]) {
    assert.equal(k in cfgInit, false, `${k} a supravietuit cascadei`);
  }
  generate("rsp_back_to_initiator", backToInit, ["rd_driver.svh"]);

  const leftover = backToInit.replace(
    /(\n(\s+))interface: rd_if/,
    "$1interface: rd_if$1request_valid: arvalid"
  );
  assert.notEqual(leftover, backToInit, "mutatia nu s-a aplicat");
  const dir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-leftover-"));
  writeFileSync(join(dir, "m.quickuvm.yaml"), leftover);
  const bad = quickUvm(["generate", "-c", join(dir, "m.quickuvm.yaml"), "-o", join(dir, "tb")], dir);
  assert.notEqual(bad.status, 0, "quick-uvm ar fi trebuit sa refuze request_valid pe un initiator");
  assert.match(
    (bad.stdout ?? "") + (bad.stderr ?? ""),
    /request_valid.*only valid with/s,
    "alt motiv de esec decat cuplarea responder"
  );
  console.log("  ok    inspector agent: cascada mode->initiator e load-bearing (fara ea: REFUZ)");
}

// --- scenario 6 (docs/07 P2): the BENCH SETTINGS panel writes configs quick-uvm
// ACCEPTS. `register_model:` and `regress:` are presence-switched blocks, so the
// gestures here are add / edit-fields / remove, exactly as the panel emits them.
{
  const ral = `package cfg_ral_pkg;
  import uvm_pkg::*;
  \`include "uvm_macros.svh"
  class cfg_reg_block extends uvm_reg_block;
    \`uvm_object_utils(cfg_reg_block)
    function new(string name = "cfg_reg_block"); super.new(name, UVM_NO_COVERAGE); endfunction
    virtual function void build();
      default_map = create_map("default_map", 0, 4, UVM_LITTLE_ENDIAN);
      lock_model();
    endfunction
  endclass
endpackage
`;

  let t = ops.setDut(ops.newConfigText("cfg"), {
    module: "cfg", clock: "clk", reset: "rst_n",
    resetActiveLow: true, externalReset: false, combinational: false,
  });
  t = ops.createAgent(t, {
    name: "host",
    inputs: [{ name: "addr", width: 8 }, { name: "wdata", width: 32 }, { name: "wr", width: 1 }],
    outputs: [{ name: "rdata", width: 32 }],
  });

  // (a) add register model + the fields the panel edits (CSR suites, coverage, backdoor)
  let ralCfg = ops.addRegisterModel(t, {
    package: "cfg_ral_pkg", block: "cfg_reg_block", bus_agent: "host",
  });
  ralCfg = ops.setRegisterModelField(ralCfg, "csr_tests", ["hw_reset", "rw"]);
  ralCfg = ops.setRegisterModelField(ralCfg, "coverage", true);
  ralCfg = ops.setRegisterModelField(ralCfg, "backdoor_root", "tb_top.dut_inst");
  generate("ral_bench", ralCfg, ["reg_adapter.svh", "cfg_reg_test.svh", "tb_top.sv"],
    { "cfg_ral_pkg.sv": ral });

  // (b) removing it leaves a config that still generates (without the RAL files)
  const noRal = ops.removeRegisterModel(ralCfg);
  const dirNoRal = generate("ral_removed", noRal, ["tb_top.sv"]);
  assert.ok(
    !existsSync(join(dirNoRal, "tb", "reg_adapter.svh")),
    "adaptorul a supravietuit stergerii lui register_model"
  );

  // (c) regress: presence generates the Makefile
  let rg = ops.addRegress(t);
  rg = ops.setRegressField(rg, "seeds", 4);
  generate("regress_bench", rg, ["Makefile", "tb_top.sv"]);

  // (d) THE SEEDS CASCADE IS LOAD-BEARING. QuickUVM refuses `tests[].seeds` without a
  // `regress:` block, so removing the block must strip them. Mutation proof: the same
  // config with the seeds left behind is REFUSED.
  const seeded = rg.replace(/(\n\s+)- \{ name: (\w+) \}/, "$1- { name: $2, seeds: 4 }");
  assert.notEqual(seeded, rg, "fixture-ul cu tests[].seeds nu s-a aplicat");
  generate("regress_seeded", seeded, ["Makefile"]);

  const cleaned = ops.removeRegress(seeded);
  assert.equal("seeds" in ops.parseQuvm(cleaned).tests[0], false, "seeds a supravietuit cascadei");
  generate("regress_removed", cleaned, ["tb_top.sv"]);

  const orphan = seeded.replace(/\nregress:[^\n]*\n/, "\n");
  assert.notEqual(orphan, seeded, "mutatia (regress sters, seeds ramas) nu s-a aplicat");
  const dir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-orphan-"));
  writeFileSync(join(dir, "m.quickuvm.yaml"), orphan);
  const bad = quickUvm(["generate", "-c", join(dir, "m.quickuvm.yaml"), "-o", join(dir, "tb")], dir);
  assert.notEqual(bad.status, 0, "quick-uvm ar fi trebuit sa refuze seeds fara regress");
  assert.match(
    (bad.stdout ?? "") + (bad.stderr ?? ""),
    /seeds.*regress/s,
    "alt motiv de esec decat seeds-fara-regress"
  );
  console.log("  ok    setari bench: cascada removeRegress -> seeds e load-bearing (fara ea: REFUZ)");
}

console.log("fluxul end-to-end (yamlops -> quick-uvm generate) e verde");
