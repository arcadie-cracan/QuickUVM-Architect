// The "Verification Hierarchy" tree view (native, in the sidebar): the
// level tree of the TB environment (docs/05, D24). The pure construction is in
// src/tbtree-build.ts (testable in Node); here is only the
// TreeDataProvider wrapper + the reveal indices.

import * as vscode from "vscode";
import { genElementUri } from "./tbdecorations";
import type { QuvmConfig } from "./quickuvm";
import { buildVTree, VNode } from "./tbtree-build";

export type { VNode };

export class VerificationProvider
  implements vscode.TreeDataProvider<VNode>
{
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private roots: VNode[] = [];
  private byFocus = new Map<string, VNode>();
  private byIdent = new Map<string, VNode>();

  /** docs/07 line 1+2 — the generation state, so a row's contextValue can carry it
   *  (`…-missing` / `…-stale` / `…-ok`) and the inline action can be Generate,
   *  Regenerate, or nothing. Injected so this provider stays free of the service. */
  constructor(
    private readonly missing: () => ReadonlySet<string> = () => new Set(),
    private readonly stale: () => ReadonlySet<string> = () => new Set()
  ) {}

  /** Re-render the rows (the generation state changed → the actions change). */
  refresh(): void {
    this.changeEmitter.fire();
  }

  setConfig(config: QuvmConfig | null, configPath: string | null): void {
    const built = config
      ? buildVTree(config, configPath)
      : { roots: [], byFocus: new Map(), byIdent: new Map() };
    this.roots = built.roots;
    this.byFocus = built.byFocus;
    this.byIdent = built.byIdent;
    this.changeEmitter.fire();
  }

  hasContent(): boolean {
    return this.roots.length > 0;
  }

  /** the node representing block `id` at level `focus` (reveal from the diagram) */
  findByIdent(focus: string, id: string): VNode | undefined {
    return this.byIdent.get(`${focus}|${id}`) ?? this.byFocus.get(focus);
  }

  getParent(node: VNode): VNode | undefined {
    return node.parent;
  }

  getChildren(node?: VNode): VNode[] {
    return node ? node.children : this.roots;
  }

  getTreeItem(node: VNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children.length
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.description
      ? `${node.label} — ${node.description}`
      : node.label;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    // A synthetic resourceUri so the GenDecorationProvider can badge an element
    // with no generated code behind it (docs/07 line 1). The element id is the
    // node id minus the `v:` tree prefix (agent:<name>, sb:<name>, probes, vsqr,
    // …); the explicit iconPath/label above still win — resourceUri only drives
    // the file decoration.
    const elementId = node.id.replace(/^v:/, "");
    item.resourceUri = genElementUri(elementId);
    // docs/07 line 2 — mark the generatable elements so the item actions can target
    // them (agents, scoreboards, probes, vsqr; NOT the agent-internal leaves
    // `agent:<name>:u.driver`, which have a second colon). The contextValue carries
    // the generation STATE too, so the inline action matches what is actually to be
    // done: `-missing` -> Generate (▶), `-stale` -> Regenerate (⟳), `-ok` -> none.
    const kind = /^agent:[^:]+$/.test(elementId)
      ? "agent"
      : /^sb:/.test(elementId)
        ? "sb"
        : elementId === "probes"
          ? "probes"
          : elementId === "vsqr"
            ? "vsqr"
            : null;
    if (kind) {
      const state = this.missing().has(elementId)
        ? "missing"
        : this.stale().has(elementId)
          ? "stale"
          : "ok";
      item.contextValue = `vgen-${kind}-${state}`;
    }
    item.command = {
      command: "quickuvm.revealTbComponent",
      title: vscode.l10n.t("Open in the verification view"),
      arguments: [node.focus, node.selectId],
    };
    return item;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
