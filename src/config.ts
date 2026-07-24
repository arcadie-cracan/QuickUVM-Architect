// The QuickUVM configuration service: discovers the YAML file, watches it,
// derives the overlay for the webview and validates YAML<->model as diagnostics.
// The YAML is the source of truth (invariant 2): the service keeps no state of its own —
// any action produces a WorkspaceEdit through `apply`, and the overlay is
// recomputed from the document's current text (including unsaved).

import * as path from "path";
import * as vscode from "vscode";
import { parseDocument } from "yaml";
import { checkConfig, Finding, WIDTH_CODE } from "./configcheck";
import { ProjectModel } from "./model";
import { AGENT_PALETTE, OverlayConfig, PortRole, StatusDeco } from "./protocol";
import { decosFromFindings } from "./status";
import { agentPorts, QuvmConfig } from "./quickuvm";
import { parseQuvm } from "./yamlops";
import { newConfigText, topConfigPaths } from "./yamlops";

// re-export: the width quick-fix code lives in the pure core
export { WIDTH_CODE } from "./configcheck";

/**
 * The minimal surface that the TB EDITING gestures (add/delete/edit) require from
 * a configuration source: the parsed config, the URI and a mutation `apply`
 * (slice 4). `ConfigService` satisfies it (the ACTIVE config), and the
 * per-file editor (`CustomTextEditor`) implements it on the open DOCUMENT — so
 * the gestures in `actions.ts` work identically on either, without duplication.
 */
export interface TbEditTarget {
  readonly current: QuvmConfig;
  readonly configUri: vscode.Uri | undefined;
  apply(mutate: (text: string) => string): Promise<boolean>;
}

const GLOB = "**/*.quickuvm.yaml";

export class ConfigService implements vscode.Disposable {
  private readonly overlayEmitter = new vscode.EventEmitter<OverlayConfig | null>();
  /** the overlay re-derived after any change to the YAML or the model */
  readonly onOverlay = this.overlayEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private model: ProjectModel | undefined;
  private uri: vscode.Uri | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** the last derived state, re-sent to the webview on `ready` */
  lastOverlay: OverlayConfig | null = null;
  /** the status decorations derived from the last validations (docs/05) */
  decorations: StatusDeco[] = [];
  /** the last parsed configuration (for commands and validations) */
  current: QuvmConfig = {};
  /** docs/07 P3c — the agents of each composed child block, keyed by subenv name.
   *  A cross-block scoreboard's endpoints are `<subenv>.<agent>`, and the child's
   *  agents live in ANOTHER file, so the endpoint picker cannot be derived from
   *  `current` alone. Empty for a leaf bench. */
  childAgents: Record<string, string[]> = {};

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
   * Finds the configuration file: the explicit setting, then glob.
   * Stability: the active configuration (`prev`) does NOT change as long as its
   * file exists — the creation of block configs by createSubenv (docs/03)
   * must not silently switch the active config (a real regression: the
   * `chan.quickuvm.yaml` scaffold wins alphabetically and "steals" the overlay and the actions).
   * On the initial choice among multiple files, those referenced as
   * `subenvs[].config` by another file (the children) are excluded.
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
      return prev; // stability: the active file still exists
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
   * The configuration file, created when needed (the first configuration action).
   * The new name: `<modulDut>.quickuvm.yaml` in the workspace root.
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
   * Creates (if missing) and ACTIVATES the config dedicated to a module —
   * the recursive flow of the composition (docs/03): each level has its own file.
   * Activation is per-session (stable discovery keeps it while the file
   * exists); for persistence across sessions: quickuvm.configFile or
   * the "Choose Active Config" command.
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

  /** All the *.quickuvm.yaml files in the workspace (for chooseConfig). */
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
   * Applies a yamlops mutation on the current text, as a single WorkspaceEdit
   * (native undo/redo). The document stays unsaved — the user decides.
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
      // synchronous, not debounced: callers read `current` right after apply
      // (checkDut after "Set this module as DUT" silently aborted on stale state —
      // a real regression caught during validation on common_cells)
      await this.refresh();
    }
    return ok;
  }

  /** Re-derives the overlay and the diagnostics from the current YAML and model. */
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
      // deleted or unreadable file: the configuration disappears, and so does the overlay
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
    await this.loadChildAgents();
    // the validation core is PURE (configcheck.ts, tested); here we only map
    // findings -> vscode.Diagnostic with the localized messages (D19)
    const res = checkConfig(ydoc, this.current, this.model);
    // the status decorations for the diagram (docs/05): pure derivation from
    // the same findings; extension.ts posts them at onOverlay
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
    for (const p of cfg.dut?.unverified_ports ?? []) {
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

  /**
   * Reads each `subenvs[].config` child and records its agent names (docs/07 P3c).
   * The paths are relative to THIS config's directory, which is how QuickUVM
   * resolves them. An unreadable or invalid child contributes nothing rather than
   * failing the refresh — composition is edited incrementally, so a child that does
   * not parse yet is a normal intermediate state.
   */
  private async loadChildAgents(): Promise<void> {
    const subenvs = this.current.subenvs ?? [];
    const next: Record<string, string[]> = {};
    if (subenvs.length && this.uri) {
      const dir = vscode.Uri.joinPath(this.uri, "..");
      for (const sub of subenvs) {
        if (!sub.name || !sub.config) {
          continue;
        }
        try {
          const child = await vscode.workspace.openTextDocument(
            vscode.Uri.joinPath(dir, sub.config)
          );
          const names = (parseQuvm(child.getText()).agents ?? [])
            .map((a) => a.name)
            .filter((n): n is string => Boolean(n));
          if (names.length) {
            next[sub.name] = names;
          }
        } catch {
          // missing/unparseable child: no endpoints from it (see the doc comment)
        }
      }
    }
    this.childAgents = next;
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

/** The "update the width to N" quick-fix (docs/03), on the WIDTH_CODE diagnostic. */
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

// ------------------------------------------------------------------ utilities

function diag(
  range: vscode.Range,
  message: string,
  severity: vscode.DiagnosticSeverity
): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, message, severity);
  d.source = "quickuvm/config";
  return d;
}

/** The localized message of a finding from the pure core (l10n stays here, D19). */
function findingMessage(f: Finding): string {
  const p = f.params;
  switch (f.kind) {
    case "dut-missing":
      return vscode.l10n.t(
        'Module "{0}" does not exist in the current design',
        String(p.module)
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
