# 07 — Plan post-MVP: bucla de feedback a generării + paritate de schemă

Continuă `docs/06-plan-mvp.md` (MVP închis, Faza 4 finisată). Trei direcții cerute
de utilizator (iul. 2026), investigate empiric în **ambele** repo-uri (QuickUVM
generatorul + QuickUVM Architect extensia). Referința de schemă folosită peste
tot: `docs/quickuvm-schema-reference.md` (suprafața v1.0.0).

**Constatarea de arhitectură** (independent confirmată de investigația liniei 1 și
a liniei 2): direcțiile 1 și 2 au AMÂNDOUĂ nevoie de aceeași primitivă — o mapare
autoritară **element de config → fișiere generate**. Hard-codarea acestei mapări în
TypeScript driftează (numele generate sunt lossy față de config: un scoreboard flat
își pierde numele → `<dut>_scoreboard.svh`, `<agent>_cov.svh` se emite necondiționat,
layout-urile packaged/subsystem multiplică cazurile). Deci fundația comună e un
**manifest de generare emis de QuickUVM**, o singură sursă de adevăr. El deblochează
atât decorația (linia 1) cât și declanșatorul incremental (linia 2). Linia 3
(paritate GUI) e independentă și poate merge în paralel.

Ordinea globală: **Track A (manifestul QuickUVM) → Linia 1 → Linia 2**; **Linia 3**
în paralel, începând cu reparațiile de paritate negativă (bug-uri).

---

## Principiu UX — „simple by default, powerful when needed"

Aceeași filozofie ca a generatorului ([[quickuvm-design-philosophy]]), aplicată
inspectorului. Encodată PUR și testat în `src/inspector.ts` (`npm run test:inspector`),
ca regulile să nu trăiască împrăștiate prin condiții inline în DOM.

Trei reguli, deliberat distincte:

1. **SCOP.** Inspectorul arată proprietățile a CE E SELECTAT, nimic altceva.
   Secțiunile la nivel de bench (RAL, regresie, ceasuri, reseturi, teste, identitate)
   apar doar în *bench scope* — nicio componentă selectată, exact ce produce selectarea
   nodului rădăcină din arborele de verificare (`selectId` null). Înainte se randau sub
   ORICE selecție: ~55 de rânduri irelevante sub fiecare clic.
2. **RELEVANȚĂ ⇒ ascunde.** Un câmp al cărui comutator stă chiar lângă el se ascunde
   până devine util (`mode: responder` dezvăluie rândurile de responder). Nu se pierde
   nimic: comutatorul E punctul de descoperire. Fiecare rând ascuns corespunde unui zid
   de validator QuickUVM — l-ar fi refuzat oricum.
3. **RARITATE ⇒ „Advanced".** Un câmp mereu valid dar rar atins stă sub o dezvăluire,
   niciodată dezactivat și niciodată eliminat — nu există alt control care să-l scoată
   la iveală. Starea deschis/închis se ține minte (`vscode.setState`).

