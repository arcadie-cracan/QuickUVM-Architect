// Node tests for the hand-routed wires (src/webview/wireroute.ts — docs/04,
// level 3 of the routing overrides, decision D27): the skeleton anchored to the
// pins, freezing a drawn route, the grab and the drag, the jog, the validity
// that sends a route dormant, the wire groups, the file form — and the
// router's side of it (a fixed route occupies its cells first).
//   npm run test:wireroute
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-wireroute-"));
const entry = join(outDir, "entry.ts");
const src = (f) => JSON.stringify(resolve("src/webview", f));
writeFileSync(
  entry,
  `export * from ${src("wireroute.ts")};\nexport { route } from ${src("router.ts")};\n`
);
const outFile = join(outDir, "wireroute.mjs");
await esbuild.build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const {
  JOG_STUB,
  ROUTE_MAX_SEGS,
  dragWire,
  formatRoute,
  freezeRoute,
  grabWire,
  normalizeRoute,
  parseRoute,
  parseRoutes,
  placeManual,
  resolveRoute,
  route,
  routeState,
  simplifyPoly,
  wireGroup,
} = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}
const pt = (x, y) => ({ x, y });
const E = (x, y) => ({ x, y, dir: 1 });
const W = (x, y) => ({ x, y, dir: -1 });
const edge = (id, source, target, net = null, sourcePort = "o", targetPort = "i") => ({
  id, net, source, sourcePort, target, targetPort,
});
const poly = (pts) => pts.map((p) => `${p.x},${p.y}`).join(" ");
/** the drawn polyline of a route */
const drawn = (r, s, t) => poly(simplifyPoly(resolveRoute(r, s, t)));

// ------------------------------------------------------------ the file form

test("file form: one token per segment, round trip, signs explicit", () => {
  const r = parseRoute("source+40 target-24 target+0");
  assert.deepEqual(r, [
    { anchor: "source", offset: 40 },
    { anchor: "target", offset: -24 },
    { anchor: "target", offset: 0 },
  ]);
  assert.equal(formatRoute(r), "source+40 target-24 target+0");
  assert.equal(formatRoute([{ anchor: "source", offset: -0 }]), "source+0", "no negative zero");
  assert.equal(formatRoute(parseRoute("  source+8.5  ")), "source+8.5");
});

