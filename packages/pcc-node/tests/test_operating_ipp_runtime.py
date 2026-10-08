"""IppPrintRuntime: a print counts as done only when the printer reports THIS job completed.

The runtime half of the port of #377 (fix/pcc-node-completion-pollers @67875cd1) onto master's run
path. #377's registry tests (TestIppCompletionTracking, the finding-2 and finding-5 end-to-end cases,
TestH4EndToEndThroughPollAwaiting) become the follow tests here: completed exactly once and only
from our job-id's state 9, failures and unobservable outcomes never completed, an answer that lands
after the deadline discarded even when it says completed, each status request capped. The run's
claim, lease and evidence are master's (AdapterRuntime's), so those are tested the way
test_operating_runtime.py and test_operating_jobport.py test them.

Nothing here reaches a real printer or gateway: the printer is a ThreadingHTTPServer on 127.0.0.1
speaking IPP, or an injected transport.
"""

import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

nacl_signing = pytest.importorskip("nacl.signing")

from pcc_node import log_capture
from pcc_node.log_capture import LogSigningRefused, compute_entry_hash
from pcc_node.operating.commitment import record_commitment
from pcc_node.operating.ipp import decode_ipp_response, encode_print_job
from pcc_node.operating.ipp_runtime import (
    MAX_DOCUMENT_BYTES,
    POLL_REQUEST_TIMEOUT_S,
    IppPrintRuntime,
    post_ipp,
)
from pcc_node.operating.jobport import ClaimedJob, GatewayJobPort
from pcc_node.operating.runtime import BindingError, _Abort, _Answer

KERNEL = "kernel_bench"
OPERATION = "print_document"


def _keys():
    sk = nacl_signing.SigningKey.generate()
    return sk.verify_key.encode().hex(), sk.encode().hex()


class Claim:
    """The claim a run belongs to: job, kernel, token, and a lease a test can end."""

    def __init__(self, job_id="j-print-1"):
        self.job_id, self.kernel_id, self.claim_token = job_id, KERNEL, f"tok-{job_id}"
        self.alive = True

    def lease_alive(self):
        return self.alive


# ---------------------------------------------------------------------------
# IPP answers, written out from RFC 8010 (independent of the module under test)
# ---------------------------------------------------------------------------

def ipp_attr(value_tag, name, value):
    return bytes([value_tag]) + len(name).to_bytes(2, "big") + name + len(value).to_bytes(2, "big") + value


def answer(request_id, groups=(), status=0x0000):
    return (
        b"\x02\x00" + status.to_bytes(2, "big") + request_id.to_bytes(4, "big", signed=True)
        + b"\x01" + ipp_attr(0x47, b"attributes-charset", b"utf-8")
        + ipp_attr(0x48, b"attributes-natural-language", b"en")
        + b"".join(groups) + b"\x03"
    )


def job_group(job_id, state=3, reasons=("none",)):
    out = b"\x02" + ipp_attr(0x21, b"job-id", job_id.to_bytes(4, "big", signed=True))
    out += ipp_attr(0x23, b"job-state", state.to_bytes(4, "big", signed=True))
    for i, reason in enumerate(reasons):
        out += ipp_attr(0x44, b"job-state-reasons" if i == 0 else b"", reason.encode())
    return out


def printer_group(state):
    return b"\x04" + ipp_attr(0x23, b"printer-state", state.to_bytes(4, "big", signed=True))


