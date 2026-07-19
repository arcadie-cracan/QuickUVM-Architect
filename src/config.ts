// Serviciul de configurare QuickUVM: descopera fisierul YAML, il urmareste,
// deriva overlay-ul pentru webview si valideaza YAML<->model ca diagnostice.
// YAML-ul e sursa de adevar (invariantul 2): serviciul nu tine stare proprie —
// orice actiune produce un WorkspaceEdit prin `apply`, iar overlay-ul se
// recalculeaza din textul curent al documentului (inclusiv nesalvat).

import * as path from "path";
import * as vscode from "vscode";
import { parseDocument } from "yaml";
import { checkConfig, Finding, WIDTH_CODE } from "./configcheck";
import { ProjectModel } from "./model";
import { AGENT_PALETTE, OverlayConfig, PortRole, StatusDeco } from "./protocol";
import { decosFromFindings } from "./status";
import { agentPorts, QuvmConfig } from "./quickuvm";
import { newConfigText, topConfigPaths } from "./yamlops";

// re-export: codul quick-fix-ului de latime traieste in nucleul pur
export { WIDTH_CODE } from "./configcheck";

/**
 * Suprafata minima pe care gesturile de EDITARE TB (add/delete/edit) o cer de la
 * o sursa de configuratie: config-ul parsat, URI-ul si un `apply` de mutatie
 * (felia 4). `ConfigService` o satisface (config-ul ACTIV), iar editorul
 * per-fisier (`CustomTextEditor`) o implementeaza pe DOCUMENTUL deschis — asa
 * gesturile din `actions.ts` merg identic pe oricare, fara duplicare.
 */
export interface TbEditTarget {
  readonly current: QuvmConfig;
  readonly configUri: vscode.Uri | undefined;
  apply(mutate: (text: string) => string): Promise<boolean>;
}

const GLOB = "**/*.quickuvm.yaml";

export class ConfigService implements vscode.Disposable {
  private readonly overlayEmitter = new vscode.EventEmitter<OverlayConfig | null>();
  /** overlay-ul re-derivat dupa orice schimbare de YAML sau de model */
  readonly onOverlay = this.overlayEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private model: ProjectModel | undefined;
  private uri: vscode.Uri | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** ultima stare derivata, retrimisa webview-ului la `ready` */
  lastOverlay: OverlayConfig | null = null;
  /** decoratiile de stare derivate din ultimele validari (docs/05) */
  decorations: StatusDeco[] = [];
  /** ultima configuratie parsata (pentru comenzi si validari) */
  current: QuvmConfig = {};

