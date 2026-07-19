// Serviciul sidecar-ului de layout (docs/04): incarcare la activare,
// scriere atomica (temp + rename, coalescata), watcher pentru editari
// externe (git checkout, editare manuala) si invalidare gratioasa la
// fiecare model nou. Host-ul e singura autoritate pe fisier; webview-ul
// primeste continutul prin `layout/full` si cere mutatii prin mesajele
// `layout/snapshot` / `fold/toggled` / `node/flipped` / `net/render` (docs/05).

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
/** fereastra in care evenimentele watcher-ului sunt considerate propriile
 *  noastre scrieri, nu editari externe */
const SELF_WRITE_MS = 1500;

export class LayoutStore implements vscode.Disposable {
  private data: SidecarData = emptySidecar();
  private readonly changeEmitter = new vscode.EventEmitter<SidecarData>();
  /** sidecar schimbat din afara gestului curent (extern, invalidare, curatare) */
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

  // ------------------------------------------------------- mutatii cerute

  /** snapshot-ul pozitiilor intregii vederi (docs/04): drag-end si pin-uirea
   *  elementelor fara samanta dintr-o vedere aranjata */
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

  /** nivelul 4 (docs/04): fir <-> eticheta per net; alegerea egala cu
   *  sugestia din model sterge override-ul */
  netRender(viewId: string, net: string, render: "wire" | "label"): void {
    const suggestion =
      this.model?.views[viewId]?.nets.find((n) => n.name === net)?.render ??
      "wire";
    setNetRender(this.data, viewId, net, render, suggestion);
    this.scheduleSave();
  }

  /** "Re-aranjeaza tot": pozitiile vederii dispar, pliaje/rasturnari raman */
  relayout(viewId: string): void {
    clearPositions(this.data, viewId);
    this.scheduleSave();
  }

  /** comanda "Clean Orphaned Layout Overrides"; intoarce cate erau */
  cleanOrphans(): number {
    const n = this.data.orphans.length;
    if (n) {
      cleanOrphans(this.data);
      this.scheduleSave();
      this.changeEmitter.fire(this.data);
    }
    return n;
  }

  /** model nou: invalidare gratioasa (docs/04) — orfanele migreaza, nu se sterg */
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

  // ------------------------------------------------------------- fisierul

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
      // fisier corupt sau versiune necunoscuta: nu-l suprascriem orbeste —
      // il pastram ca .bak si pornim curat (invalidare gratioasa si aici)
      const bak = `${file}.bak`;
      try {
        fs.copyFileSync(file, bak);
      } catch {
        /* pastrarea .bak e best-effort */
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

  /** scriere atomica, coalescata: temp + rename (rename suprascrie pe Windows
   *  prin MOVEFILE_REPLACE_EXISTING, deci cititorii nu vad fisiere partiale) */
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
      return; // cale absoluta in afara workspace-ului: fara watcher
    }
    const rel = path.relative(root.uri.fsPath, file).replace(/\\/g, "/");
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, rel)
    );
    const external = (): void => {
      if (Date.now() - this.lastWrite < SELF_WRITE_MS) {
        return; // propria noastra scriere
      }
      this.load();
      if (this.model) {
        this.setModel(this.model); // re-valideaza contra modelului curent
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
      this.save(); // nu pierdem ultima mutatie la inchidere
    }
    this.watcher?.dispose();
    this.changeEmitter.dispose();
  }
}
