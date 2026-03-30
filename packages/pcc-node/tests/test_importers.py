"""Tests for the importer registry and all built-in importers."""

import os
from pathlib import Path

import pytest

from pcc_node.importers import (
    IMPORTERS,
    detect_and_import,
    list_supported,
    register,
)
from pcc_node.importers.gcode import import_gcode
from pcc_node.importers.opentrons_protocol import import_opentrons_protocol
from pcc_node.importers.stl import import_stl
from pcc_node.importers.csv_plate import import_plate_csv

FIXTURES = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# Registry tests
# ---------------------------------------------------------------------------


class TestRegistry:
    def test_list_supported_includes_gcode(self):
        supported = list_supported()
        assert ".gcode" in supported

    def test_list_supported_includes_stl(self):
        assert ".stl" in list_supported()

    def test_list_supported_includes_csv(self):
        assert ".csv" in list_supported()

    def test_list_supported_includes_py(self):
        assert ".py" in list_supported()

    def test_list_supported_includes_gco_aliases(self):
        supported = list_supported()
        assert ".gco" in supported
        assert ".nc" in supported
        assert ".ngc" in supported

    def test_detect_and_import_gcode(self):
        result = detect_and_import(str(FIXTURES / "test.gcode"))
        assert result["capabilityType"] == "fdm"

    def test_detect_and_import_stl(self):
        result = detect_and_import(str(FIXTURES / "test.stl"))
        assert result["capabilityType"] == "fdm"
        assert result["needsSlicing"] is True

    def test_detect_and_import_csv(self):
        result = detect_and_import(str(FIXTURES / "test_plate.csv"))
        assert result["capabilityType"] == "liquid-handler"

    def test_detect_and_import_unknown_extension(self):
        with pytest.raises(ValueError, match="No importer for .xyz"):
            detect_and_import("somefile.xyz")

    def test_register_custom_importer(self):
        def dummy_importer(filepath):
            return {"capabilityType": "custom", "parameters": {}, "rawFile": filepath}

        register(".zzz", dummy_importer)
        try:
            result = detect_and_import("fake.zzz")
            assert result["capabilityType"] == "custom"
        finally:
            # Clean up
            IMPORTERS.pop(".zzz", None)


# ---------------------------------------------------------------------------
# G-code importer
# ---------------------------------------------------------------------------


class TestGcodeImporter:
    def test_parse_fdm_file(self):
        result = import_gcode(str(FIXTURES / "test.gcode"))
        assert result["capabilityType"] == "fdm"

    def test_filename(self):
        result = import_gcode(str(FIXTURES / "test.gcode"))
        assert result["parameters"]["filename"] == "test.gcode"

    def test_nozzle_temp(self):
        result = import_gcode(str(FIXTURES / "test.gcode"))
        assert result["parameters"]["nozzleTemp"] == 210.0

    def test_bed_temp(self):
        result = import_gcode(str(FIXTURES / "test.gcode"))
        assert result["parameters"]["bedTemp"] == 60.0

    def test_layer_height(self):
        result = import_gcode(str(FIXTURES / "test.gcode"))
        assert result["parameters"]["layerHeight"] == 0.2

    def test_estimated_time(self):
        result = import_gcode(str(FIXTURES / "test.gcode"))
        assert result["parameters"]["estimatedTime"] == "1h 23m 45s"

    def test_material(self):
        result = import_gcode(str(FIXTURES / "test.gcode"))
        assert result["parameters"]["material"] == "PLA"

    def test_filament_used(self):
        result = import_gcode(str(FIXTURES / "test.gcode"))
        assert result["parameters"]["filamentUsed"] == "4523.7"

    def test_line_count(self):
        result = import_gcode(str(FIXTURES / "test.gcode"))
        assert result["parameters"]["lineCount"] > 0

    def test_raw_file_path(self):
        path = str(FIXTURES / "test.gcode")
        result = import_gcode(path)
        assert result["rawFile"] == path

    def test_detect_cnc(self):
        result = import_gcode(str(FIXTURES / "test_cnc.gcode"))
        assert result["capabilityType"] == "cnc-3axis"

    def test_cnc_no_extrusion(self):
        result = import_gcode(str(FIXTURES / "test_cnc.gcode"))
        params = result["parameters"]
        # CNC file has no nozzle/bed temps from M104/M109/M140/M190
        assert params["nozzleTemp"] is None
        assert params["bedTemp"] is None

    def test_gcode_from_string(self, tmp_path):
        """G-code with only movement, no extrusion -> CNC."""
        gcode = "G0 X10 Y10\nG1 X20 Y20 Z-1\nG0 Z5\n"
        p = tmp_path / "test.gcode"
        p.write_text(gcode)
        result = import_gcode(str(p))
        assert result["capabilityType"] == "cnc-3axis"

    def test_gcode_with_extrusion_is_fdm(self, tmp_path):
        gcode = "G1 X10 Y10 E1.0\n"
        p = tmp_path / "test.gcode"
        p.write_text(gcode)
        result = import_gcode(str(p))
        assert result["capabilityType"] == "fdm"


# ---------------------------------------------------------------------------
# Opentrons protocol importer
# ---------------------------------------------------------------------------