Corolar: **un control dezactivat e zgomot permanent.** Se folosește doar când blocajul
vine din ALTĂ secțiune (ex. „In use by spi" pe un domeniu de ceas), unde utilizatorul
nu poate deduce de aici cum să-l deblocheze.

Efect măsurat pe un bench realist (RAL + regresie + 2 domenii de ceas + 1 reset +
2 teste, agent cu 4 porturi selectat): **~100 de controale → sub 30**.

---

### Vocabularul stărilor de generare

Trei stări, colorate și insignate cu vocabularul PROPRIU al VS Code, ca să nu fie
nimic de învățat:

| stare | insignă | culoare (token) | ce înseamnă |
|---|---|---|---|
| nesalvat | `●` | verde `gitDecoration.untrackedResourceForeground` | declarat în editor, încă nu în fișier — un crash îl pierde |
| negenerat | `U` | chihlimbar `list.warningForeground` | pe disc, dar fără cod în spate (git: *untracked*) |
| învechit | `M` | albastru `charts.blue` | cod există, configurația a mers mai departe (git: *modified*) |

`●` e exact marcajul pe care VS Code îl pune pe un tab nesalvat; `U`/`M` sunt
literele git cu înțelesul lor git. Prioritate: nesalvat > negenerat > învechit.

Culoarea duce greul la o privire, insigna e plasa de siguranță: în temele High
Contrast VS Code aplatizează culorile decorațiilor, iar culoarea singură e ilizibilă
pentru utilizatorii cu daltonism — deci **niciun canal nu are voie să fie singurul
purtător**. De aceea nu s-a renunțat la glif.

Chihlimbarul (`list.warningForeground`) și auriul (`gitDecoration.modified…`) sunt la
un pas de nuanță distanță, deci nu se folosesc pe două stări vecine; albastrul separă
curat a treia stare.

Declarațiile se compară la nivel de **owner**, nu de nod: mai mulți `vseq:*`
colapsează pe unicul nod `vsqr`, deci întrebarea „există nodul?" ar rata un AL DOILEA
vseq adăugat pe un bench care are deja unul.

### Unde trăiește un control (felia 2 de UX)

Inspectorul e randat de DOUĂ suprafețe, din același modul
(`src/webview/inspector-view.ts`), diferențiate de un singur steag `canvas`:

| suprafață | `canvas` | ce arată |
|---|---|---|
| bara laterală „Properties" (sub arbori) | `false` | tot ce **editează CONFIGURAȚIA**: proprietăți de agent/scoreboard/coverage/subenv, porturi, setările de bench, paleta de adăugare, Generate |
| aside-ul diagramei | `true` | tot ce **acționează asupra DESENULUI**: flip, fold, render de net, con, selecție de pini, citirea schematică a vederii curente |

Criteriul e *pe ce acționează controlul*, nu unde arată mai bine. Niciuna nu randează
controalele celeilalte, deci nimic nu e duplicat și nu se afișează niciun buton care
n-ar putea face nimic de acolo. Aside-ul se ASCUNDE când rămâne gol (o vedere TB fără
selecție), și exact acei 250px se întorc la pânză.

Bara laterală e un bundle SEPARAT (`dist/properties.js`, **33 KB** față de 3.6 MB al
diagramei): e mereu deschisă, deci nu are voie să care ELK-ul după ea. Ăsta a fost
motivul extragerii inspectorului înainte de mutare.

---

## Track A — manifestul de generare QuickUVM (fundația comună)

**Repo: QuickUVM.** Un singur slice, prin fluxul de PR QuickUVM. Trei adăugiri mici,
compatibile înapoi (verificate în `quick_uvm/cli.py` + `quick_uvm/generator.py`):

1. **`FileSpec` primește un `owner`** — felul + numele elementului (`agent:host`,
   `scoreboard:sbd`, `test:test1`, `env`, `top`, `aggregate`). Locurile de
   `specs.append` cunosc deja elementul (sunt în buclele `for agent…`/`for test…`/
   per-scoreboard, `generator.py:502-568, 357-455, 390-392`), deci e o setare de
   câmp, fără logică nouă. Azi asocierea element→fișiere există doar ca **cod
   imperativ**, se pierde după ce lista e construită.
2. **O comandă `manifest` (sau `list --json`)** care emite, per element: identitatea,
   fișierele exacte pe care le deține, ȘI **setul global de fișiere agregate**
   (`tb_pkg.sv`+`pkg.f` la flat; `*_env_pkg.*`+`*_test_pkg.*`+`run.f` la packaged;
   variantele de subenv la compoziție). Derivat direct din `files_to_generate()`,
   deci mereu corect pentru flat/packaged/subenv/VIP/selftest fără ca Architect-ul
   să ghicească. Reutilizează verificarea de existență pe care `list` o face deja
   (`cli.py:245-248`), ca manifestul să poarte și „exists on disk" per fișier — exact
   ce alimentează **linia 1**.
3. **`--only` devine repetabil** (`multiple=True`; `only` devine set; filtrul
   `spec.output not in only`). Azi `--only` ia UN singur nume de fișier
   (`cli.py:77-82`, `generator.py:922-923`), deci regenerarea unui agent (~10-12
   fișiere) cere o invocare per fișier. ~3 linii, compatibil înapoi. Plus un
   **avertisment când un `--only` nu potrivește niciun spec** (element redenumit +
   nume vechi = no-op tăcut azi).

**De ce manifest + `--only`, nu un vocabular de elemente în CLI** (`--only-agent NAME`):
numele fișierelor encodează convențiile QuickUVM (`{name}_cfg.svh`, `default_seq_name`,
prefixe de scoreboard, specializări C3 per-parametru). Autoritatea numirii TREBUIE să
stea în QuickUVM. Cu manifestul, Architect-ul citește numele și le trimite înapoi prin
`--only` — o singură sursă de adevăr, mai mic decât a re-encoda maparea în CLI.

**Precedent existent**: `add-test` (`cli.py:280-306`) e deja regenerare per-element —
apelează `generate_all(only=f"{name}.svh")` ȘI `generate_all(only=f"{dut}_tb_pkg.sv")`,
adică „fișierul elementului + agregatul". Regula asta se generalizează (vezi Riscuri).

**Invarianți verificați**: randarea per-fișier e complet independentă (contextul vine
din întregul config prin `_flat_base_ctx`, `generator.py:147-221`), deci orice fișier
se poate regenera izolat. Păstrarea pragma-urilor e identică sub `--only` (`_write` →
`merge(...)` fail-closed + backup-uri `.bak.N`, `generator.py:884, 897-900`).

**Verificare (mutation-proof)**: regenerarea scoped a unui agent lasă fișierele
celorlalți agenți byte-identice; omiterea agregatelor lasă `tb_pkg.sv` stale
(documentează regula de co-regenerare); test unitar pe forma manifestului contra
exemplelor commit-uite (flat/packaged/subenv).

---

## Linia 1 — decorația elementelor negenerate

**Repo: QuickUVM Architect.** O stea/badge în ierarhia de verificare (și în diagrama
TB) care marchează elementele TB fără cod generat în spate (există în config, dar
`quick-uvm generate` nu le-a produs fișierul, sau config-ul s-a schimbat de la ultima
generare).

**Arhitectura (verificată)**: id-urile din arborele de verificare
(`tbtree-build.ts`/`tbtree.ts`) = id-urile din diagrama TB (`tbscene.ts`) minus
prefixul `v:` — deci un singur spațiu canonic de chei de element servește ambele
suprafețe. Sistemul de decorații de stare existent (`status.ts` `decosFromFindings`/
`statusIdsTb`, badge SVG `applyStatusBadges` în `main.ts`) e tiparul de urmat, DAR
„negenerat" e o stare derivată din filesystem, nu o constatare de validare — se poartă
pe un canal paralel, nu se suprapune peste `StatusDeco`.

**Detecție**: modul pur nou `src/genstate.ts` (fără `vscode`, testat în
`scripts/test-genstate.mjs`), cu `computeGenState(config, present, opts?)` →
`generated | missing | stale` per cheie de element. Sursa de adevăr = **manifestul
Track A** (`fromManifest`); un tabel de nume hard-codat rămâne fallback pentru
QuickUVM pre-manifest. I/O de filesystem stă în host (`workspace.fs.readDirectory`
pe dir-ul de ieșire — `quickuvm.outputDir`, rezolvat ca în `generate.ts:76,111`; a-l
citi pentru existență e ortogonal față de excluderea lui din glob-urile de surse).

**Suprafețe**:
- **Arbore**: `FileDecorationProvider` (idiomatic pentru stea/badge) — `tbtree.ts`
  setează `item.resourceUri` la un uri sintetic ce encodează cheia de element;
  `provideFileDecoration` întoarce `{ badge: "★", tooltip, propagate: true }`
  (bubble-up la `env`/rădăcină, coerent cu bubble-up-ul din `status.ts`). Fallback
  ieftin: `★` în `item.description`.
- **Diagramă**: `ungeneratedIdsTb(keys, presentIds)` pur în `status.ts` (simetric cu
  `statusIdsTb`) + un badge stea distinct (`.gen-badge`) în `main.ts`, separat vizual
  de badge-urile de severitate `✕`/`!`.

**Recalculare**: la schimbarea config-ului (`config.onOverlay`), la finalul generării
(`generator.onStatus`), la schimbări în dir-ul de ieșire (un `FileSystemWatcher`
debounced pe `<outDir>/**`, model `sidecar.ts:187-217`), și la schimbarea setării
`quickuvm.outputDir`.

**Slice-uri**:
- **1.1** — detector pur `genstate.ts` + teste (layout flat întâi; prinde cazurile
  dificile: numele scoreboard-ului flat picat, `<agent>_cov.svh` necondiționat).
- **1.2** — steaua în arbore (serviciu host `genwatch.ts` + `FileDecorationProvider`
  + `resourceUri` + `setUngenerated`). *Livrabilul principal.*
- **1.3** — badge-ul stea în diagramă (payload `status/decorations` extins +
  `ungeneratedIdsTb` + `applyGenBadges`).
- **1.4** (opțional) — starea `stale` + puntea `fromManifest` (aici `stale` devine
  fiabil). **Livrat pe hash de conținut, nu pe mtime**: quick-uvm nu rescrie fișierele
  al căror conținut nu s-a schimbat (asta ține build-urile downstream liniștite), deci
  după o regenerare mtime-urile rămân vechi și euristica „fișier mai vechi decât
  config-ul" ar rămâne blocată pe `stale` la infinit. Extensia înregistrează în
  `workspaceState`, per element, hash-ul config-ului din care a generat; `stale` =
  hash înregistrat ≠ hash curent. Element fără înregistrare (generat din CLI, în afara
  extensiei) nu e revendicat `stale` — badge-ul nu minte niciodată.

**Decizii deschise pentru utilizator**:
- Limbaj vizual: stea (FileDecoration) vs rând estompat vs icon overlay; în diagramă,
  glif stea vs contur estompat.
- O stare sau două: „negenerat" și „stale" colapsate în „needs generate", sau
  distincte? (`stale` e nefiabil FĂRĂ manifest — orice atingere a YAML-ului
  marchează tot stale.)
- Nodul DUT: se decorează? Singurul lui fișier e stub-ul `<d>.sv` (byproduct, nu cod
  TB) — probabil exclus, sau mapat pe `tb_top.sv`/`clkgen.sv`.
- Subenv-uri (`sub:<name>`): codul lor stă în dir-ul de ieșire al config-ului COPIL —
  verificare recursivă, sau nedecorat în v1?
- Nodul de coverage: `<agent>_cov.svh` există indiferent de `analysis.coverage`, deci
  existența fișierului nu distinge „coverage generat" — proxy grosier până la manifest.
- Bubble-up: `env`/rădăcina arată steaua când orice descendent e negenerat?

---

## Linia 2 — generare incrementală per-element

**Repo-uri: QuickUVM (capabilitate) + QuickUVM Architect (UX).** Regenerarea doar a
fișierelor unui element (agent/scoreboard/test/subenv), declanșată plauzibil când
utilizatorul încearcă să coboare în codul unui element încă negenerat.

**Capabilitatea QuickUVM = Track A** (`--only` repetabil + manifest). Nimic în plus.

**Hazardul central (verificat)**: fișierele agregate sunt manifeste de întreg-config
(`pkg.f.j2` iterează fiecare interfață; `tb_pkg.sv.j2` include fiecare agent/
scoreboard/test). Deci:
- **MODIFY al unui element existent e SIGUR** de regenerat singur (agregatele
  referă nume, nu conținut).
- **ADD / REMOVE / RENAME NU e** — agregatele (`tb_pkg.sv`+`pkg.f`, sau variantele
  packaged/subenv) devin stale până la co-regenerare. Exact regula `add-test`.
Concluzie: Architect-ul **adaugă mereu setul agregat** la orice generare scoped
(sunt câteva fișiere ieftine — regula `add-test` generalizată e default-ul sigur).

**UX Architect** (azi „coborârea în cod" pentru elemente TB e aproape complet nouă:
elementele TB n-au cale de open-source — doar RTL are `openLoc`; item-urile din
arborele TB n-au `contextValue`, deci niciun meniu contextual; DAR identitatea de
element există: `VNode.focus`/`selectId`, id-urile de drill din `tbscene.ts`):
- **Acțiune „Generate this item"** (meniu contextual pe nodurile arborelui TB) —
  `contextValue` per fel de VNode + intrare `view/item/context` gated pe
  `view == quickuvm.verification` + comandă `quickuvm.generateItem`.
- **Auto-oferta la coborâre** — acțiune distinctă „Open Generated Code" pe item-urile
  TB. La invocare: rezolvă fișierele elementului din manifest; dacă vreunul lipsește/
  e stale, modal „Generate `<item>` now?" → generare scoped → `openLoc` în fișierul
  produs.

**Puncte de atingere**: `generate.ts` refactorizat cu un helper scoped (arg-build +
`run()` + fallback ENOENT + `publishDiagnostics` + status chip partajate), plus
`generateItem(files)` care adaugă `--only <f>` per fișier + mereu setul agregat;
`actions.ts` metodele noi `generateItem`/`openGeneratedCode` (frați cu
`openSubenvConfig`, `actions.ts:1306`); `tbtree-build.ts`/`tbtree.ts` poartă felul +
`contextValue` (+ flag `generated`/`stale` pentru linia 1); `package.json` cele două
comenzi + meniuri; cache de manifest per-config (invalidat la salvarea YAML).

**Slice-uri**:
- **2.1** = Track A (QuickUVM: manifest + `--only` repetabil).
- **2.2** — Architect: acțiunea „Generate this item" (citește/cache-uiește manifestul,
  `contextValue`, `generate.ts` refactorizat în scoped-generate).
