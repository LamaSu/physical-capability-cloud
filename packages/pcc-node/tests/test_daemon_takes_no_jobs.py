"""Verdict 68c on #442, finding 3: the daemon must not advertise what it will not do.

At 5545fa7a the daemon announced its devices as capabilities (the operator
heartbeat inserts them as buyer-visible listings), polled the gateway for
their jobs, refused every one, and marked each job seen, so a buyer saw an
online node while nothing would ever run their job. It now neither polls for
jobs nor announces capabilities, and it says so. Jobs run only through the
operating agent's typed operations.
"""

import logging
from unittest import mock

import pytest

from pcc_node import daemon
from pcc_node.config import NodeConfig


def test_the_daemon_neither_polls_jobs_nor_advertises_capabilities(monkeypatch, tmp_path, caplog):
    client = mock.MagicMock()
    client.poll_for_jobs.return_value = [{"id": "j1", "capabilityType": "liquid-handler", "parameters": {}}]
    announce = mock.MagicMock()
    executor = mock.MagicMock()
    monkeypatch.setattr(daemon, "PCCGatewayClient", lambda **kwargs: client)
    monkeypatch.setattr(daemon, "announce_capabilities", announce, raising=False)
    monkeypatch.setattr("pcc_node.register.announce_capabilities", announce)
    monkeypatch.setattr(daemon, "JobExecutor", executor, raising=False)
    monkeypatch.setattr(daemon, "register_kernel", mock.MagicMock())
    monkeypatch.setattr(daemon, "load_or_create_keys", lambda *a, **k: ("ab" * 32, "cd" * 32))
    monkeypatch.setattr(daemon, "detect_camera_device", lambda: None)
    monkeypatch.setattr(daemon, "discover_network", lambda timeout=0.5: [])
    monkeypatch.setattr("pcc_node.ui_server.start_ui_server", lambda **kwargs: None)
    monkeypatch.setattr(daemon, "PID_FILE", str(tmp_path / "pid"))
    monkeypatch.setattr(daemon, "STATE_FILE", str(tmp_path / "state.json"))

    def stop(_seconds):
        raise KeyboardInterrupt  # ends the loop after its first pass

    monkeypatch.setattr(daemon.time, "sleep", stop)
    config = NodeConfig(kernel_id="k1", pcc_base="http://127.0.0.1:9", pcc_api_key="k",
                        devices=[{"id": "g1", "protocol": "generic", "url": "http://127.0.0.1:1"}],
                        poll_interval=1, diagnostics_mode="off")

    with caplog.at_level(logging.INFO, logger="pcc-node.daemon"), pytest.raises(KeyboardInterrupt):
        daemon.run_daemon(config)

    client.poll_for_jobs.assert_not_called()
    client.announce_capabilities.assert_not_called()
    announce.assert_not_called()
    executor.return_value.execute.assert_not_called()
    assert "does not take jobs" in caplog.text


def test_the_daemon_documentation_matches():
    doc = daemon.__doc__ or ""
    assert "does not take jobs" in doc
    for claim in ("Hand each job", "pushes evidence", "real end-to-end", "Re-announce capabilities"):
        assert claim not in doc, claim
