"""Tests for the CLI commands."""

import json
import os
from unittest import mock

import pytest
from click.testing import CliRunner

from pcc_node.cli import main


@pytest.fixture
def runner():
    return CliRunner()


class TestVersion:
    def test_version_flag(self, runner):
        result = runner.invoke(main, ["--version"])
        assert result.exit_code == 0
        assert "pcc-node" in result.output
        assert "0.1.0" in result.output


class TestDetectCommand:
    def test_no_devices(self, runner):
        with mock.patch("pcc_node.cli.detect_all", return_value=[]):
            result = runner.invoke(main, ["detect"])
        assert result.exit_code == 0
        assert "No devices detected" in result.output

    def test_with_devices(self, runner):
        devices = [
            {"type": "camera", "path": "/dev/video0", "name": "TestCam", "formats": ["MJPEG"]},
            {"type": "opentrons", "url": "http://localhost:31950", "name": "ot2", "api_version": "8"},
        ]
        with mock.patch("pcc_node.cli.detect_all", return_value=devices):
            result = runner.invoke(main, ["detect"])
        assert result.exit_code == 0
        assert "Detected devices" in result.output
        assert "Camera" in result.output
        assert "Opentrons" in result.output


class TestStatusCommand:
    def test_not_running(self, runner):
        with mock.patch("pcc_node.cli.is_running", return_value=(False, None)):
            result = runner.invoke(main, ["status"])
        assert result.exit_code == 0
        assert "not running" in result.output

    def test_running_with_state(self, runner):
        import time
        state = {
            "kernel_id": "kernel-abc123",
            "started_at": time.time() - 7200,  # 2 hours ago
            "jobs_completed": 5,
            "camera_device": "/dev/video0",
            "pcc_base": "https://capability.network",
        }
        with mock.patch("pcc_node.cli.is_running", return_value=(True, 12345)), \
             mock.patch("pcc_node.cli.read_state", return_value=state):
            result = runner.invoke(main, ["status"])
        assert result.exit_code == 0
        assert "running" in result.output
        assert "kernel-abc123" in result.output
        assert "Jobs completed: 5" in result.output

    def test_running_no_state(self, runner):
        with mock.patch("pcc_node.cli.is_running", return_value=(True, 99)), \
             mock.patch("pcc_node.cli.read_state", return_value=None):
            result = runner.invoke(main, ["status"])
        assert result.exit_code == 0
        assert "running (PID 99)" in result.output
        assert "limited info" in result.output


class TestConfigCommand:
    def test_interactive_config(self, runner, tmp_path):
        output_path = str(tmp_path / "test-config.json")
        result = runner.invoke(
            main, ["config", "-o", output_path],
            input="liquid-handler\nlocalhost:31950\nmanual\n10\n0.15\nhttps://capability.network\ny\n",
        )
        assert result.exit_code == 0
        assert os.path.exists(output_path)

        with open(output_path) as f:
            data = json.load(f)
        assert data["approval_mode"] == "manual"
        assert data["kernel_name"] == "liquid-handler-node"


class TestStartCommand:
    def test_already_running(self, runner):
        with mock.patch("pcc_node.cli.is_running", return_value=(True, 999)):
            result = runner.invoke(main, ["start"])
        assert result.exit_code == 1
        assert "already running" in result.output

    def test_start_flow(self, runner, tmp_path):
        config_path = str(tmp_path / "node-config.json")

        with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
             mock.patch("pcc_node.cli.detect_all", return_value=[]), \
             mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 16, "cd" * 16)), \
             mock.patch("pcc_node.cli.provision_api_key", return_value="test-key"), \
             mock.patch("pcc_node.cli.register_kernel", return_value={"ok": True}), \
             mock.patch("pcc_node.cli.register_signing_key", return_value=(200, {})), \
             mock.patch("pcc_node.cli.announce_capabilities"), \
             mock.patch("pcc_node.cli.run_daemon") as mock_daemon:
            result = runner.invoke(main, ["start", "-c", config_path, "--api-key", "k"])
        assert result.exit_code == 0
        assert "Detecting hardware" in result.output
        assert "Node running" in result.output
        mock_daemon.assert_called_once()
