// The EFFECTIVE topology of a config, with provenance — the parsed output of
// `quick-uvm resolve` (QuickUVM >= 1.1.0). PURE (no `vscode`), testable in Node
// (scripts/test-resolved.mjs).
//
// Why this exists: the YAML understates the artifact. Without an `analysis:` key
// the generator enters IMPLICIT mode and wires a scoreboard AND a coverage
// collector onto the primary agent — components that appear in the testbench but
// nowhere in the file, so the verification diagram drew an Env holding a lone
// agent while the generated env held three things. The user reported exactly that
// gap ("why does the tutorial ask for a scoreboard if one is inferred anyway").
//
// `manifest` cannot answer it — it is byte-identical either side of the mode
// switch, because it maps files to owners rather than describing topology. Hence
// a second command, and hence this module.
//
// The rules stay in the GENERATOR. We deliberately do not re-derive "implicit mode
// means sbd + cov on agents[0]" in TypeScript, however small that rule looks: it
// is generator policy, it has already changed once, and a silent drift here would
// draw a bench that does not exist. This module only READS provenance.

/** one `analysis.scoreboards` entry, resolved */
export interface ResolvedScoreboard {
  name: string;
  source: string;
  monitor?: string;
  match?: string;
  origin: "declared" | "inferred";
}

/** one `analysis.coverage` entry, resolved */
export interface ResolvedCoverage {
  agent: string;
  origin: "declared" | "inferred";
}

export interface ResolvedNamed {
  name: string;
  origin: "declared" | "inferred";
}

export interface ResolvedAgent extends ResolvedNamed {
  sequences: ResolvedNamed[];
}

export interface ResolvedConfig {
  version: string;
  dut: string;
  analysis: {
    /** `implicit` = no `analysis:` key in the YAML; the generator supplies both
     *  components below. `declared` = exactly what is listed, possibly nothing. */
    mode: "implicit" | "declared";
    scoreboards: ResolvedScoreboard[];
    coverage: ResolvedCoverage[];
  };
  tests: ResolvedNamed[];
  virtual_sequences: ResolvedNamed[];
  agents: ResolvedAgent[];
  /** the runtime guards this config arms, e.g. `UNCOVERED_AGENT: pkt` */
  guards: string[];
}

/** A component the generator supplies that the config never mentions, addressed by
 *  the TB-diagram / verification-tree node id it should be drawn as. */
export interface InferredComponent {
  /** the node id in `buildTbScene` / `buildTbTree` — `sb:<name>`, `cov:<agent>` */
  id: string;
  kind: "scoreboard" | "coverage";
  /** the scoreboard's name, or the covered agent */
  name: string;
  /** the agent it is wired to (both kinds are wired to the primary agent) */
  source: string;
}

/**
 * Does quick-uvm really GENERATE what `resolve` says it infers for this bench?
 *
 * `resolve` up to quick-uvm 1.2.0 reports the scoreboard `sbd` and a collector
 * on the first agent whenever `analysis:` is absent and there is an agent. It
 * does not look at the shape of the bench, and on three shapes the generator's
 * env wires neither — and REFUSES both once they are declared (measured, Nov
 * 2026):
 *   - a composition (`subenvs`), pure or hybrid: "a `subenvs` top does not wire
 *     `analysis.coverage`", "a composition scoreboard is two-stream";
 *   - `kind: vip`: the bench layer is not emitted at all, and bare coverage /
 *     scoreboards "would be silently dropped";
 *   - an agent with `replicas` > 1 or `instances`: the per-instance env has its
 *     own scoreboards and no collector ("does not yet wire coverage").
 * There the reported set is not a set of components: it must be neither drawn
 * as ghosts, nor offered for materialising, nor kept by a gesture — writing it
 * turned a configuration that generated into one that does not.
 *
 * This is the one place the extension knows something about WHERE inference
 * happens; what is inferred still comes from the generator alone. Each shape
 * is locked in `test:e2e` (scenario 17) against the generator, so a quick-uvm
 * that starts wiring one of them makes that lock fail instead of this fence
 * hiding real components.
 *
 * quick-uvm 1.3.0 fixed the report (QuickUVM#121): there `resolve` reports
 * nothing inferred on these shapes, and this fence changes nothing. It stays
 * for 1.2.0 and older, which the extension supports.
 */