- **2.3** — Architect: oferta la coborâre („Open Generated Code": lipsă/stale → modal
  → generare scoped → `openLoc`).
- **2.4** — convergență cu linia 1 (același manifest decorează + declanșează).

**Riscuri / întrebări deschise**:
- Filelist-uri stale (riscul principal) — ADD/REMOVE/RENAME co-regenerează mereu
  agregatele; MODIFY nu. Manifestul expune fișierele-proprii ȘI setul agregat.
- „Per element" vs „per fișier" — unitatea de UX e elementul; mecanismul rămâne
  per-fișier prin `--only`. Manifestul le împacă (și trebuie să enumere fișierele
  EMISE real — prefixele/specializările variază).
- Variație layout/compoziție — manifestul e calculat din config-ul real; Architect-ul
  nu hardcodează nume. Deschis: pentru un element compus, regenerarea per-element are
  sens doar din config-ul TOP (rezoluția subenv se face acolo) — manifestul exprimă
  ownership peste arborele de compoziție, sau Architect-ul face scope la config-copil?
- Regenerarea scoped reflectă editările pending (contextul vine din YAML-ul curent) —
  dezirabil (o singură sursă de adevăr), dar de semnalat în UX: e „regenerează acest
  element din config-ul curent", nu „dintr-un snapshot".

