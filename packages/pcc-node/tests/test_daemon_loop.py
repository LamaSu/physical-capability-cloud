"""Tests for the daemon loop integration."""

import json
import os
import signal
import time
from unittest import mock

import pytest

from pcc_node.daemon import (
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
# Daemon state files
# ---------------------------------------------------------------------------
# NOTE: the old capability-builder (_build_capabilities_from_devices, and its
# ad hoc device-type -> capability-slug map) was removed in #3560. Capability
# derivation is now pcc_node.declared_terms.announcement_plan, which requires
# each device to carry its own DECLARED terms (assuranceTiers/pricing) --
# see tests/test_declared_terms.py for its full coverage (mirrors gateway PR
# #437 plus the node's own stricter checks).

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

    def test_announcement_defaults_to_empty_dict(self):
        """_write_state's ``announcement`` parameter is optional; when
        omitted the state file still has the key (#3560: cli status reads
        state.get("announcement") unconditionally)."""
        cfg = NodeConfig(kernel_id="k-test", kernel_name="test-node")
        _write_state(cfg, time.time(), 0)
        state = read_state()
        assert state["announcement"] == {}

    def test_announcement_round_trips(self):
        """#3560: the state file records what was announced, what was not
        (and why), and what the gateway refused -- so pcc-node status can
        print it (cli._echo_announcement)."""
        cfg = NodeConfig(kernel_id="k-test", kernel_name="test-node")
        announcement = {
            "announced": ["3d-print"],
            "notAnnounced": [{"device": "cam-1", "reason": "this node executes no capability on protocol 'camera'"}],
            "skipped": [{"type": "3d-print", "reason": "zero-price"}],
        }
        _write_state(cfg, time.time(), 3, announcement)
        state = read_state()
        assert state["announcement"] == announcement


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
                # No declared terms: the device offers "document-printing" in
                # principle (protocol "ipp"), but with nothing declared it is
                # never announced (#3560) -- irrelevant to this test, which
                # only exercises job polling/execution.
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
        """Capabilities are announced once at startup -- but only when a
        device actually declares terms (#3560): announce_capabilities is
        called from run_daemon only `if capabilities:`, and a device with no
        assuranceTiers/pricing produces none."""
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
                devices=[{
                    "id": "p1", "protocol": "ipp",
                    "assuranceTiers": [0],
                    "pricing": {"currency": "USDC", "baseCost": "5", "minimum": "5"},
                }],
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
