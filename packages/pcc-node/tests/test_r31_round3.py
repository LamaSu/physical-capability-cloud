"""Round-3 adversarial tests against the r31-pccnode-r3-astra DO-NOT-SHIP verdict.

Source: /mnt/sparkbulk/pcc-reconciliation/review-packs-for-chatgpt-20260924/
        42-r31-pccnode-r3-astra-63663616.astra.verdict.md

Covers the verdict's three remaining findings, closed this round by removing
mechanisms rather than patching them further:

  C1  = generic HTTP: a "completion contract" could still mean only
        acceptance.  CLOSED by removing the contract mechanism entirely --
        device['completionContract'] is now silently ignored, and generic
        HTTP never completes, full stop, whatever the body or device config
        say.
  H4  = IPP job-state-reasons: nonempty ASCII was accepted where strict
        RFC 8011 sec 5.1.4 keyword syntax is required, and only a narrow
        allowlist of reasons may read job-state 9 as a clean completion.
  C2/C3 = OctoPrint: an error-bearing baseline read could be admitted as a
        valid zero baseline, and cumulative/inherited file history could
        stand in for THIS print.  CLOSED by removing OctoPrint completion
        tracking entirely -- it is acceptance-only, forever: no later
        request is ever made, so there is no baseline and no history left to
        spoof.

Only pcc_node.http_util's urlopen is faked (directly, as an attribute on the
http_util module) -- the adapters, the poller, the IPP codec, the
classifier, the evidence builder and execute()/poll_awaiting() all run for
real underneath, matching the pattern in test_job_executor.py (generic HTTP
/ OctoPrint: `_RawResponse` + `mock.patch("pcc_node.http_util.urlopen", ...)`)
and test_completion_pollers.py (IPP: a raw IPP response builder + FakeClock +
a gateway Mock whose push_evidence/update_job_status calls are asserted on).
"""

import json
import logging
from unittest import mock
from urllib.error import URLError

import pytest

from pcc_node.job_executor import (
    JobExecutor,
    classify_execution_result,
    octoprint_file_path,
    ipp_completion_verdict,
    RESULT_SUCCESS,
    RESULT_ACCEPTED,
    RESULT_FAILURE,
    EVENT_EXECUTION_COMPLETED,
    EVENT_EXECUTION_PROGRESS,
    EVIDENCE_LEVEL_SUBMITTED,
    POLL_COMPLETED,
    POLL_FAILED,
    POLL_WAITING,
    POLL_UNOBSERVABLE,
    COMPLETION_POLL_MIN_INTERVAL_S,
)

EXECUTOR_LOGGER = "pcc-node.job-executor"


# ---------------------------------------------------------------------------
# Shared fakes (mirrors test_job_executor.py / test_completion_pollers.py --
# each test file in this suite keeps its own self-contained copies)
# ---------------------------------------------------------------------------

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


def _json_body(payload):
    return json.dumps(payload)


class FakeClock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def _gateway():
    g = mock.Mock()
    g.push_evidence.return_value = True
    g.update_job_status.return_value = True
    return g


def _statuses(gateway):
    return [c.args[1] for c in gateway.update_job_status.call_args_list]


def _bundles(gateway):
    return [c.args[1] for c in gateway.push_evidence.call_args_list]


def _types(bundle):
    return [e["type"] for e in bundle["events"]]


def _never_called(*a, **k):
    raise AssertionError(f"the fake http layer was called: args={a!r} kwargs={k!r}")


# ---------------------------------------------------------------------------
# C1: generic HTTP -- a "completion contract" still meant only acceptance
# ---------------------------------------------------------------------------

def _gh_device(contract=None, **extra):
    device = {"id": "g1", "protocol": "generic", "url": "http://10.0.0.9", **extra}
    if contract is not None:
        device["completionContract"] = contract
    return device


def _gh_adapter(device, status, raw, job=None, job_id="job-gh"):
    """Call the adapter directly -- no gateway, no execute() -- for the pure
    classify_execution_result-level checks."""
    job = job or {"id": job_id, "parameters": {"path": "/execute"}}
    ex = JobExecutor(devices=[])
    with mock.patch("pcc_node.http_util.urlopen",
                    side_effect=lambda req, *a, **k: _RawResponse(status, raw)):
        return ex._execute_generic_http(device, job)


def _gh_execute_job(device, status, raw, job_id="job-123", path="/run", method="POST",
                     gateway=None, clock=None):
    """Drive the full execute() path -- job status + evidence + awaiting
    registry -- for the end-to-end "the contract grants nothing" checks."""
    gateway = gateway or _gateway()
    clock = clock or FakeClock()
    ex = JobExecutor(devices=[device], gateway_client=gateway, clock=clock)
    job = {"id": job_id, "capabilityType": "generic",
           "parameters": {"path": path, "method": method}}
    with mock.patch("pcc_node.http_util.urlopen",
                    side_effect=lambda req, *a, **k: _RawResponse(status, raw)):
        bundle = ex.execute(job)
    return ex, gateway, clock, bundle


