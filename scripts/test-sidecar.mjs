// Node tests for the pure mutations of the layout sidecar
// (src/sidecarops.ts), on the regression model examples/model.json:
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
  // the CJS package `yaml` needs the createRequire shim at ESM bundling
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

test("docs/08 R18: a collapsed TB block and a view's hidden pins are overrides; the defaults are not persisted", () => {
  const d = ops.emptySidecar();
  ops.setCollapsed(d, "tb:x.yaml|env", "agent:cmd", true);
  assert.deepEqual(d.views["tb:x.yaml|env"].nodes["agent:cmd"], { collapsed: true });
  ops.setNodePos(d, "tb:x.yaml|env", "agent:cmd", 40, 80);
  ops.setCollapsed(d, "tb:x.yaml|env", "agent:cmd", false);
  assert.deepEqual(d.views["tb:x.yaml|env"].nodes["agent:cmd"], { x: 40, y: 80 }, "expanded = the default: only the position stays");
  ops.setCollapsed(d, "tb:y.yaml|env", "sb:x", true);
  ops.setCollapsed(d, "tb:y.yaml|env", "sb:x", false);
  assert.equal(d.views["tb:y.yaml|env"], undefined, "nothing left: the view goes");
  ops.setHidePins(d, "demo_top.u_soc", true);
  assert.deepEqual(d.views["demo_top.u_soc"], { hidePins: true });
  const back = ops.parseSidecar(ops.serializeSidecar(d));
  assert.deepEqual(back.views["demo_top.u_soc"], { hidePins: true }, "survives the file round trip");
  assert.deepEqual(back.views["tb:x.yaml|env"].nodes["agent:cmd"], { x: 40, y: 80 });
  ops.setHidePins(d, "demo_top.u_soc", false);
  assert.equal(d.views["demo_top.u_soc"], undefined, "shown = the default: the view goes");
});

test("docs/08 R18: invalidate keeps a view that holds only hidePins — a schematic and a leaf's symbol", () => {
  const d = ops.emptySidecar();
  ops.setHidePins(d, "demo_top.u_soc", true);
  ops.setHidePins(d, "demo_top.u_soc.g_ch[0].u_ch", true);
  ops.setHidePins(d, "gone.view", true);
  const changed = ops.invalidate(d, model, "2026-10-13");
  assert.deepEqual(d.views["demo_top.u_soc"], { hidePins: true }, "a schematic view with no positions keeps its override");
  assert.deepEqual(d.views["demo_top.u_soc.g_ch[0].u_ch"], { hidePins: true }, "a leaf has no schematic keys but is a view (its symbol)");
  assert.equal(d.views["gone.view"], undefined, "a view that is no instance goes");
  assert.equal(changed, true);
  assert.equal(ops.invalidate(d, model, "2026-10-13"), false, "stable afterwards");
});

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
  // the camera is not persisted (session state, docs/04): a field inherited
  // from an old file disappears on serialization
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
  // flip + position: returning to non-flipped keeps the position
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
  // another view stays untouched
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
  // din has render=label in the model (fanout 9); the user requests wire
  ops.setNetRender(d, "demo_top.u_soc", "din", "wire", "label");
  assert.deepEqual(d.views["demo_top.u_soc"].nets, { din: { render: "wire" } });
  const back = ops.parseSidecar(ops.serializeSidecar(d));
  assert.deepEqual(back.views["demo_top.u_soc"].nets, {
    din: { render: "wire" },
  });
  // returning to the suggestion deletes the override and the empty view disappears
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
  // "reappearance": the orphan gets the name of a real net and is restored
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

// ---------------------------------------------------------------- docs/08 R21
const V = "demo_top.u_soc";
const annot = (over = {}) => ({ frames: {}, notes: {}, colors: {}, ...over });

test("R21: setAnnotations writes frames, notes and node colours; getAnnotations reads them back", () => {
  const d = ops.emptySidecar();
  ops.setNodePos(d, V, "u_add", 8, 16);
  const a = annot({
    frames: { "frame:1": { title: "datapath", color: "blue", members: ["u_add", "u_inv"] } },
    notes: { "note:1": { x: 40, y: 80, text: "check the carry", color: "yellow" } },
    colors: { u_add: "green", u_inv: "red" },
  });
  ops.setAnnotations(d, V, a);
  assert.deepEqual(d.views[V].nodes.u_add, { x: 8, y: 16, color: "green" }, "the position is untouched");
  assert.deepEqual(d.views[V].nodes.u_inv, { color: "red" }, "a colour alone is an entry");
  assert.deepEqual(ops.getAnnotations(d, V), a);
  // a detached copy: mutating it does not reach the sidecar
  ops.getAnnotations(d, V).frames["frame:1"].members.push("x");
  assert.deepEqual(d.views[V].frames["frame:1"].members, ["u_add", "u_inv"]);
  // the serializer WHITELISTS: frames and notes must survive a round trip
  const back = ops.parseSidecar(ops.serializeSidecar(d));
  assert.deepEqual(ops.getAnnotations(back, V), a);
});

