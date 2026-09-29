"""Accepted jobs survive a daemon restart (r31 round-1 dependency: "a restart
can strand a running job").

JobExecutor(awaiting_store=...) stores each accepted job (public fields only)
and a new executor on the same store resumes observing it.  Invariants:
exactly one terminal report across restarts; a stale, orphaned or unsafe
record is dropped WITHOUT a status; a device secret never goes to a printer
the configured device no longer serves.

Only IPP is tracked (r31 round-2 findings 2 and 3; see
pcc_node.awaiting_store.AWAITING_KINDS): an OctoPrint print is
acceptance-only and gets no completion handle, so it is never registered,
and a record left over from before the withdrawal (kind "octoprint") is
malformed now and is dropped on load.

As in tests/test_completion_pollers.py and tests/test_r31_round3.py, only
pcc_node.http_util.urlopen (and pcc_node.job_executor.execute_ipp_print, for
the initial ``lp`` acceptance) is faked -- the store, the poller and
execute() all run for real underneath.  Each test file in this suite keeps
its own self-contained copies of these fakes.
"""

import json
from unittest import mock

import pytest

from pcc_node.awaiting_store import AwaitingStore
from pcc_node.job_executor import (
    EVENT_EXECUTION_COMPLETED,
    JobExecutor,
)

FAKE_DEVICE_KEY = "FAKE-IPP-DEVICE-KEY-0000"  # obviously fake: proves a device
                                               # secret never reaches the store
IPP_DEVICE = {"id": "p1", "protocol": "ipp", "host": "10.0.0.1", "apiKey": FAKE_DEVICE_KEY}
JOB = {"id": "job-r1", "capabilityType": "document-printing", "parameters": {}}
IPP_HANDLE = {"printer_ip": "10.0.0.1", "queue": "default", "cupsJobId": 42}
# What execute_ipp_print returns when `lp -h 10.0.0.1 -d default` exits 0.
IPP_ACCEPTED_RESULT = {
    "submitted": True,
    "filepath": "/tmp/pcc-print.txt",
    "returncode": 0,
    "stdout": "request id is default-42 (1 file(s))",
    "stderr": "",
    "printer_ip": "10.0.0.1",
    "printer_name": "",
}

OP_DEVICE = {"id": "op1", "protocol": "octoprint", "url": "http://10.0.0.20:5000"}


class Clock:
    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now


def _ipp_attr(value_tag, name, value):
    """RFC 8010 sec 3.1.4 / 3.1.5, written out by hand: tag, name-length,
    name, value-length, value."""
    return (
        bytes([value_tag])
        + len(name).to_bytes(2, "big") + name
        + len(value).to_bytes(2, "big") + value
    )


def ipp_response(job_state=9, reasons=("job-completed-successfully",), request_id=1, job_id=42):
    """A minimal, well-formed Get-Job-Attributes response naming job-id,
    job-state and job-state-reasons (mirrors tests/test_completion_pollers.py
    and tests/test_r31_round3.py's own copies of this builder)."""
    out = b"\x02\x00" + (0).to_bytes(2, "big") + request_id.to_bytes(4, "big", signed=True)
    out += b"\x01"
    out += _ipp_attr(0x47, b"attributes-charset", b"utf-8")
    out += _ipp_attr(0x48, b"attributes-natural-language", b"en")
    out += b"\x02"
    out += _ipp_attr(0x21, b"job-id", job_id.to_bytes(4, "big", signed=True))
    out += _ipp_attr(0x23, b"job-state", job_state.to_bytes(4, "big", signed=True))
    for i, reason in enumerate(reasons):
        name = b"job-state-reasons" if i == 0 else b""
        out += _ipp_attr(0x44, name, reason.encode("utf-8"))
    return out + b"\x03"


class _RawResponse:
    """urlopen stand-in: context manager + bounded read + status."""

    def __init__(self, status, raw):
        self.status = status
        self._raw = raw if isinstance(raw, bytes) else str(raw).encode("utf-8")

    def read(self, amt=-1):
        return self._raw if amt is None or amt < 0 else self._raw[:amt]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeIppPrinter:
    """urlopen stand-in for an IPP printer: echoes the request-id it was
    sent (RFC 8011 sec 4.1.1) and always answers about job-id 42 (matching
    IPP_HANDLE)."""

    def __init__(self, state=9, reasons=("job-completed-successfully",)):
        self.state = state
        self.reasons = reasons
        self.requests = []

    def __call__(self, req, *a, **k):
        self.requests.append(req)
        request_id = int.from_bytes(req.data[4:8], "big", signed=True)
        return _RawResponse(200, ipp_response(
            job_state=self.state, reasons=self.reasons, request_id=request_id, job_id=42,
        ))


def _poll(ex, fake):
    with mock.patch("pcc_node.http_util.urlopen", side_effect=fake):
        ex.poll_awaiting()


