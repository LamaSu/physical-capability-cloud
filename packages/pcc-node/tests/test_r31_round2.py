"""Round-2 tests against the r31-pccnode-r2-astra DO-NOT-SHIP verdict.

Source: /mnt/sparkbulk/pcc-reconciliation/review-router/r31-pccnode-r2-astra/verdict.md

One test per attack / edge-matrix row, named after the finding it targets:
  f1 = generic HTTP completion (nested-queue bypass, contract validation)
  f2 = IPP job-id binding + job-state-reasons strictness
  f3 = OctoPrint private-copy + print-history correlation
  f4 = http_util strict parsing (duplicate keys / NaN) + device-body bound
  f5 = poll deadlines (Opentrons run poll, IPP/OctoPrint completion poll)

Only pcc_node.http_util's urlopen / http / http_bytes / http_form are faked
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

from pcc_node.http_util import http, http_bytes, http_form, parse_json_strict
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
    GENERIC_ACCEPTANCE_STATUS_VALUES,
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


OP_KEY = "SECRET-OCTOPRINT-KEY"
OP_DEVICE = {"id": "op1", "protocol": "octoprint", "url": "http://10.0.0.20:5000", "api_key": OP_KEY}


def _accept_octoprint_job(job_id="job-op", filename="benchy.gcode", device=None,
                           gateway=None, clock=None,
                           create_status=201, copy_status=201,
                           get_status=200, get_body=None,
                           select_status=200, select_body=None):
    """Drives execute() through the real 4-step OctoPrint adapter, faking
    only http_form/http.  Returns (ex, gateway, clock, calls, print_path)."""
    gateway = gateway or _gateway()
    clock = clock or FakeClock()
    device = dict(device or OP_DEVICE)
    ex = JobExecutor(devices=[device], gateway_client=gateway, clock=clock)
    base_url = device["url"]
    folder = je.octoprint_job_folder(job_id)
    name = filename.rsplit("/", 1)[-1]
    print_path = f"{folder}/{name}"
    calls = []

    def fake_http_form(method, url, fields, **kwargs):
        calls.append(("form", method, url, dict(fields), kwargs.get("headers")))
        return create_status, {}

    def fake_http(method, url, **kwargs):
        calls.append(("http", method, url, kwargs.get("body"), kwargs.get("headers")))
        copy_url = f"{base_url}/api/files/local/{filename}"
        copy_get_select_url = f"{base_url}/api/files/local/{print_path}"
        if method == "POST" and url == copy_url:
            return copy_status, {}
        if method == "GET" and url == copy_get_select_url:
            body = get_body if get_body is not None else {}
            return get_status, body
        if method == "POST" and url == copy_get_select_url:
            body = select_body if select_body is not None else {}
            return select_status, body
        raise AssertionError(f"unexpected http call: {method} {url}")

    with mock.patch("pcc_node.http_util.http_form", side_effect=fake_http_form), \
         mock.patch("pcc_node.http_util.http", side_effect=fake_http):
        ex.execute({"id": job_id, "capabilityType": "3d-print",
                    "parameters": {"filename": filename}})
    return ex, gateway, clock, calls, print_path, folder


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

    def test_f4_http_form_sends_multipart_text_fields(self):
        with mock.patch("pcc_node.http_util.urlopen",
                        return_value=_Resp(201, b"")) as mock_open:
            status, data = http_form("POST", "http://dev/api/files/local",
                                     {"foldername": "pcc-job1"})
        assert status == 201
        req = mock_open.call_args[0][0]
        assert req.get_method() == "POST"
        content_type = req.get_header("Content-type")
        assert content_type.startswith("multipart/form-data; boundary=")
        body_text = req.data.decode("utf-8")
        assert 'name="foldername"' in body_text
        assert "pcc-job1" in body_text

    def test_f4_http_form_answer_handling_matches_http(self):
        """The answer is read exactly like http(): duplicate keys refused."""
        raw = b'{"status":"failed","status":"completed"}'
        with mock.patch("pcc_node.http_util.urlopen", return_value=_Resp(200, raw)):
            status, data = http_form("POST", "http://dev/api/files/local", {"a": "b"})
        assert isinstance(data, str)

    def test_f4_http_form_oversized_answer_is_status_zero(self):
        raw = b"x" * 50
        with mock.patch("pcc_node.http_util.urlopen", return_value=_Resp(201, raw)):
            status, data = http_form("POST", "http://dev", {"a": "b"}, max_bytes=10)
        assert status == 0
        assert "larger than" in data["error"]


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
        """{"status":"completed"} alone: without a contract, generic HTTP
        completes a job only under a reviewed per-device contract."""
        result = _gh_execute(GH_DEVICE, (200, {"status": "completed"}))
        assert result.get("executed") is not True
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE

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
        """204 has no content by definition (RFC 9110 sec 15.3.5): it states
        no outcome, whatever a parsed body next to it might claim."""
        result = _gh_execute(GH_DEVICE, (204, {"status": "completed"}))
        assert result.get("executed") is not True
        assert result.get("submitted") is not True
        assert classify_execution_result(result) != RESULT_SUCCESS

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


class TestF1ContractValidation:
    """validate_completion_contract is strict: an unreviewed or self-defeating
    contract runs nothing."""

    VALID = {
        "version": 1, "method": "POST", "path": "/run",
        "completionField": "result.phase", "completionValues": ["finished"],
        "correlationField": "result.jobId",
    }

    def test_f1_a_well_formed_contract_is_valid(self):
        assert je.validate_completion_contract(self.VALID) is None

    def test_f1_contract_naming_an_acceptance_value_as_completion_is_invalid(self):
        """device={"completionContract":{...,"completionField":"state",
        "completionValues":["queued"],...}} from the brief."""
        contract = {**self.VALID, "completionField": "state", "completionValues": ["queued"]}
        problem = je.validate_completion_contract(contract)
        assert problem is not None and "queued" in problem

    @pytest.mark.parametrize("word", sorted(GENERIC_ACCEPTANCE_STATUS_VALUES))
    def test_f1_contract_naming_any_acceptance_word_is_invalid(self, word):
        contract = {**self.VALID, "completionValues": [word]}
        assert je.validate_completion_contract(contract) is not None

    @pytest.mark.parametrize("word", sorted(FAILURE_STATUS_VALUES))
    def test_f1_contract_naming_any_failure_word_is_invalid(self, word):
        contract = {**self.VALID, "completionValues": [word]}
        assert je.validate_completion_contract(contract) is not None

    @pytest.mark.parametrize("value", [False, 1.5, None, {}, []])
    def test_f1_completion_values_with_unusable_entries_are_invalid(self, value):
        contract = {**self.VALID, "completionValues": [value]}
        assert je.validate_completion_contract(contract) is not None

    def test_f1_completion_values_must_be_a_non_empty_list(self):
        assert je.validate_completion_contract({**self.VALID, "completionValues": []}) is not None

    def test_f1_true_is_a_valid_completion_value(self):
        contract = {**self.VALID, "completionValues": [True]}
        assert je.validate_completion_contract(contract) is None

    def test_f1_non_bool_int_is_a_valid_completion_value(self):
        contract = {**self.VALID, "completionValues": [3]}
        assert je.validate_completion_contract(contract) is None

    @pytest.mark.parametrize("version", [2, 0, -1, "1", 1.0, None])
    def test_f1_only_version_1_int_is_valid(self, version):
        assert je.validate_completion_contract({**self.VALID, "version": version}) is not None

    @pytest.mark.parametrize("method", ["GET", "DELETE", "HEAD", "patch-typo", 7])
    def test_f1_method_must_be_post_put_or_patch(self, method):
        assert je.validate_completion_contract({**self.VALID, "method": method}) is not None

    @pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "post", "put", "patch"])
    def test_f1_method_is_case_insensitive(self, method):
        assert je.validate_completion_contract({**self.VALID, "method": method}) is None

    @pytest.mark.parametrize("path", [
        "relative/path", "http://dev/run", "/a/../b", "/has space", "", None, 7,
    ])
    def test_f1_path_must_be_a_clean_absolute_path(self, path):
        assert je.validate_completion_contract({**self.VALID, "path": path}) is not None

    def test_f1_completion_field_and_correlation_field_must_differ(self):
        contract = {**self.VALID, "correlationField": self.VALID["completionField"]}
        problem = je.validate_completion_contract(contract)
        assert problem is not None and "differ" in problem

    @pytest.mark.parametrize("field", ["", None, "  ", "a..b", 7])
    def test_f1_completion_field_must_be_a_usable_dot_path(self, field):
        assert je.validate_completion_contract({**self.VALID, "completionField": field}) is not None

    def test_f1_unknown_contract_key_is_invalid(self):
        contract = {**self.VALID, "extraField": "nope"}
        problem = je.validate_completion_contract(contract)
        assert problem is not None and "unknown" in problem.lower()

    def test_f1_missing_required_key_is_invalid(self):
        contract = dict(self.VALID)
        del contract["completionField"]
        problem = je.validate_completion_contract(contract)
        assert problem is not None and "missing" in problem.lower()

    def test_f1_correlation_request_field_with_a_dot_is_invalid(self):
        contract = {**self.VALID, "correlationRequestField": "a.b"}
        assert je.validate_completion_contract(contract) is not None

    def test_f1_non_dict_contract_is_invalid(self):
        assert je.validate_completion_contract("not a contract") is not None
        assert je.validate_completion_contract(None) is not None

    def test_f1_invalid_contract_refuses_the_job_with_no_http_request(self):
        device = {
            "id": "g1", "protocol": "http", "url": "http://dev",
            "completionContract": {
                "version": 1, "method": "POST", "path": "/run",
                "completionField": "state", "completionValues": ["queued"],
                "correlationField": "jobId",
            },
        }
        with mock.patch("pcc_node.http_util.http") as fake_http:
            result = JobExecutor(devices=[])._execute_generic_http(
                device, {"id": "job-inv", "parameters": {}})
        fake_http.assert_not_called()
        assert result.get("executed") is not True
        assert "contract" in result.get("error", "").lower()
        assert classify_execution_result(result) == RESULT_FAILURE


class TestF1ContractOutcome:
    """A validated contract: correlated completion field match required;
    method/path locked to the contract; conflicting statements refuse."""

    CONTRACT_DEVICE = {
        "id": "g1", "protocol": "http", "url": "http://dev",
        "completionContract": {
            "version": 1, "method": "POST", "path": "/run",
            "completionField": "state", "completionValues": ["done"],
            "correlationField": "jobId",
        },
    }

    def _run(self, status_and_data, job=None, device=None, job_id="job-c1"):
        status, data = status_and_data
        calls = []

        def fake_http(method, url, **kwargs):
            calls.append((method, url, kwargs.get("body"), kwargs.get("headers")))
            return status, data

        job = job or {"id": job_id, "parameters": {}}
        with mock.patch("pcc_node.http_util.http", side_effect=fake_http):
            result = JobExecutor(devices=[])._execute_generic_http(device or self.CONTRACT_DEVICE, job)
        return result, calls

    def test_f1_state_done_with_matching_job_id_completes(self):
        """{"state":"done","jobId":"<this job id>"} with completionField
        "state", completionValues ["done"], correlationField "jobId" DOES
        complete -- the brief's positive control."""
        result, calls = self._run((200, {"state": "done", "jobId": "job-c1"}))
        assert result.get("executed") is True, result
        assert classify_execution_result(result) == RESULT_SUCCESS
        assert result["contract"] == {
            "version": 1, "completionField": "state", "correlationField": "jobId",
        }
        bundle = build_evidence_bundle("job-c1", self.CONTRACT_DEVICE, result)
        assert EVENT_EXECUTION_COMPLETED in _types(bundle)

    def test_f1_state_done_without_the_correlation_echo_never_completes(self):
        result, calls = self._run((200, {"state": "done"}))
        assert result.get("executed") is not True, result
        assert classify_execution_result(result) != RESULT_SUCCESS

    def test_f1_state_done_echoing_another_jobs_id_never_completes(self):
        result, calls = self._run((200, {"state": "done", "jobId": "someone-elses-job"}))
        assert result.get("executed") is not True, result
        assert classify_execution_result(result) != RESULT_SUCCESS

    def test_f1_completion_field_matching_but_acceptance_stated_elsewhere_is_a_conflict(self):
        body = {"state": "done", "jobId": "job-c1", "data": {"status": "queued"}}
        result, _ = self._run((200, body))
        assert result.get("executed") is not True, result
        assert classify_execution_result(result) != RESULT_SUCCESS

    def test_f1_completion_field_holding_an_acceptance_word_is_accepted(self):
        result, _ = self._run((200, {"state": "queued", "jobId": "job-c1"}))
        assert result.get("submitted") is True
        assert "executed" not in result
        assert classify_execution_result(result) == RESULT_ACCEPTED

    def test_f1_completion_field_holding_neither_is_unclassifiable(self):
        result, _ = self._run((200, {"state": "homing", "jobId": "job-c1"}))
        assert result.get("executed") is not True
        assert result.get("submitted") is not True
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE

    def test_f1_nested_queued_two_levels_deep_never_completes_with_contract(self):
        """The brief's second required attack, with a contract present."""
        body = {"state": "done", "jobId": "job-c1", "data": {"result": {"status": "queued"}}}
        result, _ = self._run((200, body))
        assert result.get("executed") is not True, result
        assert classify_execution_result(result) != RESULT_SUCCESS

    def test_f1_a_failure_stated_anywhere_outranks_the_contract(self):
        body = {"state": "done", "jobId": "job-c1", "error": "actuator jammed"}
        result, _ = self._run((200, body))
        assert result.get("executed") is not True
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_f1_202_is_accepted_regardless_of_the_contract(self):
        result, _ = self._run((202, {"state": "done", "jobId": "job-c1"}))
        assert result.get("submitted") is True
        assert "executed" not in result
        assert classify_execution_result(result) == RESULT_ACCEPTED

    def test_f1_204_never_completes_regardless_of_the_contract(self):
        result, _ = self._run((204, {"state": "done", "jobId": "job-c1"}))
        assert result.get("executed") is not True
        assert classify_execution_result(result) != RESULT_SUCCESS

    def test_f1_transport_failure_is_a_failure_regardless_of_the_contract(self):
        result, _ = self._run((0, {"error": "conn refused"}))
        assert result.get("executed") is not True
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_f1_request_uses_the_contracts_method_and_path(self):
        job = {"id": "job-c1", "parameters": {}}
        result, calls = self._run((200, {"state": "done", "jobId": "job-c1"}), job=job)
        assert calls, "no HTTP request was made"
        [(method, url, body, headers)] = calls
        assert method == "POST"
        assert url == "http://dev/run"

    def test_f1_request_carries_the_correlation_header(self):
        result, calls = self._run((200, {"state": "done", "jobId": "job-c1"}))
        [(method, url, body, headers)] = calls
        assert headers is not None
        assert headers.get(je.CORRELATION_HEADER) == "job-c1" or (
            "X-PCC-Job-Id" in {k for k in headers} and headers.get("X-PCC-Job-Id") == "job-c1"
        )

    def test_f1_job_naming_a_different_method_is_refused_with_no_request(self):
        job = {"id": "job-c1", "parameters": {"method": "PATCH"}}
        with mock.patch("pcc_node.http_util.http") as fake_http:
            result = JobExecutor(devices=[])._execute_generic_http(self.CONTRACT_DEVICE, job)
        fake_http.assert_not_called()
        assert result.get("executed") is not True
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_f1_job_naming_a_different_path_is_refused_with_no_request(self):
        job = {"id": "job-c1", "parameters": {"path": "/other"}}
        with mock.patch("pcc_node.http_util.http") as fake_http:
            result = JobExecutor(devices=[])._execute_generic_http(self.CONTRACT_DEVICE, job)
        fake_http.assert_not_called()
        assert result.get("executed") is not True

    def test_f1_job_naming_the_contracts_own_method_and_path_is_allowed(self):
        job = {"id": "job-c1", "parameters": {"method": "POST", "path": "/run"}}
        result, calls = self._run((200, {"state": "done", "jobId": "job-c1"}), job=job)
        assert calls
        assert classify_execution_result(result) == RESULT_SUCCESS

    def test_f1_correlation_request_field_is_set_in_the_body(self):
        device = {
            "id": "g1", "protocol": "http", "url": "http://dev",
            "completionContract": {
                "version": 1, "method": "POST", "path": "/run",
                "completionField": "state", "completionValues": ["done"],
                "correlationField": "jobId", "correlationRequestField": "jobId",
            },
        }
        job = {"id": "job-echo", "parameters": {"body": {"payload": "x"}}}
        result, calls = self._run(
            (200, {"state": "done", "jobId": "job-echo"}), job=job, device=device,
            job_id="job-echo",
        )
        [(method, url, body, headers)] = calls
        assert body["jobId"] == "job-echo"
        assert body["payload"] == "x"

    def test_f1_correlation_request_field_already_holding_a_different_id_is_refused(self):
        device = {
            "id": "g1", "protocol": "http", "url": "http://dev",
            "completionContract": {
                "version": 1, "method": "POST", "path": "/run",
                "completionField": "state", "completionValues": ["done"],
                "correlationField": "jobId", "correlationRequestField": "jobId",
            },
        }
        job = {"id": "job-echo", "parameters": {"body": {"jobId": "not-this-job"}}}
        with mock.patch("pcc_node.http_util.http") as fake_http:
            result = JobExecutor(devices=[])._execute_generic_http(device, job)
        fake_http.assert_not_called()
        assert result.get("executed") is not True


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
        pytest.param(("job-completed-with-warnings",), POLL_COMPLETED, id="with-warnings"),
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
# Finding 3: OctoPrint private copy + print-history correlation
# ---------------------------------------------------------------------------


