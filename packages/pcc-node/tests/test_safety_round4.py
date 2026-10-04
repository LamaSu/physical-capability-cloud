"""Verdict 105d on #454: the remaining Windows config-trust path, reproduced at 1b107807 first.

On Windows a config file cannot yet be made private (no owner-only ACL, no
no-follow open), and 1b107807 refused only configs that hold a key. A keyless
config still chose the gateway that a key given on the command line was sent
to: another account that could rewrite the file could redirect that key.
"""

import json
import socket
from unittest import mock

import pytest
from click.testing import CliRunner

from pcc_node import config as config_mod
from pcc_node.cli import main
from pcc_node.config import ConfigFileError, NodeConfig, load_config, save_config


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(address, *args, **kwargs):
        raise AssertionError(f"unexpected network call to {address}")

    monkeypatch.setattr(socket, "create_connection", refuse)


@pytest.fixture
def windows(monkeypatch):
    monkeypatch.setattr(config_mod, "_POSIX", False)


def test_on_windows_a_keyless_config_cannot_redirect_a_key_given_on_the_command_line(tmp_path, windows):
    config_file = tmp_path / "pcc-node.json"
    config_file.write_text(json.dumps({"kernel_id": "k", "pcc_base": "https://evil.example"}))
    key = "-".join(["operator", "key", "105d"])
    sent = []

    def record(method, path, body=None, *, base_url, api_key, **kwargs):
        sent.append((base_url, api_key))
        return 200, {"threadId": "t-1"}

    with mock.patch("pcc_node.http_util.pcc_request", record), \
         mock.patch.dict("os.environ", {"PCC_BASE": "", "PCC_API_KEY": ""}):
        CliRunner().invoke(main, ["support", "help", "--api-key", key, "-c", str(config_file)])
    assert all(not (base == "https://evil.example" and api_key == key) for base, api_key in sent), sent


def test_on_windows_no_config_is_loaded_or_saved(tmp_path, windows):
    path = tmp_path / "pcc-node.json"
    path.write_text(json.dumps({"kernel_id": "k", "pcc_base": "https://gw.example.test"}))
    with pytest.raises(ConfigFileError, match="Windows"):
        load_config(str(path))
    with pytest.raises(ConfigFileError, match="Windows"):
        save_config(NodeConfig(kernel_id="k"), str(tmp_path / "other.json"))
    assert not (tmp_path / "other.json").exists()
