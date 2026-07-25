// Host service for the "not generated" / "stale" decoration (docs/07 line 1):
// - runs `quick-uvm manifest -c <yaml>` (QuickUVM >= 1.1.0) for the element → files
//   map, CACHED and re-run only on config change (the file list only changes then);
// - checks those files' EXISTENCE in-process on every recompute (cheap, no
//   subprocess) and hashes the config, so both `missing` (absent) and `stale`
//   (generated from a different config content) are derived by the pure `classify`
//   (genstate.ts). Staleness needs the hash rather than mtimes because quick-uvm
//   does not rewrite files whose content is unchanged;
// - recomputes on config change, generate completion, and output-dir file changes
//   (a debounced watcher, so manual deletes/regens are picked up too).

import { createHash } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { invokeQuickUvm } from "./generate";
import {
  classify,
  declaredElements,
  ElementStates,
  Manifest,
  ownerToNodeId,
  primaryFile,
  scopedFilesFor,
} from "./genstate";
import type { QuvmConfig } from "./quickuvm";

/** workspaceState key holding, per config uri, the element → config-hash records */
const STORE_KEY = "quickuvm.genHash";

export class GenStateService implements vscode.Disposable {
  private _states: ElementStates = { unsaved: new Set(), missing: new Set(), stale: new Set() };
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private config: vscode.Uri | undefined;
  private manifest: Manifest | undefined; // cached; refreshed on config change
  private outDirAbs: string | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** element id → the config hash it was last generated FROM (persisted) */
  private genHash = new Map<string, string>();
  private configHash = "";
  /** the elements the IN-MEMORY config declares. The manifest is produced from the
   *  file on DISK, so between an edit and its save it does not know about a
   *  just-added component; this is what lets its badge appear immediately. */
  private declared: string[] = [];

  constructor(
    private readonly log: vscode.OutputChannel,
    private readonly memento?: vscode.Memento
  ) {}

  get unsaved(): ReadonlySet<string> {
    return this._states.unsaved;
  }
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
  async refresh(
    configUri: vscode.Uri | undefined,
    config?: QuvmConfig
  ): Promise<void> {
    this.config = configUri;
    this.declared = config ? declaredElements(config) : [];
    this.restore(); // the per-config generated-from hashes (survive a reload)
    if (!configUri) {
      this.manifest = undefined;
      this.set({ unsaved: new Set(), missing: new Set(), stale: new Set() });
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
      this.set({ unsaved: new Set(), missing: new Set(), stale: new Set() });
      return;
    }
    try {
      this.manifest = JSON.parse(r.out) as Manifest;
    } catch (e) {
      this.log.appendLine(`[genstate] could not parse manifest JSON: ${String(e)}`);
      this.manifest = undefined;
      this.set({ unsaved: new Set(), missing: new Set(), stale: new Set() });
      return;
    }
    await this.recompute();
  }

  /** Re-check the generated files' existence + the config hash against the CACHED
   *  manifest (no subprocess). Called on generate completion and output-dir changes. */
  async recompute(): Promise<void> {
    if (!this.manifest || !this.config || !this.outDirAbs) {
      return;
    }
    const files = new Set(
      this.manifest.elements.flatMap((e) => e.files.map((f) => f.file))
    );
    const present = new Set<string>();
    for (const f of files) {
      if (await this.exists(vscode.Uri.file(path.join(this.outDirAbs, f)))) {
        present.add(f);
      }
    }
    this.configHash = await this.hashOf(this.config);
    this.set(
      classify(
        this.manifest,
        present,
        this.genHash,
        this.configHash,
        this.declared
      )
    );
  }

  /**
   * Record that `nodeIds` ("all" = every decoratable element) were just generated
   * from the CURRENT config, so they stop being reported stale. Content-hash based:
   * a regeneration whose output is unchanged still clears the flag (quick-uvm does
   * not rewrite unchanged files, so mtimes cannot express this).
   */
  async markGenerated(nodeIds: readonly string[] | "all"): Promise<void> {
    const hash = (this.configHash = this.config
      ? await this.hashOf(this.config)
      : "");
    const ids =
      nodeIds === "all"
        ? [...new Set(
            (this.manifest?.elements ?? [])
              .map((e) => ownerToNodeId(e.owner))
              .filter((x): x is string => x !== null)
          )]
        : nodeIds;
    for (const id of ids) {
      this.genHash.set(id, hash);
    }
    await this.persist();
    await this.recompute();
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /** sha1 of the config's bytes — the identity of "what was generated from". */
  private async hashOf(uri: vscode.Uri): Promise<string> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return createHash("sha1").update(bytes).digest("hex");
    } catch {
      return "";
    }
  }

  /** the recorded hashes survive a reload (else the badge would forget) */
  private async persist(): Promise<void> {
    const key = this.config?.toString() ?? "";
    await this.memento?.update(STORE_KEY, {
      ...(this.memento.get<Record<string, Record<string, string>>>(STORE_KEY) ?? {}),
      [key]: Object.fromEntries(this.genHash),
    });
  }

  private restore(): void {
    const key = this.config?.toString() ?? "";
    const all =
      this.memento?.get<Record<string, Record<string, string>>>(STORE_KEY) ?? {};
    this.genHash = new Map(Object.entries(all[key] ?? {}));
  }

  private set(next: ElementStates): void {
    if (
      eqSet(next.unsaved, this._states.unsaved) &&
      eqSet(next.missing, this._states.missing) &&
      eqSet(next.stale, this._states.stale)
    ) {
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
    this.watcher.onDidChange(bounce); // a file re-appearing/vanishing under us
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