class TestF3OctoPrintJobFolder:
    def test_f3_folder_name_is_pcc_prefixed_and_sanitized(self):
        assert je.octoprint_job_folder("job-abc123") == "pcc-job-abc123"

    def test_f3_unsafe_characters_are_replaced_with_underscore(self):
        folder = je.octoprint_job_folder("job with spaces/slash!")
        assert folder == "pcc-job_with_spaces_slash_"
        assert " " not in folder and "/" not in folder and "!" not in folder

    def test_f3_two_different_job_ids_never_share_a_folder(self):
        assert je.octoprint_job_folder("job-a") != je.octoprint_job_folder("job-b")


class TestF3OctoPrintPrivateCopyExecute:
    """The adapter never prints the requested file directly: it creates a
    per-job folder, copies the file into it, reads a baseline, then selects
    and prints the copy -- stopping at the first failed step."""

    def test_f3_happy_path_makes_all_four_calls_in_order(self):
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(
            job_id="job-op1", filename="benchy.gcode",
            get_body={"prints": {"success": 2, "failure": 0}},
        )
        assert folder == "pcc-job-op1"
        assert print_path == "pcc-job-op1/benchy.gcode"
        kinds = [(c[0], c[1], c[2]) for c in calls]
        assert kinds == [
            ("form", "POST", "http://10.0.0.20:5000/api/files/local"),
            ("http", "POST", "http://10.0.0.20:5000/api/files/local/benchy.gcode"),
            ("http", "GET", f"http://10.0.0.20:5000/api/files/local/{print_path}"),
            ("http", "POST", f"http://10.0.0.20:5000/api/files/local/{print_path}"),
        ]
        assert calls[0][3] == {"foldername": folder}
        assert calls[1][3] == {"command": "copy", "destination": folder}
        assert calls[3][3] == {"command": "select", "print": True}

    def test_f3_result_carries_print_path_and_baseline(self):
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(
            get_body={"prints": {"success": 3, "failure": 1}},
        )
        entry = ex.awaiting_completion()["job-op"]
        assert entry["handle"] == {
            "base_url": "http://10.0.0.20:5000",
            "path": print_path,
            "baseline": {"success": 3, "failure": 1},
        }

    def test_f3_missing_prints_key_is_a_zero_zero_baseline(self):
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(get_body={})
        entry = ex.awaiting_completion()["job-op"]
        assert entry["handle"]["baseline"] == {"success": 0, "failure": 0}

    def test_f3_folder_creation_failure_stops_with_no_later_request(self):
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(create_status=500)
        assert len(calls) == 1 and calls[0][0] == "form"
        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running", "failed"]

    def test_f3_copy_failure_stops_with_no_get_or_select(self):
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(copy_status=500)
        # Exactly the form call plus the failed copy call -- no GET, no select.
        assert len(calls) == 2
        assert calls[1][1] == "POST"
        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running", "failed"]

    def test_f3_copy_answering_200_instead_of_201_is_refused(self):
        """SPEC: the copy step must answer 201 exactly (200 is not enough)."""
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(copy_status=200)
        assert len(calls) == 2
        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running", "failed"]

    def test_f3_unreadable_baseline_stops_before_select(self):
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(
            get_body={"prints": {"success": "not-a-number", "failure": 0}},
        )
        assert len(calls) == 3, calls
        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running", "failed"]

    def test_f3_negative_baseline_counts_are_refused(self):
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(
            get_body={"prints": {"success": -1, "failure": 0}},
        )
        assert len(calls) == 3
        assert ex.awaiting_completion() == {}

    @pytest.mark.parametrize("select_status", [200, 201, 204])
    def test_f3_select_accepts_200_201_or_204(self, select_status):
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(
            select_status=select_status, get_body={"prints": {"success": 0, "failure": 0}},
        )
        assert "job-op" in ex.awaiting_completion()
        assert _statuses(gateway) == ["running"]

    def test_f3_select_failure_still_leaves_the_copy_made(self):
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(
            select_status=500, get_body={"prints": {"success": 0, "failure": 0}},
        )
        assert len(calls) == 4
        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running", "failed"]

    def test_f3_poll_reads_the_private_copy_not_api_job(self):
        """Each poll is one GET .../api/files/local/<path>; /api/job is never read."""
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(
            get_body={"prints": {"success": 0, "failure": 0}},
        )
        seen = []

        def fake_get(req, *a, **k):
            seen.append(req.full_url)
            return _Resp(200, _json_bytes({"path": print_path, "origin": "local",
                                           "prints": {"success": 1, "failure": 0,
                                                      "last": {"success": True}}}))

        with mock.patch("pcc_node.http_util.urlopen", side_effect=fake_get):
            ex.poll_awaiting()

        assert len(seen) == 1
        assert seen[0] == f"http://10.0.0.20:5000/api/files/local/{print_path}"
        assert "/api/job" not in seen[0]
        assert _statuses(gateway) == ["running", "completed"]