test("R21: a whole replace — what is not sent is gone, and an emptied view disappears", () => {
  const d = ops.emptySidecar();
  ops.setAnnotations(d, V, annot({
    frames: { "frame:1": { title: "a", members: ["u_add"] } },
    notes: { "note:1": { x: 0, y: 0, text: "n" } },
    colors: { u_add: "green" },
  }));
  ops.setAnnotations(d, V, annot({ notes: { "note:1": { x: 0, y: 0, text: "n" } } }));
  assert.deepEqual(d.views[V], { notes: { "note:1": { x: 0, y: 0, text: "n" } } },
    "the frame and the colour are gone, the node entry with them");
  ops.setAnnotations(d, V, annot());
  assert.equal(d.views[V], undefined, "the file holds only overrides");
  // a view holding ONLY a note is not judged empty by another mutation's prune
  ops.setAnnotations(d, V, annot({ notes: { "note:1": { x: 0, y: 0, text: "n" } } }));
  ops.setHidePins(d, V, true);
  ops.setHidePins(d, V, false);
  assert.deepEqual(Object.keys(d.views[V]), ["notes"]);
});

test("R21: what arrives is sanitised — empty frames, bad ids, bad colours, double membership", () => {
  const d = ops.emptySidecar();
  ops.setAnnotations(d, V, annot({
    frames: {
      "frame:1": { title: "  keeps  ", color: "pink", members: ["u_add", "u_add", "", 7] },
      "frame:2": { title: "second claim", members: ["u_add", "u_inv"] },
      "frame:3": { title: "empty", members: [] },
      bogus: { title: "bad id", members: ["u_inv"] },
    },
    notes: {
      "note:1": { x: 1, y: 2, text: "   " },
      "note:2": { x: NaN, y: 2, text: "t" },
      "note:3": { x: 1, y: 2, text: "ok", color: "purple" },
      other: { x: 1, y: 2, text: "bad id" },
    },
    colors: { u_add: "green", u_inv: "#ff0000", "": "blue" },
  }));
  assert.deepEqual(d.views[V].frames, {
    "frame:1": { title: "keeps", members: ["u_add"] },
    "frame:2": { title: "second claim", members: ["u_inv"] },
  }, "a node belongs to ONE frame; an unknown colour is dropped; an empty frame is not written");
  assert.deepEqual(d.views[V].notes, { "note:3": { x: 1, y: 2, text: "ok", color: "purple" } });
  assert.deepEqual(d.views[V].nodes, { u_add: { color: "green" } });
});

test("R21: clearPositions (Re-arrange all) keeps the colours, the frames and the notes", () => {
  const d = ops.emptySidecar();
  ops.setNodePos(d, V, "u_add", 8, 16);
  ops.setNodePos(d, V, "u_inv", 8, 96);
  ops.setAnnotations(d, V, annot({
    frames: { "frame:1": { title: "f", members: ["u_add"] } },
    notes: { "note:1": { x: 0, y: 0, text: "n" } },
    colors: { u_add: "green" },
  }));
  ops.clearPositions(d, V);
  assert.deepEqual(d.views[V], {
    nodes: { u_add: { color: "green" } },
    frames: { "frame:1": { title: "f", members: ["u_add"] } },
    notes: { "note:1": { x: 0, y: 0, text: "n" } },
  });
});

test("R21: invalidate — a coloured node that disappears migrates with its colour and comes back", () => {
  const d = ops.emptySidecar();
  ops.setAnnotations(d, V, annot({ colors: { u_add: "green", gone: "red" } }));
  assert.equal(ops.invalidate(d, model, "2026-11-21"), true);
  assert.deepEqual(d.views[V].nodes, { u_add: { color: "green" } });
  assert.deepEqual(d.orphans, [
    { view: V, node: "gone", value: { color: "red" }, lastSeen: "2026-11-21" },
  ]);
});

