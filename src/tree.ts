// Tree view-ul de ierarhie (nativ, in sidebar): arborele instantelor din
// instances[], cu ID-urile stabile drept chei. Blocurile generate apar in
// eticheta copilului (g_ch[1].u_ch sub u_soc), fara nod intermediar —
// instances[] contine doar instante reale.
//
// Deasupra top-ului sta o radacina sintetica „top module" (D24): selectarea
// ei prezinta SIMBOLUL top-ului, iar restul nodurilor (cu nume) prezinta
// SCHEMA interna a modulului (frunzele cad gratios pe simbol). Astfel exista
// o diferentiere simbol/schema si la nivelul de top — care altfel nu se putea
// reflecta in selectia din arbore (docs/05).

import * as vscode from "vscode";
import { Instance, ProjectModel } from "./model";

/** cheia sintetica a radacinii „top module" (nu e o cale-instanta) */
export const TOP_ROOT_ID = "<top-module>";

export interface InstanceNode {
  /** absent doar pentru radacina sintetica „top module" */
  inst?: Instance;
  /** true pentru radacina sintetica „top module" */
  synthetic?: boolean;
  /** modulul are schema interna (views[path]) — decide comanda de deschidere */
  hasSchematic?: boolean;
  /** eticheta relativa la parinte (poate include segmentul generate) */
  label: string;
  children: InstanceNode[];
  /** parintele in arbore — cerut de TreeView.reveal (getParent) */
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

  /** nodul instantei cu calea data (pentru reveal din diagrama) */
  findNode(path: string): InstanceNode | undefined {
    return this.byPath.get(path);
  }

  /** radacina sintetica „top module" (pentru reveal-ul simbolului top-ului) */
  topRoot(): InstanceNode | undefined {
    return this.root?.synthetic ? this.root : undefined;
  }

  getParent(node: InstanceNode): InstanceNode | undefined {
    return node.parent;
  }

  getTreeItem(node: InstanceNode): vscode.TreeItem {
    if (node.synthetic) {
      // radacina „top module": click -> simbolul top-ului; buton „Set top
      // module" prin meniul contextual (contextValue)
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
    // un modul cu nume prezinta schema interna; frunza (fara schema) cade
    // gratios pe simbol in webview, deci comanda schema e uniforma (docs/05)
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
 * Construieste arborele dupa prefixul cailor ierarhice. Parintele unei
 * instante e cea mai lunga cale-instanta care ii e prefix propriu — sare
 * natural peste segmentele generate (g_ch[1]), care nu sunt instante.
 *
 * Deasupra top-ului (instantele fara parinte) se aseaza radacina sintetica
 * „top module": arborele expus are un singur root, iar top-ul designului sta
 * imediat sub el.
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
