// The generation-state badges on the verification-hierarchy tree (docs/07 line 1).
//
// The vocabulary is deliberately VS Code's own, so nothing has to be learned:
//
//   ●  green   unsaved       the mark VS Code puts on a dirty editor tab
//   U  amber   not generated git's "untracked": it exists, the tool has no record
//   M  blue    stale         git's "modified": recorded, but changed since
//
// Colour carries it at a glance and the badge is the fallback — in High Contrast
// themes VS Code flattens decoration colours, and colour alone is unreadable for
// colour-blind users, so neither channel is allowed to be load-bearing on its own.
//
// A `FileDecorationProvider` badges the tree items, driven by the generation-state
// service. The tree items carry
// a synthetic `quvm-gen://element/<id>` resourceUri (set in tbtree.ts) so the
// provider can match them without touching the real filesystem.

import * as vscode from "vscode";

const GEN_SCHEME = "quvm-gen";

/** The synthetic resourceUri for a verification element id (`agent:cmd`, `sb:sbd`,
 *  `probes`, `vsqr`, …). Encoded in the path so the provider can decode it back. */
export function genElementUri(elementId: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GEN_SCHEME,
    path: "/" + encodeURIComponent(elementId),
  });
}

export class GenDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(
    private readonly unsaved: () => ReadonlySet<string>,
    private readonly missing: () => ReadonlySet<string>,
    private readonly stale: () => ReadonlySet<string>
  ) {}

  /** Re-query every decoration (a state set changed). */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== GEN_SCHEME) {
      return undefined;
    }
    const elementId = decodeURIComponent(uri.path.replace(/^\//, ""));
    // most urgent first: unsaved > not generated > stale
    if (this.unsaved().has(elementId)) {
      return {
        badge: "●",
        tooltip: vscode.l10n.t("New — not saved to the configuration yet"),
        color: new vscode.ThemeColor("gitDecoration.untrackedResourceForeground"),
      };
    }
    if (this.missing().has(elementId)) {
      return {
        badge: "U",
        tooltip: vscode.l10n.t("Not generated — run Generate Testbench"),
        color: new vscode.ThemeColor("list.warningForeground"),
      };
    }
    if (this.stale().has(elementId)) {
      return {
        badge: "M",
        tooltip: vscode.l10n.t("Modified — the config changed since Generate Testbench"),
        color: new vscode.ThemeColor("charts.blue"),
      };
    }
    return undefined;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
