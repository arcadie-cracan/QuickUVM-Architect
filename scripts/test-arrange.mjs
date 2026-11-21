// Node tests for the selection / arrangement geometry (src/webview/arrange.ts —
// docs/08 R7): the marquee's modifiers and inclusion rules, align, distribute,
// and straighten (the wires between the selected blocks made straight).
//   npm run test:arrange
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-arrange-"));
const outFile = join(outDir, "arrange.mjs");
await esbuild.build({
  entryPoints: ["src/webview/arrange.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const {
  alignItems,
  distributeItems,
  hasLinks,
  lassoHits,
  lassoRule,
  marqueeOp,
  marqueeSelection,
  straightenItems,
} = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}
const ids = (s) => [...s].sort().join(",");

// ------------------------------------------------------------- the marquee

test("marquee: plain replaces, Shift adds, Ctrl toggles, Ctrl+Shift subtracts — Alt is never read", () => {
  assert.equal(marqueeOp({}), "replace");
  assert.equal(marqueeOp({ shift: true }), "add");
  assert.equal(marqueeOp({ ctrl: true }), "toggle");
  assert.equal(marqueeOp({ shift: true, ctrl: true }), "subtract");
  // Alt alone around a mouse gesture hands the focus to the workbench menu bar
  // (Windows/Linux): it must not be a lasso modifier, alone or combined
  assert.equal(marqueeOp({ alt: true }), "replace");
  assert.equal(marqueeOp({ alt: true, shift: true }), "add");
  assert.equal(marqueeOp({ alt: true, ctrl: true }), "toggle");
});

test("marquee: the result of each operation over a frozen base", () => {
  const base = new Set(["a", "b"]);
  const hits = ["b", "c"];
  assert.equal(ids(marqueeSelection(base, hits, "replace")), "b,c", "the base is dropped");
  assert.equal(ids(marqueeSelection(base, hits, "add")), "a,b,c", "never removes");
  assert.equal(ids(marqueeSelection(base, hits, "subtract")), "a", "never adds");
  assert.equal(ids(marqueeSelection(base, hits, "toggle")), "a,c", "b leaves, c joins");
  assert.equal(ids(base), "a,b", "the base itself is never mutated");
});

test("marquee: sweeping back off an element restores it (the base is frozen)", () => {
  const base = new Set(["a"]);
  // frame 1: the rectangle covers `a`; frame 2: it no longer does
  assert.equal(ids(marqueeSelection(base, ["a"], "toggle")), "");
  assert.equal(ids(marqueeSelection(base, [], "toggle")), "a");
  assert.equal(ids(marqueeSelection(base, ["a"], "subtract")), "");
  assert.equal(ids(marqueeSelection(base, [], "subtract")), "a");
  // an empty lasso with a modifier leaves the selection alone; a plain one clears
  assert.equal(ids(marqueeSelection(base, [], "add")), "a");
  assert.equal(ids(marqueeSelection(base, [], "replace")), "");
});

test("lasso: window picks the fully enclosed, crossing also the touched", () => {
  const rect = { left: 0, top: 0, right: 100, bottom: 100 };
  const c = [
    { id: "inside", r: { left: 10, top: 10, right: 50, bottom: 50 } },
    { id: "straddles", r: { left: 80, top: 10, right: 140, bottom: 50 } },
    { id: "outside", r: { left: 200, top: 10, right: 240, bottom: 50 } },
    { id: "edge", r: { left: 100, top: 10, right: 140, bottom: 50 } }, // shares only the border
    { id: "exact", r: { left: 0, top: 0, right: 100, bottom: 100 } },
  ];
  assert.deepEqual(lassoHits(rect, c, "contain"), ["inside", "exact"]);
  assert.deepEqual(lassoHits(rect, c, "intersect"), ["inside", "straddles", "exact"],
    "a shared border is not a touch");
});

test("lasso: the direction mode follows the drag (left-to-right window, right-to-left crossing)", () => {
  assert.equal(lassoRule("contain", -50), "contain", "the fixed modes ignore the direction");
  assert.equal(lassoRule("intersect", 50), "intersect");
  assert.equal(lassoRule("direction", 50), "contain");
  assert.equal(lassoRule("direction", 0), "contain", "a vertical drag is a window");
  assert.equal(lassoRule("direction", -1), "intersect");
});

// ------------------------------------------------------ align / distribute

const A = { id: "a", x: 0, y: 0, w: 80, h: 40 };
const B = { id: "b", x: 200, y: 96, w: 120, h: 64 };
const C = { id: "c", x: 96, y: 240, w: 40, h: 24 };

test("align: one edge of the common bounding box, the other axis untouched", () => {
  assert.deepEqual(alignItems([A, B, C], "left"), { b: { x: 0, y: 96 }, c: { x: 0, y: 240 } });
  assert.deepEqual(alignItems([A, B, C], "right"), { a: { x: 240, y: 0 }, c: { x: 280, y: 240 } });
  assert.deepEqual(alignItems([A, B, C], "top"), { b: { x: 200, y: 0 }, c: { x: 96, y: 0 } });
  assert.deepEqual(alignItems([A, B, C], "bottom"), { a: { x: 0, y: 224 }, b: { x: 200, y: 200 } });
});

test("align: the centre lines, pinned to the largest item on the grid", () => {
  // the box is x 0..320 (centre 160), y 0..264 (centre 132). The widest item
  // (b, 120) is put on the grid first: 160 - 60 = 100 -> 104, so the line is
  // 164, and the others are snapped against THAT line
  assert.deepEqual(alignItems([A, B, C], "hcenter"), {
    a: { x: 128, y: 0 }, b: { x: 104, y: 96 }, c: { x: 144, y: 240 },
  }, "centres on one vertical line");
  // the tallest (b, 64): 132 - 32 = 100 -> 104, line 136
  const v = alignItems([A, B, C], "vcenter");
  assert.deepEqual(v, { a: { x: 0, y: 120 }, b: { x: 200, y: 104 }, c: { x: 96, y: 128 } });
  for (const p of Object.values(v)) {
    assert.equal(p.y % 8, 0, "on the grid");
  }
});

test("align: every operation is idempotent — a second run has nothing to move", () => {
  // the review's case: heights 104 / 136 / 64, where the raw bounding-box line
  // moved between two runs and the third block shifted again
  const reviewCase = [
    { id: "p", x: 0, y: 136, w: 96, h: 104 },
    { id: "q", x: 200, y: 64, w: 96, h: 136 },
    { id: "r", x: 400, y: 352, w: 96, h: 64 },
  ];
  const apply = (items, moved) => items.map((i) => (moved[i.id] ? { ...i, ...moved[i.id] } : i));
  assert.deepEqual(alignItems(apply(reviewCase, alignItems(reviewCase, "vcenter")), "vcenter"), {});
  // and in general, on-grid boxes of any size: a deterministic pseudo-random sweep
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 400; round++) {
    const items = Array.from({ length: 2 + rnd(5) }, (_, k) => ({
      id: "n" + k,
      x: 8 * rnd(100),
      y: 8 * rnd(100),
      w: 8 * (2 + rnd(30)),
      h: 8 * (2 + rnd(30)),
    }));
    for (const op of ["left", "right", "top", "bottom", "hcenter", "vcenter"]) {
      const once = apply(items, alignItems(items, op));
      assert.deepEqual(alignItems(once, op), {}, op + " twice, round " + round + ": " + JSON.stringify(items));
    }
  }
  // off-grid widths (a flag's measured text) settle in one run too
  const odd = [
    { id: "a", x: 0, y: 0, w: 93, h: 16 },
    { id: "b", x: 300, y: 80, w: 61, h: 16 },
    { id: "c", x: 120, y: 200, w: 128, h: 104 },
  ];
  assert.deepEqual(alignItems(apply(odd, alignItems(odd, "hcenter")), "hcenter"), {});
});

