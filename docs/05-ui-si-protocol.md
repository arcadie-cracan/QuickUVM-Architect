# 05 — Vederi, fluxuri UI și protocolul extensie↔webview

## Vederile

Extensia are trei vederi: două ale designului RTL (simbolul și schema,
descrise mai jos) și una a configurației de verificare (vederea de
verificare, faza 3b — vezi finalul secțiunii).

## Cele două vederi ale designului

Terminologie (decizia D18): vederile poartă numele consacrate EDA, în
engleză — **Symbol view** („vederea-simbol", istoric „vederea de context") și
**Schematic view** („vederea-schemă", istoric „vederea de interior"), ca în
Verdi/Vivado/DVT. Terminologia e adoptată integral: UI, protocol
(`ViewMode: symbol | schematic`), comenzi
(`quickuvm.openSymbolView`/`openSchematicView`), cod
(`src/webview/schematic.ts`) și documentație.

**Vederea-simbol (Symbol view)** — un modul ca dreptunghi cu pinii pe
laturi (intrări stânga, ieșiri dreapta, ceas/reset grupate stânga-jos). Este
vederea în care se face configurarea QuickUVM, pentru că unitatea de lucru
QuickUVM este exact aceasta: un DUT și porturile lui. Codare vizuală: lățimea pe pin
(`din[15:0]`, linie tăiată pentru bus), interfețele ca pini groși
(culoare + hașură — niciodată doar culoare, pentru accesibilitate), tablourile
unpacked cu multiplicitatea afișată separat de lățimea elementului.

**Vederea-schemă (Schematic view)** — instanțele unui modul și
interconectul; breadcrumb pentru urcare. Instanțele afișează parametrii efectivi (`chan #(W=16)`);
instanțele generate cu același modul+parametri se pliază implicit
(`ch[0..2]`), expandabile la cerere.

**Gestul de coborâre (uniform, după țintă, nu după vedere):** dublu-click pe
un bloc = „intră în el" — schema dacă instanța are una, iar la frunze
chiar sursa modulului (coborârea continuă natural în implementare); în
vederea-simbol, simbolul e blocul instanței curente, deci dublu-click
comută pe schema ei. `Ctrl`+dublu-click = sursa modulului, oriunde.
Dublu-click pe pin = declarația portului; pe un pliaj = expandare.

Level-of-detail: peste un prag de pini vizibili, grupurile cu prefix comun
(`axi_*`) devin pliabile automat.

**Vederea de verificare** (faza 3b, decizia D16) — diagrama mediului TB
derivată din YAML-ul QuickUVM. Felia 1 (read-only) e specificată aici;
editarea (paletă, conectare cu mouse-ul, ștergere cu confirmare) își adaugă
mesajele tot aici, la implementare.

- **Cheia vederii**: `tb:<cale-config relativă la workspace>` (ex.
  `tb:demo_top.quickuvm.yaml`); modul de afișare: `ViewMode: "tb"`.
  Pozițiile/răsturnările trăiesc în sidecar sub această cheie, cu toată
  mecanica existentă (drag, snapshot total D21, ⟲, ELK interactiv);
  invalidarea grațioasă NU atinge vederile `tb:` (cheile lor vin din YAML,
  nu din modelul RTL — validarea lor se adaugă odată cu editarea).
- **Model pe niveluri** (D24, revizuit iul. 2026): scena e **plată per
  nivel** (`src/webview/tbscene.ts` → `TbScene` cu `focus` + `breadcrumb`;
  layout+desen în `src/webview/tbschematic.ts`, izolat de vederea RTL).
  Fiecare bloc e o **cutie UML** (nume + stereotip `«active agent»` +
  compartimente text cu structura internă), interconectate, cu **steaguri
  de graniță** pentru conexiunile care traversează nivelul (ca `<port>` la
  RTL). Un bloc cu structură (`drill`) se deschide la **dublu-clic**,
  coborând un nivel. Nivelurile (`focus`): `""` testbench (DUT + Env), `env`
  (agenți, scoreboards, coverage, vsqr, subenvs, probes; granițe = interfața
  DUT), `agent:<nume>` (sequencer/driver/monitor cu interconexiuni; granițe
  = if/ap/sqr). Agentul activ arată sequencer+driver+monitor în
  compartimentul „components" și, la drill, blocurile lor reale conectate
  (sqr→sequencer→driver→if; if→monitor→ap); pasivul doar monitor. Subenv =
  cutie UML cu config/params (drill în alt config amânat).
- **Layout plat**: ELK layered (ca vederea-schemă), porturi FIXED_POS pe
  grilă, steaguri FIRST/LAST_SEPARATE, ruterul A* comun cu nodurile ca
  obstacole; pozițiile rotunjite la grila de 8. **Drag + poziții** ca
  vederea-schemă RTL, cheiate **per nivel** (`tb:<config>|<focus>` — id-urile
  nodurilor se repetă între niveluri de agent), cu semințe ELK interactive,
  D21 total (inclusiv steagurile) și buton ⟲; breadcrumb clicabil pentru
  urcare, butonul „Design" din header întoarce la vederile de design (RTL).
- **Navigare** (D24): webview → host `tb/focus {focus, select?}` (drill/
  breadcrumb local — host-ul ține nivelul curent și evidențiază în arborele
  de verificare); host → webview `tb/navigate {focus, select?}` (reveal din
  arbore: deschide nivelul + selectează). Sincronizarea diagramă↔arbore se
  face pe identitatea `<focus>|<bloc>` (arborele și scena împart nivelurile
  și id-urile).
