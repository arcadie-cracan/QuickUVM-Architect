"""Teste de regresie pentru extractorul svmodel, pe designul examples/.

Criteriile provin din CLAUDE.md (validarea fazei 0): parametri propagati prin
ierarhie, latimi simbolice evaluate numeric, generate desfacut, tablou
unpacked de porturi, interfata cu modporturi, conexiuni concat/select,
fan-out per net cu sugestia fir/eticheta.
"""
import json
import subprocess
import sys
from pathlib import Path

import jsonschema

from conftest import ROOT, SOURCES


def inst(model, path):
    """Instanta cu calea ierarhica data (ID stabil)."""
    return next(i for i in model["instances"] if i["path"] == path)


def port(model, module, name):
    return next(p for p in model["modules"][module]["ports"]
                if p["name"] == name)


def pin(view, name):
    return next(p for p in view["pins"] if p["pin"] == name)


def net(view, name):
    return next(n for n in view["nets"] if n["name"] == name)


# ------------------------------------------------------------ structura

def test_versiune_si_top(model):
    assert model["schema_version"] == 1
    assert model["tops"] == ["demo_top"]


def test_ierarhia_are_8_instante_cu_generate_desfacut(model):
    paths = [i["path"] for i in model["instances"]]
    assert len(paths) == 8
    # NCH=3 propagat din demo_top (nu valoarea implicita 2)
    for g in range(3):
        assert f"demo_top.u_soc.g_ch[{g}].u_ch" in paths
    assert "demo_top.u_soc.g_ch[3].u_ch" not in paths


def test_parametrii_efectivi_per_instanta(model):
    assert inst(model, "demo_top.u_soc")["params"] == {"NCH": "3", "CW": "16"}
    assert inst(model, "demo_top.u_soc.g_ch[1].u_ch")["params"] == {"W": "16"}
    assert inst(model, "demo_top.bus_i")["params"] == {"AW": "6"}


# ------------------------------------------------------------ porturi

def test_tablou_unpacked_ch_out(model):
    p = port(model, "soc_top", "ch_out")
    assert p["dir"] == "out"
    assert p["width"] == 48          # 3 elemente x 16 biti
    assert p["unpacked_dims"] == [3]
    assert p["elem_width"] == 16


def test_chan_elaborat_cu_W16(model):
    for name in ("din", "dout"):
        p = port(model, "chan", name)
        assert p["type"] == "logic[15:0]"
        assert p["width"] == 16
        assert p["unpacked_dims"] is None


def test_port_de_interfata_al_dut(model):
    ifp, = model["modules"]["soc_top"]["iface_ports"]
    assert ifp["name"] == "bus"
    assert ifp["interface"] == "reg_bus"
    assert ifp["modport"] == "slave"


def test_detaliul_interfetei_pe_instanta(model):
    iface = inst(model, "demo_top.bus_i")["iface"]
    assert iface["modports"]["slave"] == {"addr": "in", "wdata": "in",
                                          "we": "in"}
    assert iface["modports"]["master"] == {"addr": "out", "wdata": "out",
                                           "we": "out"}
    addr = next(s for s in iface["signals"] if s["name"] == "addr")
    assert addr["width"] == 6        # AW=6 propagat pe instanta


# ------------------------------------------------------------ vederi

def test_fanout_si_sugestia_de_randare(model):
    view = model["views"]["demo_top.u_soc"]
    din = net(view, "din")
    assert din["fanout"] == 9
    assert din["render"] == "label"  # peste pragul implicit 4
    ch_out = net(view, "ch_out")
    assert ch_out["fanout"] == 4
    assert ch_out["render"] == "wire"
    assert "<port>.ch_out" in ch_out["endpoints"]


def test_conexiune_select_cu_index_elaborat(model):
    view = model["views"]["demo_top.u_soc"]
    conn = pin(view, "g_ch[1].u_ch.dout")["conn"]
    assert conn["kind"] == "select"
    assert conn["index"] == "1"      # indexul numeric per instanta
    assert conn["base"] == {"kind": "net", "net": "ch_out"}
    assert conn["text"] == "ch_out[g]"   # textul sursa pastreaza genvar-ul


def test_conexiune_concat(model):
    view = model["views"]["demo_top.u_soc"]
    conn = pin(view, "g_ch[0].u_ch.din")["conn"]
    assert conn["kind"] == "concat"
    assert conn["parts"] == [{"kind": "net", "net": "din"}] * 2


def test_conexiuni_const_iface_si_pin_flotant(model):
    view = model["views"]["demo_top"]
    assert pin(view, "u_soc.rst_n")["conn"] == {"kind": "const",
                                                "value": "1'b1"}
    assert pin(view, "u_soc.bus")["conn"] == {"kind": "iface", "ref": "bus_i"}
    assert pin(view, "u_soc.sum")["conn"] is None


# ------------------------------------------------------------ contract

def test_modelul_respecta_schema_json(model):
    schema = json.loads(
        (ROOT / "schema" / "project-model.schema.json").read_text())
    jsonschema.Draft202012Validator(schema).validate(model)


def test_snapshot_contra_model_json(model):
    """Modelul regenerat trebuie sa coincida cu exemplarul din depozit."""
    snapshot = json.loads((ROOT / "examples" / "model.json").read_text())
    assert model == snapshot


def test_erorile_de_compilare_ajung_pe_stderr_si_refuza_modelul(tmp_path):
    """O compilare cu erori nu emite model: diagnosticele merg pe stderr in
    format fisier:linie:coloana (parsabil de extensie), iar CLI iese nenul.
    reportCompilation(quiet=True) le-ar fi inghitit — regresie reala, gasita
    pe common_cells (include lipsa => model degradat fara avertizare)."""
    bad = tmp_path / "rupt.sv"
    bad.write_text('`include "nu_exista.svh"\n'
                   "module rupt;\n  lipsa u_l();\nendmodule\n")
    r = subprocess.run(
        [sys.executable, str(ROOT / "backend" / "svmodel.py"), str(bad),
         "--top", "rupt"],
        capture_output=True, text=True)
    assert r.returncode != 0
    assert r.stdout == ""                      # niciun model pe stdout
    assert "rupt.sv:1:10: error:" in r.stderr  # include-ul lipsa, cu locatie
    assert "unknown module" in r.stderr


def test_cli_scrie_acelasi_model(tmp_path, examples_dir):
    """CLI-ul (calea folosita de extensie) produce acelasi JSON."""
    out = tmp_path / "model.json"
    subprocess.run(
        [sys.executable, str(ROOT / "backend" / "svmodel.py"), *SOURCES,
         "--top", "demo_top", "-o", str(out)],
        cwd=examples_dir, check=True, capture_output=True, text=True)
    snapshot = json.loads((ROOT / "examples" / "model.json").read_text())
    assert json.loads(out.read_text()) == snapshot
