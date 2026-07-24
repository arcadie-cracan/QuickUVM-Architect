// Bench identity guards (docs/07 line 3, P2): which `layout:` / `kind:` values a
// given config may actually be switched to. PURE (no `vscode`), testable in Node
// (scripts/test-benchid.mjs).
//
// These are not style preferences — QuickUVM refuses each combination below with an
// explicit error, so offering the switch unguarded would write a config that no
// longer generates. The panel disables the option and shows the reason instead.

import type { QuvmConfig } from "./quickuvm";

/**
 * Why `layout: <target>` cannot be selected, as user-facing reasons (empty = it can).
 *   - `subenvs` require `packaged` — each child block is a reusable env package;
 *   - `kind: vip|selftest` require `packaged` — a VIP *is* per-agent packages;
 *   - agent `instances` (C3) require `flat` — packaged does not thread per-instance
 *     scoreboards yet.
 */
export function layoutBlockers(
  cfg: QuvmConfig,
  target: "flat" | "packaged"
): string[] {
  const out: string[] = [];
  if (target === "flat") {
    if (cfg.subenvs?.length) {
      out.push("`subenvs` require the packaged layout (each child block is a reusable env package)");
    }
    const kind = cfg.kind ?? "bench";
    if (kind !== "bench") {
      out.push(`\`kind: ${kind}\` requires the packaged layout (flat has no package to reuse)`);
    }
    // an agent CONSUMED BY REFERENCE is an external package: flat has nothing to chain
    const refs = (cfg.agents ?? [])
      .filter((a) => a.from_vip && a.name)
      .map((a) => a.name as string);
    if (refs.length) {
      out.push(
        `\`from_vip\` agents require the packaged layout (${refs.join(", ")}) — the referenced VIP is an external package`
      );
    }
  } else {
    const withInstances = (cfg.agents ?? [])
      .filter((a) => a.instances?.length && a.name)
      .map((a) => a.name as string);
    if (withInstances.length) {
      out.push(
        `agent \`instances\` require the flat layout (${withInstances.join(", ")}) — packaged does not thread per-instance scoreboards yet`
      );
    }
  }
  return out;
}

/**
 * Why `kind: <target>` cannot be selected (empty = it can).
 *
 * `vip` emits ONLY reusable agent packages + a `.qvip` manifest, so every bench-layer
 * section would be silently dropped — QuickUVM fences them all rather than dropping
 * them. We list the ones actually present, so the message names what to move out.
 * A rich `analysis.coverage` entry is deliberately NOT fenced (its covergroup renders
 * into the agent package), and an untouched default test list is not either.
 */
export function kindBlockers(
  cfg: QuvmConfig,
  target: "bench" | "vip" | "selftest"
): string[] {
  if (target === "bench") {
    return [];
  }
  const out: string[] = [];
  if ((cfg.layout ?? "flat") !== "packaged") {
    out.push(`\`kind: ${target}\` requires \`layout: packaged\` — switch the layout first`);
  }
  if (target !== "vip") {
    return out;
  }
  const dropped: string[] = [];
  const push = (label: string, present: unknown): void => {
    if (present) {
      dropped.push(label);
    }
  };
  push("subenvs", cfg.subenvs?.length);
  push("register_model", cfg.register_model);
  push("connections", cfg.connections?.length);
  push("probes", cfg.probes?.length);
  push("virtual_sequences", cfg.virtual_sequences?.length);
  push("regress", cfg.regress);
  push("analysis.scoreboards", cfg.analysis?.scoreboards?.length);
  // A user-declared test list only. QuickUVM compares against the DEFAULT value of
  // the field (`[TestConfig(name="test1")]`), so an ABSENT `tests:` key is the
  // default and never a blocker — while an explicit `tests: []` differs from it and
  // is fenced, exactly like any other declared list.
  const tests = cfg.tests;
  push(
    "tests",
    tests !== undefined &&
      (tests.length !== 1 ||
        tests[0]?.name !== "test1" ||
        tests[0]?.num_items !== undefined)
  );
  // bare coverage names are pure env routing (dropped); rich entries render into the
  // agent package and are allowed
  const bare = (cfg.analysis?.coverage ?? []).filter((c) => typeof c === "string");
  push("analysis.coverage (bare agent names)", bare.length);
  if (dropped.length) {
    out.push(
      `\`kind: vip\` emits only agent packages + a manifest — these would be dropped: ${dropped.join(", ")}. Move them to the consuming bench.`
    );
  }
  return out;
}
