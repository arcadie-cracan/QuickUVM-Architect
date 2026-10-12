// Node tests for the keyboard-navigation helpers (src/webview/navfind.ts —
// docs/08 R5): the view history behind Ctrl+[ / ], the Ctrl+F ranking, the
// "up one level" rules and the fit-selection bounds.
//   npm run test:navfind
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-navfind-"));
const outFile = join(outDir, "navfind.mjs");
await esbuild.build({
  entryPoints: ["src/webview/navfind.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const {
  NavHistory,
  QuickMarks,
  findMatches,
  rtlParentPath,
  tbParentFocus,
  unionBounds,
} = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const E = (viewId, mode = "schematic", focus = "") => ({ mode, viewId, focus });

test("history: a re-render of the same view records nothing", () => {
  const h = new NavHistory();
  h.visit(E("demo_top"));
  h.visit(E("demo_top"));
  h.visit(E("demo_top"));
  assert.equal(h.canBack, false, "one entry, nothing to go back to");
  assert.deepEqual(h.current, E("demo_top"));
});

test("history: back and forward walk the entries; the TB level is part of the identity", () => {
  const h = new NavHistory();
  h.visit(E("demo_top"));
  h.visit(E("demo_top.u_soc"));
  h.visit(E("tb:x.yaml", "tb", ""));
  h.visit(E("tb:x.yaml", "tb", "env"));
  assert.deepEqual(h.back(), E("tb:x.yaml", "tb", ""));
  assert.deepEqual(h.back(), E("demo_top.u_soc"));
  assert.deepEqual(h.forward(), E("tb:x.yaml", "tb", ""));
  assert.deepEqual(h.forward(), E("tb:x.yaml", "tb", "env"));
  assert.equal(h.forward(), null, "at the end: no-op");
});

test("history: a new visit after going back drops the forward branch (browser rule)", () => {
  const h = new NavHistory();
  h.visit(E("a"));
  h.visit(E("b"));
  h.visit(E("c"));
  h.back();
  h.back();
  h.visit(E("d"));
  assert.equal(h.canForward, false);
  assert.deepEqual(h.back(), E("a"));
  assert.deepEqual(h.forward(), E("d"));
});

test("history: bounded — the oldest entry falls off", () => {
  const h = new NavHistory(3);
  for (const v of ["a", "b", "c", "d"]) {
    h.visit(E(v));
  }
  h.back();
  h.back();
  assert.deepEqual(h.current, E("b"), "a was dropped");
  assert.equal(h.back(), null);
});

const ITEMS = [
  { id: "u_add", label: "u_add" },
  { id: "g_ch[0..2].u_ch", label: "g_ch[0..2].u_ch" },
  { id: "<port>.ch_out", label: "ch_out" },
  { id: "agent:cmd", label: "cmd" },
  { id: "sb:sbd", label: "sbd" },
  { id: "cov:cmd", label: "cmd_cov" },
];

test("find: exact beats prefix beats word-start beats substring; stable otherwise", () => {
  assert.deepEqual(
    findMatches(ITEMS, "cmd").map((i) => i.id),
    ["agent:cmd", "cov:cmd"],
    "exact label first, then the prefix"
  );
  assert.deepEqual(
    findMatches(ITEMS, "ch").map((i) => i.id),
    ["<port>.ch_out", "g_ch[0..2].u_ch"],
    "prefix of a label beats a word-start inside another"
  );
  assert.deepEqual(findMatches(ITEMS, "add").map((i) => i.id), ["u_add"], "word-start after _");
  assert.deepEqual(findMatches(ITEMS, "port").map((i) => i.id), ["<port>.ch_out"], "the id matches too");
});

test("find: case-insensitive, trimmed, empty matches nothing, limit respected", () => {
  assert.equal(findMatches(ITEMS, "  CMD ").length, 2);
  assert.deepEqual(findMatches(ITEMS, ""), []);
  assert.deepEqual(findMatches(ITEMS, "   "), []);
  assert.equal(findMatches(ITEMS, "c", 2).length, 2);
  assert.deepEqual(findMatches(ITEMS, "[0"), [ITEMS[1]], "regex metacharacters are literal");
});

test("up: TB levels climb agent -> env -> root -> nothing", () => {
  assert.equal(tbParentFocus("agent:cmd"), "env");
  assert.equal(tbParentFocus("env"), "");
  assert.equal(tbParentFocus(""), null);
});

test("up: the RTL parent skips generate blocks and stops at the top", () => {
  const inst = new Set(["demo_top", "demo_top.u_soc", "demo_top.u_soc.g_ch[1].u_ch"]);
  const is = (p) => inst.has(p);
  assert.equal(rtlParentPath("demo_top.u_soc.g_ch[1].u_ch", is), "demo_top.u_soc");
  assert.equal(rtlParentPath("demo_top.u_soc", is), "demo_top");
  assert.equal(rtlParentPath("demo_top", is), null);
});

test("fit selection: the union of rectangles, null for an empty selection", () => {
  assert.equal(unionBounds([]), null);
  assert.deepEqual(
    unionBounds([
      { x: 10, y: 20, w: 30, h: 10 },
      { x: -5, y: 25, w: 10, h: 40 },
    ]),
    { x: -5, y: 20, w: 45, h: 45 }
  );
});

test("quick marks: per layout key, copies in and out, empty slot = null", () => {
  const m = new QuickMarks();
  const cam = { tx: 1, ty: 2, k: 1.5 };
  m.set("tb:x|env", 1, cam);
  cam.tx = 99;
  assert.deepEqual(m.get("tb:x|env", 1), { tx: 1, ty: 2, k: 1.5 }, "stored by value");
  assert.equal(m.get("tb:x|env", 2), null);
  assert.equal(m.get("tb:x|", 1), null, "another level, another slot set");
});

console.log(`\ntest-navfind: ${passed} tests passed.`);
