// Teste Node pentru mutatiile pure ale sidecar-ului de layout
// (src/sidecarops.ts), pe modelul de regresie examples/model.json:
//   npm run test:sidecar
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-sidecar-"));
const outFile = join(outDir, "sidecarops.mjs");
await esbuild.build({
  entryPoints: ["src/sidecarops.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  // pachetul CJS `yaml` cere shim-ul createRequire la legarea ESM
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const ops = await import(pathToFileURL(outFile));

const model = JSON.parse(readFileSync("examples/model.json", "utf8"));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

test("roundtrip: pozitii + fold supravietuiesc serializarii", () => {
  const d = ops.emptySidecar();
  ops.setNodePos(d, "demo_top.u_soc", "u_add", 120, 80);
  ops.setFold(d, "demo_top.u_soc", "g_ch[0..2].u_ch", false);
  const text = ops.serializeSidecar(d);
  const back = ops.parseSidecar(text);
  assert.deepEqual(back.views["demo_top.u_soc"].nodes["u_add"], { x: 120, y: 80 });
  assert.deepEqual(back.views["demo_top.u_soc"].nodes["g_ch[0..2].u_ch"], {
    collapsed: false,
  });
  // camera nu se persista (stare de sesiune, docs/04): un camp mostenit
  // dintr-un fisier vechi dispare la serializare
  assert.equal(text.includes("camera"), false);
});

test("minimalitate: re-plierea sterge intrarea fara pozitie; vederea goala dispare", () => {
  const d = ops.emptySidecar();
  ops.setFold(d, "demo_top.u_soc", "g_ch[0..2].u_ch", false);
  ops.setFold(d, "demo_top.u_soc", "g_ch[0..2].u_ch", true);
  assert.deepEqual(d.views, {});
});

test("minimalitate: pliaj mutat + re-pliat pastreaza doar pozitia", () => {
  const d = ops.emptySidecar();
  ops.setNodePos(d, "demo_top.u_soc", "g_ch[0..2].u_ch", 300, 150);
  ops.setFold(d, "demo_top.u_soc", "g_ch[0..2].u_ch", false);
  ops.setFold(d, "demo_top.u_soc", "g_ch[0..2].u_ch", true);
  assert.deepEqual(d.views["demo_top.u_soc"].nodes["g_ch[0..2].u_ch"], {
    x: 300,
    y: 150,
  });
});

test("serializare determinista: chei sortate, stabila la ordinea inserarii", () => {
  const a = ops.emptySidecar();
  ops.setNodePos(a, "demo_top.u_soc", "u_inv", 1, 2);
  ops.setNodePos(a, "demo_top.u_soc", "u_add", 3, 4);
  ops.setNodePos(a, "demo_top", "u_soc", 5, 6);
  const b = ops.emptySidecar();
  ops.setNodePos(b, "demo_top", "u_soc", 5, 6);
  ops.setNodePos(b, "demo_top.u_soc", "u_add", 3, 4);
  ops.setNodePos(b, "demo_top.u_soc", "u_inv", 1, 2);
  assert.equal(ops.serializeSidecar(a), ops.serializeSidecar(b));
});

test("validNodeKeys: noduri, pliaje si membrii pliajelor; null pe frunze", () => {
  const keys = ops.validNodeKeys(model, "demo_top.u_soc");
  for (const k of ["u_add", "u_inv", "g_ch[0..2].u_ch", "g_ch[1].u_ch"]) {
    assert.ok(keys.has(k), `lipseste ${k}`);
  }
  assert.equal(ops.validNodeKeys(model, "demo_top.u_soc.u_add"), null);
});

test("invalidate: cheile disparute migreaza in orphans cu lastSeen, nu se sterg", () => {
  const d = ops.emptySidecar();
  ops.setNodePos(d, "demo_top.u_soc", "u_add", 120, 80);
  ops.setNodePos(d, "demo_top.u_soc", "u_vechi", 1, 1);
  ops.setNodePos(d, "vedere.disparuta", "x", 2, 2);
  const changed = ops.invalidate(d, model, "2026-07-11");
  assert.equal(changed, true);
  assert.deepEqual(d.views["demo_top.u_soc"].nodes, { u_add: { x: 120, y: 80 } });
  assert.equal(d.views["vedere.disparuta"], undefined);
  assert.deepEqual(
    d.orphans.map((o) => `${o.view}/${o.node}`).sort(),
    ["demo_top.u_soc/u_vechi", "vedere.disparuta/x"]
  );
  assert.ok(d.orphans.every((o) => o.lastSeen === "2026-07-11"));
});

test("invalidate: orfanele reaparute se restaureaza (eroare temporara)", () => {
  const d = ops.emptySidecar();
  d.orphans.push({
    view: "demo_top.u_soc",
    node: "u_add",
    value: { x: 77, y: 88 },
    lastSeen: "2026-07-01",
  });
  const changed = ops.invalidate(d, model, "2026-07-11");
  assert.equal(changed, true);
  assert.deepEqual(d.views["demo_top.u_soc"].nodes["u_add"], { x: 77, y: 88 });
  assert.equal(d.orphans.length, 0);
});

test("invalidate: restaurarea nu calca peste un override mai nou", () => {
  const d = ops.emptySidecar();
  ops.setNodePos(d, "demo_top.u_soc", "u_add", 500, 500);
  d.orphans.push({
    view: "demo_top.u_soc",
    node: "u_add",
    value: { x: 77, y: 88 },
    lastSeen: "2026-07-01",
  });
  ops.invalidate(d, model, "2026-07-11");
  assert.deepEqual(d.views["demo_top.u_soc"].nodes["u_add"], { x: 500, y: 500 });
  assert.equal(d.orphans.length, 0);
});

test("invalidate: sidecar curat ramane neschimbat (changed=false)", () => {
  const d = ops.emptySidecar();
  ops.setNodePos(d, "demo_top.u_soc", "u_add", 120, 80);
  assert.equal(ops.invalidate(d, model, "2026-07-11"), false);
});

test("parseSidecar: versiune necunoscuta si YAML invalid arunca", () => {
  assert.throws(() => ops.parseSidecar("schema_version: 99\nviews: {}\n"));
  assert.throws(() => ops.parseSidecar("[nu, e, obiect]"));
  assert.deepEqual(ops.parseSidecar(""), ops.emptySidecar());
});

test("setFlip: persista doar true; prune la revenirea la implicit", () => {
  const d = ops.emptySidecar();
  ops.setFlip(d, "demo_top", "u_soc", true, false);
  assert.deepEqual(d.views["demo_top"].nodes["u_soc"], { flipH: true });
  ops.setFlip(d, "demo_top", "u_soc", true, true);
  assert.deepEqual(d.views["demo_top"].nodes["u_soc"], {
    flipH: true,
    flipV: true,
  });
  ops.setFlip(d, "demo_top", "u_soc", false, false);
  assert.deepEqual(d.views, {});
  // flip + pozitie: revenirea la ne-rasturnat pastreaza pozitia
  ops.setNodePos(d, "demo_top", "u_soc", 8, 16);
  ops.setFlip(d, "demo_top", "u_soc", true, false);
  ops.setFlip(d, "demo_top", "u_soc", false, false);
  assert.deepEqual(d.views["demo_top"].nodes["u_soc"], { x: 8, y: 16 });
});

test("clearPositions: sterge x/y, pastreaza pliaje si rasturnari", () => {
  const d = ops.emptySidecar();
  ops.setNodePos(d, "demo_top.u_soc", "u_add", 120, 80);
  ops.setNodePos(d, "demo_top.u_soc", "u_inv", 8, 8);
  ops.setFold(d, "demo_top.u_soc", "g_ch[0..2].u_ch", false);
  ops.setFlip(d, "demo_top.u_soc", "u_inv", true, false);
  ops.setNodePos(d, "demo_top", "u_soc", 1, 2);
  ops.clearPositions(d, "demo_top.u_soc");
  assert.deepEqual(d.views["demo_top.u_soc"].nodes, {
    "g_ch[0..2].u_ch": { collapsed: false },
    u_inv: { flipH: true },
  });
  // alta vedere ramane neatinsa
  assert.deepEqual(d.views["demo_top"].nodes["u_soc"], { x: 1, y: 2 });
});

test("setPositions: snapshot-ul scrie tot, pastreaza pliaje/rasturnari", () => {
  const d = ops.emptySidecar();
  ops.setFold(d, "demo_top.u_soc", "g_ch[0..2].u_ch", false);
  ops.setFlip(d, "demo_top.u_soc", "u_inv", true, false);
  ops.setPositions(d, "demo_top.u_soc", {
    u_add: { x: 8, y: 16 },
    u_inv: { x: 24, y: 32 },
    "<port>.clk": { x: -80, y: 0 },
    "g_ch[0..2].u_ch": { x: 120, y: 64 },
  });
  const nodes = d.views["demo_top.u_soc"].nodes;
  assert.deepEqual(nodes["u_add"], { x: 8, y: 16 });
  assert.deepEqual(nodes["u_inv"], { flipH: true, x: 24, y: 32 });
  assert.deepEqual(nodes["<port>.clk"], { x: -80, y: 0 });
  assert.deepEqual(nodes["g_ch[0..2].u_ch"], { collapsed: false, x: 120, y: 64 });
});

test("setNetRender: abaterea se persista; alegerea sugestiei o sterge", () => {
  const d = ops.emptySidecar();
  // din are render=label in model (fanout 9); utilizatorul cere fir
  ops.setNetRender(d, "demo_top.u_soc", "din", "wire", "label");
  assert.deepEqual(d.views["demo_top.u_soc"].nets, { din: { render: "wire" } });
  const back = ops.parseSidecar(ops.serializeSidecar(d));
  assert.deepEqual(back.views["demo_top.u_soc"].nets, {
    din: { render: "wire" },
  });
  // revenirea la sugestie sterge override-ul si vederea goala dispare
  ops.setNetRender(d, "demo_top.u_soc", "din", "label", "label");
  assert.deepEqual(d.views, {});
});

test("clearPositions: pastreaza override-urile de net", () => {
  const d = ops.emptySidecar();
  ops.setNodePos(d, "demo_top.u_soc", "u_add", 8, 8);
  ops.setNetRender(d, "demo_top.u_soc", "din", "wire", "label");
  ops.clearPositions(d, "demo_top.u_soc");
  assert.deepEqual(d.views["demo_top.u_soc"], {
    nets: { din: { render: "wire" } },
  });
});

test("invalidate: net disparut migreaza cu kind=net; reaparut se restaureaza", () => {
  const d = ops.emptySidecar();
  ops.setNetRender(d, "demo_top.u_soc", "net_disparut", "wire", "label");
  ops.setNetRender(d, "demo_top.u_soc", "din", "wire", "label");
  assert.equal(ops.invalidate(d, model, "2026-07-11"), true);
  assert.deepEqual(d.views["demo_top.u_soc"].nets, { din: { render: "wire" } });
  assert.deepEqual(d.orphans, [
    {
      view: "demo_top.u_soc",
      node: "net_disparut",
      kind: "net",
      value: { render: "wire" },
      lastSeen: "2026-07-11",
    },
  ]);
  // "reaparitia": orfanul primeste numele unui net real si se restaureaza
  d.orphans[0].node = "sum";
  ops.invalidate(d, model, "2026-07-12");
  assert.deepEqual(d.views["demo_top.u_soc"].nets, {
    din: { render: "wire" },
    sum: { render: "wire" },
  });
  assert.equal(d.orphans.length, 0);
});

test("cleanOrphans: goleste lista", () => {
  const d = ops.emptySidecar();
  d.orphans.push({ view: "v", node: "n", value: { x: 1, y: 1 }, lastSeen: "azi" });
  ops.cleanOrphans(d);
  assert.deepEqual(d.orphans, []);
});

console.log(`\ntest-sidecar: ${passed} teste au trecut.`);