VERDICT_CONTRACT = {
    "version": 1, "method": "POST", "path": "/run",
    "completionField": "ok", "completionValues": [True],
    "correlationField": "jobId",
}


class TestC1TheVerdictsExactContractGrantsNothing:
    """The verdict's own reproduction: {"version":1,"method":"POST",
    "path":"/run","completionField":"ok","completionValues":[true],
    "correlationField":"jobId"} in device config, with the device
    truthfully acknowledging receipt as {"ok": true, "jobId": "<this job>"}.
    device['completionContract'] is now silently ignored, so this never
    completes -- whatever field/value/type the (dead) contract names."""

    @pytest.mark.parametrize("contract,raw", [
        pytest.param(VERDICT_CONTRACT, _json_body({"ok": True, "jobId": "job-123"}),
                     id="verdicts-exact-contract-bool-true"),
        pytest.param({**VERDICT_CONTRACT, "completionValues": [0]},
                     _json_body({"code": 0, "jobId": "job-123"}), id="integer-completion-value-0"),
        pytest.param({**VERDICT_CONTRACT, "completionValues": [200]},
                     _json_body({"code": 200, "jobId": "job-123"}), id="integer-completion-value-200"),
        pytest.param({**VERDICT_CONTRACT, "completionValues": [1]},
                     _json_body({"code": 1, "jobId": "job-123"}), id="integer-completion-value-1"),
    ])
    def test_never_completes_stays_accepted(self, contract, raw):
        device = _gh_device(contract=contract)
        ex, gateway, clock, bundle = _gh_execute_job(device, 200, raw)

        assert EVENT_EXECUTION_COMPLETED not in _types(bundle)
        assert "execution_completed" not in json.dumps(bundle, default=str)
        assert _statuses(gateway) == ["running"]
        assert ex.awaiting_completion() == {}
        result = bundle["result"]
        assert result["submitted"] is True
        assert classify_execution_result(result) == RESULT_ACCEPTED


class TestC1CompletionStatingBodiesStayAccepted:
    """Bodies that explicitly SAY the work finished are still just acceptance
    -- no field of a generic device's body can establish that (r31 round-2
    finding 1); nothing here ever reaches RESULT_SUCCESS."""

    GH_DEVICE = _gh_device()

    @pytest.mark.parametrize("status,raw", [
        pytest.param(200, _json_body({"status": "completed"}), id="status-completed"),
        pytest.param(200, _json_body({"completed": True}), id="completed-true"),
        pytest.param(200, _json_body({"result": {"phase": "finished", "jobId": "job-gh"}}),
                     id="nested-phase-finished"),
        pytest.param(200, _json_body({"done": True, "jobId": "job-gh"}), id="done-true"),
        pytest.param(201, _json_body({"status": "succeeded"}), id="201-succeeded"),
    ])
    def test_never_success(self, status, raw):
        result = _gh_adapter(self.GH_DEVICE, status, raw,
                             job={"id": "job-gh", "parameters": {"path": "/execute"}})
        assert result["submitted"] is True
        assert classify_execution_result(result) == RESULT_ACCEPTED


class TestC1AcceptanceStatusCodes:
    GH_DEVICE = _gh_device()

    @pytest.mark.parametrize("status", [202, 204])
    def test_202_and_204_are_accepted_with_an_empty_body(self, status):
        result = _gh_adapter(self.GH_DEVICE, status, "")
        assert result["submitted"] is True
        assert classify_execution_result(result) == RESULT_ACCEPTED


def _nested_body(depth):
    body = {"leaf": "ok"}
    for _ in range(depth):
        body = {"next": body}
    return body


SOAP_FAULT = (
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
    "<soap:Body><soap:Fault><faultcode>soap:Server</faultcode>"
    "<faultstring>actuator jammed</faultstring>"
    "</soap:Fault></soap:Body></soap:Envelope>"
)