class TestOpentrons:
    def test_capability_type(self):
        result = import_opentrons_protocol(str(FIXTURES / "test_protocol.py"))
        assert result["capabilityType"] == "liquid-handler"

    def test_protocol_name(self):
        result = import_opentrons_protocol(str(FIXTURES / "test_protocol.py"))
        assert result["parameters"]["protocolName"] == "Simple Dilution"

    def test_api_level(self):
        result = import_opentrons_protocol(str(FIXTURES / "test_protocol.py"))
        assert result["parameters"]["apiLevel"] == "2.13"

    def test_pipettes(self):
        result = import_opentrons_protocol(str(FIXTURES / "test_protocol.py"))
        pipettes = result["parameters"]["pipettes"]
        assert len(pipettes) == 2
        names = [p["name"] for p in pipettes]
        assert "p300_single_gen2" in names
        assert "p20_single_gen2" in names

    def test_pipette_mounts(self):
        result = import_opentrons_protocol(str(FIXTURES / "test_protocol.py"))
        pipettes = result["parameters"]["pipettes"]
        mounts = {p["name"]: p["mount"] for p in pipettes}
        assert mounts["p300_single_gen2"] == "left"
        assert mounts["p20_single_gen2"] == "right"

    def test_labware(self):
        result = import_opentrons_protocol(str(FIXTURES / "test_protocol.py"))
        labware = result["parameters"]["labware"]
        assert "corning_96_wellplate_360ul_flat" in labware
        assert "opentrons_96_tiprack_300ul" in labware
        assert "nest_12_reservoir_15ml" in labware

    def test_modules(self):
        result = import_opentrons_protocol(str(FIXTURES / "test_protocol.py"))
        modules = result["parameters"]["modules"]
        assert "temperature module gen2" in modules

    def test_protocol_content_present(self):
        result = import_opentrons_protocol(str(FIXTURES / "test_protocol.py"))
        assert "def run(protocol)" in result["parameters"]["protocolContent"]

    def test_empty_protocol(self, tmp_path):
        p = tmp_path / "empty.py"
        p.write_text("# just a comment\n")
        result = import_opentrons_protocol(str(p))
        assert result["parameters"]["apiLevel"] is None
        assert result["parameters"]["pipettes"] == []

    def test_syntax_error_protocol(self, tmp_path):
        p = tmp_path / "bad.py"
        p.write_text("metadata = { this is not valid python }\n")
        result = import_opentrons_protocol(str(p))
        # Should not crash -- just returns None for metadata fields
        assert result["capabilityType"] == "liquid-handler"


# ---------------------------------------------------------------------------
# STL importer
# ---------------------------------------------------------------------------


class TestStl:
    def test_binary_stl(self):
        result = import_stl(str(FIXTURES / "test.stl"))
        assert result["parameters"]["format"] == "binary"

    def test_triangle_count(self):
        result = import_stl(str(FIXTURES / "test.stl"))
        assert result["parameters"]["triangleCount"] == 2

    def test_file_size(self):
        result = import_stl(str(FIXTURES / "test.stl"))
        assert result["parameters"]["fileSizeBytes"] == 184

    def test_needs_slicing(self):
        result = import_stl(str(FIXTURES / "test.stl"))
        assert result["needsSlicing"] is True

    def test_capability_type(self):
        result = import_stl(str(FIXTURES / "test.stl"))
        assert result["capabilityType"] == "fdm"

    def test_ascii_stl(self):
        result = import_stl(str(FIXTURES / "test_ascii.stl"))
        assert result["parameters"]["format"] == "ascii"

    def test_filename(self):
        result = import_stl(str(FIXTURES / "test.stl"))
        assert result["parameters"]["filename"] == "test.stl"


# ---------------------------------------------------------------------------
# CSV plate importer
# ---------------------------------------------------------------------------


class TestCsvPlate:
    def test_capability_type(self):
        result = import_plate_csv(str(FIXTURES / "test_plate.csv"))
        assert result["capabilityType"] == "liquid-handler"

    def test_well_count(self):
        result = import_plate_csv(str(FIXTURES / "test_plate.csv"))
        assert result["parameters"]["wellCount"] == 8

    def test_plate_format(self):
        result = import_plate_csv(str(FIXTURES / "test_plate.csv"))
        assert result["parameters"]["plateFormat"] == "96-well"

    def test_well_volumes(self):
        result = import_plate_csv(str(FIXTURES / "test_plate.csv"))
        wells = result["parameters"]["wells"]
        a1 = next(w for w in wells if w["well"] == "A1")
        assert a1["volume"] == 50.0

    def test_sample_names(self):
        result = import_plate_csv(str(FIXTURES / "test_plate.csv"))
        wells = result["parameters"]["wells"]
        samples = [w["sample"] for w in wells]
        assert "Sample_Alpha" in samples
        assert "Control_Blank" in samples

    def test_concentrations(self):
        result = import_plate_csv(str(FIXTURES / "test_plate.csv"))
        wells = result["parameters"]["wells"]
        a1 = next(w for w in wells if w["well"] == "A1")
        assert a1["concentration"] == 1.0
        b2 = next(w for w in wells if w["well"] == "B2")
        assert b2["concentration"] == 0.0

    def test_384_well_format(self, tmp_path):
        """More than 96 wells should report 384-well format."""
        p = tmp_path / "big.csv"
        lines = ["Well,Volume,Sample,Concentration"]
        for i in range(100):
            lines.append(f"W{i},{i * 10},Sample{i},{i * 0.1}")
        p.write_text("\n".join(lines))
        result = import_plate_csv(str(p))
        assert result["parameters"]["plateFormat"] == "384-well"

    def test_empty_csv(self, tmp_path):
        p = tmp_path / "empty.csv"
        p.write_text("Well,Volume,Sample,Concentration\n")
        result = import_plate_csv(str(p))
        assert result["parameters"]["wellCount"] == 0
