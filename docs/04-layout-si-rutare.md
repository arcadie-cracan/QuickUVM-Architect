# 04 — Layout, poziții deținute de utilizator și rutare

## Strategia de layout (decizie închisă)

Combinație a două mecanisme, cu roluri precise:

1. **Layout inițial de calitate** — la prima deschidere a unei vederi sau la
   comanda explicită "Re-aranjează tot": ELK `layered` complet
   (minimizarea încrucișărilor, `portConstraints: FIXED_SIDE`, intrări pe
   stânga, ieșiri pe dreapta, ceas/reset grupate stânga-jos, rutare ortogonală
   de pornire).
2. **Pozițiile aparțin utilizatorului** — după layoutul inițial, nodurile se
   pot trage liber; pozițiile (calculate sau mutate) se persistă. La modificări
   de design, ELK rulează în **mod interactiv**
   (`layering/crossingMinimization/nodePlacement: INTERACTIVE`) cu
   pozițiile existente ca semințe: nodurile cunoscute rămân pe loc, doar cele
   noi primesc poziții, inserate în context. Niciun re-layout total implicit,
   niciodată.

   **Semințele sunt totale sau deloc** (iul. 2026, D21): primul gest de
   poziție face aranjamentul *întregii* vederi al utilizatorului — la finalul
   oricărui drag se persistă TOATE pozițiile curente (noduri, pliaje, steaguri
   de graniță; mesajul `layout/snapshot`, docs/05), nu doar elementele trase;
   iar la randarea unei vederi deja aranjate, elementele rămase fără sămânță
   (noi din recompilare, membri de pliaj proaspăt expandați, sidecar parțial
   moștenit) se pin-uiesc imediat, la poziția în care ELK interactiv tocmai
   le-a inserat. Motivul: modul interactiv plasează elementele fără sămânță
   *altfel* decât layoutul complet pe care îl vede utilizatorul — cu semințe
   parțiale, steagurile granițelor săreau cu sute de pixeli la redeschidere
   (regresie reală). Vederile neatinse (fără nicio sămânță) rămân complet
   automate: nu se persistă nimic pentru simpla vizitare a unei vederi.

Rezolvarea poziției unui nod, în ordine: override manual → poziția persistată
din sesiunea anterioară → poziție calculată de ELK interactiv în jurul celor de
mai sus.

Muchiile sunt **excluse** din proprietatea utilizatorului: traseele se
recalculează automat după pozițiile curente ale nodurilor (utilizatorul
aranjează blocuri și pini, nu întreține trasee), modulat de override-urile de
rutare de mai jos.

## Fișierul sidecar de layout

Un fișier per proiect, textual, diff-abil, în git lângă YAML-ul QuickUVM.
Calea implicită: `.vscode/quickuvm-architect.yaml` (nu aglomerează rădăcina;
`.vscode/` e deja convenția pentru starea de proiect a editorului);
configurabilă prin setarea `quickuvm.layoutFile` (relativă la rădăcina
workspace-ului).

```yaml
schema_version: 1
views:
  demo_top.u_soc:                 # cheia vederii = calea instantei
    nodes:
      u_add:        {x: 120, y: 80}
      u_inv:        {x: 120, y: 220, flipH: true}
      "g_ch[0..2]": {x: 320, y: 150, collapsed: true}
    ports:                         # override de ordine/latura a pinilor
      din:   {side: west, order: 1}
      clk:   {side: west, order: 90}
    edges:
      "u_add.dout->sum":
        style: orthogonal          # nivel 1: stil per muchie
        exit: east                 # nivel 2: directia de iesire
        waypoints:                 # nivel 3: relative, nu absolute
          - {segment: 1, offset: 40}
    nets:
      din:   {render: label}       # nivel 4: fir <-> eticheta
      clk:   {render: label}
orphans: []                        # override-uri cu tinte disparute (v. mai jos)
```

Reguli:

- toate cheile sunt ID-urile stabile din model (doc. 02); pliajele generate
  folosesc notația `nume[lo..hi]`;
- fișierul conține *doar* override-uri și poziții — niciodată date derivate din
  model (lățimi, direcții etc.);