---

## Linia 3 — paritate de schemă GUI ↔ QuickUVM

**Repo: QuickUVM Architect.** Constatarea de bază: GUI-ul autorizează cam **schema
0.9.2** — exact ce recunoaște `src/quickuvm.ts:1-6` („subsetul de config pe care îl
atinge extensia"). Tot ce a adăugat campania 1.0 (agenți reactivi/hibrizi/replica,
`inouts`, porturi bogate, `analysis` bogat, `register_model`, `regress`,
`kind: vip|selftest`, `from_vip`, uniunile multi-clock/reset, `top_name`) e
**neexpus**. Suprafața completă de editare = uniunea `ActionKind` cu 17 membri
(`protocol.ts:38-62`) — nu există altă cale de scriere.

### Paritate NEGATIVĂ — se repară primele (GUI-ul e greșit, nu doar tăcut)

- **Porturi inout blocate**: `createAgentFromPins` sare inout cu „inout not supported
  by the QuickUVM schema" (`actions.ts:218-223`) — stale, 1.0 suportă `inouts`/
  `open_drain`/`pullup`. Deblocare + câmpuri follow-on. Leverage mare (I2C/bidir).
- **Agenți hibrizi/de graniță blocați**: `createSubenv` refuză un bench cu agenți +
  subenvs (`actions.ts:599-612`) — stale, A9 a ridicat interdicția. Garda devine o
  ofertă, nu un refuz.
