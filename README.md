# QuickUVM Architect — extensie VSCode pentru vizualizarea designurilor SystemVerilog și proiectarea grafică a mediilor QuickUVM

Extensie VSCode care afișează diagrame interactive ale unui design SystemVerilog
(vederea-simbol și vederea-schemă) și permite definirea, prin selecție și
desen direct pe diagramă, a configurației YAML pentru
[QuickUVM](https://github.com/arcadie-cracan/QuickUVM), generatorul de medii de
verificare UVM — până la editarea grafică a arhitecturii testbench-ului
(vederea de verificare, faza 3b).

Diferențiatorul față de uneltele existente (TerosHDL, svls, verible-verilog-ls):
bucla **diagramă interactivă → configurație de verificare**, care nu există în
niciun tool open-source; vizualizarea nu e scopul, ci mecanismul de specificare.

## Numele

Nume afișat în Marketplace: **QuickUVM Architect — SystemVerilog schematic
viewer & UVM testbench designer**; identificator de extensie:
`quickuvm-architect`; spațiul de nume tehnic (comenzi, setări, view-uri):
`quickuvm.*`; prefixul comenzilor în paleta VSCode: `QuickUVM Architect:`.
Numele pune utilizatorul în rolul arhitectului de verificare: studiază
structura RTL (vederile simbol și schemă) și proiectează arhitectura
mediului UVM (vederea de verificare). Sub-brand al QuickUVM — generatorul și
editorul lui grafic, găsibile împreună. Istoric: proiectul s-a numit QuickXray
până în iul. 2026 (metafora radiografiei acoperea doar jumătatea de
vizualizare); redenumirea și alternativele respinse: docs/06-plan-mvp.md,
deciziile D11 și D17.

## Arhitectura pe scurt

```
Bender (listă fișiere + define)
   └─> backend semantic: pyslang/slang (elaborare completă)
          └─> model de proiect JSON  (schema/project-model.schema.json)
                 └─> extension host TypeScript (tree view, comenzi, diagnostice)
                        └─> webview: diagramă SVG peste layout ELK
                               └─> selecție -> editare YAML QuickUVM (sursă de adevăr)
                                      └─> quick-uvm generate (task VSCode)
```

Deciziile de proiectare și motivațiile lor sunt în `docs/` (începe cu
`docs/01-arhitectura.md`); jurnalul deciziilor deja luate este în
`docs/06-plan-mvp.md`.

## Starea actuală

**Faza 0 (validare backend) — încheiată**: `backend/svmodel.py` este un
extractor funcțional care produce modelul de proiect complet — ierarhie elaborată
cu ID-uri stabile, porturi cu lățimi numerice (inclusiv tablouri unpacked),
parametri per instanță, interfețe cu modporturi, conectivitate cu expresii
normalizate și fan-out per net. Validat pe `examples/` (design derivat din
exemplele QuickUVM `soc` și `channels`, extins cu generate, parametri și
interfață cu modport) și acoperit de teste pytest (`backend/tests/`).

**Faza 1 (schelet de extensie + vederea-simbol read-only) — încheiată**:
extensie TypeScript cu backend-ul pornit ca proces copil (debounce la salvare,
diagnostice slang în Problems, ultimul model valid păstrat la erori), tree view
de ierarhie cu parametrii efectivi, webview cu vederea-simbol (layout ELK,
intrări stânga / ieșiri dreapta / ceas-reset stânga-jos, lățimi și multiplicități
pe pin, interfețe hașurate, pan/zoom, selecție, salt-la-sursă din pin) și listă
de fișiere din Bender cu fallback `.f`/glob. Criteriul de încheiere a fost
validat interactiv pe un proiect Bender real (common_cells,
`examples-bender/`): ierarhie, vederea-simbol, salt-la-sursă din pin.

**Faza 2 (configurarea QuickUVM — nucleul valoric) — încheiată**: overlay
de configurare derivat din YAML (culori + forme pe pinii agenților, roluri
ceas/reset, indicator de acoperire N/M), acțiunile „Setează ca DUT" (euristici
confirmate explicit), „Creează agent din selecție" (cu inversarea perspectivei
DUT→agent din docs/03), „Agent din interfață" (desfacerea modportului),
„Ignoră portul" (persistat în `x_quickuvm_architect.ignored_ports`) — toate ca editări
chirurgicale de YAML prin `WorkspaceEdit` (biblioteca `yaml`, comentariile și
câmpurile străine se păstrează); validări model↔YAML ca diagnostice (port
orfan, lățime divergentă cu quick-fix, pin revendicat de doi agenți);
inspector lateral în webview; comanda „Generează testbench" cu erorile
quick-uvm în Problems. Fluxul DUT→agent→testbench generat e validat
programatic contra quick-uvm real (`npm run test:e2e`) și bifat interactiv în
Extension Development Host.