class FakePrinter:
    """An IPP printer on 127.0.0.1: Print-Job creates job ``job_id``; Get-Job-Attributes answers the
    scripted ``states`` in turn (the last one repeats); Get-Printer-Attributes answers
    ``printer_state``. Each script entry is ``(state, reasons)``, or a callable ``(request_id) ->
    (http_status, body)``. ``on_poll`` runs before each Get-Job-Attributes answer."""

    def __init__(self, states=((9, ("job-completed-successfully",)),), job_id=77, echo_job_id=None,
                 print_answer=None, printer_state=3, on_poll=None):
        self.requests = []
        self.states = list(states)
        self.job_id = job_id
        self.echo_job_id = job_id if echo_job_id is None else echo_job_id
        self.print_answer = print_answer
        self.printer_state = printer_state
        self.on_poll = on_poll
        printer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                printer.requests.append((self.path, self.headers.get("Content-Type"), body))
                code, raw = printer.answer(body)
                self.send_response(code)
                self.send_header("Content-Type", "application/ipp")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def answer(self, body):
        operation = int.from_bytes(body[2:4], "big")
        request_id = int.from_bytes(body[4:8], "big", signed=True)
        if operation == 0x0002:
            if self.print_answer is not None:
                return self.print_answer(request_id)
            return 200, answer(request_id, [job_group(self.job_id, state=3)])
        if operation == 0x0009:
            if self.on_poll is not None:
                self.on_poll()
            entry = self.states.pop(0) if len(self.states) > 1 else self.states[0]
            if callable(entry):
                return entry(request_id)
            state, reasons = entry
            return 200, answer(request_id, [job_group(self.echo_job_id, state, reasons)])
        if operation == 0x000B:
            return 200, answer(request_id, [printer_group(self.printer_state)])
        return 200, answer(request_id, status=0x0501)

    def operations(self):
        return [int.from_bytes(body[2:4], "big") for _, _, body in self.requests]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def printer():
    p = FakePrinter()
    yield p
    p.close()


def _profile(url, **op_overrides):
    op = {"document": "{text}", "documentFormat": "text/plain", "jobName": "pcc-node",
          "poll": {"intervalS": 0.01, "timeoutS": 5}}
    op.update(op_overrides)
    return {"url": url, "path": "/printers/office", "operations": {OPERATION: op}}


def _runtime(url, **kwargs):
    pub, sec = _keys()
    return IppPrintRuntime.from_profile(_profile(url), pub, sec, **kwargs), pub, sec


def _fast(url, timeout_s=0.3, **kwargs):
    pub, sec = _keys()
    profile = _profile(url, poll={"intervalS": 0.01, "timeoutS": timeout_s})
    return IppPrintRuntime.from_profile(profile, pub, sec, **kwargs)


# ---------------------------------------------------------------------------
# The profile, the key and the claim (AdapterRuntime's contract)
# ---------------------------------------------------------------------------

class TestSigningIsMandatory:
    def test_no_pynacl_means_no_runtime(self, printer, monkeypatch):
        pub, sec = _keys()
        monkeypatch.setattr(log_capture, "_HAS_NACL", False)
        with pytest.raises(LogSigningRefused):
            IppPrintRuntime.from_profile(_profile(printer.url), pub, sec)


