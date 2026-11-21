// Node tests for the configuration overlay of the design views
// (src/overlay.ts): which agent claims which DUT pin, the pin roles, the
// coverage of the DUT's boundary. Pure — the host (ConfigService) and the
// figure-capture script build the same overlay from it.
//   npm run test:overlay
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-overlay-"));
const outFile = join(outDir, "overlay.mjs");
await esbuild.build({
  entryPoints: ["src/overlay.ts"],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { overlayOf } = await import(pathToFileURL(outFile));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}
const port = (name, dir = "in", width = 1) => ({ name, dir, type: "logic", width, unpacked_dims: null, elem_width: null, loc: null });
const DEF = {
  ports: [port("clk"), port("rst_n"), port("in_data", "in", 8), port("in_valid"), port("out_data", "out", 8), port("scan_en")],
  iface_ports: [],
  loc: null,
};

test("no configuration: no DUT, no agent, nothing mapped", () => {
  assert.deepEqual(overlayOf({}, undefined, null), {
    dut: null, configPath: null, agents: [], roles: {},
    coverage: { total: 0, mapped: 0, unmapped: [] }, orphans: [],
  });
});

test("roles: clock, reset and the waived ports; the rest is unmapped until an agent claims it", () => {
  const cfg = { dut: { name: "buf", clock: "clk", reset: "rst_n", unverified_ports: ["scan_en"] } };
  const o = overlayOf(cfg, DEF, "buf.quickuvm.yaml");
  assert.deepEqual(o.roles, { scan_en: "ignored", clk: "clock", rst_n: "reset" });
  assert.deepEqual(o.coverage, { total: 6, mapped: 3, unmapped: ["in_data", "in_valid", "out_data"] });
  assert.equal(o.dut, "buf");
  assert.equal(o.configPath, "buf.quickuvm.yaml");
});

test("agents: their pins from inputs, outputs and inouts; a colour index per agent, wrapping", () => {
  const agents = Array.from({ length: 9 }, (_, i) => ({ name: `a${i}`, ports: { inputs: [{ name: `p${i}` }] } }));
  agents[0].ports = { inputs: [{ name: "in_data" }, { name: "in_valid" }], outputs: [{ name: "out_data" }], inouts: [{ name: "sda" }] };
  const o = overlayOf({ dut: { name: "buf", clock: "clk", reset: "rst_n" }, agents: [...agents, { ports: {} }] }, DEF, null, ["a0.sda"]);
  assert.deepEqual(o.agents[0], { name: "a0", color: 0, pins: ["in_data", "in_valid", "out_data", "sda"] });
  assert.equal(o.agents.length, 9, "an agent without a name is not an agent");
  assert.equal(o.agents[8].color, 0, "the palette wraps");
  assert.deepEqual(o.coverage, { total: 6, mapped: 5, unmapped: ["scan_en"] });
  assert.deepEqual(o.orphans, ["a0.sda"]);
});

console.log(`\ntest-overlay: ${passed} tests passed.`);
