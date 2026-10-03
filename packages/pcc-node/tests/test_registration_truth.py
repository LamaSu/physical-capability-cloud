"""pcc-node never reports a kernel registration the gateway did not confirm.

Incident #2984.  ``discover`` and daemon coverage for the same fix lives in
test_discovery.py and test_daemon_loop.py.
"""

from unittest import mock

import pytest
from click.testing import CliRunner

from pcc_node.cli import main


@pytest.fixture
def runner():
    return CliRunner()


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