test("file form: what is not a route is null — the file is hand-editable", () => {
  for (const bad of [
    null, undefined, 5, {}, [], "", "   ",
    "source+40 target-24",          // an even count: a wire enters its pin horizontally
    "source40",                     // the sign is part of the token
    "middle+8",
    "source+1e9",
    "source+9999999",
    "source+NaN",
    "source+8 target+8 source",
    Array(ROUTE_MAX_SEGS + 2).fill("source+8").join(" "),
  ]) {
    assert.equal(parseRoute(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseRoute(Array(ROUTE_MAX_SEGS).fill("source+8").join(" ")).length, ROUTE_MAX_SEGS);
  assert.deepEqual(
    parseRoutes({ a: { route: "source+8" }, b: { route: "junk" }, c: {}, d: undefined }),
    { a: [{ anchor: "source", offset: 8 }] },
    "an entry that does not parse is skipped, never thrown on"
  );
  assert.deepEqual(parseRoutes(undefined), {});
});

// ----------------------------------------------------- resolve and freeze

test("resolve: n interior segments make n + 3 points, source stub first", () => {
  const s = E(100, 40);
  const t = W(300, 120);
  const z = parseRoute("source+60");
  assert.equal(poly(resolveRoute(z, s, t)), "100,40 160,40 160,120 300,120");
  const five = parseRoute("source+40 source+100 target-40");
  assert.equal(
    poly(resolveRoute(five, s, t)),
    "100,40 140,40 140,140 260,140 260,120 300,120"
  );
});

test("freeze: a drawn Z becomes one segment, anchored to the nearer pin", () => {
  const s = E(100, 40);
  const t = W(300, 120);
  const near = freezeRoute([pt(100, 40), pt(160, 40), pt(160, 120), pt(300, 120)], s, t);
  assert.equal(formatRoute(near), "source+60", "60 from the source, 140 from the target");
  const far = freezeRoute([pt(100, 40), pt(264, 40), pt(264, 120), pt(300, 120)], s, t);
  assert.equal(formatRoute(far), "target-36");
  const mid = freezeRoute([pt(100, 40), pt(200, 40), pt(200, 120), pt(300, 120)], s, t);
  assert.equal(formatRoute(mid), "source+100", "a tie goes to the source");
});

test("freeze: the first half follows the source, the second half the target", () => {
  const s = E(0, 0);
  const t = W(400, 80);
  const pts = [pt(0, 0), pt(40, 0), pt(40, 200), pt(360, 200), pt(360, 80), pt(400, 80)];
  const r = freezeRoute(pts, s, t);
  assert.equal(formatRoute(r), "source+40 target+120 target-40");
  assert.equal(poly(resolveRoute(r, s, t)), poly(pts), "the frozen route draws what was frozen");
});

test("freeze: collinear vertices and repeated points do not make segments", () => {
  const s = E(0, 0);
  const t = W(200, 80);
  const r = freezeRoute(
    [pt(0, 0), pt(40, 0), pt(40, 0), pt(80, 0), pt(80, 40), pt(80, 80), pt(200, 80)],
    s, t
  );
  assert.equal(formatRoute(r), "source+80");
});

test("freeze: a wire that bends at its pin gets a zero-length stub", () => {
  const s = E(0, 0);
  const t = W(200, 80);
  const r = freezeRoute([pt(0, 0), pt(0, 80), pt(200, 80)], s, t);
  assert.equal(formatRoute(r), "source+0");
  const into = freezeRoute([pt(0, 0), pt(200, 0), pt(200, 80)], s, t);
  assert.equal(formatRoute(into), "target+0");
});

test("freeze: a straight wire has a trunk without length, mid-span on the grid", () => {
  const s = E(4, 40); // an off-grid anchor, as in the verification view
  const t = W(204, 40);
  const r = freezeRoute([pt(4, 40), pt(204, 40)], s, t);
  assert.equal(r.length, 1);
  assert.equal(resolveRoute(r, s, t)[1].x, 104, "(4 + 204) / 2 = 104, on the grid of 8");
  assert.equal(drawn(r, s, t), "4,40 204,40", "still drawn as one line");
});

test("freeze: what a skeleton cannot say is refused, not approximated", () => {
  const s = E(0, 0);
  const t = W(200, 80);
  assert.equal(freezeRoute([pt(0, 0), pt(200, 80)], s, t), null, "oblique");
  assert.equal(freezeRoute([pt(0, 0)], s, t), null, "a point");
  assert.equal(freezeRoute([], s, t), null);
  assert.equal(
    freezeRoute([pt(8, 0), pt(100, 0), pt(100, 80), pt(200, 80)], s, t),
    null,
    "a polyline that does not start at the source pin is another wire's"
  );
  // more bends than a skeleton keeps
  const many = [pt(0, 0)];
  for (let i = 0; i < ROUTE_MAX_SEGS + 4; i++) { // an odd count of runs: H V … H
    const last = many[many.length - 1];
    many.push(i % 2 === 0 ? pt(last.x + 8, last.y) : pt(last.x, last.y + 8));
  }
  const end = many[many.length - 1];
  assert.equal(freezeRoute(many, s, W(end.x, end.y)), null);
});

// ------------------------------------------------- relative to the pins

test("moving a block carries the segments anchored to its pin; the rest stretch", () => {
  const r = parseRoute("source+40 target+120 target-40");
  const s = E(0, 0);
  const t = W(400, 80);
  assert.equal(drawn(r, s, t), "0,0 40,0 40,200 360,200 360,80 400,80");
  // the SOURCE block moves by (-80, +40): only its vertical follows
  assert.equal(drawn(r, E(-80, 40), t), "-80,40 -40,40 -40,200 360,200 360,80 400,80");
  // the TARGET block moves by (+80, +40): its vertical and the long run follow
  assert.equal(drawn(r, s, W(480, 120)), "0,0 40,0 40,240 440,240 440,120 480,120");
  // both by the same amount: the whole route moves with them
  assert.equal(
    drawn(r, E(16, 16), W(416, 96)),
    "16,16 56,16 56,216 376,216 376,96 416,96"
  );
});

// ---------------------------------------------------------- validity

const box = (id, x, y, w, h) => ({ id, x, y, w, h });

test("validity: a route that leaves or enters its pin backwards is reversed", () => {
  const e = edge("e", "a", "b");
  const s = E(100, 40);
  const t = W(300, 120);
  assert.equal(routeState(parseRoute("source+40"), s, t, [], e), "ok");
  assert.equal(routeState(parseRoute("source-8"), s, t, [], e), "reversed");
  assert.equal(routeState(parseRoute("target+8"), s, t, [], e), "reversed", "into a west pin from its east");
  assert.equal(routeState(parseRoute("source+0"), s, t, [], e), "ok", "a bend AT the pin is not backwards");
  // the block was flipped: the same skeleton, the pin now leaves west
  assert.equal(routeState(parseRoute("source+40"), W(100, 40), t, [], e), "reversed");
});

test("validity: no segment within reach of a block, the stubs touch their own", () => {
  const e = edge("e", "a", "b");
  const s = E(100, 40); // the east edge of block a
  const t = W(300, 120); // the west edge of block b
  const a = box("a", 20, 0, 80, 80);
  const b = box("b", 300, 80, 80, 80);
  const r = parseRoute("source+60");
  assert.equal(routeState(r, s, t, [a, b], e), "ok", "each stub starts ON its own box");
  // a third block on the trunk
  assert.equal(routeState(r, s, t, [a, b, box("c", 140, 60, 40, 40)], e), "blocked");
  // a trunk ON the box's own edge is not a stub: it runs along the border
  assert.equal(routeState(parseRoute("source+0"), s, t, [a, b], e), "blocked");
  assert.equal(routeState(parseRoute("source+8"), s, t, [a, b], e), "ok", "one grid cell away is clear");
  // the target stub through the SOURCE block is not exempt
  const back = parseRoute("source+60 source+20 target-200");
  assert.equal(routeState(back, s, t, [a, b], e), "blocked");
  // an anonymous solid (a select chip) is a wall for every segment
  assert.equal(routeState(r, s, t, [{ x: 120, y: 30, w: 18, h: 14 }], e), "blocked");
  // a zero-length segment cuts nothing
  assert.equal(
    routeState(parseRoute("source+60"), s, W(300, 40), [box("c", 150, 60, 40, 40)], e),
    "ok",
    "the pins are level: the trunk has no length, the wire passes above the block"
  );
});

test("placeManual: a valid skeleton is placed, an invalid one is dormant, a forced one is drawn anyway", () => {
  const e1 = edge("e1", "a", "b");
  const e2 = edge("e2", "a", "c");
  const ends = [
    { edge: e1, s: E(100, 40), t: W(300, 120) },
    { edge: e2, s: E(100, 40), t: W(300, 200) },
    { edge: edge("e3", "a", "d"), s: E(100, 40), t: W(300, 280) },
  ];
  const routes = parseRoutes({ e1: { route: "source+60" }, e2: { route: "source-16" } });
  const { manual, dormant } = placeManual(ends, routes, []);
  assert.deepEqual([...manual.keys()], ["e1"]);
  assert.equal(poly(manual.get("e1").pts), "100,40 160,40 160,120 300,120");
  assert.deepEqual([...dormant], [["e2", "reversed"]], "kept, reported, routed automatically");
  const forced = placeManual(ends, routes, [], new Set(["e2"]));
  assert.equal(forced.manual.get("e2").state, "reversed", "the preview of a drag shows it as it is");
  assert.equal(forced.dormant.size, 0);
});

// ------------------------------------------------------------ groups

test("groups: a net is one wire; so are edges that share a pin", () => {
  const edges = [
    edge("a", "u1", "u2", "n1", "o", "i"),
    edge("b", "u1", "u3", "n1", "o", "i"),
    edge("c", "u4", "u5", "n2", "o", "i"),
    // the verification view: two differently-named wires leave one analysis port
    edge("d", "agent", "sb", "sb.source", "ap", "source"),
    edge("e", "agent", "cov", "cov", "ap", "in"),
    // a chain through a flag: driver -> flag, flag -> monitor
    edge("f", "drv", "<if>", null, "if", null),
    edge("g", "<if>", "mon", null, null, "if"),
  ];
  assert.deepEqual(wireGroup(edges, "a"), ["a", "b"]);
  assert.deepEqual(wireGroup(edges, "c"), ["c"]);
  assert.deepEqual(wireGroup(edges, "e"), ["d", "e"], "one source pin");
  assert.deepEqual(wireGroup(edges, "f"), ["f", "g"], "the flag is one point, whichever end it is");
  assert.deepEqual(wireGroup(edges, "nope"), []);
});

// ------------------------------------------------------------- the grab

const geom = (e, s, t, pts, r = null) => ({ edge: e, s, t, pts, route: r });
const zPts = (s, t, x) => [pt(s.x, s.y), pt(x, s.y), pt(x, t.y), pt(t.x, t.y)];

test("grab: a segment's body moves on one axis, a corner on both, a miss is null", () => {
  const s = E(0, 0);
  const t = W(400, 80);
  const pts = [pt(0, 0), pt(40, 0), pt(40, 200), pt(360, 200), pt(360, 80), pt(400, 80)];
  const g = [geom(edge("e", "a", "b"), s, t, pts)];
  assert.equal(grabWire(g, pt(40, 100), 4).kind, "v");
  assert.equal(grabWire(g, pt(200, 202), 4).kind, "h");
  const corner = grabWire(g, pt(41, 199), 4);
  assert.equal(corner.kind, "corner");
  assert.deepEqual(corner.parts.map((p) => p.index).sort(), [0, 1]);
  assert.equal(grabWire(g, pt(200, 100), 4), null, "nothing within reach");
  // the corner at the pin stub: the stub is the pin's, only the segment moves
  const atStub = grabWire(g, pt(39, 1), 4);
  assert.equal(atStub.kind, "v");
  assert.deepEqual(atStub.parts.map((p) => p.index), [0]);
});

test("drag: a vertical takes dx, a horizontal dy, snapped to the grid as absolute lines", () => {
  const s = E(0, 0);
  const t = W(400, 80);
  const pts = [pt(0, 0), pt(40, 0), pt(40, 200), pt(360, 200), pt(360, 80), pt(400, 80)];
  const g = [geom(edge("e", "a", "b"), s, t, pts)];
  const v = dragWire(grabWire(g, pt(40, 100), 4), 30, 999);
  assert.equal(formatRoute(v.routes.e), "source+72 target+120 target-40", "40 + 30 = 70 -> 72; dy ignored");
  assert.deepEqual(v.moved, ["e"]);
  const h = dragWire(grabWire(g, pt(200, 200), 4), 999, -43);
  assert.equal(formatRoute(h.routes.e), "source+40 target+80 target-40", "200 - 43 = 157 -> 160");
  const c = dragWire(grabWire(g, pt(40, 200), 4), 16, 16);
  assert.equal(formatRoute(c.routes.e), "source+56 target+136 target-40");
  // less than half a cell: nothing moved, nothing to commit
  const none = dragWire(grabWire(g, pt(40, 100), 4), 3, 0);
  assert.deepEqual(none.moved, []);
  assert.equal(formatRoute(none.routes.e), "source+40 target+120 target-40", "frozen as drawn");
});

test("drag: an off-grid line lands on the grid at its first move", () => {
  const s = E(2, 0);
  const t = W(402, 80);
  const g = [geom(edge("e", "a", "b"), s, t, zPts(s, t, 43))];
  const r = dragWire(grabWire(g, pt(43, 40), 4), 8, 0).routes.e;
  assert.equal(resolveRoute(r, s, t)[1].x, 48, "43 + 8 = 51 -> 48");
});

test("drag: a bend dragged flat disappears (the neighbours become one line)", () => {
  const s = E(0, 0);
  const t = W(400, 80);
  const pts = [pt(0, 0), pt(40, 0), pt(40, 200), pt(360, 200), pt(360, 80), pt(400, 80)];
  const g = [geom(edge("e", "a", "b"), s, t, pts)];
  // the long run pulled up to the target pin's row: the last vertical has no length
  const r = dragWire(grabWire(g, pt(200, 200), 4), 0, -120).routes.e;
  assert.equal(formatRoute(r), "source+40");
  assert.equal(drawn(r, s, t), "0,0 40,0 40,80 400,80");
  // the two verticals pulled onto one line: the run between them has no length
  const merged = dragWire(grabWire(g, pt(360, 140), 4), -320, 0).routes.e;
  assert.equal(formatRoute(merged), "source+40");
});

test("normalize: a skeleton never goes below one segment", () => {
  const s = E(0, 40);
  const t = W(200, 40);
  assert.equal(formatRoute(normalizeRoute(parseRoute("source+96"), s, t)), "source+96");
  // a bump whose run sits on the pins' row is no bump
  assert.equal(
    formatRoute(normalizeRoute(parseRoute("source+16 source+0 target-16"), s, t)),
    "target-16"
  );
});

// --------------------------------------------------------------- the jog

test("jog: dragging a pin stub lifts it, leaving a stub at the pin", () => {
  const s = E(0, 0);
  const t = W(400, 80);
  const g = [geom(edge("e", "a", "b"), s, t, zPts(s, t, 200))];
  const src = dragWire(grabWire(g, pt(100, 0), 4), 0, -40).routes.e;
  assert.equal(formatRoute(src), `source+${JOG_STUB} source-40 source+200`);
  assert.equal(drawn(src, s, t), "0,0 16,0 16,-40 200,-40 200,80 400,80");
  const tgt = dragWire(grabWire(g, pt(300, 80), 4), 0, 24).routes.e;
  assert.equal(formatRoute(tgt), "source+200 target+24 target-16");
  assert.equal(drawn(tgt, s, t), "0,0 200,0 200,104 384,104 384,80 400,80");
  // sideways: a stub's line is its pin's — nothing moves
  assert.deepEqual(dragWire(grabWire(g, pt(100, 0), 4), 40, 0).moved, []);
});

test("jog: a straight wire becomes a bump with a stub at each pin", () => {
  const s = E(0, 40);
  const t = W(200, 40);
  const g = [geom(edge("e", "a", "b"), s, t, [pt(0, 40), pt(200, 40)])];
  for (const x of [30, 100, 170]) {
    const r = dragWire(grabWire(g, pt(x, 40), 4), 0, -32).routes.e;
    assert.equal(formatRoute(r), "source+16 source-32 target-16", `grabbed at x=${x}`);
    assert.equal(drawn(r, s, t), "0,40 16,40 16,8 184,8 184,40 200,40");
  }
  // an off-grid anchor (the verification view's stub): the jog is on the grid
  const s2 = E(2, 40);
  const t2 = W(202, 40);
  const r2 = dragWire(
    grabWire([geom(edge("e", "a", "b"), s2, t2, [pt(2, 40), pt(202, 40)])], pt(100, 40), 4),
    0, 16
  ).routes.e;
  assert.equal(drawn(r2, s2, t2), "2,40 16,40 16,56 184,56 184,40 202,40");
});

test("jog: no room, no jog — the stub is as long as it has to be", () => {
  const s = E(0, 0);
  const t = W(400, 80);
  // the trunk is one cell from the pin: nothing to lift
  const g = [geom(edge("e", "a", "b"), s, t, zPts(s, t, 8))];
  assert.deepEqual(dragWire(grabWire(g, pt(4, 0), 5), 0, -40).moved, []);
  // two pins 24 px apart: a bump needs a stub at each end and a run between
  const s2 = E(0, 0);
  const t2 = W(24, 0);
  const tight = [geom(edge("e", "a", "b"), s2, t2, [pt(0, 0), pt(24, 0)])];
  assert.deepEqual(dragWire(grabWire(tight, pt(12, 0), 4), 0, -40).moved, []);
});

// ------------------------------------------------- a net with several ends

test("fan-out: the shared trunk is dragged as one wire and follows the common pin", () => {
  const s = E(100, 100);
  const t1 = W(400, 40);
  const t2 = W(400, 160);
  const t3 = W(400, 280);
  const edges = [
    geom(edge("e1", "u", "a", "n"), s, t1, zPts(s, t1, 320)),
    geom(edge("e2", "u", "b", "n"), s, t2, zPts(s, t2, 320)),
    geom(edge("e3", "u", "c", "n"), s, t3, zPts(s, t3, 320)),
  ];
  // the trunk at x=320 is nearer the sinks: frozen alone each edge would follow
  // ITS sink, and moving one sink would split the trunk
  const grab = grabWire(edges, pt(320, 120), 4);
  assert.equal(grab.kind, "v");
  // e1's vertical spans y 40..100, e2's 100..160, e3's 100..280: the press at
  // y=120 is on e2's and e3's only — but the line is ONE trunk to the eye, and
  // e1's part touches it
  assert.equal(grab.parts.length, 3, "the whole straight run, not only what is under the press");
  const out = dragWire(grab, -80, 0);
  assert.deepEqual(out.moved.sort(), ["e1", "e2", "e3"]);
  for (const id of ["e1", "e2", "e3"]) {
    assert.equal(formatRoute(out.routes[id]), "source+140", `${id} follows the source pin`);
  }
  // wherever along the trunk it is pressed
  for (const y of [60, 220]) {
    assert.equal(grabWire(edges, pt(320, y), 4).parts.length, 3, `pressed at y=${y}`);
  }
});

test("a run is what TOUCHES: a segment on the same line across a gap is another wire", () => {
  const s = E(100, 100);
  const t1 = W(400, 40);
  // e2 leaves the same pin but its vertical on x=320 starts lower, past a gap
  const t2 = W(400, 300);
  const e2pts = [pt(100, 100), pt(200, 100), pt(200, 200), pt(320, 200), pt(320, 300), pt(400, 300)];
  const edges = [
    geom(edge("e1", "u", "a", "n"), s, t1, zPts(s, t1, 320)),
    geom(edge("e2", "u", "b", "n"), s, t2, e2pts),
  ];
  const grab = grabWire(edges, pt(320, 60), 4);
  assert.deepEqual(grab.parts.map((p) => p.edgeId), ["e1"], "e1: y 40..100; e2 on x=320: y 200..300");
});

test("fan-out: the untouched branches are frozen as drawn, on the common pin too", () => {
  const s = E(100, 100);
  const t1 = W(400, 40);
  const t2 = W(400, 160);
  const edges = [
    geom(edge("e1", "u", "a", "n"), s, t1, zPts(s, t1, 320)),
    geom(edge("e2", "u", "b", "n"), s, t2, zPts(s, t2, 320)),
  ];
  // lift e2's tap into its sink: only e2 changes
  const out = dragWire(grabWire(edges, pt(360, 160), 4), 0, 40);
  assert.deepEqual(out.moved, ["e2"]);
  assert.equal(formatRoute(out.routes.e2), "source+220 target+40 target-16");
  assert.equal(formatRoute(out.routes.e1), "source+220", "frozen: the shared trunk follows the source");
  assert.equal(drawn(out.routes.e1, s, t1), poly(zPts(s, t1, 320)), "and is drawn where it was");
});

test("fan-in: branches entering one pin share the trunk on the target", () => {
  const t = W(400, 100);
  const s1 = E(100, 40);
  const s2 = E(100, 160);
  const edges = [
    geom(edge("e1", "a", "u", "n"), s1, t, zPts(s1, t, 160)),
    geom(edge("e2", "b", "u", "n"), s2, t, zPts(s2, t, 160)),
  ];
  // the trunk is nearer the sources, but the sources are two pins: only the
  // target is common
  const out = dragWire(grabWire(edges, pt(160, 100), 4), 40, 0);
  assert.equal(formatRoute(out.routes.e1), "target-200");
  assert.equal(formatRoute(out.routes.e2), "target-200");
});

test("fan-out: the shared source stub is lifted for every branch", () => {
  const s = E(100, 100);
  const t1 = W(400, 40);
  const t2 = W(400, 160);
  const edges = [
    geom(edge("e1", "u", "a", "n"), s, t1, zPts(s, t1, 320)),
    geom(edge("e2", "u", "b", "n"), s, t2, zPts(s, t2, 320)),
  ];
  const out = dragWire(grabWire(edges, pt(200, 100), 4), 0, -24);
  assert.deepEqual(out.moved.sort(), ["e1", "e2"]);
  // the pin (100, 100) is off the grid of 8 here: the jog still lands ON it —
  // x 116 -> 120, y 76 -> 80
  assert.equal(formatRoute(out.routes.e1), "source+20 source-20 source+220");
  assert.equal(formatRoute(out.routes.e2), "source+20 source-20 source+220");
});

test("a junction: the trunk moves sideways, the tap's line stays the pin's", () => {
  const s = E(100, 100);
  const t1 = W(400, 40);
  const t2 = W(400, 160);
  const edges = [
    geom(edge("e1", "u", "a", "n"), s, t1, zPts(s, t1, 320)),
    geom(edge("e2", "u", "b", "n"), s, t2, zPts(s, t2, 320)),
  ];
  // the T where the source stub meets the trunk
  const grab = grabWire(edges, pt(320, 100), 4);
  assert.equal(grab.kind, "v", "the stub is the pin's: one axis");
  const out = dragWire(grab, -40, -40);
  assert.equal(formatRoute(out.routes.e1), "source+180");
  assert.equal(formatRoute(out.routes.e2), "source+180");
});

test("an edge already hand-routed keeps its skeleton; zero-length bends are not grabbed", () => {
  const s = E(0, 0);
  const t = W(400, 0); // level with the source: the stored Z has no trunk length now
  const stored = parseRoute("source+40 source+120 target-40");
  const g = [geom(edge("e", "a", "b"), s, t, simplifyPoly(resolveRoute(stored, s, t)), stored)];
  const grab = grabWire(g, pt(200, 120), 4);
  assert.equal(grab.kind, "h");
  const out = dragWire(grab, 0, 40);
  assert.equal(formatRoute(out.routes.e), "source+40 source+160 target-40");
  // nothing moved: the stored skeleton comes back untouched, not normalised
  const still = dragWire(grabWire(g, pt(200, 120), 4), 0, 0);
  assert.deepEqual(still.moved, []);
  assert.equal(formatRoute(still.routes.e), formatRoute(stored));
});

test("an edge that cannot be frozen stays out of the gesture", () => {
  const s = E(0, 0);
  const t = W(400, 80);
  const g = [
    geom(edge("ok", "a", "b", "n"), s, t, zPts(s, t, 200)),
    geom(edge("odd", "a", "c", "n"), s, W(400, 200), [pt(0, 0), pt(400, 200)]),
  ];
  const out = dragWire(grabWire(g, pt(200, 40), 4), 40, 0);
  assert.deepEqual(Object.keys(out.routes), ["ok"]);
});

// ------------------------------------------- from the adversarial review

test("review: a pin's own chip is not a wall for its stub — a wide bus label puts it 2 px from the tip", () => {
  // the anchor of a select / concat pin is the stub's tip, beyond the chip
  const e = edge("e", "a", "b");
  const s = E(224, 40);
  const t = W(400, 120);
  const chip = { x: 204, y: 33, w: 18, h: 14, id: "a" }; // ends at 222: inside the clearance
  assert.equal(routeState(parseRoute("source+16"), s, t, [chip], e), "ok");
  // anonymous, it was a wall for the stub that starts 2 px from it
  assert.equal(routeState(parseRoute("source+16"), s, t, [{ ...chip, id: undefined }], e), "blocked");
  // and it stays a wall for every other segment of its own edge
  // (a run doubling back over it, 8 px above the pin's row)
  const back = parseRoute("source+16 source-8 target-190");
  assert.equal(routeState(back, s, t, [chip], e), "blocked");
});

test("review: a dormant sibling keeps the route that is waiting — unless IT is the one dragged", () => {
  const s = E(96, 96);
  const t1 = W(400, 40);
  const t2 = W(400, 160);
  const edges = [
    geom(edge("e1", "u", "a", "n"), s, t1, zPts(s, t1, 320)),
    // e2 has a stored skeleton that is dormant: what is drawn is the router's line
    { ...geom(edge("e2", "u", "b", "n"), s, t2, zPts(s, t2, 320)), asleep: true },
  ];
  // lift e1's tap: e2 is frozen for the drag, but not written
  const out = dragWire(grabWire(edges, pt(360, 40), 4), 0, -24);
  assert.deepEqual(out.moved, ["e1"]);
  assert.deepEqual(Object.keys(out.routes), ["e1"], "e2's own route stays in the file");
  // the shared trunk dragged: e2 moves, so the user re-routed it — it is written
  const trunk = dragWire(grabWire(edges, pt(320, 120), 4), -40, 0);
  assert.deepEqual(Object.keys(trunk.routes).sort(), ["e1", "e2"]);
});

test("review: the level branch of a fan is frozen ON the trunk, and moves with it", () => {
  const s = E(96, 96);
  const t1 = W(400, 96); // level with the source: drawn as one straight line
  const t2 = W(400, 168);
  const edges = [
    geom(edge("e1", "u", "a", "n"), s, t1, [pt(96, 96), pt(400, 96)]),
    geom(edge("e2", "u", "b", "n"), s, t2, zPts(s, t2, 320)),
  ];
  // untouched, e1's hidden trunk sits where the net's trunk is — not mid-span
  const lift = dragWire(grabWire(edges, pt(360, 168), 4), 0, 24);
  assert.deepEqual(lift.moved, ["e2"]);
  assert.equal(formatRoute(lift.routes.e1), "source+224", "x = 320, the trunk");
  // so when its sink moves down, the branch leaves the trunk at the trunk
  assert.equal(drawn(lift.routes.e1, s, W(400, 144)), "96,96 320,96 320,144 400,144");
  // and the trunk dragged takes the hidden part along
  const out = dragWire(grabWire(edges, pt(320, 130), 4), -40, 0);
  assert.deepEqual(out.moved.sort(), ["e1", "e2"]);
  assert.equal(formatRoute(out.routes.e1), "source+184");
  assert.equal(formatRoute(out.routes.e2), "source+184");
  // a straight wire with no group-mate through its row keeps mid-span
  const alone = [geom(edge("e", "a", "b"), E(0, 40), W(200, 40), [pt(0, 40), pt(200, 40)])];
  const r = dragWire(grabWire(alone, pt(100, 40), 4), 0, 0).routes.e;
  assert.equal(formatRoute(r), "target-96", "x = 104: mid-span, on the grid");
});

test("review: a junction is a corner whichever edge comes first", () => {
  const t = W(400, 200);
  const sa = E(0, 0);
  const sb = E(0, 40);
  // ea's vertical runs through (200, 104); eb's horizontal ends there
  const ea = geom(edge("ea", "a", "u", "n"), sa, t, zPts(sa, t, 200));
  const eb = geom(edge("eb", "b", "u", "n"), sb, t, [
    pt(0, 40), pt(80, 40), pt(80, 104), pt(200, 104), pt(200, 200), pt(400, 200),
  ]);
  for (const order of [[ea, eb], [eb, ea]]) {
    const grab = grabWire(order, pt(200, 104), 4);
    assert.equal(grab.kind, "corner", order.map((g) => g.edge.id).join(","));
    const out = dragWire(grab, 16, 16);
    assert.equal(formatRoute(out.routes.ea), "target-184");
    assert.equal(formatRoute(out.routes.eb), "source+80 source+80 target-184");
  }
});

test("review: a run is transitive — a segment joins through one that touches both", () => {
  const mk = (id, y0, y1) => {
    const s = E(0, y0);
    const t = W(400, y1);
    return geom(edge(id, id, "u" + id, "n"), s, t, zPts(s, t, 200));
  };
  // on x=200: eA spans y 0..48, eB 48..96, eC 96..144 — eC touches only eB
  const g = [mk("eA", 0, 48), mk("eB", 48, 96), mk("eC", 96, 144)];
  assert.deepEqual(grabWire(g, pt(200, 24), 4).parts.map((p) => p.edgeId).sort(), ["eA", "eB", "eC"]);
});

test("review: a shared HORIZONTAL run follows the common pin too", () => {
  const s = E(0, 0);
  const t1 = W(400, 80);
  const t2 = W(400, 304);
  const edges = [
    geom(edge("e1", "u", "a", "n"), s, t1, [
      pt(0, 0), pt(40, 0), pt(40, 200), pt(304, 200), pt(304, 80), pt(400, 80),
    ]),
    geom(edge("e2", "u", "b", "n"), s, t2, [
      pt(0, 0), pt(40, 0), pt(40, 200), pt(360, 200), pt(360, 304), pt(400, 304),
    ]),
  ];
  // alone, each horizontal would follow its own SINK (the nearer pin)
  const out = dragWire(grabWire(edges, pt(304, 140), 4), -16, 0);
  assert.deepEqual(out.moved, ["e1"]);
  assert.equal(formatRoute(out.routes.e1), "source+40 source+200 target-112");
  assert.equal(formatRoute(out.routes.e2), "source+40 source+200 target-40");
});

test("review: a drag that went nowhere on an axis moves nothing on it — an off-grid line stays", () => {
  const s = E(0, 0);
  const t = W(400, 80);
  const pts = [pt(0, 0), pt(40, 0), pt(40, 43), pt(360, 43), pt(360, 80), pt(400, 80)];
  const g = [geom(edge("e", "a", "b"), s, t, pts)];
  assert.deepEqual(dragWire(grabWire(g, pt(200, 43), 4), 0, 0).moved, [], "y=43 is not pulled to 40");
  assert.deepEqual(dragWire(grabWire(g, pt(200, 43), 4), 0, 3).moved, [], "under half a cell");
  // a corner dragged sideways only: its horizontal line is left alone
  const side = dragWire(grabWire(g, pt(40, 43), 4), 16, 0);
  assert.equal(formatRoute(side.routes.e), "source+56 target-37 target-40");
});

test("review: the middle segment follows the pin it is dragged next to", () => {
  const s = E(0, 0);
  const t = W(400, 80);
  const g = [geom(edge("e", "a", "b"), s, t, zPts(s, t, 320))];
  assert.equal(formatRoute(dragWire(grabWire(g, pt(320, 40), 4), 0, 0).routes.e), "target-80");
  assert.equal(formatRoute(dragWire(grabWire(g, pt(320, 40), 4), -240, 0).routes.e), "source+80");
});

test("review: a route the file form cannot say is not made", () => {
  // the longest skeleton: a jog would make 43 segments, which reads back as
  // nothing — and nothing, at the host, DELETES the stored route
  const s = E(0, 0);
  const t = W(4000, 2000);
  const stored = [];
  for (let k = 0; k < ROUTE_MAX_SEGS; k++) {
    stored.push({ anchor: "source", offset: k % 2 === 0 ? 200 + 8 * k : 104 + 8 * k });
  }
  const g = [geom(edge("e", "a", "b"), s, t, simplifyPoly(resolveRoute(stored, s, t)), stored)];
  const grab = grabWire(g, pt(100, 0), 4);
  assert.equal(grab.kind, "h", "the source stub");
  assert.deepEqual(dragWire(grab, 0, -40).moved, []);
  // moving a segment of it is still fine
  assert.deepEqual(dragWire(grabWire(g, pt(200, 50), 4), 16, 0).moved, ["e"]);
  // an offset beyond the file form's range is not frozen
  const far = W(400000, 80);
  assert.equal(freezeRoute(zPts(s, far, 200000), s, far), null);
});

test("review: reversed has half a cell of slack; a flag the wire ends at may be touched", () => {
  const e = edge("e", "a", "f");
  // the verification view: anchors 2 px off the grid, a route that bends at
  // its pin lands half a cell behind it
  const s = E(322, 40);
  const t = W(600, 120);
  assert.equal(routeState(parseRoute("source-2"), s, t, [], e), "ok");
  assert.equal(routeState(parseRoute("source-8"), s, t, [], e), "reversed");
  // a boundary flag is not an obstacle of the router there: an automatic wire
  // may turn right at it
  const flag = { x: 600, y: 112, w: 40, h: 16, id: "f", flag: true };
  assert.equal(routeState(parseRoute("target+0"), s, t, [flag], e), "ok");
  assert.equal(routeState(parseRoute("target+0"), s, t, [{ ...flag, flag: undefined }], e), "blocked");
  // for a wire that does not end at it, a flag is a wall
  assert.equal(routeState(parseRoute("target+0"), s, t, [flag], edge("x", "a", "b")), "blocked");
});

test("review: the pins need not face each other — a wire that runs leftwards, two pins facing east", () => {
  // source leaves WEST, target is entered from its EAST
  const s = W(400, 0);
  const t = E(0, 80);
  const e = edge("e", "a", "b");
  assert.equal(routeState(parseRoute("source-200"), s, t, [], e), "ok");
  assert.equal(routeState(parseRoute("source+8"), s, t, [], e), "reversed", "east of a west pin");
  assert.equal(routeState(parseRoute("target-8"), s, t, [], e), "reversed", "west of an east pin");
  const g = [geom(e, s, t, zPts(s, t, 200))];
  const jog = dragWire(grabWire(g, pt(100, 80), 4), 0, 24).routes.e;
  assert.equal(formatRoute(jog), "source-200 target+24 target+16");
  assert.equal(drawn(jog, s, t), "400,0 200,0 200,104 16,104 16,80 0,80");
  // both pins face east: the wire comes round to the target's east side
  const s2 = E(0, 0);
  const t2 = E(400, 80);
  const g2 = [geom(e, s2, t2, zPts(s2, t2, 440))];
  const jog2 = dragWire(grabWire(g2, pt(420, 80), 4), 0, -24).routes.e;
  assert.equal(drawn(jog2, s2, t2), "0,0 440,0 440,56 416,56 416,80 400,80");
  assert.equal(routeState(jog2, s2, t2, [], e), "ok");
});

test("review: simplifyPoly reaches a fixpoint — a spur that returns leaves nothing behind", () => {
  assert.equal(
    poly(simplifyPoly([pt(0, 0), pt(100, 0), pt(100, 50), pt(100, 0), pt(200, 0)])),
    "0,0 200,0"
  );
});

// --------------------------------------- the router's side: fixed routes

test("router: an automatic wire keeps off a hand-placed one of another net", () => {
  // two wires that want the same straight corridor at y=80
  const request = {
    id: "auto",
    source: { x: 0, y: 80, dir: 1 },
    target: { x: 400, y: 80, dir: -1 },
    group: "n2",
  };
  const alone = route([], [request]).get("auto");
  assert.equal(poly(alone), "0,80 400,80", "unopposed: straight");
  const fixed = [{ group: "n1", points: [pt(0, 80), pt(400, 80)] }];
  // room to go around: an obstacle-free terrain needs a taller box than the
  // two anchors span
  const frame = [{ x: 0, y: 0, w: 0, h: 0 }, { x: 400, y: 160, w: 0, h: 0 }];
  const beside = route(frame, [request], { fixed, fanoutRadius: 0 }).get("auto");
  const onLine = beside.filter((p) => p.y === 80).length;
  assert.ok(beside.length > 2 && onLine < beside.length, `left the occupied row: ${poly(beside)}`);
  // the same net may run on it
  const sameNet = route(frame, [{ ...request, group: "n1" }], { fixed, fanoutRadius: 0 }).get("auto");
  assert.equal(poly(sameNet), "0,80 400,80");
});

test("router: a VERTICAL fixed route occupies its column", () => {
  // every column between the pins is taken by another net, bar x=120
  const fixed = [];
  for (let x = 8; x <= 152; x += 8) {
    if (x !== 120) {
      fixed.push({ group: `n${x}`, points: [pt(x, 16), pt(x, 144)] });
    }
  }
  const r = route(
    [],
    [{ id: "a", source: { x: 0, y: 0, dir: 1 }, target: { x: 160, y: 160, dir: -1 }, group: "mine" }],
    { fixed, fanoutRadius: 0 }
  );
  assert.equal(poly(r.get("a")), "0,0 120,0 120,160 160,160");
});

test("router: fixed routes alone route nothing, and one outside the terrain is harmless", () => {
  assert.equal(route([], [], { fixed: [{ group: "n", points: [pt(0, 0), pt(80, 0)] }] }).size, 0);
  const far = [{ group: "n", points: [pt(-9000, -9000), pt(9000, -9000), pt(9000, 9000)] }];
  const r = route([], [{ id: "a", source: { x: 0, y: 0, dir: 1 }, target: { x: 80, y: 0, dir: -1 } }], {
    fixed: far,
  });
  assert.equal(poly(r.get("a")), "0,0 80,0");
});

console.log(`\n${passed} tests passed`);
