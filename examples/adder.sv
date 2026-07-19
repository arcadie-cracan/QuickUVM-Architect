//----------------------------------------------------------------------
// adder — a trivial combinational block DUT: dout = din + 1.
//----------------------------------------------------------------------
module adder (
  output logic [7:0] dout,
  input        [7:0] din
  );

  assign dout = din + 1'b1;

endmodule
