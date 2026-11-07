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


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes")
class TestConfigHoldsTheApiKey:
    """The config carries pcc_api_key, so it must never be readable by other users."""

    def _key(self):
        return "pcc_" + "live_" + "0" * 64  # built at runtime: no literal key in the source

    def test_a_new_config_is_owner_only_whatever_the_umask(self, tmp_path):
        old = os.umask(0o022)
        try:
            path = save_config(NodeConfig(kernel_id="k", pcc_api_key=self._key()), str(tmp_path / "pcc-node.json"))
        finally:
            os.umask(old)
        assert os.stat(path).st_mode & 0o777 == 0o600

    def test_saving_over_a_readable_config_makes_it_owner_only(self, tmp_path):
        path = tmp_path / "pcc-node.json"
        path.write_text("{}")
        os.chmod(path, 0o644)
        save_config(NodeConfig(kernel_id="k", pcc_api_key=self._key()), str(path))
        assert os.stat(path).st_mode & 0o777 == 0o600
        assert load_config(str(path)).pcc_api_key == self._key()

    def test_a_symlinked_config_path_is_replaced_not_written_through(self, tmp_path):
        target = tmp_path / "elsewhere.json"
        target.write_text("untouched")
        link = tmp_path / "pcc-node.json"
        link.symlink_to(target)
        save_config(NodeConfig(kernel_id="k", pcc_api_key=self._key()), str(link))
        assert target.read_text() == "untouched"
        assert not link.is_symlink()
        assert os.stat(link).st_mode & 0o777 == 0o600

    def test_a_failed_save_leaves_no_temporary_file(self, tmp_path, monkeypatch):
        def boom(*args, **kwargs):
            raise OSError("disk full")
        monkeypatch.setattr(json, "dump", boom)
        with pytest.raises(OSError):
            save_config(NodeConfig(kernel_id="k"), str(tmp_path / "pcc-node.json"))
        assert list(tmp_path.iterdir()) == []

    # Verdict 105b, finding 7: a readable config that holds a key was loaded with only a
    # warning, and stayed readable. Now it is restricted to its owner before use.
    def test_a_readable_config_that_holds_a_key_is_restricted_to_its_owner(self, tmp_path, caplog):
        path = tmp_path / "pcc-node.json"
        path.write_text(json.dumps({"kernel_id": "k", "pcc_api_key": self._key()}))
        os.chmod(path, 0o644)
        with caplog.at_level("WARNING"):
            assert load_config(str(path)).pcc_api_key == self._key()
        assert os.stat(path).st_mode & 0o777 == 0o600
        assert "rotate" in caplog.text
        assert self._key() not in caplog.text

    def test_a_device_api_key_counts_as_a_key(self, tmp_path, caplog):
        path = tmp_path / "pcc-node.json"
        path.write_text(json.dumps({"kernel_id": "k", "devices": [{"type": "octoprint", "api_key": "octo-" + "secret"}]}))
        os.chmod(path, 0o640)
        with caplog.at_level("WARNING"):
            load_config(str(path))
        assert os.stat(path).st_mode & 0o777 == 0o600

    def test_a_symlinked_config_is_refused(self, tmp_path):
        from pcc_node import config as config_module
        target = tmp_path / "elsewhere.json"
        target.write_text(json.dumps({"kernel_id": "k", "pcc_api_key": self._key()}))
        os.chmod(target, 0o600)
        link = tmp_path / "pcc-node.json"
        link.symlink_to(target)
        refused = getattr(config_module, "ConfigFileError", None)
        assert refused is not None, "a symlinked config was loaded"
        with pytest.raises(refused, match="symbolic link"):
            load_config(str(link))

    def test_a_config_with_a_key_owned_by_another_account_is_refused(self, tmp_path, monkeypatch):
        from pcc_node import config as config_module
        path = tmp_path / "pcc-node.json"
        path.write_text(json.dumps({"kernel_id": "k", "pcc_api_key": self._key()}))
        os.chmod(path, 0o644)
        monkeypatch.setattr(config_module.os, "getuid", lambda: os.stat(path).st_uid + 1)
        refused = getattr(config_module, "ConfigFileError", None)
        assert refused is not None, "another account's config was loaded"
        with pytest.raises(refused, match="owned by another account"):
            load_config(str(path))
        assert os.stat(path).st_mode & 0o777 == 0o644  # not touched

    def test_start_stops_rather_than_replacing_a_config_it_refused(self, tmp_path):
        from unittest import mock
        from click.testing import CliRunner
        from pcc_node.cli import main
        target = tmp_path / "elsewhere.json"
        target.write_text(json.dumps({"kernel_id": "k", "pcc_api_key": self._key()}))
        os.chmod(target, 0o600)
        link = tmp_path / "pcc-node.json"
        link.symlink_to(target)
        with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
             mock.patch("pcc_node.cli.detect_all", return_value=[]), \
             mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 32, "cd" * 32)), \
             mock.patch("pcc_node.cli.provision_api_key", return_value="test-key"), \
             mock.patch("pcc_node.cli.register_kernel", return_value={"ok": True}), \
             mock.patch("pcc_node.cli.register_devices", return_value=None), \
             mock.patch("pcc_node.cli.register_signing_key", return_value=(200, {})), \
             mock.patch("pcc_node.cli.announce_capabilities", create=True), \
             mock.patch("pcc_node.cli.run_daemon") as daemon:
            result = CliRunner().invoke(main, ["start", "-c", str(link), "--api-key", "k"])
        assert result.exit_code == 1, result.output
        assert link.is_symlink()
        daemon.assert_not_called()

    def test_loading_a_readable_config_without_a_key_is_quiet(self, tmp_path, caplog):
        path = tmp_path / "pcc-node.json"
        path.write_text(json.dumps({"kernel_id": "k"}))
        os.chmod(path, 0o644)
        with caplog.at_level("WARNING"):
            load_config(str(path))
        assert caplog.text == ""
