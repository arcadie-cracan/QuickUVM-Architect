// The diagram <-> YAML link on the host (docs/08 R4).
//
// The YAML is the source of truth, but until now a gesture's effect landed in it
// invisibly: the user saw the diagram re-render and nothing else. This module
// closes the evaluation gap without touching the mutations:
//
//   afterGesture  — the lines a gesture changed flash in every visible text editor
//                   of the config (the minimal edit from src/textedit.ts gives the
//                   range); when no text editor shows the file, the
//                   `quickuvm.openYamlBeside` setting decides — ask once, always,
//                   never — whether to open one to the side;
//   openBeside    — the "YAML" button / command: the config as text, to the side,
//                   without stealing the focus;
//   revealElement — diagram -> text: a selected box reveals and flashes its YAML
//                   entry in the visible editors (Android's Split view, Umple);
//
// and the reverse direction (text -> diagram halo) is driven from extension.ts
// through `elementAtOffset` + the existing `probe/highlight` message. Nothing here
// opens a tab without the user's say-so, and nothing moves the caret.

import * as vscode from "vscode";
import { elementRange, type YamlSpan } from "./yamlmap";

export type OpenYamlBeside = "ask" | "always" | "never";

function setting(): OpenYamlBeside {
  const v = vscode.workspace.getConfiguration("quickuvm").get<string>("openYamlBeside", "ask");
  return v === "always" || v === "never" ? v : "ask";
}

export class YamlLink implements vscode.Disposable {
  /** one decoration type, shared by every flash (like the hover peek) */
  private readonly deco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  private readonly lit = new Set<vscode.TextEditor>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** the one-time question of `openYamlBeside: ask` was put this session */
  private asked = false;

  /** the visible TEXT editors of a file (the custom editor is not one) */
  private editorsOf(uri: vscode.Uri): vscode.TextEditor[] {
    const key = uri.toString();
    return vscode.window.visibleTextEditors.filter(
      (e) => e.document.uri.toString() === key
    );
  }

  /**
   * After a gesture changed `span` (offsets in the NEW text): flash it where the
   * file is visible as text; otherwise, per the setting, open the file to the
   * side first. Never steals the focus — the user is still on the diagram.
   */
  async afterGesture(uri: vscode.Uri, span: YamlSpan, version?: number): Promise<void> {
    let editors = this.editorsOf(uri);
    if (!editors.length) {
      const mode = setting();
      if (mode === "never" || (mode === "ask" && !(await this.askOnce()))) {
        return;
      }
      // the question may have waited while more gestures landed: the span belongs
      // to the document version that produced it — open beside regardless, but
      // flash only if nothing moved since (the merge review)
      const doc = await vscode.workspace.openTextDocument(uri);
      if (version !== undefined && doc.version !== version) {
        await this.openBeside(uri);
        return;
      }
      const opened = await this.openBeside(uri, span);
      editors = opened ? [opened] : [];
    }
    for (const e of editors) {
      this.flash(e, span);
    }
  }

  /** the one-time question; "Always"/"Never" persist to the user settings */
  private async askOnce(): Promise<boolean> {
    if (this.asked) {
      return false;
    }
    this.asked = true;
    const open = vscode.l10n.t("Open beside");
    const always = vscode.l10n.t("Always");
    const never = vscode.l10n.t("Never");
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Show the YAML as the diagram changes it? The lines a gesture edits are highlighted in the text editor."
      ),
      open,
      always,
      never
    );
    if (pick === always || pick === never) {
      await vscode.workspace
        .getConfiguration("quickuvm")
        .update("openYamlBeside", pick === always ? "always" : "never", vscode.ConfigurationTarget.Global);
    }
    return pick === open || pick === always;
  }

  /** the config as TEXT, to the side of the diagram, focus kept where it is */
  async openBeside(uri: vscode.Uri, span?: YamlSpan): Promise<vscode.TextEditor | undefined> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const existing = this.editorsOf(uri)[0];
    const selection = span
      ? new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end))
      : undefined;
    if (existing) {
      if (selection) {
        existing.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      return existing;
    }
    return vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
      preview: false,
      selection,
    });
  }

  /** diagram -> text: reveal + flash the YAML entry of a TB element id, only in
   *  editors that already show the file (non-invasive, like the hover peek) */
  revealElement(uri: vscode.Uri, text: string, id: string): void {
    const editors = this.editorsOf(uri);
    if (!editors.length) {
      return;
    }
    const span = elementRange(text, id);
    if (!span) {
      return; // a ghost, a level node, a renamed element: nothing to point at
    }
    for (const e of editors) {
      this.flash(e, span);
    }
  }

  /** a transient whole-line highlight (~1.5 s), revealed if off-screen */
  private flash(editor: vscode.TextEditor, span: YamlSpan): void {
    const doc = editor.document;
    const range = new vscode.Range(
      doc.positionAt(Math.min(span.start, doc.getText().length)),
      doc.positionAt(Math.min(span.end, doc.getText().length))
    );
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.setDecorations(this.deco, [range]);
    this.lit.add(editor);
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.clear(), 1500);
  }

  private clear(): void {
    for (const e of this.lit) {
      e.setDecorations(this.deco, []);
    }
    this.lit.clear();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.clear();
    this.deco.dispose();
  }
}