class TestTheProfileIsCheckedAtLoad:
    @pytest.mark.parametrize("change", [
        pytest.param({"url": "http://10.0.0.5"}, id="url-without-a-port"),
        pytest.param({"url": "ipp://10.0.0.5:631"}, id="url-not-http"),
        pytest.param({"url": "http://u:p@10.0.0.5:631"}, id="url-with-credentials"),
        pytest.param({"path": "printers/office"}, id="path-not-absolute"),
        pytest.param({"path": "/printers/../admin"}, id="path-traversal"),
        pytest.param({"path": "/printers/office?x=1"}, id="path-with-a-query"),
        pytest.param({"path": None}, id="no-path"),
        pytest.param({"operations": {}}, id="no-operations"),
    ])
    def test_an_unsafe_device_is_refused(self, change):
        pub, sec = _keys()
        profile = _profile("http://10.0.0.5:631")
        profile.update(change)
        with pytest.raises(BindingError):
            IppPrintRuntime.from_profile(profile, pub, sec)

    @pytest.mark.parametrize("op", [
        pytest.param({"document": "text"}, id="document-not-a-slot"),
        pytest.param({"document": "{a} {b}"}, id="document-two-slots"),
        pytest.param({"document": None}, id="no-document"),
        pytest.param({"documentFormat": "application/pdf"}, id="pdf-cannot-be-text"),
        pytest.param({"documentFormat": ["text/plain"]}, id="format-not-a-string"),
        pytest.param({"jobName": ""}, id="empty-job-name"),
        pytest.param({"jobName": "a\nb"}, id="job-name-control-character"),
        pytest.param({"jobName": "x" * 256}, id="job-name-too-long"),
        pytest.param({"jobName": 7}, id="job-name-not-a-string"),
        pytest.param({"poll": {"intervalS": 0}}, id="zero-interval"),
        pytest.param({"poll": {"intervalS": 61}}, id="interval-over-60s"),
        pytest.param({"poll": {"timeoutS": 86401}}, id="timeout-over-a-day"),
        pytest.param({"poll": {"timeoutS": "60"}}, id="timeout-a-string"),
        pytest.param({"poll": {"timeoutS": True}}, id="timeout-a-bool"),
        pytest.param({"poll": {"timeoutS": float("nan")}}, id="timeout-nan"),
        pytest.param({"poll": "fast"}, id="poll-not-an-object"),
    ])
    def test_an_unsafe_operation_is_refused(self, op):
        pub, sec = _keys()
        with pytest.raises(BindingError):
            IppPrintRuntime.from_profile(_profile("http://10.0.0.5:631", **op), pub, sec)

    def test_the_printer_uri_follows_rfc_8010_sec_5(self):
        pub, sec = _keys()
        plain = IppPrintRuntime.from_profile(_profile("http://10.0.0.5:631"), pub, sec)
        assert plain.printer_uri == "ipp://10.0.0.5:631/printers/office"
        tls = IppPrintRuntime.from_profile(_profile("https://printer.lan:443"), pub, sec)
        assert tls.printer_uri == "ipps://printer.lan:443/printers/office"


class TestTheRunBelongsToItsClaim:
    def test_no_claim_means_nothing_is_sent(self, printer):
        runtime, _, _ = _runtime(printer.url)
        assert runtime.run(OPERATION, {"text": "hi"}, claim=None).error == "no_claim"
        assert printer.requests == []

    def test_a_dead_lease_means_nothing_is_sent(self, printer):
        runtime, _, _ = _runtime(printer.url)
        claim = Claim()
        claim.alive = False
        assert runtime.run(OPERATION, {"text": "hi"}, claim=claim).error == "lease_lost:not_started"
        assert printer.requests == []

    def test_a_cancel_before_the_run_means_nothing_is_sent(self, printer):
        runtime, _, _ = _runtime(printer.url)
        runtime.cancel()
        assert runtime.run(OPERATION, {"text": "hi"}, claim=Claim()).error == "cancelled:not_started"
        assert printer.requests == []

    def test_an_unknown_operation_is_refused(self, printer):
        runtime, _, _ = _runtime(printer.url)
        assert runtime.run("print_photo", {"text": "hi"}, claim=Claim()).error == "unknown_operation:print_photo"
        assert printer.requests == []

    def test_a_lease_lost_while_following_stops_the_run_with_the_printer_state_unknown(self):
        claim = Claim()

        def end_lease():
            claim.alive = False

        printer = FakePrinter(states=((5, ("job-printing",)),), on_poll=end_lease)
        try:
            runtime, _, _ = _runtime(printer.url)
            result = runtime.run(OPERATION, {"text": "hi"}, claim=claim)
        finally:
            printer.close()
        assert result.ok is False
        assert result.error == "lease_lost:device_state_unknown"
        assert printer.operations() == [0x0002, 0x0009]   # no request after the lease was lost
        assert result.evidence is not None and result.evidence["runId"] == "77"


# ---------------------------------------------------------------------------
# A job never chooses the request
# ---------------------------------------------------------------------------

