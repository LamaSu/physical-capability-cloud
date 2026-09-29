"""Emergency stop on the node (ADK track item 9): read the flag, gate job
intake, and send devices their stop commands."""

from unittest import mock

import pytest

from pcc_node import estop
from pcc_node.config import NodeConfig
from pcc_node.estop import (
    ACTIVE,
    CLEAR,
    FAILED,
    IDLE,
    STOPPED,
    UNKNOWN,
    UNSUPPORTED,
    EStopGuard,
    read_estop,
    stop_device,
)

pytestmark = pytest.mark.real_estop


class TestReadEstop:
    def _read(self, status, body):
        with mock.patch.object(estop, "pcc_request", return_value=(status, body)) as req:
            state, _detail = read_estop("https://gw.example", "node-key", "k/1")
        return state, req

    def test_true_is_active(self):
        assert self._read(200, {"policy": {"emergencyStop": True}})[0] == ACTIVE

    def test_false_is_clear(self):
        assert self._read(200, {"policy": {"emergencyStop": False}})[0] == CLEAR

    def test_a_missing_or_non_boolean_flag_is_unknown(self):
        for policy in ({}, {"emergencyStop": None}, {"emergencyStop": "true"}, {"emergencyStop": 1}):
            assert self._read(200, {"policy": policy})[0] == UNKNOWN, policy

    def test_an_unreadable_policy_is_unknown(self):
        for status, body in ((401, {"error": "x"}), (404, {}), (500, {}), (0, {"error": "down"}),
                             (200, "not json"), (200, {"policy": "on"}), (200, {})):
            assert self._read(status, body)[0] == UNKNOWN, (status, body)

    def test_reads_this_kernels_policy_with_the_node_key(self):
        _state, req = self._read(200, {"policy": {"emergencyStop": False}})
        args, kwargs = req.call_args
        assert args[:2] == ("GET", "/api/operator/policy/k%2F1")
        assert kwargs["base_url"] == "https://gw.example"
        assert kwargs["api_key"] == "node-key"