test("R21: invalidate — a frame stays while ONE member lives (dead ids inert), migrates whole when none does", () => {
  const d = ops.emptySidecar();
  ops.setAnnotations(d, V, annot({
    frames: {
      "frame:1": { title: "half", members: ["u_add", "gone"] },
      "frame:2": { title: "dead", color: "red", members: ["gone2", "gone3"] },
      "frame:3": { title: "around a note", members: ["note:1"] },
    },
    notes: { "note:1": { x: 0, y: 0, text: "n" } },
  }));
  ops.invalidate(d, model, "2026-11-21");
  assert.deepEqual(d.views[V].frames, {
    "frame:1": { title: "half", members: ["u_add", "gone"] },
    "frame:3": { title: "around a note", members: ["note:1"] },
  }, "the dead member id is kept: it comes back with its node");
  assert.deepEqual(d.orphans, [{
    view: V, node: "frame:2", kind: "frame",
    value: { title: "dead", color: "red", members: ["gone2", "gone3"] },
    lastSeen: "2026-11-21",
  }]);
  // a member reappears: the frame is restored whole
  d.orphans[0].value.members = ["gone2", "u_inv"];
  ops.invalidate(d, model, "2026-11-22");
  assert.equal(d.orphans.length, 0);
  assert.equal(d.views[V].frames["frame:2"].title, "dead");
});

test("R21: invalidate — a view that disappears takes its frames and notes into orphans; they return with it", () => {
  const d = ops.emptySidecar();
  ops.setAnnotations(d, "demo_top.not_there", annot({
    frames: { "frame:1": { title: "f", members: ["x"] } },
    notes: { "note:1": { x: 8, y: 8, text: "kept" } },
  }));
  ops.invalidate(d, model, "2026-11-21");
  assert.equal(d.views["demo_top.not_there"], undefined);
  assert.deepEqual(d.orphans.map((o) => [o.kind, o.node]).sort(), [["frame", "frame:1"], ["note", "note:1"]]);
  // "the view is back": the note returns at once, the frame once a member is a key
  for (const o of d.orphans) {
    o.view = V;
  }
  ops.invalidate(d, model, "2026-11-22");
  assert.deepEqual(d.views[V].notes, { "note:1": { x: 8, y: 8, text: "kept" } });
  assert.deepEqual(d.orphans.map((o) => o.kind), ["frame"], "no member of it exists yet");
});

test("R21: parseSidecar reads the notation through the write-side sanitiser — a malformed entry never throws later", () => {
  const text = [
    "schema_version: 1",
    "views:",
    `  ${V}:`,
    "    nodes:",
    "      u_add: {x: 8, y: 16, color: pink}",
    "      u_inv: {color: green}",
    "    frames:",
    "      'frame:1': {title: no members}",
    "      'frame:2':",
    "      'frame:3': {title: ok, members: [u_add, 7, u_inv]}",
    "    notes:",
    "      'note:1': {x: 1, y: 2, text: 42}",
    "      'note:2': {x: 1, y: 2, text: kept}",
    "      'note:3':",
    "  broken_view: 5",
    "orphans: [null, {view: v, node: n, value: {}, lastSeen: x}]",
    "",
  ].join("\n");
  const d = ops.parseSidecar(text);
  assert.deepEqual(d.views[V].frames, { "frame:3": { title: "ok", members: ["u_add", "u_inv"] } });
  assert.deepEqual(d.views[V].notes, { "note:2": { x: 1, y: 2, text: "kept" } });
  assert.deepEqual(d.views[V].nodes, { u_add: { x: 8, y: 16 }, u_inv: { color: "green" } }, "an unknown colour name is dropped");
  assert.equal(d.views.broken_view, undefined);
  assert.equal(d.orphans.length, 1, "a null orphan is not an orphan");
  // the two calls that used to throw on such a file
  assert.doesNotThrow(() => ops.invalidate(d, model, "2026-11-21"));
  assert.doesNotThrow(() => ops.getAnnotations(d, V));
  // a view left with frames/notes that are ALL malformed has no such keys
  const e = ops.parseSidecar(`schema_version: 1\nviews:\n  ${V}:\n    frames: {a: 1}\n    notes: x\norphans: []\n`);
  assert.deepEqual(e.views[V], {});
});

