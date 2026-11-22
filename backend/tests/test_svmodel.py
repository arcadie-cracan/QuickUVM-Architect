"""Regression tests for the svmodel extractor, on the examples/ design.

The criteria come from CLAUDE.md (the validation of phase 0): parameters
propagated through the hierarchy, symbolic widths evaluated numerically,
generate unrolled, an unpacked array of ports, an interface with modports,
concat/select connections, fan-out per net with the wire/label hint.
"""
import json
import subprocess
import sys
from pathlib import Path

import jsonschema

from conftest import ROOT, SOURCES


def inst(model, path):
    """The instance with the given hierarchical path (the stable ID)."""
    return next(i for i in model["instances"] if i["path"] == path)


def port(model, module, name):
    return next(p for p in model["modules"][module]["ports"]
                if p["name"] == name)


def pin(view, name):
    return next(p for p in view["pins"] if p["pin"] == name)


def net(view, name):
    return next(n for n in view["nets"] if n["name"] == name)


# ------------------------------------------------------------ structure

def test_version_and_top(model):
    assert model["schema_version"] == 1
    assert model["tops"] == ["demo_top"]


def test_the_hierarchy_has_8_instances_with_generate_unrolled(model):
    paths = [i["path"] for i in model["instances"]]
    assert len(paths) == 8
    # NCH=3 propagated from demo_top (not the default value 2)
    for g in range(3):
        assert f"demo_top.u_soc.g_ch[{g}].u_ch" in paths
    assert "demo_top.u_soc.g_ch[3].u_ch" not in paths


def test_effective_parameters_per_instance(model):
    assert inst(model, "demo_top.u_soc")["params"] == {"NCH": "3", "CW": "16"}
    assert inst(model, "demo_top.u_soc.g_ch[1].u_ch")["params"] == {"W": "16"}
    assert inst(model, "demo_top.bus_i")["params"] == {"AW": "6"}


# ------------------------------------------------------------ ports

def test_unpacked_array_ch_out(model):
    p = port(model, "soc_top", "ch_out")
    assert p["dir"] == "out"
    assert p["width"] == 48          # 3 elements x 16 bits
    assert p["unpacked_dims"] == [3]
    assert p["elem_width"] == 16


def test_chan_elaborated_with_W16(model):
    for name in ("din", "dout"):
        p = port(model, "chan", name)
        assert p["type"] == "logic[15:0]"
        assert p["width"] == 16
        assert p["unpacked_dims"] is None


def test_interface_port_of_the_dut(model):
    ifp, = model["modules"]["soc_top"]["iface_ports"]
    assert ifp["name"] == "bus"
    assert ifp["interface"] == "reg_bus"
    assert ifp["modport"] == "slave"


def test_interface_detail_on_the_instance(model):
    iface = inst(model, "demo_top.bus_i")["iface"]
    assert iface["modports"]["slave"] == {"addr": "in", "wdata": "in",
                                          "we": "in"}
    assert iface["modports"]["master"] == {"addr": "out", "wdata": "out",
                                           "we": "out"}
    addr = next(s for s in iface["signals"] if s["name"] == "addr")
    assert addr["width"] == 6        # AW=6 propagated onto the instance


# ------------------------------------------------------------ views

def test_fanout_and_the_render_hint(model):
    view = model["views"]["demo_top.u_soc"]
    din = net(view, "din")
    assert din["fanout"] == 9
    assert din["render"] == "label"  # above the default threshold 4
    ch_out = net(view, "ch_out")
    assert ch_out["fanout"] == 4
    assert ch_out["render"] == "wire"
    assert "<port>.ch_out" in ch_out["endpoints"]


def test_select_connection_with_elaborated_index(model):
    view = model["views"]["demo_top.u_soc"]
    conn = pin(view, "g_ch[1].u_ch.dout")["conn"]
    assert conn["kind"] == "select"
    assert conn["index"] == "1"      # the numeric index per instance
    assert conn["base"] == {"kind": "net", "net": "ch_out"}
    assert conn["text"] == "ch_out[g]"   # the source text keeps the genvar


def test_concat_connection(model):
    view = model["views"]["demo_top.u_soc"]
    conn = pin(view, "g_ch[0].u_ch.din")["conn"]
    assert conn["kind"] == "concat"
    assert conn["parts"] == [{"kind": "net", "net": "din"}] * 2


def test_const_iface_connections_and_floating_pin(model):
    view = model["views"]["demo_top"]
    assert pin(view, "u_soc.rst_n")["conn"] == {"kind": "const",
                                                "value": "1'b1"}
    assert pin(view, "u_soc.bus")["conn"] == {"kind": "iface", "ref": "bus_i"}
    assert pin(view, "u_soc.sum")["conn"] is None


# ------------------------------------------------------------ contract

def test_the_model_follows_the_json_schema(model):
    schema = json.loads(
        (ROOT / "schema" / "project-model.schema.json").read_text())
    jsonschema.Draft202012Validator(schema).validate(model)


def test_snapshot_against_model_json(model):
    """The regenerated model must match the copy in the repository."""
    snapshot = json.loads((ROOT / "examples" / "model.json").read_text())
    assert model == snapshot


def test_compile_errors_reach_stderr_and_refuse_the_model(tmp_path):
    """A compilation with errors emits no model: the diagnostics go to stderr in
    the file:line:column format (parseable by the extension), and the CLI exits
    nonzero. reportCompilation(quiet=True) would have swallowed them — a real
    regression, found on common_cells (a missing include => a degraded model, no warning)."""
    bad = tmp_path / "broken.sv"
    bad.write_text('`include "missing.svh"\n'
                   "module broken;\n  absent u_l();\nendmodule\n")
    r = subprocess.run(
        [sys.executable, str(ROOT / "backend" / "svmodel.py"), str(bad),
         "--top", "broken"],
        capture_output=True, text=True)
    assert r.returncode != 0
    assert r.stdout == ""                      # no model on stdout
    assert "broken.sv:1:10: error:" in r.stderr  # the missing include, with its location
    assert "unknown module" in r.stderr


def test_cli_writes_the_same_model(tmp_path, examples_dir):
    """The CLI (the path the extension uses) produces the same JSON."""
    out = tmp_path / "model.json"
    subprocess.run(
        [sys.executable, str(ROOT / "backend" / "svmodel.py"), *SOURCES,
         "--top", "demo_top", "-o", str(out)],
        cwd=examples_dir, check=True, capture_output=True, text=True)
    snapshot = json.loads((ROOT / "examples" / "model.json").read_text())
    assert json.loads(out.read_text()) == snapshot
