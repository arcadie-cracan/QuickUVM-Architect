"""Pytest configuration: makes svmodel importable and exposes the extracted model.

The model is built only once per session, with the working directory in
examples/, so that loc.file comes out relative — identical to examples/model.json.
"""
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

import svmodel  # noqa: E402  (after adjusting sys.path)

SOURCES = ["adder.sv", "inverter.sv", "chan.sv", "soc_top.sv"]


@pytest.fixture(scope="session")
def examples_dir():
    return ROOT / "examples"


@pytest.fixture(scope="session")
def model(examples_dir):
    """The project model extracted from the regression design examples/."""
    old = os.getcwd()
    os.chdir(examples_dir)
    try:
        return svmodel.build_model(SOURCES, top="demo_top")
    finally:
        os.chdir(old)
