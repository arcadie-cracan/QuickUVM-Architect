# 03 — Maparea model de proiect → configurație QuickUVM

Acest document definește formal cum se traduc selecțiile pe diagramă în câmpuri
ale YAML-ului QuickUVM. Referința de schemă QuickUVM: README-ul proiectului
QuickUVM (secțiunea "Config format") și modelele Pydantic din
`quick_uvm/models.py`. Principiu: YAML-ul este sursa de adevăr; extensia îl
*editează*, nu îl deține — orice câmp pe care extensia nu îl înțelege se
păstrează neatins la rescriere (editări chirurgicale, nu serializare completă).

## Desemnarea DUT-ului

Selecție: un bloc (instanță sau definiție) → comanda "Setează ca DUT".

| Sursă în model | Câmp YAML | Regulă |
|---|---|---|
| `instances[].module` | `dut.name` | numele definiției, nu al instanței |
| port cu nume `clk*`/`*clk*`, width=1, dir=in | `dut.clock` + `clock:` | euristic; chip de confirmat în UI, niciodată aplicat tacit |
| port `rst*`/`*rst*`, width=1, dir=in | `dut.reset` | polaritate: sufix `_n`/`_b` → `reset_active_low: true` |
| niciun candidat de ceas | `dut.combinational: true` | propus, confirmat de utilizator |
| resetul nu e port al DUT | `dut.external_reset` | decizie explicită a utilizatorului (checkbox), nu euristică |

Porturile alese ca ceas/reset primesc rol distinct în overlay și sunt excluse
din maparea pe agenți.

## Agenți din selecție de pini

Selecție: mulțime de pini ai DUT-ului → "Creează agent din selecție".

Regula centrală (atenție la inversare!): direcțiile din `agents[].ports` sunt
din perspectiva DUT-ului, ca în exemplele QuickUVM — porturile pe care agentul
le *conduce* sunt intrările DUT-ului:

| Pin DUT | YAML |
|---|---|
| `dir: in` (fără ceas/reset) | `agents[].ports.inputs[]` cu `{name, width}` |
| `dir: out` | `agents[].ports.outputs[]` cu `{name, width, randomize: false}` |
| `dir: inout` | nesuportat de schema QuickUVM azi → diagnostic; utilizatorul decide (exclude sau tratare în pragma) |

`width` se copiază numeric din model (post-elaborare — niciodată expresie).
Pentru tablouri unpacked: QuickUVM nu are noțiunea; extensia propune fie
aplatizare (`width = width_total`), fie excludere cu diagnostic — decizie
explicită per port.

Nume implicite generate (editabile): `interface: <agent>_if`,
`transaction: <agent>_seq_item`, `active: true`, `trans_style` din setarea
globală a extensiei.

## Agenți din interfețe SV

Selecție: un `iface_port` al DUT-ului → "Creează agent din interfață".

Sursa: `instances[].iface` al instanței de interfață conectate (semnale cu
lățimi elaborate) + modportul din `iface_ports[].modport`. Desfacerea în
`ports.inputs/outputs` folosește direcțiile modportului *DUT-ului*, cu aceeași
inversare de perspectivă: semnal `in` în modportul DUT → agentul îl conduce →
`inputs`. Semnalul de ceas al interfeței (dacă există) se leagă de `dut.clock`,
nu intră în agent. Limită cunoscută: QuickUVM își generează propriul
`<ag>_if.sv`; interfața SV existentă e sursa *specificației* agentului, nu e
refolosită ca fișier — dacă refolosirea devine cerință, e o evoluție de discutat
în QuickUVM, nu o problemă a extensiei.

## Sub-blocuri → subenvs

Selecție: o instanță în vederea-schemă → "Generează subenv".

| Sursă în model | Câmp YAML |
|---|---|
| numele instanței (sau al pliajului `ch[0..2]`) | `subenvs[].name` |
| calea către config-ul blocului (creat la nevoie prin același flux, recursiv) | `subenvs[].config` |
| `instances[].params` | `subenvs[].params` (copiere directă) |

Cazul "aceeași definiție, parametri diferiți" (exemplul `channels`): extensia
detectează instanțe ale aceluiași modul și generează subenv-uri care partajează
config-ul, cu `params` diferiți — mecanismul de auto-namespacing e deja în
QuickUVM.

Implementare (iul. 2026, acțiunea `createSubenv`):

- selecția = blocuri (instanțe sau pliaje) în vederea-schemă a modulului DUT;
  un pliaj se desface în membri — câte un subenv per instanță;
- `subenvs[].name` = calea relativă sanitizată la identificator SV
  (`g_ch[1].u_ch` → `g_ch_1_u_ch`); coliziunile primesc sufix numeric;
  subenv-urile cu același nume deja prezente în YAML se sar (idempotent);
