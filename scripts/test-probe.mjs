// Node tests for the PURE module of the whitebox probes (src/probe.ts — DUT
// instance resolution, the XMR path and WIDTH derivation), run against the REAL
// regression model (examples/model.json): npm run test:probe
//
// The stake: naive width derivation is WRONG, and the regression model contains
// exactly both pitfalls (ch_out via `select`, din via `concat`).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-probe-"));
const outFile = join(outDir, "probe.mjs");
await esbuild.build({
  entryPoints: ["src/probe.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { proposeProbe, netWidth, probePath, resolveDutInstance, probeName, reservedNames,
  probeCoverageAllowed } = await import(pathToFileURL(outFile));

const model = JSON.parse(readFileSync("examples/model.json", "utf8"));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const SOC = { dut: { name: "soc_top", clock: "clk", reset: "rst_n" } };
const TOP = { dut: { name: "demo_top", clock: "clk", reset: "rst_n" } };

// ------------------------------------------------------------- the width

test("netWidth: `din` in soc_top = 8 (the module's own port), NOT 16 from the concat pin", () => {
  // pitfall: the pin g_ch[0].u_ch.din is a 16-bit port, reached through
  // `concat {din,din}` — ITS width is not the net width
  const w = netWidth(model, "demo_top.u_soc", "din");
  assert.deepEqual(w, { width: 8, unpacked: false });
});

test("netWidth: `ch_out` in soc_top is UNPACKED (48b, [3]), not a flat vector", () => {
  // symmetric pitfall: the pins g_ch[k].u_ch.dout are 16-bit ports via `select`
  const w = netWidth(model, "demo_top.u_soc", "ch_out");
  assert.equal(w.width, 48);
  assert.equal(w.unpacked, true);
});

test("netWidth: with no own port, the width comes from a pin tied to the WHOLE net", () => {
  // in the demo_top view, the net `din` is not a port of demo_top; the only endpoint
  // is the pin u_soc.din, with conn.kind === "net" -> the din port of soc_top (8b)
  assert.deepEqual(netWidth(model, "demo_top", "din"), { width: 8, unpacked: false });
  // `clk` likewise: bus_i.clk / u_soc.clk, both conn "net" -> 1 bit
  assert.deepEqual(netWidth(model, "demo_top", "clk"), { width: 1, unpacked: false });
});

test("netWidth: nonexistent net / nonexistent view -> not derivable, no exception", () => {
  assert.deepEqual(netWidth(model, "demo_top.u_soc", "no_such"), {
    width: null,
    unpacked: false,
  });
  assert.deepEqual(netWidth(model, "no.such", "din"), { width: null, unpacked: false });
});

// ------------------------------------------------- the DUT instance and the path

test("resolveDutInstance: the MODULE name from the YAML -> the view's ancestor instance", () => {
  assert.equal(resolveDutInstance(model, "soc_top", "demo_top.u_soc").path, "demo_top.u_soc");
  assert.equal(resolveDutInstance(model, "demo_top", "demo_top").path, "demo_top");
  // the view is ABOVE the DUT: no ancestor instance
  assert.equal(resolveDutInstance(model, "soc_top", "demo_top"), null);
  assert.equal(resolveDutInstance(model, "no_such", "demo_top"), null);
});

test("probePath: relative to the DUT instance", () => {
  assert.equal(probePath("demo_top.u_soc", "demo_top.u_soc", "w"), "w");
  assert.equal(probePath("demo_top.u_soc.g_ch[1].u_ch", "demo_top.u_soc", "w"), "g_ch[1].u_ch.w");
  assert.equal(probePath("demo_top", "demo_top.u_soc", "w"), null); // above the DUT
});

test("probeName: sanitized as an SV identifier", () => {
  assert.equal(probeName("din"), "din");
  assert.equal(probeName("g_ch[1].dout"), "g_ch_1__dout");
  assert.equal(probeName("1bad"), "p_1bad");
});

test("reservedNames: probes + agent interfaces/ports + clock + reset", () => {
  const cfg = {
    dut: { name: "soc_top", clock: "clk", reset: "rst_n" },
    agents: [
      { name: "a", interface: "a_if", ports: { inputs: [{ name: "din" }], outputs: [{ name: "sum" }] } },
    ],
    probes: [{ name: "lvl" }],
  };
  const r = reservedNames(cfg).sort();
  assert.deepEqual(r, ["a_if", "clk", "din", "lvl", "rst_n", "sum"]);
});

// ------------------------------------------------------------ the proposal

test("proposeProbe: valid case — an internal net under the DUT, with a derived width", () => {
  // DUT = demo_top: the net `din` in the demo_top view is INTERNAL (not a port)
  const r = proposeProbe(model, TOP, "demo_top", "din");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.proposal.name, "din");
  assert.equal(r.proposal.path, "din"); // the view IS the DUT instance
  assert.equal(r.proposal.width, 8);
  assert.ok(r.proposal.taken.includes("clk")); // the clock is reserved
});

test("proposeProbe: REFUSES on a subsystem bench (H1 — quick-uvm throws)", () => {
  const cfg = { ...SOC, subenvs: [{ name: "u_a", config: "a.yaml" }] };
  const r = proposeProbe(model, cfg, "demo_top.u_soc", "din");
  assert.equal(r.ok, false);
  assert.match(r.reason, /subsystem bench/i);
});

test("proposeProbe: REFUSES without a DUT and when the view is not under the DUT", () => {
  assert.match(proposeProbe(model, {}, "demo_top.u_soc", "din").reason, /no DUT/i);
  // DUT = soc_top, but the demo_top view is ABOVE it
  assert.match(proposeProbe(model, SOC, "demo_top", "din").reason, /not inside the DUT/i);
});

test("proposeProbe: REFUSES the unpacked array (the probe is a flat vector)", () => {
  const r = proposeProbe(model, SOC, "demo_top.u_soc", "ch_out");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unpacked array/i);
});

test("proposeProbe: REFUSES an interface (it is not a signal)", () => {
  const r = proposeProbe(model, SOC, "demo_top.u_soc", "bus");
  assert.equal(r.ok, false);
  assert.match(r.reason, /interface/i);
});

test("proposeProbe: REFUSES a DUT port already mapped to an agent (redundant)", () => {
  const cfg = {
    ...SOC,
    agents: [{ name: "dp", interface: "dp_if", ports: { inputs: [{ name: "din" }], outputs: [] } }],
  };
  const r = proposeProbe(model, cfg, "demo_top.u_soc", "din");
  assert.equal(r.ok, false);
  assert.match(r.reason, /already mapped to an agent/i);
  // the same port, but UNmapped -> can be probed
  const ok = proposeProbe(model, cfg, "demo_top.u_soc", "sum");
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.proposal.width, 8);
});

test("proposeProbe: nonexistent net -> explicit refusal, no exception", () => {
  assert.match(proposeProbe(model, SOC, "demo_top.u_soc", "nope").reason, /does not exist/i);
});

test("probeCoverageAllowed: NOT on the packaged layout (K2 bug #1 from 0.9.2)", () => {
  // with `layout: packaged`, env_pkg does not include probe_monitor -> does not compile;
  // the gate must refuse ONLY packaged, not the other layouts too
  assert.equal(probeCoverageAllowed({ ...SOC, layout: "packaged" }), false);
  assert.equal(probeCoverageAllowed(SOC), true);
  assert.equal(probeCoverageAllowed({ ...SOC, layout: "flat" }), true);
});

console.log(`\ntest-probe: ${passed} tests passed.`);
