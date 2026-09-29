"""Deferred completion tracking: the IPP job-state poller.

A queued `lp` job is ACCEPTANCE, not completion (PR #343), so execute()
leaves it "running".  execute() now registers such a job, and the daemon
calls JobExecutor.poll_awaiting() once per cycle, which asks the printer
ONCE per job and reports only what the PRINTER says:

  * completed  -> one bundle [execution_completed {level: device_reported}]
                  and one 'completed' status, then the job leaves the registry
  * failure    -> one bundle [execution_failed] and one 'failed' status
  * waiting    -> nothing; the job stays registered
  * unobservable / deadline -> dropped with an ERROR and NO terminal status

Fail closed: an outcome nobody observed is never a completion.

r31 round-1 findings 2 and 5, and r31 round-2 finding 4, changed the poller:

  * IPP (round-1 finding 2): a terminal verdict now needs proof the answer is
    about THIS spooled job -- exactly one echoed job-id equal to the
    handle's -- and a 'completed' state 9 needs a well-formed, non-empty
    job-state-reasons (RFC 8011 sec 5.3.8 REQUIRES it).  See
    ipp_completion_verdict, ipp_job_id, ipp_job_state_reasons.
  * IPP reasons (round-2 finding 4): job-state-reasons values must match
    RFC 8011 sec 5.1.4 keyword syntax, and a 'completed' state 9 only reads
    as a clean completion for reasons in IPP_REASONS_COMPLETED_OK ('none',
    'job-completed-successfully', 'job-restartable'); anything else is
    UNOBSERVABLE, never COMPLETED.  See ipp_job_state_reasons,
    ipp_completion_verdict.
  * OctoPrint (r31 round-3): completion tracking was WITHDRAWN entirely.
    OctoPrint's REST API names no print attempt a later answer could be
    bound to, so a select+print it accepts stays acceptance-only forever
    (see JobExecutor._execute_octoprint, _completion_handle).  The private
    per-job-copy / baseline / print-history machinery this file used to
    test (octoprint_job_folder, octoprint_print_history,
    octoprint_history_verdict, TestOctoprintJobFolder,
    TestOctoprintPrintHistory, TestOctoPrintHistoryVerdict,
    TestOctoPrintCompletionTracking) was removed along with it -- see
    tests/test_r31_round3.py for the adversarial acceptance-only coverage.
  * Deadlines (finding 5): at most one request per job per
    COMPLETION_POLL_MIN_INTERVAL_S, each request timed out at the remaining
    budget (capped), and an answer that lands after the deadline is
    discarded even when it says completed.

As in test_job_executor.py, only `urlopen` (and `subprocess.run` for `lp`)
is faked: the adapters, the poller, the IPP codec, the evidence builder and
execute() all run for real underneath.
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
    COMPLETION_POLL_MIN_INTERVAL_S,
    COMPLETION_POLL_REQUEST_TIMEOUT_S,
    COMPLETION_POLL_TIMEOUT_MAX_S,
    EVENT_EXECUTION_COMPLETED,
    EVENT_EXECUTION_FAILED,
    EVENT_EXECUTION_PROGRESS,
    EVENT_EXECUTION_STARTED,
    EVIDENCE_LEVEL_DEVICE_REPORTED,
    IPP_COMPLETION_POLL_TIMEOUT_S,
    IPP_REASONS_STOPPED,
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
    ipp_job_id,
    ipp_job_state,
    ipp_job_state_reasons,
    ipp_job_urls,
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

    def read(self, amt=-1):
        # Like http.client.HTTPResponse.read(amt): the node reads a bounded size.
        return self._raw if amt is None or amt < 0 else self._raw[:amt]

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


def ipp_response(job_state=None, reasons=None, status=0x0000, request_id=1,
                 version=b"\x02\x00", job_group=True, extra=b"",
                 job_state_tag=0x23, job_state_value=None,
                 job_id=42, job_id_tag=0x21, job_id_value=None, duplicate_job_id=False,
                 reasons_value_tag=0x44, duplicate_reasons=False):
    """A Get-Job-Attributes response: operation group, then a job group.

    ``job_id`` defaults to 42 (:data:`IPP_HANDLE`'s job id) -- a conformant
    printer echoes the id it was asked about (r31 round-1 finding 2's fix).
    ``job_id=None`` omits the attribute; ``duplicate_job_id=True`` repeats it.

    ``reasons`` defaults to ``("none",)`` -- RFC 8011 sec 5.3.8 REQUIRES
    job-state-reasons, using the keyword 'none' when nothing applies, so a
    conformant printer always sends it.  ``reasons=()`` omits the attribute
    entirely (a non-conformant printer); ``duplicate_reasons=True`` repeats
    the whole attribute.
    """
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
        if job_id is not None or job_id_value is not None:
            value = job_id_value if job_id_value is not None else job_id.to_bytes(4, "big", signed=True)
            out += ipp_attr(job_id_tag, b"job-id", value)
            if duplicate_job_id:
                out += ipp_attr(job_id_tag, b"job-id", value)
        actual_reasons = ("none",) if reasons is None else reasons
        for i, reason in enumerate(actual_reasons):
            name = b"job-state-reasons" if i == 0 else b""
            out += ipp_attr(reasons_value_tag, name, reason.encode())
        if duplicate_reasons and actual_reasons:
            out += ipp_attr(reasons_value_tag, b"job-state-reasons", actual_reasons[0].encode())
    return out + extra + b"\x03"


# Captured from the Spark's own cupsd (cups-daemon 2.4.7) with the module's
# client: a READ-ONLY Get-Job-Attributes (request-id 7) on an existing job of
# this user that had been canceled.  No print job was created.  CUPS returned
# exactly the two requested attributes: job-state 7 and job-state-reasons.
# (Captured before r31 round-1 finding 2's fix started requesting job-id, so
# it has none -- see TestIppResponseDecoding below for what that means now.)
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
    ``reasons``/``job_id`` -- or raises/garbles when told to.  Defaults to a
    CONFORMANT printer: it answers about the job it was asked for (job-id 42,
    matching IPP_HANDLE) and always sends job-state-reasons."""

    def __init__(self, state=5, reasons=("none",), job_id=42):
        self.requests = []
        self.timeouts = []
        self.state = state
        self.reasons = reasons
        self.job_id = job_id
        self.fail_with = None      # an exception to raise instead
        self.raw = None            # verbatim response bytes instead
        self.ipp_status = 0x0000

    def __call__(self, req, *args, **kwargs):
        self.requests.append(req)
        self.timeouts.append(kwargs.get("timeout"))
        if self.fail_with is not None:
            raise self.fail_with
        if self.raw is not None:
            return _Resp(200, self.raw)
        request_id = int.from_bytes(req.data[4:8], "big", signed=True)
        return _Resp(200, ipp_response(
            job_state=self.state, reasons=self.reasons, job_id=self.job_id,
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
    # requested-attributes now asks for job-id, job-state and
    # job-state-reasons (r31 round-1 finding 2): the job-id lets the verdict
    # confirm an answer is about THIS job; the reasons qualify a 'completed'
    # state (see IPP_REASON_QUEUED_IN_DEVICE / RFC 8011 sec 5.3.8).
    EXPECTED = (
        b"\x02\x00"                                   # version-number 2.0
        b"\x00\x09"                                   # operation-id Get-Job-Attributes
        b"\x00\x00\x00\x07"                           # request-id 7
        b"\x01"                                       # operation-attributes-tag
        b"\x47" b"\x00\x12" b"attributes-charset" b"\x00\x05" b"utf-8"
        b"\x48" b"\x00\x1b" b"attributes-natural-language" b"\x00\x02" b"en"
        b"\x45" b"\x00\x0b" b"printer-uri" b"\x00\x23" b"ipp://10.0.0.1:631/printers/default"
        b"\x21" b"\x00\x06" b"job-id" b"\x00\x04" b"\x00\x00\x00\x2a"
        b"\x44" b"\x00\x14" b"requested-attributes" b"\x00\x06" b"job-id"
        b"\x44" b"\x00\x00" b"\x00\x09" b"job-state"            # additional-value
        b"\x44" b"\x00\x00" b"\x00\x11" b"job-state-reasons"    # additional-value
        b"\x03"                                       # end-of-attributes-tag
    )

    def test_request_bytes_are_exact(self):
        encoded = encode_ipp_get_job_attributes(self.PRINTER_URI, 42, 7)
        assert encoded == self.EXPECTED, (
            f"\nexpected {self.EXPECTED.hex()}\n     got {encoded.hex()}"
        )

    def test_request_decodes_as_the_ordered_operation_group(self):
        """The request is itself well-formed IPP: one operation group, the
        RFC-mandated order, requested-attributes multi-valued (job-id,
        job-state, job-state-reasons, in that order)."""
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
        assert requested == [(0x44, b"job-id"), (0x44, b"job-state"), (0x44, b"job-state-reasons")]

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
        to what a real CUPS server actually sent.  The real server was not
        asked for job-id (this node only requests it after r31 round-1
        finding 2's fix), so the capture has none."""
        assert ipp_response(
            job_state=7, reasons=("processing-to-stop-point",), request_id=7,
            job_id=None,
        ) == CUPS_CANCELED_JOB_RESPONSE

    def test_a_captured_cups_response_decodes(self):
        decoded = decode_ipp_response(CUPS_CANCELED_JOB_RESPONSE)
        assert decoded["version"] == (2, 0)
        assert decoded["statusCode"] == 0x0000
        assert decoded["requestId"] == 7
        assert [g["tag"] for g in decoded["groups"]] == [0x01, 0x02]
        state, reasons, problem = ipp_job_state(decoded)
        assert (state, reasons, problem) == (7, ["processing-to-stop-point"], "")
        # r31 round-1 finding 2's fix: no terminal verdict without a job-id
        # naming THIS job.  This real capture has none (the client had not
        # started requesting it yet), so -- even though its job-state alone
        # says "canceled" -- the fixed verdict refuses to call it, rather
        # than risk doing the same for an answer about someone else's job.
        verdict, observation = ipp_completion_verdict(200, CUPS_CANCELED_JOB_RESPONSE, 7, 42)
        assert verdict == POLL_WAITING
        assert "no usable job-id" in observation["reason"]
        assert observation["jobStateCode"] == 7

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
            200, ipp_response(job_state=state, request_id=11), 11, 42
        )
        assert verdict == expected, observation
        assert observation["jobStateCode"] == state

    @pytest.mark.parametrize("reasons,expected", [
        pytest.param(("job-completed-successfully",), POLL_COMPLETED, id="successfully"),
        pytest.param(("job-completed-with-warnings",), POLL_UNOBSERVABLE, id="with-warnings"),
        pytest.param(("none",), POLL_COMPLETED, id="none"),
        pytest.param(("job-completed-with-errors",), POLL_FAILED, id="with-errors"),
        pytest.param(("completed-with-errors",), POLL_FAILED, id="with-errors-table-15-spelling"),
        pytest.param(("queued-in-device",), POLL_UNOBSERVABLE, id="queued-in-device"),
        pytest.param(("job-completed-successfully", "queued-in-device"), POLL_UNOBSERVABLE,
                     id="queued-in-device-as-additional-value"),
    ])
    def test_completed_is_qualified_by_its_reasons(self, reasons, expected):
        verdict, observation = ipp_completion_verdict(
            200, ipp_response(job_state=9, reasons=reasons, request_id=3), 3, 42
        )
        assert verdict == expected, observation
        assert observation["jobStateReasons"] == list(reasons)

    @pytest.mark.parametrize("status", [0x0001, 0x0002, 0x00FF])
    def test_every_successful_status_code_is_read(self, status):
        body = ipp_response(job_state=9, status=status, request_id=3)
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_COMPLETED

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
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "not a success" in observation["reason"]

    @pytest.mark.parametrize("http_status", [0, -1, 400, 401, 404, 500, 503])
    def test_a_non_200_http_answer_is_waiting(self, http_status):
        """RFC 8010 sec 3.4.3: only an HTTP 200 carries an IPP status-code."""
        body = ipp_response(job_state=9, request_id=3)
        assert ipp_completion_verdict(http_status, body, 3, 42)[0] == POLL_WAITING

    def test_a_request_id_that_is_not_ours_is_waiting(self):
        body = ipp_response(job_state=9, request_id=4)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "not ours" in observation["reason"]

    @pytest.mark.parametrize("version", [b"\x00\x00", b"\x03\x00", b"\x3c\x68"])
    def test_a_response_that_is_not_ipp_1_or_2_is_waiting(self, version):
        body = ipp_response(job_state=9, request_id=3, version=version)
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_WAITING

    def test_ipp_1_1_responses_are_read(self):
        body = ipp_response(job_state=9, request_id=3, version=b"\x01\x01")
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_COMPLETED

    # --- where job-state may be read from --------------------------------

    def test_job_state_only_in_the_unsupported_group_is_not_the_jobs_state(self):
        """RFC 8011 sec 4.3.4.2: requested keywords the printer does not
        support may be echoed in the Unsupported group (0x05), which is not
        the job's own state -- even with a valid, correlated job-id."""
        body = ipp_response(
            request_id=3, job_id=42, reasons=(),
            extra=b"\x05" + ipp_attr(0x23, b"job-state", (9).to_bytes(4, "big")),
        )
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] is None

    def test_job_state_in_the_operation_group_is_not_the_jobs_state(self):
        body = (
            b"\x02\x00\x00\x00\x00\x00\x00\x03\x01"
            + ipp_attr(0x47, b"attributes-charset", b"utf-8")
            + ipp_attr(0x23, b"job-state", (9).to_bytes(4, "big"))
            + b"\x02"
            + ipp_attr(0x21, b"job-id", (42).to_bytes(4, "big"))
            + b"\x03"
        )
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] is None

    def test_an_empty_job_group_is_waiting(self):
        body = ipp_response(request_id=3, job_id=42, reasons=())
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] is None

    def test_two_job_groups_are_waiting(self):
        body = ipp_response(
            job_state=9, request_id=3,
            extra=b"\x02" + ipp_attr(0x23, b"job-state", (5).to_bytes(4, "big")),
        )
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_WAITING

    def test_a_repeated_job_state_is_waiting(self):
        """RFC 8010 sec 3.6: two attributes with one name make the group malformed."""
        body = ipp_response(
            job_state=9, request_id=3,
            extra=ipp_attr(0x23, b"job-state", (5).to_bytes(4, "big")),
        )
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] is None

    def test_a_multi_valued_job_state_is_waiting(self):
        body = ipp_response(
            job_state=9, request_id=3, job_id=None, reasons=(),
            extra=ipp_attr(0x23, b"", (5).to_bytes(4, "big")),
        )
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_WAITING

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
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
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
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] == 5

    def test_data_after_the_end_tag_is_ignored(self):
        body = ipp_response(job_state=9, request_id=3) + b"trailing document data"
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_COMPLETED

    # --- malformed / truncated --------------------------------------------
    # GOOD suppresses the (new) job-id / reasons attributes so these slice
    # offsets keep meaning exactly what their ids say -- truncation of the
    # wire format itself, not of the newer fields.

    GOOD = ipp_response(job_state=9, request_id=3, job_id=None, reasons=())

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
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "malformed" in observation["reason"]

    @pytest.mark.parametrize("body", ["a string", None, 12, {"job-state": 9}])
    def test_a_body_that_is_not_bytes_is_waiting(self, body):
        with pytest.raises(IppDecodeError):
            decode_ipp_response(body)
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_WAITING


