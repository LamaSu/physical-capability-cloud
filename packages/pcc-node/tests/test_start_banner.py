"""N57 (product-steward #4042, #4076): `pcc-node start` names its target
gateway first, and registering on the public network by default needs a yes.

The gateway is resolved once: --pcc-base, then PCC_BASE, then the config
file's pcc_base, then the public default. The banner and registration use
that same value. A default public registration asks once on a terminal (and
remembers the yes); without a terminal it refuses unless --yes or PCC_BASE is
given.
"""

import json
from unittest import mock

import pytest
from click.testing import CliRunner

from pcc_node import cli
from pcc_node.cli import main

PUBLIC = "https://capability.network"


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))


def _start(tmp_path, args=(), env=None, stdin=None, interactive=False, config=None, config_name="node-config.json"):
    config_path = tmp_path / config_name
    if config is not None:
        config_path.write_text(json.dumps(config))
    with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
         mock.patch("pcc_node.cli._interactive", return_value=interactive), \
         mock.patch("pcc_node.cli.detect_all", return_value=[]), \
         mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 16, "cd" * 16)), \
         mock.patch("pcc_node.cli.provision_api_key", return_value="test-key"), \
         mock.patch("pcc_node.cli.register_kernel", return_value={"ok": True}) as register, \
         mock.patch("pcc_node.cli.register_signing_key", return_value=(200, {})), \
         mock.patch("pcc_node.cli.announce_capabilities"), \
         mock.patch("pcc_node.cli.run_daemon"):
        result = CliRunner().invoke(main, ["start", "-c", str(config_path), "--api-key", "k", *args],
                                    env={"PCC_BASE": "", **(env or {})}, input=stdin)
    return result, register


def test_the_default_target_is_named_first_and_used(tmp_path):
    result, register = _start(tmp_path, args=("--yes",))
    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert lines[0] == f"Target gateway: {PUBLIC} (public PCC network, test-net payments)"
    assert "a kernel record under your API key" in lines[1]
    assert register.call_args[0][0] == PUBLIC


def test_without_a_terminal_a_default_public_start_refuses(tmp_path):
    result, register = _start(tmp_path)
    assert result.exit_code == 1
    assert "Pass --yes or set PCC_BASE to register with the public network." in result.output
    register.assert_not_called()


def test_pcc_base_proceeds_without_asking_and_is_named(tmp_path):
    result, register = _start(tmp_path, env={"PCC_BASE": "http://127.0.0.1:4310/"})
    assert result.exit_code == 0, result.output
    assert result.output.splitlines()[0] == "Target gateway: http://127.0.0.1:4310 (set by PCC_BASE)"
    assert register.call_args[0][0] == "http://127.0.0.1:4310"


def test_a_pcc_base_flag_is_named_as_such(tmp_path):
    result, register = _start(tmp_path, args=("--pcc-base", "https://staging.example"))
    assert result.exit_code == 0, result.output
    assert result.output.splitlines()[0] == "Target gateway: https://staging.example (set by --pcc-base)"
    assert register.call_args[0][0] == "https://staging.example"


def test_a_config_file_gateway_is_used_named_and_not_overridden_by_the_default(tmp_path):
    result, register = _start(tmp_path, config={"kernel_id": "k1", "pcc_base": "https://lab-gw.example/", "devices": []})
    assert result.exit_code == 0, result.output
    path = str((tmp_path / "node-config.json").resolve())
    assert result.output.splitlines()[0] == f"Target gateway: https://lab-gw.example (from {path})"
    assert register.call_args[0][0] == "https://lab-gw.example"


def test_on_a_terminal_yes_proceeds_and_is_remembered(tmp_path):
    result, register = _start(tmp_path, stdin="y\n", interactive=True)
    assert result.exit_code == 0, result.output
    assert f"Register this machine on the public PCC network ({PUBLIC})? [y/N]" in result.output
    register.assert_called_once()
    # From another directory (no config file there), with no terminal: only the
    # remembered yes lets it proceed.
    again, register2 = _start(tmp_path, config_name="elsewhere.json")
    assert again.exit_code == 0, again.output
    register2.assert_called_once()


def test_on_a_terminal_no_refuses(tmp_path):
    result, register = _start(tmp_path, stdin="n\n", interactive=True)
    assert result.exit_code == 1
    register.assert_not_called()


def test_the_banner_comes_before_everything_else(tmp_path):
    with mock.patch("pcc_node.cli.is_running", return_value=(True, 4242)):
        result = CliRunner().invoke(main, ["start", "-c", str(tmp_path / "c.json")], env={"PCC_BASE": ""})
    lines = result.output.splitlines()
    assert lines[0].startswith(f"Target gateway: {PUBLIC}")
    assert "already running" in result.output
