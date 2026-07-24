// The inspector — every property editor of the verification/schematic views, moved
// out of main.ts so a SECOND webview (the sidebar "Properties" view) can render the
// same UI without pulling in the diagram. Behaviour is unchanged: what used to be
// module globals now arrives in an explicit `InspectorCtx`, so this file has no
// dependency on the diagram's canvas, layout or ELK.
//
// The information architecture it obeys (scope / relevance / rarity) is stated and
// tested in src/inspector.ts — this file only renders what those rules decide.

import { kindBlockers, layoutBlockers } from "../benchid";
import {
  coveredAgent,
  coverpointCandidates,
  crossBlockers,
  crossFields,
  crossName,
  formatBinSpec,
  isRich,
  scoreboardEndpoints,
} from "../coverage";
import { agentRows, isBenchScope, portRows, scoreboardRows } from "../inspector";
import type { ActionKind, WebviewMessage } from "../protocol";
import type {
  QuvmAgent,
  QuvmConfig,
  QuvmPort,
  QuvmScoreboard,
} from "../quickuvm";
import type { Instance } from "../model";
import type { SchematicScene } from "./scene";
import type { TbScene } from "./tbscene";
import type { State } from "./state";

/** Everything the inspector used to reach through module globals. */
export interface InspectorCtx {
  /** the element the rows are appended to (`#inspector` in either webview) */
  root: HTMLElement;
  state: State;
  tbScene: TbScene | undefined;
  scene: SchematicScene | null;
  pins: { name: string; iface: boolean }[];
  post(message: WebviewMessage): void;
  postAction(action: ActionKind, args: Record<string, unknown>): void;
  vscode: {
    getState():
      | { viewId?: string; mode?: string; openSections?: string[] }
      | undefined;
    setState(s: Record<string, unknown>): void;
  };
  /** drill into a TB component / flip a node / select pins in the diagram */
  onOpen(drill: string): void;
  onFlip(id: string, axis: "h" | "v"): void;
  onSelectPins(names: string[]): void;
  findInstance(viewId: string): Instance | undefined;
  tbAvailable(): boolean;
  /** switch the diagram to the verification (TB) view */
  openTbView(): void;
  /** the net a pin belongs to, and the ctx.sidecar's per-net render overrides */
  netOfPin(id: string): string | null;
  /** the layout sidecar (per-view net render overrides) */
  sidecar: {
    views?: Record<
      string,
      { nets?: Record<string, { render?: string } | undefined> } | undefined
    >;
  } | null;
  toggleNetRender(net: string): void;
  toggleFold(id: string): void;
  hasSchematic(model: unknown, viewId: string): boolean;
  navigateTo(viewId: string, mode: "schematic" | "symbol"): void;
}

// assigned by `renderInspector` before any helper runs (they are only reachable
// from it), so the non-null assertion is the honest shape here
let ctx!: InspectorCtx;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

export function button(
  label: string,
  enabled: boolean,
  onClick: () => void,
  secondary = false,
  disabledHint?: string
): HTMLButtonElement {
  const b = h("button", `btn${secondary ? " secondary" : ""}`, label);
  b.disabled = !enabled;
  if (!enabled && disabledHint) {
    b.title = disabledHint; // the reason for disabling, visible on hover
  }
  b.addEventListener("click", onClick);
  return b;
}

/** a property row in the inspector: label + control (select/input) */
function tbPropRow(label: string, control: HTMLElement): HTMLElement {
  const row = h("div", "prop-row");
  row.append(h("label", "prop-label", label), control);
  return row;
}

/**
 * The rich functional-coverage editor (docs/07 line 3, P3b). An `analysis.coverage`
 * entry is either a BARE agent name — pure env routing, connect that agent's
 * `<agent>_cov` — or a RICH model that also generates the covergroup content. This is
 * the gesture that upgrades one to the other and then authors it.
 *
 * QuickUVM's own rules are surfaced, not discovered at generate time: a rich model
 * needs at least one coverpoint (so the upgrade creates the first), each field gets
 * exactly one coverpoint, a cross needs >= 2 DECLARED coverpoints and a unique name,
 * and `goal` is a percent. Everything the editor does not author (illegal_bins,
 * ignore_bins, transitions, cross bin selections) is edited around, never rewritten.
 */
function tbCoverageEditor(agentName: string): void {
  const entries = ctx.state.config?.analysis?.coverage ?? [];
  const entry = entries.find((c) => coveredAgent(c) === agentName);
  if (entry === undefined) {
    return;
  }
  const agent = (ctx.state.config?.agents ?? []).find((a) => a.name === agentName);
  const send = (op: string, args: Record<string, unknown> = {}): void =>
    ctx.postAction("editCoverage", { op, agent: agentName, ...args });

  ctx.root.append(h("h3", "", "Coverage model"));

  if (!isRich(entry)) {
    // bare entry: routing only. The upgrade needs a first coverpoint, so it is
    // offered per candidate field rather than as a bare "make it rich" button.
    const candidates = coverpointCandidates(agent, {});
    ctx.root.append(
      h("div", "dim", "routing only — no covergroup content is generated"),
      h("div", "note", "add a first coverpoint to author bins and crosses")
    );
    if (candidates.length) {
      const sel = tbSelect(
        [["", "— add a coverpoint —"], ...candidates.map((c) => [c, c] as const)],
        "",
        (v) => {
          if (v) {
            send("upgrade", { field: v });
          }
        }
      );
      ctx.root.append(tbPropRow("Coverpoint", sel));
    } else {
      ctx.root.append(h("div", "note", "this agent has no ports to cover"));
    }
    return;
  }

  const model = entry;
  for (const cp of model.coverpoints ?? []) {
    const field = cp.field;
    if (!field) {
      continue;
    }
    ctx.root.append(h("div", "prop-group", field));
    for (const bin of cp.bins ?? []) {
      const binName = bin.name;
      if (!binName) {
        continue;
      }
      const inp = h("input", "prop");
      inp.value = formatBinSpec(bin);
      inp.title = "one value (5), an inclusive range (0..7) or a list (1, 2, 3)";
      inp.addEventListener("change", () =>
        send("setBin", { field, bin: binName, spec: inp.value })
      );
      const row = tbPropRow(binName, inp);
      const del = h("button", "prop-del", "×");
      del.title = `remove bin ${binName}`;
      del.addEventListener("click", () => send("removeBin", { field, bin: binName }));
      row.append(del);
      ctx.root.append(row);
    }
    const addBin = h("input", "prop");
    addBin.placeholder = "new bin: name = 0..7";
    addBin.addEventListener("change", () => {
      // `name = spec` on one line, so adding a bin is a single gesture
      const [rawName, ...rest] = addBin.value.split("=");
      const spec = rest.join("=");
      if (rawName.trim() && spec.trim()) {
        send("setBin", { field, bin: rawName.trim(), spec });
        addBin.value = "";
      }
    });
    ctx.root.append(tbPropRow("Add bin", addBin));
    ctx.root.append(
      button(`Remove coverpoint ${field}`, true, () => send("removeCoverpoint", { field }), true)
    );
  }

  const candidates = coverpointCandidates(agent, model);
  if (candidates.length) {
    ctx.root.append(
      tbPropRow(
        "Coverpoint",
        tbSelect(
          [["", "— add —"], ...candidates.map((c) => [c, c] as const)],
          "",
          (v) => {
            if (v) {
              send("addCoverpoint", { field: v });
            }
          }
        )
      )
    );
  }

  // crosses: a checkbox per declared coverpoint, added when >= 2 are ticked
  const declared = (model.coverpoints ?? [])
    .map((c) => c.field)
    .filter((f): f is string => Boolean(f));
  for (const cross of model.crosses ?? []) {
    const name = crossName(cross);
    const row = tbPropRow(name, h("div", "dim", crossFields(cross).join(" × ")));
    const del = h("button", "prop-del", "×");
    del.title = `remove cross ${name}`;
    del.addEventListener("click", () => send("removeCross", { value: name }));
    row.append(del);
    ctx.root.append(row);
  }
  if (declared.length >= 2) {
    const picked = new Set<string>();
    const box = h("div", "prop-checks");
    const add = h("button", "prop-add", "cross");
    add.disabled = true;
    for (const f of declared) {
      const lbl = h("label", "prop-check");
      const cb = h("input", "");
      cb.type = "checkbox";
      cb.addEventListener("change", () => {
        if (cb.checked) {
          picked.add(f);
        } else {
          picked.delete(f);
        }
        const why = crossBlockers(model, [...picked]);
        add.disabled = why.length > 0;
        add.title = why.join(" · ");
      });
      lbl.append(cb, document.createTextNode(` ${f}`));
      box.append(lbl);
    }
    add.addEventListener("click", () => {
      if (picked.size >= 2) {
        send("addCross", { fields: declared.filter((f) => picked.has(f)) });
      }
    });
    box.append(add);
    ctx.root.append(tbPropRow("New cross", box));
  }

  const goalIn = h("input", "prop");
  goalIn.type = "number";
  goalIn.min = "1";
  goalIn.max = "100";
  goalIn.value = model.goal != null ? String(model.goal) : "";
  goalIn.placeholder = "closure %";
  goalIn.addEventListener("change", () => send("goal", { value: goalIn.value }));
  ctx.root.append(tbPropRow("Goal", goalIn));

  ctx.root.append(
    button("Back to routing only", true, () => send("downgrade"), true)
  );
}

