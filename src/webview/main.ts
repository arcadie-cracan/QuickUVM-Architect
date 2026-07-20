// Codul webview-ului: cele doua vederi RTL (docs/05) — contextul unui modul
// (dreptunghi cu pinii pe laturi, ELK cu porturi FIXED_ORDER) si schema
// (instante + interconect, scena din scene.ts, layout/desen din schematic.ts).
// SVG generat manual (docs/04), pan/zoom si selectie simpla. Fara framework
// (docs/01, decizia D5).

import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import type { Instance, ModuleDef, ProjectModel } from "../model";
import type {
  ActionKind,
  HostMessage,
  OverlayConfig,
  ViewMode,
  WebviewMessage,
} from "../protocol";
import type { GenerateStatus, SidecarData, SidecarNode, StatusDeco, UiConfig, XprobeTarget } from "../protocol";
import { probeIds, ProbeViewCtx, remapSelection } from "../locmap";
import { ElementStatus, statusIdsRtl, statusIdsTb } from "../status";
import type { QuvmConfig, QuvmScoreboard } from "../quickuvm";
import { alignSnap, AlignPt, AlignSnap, centerChipSigns, drawSchematic, Flip, layoutSchematic, pinTipOffsets, portLabelText, routeEdges } from "./schematic";
import { cameraForMinimapPoint, minimapLayout, minimapUseTransform, minimapViewRect, MmLayout } from "./minimap";
import { buildSchematicScene, coneOf, hasSchematic, portLabel, SchematicScene } from "./scene";
import type { TbScene } from "./tbscene";
import { buildTbScene } from "./tbscene";
import { drawTb, drawTbEdges, layoutTb, TbLayout } from "./tbschematic";
import { el, measurer, SVG_NS } from "./svg";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): { viewId?: string; mode?: ViewMode } | undefined;
  setState(state: { viewId?: string; mode?: ViewMode }): void;
};

const vscode = acquireVsCodeApi();
const elk = new ELK();

const STUB = 14; // lungimea liniei de pin, in px, in afara dreptunghiului

// ----------------------------------------------------------------- stare

interface State {
  model: ProjectModel | undefined;
  viewId: string | undefined;
  /** modul de afisare al vederii curente (docs/05) */
  mode: ViewMode;
  selection: Set<string>;
  /** starea derivata din YAML-ul QuickUVM; null = fara configuratie */
  overlay: OverlayConfig | null;
  /** configuratia parsata + calea ei, pentru vederea de verificare (docs/05) */
  config: QuvmConfig | null;
  configPath: string | null;
  /** nivelul curent al vederii de verificare (D24): "", "env", "agent:X" */
  tbFocus: string;
  // transformarea de pan/zoom a vederii
  tx: number;
  ty: number;
  k: number;
}

const state: State = {
  model: undefined,
  viewId: vscode.getState()?.viewId,
  mode: vscode.getState()?.mode ?? "symbol",
  selection: new Set(),
  overlay: null,
  config: null,
  configPath: null,
  tbFocus: "",
  tx: 0,
  ty: 0,
  k: 1,
};

/** pinii vederii-simbol curente (goi in schema — dezactiveaza actiunile) */
let currentPins: PinSpec[] = [];

/** scena vederii-schema curente, pentru inspector */
let currentScene: SchematicScene | null = null;

/** scena+layoutul vederii de verificare (ierarhica), pentru inspector */
let currentTbScene: TbScene | null = null;
let currentTbLayout: TbLayout | null = null;
/** grupul muchiilor TB, re-rutat live la drag (ca `currentEdgesGroup` la RTL) */
let currentTbEdgesGroup: SVGGElement | null = null;

/** layoutul ELK curent (pozitiile nodurilor; mutate in timpul drag-ului) */
let currentLayout: ElkNode | null = null;

/** grupul SVG al muchiilor, re-rutat live in timpul drag-ului */
let currentEdgesGroup: SVGGElement | null = null;

/** copia locala a sidecar-ului de layout (docs/04); gesturile proprii o tin
 *  la zi — host-ul nu trimite ecou la propriile mutatii (docs/05) */
let sidecar: SidecarData = { schema_version: 1, views: {}, orphans: [] };

function sidecarNode(viewId: string, nodeId: string): SidecarNode {
  const view = (sidecar.views[viewId] ??= {});
  const nodes = (view.nodes ??= {});
  return (nodes[nodeId] ??= {});
}

/**
 * Cheia de sidecar/camera a vederii curente. Vederile RTL folosesc `viewId`;
 * vederea de verificare are un `focus` (nivel: ""/env/agent:X) sub aceeasi
 * cheie `tb:<config>`, iar id-urile nodurilor se repeta intre nivelurile de
 * agent (`u.sequencer` la agent:cmd si agent:rsp) — deci pozitiile se cheiaza
 * per nivel: `tb:<config>|<focus>`. Cheia ramane prefixata cu `tb:`, deci
 * invalidarea sidecar-ului fata de modelul RTL n-o atinge (docs/04).
 */
function layoutKey(): string | undefined {
  if (!state.viewId) {
    return undefined;
  }
  return state.mode === "tb" ? `${state.viewId}|${state.tbFocus}` : state.viewId;
}

/** dreptunghiul care cuprinde cutiile+steagurile TB (dupa drag-uri/seminte) */
function tbBounds(layout: TbLayout): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number, w: number, h: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const p of layout.nodes.values()) {
    acc(p.x, p.y, p.w, p.h);
  }
  for (const p of layout.boundary.values()) {
    acc(p.x, p.y, p.w, 16); // BPORT_H
  }
  if (minX === Infinity) {
    return { x: 0, y: 0, w: layout.width, h: layout.height };
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** pliajele expandate explicit, per vedere; initializate din sidecar la
 *  layout/full, persistate prin fold/toggled */
const expandedFolds = new Map<string, Set<string>>();

function expandedFor(viewId: string): Set<string> {
  let s = expandedFolds.get(viewId);
  if (!s) {
    s = new Set();
    expandedFolds.set(viewId, s);
  }
  return s;
}

/** ultima vedere de design vizitata (viewId + mod) — tinta butonului
 *  „Design" din header-ul vederii de verificare (docs/05) */
let lastRtl: { viewId: string; mode: "symbol" | "schematic" } | null = null;

/** configuratia curenta are ceva desenabil in vederea de verificare? */
function tbAvailable(): boolean {
  const c = state.config;
  return Boolean(
    c && (c.dut?.name || c.agents?.length || c.subenvs?.length)
  );
}

/** comutarea locala pe vederea de verificare (docs/05): cheia vine din
 *  calea config-ului; host-ul afla prin nav/drill (titlu + vedere curenta) */
function openTbView(): void {
  if (state.mode === "tb" || !tbAvailable()) {
    return;
  }
  if (state.viewId && !state.viewId.startsWith("tb:")) {
    lastRtl = {
      viewId: state.viewId,
      mode: state.mode === "schematic" ? "schematic" : "symbol",
    };
  }
  state.viewId = `tb:${state.configPath ?? ""}`;
  state.mode = "tb";
  state.selection.clear();
  postSelection();
  persistState();
  post({ v: 1, type: "nav/drill", instancePath: state.viewId, mode: state.mode });
  void render(true);
}

/** intoarcerea din vederea de verificare la ultima vedere de design (RTL) —
 *  revine la vederea si modul de dinainte de intrarea in TB (D24: nu mai exista
 *  comutator, deci un singur buton „Design", nu Symbol/Schematic) */
function leaveTbView(): void {
  const target = lastRtl?.viewId ?? state.model?.tops[0];
  if (!target) {
    return;
  }
  state.viewId = target;
  state.mode =
    lastRtl?.mode === "schematic" && hasSchematic(state.model, target)
      ? "schematic"
      : "symbol";
  state.selection.clear();
  postSelection();
  persistState();
  post({ v: 1, type: "nav/drill", instancePath: target, mode: state.mode });
  void render(true);
}

/** preferintele UI din setarile extensiei (mesajul ui/config, docs/05) */
let uiConfig: UiConfig = { lasso: "contain", decorations: true };

/** camerele per vedere — stare de SESIUNE, nu de proiect (docs/04): prima
 *  deschidere a unei vederi se incadreaza mereu in fereastra; cadrul se
 *  pastreaza doar la comutarea intre vederi in aceeasi sesiune */
const sessionCameras = new Map<
  string,
  { cx: number; cy: number; zoom: number }
>();

/** generatia randarii: o randare inceputa mai tarziu o anuleaza pe cea veche */
let renderGen = 0;

function persistState(): void {
  vscode.setState({ viewId: state.viewId, mode: state.mode });
}

const canvas = document.getElementById("canvas") as unknown as SVGSVGElement;
const banner = document.getElementById("banner") as HTMLDivElement;
const head = document.getElementById("head") as HTMLElement;
const empty = document.getElementById("empty") as HTMLDivElement;
let viewport: SVGGElement | undefined;

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

// ---------------------------------------------------------------- mesaje

window.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as HostMessage;
  switch (m.type) {
    case "model/full":
      state.model = m.model;
      hideBanner();
      // vederea de verificare (tb:...) nu e o instanta RTL: recompilarea nu
      // o re-cheia pe tops[0] (re-cheierea ar citi/polua sidecar-ul vederii
      // RTL cu nodurile TB — regresie prinsa de review-ul advers)
      if (
        !state.viewId ||
        (!state.viewId.startsWith("tb:") && !findInstance(state.viewId))
      ) {
        // recheiere pe top: la prima deschidere (viewId nedefinit) host-ul
        // trimite oricum un view/show explicit imediat dupa model/full, deci
        // un nav/drill de aici ar concura cu el si ar lasa host-ul pe top;
        // la recompilare (vederea curenta a disparut) NU vine view/show, deci
        // aici resincronizam ierarhia noi (docs/05)
        const wasStaleView = Boolean(state.viewId);
        state.viewId = m.model.tops[0];
        if (state.mode === "tb") {
          state.mode = "symbol";
        }
        if (wasStaleView) {
          post({
            v: 1,
            type: "nav/drill",
            instancePath: state.viewId,
            mode: state.mode,
          });
        }
      }
      void render();
      break;
    case "model/stale":
      showBanner(
        `View out of date (${m.errors} ${m.errors === 1 ? "error" : "errors"}) — ` +
          "showing the last valid model."
      );
      break;
    case "view/show":
      state.viewId = m.viewId;
      if (m.mode) {
        state.mode = m.mode;
      } else if (m.viewId.startsWith("tb:")) {
        state.mode = "tb";
      } else if (state.mode === "tb") {
        // vedere RTL ceruta fara mod (click in ierarhie) cand era deschisa
        // vederea de verificare: modul tb nu se mosteneste
        state.mode = "symbol";
      }
      state.selection.clear();
      postSelection();
      persistState();
      void render(true);
      break;
    case "select/reveal":
      state.selection = new Set(m.ids);
      applySelectionClasses();
      renderInspector();
      // ecou spre host: fara el, panel.selection ramanea goala dupa un reveal
      // si comenzile din paleta care o citesc actionau pe nimic (recenzia
      // adversariala a sincronizarii); remaparea pe pliaje o face presentScene
      postSelection();
      break;
    case "probe/highlight":
      // cross-probing editor->diagrama: halou persistent, NU selectie —
      // selectia de lucru a utilizatorului ramane neatinsa (docs/05)
      probeTargets = m.targets;
      applySelectionClasses();
      break;
    case "status/decorations":
      // decoratiile de stare quick-uvm (docs/05): badge-uri + cip generate
      statusDecos = m.decos;
      genStatus = m.generate;
      applyStatusBadges();
      updateGenChip();
      break;
    case "overlay/config": {
      const { v: _v, type: _t, ...overlay } = m;
      state.overlay = overlay;
      void render();
      break;
    }
    case "tb/navigate":
      state.tbFocus = m.focus;
      state.selection = new Set(m.select ? [m.select] : []);
      if (state.mode === "tb") {
        void render(true);
      }
      break;
    case "config/full":
      state.config = m.config;
      state.configPath = m.configPath;
      if (state.mode === "tb") {
        // alt config activ => alta cheie de vedere: pozitiile nu se scriu
        // sub cheia vechiului config
        const key = `tb:${m.configPath ?? ""}`;
        if (state.viewId !== key) {
          state.viewId = key;
          state.selection.clear();
          postSelection();
          persistState();
        }
        void render();
      }
      break;
    case "export/request":
      exportSvg(); // comanda din paleta; butonul ⤓ face acelasi lucru local
      break;
    case "theme/changed":
      void render(); // re-masurare text cu fontul temei curente
      break;
    case "ui/config": {
      const { v: _v2, type: _t2, ...ui } = m;
      uiConfig = ui;
      // vocabularul de desen se ascunde prin clasa pe canvas (CSS), fara
      // re-randare — slash+latime, junction dots (docs/04)
      canvas.classList.toggle("decor-off", uiConfig.decorations === false);
      break;
    }
    case "layout/full":
      // sursa de adevar pentru pozitii/pliaje/rasturnari: starea locala se
      // reconstruieste integral (editare externa, invalidare, curatare)
      sidecar = m.sidecar;
      expandedFolds.clear();
      for (const [viewId, view] of Object.entries(sidecar.views)) {
        for (const [nodeId, n] of Object.entries(view.nodes ?? {})) {
          if (n.collapsed === false) {
            expandedFor(viewId).add(nodeId);
          }
        }
      }
      void render(true);
      break;
    default:
      break; // mesaje ale fazelor urmatoare
  }
});

// ------------------------------------------------------------ construire

interface PinSpec {
  id: string; // ID stabil relativ la vedere: `<port>.din` (docs/02)
  name: string;
  label: string;
  side: "WEST" | "EAST";
  iface: boolean;
  bus: boolean;
  mult: string | null;
  /** sectiunea pinului in vederea-simbol (grupare pe rol, docs/04) */
  section: "clock/reset" | "signals";
  tooltip: string;
  labelW: number;
}

function findInstance(path: string): Instance | undefined {
  return state.model?.instances.find((i) => i.path === path);
}

function isClockOrReset(name: string, dir: string, width: number | null): boolean {
  // doar euristica de asezare (grupare stanga-jos); rolurile reale se
  // stabilesc la configurare, in fazele urmatoare (docs/02, docs/03)
  return dir === "in" && width === 1 && /clk|clock|rst|reset/i.test(name);
}

function buildPins(def: ModuleDef): PinSpec[] {
  const measure = measurer();
  const west: PinSpec[] = [];
  const east: PinSpec[] = [];
  const clkRst: PinSpec[] = [];

  for (const p of def.ports) {
    const elemW = p.elem_width ?? p.width;
    const bus = elemW !== null && elemW > 1;
    const label = portLabel(p);
    const widthInfo =
      p.width === null
        ? "no fixed size"
        : `${p.width} ${p.width === 1 ? "bit" : "bits"}`;
    const cr = isClockOrReset(p.name, p.dir, p.width);
    const spec: PinSpec = {
      id: `<port>.${p.name}`,
      name: p.name,
      label,
      side: p.dir === "in" ? "WEST" : "EAST",
      iface: false,
      bus,
      mult: p.unpacked_dims ? `×${p.unpacked_dims.join("×")}` : null,
      section: cr ? "clock/reset" : "signals",
      tooltip:
        `${p.name}: ${p.dir} ${p.type} (${widthInfo})` +
        (p.loc ? `\n${p.loc.file}:${p.loc.line}` : ""),
      labelW: measure(label, true),
    };
    if (cr) {
      clkRst.push(spec);
    } else if (p.dir === "in") {
      west.push(spec);
    } else {
      east.push(spec); // out, inout, ref — pe dreapta
    }
  }

  for (const ip of def.iface_ports) {
    const label = `${ip.name} : ${ip.interface}${ip.modport ? "." + ip.modport : ""}`;
    west.push({
      id: `<port>.${ip.name}`,
      name: ip.name,
      label,
      side: "WEST",
      iface: true,
      bus: false,
      mult: null,
      section: "signals",
      tooltip:
        `${ip.name}: interface ${ip.interface}` +
        (ip.modport ? `, modport ${ip.modport}` : "") +
        (ip.loc ? `\n${ip.loc.file}:${ip.loc.line}` : ""),
      labelW: measure(label, true),
    });
  }

  // intrari de date, apoi interfete, apoi ceas/reset — stanga-jos (docs/05)
  return [...west, ...clkRst, ...east];
}

