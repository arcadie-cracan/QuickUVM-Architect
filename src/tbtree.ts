// Tree view-ul "Verification Hierarchy" (nativ, in sidebar): arborele de
// niveluri al mediului TB (docs/05, D24). Constructia pura e in
// src/tbtree-build.ts (testabila in Node); aici e doar ambalajul
// TreeDataProvider + indicii de reveal.

import * as vscode from "vscode";
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

  /** nodul care reprezinta blocul `id` la nivelul `focus` (reveal din diagrama) */
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
