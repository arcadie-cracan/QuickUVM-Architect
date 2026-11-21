// The "Signals" tree view (docs/08 R24): the bench's clock and reset domains
// with the agents on them, and a native drag-and-drop that assigns an agent to
// a domain. The tree and the drop's rule are pure (src/signals.ts, tested in
// test:signals); here is only the TreeDataProvider / TreeDragAndDropController
// wrapper. A drop is a YAML edit like any other gesture: it goes through the
// host action, so undo and the diff are the editor's own.

import * as vscode from "vscode";
import type { QuvmConfig } from "./quickuvm";
import { buildSignalsTree, dropPlan, type SignalField, type SignalNode } from "./signals";

const MIME = "application/vnd.code.tree.quickuvm.signals";

const ICON: Readonly<Record<SignalNode["kind"], string>> = {
  group: "symbol-namespace",
  domain: "pulse",
  unassigned: "debug-disconnect",
  agent: "person",
  note: "info",
};

export class SignalsProvider
  implements vscode.TreeDataProvider<SignalNode>, vscode.TreeDragAndDropController<SignalNode>
{
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private config: QuvmConfig | null = null;
  private roots: SignalNode[] = [];
  private parents = new Map<string, SignalNode>();

  /**
   * @param assign the host action: writes `field: value` on the agents in ONE
   *   edit (value "" removes the key)
   */
  constructor(
    private readonly assign: (agents: string[], field: SignalField, value: string) => Promise<void>
  ) {}

  setConfig(config: QuvmConfig | null): void {
    this.config = config;
    this.roots = buildSignalsTree(config);
    this.parents = new Map();
    const walk = (n: SignalNode): void => {
      for (const c of n.children) {
        this.parents.set(c.id, n);
        walk(c);
      }
    };
    this.roots.forEach(walk);
    this.changeEmitter.fire();
  }

  hasContent(): boolean {
    return this.roots.length > 0;
  }

  getParent(node: SignalNode): SignalNode | undefined {
    return this.parents.get(node.id);
  }

  getChildren(node?: SignalNode): SignalNode[] {
    return node ? node.children : this.roots;
  }

  getTreeItem(node: SignalNode): vscode.TreeItem {
    // the fixed labels are localised here (the model is pure, no vscode)
    const label =
      node.kind === "group"
        ? node.field === "clock"
          ? vscode.l10n.t("Clocks")
          : vscode.l10n.t("Resets")
        : node.kind === "unassigned"
          ? vscode.l10n.t("Unconnected")
          : node.label;
    const item = new vscode.TreeItem(
      label,
      node.kind === "agent" || node.kind === "note"
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded
    );
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.fixed ?? (node.description ? `${node.label} — ${node.description}` : node.label);
    item.iconPath = new vscode.ThemeIcon(
      node.kind === "domain" && node.field === "reset" ? "debug-restart" : ICON[node.kind]
    );
    // `signals-<kind>-<field>`: the menus key on it (add a domain on a group)
    item.contextValue = `signals-${node.kind}${node.field ? `-${node.field}` : ""}`;
    if (node.kind === "agent" && node.agent) {
      // a click shows the agent in the verification view (the trees agree on ids)
      item.command = {
        command: "quickuvm.revealTbComponent",
        title: "",
        arguments: ["env", `agent:${node.agent}`],
      };
    }
    return item;
  }

  // ------------------------------------------------------------ drag and drop

  handleDrag(source: readonly SignalNode[], data: vscode.DataTransfer): void {
    // only agents travel — and not a VIP reference, whose clocking is the VIP's
    const agents = source
      .filter((n) => n.kind === "agent" && n.agent && !n.fixed)
      .map((n) => n.agent as string);
    if (agents.length) {
      data.set(MIME, new vscode.DataTransferItem(agents));
    }
  }

  async handleDrop(target: SignalNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const raw: unknown = data.get(MIME)?.value;
    // the value crosses a serialisation boundary when the drag leaves the
    // extension host's memory: a JSON string in that case
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = [];
      }
    }
    const agents = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
    if (!agents.length) {
      return;
    }
    // dropped ON an agent: its folder is what was meant
    const on = target?.kind === "agent" ? this.parents.get(target.id) : target;
    const plan = dropPlan(this.config, on, agents);
    if (!plan.ok) {
      if (plan.reason !== "already there") {
        void vscode.window.showInformationMessage(
          vscode.l10n.t("QuickUVM Architect: {0}.", plan.reason)
        );
      }
      return;
    }
    await this.assign(plan.agents, plan.field, plan.value);
  }
}