class TestStopDevice:
    def test_octoprint_cancels_the_job(self):
        device = {"id": "p1", "protocol": "octoprint", "host": "10.0.0.2", "apiKey": "ok"}
        with mock.patch.object(estop, "http", return_value=(204, "")) as http:
            assert stop_device(device)[0] == STOPPED
        http.assert_called_once_with(
            "POST", "http://10.0.0.2:5000/api/job", {"command": "cancel"}, {"X-Api-Key": "ok"}, timeout=5
        )

    def test_octoprint_with_nothing_running_is_idle_and_errors_fail(self):
        device = {"protocol": "octoprint", "url": "http://printer.lan/"}
        with mock.patch.object(estop, "http", return_value=(409, {})) as http:
            assert stop_device(device)[0] == IDLE
        assert http.call_args[0][1] == "http://printer.lan/api/job"
        for status in (403, 500, 0):
            with mock.patch.object(estop, "http", return_value=(status, {})):
                assert stop_device(device)[0] == FAILED

    def test_opentrons_stops_the_current_run(self):
        device = {"protocol": "opentrons", "host": "10.0.0.3"}
        runs = {"data": [{"id": "r-1"}, {"id": "r-9"}], "links": {"current": {"href": "/runs/r-9"}}}
        with mock.patch.object(estop, "http", side_effect=[(200, runs), (201, {})]) as http:
            assert stop_device(device)[0] == STOPPED
        get, post = http.call_args_list
        assert get[0][:2] == ("GET", "http://10.0.0.3:31950/runs")
        assert post[0][:3] == ("POST", "http://10.0.0.3:31950/runs/r-9/actions", {"data": {"actionType": "stop"}})
        assert post[0][3] == {"opentrons-version": "2"}

    def test_opentrons_finds_the_current_run_in_the_list_too(self):
        runs = {"data": [{"id": "r-1", "current": False}, {"id": "r-2", "current": True}]}
        with mock.patch.object(estop, "http", side_effect=[(200, runs), (201, {})]) as http:
            assert stop_device({"protocol": "opentrons", "host": "h"})[0] == STOPPED
        assert http.call_args_list[1][0][1].endswith("/runs/r-2/actions")

    def test_opentrons_without_a_current_run_is_idle_and_sends_nothing(self):
        with mock.patch.object(estop, "http", return_value=(200, {"data": [], "links": {}})) as http:
            assert stop_device({"protocol": "opentrons", "host": "h"})[0] == IDLE
        assert http.call_count == 1

    def test_opentrons_errors_fail_and_a_finished_run_is_idle(self):
        with mock.patch.object(estop, "http", return_value=(503, {})):
            assert stop_device({"protocol": "opentrons", "host": "h"})[0] == FAILED
        runs = {"links": {"current": {"href": "/runs/r-3"}}}
        with mock.patch.object(estop, "http", side_effect=[(200, runs), (409, {})]):
            assert stop_device({"protocol": "opentrons", "host": "h"})[0] == IDLE

    def test_a_device_can_declare_its_stop_endpoint(self):
        device = {"protocol": "generic-http", "url": "http://10.0.0.4:8080", "stopPath": "/halt"}
        with mock.patch.object(estop, "http", return_value=(200, {})) as http:
            assert stop_device(device)[0] == STOPPED
        assert http.call_args[0][:2] == ("POST", "http://10.0.0.4:8080/halt")

    def test_a_malformed_declared_stop_fails_without_a_request(self):
        for stop_path in ("halt", "//evil.example/x", 7):
            device = {"protocol": "generic-http", "url": "http://10.0.0.4", "stopPath": stop_path}
            with mock.patch.object(estop, "http") as http:
                assert stop_device(device)[0] == FAILED, stop_path
            http.assert_not_called()

    def test_devices_without_a_remote_stop_say_so_and_send_nothing(self):
        for device in ({"protocol": "ipp", "host": "10.0.0.5"}, {"protocol": "modbus", "host": "10.0.0.6"}, {}):
            with mock.patch.object(estop, "http") as http:
                outcome, detail = stop_device(device)
            assert outcome == UNSUPPORTED and "physical emergency stop" in detail
            http.assert_not_called()

    def test_a_crashing_stop_is_a_failure_not_an_exception(self):
        with mock.patch.object(estop, "http", side_effect=RuntimeError("boom")):
            assert stop_device({"protocol": "octoprint", "host": "h"})[0] == FAILED


class Recorder:
    def __init__(self, outcomes=None):
        self.calls = []
        self.outcomes = outcomes or {}

    def __call__(self, device):
        self.calls.append(device["id"])
        results = self.outcomes.get(device["id"], [(STOPPED, "ok")])
        return results.pop(0) if len(results) > 1 else results[0]


def guard(states, stopper, devices=({"id": "a"}, {"id": "b"})):
    sequence = list(states)

    def reader(*_args):
        state = sequence.pop(0)
        if isinstance(state, BaseException):
            raise state
        return state, "test"

    return EStopGuard("https://gw", "key", "k1", list(devices), reader=reader, stopper=stopper)


