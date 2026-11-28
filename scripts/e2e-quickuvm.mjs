// End-to-end validation of the phase 2 flow (the criterion from docs/06): from a
// DUT in examples/ to a generated QuickUVM testbench, exclusively through the mutations
// that the extension's actions would produce (yamlops) — no hand-written YAML.
// Requires quick-uvm installed (or importable via python): npm run test:e2e
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
await esbuild.build({
  entryPoints: ["src/benchid.ts"],
  outfile: join(outDir, "benchid.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const guards = await import(pathToFileURL(join(outDir, "benchid.mjs")));

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

// ---------------------------------------------------------------------------
// THE ELABORATION LINT (Nov 2026). `quick-uvm generate` exiting 0 proves the
// config VALIDATES, not that the bench elaborates: the tutorial bench itself was
// generated cleanly for months with `.rst_n(cmd_if_inst.rst_n)` in tb_top and no
// `rst_n` in `cmd_if` (xmelab *E,CUVUNF on the first real compile). This script
// cannot run a simulator, so it checks the generated TEXT: every signal the top
// connects to a DUT port must be declared — in the top itself (a bare net) or in
// the interface it is taken from (`<inst>.<signal>`). `generate()` runs it on
// every bench of every scenario.

const stripComments = (sv) =>
  sv.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/** the index just past the `)` that closes the `(` at `open`, or -1 */
function closeParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") {
      depth += 1;
    } else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

/** removes every `#( ... )` group (parameter assignments, balanced): a DUT's
 *  `#(.W(WIDTH))` is not a port connection, `clkgen #(10) ck (clk)` is an instance */
function stripParamLists(text) {
  let out = "";
  let i = 0;
  for (;;) {
    const m = /#\s*\(/.exec(text.slice(i));
    if (!m) {
      return out + text.slice(i);
    }
    const open = i + m.index + m[0].length - 1;
    const close = closeParen(text, open);
    if (close < 0) {
      return out + text.slice(i);
    }
    out += text.slice(i, i + m.index) + " ";
    i = close;
  }
}

/** the DECLARATIONS of an interface / of the top: comments, clocking blocks and
 *  modports removed (they REFERENCE signals), and the `[...]` ranges with them
 *  (a name inside a dimension is a use, not a declaration) */
function declText(sv) {
  return stripComments(sv)
    .replace(/\bclocking\b[\s\S]*?\bendclocking\b/g, " ")
    .replace(/\bmodport\b[^;]*;/g, " ")
    .replace(/\[[^\]]*\]/g, " ");
}

const NOT_A_TYPE =
  "begin|end|else|assign|if|initial|final|always\\w*|return|posedge|negedge|repeat|wait|forever|fork|join\\w*|module|interface|import|typedef|parameter|localparam";

function declares(sv, sig) {
  const s = sig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = declText(sv);
  return (
    // `logic a, sig;`  /  `interface x (input clk, input sig);` — up to the end of
    // the declaration, and never into an initialiser (`logic a = sig;` USES sig)
    new RegExp(
      `\\b(?:input|output|inout|logic|wire|bit|reg|var|tri\\w*)\\b[^;)=]*\\b${s}\\b`
    ).test(text) ||
    // a user-typed signal, `my_struct_t sig;` — type and name on ONE line, and the
    // "type" is not a keyword (`begin` + newline + `sig = ...;` is an assignment)
    new RegExp(
      `(?:^|[;\\n])[ \\t]*(?!(?:${NOT_A_TYPE})\\b)[A-Za-z_]\\w*(?:::\\w+)?[ \\t]+${s}\\b[ \\t]*[;,]`
    ).test(text)
  );
}

/**
 * Returns the problems of a generated bench (empty = clean), the DUT port
 * connections it found as `{port, expr}`, and the top files. `extraRoots`: more
 * directories to look for interface files in (a bench that consumes a VIP by
 * reference instantiates interfaces generated elsewhere).
 */
function lintDutConnections(tbDir, extraRoots = []) {
  const files = listFiles(tbDir);
  const elsewhere = extraRoots.flatMap((d) => listFiles(d));
  const problems = [];
  const connections = [];
  const tops = files.filter(
    (f) => /\.sv$/.test(f) && /pragma quickuvm custom dut_connections begin/.test(readFileSync(f, "utf8"))
  );
  for (const topFile of tops) {
    const raw = readFileSync(topFile, "utf8");
    const top = stripComments(raw);
    // `<type> <inst> (` — the instances of the top, by name (parameter lists gone)
    const typeOf = new Map();
    for (const m of stripParamLists(top).matchAll(/^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(/gm)) {
      typeOf.set(m[2], m[1]);
    }
    const blocks = raw.matchAll(
      /pragma quickuvm custom dut_connections begin([\s\S]*?)\/\/ pragma quickuvm custom dut_connections end/g
    );
    for (const b of blocks) {
      const body = stripParamLists(stripComments(b[1]));
      for (const c of body.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)) {
        const open = c.index + c[0].length - 1;
        const close = closeParen(body, open);
        if (close < 0) {
          problems.push(`${basename(topFile)}: .${c[1]}( — unbalanced parentheses`);
          continue;
        }
        const port = c[1];
        const expr = body.slice(open + 1, close - 1).trim();
        connections.push({ port, expr });
        // sized literals (`8'hFF`, `'0`) are not names
        const names = expr
          .replace(/\d*'[sS]?[bBdDhHoO]?[0-9a-fA-F_xXzZ?]+/g, " ")
          .match(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g);
        for (const ref of names ?? []) {
          const [head, ...rest] = ref.split(".");
          if (!rest.length) {
            if (!declares(top, head)) {
              problems.push(`${basename(topFile)}: .${port}(${expr}) — net \`${head}\` is not declared in the top`);
            }
            continue;
          }
          const type = typeOf.get(head);
          if (!type) {
            problems.push(`${basename(topFile)}: .${port}(${expr}) — \`${head}\` is not an instance of the top`);
            continue;
          }
          const ifFile =
            files.find((f) => basename(f) === `${type}.sv`) ??
            elsewhere.find((f) => basename(f) === `${type}.sv`);
          if (!ifFile) {
            problems.push(`${basename(topFile)}: .${port}(${expr}) — no ${type}.sv found for \`${head}\``);
            continue;
          }
          if (!declares(readFileSync(ifFile, "utf8"), rest[0])) {
            problems.push(
              `${basename(topFile)}: .${port}(${expr}) — ${type}.sv declares no signal \`${rest[0]}\``
            );
          }
        }
      }
    }
  }
  return { problems, connections, tops };
}

// THE LINT IS TESTED TOO (the adversarial review found five holes in its first
// cut, each on a synthetic top — they are the cases below). A lint that passes
// everything is worse than none: it is what "green" would have meant.
{
  const lintOf = (topBody, ifBody, extra = {}) => {
    const d = mkdtempSync(join(tmpdir(), "quickuvm-e2e-lint-"));
    writeFileSync(
      join(d, "tb_top.sv"),
      `module tb_top;\n  logic clk;\n${topBody.pre ?? ""}\n  a_if a_if_inst (clk);\n` +
        `  // pragma quickuvm custom dut_connections begin\n${topBody.dut}\n` +
        `  // pragma quickuvm custom dut_connections end\nendmodule\n`
    );
    if (ifBody !== null) {
      writeFileSync(join(d, "a_if.sv"), `interface a_if (input clk);\n${ifBody}\nendinterface\n`);
    }
    for (const [f, t] of Object.entries(extra)) {
      writeFileSync(join(d, f), t);
    }
    return lintDutConnections(d).problems;
  };
  const IF = "  logic [7:0] din;\n  clocking cb1 @(posedge clk);\n    output din;\n    input rst_n;\n  endclocking";
  // clean: a parameterised DUT is not a list of port connections
  assert.deepEqual(
    lintOf({ dut: "  demo #(.W(WIDTH), .D(4)) dut_inst (\n    .din(a_if_inst.din),\n    .clk(clk)  );" }, IF),
    []
  );
  // a name the clocking block merely REFERENCES is not declared
  assert.equal(lintOf({ dut: "  demo dut_inst (.rst_n(a_if_inst.rst_n));" }, IF).length, 1);
  // ... also inside a parenthesised / concatenated expression
  assert.equal(lintOf({ dut: "  demo dut_inst (.rst_n(~(a_if_inst.rst_n)), .din({a_if_inst.din, 1'b0}));" }, IF).length, 1);
  // an ASSIGNMENT after `begin` is not a declaration of the net
  assert.equal(
    lintOf({ pre: "  initial begin\n    rst_n = 1'b0;\n  end", dut: "  demo dut_inst (.rst_n(rst_n));" }, IF).length,
    1
  );
  // a name in another declaration's INITIALISER or DIMENSION is not declared
  assert.equal(lintOf({ pre: "  logic other = rst_n;", dut: "  demo dut_inst (.rst_n(rst_n));" }, IF).length, 1);
  assert.equal(lintOf({ dut: "  demo dut_inst (.x(a_if_inst.W));" }, "  logic [W-1:0] din;").length, 1);
  // declared for real: a net of the top, an interface port, a user-typed signal
  assert.deepEqual(
    lintOf(
      { pre: "  logic rst_n;", dut: "  demo dut_inst (.rst_n(rst_n), .p(a_if_inst.pkt), .q(a_if_inst.r2));" },
      "  pkt_t pkt;\n  wire r1, r2;"
    ),
    []
  );
  // an instance of the top that is no interface we can read is a problem, not a pass
  assert.equal(lintOf({ dut: "  demo dut_inst (.x(ghost_inst.x), .y(a_if_inst.din));" }, IF).length, 1);
  assert.equal(lintOf({ dut: "  demo dut_inst (.y(a_if_inst.din));" }, null).length, 1);
  console.log("  ok    lint: the elaboration lint catches its own review cases");
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
    throw new Error(`quick-uvm generate failed for ${name} (${r.status})`);
  }
  for (const f of expectFiles) {
    assert.ok(existsSync(join(dir, "tb", f)), `${f} is missing (in ${dir})`);
  }
  // exit 0 is not enough — see lintDutConnections (interfaces generated outside
  // `tb/`, e.g. a VIP copied next to the config, are looked up in the scenario dir)
  const lint = lintDutConnections(join(dir, "tb"), [dir]);
  assert.deepEqual(
    lint.problems,
    [],
    `${name}: the generated top connects the DUT to signals that do not exist (in ${dir})`
  );
  console.log(`  ok    ${name}: testbench generated (${expectFiles.length}+ files) in ${dir}`);
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
    combinational: true,
  });
  const clocked = (m) => ({
    module: m,
    clock: "clk",
    reset: "rst_n",
    resetActiveLow: true,
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
    combinational: false,
  });
  top = ops.createSubenvs(top, [
    { name: "u_add", config: "adder.quickuvm.yaml", params: {} },
    { name: "u_inv", config: "inverter.quickuvm.yaml", params: {} },
    { name: "u_ch", config: "chan.quickuvm.yaml", params: {} },
  ]);
  const compDir = generate(
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
  // THE CLOCKED LEAF'S RESET IS CONNECTED. In a composition the old shape failed
  // differently, and more quietly: a leaf whose reset was not `external` got NO
  // reset connection at all in the subsystem top (the port left floating — no
  // elaboration error, a DUT that is never reset). With the reset setDut writes
  // now, the top declares a per-leaf net, drives it and connects it.
  const comp = lintDutConnections(join(compDir, "tb"));
  const chanRst = comp.connections.filter((c) => c.port === "rst_n");
  assert.deepEqual(chanRst.map((c) => c.expr), ["u_ch_rst_n"],
    "the clocked leaf's reset port is not connected in the subsystem top");
  assert.match(readFileSync(comp.tops[0], "utf8"), /u_ch_rst_n = 1'b1;\s*\/\/ deassert/);
  console.log("  ok    composition: the clocked leaf's reset is declared, driven and connected in tb_top");
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
  assert.ok(before.some((f) => f.startsWith("rsp_")), "the baseline has no rsp_* artifacts");

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
  assert.deepEqual(orphans, [], `rsp_* artifacts left behind: ${orphans.join(", ")}`);
  console.log("  ok    deletion: removeAgent(rsp) — the cascade is accepted by the generator, rsp_* are gone");

  // Deleting the LAST element from `analysis`: the block must stay EMPTY
  // (`analysis: {}`), so that QuickUVM stays in DECLARED mode. If we cleaned it,
  // it would fall into DEFAULT mode and REVIVE a scoreboard + a coverage
  // auto-wired to the primary agent — i.e. you delete something and get back
  // more (a real regression caught exactly here; see `keepAnalysis` in yamlops).
  const afterCov = ops.removeCoverage(afterAgent, "cmd");
  assert.deepEqual(ops.parseQuvm(afterCov).analysis, {}, "the analysis block did not stay empty");
  const covDir = generate("soc_top", afterCov, ["cmd_if.sv"]);
  const envPath = listFiles(join(covDir, "tb")).find((f) =>
    basename(f).endsWith("_env.svh")
  );
  const env = readFileSync(envPath, "utf8");
  assert.ok(
    !/wired to primary agent/i.test(env),
    `QuickUVM fell into IMPLICIT mode and revived the defaults:\n${env}`
  );
  assert.ok(
    !/\b\w+_cov\s+cov\b/.test(env),
    `the deleted coverage collector was revived in the env:\n${env}`
  );
  console.log("  ok    deletion: an emptied analysis stays `{}` — the defaults are not revived");
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
    `the probe's XMR is missing from tb_top:\n${tb}`
  );
  // without coverage: the probe monitor is NOT generated
  assert.ok(
    !files.some((f) => basename(f) === "soc_top_probe_monitor.svh"),
    "probe_monitor was generated although no probe asks for coverage"
  );
  console.log("  ok    probe: XMR `probe_if.add_out = dut_inst.u_add.dout` in tb_top");

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
    "probe_if is missing for the probe with coverage"
  );
  console.log("  ok    probe: coverage: true -> soc_top_probe_monitor.svh");

  // deleting the probe: its artifacts disappear, the rest is generated cleanly
  const noProbe = ops.removeProbe(text, "add_out");
  assert.equal(ops.parseQuvm(noProbe).probes, undefined);
  const delDir = generate("soc_top", noProbe, ["tb_top.sv"]);
  assert.ok(
    !listFiles(join(delDir, "tb")).some((f) => basename(f).startsWith("soc_top_probe")),
    "the probe's artifacts were left behind after removeProbe"
  );
  console.log("  ok    probe: removeProbe -> the probe's artifacts disappear");

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
        combinational: true,
      }),
      { name: "a", inputs: [{ name: "din", width: 8 }], outputs: [{ name: "dout", width: 8 }] }
    )
  );
  const r = quickUvm(["generate", "-c", hcfg, "-o", join(hd, "tb")], hd);
  assert.notEqual(r.status, 0, "quick-uvm should have refused probes + subenvs (H1)");
  assert.match(
    `${r.stdout ?? ""}${r.stderr ?? ""}`,
    /subsystem bench/i,
    "it failed for a reason other than H1"
  );
  console.log("  ok    probe: H1 confirmed — probes + subenvs is refused by the generator");
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
    resetActiveLow: false, combinational: true,
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
    `the inter-block connection is missing from tb_top:\n${tb.split("\n").filter((l) => /assign|probe|connect/i.test(l)).join("\n")}`
  );
  console.log("  ok    composition: connections -> `assign c1...din = p1...dout` in tb_top");

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
  assert.notEqual(active.status, 0, "an ACTIVE destination agent should have been refused");
  assert.match(active.out, /passive|active/i, "it failed for a reason other than passivity");
  // the flip: setAgentActive makes cons_agent passive -> generates cleanly
  const consumerFixed = ops.setAgentActive(consumerActive, "cons_agent", false);
  assert.equal(ops.parseQuvm(consumerFixed).agents[0].active, false);
  const fixed = quickUvmComposed(top, producer, consumerFixed);
  assert.equal(fixed.status, 0, `the flip to passive did not repair the generation:\n${fixed.out.slice(-400)}`);
  console.log("  ok    composition: an active agent is refused, setAgentActive(passive) repairs the generation");

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
    `the hybrid (boundary agents, H2) should generate cleanly:\n${hyb.out.slice(-400)}`);
  console.log("  ok    composition: the hybrid (subenvs + boundary agents) is ACCEPTED by the generator (1.0)");

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
  assert.ok(!/assign\s+c1_\w*inst\.din/.test(tb2), "the wire was left behind after removeConnection");
  console.log("  ok    composition: removeConnection -> the wire disappears from tb_top");
}