test("align: returns only what moves; one item aligns to nothing", () => {
  assert.deepEqual(alignItems([A], "left"), {});
  assert.deepEqual(alignItems([], "left"), {});
  const twins = [A, { ...A, id: "a2", y: 100 }];
  assert.deepEqual(alignItems(twins, "left"), {}, "already aligned: an empty result, no snapshot");
});

test("distribute: equal gaps between neighbours, the outermost stay", () => {
  const items = [
    { id: "l", x: 0, y: 0, w: 40, h: 40 },
    { id: "m1", x: 48, y: 8, w: 40, h: 40 },
    { id: "m2", x: 104, y: 16, w: 40, h: 40 },
    { id: "r", x: 360, y: 0, w: 40, h: 40 },
  ];
  // span 0..400, sizes 160, gap 80: 0, 120, 240, 360
  assert.deepEqual(distributeItems(items, "h"), {
    m1: { x: 120, y: 8 }, m2: { x: 240, y: 16 },
  }, "y untouched, ends untouched");
  const spaced = items.map((i) => (i.id === "m1" ? { ...i, x: 120 } : i.id === "m2" ? { ...i, x: 240 } : i));
  assert.deepEqual(distributeItems(spaced, "h"), {}, "a second run has nothing to move");
  // vertically the same rule on the other axis
  const col = items.map((i) => ({ ...i, x: i.y, y: i.x }));
  assert.deepEqual(distributeItems(col, "v"), {
    m1: { x: 8, y: 120 }, m2: { x: 16, y: 240 },
  });
});

