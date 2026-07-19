// Protocolul de mesaje extensie <-> webview, versionat (v: 1).
// Sursa de adevar a formei mesajelor: docs/05-ui-si-protocol.md — orice
// mesaj nou se adauga INTAI acolo, apoi aici. Fisierul e partajat de host
// (src/) si de webview (src/webview/), deci nu importa nimic din `vscode`.
//
// Starea contractului (fazele 0-3b incheiate): toate mesajele si actiunile
// de mai jos sunt implementate si tipizate strict, cu DOUA exceptii declarate
// ca sa fixeze contractul dar inca netratate — rezervate override-urilor de
// nivel 2/3 din faza 4 (docs/04): `ports/reordered` (ordinea pinilor) si
// `edge/override` (waypoints; payload `unknown`, se rafineaza la
// implementare, D7: doar la cerere demonstrata).

import type { ProjectModel } from "./model";

export const PROTOCOL_VERSION = 1 as const;

export type Side = "north" | "south" | "east" | "west";

/** modul de afisare al unei vederi RTL (docs/05): simbolul sau schema */
import type { QuvmConfig } from "./quickuvm";

/** "tb" = vederea de verificare (faza 3b, docs/05), cheia `tb:<cale-config>` */
export type ViewMode = "symbol" | "schematic" | "tb";

/** semantica lasso-ului (docs/05): doar obiectele complet cuprinse
 *  ("window selection", implicit) sau si cele atinse ("crossing") */
export type LassoMode = "contain" | "intersect";

/** preferintele UI din setarile extensiei (mesajul ui/config) */
export interface UiConfig {
  lasso: LassoMode;
  /** vocabularul de desen (slash+latime pe buse, junction dots) e vizibil;
   *  false = ascuns (setarea quickuvm.schematicDecorations, docs/04) */
  decorations: boolean;
}

/** Actiuni cerute de webview care ating YAML-ul sau sursele (doc. 05). */
export type ActionKind =
  | "setDut"
  | "createAgentFromPins"
  | "createAgentFromIface"
  | "createSubenv"
  | "ignorePort"
  | "unignorePort"
  | "generate"
  | "openSource"
  // vederea de verificare (faza 3b, felia 2): adaugarea de componente TB
  | "addScoreboard"
  | "addCoverage"
  | "addVirtualSequence"
  // felia 2: stergerea (cu confirmare/cascada) si editarea proprietatilor
  | "deleteComponent"
  | "editScoreboard"
  // felia 3: proba whitebox (K2) dintr-un net selectat in vederea-schema
  | "createProbe"
  // felia 3: compunerea derivata — connections H1 din net-urile vederii
  | "wireConnections"
  // felia 3: compune blocul curent + fratii lui in bench-ul parinte
  | "composeIntoParent"
  // drill in blocul compus: deschide config-ul subenv-ului cu editorul
  // implicit (diagrama TB per-fisier, felia 4)
  | "openSubenvConfig";

// ---------------------------------------------------- sidecar-ul de layout

/** pozitia (si starea de pliere/rasturnare) unui nod, detinuta de
 *  utilizator (docs/04); x/y pot lipsi la nodurile cu alte override-uri
 *  dar inca nemutate */
export interface SidecarNode {
  x?: number;
  y?: number;
  /** doar pentru pliaje generate; absent = implicit (pliat) */
  collapsed?: boolean;
  /** rasturnare orizontala: laturile vest<->est schimbate (docs/04) */
  flipH?: boolean;
  /** rasturnare verticala: ordinea pinilor inversata pe fiecare latura */
  flipV?: boolean;
}

// camera (pan/zoom) NU face parte din sidecar: e stare de sesiune a
// webview-ului (docs/04) — prima deschidere a unei vederi se incadreaza
// mereu; cadrul se pastreaza doar intre comutarile din aceeasi sesiune

