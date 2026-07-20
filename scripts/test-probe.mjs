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

test("netWidth: `din` in soc_top = 8 (portul propriu), NU 16 de la pinul concat", () => {
  // pitfall: the pin g_ch[0].u_ch.din is a 16-bit port, reached through
  // `concat {din,din}` — ITS width is not the net width
  const w = netWidth(model, "demo_top.u_soc", "din");
  assert.deepEqual(w, { width: 8, unpacked: false });
});

test("netWidth: `ch_out` in soc_top e UNPACKED (48b, [3]), nu vector plat", () => {
  // symmetric pitfall: the pins g_ch[k].u_ch.dout are 16-bit ports via `select`
  const w = netWidth(model, "demo_top.u_soc", "ch_out");
  assert.equal(w.width, 48);
  assert.equal(w.unpacked, true);
});

test("netWidth: fara port propriu, latimea vine de la un pin legat cu netul INTREG", () => {
  // in the demo_top view, the net `din` is not a port of demo_top; the only endpoint
  // is the pin u_soc.din, with conn.kind === "net" -> the din port of soc_top (8b)
  assert.deepEqual(netWidth(model, "demo_top", "din"), { width: 8, unpacked: false });
  // `clk` likewise: bus_i.clk / u_soc.clk, both conn "net" -> 1 bit
  assert.deepEqual(netWidth(model, "demo_top", "clk"), { width: 1, unpacked: false });
});

test("netWidth: net inexistent / vedere inexistenta -> nederivabil, fara exceptie", () => {
  assert.deepEqual(netWidth(model, "demo_top.u_soc", "nu_exista"), {
    width: null,
    unpacked: false,
  });
  assert.deepEqual(netWidth(model, "nu.exista", "din"), { width: null, unpacked: false });
});

// ------------------------------------------------- the DUT instance and the path

test("resolveDutInstance: numele de MODUL din YAML -> instanta stramos a vederii", () => {
  assert.equal(resolveDutInstance(model, "soc_top", "demo_top.u_soc").path, "demo_top.u_soc");
  assert.equal(resolveDutInstance(model, "demo_top", "demo_top").path, "demo_top");
  // the view is ABOVE the DUT: no ancestor instance
  assert.equal(resolveDutInstance(model, "soc_top", "demo_top"), null);
  assert.equal(resolveDutInstance(model, "nu_exista", "demo_top"), null);
});

test("probePath: relativa la instanta DUT", () => {
  assert.equal(probePath("demo_top.u_soc", "demo_top.u_soc", "w"), "w");
  assert.equal(probePath("demo_top.u_soc.g_ch[1].u_ch", "demo_top.u_soc", "w"), "g_ch[1].u_ch.w");
  assert.equal(probePath("demo_top", "demo_top.u_soc", "w"), null); // above the DUT
});

test("probeName: sanitizat ca identificator SV", () => {
  assert.equal(probeName("din"), "din");
  assert.equal(probeName("g_ch[1].dout"), "g_ch_1__dout");
  assert.equal(probeName("1bad"), "p_1bad");
});

test("reservedNames: probe + interfete/porturi de agent + ceas + reset", () => {
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

test("proposeProbe: caz valid — net intern sub DUT, cu latime derivata", () => {
  // DUT = demo_top: the net `din` in the demo_top view is INTERNAL (not a port)
  const r = proposeProbe(model, TOP, "demo_top", "din");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.proposal.name, "din");
  assert.equal(r.proposal.path, "din"); // the view IS the DUT instance
  assert.equal(r.proposal.width, 8);
  assert.ok(r.proposal.taken.includes("clk")); // the clock is reserved
});

test("proposeProbe: REFUZA pe bench de subsistem (H1 — quick-uvm arunca)", () => {
  const cfg = { ...SOC, subenvs: [{ name: "u_a", config: "a.yaml" }] };
  const r = proposeProbe(model, cfg, "demo_top.u_soc", "din");
  assert.equal(r.ok, false);
  assert.match(r.reason, /subsystem bench/i);
});

test("proposeProbe: REFUZA fara DUT si cand vederea nu e sub DUT", () => {
  assert.match(proposeProbe(model, {}, "demo_top.u_soc", "din").reason, /no DUT/i);
  // DUT = soc_top, but the demo_top view is ABOVE it
  assert.match(proposeProbe(model, SOC, "demo_top", "din").reason, /not inside the DUT/i);
});

test("proposeProbe: REFUZA tabloul unpacked (proba e vector plat)", () => {
  const r = proposeProbe(model, SOC, "demo_top.u_soc", "ch_out");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unpacked array/i);
});

test("proposeProbe: REFUZA o interfata (nu e semnal)", () => {
  const r = proposeProbe(model, SOC, "demo_top.u_soc", "bus");
  assert.equal(r.ok, false);
  assert.match(r.reason, /interface/i);
});

test("proposeProbe: REFUZA un port de DUT deja mapat pe agent (redundant)", () => {
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

test("proposeProbe: net inexistent -> refuz explicit, fara exceptie", () => {
  assert.match(proposeProbe(model, SOC, "demo_top.u_soc", "nope").reason, /does not exist/i);
});

test("probeCoverageAllowed: NU pe layout packaged (bug K2 #1 din 0.9.2)", () => {
  // with `layout: packaged`, env_pkg does not include probe_monitor -> does not compile;
  // the gate must refuse ONLY packaged, not the other layouts too
  assert.equal(probeCoverageAllowed({ ...SOC, layout: "packaged" }), false);
  assert.equal(probeCoverageAllowed(SOC), true);
  assert.equal(probeCoverageAllowed({ ...SOC, layout: "flat" }), true);
});

console.log(`\ntest-probe: ${passed} teste au trecut.`);