# ---------------------------------------------------------------------------
# IPP: no terminal verdict without proof the answer is about THIS job
# (r31 round-1 finding 2)
# ---------------------------------------------------------------------------

class TestIppJobIdCorrelation:
    def test_another_jobs_id_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, job_id=999)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "not our job" in observation["reason"]
        assert observation["reportedJobId"] == 999

    def test_missing_job_id_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, job_id=None)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "no usable job-id" in observation["reason"]
        assert observation["reportedJobId"] is None

    def test_duplicate_job_id_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, job_id=42, duplicate_job_id=True)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "no usable job-id" in observation["reason"]

    def test_job_id_with_a_non_integer_tag_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, job_id=42, job_id_tag=0x44)  # keyword, not integer
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "not a 4-octet integer" in observation["reason"]

    def test_job_id_with_the_wrong_octet_count_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, job_id_value=b"\x00\x2a")  # 2 octets, not 4
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "not a 4-octet integer" in observation["reason"]


# ---------------------------------------------------------------------------
# IPP: job-state-reasons is REQUIRED to read a 'completed' state
# (RFC 8011 sec 5.3.8, r31 round-1 finding 2)
# ---------------------------------------------------------------------------

class TestIppReasonsAtStateNine:
    def test_missing_reasons_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, reasons=())
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "job-state-reasons is unusable" in observation["reason"]

    def test_duplicated_reasons_attribute_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, reasons=("none",), duplicate_reasons=True)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "job-state-reasons is unusable" in observation["reason"]

    def test_non_keyword_reason_value_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, reasons=("none",), reasons_value_tag=0x21)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "job-state-reasons is unusable" in observation["reason"]

    def test_empty_reason_value_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, reasons=("",))
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "job-state-reasons is unusable" in observation["reason"]

    @pytest.mark.parametrize("reason", sorted(IPP_REASONS_STOPPED))
    def test_a_stopped_reason_is_failed(self, reason):
        body = ipp_response(job_state=9, request_id=3, reasons=(reason,))
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_FAILED
        assert reason in observation["reason"]


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
        ex, gateway, clock = accept_ipp()
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

        clock.advance(COMPLETION_POLL_MIN_INTERVAL_S)
        poll(ex, printer)
        assert len(printer.requests) == 2, "exactly one request per job per cycle"
        ids = [int.from_bytes(r.data[4:8], "big") for r in printer.requests]
        assert ids[0] != ids[1] and all(1 <= i <= 2 ** 31 - 1 for i in ids)

    def test_polling_again_before_the_interval_elapses_sends_no_request(self):
        ex, gateway, clock = accept_ipp()
        printer = FakeIppPrinter(state=5)
        poll(ex, printer)
        assert len(printer.requests) == 1
        poll(ex, printer)  # no clock advance: skipped by the min poll interval
        assert len(printer.requests) == 1

    def test_the_request_timeout_is_the_remaining_budget_capped_at_ten_seconds(self):
        device = {**IPP_DEVICE, "completionPollTimeout": 7}
        ex, gateway, clock = accept_ipp(device=device)
        printer = FakeIppPrinter(state=5)
        poll(ex, printer)
        assert printer.timeouts == [7]  # remaining (7) is under the 10s cap

        clock.advance(5)
        poll(ex, printer)
        assert printer.timeouts[-1] == 2  # remaining is now 2s

    def test_the_request_timeout_is_capped_at_ten_seconds_even_with_a_large_budget(self):
        ex, gateway, clock = accept_ipp()  # default 3600s budget
        printer = FakeIppPrinter(state=5)
        poll(ex, printer)
        assert printer.timeouts == [COMPLETION_POLL_REQUEST_TIMEOUT_S]

    @pytest.mark.parametrize("state", [3, 4, 5, 6])
    def test_not_completed_states_leave_the_job_registered(self, state):
        ex, gateway, _ = accept_ipp()
        poll(ex, FakeIppPrinter(state=state))
        assert "job-ipp" in ex.awaiting_completion()
        assert _statuses(gateway) == ["running"]
        assert len(_bundles(gateway)) == 1

    def test_completed_is_reported_exactly_once(self):
        ex, gateway, clock = accept_ipp()
        printer = FakeIppPrinter(state=5)
        poll(ex, printer)
        printer.state = 9
        printer.reasons = ("job-completed-successfully",)
        clock.advance(COMPLETION_POLL_MIN_INTERVAL_S)
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

    def test_an_answer_that_arrives_after_the_deadline_is_discarded_even_when_completed(self, caplog):
        """r31 round-1 finding 5: the deadline is rechecked AFTER the answer
        too, so a slow device cannot buy a late completion."""
        device = {**IPP_DEVICE, "completionPollTimeout": 10}
        ex, gateway, clock = accept_ipp(device=device)

        def slow_printer(req, *args, **kwargs):
            clock.advance(20)  # the "request" takes longer than the remaining budget
            request_id = int.from_bytes(req.data[4:8], "big", signed=True)
            return _Resp(200, ipp_response(job_state=9, reasons=("none",), request_id=request_id))

        with caplog.at_level(logging.ERROR, logger=EXECUTOR_LOGGER):
            poll(ex, slow_printer)

        assert ex.awaiting_completion() == {}
        assert _statuses(gateway) == ["running"]
        assert len(_bundles(gateway)) == 1
        errors = _messages(caplog, logging.ERROR)
        assert any(
            "job-ipp" in m and "arrived after the deadline" in m and "stays 'running'" in m
            for m in errors
        ), errors

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

    def test_completion_poll_timeout_is_clamped_to_the_maximum(self):
        """r31 round-1 finding 5: an operator override cannot hold a job past
        COMPLETION_POLL_TIMEOUT_MAX_S (7 days)."""
        ex, _, clock = accept_ipp(device={**IPP_DEVICE, "completionPollTimeout": 999 * 24 * 3600})
        entry = ex.awaiting_completion()["job-ipp"]
        assert entry["deadline"] - entry["accepted_at"] == COMPLETION_POLL_TIMEOUT_MAX_S

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