- **Protocol**: host→webview `config/full {configPath, config, resolved?}` —
  subsetul QuvmConfig parsat (agents, analysis, virtual_sequences, probes,
  subenvs, connections, subenv_scoreboards), trimis la `ready` și la orice
  schimbare a YAML-ului (ca `overlay/config`); `view/show {viewId: "tb:…",
  mode: "tb"}`.
- **`resolved` — the effective topology** (Aug 2026): the output of `quick-uvm
  resolve` (>= 1.1.0), from which the view draws the **inferred** components
  (the ghosts — see docs/07). It travels on the SAME message as `config`, never
  on one of its own: a re-render landing between two messages would pair one
  bench's ghosts with another's configuration. Since it comes from a
  subprocess it is never awaited on the render path — the message carries
  whatever is cached (at most one edit behind), and a completed `resolve`
  re-posts `config/full` to every surface showing that config (panel, sidebar,
  and the per-file editor, which subscribes to `ResolveService.onDidChange`
  for its own uri). Absent (or `null`) on an older quick-uvm or for a
  configuration that does not resolve: then no ghost is drawn, never a broken
  diagram.
- **Editarea — adăugarea** (felia 2, iul. 2026): în QuickUVM conexiunile NU
  sunt muchii libere — `source`/`monitor` sunt câmpuri, deci „adaugă"
  creează componenta deja conectată. Paleta „Add component" din inspector
  (agentul selectat preîncarcă sursa) trimite `action/request` cu
  `addScoreboard {source?}`, `addCoverage {agent?}`, `addVirtualSequence`;
  host-ul completează prin QuickPick (source/monitor/match, agent, mod +
  agenți) și aplică mutația yamlops (`addScoreboard`/`addCoverage`/
  `addVirtualSequence`) ca `WorkspaceEdit`; `config/full` re-trimis
  re-randează diagrama.
- **Editarea — ștergerea și proprietățile** (felia 2, iul. 2026):
  `deleteComponent {kind, name}` (kind ∈ scoreboard | coverage | vseq |
  agent | probe) — trei căi spre același gest: butonul Delete din inspector,
  tasta `Delete`/`Backspace` pe componenta selectată și meniul contextual
  (clic-dreapta); host-ul confirmă **modal** (la agent, `detail` rezumă
  cascada) și aplică `removeScoreboard`/`removeCoverage`/
  `removeVirtualSequence`/`removeAgent`/`removeProbe`.
  `editScoreboard {name, field, value}` editează inline (un `WorkspaceEdit`
  per câmp) prin `setScoreboardField`.
- **Meniu contextual în vederile RTL** (din validarea quick wins, iul. 2026):
  clic-dreapta oferă acțiunile țintei — pe un **bloc copil** din schemă: „Open
  schematic" (doar dacă are schemă), „Go to source" (definiția modulului),
  „Flip horizontal/vertical"; pe un **pliaj**: „Expand group" + „Go to source"
  (membrii împart același modul — criteriul plierii — deci definiția se
  deschide prin primul membru, `g_ch[0..2].u_ch` → `g_ch[0].u_ch`; + Flip),
  iar pe un membru expandat „Re-fold group"; pe un **pin sau steag de graniță**: „Go
  to source" (declarația portului — aceeași rezoluție de proprietar ca la
  dublu-click); pe **blocul vederii-simbol**: „Go to source". Pe fundal și pe
  ținte fără acțiuni (pinii pliajelor) rămâne meniul nativ. Clic-dreapta pe un
  element din afara selecției îl selectează (convenția editoarelor, ca în TB);
  închideri: Escape, pointerdown în afară, zoom și **pierderea focusului
  webview-ului** (`blur` — clic în Design Hierarchy / editor nu produce
  pointerdown în iframe, deci `blur` e singura cale de a închide meniul).
- **The temporary wire** (docs/08 R10/R11, Oct 2026): a press on a port's
  hotspot starts a dashed orthogonal wire that follows the pointer; the DROP
  decides, and every rule of what a drop means lives in the pure module
  `src/webview/wiring.ts` (`wireOriginOf` / `wireTargets` / `wireChoices` /
  `wireChoicesOnCanvas` / `rtlWireChoices`, `npm run test:wiring`). Hotspots: in
  the TB view a transparent disc (`.tb-porthit`, `data-port` / `data-node`) at
  the tip of every TLM port of a non-ghost box; in the RTL views the `.pin`
  groups (the symbol's pins, a child block's pins in the schematic — NOT the
  boundary flags: a drag on a flag moves it, docs/04; not clock/reset/ignored
  pins, nor pins an agent already claims — port-claimed is an error — and, in
  the schematic, not the label inside the block, which keeps dragging the
  block). Drop on EMPTY canvas → a filtered menu at the drop point (R10): from an
  agent's `<ap>` → "Scoreboard fed by X" / "Coverage on X" — the latter only
  while X has no collector — (`addScoreboard {source}` / `addCoverage {agent}`;
  the webview keeps a `pendingDrop` and the next `renderTb` of the same layout
  key places the first node of that kind that was NOT in the scene before
  (ghosts excluded: a declared scoreboard may take a ghost's id) at the drop
  point, over any stale seed under the same id, then pins the whole view
  through `layout/snapshot` — total seeds, D21); from a scoreboard's `source` / `monitor` → the legal agents
  (`editScoreboard`); from a DUT pin → "Agent from pin X" / "Agent from the N
  selected pins" (`createAgentFromPins {pins, viewId}`; the selection travels
  only when the origin is part of it) / "Agent from interface X"
  (`createAgentFromIface`). Drop on a LEGAL target (R11) → ONE outcome applies
  directly, several open the menu: `<ap>` on a scoreboard box or input →
  `editScoreboard {name, field: source|monitor, value: agent}`; a scoreboard
  input on an agent → the same retarget; a DUT pin on a pin an agent already
  claims (the overlay colors it — the symbol view) → `addPinsToAgent {agent,
  pins, viewId}`. Legality is computed ONCE at the press and shown before the
  drop (`.drop-ok` / `.drop-bad` on boxes and hotspots, the reason as a hint
  under the pointer and as the toast of an illegal drop): already an endpoint,
  source ≠ monitor, an unnamed or duplicate-named scoreboard (endpoints are set
  BY NAME — the first entry of that name), a cross-block scoreboard (edit `<subenv>.<agent>` in Properties), a ghost
  (nothing in the YAML), a coverage collector (one agent each). The nearest
  legal hotspot within 20 px snaps. Escape, the webview's `blur` and a press
  outside the canvas cancel. TB only: a plain click on a hotspot ARMS
  click-click mode (the wire follows the pointer until the next press — R11's
  keyboard/touch fallback); in RTL a click on a pin keeps selecting it. NOT
  wired by the gesture yet: `connections` between subenvs (they need a host
  action with the children's widths — "Wire connections from design" stays in
  the inspector).