/**
 * The bench-level settings panel (docs/07 line 3, P2): RAL + regression. Both are
 * PRESENCE-switched blocks — `register_model:` switches the bench into RAL mode
 * (adapter + CSR tests + env wiring), `regress:` generates the Makefile and is what
 * makes `tests[].seeds` legal — so each gets an explicit enable/remove, not a field.
 * Shown regardless of selection: these belong to the bench, not to a component.
 */
function tbBenchSettings(cfg: QuvmConfig): void {
  ctx.root.append(h("h3", "", `Bench: ${cfg.project?.name ?? "unnamed"}`));
  tbSection("bench.ral", "Register model", () => tbRegisterModel(cfg), true);
  tbSection("bench.regress", "Regression", () => tbRegress(cfg), true);
  tbSection("bench.clocks", "Clocks", () => tbClockDomains(cfg));
  tbSection("bench.resets", "Resets", () => tbResetDomains(cfg));
  tbSection("bench.tests", "Tests", () => tbTestsEditor(cfg));
  tbSection("bench.identity", "Identity", () => tbBenchIdentity(cfg));
}

/** The `register_model:` block (docs/07 P2a). */
function tbRegisterModel(cfg: QuvmConfig): void {

  const rm = cfg.register_model;
  if (!rm) {
    ctx.root.append(
      h("div", "dim", "no register model (RAL)"),
      button("Add register model…", true, () => ctx.postAction("addRegisterModel", {}), true)
    );
  } else {
    const send = (field: string, value: string): void =>
      ctx.postAction("editRegisterModel", { field, value });
    const textRow = (
      label: string,
      field: string,
      cur: string,
      placeholder: string
    ): void => {
      const inp = h("input", "prop");
      inp.value = cur;
      inp.placeholder = placeholder;
      inp.addEventListener("change", () => send(field, inp.value));
      ctx.root.append(tbPropRow(label, inp));
    };
    textRow("RAL package", "package", rm.package ?? "", "required");
    textRow("Reg block", "block", rm.block ?? "", "required");
    // the bus agent must be an INITIATOR (a responder cannot carry register traffic)
    const initiators = (cfg.agents ?? [])
      .filter((a) => a.mode !== "responder" && a.name)
      .map((a) => a.name as string);
    ctx.root.append(
      tbPropRow(
        "Bus agent",
        tbSelect(
          initiators.map((a) => [a, a] as const),
          rm.bus_agent ?? "",
          (v) => send("bus_agent", v)
        )
      )
    );
    if (rm.bus_agent && !initiators.includes(rm.bus_agent)) {
      ctx.root.append(
        h("div", "note", `bus_agent “${rm.bus_agent}” is not an initiator agent — QuickUVM refuses it`)
      );
    }
    textRow("Backdoor root", "backdoor_root", rm.backdoor_root ?? "", "none (frontdoor only)");

    // csr_tests: a checkbox per suite, sent back as a comma-separated list
    const suites = ["hw_reset", "bit_bash", "rw", "mem_walk", "shared"] as const;
    const chosen = new Set(rm.csr_tests ?? []);
    const box = h("div", "prop-checks");
    for (const s of suites) {
      const lbl = h("label", "prop-check");
      const cb = h("input", "");
      cb.type = "checkbox";
      cb.checked = chosen.has(s);
      cb.addEventListener("change", () => {
        const next = new Set(chosen);
        if (cb.checked) {
          next.add(s);
        } else {
          next.delete(s);
        }
        send("csr_tests", suites.filter((x) => next.has(x)).join(","));
      });
      lbl.append(cb, document.createTextNode(` ${s}`));
      box.append(lbl);
    }
    ctx.root.append(tbPropRow("CSR tests", box));

    for (const [label, field, cur] of [
      ["Reg coverage", "coverage", rm.coverage === true],
    ] as const) {
      ctx.root.append(
        tbPropRow(
          label,
          tbSelect(
            [
              ["true", "Yes"],
              ["false", "No"],
            ],
            cur ? "true" : "false",
            (v) => send(field, v)
          )
        )
      );
    }
    ctx.root.append(
      tbPropRow(
        "Reg test door",
        tbSelect(
          [
            ["frontdoor", "Frontdoor"],
            ["backdoor", "Backdoor"],
          ],
          rm.reg_test_door ?? "frontdoor",
          (v) => send("reg_test_door", v)
        )
      )
    );
    if (rm.reg_test_door === "backdoor" && !rm.backdoor_root) {
      ctx.root.append(
        h("div", "note", "a backdoor reg test needs a backdoor_root (the HDL path to the DUT)")
      );
    }
    tbSection("bench.ral.advanced", "Advanced", () => {
      textRow("Adapter", "adapter", rm.adapter ?? "", "reg_adapter");
      textRow("Map", "map", rm.map ?? "", "default_map");
      for (const [label, field, cur] of [
        ["Use predictor", "use_predictor", rm.use_predictor !== false],
        ["Reg test", "reg_test", rm.reg_test !== false],
      ] as const) {
        ctx.root.append(
          tbPropRow(
            label,
            tbSelect(
              [
                ["true", "Yes"],
                ["false", "No"],
              ],
              cur ? "true" : "false",
              (v) => send(field, v)
            )
          )
        );
      }
    });
    ctx.root.append(
      button("Remove register model", true, () => ctx.postAction("removeRegisterModel", {}), true)
    );
  }

}

/** The `regress:` block (docs/07 P2a). */
function tbRegress(cfg: QuvmConfig): void {
  const rg = cfg.regress;
  const seeded = (cfg.tests ?? []).filter((t) => t.seeds !== undefined).length;
  if (!rg) {
    ctx.root.append(
      h("div", "dim", "no regression (Makefile)"),
      button("Add regression", true,
        () => ctx.postAction("toggleRegress", { value: "true" }), true)
    );
  } else {
    const send = (field: string, value: string): void =>
      ctx.postAction("editRegress", { field, value });
    const simIn = h("input", "prop");
    simIn.value = rg.simulator ?? "";
    simIn.placeholder = "xcelium";
    simIn.addEventListener("change", () => send("simulator", simIn.value));
    ctx.root.append(tbPropRow("Simulator", simIn));

    const flIn = h("input", "prop");
    flIn.value = rg.filelist ?? "";
    flIn.placeholder = "../sim/xrun.f";
    flIn.addEventListener("change", () => send("filelist", flIn.value));
    ctx.root.append(tbPropRow("Filelist", flIn));

    const sdIn = h("input", "prop");
    sdIn.type = "number";
    sdIn.min = "1";
    sdIn.value = String(rg.seeds ?? 1);
    sdIn.addEventListener("change", () => send("seeds", sdIn.value));
    ctx.root.append(tbPropRow("Seeds", sdIn));

    ctx.root.append(
      tbPropRow(
        "Merge coverage",
        tbSelect(
          [
            ["true", "Yes"],
            ["false", "No"],
          ],
          rg.coverage === false ? "false" : "true",
          (v) => send("coverage", v)
        )
      )
    );
    ctx.root.append(
      button(
        seeded
          ? `Remove regression (${seeded} test seed count(s) go too)`
          : "Remove regression",
        true,
        () => ctx.postAction("toggleRegress", { value: "false" }),
        true
      )
    );
  }

}

/**
 * The reset-domains editor (docs/07 line 3, P4b). Same union shape as the clocks, plus
 * two invariants clocks do not have: under a LIST `dut.reset` names a declared DOMAIN
 * (not a port), and a domain's `clock:` gate must name a declared clock domain. The
 * single mapping also has an `external` flag the list form does not — so converting an
 * external reset is refused host-side rather than silently dropping it.
 */
