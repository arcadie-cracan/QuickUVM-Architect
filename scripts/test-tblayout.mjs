// Node tests for the verification view layout (src/webview/tbschematic.ts
// — layoutTb with real ELK): npm run test:tblayout
//
// Covers the key invariants of the drift from the „drag + TB positions" slice:
//  - the TbPlaced ports are RELATIVE to the node origin (anchor = n.x +
//    offset), not absolute — otherwise the wires don't follow the block on drag;
//  - layoutTb accepts seeds (interactive ELK) without crashing.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import esbuild from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "quickuvm-tblayout-"));
await esbuild.build({
  entryPoints: ["src/webview/tbscene.ts"],
  outfile: join(dir, "scene.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
await esbuild.build({
  entryPoints: ["src/webview/tbschematic.ts"],
  outfile: join(dir, "tb.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  // `router`/`svg` are clean ESM; elkjs (CJS) is linked via require in the banner
  banner: {
    js: "import { createRequire as _cr } from 'module'; const require=_cr(import.meta.url);",
  },
});
const { buildTbScene } = await import(pathToFileURL(join(dir, "scene.mjs")));
const { layoutTb } = await import(pathToFileURL(join(dir, "tb.mjs")));
const require = createRequire(import.meta.url);
const ELK = require("elkjs/lib/elk.bundled.js");
const elk = new ELK();
const measure = (t) => t.length * 7;

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const CFG = {
  project: { name: "demo" },
  dut: { name: "soc_top", clock: "clk", reset: "rst_n" },
  agents: [{ name: "cmd", interface: "cmd_if" }, { name: "rsp", active: false }],
  analysis: { scoreboards: [{ name: "sbd", source: "cmd", monitor: "rsp" }] },
};

await test("docs/08 R13: the widget rows are counted in the box (the pills fit)", async () => {
  const scene = buildTbScene(CFG, "env", "d.yaml");
  const layout = await layoutTb(elk, scene, measure);
  const sb = layout.nodes.get("sb:sbd");
  const noWidgets = { ...scene, nodes: scene.nodes.map((n) => ({ ...n, widgets: [] })) };
  const bare = (await layoutTb(elk, noWidgets, measure)).nodes.get("sb:sbd");
  // two pills (4 + 2*18 = 40px of text height) make the box taller than the
  // port-driven minimum it had without them, on the 8px grid
  assert.ok(sb.h > bare.h, `with widgets ${sb.h} vs without ${bare.h}`);
  assert.equal(sb.h % 8, 0);
  // the mono measurer is asked for the pill text: a wide label widens the box
  const wide = { ...scene, nodes: scene.nodes.map((n) => n.id === "sb:sbd" ? { ...n, widgets: [{ ...n.widgets[0], label: "match: out_of_order (a_very_long_key_name)" }] } : n) };
  const w = (await layoutTb(elk, wide, measure)).nodes.get("sb:sbd");
  assert.ok(w.w > sb.w, `wide label ${w.w} vs ${sb.w}`);
});

await test("docs/08 R18: a block collapsed to its header is shorter, keeps its ports, and is marked", async () => {
  const scene = buildTbScene(CFG, "env", "d.yaml");
  const full = (await layoutTb(elk, scene, measure)).nodes.get("agent:cmd");
  const layout = await layoutTb(elk, scene, measure, undefined, undefined, new Set(["agent:cmd"]));
  const c = layout.nodes.get("agent:cmd");
  assert.equal(c.collapsed, true);
  assert.ok(c.h < full.h, `collapsed ${c.h} < full ${full.h}`);
  assert.equal(c.h % 8, 0, "still on the grid");
  assert.equal(c.ports.size, full.ports.size, "the ports stay: the wires still connect");
  assert.equal(layout.nodes.get("agent:rsp").collapsed, undefined, "only the named block");
});

await test("porturile sunt RELATIVE la originea nodului (0 sau w)", async () => {
  const scene = buildTbScene(CFG, "", "d.yaml");
  const layout = await layoutTb(elk, scene, measure);
  let checked = 0;
  for (const p of layout.nodes.values()) {
    for (const port of p.ports.values()) {
      // relative: WEST = 0, EAST = the node width. Absolute would be p.x + offset,
      // i.e. >= p.x (always shifted by the node position on the canvas)
      assert.ok(
        port.x === 0 || port.x === p.w,
        `port ${JSON.stringify(port)} nu e relativ (w=${p.w}, node.x=${p.x})`
      );
      // the port y is relative (in the port band, < the node height)
      assert.ok(port.y >= 0 && port.y <= p.h, `port.y ${port.y} nu e relativ`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "niciun port de verificat");
});

await test("layoutTb accepta seminte (ELK interactiv) fara sa crape", async () => {
  const scene = buildTbScene(CFG, "env", "d.yaml");
  const ids = scene.nodes.map((n) => n.id);
  // partial seeds: only a few nodes have positions
  const seeds = new Map([
    [ids[0], { x: 40, y: 40 }],
    [ids[1] ?? ids[0], { x: 40, y: 200 }],
  ]);
  const layout = await layoutTb(elk, scene, measure, seeds);
  // all scene nodes appear in the layout, the ports stay relative
  for (const n of scene.nodes) {
    assert.ok(layout.nodes.has(n.id), `nodul ${n.id} lipseste din layout`);
  }
  for (const p of layout.nodes.values()) {
    for (const port of p.ports.values()) {
      assert.ok(port.x === 0 || port.x === p.w, "port ne-relativ cu seminte");
    }
  }
});

await test("flip H pe un bloc: laturile porturilor se schimba vest<->est", async () => {
  const scene = buildTbScene(CFG, "agent:cmd", "d.yaml");
  const plain = await layoutTb(elk, scene, measure);
  const flips = new Map([["u.monitor", { h: true, v: false }]]);
  const flipped = await layoutTb(elk, scene, measure, undefined, flips);
  const sideOf = (layout, port) =>
    [...layout.nodes.get("u.monitor").node.ports].find((p) => p.port === port)?.side;
  // the monitor has if(west) + ap(east); flip H swaps their side
  assert.equal(sideOf(plain, "if"), "WEST");
  assert.equal(sideOf(plain, "ap"), "EAST");
  assert.equal(sideOf(flipped, "if"), "EAST");
  assert.equal(sideOf(flipped, "ap"), "WEST");
});

await test("flip pe steag = rasturnare LOCALA (flipH), fara sa mute latura ELK", async () => {
  // Flip on a flag is a LOCAL horizontal mirror: it mirrors the shape +
  // moves the anchor to the opposite side of the flag, BUT does not change its
  // ELK position/side (FIRST/LAST_SEPARATE stays satisfied, so ELK does NOT throw —
  // a flip on the opposite side would have thrown, see the probes in CLAUDE.md).
  const scene = buildTbScene(CFG, "agent:cmd", "d.yaml");
  const plain = await layoutTb(elk, scene, measure);
  const seeds = new Map(scene.nodes.map((n, i) => [n.id, { x: 40 + i * 180, y: 40 }]));
  scene.boundary.forEach((b, i) => seeds.set(b.id, { x: 600, y: 40 + i * 160 }));
  const flips = new Map([["<ap>", { h: true, v: false }]]);
  const flipped = await layoutTb(elk, scene, measure, seeds, flips); // does not throw
  const ap0 = plain.boundary.get("<ap>");
  const ap1 = flipped.boundary.get("<ap>");
  assert.equal(ap1.b.side, ap0.b.side); // ELK side unchanged (no throw)
  assert.equal(ap1.flipH, true); // but flipped locally (shape+anchor are mirrored)
  assert.ok(!plain.boundary.get("<ap>").flipH); // non-flipped by default
});

console.log(`\ntest-tblayout: ${passed} teste au trecut.`);