class TestC1FailuresStayFailures:
    """A device-stated failure, a transport failure, and a body too large or
    too deep to verify are all still failures -- none of that changed."""

    GH_DEVICE = _gh_device()

    @pytest.mark.parametrize("status,raw", [
        pytest.param(200, _json_body({"error": "x"}), id="error-key"),
        pytest.param(200, _json_body({"ok": False}), id="ok-false"),
        pytest.param(200, _json_body({"status": "failed"}), id="status-failed"),
        pytest.param(200, _json_body({"result": [{"error": "jam"}]}), id="error-in-list"),
        pytest.param(200, SOAP_FAULT, id="soap-fault"),
        pytest.param(200, _json_body({f"f{i}": i for i in range(6000)}), id="flat-6000-keys"),
        pytest.param(200, _json_body(_nested_body(9)), id="nested-9-deep"),
        pytest.param(500, _json_body({}), id="http-500"),
        pytest.param(302, "", id="http-302-redirect"),
    ])
    def test_stays_a_failure(self, status, raw):
        result = _gh_adapter(self.GH_DEVICE, status, raw)
        assert result["submitted"] is False
        assert result["error"]
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_transport_failure_stays_a_failure(self):
        ex = JobExecutor(devices=[])
        with mock.patch("pcc_node.http_util.urlopen",
                        side_effect=URLError("[Errno 111] Connection refused")):
            result = ex._execute_generic_http(
                self.GH_DEVICE, {"id": "job-gh", "parameters": {"path": "/execute"}}
            )
        assert result["status_code"] == 0
        assert result["submitted"] is False
        assert classify_execution_result(result) == RESULT_FAILURE

    @pytest.mark.parametrize("status,raw", [
        pytest.param(200, _json_body({"error": "x"}), id="error-key-end-to-end"),
        pytest.param(500, _json_body({}), id="http-500-end-to-end"),
    ])
    def test_stays_a_failure_end_to_end(self, status, raw):
        device = _gh_device()
        ex, gateway, clock, bundle = _gh_execute_job(device, status, raw)
        assert _statuses(gateway) == ["running", "failed"]
        assert classify_execution_result(bundle["result"]) == RESULT_FAILURE


class TestC1AnUnreadableOutcomeIsNotAnAcceptance:
    """Lane review of this round: "any clean 2xx is acceptance" would record a
    device that answers 200 {"status": "rejected"} as having TAKEN the
    request -- a false statement.  An outcome the node cannot read as
    acceptance (a status/state word outside GENERIC_ACCEPTANCE_WORDS, or an
    acceptance/completion flag that is not True) carries no flag, so it is
    unclassifiable and the job fails closed; a readable one stays accepted."""

    GH_DEVICE = _gh_device()

    @pytest.mark.parametrize("raw", [
        pytest.param(_json_body({"status": "rejected"}), id="rejected"),
        pytest.param(_json_body({"status": "jammed"}), id="jammed"),
        pytest.param(_json_body({"state": "denied"}), id="state-denied"),
        pytest.param(_json_body({"data": {"result": {"status": "invalid"}}}), id="nested-status"),
        pytest.param(_json_body({"items": [{"state": "queued"}, {"state": "refused"}]}), id="one-bad-item-in-a-list"),
        pytest.param(_json_body({"status": ["queued", "jammed"]}), id="status-list-with-an-unknown-word"),
        pytest.param(_json_body({"status": None}), id="null-status"),
        pytest.param(_json_body({"status": 3}), id="numeric-status"),
        pytest.param(_json_body({"accepted": False}), id="accepted-false"),
        pytest.param(_json_body({"submitted": "no"}), id="submitted-no"),
        pytest.param(_json_body({"result": {"done": 0}}), id="nested-done-zero"),
        pytest.param(_json_body({"completed": None}), id="completed-null"),
    ])
    def test_fails_closed_end_to_end(self, raw):
        result = _gh_adapter(self.GH_DEVICE, 200, raw)
        assert "submitted" not in result and "executed" not in result, result
        assert result["outcome"] == "unrecognized"
        assert classify_execution_result(result) not in (RESULT_SUCCESS, RESULT_ACCEPTED)
        ex, gateway, clock, bundle = _gh_execute_job(_gh_device(), 200, raw)
        assert _statuses(gateway) == ["running", "failed"]
        assert EVENT_EXECUTION_COMPLETED not in _types(bundle)
        assert EVENT_EXECUTION_PROGRESS not in _types(bundle)  # never recorded as a submission
        assert ex.awaiting_completion() == {}

    @pytest.mark.parametrize("raw", [
        pytest.param(_json_body({"status": "queued"}), id="queued"),
        pytest.param(_json_body({"status": " Completed "}), id="completed-any-case-and-space"),
        pytest.param(_json_body({"status": "ok", "state": "running"}), id="ok-and-running"),
        pytest.param(_json_body({"data": {"state": "in-progress"}, "done": True}), id="nested-and-flag"),
        pytest.param(_json_body({"status": []}), id="empty-status-list"),
        pytest.param(_json_body({"jobId": "job-123", "message": "rejected words elsewhere are not statements"}), id="no-status-key"),
        pytest.param(_json_body({"submitted": True, "accepted": True}), id="true-flags"),
    ])
    def test_a_readable_statement_stays_accepted(self, raw):
        result = _gh_adapter(self.GH_DEVICE, 200, raw)
        assert result["submitted"] is True, result
        assert classify_execution_result(result) == RESULT_ACCEPTED
        ex, gateway, clock, bundle = _gh_execute_job(_gh_device(), 200, raw)
        assert _statuses(gateway) == ["running"]
        assert EVENT_EXECUTION_COMPLETED not in _types(bundle)