function tbResetDomains(cfg: QuvmConfig): void {
  const reset = cfg.reset;
  const isList = Array.isArray(reset);
  const single = (isList ? undefined : reset) as
    | { active_low?: boolean; external?: boolean }
    | undefined;
  const domains: { name?: string; active_low?: boolean; clock?: string }[] = isList
    ? (reset as { name?: string }[])
    : [{ name: cfg.dut?.reset || "rst_n", active_low: single?.active_low }];
  const clocks = Array.isArray(cfg.clock)
    ? (cfg.clock as { name?: string }[])
        .map((c) => c.name)
        .filter((n): n is string => Boolean(n))
    : [];

  if (!cfg.dut?.reset) {
    ctx.root.append(h("div", "dim", "no reset port on the DUT"));
    return;
  }

  for (const d of domains) {
    const name = d.name || "rst_n";
    ctx.root.append(h("div", "prop-group", name));
    const send = (field: string, value: string): void =>
      ctx.postAction("editReset", { op: "set", name, field, value });

    ctx.root.append(
      tbPropRow(
        "Polarity",
        tbSelect(
          [
            ["true", "Active low"],
            ["false", "Active high"],
          ],
          d.active_low === false ? "false" : "true",
          (v) => send("active_low", v)
        )
      )
    );
    if (isList) {
      const nameIn = h("input", "prop");
      nameIn.value = name;
      nameIn.title = "renaming follows through to dut.reset and any agent gated by it";
      nameIn.addEventListener("change", () => send("name", nameIn.value));
      ctx.root.append(tbPropRow("Name", nameIn));
      if (clocks.length) {
        // the gate must name a DECLARED clock domain, so only those are offered
        ctx.root.append(
          tbPropRow(
            "Clock gate",
            tbSelect(
              [["", "— none —"], ...clocks.map((c) => [c, c] as const)],
              d.clock ?? "",
              (v) => send("clock", v)
            )
          )
        );
      }
      const users = (cfg.agents ?? []).filter((a) => a.reset === name).map((a) => a.name);
      const boundToDut = cfg.dut?.reset === name;
      ctx.root.append(
        button(
          boundToDut
            ? `Bound to dut.reset`
            : users.length
              ? `In use by ${users.join(", ")}`
              : `Remove ${name}`,
          domains.length > 1 && !boundToDut && users.length === 0,
          () => ctx.postAction("editReset", { op: "remove", name }),
          true
        )
      );
    } else {
      ctx.root.append(
        tbPropRow(
          "Driven by",
          tbSelect(
            [
              ["false", "The testbench"],
              ["true", "The environment/DUT (external)"],
            ],
            single?.external ? "true" : "false",
            (v) => send("external", v)
          )
        )
      );
    }
  }

  ctx.root.append(
    button("Add reset domain…", true, () => ctx.postAction("editReset", { op: "add" }), true)
  );
  if (single?.external) {
    ctx.root.append(
      h("div", "note", "an external reset cannot become a domain list (list entries have no `external`)")
    );
  }
  if (isList && domains.length === 1) {
    ctx.root.append(
      button("Back to a single reset", true, () => ctx.postAction("editReset", { op: "collapse" }), true)
    );
  }
}

/**
 * The clock-domains editor (docs/07 line 3, P4). `clock:` is either a single MAPPING
 * or a LIST of domains — different modes (a list engages per-domain clkgen/nets), so
 * a 1-element list is NOT a mapping. Adding the first domain converts mapping → list;
 * collapsing a 1-element list goes back. Per-agent domain assignment lives in the
 * agent inspector (P1); this authors the domains it chooses from.
 */
function tbClockDomains(cfg: QuvmConfig): void {
  const clock = cfg.clock;
  const isList = Array.isArray(clock);
  const domains: { name?: string; period?: number; unit?: string; source?: string }[] =
    isList
      ? (clock as { name?: string }[])
      : [
          {
            name: cfg.dut?.clock || "clk",
            period: (clock as { period?: number })?.period,
            unit: (clock as { unit?: string })?.unit,
          },
        ];

  for (const d of domains) {
    const name = d.name || "clk";
    ctx.root.append(h("div", "prop-group", name));
    const send = (field: string, value: string): void =>
      // a single mapping is addressed by any name; a list domain by its own
      ctx.postAction("editClock", { op: "set", name, field, value });

    const perIn = h("input", "prop");
    perIn.type = "number";
    perIn.min = "1";
    perIn.value = d.period != null ? String(d.period) : "";
    perIn.placeholder = "10";
    perIn.addEventListener("change", () => send("period", perIn.value));
    ctx.root.append(tbPropRow("Period", perIn));

    ctx.root.append(
      tbPropRow(
        "Unit",
        tbSelect(
          ["fs", "ps", "ns", "us", "ms", "s"].map((u) => [u, u] as const),
          d.unit ?? "ns",
          (v) => send("unit", v)
        )
      )
    );
    ctx.root.append(
      tbPropRow(
        "Source",
        tbSelect(
          [
            ["tb", "TB drives it"],
            ["dut", "DUT outputs it"],
          ],
          d.source ?? "tb",
          (v) => send("source", v)
        )
      )
    );
    if (isList) {
      const nameIn = h("input", "prop");
      nameIn.value = name;
      nameIn.addEventListener("change", () => send("name", nameIn.value));
      ctx.root.append(tbPropRow("Name", nameIn));
      // a domain in use by an agent cannot be removed (the agent inspector reassigns)
      const users = (cfg.agents ?? []).filter((a) => a.clock === name).map((a) => a.name);
      const del = button(
        users.length ? `In use by ${users.join(", ")}` : `Remove ${name}`,
        domains.length > 1 && users.length === 0,
        () => ctx.postAction("editClock", { op: "remove", name }),
        true
      );
      ctx.root.append(del);
    }
  }

  ctx.root.append(
    button("Add clock domain…", true, () => ctx.postAction("editClock", { op: "add" }), true)
  );
  if (isList && domains.length === 1) {
    ctx.root.append(
      button("Back to a single clock", true, () => ctx.postAction("editClock", { op: "collapse" }), true)
    );
  }
}

/**
 * The `tests[]` editor (docs/07 P2). Two QuickUVM rules are surfaced rather than
 * discovered at generate time: `seeds` is only legal with a `regress:` block, and
 * removing the LAST test drops the whole key so the bench falls back to the runnable
 * default `test1` (writing `tests: []` instead is accepted and yields a bench with
 * nothing to run — verified against the generator).
 */
function tbTestsEditor(cfg: QuvmConfig): void {
  const tests = cfg.tests ?? [];
  if (!tests.length) {
    ctx.root.append(h("div", "dim", "no tests declared — QuickUVM generates the default test1"));
  }
  const vseqs = (cfg.virtual_sequences ?? [])
    .map((v) => v.name)
    .filter((n): n is string => Boolean(n));
  for (const t of tests) {
    const name = t.name;
    if (!name) {
      continue;
    }
    const send = (field: string, value: string): void =>
      ctx.postAction("editTest", { name, field, value });
    ctx.root.append(h("div", "prop-group", name));

    const itemsIn = h("input", "prop");
    itemsIn.type = "number";
    itemsIn.min = "0";
    itemsIn.value = t.num_items != null ? String(t.num_items) : "";
    itemsIn.placeholder = "100";
    itemsIn.addEventListener("change", () => send("num_items", itemsIn.value));
    ctx.root.append(tbPropRow("Items", itemsIn));

    if (vseqs.length) {
      ctx.root.append(
        tbPropRow(
          "Vseq",
          tbSelect(
            [["", "— none —"], ...vseqs.map((v) => [v, v] as const)],
            t.vseq ?? "",
            (v) => send("vseq", v)
          )
        )
      );
    }

    const seedsIn = h("input", "prop");
    seedsIn.type = "number";
    seedsIn.min = "1";
    seedsIn.value = t.seeds != null ? String(t.seeds) : "";
    // seeds is the per-test seed count of the regression matrix: QuickUVM rejects it
    // without a `regress:` block, so the row is inert until one exists
    seedsIn.disabled = !cfg.regress;
    seedsIn.placeholder = cfg.regress ? "regress.seeds" : "needs a regression block";
    seedsIn.addEventListener("change", () => send("seeds", seedsIn.value));
    ctx.root.append(tbPropRow("Seeds", seedsIn));

    ctx.root.append(
      button(`Delete ${name}`, true, () => ctx.postAction("removeTest", { name }), true)
    );
  }
  ctx.root.append(button("Add test…", true, () => ctx.postAction("addTest", {}), true));
}

