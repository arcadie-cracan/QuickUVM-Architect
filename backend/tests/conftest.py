"""Configurare pytest: face importabil svmodel si expune modelul extras.

Modelul se construieste o singura data per sesiune, cu directorul de lucru
in examples/, ca loc.file sa iasa relative — identic cu examples/model.json.
"""
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

import svmodel  # noqa: E402  (dupa ajustarea sys.path)

SOURCES = ["adder.sv", "inverter.sv", "chan.sv", "soc_top.sv"]


@pytest.fixture(scope="session")
def examples_dir():
    return ROOT / "examples"


@pytest.fixture(scope="session")
def model(examples_dir):
    """Modelul de proiect extras din designul de regresie examples/."""
    old = os.getcwd()
    os.chdir(examples_dir)
    try:
        return svmodel.build_model(SOURCES, top="demo_top")
    finally:
        os.chdir(old)
