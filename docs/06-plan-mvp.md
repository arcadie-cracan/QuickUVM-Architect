# 06 — Plan pe faze, riscuri și jurnalul deciziilor

## Faze

### Faza 0 — validarea backend-ului (ÎNCHEIATĂ)

Extractor pyslang funcțional (`backend/svmodel.py`) care produce modelul de
proiect complet, validat pe `examples/soc_top.sv` (design de regresie derivat
din exemplele QuickUVM, cu parametri propagați, generate, tablou unpacked,
interfață cu modporturi, conexiuni concat/select). Criteriile de verificare:
CLAUDE.md.

### Faza 1 — schelet de extensie + vederea-simbol read-only (ÎNCHEIATĂ)

Închisă în iul. 2026: implementată și verificată pe designul de regresie
(pytest verde, webview validat pe model real), iar criteriul de încheiere a
fost bifat interactiv pe un proiect Bender real — common_cells, top
`cdc_fifo_gray` (`examples-bender/`): ierarhie, vederea-simbol,
salt-la-sursă din pin.

- schelet `yo code` TypeScript; pornirea backend-ului ca proces copil, cu
  debounce la salvare; parsarea modelului contra schemei;
- tree view de ierarhie (nativ) din `instances[]`;
- webview cu vederea-simbol a unui modul: layout ELK complet, pini pe
  laturi, lățimi, pan/zoom, selecție simplă; temă VSCode;
- integrare Bender (`bender script flist-plus`, cu +incdir/+define) cu
  fallback glob/.f;
- teste: pytest pe extractor (criteriile din CLAUDE.md), snapshot pe modelul
  JSON al exemplului.

Criteriu de încheiere: deschizi un proiect Bender real, vezi ierarhia și
diagrama-simbol a oricărui modul, cu salt-la-sursă din pin.

### Faza 2 — configurare QuickUVM (nucleul valoric) (ÎNCHEIATĂ)

Închisă în iul. 2026: mutațiile YAML au teste Node (`npm run test:yamlops`),
fluxul DUT→agent→generate rulează cap-coadă pe `examples/` contra quick-uvm
0.9.1 real (`npm run test:e2e`), overlay-ul + inspectorul sunt validate pe
model real în harness de browser, iar criteriul de încheiere a fost bifat
interactiv în Extension Development Host: DUT setat din diagramă, agent din
selecție de pini, port ignorat, testbench generat — fără YAML scris de mână.

- overlay de configurare din YAML (parsare, culori agenți, indicator de
  acoperire); `WorkspaceEdit` pentru: setDut, createAgentFromPins,
  ignorePort; validările din doc. 03 ca diagnostice;
- inspectorul lateral (agenți, teste, project/clock);
- task `quick-uvm generate` + parsarea erorilor;
- agent din interfață (desfacerea modportului).

Criteriu de încheiere: de la un DUT real la un testbench QuickUVM care rulează,
fără a scrie YAML de mână (dar cu YAML-ul lizibil și corect la final).

### Faza 3 — vederea-schemă + poziții deținute de utilizator (ÎNCHEIATĂ)

Închisă în iul. 2026. Criteriul bifat pe common_cells (`examples-bender/`,
top `cdc_fifo_gray`): partea automată prin măturarea din harness pe modelul
real (8/8 vederi-schemă și 24/24 simboluri fără excepții, zero muchii prin
blocuri, drag → snapshot total D21, redeschidere exactă), iar partea
interactivă de utilizator în Extension Development Host — care a prins și a
dus la remedierea a cinci regresii reale (descoperirea config-ului activ,
avortul tăcut din checkDut, euristica `_ni`, fluxul recursiv al
compunerii, gesturile pe vederile ne-DUT) — vezi jurnalul de mai jos și
notele din secțiune.

- vederea-schemă din `views` (instanțe, interconect, pliaj generate) —
  **implementată read-only** (iul. 2026): scenă pură testată în Node
  (`test:scene`), layout ELK layered cu porturi de graniță pe straturi
  dedicate, navigare drill/breadcrumb/comutator, harness de browser;
- drag de noduri + sidecar — **implementate** (iul. 2026): mutații pure în
  `src/sidecarops.ts` (`test:sidecar`), serviciu host cu scriere atomică
  (temp+rename), watcher pentru editări externe, invalidare grațioasă cu
  restaurarea orfanelor reapărute, comanda „Clean Orphaned Layout Overrides",
  drag cu snap pe grilă și re-rutare naivă ortogonală a muchiilor (traseele
  ELK rămân doar pe vederi fără override-uri), pliaje persistate (camera e
  stare de sesiune — prima deschidere se încadrează mereu);
  pinii pe grilă prin construcție (porturi `FIXED_POS`, pas 16 — pin aliniat
  = fir drept) și răsturnare H/V per nod (reatribuirea sloturilor de pini,
  persistată în sidecar, tastele H/V + inspector);
- ELK interactiv pentru elemente noi + „Re-aranjează tot" explicit —
  **implementate** (iul. 2026): pozițiile utilizatorului devin semințe
  (strategii INTERACTIVE, fără cycleBreaking — conflict cu LAST_SEPARATE),
  se forțează exact după layout, doar elementele noi primesc poziții;
  butonul ⟲ + `relayout/request` șterg pozițiile vederii (pliaje/răsturnări
  rămân). Tot blocul de mai sus (drag, grilă, flip, lasso, fit, ELK
  interactiv, orfane) **bifat interactiv** în Extension Development Host pe
  examples/ (iul. 2026);
- ruter de interconexiuni: **prototipul propriu Lee/A* pe grilă implementat**
  (iul. 2026) — `src/webview/router.ts` (modul pur, `test:router`), interfața
  fixă `route(obstacles, requests, constraints) -> polilinii`, A* cu stare
  (celulă, direcție), penalizare pe coturi, obstacole umflate, culoar liber
  la ancore; ortogonalitate strictă pe grilă (ancorele se inserează, nu
  înlocuiesc punctele de grilă) și ocupanță pe celule pe orientări:
  suprapunerea paralelă cu alt net e practic interzisă (penalizare 8/celulă),
  traversarea perpendiculară permisă dar rară (2), doar cutiile blocurilor sunt
  ziduri absolute — haloul e cost mare (6/celulă), traversabil când blocurile
  stau mai aproape decât două halouri (firul se strecoară prin gol, nu prin
  blocuri); penalizare de
  proximitate pe inelul din jurul haloului (1/celulă — la egalitate de cost,
  traseul preferă canalul larg, nu lipirea de blocuri), muchiile aceluiași net
  împart liber trunchiul (fan-out); cererile se rutează scurte-întâi;
  halou configurabil în jurul obstacolelor (implicit 16px, cu culoar propriu
  la ancore) plus obstacole de text pentru etichetele/adnotările pinilor —
  traseele altor net-uri nu trec peste numele porturilor: textele sunt
  obstacole MOI (cost 10/celulă la traversare, nu zid — în canale strâmte
  ruterul trece peste o etichetă în loc să cadă pe fallback prin blocuri),
  intră ca margini `elk.margins` în layout, iar spațierile ELK sunt
  corelate cu haloul (88 între straturi, 48 între noduri — între două
  halouri încape mereu un culoar de fir); ruterul e sursa
  unică de trasee în toate vederile-schemă (lumea pe grilă e universală,
  ELK dă doar pozițiile), cu fallback naiv per muchie fără drum; ~2ms/re-rutare completă la drag pe
  designul de regresie. Decizia libavoid vs. propriu: închisă — D20 (ruterul
  propriu). Nivelul de override 4 (fir↔etichetă per net) implementat
  (iul. 2026): click pe traseu sau pe eticheta netului → secțiunea Net din
  inspector cu comutatorul „Show as label"/„Show as wire"; mesajul
  `net/render` (docs/05), persistență în sidecar sub `nets.<net>.render`
  doar la abatere de la sugestia din model, invalidare grațioasă cu
  `kind: net` (docs/04); teste în `test:sidecar` și `test:scene`. Nivelul 1
  (stil) amânat: există un singur stil (ortogonal), override-ul ar fi o
  setare fără opțiuni;