test("R21: a double claim is resolved by frame NUMBER (frame:2 before frame:10), on write and on read", () => {
  const d = ops.emptySidecar();
  ops.setAnnotations(d, V, annot({
    frames: {
      "frame:10": { title: "ten", members: ["u_add", "u_inv"] },
      "frame:2": { title: "two", members: ["u_add"] },
    },
  }));
  assert.deepEqual(d.views[V].frames, {
    "frame:2": { title: "two", members: ["u_add"] },
    "frame:10": { title: "ten", members: ["u_inv"] },
  });
  // the limits are the webview's: a title of 80, a note of 2000
  ops.setAnnotations(d, V, annot({
    frames: { "frame:1": { title: "t".repeat(300), members: ["u_add"] } },
    notes: { "note:1": { x: 0, y: 0, text: "n".repeat(5000) } },
  }));
  assert.equal(d.views[V].frames["frame:1"].title.length, 80);
  assert.equal(d.views[V].notes["note:1"].text.length, 2000);
  assert.doesNotThrow(() => ops.setAnnotations(d, V, null));
});

test("R21: invalidate — an orphaned frame whose id was reused comes back under a NEW id, not dropped", () => {
  const d = ops.emptySidecar();
  ops.setAnnotations(d, V, annot({ frames: { "frame:1": { title: "old", members: ["gone"] } } }));
  ops.invalidate(d, model, "2026-11-21");
  assert.equal(d.orphans[0].node, "frame:1");
  // meanwhile the user frames something else: the counter gives frame:1 again
  ops.setAnnotations(d, V, annot({ frames: { "frame:1": { title: "new", members: ["u_add"] } } }));
  // the old frame's member returns
  d.orphans[0].value.members = ["u_inv"];
  ops.invalidate(d, model, "2026-11-22");
  assert.deepEqual(d.views[V].frames, {
    "frame:1": { title: "new", members: ["u_add"] },
    "frame:2": { title: "old", members: ["u_inv"] },
  });
  assert.equal(d.orphans.length, 0);
});

test("R21: invalidate — a vanished view's frame around NOTES ONLY returns with its notes", () => {
  const d = ops.emptySidecar();
  ops.setAnnotations(d, "demo_top.not_there", annot({
    frames: { "frame:1": { title: "remarks", members: ["note:1", "note:2"] } },
    notes: { "note:1": { x: 0, y: 0, text: "a" }, "note:2": { x: 0, y: 40, text: "b" } },
  }));
  ops.invalidate(d, model, "2026-11-21");
  assert.equal(d.orphans.length, 3);
  for (const o of d.orphans) {
    o.view = V; // "the view is back"
  }
  ops.invalidate(d, model, "2026-11-22");
  assert.equal(d.orphans.length, 0, "the frame did not wait for a node key that would never come");
  assert.deepEqual(d.views[V].frames["frame:1"].members, ["note:1", "note:2"]);
  // a note restored under a new id (its own was reused) is followed by its frame
  const e = ops.emptySidecar();
  ops.setAnnotations(e, V, annot({ notes: { "note:1": { x: 9, y: 9, text: "newer" } } }));
  e.orphans.push(
    { view: V, node: "note:1", kind: "note", value: { x: 0, y: 0, text: "older" }, lastSeen: "x" },
    { view: V, node: "frame:1", kind: "frame", value: { title: "f", members: ["note:1"] }, lastSeen: "x" }
  );
  ops.invalidate(e, model, "2026-11-22");
  assert.deepEqual(e.views[V].notes, {
    "note:1": { x: 9, y: 9, text: "newer" },
    "note:2": { x: 0, y: 0, text: "older" },
  });
  assert.deepEqual(e.views[V].frames["frame:1"].members, ["note:2"], "the frame follows its note's new id");
});

test("R21: invalidate — a dead frame re-added by a stale whole set does not pile up duplicate orphans", () => {
  const d = ops.emptySidecar();
  const stale = annot({ frames: { "frame:1": { title: "dead", members: ["gone"] } } });
  ops.setAnnotations(d, V, stale);
  ops.invalidate(d, model, "2026-11-21");
  ops.setAnnotations(d, V, stale); // another surface's mirror writes it back
  ops.invalidate(d, model, "2026-11-22");
  assert.equal(d.orphans.length, 1);
  assert.equal(d.orphans[0].lastSeen, "2026-11-22");
  // a restore that cannot happen yet does not leave an empty view behind
  assert.equal(d.views[V], undefined);
});

