// Node tests for the secondary notation (src/webview/annotations.ts — docs/08
// R21): frames as member lists with derived boxes, notes, colours, the
// containment test at a drag's end, the carry of a rename, the note wrapping.
//   npm run test:annotations
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-annotations-"));
const outFile = join(outDir, "annotations.mjs");
await esbuild.build({
  entryPoints: ["src/webview/annotations.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const A = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}
const empty = () => A.emptyAnnotations();
const frozen = (a) => JSON.parse(JSON.stringify(a));

test("ids: the smallest free number of the kind", () => {
  assert.equal(A.nextId("frame", []), "frame:1");
  assert.equal(A.nextId("note", ["note:1", "note:2", "frame:3"]), "note:3");
  assert.equal(A.nextId("frame", ["frame:1", "frame:3"]), "frame:2", "a freed id is reused");
});

test("frame: a new frame takes its members out of the frame they were in; no members, no frame", () => {
  const a0 = empty();
  const r1 = A.addFrame(a0, ["u_a", "u_b", "u_a"], "datapath");
  assert.equal(r1.id, "frame:1");
  assert.deepEqual(r1.annotations.frames, { "frame:1": { title: "datapath", members: ["u_a", "u_b"] } });
  assert.deepEqual(a0, empty(), "the input is never mutated");
  // u_b moves to a second frame: one frame per member
  const r2 = A.addFrame(r1.annotations, ["u_b", "u_c"], "control");
  assert.deepEqual(r2.annotations.frames, {
    "frame:1": { title: "datapath", members: ["u_a"] },
    "frame:2": { title: "control", members: ["u_b", "u_c"] },
  });
  // taking the LAST member of a frame deletes that frame
  const r3 = A.addFrame(r2.annotations, ["u_a"], "alone");
  assert.deepEqual(Object.keys(r3.annotations.frames).sort(), ["frame:1", "frame:2"]);
  assert.deepEqual(r3.annotations.frames["frame:1"], { title: "alone", members: ["u_a"] },
    "the emptied frame:1 went, and its id was reused");
  assert.equal(A.addFrame(a0, [], "x").id, null);
  assert.equal(A.addFrame(a0, ["frame:9"], "x").id, null, "a frame is not a member of a frame");
});

test("frame: join, leave, delete, retitle", () => {
  let a = A.addFrame(empty(), ["u_a"], "f").annotations;
  a = A.joinFrame(a, "frame:1", "u_b");
  assert.deepEqual(a.frames["frame:1"].members, ["u_a", "u_b"]);
  assert.equal(A.joinFrame(a, "frame:1", "u_b"), a, "already a member: the same object (no edit)");
  assert.equal(A.joinFrame(a, "frame:9", "u_c"), a, "an unknown frame: no edit");
  assert.equal(A.frameOf(a, "u_b"), "frame:1");
  assert.equal(A.frameOf(a, "u_z"), null);
  a = A.leaveFrame(a, "u_a");
  assert.deepEqual(a.frames["frame:1"].members, ["u_b"]);
  assert.equal(A.leaveFrame(a, "u_a"), a, "not a member: no edit");
  const gone = A.leaveFrame(a, "u_b");
  assert.deepEqual(gone.frames, {}, "the last member leaving deletes the frame");
  assert.equal(A.setFrameTitle(a, "frame:1", "f"), a, "the same title: no edit");
  assert.equal(A.setFrameTitle(a, "frame:1", "g").frames["frame:1"].title, "g");
  assert.deepEqual(A.deleteFrame(a, "frame:1").frames, {});
  assert.equal(A.deleteFrame(a, "frame:9"), a);
});

test("frame box: the members' bounding box plus padding and the title band; none on screen, no box", () => {
  const r = A.frameRect([
    { x: 100, y: 200, w: 80, h: 40 },
    { x: 240, y: 160, w: 40, h: 120 },
  ]);
  // x 100..280, y 160..280
  assert.deepEqual(r, {
    x: 100 - A.FRAME_PAD,
    y: 160 - A.FRAME_PAD - A.FRAME_TITLE_H,
    w: 180 + 2 * A.FRAME_PAD,
    h: 120 + 2 * A.FRAME_PAD + A.FRAME_TITLE_H,
  });
  assert.equal(A.frameRect([]), null);
  // a frame with one live member and one dead id still has a box; all dead, none
  const a = A.addFrame(empty(), ["u_a", "gone"], "f").annotations;
  const rects = { u_a: { x: 0, y: 0, w: 80, h: 40 } };
  assert.equal(A.frameRects(a, (id) => rects[id] ?? null).size, 1);
  assert.equal(A.frameRects(a, () => null).size, 0, "not drawn — and not deleted: " + JSON.stringify(a.frames));
});

test("notes: add, edit, move, delete; empty text makes no note and deletes one", () => {
  const r = A.addNote(empty(), 40, 80, "check the carry");
  assert.equal(r.id, "note:1");
  assert.deepEqual(r.annotations.notes, { "note:1": { x: 40, y: 80, text: "check the carry" } });
  assert.equal(A.addNote(empty(), 0, 0, "   \n ").id, null);
  let a = r.annotations;
  assert.equal(A.setNoteText(a, "note:1", "check the carry"), a, "the same text: no edit");
  assert.equal(A.setNoteText(a, "note:1", "new").notes["note:1"].text, "new");
  assert.deepEqual(A.setNoteText(a, "note:1", "  ").notes, {}, "emptied: deleted");
  assert.equal(A.moveNotes(a, { "note:1": { x: 40, y: 80 } }), a, "the same place: no edit");
  assert.deepEqual(A.moveNotes(a, { "note:1": { x: 48, y: 96 }, "note:9": { x: 0, y: 0 } }).notes["note:1"],
    { x: 48, y: 96, text: "check the carry" });
  // a note in a frame: deleting it takes it out; the frame emptied by it goes too
  a = A.addFrame(a, ["note:1", "u_a"], "f").annotations;
  const d = A.deleteNote(a, "note:1");
  assert.deepEqual(d.notes, {});
  assert.deepEqual(d.frames["frame:1"].members, ["u_a"]);
  const solo = A.addFrame(r.annotations, ["note:1"], "f").annotations;
  assert.deepEqual(A.deleteNote(solo, "note:1"), empty());
});

test("colour: a node's goes into `colors`, a frame's and a note's is their own; null clears", () => {
  let a = A.addFrame(A.addNote(empty(), 0, 0, "n").annotations, ["u_a"], "f").annotations;
  a = A.setColor(a, ["u_a", "u_b", "frame:1", "note:1", "frame:9"], "green");
  assert.deepEqual(a.colors, { u_a: "green", u_b: "green" });
  assert.equal(a.frames["frame:1"].color, "green");
  assert.equal(a.notes["note:1"].color, "green");
  assert.equal(A.setColor(a, ["u_a"], "green"), a, "already that colour: no edit");
  const c = A.setColor(a, ["u_a", "frame:1", "note:1"], null);
  assert.deepEqual(c.colors, { u_b: "green" });
  assert.ok(!("color" in c.frames["frame:1"]) && !("color" in c.notes["note:1"]));
});

test("rename carry (R14): memberships and colours follow the new ids; nothing referenced, nothing changed", () => {
  let a = A.addFrame(empty(), ["agent:cmd", "cov:cmd", "sb:sbd"], "cmd path").annotations;
  a = A.setColor(a, ["agent:cmd", "sb:sbd"], "blue");
  const pairs = [["agent:cmd", "agent:req"], ["cov:cmd", "cov:req"], ["<if>.cmd", "<if>.req"]];
  const r = A.renameIds(a, pairs);
  assert.deepEqual(r.frames["frame:1"].members, ["agent:req", "cov:req", "sb:sbd"]);
  assert.deepEqual(r.colors, { "sb:sbd": "blue", "agent:req": "blue" });
  assert.equal(A.renameIds(a, [["agent:zz", "agent:yy"]]), a);
});

test("drag end: a moved, unframed item whose centre lands in a frame joins it — the smallest one", () => {
  const a = A.addFrame(A.addFrame(empty(), ["u_a"], "outer").annotations, ["u_b"], "inner").annotations;
  const boxes = new Map([
    ["frame:1", { x: 0, y: 0, w: 400, h: 400 }],
    ["frame:2", { x: 100, y: 100, w: 100, h: 100 }],
  ]);
  const at = (id, x, y) => ({ id, rect: { x, y, w: 40, h: 40 } });
  // centre (150,150): inside both -> the smaller
  assert.equal(A.frameOf(A.dropIntoFrames(a, boxes, [at("u_c", 130, 130)]), "u_c"), "frame:2");
  // centre (320,320): only the outer
  assert.equal(A.frameOf(A.dropIntoFrames(a, boxes, [at("u_c", 300, 300)]), "u_c"), "frame:1");
  // outside every box: nothing
  assert.equal(A.dropIntoFrames(a, boxes, [at("u_c", 600, 600)]), a);
  // a note is an item like any other
  assert.equal(A.frameOf(A.dropIntoFrames(a, boxes, [at("note:1", 300, 300)]), "note:1"), "frame:1");
});

test("drag end: an item joins by ENTERING a box — one that was already inside does not rejoin", () => {
  // u_c was taken out of frame:1 with "Remove from frame" and still lies between
  // its members; nudging it inside the box must not put it straight back
  const a = A.addFrame(empty(), ["u_a", "u_b"], "f").annotations;
  const boxes = new Map([["frame:1", { x: 0, y: 0, w: 400, h: 400 }]]);
  const inside = { x: 100, y: 100, w: 40, h: 40 };
  const nudged = { x: 108, y: 100, w: 40, h: 40 };
  assert.equal(A.dropIntoFrames(a, boxes, [{ id: "u_c", rect: nudged, from: inside }]), a);
  // from outside, the same end position joins
  const outside = { x: 600, y: 600, w: 40, h: 40 };
  assert.equal(A.frameOf(A.dropIntoFrames(a, boxes, [{ id: "u_c", rect: nudged, from: outside }]), "u_c"), "frame:1");
  // dragged out and back in ONE gesture: it never entered
  assert.equal(A.dropIntoFrames(a, boxes, [{ id: "u_c", rect: inside, from: inside }]), a);
});

test("limits and order are the host's: a title of 80, a note of 2000, frames by NUMBER", () => {
  const long = "x".repeat(5000);
  assert.equal(A.addFrame(empty(), ["u_a"], `  ${long}  `).annotations.frames["frame:1"].title.length, 80);
  const n = A.addNote(empty(), 0, 0, long).annotations;
  assert.equal(n.notes["note:1"].text.length, 2000);
  assert.equal(A.setNoteText(n, "note:1", long), n, "the same text after the cut: no edit");
  const titled = A.addFrame(empty(), ["u_a"], "t").annotations;
  assert.equal(A.setFrameTitle(titled, "frame:1", " t "), titled, "the same title after trimming: no edit");
  assert.deepEqual(A.byNumber(["frame:10", "frame:2", "frame:1"]), ["frame:1", "frame:2", "frame:10"]);
  // a double claim (a hand-edited file): the LOWER-numbered frame, as on the host
  const dbl = { frames: { "frame:10": { title: "ten", members: ["u_a"] }, "frame:2": { title: "two", members: ["u_a"] } }, notes: {}, colors: {} };
  assert.equal(A.frameOf(dbl, "u_a"), "frame:2");
});

test("drag end: a member never changes house by being dragged, and a frame is not a member", () => {
  const a = A.addFrame(A.addFrame(empty(), ["u_a"], "one").annotations, ["u_b"], "two").annotations;
  const boxes = new Map([
    ["frame:1", { x: 0, y: 0, w: 100, h: 100 }],
    ["frame:2", { x: 200, y: 0, w: 100, h: 100 }],
  ]);
  // u_a (of frame:1) dropped inside frame:2's box: it stays in frame:1
  assert.equal(A.dropIntoFrames(a, boxes, [{ id: "u_a", rect: { x: 220, y: 20, w: 40, h: 40 } }]), a);
  assert.equal(A.dropIntoFrames(a, boxes, [{ id: "frame:1", rect: { x: 220, y: 20, w: 40, h: 40 } }]), a);
});

test("equality and cloning: order-insensitive compare, deep copies", () => {
  const a = A.setColor(A.addFrame(empty(), ["u_a"], "f").annotations, ["u_b", "u_a"], "red");
  const b = frozen(a);
  b.colors = { u_a: "red", u_b: "red" };
  assert.equal(A.sameAnnotations(a, b), true, "key order does not matter");
  const c = A.cloneAnnotations(a);
  c.frames["frame:1"].members.push("x");
  assert.deepEqual(a.frames["frame:1"].members, ["u_a"], "the clone is deep");
  assert.equal(A.sameAnnotations(a, c), false);
});

// --------------------------------------------------------------- note text
const mono = (s) => s.length * 7; // 7px per character

test("wrap: at word boundaries, the user's line breaks kept, a long word cut by characters", () => {
  assert.deepEqual(A.wrapText("one two three", 49, mono), ["one two", "three"]);
  assert.deepEqual(A.wrapText("a\n\nb", 100, mono), ["a", "", "b"], "an empty line the user typed stays");
  assert.deepEqual(A.wrapText("a\r\nb", 100, mono), ["a", "b"]);
  assert.deepEqual(A.wrapText("abcdefghij", 28, mono), ["abcd", "efgh", "ij"]);
  assert.deepEqual(A.wrapText("hi abcdefghij", 28, mono), ["hi", "abcd", "efgh", "ij"]);
  assert.deepEqual(A.wrapText("text\n\n\n", 100, mono), ["text"], "trailing blank lines draw nothing");
  assert.deepEqual(A.wrapText("   spaced    out   ", 200, mono), ["spaced out"]);
  for (const l of A.wrapText("the quick brown fox jumps over the lazy dog", 70, mono)) {
    assert.ok(mono(l) <= 70, `"${l}" fits`);
  }
});

test("wrap: capped with an ellipsis; the size follows the lines, on the grid", () => {
  const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const lines = A.wrapText(many, 200, mono);
  assert.equal(lines.length, A.NOTE_MAX_LINES);
  assert.ok(lines[lines.length - 1].endsWith("…"));
  assert.deepEqual(A.noteSize(1), { w: A.NOTE_W, h: 32 }, "14 + 16 = 30 -> 32");
  assert.deepEqual(A.noteSize(3), { w: A.NOTE_W, h: 64 }, "42 + 16 = 58 -> 64");
  assert.equal(A.noteSize(0).h, A.noteSize(1).h, "never flatter than one line");
  assert.equal(A.NOTE_W % 8, 0);
});

console.log(`\ntest-annotations: ${passed} tests passed.`);
