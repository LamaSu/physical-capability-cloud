"""Verdict 68d on #442: nothing the node starts carries its key or advertises jobs.

Each test failed at d879e9fa, the reviewed SHA:
- finding 1: the daemon handed its gateway key to the local UI server, whose
  pages are agent-generated (the UI server's proxy itself is deleted by #447);
- finding 3: `pcc-node start` still announced capabilities, although the node
  takes no jobs.
"""

import socket
from unittest import mock

import pytest
from click.testing import CliRunner

from pcc_node import daemon
from pcc_node.cli import main
from pcc_node.config import NodeConfig


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """These tests never reach a real gateway: any connection attempt fails loudly."""
    def refuse(address, *args, **kwargs):
        raise AssertionError(f"unexpected network call to {address}")

    monkeypatch.setattr(socket, "create_connection", refuse)


def test_the_daemon_gives_the_ui_server_no_credentials(monkeypatch, tmp_path):
    ui_calls = []
    monkeypatch.setattr(daemon, "PCCGatewayClient", lambda **kwargs: mock.MagicMock())
    monkeypatch.setattr(daemon, "register_kernel", mock.MagicMock())
    monkeypatch.setattr(daemon, "load_or_create_keys", lambda *a, **k: ("ab" * 32, "cd" * 32))
    monkeypatch.setattr(daemon, "detect_camera_device", lambda: None)
    monkeypatch.setattr(daemon, "discover_network", lambda timeout=0.5: [])
    monkeypatch.setattr("pcc_node.ui_server.start_ui_server", lambda **kwargs: ui_calls.append(kwargs))
    monkeypatch.setattr(daemon, "PID_FILE", str(tmp_path / "pid"))
    monkeypatch.setattr(daemon, "STATE_FILE", str(tmp_path / "state.json"))

    def stop(_seconds):
        raise KeyboardInterrupt  # ends the loop after its first pass

    monkeypatch.setattr(daemon.time, "sleep", stop)
    config = NodeConfig(kernel_id="k1", pcc_base="https://gw.example.test", pcc_api_key="operator-key",
                        devices=[], poll_interval=1, diagnostics_mode="off")
    with pytest.raises(KeyboardInterrupt):
        daemon.run_daemon(config)

    assert len(ui_calls) == 1
    assert "pcc_api_key" not in ui_calls[0] and "pcc_base" not in ui_calls[0]
    assert "operator-key" not in repr(ui_calls[0])


def test_start_announces_no_capabilities(tmp_path):
    device = {"id": "printer-1", "type": "machine", "protocol": "octoprint",
              "url": "http://192.0.2.10", "name": "Test printer"}
    with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
         mock.patch("pcc_node.cli.detect_all", return_value=[device]), \
         mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 32, "cd" * 32)), \
         mock.patch("pcc_node.cli.provision_api_key", return_value="test-key"), \
         mock.patch("pcc_node.cli.register_kernel", return_value={"ok": True}), \
         mock.patch("pcc_node.cli.register_devices", return_value=None), \
         mock.patch("pcc_node.cli.register_signing_key", return_value=(200, {})), \
         mock.patch("pcc_node.cli.announce_capabilities", create=True) as announce, \
         mock.patch("pcc_node.register.announce_capabilities") as announce_module, \
         mock.patch("pcc_node.cli.run_daemon"):
        result = CliRunner().invoke(main, ["start", "-c", str(tmp_path / "node-config.json"), "--api-key", "k",
                                           "--pcc-base", "https://gw.example.test"])
    assert result.exit_code == 0, result.output
    announce.assert_not_called()
    announce_module.assert_not_called()
    assert "does not take jobs" in result.output


def test_the_heartbeat_says_the_node_takes_no_jobs(monkeypatch, tmp_path):
    # Verdict 68d, finding 3: a heartbeat must not keep this kernel's listings alive.
    # The gateway honours acceptingJobs:false once WP-C (#445) merges; until then
    # it ignores the field.
    client = mock.MagicMock()
    monkeypatch.setattr(daemon, "PCCGatewayClient", lambda **kwargs: client)
    monkeypatch.setattr(daemon, "register_kernel", mock.MagicMock())
    monkeypatch.setattr(daemon, "load_or_create_keys", lambda *a, **k: ("ab" * 32, "cd" * 32))
    monkeypatch.setattr(daemon, "detect_camera_device", lambda: None)
    monkeypatch.setattr(daemon, "discover_network", lambda timeout=0.5: [])
    monkeypatch.setattr("pcc_node.ui_server.start_ui_server", lambda **kwargs: None)
    monkeypatch.setattr(daemon, "PID_FILE", str(tmp_path / "pid"))
    monkeypatch.setattr(daemon, "STATE_FILE", str(tmp_path / "state.json"))

    def stop(_seconds):
        raise KeyboardInterrupt

    monkeypatch.setattr(daemon.time, "sleep", stop)
    config = NodeConfig(kernel_id="k1", pcc_base="https://gw.example.test", pcc_api_key="k",
                        devices=[], poll_interval=1, diagnostics_mode="off")
    with pytest.raises(KeyboardInterrupt):
        daemon.run_daemon(config)

    beats = client.send_heartbeat.call_args_list
    assert beats, "the daemon sent no heartbeat"
    assert all(call.kwargs.get("accepting_jobs") is False for call in beats), beats
