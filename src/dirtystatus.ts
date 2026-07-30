// "Config unsaved" status-bar indicator.
//
// Every diagram gesture applies a WorkspaceEdit and leaves the document DIRTY on
// purpose (config.ts: "the user decides"). That is fine for undo/redo, but the
// manifest, the U/M generation badges and quick-uvm itself all read the file from
// DISK — so an unsaved config makes the tooling quietly disagree with the screen.
//
// VS Code offers no way for an extension to hook the window's close button (there is
// no onWillQuit/onWillClose API; `deactivate` cannot show UI or block), so a
// close-time warning is impossible from here. `files.hotExit: "off"` is the built-in
// way to get one. What an extension CAN do is make the state visible the whole time
// it lasts, which is what this is: a persistent, clickable reminder rather than a
// dialog at the moment the user is already leaving.

import * as vscode from "vscode";

export class DirtyConfigStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly configUri: () => vscode.Uri | undefined) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99
    );
    this.item.command = "quickuvm.saveConfig";
    // warningBackground rather than an error colour: an unsaved file is a state to
    // resolve, not a fault — and it is the user's own edit
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    this.subs.push(
      this.item,
      // a text edit is what makes it dirty; a save is what clears it. Both arrive as
      // document events, so no polling is needed.
      vscode.workspace.onDidChangeTextDocument((e) => this.onDoc(e.document)),
      vscode.workspace.onDidSaveTextDocument((d) => this.onDoc(d)),
      vscode.workspace.onDidOpenTextDocument((d) => this.onDoc(d)),
      vscode.workspace.onDidCloseTextDocument(() => this.refresh())
    );
    this.refresh();
  }

  /** Re-evaluate only when the event concerns the ACTIVE config. */
  private onDoc(doc: vscode.TextDocument): void {
    const uri = this.configUri();
    if (uri && doc.uri.toString() === uri.toString()) {
      this.refresh();
    }
  }

  /** Show the indicator iff the active config document exists and is dirty. */
  refresh(): void {
    const uri = this.configUri();
    const doc = uri
      ? vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === uri.toString()
        )
      : undefined;
    if (!doc?.isDirty) {
      this.item.hide();
      return;
    }
    const name = uri ? uri.path.split("/").pop() : "config";
    this.item.text = `$(circle-filled) ${vscode.l10n.t("QuickUVM: unsaved")}`;
    this.item.tooltip = vscode.l10n.t(
      "{0} has unsaved changes. Generation, the manifest and the U/M badges read the file from disk, so they do not see them yet. Click to save.",
      name ?? "config"
    );
    this.item.show();
  }

  dispose(): void {
    for (const s of this.subs) {
      s.dispose();
    }
  }
}