- scriere atomică (temp + rename), o singură instanță scriitoare (host-ul);
- camera (pan/zoom) NU se persistă: e stare de sesiune a webview-ului —
  prima deschidere a unei vederi se încadrează mereu în fereastră, iar
  cadrul se păstrează doar la comutarea între vederi în aceeași sesiune
  (decizie revenită în iul. 2026: cadrele moștenite între sesiuni au produs
  constant deschideri „pe jumătate în afara ferestrei").

## Invalidarea grațioasă

Când o cheie din sidecar nu mai există în model (redenumire, eroare temporară
de compilare), intrarea se mută în `orphans` cu data ultimei vederi valide; nu
se șterge. UI-ul oferă "Curăță override-urile orfane" și, la redenumiri
detectabile (același modul + aceiași parametri + aceeași poziție în părinte),
propune migrarea cheii. Este același principiu fail-closed din QuickUVM
(secțiunile pragma), aplicat layoutului.

## Ruterul de interconexiuni

Consecință a pozițiilor libere: rutarea nu mai poate veni din ELK (care rutează
doar propriile plasări). Componentă separată de rutare ortogonală cu evitare de
obstacole, cu două implementări candidate:

- **libavoid** (Adaptagrams, ruterul din Inkscape) prin build WASM — obstacole,
  puncte de trecere, penalizări; de evaluat mărimea build-ului în webview;
- **ruter propriu** pe grilă (Lee / A* cu cost pe direcție și pe apropierea de
  obstacole) — la scara diagramei (zeci de obstacole, sute de muchii) e simplu
  și suficient; avantaj: zero dependențe, control total al esteticii
  (spațiere între trasee paralele, joncțiuni).

Decizia se ia în faza 3 pe un prototip comparativ; interfața ruterului e fixă:
`route(obstacles, pins, constraints) -> polylines`, ca implementarea să fie
interschimbabilă.

## Ierarhia de override-uri de rutare

| Nivel | Ce controlează | Persistență | Fragilitate |
|---|---|---|---|
| 1 | stil (ortogonal/direct/curbe), spațiere, per vedere sau per muchie | atribut declarativ | zero |
| 2 | latura/ordinea pinilor pe nod; direcția de ieșire a muchiei | relativ la nod | zero (se mută cu nodul) |
| 3 | waypoints pe muchie | **relative** (offset per segment sau ancoră la nod) — niciodată coordonate absolute | mică, cu invalidare grațioasă |
| 4 | fir ↔ etichetă de net | per net | zero |

Nivelul 4 este prima linie de apărare a lizibilității: net-urile cu fan-out
peste prag (implicit >4; `render` vine deja sugerat din model) și net-urile cu
rol ceas/reset se afișează ca etichete pe pini, nu ca trasee. Aplicat corect,
reduce cererea de waypoints (nivelul 3) aproape la zero — de aceea ordinea de
implementare este 1 → 4 → 2 → 3, iar 3 doar la cerere demonstrată.

Implementat (iul. 2026): netul se selectează prin click pe traseu sau pe
eticheta lui, iar inspectorul oferă comutatorul „Show as label"/„Show as
wire" (mesajul `net/render`, docs/05). La o selecție de UN pin/steag,
inspectorul îi derivă netul (din muchii sau `pin.nets`/`bport.nets`) și arată
același comutator — descoperibil de pe orice capăt, nu doar de pe traseu/etichetă
(rafinare din validare). Override-ul se persistă în sidecar sub
`views.<vedere>.nets.<net>.render` doar când diferă de sugestia din model —
revenirea la sugestie șterge intrarea (fișierul ține doar abateri). La
invalidare, override-urile net-urilor dispărute migrează în `orphans` cu
`kind: net` și se restaurează la reapariție, ca pozițiile. Nivelul 1 (stilul
traseelor) se amână: există un singur stil — ortogonal pe grilă, prin ruterul
propriu (D20) — deci nu are încă ce parametru să expună.

## Randare

SVG generat manual în webview (nu canvas, nu framework de diagramming):
hit-testing nativ pe elemente, stilizare CSS pentru overlay-ul de agenți
(schimbare de clasă, nu re-randare), export vectorial trivial (SVG → PDF pentru
documentație și materiale didactice). Maparea gesturilor: zoom pe rotiță,
**pan pe butonul din mijloc**, click-stânga pe fundal = **lasso de selecție**
(pe simbol selectează pini — gestul pentru „Agent from selection"; pe schemă
selectează blocuri și steaguri; Ctrl = adăugare la selecția existentă;
implicit se selectează doar obiectele complet cuprinse — setarea
`quickuvm.lassoMode: intersect` comută pe „crossing selection"), click
pe element = selecție simplă (+Ctrl comutare), drag de noduri cu snap pe
grilă (drag pe un membru al selecției mută toată selecția), hover cu tooltip.
**Minimap** (navigatorul de ansamblu; cererea utilizatorului, iul. 2026):
miniatura întregii scene într-un colț (dreapta-jos, 180×120) + dreptunghiul
zonei vizibile; click sau drag pe minimap **centrează camera** pe punctul
respectiv (zoomul se păstrează), tasta **M** îl comută. Doar în vederile-schemă
(RTL + TB) — simbolul încape mereu; nu apare în exportul SVG (e chrome de UI,
nu conținut). Implementare: miniatura e o **copie vie** prin
`<use href="#viewport">` — zero re-randare, orice schimbare (drag, selecție,
ghidaje) apare instant; transformul `U = M ∘ V⁻¹` anulează camera copiată și
aduce lumea la scara minimapului. Toată geometria (încadrare, dreptunghi de
vedere, salt de cameră) e în modulul **pur** `src/webview/minimap.ts`
(`test:minimap`); `refreshMinimap`/`updateMinimap` în `main.ts` o leagă de DOM
(refresh la randare/drag-end/resize/toggle; update ieftin per cadru din
`applyTransform`, cu auto-corecția ancorării — prima randare poate rula cu
canvasul încă ascuns de ecranul de bun-venit, `clientWidth=0`). Gesturile pe
minimap nu ajung la canvas (altfel porneau lasso-ul / goleau selecția).
**Ghidaje de aliniere la drag, pe CAPETELE PINILOR** (`alignSnap`, pur,
`test:router`; cererea utilizatorului, iul. 2026): alinierea ține cont DOAR de
pini, nu de marginile blocului — două capete de pini la același y ⇒ fir
orizontal drept, exact ce contează pentru o schemă curată. Punctul de aliniere e
CAPĂTUL pinului (vârful stub-ului, unde se leagă firul și stă marcajul `{}`/`[]`),
nu marginea blocului: la `cx − stubLen` pe vest / `cx + cw + stubLen` pe est, cu
`stubLen = MARKER_STUB` pentru pinii cu marcator concat/select (firul se leagă
dincolo de chip), altfel `STUB` — deci ghidajul vertical trece prin vârfurile
pinilor, nu prin marginea blocului (`pinTipOffsets` pur în `schematic.ts`,
`test:router`; latura vine din geometrie, ca ancora din `routeEdges`, deci
răsturnările o urmează). Pe fiecare axă, dacă un capăt de pin al nodului APUCAT
ajunge în ~6px (ecran) de un capăt de pin al altui bloc, blocul se mută ca ele să
se alinieze EXACT (peste snap-ul de grilă) și apare o linie de ghidaj punctată
(`.align-guide`, 1px la orice zoom) de la capătul tras la cel potrivit, cu un mic
surplus pe capete (`ALIGN_GUIDE_PAD`) ca să rămână vizibilă chiar când capetele
coincid pe axă; pe axa fără potrivire rămâne snap-ul de grilă. Steagurile de
graniță (porturile modulului, fără stub) folosesc centrul lor. Se caută cel mai
apropiat capăt, deci snap-ul poate fi la orice vecin, nu doar la frați. Ghidajele
se curăță la drag-end. Grupul se mută cu nodul primar (offseturile relative se
păstrează). `nodeAlignPts`/`nodePortPoints` în `main.ts` extrag punctele (RTL:
capetele din `pinTipOffsets`; TB: `TbPlaced.ports`, fără stub-uri).
**Ctrl+Z / Ctrl+Shift+Z (sau Ctrl+Y)** = undo/redo de **poziții** (din
validarea quick wins, iul. 2026): istoric de sesiune per cheie de layout
(RTL per vedere, TB per nivel) care anulează mutările de blocuri/steaguri și
re-aranjările ⟲ — fiecare pas aplicat se persistă normal prin
`layout/snapshot` (sidecar-ul rămâne sursa persistată; flip-ul și pliajele
nu intră în istoric). **Săgețile** derulează viewport-ul (pan din tastatură,
cererea utilizatorului, iul. 2026): convenție de scroll (jos = vezi conținut
dedesubt), pas mai mare cu Shift, ținut apăsat = derulare continuă; camera
devine a utilizatorului și se salvează ca la pan-ul cu mouse-ul (stare de
sesiune). Nu declanșează în câmpurile inspectorului (bail pe INPUT/SELECT/…).
**Trasare interactivă** (faza 4, implementată): în vederea-schemă,
**Shift+click** pe un net (fir sau etichetă) sau pe un bloc/steag selectează
**conul aval** (tot ce e condus, tranzitiv, de element), iar
**Shift+Alt+click** — **conul amonte** (tot ce îl conduce). Traversarea
(`netCone` în `scene.ts`, pură, `test:scene`) urmează exact ce e desenat:
muchiile wire după direcție, interfețele în ambele sensuri, iar net-urile
afișate ca **etichetă** prin conectivitatea pinilor și a **steagurilor de
graniță** (`pin.nets`/`bport.nets` — etichetele nu au muchii; un net-etichetă
care atinge un port al vederii NU-și pierde capătul de graniță din con);
pliajele generate sunt un singur nod, ca pe ecran. Clasificarea semínței
(`coneOf`) e robustă la ținta clicului: un click pe interiorul unui pin
(numele portului, adnotarea) pornește din net-urile pinului, nu dintr-un net
inexistent, iar un Shift+click pe ceva nerecunoscut păstrează selecția (nu o
golește).
**Cross-probing la hover** (faza 4, implementată): staționarea pe un pin
(~300 ms) revelează declarația portului în editoarele **deja vizibile**, cu
o evidențiere tranzitorie a liniei — ne-intruziv prin construcție (nu
deschide tab-uri, nu fură focusul, nu mută cursorul; `openSource` cu
`peek: true`, docs/05); saltul complet rămâne pe dublu-click. Setarea
`quickuvm.hoverCrossProbe` îl stinge. **Cross-probing editor→diagramă**
(reciproca; faza 4, implementată): host-ul urmărește cursorul din sursele SV
(debounced 150ms) și, prin `probe/highlight` (docs/05), webview-ul aprinde un
**halou galben persistent** (`.xprobe`) pe elementul de sub cursor — DISTINCT
de selecție (selecția de lucru nu e atinsă) și DOAR în vederea curentă
(non-invaziv: fără navigare, fără mișcare de cameră; ținta absentă = niciun
halou). Rezoluția (fișier,linie)→țintă e pură (`buildLocIndex`/`resolveLoc` în
`src/locmap.ts`, `test:locmap`): potrivire exactă pe linie (portul bate
instanța bate antetul de modul — stil ANSI pe o linie), altfel cel mai
apropiat element care CUPRINDE de deasupra (instanțe/module; porturile doar
exact); instanțele generate împart linia sursă → toate se aprind (pliajul, o
dată — maparea pe id-urile vederii e tot pură, `probeIds`, cu `memberPaths`
pe nodurile-pliaj). Căile se compară normalizat (lower+slash — capcana
Windows din `isComposedChild`). Navigarea explicită: comanda **„Reveal in
Diagram"** din meniul contextual al editorului (`.sv/.svh/.v/.vh`, insensibil
la caz) deschide diagrama la element — instanță → schema vederii-conținătoare
+ selecție (generate: toți membrii; cu pliajul închis, id-urile membrilor se
remapează pe pliaj prin `remapSelection` în `presentScene` — pur, `test:locmap`
— altfel navigarea reușea dar selecția era goală); top fără vedere-părinte →
schema lui dacă există (antetul unui modul dezvăluie interiorul, consecvent);
port/modul → vederea instanței modulului (preferă instanța vederii curente) cu
steagul/pinul selectat; ținta lipsă → mesaj, nu eșec tăcut. `select/reveal`
face și ecou `select/changed` spre host (altfel comenzile din paletă care
citesc selecția acționau pe nimic). Haloul `.xprobe` NU intră în exportul SVG
(stare de sesiune, nu conținut — scos de pe clonă ca `.selected`).
**Limitare cunoscută** (recenzia adversarială, structurală — modelul n-are
sfârșiturile elementelor): „cel mai apropiat deasupra" nu vede granițele
dintre module — cursorul într-o construcție ne-elaborată (pachet, modul
nefolosit) care URMEAZĂ în fișier unor instanțe poate cădea pe ultima
instanță de deasupra; inofensiv (doar halou/reveal aproximativ) și
nedeclanșabil pe fixture-urile actuale, corectabil doar cu end-loc în model.
**Decorațiile de stare quick-uvm** (faza 4, implementată; deciziile prin
AskUserQuestion: ambele surse, badge în colț + tooltip): validările
model↔YAML (`checkConfig`) ajung pe diagramă ca **badge-uri** ⚠ (warning) /
✕ (error) în colțul dreapta-sus al elementului vizat, cu mesajele în tooltip
— pinii RTL ai DUT-ului (lățime greșită, revendicare dublă, ignorat+mapat;
steagul `<port>.X` pe vederea DUT-ului însuși, pinii instanțelor de DUT în
vederea-părinte) și blocurile TB (`agent:<nume>`; hibrid/dut-missing pe
Env). La nivelul-rădăcină TB, problemele agenților se **agregă pe Env**
(bubble-up cu prefixul agentului, severitatea maximă) — rădăcina nu pare
curată cu agenți stricați dedesubt. Portul orfan NU țintește pinul (a
dispărut din model), doar agentul. Rezultatul ultimului „Generează
testbench" e un **cip în antet** (`✓/✕ generate`, tooltip cu detaliul
Pydantic + momentul; ✕ și la eșecul de lansare ENOENT); absent până la prima
rulare. Mesajul `status/decorations` (docs/05), derivarea și maparea pure în
`src/status.ts` (`decosFromFindings`/`statusIdsRtl`/`statusIdsTb`,
`test:status`); badge-urile se re-desenează după fiecare randare
(idempotent, poziționate pe `getBBox`) și NU intră în exportul SVG
(diagnostic de sesiune, nu conținut). **Export SVG** (faza 4, implementată):
butonul ⤓ din header (orice vedere) sau comanda `quickuvm.exportSvg` scrie
un SVG **autonom**: stilurile calculate se inline-uiesc (culorile temei
curente se coc în fișier — CSS-ul tematizat prin `var(--vscode-*)` nu
călătorește), camera de sesiune devine `viewBox` pe conținut, fundalul temei
se coace într-un rect. Exportul PDF e amânat: SVG-ul se convertește curat cu
unelte externe (browser, Inkscape), iar o bibliotecă de PDF în webview nu-și
justifică greutatea (D5 anticipa exportul vectorial — corect pe fond, dar
„trivial" doar după inline-area stilurilor).

**Vocabular de desen — core** (faza 4, implementat): **busele** poartă
lățimea (`ScenePin`/`SceneBPort`/`SceneEdge` au `width`): pinul/steagul arată
`/N` deasupra stub-ului (combinat `/16×3` la tabloul unpacked), iar
firul/stub-ul se îngroașă pe **clase de lățime** (`widthClass` →
w-s 2-8 / w-m 9-16 / w-l >16). Lățimea netului pe muchie e derivată prin
`netWidth` (reutilizat din `probe.ts`) — DOAR de la un capăt cu **același
semnal** (portul propriu al vederii sau un pin de copil cu `conn.kind==="net"`),
niciodată prin select/concat (invariantul de lățime din CLAUDE.md).
**Eticheta portului** (`portLabel`, pur, `test:scene`) urmează ordinea de
declarare SystemVerilog: dimensiunile **packed înaintea numelui** (din
`elem_width`), **unpacked după** (din sufixul `type` de după separatorul intern
`$`, ca să păstreze intervalul exact declarat) — `[15:0]ch_out[0:2]` pentru un
tablou unpacked, `[15:0]din` pentru un vector packed, doar numele la 1 bit.
Corectează `ch_out[15:0]` vechi (iul. 2026, cererea utilizatorului), care
prezenta un tablou unpacked ca vector plat de 16 biți și contrazicea selecturile
`[0]`/`[1]`/`[2]` care-l alimentează. Eticheta e **compactă (fără spații** între
dimensiuni și nume, ca să economisească lățime); lizibilitatea vine din
**colorarea diferită**: la desen (`portLabelText` + `splitLabel`, ambele pure)
numele stă în culoarea plină, iar dimensiunile în tspan-uri `.dim` cu
`fill-opacity: 0.55` — o nuanță care urmează culoarea numelui la
hover/select/iface, ca numele să rămână proeminent. **Măsurarea** blocului
folosește șirul compact cu fontul editorului (monospace, `measurer(mono)` —
altfel etichetele monospace mai late erau subestimate și porturile vest/est se
suprapuneau). **Junction
dots** (`junctionDots`, pur, consumat în `routeEdges` după rutare): un punct
unde un net se contopește — pentru fiecare vârf al netului se numără direcțiile
cardinale distincte în care pleacă un segment al netului, iar **≥3 direcții la
un vârf** = joncțiune reală (T cu 3, sau contopire 4-way ca la fan-in-ul unei
magistrale — 3 `dout`-uri într-un port `ch_out`; cererea utilizatorului, iul.
2026). Un **cot** (2 direcții) nu primește punct. **Nu** se marchează
încrucișările periculoase: (1) net-uri DIFERITE care se ating — detecția e
**grupată pe net**, deci nu-s în același grup; (2) o încrucișare a aceluiași net
fără cot (două fire drepte) nu are vârf la intersecție, deci nu ajunge la
verificare. Trunchiul comun al unui fan-out (waive-ul) se dedup pe vârf.
**Pieptenele de magistrală** (`combPolys`, pur, `test:router`): un net cu fan
(≥2 muchii wire, capete pe rânduri diferite) se redesenează ca un **trunchi
vertical + o priză orizontală per capăt**, nu ca o STEA în care toate muchiile
converg în sink (care făcea un 4-way — un singur punct). `trunkX` = x-ul vertical
dominant din rutarea A* (ocolește obstacolele), iar `routeEdges` aplică pieptenele
DOAR dacă prizele/trunchiul nu taie vreun bloc (`combClear`) — altfel rămâne
rutarea per-muchie. Priza de sus + trunchiul + priza de jos se desenează ca **o
SINGURĂ polilinie** (spina), ca cele două colțuri de capăt să aibă jonctiune
(miter), nu două capete „butt" separate care lăsau un gol la îmbinare (observația
utilizatorului); prizele interioare rămân separate — ating latura groasă a
trunchiului, acoperite de el. Rezultatul: prize separate, fiecare cu punctul ei de T
(sink-ul dincolo de surse = capăt de trunchi, deci capetele-priză sunt coturi
fără punct; cererea utilizatorului, iul. 2026). **Glife de adnotare** (implementate ulterior): `ScenePin.noteKind`
(`select`/`const`/`concat`/`nc`/`expr`/`mixed`) e discriminatorul care ALEGE
glifa în stratul de desen, fără să reparseze textul notei (`noteOf` în
scene.ts). `drawAnnotation` (schematic.ts) desenează: `const` = cutie tie-cell
cu valoarea, `select`/`concat` = **chip de accent cu parantezele SV** (`{}`
concat, `[]` select — chiar operatorii din sursă) + eticheta, `nc` = cerc,
restul text. Chip-ul înlocuiește pana netlistsvg veche (iul. 2026): pana era
plină și convergea spre bloc, deci se citea ca un al doilea **cap de săgeată**
peste săgeata de direcție a firelor — triaj adversarial pe 8 familii, cererea
explicită a utilizatorului. (Ulterior, tot la cererea utilizatorului, **săgeata
de direcție a firelor RTL a fost scoasă** — `marker-end` eliminat din
`edgeElement` —, direcția fiind implicită din latura portului: intrări pe vest,
ieșiri pe est. Săgețile rămân în vederea TB, unde steagurile disting
in/out/inout; markerul `#arrow` din defs rămâne, folosit acolo.) Chip-ul n-are
vârf orientat de-a lungul firului
(dreptunghi rotunjit, parantezele poartă distincția), iar textul `{…}`/`[hi:lo]`
rămâne purtătorul de sens la „decorations off" (chip-ul e decorație, ascuns
acolo; nota nu se scoate). Chip-ul stă la un `MARKER_GAP` de capătul stub-ului,
spre exterior (nu lipit de port) — altfel colțul lui de sus se suprapunea cu
eticheta de lățime și cu nota. **Firul traversează chip-ul ORIZONTAL**, în
aceeași direcție cu portul (cererea utilizatorului): pentru un pin cu marcator,
stub-ul VIZIBIL se extinde la `MARKER_STUB` (= `STUB+GAP+CW+MARKER_TAIL` = 48)
ȘI ancora de rutare a firului (`routeEdges`) se mută tot la `MARKER_STUB`, așa
că trunchiul fanout-ului se leagă DINCOLO de marcator (la stânga la
intrări/vest, la dreapta la ieșiri/est) și stub-ul orizontal desenat prin chip
îl traversează. **Pinul STRĂPUNGE vizibil chip-ul** (cererea utilizatorului,
iul. 2026): stub-ul iese `MARKER_TAIL` (=12px) dincolo de marginea exterioară a
chip-ului (36), altfel părea ascuns sub el (se oprea exact la margine, firul
părea să izvorască din chip); 36+12=48 e multiplu de 8, deci vârful/ancora cade
PE GRILĂ (pin pe grilă = fir drept). Abordarea cu obstacol de rutare (să împingă
trunchiul) a fost RESPINSĂ — un obstacol respinge și ramura orizontală (firul
ocolea chip-ul, rămânea „pe uscat"); ancora e soluția corectă (fir rutat până la
ancoră + stub-decorație prin chip). **Tranziția de grosime** stub-port (lățimea
portului) → muchie-net (lățimea netului) cade acum la VÂRF, coliniară cu firul
(fără colț), deci nu produce îmbinări rupte; nota veche „tranziția sub chip"
(ancora exact la marginea chip-ului) e ÎNLOCUITĂ de cererea mai nouă — pinul
vizibil dincolo de chip bate ascunderea tranziției. Fundalul e OPAC
(`color-mix` cu `editor-background`), deci maschează firul de dedesubt. Centrarea verticală a parantezelor NU folosește `dominant-baseline`
(getBBox + dominant-baseline diferă între versiuni de Chromium — harness vs
webview VSCode —, iar nudge-ul ieșea greșit): semnul primește un `y` de start
aproximativ centrat, iar `centerChipSigns` (apelat după `drawSchematic`, cu
elementele în DOM) măsoară cutia reală a semnului și a dreptunghiului pe
**baseline alfabetic** (getBBox fiabil peste tot) și nudge-uiește semnul până
coincid centrele. Se re-aplică pe cadrul următor și după `document.fonts.ready`
(primul getBBox poate rula înainte ca fontul editorului să fie aplicat).
Independent de font, idempotent per randare.
Iterația intermediară a fost un romb cu semn de
lățime `+`/`−`, înlocuit fiindcă semnul cerea un mnemonic; parantezele sunt
sintaxa însăși. `estPinText`
adaugă o alocare fixă (`GLYPH_W`) pentru const/select/concat, în AMBELE
consumatoare (marginile ELK și obstacolele ruterului), ca glifele mai late să
nu iasă din zona rezervată.
**Secțiuni de pini pe rol** (vederea-simbol, symbolator): pinii de ceas/reset
(euristica `isClockOrReset`) sunt deja grupați jos-stânga (`buildPins`);
gruparea se face VIZIBILĂ printr-un gap + divizor + titlu — `draw` (main.ts)
detectează granița signals→clock/reset pe vest, deplasează grupul clock/reset
în jos cu `SECTION_GAP` (ELK FIXED_ORDER nu lasă gol per-grup), mărește cutia
și desenează un divizor punctat + eticheta „clock / reset" (grupul de sus e
implicit prin contrast). Doar în vederea-simbol și doar când modulul are
ceas/reset (combinațional pur rămâne plat).
Vocabularul (slash+lățime, junction dots) se poate ascunde cu setarea
`quickuvm.schematicDecorations` (implicit pornit; clasă `decor-off` pe canvas
prin `ui/config` — gradarea grosimii firelor rămâne, e natura firului).
**Firul folosește o culoare OPACĂ amestecată cu fundalul, nu `opacity`**:
firele aceluiași net care împart trunchiul (waive-ul de fan-out) își cumulau
transparența și dădeau un efect de gradient la suprapunere (observat la
validare) — amestecul opac dă aceeași softness fără acumulare.

