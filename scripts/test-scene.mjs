// Teste Node pentru construirea scenei vederii-schema
// (src/webview/scene.ts — functii pure, fara DOM), pe modelul de regresie
// examples/model.json (criteriile din CLAUDE.md):
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
  // din: label in model -> fir; ch_out: wire in model -> eticheta
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
  // eticheta compacta in ordinea de declarare SV: packed+nume+unpacked, fara
  // spatii (lizibilitatea vine din colorarea diferita a dimensiunilor)
  assert.equal(chOut.label, "[15:0]ch_out[0:2]");
});

test("portLabel: packed inaintea numelui, unpacked dupa, compact (ordinea SV)", () => {
  // tablou unpacked de vectori: packed [15:0] + nume + unpacked [0:2], fara spatii
  assert.equal(
    portLabel({ name: "ch_out", type: "logic[15:0]$[0:2]", elem_width: 16, width: 48 }),
    "[15:0]ch_out[0:2]"
  );
  // vector packed simplu: doar packed inaintea numelui
  assert.equal(portLabel({ name: "din", type: "logic[15:0]", elem_width: 16, width: 16 }), "[15:0]din");
  // semnal de 1 bit fara tablou: doar numele
  assert.equal(portLabel({ name: "clk", type: "logic", elem_width: 1, width: 1 }), "clk");
  // tablou unpacked de 1 bit: fara packed, dar cu unpacked dupa nume
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

// --------------------------------------- demo_top.u_soc, pliaj expandat

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

// ---------------------------- geometria pinilor pe grila (layoutSchematic)

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
      continue; // steagurile granitei nu sunt draggabile (inca)
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

// ------------------------- seminte totale (regresia driftului la redeschidere)

// pozitiile layout-ului complet devin snapshot-ul vederii (docs/04: la primul
// gest, aranjamentul intregii vederi e al utilizatorului); modul interactiv
// cu seminte TOTALE — inclusiv steagurile granitei, care poarta
// FIRST_SEPARATE/LAST_SEPARATE — trebuie sa mearga fara exceptii si sa
// intoarca aceleasi elemente, pe care main.ts le forteaza apoi exact pe
// seminte -> zero drift. Cu seminte partiale, ELK interactiv re-plasa
// steagurile cu sute de px fata de layout-ul complet (regresie reala).
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

// -------------------------------------------- rasturnarea blocurilor (flip)

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
  // vest are 4 pini (clk, rst_n, din, bus): clk ajunge ultimul, bus primul
  // (pas de pin PIN_PITCH=24, primul centru la PIN_TOP=40)
  assert.equal(clk.x, -4, "clk ramane pe vest");
  assert.equal(clk.y + 4, 40 + 24 * 3, "clk in ultimul slot vest");
  assert.equal(bus.y + 4, 40, "bus in primul slot vest");
});

// --------------------------------------------- conul de conectivitate (faza 4)

test("netCone aval: prin etichetele de net (din, fanout 9) si mai departe", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  // din e net cu render=label (fara muchii): conul trebuie sa treaca prin
  // pin.nets — toti cei trei consumatori (pliajul e UN nod, ca pe ecran),
  // apoi tranzitiv prin iesirile lor pana la steagurile de granita
  const down = netCone(s, { net: "din" }, "down");
  assert.deepEqual(
    [...down].sort(),
    ["<port>.ch_out", "<port>.inv", "<port>.sum",
     "ch_out", "din", "g_ch[0..2].u_ch", "inv", "sum", "u_add", "u_inv"]
  );
});

test("netCone amonte: directia conteaza + steagul granitei intra in con", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  // amonte de u_add: netul care il alimenteaza (din) + steagul lui de granita
  // <port>.din (net-eticheta care atinge granita — capatul de granita NU se
  // pierde, recenzie adversariala); NU fratii care citesc si ei din
  assert.deepEqual(
    [...netCone(s, { node: "u_add" }, "up")].sort(),
    ["<port>.din", "din", "u_add"]
  );
  // aval de u_add: iesirea lui si steagul ei
  assert.deepEqual(
    [...netCone(s, { node: "u_add" }, "down")].sort(),
    ["<port>.sum", "sum", "u_add"]
  );
  // amonte de ch_out (net wire): pliajul + din + steagul <port>.din (lant
  // tranzitiv prin eticheta pana la granita)
  assert.deepEqual(
    [...netCone(s, { net: "ch_out" }, "up")].sort(),
    ["<port>.din", "ch_out", "din", "g_ch[0..2].u_ch"]
  );
});

