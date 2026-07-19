// Teste Node pentru modulul PUR al probelor whitebox (src/probe.ts — rezolvarea
// instantei DUT, calea XMR si derivarea LATIMII), rulate contra modelului REAL
// de regresie (examples/model.json): npm run test:probe
//
// Miza: derivarea naiva a latimii e GRESITA, iar modelul de regresie contine
// exact ambele capcane (ch_out prin `select`, din prin `concat`).
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

// ------------------------------------------------------------- latimea

test("netWidth: `din` in soc_top = 8 (portul propriu), NU 16 de la pinul concat", () => {
  // capcana: pinul g_ch[0].u_ch.din e un port de 16 biti, atins prin
  // `concat {din,din}` — latimea LUI nu e latimea netului
  const w = netWidth(model, "demo_top.u_soc", "din");
  assert.deepEqual(w, { width: 8, unpacked: false });
});

test("netWidth: `ch_out` in soc_top e UNPACKED (48b, [3]), nu vector plat", () => {
  // capcana simetrica: pinii g_ch[k].u_ch.dout sunt porturi de 16 prin `select`
  const w = netWidth(model, "demo_top.u_soc", "ch_out");
  assert.equal(w.width, 48);
  assert.equal(w.unpacked, true);
});

test("netWidth: fara port propriu, latimea vine de la un pin legat cu netul INTREG", () => {
  // in vederea demo_top, netul `din` nu e port al lui demo_top; singurul capat
  // e pinul u_soc.din, cu conn.kind === "net" -> portul din al lui soc_top (8b)
  assert.deepEqual(netWidth(model, "demo_top", "din"), { width: 8, unpacked: false });
  // `clk` la fel: bus_i.clk / u_soc.clk, ambele conn "net" -> 1 bit
  assert.deepEqual(netWidth(model, "demo_top", "clk"), { width: 1, unpacked: false });
});

test("netWidth: net inexistent / vedere inexistenta -> nederivabil, fara exceptie", () => {
  assert.deepEqual(netWidth(model, "demo_top.u_soc", "nu_exista"), {
    width: null,
    unpacked: false,
  });
  assert.deepEqual(netWidth(model, "nu.exista", "din"), { width: null, unpacked: false });
});

// ------------------------------------------------- instanta DUT si calea

test("resolveDutInstance: numele de MODUL din YAML -> instanta stramos a vederii", () => {
  assert.equal(resolveDutInstance(model, "soc_top", "demo_top.u_soc").path, "demo_top.u_soc");
  assert.equal(resolveDutInstance(model, "demo_top", "demo_top").path, "demo_top");
  // vederea e DEASUPRA DUT-ului: nicio instanta stramos
  assert.equal(resolveDutInstance(model, "soc_top", "demo_top"), null);
  assert.equal(resolveDutInstance(model, "nu_exista", "demo_top"), null);
});

test("probePath: relativa la instanta DUT", () => {
  assert.equal(probePath("demo_top.u_soc", "demo_top.u_soc", "w"), "w");
  assert.equal(probePath("demo_top.u_soc.g_ch[1].u_ch", "demo_top.u_soc", "w"), "g_ch[1].u_ch.w");
  assert.equal(probePath("demo_top", "demo_top.u_soc", "w"), null); // deasupra DUT-ului
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

// ------------------------------------------------------------ propunerea

test("proposeProbe: caz valid — net intern sub DUT, cu latime derivata", () => {
  // DUT = demo_top: netul `din` din vederea demo_top e INTERN (nu e port)
  const r = proposeProbe(model, TOP, "demo_top", "din");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.proposal.name, "din");
  assert.equal(r.proposal.path, "din"); // vederea E instanta DUT
  assert.equal(r.proposal.width, 8);
  assert.ok(r.proposal.taken.includes("clk")); // ceasul e rezervat
});

test("proposeProbe: REFUZA pe bench de subsistem (H1 — quick-uvm arunca)", () => {
  const cfg = { ...SOC, subenvs: [{ name: "u_a", config: "a.yaml" }] };
  const r = proposeProbe(model, cfg, "demo_top.u_soc", "din");
  assert.equal(r.ok, false);
  assert.match(r.reason, /subsystem bench/i);
});

test("proposeProbe: REFUZA fara DUT si cand vederea nu e sub DUT", () => {
  assert.match(proposeProbe(model, {}, "demo_top.u_soc", "din").reason, /no DUT/i);
  // DUT = soc_top, dar vederea demo_top e DEASUPRA lui
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
  // acelasi port, dar NEmapat -> se poate sonda
  const ok = proposeProbe(model, cfg, "demo_top.u_soc", "sum");
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.proposal.width, 8);
});

test("proposeProbe: net inexistent -> refuz explicit, fara exceptie", () => {
  assert.match(proposeProbe(model, SOC, "demo_top.u_soc", "nope").reason, /does not exist/i);
});

test("probeCoverageAllowed: NU pe layout packaged (bug K2 #1 din 0.9.2)", () => {
  // cu `layout: packaged`, env_pkg nu include probe_monitor -> nu compileaza;
  // gate-ul trebuie sa refuze DOAR packaged, nu si celelalte layout-uri
  assert.equal(probeCoverageAllowed({ ...SOC, layout: "packaged" }), false);
  assert.equal(probeCoverageAllowed(SOC), true);
  assert.equal(probeCoverageAllowed({ ...SOC, layout: "flat" }), true);
});

console.log(`\ntest-probe: ${passed} teste au trecut.`);
