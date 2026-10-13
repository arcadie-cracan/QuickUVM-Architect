// The generated code next to the diagram (docs/08 R20) — the host side of
// src/trace.ts: the selection in the TB view lights the element's lines in the
// VISIBLE generated editors (the aggregate files; an owned file IS the element),
// optionally opens its primary file in a preview tab beside the diagram ("the
// code view follows the selection", HDL Coder's Code view), every generated
// file gets CodeLenses back to the verification view, and the traceability
// report is a read-only virtual markdown document. Nothing here opens a tab
// without the user's say-so: the follow mode is a setting, off by default.

import * as path from "path";
import * as vscode from "vscode";
import type { Manifest } from "./genstate";
import { scoreboardNodeIds, type QuvmConfig } from "./quickuvm";
import type { ResolvedConfig } from "./resolved";
import { ownerOfFile, traceLenses, traceLines, tracePattern, traceReport } from "./trace";

export const TRACE_SCHEME = "quickuvm-trace";

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
  /** the files an element OWNS (R15's mapping: `cov:<a>` and the agent internals included) */
  ownedFiles: (nodeId: string) => { file: string; exists: boolean }[] | null;
  resolved: () => ResolvedConfig | null;
  config: () => QuvmConfig;
  configPath: () => string | undefined;
}

export class TraceService
  implements vscode.Disposable, vscode.CodeLensProvider, vscode.TextDocumentContentProvider
{
  /** one decoration type, like the YAML link's: whole lines, the range-highlight colour */
  private readonly deco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly docEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.docEmitter.event;
  private readonly reports = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lit = new Set<vscode.TextEditor>();
  /** the selected TB element and its identifier pattern (null = nothing selected) */
  private current: { nodeId: string; pattern: RegExp | null } | null = null;

  constructor(private readonly deps: TraceDeps) {
    this.disposables.push(
      // by pattern, not language: without a SystemVerilog extension `.sv/.svh`
      // have no language id; the provider checks the output dir itself
      vscode.languages.registerCodeLensProvider([{ scheme: "file", pattern: "**/*.{sv,svh}" }], this),
      vscode.workspace.registerTextDocumentContentProvider(TRACE_SCHEME, this),
      // a newly visible editor gets its lines lit; no reveal (not a selection)
      vscode.window.onDidChangeVisibleTextEditors(() => this.apply(false)),
      this.deco,
      this.lensEmitter,
      this.docEmitter
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.reports.get(uri.toString()) ?? "";
  }

  /** the manifest or the resolve changed: the lenses are recomputed on demand */
  refresh(): void {
    this.lensEmitter.fire();
    this.apply(false);
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
    // a cross-block scoreboard is drawn as `xsb:<n>` at the testbench level; the
    // manifest's owner maps to `sb:<n>` (the local one) — the config decides
    const cross = new Set(
      scoreboardNodeIds(this.deps.config())
        .filter((n): n is { id: string; cross: boolean } => Boolean(n && n.cross))
        .map((n) => n.id)
    );
    return lenses.map((l) => {
      const id = l.nodeId.startsWith("sb:") && cross.has(`x${l.nodeId}`) ? `x${l.nodeId}` : l.nodeId;
      // every lens target lives at the env level (agents, their coverage, the
      // scoreboards, the vsqr, the probes); a cross-block scoreboard at the root
      const focus = id.startsWith("xsb:") ? "" : "env";
      return new vscode.CodeLens(new vscode.Range(l.line, 0, l.line, 0), {
        title: l.inferred
          ? vscode.l10n.t("↖ {0} — inferred by quick-uvm, not in the YAML", l.label)
          : vscode.l10n.t("↖ {0} in the verification view", l.label),
        command: "quickuvm.revealTbComponent",
        arguments: [focus, id],
      });
    });
  }

  /**
   * The diagram's selection changed. One TB element: its lines light up in the
   * visible generated editors (the first revealed) and, in follow mode, its
   * primary file opens beside. Anything else clears.
   */
  select(ids: readonly string[], tb: boolean): void {
    if (!tb || ids.length !== 1) {
      this.current = null;
      this.clear();
      return;
    }
    const m = this.deps.manifest();
    this.current = { nodeId: ids[0], pattern: m ? tracePattern(m, ids[0]) : null };
    this.apply(true);
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

  /** lights the lines in the visible aggregate files; `reveal` only on a selection —
   *  a tab opening or a manifest refresh must not yank the scroll of a file being read */
  private apply(reveal: boolean): void {
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
      if (reveal) {
        editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
  }

  private clear(): void {
    const visible = new Set(vscode.window.visibleTextEditors);
    for (const e of this.lit) {
      if (visible.has(e)) {
        e.setDecorations(this.deco, []); // a closed editor only logs a warning
      }
    }
    this.lit.clear();
  }

  /** the element's primary generated file — or, for the ids the manifest does
   *  not own directly (`cov:<a>`, the agent internals), its first owned file —
   *  in a PREVIEW tab beside the diagram (the next selection replaces it),
   *  focus kept on the diagram */
  private async follow(nodeId: string): Promise<void> {
    let target = this.deps.primaryFile(nodeId);
    if (!target) {
      const out = this.deps.outDir();
      const first = this.deps.ownedFiles(nodeId)?.[0];
      target = out && first ? path.join(out, first.file) : null;
    }
    if (!target) {
      return;
    }
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(target), {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        preview: true,
      });
    } catch {
      // not generated yet: the badge and the card already say so
    }
  }

  /** the traceability report: a read-only virtual markdown document (no dirty
   *  untitled buffer, no save prompt), rendered as a markdown preview when the
   *  built-in markdown extension answers, else opened as text */
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
    const name = cfgPath ? path.basename(cfgPath) : "configuration";
    const text = traceReport(m, this.deps.resolved(), this.deps.present() ?? null, name);
    const uri = vscode.Uri.from({ scheme: TRACE_SCHEME, path: `/Traceability — ${name}.md` });
    this.reports.set(uri.toString(), text);
    this.docEmitter.fire(uri); // a report already open re-renders with the new text
    await vscode.workspace.openTextDocument(uri);
    try {
      await vscode.commands.executeCommand("markdown.showPreview", uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: true });
    }
  }

  dispose(): void {
    this.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
