"""The durable terminal-status outbox (r31 astra finding 7).

A terminal report the gateway did not acknowledge used to be logged and
dropped.  These tests pin the outbox that keeps it and retries it, and the
stricter acknowledgements it relies on: a 2xx alone is not a receipt.
"""

import json
import logging
import os
import signal
from contextlib import ExitStack
from unittest import mock

import pytest

from pcc_node.config import NodeConfig
from pcc_node.job_executor import JobExecutor
from pcc_node.outbox import StatusOutbox
from pcc_node.ws_client import PCCGatewayClient


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


def _outbox(tmp_path, clock=None, **kw):
    return StatusOutbox(str(tmp_path / "state" / "outbox.json"), clock=clock or Clock(), **kw)


# ---------------------------------------------------------------------------
# The queue
# ---------------------------------------------------------------------------

class TestStatusOutbox:
    def test_nothing_touches_disk_until_a_report_is_queued(self, tmp_path):
        box = _outbox(tmp_path)
        assert box.pending() == []
        assert box.flush(lambda *a: True) == 0
        assert not (tmp_path / "state").exists()

    def test_a_queued_report_survives_a_restart(self, tmp_path):
        clock = Clock()
        _outbox(tmp_path, clock).enqueue("job-1", "failed", {"error": "jam"})
        again = _outbox(tmp_path, clock)
        [record] = again.pending()
        assert (record["jobId"], record["status"], record["metadata"]) == ("job-1", "failed", {"error": "jam"})

    def test_due_reports_are_delivered_and_removed(self, tmp_path):
        clock = Clock()
        box = _outbox(tmp_path, clock)
        box.enqueue("job-1", "failed", {"error": "jam"})
        calls = []
        assert box.flush(lambda *a: calls.append(a) or True) == 0, "not due before the first delay"
        clock.now += 5
        assert box.flush(lambda *a: calls.append(a) or True) == 1
        assert calls == [("job-1", "failed", {"error": "jam"})]
        assert box.pending() == []
        assert _outbox(tmp_path, clock).pending() == [], "the delivery is durable too"

    def test_a_failed_retry_backs_off_exponentially_up_to_the_cap(self, tmp_path):
        clock = Clock()
        box = _outbox(tmp_path, clock, base_delay_s=5, max_delay_s=40, max_age_s=10_000)
        box.enqueue("job-1", "completed", None)
        waits = []
        for _ in range(5):
            clock.now = box.pending()[0]["nextAttemptAt"]
            before = clock.now
            box.flush(lambda *a: False)
            waits.append(box.pending()[0]["nextAttemptAt"] - before)
        assert waits == [10, 20, 40, 40, 40]
        assert box.pending()[0]["attempts"] == 5

    def test_a_report_that_raises_is_kept_for_the_next_try(self, tmp_path):
        clock = Clock()
        box = _outbox(tmp_path, clock)
        box.enqueue("job-1", "failed", None)
        clock.now += 5

        def boom(*a):
            raise RuntimeError("gateway client exploded")

        assert box.flush(boom) == 0
        assert box.pending()[0]["attempts"] == 1

    def test_an_expired_report_is_dropped_loudly_and_never_sent(self, tmp_path, caplog):
        clock = Clock()
        box = _outbox(tmp_path, clock, max_age_s=100)
        box.enqueue("job-1", "failed", None)
        clock.now += 101
        sent = []
        with caplog.at_level(logging.ERROR, logger="pcc-node.outbox"):
            box.flush(lambda *a: sent.append(a) or True)
        assert sent == []
        assert box.pending() == []
        assert "giving up" in caplog.text

    def test_only_terminal_statuses_are_queued(self, tmp_path):
        with pytest.raises(ValueError):
            _outbox(tmp_path).enqueue("job-1", "running", None)

    def test_one_report_per_job(self, tmp_path):
        box = _outbox(tmp_path)
        box.enqueue("job-1", "completed", None)
        box.enqueue("job-1", "failed", {"error": "x"})
        [record] = box.pending()
        assert record["status"] == "failed"

    def test_a_full_outbox_refuses_loudly(self, tmp_path, caplog):
        box = _outbox(tmp_path, max_records=1)
        assert box.enqueue("job-1", "failed", None) is True
        with caplog.at_level(logging.ERROR, logger="pcc-node.outbox"):
            assert box.enqueue("job-2", "failed", None) is False
        assert "NOT queued" in caplog.text

    def test_a_corrupt_file_is_set_aside_and_the_outbox_starts_empty(self, tmp_path, caplog):
        path = tmp_path / "state" / "outbox.json"
        path.parent.mkdir()
        path.write_text("{not json")
        box = StatusOutbox(str(path), clock=Clock())
        with caplog.at_level(logging.ERROR, logger="pcc-node.outbox"):
            assert box.pending() == []
        assert list(path.parent.glob("outbox.json.corrupt-*")), "the bad file is kept for a human"
        assert box.enqueue("job-1", "failed", None) is True

    def test_non_json_metadata_is_stored_as_text(self, tmp_path):
        box = _outbox(tmp_path)
        box.enqueue("job-1", "failed", {"raw": b"\x00bytes"})
        stored = json.loads((tmp_path / "state" / "outbox.json").read_text())
        assert isinstance(stored[0]["metadata"]["raw"], str)