// --- scenario 5 (docs/07 P1): the AGENT INSPECTOR writes a config quick-uvm ACCEPTS.
// The inspector's enable/disable matrix and `setAgentField`'s cascades encode
// QuickUVM's responder coupling rules; unit tests prove the YAML shape, only the
// generator proves the rules were read right. Each step here is one inspector gesture.
{
  const base = () => {
    let t = ops.setDut(ops.newConfigText("rsp_dut"), {
      module: "rsp_dut", clock: "clk", reset: "rst_n",
      resetActiveLow: true, combinational: false,
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
    assert.equal(k in cfgInit, false, `${k} survived the cascade`);
  }
  generate("rsp_back_to_initiator", backToInit, ["rd_driver.svh"]);

  const leftover = backToInit.replace(
    /(\n(\s+))interface: rd_if/,
    "$1interface: rd_if$1request_valid: arvalid"
  );
  assert.notEqual(leftover, backToInit, "the mutation did not apply");
  const dir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-leftover-"));
  writeFileSync(join(dir, "m.quickuvm.yaml"), leftover);
  const bad = quickUvm(["generate", "-c", join(dir, "m.quickuvm.yaml"), "-o", join(dir, "tb")], dir);
  assert.notEqual(bad.status, 0, "quick-uvm should have refused request_valid on an initiator");
  assert.match(
    (bad.stdout ?? "") + (bad.stderr ?? ""),
    /request_valid.*only valid with/s,
    "it failed for a reason other than the responder coupling"
  );
  console.log("  ok    agent inspector: the mode->initiator cascade is load-bearing (without it: REFUSED)");
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
    resetActiveLow: true, combinational: false,
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
    "the adapter survived the removal of register_model"
  );

  // (c) regress: presence generates the Makefile
  let rg = ops.addRegress(t);
  rg = ops.setRegressField(rg, "seeds", 4);
  generate("regress_bench", rg, ["Makefile", "tb_top.sv"]);

  // (d) THE SEEDS CASCADE IS LOAD-BEARING. QuickUVM refuses `tests[].seeds` without a
  // `regress:` block, so removing the block must strip them. Mutation proof: the same
  // config with the seeds left behind is REFUSED.
  const seeded = rg.replace(/(\n\s+)- \{ name: (\w+) \}/, "$1- { name: $2, seeds: 4 }");
  assert.notEqual(seeded, rg, "the fixture with tests[].seeds did not apply");
  generate("regress_seeded", seeded, ["Makefile"]);

  const cleaned = ops.removeRegress(seeded);
  assert.equal("seeds" in ops.parseQuvm(cleaned).tests[0], false, "seeds survived the cascade");
  generate("regress_removed", cleaned, ["tb_top.sv"]);

  const orphan = seeded.replace(/\nregress:[^\n]*\n/, "\n");
  assert.notEqual(orphan, seeded, "the mutation (regress removed, seeds left behind) did not apply");
  const dir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-orphan-"));
  writeFileSync(join(dir, "m.quickuvm.yaml"), orphan);
  const bad = quickUvm(["generate", "-c", join(dir, "m.quickuvm.yaml"), "-o", join(dir, "tb")], dir);
  assert.notEqual(bad.status, 0, "quick-uvm should have refused seeds without regress");
  assert.match(
    (bad.stdout ?? "") + (bad.stderr ?? ""),
    /seeds.*regress/s,
    "it failed for a reason other than seeds-without-regress"
  );
  console.log("  ok    bench settings: the removeRegress -> seeds cascade is load-bearing (without it: REFUSED)");
}

// --- scenario 7 (docs/07 P2b): the TESTS editor + BENCH IDENTITY form. The two
// interesting claims are empirical, so they are checked against the generator:
// `tests: []` is ACCEPTED but yields a bench with nothing to run, and the guarded
// layout/kind switches match what quick-uvm actually refuses.
{
  let t = ops.setDut(ops.newConfigText("bid"), {
    module: "bid", clock: "clk", reset: "rst_n",
    resetActiveLow: true, combinational: false,
  });
  t = ops.createAgent(t, {
    name: "a", inputs: [{ name: "din", width: 8 }], outputs: [{ name: "dout", width: 8 }],
  });

  // (a) add + edit tests
  let many = ops.addTest(t, "smoke_test");
  many = ops.setTestField(many, "smoke_test", "num_items", 5);
  const dirMany = generate("tests_many", many, ["smoke_test.svh", "tb_top.sv"]);
  assert.ok(existsSync(join(dirMany, "tb", "bid_base_test.svh")));

  // (b) removing the LAST test drops the `tests:` key -> the bench falls back to the
  // runnable default test1. The alternative (`tests: []`) is ACCEPTED by quick-uvm but
  // generates only the base test — a bench with nothing to run. Both are generated
  // here, and the difference is asserted: it is why removeTest deletes the key.
  let last = many;
  for (const name of ops.parseQuvm(many).tests.map((x) => x.name)) {
    last = ops.removeTest(last, name);
  }
  assert.equal(ops.parseQuvm(last).tests, undefined, "the tests key should have been deleted");
  const dirDefault = generate("tests_key_removed", last, ["bid_base_test.svh"]);
  const testFiles = (dir) =>
    listFiles(join(dir, "tb"))
      .map((f) => basename(f))
      .filter((f) => f.endsWith(".svh") && /test/.test(f) && !/_base_test\.svh$/.test(f));
  const defaultTests = testFiles(dirDefault);
  assert.ok(defaultTests.length > 0, "the absence of tests: should have given test1");

  const emptyList = last.replace(/\n(dut:)/, "\ntests: []\n$1");
  assert.notEqual(emptyList, last, "the `tests: []` fixture did not apply");
  const dirEmpty = generate("tests_empty_list", emptyList, ["bid_base_test.svh"]);
  const emptyTests = testFiles(dirEmpty);
  assert.equal(emptyTests.length, 0,
    `\`tests: []\` should give ZERO runnable tests, it has: ${emptyTests}`);
  console.log("  ok    tests[]: absence => the default test1, `tests: []` => a bench with no runnable test");

  // (c) bench identity: top_name + packaged layout generate cleanly
  let ident = ops.setBenchField(t, "top_name", "my_top");
  ident = ops.setBenchField(ident, "auto_virtual_sequences", false);
  generate("bench_identity", ident, ["my_top.sv"]);

  // (d) THE GUARDS MATCH THE GENERATOR — checked in BOTH directions. `kindBlockers`
  // is what the panel uses to disable an option; if it disagreed with quick-uvm the
  // panel would either block a legal switch or wave through a config that fails.
  const tryGenerate = (yamlText) => {
    const dir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-guard-"));
    writeFileSync(join(dir, "m.quickuvm.yaml"), yamlText);
    const r = quickUvm(["generate", "-c", join(dir, "m.quickuvm.yaml"), "-o", join(dir, "tb")], dir);
    return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };

  // flat + vip: blocked by the guard AND refused by the generator, same reason
  const flatVip = ops.setBenchField(t, "kind", "vip");
  const flatWhy = guards.kindBlockers(ops.parseQuvm(flatVip), "vip");
  assert.ok(flatWhy.length, "kindBlockers should have blocked vip on the flat layout");
  const flatRun = tryGenerate(flatVip);
  assert.equal(flatRun.ok, false);
  assert.match(flatRun.out, /kind: vip.*layout: packaged/s);

  // packaged, but a DECLARED test list: still blocked — a vip drops bench-layer
  // sections, and the generator names exactly the same one
  const pkgVip = ops.setBenchField(flatVip, "layout", "packaged");
  const pkgWhy = guards.kindBlockers(ops.parseQuvm(pkgVip), "vip");
  assert.ok(pkgWhy.some((w) => w.includes("tests")), `the guard did not name tests: ${pkgWhy}`);
  const pkgRun = tryGenerate(pkgVip);
  assert.equal(pkgRun.ok, false);
  assert.match(pkgRun.out, /would be silently dropped.*tests/s);

  // drop the declared test and it becomes a legal VIP: the guard clears AND it builds
  let cleanVip = pkgVip;
  for (const name of ops.parseQuvm(pkgVip).tests.map((x) => x.name)) {
    cleanVip = ops.removeTest(cleanVip, name);
  }
  assert.deepEqual(guards.kindBlockers(ops.parseQuvm(cleanVip), "vip"), []);
  generate("bench_vip", cleanVip, ["a_agent.svh"]);

  // the layout guard, same agreement: subenvs pin it to packaged
  assert.deepEqual(guards.layoutBlockers(ops.parseQuvm(t), "flat"), []);
  assert.ok(guards.layoutBlockers(ops.parseQuvm(cleanVip), "flat").length,
    "layoutBlockers should have blocked flat under kind: vip");
  console.log("  ok    bench identity: the kind/layout guard matches the real refusal");
}

// --- scenario 8 (docs/07 P3a): scoreboard DEPTH — the windowed N:1 check and the
// predictor language, both nested mappings the inspector now edits.
{
  let t = ops.setDut(ops.newConfigText("win"), {
    module: "win", clock: "clk", reset: "rst_n",
    resetActiveLow: true, combinational: false,
  });
  t = ops.createAgent(t, {
    name: "es",
    inputs: [{ name: "din", width: 8 }],
    outputs: [{ name: "sample", width: 8 }, { name: "done", width: 1 }],
  });
  t = ops.addScoreboard(t, { name: "sbd", source: "es" });

  // (a) window: boundary + length, single-stream
  let win = ops.setScoreboardField(t, "sbd", "window.boundary", "done");
  win = ops.setScoreboardField(win, "sbd", "window.length", 64);
  generate("sb_window", win, ["win_scoreboard.svh", "tb_top.sv"]);

  // (b) predictor language: `c` also emits the DPI-C bridge + stub
  const cModel = ops.setScoreboardField(t, "sbd", "reference_model.language", "c");
  const dirC = generate("sb_ref_c", cModel, ["win_reference_model.c"]);
  assert.ok(
    listFiles(join(dirC, "tb")).some((f) => basename(f).endsWith(".c")),
    "the `c` language should have emitted a .c stub"
  );

  // (c) THE SINGLE-STREAM COUPLING IS LOAD-BEARING. Adding a monitor drops the window
  // (the op cascades); the same config with the window left behind is REFUSED.
  const withObs = ops.createAgent(win, {
    name: "obs", inputs: [], outputs: [{ name: "dout", width: 8 }],
  });
  const twoStream = ops.setScoreboardField(withObs, "sbd", "monitor", "obs");
  assert.equal("window" in ops.parseQuvm(twoStream).analysis.scoreboards[0], false,
    "window survived the addition of the monitor");
  generate("sb_two_stream", twoStream, ["win_scoreboard.svh"]);

  const leftover = twoStream.replace(
    /(\n\s+)- \{ ?name: sbd/,
    "$1- { window: { boundary: done, length: 64 }, name: sbd"
  );
  assert.notEqual(leftover, twoStream, "the mutation (window + monitor) did not apply");
  const dir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-window-"));
  writeFileSync(join(dir, "m.quickuvm.yaml"), leftover);
  const bad = quickUvm(["generate", "-c", join(dir, "m.quickuvm.yaml"), "-o", join(dir, "tb")], dir);
  assert.notEqual(bad.status, 0, "quick-uvm should have refused window + monitor");
  assert.match(
    (bad.stdout ?? "") + (bad.stderr ?? ""),
    /window requires a SINGLE-stream/s,
    "it failed for a reason other than window-on-two-streams"
  );
  console.log("  ok    scoreboard: the window<->monitor cascade is load-bearing (without it: REFUSED)");
}

// --- scenario 9 (docs/07 P3b): RICH functional coverage. The editor upgrades a bare
// `coverage: [cmd]` routing entry into a covergroup model; every gesture below is
// one of its actions, and the generated covergroup is inspected (not just exit 0).
{
  let t = ops.setDut(ops.newConfigText("cov"), {
    module: "cov", clock: "clk", reset: "rst_n",
    resetActiveLow: true, combinational: false,
  });
  t = ops.createAgent(t, {
    name: "cmd",
    inputs: [{ name: "din", width: 8 }, { name: "wr", width: 1 }],
    outputs: [{ name: "dout", width: 8 }],
  });
  t = ops.addCoverage(t, "cmd");

  // bare entry: routing only, no covergroup content
  const dirBare = generate("cov_bare", t, ["cmd_cov.svh"]);
  const bareCov = readFileSync(
    listFiles(join(dirBare, "tb")).find((f) => basename(f) === "cmd_cov.svh"), "utf8"
  );
  assert.ok(!/low\b/.test(bareCov), "the bare entry should have no named bins");

  // upgrade + author: coverpoints, bins in all three forms, a cross, a goal
  let rich = ops.upgradeCoverage(t, "cmd", "din");
  rich = ops.addCoverpoint(rich, "cmd", "wr");
  rich = ops.setCoverageBin(rich, "cmd", "din", "low", { range: [0, 7] });
  rich = ops.setCoverageBin(rich, "cmd", "din", "max", { value: 255 });
  rich = ops.setCoverageBin(rich, "cmd", "wr", "both", { values: [0, 1] });
  rich = ops.addCross(rich, "cmd", ["din", "wr"]);
  rich = ops.setCoverageGoal(rich, "cmd", 90);
  const dirRich = generate("cov_rich", rich, ["cmd_cov.svh"]);
  const richCov = readFileSync(
    listFiles(join(dirRich, "tb")).find((f) => basename(f) === "cmd_cov.svh"), "utf8"
  );
  // the authored content really reaches the covergroup
  for (const needle of ["low", "max", "both", "[0:7]", "255", "cross", "goal"]) {
    assert.ok(richCov.includes(needle), `the covergroup does not contain "${needle}":\n${richCov}`);
  }
  console.log("  ok    rich coverage: bins/cross/goal reach the generated covergroup");

  // THE PRUNING CASCADE IS LOAD-BEARING. Removing a coverpoint must remove the
  // crosses over it — QuickUVM refuses a cross naming an undeclared coverpoint.
  const pruned = ops.removeCoverpoint(rich, "cmd", "wr");
  assert.equal("crosses" in ops.parseQuvm(pruned).analysis.coverage[0], false);
  generate("cov_pruned", pruned, ["cmd_cov.svh"]);

  // the mutation uses the real op, which does NOT validate: a cross over `wr`, which
  // is no longer a declared coverpoint — precisely what the cascade prevents
  const orphanCross = ops.addCross(pruned, "cmd", ["din", "wr"]);
  assert.notEqual(orphanCross, pruned, "the mutation (orphan cross) did not apply");
  const dir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-cross-"));
  writeFileSync(join(dir, "m.quickuvm.yaml"), orphanCross);
  const bad = quickUvm(["generate", "-c", join(dir, "m.quickuvm.yaml"), "-o", join(dir, "tb")], dir);
  assert.notEqual(bad.status, 0, "quick-uvm should have refused a cross to an undeclared field");
  assert.match(
    (bad.stdout ?? "") + (bad.stderr ?? ""),
    /cross references.*not a declared coverpoint/s,
    "it failed for a reason other than the orphan cross"
  );
  console.log("  ok    rich coverage: the coverpoint->cross cascade is load-bearing (without it: REFUSED)");

  // downgrade: back to routing only, and the bench still generates
  const bare = ops.downgradeCoverage(rich, "cmd");
  assert.deepEqual(ops.parseQuvm(bare).analysis.coverage, ["cmd"]);
  generate("cov_downgraded", bare, ["cmd_cov.svh"]);
}

// --- scenario 10 (docs/07 P4): MULTI-CLOCK domains. The editor converts the single
// `clock:` mapping into a domain list and assigns an agent to a second domain; the
// generator is the judge of whether the list mode really wired up.
{
  let t = ops.setDut(ops.newConfigText("mc"), {
    module: "mc", clock: "clk", reset: "rst_n",
    resetActiveLow: true, combinational: false,
  });
  t = ops.createAgent(t, {
    name: "core", inputs: [{ name: "din", width: 8 }], outputs: [{ name: "dout", width: 8 }],
  });
  t = ops.createAgent(t, {
    name: "spi", inputs: [{ name: "mosi", width: 1 }], outputs: [{ name: "miso", width: 1 }],
  });

  // add a second domain (mapping -> list) sourced by the DUT (SPI sck), assign the
  // spi agent to it
  let mc = ops.addClockDomain(t, "sck");
  mc = ops.setClockDomainField(mc, "sck", "period", 40);
  mc = ops.setClockDomainField(mc, "sck", "source", "dut");
  mc = ops.setAgentField(mc, "spi", "clock", "sck");
  assert.ok(Array.isArray(ops.parseQuvm(mc).clock), "clock should have been a list");
  const dirMc = generate("multiclock", mc, ["clkgen.sv", "tb_top.sv"]);
  // the second domain reached the top: a DUT-sourced clock is a sampled net there
  // (source: dut => the TB does not generate it, so it is NOT in clkgen)
  const top = readFileSync(
    listFiles(join(dirMc, "tb")).find((f) => basename(f) === "tb_top.sv"), "utf8"
  );
  assert.ok(/\bsck\b/.test(top), `tb_top.sv does not contain the sck domain:\n${top}`);
  assert.match(top, /OBSERVED: the DUT drives this clock/,
    "the source: dut domain should have been an observed clock");
  console.log("  ok    multi-clock: the second domain (source: dut) reaches tb_top");

  // THE DOMAIN-USE CASCADE IS LOAD-BEARING. An agent samples `sck`; QuickUVM refuses
  // an agent clock naming an undeclared domain, so removing `sck` is blocked. Mutation
  // proof: the config with `sck` deleted but the agent still on it is REFUSED.
  assert.throws(() => ops.removeClockDomain(mc, "sck"), /is used by/);
  // build the illegal config by hand (drop the domain, keep the agent binding)
  const orphan = ops.parseQuvm(mc);
  orphan.clock = orphan.clock.filter((d) => d.name !== "sck");
  const dir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-mc-"));
  // re-serialize via a targeted text edit: remove the `{ name: sck, ... }` entry
  const orphanText = mc.replace(/\n\s+- \{ name: sck[^}]*\}/, "");
  assert.notEqual(orphanText, mc, "the mutation (sck domain removed) did not apply");
  writeFileSync(join(dir, "m.quickuvm.yaml"), orphanText);
  const bad = quickUvm(["generate", "-c", join(dir, "m.quickuvm.yaml"), "-o", join(dir, "tb")], dir);
  assert.notEqual(bad.status, 0, "quick-uvm should have refused the agent on a nonexistent domain");
  console.log("  ok    multi-clock: the domain-use cascade is load-bearing (without it: REFUSED)");

  // collapse a 1-element list back to a single mapping — still generates
  let one = ops.addClockDomain(t, "aux"); // core stays on the implicit first
  one = ops.removeClockDomain(one, "aux");
  one = ops.collapseClocks(one);
  assert.equal(Array.isArray(ops.parseQuvm(one).clock), false);
  generate("clock_collapsed", one, ["clkgen.sv"]);
}

// --- scenario 11 (docs/07 P4b): MULTI-RESET domains. Resets carry two invariants
// clocks do not — under a LIST `dut.reset` names a declared DOMAIN, and a domain's
// `clock:` gate must name a declared clock — so the generator is the judge again.
{
  let t = ops.setDut(ops.newConfigText("mr"), {
    module: "mr", clock: "clk", reset: "rst_n",
    resetActiveLow: true, combinational: false,
  });
  t = ops.createAgent(t, {
    name: "core", inputs: [{ name: "din", width: 8 }], outputs: [{ name: "dout", width: 8 }],
  });
  t = ops.createAgent(t, {
    name: "wr", inputs: [{ name: "wdat", width: 8 }], outputs: [] });

  // two reset domains, the second gating the `wr` agent and clocked by a second clock
  let mr = ops.addClockDomain(t, "wclk");
  mr = ops.addResetDomain(mr, "wrst_n");
  mr = ops.setResetDomainField(mr, "wrst_n", "clock", "wclk");
  mr = ops.setAgentField(mr, "wr", "clock", "wclk");
  mr = ops.setAgentField(mr, "wr", "reset", "wrst_n");
  const cfgMr = ops.parseQuvm(mr);
  assert.deepEqual(cfgMr.reset.map((d) => d.name), ["rst_n", "wrst_n"]);
  assert.equal(cfgMr.dut.reset, "rst_n", "dut.reset must name a declared domain");
  generate("multireset", mr, ["tb_top.sv", "clkgen.sv"]);
  console.log("  ok    multi-reset: two domains + the clock gate generate cleanly");

  // THE RENAME CASCADE IS LOAD-BEARING. `dut.reset` and every agent gated by a domain
  // must name a DECLARED domain, so a rename has to carry them along.
  const renamed = ops.setResetDomainField(mr, "wrst_n", "name", "wr_rst_n");
  assert.equal(ops.parseQuvm(renamed).agents[1].reset, "wr_rst_n");
  generate("multireset_renamed", renamed, ["tb_top.sv"]);

  // mutation: rename the domain WITHOUT carrying the agent binding -> REFUSED
  const orphan = mr.replace(/\{ name: wrst_n([^}]*)\}/, "{ name: wr_rst_n$1}");
  assert.notEqual(orphan, mr, "the mutation (a rename without the cascade) did not apply");
  const dir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-mr-"));
  writeFileSync(join(dir, "m.quickuvm.yaml"), orphan);
  const bad = quickUvm(["generate", "-c", join(dir, "m.quickuvm.yaml"), "-o", join(dir, "tb")], dir);
  assert.notEqual(bad.status, 0, "quick-uvm should have refused the unknown reset");
  assert.match(
    (bad.stdout ?? "") + (bad.stderr ?? ""),
    /not a declared reset|dut\.reset/s,
    "it failed for a reason other than the undeclared reset domain"
  );
  console.log("  ok    multi-reset: the rename cascade is load-bearing (without it: REFUSED)");

  // collapse back: dut.reset becomes a PORT name again and agent `reset:` disappears.
  // The domain is in use, so it must be unbound first — the op refuses otherwise,
  // which is the guard doing its job.
  assert.throws(() => ops.removeResetDomain(renamed, "wr_rst_n"), /is used by/);
  let one = ops.setAgentField(renamed, "wr", "reset", "");
  one = ops.removeResetDomain(one, "wr_rst_n");
  one = ops.collapseResets(one);
  assert.equal(Array.isArray(ops.parseQuvm(one).reset), false);
  assert.equal(ops.parseQuvm(one).dut.reset, "rst_n");
  generate("reset_collapsed", one, ["tb_top.sv"]);
}