export interface SidecarView {
  nodes?: Record<string, SidecarNode>;
  /** override-ul de nivel 4 (docs/04): fir <-> eticheta per net; absent =
   *  sugestia din model (render calculata din fan-out) */
  nets?: Record<string, { render: "wire" | "label" }>;
}

/** override orfan: cheia a disparut din model (invalidare gratioasa) */
export interface SidecarOrphan {
  view: string;
  node: string;
  value: SidecarNode | { render: "wire" | "label" };
  /** felul cheii orfane; absent = nod (compatibilitate) */
  kind?: "net";
  /** data ultimei vederi valide (ISO 8601) */
  lastSeen: string;
}

/** continutul fisierului sidecar (docs/04); doar override-uri, nimic derivat */
export interface SidecarData {
  schema_version: 1;
  views: Record<string, SidecarView>;
  orphans: SidecarOrphan[];
}

// ------------------------------------------------- overlay-ul de configurare

/** rolul unui port in overlay (in afara apartenentei la un agent) */
export type PortRole = "clock" | "reset" | "ignored";

/** numarul de culori (si forme) distincte pentru agenti in webview */
export const AGENT_PALETTE = 8;

export interface OverlayAgent {
  name: string;
  /** indexul culorii/formei in paleta webview-ului (mod AGENT_PALETTE) */
  color: number;
  /** numele porturilor DUT revendicate de agent */
  pins: string[];
}

export interface OverlayCoverage {
  total: number;
  mapped: number;
  unmapped: string[];
}

/** starea derivata din YAML-ul QuickUVM (mesajul overlay/config, doc. 05) */
export interface OverlayConfig {
  /** numele modulului DUT din YAML (dut.name) sau null fara configuratie */
  dut: string | null;
  /** calea fisierului de configuratie, pentru afisare in inspector */
  configPath: string | null;
  agents: OverlayAgent[];
  roles: Record<string, PortRole>;
  coverage: OverlayCoverage;
  /** porturi de agenti care nu mai exista in model (orfane, docs/03) */
  orphans: string[];
}

// ------------------------------------------------- cross-probing editor->diagrama

/** tinta cross-probing-ului editor->diagrama (docs/05, faza 4): elementul de
 *  sub cursorul din sursa SV. Instanta = calea elaborata (unic); portul e al
 *  DEFINITIEI modulului (toate instantele lui il poarta); modulul = antetul
 *  definitiei. Webview-ul mapeaza tinta pe id-urile vederii curente
 *  (`probeIds`, src/locmap.ts) */
export type XprobeTarget =
  | { kind: "instance"; path: string }
  | { kind: "port"; module: string; port: string }
  | { kind: "module"; module: string };

// ------------------------------------------------ decoratiile de stare quick-uvm

/** tinta SEMANTICA a unei decoratii de stare (docs/05, faza 4): webview-ul o
 *  mapeaza pe id-urile vederii curente (statusIdsRtl/statusIdsTb, src/status.ts).
 *  Mesajele sunt engleza — webview-ul e monolingv in MVP (D19). */
export type StatusDeco =
  | { scope: "port"; port: string; severity: StatusSeverity; message: string }
  | { scope: "agent"; agent: string; severity: StatusSeverity; message: string }
  | { scope: "env"; severity: StatusSeverity; message: string };

export type StatusSeverity = "error" | "warning";

/** rezultatul ultimului „Genereaza testbench" (null = niciodata rulat) */
export interface GenerateStatus {
  ok: boolean;
  code: number;
  /** primele linii ale erorii (Pydantic/CLI), pentru tooltip-ul cipului */
  detail: string;
  /** ISO 8601 — momentul rularii */
  at: string;
}

// ------------------------------------------------------------ host -> webview

