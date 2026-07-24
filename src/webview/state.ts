// The webview's view-model, shared by the diagram (main.ts) and the inspector
// (inspector-view.ts) so both can be rendered from the same messages.

import type { ProjectModel } from "../model";
import type { OverlayConfig, ViewMode } from "../protocol";
import type { QuvmConfig } from "../quickuvm";

export interface State {
  model: ProjectModel | undefined;
  viewId: string | undefined;
  /** the display mode of the current view (docs/05) */
  mode: ViewMode;
  selection: Set<string>;
  /** the state derived from the QuickUVM YAML; null = no configuration */
  overlay: OverlayConfig | null;
  /** the parsed configuration + its path, for the verification (TB) view (docs/05) */
  config: QuvmConfig | null;
  configPath: string | null;
  /** docs/07 P3c — agents of each composed child, by subenv name (cross-block
   *  scoreboard endpoints are `<subenv>.<agent>`, declared in another file) */
  childAgents: Record<string, string[]>;
  /** the current level of the verification (TB) view (D24): "", "env", "agent:X" */
  tbFocus: string;
  // the pan/zoom transform of the view
  tx: number;
  ty: number;
  k: number;
}
