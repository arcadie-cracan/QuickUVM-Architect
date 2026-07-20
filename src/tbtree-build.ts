// The pure construction of the verification tree (no `vscode`), testable in
// Node (scripts/test-tbtree.mjs). Reflects the level hierarchy of the TB
// diagram (D24): Testbench > {DUT, Env > {agents > {sequencer/driver/monitor},
// scoreboards, coverage, vsqr, subenvs, probes}}. Each node carries `focus`
// (the level that opens on click) + `selectId` (the block to select in that
// level), plus identity ids `<focus>|<blocId>` for reverse reveal
// from the diagram.

import type { QuvmConfig } from "./quickuvm";

export interface VNode {
  id: string;
  label: string;
  description?: string;
  icon: string;
  /** the TB level opened on click (the focus from buildTbScene) */
  focus: string;
  /** the block to select in that level; null = just open the level */
  selectId: string | null;
  children: VNode[];
  parent?: VNode;
}

export interface VTree {
  roots: VNode[];
  /** reveal drill: focus -> the level's container node */
  byFocus: Map<string, VNode>;
  /** reveal selection: `<focus>|<blocId>` -> the node in the tree */
  byIdent: Map<string, VNode>;
}

export function buildVTree(config: QuvmConfig, configPath: string | null): VTree {
  void configPath;
  const byFocus = new Map<string, VNode>();
  const byIdent = new Map<string, VNode>();
  const agents = (config.agents ?? []).filter((a) => a.name);
  const subenvs = (config.subenvs ?? []).filter((s) => s.name);
  const dutName = config.dut?.name;
  const hasDut = Boolean(dutName) && subenvs.length === 0;
  if (!dutName && agents.length === 0 && subenvs.length === 0) {
    return { roots: [], byFocus, byIdent };
  }

  const mk = (
    id: string,
    label: string,
    icon: string,
    focus: string,
    selectId: string | null,
    parent: VNode | undefined,
    opts?: { description?: string; identFocus?: string; identId?: string }
  ): VNode => {
    const n: VNode = { id, label, icon, focus, selectId, children: [], parent };
    if (opts?.description) {
      n.description = opts.description;
    }
    // identity in the diagram: containers are identified by their focus at
    // the parent level; both forms are registered for reveal
    if (opts?.identFocus !== undefined && opts?.identId !== undefined) {
      byIdent.set(`${opts.identFocus}|${opts.identId}`, n);
    }
    return n;
  };

  // root: Testbench (the "" level)
  const tb = mk(
    "v:tb",
    config.project?.name ? `${config.project.name} (tb)` : "Testbench",
    "beaker",
    "",
    null,
    undefined,
    { description: "verification environment" }
  );
  byFocus.set("", tb);

  if (hasDut && dutName) {
    tb.children.push(
      mk("v:dut", dutName, "circuit-board", "", "dut", tb, {
        description: "DUT",
        identFocus: "",
        identId: "dut",
      })
    );
  }

  // Env (the "env" level)
  const analysisCount =
    (config.analysis?.scoreboards?.length ?? 0) +
    (new Set(config.analysis?.coverage ?? []).size);
  const hasEnv = agents.length > 0 || subenvs.length > 0 || analysisCount > 0;
  if (hasEnv) {
    const env = mk("v:env", "Env", "symbol-namespace", "env", null, tb, {
      description: "verification environment",
      identFocus: "",
      identId: "env",
    });
    byFocus.set("env", env);
    tb.children.push(env);

    for (const a of agents) {
      const name = a.name as string;
      const active = a.active !== false;
      const focus = `agent:${name}`;
      const agentNode = mk(
        `v:${focus}`,
        name,
        active ? "arrow-both" : "eye",
        focus,
        null,
        env,
        {
          description: active ? "active agent" : "passive agent",
          identFocus: "env",
          identId: focus,
        }
      );
      byFocus.set(focus, agentNode);
      env.children.push(agentNode);
      // the agent internals: leaves that open the agent level + select
      const units = active
        ? [
            ["u.sequencer", "sequencer", "list-ordered"],
            ["u.driver", "driver", "triangle-right"],
            ["u.monitor", "monitor", "eye"],
          ]
        : [["u.monitor", "monitor", "eye"]];
      for (const [uid, ulabel, uicon] of units) {
        agentNode.children.push(
          mk(`v:${focus}:${uid}`, ulabel, uicon, focus, uid, agentNode, {
            identFocus: focus,
            identId: uid,
          })
        );
      }
    }

    const usedSb = new Set<string>();
    for (const sb of (config.analysis?.scoreboards ?? []).filter((s) => s.source)) {
      let id = `sb:${sb.name ?? "sbd"}`;
      for (let n = 2; usedSb.has(id); n++) {
        id = `sb:${sb.name ?? "sbd"}#${n}`;
      }
      usedSb.add(id);
      env.children.push(
        mk(`v:${id}`, sb.name ?? "sbd", "checklist", "env", id, env, {
          description: "scoreboard",
          identFocus: "env",
          identId: id,
        })
      );
    }
    for (const agent of new Set(config.analysis?.coverage ?? [])) {
      env.children.push(
        mk(`v:cov:${agent}`, `${agent}_cov`, "graph", "env", `cov:${agent}`, env, {
          description: "coverage",
          identFocus: "env",
          identId: `cov:${agent}`,
        })
      );
    }
    const coordinated = coordinatedCount(config);
    if (coordinated > 0) {
      env.children.push(
        mk("v:vsqr", "virtual sequencer", "list-ordered", "env", "vsqr", env, {
          identFocus: "env",
          identId: "vsqr",
        })
      );
    }
    for (const s of subenvs) {
      const id = `sub:${s.name}`;
      env.children.push(
        mk(`v:${id}`, s.name as string, "package", "env", id, env, {
          description: s.config,
          identFocus: "env",
          identId: id,
        })
      );
    }
    if ((config.probes ?? []).some((p) => p.name)) {
      const probes = mk("v:probes", "probes", "pulse", "env", "probes", env, {
        identFocus: "env",
        identId: "probes",
      });
      env.children.push(probes);
      for (const p of (config.probes ?? []).filter((pp) => pp.name)) {
        probes.children.push(
          mk(`v:probe:${p.name}`, p.name as string, "pulse", "env", "probes", probes, {
            description: p.path,
          })
        );
      }
    }
  }

  return { roots: [tb], byFocus, byIdent };
}

function coordinatedCount(config: QuvmConfig): number {
  const agents = (config.agents ?? []).filter((a) => a.name);
  const names = new Set(agents.map((a) => a.name));
  const vseqs = (config.virtual_sequences ?? []).filter((v) => v.name);
  if (vseqs.length) {
    const set = new Set<string>();
    for (const v of vseqs) {
      for (const s of v.body ?? []) {
        if (s.agent && names.has(s.agent)) set.add(s.agent);
      }
    }
    return set.size;
  }
  const active = agents.filter((a) => a.active !== false);
  return config.auto_virtual_sequences !== false && active.length >= 2
    ? active.length
    : 0;
}
