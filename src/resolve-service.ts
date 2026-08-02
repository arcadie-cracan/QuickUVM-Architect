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

import * as path from "path";
import * as vscode from "vscode";
import { invokeQuickUvm } from "./generate";
import { parseResolved, type ResolvedConfig } from "./resolved";

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
      if (!this.warned && r.err.trim()) {
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
