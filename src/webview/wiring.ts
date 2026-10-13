// The legality and the outcomes of the "temporary wire" gestures in the
// verification view (docs/08 R10 + R11) — a PURE module (no DOM), tested in
// Node (scripts/test-wiring.mjs). main.ts owns the pointer state machine and
// the drawing; everything that decides WHAT a drop means lives here, so the
// rules can be pinned by tests and read in one place.
//
// Three origins exist today:
//   agent-ap — the analysis port of an agent: dropped on empty canvas it CREATES a
//              scoreboard fed by the agent or a coverage collector on it (R10, the
//              pin-drop create of Blueprints / Blender / Simulink); dropped on a
//              scoreboard it becomes its source or monitor (R11);
//   sb-port  — a scoreboard's source/monitor input: dropped on an agent it
//              RETARGETS that endpoint (R11, `setScoreboardField`); dropped on
//              empty canvas it offers the legal agents as a menu;
//   RTL pin  — a DUT pin in the symbol / a child block's pin in the schematic:
//              dropped on empty canvas it creates an agent (from the pin, from
//              the selected pins, from the interface); dropped on a pin an agent
//              already claims, the pins JOIN that agent (`addPinsToAgent`).
//   sub-port — a composed block's signal port (its child agents' ports, from
//              `config/full.children`): an output dropped on another block's
//              input — or the reverse — writes a `connections` entry
//              (`addConnection`, the same multi-file plan as "Wire connections
//              from design": the destination's agents go passive). Legality:
//              another block, one driver per input, equal widths when both
//              are known (R11 for the composition).
// Every outcome is an existing host action with its args filled in — the same
// mutation the inspector would send — so the YAML write path does not change.
// Legality is computed ONCE at pointer-down and shown before the drop (Simulink
// R2018b, Vivado's green check): a target is either legal (null) or carries the
// reason it is not, which the canvas shows as a hint.

import type { ActionKind } from "../protocol";
import { scoreboardNodeIds, type QuvmConfig, type QuvmScoreboard } from "../quickuvm";
import type { TbNode, TbScene } from "./tbscene";

export type WireOrigin =
  | { kind: "agent-ap"; nodeId: string; agent: string }
  | {
      kind: "sb-port";
      nodeId: string;
      /** the entry's name as written; `sbd` when unnamed (see `blocked`) */
      sbName: string;
      /** endpoints are set BY NAME (`setScoreboardField` edits the FIRST entry
       *  of that name): an unnamed or duplicate-named entry cannot be
       *  retargeted — the reason, or null when it can */
      blocked: string | null;
      field: "source" | "monitor";
    }
  | {
      kind: "sub-port";
      nodeId: string;
      /** the composed block (`subenvs[].name`) and its port, as `connections` name them */
      subenv: string;
      port: string;
      /** `out` = the block's output (a source, east); `in` = its input (a target, west) */
      dir: "out" | "in";
      /** the port's width from the child config; null when unknown */
      width: number | null;
      /** an input already driven by a connection: by whom (no second driver) */
      drivenBy: string | null;
    };

type Children = Readonly<Record<string, QuvmConfig>> | undefined;

/** the width of a block's port from its child config — the agents' `outputs`
 *  for `out`, `inputs` for `in`; null when the child or the port is unknown */
export function subPortWidth(
  children: Children,
  subenv: string,
  port: string,
  dir: "out" | "in"
): number | null {
  for (const a of children?.[subenv]?.agents ?? []) {
    const list = dir === "out" ? a.ports?.outputs : a.ports?.inputs;
    const p = list?.find((x) => x.name === port);
    if (p) {
      return p.width ?? 1;
    }
  }
  return null;
}

/** the connection already driving `<subenv>.<port>`: its source, or null */
function drivenBy(config: QuvmConfig, subenv: string, port: string): string | null {
  const to = `${subenv}.${port}`;
  return (config.connections ?? []).find((c) => c.to === to && c.from)?.from ?? null;
}

export interface WireChoice {
  label: string;
  action: ActionKind;
  args: Record<string, unknown>;
  /** docs/08 R10 — the drop point becomes the seed of the node this action
   *  creates (by scene kind): the webview pins the next new node of that kind */
  creates?: "tbsb" | "tbcov";
}

/** the config entry drawn as the scoreboard node `nodeId` (local ones only) */
function scoreboardOf(config: QuvmConfig, nodeId: string): QuvmScoreboard | undefined {
  const i = scoreboardNodeIds(config).findIndex((n) => n?.id === nodeId);
  return i < 0 ? undefined : config.analysis?.scoreboards?.[i];
}

