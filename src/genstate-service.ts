// Host service for the "not generated" decoration (docs/07 line 1): runs
// `quick-uvm manifest -c <yaml> -o <outDir>` (QuickUVM >= 1.1.0), derives the
// ungenerated element ids (pure `genstate.ts`), and exposes them + a change event.
// Recomputes on config change, on generate completion, and on output-dir file
// changes (a debounced watcher, so manual deletes/regens are picked up too).

import * as path from "path";
import * as vscode from "vscode";
import { invokeQuickUvm } from "./generate";
import { Manifest, ungeneratedNodeIds } from "./genstate";

export class GenStateService implements vscode.Disposable {
  private _ungenerated = new Set<string>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private lastConfig: vscode.Uri | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private watchedDir: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly log: vscode.OutputChannel) {}

  get ungenerated(): ReadonlySet<string> {
    return this._ungenerated;
  }

  /** Recompute from the manifest for `configUri` (the active config). No config =>
   *  nothing ungenerated. */
  async refresh(configUri: vscode.Uri | undefined): Promise<void> {
    this.lastConfig = configUri;
    if (!configUri) {
      this.set(new Set());
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0];
    const cfg = vscode.workspace.getConfiguration("quickuvm", root?.uri);
    const outDir = cfg.get<string>("outputDir", "tb");
    const cwd = root?.uri.fsPath ?? path.dirname(configUri.fsPath);
    const abs = path.isAbsolute(outDir) ? outDir : path.join(cwd, outDir);
    this.retarget(abs);

    const r = await invokeQuickUvm(
      ["manifest", "-c", configUri.fsPath, "-o", outDir],
      cwd,
      cfg
    );
    if (r.code !== 0 || !r.out.trim()) {
      // manifest failed (e.g. invalid config, or quick-uvm < 1.1.0) — decorate
      // nothing rather than guess; the log has the reason.
      if (r.err.trim()) {
        this.log.appendLine(`[genstate] ${r.err.trim()}`);
      }
      this.set(new Set());
      return;
    }
    try {
      this.set(ungeneratedNodeIds(JSON.parse(r.out) as Manifest));
    } catch (e) {
      this.log.appendLine(`[genstate] could not parse manifest JSON: ${String(e)}`);
      this.set(new Set());
    }
  }

  private set(next: Set<string>): void {
    // only fire when the set actually changed (avoids redundant tree redraws)
    if (
      next.size === this._ungenerated.size &&
      [...next].every((id) => this._ungenerated.has(id))
    ) {
      return;
    }
    this._ungenerated = next;
    this.emitter.fire();
  }

  /** (Re)watch the output dir; a debounced change recomputes from the last config. */
  private retarget(absDir: string): void {
    if (this.watchedDir === absDir) {
      return;
    }
    this.watcher?.dispose();
    this.watchedDir = absDir;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(absDir, "**")
    );
    const bounce = (): void => {
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.timer = setTimeout(() => void this.refresh(this.lastConfig), 300);
    };
    this.watcher.onDidCreate(bounce);
    this.watcher.onDidDelete(bounce);
    // onDidChange is intentionally NOT watched: a file's content changing does not
    // change its existence, and generate touches every file (would thrash).
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.watcher?.dispose();
    this.emitter.dispose();
  }
}