class TestAJobNeverChoosesTheRequest:
    def test_only_the_document_comes_from_the_job(self, printer):
        runtime, _, _ = _runtime(printer.url)
        params = {"text": "Hello, printer\n", "method": "DELETE", "path": "/admin", "url": "http://evil:1",
                  "printer-uri": "ipp://evil/x", "jobName": "x", "documentFormat": "application/pdf"}
        result = runtime.run(OPERATION, params, claim=Claim())
        assert result.ok is True, result
        path, content_type, body = printer.requests[0]
        assert (path, content_type) == ("/printers/office", "application/ipp")
        request_id = int.from_bytes(body[4:8], "big", signed=True)
        assert body == encode_print_job(runtime.printer_uri, request_id, b"Hello, printer\n",
                                        document_format="text/plain", job_name="pcc-node")
        assert all(p == "/printers/office" for p, _, _ in printer.requests)

    def test_a_missing_document_sends_nothing(self, printer):
        runtime, _, _ = _runtime(printer.url)
        assert runtime.run(OPERATION, {"content": "hi"}, claim=Claim()).error == "param_missing:text"
        assert printer.requests == []

    @pytest.mark.parametrize("value", [
        pytest.param(42, id="int"), pytest.param(b"bytes", id="bytes"), pytest.param(None, id="none"),
        pytest.param({"text": "x"}, id="object"), pytest.param(chr(0xD800) + " lone surrogate", id="not-utf8-encodable"),
    ])
    def test_a_document_that_is_not_text_sends_nothing(self, printer, value):
        runtime, _, _ = _runtime(printer.url)
        assert runtime.run(OPERATION, {"text": value}, claim=Claim()).error == "param_not_text:not_started"
        assert printer.requests == []

    def test_a_document_over_the_cap_sends_nothing(self, printer):
        runtime, _, _ = _runtime(printer.url)
        result = runtime.run(OPERATION, {"text": "x" * (MAX_DOCUMENT_BYTES + 1)}, claim=Claim())
        assert result.error == "param_too_large:not_started"
        assert printer.requests == []


# ---------------------------------------------------------------------------
# Completion: only the printer's own state for the job it created
# ---------------------------------------------------------------------------

class TestCompletionComesOnlyFromThePrintersOwnState:
    def test_a_print_completes_when_the_printer_reports_its_job_completed(self):
        printer = FakePrinter(states=((3, ("none",)), (5, ("job-printing",)), (9, ("job-completed-successfully",))))
        try:
            runtime, _, _ = _runtime(printer.url)
            result = runtime.run(OPERATION, {"text": "hi"}, claim=Claim())
        finally:
            printer.close()
        assert result.ok is True and result.error is None
        assert printer.operations() == [0x0002, 0x0009, 0x0009, 0x0009]   # one Print-Job, then its job
        for _, _, body in printer.requests[1:]:
            decoded = decode_ipp_response(body)
            [group] = decoded["groups"]
            job_id = [a for a in group["attributes"] if a["name"] == "job-id"][0]["values"]
            assert job_id == [(0x21, (77).to_bytes(4, "big"))]   # always the job the printer created
        record = result.output
        assert record["ippJobId"] == 77 and record["verdict"] == "completed"
        assert record["observation"]["jobState"] == "completed"
        assert record["submitted"]["reportedJobId"] == 77
        assert "jobId" not in record   # LO-EV-9 keeps jobId for the PCC job

    def test_the_print_job_answer_is_acceptance_never_completion(self):
        """Even a Print-Job answer that already says job-state 9 is not read: only Get-Job-Attributes is."""
        printer = FakePrinter(
            states=((5, ("job-printing",)),),
            print_answer=lambda rid: (200, answer(rid, [job_group(77, 9, ("job-completed-successfully",))])),
        )
        try:
            runtime = _fast(printer.url)
            result = runtime.run(OPERATION, {"text": "hi"}, claim=Claim())
        finally:
            printer.close()
        assert result.ok is False
        assert result.error == "timeout:device_state_unknown"
        assert result.output["verdict"] == "waiting"

    @pytest.mark.parametrize("state,reasons,error", [
        pytest.param(7, ("job-canceled-by-user",), "run_failed", id="canceled"),
        pytest.param(8, ("aborted-by-system",), "run_failed", id="aborted"),
        pytest.param(9, ("job-completed-with-errors",), "run_failed", id="completed-with-errors"),
        pytest.param(9, ("queued-in-device",), "outcome_unobservable:device_state_unknown", id="queued-in-device"),
        pytest.param(9, ("job-completed-with-warnings",), "outcome_unobservable:device_state_unknown",
                     id="with-warnings"),
        pytest.param(9, ("none", "job-completed-successfully"), "outcome_unobservable:device_state_unknown",
                     id="none-beside-another-reason"),
    ])
    def test_anything_but_a_clean_completion_is_never_a_success(self, state, reasons, error):
        printer = FakePrinter(states=((state, reasons),))
        try:
            runtime, _, _ = _runtime(printer.url)
            result = runtime.run(OPERATION, {"text": "hi"}, claim=Claim())
        finally:
            printer.close()
        assert result.ok is False
        assert result.error == error
        assert result.evidence is not None   # a failure is signed too, so it can be disputed

    @pytest.mark.parametrize("entry", [
        pytest.param(lambda rid: (200, answer(rid, [job_group(78, 9, ("none",))])), id="another-jobs-id"),
        pytest.param(lambda rid: (200, answer(rid + 1, [job_group(77, 9, ("none",))])), id="another-request-id"),
        pytest.param(lambda rid: (200, answer(rid, [job_group(77, 9, ("none",))], status=0x0406)), id="error-status"),
        pytest.param(lambda rid: (503, answer(rid, [job_group(77, 9, ("none",))])), id="http-503"),
        pytest.param(lambda rid: (200, answer(rid, [job_group(77, 9, ())])), id="no-reasons"),
        pytest.param(lambda rid: (200, b"\x02\x00\x00"), id="truncated"),
    ])
    def test_an_answer_not_proven_to_be_about_our_job_never_completes(self, entry):
        printer = FakePrinter(states=(entry,))
        try:
            runtime = _fast(printer.url)
            result = runtime.run(OPERATION, {"text": "hi"}, claim=Claim())
        finally:
            printer.close()
        assert result.ok is False
        assert result.error == "timeout:device_state_unknown"
        assert printer.operations().count(0x0002) == 1

    def test_the_print_is_submitted_once_whatever_the_polls_say(self):
        printer = FakePrinter(states=(
            lambda rid: (500, b""), lambda rid: (200, b"garbage"), (5, ("job-printing",)),
            (9, ("job-completed-successfully",)),
        ))
        try:
            runtime, _, _ = _runtime(printer.url)
            result = runtime.run(OPERATION, {"text": "hi"}, claim=Claim())
        finally:
            printer.close()
        assert result.ok is True
        assert printer.operations() == [0x0002, 0x0009, 0x0009, 0x0009, 0x0009]


