// Node tests for the minimap math (src/webview/minimap.ts):
//   npm run test:minimap
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-minimap-"));
const outFile = join(outDir, "minimap.mjs");
await esbuild.build({
  entryPoints: ["src/webview/minimap.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { minimapLayout, minimapUseTransform, minimapViewRect, cameraForMinimapPoint } =
  await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

test("minimapLayout: incadrare centrata, scara uniforma", () => {
  // world 400x300 in minimap 180x120 pad 8: s = min(164/400, 104/300) = 104/300
  const l = minimapLayout({ x: 0, y: 0, w: 400, h: 300 }, 180, 120, 8);
  const s = 104 / 300;
  assert.ok(Math.abs(l.s - s) < 1e-9);
  // centered: on X, (180 - 400*s)/2 remains on each side; on Y exactly the pad
  assert.ok(Math.abs(l.ox - (180 - 400 * s) / 2) < 1e-9);
  assert.ok(Math.abs(l.oy - 8) < 1e-9);
});

test("minimapLayout: origine negativa (drag spre stanga/sus)", () => {
  const l = minimapLayout({ x: -100, y: -50, w: 200, h: 100 }, 180, 120, 8);
  // the world corner (-100,-50) must fall inside the minimap
  const cx = l.ox + l.s * -100;
  const cy = l.oy + l.s * -50;
  assert.ok(cx >= 0 && cy >= 0);
  // and the world center (0,0) at the minimap center
  assert.ok(Math.abs(l.ox - 90) < 1e-9);
  assert.ok(Math.abs(l.oy - 60) < 1e-9);
});

test("minimapUseTransform: camera identitate = plasarea lumii in minimap", () => {
  const l = { s: 0.25, ox: 10, oy: 20 };
  const t = minimapUseTransform(l, { tx: 0, ty: 0, k: 1 });
  assert.equal(t, "translate(10,20) scale(0.25)");
});

test("minimapViewRect: zona vizibila prin camera, in coordonate minimap", () => {
  // camera: zoom 2, translation (100, 40); canvas 800x600
  // visible world: x=(0-100)/2=-50 .. (800-100)/2=350 (w=400), y=-20..280 (h=300)
  const l = { s: 0.25, ox: 10, oy: 20 };
  const r = minimapViewRect(l, { tx: 100, ty: 40, k: 2 }, 800, 600);
  assert.ok(Math.abs(r.x - (10 + 0.25 * -50)) < 1e-9);
  assert.ok(Math.abs(r.y - (20 + 0.25 * -20)) < 1e-9);
  assert.ok(Math.abs(r.w - 0.25 * 400) < 1e-9);
  assert.ok(Math.abs(r.h - 0.25 * 300) < 1e-9);
});

test("cameraForMinimapPoint: dus-intors — centrul dreptunghiului de vedere", () => {
  // for any camera, the point at the CENTER of the view rectangle must
  // return exactly the same camera (fixpoint of the jump)
  const l = minimapLayout({ x: 0, y: 0, w: 640, h: 480 }, 180, 120, 8);
  const cam = { tx: -37, ty: 91, k: 1.4251 };
  const r = minimapViewRect(l, cam, 800, 600);
  const back = cameraForMinimapPoint(l, r.x + r.w / 2, r.y + r.h / 2, cam.k, 800, 600);
  assert.ok(Math.abs(back.tx - cam.tx) < 1e-6);
  assert.ok(Math.abs(back.ty - cam.ty) < 1e-6);
});

test("cameraForMinimapPoint: click pe proiectia unui punct il centreaza", () => {
  const l = minimapLayout({ x: 0, y: 0, w: 400, h: 400 }, 180, 120, 8);
  // the world point (100, 200), projected into the minimap
  const mx = l.ox + l.s * 100;
  const my = l.oy + l.s * 200;
  const cam = cameraForMinimapPoint(l, mx, my, 2, 800, 600);
  // on screen, the world point must fall in the center of the canvas
  assert.ok(Math.abs(2 * 100 + cam.tx - 400) < 1e-9);
  assert.ok(Math.abs(2 * 200 + cam.ty - 300) < 1e-9);
});

console.log(`\ntest-minimap: ${passed} teste au trecut.`);
