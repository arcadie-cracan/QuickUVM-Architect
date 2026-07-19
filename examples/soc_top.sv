// soc_top — top de demonstrație pentru experimentul slang:
// parametri, lățimi simbolice, generate, interfață cu modport.
interface reg_bus #(parameter int AW = 4) (input logic clk);
  logic [AW-1:0] addr;
  logic [7:0]    wdata;
  logic          we;
  modport slave  (input  addr, wdata, we);
  modport master (output addr, wdata, we);
endinterface

module soc_top #(parameter int NCH = 2, parameter int CW = 16) (
  input  logic          clk,
  input  logic          rst_n,
  input  logic  [7:0]   din,
  output logic  [7:0]   sum,
  output logic  [7:0]   inv,
  reg_bus.slave         bus,
  output logic [CW-1:0] ch_out [NCH]
);
  adder    u_add (.din(din), .dout(sum));
  inverter u_inv (.din(din), .dout(inv));
  
  for (genvar g = 0; g < NCH; g++) begin : g_ch
    chan #(.W(CW)) u_ch (.din({din, din}), .dout(ch_out[g]));
  end
endmodule

module demo_top;
  logic clk;
  logic [7:0] din;
  reg_bus #(.AW(6)) bus_i (.clk(clk));
  soc_top #(.NCH(3), .CW(16)) u_soc (
    .clk(clk), .rst_n(1'b1), .din(din),
    .sum(), .inv(), .bus(bus_i.slave), .ch_out()
  );
endmodule
