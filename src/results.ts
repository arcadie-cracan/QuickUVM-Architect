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
//   <out>/runs/<test>.<seed>/status     PASS | FAIL   (written AFTER the run)
//   <out>/runs/<test>.<seed>/test.txt, seed.txt
//   <out>/runs/<test>.<seed>/sim.log    the simulator's log
//   <out>/cov/summary.txt               imc's text summary of the merged coverage
//
// A UVM report line names the component that raised it by its hierarchical
// path, and the generator's instance names follow from the configuration, so a
// report is attributed by PATH first — never by a pattern on its message. The
// names are the generator's, probed per mode (see `elementOfPath`); a path this
// module does not recognise falls back to the OWNER of the report's source file
// (the generation manifest) and only then to the environment. A report is
// never dropped.
//
// Tested in `npm run test:results`.

export type Severity = "info" | "warning" | "error" | "fatal";

const RANK: Readonly<Record<Severity, number>> = { info: 0, warning: 1, error: 2, fatal: 3 };

/** the reports of one KIND in a log — same severity, reporter, id and source
 *  line — folded while parsing: a log of a hundred thousand mismatches is a
 *  handful of these, and nothing of the log's text is kept alive by them */
export interface UvmReport {
  severity: Severity;
  /** the source file of the reporting macro, as the simulator printed it */
  file: string | null;
  line: number | null;
  /** simulation time of the FIRST one, in the log's own unit */
  time: number | null;
  /** the reporter's full hierarchical name: `uvm_test_top.e.pkt_sb.cmp` */
  path: string;
  id: string;
  /** the FIRST message of the kind (the others differ in their data) */
  message: string;
  count: number;
}

export interface SimLog {
  /** the kinds of report of severity WARNING and above (INFOs are only counted) */
  reports: UvmReport[];
  /** the report server's own totals; null when the log has no COMPLETE summary
   *  (a crash, a run still going, a block cut short) */
  counts: Record<Severity, number> | null;
  /** the simulator reached `$finish` */
  finished: boolean;
  /** the coverage scope the run was started with (`-covscope <dut>`): the DUT
   *  the results belong to; null when the run had no coverage */
  scope: string | null;
  /** reports of kinds beyond `MAX_KINDS`: parsed, not kept */
  dropped: number;
}

const SEVERITY: Readonly<Record<string, Severity>> = {
  UVM_INFO: "info",
  UVM_WARNING: "warning",
  UVM_ERROR: "error",
  UVM_FATAL: "fatal",
};

// UVM_ERROR ../tb/x_comparator.svh(84) @ 65: uvm_test_top.e.pkt_sb.cmp [SB_NOEXP] text
// UVM_INFO @ 0: reporter [RNTST] Running test x...
// (an id may hold one level of brackets: `[a[0]]`)
const REPORT_RE =
  /^(UVM_(?:INFO|WARNING|ERROR|FATAL)) (?:(\S.*?)\((\d+)\) )?@ (\d+)[^:]*: (\S+) \[((?:[^[\]]|\[[^[\]]*\])*)\] ?(.*)$/;
// ** Report counts by severity / UVM_ERROR :  102
const COUNT_RE = /^(UVM_(?:INFO|WARNING|ERROR|FATAL)) :\s*(\d+)\s*$/;
const SCOPE_RE = /^\s*-covscope\s+(\S+)/;

/** distinct kinds kept per log; a log with more is pathological and is counted */
const MAX_KINDS = 2000;

/**
 * A copy of a string that shares no storage with its source. A regex capture
 * is a SLICE of the line, which is a slice of the whole log: keeping one
 * capture kept megabytes alive (measured: one warning retained its 8 MB log).
 */
const own = (s: string): string => (s.length ? Array.from(s).join("") : s);

/**
 * Reads a simulation log. Only what the UVM report server prints is trusted:
 * the report lines, its "Report counts by severity" block, and the `$finish`
 * line. (The "caught UVM_ERROR" numbers of the report CATCHER are not errors —
 * they are 0 on a failing run — and are never read.) A report line is a report
 * even when its text mentions `$finish`.
 */