test("netCone: steagul granitei pe net-eticheta e samanta valida (fix boundary)", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  // <port>.din poarta net-ul label `din`: SceneBPort.nets il tine
  const bDin = s.boundary.find((b) => b.id === "<port>.din");
  assert.deepEqual(bDin.nets, ["din"]);
  // seed din steag: conul aval e complet (nu gol, ca inainte de fix)
  assert.deepEqual(
    [...netCone(s, { node: "<port>.din" }, "down")].sort(),
    ["<port>.ch_out", "<port>.din", "<port>.inv", "<port>.sum",
     "ch_out", "din", "g_ch[0..2].u_ch", "inv", "sum", "u_add", "u_inv"]
  );
});

test("coneOf: pin din interiorul blocului -> conul netului, nu net inexistent", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  // click pe pinul u_add.din (data-id de grup) — NU e nod/net; se rezolva la
  // net-urile pinului, nu la un seed {net:"u_add.din"} inutil (recenzie)
  assert.deepEqual(
    [...coneOf(s, "u_add.din", "down")].sort(),
    [...netCone(s, { net: "din" }, "down")].sort()
  );
  // pin de iesire (fir): conul din netul cablat pe el (dout -> net sum)
  assert.deepEqual(
    [...coneOf(s, "u_add.dout", "down")].sort(),
    ["<port>.sum", "sum"]
  );
  // nod, steag si nume de net raman clasificate corect
  assert.deepEqual([...coneOf(s, "u_add", "down")].sort(), ["<port>.sum", "sum", "u_add"]);
  assert.ok(coneOf(s, "<port>.din", "down").size > 1);
  assert.deepEqual(
    [...coneOf(s, "din", "up")].sort(),
    [...netCone(s, { net: "din" }, "up")].sort()
  );
  // id nerecunoscut -> null (apelantul NU atinge selectia)
  assert.equal(coneOf(s, "does.not.exist", "down"), null);
});

test("latimi pe scena: pin/bport = elemW, edge = netWidth (nu prin select)", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  const bw = (name) => s.boundary.find((b) => b.name === name)?.width;
  // porturile vederii: elem_width (ch_out e unpacked 3×16 -> elemW=16)
  assert.equal(bw("clk"), 1);
  assert.equal(bw("din"), 8);
  assert.equal(bw("ch_out"), 16);
  assert.equal(s.boundary.find((b) => b.iface)?.width, null); // interfata
  // muchiile: latimea NETULUI (netWidth) — ch_out=48 (portul intreg), NU 16
  // de la pinii de select; sum/inv=8
  const ew = (net) => s.edges.find((e) => e.net === net && e.kind === "wire")?.width;
  assert.equal(ew("ch_out"), 48, "latimea netului, nu a pinilor de select");
  assert.equal(ew("sum"), 8);
  // pinii unei instante copil poarta latimea proprie
  const uadd = s.nodes.find((n) => n.id === "u_add");
  assert.equal(uadd.pins.find((p) => p.port === "dout")?.width, 8);
  assert.equal(uadd.pins.find((p) => p.port === "din")?.width, 8);
});

test("noteKind: discriminatorul adnotarii (select/concat/const/nc) pe model real", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  const pin = (nid, port) => s.nodes.find((n) => n.id === nid)?.pins.find((p) => p.port === port);
  // pliajul g_ch: dout prin select (`[0..2]`), din prin concat (`{…}`)
  assert.equal(pin("g_ch[0..2].u_ch", "dout")?.noteKind, "select");
  assert.equal(pin("g_ch[0..2].u_ch", "din")?.noteKind, "concat");
  // in demo_top: u_soc.rst_n = 1'b1 (const), iesirile nemapate = nc
  const top = buildSchematicScene(model, "demo_top", none);
  const tp = (port) => top.nodes.find((n) => n.id === "u_soc")?.pins.find((p) => p.port === port);
  assert.equal(tp("rst_n")?.noteKind, "const");
  assert.equal(tp("rst_n")?.note, "=1'b1");
  assert.equal(tp("sum")?.noteKind, "nc");
  // net/iface pur: fara adnotare (kind null)
  assert.equal(tp("clk")?.noteKind, null);
});

test("netCone: pin.nets e masina (netLabel ramane doar afisare)", () => {
  const s = buildSchematicScene(model, "demo_top.u_soc", none);
  const labeled = s.nodes.flatMap((n) => n.pins.filter((p) => p.nets.length));
  assert.equal(labeled.length, 3, "din etichetat pe cei trei consumatori");
  assert.ok(labeled.every((p) => p.nets.includes("din") && p.netLabel));
});

console.log(`\ntest-scene: ${passed} teste au trecut.`);