# ---------------------------------------------------------------------------
# The executor queues what the gateway did not acknowledge
# ---------------------------------------------------------------------------

def _gateway(push_ack=True, status_ack=True):
    g = mock.Mock()
    g.push_evidence.return_value = push_ack
    g.update_job_status.side_effect = lambda job_id, status, *a, **k: True if status == "running" else status_ack
    return g


def _statuses(gateway):
    return [c.args[1] for c in gateway.update_job_status.call_args_list]


IPP_FAIL = {"submitted": False, "error": "printer on fire", "returncode": 1}
DEVICE_SUCCESS = {"executed": True, "status_code": 200, "response": {"status": "completed"}}


class TestExecutorUsesTheOutbox:
    DEVICE = {"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}

    def test_an_unacknowledged_failed_report_is_queued_then_delivered(self, tmp_path):
        clock = Clock()
        box = _outbox(tmp_path, clock)
        gateway = _gateway(status_ack=False)
        ex = JobExecutor(devices=[self.DEVICE], gateway_client=gateway, outbox=box)
        with mock.patch.object(ex, "_execute_on_device", return_value=IPP_FAIL):
            ex.execute({"id": "job-f", "capabilityType": "document-printing"})
        [record] = box.pending()
        assert (record["jobId"], record["status"]) == ("job-f", "failed")

        gateway.update_job_status.side_effect = None
        gateway.update_job_status.return_value = True
        clock.now += 5
        assert ex.flush_outbox() == 1
        assert box.pending() == []
        assert gateway.update_job_status.call_args.args[:2] == ("job-f", "failed")

    def test_success_whose_evidence_was_not_stored_is_never_reported_completed(self, tmp_path, caplog):
        # Old: execute() reported 'completed' whether or not the gateway stored
        # the evidence.  New: as for device-reported completion, no stored
        # execution_completed means no 'completed' -- the job stays running.
        gateway = _gateway(push_ack=False)
        ex = JobExecutor(devices=[self.DEVICE], gateway_client=gateway, outbox=_outbox(tmp_path))
        with mock.patch.object(ex, "_execute_on_device", return_value=DEVICE_SUCCESS), \
             caplog.at_level(logging.ERROR, logger="pcc-node.job_executor"):
            ex.execute({"id": "job-s", "capabilityType": "document-printing"})
        assert _statuses(gateway) == ["running"]
        assert "NOT reporting 'completed'" in caplog.text

    def test_an_unacknowledged_completed_report_is_queued(self, tmp_path):
        box = _outbox(tmp_path)
        gateway = _gateway(status_ack=False)
        ex = JobExecutor(devices=[self.DEVICE], gateway_client=gateway, outbox=box)
        with mock.patch.object(ex, "_execute_on_device", return_value=DEVICE_SUCCESS):
            ex.execute({"id": "job-c", "capabilityType": "document-printing"})
        [record] = box.pending()
        assert (record["jobId"], record["status"]) == ("job-c", "completed")

    def test_without_an_outbox_nothing_is_queued_or_flushed(self):
        ex = JobExecutor(devices=[self.DEVICE], gateway_client=_gateway(status_ack=False))
        assert ex.flush_outbox() == 0


# ---------------------------------------------------------------------------
# A 2xx alone is not a receipt
# ---------------------------------------------------------------------------

def _client():
    return PCCGatewayClient(gateway_url="http://pcc-test", api_key="k", kernel_id="kernel-1", poll_interval=0.1)


class TestAcknowledgementsReadTheBody:
    def test_evidence_the_relay_did_not_store_is_not_acknowledged(self):
        for body in ({"stored": False, "error": "storage_failed"}, {}, "ok"):
            with mock.patch("pcc_node.ws_client._http", return_value=(200, body)):
                assert _client().push_evidence("j1", {}) is False, body
        with mock.patch("pcc_node.ws_client._http", return_value=(200, {"stored": True})):
            assert _client().push_evidence("j1", {}) is True

    def test_a_2xx_that_did_not_record_the_status_is_not_acknowledged_and_not_forced(self):
        calls = []

        def http(method, url, **kw):
            calls.append(method)
            return 200, {"job": {"id": "j1", "status": "running"}}

        with mock.patch("pcc_node.ws_client._http", side_effect=http):
            assert _client().update_job_status("j1", "failed") is False
        assert calls == ["PATCH"], "the relay must not be used to force what PATCH declined"

    def test_the_relay_s_unknown_job_answer_is_not_acknowledged(self):
        def http(method, url, **kw):
            if method == "PATCH":
                return 404, {"error": "not_found"}
            return 200, {"updated": False, "warning": "job_not_found"}

        with mock.patch("pcc_node.ws_client._http", side_effect=http):
            assert _client().update_job_status("j1", "failed") is False


# ---------------------------------------------------------------------------
# The daemon flushes the outbox every cycle, and survives its errors
# ---------------------------------------------------------------------------

class TestDaemonFlushesTheOutbox:
    @pytest.fixture(autouse=True)
    def _restore_signal_handlers(self):
        saved = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
        yield
        for s, handler in saved.items():
            signal.signal(s, handler)

    def test_called_every_cycle_and_an_exception_does_not_stop_the_loop(self, tmp_path, caplog):
        from pcc_node import daemon as daemon_module

        with ExitStack() as stack:
            for target, kwargs in (
                ("load_or_create_keys", {"return_value": ("pub", "sec")}),
                ("discover_network", {"return_value": []}),
                ("register_kernel", {"return_value": {}}),
                ("announce_capabilities", {}),
                ("detect_camera_device", {"return_value": None}),
                ("_write_pid", {}),
                ("_remove_pid", {}),
                ("_write_state", {}),
            ):
                stack.enter_context(mock.patch.object(daemon_module, target, **kwargs))
            stack.enter_context(mock.patch("pcc_node.ui_server.start_ui_server"))
            stack.enter_context(mock.patch.object(daemon_module, "OUTBOX_FILE", str(tmp_path / "outbox.json")))
            client = stack.enter_context(mock.patch("pcc_node.daemon.PCCGatewayClient")).return_value
            executor = stack.enter_context(mock.patch("pcc_node.daemon.JobExecutor")).return_value
            client.poll_for_jobs.side_effect = [[], [], KeyboardInterrupt("stop")]
            executor.flush_outbox.side_effect = [RuntimeError("outbox exploded"), 0, 0]
            config = NodeConfig(kernel_id="k-out", kernel_name="n", pcc_base="http://pcc-test",
                                pcc_api_key="key", poll_interval=0, devices=[])
            with caplog.at_level(logging.ERROR, logger="pcc-node.daemon"), pytest.raises(KeyboardInterrupt):
                daemon_module.run_daemon(config)

        assert executor.flush_outbox.call_count == 3
        assert client.poll_for_jobs.call_count == 3
        assert "outbox exploded" in caplog.text