- **`QuvmProbe` e înaintea mutației lui**: `enum/struct/real/clock` sunt modelate
  (`quickuvm.ts:77-89`) și desenate, dar `addProbe` le pică (`yamlops.ts:623-628`).
  Pe jumătate cablat, ieftin de închis.

### Grupuri de goluri (leverage × tractabilitate)

- **Ieftine — „încă o mutație yamlops + un control de inspector"** (punctul forte al
  GUI-ului): toggle `active` agent (mutația EXISTĂ, `yamlops.ts:264`, lipsește doar
  butonul); scoreboard `window`/`reference_model.language`/`max_latency`-la-add;
  `register_model` (toate câmpurile scalare/enum/bool → un formular + o mutație);
  `regress` (4 scalare); `kind`/`top_name`/`auto_vseq_mode`/`layout`/metadate
  `project`; editare `tests[]`; `clock` period/unit/source + `reset` active_low/
  external ca inspector de sine-stătător; `subenvs.namespace`.
- **Medii — editor imbricat/listă, tot pur config**: intrări `coverage` bogate
  (coverpoints/bins/crosses); tipuri de port bogate (`enum`/`struct`/`packed_dims`/
  `type`/`constraint`); `parameters`+`instances` agent; autorarea scoreboard-urilor
  cross-bloc cu capete `<subenv>.<agent>` (desenul EXISTĂ, `tbscene.ts:795`; trebuie
  un selector de capete).
- **Scumpe — geometrie/interacțiune nouă sau cross-fișier**: liste multi-clock/
  multi-reset (comutator de mod + atribuire de domeniu per-agent + vizualizare per
  domeniu); agenți de graniță desenați la topul compoziției + cablați ca capete
  connection/xsb; `kind: vip` + consum `from_vip` (flux cross-fișier de VIP).

### Roadmap fazat P1–P5

- **P1 — adâncimea autorării de agent** (inspector; mai ales config, geometrie mică).
  Azi un agent se CREEAZĂ dar nu se EDITEAZĂ niciodată. Inspector de proprietăți de
  agent (scena desenează/selectează deja `tbagent`, `tbscene.ts:424`), oglindind
  `tbScoreboardEditor`. `setAgentField` peste `mode`, `respond`, `request_valid`,
  `request_ready`, `reorder_by`, `reorder_policy`, `proactive`, `replicas`,
  `seq_item_style`, `clock`/`reset` per-agent; cablarea `setAgentActive` existent la
  un toggle Active/Passive. Închide tot golul reactiv/hibrid/replica.
  **LIVRAT.** `tbAgentEditor` (webview) + acțiunea `editAgent` + op-ul pur
  `setAgentField`, cu toate câmpurile de mai sus. Două lucruri au ieșit din construcție:
  (a) referința de schemă documenta `request_ready` ca fiind pe *inițiator* — greșit,
  validatorul îl acceptă DOAR pe responder (`examples/axi_handshake` îl confirmă);
  rândurile responder din §1.5 sunt corectate. (b) Regulile de cuplare sunt *ziduri de
  validator*, nu convenții, deci nu ajunge să dezactivezi controalele: `setAgentField`
  **cascadează ștergerile** (înapoi la `initiator` ⇒ cad toate cheile responder-only;
  `respond` afară din `pipelined` ⇒ cad `reorder_*`). Dovedit prin mutație în e2e —
  aceeași configurație cu cheia rămasă în urmă e REFUZATĂ de quick-uvm.
  Rămas în afara feliei: `idle` (dict port→valoare, cere un editor imbricat) și
  `instances`/`parameters` (C3).
