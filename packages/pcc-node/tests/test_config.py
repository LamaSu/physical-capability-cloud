"""Tests for node configuration."""

import json
import os
import tempfile

import pytest

from pcc_node.config import (
    NodeConfig,
    generate_config,
    save_config,
    load_config,
)


class TestNodeConfig:
    def test_defaults(self):
        cfg = NodeConfig()
        assert cfg.pcc_base == "https://capability.network"
        assert cfg.approval_mode == "manual"
        assert cfg.poll_interval == 5
        assert cfg.camera_push_interval == 50
        assert cfg.devices == []

    def test_to_dict(self):
        cfg = NodeConfig(kernel_id="k1", kernel_name="test")
        d = cfg.to_dict()
        assert d["kernel_id"] == "k1"
        assert d["kernel_name"] == "test"
        assert isinstance(d["devices"], list)
        assert isinstance(d["pricing"], dict)

    def test_from_dict(self):
        d = {
            "kernel_id": "k2",
            "kernel_name": "my-node",
            "pcc_base": "http://localhost:3000",
            "approval_mode": "auto",
            "extra_unknown_field": True,  # should be ignored
        }
        cfg = NodeConfig.from_dict(d)
        assert cfg.kernel_id == "k2"
        assert cfg.kernel_name == "my-node"
        assert cfg.pcc_base == "http://localhost:3000"
        assert cfg.approval_mode == "auto"

    def test_roundtrip(self):
        cfg = NodeConfig(
            kernel_id="k3",
            kernel_name="roundtrip",
            devices=[{"type": "camera", "path": "/dev/video0"}],
            pricing={"base": 20, "per_minute": 0.5},
        )
        d = cfg.to_dict()
        cfg2 = NodeConfig.from_dict(d)
        assert cfg2.kernel_id == cfg.kernel_id
        assert cfg2.devices == cfg.devices
        assert cfg2.pricing == cfg.pricing


class TestGenerateConfig:
    def test_opentrons_device(self):
        devices = [{"type": "opentrons", "url": "http://localhost:31950"}]
        cfg = generate_config(devices)
        assert cfg.kernel_id.startswith("kernel-")
        assert cfg.kernel_name == "liquid-handler-node"
        assert len(cfg.devices) == 1

    def test_octoprint_device(self):
        devices = [{"type": "octoprint", "url": "http://localhost:5000"}]
        cfg = generate_config(devices)
        assert cfg.kernel_name == "3d-printer-node"

    def test_camera_only(self):
        devices = [{"type": "camera", "path": "/dev/video0"}]
        cfg = generate_config(devices)
        assert cfg.kernel_name == "camera-node"
        assert cfg.camera_device == "/dev/video0"

    def test_no_devices(self):
        cfg = generate_config([])
        assert cfg.kernel_name == "pcc-node"
        assert cfg.camera_device == ""

    def test_mixed_devices(self):
        devices = [
            {"type": "camera", "path": "/dev/video0"},
            {"type": "opentrons", "url": "http://localhost:31950"},
        ]
        cfg = generate_config(devices)
        # opentrons takes priority in naming
        assert cfg.kernel_name == "liquid-handler-node"
        assert cfg.camera_device == "/dev/video0"

    def test_unique_kernel_ids(self):
        cfg1 = generate_config([])
        cfg2 = generate_config([])
        assert cfg1.kernel_id != cfg2.kernel_id


class TestSaveLoadConfig:
    def test_save_and_load(self, tmp_path):
        path = str(tmp_path / "test-config.json")
        cfg = NodeConfig(
            kernel_id="k-save",
            kernel_name="test-save",
            devices=[{"type": "serial", "path": "/dev/ttyUSB0"}],
        )
        saved_path = save_config(cfg, path)
        assert os.path.exists(saved_path)

        loaded = load_config(path)
        assert loaded.kernel_id == "k-save"
        assert loaded.kernel_name == "test-save"
        assert len(loaded.devices) == 1

    def test_load_missing_file(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_config(str(tmp_path / "nonexistent.json"))

    def test_saved_file_is_valid_json(self, tmp_path):
        path = str(tmp_path / "json-check.json")
        cfg = NodeConfig(kernel_id="k-json")
        save_config(cfg, path)

        with open(path) as f:
            data = json.load(f)
        assert data["kernel_id"] == "k-json"