// --- scenario 12 (docs/07 P4c): PORT DEPTH — the open-drain pair and the symbolic
// enum. An I2C-style bidirectional line is the real case: QuickUVM refuses open drain
// without a pullup, because the line floats to X the moment every driver releases.
{
  let t = ops.setDut(ops.newConfigText("i2c"), {
    module: "i2c", clock: "clk", reset: "rst_n",
    resetActiveLow: true, combinational: false,
  });
  t = ops.createAgent(t, {
    name: "bus",
    inputs: [{ name: "op", width: 2 }],
    outputs: [],
    inouts: [{ name: "sda", width: 1 }],
  });

  // open drain pulls the pullup along, and a symbolic enum on a driven field
  let od = ops.setAgentPortField(t, "bus", "sda", "open_drain", true);
  od = ops.setAgentPortField(od, "bus", "op", "enum", { READ: 0, WRITE: 1, STOP: 2 });
  od = ops.setAgentPortField(od, "bus", "op", "constraint", "op != 3");
  const cfgOd = ops.parseQuvm(od).agents[0].ports;
  assert.equal(cfgOd.inouts[0].open_drain, true);
  assert.equal(cfgOd.inouts[0].pullup, true);
  const dirOd = generate("port_depth", od, ["bus_if.sv", "bus_seq_item.svh"]);

  // the open-drain resolution and the TB's OWN enum really reach the generated code
  const iface = readFileSync(
    listFiles(join(dirOd, "tb")).find((f) => basename(f) === "bus_if.sv"), "utf8"
  );
  assert.match(iface, /1'bz/, `the interface has no open-drain resolution:\n${iface}`);
  const item = readFileSync(
    listFiles(join(dirOd, "tb")).find((f) => basename(f) === "bus_seq_item.svh"), "utf8"
  );
  for (const needle of ["READ", "WRITE", "STOP"]) {
    assert.ok(item.includes(needle), `the enum did not reach the seq_item: ${needle}`);
  }
  console.log("  ok    port depth: open-drain (1'bz) + the symbolic enum reach the code");

  // THE PULLUP PAIRING IS LOAD-BEARING. Mutation: the same config with the pullup
  // stripped is REFUSED — the op refuses it at the source for the same reason.
  assert.throws(() => ops.setAgentPortField(od, "bus", "sda", "pullup", false), /floats to X/);
  const noPullup = od.replace(/, pullup: true/, "");
  assert.notEqual(noPullup, od, "the mutation (pullup stripped) did not apply");
  const dir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-od-"));
  writeFileSync(join(dir, "m.quickuvm.yaml"), noPullup);
  const bad = quickUvm(["generate", "-c", join(dir, "m.quickuvm.yaml"), "-o", join(dir, "tb")], dir);
  assert.notEqual(bad.status, 0, "quick-uvm should have refused open-drain without a pullup");
  assert.match(
    (bad.stdout ?? "") + (bad.stderr ?? ""),
    /needs `pullup: true`|floats to X/s,
    "it failed for a reason other than open-drain-without-pullup"
  );
  console.log("  ok    port depth: the open_drain/pullup pair is load-bearing (without it: REFUSED)");
}

// --- scenario 13 (docs/07 P3c): CROSS-BLOCK scoreboards. A scoreboard whose
// endpoints are `<subenv>.<agent>` compares two COMPOSED children — the endpoint list
// cannot come from the top config alone, so the host reads the children.
{
  // composed blocks share ONE namespace, so the agent names must be unique ACROSS
  // the children (quick-uvm: "agent name 'io' collides with another block")
  const child = (name, agent) => {
    let c = ops.setDut(ops.newConfigText(name), {
      module: name, clock: "clk", reset: "rst_n",
      resetActiveLow: true, combinational: false,
    });
    return ops.createAgent(c, {
      name: agent,
      inputs: [{ name: "din", width: 8 }],
      outputs: [{ name: "dout", width: 8 }],
    });
  };
  const producer = child("producer", "prod_io");
  // the consumer's agent must be PASSIVE: its input is driven by the wire, not by
  // its own driver (the H1 rule the compose flow also enforces)
  const consumer = ops.setAgentActive(child("consumer", "cons_io"), "cons_io", false);

  let top = ops.setDut(ops.newConfigText("sys"), {
    module: "sys", clock: "clk", reset: "rst_n",
    resetActiveLow: true, combinational: true,
  });
  top = ops.createSubenvs(top, [
    { name: "p1", config: "producer.quickuvm.yaml", params: {} },
    { name: "c1", config: "consumer.quickuvm.yaml", params: {} },
  ]);
  top = ops.addConnections(top, [{ from: "p1.dout", to: "c1.din" }]);

  // the CROSS-BLOCK scoreboard: both endpoints are qualified `<subenv>.<agent>`
  const xsb = ops.addScoreboard(top, { name: "xsb", source: "p1.prod_io", monitor: "c1.cons_io" });
  const entry = ops.parseQuvm(xsb).analysis.scoreboards[0];
  assert.equal(entry.source, "p1.prod_io");
  assert.equal(entry.monitor, "c1.cons_io");
  generate("cross_block_sb", xsb, ["tb_top.sv"], {
    "producer.quickuvm.yaml": producer,
    "consumer.quickuvm.yaml": consumer,
  });
  console.log("  ok    cross-block scoreboard: `<subenv>.<agent>` endpoints generate cleanly");

  // the endpoint list the picker offers must match what the generator accepts: an
  // endpoint naming an agent the child does NOT declare is REFUSED
  const bogus = ops.addScoreboard(top, { name: "bad", source: "p1.nope", monitor: "c1.cons_io" });
  const dir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-xsb-"));
  writeFileSync(join(dir, "sys.quickuvm.yaml"), bogus);
  writeFileSync(join(dir, "producer.quickuvm.yaml"), producer);
  writeFileSync(join(dir, "consumer.quickuvm.yaml"), consumer);
  const bad = quickUvm(["generate", "-c", join(dir, "sys.quickuvm.yaml"), "-o", join(dir, "tb")], dir);
  assert.notEqual(bad.status, 0, "quick-uvm should have refused a nonexistent endpoint");
  console.log("  ok    cross-block scoreboard: an undeclared endpoint is REFUSED (the list is anchored)");
}

// --- scenario 14 (docs/07 P5): COMPOSITION & VIP. A VIP is generated first, then a
// bench consumes one of its agents BY REFERENCE — the agent's source is never
// regenerated, the VIP's package filelist is chained instead.
{
  // 1. the VIP: packaged layout, kind: vip, no bench-layer sections
  let vip = ops.setDut(ops.newConfigText("iovip"), {
    module: "iovip", clock: "clk", reset: "rst_n",
    resetActiveLow: true, combinational: false,
  });
  vip = ops.createAgent(vip, {
    name: "io", inputs: [{ name: "din", width: 8 }], outputs: [{ name: "dout", width: 8 }],
  });
  vip = ops.setBenchField(vip, "layout", "packaged");
  vip = ops.setBenchField(vip, "kind", "vip");
  for (const tname of ops.parseQuvm(vip).tests.map((x) => x.name)) {
    vip = ops.removeTest(vip, tname); // a declared test list is fenced on a vip
  }
  const vipDir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-vip-"));
  writeFileSync(join(vipDir, "iovip.quickuvm.yaml"), vip);
  const rv = quickUvm(["generate", "-c", join(vipDir, "iovip.quickuvm.yaml"), "-o", join(vipDir, "gen")], vipDir);
  assert.equal(rv.status, 0, `the VIP's generation failed:\n${(rv.stdout ?? "") + (rv.stderr ?? "")}`);
  const manifest = listFiles(join(vipDir, "gen")).find((f) => f.endsWith(".qvip"));
  assert.ok(manifest, "the VIP did not emit a .qvip manifest");
  console.log("  ok    VIP: kind: vip emits the .qvip manifest");

  // 2. the consuming bench: `{name, from_vip}` with the path RELATIVE to the config
  let bench = ops.setDut(ops.newConfigText("user"), {
    module: "user", clock: "clk", reset: "rst_n",
    resetActiveLow: true, combinational: false,
  });
  // addVipAgent also switches the bench to `layout: packaged` — consuming by
  // reference requires it, and quick-uvm refuses otherwise
  bench = ops.addVipAgent(bench, "io", "vip/gen/" + basename(manifest));
  assert.equal(ops.parseQuvm(bench).layout, "packaged");
  const benchDir = mkdtempSync(join(tmpdir(), "quickuvm-e2e-vipuser-"));
  cpSync(vipDir, join(benchDir, "vip"), { recursive: true });
  writeFileSync(join(benchDir, "user.quickuvm.yaml"), bench);
  const rb = quickUvm(["generate", "-c", join(benchDir, "user.quickuvm.yaml"), "-o", join(benchDir, "tb")], benchDir);
  assert.equal(rb.status, 0, `the consuming bench failed:\n${(rb.stdout ?? "") + (rb.stderr ?? "")}`);

  // the referenced agent's SOURCE is not regenerated — only the wiring is
  const emitted = listFiles(join(benchDir, "tb")).map((f) => basename(f));
  assert.ok(!emitted.includes("io_driver.svh"),
    `the referenced agent's source should have been SKIPPED, but it was generated: ${emitted}`);
  assert.ok(emitted.includes("tb_top.sv"), "the consuming bench did not generate a top");
  console.log("  ok    VIP: consumption by reference (the agent's source is NOT regenerated)");

  // a reference entry carries ONLY name + from_vip — anything else is refused
  const bloated = bench.replace(/\{ name: io, from_vip: ([^}]*)\}/, "{ name: io, from_vip: $1, active: false }");
  assert.notEqual(bloated, bench, "the mutation (an extra key on the reference) did not apply");
  writeFileSync(join(benchDir, "bad.quickuvm.yaml"), bloated);
  const bad = quickUvm(["generate", "-c", join(benchDir, "bad.quickuvm.yaml"), "-o", join(benchDir, "tb2")], benchDir);
  assert.notEqual(bad.status, 0, "quick-uvm should have refused a reference with extra keys");
  assert.match(
    (bad.stdout ?? "") + (bad.stderr ?? ""),
    /reference entry carries only/s,
    "it failed for a reason other than the enriched reference"
  );
  console.log("  ok    VIP: a reference carries ONLY name + from_vip (anything else: REFUSED)");
}