test("R21: invalidate never touches a verification (tb:) view's annotations, nor a leaf instance's", () => {
  const d = ops.emptySidecar();
  const a = annot({
    frames: { "frame:1": { title: "f", members: ["agent:gone"] } },
    notes: { "note:1": { x: 0, y: 0, text: "n" } },
    colors: { "agent:gone": "blue" },
  });
  ops.setAnnotations(d, "tb:demo.quickuvm.yaml|env", a);
  const leaf = model.instances.find((i) => !model.views[i.path]).path;
  ops.setAnnotations(d, leaf, annot({ notes: { "note:1": { x: 0, y: 0, text: "on a leaf" } } }));
  ops.invalidate(d, model, "2026-11-21");
  assert.deepEqual(ops.getAnnotations(d, "tb:demo.quickuvm.yaml|env"), a);
  assert.deepEqual(d.views[leaf].notes, { "note:1": { x: 0, y: 0, text: "on a leaf" } });
  assert.equal(d.orphans.length, 0);
});

// ---------------------------------------------------------------- docs/08 R23
test("R23: setFilters keeps the rules in ORDER, sanitised; no rules, no key; a round trip survives", () => {
  const d = ops.emptySidecar();
  ops.setFilters(d, V, {
    rules: [
      { effect: "show", name: "^u_add$" },
      { effect: "hide", kind: "instance" },
      { effect: "bogus" },
      { effect: "red", kind: " fold " },
    ],
    off: true,
  });
  assert.deepEqual(d.views[V].filters, {
    rules: [
      { effect: "show", name: "^u_add$" },
      { effect: "hide", kind: "instance" },
      { effect: "red", kind: "fold" },
    ],
    off: true,
  }, "the order is the meaning: the first matching rule decides");
  const back = ops.parseSidecar(ops.serializeSidecar(d));
  assert.deepEqual(back.views[V].filters, d.views[V].filters, "the serializer whitelists: filters must be copied");
  ops.setFilters(d, V, { rules: [] });
  assert.equal(d.views[V], undefined, "no rules: the key goes, and the empty view with it");
  assert.doesNotThrow(() => ops.setFilters(d, V, null));
  assert.doesNotThrow(() => ops.setFilters(d, V, "x"));
});

test("R23: a view holding only filters is a view; a hand-edited rule list is read through the sanitiser", () => {
  const d = ops.emptySidecar();
  ops.setFilters(d, V, { rules: [{ effect: "dim", kind: "instance" }] });
  ops.setHidePins(d, V, true);
  ops.setHidePins(d, V, false);
  assert.deepEqual(Object.keys(d.views[V]), ["filters"], "another mutation's prune does not judge it empty");
  assert.equal(ops.invalidate(d, model, "2026-11-21"), false, "the view exists: its rules stay");
  assert.deepEqual(d.views[V].filters.rules, [{ effect: "dim", kind: "instance" }]);
  const e = ops.parseSidecar(
    `schema_version: 1\nviews:\n  ${V}:\n    filters:\n      rules: [{effect: hide, name: 7}, nope, {effect: explode}]\n      off: true\norphans: []\n`
  );
  assert.deepEqual(e.views[V].filters, { rules: [{ effect: "hide" }], off: true });
  const f = ops.parseSidecar(`schema_version: 1\nviews:\n  ${V}:\n    filters: 5\norphans: []\n`);
  assert.equal(f.views[V].filters, undefined);
});

test("R23: invalidate — a vanished view's rules wait in orphans and return with it; a tb: view and a leaf keep theirs", () => {
  const d = ops.emptySidecar();
  const rules = { rules: [{ effect: "hide", kind: "instance", name: "^u_" }] };
  ops.setFilters(d, "demo_top.not_there", rules);
  ops.setFilters(d, "tb:demo.quickuvm.yaml|env", rules);
  const leaf = model.instances.find((i) => !model.views[i.path]).path;
  ops.setFilters(d, leaf, rules);
  ops.invalidate(d, model, "2026-11-21");
  assert.equal(d.views["demo_top.not_there"], undefined);
  assert.deepEqual(d.orphans.map((o) => [o.kind, o.node]), [["filters", "filters"]]);
  assert.deepEqual(d.views["tb:demo.quickuvm.yaml|env"].filters, rules);
  assert.deepEqual(d.views[leaf].filters, rules);
  // twice: replaced, not duplicated
  ops.setFilters(d, "demo_top.not_there", rules);
  ops.invalidate(d, model, "2026-11-22");
  assert.equal(d.orphans.length, 1);
  // the view is back: restored — unless newer rules were written meanwhile
  d.orphans[0].view = V;
  ops.invalidate(d, model, "2026-11-23");
  assert.deepEqual(d.views[V].filters, rules);
  assert.equal(d.orphans.length, 0);
  const n = ops.emptySidecar();
  ops.setFilters(n, V, { rules: [{ effect: "dim" }] });
  n.orphans.push({ view: V, node: "filters", kind: "filters", value: rules, lastSeen: "x" });
  ops.invalidate(n, model, "2026-11-23");
  assert.deepEqual(n.views[V].filters, { rules: [{ effect: "dim" }] }, "the newer rules stay");
});