class TestF3OctoPrintHistoryVerdict:
    """octoprint_history_verdict reads durable print-history counts, not a
    transient current-job snapshot -- so a print instance is never confused
    with a file."""

    PATH = "pcc-job1/benchy.gcode"
    BASELINE = {"success": 0, "failure": 0}

    def _verdict(self, body, baseline=None, status=200, path=None):
        return je.octoprint_history_verdict(status, body, path or self.PATH, baseline or self.BASELINE)

    def test_f3_cancelled_then_reprinted_between_polls_is_failed(self):
        """Required attack: a cancelled print followed by a successful
        re-print between two polls (success +1 and failure +1) -> FAILED."""
        body = {"path": self.PATH, "origin": "local",
                "prints": {"success": 1, "failure": 1, "last": {"success": True}}}
        verdict, reason = self._verdict(body)
        assert verdict == POLL_FAILED, reason

    def test_f3_history_unchanged_never_completes(self):
        """Required attack: history unchanged while /api/job would say
        Operational 100% -> never completed."""
        body = {"path": self.PATH, "origin": "local", "prints": {"success": 0, "failure": 0}}
        verdict, reason = self._verdict(body)
        assert verdict == POLL_WAITING, reason

    def test_f3_disconnect_then_later_success_completes_only_then(self):
        """Required attack: a disconnect (status 0) then a later answer with
        success +1 -> COMPLETED only then."""
        verdict1, reason1 = self._verdict({}, status=0)
        assert verdict1 == POLL_WAITING, reason1
        body = {"path": self.PATH, "origin": "local",
                "prints": {"success": 1, "failure": 0, "last": {"success": True}}}
        verdict2, reason2 = self._verdict(body)
        assert verdict2 == POLL_COMPLETED, reason2

    def test_f3_success_increment_without_last_success_true_is_waiting(self):
        body = {"path": self.PATH, "origin": "local",
                "prints": {"success": 1, "failure": 0, "last": {"success": False}}}
        verdict, reason = self._verdict(body)
        assert verdict == POLL_WAITING, reason

    def test_f3_success_increment_with_no_last_field_is_waiting(self):
        body = {"path": self.PATH, "origin": "local", "prints": {"success": 1, "failure": 0}}
        verdict, reason = self._verdict(body)
        assert verdict == POLL_WAITING, reason

    def test_f3_a_count_below_baseline_is_unobservable(self):
        """The file was replaced/reset: history went backwards."""
        body = {"path": self.PATH, "origin": "local", "prints": {"success": 0, "failure": 0}}
        verdict, reason = self._verdict(body, baseline={"success": 2, "failure": 0})
        assert verdict == POLL_UNOBSERVABLE, reason

    def test_f3_failure_above_baseline_wins_over_a_simultaneous_success_rise(self):
        body = {"path": self.PATH, "origin": "local",
                "prints": {"success": 5, "failure": 2, "last": {"success": True}}}
        verdict, reason = self._verdict(body, baseline={"success": 4, "failure": 1})
        assert verdict == POLL_FAILED, reason

    def test_f3_answer_about_a_different_path_is_waiting(self):
        body = {"path": "other-job/file.gcode", "origin": "local",
                "prints": {"success": 1, "failure": 0, "last": {"success": True}}}
        verdict, reason = self._verdict(body)
        assert verdict == POLL_WAITING, reason

    def test_f3_answer_about_a_non_local_origin_is_waiting(self):
        body = {"path": self.PATH, "origin": "sdcard",
                "prints": {"success": 1, "failure": 0, "last": {"success": True}}}
        verdict, reason = self._verdict(body)
        assert verdict == POLL_WAITING, reason

    def test_f3_non_200_is_waiting(self):
        verdict, reason = self._verdict({"prints": {"success": 1, "failure": 0}}, status=500)
        assert verdict == POLL_WAITING, reason

    def test_f3_non_dict_body_is_waiting(self):
        verdict, reason = self._verdict("not json")
        assert verdict == POLL_WAITING, reason

    def test_f3_malformed_prints_counts_are_waiting(self):
        body = {"prints": {"success": "one", "failure": 0}}
        verdict, reason = self._verdict(body)
        assert verdict == POLL_WAITING, reason


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

    def test_f5_octoprint_poll_request_timeout_is_min_10_and_remaining(self):
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(
            device={**OP_DEVICE, "completionPollTimeout": 4},
            get_body={"prints": {"success": 0, "failure": 0}},
        )
        captured = {}

        def fake_http(method, url, **kwargs):
            captured["timeout"] = kwargs.get("timeout")
            return 200, {"path": print_path, "origin": "local", "prints": {"success": 0, "failure": 0}}

        with mock.patch("pcc_node.http_util.http", side_effect=fake_http):
            ex.poll_awaiting()

        assert captured.get("timeout") == pytest.approx(min(COMPLETION_POLL_REQUEST_TIMEOUT_S, 4))

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

    def test_f5_octoprint_answer_after_deadline_is_dropped_without_status_even_if_completed(self):
        ex, gateway, clock, calls, print_path, folder = _accept_octoprint_job(
            device={**OP_DEVICE, "completionPollTimeout": 100},
            get_body={"prints": {"success": 0, "failure": 0}},
        )

        def fake_http(method, url, **kwargs):
            clock.advance(1000)  # far past the 100s budget by the time it answers
            return 200, {"path": print_path, "origin": "local",
                        "prints": {"success": 1, "failure": 0, "last": {"success": True}}}

        with mock.patch("pcc_node.http_util.http", side_effect=fake_http):
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
