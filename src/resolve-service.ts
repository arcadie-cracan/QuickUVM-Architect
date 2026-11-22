// Host service for the GHOST components in the verification view: runs
// `quick-uvm resolve -c <yaml>` (QuickUVM >= 1.1.0) and caches the effective
// topology, so the diagram can draw what the generator supplies but the config
// never mentions (src/resolved.ts explains why this cannot be derived locally).
//
// CACHED, never awaited on the render path. `config/full` is posted on every
// keystroke in the custom editor; blocking it on a Python subprocess would make
// typing lag. So the message carries whatever is cached — at worst one edit
// stale — and a completed resolve pushes a fresh `config/full` of its own. The
// pair stays ATOMIC (ghosts always travel with the config they describe), which
// a separate `resolved/*` message could not guarantee.
//
// Staleness has a floor: `resolve` reads the file on DISK, so between an edit and
// its save the cache describes the previous text. `buildTbScene` therefore drops
// every ghost as soon as the LIVE config has an `analysis:` key — the one-line
// mode switch — so a half-typed `analysis:` can never render as "declared
// scoreboard AND inferred ghosts", a state the generator cannot produce.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { invokeQuickUvm } from "./generate";
import { parseResolved, type LiveResolve, type ResolvedConfig } from "./resolved";

/** a gesture waits for this answer: a Python that hangs must not hang it */
const LIVE_RESOLVE_TIMEOUT_MS = 20000;

export class ResolveService implements vscode.Disposable {
  /** cached PER CONFIG URI. One slot would be wrong: the custom editor can hold a
   *  `*.quickuvm.yaml` that is NOT the active config, and answering it from a single
   *  cache would pair one bench's ghosts with another's diagram — the very thing
   *  travelling with `config/full` is meant to prevent. */
  private readonly cache = new Map<string, ResolvedConfig | null>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  /** fires with the config whose resolve just changed */
  readonly onDidChange = this.emitter.event;
  /** the active config, for the panel/sidebar which follow it */
  private active: string | undefined;
  /** per uri, the latest in-flight request — an older reply is discarded */
  private readonly seq = new Map<string, number>();
  /** logged once per session — a missing `resolve` is normal on older quick-uvm */
  private warned = false;

  constructor(private readonly log: vscode.OutputChannel) {}

  /** the effective topology of the ACTIVE config, or null when unavailable
   *  (quick-uvm < 1.1.0, an invalid config, no config at all) */
  get current(): ResolvedConfig | null {
    return this.active ? (this.cache.get(this.active) ?? null) : null;
  }

  /** the effective topology of ONE config — for the custom editor, which may hold a
   *  different file than the active one. Never falls back to another config's answer. */
  resolvedFor(uri: vscode.Uri): ResolvedConfig | null {
    return this.cache.get(uri.toString()) ?? null;
  }

