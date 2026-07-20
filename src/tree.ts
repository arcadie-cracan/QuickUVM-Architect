// The hierarchy tree view (native, in the sidebar): the tree of instances from
// instances[], with the stable IDs as keys. The generated blocks appear in
// the child's label (g_ch[1].u_ch under u_soc), without an intermediate node —
// instances[] contains only real instances.
//
// Above the top sits a synthetic "top module" root (D24): selecting
// it shows the top's SYMBOL, while the rest of the nodes (with names) show
// the module's internal SCHEMATIC (leaves fall gracefully onto the symbol). This way there is
// a symbol/schematic differentiation at the top level too — which otherwise could not
// be reflected in the tree selection (docs/05).

import * as vscode from "vscode";
import { Instance, ProjectModel } from "./model";

/** the synthetic key of the "top module" root (not an instance path) */
export const TOP_ROOT_ID = "<top-module>";

export interface InstanceNode {
  /** absent only for the synthetic "top module" root */
  inst?: Instance;
  /** true for the synthetic "top module" root */
  synthetic?: boolean;
  /** the module has an internal schematic (views[path]) — decides the open command */
  hasSchematic?: boolean;
  /** the label relative to the parent (may include the generate segment) */
  label: string;
  children: InstanceNode[];
  /** the parent in the tree — required by TreeView.reveal (getParent) */
  parent?: InstanceNode;
}

export class HierarchyProvider implements vscode.TreeDataProvider<InstanceNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private roots: InstanceNode[] = [];
  private byPath = new Map<string, InstanceNode>();
  private root: InstanceNode | undefined;

  setModel(model: ProjectModel | undefined): void {
    const built = model ? buildTree(model) : { roots: [], byPath: new Map() };
    this.roots = built.roots;
    this.byPath = built.byPath;
    this.root = built.roots[0];
    this.changeEmitter.fire();
  }

  /** the node of the instance with the given path (for reveal from the diagram) */
  findNode(path: string): InstanceNode | undefined {
    return this.byPath.get(path);
  }

  /** the synthetic "top module" root (for revealing the top's symbol) */
  topRoot(): InstanceNode | undefined {
    return this.root?.synthetic ? this.root : undefined;
  }

  getParent(node: InstanceNode): InstanceNode | undefined {
    return node.parent;
  }

  getTreeItem(node: InstanceNode): vscode.TreeItem {
    if (node.synthetic) {
      // "top module" root: click -> the top's symbol; a "Set top
      // module" button via the context menu (contextValue)
      const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      const top = node.children[0]?.inst;
      item.description = top?.module;
      item.tooltip = vscode.l10n.t("Top module — click to show its symbol");
      item.iconPath = new vscode.ThemeIcon("circuit-board");
      item.id = TOP_ROOT_ID;
      item.contextValue = "top-root";
      if (top) {
        item.command = {
          command: "quickuvm.openSymbolView",
          title: vscode.l10n.t("Open Symbol View"),
          arguments: [top.path],
        };
      }
      return item;
    }
    const inst = node.inst!;
    const item = new vscode.TreeItem(
      node.label,
      node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    const params = Object.entries(inst.params)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    item.description = inst.module + (params ? ` #(${params})` : "");
    item.tooltip = inst.path;
    item.iconPath = new vscode.ThemeIcon(
      inst.iface ? "symbol-interface" : "symbol-class"
    );
    item.id = inst.path;
    item.contextValue = "instance";
    // a module with a name shows the internal schematic; a leaf (without a schematic) falls
    // gracefully onto the symbol in the webview, so the schematic command is uniform (docs/05)
    item.command = {
      command: node.hasSchematic
        ? "quickuvm.openSchematicView"
        : "quickuvm.openSymbolView",
      title: vscode.l10n.t("Open"),
      arguments: [inst.path],
    };
    return item;
  }

  getChildren(node?: InstanceNode): InstanceNode[] {
    return node ? node.children : this.roots;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/**
 * Builds the tree by the prefix of the hierarchical paths. The parent of an
 * instance is the longest instance path that is a proper prefix of it — it
 * naturally skips over the generate segments (g_ch[1]), which are not instances.
 *
 * Above the top (the instances without a parent) sits the synthetic
 * "top module" root: the exposed tree has a single root, and the design's top sits
 * immediately under it.
 */
export function buildTree(model: ProjectModel): {
  roots: InstanceNode[];
  byPath: Map<string, InstanceNode>;
} {
  const byPath = new Map<string, InstanceNode>();
  const tops: InstanceNode[] = [];
  const hasView = (p: string): boolean => Boolean(model.views[p]);
  for (const inst of model.instances) {
    const node: InstanceNode = {
      inst,
      label: inst.path,
      hasSchematic: hasView(inst.path),
      children: [],
    };
    let idx = inst.path.lastIndexOf(".");
    while (idx > 0) {
      const parent = byPath.get(inst.path.slice(0, idx));
      if (parent) {
        node.label = inst.path.slice(idx + 1);
        node.parent = parent;
        parent.children.push(node);
        break;
      }
      idx = inst.path.lastIndexOf(".", idx - 1);
    }
    if (idx <= 0) {
      tops.push(node);
    }
    byPath.set(inst.path, node);
  }
  if (tops.length === 0) {
    return { roots: [], byPath };
  }
  const root: InstanceNode = {
    synthetic: true,
    label: vscode.l10n.t("top module"),
    children: tops,
  };
  for (const t of tops) {
    t.parent = root;
  }
  return { roots: [root], byPath };
}