async function layoutSymbol(
  moduleName: string,
  pins: PinSpec[]
): Promise<ElkNode> {
  const measure = measurer();
  const westPins = pins.filter((p) => p.side === "WEST");
  const eastPins = pins.filter((p) => p.side === "EAST");
  // FIXED_ORDER numara in sens orar: EAST sus->jos, WEST jos->sus
  const index = new Map<string, number>();
  eastPins.forEach((p, i) => index.set(p.id, i));
  [...westPins].reverse().forEach((p, i) => index.set(p.id, eastPins.length + i));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: { "elk.algorithm": "layered" },
    children: [
      {
        id: "ctx",
        layoutOptions: {
          "elk.portConstraints": "FIXED_ORDER",
          "elk.nodeSize.constraints": "PORTS PORT_LABELS NODE_LABELS MINIMUM_SIZE",
          "elk.nodeSize.minimum": "(200, 100)",
          "elk.portLabels.placement": "INSIDE",
          "elk.spacing.portPort": "12",
          "elk.spacing.portsSurrounding": "[top=32,left=0,bottom=16,right=0]",
          "elk.nodeLabels.placement": "H_CENTER V_TOP INSIDE",
        },
        labels: [
          { text: moduleName, width: measure(moduleName) + 24, height: 26 },
        ],
        ports: pins.map((p) => ({
          id: p.id,
          width: 8,
          height: 8,
          layoutOptions: {
            "elk.port.side": p.side,
            "elk.port.index": String(index.get(p.id) ?? 0),
          },
          labels: [{ text: p.label, width: p.labelW + 16, height: 16 }],
        })),
      },
    ],
  };
  return elk.layout(graph);
}

// ---------------------------------------------------------------- desen

/**
 * Antetul vederii: breadcrumb clicabil pe segmentele-instanta ale caii
 * (urcarea din docs/05), modulul cu parametrii efectivi si comutatorul
 * Symbol/Schematic (doar cand instanta are schema).
 */
function renderHeader(inst: Instance): void {
  head.replaceChildren();
  const crumbs = h("span", "crumbs");
  const segs = inst.path.split(".");
  let prefix = "";
  segs.forEach((s, i) => {
    prefix = i ? `${prefix}.${s}` : s;
    if (i) {
      crumbs.append(h("span", "sep", "."));
    }
    const target = prefix;
    if (target !== inst.path && findInstance(target)) {
      const a = h("span", "seg link", s);
      a.title = target;
      a.addEventListener("click", () =>
        navigateTo(
          target,
          hasSchematic(state.model, target) ? "schematic" : "symbol"
        )
      );
      crumbs.append(a);
    } else {
      // segment generate (g_ch[1]) sau instanta curenta: text simplu
      crumbs.append(h("span", "seg", s));
    }
  });
  head.append(crumbs, h("span", "module", ` — ${inst.module}`));
  const params = Object.entries(inst.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  if (params) {
    head.append(h("span", "params", `  #(${params})`));
  }
  // fara comutator Symbol/Schematic (D24): vederea e derivata din nodul
  // selectat in ierarhie — radacina „top module" -> simbolul top-ului, restul
  // modulelor -> schema interna (frunzele cad gratios pe simbol)
  const tgl = h("span", "mode-toggle");
  if (tbAvailable()) {
    // a treia vedere (docs/05): diagrama mediului de verificare al
    // config-ului activ — punct de intrare vizibil, nu doar comanda
    const tb = h("button", "mbtn", "Testbench");
    tb.title = "Open the verification view of the active QuickUVM config";
    tb.addEventListener("click", openTbView);
    tgl.append(tb);
  }
  const fitBtn = h("button", "mbtn", "⛶");
  fitBtn.title = "Fit to window (F)";
  fitBtn.addEventListener("click", fitView);
  tgl.append(fitBtn);
  if (state.mode === "schematic") {
    const rl = h("button", "mbtn", "⟲");
    rl.title = "Re-arrange all (discards node positions)";
    rl.addEventListener("click", relayoutAll);
    tgl.append(rl);
  }
  const ex = h("button", "mbtn", "⤓");
  ex.title = "Export view as SVG";
  ex.addEventListener("click", exportSvg);
  tgl.append(ex);
  head.append(tgl);
  updateGenChip(); // cipul de stare generate (docs/05)
}

/** "Re-aranjeaza tot" (docs/04): singura cale de re-layout total — sterge
 *  pozitiile vederii (pliaje/rasturnari raman) si revine la ELK complet */
function relayoutAll(): void {
  const key = layoutKey();
  if (!key || state.mode === "symbol") {
    return; // simbolul nu are pozitii detinute de utilizator
  }
  pushPosUndo(capturePositions()); // ⟲ accidental se anuleaza cu Ctrl+Z
  const nodes = sidecar.views[key]?.nodes ?? {};
  for (const n of Object.values(nodes)) {
    delete n.x;
    delete n.y;
  }
  sessionCameras.delete(key); // incadrare proaspata pe noul layout
  post({ v: 1, type: "relayout/request", viewId: key, scope: "all" });
  void render(true);
}

// -------------------------------------------------------------- navigare

function navigateTo(path: string, mode?: ViewMode): void {
  state.viewId = path;
  if (mode) {
    state.mode = mode;
  }
  state.selection.clear();
  postSelection();
  persistState();
  // host-ul actualizeaza titlul, vederea curenta si ierarhia (docs/05); modul
  // distinge simbolul top-ului (radacina) de schema (nodul instantei)
  post({ v: 1, type: "nav/drill", instancePath: path, mode: state.mode });
  void render(true);
}

function toggleFold(foldId: string): void {
  const viewId = state.viewId ?? "";
  const s = expandedFor(viewId);
  const collapsed = s.delete(foldId); // era expandat -> se pliaza la loc
  if (!collapsed) {
    s.add(foldId);
  }
  // oglinda locala + persistenta in sidecar (docs/04)
  const n = sidecarNode(viewId, foldId);
  if (collapsed) {
    delete n.collapsed;
  } else {
    n.collapsed = false;
  }
  post({ v: 1, type: "fold/toggled", viewId, foldId, collapsed });
  void render();
}

/** rasturnarea unui bloc (docs/04): H = laturile vest<->est, V = ordinea
 *  pinilor pe fiecare latura; persistata in sidecar prin node/flipped */
/** nivelul 4 (docs/04): comuta un net intre fir si eticheta; alegerea
 *  egala cu sugestia din model sterge override-ul (host-ul face la fel) */
/** netul de care aparține un pin/steag selectat (din muchii sau eticheta),
 *  ca secțiunea Net a inspectorului să fie descoperibilă de pe orice capăt */
function netOfPin(id: string): string | null {
  if (!currentScene) {
    return null;
  }
  for (const e of currentScene.edges) {
    if (!e.net) {
      continue;
    }
    // pin de copil (sourcePort/targetPort) sau steag de granita (source/target nod)
    if (e.sourcePort === id || e.targetPort === id || e.source === id || e.target === id) {
      return e.net;
    }
  }
  // net etichetat (fara muchie): din bport.nets / pin.nets sau numele portului
  if (id.startsWith("<port>.")) {
    const b = currentScene.boundary.find((bb) => bb.id === id);
    return b?.nets[0] ?? id.slice("<port>.".length);
  }
  for (const n of currentScene.nodes) {
    const p = n.pins.find((pp) => pp.id === id);
    if (p?.nets.length) {
      return p.nets[0];
    }
  }
  return null;
}

function toggleNetRender(net: string): void {
  const viewId = state.viewId;
  if (!viewId || !state.model) {
    return;
  }
  const suggestion =
    state.model.views[viewId]?.nets.find((n) => n.name === net)?.render ??
    "wire";
  const view = (sidecar.views[viewId] ??= {});
  const current = view.nets?.[net]?.render ?? suggestion;
  const next = current === "wire" ? "label" : "wire";
  if (next === suggestion) {
    if (view.nets) {
      delete view.nets[net];
    }
  } else {
    (view.nets ??= {})[net] = { render: next };
  }
  post({ v: 1, type: "net/render", viewId, net, render: next });
  void render();
}

function toggleFlip(nodeId: string, axis: "h" | "v"): void {
  const key = layoutKey(); // viewId la RTL, tb:<config>|<focus> la TB
  if (!key || state.mode === "symbol") {
    return;
  }
  const n = sidecarNode(key, nodeId);
  if (axis === "h") {
    if (n.flipH) {
      delete n.flipH;
    } else {
      n.flipH = true;
    }
  } else if (n.flipV) {
    delete n.flipV;
  } else {
    n.flipV = true;
  }
  post({
    v: 1,
    type: "node/flipped",
    viewId: key,
    nodeId,
    flipH: Boolean(n.flipH),
    flipV: Boolean(n.flipV),
  });
  void render();
}

/** decorul unui pin, derivat din overlay (agent, rol, ignorat) */
interface PinDeco {
  color: number | undefined;
  role: string | undefined;
}

/** marcaj de forma per agent: culoarea e dublata de forma (accesibilitate) */
function agentMarker(color: number, x: number, y: number): SVGElement {
  const hollow = color >= 4;
  const attrs: Record<string, string> = {
    class: "marker",
    ...(hollow ? { fill: "none", "stroke-width": "1.6" } : { stroke: "none" }),
  };
  switch (color % 4) {
    case 0:
      return el("circle", { ...attrs, cx: String(x), cy: String(y), r: "3.6" });
    case 1:
      return el("rect", {
        ...attrs,
        x: String(x - 3.2), y: String(y - 3.2), width: "6.4", height: "6.4",
      });
    case 2: // romb
      return el("path", {
        ...attrs,
        d: `M ${x} ${y - 4.2} L ${x + 4.2} ${y} L ${x} ${y + 4.2} L ${x - 4.2} ${y} Z`,
      });
    default: // triunghi
      return el("path", {
        ...attrs,
        d: `M ${x} ${y - 4} L ${x + 4} ${y + 3.4} L ${x - 4} ${y + 3.4} Z`,
      });
  }
}

function drawPin(
  spec: PinSpec,
  nodeW: number,
  py: number,
  deco?: PinDeco
): SVGGElement {
  const west = spec.side === "WEST";
  const x0 = west ? 0 : nodeW; // marginea dreptunghiului
  const xOut = west ? -STUB : nodeW + STUB; // capatul liber al pinului
  const mx = (x0 + xOut) / 2;

  const g = el("g", { class: `pin${spec.iface ? " iface" : ""}` });
  g.dataset.id = spec.id;
  g.dataset.port = spec.name;
  if (deco?.role) {
    g.classList.add(`role-${deco.role}`);
  }
  if (deco?.color !== undefined) {
    g.classList.add(`agent-c${deco.color}`);
  }

  if (spec.iface) {
    // pin gros: culoare + hasura (accesibilitate, docs/05)
    g.append(
      el("line", {
        class: "stub",
        x1: String(xOut), y1: String(py), x2: String(x0), y2: String(py),
      }),
      el("rect", {
        class: "hatch",
        x: String(Math.min(x0, xOut)), y: String(py - 3),
        width: String(STUB), height: "6",
      })
    );
  } else {
    g.append(
      el("line", {
        class: "stub",
        x1: String(xOut), y1: String(py), x2: String(x0), y2: String(py),
      })
    );
    if (spec.bus) {
      // linia taiata a magistralei, pe mijlocul pinului
      g.append(
        el("line", {
          class: "bus-slash",
          x1: String(mx - 3), y1: String(py + 4),
          x2: String(mx + 3), y2: String(py - 4),
        })
      );
    }
  }
  if (spec.mult) {
    // multiplicitatea tabloului unpacked; ancorata pe latura (nu centrata),
    // ca sa nu taie frontiera simbolului pe stub-ul scurt (ca in schema)
    g.append(
      el(
        "text",
        {
          class: "mult",
          x: String(mx),
          y: String(py - 6),
          "text-anchor": west ? "end" : "start",
        },
        spec.mult
      )
    );
  }
  if (deco?.color !== undefined) {
    // marcajul de agent, dincolo de capatul liber al pinului
    g.append(agentMarker(deco.color, west ? xOut - 7 : xOut + 7, py));
  }
  const roleNote =
    deco?.role === "clock"
      ? "\nrole: clock (excluded from agents)"
      : deco?.role === "reset"
        ? "\nrole: reset (excluded from agents)"
        : deco?.role === "ignored"
          ? "\ndeliberately unverified (dut.unverified_ports)"
          : "";
  g.append(
    portLabelText(
      {
        class: "pin-label",
        x: String(west ? 8 : nodeW - 8),
        y: String(py + 4),
        "text-anchor": west ? "start" : "end",
      },
      spec.label,
      spec.name
    ),
    el("title", {}, spec.tooltip + roleNote)
  );
  return g;
}

/**
 * Goleste canvas-ul si il repopuleaza cu defs-urile comune (hasura pentru
 * interfete, sageata pentru muchii) si cu grupul viewport de pan/zoom.
 */
function resetCanvas(): SVGGElement {
  canvas.replaceChildren();
  const defs = el("defs", {});
  const hatch = el("pattern", {
    id: "hatch",
    width: "5",
    height: "5",
    patternTransform: "rotate(45)",
    patternUnits: "userSpaceOnUse",
  });
  hatch.append(el("line", { x1: "0", y1: "0", x2: "0", y2: "5" }));
  const arrow = el("marker", {
    id: "arrow",
    viewBox: "0 0 8 8",
    refX: "7",
    refY: "4",
    markerWidth: "8",
    markerHeight: "8",
    // dimensiune FIXA (nu scalata cu grosimea firului): altfel firul de
    // interfata gros face o sageata uriasa, iar la hover (fir mai subtire)
    // sageata se micsoreaza
    markerUnits: "userSpaceOnUse",
    orient: "auto-start-reverse",
  });
  arrow.append(el("path", { d: "M 0 0 L 8 4 L 0 8 z" }));
  defs.append(hatch, arrow);
  canvas.append(defs);
  viewport = el("g", { id: "viewport" });
  canvas.append(viewport);
  return viewport;
}

/** inaltimea gap-ului dintre sectiunile de pini in vederea-simbol (docs/04) */
const SECTION_GAP = 18;

function draw(inst: Instance, pins: PinSpec[], layout: ElkNode): void {
  const ctx = layout.children?.[0];
  if (!ctx) {
    return;
  }
  const nodeW = ctx.width ?? 200;
  let nodeH = ctx.height ?? 100;
  const byId = new Map(pins.map((p) => [p.id, p]));

  // sectiuni de pini pe rol (docs/04): clock/reset sunt deja grupate jos-stanga
  // (buildPins). Facem gruparea VIZIBILA — gap + divizor + titluri — deplasand
  // grupul clock/reset in jos (ELK FIXED_ORDER nu lasa gol per-grup) si
  // marind cutia. Doar in vederea-simbol si doar cand exista ambele sectiuni
  const westPorts = (ctx.ports ?? [])
    .filter((p) => byId.get(p.id)?.side === "WEST")
    .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
  let dividerY = -1;
  for (let i = 1; i < westPorts.length; i++) {
    const prev = byId.get(westPorts[i - 1].id)?.section;
    const cur = byId.get(westPorts[i].id)?.section;
    if (prev === "signals" && cur === "clock/reset") {
      dividerY = (westPorts[i - 1].y ?? 0) + 4 + SECTION_GAP / 2;
      for (let j = i; j < westPorts.length; j++) {
        westPorts[j].y = (westPorts[j].y ?? 0) + SECTION_GAP;
      }
      nodeH += SECTION_GAP;
      break;
    }
  }

  const vp = resetCanvas();
  const node = el("g", { class: "node" });
  node.dataset.id = inst.path;
  node.append(
    el("rect", {
      class: "module-box",
      x: "0", y: "0", rx: "3",
      width: String(nodeW), height: String(nodeH),
    }),
    el(
      "text",
      { class: "module-name", x: String(nodeW / 2), y: "19" },
      inst.module
    ),
    el(
      "title",
      {},
      `${inst.module} — ${inst.path}\n` +
        (hasSchematic(state.model, inst.path)
          ? "double-click: schematic; Ctrl+double-click: source"
          : "double-click: module source")
    )
  );
  vp.append(node);

  // divizorul + titlurile sectiunilor de pini (rol, docs/04): doar cand
  // grupul clock/reset a fost separat prin gap (dividerY >= 0)
  if (dividerY >= 0) {
    node.append(
      el("line", {
        class: "sym-divider",
        x1: "8", y1: String(dividerY), x2: String(nodeW - 8), y2: String(dividerY),
      }),
      el(
        "text",
        { class: "sym-section", x: "10", y: String(dividerY + 11) },
        "clock / reset"
      )
    );
    // sectiunea de sus (semnale) e implicita prin contrast cu eticheta
    // clock/reset de sub divizor — nu o etichetam separat (ar concura cu
    // numele modulului cand primul pin e sus)
  }

  // overlay-ul se aplica doar cand configuratia vizeaza modulul afisat
  const ov =
    state.overlay && state.overlay.dut === inst.module ? state.overlay : null;
  const pinAgent = new Map<string, number>();
  ov?.agents.forEach((a) => a.pins.forEach((p) => pinAgent.set(p, a.color)));

  for (const port of ctx.ports ?? []) {
    const spec = byId.get(port.id);
    if (!spec) {
      continue;
    }
    const py = (port.y ?? 0) + (port.height ?? 0) / 2;
    const deco: PinDeco | undefined = ov
      ? { color: pinAgent.get(spec.name), role: ov.roles[spec.name] }
      : undefined;
    node.append(drawPin(spec, nodeW, py, deco));
  }
  applySelectionClasses();
  applyStatusBadges();
  refreshMinimap(); // simbolul nu are minimap (incape mereu) — il scoate
}

// ------------------------------------------------------------ interactiune

function applyTransform(): void {
  viewport?.setAttribute(
    "transform",
    `translate(${state.tx},${state.ty}) scale(${state.k})`
  );
  updateMinimap();
}

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** limitele continutului la ultima randare (pentru fit) */
let contentBounds: Bounds = { x: 0, y: 0, w: 200, h: 100 };

/** dreptunghiul care cuprinde toate nodurile layoutului (dupa drag-uri,
 *  continutul poate depasi dreptunghiul ELK initial, inclusiv spre negativ) */
function layoutBounds(layout: ElkNode): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of layout.children ?? []) {
    const x = c.x ?? 0;
    const y = c.y ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (c.width ?? 0));
    maxY = Math.max(maxY, y + (c.height ?? 0));
  }
  if (minX === Infinity) {
    return { x: 0, y: 0, w: layout.width ?? 200, h: layout.height ?? 100 };
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** ultima dimensiune cunoscuta a canvas-ului (pentru pastrarea centrului) */
let lastVW = 0;
let lastVH = 0;

/** camera curenta e o incadrare automata (se recalculeaza la resize),
 *  nu una a utilizatorului (pan/zoom/camera persistata) */
let autoCam = true;

function fit(b: Bounds): void {
  const vw = canvas.clientWidth || 800;
  const vh = canvas.clientHeight || 600;
  const margin = 2 * STUB + 40;
  state.k = Math.min(vw / (b.w + margin), vh / (b.h + margin), 1.5);
  state.tx = (vw - b.w * state.k) / 2 - b.x * state.k;
  state.ty = (vh - b.h * state.k) / 2 - b.y * state.k;
  lastVW = vw;
  lastVH = vh;
  autoCam = true;
  applyTransform();
}

/** incadreaza diagrama in fereastra (tasta F / butonul din antet);
 *  camera rezultata se persista ca la orice pan/zoom */
function fitView(): void {
  if (state.mode === "schematic" && currentLayout) {
    contentBounds = layoutBounds(currentLayout); // drag-urile au miscat lumea
  } else if (state.mode === "tb" && currentTbLayout) {
    contentBounds = tbBounds(currentTbLayout); // idem: pozitiile din drag/seminte
  }
  fit(contentBounds);
  scheduleCameraSave();
}

function postSelection(): void {
  post({ v: 1, type: "select/changed", ids: [...state.selection] });
}

// ------------------------------------------------------------------ minimap

// Navigatorul de ansamblu (docs/04): miniatura scenei intr-un colt + dreptunghiul
// zonei vizibile; click/drag pe el muta camera. Miniatura e o COPIE VIE prin
// <use href="#viewport"> — zero re-randare, orice schimbare (drag, selectie,
// ghidaje) apare instant; transformul U = M ∘ V⁻¹ (minimap.ts, pur, testat in
// test:minimap) anuleaza camera copiata si aduce lumea la scara minimapului.
// Doar in vederile-schema (RTL + TB) — simbolul incape mereu. Stare de sesiune
// (ca si camera), tasta M comuta.
const MM_W = 180;
const MM_H = 120;
const MM_PAD = 8;
const MM_MARGIN = 12;
let minimapOn = true;
let mmLayout: MmLayout | null = null;
/** pozitia coltului minimapului in canvas (pentru client->local la pointer) */
let mmPos = { x: 0, y: 0 };
let mmDragging = false;

/** salt/pan de camera din pozitia pointerului pe minimap */
function mmJump(e: PointerEvent): void {
  if (!mmLayout) {
    return;
  }
  const cb = canvas.getBoundingClientRect();
  const cam = cameraForMinimapPoint(
    mmLayout,
    e.clientX - cb.left - mmPos.x,
    e.clientY - cb.top - mmPos.y,
    state.k,
    canvas.clientWidth || 800,
    canvas.clientHeight || 600
  );
  state.tx = cam.tx;
  state.ty = cam.ty;
  autoCam = false; // camera e de-acum a utilizatorului
  applyTransform();
  scheduleCameraSave();
}

/** actualizare IEFTINA per cadru (apelata din applyTransform): transformul
 *  copiei <use> + dreptunghiul de vedere; geometria din minimap.ts (pur) */
function updateMinimap(): void {
  if (!mmLayout) {
    return;
  }
  const g = canvas.querySelector<SVGGElement>("#minimap");
  if (!g) {
    return;
  }
  const vw = canvas.clientWidth || 800;
  const vh = canvas.clientHeight || 600;
  // auto-corectia ancorarii: refreshMinimap poate rula cu canvasul inca
  // ascuns (ecranul de bun-venit, clientWidth=0 -> fallback); cum camera se
  // aplica dupa ce canvasul devine vizibil, prima trecere pe aici vede
  // dimensiunea reala si muta minimapul in coltul corect
  const px = vw - MM_W - MM_MARGIN;
  const py = vh - MM_H - MM_MARGIN;
  if (px !== mmPos.x || py !== mmPos.y) {
    mmPos = { x: px, y: py };
    g.setAttribute("transform", `translate(${px},${py})`);
  }
  g.querySelector<SVGGElement>(".mm-scale")?.setAttribute(
    "transform",
    minimapUseTransform(mmLayout, state)
  );
  const vr = minimapViewRect(mmLayout, state, vw, vh);
  const r = g.querySelector<SVGRectElement>(".mm-view");
  if (r) {
    r.setAttribute("x", String(vr.x));
    r.setAttribute("y", String(vr.y));
    r.setAttribute("width", String(Math.max(vr.w, 0)));
    r.setAttribute("height", String(Math.max(vr.h, 0)));
  }
}

/** (re)construieste minimapul: dupa fiecare randare (resetCanvas goleste
 *  canvasul), la drag-end/undo (limitele lumii s-au miscat), la resize
 *  (repozitionare in colt) si la toggle (tasta M). In afara vederilor-schema
 *  sau fara continut, il scoate. */
function refreshMinimap(): void {
  const old = canvas.querySelector<SVGGElement>("#minimap");
  const b = !minimapOn || !viewport
    ? null
    : state.mode === "tb"
      ? currentTbLayout && tbBounds(currentTbLayout)
      : state.mode === "schematic"
        ? currentLayout && layoutBounds(currentLayout)
        : null;
  if (!b || b.w <= 0 || b.h <= 0) {
    mmLayout = null;
    mmDragging = false; // elementul care detinea gestul dispare
    old?.remove();
    return;
  }
  mmLayout = minimapLayout(b, MM_W, MM_H, MM_PAD);
  mmPos = {
    x: (canvas.clientWidth || 800) - MM_W - MM_MARGIN,
    y: (canvas.clientHeight || 600) - MM_H - MM_MARGIN,
  };
  let g = old;
  if (!g) {
    // reconstructie de la zero (resetCanvas a sters minimapul): vechiul hit
    // rect — singurul care reseta flag-ul la pointerup — nu mai exista, deci
    // un drag de minimap intrerupt de re-randare se anuleaza aici (recenzia
    // adversariala a minimapului: altfel hover-ul fara buton pana camera)
    mmDragging = false;
    g = el("g", { id: "minimap" });
    const clip = el("clipPath", { id: "mm-clip" });
    clip.append(
      el("rect", {
        x: "0", y: "0", width: String(MM_W), height: String(MM_H), rx: "4",
      })
    );
    const content = el("g", {
      class: "mm-content",
      "clip-path": "url(#mm-clip)",
    });
    const scale = el("g", { class: "mm-scale" });
    scale.append(el("use", { href: "#viewport" }));
    content.append(scale, el("rect", { class: "mm-view" }));
    const hit = el("rect", {
      class: "mm-hit",
      x: "0", y: "0", width: String(MM_W), height: String(MM_H),
    });
    // gesturile pe minimap NU ajung la canvas (altfel pointerdown ar porni
    // lasso-ul, iar click-ul de dupa ar goli selectia)
    hit.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      mmDragging = true;
      mmJump(e); // saltul intai — captura poate arunca (pointer expirat)
      try {
        hit.setPointerCapture(e.pointerId);
      } catch {
        // fara captura, pan-ul merge cat timp pointerul ramane pe minimap
      }
    });
    hit.addEventListener("pointermove", (e) => {
      if (mmDragging) {
        e.stopPropagation();
        mmJump(e);
      }
    });
    hit.addEventListener("pointerup", (e) => {
      // stopPropagation DOAR cand gestul e al minimapului: un gest de canvas
      // sub-prag (lasso/drag < DRAG_MIN, inca fara captura) eliberat peste
      // minimap trebuie sa ajunga la curatarea canvas-ului, altfel ramane un
      // marquee/drag fantoma (recenzia adversariala a minimapului)
      if (mmDragging) {
        mmDragging = false;
        e.stopPropagation();
      }
    });
    // caile de anulare resetau flag-ul doar pe pointerup-ul propriu: fara
    // acestea, un pointercancel (touch/pen) sau pierderea capturii lasau
    // mmDragging blocat true -> hover fara buton pana camera (recenzia
    // adversariala a minimapului)
    hit.addEventListener("pointercancel", () => {
      mmDragging = false;
    });
    hit.addEventListener("lostpointercapture", () => {
      mmDragging = false;
    });
    hit.addEventListener("click", (e) => e.stopPropagation());
    hit.addEventListener("dblclick", (e) => e.stopPropagation());
    hit.append(el("title", {}, "Overview — click or drag to move the view (M toggles)"));
    g.append(
      clip,
      el("rect", {
        class: "mm-bg",
        x: "0", y: "0", width: String(MM_W), height: String(MM_H), rx: "4",
      }),
      content,
      hit
    );
  }
  // (re)atasare la final: randarea re-creeaza viewport-ul sub el, iar minimapul
  // trebuie sa ramana DEASUPRA continutului
  canvas.append(g);
  g.setAttribute("transform", `translate(${mmPos.x},${mmPos.y})`);
  updateMinimap();
}

