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
const { inferredComponents, parseResolved, keepOnFirstAnalysis, inferenceIsReal } = await import(pathToFileURL(outFile));

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

// ------------------------------------------------- the first `analysis:` entry
// docs/07 "Interim": writing it leaves implicit mode, so the gesture declares
// what quick-uvm inferred next to its own entry (the generator-side proof is in
// test:e2e, scenario 17)

/** the same answer for a bench with a second agent (the primary is the first) */
const TWO = {
  ...IMPLICIT,
  agents: [
    { name: "pkt", origin: "declared", sequences: [] },
    { name: "rsp", origin: "declared", sequences: [] },
  ],
};
const LIVE = ["pkt", "rsp"];

test("keepOnFirstAnalysis: a scoreboard on the inferred one's source REPLACES it; the coverage is kept", () => {
  const p = keepOnFirstAnalysis(TWO, LIVE, { kind: "scoreboard", source: "pkt" });
  assert.deepEqual(p, { known: true, scoreboards: [], coverage: ["pkt"], replaced: ["sbd"], dangling: [] });
});

test("keepOnFirstAnalysis: a scoreboard on ANOTHER source keeps the inferred one beside it", () => {
  const p = keepOnFirstAnalysis(TWO, LIVE, { kind: "scoreboard", source: "rsp" });
  assert.deepEqual(p.scoreboards, [{ name: "sbd", source: "pkt" }]);
  assert.deepEqual(p.coverage, ["pkt"]);
  assert.deepEqual(p.replaced, []);
});

test("keepOnFirstAnalysis: coverage on another agent keeps the scoreboard AND the inferred collector", () => {
  const p = keepOnFirstAnalysis(TWO, LIVE, { kind: "coverage", agent: "rsp" });
  assert.deepEqual(p.scoreboards, [{ name: "sbd", source: "pkt" }]);
  assert.deepEqual(p.coverage, ["pkt"]);
});

test("keepOnFirstAnalysis: coverage on the inferred collector's own agent — the gesture declares it, it is not 'kept'", () => {
  const p = keepOnFirstAnalysis(TWO, LIVE, { kind: "coverage", agent: "pkt" });
  assert.deepEqual(p.scoreboards, [{ name: "sbd", source: "pkt" }], "the scoreboard still is");
  assert.deepEqual(p.coverage, []);
});

test("keepOnFirstAnalysis: an answer about OTHER agents than the live configuration's is not this bench's", () => {
  const g = { kind: "coverage", agent: "rsp" };
  const unknown = { known: false, scoreboards: [], coverage: [], replaced: [], dangling: [] };
  // the disk copy the cache describes: the second agent was added since
  assert.deepEqual(keepOnFirstAnalysis(IMPLICIT, LIVE, g), unknown);
  // an agent renamed in the editor
  assert.deepEqual(keepOnFirstAnalysis(TWO, ["cmd", "rsp"], g), unknown);
  // the same agents in another ORDER: the primary agent is the first, so what
  // is inferred is not the same either
  assert.deepEqual(keepOnFirstAnalysis(TWO, ["rsp", "pkt"], g), unknown);
  assert.equal(keepOnFirstAnalysis(TWO, ["pkt", "rsp"], g).known, true);
});

test("keepOnFirstAnalysis: an answer without its agent list — a missing agent is reported, never written", () => {
  // the second wall: nothing to compare the live agents with, so each
  // component is checked on its own
  const bare = { ...TWO, agents: undefined };
  const p = keepOnFirstAnalysis(bare, ["cmd", "rsp"], { kind: "coverage", agent: "rsp" });
  assert.equal(p.known, true);
  assert.deepEqual([p.scoreboards, p.coverage], [[], []]);
  assert.deepEqual(p.dangling, ["sb:sbd", "cov:pkt"]);
  // a replaced scoreboard is not "dangling" too: it would not have been written anyway
  const r = keepOnFirstAnalysis(bare, ["rsp"], { kind: "scoreboard", source: "pkt" });
  assert.deepEqual([r.replaced, r.dangling], [["sbd"], ["cov:pkt"]]);
});

test("keepOnFirstAnalysis: no resolved view, or one of a file that already declares analysis — NOT known", () => {
  const g = { kind: "scoreboard", source: "pkt" };
  for (const r of [null, undefined, { ...DECLARED, agents: TWO.agents }, {}]) {
    const p = keepOnFirstAnalysis(r, LIVE, g);
    assert.equal(p.known, false);
    assert.deepEqual([p.scoreboards, p.coverage, p.replaced, p.dangling], [[], [], [], []]);
  }
  // an entry marked inferred inside a DECLARED answer is still not to be trusted:
  // the answer is about another state of the file
  const odd = { ...TWO, analysis: { ...TWO.analysis, mode: "declared" } };
  assert.equal(keepOnFirstAnalysis(odd, LIVE, g).known, false);
});

