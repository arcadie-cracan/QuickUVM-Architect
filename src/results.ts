// Simulation results projected onto the verification view (docs/08 R25) — the
// PURE half: parsing what a regression leaves on disk and attributing it to the
// elements of the bench. No `vscode`, no file access (the host reads the files;
// `src/results-service.ts`), and NO simulator: results come from files, never
// from a process.
//
// The layout is the one QuickUVM's generated Makefile writes (probed on
// quick-uvm 1.1.0 and run on Xcelium 25.09 — the fixtures under
// scripts/fixtures/results/ are those runs):
//
//   <out>/runs/<test>.<seed>/status     PASS | FAIL   (the Makefile's verdict)
//   <out>/runs/<test>.<seed>/test.txt, seed.txt
//   <out>/runs/<test>.<seed>/sim.log    the simulator's log
//   <out>/cov/summary.txt               imc's text summary of the merged coverage
//
// A UVM report line names the component that raised it by its hierarchical
// path, and the generator's instance names are a function of the configuration
// (`<agent>_agnt`, `<scoreboard name>`, `<agent>_cov_h`, `vsqr`), so a report is
// attributed EXACTLY, by path — no pattern on the message text.
//
// Tested in `npm run test:results`.

export type Severity = "info" | "warning" | "error" | "fatal";

export interface UvmReport {
  severity: Severity;
  /** the source file of the reporting macro, as the simulator printed it */
  file: string | null;
  line: number | null;
  /** simulation time, in the log's own unit */
  time: number | null;
  /** the reporter's full hierarchical name: `uvm_test_top.e.pkt_sb.cmp` */
  path: string;
  id: string;
  message: string;
}

export interface SimLog {
  /** the reports of severity WARNING and above (the INFOs are only counted) */
  reports: UvmReport[];
  /** the report server's own totals; null when the log has no summary (a crash) */
  counts: Record<Severity, number> | null;
  /** the simulator reached `$finish` */
  finished: boolean;
}

const SEVERITY: Readonly<Record<string, Severity>> = {
  UVM_INFO: "info",
  UVM_WARNING: "warning",
  UVM_ERROR: "error",
  UVM_FATAL: "fatal",
};

// UVM_ERROR ../tb/x_comparator.svh(84) @ 65: uvm_test_top.e.pkt_sb.cmp [SB_NOEXP] text
// UVM_INFO @ 0: reporter [RNTST] Running test x...
const REPORT_RE =
  /^(UVM_(?:INFO|WARNING|ERROR|FATAL)) (?:(\S.*?)\((\d+)\) )?@ (\d+)[^:]*: (\S+) \[([^\]]*)\] ?(.*)$/;
// ** Report counts by severity / UVM_ERROR :  102
const COUNT_RE = /^(UVM_(?:INFO|WARNING|ERROR|FATAL)) :\s*(\d+)\s*$/;

/**
 * Reads a simulation log. Only what the UVM report server prints is trusted:
 * the report lines, its "Report counts by severity" block, and the `$finish`
 * line. (The "caught UVM_ERROR" numbers of the report CATCHER are not errors —
 * they are 0 on a failing run — and are never read.)
 */
export function parseSimLog(text: string): SimLog {
  const out: SimLog = { reports: [], counts: null, finished: false };
  let inCounts = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("** Report counts by severity")) {
      inCounts = true;
      out.counts = { info: 0, warning: 0, error: 0, fatal: 0 };
      continue;
    }
    if (inCounts) {
      const c = COUNT_RE.exec(line);
      if (c && out.counts) {
        out.counts[SEVERITY[c[1]]] = Number(c[2]);
        continue;
      }
      inCounts = false;
    }
    if (line.includes("Simulation complete via $finish")) {
      out.finished = true;
      continue;
    }
    const m = REPORT_RE.exec(line);
    if (!m) {
      continue;
    }
    const severity = SEVERITY[m[1]];
    if (severity === "info") {
      continue;
    }
    out.reports.push({
      severity,
      file: m[2] ?? null,
      line: m[3] ? Number(m[3]) : null,
      time: Number(m[4]),
      path: m[5],
      id: m[6],
      message: m[7],
    });
  }
  return out;
}

export type Verdict = "PASS" | "FAIL" | "UNKNOWN";

/**
 * The verdict of a log by the generated Makefile's own rule: `$finish` was
 * reached AND the severity block counts no error and no fatal. A log without
 * the block (a crash, a run that never started) is a FAIL, never a pass.
 */
