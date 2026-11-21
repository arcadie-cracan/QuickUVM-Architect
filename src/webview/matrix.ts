// The matrix editor's model (docs/08 R22) — pure, no DOM.
//
// A many-to-many relationship is easier to read, and to edit, as a table than
// as wires once it is big enough: which agent feeds which scoreboard, which
// agents are covered; on a composition, which block output drives which block
// input. Each matrix is DERIVED from the configuration on every render and a
// cell holds the host action a click sends — the same actions the canvas
// gestures and the Properties panel send (`editScoreboard`, `addCoverage`,
// `deleteComponent`, `addConnection`, `removeConnection`), so the table owns
// no rule of its own beyond "is this cell legal, and why not".
//
// Tested in `npm run test:matrix`.

import { coveredAgent, scoreboardEndpoints } from "../coverage";
import type { ActionKind } from "../protocol";
import type { QuvmConfig, QuvmScoreboard } from "../quickuvm";
import { subPortWidth } from "./wiring";

export interface MatrixAction {
  action: ActionKind;
  args: Record<string, unknown>;
}

export interface MatrixCell {
  on: boolean;
  /** what the cell shows when on: "S" (source), "M" (monitor), "●" */
  mark: string;
  /** why a click does nothing; absent = clickable */
  disabled?: string;
  /** what a click sends (absent on a disabled cell) */
  click?: MatrixAction;
  /** the tooltip: what a click does, or why it cannot */
  title: string;
  /** the click also removes something the user did not point at (a scoreboard's
   *  `window` when it gets a monitor) — drawn marked, the title says what */
  warn?: true;
}

export interface MatrixColumn {
  id: string;
  /** the column's own header ("source", "monitor", a port name) */
  label: string;
  /** the header spanning its group (a scoreboard's name, a block's name) */
  group: string;
}

export interface Matrix {
  kind: "analysis" | "connections";
  title: string;
  /** what the rows are, for the corner header */
  corner: string;
  rows: { id: string; label: string; group: string }[];
  cols: MatrixColumn[];
  /** cells[row][col] */
  cells: MatrixCell[][];
  /** a line above the table: a mode that disables it, a child that is unreadable */
  note?: string;
}

/** "offer it from ~4x4 upwards" (docs/08 R22): below that the canvas says it
 *  better, and the header button would be noise */
