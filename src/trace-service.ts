// The generated code next to the diagram (docs/08 R20) — the host side of
// src/trace.ts: the selection in the TB view lights the element's lines in the
// VISIBLE generated editors (the aggregate files; an owned file IS the element),
// optionally opens its primary file in a preview tab beside the diagram ("the
// code view follows the selection", HDL Coder's Code view), and every generated
// file gets CodeLenses back to the verification view. Nothing here opens a tab
// without the user's say-so: the follow mode is a setting, off by default.

import * as path from "path";
import * as vscode from "vscode";
import type { Manifest } from "./genstate";
import type { QuvmConfig } from "./quickuvm";
import type { ResolvedConfig } from "./resolved";
import { buildVTree } from "./tbtree-build";
import { ownerOfFile, traceLenses, traceLines, tracePattern, traceReport } from "./trace";

export function codeFollowSetting(): boolean {
  return vscode.workspace.getConfiguration("quickuvm").get<boolean>("codeFollowsSelection", false);
}

export interface TraceDeps {
  manifest: () => Manifest | undefined;
  /** the absolute output directory of the active bench */
  outDir: () => string | undefined;
  /** the files of the manifest that exist on disk, when known */
  present: () => ReadonlySet<string> | undefined;
  /** the absolute path of an element's representative generated file */
  primaryFile: (nodeId: string) => string | null;
  resolved: () => ResolvedConfig | null;
  config: () => QuvmConfig;
  configPath: () => string | undefined;
}

export class TraceService implements vscode.Disposable, vscode.CodeLensProvider {
  /** one decoration type, like the YAML link's: whole lines, the range-highlight colour */
  private readonly deco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lit = new Set<vscode.TextEditor>();
  /** the selected TB element and its identifier pattern (null = nothing selected) */
  private current: { nodeId: string; pattern: RegExp | null } | null = null;

  constructor(private readonly deps: TraceDeps) {
    this.disposables.push(
      // by pattern, not language: without a SystemVerilog extension `.sv/.svh`
      // have no language id; the provider checks the output dir itself
      vscode.languages.registerCodeLensProvider([{ scheme: "file", pattern: "**/*.{sv,svh}" }], this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.apply()),
      this.deco,
      this.lensEmitter
    );
  }

  /** the manifest or the resolve changed: the lenses are recomputed on demand */
  refresh(): void {
    this.lensEmitter.fire();
    this.apply();
  }

  /** the basename of a document that is a generated file of the active bench */
  private fileOf(doc: vscode.TextDocument): string | null {
    const out = this.deps.outDir();
    const m = this.deps.manifest();
    if (!out || !m || doc.uri.scheme !== "file") {
      return null;
    }
    const rel = path.relative(out, doc.uri.fsPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return null;
    }
    const name = path.basename(doc.uri.fsPath);
    return ownerOfFile(m, name) ? name : null;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const m = this.deps.manifest();
    const file = this.fileOf(doc);
    if (!m || !file) {
      return [];
    }
    const lenses = traceLenses(m, file, doc.getText(), this.deps.resolved());
    if (!lenses.length) {
      return [];
    }
    const tree = buildVTree(this.deps.config(), this.deps.configPath() ?? null);
    const focusOf = (nodeId: string): string => {
      for (const n of tree.byIdent.values()) {
        if (n.selectId === nodeId) {
          return n.focus;
        }
      }
      return "env";
    };
    return lenses.map(
      (l) =>
        new vscode.CodeLens(new vscode.Range(l.line, 0, l.line, 0), {
          title: l.inferred
            ? vscode.l10n.t("↖ {0} — inferred by quick-uvm, not in the YAML", l.label)
            : vscode.l10n.t("↖ {0} in the verification view", l.label),
          command: "quickuvm.revealTbComponent",
          arguments: [focusOf(l.nodeId), l.nodeId],
        })
    );
  }

  /**
   * The diagram's selection changed. One TB element: its lines light up in the
   * visible generated editors and, in follow mode, its primary file opens
   * beside. Anything else clears.
   */
  select(ids: readonly string[], tb: boolean): void {
    if (!tb || ids.length !== 1) {
      this.current = null;
      this.clear();
      return;
    }
    const m = this.deps.manifest();
    this.current = { nodeId: ids[0], pattern: m ? tracePattern(m, ids[0]) : null };
    this.apply();
    if (codeFollowSetting()) {
      void this.follow(ids[0]);
    }
  }

  /** the follow mode was just switched on: show the current selection's file */
  followNow(): void {
    if (this.current) {
      void this.follow(this.current.nodeId);
    }
  }

  private apply(): void {
    this.clear();
    const cur = this.current;
    const m = this.deps.manifest();
    if (!cur || !cur.pattern || !m) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      const file = this.fileOf(editor.document);
      // an owned file IS the element: every line would light — nothing to point at
      if (!file || ownerOfFile(m, file) !== "aggregate") {
        continue;
      }
      const lines = traceLines(editor.document.getText(), cur.pattern);
      if (!lines.length) {
        continue;
      }
      const ranges = lines
        .filter((l) => l < editor.document.lineCount)
        .map((l) => editor.document.lineAt(l).range);
      editor.setDecorations(this.deco, ranges);
      this.lit.add(editor);
      editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  private clear(): void {
    for (const e of this.lit) {
      e.setDecorations(this.deco, []);
    }
    this.lit.clear();
  }

  /** the element's primary generated file, in a PREVIEW tab beside the diagram
   *  (the next selection replaces it), focus kept on the diagram */
  private async follow(nodeId: string): Promise<void> {
    const primary = this.deps.primaryFile(nodeId);
    if (!primary) {
      return;
    }
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(primary), {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        preview: true,
      });
    } catch {
      // not generated yet: the badge and the card already say so
    }
  }

  /** the traceability report as a markdown document (untitled, preview) */
  async report(): Promise<void> {
    const m = this.deps.manifest();
    if (!m) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "QuickUVM Architect: no generation manifest — open a configuration (quick-uvm >= 1.1.0)."
        )
      );
      return;
    }
    const cfgPath = this.deps.configPath();
    const text = traceReport(
      m,
      this.deps.resolved(),
      this.deps.present() ?? null,
      cfgPath ? path.basename(cfgPath) : "configuration"
    );
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: text });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  dispose(): void {
    this.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
