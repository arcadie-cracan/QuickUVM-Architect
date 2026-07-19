// deep_pipe.sv — un pipeline cu MULTE module intr-un SINGUR fisier, gandit
// pentru a proba cross-probing-ul la hover (Faza 4): in schema lui
// `deep_pipe`, fiecare instanta e un modul DIFERIT, iar declaratiile lor de
// porturi stau la linii foarte departate in fisier. Cand stationezi pe un pin
// al unei instante, sursa deruleaza vizibil pana la definitia acelui modul —
// cu cat instanta e mai jos in lant, cu atat saltul e mai mare.
//
// Deschide simbolul/schema lui `deep_pipe`, tine editorul acesta split langa
// diagrama, si plimba-te cu hover-ul peste pinii u_a … u_h.

`timescale 1ns / 1ps

// =====================================================================
// Etajul A — captura de intrare (registru simplu)
// =====================================================================
module stage_a #(
    parameter int W = 16
) (
    input  logic         clk,
    input  logic         rst_ni,
    input  logic [W-1:0] d_in,
    input  logic         v_in,
    output logic [W-1:0] d_out,
    output logic         v_out
);
  always_ff @(posedge clk or negedge rst_ni) begin
    if (!rst_ni) begin
      d_out <= '0;
      v_out <= 1'b0;
    end else begin
      d_out <= d_in;
      v_out <= v_in;
    end
  end
endmodule

// =====================================================================
// Etajul B — incrementare
// =====================================================================
module stage_b #(
    parameter int W = 16
) (
    input  logic         clk,
    input  logic         rst_ni,
    input  logic [W-1:0] d_in,
    input  logic         v_in,
    output logic [W-1:0] d_out,
    output logic         v_out
);
  always_ff @(posedge clk or negedge rst_ni) begin
    if (!rst_ni) begin
      d_out <= '0;
      v_out <= 1'b0;
    end else begin
      d_out <= d_in + 16'd1;
      v_out <= v_in;
    end
  end
endmodule

// =====================================================================
// Etajul C — deplasare la stanga cu 1
// =====================================================================
module stage_c #(
    parameter int W = 16
) (
    input  logic         clk,
    input  logic         rst_ni,
    input  logic [W-1:0] d_in,
    input  logic         v_in,
    output logic [W-1:0] d_out,
    output logic         v_out
);
  always_ff @(posedge clk or negedge rst_ni) begin
    if (!rst_ni) begin
      d_out <= '0;
      v_out <= 1'b0;
    end else begin
      d_out <= {d_in[W-2:0], 1'b0};
      v_out <= v_in;
    end
  end
endmodule

// =====================================================================
// Etajul D — XOR cu o masca constanta
// =====================================================================
module stage_d #(
    parameter int W = 16
) (
    input  logic         clk,
    input  logic         rst_ni,
    input  logic [W-1:0] d_in,
    input  logic         v_in,
    output logic [W-1:0] d_out,
    output logic         v_out
);
  always_ff @(posedge clk or negedge rst_ni) begin
    if (!rst_ni) begin
      d_out <= '0;
      v_out <= 1'b0;
    end else begin
      d_out <= d_in ^ 16'hA5A5;
      v_out <= v_in;
    end
  end
endmodule

// =====================================================================
// Etajul E — saturare la jumatate de scala
// =====================================================================
module stage_e #(
    parameter int W = 16
) (
    input  logic         clk,
    input  logic         rst_ni,
    input  logic [W-1:0] d_in,
    input  logic         v_in,
    output logic [W-1:0] d_out,
    output logic         v_out
);
  always_ff @(posedge clk or negedge rst_ni) begin
    if (!rst_ni) begin
      d_out <= '0;
      v_out <= 1'b0;
    end else begin
      d_out <= (d_in > 16'h7FFF) ? 16'h7FFF : d_in;
      v_out <= v_in;
    end
  end
endmodule

// =====================================================================
// Etajul F — inversare pe biti
// =====================================================================
module stage_f #(
    parameter int W = 16
) (
    input  logic         clk,
    input  logic         rst_ni,
    input  logic [W-1:0] d_in,
    input  logic         v_in,
    output logic [W-1:0] d_out,
    output logic         v_out
);
  always_ff @(posedge clk or negedge rst_ni) begin
    if (!rst_ni) begin
      d_out <= '0;
      v_out <= 1'b0;
    end else begin
      for (int i = 0; i < W; i++) d_out[i] <= d_in[W-1-i];
      v_out <= v_in;
    end
  end
endmodule

// =====================================================================
// Etajul G — acumulare (stare interna)
// =====================================================================
module stage_g #(
    parameter int W = 16
) (
    input  logic         clk,
    input  logic         rst_ni,
    input  logic [W-1:0] d_in,
    input  logic         v_in,
    output logic [W-1:0] d_out,
    output logic         v_out
);
  logic [W-1:0] acc;
  always_ff @(posedge clk or negedge rst_ni) begin
    if (!rst_ni) begin
      acc   <= '0;
      d_out <= '0;
      v_out <= 1'b0;
    end else begin
      if (v_in) acc <= acc + d_in;
      d_out <= acc;
      v_out <= v_in;
    end
  end
endmodule

// =====================================================================
// Etajul H — captura de iesire
// =====================================================================
module stage_h #(
    parameter int W = 16
) (
    input  logic         clk,
    input  logic         rst_ni,
    input  logic [W-1:0] d_in,
    input  logic         v_in,
    output logic [W-1:0] d_out,
    output logic         v_out
);
  always_ff @(posedge clk or negedge rst_ni) begin
    if (!rst_ni) begin
      d_out <= '0;
      v_out <= 1'b0;
    end else begin
      d_out <= d_in;
      v_out <= v_in;
    end
  end
endmodule

// =====================================================================
// Top — inlantuie cele opt etaje (A -> B -> ... -> H)
// =====================================================================
module deep_pipe #(
    parameter int W = 16
) (
    input  logic         clk,
    input  logic         rst_ni,
    input  logic [W-1:0] din,
    input  logic         din_valid,
    output logic [W-1:0] dout,
    output logic         dout_valid
);
  logic [W-1:0] da, db, dc, dd, de, df, dg;
  logic         va, vb, vc, vd, ve, vf, vg;

  stage_a #(.W(W)) u_a (.clk, .rst_ni, .d_in(din), .v_in(din_valid), .d_out(da), .v_out(va));
  stage_b #(.W(W)) u_b (.clk, .rst_ni, .d_in(da),  .v_in(va),        .d_out(db), .v_out(vb));
  stage_c #(.W(W)) u_c (.clk, .rst_ni, .d_in(db),  .v_in(vb),        .d_out(dc), .v_out(vc));
  stage_d #(.W(W)) u_d (.clk, .rst_ni, .d_in(dc),  .v_in(vc),        .d_out(dd), .v_out(vd));
  stage_e #(.W(W)) u_e (.clk, .rst_ni, .d_in(dd),  .v_in(vd),        .d_out(de), .v_out(ve));
  stage_f #(.W(W)) u_f (.clk, .rst_ni, .d_in(de),  .v_in(ve),        .d_out(df), .v_out(vf));
  stage_g #(.W(W)) u_g (.clk, .rst_ni, .d_in(df),  .v_in(vf),        .d_out(dg), .v_out(vg));
  stage_h #(.W(W)) u_h (.clk, .rst_ni, .d_in(dg),  .v_in(vg),        .d_out(dout), .v_out(dout_valid));
endmodule