- **P2a LIVRAT — RAL + regresie.** Panelul „Verification settings" (inspector, în modul
  TB, independent de selecție) autorează cele două blocuri *comutate prin prezență*:
  `register_model:` (add cu cele trei câmpuri obligatorii cerute în față — `bus_agent`
  doar dintre agenții INIȚIATORI — apoi map/adapter/backdoor_root/`csr_tests` multiselect/
  `coverage`/`use_predictor`/`reg_test`/`reg_test_door`, plus remove) și `regress:`
  (simulator/filelist/seeds/coverage, add/remove). Regula descoperită la construcție:
  **ștergerea lui `regress:` trebuie să ia cu ea `tests[].seeds`** — QuickUVM refuză
  seeds fără bloc de regresie, deci `removeRegress` cascadează (dovedit prin mutație în
  e2e: aceeași configurație cu seeds rămas = REFUZ). Câmpurile obligatorii ale RAL-ului
  refuză golirea în loc să corupă blocul.
- **P2b LIVRAT — teste + identitatea bench-ului.** Editor `tests[]` (add/delete,
  `num_items`, `vseq`, `seeds` inert până există `regress:`) și secțiunea „Bench"
  (`layout`, `kind`, `top_name`, `auto_virtual_sequences`/`auto_vseq_mode`, metadate
  `project`). Două lucruri ieșite din construcție: (a) referința documenta greșit
  `tests` — **absența ≠ lista goală**: absent ⇒ `test1` implicit (rulabil), pe când
  `tests: []` e ACCEPTAT și dă ZERO teste (doar `<dut>_base_test.svh`, bench fără ce
  rula); de aceea ștergerea ultimului test scoate CHEIA, nu scrie `[]`. (b) `layout` și
  `kind` au precondiții dure (subenvs⇒packaged, `instances` C3⇒flat, vip aruncă tot
  stratul de bench), deci opțiunile blocate sunt DEZACTIVATE cu motivul afișat —
  `benchid.ts` (pur, testat) le calculează, iar e2e-ul verifică în AMBELE sensuri că
  verdictul gărzii coincide cu ce refuză/acceptă efectiv quick-uvm.
  Rămas: `tests[].sequence` (agent+nume+count) și `project.imports`.
- **P2 — formulare de config la nivel de bench** (pur config, doar formular). Panel
  „Verification settings": `register_model` (RAL — `bus_agent` din agenții
  inițiatori, `csr_tests` multiselect, `coverage` bool), `regress`, `kind`/
  `top_name`/`auto_vseq_mode`/`layout`, metadate `project`, editor `tests[]` (cu
  gărzile „seeds cere regress" și „ștergerea ultimului test reînvie test1"). Leverage
  mare (RAL + regresia sunt centrale la benchurile reale).
- **P3a LIVRAT — adâncimea scoreboard-ului.** Editorul de scoreboard capătă `window`
  (boundary dintre porturile EȘANTIONATE ale agentului sursă + `length`) și
  `reference_model.language` (sv / c — doar comutatorul, nu corpul). Ambele sunt
  mapări imbricate, deci `setScoreboardField` primește câmpuri cu punct
  (`window.boundary`, `reference_model.language`), iar o valoare implicită șterge
  MAPAREA, nu doar cheia. Cuplarea descoperită: **un window cere un scoreboard cu un
  singur flux** — adăugarea unui `monitor` îl șterge în cascadă, iar adăugarea unui
  window peste două fluxuri e refuzată la sursă (dovedit prin mutație: aceeași
  configurație cu window-ul rămas = REFUZ).
  Rămas pentru P3b: autorarea `coverage` bogat (editor imbricat coverpoints/bins/
  crosses) și scoreboard-urile cross-bloc (selectorul `<subenv>.<agent>` cere ca
  host-ul să citească configurațiile copiilor — fezabil, vezi `actions.ts` la
  `openTextDocument(childUri)`).
- **P3b LIVRAT — autorarea `coverage` bogat.** Un nod de coverage selectat deschide
  editorul imbricat: upgrade `coverage: [cmd]` (simplă rutare) → model bogat, apoi
  coverpoints (câmpuri din porturile agentului, unul per câmp), bin-uri cu o
  mini-sintaxă pe un rând (`5` / `0..7` / `1, 2, 3` → value/range/values), crossuri
  peste coverpoints DECLARATE, `goal`, și downgrade înapoi la rutare. Găsit la
  construcție: **șapte locuri citeau `analysis.coverage` ca listă de șiruri** — nodul
  din diagramă ar fi ajuns `[object Object]` de îndată ce feature-ul creează prima
  intrare bogată; toate trec acum prin `coveredAgent`. Cascada: ștergerea unui
  coverpoint ia cu ea crossurile care îl refereau (dovedit prin mutație). Editările
  modifică intrarea PE LOC, deci `illegal_bins`/`transitions`/bin-urile de cross
  scrise de mână nu se pierd (test dedicat).
  Rămas pentru P3c: scoreboard-uri cross-bloc (selectorul `<subenv>.<agent>` cere
  citirea configurațiilor copil) și coada adâncă (`at_least`, `auto_bin_max`,
  `illegal_bins`/`ignore_bins`/`transitions`, selecția `binsof` a crossurilor).