// --------------------------------------------------------------- export SVG

/** proprietatile inline-uite la export: CSS-ul webview-ului e extern si
 *  tematizat prin var(--vscode-*) — nu calatoreste cu fisierul */
const EXPORT_PROPS = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray",
  "stroke-linecap", "stroke-linejoin", "stroke-opacity", "opacity",
  "font-family", "font-size", "font-weight", "font-style",
  "text-anchor", "dominant-baseline", "letter-spacing", "visibility",
  // marcaje pur-CSS ale textelor: titlurile TB (uppercase) si porturile
  // ignorate (line-through) — omise, exportul difera vizibil de ecran
  "text-transform", "text-decoration",
] as const;

/**
 * Serializeaza vederea curenta ca SVG AUTONOM si o trimite host-ului
 * (export/result, docs/05): stilurile CALCULATE se inline-uiesc (culorile
 * temei curente se coc in fisier), camera de sesiune se inlocuieste cu un
 * viewBox pe continut, iar fundalul temei se coace intr-un rect (exportul
 * transparent e ilizibil pe fundal alb/negru). Stilurile se citesc pe CLONA
 * atasata off-screen, NU pe original: clona n-are `.selected` (ridicata) si
 * nu e sub pointer, deci `:hover`/`:selected` nu se coc in export.
 */
function exportSvg(): void {
  // ecranul de bun-venit ramane VIZIBIL peste un viewport eventual populat
  // de o vedere anterioara (render() nu-l goleste) — gate-ul se ia dupa
  // overlay, nu doar dupa DOM (regresie reala prinsa la validarea manuala:
  // exportul de pe welcome deschidea dialogul de salvare). Sub un BANNER,
  // exportul ramane permis: dedesubt e ultimul desen valid (invariantul 5)
  if (!viewport || !viewport.hasChildNodes() || !empty.hidden) {
    post({ v: 1, type: "export/result", viewId: state.viewId ?? "", svg: "" });
    return;
  }
  const MARGIN = 16;
  // bbox-ul continutului in spatiul lumii (getBBox ignora transformul
  // propriu al viewport-ului = exact camera pe care o aruncam)
  const bb = viewport.getBBox();
  const clone = canvas.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll(".selected").forEach((n) =>
    n.classList.remove("selected")
  );
  // haloul de cross-probing e stare de sesiune, nu continut: fara el, galbenul
  // s-ar coace permanent in fisier (recenzia adversariala a sincronizarii)
  clone.querySelectorAll(".xprobe").forEach((n) =>
    n.classList.remove("xprobe")
  );
  // badge-urile de stare sunt diagnostic de sesiune, nu continut (docs/05)
  clone.querySelectorAll(".status-badge").forEach((n) => n.remove());
  clone.removeAttribute("id"); // fara reguli `#canvas` + fara id duplicat
  // atasam off-screen: stilurile se rezolva din stylesheet FARA :hover
  // (pointerul e pe UI-ul real, nu pe clona) si fara :selected (ridicata)
  clone.style.position = "absolute";
  clone.style.left = "-100000px";
  clone.style.top = "0";
  document.body.append(clone);
  // culorile din color-mix se calculeaza ca `color(srgb r g b / a)` — sintaxa
  // CSS Color 4, pe care uneltele SVG externe (Inkscape, convertoare PDF) pot
  // sa n-o parseze; se normalizeaza la rgba() clasic
  const legacyColor = (v: string): string =>
    v.replace(
      /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/g,
      (_m, r, g, b, a) => {
        const c = (x: string): number => Math.round(Number(x) * 255);
        return a === undefined
          ? `rgb(${c(r)}, ${c(g)}, ${c(b)})`
          : `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${a})`;
      }
    );
  const nodes = clone.querySelectorAll<SVGElement>("*");
  const styles: string[] = [];
  for (const n of nodes) {
    const cs = getComputedStyle(n); // citire (fara mutatii intre citiri)
    let style = "";
    for (const p of EXPORT_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v) {
        style += `${p}:${legacyColor(v)};`;
      }
    }
    styles.push(style);
  }
  nodes.forEach((n, i) => n.setAttribute("style", styles[i])); // scriere
  clone.remove();
  clone.removeAttribute("style"); // scoatem pozitionarea off-screen

  clone.querySelector<SVGGElement>("#viewport")?.removeAttribute("transform");
  // minimapul e chrome de UI (navigator), nu continut — nu intra in export
  clone.querySelector<SVGGElement>("#minimap")?.remove();
  clone.setAttribute("xmlns", SVG_NS);
  const w = Math.ceil(bb.width + 2 * MARGIN);
  const hh = Math.ceil(bb.height + 2 * MARGIN);
  clone.setAttribute("viewBox", `${bb.x - MARGIN} ${bb.y - MARGIN} ${w} ${hh}`);
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(hh));
  const bg = el("rect", {
    x: String(bb.x - MARGIN),
    y: String(bb.y - MARGIN),
    width: String(w),
    height: String(hh),
    fill: getComputedStyle(document.body).backgroundColor,
  });
  clone.insertBefore(bg, clone.firstChild);
  const svg =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    new XMLSerializer().serializeToString(clone);
  post({ v: 1, type: "export/result", viewId: state.viewId ?? "", svg });
}

// --- decoratiile de stare quick-uvm (docs/05): validarile model<->YAML ca
// badge-uri pe elemente + rezultatul ultimului generate ca cip in antet;
// maparea pe id-urile vederii curente e pura (statusIdsRtl/Tb, src/status.ts)
let statusDecos: StatusDeco[] = [];
let genStatus: GenerateStatus | null = null;

/** badge ⚠/✕ in coltul dreapta-sus al fiecarui element vizat, cu mesajele in
 *  tooltip; idempotent (scoate badge-urile vechi), rulat dupa fiecare randare
 *  si la status/decorations */
