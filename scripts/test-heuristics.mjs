// Node tests for the signal-name heuristics (src/heuristics.ts):
//   npm run test:heuristics
// Real pitfall (CLAUDE.md): the active-low suffixes include _ni/_bi (the PULP
// convention, e.g. src_rst_ni) — narrowing to _n|_b wrote reset_active_low wrong.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-heuristics-"));
const outFile = join(outDir, "heuristics.mjs");
await esbuild.build({
  entryPoints: ["src/heuristics.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { CLOCK_RE, RESET_RE, ACTIVE_LOW_RE, SV_IDENT_RE } = await import(
  pathToFileURL(outFile)
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

test("active-low: the classic suffixes _n/_b", () => {
  for (const s of ["rst_n", "rst_b", "RST_N", "areset_n"]) {
    assert.ok(ACTIVE_LOW_RE.test(s), `${s} should be active-low`);
  }
});

test("active-low: the PULP suffixes _ni/_bi (pitfall 23 — src_rst_ni)", () => {
  for (const s of ["src_rst_ni", "dst_rst_ni", "scan_bi", "RST_NI"]) {
    assert.ok(ACTIVE_LOW_RE.test(s), `${s} should be active-low`);
  }
});

test("active-low: NOT on names without a suffix (clk, data, rst, enable_in)", () => {
  for (const s of ["clk", "data", "rst", "reset", "enable_in", "count"]) {
    assert.ok(!ACTIVE_LOW_RE.test(s), `${s} is NOT active-low`);
  }
});

test("clock: clk/clock, whatever the case and the position", () => {
  for (const s of ["clk", "clk_i", "core_clock", "CLK"]) {
    assert.ok(CLOCK_RE.test(s), `${s} should be a clock`);
  }
  assert.ok(!CLOCK_RE.test("data_i"));
});

test("reset: rst/reset, whatever the case and the position", () => {
  for (const s of ["rst_n", "areset", "src_rst_ni", "RESET"]) {
    assert.ok(RESET_RE.test(s), `${s} should be a reset`);
  }
  assert.ok(!RESET_RE.test("ready"));
});

test("SV identifier: valid vs invalid", () => {
  for (const s of ["cmd", "_x", "a1_b2", "P_0"]) {
    assert.ok(SV_IDENT_RE.test(s), `${s} should be valid`);
  }
  for (const s of ["1abc", "a-b", "a b", "", "g_ch[0]"]) {
    assert.ok(!SV_IDENT_RE.test(s), `${s} should be invalid`);
  }
});

const { resetIsActiveLow, CLOCK_QUALIFIER_RE } = await import(pathToFileURL(outFile));

test("reset polarity by name: the suffixes, and the reset token fused with n (docs/08 R24)", () => {
  for (const s of ["rst_n", "rst_ni", "src_rst_ni", "aresetn", "rstn", "resetn_i", "ARESETN", "s_axi_aresetn"]) {
    assert.ok(resetIsActiveLow(s), `${s} is active low`);
  }
  for (const s of ["rst", "reset", "areset", "rst_i", "srst", "reset_in"]) {
    assert.ok(!resetIsActiveLow(s), `${s} is active high`);
  }
});

test("a clock's control is not a clock: enable / gate / select; a divided clock still is", () => {
  for (const s of ["clk_en", "clk_en_i", "clk_enable", "clk_gate_i", "clk_sel", "clk_sel0", "clk_locked", "ref_clk_valid"]) {
    assert.ok(CLOCK_QUALIFIER_RE.test(s), `${s} is a control`);
  }
  for (const s of ["clk", "clk_i", "src_clk_i", "clk_div2", "clk_gated", "sysclk", "enet_clk", "selclk"]) {
    assert.ok(!CLOCK_QUALIFIER_RE.test(s), `${s} is a clock name`);
  }
});

console.log(`\ntest-heuristics: ${passed} tests passed.`);
