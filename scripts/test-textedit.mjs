// Node tests for the minimal text edit (src/textedit.ts — docs/08 R4): the
// smallest replacement between two YAML texts and the span to highlight.
//   npm run test:textedit
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-textedit-"));
const outFile = join(outDir, "textedit.mjs");
await esbuild.build({
  entryPoints: ["src/textedit.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { changedSpan, minimalEdit, wholeLines } = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

/** applies an edit to the old text — the round-trip every case must satisfy */
const apply = (old, e) => old.slice(0, e.start) + e.text + old.slice(e.end);

test("identical texts: no edit at all (no WorkspaceEdit, no highlight)", () => {
  assert.equal(minimalEdit("a: 1\n", "a: 1\n"), null);
  assert.equal(minimalEdit("", ""), null);
});

test("an inserted entry in the middle: only that entry is replaced", () => {
  const old = "agents:\n  - name: cmd\n  - name: rsp\nanalysis: {}\n";
  const neu = "agents:\n  - name: cmd\n  - name: mid\n  - name: rsp\nanalysis: {}\n";
  const e = minimalEdit(old, neu);
  assert.equal(apply(old, e), neu, "round-trip");
  assert.equal(e.text, "  - name: mid\n");
  assert.equal(old.slice(e.start, e.end), "", "a pure insertion replaces nothing");
  assert.deepEqual(wholeLines(neu, changedSpan(e)), {
    start: neu.indexOf("  - name: mid"),
    end: neu.indexOf("  - name: mid") + "  - name: mid".length,
  });
});

test("a deleted entry: empty replacement, the highlight collapses to a position", () => {
  const old = "a: 1\nb: 2\nc: 3\n";
  const neu = "a: 1\nc: 3\n";
  const e = minimalEdit(old, neu);
  assert.equal(apply(old, e), neu);
  assert.equal(e.text, "");
  const span = changedSpan(e);
  assert.equal(span.start, span.end);
  const wl = wholeLines(neu, span);
  assert.equal(neu.slice(wl.start, wl.end), "c: 3", "the line where the gap closed");
});

test("a changed value: the replacement is the value, the highlight the whole line", () => {
  const old = "ports:\n  - { name: din, width: 8 }\n";
  const neu = "ports:\n  - { name: din, width: 16 }\n";
  const e = minimalEdit(old, neu);
  assert.equal(apply(old, e), neu);
  assert.equal(e.text, "16");
  const wl = wholeLines(neu, changedSpan(e));
  assert.equal(neu.slice(wl.start, wl.end), "  - { name: din, width: 16 }");
});

test("repeated characters: prefix and suffix never overlap (aa -> aaa, aaa -> aa)", () => {
  for (const [old, neu] of [["aa", "aaa"], ["aaa", "aa"], ["", "x"], ["x", ""], ["ab", "ba"]]) {
    const e = minimalEdit(old, neu);
    assert.equal(apply(old, e), neu, `${JSON.stringify(old)} -> ${JSON.stringify(neu)}`);
    assert.ok(e.start <= e.end && e.end <= old.length);
  }
});

test("CRLF documents: the line widening stops at \\r", () => {
  const old = "a: 1\r\nb: 2\r\n";
  const neu = "a: 1\r\nb: 3\r\n";
  const e = minimalEdit(old, neu);
  assert.equal(e.text, "3");
  const wl = wholeLines(neu, changedSpan(e));
  assert.equal(neu.slice(wl.start, wl.end), "b: 3");
});

console.log(`\ntest-textedit: ${passed} tests passed.`);