export function verdictOf(log: SimLog): Verdict {
  return log.finished && log.counts && log.counts.error === 0 && log.counts.fatal === 0
    ? "PASS"
    : "FAIL";
}

export interface RunResult {
  test: string;
  seed: string;
  status: Verdict;
  counts: Record<Severity, number>;
  reports: UvmReport[];
}

/**
 * One run from the files of its directory (`<test>.<seed>`). The `status` file
 * is the Makefile's verdict and wins; without it the log decides by the same
 * rule; with neither the run is UNKNOWN (started, or cleaned). The counts are
 * the report server's when the log has them, otherwise what was parsed.
 */
export function runResult(
  dir: string,
  files: { status?: string; test?: string; seed?: string; log?: string }
): RunResult {
  const dot = dir.lastIndexOf(".");
  const log = files.log !== undefined ? parseSimLog(files.log) : null;
  const said = files.status?.trim().toUpperCase();
  const status: Verdict =
    said === "PASS" || said === "FAIL" ? said : log ? verdictOf(log) : "UNKNOWN";
  const parsed: Record<Severity, number> = { info: 0, warning: 0, error: 0, fatal: 0 };
  for (const r of log?.reports ?? []) {
    parsed[r.severity]++;
  }
  return {
    test: files.test?.trim() || (dot > 0 ? dir.slice(0, dot) : dir),
    seed: files.seed?.trim() || (dot > 0 ? dir.slice(dot + 1) : ""),
    status,
    counts: log?.counts ?? parsed,
    reports: log?.reports ?? [],
  };
}

// ------------------------------------------------------------- attribution

/** the names of a bench's elements, from its configuration */
export interface BenchNames {
  agents: readonly string[];
  scoreboards: readonly string[];
  subenvs: readonly string[];
}

/** the units of an agent the generator instantiates, by instance name */
const UNIT: Readonly<Record<string, string>> = {
  drv: "u.driver",
  mon: "u.monitor",
  sqr: "u.sequencer",
};

/**
 * The verification-view node a reporter's path belongs to, as ids of the
 * diagram: `agent:<a>` (and `agent:<a>:u.monitor` for a unit inside it),
 * `sb:<name>`, `cov:<agent>`, `vsqr`, `sub:<name>`, `env` for the environment
 * or the test themselves. null when the path is not under the test (the
 * `reporter` pseudo-component, a path of another shape): the caller decides.
 *
 * The path is `uvm_test_top.<env instance>.<component>[.<unit>…]`; the env's
 * instance name is not assumed (`e` today), only its position.
 */
export function elementOfPath(
  path: string,
  names: BenchNames
): { id: string; unit: string | null } | null {
  const segs = path.split(".");
  if (segs[0] !== "uvm_test_top") {
    return null;
  }
  if (segs.length <= 2) {
    return { id: "env", unit: null }; // the test, or the environment itself
  }
  const inst = segs[2];
  if (inst.endsWith("_agnt")) {
    const agent = inst.slice(0, -"_agnt".length);
    if (names.agents.includes(agent)) {
      const unit = segs[3] ? UNIT[segs[3]] ?? null : null;
      return { id: `agent:${agent}`, unit };
    }
  }
  if (inst.endsWith("_cov_h")) {
    const agent = inst.slice(0, -"_cov_h".length);
    if (names.agents.includes(agent)) {
      return { id: `cov:${agent}`, unit: null };
    }
  }
  if (names.scoreboards.includes(inst)) {
    return { id: `sb:${inst}`, unit: null };
  }
  if (names.subenvs.includes(inst)) {
    return { id: `sub:${inst}`, unit: null };
  }
  if (inst === "vsqr") {
    return { id: "vsqr", unit: null };
  }
  return { id: "env", unit: null }; // under the env, in a component the diagram does not draw
}

// ---------------------------------------------------------------- coverage

export interface CoverageCell {
  pct: number;
  covered: number | null;
  total: number | null;
}

export interface CoverageRow {
  /** the instance path, top first: ["tb_top", "dut_inst"] */
  path: string[];
  /** by imc's column name ("Block", "Toggle", "CoverGroup Covered"…); a metric
   *  the instance does not have (`n/a`) is absent */
  metrics: Record<string, CoverageCell>;
}

/**
 * imc's `report -summary -text` table: a header row, a rule, then one row per
 * instance with its depth drawn as a tree prefix (`| | |--name`) and one cell
 * per metric — `n/a`, `71.43% (5/7)` or a bare `0.00%`. Columns are separated
 * by two or more spaces (a column NAME may contain one: "Fsm Average").
 */
