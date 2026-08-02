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
 * The inferred components of a resolved config, in diagram-node terms.
 *
 * Only `origin: "inferred"` entries are returned: a declared scoreboard is already
 * in the YAML and is already drawn from it, so returning it too would double the
 * node. That asymmetry is the whole contract — this list is exactly the set the
 * config does NOT contain.
 */
export function inferredComponents(
  resolved: ResolvedConfig | null | undefined
): InferredComponent[] {
  if (!resolved) {
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