def _gateway():
    g = mock.Mock()
    g.update_job_status.return_value = True
    g.push_evidence.return_value = True
    return g


def _statuses(gateway):
    return [call[0][1] for call in gateway.update_job_status.call_args_list]


def _executor(store, gateway, clock, wall, devices=(IPP_DEVICE,)):
    return JobExecutor(devices=list(devices), gateway_client=gateway, clock=clock,
                       awaiting_store=store, wall_clock=wall)


@pytest.fixture
def store(tmp_path):
    return AwaitingStore(str(tmp_path / "awaiting.json"))


def _accept(store, result=IPP_ACCEPTED_RESULT):
    gateway, clock, wall = _gateway(), Clock(100.0), Clock(1_000_000.0)
    ex = _executor(store, gateway, clock, wall)
    with mock.patch("pcc_node.job_executor.execute_ipp_print", return_value=result):
        ex.execute(dict(JOB))
    return ex, gateway, clock, wall


def test_an_accepted_job_is_stored_with_public_fields_only(store):
    ex, gateway, clock, wall = _accept(store)
    assert _statuses(gateway) == ["running"]
    [record] = store.records()
    assert record["jobId"] == "job-r1"
    assert record["deviceId"] == "p1"
    assert record["kind"] == "ipp"
    assert record["handle"] == IPP_HANDLE
    assert record["deadline"] > record["acceptedAt"] == 1_000_000.0
    assert FAKE_DEVICE_KEY not in json.dumps(record)
    assert FAKE_DEVICE_KEY not in open(store.path, encoding="utf-8").read()


def test_a_restarted_executor_resumes_and_reports_exactly_once(store):
    _accept(store)

    # The daemon restarts: a new executor, the same store, a new monotonic clock.
    gateway2, clock2, wall2 = _gateway(), Clock(5.0), Clock(1_000_100.0)
    ex2 = _executor(store, gateway2, clock2, wall2)
    assert "job-r1" in ex2.awaiting_completion()

    printer = FakeIppPrinter(state=9, reasons=("job-completed-successfully",))
    _poll(ex2, printer)
    _poll(ex2, printer)  # the printer keeps saying completed: nothing reported twice
    assert _statuses(gateway2) == ["completed"]
    [(_, bundle), _kw] = gateway2.push_evidence.call_args_list[0]
    assert [e["type"] for e in bundle["events"]] == [EVENT_EXECUTION_COMPLETED]
    assert store.records() == []

    # A third start restores nothing: never a second report.
    ex3 = _executor(store, _gateway(), Clock(1.0), Clock(1_000_200.0))
    assert ex3.awaiting_completion() == {}


def test_the_resumed_poll_goes_only_to_the_devices_own_printer(store):
    _accept(store)
    ex2 = _executor(store, _gateway(), Clock(5.0), Clock(1_000_100.0))
    printer = FakeIppPrinter(state=5)  # still processing: the URL is what's under test
    _poll(ex2, printer)
    assert printer.requests and all(
        req.full_url == "http://10.0.0.1:631/printers/default" for req in printer.requests
    )


def test_a_device_whose_printer_host_changed_is_never_polled_and_is_dropped(store, caplog):
    _accept(store)
    moved = {**IPP_DEVICE, "host": "10.0.0.99"}
    gateway2 = _gateway()
    ex2 = _executor(store, gateway2, Clock(5.0), Clock(1_000_100.0), devices=(moved,))
    assert ex2.awaiting_completion() == {}

    def _never_called(*a, **k):
        raise AssertionError("a device whose printer host changed must never be polled")

    with mock.patch("pcc_node.http_util.urlopen", side_effect=_never_called):
        ex2.poll_awaiting()
    assert _statuses(gateway2) == []
    assert store.records() == []
    assert "not resuming" in caplog.text


def test_a_device_no_longer_configured_is_dropped_without_a_status(store, caplog):
    _accept(store)
    gateway2 = _gateway()
    ex2 = _executor(store, gateway2, Clock(5.0), Clock(1_000_100.0), devices=())
    assert ex2.awaiting_completion() == {}
    assert _statuses(gateway2) == []
    assert store.records() == []
    assert "no longer configured" in caplog.text


def test_a_budget_that_ran_out_while_down_is_dropped_without_a_status(store, caplog):
    _accept(store)
    [record] = store.records()
    gateway2 = _gateway()
    ex2 = _executor(store, gateway2, Clock(5.0), Clock(record["deadline"] + 1))
    assert ex2.awaiting_completion() == {}
    assert _statuses(gateway2) == []
    assert "ran out while the daemon was down" in caplog.text


