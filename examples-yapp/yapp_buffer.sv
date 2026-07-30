// yapp_buffer — un buffer de pachete de un slot, fixtura tutorialului de validare
// a QuickUVM Architect (docs/tutorial-yapp-buffer.md).
//
// NU e routerul YAPP: acela e un demux 1->3 si traieste in QuickUVM
// (examples/yapp/rtl/yapp_router.sv, cu out0_*/out1_*/out2_*), verificat de
// walkthrough-ul vizual docs/yapp-router-walkthrough.html. Fixtura de aici e o
// reducere DELIBERATA a lui, pastrata separat fiindca are nevoie de altceva:
//
//   - un FLUX DE COMANDA (intrare): un pachet {payload, adresa-canal} intra
//     printr-un handshake valid/ready;
//   - un FLUX DE RASPUNS (iesire): pachetul iese prin acelasi protocol.
//
// Granita clara intrare/iesire da exact cei DOI agenti de care are nevoie
// criteriul de inchidere al MVP-ului (>=2 agenti + scoreboard two-stream +
// coverage) — un demux cu un singur canal de intrare da un singur agent.
//
//   - un agent de COMANDA care conduce fluxul de intrare;
//   - un agent de RASPUNS care esantioneaza fluxul de iesire.
//
// (Se numea `yapp_router` si el, ceea ce facea ca pasii tutorialului si
// capturile walkthrough-ului sa descrie doua designuri diferite cu acelasi
// nume — de aici redenumirea.)

module yapp_buffer #(
    parameter int DW = 8,  // latimea payload-ului
    parameter int AW = 2   // latimea adresei (canalul destinatie, 0..3)
) (
    input  logic          clk,
    input  logic          rst_n,
    // fluxul de COMANDA (intrare): pachetul de injectat
    input  logic [DW-1:0] in_data,
    input  logic [AW-1:0] in_addr,
    input  logic          in_valid,
    output logic          in_ready,
    // fluxul de RASPUNS (iesire): pachetul preluat
    output logic [DW-1:0] out_data,
    output logic [AW-1:0] out_addr,
    output logic          out_valid,
    input  logic          out_ready
);

  logic [DW-1:0] data_q;
  logic [AW-1:0] addr_q;
  logic          full_q;

  // handshake: gata de primit cand slotul e liber; iesire valida cand e plin
  assign in_ready  = !full_q;
  assign out_data  = data_q;
  assign out_addr  = addr_q;
  assign out_valid = full_q;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      full_q <= 1'b0;
      data_q <= '0;
      addr_q <= '0;
    end else if (in_valid && in_ready) begin
      // accepta un pachet nou de la fluxul de comanda
      data_q <= in_data;
      addr_q <= in_addr;
      full_q <= 1'b1;
    end else if (out_valid && out_ready) begin
      // pachetul a fost preluat de fluxul de raspuns: slotul se elibereaza
      full_q <= 1'b0;
    end
  end

endmodule
