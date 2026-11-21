// The figures of the tutorials — captured, not drawn.
//
//   npm run shots              capture every figure into docs/tutorial-shots/
//   npm run shots -- --arrange serve the scenes for ARRANGING by hand (drag the
//                              blocks in a browser; every drag is saved to
//                              docs/tutorial-shots/layouts.json, which the
//                              captures then use)
//   npm run shots -- --only env   only the figures whose name contains "env"
//
// A figure is the SHIPPED webview (dist/webview.js through scripts/harness.html)
// fed with what a real host would send, and photographed by a headless Chrome /
// Edge — header, canvas, minimap, Properties panel as they are, at 2x. Nothing
// is mocked up:
//   - the model is a real `backend/svmodel.py` run on the fixture's RTL;
//   - the configuration is the YAML the real mutations write (src/yamlops.ts),
//     gesture by gesture, as the tutorial's steps do;
//   - the overlay, the proposals and the results snapshot come from the same
//     pure modules the extension uses; the inferred components from a real
//     `quick-uvm resolve`; the simulation results from the Xcelium logs under
//     scripts/fixtures/results/.
// What it cannot show is VS Code itself (activity bar, trees, QuickPicks).
//
// Needs: python (svmodel; Pillow only to trim the panel captures), a Chrome or
// Edge (env CHROME overrides the search), `npm run build` done. The YAPP-router
// figures need the router's RTL, which lives in the QuickUVM repository (next
// to this one; env QUICKUVM_REPO overrides `../QuickUVM`); without it they are
// skipped, and said.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const ARRANGE = argv.includes("--arrange");
const ONLY = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const PORT = argv.includes("--port") ? Number(argv[argv.indexOf("--port") + 1]) : 8140;
const SHOTS = join(ROOT, "docs", "tutorial-shots");
const LAYOUTS = join(SHOTS, "layouts.json");
const tmp = mkdtempSync(join(tmpdir(), "quickuvm-shots-"));
const env = { ...process.env, PYTHONUTF8: "1" };

