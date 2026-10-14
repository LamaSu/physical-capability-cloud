"""Signing identity refusals reach operators without a traceback or registration."""

from unittest import mock

import pytest
from click.testing import CliRunner

from pcc_node import cli, crypto
from pcc_node.discovery import DiscoveredDevice


@pytest.mark.parametrize("command", ["start", "discover"])
@pytest.mark.parametrize(
    "refusal_type, message",
    [
        (
            crypto.KeyFileError,
            "Use the default ~/.pcc-node/keys.json or set PCC_NODE_KEY_PATH "
            "to a path outside every source checkout.",
        ),
        (
            crypto.CompromisedKeyError,
            "The key pair is compromised; retire it and register the new identity.",
        ),
        (
            crypto.CryptoUnavailableError,
            "PyNaCl is required to load node keys. Install pcc-node[crypto].",
        ),
        (
            crypto._ExposedKeyError,
            "The identity is compromised; retire keys.json and keys.json.exposed.",
        ),
    ],
    ids=["key-file", "compromised", "crypto-unavailable", "exposed"],
)
def test_commands_print_key_refusals_and_stop(command, refusal_type, message, tmp_path):
    device = DiscoveredDevice(
        ip="192.0.2.10",
        hostname=None,
        mac=None,
        open_ports=[31950],
        protocol="opentrons",
        device_type="liquid-handler",
        confidence=0.95,
        details={"name": "test-device", "api_version": "8"},
    )
    if command == "start":
        args = [
            "start", "-c", str(tmp_path / "node-config.json"),
            "--pcc-base", "http://127.0.0.1:3200", "--api-key", "test-key",
        ]
    else:
        args = [
            "discover", "--register", "--pcc-base", "http://127.0.0.1:3200",
            "--api-key", "test-key",
        ]

    with mock.patch.object(cli, "_setup_logging"), \
         mock.patch.object(cli, "is_running", return_value=(False, None)), \
         mock.patch.object(cli, "detect_all", return_value=[]), \
         mock.patch.object(cli, "discover_network", return_value=[device]), \
         mock.patch.object(cli, "load_or_create_keys", side_effect=refusal_type(message)) as load, \
         mock.patch.object(cli, "provision_api_key") as provision, \
         mock.patch.object(cli, "register_kernel") as register, \
         mock.patch.object(cli, "register_signing_key") as register_key, \
         mock.patch.object(cli, "save_config") as save, \
         mock.patch.object(cli, "run_daemon") as daemon:
        result = CliRunner().invoke(cli.main, args)

    assert result.exit_code == 1
    assert isinstance(result.exception, SystemExit)
    assert result.stderr == f"Cannot use this node's key file: {message}\n"
    assert message not in result.stdout
    assert "Traceback" not in result.output
    assert "Traceback" not in result.stderr
    load.assert_called_once_with()
    provision.assert_not_called()
    register.assert_not_called()
    register_key.assert_not_called()
    save.assert_not_called()
    daemon.assert_not_called()
