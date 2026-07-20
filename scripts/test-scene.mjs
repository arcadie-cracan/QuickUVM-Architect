// Node tests for building the schematic-view scene
// (src/webview/scene.ts — pure functions, no DOM), on the regression model
// examples/model.json (the criteria from CLAUDE.md):
//   npm run test:scene
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-scene-"));
const outFile = join(outDir, "scene.mjs");
await esbuild.build({
  entryPoints: ["src/webview/scene.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { buildSchematicScene, hasSchematic, netCone, coneOf, portLabel, splitLabel } = await import(pathToFileURL(outFile));

const model = JSON.parse(readFileSync("examples/model.json", "utf8"));
const none = new Set();

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

// ------------------------------------------------------- demo_top.u_soc

const soc = buildSchematicScene(model, "demo_top.u_soc", none);

test("hasSchematic: doar instantele cu vedere", () => {
  assert.equal(hasSchematic(model, "demo_top.u_soc"), true);
  assert.equal(hasSchematic(model, "demo_top.u_soc.u_add"), false);
  assert.equal(hasSchematic(undefined, "demo_top"), false);
});

test("u_soc: pliajul generate g_ch[0..2].u_ch (3 membri, chan #(W=16))", () => {
  const ids = soc.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["g_ch[0..2].u_ch", "u_add", "u_inv"]);
  const fold = soc.nodes.find((n) => n.id === "g_ch[0..2].u_ch");
  assert.equal(fold.kind, "fold");
  assert.equal(fold.foldCount, 3);
  assert.equal(fold.sub, "chan #(W=16)");
  assert.equal(fold.instPath, null);
});

test("u_soc: din (fanout 9, render=label) — etichete pe pini, zero muchii", () => {
  assert.equal(soc.edges.filter((e) => e.net === "din").length, 0);
  const uAddDin = soc.nodes
    .find((n) => n.id === "u_add")
    .pins.find((p) => p.port === "din");
  assert.equal(uAddDin.netLabel, "din");
  const foldDin = soc.nodes
    .find((n) => n.id === "g_ch[0..2].u_ch")
    .pins.find((p) => p.port === "din");
  assert.equal(foldDin.netLabel, "din");
});

test("u_soc: override-urile de nivel 4 bat sugestia din model", () => {
  // din: label in the model -> wire; ch_out: wire in the model -> label
  const ov = buildSchematicScene(
    model,
    "demo_top.u_soc",
    none,
    new Map([
      ["din", "wire"],
      ["ch_out", "label"],
    ])
  );
  assert.ok(ov.edges.filter((e) => e.net === "din").length >= 2);
  const uAddDin = ov.nodes
    .find((n) => n.id === "u_add")
    .pins.find((p) => p.port === "din");
  assert.equal(uAddDin.netLabel, null);
  assert.equal(ov.edges.filter((e) => e.net === "ch_out").length, 0);
  const foldOut = ov.nodes
    .find((n) => n.id === "g_ch[0..2].u_ch")
    .pins.find((p) => p.port === "dout");
  assert.equal(foldOut.netLabel, "ch_out");
});

test("u_soc: ch_out — o singura muchie dedup din pliaj spre granita", () => {
  const chOut = soc.edges.filter((e) => e.net === "ch_out");
  assert.equal(chOut.length, 1);
  assert.equal(chOut[0].source, "g_ch[0..2].u_ch");
  assert.equal(chOut[0].sourcePort, "g_ch[0..2].u_ch.dout");
  assert.equal(chOut[0].target, "<port>.ch_out");
  assert.equal(chOut[0].targetPort, null);
});

test("u_soc: pinul dout al pliajului poarta intervalul de selecturi [0..2]", () => {
  const dout = soc.nodes
    .find((n) => n.id === "g_ch[0..2].u_ch")
    .pins.find((p) => p.port === "dout");
  assert.equal(dout.note, "[0..2]");
});

test("u_soc: sum — muchie u_add.dout -> <port>.sum", () => {
  const sum = soc.edges.filter((e) => e.net === "sum");
  assert.equal(sum.length, 1);
  assert.equal(sum[0].sourcePort, "u_add.dout");
  assert.equal(sum[0].target, "<port>.sum");
});

test("u_soc: granita — intrarile west, iesirile east, interfata bus prezenta", () => {
  const side = new Map(soc.boundary.map((b) => [b.name, b.side]));
  assert.equal(side.get("clk"), "WEST");
  assert.equal(side.get("rst_n"), "WEST");
  assert.equal(side.get("din"), "WEST");
  assert.equal(side.get("sum"), "EAST");
  assert.equal(side.get("inv"), "EAST");
  assert.equal(side.get("ch_out"), "EAST");
  const bus = soc.boundary.find((b) => b.name === "bus");
  assert.equal(bus.iface, true);
  assert.equal(bus.label, "bus : reg_bus.slave");
});

test("u_soc: ch_out pe granita — tablou unpacked cu multiplicitate separata", () => {
  const chOut = soc.boundary.find((b) => b.name === "ch_out");
  assert.equal(chOut.mult, "×3");
  // compact label in SV declaration order: packed+name+unpacked, without
  // spaces (readability comes from coloring the dimensions differently)
  assert.equal(chOut.label, "[15:0]ch_out[0:2]");
});

test("portLabel: packed inaintea numelui, unpacked dupa, compact (ordinea SV)", () => {
  // unpacked array of vectors: packed [15:0] + name + unpacked [0:2], without spaces
  assert.equal(
    portLabel({ name: "ch_out", type: "logic[15:0]$[0:2]", elem_width: 16, width: 48 }),
    "[15:0]ch_out[0:2]"
  );
  // simple packed vector: only packed before the name
  assert.equal(portLabel({ name: "din", type: "logic[15:0]", elem_width: 16, width: 16 }), "[15:0]din");
  // 1-bit signal without array: only the name
  assert.equal(portLabel({ name: "clk", type: "logic", elem_width: 1, width: 1 }), "clk");
  // 1-bit unpacked array: no packed, but unpacked after the name
  assert.equal(portLabel({ name: "en", type: "logic$[0:3]", elem_width: 1, width: 4 }), "en[0:3]");
});

test("splitLabel: desparte eticheta compacta in packed/nume/unpacked", () => {
  assert.deepEqual(splitLabel("[15:0]ch_out[0:2]", "ch_out"), {
    packed: "[15:0]", name: "ch_out", unpacked: "[0:2]",
  });
  assert.deepEqual(splitLabel("[15:0]din", "din"), {
    packed: "[15:0]", name: "din", unpacked: "",
  });
  assert.deepEqual(splitLabel("clk", "clk"), { packed: "", name: "clk", unpacked: "" });
  assert.deepEqual(splitLabel("en[0:3]", "en"), {
    packed: "", name: "en", unpacked: "[0:3]",
  });
});

// --------------------------------------- demo_top.u_soc, expanded fold

const socExp = buildSchematicScene(
  model,
  "demo_top.u_soc",
  new Set(["g_ch[0..2].u_ch"])
);

test("u_soc expandat: 5 noduri, membrii poarta foldId pentru re-pliere", () => {
  assert.equal(socExp.nodes.length, 5);
  const m1 = socExp.nodes.find((n) => n.id === "g_ch[1].u_ch");
  assert.equal(m1.kind, "instance");
  assert.equal(m1.foldId, "g_ch[0..2].u_ch");
  assert.equal(m1.instPath, "demo_top.u_soc.g_ch[1].u_ch");
});

test("u_soc expandat: selectul per membru ([1] din constant, nu din genvar)", () => {
  const dout = socExp.nodes
    .find((n) => n.id === "g_ch[1].u_ch")
    .pins.find((p) => p.port === "dout");
  assert.equal(dout.note, "[1]");
});

test("u_soc expandat: ch_out are 3 muchii, membru -> granita (nu intre membri)", () => {
  const chOut = socExp.edges.filter((e) => e.net === "ch_out");
  assert.equal(chOut.length, 3);
  const sources = chOut.map((e) => e.sourcePort).sort();
  assert.deepEqual(sources, [
    "g_ch[0].u_ch.dout",
    "g_ch[1].u_ch.dout",
    "g_ch[2].u_ch.dout",
  ]);
  assert.ok(chOut.every((e) => e.target === "<port>.ch_out"));
});

// --------------------------------------------------------------- demo_top

const top = buildSchematicScene(model, "demo_top", none);

test("demo_top: bus_i e nod de interfata cu parametrii efectivi", () => {
  const busI = top.nodes.find((n) => n.id === "bus_i");
  assert.equal(busI.kind, "iface");
  assert.equal(busI.sub, "reg_bus #(AW=6)");
});

test("hasView: u_soc coboara in schema, frunzele si pliajele nu", () => {
  assert.equal(top.nodes.find((n) => n.id === "u_soc").hasView, true);
  assert.equal(top.nodes.find((n) => n.id === "bus_i").hasView, false);
  assert.equal(soc.nodes.find((n) => n.id === "u_add").hasView, false);
  assert.equal(
    soc.nodes.find((n) => n.id === "g_ch[0..2].u_ch").hasView,
    false
  );
});

test("demo_top: conexiunea de interfata bus_i -> u_soc.bus, o muchie iface", () => {
  const ifaces = top.edges.filter((e) => e.kind === "iface");
  assert.equal(ifaces.length, 1);
  assert.equal(ifaces[0].source, "bus_i");
  assert.equal(ifaces[0].targetPort, "u_soc.bus");
});

test("demo_top: tie-off si pini flotanti ca adnotari", () => {
  const uSoc = top.nodes.find((n) => n.id === "u_soc");
  assert.equal(uSoc.pins.find((p) => p.port === "rst_n").note, "=1'b1");
  assert.equal(uSoc.pins.find((p) => p.port === "sum").note, "nc");
});

test("demo_top: net fara sursa (clk condus intern) — primul capat tine loc", () => {
  const clk = top.edges.filter((e) => e.net === "clk");
  assert.equal(clk.length, 1);
  assert.equal(clk[0].sourcePort, "bus_i.clk");
  assert.equal(clk[0].targetPort, "u_soc.clk");
});

test("demo_top: net wire cu un singur capat — degradare la eticheta", () => {
  assert.equal(top.edges.filter((e) => e.net === "din").length, 0);
  const din = top.nodes
    .find((n) => n.id === "u_soc")
    .pins.find((p) => p.port === "din");
  assert.equal(din.netLabel, "din");
});

// ---------------------------- pin geometry on the grid (layoutSchematic)

const outFile2 = join(outDir, "schematic.mjs");
await esbuild.build({
  entryPoints: ["src/webview/schematic.ts"],
  outfile: outFile2,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { layoutSchematic } = await import(pathToFileURL(outFile2));
const ELK = require("elkjs/lib/elk.bundled.js");
const layout = await layoutSchematic(new ELK(), socExp, (t) => t.length * 7.2);

test("layout: pinii pe grila de 8 cu pas 16, nodurile multiple de 8", () => {
  const bports = new Set(socExp.boundary.map((b) => b.id));
  for (const c of layout.children ?? []) {
    if (bports.has(c.id)) {
      continue; // the boundary flags are not draggable (yet)
    }
    assert.equal(c.width % 8, 0, `${c.id}: latime ${c.width}`);
    assert.equal(c.height % 8, 0, `${c.id}: inaltime ${c.height}`);
    const bySide = { west: [], east: [] };
    for (const p of c.ports ?? []) {
      const center = p.y + p.height / 2;
      assert.equal(center % 8, 0, `${c.id}/${p.id}: centrul la ${center}`);
      bySide[p.x < c.width / 2 ? "west" : "east"].push(center);
    }
    for (const side of Object.values(bySide)) {
      side.sort((a, b) => a - b);
      for (let i = 1; i < side.length; i++) {
        assert.equal(
          side[i] - side[i - 1], 16, `${c.id}: pas ${side[i] - side[i - 1]}`
        );
      }
    }
  }
});

// ------------------------- total seeds (the reopen-drift regression)

// the full layout's positions become the view snapshot (docs/04: at the first
// gesture, the arrangement of the whole view belongs to the user); interactive mode
// with TOTAL seeds — including the boundary flags, which carry
// FIRST_SEPARATE/LAST_SEPARATE — must work without exceptions and
// return the same elements, which main.ts then forces exactly onto the
// seeds -> zero drift. With partial seeds, interactive ELK re-placed
// the flags by hundreds of px from the full layout (a real regression).
const totalSeeds = new Map(
  (layout.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }])
);
const relayout = await layoutSchematic(
  new ELK(), socExp, (t) => t.length * 7.2, undefined, totalSeeds
);

test("seminte totale: re-layout interactiv fara exceptii, aceleasi elemente", () => {
  const ids = new Set((relayout.children ?? []).map((c) => c.id));
  for (const c of layout.children ?? []) {
    assert.ok(ids.has(c.id), `lipseste ${c.id} la re-layout interactiv`);
  }
  assert.equal(ids.size, (layout.children ?? []).length);
});

// -------------------------------------------- flipping the blocks (flip)

const measureStub = (t) => t.length * 7.2;
const layoutFlipH = await layoutSchematic(
  new ELK(), top, measureStub, new Map([["u_soc", { h: true, v: false }]])
);
const layoutFlipV = await layoutSchematic(
  new ELK(), top, measureStub, new Map([["u_soc", { h: false, v: true }]])
);

test("flip orizontal: laturile vest<->est se schimba, sloturile raman", () => {
  const n = layoutFlipH.children.find((c) => c.id === "u_soc");
  const clk = n.ports.find((p) => p.id === "u_soc.clk");
  const sum = n.ports.find((p) => p.id === "u_soc.sum");
  assert.equal(clk.x, n.width - 4, "clk (in) trece pe est");
  assert.equal(sum.x, -4, "sum (out) trece pe vest");
  assert.equal(clk.y + 4, 40, "clk ramane in primul slot");
});

test("flip vertical: ordinea pinilor se inverseaza pe fiecare latura", () => {
  const n = layoutFlipV.children.find((c) => c.id === "u_soc");
  const clk = n.ports.find((p) => p.id === "u_soc.clk");
  const bus = n.ports.find((p) => p.id === "u_soc.bus");
  // west has 4 pins (clk, rst_n, din, bus): clk ends up last, bus first
  // (pin step PIN_PITCH=24, first center at PIN_TOP=40)
  assert.equal(clk.x, -4, "clk ramane pe vest");
  assert.equal(clk.y + 4, 40 + 24 * 3, "clk in ultimul slot vest");
  assert.equal(bus.y + 4, 40, "bus in primul slot vest");
});

// --------------------------------------------- the connectivity cone (phase 4)

test("netCone aval: prin etichetele de net (din, fanout 9) si mai departe", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  // din is a net with render=label (no edges): the cone must pass through
  // pin.nets — all three consumers (the fold is ONE node, as on screen),
  // then transitively through their outputs up to the boundary flags
  const down = netCone(s, { net: "din" }, "down");
  assert.deepEqual(
    [...down].sort(),
    ["<port>.ch_out", "<port>.inv", "<port>.sum",
     "ch_out", "din", "g_ch[0..2].u_ch", "inv", "sum", "u_add", "u_inv"]
  );
});

test("netCone amonte: directia conteaza + steagul granitei intra in con", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  // upstream of u_add: the net that feeds it (din) + its boundary flag
  // <port>.din (net-label that touches the boundary — the boundary endpoint is NOT
  // lost, adversarial review); NOT the siblings that also read din
  assert.deepEqual(
    [...netCone(s, { node: "u_add" }, "up")].sort(),
    ["<port>.din", "din", "u_add"]
  );
  // downstream of u_add: its output and its flag
  assert.deepEqual(
    [...netCone(s, { node: "u_add" }, "down")].sort(),
    ["<port>.sum", "sum", "u_add"]
  );
  // upstream of ch_out (wire net): the fold + din + the flag <port>.din (transitive
  // chain through the label up to the boundary)
  assert.deepEqual(
    [...netCone(s, { net: "ch_out" }, "up")].sort(),
    ["<port>.din", "ch_out", "din", "g_ch[0..2].u_ch"]
  );
});