test("R23 review: a view holding ONLY filters survives a frame orphan that keeps waiting for it", () => {
  // the orphan pass asks `viewOf` for the view and, when the frame cannot come
  // back yet, drops the view "it created for nothing" — judged by a hand-rolled
  // key list that did not know `filters`: the rules were deleted on a recompile
  const d = ops.emptySidecar();
  const rules = { rules: [{ effect: "hide", kind: "instance", name: "^u_" }] };
  ops.setFilters(d, V, rules);
  d.orphans.push({
    view: V,
    node: "frame:1",
    kind: "frame",
    value: { title: "gone", members: ["no_such_node"] },
    lastSeen: "2026-11-01",
  });
  ops.invalidate(d, model, "2026-11-21");
  assert.deepEqual(d.views[V]?.filters, rules, "the rules are the user's work");
  assert.equal(d.orphans.length, 1, "the frame still waits");
  // and a view that really is empty is still cleaned up
  const e = ops.emptySidecar();
  e.orphans.push({ ...d.orphans[0] });
  ops.invalidate(e, model, "2026-11-21");
  assert.equal(e.views[V], undefined);
});

// ------------------------------ hand-routed wires (docs/04 level 3, D27)

const SOC = "demo_top.u_soc";
/** an edge of the regression view: `sum` runs from the adder to the port */
const SUM = "sum:u_add.dout-><port>.sum";
/** the same net's edge ids: while the generate fold is folded / expanded */
const CH_FOLDED = "ch_out:g_ch[0..2].u_ch.dout-><port>.ch_out";
const CH_MEMBER = "ch_out:g_ch[1].u_ch.dout-><port>.ch_out";

test("D27: a route is a patch by edge id — set, replace, null = back to automatic; the view goes when empty", () => {
  const d = ops.emptySidecar();
  ops.setEdgeRoutes(d, SOC, { [SUM]: "source+16 source-40 target-16" });
  assert.deepEqual(d.views[SOC], { edges: { [SUM]: { route: "source+16 source-40 target-16" } } });
  // another edge: the first is not named by the patch and stays (the sender's
  // mirror may be older than the file)
  ops.setEdgeRoutes(d, SOC, { [CH_FOLDED]: "target-16" });
  assert.deepEqual(Object.keys(d.views[SOC].edges).sort(), [CH_FOLDED, SUM].sort());
  ops.setEdgeRoutes(d, SOC, { [SUM]: "source+24" });
  assert.equal(d.views[SOC].edges[SUM].route, "source+24");
  ops.setEdgeRoutes(d, SOC, { [SUM]: null, [CH_FOLDED]: null });
  assert.equal(d.views[SOC], undefined, "a view holding nothing is not kept");
  // null for an edge that has no route is a no-op, and creates no view
  ops.setEdgeRoutes(d, SOC, { [SUM]: null });
  assert.equal(d.views[SOC], undefined);
});

test("D27: what arrives is sanitised — a route that does not parse removes the override, never stores junk", () => {
  const d = ops.emptySidecar();
  ops.setEdgeRoutes(d, SOC, { [SUM]: "source+40" });
  for (const junk of ["source+40 target-8", "left+8", 5, {}, [], "", "source+1e9"]) {
    ops.setEdgeRoutes(d, SOC, { [SUM]: "source+40" });
    ops.setEdgeRoutes(d, SOC, { [SUM]: junk });
    assert.equal(d.views[SOC], undefined, `not a route: ${JSON.stringify(junk)}`);
  }
  for (const patch of [null, undefined, "x", 5, [["a", "source+8"]]]) {
    ops.setEdgeRoutes(d, SOC, patch);
    assert.equal(d.views[SOC], undefined, `not a patch: ${JSON.stringify(patch)}`);
  }
  // the canonical form is what is kept
  ops.setEdgeRoutes(d, SOC, { [SUM]: "  source+40   target-8  target+0 " });
  assert.equal(d.views[SOC].edges[SUM].route, "source+40 target-8 target+0");
  // an empty edge id is nobody's
  ops.setEdgeRoutes(d, SOC, { "": "source+8" });
  assert.deepEqual(Object.keys(d.views[SOC].edges), [SUM]);
});