def test_a_record_that_cannot_be_removed_is_not_reported_until_the_restart(store):
    ex, gateway, clock, wall = _accept(store)
    printer = FakeIppPrinter(state=9, reasons=("job-completed-successfully",))
    with mock.patch("pcc_node.http_util.urlopen", side_effect=printer), \
         mock.patch.object(store, "remove", side_effect=OSError("disk full")):
        ex.poll_awaiting()
    # Not reported now: a restart will restore it, and one report must remain.
    assert _statuses(gateway) == ["running"]
    gateway.push_evidence.assert_called_once()  # only the acceptance evidence
    assert ex.awaiting_completion() == {}

    gateway2 = _gateway()
    ex2 = _executor(store, gateway2, Clock(5.0), Clock(1_000_100.0))
    _poll(ex2, printer)
    assert _statuses(gateway2) == ["completed"]
    assert store.records() == []


def test_a_job_that_cannot_be_stored_is_still_tracked_in_memory(store, caplog):
    gateway, clock, wall = _gateway(), Clock(100.0), Clock(1_000_000.0)
    ex = _executor(store, gateway, clock, wall)
    with mock.patch("pcc_node.job_executor.execute_ipp_print", return_value=IPP_ACCEPTED_RESULT), \
         mock.patch.object(store, "put", side_effect=OSError("read-only")):
        ex.execute(dict(JOB))
    assert "job-r1" in ex.awaiting_completion()
    assert "tracked in memory only" in caplog.text
    printer = FakeIppPrinter(state=9, reasons=("job-completed-successfully",))
    _poll(ex, printer)
    assert _statuses(gateway) == ["running", "completed"]


def test_without_a_store_nothing_touches_disk(tmp_path):
    ex = JobExecutor(devices=[IPP_DEVICE], gateway_client=_gateway(), clock=Clock(1.0))
    with mock.patch("pcc_node.job_executor.execute_ipp_print", return_value=IPP_ACCEPTED_RESULT):
        ex.execute(dict(JOB))
    assert "job-r1" in ex.awaiting_completion()
    assert list(tmp_path.iterdir()) == []


def test_a_stored_octoprint_record_is_dropped_on_load(store, caplog):
    """kind: "octoprint" was a valid AWAITING_KINDS value before r31 round-2
    withdrew OctoPrint completion tracking; a record left over from before
    that withdrawal is malformed now and must never be restored."""
    old_record = {
        "jobId": "job-old",
        "binding": {"jobId": "job-old"},
        "deviceId": "op1",
        "kind": "octoprint",
        "handle": {"base_url": "http://10.0.0.20:5000", "path": "pcc-job-old/part.gcode",
                   "baseline": {"success": 0, "failure": 0}},
        "acceptedAt": 1_000_000.0,
        "deadline": 1_003_600.0,
    }
    with open(store.path, "w", encoding="utf-8") as fh:
        json.dump([old_record], fh)
    ex = JobExecutor(devices=[OP_DEVICE], gateway_client=_gateway(), clock=Clock(1.0),
                     awaiting_store=store, wall_clock=Clock(1_000_100.0))
    assert ex.awaiting_completion() == {}
    assert store.records() == []
    assert "malformed" in caplog.text


def test_an_octoprint_acceptance_is_never_stored(store):
    """OctoPrint's REST API names no print attempt a later answer could bind
    to (r31 round-2 findings 2 and 3), so a select+print it accepts gets no
    completion handle at all: nothing is ever written to the registry."""
    gateway = _gateway()
    ex = JobExecutor(devices=[OP_DEVICE], gateway_client=gateway, clock=Clock(1.0),
                     awaiting_store=store, wall_clock=Clock(1_000_000.0))
    fake = lambda req, *a, **k: _RawResponse(200, json.dumps({}))
    with mock.patch("pcc_node.http_util.urlopen", side_effect=fake):
        ex.execute({"id": "job-op", "capabilityType": "3d-print",
                    "parameters": {"filename": "part.gcode"}})
    assert _statuses(gateway) == ["running"]
    assert ex.awaiting_completion() == {}
    assert store.records() == []


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


def test_a_stored_handle_is_valid_only_as_an_ipp_handle_for_the_same_printer():
    """_valid_stored_handle directly (the store already refuses a non-IPP
    record on load; this pins the executor's own check as a second line)."""
    from pcc_node.job_executor import _valid_stored_handle

    assert _valid_stored_handle("ipp", dict(IPP_HANDLE), IPP_DEVICE) is True
    assert _valid_stored_handle("octoprint", dict(IPP_HANDLE), IPP_DEVICE) is False
    assert _valid_stored_handle("ipp", {**IPP_HANDLE, "printer_ip": "10.0.0.2"}, IPP_DEVICE) is False
    assert _valid_stored_handle("ipp", {**IPP_HANDLE, "cupsJobId": True}, IPP_DEVICE) is False
    assert _valid_stored_handle("ipp", {**IPP_HANDLE, "queue": ""}, IPP_DEVICE) is False
