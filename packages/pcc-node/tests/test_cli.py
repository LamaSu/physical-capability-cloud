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
        """#3560: the wizard no longer asks for a kernel-wide price (base
        rate / per-minute prompts are gone). Instead, once a device is
        configured, it asks for that device's own declared terms
        (_prompt_declared_terms) with NO defaults filled in."""
        output_path = str(tmp_path / "test-config.json")
        answers = [
            "liquid-handler",              # What kind of equipment?
            "localhost:31950",             # Device IP or URL
            "manual",                      # Approval mode
            "https://capability.network",  # PCC gateway URL
            "0,1",                         # Assurance tiers you offer
            "USDC",                        # Currency code
            "12.50",                       # Base cost
            "5",                           # Minimum charge
            "",                            # Per-minute rate (none)
            "",                            # Per-gram rate (none)
            "",                            # Per-cm3 rate (none)
            "y",                           # Save config?
        ]
        result = runner.invoke(
            main, ["config", "-o", output_path],
            input="\n".join(answers) + "\n",
        )
        assert result.exit_code == 0
        assert os.path.exists(output_path)

        with open(output_path) as f:
            data = json.load(f)
        assert data["approval_mode"] == "manual"
        assert data["kernel_name"] == "liquid-handler-node"
        # No kernel-wide pricing field any more -- terms are per device.
        assert "pricing" not in data
        dev = data["devices"][0]
        assert dev["assuranceTiers"] == [0, 1]
        assert dev["pricing"] == {"currency": "USDC", "baseCost": "12.50", "minimum": "5"}
        assert "Terms: tiers [0, 1]" in result.output

    def test_interactive_config_no_terms_declared(self, runner, tmp_path):
        """Leaving the assurance-tiers prompt empty declares no terms at
        all: nothing is filled in for the operator, and the device is saved
        with no assuranceTiers/pricing (so it will announce nothing)."""
        output_path = str(tmp_path / "test-config.json")
        answers = [
            "3d-printer",                  # What kind of equipment?
            "localhost:5000",              # Device IP or URL
            "auto",                        # Approval mode
            "https://capability.network",  # PCC gateway URL
            "",                            # Assurance tiers -- empty, decline
            "y",                           # Save config?
        ]
        result = runner.invoke(
            main, ["config", "-o", output_path],
            input="\n".join(answers) + "\n",
        )
        assert result.exit_code == 0
        assert "Terms: none declared, so nothing will be announced" in result.output

        with open(output_path) as f:
            data = json.load(f)
        dev = data["devices"][0]
        assert "assuranceTiers" not in dev
        assert "pricing" not in dev


class TestStartCommand:
    def test_already_running(self, runner):
        with mock.patch("pcc_node.cli.is_running", return_value=(True, 999)):
            result = runner.invoke(main, ["start"])
        assert result.exit_code == 1
        assert "already running" in result.output

    def test_start_keeps_the_configured_devices_and_their_declared_terms(self, runner, tmp_path):
        """#3560 / N1: `start` used to REPLACE the configured devices with the
        freshly detected ones, which would erase every declared term on the
        next start.  The configured device must reach the announcement with
        its terms, a newly detected device is added beside it, and the saved
        file still declares the terms."""
        terms = {"assuranceTiers": [1], "pricing": {"currency": "USDC", "baseCost": "12.50", "minimum": "10"}}
        configured = {"id": "printer-1", "type": "ipp", "host": "10.0.0.5", **terms}
        detected = {"type": "camera", "path": "/dev/video0"}
        config_path = tmp_path / "node-config.json"
        config_path.write_text(json.dumps({"kernel_id": "kernel-t", "devices": [configured]}))

        with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
             mock.patch("pcc_node.cli.detect_all", return_value=[detected]), \
             mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 16, "cd" * 16)), \
             mock.patch("pcc_node.cli.register_kernel", return_value={"ok": True}), \
             mock.patch("pcc_node.cli.register_devices") as mock_register_devices, \
             mock.patch("pcc_node.cli.register_signing_key", return_value=(200, {})), \
             mock.patch("pcc_node.cli.announce_capabilities") as mock_announce, \
             mock.patch("pcc_node.cli._maybe_prompt_diagnostics"), \
             mock.patch("pcc_node.cli.run_daemon"):
            result = runner.invoke(main, ["start", "-c", str(config_path), "--api-key", "k"])
        assert result.exit_code == 0, result.output

        announced_devices = mock_announce.call_args.args[3]
        assert configured in announced_devices
        assert detected in announced_devices
        assert mock_register_devices.call_args.args[3] == announced_devices
        saved = json.loads(config_path.read_text())
        assert saved["devices"][0] == configured

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
