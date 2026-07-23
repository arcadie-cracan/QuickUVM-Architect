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
- **P2 — formulare de config la nivel de bench** (pur config, doar formular). Panel
  „Verification settings": `register_model` (RAL — `bus_agent` din agenții
  inițiatori, `csr_tests` multiselect, `coverage` bool), `regress`, `kind`/
  `top_name`/`auto_vseq_mode`/`layout`, metadate `project`, editor `tests[]` (cu
  gărzile „seeds cere regress" și „ștergerea ultimului test reînvie test1"). Leverage
  mare (RAL + regresia sunt centrale la benchurile reale).
- **P3 — adâncimea de analysis** (câmpuri ieftine + un editor imbricat). Extinde
  editorul de scoreboard cu `window`, `reference_model.language` (dropdown sv/c — DOAR
  butonul, nu corpul), `max_latency`-la-add; autorare `coverage` bogat; autorare
  scoreboard cross-bloc (selector de capete `<subenv>.<agent>`).
- **P4 — adâncimea de porturi & ceasuri** (mediu-scump; atinge gestul de pini +
  geometrie). Deblocare inouts (`actions.ts:218`) cu `open_drain`/`pullup`; tipuri de
  port bogate; inspector clock/reset independent de setDut; autorare liste
  multi-clock/multi-reset cu atribuire de domeniu per-agent (respectând distincția
  listă-vs-mapare).
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