test("D27: the routes survive the file round trip, sorted; a hand-edited entry is read through the sanitiser", () => {
  const d = ops.emptySidecar();
  ops.setEdgeRoutes(d, SOC, { "z:a.o->b.i": "source+8", [SUM]: "source+16 source-40 target-16" });
  ops.setEdgeRoutes(d, "tb:x.yaml|env", { "e:cov:cmd": "target-14" });
  const text = ops.serializeSidecar(d);
  assert.match(text, /route: source\+16 source-40 target-16/, "one line per edge");
  const back = ops.parseSidecar(text);
  assert.deepEqual(back.views[SOC].edges, d.views[SOC].edges, "the serializer WHITELISTS: edges must be copied");
  assert.deepEqual(Object.keys(back.views[SOC].edges), [SUM, "z:a.o->b.i"], "sorted keys: a stable diff");
  assert.deepEqual(back.views["tb:x.yaml|env"].edges, { "e:cov:cmd": { route: "target-14" } });
  // a hand-edited file: junk entries are dropped at the read, the good one stays
  const hand = ops.parseSidecar(
    [
      "schema_version: 1",
      "views:",
      `  ${SOC}:`,
      "    edges:",
      "      good: {route: source+8}",
      "      bad: {route: sideways}",
      "      empty:",
      "      scalar: 5",
      "      even: {route: source+8 target-8}",
      "  only.junk:",
      "    edges: [1, 2]",
      "orphans: []",
    ].join("\n")
  );
  assert.deepEqual(hand.views[SOC].edges, { good: { route: "source+8" } });
  assert.equal(hand.views["only.junk"].edges, undefined, "a list is not an edge map");
  // and nothing throws afterwards
  ops.invalidate(hand, model, "2026-11-21");
});

test("D27: positions, nets and annotations are untouched by a route; a route-only view is a view", () => {
  const d = ops.emptySidecar();
  ops.setNodePos(d, SOC, "u_add", 120, 80);
  ops.setNetRender(d, SOC, "din", "wire", "label");
  ops.setEdgeRoutes(d, SOC, { [SUM]: "source+40" });
  ops.setEdgeRoutes(d, SOC, { [SUM]: null });
  assert.deepEqual(d.views[SOC], { nodes: { u_add: { x: 120, y: 80 } }, nets: { din: { render: "wire" } } });
  ops.setEdgeRoutes(d, SOC, { [SUM]: "source+40" });
  ops.clearPositions(d, SOC);
  assert.deepEqual(d.views[SOC].edges, { [SUM]: { route: "source+40" } }, "clearPositions clears positions");
  ops.clearRoutes(d, SOC);
  assert.equal(d.views[SOC].edges, undefined, "\"Re-arrange all\" takes the routes too");
  assert.deepEqual(d.views[SOC].nets, { din: { render: "wire" } });
  // a view whose only content is a route is kept by invalidate
  const e = ops.emptySidecar();
  ops.setEdgeRoutes(e, SOC, { [SUM]: "source+40" });
  assert.equal(ops.invalidate(e, model, "2026-11-21"), false);
  assert.deepEqual(e.views[SOC], { edges: { [SUM]: { route: "source+40" } } });
});

test("D27: validEdgeIds knows an edge under every fold state, and a label net's edges too", () => {
  const ids = ops.validEdgeIds(model, SOC);
  assert.ok(ids.has(SUM));
  assert.ok(ids.has(CH_FOLDED), "the generate fold folded");
  assert.ok(ids.has(CH_MEMBER), "and expanded: another id for the same wire");
  // `din` is shown as a LABEL (fan-out 9): it has no edges now, but its routes
  // must wait for the day it is switched to a wire
  assert.ok([...ids].some((id) => id.startsWith("din:")), "a label net's edges are valid ids");
  assert.ok(!ids.has("sum:u_add.dout-><port>.nope"));
  assert.equal(ops.validEdgeIds(model, "no.such.view"), null);
  assert.equal(ops.validEdgeIds(model, "demo_top.u_soc.u_add"), null, "a leaf has no schematic");
});