  async refresh(configUri: vscode.Uri | undefined, active = true): Promise<void> {
    if (active) {
      this.active = configUri?.toString();
    }
    if (!configUri) {
      return;
    }
    const key = configUri.toString();
    // `resolve` reads the file on DISK. While the document is dirty the disk is
    // what it was at the last save, so a cached answer is still its answer — and
    // ConfigService refreshes on every 200 ms-debounced keystroke, which would
    // otherwise spawn a ~0.8 s Python process per burst only to repeat it. Never
    // skipped: the first answer (nothing cached yet) and a clean document.
    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === key
    );
    if (open?.isDirty && this.cache.has(key)) {
      return;
    }
    const mine = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, mine);

    const root = vscode.workspace.workspaceFolders?.[0];
    const cfg = vscode.workspace.getConfiguration("quickuvm", root?.uri);
    const cwd = root?.uri.fsPath ?? path.dirname(configUri.fsPath);

    const r = await invokeQuickUvm(["resolve", "-c", configUri.fsPath], cwd, cfg);
    if (this.seq.get(key) !== mine) {
      return; // a newer refresh for this config started while we waited — it wins
    }
    if (r.code !== 0) {
      // an invalid config, or a quick-uvm without `resolve`. Either way: no ghosts,
      // no diagnostic — ConfigService already reports what is wrong with the config,
      // and an old quick-uvm is a missing feature, not an error.
      // Logged once, and ONLY for a quick-uvm that lacks the command (click:
      // "No such command 'resolve'"). An invalid config also exits non-zero with a
      // pydantic message on stderr; it used to consume this one-shot log with a
      // misleading ">= 1.1.0 required" line, after which a genuinely old quick-uvm
      // was never logged at all.
      if (!this.warned && /No such command/i.test(r.err)) {
        this.warned = true;
        this.log.appendLine(
          `[resolve] unavailable — the verification view will not show inferred ` +
            `components (quick-uvm >= 1.1.0 required): ${r.err.trim().split("\n")[0]}`
        );
      }
      this.set(configUri, null);
      return;
    }
    this.set(configUri, parseResolved(r.out));
  }

  /**
   * The effective topology of a TEXT — the live document, saved or not (docs/07
   * "Interim"). A gesture that is about to write the first `analysis:` entry
   * must know what quick-uvm infers for the configuration AS IT STANDS, and the
   * cache cannot say: it describes the file on disk, and with
   * `quickuvm.autoSaveConfig` off (the default) the disk lags behind every
   * gesture since the last save.
   *
   * A copy of the text is resolved from a temporary folder, never from the
   * workspace: a scratch `*.quickuvm.yaml` there would be discovered as a
   * configuration. A composition's relative `subenvs[].config` paths do not
   * resolve from that folder (a file a relative path points at — a VIP
   * manifest — is not there) — then, and only for a document that is NOT
   * dirty, the cached answer of the file itself is the same thing. Not cached,
   * not announced: it answers one question and is gone. When there is no
   * answer it says WHY: the remedy is not the same for a quick-uvm without the
   * command, a configuration it refuses, and a process that could not be run.
   */
  async resolveText(text: string, configUri: vscode.Uri): Promise<LiveResolve> {
    const root = vscode.workspace.workspaceFolders?.[0];
    const cfg = vscode.workspace.getConfiguration("quickuvm", root?.uri);
    let dir: string | undefined;
    let live: LiveResolve = { resolved: null, why: "failed" };
    try {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "quickuvm-resolve-"));
      const file = path.join(dir, path.basename(configUri.fsPath));
      await fs.promises.writeFile(file, text, "utf8");
      const run = invokeQuickUvm(["resolve", "-c", file], root?.uri.fsPath ?? dir, cfg);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((done) => {
        timer = setTimeout(() => done(null), LIVE_RESOLVE_TIMEOUT_MS);
      });
      const r = await Promise.race([run, late]);
      clearTimeout(timer);
      if (!r) {
        live = { resolved: null, why: "failed", detail: "quick-uvm did not answer in time" };
      } else if (r.code === 0) {
        const resolved = parseResolved(r.out);
        live = resolved ? { resolved } : { resolved: null, why: "failed" };
      } else if (/No such command/i.test(r.err)) {
        live = { resolved: null, why: "no-command" };
      } else if (r.enoent) {
        live = { resolved: null, why: "failed", detail: "quick-uvm could not be started" };
      } else {
        // pydantic prints the reason under an "Invalid config" heading: the
        // first line that says something is the one to show
        const lines = r.err.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const first = lines.find((l) => !/^(Error:|Traceback|\d+ validation error)/i.test(l)) ?? lines[0];
        live = { resolved: null, why: "refused", detail: first?.slice(0, 240) };
      }
    } catch (e) {
      this.log.appendLine(`[resolve] the live text could not be resolved: ${String(e)}`);
    } finally {
      if (dir) {
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    if (live.resolved) {
      return live;
    }
    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === configUri.toString()
    );
    const cached =
      open && !open.isDirty && open.getText() === text ? this.resolvedFor(configUri) : null;
    return cached ? { resolved: cached } : live;
  }

  private set(uri: vscode.Uri, next: ResolvedConfig | null): void {
    const key = uri.toString();
    if (
      this.cache.has(key) &&
      JSON.stringify(this.cache.get(key)) === JSON.stringify(next)
    ) {
      return; // unchanged — avoid a redundant re-render of every open view
    }
    this.cache.set(key, next);
    this.emitter.fire(uri);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
