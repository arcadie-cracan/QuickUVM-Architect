// The PURE part of the paths and file lists exchanged with slang (no
// vscode) — testable in Node (scripts/test-filelist.mjs). Three real pitfalls
// live here (CLAUDE.md):
// - slang relativizes loc.file against the process cwd (it can come out
//   ..\..\...); the host reconstructs the absolute path by joining with the
//   workspace root (resolveLocPath, used by openLoc);
// - slang splits the command line on spaces: the paths in .f are quoted
//   in full, and at +incdir+ only the path is quoted (`+incdir+"cale"`,
//   validated with slang 11 on paths with spaces);
// - the quick-uvm output directory is excluded from the source glob: the
//   generated testbench contains a DUT stub (a duplicate definition that wins
//   slang resolution) and sources that require uvm_macros.svh — otherwise the
//   extension poisons its own model after the first "Generate Testbench" (a real
//   regression on examples/, where test:e2e had left tb/).

import * as path from "path";

/**
 * Quotes the lines of a flist for the slang parser (splits on spaces).
 * Paths are quoted in full; at +incdir+ only the path is quoted (the
 * `+incdir+"cale"` form, validated with slang 11 on paths with spaces). Bender emits a
 * single directory per +incdir+ line; +define+ contains no spaces.
 */
export function quoteFlistLine(line: string): string {
  const t = line.trim();
  if (!t || t.startsWith("//") || t.startsWith("#")) {
    return t;
  }
  const inc = /^\+incdir\+(?!")(.+)$/.exec(t);
  if (inc) {
    return `+incdir+"${inc[1]}"`;
  }
  if (t.startsWith("+")) {
    return t;
  }
  return t.startsWith('"') ? t : `"${t}"`;
}

/** the text of the .f file: the quoted lines, without those left empty */
export function renderFlist(lines: string[]): string {
  return lines.map(quoteFlistLine).filter(Boolean).join("\n") + "\n";
}

/**
 * The exclude pattern for the quick-uvm output directory, or null when
 * a relative exclude makes no sense (empty, "." = the root, an absolute path).
 * Normalizes \ -> / and trims the trailing separators.
 */
export function outputDirExclude(outputDir: string): string | null {
  const outDir = outputDir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  // absolute on ANY platform: on Linux, path.isAbsolute does not recognize
  // "C:\..." (a real regression: the absolute outputDir test failed on posix)
  if (!outDir || outDir === "." || path.isAbsolute(outDir) || /^[A-Za-z]:\//.test(outDir)) {
    return null;
  }
  return `${outDir}/**`;
}

/**
 * The absolute path of a `loc.file` emitted by slang: an absolute one stays as is, and
 * a relative one (slang relativizes it against the process cwd — it can come out
 * `..\\..\\...`) is reconstructed by joining with the workspace root
 * (path.join normalizes the `..` segments).
 */
export function resolveLocPath(root: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(root, file);
}