test("distribute: needs three; the selection's order does not matter; a spanning box is a no-op", () => {
  const l = { id: "l", x: 0, y: 0, w: 40, h: 40 };
  const m = { id: "m", x: 48, y: 0, w: 40, h: 40 };
  const r = { id: "r", x: 360, y: 0, w: 40, h: 40 };
  assert.deepEqual(distributeItems([l, r], "h"), {});
  assert.deepEqual(distributeItems([r, m, l], "h"), distributeItems([l, m, r], "h"));
  assert.deepEqual(distributeItems([l, m, r], "h"), { m: { x: 184, y: 0 } });
  // one box spans the others: there is no row to space out
  const wide = { id: "w", x: 0, y: 0, w: 1000, h: 40 };
  assert.deepEqual(distributeItems([wide, m, r], "h"), {});
});

test("distribute: the last item is the one whose FAR edge is last, not the one that starts last", () => {
  // `w` starts second but ends last (400); `m` starts last but ends at 160.
  // The row is s, m, w: s and w stay, m goes between them
  const s = { id: "s", x: 0, y: 0, w: 40, h: 40 };
  const w = { id: "w", x: 100, y: 0, w: 300, h: 40 };
  const m = { id: "m", x: 120, y: 0, w: 40, h: 40 };
  const out = distributeItems([s, w, m], "h");
  // span 0..400, sizes 380, gap 10: m at 40 + 10 = 50 -> 48
  assert.deepEqual(out, { m: { x: 48, y: 0 } }, "the outermost stay");
});

test("distribute: items that do not fit in the span (they overlap) are left alone", () => {
  // the review's case: an "equal overlap" pushed the third item past the last
  // one's far edge — the outermost did not stay outermost, and a second run
  // moved different items. There is no even spacing to give: nothing moves
  const col = [
    { id: "a", x: 0, y: 208, w: 80, h: 112 },
    { id: "b", x: 0, y: 248, w: 80, h: 176 },
    { id: "c", x: 0, y: 288, w: 80, h: 152 },
    { id: "d", x: 0, y: 408, w: 80, h: 56 },
  ];
  assert.deepEqual(distributeItems(col, "v"), {});
  // a wide box over the others is the same refusal
  const s = { id: "s", x: 0, y: 0, w: 40, h: 40 };
  const w = { id: "w", x: 8, y: 0, w: 392, h: 40 };
  const m = { id: "m", x: 16, y: 0, w: 40, h: 40 };
  assert.deepEqual(distributeItems([s, w, m], "h"), {});
  // exactly touching (gap 0) is still a distribution
  const t = [
    { id: "a", x: 0, y: 0, w: 40, h: 40 },
    { id: "b", x: 8, y: 0, w: 40, h: 40 },
    { id: "c", x: 80, y: 0, w: 40, h: 40 },
  ];
  assert.deepEqual(distributeItems(t, "h"), { b: { x: 40, y: 0 } });
});

// ---------------------------------------------------------------- straighten

test("straighten: the wired item moves until the two pin centres share a y", () => {
  const src = { id: "src", x: 0, y: 0, w: 80, h: 80 };
  const dst = { id: "dst", x: 200, y: 56, w: 80, h: 80 };
  // src's pin at y=40 (abs 40), dst's pin at y=64 (abs 120)
  const links = [{ a: "src", ay: 40, b: "dst", by: 64 }];
  assert.deepEqual(straightenItems([src, dst], links), { dst: { x: 200, y: -24 } },
    "the leftmost stays; 0 + 40 === -24 + 64");
  assert.deepEqual(straightenItems([src, dst], links, "dst"), { src: { x: 0, y: 80 } },
    "the anchor stays instead; 80 + 40 === 56 + 64");
});

test("straighten: a chain propagates, each item placed against the one before", () => {
  const a = { id: "a", x: 0, y: 0, w: 80, h: 80 };
  const b = { id: "b", x: 200, y: 100, w: 80, h: 80 };
  const c = { id: "c", x: 400, y: 300, w: 80, h: 80 };
  const links = [
    { a: "a", ay: 40, b: "b", by: 16 },
    { a: "b", ay: 64, b: "c", by: 40 },
  ];
  // b.y = 0 + 40 - 16 = 24; c.y = 24 + 64 - 40 = 48
  assert.deepEqual(straightenItems([a, b, c], links), {
    b: { x: 200, y: 24 }, c: { x: 400, y: 48 },
  });
  // the selection's order does not change the result
  assert.deepEqual(straightenItems([c, a, b], links), straightenItems([a, b, c], links));
});

