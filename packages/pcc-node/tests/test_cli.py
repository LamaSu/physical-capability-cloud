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


class TestStartRegistrationTruth:
    """``start`` never claims a registration the gateway did not confirm.

    Incident #2984: after ``POST /api/kernels`` returned HTTP 401, ``start``
    still went on to "Node running. Accepting jobs." and the daemon logged
    "Kernel ... registered".  Every network call here is mocked, and the base
    URL is an unresolvable ``.invalid`` host, so nothing can reach a gateway.
    """

    BASE = "http://pcc.invalid"
    # The caller's own PCC_* variables must not leak into these runs.
    CLEAN_ENV = {"PCC_API_KEY": None, "PCC_BASE": None, "KERNEL_ID": None}

    def _start(self, runner, tmp_path, register_side_effect, *, provision=None,
               extra_args=("--api-key", "k")):
        from pcc_node.register import KernelRegistrationError  # noqa: F401

        config_path = str(tmp_path / "node-config.json")
        with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
             mock.patch("pcc_node.cli.detect_all", return_value=[]), \
             mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 16, "cd" * 16)), \
             mock.patch("pcc_node.cli.provision_api_key", return_value=provision) as prov, \
             mock.patch("pcc_node.cli.register_kernel", side_effect=register_side_effect), \
             mock.patch("pcc_node.cli.register_devices") as reg_devices, \
             mock.patch("pcc_node.cli.register_signing_key", return_value=(200, {})) as reg_key, \
             mock.patch("pcc_node.cli.announce_capabilities") as announce, \
             mock.patch("pcc_node.cli._maybe_prompt_diagnostics"), \
             mock.patch("pcc_node.cli.save_config", return_value=config_path) as save, \
             mock.patch("pcc_node.cli.run_daemon") as daemon:
            result = runner.invoke(
                main, ["start", "-c", config_path, "--pcc-base", self.BASE, *extra_args],
                env=self.CLEAN_ENV,
            )
        return result, {
            "provision": prov, "register_devices": reg_devices,
            "register_signing_key": reg_key, "announce": announce,
            "save_config": save, "run_daemon": daemon,
        }

    def _assert_nothing_started(self, result, calls):
        assert result.exit_code != 0
        assert "NOT registered" in result.output
        assert "Nothing was started" in result.output
        assert "registered." not in result.output
        assert "Node running" not in result.output
        assert "Accepting jobs" not in result.output
        calls["register_devices"].assert_not_called()
        calls["register_signing_key"].assert_not_called()
        calls["announce"].assert_not_called()
        calls["run_daemon"].assert_not_called()

    def test_rejected_key_aborts_and_says_so(self, runner, tmp_path):
        from pcc_node.register import KernelRegistrationError

        err = KernelRegistrationError("kernel-x", 401, {"error": "unauthorized"})
        result, calls = self._start(runner, tmp_path, err)

        self._assert_nothing_started(result, calls)
        assert "rejected the API key (HTTP 401)" in result.output
        # The key came from --api-key, so there is nothing new to keep.
        calls["save_config"].assert_not_called()

    def test_unreachable_gateway_aborts_and_says_so(self, runner, tmp_path):
        from pcc_node.register import KernelRegistrationError

        err = KernelRegistrationError("kernel-x", 0, {"error": "connection refused"})
        result, calls = self._start(runner, tmp_path, err)

        self._assert_nothing_started(result, calls)
        assert f"the gateway at {self.BASE} could not be reached" in result.output

    def test_server_error_aborts_and_says_so(self, runner, tmp_path):
        from pcc_node.register import KernelRegistrationError

        err = KernelRegistrationError("kernel-x", 503, {"error": "unavailable"})
        result, calls = self._start(runner, tmp_path, err)

        self._assert_nothing_started(result, calls)
        assert "the gateway answered HTTP 503" in result.output

    def test_failure_after_provisioning_keeps_the_new_key(self, runner, tmp_path):
        """A key the gateway just minted is saved before aborting, never lost."""
        from pcc_node.register import KernelRegistrationError

        err = KernelRegistrationError("kernel-x", 503, {"error": "unavailable"})
        result, calls = self._start(
            runner, tmp_path, err, provision="minted-key", extra_args=(),
        )

        self._assert_nothing_started(result, calls)
        calls["provision"].assert_called_once()
        calls["save_config"].assert_called_once()
        saved_config = calls["save_config"].call_args.args[0]
        assert saved_config.pcc_api_key == "minted-key"
        assert "The new API key was saved to" in result.output

    def test_unsavable_new_key_is_reported_not_hidden(self, runner, tmp_path):
        """If saving the minted key fails, the registration failure still shows."""
        from pcc_node.register import KernelRegistrationError

        err = KernelRegistrationError("kernel-x", 503, {"error": "unavailable"})
        config_path = str(tmp_path / "node-config.json")
        with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
             mock.patch("pcc_node.cli.detect_all", return_value=[]), \
             mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 16, "cd" * 16)), \
             mock.patch("pcc_node.cli.provision_api_key", return_value="minted-key"), \
             mock.patch("pcc_node.cli.register_kernel", side_effect=err), \
             mock.patch("pcc_node.cli.save_config", side_effect=PermissionError("read-only")), \
             mock.patch("pcc_node.cli.run_daemon") as daemon:
            result = runner.invoke(
                main, ["start", "-c", config_path, "--pcc-base", self.BASE],
                env=self.CLEAN_ENV,
            )
        assert result.exit_code != 0
        assert "NOT registered" in result.output
        assert "could NOT be saved" in result.output
        assert "minted-key" not in result.output
        daemon.assert_not_called()

    def test_confirmed_registration_is_reported(self, runner, tmp_path):
        result, calls = self._start(runner, tmp_path, lambda *a, **k: {"id": "k"})

        assert result.exit_code == 0, result.output
        assert "registered." in result.output
        assert "NOT registered" not in result.output
        assert "Node running" in result.output
        calls["run_daemon"].assert_called_once()

    def test_daemon_stopping_on_a_rejected_key_exits_nonzero(self, runner, tmp_path):
        config_path = str(tmp_path / "node-config.json")
        with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
             mock.patch("pcc_node.cli.detect_all", return_value=[]), \
             mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 16, "cd" * 16)), \
             mock.patch("pcc_node.cli.register_kernel", return_value={"id": "k"}), \
             mock.patch("pcc_node.cli.register_devices"), \
             mock.patch("pcc_node.cli.register_signing_key", return_value=(200, {})), \
             mock.patch("pcc_node.cli.announce_capabilities"), \
             mock.patch("pcc_node.cli._maybe_prompt_diagnostics"), \
             mock.patch("pcc_node.cli.save_config", return_value=config_path), \
             mock.patch("pcc_node.cli.run_daemon", return_value=False):
            result = runner.invoke(
                main, ["start", "-c", config_path, "--pcc-base", self.BASE, "--api-key", "k"],
                env=self.CLEAN_ENV,
            )
        assert result.exit_code == 1