class TestC1PathRefusal:
    """The job's path must be an absolute, clean path on the device -- else
    nothing is sent at all and the job fails."""

    GH_DEVICE = _gh_device()

    @pytest.mark.parametrize("path", [
        pytest.param("@evil.example/x", id="not-absolute-host-like"),
        pytest.param("//evil.example/x", id="protocol-relative-another-host"),
        pytest.param("x", id="no-leading-slash"),
        pytest.param("/a b", id="embedded-space"),
        pytest.param("/a\\b", id="backslash"),
        pytest.param("/a\n", id="embedded-newline"),
        pytest.param("/a\t", id="embedded-tab"),
        pytest.param("/a\x7f", id="embedded-del"),
        pytest.param(None, id="none"),
        pytest.param(5, id="int"),
        pytest.param(["/x"], id="list"),
    ])
    def test_refused_with_nothing_sent_and_the_job_fails(self, path):
        gateway = _gateway()
        ex = JobExecutor(devices=[self.GH_DEVICE], gateway_client=gateway)
        job = {"id": "job-path", "capabilityType": "generic", "parameters": {"path": path}}
        with mock.patch("pcc_node.http_util.urlopen", side_effect=_never_called):
            bundle = ex.execute(job)

        assert _statuses(gateway) == ["running", "failed"]
        assert classify_execution_result(bundle["result"]) == RESULT_FAILURE
        assert bundle["result"]["submitted"] is False


class TestC1PropertyStyleNeverSuccess:
    """A grab-bag of ~30 varied 2xx bodies (acceptance words, receipts,
    opaque envelopes, nesting, empty/null): classify_execution_result never
    reaches RESULT_SUCCESS for any of them -- generic HTTP has no path to
    success at all any more."""

    GH_DEVICE = _gh_device()

    BODIES = [
        {},
        {"ok": True},
        {"success": True},
        {"status": "completed"},
        {"status": "succeeded"},
        {"status": "done"},
        {"completed": True},
        {"done": True},
        {"finished": True},
        {"result": "ok"},
        {"result": {"phase": "finished"}},
        {"jobId": "abc"},
        {"job_id": "abc"},
        {"message": "ok"},
        {"data": {}},
        {"data": None},
        {"code": 200},
        {"code": "OK"},
        {"outcome": "completed"},
        {"state": "completed"},
        {"state": "FINISHED"},
        {"phase": "done"},
        {"value": True},
        {"payload": {"status": "completed"}},
        {"nested": {"deep": {"status": "completed"}}},
        {"list": ["completed"]},
        {"status": "completed", "extra": 1},
        {"a": 1, "b": 2, "c": 3},
        {"": ""},
        {"status": None},
    ]

    def test_no_2xx_body_is_ever_a_success(self):
        assert len(self.BODIES) >= 29, "the property list shrank below the ~30 the brief asked for"
        for body in self.BODIES:
            result = _gh_adapter(self.GH_DEVICE, 200, _json_body(body))
            assert classify_execution_result(result) != RESULT_SUCCESS, (body, result)


class TestC1CorrelationHeaderAlwaysSent:
    def test_header_equals_the_job_id(self):
        device = _gh_device()
        seen = {}

        def fake(req, *a, **k):
            seen["headers"] = {k.lower(): v for k, v in req.header_items()}
            return _RawResponse(200, _json_body({}))

        ex = JobExecutor(devices=[])
        with mock.patch("pcc_node.http_util.urlopen", side_effect=fake):
            ex._execute_generic_http(device, {"id": "job-hdr-1", "parameters": {"path": "/execute"}})

        assert seen["headers"]["x-pcc-job-id"] == "job-hdr-1"


# ---------------------------------------------------------------------------
# H4: IPP job-state-reasons -- strict keyword syntax + a narrow allowlist
# ---------------------------------------------------------------------------

def _ipp_attr(value_tag, name, value):
    return (
        bytes([value_tag])
        + len(name).to_bytes(2, "big") + name
        + len(value).to_bytes(2, "big") + value
    )