export type HostMessage =
  | { v: 1; type: "model/full"; model: ProjectModel }
  | { v: 1; type: "model/stale"; errors: number }
  | { v: 1; type: "layout/full"; sidecar: SidecarData }
  | {
      v: 1;
      /** subsetul QuvmConfig parsat, pentru vederea de verificare (docs/05);
       *  trimis la ready si la orice schimbare a YAML-ului */
      type: "config/full";
      configPath: string | null;
      config: QuvmConfig;
    }
  | ({ v: 1; type: "overlay/config" } & OverlayConfig)
  | { v: 1; type: "view/show"; viewId: string; mode?: ViewMode }
  | ({ v: 1; type: "ui/config" } & UiConfig)
  | { v: 1; type: "select/reveal"; ids: string[] }
  // cross-probing editor->diagrama (docs/05): tinta de sub cursorul din sursa
  // SV; webview-ul aplica haloul .xprobe pe id-urile vederii curente, fara sa
  // atinga selectia; lista goala = stinge
  | { v: 1; type: "probe/highlight"; targets: XprobeTarget[] }
  // decoratiile de stare quick-uvm (docs/05): validarile model<->YAML ca
  // badge-uri pe elemente + rezultatul ultimului generate ca cip in antet;
  // decos gol = curata, generate null = niciodata rulat
  | {
      v: 1;
      type: "status/decorations";
      decos: StatusDeco[];
      generate: GenerateStatus | null;
    }
  // navigare pe niveluri in vederea de verificare (D24): deschide nivelul
  // `focus` si, optional, selecteaza blocul `select`
  | { v: 1; type: "tb/navigate"; focus: string; select?: string | null }
  // cere serializarea SVG a vederii curente (comanda quickuvm.exportSvg);
  // webview raspunde cu export/result
  | { v: 1; type: "export/request" }
  | { v: 1; type: "theme/changed" };

// ------------------------------------------------------------ webview -> host

export type WebviewMessage =
  | { v: 1; type: "ready" }
  | { v: 1; type: "select/changed"; ids: string[] }
  // mutarile punctuale de nod (`node/moved`) au fost RETRASE din contract:
  // D21 cere seminte totale, deci orice drag trimite `layout/snapshot`
  | {
      v: 1;
      type: "layout/snapshot";
      viewId: string;
      /** pozitiile intregii vederi, in bloc (docs/04: aranjamentul e al
       *  utilizatorului; fara seminte totale, ELK interactiv re-plaseaza
       *  elementele nepersistate altfel decat layout-ul complet) */
      nodes: Record<string, { x: number; y: number }>;
    }
  | {
      v: 1;
      type: "fold/toggled";
      viewId: string;
      foldId: string;
      collapsed: boolean;
    }
  | {
      v: 1;
      type: "node/flipped";
      viewId: string;
      nodeId: string;
      flipH: boolean;
      flipV: boolean;
    }
  | {
      v: 1;
      type: "ports/reordered";
      viewId: string;
      port: string;
      side: Side;
      order: number;
    }
  | { v: 1; type: "edge/override"; viewId: string; edgeId: string; patch: unknown }
  | { v: 1; type: "net/render"; viewId: string; net: string; render: "wire" | "label" }
  // SVG-ul AUTONOM al vederii (faza 4): stiluri inline-uite, viewBox pe
  // continut; host-ul arata save dialog si scrie fisierul
  | { v: 1; type: "export/result"; viewId: string; svg: string }
  // `mode` insoteste drill-ul ca host-ul sa distinga simbolul top-ului
  // (radacina „top module") de schema lui (nodul instantei) — aceeasi cale,
  // vederi diferite (docs/05)
  | { v: 1; type: "nav/drill"; instancePath: string; mode?: ViewMode }
  // webview a navigat local in vederea de verificare (drill/breadcrumb, D24):
  // host-ul evidentiaza nivelul/blocul in arborele de verificare
  | { v: 1; type: "tb/focus"; focus: string; select?: string | null }
  | {
      v: 1;
      type: "action/request";
      action: ActionKind;
      args: Record<string, unknown>;
    }
  | { v: 1; type: "relayout/request"; viewId: string; scope: "all" | "new" };