function nodeOf(scene: TbScene, id: string): TbNode | undefined {
  return scene.nodes.find((n) => n.id === id);
}

/**
 * What a drag from `portId` (`<nodeId>.<port>`) means, or null when the port
 * starts no gesture (interfaces, sequencer references, coverage inputs,
 * cross-block boxes, ghosts).
 */
export function wireOriginOf(
  scene: TbScene,
  config: QuvmConfig,
  portId: string,
  children?: Children
): WireOrigin | null {
  const dot = portId.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  const nodeId = portId.slice(0, dot);
  const port = portId.slice(dot + 1);
  const node = nodeOf(scene, nodeId);
  if (!node || node.inferred) {
    return null;
  }
  if (node.kind === "tbagent" && port === "ap") {
    return { kind: "agent-ap", nodeId, agent: node.label };
  }
  if (node.kind === "tbsb" && nodeId.startsWith("sb:") && (port === "source" || port === "monitor")) {
    const sb = scoreboardOf(config, nodeId);
    return {
      kind: "sb-port",
      nodeId,
      sbName: sb?.name ?? "sbd",
      blocked: nameBlock(sb, nodeId),
      field: port,
    };
  }
  if (node.kind === "tbsubenv") {
    const tp = node.ports.find((p) => p.id === portId);
    if (!tp) {
      return null;
    }
    const dir = tp.side === "EAST" ? "out" : "in";
    return {
      kind: "sub-port",
      nodeId,
      subenv: node.label,
      port: tp.port,
      dir,
      width: subPortWidth(children, node.label, tp.port, dir),
      drivenBy: dir === "in" ? drivenBy(config, node.label, tp.port) : null,
    };
  }
  return null;
}

/** per block port, for a sub-port origin: null = a legal endpoint, else why not */
function subPortReason(
  config: QuvmConfig,
  children: Children,
  origin: Extract<WireOrigin, { kind: "sub-port" }>,
  subenv: string,
  port: string
): string | null {
  if (origin.dir === "in" && origin.drivenBy) {
    return `${origin.subenv}.${origin.port} is already driven by ${origin.drivenBy} — remove that connection first`;
  }
  if (origin.dir === "out") {
    const d = drivenBy(config, subenv, port);
    if (d) {
      return `already driven by ${d} — one driver per input`;
    }
  }
  const w = subPortWidth(children, subenv, port, origin.dir === "out" ? "in" : "out");
  if (origin.width !== null && w !== null && origin.width !== w) {
    return `width ${origin.width} ≠ ${w} — quick-uvm requires equal widths`;
  }
  return null;
}

function connect(
  origin: Extract<WireOrigin, { kind: "sub-port" }>,
  subenv: string,
  port: string
): WireChoice {
  const mine = `${origin.subenv}.${origin.port}`;
  const theirs = `${subenv}.${port}`;
  const [from, to] = origin.dir === "out" ? [mine, theirs] : [theirs, mine];
  return { label: `Connect ${from} → ${to}`, action: "addConnection", args: { from, to } };
}

const NAME_FIRST = "name the scoreboard first — endpoints are set by name";
const DUP_NAME =
  "another scoreboard has this name — endpoints are set by name, rename it first";

/** why a scoreboard entry cannot be addressed by name: unnamed, or a
 *  duplicate (`sb:x#2` — `setScoreboardField` would edit the FIRST `x`) */
function nameBlock(sb: QuvmScoreboard | undefined, nodeId: string): string | null {
  if (!sb?.name) {
    return NAME_FIRST;
  }
  return nodeId.includes("#") ? DUP_NAME : null;
}

/** per scoreboard port: null = legal for the agent, else why not */
function sbPortReason(
  sb: QuvmScoreboard | undefined,
  nodeId: string,
  field: "source" | "monitor",
  agent: string
): string | null {
  if (!sb) {
    return NAME_FIRST;
  }
  const block = nameBlock(sb, nodeId);
  if (block) {
    return block;
  }
  if (sb[field] === agent) {
    return `already the ${field}`;
  }
  if (field === "monitor" && sb.source === agent) {
    return "the source cannot also be the monitor";
  }
  if (field === "source" && sb.monitor === agent) {
    return "the monitor cannot also be the source";
  }
  return null;
}

/**
 * The legality of every node — and, for an agent origin, of every scoreboard
 * port — as a drop target: null = legal, a string = the reason shown as a hint.
 * Nodes absent from the map are not targets at all (boundary flags, the origin).
 */
