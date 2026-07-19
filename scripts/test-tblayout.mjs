// Teste Node pentru layoutul vederii de verificare (src/webview/tbschematic.ts
// — layoutTb cu ELK real): npm run test:tblayout
//
// Acopera invariantii cheie ai driftului de la felia „drag + pozitii TB":
//  - porturile TbPlaced sunt RELATIVE la originea nodului (ancora = n.x +
//    offset), nu absolute — altfel firele nu urmeaza blocul la drag;
//  - layoutTb accepta seminte (ELK interactiv) fara sa crape.
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
  // `router`/`svg` sunt ESM curat; elkjs (CJS) se leaga prin require in banner
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

await test("porturile sunt RELATIVE la originea nodului (0 sau w)", async () => {
  const scene = buildTbScene(CFG, "", "d.yaml");
  const layout = await layoutTb(elk, scene, measure);
  let checked = 0;
  for (const p of layout.nodes.values()) {
    for (const port of p.ports.values()) {
      // relativ: WEST = 0, EAST = latimea nodului. Absolut ar fi p.x + offset,
      // adica >= p.x (mereu deplasat cu pozitia nodului pe canvas)
      assert.ok(
        port.x === 0 || port.x === p.w,
        `port ${JSON.stringify(port)} nu e relativ (w=${p.w}, node.x=${p.x})`
      );
      // y-ul portului e relativ (in banda de porturi, < inaltimea nodului)
      assert.ok(port.y >= 0 && port.y <= p.h, `port.y ${port.y} nu e relativ`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "niciun port de verificat");
});

await test("layoutTb accepta seminte (ELK interactiv) fara sa crape", async () => {
  const scene = buildTbScene(CFG, "env", "d.yaml");
  const ids = scene.nodes.map((n) => n.id);
  // seminte partiale: doar cateva noduri au pozitii
  const seeds = new Map([
    [ids[0], { x: 40, y: 40 }],
    [ids[1] ?? ids[0], { x: 40, y: 200 }],
  ]);
  const layout = await layoutTb(elk, scene, measure, seeds);
  // toate nodurile scenei apar in layout, porturile raman relative
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
  // monitorul are if(vest) + ap(est); flip H le schimba latura
  assert.equal(sideOf(plain, "if"), "WEST");
  assert.equal(sideOf(plain, "ap"), "EAST");
  assert.equal(sideOf(flipped, "if"), "EAST");
  assert.equal(sideOf(flipped, "ap"), "WEST");
});

await test("flip pe steag = rasturnare LOCALA (flipH), fara sa mute latura ELK", async () => {
  // Flip pe un steag e o rasturnare LOCALA pe orizontala: oglindeste forma +
  // muta ancora pe latura opusa a steagului, DAR nu-i schimba pozitia/latura
  // ELK (FIRST/LAST_SEPARATE ramane satisfacut, deci ELK NU arunca — flip pe
  // latura opusa ar fi aruncat, vezi probele din CLAUDE.md).
  const scene = buildTbScene(CFG, "agent:cmd", "d.yaml");
  const plain = await layoutTb(elk, scene, measure);
  const seeds = new Map(scene.nodes.map((n, i) => [n.id, { x: 40 + i * 180, y: 40 }]));
  scene.boundary.forEach((b, i) => seeds.set(b.id, { x: 600, y: 40 + i * 160 }));
  const flips = new Map([["<ap>", { h: true, v: false }]]);
  const flipped = await layoutTb(elk, scene, measure, seeds, flips); // nu arunca
  const ap0 = plain.boundary.get("<ap>");
  const ap1 = flipped.boundary.get("<ap>");
  assert.equal(ap1.b.side, ap0.b.side); // latura ELK neschimbata (fara aruncare)
  assert.equal(ap1.flipH, true); // dar rasturnat local (forma+ancora se oglindesc)
  assert.ok(!plain.boundary.get("<ap>").flipH); // implicit ne-rasturnat
});

console.log(`\ntest-tblayout: ${passed} teste au trecut.`);