export function parseSimLog(text: string): SimLog {
  const out: SimLog = { reports: [], counts: null, finished: false, scope: null, dropped: 0 };
  const kinds = new Map<string, UvmReport>();
  let block: Partial<Record<Severity, number>> | null = null;
  const closeBlock = (): void => {
    // a block cut short (the log ends inside it) is not a summary: pre-zeroed
    // counts would read as "no errors"
    if (block && block.error !== undefined && block.fatal !== undefined) {
      out.counts = {
        info: block.info ?? 0,
        warning: block.warning ?? 0,
        error: block.error,
        fatal: block.fatal,
      };
    }
    block = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    // Questa prefixes transcript lines with "# "
    const line = (raw.startsWith("# ") ? raw.slice(2) : raw).trimEnd();
    if (line.startsWith("** Report counts by severity")) {
      block = {};
      out.counts = null; // a later summary (a restart) replaces an earlier one
      continue;
    }
    if (block) {
      const c = COUNT_RE.exec(line);
      if (c) {
        block[SEVERITY[c[1]]] = Number(c[2]);
        continue;
      }
      closeBlock();
    }
    const m = REPORT_RE.exec(line);
    if (!m) {
      if (line.includes("Simulation complete via $finish")) {
        out.finished = true;
      } else if (out.scope === null) {
        const s = SCOPE_RE.exec(line);
        if (s) {
          out.scope = own(s[1]);
        }
      }
      continue;
    }
    const severity = SEVERITY[m[1]];
    if (severity === "info") {
      continue;
    }
    const key = `${severity}\0${m[5]}\0${m[6]}\0${m[2] ?? ""}\0${m[3] ?? ""}`;
    const seen = kinds.get(key);
    if (seen) {
      seen.count++;
    } else if (kinds.size < MAX_KINDS) {
      kinds.set(own(key), {
        severity,
        file: m[2] ? own(m[2]) : null,
        line: m[3] ? Number(m[3]) : null,
        time: Number(m[4]),
        path: own(m[5]),
        id: own(m[6]),
        message: own(m[7]),
        count: 1,
      });
    } else {
      out.dropped++;
    }
  }
  closeBlock();
  out.reports = [...kinds.values()];
  return out;
}

export type Verdict = "PASS" | "FAIL" | "UNKNOWN";

/**
 * The verdict of a COMPLETE log by the generated Makefile's own rule:
 * `$finish` was reached AND the severity block counts no error and no fatal.
 * A log without a complete block is a FAIL, never a pass. (Not used for a run
 * without a `status` file — see `runResult`.)
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
  scope: string | null;
  /** warnings / errors / fatals the report server counted that are not in
   *  `reports` (a line format this parser does not know, or kinds beyond the
   *  cap): they exist, and are not on any block */
  missed: number;
}

/**
 * One run from the files of its directory (`<test>.<seed>`). The verdict is the
 * `status` file's and nothing else's: the Makefile writes it AFTER the
 * simulator exits, so a run without one is in flight (or was killed) — UNKNOWN,
 * exactly as the Makefile's own summary skips it. Judging its half-written log
 * would report a running regression as failing. The counts are the report
 * server's when the log has them, otherwise what was parsed.
 */
export function runResult(
  dir: string,
  files: { status?: string; test?: string; seed?: string; log?: string }
): RunResult {
  const dot = dir.lastIndexOf(".");
  const log = files.log !== undefined ? parseSimLog(files.log) : null;
  const said = files.status?.trim().toUpperCase();
  const parsed: Record<Severity, number> = { info: 0, warning: 0, error: 0, fatal: 0 };
  for (const r of log?.reports ?? []) {
    parsed[r.severity] += r.count;
  }
  const counts = log?.counts ?? parsed;
  const kept = parsed.warning + parsed.error + parsed.fatal;
  return {
    test: files.test?.trim() || (dot > 0 ? dir.slice(0, dot) : dir),
    seed: files.seed?.trim() || (dot > 0 ? dir.slice(dot + 1) : ""),
    status: said === "PASS" || said === "FAIL" ? said : "UNKNOWN",
    counts,
    reports: log?.reports ?? [],
    scope: log?.scope ?? null,
    missed: log?.counts
      ? Math.max(0, counts.warning + counts.error + counts.fatal - kept)
      : log?.dropped ?? 0,
  };
}

// ------------------------------------------------------------- attribution