class TestStartFailures:
    def test_an_unreachable_printer_was_never_sent_anything(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
        port = server.server_port
        server.server_close()   # nothing listens on this port now
        runtime, _, _ = _runtime(f"http://127.0.0.1:{port}")
        assert runtime.run(OPERATION, {"text": "hi"}, claim=Claim()).error == "device_unreachable"

    @pytest.mark.parametrize("print_answer,error", [
        pytest.param(lambda rid: (500, b""), "device_error:500:device_state_unknown", id="http-500"),
        pytest.param(lambda rid: (200, answer(rid, [job_group(77)], status=0x040A)),
                     "ipp_error:0x040a:device_state_unknown", id="document-format-not-supported"),
        pytest.param(lambda rid: (200, answer(rid, [])), "no_run_id:device_state_unknown", id="no-job-id"),
        pytest.param(lambda rid: (200, answer(rid + 1, [job_group(77)])), "no_run_id:device_state_unknown",
                     id="another-request-id"),
    ])
    def test_a_print_job_answer_that_names_no_job_of_ours(self, print_answer, error):
        printer = FakePrinter(print_answer=print_answer)
        try:
            runtime, _, _ = _runtime(printer.url)
            result = runtime.run(OPERATION, {"text": "hi"}, claim=Claim())
        finally:
            printer.close()
        assert result.ok is False and result.error == error
        assert printer.operations() == [0x0002]   # nothing to follow, and never resent

    @pytest.mark.parametrize("raised,error", [
        pytest.param(_Abort("timeout", True), "timeout:device_state_unknown", id="sent-then-timed-out"),
        pytest.param(_Abort("cancelled", False), "cancelled:not_started", id="cancelled-before-sending"),
        pytest.param(RuntimeError("boom"), "internal_error:device_state_unknown", id="unexpected-error"),
    ])
    def test_a_print_job_that_stops(self, raised, error):
        def post(url, payload, **kwargs):
            raise raised

        runtime = _fast("http://127.0.0.1:9", post=post)
        assert runtime.run(OPERATION, {"text": "hi"}, claim=Claim()).error == error

    def test_a_connection_lost_after_sending(self):
        runtime = _fast("http://127.0.0.1:9", post=lambda url, payload, **kwargs: _Answer(0, None, True))
        assert runtime.run(OPERATION, {"text": "hi"}, claim=Claim()).error == "connection_lost:device_state_unknown"


# ---------------------------------------------------------------------------
# Deadlines: each status request is capped, and a late answer is discarded (#377 round-1 finding 5)
# ---------------------------------------------------------------------------

class FakeClock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class ScriptedPrinter:
    """An injected transport: Print-Job creates job 77; each Get-Job-Attributes runs the next step."""

    def __init__(self, steps):
        self.steps = list(steps)
        self.deadlines = []

    def __call__(self, url, payload, *, deadline, clock, stop=None):
        request_id = int.from_bytes(payload[4:8], "big", signed=True)
        if int.from_bytes(payload[2:4], "big") == 0x0002:
            return _Answer(200, answer(request_id, [job_group(77)]), True)
        self.deadlines.append((clock(), deadline))
        step = self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]
        return step(request_id, clock)


