// Host service for the "not generated" / "stale" decoration (docs/07 line 1):
// - runs `quick-uvm manifest -c <yaml>` (QuickUVM >= 1.1.0) for the element → files
//   map, CACHED and re-run only on config change (the file list only changes then);
// - stats those files + the config IN-PROCESS on every recompute (cheap, no
//   subprocess), so both `missing` (absent) and `stale` (older than the config) are
//   derived by the pure `classify` (genstate.ts);
// - recomputes on config change, generate completion, and output-dir file changes
//   (a debounced watcher, so manual deletes/regens are picked up too).

import * as path from "path";
import * as vscode from "vscode";
import { invokeQuickUvm } from "./generate";
import {
  classify,
  ElementStates,
  Manifest,
  primaryFile,
  scopedFilesFor,
} from "./genstate";

export class GenStateService implements vscode.Disposable {
  private _states: ElementStates = { missing: new Set(), stale: new Set() };
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private config: vscode.Uri | undefined;
  private manifest: Manifest | undefined; // cached; refreshed on config change
  private outDirAbs: string | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly log: vscode.OutputChannel) {}

  get missing(): ReadonlySet<string> {
    return this._states.missing;
  }
  get stale(): ReadonlySet<string> {
    return this._states.stale;
  }

  /** docs/07 line 2 — the output files to regenerate for one element (`agent:cmd`,
   *  `sb:sbd`, `probes`, `vsqr`): its OWN files plus the `aggregate` co-regen set.
   *  Appending the aggregates always is the safe default — any structural change
   *  (add/remove/rename) needs them, and they are a handful of cheap files. `null`
   *  if the manifest is unavailable or the element is unknown. */
  scopedFiles(nodeId: string): string[] | null {
    return this.manifest ? scopedFilesFor(this.manifest, nodeId) : null;
  }

  /** The absolute path of the representative file to OPEN for an element (2.3),
   *  or null if unavailable. */
  primaryFilePath(nodeId: string): string | null {
    if (!this.manifest || !this.outDirAbs) {
      return null;
    }
    const f = primaryFile(this.manifest, nodeId);
    return f ? path.join(this.outDirAbs, f) : null;
  }

  /** The config changed (or first load): re-run the manifest, then recompute. */
  async refresh(configUri: vscode.Uri | undefined): Promise<void> {
    this.config = configUri;
    if (!configUri) {
      this.manifest = undefined;
      this.set({ missing: new Set(), stale: new Set() });
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0];
    const cfg = vscode.workspace.getConfiguration("quickuvm", root?.uri);
    const outDir = cfg.get<string>("outputDir", "tb");
    const cwd = root?.uri.fsPath ?? path.dirname(configUri.fsPath);
    this.outDirAbs = path.isAbsolute(outDir) ? outDir : path.join(cwd, outDir);
    this.retarget(this.outDirAbs);

    const r = await invokeQuickUvm(["manifest", "-c", configUri.fsPath], cwd, cfg);
    if (r.code !== 0 || !r.out.trim()) {
      // manifest failed (invalid config, or quick-uvm < 1.1.0) — decorate nothing.
      if (r.err.trim()) {
        this.log.appendLine(`[genstate] ${r.err.trim()}`);
      }
      this.manifest = undefined;
      this.set({ missing: new Set(), stale: new Set() });
      return;
    }
    try {
      this.manifest = JSON.parse(r.out) as Manifest;
    } catch (e) {
      this.log.appendLine(`[genstate] could not parse manifest JSON: ${String(e)}`);
      this.manifest = undefined;
      this.set({ missing: new Set(), stale: new Set() });
      return;
    }
    await this.recompute();
  }

  /** Re-stat the generated files + config against the CACHED manifest (no
   *  subprocess). Called on generate completion and output-dir changes. */
  async recompute(): Promise<void> {
    if (!this.manifest || !this.config || !this.outDirAbs) {
      return;
    }
    const configMtime = await this.mtime(this.config);
    const files = new Set(
      this.manifest.elements.flatMap((e) => e.files.map((f) => f.file))
    );
    const mtimes = new Map<string, number>();
    for (const f of files) {
      const m = await this.mtime(vscode.Uri.file(path.join(this.outDirAbs, f)));
      if (m !== null) {
        mtimes.set(f, m);
      }
    }
    this.set(classify(this.manifest, mtimes, configMtime ?? 0));
  }

  private async mtime(uri: vscode.Uri): Promise<number | null> {
    try {
      return (await vscode.workspace.fs.stat(uri)).mtime;
    } catch {
      return null; // does not exist
    }
  }

  private set(next: ElementStates): void {
    if (eqSet(next.missing, this._states.missing) && eqSet(next.stale, this._states.stale)) {
      return; // no change — avoid a redundant tree/diagram redraw
    }
    this._states = next;
    this.emitter.fire();
  }

  /** (Re)watch the output dir; a debounced create/delete recomputes. */
  private retarget(absDir: string): void {
    if (this.watcher && this.outDirAbs === absDir) {
      return;
    }
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(absDir, "**")
    );
    const bounce = (): void => {
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.timer = setTimeout(() => void this.recompute(), 300);
    };
    this.watcher.onDidCreate(bounce);
    this.watcher.onDidDelete(bounce);
    this.watcher.onDidChange(bounce); // a rewrite changes mtime → may clear `stale`
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.watcher?.dispose();
    this.emitter.dispose();
  }
}

function eqSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}
