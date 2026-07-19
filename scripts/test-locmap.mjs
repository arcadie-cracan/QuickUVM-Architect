// Teste Node pentru cross-probing-ul editor->diagrama (src/locmap.ts):
//   npm run test:locmap
// Ruleaza pe modelul REAL (examples/model.json) — aceleasi fapte pe care le
// verifica si testele svmodel, deci o schimbare de fixture pica zgomotos aici.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-locmap-"));
const outFile = join(outDir, "locmap.mjs");
await esbuild.build({
  entryPoints: ["src/locmap.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { buildLocIndex, resolveLoc, probeIds, remapSelection } = await import(pathToFileURL(outFile));

const model = JSON.parse(readFileSync("examples/model.json", "utf8"));
const idx = buildLocIndex(model);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

test("buildLocIndex: fisierele modelului, intrari sortate pe linie", () => {
  assert.ok(idx.has("soc_top.sv"));
  assert.ok(idx.has("chan.sv"));
  const chan = idx.get("chan.sv");
  for (let i = 1; i < chan.length; i++) {
    assert.ok(chan[i - 1].line <= chan[i].line);
  }
  // porturile sunt exactOnly, modulul nu
  assert.ok(chan.find((e) => e.target.kind === "port").exactOnly);
  assert.ok(!chan.find((e) => e.target.kind === "module").exactOnly);
});

test("resolveLoc: exact pe linia unui port -> portul", () => {
  // chan.sv:7 = declaratia portului din
  const t = resolveLoc(idx.get("chan.sv"), 7);
  assert.deepEqual(t, [{ kind: "port", module: "chan", port: "din" }]);
});

test("resolveLoc: linia instantierii generate -> TOATE instantele", () => {
  // soc_top.sv:24 = `chan #(.W(CW)) u_ch` — impartita de g_ch[0..2]
  const t = resolveLoc(idx.get("soc_top.sv"), 24);
  assert.equal(t.length, 3);
  assert.ok(t.every((x) => x.kind === "instance"));
  assert.deepEqual(
    t.map((x) => x.path).sort(),
    [
      "demo_top.u_soc.g_ch[0].u_ch",
      "demo_top.u_soc.g_ch[1].u_ch",
      "demo_top.u_soc.g_ch[2].u_ch",
    ]
  );
});

test("resolveLoc: cuprindere — sub instantiere cade pe instanta de deasupra", () => {
  // soc_top.sv:22 (linie goala) si 23 (`for (genvar…`) sunt intre u_inv (21)
  // si g_ch (24): cea mai apropiata deasupra care cuprinde e instanta u_inv
  // (porturile NU se intind — doar exact)
  assert.deepEqual(resolveLoc(idx.get("soc_top.sv"), 22), [
    { kind: "instance", path: "demo_top.u_soc.u_inv" },
  ]);
  assert.deepEqual(resolveLoc(idx.get("soc_top.sv"), 23), [
    { kind: "instance", path: "demo_top.u_soc.u_inv" },
  ]);
});

test("resolveLoc: ANSI — antetul si primul port pe aceeasi linie -> portul", () => {
  // soc_top.sv:3 = `interface reg_bus ... (input logic clk ...)` — modulul
  // reg_bus si portul clk impart linia; portul e mai specific
  const t = resolveLoc(idx.get("soc_top.sv"), 3);
  assert.deepEqual(t, [{ kind: "port", module: "reg_bus", port: "clk" }]);
});

test("resolveLoc: inainte de orice element / fisier necunoscut -> nimic", () => {
  assert.deepEqual(resolveLoc(idx.get("soc_top.sv"), 1), []);
  assert.deepEqual(resolveLoc(idx.get("nu-exista.sv"), 10), []);
});

// ------------------------------------------------ probeIds pe vederea curenta

/** contextul vederii demo_top.u_soc cu pliajul g_ch inchis (ca in webview) */
const CTX = {
  mode: "schematic",
  viewId: "demo_top.u_soc",
  viewModule: "soc_top",
  nodes: [
    { id: "u_add", instPath: "demo_top.u_soc.u_add", module: "adder" },
    { id: "u_inv", instPath: "demo_top.u_soc.u_inv", module: "inverter" },
    {
      id: "g_ch[0..2].u_ch",
      instPath: null,
      module: "chan",
      memberPaths: [
        "demo_top.u_soc.g_ch[0].u_ch",
        "demo_top.u_soc.g_ch[1].u_ch",
        "demo_top.u_soc.g_ch[2].u_ch",
      ],
    },
  ],
};

test("probeIds: instanta directa -> nodul ei; membru pliat -> pliajul", () => {
  assert.deepEqual(
    probeIds([{ kind: "instance", path: "demo_top.u_soc.u_add" }], CTX),
    ["u_add"]
  );
  assert.deepEqual(
    probeIds([{ kind: "instance", path: "demo_top.u_soc.g_ch[1].u_ch" }], CTX),
    ["g_ch[0..2].u_ch"]
  );
});

test("probeIds: tinta mai adanca -> copilul care o CONTINE", () => {
  assert.deepEqual(
    probeIds([{ kind: "instance", path: "demo_top.u_soc.u_add.u_deep" }], CTX),
    ["u_add"]
  );
  // membru de pliaj cu adancime: prin memberPaths
  assert.deepEqual(
    probeIds(
      [{ kind: "instance", path: "demo_top.u_soc.g_ch[2].u_ch.u_leaf" }],
      CTX
    ),
    ["g_ch[0..2].u_ch"]
  );
});

test("probeIds: port de copil -> pinul; port al vederii -> steagul", () => {
  assert.deepEqual(probeIds([{ kind: "port", module: "chan", port: "din" }], CTX), [
    "g_ch[0..2].u_ch.din",
  ]);
  assert.deepEqual(
    probeIds([{ kind: "port", module: "soc_top", port: "din" }], CTX),
    ["<port>.din"]
  );
});

test("probeIds: modul -> toate instantele lui din vedere; tb -> nimic", () => {
  assert.deepEqual(probeIds([{ kind: "module", module: "chan" }], CTX), [
    "g_ch[0..2].u_ch",
  ]);
  assert.deepEqual(
    probeIds([{ kind: "module", module: "chan" }], { ...CTX, mode: "tb" }),
    []
  );
});

test("probeIds: simbol — doar porturile modulului desenat", () => {
  const sym = {
    mode: "symbol",
    viewId: "demo_top.u_soc.u_add",
    viewModule: "adder",
    nodes: [],
  };
  assert.deepEqual(
    probeIds([{ kind: "port", module: "adder", port: "din" }], sym),
    ["<port>.din"]
  );
  assert.deepEqual(
    probeIds([{ kind: "port", module: "chan", port: "din" }], sym),
    []
  );
  assert.deepEqual(
    probeIds([{ kind: "instance", path: "demo_top.u_soc.u_add" }], sym),
    []
  );
});

test("probeIds: instantele generate (mai multe tinte) aprind pliajul o data", () => {
  const targets = resolveLoc(idx.get("soc_top.sv"), 24);
  assert.deepEqual(probeIds(targets, CTX), ["g_ch[0..2].u_ch"]);
});

test("remapSelection: rel-urile membrilor pliati -> pliajul, o singura data", () => {
  // cazul „Reveal in Diagram" pe linia generate cu pliajul INCHIS (implicitul):
  // host-ul trimite rel-urile membrilor, dar in DOM exista doar pliajul
  const out = remapSelection(
    ["g_ch[0].u_ch", "g_ch[1].u_ch", "g_ch[2].u_ch"],
    "demo_top.u_soc",
    CTX.nodes
  );
  assert.deepEqual(out, ["g_ch[0..2].u_ch"]);
});

test("remapSelection: id-urile existente si cele straine raman neatinse", () => {
  const out = remapSelection(
    ["u_add", "<port>.din", "necunoscut"],
    "demo_top.u_soc",
    CTX.nodes
  );
  assert.deepEqual(out.sort(), ["<port>.din", "necunoscut", "u_add"]);
});

console.log(`\ntest-locmap: ${passed} teste au trecut.`);
