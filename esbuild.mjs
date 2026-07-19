// Build: host-ul extensiei (Node/CJS) + codul webview-ului (browser/IIFE).
// elkjs se leaga static in dist/webview.js (varianta bundled, fara worker).
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

const host = {
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
};

const webview = {
  ...common,
  entryPoints: ["src/webview/main.ts"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(host),
    esbuild.context(webview),
  ]);
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(host), esbuild.build(webview)]);
}
