"""N57 (product-steward #4042): `pcc-node start` names its target gateway first.

The public gateway stays the default. The first line says where this node
will register and take jobs, and the second line says what starting creates
there, before anything is detected, provisioned or registered.
"""

from unittest import mock

import pytest
from click.testing import CliRunner

from pcc_node.cli import main


def _start(args=(), env=None, tmp_path=None):
    runner = CliRunner()
    config_path = str(tmp_path / "node-config.json")
    with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
         mock.patch("pcc_node.cli.detect_all", return_value=[]), \
         mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 16, "cd" * 16)), \
         mock.patch("pcc_node.cli.provision_api_key", return_value="test-key"), \
         mock.patch("pcc_node.cli.register_kernel", return_value={"ok": True}) as register, \
         mock.patch("pcc_node.cli.register_signing_key", return_value=(200, {})), \
         mock.patch("pcc_node.cli.announce_capabilities"), \
         mock.patch("pcc_node.cli.run_daemon"):
        result = runner.invoke(main, ["start", "-c", config_path, "--api-key", "k", *args], env=env or {})
    return result, register


def test_the_default_target_is_the_public_gateway_and_is_named_first(tmp_path):
    result, register = _start(env={"PCC_BASE": ""}, tmp_path=tmp_path)
    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert lines[0] == "Target gateway: https://capability.network (public PCC network, test-net payments)"
    assert "a kernel record under your API key" in lines[1]
    assert register.call_args[0][0] == "https://capability.network"


def test_an_explicit_pcc_base_is_named_and_used(tmp_path):
    result, register = _start(env={"PCC_BASE": "http://127.0.0.1:4310/"}, tmp_path=tmp_path)
    assert result.exit_code == 0, result.output
    assert result.output.splitlines()[0] == "Target gateway: http://127.0.0.1:4310 (set by PCC_BASE)"
    assert register.call_args[0][0].rstrip("/") == "http://127.0.0.1:4310"


def test_a_pcc_base_flag_is_named_as_such(tmp_path):
    result, _ = _start(args=("--pcc-base", "https://staging.example"), tmp_path=tmp_path)
    assert result.exit_code == 0, result.output
    assert result.output.splitlines()[0] == "Target gateway: https://staging.example (set by --pcc-base)"


def test_the_banner_comes_before_everything_else(tmp_path):
    with mock.patch("pcc_node.cli.is_running", return_value=(True, 4242)):
        result = CliRunner().invoke(main, ["start", "-c", str(tmp_path / "c.json")], env={"PCC_BASE": ""})
    lines = result.output.splitlines()
    assert lines[0].startswith("Target gateway: https://capability.network")
    assert "already running" in result.output
