// The sidebar "Properties" view (docs/07 UX slice 2): the config-editing half of the
// inspector, sitting under the Hierarchy and Verification trees instead of inside the
// diagram panel. It renders `dist/properties.js` — the inspector WITHOUT the diagram
// (83 KB against the panel's 3.6 MB), which is why the inspector was extracted first.
//
// The view is stateless: the host pushes the same config/overlay/selection messages
// the panel gets, and the view's edits come back as ordinary `action/request`
// messages, so every editor works exactly as it did in the aside.

import * as vscode from "vscode";
import type { HostMessage, WebviewMessage } from "./protocol";

export class PropertiesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "quickuvm.properties";

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** the current state to push at (re)open — the view can be created long after
     *  the config was loaded, so it must be able to catch up on its own */
    private readonly snapshot: () => HostMessage[],
    /** an editing gesture from the view (the same protocol the panel uses) */
    private readonly onMessage: (m: WebviewMessage) => void
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: WebviewMessage) => {
      if (m?.type === "ready") {
        // the view (re)mounted: replay the current state rather than waiting for the
        // next config change, which may never come
        this.replay();
        return;
      }
      this.onMessage(m);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.replay();
      }
    });
  }

  /** Push one message to the view (no-op when it was never opened). */
  post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private replay(): void {
    for (const m of this.snapshot()) {
      this.post(m);
    }
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "properties.js")
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview.css")
    );
    const nonce = nonceString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>QuickUVM Architect</title>
</head>
<body class="sidebar">
<aside id="inspector"></aside>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function nonceString(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
