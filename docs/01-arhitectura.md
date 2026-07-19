# 01 — Arhitectura generală

## Scop și diferențiator

Extensia oferă două lucruri legate: (a) vizualizarea unui proiect SystemVerilog
ca diagramă bloc navigabilă și (b) definirea, prin selecție directă pe diagramă,
a configurației YAML pentru QuickUVM. Vizualizarea de una singură există în alte
unelte (TerosHDL cu Yosys, hierarchy view în svlangserver); bucla
diagramă → configurație de verificare nu există nicăieri și este motivul
proiectului. Orice decizie de design se judecă după cât servește această buclă.

## Componente și responsabilități

```
┌────────────────────────────────────────────────────────────────────┐
│ VSCode                                                             │
│  ┌──────────────────────┐   mesaje JSON    ┌────────────────────┐  │
│  │ extension host (TS)  │◄────────────────►│ webview            │  │
│  │ - tree view ierarhie │   (protocol      │ - diagramă SVG     │  │
│  │ - comenzi, QuickPick │    versionat,    │ - layout elkjs     │  │
│  │ - diagnostice        │    doc. 05)      │ - selecție, drag   │  │
│  │ - task quick-uvm     │                  │ - inspector config │  │
│  │ - WorkspaceEdit YAML │                  └────────────────────┘  │
│  └─────────┬────────────┘                                          │
│            │ stdio JSON                                            │
└────────────┼───────────────────────────────────────────────────────┘
             ▼
   ┌───────────────────────┐        ┌─────────────────────┐
   │ backend semantic      │  -f    │ bender              │
   │ svmodel (pyslang)     │◄───────│ listă fișiere,      │
   │ -> model de proiect   │        │ define, target-uri  │
   └───────────────────────┘        └─────────────────────┘
```

**Bender** furnizează lista ordonată de fișiere, directoarele de include și
define-urile (`bender script flist-plus`; formatul `flist` simplu pierde
`export_include_dirs`). Extensia nu ghicește componența proiectului; pentru
proiecte fără Bender, fallback: glob configurabil pe workspace + fișier `.f`
scris de utilizator.

**Backend-ul semantic** (`backend/svmodel.py`, pyslang) compilează și
elaborează designul și emite modelul de proiect JSON. Elaborarea completă este
cerința care a decis alegerea slang în locul sv-parser: lățimi `[W-1:0]`
evaluate numeric, `generate` desfăcut cu valorile reale ale parametrilor,
interfețe cu modporturi rezolvate semantic (istoria comparației: doc. 06,
jurnalul deciziilor). Backend-ul e proces separat, pornit de extensie la
deschiderea proiectului și re-rulat la salvarea fișierelor SV (debounced);
modelul de compilare slang e whole-design, dar rapid — nu se optimizează
incremental înainte de a măsura o problemă reală.

**Extension host** (TypeScript) deține: tree view-ul de ierarhie în sidebar
(nativ), comenzile ("Setează ca DUT", "Creează agent din selecție",
"Re-aranjează", "Generează testbench"), QuickPick-urile, diagnosticele
(Problems), task-ul `quick-uvm generate` și toate editările YAML prin
`WorkspaceEdit`. Regulă: tot ce poate fi UI nativ VSCode este nativ.

**Webview-ul** deține doar ce nu poate fi nativ: diagrama (SVG generat manual
peste layout elkjs) și inspectorul de configurare. `retainContextWhenHidden`
activ; `getState`/`setState` ca plasă de siguranță la restart; temă prin
variabilele CSS `--vscode-*`.

## Fluxurile de date principale

1. **Deschidere proiect**: bender → `.f` → svmodel → model JSON → host → webview
   (layout inițial ELK complet) + tree view.
2. **Modificare sursă SV**: watcher → svmodel re-rulat → model nou → diff pe
   ID-uri stabile → webview actualizează incremental (ELK interactiv doar
   pentru elementele noi; doc. 04). Pe erori de compilare: modelul vechi rămâne
   afișat, banner "vedere neactualizată (N erori)", diagnosticele merg în
   Problems.
3. **Configurare QuickUVM**: selecție pe diagramă → comandă → `WorkspaceEdit`
   pe fișierul YAML → parser YAML în host → overlay actualizat pe diagramă
   (culori agenți, indicator de acoperire). YAML-ul e sursă de adevăr; doc. 03
   definește maparea, doc. 05 fluxurile UI.
4. **Generare**: buton/comandă → task VSCode `quick-uvm generate` → erori
   Pydantic parsate în Problems; ulterior `quick-uvm status` → decorații pe
   fișierele generate în Explorer.

## Invarianți (rezumat; detalii în CLAUDE.md)

- modelul JSON = contract stabil; backend înlocuibil (slang CLI `--ast-json`,
  tool C++ pe libslang, sau alt front-end) fără a atinge UI-ul;
- YAML = sursă de adevăr; UI fără stare proprie de configurare;
- pozițiile nodurilor aparțin utilizatorului; auto-layout complet doar la cerere;
- ID-uri stabile = căi ierarhice elaborate;
- invalidare grațioasă pentru override-uri orfane și pentru cod care nu compilează.

## Ce este explicit în afara scopului (MVP)

- editare de schemă (extensia nu modifică RTL-ul);
- netlist post-sinteză (dacă apare cerința: Yosys/UHDM, decizie separată);
- suport VHDL / mixed-language;
- layout automat "frumos" cu optimizări continue — contrazice invariantul 3.