- createSubenv din instanță — implementat (iul. 2026, maparea în docs/03):
  butonul „Create subenv" din inspector pe blocurile selectate în
  vederea-schemă (+ comanda `quickuvm.createSubenv` din paletă), pliajele se
  desfac în membri, confirmare multi-select cu rezumatul config-urilor noi
  (schelet + dut euristic) și al constrângerilor H1 din QuickUVM (`params`
  cer `parameters:` în agentul blocului; copiii cu ceas acceptați din
  slice-ul M1 clocked-subenv — single-clock, cel mult un reset); mutația
  `createSubenvs` în yamlops (nume SV sanitizate, `params` doar întregi,
  `layout: packaged` asigurat, duplicate refuzate); teste în `test:yamlops`
  și scenariul 3 de compunere în `test:e2e` (top + 2 blocuri combinaționale
  + 1 bloc cu ceas, construite exclusiv prin yamlops → `quick-uvm generate`
  produce pachetele env per bloc, env-ul top, virtual sequencer-ul și
  tb_top; validat pe QuickUVM HEAD, iul. 2026); `createSubenv` bifat
  interactiv (sumar) în Extension Development Host — care a și prins o
  regresie: scaffold-urile de bloc câștigau alfabetic descoperirea
  config-ului activ și „furau" overlay-ul/acțiunile; remediat prin
  descoperire stabilă + excluderea copiilor referiți ca `subenvs[].config`
  (`topConfigPaths`, docs/03; tooltip pe butoanele dezactivate cu motivul).
  Validarea pe common_cells a mai prins trei: (1) `ConfigService.apply`
  împrospăta debounced, deci `checkDut` citea stare veche imediat după „Set
  this module as DUT" și acțiunea avorta tăcut — acum apply împrospătează
  sincron; (2) euristica activ-jos rata sufixele PULP `_ni`/`_bi`
  (`src_rst_ni` propus activ-sus) — regex extins; (3) fluxul recursiv nu
  avea cale curată: „Set as DUT" pe alt modul suprascria DUT-ul config-ului
  activ — acum întreabă explicit (suprascriere vs. config nou de bloc), iar
  comanda „Choose Active Config" comută între config-uri prin
  `quickuvm.configFile` (docs/03). În plus, gestul „Create subenv" e acum
  autonom pe vederile ne-DUT: butonul e activ oricând sunt blocuri
  selectate, iar nepotrivirea de DUT se rezolvă în flux (oferta de config
  dedicat blocului + Set as DUT, apoi propunerile continuă în același gest).
  Tot de aici: gesturile de agent funcționează și în vederea-schemă, pe
  steagurile de graniță ȘI pe pinii blocurilor copil (pinii unui bloc =
  porturile modulului lui — agentul se creează pentru config-ul blocului,
  cu `viewId`-ul blocului în `args` și rezolvarea DUT-ului în flux, ca la
  subenv; restricția la vederea-simbol era moștenire de fază 2, nu
  decizie); selecția mixtă dezactivează gestul, acțiunile pe pini primesc
  doar pinii rezolvați (blocurile se filtrează), inclusiv Ignore/Un-ignore.

Validarea de închidere pe common_cells (`examples-bender/`, top
`cdc_fifo_gray`, iul. 2026) — partea automată, prin harness pe modelul real
(`bender script flist-plus` → `svmodel` → `examples-bender/model-cdc.json`,
regenerabil oricând): toate cele 8 vederi-schemă randează fără nicio
excepție și cu **zero segmente de muchie prin blocuri** (metrica de calitate
a ruterului), toate cele 24 de simboluri randează, drag-ul persistă
snapshot-ul total (10/10 elemente — D21 pe model real), comutarea
fir↔etichetă funcționează cu mesajul de persistență corect; designul nu are
pliaje generate (comportamentul pliajelor rămâne acoperit de demo_top).
Pasul interactiv rămas: configurația de lansare „Rulează extensia (Bender:
common_cells)" — drag + redeschidere (sidecar), navigare, apoi faza 3 se
poate declara încheiată.

Criteriu de încheiere: pe un proiect Bender real, orice vedere-schemă se
deschide curată (fără muchii prin blocuri), pozițiile aranjate supraviețuiesc
redeschiderii, iar acțiunile de configurare (agenți, subenvs) funcționează
din diagramă.

### Faza 3b — vederea de verificare: editor grafic al configurației QuickUVM (ÎNCHEIATĂ)

Obiectiv (adăugat în iul. 2026, decizia D16): a treia vedere a extensiei — pe
lângă simbol și schemă (ambele ale RTL-ului) — este diagrama **mediului de
verificare însuși**, derivată din YAML: DUT-ul cu porturile mapate, agenții
(activ/pasiv, culorile overlay-ului), scoreboard-urile cu fluxurile
sursă/monitor, colectoarele de coverage, virtual sequencer-ul, iar pentru
bench-urile compuse (H1) subenv-urile cu `connections` și scoreboard-urile
trans-bloc. Editare **directă pe diagramă**, nu doar vizualizare:

- paletă de componente: scoreboard, coverage, virtual sequence — inserție prin
  drag pe diagramă → editare YAML (yamlops noi pentru `analysis`, `tests`,
  `virtual_sequences`);
- conectare cu mouse-ul: muchie agent→scoreboard (source/monitor),
  agent→coverage; proprietățile muchiei/componentei (match, match_key,
  max_latency…) în inspector;
- ștergere cu confirmare; orice gest = un `WorkspaceEdit` (undo/redo nativ);
- ID-uri stabile: numele agenților/scoreboard-urilor; cheia vederii
  `tb:<cale-config>`; pozițiile nodurilor în sidecar, ca la celelalte vederi;
- validări live în ConfigService (referință la agent inexistent, monitor ==
  source etc.) ca diagnostice pe YAML;
- probe whitebox din diagramă (QuickUVM 0.9.2, slice-ul K2, iul. 2026):
  `probes: [{name, path, width, enum?, clock?, coverage?}]` observă
  OBSERVE-only semnale interne prin XMR, cu `path` relativ la instanța DUT
  — proiectat explicit ca uneltele externe să-l emită. Gestul extensiei:
  selectezi un net (în orice vedere sub DUT) → „Create probe"; calea =
  calea elaborată a netului minus calea instanței DUT (invariantul 4 o dă
  direct), lățimea din model. Golul de model: svmodel nu emite azi
  tipurile enum ale net-urilor — probele tipizate (coverage simbolic pe
  FSM) cer extinderea extractorului; început cu width-only. Constrângere
  QuickUVM: probes nu merg încă pe bench-uri subsystem (H1);
- compunerea derivată din model (idee din validarea fazei 3, iul. 2026):
  net-urile dintre instanțele copil din vederea-schemă a părintelui sunt
  exact intrările `connections: [{from: bloc.port, to: bloc.port}]` ale
  compoziției H1 (și candidatele de `subenv_scoreboards` trans-bloc) —
  extensia le poate genera din model în loc să fie scrise de mână; plus
  pasul opțional „Compose into parent bench" la crearea unui bench de bloc
  (asigură config + intrarea `subenvs` pe fiecare nivel intermediar, pe
  calea cunoscută de la bench-ul rădăcină la vederea curentă);
- ambalaj final: `CustomEditor` pe `*.quickuvm.yaml` (diagrama TB ca editor
  implicit al fișierului, cu fallback text).

Dependență tare de faza 3: refolosește randarea multi-nod, ruterul de
interconexiuni, drag-ul cu persistență și invalidarea grațioasă — de aceea
vine după ea. YAML-ul rămâne sursa de adevăr; diagrama e o proiecție
editabilă, la fel ca overlay-ul din faza 2.

Referințe de design: jurnalul D22 — bigUML ca hartă de patternuri
(handleri generici conduși de metadate, edge type hints, property palette,
sincronizare text↔diagramă), GLSP/Sprotty respins ca stack; precedentele
externe validate acolo (AWS Workflow Studio, drawio, Structurizr/LikeC4)
confirmă combinația `CustomTextEditorProvider` + `WorkspaceEdit` minimal +
sidecar de geometrie.

Referințe suplimentare (sondaj iul. 2026, patru investigații paralele):

- **Kaoto + Apache KIE Tools** (Red Hat) — singurul designer grafic de
  producție peste YAML întreținut manual în VSCode; wiring-ul de copiat:
  gest → `WorkspaceEdit.replace` pe TextDocument (VSCode deține undo),
  supresie de ecou stop-listening/resubscribe, orice `onDidChangeTextDocument`
  → re-randare. Slăbiciunile lor (re-serializare integrală; păstrează doar
  comentariile de început) sunt exact punctele forte ale `yamlops.ts`.
- **Notația canonică Accellera UVM 1.2** (+ dialectul cookbook
  ClueLogic/ChipVerify): pătrat = port pe producător, cerc = export pe
  consumator, romb = analysis port pe monitor, sequencer desenat peste
  driver, pasiv = doar monitor, referințe punctate de la virtual sequencer
  la sequencerii agenților — glifele obligatorii ca diagrama să fie
  instantaneu familiară inginerilor de verificare.
- **DVT / Sigasi / Questa Visualizer** — principiul „doar informația
  vitală" (fără interne uvm_root/phase); detaliile de config/factory în
  inspector (aspect views, Verdi), nu pe canvas; click pe muchia de
  analysis → liniile YAML care au creat-o (Sigasi); porturi obligatorii
  neconectate în stil de eroare cu quick-fix (Riviera-PRO).
- **UVMF `yaml2uvmf`** (Siemens) — checklist-ul semantic al obiectelor pe
  care editorul 3b trebuie să le exprime (agenți activ/pasiv +
  initiator/responder, predictori, scoreboards cu exporturi numite
  expected/actual, conexiuni analysis explicite, subenv-uri imbricate);
  plasarea agentului în env (propriu/top/partajat) ca proprietate, nu ca
  gest (Doulos Easier UVM).