export function parseImcSummary(text: string): CoverageRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines.findIndex((l) => /^name\s{2,}/.test(l));
  if (head < 0) {
    return [];
  }
  const cols = lines[head].trim().split(/\s{2,}/).slice(1);
  const rows: CoverageRow[] = [];
  const stack: string[] = [];
  for (const line of lines.slice(head + 1)) {
    if (/^-+$/.test(line.trim())) {
      continue;
    }
    const m = /^((?:\| )*)(?:\|--)?(\S+)\s{2,}(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const depth = m[1].length / 2 + (line.slice(m[1].length).startsWith("|--") ? 1 : 0);
    stack.length = depth;
    stack[depth] = m[2];
    const cells = m[3].trim().split(/\s{2,}/);
    const metrics: Record<string, CoverageCell> = {};
    cols.forEach((name, i) => {
      const c = /^(\d+(?:\.\d+)?)%(?: \((\d+)\/(\d+)\))?$/.exec(cells[i] ?? "");
      if (c) {
        metrics[name] = {
          pct: Number(c[1]),
          covered: c[2] !== undefined ? Number(c[2]) : null,
          total: c[3] !== undefined ? Number(c[3]) : null,
        };
      }
    });
    rows.push({ path: stack.slice(0, depth + 1), metrics });
  }
  return rows;
}

// ----------------------------------------------------------------- summary

/** the reports of one element that say the same thing, folded */
export interface ResultMessage {
  severity: Severity;
  id: string;
  /** the FIRST message of the group (the others differ in their data) */
  message: string;
  count: number;
  file: string | null;
  line: number | null;
  /** the run the first one came from: `<test>.<seed>` */
  run: string;
}

export interface ElementResult {
  fatals: number;
  errors: number;
  warnings: number;
  messages: ResultMessage[];
}

/** a coverage figure shown on a box: "cg" for a covergroup, "block" / "expr" /
 *  "toggle" for the DUT's code coverage */
export interface CoverageFigure {
  label: string;
  pct: number;
  covered: number | null;
  total: number | null;
}

/** what the diagram draws: per element, and for the bench as a whole */
export interface ResultsSnapshot {
  runs: { test: string; seed: string; status: Verdict }[];
  passed: number;
  failed: number;
  /** by diagram id: `agent:cmd`, `agent:cmd:u.monitor`, `sb:pkt_sb`, `env`… */
  elements: Record<string, ElementResult>;
  coverage: Record<string, CoverageFigure[]>;
}

const MAX_MESSAGES = 8;

function bump(e: ElementResult, r: UvmReport, run: string): void {
  if (r.severity === "fatal") {
    e.fatals++;
  } else if (r.severity === "error") {
    e.errors++;
  } else {
    e.warnings++;
  }
  const same = e.messages.find((m) => m.severity === r.severity && m.id === r.id && m.file === r.file && m.line === r.line);
  if (same) {
    same.count++;
  } else if (e.messages.length < MAX_MESSAGES) {
    e.messages.push({
      severity: r.severity,
      id: r.id,
      message: r.message,
      count: 1,
      file: r.file,
      line: r.line,
      run,
    });
  }
}

/** the metrics of the DUT's code coverage worth a figure on its box */
const DUT_METRICS: readonly (readonly [string, string])[] = [
  ["Block", "block"],
  ["Expression", "expr"],
  ["Toggle", "toggle"],
];

/**
 * Folds the runs and the coverage rows into what the diagram shows. A report
 * goes to the element its path names; when the path is not under the test
 * (`reporter`), to the owner of its source file if `ownerOfFile` knows one
 * (the generation manifest), else to `env` — a report is never dropped: an
 * error nobody can see is worse than one on the wrong box. A unit inside an
 * agent is counted on the agent AND under `agent:<a>:<unit>`, for the agent's
 * own level.
 *
 * Coverage: a collector instance `<agent>_cov_h` puts its covergroup figure on
 * `cov:<agent>`; `dut_inst` puts the code-coverage figures on `dut`.
 */
