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
- **Protocol**: host→webview `config/full {configPath, config}` — subsetul
  QuvmConfig parsat (agents, analysis, virtual_sequences, probes, subenvs,
  connections, subenv_scoreboards), trimis la `ready` și la orice schimbare
  a YAML-ului (ca `overlay/config`); `view/show {viewId: "tb:…", mode:
  "tb"}`.
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
| `probe/highlight` | `{targets[]}` | cross-probing editor→diagramă (reciproca hover-ului, faza 4): host-ul urmărește cursorul din sursele SV (debounced) și trimite ținta de sub cursor — `{kind: "instance", path}` \| `{kind: "port", module, port}` \| `{kind: "module", module}`; mai multe ținte doar la instanțele generate de pe aceeași linie sursă. Webview-ul le mapează pe id-urile vederii CURENTE (`probeIds` în `src/locmap.ts`, pur) și aplică un **halou de cross-probing** (`.xprobe`) persistent, DISTINCT de selecție — selecția de lucru nu e atinsă. Ținta absentă din vederea curentă = niciun halou (non-invaziv, fără navigare); listă goală = stinge. Navigarea explicită e comanda `quickuvm.revealInDiagram` (meniul contextual al editorului), care folosește `view/show` + `select/reveal` |
| `ui/config` | `{lasso}` | preferințele UI din setările extensiei, trimise la `ready` și la schimbarea configurației; `lasso`: `contain` (implicit — lasso-ul selectează doar obiectele complet cuprinse, „window selection") \| `intersect` (și pe cele atinse, „crossing selection"; setarea `quickuvm.lassoMode`) |
| `export/request` | `{}` | cere serializarea SVG a vederii curente (comanda `quickuvm.exportSvg` din paletă); webview răspunde cu `export/result` |
| `theme/changed` | `{}` | re-citește variabilele CSS |
| `status/decorations` | `{decos[], generate}` | decorațiile de stare quick-uvm (faza 4): `decos[]` = validările model↔YAML (`checkConfig`) ca ținte SEMANTICE — `{scope: "port", port}` \| `{scope: "agent", agent}` \| `{scope: "env"}`, fiecare cu `severity: "error"\|"warning"` și `message` (engleză — webview-ul e monolingv, D19); webview-ul le mapează pe id-urile vederii curente (`statusIdsRtl`/`statusIdsTb` în `src/status.ts`, pur) și desenează un **badge** ⚠/✕ în colțul elementului, cu mesajele în tooltip; la nivelul-rădăcină TB, problemele agenților se agregă pe Env (bubble-up). `generate` = rezultatul ultimului „Generează testbench" (`{ok, code, detail, at}` sau `null` — niciodată rulat): **cip de stare** în antetul diagramei (✓/✕ + tooltip). Trimis la `ready`, la fiecare re-validare (împreună cu `overlay/config`) și după fiecare `generate`; liste goale = curăță. Badge-urile nu intră în exportul SVG (stare de diagnostic, nu conținut) |

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
| `action/request` | `{action, args}` | acțiuni care ating YAML sau sursele: `setDut`, `createAgentFromPins`, `createAgentFromIface`, `createSubenv`, `ignorePort`, `unignorePort`, `generate`, `openSource`, `addScoreboard`, `addCoverage`, `addVirtualSequence`, `deleteComponent {kind, name}`, `editScoreboard {name, field, value}`, `createProbe {net}`, `wireConnections {}`, `composeIntoParent {}`, `openSubenvConfig {config}` (deschide fișierul de config al unui subenv — calea din `subenvs[].config`, purtată de drill — cu editorul implicit) — webview-ul NU scrie niciodată fișiere; cere host-ului. `openSource` acceptă și `peek: true` (cross-probing la hover, faza 4): host-ul doar **revelează** declarația în editoarele DEJA vizibile, cu o evidențiere tranzitorie a liniei (~1,2 s) — nu deschide tab-uri, nu fură focusul; setarea `quickuvm.hoverCrossProbe` (implicit on) îl stinge |
| `export/result` | `{viewId, svg}` | SVG-ul AUTONOM al vederii curente (faza 4): clonă cu stilurile calculate inline-uite (culorile temei VSCode sunt copiate în export — CSS-ul extern cu `var(--vscode-*)` nu călătorește), `viewBox` pe conținut (fără camera de sesiune), fundal copt din tema curentă. Emis la butonul ⤓ din header sau ca răspuns la `export/request`; host: save dialog + scriere pe disc |
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