- **Gesturi**: pin-drop create menu (Unreal Blueprints — drag din pin pe
  canvas gol → meniu filtrat de creații legale, nodul apare gata conectat;
  gestul de bază al lui 3b: din pinii DUT → „New active/passive agent /
  Connect to scoreboard"); splice de nod pe fir + heal la ștergere
  (Node-RED/Blender); matricea de conectivitate monitor×scoreboard ca
  alternativă bulk la desenarea muchiilor (DVCon 2021); validare live la
  drag (`isValidConnection`, React Flow); undo la nivel de gest cu
  Escape = anulare (tldraw): un gest = un WorkspaceEdit = un pas de undo.

Ordinea de implementare (începută în iul. 2026):

1. **Felia 1 — vederea read-only** (implementată, iul. 2026): scena TB
   **ierarhică** (`src/webview/tbscene.ts` → `TbScene` cu containment UVM
   canonic; layout+desen ierarhic în `src/webview/tbschematic.ts` — ELK
   compound `INCLUDE_CHILDREN`, aplatizare la grilă, ruterul A* refolosit cu
   frunzele ca obstacole), mesajul `config/full`, `ViewMode: "tb"`, cheia
   `tb:<cale-config>`, comanda `openVerificationView`; teste `test:tbscene`.
   Containment: Testbench › {DUT, Env › {agent › {sequencer/driver/monitor},
   scoreboard, coverage, vsqr, subenv, probes}} — agentul e în Env, nu în
   DUT (răspuns la observația utilizatorului: agentul se CONECTEAZĂ la DUT,
   nu îl conține). **Drag + poziții TB implementate** (iul. 2026): aceeași
   mecanică ca RTL, cheiată per nivel (`tb:<config>|<focus>`), semințe ELK
   interactive, D21 total, ⟲.
2. Felia 2 — editarea. **Adăugarea implementată** (iul. 2026): paleta „Add
   component" din inspectorul TB (coverage/scoreboard/virtual sequence),
   agentul selectat preîncarcă sursa; conexiunile nu sunt muchii libere în
   QuickUVM (source/monitor sunt câmpuri), deci gestul creează componenta
   deja conectată; mutații yamlops `addScoreboard`/`addCoverage`/
   `addVirtualSequence` (flow maps, nume unice, idempotent) prin
   `WorkspaceEdit`; QuickPick-uri native pentru parametri (source/monitor/
   match+key, agenți, mod); teste `test:yamlops` + scenariul e2e extins
   (coverage + scoreboard adăugate → `generate` produce fișierele lor).
   **Ștergerea + editarea proprietăților implementate** (iul. 2026): mutații
   pure `removeScoreboard`/`removeCoverage`/`removeVirtualSequence`,
   `removeAgent` (cascadă: coverage-ul agentului, scoreboard-urile cu
   `source`/`monitor`==agent, pașii de vseq + secvențele rămase goale) și
   `setScoreboardField` (source/monitor/match/match_key/max_latency, cu
   curățare în cascadă: monitor gol → single-stream șterge match+match_key;
   match=in_order șterge match_key), toate cu curățarea blocurilor golite
   (`pruneEmptySeq`/`pruneEmptyMap`) și idempotente la țintă lipsă (`test:yamlops`).
   Acțiunile host `deleteComponent` (confirmare **modală** cu rezumatul
   cascadei la agent) și `editScoreboard` (editare **inline** în inspector:
   `<select>`/`<input>` per câmp → un `WorkspaceEdit` per schimbare). Inspectorul
   TB: buton Delete per componentă selectată (scoreboard/coverage/agent; vsqr →
   Delete per secvență) + editorul de proprietăți al scoreboard-ului. **Trei
   căi spre aceeași ștergere**, toate prin `tbDeleteTarget` (sursă unică de
   rezoluție id→nume) și aceeași confirmare modală a host-ului: butonul din
   inspector, **tasta** `Delete`/`Backspace` pe componenta selectată, și
   **meniul contextual** (clic-dreapta → Open / Flip H / Flip V / Delete, cu
   ștergerea marcată cromatic; pe `vsqr` câte o intrare per secvență; pe un
   steag de graniță doar Flip H; pe DUT/Env fără Delete). Handler-ul de taste e
   blindat să NU se declanșeze cât timp editezi un câmp din inspector
   (`INPUT`/`SELECT`/`TEXTAREA`). Validat în
   `scripts/harness.html?mode=tb` (mesajele `deleteComponent`/`editScoreboard`
   corecte pe toate tipurile, Delete pe DUT = no-op, tastele blocate în câmpuri,
   meniul se închide la Escape/clic-în-afară/zoom).
   **Scenariul e2e de ștergere** (`test:e2e`, scenariul 4) închide felia contra
   generatorului real: `removeAgent` cu cascadă → `quick-uvm generate` iese 0
   (o referință moartă — scoreboard cu `monitor` == agentul șters — ar fi fost
   refuzată de Pydantic) și artefactele agentului dispar. **A prins o regresie
   pe care testele pure n-o puteau vedea**: blocul `analysis:` comută QuickUVM
   între mod implicit (fără cheie → auto-cablează scoreboard + coverage la
   „primary agent") și declarat (cu cheie, chiar `{}` → cablează exact ce e
   listat). Curățarea blocului golit ar fi *reînviat* componentele tocmai
   șterse; mutațiile păstrează acum `analysis: {}` (vezi `keepAnalysis` în
   `yamlops.ts` și capcana din CLAUDE.md).
   **Ierarhia verificării** (a doua secțiune din sidebar, iul. 2026):
   „Verification Hierarchy" lângă „Design Hierarchy" — arborele mediului TB
   derivat din config (`tbtree-build.ts` pur + `tbtree.ts`), oglinda
   diagramei TB, cu navigare simetrică arbore↔diagramă (id-uri comune din
   `buildTbScene`); test `test:tbtree`.
3. Felia 3 — gesturile derivate din model. **Proba whitebox (K2) implementată**
   (iul. 2026): net selectat în vederea-schemă → „Create probe" (`createProbe
   {net}`); toată deducerea stă în modulul **pur** `src/probe.ts`
   (`proposeProbe`): rezolvă instanța DUT (YAML dă numele de MODUL, nu calea),
   calculează calea XMR relativă la ea, derivă lățimea și refuză cu motiv
   explicit exact acolo unde generatorul ar refuza (H1 subsistem, unpacked,
   interfață, port deja mapat pe agent, vedere din afara DUT-ului); mutații
   `addProbe`/`removeProbe`; teste `test:probe` (15, pe modelul real) +
   `test:e2e` scenariul 5 (XMR-ul `assign probe_if.x = dut_inst.<path>` ajunge
   în tb_top; `coverage: true` → `probe_monitor`; H1 confirmat empiric).
   **Două limite reale, descoperite prin sondarea generatorului** (detaliate în
   CLAUDE.md): lățimea nu e în model și derivarea naivă e greșită (`select`/
   `concat` mint), iar semnalele interne PURE (registre de stare, fire din
   `assign`) nu sunt sondabile — modelul emite net-uri doar din conexiunile
   porturilor instanțelor-copil; extinderea ar cere schimbarea extractorului.
   **Compunerea derivată implementată** (iul. 2026): `deriveConnections` în
   modulul **pur** `src/compose.ts` (`test:compose`) transformă net-urile
   inter-bloc ale vederii-schemă a subsistemului (un net fără capăt `<port>.X`,
   cu o ieșire → una+ intrări între subenv-uri) în `connections: [{from, to}]`,
   cu direcția din `port.dir` și lățimea din model; refuză multi-driver și
   nepotrivirile de lățime. Gestul „Wire connections from design" (buton în
   Actions la subsistem) scrie `connections` prin `addConnections` ȘI **pune
   automat pasivi** agenții blocurilor-destinație (`setAgentActive(false)` pe
   config-urile copil) — un `WorkspaceEdit` ATOMIC pe mai multe fișiere (un
   singur undo); dacă un copil n-are încă agent, avertizează să-l configureze
   pasiv. E un gest SEPARAT de `createSubenv` fiindcă firele cablează porturi de
   interfață de agent, deci copiii trebuie să aibă agenți întâi. `test:e2e`
   scenariul 6: `addConnections` → `assign` fizic inter-bloc în tb_top; **un
   agent-destinație ACTIV e refuzat de generator, iar `setAgentActive(pasiv) îl
   repară** (dovadă că flip-ul produce un bench care se generează);
   `removeConnection` → firul dispare. Contractul (endpoint = `<subenv>.<port>`,
   dest pasiv, lățimi egale) a fost re-sondat empiric pe build-ul curent
   (capcane în CLAUDE.md). **„Compose into parent bench" implementat** (iul.
   2026), dar RECONCILIAT cu regulile de compunere călite din quick-uvm (sondate
   empiric): (a) un subsistem cere **≥2 subenv-uri** (1 → refuzat), deci
   „compune calea cu un subenv per nivel" din planul original e INVALID; (b) un
   bench cu `subenvs` **nu poate avea agenți proprii** (hibridul e interzis — un
   nivel de compunere e subsistem PUR); (c) nesting-ul FUNCȚIONEAZĂ (un subenv
   poate fi el însuși subsistem). Decizia (aleasă de utilizator): gestul e „un
   nivel, din copil" — din vederea unui bloc, compune blocul + FRAȚII lui de
   bloc în părintele imediat (`parentComposition` pur în `src/compose.ts`,
   `test:compose`; deleagă la `createSubenv`), refuzând când părintele are <2
   blocuri componibile. Fără cascadă recursivă (ar lovi ≥2 la nivelurile cu un
   singur copil). **Divergența „hibrid interzis" atacată** (iul. 2026): fiindcă
   quick-uvm curent respinge un bench cu `subenvs` + agenți proprii (`agents: []`
   e OK, doar nevid + subenvs e refuzat — sondat), extensia (a) pune un
   **diagnostic dur** pe blocul `agents` când un config e hibrid (`ConfigService`,
   detecție universală: și pentru YAML scris de mână), (b) **avertizează modal**
   în `createSubenv`/`composeIntoParent` înainte să compună într-un config care
   are deja agenți, (c) corectează comentariile care descriau hibridul ca valid
   (`hasDut`, CLAUDE.md). `test:e2e` blochează regula (hibrid → `generate`
   eșuează). **Felia 3 e ÎNCHEIATĂ.**
