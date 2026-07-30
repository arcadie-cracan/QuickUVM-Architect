# Tutorial — un mediu de verificare pentru `yapp_buffer`

Acesta e exercițiul de **validare de închidere a MVP-ului** (criteriul din
`docs/06-plan-mvp.md`, Felia 3b): pornind de la un design SystemVerilog, se
construiește **integral grafic** — fără a scrie YAML de mână — un mediu de
verificare cu **≥2 agenți, un scoreboard two-stream și un colector de
coverage**, se re-aranjează diagrama, iar la final `quick-uvm generate` produce
un testbench curat dintr-un YAML lizibil.

Designul-fixtură e [`examples-yapp/yapp_buffer.sv`](../examples-yapp/yapp_buffer.sv):
un buffer de pachete de un slot, cu o graniță clară intrare/ieșire — exact cei doi
agenți de care avem nevoie.

> **Nu-l confunda cu routerul YAPP.** Routerul e un demux 1→3
> (`out0_*`/`out1_*`/`out2_*`) și trăiește în celălalt repo, la
> `QuickUVM/examples/yapp/rtl/yapp_router.sv`; el e subiectul walkthrough-ului
> vizual [`yapp-router-walkthrough.html`](yapp-router-walkthrough.html), care se
> verifică cu **un singur** agent. Fixtura de aici e o reducere deliberată a lui:
> handshake-ul `ready` în ambele sensuri e ce dă **doi** agenți, adică exact ce
> cere criteriul de închidere. (Până în iul. 2026 fixtura se numea tot
> `yapp_router`, ceea ce făcea ca pașii de mai jos și capturile walkthrough-ului
> să descrie două designuri diferite cu același nume.)

