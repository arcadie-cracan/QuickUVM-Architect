# examples-bender — proiect Bender real pentru validarea fazei 1

`common_cells/` este o clonă superficială (`git clone --depth 1`) a
[pulp-platform/common_cells](https://github.com/pulp-platform/common_cells) —
proiectul canonic al ecosistemului Bender, cu licența lui proprie (Solderpad,
vezi `common_cells/LICENSE`). Nu face parte din extensie (e exclus prin
`.vscodeignore`) și nu se distribuie; există local doar ca teren de validare
pentru criteriul de încheiere al fazei 1: „deschizi un proiect Bender real,
vezi ierarhia și diagrama de context a oricărui modul, cu salt-la-sursă din
pin".

Pregătit deja:

- dependențele Bender sunt rezolvate (`.bender/`, `Bender.lock` — create de
  `bender script flist-plus`, care rulează automat și din extensie);
- `.vscode/settings.json` presetează `quickuvm.top = cdc_fifo_gray` (FIFO de
  trecere între domenii de ceas: 24 de instanțe, 8 vederi, ierarhie pe 3
  niveluri cu celule din `tech_cells_generic` — 0 erori, 15 avertismente care
  populează Problems).

Pasul interactiv: configurația de lansare „Rulează extensia (Bender:
common_cells)" din `.vscode/launch.json` al depozitului, apoi în Extension
Development Host: ierarhia în vederea QuickUVM Architect, click pe o instanță →
vederea de context, dublu-click pe un pin → declarația portului.

Clona poate fi ștearsă oricând; se reface cu:

```bash
git clone --depth 1 https://github.com/pulp-platform/common_cells.git \
    examples-bender/common_cells
```

## Validarea fazei 3 (vederea-schemă, iul. 2026)

`model-cdc.json` e modelul de proiect derivat (regenerabil, nu se
distribuie), folosit de măturarea automată din `scripts/harness.html`:
toate cele 8 vederi-schemă și cele 24 de simboluri randate fără excepții,
zero muchii prin blocuri, drag → snapshot total (D21), comutare
fir↔etichetă cu persistență corectă. Regenerare (atenție la capcana din
CLAUDE.md — liniile `.f` cu spații în căi se citează):

```bash
cd examples-bender/common_cells && bender script flist-plus > cc-raw.f
# citează căile cu spații din cc-raw.f, apoi, din rădăcina depozitului:
python backend/svmodel.py -f cc.f --top cdc_fifo_gray \
       -o examples-bender/model-cdc.json
```