export function inferenceIsReal(
  config:
    | { subenvs?: unknown; kind?: unknown; agents?: unknown }
    | null
    | undefined
): boolean {
  if (!config) {
    return true; // nothing known about the bench: `resolve` stands alone
  }
  if (Array.isArray(config.subenvs) && config.subenvs.length > 0) {
    return false;
  }
  if (config.kind === "vip") {
    return false;
  }
  for (const a of Array.isArray(config.agents) ? config.agents : []) {
    if (!a || typeof a !== "object") {
      continue;
    }
    const { replicas, instances } = a as { replicas?: unknown; instances?: unknown };
    if (typeof replicas === "number" && replicas > 1) {
      return false;
    }
    if (Array.isArray(instances) && instances.length > 0) {
      return false;
    }
  }
  return true;
}

/** what `ResolveService.resolveText` answers: the resolved view of a text, or
 *  why there is none (the user is told which — the remedy differs) */
export interface LiveResolve {
  resolved: ResolvedConfig | null;
  /** `no-command`: a quick-uvm without `resolve` (< 1.1.0); `refused`: it
   *  rejects the configuration (`detail` = its first error line); `failed`:
   *  it could not be run, or did not answer in time */
  why?: "no-command" | "refused" | "failed";
  detail?: string;
}

/** the gesture that is about to write the FIRST `analysis:` entry of a bench */
export type FirstAnalysisGesture =
  | { kind: "scoreboard"; source: string }
  | { kind: "coverage"; agent: string };

/** what that gesture must write NEXT TO its own entry (docs/07, "Interim") */
export interface KeepPlan {
  /** false: what quick-uvm infers for this configuration is not known — there
   *  is no resolved view, it describes a file that already declares
   *  `analysis:`, or it describes OTHER agents than the live configuration has */
  known: boolean;
  /** inferred scoreboards to declare, verbatim */
  scoreboards: { name: string; source: string; monitor?: string; match?: string }[];
  /** agents whose inferred coverage collector is to be declared */
  coverage: string[];
  /** inferred scoreboards the new one takes the place of (the same source) */
  replaced: string[];
  /** inferred components left out because their agent is no longer in the live
   *  configuration (`sb:<name>` / `cov:<agent>`) */
  dangling: string[];
}

/**
 * Writing the first `analysis:` entry switches quick-uvm from implicit to
 * declared mode, and everything it inferred stops being generated — a gesture
 * that adds ONE scoreboard silently took the coverage collector away, and one
 * that adds coverage on another agent took the scoreboard and the collector
 * (measured with `quick-uvm resolve`, Nov 2026). This says what the gesture
 * must declare with its own entry so that nothing the user had disappears.
 *
 * The rule (the user's decision, Nov 2026): inferred COVERAGE is always kept;
 * an inferred SCOREBOARD is kept unless the new scoreboard checks the same
 * source agent — then the new one is its replacement, not a second checker of
 * one stream. The set comes from the generator; nothing is re-derived here.
 *
 * The resolved view must be OF THE LIVE TEXT (the host resolves a copy of
 * the document, saved or not): one whose agents are not the live
 * configuration's, in order — the primary agent is the first — is another
 * file's answer, and the plan says it does not know rather than keep a set
 * that is not this bench's. As a second wall, a component whose agent is
 * missing is left out and reported, never written as a dangling endpoint.
 * Call it only for a bench whose LIVE config is implicit.
 */
