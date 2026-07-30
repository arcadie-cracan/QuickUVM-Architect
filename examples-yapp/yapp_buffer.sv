// yapp_buffer — a one-slot packet buffer; the fixture for the QuickUVM Architect
// validation tutorial (docs/tutorial-yapp-buffer.md).
//
// This is NOT the YAPP router. That one is a 1->3 demux and lives in QuickUVM, at
// examples/yapp/rtl/yapp_router.sv (out0_*/out1_*/out2_*); it is the subject of the
// visual walkthrough docs/yapp-router-walkthrough.html. This fixture is a DELIBERATE
// reduction of it, kept separate because it needs something the router cannot give:
//
//   - a COMMAND stream (input): a packet {payload, channel address} arrives through
//     a valid/ready handshake;
//   - a RESPONSE stream (output): the packet leaves through the same protocol.
//
// The clean input/output boundary yields exactly the TWO agents the MVP closure
// criterion needs (>=2 agents + a two-stream scoreboard + coverage):
//
//   - a COMMAND agent driving the input stream;
//   - a RESPONSE agent sampling the output stream.
//
// A demux, having a single input channel, yields only one agent — which is why both
// designs exist. (Until Jul 2026 this fixture was also called `yapp_router`, so the
// tutorial steps and the walkthrough captures described two different designs under
// one name; hence the rename.)

module yapp_buffer #(
    parameter int DW = 8,  // payload width
    parameter int AW = 2   // address width (destination channel, 0..3)
) (
    input  logic          clk,
    input  logic          rst_n,
    // COMMAND stream (input): the packet to inject
    input  logic [DW-1:0] in_data,
    input  logic [AW-1:0] in_addr,
    input  logic          in_valid,
    output logic          in_ready,
    // RESPONSE stream (output): the packet taken away
    output logic [DW-1:0] out_data,
    output logic [AW-1:0] out_addr,
    output logic          out_valid,
    input  logic          out_ready
);

  logic [DW-1:0] data_q;
  logic [AW-1:0] addr_q;
  logic          full_q;

  // handshake: ready to accept while the slot is free; output valid while it is full
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
      // accept a new packet from the command stream
      data_q <= in_data;
      addr_q <= in_addr;
      full_q <= 1'b1;
    end else if (out_valid && out_ready) begin
      // the response stream took the packet: the slot is free again
      full_q <= 1'b0;
    end
  end

endmodule