// ------------------------------------------------------------ the pure modules
const fwd = (p) => p.replace(/\\/g, "/");
const entry = join(tmp, "entry.ts");
writeFileSync(
  entry,
  [
    `export * as ops from ${JSON.stringify(fwd(join(ROOT, "src/yamlops.ts")))};`,
    `export { overlayOf } from ${JSON.stringify(fwd(join(ROOT, "src/overlay.ts")))};`,
    `export { proposalsFor } from ${JSON.stringify(fwd(join(ROOT, "src/proposals.ts")))};`,
    `export * as results from ${JSON.stringify(fwd(join(ROOT, "src/results.ts")))};`,
    `export { inferredComponents } from ${JSON.stringify(fwd(join(ROOT, "src/resolved.ts")))};`,
  ].join("\n")
);
await esbuild.build({
  entryPoints: [entry],
  outfile: join(tmp, "pure.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const { ops, overlayOf, proposalsFor, results: R, inferredComponents } = await import(
  pathToFileURL(join(tmp, "pure.mjs"))
);

// ------------------------------------------------------------- real inputs
/** a real svmodel run: the project model of one top */
function svmodel(cwd, file, top) {
  const out = join(tmp, `${top}.model.json`);
  const r = spawnSync(
    "python",
    [join(ROOT, "backend", "svmodel.py"), file, "--top", top, "-o", out],
    { cwd, env, encoding: "utf8" }
  );
  if (r.status !== 0) {
    throw new Error(`svmodel failed on ${file}:\n${r.stdout}${r.stderr}`);
  }
  return JSON.parse(readFileSync(out, "utf8"));
}

/** a real `quick-uvm resolve` of a configuration text; null when it is not there */
function resolveOf(name, text) {
  const file = join(tmp, `${name}.quickuvm.yaml`);
  writeFileSync(file, text);
  let r = spawnSync("quick-uvm", ["resolve", "-c", file], { cwd: tmp, env, encoding: "utf8" });
  if (r.error?.code === "ENOENT") {
    r = spawnSync(
      "python",
      ["-c", "from quick_uvm.cli import main; main()", "resolve", "-c", file],
      { cwd: tmp, env, encoding: "utf8" }
    );
  }
  try {
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

/** one scene: what the host would send for a view of a bench at one moment */
function scene(group, model, configPath, text, view) {
  const config = ops.parseQuvm(text);
  const dut = config.dut?.name;
  const mode = view.mode;
  const viewId = view.viewId ?? dut;
  const resolved = resolveOf(`${group}-${view.name ?? "x"}`, text);
  const sc = {
    group,
    model,
    configPath,
    config,
    resolved,
    overlay: overlayOf(config, dut ? model.modules[dut] : undefined, configPath),
    viewId,
    mode,
    ...(view.focus !== undefined ? { focus: view.focus } : {}),
    ...(view.select ? { select: view.select } : {}),
    ...(view.results ? { results: view.results } : {}),
  };
  if (view.proposals) {
    sc.proposals = proposalsFor(model, viewId, mode, config, resolved).items;
  }
  return { sc, config, resolved };
}

// ----------------------------------------------------------- the two benches
// a headless Chrome window is never narrower than about 500 px: a narrower
// capture is a CLIPPED 500 px layout (the panel's right edge cut off)
const PANEL_W = 520;
const scenes = new Map(); // name -> scene object
const shots = []; // { file, scene, w, h, query, trim?, arrange?, about }
const add = (name, built, shot) => {
  scenes.set(name, built.sc);
  shots.push({ scene: name, ...shot });
};

// --- yapp_buffer: docs/tutorial-yapp-buffer.md, gesture by gesture
{
  const model = svmodel(join(ROOT, "examples-yapp"), "yapp_buffer.sv", "yapp_buffer");
  const PATH = "yapp_buffer.quickuvm.yaml";
  const s0 = ops.setDut(ops.newConfigText("yapp_buffer"), {
    module: "yapp_buffer", clock: "clk", reset: "rst_n", resetActiveLow: true, combinational: false,
  });
  const s1 = ops.createAgent(s0, {
    name: "cmd",
    inputs: [{ name: "in_data", width: 8 }, { name: "in_addr", width: 2 }, { name: "in_valid", width: 1 }],
    outputs: [{ name: "in_ready", width: 1 }],
  });
  const s2 = ops.createAgent(s1, {
    name: "rsp",
    inputs: [{ name: "out_ready", width: 1 }],
    outputs: [{ name: "out_data", width: 8 }, { name: "out_addr", width: 2 }, { name: "out_valid", width: 1 }],
  });
  const s3 = ops.addScoreboard(s2, {
    name: "pkt_sb", source: "cmd", monitor: "rsp", match: "out_of_order", matchKey: "out_addr",
  });
  const s4 = ops.addCoverage(s3, "cmd");
  const B = (view, text) => scene("yapp_buffer", model, PATH, text, view);
  const dir = "yapp-buffer/";
  const cmdPins = ["in_data", "in_addr", "in_valid", "in_ready"].map((p) => `<port>.${p}`);

  add("buf-dut", B({ name: "dut", mode: "symbol", proposals: true }, s0), {
    file: `${dir}01-set-as-dut.png`, w: 1180, h: 600, query: "side=left",
    about: "step 1 — the symbol after \"Set as DUT\": clock / reset roles, the proposal strip",
  });
  add("buf-select", B({ name: "sel", mode: "symbol", select: cmdPins }, s0), {
    file: `${dir}02-select-cmd-pins.png`, w: 1180, h: 600, query: "side=left",
    about: "step 2 — the four command pins selected: \"Agent from selection (4)\"",
  });
  add("buf-agents", B({ name: "agents", mode: "symbol" }, s2), {
    file: `${dir}03-agents-mapped.png`, w: 1180, h: 600, query: "side=left",
    about: "step 3 — both agents: every data pin carries its agent's colour",
  });
  add("buf-top", B({ name: "top", mode: "tb", focus: "" }, s2), {
    file: `${dir}04-testbench-root.png`, w: 1100, h: 480, query: "only=canvas", arrange: true,
    about: "step 4 — the testbench root: DUT and Env, one interface per agent",
  });
  add("buf-env", B({ name: "env", mode: "tb", focus: "env" }, s4), {
    file: `${dir}05-env.png`, w: 1280, h: 680, query: "only=canvas", arrange: true,
    about: "steps 5–6 — inside the Env: two agents, the two-stream scoreboard, the collector",
  });
  add("buf-sb", B({ name: "sb", mode: "tb", focus: "env", select: ["sb:pkt_sb"] }, s4), {
    file: `${dir}06-scoreboard-selected.png`, w: 1480, h: 720, query: "side=left",
    about: "step 5 — the scoreboard selected: its editor in Properties, its pills on the box",
  });
  // step 10: the results of a REAL regression of this bench (Xcelium 25.09)
  const fx = (...p) => readFileSync(join(ROOT, "scripts/fixtures/results", ...p), "utf8");
  const run = (name) =>
    R.runResult(name, {
      status: fx("errors", "runs", name, "status"),
      test: fx("errors", "runs", name, "test.txt"),
      seed: fx("errors", "runs", name, "seed.txt"),
      log: fx("errors", "runs", name, "sim.log"),
    });
  const built = B({ name: "res", mode: "tb", focus: "env" }, s4);
  const snapshot = R.summarizeResults(
    [run("yapp_buffer_test.1"), run("smoke_test.1")],
    R.parseImcSummary(fx("errors", "cov", "summary.txt")),
    R.benchNames(built.config, inferredComponents(built.resolved))
  );
  built.sc.results = { results: snapshot, at: null, stale: false, covStale: false, unparsed: 0 };
  add("buf-results", built, {
    file: `${dir}07-results.png`, w: 1280, h: 680, query: "only=canvas",
    about: "step 10 — the regression's results on the blocks (real Xcelium logs of this bench)",
  });
}

// --- yapp_router: docs/yapp-router-walkthrough.html. The RTL is QuickUVM's own
// example; the configuration is built by the walkthrough's gestures (Steps 1,
// 3, 4 and 5), not copied from the example's hand-written YAML
{
  const repo = resolve(process.env.QUICKUVM_REPO ?? join(ROOT, "..", "QuickUVM"));
  const rtl = join(repo, "examples", "yapp", "rtl");
  if (!existsSync(join(rtl, "yapp_router.sv"))) {
    console.log(`  skip  the YAPP-router figures: no QuickUVM repository at ${repo} (set QUICKUVM_REPO)`);
  } else {
    const model = svmodel(rtl, "yapp_router.sv", "yapp_router");
    const PATH = "yapp_router.quickuvm.yaml";
    const r0 = ops.setDut(ops.newConfigText("yapp_router"), {
      module: "yapp_router", clock: "clk", reset: "rst_n", resetActiveLow: true, combinational: false,
    });
    // Step 3: the nine data ports become the packet agent
    let final = ops.createAgent(r0, {
      name: "pkt",
      inputs: [{ name: "in_valid", width: 1 }, { name: "in_addr", width: 2 }, { name: "in_data", width: 8 }],
      outputs: ["out0", "out1", "out2"].flatMap((o) => [
        { name: `${o}_valid`, width: 1 },
        { name: `${o}_data`, width: 8 },
      ]),
    });
    // Step 4: the three Properties edits
    final = ops.setAgentPortField(final, "pkt", "in_addr", "enum", { P0: 0, P1: 1, P2: 2, DROP: 3 });
    final = ops.setAgentPortField(final, "pkt", "in_valid", "constraint", "in_valid == 1");
    final = ops.setAgentField(final, "pkt", "emit_when", "in_valid");
    // Step 5: the scoreboard and the coverage collector
    final = ops.addScoreboard(final, { name: "sbd", source: "pkt" });
    final = ops.addCoverage(final, "pkt");
    const Rt = (view, text) => scene("yapp_router", model, PATH, text, view);
    const data = [
      "in_valid", "in_addr", "in_data",
      "out0_valid", "out0_data", "out1_valid", "out1_data", "out2_valid", "out2_data",
    ].map((p) => `<port>.${p}`);
    add("rt-symbol", Rt({ name: "sym", mode: "symbol" }, r0), {
      file: "5-rtl-symbol.png", w: 1000, h: 560, query: "only=canvas",
      about: "Step 2 — the yapp_router symbol",
    });
    add("rt-ports", Rt({ name: "ports", mode: "schematic" }, r0), {
      file: "8-rtl-leaf-ports.png", w: 1000, h: 560, query: "only=canvas", arrange: true,
      about: "Step 2 — the same module from inside: its ports as boundary flags",
    });
    add("rt-selected", Rt({ name: "sel", mode: "symbol", select: data }, r0), {
      file: "6-rtl-symbol-selected.png", w: 1000, h: 560, query: "only=canvas",
      about: "Step 3 — the nine data ports selected",
    });
    add("rt-props-agent", Rt({ name: "pa", mode: "tb", focus: "env", select: ["agent:pkt"] }, final), {
      file: "7-properties-agent.png", w: PANEL_W, h: 2400, query: "only=inspector", trim: true,
      about: "Step 4 — Properties with the agent selected",
    });
    add("rt-agent", Rt({ name: "agent", mode: "tb", focus: "agent:pkt" }, final), {
      file: "4-schematic-agent.png", w: 1180, h: 420, query: "only=canvas", arrange: true,
      about: "Step 4 — inside the agent: sequencer, driver, monitor",
    });
    add("rt-props", Rt({ name: "pb", mode: "tb", focus: "" }, final), {
      file: "1-properties-panel.png", w: PANEL_W, h: 2400, query: "only=inspector", trim: true,
      about: "Step 5 — Properties at bench scope: Add component, Generate",
    });
    add("rt-top", Rt({ name: "top", mode: "tb", focus: "" }, final), {
      file: "2-schematic-top.png", w: 1100, h: 440, query: "only=canvas", arrange: true,
      about: "Step 6 — the testbench top: DUT and Env through pkt_if",
    });
    add("rt-env", Rt({ name: "env", mode: "tb", focus: "env" }, final), {
      file: "3-schematic-env.png", w: 1180, h: 600, query: "only=canvas", arrange: true,
      about: "Step 6 — inside the Env: agent, scoreboard, coverage",
    });
  }
}

// ------------------------------------------------------------------ the server
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};
const loadLayouts = () => (existsSync(LAYOUTS) ? JSON.parse(readFileSync(LAYOUTS, "utf8")) : {});
const emptySidecar = () => ({ schema_version: 1, views: {}, orphans: [] });
const urlOf = (s) => `/scripts/harness.html?scene=/__scene/${s.scene}.json&${s.query}`;

function indexPage() {
  const rows = shots
    .filter((s) => s.arrange)
    .map(
      (s) =>
        `<li><a href="${urlOf(s)}" target="_blank">${s.file}</a> — ${s.about}</li>`
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>QuickUVM Architect — arrange the figures</title>
<style>body{font:14px/1.5 "Segoe UI",sans-serif;max-width:860px;margin:32px auto;color:#ddd;background:#1e1e1e}
a{color:#3794ff}li{margin:6px 0}code{background:#2a2d2e;padding:1px 5px;border-radius:3px}</style>
<h1>Arrange the figures</h1>
<p>Open a view, drag its blocks (and flags) where they read best, flip with <code>H</code> / <code>V</code>.
Every gesture is saved to <code>docs/tutorial-shots/layouts.json</code>; reload a page to see what is saved.
The views of one bench share their layout: the Env arranged once is the Env of every figure of that bench.
The <code>⟲</code> button goes back to the automatic layout.</p>
<ul>${rows}</ul>
<p>When done, run <code>npm run shots</code>.</p>`;
}

/** every figure of the walkthrough on one page, labelled (contact-sheet.png) */
function contactPage() {
  const cells = shots
    .filter((s) => !s.file.includes("/"))
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(
      (s) =>
        `<figure><figcaption><b>${s.file}</b> — ${s.about}</figcaption>` +
        `<img src="/docs/tutorial-shots/${s.file}?v=${Date.now()}"></figure>`
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:16px;background:#111;color:#ccc;font:13px "Segoe UI",sans-serif}
figure{margin:0 0 18px}figcaption{margin:0 0 6px}img{display:block;max-width:100%;border:1px solid #333}
</style>${cells}`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, type, body) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  const sceneName = /^\/__scene\/(.+)\.json$/.exec(url.pathname)?.[1];
  if (sceneName && scenes.has(sceneName)) {
    // the layout saved for the bench is injected at request time, so a reload
    // after arranging shows (and a capture uses) what was saved
    const sc = scenes.get(sceneName);
    const body = {
      ...sc,
      sidecar: loadLayouts()[sc.group] ?? emptySidecar(),
      ...(ARRANGE ? { saveUrl: `/__layout/${sc.group}` } : {}),
    };
    return send(200, MIME[".json"], JSON.stringify(body));
  }
  const group = /^\/__layout\/([\w-]+)$/.exec(url.pathname)?.[1];
  if (group && req.method === "POST") {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        const all = loadLayouts();
        all[group] = JSON.parse(data);
        writeFileSync(LAYOUTS, `${JSON.stringify(all, null, 2)}\n`);
        send(200, MIME[".json"], "{}");
      } catch (e) {
        send(400, "text/plain", String(e));
      }
    });
    return undefined;
  }
  if (url.pathname === "/") {
    return send(200, MIME[".html"], indexPage());
  }
  if (url.pathname === "/__contact") {
    return send(200, MIME[".html"], contactPage());
  }
  const file = join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    return send(404, "text/plain", "not found");
  }
  try {
    return send(200, MIME[extname(file)] ?? "application/octet-stream", readFileSync(file));
  } catch {
    return send(404, "text/plain", "not found");
  }
});
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));

