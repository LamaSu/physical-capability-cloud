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
    """run_daemon with every external call mocked, for exactly one loop pass.

    The loop's interruptible sleep calls time.sleep, and the harness makes it
    raise KeyboardInterrupt, which ends the run after the first pass. The
    daemon takes no jobs and announces no capabilities (verdict 68c,
    finding 3): these tests replace ones that asserted it polled, executed,
    marked jobs seen and announced.
    """

    def _run_once(self, config):
        from pcc_node import daemon as daemon_module

        with mock.patch.object(daemon_module, "load_or_create_keys", return_value=("pub", "sec")), \
             mock.patch.object(daemon_module, "discover_network", return_value=[]), \
             mock.patch.object(daemon_module, "register_kernel", return_value={}) as mock_register, \
             mock.patch("pcc_node.register.announce_capabilities") as mock_announce, \
             mock.patch.object(daemon_module, "detect_camera_device", return_value=None), \
             mock.patch("pcc_node.daemon.PCCGatewayClient") as MockClient, \
             mock.patch("pcc_node.ui_server.start_ui_server"), \
             mock.patch.object(daemon_module.time, "sleep", side_effect=KeyboardInterrupt):
            mock_client = MockClient.return_value
            mock_client.poll_for_jobs.return_value = [{"id": "j-test", "capabilityType": "document-printing"}]
            try:
                daemon_module.run_daemon(config)
            except (KeyboardInterrupt, SystemExit):
                pass
        return mock_client, mock_register, mock_announce

    def _config(self, **overrides):
        values = dict(kernel_id="k-test", kernel_name="test-node", pcc_base="http://pcc-test",
                      pcc_api_key="key", poll_interval=1,
                      devices=[{"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}])
        values.update(overrides)
        return NodeConfig(**values)

    def test_the_daemon_fails_closed_on_a_registration_401(self):
        # verdict 133a MED: a refused (non-2xx) registration must stop the daemon BEFORE it creates the
        # gateway client, sends an "online" heartbeat, writes running state, or logs "Daemon running" --
        # so `status` cannot report a false "PCC: connected".
        from pcc_node import daemon as daemon_module
        from pcc_node.register import RegistrationError
        with mock.patch.object(daemon_module, "load_or_create_keys", return_value=("pub", "sec")), \
             mock.patch.object(daemon_module, "discover_network", return_value=[]), \
             mock.patch.object(daemon_module, "register_kernel",
                               side_effect=RegistrationError(401, {"error": "unauthorized"})), \
             mock.patch.object(daemon_module, "detect_camera_device", return_value=None), \
             mock.patch("pcc_node.daemon.PCCGatewayClient") as MockClient, \
             mock.patch("pcc_node.ui_server.start_ui_server"), \
             mock.patch.object(daemon_module, "_write_state") as write_state, \
             mock.patch.object(daemon_module.time, "sleep", side_effect=KeyboardInterrupt):
            # ChatGPT r3 F1: the refusal is raised (after the cleanup), not returned as a normal stop.
            with pytest.raises(RegistrationError):
                daemon_module.run_daemon(self._config())
        MockClient.assert_not_called()   # no gateway client / no "online" heartbeat
        write_state.assert_not_called()  # no running state written

    def test_a_refused_registration_leaves_no_pid_or_state_file(self):
        # verdict 133b MED (Q1 NOT CLOSED): the fail-closed return at the 401 bypasses the daemon-file
        # cleanup, so the PID written at startup plus a PRE-EXISTING state file from an earlier run let
        # `status` still print "PCC: connected" after a refused registration. The fail path must leave
        # disk as a clean shutdown does -- no PID file, no state file.
        from pcc_node import daemon as daemon_module
        from pcc_node.register import RegistrationError
        # A stale state file from an earlier, successful run is already on disk.
        with open(daemon_module.STATE_FILE, "w") as f:
            json.dump({"kernel_id": "k-old", "pcc_base": "http://pcc-test", "pid": os.getpid()}, f)
        with mock.patch.object(daemon_module, "load_or_create_keys", return_value=("pub", "sec")), \
             mock.patch.object(daemon_module, "discover_network", return_value=[]), \
             mock.patch.object(daemon_module, "register_kernel",
                               side_effect=RegistrationError(401, {"error": "unauthorized"})), \
             mock.patch.object(daemon_module, "detect_camera_device", return_value=None), \
             mock.patch("pcc_node.daemon.PCCGatewayClient") as MockClient, \
             mock.patch("pcc_node.ui_server.start_ui_server"):
            with pytest.raises(RegistrationError):  # ChatGPT r3 F1: raised after the cleanup
                daemon_module.run_daemon(self._config())
        # The daemon never started, so it must leave no live-looking footprint: a subsequent `status`
        # keys off read_pid()/read_state(), so both must be gone.
        assert daemon_module.read_pid() is None, "PID file left behind after a refused registration"
        assert daemon_module.read_state() is None, "state file left behind after a refused registration"
        MockClient.assert_not_called()

    def test_the_daemon_keeps_the_kernel_online_without_taking_jobs(self):
        client, _, _ = self._run_once(self._config())
        client.send_heartbeat.assert_any_call("online", accepting_jobs=False)
        client.poll_for_jobs.assert_not_called()
        client.mark_job_seen.assert_not_called()

    def test_the_daemon_announces_no_capabilities(self):
        client, _, announce = self._run_once(self._config())
        announce.assert_not_called()
        client.announce_capabilities.assert_not_called()

    def test_daemon_registers_kernel_on_startup(self):
        config = self._config(kernel_id="k-reg", devices=[])
        _, register, _ = self._run_once(config)
        register.assert_called_once_with("http://pcc-test", "key", config)
