// Node tests for the matrix editor's model (src/webview/matrix.ts — docs/08
// R22): agents x scoreboards / coverage, and block outputs x block inputs on a
// composition. Each cell is checked for its state, its legality and the host
// action a click sends.
//   npm run test:matrix
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-matrix-"));
const outFile = join(outDir, "matrix.mjs");
await esbuild.build({
  entryPoints: ["src/webview/matrix.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { analysisMatrix, connectionsMatrix, worthOffering } = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}
/** the cell at (row id, column id) */
const at = (m, row, col) =>
  m.cells[m.rows.findIndex((r) => r.id === row)][m.cols.findIndex((c) => c.id === col)];

const CFG = {
  agents: [{ name: "cmd" }, { name: "rsp" }, { name: "aux" }],
  analysis: {
    coverage: ["cmd", { agent: "aux", coverpoints: [] }],
    scoreboards: [
      { name: "sbd", source: "cmd", monitor: "rsp", match: "out_of_order", match_key: "id" },
      { name: "single", source: "aux" },
    ],
  },
};

test("analysis: one row per agent, source + monitor per scoreboard, a coverage column", () => {
  const m = analysisMatrix(CFG);
  assert.equal(m.kind, "analysis");
  assert.deepEqual(m.rows.map((r) => r.id), ["cmd", "rsp", "aux"]);
  assert.deepEqual(m.cols.map((c) => `${c.group}/${c.label}`), [
    "sbd/source", "sbd/monitor", "single/source", "single/monitor", "coverage/covered",
  ]);
  assert.deepEqual(
    m.cells.map((row) => row.map((c) => (c.on ? c.mark : "·")).join("")),
    ["S···●", "·M···", "··S·●"],
    "the marks say the role; a rich coverage entry counts as covered"
  );
});

test("analysis: a source is moved, never cleared; a monitor is set and cleared; the two differ", () => {
  const m = analysisMatrix(CFG);
  // the source cell that is ON cannot be clicked (a scoreboard needs a source)
  assert.ok(at(m, "cmd", "sb0.source").disabled.includes("needs a source"));
  assert.equal(at(m, "cmd", "sb0.source").click, undefined);
  // another agent's source cell moves it
  assert.deepEqual(at(m, "aux", "sb0.source").click, {
    action: "editScoreboard", args: { name: "sbd", field: "source", value: "aux" },
  });
  // ...but not onto the scoreboard's own monitor
  assert.ok(at(m, "rsp", "sb0.source").disabled.includes("already this scoreboard's monitor"));
  // the monitor cell that is ON clears it (value ""), and says what goes with it
  assert.deepEqual(at(m, "rsp", "sb0.monitor").click, {
    action: "editScoreboard", args: { name: "sbd", field: "monitor", value: "" },
  });
  assert.ok(at(m, "rsp", "sb0.monitor").title.includes("match and match_key go too"));
  // the source cannot also be the monitor
  assert.ok(at(m, "cmd", "sb0.monitor").disabled.includes("already this scoreboard's source"));
  // a single-stream scoreboard gets a monitor with one click
  assert.deepEqual(at(m, "cmd", "sb1.monitor").click, {
    action: "editScoreboard", args: { name: "single", field: "monitor", value: "cmd" },
  });
});

test("analysis: the coverage column adds and removes through the existing actions", () => {
  const m = analysisMatrix(CFG);
  assert.deepEqual(at(m, "rsp", "coverage").click, { action: "addCoverage", args: { agent: "rsp" } });
  assert.deepEqual(at(m, "cmd", "coverage").click, {
    action: "deleteComponent", args: { kind: "coverage", name: "cmd" },
  });
  assert.ok(at(m, "cmd", "coverage").title.includes("asks first"), "the removal keeps its confirmation");
});

test("analysis: implicit mode is read-only, and says why", () => {
  for (const cfg of [{ agents: [{ name: "cmd" }] }, { agents: [{ name: "cmd" }], analysis: null }]) {
    const m = analysisMatrix(cfg);
    assert.ok(m.note.includes("implicit mode"));
    assert.ok(m.cells.flat().every((c) => c.disabled && !c.click), "no cell can switch the mode by accident");
  }
  // `analysis: {}` IS declared mode: empty, and editable
  const d = analysisMatrix({ agents: [{ name: "cmd" }], analysis: {} });
  assert.equal(d.note, undefined);
  assert.deepEqual(at(d, "cmd", "coverage").click, { action: "addCoverage", args: { agent: "cmd" } });
});

test("analysis: an unnamed or duplicate-named scoreboard is shown, not editable", () => {
  const m = analysisMatrix({
    agents: [{ name: "a" }, { name: "b" }],
    analysis: { scoreboards: [{ source: "a" }, { name: "x", source: "a" }, { name: "x", source: "b" }] },
  });
  assert.equal(at(m, "a", "sb0.source").on, true, "still drawn");
  assert.ok(at(m, "b", "sb0.source").disabled.includes("name the scoreboard first"));
  assert.ok(at(m, "b", "sb1.source").disabled.includes("another scoreboard has this name"));
  assert.ok(at(m, "a", "sb2.monitor").disabled.includes("another scoreboard has this name"));
  assert.equal(m.cols[0].group, "scoreboard 1", "an unnamed one is labelled by its position");
});

test("analysis: a composition adds the children's agents as rows; their coverage is not this file's", () => {
  const m = analysisMatrix(
    { agents: [{ name: "edge" }], subenvs: [{ name: "ch0" }], analysis: { scoreboards: [{ name: "x", source: "edge" }] } },
    { ch0: ["chan_a"] }
  );
  assert.deepEqual(m.rows.map((r) => [r.id, r.group]), [["edge", ""], ["ch0.chan_a", "ch0"]]);
  assert.deepEqual(at(m, "ch0.chan_a", "sb0.monitor").click, {
    action: "editScoreboard", args: { name: "x", field: "monitor", value: "ch0.chan_a" },
  }, "a cross-block endpoint is a qualified name");
  assert.ok(at(m, "ch0.chan_a", "coverage").disabled.includes("its own configuration"));
});

test("analysis: no agents, no matrix; malformed sections do not throw", () => {
  assert.equal(analysisMatrix(null), null);
  assert.equal(analysisMatrix({}), null);
  assert.equal(analysisMatrix({ agents: [] }), null);
  const m = analysisMatrix({ agents: [{ name: "a" }, null], analysis: { scoreboards: [null, { name: "s", source: "a" }], coverage: "x" } });
  assert.deepEqual(m.rows.map((r) => r.id), ["a"]);
  assert.equal(m.cols.length, 3);
});

// ------------------------------------------------------------- connections
const TOP = {
  subenvs: [{ name: "ch0" }, { name: "u_add" }, { name: "u_inv" }],
  connections: [{ from: "ch0.dout", to: "u_add.b" }],
};
const CHILDREN = {
  ch0: { agents: [{ name: "chan_a", ports: { inputs: [{ name: "din", width: 16 }], outputs: [{ name: "dout", width: 16 }] } }] },
  u_add: { agents: [{ name: "add_a", ports: { inputs: [{ name: "a", width: 16 }, { name: "b", width: 16 }, { name: "cin" }], outputs: [{ name: "s", width: 16 }] } }] },
  u_inv: { agents: [{ name: "inv_a", ports: { inputs: [{ name: "x", width: 8 }, { name: "p", width_param: "W" }], outputs: [{ name: "y", width: 8 }] } }] },
};

test("connections: rows are block outputs, columns block inputs; an entry is an ON cell that removes it", () => {
  const m = connectionsMatrix(TOP, CHILDREN);
  assert.equal(m.kind, "connections");
  assert.deepEqual(m.rows.map((r) => r.id), ["ch0.dout", "u_add.s", "u_inv.y"]);
  assert.deepEqual(m.cols.map((c) => c.id), ["ch0.din", "u_add.a", "u_add.b", "u_add.cin", "u_inv.x", "u_inv.p"]);
  const on = at(m, "ch0.dout", "u_add.b");
  assert.equal(on.on, true);
  assert.deepEqual(on.click, { action: "removeConnection", args: { from: "ch0.dout", to: "u_add.b" } });
});

test("connections: the generator's refusals are the disabled cells", () => {
  const m = connectionsMatrix(TOP, CHILDREN);
  assert.ok(at(m, "ch0.dout", "ch0.din").disabled.includes("same block"));
  assert.ok(at(m, "u_inv.y", "u_add.b").disabled.includes("already driven by ch0.dout"), "one driver per input");
  assert.ok(at(m, "u_inv.y", "u_add.a").disabled.includes("width 8 ≠ 16"));
  assert.ok(at(m, "u_add.s", "u_add.cin").disabled.includes("same block"));
  // legal: equal widths, free input
  assert.deepEqual(at(m, "ch0.dout", "u_add.a").click, {
    action: "addConnection", args: { from: "ch0.dout", to: "u_add.a" },
  });
  // an UNKNOWN width (a parameter) is not a reason to refuse
  assert.deepEqual(at(m, "ch0.dout", "u_inv.p").click, {
    action: "addConnection", args: { from: "ch0.dout", to: "u_inv.p" },
  });
});

test("connections: needs two blocks; an unreadable child is named; a name composed twice is left out", () => {
  assert.equal(connectionsMatrix({ subenvs: [{ name: "a" }] }, {}), null);
  assert.equal(connectionsMatrix(null, CHILDREN), null);
  assert.equal(connectionsMatrix({ subenvs: [{ name: "x" }, { name: "y" }] }, {}), null, "no ports known at all");
  const partial = connectionsMatrix({ subenvs: [{ name: "ch0" }, { name: "u_add" }, { name: "ghost" }] }, CHILDREN);
  assert.ok(partial.note.includes("ghost"));
  assert.deepEqual(partial.rows.map((r) => r.id), ["ch0.dout", "u_add.s"]);
  const twice = connectionsMatrix({ subenvs: [{ name: "ch0" }, { name: "ch0" }, { name: "u_add" }, { name: "u_inv" }] }, CHILDREN);
  assert.ok(!twice.rows.some((r) => r.group === "ch0"), "ambiguous ids are not offered");
});

test("connections: the canonical src/dst keys are read through from/to (parseQuvm mirrors them)", () => {
  // parseQuvm mirrors src/dst into from/to, so the matrix reads ONE shape
  const m = connectionsMatrix({ ...TOP, connections: [{ src: "ch0.dout", dst: "u_add.b", from: "ch0.dout", to: "u_add.b" }] }, CHILDREN);
  assert.equal(at(m, "ch0.dout", "u_add.b").on, true);
});

test("worth offering: from about 4x4 upwards", () => {
  assert.equal(worthOffering(null), false);
  assert.equal(worthOffering(analysisMatrix(CFG)), false, "3 agents x 5 columns = 15");
  const big = analysisMatrix({ ...CFG, agents: [...CFG.agents, { name: "d" }] });
  assert.equal(worthOffering(big), true, "4 x 5 = 20");
  assert.equal(worthOffering(connectionsMatrix(TOP, CHILDREN)), true, "3 x 6 = 18");
});

console.log(`\ntest-matrix: ${passed} tests passed.`);