export function summarizeResults(
  runs: readonly RunResult[],
  coverage: readonly CoverageRow[],
  names: BenchNames,
  ownerOfFile?: (file: string) => string | null
): ResultsSnapshot {
  const out: ResultsSnapshot = {
    runs: runs.map((r) => ({ test: r.test, seed: r.seed, status: r.status })),
    passed: runs.filter((r) => r.status === "PASS").length,
    failed: runs.filter((r) => r.status === "FAIL").length,
    elements: {},
    coverage: {},
  };
  const at = (id: string): ElementResult =>
    (out.elements[id] ??= { fatals: 0, errors: 0, warnings: 0, messages: [] });
  for (const run of runs) {
    const tag = run.seed ? `${run.test}.${run.seed}` : run.test;
    for (const r of run.reports) {
      const where = elementOfPath(r.path, names);
      const id = where?.id ?? (r.file ? ownerOfFile?.(r.file) ?? null : null) ?? "env";
      bump(at(id), r, tag);
      if (where?.unit) {
        bump(at(`${id}:${where.unit}`), r, tag);
      }
    }
  }
  for (const row of coverage) {
    const leaf = row.path[row.path.length - 1];
    if (leaf.endsWith("_cov_h")) {
      const agent = leaf.slice(0, -"_cov_h".length);
      const cg = row.metrics["CoverGroup Covered"] ?? row.metrics["CoverGroup Average"];
      if (cg && names.agents.includes(agent)) {
        out.coverage[`cov:${agent}`] = [{ label: "cg", ...cg }];
      }
    } else if (leaf === "dut_inst") {
      const figs: CoverageFigure[] = [];
      for (const [col, label] of DUT_METRICS) {
        const c = row.metrics[col];
        if (c) {
          figs.push({ label, ...c });
        }
      }
      if (figs.length) {
        out.coverage.dut = figs;
      }
    }
  }
  return out;
}

/** the worst severity an element shows, or null when it has nothing */
export function worstOf(e: ElementResult | undefined): "fatal" | "error" | "warning" | null {
  if (!e) {
    return null;
  }
  return e.fatals ? "fatal" : e.errors ? "error" : e.warnings ? "warning" : null;
}

// ------------------------------------------------------ what a level shows

/** what one block of a level shows: its own results, or those of what is inside it */
export interface NodeResult {
  fatals: number;
  errors: number;
  warnings: number;
  messages: ResultMessage[];
  coverage: CoverageFigure[];
}

/**
 * The results of the blocks drawn on ONE level of the verification view
 * (`focus`: "" the testbench, "env", "agent:<a>"; `nodeIds`: the level's
 * blocks). The diagram shows one level at a time, so a result is drawn on the
 * block that REPRESENTS its element there:
 *
 *   - the element's own block when the level has it (`sb:x`, `agent:cmd`,
 *     and a cross-block scoreboard's `xsb:x` at the testbench level);
 *   - at the testbench level, the `env` block for everything inside the
 *     environment — an error two levels down is still an error on screen;
 *   - at an agent's level, a unit's reports on its `u.<unit>` block (the
 *     snapshot keeps them under `agent:<a>:u.<unit>`).
 *
 * A unit's reports are already counted on its agent, so the unit keys are read
 * ONLY at that agent's level. Coverage is never summed upwards: a figure is a
 * property of one instance (`cov:<agent>`, `dut`), shown where that block is.
 */
export function levelResults(
  snapshot: ResultsSnapshot | null | undefined,
  focus: string,
  nodeIds: readonly string[]
): Record<string, NodeResult> {
  const out: Record<string, NodeResult> = {};
  if (!snapshot) {
    return out;
  }
  const ids = new Set(nodeIds);
  const here = /^agent:[^:]+$/.test(focus) ? focus : null;
  const at = (id: string): NodeResult =>
    (out[id] ??= { fatals: 0, errors: 0, warnings: 0, messages: [], coverage: [] });
  const nodeFor = (key: string): string | null => {
    const unit = /^(agent:[^:]+):(u\..+)$/.exec(key);
    if (unit) {
      return here === unit[1] && ids.has(unit[2]) ? unit[2] : null;
    }
    if (ids.has(key)) {
      return key;
    }
    if (key.startsWith("sb:") && ids.has(`x${key}`)) {
      return `x${key}`;
    }
    return ids.has("env") && key !== "dut" ? "env" : null;
  };
  for (const [key, e] of Object.entries(snapshot.elements)) {
    const id = nodeFor(key);
    if (!id) {
      continue;
    }
    const n = at(id);
    n.fatals += e.fatals;
    n.errors += e.errors;
    n.warnings += e.warnings;
    for (const m of e.messages) {
      if (n.messages.length < MAX_MESSAGES) {
        n.messages.push(m);
      }
    }
  }
  for (const [key, figs] of Object.entries(snapshot.coverage)) {
    if (ids.has(key)) {
      at(key).coverage = figs;
    }
  }
  return out;
}

/** the worst severity a block shows, or null */
export function worstOfNode(n: NodeResult | undefined): "fatal" | "error" | "warning" | null {
  return n ? worstOf({ ...n }) : null;
}