export function wireTargets(
  scene: TbScene,
  config: QuvmConfig,
  origin: WireOrigin,
  children?: Children
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const n of scene.nodes) {
    if (n.id === origin.nodeId) {
      continue;
    }
    if (n.inferred) {
      out.set(n.id, "inferred by quick-uvm — declare a scoreboard or coverage first");
      continue;
    }
    if (origin.kind === "sub-port") {
      if (n.kind !== "tbsubenv") {
        out.set(n.id, "not a composed block — a connection joins two subenvs");
        continue;
      }
      // the opposite side of the other block: its inputs for an output origin
      const side = origin.dir === "out" ? "WEST" : "EAST";
      let first: string | null = null;
      let anyLegal = false;
      for (const p of n.ports) {
        if (p.side !== side) {
          continue;
        }
        const r = subPortReason(config, children, origin, n.label, p.port);
        out.set(p.id, r);
        if (r === null) {
          anyLegal = true;
        } else if (first === null) {
          first = r;
        }
      }
      out.set(
        n.id,
        anyLegal ? null : first ?? `no ${origin.dir === "out" ? "input" : "output"} port on this block`
      );
      continue;
    }
    if (origin.kind === "agent-ap") {
      if (n.kind === "tbsb") {
        if (!n.id.startsWith("sb:")) {
          out.set(n.id, "cross-block endpoints are <subenv>.<agent> — edit them in the Properties panel");
          continue;
        }
        const sb = scoreboardOf(config, n.id);
        const rs = sbPortReason(sb, n.id, "source", origin.agent);
        const rm = sbPortReason(sb, n.id, "monitor", origin.agent);
        out.set(`${n.id}.source`, rs);
        out.set(`${n.id}.monitor`, rm);
        out.set(n.id, rs === null || rm === null ? null : (rs ?? rm));
      } else if (n.kind === "tbcov") {
        out.set(n.id, "a coverage collector belongs to one agent — add a new one from the agent");
      } else if (n.kind === "tbagent") {
        out.set(n.id, "an agent cannot feed another agent — connect through a scoreboard");
      } else {
        out.set(n.id, "not a scoreboard");
      }
    } else {
      if (origin.blocked) {
        out.set(n.id, origin.blocked);
        continue;
      }
      if (n.kind !== "tbagent") {
        out.set(n.id, "not an agent");
        continue;
      }
      const sb = scoreboardOf(config, origin.nodeId);
      out.set(n.id, sbPortReason(sb, origin.nodeId, origin.field, n.label));
    }
  }
  return out;
}

function retarget(origin: Extract<WireOrigin, { kind: "sb-port" }>, agent: string): WireChoice {
  return {
    label: `Use ${agent} as ${origin.field} of ${origin.sbName}`,
    action: "editScoreboard",
    args: { name: origin.sbName, field: origin.field, value: agent },
  };
}

function feed(sbName: string, field: "source" | "monitor", agent: string): WireChoice {
  return {
    label: `Set ${agent} as ${field} of ${sbName}`,
    action: "editScoreboard",
    args: { name: sbName, field, value: agent },
  };
}

/**
 * The choices offered when the wire is dropped on `targetId` — a node id, or
 * `<nodeId>.<port>` for a scoreboard port. Empty when the target is illegal
 * (the caller shows the reason from `wireTargets` instead).
 */
export function wireChoices(
  scene: TbScene,
  config: QuvmConfig,
  origin: WireOrigin,
  targetId: string,
  children?: Children
): WireChoice[] {
  const legal = wireTargets(scene, config, origin, children);
  if (!legal.has(targetId) || legal.get(targetId) !== null) {
    return [];
  }
  if (origin.kind === "sub-port") {
    const box = nodeOf(scene, targetId);
    if (box) {
      // dropped on the block: every legal port of it (one applies directly, several ask)
      return box.ports
        .filter((p) => legal.get(p.id) === null)
        .map((p) => connect(origin, box.label, p.port));
    }
    const dot = targetId.lastIndexOf(".");
    const owner = dot >= 0 ? nodeOf(scene, targetId.slice(0, dot)) : undefined;
    return owner ? [connect(origin, owner.label, targetId.slice(dot + 1))] : [];
  }
  if (origin.kind === "agent-ap") {
    const dot = targetId.lastIndexOf(".");
    const nodeId = dot >= 0 && !nodeOf(scene, targetId) ? targetId.slice(0, dot) : targetId;
    const sb = scoreboardOf(config, nodeId);
    const sbName = sb?.name ?? "sbd";
    const port = nodeId === targetId ? null : targetId.slice(dot + 1);
    const fields = (port ? [port] : ["source", "monitor"]).filter(
      (f): f is "source" | "monitor" =>
        (f === "source" || f === "monitor") && legal.get(`${nodeId}.${f}`) === null
    );
    return fields.map((f) => feed(sbName, f, origin.agent));
  }
  const node = nodeOf(scene, targetId);
  return node ? [retarget(origin, node.label)] : [];
}

