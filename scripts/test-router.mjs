// Teste Node pentru ruterul A* pe grila (src/webview/router.ts):
//   npm run test:router
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-router-"));
const outFile = join(outDir, "router.mjs");
await esbuild.build({
  entryPoints: ["src/webview/router.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { route } = await import(pathToFileURL(outFile));

// edgeObstacles (schematic.ts) e pur: modulul nu atinge DOM la import
// (el()/measure doar la apel), iar elkjs e doar import de tip
const schFile = join(outDir, "schematic.mjs");
await esbuild.build({
  entryPoints: ["src/webview/schematic.ts"],
  outfile: schFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { edgeObstacles, junctionDots, combPolys, alignSnap, pinTipOffsets } = await import(pathToFileURL(schFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const A = (x, y, dir) => ({ x, y, dir });

test("pini aliniati, teren liber: fir perfect drept (2 puncte)", () => {
  const r = route(
    [],
    [{ id: "e", source: A(0, 96, 1), target: A(240, 96, -1) }]
  );
  assert.deepEqual(r.get("e"), [
    { x: 0, y: 96 },
    { x: 240, y: 96 },
  ]);
});

test("forma L: exact un cot (3 puncte), nu scari", () => {
  const r = route(
    [],
    [{ id: "e", source: A(0, 0, 1), target: A(200, 160, 1) }]
  );
  const pts = r.get("e");
  assert.ok(pts.length <= 4, `prea multe coturi: ${JSON.stringify(pts)}`);
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[pts.length - 1], { x: 200, y: 160 });
});

test("obstacol interpus: traseul il ocoleste (nicio celula inauntru)", () => {
  const obst = { x: 96, y: 40, w: 80, h: 112 }; // in calea firului drept
  const r = route(
    [obst],
    [{ id: "e", source: A(0, 96, 1), target: A(280, 96, -1) }]
  );
  const pts = r.get("e");
  assert.ok(pts, "fara drum");
  // niciun punct al poliliniei strict in interiorul obstacolului
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    // esantioneaza segmentul
    for (let t = 0; t <= 1; t += 0.1) {
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const inside =
        x > obst.x && x < obst.x + obst.w && y > obst.y && y < obst.y + obst.h;
      assert.ok(!inside, `traseul taie obstacolul la (${x},${y})`);
    }
  }
  assert.deepEqual(pts[0], { x: 0, y: 96 });
  assert.deepEqual(pts[pts.length - 1], { x: 280, y: 96 });
});

test("ancora din umbra obstacolului propriu: culoarul o elibereaza", () => {
  // pinul sta chiar pe granita obstacolului (cazul real: ancora pe nod)
  const node = { x: 0, y: 64, w: 96, h: 64 };
  const r = route(
    [node],
    [{ id: "e", source: A(96, 96, 1), target: A(280, 96, -1) }]
  );
  const pts = r.get("e");
  assert.ok(pts, "ancora de pe nod trebuie sa fie rutabila");
  assert.deepEqual(pts[0], { x: 96, y: 96 });
});

test("tinta inconjurata complet: cererea lipseste din rezultat", () => {
  // zid gros in jurul tintei, dincolo de culoarul de 2 celule
  const walls = [
    { x: 160, y: 40, w: 200, h: 40 },
    { x: 160, y: 160, w: 200, h: 40 },
    { x: 160, y: 40, w: 40, h: 160 },
    { x: 320, y: 40, w: 40, h: 160 },
  ];
  const r = route(
    walls,
    [{ id: "e", source: A(0, 96, 1), target: A(240, 120, -1) }]
  );
  assert.equal(r.get("e"), undefined);
});

test("mai multe cereri: fiecare isi primeste traseul", () => {
  const r = route(
    [],
    [
      { id: "a", source: A(0, 0, 1), target: A(160, 0, -1) },
      { id: "b", source: A(0, 64, 1), target: A(160, 64, -1) },
    ]
  );
  assert.equal(r.size, 2);
});

const ortho = (pts) => {
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    assert.ok(dx === 0 || dy === 0,
      `segment oblic ${JSON.stringify(pts[i])} -> ${JSON.stringify(pts[i + 1])}`);
  }
};

test("ortogonalitate stricta, inclusiv cu ancore in afara grilei pe x", () => {
  const obst = { x: 96, y: 40, w: 80, h: 112 };
  const r = route(
    [obst],
    [
      { id: "a", source: A(13.37, 96, 1), target: A(266.6, 96, -1) },
      { id: "b", source: A(0, 0, 1), target: A(203.2, 168, 1) },
    ]
  );
  ortho(r.get("a"));
  ortho(r.get("b"));
});

test("suprapunere: doua net-uri paralele isi iau culoare diferite", () => {
  const r = route(
    [],
    [
      { id: "a", source: A(0, 96, 1), target: A(320, 96, -1), group: "n1" },
      { id: "b", source: A(0, 96, 1), target: A(320, 96, -1), group: "n2" },
    ]
  );
  const a = r.get("a");
  const b = r.get("b");
  ortho(a);
  ortho(b);
  const longH = (pts) => {
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      if (pts[i].y === pts[i + 1].y) {
        const len = Math.abs(pts[i + 1].x - pts[i].x);
        if (!best || len > best.len) best = { y: pts[i].y, len };
      }
    }
    return best.y;
  };
  assert.notEqual(longH(a), longH(b), "trasee suprapuse pe acelasi culoar");
});

test("acelasi net (fan-out): trunchiul comun e permis", () => {
  const r = route(
    [],
    [
      { id: "s1", source: A(0, 96, 1), target: A(320, 64, -1), group: "sum" },
      { id: "s2", source: A(0, 96, 1), target: A(320, 128, -1), group: "sum" },
    ]
  );
  const a = r.get("s1");
  const b = r.get("s2");
  assert.equal(a[0].y, 96);
  assert.equal(b[0].y, 96);
  assert.equal(a[1].y, 96, "primul segment ramane pe randul pinului");
  assert.equal(b[1].y, 96, "trunchiul comun nu e penalizat");
});

test("fan-out net-uri distincte: se suprapun langa sursa comuna", () => {
  // doua muchii din ACELASI pin sursa spre tinte diferite, dar net-uri
  // (grupuri) DISTINCTE: fan-out real (ap->sb, ap->cov in vederea TB).
  // Implicit (fanoutRadius>0) impart stub-ul langa sursa; fara raza forcheaza
  // imediat la pin, pe culoare separate (cererea utilizatorului la validare).
  const reqs = [
    { id: "s1", source: A(0, 96, 1), target: A(320, 64, -1), group: "n1" },
    { id: "s2", source: A(0, 96, 1), target: A(320, 128, -1), group: "n2" },
  ];
  // cu waive: s2 ramane pe randul sursei (y=96) pe stub, apoi diverge
  const on = route([], reqs);
  assert.equal(on.get("s1")[1].y, 96, "s1 pleaca pe randul sursei");
  assert.equal(on.get("s2")[1].y, 96, "s2 imparte trunchiul langa sursa");
  assert.ok(on.get("s2")[1].x > 0, "s2 diverge abia dupa stubul comun");
  // fara waive: s2 forcheaza chiar la pin (paraseste randul imediat)
  const off = route([], reqs, { fanoutRadius: 0 });
  assert.notEqual(off.get("s2")[1].y, 96, "fara raza, s2 nu se suprapune deloc");
});

test("halou: traseul pastreaza distanta de obstacol (nu trece peste etichete)", () => {
  // obstacol cu marginea de sus la 16px sub linia dreapta a firului
  const obst = { x: 120, y: 112, w: 80, h: 40 };
  const req = [{ id: "e", source: A(0, 96, 1), target: A(320, 96, -1) }];
  // cu haloul implicit (16px): linia dreapta intra in halou -> ocoleste
  const withHalo = route([obst], req).get("e");
  for (const pt of withHalo) {
    if (pt.x > 112 && pt.x < 208) {
      assert.ok(pt.y <= 96 - 16 || pt.y >= 112 + 40 + 16,
        'punct in halou: ' + JSON.stringify(pt));
    }
  }
  // cu halou redus (8px): linia dreapta incape
  const slim = route([obst], req, { halo: 8 }).get("e");
  assert.equal(slim.length, 2, 'cu halou mic firul ramane drept');
});

test("proximitate: la egalitate, traseul prefera canalul larg", () => {
  // doua variante de L cu acelasi cost brut; obstacolul sta langa coltul
  // variantei de sus -> ruterul trebuie sa aleaga varianta de jos
  const obst = { x: 96, y: 8, w: 120, h: 48 };
  const r = route(
    [obst],
    [{ id: "e", source: A(0, 96, 1), target: A(320, 200, -1) }]
  );
  const pts = r.get("e");
  // niciun punct in inelul obstacolului (halou 16 + inel 8 = 24)
  for (const pt of pts) {
    const near =
      pt.x > obst.x - 24 && pt.x < obst.x + obst.w + 24 &&
      pt.y > obst.y - 24 && pt.y < obst.y + obst.h + 24;
    assert.ok(!near, 'traseul se lipeste de obstacol: ' + JSON.stringify(pt));
  }
});

test("blocuri lipite: pinul evadeaza prin golul ingust, nu prin blocuri", () => {
  // doua blocuri cu gol de 16px intre ele; pinul sursa e pe peretele din
  // gol — inainte, halourile dure astupau golul si ruta cadea pe fallback
  const left = { x: 0, y: 64, w: 176, h: 56 };
  const right = { x: 192, y: 64, w: 176, h: 56 };
  const r = route(
    [left, right],
    [{ id: "e", source: A(176, 104, 1), target: A(560, 224, -1) }]
  );
  const pts = r.get("e");
  assert.ok(pts, "trebuie sa existe drum prin gol");
  // niciun punct in interiorul vreunui bloc
  for (const o of [left, right]) {
    for (let i = 0; i < pts.length - 1; i++) {
      for (let s = 0; s <= 1; s += 0.1) {
        const x = pts[i].x + (pts[i + 1].x - pts[i].x) * s;
        const y = pts[i].y + (pts[i + 1].y - pts[i].y) * s;
        assert.ok(!(x > o.x + 1 && x < o.x + o.w - 1 &&
                    y > o.y + 1 && y < o.y + o.h - 1),
          'traseul taie blocul la (' + x + ',' + y + ')');
      }
    }
  }
});

// --------------------------------------------- edgeObstacles (schematic.ts)

const PIN = (id, extra) => ({
  id, port: id.split(".").pop(), dir: "in", side: "WEST", iface: false,
  bus: false, mult: null, label: id, netLabel: null, note: null, tooltip: "",
  ...extra,
});
const OBST_SCENE = {
  viewId: "v", module: "m", boundary: [],
  nodes: [{
    id: "u_a", kind: "instance", name: "u_a", sub: "", instPath: "t.u_a",
    hasView: false, foldCount: 1, foldId: null, tooltip: "",
    pins: [
      // pin cu eticheta de net, FARA fir -> obstacol moale la vest
      PIN("u_a.x", { netLabel: "long_net_name" }),
      // pin cu adnotare select, capat de FIR -> NU devine obstacol
      PIN("u_a.y", { side: "EAST", dir: "out", note: "[1]" }),
      // pin fara texte -> nimic
      PIN("u_a.z"),
    ],
  }],
  edges: [{
    id: "e1", net: "n1", kind: "wire",
    source: "u_a", sourcePort: "u_a.y", target: "p.out", targetPort: null,
  }],
};
const OBST_LAYOUT = {
  id: "root",
  children: [{
    id: "u_a", x: 100, y: 50, width: 80, height: 72,
    ports: [
      { id: "u_a.x", x: 0, y: 32, width: 0, height: 0 },
      { id: "u_a.y", x: 80, y: 32, width: 0, height: 0 },
      { id: "u_a.z", x: 0, y: 48, width: 0, height: 0 },
    ],
  }],
};

test("edgeObstacles: eticheta de pin = obstacol MOALE inalt de UN pas de pin", () => {
  const obs = edgeObstacles(OBST_SCENE, OBST_LAYOUT);
  // nodul insusi + un singur obstacol de text (x are eticheta, y e pe fir, z gol)
  assert.equal(obs.length, 2, JSON.stringify(obs));
  const soft = obs.find((o) => o.cost !== undefined);
  assert.ok(soft, "lipseste obstacolul moale al etichetei");
  assert.equal(soft.cost, 10, "moale (cost), nu zid");
  // capcana 13: inaltimea = PIN_PITCH (24), altfel sangereaza in randul vecin
  assert.equal(soft.h, 24, "inaltimea trebuie sa fie un pas de pin");
  // centrat pe randul pinului (py = 50 + 32 = 82), obstacol de PIN_PITCH/2 in sus
  assert.equal(soft.y, 82 - 12);
  // pe latura de vest textul iese la stanga blocului
  assert.ok(soft.x < 100 && soft.x + soft.w <= 100, JSON.stringify(soft));
});

test("edgeObstacles: pinul capat de fir NU e obstacol pentru propriul fir", () => {
  // capcana 14: cu fir, adnotarea pinului y nu apare; fara fir, apare la EST
  const noWires = { ...OBST_SCENE, edges: [] };
  const obs = edgeObstacles(noWires, OBST_LAYOUT);
  assert.equal(obs.length, 3, "fara fir, adnotarea lui y devine obstacol");
  const east = obs.filter((o) => o.cost !== undefined).find((o) => o.x >= 180);
  assert.ok(east, "adnotarea pinului de est incepe la marginea dreapta");
  assert.equal(east.x, 180); // child.x + width
});

// --------------------------------------------- junctionDots (schematic.ts)

const P = (x, y) => ({ x, y });
const dotKeys = (m) => junctionDots(m).map((d) => `${d.x},${d.y}`).sort();

test("junctionDots: T (3 directii) = un punct; cot/drept = niciunul", () => {
  // trunchi vertical x=100 y=0..80, cu o ramura orizontala la (100,40)->(200,40)
  // -> T la (100,40); capetele (100,0),(100,80),(200,40) sunt grad 1
  const m = new Map([["n", [
    [P(100, 0), P(100, 80)],
    [P(100, 40), P(200, 40)],
  ]]]);
  assert.deepEqual(dotKeys(m), ["100,40"]);
  // un simplu cot (L) — doua directii, niciun punct
  const corner = new Map([["n", [[P(0, 0), P(0, 40), P(40, 40)]]]]);
  assert.deepEqual(dotKeys(corner), []);
  // linie dreapta — niciun punct
  assert.deepEqual(dotKeys(new Map([["n", [[P(0, 0), P(80, 0)]]]])), []);
});

test("junctionDots: incrucisare fara varf NU primeste punct (crossover)", () => {
  // acelasi net, doua segmente care se incruciseaza la (50,50) fara varf acolo
  const m = new Map([["n", [
    [P(0, 50), P(100, 50)],
    [P(50, 0), P(50, 100)],
  ]]]);
  // niciun varf la (50,50) -> nedetectat, niciun punct
  assert.deepEqual(dotKeys(m), []);
});

test("junctionDots: contopire 4-way la VARF primeste punct (fan-in magistrala)", () => {
  // orizontal drept prin (50,50) + vertical cu VARF la (50,50): 4 directii la un
  // varf, acelasi net -> contopire reala (ca 3 dout-uri intr-un port ch_out)
  const m = new Map([["n", [
    [P(0, 50), P(100, 50)],
    [P(50, 0), P(50, 50), P(50, 100)],
  ]]]);
  assert.deepEqual(dotKeys(m), ["50,50"]);
});

test("junctionDots: net-uri DIFERITE care se ating nu produc punct", () => {
  // gruparea pe net izoleaza: T-ul aparent e intre doua net-uri distincte
  const m = new Map([
    ["a", [[P(0, 0), P(100, 0)]]],
    ["b", [[P(50, 0), P(50, 50)]]], // atinge netul a la (50,0), dar e alt net
  ]);
  assert.deepEqual(dotKeys(m), []);
});

test("junctionDots: fanout cu trunchi comun -> punct la bifurcatie", () => {
  // doua polilinii ale aceluiasi net care impart trunchiul (0,0)->(0,40) apoi
  // se despart: dedup pe trunchi + T la (0,40)
  const m = new Map([["n", [
    [P(0, 0), P(0, 40), P(60, 40)],
    [P(0, 0), P(0, 40), P(-60, 40)],
  ]]]);
  assert.deepEqual(dotKeys(m), ["0,40"]);
});

test("combPolys: fan-in -> pieptene (spina + prize interioare), colturi curate", () => {
  // 3 surse la stanga (x=0) pe randuri 0/40/80, sink la dreapta (x=100) SUB
  // surse (y=120). Rutarea (stea) are spina la x=50.
  const ends = [P(0, 0), P(0, 40), P(0, 80), P(100, 120)];
  const routed = [
    [P(0, 0), P(50, 0), P(50, 120), P(100, 120)],
    [P(0, 40), P(50, 40), P(50, 120), P(100, 120)],
    [P(0, 80), P(50, 80), P(50, 120), P(100, 120)],
  ];
  const comb = combPolys(ends, routed);
  assert.ok(comb, "pieptene construit");
  // spina = priza de sus -> trunchi -> priza de jos, O SINGURA polilinie (colturi
  // cu jonctiune, fara gol): (0,0)->(50,0)->(50,120)->(100,120)
  assert.deepEqual(comb[0], [P(0, 0), P(50, 0), P(50, 120), P(100, 120)]);
  // prizele interioare (40, 80) sunt separate
  assert.equal(comb.length, 3);
  // junctionDots: T la 40 si 80 (interioare); capetele spinei (0,120) = coturi
  assert.deepEqual(dotKeys(new Map([["n", comb]])), ["50,40", "50,80"]);
});

test("combPolys: null cand <3 capete sau toate pe un rand", () => {
  assert.equal(combPolys([P(0, 0), P(100, 0)], [[P(0, 0), P(100, 0)]]), null);
  assert.equal(
    combPolys([P(0, 0), P(50, 0), P(100, 0)], [[P(50, 0), P(50, 10)]]),
    null
  );
});

test("alignSnap: port tras la acelasi y ca un port vecin -> ghidaj orizontal", () => {
  // port tras la (200,103); port vecin la (50,100). y 103 vs 100 -> in prag 6
  // -> dy=-3, ghidaj orizontal la y=100 de la portul tras (200) la vecin (50).
  const a = alignSnap([{ x: 200, y: 103 }], [{ x: 50, y: 100 }], 6);
  assert.equal(a.dy, -3);
  assert.ok(a.hLine && a.hLine.y === 100);
  // span de la portul tras (200) la vecin (50), cu surplus de 24px pe capete
  assert.equal(a.hLine.x0, 50 - 24);
  assert.equal(a.hLine.x1, 200 + 24);
  assert.equal(a.dx, 0); // X prea departe (200 vs 50)
  assert.equal(a.vLine, null);
});

test("alignSnap: cel mai apropiat port castiga pe ambele axe", () => {
  // doua porturi trase; tinte multiple. pe X cel mai aproape e diff 1, pe Y diff 2
  const a = alignSnap(
    [{ x: 100, y: 40 }, { x: 100, y: 64 }],
    [{ x: 101, y: 200 }, { x: 300, y: 42 }],
    6
  );
  assert.equal(a.dx, 1); // 101 - 100
  assert.ok(a.vLine && a.vLine.x === 101);
  assert.equal(a.dy, 2); // 42 - 40 (portul de sus), mai aproape ca 64
  assert.ok(a.hLine && a.hLine.y === 42);
});

test("alignSnap: niciun port vecin in prag -> fara aliniere", () => {
  const a = alignSnap([{ x: 10, y: 10 }], [{ x: 200, y: 200 }], 6);
  assert.equal(a.dx, 0);
  assert.equal(a.dy, 0);
  assert.equal(a.vLine, null);
  assert.equal(a.hLine, null);
});

test("alignSnap: fara porturi trase (bloc fara porturi) -> fara aliniere", () => {
  const a = alignSnap([], [{ x: 50, y: 50 }], 6);
  assert.equal(a.vLine, null);
  assert.equal(a.hLine, null);
});

test("pinTipOffsets: capatul pinului cu marcator la -MARKER_STUB, normal la +STUB", () => {
  // nod latime 100; pin vest cu marcator concat, pin est normal
  const scene = { nodes: [{ pins: [
    { id: "n.a", noteKind: "concat" }, { id: "n.b" },
  ] }], boundary: [] };
  const layout = { children: [{ id: "n", width: 100, ports: [
    { id: "n.a", x: 0, width: 8, y: 36, height: 8 },   // vest (centru 4 < 50)
    { id: "n.b", x: 92, width: 8, y: 36, height: 8 },  // est  (centru 96 > 50)
  ] }] };
  const m = pinTipOffsets(scene, layout);
  const pts = m.get("n");
  // vest marcator: x = -MARKER_STUB (=STUB+GAP+CW+TAIL=10+8+18+12=48, pe grila,
  // strapunge chip-ul); est normal: x = cw+STUB = 110
  assert.deepEqual(pts, [{ x: -48, y: 40 }, { x: 110, y: 40 }]);
});

test("pinTipOffsets: latura vine din geometrie (rasturnare) + nod fara porturi", () => {
  // acelasi pin mutat pe latura EST (centru > cw/2) -> capat la cw+STUB
  const scene = { nodes: [{ pins: [{ id: "n.a" }] }], boundary: [] };
  const flipped = { children: [
    { id: "n", width: 100, ports: [{ id: "n.a", x: 92, width: 8, y: 20, height: 8 }] },
    { id: "empty", width: 40, ports: [] },
  ] };
  const m = pinTipOffsets(scene, flipped);
  assert.deepEqual(m.get("n"), [{ x: 110, y: 24 }]);
  assert.deepEqual(m.get("empty"), []); // fara porturi -> lista goala
});

console.log(`\ntest-router: ${passed} teste au trecut.`);
