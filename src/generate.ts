// The generation cycle (docs/03): the "Generate Testbench" command runs
// `quick-uvm generate -c <yaml> -o <dir>`; the Pydantic/CLI errors land in
// Problems on the YAML file, the full output in the log channel.
// Generation with unmapped ports requires confirmation (the coverage indicator).

import { spawn } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { ConfigService } from "./config";
import { GenerateStatus } from "./protocol";

export class Generator {
  /** the result of the last run, for the status chip in the diagram
   *  (docs/05); null = never run in this session */
  status: GenerateStatus | null = null;
  private readonly statusEmitter = new vscode.EventEmitter<GenerateStatus>();
  /** signaled after every run (including the ENOENT failure) — extension.ts posts
   *  status/decorations to the webview */
  readonly onStatus = this.statusEmitter.event;

  constructor(
    private readonly config: ConfigService,
    private readonly log: vscode.OutputChannel,
    private readonly diagnostics: vscode.DiagnosticCollection
  ) {}

  private setStatus(ok: boolean, code: number, detail: string): void {
    this.status = { ok, code, detail, at: new Date().toISOString() };
    this.statusEmitter.fire(this.status);
  }

  async generate(): Promise<void> {
    const uri = this.config.configUri;
    if (!uri) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "QuickUVM Architect: there is no QuickUVM configuration — set the DUT first."
        )
      );
      return;
    }

    // coverage: generation with unmapped ports requires confirmation (docs/03)
    const unmapped = this.config.lastOverlay?.coverage.unmapped ?? [];
    if (unmapped.length > 0) {
      const list =
        unmapped.slice(0, 6).join(", ") +
        (unmapped.length > 6 ? `, … (+${unmapped.length - 6})` : "");
      const go = await vscode.window.showWarningMessage(
        unmapped.length === 1
          ? vscode.l10n.t(
              "QuickUVM Architect: 1 unmapped port ({0}). Generate anyway?",
              list
            )
          : vscode.l10n.t(
              "QuickUVM Architect: {0} unmapped ports ({1}). Generate anyway?",
              unmapped.length,
              list
            ),
        { modal: true },
        vscode.l10n.t("Generate")
      );
      if (!go) {
        return;
      }
    }

    // quick-uvm reads from disk: the dirty document is saved first
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.isDirty && !(await doc.save())) {
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0];
    const cfg = vscode.workspace.getConfiguration("quickuvm", root?.uri);
    const outDir = cfg.get<string>("outputDir", "tb");
    const cwd = root?.uri.fsPath ?? path.dirname(uri.fsPath);
    const args = ["generate", "-c", uri.fsPath, "-o", outDir];

    const command = cfg.get<string>("quickUvm", "quick-uvm");
    this.log.appendLine(`[generate] ${command} ${args.join(" ")}`);
    let r = await run(command, args, cwd);
    if (r.enoent) {
      // fallback: the installed module, through the same Python as the backend
      const python = cfg.get<string>("python", "python");
      const shim = "from quick_uvm.cli import main; main()";
      this.log.appendLine(`[generate] fallback: ${python} -c "${shim}" …`);
      r = await run(python, ["-c", shim, ...args], cwd);
      if (r.enoent) {
        // the status chip also shows the launch failure (EN message — docs/05)
        this.setStatus(false, -1, "quick-uvm not found (pip install quick-uvm)");
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            "QuickUVM Architect: cannot run quick-uvm — install it (pip install quick-uvm) or set quickuvm.quickUvm."
          )
        );
        return;
      }
    }

    if (r.out.trim()) {
      this.log.appendLine(r.out.trimEnd());
    }
    if (r.err.trim()) {
      this.log.appendLine(r.err.trimEnd());
    }
    const detail = this.publishDiagnostics(uri, r.code, r.err);
    this.setStatus(r.code === 0, r.code, detail);

    if (r.code === 0) {
      const abs = path.isAbsolute(outDir) ? outDir : path.join(cwd, outDir);
      const pick = await vscode.window.showInformationMessage(
        vscode.l10n.t("QuickUVM Architect: testbench generated in {0}.", abs),
        vscode.l10n.t("Show Files")
      );
      if (pick) {
        await vscode.commands.executeCommand(
          "revealInExplorer",
          vscode.Uri.file(abs)
        );
      }
    } else {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          "QuickUVM Architect: quick-uvm failed (code {0}) — details in the Problems panel and in the QuickUVM Architect output channel.",
          r.code
        )
      );
      this.log.show(true);
    }
  }

  /** The validation/CLI errors, as a diagnostic on the configuration file;
   *  returns the shortened message, reused by the status chip (docs/05). */
  private publishDiagnostics(
    uri: vscode.Uri,
    code: number,
    stderr: string
  ): string {
    this.diagnostics.clear();
    if (code === 0) {
      return "";
    }
    // Pydantic writes "N validation error(s) for ProjectConfig" + fields;
    // click writes "Error: ...". The raw message is kept — it is already readable.
    const text = stderr.trim();
    const start = text.search(/\d+ validation errors? for|Error:/);
    const message =
      start >= 0
        ? text.slice(start)
        : text || vscode.l10n.t("quick-uvm exited with {0}", code);
    const short = message.split(/\r?\n/).slice(0, 12).join("\n");
    const d = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      short,
      vscode.DiagnosticSeverity.Error
    );
    d.source = "quickuvm/generate";
    this.diagnostics.set(uri, [d]);
    return short;
  }
}

function run(
  cmd: string,
  args: string[],
  cwd: string
): Promise<{ code: number; out: string; err: string; enoent: boolean }> {
  return new Promise((resolve) => {
    // PYTHONUTF8: quick-uvm writes Unicode arrows; the Windows console is cp1252
    const p = spawn(cmd, args, {
      cwd,
      shell: false,
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    p.on("error", (e: NodeJS.ErrnoException) =>
      resolve({ code: -1, out, err, enoent: e.code === "ENOENT" })
    );
    p.on("close", (code) =>
      resolve({ code: code ?? -1, out, err, enoent: false })
    );
  });
}

/**
 * Run `quick-uvm <args>` from `cwd`, with the same ENOENT fallback the generate
 * flow uses (the configured `quickuvm.quickUvm` binary, else the installed module
 * through `quickuvm.python`). Shared by the generate flow and the generation-state
 * service (`quick-uvm manifest`).
 */
export async function invokeQuickUvm(
  args: string[],
  cwd: string,
  cfg: vscode.WorkspaceConfiguration
): Promise<{ code: number; out: string; err: string; enoent: boolean }> {
  const command = cfg.get<string>("quickUvm", "quick-uvm");
  const r = await run(command, args, cwd);
  if (!r.enoent) {
    return r;
  }
  const python = cfg.get<string>("python", "python");
  return run(python, ["-c", "from quick_uvm.cli import main; main()", ...args], cwd);
}
