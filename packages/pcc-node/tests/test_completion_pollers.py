"""Deferred completion tracking: IPP job-state and OctoPrint /api/job pollers.

A queued `lp` job and a started OctoPrint print are ACCEPTANCE, not completion
(PR #343), so execute() leaves them "running".  execute() now registers such a
job, and the daemon calls JobExecutor.poll_awaiting() once per cycle, which
asks the device ONCE per job and reports only what the DEVICE says:

  * completed  -> one bundle [execution_completed {level: device_reported}]
                  and one 'completed' status, then the job leaves the registry
  * failure    -> one bundle [execution_failed] and one 'failed' status
  * waiting    -> nothing; the job stays registered
  * deadline   -> dropped with an ERROR and NO terminal status

Fail closed: an outcome nobody observed is never a completion.  As in
test_job_executor.py, only `urlopen` (and `subprocess.run` for `lp`) is faked:
the adapters, the poller, the IPP codec, the evidence builder and execute()
all run for real underneath.
"""

import io
import json
import logging
import os
import re
import signal
from contextlib import ExitStack
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError, URLError

import pytest

from pcc_node.config import NodeConfig
from pcc_node.job_executor import (
    EVENT_EXECUTION_COMPLETED,
    EVENT_EXECUTION_FAILED,
    EVENT_EXECUTION_PROGRESS,
    EVENT_EXECUTION_STARTED,
    EVIDENCE_LEVEL_DEVICE_REPORTED,
    IPP_COMPLETION_POLL_TIMEOUT_S,
    OCTOPRINT_COMPLETION_POLL_TIMEOUT_S,
    POLL_COMPLETED,
    POLL_FAILED,
    POLL_UNOBSERVABLE,
    POLL_WAITING,
    RESULT_ACCEPTED,
    IppDecodeError,
    JobExecutor,
    classify_execution_result,
    decode_ipp_response,
    encode_ipp_get_job_attributes,
    ipp_completion_verdict,
    ipp_job_state,
    ipp_job_urls,
    octoprint_completion_verdict,
    parse_lp_request_id,
)

EXECUTOR_LOGGER = "pcc-node.job-executor"


# ---------------------------------------------------------------------------
# Shared fakes
# ---------------------------------------------------------------------------

class FakeClock:
    """Monotonic clock the tests move by hand (injected via JobExecutor(clock=))."""

    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class _Resp:
    """urlopen stand-in: context manager + read + status."""

    def __init__(self, status, raw=b""):
        self.status = status
        self._raw = raw

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _gateway(push_ack=True, completed_ack=True, failed_ack=True):
    """A gateway client whose 'running' claim always lands."""
    g = mock.Mock()
    g.push_evidence.return_value = push_ack
    acks = {"running": True, "completed": completed_ack, "failed": failed_ack}
    g.update_job_status.side_effect = lambda job_id, status, *a, **k: acks[status]
    return g


def _statuses(gateway):
    return [c.args[1] for c in gateway.update_job_status.call_args_list]


def _bundles(gateway):
    return [c.args[1] for c in gateway.push_evidence.call_args_list]


def _types(bundle):
    return [e["type"] for e in bundle["events"]]


def _text(obj):
    return json.dumps(obj, default=str)


def _messages(caplog, level):
    return [r.getMessage() for r in caplog.records if r.levelno >= level]


# ---------------------------------------------------------------------------
# IPP wire helpers (independent of the module under test)
# ---------------------------------------------------------------------------

def ipp_attr(value_tag, name, value):
    """RFC 8010 sec 3.1.4 / 3.1.5, written out by hand: tag, name-length,
    name, value-length, value -- an additional-value when name is b""."""
    return (
        bytes([value_tag])
        + len(name).to_bytes(2, "big") + name
        + len(value).to_bytes(2, "big") + value
    )


def ipp_response(job_state=None, reasons=(), status=0x0000, request_id=1,
                 version=b"\x02\x00", job_group=True, extra=b"",
                 job_state_tag=0x23, job_state_value=None):
    """A Get-Job-Attributes response: operation group, then a job group."""
    out = version + status.to_bytes(2, "big") + request_id.to_bytes(4, "big", signed=True)
    out += b"\x01"
    out += ipp_attr(0x47, b"attributes-charset", b"utf-8")
    out += ipp_attr(0x48, b"attributes-natural-language", b"en")
    if job_group:
        out += b"\x02"
        if job_state is not None or job_state_value is not None:
            value = (job_state_value if job_state_value is not None
                     else job_state.to_bytes(4, "big", signed=True))
            out += ipp_attr(job_state_tag, b"job-state", value)
        for i, reason in enumerate(reasons):
            out += ipp_attr(0x44, b"job-state-reasons" if i == 0 else b"", reason.encode())
    return out + extra + b"\x03"


# Captured from the Spark's own cupsd (cups-daemon 2.4.7) with the module's
# client: a READ-ONLY Get-Job-Attributes (request-id 7) on an existing job of
# this user that had been canceled.  No print job was created.  CUPS returned
# exactly the two requested attributes: job-state 7 and job-state-reasons.
CUPS_CANCELED_JOB_RESPONSE = bytes.fromhex(
    "020000000000000701470012617474726962757465732d63686172736574000575"
    "74662d3848001b617474726962757465732d6e61747572616c2d6c616e67756167"
    "650002656e022300096a6f622d73746174650004000000074400116a6f622d7374"
    "6174652d726561736f6e73001870726f63657373696e672d746f2d73746f702d70"
    "6f696e7403"
)


class FakeIppPrinter:
    """urlopen stand-in for an IPP printer.  Echoes the request-id it was
    sent, as RFC 8011 sec 4.1.1 requires, and answers with ``state``/
    ``reasons`` -- or raises/garbles when told to."""

    def __init__(self, state=5, reasons=()):
        self.requests = []
        self.state = state
        self.reasons = reasons
        self.fail_with = None      # an exception to raise instead
        self.raw = None            # verbatim response bytes instead
        self.ipp_status = 0x0000

    def __call__(self, req, *args, **kwargs):
        self.requests.append(req)
        if self.fail_with is not None:
            raise self.fail_with
        if self.raw is not None:
            return _Resp(200, self.raw)
        request_id = int.from_bytes(req.data[4:8], "big", signed=True)
        return _Resp(200, ipp_response(
            job_state=self.state, reasons=self.reasons,
            status=self.ipp_status, request_id=request_id,
        ))


# ---------------------------------------------------------------------------
# lp stdout -> CUPS request id
# ---------------------------------------------------------------------------

class TestParseLpRequestId:
    @pytest.mark.parametrize("stdout,expected", [
        pytest.param("request id is default-42 (1 file(s))", ("default", 42), id="canonical"),
        pytest.param("  request id is default-42 (1 file(s))  \n", ("default", 42), id="surrounding-spaces"),
        pytest.param("\n\trequest id is default-42 (1 file(s))\n\n", ("default", 42), id="newlines-and-tab"),
        pytest.param("request id is default-42", ("default", 42), id="end-of-string"),
        pytest.param("request id is HP-LaserJet-M404-7 (1 file(s))", ("HP-LaserJet-M404", 7),
                     id="hyphenated-queue-splits-at-the-last-hyphen"),
        pytest.param("request id is HP_Color_LaserJet_Pro_MFP_3301_0D253A-1 (1 file(s))",
                     ("HP_Color_LaserJet_Pro_MFP_3301_0D253A", 1), id="real-cups-queue-name"),
        pytest.param("lp: warning - foo\nrequest id is default-42 (1 file(s))\n", ("default", 42),
                     id="after-another-line"),
        pytest.param("request id is default-2147483647 (1 file(s))", ("default", 2147483647),
                     id="largest-ipp-integer"),
    ])
    def test_parses_the_queue_and_job_id(self, stdout, expected):
        assert parse_lp_request_id(stdout) == expected

    @pytest.mark.parametrize("stdout", [
        pytest.param("", id="empty-windows-notepad-path"),
        pytest.param("ok", id="no-request-id"),
        pytest.param("request ok", id="request-ok"),
        pytest.param("request id is default (1 file(s))", id="no-job-number"),
        pytest.param("request id is default-abc (1 file(s))", id="non-numeric-job"),
        pytest.param("request id is default-42x (1 file(s))", id="trailing-junk-on-the-number"),
        pytest.param("request id is -42 (1 file(s))", id="no-queue"),
        pytest.param("request id is default-0 (1 file(s))", id="job-id-zero"),
        pytest.param("request id is default-2147483648 (1 file(s))", id="job-id-beyond-ipp-integer"),
        pytest.param("xrequest id is default-42 (1 file(s))", id="not-at-a-line-start"),
        pytest.param("request id is de/fault-42 (1 file(s))", id="queue-not-url-safe"),
        pytest.param(None, id="none"),
        pytest.param(42, id="int"),
        pytest.param(b"request id is default-42 (1 file(s))", id="bytes"),
    ])
    def test_no_request_id_means_no_handle(self, stdout):
        assert parse_lp_request_id(stdout) is None


