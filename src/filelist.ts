// Resolving the SV source list, in the order from docs/01-arhitectura.md:
// 1. Bender (`bender script flist-plus`), if Bender.yml exists in the root;
// 2. a .f file indicated by the user (the quickuvm.fileList setting);
// 3. a glob over the workspace (the quickuvm.sourceGlob setting).
// The result is always a .f file (generated in the extension's storage when
// needed), passed to the backend with -f — avoids the command-line length
// limit on Windows. The flist-plus format (not flist!) preserves
// +incdir/+define — otherwise export_include_dirs from Bender.yml is lost and
// `include directives fail.

import { spawn } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { outputDirExclude, renderFlist } from "./filelistops";

export interface FileListResult {
  /** the path of the .f file to pass to the backend */
  flist: string;
  /** the provenance, for messages and the log */
  source: "bender" | ".f file" | "glob";
}

function runCapture(
  cmd: string,
  args: string[],
  cwd: string
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: false });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    p.on("error", reject); // e.g. ENOENT: bender is not installed
    p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

async function writeFlist(
  storage: vscode.Uri,
  lines: string[]
): Promise<string> {
  await vscode.workspace.fs.createDirectory(storage);
  const uri = vscode.Uri.joinPath(storage, "quickuvm-architect.f");
  // the quoting for slang (splits on spaces) lives in filelistops (pure, tested)
  const text = renderFlist(lines);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
  return uri.fsPath;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function resolveFileList(
  root: vscode.WorkspaceFolder,
  storage: vscode.Uri,
  log: vscode.OutputChannel
): Promise<FileListResult> {
  const cfg = vscode.workspace.getConfiguration("quickuvm", root.uri);

  // 1. Bender
  if (await exists(vscode.Uri.joinPath(root.uri, "Bender.yml"))) {
    const bender = cfg.get<string>("bender", "bender");
    const extra = cfg.get<string>("benderArgs", "").split(/\s+/).filter(Boolean);
    const args = ["script", "flist-plus", ...extra];
    try {
      const r = await runCapture(bender, args, root.uri.fsPath);
      if (r.code === 0 && r.out.trim()) {
        const flist = await writeFlist(storage, r.out.split(/\r?\n/));
        log.appendLine(`[filelist] bender script flist-plus -> ${flist}`);
        return { flist, source: "bender" };
      }
      log.appendLine(
        `[filelist] bender failed (code ${r.code}); trying fallback.\n${r.err}`
      );
    } catch (e) {
      log.appendLine(`[filelist] bender unavailable (${String(e)}); falling back.`);
    }
  }

  // 2. the user's .f file
  const userList = cfg.get<string>("fileList", "").trim();
  if (userList) {
    const abs = path.isAbsolute(userList)
      ? userList
      : path.join(root.uri.fsPath, userList);
    if (await exists(vscode.Uri.file(abs))) {
      log.appendLine(`[filelist] .f file: ${abs}`);
      return { flist: abs, source: ".f file" };
    }
    log.appendLine(`[filelist] quickuvm.fileList does not exist: ${abs}; falling back to glob.`);
  }

  // 3. glob over the workspace
  const glob = cfg.get<string>("sourceGlob", "**/*.sv");
  // the quick-uvm output directory is excluded (the DUT stub would poison
  // the model — the full reasoning in filelistops.ts, pure and tested)
  const excludes = ["**/node_modules/**"];
  const outExclude = outputDirExclude(cfg.get<string>("outputDir", "tb"));
  if (outExclude) {
    excludes.push(outExclude);
  }
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, glob),
    new vscode.RelativePattern(root, `{${excludes.join(",")}}`)
  );
  if (files.length === 0) {
    throw new Error(
      vscode.l10n.t(
        'no sources found: no Bender.yml, no .f file, glob "{0}" empty',
        glob
      )
    );
  }
  const sorted = files.map((u) => u.fsPath).sort();
  const flist = await writeFlist(storage, sorted);
  log.appendLine(`[filelist] glob "${glob}": ${sorted.length} files -> ${flist}`);
  return { flist, source: "glob" };
}