/** what the attribution needs to know of a bench, from its configuration */
export interface BenchNames {
  /** the DUT module: what a run's coverage scope must say */
  dut?: string | null;
  agents: readonly string[];
  /** the scoreboards by INSTANCE name: a named one is its name; an unnamed
   *  declared one and the one implicit mode infers are `sbd` */
  scoreboards: readonly string[];
  subenvs: readonly string[];
  /** implicit mode (no `analysis:`): the agent whose collector is the single
   *  instance `cov` (a declared collector is `<agent>_cov_h`) */
  implicitCoverage?: string | null;
  /** a bench whose ONE agent is replicated (`replicas`) or instantiated
   *  (`instances`): its agent instances are `<handle>_agnt`, its scoreboards
   *  `<handle>_sb` — quick-uvm allows these only on a sole-agent bench */
  soleAgent?: string | null;
  hasProbes?: boolean;
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const nameOf = (v: unknown): string | null => {
  const n = v !== null && typeof v === "object" ? (v as { name?: unknown }).name : undefined;
  return typeof n === "string" && n ? n : null;
};

/**
 * The names of a bench from its (live, possibly half-typed) configuration and
 * the components quick-uvm infers. Defensive by construction: `agents: foo`, a
 * bare `-` entry, `analysis: {scoreboards: 5}` yield fewer names, never a throw
 * — this runs on every edit.
 */
export function benchNames(
  config: unknown,
  inferred: readonly { kind: string; name?: string; source?: string }[] = []
): BenchNames {
  const cfg = (config !== null && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const agentEntries = arr<Record<string, unknown>>(cfg.agents).filter(
    (a) => a !== null && typeof a === "object"
  );
  const agents = agentEntries.map(nameOf).filter((n): n is string => n !== null);
  const analysis = cfg.analysis;
  const declared = analysis !== null && typeof analysis === "object";
  const sbs = declared ? arr<unknown>((analysis as Record<string, unknown>).scoreboards) : [];
  const scoreboards = new Set<string>();
  for (const sb of sbs) {
    if (sb !== null && typeof sb === "object") {
      scoreboards.add(nameOf(sb) ?? "sbd");
    }
  }
  let implicitCoverage: string | null = null;
  for (const c of inferred) {
    if (c.kind === "scoreboard" && c.name) {
      scoreboards.add(c.name);
    } else if (c.kind === "coverage" && c.name) {
      implicitCoverage = c.name;
    }
  }
  const sole = agentEntries.length === 1 ? agentEntries[0] : null;
  const multiplied =
    sole !== null &&
    ((typeof sole.replicas === "number" && sole.replicas > 1) || arr(sole.instances).length > 0);
  const dut = cfg.dut;
  return {
    dut: nameOf(dut),
    agents,
    scoreboards: [...scoreboards],
    subenvs: arr<unknown>(cfg.subenvs).map(nameOf).filter((n): n is string => n !== null),
    implicitCoverage,
    soleAgent: multiplied ? nameOf(sole) : null,
    hasProbes: arr(cfg.probes).length > 0,
  };
}

/** the units of an agent the generator instantiates, by instance name */
const UNIT: Readonly<Record<string, string>> = {
  drv: "u.driver",
  mon: "u.monitor",
  sqr: "u.sequencer",
};

/**
 * The verification-view node a reporter's path belongs to, as ids of the
 * diagram: `agent:<a>` (with `unit` for a unit inside it), `sb:<name>`,
 * `cov:<agent>`, `vsqr`, `probes`, `sub:<name>`, `env` for the environment or
 * the test themselves. null when the path is not under the test (the
 * `reporter` pseudo-component). `exact: false` = "somewhere under the env, in
 * an instance this function does not know": the caller tries the report's
 * source file before settling on the env.
 *
 * The path is `uvm_test_top.<env instance>.<component>[.<unit>…]`; the env's
 * instance name is not assumed (`e` today), only its position. A sequence
 * reports through its sequencer as `…sqr@@<sequence>`: the `@@` tail is not
 * part of the instance. The instance names, as quick-uvm 1.1.0 generates them:
 *
 *   <agent>_agnt[.drv|.mon|.sqr]   an agent and its units
 *   <handle>_agnt, <handle>_sb     a sole agent's replicas (`cmd_0`) / instances
 *   <scoreboard name>, `sbd`       a named scoreboard; an unnamed or inferred one
 *   <agent>_cov_h, `cov`           a declared collector; the implicit mode's
 *   vsqr, probe_mon, <subenv>      the virtual sequencer, the probes, a sub-env
 */
export function elementOfPath(
  path: string,
  names: BenchNames
): { id: string; unit: string | null; exact: boolean } | null {
  const segs = path.split(".").map((s) => s.split("@@")[0]);
  if (segs[0] !== "uvm_test_top") {
    return null;
  }
  if (segs.length <= 2) {
    return { id: "env", unit: null, exact: true }; // the test, or the environment itself
  }
  const inst = segs[2];
  const hit = (id: string, unit: string | null = null) => ({ id, unit, exact: true });
  if (inst.endsWith("_agnt")) {
    const base = inst.slice(0, -"_agnt".length);
    const agent = names.agents.includes(base) ? base : names.soleAgent ?? null;
    if (agent) {
      return hit(`agent:${agent}`, segs[3] ? UNIT[segs[3]] ?? null : null);
    }
  }
  if (inst.endsWith("_cov_h")) {
    const agent = inst.slice(0, -"_cov_h".length);
    if (names.agents.includes(agent)) {
      return hit(`cov:${agent}`);
    }
  }
  if (inst === "cov" && names.implicitCoverage) {
    return hit(`cov:${names.implicitCoverage}`);
  }
  if (names.scoreboards.includes(inst)) {
    return hit(`sb:${inst}`);
  }
  if (inst.endsWith("_sb") && names.soleAgent && names.scoreboards.length === 1) {
    return hit(`sb:${names.scoreboards[0]}`); // a replica's copy of the one scoreboard
  }
  if (names.subenvs.includes(inst)) {
    return hit(`sub:${inst}`);
  }
  if (inst === "vsqr") {
    return hit("vsqr");
  }
  if (inst === "probe_mon" && names.hasProbes) {
    return hit("probes");
  }
  return { id: "env", unit: null, exact: false };
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
 * by two or more spaces (a column NAME may contain one: "Fsm Average"). A row's
 * figures are the instance's OWN, not its subtree's.
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
  /** at most `MAX_MESSAGES` kinds, the most severe ones, worst first */
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
  /** warnings / errors / fatals the simulator counted that are on no block (a
   *  line format the parser does not know): said, never silently short */
  missed: number;
}

export const MAX_MESSAGES = 12;

/**
 * Adds a kind to a capped list WITHOUT losing the worst: when the list is full
 * the least severe entry gives way to a more severe newcomer — first-come
 * dropped the fatal that ended the run behind eight earlier warnings.
 */
function keep(list: ResultMessage[], m: ResultMessage): void {
  if (list.length < MAX_MESSAGES) {
    list.push(m);
  } else {
    let weakest = 0;
    for (let i = 1; i < list.length; i++) {
      if (RANK[list[i].severity] <= RANK[list[weakest].severity]) {
        weakest = i; // the LAST of the least severe
      }
    }
    if (RANK[m.severity] > RANK[list[weakest].severity]) {
      list[weakest] = m;
    } else {
      return;
    }
  }
  list.sort((a, b) => RANK[b.severity] - RANK[a.severity]); // stable: order kept within a severity
}

function bump(e: ElementResult, r: UvmReport, run: string): void {
  if (r.severity === "fatal") {
    e.fatals += r.count;
  } else if (r.severity === "error") {
    e.errors += r.count;
  } else {
    e.warnings += r.count;
  }
  const same = e.messages.find(
    (m) => m.severity === r.severity && m.id === r.id && m.file === r.file && m.line === r.line
  );
  if (same) {
    same.count += r.count;
  } else {
    keep(e.messages, {
      severity: r.severity,
      id: r.id,
      message: r.message,
      count: r.count,
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
 * goes to the element its path names; a path that names nothing known — or is
 * not under the test at all (`reporter`) — goes to the owner of its source file
 * if `ownerOfFile` knows one (the generation manifest), else to `env`. A report
 * is never dropped: an error nobody can see is worse than one on the wrong
 * box. A unit inside an agent is counted on the agent AND under
 * `agent:<a>:<unit>`, for the agent's own level.
 *
 * Coverage: a collector instance (`<agent>_cov_h`, or the implicit mode's
 * `cov`) puts its covergroup figure on `cov:<agent>`; `dut_inst` puts the
 * code-coverage figures on `dut` — summed over its SUBTREE (imc's rows are per
 * instance: a hierarchical DUT's top row alone would speak for its glue logic).
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
    missed: runs.reduce((n, r) => n + r.missed, 0),
  };
  const at = (id: string): ElementResult =>
    (out.elements[id] ??= { fatals: 0, errors: 0, warnings: 0, messages: [] });
  for (const run of runs) {
    const tag = run.seed ? `${run.test}.${run.seed}` : run.test;
    for (const r of run.reports) {
      const where = elementOfPath(r.path, names);
      const byFile = !where?.exact && r.file ? ownerOfFile?.(r.file) ?? null : null;
      const id = where?.exact ? where.id : byFile ?? where?.id ?? "env";
      bump(at(id), r, tag);
      if (where?.exact && where.unit) {
        bump(at(`${id}:${where.unit}`), r, tag);
      }
    }
  }
  const dutSum = new Map<string, { covered: number; total: number; whole: boolean; own: CoverageCell | null }>();
  for (const row of coverage) {
    const leaf = row.path[row.path.length - 1];
    const cg = row.metrics["CoverGroup Covered"] ?? row.metrics["CoverGroup Average"];
    if (leaf.endsWith("_cov_h")) {
      const agent = leaf.slice(0, -"_cov_h".length);
      if (cg && names.agents.includes(agent)) {
        out.coverage[`cov:${agent}`] = [{ label: "cg", ...cg }];
      }
    } else if (leaf === "cov" && cg && names.implicitCoverage) {
      out.coverage[`cov:${names.implicitCoverage}`] = [{ label: "cg", ...cg }];
    }
    const depth = row.path.indexOf("dut_inst");
    if (depth >= 0) {
      for (const [col] of DUT_METRICS) {
        const c = row.metrics[col];
        if (!c) {
          continue;
        }
        const s = dutSum.get(col) ?? { covered: 0, total: 0, whole: true, own: null };
        if (c.covered !== null && c.total !== null) {
          s.covered += c.covered;
          s.total += c.total;
        } else {
          s.whole = false; // a bare percentage cannot be summed
        }
        if (depth === row.path.length - 1) {
          s.own = c;
        }
        dutSum.set(col, s);
      }
    }
  }
  const figs: CoverageFigure[] = [];
  for (const [col, label] of DUT_METRICS) {
    const s = dutSum.get(col);
    if (!s) {
      continue;
    }
    if (s.whole && s.total > 0) {
      figs.push({
        label,
        pct: Math.round((s.covered / s.total) * 10000) / 100,
        covered: s.covered,
        total: s.total,
      });
    } else if (s.own) {
      figs.push({ label, ...s.own }); // the DUT's own row: the best that can be said
    }
  }
  if (figs.length) {
    out.coverage.dut = figs;
  }
  return out;
}

/** the worst severity an element shows, or null when it has nothing */
export function worstOf(
  e: Pick<ElementResult, "fatals" | "errors" | "warnings"> | undefined | null
): "fatal" | "error" | "warning" | null {
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

export interface LevelResults {
  /** by block id of the level */
  nodes: Record<string, NodeResult>;
  /** what was reported and has NO block on this level (the env's own reports
   *  at the env level, the rest of the bench at an agent's level): shown next
   *  to the header's verdicts, so that no level is ever silently clean */
  elsewhere: NodeResult | null;
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
 * What has no block on the level is `elsewhere`. A unit's reports are already
 * counted on its agent, so the unit keys are read ONLY at that agent's level —
 * where the agent's own total counts for `elsewhere` only by what its drawn
 * units do not already show. Coverage is never summed upwards: a figure is a
 * property of one instance (`cov:<agent>`, `dut`), shown where that block is.
 */
export function levelResults(
  snapshot: ResultsSnapshot | null | undefined,
  focus: string,
  nodeIds: readonly string[]
): LevelResults {
  const nodes: Record<string, NodeResult> = {};
  if (!snapshot) {
    return { nodes, elsewhere: null };
  }
  const ids = new Set(nodeIds);
  const here = /^agent:[^:]+$/.test(focus) ? focus : null;
  const blank = (): NodeResult => ({ fatals: 0, errors: 0, warnings: 0, messages: [], coverage: [] });
  const elsewhere = blank();
  const add = (n: NodeResult, e: ElementResult, sign = 1): void => {
    n.fatals += sign * e.fatals;
    n.errors += sign * e.errors;
    n.warnings += sign * e.warnings;
    if (sign > 0) {
      for (const m of e.messages) {
        keep(n.messages, m);
      }
    }
  };
  const nodeFor = (key: string): string | null => {
    if (ids.has(key)) {
      return key;
    }
    if (key.startsWith("sb:") && ids.has(`x${key}`)) {
      return `x${key}`;
    }
    return ids.has("env") && key !== "dut" ? "env" : null;
  };
  for (const [key, e] of Object.entries(snapshot.elements)) {
    const unit = /^(agent:[^:]+):(u\..+)$/.exec(key);
    if (unit) {
      if (here === unit[1] && ids.has(unit[2])) {
        add((nodes[unit[2]] ??= blank()), e);
        add(elsewhere, e, -1); // already inside the agent's total, counted below
      }
      continue;
    }
    const id = nodeFor(key);
    add(id ? (nodes[id] ??= blank()) : elsewhere, e);
  }
  for (const [key, figs] of Object.entries(snapshot.coverage)) {
    if (ids.has(key)) {
      (nodes[key] ??= blank()).coverage = figs;
    }
  }
  const any = elsewhere.fatals + elsewhere.errors + elsewhere.warnings > 0;
  return { nodes, elsewhere: any ? elsewhere : null };
}

/** the worst severity a block shows, or null */
export function worstOfNode(n: NodeResult | undefined | null): "fatal" | "error" | "warning" | null {
  return worstOf(n);
}

/** one message as a line: `UVM_ERROR [SB_NOEXP] ×102 — text (file:84, test.1)` */
export function messageLine(m: ResultMessage): string {
  const sev = `UVM_${m.severity.toUpperCase()}`;
  const base = m.file ? m.file.replace(/^.*[\\/]/, "") : "";
  const where = [base ? `${base}${m.line ? `:${m.line}` : ""}` : "", m.run].filter(Boolean).join(", ");
  return `${sev} [${m.id}]${m.count > 1 ? ` ×${m.count}` : ""} — ${m.message}${where ? ` (${where})` : ""}`;
}

/** `✕ 3` / `! 2`: failures first — a block with errors shows them, not its warnings */
export function countLabel(n: Pick<NodeResult, "fatals" | "errors" | "warnings">): string {
  const bad = n.fatals + n.errors;
  return bad ? `✕ ${bad}` : `! ${n.warnings}`;
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

export interface ReportState {
  snapshot: ResultsSnapshot;
  dir: string;
  /** the newest verdict's time (ms), or null */
  at: number | null;
  /** runs counted by verdict only (a log too large, or beyond the run limit) */
  unparsed: number;
}

/**
 * The results as a document (the "Simulation results" report): the runs, then
 * every element with its folded messages, worst first, then the coverage
 * figures. What makes the picture incomplete — stale, old coverage, runs
 * without a verdict, logs not parsed, reports not recognised — is SAID at the
 * top: a report that looks complete and is not is the failure this row must
 * not have.
 */
export function resultsReport(
  state: ReportState,
  opts: { name: string; stale: boolean; covStale?: boolean }
): string {
  const s = state.snapshot;
  const other = s.runs.length - s.passed - s.failed;
  const lines: string[] = [`# Simulation results — ${opts.name}`, ""];
  lines.push(
    `${s.runs.length} run${s.runs.length === 1 ? "" : "s"}: ${s.passed} passed, ${s.failed} failed` +
      (other ? `, ${other} without a verdict (still running, or stopped)` : "") +
      (state.at !== null ? ` — ${new Date(state.at).toISOString().replace("T", " ").slice(0, 16)} UTC` : "")
  );
  lines.push("", `Read from \`${state.dir}\`. Nothing here was run by the extension.`);
  if (opts.stale) {
    lines.push(
      "",
      "**Stale:** the configuration changed after at least one of these runs — they describe an older bench."
    );
  }
  if (opts.covStale) {
    lines.push(
      "",
      "**Old coverage:** the coverage summary is older than the runs (or than the configuration) — it was not rewritten by this regression."
    );
  }
  if (state.unparsed) {
    lines.push(
      "",
      `**Partial:** ${state.unparsed} log${state.unparsed === 1 ? " was" : "s were"} not parsed (too large, or beyond the run limit) — those runs count by verdict only.`
    );
  }
  if (s.missed) {
    lines.push(
      "",
      `**Partial:** the simulator counted ${s.missed} more warning / error / fatal report${s.missed === 1 ? "" : "s"} than could be read from the logs — ${s.missed === 1 ? "it is" : "they are"} on no block.`
    );
  }
  lines.push("", "## Runs", "", "| test | seed | status |", "| --- | --- | --- |");
  for (const r of s.runs) {
    lines.push(`| ${r.test} | ${r.seed || "—"} | ${r.status === "UNKNOWN" ? "no verdict" : r.status} |`);
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
      lines.push(`- … and ${all - shown} more of other, less severe kinds (see the logs)`);
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