def ipp_response(job_state=9, reasons=("none",), request_id=1, job_id=42, reasons_value_tag=0x44):
    """A minimal, well-formed Get-Job-Attributes response naming job-id,
    job-state and job-state-reasons.  job-id always matches (job_id=42 is
    the default handle's job id below) -- H4's target is job-state-reasons
    syntax/vocabulary, not job-id binding (already covered by r31 round-1
    finding 2's tests).  A reason may be a str (encoded ascii/utf-8) or raw
    bytes (to inject a genuinely non-ASCII value)."""
    out = b"\x02\x00" + (0).to_bytes(2, "big") + request_id.to_bytes(4, "big", signed=True)
    out += b"\x01"
    out += _ipp_attr(0x47, b"attributes-charset", b"utf-8")
    out += _ipp_attr(0x48, b"attributes-natural-language", b"en")
    out += b"\x02"
    out += _ipp_attr(0x21, b"job-id", job_id.to_bytes(4, "big", signed=True))
    out += _ipp_attr(0x23, b"job-state", job_state.to_bytes(4, "big", signed=True))
    for i, reason in enumerate(reasons):
        value = reason if isinstance(reason, bytes) else reason.encode("utf-8")
        name = b"job-state-reasons" if i == 0 else b""
        out += _ipp_attr(reasons_value_tag, name, value)
    return out + b"\x03"


class TestH4MalformedKeywordSyntaxIsAlwaysWaiting:
    """r31 round-2 finding 4 (astra verdict item 4, escalated): job-state-
    reasons must be strict RFC 8011 sec 5.1.4 keyword syntax (1-255 US-ASCII
    lowercase letters/digits/-/./_, first char a lowercase letter).  ONE
    malformed value makes the WHOLE attribute unusable -- WAITING, never
    reinterpreted as COMPLETED, FAILED or UNOBSERVABLE."""

    @pytest.mark.parametrize("reasons", [
        pytest.param((" ",), id="bare-space"),
        pytest.param(("job-completed-with-errors ",), id="trailing-space-on-an-error-reason"),
        pytest.param(("job-completed-successfully\n",), id="trailing-newline"),
        pytest.param(("Job-completed-successfully",), id="leading-capital"),
        pytest.param(("1abc",), id="leading-digit"),
        pytest.param(("a" * 256,), id="256-chars-one-over-the-255-max"),
        pytest.param(("job\x00x",), id="embedded-nul"),
        pytest.param(("",), id="empty-value"),
        pytest.param(("job-completed-successfully", " "), id="second-value-malformed"),
        pytest.param((b"\xff",), id="non-ascii-byte"),
        pytest.param(("-x",), id="leading-hyphen"),
    ])
    def test_malformed_reason_is_waiting(self, reasons):
        body = ipp_response(job_state=9, reasons=reasons, request_id=7, job_id=42)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation

    def test_255_chars_is_syntactically_valid_but_not_allowlisted(self):
        """One char under the max parses fine (unlike 256), so it reaches the
        allowlist check on its own semantic merits -- and fails it:
        UNOBSERVABLE, not COMPLETED, and not WAITING either."""
        body = ipp_response(job_state=9, reasons=("a" * 255,), request_id=7, job_id=42)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_UNOBSERVABLE, observation


class TestH4SyntacticallyValidButUnlistedReasonsAreUnobservable:
    @pytest.mark.parametrize("reasons", [
        pytest.param(("job-completed-with-warnings",), id="with-warnings"),
        pytest.param(("job-printing",), id="printing-contradicts-completed"),
        pytest.param(("com.acme.reason",), id="vendor-keyword"),
        pytest.param(("none", "job-queued"), id="none-plus-an-unlisted-reason"),
        pytest.param(("job-completed-successfully", "printer-stopped"),
                     id="successfully-plus-an-unlisted-reason"),
    ])
    def test_unlisted_reason_is_unobservable(self, reasons):
        body = ipp_response(job_state=9, reasons=reasons, request_id=7, job_id=42)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_UNOBSERVABLE, observation


class TestH4AllowlistedReasonsComplete:
    @pytest.mark.parametrize("reasons", [
        pytest.param(("none",), id="none"),
        pytest.param(("job-completed-successfully",), id="successfully"),
        pytest.param(("job-completed-successfully", "job-restartable"),
                     id="successfully-plus-restartable"),
        pytest.param(("job-restartable",), id="restartable-alone"),
    ])
    def test_allowlisted_reason_completes(self, reasons):
        body = ipp_response(job_state=9, reasons=reasons, request_id=7, job_id=42)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_COMPLETED, observation