if (ARRANGE) {
  console.log(`arrange the figures at http://localhost:${PORT}/  (Ctrl+C to stop)`);
} else {
  // ---------------------------------------------------------------- capture
  const chrome =
    process.env.CHROME ??
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].find((p) => existsSync(p));
  if (!chrome) {
    console.error("no Chrome / Edge found — set CHROME to a Chromium-based browser");
    process.exit(1);
  }
  // spawnSync would block this process's own server: the browser is awaited
  const { spawn } = await import("node:child_process");
  const snap = (url, out, w, h) =>
    new Promise((ok, fail) => {
      const p = spawn(
        chrome,
        [
          "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
          "--force-device-scale-factor=2", `--window-size=${w},${h}`,
          "--virtual-time-budget=12000", `--user-data-dir=${join(tmp, "profile")}`,
          `--screenshot=${out}`, url,
        ],
        { stdio: "ignore" }
      );
      p.on("error", fail);
      p.on("exit", () => (existsSync(out) ? ok() : fail(new Error(`no capture for ${url}`))));
    });
  // the panel captures are taken tall and cut to their content (Pillow)
  const TRIM = [
    "import sys",
    "from PIL import Image, ImageChops",
    "im = Image.open(sys.argv[1]).convert('RGB')",
    "bg = Image.new('RGB', im.size, im.getpixel((im.width - 1, im.height - 1)))",
    "box = ImageChops.difference(im, bg).getbbox()",
    "im.crop((0, 0, im.width, min(im.height, box[3] + 24))).save(sys.argv[1]) if box else None",
  ].join("\n");
  let done = 0;
  for (const s of shots) {
    if (ONLY && !s.file.includes(ONLY) && !s.scene.includes(ONLY)) {
      continue;
    }
    const out = join(SHOTS, s.file);
    mkdirSync(dirname(out), { recursive: true });
    await snap(`http://localhost:${PORT}${urlOf(s)}`, out, s.w, s.h);
    if (s.trim) {
      const t = spawnSync("python", ["-c", TRIM, out], { env, encoding: "utf8" });
      if (t.status !== 0) {
        console.log(`  note  ${s.file}: not trimmed (Pillow missing?)`);
      }
    }
    console.log(`  ok    ${s.file}  (${basename(s.scene)})`);
    done++;
  }
  if (!ONLY && shots.some((s) => !s.file.includes("/"))) {
    const sheet = join(SHOTS, "contact-sheet.png");
    await snap(`http://localhost:${PORT}/__contact`, sheet, 900, 9000);
    spawnSync("python", ["-c", TRIM, sheet], { env, encoding: "utf8" });
    console.log("  ok    contact-sheet.png");
  }
  server.close();
  console.log(`${done} figure(s) captured into docs/tutorial-shots/`);
}
