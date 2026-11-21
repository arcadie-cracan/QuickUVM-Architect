// Simulation results on the verification view (docs/08 R25) — the HOST half:
// reading what a regression left on disk, and keeping it current.
//
// The extension never runs a simulator and never waits for one: it reads the
// files QuickUVM's generated Makefile writes under `<outputDir>/out/` (see
// `src/results.ts` for the layout and the parsing) whenever they change, and
// hands the diagram a folded snapshot. With nothing there, there is no
// snapshot and the diagram shows nothing — a bench that was never simulated is
// not a bench that passed.

import * as path from "path";
import * as vscode from "vscode";
import {
  parseImcSummary,
  resultsReport,
  runResult,
  summarizeResults,
  type BenchNames,
  type CoverageRow,
  type ResultsSnapshot,
  type RunResult,
} from "./results";

/** a log above this is not parsed: its run keeps its verdict (the `status`
 *  file), its reports are not attributed, and the snapshot says so */
const MAX_LOG_BYTES = 16 * 1024 * 1024;
/** runs beyond this are counted by verdict only (a wide seed sweep) */
const MAX_PARSED_RUNS = 200;

export const RESULTS_SCHEME = "quickuvm-results";

export interface ResultsState {
  snapshot: ResultsSnapshot;
  /** the results directory, absolute */
  dir: string;
  /** the NEWEST `status` file's modification time (ms): when the regression last ran */
  at: number | null;
  /** the OLDEST `status` shown: a configuration newer than it makes at least
   *  that run stale (one fresh run must not vouch for the old ones) */
  oldest: number | null;
  /** the coverage summary's own modification time; null without one */
  covAt: number | null;
  /** runs whose log was too large (or too many) to parse: verdict only */
  unparsed: number;
}

/** what was READ from the directory, before it is attributed to elements */
interface Raw {
  dir: string;
  runs: RunResult[];
  coverage: CoverageRow[];
  at: number | null;
  oldest: number | null;
  covAt: number | null;
  unparsed: number;
}

export interface ResultsDeps {
  /** the generated bench's directory (`quickuvm.outputDir`, absolute) */
  outDir: () => string | undefined;
  /** the element names of the active configuration */
  names: () => BenchNames;
  /** the diagram id that owns a generated file (the manifest), or null */
  ownerOfFile: (file: string) => string | null;
  log: vscode.OutputChannel;
}

export class ResultsService implements vscode.Disposable {
  private raw: Raw | null = null;
  private state: ResultsState | null = null;
  /** the DUT the results on disk belong to, when it is NOT the active bench's */
  private otherDut: string | null = null;
  /** the regression the user hid ("Hide Simulation Results"): the same runs
   *  stay hidden, another regression shows again. A signature of what was READ
   *  (a rename that only re-attributes them is not "other results") */
  private hiddenSig: string | null = null;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** fired when what the diagram should show changes */
  readonly onDidChange = this.emitter.event;
  private watchers: vscode.Disposable[] = [];
  private watched: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private gen = 0;
  /** a parsed run, kept while its files do not change: a regression fires one
   *  event per finished run, and re-reading every log each time was quadratic */
  private cache = new Map<string, { sig: string; run: RunResult; parsed: boolean }>();
  private cacheDir: string | undefined;
  private readonly reports = new Map<string, string>();
  private readonly docEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly registration: vscode.Disposable;

