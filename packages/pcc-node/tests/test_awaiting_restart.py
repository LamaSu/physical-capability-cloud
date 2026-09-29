"""Accepted jobs survive a daemon restart (r31 round-1 dependency: "a restart
can strand a running job").

JobExecutor(awaiting_store=...) stores each accepted job (public fields only)
and a new executor on the same store resumes observing it.  Invariants:
exactly one terminal report across restarts; a stale, orphaned or unsafe
record is dropped WITHOUT a status; an OctoPrint API key never goes to a URL
the configured device no longer serves.
"""

import json
from unittest import mock

import pytest

from pcc_node.awaiting_store import AwaitingStore
from pcc_node.job_executor import (
    COMPLETION_POLL_MIN_INTERVAL_S,
    EVENT_EXECUTION_COMPLETED,
    JobExecutor,
)

OP_KEY = "SECRET-OCTOPRINT-KEY-9876"
BASE = "http://10.0.0.20:5000"
OP_DEVICE = {"id": "op1", "protocol": "octoprint", "url": BASE, "api_key": OP_KEY}
JOB = {"id": "job-r1", "capabilityType": "3d-print", "parameters": {"filename": "part.gcode"}}
COPY = "pcc-job-r1/part.gcode"


class Clock:
    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now


class FakeOctoPrint:
    """Answers the adapter's four acceptance requests and the history polls."""

    def __init__(self):
        self.success = 0
        self.failure = 0
        self.requests = []

    def form(self, method, url, fields, headers=None, **kwargs):
        self.requests.append((method, url, dict(headers or {})))
        return 201, {"done": True}

    def http(self, method, url, body=None, headers=None, **kwargs):
        self.requests.append((method, url, dict(headers or {})))
        if method == "GET":
            path = url.split("/api/files/local/", 1)[1]
            answer = {"name": path.rsplit("/", 1)[-1], "path": path, "origin": "local"}
            if self.success or self.failure:
                answer["prints"] = {"success": self.success, "failure": self.failure,
                                    "last": {"success": self.failure == 0, "date": 1}}
            return 200, answer
        if isinstance(body, dict) and body.get("command") == "copy":
            return 201, {"done": True}
        if isinstance(body, dict) and body.get("command") == "select":
            return 204, ""
        return 404, {"error": "unexpected request"}


def _gateway():
    g = mock.Mock()
    g.update_job_status.return_value = True
    g.push_evidence.return_value = True
    return g


def _statuses(gateway):
    return [call[0][1] for call in gateway.update_job_status.call_args_list]


def _patched(fake):
    return (mock.patch("pcc_node.http_util.http", side_effect=fake.http),
            mock.patch("pcc_node.http_util.http_form", side_effect=fake.form))


def _executor(store, gateway, clock, wall, devices=(OP_DEVICE,)):
    return JobExecutor(devices=list(devices), gateway_client=gateway, clock=clock,
                       awaiting_store=store, wall_clock=wall)


@pytest.fixture
def store(tmp_path):
    return AwaitingStore(str(tmp_path / "awaiting.json"))


def _accept(store, fake):
    gateway, clock, wall = _gateway(), Clock(100.0), Clock(1_000_000.0)
    ex = _executor(store, gateway, clock, wall)
    http_patch, form_patch = _patched(fake)
    with http_patch, form_patch:
        ex.execute(dict(JOB))
    return ex, gateway, clock, wall


def test_an_accepted_job_is_stored_with_public_fields_only(store):
    fake = FakeOctoPrint()
    ex, gateway, clock, wall = _accept(store, fake)
    assert _statuses(gateway) == ["running"]
    [record] = store.records()
    assert record["jobId"] == "job-r1"
    assert record["deviceId"] == "op1"
    assert record["kind"] == "octoprint"
    assert record["handle"] == {"base_url": BASE, "path": COPY, "baseline": {"success": 0, "failure": 0}}
    assert record["deadline"] > record["acceptedAt"] == 1_000_000.0
    assert OP_KEY not in json.dumps(record)
    assert OP_KEY not in open(store.path, encoding="utf-8").read()


def test_a_restarted_executor_resumes_and_reports_exactly_once(store):
    fake = FakeOctoPrint()
    _accept(store, fake)

    # The daemon restarts: a new executor, the same store, a new monotonic clock.
    gateway2, clock2, wall2 = _gateway(), Clock(5.0), Clock(1_000_100.0)
    ex2 = _executor(store, gateway2, clock2, wall2)
    assert "job-r1" in ex2.awaiting_completion()

    fake.success = 1  # OctoPrint recorded PrintDone for our copy
    http_patch, form_patch = _patched(fake)
    with http_patch, form_patch:
        ex2.poll_awaiting()
        clock2.now += COMPLETION_POLL_MIN_INTERVAL_S
        ex2.poll_awaiting()
    assert _statuses(gateway2) == ["completed"]
    [(_, bundle), _kw] = gateway2.push_evidence.call_args_list[0]
    assert [e["type"] for e in bundle["events"]] == [EVENT_EXECUTION_COMPLETED]
    assert store.records() == []

    # A third start restores nothing: never a second report.
    ex3 = _executor(store, _gateway(), Clock(1.0), Clock(1_000_200.0))
    assert ex3.awaiting_completion() == {}