test("straighten: only the selected move; a wire leaving the selection is ignored", () => {
  const a = { id: "a", x: 0, y: 0, w: 80, h: 80 };
  const b = { id: "b", x: 200, y: 100, w: 80, h: 80 };
  const links = [
    { a: "a", ay: 40, b: "outside", by: 0 },
    { a: "a", ay: 40, b: "a", by: 16 }, // a self-loop
  ];
  assert.deepEqual(straightenItems([a, b], links), {});
  assert.equal(hasLinks([a, b], links), false, "nothing to offer");
  assert.equal(hasLinks([a, b], [{ a: "b", ay: 0, b: "a", by: 0 }]), true);
});

test("straighten: two wires between the same blocks — the first in scene order is the straight one", () => {
  const a = { id: "a", x: 0, y: 0, w: 80, h: 120 };
  const b = { id: "b", x: 200, y: 200, w: 80, h: 120 };
  const links = [
    { a: "a", ay: 40, b: "b", by: 88 },
    { a: "a", ay: 64, b: "b", by: 40 },
  ];
  assert.deepEqual(straightenItems([a, b], links), { b: { x: 200, y: -48 } }, "0 + 40 - 88");
});

test("straighten: separate groups each keep their own leftmost; a cycle terminates", () => {
  const a = { id: "a", x: 0, y: 0, w: 80, h: 80 };
  const b = { id: "b", x: 200, y: 96, w: 80, h: 80 };
  const c = { id: "c", x: 0, y: 400, w: 80, h: 80 };
  const d = { id: "d", x: 200, y: 304, w: 80, h: 80 };
  const lone = { id: "lone", x: 96, y: 800, w: 80, h: 80 };
  const links = [
    { a: "a", ay: 40, b: "b", by: 40 },
    { a: "c", ay: 40, b: "d", by: 40 },
    { a: "b", ay: 16, b: "a", by: 16 }, // back edge: a is already placed
  ];
  assert.deepEqual(straightenItems([a, b, c, d, lone], links, "a"), {
    b: { x: 200, y: 0 }, d: { x: 200, y: 400 },
  }, "the group not wired to the anchor keeps ITS leftmost; the unwired item stays");
});

test("straighten: a move that would land on another box is refused — the item stays", () => {
  // two agents in one column feed one scoreboard: its two pins are 24px apart,
  // the agents 120px tall — both wires cannot be straight without stacking them
  const cmd = { id: "cmd", x: 168, y: 96, w: 112, h: 120 };
  const rsp = { id: "rsp", x: 176, y: 296, w: 112, h: 120 };
  const sbd = { id: "sbd", x: 408, y: 296, w: 96, h: 80 };
  const links = [
    { a: "cmd", ay: 40, b: "sbd", by: 24 },
    { a: "rsp", ay: 40, b: "sbd", by: 48 },
  ];
  // sbd aligns to cmd (96 + 40 - 24 = 112); rsp would need 112 + 48 - 40 = 120,
  // ON cmd (96..216) — refused, it stays at 296
  assert.deepEqual(straightenItems([cmd, rsp, sbd], links, "cmd"), { sbd: { x: 408, y: 112 } });
  // a box OUTSIDE the selection blocks a move the same way
  const wall = { id: "wall", x: 400, y: 100, w: 120, h: 60 };
  assert.deepEqual(
    straightenItems([cmd, sbd], [links[0]], "cmd", 8, [cmd, sbd, wall]),
    {},
    "sbd would land on `wall`: nothing moves"
  );
  // ...and one grid step of air is part of the rule: touching is refused too
  const near = { id: "near", x: 408, y: 112 + 80 + 4, w: 96, h: 40 };
  assert.deepEqual(straightenItems([cmd, sbd], [links[0]], "cmd", 8, [near]), {});
  const clear = { ...near, y: 112 + 80 + 8 };
  assert.deepEqual(straightenItems([cmd, sbd], [links[0]], "cmd", 8, [clear]), {
    sbd: { x: 408, y: 112 },
  });
});

test("straighten: already straight is an empty result (no snapshot, no undo entry)", () => {
  const a = { id: "a", x: 0, y: 0, w: 80, h: 80 };
  const b = { id: "b", x: 200, y: 24, w: 80, h: 80 };
  assert.deepEqual(straightenItems([a, b], [{ a: "a", ay: 40, b: "b", by: 16 }]), {});
});

console.log(`\ntest-arrange: ${passed} tests passed.`);