4. Felia 4 — ambalajul `CustomTextEditorProvider` pe `*.quickuvm.yaml`
   (wiring-ul Kaoto/KIE din D22) + validarea de închidere. **Implementat** (iul.
   2026): `QuvmConfigEditor` (`src/customeditor.ts`) e editorul IMPLICIT
   (`priority: default`) al `*.quickuvm.yaml` — deschizi fișierul → vezi diagrama
   de verificare TB, cu fallback text nativ („Reopen Editor With… → Text
   Editor"). Diagrama TB e config-driven (`renderTb` nu atinge modelul RTL),
   deci se randează din textul documentului; layout-ul (drag/flip/pliaj) merge
   prin sidecar-ul COMUN (cheiat `tb:<cale>`), iar gesturile de editare
   (add/delete/edit) aplică pe DOCUMENT prin `WorkspaceEdit` — undo/diff/editare
   text native (invariantul 2). Cheia refactorului: interfața **`TbEditTarget`**
   (`current`/`configUri`/`apply`) pe care ConfigService o satisface (config-ul
   ACTIV) și `DocumentEditTarget` o implementează (documentul deschis), iar
   gesturile de editare TB din `actions.ts` iau un parametru `cfg: TbEditTarget =
   this.config` — deci ACELEAȘI metode (inclusiv QuickPick-urile) merg pe oricare
   țintă, zero duplicare. Orice schimbare de text (editare, undo, gestul propriu)
   → `config/full` → re-randare (idempotent, fără buclă). Validat în harness cu
   `?nomodel=1` (vederea TB + editarea funcționează DOAR din config).
   **Tutorial pas-cu-pas pentru validarea manuală**:
   `docs/tutorial-yapp-router.md` (fixtura `examples-yapp/yapp_router.sv` +
   configurația de lansare „tutorial: yapp_router"); pașii sunt verificați
   empiric — designul se parsează cu svmodel și config-ul rezultat generează
   curat cu quick-uvm (ambele variante de scoreboard). **Pasul manual de
   închidere e BIFAT** (16 iul. 2026): utilizatorul a parcurs integral
   tutorialul în Extension Development Host; pe parcurs au ieșit și două
   rafinări reale (alinierea constantă a etichetelor de pin la flip;
   suprapunerea fan-out/fan-in lângă capătul comun în ruter — `fanoutRadius`,
   docs/04), ambele implementate și testate.

Criteriu de încheiere: un mediu cu ≥2 agenți, un scoreboard two-stream și un
colector de coverage, construit și re-aranjat integral grafic (fără editor de
text), cu YAML lizibil la final și `quick-uvm generate` curat. **Bifat —
MVP-ul e validat** (16 iul. 2026, tutorialul yapp_router).

După închidere a rulat o **trecere de călire a plasei de teste** (16 iul.
2026, audit multi-agent + recenzie adversarială): golul sistematic era că
orchestrarea care importă `vscode` nu avea nicio acoperire, iar câteva
regresii DOVEDITE reale nu aveau gardă. Remediat prin extrageri-la-pur, fără
schimbări de comportament: `filelistops.ts` (quotarea .f, excluderea
outputDir, `resolveLocPath` — `test:filelist`), `heuristics.ts` (regexurile
de nume, inclusiv capcana `_ni/_bi` — `test:heuristics`), `configcheck.ts`
(nucleul validărilor model↔YAML ca findings structurate, mesajele l10n rămân
în host per D19 — `test:configcheck`), `subenvMapping`+`planWireEdits` în
`compose.ts` (maparea rel→subenv + planul editului multi-fișier al cablării
H1, cu invarianții #3/#4 blocați în teste — `test:compose`), `edgeObstacles`
în `schematic.ts` (capcanele 13/14 — `test:router`), `probeCoverageAllowed`
(`test:probe`) și `isComposedChild` (`test:yamlops`, cu comparație de căi
normalizată — vechiul `includes(fsPath)` rata diferențele de caz pe Windows).
Recenzia adversarială a refactorurilor a confirmat echivalența semantică
(diff pe codul vechi, două suspiciuni respinse cu probe) și a găsit **un bug
real pre-existent**, dublu-confirmat pe generatorul instalat: pasivizarea
cabla doar PRIMUL agent al unui bloc destinație — cu porturi conduse
deținute de agenți diferiți, al doilea rămânea activ, `generate` refuza, iar
gestul raporta succes. Remediat în `planWireEdits` (`filter`, nu `find`;
toți agenții proprietari devin pasivi) + test de regresie; capcana în
CLAUDE.md (invariantul #5 al compunerii).

După călire a urmat o **trecere de curățenie a loose-end-urilor** (16 iul.
2026, dintr-un audit paralel al stării MVP): (a) mesajul `node/moved` a fost
**retras din contract** — mort după D21 (drag-ul trimite doar
`layout/snapshot`), scos din protocol/panel/customeditor/sidecar/harness +
docs/05; (b) antetul `protocol.ts` (contractul) și comentariile „not
implemented" rămase au fost aduse la zi, iar `default`-ul din `onAction`
(host) e acum o **gardă de exhaustivitate** (`never`) care prinde la
compilare un `ActionKind` nou fără handler; (c) resturile de nume „QuickXray"
post-D17 (interfața `QuvmXQuickuvmArchitect`, nota D15); (d) **drill-ul în
subenv** — singura lipsă reală de navigare: un bloc `«subenv»` cu config e
drillabil, iar dublu-clic/Open trimite `openSubenvConfig` cu **calea
config-ului** (nu numele), pe care host-ul o deschide cu editorul implicit
(diagrama TB per-fișier, felia 4); merge din panel și din editorul
per-fișier (nesting H1). Recenzia adversarială a confirmat 3 defecte reale,
toate remediate: drill-ul purta numele (nume duplicate → deschidea tăcut
fișierul greșit) — acum poartă calea + id de nod deduplicat (`#n`, ca
`usedSb`); căile absolute erau lipite ca relative (`Uri.joinPath`) — acum
`path.isAbsolute` → `Uri.file`, ca `pathlib` în quick-uvm; și o referință
stale la `node/moved` în CLAUDE.md. Toate cele 12 suite + typecheck/build
verzi; drill-ul validat în harness (nume duplicat + cale absolută).

### Faza 4 — finisaj

- override-uri nivel 2 (ordinea pinilor) și, la cerere demonstrată, nivel 3
  (waypoints relative);
- vocabular de desen îmbogățit — **core-ul IMPLEMENTAT** (iul. 2026, ales de
  utilizator din audit): **etichete slash+lățime pe buse cu gradare pe clase**
  (`ScenePin`/`SceneBPort`/`SceneEdge` poartă `width`; pinul/steagul arată
  `/N` — combinat `/16×3` la unpacked —, iar firul/stub-ul se îngroașă pe
  clase w-s/w-m/w-l prin `widthClass`; lățimea netului pe muchie e derivată
  prin `netWidth` din `probe.ts`, DOAR de la un capăt cu același semnal,
  niciodată prin select/concat) și **junction dots doar la T** (`junctionDots`
  pur în `schematic.ts`, consumat în `routeEdges`: pentru fiecare vârf al
  netului numără direcțiile cardinale distincte — T = exact 3, niciodată 2=cot
  sau 4=încrucișare; grupat pe net, deci încrucișările a două net-uri diferite
  nu produc punct; `test:scene`+`test:router`). **Rămân**: glife split/join
  pentru slice/concat + cutii de constante (netlistsvg — cer câmpuri
  structurate pe `ScenePin`), secțiuni de pini cu titlu în vederea-simbol
  (symbolator — cer o taxonomie ne-modelată, decizie de design). **Glifele de
  adnotare — IMPLEMENTATE** (iul. 2026): `ScenePin.noteKind` (discriminator
  pur, `noteOf` în scene.ts) alege glifa — `const` = cutie tie-cell, slice/
  concat = **chip de accent cu parantezele SV** (`{}` concat / `[]` select),
  `nc` = cerc; `estPinText` rezervă `GLYPH_W` în margini ȘI obstacole;
  `test:scene` (noteKind pe model real). Chip-ul a înlocuit pana split/join
  netlistsvg inițială la finisaj (iul. 2026): pana era plină și converge spre
  bloc, deci se citea ca un al doilea **cap de săgeată** peste săgeata de
  direcție a firelor. Triaj adversarial pe 8 familii de rezolvare (workflow
  multi-agent, scor „arrow-confusability"): concluzia — vinovatul e vârful plin
  orientat de-a lungul firului, nu forma în sine; scapă doar formele fără vârf /
  categoric ne-fir. Prima iterație a fost un romb cu semn de lățime `+`/`−`, dar
  semnul cerea un mnemonic; înlocuit cu **parantezele SV literale** (`{}`/`[]`)
  într-un chip de accent — sintaxa însăși, zero mnemonic. Textul `{…}`/`[hi:lo]`
  rămâne purtătorul de sens la „decorations off" (chip-ul e decorație, ascuns
  acolo; nota nu se scoate). Tot la finisaj s-au reparat centrarea verticală a
  parantezelor pe fir (`dominant-baseline: central`) și lizibilitatea (chip cu
  fundal OPAC — `color-mix` cu `editor-background`, nu `transparent` — care
  maschează firul de dedesubt, ca tie-cell-ul de constantă). **Eticheta
  portului** a trecut la ordinea de declarare SystemVerilog (`portLabel` pur,
  `test:scene`): dimensiunile packed înaintea numelui (din `elem_width`),
  unpacked după (din sufixul `type` de după `$`) — `[15:0]ch_out[0:2]` în loc
  de `ch_out[15:0]`, care prezenta un tablou unpacked ca vector plat de 16 biți
  și contrazicea selecturile `[0]`/`[1]`/`[2]`; tooltip-ul s-a curățat de
  separatorul intern `$`. Adnotarea de lățime de pe fir rămâne (`16×3`, alegerea
  utilizatorului — lățimea totală vizibilă la o privire). Eticheta e **compactă
  (fără spații)** cu **dimensiunile colorate discret** (`portLabelText` +
  `splitLabel` puri; tspan `.dim` cu `fill-opacity: 0.55` care urmează culoarea
  numelui) — economisește lățime fără să piardă lizibilitatea (cererea
  utilizatorului). La aceeași trecere s-a prins și un bug de lățime: `measurer`
  măsura etichetele monospace cu fontul UI proporțional (mai îngust) →
  subestimare → porturi vest/est suprapuse; `measurer(mono)` măsoară acum cu
  fontul editorului. Ambele vederi (schemă + simbol) folosesc `portLabel`.
  Rafinări ulterioare ale chip-ului concat/select (cererea utilizatorului): `GAP`
  față de port (nu se mai suprapune cu eticheta de lățime / nota), fundal opac
  (maschează firul), și `centerChipSigns` — o trecere post-randare care măsoară
  cutiile reale și centrează semnul `{}`/`[]` în dreptunghi, independent de
  metrica fontului. **Săgeata de direcție a firelor RTL a fost scoasă**
  (`marker-end` din `edgeElement`) — direcția e implicită din latura portului
  (vest=intrare, est=ieșire); în vederea TB săgețile rămân (in/out/inout).
  **Firul traversează marcatorul concat/select ORIZONTAL** (cererea
  utilizatorului): pinii cu marcator au stub extins la `MARKER_STUB` și ancora de
  rutare mutată tot acolo, deci trunchiul fanout-ului se leagă dincolo de chip
  (nu-l mai taie vertical) și doar stub-ul orizontal îl traversează. Prima
  încercare (obstacol de rutare care să împingă trunchiul) a fost respinsă —
  obstacolul respingea și ramura orizontală, firul ocolea chip-ul. **Pinul
  străpunge vizibil chip-ul** (cererea utilizatorului, 19 iul. 2026):
  `MARKER_TAIL` (=12px) prelungește stub-ul dincolo de marginea exterioară a
  chip-ului (36→48, multiplu de 8 — vârf/ancoră PE GRILĂ); înainte stub-ul se
  oprea exact la margine și părea ascuns sub dreptunghi, firul părea să
  izvorască din chip. Tranziția de grosime stub→net cade acum la vârf,
  coliniară (fără colț), deci fără îmbinări rupte (docs/04). **Steagurile
  de graniță s-au compactat** (padding 26→16 la lățime), margini mai strânse
  între etichetă și margini. **Junction dots la contopire** (cererea
  utilizatorului): `junctionDots` marchează acum ≥3 direcții la un vârf (T sau
  contopire 4-way a aceluiași net), nu doar T-uri, iar **fan-in-ul unei
  magistrale se desenează ca PIEPTENE** (`combPolys` pur, `test:router`): un
  trunchi vertical + o priză orizontală per capăt, cu punct la fiecare T
  interior — în loc de o STEA care converge în sink (un 4-way). Se aplică doar
  când prizele nu taie blocuri (`combClear`). Spina (priza de sus + trunchi +
  priza de jos) e o singură polilinie, ca colțurile de capăt să aibă jonctiune
  (miter), fără gol la îmbinare. **Navigare & aranjare** (cererea utilizatorului):
  **săgețile derulează** viewport-ul (pan din tastatură, convenție de scroll, pas
  mare cu Shift, persistă ca la mouse), iar la **drag apar ghidaje de aliniere pe
  CAPETELE PINILOR** (`alignSnap`+`pinTipOffsets` pur, `test:router`; cererea
  utilizatorului): capetele pinilor (vârfurile stub-urilor, cu marcajele
  `{}`/`[]`) blocului apucat se aliniază la cel mai apropiat capăt de pin al
  altui bloc (~6px ecran, peste snap-ul de grilă) cu o linie punctată
  `.align-guide` — două capete la același y ⇒ fir orizontal drept, iar ghidajul
  vertical trece prin vârfurile pinilor, NU prin marginile blocului.
  **Minimap** (cererea utilizatorului, 19 iul. 2026): navigator de ansamblu în
  colțul dreapta-jos (RTL + TB) — miniatura scenei prin `<use href="#viewport">`
  (copie vie, zero re-randare) + dreptunghiul zonei vizibile; click/drag
  centrează camera, tasta M comută; nu intră în exportul SVG. Geometria pură în
  `src/webview/minimap.ts` (`test:minimap`, 6 teste — încadrare, transformul
  `U = M ∘ V⁻¹`, dus-întors salt↔dreptunghi de vedere). **Recenzia adversarială
  a minimapului** (19 iul. 2026, 5 dimensiuni × verificatori sceptici): 7
  descoperiri brute → 3 defecte reale confirmate, toate reparate + verificate
  empiric în harness (nu le reintroduce): (1) `mmDragging` rămânea blocat
  `true` fără `pointercancel`/`lostpointercapture` și când hit-rect-ul (singurul
  care-l reseta la pointerup) dispărea mid-drag la re-randare/toggle M — hover
  fără buton pana camera; flag-ul se resetează acum pe toate căile de anulare
  ȘI la reconstrucția/scoaterea minimapului. (2) `stopPropagation` pe
  `pointerup` era necondiționat: un gest de canvas sub-prag (lasso/drag <
  DRAG_MIN, încă fără captură) eliberat peste minimap își pierdea curățarea →
  marquee/drag fantomă; acum se oprește propagarea DOAR când gestul e al
  minimapului (`mmDragging`). (3) drag-end actualiza minimapul dar lăsa
  `contentBounds` pe limitele pre-drag → un resize cu autoCam încadra divergent
  de minimap; drag-end recalculează acum și `contentBounds` (ca `fitView`).
  Matematica pură a ieșit curată (compunerea `U = M ∘ V⁻¹` verificată algebric
  de recenzent). **Sincronizarea editor→diagramă** (cererea utilizatorului, 19
  iul. 2026; deciziile prin AskUserQuestion: doar evidențiere + comandă,
  halou separat persistent): urmărirea cursorului din sursele SV aprinde un
  halou `.xprobe` (galben, distinct de selecție, doar în vederea curentă —
  non-invaziv), iar comanda „Reveal in Diagram" (meniul contextual al
  editorului) navighează la element. Mesaj nou `probe/highlight` (docs/05);
  rezoluția (fișier,linie)→țintă și maparea țintă→id-uri de vedere sunt pure
  (`src/locmap.ts`: `buildLocIndex`/`resolveLoc`/`probeIds`; `test:locmap`,
  14 teste pe modelul real — exact-pe-linie cu port>instanță>modul,
  cuprindere de deasupra, instanțele generate de pe aceeași linie, pliaje
  prin `memberPaths`); haloul se recalculează în `applySelectionClasses`,
  deci supraviețuiește re-randărilor și se remapează la expandarea pliajului.
  **Recenzia adversarială a sincronizării** (19 iul. 2026, 5 dimensiuni ×
  sceptici): 13 brute → 8 defecte distincte confirmate, toate reparate (nu le
  reintroduce): (1) exportul SVG cocea haloul `.xprobe` în fișier — scos de pe
  clonă ca `.selected`; (2) „Reveal in Diagram" pe linia generate naviga dar
  selecta NIMIC cu pliajul închis — `remapSelection` (pur) în `presentScene`
  remapează rel-urile membrilor pe pliaj; (3) `select/reveal` nu făcea ecou —
  `postSelection()` ține host-ul sincron; (4) fixtura `examples/model.json`
  era DEJA învechită față de soc_top.sv (deriva pre-existentă: linia goală 22
  adăugată pe 11 iul.; poarta pytest a backend-ului era roșie) — regenerată,
  test-locmap actualizat (g_ch pe 24), pytest verde; (5) `lastProbe` nu se
  reseta la reîncărcarea webview-ului — halou pierdut la ținte identice; (6)
  antetul top-ului dezvăluia simbolul deși avea schemă; (7) regexul meniului
  era sensibil la caz (`.SV` fără intrare); (8) harta cale→modul se
  reconstruia per `applySelectionClasses` (per pointermove la lasso) —
  memoizată pe referința modelului. Limitare cunoscută, documentată în
  docs/04: cuprinderea nu vede granițele dintre module (fără end-loc în
  model). **Decorațiile de stare quick-uvm** (cererea utilizatorului, 19 iul.
  2026; deciziile prin AskUserQuestion: ambele surse, badge în colț +
  tooltip): validările model↔YAML ca badge-uri ⚠/✕ pe elementele vizate
  (pini RTL ai DUT-ului, blocuri de agent TB, Env cu bubble-up la rădăcină)
  + rezultatul ultimului generate ca cip `✓/✕ generate` în antet (inclusiv
  ENOENT). Mesaj nou `status/decorations` (docs/05); derivarea
  findings→decorații și maparea decorații→id-uri sunt pure (`src/status.ts`,
  `test:status`, 6 teste); `checkConfig` emite acum și `agent` în params la
  `width-mismatch`/`port-orphan` (țintirea blocului de agent). Badge-urile
  nu intră în exportul SVG; detaliile în docs/04. Seria de
  finisaj a trecut o **recenzie adversarială multi-agent** (19 iul. 2026: 6
  dimensiuni — consistența stub/ancoră/capăt, pieptene+joncțiuni, ghidaje,
  etichete+măsurare, interacțiune/cameră, invarianți — fiecare descoperire
  contra-verificată de un sceptic independent): 4 descoperiri brute, toate
  refuzate, 0 confirmate. Limitare CUNOSCUTĂ și acceptată (by design, nu bug):
  o aliniere pe X între capete cu stub-uri DIFERITE (marcator 36 vs normal 10,
  sau vest↔est) cade off-grid și se așază la următoarea randare cu ≤4px
  (lumea pe grilă e universală — rotunjirea la GRID e invariantul, nu
  fidelitatea sub-grilă); alinierile uzuale (același stub, aceeași latură) și
  TOATE alinierile pe Y rămân exacte (offseturile y sunt multipli de 8).
  **Secțiuni de pini pe rol — IMPLEMENTATE** (iul. 2026): în vederea-simbol,
  grupul ceas/reset (deja separat de `buildPins`) primește gap + divizor punctat
  + eticheta „clock / reset" (`draw` deplasează grupul, mărește cutia); doar
  când modulul are ceas/reset. **Vocabularul de desen e ÎNCHEIAT.**
  **Validat**
  vizual în EDH** (iul. 2026), cu patru rafinări: (a) firul folosește o culoare
  OPACĂ amestecată cu fundalul, nu `opacity` — firele aceluiași net care împart
  trunchiul (waive-ul de fan-out) își cumulau transparența și dădeau un efect
  de gradient la suprapunere; (b) setarea `quickuvm.schematicDecorations`
  (implicit pornit) ascunde slash/`/N`/junction dots prin clasa `decor-off` pe
  canvas (gradarea grosimii rămâne); (c) comutatorul fir/etichetă e
  descoperibil de pe orice pin/steag (inspectorul derivă netul din
  muchii/etichetă); (d) nudge anti-suprapunere la expandarea unui pliaj pe
  vederi aranjate (D21 pinuiește vecinii → membrii noi se mută la loc liber
  cu `freeSpot`, fără să atingă blocurile utilizatorului);
- trasare interactivă: **Shift+click = conul amonte/aval — IMPLEMENTAT**
  (iul. 2026): `netCone`+`coneOf` puri în `scene.ts` (BFS pe muchii wire după
  direcție + iface în ambele sensuri + net-uri `render=label` prin
  `pin.nets`/`bport.nets`; `test:scene`), gest Shift(+Alt) în vederea-schemă;
  **cross-probing la hover — IMPLEMENTAT** (staționare ~300 ms → revelare
  ne-intruzivă în editoarele deja vizibile, `openSource {peek}`, setarea
  `quickuvm.hoverCrossProbe`); ghiduri de aliniere echidistante și minimap la
  vederi mari — rămân;
- **export SVG — IMPLEMENTAT** (iul. 2026): butonul ⤓ / comanda
  `quickuvm.exportSvg` → SVG autonom (stiluri calculate inline-uite pe o clonă
  atașată off-screen — fără `:hover`/`:selected` copt; `viewBox` pe conținut;
  fundal copt); **PDF amânat** — SVG-ul se convertește curat cu unelte externe,
  iar o bibliotecă PDF în webview nu-și justifică greutatea (D5 anticipa
  exportul vectorial „trivial" — corect pe fond, dar trivial doar după
  inline-area stilurilor);
- sincronizare editor→diagramă (reveal din poziția cursorului) — rămâne;
- vocabular de desen îmbogățit, ghiduri de aliniere, minimap, decorații
  `quick-uvm status` — rămân;
- override-uri nivel 2/3 — rămân (nivel 3 blocat de ruter, D7: la cerere);
- performanță pe proiecte mari (măsurare înainte de optimizare).

**Validarea manuală a quick wins-urilor** (Extension Development Host, 16
iul. 2026) a confirmat gesturile și a adus trei constatări, toate rezolvate:
(1) exportul de pe ecranul de bun-venit deschidea dialogul de salvare —
`render()` lasă viewport-ul populat sub overlay, deci gate-ul de gol se ia
acum după overlay-ul vizibil, nu doar după DOM (sub un **banner** exportul
rămâne permis: dedesubt e ultimul desen valid, invariantul 5); (2) **meniu
contextual în vederile RTL** — clic-dreapta oferă „Go to source" pe
blocuri/pini/steaguri (aceeași rezoluție ca dublu-click-ul), „Open schematic"
pe blocurile cu schemă, Expand/Re-fold pe pliaje și Flip H/V (docs/05); (3)
**undo/redo de poziții** — Ctrl+Z/Ctrl+Shift+Z (sau Ctrl+Y): istoric de
sesiune per cheie de layout (RTL per vedere, TB per nivel) care anulează
mutările de blocuri și ⟲, fiecare pas restaurat persistându-se prin
`layout/snapshot` (docs/04); validate în harness (drag simulat → undo la
poziția exactă → redo; meniul pe toate țintele; exportul gol pe welcome).

Cele trei quick wins au trecut prin **recenzie adversarială** (iul. 2026, 3
recenzori × verificatori): 7 defecte reale confirmate, toate remediate — cel
mai important, conul prin net-uri `render=label` nu vedea steagurile de
graniță (`SceneBPort` a primit `nets`, `netCone` le traversează cu regula
inversă: portul de INTRARE al vederii conduce), iar Shift+click pe interiorul
unui pin devenea un net inexistent care distrugea selecția (`coneOf`
clasifică robust ținta). Plus la export: `text-transform`/`text-decoration`
lipseau din stilurile inline-uite (titluri TB lowercase, porturi ignorate
fără line-through), `:hover` se cocea în artefact (rezolvat prin citirea pe
clona off-screen), și anularea peek-ului la `pointerdown`/`pointerleave`.

**A doua rundă de validare** (Extension Development Host) a mai adus trei:
(1) exportul din paletă mergea și cu tab-ul Welcome/sursă activ — comanda
țintește acum **exporter-ul ACTIV** (registru de sesiune în `panel.ts`:
panoul RTL/TB și editorul per-fișier se înregistrează pe `onDidChangeViewState`
când sunt `active`, se scot la blur/dispose; comanda exportă doar tab-ul de
diagramă vizibil); (2) meniul contextual RTL rămânea deschis când schimbai
selecția în Design Hierarchy — clic în arbore e în afara iframe-ului, deci nu
produce pointerdown în webview; se închide acum și la `blur` (docs/05); (3)
„Go to source" lipsea pe **pliaje** (nu au `instPath` propriu) — membrii unui
pliaj împart același modul (criteriul plierii), deci definiția se deschide
prin primul membru derivat din id (`g_ch[0..2].u_ch` → `g_ch[0].u_ch`).
Fixtură nouă pentru cross-probing: `examples-probe/deep_pipe.sv` — 8 module
într-un singur fișier (porturi la liniile 19…195), instanțiate în lanț de
`deep_pipe`, ca hover-ul pe pinii `u_a…u_h` să deruleze vizibil sursa
(configurația de lansare „cross-probing: deep_pipe").

### Faza 5 — post-MVP (bucla de feedback a generării + paritate de schemă)

MVP-ul (Fazele 0–4) e închis. Continuarea planului — trei direcții cerute de
utilizator (decorația elementelor negenerate, generarea incrementală per-element,
paritatea GUI ↔ schema QuickUVM) — e detaliată separat în
[`docs/07-plan-post-mvp.md`](07-plan-post-mvp.md): o fundație comună (manifestul de
generare QuickUVM) deblochează liniile 1–2, iar linia 3 (paritate) merge în paralel,
începând cu reparațiile de paritate negativă (agenți inout/hibrizi blocați de gărzi
stale de la 1.0).

## Riscuri principale și atenuări

| Risc | Atenuare |
|---|---|
| dump/model mare pe designuri industriale | modelul e deja compact (nu AST-ul brut); la nevoie, emitere per-vedere la cerere |
| slang whole-design la fiecare salvare | debounce + măsurare; slang e rapid; abia apoi cache/incremental |
| schema AST/API pyslang se schimbă între versiuni | versiune pinuită în `requirements.txt`; testele de regresie prind divergențele |
| cod care nu compilează în timpul editării | `model/stale`: ultimul model valid rămâne; nu e blocant pentru MVP |
| rutarea devine gaură de timp | ordinea 1→4→2→(3); nivelul 4 (etichete) taie majoritatea cazurilor grele |
| suprapunere funcțională cu TerosHDL percepută ca duplicare | poziționare clară: bucla diagramă→config e diferențiatorul; vizualizarea e mijloc |

## Jurnalul deciziilor

| # | Decizie | Motiv (rezumat) | Alternativa respinsă |
|---|---|---|---|
| D1 | backend semantic = slang (pyslang) | elaborare completă: lățimi numerice, generate desfăcut, parametri per instanță, interfețe/modporturi semantice; robust pe cod incomplet; cel mai rapid/conform (suita ChipsAlliance) | sv-parser+svinst: parse-only, lățimi simbolice ar fi cerut evaluator propriu; svinst neîntreținut din 2022. Verible: fără elaborare, CST declarat instabil. Surelog/UHDM: integrare grea (Cap'n Proto/VPI), mai lent |
| D2 | model de proiect JSON ca contract stabil, backend în spatele unui adaptor | backend înlocuibil fără a atinge UI; prototipul pyslang nu blochează un viitor tool C++ pe libslang | cuplare directă UI↔API slang |
| D3 | Bender ca sursă a listei de fișiere | manifest+lock deja standard în fluxul vizat; separă RTL de mediul generat prin target-uri | ghicirea prin glob (rămâne fallback) |
| D4 | layout: ELK layered inițial + poziții deținute de utilizator + ELK interactiv pentru elemente noi | modelul mental din schematics (unealta propune, omul dispune); memoria spațială protejată | re-layout automat continuu; yFiles/GoJS (licență); React Flow (dependență React, fără rutare ortogonală nativă); JointJS (model de date propriu — reevaluabil dacă apare nevoia de rutare interactivă) |
| D5 | randare SVG proprie în webview | hit-testing nativ, overlay prin CSS, export vectorial; modelul de date rămâne al nostru | canvas; framework-uri de diagramming |
| D6 | ruter de interconexiuni separat de layout | pozițiile libere invalidează rutarea ELK | rutare doar la re-layout total |
| D7 | override-uri de rutare pe 4 niveluri, implementate 1→4→2→(3) | nivelul 4 (fir↔etichetă) e practica EDA și elimină majoritatea cazurilor grele ieftin; waypoints doar relative | waypoints absolute (fragile); doar rutare automată |
| D8 | YAML QuickUVM = sursă de adevăr; UI editează prin WorkspaceEdit | fără stare ascunsă; undo/diff/colaborare gratuite; validarea rămâne în QuickUVM (Pydantic) | format propriu de proiect al extensiei |
| D9 | ID-uri stabile = căi ierarhice elaborate | chei pentru sidecar, overlay, protocol; stabile la re-parsare | ID-uri sintetice per sesiune |
| D10 | invalidare grațioasă (orphans) pentru override-uri și pentru compilări eșuate | un typo nu distruge munca de aranjare; coerent cu fail-closed din QuickUVM | curățare automată agresivă |
| D11 | numele extensiei = QuickXray (id `quickxray`) | familia Quick* leagă extensia de brandul QuickUVM existent; metafora radiografiei descrie exact vederea de interior; fără coliziuni la verificare (iul. 2026); scurt, pronunțabil identic în RO/EN; găsibilitatea se asigură prin subtitlu și `keywords` | QuickInspect (2 produse comerciale active, ™), QuickBench (tool EDA istoric Chronology + benchmark de discuri), QuickSchem (marcă ™ Trace Software, software de scheme electrice — coliziune directă de categorie, care slăbește și QuickSchematic prin proximitate), QuickEnv (tool Rust existent + "env" = variabile de mediu pentru publicul larg), QuickScope (slang de gaming + Mitutoyo), QuickRTL/QuickHDL (proximitate cu fosta familie Mentor), DUTscope și RTL Canvas (bune, dar în afara familiei de brand) |
| D12 | build cu esbuild: host CJS (`dist/extension.js`) + webview IIFE (`dist/webview.js`), elkjs legat static în bundle-ul webview-ului | două ținte dintr-o singură comandă; formatul folosit de șabloanele oficiale de extensii; webview-ul fără framework are nevoie doar de bundling, iar varianta `elk.bundled.js` (fără worker) evită orice infrastructură suplimentară | doar `tsc` (nu leagă elkjs pentru browser); webpack (configurare mai grea, fără câștig la scara asta); încărcarea elkjs ca `<script>` separat (două artefacte de sincronizat) |
| D13 | validarea modelului în host = poartă pe `schema_version` + verificare structurală ușoară (`validateModel`); validarea completă contra schemei JSON rămâne în testele pytest ale backend-ului | contractul e păzit la sursă (backend-ul e testat cu `jsonschema` la fiecare rulare pytest); host-ul trebuie doar să refuze versiuni necunoscute (docs/02) și forme evident rupte, fără dependență de runtime | `ajv` în extensie (dependență în plus și validare duplicată; de reevaluat dacă apar backend-uri terțe care emit modelul) |
| D14 | editarea YAML-ului QuickUVM prin biblioteca `yaml` (eemeli), pe `Document` cu păstrarea comentariilor; aplicare ca un singur `WorkspaceEdit` | mutațiile ating doar nodurile vizate — comentariile, formatarea și câmpurile pe care extensia nu le înțelege rămân intacte (cerința de „editări chirurgicale" din docs/03); undo/redo rămâne nativ | serializare completă cu js-yaml (pierde comentarii și format); editări regex pe text (fragile la stilurile YAML echivalente) |
| D15 | starea „ignorat explicit" a porturilor se persistă în YAML-ul QuickUVM, sub blocul propriu `x_quickuvm_architect.ignored_ports` (numit inițial `x_quickxray`, redenumit mecanic prin D17) | e o decizie de configurare a verificării, deci aparține sursei de adevăr (nu sidecar-ului de layout); Pydantic v2 din QuickUVM ignoră câmpurile necunoscute — validat empiric cu `generate --dry-run` pe 0.9.1 | sidecar-ul de layout (ar amesteca verificarea cu geometria); comentarii YAML ca purtător de date (fragile la editare manuală) |
| D16 | editor grafic complet al configurației QuickUVM ca fază dedicată (3b): „vederea de verificare" — diagrama mediului TB (agenți, scoreboards, coverage, vsqr, subenvs) cu editare directă (paletă, conectare cu mouse-ul), după faza 3 | obiectiv exprimat de utilizator (iul. 2026); configurația dincolo de maparea pe porturi (analysis, subenvs) nu are azi nicio reprezentare geometrică — doar formular; faza 3 aduce exact infrastructura necesară (multi-nod, ruter, drag, sidecar), deci ordinea 3→3b minimizează rework; `CustomEditor` pe `*.quickuvm.yaml` (menționat post-MVP în doc 05) devine ambalajul acestei vederi | doar vedere read-only cu editare în formular (acoperă ~80% din valoare, dar nu obiectivul cerut); editor înainte de faza 3 (muchii fără ruter → rework); unealtă separată în afara extensiei |
| D20 | ruterul de interconexiuni = **ruterul propriu A\* pe grilă** (`src/webview/router.ts`); comparația libavoid-WASM închisă pe bază de dovezi, fără prototip complet | prototipul propriu a fost călit pe trei scenarii reale găsite la validarea interactivă (fiecare a devenit test de regresie): canale zidite de halouri+texte, pini față în față cu blocuri adiacente, blocuri mai apropiate decât două halouri; ~2ms/re-rutare completă pe designul de regresie; zero dependențe; teren cu costuri calibrabile într-un singur loc (coturi 4, suprapunere 8, intersecție 2, halou 6, etichete 10, proximitate 1) — exact „controlul total al esteticii" anticipat în docs/04; un prototip libavoid-WASM ar fi cerut buildchain Emscripten + ~400KB WASM doar pentru confirmare. **Condiții de reevaluare**: nudging-ul matur al segmentelor paralele sau joncțiunile devin cerință; performanță degradată pe designuri mari; scenarii sistematic nerutabile | libavoid-WASM (integrare grea, dependență mare, costuri necalibrabile fin); amânarea deciziei (ruterul e în drumul critic al fazei 3b) |
| D21 | semințele ELK interactiv sunt **totale sau deloc**: primul gest de poziție persistă snapshot-ul întregii vederi (`layout/snapshot` — noduri, pliaje, steaguri de graniță), iar la randarea unei vederi aranjate, elementele fără sămânță se pin-uiesc imediat la poziția inserată de ELK; vederile nevizitate de niciun gest rămân complet automate | regresie reală raportată la validarea interactivă: cu semințe parțiale (doar elementele trase), modul INTERACTIVE re-plasează elementele nepersistate altfel decât layoutul complet văzut de utilizator — dovedit headless: steagurile granițelor săreau cu până la 384px pe verticală la redeschidere, deterministic (repro `scratchpad/repro-port-drift.mjs`); auditul căilor de re-randare a arătat că ORICE trigger (overlay, temă, fold, net/render, recompilare) putea muta elementele neatinse odată ce semințele erau parțiale; docs/04 promitea deja „pozițiile (calculate sau mutate) se persistă" — implementarea persista doar cele mutate | persistarea doar a elementelor trase (bugul); snapshot la prima deschidere a oricărei vederi (umple sidecar-ul pentru vederi doar vizitate); re-layout complet la fiecare redeschidere (încalcă invariantul 3) |
| D22 | referințe de design pentru faza 3b (cercetare iul. 2026, trei investigații paralele): **bigUML ca hartă de patternuri UX și arhitectură declarativă; GLSP/Sprotty respins ca stack tehnic** | GLSP e server-autoritar: modelul viu stă în `ModelState` pe server, undo/redo e command stack-ul propriu al serverului, integrarea VSCode e custom editor **non-text** (Ctrl+Z delegat ca `UndoAction` spre server — verificat în `glsp-vscode-connector`), salvarea = rescriere integrală; fișierul e „mort" cât e diagrama deschisă — opusul frontal al invariantului 2 (YAML sursă de adevăr, `WorkspaceEdit` minimal, undo text nativ, editare manuală concurentă). Adoptarea ar înlocui D5/D20/D21 fără capabilitate nouă (~6–9MB, ~15 pachete, Inversify pe ambele părți, snabbdom în webview) și nu poate exprima despărțirea noastră: diagrama e proiecția designului SV, editările țintesc ALT fișier. **Ce împrumutăm din bigUML**: handleri generici de operații conduși de metadate (paletă, căi de creare, default-uri, reguli de legalitate generate dintr-o sursă declarativă — la noi schema YAML QuickUVM), edge type hints cu feedback de legalitate la conectarea în doi pași, contoare de versiune text-vs-diagramă pentru sincronizare, property palette ca view VSCode separat gated pe context key, keybindings în `package.json` cu when-clauses. **Precedente externe**: AWS Workflow Studio dovedește `CustomTextEditorProvider`+`WorkspaceEdit` la scară de producție, dar cu înlocuire integrală și round-trip YAML→JSON→YAML care pierde comentariile — editările chirurgicale prin CST din `yamlops.ts` rămân diferențiatorul, nerezolvat de nicio unealtă din sondaj; Structurizr/LikeC4 validează independent sidecar-ul de geometrie (LikeC4 a migrat de la comentarii în sursă la fișiere `.snap` separate); drawio arată supresia de ecou (flag + normalizare) la editarea duală text+diagramă și forward-ul explicit al undo-ului din webview spre host. Consecință pentru D16: ambalajul 3b e `CustomTextEditorProvider` pe `*.quickuvm.yaml`, nu custom editor non-text | adoptarea GLSP+Sprotty (rescrierea randării, protocolului și ruterului; undo non-text); sprotty client-only fără server GLSP (tot ar înlocui SVG-ul propriu D5 și ruterul D20); custom editor non-text cu undo propriu (pierde undo/diff/editarea manuală nativă a YAML-ului) |
| D23 | **draw.io / mxGraph respins ca motor de editare pentru vederea de verificare; păstrat ca referință de UX** (întrebare de principiu, iul. 2026) | aceeași rațiune de fond ca D22 (GLSP), plus specific draw.io: (1) **ar inversa sursa de adevăr** — mxGraph e proiectat să dețină modelul (cell model) și să-l serializeze în XML propriu; ori mxGraph devine autoritatea (YAML derivat → `quick-uvm generate` din XML, se pierde editarea manuală/diff/comentariile, încalcă invariantul 2), ori YAML rămâne canonic și trebuie sincronizat bidirecțional cu un motor care vrea să fie autoritatea („fighting the framework"); (2) **diagrama TB e o proiecție semantică, nu un desen liber** — nodurile/muchiile derivă din config, iar „conexiunea" în QuickUVM e câmpul `source`/`monitor`, nu o muchie liberă; gestul e „adaugă scoreboard" = mutație YAML, nu „trage un dreptunghi"; draw.io e editor de desen generic, ar trebui constrâns masiv (shapes custom, validare de conexiuni, blocarea desenului liber); (3) **ar arunca infrastructura călită fără câștig net** — layout ELK ierarhic (containment UVM), ruter A* pe grilă (D20), drag+sidecar cu semințe totale (D21), protocol versionat; draw.io are layout/rutare proprii generice, ori le accept (pierd controlul estetic D5/D20), ori le dezactivez impunând pozițiile noastre (draw.io devine renderer greu ~1–2MB, fără motiv de a-l folosi); contravine D5. **Ce împrumutăm** (ca la bigUML): patternuri de interacțiune draw.io — endpoints fixed/floating color-codate, editarea waypoints prin segment-drag, connection points, meniul de clonare direcțională. **Condiție de reevaluare**: doar dacă vederea TB ar deveni un canvas de desen liber-formă unde utilizatorul plasează geometrie care NU mapează 1:1 pe YAML — dar acela ar fi alt produs, care sacrifică diferențiatorul „YAML e sursa de adevăr" | draw.io ca aplicație-editor completă (înlocuiește webview-ul; mxGraph autoritate pe model); mxGraph ca bibliotecă de diagramming pe care construim (dependență mare, deține modelul, contra D5); formatul `.drawio` ca stocare (irelevant — YAML e formatul) |
| D24 | **navigare unificată pe niveluri, fără comutator Symbol/Schematic** (revizuire de UX, iul. 2026) — înlocuiește parțial D18: modul „Symbol" separat dispare | simbolul unui bloc e deja vizibil ca reprezentarea lui (cutie cu pini) în orice schemă în care apare, deci o vedere-simbol de sine-stătătoare a fiecărui modul e redundantă, iar comutatorul de mod producea confuzie. Model unic: fiecare diagramă (DESIGN și TB) arată **nivelul curent** cu blocurile lui ca simboluri interconectate; **dublu-clic pe un bloc** coboară în structura lui (schema instanțelor copil la RTL; sequencer/driver/monitor la agent; agenți la Env), cu selecție sincronizată în panoul-arbore și breadcrumb pentru urcare. **Rădăcina DESIGN** = simbolul top-ului (un bloc) cu buton „Set top module"; **rădăcina TB** = Testbench (DUT + Env). Frunza (modul fără instanțe interne) rămâne salt-la-sursă la dublu-clic. Ce dispare: comutatorul Symbol/Schematic din header, vederea-simbol de sine-stătătoare a modulelor interne, butonul „Open symbol" din inspector. Ce rămâne: desenul unui bloc ca simbol (cutie cu pini) în orice schemă + rădăcina = simbolul top-ului. Terminologia D18 (Symbol/Schematic) rămâne pentru glife/cod, dar nu mai e un mod comutabil. **Implementare** (iul. 2026): rădăcina DESIGN e un nod sintetic „top module" DISTINCT de nodul instanței-top — click pe „top module" → simbolul top-ului, click pe nodul top (și pe orice modul cu nume) → schema internă; astfel diferențierea simbol/schemă se reflectă în selecția din arbore chiar la nivelul de top (rafinare cerută de utilizator, altfel simbolul și schema top-ului n-aveau noduri distincte de selectat). `nav/drill.mode` duce modul spre host pentru reveal-ul corect (rădăcină sintetică vs nod-instanță); `model/full` NU re-trimite `nav/drill` la prima deschidere (ar concura cu `view/show`-ul explicit al host-ului) | păstrarea comutatorului Symbol/Schematic (D18 original — sursă de confuzie confirmată de utilizator); rădăcină DESIGN = schema top-ului direct (utilizatorul vrea explicit simbolul top-ului ca punct de intrare + set-top); vedere-simbol pe frunze (reintroduce un nivel gol redundant) |
| D18 | terminologia EDA adoptată **integral**, în engleză: **Symbol view** (istoric „vederea de context") și **Schematic view** (istoric „vederea de interior") — în UI, protocol (`ViewMode: symbol\|schematic`), comenzi (`quickuvm.openSymbolView`/`openSchematicView`), fișiere (`src/webview/schematic.ts`) și documentație („vederea-simbol"/„vederea-schemă"); decizie luată în doi pași în aceeași zi (întâi doar UI, extinsă apoi la tot, la cererea utilizatorului) | publicul-țintă vine din Verdi/Vivado/DVT și recunoaște perechea instantaneu; „context" putea sugera greșit „unde e folosit modulul"; adopția parțială ar fi lăsat un strat permanent de traducere între docs, UI și cod; momentul e cel mai ieftin din istoria proiectului (pre-git, pre-Marketplace, pre-sidecar — vocabularul ales acum e cel care se va persista pe disc), raționamentul D17 | doar etichete UI cu identificatori `context`/`interior` (varianta inițială — strat de traducere permanent); păstrarea „Context/Interior" în UI (cerea explicație — semn că numele era greșit); românizarea „Simbol/Schemă" în UI (înlocuită de D19, UI integral englez) |
| D19 | limba UI a extensiei = **engleza**, cu localizare prin mecanismele native VSCode: `package.nls.json` (+`package.nls.ro.json`) pentru contribuții, `vscode.l10n.t()` + `l10n/bundle.l10n.ro.json` pentru host; **româna livrată ca prima traducere** a părții native; webview-ul rămâne monolingv englez în MVP (extragerea într-o tabelă de șiruri se face când apare a doua limbă); jurnalele (Output) nu se localizează; documentația și comentariile din cod rămân în română (convenția existentă) | publicul Marketplace e internațional — engleza e limba implicită de facto; plumbing-ul l10n montat acum costă puțin și evită retrofit-ul; șirurile românești existente nu se pierd, devin traducerea oficială | UI românesc cu traducere engleză ulterioară (public restrâns implicit); i18n complet inclusiv webview de la început (efort disproporționat pentru MVP; VSCode nu oferă mecanism nativ pentru webview) |
| D17 | redenumire: QuickXray → **QuickUVM Architect** (id `quickuvm-architect`, spațiu de nume tehnic `quickuvm.*`, prefix paletă `QuickUVM Architect:`); înlocuiește D11, care rămâne ca istorie | extinderea D16 schimbă identitatea produsului din instrument de diagnostic (radiografie = privit) în masă de lucru bidirecțională (privit + proiectat); „architect" e rolul real din industrie (verification architect) și sintagma standard „UVM testbench architecture" — exact ce editează 3b; sub-brand al QuickUVM = fără coliziuni prin construcție + ecosistem unitar cu generatorul; momentul e ieftin (pre-Marketplace, pre-git). Redenumiri mecanice consecutive: blocul YAML `x_quickxray` → `x_quickuvm_architect` (D15), sidecar-ul planificat `*.quickxray.yaml` → `*.quickuvm-architect.yaml` (doc 04), schema `$id`/`title` | QuickUVM-design/QuickDesignUVM („design" = DUT-ul în jargonul verificării — derutant); QuickUVM Sketch („sketch" = schiță aproximativă, nepotrivit unui editor de precizie); QuickUVM Studio/Canvas (corecte dar generice; „Architect" numește activitatea, nu încăperea); QuickCanvas/QuickHarness/QuickBlueprint ca frați standalone (pierd legătura explicită cu QuickUVM; Canvas aglomerat în alte categorii) |