def completed(request_id, clock):
    return _Answer(200, answer(request_id, [job_group(77, 9, ("job-completed-successfully",))]), True)


def failed(request_id, clock):
    return _Answer(200, answer(request_id, [job_group(77, 8, ("aborted-by-system",))]), True)


def processing(request_id, clock):
    return _Answer(200, answer(request_id, [job_group(77, 5, ("job-printing",))]), True)


def _scripted(steps, timeout_s=60.0, interval_s=5.0):
    clock = FakeClock()
    pub, sec = _keys()
    script = ScriptedPrinter(steps)
    profile = _profile("http://10.0.0.5:631", poll={"intervalS": interval_s, "timeoutS": timeout_s})
    runtime = IppPrintRuntime.from_profile(profile, pub, sec, clock=clock, sleep=clock.sleep, post=script)
    return runtime, script, clock


class TestDeadlines:
    def test_each_status_request_is_capped_and_never_outlives_the_run(self):
        runtime, script, clock = _scripted([processing, processing, completed], timeout_s=12.0, interval_s=5.0)
        result = runtime.run(OPERATION, {"text": "hi"}, claim=Claim())
        assert result.ok is True
        run_deadline = 1000.0 + 12.0
        caps = [deadline - asked_at for asked_at, deadline in script.deadlines]
        assert caps[0] == POLL_REQUEST_TIMEOUT_S        # 10 s while the run has more than that left
        assert script.deadlines[-1][1] == run_deadline   # and never past the run's own deadline
        assert all(deadline <= run_deadline for _, deadline in script.deadlines)

    def test_a_status_request_that_times_out_on_its_own_is_asked_again(self):
        def stalls(request_id, clock):
            raise _Abort("timeout", True)

        runtime, script, _ = _scripted([stalls, completed])
        assert runtime.run(OPERATION, {"text": "hi"}, claim=Claim()).ok is True

    def test_an_answer_too_large_to_read_is_not_an_answer(self):
        def too_large(request_id, clock):
            raise _Abort("device_response_too_large", True)

        runtime, _, _ = _scripted([too_large, completed])
        assert runtime.run(OPERATION, {"text": "hi"}, claim=Claim()).ok is True

    def test_a_completion_that_arrives_after_the_deadline_is_discarded(self):
        def late_completion(request_id, clock):
            clock.now = 1000.0 + 60.0   # the answer lands as the run's deadline passes
            return completed(request_id, clock)

        runtime, _, _ = _scripted([late_completion])
        result = runtime.run(OPERATION, {"text": "hi"}, claim=Claim())
        assert result.ok is False
        assert result.error == "timeout:run_finished"
        assert result.output["verdict"] == "completed"   # recorded, signed, and still not a success

    @pytest.mark.parametrize("step,error", [
        pytest.param(completed, "lease_lost:run_finished", id="completed"),
        pytest.param(failed, "lease_lost:run_finished", id="failed"),
        pytest.param(processing, "lease_lost:device_state_unknown", id="still-printing"),
    ])
    def test_an_answer_that_arrives_after_the_lease_was_lost_is_discarded(self, step, error):
        claim = Claim()

        def lease_ends_in_flight(request_id, clock):
            claim.alive = False
            return step(request_id, clock)

        runtime, _, _ = _scripted([lease_ends_in_flight])
        result = runtime.run(OPERATION, {"text": "hi"}, claim=claim)
        assert result.ok is False and result.error == error

    def test_a_cancel_while_following_stops_the_run(self):
        runtime, _, _ = _scripted([processing])

        def cancel_in_flight(request_id, clock):
            runtime.cancel()
            return processing(request_id, clock)

        runtime._post.steps = [cancel_in_flight]
        result = runtime.run(OPERATION, {"text": "hi"}, claim=Claim())
        assert result.ok is False and result.error == "cancelled:device_state_unknown"

    def test_a_printer_that_never_finishes_runs_out_of_time(self):
        runtime, script, clock = _scripted([processing], timeout_s=30.0, interval_s=5.0)
        result = runtime.run(OPERATION, {"text": "hi"}, claim=Claim())
        assert result.ok is False and result.error == "timeout:device_state_unknown"
        assert clock.now <= 1000.0 + 30.0 + 1.0
        assert 5 <= len(script.deadlines) <= 7   # about one request per interval, not a flood