test("netCone: steagul granitei pe net-eticheta e samanta valida (fix boundary)", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  // <port>.din carries the label net `din`: SceneBPort.nets holds it
  const bDin = s.boundary.find((b) => b.id === "<port>.din");
  assert.deepEqual(bDin.nets, ["din"]);
  // seed from the flag: the downstream cone is complete (not empty, as before the fix)
  assert.deepEqual(
    [...netCone(s, { node: "<port>.din" }, "down")].sort(),
    ["<port>.ch_out", "<port>.din", "<port>.inv", "<port>.sum",
     "ch_out", "din", "g_ch[0..2].u_ch", "inv", "sum", "u_add", "u_inv"]
  );
});

test("coneOf: pin din interiorul blocului -> conul netului, nu net inexistent", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  // click on the pin u_add.din (group data-id) — it is NOT a node/net; it resolves to
  // the pin's nets, not to a useless seed {net:"u_add.din"} (review)
  assert.deepEqual(
    [...coneOf(s, "u_add.din", "down")].sort(),
    [...netCone(s, { net: "din" }, "down")].sort()
  );
  // output pin (wire): the cone from the net wired on it (dout -> net sum)
  assert.deepEqual(
    [...coneOf(s, "u_add.dout", "down")].sort(),
    ["<port>.sum", "sum"]
  );
  // node, flag and net name stay correctly classified
  assert.deepEqual([...coneOf(s, "u_add", "down")].sort(), ["<port>.sum", "sum", "u_add"]);
  assert.ok(coneOf(s, "<port>.din", "down").size > 1);
  assert.deepEqual(
    [...coneOf(s, "din", "up")].sort(),
    [...netCone(s, { net: "din" }, "up")].sort()
  );
  // unrecognized id -> null (the caller does NOT touch the selection)
  assert.equal(coneOf(s, "does.not.exist", "down"), null);
});