  constructor(
    private readonly log: vscode.OutputChannel,
    private readonly diagnostics: vscode.DiagnosticCollection
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(GLOB);
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => void this.refresh(true)),
      watcher.onDidDelete(() => void this.refresh(true)),
      watcher.onDidChange(() => this.debouncedRefresh()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.uri && e.document.uri.toString() === this.uri.toString()) {
          this.debouncedRefresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("quickuvm.configFile")) {
          void this.refresh(true);
        }
      })
    );
  }

  setModel(model: ProjectModel | undefined): void {
    this.model = model;
    void this.refresh();
  }

  get configUri(): vscode.Uri | undefined {
    return this.uri;
  }

  private debouncedRefresh(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.refresh(), 200);
  }

  /**
   * Gaseste fisierul de configuratie: setarea explicita, apoi glob.
   * Stabilitate: configuratia activa (`prev`) NU se schimba cat timp fisierul
   * ei exista — crearea config-urilor de bloc de catre createSubenv (docs/03)
   * nu trebuie sa comute tacit config-ul activ (regresie reala: scaffold-ul
   * `chan.quickuvm.yaml` castiga alfabetic si "fura" overlay-ul si actiunile).
   * La alegerea initiala dintre mai multe fisiere, cele referite ca
   * `subenvs[].config` de un alt fisier (copiii) se exclud.
   */
  private async discover(prev?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return undefined;
    }
    const setting = vscode.workspace
      .getConfiguration("quickuvm", root.uri)
      .get<string>("configFile", "")
      .trim();
    if (setting) {
      const abs = path.isAbsolute(setting)
        ? setting
        : path.join(root.uri.fsPath, setting);
      return vscode.Uri.file(abs);
    }
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, GLOB),
      "**/node_modules/**"
    );
    if (found.length === 0) {
      return undefined;
    }
    if (prev && found.some((u) => u.fsPath === prev.fsPath)) {
      return prev; // stabilitate: fisierul activ inca exista
    }
    if (found.length === 1) {
      return found[0];
    }
    const files = await Promise.all(
      found.map(async (u) => ({
        path: u.fsPath,
        text: Buffer.from(await vscode.workspace.fs.readFile(u)).toString(
          "utf8"
        ),
      }))
    );
    const tops = topConfigPaths(files).sort();
    const all = found.map((u) => u.fsPath).sort();
    const pick = tops[0] ?? all[0];
    this.log.appendLine(
      `[config] ${all.length} *.quickuvm.yaml files ` +
        `(${all.length - tops.length} referenced as subenv children); using ` +
        `${pick} (pin the desired one in quickuvm.configFile)`
    );
    return vscode.Uri.file(pick);
  }

  /**
   * Fisierul de configuratie, creat la nevoie (prima actiune de configurare).
   * Numele nou: `<modulDut>.quickuvm.yaml` in radacina workspace-ului.
   */
  async ensureConfig(dutModule: string): Promise<vscode.Uri | undefined> {
    await this.refresh(true);
    if (this.uri) {
      return this.uri;
    }
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return undefined;
    }
    const uri = vscode.Uri.joinPath(root.uri, `${dutModule}.quickuvm.yaml`);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, {
      ignoreIfExists: true,
      contents: Buffer.from(newConfigText(dutModule), "utf8"),
    });
    await vscode.workspace.applyEdit(edit);
    this.uri = uri;
    this.log.appendLine(`[config] created ${uri.fsPath}`);
    return uri;
  }

  /**
   * Creeaza (daca lipseste) si ACTIVEAZA config-ul dedicat unui modul —
   * fluxul recursiv al compunerii (docs/03): fiecare nivel isi are fisierul.
   * Activarea e de sesiune (descoperirea stabila o pastreaza cat exista
   * fisierul); pentru persistenta intre sesiuni: quickuvm.configFile sau
   * comanda "Choose Active Config".
   */
  async createConfigFor(dutModule: string): Promise<vscode.Uri | undefined> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return undefined;
    }
    const dir = this.uri ? vscode.Uri.joinPath(this.uri, "..") : root.uri;
    const uri = vscode.Uri.joinPath(dir, `${dutModule}.quickuvm.yaml`);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, {
      ignoreIfExists: true,
      contents: Buffer.from(newConfigText(dutModule), "utf8"),
    });
    await vscode.workspace.applyEdit(edit);
    this.uri = uri;
    await this.refresh();
    this.log.appendLine(
      `[config] active config: ${uri.fsPath} (session; pin via quickuvm.configFile)`
    );
    return uri;
  }

  /** Toate fisierele *.quickuvm.yaml din workspace (pentru chooseConfig). */
  async listConfigs(): Promise<vscode.Uri[]> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return [];
    }
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, GLOB),
      "**/node_modules/**"
    );
    return found.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  /**
   * Aplica o mutatie yamlops pe textul curent, ca un singur WorkspaceEdit
   * (undo/redo nativ). Documentul ramane nesalvat — utilizatorul decide.
   */
  async apply(mutate: (text: string) => string): Promise<boolean> {
    if (!this.uri) {
      return false;
    }
    const doc = await vscode.workspace.openTextDocument(this.uri);
    const oldText = doc.getText();
    let newText: string;
    try {
      newText = mutate(oldText);
    } catch (e) {
      void vscode.window.showErrorMessage(vscode.l10n.t("QuickUVM Architect: {0}", String(e instanceof Error ? e.message : e)));
      return false;
    }
    if (newText === oldText) {
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(oldText.length)),
      newText
    );
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) {
      // sincron, nu debounced: apelantii citesc `current` imediat dupa apply
      // (checkDut dupa "Set this module as DUT" avorta tacit pe stare veche —
      // regresie reala prinsa la validarea pe common_cells)
      await this.refresh();
    }
    return ok;
  }

  /** Re-deriva overlay-ul si diagnosticele din YAML-ul si modelul curente. */
  async refresh(rediscover = false): Promise<void> {
    if (rediscover || !this.uri) {
      this.uri = await this.discover(this.uri);
    }
    if (!this.uri) {
      this.current = {};
      this.publish(null, []);
      return;
    }
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(this.uri);
    } catch {
      // fisier sters sau ilizibil: configuratia dispare, overlay-ul si el
      this.uri = undefined;
      this.publish(null, []);
      return;
    }
    const text = doc.getText();
    const ydoc = parseDocument(text);
    const diags: vscode.Diagnostic[] = [];

    for (const err of [...ydoc.errors, ...ydoc.warnings]) {
      const [s, e] = err.pos;
      diags.push(
        diag(
          new vscode.Range(doc.positionAt(s), doc.positionAt(Math.max(e, s + 1))),
          err.message,
          err.name === "YAMLWarning"
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Error
        )
      );
    }

    this.current = (ydoc.toJS() as QuvmConfig) ?? {};
    // nucleul validarilor e PUR (configcheck.ts, testat); aici doar mapam
    // findings -> vscode.Diagnostic cu mesajele localizate (D19)
    const res = checkConfig(ydoc, this.current, this.model);
    // decoratiile de stare pentru diagrama (docs/05): derivare pura din
    // aceleasi findings; extension.ts le posteaza la onOverlay
    this.decorations = decosFromFindings(res.findings);
    for (const f of res.findings) {
      const range = f.span
        ? new vscode.Range(doc.positionAt(f.span[0]), doc.positionAt(f.span[1]))
        : new vscode.Range(0, 0, 0, 1);
      const d = diag(
        range,
        findingMessage(f),
        f.severity === "error"
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning
      );
      if (f.code) {
        d.code = f.code;
      }
      diags.push(d);
    }
    this.publish(this.buildOverlay(this.current, res.orphans), diags);
  }

  private buildOverlay(cfg: QuvmConfig, orphans: string[]): OverlayConfig {
    const dut = cfg.dut?.name ?? null;
    const agents = (cfg.agents ?? [])
      .filter((a): a is typeof a & { name: string } => Boolean(a.name))
      .map((a, i) => ({
        name: a.name,
        color: i % AGENT_PALETTE,
        pins: [...agentPorts(a).keys()],
      }));

    const roles: Record<string, PortRole> = {};
    for (const p of cfg.x_quickuvm_architect?.ignored_ports ?? []) {
      roles[p] = "ignored";
    }
    if (cfg.dut?.clock) {
      roles[cfg.dut.clock] = "clock";
    }
    if (cfg.dut?.reset) {
      roles[cfg.dut.reset] = "reset";
    }

    const def = this.model && dut ? this.model.modules[dut] : undefined;
    const claimed = new Set(agents.flatMap((a) => a.pins));
    const unmapped = (def?.ports ?? [])
      .map((p) => p.name)
      .filter((n) => !claimed.has(n) && !roles[n]);
    const total = def?.ports.length ?? 0;

    return {
      dut,
      configPath: this.uri
        ? vscode.workspace.asRelativePath(this.uri, false)
        : null,
      agents,
      roles,
      coverage: { total, mapped: total - unmapped.length, unmapped },
      orphans,
    };
  }

  private publish(
    overlay: OverlayConfig | null,
    diags: vscode.Diagnostic[]
  ): void {
    this.lastOverlay = overlay;
    this.diagnostics.clear();
    if (this.uri && diags.length) {
      this.diagnostics.set(this.uri, diags);
    }
    this.overlayEmitter.fire(overlay);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.overlayEmitter.dispose();
  }
}

