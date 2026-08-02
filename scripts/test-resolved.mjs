// Node tests for the resolved-config reader (src/resolved.ts — `quick-uvm resolve`
// output -> the inferred components, in diagram-node terms):
//   npm run test:resolved
//
// The origin filter gets its OWN suite on purpose. At the scene level it is masked:
// a declared component is also in the config, so `buildTbScene`'s dedup guard skips
// it anyway and the scene tests pass either way (proved by mutation — dropping
// `origin === "inferred"` left test-tbscene fully green). The consequence of the
// filter failing is a solid component redrawn as a ghost, i.e. the diagram claiming
// the user never wrote something they did write.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-resolved-"));
const outFile = join(outDir, "resolved.mjs");
await esbuild.build({
  entryPoints: ["src/resolved.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { inferredComponents, parseResolved } = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

/** verbatim `quick-uvm resolve` output for a config with NO `analysis:` key */
const IMPLICIT = {
  version: "1.1.0",
  dut: "yapp_router",
  analysis: {
    mode: "implicit",
    scoreboards: [{ name: "sbd", source: "pkt", origin: "inferred" }],
    coverage: [{ agent: "pkt", origin: "inferred" }],
  },
  tests: [{ name: "test1", origin: "inferred" }],
  virtual_sequences: [],
  agents: [{ name: "pkt", origin: "declared", sequences: [] }],
  guards: [],
};
/** the same bench once the user declares a scoreboard — the mode switch */
const DECLARED = {
  ...IMPLICIT,
  analysis: {
    mode: "declared",
    scoreboards: [{ name: "sbd", source: "pkt", origin: "declared" }],
    coverage: [],
  },
  guards: ["UNCOVERED_AGENT: pkt"],
};

test("implicit mode yields both components, addressed as diagram nodes", () => {
  const got = inferredComponents(IMPLICIT);
  assert.deepEqual(got, [
    { id: "sb:sbd", kind: "scoreboard", name: "sbd", source: "pkt" },
    { id: "cov:pkt", kind: "coverage", name: "pkt", source: "pkt" },
  ]);
});

test("a DECLARED component is never reported — it is already in the YAML", () => {
  assert.deepEqual(inferredComponents(DECLARED), []);
});

test("mixed provenance: only the inferred half comes back", () => {
  const got = inferredComponents({
    ...IMPLICIT,
    analysis: {
      mode: "declared",
      scoreboards: [
        { name: "mine", source: "pkt", origin: "declared" },
        { name: "auto", source: "pkt", origin: "inferred" },
      ],
      coverage: [
        { agent: "pkt", origin: "declared" },
        { agent: "rsp", origin: "inferred" },
      ],
    },
  });
  assert.deepEqual(got.map((c) => c.id), ["sb:auto", "cov:rsp"]);
});

test("the mode switch is visible as a disappearance", () => {
  // the user's reported confusion, as one assertion: declaring a scoreboard drops
  // the coverage collector they had for free (quick-uvm arms UNCOVERED_AGENT)
  assert.equal(inferredComponents(IMPLICIT).length, 2);
  assert.equal(inferredComponents(DECLARED).length, 0);
  assert.ok(DECLARED.guards.includes("UNCOVERED_AGENT: pkt"));
});

test("no resolve at all degrades to no ghosts, never to a throw", () => {
  assert.deepEqual(inferredComponents(null), []);
  assert.deepEqual(inferredComponents(undefined), []);
  assert.deepEqual(inferredComponents({ version: "1.1.0", dut: "y" }), []);
  assert.deepEqual(inferredComponents({ analysis: {} }), []);
});

test("entries without a usable name are skipped, not drawn as `sb:undefined`", () => {
  const got = inferredComponents({
    analysis: {
      mode: "implicit",
      scoreboards: [{ source: "pkt", origin: "inferred" }],
      coverage: [{ origin: "inferred" }],
    },
  });
  assert.deepEqual(got, []);
});

// --- parseResolved: an older quick-uvm, or a broken config, must not break the view -

test("parseResolved reads real output and rejects everything else", () => {
  assert.equal(parseResolved(JSON.stringify(IMPLICIT)).dut, "yapp_router");
  assert.equal(parseResolved("  " + JSON.stringify(IMPLICIT) + "\n").dut, "yapp_router");
  assert.equal(parseResolved(""), null, "quick-uvm < 1.1.0 prints nothing");
  assert.equal(parseResolved("   \n "), null);
  assert.equal(parseResolved("usage: quick-uvm ..."), null, "an error message, not JSON");
  assert.equal(parseResolved("{"), null, "truncated JSON");
  assert.equal(parseResolved("null"), null);
  assert.equal(parseResolved("[]"), null, "an array has no `analysis`");
  assert.equal(parseResolved('{"version":"1.1.0"}'), null, "no `analysis` = unusable");
});

console.log(`\ntest-resolved: ${passed} tests passed.`);