/**
 * Bench identity + project metadata (docs/07 P2). `layout` and `kind` options that
 * QuickUVM would refuse are DISABLED with the reason shown — `benchid.ts` computes
 * them (subenvs need packaged, C3 `instances` need flat, a VIP drops every
 * bench-layer section). The host re-checks before writing, so the two cannot drift.
 */
function tbBenchIdentity(cfg: QuvmConfig): void {
  const send = (field: string, value: string): void =>
    ctx.postAction("editBench", { field, value });

  /** a select whose blocked options are disabled; the reasons are listed below it */
  const guarded = (
    label: string,
    field: string,
    options: readonly (readonly [string, string])[],
    cur: string,
    blockersFor: (v: string) => string[]
  ): void => {
    const sel = h("select", "prop");
    const reasons: string[] = [];
    for (const [v, lbl] of options) {
      const why = v === cur ? [] : blockersFor(v);
      const o = h("option", "", lbl);
      o.value = v;
      o.selected = v === cur;
      o.disabled = why.length > 0;
      sel.append(o);
      reasons.push(...why);
    }
    sel.addEventListener("change", () => send(field, sel.value));
    ctx.root.append(tbPropRow(label, sel));
    for (const r of [...new Set(reasons)]) {
      ctx.root.append(h("div", "note", r));
    }
  };

  guarded(
    "Layout",
    "layout",
    [
      ["flat", "Flat (one tb package)"],
      ["packaged", "Packaged (per-agent packages)"],
    ],
    cfg.layout ?? "flat",
    (v) => layoutBlockers(cfg, v as "flat" | "packaged")
  );
  guarded(
    "Kind",
    "kind",
    [
      ["bench", "Bench"],
      ["vip", "VIP (reusable agent packages)"],
      ["selftest", "Self-test (DUT-less loopback)"],
    ],
    cfg.kind ?? "bench",
    (v) => kindBlockers(cfg, v as "bench" | "vip" | "selftest")
  );

  const topIn = h("input", "prop");
  topIn.value = cfg.top_name ?? "";
  topIn.placeholder = "tb_top";
  topIn.addEventListener("change", () => send("top_name", topIn.value));
  ctx.root.append(tbPropRow("Top name", topIn));

  ctx.root.append(
    tbPropRow(
      "Auto vseq",
      tbSelect(
        [
          ["true", "On"],
          ["false", "Off"],
        ],
        cfg.auto_virtual_sequences === false ? "false" : "true",
        (v) => send("auto_virtual_sequences", v)
      )
    )
  );
  if (cfg.auto_virtual_sequences !== false) {
    ctx.root.append(
      tbPropRow(
        "Auto mode",
        tbSelect(
          [
            ["parallel", "Parallel"],
            ["sequential", "Sequential"],
          ],
          cfg.auto_vseq_mode ?? "parallel",
          (v) => send("auto_vseq_mode", v)
        )
      )
    );
  }

  for (const [label, field, cur, placeholder] of [
    ["Project", "project.name", cfg.project?.name ?? "", "required"],
    ["Author", "project.author", cfg.project?.author ?? "", ""],
    ["Version", "project.version", cfg.project?.version ?? "", "0.1.0"],
  ] as const) {
    const inp = h("input", "prop");
    inp.value = cur;
    inp.placeholder = placeholder;
    inp.addEventListener("change", () => send(field, inp.value));
    ctx.root.append(tbPropRow(label, inp));
  }
  ctx.root.append(
    tbPropRow(
      "UVM",
      tbSelect(
        [
          ["1.2", "1.2"],
          ["1.1d", "1.1d"],
        ],
        cfg.project?.uvm_version ?? "1.2",
        (v) => send("project.uvm_version", v)
      )
    )
  );
}

/**
 * The open/closed state of the inspector's disclosures, remembered across renders and
 * reloads (an "Advanced" the user opened must stay open while they work in it).
 * Keyed by a stable section id, NOT by the selected component: the preference is
 * "I want agent advanced fields", not "…for this one agent".
 */
const openSections = new Set<string>(ctx.vscode.getState()?.openSections ?? []);

function persistSections(): void {
  ctx.vscode.setState({
    viewId: ctx.state.viewId,
    mode: ctx.state.mode,
    openSections: [...openSections],
  });
}

/**
 * A collapsible inspector section. `id` is the persistence key; `defaultOpen` decides
 * the first-run state — the "simple by default" half of the UX rule, so everything
 * advanced starts closed. The body is rendered lazily on open, so a closed section
 * costs one row.
 */
function tbSection(
  id: string,
  title: string,
  render: () => void,
  defaultOpen = false
): void {
  const open = openSections.has(id) || (defaultOpen && !openSections.has(`!${id}`));
  const head = h("div", "sec-head");
  head.append(h("span", "sec-twisty", open ? "▾" : "▸"), h("span", "", title));
  head.addEventListener("click", () => {
    // both states are recorded, so a closed default-open section stays closed
    if (open) {
      openSections.delete(id);
      openSections.add(`!${id}`);
    } else {
      openSections.add(id);
      openSections.delete(`!${id}`);
    }
    persistSections();
    renderInspector(ctx);
  });
  ctx.root.append(head);
  if (open) {
    render();
  }
}

