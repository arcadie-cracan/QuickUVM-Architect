// The configuration overlay of the design views (docs/05): which agent claims
// which DUT pin, which pins carry a role (clock / reset / ignored), and how much
// of the DUT's boundary is mapped. Pure — no vscode, no file access — so the
// host (`ConfigService`) and the figure-capture script (`scripts/capture-shots
// .mjs`) build the SAME overlay from a configuration and a module definition.
//
// Tested in `npm run test:overlay`.

import type { ModuleDef } from "./model";
import { AGENT_PALETTE, type OverlayConfig, type PortRole } from "./protocol";
import { agentPorts, type QuvmConfig } from "./quickuvm";

/**
 * @param def        the DUT module's definition (for the coverage figure);
 *                   undefined when the model does not have it
 * @param configPath the configuration's path as the inspector shows it
 * @param orphans    agent ports that no longer exist in the model (docs/03)
 */
export function overlayOf(
  cfg: QuvmConfig,
  def: ModuleDef | undefined,
  configPath: string | null,
  orphans: string[] = []
): OverlayConfig {
  const agents = (cfg.agents ?? [])
    .filter((a): a is typeof a & { name: string } => Boolean(a.name))
    .map((a, i) => ({
      name: a.name,
      color: i % AGENT_PALETTE,
      pins: [...agentPorts(a).keys()],
    }));

  const roles: Record<string, PortRole> = {};
  for (const p of cfg.dut?.unverified_ports ?? []) {
    roles[p] = "ignored";
  }
  if (cfg.dut?.clock) {
    roles[cfg.dut.clock] = "clock";
  }
  if (cfg.dut?.reset) {
    roles[cfg.dut.reset] = "reset";
  }

  const claimed = new Set(agents.flatMap((a) => a.pins));
  const unmapped = (def?.ports ?? [])
    .map((p) => p.name)
    .filter((n) => !claimed.has(n) && !roles[n]);
  const total = def?.ports.length ?? 0;

  return {
    dut: cfg.dut?.name ?? null,
    configPath,
    agents,
    roles,
    coverage: { total, mapped: total - unmapped.length, unmapped },
    orphans,
  };
}