# ---------------------------------------------------------------------------
# IPP Get-Job-Attributes request: exact bytes (RFC 8010 sec 3, RFC 8011 sec 4.3.4)
# ---------------------------------------------------------------------------

class TestIppRequestEncoding:
    PRINTER_URI = "ipp://10.0.0.1:631/printers/default"

    # Written out field by field from RFC 8010 sec 3.1 (figures 1-5) and the
    # RFC 8011 sec 4.1.4/4.1.5 attribute order -- NOT produced by the encoder.
    EXPECTED = (
        b"\x02\x00"                                   # version-number 2.0
        b"\x00\x09"                                   # operation-id Get-Job-Attributes
        b"\x00\x00\x00\x07"                           # request-id 7
        b"\x01"                                       # operation-attributes-tag
        b"\x47" b"\x00\x12" b"attributes-charset" b"\x00\x05" b"utf-8"
        b"\x48" b"\x00\x1b" b"attributes-natural-language" b"\x00\x02" b"en"
        b"\x45" b"\x00\x0b" b"printer-uri" b"\x00\x23" b"ipp://10.0.0.1:631/printers/default"
        b"\x21" b"\x00\x06" b"job-id" b"\x00\x04" b"\x00\x00\x00\x2a"
        b"\x44" b"\x00\x14" b"requested-attributes" b"\x00\x09" b"job-state"
        b"\x44" b"\x00\x00" b"\x00\x11" b"job-state-reasons"   # additional-value
        b"\x03"                                       # end-of-attributes-tag
    )

    def test_request_bytes_are_exact(self):
        encoded = encode_ipp_get_job_attributes(self.PRINTER_URI, 42, 7)
        assert encoded == self.EXPECTED, (
            f"\nexpected {self.EXPECTED.hex()}\n     got {encoded.hex()}"
        )

    def test_request_decodes_as_the_ordered_operation_group(self):
        """The request is itself well-formed IPP: one operation group, the
        RFC-mandated order, requested-attributes multi-valued."""
        decoded = decode_ipp_response(encode_ipp_get_job_attributes(self.PRINTER_URI, 42, 7))
        assert decoded["version"] == (2, 0)
        assert decoded["statusCode"] == 0x0009     # the operation-id sits here in a request
        assert decoded["requestId"] == 7
        [group] = decoded["groups"]
        assert group["tag"] == 0x01
        assert [a["name"] for a in group["attributes"]] == [
            "attributes-charset", "attributes-natural-language",
            "printer-uri", "job-id", "requested-attributes",
        ]
        requested = group["attributes"][-1]["values"]
        assert requested == [(0x44, b"job-state"), (0x44, b"job-state-reasons")]

    @pytest.mark.parametrize("job_id,request_id", [
        (0, 1), (2 ** 31, 1), (1, 0), (1, 2 ** 31), (-5, 1),
    ])
    def test_out_of_range_ids_are_refused(self, job_id, request_id):
        with pytest.raises(ValueError):
            encode_ipp_get_job_attributes(self.PRINTER_URI, job_id, request_id)

    def test_urls_follow_rfc_8010_sec_5(self):
        http_url, printer_uri = ipp_job_urls(
            {"printer_ip": "10.0.0.1", "queue": "default", "job_id": 42}
        )
        assert http_url == "http://10.0.0.1:631/printers/default"
        assert printer_uri == "ipp://10.0.0.1:631/printers/default"


# ---------------------------------------------------------------------------
# IPP response decoding and the job-state verdict
# ---------------------------------------------------------------------------