// --- scenario 15 (Nov 2026): THE TUTORIAL BENCH, gesture by gesture
// (docs/tutorial-yapp-buffer.md) — and the reset wiring that was broken in it.
{
  const tutorial = () => {
    let t = ops.setDut(ops.newConfigText("yapp_buffer"), {
      module: "yapp_buffer", clock: "clk", reset: "rst_n",
      resetActiveLow: true, combinational: false,
    });
    t = ops.createAgent(t, {
      name: "cmd",
      inputs: [
        { name: "in_data", width: 8 },
        { name: "in_addr", width: 2 },
        { name: "in_valid", width: 1 },
      ],
      outputs: [{ name: "in_ready", width: 1 }],
    });
    t = ops.createAgent(t, {
      name: "rsp",
      inputs: [{ name: "out_ready", width: 1 }],
      outputs: [
        { name: "out_data", width: 8 },
        { name: "out_addr", width: 2 },
        { name: "out_valid", width: 1 },
      ],
    });
    t = ops.addScoreboard(t, {
      name: "pkt_sb", source: "cmd", monitor: "rsp",
      match: "out_of_order", matchKey: "out_addr",
    });
    return ops.addCoverage(t, "cmd");
  };
  const text = tutorial();

  // the tutorial's YAML listing IS what the gestures write (the listing claimed a
  // config that generated a bench which did not elaborate; now it cannot drift)
  const doc = readFileSync("docs/tutorial-yapp-buffer.md", "utf8").replace(/\r\n/g, "\n");
  const listing = /```yaml\n([\s\S]*?)```/.exec(doc)?.[1];
  assert.ok(listing, "the tutorial has no ```yaml listing");
  assert.equal(listing, text.replace(/\r\n/g, "\n"),
    "docs/tutorial-yapp-buffer.md: the YAML listing is not what the mutations write");

  const dir = generate("yapp_buffer", text, [
    "cmd_if.sv", "rsp_if.sv", "cmd_cov.svh", "yapp_buffer_scoreboard.svh",
    "yapp_buffer_env.svh", "yapp_buffer_virtual_sequencer.svh", "tb_top.sv",
  ]);
  const lint = lintDutConnections(join(dir, "tb"));
  const top = readFileSync(lint.tops[0], "utf8");
  // the DUT's reset port IS connected, to a signal that exists (the lint in
  // generate() proved the second half) ...
  const rst = lint.connections.filter((c) => c.port === "rst_n");
  assert.equal(rst.length, 1, `the DUT's rst_n is not connected:\n${top}`);
  // ... and somebody DRIVES it: the top's generated reset block, active-low
  assert.match(top, /^\s*logic rst_n;/m, "tb_top does not declare the reset net");
  assert.match(top, /rst_n = 1'b0;\s*\/\/ assert[\s\S]*rst_n = 1'b1;\s*\/\/ deassert/,
    "tb_top does not drive the reset (assert low, release high)");
  for (const f of ["cmd_if.sv", "rsp_if.sv"]) {
    assert.match(readFileSync(join(dir, "tb", f), "utf8"), /input rst_n\)/,
      `${f} does not take the reset`);
  }
  console.log("  ok    tutorial: the DUT's reset is declared, driven by tb_top and connected");

  // the POLARITY is honoured by the generated block (an active-high `rst`)
  let high = ops.setDut(ops.newConfigText("hi"), {
    module: "hi", clock: "clk", reset: "rst", resetActiveLow: false, combinational: false,
  });
  high = ops.createAgent(high, {
    name: "a", inputs: [{ name: "din", width: 8 }], outputs: [{ name: "dout", width: 8 }],
  });
  assert.deepEqual(ops.parseQuvm(high).reset, { active_low: false, external: true });
  const hiDir = generate("reset_active_high", high, ["tb_top.sv"]);
  assert.match(readFileSync(join(hiDir, "tb", "tb_top.sv"), "utf8"),
    /rst = 1'b1;\s*\/\/ assert[\s\S]*rst = 1'b0;\s*\/\/ deassert/,
    "the active-high reset is not asserted high / released low");
  console.log("  ok    reset: the active-high polarity reaches tb_top's reset generator");

  // MUTATION PROOF — the lint is what catches the old shape. The same bench
  // without `reset: {external: true}` (what every earlier Architect wrote):
  // quick-uvm 1.1.0 still exits 0 and the lint names the dangling reference. The
  // fix released in quick-uvm 1.2.0 (arcadie-cracan/QuickUVM#119) INFERS the
  // top-driven reset for this shape — then the bench is the same as the one
  // above and the lint is clean; a generator that refuses the config instead is
  // accepted too. All three are told apart here, so this test says which
  // generator it ran against.
  const oldShape = ops.setResetDomainField(text, "rst_n", "external", false);
  assert.equal(ops.parseQuvm(oldShape).reset, undefined, "the old shape has no `reset:` block");
  const od = mkdtempSync(join(tmpdir(), "quickuvm-e2e-oldreset-"));
  writeFileSync(join(od, "m.quickuvm.yaml"), oldShape);
  const r = quickUvm(["generate", "-c", join(od, "m.quickuvm.yaml"), "-o", join(od, "tb")], od);
  const bad = r.status === 0 ? lintDutConnections(join(od, "tb")).problems : [];
  if (r.status === 0 && bad.length === 0) {
    const inferred = readFileSync(join(od, "tb", "tb_top.sv"), "utf8");
    assert.match(inferred, /^\s*logic rst_n;/m, "clean, but nobody declares the reset net");
    assert.match(inferred, /rst_n = 1'b1;\s*\/\/ deassert/, "clean, but nobody drives the reset");
    console.log("  ok    reset: the old shape (no external) — the generator INFERS the top-driven reset (fixed upstream)");
  } else if (r.status === 0) {
    assert.equal(bad.length, 1, `the lint should name exactly the reset:\n${bad.join("\n")}`);
    assert.match(bad[0], /\.rst_n\(cmd_if_inst\.rst_n\).*cmd_if\.sv declares no signal `rst_n`/);
    console.log("  ok    reset: the old shape (no external) — the generator exits 0, the lint names the dangling reference");
  } else {
    console.log("  ok    reset: the old shape (no external) is REFUSED by the generator (fixed upstream)");
  }

  // the AGENT-DRIVEN shape stays legal: the port among an agent's inputs, no
  // `external` (setDut derives that), and the interface then has the signal
  let driven = ops.addAgentPorts(oldShape, "cmd", {
    inputs: [{ name: "rst_n", width: 1 }], outputs: [],
  });
  driven = ops.setDut(driven, {
    module: "yapp_buffer", clock: "clk", reset: "rst_n",
    resetActiveLow: true, combinational: false,
  });
  assert.equal(ops.parseQuvm(driven).reset, undefined, "external next to an agent-declared reset");
  generate("reset_agent_driven", driven, ["cmd_if.sv", "tb_top.sv"]);
  // ... and `external: true` next to it is the generator's own wall — which the
  // mutation says first (the guard and the wall agree, checked in both directions)
  assert.throws(() => ops.setResetDomainField(driven, "rst_n", "external", true), /agent's ports/);
  const both = driven + "reset: { external: true }\n";
  assert.equal(ops.parseQuvm(both).reset.external, true, "the hand-written pair did not apply");
  const bd = mkdtempSync(join(tmpdir(), "quickuvm-e2e-bothreset-"));
  writeFileSync(join(bd, "m.quickuvm.yaml"), both);
  const rb = quickUvm(["generate", "-c", join(bd, "m.quickuvm.yaml"), "-o", join(bd, "tb")], bd);
  assert.notEqual(rb.status, 0, "external + agent-declared reset should be refused");
  assert.match((rb.stdout ?? "") + (rb.stderr ?? ""), /must not also be an agent port/);
  console.log("  ok    reset: agent-driven (the port in an agent, no external) generates; both at once = REFUSED");

  // `reset_port` (review): an agent drives the reset through its own port. With
  // dut.reset left at its `rst_n` default the top dangles as before, `external:
  // true` is REFUSED there — the repair is `clearDutReset`.
  let rp = ops.createAgent(ops.newConfigText("rp"), {
    name: "a", inputs: [{ name: "din", width: 8 }, { name: "arst", width: 1 }], outputs: [],
  });
  rp = ops.setAgentField(rp, "a", "reset_port", "arst");
  rp += "dut: { name: rp, clock: clk }\n";
  assert.equal(ops.parseQuvm(rp).dut.reset, undefined, "the key is absent: the generator's default");
  const rd = mkdtempSync(join(tmpdir(), "quickuvm-e2e-resetport-"));
  writeFileSync(join(rd, "m.quickuvm.yaml"), rp);
  const rr = quickUvm(["generate", "-c", join(rd, "m.quickuvm.yaml"), "-o", join(rd, "tb")], rd);
  if (rr.status === 0) {
    assert.match(lintDutConnections(join(rd, "tb")).problems.join("\n"), /\.rst_n\(a_if_inst\.rst_n\)/);
  }
  assert.throws(() => ops.setResetDomainField(rp, "rst_n", "external", true), /reset_port/);
  generate("reset_port_cleared", ops.clearDutReset(rp), ["a_if.sv", "tb_top.sv"]);
  console.log("  ok    reset: reset_port — the default dut.reset dangles, clearDutReset repairs it");

  // `kind: selftest` (review): a DUT-less top. The kind switch must take
  // `external: true` away — with it the interfaces take a `rst_n` input the top
  // never connects, and the drivers wait on it forever (exit 0).
  let st = ops.setDut(ops.newConfigText("st"), {
    module: "st", clock: "clk", reset: "rst_n", resetActiveLow: true, combinational: false,
  });
  st = ops.createAgent(st, {
    name: "a", inputs: [{ name: "din", width: 8 }], outputs: [{ name: "dout", width: 8 }],
  });
  for (const tname of ops.parseQuvm(st).tests.map((x) => x.name)) {
    st = ops.removeTest(st, tname);
  }
  st = ops.setBenchField(st, "layout", "packaged");
  assert.deepEqual(ops.parseQuvm(st).reset, { external: true });
  const selftest = ops.setBenchField(st, "kind", "selftest");
  assert.equal(ops.parseQuvm(selftest).reset, undefined, "the selftest kept `external: true`");
  const sd = generate("selftest", selftest, ["a_driver.svh", "a_if.sv"]);
  const waits = (dir) =>
    /wait\s*\(\s*vif\.rst_n/.test(readFileSync(
      listFiles(join(dir, "tb")).find((f) => basename(f) === "a_driver.svh"), "utf8"));
  // THE INVARIANT, whatever the generator: a driver that waits on the reset needs a
  // top that drives it. On 1.1.0 the selftest Architect writes has no reset at all;
  // with the upstream fix the reset is inferred there too and the top generates it.
  const topOf = (dir) =>
    readFileSync(listFiles(join(dir, "tb")).find((f) => basename(f) === "tb_top.sv"), "utf8");
  const drivesReset = (dir) => /a_if a_if_inst \(\.clk\(clk\), \.rst_n\(rst_n\)\);/.test(topOf(dir));
  assert.equal(waits(sd), drivesReset(sd),
    "the selftest's driver waits on a reset the top does not drive (or the reverse)");
  // mutation proof: the same selftest WITH the flag — the cascade is load-bearing
  // on 1.1.0, where the generator hangs the bench instead of driving the reset
  const stuck = selftest + "reset: { external: true }\n";
  const xd = mkdtempSync(join(tmpdir(), "quickuvm-e2e-selftest-ext-"));
  writeFileSync(join(xd, "m.quickuvm.yaml"), stuck);
  const xr = quickUvm(["generate", "-c", join(xd, "m.quickuvm.yaml"), "-o", join(xd, "tb")], xd);
  if (xr.status === 0 && drivesReset(xd)) {
    assert.ok(waits(xd), "the top drives a reset no driver waits on");
    console.log("  ok    reset: selftest — the selftest top generates the reset (fixed upstream)");
  } else if (xr.status === 0) {
    const xtop = topOf(xd);
    assert.ok(waits(xd), "expected the driver to wait on vif.rst_n");
    assert.match(xtop, /a_if a_if_inst \(clk\);/, "expected the top to leave rst_n unconnected");
    console.log("  ok    reset: selftest — no external (with it: drivers wait on a reset the top never connects)");
  } else {
    console.log("  ok    reset: selftest — no external (the generator now refuses the pair itself)");
  }
}

// --- scenario 16 (docs/08 R24): the "New testbench" TEMPLATES. Each plan is a fold
// of the mutations above over a new skeleton; here each one is generated for real —
// a template that writes a config quick-uvm refuses is worse than no template.
{
  await esbuild.build({
    entryPoints: ["src/templates.ts"],
    outfile: join(outDir, "templates.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  const T = await import(pathToFileURL(join(outDir, "templates.mjs")));
  const model = JSON.parse(readFileSync("examples/model.json", "utf8"));
  const port = (name, dir, width = 1) => ({
    name, dir, type: "logic", width, unpacked_dims: null, elem_width: null, loc: null,
  });
  const tbTop = (dir) =>
    readFileSync(listFiles(join(dir, "tb")).find((f) => basename(f) === "tb_top.sv"), "utf8");

  // one agent per interface, on the regression design
  const iface = T.planTemplate(model, "demo_top.u_soc", "per-interface");
  generate("tpl_per_interface", iface.text, ["bus_if.sv", "tb_top.sv"]);

  // one agent per clock domain: two clocks, two resets, each agent on its own
  const cdc = {
    schema_version: 1,
    tops: ["cdc_fifo"],
    modules: {
      cdc_fifo: {
        ports: [
          port("src_clk_i", "in"), port("src_rst_ni", "in"),
          port("src_data_i", "in", 8), port("src_valid_i", "in"), port("src_ready_o", "out"),
          port("dst_clk_i", "in"), port("dst_rst_ni", "in"),
          port("dst_data_o", "out", 8), port("dst_valid_o", "out"), port("dst_ready_i", "in"),
        ],
        iface_ports: [],
        loc: null,
      },
    },
    instances: [{ path: "cdc_fifo", module: "cdc_fifo", params: {}, loc: null }],
    views: {},
  };
  const clk = T.planTemplate(cdc, "cdc_fifo", "per-clock");
  const clkTop = tbTop(generate("tpl_per_clock", clk.text, ["clkgen.sv", "src_if.sv", "dst_if.sv"]));
  assert.match(clkTop, /src_if src_if_inst \(\.clk\(src_clk_i\), \.src_rst_ni\(src_rst_ni\)\)/);
  assert.match(clkTop, /dst_if dst_if_inst \(\.clk\(dst_clk_i\), \.dst_rst_ni\(dst_rst_ni\)\)/,
    "each agent's interface is on ITS clock and reset");
  // both resets reach the DUT itself (not only the interfaces asserted above)
  const dutInst = /cdc_fifo dut_inst \(([\s\S]*?)\);/.exec(clkTop)?.[1] ?? "";
  assert.match(dutInst, /\.src_rst_ni\(src_rst_ni\)/, "the first reset is connected to the DUT");
  assert.match(dutInst, /\.dst_rst_ni\(dst_rst_ni\)/, "the second reset is connected to the DUT");

  // what the Signals view's "Unconnected" folders state (two DIFFERENT rules,
  // probed one key at a time):
  //  - no `clock:` of its own → the FIRST clock domain of the list;
  const noClock = ops.setAgentField(ops.setAgentField(clk.text, "dst", "clock", ""), "dst", "reset", "");
  assert.match(tbTop(generate("tpl_no_clock", noClock, ["tb_top.sv"])),
    /dst_if dst_if_inst \(\.clk\(src_clk_i\), \.src_rst_ni\(src_rst_ni\)\)/,
    "quick-uvm no longer puts an agent without `clock:` on the first domain — the Signals view lies");
  //  - no `reset:` of its own → the reset RELEASED ON ITS CLOCK, not the first
  const noReset = ops.setAgentField(clk.text, "dst", "reset", "");
  assert.match(tbTop(generate("tpl_no_reset", noReset, ["tb_top.sv"])),
    /dst_if dst_if_inst \(\.clk\(dst_clk_i\), \.dst_rst_ni\(dst_rst_ni\)\)/,
    "quick-uvm no longer binds an agent without `reset:` to its clock's reset — the Signals view lies");

  // ONE reset under a clock list: the template declares it as a one-entry list,
  // because with the plain mapping quick-uvm generates no reset at all
  const bridge = {
    schema_version: 1,
    tops: ["bridge"],
    modules: {
      bridge: {
        ports: [
          port("clk", "in"), port("rst_n", "in"), port("fast_clk", "in"),
          port("req", "in"), port("ack", "out"), port("fast_data", "in", 4), port("fast_vld", "out"),
        ],
        iface_ports: [],
        loc: null,
      },
    },
    instances: [{ path: "bridge", module: "bridge", params: {}, loc: null }],
    views: {},
  };
  const shared = T.planTemplate(bridge, "bridge", "per-clock");
  const sharedTop = tbTop(generate("tpl_shared_reset", shared.text, ["clkgen.sv", "tb_top.sv"]));
  const sharedDut = /bridge dut_inst \(([\s\S]*?)\);/.exec(sharedTop)?.[1] ?? "";
  assert.match(sharedDut, /\.rst_n\(rst_n\)/, "the shared reset is connected to the DUT");
  assert.match(sharedTop, /fast_if fast_if_inst \(\.clk\(fast_clk\), \.rst_n\(rst_n\)\)/,
    "the agent of the other domain gets the shared reset");
  // `collapseResets` is the Properties panel's own gesture: a one-entry list
  // back to the single mapping. Since D25 the mapping it writes is TOP-DRIVEN
  // (`external: true`), which quick-uvm's multi-domain path does read — so the
  // gesture no longer walks into the hazard below
  const mapped = ops.collapseResets(shared.text);
  assert.deepEqual(ops.parseQuvm(mapped).reset, { external: true });
  const dutOf = (top) => /bridge dut_inst \(([\s\S]*?)\);/.exec(top)?.[1] ?? "";
  const mappedTop = tbTop(generate("tpl_shared_reset_mapping", mapped, ["tb_top.sv"]));
  assert.match(dutOf(mappedTop), /\.rst_n\(rst_n\)/,
    "a top-driven single reset under a clock list is not connected to the DUT");
  // the hazard itself, locked: the same bench with the PLAIN mapping (no
  // `external` — a hand-written or pre-D25 config) has no reset on quick-uvm
  // 1.1.0. A generator that infers the top-driven reset wires it; both are told
  // apart, so this says which generator it ran against.
  const plain = ops.setResetDomainField(mapped, "rst_n", "external", false);
  assert.equal(ops.parseQuvm(plain).reset, undefined);
  const plainTop = tbTop(generate("tpl_shared_reset_plain", plain, ["tb_top.sv"]));
  if (/\.rst_n\(rst_n\)/.test(dutOf(plainTop))) {
    console.log("  ok    templates: a plain reset mapping under a clock list — the generator INFERS the top-driven reset (fixed upstream)");
  } else {
    assert.doesNotMatch(dutOf(plainTop), /rst_n/, "the DUT's reset is connected to something else");
    console.log("  ok    templates: a plain reset mapping under a clock list — NO reset is generated (resetAsList and the Signals view's warning stay)");
  }

  // composition from the sub-blocks, on the regression design: 5 subenvs, 3 block
  // configs with a boundary agent each
  const comp = T.planTemplate(model, "demo_top.u_soc", "composition");
  generate("soc_top", comp.text, ["tb_top.sv"],
    Object.fromEntries(comp.children.map((c) => [c.file, c.text])));

  // ... and with a connection the design draws: the physical assign, the
  // destination's agent passive (an active one is refused — scenario 6)
  const sys = {
    schema_version: 1,
    tops: ["sys"],
    modules: {
      sys: { ports: [port("din", "in", 8), port("dout", "out", 8)], iface_ports: [], loc: null },
      prod: { ports: [port("d_i", "in", 8), port("q_o", "out", 8)], iface_ports: [], loc: null },
      cons: { ports: [port("d_i", "in", 8), port("q_o", "out", 8)], iface_ports: [], loc: null },
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
        nets: [{ name: "mid", endpoints: ["u_p.q_o", "u_c.d_i"], fanout: 1, render: "wire" }],
      },
    },
  };
  const wired = T.planTemplate(sys, "sys", "composition");
  const wiredTop = tbTop(generate("sys", wired.text, ["tb_top.sv"],
    Object.fromEntries(wired.children.map((c) => [c.file, c.text]))));
  assert.match(wiredTop, /assign\s+\S*d_i\s*=\s*\S*q_o/, "the connection is a physical assign in tb_top");
  console.log("  ok    templates: per-interface, per-clock (+ the unassigned default), composition (+ wired)");
}

// --- scenario 17 (docs/07 "Interim", Nov 2026): THE FIRST `analysis:` ENTRY.
// Without the key quick-uvm infers a scoreboard and a coverage collector on the
// primary agent; writing ANY entry switches it to declared mode and both are
// gone. A gesture that adds one scoreboard therefore took the coverage away,
// and one that adds coverage took both — silently. The generator is asked
// (`resolve`) before and after: what was inferred must still be there.
{
  await esbuild.build({
    entryPoints: ["src/resolved.ts"],
    outfile: join(outDir, "resolved.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const R = await import(pathToFileURL(join(outDir, "resolved.mjs")));
  const resolveOf = (text, extra = {}) => {
    const d = mkdtempSync(join(tmpdir(), "quickuvm-e2e-resolve-"));
    const f = join(d, "b.quickuvm.yaml");
    writeFileSync(f, text);
    for (const [name, body] of Object.entries(extra)) {
      writeFileSync(join(d, name), body);
    }
    const r = quickUvm(["resolve", "-c", f], d);
    assert.equal(r.status, 0, `quick-uvm resolve failed:\n${r.stdout}${r.stderr}`);
    const parsed = R.parseResolved(r.stdout);
    assert.ok(parsed, `resolve printed something that is not a resolved config:\n${r.stdout.slice(0, 300)}`);
    return parsed;
  };
  const shape = (res) => ({
    mode: res.analysis.mode,
    scoreboards: res.analysis.scoreboards.map((s) => `${s.name}@${s.source}`).sort(),
    coverage: res.analysis.coverage.map((c) => c.agent).sort(),
    inferred: R.inferredComponents(res).map((c) => c.id).sort(),
  });

  // the tutorial bench before its first analysis gesture
  let base = ops.setDut(ops.newConfigText("yapp_buffer"), {
    module: "yapp_buffer", clock: "clk", reset: "rst_n",
    resetActiveLow: true, combinational: false,
  });
  base = ops.createAgent(base, {
    name: "cmd",
    inputs: [{ name: "in_data", width: 8 }, { name: "in_addr", width: 2 }, { name: "in_valid", width: 1 }],
    outputs: [{ name: "in_ready", width: 1 }],
  });
  base = ops.createAgent(base, {
    name: "rsp",
    inputs: [{ name: "out_ready", width: 1 }],
    outputs: [{ name: "out_data", width: 8 }, { name: "out_addr", width: 2 }, { name: "out_valid", width: 1 }],
  });
  const live = ["cmd", "rsp"];
  const implicit = resolveOf(base);
  // what the rule is built on — if a quick-uvm release infers something else,
  // this is the line that says so
  assert.deepEqual(shape(implicit), {
    mode: "implicit", scoreboards: ["sbd@cmd"], coverage: ["cmd"], inferred: ["cov:cmd", "sb:sbd"],
  });

  // the plan trusts an answer only when its agents are the live configuration's,
  // in order: that is what `resolve` must keep reporting
  assert.deepEqual(implicit.agents.map((x) => x.name), live);
  assert.equal(R.keepOnFirstAnalysis(implicit, ["rsp", "cmd"], { kind: "coverage", agent: "rsp" }).known, false);

  // THE OLD BEHAVIOUR, as a mutation proof: the bare mutations lose what was inferred
  assert.deepEqual(
    shape(resolveOf(ops.addScoreboard(base, { name: "pkt_sb", source: "cmd", monitor: "rsp" }))),
    { mode: "declared", scoreboards: ["pkt_sb@cmd"], coverage: [], inferred: [] },
    "the bare addScoreboard no longer drops the inferred coverage: the fold may be redundant now"
  );
  assert.deepEqual(
    shape(resolveOf(ops.addCoverage(base, "rsp"))),
    { mode: "declared", scoreboards: [], coverage: ["rsp"], inferred: [] },
    "the bare addCoverage no longer drops the inferred scoreboard and collector"
  );

  // 1. the tutorial's gesture: a scoreboard on cmd — the inferred one's source.
  //    It REPLACES sbd; the coverage on cmd survives. And the text is the
  //    tutorial's listing: the gesture alone now writes what steps 5 + 6 wrote.
  const sbSpec = { name: "pkt_sb", source: "cmd", monitor: "rsp", match: "out_of_order", matchKey: "out_addr" };
  const p1 = R.keepOnFirstAnalysis(implicit, live, { kind: "scoreboard", source: "cmd" });
  assert.deepEqual([p1.known, p1.replaced, p1.coverage], [true, ["sbd"], ["cmd"]]);
  const t1 = ops.addScoreboardKeeping(base, sbSpec, p1);
  assert.deepEqual(shape(resolveOf(t1)), {
    mode: "declared", scoreboards: ["pkt_sb@cmd"], coverage: ["cmd"], inferred: [],
  });
  const tutorialDoc = readFileSync("docs/tutorial-yapp-buffer.md", "utf8").replace(/\r\n/g, "\n");
  assert.equal(/```yaml\n([\s\S]*?)```/.exec(tutorialDoc)?.[1], t1.replace(/\r\n/g, "\n"),
    "the scoreboard gesture on an implicit bench does not write the tutorial's listing");

  // 2. a scoreboard on ANOTHER source keeps the inferred one beside it — and the
  //    bench with both generates (two scoreboards, one per stream)
  const p2 = R.keepOnFirstAnalysis(implicit, live, { kind: "scoreboard", source: "rsp" });
  const t2 = ops.addScoreboardKeeping(base, { name: "rsp_sb", source: "rsp" }, p2);
  assert.deepEqual(shape(resolveOf(t2)), {
    mode: "declared", scoreboards: ["rsp_sb@rsp", "sbd@cmd"], coverage: ["cmd"], inferred: [],
  });
  generate("first-analysis-two-sb", t2, ["tb_top.sv", "cmd_cov.svh"]);

  // 3. coverage on another agent keeps the scoreboard AND the inferred collector
  const p3 = R.keepOnFirstAnalysis(implicit, live, { kind: "coverage", agent: "rsp" });
  const t3 = ops.addCoverageKeeping(base, "rsp", p3);
  assert.deepEqual(shape(resolveOf(t3)), {
    mode: "declared", scoreboards: ["sbd@cmd"], coverage: ["cmd", "rsp"], inferred: [],
  });
  generate("first-analysis-cov", t3, ["tb_top.sv", "rsp_cov.svh"]);

  // the invariant behind all three, stated once: nothing inferred is lost unless
  // the plan says it was replaced
  for (const [text, plan] of [[t1, p1], [t2, p2], [t3, p3]]) {
    const after = shape(resolveOf(text));
    for (const id of shape(implicit).inferred) {
      const name = id.slice(id.indexOf(":") + 1);
      const still = id.startsWith("cov:")
        ? after.coverage.includes(name)
        : after.scoreboards.some((s) => s.startsWith(`${name}@`));
      assert.ok(still || plan.replaced.includes(name), `${id} was inferred and is gone without being replaced`);
    }
  }
  console.log("  ok    first analysis entry: what quick-uvm inferred is kept (or replaced on the same source), asked of the generator");

  // --- WHERE WHAT `resolve` REPORTS IS NOT GENERATED (adversarial review, Nov
  // 2026). quick-uvm 1.2.0 reports sbd + a collector on agents[0] for ANY bench
  // without `analysis:`; on a replicated agent, a VIP and a composition the
  // generator generates neither, and REFUSES both once declared — keeping the
  // reported set there turned a bench that generated into one that does not.
  // `inferenceIsReal` fences those shapes off (no ghost, no materialise offer,
  // the plain gesture). Each lock below has four legs; the day quick-uvm wires
  // one of these shapes, a leg fails and says which.
  //
  // The over-report is QuickUVM#121. A generator with the fix reports nothing
  // inferred on these shapes, so leg 2 accepts BOTH answers and says which one
  // it met: the fence is needed for 1.2.0 and older, and harmless after — it
  // stays as long as those versions are supported. What 1.2.0 reported is
  // written down here (`legacy`) so that leg 4, the reason the fence exists,
  // keeps being checked whatever the installed generator answers.
  const overReporting = [];
  const tryGen = (text, extra = {}) => {
    const d = mkdtempSync(join(tmpdir(), "quickuvm-e2e-shape-"));
    const f = join(d, "b.quickuvm.yaml");
    writeFileSync(f, text);
    for (const [name, body] of Object.entries(extra)) {
      writeFileSync(join(d, name), body);
    }
    const r = quickUvm(["generate", "-c", f, "-o", join(d, "tb")], d);
    return { status: r.status, out: `${r.stdout}${r.stderr}`, dir: d };
  };
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
    );
  const generated = (g, re) =>
    walk(join(g.dir, "tb")).filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => basename(f));
  const shapeLock = (label, text, extra, gesture, bare, keeping, wall, absent) => {
    const cfg = ops.parseQuvm(text);
    const agents = (cfg.agents ?? []).map((x) => x.name);
    // 1. the fence knows the shape
    assert.equal(R.inferenceIsReal(cfg), false, `${label}: the fence does not know this shape`);
    assert.deepEqual(R.inferredComponents(resolveOf(text, extra), cfg), [], `${label}: a ghost would be drawn`);
    // 2. `resolve` either over-reports the shape (<= 1.2.0) or reports nothing
    //    inferred for it (QuickUVM#121 fixed) — never something else
    const reported = resolveOf(text, extra);
    const now = R.inferredComponents(reported).map((c) => c.id).sort();
    const legacyIds = [`cov:${agents[0]}`, `sb:sbd`];
    assert.ok(
      now.length === 0 || JSON.stringify(now) === JSON.stringify(legacyIds),
      `${label}: quick-uvm resolve reports ${JSON.stringify(now)} here — neither the old over-report nor nothing`
    );
    if (now.length) {
      overReporting.push(label);
    }
    // what 1.2.0 answered, whatever this generator answers
    const legacy = {
      ...reported,
      analysis: {
        mode: "implicit",
        scoreboards: [{ name: "sbd", source: agents[0], origin: "inferred" }],
        coverage: [{ agent: agents[0], origin: "inferred" }],
      },
    };
    // 3. the bench generates as it is, WITHOUT the components resolve reports
    const implicitGen = tryGen(text, extra);
    assert.equal(implicitGen.status, 0, `${label}: the implicit bench does not generate:\n${implicitGen.out.slice(-600)}`);
    for (const [what, re, only] of absent) {
      const hits = generated(implicitGen, re).filter((f) => !only || only.test(f));
      assert.deepEqual(hits, [], `${label}: the generator DOES generate ${what} now (${hits.join(", ")}) — the fence hides real components`);
    }
    // 4. the plain gesture generates; the set 1.2.0 reports, declared with it,
    //    is refused — and with a generator that reports nothing, nothing is kept
    if (!now.length) {
      const honest = R.keepOnFirstAnalysis(reported, agents, gesture);
      assert.deepEqual(
        [honest.known, honest.scoreboards, honest.coverage],
        [true, [], []],
        `${label}: the fixed generator's answer would still have something kept`
      );
    }
    const plan = R.keepOnFirstAnalysis(legacy, agents, gesture);
    assert.equal(plan.known, true, `${label}: the plan would not have been made`);
    assert.ok(plan.scoreboards.length + plan.coverage.length > 0, `${label}: nothing would have been kept`);
    const plain = tryGen(bare(text), extra);
    assert.equal(plain.status, 0, `${label}: the plain gesture no longer generates:\n${plain.out.slice(-600)}`);
    const kept = tryGen(keeping(text, plan), extra);
    assert.notEqual(kept.status, 0, `${label}: quick-uvm now ACCEPTS the reported set declared — it wires this shape, the fence may go`);
    assert.match(kept.out, wall, `${label}: it failed for a reason other than the shape's wall`);
  };

  // a replicated agent: per-replica scoreboards, no collector
  let rep = ops.setDut(ops.newConfigText("buf"), {
    module: "buf", clock: "clk", reset: "rst_n", resetActiveLow: true, combinational: false,
  });
  rep = ops.createAgent(rep, { name: "cmd", inputs: [{ name: "d", width: 8 }], outputs: [{ name: "q", width: 8 }] });
  const repText = rep.replace("    sequence_item: cmd_seq_item\n", "    sequence_item: cmd_seq_item\n    replicas: 3\n");
  assert.notEqual(repText, rep, "the replicas fixture did not apply");
  // the new scoreboard is on ANOTHER name and the same source: sbd is replaced,
  // and what is kept is the collector — the entry the replicated env refuses
  shapeLock(
    "replicas", repText, {},
    { kind: "scoreboard", source: "cmd" },
    (t) => ops.addScoreboard(t, { name: "sbd", source: "cmd" }),
    (t, plan) => ops.addScoreboardKeeping(t, { name: "sbd", source: "cmd" }, plan),
    /replicas/,
    [["a coverage collector in the env", /_cov(_h)?\s*=|_cov\b[^\n]*type_id::create/, /_env\.svh$/]]
  );

  // a VIP: only the agent packages and a manifest are emitted
  let vip = ops.setBenchField(ops.setBenchField(base, "layout", "packaged"), "kind", "vip");
  const vipText = vip.replace(/tests:\n  - \{ name: \w+ \}\n/, ""); // a vip refuses a declared test list
  assert.notEqual(vipText, vip, "the vip fixture did not apply");
  shapeLock(
    "kind: vip", vipText, {},
    { kind: "coverage", agent: "rsp" },
    // the only coverage a VIP accepts is a rich model on the agent it ships (a 1-bit
    // field: a wider coverpoint needs explicit bins)
    (t) => ops.upgradeCoverage(ops.addCoverage(t, "rsp"), "rsp", "out_valid"),
    (t, plan) => ops.upgradeCoverage(ops.addCoverageKeeping(t, "rsp", plan), "rsp", "out_valid"),
    /kind: vip/,
    [["the scoreboard sbd", /\bsbd\b/, null]]
  );

  // a composition with a boundary agent (hybrid): the top env wires the blocks'
  // envs; `analysis.coverage` and a single-stream scoreboard are refused there
  const blocks = {
    "producer.quickuvm.yaml": [
      "project: {name: producer}",
      'dut: {name: producer, clock: clk, reset: "", combinational: true}',
      "agents:",
      "  - name: prod_agent",
      "    interface: prod_if",
      "    sequence_item: prod_item",
      "    ports:",
      "      inputs: [{name: pin, width: 8}]",
      "      outputs: [{name: dout, width: 8, randomize: false}]",
      "",
    ].join("\n"),
    "consumer.quickuvm.yaml": [
      "project: {name: consumer}",
      'dut: {name: consumer, clock: clk, reset: "", combinational: true}',
      "agents:",
      "  - name: cons_agent",
      "    interface: cons_if",
      "    sequence_item: cons_item",
      "    active: false",
      "    ports:",
      "      inputs: [{name: din, width: 8}]",
      "      outputs: [{name: cout, width: 8, randomize: false}]",
      "",
    ].join("\n"),
  };
  let hyb = ops.setDut(ops.newConfigText("sys_top"), {
    module: "sys_top", clock: "clk", reset: null, resetActiveLow: false, combinational: true,
  });
  hyb = ops.createSubenvs(hyb, [
    { name: "p1", config: "producer.quickuvm.yaml", params: {} },
    { name: "c1", config: "consumer.quickuvm.yaml", params: {} },
  ]);
  hyb = ops.addConnections(hyb, [{ from: "p1.dout", to: "c1.din" }]);
  hyb = ops.createAgent(hyb, { name: "topcmd", inputs: [{ name: "z", width: 8 }], outputs: [] });
  const xsb = { name: "xsb", source: "p1.prod_agent", monitor: "c1.cons_agent" };
  shapeLock(
    "hybrid composition", hyb, blocks,
    { kind: "scoreboard", source: "p1.prod_agent" },
    (t) => ops.addScoreboard(t, xsb),
    (t, plan) => ops.addScoreboardKeeping(t, xsb, plan),
    /subenvs/,
    [
      ["the scoreboard sbd in the top env", /\bsbd\b/, /^sys_top_env\.svh$/],
      ["a collector on the boundary agent", /topcmd_cov/, /^sys_top_env\.svh$/],
    ]
  );
  // a selftest is NOT fenced: it really generates the inferred scoreboard
  const selftest = ops.setBenchField(ops.setBenchField(base, "layout", "packaged"), "kind", "selftest");
  assert.equal(R.inferenceIsReal(ops.parseQuvm(selftest)), true);
  const stGen = tryGen(selftest);
  assert.equal(stGen.status, 0, `the selftest does not generate:\n${stGen.out.slice(-400)}`);
  assert.ok(generated(stGen, /\bsbd\b/).some((f) => /_env\.svh$/.test(f)), "a selftest no longer generates sbd: it should be fenced too");
  console.log(
    "  ok    where the implicit pair is not generated (replicas, vip, hybrid): fenced — the plain gesture generates, the pair declared is refused; " +
      (overReporting.length
        ? `this quick-uvm still over-reports ${overReporting.join(", ")} (QuickUVM#121)`
        : "this quick-uvm reports nothing inferred there (QuickUVM#121 fixed)")
  );
}

console.log("the end-to-end flow (yamlops -> quick-uvm generate) is green");
