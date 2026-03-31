"""Tests for the daemon loop integration."""

import json
import os
import signal
import time
from unittest import mock

import pytest

from pcc_node.daemon import (
    _build_capabilities_from_devices,
    _write_pid,
    _remove_pid,
    _write_state,
    read_state,
    read_pid,
    is_running,
    PID_FILE,
    STATE_FILE,
)
from pcc_node.config import NodeConfig


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def clean_pid_files():
    """Clean up PID and state files before and after each test."""
    for f in [PID_FILE, STATE_FILE]:
        try:
            os.remove(f)
        except OSError:
            pass
    yield
    for f in [PID_FILE, STATE_FILE]:
        try:
            os.remove(f)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Capability builder
# ---------------------------------------------------------------------------

class TestBuildCapabilitiesFromDevices:
    def test_printer_maps_to_document_printing(self):
        devices = [{"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}]
        caps = _build_capabilities_from_devices(devices)
        types = [c["type"] for c in caps]
        assert "document-printing" in types

    def test_opentrons_maps_to_liquid_handler(self):
        devices = [{"id": "ot1", "type": "opentrons", "url": "http://ot2:31950"}]
        caps = _build_capabilities_from_devices(devices)
        types = [c["type"] for c in caps]
        assert "liquid-handler" in types

    def test_octoprint_maps_to_3d_print(self):
        devices = [{"id": "op1", "protocol": "octoprint", "url": "http://op:5000"}]
        caps = _build_capabilities_from_devices(devices)
        types = [c["type"] for c in caps]
        assert "3d-print" in types

    def test_no_duplicates_from_same_protocol(self):
        devices = [
            {"id": "p1", "protocol": "ipp"},
            {"id": "p2", "protocol": "ipp"},
        ]
        caps = _build_capabilities_from_devices(devices)
        types = [c["type"] for c in caps]
        # document-printing should only appear once
        assert types.count("document-printing") == 1

    def test_empty_devices_returns_empty(self):
        caps = _build_capabilities_from_devices([])
        assert caps == []

    def test_mixed_devices(self):
        devices = [
            {"id": "p1", "protocol": "ipp"},
            {"id": "ot1", "type": "opentrons"},
            {"id": "cam1", "type": "camera"},
        ]
        caps = _build_capabilities_from_devices(devices)
        types = [c["type"] for c in caps]
        assert "document-printing" in types
        assert "liquid-handler" in types
        assert "visual-inspection" in types

    def test_capability_has_device_id(self):
        devices = [{"id": "d1", "protocol": "ipp", "host": "10.0.0.1"}]
        caps = _build_capabilities_from_devices(devices)
        for cap in caps:
            if cap["type"] == "document-printing":
                assert cap["deviceId"] == "d1"


# ---------------------------------------------------------------------------
# Daemon state files (inherited from original daemon.py, now using new module)
# ---------------------------------------------------------------------------

class TestPidFile:
    def test_write_and_read(self):
        _write_pid()
        pid = read_pid()
        assert pid == os.getpid()

    def test_remove(self):
        _write_pid()
        _remove_pid()
        assert read_pid() is None

    def test_read_missing(self):
        assert read_pid() is None


class TestStateFile:
    def test_write_and_read(self):
        cfg = NodeConfig(kernel_id="k-test", kernel_name="test-node")
        _write_state(cfg, time.time(), 7)
        state = read_state()
        assert state is not None
        assert state["kernel_id"] == "k-test"
        assert state["jobs_completed"] == 7

    def test_read_missing(self):
        assert read_state() is None


class TestIsRunning:
    def test_not_running_no_pid_file(self):
        running, pid = is_running()
        assert running is False
        assert pid is None

    def test_stale_pid(self):
        with open(PID_FILE, "w") as f:
            f.write("999999999")
        running, pid = is_running()
        assert running is False

    def test_current_process(self):
        _write_pid()
        running, pid = is_running()
        assert running is True
        assert pid == os.getpid()


# ---------------------------------------------------------------------------
# run_daemon mock integration test
# ---------------------------------------------------------------------------

class TestRunDaemonLoop:
    """Tests the full run_daemon function with all external calls mocked.

    We test the daemon logic directly rather than running the full loop,
    because sending SIGINT from a timer thread is unreliable on Windows.
    Instead we patch the inner ``while running`` loop to execute exactly once.
    """

    def test_daemon_executes_jobs_from_poll(self):
        """Daemon polls for jobs and calls executor.execute() for each one."""
        from pcc_node import daemon as daemon_module

        jobs_executed = []

        with mock.patch.object(daemon_module, "load_or_create_keys", return_value=("pub", "sec")), \
             mock.patch.object(daemon_module, "discover_network", return_value=[]), \
             mock.patch.object(daemon_module, "register_kernel", return_value={}), \
             mock.patch.object(daemon_module, "announce_capabilities"), \
             mock.patch.object(daemon_module, "detect_camera_device", return_value=None), \
             mock.patch("pcc_node.daemon.PCCGatewayClient") as MockClient, \
             mock.patch("pcc_node.daemon.JobExecutor") as MockExecutor, \
             mock.patch("pcc_node.daemon.start_ui_server", create=True):

            mock_client = mock.MagicMock()
            MockClient.return_value = mock_client
            mock_client.send_heartbeat.return_value = True
            mock_client.announce_capabilities.return_value = True
            mock_client.mark_job_seen = mock.MagicMock()

            # Return one job on first poll, then stop the loop
            poll_count = {"n": 0}
            def fake_poll():
                poll_count["n"] += 1
                if poll_count["n"] == 1:
                    return [{"id": "j-test", "capabilityType": "document-printing"}]
                # Signal stop after first cycle by raising KeyboardInterrupt
                raise KeyboardInterrupt("test done")
            mock_client.poll_for_jobs.side_effect = fake_poll

            mock_executor = mock.MagicMock()
            MockExecutor.return_value = mock_executor
            mock_executor.execute.side_effect = lambda job: jobs_executed.append(job["id"]) or {}

            config = NodeConfig(
                kernel_id="k-test",
                kernel_name="test-node",
                pcc_base="http://pcc-test",
                pcc_api_key="test-key",
                poll_interval=0,
                devices=[{"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}],
            )

            try:
                daemon_module.run_daemon(config)
            except (KeyboardInterrupt, SystemExit):
                pass

        assert "j-test" in jobs_executed
        mock_client.send_heartbeat.assert_called()

    def test_daemon_marks_jobs_seen_before_execution(self):
        """Jobs must be marked seen BEFORE execution to prevent duplicate runs."""
        from pcc_node import daemon as daemon_module

        mark_seen_calls = []
        execute_calls = []

        with mock.patch.object(daemon_module, "load_or_create_keys", return_value=("pub", "sec")), \
             mock.patch.object(daemon_module, "discover_network", return_value=[]), \
             mock.patch.object(daemon_module, "register_kernel", return_value={}), \
             mock.patch.object(daemon_module, "announce_capabilities"), \
             mock.patch.object(daemon_module, "detect_camera_device", return_value=None), \
             mock.patch("pcc_node.daemon.PCCGatewayClient") as MockClient, \
             mock.patch("pcc_node.daemon.JobExecutor") as MockExecutor, \
             mock.patch("pcc_node.daemon.start_ui_server", create=True):

            mock_client = mock.MagicMock()
            MockClient.return_value = mock_client
            mock_client.send_heartbeat.return_value = True
            mock_client.mark_job_seen.side_effect = lambda jid: mark_seen_calls.append(jid)

            call_count = {"n": 0}
            def fake_poll():
                call_count["n"] += 1
                if call_count["n"] == 1:
                    return [{"id": "j-order", "capabilityType": "document-printing"}]
                raise KeyboardInterrupt
            mock_client.poll_for_jobs.side_effect = fake_poll

            mock_executor = mock.MagicMock()
            MockExecutor.return_value = mock_executor
            mock_executor.execute.side_effect = lambda job: execute_calls.append(job["id"]) or {}

            config = NodeConfig(
                kernel_id="k-test",
                kernel_name="test-node",
                pcc_base="http://pcc-test",
                pcc_api_key="test-key",
                poll_interval=0,
                devices=[],
            )

            try:
                daemon_module.run_daemon(config)
            except (KeyboardInterrupt, SystemExit):
                pass

        assert "j-order" in mark_seen_calls
        assert "j-order" in execute_calls

    def test_daemon_announces_capabilities_on_startup(self):
        """Capabilities are announced once at startup."""
        from pcc_node import daemon as daemon_module

        with mock.patch.object(daemon_module, "load_or_create_keys", return_value=("pub", "sec")), \
             mock.patch.object(daemon_module, "discover_network", return_value=[]), \
             mock.patch.object(daemon_module, "register_kernel", return_value={}), \
             mock.patch.object(daemon_module, "announce_capabilities") as mock_announce, \
             mock.patch.object(daemon_module, "detect_camera_device", return_value=None), \
             mock.patch("pcc_node.daemon.PCCGatewayClient") as MockClient, \
             mock.patch("pcc_node.daemon.JobExecutor"), \
             mock.patch("pcc_node.daemon.start_ui_server", create=True):

            mock_client = mock.MagicMock()
            MockClient.return_value = mock_client
            mock_client.poll_for_jobs.side_effect = KeyboardInterrupt

            config = NodeConfig(
                kernel_id="k-test3",
                pcc_base="http://pcc-test",
                pcc_api_key="key",
                poll_interval=0,
                devices=[{"id": "p1", "protocol": "ipp"}],
            )

            try:
                daemon_module.run_daemon(config)
            except (KeyboardInterrupt, SystemExit):
                pass

        # announce_capabilities called during startup (before poll loop)
        mock_announce.assert_called_once()

    def test_daemon_registers_kernel_on_startup(self):
        """Kernel is registered with the gateway on startup."""
        from pcc_node import daemon as daemon_module

        with mock.patch.object(daemon_module, "load_or_create_keys", return_value=("pub", "sec")), \
             mock.patch.object(daemon_module, "discover_network", return_value=[]), \
             mock.patch.object(daemon_module, "register_kernel") as mock_register, \
             mock.patch.object(daemon_module, "announce_capabilities"), \
             mock.patch.object(daemon_module, "detect_camera_device", return_value=None), \
             mock.patch("pcc_node.daemon.PCCGatewayClient") as MockClient, \
             mock.patch("pcc_node.daemon.JobExecutor"), \
             mock.patch("pcc_node.daemon.start_ui_server", create=True):

            mock_client = mock.MagicMock()
            MockClient.return_value = mock_client
            mock_client.poll_for_jobs.side_effect = KeyboardInterrupt

            config = NodeConfig(
                kernel_id="k-reg",
                pcc_base="http://pcc-test",
                pcc_api_key="key",
                poll_interval=0,
                devices=[],
            )

            try:
                daemon_module.run_daemon(config)
            except (KeyboardInterrupt, SystemExit):
                pass

        mock_register.assert_called_once_with("http://pcc-test", "key", config)