function applyStatusBadges(): void {
  canvas.querySelectorAll(".status-badge").forEach((b) => b.remove());
  if (!statusDecos.length) {
    return;
  }
  let map: Map<string, ElementStatus>;
  if (state.mode === "tb") {
    map = statusIdsTb(
      statusDecos,
      new Set((currentTbScene?.nodes ?? []).map((n) => n.id))
    );
  } else {
    const byPath = instModuleByPath();
    map = statusIdsRtl(statusDecos, {
      viewModule:
        state.mode === "schematic"
          ? currentScene?.module ?? null
          : byPath.get(state.viewId ?? "") ?? null,
      dut: state.overlay?.dut ?? null,
      nodes:
        state.mode === "schematic"
          ? (currentScene?.nodes ?? []).map((n) => ({
              id: n.id,
              module: byPath.get(n.instPath ?? n.memberPaths?.[0] ?? "") ?? "",
            }))
          : [],
    });
  }
  canvas.querySelectorAll<SVGGraphicsElement>("[data-id]").forEach((g) => {
    const st = map.get(g.dataset.id ?? "");
    if (!st) {
      return;
    }
    let bb: DOMRect;
    try {
      bb = g.getBBox();
    } catch {
      return; // element inca neatasat/invizibil
    }
    const cx = bb.x + bb.width;
    const cy = bb.y;
    const badge = el("g", { class: `status-badge sev-${st.severity}` });
    badge.append(
      el("circle", { cx: String(cx), cy: String(cy), r: "7" }),
      el(
        "text",
        { x: String(cx), y: String(cy + 3.5), "text-anchor": "middle" },
        st.severity === "error" ? "✕" : "!"
      ),
      el("title", {}, st.messages.join("\n"))
    );
    g.append(badge);
  });
}

/** cipul de stare al ultimului „Genereaza testbench" din antet (docs/05);
 *  idempotent, rulat de ambele antete si la status/decorations */
function updateGenChip(): void {
  head.querySelector(".gen-chip")?.remove();
  const tgl = head.querySelector(".mode-toggle");
  if (!tgl || !genStatus) {
    return;
  }
  const s = genStatus;
  const chip = h(
    "span",
    `gen-chip ${s.ok ? "gen-ok" : "gen-fail"}`,
    s.ok ? "✓ generate" : "✕ generate"
  );
  chip.title =
    (s.ok
      ? "quick-uvm generate succeeded"
      : `quick-uvm generate failed (exit ${s.code})` +
        (s.detail ? `\n${s.detail}` : "")) + `\n${s.at}`;
  tgl.prepend(chip);
}

// --- cross-probing editor->diagrama (docs/05): haloul .xprobe, DISTINCT de
// selectie — tintele vin prin probe/highlight, maparea pe id-urile vederii
// curente e pura (probeIds, src/locmap.ts)
let probeTargets: XprobeTarget[] = [];

/** harta cale->modul, memoizata pe referinta modelului: probeCtx ruleaza in
 *  applySelectionClasses (si la lasso, per pointermove) — reconstructia per
 *  apel ar fi O(instante) pe fiecare miscare de mouse cu haloul activ */
let instModuleCache: { model: ProjectModel | undefined; map: Map<string, string> } = {
  model: undefined,
  map: new Map(),
};
function instModuleByPath(): Map<string, string> {
  if (instModuleCache.model !== state.model) {
    instModuleCache = {
      model: state.model,
      map: new Map(
        (state.model?.instances ?? []).map((i) => [i.path, i.module])
      ),
    };
  }
  return instModuleCache.map;
}

/** contextul vederii curente pentru probeIds; modulul nodurilor se ia din
 *  model (SceneNode nu-l poarta separat de subtitlu) */
function probeCtx(): ProbeViewCtx {
  const byPath = instModuleByPath();
  if (state.mode === "schematic" && currentScene) {
    return {
      mode: "schematic",
      viewId: state.viewId ?? "",
      viewModule: currentScene.module,
      nodes: currentScene.nodes.map((n) => ({
        id: n.id,
        instPath: n.instPath,
        module:
          byPath.get(n.instPath ?? n.memberPaths?.[0] ?? "") ?? "",
        memberPaths: n.memberPaths,
      })),
    };
  }
  return {
    mode: state.mode,
    viewId: state.viewId ?? "",
    viewModule: byPath.get(state.viewId ?? "") ?? null,
    nodes: [],
  };
}

function applySelectionClasses(): void {
  // haloul se recalculeaza aici (nu se tine un Set cache): functia ruleaza
  // dupa fiecare randare/navigare, deci maparea urmeaza mereu scena curenta
  const probe = new Set(
    probeTargets.length ? probeIds(probeTargets, probeCtx()) : []
  );
  canvas.querySelectorAll<SVGElement>("[data-id]").forEach((g) => {
    g.classList.toggle("selected", state.selection.has(g.dataset.id ?? ""));
    g.classList.toggle("xprobe", probe.has(g.dataset.id ?? ""));
  });
}

canvas.addEventListener("click", (e) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const target = (e.target as Element).closest<SVGElement>("[data-id]");
  if (!target) {
    // Shift+click pe fundal / element fara data-id (ex. muchie iface): gest de
    // con — NU golim selectia existenta (altfel un rateu ar sterge conul)
    if (!e.shiftKey && state.selection.size) {
      state.selection.clear();
      applySelectionClasses();
      postSelection();
      renderInspector();
    }
    return;
  }
  const id = target.dataset.id ?? "";
  if (e.shiftKey && state.mode === "schematic" && currentScene) {
    // conul de conectivitate (docs/04, faza 4): Shift+click = tot ce e condus
    // de element (aval); Shift+Alt+click = tot ce il conduce (amonte).
    // coneOf clasifica id-ul (nod/steag, nume de net, sau pin) — un click pe
    // interiorul unui pin porneste din net-urile lui, nu dintr-un net inexistent
    const cone = coneOf(currentScene, id, e.altKey ? "up" : "down");
    if (cone) {
      state.selection = cone;
      applySelectionClasses();
      postSelection();
      renderInspector();
    }
    return; // Shift e mereu gest de con; id nerecunoscut => selectia ramane
  }
  if (e.ctrlKey || e.metaKey) {
    if (!state.selection.delete(id)) {
      state.selection.add(id);
    }
  } else {
    state.selection.clear();
    state.selection.add(id);
  }
  applySelectionClasses();
  postSelection();
  renderInspector();
});

// cross-probing la hover (faza 4, docs/05): dupa o scurta stationare pe un
// pin din vederile RTL, host-ul reveleaza declaratia portului in editoarele
// DEJA vizibile (ne-intruziv: nu deschide tab-uri, nu fura focusul; setarea
// quickuvm.hoverCrossProbe il stinge in host). Saltul complet = dublu-click.
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let hoverKey = "";
canvas.addEventListener("pointerover", (e) => {
  if (state.mode === "tb" || e.buttons !== 0) {
    return; // vederea TB nu are surse SV; in timpul drag-ului, nimic
  }
  const pin = (e.target as Element).closest<SVGElement>(".pin, .bport");
  const port = pin?.dataset.port;
  const owner = !pin
    ? undefined
    : state.mode === "schematic"
      ? pin.dataset.inst ?? (pin.dataset.bport ? state.viewId : undefined)
      : state.viewId;
  const key = port && owner ? `${owner}|${port}` : "";
  if (key === hoverKey) {
    return; // acelasi pin (pointerover pe copiii lui): pastreaza programarea
  }
  clearTimeout(hoverTimer);
  hoverKey = key;
  if (!key) {
    return; // a iesit pe fundal/alt element: anuleaza revelarea programata
  }
  hoverTimer = setTimeout(() => {
    post({
      v: 1,
      type: "action/request",
      action: "openSource",
      args: { viewId: owner, port, peek: true },
    });
  }, 300);
});
canvas.addEventListener("pointerleave", () => {
  // iesirea din canvas NU declanseaza pointerover (doar leave): fara anulare,
  // un timer programat ar trage dupa ce pointerul a parasit diagrama
  clearTimeout(hoverTimer);
  hoverKey = "";
});

// dublu-click, regula unica dupa tinta (docs/05): pe pin — declaratia
// portului; pe pliaj — expandare; pe bloc — "intra in el": schema daca
// exista, la frunze chiar sursa modulului. Ctrl+dublu-click pe bloc =
// sursa modulului, oriunde.
canvas.addEventListener("dblclick", (e) => {
  if (state.mode === "tb") {
    // drill pe un bloc cu structura (D24): coboara la nivelul lui;
    // pe un subenv (`config:`), deschide config-ul blocului compus
    const box = (e.target as Element).closest<SVGElement>(".tbnode.drill");
    if (box?.dataset.drill) {
      tbOpen(box.dataset.drill);
    }
    return;
  }
  const t = e.target as Element;
  const openSrc = (args: Record<string, unknown>): void =>
    post({ v: 1, type: "action/request", action: "openSource", args });

  const pin = t.closest<SVGElement>(".pin, .bport");
  if (pin) {
    const port = pin.dataset.port;
    // simbol: pinii apartin modulului vederii; schema: instantei copil
    // (data-inst) sau modulului vederii (granita); pinii pliajelor nu au
    // o singura sursa — se ignora
    const owner =
      state.mode === "schematic"
        ? pin.dataset.inst ?? (pin.dataset.bport ? state.viewId : undefined)
        : state.viewId;
    if (port && owner) {
      openSrc({ viewId: owner, port });
    }
    return;
  }

  let instPath: string | undefined;
  if (state.mode === "schematic") {
    const node = t.closest<SVGElement>(".inode");
    if (!node) {
      return;
    }
    if (!node.dataset.inst) {
      if (node.dataset.id) {
        toggleFold(node.dataset.id); // pliaj: dublu-click = expandare
      }
      return;
    }
    instPath = node.dataset.inst;
  } else {
    if (!t.closest(".node")) {
      return;
    }
    instPath = state.viewId; // simbolul contextului e blocul instantei curente
  }
  if (!instPath) {
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    openSrc({ viewId: instPath });
  } else if (hasSchematic(state.model, instPath)) {
    navigateTo(instPath, "schematic");
  } else {
    openSrc({ viewId: instPath }); // frunza: "schema" e chiar codul
  }
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0012);
    const k2 = Math.min(5, Math.max(0.2, state.k * factor));
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    state.tx = cx - ((cx - state.tx) * k2) / state.k;
    state.ty = cy - ((cy - state.ty) * k2) / state.k;
    state.k = k2;
    autoCam = false; // camera e de-acum a utilizatorului
    applyTransform();
    scheduleCameraSave();
  },
  { passive: false }
);

// ---------------------------------------------------------- drag si pan

const GRID = 8; // snap pe grila la drag (docs/04)
const DRAG_MIN = 5; // px pe ecran sub care gestul ramane click

interface DragItem {
  nodeId: string;
  el: SVGGElement;
  /** holder-ul mutabil de pozitie + dimensiuni: ElkNode (RTL: width/height) sau
   *  TbPlaced/TbBPlaced (TB: w/h) — ambele au x/y mutabile */
  child: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    w?: number;
    h?: number;
  };
  origX: number; // nodul, in coordonatele diagramei
  origY: number;
}

interface DragState {
  items: DragItem[];
  /** nodul APUCAT (sub cursor): el se aliniaza; grupul se muta cu el */
  primary: string;
  startX: number; // pointer, px ecran
  startY: number;
  moved: boolean;
  /** pozitiile INTREGII vederi la apasare — intrarea de undo a mutarii */
  before: PosMap | null;
}
/** pragul de aliniere la drag, in px ECRAN (diagrama: impartit la zoom) */
const ALIGN_THRESH = 6;
let alignGuideEls: SVGElement[] = [];
let drag: DragState | undefined;
/** un drag incheiat nu trebuie sa declanseze si click-ul de selectie */
let suppressClick = false;

// lasso: dreptunghi de selectie pornit cu click-stanga pe fundal (docs/04);
// pe simbol selecteaza pini (gestul pentru "Agent from selection"), pe
// schema selecteaza blocuri si steaguri; Ctrl = adaugare la selectie
interface Marquee {
  x0: number; // pointer, px ecran
  y0: number;
  /** baza selectiei: cea existenta la Ctrl, goala altfel */
  base: Set<string>;
  /** dreptunghiul SVG, creat abia dupa pragul DRAG_MIN */
  rect: SVGRectElement | null;
  /** tintele cu dreptunghiurile lor pe ecran, cache la pornire */
  candidates: { id: string; r: DOMRect }[] | null;
}
let marquee: Marquee | undefined;

function marqueeCandidates(): { id: string; r: DOMRect }[] {
  const sel =
    state.mode === "schematic"
      ? ".inode[data-id], .bport[data-id]"
      : state.mode === "tb"
        ? ".tbnode[data-id], .tb-bport[data-id]"
        : ".pin[data-id]";
  return [...canvas.querySelectorAll<SVGGElement>(sel)].map((g) => ({
    id: g.dataset.id ?? "",
    r: g.getBoundingClientRect(),
  }));
}

// --- drag polimorf: aceeasi mecanica pentru schema RTL si vederea de
// verificare, doar structura layoutului si re-rutarea difera (docs/04)

/** vederea curenta e editabila prin drag (pozitiile apartin utilizatorului)? */
function draggable(): boolean {
  return state.mode === "schematic" || state.mode === "tb";
}
/** selectorul elementelor mutabile din DOM, dupa mod */
function dragSelector(): string {
  return state.mode === "tb"
    ? ".tbnode[data-id], .tb-bport[data-id]"
    : ".inode[data-id], .bport[data-id]";
}
/** holder-ul mutabil de pozitie al unui nod: ElkNode (RTL) sau TbPlaced/
 *  TbBPlaced (TB) — ambele au x/y mutabile */
function dragChild(id: string): DragItem["child"] | undefined {
  if (state.mode === "tb") {
    return currentTbLayout?.nodes.get(id) ?? currentTbLayout?.boundary.get(id);
  }
  return currentLayout?.children?.find((c) => c.id === id);
}
/** punctele de aliniere ale unui nod plasat la (x,y): CAPETELE pinilor lui
 *  (varfurile stub-urilor, `tips` din pinTipOffsets — cererea utilizatorului:
 *  ghidajele trec prin capetele pinilor, nu prin marginile blocului) sau, daca
 *  n-are pini, centrul lui (steag de granita). RTL: steagul de granita e tot
 *  nod ELK (in children); TB: TbPlaced (porturi) / TbBPlaced */
function nodeAlignPts(
  id: string,
  x: number,
  y: number,
  tips: Map<string, AlignPt[]> | null
): AlignPt[] {
  if (state.mode === "tb") {
    const p = currentTbLayout?.nodes.get(id);
    if (p) {
      return [...p.ports.values()].map((pt) => ({ x: x + pt.x, y: y + pt.y }));
    }
    const b = currentTbLayout?.boundary.get(id);
    return b ? [{ x: x + b.w / 2, y: y + 8 }] : []; // BPORT_H/2
  }
  const offs = tips?.get(id);
  if (offs?.length) {
    return offs.map((o) => ({ x: x + o.x, y: y + o.y }));
  }
  const c = currentLayout?.children?.find((ch) => ch.id === id);
  return c ? [{ x: x + (c.width ?? 0) / 2, y: y + (c.height ?? 0) / 2 }] : [];
}
/** toate punctele de aliniere (capete de pini + ancore de steaguri) ale vederii
 *  curente, EXCLUZAND `exclude` — tintele pentru ghidajele de aliniere.
 *  Alinierea la CAPETELE PINILOR (nu la marginile blocului) tine firele drepte
 *  si trece ghidajul prin varfuri (docs/04) */
function nodePortPoints(
  exclude: Set<string>,
  tips: Map<string, AlignPt[]> | null
): AlignPt[] {
  const out: AlignPt[] = [];
  if (state.mode === "tb") {
    for (const [id, p] of currentTbLayout?.nodes ?? []) {
      if (!exclude.has(id)) out.push(...nodeAlignPts(id, p.x, p.y, tips));
    }
    for (const [id, p] of currentTbLayout?.boundary ?? []) {
      if (!exclude.has(id)) out.push(...nodeAlignPts(id, p.x, p.y, tips));
    }
    return out;
  }
  for (const c of currentLayout?.children ?? []) {
    const id = c.id ?? "";
    if (!exclude.has(id)) out.push(...nodeAlignPts(id, c.x ?? 0, c.y ?? 0, tips));
  }
  return out;
}
/** deseneaza ghidajele de aliniere in viewport (spatiu diagrama); le curata
 *  intai. Liniile sunt `non-scaling-stroke` (1px la orice zoom) */
function renderAlignGuides(a: AlignSnap): void {
  clearAlignGuides();
  if (!viewport) {
    return;
  }
  if (a.vLine) {
    const l = el("line", {
      class: "align-guide",
      x1: String(a.vLine.x), y1: String(a.vLine.y0),
      x2: String(a.vLine.x), y2: String(a.vLine.y1),
    });
    viewport.append(l);
    alignGuideEls.push(l);
  }
  if (a.hLine) {
    const l = el("line", {
      class: "align-guide",
      x1: String(a.hLine.x0), y1: String(a.hLine.y),
      x2: String(a.hLine.x1), y2: String(a.hLine.y),
    });
    viewport.append(l);
    alignGuideEls.push(l);
  }
}
function clearAlignGuides(): void {
  for (const g of alignGuideEls) {
    g.remove();
  }
  alignGuideEls = [];
}
/** re-ruteaza muchiile la pozitiile curente (drag live) */
function dragReroute(): void {
  if (state.mode === "tb") {
    if (currentTbScene && currentTbLayout && currentTbEdgesGroup) {
      drawTbEdges(currentTbScene, currentTbLayout, currentTbEdgesGroup);
    }
  } else if (currentScene && currentLayout && currentEdgesGroup) {
    routeEdges(currentScene, currentLayout, currentEdgesGroup);
  }
}
/** itereaza toate pozitiile vederii curente (pentru snapshot-ul total D21) */
function dragEachPos(cb: (id: string, x: number, y: number) => void): void {
  if (state.mode === "tb") {
    if (currentTbLayout) {
      for (const [id, p] of currentTbLayout.nodes) {
        cb(id, p.x, p.y);
      }
      for (const [id, p] of currentTbLayout.boundary) {
        cb(id, p.x, p.y);
      }
    }
    return;
  }
  for (const c of currentLayout?.children ?? []) {
    cb(c.id ?? "", c.x ?? 0, c.y ?? 0);
  }
}