/** Quick-fix-ul „actualizeaza latimea la N" (docs/03), pe diagnosticul WIDTH_CODE. */
export class WidthFixProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  provideCodeActions(
    _doc: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const d of context.diagnostics) {
      const code = typeof d.code === "string" ? d.code : "";
      if (!code.startsWith(`${WIDTH_CODE}:`)) {
        continue;
      }
      const [, agent, port, width] = code.split(":");
      const action = new vscode.CodeAction(
        vscode.l10n.t('Update width of "{0}" to {1}', port, width),
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [d];
      action.isPreferred = true;
      action.command = {
        command: "quickuvm.fixPortWidth",
        title: action.title,
        arguments: [agent, port, Number(width)],
      };
      actions.push(action);
    }
    return actions;
  }
}

// ------------------------------------------------------------------ utilitare

function diag(
  range: vscode.Range,
  message: string,
  severity: vscode.DiagnosticSeverity
): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, message, severity);
  d.source = "quickuvm/config";
  return d;
}

/** Mesajul localizat al unui finding din nucleul pur (l10n ramane aici, D19). */
function findingMessage(f: Finding): string {
  const p = f.params;
  switch (f.kind) {
    case "dut-missing":
      return vscode.l10n.t(
        'Module "{0}" does not exist in the current design',
        String(p.module)
      );
    case "hybrid":
      return vscode.l10n.t(
        "A bench with `subenvs` cannot also define its own `agents` — a composition level is a pure subsystem, which QuickUVM requires. Remove the agents (or the subenvs)."
      );
    case "port-claimed":
      return vscode.l10n.t(
        'Port "{0}" already belongs to agent "{1}" — a pin belongs to a single agent',
        String(p.port),
        String(p.agent)
      );
    case "port-orphan":
      return vscode.l10n.t(
        'Port "{0}" no longer exists on module "{1}" — marked orphan, not deleted automatically',
        String(p.port),
        String(p.dut)
      );
    case "width-mismatch":
      return vscode.l10n.t(
        'Width of "{0}" is {1} in YAML, but {2} in the design',
        String(p.port),
        String(p.declared),
        String(p.expected)
      );
    case "ignored-and-mapped":
      return vscode.l10n.t(
        'Port "{0}" is both ignored and in agent "{1}"',
        String(p.port),
        String(p.agent)
      );
  }
}
