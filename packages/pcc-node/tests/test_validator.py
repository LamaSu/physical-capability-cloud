"""Tests for the job-parameter validator."""

import pytest

from pcc_node.validator import validate_job


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _caps(*types):
    """Build a kernel_capabilities list from type strings."""
    return [{"type": t} for t in types]


# ---------------------------------------------------------------------------
# FDM validation
# ---------------------------------------------------------------------------


class TestFdmValidation:
    def test_valid_fdm_job(self):
        imported = {
            "capabilityType": "fdm",
            "parameters": {
                "nozzleTemp": 210,
                "bedTemp": 60,
                "material": "PLA",
            },
        }
        result = validate_job(imported, None, _caps("fdm"))
        assert result["valid"] is True
        assert result["errors"] == []

    def test_high_nozzle_temp_warning(self):
        imported = {
            "capabilityType": "fdm",
            "parameters": {"nozzleTemp": 310},
        }
        result = validate_job(imported, None, _caps("fdm"))
        assert result["valid"] is True
        assert any("310" in w for w in result["warnings"])

    def test_abs_enclosure_warning(self):
        imported = {
            "capabilityType": "fdm",
            "parameters": {"material": "ABS"},
        }
        result = validate_job(imported, None, _caps("fdm"))
        assert result["valid"] is True
        assert any("enclosure" in w.lower() for w in result["warnings"])

    def test_high_bed_temp_warning(self):
        imported = {
            "capabilityType": "fdm",
            "parameters": {"bedTemp": 130},
        }
        result = validate_job(imported, None, _caps("fdm"))
        assert any("130" in w for w in result["warnings"])

    def test_stl_needs_slicing_warning(self):
        imported = {
            "capabilityType": "fdm",
            "parameters": {},
            "needsSlicing": True,
        }
        result = validate_job(imported, None, _caps("fdm"))
        assert result["valid"] is True
        assert any("slicing" in w.lower() for w in result["warnings"])


# ---------------------------------------------------------------------------
# Capability-type mismatch
# ---------------------------------------------------------------------------


class TestCapabilityMismatch:
    def test_wrong_type_for_machine(self):
        imported = {
            "capabilityType": "fdm",
            "parameters": {},
        }
        result = validate_job(imported, None, _caps("liquid-handler"))
        assert result["valid"] is False
        assert any("doesn't support fdm" in e.lower() for e in result["errors"])

    def test_multiple_capabilities_one_matches(self):
        imported = {
            "capabilityType": "fdm",
            "parameters": {},
        }
        result = validate_job(imported, None, _caps("liquid-handler", "fdm"))
        assert result["valid"] is True


# ---------------------------------------------------------------------------
# Liquid-handler validation
# ---------------------------------------------------------------------------


class TestLiquidHandlerValidation:
    def test_valid_liquid_handler(self):
        imported = {
            "capabilityType": "liquid-handler",
            "parameters": {
                "wells": [{"well": "A1", "volume": 50}],
                "apiLevel": "2.13",
            },
        }
        result = validate_job(imported, None, _caps("liquid-handler"))
        assert result["valid"] is True

    def test_excess_wells_error(self):
        imported = {
            "capabilityType": "liquid-handler",
            "parameters": {
                "wells": [{"well": f"W{i}", "volume": 10} for i in range(400)],
            },
        }
        result = validate_job(imported, None, _caps("liquid-handler"))
        assert result["valid"] is False
        assert any("384" in e for e in result["errors"])

    def test_negative_volume_error(self):
        imported = {
            "capabilityType": "liquid-handler",
            "parameters": {
                "wells": [{"well": "A1", "volume": -10}],
            },
        }
        result = validate_job(imported, None, _caps("liquid-handler"))
        assert result["valid"] is False
        assert any("negative" in e.lower() for e in result["errors"])

    def test_high_volume_warning(self):
        imported = {
            "capabilityType": "liquid-handler",
            "parameters": {
                "wells": [{"well": "A1", "volume": 1500}],
            },
        }
        result = validate_job(imported, None, _caps("liquid-handler"))
        assert result["valid"] is True
        assert any("1500" in w for w in result["warnings"])

    def test_old_api_level_warning(self):
        imported = {
            "capabilityType": "liquid-handler",
            "parameters": {
                "wells": [],
                "apiLevel": "1.0",
            },
        }
        result = validate_job(imported, None, _caps("liquid-handler"))
        assert any("old" in w.lower() for w in result["warnings"])


# ---------------------------------------------------------------------------
# CNC validation
# ---------------------------------------------------------------------------


class TestCncValidation:
    def test_valid_cnc_job(self):
        imported = {
            "capabilityType": "cnc-3axis",
            "parameters": {},
        }
        result = validate_job(imported, None, _caps("cnc-3axis"))
        assert result["valid"] is True

    def test_stl_needs_cam_error(self):
        imported = {
            "capabilityType": "cnc-3axis",
            "parameters": {},
            "needsSlicing": True,
        }
        result = validate_job(imported, None, _caps("cnc-3axis"))
        assert result["valid"] is False
        assert any("cam" in e.lower() for e in result["errors"])


# ---------------------------------------------------------------------------
# Device-manifest validation
# ---------------------------------------------------------------------------


class TestManifestValidation:
    def test_nozzle_exceeds_manifest_max(self):
        imported = {
            "capabilityType": "fdm",
            "parameters": {"nozzleTemp": 280},
        }
        manifest = {"maxNozzleTemp": 260}
        result = validate_job(imported, manifest, _caps("fdm"))
        assert result["valid"] is False
        assert any("exceeds" in e.lower() for e in result["errors"])

    def test_bed_exceeds_manifest_max(self):
        imported = {
            "capabilityType": "fdm",
            "parameters": {"bedTemp": 110},
        }
        manifest = {"maxBedTemp": 100}
        result = validate_job(imported, manifest, _caps("fdm"))
        assert result["valid"] is False
        assert any("exceeds" in e.lower() for e in result["errors"])

    def test_within_manifest_limits(self):
        imported = {
            "capabilityType": "fdm",
            "parameters": {"nozzleTemp": 200, "bedTemp": 60},
        }
        manifest = {"maxNozzleTemp": 260, "maxBedTemp": 100}
        result = validate_job(imported, manifest, _caps("fdm"))
        assert result["valid"] is True