export function worthOffering(m: Matrix | null): boolean {
  return m !== null && m.rows.length * m.cols.length >= 16;
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const IMPLICIT =
  "implicit mode — quick-uvm infers the analysis components; declaring one here " +
  "would drop the others. Materialise the inferred set first (the proposal strip)";

/**
 * Agents x scoreboards / coverage. Rows are the endpoints a scoreboard can name
 * (this bench's agents, then the composed children's `<subenv>.<agent>`); each
 * named scoreboard gets a `source` and a `monitor` column, and a last column
 * says which agents are covered.
 *
 * The rules are the generator's: a scoreboard has exactly ONE source (moving it
 * is a click on another row, never a clear), at most one monitor (a click on it
 * clears it — single-stream again, `match` and `match_key` go with it), and the
 * two are different agents. A scoreboard that cannot be addressed by name
 * (unnamed, or sharing its name) is shown and not editable. null without agents.
 */
export function analysisMatrix(
  cfg: QuvmConfig | null | undefined,
  childAgents: Readonly<Record<string, readonly string[]>> = {}
): Matrix | null {
  const own = list<{ name?: string }>(cfg?.agents)
    .map((a) => a?.name)
    .filter((n): n is string => Boolean(n));
  if (!cfg || !own.length) {
    return null;
  }
  const endpoints = scoreboardEndpoints(own, childAgents);
  const rows = endpoints.map((id) => ({
    id,
    label: id,
    group: id.includes(".") ? id.split(".")[0] : "",
  }));
  // `analysis:` absent, or present with no value, is implicit mode
  const implicit = cfg.analysis === undefined || cfg.analysis === null;
  const sbs = list<QuvmScoreboard>(cfg.analysis?.scoreboards).filter((s) => s);
  const names = sbs.map((s) => s.name);
  const cols: MatrixColumn[] = [];
  for (let i = 0; i < sbs.length; i++) {
    const group = sbs[i].name || `scoreboard ${i + 1}`;
    cols.push(
      { id: `sb${i}.source`, label: "source", group },
      { id: `sb${i}.monitor`, label: "monitor", group }
    );
  }
  cols.push({ id: "coverage", label: "covered", group: "coverage" });
  const covered = new Set(
    list<unknown>(cfg.analysis?.coverage)
      .map(coveredAgent)
      .filter((n): n is string => Boolean(n))
  );

  const cells: MatrixCell[][] = rows.map((row) => {
    const out: MatrixCell[] = [];
    for (const sb of sbs) {
      const unaddressable = !sb.name
        ? "name the scoreboard first — its endpoints are set by name"
        : names.filter((n) => n === sb.name).length > 1
          ? "another scoreboard has this name — rename it first"
          : null;
      for (const field of ["source", "monitor"] as const) {
        const on = sb[field] === row.id;
        const other = field === "source" ? sb.monitor : sb.source;
        const cell: MatrixCell = { on, mark: field === "source" ? "S" : "M", title: "" };
        if (implicit) {
          cell.disabled = IMPLICIT;
        } else if (unaddressable) {
          cell.disabled = unaddressable;
        } else if (on && field === "source") {
          cell.disabled = "a scoreboard needs a source — click another agent to move it";
        } else if (!on && other === row.id) {
          cell.disabled = `${row.id} is already this scoreboard's ${
            field === "source" ? "monitor" : "source"
          } — the two streams are different agents`;
        } else {
          cell.click = {
            action: "editScoreboard",
            args: { name: sb.name, field, value: on ? "" : row.id },
          };
          // a monitor makes the scoreboard two-stream, which a window cannot be:
          // the mutation drops `window` with it — said here, not found out later
          const windowed = field === "monitor" && !sb.monitor && sb.window != null;
          cell.title = on
            ? `Clear the monitor of ${sb.name} — single-stream again (match and match_key go too)`
            : field === "source"
              ? `Make ${row.id} the source of ${sb.name}`
              : `Make ${row.id} the monitor of ${sb.name}` +
                (windowed ? " — its window is removed (a window is single-stream only)" : "");
          if (windowed) {
            cell.warn = true;
          }
        }
        cell.title ||= cell.disabled ?? "";
        out.push(cell);
      }
    }
    const isOwn = !row.group;
    const on = covered.has(row.id);
    const cov: MatrixCell = { on, mark: "●", title: "" };
    if (!isOwn) {
      cov.disabled = "a composed block's coverage belongs to its own configuration";
    } else if (implicit) {
      cov.disabled = IMPLICIT;
    } else {
      cov.click = on
        ? { action: "deleteComponent", args: { kind: "coverage", name: row.id } }
        : { action: "addCoverage", args: { agent: row.id } };
      cov.title = on
        ? `Remove the coverage collector of ${row.id} (asks first)`
        : `Add a coverage collector on ${row.id}`;
    }
    cov.title ||= cov.disabled ?? "";
    out.push(cov);
    return out;
  });
  return {
    kind: "analysis",
    title: "Agents × scoreboards / coverage",
    corner: "agent",
    rows,
    cols,
    cells,
    note: implicit ? `Read-only: ${IMPLICIT}.` : undefined,
  };
}

/**
 * Block outputs x block inputs on a composition: a cell is a `connections`
 * entry. Rows are the outputs of every composed block (`<subenv>.<port>`, the
 * ports its agents sample), columns the inputs (the ports its agents drive) —
 * both from the children's configurations, so a child that cannot be read
 * contributes nothing and the note says so.
 *
 * A cell is illegal for the reasons the generator refuses a connection: the two
 * ends on the same block, an input that already has a driver (one driver per
 * input), different widths when both are known. A width that cannot be known
 * (a parameter, packed dims, a struct) is not a reason. null without two
 * composed blocks.
 */
export function connectionsMatrix(
  cfg: QuvmConfig | null | undefined,
  children: Readonly<Record<string, QuvmConfig>> | undefined
): Matrix | null {
  const subs = list<{ name?: string }>(cfg?.subenvs)
    .map((s) => s?.name)
    .filter((n): n is string => Boolean(n));
  if (!cfg || subs.length < 2) {
    return null;
  }
  // a name composed twice shares its ports' ids: neither instance is addressable
  const unique = subs.filter((n) => subs.indexOf(n) === subs.lastIndexOf(n));
  const unreadable = unique.filter((n) => !children?.[n]);
  const ports = (sub: string, dir: "outputs" | "inputs"): string[] => {
    const seen = new Set<string>();
    for (const a of list<{ ports?: Record<string, unknown> }>(children?.[sub]?.agents)) {
      for (const p of list<{ name?: string }>(a?.ports?.[dir])) {
        if (p?.name) {
          seen.add(p.name);
        }
      }
    }
    return [...seen];
  };
  const rows = unique.flatMap((sub) =>
    ports(sub, "outputs").map((p) => ({ id: `${sub}.${p}`, label: p, group: sub }))
  );
  const cols: MatrixColumn[] = unique.flatMap((sub) =>
    ports(sub, "inputs").map((p) => ({ id: `${sub}.${p}`, label: p, group: sub }))
  );
  if (!rows.length || !cols.length) {
    return null;
  }
  const conns = list<{ from?: string; to?: string }>(cfg.connections).filter((c) => c);
  const driver = new Map<string, string>();
  for (const c of conns) {
    if (c.from && c.to && !driver.has(c.to)) {
      driver.set(c.to, c.from);
    }
  }
  const cells: MatrixCell[][] = rows.map((row) =>
    cols.map((col) => {
      const on = conns.some((c) => c.from === row.id && c.to === col.id);
      const cell: MatrixCell = { on, mark: "●", title: "" };
      if (on) {
        cell.click = { action: "removeConnection", args: { from: row.id, to: col.id } };
        cell.title = `Remove ${row.id} → ${col.id}`;
        return cell;
      }
      const drv = driver.get(col.id);
      const wf = subPortWidth(children, row.group, row.label, "out");
      const wt = subPortWidth(children, col.group, col.label, "in");
      if (row.group === col.group) {
        cell.disabled = "both ends are on the same block";
      } else if (drv) {
        cell.disabled = `already driven by ${drv} — one driver per input`;
      } else if (wf !== null && wt !== null && wf !== wt) {
        cell.disabled = `width ${wf} ≠ ${wt} — quick-uvm requires equal widths`;
      } else {
        cell.click = { action: "addConnection", args: { from: row.id, to: col.id } };
        cell.title = `Connect ${row.id} → ${col.id} (the destination's agents become passive)`;
      }
      cell.title ||= cell.disabled ?? "";
      return cell;
    })
  );
  return {
    kind: "connections",
    title: "Block outputs × block inputs",
    corner: "output → input",
    rows,
    cols,
    cells,
    note: unreadable.length
      ? `The ports of ${unreadable.join(", ")} are unknown: the configuration could not be read.`
      : undefined,
  };
}