# ---------------------------------------------------------------------------
# Evidence: the node's signed record, committed to the claim, accepted by the job port as it is
# ---------------------------------------------------------------------------

class TestEvidence:
    def test_the_evidence_is_the_signed_record_of_this_claims_print(self):
        runtime, pub, sec = _runtime("http://10.0.0.5:631")
        runtime._post = ScriptedPrinter([completed])
        claim = Claim()
        result = runtime.run(OPERATION, {"text": "hi"}, claim=claim)
        evidence = result.evidence
        assert set(evidence) == {"operation", "runId", "record", "logChain", "signer"}
        assert evidence["operation"] == OPERATION and evidence["runId"] == "77"
        assert evidence["record"] == result.output and evidence["signer"] == "0x" + pub
        [entry] = evidence["logChain"]
        payload = entry["payload"]
        assert payload["rawContent"] == record_commitment(claim.claim_token, claim.job_id, KERNEL, OPERATION,
                                                          result.output, "77")
        assert payload["entryHash"] == compute_entry_hash(payload["rawContent"], payload["source"], payload["capturedAt"])
        nacl_signing.VerifyKey(bytes.fromhex(pub)).verify(payload["entryHash"].encode(),
                                                          bytes.fromhex(payload["kernelSignature"]["value"]))

    def _port(self, pub, sec, stored):
        def request(method, path, body=None, **kwargs):
            stored.append((method, path, body))
            return 200, {"stored": True, "jobId": body["jobId"]}

        return GatewayJobPort("http://gw.test:4310", "k-operator", KERNEL, {"document-printing": OPERATION},
                              pub, sec, request=request)

    def test_the_job_port_signs_and_posts_it_unchanged(self):
        runtime, pub, sec = _runtime("http://10.0.0.5:631")
        runtime._post = ScriptedPrinter([completed])
        claim = Claim()
        result = runtime.run(OPERATION, {"text": "hi"}, claim=claim)
        stored = []
        port = self._port(pub, sec, stored)
        job = ClaimedJob(job_id=claim.job_id, operation=OPERATION, capability_type="document-printing",
                         claim_token=claim.claim_token, kernel_id=KERNEL)
        assert port.report(job, result.evidence).stored is True
        [(_, path, body)] = stored
        assert path == "/api/operator/evidence" and body["jobId"] == claim.job_id
        assert body["evidence"]["bundle"]["runId"] == "77"

    def test_evidence_made_under_another_claim_is_refused_by_the_job_port(self):
        runtime, pub, sec = _runtime("http://10.0.0.5:631")
        runtime._post = ScriptedPrinter([completed])
        result = runtime.run(OPERATION, {"text": "hi"}, claim=Claim("j-print-1"))
        stored = []
        port = self._port(pub, sec, stored)
        other = ClaimedJob(job_id="j-print-2", operation=OPERATION, capability_type="document-printing",
                           claim_token="tok-j-print-2", kernel_id=KERNEL)
        ack = port.report(other, result.evidence)
        assert ack.stored is False and ack.reason == "evidence_invalid:record_not_committed"
        assert stored == []