/** one message as a line: `UVM_ERROR [SB_NOEXP] ×102 — text (file:84, test.1)` */
export function messageLine(m: ResultMessage): string {
  const sev = `UVM_${m.severity.toUpperCase()}`;
  const where = [m.file ? `${m.file.replace(/^.*[\/]/, "")}${m.line ? `:${m.line}` : ""}` : "", m.run]
    .filter(Boolean)
    .join(", ");
  return `${sev} [${m.id}]${m.count > 1 ? ` ×${m.count}` : ""} — ${m.message}${where ? ` (${where})` : ""}`;
}

/** the header's sentence: the VERDICTS of the runs (never an error count: a
 *  passing run can warn, a failing one can fail without a single report) */
export function resultsChip(
  snapshot: ResultsSnapshot,
  stale: boolean
): { text: string; tone: "pass" | "fail" | "unknown" } {
  const total = snapshot.runs.length;
  const other = total - snapshot.passed - snapshot.failed;
  const tone = snapshot.failed ? "fail" : other ? "unknown" : "pass";
  const text =
    (snapshot.failed
      ? `Runs: ${snapshot.passed}/${total} passed`
      : `Runs: ${snapshot.passed} passed`) +
    (other ? `, ${other} without a verdict` : "") +
    (stale ? " (stale)" : "");
  return { text, tone };
}

/**
 * The results as a document (the "Simulation results" report): the runs, then
 * every element with its folded messages, worst first, then the coverage
 * figures. `stale` and `unparsed` are SAID at the top — a report that looks
 * complete and is not is the failure this row must not have.
 */
export function resultsReport(
  state: { snapshot: ResultsSnapshot; dir: string; at: number | null; unparsed: number },
  opts: { name: string; stale: boolean }
): string {
  const s = state.snapshot;
  const lines: string[] = [`# Simulation results — ${opts.name}`, ""];
  lines.push(
    `${s.runs.length} run${s.runs.length === 1 ? "" : "s"}: ${s.passed} passed, ${s.failed} failed` +
      (state.at !== null ? ` — ${new Date(state.at).toISOString().replace("T", " ").slice(0, 16)} UTC` : "")
  );
  lines.push("", `Read from \`${state.dir}\`. Nothing here was run by the extension.`);
  if (opts.stale) {
    lines.push("", "**Stale:** the configuration changed after these runs — they describe an older bench.");
  }
  if (state.unparsed) {
    lines.push(
      "",
      `**Partial:** ${state.unparsed} log${state.unparsed === 1 ? " was" : "s were"} not parsed (too large, or beyond the run limit) — those runs count by verdict only.`
    );
  }
  lines.push("", "## Runs", "", "| test | seed | status |", "| --- | --- | --- |");
  for (const r of s.runs) {
    lines.push(`| ${r.test} | ${r.seed || "—"} | ${r.status} |`);
  }
  const elements = Object.entries(s.elements)
    .filter(([id]) => !/^agent:[^:]+:u\./.test(id)) // a unit is already in its agent
    .sort(
      ([, a], [, b]) => b.fatals - a.fatals || b.errors - a.errors || b.warnings - a.warnings
    );
  lines.push("", "## By element", "");
  if (!elements.length) {
    lines.push("No warning, error or fatal was reported.");
  }
  for (const [id, e] of elements) {
    const counts = [
      e.fatals ? `${e.fatals} fatal${e.fatals === 1 ? "" : "s"}` : "",
      e.errors ? `${e.errors} error${e.errors === 1 ? "" : "s"}` : "",
      e.warnings ? `${e.warnings} warning${e.warnings === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    lines.push(`### \`${id}\` — ${counts.join(", ")}`, "");
    for (const m of e.messages) {
      lines.push(`- ${messageLine(m)}`);
    }
    const shown = e.messages.reduce((n, m) => n + m.count, 0);
    const all = e.fatals + e.errors + e.warnings;
    if (all > shown) {
      lines.push(`- … and ${all - shown} more of other kinds (see the logs)`);
    }
    lines.push("");
  }
  const cov = Object.entries(s.coverage);
  if (cov.length) {
    lines.push("## Coverage", "");
    for (const [id, figs] of cov) {
      lines.push(
        `- \`${id}\`: ` +
          figs
            .map(
              (f) =>
                `${f.label} ${f.pct}%` +
                (f.covered !== null && f.total !== null ? ` (${f.covered}/${f.total})` : "")
            )
            .join(", ")
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
