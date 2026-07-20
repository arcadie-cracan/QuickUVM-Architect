// The layout sidecar service (docs/04): load on activation,
// atomic write (temp + rename, coalesced), watcher for external
// edits (git checkout, manual editing) and graceful invalidation on
// every new model. The host is the sole authority on the file; the webview
// receives the content through `layout/full` and requests mutations through the
// `layout/snapshot` / `fold/toggled` / `node/flipped` / `net/render` messages (docs/05).

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ProjectModel } from "./model";
import type { SidecarData } from "./protocol";
import {
  cleanOrphans,
  clearPositions,
  emptySidecar,
  invalidate,
  parseSidecar,
  serializeSidecar,
  setFlip,
  setFold,
  setNetRender,
  setPositions,
} from "./sidecarops";

const DEFAULT_PATH = ".vscode/quickuvm-architect.yaml";
/** the window during which the watcher's events are considered our own
 *  writes, not external edits */
const SELF_WRITE_MS = 1500;

export class LayoutStore implements vscode.Disposable {
  private data: SidecarData = emptySidecar();
  private readonly changeEmitter = new vscode.EventEmitter<SidecarData>();
  /** sidecar changed from outside the current gesture (external, invalidation, cleanup) */
  readonly onExternalChange = this.changeEmitter.event;

  private watcher: vscode.FileSystemWatcher | undefined;
  private lastWrite = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private model: ProjectModel | undefined;

  constructor(private readonly log: vscode.OutputChannel) {
    this.load();
    this.watch();
  }

  get sidecar(): SidecarData {
    return this.data;
  }

  // ------------------------------------------------------- requested mutations

  /** the position snapshot of the whole view (docs/04): drag-end and pinning
   *  the seedless elements of an arranged view */
  positionsSnapshotted(
    viewId: string,
    nodes: Record<string, { x: number; y: number }>
  ): void {
    setPositions(this.data, viewId, nodes);
    this.scheduleSave();
  }

  foldToggled(viewId: string, foldId: string, collapsed: boolean): void {
    setFold(this.data, viewId, foldId, collapsed);
    this.scheduleSave();
  }

  nodeFlipped(
    viewId: string,
    nodeId: string,
    flipH: boolean,
    flipV: boolean
  ): void {
    setFlip(this.data, viewId, nodeId, flipH, flipV);
    this.scheduleSave();
  }

  /** level 4 (docs/04): wire <-> label per net; a choice equal to
   *  the model's suggestion deletes the override */
  netRender(viewId: string, net: string, render: "wire" | "label"): void {
    const suggestion =
      this.model?.views[viewId]?.nets.find((n) => n.name === net)?.render ??
      "wire";
    setNetRender(this.data, viewId, net, render, suggestion);
    this.scheduleSave();
  }

  /** "Re-arrange all": the view's positions disappear, folds/flips remain */
  relayout(viewId: string): void {
    clearPositions(this.data, viewId);
    this.scheduleSave();
  }

  /** the "Clean Orphaned Layout Overrides" command; returns how many there were */
  cleanOrphans(): number {
    const n = this.data.orphans.length;
    if (n) {
      cleanOrphans(this.data);
      this.scheduleSave();
      this.changeEmitter.fire(this.data);
    }
    return n;
  }

  /** new model: graceful invalidation (docs/04) — the orphans migrate, they are not deleted */
  setModel(model: ProjectModel): void {
    this.model = model;
    const today = new Date().toISOString().slice(0, 10);
    if (invalidate(this.data, model, today)) {
      this.log.appendLine(
        `[layout] graceful invalidation: ${this.data.orphans.length} orphan(s)`
      );
      this.scheduleSave();
      this.changeEmitter.fire(this.data);
    }
  }

  // ------------------------------------------------------------- the file

  private filePath(): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return undefined;
    }
    const cfg = vscode.workspace.getConfiguration("quickuvm", root.uri);
    const rel = cfg.get<string>("layoutFile", "").trim() || DEFAULT_PATH;
    return path.isAbsolute(rel) ? rel : path.join(root.uri.fsPath, rel);
  }

  private load(): void {
    const file = this.filePath();
    if (!file || !fs.existsSync(file)) {
      this.data = emptySidecar();
      return;
    }
    try {
      this.data = parseSidecar(fs.readFileSync(file, "utf8"));
      this.log.appendLine(
        `[layout] loaded ${file}: ${Object.keys(this.data.views).length} view(s), ` +
          `${this.data.orphans.length} orphan(s)`
      );
    } catch (e) {
      // corrupt file or unknown version: we do not overwrite it blindly —
      // we keep it as .bak and start clean (graceful invalidation here too)
      const bak = `${file}.bak`;
      try {
        fs.copyFileSync(file, bak);
      } catch {
        /* keeping the .bak is best-effort */
      }
      this.log.appendLine(`[layout] unreadable sidecar (${String(e)}); kept as ${bak}`);
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "QuickUVM Architect: the layout file could not be read and was backed up as {0}.",
          path.basename(bak)
        )
      );
      this.data = emptySidecar();
    }
  }

  /** atomic, coalesced write: temp + rename (rename overwrites on Windows
   *  via MOVEFILE_REPLACE_EXISTING, so readers do not see partial files) */
  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.save(), 250);
  }

  private save(): void {
    const file = this.filePath();
    if (!file) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, serializeSidecar(this.data), "utf8");
      this.lastWrite = Date.now();
      fs.renameSync(tmp, file);
    } catch (e) {
      this.log.appendLine(`[layout] write failed: ${String(e)}`);
    }
  }

  private watch(): void {
    const root = vscode.workspace.workspaceFolders?.[0];
    const file = this.filePath();
    if (!root || !file || !file.startsWith(root.uri.fsPath)) {
      return; // absolute path outside the workspace: no watcher
    }
    const rel = path.relative(root.uri.fsPath, file).replace(/\\/g, "/");
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, rel)
    );
    const external = (): void => {
      if (Date.now() - this.lastWrite < SELF_WRITE_MS) {
        return; // our own write
      }
      this.load();
      if (this.model) {
        this.setModel(this.model); // re-validate against the current model
      }
      this.changeEmitter.fire(this.data);
    };
    this.watcher.onDidChange(external);
    this.watcher.onDidCreate(external);
    this.watcher.onDidDelete(external);
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.save(); // do not lose the last mutation on close
    }
    this.watcher?.dispose();
    this.changeEmitter.dispose();
  }
}
