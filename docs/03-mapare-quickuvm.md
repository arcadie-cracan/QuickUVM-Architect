# 03 — Maparea model de proiect → configurație QuickUVM

Acest document definește formal cum se traduc selecțiile pe diagramă în câmpuri
ale YAML-ului QuickUVM. Referința de schemă QuickUVM: README-ul proiectului
QuickUVM (secțiunea "Config format") și modelele Pydantic din
`quick_uvm/models.py`. Principiu: YAML-ul este sursa de adevăr; extensia îl
*editează*, nu îl deține — orice câmp pe care extensia nu îl înțelege se
păstrează neatins la rescriere (editări chirurgicale, nu serializare completă).

## Designating the DUT

Selection: a block (instance or definition) → the "Set as DUT" command.

| Source in the model | YAML field | Rule |
|---|---|---|
| `instances[].module` | `dut.name` | the definition's name, not the instance's |
| port named `clk*`/`*clk*`, width=1, dir=in | `dut.clock` + `clock:` | heuristic; a chip to confirm in the UI, never applied silently |
| port `rst*`/`*rst*`, width=1, dir=in | `dut.reset` (the port NAME only) | heuristic, confirmed like the clock; only on a clocked DUT |
| the reset's polarity | top-level `reset: {active_low: false}` | suffix `_n`/`_b`/`_ni`/`_bi` → active-low, which is QuickUVM's default and writes nothing; only an active-high reset writes the key |
| who drives the reset | top-level `reset: {external: true}` | **derived, not asked** — written whenever no agent declares the reset port (see below) |
| no clock candidate | `dut.combinational: true`, `dut.reset: ''` | proposed, confirmed by the user; a combinational DUT gets no reset |

The ports chosen as clock/reset get a distinct role in the overlay and are
excluded from the mapping onto agents.

### Who drives the reset — and what "external" means

`reset.external` is QuickUVM's word, and it does **not** mean "the reset is not
a DUT port" (the meaning this document gave it until Nov 2026, under the
pre-1.0 key `dut.external_reset`). It means *external to the agents*: the
testbench top drives the reset instead of an agent. Probed on quick-uvm 1.1.0 —
the single-reset mapping has exactly three shapes, two of which work:

| Shape | What `tb_top.sv` gets | Verdict |
|---|---|---|
| `reset: {external: true}` | `logic rst_n;`, a generated `initial` block (assert, 5 clocks, deassert — the polarity follows `active_low`), every interface declared `(input clk, input rst_n)`, drivers/monitors wait for the release | **what Architect writes** |
| not external, an agent declares the port (`ports.inputs`) | the port is a field of that agent's sequence item, driven like any stimulus; the DUT is wired to that agent's interface | legal, hand-written only (it is the shape of quick-uvm's own `init` scaffold) |
| not external, **no** agent declares the port | `.rst_n(<first agent>_if_inst.rst_n)` — a signal that interface does not have. `generate` exits 0; **elaboration fails** | the `reset-undriven` finding |

Architect keeps the reset pin out of every agent (the role above), so the third
shape is what *every* Architect bench with a reset used to be — including the
tutorial's. `setDut` (`src/yamlops.ts`) now derives `external: true` from the
document (`resetNeedsExternal`): a reset port, a clocked DUT, no agent that
declares the port. The same rule on the neighbouring gestures: collapsing a
one-domain reset list restores `external: true`; adding a reset domain drops it
(under a LIST the top drives every domain — that is what the list means, which
is why the list entry schema has no `external`) and is refused when an agent
declares the port (quick-uvm: "collides with a clock/reset net").

The walls around it, all from the generator:

- `combinational: true` + `reset: {external: true}` is **refused** ("a
  combinational DUT has no reset"), and a combinational DUT's reset port is left
  unconnected — so "Set as DUT" assigns no reset role on a combinational DUT;
  the pin stays unmapped, for an agent or a waiver.
- `external: true` + the port among an agent's ports is **refused** ("An
  external reset must not also be an agent port").
- the reset port cannot be waived (`dut.unverified_ports`): "the bench itself
  drives it".
- an agent with `reset_port` (the agent-side reset output — an agent-driven
  reset under another port name) is **refused** next to `external: true`; there
  `dut.reset` must be `''` or name that port.
- `kind: selftest` + `external: true` is **accepted and hangs**: the DUT-less
  top instantiates the interfaces with the clock only, while they take a
  `rst_n` input and the drivers wait for it. A selftest never gets the flag
  (`setBenchField("kind", …)` drops it and restores it on the way back). A
  `kind: vip` keeps it: the flag decides whether the VIP's interfaces take the
  reset, and the VIP and the bench that consumes it must agree.
- in a composition, a clocked leaf whose own config is **not** external gets no
  reset connection at all in the subsystem top (the port floats — no error);
  with `external: true` the top declares, drives and connects `<subenv>_<reset>`.

Configs written before this are repaired by the validation
(`reset-undriven` in `src/configcheck.ts`, an error): on the DUT's reset pin and
on the Env box in the diagram, in the Problems panel on `dut.reset`, with a
one-click fix. Which fix depends on whether the top CAN drive the reset:

| situation | repair |
|---|---|
| the usual one: a reset pin nobody drives | "Let the testbench top drive it" — `editReset set external true` |
| the model's DUT has no port of that name (an absent `dut.reset` is the generator's default `rst_n`; or a typo) | "Declare no reset port" — `editReset clear` → `dut.reset: ''` |
| an agent drives the reset through `reset_port` | the same `clear` (`external: true` would be refused) |

It is silent where the generator wires no reset or the YAML cannot tell: a
combinational DUT, `kind: selftest` / `kind: vip`, a pure subsystem top, and a
bench with a `from_vip` agent (its ports live in the VIP manifest).

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
