"""Round-2 tests against the r31-pccnode-r2-astra DO-NOT-SHIP verdict.

Source: /mnt/sparkbulk/pcc-reconciliation/review-router/r31-pccnode-r2-astra/verdict.md

One test per attack / edge-matrix row, named after the finding it targets:
  f1 = generic HTTP completion (nested-queue bypass; the completion
        contract this originally covered was removed in r31 round-3 --
        generic HTTP now never completes, see test_r31_round3.py)
  f2 = IPP job-id binding + job-state-reasons strictness
  f3 = OctoPrint private-copy + print-history correlation (REMOVED in
        r31 round-3: OctoPrint completion tracking was withdrawn
        entirely, see test_r31_round3.py)
  f4 = http_util strict parsing (duplicate keys / NaN) + device-body bound
  f5 = poll deadlines (Opentrons run poll, IPP/OctoPrint completion poll)

Only pcc_node.http_util's urlopen / http / http_bytes are faked
(directly, as attributes on the http_util module).  The adapters, the
classifier and the evidence builder all run for real underneath, per the
sidecar brief: build a JobExecutor with a fake gateway that records
push_evidence/update_job_status, call executor.execute(job) (and
executor.poll_awaiting() for IPP/OctoPrint), and assert on the pushed
bundles' event types and the reported statuses.

This file is expected to be RED in places: the r31-round2 lane is
implementing these fixes in parallel.  Every failure here must be either an
assertion about behavior, or an AttributeError/TypeError for a spec'd name
the lane has not added yet -- never a bug in the test itself.
"""

import io
import json
from unittest import mock
from urllib.error import HTTPError, URLError

import pytest

from pcc_node.http_util import http, http_bytes, parse_json_strict
from pcc_node import job_executor as je
from pcc_node.job_executor import (
    JobExecutor,
    execute_ipp_print,
    classify_execution_result,
    build_evidence_bundle,
    RESULT_SUCCESS,
    RESULT_FAILURE,
    RESULT_UNCLASSIFIABLE,
    RESULT_ACCEPTED,
    EVENT_EXECUTION_STARTED,
    EVENT_EXECUTION_PROGRESS,
    EVENT_EXECUTION_COMPLETED,
    EVENT_EXECUTION_FAILED,
    DEVICE_BODY_MAX_NODES,
    DEVICE_BODY_MAX_DEPTH,
    _extract_device_error,
    FAILURE_STATUS_VALUES,
    encode_ipp_get_job_attributes,
    decode_ipp_response,
    ipp_job_state,
    ipp_job_urls,
    ipp_completion_verdict,
    IppDecodeError,
    parse_lp_request_id,
    POLL_COMPLETED,
    POLL_FAILED,
    POLL_WAITING,
    POLL_UNOBSERVABLE,
    COMPLETION_POLL_REQUEST_TIMEOUT_S,
)

# ---------------------------------------------------------------------------
# Shared fakes / helpers
# ---------------------------------------------------------------------------


class _Resp:
    """urlopen stand-in: context manager + status + bounded read(n)."""

    def __init__(self, status, raw=b""):
        self.status = status
        self._raw = raw if isinstance(raw, bytes) else raw.encode("utf-8")

    def read(self, n=None):
        return self._raw if n is None else self._raw[:n]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeClock:
    """Monotonic clock the tests move by hand (injected via JobExecutor(clock=))."""

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


def _text(obj):
    return json.dumps(obj, default=str)


def _json_bytes(obj):
    return json.dumps(obj).encode("utf-8")