test("latimi pe scena: pin/bport = elemW, edge = netWidth (nu prin select)", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  const bw = (name) => s.boundary.find((b) => b.name === name)?.width;
  // the view ports: elem_width (ch_out is unpacked 3×16 -> elemW=16)
  assert.equal(bw("clk"), 1);
  assert.equal(bw("din"), 8);
  assert.equal(bw("ch_out"), 16);
  assert.equal(s.boundary.find((b) => b.iface)?.width, null); // interfata
  // the edges: the NET width (netWidth) — ch_out=48 (the whole port), NOT 16
  // from the select pins; sum/inv=8
  const ew = (net) => s.edges.find((e) => e.net === net && e.kind === "wire")?.width;
  assert.equal(ew("ch_out"), 48, "latimea netului, nu a pinilor de select");
  assert.equal(ew("sum"), 8);
  // the pins of a child instance carry their own width
  const uadd = s.nodes.find((n) => n.id === "u_add");
  assert.equal(uadd.pins.find((p) => p.port === "dout")?.width, 8);
  assert.equal(uadd.pins.find((p) => p.port === "din")?.width, 8);
});

test("noteKind: discriminatorul adnotarii (select/concat/const/nc) pe model real", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  const pin = (nid, port) => s.nodes.find((n) => n.id === nid)?.pins.find((p) => p.port === port);
  // the g_ch fold: dout via select (`[0..2]`), din via concat (`{…}`)
  assert.equal(pin("g_ch[0..2].u_ch", "dout")?.noteKind, "select");
  assert.equal(pin("g_ch[0..2].u_ch", "din")?.noteKind, "concat");
  // in demo_top: u_soc.rst_n = 1'b1 (const), the unmapped outputs = nc
  const top = buildSchematicScene(model, "demo_top", none);
  const tp = (port) => top.nodes.find((n) => n.id === "u_soc")?.pins.find((p) => p.port === port);
  assert.equal(tp("rst_n")?.noteKind, "const");
  assert.equal(tp("rst_n")?.note, "=1'b1");
  assert.equal(tp("sum")?.noteKind, "nc");
  // pure net/iface: no annotation (kind null)
  assert.equal(tp("clk")?.noteKind, null);
});

test("netCone: pin.nets e masina (netLabel ramane doar afisare)", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  const labeled = s.nodes.flatMap((n) => n.pins.filter((p) => p.nets.length));
  assert.equal(labeled.length, 3, "din etichetat pe cei trei consumatori");
  assert.ok(labeled.every((p) => p.nets.includes("din") && p.netLabel));
});

console.log(`\ntest-scene: ${passed} teste au trecut.`);
