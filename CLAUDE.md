# CLAUDE.md — context pentru sesiunile de lucru pe QuickUVM Architect

## Ce este proiectul

Extensie VSCode pentru proiectarea de circuite integrate digitale: vizualizează
un design SystemVerilog ca diagramă interactivă și generează, prin selecție pe
diagramă, configurația YAML pentru generatorul de testbench-uri QuickUVM
(https://github.com/arcadie-cracan/QuickUVM). Citește `README.md` și apoi
`docs/01-arhitectura.md` … `docs/06-plan-mvp.md` înainte de orice modificare —
deciziile arhitecturale sunt deja luate și motivate acolo; nu le rediscuta fără
un motiv nou.

## Invarianți arhitecturali (nu se încalcă)

1. **Modelul de proiect JSON este contractul stabil** între backend și UI
   (`schema/project-model.schema.json`). Backend-ul (azi pyslang) este
   înlocuibil; UI-ul nu vede niciodată API-ul slang direct.
2. **Fișierul YAML QuickUVM este sursa de adevăr** pentru configurarea
   verificării. UI-ul nu ține stare proprie de configurare: orice acțiune
   produce o editare de text în YAML (prin `WorkspaceEdit`), deci undo/redo,
   diff și editarea manuală funcționează natural.
3. **Pozițiile nodurilor aparțin utilizatorului.** Layout automat complet doar
   la prima deschidere sau la comanda explicită "Re-aranjează"; la modificări de
   design, ELK rulează în mod interactiv doar pentru elementele noi. Pozițiile
   se persistă în fișierul sidecar (`docs/04-layout-si-rutare.md`).
4. **ID-uri stabile** = căile ierarhice elaborate (`demo_top.u_soc.g_ch[1].u_ch`).
   Orice element adresabil (nod, pin, net, vedere) se identifică prin ele.
5. **Invalidare grațioasă**: override-uri (poziții, waypoints) ale căror ținte
   dispar din design se marchează orfane, nu se șterg automat. Diagrama nu
   dispare pe cod stricat — rămâne ultimul model valid + banner.

## Convenții de cod

- **Comentariile din surse sunt în ENGLEZĂ** (decizie 2026-07-20, pentru
  creșterea comunității): orice comentariu nou din `src/**`, `backend/**`,
  `scripts/**` se scrie în engleză; corpusul vechi (comentarii în română fără
  diacritice) se migrează progresiv la engleză. Backend Python: PEP 8.
  Comunicarea cu utilizatorul rămâne în română cu diacritice; documentația
  (`docs/**`, acest fișier) rămâne română până la o decizie separată.
- **UI-ul extensiei: engleză** (decizia D19), localizat prin `package.nls.json`
  (+`package.nls.ro.json`) și `vscode.l10n.t()` + `l10n/bundle.l10n.ro.json`;
  orice șir nou vizibil utilizatorului în host se împachetează în `l10n.t()`
  și primește traducerea în bundle-ul ro; webview-ul e monolingv englez în
  MVP; jurnalele (Output) nu se localizează. Terminologia **Symbol view /
  Schematic view** (D18) e adoptată integral: UI, protocol (`ViewMode:
  symbol|schematic`), comenzi (`quickuvm.openSymbolView`/`openSchematicView`),
  fișiere (`src/webview/schematic.ts`), documentație („vederea-simbol" /
  „vederea-schemă").
- Extensia: TypeScript strict, fără framework în webview (SVG generat manual +
  elkjs); mesajele extensie↔webview respectă protocolul versionat din
  `docs/05-ui-si-protocol.md` — orice mesaj nou se adaugă întâi acolo.
- Nu introduce dependențe mari fără justificare scrisă în jurnalul deciziilor
  (`docs/06-plan-mvp.md`, secțiunea "Jurnalul deciziilor").

## Cum se rulează și testează backend-ul

```bash
pip install pyslang
cd examples
python3 ../backend/svmodel.py adder.sv inverter.sv chan.sv soc_top.sv \
        --top demo_top -o model.json
```

`examples-probe/deep_pipe.sv` e o fixtură separată pentru cross-probing (8
module într-un singur fișier, instanțiate în lanț de `deep_pipe`; porturile lor
sunt la linii mult distanțate, ca hover-ul pe pini să deruleze vizibil sursa —
configurația de lansare „cross-probing: deep_pipe").

`examples/soc_top.sv` este designul de regresie: conține deliberat parametri
propagați, lățimi simbolice, `generate for`, tablou unpacked de porturi,
interfață cu modporturi și conexiuni prin concatenare/select — dacă o
modificare a extractorului le păstrează pe toate corecte în `model.json`,
e probabil sănătoasă. Verificări-cheie așteptate:

- 8 instanțe, inclusiv `demo_top.u_soc.g_ch[0..2].u_ch` (NCH=3 propagat, nu 2);
- `soc_top.ch_out`: `width=48`, `unpacked_dims=[3]`, `elem_width=16`;
- `chan` elaborat cu `W=16`: porturi `logic[15:0]`, `width=16`;
- `demo_top.bus_i`: modport `slave` cu `addr/wdata/we: in`;
- în vederea `demo_top.u_soc`: `din` are `fanout=9`, `render=label`;
  pinul `g_ch[1].u_ch.dout` are `conn.kind=select`, `index="1"`.

Verificările sunt implementate ca teste pytest în
`backend/tests/test_svmodel.py` (plus snapshot contra `examples/model.json` și
validare contra schemei JSON). Rulează-le după orice modificare a extractorului:

```bash
pip install -r backend/requirements-dev.txt
python -m pytest backend/tests
```

## Cum se compilează și rulează extensia

```bash
npm install
npm run build            # esbuild: dist/extension.js + dist/webview.js
npm run typecheck        # tsc --noEmit (strict)
npm run test:scene       # scena vederii-schema (Node, fara DOM)
npm run test:tbscene     # scena pe niveluri a vederii de verificare (faza 3b)
npm run test:tblayout    # layout-ul TB: laturile porturilor, flip, seminte
npm run test:tbtree      # arborele ierarhiei de verificare (faza 3b, Node)
npm run test:yamlops     # mutatiile YAML pure (+ topConfigPaths/isComposedChild)
npm run test:filelist    # caile/listele slang: quotare .f, exclude outputDir, loc.file
npm run test:heuristics  # euristicile pe nume: ceas/reset/activ-jos (_ni/_bi)
npm run test:configcheck # nucleul pur al validarilor model<->YAML (hibrid, latimi)
npm run test:probe       # modulul pur al probelor K2 (cale XMR + latime, pe model real)
npm run test:compose     # compunerea H1: conexiuni + subenvMapping + planWireEdits
npm run test:sidecar     # mutatiile pure ale sidecar-ului de layout
npm run test:router      # ruterul A* pe grila + obstacolele din etichetele pinilor
npm run test:minimap     # matematica minimapului (incadrare, U = M ∘ V⁻¹, salt)
npm run test:locmap      # cross-probing editor->diagrama: loc->tinta + tinta->id-uri
npm run test:status      # decoratiile de stare: findings->decoratii + decoratii->id-uri
npm run test:e2e         # yamlops -> quick-uvm generate real (cere quick-uvm)
```

F5 în VSCode (configurația "Rulează extensia (examples/)") deschide un
Extension Development Host pe `examples/`, unde `quickuvm.top=demo_top` e
presetat în `.vscode/settings.json`. Webview-ul se poate proba și fără VSCode
cu `scripts/harness.html` (stub `acquireVsCodeApi` + modelul de regresie):
`python -m http.server 8123` din rădăcină, apoi
`/scripts/harness.html?view=demo_top.u_soc&mode=schematic` (adaugă `&nomodel=1`
ca să simulezi editorul per-fișier din felia 4: vederea TB doar din config).
Pentru **validarea de închidere a MVP-ului** există un tutorial pas-cu-pas —
`docs/tutorial-yapp-router.md` — cu fixtura `examples-yapp/yapp_router.sv`
(configurația de lansare „tutorial: yapp_router"); pașii sunt verificați empiric
(svmodel parsează designul, iar config-ul rezultat generează curat cu quick-uvm).

## Capcane cunoscute (descoperite la validare)

> **Referința de schemă autoritară e `docs/quickuvm-schema-reference.md`**
> (sondată empiric pe quick-uvm 1.0.0: verdicte A1–A26, tabele de chei,
> mesajele de eroare verbatim). Notele de mai jos marchează local ce s-a
> schimbat la 1.0; la conflict, referința câștigă. Extensia poate condiționa
> pe `quick-uvm --version` >= 1.0.0 (schema e înghețată, deprecările vin cu
> erori-ghid).

- **Waiver-ul de porturi (D15) e cheia DE SCHEMĂ `dut.unverified_ports`**
  (quick-uvm >= 1.0.0): 1.0 respinge ORICE cheie necunoscută
  (extra="forbid", inclusiv prefixul `x_`), așa că vechiul bloc
  `x_quickuvm_architect` a fost PROMOVAT în schemă, nu ocolit. Regula:
  intenție de verificare → cheie de schemă; stare de vedere → sidecar; fără
  coș `x_` intermediar. Un port waived pe care un agent îl conectează e
  REFUZAT de generator la generate („connected by agent ... Remove it from
  one side") → diagnosticul `ignored-and-mapped` e acum ERROR, iar la golire
  dispare DOAR cheia (blocul `dut` rămâne — e configurație obligatorie).

- pyslang 11 e organizat pe submodule: `from pyslang.driver import Driver`,
  `from pyslang import ast`; multe metode C++ `getX()` sunt proprietăți `x`.
- `Driver.reportCompilation` poate întoarce valori neintuitive, iar cu
  `quiet=True` **înghite complet diagnosticele** (erori invizibile, model
  degradat emis tacit — regresie reală prinsă pe common_cells). `svmodel`
  folosește `comp.getAllDiagnostics()` + `DiagnosticEngine.reportAll()` pe
  stderr și refuză modelul la erori; nu reintroduce `reportCompilation`.
- `bender script flist` NU emite `+incdir+`/`+define+` (pierde
  `export_include_dirs` din Bender.yml, include-urile eșuează); extensia
  folosește `bender script flist-plus`. Căile `+incdir+` cu spații se citează
  interior: `+incdir+"cale"` (validat cu slang 11).
- Conexiunile porturilor de ieșire vin împachetate în `AssignmentExpression`
  (latura externă e `.left`); intrările pot veni în `ConversionExpression`.
- Textul sintactic al selecturilor din generate păstrează genvar-ul (`ch_out[g]`);
  indexul numeric per instanță se ia din `e.selector.constant`.
- GitHub API e limitat de rată din unele medii; preferă `pip install pyslang`
  sau clone direct pe `github.com`.
- `Driver.parseCommandLine` desparte pe spații: căile (fișiere, `-f`) se
  citează cu ghilimele duble — și pe linia de comandă sintetică din
  `build_model`, și pe liniile fișierelor `.f` generate de extensie.
- slang relativizează `loc.file` față de cwd-ul procesului (poate ieși
  `..\..\...`); host-ul reconstituie calea absolută prin join cu rădăcina
  workspace-ului (`resolveLocPath` în `src/filelistops.ts` — pur, testat în
  `test:filelist` —, consumat de `openLoc` din `src/panel.ts`).
- ELK `FIXED_ORDER` numără porturile în sens orar: pe latura de vest indexul
  crește de jos în sus — ordinea vizuală se obține inversând indecșii
  (`layoutSymbol` în `src/webview/main.ts`).
- ELK layered pune nodurile fără muchii de intrare în primul strat, iar pe
  cele neconectate le împachetează pe componente separate: porturile de
  graniță ale vederii-schemă cer `layerConstraint:
  FIRST_SEPARATE/LAST_SEPARATE` **plus** `separateConnectedComponents: false`
  — cu `FIRST/LAST` simplu, steagurile se amestecă printre instanțele ale
  căror intrări sunt net-uri etichetate (`layoutSchematic` în
  `src/webview/schematic.ts`).
- La net-urile cu mai multe surse (slice-uri asamblate prin select, `ch_out`),
  muchiile se trag din fiecare sursă spre fiecare destinație — cu un singur
  „driver" ales, celelalte surse ar deveni ținte și layering-ul se strică
  (`buildSchematicScene` în `src/webview/scene.ts`).
- Pinii instanțelor de interfață NU au direcție proprie (un semnal de
  interfață nu e intrinsec in/out — direcția se dă per modport, la modulul
  conectat); dacă latura lor rămâne fixă (VEST, ca porturile de intrare),
  firul unui net fără driver clar (ex. `clk` între `bus_i.clk` și
  `u_soc.clk`) iese pe latura opusă țintei și ocolește tot blocul (384px, 4
  coturi). Latura pinilor de interfață se orientează după rolul în net
  (sursă → EST, destinație → VEST), iar la net-uri fără driver clar instanța
  de interfață e preferată drept sursă (`buildSchematicScene`).
- Obstacolele MOI de text ale pinilor (etichete de net / adnotări const,
  desenate în afara blocului) trebuie limitate la ÎNĂLȚIMEA unui pas de pin
  (`PIN_PITCH`, nu mai mult): un obstacol mai înalt sângerează în rândul
  pinului vecin și-i forțează firul pe un ocol inutil în scară (`routeEdges`
  în `src/webview/schematic.ts`). `PIN_PITCH` e acum **24** (era 16) — lărgit
  la validare, ca decorațiile (`/N`, glife const/split-join, cercuri nc) să
  aibă aer între rânduri; rămâne multiplu de 8 (pin pe grilă = fir drept).
- Adnotarea unui pin care e capăt de fir (select `[N]` pe `dout`, concat)
  stă chiar pe traseul propriului fir, ca eticheta lui — NU trebuie să fie
  obstacol pentru el, altfel firul își ocolește propria etichetă cu coturi
  inutile (ex. `g_ch[0/2].u_ch.dout → ch_out`: 4 coturi în loc de 2, un
  „cârlig" jos-apoi-dreapta la ieșire). `routeEdges` sare peste obstacolul
  pinilor care sunt capete ale unei muchii-fir (`wirePins`); adnotările
  pinilor FĂRĂ fir (const `=1'b1`, nc, etichete de net) rămân obstacole
  pentru firele ALTOR net-uri.
- În vederea TB, etichetele porturilor se desenează mereu DEASUPRA portului
  (`py - 5`, pe AMBELE laturi), nu pe rândul firului (`drawBox` în
  `src/webview/tbschematic.ts`): firul iese orizontal la `py`, deci nu-l mai
  taie. **Alinierea verticală e CONSTANTĂ la răsturnare** (cererea
  utilizatorului la validare): H schimbă latura vest↔est, dar NU sus/jos —
  altfel un bloc răsturnat își muta etichetele deasupra↔dedesubt. Anchorul
  (`end` la vest, `start` la est) le ține pe latura exterioară, deci porturile
  care se privesc (DUT est ↔ Env vest) rămân separate ORIZONTAL (~9px la
  layout-ul implicit, fără suprapunere). Nota veche „est deasupra/vest dedesubt"
  (separare pe laturi opuse ale firului) e ÎNLOCUITĂ — dădea inconsecvență la
  flip. A face din etichete obstacole MOI pentru ruter a fost încercat și RESPINS
  — supra-constrânge ruterul TB (mai multe intersecții, nu mai puține).
- `cycleBreaking: INTERACTIVE` inversează muchii după pozițiile-semințe și
  aruncă `UnsupportedConfigurationException` în combinație cu
  `LAST_SEPARATE` pe steagurile granițelor — modul interactiv folosește doar
  layering/crossingMinimization/nodePlacement INTERACTIVE (direcțiile
  muchiilor noastre sunt fixe semantic; `layoutSchematic`).
- Modul INTERACTIVE plasează elementele FĂRĂ sămânță altfel decât layoutul
  complet (rândurile steagurilor de graniță se reamestecă — până la 384px
  diferență pe verticală, deterministic): semințele trebuie să fie totale
  sau deloc (D21). De aceea drag-end trimite `layout/snapshot` cu TOATE
  pozițiile vederii, iar randarea unei vederi aranjate pin-uiește imediat
  elementele fără sămânță; nu reintroduce persistarea doar a elementelor
  trase (regresie reală: porturile săreau la redeschiderea panelului).
- Plasarea porturilor ELK nu e controlabilă fin: `portsSurrounding` e ignorat
  la plasare (contează doar la dimensionare), iar etichetele INSIDE umflă
  pasul dintre porturi (24 în loc de 16) — pentru pinii pe grilă (docs/04),
  porturile sunt `FIXED_POS`, calculate de `layoutSchematic`
  (`src/webview/schematic.ts`), cu dimensiunile nodului rotunjite la 8.
- Măsurarea textului pentru lățimea blocului trebuie făcută cu **fontul cu
  care se desenează**: etichetele de pin/port sunt monospace
  (`--vscode-editor-font-family`), NU fontul UI proporțional
  (`--vscode-font-family`). `measurer()` din `src/webview/svg.ts` măsura totul
  cu fontul proporțional, care subestima lățimea etichetelor monospace (mai
  late) → blocuri prea înguste, etichete de porturi vest/est suprapuse (regresie
  reală, expusă de etichetele SV `[15:0] ch_out [0:2]` mai lungi). `measurer`
  ia acum un flag `mono`, iar `layoutSchematic`/`buildPins` cer măsurarea
  etichetelor de pin cu `mono=true`; numele/parametrii (proporționali) rămân pe
  fontul UI.
- Procesele Python copil se pornesc cu `PYTHONUTF8=1`: consola Windows e
  cp1252, iar quick-uvm scrie săgeți Unicode (crash real la primul echo);
  aceeași protecție și pe svmodel (sursele citate în diagnostice).
- Pe Windows, scriptul `quick-uvm.exe` poate ateriza în
  `%APPDATA%\Python\PythonXXX\Scripts` (instalare user), în afara PATH-ului;
  `generate.ts` are fallback `python -c "from quick_uvm.cli import main; main()"`.
- Pachetul npm `yaml` e CJS: la legarea ESM pentru scripturile Node de test
  e nevoie de shim-ul `createRequire` în banner (vezi `scripts/*.mjs`).
- `createSubenv` creează config-uri de bloc (`<modul>.quickuvm.yaml`) lângă
  config-ul top, iar descoperirea config-ului activ (glob pe
  `**/*.quickuvm.yaml`) alegea primul fișier alfabetic: scaffold-ul
  `chan.quickuvm.yaml` „fura" tăcut config-ul activ la următorul refresh
  (DUT devine `chan`, overlay-ul și acțiunile mor pe vederile soc — butoane
  inactive fără explicație; regresie reală prinsă la validarea interactivă).
  Descoperirea e acum stabilă (config-ul activ nu se schimbă cât timp
  fișierul lui există) și exclude la alegerea inițială fișierele referite ca
  `subenvs[].config` de un alt config (`topConfigPaths` în `src/yamlops.ts`,
  testată în `test:yamlops`); nu reintroduce alegerea pur alfabetică.
- `ConfigService.apply` trebuie să împrospăteze SINCRON (`await refresh()`):
  cu refresh debounced, `checkDut` citea `current` vechi imediat după „Set
  this module as DUT" și `createSubenv`/`createAgent` avortau tăcut
  (regresie reală pe common_cells). Sufixele active-jos includ `_ni`/`_bi`
  (convenția PULP — `src_rst_ni`); nu restrânge regexul la `_n|_b` —
  `ACTIVE_LOW_RE` stă în `src/heuristics.ts` (pur) și e blocat de
  `test:heuristics`. ATENȚIE 1.0: polaritatea/externalitatea NU se mai scriu
  pe `dut` (`reset_active_low`/`external_reset` sunt RESPINSE cu eroare-ghid)
  — `setDut` scrie maparea TOP-LEVEL `reset: {active_low, external}` și nu
  atinge o LISTĂ `reset:` scrisă de mână (domenii multi-reset).
- **Validarea compunerii (`subenvs`) s-a călit în quick-uvm** (re-sondat pe
  build-ul curent 0.9.2, iul. 2026 — utilizatorul a mai lucrat la generator;
  `models.py` a crescut de la ~2600 la 3216 de linii). Reguli DURE noi de care
  compunerea derivată (felia 3, încă neimplementată) trebuie să țină cont: (1)
  `subenvs` cer `layout: packaged` (deja asigurat de `createSubenvs`); (2) un
  bench de subsistem cere **≥2 subenv-uri** — compunerea unui SINGUR bloc e
  respinsă la `generate` (mesaj clar, dar abia la generare); (3) blocurile
  compuse **împart un namespace**: numele de agent/interfață/tranzacție/secvență
  trebuie unice între config-uri de bloc DISTINCTE — două `subenvs` către
  ACELAȘI config (ex. `g_ch[0].u_ch` și `g_ch[1].u_ch`, ambele `chan`) sunt OK
  (același env-package reutilizat), fiindcă `createSubenvs` numește agentul
  `<modul>_a` (distinct per modul). **HIBRIDUL E DIN NOU LEGAL** (quick-uvm >= 1.0.0,
  re-sondat empiric: agenți de graniță, H2): un bench cu `subenvs` POATE avea
  agenți proprii la top — diagnosticul „hybrid" a fost SCOS din ConfigService,
  iar lock-ul din `test:e2e` păzește acum sensul invers (dacă generatorul l-ar
  re-interzice, gestul de compunere cu agenți la top ar muri tăcut). Un top de
  subsistem PUR (fără agenți) rămâne un ÎNVELIȘ combinational
  (`dut: {combinational: true, reset: ''}`) — `createSubenvs` îl setează așa,
  altfel garda de ceas-fantomă din 1.0 refuză generarea (un ceas de top
  neconectat la DUT). **Nesting-ul
  FUNCȚIONEAZĂ**: un subenv al cărui config e el însuși subsistem e acceptat
  (compunere pe mai multe niveluri validă, dar fiecare nivel cere ≥2). Corolar
  pentru „Compose into parent bench" (`composeIntoParent` → `parentComposition`
  pur + `createSubenv`): NU se poate cabla un lanț cu un singur subenv per nivel;
  gestul compune blocul + FRAȚII lui în părintele imediat (≥2). Restul faptelor
  despre probe (cele 3 bug-uri, regulile de validare) rămân VALIDE pe acest
  build — re-confirmate empiric.
- **Blocul `analysis:` comută QuickUVM între mod implicit și declarat**
  (probat pe 0.9.2, RE-CONFIRMAT pe 1.0.0; `test:e2e` scenariul 4): FĂRĂ cheia `analysis:`, generatorul intră în
  mod **implicit** și auto-cablează un scoreboard ȘI un colector de coverage la
  „primary agent" (`// Scoreboard (wired to primary agent: cmd)` în env); CU
  `analysis:` — chiar `{}` gol — intră în mod **declarat** și cablează exact ce e
  listat (gol ⇒ nimic). Deci mutațiile de ștergere **nu au voie să curețe blocul
  `analysis` golit**: ar comuta explicit→implicit și ar **reînvia** scoreboard-ul
  și coverage-ul tocmai șterse din diagramă (ștergi ceva, primești înapoi mai
  mult — regresie reală, prinsă doar de e2e, invizibilă testelor pure). Se curăță
  doar listele-copil (`scoreboards: []`/`coverage: []`), niciodată maparea
  `analysis` (vezi `keepAnalysis` în `src/yamlops.ts`). Fișierul `<agent>_cov.svh`
  se generează oricum, per agent — `analysis` controlează **cablarea în env**, nu
  existența clasei.
- **Probele whitebox (K2)** — sondat empiric pe quick-uvm 0.9.2
  (`ProbeConfig`/`validate_probes` în `quick_uvm/models.py`; `test:e2e`
  scenariul 5): obligatorii doar `name` (identificator SV) și `path`; `width`
  implicit **1** — o probă fără lățime TRUNCHIAZĂ tăcut un semnal lat, deci
  extensia o cere explicit când nu o poate deriva. `path` e lipit **verbatim**
  după `dut_inst.` în tb_top (`assign probe_if.<name> = dut_inst.<path>;`),
  deci e relativ la instanța DUT și **nu e validat** de generator (o cale
  greșită trece tăcut). Spre deosebire de `analysis:`, blocul `probes:` NU
  comută moduri — absența lui e byte-identică, deci lista goală se curăță
  liniștit. Refuzuri reale ale generatorului (toate replicate în `proposeProbe`,
  `src/probe.ts`): `probes` + `subenvs` = **eroare dură** (H1); nume care se
  ciocnește cu o interfață/port de agent, cu ceasul sau reset-ul (același
  namespace tb_top/config-DB); agenți multi-instanțiați (`instances`; cu
  `replicas` merge). ATENȚIE 1.0: >1 domeniu de ceas NU se mai refuză —
  proba are câmp `clock:` care alege domeniul de eșantionare.
  **Bug-urile din 0.9.2, re-verificate pe 1.0.0** (repro + xrun): (1) `layout:
  packaged` + probă cu `coverage` → `env_pkg` nu include `probe_monitor`
  (xmvlog *E,NOIPRT, tip necunoscut) — ÎNCĂ RUPT, nu oferim `coverage` pe
  config-uri packaged; (2) un bloc-frunză **compus ca subenv** își generează
  fișierele de probă, dar tb_top-ul subsistemului n-are instanță `probe_if`,
  nici XMR, nici `config_db`, iar `probe_if.sv` nu intră în filelist →
  **exit 0, rupt tăcut** — ÎNCĂ RUPT, extensia avertizează (`isComposedChild`);
  (3) `struct` + `coverage` crăpa generatorul — REPARAT în 1.0 (generează și
  compilează curat).
- **Lățimea unui net NU e în model** și derivarea naivă e GREȘITĂ: `ViewNet` are
  doar `{name, endpoints, fanout, render}`. Lățimea se ia DOAR de la un capăt
  care e **același semnal** — portul propriu al modulului vederii (svmodel
  seamănă netul cu numele portului) sau un pin de copil legat cu **netul întreg**
  (`conn.kind === "net"`) — niciodată prin `select`/`concat`/`expr`. Dovada e în
  `examples/model.json`: `ch_out` are 48 de biți dar toți pinii lui sunt porturi
  de 16 prin `select`; `din` are 8 dar pinul e port de 16 prin `concat`
  (`netWidth` în `src/probe.ts`, testat în `test:probe`). Corolar: **nu se pot
  sonda semnale interne pure** (registre de stare, fire din `assign`) — modelul
  emite net-uri doar din conexiunile porturilor instanțelor-copil.
- **Cheile de compunere: `connections` și scoreboard-urile cross-bloc** — sondat
  empiric (1.0.0: cheia `subenv_scoreboards` NU mai există — e respinsă cu
  eroare-ghid; un scoreboard cross-bloc e o intrare `analysis.scoreboards` cu
  capete calificate `<subenv>.<agent>`, vezi `isCrossBlockSb` în
  `src/quickuvm.ts`; `test:e2e` scenariul 6): valide DOAR pe un bench cu `subenvs`; primul token al
  oricărui capăt e **numele instanței subenv** (`subenvs[].name`), nu `dut.name`.
  `connections: [{from: <subenv>.<port>, to: <subenv>.<port>}]` — `from` = port de
  **ieșire** al blocului sursă, `to` = port de **intrare** al blocului destinație,
  lățimi EGALE, un singur driver per destinație, iar agentul blocului **destinație
  trebuie PASIV** (`active: false`); generează un `assign` FIZIC în tb_top. Firul
  cablează **porturi de interfață de agent**, deci copiii trebuie să aibă agenți
  ÎNAINTE (de asta compunerea derivată e un gest separat de `createSubenv`, care
  scheletul copiilor nu creează agenți). Scoreboard-ul cross-bloc: `analysis: {scoreboards: [{name, source:
  <subenv>.<AGENT>, monitor: <subenv>.<AGENT>}]}` — cheiat pe **AGENT**, nu
  port; intră sub regula `keepAnalysis` (maparea `analysis` nu se șterge). Niciuna nu comută moduri (absența = byte-identică),
  deci listele goale se curăță liniștit. Derivarea din model: `deriveConnections`
  în `src/compose.ts` (pur, `test:compose`) — net inter-bloc = un net FĂRĂ capăt
  `<port>.X`, cu o ieșire și una+ intrări între subenv-uri; direcția din `port.dir`,
  lățimea din model; refuză multi-driver. **Invarianți căliți la recenzia
  adversarială** (nu-i reintroduce regresia): (1) un net de **feedthrough**
  (portul părintelui condus de un copil ȘI citit de altul) e conexiune reală —
  NU se sare tot net-ul fiindcă atinge `<port>.X`; capătul de graniță cade la
  filtrul per-capăt, net-urile pur de graniță cad la testul 0-drivere/0-sink.
  (2) Lățimea vine din **definiția-per-nume** a modulului, comună mai multor
  elaborări — pentru două instanțe ale ACELUIAȘI modul (parametri diferiți) e
  nesigură, deci nu se verifică (quick-uvm face verificarea autoritară); la
  module DIFERITE nepotrivirea se avertizează dar **tot se cablează** (nu arunca
  o conexiune reală — skip-ul pierdea conexiuni). (3) `wireConnections`
  reconstruiește rel→subenv fără filtrul `.` (membrii de generate au rel adânc);
  numele revendicat de mai mulți rel = ambiguu (`subenvName` e many-to-one) → se
  scoate + avertizează. (4) Pasivizarea grupează editările pe **URI de fișier**
  (două sinks pot referi ACELAȘI config-copil) — o singură `edit.replace` per
  fișier, cu pasivizările pliate pe textul în evoluție, altfel două replace pe
  același range se corup. (5) Se pasivizează **TOȚI agenții** blocului
  destinație care dețin porturi conduse, nu doar primul (`filter`, nu `find`
  în `planWireEdits`, `src/compose.ts`): porturile conduse ale unui sink pot
  aparține unor agenți DIFERIȚI, iar quick-uvm refuză generarea dacă oricare
  rămâne activ („agent ... is active and would drive ...") — cu un singur
  agent pasivizat, gestul raporta succes pe o stare ruptă (bug pre-existent
  găsit și confirmat empiric la recenzia adversarială a călirii, 16 iul.
  2026; blocul destinație multi-agent E o compunere validă — cu toți agenții
  pasivi, generarea e curată). Planificatorul editului multi-fișier e PUR
  (`planWireEdits` + `subenvMapping` în `src/compose.ts`, `test:compose`);
  host-ul din `actions.ts` doar citește fișierele și construiește
  `WorkspaceEdit`-ul din plan.
- Testbench-ul generat de quick-uvm conține un **stub al DUT-ului** (definiție
  duplicată care câștigă rezoluția slang → `port does not exist` pe designul
  real) plus surse care cer `uvm_macros.svh`: dosarul `quickuvm.outputDir` se
  exclude din glob-ul de surse (`outputDirExclude` în `src/filelistops.ts` —
  pur, testat în `test:filelist` —, consumat de `resolveFileList` din
  `src/filelist.ts`), altfel extensia își otrăvește singură modelul după
  primul „Generează testbench" (regresie reală: `test:e2e` lasă
  `examples/tb/`, iar arborele rămâne pe ecranul de bun-venit fără nicio
  explicație vizibilă).

## Faza curentă

Fazele 0–2 sunt încheiate: 0 (validare backend), 1 (schelet extensie +
vederea-simbol; bifată interactiv pe common_cells, `examples-bender/`),
2 (configurarea QuickUVM: overlay din YAML prin `ConfigService`, acțiunile
`setDut`/`createAgentFromPins`/`createAgentFromIface`/`ignorePort` prin
`WorkspaceEdit` cu mutații pure în `src/yamlops.ts`, validări model↔YAML cu
quick-fix de lățime, inspector lateral, „Generează testbench" cu fallback
`python -c`; validată cu `npm run test:e2e` și bifată interactiv în Extension
Development Host). Faza 3 e în lucru: vederea-schemă din `views` e
implementată read-only (iul. 2026) — scena pură în `src/webview/scene.ts`
(noduri copil cu parametri, pliaj generate `g_ch[0..2].u_ch` cu
expandare/re-pliere, muchii din nets cu dedup pe pliaje, etichete pentru
`render=label`, adnotări select/const/nc/concat, muchii de interfață), layout
și desen în `src/webview/schematic.ts`, navigare completă (mod derivat din
selecția în ierarhie — fără comutator Symbol/Schematic, D24; dublu-click =
intră în bloc — schema dacă există, la frunze sursa; Ctrl+dublu-click = sursa
oriunde; breadcrumb, comanda `quickuvm.openSchematicView`, sincronizare
diagramă→ierarhie), protocol extins (`view/show.mode`, `nav/drill.mode`);
teste în `npm run test:scene`, validare interactivă în `scripts/harness.html`.
Drag + sidecar sunt implementate (iul. 2026): pozițiile/pliajele/răsturnările se
persistă în `.vscode/quickuvm-architect.yaml` (mutații pure în
`src/sidecarops.ts`, `npm run test:sidecar`; serviciu host `src/sidecar.ts`
cu scriere atomică, watcher și invalidare grațioasă cu restaurarea orfanelor;
mesajele `layout/full`/`layout/snapshot`/`fold/toggled`/`node/flipped` din
docs/05; camera e stare de sesiune, nu de proiect — prima deschidere a
unei vederi se încadrează mereu în fereastră, docs/04); muchiile TUTUROR vederilor-schemă se rutează cu ruterul propriu A* pe
grilă din `routeEdges` (`src/webview/schematic.ts`, `src/webview/router.ts`,
`npm run test:router`; halou + obstacole de text pe etichetele pinilor;
fallback naiv per muchie fără drum) — ELK dă doar pozițiile, iar lumea pe
grilă e universală (docs/04). La recompilare, pozițiile utilizatorului devin
semințe pentru ELK interactiv: nodurile cunoscute rămân exact pe loc, doar
elementele noi primesc poziții, inserate în context; semințele sunt totale
sau deloc (D21, iul. 2026) — drag-end persistă snapshot-ul întregii vederi
(`layout/snapshot`), randarea unei vederi aranjate pin-uiește elementele
fără sămânță, iar `layout/full` se trimite înaintea lui `model/full` la
`ready`; „Re-aranjează tot"
(butonul ⟲, `relayout/request`) e singura cale de re-layout total. Pinii
stau pe grilă prin construcție (porturi
`FIXED_POS`, primul centru la +40, pas 24 (PIN_PITCH), dimensiuni multiple de 8 — pin
aliniat = fir drept, docs/04), iar blocurile suportă răsturnare H/V
(reatribuirea sloturilor de pini, nu oglindire; tastele H/V + inspector;
`node/flipped` → sidecar). Lumea pe grilă e universală: toate
pozițiile, inclusiv steagurile granițelor (mutabile, chei `<port>.x`), se
rotunjesc la grilă la fiecare randare (docs/04). ELK interactiv pentru
elemente noi + „Re-aranjează tot" (⟲) sunt implementate. Decizia
libavoid vs. ruter propriu e închisă — D20 (ruterul propriu, cu condiții de
reevaluare în jurnal). Override-ul de nivel 4 (fir↔etichetă per net) e
implementat (iul. 2026): click pe traseu sau pe eticheta netului → secțiunea
Net din inspector cu „Show as label"/„Show as wire"; mesajul `net/render`,
persistență în sidecar sub `nets.<net>.render` doar la abatere de la
sugestia din model, invalidare grațioasă cu `kind: net`; nivelul 1 (stil)
amânat — există un singur stil de rutare. `createSubenv` e implementat
(iul. 2026): butonul „Create subenv" din inspector pe blocurile selectate
în vederea-schemă (pliajele se desfac în membri), confirmare multi-select,
config-urile de bloc lipsă se creează schelet + dut euristic; mutația
`createSubenvs` în yamlops (nume SV sanitizate, `params` doar întregi —
schema cere `dict[str,int]`, `layout: packaged` asigurat pe top); atenție
la constrângerile H1 din QuickUVM (HEAD, iul. 2026): copiii cu ceas sunt
acceptați din slice-ul M1 dacă sunt single-clock cu cel mult un reset,
`params` cer `parameters:` declarați în agentul blocului (docs/03);
scenariul 3 din `test:e2e` acoperă compunerea, inclusiv un copil cu ceas.
**Faza 3 e ÎNCHEIATĂ** (iul. 2026, criteriul bifat pe common_cells —
docs/06). **Faza 3b e în lucru** — felia 1 (vederea de verificare
read-only) e implementată ca **model pe niveluri** (D24): scena plată per nivel
`TbScene` cu `focus`+`breadcrumb` în `src/webview/tbscene.ts`; fiecare bloc
= cutie UML (stereotip + compartimente text cu structura internă),
dublu-clic pe un bloc cu `drill` coboară un nivel (`""` testbench →
`env` → `agent:X`), cu steaguri de graniță pentru conexiunile ce
traversează nivelul. **Direcția porturilor e vizibilă** (iul. 2026): toate
muchiile au săgeată la capăt (sensul datelor → sursă = ieșire, țintă =
intrare), iar steagurile de graniță își arată direcția prin orientarea
vârfului — `dir` dedus din muchii în `buildTbScene` (`in` = doar sursă →
vârf spre interior; `out` = doar țintă → vârf spre exterior; `inout` =
ambele → hexagon turtit, fuziunea celor două vârfuri). Astfel `<if>` la un
agent activ = hexagon (driver-ul conduce + monitorul eșantionează), la un agent
pasiv = `in` (doar eșantionare); `<ap>` = `out`, `<sqr>` = `in`. Portul
`if` al monitorului stă pe EST (ca driver-ul, latura DUT-ului) — altfel
firul `if→monitor` ocolea monitorul (4 coturi/430px → 2/182px). Rădăcina
TB = DUT + Env (D24); DUT-ul se desenează
când există `dut.name` ȘI e verificat direct — config frunză SAU hibrid:
`hasDut = dut.name && (fără subenvs || are agenți)`; se omite la subsistemele
PURE (subenvs fără agenți), unde `dut.name` e doar containerul de împachetare
(`buildTbScene` în `src/webview/tbscene.ts`). ATENȚIE 1.0 — hibridul (subenvs +
agenți proprii) e LEGAL (agenți de graniță H2): ramura hibridă a lui `hasDut`
desenează un config VALID acum; diagnosticul dur a fost scos (vezi capcana
actualizată din secțiunea de compunere). Layout+desen plat în
`src/webview/tbschematic.ts`
(ELK layered, porturi FIXED_POS pe grilă, ruterul A* comun cu nodurile ca
obstacole; izolat de `schematic.ts` RTL). Navigare: `tb/focus`
(webview→host, drill/breadcrumb) + `tb/navigate` (host→webview, reveal din
arbore), sincronizare pe identitatea `<focus>|<bloc>`. Mesajul
`config/full`, `ViewMode: "tb"`, cheia `tb:<cale-config>` (invalidarea
sidecar-ului NU atinge vederile `tb:`), comanda
`quickuvm.openVerificationView`.
**Drag + poziții în vederea TB e implementat** (iul. 2026): aceeași mecanică
de drag/sidecar/semințe/D21/cameră/⟲ ca vederea-schemă RTL, cheiată **per
nivel** — `layoutKey()` întoarce `viewId` la RTL și `tb:<config>|<focus>` la
TB, fiindcă id-urile nodurilor se repetă între nivelurile de agent
(`u.sequencer` la `agent:cmd` și `agent:rsp`) și s-ar ciocni sub o cheie
comună. `layoutTb` primește `seeds` (ELK interactiv, ca `layoutSchematic`),
`renderTb` forțează semințele + pin-uiește elementele fără sămânță (D21
total, inclusiv steagurile de graniță). Porturile `TbPlaced` sunt acum
**relative** la originea nodului (ancora = `n.x + offset`), deci firele
urmează blocul la drag fără re-layout; `drawTbEdges` e reutilizabil pentru
re-rutarea live. Mânerele de drag sunt polimorfe (`dragChild`/`dragReroute`/
`dragEachPos`/`dragSelector` ramifică pe `state.mode`; RTL neschimbat).
**Flip în TB** (iul. 2026): pe **blocuri**, H schimbă laturile porturilor
(vest↔est), V inversează ordinea pe fiecare latură (ca RTL, prin `flipPorts`
în `tbschematic.ts`; `toggleFlip` folosește `layoutKey()`; taste H/V + butoane
în inspector). Pe **steaguri de graniță**, H face o **răsturnare LOCALĂ pe
orizontală** (`TbBPlaced.flipH`, consumat de `drawBoundary`+`anchor`):
oglindește forma în jurul centrului propriu ȘI mută ancora pe latura opusă a
steagului, DAR **nu-i schimbă poziția/latura ELK** (deci `FIRST/LAST_SEPARATE`
rămâne satisfăcut — nicio aruncare). La un steag `inout` (hexagon simetric)
forma nu se schimbă, dar ancora sare de la un vârf la celălalt — util: alege
care conexiune iese dreaptă (ex. `<if>` la nivel de agent: neflipat →
`driver→if` drept și `if→monitor` cu cot; flipat → invers). La un steag
direcțional, oglindirea + mutarea ancorei pe latura exterioară produc un cot
(blocul e mereu pe latura interioară) — răsturnare pur locală, reversibilă
(D24, cererea explicită a utilizatorului). V nu are sens pe un steag (o singură
conexiune). **De ce DOAR local, nu mutare pe latura opusă** (probat empiric,
`scripts/_probe-flip*.mjs`): ELK layered fixează latura unui steag direcțional
după direcția muchiei (sursă→primul strat/stânga, țintă→ultimul strat/dreapta)
și **ignoră o sămânță pe latura opusă** — chiar și FĂRĂ `layerConstraint`
(`<ap>`, țintă, semințat la x=8 → ELK îl ține la x=792). Un flip care ar
schimba latura ELK ar cere `FIRST_SEPARATE` cu muchie de intrare (sau invers)
→ ELK **aruncă** (`UnsupportedConfigurationException`) și `renderTb` eșua
TĂCUT. De aceea flip-ul e local (pură geometrie post-layout, fără ELK).
**Steag `inout` + semințe**: un steag INOUT nu satisface NICIUNA dintre
constrângeri → NU primește `layerConstraint` (ELK îl așază în mijloc; bonus,
dispare ocolul `if→monitor`, iar `monitor.if` revine pe VEST). `renderTb`
prinde orice aruncare din `layoutTb` (banner, nu eșec tăcut). Săgeata muchiilor e `markerUnits:
"userSpaceOnUse"` (dimensiune fixă, nu scalată cu grosimea firului — altfel
firul de interfață gros o umfla, iar la hover se micșora). Harness-ul suportă
`mode=tb` (injectează `config/full` + persistă snapshot/`node/flipped` în
`sessionStorage`).
**Unificarea DESIGN (D24) e implementată** (iul. 2026): vederea RTL nu mai
are comutator Symbol/Schematic — modul e derivat din nodul selectat în
ierarhie. Arborele Design Hierarchy are o **rădăcină sintetică „top module"**
(`src/tree.ts`, `InstanceNode.inst` opțional, `contextValue` `top-root` vs
`instance`) imediat deasupra top-ului: click pe „top module" → **simbolul**
top-ului (`openSymbolView`, mod `symbol`); click pe orice nod cu nume →
**schema** internă (`openSchematicView`; frunzele cad grațios pe simbol în
webview). Buton „Set top module" pe rădăcină (inline `$(gear)` + meniu
contextual + link în welcome view). `nav/drill` poartă `mode` ca host-ul să
distingă simbolul top-ului (reveal pe rădăcina sintetică) de schema lui
(reveal pe nodul instanței): `panel.ts` ține `currentMode`, `revealInstance`
în `extension.ts` alege rădăcina doar la `mode==="symbol" && viewId===tops[0]`.
Capcană rezolvată la review: `model/full` NU trimite `nav/drill` la prima
deschidere (host-ul trimite oricum un `view/show` explicit imediat după — un
`nav/drill` ar concura și ar fixa host-ul pe top); îl trimite doar la
recompilarea care șterge vederea curentă (când NU vine `view/show`).
Sidebar-ul are două secțiuni: **Design Hierarchy**
(arborele RTL, `src/tree.ts`) și **Verification Hierarchy** (arborele
mediului TB derivat din config, `src/tbtree-build.ts` pur +
`src/tbtree.ts`); id-urile arborelui de verificare coincid cu ale
diagramei TB (ambele din `buildTbScene`), deci navigarea arbore↔diagramă e
simetrică fără mapare (comanda `quickuvm.revealTbComponent`, mesajul
`select/reveal`). **Felia 2 (editarea) e implementată**: adăugarea (paletă în
inspector), **ștergerea** și **editarea proprietăților** (iul. 2026). Mutații
pure în `src/yamlops.ts`: `removeScoreboard`/`removeCoverage`/
`removeVirtualSequence` (frunze, idempotente la țintă lipsă — no-op = text
neschimbat, ca `addCoverage`), `removeAgent` (cascadă: coverage-ul agentului,
scoreboard-urile cu `source`/`monitor`==agent — se șterge întreg scoreboard-ul,
nu se degradează —, pașii de vseq care-l folosesc + secvențele rămase goale;
`subenv_scoreboards` are capete `<subenv>.<AGENT>` — nume calificate cu prefix de
subenv, care referă agenți ai config-urilor COPIL (alte fișiere), nu agenții
bare ai config-ului curent, deci `removeAgent` (care compară nume bare) nu-l
atinge corect) și `setScoreboardField` (câmp generic; valoarea implicită se șterge —
`match=in_order` sau gol; **cascadă**: monitor gol → single-stream șterge
`match`+`match_key`, `match=in_order` șterge `match_key`; NU forțează flow, deci
stilul scris de mână rămâne). Curățarea blocurilor golite prin `pruneEmptySeq`/
`pruneEmptyMap` (ca `writeIgnored`). Acțiuni host în `src/actions.ts`:
`deleteComponent` (confirmare **modală** `showWarningMessage {modal:true}`; la
agent, `detail` rezumă cascada prin `agentCascade` — secvența dispare doar dacă
TOȚI pașii sunt ai agentului, altfel „a step in X") și `editScoreboard`
(editare **inline**: valoarea vine din inspector, `max_latency`→`Number`). ID→
nume în inspector: `tbsb`→`sb.name` (căutat după etichetă), `tbcov`→agentul din
`cov:<agent>`, `tbagent`→etichetă, `tbvsqr`→un buton Delete per
`virtual_sequences[]`. Editorul de proprietăți (`tbScoreboardEditor`):
`<select>` source/monitor (monitorul exclude sursa)/match (dezactivat fără
monitor), `<input>` match_key (dezactivat dacă nu e out_of_order)/max_latency;
`ActionKind` `deleteComponent`/`editScoreboard` (protocol.ts). Validat în
`scripts/harness.html?mode=tb` (mesajele corecte pe scoreboard/coverage/agent/
vseq). **Invarianți căliți la recenzia adversarială** (nu-i reintroduce
regresia): (1) o ștergere fără țintă întoarce textul ORIGINAL byte-identic (nu
`doc.toString`), altfel un no-op ar re-serializa și ar șterge containere goale
scrise de mână (`scoreboards: []`) → WorkspaceEdit fantomă; `removeNamedFromSeq`
întoarce `bool`, apelantul se scurtcircuitează la `text`. (2) `removeAgent`
curăță DOAR containerele pe care ACEASTĂ operație le-a golit (`covChanged`/
`sbChanged`/`vseqChanged`), iar un vseq dispare doar dacă i s-au scos efectiv
pași (`stepsRemoved > 0`) — un `body: []` pre-existent rămâne, coerent cu ce
promite `agentCascade` în modală. (3) `setScoreboardField` REFUZĂ golirea lui
`source` (obligatoriu A2). (4) În editor, `<select>` Source exclude monitorul
curent (și invers), ca la add. (5) Ramura `tbsb` din inspector se restrânge la
`id.startsWith("sb:")` — nodurile cross-bloc `xsb:` (`subenv_scoreboards`) au
altă sursă și încă n-au editor/ștergere. (6) Ștergerea are și **gest de
tastatură** (`Delete`/`Backspace` pe nodul TB selectat → aceeași `tbDeleteTarget`
+ confirmare modală ca butonul); handler-ul `keydown` (pe `window`) se
scurtcircuitează dacă `e.target` e `INPUT`/`SELECT`/`TEXTAREA`/contenteditable —
altfel `f`/`h`/`Delete` tastate în câmpurile inspectorului (match_key,
max_latency) ar comanda diagrama în loc să ajungă în câmp. (7) **Meniu
contextual** în vederea TB (`contextmenu` pe canvas): clic-dreapta pe o
componentă → Open (dacă are `drill`) / Flip H / Flip V / Delete (marcat
`danger`); pe `vsqr` o intrare per secvență, pe un steag doar Flip H, pe
DUT/Env fără Delete; pe fundal NU se face `preventDefault` (rămâne meniul
implicit). Se închide la Escape (înaintea golirii selecției),
`pointerdown` în afară (listener pe `window` în faza de **capture**, ca să
preceadă handlerele canvas-ului) și la zoom. Clic-dreapta pe un element din
AFARA selecției îl selectează (convenția editoarelor). `tbDeleteTarget` e
sursa unică de rezoluție id→nume pentru buton, tastă ȘI meniu (nu pot devia).
**Felia 3 e în lucru** — **proba whitebox (K2) e implementată** (iul. 2026):
selectezi un net în vederea-schemă → „Create probe" din secțiunea Net trimite
`createProbe {net}`; toată deducerea stă în modulul **pur** `src/probe.ts`
(`proposeProbe` — rezolvă instanța DUT din numele de MODUL din YAML, calculează
calea XMR relativă la ea și derivă lățimea corect; `test:probe`, 15 teste pe
modelul real). Refuzurile replică exact ce respinge generatorul (vezi capcanele
de mai sus). Mutații `addProbe`/`removeProbe` în yamlops (`probes` e listă de
prim nivel, se curăță goală — NU e ca `analysis`); ștergerea probelor e în
vederea TB (nodul `probes` le agregă, deci un buton per probă, ca la `vsqr`).
**Compunerea derivată e implementată** (iul. 2026): `deriveConnections` în
modulul pur `src/compose.ts` (`test:compose`) transformă net-urile inter-bloc
ale vederii-schemă (net fără capăt `<port>.X`, o ieșire → una+ intrări între
subenv-uri) în `connections`, cu direcția din `port.dir` și lățimea din model;
gestul „Wire connections from design" (`wireConnections`) scrie `connections`
prin `addConnections` ȘI pune automat pasivi agenții blocurilor-destinație
(`setAgentActive(false)`) — `WorkspaceEdit` ATOMIC pe mai multe fișiere (top +
config-uri copil); când un copil n-are încă agent, avertizează. `test:e2e`
scenariul 6 dovedește lanțul + că un agent activ e refuzat și flip-ul îl repară.
„Compose into parent bench" (`composeIntoParent` → `parentComposition` pur +
`createSubenv`) e implementat (un nivel, din copil; ≥2 blocuri). **Felia 4 e
implementată** (iul. 2026): `QuvmConfigEditor` (`src/customeditor.ts`) e
editorul IMPLICIT al `*.quickuvm.yaml` (`customEditors` `priority: default` în
package.json) — deschizi fișierul → diagrama TB, cu fallback text nativ. TB e
config-driven (`renderTb` nu atinge `state.model` — verificat; header-ul omite
butonul „Design" fără model), deci se randează din textul documentului;
layout-ul merge prin sidecar-ul COMUN (`tb:<cale>`), gesturile de editare aplică
pe DOCUMENT. Refactorul-cheie: interfața `TbEditTarget` (`current`/`configUri`/
`apply`) — `ConfigService` o satisface (config-ul ACTIV), `DocumentEditTarget`
(în customeditor.ts) o implementează (documentul deschis), iar gesturile de
editare TB din `actions.ts` iau `cfg: TbEditTarget = this.config` → ACELEAȘI
metode (cu QuickPick-uri) merg pe oricare țintă, zero duplicare. `diagramHtml`
(în `panel.ts`) e HTML-ul webview partajat. Orice schimbare de text →
`config/full` → re-randare (fără buclă). Validat în harness cu `?nomodel=1`.
**Faza 3b e ÎNCHEIATĂ** (16 iul. 2026): utilizatorul a parcurs integral
tutorialul `docs/tutorial-yapp-router.md` în Extension Development Host —
criteriul de închidere (mediu cu ≥2 agenți + scoreboard two-stream +
coverage, construit și re-aranjat integral grafic, YAML lizibil, `generate`
curat) e bifat. **MVP-ul e validat.**
După închidere a rulat o **trecere de călire a plasei de teste** (16 iul.
2026): regresiile DOVEDITE reale fără gardă au primit teste prin
extrageri-la-pur — `src/filelistops.ts` (quotare .f + exclude outputDir +
`resolveLocPath`; `test:filelist`), `src/heuristics.ts` (regexurile de nume,
inclusiv `_ni/_bi`; `test:heuristics`), `src/configcheck.ts` (nucleul
validărilor model↔YAML: `checkConfig` întoarce findings structurate, config.ts
doar le mapează pe Diagnostic cu l10n — D19; `test:configcheck`),
`subenvName`/`subenvMapping`/`planWireEdits` în `src/compose.ts` (maparea
rel→subenv cu excluderea ambigue + planul editului multi-fișier cu pliere per
fișier partajat; `test:compose`), `edgeObstacles` în `schematic.ts`
(obstacolele din etichete: înălțime PIN_PITCH + excluderea pinilor de fir;
`test:router`), `probeCoverageAllowed` în `probe.ts` și `isComposedChild` în
`yamlops.ts` (compară căile NORMALIZAT — vechiul `includes(fsPath)` rata
diferențele de caz pe Windows). Tot atunci: cei doi octeți NUL bruți din
`yamlops.ts` (separatori de chei de dedup) au devenit secvențe `\0` escapate —
un NUL brut face ripgrep să trateze fișierul ca BINAR și-l exclude tăcut din
căutări.
Planul complet: `docs/06-plan-mvp.md`.