// -------------------------------------------- undo/redo de pozitii (docs/04)

/** istoricul de POZITII al sesiunii, per cheie de layout (RTL: viewId; TB:
 *  `tb:<config>|<focus>`): Ctrl+Z/Ctrl+Y anuleaza/reface mutarile de blocuri
 *  si re-aranjarile ⟲. Doar pozitii (nu flip/pliaj) si doar sesiune —
 *  fiecare pas aplicat se persista normal prin `layout/snapshot`, ca orice
 *  gest de pozitie (sidecar-ul ramane sursa persistata) */
type PosMap = Record<string, { x: number; y: number }>;
const posHistory = new Map<string, { undo: PosMap[]; redo: PosMap[] }>();
const POS_HISTORY_MAX = 50;

/** pozitiile curente ale vederii (toate, D21), sau null fara layout */
function capturePositions(): PosMap | null {
  const nodes: PosMap = {};
  let count = 0;
  dragEachPos((id, x, y) => {
    if (id) {
      nodes[id] = { x, y };
      count++;
    }
  });
  return count ? nodes : null;
}

/** impinge starea DINAINTEA unui gest de pozitie; un gest nou goleste redo-ul */
function pushPosUndo(before: PosMap | null): void {
  const key = layoutKey();
  if (!key || !before) {
    return;
  }
  const h = posHistory.get(key) ?? { undo: [], redo: [] };
  h.undo.push(before);
  if (h.undo.length > POS_HISTORY_MAX) {
    h.undo.shift();
  }
  h.redo.length = 0;
  posHistory.set(key, h);
}

/** aplica un snapshot: oglinda sidecar + persistare + re-randare (semintele
 *  totale forteaza exact pozitiile; camera ramane pe loc) */
function applyPositions(key: string, nodes: PosMap): void {
  for (const [id, p] of Object.entries(nodes)) {
    const n = sidecarNode(key, id);
    n.x = p.x;
    n.y = p.y;
  }
  post({ v: 1, type: "layout/snapshot", viewId: key, nodes });
  void render(false);
}

function undoPositions(redo: boolean): void {
  const key = layoutKey();
  const h = key ? posHistory.get(key) : undefined;
  if (!key || !h) {
    return;
  }
  const snap = (redo ? h.redo : h.undo).pop();
  if (!snap) {
    return;
  }
  const now = capturePositions();
  if (now) {
    (redo ? h.undo : h.redo).push(now);
  }
  applyPositions(key, snap);
}

let pan: { x: number; y: number } | undefined;
canvas.addEventListener("pointerdown", (e) => {
  // orice apasare anuleaza un peek de hover programat: altfel ar trage in
  // mijlocul unui drag/click abia inceput
  clearTimeout(hoverTimer);
  hoverKey = "";
  // drag de nod sau de steag de granita in schema, cu butonul stang
  // (docs/04: pozitiile apartin utilizatorului); butonul de pliaj isi
  // pastreaza click-ul
  if (e.button === 0 && draggable()) {
    const t = e.target as Element;
    const nodeEl = t.closest<SVGElement>(
      state.mode === "tb" ? ".tbnode, .tb-bport" : ".inode, .bport"
    );
    if (nodeEl && !t.closest(".foldbtn")) {
      const pressedId = nodeEl.dataset.id ?? "";
      // conventia editoarelor de diagrame: drag pe un membru al selectiei
      // muta toata selectia; drag pe un element din afara ei muta doar
      // elementul, fara sa atinga selectia
      const ids =
        state.selection.has(pressedId) && state.selection.size > 1
          ? [...state.selection]
          : [pressedId];
      const byId = new Map<string, SVGGElement>();
      canvas
        .querySelectorAll<SVGGElement>(dragSelector())
        .forEach((g) => byId.set(g.dataset.id ?? "", g));
      const items: DragItem[] = [];
      for (const id of ids) {
        const el2 = byId.get(id);
        const child = dragChild(id);
        if (el2 && child) {
          // doar noduri/steaguri; net-urile sau pinii din selectie se ignora
          items.push({
            nodeId: id,
            el: el2,
            child,
            origX: child.x ?? 0,
            origY: child.y ?? 0,
          });
        }
      }
      if (items.length) {
        // doar candidat la drag: pointerul NU se captureaza inca — captura
        // retinteste click-ul spre canvas (Chrome) si ar strica selectia;
        // captura se face abia cand pragul DRAG_MIN e depasit (pointermove)
        drag = {
          items,
          primary: pressedId,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
          before: capturePositions(), // intrarea de undo (push la drag-end)
        };
        return;
      }
    }
  }
  // click-stanga pe fundal: lasso de selectie; pan-ul e rezervat
  // butonului din mijloc
  const onElement = (e.target as Element).closest("[data-id]");
  if (e.button === 0 && !onElement) {
    marquee = {
      x0: e.clientX,
      y0: e.clientY,
      base: e.ctrlKey || e.metaKey ? new Set(state.selection) : new Set(),
      rect: null,
      candidates: null,
    };
    return;
  }
  if (e.button === 1) {
    e.preventDefault(); // fara autoscroll-ul implicit al butonului din mijloc
    pan = { x: e.clientX - state.tx, y: e.clientY - state.ty };
    canvas.classList.add("panning");
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (drag) {
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_MIN) {
        return; // inca gest de click, nu de drag
      }
      drag.moved = true;
      canvas.setPointerCapture(e.pointerId);
    }
    // aliniere la PORTURILE vecinilor (ghidaje) SAU snap pe grila, per axa:
    // porturile nodului primar (apucat) se aliniaza la un port al altui bloc;
    // grupul se muta cu aceeasi deplasare, deci offseturile relative dintre
    // membrii selectiei se pastreaza exact
    const primaryId = drag.primary;
    const prim = drag.items.find((it) => it.nodeId === primaryId) ?? drag.items[0];
    const rawX = prim.origX + dx / state.k;
    const rawY = prim.origY + dy / state.k;
    const draggedIds = new Set(drag.items.map((it) => it.nodeId));
    // capetele pinilor RTL (varfuri de stub, cu marcatoarele) sunt punctele de
    // aliniere — ghidajele trec prin ele, nu prin marginile blocului; TB nu are
    // stub-uri, foloseste porturile direct (tips=null)
    const tips =
      state.mode === "schematic" && currentScene && currentLayout
        ? pinTipOffsets(currentScene, currentLayout)
        : null;
    const a = alignSnap(
      nodeAlignPts(primaryId, rawX, rawY, tips),
      nodePortPoints(draggedIds, tips),
      ALIGN_THRESH / state.k
    );
    // aliniere daca exista (poate fi off-grid), altfel snap pe grila
    const finalX = a.vLine ? rawX + a.dx : Math.round(rawX / GRID) * GRID;
    const finalY = a.hLine ? rawY + a.dy : Math.round(rawY / GRID) * GRID;
    const gdx = finalX - prim.origX;
    const gdy = finalY - prim.origY;
    for (const it of drag.items) {
      const nx = it.origX + gdx;
      const ny = it.origY + gdy;
      it.child.x = nx;
      it.child.y = ny;
      it.el.setAttribute("transform", `translate(${nx},${ny})`);
    }
    // traseele urmeaza pozitiile curente (docs/04): re-rutare live (RTL sau TB)
    dragReroute();
    renderAlignGuides(a); // deasupra muchiilor re-rutate
    return;
  }
  if (marquee) {
    const dx = e.clientX - marquee.x0;
    const dy = e.clientY - marquee.y0;
    if (!marquee.rect) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_MIN) {
        return; // inca gest de click
      }
      marquee.rect = el("rect", { class: "marquee" });
      canvas.append(marquee.rect);
      marquee.candidates = marqueeCandidates();
      canvas.setPointerCapture(e.pointerId);
    }
    const cb = canvas.getBoundingClientRect();
    const x1 = Math.min(marquee.x0, e.clientX);
    const y1 = Math.min(marquee.y0, e.clientY);
    const x2 = Math.max(marquee.x0, e.clientX);
    const y2 = Math.max(marquee.y0, e.clientY);
    marquee.rect.setAttribute("x", String(x1 - cb.left));
    marquee.rect.setAttribute("y", String(y1 - cb.top));
    marquee.rect.setAttribute("width", String(x2 - x1));
    marquee.rect.setAttribute("height", String(y2 - y1));
    // selectia live: baza (Ctrl) plus tintele dreptunghiului — implicit
    // doar cele complet cuprinse ("window selection"); cu
    // quickuvm.lassoMode=intersect, si cele doar atinse ("crossing")
    const hit = new Set(marquee.base);
    for (const c of marquee.candidates ?? []) {
      const inside =
        uiConfig.lasso === "intersect"
          ? c.r.left < x2 && c.r.right > x1 && c.r.top < y2 && c.r.bottom > y1
          : c.r.left >= x1 && c.r.right <= x2 && c.r.top >= y1 && c.r.bottom <= y2;
      if (inside) {
        hit.add(c.id);
      }
    }
    state.selection = hit;
    applySelectionClasses();
    return;
  }
  if (pan) {
    state.tx = e.clientX - pan.x;
    state.ty = e.clientY - pan.y;
    autoCam = false; // camera e de-acum a utilizatorului
    applyTransform();
  }
});
canvas.addEventListener("pointerup", (e) => {
  if (drag) {
    const key = layoutKey();
    if (drag.moved && key) {
      pushPosUndo(drag.before); // mutarea devine anulabila cu Ctrl+Z
      // primul gest de pozitie face aranjamentul INTREGII vederi al
      // utilizatorului (docs/04): se persista toate pozitiile curente, nu
      // doar elementele trase — cu seminte partiale, ELK interactiv ar
      // re-plasa elementele nepersistate (steaguri, noduri neatinse) altfel
      // decat layout-ul pe care il vede utilizatorul acum. Cheia e per nivel
      // la TB (`tb:<config>|<focus>`), viewId la RTL
      const nodes: Record<string, { x: number; y: number }> = {};
      dragEachPos((id, x, y) => {
        const n = sidecarNode(key, id);
        n.x = x;
        n.y = y;
        nodes[id] = { x, y };
      });
      post({ v: 1, type: "layout/snapshot", viewId: key, nodes });
      suppressClick = true;
    }
    clearAlignGuides();
    drag = undefined;
    canvas.releasePointerCapture(e.pointerId);
    refreshMinimap(); // limitele lumii s-au putut misca odata cu blocul
    // si limitele pentru fit se actualizeaza (ca in fitView): altfel un
    // resize cu autoCam ar incadra pe limitele PRE-drag, divergent de
    // minimap (recenzia adversariala a minimapului)
    if (state.mode === "schematic" && currentLayout) {
      contentBounds = layoutBounds(currentLayout);
    } else if (state.mode === "tb" && currentTbLayout) {
      contentBounds = tbBounds(currentTbLayout);
    }
    return;
  }
  if (marquee) {
    if (marquee.rect) {
      marquee.rect.remove();
      canvas.releasePointerCapture(e.pointerId);
      postSelection();
      renderInspector();
      suppressClick = true; // click-ul de dupa lasso nu goleste selectia
    }
    // fara prag depasit: click simplu — handler-ul de click decide
    marquee = undefined;
    return;
  }
  if (pan) {
    scheduleCameraSave();
  }
  pan = undefined;
  canvas.classList.remove("panning");
  canvas.releasePointerCapture(e.pointerId);
});

// -------------------------------------------------------------- camera

let camTimer: ReturnType<typeof setTimeout> | undefined;

/** retine camera vederii (stare de sesiune) dupa ce pan/zoom-ul s-a
 *  stabilizat; center-based: centrul vizibil in coordonate diagrama + zoom */
function scheduleCameraSave(): void {
  if (camTimer) {
    clearTimeout(camTimer);
  }
  camTimer = setTimeout(() => {
    const viewId = layoutKey();
    if (!viewId) {
      return;
    }
    const vw = canvas.clientWidth || 800;
    const vh = canvas.clientHeight || 600;
    const cx = (vw / 2 - state.tx) / state.k;
    const cy = (vh / 2 - state.ty) / state.k;
    sessionCameras.set(viewId, { cx, cy, zoom: state.k });
  }, 800);
}

/**
 * La redimensionarea panoului: incadrarile automate se recalculeaza, iar
 * camerele utilizatorului isi pastreaza centrul (fara continut "fugit" in
 * afara ferestrei — prima incadrare poate rula inainte ca webview-ul sa
 * aiba dimensiunea finala).
 */
function onViewportResize(): void {
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight;
  if (!vw || !vh || (vw === lastVW && vh === lastVH)) {
    return;
  }
  if (autoCam) {
    fit(contentBounds);
    refreshMinimap(); // colt nou de ancorare dupa redimensionare
    return;
  }
  if (lastVW && lastVH) {
    const cx = (lastVW / 2 - state.tx) / state.k;
    const cy = (lastVH / 2 - state.ty) / state.k;
    state.tx = vw / 2 - cx * state.k;
    state.ty = vh / 2 - cy * state.k;
    applyTransform();
  }
  lastVW = vw;
  lastVH = vh;
  refreshMinimap(); // colt nou de ancorare + dreptunghi de vedere nou
}
// ambele surse, deduplicate prin garda pe dimensiuni: ResizeObserver pe
// containerul #main (nu pe canvas — RO nu se declanseaza pe elemente SVG
// in Chromium) si evenimentul window.resize (RO livreaza pe cadre de
// randare, care in documente ascunse/throttled nu ruleaza)
new ResizeObserver(onViewportResize).observe(
  document.getElementById("main") as HTMLElement
);
window.addEventListener("resize", onViewportResize);

window.addEventListener("keydown", (e) => {
  // tastele comanda diagrama doar cand NU editezi un camp din inspector
  // (match_key/max_latency/select-uri) — altfel "f"/"h"/"Delete" ar declansa
  // gesturi in loc sa ajunga in camp
  const t = e.target as HTMLElement | null;
  if (
    t &&
    (t.tagName === "INPUT" ||
      t.tagName === "SELECT" ||
      t.tagName === "TEXTAREA" ||
      t.isContentEditable)
  ) {
    return;
  }
  if (e.key === "Escape") {
    if (ctxMenu) {
      closeCtxMenu(); // Escape inchide intai meniul contextual, nu selectia
      return;
    }
    if (state.selection.size) {
      state.selection.clear();
      applySelectionClasses();
      postSelection();
      renderInspector();
      return;
    }
  }
  const key = e.key.toLowerCase();
  // undo/redo de POZITII (docs/04): Ctrl+Z / Ctrl+Shift+Z sau Ctrl+Y —
  // inaintea bail-ului pe modificatori
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (key === "z" || key === "y") {
      e.preventDefault();
      undoPositions(key === "y" || e.shiftKey);
      return;
    }
  }
  if (e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }
  // Delete/Backspace: sterge componenta TB selectata — acelasi gest ca butonul
  // Delete din inspector (host: confirmare modala + cascada la agent). Doar in
  // vederea TB; RTL n-are stergere (nodurile vin din design, nu din config)
  if ((key === "delete" || key === "backspace") && state.mode === "tb") {
    const node = currentTbScene?.nodes.find((n) => state.selection.has(n.id));
    const target = node ? tbDeleteTarget(node) : null;
    if (target) {
      e.preventDefault();
      postAction("deleteComponent", { kind: target.kind, name: target.name });
    }
    return;
  }
  // F: incadreaza diagrama in fereastra
  if (key === "f") {
    fitView();
    return;
  }
  // M: comuta minimapul (navigatorul de ansamblu, docs/04)
  if (key === "m") {
    minimapOn = !minimapOn;
    refreshMinimap();
    return;
  }
  // sageti: deruleaza viewport-ul (pan din tastatura, cererea utilizatorului).
  // Conventie de scroll: jos = vezi continut de dedesubt (continutul urca).
  // Pas mai mare cu Shift; tinut apasat -> derulare continua (keydown repeta).
  // Camera devine a utilizatorului si se salveaza ca la pan-ul cu mouse-ul.
  if (
    key === "arrowup" ||
    key === "arrowdown" ||
    key === "arrowleft" ||
    key === "arrowright"
  ) {
    e.preventDefault();
    const step = e.shiftKey ? 200 : 40;
    if (key === "arrowup") {
      state.ty += step;
    } else if (key === "arrowdown") {
      state.ty -= step;
    } else if (key === "arrowleft") {
      state.tx += step;
    } else {
      state.tx -= step;
    }
    autoCam = false;
    applyTransform();
    scheduleCameraSave();
    return;
  }
  // H/V: rasturnarea BLOCULUI selectat (docs/04) — la RTL si la vederea TB.
  // La vederea TB, H rastoarna si un STEAG de granita selectat: rasturnare
  // LOCALA pe orizontala (oglindeste forma + muta ancora pe latura opusa a
  // steagului), fara sa-i schimbe pozitia/latura ELK — deci nu incalca
  // FIRST/LAST_SEPARATE. V nu are sens pe un steag (o singura conexiune).
  if (key === "h" || key === "v") {
    let nodeId: string | undefined;
    if (state.mode === "schematic") {
      nodeId = currentScene?.nodes.find((n) => state.selection.has(n.id))?.id;
    } else if (state.mode === "tb") {
      nodeId = currentTbScene?.nodes.find((n) => state.selection.has(n.id))?.id;
      if (!nodeId && key === "h") {
        nodeId = currentTbScene?.boundary.find((b) =>
          state.selection.has(b.id)
        )?.id;
      }
    }
    if (nodeId) {
      toggleFlip(nodeId, key);
    }
  }
});