/** A `<select>` bound to one agent field: options `[value, label]`, `cur` preselected. */
function tbSelect(
  options: readonly (readonly [string, string])[],
  cur: string,
  onChange: (v: string) => void
): HTMLSelectElement {
  const sel = h("select", "prop");
  for (const [v, lbl] of options) {
    const o = h("option", "", lbl);
    o.value = v;
    o.selected = v === cur;
    sel.append(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

/**
 * The subenv property editor (docs/07 line 3, P5): per-instance class NAMESPACING.
 *
 * The default (`namespace` absent) is AUTO, and it is the interesting one: QuickUVM
 * prefixes an instance's class names only when the SAME `config` path is composed
 * twice or more, so a block used once stays byte-identical. Forcing it on/off is for
 * the cases auto cannot see — and `false` means a genuine collision fails closed
 * rather than being silently renamed.
 */
function tbSubenvEditor(name: string): void {
  const sub = (ctx.state.config?.subenvs ?? []).find((s) => s.name === name);
  if (!sub) {
    return;
  }
  const shared =
    (ctx.state.config?.subenvs ?? []).filter((s) => s.config === sub.config).length > 1;
  const ns = sub.namespace;
  const cur =
    ns === undefined ? "auto" : ns === true ? "on" : ns === false ? "off" : "custom";
  ctx.root.append(h("h3", "", "Subenv properties"));
  ctx.root.append(
    tbPropRow(
      "Namespace",
      tbSelect(
        [
          ["auto", `Auto (${shared ? "prefixed: config reused" : "no prefix: used once"})`],
          ["on", "Force (prefix = subenv name)"],
          ["custom", typeof ns === "string" ? `Custom: ${ns}` : "Custom prefix…"],
          ["off", "Off (a collision then fails)"],
        ],
        cur,
        (v) => ctx.postAction("editSubenvNamespace", { subenv: name, mode: v })
      )
    )
  );
  if (ns === false) {
    ctx.root.append(
      h("div", "note", "namespacing is off — a genuine class-name collision will fail the generate")
    );
  }
}

/**
 * Per-port depth on the agent inspector (docs/07 line 3, P4c): width, randomize, a
 * constraint expression, a symbolic `enum`, and — on INOUTS — the open-drain pair.
 *
 * Two QuickUVM couplings shape the rows: an open-drain line is 1 bit and needs
 * `pullup: true` (with none it floats to X the moment every driver releases, which
 * the validator calls out as "not a style preference"), and enum/type/packed_dims/
 * struct are exclusive type specifiers. The host op enforces both, so the disabled
 * controls and the op cannot drift apart.
 */
function tbAgentPorts(agent: QuvmAgent): void {
  const name = agent.name;
  if (!name) {
    return;
  }
  const groups: ["in" | "out" | "inout", QuvmPort[]][] = [
    ["in", agent.ports?.inputs ?? []],
    ["out", agent.ports?.outputs ?? []],
    ["inout", (agent.ports as { inouts?: QuvmPort[] })?.inouts ?? []],
  ];
  if (!groups.some(([, ps]) => ps.length)) {
    return;
  }
  const count = groups.reduce((n, [, ps]) => n + ps.length, 0);

  /** one port's rows, by id — `advancedOnly` renders the second half */
  const renderPort = (p: QuvmPort, ids: string[]): void => {
    const port = p.name as string;
    const send = (field: string, value: string): void =>
      ctx.postAction("editAgentPort", { agent: name, port, field, value });
    const rich = p as {
      constraint?: string;
      enum?: Record<string, number>;
      open_drain?: boolean;
      pullup?: boolean;
    };
    for (const id of ids) {
      switch (id) {
        case "width": {
          const wIn = h("input", "prop");
          wIn.type = "number";
          wIn.min = "1";
          wIn.value = String(p.width ?? 1);
          wIn.addEventListener("change", () => send("width", wIn.value));
          ctx.root.append(tbPropRow("Width", wIn));
          break;
        }
        case "randomize":
          ctx.root.append(
            tbPropRow(
              "Randomize",
              tbSelect(
                [
                  ["true", "Yes"],
                  ["false", "No"],
                ],
                p.randomize === false ? "false" : "true",
                (v) => send("randomize", v)
              )
            )
          );
          break;
        case "constraint": {
          const cIn = h("input", "prop");
          cIn.value = rich.constraint ?? "";
          cIn.placeholder = "e.g. op inside {[0:2]}";
          cIn.addEventListener("change", () => send("constraint", cIn.value));
          ctx.root.append(tbPropRow("Constraint", cIn));
          break;
        }
        case "enum": {
          // black box by design: QuickUVM generates the TESTBENCH's own enum
          const eIn = h("input", "prop");
          eIn.value = Object.entries(rich.enum ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          eIn.placeholder = "IDLE=0, BUSY=1";
          eIn.addEventListener("change", () => send("enum", eIn.value));
          ctx.root.append(tbPropRow("Enum", eIn));
          break;
        }
        case "type_specifier_hint":
          ctx.root.append(
            h("div", "note", "declares packed_dims/struct — the type specifiers are exclusive")
          );
          break;
        case "open_drain":
          ctx.root.append(
            tbPropRow(
              "Drive",
              tbSelect(
                [
                  ["false", "Tri-state (drives both levels)"],
                  ["true", "Open drain"],
                ],
                rich.open_drain ? "true" : "false",
                (v) => send("open_drain", v)
              )
            )
          );
          break;
        case "pullup":
          // mandatory once open drain is on: it is a statement, not a choice
          ctx.root.append(
            tbPropRow("Pullup", h("div", "dim", "on (an open-drain line never drives high)"))
          );
          break;
        default:
          break;
      }
    }
  };

  tbSection(
    "agent.ports",
    `Ports (${count})`,
    () => {
      for (const [kind, ports] of groups) {
        for (const p of ports) {
          if (!p.name) {
            continue;
          }
          const rows = portRows(kind, p);
          ctx.root.append(h("div", "prop-group", `${p.name} (${kind})`));
          renderPort(p, rows.basic);
          tbSection(`port.advanced.${name}.${p.name}`, "More", () =>
            renderPort(p, rows.advanced)
          );
        }
      }
    },
    true
  );
}

/**
 * The property editor of an agent (docs/07 line 3, P1). Until now an agent could be
 * CREATED but never EDITED — every reactive/hybrid/replica knob meant hand-editing
 * the YAML.
 *
 * The rows mirror QuickUVM's own coupling rules (schema reference §1.5), which are
 * hard validator walls, not conventions: the responder-only keys are DISABLED on an
 * initiator, `reorder_*` only under `respond: pipelined`, `proactive` only under
 * `on_request`. Editing a field that would orphan another also cascades the deletion
 * host-side (`setAgentField`), so the inspector cannot write a config that
 * quick-uvm then refuses.
 */
function tbAgentEditor(agent: QuvmAgent): void {
  const name = agent.name;
  if (!name) {
    return; // without a name we cannot identify it for editing
  }
  const send = (field: string, value: string): void =>
    ctx.postAction("editAgent", { name, field, value });

  const sampled = agent.ports?.outputs ?? []; // DUT-driven: what the agent samples
  const driven = agent.ports?.inputs ?? []; //   what the agent drives
  const oneBitSampled = sampled.filter((p: QuvmPort) => (p.width ?? 1) === 1 && p.name);
  // which rows are worth showing at all — the tested rule, not an inline condition
  const rows = agentRows(agent);

  /** render one property row by id; unknown ids are simply not rendered */
  const row = (id: string): void => {
    switch (id) {
      case "active":
        ctx.root.append(
          tbPropRow(
            "Role",
            tbSelect(
              [
                ["true", "Active (drives + monitors)"],
                ["false", "Passive (monitors only)"],
              ],
              agent.active === false ? "false" : "true",
              (v) => send("active", v)
            )
          )
        );
        break;
      case "mode":
        // the discovery point for every responder knob below
        ctx.root.append(
          tbPropRow(
            "Mode",
            tbSelect(
              [
                ["initiator", "Initiator (drives stimulus)"],
                ["responder", "Responder (answers the DUT)"],
              ],
              agent.mode ?? "initiator",
              (v) => {
                send("mode", v);
                if (
                  v === "responder" &&
                  !agent.request_valid &&
                  oneBitSampled.length === 1
                ) {
                  send("request_valid", oneBitSampled[0].name as string);
                }
              }
            )
          )
        );
        break;
      case "seq_item_style":
        ctx.root.append(
          tbPropRow(
            "Seq item style",
            tbSelect(
              [
                ["manual", "Manual"],
                ["field_macros", "Field macros"],
              ],
              agent.seq_item_style ?? "manual",
              (v) => send("seq_item_style", v)
            )
          )
        );
        break;
      case "respond":
        ctx.root.append(
          tbPropRow(
            "Respond",
            tbSelect(
              [
                ["on_request", "On request (blocking)"],
                ["prefetch", "Prefetch"],
                ["combinational", "Combinational"],
                ["pipelined", "Pipelined (out-of-order)"],
              ],
              agent.respond ?? "on_request",
              (v) => send("respond", v)
            )
          )
        );
        break;
      case "request_valid": {
        // a SAMPLED 1-bit port: the qualifier the DUT asserts
        ctx.root.append(
          tbPropRow(
            "Request valid",
            tbSelect(
              [
                ["", "— none —"],
                ...oneBitSampled.map(
                  (p: QuvmPort) => [p.name as string, p.name as string] as const
                ),
              ],
              agent.request_valid ?? "",
              (v) => send("request_valid", v)
            )
          )
        );
        if (!agent.request_valid) {
          ctx.root.append(
            h(
              "div",
              "note",
              oneBitSampled.length
                ? "required: the sampled 1-bit port meaning “the DUT issued a request”"
                : "this agent has no 1-bit sampled (output) port — a responder needs one"
            )
          );
        }
        break;
      }
      case "request_ready":
        // the READY half may be driven (a slave's arready) or sampled
        ctx.root.append(
          tbPropRow(
            "Request ready",
            tbSelect(
              [
                ["", "— none —"],
                ...[...sampled, ...driven]
                  .filter((p: QuvmPort) => p.name && p.name !== agent.request_valid)
                  .map((p: QuvmPort) => [p.name as string, p.name as string] as const),
              ],
              agent.request_ready ?? "",
              (v) => send("request_ready", v)
            )
          )
        );
        break;
      case "reorder_by":
        ctx.root.append(
          tbPropRow(
            "Reorder by",
            tbSelect(
              [
                ["", "— none —"],
                ...sampled
                  .filter(
                    (p: QuvmPort) =>
                      p.name && p.name !== agent.request_valid && (p.width ?? 1) <= 31
                  )
                  .map((p: QuvmPort) => [p.name as string, p.name as string] as const),
              ],
              agent.reorder_by ?? "",
              (v) => send("reorder_by", v)
            )
          )
        );
        if (!agent.reorder_by) {
          ctx.root.append(
            h("div", "note", "required: the sampled ID field keying the per-ID queues")
          );
        }
        break;
      case "reorder_policy":
        ctx.root.append(
          tbPropRow(
            "Reorder policy",
            tbSelect(
              [
                ["priority", "Priority"],
                ["round_robin", "Round robin"],
                ["random", "Random"],
              ],
              agent.reorder_policy ?? "priority",
              (v) => send("reorder_policy", v)
            )
          )
        );
        break;
      case "proactive":
        ctx.root.append(
          tbPropRow(
            "Proactive",
            tbSelect(
              [
                ["false", "No"],
                ["true", "Yes (hybrid)"],
              ],
              agent.proactive ? "true" : "false",
              (v) => send("proactive", v)
            )
          )
        );
        break;
      case "replicas": {
        const repIn = h("input", "prop");
        repIn.type = "number";
        repIn.min = "1";
        repIn.value = String(agent.replicas ?? 1);
        repIn.addEventListener("change", () => send("replicas", repIn.value));
        ctx.root.append(tbPropRow("Replicas", repIn));
        if ((agent.replicas ?? 1) > 1) {
          ctx.root.append(
            h("div", "note", "replicas needs reset: {external: true} — a shared vectored DUT binds the top reset")
          );
        }
        break;
      }
      default:
        break;
    }
  };

  ctx.root.append(h("h3", "", "Agent properties"));
  for (const id of rows.basic) {
    row(id);
  }

  // clock/reset domains: only meaningful when they were DECLARED AS LISTS (M1) —
  // a 1-element list is still multi-domain, so the gate is "is it a list?"
  const domains = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .map((d) => (d as { name?: string })?.name)
          .filter((n): n is string => Boolean(n))
      : [];
  const clockDomains = domains(ctx.state.config?.clock);
  const resetDomains = domains(ctx.state.config?.reset);

  if (rows.advanced.length || clockDomains.length || resetDomains.length) {
    tbSection("agent.advanced", "Advanced", () => {
      for (const id of rows.advanced) {
        row(id);
      }
      for (const [label, field, list, cur] of [
        ["Clock domain", "clock", clockDomains, agent.clock ?? ""],
        ["Reset domain", "reset", resetDomains, agent.reset ?? ""],
      ] as const) {
        if (!list.length) {
          continue; // single-domain bench: the per-agent selector would be noise
        }
        ctx.root.append(
          tbPropRow(
            label,
            tbSelect(
              [["", "— default —"], ...list.map((d) => [d, d] as const)],
              cur,
              (v) => send(field, v)
            )
          )
        );
      }
    });
  }

  tbAgentPorts(agent);
}

/**
 * The property editor of a scoreboard (slice 2): source/monitor/match/
 * match_key/max_latency, inline editing in the inspector -> the editScoreboard action
 * (one WorkspaceEdit per change; the diagram re-renders at config/full).
 * Empty field = reset to default (the host deletes the field from the YAML).
 */
function tbScoreboardEditor(sb: QuvmScoreboard): void {
  const name = sb.name;
  if (!name) {
    return; // without a name we cannot identify it for editing
  }
  // docs/07 P3c — on a COMPOSITION the endpoints also include the composed children's
  // agents, qualified `<subenv>.<agent>`; naming one is what makes this a cross-block
  // scoreboard. The child agents come from the host (they live in other files).
  const agents = scoreboardEndpoints(
    (ctx.state.config?.agents ?? []).map((a) => a.name),
    ctx.state.childAgents
  );
  // a hand-written endpoint we do not know about must still be selectable, or opening
  // the inspector would silently rewrite it to the first option
  for (const cur of [sb.source, sb.monitor]) {
    if (cur && !agents.includes(cur)) {
      agents.push(cur);
    }
  }
  const send = (field: string, value: string): void =>
    ctx.postAction("editScoreboard", { name, field, value });
  const src = (ctx.state.config?.agents ?? []).find((a) => a.name === sb.source);
  const sampled = (src?.ports?.outputs ?? [])
    .map((p: QuvmPort) => p.name)
    .filter((n): n is string => Boolean(n));
  const rows = scoreboardRows(sb);

  const row = (id: string): void => {
    switch (id) {
      case "source": {
        const srcSel = h("select", "prop");
        for (const a of agents) {
          // the source differs from the monitor (A2) — but keep the current source
          // visible even if a hand-written config has source == monitor
          if (a === sb.monitor && a !== sb.source) {
            continue;
          }
          const o = h("option", "", a);
          o.value = a;
          o.selected = a === sb.source;
          srcSel.append(o);
        }
        srcSel.addEventListener("change", () => send("source", srcSel.value));
        ctx.root.append(tbPropRow("Source", srcSel));
        break;
      }
      case "monitor": {
        // the stream count: the discovery point for match/match_key and for window
        const monSel = h("select", "prop");
        const none = h("option", "", "None (single-stream)");
        none.value = "";
        none.selected = !sb.monitor;
        monSel.append(none);
        for (const a of agents) {
          if (a === sb.source) {
            continue; // the monitor differs from the source (A2 two-stream)
          }
          const o = h("option", "", a);
          o.value = a;
          o.selected = a === sb.monitor;
          monSel.append(o);
        }
        monSel.addEventListener("change", () => send("monitor", monSel.value));
        ctx.root.append(tbPropRow("Monitor", monSel));
        break;
      }
      case "match":
        ctx.root.append(
          tbPropRow(
            "Match",
            tbSelect(
              [
                ["in_order", "In order"],
                ["out_of_order", "Out of order"],
              ],
              sb.match ?? "in_order",
              (v) => send("match", v)
            )
          )
        );
        break;
      case "match_key": {
        const keyIn = h("input", "prop");
        keyIn.value = sb.match_key ?? "";
        keyIn.placeholder = "key field";
        keyIn.addEventListener("change", () => send("match_key", keyIn.value));
        ctx.root.append(tbPropRow("Match key", keyIn));
        break;
      }
      case "max_latency": {
        const latIn = h("input", "prop");
        latIn.type = "number";
        latIn.min = "0";
        latIn.value = sb.max_latency != null ? String(sb.max_latency) : "";
        latIn.placeholder = "unbounded";
        latIn.addEventListener("change", () => send("max_latency", latIn.value));
        ctx.root.append(tbPropRow("Max latency", latIn));
        break;
      }
      case "window.boundary":
        // the boundary is a SAMPLED port of the source agent: the DUT strobe that
        // closes a window (single-stream only — a two-stream sb is strictly 1:1)
        ctx.root.append(
          tbPropRow(
            "Window on",
            tbSelect(
              [["", "— none —"], ...sampled.map((p) => [p, p] as const)],
              sb.window?.boundary ?? "",
              (v) => send("window.boundary", v)
            )
          )
        );
        break;
      case "window.length": {
        const lenIn = h("input", "prop");
        lenIn.type = "number";
        lenIn.min = "1";
        lenIn.value = String(sb.window?.length ?? 1);
        lenIn.addEventListener("change", () => send("window.length", lenIn.value));
        ctx.root.append(tbPropRow("Samples", lenIn));
        break;
      }
      case "reference_model.language":
        ctx.root.append(
          tbPropRow(
            "Predictor",
            tbSelect(
              [
                ["sv", "SystemVerilog"],
                ["c", "C (DPI bridge)"],
              ],
              sb.reference_model?.language ?? "sv",
              (v) => send("reference_model.language", v)
            )
          )
        );
        break;
      default:
        break;
    }
  };

  ctx.root.append(h("h3", "", "Scoreboard properties"));
  for (const id of rows.basic) {
    row(id);
  }
  if (rows.advanced.length) {
    tbSection("sb.advanced", "Advanced", () => {
      for (const id of rows.advanced) {
        row(id);
      }
    });
  }
}

/**
 * The deletable component of a selected TB node: `{kind, name, label}` or null.
 * The single source of truth for the Delete button in the inspector AND for the
 * Delete key — so that the id→name resolution cannot diverge between them. Returns null
 * for what is NOT deleted through a single gesture: `tbvsqr` (aggregates all
 * the sequences → per-sequence deletion in the inspector), DUT/Env/unit/subenv/probe
 * and the cross-block scoreboards `xsb:` or the ones without a name.
 */
export function tbDeleteTarget(
  node: TbScene["nodes"][number]
): { kind: string; name: string; label: string } | null {
  if (node.kind === "tbsb" && node.id.startsWith("sb:")) {
    const sb = ctx.state.config?.analysis?.scoreboards?.find(
      (s) => (s.name ?? "sbd") === node.label
    );
    return sb?.name
      ? { kind: "scoreboard", name: sb.name, label: "Delete scoreboard" }
      : null;
  }
  if (node.kind === "tbcov") {
    const agent = node.id.startsWith("cov:")
      ? node.id.slice(4)
      : node.label.replace(/_cov$/, "");
    return { kind: "coverage", name: agent, label: "Delete coverage" };
  }
  if (node.kind === "tbagent") {
    return { kind: "agent", name: node.label, label: "Delete agent…" };
  }
  return null;
}

/** The side inspector: configuration, DUT, agents, coverage, actions.
 *  Without own state: everything is derived from the model + overlay (invariant 2). */
export function renderInspector(c: InspectorCtx): void {
  ctx = c;
  if (!ctx.root) {
    return;
  }
  ctx.root.replaceChildren();
  const inst = ctx.state.viewId ? ctx.findInstance(ctx.state.viewId) : undefined;
  const ov = ctx.state.overlay;
  const matches = Boolean(ov && inst && ov.dut === inst.module);
  const sel = [...ctx.state.selection];
  const selNames = sel.map((s) => s.replace(/^<port>\./, ""));
  // the selectable pins for the agent gestures: the symbol's pins OR
  // the boundary flags from the schematic view — the ports of the view's module,
  // with the same stable IDs `<port>.x` (the restriction to the symbol was
  // a phase 2 legacy, not a design decision)
  const byName = new Map<string, { name: string; iface: boolean }>(
    ctx.pins.map((p) => [p.name, p])
  );
  if (ctx.state.mode === "schematic" && ctx.scene) {
    for (const b of ctx.scene.boundary) {
      byName.set(b.name, b);
    }
  }
  const selPins = selNames
    .map((n) => byName.get(n))
    .filter((p): p is { name: string; iface: boolean } => Boolean(p));
  // the pins of a CHILD BLOCK from the schematic = the ports of that block's module:
  // the agent gesture targets the block's config (the recursive flow, docs/03).
  // Conditions: no boundary pin in the selection and all pins of the same
  // instance (the folds are excluded — they have no single target instance)
  let childAgent:
    | { viewId: string; pins: { port: string; iface: boolean }[] }
    | null = null;
  if (ctx.state.mode === "schematic" && ctx.scene && selPins.length === 0) {
    const owners = new Set<string>();
    const pins: { port: string; iface: boolean }[] = [];
    for (const id of sel) {
      for (const n of ctx.scene.nodes) {
        const p = n.pins.find((sp) => sp.id === id);
        if (p) {
          owners.add(n.instPath ?? `fold:${n.id}`);
          if (n.kind === "instance" && n.instPath) {
            pins.push({ port: p.port, iface: p.iface });
          }
        }
      }
    }
    const owner = [...owners];
    if (pins.length > 0 && owner.length === 1 && !owner[0].startsWith("fold:")) {
      childAgent = { viewId: owner[0], pins };
    }
  }
  const roles = matches && ov ? ov.roles : {};

  ctx.root.append(
    h("h3", "", "QuickUVM configuration"),
    h("div", "cfgpath",
      ov?.configPath ?? 'no configuration yet — "Set as DUT" creates one')
  );
  if (ctx.state.mode !== "tb" && ctx.tbAvailable()) {
    ctx.root.append(
      button("Open verification view", true, () => ctx.openTbView(), true)
    );
  }

  if (ov?.dut) {
    ctx.root.append(h("h3", "", "DUT"), h("div", "", ov.dut));
    if (inst && ov.dut !== inst.module) {
      ctx.root.append(
        h("div", "note",
          `current view shows "${inst.module}" — the overlay only applies ` +
            "to the DUT's views")
      );
    }
  }

  if (ov && ov.agents.length) {
    ctx.root.append(h("h3", "", `Agents (${ov.agents.length})`));
    const ul = h("ul", "agents");
    for (const a of ov.agents) {
      const li = h("li", "");
      li.append(
        h("span", `swatch agent-c${a.color}`),
        h("span", "", ` ${a.name} `),
        h("span", "dim", `(${a.pins.length} pins)`)
      );
      li.title = a.pins.join(", ");
      li.addEventListener("click", () => ctx.onSelectPins(a.pins));
      ul.append(li);
    }
    ctx.root.append(ul);
  }

  if (matches && ov) {
    ctx.root.append(
      h("h3", "", "Coverage"),
      h("div", "", `${ov.coverage.mapped}/${ov.coverage.total} ports mapped`)
    );
    if (ov.coverage.unmapped.length) {
      ctx.root.append(h("div", "dim", "unmapped:"));
      const ul = h("ul", "unmapped");
      for (const n of ov.coverage.unmapped) {
        const li = h("li", "", n);
        li.addEventListener("click", () => ctx.onSelectPins([n]));
        ul.append(li);
      }
      ctx.root.append(ul);
    }
    if (ov.orphans.length) {
      ctx.root.append(
        h("h3", "", "Orphans in YAML"),
        h("div", "note", ov.orphans.join(", "))
      );
    }
  }

  if (ctx.state.mode === "tb") {
    const selNode = ctx.tbScene?.nodes.find((n) =>
      ctx.state.selection.has(n.id)
    );
    // the selected agent preloads the source of the add gestures (docs/05)
    const selAgent = selNode?.kind === "tbagent" ? selNode.label : undefined;
    if (selNode) {
      ctx.root.append(
        h("h3", "", "Component"),
        h("div", "", selNode.label)
      );
      if (selNode.stereotype) {
        ctx.root.append(h("div", "dim", selNode.stereotype));
      }
      if (selNode.drill) {
        const target = selNode.drill;
        ctx.root.append(
          button("Open (double-click)", true, () => ctx.onOpen(target), true)
        );
      }
      // flip (docs/04): H = the west<->east sides of the ports, V = the order
      ctx.root.append(
        button("Flip horizontal (H)", true, () => ctx.onFlip(selNode.id, "h"), true),
        button("Flip vertical (V)", true, () => ctx.onFlip(selNode.id, "v"), true)
      );
      // editing + deletion per component type (slice 2). Scoreboard/coverage/
      // vseq are leaves; the agent falls in cascade (host: modal confirmation).
      const del = (kind: string, dname: string): void =>
        ctx.postAction("deleteComponent", { kind, name: dname });
      // the property editor (only the scoreboards from `analysis`, id `sb:`;
      // NOT the cross-block ones `xsb:` = analysis.scoreboards with qualified endpoints)
      if (selNode.kind === "tbsb" && selNode.id.startsWith("sb:")) {
        const sb = ctx.state.config?.analysis?.scoreboards?.find(
          (s) => (s.name ?? "sbd") === selNode.label
        );
        if (sb?.name) {
          tbScoreboardEditor(sb);
        }
      } else if (selNode.kind === "tbsubenv") {
        // docs/07 P5 — per-instance class namespacing (H1 reuse)
        tbSubenvEditor(selNode.label);
      } else if (selNode.kind === "tbcov") {
        // docs/07 P3b — the rich coverage model behind this collector
        const covAgent = selNode.id.startsWith("cov:")
          ? selNode.id.slice(4)
          : selNode.label.replace(/_cov$/, "");
        tbCoverageEditor(covAgent);
      } else if (selNode.kind === "tbagent") {
        // docs/07 line 3 (P1) — an agent can now be EDITED, not only created
        const ag = ctx.state.config?.agents?.find((a) => a.name === selNode.label);
        if (ag?.name) {
          tbAgentEditor(ag);
        }
      }
      // Delete button — the SAME id->name resolution as the Delete key on the diagram
      // (tbDeleteTarget), so they cannot diverge from each other
      const dt = tbDeleteTarget(selNode);
      if (dt) {
        ctx.root.append(button(dt.label, true, () => del(dt.kind, dt.name), true));
      }
      // vsqr / probes aggregate ALL their entries: deletion is per-entry (the Delete
      // key on them has no single target, so the buttons remain the only way here)
      if (selNode.kind === "tbvsqr") {
        for (const v of ctx.state.config?.virtual_sequences ?? []) {
          const vn = v.name;
          if (vn) {
            ctx.root.append(
              button(`Delete ${vn}`, true, () => del("vseq", vn), true)
            );
          }
        }
      } else if (selNode.kind === "tbprobe") {
        for (const p of ctx.state.config?.probes ?? []) {
          const pn = p.name;
          if (pn) {
            ctx.root.append(
              button(`Delete ${pn}`, true, () => del("probe", pn), true)
            );
          }
        }
      }
    }
    // selected boundary flag: LOCAL horizontal flip (mirrors the
    // shape + moves the anchor to the opposite side of the flag, without changing its
    // ELK position/side). On an inout flag (hexagon) it moves only the anchored tip.
    const selB = !selNode
      ? ctx.tbScene?.boundary.find((b) => ctx.state.selection.has(b.id))
      : undefined;
    if (selB) {
      ctx.root.append(
        h("h3", "", "Boundary"),
        h("div", "", selB.label),
        h("div", "dim",
          selB.dir === "inout"
            ? "bidirectional interface"
            : selB.dir === "out"
              ? "output (to level above)"
              : "input (from level above)"),
        button("Flip horizontal (H)", true, () => ctx.onFlip(selB.id, "h"), true)
      );
    }
    // the add palette (slice 2, docs/05): the connections are not free
    // edges in QuickUVM — source/monitor are fields, so "add" creates the
    // component ALREADY connected (the selected agent preloads the source)
    const hasAgents = Boolean(ctx.state.config?.agents?.length);
    const hasActive = Boolean(
      ctx.state.config?.agents?.some((a) => a.active !== false)
    );
    ctx.root.append(h("h3", "", "Add component"));
    ctx.root.append(
      button(
        selAgent ? `Coverage for ${selAgent}` : "Coverage collector",
        hasAgents,
        () => ctx.postAction("addCoverage", selAgent ? { agent: selAgent } : {}),
        true
      ),
      button(
        selAgent ? `Scoreboard from ${selAgent}` : "Scoreboard",
        hasAgents,
        () => ctx.postAction("addScoreboard", selAgent ? { source: selAgent } : {}),
        true
      ),
      button("Virtual sequence", hasActive,
        () => ctx.postAction("addVirtualSequence", {}), true),
      // docs/07 P5 — consume an agent BY REFERENCE from a generated VIP (F2'):
      // its source is never regenerated, the VIP's filelist is chained instead
      button("VIP agent (by reference)…", true,
        () => ctx.postAction("addVipAgent", {}), true)
    );
    // The bench-level sections belong to the BENCH, not to a component, so they show
    // only in bench scope — no component selected, which is exactly what selecting the
    // verification tree's root node produces (its selectId is null). Previously they
    // rendered under every selection, which is what made the inspector a wall.
    if (ctx.state.config && isBenchScope(selNode?.kind)) {
      tbBenchSettings(ctx.state.config);
    }
    ctx.root.append(h("h3", "", "Actions"));
    ctx.root.append(
      button("Generate testbench", Boolean(ov?.dut), () =>
        ctx.postAction("generate", {})
      )
    );
    return;
  }

  if (ctx.state.mode === "schematic" && ctx.state.model && ctx.state.viewId) {
    const nets = ctx.state.model.views[ctx.state.viewId]?.nets ?? [];
    // the net is selected through the wire/label (data-id = the net's name), BUT also
    // from a pin/flag: on a selection of ONE pin we derive its net, so that
    // the wire/label toggle is discoverable from any endpoint (observation at
    // validation — B1)
    let selNet = nets.find((n) => ctx.state.selection.has(n.name));
    if (!selNet && ctx.state.selection.size === 1) {
      const nm = ctx.netOfPin([...ctx.state.selection][0]);
      selNet = nm ? nets.find((n) => n.name === nm) : undefined;
    }
    if (selNet) {
      const ov = ctx.sidecar?.views?.[ctx.state.viewId ?? ""]?.nets?.[selNet.name];
      const effective = ov?.render ?? selNet.render;
      ctx.root.append(
        h("h3", "", "Net"),
        h("div", "", selNet.name),
        h("div", "dim",
          `fan-out ${selNet.fanout} — shown as ${effective}` +
            (ov ? " (override)" : ""))
      );
      ctx.root.append(
        button(
          effective === "wire" ? "Show as label" : "Show as wire",
          true,
          () => ctx.toggleNetRender(selNet.name),
          true
        )
      );
      // whitebox probe (K2, slice 3): the XMR path and the width are derived from the model
      // on the host (src/probe.ts) — the webview sends only (viewId, net). The host
      // refuses with a reason if the net is not probeable (unpacked, interface, subsystem
      // bench, port already mapped to an agent).
      // `ov` is shadowed here by the net override: the DUT is taken from the overlay
      ctx.root.append(
        button(
          "Create probe",
          Boolean(ctx.state.overlay?.dut),
          () => ctx.postAction("createProbe", { net: selNet.name }),
          true,
          "set the DUT first — a probe path is relative to the DUT instance"
        )
      );
    }
  }

  if (ctx.state.mode === "schematic" && ctx.scene) {
    const selNode = ctx.scene.nodes.find((n) => ctx.state.selection.has(n.id));
    if (selNode) {
      ctx.root.append(
        h("h3", "", "Selection"),
        h("div", "", selNode.name),
        h("div", "dim", selNode.sub)
      );
      ctx.root.append(
        button("Flip horizontal (H)", true,
          () => ctx.onFlip(selNode.id, "h"), true),
        button("Flip vertical (V)", true,
          () => ctx.onFlip(selNode.id, "v"), true)
      );
      if (selNode.kind === "fold") {
        ctx.root.append(
          h("div", "dim", `${selNode.foldCount} folded instances`),
          button("Expand fold", true, () => ctx.toggleFold(selNode.id), true)
        );
      } else if (selNode.instPath) {
        const p = selNode.instPath;
        if (ctx.hasSchematic(ctx.state.model, p)) {
          ctx.root.append(
            button("Open schematic", true,
              () => ctx.navigateTo(p, "schematic"), true)
          );
        }
        ctx.root.append(
          button("Open symbol", true, () => ctx.navigateTo(p, "symbol"), true),
          button("Go to source", true, () =>
            ctx.post({
              v: 1,
              type: "action/request",
              action: "openSource",
              args: { viewId: p },
            }), true)
        );
      }
    }
  }

  ctx.root.append(h("h3", "", "Actions"));
  // the blocks selected in the schematic view (instances and folds, not interfaces):
  // the target of the "Create subenv" action (docs/03)
  const selBlocks =
    ctx.state.mode === "schematic" && ctx.scene
      ? ctx.scene.nodes.filter(
          (n) => ctx.state.selection.has(n.id) && n.kind !== "iface"
        )
      : [];
  // the agent gesture: the boundary/symbol pins target the view's module;
  // the pins of a child block target the block's module (explicit viewId in
  // args); the DUT mismatch is resolved on the host, in the flow — the buttons no
  // longer sit dead on the non-DUT views
  const agentPins = selPins.length
    ? selPins.map((p) => ({ port: p.name, iface: p.iface }))
    : childAgent?.pins ?? [];
  const agentView = selPins.length ? ctx.state.viewId : childAgent?.viewId;
  const agentArgs = (extra: Record<string, unknown>) => ({
    viewId: agentView,
    ...extra,
  });
  const selectable = agentPins.filter((p) => !p.iface);
  const ifaceSel =
    agentPins.length === 1 && agentPins[0].iface ? agentPins[0] : undefined;
  // the actions on pins receive ONLY the resolved pins — in the schematic, the selection
  // can also contain blocks/folds, which are not ports of the DUT
  const pinIds = agentPins.map((p) => `<port>.${p.port}`);
  const allIgnored =
    selPins.length > 0 && selPins.every((p) => roles[p.name] === "ignored");
  ctx.root.append(
    button("Set as DUT", Boolean(inst), () => ctx.postAction("setDut", {})),
    button(
      `Agent from selection${selectable.length ? ` (${selectable.length})` : ""}`,
      selectable.length > 0,
      () => ctx.postAction("createAgentFromPins", agentArgs({ pins: pinIds }))
    ),
    button("Agent from interface", Boolean(ifaceSel), () =>
      ctx.postAction("createAgentFromIface", agentArgs({ port: ifaceSel?.port }))
    ),
    button(
      `Create subenv${selBlocks.length ? ` (${selBlocks.length})` : ""}`,
      // the DUT mismatch is resolved IN the flow (a config dedicated to the block,
      // docs/03) — the button no longer sits dead on the non-DUT views
      selBlocks.length > 0,
      () => ctx.postAction("createSubenv", { nodes: selBlocks.map((n) => n.id) })
    ),
    // slice 3: composes the CURRENT block + its siblings into the immediate parent bench
    // (createSubenv initiated from the child). Only when the view has a parent (is not
    // a top module); the host computes the parent + the direct child blocks
    button(
      "Compose into parent bench",
      Boolean(
        ctx.state.model && ctx.state.viewId && !ctx.state.model.tops.includes(ctx.state.viewId)
      ),
      () => ctx.postAction("composeIntoParent", {}),
      true,
      "open a non-top block — it gets composed into its immediate parent bench"
    ),
    // the derived composition (slice 3): writes `connections` from the inter-block nets
    // of this subsystem. Only on the DUT's OWN view (`matches`) — on
    // other views it makes no sense; the host also validates that it has subenvs
    button(
      "Wire connections from design",
      matches,
      () => ctx.postAction("wireConnections", {}),
      true,
      "open the schematic of the subsystem DUT — connections are derived for the composed blocks"
    ),
    allIgnored
      ? button("Un-ignore selection", true,
          () => ctx.postAction("unignorePort",
            { pins: selPins.map((p) => `<port>.${p.name}`) }), true)
      : button("Ignore selection", matches && selPins.length > 0,
          () => ctx.postAction("ignorePort",
            { pins: selPins.map((p) => `<port>.${p.name}`) }), true),
    button("Generate testbench", Boolean(ov?.dut), () =>
      ctx.postAction("generate", {})
    )
  );
}