## Quickstart

Backend singur (faza 0):

```bash
pip install pyslang            # slang 11 cu API Python
cd examples
python3 ../backend/svmodel.py adder.sv inverter.sv chan.sv soc_top.sv \
        --top demo_top -o model.json
```

`model.json` este exact structura pe care o consumă webview-ul; un exemplar
generat este inclus în `examples/model.json`.

Extensia (faza 1):

```bash
npm install
npm run build                  # dist/extension.js + dist/webview.js
python -m pip install -r backend/requirements-dev.txt
python -m pytest backend/tests # 14 teste pe extractor
```

Apoi F5 în VSCode (configurația „Rulează extensia (examples/)”): se deschide un
Extension Development Host pe `examples/`, cu `quickuvm.top=demo_top` presetat;
vederea „QuickUVM Architect → Ierarhie” arată arborele, click pe o instanță deschide
vederea-simbol, dublu-click pe un pin sare la declarația portului.

Pentru validarea pe un proiect Bender real există configurația de lansare
„Rulează extensia (Bender: common_cells)”, care deschide clona din
`examples-bender/common_cells` (top presetat `cdc_fifo_gray`; detalii și cum se
reface clona: `examples-bender/README.md`).

## Structura depozitului

| Cale | Conținut |
|---|---|
| `backend/svmodel.py` | extractorul de model (pyslang), CLI compatibil cu liste `.f` de la Bender |
| `backend/tests/` | testele pytest ale extractorului (criterii CLAUDE.md, snapshot, validare schemă) |
| `src/` | extensia TypeScript: `extension.ts` (orchestrare), `backend.ts` (proces copil + diagnostice), `filelist.ts` (Bender/.f/glob), `tree.ts` (ierarhia), `panel.ts` (webview), `model.ts`/`protocol.ts` (contractul), `webview/main.ts` (diagrama ELK+SVG) |
| `media/` | stiluri webview (variabile de temă VSCode) și iconița |
| `schema/project-model.schema.json` | schema JSON a modelului de proiect — contractul backend↔UI |
| `docs/01-arhitectura.md` | arhitectura generală și responsabilitățile componentelor |
| `docs/02-model-de-proiect.md` | modelul de proiect: semantică, ID-uri stabile, cazuri limită |
| `docs/03-mapare-quickuvm.md` | maparea formală model → YAML QuickUVM |
| `docs/04-layout-si-rutare.md` | strategia de layout (ELK + poziții deținute de utilizator), formatul sidecar, ierarhia de override-uri de rutare |
| `docs/05-ui-si-protocol.md` | vederile, fluxurile UI de configurare, protocolul de mesaje extensie↔webview |
| `docs/06-plan-mvp.md` | planul pe faze, riscuri, jurnalul deciziilor |
| `examples/` | design de test + `model.json` generat |
| `CLAUDE.md` | convenții și context pentru sesiunile de lucru cu Claude Code |

## Cerințe

- Python ≥ 3.10, `pyslang` ≥ 11 (faza 0–1)
- Node.js ≥ 20 + `@types/vscode` (fazele 1+, scheletul de extensie)
- opțional: `bender` pentru liste de fișiere, `quick-uvm` pentru generare