// --------------------------------------------- meniu contextual (vederea TB)

interface CtxItem {
  label: string;
  action: () => void;
  /** actiune distructiva (stergere): se coloreaza ca atare */
  danger?: boolean;
}

let ctxMenu: HTMLElement | null = null;

function closeCtxMenu(): void {
  ctxMenu?.remove();
  ctxMenu = null;
}

/** deschide meniul la (x,y) — pozitie `fixed`, incadrata in fereastra */
function openCtxMenu(x: number, y: number, items: CtxItem[]): void {
  closeCtxMenu();
  if (!items.length) {
    return;
  }
  const m = h("div", "ctxmenu");
  for (const it of items) {
    const b = h("button", `ctxitem${it.danger ? " danger" : ""}`, it.label);
    b.addEventListener("click", () => {
      closeCtxMenu();
      it.action();
    });
    m.append(b);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  ctxMenu = m;
}

/**
 * Clic-dreapta in vederile RTL (simbol/schema, docs/05): „Go to source" pe
 * orice tinta cu sursa cunoscuta (aceeasi rezolutie de proprietar ca la
 * dublu-click), plus navigare/pliaj/rasturnare pe blocuri. Pe fundal si pe
 * tintele fara actiuni (pinii pliajelor) ramane meniul nativ.
 */
function rtlContextMenu(e: MouseEvent): void {
  const t = e.target as Element;
  const openSrc = (args: Record<string, unknown>): void =>
    post({ v: 1, type: "action/request", action: "openSource", args });
  const items: CtxItem[] = [];
  let selectId: string | null = null;

  const pin = t.closest<SVGElement>(".pin, .bport");
  const block = t.closest<SVGElement>(
    state.mode === "schematic" ? ".inode" : ".node"
  );
  if (pin) {
    const port = pin.dataset.port;
    const owner =
      state.mode === "schematic"
        ? pin.dataset.inst ?? (pin.dataset.bport ? state.viewId : undefined)
        : state.viewId;
    if (port && owner) {
      items.push({
        label: "Go to source",
        action: () => openSrc({ viewId: owner, port }),
      });
    }
    selectId = pin.dataset.id ?? null;
  } else if (block && state.mode === "schematic") {
    const id = block.dataset.id ?? "";
    selectId = id || null;
    const inst = block.dataset.inst;
    if (inst) {
      if (hasSchematic(state.model, inst)) {
        items.push({
          label: "Open schematic",
          action: () => navigateTo(inst, "schematic"),
        });
      }
      items.push({
        label: "Go to source",
        action: () => openSrc({ viewId: inst }),
      });
    } else if (id) {
      // pliaj: expandarea e actiunea lui naturala (ca dublu-click-ul)
      items.push({ label: "Expand group", action: () => toggleFold(id) });
      // membrii unui pliaj impart ACELASI modul (criteriul plierii, docs/05),
      // deci definitia se deschide prin primul membru: `g_ch[0..2].u_ch` ->
      // `g_ch[0].u_ch`. Doar cand id-ul se rezolva complet (fara `[*]` ramase
      // dintr-un generate multidimensional)
      const memberRel = id.replace(/\[(\d+)\.\.\d+\]/, "[$1]");
      if (state.viewId && !memberRel.includes("[*]") && memberRel !== id) {
        const member = `${state.viewId}.${memberRel}`;
        items.push({
          label: "Go to source",
          action: () => openSrc({ viewId: member }),
        });
      }
    }
    const fid = currentScene?.nodes.find((n) => n.id === id)?.foldId;
    if (fid) {
      items.push({ label: "Re-fold group", action: () => toggleFold(fid) });
    }
    if (id) {
      items.push(
        { label: "Flip horizontal (H)", action: () => toggleFlip(id, "h") },
        { label: "Flip vertical (V)", action: () => toggleFlip(id, "v") }
      );
    }
  } else if (block) {
    // vederea-simbol: blocul E modulul vederii
    const vid = state.viewId;
    if (vid) {
      items.push({
        label: "Go to source",
        action: () => openSrc({ viewId: vid }),
      });
    }
  }
  if (!items.length) {
    closeCtxMenu();
    return; // fundal / tinta fara actiuni: meniul nativ
  }
  e.preventDefault();
  if (selectId && !state.selection.has(selectId)) {
    state.selection = new Set([selectId]);
    applySelectionClasses();
    postSelection();
    renderInspector();
  }
  openCtxMenu(e.clientX, e.clientY, items);
}

// Clic-dreapta pe o componenta din vederea de verificare: Open / Flip / Delete.
// Actiunile sunt ACELEASI ca in inspector si pe tasta Delete — `tbDeleteTarget`
// ramane sursa unica de rezolutie id->nume, iar confirmarea modala e a host-ului.
canvas.addEventListener("contextmenu", (e) => {
  if (state.mode !== "tb") {
    rtlContextMenu(e); // vederile RTL: Go to source / Open / pliaj / flip
    return;
  }
  const el = (e.target as Element).closest<SVGElement>(".tbnode, .tb-bport");
  const id = el?.dataset.id;
  if (!el || !id) {
    closeCtxMenu();
    return; // pe fundal: meniul implicit
  }
  e.preventDefault();
  // conventia editoarelor: clic-dreapta pe un element din AFARA selectiei il
  // selecteaza; pe unul din selectie pastreaza selectia
  if (!state.selection.has(id)) {
    state.selection = new Set([id]);
    applySelectionClasses();
    postSelection();
    renderInspector();
  }
  const items: CtxItem[] = [];
  const node = currentTbScene?.nodes.find((n) => n.id === id);
  if (node) {
    const drill = node.drill;
    if (drill) {
      items.push({ label: "Open", action: () => tbOpen(drill) });
    }
    items.push(
      { label: "Flip horizontal (H)", action: () => toggleFlip(id, "h") },
      { label: "Flip vertical (V)", action: () => toggleFlip(id, "v") }
    );
    const dt = tbDeleteTarget(node);
    if (dt) {
      items.push({
        label: dt.label,
        danger: true,
        action: () =>
          postAction("deleteComponent", { kind: dt.kind, name: dt.name }),
      });
    }
    if (node.kind === "tbvsqr") {
      // vsqr agrega TOATE secventele: cate o intrare per secventa
      for (const v of state.config?.virtual_sequences ?? []) {
        const vn = v.name;
        if (vn) {
          items.push({
            label: `Delete ${vn}`,
            danger: true,
            action: () =>
              postAction("deleteComponent", { kind: "vseq", name: vn }),
          });
        }
      }
    } else if (node.kind === "tbprobe") {
      // idem pentru probe (nodul le agrega pe toate)
      for (const p of state.config?.probes ?? []) {
        const pn = p.name;
        if (pn) {
          items.push({
            label: `Delete ${pn}`,
            danger: true,
            action: () =>
              postAction("deleteComponent", { kind: "probe", name: pn }),
          });
        }
      }
    }
  } else {
    // steag de granita: doar rasturnarea LOCALA pe orizontala (V n-are sens)
    items.push({
      label: "Flip horizontal (H)",
      action: () => toggleFlip(id, "h"),
    });
  }
  openCtxMenu(e.clientX, e.clientY, items);
});

// inchiderea meniului: clic in afara (capture, ca sa preceada handlerele
// canvas-ului) si zoom; Escape e tratat in handler-ul de taste
window.addEventListener(
  "pointerdown",
  (e) => {
    if (ctxMenu && !ctxMenu.contains(e.target as Node)) {
      closeCtxMenu();
    }
  },
  true
);
canvas.addEventListener("wheel", () => closeCtxMenu(), { passive: true });
// focusul iese din webview (clic in Design Hierarchy, editor, alta panela):
// evenimentele de pointer NU ajung la webview, deci `blur` e singura cale de
// a inchide meniul (altfel ramanea deschis peste noua selectie)
window.addEventListener("blur", closeCtxMenu);

// ------------------------------------------------------------- inspector

const inspector = document.getElementById("inspector") as HTMLElement;

function postAction(action: ActionKind, args: Record<string, unknown>): void {
  post({
    v: 1,
    type: "action/request",
    action,
    args: { viewId: state.viewId, ...args },
  });
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

function button(
  label: string,
  enabled: boolean,
  onClick: () => void,
  secondary = false,
  disabledHint?: string
): HTMLButtonElement {
  const b = h("button", `btn${secondary ? " secondary" : ""}`, label);
  b.disabled = !enabled;
  if (!enabled && disabledHint) {
    b.title = disabledHint; // motivul dezactivarii, vizibil la hover
  }
  b.addEventListener("click", onClick);
  return b;
}

/** un rand de proprietate in inspector: eticheta + control (select/input) */
function tbPropRow(label: string, control: HTMLElement): HTMLElement {
  const row = h("div", "prop-row");
  row.append(h("label", "prop-label", label), control);
  return row;
}

/**
 * Editorul de proprietati al unui scoreboard (felia 2): source/monitor/match/
 * match_key/max_latency, editare inline in inspector -> actiunea editScoreboard
 * (un WorkspaceEdit per schimbare; diagrama se re-randeaza la config/full).
 * Camp gol = reset la implicit (host-ul sterge campul din YAML).
 */
function tbScoreboardEditor(sb: QuvmScoreboard): void {
  const name = sb.name;
  if (!name) {
    return; // fara nume nu-l putem identifica pentru editare
  }
  const agents = (state.config?.agents ?? [])
    .map((a) => a.name)
    .filter((n): n is string => Boolean(n));
  const send = (field: string, value: string): void =>
    postAction("editScoreboard", { name, field, value });

  inspector.append(h("h3", "", "Scoreboard properties"));

  const srcSel = h("select", "prop");
  for (const a of agents) {
    // sursa difera de monitor (A2), ca la add — dar pastreaza sursa curenta
    // vizibila chiar daca un config scris de mana are source==monitor
    if (a === sb.monitor && a !== sb.source) {
      continue;
    }
    const o = h("option", "", a);
    o.value = a;
    o.selected = a === sb.source;
    srcSel.append(o);
  }
  srcSel.addEventListener("change", () => send("source", srcSel.value));
  inspector.append(tbPropRow("Source", srcSel));

  const monSel = h("select", "prop");
  const none = h("option", "", "None (single-stream)");
  none.value = "";
  none.selected = !sb.monitor;
  monSel.append(none);
  for (const a of agents) {
    if (a === sb.source) {
      continue; // monitorul difera de sursa (A2 two-stream)
    }
    const o = h("option", "", a);
    o.value = a;
    o.selected = a === sb.monitor;
    monSel.append(o);
  }
  monSel.addEventListener("change", () => send("monitor", monSel.value));
  inspector.append(tbPropRow("Monitor", monSel));

  const matchSel = h("select", "prop");
  for (const [v, lbl] of [
    ["in_order", "In order"],
    ["out_of_order", "Out of order"],
  ] as const) {
    const o = h("option", "", lbl);
    o.value = v;
    o.selected = (sb.match ?? "in_order") === v;
    matchSel.append(o);
  }
  matchSel.disabled = !sb.monitor; // match are sens doar two-stream
  matchSel.addEventListener("change", () => send("match", matchSel.value));
  inspector.append(tbPropRow("Match", matchSel));

  const keyIn = h("input", "prop");
  keyIn.value = sb.match_key ?? "";
  keyIn.placeholder = "key field";
  keyIn.disabled = sb.match !== "out_of_order"; // ceruta doar out-of-order
  keyIn.addEventListener("change", () => send("match_key", keyIn.value));
  inspector.append(tbPropRow("Match key", keyIn));

  const latIn = h("input", "prop");
  latIn.type = "number";
  latIn.min = "0";
  latIn.value = sb.max_latency != null ? String(sb.max_latency) : "";
  latIn.placeholder = "unbounded";
  latIn.addEventListener("change", () => send("max_latency", latIn.value));
  inspector.append(tbPropRow("Max latency", latIn));
}

/**
 * Componenta ștergibilă a unui nod TB selectat: `{kind, name, label}` sau null.
 * Sursă unică de adevăr pentru butonul Delete din inspector ȘI pentru tasta
 * Delete — ca rezoluția id→nume să nu poată devia între ele. Întoarce null
 * pentru ce NU se șterge printr-un gest unic: `tbvsqr` (agregă toate
 * secvențele → ștergere per-secvență în inspector), DUT/Env/unit/subenv/probe
 * și scoreboard-urile cross-bloc `xsb:` sau cele fără nume.
 */
function tbDeleteTarget(
  node: TbScene["nodes"][number]
): { kind: string; name: string; label: string } | null {
  if (node.kind === "tbsb" && node.id.startsWith("sb:")) {
    const sb = state.config?.analysis?.scoreboards?.find(
      (s) => (s.name ?? "sbd") === node.label
    );
    return sb?.name
      ? { kind: "scoreboard", name: sb.name, label: "Delete scoreboard" }
      : null;
  }
  if (node.kind === "tbcov") {
    const agent = node.id.startsWith("cov:")
      ? node.id.slice(4)
      : node.label.replace(/_cov$/, "");
    return { kind: "coverage", name: agent, label: "Delete coverage" };
  }
  if (node.kind === "tbagent") {
    return { kind: "agent", name: node.label, label: "Delete agent…" };
  }
  return null;
}

function selectPins(names: string[]): void {
  state.selection = new Set(names.map((n) => `<port>.${n}`));
  applySelectionClasses();
  postSelection();
  renderInspector();
}

/** Inspectorul lateral: configuratie, DUT, agenti, acoperire, actiuni.
 *  Fara stare proprie: totul e derivat din model + overlay (invariantul 2). */
function renderInspector(): void {
  if (!inspector) {
    return;
  }
  inspector.replaceChildren();
  const inst = state.viewId ? findInstance(state.viewId) : undefined;
  const ov = state.overlay;
  const matches = Boolean(ov && inst && ov.dut === inst.module);
  const sel = [...state.selection];
  const selNames = sel.map((s) => s.replace(/^<port>\./, ""));
  // pinii selectabili pentru gesturile de agent: pinii simbolului SAU
  // steagurile granitei din vederea-schema — porturile modulului vederii,
  // cu aceleasi ID-uri stabile `<port>.x` (restrictia la simbol era
  // mostenire de faza 2, nu decizie de design)
  const byName = new Map<string, { name: string; iface: boolean }>(
    currentPins.map((p) => [p.name, p])
  );
  if (state.mode === "schematic" && currentScene) {
    for (const b of currentScene.boundary) {
      byName.set(b.name, b);
    }
  }
  const selPins = selNames
    .map((n) => byName.get(n))
    .filter((p): p is { name: string; iface: boolean } => Boolean(p));
  // pinii unui BLOC COPIL din schema = porturile modulului acelui bloc:
  // gestul de agent tinteste config-ul blocului (fluxul recursiv, docs/03).
  // Conditii: niciun pin de granita in selectie si toti pinii aceleiasi
  // instante (pliajele se exclud — n-au o singura instanta-tinta)
  let childAgent:
    | { viewId: string; pins: { port: string; iface: boolean }[] }
    | null = null;
  if (state.mode === "schematic" && currentScene && selPins.length === 0) {
    const owners = new Set<string>();
    const pins: { port: string; iface: boolean }[] = [];
    for (const id of sel) {
      for (const n of currentScene.nodes) {
        const p = n.pins.find((sp) => sp.id === id);
        if (p) {
          owners.add(n.instPath ?? `fold:${n.id}`);
          if (n.kind === "instance" && n.instPath) {
            pins.push({ port: p.port, iface: p.iface });
          }
        }
      }
    }
    const owner = [...owners];
    if (pins.length > 0 && owner.length === 1 && !owner[0].startsWith("fold:")) {
      childAgent = { viewId: owner[0], pins };
    }
  }
  const roles = matches && ov ? ov.roles : {};

  inspector.append(
    h("h3", "", "QuickUVM configuration"),
    h("div", "cfgpath",
      ov?.configPath ?? 'no configuration yet — "Set as DUT" creates one')
  );
  if (state.mode !== "tb" && tbAvailable()) {
    inspector.append(
      button("Open verification view", true, openTbView, true)
    );
  }

  if (ov?.dut) {
    inspector.append(h("h3", "", "DUT"), h("div", "", ov.dut));
    if (inst && ov.dut !== inst.module) {
      inspector.append(
        h("div", "note",
          `current view shows "${inst.module}" — the overlay only applies ` +
            "to the DUT's views")
      );
    }
  }

  if (ov && ov.agents.length) {
    inspector.append(h("h3", "", `Agents (${ov.agents.length})`));
    const ul = h("ul", "agents");
    for (const a of ov.agents) {
      const li = h("li", "");
      li.append(
        h("span", `swatch agent-c${a.color}`),
        h("span", "", ` ${a.name} `),
        h("span", "dim", `(${a.pins.length} pins)`)
      );
      li.title = a.pins.join(", ");
      li.addEventListener("click", () => selectPins(a.pins));
      ul.append(li);
    }
    inspector.append(ul);
  }

  if (matches && ov) {
    inspector.append(
      h("h3", "", "Coverage"),
      h("div", "", `${ov.coverage.mapped}/${ov.coverage.total} ports mapped`)
    );
    if (ov.coverage.unmapped.length) {
      inspector.append(h("div", "dim", "unmapped:"));
      const ul = h("ul", "unmapped");
      for (const n of ov.coverage.unmapped) {
        const li = h("li", "", n);
        li.addEventListener("click", () => selectPins([n]));
        ul.append(li);
      }
      inspector.append(ul);
    }
    if (ov.orphans.length) {
      inspector.append(
        h("h3", "", "Orphans in YAML"),
        h("div", "note", ov.orphans.join(", "))
      );
    }
  }

  if (state.mode === "tb") {
    const selNode = currentTbScene?.nodes.find((n) =>
      state.selection.has(n.id)
    );
    // agentul selectat preincarca sursa gesturilor de adaugare (docs/05)
    const selAgent = selNode?.kind === "tbagent" ? selNode.label : undefined;
    if (selNode) {
      inspector.append(
        h("h3", "", "Component"),
        h("div", "", selNode.label)
      );
      if (selNode.stereotype) {
        inspector.append(h("div", "dim", selNode.stereotype));
      }
      if (selNode.drill) {
        const target = selNode.drill;
        inspector.append(
          button("Open (double-click)", true, () => tbOpen(target), true)
        );
      }
      // rasturnare (docs/04): H = laturile porturilor vest<->est, V = ordinea
      inspector.append(
        button("Flip horizontal (H)", true, () => toggleFlip(selNode.id, "h"), true),
        button("Flip vertical (V)", true, () => toggleFlip(selNode.id, "v"), true)
      );
      // editare + stergere per tipul componentei (felia 2). Scoreboard/coverage/
      // vseq sunt frunze; agentul cade in cascada (host: confirmare modala).
      const del = (kind: string, dname: string): void =>
        postAction("deleteComponent", { kind, name: dname });
      // editorul de proprietati (doar scoreboard-urile din `analysis`, id `sb:`;
      // NU cele cross-bloc `xsb:` = analysis.scoreboards cu capete calificate)
      if (selNode.kind === "tbsb" && selNode.id.startsWith("sb:")) {
        const sb = state.config?.analysis?.scoreboards?.find(
          (s) => (s.name ?? "sbd") === selNode.label
        );
        if (sb?.name) {
          tbScoreboardEditor(sb);
        }
      }
      // buton Delete — ACEEASI rezolvare id->nume ca tasta Delete pe diagrama
      // (tbDeleteTarget), ca sa nu poata devia una de alta
      const dt = tbDeleteTarget(selNode);
      if (dt) {
        inspector.append(button(dt.label, true, () => del(dt.kind, dt.name), true));
      }
      // vsqr / probes agrega TOATE intrarile lor: stergerea e per-intrare (tasta
      // Delete pe ele n-are tinta unica, deci butoanele raman singura cale aici)
      if (selNode.kind === "tbvsqr") {
        for (const v of state.config?.virtual_sequences ?? []) {
          const vn = v.name;
          if (vn) {
            inspector.append(
              button(`Delete ${vn}`, true, () => del("vseq", vn), true)
            );
          }
        }
      } else if (selNode.kind === "tbprobe") {
        for (const p of state.config?.probes ?? []) {
          const pn = p.name;
          if (pn) {
            inspector.append(
              button(`Delete ${pn}`, true, () => del("probe", pn), true)
            );
          }
        }
      }
    }
    // steag de granita selectat: rasturnare LOCALA pe orizontala (oglindeste
    // forma + muta ancora pe latura opusa a steagului, fara sa-i schimbe
    // pozitia/latura ELK). La un steag inout (hexagon) muta doar varful ancorat.
    const selB = !selNode
      ? currentTbScene?.boundary.find((b) => state.selection.has(b.id))
      : undefined;
    if (selB) {
      inspector.append(
        h("h3", "", "Boundary"),
        h("div", "", selB.label),
        h("div", "dim",
          selB.dir === "inout"
            ? "bidirectional interface"
            : selB.dir === "out"
              ? "output (to level above)"
              : "input (from level above)"),
        button("Flip horizontal (H)", true, () => toggleFlip(selB.id, "h"), true)
      );
    }
    // paleta de adaugare (felia 2, docs/05): conexiunile nu sunt muchii
    // libere in QuickUVM — sursa/monitor sunt campuri, deci "adauga" creeaza
    // componenta DEJA conectata (agentul selectat preincarca sursa)
    const hasAgents = Boolean(state.config?.agents?.length);
    const hasActive = Boolean(
      state.config?.agents?.some((a) => a.active !== false)
    );
    inspector.append(h("h3", "", "Add component"));
    inspector.append(
      button(
        selAgent ? `Coverage for ${selAgent}` : "Coverage collector",
        hasAgents,
        () => postAction("addCoverage", selAgent ? { agent: selAgent } : {}),
        true
      ),
      button(
        selAgent ? `Scoreboard from ${selAgent}` : "Scoreboard",
        hasAgents,
        () => postAction("addScoreboard", selAgent ? { source: selAgent } : {}),
        true
      ),
      button("Virtual sequence", hasActive,
        () => postAction("addVirtualSequence", {}), true)
    );
    inspector.append(h("h3", "", "Actions"));
    inspector.append(
      button("Generate testbench", Boolean(ov?.dut), () =>
        postAction("generate", {})
      )
    );
    return;
  }

  if (state.mode === "schematic" && state.model && state.viewId) {
    const nets = state.model.views[state.viewId]?.nets ?? [];
    // netul se selecteaza prin fir/eticheta (data-id = numele netului), DAR si
    // dintr-un pin/steag: la o selectie de UN pin ii derivam netul, ca sa fie
    // comutatorul fir/eticheta descoperibil de pe orice capat (observatie la
    // validare — B1)
    let selNet = nets.find((n) => state.selection.has(n.name));
    if (!selNet && state.selection.size === 1) {
      const nm = netOfPin([...state.selection][0]);
      selNet = nm ? nets.find((n) => n.name === nm) : undefined;
    }
    if (selNet) {
      const ov = sidecar.views[state.viewId]?.nets?.[selNet.name];
      const effective = ov?.render ?? selNet.render;
      inspector.append(
        h("h3", "", "Net"),
        h("div", "", selNet.name),
        h("div", "dim",
          `fan-out ${selNet.fanout} — shown as ${effective}` +
            (ov ? " (override)" : ""))
      );
      inspector.append(
        button(
          effective === "wire" ? "Show as label" : "Show as wire",
          true,
          () => toggleNetRender(selNet.name),
          true
        )
      );
      // proba whitebox (K2, felia 3): calea XMR si latimea se derivă din model
      // pe host (src/probe.ts) — webview-ul trimite doar (viewId, net). Host-ul
      // refuză cu motiv dacă netul nu e sondabil (unpacked, interfață, bench de
      // subsistem, port deja mapat pe agent).
      // `ov` e umbrit aici de override-ul de net: DUT-ul se ia din overlay
      inspector.append(
        button(
          "Create probe",
          Boolean(state.overlay?.dut),
          () => postAction("createProbe", { net: selNet.name }),
          true,
          "set the DUT first — a probe path is relative to the DUT instance"
        )
      );
    }
  }

  if (state.mode === "schematic" && currentScene) {
    const selNode = currentScene.nodes.find((n) => state.selection.has(n.id));
    if (selNode) {
      inspector.append(
        h("h3", "", "Selection"),
        h("div", "", selNode.name),
        h("div", "dim", selNode.sub)
      );
      inspector.append(
        button("Flip horizontal (H)", true,
          () => toggleFlip(selNode.id, "h"), true),
        button("Flip vertical (V)", true,
          () => toggleFlip(selNode.id, "v"), true)
      );
      if (selNode.kind === "fold") {
        inspector.append(
          h("div", "dim", `${selNode.foldCount} folded instances`),
          button("Expand fold", true, () => toggleFold(selNode.id), true)
        );
      } else if (selNode.instPath) {
        const p = selNode.instPath;
        if (hasSchematic(state.model, p)) {
          inspector.append(
            button("Open schematic", true,
              () => navigateTo(p, "schematic"), true)
          );
        }
        inspector.append(
          button("Open symbol", true, () => navigateTo(p, "symbol"), true),
          button("Go to source", true, () =>
            post({
              v: 1,
              type: "action/request",
              action: "openSource",
              args: { viewId: p },
            }), true)
        );
      }
    }
  }

  inspector.append(h("h3", "", "Actions"));
  // blocurile selectate in vederea-schema (instante si pliaje, nu interfete):
  // tinta actiunii "Create subenv" (docs/03)
  const selBlocks =
    state.mode === "schematic" && currentScene
      ? currentScene.nodes.filter(
          (n) => state.selection.has(n.id) && n.kind !== "iface"
        )
      : [];
  // gestul de agent: pinii granitei/simbolului tintesc modulul vederii;
  // pinii unui bloc copil tintesc modulul blocului (viewId explicit in
  // args); nepotrivirea de DUT se rezolva pe host, in flux — butoanele nu
  // mai stau moarte pe vederile ne-DUT
  const agentPins = selPins.length
    ? selPins.map((p) => ({ port: p.name, iface: p.iface }))
    : childAgent?.pins ?? [];
  const agentView = selPins.length ? state.viewId : childAgent?.viewId;
  const agentArgs = (extra: Record<string, unknown>) => ({
    viewId: agentView,
    ...extra,
  });
  const selectable = agentPins.filter((p) => !p.iface);
  const ifaceSel =
    agentPins.length === 1 && agentPins[0].iface ? agentPins[0] : undefined;
  // actiunile pe pini primesc DOAR pinii rezolvati — in schema, selectia
  // poate contine si blocuri/pliaje, care nu sunt porturi ale DUT-ului
  const pinIds = agentPins.map((p) => `<port>.${p.port}`);
  const allIgnored =
    selPins.length > 0 && selPins.every((p) => roles[p.name] === "ignored");
  inspector.append(
    button("Set as DUT", Boolean(inst), () => postAction("setDut", {})),
    button(
      `Agent from selection${selectable.length ? ` (${selectable.length})` : ""}`,
      selectable.length > 0,
      () => postAction("createAgentFromPins", agentArgs({ pins: pinIds }))
    ),
    button("Agent from interface", Boolean(ifaceSel), () =>
      postAction("createAgentFromIface", agentArgs({ port: ifaceSel?.port }))
    ),
    button(
      `Create subenv${selBlocks.length ? ` (${selBlocks.length})` : ""}`,
      // nepotrivirea de DUT se rezolva IN flux (config dedicat blocului,
      // docs/03) — butonul nu mai sta mort pe vederile ne-DUT
      selBlocks.length > 0,
      () => postAction("createSubenv", { nodes: selBlocks.map((n) => n.id) })
    ),
    // felia 3: compune blocul CURENT + fratii lui in bench-ul parinte imediat
    // (createSubenv initiat din copil). Doar cand vederea are un parinte (nu e
    // un modul top); host-ul calculeaza parintele + copiii-bloc directi
    button(
      "Compose into parent bench",
      Boolean(
        state.model && state.viewId && !state.model.tops.includes(state.viewId)
      ),
      () => postAction("composeIntoParent", {}),
      true,
      "open a non-top block — it gets composed into its immediate parent bench"
    ),
    // compunerea derivata (felia 3): scrie `connections` din net-urile inter-bloc
    // ale acestui subsistem. Doar pe vederea PROPRIE a DUT-ului (`matches`) — pe
    // alte vederi n-are sens; host-ul mai valideaza ca are subenvs
    button(
      "Wire connections from design",
      matches,
      () => postAction("wireConnections", {}),
      true,
      "open the schematic of the subsystem DUT — connections are derived for the composed blocks"
    ),
    allIgnored
      ? button("Un-ignore selection", true,
          () => postAction("unignorePort",
            { pins: selPins.map((p) => `<port>.${p.name}`) }), true)
      : button("Ignore selection", matches && selPins.length > 0,
          () => postAction("ignorePort",
            { pins: selPins.map((p) => `<port>.${p.name}`) }), true),
    button("Generate testbench", Boolean(ov?.dut), () =>
      postAction("generate", {})
    )
  );
}

// ---------------------------------------------------------------- randare

function showBanner(text: string): void {
  banner.textContent = text;
  banner.hidden = false;
}

function hideBanner(): void {
  banner.hidden = true;
}

async function render(refit = false): Promise<void> {
  if (state.mode === "tb") {
    return renderTb(refit);
  }
  if (!state.model || !state.viewId) {
    empty.hidden = false;
    renderInspector();
    return;
  }
  const inst = findInstance(state.viewId);
  const def = inst ? state.model.modules[inst.module] : undefined;
  if (!inst || !def) {
    showBanner(`Instance "${state.viewId}" no longer exists in the model.`);
    renderInspector();
    return;
  }
  empty.hidden = true;
  if (state.mode === "schematic" && !hasSchematic(state.model, state.viewId)) {
    // frunza fara schema: cade gratios pe simbol (docs/05)
    state.mode = "symbol";
    persistState();
  }
  renderHeader(inst);
  const gen = ++renderGen;
  if (state.mode === "schematic") {
    currentPins = [];
    const netsOv = sidecar.views[state.viewId]?.nets ?? {};
    const scene = buildSchematicScene(
      state.model,
      state.viewId,
      expandedFor(state.viewId),
      new Map(Object.entries(netsOv).map(([n, o]) => [n, o.render]))
    );
    if (!scene) {
      return;
    }
    if (!(await presentScene(scene, gen))) {
      return; // o randare mai noua a inceput intre timp
    }
  } else {
    currentScene = null;
    currentLayout = null;
    currentEdgesGroup = null;
    const pins = buildPins(def);
    currentPins = pins;
    const layout = await layoutSymbol(inst.module, pins);
    if (gen !== renderGen) {
      return;
    }
    draw(inst, pins, layout);
    const ctx = layout.children?.[0];
    contentBounds = {
      x: 0,
      y: 0,
      w: ctx?.width ?? 200,
      h: ctx?.height ?? 100,
    };
  }
  renderInspector();
  applyCameraAfterRender(refit);
}

/**
 * Pipeline-ul comun al vederilor cu noduri multiple (vederea-schema si
 * vederea de verificare): layout ELK cu semintele/rasturnarile din sidecar,
 * fortarea semintelor, lumea pe grila, pin-uirea D21 si desenul cu ruterul
 * propriu. Intoarce false daca o randare mai noua a inceput intre timp.
 */
interface Boxed {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * Cel mai apropiat loc liber pe grilă pentru `child`, evitând suprapunerea
 * (cu margine `pad`) cu celelalte noduri; `null` dacă deja e liber sau nu se
 * găsește în raza de căutare. Scanează pe cercuri de rază crescătoare,
 * preferând JOS (membrii unui pliaj se așază firesc în coloană sub poziția
 * inserată de ELK). Pur — doar aritmetică pe cutii.
 */
function freeSpot(
  child: Boxed,
  all: readonly Boxed[],
  pad: number
): { x: number; y: number } | null {
  const w = child.width ?? 0;
  const h = child.height ?? 0;
  const others = all.filter((c) => c !== child);
  const free = (x: number, y: number): boolean =>
    !others.some((o) => {
      const ox = o.x ?? 0;
      const oy = o.y ?? 0;
      const ow = o.width ?? 0;
      const oh = o.height ?? 0;
      return (
        x < ox + ow + pad &&
        x + w + pad > ox &&
        y < oy + oh + pad &&
        y + h + pad > oy
      );
    });
  const x0 = child.x ?? 0;
  const y0 = child.y ?? 0;
  if (free(x0, y0)) {
    return null;
  }
  for (let r = GRID; r <= 60 * GRID; r += GRID) {
    // ordinea preferă jos, apoi sus, apoi lateral/diagonale
    const cands: [number, number][] = [
      [x0, y0 + r], [x0, y0 - r], [x0 + r, y0], [x0 - r, y0],
      [x0 + r, y0 + r], [x0 - r, y0 + r], [x0 + r, y0 - r], [x0 - r, y0 - r],
    ];
    for (const [x, y] of cands) {
      if (free(x, y)) {
        return { x, y };
      }
    }
  }
  return null;
}

async function presentScene(
  scene: SchematicScene,
  gen: number
): Promise<boolean> {
  const viewId = state.viewId;
  if (!viewId) {
    return false;
  }
  // rasturnarile intra in geometria porturilor la layout (docs/04):
  // ELK ruteaza spre pozitiile deja rasturnate, deci traseele lui raman
  // valabile si pe noduri rasturnate
  const nodesOv = sidecar.views[viewId]?.nodes ?? {};
  const flips = new Map<string, Flip>(
    Object.entries(nodesOv)
      .filter(([, o]) => o.flipH || o.flipV)
      .map(([id, o]) => [id, { h: Boolean(o.flipH), v: Boolean(o.flipV) }])
  );
  // pozitiile detinute de utilizator devin seminte pentru ELK interactiv:
  // nodurile cunoscute raman pe loc, doar elementele noi primesc pozitii,
  // inserate in contextul celor existente (docs/04, invariantul 3)
  const seeds = new Map<string, { x: number; y: number }>();
  for (const [id, o] of Object.entries(nodesOv)) {
    if (o.x !== undefined && o.y !== undefined) {
      seeds.set(id, { x: o.x, y: o.y });
    }
  }
  const layout = await layoutSchematic(
    elk,
    scene,
    measurer(),
    flips,
    seeds.size ? seeds : undefined
  );
  if (gen !== renderGen) {
    return false;
  }
  currentScene = scene;
  currentLayout = layout;
  // selectia ceruta de host (select/reveal) poate referi membri de generate
  // PLIATI (rel-uri care nu exista in DOM): remapare pe scena curenta
  // (rel -> pliajul prin memberPaths; pur, locmap.ts), cu ecou spre host —
  // altfel „Reveal in Diagram" naviga corect dar selecta nimic
  if (state.selection.size) {
    const remapped = remapSelection(
      [...state.selection],
      state.viewId ?? "",
      scene.nodes.map((n) => ({
        id: n.id,
        instPath: n.instPath,
        module: "",
        memberPaths: n.memberPaths,
      }))
    );
    if (
      remapped.length !== state.selection.size ||
      remapped.some((id) => !state.selection.has(id))
    ) {
      state.selection = new Set(remapped);
      postSelection();
      renderInspector();
    }
  }
  // semintele se forteaza exact (ELK interactiv le poate deplasa usor);
  // cu orice override de pozitie, traseele ELK nu mai sunt valabile ->
  // re-rutare naiva
  for (const child of layout.children ?? []) {
    const s = seeds.get(child.id);
    if (s) {
      child.x = s.x;
      child.y = s.y;
    }
  }
  // lumea pe grila e universala (docs/04): TOATE pozitiile se rotunjesc
  // la grila, in orice vedere — ancorele cad pe randuri de grila (ruterul
  // scoate trasee integral ortogonale) si alinierea pin-la-pin e mereu
  // posibila; pozitiile ELK sunt fractionare, saltul e sub o jumatate
  // de pas
  for (const child of layout.children ?? []) {
    child.x = Math.round((child.x ?? 0) / GRID) * GRID;
    child.y = Math.round((child.y ?? 0) / GRID) * GRID;
  }
  // vedere aranjata (are seminte): elementele FARA samanta — noi din
  // recompilare, membri de pliaj proaspat expandati sau ramase dintr-un
  // sidecar partial — se pin-uiesc acum, ca semintele sa ramana totale si
  // nicio randare viitoare sa nu le mai poata muta (docs/04); vederile
  // neatinse (fara seminte) raman complet automate, nu se persista nimic
  if (seeds.size) {
    const children = layout.children ?? [];
    // nudge anti-suprapunere: pe o vedere aranjata, D21 pinuieste TOTI vecinii,
    // deci ELK interactiv nu-i poate impinge sa faca loc — membrii unui pliaj
    // proaspat expandat (elemente FARA samanta) pot ateriza peste noduri
    // pinuite. Ii mutam pe cel mai apropiat loc liber pe grila, fara sa atingem
    // blocurile utilizatorului (observatie la validare); vederea proaspata
    // (fara seminte) trece prin ELK complet, deci nu are nevoie de nudge
    for (const child of children) {
      if (seeds.has(child.id)) {
        continue; // element pinuit al utilizatorului: nu se misca
      }
      const spot = freeSpot(child, children, 24);
      if (spot) {
        child.x = spot.x;
        child.y = spot.y;
      }
    }
    const fresh: Record<string, { x: number; y: number }> = {};
    for (const child of children) {
      if (!seeds.has(child.id)) {
        const x = child.x ?? 0;
        const y = child.y ?? 0;
        const n = sidecarNode(viewId, child.id);
        n.x = x;
        n.y = y;
        fresh[child.id] = { x, y };
      }
    }
    if (Object.keys(fresh).length) {
      post({
        v: 1, type: "layout/snapshot", viewId, nodes: fresh,
      });
    }
  }
  const vp = resetCanvas();
  currentEdgesGroup = drawSchematic(
    scene, layout, vp, { onToggleFold: toggleFold }
  );
  // centrare fina a semnelor {}/[] in chip-uri: imediat, apoi re-aplicata pe
  // cadrul urmator si dupa incarcarea fontului editorului — in webview primul
  // getBBox poate rula inainte ca fontul sa fie aplicat, lasand semnul descentrat
  centerChipSigns(vp);
  requestAnimationFrame(() => centerChipSigns(canvas));
  if (document.fonts?.ready) {
    void document.fonts.ready.then(() => centerChipSigns(canvas)).catch(() => {});
  }
  applySelectionClasses();
  applyStatusBadges();
  contentBounds = layoutBounds(layout);
  refreshMinimap();
  return true;
}

/** camera de dupa randare: cea de sesiune a vederii sau incadrare automata */
function applyCameraAfterRender(refit: boolean): void {
  const camKey = layoutKey();
  if (!camKey) {
    return;
  }
  if (refit || state.k === 1) {
    // camera de sesiune a vederii are prioritate; altfel incadrare
    // automata. Camera e center-based: cx/cy = centrul vizibil in
    // coordonatele diagramei — robust la redimensionarea panoului.
    const cam = sessionCameras.get(camKey);
    if (cam) {
      const vw = canvas.clientWidth || 800;
      const vh = canvas.clientHeight || 600;
      const tx = vw / 2 - cam.cx * cam.zoom;
      const ty = vh / 2 - cam.cy * cam.zoom;
      // plasa de siguranta: o camera care ar lasa continutul complet in
      // afara ferestrei (date corupte, continut mutat radical) se ignora
      const bx = contentBounds.x * cam.zoom + tx;
      const by = contentBounds.y * cam.zoom + ty;
      const visible =
        bx < vw &&
        bx + contentBounds.w * cam.zoom > 0 &&
        by < vh &&
        by + contentBounds.h * cam.zoom > 0;
      if (visible) {
        state.k = cam.zoom;
        state.tx = tx;
        state.ty = ty;
        lastVW = vw;
        lastVH = vh;
        autoCam = false;
        applyTransform();
      } else {
        fit(contentBounds);
      }
    } else {
      fit(contentBounds);
    }
  } else {
    applyTransform();
  }
}

/**
 * Vederea de verificare (faza 3b felia 1, docs/05): scena TB pura din
 * configuratia QuickUVM + acelasi pipeline de layout/rutare/pozitii ca
 * vederea-schema; cheia vederii e `tb:<cale-config>`, pozitiile traiesc in
 * sidecar sub ea, cu toata mecanica D21.
 */
async function renderTb(refit: boolean): Promise<void> {
  if (state.viewId && !state.viewId.startsWith("tb:")) {
    // desincronizare mod/cheie (nu ar trebui sa se intample): vederea RTL
    // are prioritate, nu desenam scena TB sub cheia ei
    state.mode = "symbol";
    persistState();
    return render(true);
  }
  if (!state.viewId || !state.config) {
    empty.hidden = false;
    renderInspector();
    return;
  }
  empty.hidden = true;
  const gen = ++renderGen;
  currentPins = [];
  // nivelul curent (D24): "" testbench, "env", "agent:X". La un focus
  // inexistent (config schimbat), cade pe radacina.
  let scene = buildTbScene(state.config, state.tbFocus, state.configPath);
  if (!scene && state.tbFocus !== "") {
    // nivelul focus a disparut (config schimbat): cade pe radacina si
    // anunta host-ul, ca reveal-ul din arbore sa nu ramana pe nivelul vechi
    state.tbFocus = "";
    post({ v: 1, type: "tb/focus", focus: "", select: null });
    scene = buildTbScene(state.config, "", state.configPath);
  }
  if (!scene) {
    currentScene = null;
    currentLayout = null;
    currentEdgesGroup = null;
    currentTbScene = null;
    currentTbLayout = null;
    renderTbHeader(null);
    resetCanvas();
    showBanner(
      'The QuickUVM configuration has nothing to draw yet — use "Set as DUT" first.'
    );
    renderInspector();
    return;
  }
  renderTbHeader(scene);
  hideBanner();
  // pozitiile detinute de utilizator (per nivel) devin seminte pentru ELK
  // interactiv (docs/04, aceeasi mecanica D21 ca vederea-schema RTL)
  const key = layoutKey();
  const nodesOv = (key && sidecar.views[key]?.nodes) || {};
  const seeds = new Map<string, { x: number; y: number }>();
  for (const [id, o] of Object.entries(nodesOv)) {
    if (o.x !== undefined && o.y !== undefined) {
      seeds.set(id, { x: o.x, y: o.y });
    }
  }
  // rasturnarile detinute de utilizator (H = laturi, V = ordine), ca la RTL
  const flips = new Map<string, Flip>(
    Object.entries(nodesOv)
      .filter(([, o]) => o.flipH || o.flipV)
      .map(([id, o]) => [id, { h: Boolean(o.flipH), v: Boolean(o.flipV) }])
  );
  // ELK poate arunca la configuratii invalide (ex. un layerConstraint
  // FIRST/LAST_SEPARATE incompatibil cu directia muchiei): prindem eroarea ca
  // randarea sa nu esueze TACIT (diagrama ar ramane inghetata pe starea veche,
  // fara nicio explicatie — regresie reala prinsa la flip pe steag)
  let layout: TbLayout;
  try {
    layout = await layoutTb(
      elk,
      scene,
      measurer(),
      seeds.size ? seeds : undefined,
      flips.size ? flips : undefined
    );
  } catch {
    if (gen !== renderGen) {
      return;
    }
    showBanner("Could not lay out the verification view for this configuration.");
    return;
  }
  if (gen !== renderGen) {
    return; // o randare mai noua a inceput intre timp
  }
  // semintele se forteaza exact (ELK interactiv le poate deplasa usor);
  // porturile sunt relative, deci ancorele urmeaza pozitia fortata
  for (const [id, s] of seeds) {
    const n = layout.nodes.get(id);
    if (n) {
      n.x = s.x;
      n.y = s.y;
    }
    const b = layout.boundary.get(id);
    if (b) {
      b.x = s.x;
      b.y = s.y;
    }
  }
  // lumea pe grila e universala (docs/04): TOATE pozitiile se rotunjesc la
  // grila, in orice vedere (ca presentScene) — o samanta externa/corupta
  // off-grid nu produce fire strambe, iar D21 pin-uieste tot pe grila
  for (const p of layout.nodes.values()) {
    p.x = Math.round(p.x / GRID) * GRID;
    p.y = Math.round(p.y / GRID) * GRID;
  }
  for (const p of layout.boundary.values()) {
    p.x = Math.round(p.x / GRID) * GRID;
    p.y = Math.round(p.y / GRID) * GRID;
  }
  // D21: intr-o vedere aranjata (are seminte), elementele FARA samanta —
  // noi din editarea config-ului, ramase dintr-un sidecar partial — se
  // pin-uiesc acum, ca semintele sa ramana totale (docs/04)
  if (seeds.size && key) {
    const fresh: Record<string, { x: number; y: number }> = {};
    const pin = (id: string, x: number, y: number): void => {
      if (!seeds.has(id)) {
        const nn = sidecarNode(key, id);
        nn.x = x;
        nn.y = y;
        fresh[id] = { x, y };
      }
    };
    for (const [id, p] of layout.nodes) {
      pin(id, p.x, p.y);
    }
    for (const [id, p] of layout.boundary) {
      pin(id, p.x, p.y);
    }
    if (Object.keys(fresh).length) {
      post({ v: 1, type: "layout/snapshot", viewId: key, nodes: fresh });
    }
  }
  currentScene = null;
  currentLayout = null;
  currentEdgesGroup = null;
  currentTbScene = scene;
  currentTbLayout = layout;
  const vp = resetCanvas();
  currentTbEdgesGroup = drawTb(scene, layout, vp);
  applySelectionClasses();
  contentBounds = tbBounds(layout);
  applyStatusBadges();
  refreshMinimap();
  renderInspector();
  applyCameraAfterRender(refit);
}

/** navigare pe niveluri in vederea de verificare (drill / breadcrumb, D24) */
function tbNavigate(focus: string, select: string | null = null): void {
  state.tbFocus = focus;
  state.selection = new Set(select ? [select] : []);
  post({ v: 1, type: "tb/focus", focus, select });
  void render(true);
}

/** deschide tinta unui drill TB: nivel LOCAL (tb/focus) sau, cu prefixul
 *  `config:<subenv>`, config-ul blocului compus — host-ul il deschide cu
 *  editorul implicit, adica diagrama TB per-fisier (felia 4, docs/05) */
function tbOpen(drill: string): void {
  if (drill.startsWith("config:")) {
    // `config:<cale>` — chiar calea config-ului copil (poate contine `:` pe
    // Windows: `config:C:/x.yaml`); taiem DOAR primul prefix
    post({
      v: 1,
      type: "action/request",
      action: "openSubenvConfig",
      args: { config: drill.slice("config:".length) },
    });
    return;
  }
  tbNavigate(drill);
}

/** antetul vederii de verificare: breadcrumb pe niveluri + intoarcere RTL */
function renderTbHeader(scene: TbScene | null): void {
  head.replaceChildren();
  const crumbs = h("span", "crumbs");
  const trail = scene?.breadcrumb ?? [
    { label: state.configPath ?? "Testbench", focus: "" },
  ];
  trail.forEach((c, i) => {
    if (i) {
      crumbs.append(h("span", "sep", "›"));
    }
    if (i < trail.length - 1) {
      const a = h("span", "seg link", c.label);
      a.addEventListener("click", () => tbNavigate(c.focus));
      crumbs.append(a);
    } else {
      crumbs.append(h("span", "seg", c.label));
    }
  });
  head.append(crumbs);
  const tgl = h("span", "mode-toggle");
  if (state.model) {
    // un singur buton de intoarcere la design (D24: fara Symbol/Schematic)
    const back = h("button", "mbtn", "Design");
    back.title = "Back to the design views";
    back.addEventListener("click", () => leaveTbView());
    tgl.append(back);
  }
  const tb = h("button", "mbtn active", "Testbench");
  tgl.append(tb);
  const fitBtn = h("button", "mbtn", "⛶");
  fitBtn.title = "Fit to window (F)";
  fitBtn.addEventListener("click", fitView);
  tgl.append(fitBtn);
  // Re-aranjeaza tot (docs/04): sterge pozitiile nivelului si revine la ELK
  const rl = h("button", "mbtn", "⟲");
  rl.title = "Re-arrange all (discards node positions)";
  rl.addEventListener("click", relayoutAll);
  tgl.append(rl);
  const ex = h("button", "mbtn", "⤓");
  ex.title = "Export view as SVG";
  ex.addEventListener("click", exportSvg);
  tgl.append(ex);
  head.append(tgl);
  updateGenChip(); // cipul de stare generate (docs/05)
}

post({ v: 1, type: "ready" });
