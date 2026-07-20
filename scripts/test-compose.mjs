// Node tests for the PURE derivation of the H1 connections (src/compose.ts —
// the parent view's nets -> connections): npm run test:compose
//
// SYNTHETIC models for the pipeline topology (the soc_top regression model is a
// STAR — all nets touch own ports — so it has no inter-block net;
// we use it for the „the star derives nothing" case).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outFile = join(mkdtempSync(join(tmpdir(), "quickuvm-compose-")), "compose.mjs");
await esbuild.build({
  entryPoints: ["src/compose.ts"], outfile: outFile,
  bundle: true, format: "esm", platform: "node", logLevel: "silent",
  // compose pulls in yamlops -> the CJS package `yaml`: the standard esbuild shim
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const { deriveConnections, parentComposition, subenvMapping, subenvName, planWireEdits } =
  await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok ${name}`); }

// synthetic model constructor: instances + modules with ports
function mkModel(view) {
  const modules = {};
  const instances = [{ path: "top", module: "sys", params: {}, loc: null }];
  for (const [rel, m] of Object.entries(view.children)) {
    instances.push({ path: `top.${rel}`, module: m.module, params: {}, loc: null });
    modules[m.module] = {
      ports: m.ports.map((p) => ({
        name: p.name, dir: p.dir, type: "logic", width: p.width,
        unpacked_dims: null, elem_width: null, loc: null,
      })),
      iface_ports: [], loc: null,
    };
  }
  modules.sys = { ports: view.ownPorts ?? [], iface_ports: [], loc: null };
  return {
    schema_version: 1, tops: ["top"], modules, instances,
    views: { top: { module: "sys", pins: [], nets: view.nets } },
  };
}

const PIPE = mkModel({
  children: {
    u_prod: { module: "producer", ports: [{ name: "dout", dir: "out", width: 8 }] },
    u_cons: { module: "consumer", ports: [{ name: "din", dir: "in", width: 8 }] },
  },
  nets: [{ name: "stream", endpoints: ["u_prod.dout", "u_cons.din"], fanout: 2, render: "wire" }],
});
const SUBS = new Map([["u_prod", "u_prod"], ["u_cons", "u_cons"]]);

test("pipeline: un net iesire->intrare devine o conexiune; sink identificat", () => {
  const r = deriveConnections(PIPE, "top", SUBS);
  assert.deepEqual(r.connections, [{ from: "u_prod.dout", to: "u_cons.din", width: 8 }]);
  assert.deepEqual(r.sinks, ["u_cons"]); // the agent of u_cons must be passive
  assert.deepEqual(r.warnings, []);
});

test("directia conteaza: from = IESIREA sursei, to = INTRAREA destinatiei", () => {
  // same model, but querying with u_cons as source would not appear (it has only `in`)
  const r = deriveConnections(PIPE, "top", SUBS);
  assert.equal(r.connections[0].from, "u_prod.dout");
  assert.equal(r.connections[0].to, "u_cons.din");
});

test("subenv necompus: capatul catre el se ignora (nu se cableaza la un ne-subenv)", () => {
  const r = deriveConnections(PIPE, "top", new Map([["u_prod", "u_prod"]]));
  assert.deepEqual(r.connections, []); // u_cons is not in the map
});

test("net de granita (atinge <port>.X) NU e conexiune inter-bloc", () => {
  const m = mkModel({
    children: { u_a: { module: "a", ports: [{ name: "dout", dir: "out", width: 8 }] } },
    ownPorts: [{ name: "y", dir: "out", type: "logic", width: 8, unpacked_dims: null, elem_width: null, loc: null }],
    nets: [{ name: "y", endpoints: ["<port>.y", "u_a.dout"], fanout: 2, render: "wire" }],
  });
  assert.deepEqual(deriveConnections(m, "top", new Map([["u_a", "u_a"]])).connections, []);
});

test("multi-driver: doua iesiri pe acelasi net -> avertisment, nimic cablat", () => {
  const m = mkModel({
    children: {
      u_a: { module: "a", ports: [{ name: "o", dir: "out", width: 8 }] },
      u_b: { module: "b", ports: [{ name: "o", dir: "out", width: 8 }] },
      u_c: { module: "c", ports: [{ name: "i", dir: "in", width: 8 }] },
    },
    nets: [{ name: "n", endpoints: ["u_a.o", "u_b.o", "u_c.i"], fanout: 3, render: "wire" }],
  });
  const r = deriveConnections(m, "top", new Map([["u_a", "u_a"], ["u_b", "u_b"], ["u_c", "u_c"]]));
  assert.deepEqual(r.connections, []);
  assert.match(r.warnings[0], /drivers/i);
});

test("nepotrivire de latime (module DIFERITE) -> avertisment, DAR se cableaza", () => {
  // the generator does the authoritative check: we don't drop a real connection,
  // we only warn (regression caught in review — the skip lost connections)
  const m = mkModel({
    children: {
      u_a: { module: "a", ports: [{ name: "o", dir: "out", width: 8 }] },
      u_b: { module: "b", ports: [{ name: "i", dir: "in", width: 16 }] },
    },
    nets: [{ name: "n", endpoints: ["u_a.o", "u_b.i"], fanout: 2, render: "wire" }],
  });
  const r = deriveConnections(m, "top", new Map([["u_a", "u_a"], ["u_b", "u_b"]]));
  assert.deepEqual(r.connections, [{ from: "u_a.o", to: "u_b.i", width: 8 }]);
  assert.match(r.warnings[0], /width mismatch/i);
});

test("feedthrough: un net care atinge SI un port propriu ramane conexiune inter-bloc", () => {
  // the parent port `y` driven by u_a.o AND read by u_b.i: net `y` =
  // [<port>.y, u_a.o, u_b.i]. The old boundary guard dropped the whole net and
  // lost the real pair u_a->u_b (regression caught in review)
  const m = mkModel({
    children: {
      u_a: { module: "a", ports: [{ name: "o", dir: "out", width: 8 }] },
      u_b: { module: "b", ports: [{ name: "i", dir: "in", width: 8 }] },
    },
    ownPorts: [{ name: "y", dir: "out", type: "logic", width: 8, unpacked_dims: null, elem_width: null, loc: null }],
    nets: [{ name: "y", endpoints: ["<port>.y", "u_a.o", "u_b.i"], fanout: 3, render: "wire" }],
  });
  const r = deriveConnections(m, "top", new Map([["u_a", "u_a"], ["u_b", "u_b"]]));
  assert.deepEqual(r.connections, [{ from: "u_a.o", to: "u_b.i", width: 8 }]);
});

test("acelasi modul (parametri per-instanta): latimea partajata NU blocheaza cablarea", () => {
  // two instances of the same module: the width from the per-name definition is common,
  // so unreliable under different parameters — we don't check, quick-uvm decides
  const m = mkModel({
    children: {
      u_a: { module: "stage", ports: [{ name: "o", dir: "out", width: 8 }, { name: "i", dir: "in", width: 8 }] },
      u_b: { module: "stage", ports: [{ name: "o", dir: "out", width: 8 }, { name: "i", dir: "in", width: 8 }] },
    },
    nets: [{ name: "n", endpoints: ["u_a.o", "u_b.i"], fanout: 2, render: "wire" }],
  });
  const r = deriveConnections(m, "top", new Map([["u_a", "u_a"], ["u_b", "u_b"]]));
  assert.deepEqual(r.connections, [{ from: "u_a.o", to: "u_b.i", width: 8 }]);
  assert.deepEqual(r.warnings, []);
});

test("fan-out: o iesire spre DOUA intrari -> doua conexiuni, doi sinks", () => {
  const m = mkModel({
    children: {
      u_a: { module: "a", ports: [{ name: "o", dir: "out", width: 8 }] },
      u_b: { module: "b", ports: [{ name: "i", dir: "in", width: 8 }] },
      u_c: { module: "c", ports: [{ name: "i", dir: "in", width: 8 }] },
    },
    nets: [{ name: "n", endpoints: ["u_a.o", "u_b.i", "u_c.i"], fanout: 3, render: "wire" }],
  });
  const r = deriveConnections(m, "top", new Map([["u_a", "u_a"], ["u_b", "u_b"], ["u_c", "u_c"]]));
  assert.deepEqual(r.connections, [
    { from: "u_a.o", to: "u_b.i", width: 8 },
    { from: "u_a.o", to: "u_c.i", width: 8 },
  ]);
  assert.deepEqual(r.sinks.sort(), ["u_b", "u_c"]);
});

test("numele subenv difera de rel: capetele folosesc NUMELE subenv", () => {
  const r = deriveConnections(PIPE, "top", new Map([["u_prod", "p1"], ["u_cons", "c1"]]));
  assert.deepEqual(r.connections, [{ from: "p1.dout", to: "c1.din", width: 8 }]);
  assert.deepEqual(r.sinks, ["c1"]);
});

test("modelul de regresie (soc_top) e o STEA: nicio conexiune inter-bloc", () => {
  const model = JSON.parse(readFileSync("examples/model.json", "utf8"));
  // all children of soc_top, keyed rel->name (as subenvs)
  const subs = new Map([
    ["u_add", "u_add"], ["u_inv", "u_inv"],
    ["g_ch[0].u_ch", "u_ch0"], ["g_ch[1].u_ch", "u_ch1"], ["g_ch[2].u_ch", "u_ch2"],
  ]);
  const r = deriveConnections(model, "demo_top.u_soc", subs);
  assert.deepEqual(r.connections, [], `steaua nu ar trebui sa dea conexiuni: ${JSON.stringify(r)}`);
});

// ------------------------------------------- parentComposition (Compose up)

test("parentComposition: dintr-un bloc -> parintele imediat + copiii-bloc directi", () => {
  const model = JSON.parse(readFileSync("examples/model.json", "utf8"));
  // from the chan view g_ch[1].u_ch: the parent is u_soc (soc_top), and the
  // direct block-children are u_add, u_inv and the three channels (bus_i = interface, excluded)
  const pc = parentComposition(model, "demo_top.u_soc.g_ch[1].u_ch");
  assert.equal(pc.parentPath, "demo_top.u_soc");
  assert.deepEqual(pc.childRels.sort(), [
    "g_ch[0].u_ch", "g_ch[1].u_ch", "g_ch[2].u_ch", "u_add", "u_inv",
  ]);
});

test("parentComposition: dintr-un copil direct (u_add) -> acelasi parinte u_soc", () => {
  const model = JSON.parse(readFileSync("examples/model.json", "utf8"));
  const pc = parentComposition(model, "demo_top.u_soc.u_add");
  assert.equal(pc.parentPath, "demo_top.u_soc");
  assert.ok(pc.childRels.includes("u_add") && pc.childRels.includes("g_ch[0].u_ch"));
});

test("parentComposition: un modul TOP nu are parinte -> null", () => {
  const model = JSON.parse(readFileSync("examples/model.json", "utf8"));
  assert.equal(parentComposition(model, "demo_top"), null);
  assert.equal(parentComposition(model, "nu.exista"), null);
});

test("parentComposition: parintele lui u_soc e demo_top; copiii lui = u_soc (bus_i exclus)", () => {
  const model = JSON.parse(readFileSync("examples/model.json", "utf8"));
  const pc = parentComposition(model, "demo_top.u_soc");
  assert.equal(pc.parentPath, "demo_top");
  // demo_top has u_soc (block) and bus_i (interface, excluded) -> a single block-child
  assert.deepEqual(pc.childRels, ["u_soc"]);
});

// ------------------------------------------- subenvMapping + planWireEdits

test("subenvName: membru de generate -> identificator SV", () => {
  assert.equal(subenvName("g_ch[1].u_ch"), "g_ch_1_u_ch");
  assert.equal(subenvName("u_add"), "u_add");
});

test("subenvMapping: rel adanc mapat; numele ambigue se exclud + raporteaza", () => {
  const model = {
    schema_version: 1, tops: ["top"], modules: {}, views: {},
    instances: [
      { path: "top", module: "sys", params: {}, loc: null },
      // DEEP rel (generate member) — not filtered by `.` (#3)
      { path: "top.g_ch[0].u_ch", module: "chan", params: {}, loc: null },
      // many-to-one collision: both rels produce the same name `u_x_1`
      { path: "top.u_x[1]", module: "m1", params: {}, loc: null },
      { path: "top.u_x_1", module: "m2", params: {}, loc: null },
    ],
  };
  const r = subenvMapping(model, "top", ["g_ch_0_u_ch", "u_x_1", undefined]);
  assert.equal(r.subenvOf.get("g_ch[0].u_ch"), "g_ch_0_u_ch");
  // both candidates for `u_x_1` were removed (better nothing than misrouted)
  assert.deepEqual(r.ambiguous, ["u_x_1"]);
  assert.equal(r.subenvOf.size, 1);
});

const CHILD_YAML = `dut:
  name: chan
agents:
  - name: chan_a
    active: true
    ports:
      inputs:
        - { name: din, width: 8 }
`;

test("planWireEdits: connections pe top + agentul sink-ului pus pasiv", () => {
  const subenvs = [
    { name: "u_prod", config: "producer.quickuvm.yaml" },
    { name: "u_cons", config: "chan.quickuvm.yaml" },
  ];
  const derived = {
    connections: [{ from: "u_prod.dout", to: "u_cons.din", width: 8 }],
    sinks: ["u_cons"],
  };
  const children = new Map([
    ["chan.quickuvm.yaml", { key: "file:///ws/chan.quickuvm.yaml", text: CHILD_YAML }],
  ]);
  const plan = planWireEdits("dut:\n  name: top\n", subenvs, derived, children);
  assert.match(plan.topText, /connections:/);
  assert.match(plan.topText, /u_prod\.dout/);
  assert.deepEqual(plan.passivated, ["u_cons.chan_a"]);
  assert.deepEqual(plan.manual, []);
  const child = plan.childTexts.get("file:///ws/chan.quickuvm.yaml");
  assert.ok(child, "config-ul copil trebuie editat");
  assert.match(child, /active: false/);
});

test("planWireEdits: doua sinks spre ACELASI fisier copil se PLIAZA (#4)", () => {
  // shared block: two `chan` instances reference the same config; the passivations
  // must be folded into ONE single text, not two replacements that corrupt each other
  const shared = `dut:
  name: chan
agents:
  - name: a1
    active: true
    ports:
      inputs:
        - { name: din, width: 8 }
  - name: a2
    active: true
    ports:
      inputs:
        - { name: alt, width: 8 }
`;
  const subenvs = [
    { name: "u_prod", config: "producer.quickuvm.yaml" },
    { name: "u_c0", config: "chan.quickuvm.yaml" },
    { name: "u_c1", config: "chan.quickuvm.yaml" },
  ];
  const derived = {
    connections: [
      { from: "u_prod.dout", to: "u_c0.din", width: 8 },
      { from: "u_prod.dout2", to: "u_c1.alt", width: 8 },
    ],
    sinks: ["u_c0", "u_c1"],
  };
  const children = new Map([
    ["chan.quickuvm.yaml", { key: "file:///ws/chan.quickuvm.yaml", text: shared }],
  ]);
  const plan = planWireEdits("dut:\n  name: top\n", subenvs, derived, children);
  assert.equal(plan.childTexts.size, 1, "UN singur text final per fisier");
  const child = plan.childTexts.get("file:///ws/chan.quickuvm.yaml");
  // BOTH passivations present in the same text (folded onto the evolving text)
  const passives = child.match(/active: false/g) ?? [];
  assert.equal(passives.length, 2, child);
  assert.deepEqual(plan.passivated, ["u_c0.a1", "u_c1.a2"]);
});

test("planWireEdits: TOTI agentii cu porturi conduse devin pasivi (nu doar primul)", () => {
  // real bug empirically confirmed in the adversarial review: the driven ports of
  // a sink can belong to DIFFERENT agents; quick-uvm refuses generation
  // if ANY stays active — find() passivated only the first and the gesture reported
  // success on a broken state
  const twoAgents = `dut:
  name: duo
agents:
  - name: a1
    active: true
    ports:
      inputs:
        - { name: din, width: 8 }
  - name: a2
    active: true
    ports:
      inputs:
        - { name: alt, width: 8 }
`;
  const subenvs = [
    { name: "u_p", config: "p.quickuvm.yaml" },
    { name: "u_d", config: "duo.quickuvm.yaml" },
  ];
  const derived = {
    connections: [
      { from: "u_p.o1", to: "u_d.din", width: 8 },
      { from: "u_p.o2", to: "u_d.alt", width: 8 },
    ],
    sinks: ["u_d"],
  };
  const children = new Map([
    ["duo.quickuvm.yaml", { key: "file:///ws/duo.quickuvm.yaml", text: twoAgents }],
  ]);
  const plan = planWireEdits("dut:\n  name: top\n", subenvs, derived, children);
  assert.deepEqual(plan.passivated, ["u_d.a1", "u_d.a2"]);
  assert.deepEqual(plan.manual, []);
  const child = plan.childTexts.get("file:///ws/duo.quickuvm.yaml");
  const passives = child.match(/active: false/g) ?? [];
  assert.equal(passives.length, 2, child);
});

test("planWireEdits: sink fara config/fisier/agent -> manual, restul merg", () => {
  const subenvs = [
    { name: "u_a" }, // no config
    { name: "u_b", config: "missing.quickuvm.yaml" }, // unreadable file
    { name: "u_c", config: "skeleton.quickuvm.yaml" }, // skeleton without agents
  ];
  const derived = {
    connections: [
      { from: "u_src.o", to: "u_a.i", width: 1 },
      { from: "u_src.o", to: "u_b.i", width: 1 },
      { from: "u_src.o", to: "u_c.i", width: 1 },
    ],
    sinks: ["u_a", "u_b", "u_c"],
  };
  const children = new Map([
    ["skeleton.quickuvm.yaml", { key: "file:///ws/skeleton.quickuvm.yaml", text: "dut:\n  name: skel\n" }],
  ]);
  const plan = planWireEdits("dut:\n  name: top\n", subenvs, derived, children);
  assert.deepEqual(plan.manual, ["u_a", "u_b", "u_c"]);
  assert.deepEqual(plan.passivated, []);
  assert.equal(plan.childTexts.size, 0, "scheletul neschimbat nu se scrie");
  // the connections are written to top anyway (passivation is the user's responsibility)
  assert.match(plan.topText, /connections:/);
});

console.log(`\ntest-compose: ${passed} teste au trecut.`);