| Semnal | Direcție DUT | Rol în verificare |
|---|---|---|
| `clk`, `rst_n` | in | ceas + reset (se dau la „Set as DUT", nu la agenți) |
| `in_data[8]`, `in_addr[2]`, `in_valid` | in | fluxul de **comandă** — agentul `cmd` le CONDUCE |
| `in_ready` | out | handshake-ul de intrare — agentul `cmd` îl observă |
| `out_data[8]`, `out_addr[2]`, `out_valid` | out | fluxul de **răspuns** — agentul `rsp` le observă |
| `out_ready` | in | backpressure — agentul `rsp` îl conduce |

> **Verificat empiric**: acest design se parsează cu `svmodel`, iar config-ul
> din pașii de mai jos generează curat cu `quick-uvm` 0.9.2 (ambele variante de
> scoreboard, in-order și out-of-order). Deci pașii nu sunt doar plauzibili — duc
> garantat la un testbench generabil.

---

## 0. Pornește Extension Development Host

În VSCode (repo-ul extensiei deschis), din panoul **Run and Debug** alege
configurația **„Ruleaza extensia (tutorial: yapp_buffer)"** și apasă F5. Se
compilează extensia (`npm: build`) și se deschide o fereastră nouă cu folderul
`examples-yapp/` ca workspace, cu `quickuvm.top = yapp_buffer` presetat.

În fereastra nouă, deschide bara laterală **QuickUVM Architect** (iconița din
activity bar). Vezi trei secțiuni: **Design Hierarchy**, **Verification
Hierarchy** și **Properties**.

> **Properties e SINGURUL inspector** (iul. 2026). Până atunci, diagrama avea și
> ea un inspector propriu, într-o coloană în dreapta pânzei; acela a fost SCOS,
> iar tot ce edita el a fost mutat în Properties — deci diagrama ocupă acum toată
> lățimea editorului. Dacă un pas de mai jos spune doar „inspector", e vorba de
> panoul **Properties** din bara laterală.

---

## 1. Deschide designul și setează DUT-ul

1. În **Design Hierarchy** apare rădăcina **„top module"** și, sub ea,
   `yapp_buffer`. Clic pe `yapp_buffer` → se deschide **schema/simbolul** lui
   (o cutie cu toți pinii pe laturi).
2. În panoul **Properties** din bara laterală, la secțiunea de configurare, apasă
   **„Set as DUT"**. Extensia:
   - detectează euristic ceasul (`clk`) și reset-ul (`rst_n`, activ-jos — sufixul
     `_n`), pe care le confirmi;
   - creează un fișier `yapp_buffer.quickuvm.yaml` lângă design.

   Overlay-ul se aprinde: pinii nemapați (toți, deocamdată) sunt marcați, iar
   `clk`/`rst_n` primesc rolul de ceas/reset.

---

## 2. Agentul de COMANDĂ (`cmd`) — din pinii de intrare

1. În schema/simbolul lui `yapp_buffer`, **selectează** pinii fluxului de
   comandă: `in_data`, `in_addr`, `in_valid` și handshake-ul `in_ready`
   (clic pe fiecare pin; sau lasso peste ei).
2. În inspector apare **„Agent from selection (4)"** — apasă-l.
3. Dă-i numele **`cmd`**. Extensia inversează perspectiva (docs/03): porturile
   de **intrare** ale DUT-ului devin ce **conduce** agentul
   (`in_data`, `in_addr`, `in_valid`), iar `in_ready` (ieșire DUT) devine ce
   **observă**.

Pinii lui `cmd` se colorează acum cu culoarea agentului.

---

## 3. Agentul de RĂSPUNS (`rsp`) — din pinii de ieșire

1. Selectează pinii fluxului de răspuns: `out_data`, `out_addr`, `out_valid` și
   backpressure-ul `out_ready`.
2. **„Agent from selection (4)"** → nume **`rsp`**. De data asta `out_ready`
   (intrare DUT) e ce conduce agentul, iar `out_data`/`out_addr`/`out_valid`
   (ieșiri DUT) sunt ce observă.

Acum ai **2 agenți** și toți pinii de date sunt mapați (doar `clk`/`rst_n`
rămân ceas/reset). ✔️ *criteriul „≥2 agenți"*

---

## 4. Deschide diagrama de verificare

Ai două căi echivalente — a doua validează **Felia 4**:

- **A.** În inspector, apasă **„Open verification view"** (sau butonul
  **„Testbench"** din header-ul diagramei).
- **B.** *(Felia 4)* În **Explorer**, dublu-clic pe `yapp_buffer.quickuvm.yaml`
  → fișierul se deschide **direct ca diagrama de verificare** (editorul
  implicit). Pentru YAML brut: clic-dreapta pe tab → **„Reopen Editor With… →
  Text Editor"**.

Vezi rădăcina testbench-ului: **DUT** (`yapp_buffer`) + **Env**, cu o interfață
per agent între ei. Dublu-clic pe **Env** coboară la nivelul agenților.

---

## 5. Scoreboard two-stream (`cmd` vs `rsp`)

La nivelul **Env** (sau din secțiunea „Add component" a inspectorului),
apasă **„Scoreboard"**. Completează în QuickPick-uri:

1. **Source** (fluxul stimul) → `cmd`.
2. **Monitor** (fluxul observat, A2 two-stream) → `rsp`.
3. **Strategia** → **„Out of order (keyed pool — a reordering DUT)"**.
4. **Match key** → `out_addr` (câmpul după care se împerechează pachetele).
5. **Nume** → `pkt_sb` (sau lasă implicitul `sbd`).

> Alternativă mai simplă: la strategie alege **„In order (FIFO pair)"** — nu
> cere match key, și e corectă pentru acest buffer de un slot. Ambele generează.

Apare o cutie `pkt_sb` legată de ambii agenți. ✔️ *criteriul „scoreboard two-stream"*

Poți edita ulterior câmpurile din inspector (selectează scoreboard-ul → editorul
Source/Monitor/Match/Match key/Max latency).

---

## 6. Colector de coverage (pe `cmd`)

Apasă **„Coverage collector"** → alege agentul **`cmd`**. Apare un colector de
coverage legat de `cmd`. ✔️ *criteriul „un colector de coverage"*

*(Opțional)* **„Virtual sequence"** → coordonează `cmd` (agentul activ) — un
`smoke` secvențial.

---

## 7. Re-aranjează diagrama (integral grafic)

- **Trage** cutiile (DUT, Env, agenți, scoreboard) în pozițiile dorite —
  pozițiile se persistă în sidecar (`.vscode/quickuvm-architect.yaml`).
- **H**/**V** pe un bloc selectat = răsturnare orizontală/verticală a
  porturilor; **H** pe un steag de graniță = răsturnare locală.
- Butonul **⟲** re-aranjează tot (revine la layout-ul automat).
- **Delete**/clic-dreapta pe o componentă = ștergere (cu confirmare) — dacă vrei
  să corectezi ceva.

Nimic din toate astea nu atinge textul YAML direct. ✔️ *criteriul „re-aranjat
integral grafic"*

---

## 8. Generează testbench-ul

Apasă **„Generate testbench"** — butonul ▷ din bara de titlu a panoului
**Properties**, butonul din corpul panoului, sau comanda din paletă. (NU din
antetul diagramei: acolo e doar *cipul de stare* al ultimului generate.)
Extensia rulează
`quick-uvm generate` (cu fallback `python -c` dacă `quick-uvm` nu e pe PATH) și
scrie testbench-ul în `quickuvm.outputDir` (implicit `tb/`).

Fișiere-cheie așteptate:
`cmd_if.sv`, `rsp_if.sv`, `cmd_cov.svh`, `yapp_buffer_scoreboard.svh`,
`yapp_buffer_env.svh`, `yapp_buffer_virtual_sequencer.svh`, `tb_top.sv`.

---

## 9. Verifică rezultatul

- **YAML lizibil**: deschide `yapp_buffer.quickuvm.yaml` ca text — trebuie să
  arate ca mai jos, curat și editabil de mână.
- **`generate` curat**: fără erori în panoul **Problems** sau în canalul de
  ieșire **QuickUVM Architect**.

```yaml
# Configuratie QuickUVM — creata de QuickUVM Architect, editabila si manual.
# Extensia pastreaza comentariile si campurile pe care nu le cunoaste.
project:
  name: yapp_buffer

clock:
  period: 10
  unit: ns

tests:
  - { name: yapp_buffer_test }
dut:
  name: yapp_buffer
  clock: clk
  reset: rst_n
agents:
  - name: cmd
    interface: cmd_if
    sequence_item: cmd_seq_item
    ports:
      inputs:
        - { name: in_data, width: 8 }
        - { name: in_addr, width: 2 }
        - { name: in_valid }
      outputs:
        - { name: in_ready, randomize: false }
  - name: rsp
    interface: rsp_if
    sequence_item: rsp_seq_item
    ports:
      inputs:
        - { name: out_ready }
      outputs:
        - { name: out_data, width: 8, randomize: false }
        - { name: out_addr, width: 2, randomize: false }
        - { name: out_valid, randomize: false }
analysis:
  coverage: [ cmd ]
  scoreboards:
    - { name: pkt_sb, source: cmd, monitor: rsp, match: out_of_order, match_key: out_addr }
```

> Detalii care confirmă că YAML-ul e cel real (nu unul idealizat):
> - porturile de 1 bit apar fără `width` (implicitul QuickUVM e 1), deci
>   `in_valid`/`in_ready`/`out_ready`/`out_valid` nu au `width`;
> - lipsa lui `reset_active_low` **înseamnă activ-jos** (implicitul QuickUVM); se
>   scrie `reset_active_low: false` doar la un reset activ-sus;
> - porturile pe care agentul le **observă** (ieșirile DUT-ului) primesc
>   `randomize: false` — nu sunt stimul.

---

## Checklist — criteriul de închidere

- [ ] Design real deschis din ierarhie (fără YAML scris de mână).
- [ ] DUT setat din diagramă, cu ceas/reset detectate.
- [ ] **≥2 agenți** (`cmd`, `rsp`) creați din selecția de pini.
- [ ] **scoreboard two-stream** (`cmd` → `rsp`) adăugat grafic.
- [ ] **colector de coverage** (pe `cmd`) adăugat grafic.
- [ ] diagrama re-aranjată (drag/flip), pozițiile supraviețuiesc redeschiderii.
- [ ] `yapp_buffer.quickuvm.yaml` deschis ca **diagrama de verificare** (Felia 4).
- [ ] **YAML lizibil** la final.
- [ ] **`quick-uvm generate` curat**, testbench-ul produs în `tb/`.

Dacă toate sunt bifate, **MVP-ul e validat**.
