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
  /** the newest `status` file's modification time (ms): when the regression ran */
  at: number | null;
  /** runs whose log was too large (or too many) to parse: verdict only */
  unparsed: number;
}

/** what was READ from the directory, before it is attributed to elements */
interface Raw {
  dir: string;
  runs: RunResult[];
  coverage: CoverageRow[];
  at: number | null;
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
  /** the state the user hid ("Hide Simulation Results"), as a signature: the
   *  same results stay hidden, NEW ones (another regression) show again */
  private hiddenSig: string | null = null;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** fired when what the diagram should show changes */
  readonly onDidChange = this.emitter.event;
  private watchers: vscode.Disposable[] = [];
  private watched: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private gen = 0;
  private readonly reports = new Map<string, string>();
  private readonly docEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly registration: vscode.Disposable;

  constructor(private readonly deps: ResultsDeps) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(RESULTS_SCHEME, {
      onDidChange: this.docEmitter.event,
      provideTextDocumentContent: (uri) => this.provideTextDocumentContent(uri),
    });
  }

  /** what was read, attributed — whether or not the user hid it */
  get current(): ResultsState | null {
    return this.state;
  }

  /** what the diagram shows: nothing while the current results are hidden */
  get shown(): ResultsState | null {
    return this.state && this.hiddenSig === JSON.stringify(this.state) ? null : this.state;
  }

  /** where the generated Makefile puts its results: `<outputDir>/out` (its
   *  `OUT ?= out`, relative to the bench directory `make` runs in) */
  resultsDir(): string | undefined {
    const out = this.deps.outDir();
    return out ? path.join(out, "out") : undefined;
  }

  /**
   * Re-reads the results directory. Safe to call at any time: a newer call
   * supersedes an older one still reading (a regression writes many files in a
   * burst), and a directory that is not there simply means "no results".
   * `show`: an explicit refresh un-hides.
   */
  async refresh(show = false): Promise<void> {
    const dir = this.resultsDir();
    this.retarget(dir);
    const gen = ++this.gen;
    const raw = dir ? await this.read(dir) : null;
    if (gen !== this.gen) {
      return;
    }
    this.raw = raw;
    if (show) {
      this.hiddenSig = null;
    }
    this.fold(show);
  }

  /**
   * The cheap path, for a configuration change: the element NAMES decide the
   * attribution, the files do not change. Re-reads only when the output
   * directory moved (another bench became active).
   */
  async update(): Promise<void> {
    if (this.resultsDir() !== this.raw?.dir || this.resultsDir() !== this.watched) {
      await this.refresh();
    } else {
      this.fold(false);
    }
  }

  /** hides the results that are there now; the next DIFFERENT ones show */
  hide(): void {
    if (this.state) {
      this.hiddenSig = JSON.stringify(this.state);
      this.emitter.fire();
    }
  }

  /** debounced refresh: a regression finishes its runs one `status` at a time */
  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 400);
  }

  private fold(force: boolean): void {
    const before = JSON.stringify(this.state);
    const raw = this.raw;
    this.state = raw
      ? {
          snapshot: summarizeResults(raw.runs, raw.coverage, this.deps.names(), this.deps.ownerOfFile),
          dir: raw.dir,
          at: raw.at,
          unparsed: raw.unparsed,
        }
      : null;
    if (force || JSON.stringify(this.state) !== before) {
      this.emitter.fire();
    }
  }

  private async read(dir: string): Promise<Raw | null> {
    const fs = vscode.workspace.fs;
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
    const runs: RunResult[] = [];
    let at: number | null = null;
    let unparsed = 0;
    const dirs = entries
      .filter(([, t]) => (t & vscode.FileType.Directory) !== 0)
      .map(([n]) => n)
      .sort();
    for (const name of dirs) {
      const base = vscode.Uri.joinPath(runsDir, name);
      const statusUri = vscode.Uri.joinPath(base, "status");
      const status = await text(statusUri);
      try {
        at = Math.max(at ?? 0, (await fs.stat(statusUri)).mtime);
      } catch {
        // no status yet: the run is in flight (or crashed before its verdict)
      }
      let log: string | undefined;
      const logUri = vscode.Uri.joinPath(base, "sim.log");
      if (runs.length < MAX_PARSED_RUNS) {
        try {
          if ((await fs.stat(logUri)).size <= MAX_LOG_BYTES) {
            log = await text(logUri);
          } else {
            unparsed++;
          }
        } catch {
          // no log: a run that never started — its status (if any) still counts
        }
      } else {
        unparsed++;
      }
      runs.push(
        runResult(name, {
          status,
          test: await text(vscode.Uri.joinPath(base, "test.txt")),
          seed: await text(vscode.Uri.joinPath(base, "seed.txt")),
          log,
        })
      );
    }
    if (!runs.length) {
      return null;
    }
    const cov = await text(vscode.Uri.file(path.join(dir, "cov", "summary.txt")));
    const passed = runs.filter((r) => r.status === "PASS").length;
    const failed = runs.filter((r) => r.status === "FAIL").length;
    this.deps.log.appendLine(
      `[results] ${runs.length} run(s) under ${dir}: ${passed} passed, ${failed} failed` +
        (unparsed ? `, ${unparsed} log(s) not parsed` : "")
    );
    return { dir, runs, coverage: cov ? parseImcSummary(cov) : [], at, unparsed };
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

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.reports.get(uri.toString()) ?? "";
  }

  /**
   * The results as a read-only document. A virtual one (an untitled document
   * is born dirty and asks to be saved), re-rendered in place when it is
   * already open — the traceability report's pattern.
   */
  async report(name: string, stale: boolean): Promise<boolean> {
    const st = this.state;
    if (!st) {
      return false;
    }
    const uri = vscode.Uri.from({ scheme: RESULTS_SCHEME, path: `/Simulation results — ${name}.md` });
    this.reports.set(uri.toString(), resultsReport(st, { name, stale }));
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