# ---------------------------------------------------------------------------
# is_idle, and the transport itself
# ---------------------------------------------------------------------------

class TestIdle:
    @pytest.mark.parametrize("state,idle", [(3, True), (4, False), (5, False)])
    def test_only_printer_state_idle_is_idle(self, state, idle):
        printer = FakePrinter(printer_state=state)
        try:
            runtime, _, _ = _runtime(printer.url)
            assert runtime.is_idle() is idle
        finally:
            printer.close()
        assert printer.operations() == [0x000B]

    def test_an_unreachable_printer_is_not_idle(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
        port = server.server_port
        server.server_close()
        runtime, _, _ = _runtime(f"http://127.0.0.1:{port}")
        assert runtime.is_idle() is False


class _RawServer:
    """A server whose handler the test writes: for the transport's size and time bounds."""

    def __init__(self, handle):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                handle(self)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/printers/office"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class TestTransport:
    def test_an_answer_over_the_cap_is_refused(self):
        def huge(handler):
            handler.send_response(200)
            handler.end_headers()
            try:
                handler.wfile.write(b"\x00" * ((1 << 20) + 1024))
            except OSError:
                pass   # the node hangs up once the answer passes its cap

        server = _RawServer(huge)
        try:
            with pytest.raises(_Abort) as stopped:
                post_ipp(server.url, b"x", deadline=time.monotonic() + 5, clock=time.monotonic)
        finally:
            server.close()
        assert (stopped.value.reason, stopped.value.sent) == ("device_response_too_large", True)

    def test_a_printer_that_never_answers_is_cut_off_at_the_deadline(self):
        release = threading.Event()

        def silent(handler):
            release.wait(5)

        server = _RawServer(silent)
        try:
            began = time.monotonic()
            with pytest.raises(_Abort) as stopped:
                post_ipp(server.url, b"x", deadline=began + 0.3, clock=time.monotonic)
            took = time.monotonic() - began
        finally:
            release.set()
            server.close()
        assert (stopped.value.reason, stopped.value.sent) == ("timeout", True)
        assert took < 2.0

    def test_a_stop_cuts_off_a_request_in_flight(self):
        release = threading.Event()
        flag = {"reason": None}

        def silent(handler):
            flag["reason"] = "lease_lost"   # the lease ends while the printer holds the answer
            release.wait(5)

        server = _RawServer(silent)
        try:
            with pytest.raises(_Abort) as stopped:
                post_ipp(server.url, b"x", deadline=time.monotonic() + 5, clock=time.monotonic,
                         stop=lambda: flag["reason"])
        finally:
            release.set()
            server.close()
        assert (stopped.value.reason, stopped.value.sent) == ("lease_lost", True)

    def test_the_body_and_headers_arrive_as_sent(self):
        seen = {}

        def capture(handler):
            seen["type"] = handler.headers.get("Content-Type")
            seen["length"] = handler.headers.get("Content-Length")
            handler.send_response(200)
            handler.end_headers()
            handler.wfile.write(b"\x02\x00\x00\x00\x00\x00\x00\x01\x03")

        server = _RawServer(capture)
        try:
            got = post_ipp(server.url, b"\x00\x01\x02\xff", deadline=time.monotonic() + 5, clock=time.monotonic)
        finally:
            server.close()
        assert (got.status, got.body, got.sent) == (200, b"\x02\x00\x00\x00\x00\x00\x00\x01\x03", True)
        assert seen == {"type": "application/ipp", "length": "4"}
