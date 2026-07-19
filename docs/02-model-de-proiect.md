# 02 — Modelul de proiect

Modelul de proiect este documentul JSON emis de backend și consumat de host și
webview. Este contractul stabil al sistemului: schema formală este
`schema/project-model.schema.json`, iar acest document explică semantica și
cazurile limită. Câmpul `schema_version` (întreg, azi `1`) se incrementează la
orice modificare incompatibilă; host-ul refuză versiuni necunoscute.

## Structura de ansamblu

```json
{
  "schema_version": 1,
  "tops": ["demo_top"],
  "modules":   { "<nume-definitie>": { ports, iface_ports, loc } },
  "instances": [ { path, module, params, loc, iface? } ],
  "views":     { "<cale-instanta>": { module, pins, nets } }
}
```

`modules` descrie *definițiile* (o intrare per modul/interfață, cu porturile
așa cum au fost elaborate la prima instanțiere întâlnită); `instances` descrie
*arborele elaborat* (o intrare per instanță, cu valorile efective ale
parametrilor); `views` descrie conectivitatea internă a instanțelor care au
copii.

## ID-uri stabile

Orice element adresabil se identifică prin cale ierarhică elaborată:

- instanță: `demo_top.u_soc.g_ch[1].u_ch` (blocurile generate apar cu numele
  și indexul construcției: `g_ch[1]`);
- pin de instanță într-o vedere: `g_ch[1].u_ch.dout` (relativ la vedere);
- port al modulului vederii: `<port>.din` (prefixul `<port>` îl distinge de
  pinii instanțelor copil);
- net: numele lui în scope-ul vederii.

Aceste chei sunt folosite de fișierul sidecar de layout (doc. 04), de overlay-ul
de configurare și de protocolul de mesaje (doc. 05). Ele sunt stabile la
re-parsare câtă vreme designul nu se redenumește — exact proprietatea cerută de
memoria spațială a utilizatorului.

## Porturi și tipuri

Per port: `name`, `dir` (`in` / `out` / `inout` / `ref`), `type` (textul
tipului elaborat, ex. `logic[15:0]$[0:2]`), `width` (lățimea totală în biți,
numerică — niciodată simbolică, pentru că modelul e post-elaborare),
`unpacked_dims` (lista dimensiunilor unpacked, `null` dacă nu e tablou),
`elem_width` (lățimea elementului pentru tablouri), `loc` (fișier + linie).

Cazuri limită documentate:

- **tablouri unpacked**: `width` = produsul dimensiunilor × lățimea
  elementului (`ch_out`: 3 × 16 = 48); UI-ul afișează `elem_width` pe pin și
  multiplicitatea separat;
- **porturi de interfață**: nu apar în `ports`, ci în `iface_ports`
  (`{name, interface, modport, loc}`); detaliul interfeței (semnale cu lățimi
  elaborate + modporturi cu direcții) e pe *instanța* de interfață
  (`instances[].iface`), pentru că lățimile depind de parametrii instanței;
- **tipuri fără dimensiune fixă** (dynamic array, string etc.): `width: null`;
  UI-ul le afișează fără etichetă de lățime.

## Vederi și conectivitate

O vedere există pentru fiecare instanță cu instanțe copil. Conține:

- `pins`: lista `{pin, conn}` — fiecare pin al fiecărei instanțe copil, cu
  expresia de conexiune normalizată;
- `nets`: lista `{name, endpoints, fanout, render}` — capetele includ pinii
  instanțelor și porturile modulului (`<port>.x`); `render` este *sugestia*
  fir/eticheta calculată din fan-out (prag configurabil, implicit >4 →
  eticheta).

### Expresii de conexiune normalizate

Descriptor recursiv cu `kind`:

| kind | semnificație | câmpuri |
|---|---|---|
| `net` | referință simplă la un net | `net` |
| `concat` | concatenare | `parts[]` (recursiv) |
| `select` | selecție element/interval | `base` (recursiv), `index` (numeric, elaborat per instanță; textul sursă în `text` poate conține genvar) |
| `const` | legare la constantă (tie-off) | `value` |
| `iface` | conexiune de interfață | `ref` (ex. `bus_i.slave`) |
| `expr` | expresie generală nerecunoscută | `text` (sintaxa sursă) — UI o afișează ca "logică de conexiune", fără pretenția de a o desena |
| `null` | pin neconectat | — (marcaj vizual de pin flotant) |

Regula de proiectare: descriptorii există ca UI-ul să poată desena joncțiuni și
să numere corect fan-out-ul, nu ca să reimplementeze evaluarea de expresii.
Orice caz nou întâlnit în practică se adaugă ca `kind` nou doar dacă are
consecință vizuală; altfel cade în `expr`.

## Politici care NU sunt în model

Modelul transportă fapte despre design; politicile de afișare aparțin UI-ului:

- regula "ceas/reset se afișează ca etichetă indiferent de fan-out" se aplică
  în UI pe baza rolurilor stabilite la configurare (sau euristic pe nume),
  nu în extractor;
- plierea instanțelor generate (`ch[0..2]`) e o operație de vedere: UI-ul
  grupează instanțele cu același prefix de cale și același modul/parametri;
- gruparea pinilor după prefix (`axi_*`) e de asemenea în UI.

## Extensii planificate ale schemei (nu implementate)

- `schema_version: 2`: atribute de fișier-sursă la nivel de definiție pentru
  proiecte multi-bibliotecă Bender (câmp `library`);
- diagnostice de compilare incluse în model (`diags[]`), ca host-ul să nu
  parseze stderr.
