// Node tests for the per-view filter rules (src/webview/filters.ts — docs/08
// R23): what a rule matches, which rule wins, what happens to a wire, what a
// hand-edited sidecar may contain, and what the indicator says.
//   npm run test:filters
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-filters-"));
const outFile = join(outDir, "filters.mjs");
await esbuild.build({
  entryPoints: ["src/webview/filters.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const F = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}
const ITEMS = [
  { id: "agent:cmd", kind: "agent", name: "cmd" },
  { id: "agent:rsp", kind: "agent", name: "rsp" },
  { id: "agent:cmd_aux", kind: "agent", name: "cmd_aux" },
  { id: "sb:sbd", kind: "scoreboard", name: "sbd" },
  { id: "cov:cmd", kind: "coverage", name: "cmd_cov" },
];
const ids = (s) => [...s].sort().join(",");

test("a rule matches by kind, by name pattern (case-insensitive), by both, or everything", () => {
  const r = F.applyFilters(ITEMS, { rules: [{ effect: "hide", kind: "agent" }] });
  assert.equal(ids(r.hidden), "agent:cmd,agent:cmd_aux,agent:rsp");
  assert.equal(ids(F.applyFilters(ITEMS, { rules: [{ effect: "hide", name: "^CMD" }] }).hidden),
    "agent:cmd,agent:cmd_aux,cov:cmd");
  assert.equal(ids(F.applyFilters(ITEMS, { rules: [{ effect: "dim", kind: "agent", name: "^cmd$" }] }).dimmed),
    "agent:cmd");
  assert.equal(F.applyFilters(ITEMS, { rules: [{ effect: "dim" }] }).dimmed.size, ITEMS.length,
    "no kind, no pattern: everything");
  assert.deepEqual(r.counts, [3]);
});

test("visibility: the FIRST matching rule decides — an exception goes above the rule it carves into", () => {
  const r = F.applyFilters(ITEMS, {
    rules: [
      { effect: "show", name: "^cmd$" },
      { effect: "hide", kind: "agent" },
      { effect: "dim" },
    ],
  });
  assert.equal(ids(r.hidden), "agent:cmd_aux,agent:rsp", "cmd is shown by the rule above");
  assert.equal(ids(r.dimmed), "cov:cmd,sb:sbd", "what neither rule above took");
  assert.deepEqual(r.counts, [1, 3, 5], "the counts say what each rule matches on its own");
  // the other order: the hide wins, the show below it never gets a say
  const o = F.applyFilters(ITEMS, { rules: [{ effect: "hide", kind: "agent" }, { effect: "show", name: "^cmd$" }] });
  assert.ok(o.hidden.has("agent:cmd"));
});

test("colour is independent of visibility: the first colour rule that matches", () => {
  const r = F.applyFilters(ITEMS, {
    rules: [
      { effect: "dim", kind: "agent" },
      { effect: "red", name: "cmd" },
      { effect: "blue", kind: "agent" },
    ],
  });
  assert.equal(r.colors.get("agent:cmd"), "red", "the first colour rule, though a dim rule matched before it");
  assert.equal(r.colors.get("agent:rsp"), "blue");
  assert.equal(r.colors.get("cov:cmd"), "red");
  assert.equal(r.colors.has("sb:sbd"), false);
  assert.ok(r.dimmed.has("agent:cmd"), "dimmed AND coloured");
});

test("a pattern that does not compile matches nothing and says why; the other rules still run", () => {
  const r = F.applyFilters(ITEMS, { rules: [{ effect: "hide", name: "(" }, { effect: "hide", name: "^rsp$" }] });
  assert.ok(r.errors[0].startsWith("not a regular expression"));
  assert.equal(r.errors[1], null);
  assert.equal(ids(r.hidden), "agent:rsp");
  assert.deepEqual(r.counts, [0, 1]);
});

test("off: nothing is applied, the rules and their counts stay", () => {
  const r = F.applyFilters(ITEMS, { rules: [{ effect: "hide", kind: "agent" }, { effect: "red" }], off: true });
  assert.equal(r.hidden.size + r.dimmed.size + r.colors.size, 0);
  assert.deepEqual(r.counts, [3, 5], "the editor still shows what each rule WOULD match");
  assert.equal(F.applyFilters(ITEMS, null).hidden.size, 0);
  assert.equal(F.applyFilters(ITEMS, undefined).counts.length, 0);
});

test("a wire goes with its ends: hidden with a hidden end, dimmed with a dimmed one", () => {
  const r = F.applyFilters(ITEMS, { rules: [{ effect: "hide", name: "^rsp$" }, { effect: "dim", name: "^sbd$" }] });
  assert.equal(F.edgeEffect(r, "agent:rsp", "sb:sbd"), "hide", "hidden beats dimmed");
  assert.equal(F.edgeEffect(r, "agent:cmd", "sb:sbd"), "dim");
  assert.equal(F.edgeEffect(r, "agent:cmd", "cov:cmd"), null);
});

test("sanitize: only what a rule is survives a hand-edited file or a message", () => {
  assert.deepEqual(F.sanitizeFilters(null), { rules: [] });
  assert.deepEqual(F.sanitizeFilters("x"), { rules: [] });
  assert.deepEqual(
    F.sanitizeFilters({
      rules: [
        { effect: "hide", kind: " agent ", name: "  ^cmd  " },
        { effect: "explode", kind: "agent" },
        { effect: "purple" },
        null,
        "hide",
        { effect: "dim", kind: 7, name: "" },
      ],
      off: true,
      extra: 1,
    }),
    {
      rules: [{ effect: "hide", kind: "agent", name: "^cmd" }, { effect: "purple" }, { effect: "dim" }],
      off: true,
    }
  );
  assert.deepEqual(F.sanitizeFilters({ rules: [], off: true }), { rules: [] }, "off without rules means nothing");
  const many = F.sanitizeFilters({ rules: Array.from({ length: 60 }, () => ({ effect: "dim" })) });
  assert.equal(many.rules.length, F.MAX_RULES);
  // an over-long pattern is never TRUNCATED (half a pattern is another pattern,
  // and a rule without its pattern matches everything of its kind): the whole
  // rule goes, the direction that shows more — review
  assert.deepEqual(
    F.sanitizeFilters({
      rules: [
        { effect: "hide", kind: "agent", name: "x".repeat(F.NAME_MAX + 1) },
        { effect: "dim", name: "y".repeat(F.NAME_MAX) },
      ],
    }).rules,
    [{ effect: "dim", name: "y".repeat(F.NAME_MAX) }]
  );
});

test("review: a pattern that can backtrack forever is refused before it runs", () => {
  for (const bad of ["(a+)+$", "(.*)*x", "(a|aa)+$", "^(\\w+\\s?)*$", "((ab)*c)*", "(x{2,})+", "(?:a*)*b", "(foo|bar)+"]) {
    assert.ok(F.unsafePattern(bad), `${bad} is refused`);
  }
  for (const ok of ["^cmd", "_i$", "u_(add|inv)", "ch\\d+", "^g_ch\\[\\d+\\]", "(a+)b", "a*b*c*", "(ab)+", "[(+)*]+", "\\(a+\\)+", "(a|b)?c", "x{2,4}"]) {
    assert.equal(F.unsafePattern(ok), null, `${ok} passes`);
  }
  // refused = a rule that cannot run: it matches nothing, says why, and the
  // matcher is never entered (this would not return on the old code)
  const t0 = Date.now();
  const r = F.applyFilters(
    [{ id: "n", kind: "agent", name: "a".repeat(40) + "!" }],
    { rules: [{ effect: "hide", name: "(a+)+$" }, { effect: "dim", kind: "agent" }] }
  );
  assert.ok(Date.now() - t0 < 500, "the pattern was not run");
  assert.match(r.errors[0], /repeats or alternates/);
  assert.equal(r.counts[0], 0);
  assert.equal(r.hidden.size, 0);
  assert.deepEqual([...r.dimmed], ["n"], "the other rules still run");
});

test("review: a colour rule does not match what takes no tint (a flag, a ghost)", () => {
  const items = [
    { id: "agent:cmd", kind: "agent", name: "cmd" },
    { id: "sb:sbd", kind: "scoreboard", name: "sbd", noColor: true }, // an inferred ghost
    { id: "<if>.cmd_if", kind: "port", name: "cmd_if", noColor: true },
  ];
  const r = F.applyFilters(items, { rules: [{ effect: "red" }, { effect: "dim", kind: "port" }] });
  assert.deepEqual([...r.colors.keys()], ["agent:cmd"]);
  assert.equal(r.counts[0], 1, "the editor's count is what the user will SEE coloured");
  assert.deepEqual([...r.dimmed], ["<if>.cmd_if"], "visibility rules still reach them");
  assert.equal(F.filterSummary({ rules: [{ effect: "red" }] }, r), "Filters: 1 dimmed, 1 coloured");
});

test("the indicator says what the rules do to this view, and that they are off", () => {
  const f = { rules: [{ effect: "hide", kind: "agent" }, { effect: "dim", kind: "scoreboard" }, { effect: "red", name: "cov" }] };
  assert.equal(F.filterSummary(f, F.applyFilters(ITEMS, f)), "Filters: 3 hidden, 1 dimmed, 1 coloured");
  assert.equal(F.filterSummary({ ...f, off: true }, F.applyFilters(ITEMS, { ...f, off: true })), "Filters off (3 rules)");
  const none = { rules: [{ effect: "hide", name: "^zzz$" }] };
  assert.equal(F.filterSummary(none, F.applyFilters(ITEMS, none)), "Filters: no match",
    "rules that match nothing here are still announced");
  assert.equal(F.filterSummary({ rules: [] }, F.applyFilters(ITEMS, { rules: [] })), "");
  assert.equal(F.filterSummary(null, F.applyFilters(ITEMS, null)), "");
});

console.log(`\ntest-filters: ${passed} tests passed.`);