- `subenvs[].config` = `<modul>.quickuvm.yaml` lângă config-ul top; dacă
  lipsește, se creează schelet (`newConfigText` + `dut` euristic — aceleași
  euristici de ceas/reset ca la „Set as DUT"), iar rezumatul apare în
  confirmarea multi-select: nimic nu se aplică tacit;
- `params` = copiere directă a parametrilor elaborați, dar **doar valorile
  întregi** (schema QuickUVM cere `dict[str, int]`); restul se omit cu notă;
- mutația asigură `layout: packaged` pe config-ul top (compunerea o cere:
  fiecare bloc copil e un pachet env reutilizabil; validat de QuickUVM);
- config-urile de bloc create nu perturbă config-ul activ: descoperirea e
  stabilă (fișierul activ rămâne activ cât timp există), iar la alegerea
  inițială dintre mai multe fișiere se exclud cele referite ca
  `subenvs[].config` de un altul — top-ul câștigă, nu primul alfabetic
  (regresie reală prinsă la validarea interactivă a `createSubenv`);
- fluxul recursiv e explicit: „Set as DUT" pe un modul diferit de DUT-ul
  config-ului activ întreabă — suprascrii DUT-ul config-ului activ
  (semantica fazei 2) sau creezi `<modul>.quickuvm.yaml` dedicat blocului,
  care devine config-ul activ al sesiunii; comutarea ulterioară între
  config-uri: comanda „Choose Active Config" (scrie `quickuvm.configFile`);
- gestul „Create subenv" e autonom și pe vederile ne-DUT: butonul e activ
  oricând sunt blocuri selectate, iar nepotrivirea de DUT se rezolvă ÎN
  flux — oferta „Create `<modul>`.quickuvm.yaml and set its DUT" (config-ul
  blocului devine activ, cu euristicile Set as DUT confirmate), apoi
  propunerile de subenv continuă în același gest; un buton mort care cere
  explicație e un gest greșit proiectat (raportat la validarea interactivă
  pe common_cells).

Constrângeri moștenite din QuickUVM (verificate pe HEAD, iul. 2026 — slice-ul
M1 clocked-subenv a ridicat restricția combinațional-only): blocurile copil
cu ceas sunt acceptate dacă sunt **single-clock, cu cel mult un reset**
(scheletul euristic creat de extensie satisface mereu condiția; frunzele
multi-clock rămân un slice viitor); `params` cere ca agentul blocului să
declare parametrul în `parameters:` (scheletul creat de extensie nu are încă
agenți, deci `generate` eșuează vizibil până când agentul blocului e
configurat — fluxul recursiv rămâne responsabilitatea utilizatorului); un
bloc parametrizat trebuie să fie single-agent; un bloc cu `register_model`
nu se poate compune încă.

## Net-uri interne → probes (schiță, QuickUVM ≥0.9.2 / K2)

Selecție: un net în orice vedere-schemă de sub DUT → „Create probe" (gest
planificat, faza 3b/4).

| Sursă în model | Câmp YAML |
|---|---|
| numele netului (sanitizat la identificator SV) | `probes[].name` |
| calea elaborată a netului minus calea instanței DUT (invariantul 4) | `probes[].path` |
| lățimea netului din model | `probes[].width` |

Probele sunt OBSERVE-only (XMR generat de QuickUVM în interfața de probe);
`enum`/`type` (coverage simbolic pe FSM-uri) cer ca extractorul să emită
tipurile net-urilor — azi svmodel dă doar lățimi. Constrângere QuickUVM:
`probes` nu sunt încă acceptate pe bench-uri subsystem (H1).

## Restul configurației

`project`, `clock.period/unit`, `tests[]`, `analysis`, `register_model` nu au
corespondent geometric pe diagrama designului — în fazele 2–3 se editează în
inspectorul lateral (formular simplu). Excepție utilă: `analysis.scoreboards[].source`
și `analysis.coverage[]` se pot alege prin click pe agent în diagramă. Din faza
3b, `analysis`, `virtual_sequences` și compoziția `subenvs` primesc reprezentare
și editare directă în vederea de verificare (docs/05, decizia D16); maparea
gesturilor pe câmpuri YAML se adaugă în acest document la implementare.

## Indicatorul de acoperire și validarea

Invariant afișat permanent: fiecare port al DUT-ului este în exact una din
stările {agent X, ceas/reset, ignorat explicit, nemapat}. "Nemapat" e starea de
lucru; generarea cu porturi nemapate cere confirmare. Validări la editare:

- port din YAML inexistent în model → diagnostic (Problems + marcaj pe
  diagramă); nu se șterge automat (invalidare grațioasă);
- lățime din YAML ≠ lățimea din model → diagnostic cu quick-fix "actualizează
  la N";
- suprapunere de pini între agenți → eroare (un pin aparține unui singur agent).

## Ciclul de generare

"Generează testbench" → task `quick-uvm generate --config <yaml> --output <dir>`;
erorile Pydantic/CLI se parsează în Problems. Post-MVP: `quick-uvm status`
alimentează decorații pe fișierele generate (user-modified / orphaned /
out-of-band), făcând vizibil contractul fail-closed al QuickUVM.
