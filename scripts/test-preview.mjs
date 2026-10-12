// Node tests for the YAML diff preview (src/preview.ts — docs/08 R19): the
// line summary of a gesture's change, the files that actually change and the
// one-line label of a confirmation.
//   npm run test:preview
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-preview-"));
const outFile = join(outDir, "preview.mjs");
await esbuild.build({
  entryPoints: ["src/preview.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { changedFiles, changesLabel, summarize } = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const AGENTS = "agents:\n  - name: cmd\n    ports: [a]\n  - name: rsp\n";

test("summarize: identical texts change nothing", () => {
  assert.deepEqual(summarize(AGENTS, AGENTS), { added: 0, removed: 0 });
  assert.deepEqual(summarize("", ""), { added: 0, removed: 0 });
});

test("summarize: a deleted agent block counts its lines, nothing added (removeAgent)", () => {
  assert.deepEqual(summarize(AGENTS, "agents:\n  - name: rsp\n"), { added: 0, removed: 2 });
});

test("summarize: an inserted entry counts its lines, nothing removed", () => {
  const neu = "agents:\n  - name: cmd\n  - name: rsp\n    active: false\n";
  assert.deepEqual(summarize("agents:\n  - name: cmd\n", neu), { added: 2, removed: 0 });
});

test("summarize: an in-line replacement is one line each way", () => {
  assert.deepEqual(summarize("active: true\n", "active: false\n"), { added: 1, removed: 1 });
});

test("summarize: an in-line insertion or deletion is one line each way too (review finding)", () => {
  // the character-level minimal edit counted these +1 -0 / +0 -1
  assert.deepEqual(summarize("name: cmd\n", "name: cmd2\n"), { added: 1, removed: 1 });
  assert.deepEqual(summarize("coverage: [cmd, rsp]\n", "coverage: [cmd]\n"), { added: 1, removed: 1 });
  assert.deepEqual(summarize("a: 1\nports: [a]\nz: 9\n", "a: 1\nports: [a, b]\nz: 9\n"), {
    added: 1,
    removed: 1,
  });
});

test("summarize: a replacement spanning lines counts both sides", () => {
  assert.deepEqual(summarize("a: 1\nb: 2\nc: 3\n", "a: 1\nx: 9\ny: 8\nz: 7\nc: 3\n"), {
    added: 3,
    removed: 1,
  });
});

test("summarize: CRLF texts count lines the same", () => {
  const crlf = (s) => s.replace(/\n/g, "\r\n");
  assert.deepEqual(summarize(crlf(AGENTS), crlf("agents:\n  - name: rsp\n")), { added: 0, removed: 2 });
});

test("summarize: a deleted blank line is one line", () => {
  assert.deepEqual(summarize("a: 1\n\nb: 2\n", "a: 1\nb: 2\n"), { added: 0, removed: 1 });
});

test("summarize: a deletion at the end of a file without a final newline is not over-counted (review finding)", () => {
  // the minimal edit removes "\nb: 2" — the newline it takes from the previous line is not a line
  assert.deepEqual(summarize("a: 1\nb: 2", "a: 1"), { added: 0, removed: 1 });
  assert.deepEqual(summarize("a: 1", "a: 1\nb: 2"), { added: 1, removed: 0 });
  assert.deepEqual(summarize("a: 1\n", "a: 1"), { added: 0, removed: 1 }, "the final newline is a line boundary");
});

test("summarize: added - removed is the change in line count", () => {
  for (const [o, n] of [
    [AGENTS, "agents:\n  - name: rsp\n"],
    ["a: 1\nb: 2", "a: 1"],
    ["x: 1\n", "x: 1\ny: 2\nz: 3\n"],
    ["", "dut:\n  name: chan\n"],
  ]) {
    const s = summarize(o, n);
    assert.equal(s.added - s.removed, n.split("\n").length - o.split("\n").length, JSON.stringify([o, n]));
  }
});

const FILES = [
  { label: "top.quickuvm.yaml", oldText: "a: 1\n", newText: "a: 1\nb: 2\n" },
  { label: "same.quickuvm.yaml", oldText: "x: 1\n", newText: "x: 1\n" },
  { label: "chan.quickuvm.yaml", created: true, oldText: "", newText: "dut:\n  name: chan\n" },
];

test("changedFiles: the no-ops drop, a created file always counts, the order is kept", () => {
  assert.deepEqual(
    changedFiles(FILES).map((f) => f.label),
    ["top.quickuvm.yaml", "chan.quickuvm.yaml"]
  );
  assert.deepEqual(changedFiles([{ label: "e", created: true, oldText: "", newText: "" }]).length, 1);
  assert.deepEqual(changedFiles([]), []);
});

test("changesLabel: +/- per changed file, `new` for a created one", () => {
  assert.equal(changesLabel(FILES), "top.quickuvm.yaml (+1 -0), chan.quickuvm.yaml (new, +2)");
  assert.equal(changesLabel([FILES[1]]), "");
});

console.log(`\ntest-preview: ${passed} tests passed.`);