export function keepOnFirstAnalysis(
  resolved: ResolvedConfig | null | undefined,
  liveAgents: readonly string[],
  gesture: FirstAnalysisGesture
): KeepPlan {
  const plan: KeepPlan = { known: false, scoreboards: [], coverage: [], replaced: [], dangling: [] };
  if (!resolved || resolved.analysis?.mode !== "implicit") {
    return plan;
  }
  if (Array.isArray(resolved.agents)) {
    const theirs = resolved.agents.map((a) => a?.name);
    if (theirs.length !== liveAgents.length || theirs.some((n, i) => n !== liveAgents[i])) {
      return plan; // the answer is about another state of the file
    }
  }
  plan.known = true;
  const live = new Set(liveAgents);
  for (const sb of resolved.analysis.scoreboards ?? []) {
    if (sb.origin !== "inferred" || !sb.name) {
      continue;
    }
    if (gesture.kind === "scoreboard" && sb.source === gesture.source) {
      plan.replaced.push(sb.name);
    } else if (!live.has(sb.source) || (sb.monitor !== undefined && !live.has(sb.monitor))) {
      plan.dangling.push(`sb:${sb.name}`);
    } else {
      plan.scoreboards.push({
        name: sb.name,
        source: sb.source,
        ...(sb.monitor ? { monitor: sb.monitor } : {}),
        ...(sb.match ? { match: sb.match } : {}),
      });
    }
  }
  for (const c of resolved.analysis.coverage ?? []) {
    if (c.origin !== "inferred" || !c.agent) {
      continue;
    }
    if (gesture.kind === "coverage" && c.agent === gesture.agent) {
      continue; // the gesture declares this very collector
    }
    if (!live.has(c.agent)) {
      plan.dangling.push(`cov:${c.agent}`);
    } else if (!plan.coverage.includes(c.agent)) {
      plan.coverage.push(c.agent);
    }
  }
  return plan;
}

/**
 * The inferred components of a resolved config, in diagram-node terms.
 *
 * Only `origin: "inferred"` entries are returned: a declared scoreboard is already
 * in the YAML and is already drawn from it, so returning it too would double the
 * node. That asymmetry is the whole contract — this list is exactly the set the
 * config does NOT contain.
 */
// Pass the LIVE `config` wherever there is one: on the shapes where `resolve`
// reports components the generator does not generate (`inferenceIsReal`) the
// list is empty — a ghost there is a box for something that does not exist.
export function inferredComponents(
  resolved: ResolvedConfig | null | undefined,
  config?: { subenvs?: unknown; kind?: unknown; agents?: unknown } | null
): InferredComponent[] {
  if (!resolved || (config && !inferenceIsReal(config))) {
    return [];
  }
  const out: InferredComponent[] = [];
  for (const sb of resolved.analysis?.scoreboards ?? []) {
    if (sb.origin === "inferred" && sb.name) {
      out.push({
        id: `sb:${sb.name}`,
        kind: "scoreboard",
        name: sb.name,
        source: sb.source,
      });
    }
  }
  for (const c of resolved.analysis?.coverage ?? []) {
    if (c.origin === "inferred" && c.agent) {
      out.push({
        id: `cov:${c.agent}`,
        kind: "coverage",
        name: c.agent,
        source: c.agent,
      });
    }
  }
  return out;
}

/** Parse `quick-uvm resolve` stdout, or null when it is not usable (older
 *  quick-uvm printing nothing, an invalid config, malformed JSON). Never throws:
 *  a missing resolve degrades to "no ghosts", never to a broken diagram. */
export function parseResolved(stdout: string): ResolvedConfig | null {
  const text = stdout.trim();
  if (!text) {
    return null; // redundant with the catch below (JSON.parse("") throws) — kept
    // because empty stdout is the EXPECTED shape for quick-uvm < 1.1.0, not an error
  }
  try {
    const r = JSON.parse(text) as ResolvedConfig;
    return r && typeof r === "object" && r.analysis ? r : null;
  } catch {
    return null;
  }
}