- **P3c LIVRAT — scoreboard-uri cross-bloc. P3 COMPLET.** Selectoarele de capăt
  (source/monitor, la adăugare și în inspector) oferă acum, pe o COMPOZIȚIE, și
  agenții blocurilor copil, calificați `<subenv>.<agent>` — exact ce face un
  scoreboard să fie cross-bloc. Cum copiii trăiesc în ALTE fișiere, `ConfigService`
  citește fiecare `subenvs[].config` la refresh și publică `childAgents` spre webview;
  un copil lipsă sau neparsabil nu contribuie nimic (compoziția se editează
  incremental, deci e o stare intermediară normală, nu o eroare). Un capăt scris de
  mână pe care nu-l cunoaștem rămâne selectabil, altfel deschiderea inspectorului
  l-ar rescrie tăcut la prima opțiune. Regula prinsă de e2e: **blocurile compuse
  împart UN namespace**, deci numele de agenți trebuie unice ÎNTRE copii.
  Rămas (coada adâncă, hand-edit): `at_least`, `auto_bin_max`,
  `illegal_bins`/`ignore_bins`, `transitions`, selecția `binsof` a crossurilor.
- **P3 — adâncimea de analysis** (câmpuri ieftine + un editor imbricat). Extinde
  editorul de scoreboard cu `window`, `reference_model.language` (dropdown sv/c — DOAR
  butonul, nu corpul), `max_latency`-la-add; autorare `coverage` bogat; autorare
  scoreboard cross-bloc (selector de capete `<subenv>.<agent>`).
- **P4a LIVRAT — domenii de ceas (M1).** Secțiunea „Clocks" autorează uniunea
  `clock:` mapare ↔ LISTĂ de domenii: adăugarea primului domeniu convertește maparea
  în listă (purtând câmpurile ei în primul domeniu, numit după ceasul curent),
  editare per-domeniu (period/unit/source/name), ștergere, și colapsare înapoi la un
  singur ceas dintr-o listă cu un element. Asta face utilizabil selectorul de domeniu
  per-agent livrat în P1 — până acum nimic nu crea listele din care alegea.
  Cascada: un domeniu **folosit de un agent nu se poate șterge** (QuickUVM refuză un
  `clock:` de agent către un domeniu nedeclarat) — dovedit prin mutație. Verificat că
  `source: dut` chiar produce un ceas OBSERVAT în `tb_top` (nu în `clkgen`, unde nu
  are ce căuta: TB-ul nu-l generează).
  Rămas pentru P4b: domenii de RESET (invariantul suplimentar `dut.reset` = numele
  unui domeniu declarat sub listă), `open_drain`/`pullup` pe inouts, tipuri de port
  bogate (enum/struct/packed_dims).
- **P4b LIVRAT — domenii de reset.** Simetric cu ceasurile, plus două invariante pe
  care ceasurile nu le au: sub LISTĂ `dut.reset` numește un DOMENIU declarat (nu un
  port), iar poarta `clock:` a unui domeniu trebuie să numească un domeniu de ceas
  declarat. Trei lucruri ieșite din construcție: (a) `external` există DOAR pe maparea
  simplă — intrările din listă resping cheia, deci conversia unui reset extern e
  REFUZATĂ în loc să piardă tăcut faptul că TB-ul nu conduce resetul; (b) redenumirea
  unui domeniu **cascadează** peste `dut.reset` și peste agenții porniți de el
  (dovedit prin mutație: fără cascadă, quick-uvm refuză); (c) un reset cu totul
  implicit nu scrie niciun bloc `reset:`, deci prima abatere trebuie să-l CREEZE —
  altfel rândurile de polaritate/externalitate ar fi aruncat pe un bench proaspăt.
  Capcană prinsă de teste: defaultul e PER CÂMP (`active_low` implicit true,
  `external` implicit false) — un singur test „falsy ⇒ default" ștergea exact
  `active_low: false`, adică abaterea cerută.
  Rămas pentru P4c: `open_drain`/`pullup` pe inouts și tipuri de port bogate
  (enum/struct/packed_dims).
- **P4c LIVRAT — adâncimea de porturi. P4 COMPLET.** Inspectorul de agent capătă un
  bloc „Ports" per port: `width` (rutat prin `setAgentPortWidth`, aceeași cale cu
  gestul de pin din diagramă), `randomize`, `constraint`, `enum` simbolic
  (mini-sintaxă `NAME=valoare, …`) și, pe INOUTS, perechea open-drain. Cuplările
  impuse la sursă, nu la generare: (a) `open_drain: true` **aprinde și `pullup: true`**
  și nu-l lasă scos — o linie open-drain nu conduce niciodată 1, deci fără pullup
  plutește în X din clipa în care toți eliberează („not a style preference" zice chiar
  validatorul); (b) open-drain doar pe 1 bit; (c) `enum`/`type`/`packed_dims`/`struct`
  sunt EXCLUSIVE — setarea uneia o scoate pe cealaltă autorată, iar peste
  `packed_dims`/`struct` scrise de mână se REFUZĂ în loc să se piardă tăcut.
  e2e-ul citește codul generat: `1'bz` în interfață și numele simbolice în seq_item.