class TestEStopGuard:
    def test_clear_takes_jobs_and_stops_nothing(self):
        stops = Recorder()
        g = guard([CLEAR, CLEAR], stops)
        assert g.check() is True and g.check() is True
        assert stops.calls == []

    def test_unknown_takes_no_jobs_but_leaves_devices_alone(self):
        stops = Recorder()
        g = guard([UNKNOWN, UNKNOWN], stops)
        assert g.check() is False and g.check() is False
        assert stops.calls == []

    def test_a_reader_that_raises_is_unknown(self):
        g = guard([RuntimeError("down")], Recorder())
        assert g.check() is False and g.state == UNKNOWN

    def test_entering_active_stops_every_device_once(self):
        stops = Recorder()
        g = guard([CLEAR, ACTIVE, ACTIVE, ACTIVE], stops)
        assert g.check() is True
        assert [g.check(), g.check(), g.check()] == [False, False, False]
        assert stops.calls == ["a", "b"]

    def test_a_node_that_starts_during_an_emergency_stop_stops_its_devices(self):
        stops = Recorder()
        assert guard([ACTIVE], stops).check() is False
        assert stops.calls == ["a", "b"]

    def test_failed_stops_are_retried_until_they_get_through(self):
        stops = Recorder({"b": [(FAILED, "timeout"), (FAILED, "timeout"), (STOPPED, "ok")]})
        g = guard([ACTIVE, ACTIVE, ACTIVE, ACTIVE], stops)
        for _ in range(4):
            assert g.check() is False
        assert stops.calls == ["a", "b", "b", "b"]

    def test_a_stopper_that_raises_is_retried_and_never_escapes(self):
        calls = []

        def stopper(device):
            calls.append(device["id"])
            raise RuntimeError("boom")

        g = guard([ACTIVE, ACTIVE], stopper, devices=({"id": "a"},))
        assert g.check() is False and g.check() is False
        assert calls == ["a", "a"]

    def test_clearing_resumes_intake_and_drops_retries(self):
        stops = Recorder({"a": [(FAILED, "x")]})
        g = guard([ACTIVE, CLEAR, CLEAR], stops, devices=({"id": "a"},))
        assert g.check() is False
        assert g.check() is True and g.check() is True
        assert stops.calls == ["a"]

    def test_a_blip_during_an_emergency_stop_sends_the_stops_again(self):
        stops = Recorder()
        g = guard([ACTIVE, UNKNOWN, ACTIVE], stops, devices=({"id": "a"},))
        assert [g.check(), g.check(), g.check()] == [False, False, False]
        assert stops.calls == ["a", "a"]


class TestDaemonHonoursTheEmergencyStop:
    def test_no_job_is_taken_and_devices_are_stopped(self):
        from pcc_node import daemon as daemon_module

        reads = {"n": 0}

        def reader(*_args):
            reads["n"] += 1
            if reads["n"] > 2:
                raise KeyboardInterrupt("test done")
            return ACTIVE, "set"

        stopped = []

        with mock.patch.object(estop, "read_estop", side_effect=reader), \
             mock.patch.object(estop, "stop_device", side_effect=lambda d: stopped.append(d["id"]) or (STOPPED, "ok")), \
             mock.patch.object(daemon_module, "load_or_create_keys", return_value=("pub", "sec")), \
             mock.patch.object(daemon_module, "discover_network", return_value=[]), \
             mock.patch.object(daemon_module, "register_kernel", return_value={}), \
             mock.patch.object(daemon_module, "announce_capabilities"), \
             mock.patch.object(daemon_module, "detect_camera_device", return_value=None), \
             mock.patch("pcc_node.daemon.PCCGatewayClient") as MockClient, \
             mock.patch("pcc_node.daemon.JobExecutor") as MockExecutor, \
             mock.patch("pcc_node.daemon.start_ui_server", create=True):
            client = mock.MagicMock()
            MockClient.return_value = client
            # If the guard were bypassed, this ends the loop and the assertions
            # below fail, rather than the daemon polling forever.
            client.poll_for_jobs.side_effect = KeyboardInterrupt("poll must not be called")
            config = NodeConfig(
                kernel_id="k-test",
                kernel_name="test-node",
                pcc_base="http://pcc-test",
                pcc_api_key="test-key",
                poll_interval=0,
                devices=[{"id": "p1", "protocol": "octoprint", "host": "10.0.0.2"}],
            )
            with pytest.raises(KeyboardInterrupt):
                daemon_module.run_daemon(config)

        client.poll_for_jobs.assert_not_called()
        MockExecutor.return_value.execute.assert_not_called()
        assert stopped == ["p1"]