**Lumea pe grilă e universală**: în orice vedere-schemă, toate pozițiile —
inclusiv steagurile porturilor de graniță, mutabile și ele (chei `<port>.x`
în sidecar) — se rotunjesc la grilă la fiecare randare (pozițiile ELK sunt
fracționare; saltul e sub jumătate de pas). Consecințe: ancorele cad pe
rânduri de grilă (ruterul scoate trasee integral ortogonale pe grid), iar
alinierea pin-la-pin e posibilă între orice două elemente, mutate sau nu.
**Nudge anti-suprapunere la expandare** (din validare): pe o vedere aranjată,
D21 pinuiește TOȚI vecinii, deci ELK interactiv nu-i poate împinge să facă loc
membrilor unui pliaj proaspăt expandat — care pot ateriza peste noduri
pinuite. La randare, elementele FĂRĂ sămânță (membri noi) care s-ar suprapune
se mută la cel mai apropiat loc liber pe grilă (`freeSpot`, pur — scanează pe
cercuri crescătoare, preferă jos), fără să atingă blocurile utilizatorului; o
vedere proaspătă (fără semințe) trece prin ELK complet, deci n-are nevoie de
nudge. `⟲` rămâne calea pentru un aranjament curat.

**Traseele vin întotdeauna din ruterul propriu** — ELK dă doar pozițiile;
un singur comportament de rutare (halou, etichete protejate, ocupanță) în
toate vederile, cu sau fără override-uri.

