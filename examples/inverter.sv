//----------------------------------------------------------------------
// inverter — a trivial combinational block DUT: dout = ~din.
//----------------------------------------------------------------------
module inverter (
  output logic [7:0] dout,
  input        [7:0] din
  );

  assign dout = ~din;

endmodule