- **Designer assistance** (docs/08 R12, Oct 2026): a strip between the header
  and the canvas (`#assist`) lists the host's proposals (`proposals/full`) with
  checkboxes, "Apply" and "Dismiss" — never automatic (Vivado's Designer
  Assistance, SmartDesign's Auto Connect). Apply sends `applyProposals` with the
  checked rows; in the verification view the rows are the inferred ghosts and the
  button reads "Write analysis" — the checked ones are kept, the unchecked ones
  will no longer be generated (the strip says so). Dismiss hides THAT set for the
  view until the proposals change (session state, keyed by the set's signature;
  an applied set is treated the same, so a render before the host's next set does
  not re-show it). What the apply created is flashed once on the next render
  (`.flash`: the newly claimed pins in the symbol, the new boxes in the TB view —
  the ids drawn before the apply are remembered, the difference lights up).
- **In-place rename** (docs/08 R14, Oct 2026): F2 on the selected component,
  a double-click on the box's TITLE (the `.tb-name` text takes pointer events
  for this; the body still drills) or "Rename… (F2)" in the context menu opens
  an `<input>` over the SVG title — StarUML's Quick Edit, Blueprints' F2. Enter
  applies; a bad name (not an SV identifier, a keyword, a name an agent /
  scoreboard / subenv / probe already uses) is flagged live and keeps the
  editor; Escape cancels; leaving the field with a change applies. One resolver
  (`tbRenameTarget`, next to `tbDeleteTarget`) decides what can be renamed:
  agents, named scoreboards, subenvs — a ghost, an unnamed scoreboard and the
  derived names (coverage `<agent>_cov`, the aggregates) cannot; nor can a VIP
  reference (`from_vip` — its name is the manifest's) or a duplicate subenv
  name. A scoreboard is addressed by ORDINAL (`id: sb:x#2` travels with the
  action), so a duplicate renames its own entry. The webview sends
  `renameComponent {kind, name, newName, id?}` and, on the render that shows
  the new id, carries the sidecar positions of the renamed ids (`agent:` + its
  `cov:` and `<if>.` flag, `sb:`, `sub:`) and an agent's own level
  (`tb:<config>|agent:<name>`) to the new ids through `layout/snapshot` — the
  box keeps its seat — and moves the selection (deferred on purpose: a refused
  rename leaves no orphan entries). The host renames with the cascade
  (`renameAgent`: coverage bare or rich, scoreboard endpoints bare and
  `<agent>.<port>`, vseq steps, `tests[].sequence.agent`, `connections`
  endpoints of a boundary agent, `register_model.bus_agent`, the agent's own
  `<name>_if` / `<name>_seq_item` when conventional; `renameScoreboardAt`;
  `renameSubenv`: `connections` and cross-block endpoints) and reports the
  references updated.
- **Inline widgets on the boxes** (docs/08 R13, Oct 2026): the two or three
  facts a bench is tuned by sit ON the box, under its compartments, as pills
  (`TbNode.widgets`, built in `buildTbScene`; sized and drawn in
  `tbschematic.ts`): `active` / `passive` on an agent (a toggle), `match: …`
  (a cycle in_order ↔ out_of_order) and `latency: …` (a small number editor,
  empty = unbounded, at least 1 cycle — quick-uvm refuses 0) on a NAMED
  two-stream scoreboard — a single-stream entry has neither fact, an unnamed or
  duplicate-named one (`sb:x#2`) cannot be edited by name, a ghost has nothing
  in the YAML, a VIP reference (`from_vip`) takes no keys. The `match` pill
  shows the `match_key` with the mode and its tooltip says the step to in_order
  drops it (the `setScoreboardField` cascade). A bad number (a stray `e`, a
  fraction, 0) is flagged, keeps the editor on Enter and cancels on blur. A
  click sends the SAME host action the Properties panel would
  (`editAgent {name, field: active, value}` / `editScoreboard {name, field,
  value}`), so the panel and the box stay in sync through the YAML. The
  accidental-edit rule of the research: a widget takes pointer events only
  while its box is SELECTED (the first click selects, the second acts), the
  second click of a double-click is ignored (`e.detail > 1`) and a double-click
  on a widget does not drill. No protocol change.
- **"What will this generate"** (docs/08 R15, Oct 2026): a 450 ms dwell on a
  TB box opens a card beside it (`.gencard`, a DOM overlay; `I` on the selected
  box PINS it until Escape / `I` / a render): the element's own YAML entry
  (`<pre>`), its generation state as the badges say it (● new / U not generated /
  M modified / ✓ generated), the files it owns in the generated bench with their
  LIVE on-disk flags (✓ / ○; an agent's internal shows the agent's file of that
  part, a coverage box its `<agent>_cov.svh`, a level box the aggregates), and
  two actions — "Open generated code beside"
  (`openGeneratedCode {id, label}`; disabled while the manifest or the files are
  unknown) and "Show YAML beside" (`openConfigBeside {id}`). A ghost's card says
  it is inferred and asks nothing. The data is requested on demand
  (`card/request` → `card/full`, one per dwell) and cached until the YAML or the
  generation state changes; the host answers from the config text and the
  CACHED manifest — the generator is never run for a card. The card leaves with
  the pointer (onto the card itself it stays, for its buttons), on a press, on a
  wheel and on every render (it is anchored to a box that is redrawn).
- **Action palette** (docs/08 R17, Oct 2026): Ctrl+Space / Ctrl+/ (or the
  "Actions" header button) opens a palette — the find box's UI, `.findbox.palette`
  — of the actions that are LEGAL right now, recent ones first (GLSP's command
  palette, Figma's quick actions): the selected element's own actions (the
  context menu's items — `tbMenuItems` / `rtlMenuItemsFor`, the ONE list behind
  both surfaces —, the R1 "+" tools, the R13 widgets' steps, the R15 card), the
  Properties panel's ENABLED buttons (the panel is rendered into a detached
  element with every section open — `InspectorCtx.allOpen` — and its `button.btn`
  rows are collected under their heading, so the enabling rules stay in one
  place), the applicable assistance proposals (not the ghosts: those are
  all-or-nothing in the strip), and the view / config commands. Every row runs
  exactly what its surface would — the same host action, the same confirmations
  —; the palette adds no gesture of its own, and shows display names, never ids.
  Typing filters with the Ctrl+F ranking (`findMatches`); with no query the
  recent actions come first (`rankPalette` / `pushRecent` in `navfind.ts`,
  recency persisted in the webview state as `paletteRecent`). Enter runs,
  Escape closes, the arrows move. No protocol change.
- **Diff preview before a gesture** (docs/08 R19, Oct 2026): a DESTRUCTIVE
  gesture (`deleteComponent` with its cascade, the covergroup downgrade,
  `removeTest`, `removeRegisterModel`, the regression block while tests set
  `seeds`) and a MULTI-FILE gesture (`wireConnections`: the top's `connections`
  plus the children's agents set passive; `createSubenv` when it creates block
  configs) can be previewed as a diff before they are applied. The mutation runs
  on the target's current text first (`TbEditTarget.readText`), so what the
  preview shows is byte-for-byte what the WorkspaceEdit would write; the host
  opens one `vscode.diff` tab per changed file — the real document on the left
  (an unsaved buffer diffs against what the user sees), a virtual
  `quickuvm-preview:` document on the right, served by `PreviewProvider` in
  `src/previewdiff.ts`; a created file diffs against an empty virtual "before"
  —, then asks with a NON-modal notification (a modal would block the tabs)
  and closes the tabs whichever way the question is answered. The setting
  `quickuvm.previewEdits`: `ask` (default — the existing modal gains a "Preview
  changes" button; a multi-file gesture gets a modal with the per-file summary),
  `always` (the preview opens first), `never` (the modal as before; multi-file
  gestures apply directly). A single-file, non-destructive gesture is never
  previewed, and a multi-file gesture whose effect lands in ONE file stays
  immediate. The summary line (`top.quickuvm.yaml (+6 -0), chan.quickuvm.yaml
  (+1 -1)`) comes from the pure `src/preview.ts` (`test:preview`), measured on
  R4's minimal edit. No protocol change: the webview sends the same actions.
- **Proba whitebox** (felia 3, K2, iul. 2026): se selectează un **net** în
  vederea-schemă → butonul „Create probe" din secțiunea Net trimite
  `createProbe {net}` (`viewId` e injectat de `postAction`). Webview-ul NU
  calculează nimic: calea XMR (relativă la instanța DUT) și lățimea se derivă
  pe host din model, în modulul **pur** `src/probe.ts` (`proposeProbe`), care
  și refuză cu motiv explicit (bench de subsistem — H1, tablou unpacked,
  interfață, port deja mapat pe agent, vedere din afara DUT-ului). Host-ul
  cere numele (validat contra numelor rezervate: alte probe, porturi/interfețe
  de agent, ceas, reset) și opțional `coverage`, apoi aplică `addProbe`.
- **Compunerea derivată** (felia 3, iul. 2026): butonul „Wire connections from
  design" (Actions, la un subsistem) trimite `wireConnections {}`; host-ul
  derivă `connections: [{from, to}]` din net-urile inter-bloc ale vederii
  (modul pur `src/compose.ts`) și le scrie prin `addConnections`, avertizând
  care agenți-destinație trebuie făcuți pasivi (`active: false`). Gest separat
  de „Create subenv" fiindcă firele cablează porturi de interfață de agent
  (copiii trebuie să aibă agenți întâi).
- **Compose into parent bench** (felia 3, iul. 2026): butonul din Actions,
  vizibil pe orice bloc non-top, trimite `composeIntoParent {}`; host-ul află
  părintele-bench imediat + copiii-bloc direcți ai lui (`parentComposition` în
  `src/compose.ts`, pur) și deleagă la `createSubenv` țintind părintele
  (compune blocul + frații, cu confirmare în QuickPick). Un subsistem cere ≥2
  subenv-uri (constrângere quick-uvm), deci se refuză când părintele are un
  singur bloc componibil.
- **Drill în subenv** (închiderea loose-end-ului, iul. 2026): în vederea TB,
  un bloc `«subenv»` cu `config` cunoscut e drillabil (sufixul ⊟, cursorul de
  drill); dublu-clic / „Open" (meniu contextual sau inspector) trimite
  `openSubenvConfig {name}`, iar host-ul rezolvă `subenvs[].config` relativ la
  config-ul curent și **deschide fișierul copil cu editorul implicit** — adică
  diagrama TB a Feliei 4 (tab nou; înapoi = comutare de tab). Drill-ul rămâne
  în webview un string `config:<nume>` pe `TbNode.drill`, deosebit de
  focus-urile locale (`env`, `agent:X`) prin prefix; merge identic din panel
  (config-ul activ) și din editorul per-fișier (documentul deschis, nesting-ul
  H1 pe niveluri). Un subenv fără `config` rămâne frunză.
- **Puncte de intrare** (un gest care trebuie explicat e greșit proiectat):
  butonul **Testbench** din header-ul vederilor de design (vizibil când
  config-ul activ are ceva desenabil), butonul „Open
  verification view" din secțiunea de configurare a inspectorului, meniul de
  context al ierarhiei (grupul de configurare, lângă „Set as DUT") și
  comanda `quickuvm.openVerificationView` din paletă (toate deschid vederea
  config-ului activ — un singur bench — independent de instanța cu click).
- **Ierarhia verificării** (a doua secțiune din sidebar, „Verification
  Hierarchy", lângă „Design Hierarchy"): arborele mediului TB derivat din
  config (`src/tbtree-build.ts`, pur, testabil; ambalat de
  `src/tbtree.ts`), oglinda vederii-schemă TB — env → DUT, agenți
  (activ/pasiv cu iconuri distincte), scoreboards, coverage, virtual
  sequencer, subenvs, probe. Id-urile nodurilor arborelui coincid cu cele
  ale diagramei (ambele derivă din `buildTbScene`), deci navigarea e
  simetrică fără mapare: click pe nod → `quickuvm.revealTbComponent`
  deschide vederea TB și selectează componenta (mesajul `select/reveal`,
  aplicat după `view/show`); selecția în diagramă → `select/changed` →
  host-ul evidențiază nodul în arbore (`onSelection` dispecerizează pe
  prefixul `tb:`). Se populează din `config/full` (același semnal ca
  overlay-ul). Din vederea TB,
  butonul „Design" din header întoarce la ultima vedere de design vizitată
  (viewId + mod); navigarea locală se anunță host-ului prin `nav/drill` (titlul
  panoului rămâne sincron). Ambalajul final rămâne
  `CustomTextEditorProvider` pe `*.quickuvm.yaml` (D22).

## Fluxurile UI de configurare (rezumat; maparea exactă în doc. 03)

1. **Setează ca DUT** (context menu pe bloc, în arbore sau pe diagramă) →
   propuneri euristice ceas/reset/combinational ca chip-uri de confirmat.
2. **Creează agent din selecție** (lasso/Ctrl+click pe pini) → agentul
   primește o culoare; pinii lui o poartă permanent în overlay. Culoarea e
   dublată de un marcaj de formă pe pin (accesibilitate). Ținta gestului se
   deduce din pinii selectați: pinii vederii-simbol sau steagurile de
   graniță din schemă = porturile modulului vederii; **pinii unui bloc
   copil** din schemă = porturile modulului acelui bloc — agentul se
   creează pentru config-ul blocului (`viewId`-ul blocului călătorește în
   `action/request.args`, iar nepotrivirea/lipsa DUT-ului se rezolvă pe
   host, în flux, ca la subenv). Selecția mixtă (pini din blocuri diferite
   sau pini + graniță) dezactivează gestul; blocurile din selecție se
   ignoră.
3. **Creează agent din interfață** (click pe pinul de interfață — pe
   simbol, pe steagul de graniță sau pe pinul de interfață al unui bloc
   copil; aceeași deducere a țintei).
4. **Creează subenv** (butonul din inspector pe blocurile selectate în
   vederea-schemă — instanțe sau pliaje, desfăcute în membri — sau comanda
   `quickuvm.createSubenv` din paletă); confirmare multi-select cu rezumatul
   config-urilor de bloc noi și al constrângerilor H1 (docs/03).
5. **Indicatorul de acoperire** (permanent în inspector): "N/M porturi mapate",
   cu lista porturilor nemapate ca listă de bifat; stările per port:
   agent X / ceas-reset / ignorat explicit / nemapat.
6. **Generează testbench** → task `quick-uvm generate`; erori în Problems.

Distribuția nativ/webview: tree view, comenzi, QuickPick, diagnostice, task-uri
= nativ; diagramă + inspector de configurare = webview (panel unic cu inspector
lateral intern). `CustomEditor` pe `*.quickuvm.yaml` este ambalajul final al
vederii de verificare (faza 3b), nu punctul de pornire.

Toate acțiunile de configurare produc `WorkspaceEdit` pe YAML (sursa de
adevăr): undo/redo nativ, diff în git, editare manuală simultană. Sensul
invers: la modificarea YAML-ului (de mână sau de extensie), host-ul re-parsează
și retrimite overlay-ul.

## Protocolul de mesaje extensie↔webview

JSON, versionat (`v: 1`), tipat în TypeScript într-un singur fișier partajat
(`src/protocol.ts`). Orice mesaj nou se adaugă întâi aici și în acest document.

### host → webview

| type | payload | semnificație |
|---|---|---|
| `model/full` | `{model}` | model complet (prima încărcare / re-compilare) |
| `model/stale` | `{errors: n}` | compilare eșuată: păstrează modelul, arată banner |
| `layout/full` | `{sidecar}` | conținutul sidecar-ului (doc. 04): `{schema_version, views: {<viewId>: {nodes: {<nodeId>: {x?, y?, collapsed?, flipH?, flipV?}}}}, orphans[]}` — trimis la `ready` și la schimbările neinițiate de webview (editare externă a fișierului, invalidare grațioasă, curățarea orfanelor); gesturile proprii nu primesc ecou, webview-ul le-a aplicat deja local. Webview-ul aplică pozițiile ca override peste layoutul calculat |
| `overlay/config` | `{dut, configPath, agents[], roles{}, coverage, orphans[]}` | starea derivată din YAML: cine e DUT, culorile agenților, rolurile pinilor, acoperirea |
| `view/show` | `{viewId, mode?}` | navighează la vederea cerută (din tree view / editor); `mode` opțional (`symbol` \| `schematic`) — absent: webview-ul păstrează modul curent (implicit simbolul); `schematic` fără vedere în model cade grațios pe simbol |
| `select/reveal` | `{ids[]}` | evidențiază elemente (sincronizare dinspre editor) |
| `proposals/full` | `{viewId, mode, items[]}` | docs/08 R12 — the designer-assistance proposals of the view the host shows (`src/proposals.ts`, pure, `test:proposals`): `items[]` = `{id, kind, label, detail?, action, args}`, every one an existing host action with its arguments filled in. Kinds: `agent-iface` (a DUT interface port without an agent → `createAgentFromIface {port, name}`), `agent-group` (DUT pins sharing a prefix — the name up to its LAST underscore, a trailing direction token `_i/_o/_io/_in/_out/_n/_ni/_no` stripped first, so PULP `src_valid_i` joins `src` while `valid_i`/`valid_o` make no group — two or more, none claimed, no clock/reset/waived/ref/unsized/unpacked port → `createAgentFromPins {pins, name}`; a lone pin is never proposed, and an agent of the prefix's name that claims nothing makes the group ambiguous → no proposal, the SmartDesign rule), `connections` (a subsystem of ≥2 subenvs whose blocks the design wires but the YAML does not, and whose children already have agents — the wire cables agent ports; ambiguous subenv names or a derivation warning = no proposal → `wireConnections`, through the same `deriveConnections`), `materialize` (on an implicit-mode bench — no `analysis:` key — the components quick-uvm infers, one row per ghost of `src/resolved.ts`). Sent by the panel after `view/show`, `model/full`, `overlay/config`, `config/full` and the drill, and by the per-file editor with its `config/full` (ghosts only — it has no model); an empty list clears the strip. The webview shows the strip only while `viewId` matches the view it displays |
| `card/full` | `{id, yaml, files[], primary, manifest}` | docs/08 R15 — the answer to `card/request`: what a TB element will generate. `yaml` = the element's own entry, verbatim (the R4 map `elementRange` on the document text; null = no entry of its own), `files[]` = `{file, exists}` the element OWNS in the generated bench (the CACHED `quick-uvm manifest`, never a generator run; the aggregates are not listed), `primary` = the absolute path "Open generated code" opens (null = none yet), `manifest` = `ok` / `unavailable` (quick-uvm < 1.1.0, an invalid config — the card says "not resolved" instead of "no files") / `inactive` (the per-file editor's document is not the active config, whose manifest it is). The per-file editor answers from ITS document, with the files only when the document is the active config |
| `probe/highlight` | `{targets[]}` | cross-probing editor→diagramă (reciproca hover-ului, faza 4): host-ul urmărește cursorul din sursele SV (debounced) și trimite ținta de sub cursor — `{kind: "instance", path}` \| `{kind: "port", module, port}` \| `{kind: "module", module}`; mai multe ținte doar la instanțele generate de pe aceeași linie sursă. **docs/08 R4:** a fourth target kind, `{kind: "tb", id, focus}`, comes from the caret in a `*.quickuvm.yaml` TEXT editor (`elementAtOffset`, `src/yamlmap.ts`, pure, `test:yamlmap`): the verification view lights the box with that id when it is on the current level — panel and per-file editors alike — never navigating. The reverse (a selected box reveals and flashes its YAML entry in the text editors that already show the file) and the per-gesture flash of the changed lines (`onGestureApplied` in `src/config.ts`, from the MINIMAL edit of `src/textedit.ts`, `test:textedit`) are host-side and need no message; the `quickuvm.openYamlBeside` setting (ask once / always / never) decides whether a gesture opens the YAML beside the diagram when no text editor shows it. Webview-ul le mapează pe id-urile vederii CURENTE (`probeIds` în `src/locmap.ts`, pur) și aplică un **halou de cross-probing** (`.xprobe`) persistent, DISTINCT de selecție — selecția de lucru nu e atinsă. Ținta absentă din vederea curentă = niciun halou (non-invaziv, fără navigare); listă goală = stinge. Navigarea explicită e comanda `quickuvm.revealInDiagram` (meniul contextual al editorului), care folosește `view/show` + `select/reveal` |
| `ui/config` | `{lasso}` | preferințele UI din setările extensiei, trimise la `ready` și la schimbarea configurației; `lasso`: `contain` (implicit — lasso-ul selectează doar obiectele complet cuprinse, „window selection") \| `intersect` (și pe cele atinse, „crossing selection"; setarea `quickuvm.lassoMode`) |
| `export/request` | `{}` | cere serializarea SVG a vederii curente (comanda `quickuvm.exportSvg` din paletă); webview răspunde cu `export/result` |
| `theme/changed` | `{}` | re-citește variabilele CSS |
| `relay/flip` | `{nodeId, axis: "h"\|"v"}` | gest de desen venit din inspectorul din SIDEBAR, transmis mai departe de host către panou (vezi blocul `relay/*` de la webview→host). Panoul îl aplică pe vederea pe care o arată EL, ca și cum ar fi venit din propria diagramă |
| `relay/fold` | `{foldId}` | idem: expandarea/re-plierea unui pliaj |
| `relay/netRender` | `{net}` | idem: comutarea fir↔etichetă a unui net |
| `relay/selectPins` | `{names[]}` | idem: selectarea pinilor din lista „porturi nemapate" a inspectorului |
| `relay/openTb` | `{}` | idem: „Open verification view" |
| `status/decorations` | `{decos[], generate}` | decorațiile de stare quick-uvm (faza 4): `decos[]` = validările model↔YAML (`checkConfig`) ca ținte SEMANTICE — `{scope: "port", port}` \| `{scope: "agent", agent}` \| `{scope: "env"}`, fiecare cu `severity: "error"\|"warning"` și `message` (engleză — webview-ul e monolingv, D19); webview-ul le mapează pe id-urile vederii curente (`statusIdsRtl`/`statusIdsTb` în `src/status.ts`, pur) și desenează un **badge** ⚠/✕ în colțul elementului, cu mesajele în tooltip; la nivelul-rădăcină TB, problemele agenților se agregă pe Env (bubble-up). `generate` = rezultatul ultimului „Generează testbench" (`{ok, code, detail, at}` sau `null` — niciodată rulat): **cip de stare** în antetul diagramei (✓/✕ + tooltip). Trimis la `ready`, la fiecare re-validare (împreună cu `overlay/config`) și după fiecare `generate`; liste goale = curăță. Badge-urile nu intră în exportul SVG (stare de diagnostic, nu conținut). **docs/08 R3 (Oct 2026):** `decos[]` also carry `{scope: "scoreboard", name}` / `{scope: "coverage", agent}` (an analysis endpoint naming an agent that does not exist — an error; the box's input is drawn as a broken stub) and an optional `fixes[]` of `{label, action, args}`: the SAME host action a palette button would send, offered on the badge (click), in the context menu and in the Properties panel; the host mirrors the findings on the verification tree through a `FileDecorationProvider` (✕ / !, bubbled up onto Env) and sends `status/decorations` to the sidebar as well |

### webview → host

| type | payload | semnificație |
|---|---|---|
| `ready` | `{v}` | webview inițializat; host răspunde cu `layout/full` + `model/full` + `overlay/config` — sidecar-ul ÎNAINTEA modelului, ca prima randare să aibă semințele de poziții (altfel o vedere aranjată ar licări întâi cu layout-ul automat) |
| `select/changed` | `{ids[]}` | selecția curentă (pentru comenzi, sincronizare spre editor și evidențierea instanței în ierarhie: primul id care se rezolvă la o instanță — direct, prefixat cu vederea curentă sau ca instanță-proprietar a unui pin — se selectează în tree view, fără focus; fără niciun id rezolvabil — inclusiv selecție goală, la comutarea de mod sau Escape — se evidențiază instanța vederii curente, ca ierarhia să reflecte mereu ce arată diagrama) |
| `layout/snapshot` | `{viewId, nodes: {id: {x, y}}}` | pozițiile întregii vederi, în bloc (docs/04): la finalul oricărui drag se persistă TOATE pozițiile curente (noduri, pliaje, steaguri de graniță), nu doar elementele trase; la randarea unei vederi deja aranjate se trimit pozițiile elementelor care nu aveau sămânță (elemente noi din recompilare, membri de pliaj, sidecar parțial moștenit). Fără semințe totale, ELK interactiv re-plasează elementele nepersistate altfel decât layout-ul complet văzut de utilizator (regresie reală: steagurile porturilor săreau la redeschidere). Host: `setPositions` în sidecar; fără ecou. Undo/redo-ul de poziții (Ctrl+Z/Ctrl+Y, docs/04) reutilizează același mesaj: fiecare pas restaurat se persistă ca un gest de poziție obișnuit |
| `fold/toggled` | `{viewId, foldId, collapsed}` | expandarea/re-plierea unui pliaj generate → host persistă starea în sidecar (`nodes[foldId].collapsed`) |
| `node/flipped` | `{viewId, nodeId, flipH, flipV}` | răsturnarea unui bloc (doc. 04: reatribuirea laturilor/ordinii pinilor, nu oglindire geometrică) → host persistă `nodes[nodeId].flipH/flipV` |
| `ports/reordered` | `{viewId, port, side, order}` | override de pin |
| `edge/override` | `{viewId, edgeId, patch}` | override de rutare (nivelurile 1–3) |
| `net/render` | `{viewId, net, render: "wire"\|"label"}` | override-ul de nivel 4 (docs/04): comutarea unui net între fir și etichetă din inspector (netul se selectează prin click pe traseu sau pe eticheta lui). Webview-ul a aplicat deja local; host-ul persistă `nets[net].render` în sidecar — alegerea egală cu sugestia din model șterge override-ul; fără ecou |
| `nav/drill` | `{instancePath, mode?}` | dublu-click pe instanță în vederea-schemă: webview-ul navighează local (schema dacă instanța are una, altfel simbolul), host-ul actualizează titlul panoului, vederea curentă și evidențiază instanța în ierarhie; `mode` (D24) distinge simbolul top-ului — reveal pe rădăcina sintetică „top module" — de schema lui — reveal pe nodul instanței (aceeași cale, vederi diferite) |
| `action/request` | `{action, args}` | acțiuni care ating YAML sau sursele: `setDut`, `createAgentFromPins`, `createAgentFromIface`, `createSubenv`, `ignorePort`, `unignorePort`, `generate`, `openSource`, `addScoreboard`, `addCoverage`, `addVirtualSequence`, `deleteComponent {kind, name}`, `editScoreboard {name, field, value}`, `createProbe {net}`, `wireConnections {}`, `composeIntoParent {}`, `openSubenvConfig {config}` (deschide fișierul de config al unui subenv — calea din `subenvs[].config`, purtată de drill — cu editorul implicit), `openConfigBeside {}` (docs/08 R4: the "YAML" header button — the configuration as text beside the diagram, focus kept on the diagram; the host opens it, or the per-file editor opens its own document), `addPinsToAgent {agent, pins, viewId}` (docs/08 R10: a wire from a DUT pin dropped on a pin an agent already claims — the dragged pins join that agent through the `addAgentPorts` mutation, with the same port derivation as `createAgentFromPins`), `applyProposals {items: [{kind, args, accept?}]}` (docs/08 R12: the proposals the user CHECKED in the assistance strip, applied in order through the flows above — a preset agent name is used only when it is free, not an SV keyword and not a scoreboard/subenv/probe name, otherwise the input box asks; the `materialize` item carries the ghost ids to KEEP and the host writes `analysis:` from the RESOLVED inferred set through `materializeAnalysis` — the whole set at once, the unchecked members absent, `analysis: {}` when nothing is kept: docs/07's two sharp edges), `renameComponent {kind: agent|scoreboard|subenv, name, newName}` (docs/08 R14: in-place rename, validated on the host — an SV identifier, no keyword, free across agents/scoreboards/subenvs/probes — with the cascade of `renameAgent` / `renameScoreboard` / `renameSubenv`; a composed config gets a warning that the parent's `<subenv>.<agent>` references are not updated), `openGeneratedCode {id, label}` (docs/08 R15: the element's generated code BESIDE the diagram, focus kept — the `quickuvm.openGeneratedCode` flow, which offers to generate it first when it is missing); `openConfigBeside` also takes an optional `id` (R15: the element's YAML entry is revealed and flashed after opening) — webview-ul NU scrie niciodată fișiere; cere host-ului. `openSource` acceptă și `peek: true` (cross-probing la hover, faza 4): host-ul doar **revelează** declarația în editoarele DEJA vizibile, cu o evidențiere tranzitorie a liniei (~1,2 s) — nu deschide tab-uri, nu fură focusul; setarea `quickuvm.hoverCrossProbe` (implicit on) îl stinge |
| `card/request` | `{id}` | docs/08 R15 — the hover card (a 450 ms dwell on a TB box, or `I` on the selected one) asks what the element will generate; the webview caches the answer until the next `config/full` or `status/decorations` |
| `export/result` | `{viewId, svg}` | SVG-ul AUTONOM al vederii curente (faza 4): clonă cu stilurile calculate inline-uite (culorile temei VSCode sunt copiate în export — CSS-ul extern cu `var(--vscode-*)` nu călătorește), `viewBox` pe conținut (fără camera de sesiune), fundal copt din tema curentă. Emis la butonul ⤓ din header sau ca răspuns la `export/request`; host: save dialog + scriere pe disc |
| `relay/flip` \| `relay/fold` \| `relay/netRender` \| `relay/selectPins` \| `relay/openTb` | `{nodeId, axis}` \| `{foldId}` \| `{net}` \| `{names[]}` \| `{}` | **gesturile de desen ale inspectorului din sidebar** (iul. 2026). Inspectorul NU mai stă în panou: aside-ul `#inspector` a fost SCOS, iar vederea „Properties" din sidebar e singurul inspector — de aici, un flip/pliaj/net-render nu are pânză pe care să acționeze, așa că se trimit host-ului, care le retrimite panoului (aceleași nume, sens invers). **Niciunul nu poartă `viewId`**: panoul le aplică pe vederea pe care o arată el, deliberat — sidebar-ul nu trebuie să poată muta o vedere pe care utilizatorul nu o privește. Fără panou deschis se pierd, ceea ce e corect: singurul lor efect e ce se desenează |
| `relayout/request` | `{viewId, scope: all}` | „Re-aranjează tot" (butonul ⟲ / docs/04): webview-ul a șters local pozițiile vederii și a revenit la layoutul ELK complet; host-ul șterge pozițiile (x/y) din nodurile vederii în sidecar — plierea și răsturnările rămân; fără ecou. `scope: new` e rezervat (inserarea elementelor noi se face automat, prin ELK interactiv) |

### Payload-ul `overlay/config` (detaliat în faza 2)

- `dut`: numele modulului DUT din YAML (`dut.name`) sau `null` fără configurație;
- `configPath`: calea fișierului YAML, pentru afișare în inspector;
- `agents[]`: `{name, color, pins[]}` — `color` = indexul în paleta de 8
  culori+forme a webview-ului (accesibilitate: forma dublează culoarea);
  `pins` = numele porturilor DUT revendicate de agent;
- `roles{}`: port → `clock` | `reset` | `ignored` (ceasul/resetul din `dut.*`,
  ignorările din `x_quickuvm_architect.ignored_ports`, decizia D15);
- `coverage`: `{total, mapped, unmapped[]}` peste porturile plane ale
  modulului DUT; porturile de interfață se configurează prin „agent din
  interfață" și nu intră în numărătoare (MVP);
- `orphans[]`: porturi prezente în YAML dar absente din model — se marchează,
  nu se șterg (invalidare grațioasă).

Reguli de protocol: mesajele sunt idempotente unde e posibil; host-ul e singura
autoritate pe fișiere (YAML, sidecar); webview-ul e reconstruibil integral din
`model/full` + `layout/full` + `overlay/config` (proprietate testabilă: kill +
restore trebuie să dea aceeași imagine).

## Degradare grațioasă și stări speciale

- compilare eșuată → `model/stale`, ultimul model rămâne interactiv;
- port din YAML absent în model → pin marcat "orfan" în overlay + diagnostic;
- selecție pe elemente pliate (`ch[0..2]`) → acțiunile se aplică pliajului
  întreg sau cer expandare, explicit;
- proiect fără Bender → sursa listei de fișiere din setări (glob sau `.f`).