Suprapunerea paralelă a două net-uri distincte pe același culoar e scumpă
(`overlapPenalty`, implicit 8/celulă) — pe lungime, firele diferite stau pe
culoare separate. **Excepție lângă capetele comune** (`fanoutRadius`, implicit
6 celule): firele care pornesc din aceeași sursă (fan-out — portul de analiză
al unui agent spre scoreboard ȘI coverage) sau converg spre aceeași destinație
(fan-in) au voie să împartă trunchiul chiar lângă capătul comun, în loc să fie
forțate să forcheze la pin. Raza e ancorată la capetele muchiei *care se
rutează* (nu la puncte de trecere arbitrare) și doar *anulează penalizarea*, nu
forțează suprapunerea: la lungime egală ruterul tot preferă culoare separate,
deci net-urile din pini vecini nu se lipesc — waive-ul mușcă doar când
suprapunerea chiar scurtează traseul (adică exact la capăt comun). Nu confunda
cu net-ul unic cu fan-out (`group` comun), unde suprapunerea e liberă pe toată
lungimea.

Nodurile suportă **răsturnare** (flip), persistată în sidecar per nod
(`flipH`/`flipV`): orizontal = laturile vest↔est se schimbă (intrările apar
pe dreapta), vertical = ordinea pinilor se inversează pe fiecare latură.
Flip-ul e o **reatribuire a sloturilor de pini pe grilă, nu o oglindire
geometrică** — textul (nume, etichete) nu se oglindește niciodată, iar pinii
rămân pe aceleași rânduri de grilă. Porturile fiind `FIXED_POS`, ELK primește
pozițiile deja răsturnate, deci traseele lui rămân valabile și pe noduri
răsturnate.

Grila (pas 8) urmează convenția EDA: **pinii se agață de grilă, nu doar
cutia**. Geometria internă a nodurilor e multiplu de grilă prin construcție
(primul centru de pin la +40 sub banda de titlu, pas de pin `PIN_PITCH`=24 —
lărgit de la 16 la validare, ca decorațiile să aibă aer între rânduri; rămâne
multiplu de 8, deci pinii rămân pe grilă —, lățimi și
înălțimi rotunjite la 8, porturi `FIXED_POS` calculate de extensie — nu de
ELK), astfel încât snap-ul colțului stânga-sus pune automat toate punctele de
conexiune pe grilă: pin aliniat cu pin = fir perfect drept. Consecință: pinii
stau în ordinea declarației din modul (norma din schematics); reordonarea vine
din override-urile de nivel 2. Reevaluarea către JointJS se face
doar dacă rutarea interactivă a muchiilor devine cerință reală (jurnalul
deciziilor, doc. 06).