/**
 * The choices when the wire is dropped on EMPTY canvas: an agent's analysis
 * port creates (scoreboard fed by it, coverage on it — R10); a scoreboard input
 * offers every legal agent (R11's menu form).
 */
export function wireChoicesOnCanvas(
  scene: TbScene,
  config: QuvmConfig,
  origin: WireOrigin,
  children?: Children
): WireChoice[] {
  if (origin.kind === "sub-port") {
    // every legal port of every other block, as a menu (R11's menu form)
    const legal = wireTargets(scene, config, origin, children);
    const out: WireChoice[] = [];
    for (const n of scene.nodes) {
      for (const p of n.ports) {
        if (legal.get(p.id) === null) {
          out.push(connect(origin, n.label, p.port));
        }
      }
    }
    return out;
  }
  if (origin.kind === "agent-ap") {
    const out: WireChoice[] = [
      {
        label: `Scoreboard fed by ${origin.agent}`,
        action: "addScoreboard",
        args: { source: origin.agent },
        creates: "tbsb",
      },
    ];
    // one collector per agent: offered only while the agent has none — the
    // host would otherwise cover ANOTHER agent (the single remaining
    // candidate) under this label (review finding)
    const covered = scene.nodes.some(
      (n) => n.id === `cov:${origin.agent}` && !n.inferred
    );
    if (!covered) {
      out.push({
        label: `Coverage on ${origin.agent}`,
        action: "addCoverage",
        args: { agent: origin.agent },
        creates: "tbcov",
      });
    }
    return out;
  }
  const legal = wireTargets(scene, config, origin);
  return scene.nodes
    .filter((n) => n.kind === "tbagent" && legal.get(n.id) === null)
    .map((n) => retarget(origin, n.label));
}

// ------------------------------------------------------------- the RTL side

export interface RtlWireOrigin {
  port: string;
  /** the module instance whose pins these are: the view (symbol) or a child block */
  owner: string;
  iface: boolean;
}

/**
 * The RTL half of R10 — a wire from a DUT pin. `selected` = the usable ports
 * selected alongside (same module, no interface/clock/reset); when the origin
 * is one of them the gesture acts on the whole selection, with the single pin
 * as the second choice. `targetAgent` = the agent claiming the drop pin, or
 * null for the canvas. The args mirror the inspector's buttons (`viewId` =
 * the owner, `pins` as `<port>.<name>`), so the host paths do not change.
 */
export function rtlWireChoices(
  origin: RtlWireOrigin,
  selected: readonly string[],
  targetAgent: string | null
): WireChoice[] {
  const viewId = origin.owner;
  if (origin.iface) {
    // an interface port unfolds into an agent of its own (createAgentFromIface);
    // it cannot join a pin agent
    return targetAgent
      ? []
      : [
          {
            label: `Agent from interface ${origin.port}`,
            action: "createAgentFromIface",
            args: { port: origin.port, viewId },
          },
        ];
  }
  const group =
    selected.includes(origin.port) && selected.length > 1 ? [...selected] : [origin.port];
  const pinsOf = (ports: readonly string[]): string[] => ports.map((p) => `<port>.${p}`);
  const out: WireChoice[] = [];
  if (targetAgent) {
    if (group.length > 1) {
      out.push({
        label: `Add the ${group.length} selected pins to agent ${targetAgent}`,
        action: "addPinsToAgent",
        args: { agent: targetAgent, pins: pinsOf(group), viewId },
      });
    }
    out.push({
      label: `Add ${origin.port} to agent ${targetAgent}`,
      action: "addPinsToAgent",
      args: { agent: targetAgent, pins: pinsOf([origin.port]), viewId },
    });
    return out;
  }
  if (group.length > 1) {
    out.push({
      label: `Agent from the ${group.length} selected pins`,
      action: "createAgentFromPins",
      args: { pins: pinsOf(group), viewId },
    });
  }
  out.push({
    label: `Agent from pin ${origin.port}`,
    action: "createAgentFromPins",
    args: { pins: pinsOf([origin.port]), viewId },
  });
  return out;
}