def test_the_resumed_poll_sends_the_key_only_to_the_devices_own_url(store):
    fake = FakeOctoPrint()
    _accept(store, fake)
    fake.requests.clear()
    ex2 = _executor(store, _gateway(), Clock(5.0), Clock(1_000_100.0))
    http_patch, form_patch = _patched(fake)
    with http_patch, form_patch:
        ex2.poll_awaiting()
    assert fake.requests and all(url.startswith(BASE + "/") for _, url, _ in fake.requests)


def test_a_device_whose_url_changed_is_never_polled_and_is_dropped(store, caplog):
    fake = FakeOctoPrint()
    _accept(store, fake)
    fake.requests.clear()
    moved = {**OP_DEVICE, "url": "http://10.0.0.99:5000"}
    gateway2 = _gateway()
    ex2 = _executor(store, gateway2, Clock(5.0), Clock(1_000_100.0), devices=(moved,))
    http_patch, form_patch = _patched(fake)
    with http_patch, form_patch:
        ex2.poll_awaiting()
    assert ex2.awaiting_completion() == {}
    assert fake.requests == [], "the API key must never go to a URL the device no longer serves"
    assert _statuses(gateway2) == []
    assert store.records() == []
    assert "not resuming" in caplog.text


def test_a_device_no_longer_configured_is_dropped_without_a_status(store, caplog):
    _accept(store, FakeOctoPrint())
    gateway2 = _gateway()
    ex2 = _executor(store, gateway2, Clock(5.0), Clock(1_000_100.0), devices=())
    assert ex2.awaiting_completion() == {}
    assert _statuses(gateway2) == []
    assert store.records() == []
    assert "no longer configured" in caplog.text


def test_a_budget_that_ran_out_while_down_is_dropped_without_a_status(store, caplog):
    _accept(store, FakeOctoPrint())
    [record] = store.records()
    gateway2 = _gateway()
    ex2 = _executor(store, gateway2, Clock(5.0), Clock(record["deadline"] + 1))
    assert ex2.awaiting_completion() == {}
    assert _statuses(gateway2) == []
    assert "ran out while the daemon was down" in caplog.text


def test_a_record_that_cannot_be_removed_is_not_reported_until_the_restart(store):
    fake = FakeOctoPrint()
    ex, gateway, clock, wall = _accept(store, fake)
    fake.success = 1
    http_patch, form_patch = _patched(fake)
    with http_patch, form_patch, mock.patch.object(store, "remove", side_effect=OSError("disk full")):
        ex.poll_awaiting()
    # Not reported now: a restart will restore it, and one report must remain.
    assert _statuses(gateway) == ["running"]
    gateway.push_evidence.assert_called_once()  # only the acceptance evidence
    assert ex.awaiting_completion() == {}

    gateway2 = _gateway()
    ex2 = _executor(store, gateway2, Clock(5.0), Clock(1_000_100.0))
    with http_patch, form_patch:
        ex2.poll_awaiting()
    assert _statuses(gateway2) == ["completed"]
    assert store.records() == []


def test_a_job_that_cannot_be_stored_is_still_tracked_in_memory(store, caplog):
    fake = FakeOctoPrint()
    gateway, clock, wall = _gateway(), Clock(100.0), Clock(1_000_000.0)
    ex = _executor(store, gateway, clock, wall)
    http_patch, form_patch = _patched(fake)
    with http_patch, form_patch, mock.patch.object(store, "put", side_effect=OSError("read-only")):
        ex.execute(dict(JOB))
    assert "job-r1" in ex.awaiting_completion()
    assert "tracked in memory only" in caplog.text
    fake.success = 1
    with http_patch, form_patch:
        ex.poll_awaiting()
    assert _statuses(gateway) == ["running", "completed"]


def test_without_a_store_nothing_touches_disk(tmp_path):
    fake = FakeOctoPrint()
    ex = JobExecutor(devices=[OP_DEVICE], gateway_client=_gateway(), clock=Clock(1.0))
    http_patch, form_patch = _patched(fake)
    with http_patch, form_patch:
        ex.execute(dict(JOB))
    assert "job-r1" in ex.awaiting_completion()
    assert list(tmp_path.iterdir()) == []


def test_an_ipp_job_survives_a_restart(store, tmp_path):
    """IPP handles carry no credential, and resume the same way."""
    ipp_device = {"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}
    job = {"id": "job-ipp", "capabilityType": "document-printing",
           "parameters": {"content": "x", "filename": "x.txt"}}
    gateway, clock, wall = _gateway(), Clock(100.0), Clock(1_000_000.0)
    ex = JobExecutor(devices=[ipp_device], gateway_client=gateway, clock=clock,
                     awaiting_store=store, wall_clock=wall)
    with mock.patch("subprocess.run") as run, mock.patch("platform.system", return_value="Linux"):
        run.return_value = mock.Mock(returncode=0, stdout="request id is default-42 (1 file(s))", stderr="")
        bundle = ex.execute(job)
    spool = bundle.get("result", {}).get("filepath")
    if spool:
        import os
        if os.path.exists(spool):
            os.unlink(spool)
    [record] = store.records()
    assert record["kind"] == "ipp"
    assert record["handle"] == {"printer_ip": "10.0.0.1", "queue": "default", "cupsJobId": 42}
    ex2 = JobExecutor(devices=[ipp_device], gateway_client=_gateway(), clock=Clock(5.0),
                      awaiting_store=store, wall_clock=Clock(1_000_100.0))
    assert "job-ipp" in ex2.awaiting_completion()