- **P4 — adâncimea de porturi & ceasuri** (mediu-scump; atinge gestul de pini +
  geometrie). Deblocare inouts (`actions.ts:218`) cu `open_drain`/`pullup`; tipuri de
  port bogate; inspector clock/reset independent de setDut; autorare liste
  multi-clock/multi-reset cu atribuire de domeniu per-agent (respectând distincția
  listă-vs-mapare).
- **P5 LIVRAT — compoziție & VIP. LINIA 3 COMPLETĂ.** (a) *Consumul unui VIP prin
  referință*: „VIP agent (by reference)…" din paleta de adăugare deschide un selector
  de `.qvip`, citește agenții pe care îi livrează manifestul și scrie
  `{name, from_vip}` cu calea RELATIVĂ la configurația consumatoare. Regula descoperită
  rulând: **`from_vip` cere `layout: packaged`** (VIP-ul E un pachet extern) — op-ul îl
  pune, ca `createSubenvs`, iar `layoutBlockers` blochează întoarcerea la flat.
  (b) *`subenvs.namespace`*: selector pe nodul de subenv, cu AUTO explicat în etichetă
  (prefixează doar când același `config` e compus de ≥2 ori — un bloc folosit o dată
  rămâne byte-identic). (c) Garda hibridă era deja ridicată dintr-o felie anterioară.
  Verificat pe cod generat: sursa agentului referit NU se regenerează.
  **Finding pentru QuickUVM**: antetul `templates/vip_manifest.qvip.j2:3` documentează
  sintaxa VECHE (`agent_refs: {name, manifest}`), redenumită în 1.0 în
  `agents: {name, from_vip}` — manifestele generate poartă instrucțiuni greșite.
- **P5 — paritate de compoziție & VIP** (scump; geometrie nouă + cross-fișier). Garda
  hibridă stale (`actions.ts:599-612`) devine flux suportat (agenți de graniță la top,
  capete connection/xsb); autorare `kind: vip` (emite manifestul `.qvip`) + consum
  `from_vip` (rezolvă manifestul, înlănțuie `-F`); `subenvs.namespace`. Frecvență
  per-utilizator cea mai mică, cost cel mai mare — ultimul.

### Anti-scope (deliberat NEparitate — rămân hand-edit)

Coerent cu filozofia „GUI-ul editează *config*; corpurile predict/reference-model sunt
*cod* scris de om":
- **Corpuri SystemVerilog libere**: `constraints: list[str]`, expresii `constraint`
  per-port/scoreboard, `emit_when`, și **corpul C/SV `predict()`** din
  `reference_model`. Se expune butonul de *limbaj* (P3), niciodată corpul.
- **Corpuri de secvențe directed/nested**: `sequences[].steps[]` cu `directed`/
  `nested` + `field` per-pas alunecă spre cod procedural. Cel mult `{name, kind:
  random|incrementing, count}`.
- **Clauze `select` de cross-bin**, dicționare `idle`, nume de clasă `frontdoor`
  custom, `path` de probă liber dincolo de XMR-ul derivat din model — nișă, low-
  leverage, mai curat hand-edit (`createProbe` derivă deja XMR-ul corect; un editor de
  path liber invită capcana truncherii tăcute).

Fiindcă `yamlops.ts` editează Document-ul `yaml` chirurgical (comentarii/chei
necunoscute păstrate, `yamlops.ts:1-5`), toate item-urile anti-scope rămân
**hand-editabile alături** de editările GUI, fără pierdere — exact de ce nu trebuie
autorate din GUI.

---

## Secvențiere & dependențe

```
Track A (QuickUVM: manifest + --only repetabil)   ─┬─► Linia 1 (decorație)
                                                    └─► Linia 2 (incremental)

Linia 3 (paritate) — independentă, în paralel:
   paritate negativă (inouts, hibrid, probe fields)  ← ieftin, oricând
   P1 → P2 → P3 → P4 → P5                             ← ordonat, config-întâi
```

Track A e singura muncă QuickUVM; restul e Architect. Paritatea negativă (3
reparații de gărzi stale) e cel mai bun raport valoare/efort și nu depinde de nimic.
Recomandare de start: **Track A** (deblochează două direcții cu un PR) în paralel cu
**paritatea negativă** (trei bug-uri de deblocat), apoi liniile 1/2 pe manifest și
P1→P2 pe paritate.