test("D27: invalidate — a route whose edge is gone waits in orphans and returns with it", () => {
  const d = ops.emptySidecar();
  ops.setEdgeRoutes(d, SOC, {
    [SUM]: "source+40",
    [CH_MEMBER]: "target-16",
    "sum:u_add.dout-><port>.renamed": "source+8",
  });
  assert.equal(ops.invalidate(d, model, "2026-11-21"), true);
  assert.deepEqual(Object.keys(d.views[SOC].edges).sort(), [CH_MEMBER, SUM].sort(), "both fold states are valid");
  assert.deepEqual(d.orphans, [
    {
      view: SOC,
      node: "sum:u_add.dout-><port>.renamed",
      kind: "edge",
      value: { route: "source+8" },
      lastSeen: "2026-11-21",
    },
  ]);
  // a second pass moves nothing and piles nothing up
  assert.equal(ops.invalidate(d, model, "2026-11-22"), false);
  assert.equal(d.orphans.length, 1);
  // the edge reappears (the orphan's id is made valid by renaming it to a real one)
  d.orphans[0].node = CH_FOLDED;
  assert.equal(ops.invalidate(d, model, "2026-11-23"), true);
  assert.equal(d.views[SOC].edges[CH_FOLDED].route, "source+8");
  assert.equal(d.orphans.length, 0);
});

test("D27: invalidate — a restored route does not step over a newer one; a junk orphan is dropped", () => {
  const d = ops.emptySidecar();
  ops.setEdgeRoutes(d, SOC, { [SUM]: "source+24" });
  d.orphans.push(
    { view: SOC, node: SUM, kind: "edge", value: { route: "source+80" }, lastSeen: "2026-01-01" },
    { view: SOC, node: CH_FOLDED, kind: "edge", value: { route: "sideways" }, lastSeen: "2026-01-01" },
    { view: SOC, node: CH_MEMBER, kind: "edge", value: null, lastSeen: "2026-01-01" }
  );
  ops.invalidate(d, model, "2026-11-21");
  assert.deepEqual(d.views[SOC].edges, { [SUM]: { route: "source+24" } }, "the newer route stays");
  assert.equal(d.orphans.length, 0, "the orphans are consumed, restored or not");
});

test("D27: invalidate — a vanished view's routes migrate and come back; a verification view is never touched", () => {
  const d = ops.emptySidecar();
  ops.setEdgeRoutes(d, "gone.view", { "n:a.o->b.i": "source+8" });
  ops.setEdgeRoutes(d, "tb:x.yaml|env", { "e:whatever": "source+8" });
  ops.setEdgeRoutes(d, "tb:x.yaml|agent:cmd", { "e:drv.if": "target-8" });
  ops.invalidate(d, model, "2026-11-21");
  assert.equal(d.views["gone.view"], undefined);
  assert.deepEqual(d.orphans.map((o) => [o.view, o.node, o.kind]), [["gone.view", "n:a.o->b.i", "edge"]]);
  assert.deepEqual(d.views["tb:x.yaml|env"].edges, { "e:whatever": { route: "source+8" } });
  assert.deepEqual(d.views["tb:x.yaml|agent:cmd"].edges, { "e:drv.if": { route: "target-8" } });
  // the round trip keeps the orphan
  const back = ops.parseSidecar(ops.serializeSidecar(d));
  assert.deepEqual(back.orphans, d.orphans);
});

test("D27: an orphaned route re-orphaned replaces its entry (no duplicates), and cleanEdges caps a file", () => {
  const d = ops.emptySidecar();
  const DEAD = "sum:u_add.dout-><port>.dead";
  d.orphans.push({ view: SOC, node: DEAD, kind: "edge", value: { route: "source+8" }, lastSeen: "2026-01-01" });
  ops.setEdgeRoutes(d, SOC, { [DEAD]: "source+16" });
  ops.invalidate(d, model, "2026-11-21");
  assert.deepEqual(
    d.orphans.filter((o) => o.node === DEAD).map((o) => o.value.route),
    ["source+16"],
    "one entry, the newer route"
  );
  const many = {};
  for (let i = 0; i < ops.EDGE_OVERRIDES_MAX + 50; i++) {
    many[`e${i}`] = { route: "source+8" };
  }
  assert.equal(Object.keys(ops.cleanEdges(many)).length, ops.EDGE_OVERRIDES_MAX);
  // the same cap on a patch: a full view takes no NEW edge, but an edge it
  // already holds can still be re-routed or reset
  const full = ops.emptySidecar();
  full.views[SOC] = { edges: ops.cleanEdges(many) };
  ops.setEdgeRoutes(full, SOC, { extra: "source+8", e0: "source+16", e1: null });
  assert.equal(full.views[SOC].edges.extra, undefined);
  assert.equal(full.views[SOC].edges.e0.route, "source+16");
  assert.equal(full.views[SOC].edges.e1, undefined);
  assert.deepEqual(ops.cleanEdges(null), {});
  assert.deepEqual(ops.cleanEdges([{ route: "source+8" }]), {});
});

console.log(`\ntest-sidecar: ${passed} teste au trecut.`);