class TestH4ErrorsAndStoppedAndQueuedInDeviceOutrankTheAllowlist:
    @pytest.mark.parametrize("reasons,expected", [
        pytest.param(("job-completed-with-errors",), POLL_FAILED, id="with-errors"),
        pytest.param(("job-completed-successfully", "job-canceled-by-user"), POLL_FAILED,
                     id="successfully-plus-canceled-outranks-the-allowlist"),
        pytest.param(("queued-in-device",), POLL_UNOBSERVABLE, id="queued-in-device"),
    ])
    def test_verdict(self, reasons, expected):
        body = ipp_response(job_state=9, reasons=reasons, request_id=7, job_id=42)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == expected, observation


IPP_DEVICE = {"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}
IPP_ACCEPTED_RESULT = {
    "submitted": True,
    "filepath": "/tmp/pcc-print.txt",
    "returncode": 0,
    "stdout": "request id is default-42 (1 file(s))",
    "stderr": "",
    "printer_ip": "10.0.0.1",
    "printer_name": "",
}


def _accept_ipp(gateway=None, clock=None):
    gateway = gateway or _gateway()
    clock = clock or FakeClock()
    ex = JobExecutor(devices=[IPP_DEVICE], gateway_client=gateway, clock=clock)
    with mock.patch("pcc_node.job_executor.execute_ipp_print", return_value=IPP_ACCEPTED_RESULT):
        ex.execute({"id": "job-h4", "capabilityType": "document-printing", "parameters": {}})
    return ex, gateway, clock


class FakeIppPrinter:
    def __init__(self, state=9, reasons=("none",)):
        self.state = state
        self.reasons = reasons
        self.requests = []

    def __call__(self, req, *a, **k):
        self.requests.append(req)
        request_id = int.from_bytes(req.data[4:8], "big", signed=True)
        return _RawResponse(200, ipp_response(job_state=self.state, reasons=self.reasons,
                                              request_id=request_id, job_id=42))


def _poll(ex, fake):
    with mock.patch("pcc_node.http_util.urlopen", side_effect=fake):
        ex.poll_awaiting()


class TestH4EndToEndThroughPollAwaiting:
    """The same three verdicts, driven through the real JobExecutor with the
    existing fakes: accept a print, then poll it once."""

    def test_a_malformed_reason_leaves_the_job_registered_with_no_status_and_no_evidence(self):
        ex, gateway, clock = _accept_ipp()
        _poll(ex, FakeIppPrinter(state=9, reasons=(" ",)))

        assert "job-h4" in ex.awaiting_completion()
        assert _statuses(gateway) == ["running"]
        assert len(_bundles(gateway)) == 1  # only execute()'s acceptance bundle

    def test_an_allowlist_external_reason_drops_it_with_no_status_and_no_evidence(self, caplog):
        ex, gateway, clock = _accept_ipp()
        with caplog.at_level(logging.ERROR, logger=EXECUTOR_LOGGER):
            _poll(ex, FakeIppPrinter(state=9, reasons=("job-completed-with-warnings",)))

        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running"]
        assert len(_bundles(gateway)) == 1

    def test_job_completed_successfully_reports_completed_once(self):
        ex, gateway, clock = _accept_ipp()
        printer = FakeIppPrinter(state=9, reasons=("job-completed-successfully",))
        _poll(ex, printer)

        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running", "completed"]
        completion = _bundles(gateway)[-1]
        assert _types(completion) == [EVENT_EXECUTION_COMPLETED]

        clock.advance(COMPLETION_POLL_MIN_INTERVAL_S)
        _poll(ex, printer)
        assert _statuses(gateway) == ["running", "completed"]
        assert len(_bundles(gateway)) == 2, "the completion must not be reported twice"


# ---------------------------------------------------------------------------
# C2/C3: OctoPrint -- completion tracking is gone; acceptance-only, forever
# ---------------------------------------------------------------------------

OP_DEVICE = {"id": "op1", "protocol": "octoprint", "url": "http://10.0.0.20:5000"}


def _op_execute(device, filename, urlopen_side_effect, job_id="job-op"):
    gateway = _gateway()
    ex = JobExecutor(devices=[device], gateway_client=gateway)
    with mock.patch("pcc_node.http_util.urlopen", side_effect=urlopen_side_effect):
        bundle = ex.execute({"id": job_id, "capabilityType": "3d-print",
                             "parameters": {"filename": filename}})
    return ex, gateway, bundle


class TestC2OctoPrintFilePathPure:
    @pytest.mark.parametrize("filename,expected", [
        pytest.param("benchy.gcode", "benchy.gcode", id="plain"),
        pytest.param("/benchy.gcode", "benchy.gcode", id="leading-slash-stripped"),
        pytest.param("models/part.gcode", "models/part.gcode", id="one-subdirectory"),
    ])
    def test_valid_paths_pass_through(self, filename, expected):
        assert octoprint_file_path(filename) == expected

    @pytest.mark.parametrize("filename", [
        pytest.param("../x.gcode", id="parent-traversal-at-start"),
        pytest.param("a/../b.gcode", id="parent-traversal-mid-path"),
        pytest.param("a//b.gcode", id="empty-segment-from-double-slash"),
        pytest.param("./a.gcode", id="dot-segment-at-start"),
        pytest.param("a/.", id="dot-segment-at-end"),
        pytest.param("a\\b.gcode", id="backslash"),
        pytest.param("a\nb.gcode", id="embedded-newline"),
        pytest.param("a\x7fb", id="embedded-del"),
        # An empty filename IS refused by this pure function -- but the
        # ADAPTER never reaches it: _execute_octoprint's own `if not
        # filename` guard fires first and reports "no_filename", never
        # "unsafe_filename".  See test_empty_filename_is_no_filename below.
        pytest.param("", id="empty-string"),
        pytest.param(5, id="int"),
        pytest.param(["a"], id="list"),
        pytest.param(None, id="none"),
    ])
    def test_unsafe_or_non_string_paths_return_none(self, filename):
        assert octoprint_file_path(filename) is None


class TestC2SelectPrintIsTheOnlyRequestEver:
    def test_200_empty_body_for_a_nested_path_is_one_request_and_accepted(self):
        seen = []

        def fake(req, *a, **k):
            seen.append((req.get_method(), req.full_url, json.loads(req.data.decode())))
            return _RawResponse(200, _json_body({}))

        ex, gateway, bundle = _op_execute(OP_DEVICE, "models/part.gcode", fake)

        assert seen == [(
            "POST", "http://10.0.0.20:5000/api/files/local/models/part.gcode",
            {"command": "select", "print": True},
        )]
        result = bundle["result"]
        assert classify_execution_result(result) == RESULT_ACCEPTED
        assert _statuses(gateway) == ["running"]
        progress_event = _bundles(gateway)[0]["events"][1]
        assert progress_event["type"] == EVENT_EXECUTION_PROGRESS
        assert progress_event["payload"]["level"] == EVIDENCE_LEVEL_SUBMITTED
        assert ex.awaiting_completion() == {}

        # OctoPrint gets no completion handle at all: a later poll cycle
        # must not send anything, because nothing was ever registered.
        with mock.patch("pcc_node.http_util.urlopen", side_effect=_never_called):
            ex.poll_awaiting()

    def test_the_verdicts_baseline_and_history_bait_is_never_asked(self):
        """The verdict's exact scenario: a device that would answer ANY GET
        .../api/files/... with history that looks like an inherited success,
        and GET /api/job with a finished-job snapshot.  The node has no GET
        path left at all, so it never asks either -- and the job never
        completes."""

        def fake(req, *a, **k):
            method, url = req.get_method(), req.full_url
            if method == "GET" and "/api/files/" in url:
                return _RawResponse(200, _json_body(
                    {"prints": {"success": 23, "failure": 0, "last": {"success": True}}}
                ))
            if method == "GET" and url.endswith("/api/job"):
                return _RawResponse(200, _json_body(
                    {"state": "Operational", "progress": {"completion": 100.0}}
                ))
            if method == "POST" and url == "http://10.0.0.20:5000/api/files/local/part.gcode":
                return _RawResponse(200, _json_body({}))
            raise AssertionError(f"unexpected request {method} {url}")

        ex, gateway, bundle = _op_execute(OP_DEVICE, "part.gcode", fake)

        assert classify_execution_result(bundle["result"]) == RESULT_ACCEPTED
        assert EVENT_EXECUTION_COMPLETED not in _types(bundle)
        assert _statuses(gateway) == ["running"]
        assert ex.awaiting_completion() == {}

        with mock.patch("pcc_node.http_util.urlopen", side_effect=fake):
            ex.poll_awaiting()  # nothing registered: must not touch /api/job either
        assert _statuses(gateway) == ["running"]
        assert len(_bundles(gateway)) == 1


class TestC2SelectPrintFailures:
    def test_200_with_an_error_body_is_a_failure(self):
        fake = lambda req, *a, **k: _RawResponse(200, _json_body({"error": "metadata unavailable"}))
        ex, gateway, bundle = _op_execute(OP_DEVICE, "part.gcode", fake, job_id="job-op-a")

        assert classify_execution_result(bundle["result"]) == RESULT_FAILURE
        assert _statuses(gateway) == ["running", "failed"]
        assert ex.awaiting_completion() == {}

    def test_409_is_a_failure(self):
        fake = lambda req, *a, **k: _RawResponse(409, _json_body({}))
        ex, gateway, bundle = _op_execute(OP_DEVICE, "part.gcode", fake, job_id="job-op-b")

        assert classify_execution_result(bundle["result"]) == RESULT_FAILURE
        assert _statuses(gateway) == ["running", "failed"]

    def test_transport_failure_is_a_failure(self):
        fake = URLError("[Errno 111] Connection refused")
        ex, gateway, bundle = _op_execute(OP_DEVICE, "part.gcode", fake, job_id="job-op-c")

        assert classify_execution_result(bundle["result"]) == RESULT_FAILURE
        assert _statuses(gateway) == ["running", "failed"]


class TestC2OctoPrintFilenameRefusal:
    @pytest.mark.parametrize("filename", [
        pytest.param("../x.gcode", id="parent-traversal-at-start"),
        pytest.param("a/../b.gcode", id="parent-traversal-mid-path"),
        pytest.param("a//b.gcode", id="empty-segment-from-double-slash"),
        pytest.param("./a.gcode", id="dot-segment-at-start"),
        pytest.param("a/.", id="dot-segment-at-end"),
        pytest.param("a\\b.gcode", id="backslash"),
        pytest.param("a\nb.gcode", id="embedded-newline"),
        pytest.param("a\x7fb", id="embedded-del"),
        pytest.param(5, id="int"),
        pytest.param(["a"], id="list"),
    ])
    def test_unsafe_filename_refuses_with_nothing_sent(self, filename):
        ex = JobExecutor(devices=[])
        with mock.patch("pcc_node.http_util.urlopen", side_effect=_never_called):
            result = ex._execute_octoprint(OP_DEVICE, {"id": "job-op", "parameters": {"filename": filename}})

        assert result["error"] == "unsafe_filename"
        assert result["submitted"] is False
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_empty_filename_is_no_filename_not_unsafe_filename(self):
        ex = JobExecutor(devices=[])
        with mock.patch("pcc_node.http_util.urlopen", side_effect=_never_called):
            result = ex._execute_octoprint(OP_DEVICE, {"id": "job-op", "parameters": {"filename": ""}})

        assert result["error"] == "no_filename"
        assert classify_execution_result(result) == RESULT_FAILURE


class TestC2OctoPrintPathEncoding:
    def test_space_in_path_is_percent_encoded(self):
        seen = []

        def fake(req, *a, **k):
            seen.append(req.full_url)
            return _RawResponse(200, _json_body({}))

        ex = JobExecutor(devices=[])
        with mock.patch("pcc_node.http_util.urlopen", side_effect=fake):
            ex._execute_octoprint(OP_DEVICE, {"id": "job-op",
                                              "parameters": {"filename": "/models/a b.gcode"}})

        assert seen == ["http://10.0.0.20:5000/api/files/local/models/a%20b.gcode"]

    def test_percent_encoded_dot_dot_is_double_encoded_not_decoded(self):
        """"%2e%2e/x.gcode" is a LITERAL string -- the node never URL-decodes
        a job's filename, so it is not ".." and octoprint_file_path lets it
        through.  What matters is that sending it does not hand a single-
        decode-pass party a traversal: quote() re-encodes the literal "%"
        itself, so "%2e%2e" becomes "%252e%252e" on the wire."""
        seen = []

        def fake(req, *a, **k):
            seen.append(req.full_url)
            return _RawResponse(200, _json_body({}))

        ex = JobExecutor(devices=[])
        with mock.patch("pcc_node.http_util.urlopen", side_effect=fake):
            result = ex._execute_octoprint(OP_DEVICE, {"id": "job-op",
                                                        "parameters": {"filename": "%2e%2e/x.gcode"}})

        assert seen == ["http://10.0.0.20:5000/api/files/local/%252e%252e/x.gcode"]
        assert result["submitted"] is True


class TestC3CompletionHandleNeverResurrectsOctoPrint:
    """_completion_handle grants a handle to IPP only.  A result dict crafted
    with the OLD OctoPrint handle shape (printPath/baseline) gets nothing --
    for an octoprint device, a generic device, or anything else."""

    @pytest.mark.parametrize("protocol", ["octoprint", "3d-printer", "generic", "http"])
    def test_a_crafted_legacy_shaped_result_gets_no_handle(self, protocol):
        device = {"id": "d1", "protocol": protocol, "url": "http://x"}
        legacy_result = {
            "submitted": True, "device": "http://x",
            "printPath": "pcc-j/a.gcode", "baseline": {"success": 0, "failure": 0},
        }
        ex = JobExecutor(devices=[])
        assert ex._completion_handle(device, legacy_result) is None
