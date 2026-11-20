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

const { rankPalette, pushRecent } = await import(pathToFileURL(outFile));
test("docs/08 R17: the palette lists the recent actions first, then the rest in order; a query ranks instead", () => {
  const items = [
    { id: "View|Fit to window (F)", label: "Fit to window (F)" },
    { id: "Selection|Delete agent…", label: "Delete agent…" },
    { id: "Config|Generate testbench", label: "Generate testbench" },
    { id: "Selection|Rename… (F2)", label: "Rename… (F2)" },
  ];
  assert.deepEqual(rankPalette(items, [], "").map((i) => i.id), items.map((i) => i.id), "no recent: the offered order");
  const recent = pushRecent(pushRecent([], "Config|Generate testbench"), "Selection|Rename… (F2)");
  assert.deepEqual(recent, ["Selection|Rename… (F2)", "Config|Generate testbench"], "newest first");
  assert.deepEqual(rankPalette(items, [...recent, "gone|not offered any more"], "").map((i) => i.id), [
    "Selection|Rename… (F2)", "Config|Generate testbench", "View|Fit to window (F)", "Selection|Delete agent…",
  ], "recent first (only those offered), then the rest");
  assert.deepEqual(rankPalette(items, recent, "generate").map((i) => i.id), ["Config|Generate testbench"], "a query ranks, recency is ignored");
  assert.deepEqual(rankPalette(items, recent, "gen").map((i) => i.id), ["Config|Generate testbench", "Selection|Delete agent…"], "prefix before substring (a-GEN-t)");
  assert.deepEqual(rankPalette(items, recent, "", 2).length, 2, "capped");
  assert.equal(pushRecent(["a", "b", "c"], "b").join(","), "b,a,c", "re-running moves to the front, no duplicates");
  assert.equal(pushRecent(["1", "2", "3", "4", "5", "6", "7", "8"], "9").length, 8, "capped at 8");
});

const { lodFor, titleUpscale, LOD_HYSTERESIS, LOD_TITLE_MAX } = await import(pathToFileURL(outFile));
test("docs/08 R6: the level of detail drops below the threshold and returns only past the hysteresis band", () => {
  assert.equal(lodFor(1, "full", 0.5), "full");
  assert.equal(lodFor(0.5, "full", 0.5), "full", "AT the threshold is still full detail");
  assert.equal(lodFor(0.49, "full", 0.5), "low");
  // a wheel hovering around the threshold must not flicker the labels
  assert.equal(lodFor(0.5, "low", 0.5), "low", "back at the threshold: still the overview");
  assert.equal(lodFor(0.55, "low", 0.5), "low", "inside the band");
  assert.equal(lodFor(0.5 * LOD_HYSTERESIS, "low", 0.5), "full", "the band's upper edge returns");
  assert.equal(lodFor(0.6, "low", 0.5), "full");
  // walked down and up, the level changes exactly twice
  let lod = "full";
  let changes = 0;
  for (const k of [0.6, 0.52, 0.49, 0.51, 0.49, 0.53, 0.57, 0.58, 0.56]) {
    const next = lodFor(k, lod, 0.5);
    changes += next === lod ? 0 : 1;
    lod = next;
  }
  assert.equal(changes, 2, "one drop, one return — no flicker in between");
});

test("docs/08 R6: a threshold of 0 (or a non-number) switches the overview level off", () => {
  for (const t of [0, -1, NaN, Infinity, undefined]) {
    assert.equal(lodFor(0.2, "full", t), "full", `threshold ${t}`);
    assert.equal(lodFor(0.2, "low", t), "full", `threshold ${t} also LEAVES the overview`);
  }
});

test("docs/08 R6: an overview title fills its box, is capped, and never shrinks", () => {
  // a 60x14 title at the top of a 160x120 box: width allows 2.4, height 8, cap 3
  const a = titleUpscale({ y: 4, w: 60, h: 14 }, { w: 160, h: 120 });
  assert.equal(a.scale, 2.4);
  assert.equal(a.dy, 60 - 11, "moved to the box's vertical centre");
  // a short title in a big box stops at the cap
  assert.equal(titleUpscale({ y: 4, w: 20, h: 14 }, { w: 400, h: 300 }).scale, LOD_TITLE_MAX);
  // a flat box (a collapsed header): the HEIGHT limits it
  const flat = titleUpscale({ y: 4, w: 40, h: 14 }, { w: 200, h: 32 });
  assert.equal(flat.scale, 1.71, "(32 - 8) / 14, floored to 2 decimals — never past the box");
  assert.ok(flat.scale * 14 <= 32 - 8);
  // a title already wider than its box is left exactly where it is drawn
  assert.deepEqual(titleUpscale({ y: 4, w: 200, h: 14 }, { w: 120, h: 80 }), { scale: 1, dy: 0 });
  // an unmeasurable title (not rendered yet) is left alone too
  assert.deepEqual(titleUpscale({ y: 0, w: 0, h: 0 }, { w: 120, h: 80 }), { scale: 1, dy: 0 });
});

console.log(`\ntest-navfind: ${passed} tests passed.`);