IPP_ACCEPTED_RESULT = {
    "submitted": True,
    "filepath": "/tmp/pcc-print.txt",
    "returncode": 0,
    "stdout": "request id is default-42 (1 file(s))",
    "stderr": "",
    "printer_ip": "10.0.0.1",
    "printer_name": "",
}
IPP_DEVICE = {"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}


def _accept_ipp_job(gateway=None, clock=None, device=None, job_id="job-ipp",
                     result=None, timeout_override=None):
    gateway = gateway or _gateway()
    clock = clock or FakeClock()
    device = dict(device or IPP_DEVICE)
    if timeout_override is not None:
        device["completionPollTimeout"] = timeout_override
    ex = JobExecutor(devices=[device], gateway_client=gateway, clock=clock)
    with mock.patch("pcc_node.job_executor.execute_ipp_print",
                    return_value=result or IPP_ACCEPTED_RESULT):
        ex.execute({"id": job_id, "capabilityType": "document-printing", "parameters": {}})
    return ex, gateway, clock


def _ipp_attr(tag, name, value):
    """RFC 8010 sec 3.1.4/3.1.5: tag, name-length, name, value-length, value
    (an additional-value when name is b"")."""
    return (
        bytes([tag]) + len(name).to_bytes(2, "big") + name
        + len(value).to_bytes(2, "big") + value
    )


def _ipp_ok_response(request_id, job_id=42, state=9,
                      reasons=("job-completed-successfully",),
                      include_job_id=True, job_id_tag=0x21,
                      reasons_tag=0x44, extra=b""):
    """A well-formed Get-Job-Attributes response naming job_id/state/reasons."""
    out = b"\x02\x00" + (0).to_bytes(2, "big") + request_id.to_bytes(4, "big", signed=True)
    out += b"\x01"
    out += _ipp_attr(0x47, b"attributes-charset", b"utf-8")
    out += _ipp_attr(0x48, b"attributes-natural-language", b"en")
    out += b"\x02"
    if include_job_id:
        out += _ipp_attr(job_id_tag, b"job-id", job_id.to_bytes(4, "big", signed=True))
    if state is not None:
        out += _ipp_attr(0x23, b"job-state", state.to_bytes(4, "big", signed=True))
    for i, r in enumerate(reasons):
        out += _ipp_attr(reasons_tag, b"job-state-reasons" if i == 0 else b"", r.encode())
    return out + extra + b"\x03"


class FakeIppPrinter:
    """urlopen stand-in for an IPP printer: echoes the request-id it was
    sent and answers using the builder above (or a raw/failure override)."""

    def __init__(self, job_id=42, state=5, reasons=(), include_job_id=True):
        self.requests = []
        self.job_id = job_id
        self.state = state
        self.reasons = reasons
        self.include_job_id = include_job_id
        self.raw = None
        self.fail_with = None

    def __call__(self, req, *args, **kwargs):
        self.requests.append(req)
        if self.fail_with is not None:
            raise self.fail_with
        if self.raw is not None:
            return _Resp(200, self.raw)
        request_id = int.from_bytes(req.data[4:8], "big", signed=True)
        return _Resp(200, _ipp_ok_response(
            request_id, job_id=self.job_id, state=self.state,
            reasons=self.reasons, include_job_id=self.include_job_id,
        ))


def _poll(ex, fake):
    with mock.patch("pcc_node.http_util.urlopen", side_effect=fake):
        ex.poll_awaiting()


# ---------------------------------------------------------------------------
# Finding 4 (part a): http_util strict answer parsing
# ---------------------------------------------------------------------------


class TestF4HttpStrictParsing:
    """http() must refuse duplicate keys / NaN-Infinity and return the raw
    text (never a parsed dict) so a discarded key can never hide a failure."""

    def _urlopen(self, status, raw_bytes):
        return mock.patch(
            "pcc_node.http_util.urlopen",
            return_value=_Resp(status, raw_bytes),
        )

    def test_f4_valid_json_no_duplicates_parses_to_dict(self):
        with self._urlopen(200, b'{"status": "failed"}'):
            status, data = http("GET", "http://dev")
        assert status == 200
        assert data == {"status": "failed"}

    @pytest.mark.parametrize("raw", [
        pytest.param(b'{"status":"failed","status":"completed"}', id="failed-then-completed"),
        pytest.param(b'{"status":"completed","status":"failed"}', id="completed-then-failed"),
    ])
    def test_f4_duplicate_top_level_key_returns_raw_text(self, raw):
        with self._urlopen(200, raw):
            status, data = http("GET", "http://dev")
        assert status == 200
        assert isinstance(data, str), f"a duplicate key must never parse to a dict: {data!r}"
        assert data == raw.decode("utf-8")

    @pytest.mark.parametrize("raw", [
        pytest.param(b'{"error":"jam","error":null}', id="jam-then-null"),
        pytest.param(b'{"error":null,"error":"jam"}', id="null-then-jam"),
    ])
    def test_f4_duplicate_nested_key_returns_raw_text(self, raw):
        with self._urlopen(200, raw):
            status, data = http("GET", "http://dev")
        assert isinstance(data, str)

    def test_f4_duplicate_key_nested_two_levels_deep_returns_raw_text(self):
        raw = b'{"outer": {"inner": {"error": "jam", "error": null}}}'
        with self._urlopen(200, raw):
            status, data = http("GET", "http://dev")
        assert isinstance(data, str)

    def test_f4_duplicate_key_inside_a_list_item_returns_raw_text(self):
        raw = b'[{"a": 1, "a": 2}]'
        with self._urlopen(200, raw):
            status, data = http("GET", "http://dev")
        assert isinstance(data, str)

    @pytest.mark.parametrize("raw", [
        pytest.param(b'{"value": NaN}', id="nan"),
        pytest.param(b'{"value": Infinity}', id="infinity"),
        pytest.param(b'{"value": -Infinity}', id="negative-infinity"),
    ])
    def test_f4_nan_and_infinity_return_raw_text(self, raw):
        with self._urlopen(200, raw):
            status, data = http("GET", "http://dev")
        assert isinstance(data, str)
        assert data == raw.decode("utf-8")

    def test_f4_invalid_utf8_returns_str_never_parsed_json(self):
        with self._urlopen(200, b"\xff\xfe\x00garbage"):
            status, data = http("GET", "http://dev")
        assert status == 200
        assert isinstance(data, str)

    def test_f4_http_error_path_duplicate_keys_returns_raw_text(self):
        raw = b'{"status":"failed","status":"completed"}'
        err = HTTPError("http://dev", 500, "err", {}, io.BytesIO(raw))
        with mock.patch("pcc_node.http_util.urlopen", side_effect=err):
            status, data = http("GET", "http://dev")
        assert status == 500
        assert isinstance(data, str)

    def test_f4_http_error_path_nan_returns_raw_text(self):
        raw = b'{"value": NaN}'
        err = HTTPError("http://dev", 502, "err", {}, io.BytesIO(raw))
        with mock.patch("pcc_node.http_util.urlopen", side_effect=err):
            status, data = http("GET", "http://dev")
        assert status == 502
        assert isinstance(data, str)

    def test_f4_parse_json_strict_returns_value_for_valid_json(self):
        assert parse_json_strict('{"a": 1}') == {"a": 1}
        assert parse_json_strict("[1, 2, 3]") == [1, 2, 3]

    @pytest.mark.parametrize("text", [
        '{"a": 1, "a": 2}',
        '{"a": {"b": 1, "b": 2}}',
        '{"a": NaN}',
        '{"a": Infinity}',
        '{"a": -Infinity}',
    ])
    def test_f4_parse_json_strict_raises_value_error(self, text):
        with pytest.raises(ValueError):
            parse_json_strict(text)


class TestF4HttpUtilBoundedReads:
    """max_bytes bounds every read; an oversized answer is a transport
    failure (status 0), never partially parsed."""

    def test_f4_oversized_answer_is_status_zero_with_larger_than_message(self):
        raw = b"x" * 50
        with mock.patch("pcc_node.http_util.urlopen", return_value=_Resp(200, raw)):
            status, data = http("GET", "http://dev", max_bytes=10)
        assert status == 0
        assert isinstance(data, dict)
        assert "larger than" in data["error"]

    def test_f4_oversized_http_error_answer_is_status_zero(self):
        raw = b"x" * 50
        err = HTTPError("http://dev", 500, "err", {}, io.BytesIO(raw))
        with mock.patch("pcc_node.http_util.urlopen", side_effect=err):
            status, data = http("GET", "http://dev", max_bytes=10)
        assert status == 0
        assert "larger than" in data["error"]

    def test_f4_answer_exactly_at_the_boundary_is_read(self):
        raw = b"x" * 10  # a bare 10-byte string is not valid JSON -> str
        with mock.patch("pcc_node.http_util.urlopen", return_value=_Resp(200, raw)):
            status, data = http("GET", "http://dev", max_bytes=10)
        assert status == 200
        assert data == "x" * 10

    def test_f4_http_bytes_oversized_returns_status_zero_empty_bytes(self):
        raw = b"\x02\x00" + b"y" * 50
        with mock.patch("pcc_node.http_util.urlopen", return_value=_Resp(200, raw)):
            status, body = http_bytes("POST", "http://dev", data=b"x", max_bytes=10)
        assert (status, body) == (0, b"")

    def test_f4_http_bytes_within_bound_is_returned_verbatim(self):
        raw = b"\x02\x00\x00\x09"
        with mock.patch("pcc_node.http_util.urlopen", return_value=_Resp(200, raw)):
            status, body = http_bytes("POST", "http://dev", data=b"x", max_bytes=100)
        assert (status, body) == (200, raw)


# ---------------------------------------------------------------------------
# Finding 4 (part b): device-body size/depth bound (5,000 nodes, depth 8)
# ---------------------------------------------------------------------------


class TestF4DeviceBodySizeAndDepthBoundary:
    def test_f4_4999_scalar_fields_is_readable(self):
        """root(1) + 4999 values = 5000 nodes: at the bound, not over it."""
        body = {f"f{i}": i for i in range(DEVICE_BODY_MAX_NODES - 1)}
        assert _extract_device_error(body) is None

    def test_f4_5000_scalar_fields_is_too_large(self):
        """root(1) + 5000 values = 5001 nodes: one over the bound."""
        body = {f"f{i}": i for i in range(DEVICE_BODY_MAX_NODES)}
        message = _extract_device_error(body)
        assert message is not None and "too large" in message

    def test_f4_6000_scalar_fields_with_top_level_completed_status_never_completes(self):
        """The exact bypass: counting only visited CONTAINERS let a flat
        6,000-scalar-field body with a top-level status=completed through,
        because _scan_device_body skips scalar children.  Every value is now
        a node, so this must fail closed through the real adapter."""
        device = {"id": "g1", "protocol": "generic", "url": "http://10.0.0.9"}
        body = {f"f{i}": i for i in range(5999)}
        body["status"] = "completed"
        with mock.patch("pcc_node.http_util.http", return_value=(200, body)):
            result = JobExecutor(devices=[])._execute_generic_http(
                device, {"id": "job-6000", "parameters": {}})
        assert result.get("executed") is not True, result
        assert classify_execution_result(result) != RESULT_SUCCESS
        bundle = build_evidence_bundle("job-6000", device, result)
        assert EVENT_EXECUTION_COMPLETED not in _types(bundle)
        assert "execution_completed" not in _text(bundle)

    def test_f4_list_items_count_as_nodes_too(self):
        readable = {"items": list(range(DEVICE_BODY_MAX_NODES - 2))}  # 1+1+4998=5000
        assert _extract_device_error(readable) is None
        too_large = {"items": list(range(DEVICE_BODY_MAX_NODES - 1))}  # 1+1+4999=5001
        message = _extract_device_error(too_large)
        assert message is not None and "too large" in message

    @staticmethod
    def _nested(depth):
        body = {"leaf": "ok"}
        for _ in range(depth):
            body = {"next": body}
        return body

    def test_f4_container_at_depth_7_is_readable(self):
        assert _extract_device_error(self._nested(DEVICE_BODY_MAX_DEPTH - 1)) is None

    def test_f4_container_at_depth_8_is_too_deep(self):
        message = _extract_device_error(self._nested(DEVICE_BODY_MAX_DEPTH))
        assert message is not None and "too deeply nested" in message

    def test_f4_size_bound_is_checked_before_the_body_is_otherwise_read(self):
        """A too-large body is refused before any failure/success words in it
        would be read -- the bound wins even over a nested error marker."""
        body = {f"f{i}": i for i in range(DEVICE_BODY_MAX_NODES)}
        body["error"] = "should never be reached"
        message = _extract_device_error(body)
        assert "too large" in message
        assert "should never be reached" not in message


# ---------------------------------------------------------------------------
# Finding 1: generic HTTP completion contract
# ---------------------------------------------------------------------------

GH_DEVICE = {"id": "g1", "protocol": "generic", "url": "http://10.0.0.9"}


def _gh_execute(device, job_body_status_and_data, job=None, job_id="job-gh"):
    status, data = job_body_status_and_data
    job = job or {"id": job_id, "parameters": {}}
    with mock.patch("pcc_node.http_util.http", return_value=(status, data)):
        return JobExecutor(devices=[])._execute_generic_http(device, job)


class TestF1GenericHttpWithoutContract:
    """Without a device['completionContract'], generic HTTP can never
    complete -- a recognised acceptance word (anywhere) is the only flag it
    can carry, and it is fail-closed otherwise."""

    def test_f1_nested_queued_under_top_level_completed_never_completes(self):
        """The verdict's central attack:
        {"status":"completed","data":{"result":{"status":"queued"}}}"""
        body = {"status": "completed", "data": {"result": {"status": "queued"}}}
        result = _gh_execute(GH_DEVICE, (200, body))
        assert result.get("executed") is not True, result
        assert classify_execution_result(result) != RESULT_SUCCESS
        bundle = build_evidence_bundle("job-gh", GH_DEVICE, result)
        assert EVENT_EXECUTION_COMPLETED not in _types(bundle)
        assert "execution_completed" not in _text(bundle)

    def test_f1_bare_top_level_completed_status_never_completes_without_contract(self):
        """{"status":"completed"} alone: no field of a generic device's body
        can be read as "the physical work finished" (r31 round-2 finding 1 --
        the completion contract this test's name refers to was removed in
        round-3).  A clean 2xx with no failure stated is acceptance now,
        never completion. CHANGED (r31 round-3): used to be UNCLASSIFIABLE."""
        result = _gh_execute(GH_DEVICE, (200, {"status": "completed"}))
        assert result.get("executed") is not True
        assert result.get("submitted") is True
        assert classify_execution_result(result) == RESULT_ACCEPTED

    @pytest.mark.parametrize("body", [
        pytest.param({"state": "done"}, id="state-done"),
        pytest.param({"completed": True}, id="completed-true"),
        pytest.param({"ok": True}, id="ok-true"),
        pytest.param({}, id="empty"),
    ])
    def test_f1_edge_matrix_opaque_2xx_never_completes(self, body):
        result = _gh_execute(GH_DEVICE, (200, body))
        assert result.get("executed") is not True
        assert classify_execution_result(result) != RESULT_SUCCESS

    def test_f1_acceptance_word_at_arbitrary_depth_not_a_named_envelope_is_accepted(self):
        """The old scan only looked inside result/data/response/body/payload
        one level deep.  The fix must read ANY depth, ANY key name."""
        body = {"foo": {"bar": {"baz": {"status": "queued"}}}}
        result = _gh_execute(GH_DEVICE, (200, body))
        assert result.get("submitted") is True, result
        assert "executed" not in result
        assert classify_execution_result(result) == RESULT_ACCEPTED

    def test_f1_acceptance_boolean_at_arbitrary_depth_is_accepted(self):
        body = {"a": {"b": [{"c": {"accepted": True}}]}}
        result = _gh_execute(GH_DEVICE, (200, body))
        assert result.get("submitted") is True, result
        assert classify_execution_result(result) == RESULT_ACCEPTED

    def test_f1_202_is_accepted_even_with_a_completion_claiming_body(self):
        result = _gh_execute(GH_DEVICE, (202, {"status": "completed"}))
        assert result.get("submitted") is True
        assert "executed" not in result
        assert classify_execution_result(result) == RESULT_ACCEPTED

    def test_f1_204_never_completes_even_with_a_completion_claiming_body(self):
        """204 is now just another clean 2xx (r31 round-3 removed the special
        HTTP_NO_CONTENT case along with the completion contract): acceptance,
        never completion, whatever a parsed body next to it might claim.
        CHANGED (r31 round-3): submitted used to be False; now True."""
        result = _gh_execute(GH_DEVICE, (204, {"status": "completed"}))
        assert result.get("executed") is not True
        assert result.get("submitted") is True
        assert classify_execution_result(result) == RESULT_ACCEPTED

    def test_f1_204_end_to_end_never_reports_completed(self):
        gateway = _gateway()
        ex = JobExecutor(devices=[GH_DEVICE], gateway_client=gateway)
        job = {"id": "job-204", "capabilityType": "generic", "parameters": {}}
        with mock.patch("pcc_node.http_util.http", return_value=(204, {"status": "completed"})):
            bundle = ex.execute(job)
        assert EVENT_EXECUTION_COMPLETED not in _types(bundle)
        assert "completed" not in _statuses(gateway)

    def test_f1_completion_and_acceptance_stated_together_is_a_conflict(self):
        body = {"status": "completed", "state": "queued"}
        result = _gh_execute(GH_DEVICE, (200, body))
        assert result.get("executed") is not True
        assert classify_execution_result(result) != RESULT_SUCCESS


# ---------------------------------------------------------------------------
# Finding 2: IPP job-id binding + job-state-reasons strictness
# ---------------------------------------------------------------------------


class TestF2IppRequestEncoding:
    def test_f2_requested_attributes_are_job_id_job_state_job_state_reasons_in_order(self):
        encoded = encode_ipp_get_job_attributes("ipp://10.0.0.1:631/printers/default", 42, 7)
        decoded = decode_ipp_response(encoded)
        [group] = decoded["groups"]
        requested = group["attributes"][-1]["values"]
        assert requested == [
            (0x44, b"job-id"), (0x44, b"job-state"), (0x44, b"job-state-reasons"),
        ]


class TestF2IppJobIdBinding:
    """No terminal verdict without proof the answer is about THIS job."""

    def test_f2_answer_about_a_different_job_id_is_waiting_even_at_state_9(self):
        """The brief's core attack: job 999, state 9, reason none, asked
        about job 42 -- must be WAITING, never COMPLETED."""
        body = _ipp_ok_response(7, job_id=999, state=9, reasons=("none",))
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation
        assert "999" in observation["reason"] and "42" in observation["reason"]

    def test_f2_matching_job_id_state_9_with_none_reason_completes(self):
        body = _ipp_ok_response(7, job_id=42, state=9, reasons=("none",))
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_COMPLETED, observation

    def test_f2_missing_job_id_attribute_is_waiting(self):
        body = _ipp_ok_response(7, state=9, reasons=("none",), include_job_id=False)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation

    def test_f2_duplicate_job_id_attribute_is_waiting(self):
        base = _ipp_ok_response(7, job_id=42, state=9, reasons=("none",))[:-1]  # strip end tag
        extra = _ipp_attr(0x21, b"job-id", (42).to_bytes(4, "big", signed=True))
        body = base + extra + b"\x03"
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation

    def test_f2_job_id_wrong_value_tag_is_waiting(self):
        body = _ipp_ok_response(7, job_id=42, state=9, reasons=("none",), job_id_tag=0x44)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation

    @pytest.mark.parametrize("state", [7, 8])
    def test_f2_failed_states_still_require_a_matching_job_id(self, state):
        body = _ipp_ok_response(7, job_id=999, state=state, reasons=())
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation

    @pytest.mark.parametrize("state", [7, 8])
    def test_f2_failed_states_need_no_well_formed_reasons_once_job_id_matches(self, state):
        body = _ipp_ok_response(7, job_id=42, state=state, reasons=())
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_FAILED, observation

    def test_f2_end_to_end_through_poll_awaiting_wrong_job_never_completes(self):
        """The brief's acceptance vector: a queued lp job (job-id 42) polled
        against a misrouted answer about job 999 must stay running."""
        ex, gateway, clock = _accept_ipp_job()
        printer = FakeIppPrinter(job_id=999, state=9, reasons=("none",))
        _poll(ex, printer)

        assert "job-ipp" in ex.awaiting_completion()
        assert _statuses(gateway) == ["running"]
        assert len(_bundles(gateway)) == 1

    def test_f2_end_to_end_matching_job_id_completes_exactly_once(self):
        ex, gateway, clock = _accept_ipp_job()
        printer = FakeIppPrinter(job_id=42, state=9, reasons=("job-completed-successfully",))
        _poll(ex, printer)

        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running", "completed"]
        bundle = _bundles(gateway)[-1]
        assert EVENT_EXECUTION_COMPLETED in _types(bundle)


class TestF2IppReasonsStrictness:
    """RFC 8011 sec 5.3.8: job-state-reasons is REQUIRED; missing, duplicated,
    empty or wrongly tagged reasons must never be read as safe."""

    def test_f2_completed_missing_reasons_is_waiting(self):
        body = _ipp_ok_response(7, job_id=42, state=9, reasons=())
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation

    def test_f2_completed_empty_reasons_value_is_waiting(self):
        body = _ipp_ok_response(7, job_id=42, state=9, reasons=("",))
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation

    def test_f2_completed_wrongly_tagged_reasons_is_waiting(self):
        body = _ipp_ok_response(7, job_id=42, state=9, reasons=("none",), reasons_tag=0x21)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation

    def test_f2_completed_duplicated_reasons_attribute_is_waiting(self):
        base = _ipp_ok_response(7, job_id=42, state=9, reasons=("none",))[:-1]
        extra = _ipp_attr(0x44, b"job-state-reasons", b"none")
        body = base + extra + b"\x03"
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation

    @pytest.mark.parametrize("reasons,expected", [
        pytest.param(("none",), POLL_COMPLETED, id="none"),
        pytest.param(("job-completed-successfully",), POLL_COMPLETED, id="successfully"),
        pytest.param(("job-completed-with-warnings",), POLL_UNOBSERVABLE, id="with-warnings"),
        pytest.param(("job-completed-with-errors",), POLL_FAILED, id="with-errors"),
        pytest.param(("completed-with-errors",), POLL_FAILED, id="with-errors-table-15"),
        pytest.param(("queued-in-device",), POLL_UNOBSERVABLE, id="queued-in-device"),
        pytest.param(("job-canceled-by-user",), POLL_FAILED, id="canceled-by-user"),
        pytest.param(("job-canceled-by-operator",), POLL_FAILED, id="canceled-by-operator"),
        pytest.param(("job-canceled-at-device",), POLL_FAILED, id="canceled-at-device"),
        pytest.param(("aborted-by-system",), POLL_FAILED, id="aborted-by-system"),
        pytest.param(("processing-to-stop-point",), POLL_FAILED, id="processing-to-stop-point"),
    ])
    def test_f2_reason_vocabulary_at_state_9(self, reasons, expected):
        body = _ipp_ok_response(7, job_id=42, state=9, reasons=reasons)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == expected, observation

# ---------------------------------------------------------------------------
# Finding 5: poll deadlines (Opentrons run poll; IPP/OctoPrint completion poll)
# ---------------------------------------------------------------------------

OT_DEVICE = {"id": "ot1", "protocol": "opentrons", "url": "http://ot"}


def _ot_router(actions_body=None, runs_body=None, run_id="run-1"):
    actions_body = actions_body or {"data": {"id": run_id}}
    runs_body = runs_body or {"data": {"id": run_id}}

    def fake_http(method, url, **kwargs):
        if url.endswith("/actions"):
            return 201, actions_body
        if url.endswith("/runs"):
            return 201, runs_body
        raise AssertionError(f"unexpected poll call before override: {method} {url}")

    return fake_http


class TestF5OpentronsRunPollDeadlines:
    def test_f5_run_poll_timeout_is_clamped_to_3600(self):
        device = {**OT_DEVICE, "runPollTimeout": 999999, "runPollInterval": 1}
        clock = FakeClock(0.0)

        def ever_later():
            clock.advance(10_000_000)
            return clock.now

        seen = []

        def fake_http(method, url, **kwargs):
            if url.endswith("/actions"):
                return 201, {"data": {"id": "run-1"}}
            if url.endswith("/runs"):
                return 201, {"data": {"id": "run-1"}}
            seen.append(url)
            return 200, {"data": {"id": "run-1", "status": "running"}}

        ex = JobExecutor(devices=[], clock=ever_later, sleep=lambda s: None)
        with mock.patch("pcc_node.http_util.http", side_effect=fake_http):
            result = ex._execute_opentrons(device, {"id": "j", "parameters": {"protocolId": "p"}})

        assert not seen, "the run was polled after its already-clamped budget was spent"
        assert result["status"] == "running"
        assert "3600" in result["note"]
        assert "999999" not in result["note"]

    def test_f5_zero_poll_interval_is_clamped_and_does_not_flood(self):
        device = {**OT_DEVICE, "runPollTimeout": 2, "runPollInterval": 0}
        seen_polls = []

        def fake_http(method, url, **kwargs):
            if url.endswith("/actions"):
                return 201, {"data": {"id": "run-1"}}
            if url.endswith("/runs"):
                return 201, {"data": {"id": "run-1"}}
            seen_polls.append(url)
            return 200, {"data": {"id": "run-1", "status": "running"}}

        ex = JobExecutor(devices=[], clock=lambda: 1000.0, sleep=lambda s: None)
        with mock.patch("pcc_node.http_util.http", side_effect=fake_http):
            result = ex._execute_opentrons(device, {"id": "j", "parameters": {"protocolId": "p"}})

        # int(2 / MIN_POLL_INTERVAL_S) + 1 bounds the request count even
        # though the clock never advances on its own.
        assert 1 <= len(seen_polls) <= 5, seen_polls
        assert result["status"] == "running"

    def test_f5_poll_request_timeout_has_no_one_second_floor(self):
        device = {**OT_DEVICE, "runPollTimeout": 0.3, "runPollInterval": 0.5}
        calls = []

        def fake_http(method, url, **kwargs):
            if url.endswith("/actions"):
                return 201, {"data": {"id": "run-1"}}
            if url.endswith("/runs"):
                return 201, {"data": {"id": "run-1"}}
            calls.append(kwargs.get("timeout"))
            return 200, {"data": {"id": "run-1", "status": "running"}}

        ex = JobExecutor(devices=[], clock=FakeClock(1000.0), sleep=lambda s: None)
        with mock.patch("pcc_node.http_util.http", side_effect=fake_http):
            ex._execute_opentrons(device, {"id": "j", "parameters": {"protocolId": "p"}})

        assert calls, "the run was never polled"
        assert all(c == pytest.approx(0.3) for c in calls), calls
        assert all(c < 1.0 for c in calls), "a sub-1s remaining budget must not be floored to 1.0s"

    def test_f5_no_poll_request_once_remaining_is_non_positive(self):
        device = {**OT_DEVICE, "runPollTimeout": 5, "runPollInterval": 1}
        calls = []
        clock = FakeClock(1000.0)

        def clock_then_jump():
            value = clock.now
            clock.now += 100
            return value

        def fake_http(method, url, **kwargs):
            if url.endswith("/actions"):
                return 201, {"data": {"id": "run-1"}}
            if url.endswith("/runs"):
                return 201, {"data": {"id": "run-1"}}
            calls.append(url)
            return 200, {"data": {"id": "run-1", "status": "succeeded"}}

        ex = JobExecutor(devices=[], clock=clock_then_jump, sleep=lambda s: None)
        with mock.patch("pcc_node.http_util.http", side_effect=fake_http):
            result = ex._execute_opentrons(device, {"id": "j", "parameters": {"protocolId": "p"}})

        assert not calls, "a request was made after the deadline had already passed"
        assert result["status"] == "running"

    def test_f5_answer_arriving_after_deadline_is_discarded_even_if_succeeded(self):
        device = {**OT_DEVICE, "runPollTimeout": 5, "runPollInterval": 0.5}
        clock = FakeClock(1000.0)

        def fake_http(method, url, **kwargs):
            if url.endswith("/actions"):
                return 201, {"data": {"id": "run-1"}}
            if url.endswith("/runs"):
                return 201, {"data": {"id": "run-1"}}
            clock.advance(10)  # the device took far longer than the budget
            return 200, {"data": {"id": "run-1", "status": "succeeded"}}

        ex = JobExecutor(devices=[], clock=clock, sleep=lambda s: None)
        with mock.patch("pcc_node.http_util.http", side_effect=fake_http):
            result = ex._execute_opentrons(device, {"id": "j", "parameters": {"protocolId": "p"}})

        assert result["status"] == "running"
        assert result.get("runStatus") != "succeeded"
        assert classify_execution_result(result) != RESULT_SUCCESS
        bundle = build_evidence_bundle("job-late", OT_DEVICE, result)
        assert EVENT_EXECUTION_COMPLETED not in _types(bundle)

    def test_f5_a_terminal_body_about_another_run_id_is_ignored(self):
        device = {**OT_DEVICE, "runPollTimeout": 1, "runPollInterval": 0.5}

        def fake_http(method, url, **kwargs):
            if url.endswith("/actions"):
                return 201, {"data": {"id": "run-1"}}
            if url.endswith("/runs"):
                return 201, {"data": {"id": "run-1"}}
            return 200, {"data": {"id": "some-other-run", "status": "succeeded"}}

        ex = JobExecutor(devices=[], clock=FakeClock(1000.0), sleep=lambda s: None)
        with mock.patch("pcc_node.http_util.http", side_effect=fake_http):
            result = ex._execute_opentrons(device, {"id": "j", "parameters": {"protocolId": "p"}})

        assert result["status"] == "running"
        assert classify_execution_result(result) != RESULT_SUCCESS


class TestF5CompletionPollDeadlines:
    """IPP/OctoPrint completion polls: request timeout is min(10, remaining);
    an answer that arrives after the deadline is discarded, even completed."""

    def test_f5_ipp_poll_request_timeout_is_min_10_and_remaining(self):
        ex, gateway, clock = _accept_ipp_job(timeout_override=3)
        captured = {}

        def fake_http_bytes(method, url, **kwargs):
            captured["timeout"] = kwargs.get("timeout")
            return 200, b""

        with mock.patch("pcc_node.http_util.http_bytes", side_effect=fake_http_bytes):
            ex.poll_awaiting()

        assert captured.get("timeout") == pytest.approx(min(COMPLETION_POLL_REQUEST_TIMEOUT_S, 3))

    def test_f5_ipp_answer_after_deadline_is_dropped_without_status_even_if_completed(self):
        ex, gateway, clock = _accept_ipp_job(timeout_override=100)

        def _late_answer(req, *a, **k):
            clock.advance(1000)  # far past the 100s budget by the time it answers
            request_id = int.from_bytes(req.data[4:8], "big", signed=True)
            return _Resp(200, _ipp_ok_response(
                request_id, job_id=42, state=9, reasons=("job-completed-successfully",),
            ))

        with mock.patch("pcc_node.http_util.urlopen", side_effect=_late_answer):
            ex.poll_awaiting()

        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running"]
        assert len(_bundles(gateway)) == 1


# ---------------------------------------------------------------------------
# Prior-findings edge-matrix spot checks not otherwise covered above
# ---------------------------------------------------------------------------


class TestEdgeMatrixSpotChecks:
    def test_edge_ipp_state_6_with_matching_job_id_is_waiting(self):
        body = _ipp_ok_response(7, job_id=42, state=6, reasons=())
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation

    def test_edge_ipp_request_id_not_ours_is_waiting(self):
        body = _ipp_ok_response(7, job_id=42, state=9, reasons=("none",))
        verdict, observation = ipp_completion_verdict(200, body, 99, 42)
        assert verdict == POLL_WAITING, observation

    def test_edge_ipp_malformed_body_is_waiting_not_raising(self):
        verdict, observation = ipp_completion_verdict(200, b"not ipp", 7, 42)
        assert verdict == POLL_WAITING, observation

    def test_edge_generic_http_deep_nested_error_still_a_failure(self):
        body = {"a": {"b": {"c": {"d": {"error": "jam"}}}}}
        result = _gh_execute(GH_DEVICE, (200, body))
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_edge_generic_http_completed_at_exactly_5000_nodes_is_readable(self):
        body = {f"f{i}": i for i in range(DEVICE_BODY_MAX_NODES - 2)}
        body["status"] = "completed"
        result = _gh_execute(GH_DEVICE, (200, body))
        # readable (not bounded-out): without a contract this still cannot
        # complete, but it must fail as unclassifiable, not as "too large".
        assert result.get("error") is None or "too large" not in result.get("error", "")
        assert classify_execution_result(result) != RESULT_SUCCESS