test("keepOnFirstAnalysis: the resolved entries are copied verbatim, defaults and all; the input is not touched", () => {
  const two = {
    ...TWO,
    analysis: {
      mode: "implicit",
      scoreboards: [{ name: "sbd", source: "pkt", monitor: "rsp", match: "in_order", origin: "inferred" }],
      coverage: [
        { agent: "pkt", origin: "inferred" },
        { agent: "pkt", origin: "inferred" },
        { agent: "rsp", origin: "declared" },
      ],
    },
  };
  const before = JSON.stringify(two);
  const p = keepOnFirstAnalysis(two, LIVE, { kind: "coverage", agent: "x" });
  assert.deepEqual(p.scoreboards, [{ name: "sbd", source: "pkt", monitor: "rsp", match: "in_order" }]);
  assert.deepEqual(p.coverage, ["pkt"], "once, and never a declared entry");
  assert.equal(JSON.stringify(two), before);
  // a two-stream inferred scoreboard whose MONITOR is gone is dangling as well
  const bare = { ...two, agents: undefined };
  assert.deepEqual(keepOnFirstAnalysis(bare, ["pkt"], { kind: "coverage", agent: "x" }).dangling, ["sb:sbd"]);
});

// ------------------------------------------------- where inference is real
// `resolve` (1.2.0) reports sbd + a collector on agents[0] whenever `analysis:`
// is absent; on these shapes the generator generates neither and refuses both
// once declared. The generator-side locks are in test:e2e, scenario 17.

test("inferenceIsReal: a plain bench and a selftest infer; a composition, a VIP, a replicated agent do not", () => {
  const agents = [{ name: "pkt" }];
  assert.equal(inferenceIsReal({ agents }), true);
  assert.equal(inferenceIsReal({ agents, kind: "bench" }), true);
  assert.equal(inferenceIsReal({ agents, kind: "selftest" }), true, "a selftest really generates sbd");
  assert.equal(inferenceIsReal({ agents, subenvs: [] }), true, "an empty list is no composition");
  assert.equal(inferenceIsReal({ agents: [{ name: "pkt", replicas: 1 }] }), true, "one replica is the plain agent");
  assert.equal(inferenceIsReal({ agents: [{ name: "pkt", instances: [] }] }), true);

  assert.equal(inferenceIsReal({ agents, subenvs: [{ name: "p1" }] }), false, "hybrid: boundary agent + subenvs");
  assert.equal(inferenceIsReal({ subenvs: [{ name: "p1" }, { name: "c1" }] }), false, "pure subsystem top");
  assert.equal(inferenceIsReal({ agents, kind: "vip" }), false);
  assert.equal(inferenceIsReal({ agents: [{ name: "pkt", replicas: 3 }] }), false);
  assert.equal(inferenceIsReal({ agents: [{ name: "pkt", instances: [{ name: "lo" }] }] }), false);
  assert.equal(inferenceIsReal({ agents: [{ name: "a" }, { name: "b", replicas: 2 }] }), false, "any agent, not only the first");
});

test("inferenceIsReal: a half-typed configuration never throws, and unknown means `resolve` stands alone", () => {
  for (const c of [null, undefined, {}, { agents: null }, { agents: "x" }, { agents: [null, 5, "a"] }, { subenvs: "x" }, { kind: 7 }]) {
    assert.equal(inferenceIsReal(c), true);
  }
  assert.equal(inferenceIsReal({ agents: [null, { replicas: "3" }] }), true, "a string is not a count");
});

test("inferredComponents: with the live config, nothing on a shape where the reported set is not generated", () => {
  assert.equal(inferredComponents(IMPLICIT).length, 2, "no config: the answer as it is");
  assert.equal(inferredComponents(IMPLICIT, { agents: [{ name: "pkt" }] }).length, 2);
  for (const cfg of [
    { agents: [{ name: "pkt" }], subenvs: [{ name: "p1" }] },
    { agents: [{ name: "pkt" }], kind: "vip" },
    { agents: [{ name: "pkt", replicas: 3 }] },
    { agents: [{ name: "pkt", instances: [{ name: "lo" }] }] },
  ]) {
    assert.deepEqual(inferredComponents(IMPLICIT, cfg), []);
  }
});

console.log(`\ntest-resolved: ${passed} tests passed.`);