  constructor(private readonly deps: ResultsDeps) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(RESULTS_SCHEME, {
      onDidChange: this.docEmitter.event,
      provideTextDocumentContent: (uri) => this.reports.get(uri.toString()) ?? "",
    });
  }

  /** what was read, attributed — whether or not the user hid it */
  get current(): ResultsState | null {
    return this.state;
  }

  /** what the diagram shows: nothing while this regression is hidden */
  get shown(): ResultsState | null {
    return this.state && this.hiddenSig !== null && this.hiddenSig === this.sig() ? null : this.state;
  }

  /** the results on disk are another bench's (their coverage scope names this
   *  DUT, not the active configuration's): nothing is shown, and this says why */
  get foreign(): string | null {
    return this.otherDut;
  }

  /** where the generated Makefile puts its results: `<outputDir>/out` (its
   *  `OUT ?= out`, relative to the bench directory `make` runs in) */
  resultsDir(): string | undefined {
    const out = this.deps.outDir();
    return out ? path.join(out, "out") : undefined;
  }

  private sig(): string {
    const r = this.raw;
    return r
      ? `${r.dir}|${r.at}|${r.runs.map((x) => `${x.test}.${x.seed}:${x.status}`).join(",")}`
      : "";
  }

  /**
   * Re-reads the results directory. Safe to call at any time: a newer call
   * supersedes an older one still reading (a regression writes many files in a
   * burst), and a directory that is not there simply means "no results".
   * `show`: an explicit refresh un-hides — decided BEFORE the read, so a
   * superseding watcher refresh cannot lose it.
   */
  async refresh(show = false): Promise<void> {
    if (show) {
      this.hiddenSig = null;
    }
    const dir = this.resultsDir();
    this.retarget(dir);
    const gen = ++this.gen;
    const raw = dir ? await this.read(dir, gen) : null;
    if (gen !== this.gen || raw === "superseded") {
      return;
    }
    this.raw = raw;
    this.fold(show);
  }

  /**
   * The cheap path, for a configuration change: the element NAMES decide the
   * attribution, the files do not change. Re-reads only when the output
   * directory moved (another bench became active).
   */
  async update(): Promise<void> {
    const dir = this.resultsDir();
    if (dir !== this.watched || dir !== (this.raw?.dir ?? dir) || (dir && !this.raw)) {
      await this.refresh();
    } else {
      this.fold(false);
    }
  }

  /** hides the regression that is there now; another one shows again */
  hide(): void {
    if (this.state) {
      this.hiddenSig = this.sig();
      this.emitter.fire();
    }
  }

  /** debounced refresh: a regression finishes its runs one `status` at a time */
  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.refresh().catch((e) => this.deps.log.appendLine(`[results] refresh failed: ${String(e)}`));
    }, 400);
  }

  private fold(force: boolean): void {
    const before = JSON.stringify([this.state, this.otherDut]);
    const raw = this.raw;
    let names: BenchNames;
    try {
      names = this.deps.names();
    } catch (e) {
      // a configuration shape nobody foresaw: fewer names, never no results
      this.deps.log.appendLine(`[results] names unavailable: ${String(e)}`);
      names = { agents: [], scoreboards: [], subenvs: [] };
    }
    // OWNERSHIP: `quickuvm.outputDir` is one folder for the workspace, and a
    // workspace has several configurations (every composed bench does). The
    // runs say which DUT they covered (`-covscope`); when that is not the
    // active bench's, these are another bench's results — shown on this one
    // they would put its verdicts and its DUT coverage on the wrong diagram.
    const scopes = new Set((raw?.runs ?? []).map((r) => r.scope).filter((s): s is string => Boolean(s)));
    this.otherDut =
      raw && names.dut && scopes.size && !scopes.has(names.dut) ? [...scopes][0] : null;
    this.state =
      raw && !this.otherDut
        ? {
            snapshot: summarizeResults(raw.runs, raw.coverage, names, this.deps.ownerOfFile),
            dir: raw.dir,
            at: raw.at,
            oldest: raw.oldest,
            covAt: raw.covAt,
            unparsed: raw.unparsed,
          }
        : null;
    if (this.otherDut && before !== JSON.stringify([this.state, this.otherDut])) {
      this.deps.log.appendLine(
        `[results] the results under ${raw?.dir} are of DUT "${this.otherDut}", not "${names.dut}" — not shown`
      );
    }
    if (force || JSON.stringify([this.state, this.otherDut]) !== before) {
      this.emitter.fire();
    }
  }

  private async read(dir: string, gen: number): Promise<Raw | null | "superseded"> {
    const fs = vscode.workspace.fs;
    if (this.cacheDir !== dir) {
      this.cache.clear();
      this.cacheDir = dir;
    }
    const runsDir = vscode.Uri.file(path.join(dir, "runs"));
    let entries: [string, vscode.FileType][];
    try {
      entries = await fs.readDirectory(runsDir);
    } catch {
      return null; // never simulated (or cleaned): nothing to show
    }
    const text = async (uri: vscode.Uri): Promise<string | undefined> => {
      try {
        return Buffer.from(await fs.readFile(uri)).toString("utf8");
      } catch {
        return undefined;
      }
    };
    const stat = async (uri: vscode.Uri): Promise<vscode.FileStat | undefined> => {
      try {
        return await fs.stat(uri);
      } catch {
        return undefined;
      }
    };
    const runs: RunResult[] = [];
    let at: number | null = null;
    let oldest: number | null = null;
    let unparsed = 0;
    let parsedRuns = 0;
    const dirs = entries
      .filter(([, t]) => (t & vscode.FileType.Directory) !== 0)
      .map(([n]) => n)
      .sort();
    const alive = new Set(dirs);
    for (const k of [...this.cache.keys()]) {
      if (!alive.has(k)) {
        this.cache.delete(k);
      }
    }
    for (const name of dirs) {
      if (gen !== this.gen) {
        return "superseded"; // a newer refresh is reading: stop competing with it
      }
      const base = vscode.Uri.joinPath(runsDir, name);
      const statusUri = vscode.Uri.joinPath(base, "status");
      const logUri = vscode.Uri.joinPath(base, "sim.log");
      const st = await stat(statusUri);
      const lg = await stat(logUri);
      if (st) {
        at = Math.max(at ?? 0, st.mtime);
        oldest = Math.min(oldest ?? Number.MAX_SAFE_INTEGER, st.mtime);
      }
      // no `status` yet: the run is in flight (the Makefile writes it LAST) —
      // it is read as "no verdict", and re-read when its files change
      const sig = `${st?.mtime ?? "-"}|${lg?.mtime ?? "-"}|${lg?.size ?? "-"}`;
      const hit = this.cache.get(name);
      if (hit && hit.sig === sig) {
        runs.push(hit.run);
        if (hit.parsed) {
          parsedRuns++;
        } else if (lg) {
          unparsed++;
        }
        continue;
      }
      let log: string | undefined;
      let parsed = false;
      if (lg) {
        if (parsedRuns < MAX_PARSED_RUNS && lg.size <= MAX_LOG_BYTES) {
          log = await text(logUri);
          parsed = log !== undefined;
        }
        if (parsed) {
          parsedRuns++;
        } else {
          unparsed++;
        }
      }
      const run = runResult(name, {
        status: st ? await text(statusUri) : undefined,
        test: await text(vscode.Uri.joinPath(base, "test.txt")),
        seed: await text(vscode.Uri.joinPath(base, "seed.txt")),
        log,
      });
      this.cache.set(name, { sig, run, parsed });
      runs.push(run);
    }
    if (!runs.length) {
      return null;
    }
    const covUri = vscode.Uri.file(path.join(dir, "cov", "summary.txt"));
    const cov = await text(covUri);
    const covAt = cov !== undefined ? (await stat(covUri))?.mtime ?? null : null;
    const passed = runs.filter((r) => r.status === "PASS").length;
    const failed = runs.filter((r) => r.status === "FAIL").length;
    this.deps.log.appendLine(
      `[results] ${runs.length} run(s) under ${dir}: ${passed} passed, ${failed} failed` +
        (runs.length - passed - failed ? `, ${runs.length - passed - failed} without a verdict` : "") +
        (unparsed ? `, ${unparsed} log(s) not parsed` : "")
    );
    return { dir, runs, coverage: cov ? parseImcSummary(cov) : [], at, oldest, covAt, unparsed };
  }

  /** watches the results directory in force (re-armed when `outputDir` moves) */
  private retarget(dir: string | undefined): void {
    if (dir === this.watched) {
      return;
    }
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers = [];
    this.watched = dir;
    if (!dir) {
      return;
    }
    // the verdict files and the coverage summary: what a finished run writes
    // LAST — watching the logs would refresh on every line of a running sim
    for (const glob of ["runs/*/status", "cov/summary.txt"]) {
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), glob)
      );
      const bounce = (): void => this.schedule();
      w.onDidCreate(bounce);
      w.onDidChange(bounce);
      w.onDidDelete(bounce);
      this.watchers.push(w);
    }
  }

  // ------------------------------------------------------------- the report

  /**
   * The results as a read-only document. A virtual one (an untitled document
   * is born dirty and asks to be saved), re-rendered in place when it is
   * already open — the traceability report's pattern. `false` = nothing to
   * report.
   */
  async report(name: string, flags: { stale: boolean; covStale: boolean }): Promise<boolean> {
    const st = this.state;
    if (!st) {
      return false;
    }
    const uri = vscode.Uri.from({ scheme: RESULTS_SCHEME, path: `/Simulation results — ${name}.md` });
    this.reports.clear(); // one report at a time: the map must not grow with every bench
    this.reports.set(uri.toString(), resultsReport(st, { name, ...flags }));
    this.docEmitter.fire(uri);
    await vscode.workspace.openTextDocument(uri);
    try {
      await vscode.commands.executeCommand("markdown.showPreview", uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: true });
    }
    return true;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const w of this.watchers) {
      w.dispose();
    }
    this.registration.dispose();
    this.docEmitter.dispose();
    this.emitter.dispose();
  }
}