class TestIppResponseDecoding:
    def test_the_test_builder_reproduces_a_real_cups_response_byte_for_byte(self):
        """Every canned response below comes from ipp_response(); this pins it
        to what a real CUPS server actually sent."""
        assert ipp_response(
            job_state=7, reasons=("processing-to-stop-point",), request_id=7
        ) == CUPS_CANCELED_JOB_RESPONSE

    def test_a_captured_cups_response_decodes(self):
        decoded = decode_ipp_response(CUPS_CANCELED_JOB_RESPONSE)
        assert decoded["version"] == (2, 0)
        assert decoded["statusCode"] == 0x0000
        assert decoded["requestId"] == 7
        assert [g["tag"] for g in decoded["groups"]] == [0x01, 0x02]
        state, reasons, problem = ipp_job_state(decoded)
        assert (state, reasons, problem) == (7, ["processing-to-stop-point"], "")
        verdict, observation = ipp_completion_verdict(200, CUPS_CANCELED_JOB_RESPONSE, 7)
        assert verdict == POLL_FAILED
        assert observation["jobState"] == "canceled"

    @pytest.mark.parametrize("state,expected", [
        pytest.param(3, POLL_WAITING, id="3-pending"),
        pytest.param(4, POLL_WAITING, id="4-pending-held"),
        pytest.param(5, POLL_WAITING, id="5-processing"),
        pytest.param(6, POLL_WAITING, id="6-processing-stopped"),
        pytest.param(7, POLL_FAILED, id="7-canceled"),
        pytest.param(8, POLL_FAILED, id="8-aborted"),
        pytest.param(9, POLL_COMPLETED, id="9-completed"),
        pytest.param(0, POLL_WAITING, id="0-not-a-state"),
        pytest.param(1, POLL_WAITING, id="1-not-a-state"),
        pytest.param(10, POLL_WAITING, id="10-unknown"),
        pytest.param(-1, POLL_WAITING, id="negative"),
    ])
    def test_each_job_state(self, state, expected):
        verdict, observation = ipp_completion_verdict(
            200, ipp_response(job_state=state, request_id=11), 11
        )
        assert verdict == expected, observation
        assert observation["jobStateCode"] == state

    @pytest.mark.parametrize("reasons,expected", [
        pytest.param(("job-completed-successfully",), POLL_COMPLETED, id="successfully"),
        pytest.param(("job-completed-with-warnings",), POLL_COMPLETED, id="with-warnings"),
        pytest.param(("none",), POLL_COMPLETED, id="none"),
        pytest.param(("job-completed-with-errors",), POLL_FAILED, id="with-errors"),
        pytest.param(("completed-with-errors",), POLL_FAILED, id="with-errors-table-15-spelling"),
        pytest.param(("queued-in-device",), POLL_UNOBSERVABLE, id="queued-in-device"),
        pytest.param(("job-completed-successfully", "queued-in-device"), POLL_UNOBSERVABLE,
                     id="queued-in-device-as-additional-value"),
    ])
    def test_completed_is_qualified_by_its_reasons(self, reasons, expected):
        verdict, observation = ipp_completion_verdict(
            200, ipp_response(job_state=9, reasons=reasons, request_id=3), 3
        )
        assert verdict == expected, observation
        assert observation["jobStateReasons"] == list(reasons)

    @pytest.mark.parametrize("status", [0x0001, 0x0002, 0x00FF])
    def test_every_successful_status_code_is_read(self, status):
        body = ipp_response(job_state=9, status=status, request_id=3)
        assert ipp_completion_verdict(200, body, 3)[0] == POLL_COMPLETED

    @pytest.mark.parametrize("status", [
        pytest.param(0x0100, id="0x0100-just-past-success"),
        pytest.param(0x0400, id="bad-request"),
        pytest.param(0x0406, id="not-found-maybe-purged"),
        pytest.param(0x0500, id="internal-error"),
        pytest.param(0x0503, id="version-not-supported"),
        pytest.param(0xFFFF, id="0xffff"),
    ])
    def test_a_non_success_status_code_is_waiting_even_with_job_state_9(self, status):
        body = ipp_response(job_state=9, status=status, request_id=3)
        verdict, observation = ipp_completion_verdict(200, body, 3)
        assert verdict == POLL_WAITING
        assert "not a success" in observation["reason"]

    @pytest.mark.parametrize("http_status", [0, -1, 400, 401, 404, 500, 503])
    def test_a_non_200_http_answer_is_waiting(self, http_status):
        """RFC 8010 sec 3.4.3: only an HTTP 200 carries an IPP status-code."""
        body = ipp_response(job_state=9, request_id=3)
        assert ipp_completion_verdict(http_status, body, 3)[0] == POLL_WAITING

    def test_a_request_id_that_is_not_ours_is_waiting(self):
        body = ipp_response(job_state=9, request_id=4)
        verdict, observation = ipp_completion_verdict(200, body, 3)
        assert verdict == POLL_WAITING
        assert "not ours" in observation["reason"]

    @pytest.mark.parametrize("version", [b"\x00\x00", b"\x03\x00", b"\x3c\x68"])
    def test_a_response_that_is_not_ipp_1_or_2_is_waiting(self, version):
        body = ipp_response(job_state=9, request_id=3, version=version)
        assert ipp_completion_verdict(200, body, 3)[0] == POLL_WAITING

    def test_ipp_1_1_responses_are_read(self):
        body = ipp_response(job_state=9, request_id=3, version=b"\x01\x01")
        assert ipp_completion_verdict(200, body, 3)[0] == POLL_COMPLETED

    # --- where job-state may be read from --------------------------------

    def test_job_state_only_in_the_unsupported_group_is_not_the_jobs_state(self):
        """RFC 8011 sec 4.3.4.2: requested keywords the printer does not
        support may be echoed in the Unsupported group (0x05)."""
        body = ipp_response(
            request_id=3, job_group=False,
            extra=b"\x05" + ipp_attr(0x23, b"job-state", (9).to_bytes(4, "big")),
        )
        assert ipp_completion_verdict(200, body, 3)[0] == POLL_WAITING

    def test_job_state_in_the_operation_group_is_not_the_jobs_state(self):
        body = (
            b"\x02\x00\x00\x00\x00\x00\x00\x03\x01"
            + ipp_attr(0x47, b"attributes-charset", b"utf-8")
            + ipp_attr(0x23, b"job-state", (9).to_bytes(4, "big"))
            + b"\x02\x03"
        )
        assert ipp_completion_verdict(200, body, 3)[0] == POLL_WAITING

    def test_an_empty_job_group_is_waiting(self):
        assert ipp_completion_verdict(200, ipp_response(request_id=3), 3)[0] == POLL_WAITING

    def test_two_job_groups_are_waiting(self):
        body = ipp_response(
            job_state=9, request_id=3,
            extra=b"\x02" + ipp_attr(0x23, b"job-state", (5).to_bytes(4, "big")),
        )
        assert ipp_completion_verdict(200, body, 3)[0] == POLL_WAITING

    def test_a_repeated_job_state_is_waiting(self):
        """RFC 8010 sec 3.6: two attributes with one name make the group malformed."""
        body = ipp_response(
            job_state=9, request_id=3,
            extra=ipp_attr(0x23, b"job-state", (5).to_bytes(4, "big")),
        )
        assert ipp_completion_verdict(200, body, 3)[0] == POLL_WAITING

    def test_a_multi_valued_job_state_is_waiting(self):
        body = ipp_response(
            job_state=9, request_id=3,
            extra=ipp_attr(0x23, b"", (5).to_bytes(4, "big")),
        )
        assert ipp_completion_verdict(200, body, 3)[0] == POLL_WAITING

    @pytest.mark.parametrize("tag,value", [
        pytest.param(0x21, (9).to_bytes(4, "big"), id="integer-tag-not-enum"),
        pytest.param(0x12, b"", id="out-of-band-unknown"),
        pytest.param(0x13, b"", id="out-of-band-no-value"),
        pytest.param(0x10, b"", id="out-of-band-unsupported"),
        pytest.param(0x23, b"\x00\x09", id="two-octet-enum"),
        pytest.param(0x44, b"completed", id="keyword-completed"),
    ])
    def test_an_unreadable_job_state_is_waiting(self, tag, value):
        body = ipp_response(request_id=3, job_state_tag=tag, job_state_value=value)
        verdict, observation = ipp_completion_verdict(200, body, 3)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] is None

    def test_a_collection_before_job_state_is_walked_by_length(self):
        """A begCollection/member/endCollection run parses as values of one
        attribute and never shadows or fakes job-state."""
        collection = (
            ipp_attr(0x34, b"media-col", b"")
            + ipp_attr(0x4a, b"", b"media-size")
            + ipp_attr(0x34, b"", b"")
            + ipp_attr(0x4a, b"", b"job-state")          # a MEMBER name, not an attribute
            + ipp_attr(0x21, b"", (9).to_bytes(4, "big"))
            + ipp_attr(0x37, b"", b"")
            + ipp_attr(0x37, b"", b"")
        )
        body = (
            b"\x02\x00\x00\x00\x00\x00\x00\x03\x01"
            + ipp_attr(0x47, b"attributes-charset", b"utf-8")
            + b"\x02" + collection
            + ipp_attr(0x23, b"job-state", (5).to_bytes(4, "big"))
            + b"\x03"
        )
        verdict, observation = ipp_completion_verdict(200, body, 3)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] == 5

    def test_data_after_the_end_tag_is_ignored(self):
        body = ipp_response(job_state=9, request_id=3) + b"trailing document data"
        assert ipp_completion_verdict(200, body, 3)[0] == POLL_COMPLETED

    # --- malformed / truncated --------------------------------------------

    GOOD = ipp_response(job_state=9, request_id=3)

    @pytest.mark.parametrize("body,problem", [
        pytest.param(b"", "truncated header", id="empty"),
        pytest.param(GOOD[:5], "truncated header", id="five-bytes"),
        pytest.param(GOOD[:8], "no end-of-attributes-tag", id="header-only"),
        pytest.param(GOOD[:-1], "no end-of-attributes-tag", id="end-tag-missing"),
        pytest.param(GOOD[:-3], "truncated in value", id="cut-inside-job-state"),
        pytest.param(GOOD[:12], "truncated in name", id="cut-inside-a-name"),
        pytest.param(GOOD[:10], "truncated in name-length", id="cut-inside-name-length"),
        pytest.param(
            b"\x02\x00\x00\x00\x00\x00\x00\x03\x02\x23\x00\x09job-state\x00\xff\x00\x00\x00\x09\x03",
            "truncated in value", id="value-length-overruns",
        ),
        pytest.param(
            b"\x02\x00\x00\x00\x00\x00\x00\x03" + ipp_attr(0x23, b"job-state", b"\x00\x00\x00\x09") + b"\x03",
            "before any attribute group", id="attribute-outside-a-group",
        ),
        pytest.param(
            b"\x02\x00\x00\x00\x00\x00\x00\x03\x02" + ipp_attr(0x23, b"", b"\x00\x00\x00\x09") + b"\x03",
            "additional-value with no attribute", id="orphan-additional-value",
        ),
        pytest.param(
            b"\x02\x00\x00\x00\x00\x00\x00\x03\x02\x23\x80\x00", "negative name-length",
            id="negative-name-length",
        ),
    ])
    def test_malformed_responses_raise_and_are_waiting(self, body, problem):
        with pytest.raises(IppDecodeError, match=problem):
            decode_ipp_response(body)
        verdict, observation = ipp_completion_verdict(200, body, 3)
        assert verdict == POLL_WAITING
        assert "malformed" in observation["reason"]

    @pytest.mark.parametrize("body", ["a string", None, 12, {"job-state": 9}])
    def test_a_body_that_is_not_bytes_is_waiting(self, body):
        with pytest.raises(IppDecodeError):
            decode_ipp_response(body)
        assert ipp_completion_verdict(200, body, 3)[0] == POLL_WAITING


