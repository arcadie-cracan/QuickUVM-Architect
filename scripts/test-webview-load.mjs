// Both webview bundles must be IMPORTABLE without throwing.
//
// This exists because they once were not: `inspector-view.ts` read `ctx.vscode` at
// module scope to restore the persisted disclosures, and `ctx` is only assigned when
// `renderInspector` runs. Importing threw a TypeError, which killed the whole script —
// the diagram showed its static "select an instance" placeholder and the sidebar
// Properties view rendered nothing at all. The `let ctx!` definite-assignment
// assertion hid it from the compiler, so nothing else would have caught it.
//
// The rule this pins: NO module-scope code may depend on the render context.
//   npm run test:webview-load

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "quickuvm-webview-load-"));

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  ok  ${name}`);
  passed++;
}

/** Bundle an entry for the browser, then import it under a minimal DOM stub. */
async function importsCleanly(entry, name) {
  const outFile = join(outDir, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  // the least a webview script may assume at LOAD time: a document it can query and
  // the vscode api factory. Anything more is a module-scope dependency and a bug.
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({
      className: "",
      style: {},
      append: () => undefined,
      addEventListener: () => undefined,
    }),
    createTextNode: () => ({}),
  };
  globalThis.window = { addEventListener: () => undefined };
  globalThis.acquireVsCodeApi = () => ({
    postMessage: () => undefined,
    getState: () => undefined,
    setState: () => undefined,
  });
  return import(pathToFileURL(outFile));
}

await test("inspector-view imports with no render context assigned", async () => {
  const mod = await importsCleanly("src/webview/inspector-view.ts", "inspector-view");
  // it must also EXPORT the entry point the two surfaces call
  assert.equal(typeof mod.renderInspector, "function");
});

await test("the sidebar Properties entry imports and boots", async () => {
  // properties.ts runs at load (it posts `ready` and renders once), so this covers
  // its boot path too — with #inspector absent, `render` must simply do nothing
  const mod = await importsCleanly("src/webview/properties.ts", "properties");
  assert.ok(mod);
});

console.log(`\ntest-webview-load: ${passed} tests passed.`);
