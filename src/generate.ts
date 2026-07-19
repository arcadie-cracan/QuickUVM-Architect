// Ciclul de generare (docs/03): comanda "Genereaza testbench" ruleaza
// `quick-uvm generate -c <yaml> -o <dir>`; erorile Pydantic/CLI ajung in
// Problems pe fisierul YAML, iesirea completa in canalul de jurnal.
// Generarea cu porturi nemapate cere confirmare (indicatorul de acoperire).

import { spawn } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { ConfigService } from "./config";
import { GenerateStatus } from "./protocol";

export class Generator {
  /** rezultatul ultimei rulari, pentru cipul de stare din diagrama
   *  (docs/05); null = niciodata rulat in sesiunea asta */
  status: GenerateStatus | null = null;
  private readonly statusEmitter = new vscode.EventEmitter<GenerateStatus>();
  /** semnal dupa fiecare rulare (si esecul ENOENT) — extension.ts posteaza
   *  status/decorations catre webview */
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

    // acoperirea: generarea cu porturi nemapate cere confirmare (docs/03)
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

    // quick-uvm citeste de pe disc: documentul murdar se salveaza intai
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
      // fallback: modulul instalat, prin acelasi Python ca backend-ul
      const python = cfg.get<string>("python", "python");
      const shim = "from quick_uvm.cli import main; main()";
      this.log.appendLine(`[generate] fallback: ${python} -c "${shim}" …`);
      r = await run(python, ["-c", shim, ...args], cwd);
      if (r.enoent) {
        // cipul de stare arata si esecul de lansare (mesaj EN — docs/05)
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

  /** Erorile de validare/CLI, ca diagnostic pe fisierul de configuratie;
   *  intoarce mesajul scurtat, refolosit de cipul de stare (docs/05). */
  private publishDiagnostics(
    uri: vscode.Uri,
    code: number,
    stderr: string
  ): string {
    this.diagnostics.clear();
    if (code === 0) {
      return "";
    }
    // Pydantic scrie "N validation error(s) for ProjectConfig" + campuri;
    // click scrie "Error: ...". Se pastreaza mesajul brut — e deja lizibil.
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
    // PYTHONUTF8: quick-uvm scrie sageti Unicode; consola Windows e cp1252
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
