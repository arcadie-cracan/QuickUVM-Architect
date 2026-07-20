// Running the semantic backend (backend/svmodel.py) as a child process:
// debounce on save, collecting stdout (the JSON model) and stderr
// (slang diagnostics -> Problems). On failure, the old model stays valid
// and `model/stale` is announced (graceful invalidation, docs/01).

import { ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { resolveFileList } from "./filelist";
import { ProjectModel, validateModel } from "./model";

/** a slang diagnostic line: file:line:column: severity: message */
const DIAG_RE = /^(.+?):(\d+):(\d+): (error|warning|note): (.*)$/;

const SEVERITY: Record<string, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  note: vscode.DiagnosticSeverity.Information,
};

export class Backend implements vscode.Disposable {
  private readonly modelEmitter = new vscode.EventEmitter<ProjectModel>();
  private readonly staleEmitter = new vscode.EventEmitter<number>();
  /** new, validated model */
  readonly onModel = this.modelEmitter.event;
  /** compilation failed: the error count; the old model stays */
  readonly onStale = this.staleEmitter.event;

  private proc: ChildProcess | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private rerunAfter = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
    private readonly diagnostics: vscode.DiagnosticCollection
  ) {}

  /** Schedules a debounced run (defaults to the quickuvm.debounceMs setting). */
  schedule(delayMs?: number): void {
    const cfg = vscode.workspace.getConfiguration("quickuvm");
    const delay = delayMs ?? cfg.get<number>("debounceMs", 400);
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private async run(): Promise<void> {
    if (this.proc) {
      // a run is in progress: a single re-run is scheduled after it finishes
      this.rerunAfter = true;
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0];
    const storage = this.context.storageUri;
    if (!root || !storage) {
      this.log.appendLine("[backend] no workspace folder; nothing to do");
      return;
    }
    const cfg = vscode.workspace.getConfiguration("quickuvm", root.uri);
    const top = cfg.get<string>("top", "").trim();
    if (!top) {
      this.log.appendLine("[backend] quickuvm.top is not set; run canceled");
      void vscode.window
        .showWarningMessage(
          vscode.l10n.t("QuickUVM Architect: the top module is not set."),
          vscode.l10n.t("Set Top Module")
        )
        .then((pick) => {
          if (pick) {
            void vscode.commands.executeCommand("quickuvm.setTop");
          }
        });
      return;
    }

    let flist: string;
    try {
      ({ flist } = await resolveFileList(root, storage, this.log));
    } catch (e) {
      this.log.appendLine(`[backend] ${String(e)}`);
      void vscode.window.showErrorMessage(
        vscode.l10n.t("QuickUVM Architect: {0}", String(e))
      );
      return;
    }

    const python = cfg.get<string>("python", "python");
    const script = this.context.asAbsolutePath(
      path.join("backend", "svmodel.py")
    );
    const args = [
      script,
      "-f",
      flist,
      "--top",
      top,
      "--label-threshold",
      String(cfg.get<number>("labelThreshold", 4)),
    ];
    this.log.appendLine(`[backend] ${python} ${args.join(" ")}`);

    const started = Date.now();
    // PYTHONUTF8: slang diagnostics can cite Unicode sources; the default
    // Windows console is cp1252 and sys.stderr.write would crash (quick-uvm pitfall)
    const proc = spawn(python, args, {
      cwd: root.uri.fsPath,
      shell: false,
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    this.proc = proc;
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    proc.on("error", (e) => {
      this.log.appendLine(`[backend] failed to start: ${String(e)}`);
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'QuickUVM Architect: cannot start "{0}" — check the quickuvm.python setting.',
          python
        )
      );
      this.proc = undefined;
    });
    proc.on("close", (code) => {
      this.proc = undefined;
      const errors = this.publishDiagnostics(err, root);
      if (err.trim()) {
        this.log.appendLine(err.trimEnd());
      }
      if (code === 0) {
        try {
          const model = validateModel(JSON.parse(out));
          this.log.appendLine(
            `[backend] model OK in ${Date.now() - started} ms: ` +
              `${model.instances.length} instances, ` +
              `${Object.keys(model.views).length} views, ${errors} errors`
          );
          this.modelEmitter.fire(model);
        } catch (e) {
          this.log.appendLine(`[backend] invalid model: ${String(e)}`);
          this.staleEmitter.fire(Math.max(errors, 1));
        }
      } else {
        this.log.appendLine(`[backend] exited with code ${code}; model kept`);
        this.staleEmitter.fire(Math.max(errors, 1));
      }
      if (this.rerunAfter) {
        this.rerunAfter = false;
        this.schedule(0);
      }
    });
  }

  /** Parses the slang diagnostics from stderr into Problems; returns the error count. */
  private publishDiagnostics(
    stderr: string,
    root: vscode.WorkspaceFolder
  ): number {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    let errors = 0;
    for (const line of stderr.split(/\r?\n/)) {
      const m = DIAG_RE.exec(line);
      if (!m) {
        continue;
      }
      const [, file, ln, col, sev, msg] = m;
      if (sev === "error") {
        errors++;
      }
      const lineNo = Math.max(0, Number(ln) - 1);
      const colNo = Math.max(0, Number(col) - 1);
      const diag = new vscode.Diagnostic(
        new vscode.Range(lineNo, colNo, lineNo, colNo + 1),
        msg,
        SEVERITY[sev]
      );
      diag.source = "quickuvm/slang";
      const abs = path.isAbsolute(file)
        ? file
        : path.join(root.uri.fsPath, file);
      const key = vscode.Uri.file(abs).toString();
      const list = byFile.get(key) ?? [];
      list.push(diag);
      byFile.set(key, list);
    }
    this.diagnostics.clear();
    for (const [uri, list] of byFile) {
      this.diagnostics.set(vscode.Uri.parse(uri), list);
    }
    return errors;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.proc?.kill();
    this.modelEmitter.dispose();
    this.staleEmitter.dispose();
  }
}