# ---------------------------------------------------------------------------
# IPP: registration and one check per cycle, end to end through execute()
# ---------------------------------------------------------------------------

IPP_DEVICE = {"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}
LP_QUEUED = "request id is default-42 (1 file(s))"
# What execute_ipp_print returns when `lp -h 10.0.0.1 -d default` exits 0.
IPP_ACCEPTED_WITH_ID = {
    "submitted": True,
    "filepath": "/tmp/pcc-print.txt",
    "returncode": 0,
    "stdout": LP_QUEUED,
    "stderr": "",
    "printer_ip": "10.0.0.1",
    "printer_name": "",
}
IPP_HANDLE = {"printer_ip": "10.0.0.1", "queue": "default", "job_id": 42}


def accept_ipp(device=IPP_DEVICE, result=IPP_ACCEPTED_WITH_ID, gateway=None, clock=None,
               job_id="job-ipp"):
    gateway = gateway or _gateway()
    clock = clock or FakeClock()
    ex = JobExecutor(devices=[device], gateway_client=gateway, clock=clock)
    with mock.patch("pcc_node.job_executor.execute_ipp_print", return_value=result):
        ex.execute({"id": job_id, "capabilityType": "document-printing", "parameters": {}})
    return ex, gateway, clock


def poll(ex, fake):
    with mock.patch("pcc_node.http_util.urlopen", side_effect=fake):
        ex.poll_awaiting()


def _discard_spool_file(path):
    if path and os.path.exists(path):
        os.unlink(path)


class TestIppCompletionTracking:
    def test_an_accepted_ipp_job_is_registered_with_its_handle(self):
        ex, gateway, clock = accept_ipp()
        awaiting = ex.awaiting_completion()
        assert list(awaiting) == ["job-ipp"]
        entry = awaiting["job-ipp"]
        assert entry["kind"] == "ipp"
        assert entry["handle"] == IPP_HANDLE
        assert entry["accepted_at"] == clock.now
        assert entry["deadline"] == clock.now + IPP_COMPLETION_POLL_TIMEOUT_S
        # Registration changes nothing upstream: still only the claim and the
        # acceptance bundle (execution_progress, never execution_completed).
        assert _statuses(gateway) == ["running"]
        [bundle] = _bundles(gateway)
        assert _types(bundle) == [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_PROGRESS]

    def test_the_live_lp_adapter_output_yields_the_handle(self):
        gateway = _gateway()
        ex = JobExecutor(devices=[IPP_DEVICE], gateway_client=gateway, clock=FakeClock())
        job = {"id": "job-lp", "capabilityType": "document-printing",
               "parameters": {"content": "x", "filename": "x.txt"}}
        with mock.patch("subprocess.run") as run, \
             mock.patch("platform.system", return_value="Linux"):
            run.return_value = mock.Mock(returncode=0, stdout=LP_QUEUED + "\n", stderr="")
            bundle = ex.execute(job)
        _discard_spool_file(bundle["result"].get("filepath"))

        assert run.call_args.args[0][:5] == ["lp", "-h", "10.0.0.1", "-d", "default"]
        assert classify_execution_result(bundle["result"]) == RESULT_ACCEPTED
        assert ex.awaiting_completion()["job-lp"]["handle"] == IPP_HANDLE

    def test_the_windows_notepad_path_has_no_handle_and_is_not_registered(self, caplog):
        gateway = _gateway()
        ex = JobExecutor(devices=[IPP_DEVICE], gateway_client=gateway, clock=FakeClock())
        job = {"id": "job-win", "capabilityType": "document-printing",
               "parameters": {"content": "x", "filename": "x.txt"}}
        with mock.patch("subprocess.run") as run, \
             mock.patch("platform.system", return_value="Windows"), \
             caplog.at_level(logging.INFO, logger=EXECUTOR_LOGGER):
            run.return_value = mock.Mock(returncode=0, stdout="", stderr="")
            bundle = ex.execute(job)
        _discard_spool_file(bundle["result"].get("filepath"))

        assert run.call_args.args[0][0] == "notepad"
        assert classify_execution_result(bundle["result"]) == RESULT_ACCEPTED
        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running"]
        assert any("no completion handle" in m for m in _messages(caplog, logging.INFO))

    @pytest.mark.parametrize("result", [
        pytest.param({**IPP_ACCEPTED_WITH_ID, "stdout": "request ok"}, id="no-request-id"),
        pytest.param({**IPP_ACCEPTED_WITH_ID, "printer_ip": ""}, id="local-queue-no-host"),
        pytest.param({**IPP_ACCEPTED_WITH_ID, "printer_ip": "10.0.0.1:8631"}, id="host-with-port"),
        pytest.param({**IPP_ACCEPTED_WITH_ID, "printer_ip": "fe80::1"}, id="ipv6-literal"),
        pytest.param({**IPP_ACCEPTED_WITH_ID, "printer_ip": "10.0.0.1/evil"}, id="host-with-path"),
    ])
    def test_no_usable_handle_means_no_registration(self, result):
        ex, gateway, _ = accept_ipp(result=result)
        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running"]

    def test_one_get_job_attributes_per_cycle_to_the_right_printer(self):
        ex, gateway, _ = accept_ipp()
        printer = FakeIppPrinter(state=5)
        poll(ex, printer)

        [req] = printer.requests
        assert req.full_url == "http://10.0.0.1:631/printers/default"
        assert req.get_method() == "POST"
        assert req.get_header("Content-type") == "application/ipp"
        request_id = int.from_bytes(req.data[4:8], "big")
        assert req.data == encode_ipp_get_job_attributes(
            "ipp://10.0.0.1:631/printers/default", 42, request_id
        )

        poll(ex, printer)
        assert len(printer.requests) == 2, "exactly one request per job per cycle"
        ids = [int.from_bytes(r.data[4:8], "big") for r in printer.requests]
        assert ids[0] != ids[1] and all(1 <= i <= 2 ** 31 - 1 for i in ids)

    @pytest.mark.parametrize("state", [3, 4, 5, 6])
    def test_not_completed_states_leave_the_job_registered(self, state):
        ex, gateway, _ = accept_ipp()
        poll(ex, FakeIppPrinter(state=state))
        assert "job-ipp" in ex.awaiting_completion()
        assert _statuses(gateway) == ["running"]
        assert len(_bundles(gateway)) == 1

    def test_completed_is_reported_exactly_once(self):
        ex, gateway, _ = accept_ipp()
        printer = FakeIppPrinter(state=5)
        poll(ex, printer)
        printer.state = 9
        printer.reasons = ("job-completed-successfully",)
        poll(ex, printer)

        assert _statuses(gateway) == ["running", "completed"]
        acceptance, completion = _bundles(gateway)
        assert _types(acceptance) == [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_PROGRESS]
        assert _types(completion) == [EVENT_EXECUTION_COMPLETED]
        assert EVENT_EXECUTION_FAILED not in _text(completion)
        assert completion["jobId"] == "job-ipp"
        assert completion["deviceId"] == "p1"
        [event] = completion["events"]
        assert event["timestamp"] == completion["executedAt"]
        payload = event["payload"]
        assert payload["level"] == EVIDENCE_LEVEL_DEVICE_REPORTED == "device_reported"
        assert payload["handle"] == IPP_HANDLE
        assert payload["jobState"] == "completed"
        assert payload["jobStateCode"] == 9
        assert payload["jobStateReasons"] == ["job-completed-successfully"]
        assert ex.awaiting_completion() == {}

        # The printer keeps saying 'completed': nothing is asked or reported again.
        poll(ex, printer)
        assert len(printer.requests) == 2
        assert _statuses(gateway) == ["running", "completed"]
        assert len(_bundles(gateway)) == 2

    @pytest.mark.parametrize("state,name", [(7, "canceled"), (8, "aborted")])
    def test_canceled_or_aborted_is_reported_failed_exactly_once(self, state, name):
        ex, gateway, _ = accept_ipp()
        printer = FakeIppPrinter(state=state)
        poll(ex, printer)

        assert _statuses(gateway) == ["running", "failed"]
        failure = _bundles(gateway)[-1]
        assert _types(failure) == [EVENT_EXECUTION_FAILED]
        assert "execution_completed" not in _text(failure)
        payload = failure["events"][0]["payload"]
        assert payload["level"] == "device_reported"
        assert payload["jobState"] == name
        assert name in payload["error"]
        failed_metadata = gateway.update_job_status.call_args_list[-1].args[2]
        assert name in failed_metadata["error"]
        assert ex.awaiting_completion() == {}

        poll(ex, printer)
        assert len(printer.requests) == 1
        assert _statuses(gateway) == ["running", "failed"]

    def test_completed_with_errors_is_reported_failed(self):
        ex, gateway, _ = accept_ipp()
        poll(ex, FakeIppPrinter(state=9, reasons=("job-completed-with-errors",)))
        assert _statuses(gateway) == ["running", "failed"]
        assert "execution_completed" not in _text(_bundles(gateway)[-1])

    def test_queued_in_device_is_dropped_without_any_terminal_status(self, caplog):
        """RFC 8011 sec 5.3.8: 'completed' + 'queued-in-device' means the
        printer handed the job on and "never will have any better
        information" -- an outcome nobody can observe."""
        ex, gateway, _ = accept_ipp()
        printer = FakeIppPrinter(state=9, reasons=("queued-in-device",))
        with caplog.at_level(logging.ERROR, logger=EXECUTOR_LOGGER):
            poll(ex, printer)

        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running"]
        assert len(_bundles(gateway)) == 1
        errors = _messages(caplog, logging.ERROR)
        assert any("job-ipp" in m and "stays 'running'" in m for m in errors), errors
        poll(ex, printer)
        assert len(printer.requests) == 1

    @pytest.mark.parametrize("configure", [
        pytest.param(lambda p: setattr(p, "fail_with", URLError("[Errno 111] Connection refused")),
                     id="connection-refused"),
        pytest.param(lambda p: setattr(p, "fail_with", TimeoutError("timed out")), id="timeout"),
        pytest.param(lambda p: setattr(p, "fail_with", HTTPError(
            "http://10.0.0.1:631/printers/default", 500, "err", {}, io.BytesIO(b""))), id="http-500"),
        pytest.param(lambda p: setattr(p, "fail_with", HTTPError(
            "http://10.0.0.1:631/printers/default", 404, "err", {}, io.BytesIO(b"<html/>"))), id="http-404"),
        pytest.param(lambda p: setattr(p, "raw", b"<html>not ipp</html>"), id="200-not-ipp"),
        pytest.param(lambda p: setattr(p, "raw", ipp_response(job_state=9)[:-1]), id="200-truncated"),
        pytest.param(lambda p: setattr(p, "ipp_status", 0x0406), id="ipp-not-found"),
        pytest.param(lambda p: setattr(p, "raw", ipp_response(job_state=9, request_id=999)),
                     id="someone-elses-request-id"),
    ])
    def test_a_failed_or_unreadable_check_leaves_the_job_registered(self, configure):
        ex, gateway, _ = accept_ipp()
        printer = FakeIppPrinter(state=9)
        configure(printer)
        poll(ex, printer)

        assert len(printer.requests) == 1
        assert "job-ipp" in ex.awaiting_completion()
        assert _statuses(gateway) == ["running"]
        assert len(_bundles(gateway)) == 1
        assert ex.awaiting_completion()["job-ipp"]["last_observation"]["reason"]

    def test_the_deadline_drops_the_job_without_a_terminal_status(self, caplog):
        device = {**IPP_DEVICE, "completionPollTimeout": 100}
        ex, gateway, clock = accept_ipp(device=device)
        printer = FakeIppPrinter(state=5)

        clock.advance(50)
        poll(ex, printer)
        assert "job-ipp" in ex.awaiting_completion()

        clock.advance(50)       # exactly at the deadline
        printer.state = 9       # too late: the budget is spent
        with caplog.at_level(logging.ERROR, logger=EXECUTOR_LOGGER):
            poll(ex, printer)

        assert len(printer.requests) == 1, "a job must not be polled past its deadline"
        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running"]
        assert len(_bundles(gateway)) == 1
        errors = _messages(caplog, logging.ERROR)
        assert any(
            "job-ipp" in m and "WITHOUT reporting completed or failed" in m
            and "stays 'running'" in m and "processing" in m
            for m in errors
        ), errors

        poll(ex, printer)
        assert len(printer.requests) == 1
        assert _statuses(gateway) == ["running"]

    @pytest.mark.parametrize("override,expected", [
        pytest.param(10, 10.0, id="int"),
        pytest.param(2.5, 2.5, id="float"),
        pytest.param("600", IPP_COMPLETION_POLL_TIMEOUT_S, id="string-ignored"),
        pytest.param(True, IPP_COMPLETION_POLL_TIMEOUT_S, id="bool-ignored"),
        pytest.param(float("inf"), IPP_COMPLETION_POLL_TIMEOUT_S, id="infinity-ignored"),
        pytest.param(float("nan"), IPP_COMPLETION_POLL_TIMEOUT_S, id="nan-ignored"),
    ])
    def test_completion_poll_timeout_is_device_configurable(self, override, expected):
        ex, _, clock = accept_ipp(device={**IPP_DEVICE, "completionPollTimeout": override})
        entry = ex.awaiting_completion()["job-ipp"]
        assert entry["deadline"] - entry["accepted_at"] == expected

    @pytest.mark.parametrize("override", [0, -5])
    def test_a_zero_or_negative_budget_disables_tracking(self, override):
        ex, gateway, _ = accept_ipp(device={**IPP_DEVICE, "completionPollTimeout": override})
        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running"]

    def test_without_a_gateway_nothing_is_registered(self):
        ex = JobExecutor(devices=[IPP_DEVICE], gateway_client=None, clock=FakeClock())
        with mock.patch("pcc_node.job_executor.execute_ipp_print", return_value=IPP_ACCEPTED_WITH_ID):
            ex.execute({"id": "job-offline", "capabilityType": "document-printing", "parameters": {}})
        assert ex.awaiting_completion() == {}
        ex.poll_awaiting()   # nothing to do, and must not raise

    def test_a_job_is_never_registered_twice(self):
        ex, _, _ = accept_ipp()
        first = ex.awaiting_completion()["job-ipp"]
        assert ex._register_awaiting("job-ipp", IPP_DEVICE, IPP_ACCEPTED_WITH_ID) is False
        assert ex.awaiting_completion()["job-ipp"] == first

    # --- the reports themselves --------------------------------------------

    def test_unacknowledged_completion_evidence_means_no_completed_status(self, caplog):
        """'completed' without its execution_completed could not settle, and a
        second push risks a duplicate: the job stays running, loudly."""
        ex, gateway, _ = accept_ipp()
        gateway.push_evidence.return_value = False
        printer = FakeIppPrinter(state=9)
        with caplog.at_level(logging.ERROR, logger=EXECUTOR_LOGGER):
            poll(ex, printer)

        assert _statuses(gateway) == ["running"]
        assert ex.awaiting_completion() == {}
        errors = _messages(caplog, logging.ERROR)
        assert any("job-ipp" in m and "NOT reporting 'completed'" in m for m in errors), errors
        poll(ex, printer)
        assert len(printer.requests) == 1, "the completion bundle must never be pushed twice"
        assert len(_bundles(gateway)) == 2

    def test_an_unacknowledged_completed_report_is_loud_and_not_retried(self, caplog):
        ex, gateway, _ = accept_ipp(gateway=_gateway(completed_ack=False))
        printer = FakeIppPrinter(state=9)
        with caplog.at_level(logging.ERROR, logger=EXECUTOR_LOGGER):
            poll(ex, printer)
            poll(ex, printer)

        assert _statuses(gateway) == ["running", "completed"]
        errors = _messages(caplog, logging.ERROR)
        assert any("did not acknowledge the 'completed'" in m for m in errors), errors

    def test_an_unacknowledged_failed_report_is_loud_and_not_retried(self, caplog):
        ex, gateway, _ = accept_ipp(gateway=_gateway(failed_ack=False))
        printer = FakeIppPrinter(state=8)
        with caplog.at_level(logging.ERROR, logger=EXECUTOR_LOGGER):
            poll(ex, printer)
            poll(ex, printer)

        assert _statuses(gateway) == ["running", "failed"]
        errors = _messages(caplog, logging.ERROR)
        assert any("did not acknowledge the 'failed'" in m for m in errors), errors

    def test_a_raising_check_does_not_stop_the_other_jobs(self, caplog):
        gateway = _gateway()
        devices = [
            {"id": "pa", "protocol": "ipp", "host": "10.0.0.1"},
            {"id": "pb", "protocol": "ipp", "host": "10.0.0.2"},
        ]
        ex = JobExecutor(devices=devices, gateway_client=gateway, clock=FakeClock())
        for job_id, device_id, host in (("job-a", "pa", "10.0.0.1"), ("job-b", "pb", "10.0.0.2")):
            with mock.patch("pcc_node.job_executor.execute_ipp_print",
                            return_value={**IPP_ACCEPTED_WITH_ID, "printer_ip": host}):
                ex.execute({"id": job_id, "deviceId": device_id,
                            "capabilityType": "document-printing", "parameters": {}})
        good = FakeIppPrinter(state=9)

        def router(req, *args, **kwargs):
            if "10.0.0.1" in req.full_url:
                raise RuntimeError("driver bug")   # not a transport error: escapes http_bytes
            return good(req, *args, **kwargs)

        with caplog.at_level(logging.ERROR, logger=EXECUTOR_LOGGER):
            poll(ex, router)

        assert list(ex.awaiting_completion()) == ["job-a"]
        completed = [c.args[0] for c in gateway.update_job_status.call_args_list if c.args[1] == "completed"]
        assert completed == ["job-b"]
        assert any("job-a" in m and "driver bug" in m for m in _messages(caplog, logging.ERROR))


# ---------------------------------------------------------------------------
# OctoPrint: the /api/job verdict (pure)
# ---------------------------------------------------------------------------

def job_body(state, completion, path="benchy.gcode", name=None, origin="local",
             error=None, with_path=True):
    selected = {
        "name": name if name is not None else path.rsplit("/", 1)[-1],
        "origin": origin,
        "size": 1468987,
        "date": 1378847754,
    }
    if with_path:
        selected["path"] = path
    body = {
        "job": {"file": selected, "estimatedPrintTime": 8811},
        "progress": {"completion": completion, "filepos": 0, "printTime": 276, "printTimeLeft": 912},
        "state": state,
    }
    if error is not None:
        body["error"] = error
    return body


class TestOctoPrintVerdict:
    FILE = "benchy.gcode"

    def verdict(self, body, seen_active=True, status=200, filename=FILE):
        return octoprint_completion_verdict(status, body, filename, seen_active)

    @pytest.mark.parametrize("state", ["Printing", "Pausing", "Paused", "printing", " PRINTING "])
    def test_an_active_print_of_our_file_is_waiting_and_marks_it_seen(self, state):
        verdict, reason, active = self.verdict(job_body(state, 42.0), seen_active=False)
        assert (verdict, active) == (POLL_WAITING, True), reason

    def test_printing_at_100_percent_is_still_waiting(self):
        """The polarity control's neighbour: a print can sit at 100 % while
        it finishes; only the printer leaving the active state completes it."""
        assert self.verdict(job_body("Printing", 100.0))[0] == POLL_WAITING

    @pytest.mark.parametrize("completion", [100, 100.0, 100.00001])
    def test_operational_at_100_after_printing_is_completed(self, completion):
        verdict, reason, active = self.verdict(job_body("Operational", completion))
        assert (verdict, active) == (POLL_COMPLETED, False), reason

    def test_operational_at_100_never_seen_printing_is_waiting(self):
        """The selection may show a PREVIOUS run of the same file, or a print
        that has not started: no completion without seeing ours run."""
        verdict, reason, _ = self.verdict(job_body("Operational", 100.0), seen_active=False)
        assert verdict == POLL_WAITING
        assert "never seen running" in reason

    @pytest.mark.parametrize("completion", [0, 0.0, 37.5, 99.99])
    def test_operational_below_100_after_printing_is_a_cancelled_print(self, completion):
        verdict, reason, _ = self.verdict(job_body("Operational", completion))
        assert verdict == POLL_FAILED
        assert "stopped" in reason

    def test_operational_below_100_never_seen_printing_is_waiting(self):
        assert self.verdict(job_body("Operational", 0.0), seen_active=False)[0] == POLL_WAITING

    @pytest.mark.parametrize("seen", [True, False])
    def test_cancelling_our_file_is_a_failure(self, seen):
        verdict, reason, _ = self.verdict(job_body("Cancelling", 12.0), seen_active=seen)
        assert verdict == POLL_FAILED
        assert "cancelled" in reason

    @pytest.mark.parametrize("state", ["Error", "Offline", "Offline after error", "OFFLINE AFTER ERROR"])
    @pytest.mark.parametrize("completion", [None, 0.0, 63.2])
    def test_an_error_or_offline_state_before_100_is_a_failure(self, state, completion):
        assert self.verdict(job_body(state, completion))[0] == POLL_FAILED

    @pytest.mark.parametrize("state", ["Error", "Offline", "Offline after error"])
    def test_an_error_or_offline_state_at_100_is_ambiguous(self, state):
        assert self.verdict(job_body(state, 100.0))[0] == POLL_WAITING

    @pytest.mark.parametrize("body", [
        pytest.param(job_body("Operational", 100.0, path="other.gcode"), id="another-file"),
        pytest.param(job_body("Operational", 100.0, path="old/benchy.gcode"), id="same-name-other-folder"),
        pytest.param(job_body("Operational", 100.0, origin="sdcard"), id="sdcard-copy"),
        pytest.param(job_body("Operational", 100.0, origin=None), id="no-origin"),
        pytest.param({**job_body("Operational", 100.0), "job": {"file": {}}}, id="no-file-fields"),
        pytest.param({**job_body("Operational", 100.0), "job": {"file": None}}, id="file-null"),
        pytest.param({**job_body("Operational", 100.0), "job": None}, id="job-null"),
        pytest.param({"progress": {"completion": 100.0}, "state": "Operational"}, id="no-job"),
        pytest.param({**job_body("Operational", 100.0), "state": None}, id="state-null"),
        pytest.param({k: v for k, v in job_body("Operational", 100.0).items() if k != "state"},
                     id="no-state"),
        pytest.param({**job_body("Operational", 100.0), "state": 5}, id="state-not-a-string"),
        pytest.param({**job_body("Operational", 100.0), "state": "  "}, id="state-blank"),
        pytest.param(job_body("Operational", None), id="completion-null"),
        pytest.param(job_body("Operational", True), id="completion-bool"),
        pytest.param(job_body("Operational", "100"), id="completion-string"),
        pytest.param(job_body("Operational", float("nan")), id="completion-nan"),
        pytest.param({**job_body("Operational", 100.0), "progress": None}, id="progress-null"),
        pytest.param(job_body("Operational", 100.0, error="Printer halted: thermal runaway"),
                     id="operational-with-an-error-message"),
        pytest.param(job_body("Finishing", 100.0), id="finishing-not-in-the-docs"),
        pytest.param(job_body("Starting", 0.0), id="starting-not-in-the-docs"),
        pytest.param(job_body("Resuming", 50.0), id="resuming-not-in-the-docs"),
        pytest.param(job_body("Opening serial connection", 100.0), id="connecting"),
        pytest.param(job_body("Ready", 100.0), id="an-idle-word-not-in-the-docs"),
        pytest.param("not json", id="text-body"),
        pytest.param(None, id="no-body"),
        pytest.param([job_body("Operational", 100.0)], id="list-body"),
    ])
    def test_anything_ambiguous_is_waiting(self, body):
        verdict, reason, active = self.verdict(body)
        assert verdict == POLL_WAITING, reason
        assert active is False

    @pytest.mark.parametrize("status", [0, 401, 403, 404, 409, 500, 204, 201])
    def test_a_non_200_answer_is_waiting(self, status):
        assert self.verdict(job_body("Operational", 100.0), status=status)[0] == POLL_WAITING

    def test_name_is_the_fallback_when_path_is_absent(self):
        body = job_body("Operational", 100.0, with_path=False)
        assert self.verdict(body)[0] == POLL_COMPLETED

    def test_a_folder_filename_cannot_match_a_bare_name(self):
        body = job_body("Operational", 100.0, path="prints/benchy.gcode", with_path=False)
        assert self.verdict(body, filename="prints/benchy.gcode")[0] == POLL_WAITING

    def test_a_folder_filename_matches_its_path(self):
        body = job_body("Operational", 100.0, path="prints/benchy.gcode")
        assert self.verdict(body, filename="prints/benchy.gcode")[0] == POLL_COMPLETED


# ---------------------------------------------------------------------------
# OctoPrint: registration and one check per cycle, end to end through execute()
# ---------------------------------------------------------------------------

OP_KEY = "SECRET-OCTOPRINT-KEY-1234"
OP_DEVICE = {"id": "op1", "protocol": "octoprint", "url": "http://10.0.0.20:5000", "api_key": OP_KEY}
OP_HANDLE = {"base_url": "http://10.0.0.20:5000", "filename": "benchy.gcode"}


class FakeOctoPrint:
    """urlopen stand-in for OctoPrint: 204 to select+print, then whatever
    ``answer`` holds for GET /api/job -- a body, or an exception to raise."""

    def __init__(self, answer=None):
        self.requests = []
        self.answer = answer if answer is not None else job_body("Printing", 0.0)
        self.http_status = 200

    def __call__(self, req, *args, **kwargs):
        self.requests.append(req)
        url, method = req.full_url, req.get_method()
        if method == "POST" and "/api/files/local/" in url:
            return _Resp(204, b"")
        if method == "GET" and url.endswith("/api/job"):
            if isinstance(self.answer, Exception):
                raise self.answer
            raw = self.answer if isinstance(self.answer, bytes) else json.dumps(self.answer).encode()
            if self.http_status >= 400:
                raise HTTPError(url, self.http_status, "err", {}, io.BytesIO(raw))
            return _Resp(self.http_status, raw)
        raise AssertionError(f"unexpected request {method} {url}")

    def polls(self):
        return [r for r in self.requests if r.get_method() == "GET"]


def accept_octoprint(device=OP_DEVICE, gateway=None, clock=None, filename="benchy.gcode"):
    gateway = gateway or _gateway()
    clock = clock or FakeClock()
    ex = JobExecutor(devices=[device], gateway_client=gateway, clock=clock)
    fake = FakeOctoPrint()
    with mock.patch("pcc_node.http_util.urlopen", side_effect=fake):
        ex.execute({"id": "job-op", "capabilityType": "3d-print",
                    "parameters": {"filename": filename}})
    return ex, gateway, clock, fake


def answer(ex, fake, body):
    fake.answer = body
    poll(ex, fake)


class TestOctoPrintCompletionTracking:
    def test_an_accepted_print_is_registered_without_its_api_key(self):
        ex, gateway, clock, fake = accept_octoprint()
        entry = ex.awaiting_completion()["job-op"]
        assert entry["kind"] == "octoprint"
        assert entry["handle"] == OP_HANDLE
        assert entry["deadline"] - entry["accepted_at"] == OCTOPRINT_COMPLETION_POLL_TIMEOUT_S
        assert entry["seen_active"] is False
        assert OP_KEY not in _text(entry["handle"])
        assert _statuses(gateway) == ["running"]
        [select] = fake.requests
        assert select.full_url == "http://10.0.0.20:5000/api/files/local/benchy.gcode"

    def test_each_cycle_is_one_authenticated_get_of_api_job(self):
        ex, gateway, _, fake = accept_octoprint()
        answer(ex, fake, job_body("Printing", 10.0))
        [req] = fake.polls()
        assert req.full_url == "http://10.0.0.20:5000/api/job"
        assert req.get_header("X-api-key") == OP_KEY
        assert ex.awaiting_completion()["job-op"]["seen_active"] is True
        assert _statuses(gateway) == ["running"]

    def test_printing_then_operational_at_100_completes_exactly_once(self):
        ex, gateway, _, fake = accept_octoprint()
        answer(ex, fake, job_body("Printing", 55.0))
        answer(ex, fake, job_body("Operational", 100.0))

        assert _statuses(gateway) == ["running", "completed"]
        acceptance, completion = _bundles(gateway)
        assert _types(acceptance) == [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_PROGRESS]
        assert _types(completion) == [EVENT_EXECUTION_COMPLETED]
        payload = completion["events"][0]["payload"]
        assert payload["level"] == "device_reported"
        assert payload["deviceState"] == "Operational"
        assert payload["progress"]["completion"] == 100.0
        assert payload["file"]["path"] == "benchy.gcode"
        assert payload["handle"] == OP_HANDLE
        assert ex.awaiting_completion() == {}

        answer(ex, fake, job_body("Operational", 100.0))
        assert len(fake.polls()) == 2
        assert _statuses(gateway) == ["running", "completed"]

    def test_the_api_key_never_reaches_evidence_or_status(self):
        ex, gateway, _, fake = accept_octoprint()
        answer(ex, fake, job_body("Printing", 55.0))
        answer(ex, fake, job_body("Operational", 100.0))
        for call in gateway.push_evidence.call_args_list + gateway.update_job_status.call_args_list:
            assert OP_KEY not in _text(call.args), f"API key leaked in {call}"

    def test_operational_at_100_without_ever_printing_never_completes(self):
        ex, gateway, _, fake = accept_octoprint()
        for _ in range(3):
            answer(ex, fake, job_body("Operational", 100.0))
        assert _statuses(gateway) == ["running"]
        assert "job-op" in ex.awaiting_completion()

    @pytest.mark.parametrize("final", [
        pytest.param(job_body("Cancelling", 40.0), id="cancelling"),
        pytest.param(job_body("Operational", 40.0), id="stopped-before-100"),
        pytest.param(job_body("Error", 40.0), id="error"),
        pytest.param(job_body("Offline after error", 40.0), id="offline-after-error"),
        pytest.param(job_body("Offline", 40.0), id="offline"),
    ])
    def test_a_print_that_stopped_is_reported_failed_exactly_once(self, final):
        ex, gateway, _, fake = accept_octoprint()
        answer(ex, fake, job_body("Printing", 40.0))
        answer(ex, fake, final)

        assert _statuses(gateway) == ["running", "failed"]
        failure = _bundles(gateway)[-1]
        assert _types(failure) == [EVENT_EXECUTION_FAILED]
        assert "execution_completed" not in _text(failure)
        assert failure["events"][0]["payload"]["error"]
        assert ex.awaiting_completion() == {}
        answer(ex, fake, final)
        assert _statuses(gateway) == ["running", "failed"]

    @pytest.mark.parametrize("later", [
        pytest.param(job_body("Operational", 100.0, path="other.gcode"), id="another-file-now-selected"),
        pytest.param(job_body("Printing", 5.0, path="other.gcode"), id="another-file-printing"),
        pytest.param(job_body("Operational", None), id="completion-null"),
        pytest.param({"state": "Operational"}, id="fields-missing"),
        pytest.param(job_body("Error", 100.0), id="error-at-100"),
        pytest.param(job_body("Operational", 100.0, error="Printer halted"), id="error-message"),
        pytest.param(b"<html>proxy error</html>", id="not-json"),
        pytest.param(b"\xff\xfe\x00garbage", id="not-utf8"),
        pytest.param(URLError("[Errno 113] No route to host"), id="unreachable"),
    ])
    def test_ambiguous_answers_keep_it_registered(self, later):
        ex, gateway, _, fake = accept_octoprint()
        answer(ex, fake, job_body("Printing", 50.0))
        answer(ex, fake, later)
        assert "job-op" in ex.awaiting_completion()
        assert _statuses(gateway) == ["running"]
        assert len(_bundles(gateway)) == 1

    @pytest.mark.parametrize("status", [401, 403, 500])
    def test_an_http_error_keeps_it_registered(self, status):
        ex, gateway, _, fake = accept_octoprint()
        fake.http_status = status
        answer(ex, fake, {"error": "denied"})
        assert "job-op" in ex.awaiting_completion()
        assert _statuses(gateway) == ["running"]

    def test_the_deadline_drops_it_without_a_terminal_status(self, caplog):
        ex, gateway, clock, fake = accept_octoprint(
            device={**OP_DEVICE, "completionPollTimeout": 3600}
        )
        answer(ex, fake, job_body("Printing", 50.0))
        clock.advance(3600)
        with caplog.at_level(logging.ERROR, logger=EXECUTOR_LOGGER):
            answer(ex, fake, job_body("Operational", 100.0))

        assert len(fake.polls()) == 1
        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running"]
        assert any("job-op" in m and "stays 'running'" in m for m in _messages(caplog, logging.ERROR))

    def test_no_filename_is_a_failure_and_is_never_registered(self):
        """Sanity: a refused job is failed by execute() and never tracked."""
        ex, gateway, _, _ = accept_octoprint(filename="")
        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running", "failed"]


# ---------------------------------------------------------------------------
# The daemon calls poll_awaiting once per cycle, and survives its errors
# ---------------------------------------------------------------------------

class TestDaemonPollsAwaitingEachCycle:
    @pytest.fixture(autouse=True)
    def _restore_signal_handlers(self):
        saved = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
        yield
        for s, handler in saved.items():
            signal.signal(s, handler)

    def _enter_common_patches(self, stack, daemon_module):
        """Everything run_daemon touches outside the loop -- including the PID
        and state files (HOME) and the UI server (port 3200)."""
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
        return stack.enter_context(mock.patch("pcc_node.daemon.PCCGatewayClient")).return_value

    def _config(self, devices=()):
        return NodeConfig(kernel_id="k-poll", kernel_name="n", pcc_base="http://pcc-test",
                          pcc_api_key="key", poll_interval=0, devices=list(devices))

    def test_called_every_iteration_and_its_exception_does_not_stop_the_loop(self, caplog):
        from pcc_node import daemon as daemon_module

        with ExitStack() as stack:
            client = self._enter_common_patches(stack, daemon_module)
            executor = stack.enter_context(mock.patch("pcc_node.daemon.JobExecutor")).return_value
            client.poll_for_jobs.side_effect = [[], [], [], KeyboardInterrupt("stop")]
            executor.poll_awaiting.side_effect = [RuntimeError("poller exploded"), None, None, None]
            with caplog.at_level(logging.ERROR, logger="pcc-node.daemon"), \
                 pytest.raises(KeyboardInterrupt):
                daemon_module.run_daemon(self._config())

        assert executor.poll_awaiting.call_count == 4
        assert client.poll_for_jobs.call_count == 4, "the loop stopped after the poller raised"
        assert any("poller exploded" in m for m in _messages(caplog, logging.ERROR))

    def test_still_called_when_the_job_poll_itself_fails(self):
        from pcc_node import daemon as daemon_module

        with ExitStack() as stack:
            client = self._enter_common_patches(stack, daemon_module)
            executor = stack.enter_context(mock.patch("pcc_node.daemon.JobExecutor")).return_value
            client.poll_for_jobs.side_effect = [RuntimeError("gateway down"), [], KeyboardInterrupt("stop")]
            with pytest.raises(KeyboardInterrupt):
                daemon_module.run_daemon(self._config())

        assert executor.poll_awaiting.call_count == 3

    def test_an_accepted_print_settles_when_the_printer_reports_completion(self):
        """End to end with the REAL JobExecutor: cycle 1 accepts the print
        (running + submitted evidence), cycle 2 reads job-state 9 and reports
        device_reported completion; nothing else is faked but lp and the socket."""
        from pcc_node import daemon as daemon_module

        printer = FakeIppPrinter(state=9, reasons=("job-completed-successfully",))
        job = {"id": "job-daemon", "capabilityType": "document-printing",
               "parameters": {"content": "x", "filename": "x.txt"}}
        with ExitStack() as stack:
            client = self._enter_common_patches(stack, daemon_module)
            client.update_job_status.return_value = True
            client.push_evidence.return_value = True
            client.poll_for_jobs.side_effect = [[job], [], KeyboardInterrupt("stop")]
            run = stack.enter_context(mock.patch("subprocess.run"))
            run.return_value = mock.Mock(returncode=0, stdout=LP_QUEUED, stderr="")
            stack.enter_context(mock.patch("platform.system", return_value="Linux"))
            stack.enter_context(mock.patch("pcc_node.http_util.urlopen", side_effect=printer))
            try:
                with pytest.raises(KeyboardInterrupt):
                    daemon_module.run_daemon(self._config(devices=[IPP_DEVICE]))
            finally:
                for call in run.call_args_list:
                    _discard_spool_file(call.args[0][-1])

        assert [c.args[1] for c in client.update_job_status.call_args_list] == ["running", "completed"]
        bundles = [c.args[1] for c in client.push_evidence.call_args_list]
        assert [_types(b) for b in bundles] == [
            [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_PROGRESS],
            [EVENT_EXECUTION_COMPLETED],
        ]
        assert len(printer.requests) == 1


# ---------------------------------------------------------------------------
# Every type the pollers emit is in the closed evidence vocabulary
# ---------------------------------------------------------------------------

class TestPollerEvidenceVocabulary:
    def _vocabulary(self):
        spec = Path(__file__).resolve().parents[2] / "spec" / "src" / "types" / "evidence.ts"
        source = spec.read_text(encoding="utf-8")
        block = source.split("export const EVIDENCE_EVENT_TYPES = [", 1)[1].split("] as const", 1)[0]
        vocabulary = set(re.findall(r'"([a-z_]+)"', block))
        assert len(vocabulary) > 20, "failed to parse EVIDENCE_EVENT_TYPES"
        return vocabulary

    def test_every_poller_event_type_is_in_evidence_event_types(self):
        emitted = set()
        for state in (9, 8):
            ex, gateway, _ = accept_ipp()
            poll(ex, FakeIppPrinter(state=state))
            emitted.update(_types(_bundles(gateway)[-1]))
        for final in (job_body("Operational", 100.0), job_body("Cancelling", 10.0)):
            ex, gateway, _, fake = accept_octoprint()
            answer(ex, fake, job_body("Printing", 10.0))
            answer(ex, fake, final)
            emitted.update(_types(_bundles(gateway)[-1]))

        assert emitted == {EVENT_EXECUTION_COMPLETED, EVENT_EXECUTION_FAILED}, (
            f"guard no longer covers every poller event type: {sorted(emitted)}"
        )
        vocabulary = self._vocabulary()
        assert emitted <= vocabulary, f"not in EVIDENCE_EVENT_TYPES: {sorted(emitted - vocabulary)}"


# ---------------------------------------------------------------------------
# The pollers' evidence comes from a CLOSED builder (r31 astra verdict item 6):
# one terminal event, type chosen only by `completed is True`, level fixed.
# ---------------------------------------------------------------------------


class TestDeviceReportedBundleIsClosed:
    DEVICE = {"id": "p1", "protocol": "ipp"}

    def _types(self, bundle):
        return [e["type"] for e in bundle["events"]]

    def test_completed_true_is_one_completion_event(self):
        from pcc_node.job_executor import (
            build_device_reported_bundle, EVENT_EXECUTION_COMPLETED, EVIDENCE_LEVEL_DEVICE_REPORTED,
        )
        bundle = build_device_reported_bundle("j", self.DEVICE, {"kind": "ipp"}, completed=True)
        assert self._types(bundle) == [EVENT_EXECUTION_COMPLETED]
        assert bundle["events"][0]["payload"]["level"] == EVIDENCE_LEVEL_DEVICE_REPORTED

    @pytest.mark.parametrize("completed", [False, None, "yes", 1, "True"])
    def test_anything_but_true_is_one_failure_event(self, completed):
        from pcc_node.job_executor import build_device_reported_bundle, EVENT_EXECUTION_FAILED
        bundle = build_device_reported_bundle("j", self.DEVICE, {"kind": "ipp"}, completed=completed,
                                              error="jammed")
        assert self._types(bundle) == [EVENT_EXECUTION_FAILED]
        assert bundle["events"][0]["payload"]["error"] == "jammed"

    def test_callers_cannot_supply_events(self):
        from pcc_node.job_executor import build_device_reported_bundle
        with pytest.raises(TypeError):
            build_device_reported_bundle("j", self.DEVICE, {}, completed=True,
                                         events=[{"type": "custom_event"}])
