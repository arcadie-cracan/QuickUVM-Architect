// The "not generated" star on the verification-hierarchy tree (docs/07 line 1).
// A `FileDecorationProvider` badges the tree items whose element has no generated
// code behind it yet, driven by the generation-state service. The tree items carry
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

  constructor(private readonly ungenerated: () => ReadonlySet<string>) {}

  /** Re-query every decoration (the ungenerated set changed). */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== GEN_SCHEME) {
      return undefined;
    }
    const elementId = decodeURIComponent(uri.path.replace(/^\//, ""));
    if (!this.ungenerated().has(elementId)) {
      return undefined;
    }
    return {
      badge: "★",
      tooltip: vscode.l10n.t("Not generated — run Generate Testbench"),
      color: new vscode.ThemeColor("gitDecoration.untrackedResourceForeground"),
    };
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
