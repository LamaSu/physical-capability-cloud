"""Tests for JobExecutor: it refuses polled jobs (verdict 68b); lookups and evidence helpers."""

import json
import os
import platform
import re
import subprocess
from datetime import datetime
from pathlib import Path
from unittest import mock

import pytest

from pcc_node.job_executor import (
    JobExecutor,
    build_evidence_bundle,
    CAPABILITY_PROTOCOL_MAP,
)


# ---------------------------------------------------------------------------
# Evidence contract sec-10 (ledger OH-1)
#
# A device adapter reports failure by RETURNING a dict that says so, not by
# raising.  The settlement oracle keys off the event TYPE in the bundle, not
# the payload, so a failed run must never carry "execution_completed".
# ---------------------------------------------------------------------------

from pcc_node.job_executor import (  # noqa: E402
    classify_execution_result,
    describe_execution_failure,
    RESULT_SUCCESS,
    RESULT_FAILURE,
    RESULT_UNCLASSIFIABLE,
    RESULT_ACCEPTED,
    EVENT_EXECUTION_STARTED,
    EVENT_EXECUTION_PROGRESS,
    EVENT_EXECUTION_COMPLETED,
    EVENT_EXECUTION_FAILED,
    EVIDENCE_LEVEL_SUBMITTED,
    COMPLETION_FLAG_KEYS,
    ACCEPTANCE_FLAG_KEYS,
    _extract_device_error,
    _is_transport_failure,
)


# --- Censused adapter result shapes ----------------------------------------
# Each mirrors, verbatim, a return statement in pcc_node/job_executor.py.

# execute_ipp_print
#
# `lp` exiting 0 means CUPS QUEUED the job -- "request id is ..." is printed the
# moment the spooler accepts it, before a sheet moves.  So the adapter reports
# the ACCEPTANCE flag `submitted` on every path and never `printed`: this used
# to be IPP_SUCCESS with `printed: True`, which minted execution_completed for
# a job that had only been queued (must-close item 5).
IPP_ACCEPTED = {
    "submitted": True,
    "filepath": "/tmp/pcc-print.txt",
    "returncode": 0,
    "stdout": "request id is printer-1-1",
    "stderr": "",
    "printer_ip": "10.0.0.1",
    "printer_name": "Prusa",
}
IPP_FAIL_RETURNCODE = {
    "submitted": False,
    "filepath": "/tmp/pcc-print.txt",
    "returncode": 1,
    "stdout": "",
    "stderr": "lp: error - no such printer",
    "printer_ip": "10.0.0.1",
    "printer_name": "Prusa",
}
IPP_FAIL_TIMEOUT = {
    "submitted": False,
    "filepath": "/tmp/pcc-print.txt",
    "error": "print command timed out",
    "printer_ip": "10.0.0.1",
}
IPP_FAIL_NOT_FOUND = {
    "submitted": False,
    "filepath": "/tmp/pcc-print.txt",
    "error": "print command not available: lp not found",
    "printer_ip": "10.0.0.1",
}
IPP_FAIL_EXCEPTION = {
    "submitted": False,
    "filepath": "/tmp/pcc-print.txt",
    "error": "device unreachable",
    "printer_ip": "10.0.0.1",
}

# JobExecutor._execute_opentrons
#
# `submitted` is an ACCEPTANCE flag: the play action started the protocol.  A
# run that starts and then fails at step 40 was still submitted, so the adapter
# now polls the run to a terminal state and reports THAT.  Only the polled
# terminal status makes this a success.
OT_SUCCESS = {
    "runId": "run-1",
    "protocolId": "proto-abc",
    "submitted": True,
    "device": "http://192.168.1.200:31950",
    "status": "completed",
    "runStatus": "succeeded",
    # r31 item 2: the success now keeps the polled run body it was decided on.
    "response": {"data": {"id": "run-1", "status": "succeeded"}},
}
# The pre-fix shape: accepted, outcome never confirmed.  Locked as a shape that
# must NEVER release -- it is exactly what "the run was accepted" looks like.
# With no status of its own it now classifies as ACCEPTED (rule 10) rather than
# unclassifiable; either way it carries no execution_completed.
OT_ACCEPTED_ONLY = {
    "runId": "run-1",
    "protocolId": "proto-abc",
    "submitted": True,
    "device": "http://192.168.1.200:31950",
}
OT_NONTERMINAL = {
    "runId": "run-1",
    "protocolId": "proto-abc",
    "submitted": True,
    "device": "http://192.168.1.200:31950",
    "status": "running",
    "runStatus": "running",
    "note": "run started but did not reach a terminal state within 120s; outcome unknown",
    "data": {"data": {"id": "run-1", "status": "running"}},
}
OT_FAIL_RUN_FAILED = {
    "runId": "run-1",
    "protocolId": "proto-abc",
    "submitted": True,
    "device": "http://192.168.1.200:31950",
    "status": "failed",
    "runStatus": "failed",
    "error": "run finished with status 'failed'",
    "data": {"data": {"id": "run-1", "status": "failed"}},
}
OT_FAIL_RUN_ERRORS = {
    "runId": "run-1",
    "protocolId": "proto-abc",
    "submitted": True,
    "device": "http://192.168.1.200:31950",
    "status": "failed",
    "runStatus": "errored",
    "error": "run reported 1 protocol error(s): [{\"detail\": \"tip pickup failed\"}]",
    "data": {"data": {"id": "run-1", "errors": [{"detail": "tip pickup failed"}]}},
}
OT_FAIL_UPLOAD = {"error": "protocol upload failed: connection refused", "uploaded": False}
OT_FAIL_NO_UPLOAD_ID = {"error": "protocol upload returned no ID", "data": {}}
OT_FAIL_NO_PROTOCOL_ID = {
    "error": "no_protocol_id",
    "note": "opentrons job requires protocolId or pythonCode in parameters",
}
OT_FAIL_RUN_CREATE = {"error": "run creation failed HTTP 500", "data": {}}
OT_FAIL_RUN_ID_MISSING = {"error": "run_id_missing", "data": {}}
# Transport failure: http_util.http yields status 0, so the run-creation
# allowlist (`status not in (200, 201)`) rejects it -- observed from a live run
# against a dead socket, not hand-copied from a return statement.
OT_FAIL_TRANSPORT = {
    "error": "run creation failed HTTP 0",
    "data": {"error": "<urlopen error [Errno 111] Connection refused>"},
}

# JobExecutor._execute_octoprint
#
# A 2xx to `select + print` means OctoPrint ACCEPTED the job and started it,
# not that anything was printed, so the adapter's flag is `submitted`.  This
# used to be OP_SUCCESS with `printed: True` (must-close item 5).
OP_ACCEPTED = {
    "submitted": True,
    "filename": "benchy.gcode",
    "status_code": 200,
    "device": "http://10.0.0.20:5000",
}
OP_FAIL_NO_FILENAME = {
    "error": "no_filename",
    "note": "octoprint job requires filename in parameters",
}
OP_FAIL_BAD_STATUS = {
    "submitted": False,
    "filename": "benchy.gcode",
    "status_code": 500,
    "device": "http://10.0.0.20:5000",
}
# Transport failure: status 0 falls outside the (200, 201, 204) allowlist.
OP_FAIL_TRANSPORT = {
    "submitted": False,
    "filename": "benchy.gcode",
    "status_code": 0,
    "device": "http://10.0.0.20:5000",
    "error": "<urlopen error [Errno 111] Connection refused>",
}
# Reachable printer, transport-level success, DEVICE-level failure: OctoPrint
# answers 204 (in the allowlist) with a jam report.  Captured live -- see
# TestDeviceReportedFailureInABody.
OP_FAIL_ERROR_IN_2XX_BODY = {
    "submitted": False,
    "filename": "benchy.gcode",
    "status_code": 200,
    "device": "http://10.0.0.20:5000",
    "error": "E_JAM: carriage jam, job aborted",
}

# JobExecutor._execute_generic_http
# CHANGED (r31 astra verdict item 1): the response was {"ok": True}.  The live
# adapter now claims `executed` only when the body states completion, so the
# fixture mirrors a completion statement.
GH_SUCCESS = {
    "executed": True,
    "status_code": 200,
    "response": {"status": "completed"},
    "device": "http://10.0.0.9",
}
# RFC 9110 sec 15.3.3: 202 = accepted for processing, processing NOT completed.
# The device's own statement that the work has not finished, so the flag is
# `submitted`, never `executed`.  Captured from the live adapter -- see
# TestAcceptanceIsNotCompletion.
GH_ACCEPTED_202 = {
    "submitted": True,
    "status_code": 202,
    "response": {"jobId": "abc", "status": "queued"},
    "device": "http://10.0.0.9",
}
GH_FAIL_NO_BASE_URL = {"error": "no_base_url", "executed": False}
GH_FAIL_HTTP_ERROR = {
    "executed": False,
    "status_code": 503,
    "response": {"detail": "unavailable"},
    "device": "http://10.0.0.9",
}
# Transport failure (connection refused / DNS failure / timeout).  http_util
# returns status_code 0 -- a value NO adapter return statement mentions, which
# is exactly why the first census of literal return statements missed it.  Both
# shapes below were captured from a live run against a dead socket.
GH_TRANSPORT_PRE_FIX = {
    # What the adapter produced BEFORE the fix: a bare `status < 400` admitted
    # the sentinel, so an unreachable device claimed executed=True and settled
    # as a success.  Retained as a fixture so the classifier's backstop stays
    # fail-closed on this shape even if an adapter reintroduces it.
    "executed": True,
    "status_code": 0,
    "response": {"error": "<urlopen error [Errno 111] Connection refused>"},
    "device": "http://10.255.255.1:9",
}
GH_FAIL_TRANSPORT = {
    "executed": False,
    "status_code": 0,
    "response": {"error": "<urlopen error [Errno 111] Connection refused>"},
    "device": "http://10.255.255.1:9",
    "error": "<urlopen error [Errno 111] Connection refused>",
}

# --- transport succeeds, the DEVICE fails ----------------------------------
# The band `200 <= status < 400` plus an error-lift gated on `status <= 0` meant
# a REACHABLE device answering 2xx with a failure envelope minted
# `executed: True` -> execution_completed -> golden-v4 RELEASED it.  This is the
# ordinary instrument failure mode (JSON-RPC, SiLA, OPC-UA HTTP bridges,
# LabVIEW web services, most vendor REST), and generic-http is the catch-all
# branch every unmapped protocol lands on -- so it is the widest path, not an
# edge.  Every shape below was captured from the live adapter; see
# TestDeviceReportedFailureInABody.
GH_FAIL_JSONRPC_ERROR_200 = {
    "executed": False,
    "status_code": 200,
    "response": {
        "jsonrpc": "2.0",
        "id": 1,
        "error": {"code": -32000, "message": "actuator jammed; job NOT executed"},
    },
    "device": "http://10.0.0.9",
    "error": 'error={"code": -32000, "message": "actuator jammed; job NOT executed"}',
}
GH_FAIL_STATUS_ERROR_200 = {
    "executed": False,
    "status_code": 200,
    "response": {"status": "error", "message": "sample rack empty"},
    "device": "http://10.0.0.9",
    "error": "device reported status='error'",
}
GH_FAIL_SUCCESS_FALSE_200 = {
    "executed": False,
    "status_code": 200,
    "response": {"success": False, "error": "sample rack empty; nothing dispensed"},
    "device": "http://10.0.0.9",
    "error": "sample rack empty; nothing dispensed",
}
GH_FAIL_SOAP_FAULT_200 = {
    "executed": False,
    "status_code": 200,
    "response": "<soap:Envelope><soap:Fault><faultstring>jam</faultstring></soap:Fault></soap:Envelope>",
    "device": "http://10.0.0.9",
    "error": "device returned a fault body (matched '<soap:fault')",
}
# A 3xx sat inside the old `status < 400` band: a redirect nobody followed.
GH_FAIL_REDIRECT_304 = {
    "executed": False,
    "status_code": 304,
    "response": "",
    "device": "http://10.0.0.9",
    "error": "device returned HTTP 304",
}
# The pre-fix shapes -- what the adapter USED to mint for the two cases above.
# Retained so the classifier stays fail-closed on them even if an adapter
# reintroduces the transport-only derivation.
GH_2XX_FAILURE_PRE_FIX = {
    "executed": True,
    "status_code": 200,
    "response": {"error": {"code": -32000, "message": "actuator jammed"}},
    "device": "http://10.0.0.9",
}
GH_REDIRECT_PRE_FIX = {
    "executed": True,
    "status_code": 304,
    "response": "",
    "device": "http://10.0.0.9",
}

# Device-reported completion only.  IPP and OctoPrint left this list for
# ACCEPTED_SHAPES (must-close item 5): neither adapter observes completion.
SUCCESS_SHAPES = [
    pytest.param(OT_SUCCESS, id="opentrons-run-succeeded"),
    pytest.param(GH_SUCCESS, id="generic-http-executed-true"),
]

# SUBMITTED evidence: the device accepted the command; completion unobserved.
# Must produce execution_progress (level "submitted"), never
# execution_completed, and no terminal job status.
ACCEPTED_SHAPES = [
    pytest.param(IPP_ACCEPTED, id="ipp-lp-exit-0-queued"),
    pytest.param(OP_ACCEPTED, id="octoprint-select-print-2xx"),
    pytest.param(GH_ACCEPTED_202, id="generic-http-202-accepted"),
    pytest.param(OT_ACCEPTED_ONLY, id="opentrons-accepted-outcome-unknown"),
]

FAILURE_SHAPES = [
    pytest.param(IPP_FAIL_RETURNCODE, id="ipp-nonzero-returncode"),
    pytest.param(IPP_FAIL_TIMEOUT, id="ipp-timeout"),
    pytest.param(IPP_FAIL_NOT_FOUND, id="ipp-command-not-found"),
    pytest.param(IPP_FAIL_EXCEPTION, id="ipp-generic-exception"),
    pytest.param(OT_FAIL_UPLOAD, id="opentrons-upload-failed"),
    pytest.param(OT_FAIL_NO_UPLOAD_ID, id="opentrons-no-upload-id"),
    pytest.param(OT_FAIL_NO_PROTOCOL_ID, id="opentrons-no-protocol-id"),
    pytest.param(OT_FAIL_RUN_CREATE, id="opentrons-run-create-failed"),
    pytest.param(OT_FAIL_RUN_ID_MISSING, id="opentrons-run-id-missing"),
    pytest.param(OT_FAIL_RUN_FAILED, id="opentrons-run-terminal-failed"),
    pytest.param(OT_FAIL_RUN_ERRORS, id="opentrons-run-protocol-errors"),
    pytest.param(OP_FAIL_NO_FILENAME, id="octoprint-no-filename"),
    pytest.param(OP_FAIL_BAD_STATUS, id="octoprint-bad-http-status"),
    pytest.param(OP_FAIL_ERROR_IN_2XX_BODY, id="octoprint-error-in-2xx-body"),
    pytest.param(GH_FAIL_NO_BASE_URL, id="generic-http-no-base-url"),
    pytest.param(GH_FAIL_HTTP_ERROR, id="generic-http-error-status"),
    pytest.param(GH_FAIL_TRANSPORT, id="generic-http-transport-failure"),
    pytest.param(GH_TRANSPORT_PRE_FIX, id="generic-http-transport-pre-fix-shape"),
    pytest.param(GH_FAIL_JSONRPC_ERROR_200, id="generic-http-jsonrpc-error-200"),
    pytest.param(GH_FAIL_STATUS_ERROR_200, id="generic-http-status-error-200"),
    pytest.param(GH_FAIL_SUCCESS_FALSE_200, id="generic-http-success-false-200"),
    pytest.param(GH_FAIL_SOAP_FAULT_200, id="generic-http-soap-fault-200"),
    pytest.param(GH_FAIL_REDIRECT_304, id="generic-http-redirect-304"),
    pytest.param(GH_2XX_FAILURE_PRE_FIX, id="generic-http-2xx-failure-pre-fix-shape"),
    pytest.param(GH_REDIRECT_PRE_FIX, id="generic-http-redirect-pre-fix-shape"),
    pytest.param(OP_FAIL_TRANSPORT, id="octoprint-transport-failure"),
    pytest.param(OT_FAIL_TRANSPORT, id="opentrons-transport-failure"),
]

UNCLASSIFIABLE_SHAPES = [
    pytest.param(None, id="none"),
    pytest.param({}, id="empty-dict"),
    pytest.param("completed", id="bare-string"),
    pytest.param([], id="empty-list"),
    pytest.param([{"printed": True}], id="list-of-dicts"),
    pytest.param(0, id="int-zero"),
    pytest.param({"foo": "bar"}, id="novel-shape"),
    pytest.param({"status": "running"}, id="unknown-status-value"),
    # OT_ACCEPTED_ONLY moved to ACCEPTED_SHAPES.  OT_NONTERMINAL stays: it
    # names a status of its own ("running"), and rule 8 outranks rule 10.
    pytest.param(OT_NONTERMINAL, id="opentrons-non-terminal-run"),
]


def _event_types(bundle):
    return [e["type"] for e in bundle["events"]]


def _bundle_text(bundle):
    """Serialize a bundle for golden-style substring assertions."""
    return json.dumps(bundle, default=str)


# ---------------------------------------------------------------------------
# classify_execution_result
# ---------------------------------------------------------------------------

class TestClassifyExecutionResult:
    @pytest.mark.parametrize("result", SUCCESS_SHAPES)
    def test_censused_success_shapes(self, result):
        assert classify_execution_result(result) == RESULT_SUCCESS

    @pytest.mark.parametrize("result", FAILURE_SHAPES)
    def test_censused_failure_shapes(self, result):
        assert classify_execution_result(result) == RESULT_FAILURE

    @pytest.mark.parametrize("result", UNCLASSIFIABLE_SHAPES)
    def test_unclassifiable_shapes(self, result):
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE

    @pytest.mark.parametrize("result", ACCEPTED_SHAPES)
    def test_censused_accepted_shapes(self, result):
        assert classify_execution_result(result) == RESULT_ACCEPTED

    @pytest.mark.parametrize("status", ["failed", "error"])
    def test_status_key_failure_values(self, status):
        assert classify_execution_result({"status": status}) == RESULT_FAILURE

    @pytest.mark.parametrize("status", ["completed", "success", "ok"])
    def test_status_key_success_values(self, status):
        assert classify_execution_result({"status": status}) == RESULT_SUCCESS

    def test_no_device_found_shape_is_failure(self):
        """The shape execute() itself builds for a missing device."""
        result = {
            "status": "failed",
            "error": "no_device_found",
            "capabilityType": "document-printing",
        }
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_error_key_outranks_boolean_success_flag(self):
        """A stale printed:True must never mask a populated error."""
        assert classify_execution_result({"printed": True, "error": "boom"}) == RESULT_FAILURE

    def test_error_key_outranks_success_status(self):
        assert classify_execution_result({"status": "completed", "error": "boom"}) == RESULT_FAILURE

    @pytest.mark.parametrize("flag", ["printed", "submitted", "executed"])
    @pytest.mark.parametrize("value", [1, "true", "yes", [1], {"a": 1}])
    def test_non_bool_truthy_flag_is_failure(self, flag, value):
        """Only an unambiguous boolean True counts as success (fail closed)."""
        assert classify_execution_result({flag: value}) == RESULT_FAILURE

    @pytest.mark.parametrize("flag", COMPLETION_FLAG_KEYS)
    def test_completion_flag_true_is_success(self, flag):
        """`printed`/`executed` mean the device reported the WORK finished."""
        assert classify_execution_result({flag: True}) == RESULT_SUCCESS

    @pytest.mark.parametrize("flag", ACCEPTANCE_FLAG_KEYS)
    def test_acceptance_flag_true_alone_is_not_a_success(self, flag):
        """`submitted` means the device TOOK the request, not that it finished.

        An Opentrons run that is playing has been submitted and can still fail
        at step 40, so acceptance alone must settle as neither -- it emits no
        execution_completed for golden-v4 to release on.  It is now named
        ACCEPTED (rule 10) rather than unclassifiable; still never a success.
        """
        verdict = classify_execution_result({flag: True})
        assert verdict != RESULT_SUCCESS
        assert verdict == RESULT_ACCEPTED

    @pytest.mark.parametrize("result", [
        pytest.param({"submitted": True, "error": "boom"}, id="error-key"),
        pytest.param({"submitted": True, "response": {"error": "jam"}}, id="nested-error"),
        pytest.param({"submitted": True, "status_code": 500}, id="http-500"),
        pytest.param({"submitted": True, "status_code": 0}, id="transport-sentinel"),
        pytest.param({"submitted": True, "returncode": 1}, id="nonzero-returncode"),
        pytest.param({"submitted": True, "status": "failed"}, id="failure-status"),
        pytest.param({"submitted": True, "printed": False}, id="false-completion-flag"),
    ])
    def test_every_failure_rule_outranks_acceptance(self, result):
        """Rule 10 sits below every failure rule: acceptance never masks one."""
        assert classify_execution_result(result) == RESULT_FAILURE

    @pytest.mark.parametrize("result", [
        pytest.param({"submitted": True, "printed": True}, id="completion-flag"),
        pytest.param({"submitted": True, "executed": True}, id="executed-flag"),
        pytest.param({"submitted": True, "status": "succeeded"}, id="success-status"),
    ])
    def test_device_reported_completion_outranks_acceptance(self, result):
        """A completion the device itself reported is a success (rules 7, 9)."""
        assert classify_execution_result(result) == RESULT_SUCCESS

    @pytest.mark.parametrize("status", ["running", "rejected", "paused", "jammed"])
    def test_unrecognised_status_outranks_acceptance(self, status):
        """Rule 8 before rule 10: a status the classifier cannot read may name
        a failure it does not know, so it fails closed as unclassifiable
        instead of leaving the job waiting as accepted."""
        assert classify_execution_result(
            {"submitted": True, "status": status}
        ) == RESULT_UNCLASSIFIABLE

    @pytest.mark.parametrize("flag", ["printed", "submitted", "executed"])
    def test_boolean_flag_false_is_failure(self, flag):
        assert classify_execution_result({flag: False}) == RESULT_FAILURE

    def test_acceptance_flag_plus_terminal_status_is_a_success(self):
        assert classify_execution_result(
            {"submitted": True, "status": "completed", "runStatus": "succeeded"}
        ) == RESULT_SUCCESS

    # --- rule order ---------------------------------------------------------

    def test_false_flag_outranks_a_success_status(self):
        """`{"status": "ok", "printed": False}` is a failure, not a success."""
        assert classify_execution_result({"status": "ok", "printed": False}) == RESULT_FAILURE

    def test_every_flag_is_checked_not_just_the_first(self):
        """First-key-present-wins let `executed: False` hide behind `printed`."""
        assert classify_execution_result({"printed": True, "executed": False}) == RESULT_FAILURE
        assert classify_execution_result({"executed": True, "printed": False}) == RESULT_FAILURE

    def test_unrecognised_status_string_is_never_overridden_by_a_flag(self):
        """The device named a non-terminal outcome; a flag must not outvote it."""
        assert classify_execution_result(
            {"submitted": True, "status": "running"}
        ) == RESULT_UNCLASSIFIABLE
        assert classify_execution_result(
            {"printed": True, "status": "paused"}
        ) == RESULT_UNCLASSIFIABLE

    @pytest.mark.parametrize("status", ["FAILED", "Failed", " failed ", "Error"])
    def test_failure_status_matching_is_case_insensitive(self, status):
        """A device that shouts its failure must not fall through to a flag."""
        assert classify_execution_result({"status": status, "printed": True}) == RESULT_FAILURE

    @pytest.mark.parametrize("status", ["COMPLETED", "Succeeded", " ok "])
    def test_success_status_matching_is_case_insensitive(self, status):
        assert classify_execution_result({"status": status}) == RESULT_SUCCESS

    # --- backstops on the fields an adapter derives its flag from -----------

    @pytest.mark.parametrize("status_code", [0, -1, 301, 304, 400, 404, 500, 503])
    def test_status_code_outside_2xx_outranks_a_claimed_success(self, status_code):
        result = {"executed": True, "status_code": status_code, "response": ""}
        assert classify_execution_result(result) == RESULT_FAILURE

    # 202 is not here: it is the device saying the work has not finished (see
    # TestAcceptedStatusAndShapeGaps).
    @pytest.mark.parametrize("status_code", [200, 201, 204, 299])
    def test_2xx_status_codes_still_permit_success(self, status_code):
        result = {"executed": True, "status_code": status_code, "response": {"ok": True}}
        assert classify_execution_result(result) == RESULT_SUCCESS

    @pytest.mark.parametrize("returncode", [1, -1, "0", "1", None, 2.0])
    def test_non_zero_returncode_outranks_a_stale_printed_flag(self, returncode):
        result = {"printed": True, "returncode": returncode, "stderr": "lp: not accepted"}
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_zero_returncode_still_permits_success(self):
        assert classify_execution_result({"printed": True, "returncode": 0}) == RESULT_SUCCESS

    # --- the device's own answer, wherever the adapter parked it ------------

    @pytest.mark.parametrize("container", ["response", "data", "body", "payload"])
    def test_nested_error_outranks_a_transport_derived_flag(self, container):
        """Rule 3b: an adapter that forgets to lift a nested error is still
        fail-closed, so the guarantee does not depend on future review."""
        result = {"executed": True, "status_code": 200, container: {"error": "jam"}}
        assert classify_execution_result(result) == RESULT_FAILURE

    @pytest.mark.parametrize("body", [
        pytest.param({"error": {"code": -32000, "message": "jammed"}}, id="jsonrpc-error"),
        pytest.param({"errors": ["run aborted"]}, id="errors-list"),
        pytest.param({"fault": "E_JAM"}, id="fault"),
        pytest.param({"success": False}, id="success-false"),
        pytest.param({"ok": False}, id="ok-false"),
        pytest.param({"status": "error"}, id="nested-status-error"),
        pytest.param({"status": "FAILED"}, id="nested-status-uppercase"),
        pytest.param("<soap:Fault><faultstring>jam</faultstring></soap:Fault>", id="soap-fault"),
        pytest.param("<error>carriage jam</error>", id="xml-error-element"),
    ])
    def test_nested_failure_envelopes_are_failures(self, body):
        result = {"executed": True, "status_code": 200, "response": body}
        assert classify_execution_result(result) == RESULT_FAILURE

    @pytest.mark.parametrize("body", [
        pytest.param({"ok": True}, id="ok-true"),
        pytest.param({"success": True}, id="success-true"),
        pytest.param({"error": None}, id="error-null"),
        pytest.param({"errors": []}, id="errors-empty"),
        pytest.param({"status": "ok"}, id="nested-status-ok"),
        pytest.param({"jobId": "abc"}, id="opaque-json"),
        pytest.param("", id="empty-body"),
        pytest.param("OK", id="plain-text-ok"),
    ])
    def test_nested_scan_does_not_invent_failures(self, body):
        """It reads POSITIVE failure signals only -- no signal is not a failure."""
        result = {"executed": True, "status_code": 200, "response": body}
        assert classify_execution_result(result) == RESULT_SUCCESS

    def test_unhashable_status_value_does_not_raise(self):
        assert classify_execution_result({"status": ["failed"]}) == RESULT_UNCLASSIFIABLE

    def test_is_pure_and_does_not_mutate_input(self):
        result = dict(IPP_FAIL_TIMEOUT)
        before = json.dumps(result, sort_keys=True)
        classify_execution_result(result)
        assert json.dumps(result, sort_keys=True) == before

    @pytest.mark.parametrize("result", FAILURE_SHAPES)
    def test_describe_failure_returns_non_empty_string(self, result):
        assert isinstance(describe_execution_failure(result), str)
        assert describe_execution_failure(result).strip()

    @pytest.mark.parametrize("result", UNCLASSIFIABLE_SHAPES)
    def test_describe_failure_never_raises(self, result):
        assert isinstance(describe_execution_failure(result), str)


# ---------------------------------------------------------------------------
# build_evidence_bundle -- outcome event mapping
# ---------------------------------------------------------------------------

class TestEvidenceBundleOutcomeEvents:
    DEVICE = {"id": "d1", "protocol": "ipp"}

    @pytest.mark.parametrize("result", SUCCESS_SHAPES)
    def test_success_emits_execution_completed_only(self, result):
        bundle = build_evidence_bundle("j1", self.DEVICE, result)
        types = _event_types(bundle)
        assert types == [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_COMPLETED]
        assert EVENT_EXECUTION_FAILED not in types
        assert EVENT_EXECUTION_FAILED not in _bundle_text(bundle)

    @pytest.mark.parametrize("result", FAILURE_SHAPES)
    def test_failure_emits_execution_failed_and_never_completed(self, result):
        bundle = build_evidence_bundle("j1", self.DEVICE, result)
        types = _event_types(bundle)
        assert types == [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_FAILED]
        assert EVENT_EXECUTION_COMPLETED not in types

    @pytest.mark.parametrize("result", FAILURE_SHAPES)
    def test_golden_failure_bundle_never_contains_execution_completed(self, result):
        """Golden-style: the literal string must not appear anywhere in the bundle.

        This is the exact check the settlement oracle's program performs --
        presence of the event type, not inspection of the payload.
        """
        bundle = build_evidence_bundle("j1", self.DEVICE, result)
        assert "execution_completed" not in _bundle_text(bundle)

    @pytest.mark.parametrize("result", FAILURE_SHAPES)
    def test_failure_event_payload_carries_error_and_result(self, result):
        bundle = build_evidence_bundle("j1", self.DEVICE, result)
        payload = bundle["events"][1]["payload"]
        assert payload["result"] == result
        assert isinstance(payload["error"], str) and payload["error"].strip()

    @pytest.mark.parametrize("result", UNCLASSIFIABLE_SHAPES)
    def test_unclassifiable_emits_neither_completed_nor_failed(self, result):
        bundle = build_evidence_bundle("j1", self.DEVICE, result)
        types = _event_types(bundle)
        assert EVENT_EXECUTION_COMPLETED not in types
        assert EVENT_EXECUTION_FAILED not in types
        assert types == [EVENT_EXECUTION_STARTED]
        assert "execution_completed" not in _bundle_text(bundle)

    @pytest.mark.parametrize("result", UNCLASSIFIABLE_SHAPES)
    def test_unclassifiable_keeps_the_raw_result_without_an_outcome_event(self, result):
        bundle = build_evidence_bundle("j1", self.DEVICE, result)
        assert bundle["result"] == result
        assert len(bundle["events"]) == 1

    # --- accepted: SUBMITTED evidence (must-close item 5) --------------------

    @pytest.mark.parametrize("result", ACCEPTED_SHAPES)
    def test_accepted_emits_execution_progress_and_no_outcome_event(self, result):
        bundle = build_evidence_bundle("j1", self.DEVICE, result)
        types = _event_types(bundle)
        assert types == [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_PROGRESS]
        assert EVENT_EXECUTION_COMPLETED not in types
        assert EVENT_EXECUTION_FAILED not in types

    @pytest.mark.parametrize("result", ACCEPTED_SHAPES)
    def test_golden_accepted_bundle_never_contains_execution_completed(self, result):
        """Golden-style, as for failures: the oracle releases on the PRESENCE
        of execution_completed, so the literal string must appear nowhere in a
        bundle whose device only accepted the command."""
        bundle = build_evidence_bundle("j1", self.DEVICE, result)
        assert "execution_completed" not in _bundle_text(bundle)

    @pytest.mark.parametrize("result", ACCEPTED_SHAPES)
    def test_accepted_progress_payload_records_level_and_raw_result(self, result):
        bundle = build_evidence_bundle("j1", self.DEVICE, result)
        progress = bundle["events"][1]
        assert progress["type"] == EVENT_EXECUTION_PROGRESS
        assert progress["payload"]["level"] == "submitted"
        assert progress["payload"]["level"] == EVIDENCE_LEVEL_SUBMITTED
        assert progress["payload"]["result"] == result
        # Old: the payload was exactly {level, result}.  New: it also commits
        # the PCC job (LO-EV-9, evidence #3241): every event binds payload.jobId.
        assert progress["payload"] == {"level": "submitted", "result": result, "jobId": "j1"}
        assert progress["timestamp"] == bundle["executedAt"]
        assert bundle["result"] == result

    def test_execution_started_present_for_every_verdict(self):
        for result in (GH_SUCCESS, IPP_ACCEPTED, IPP_FAIL_TIMEOUT, {}, None, {"foo": "bar"}):
            bundle = build_evidence_bundle("j1", self.DEVICE, result)
            assert _event_types(bundle)[0] == EVENT_EXECUTION_STARTED

    def test_one_outcome_event_when_classified_and_none_otherwise(self):
        # IPP_ACCEPTED used to sit here as IPP_SUCCESS with 1 outcome event;
        # an accepted print has none (item 5).  GH_SUCCESS keeps the success
        # row a real completion.
        outcome_types = {EVENT_EXECUTION_COMPLETED, EVENT_EXECUTION_FAILED}
        for result, expected in (
            (GH_SUCCESS, 1),
            (IPP_FAIL_TIMEOUT, 1),
            (OP_FAIL_BAD_STATUS, 1),
            (IPP_ACCEPTED, 0),
            (OP_ACCEPTED, 0),
            (GH_ACCEPTED_202, 0),
            ({}, 0),
            (None, 0),
        ):
            bundle = build_evidence_bundle("j1", self.DEVICE, result)
            found = [t for t in _event_types(bundle) if t in outcome_types]
            assert len(found) == expected, f"{result!r}: expected {expected} outcome event(s), got {found}"

    def test_every_emitted_type_is_in_the_evidence_vocabulary(self):
        """Parse the closed EVIDENCE_EVENT_TYPES enum from @pcc/spec and prove
        every type this producer can synthesize is a member of it."""
        spec = Path(__file__).resolve().parents[2] / "spec" / "src" / "types" / "evidence.ts"
        source = spec.read_text(encoding="utf-8")
        block = source.split("export const EVIDENCE_EVENT_TYPES = [", 1)[1].split("] as const", 1)[0]
        vocabulary = set(re.findall(r'"([a-z_]+)"', block))
        assert len(vocabulary) > 20, "failed to parse EVIDENCE_EVENT_TYPES"
        emitted = set()
        for result in (
            GH_SUCCESS,          # success        -> execution_completed
            IPP_ACCEPTED,        # accepted       -> execution_progress
            OP_ACCEPTED,
            GH_ACCEPTED_202,
            IPP_FAIL_TIMEOUT,    # failure        -> execution_failed
            OP_FAIL_BAD_STATUS,
            {}, None, {"foo": "bar"},  # unclassifiable -> execution_started only
        ):
            emitted.update(_event_types(build_evidence_bundle("j1", self.DEVICE, result)))
        assert emitted, "no events synthesized"
        # Every verdict's event must actually be exercised -- otherwise a shape
        # changing verdict silently drops a type from this guard.
        assert emitted == {
            EVENT_EXECUTION_STARTED,
            EVENT_EXECUTION_PROGRESS,
            EVENT_EXECUTION_COMPLETED,
            EVENT_EXECUTION_FAILED,
        }, f"guard no longer covers every synthesized type: {sorted(emitted)}"
        assert emitted <= vocabulary, f"not in EVIDENCE_EVENT_TYPES: {sorted(emitted - vocabulary)}"

    def test_result_is_still_embedded_verbatim(self):
        bundle = build_evidence_bundle("j1", self.DEVICE, IPP_FAIL_TIMEOUT)
        assert bundle["result"] == IPP_FAIL_TIMEOUT

    def test_there_is_no_events_override_to_bypass_classification(self):
        """CHANGED (r31 astra verdict item 6).  Old: asserted that an explicit
        `events` list bypassed classification ("escape hatch unchanged").  The
        reviewer's exploit -- a failed result with caller-supplied
        execution_completed + execution_failed + custom_event -- is now a
        TypeError, and the classified trail for the same result has no
        completion."""
        events = [{"type": "execution_completed"}, {"type": "execution_failed"},
                  {"type": "custom_event"}]
        with pytest.raises(TypeError):
            build_evidence_bundle("j1", self.DEVICE, {"submitted": False, "error": "jam"}, events=events)
        types = [e["type"] for e in build_evidence_bundle(
            "j1", self.DEVICE, {"submitted": False, "error": "jam"})["events"]]
        assert "execution_completed" not in types
        assert "execution_failed" in types


# ---------------------------------------------------------------------------
# The last shapes by which a submitted or failed result could still read as a
# success (review of item 5 against the R31 question: can a FAILED or merely
# SUBMITTED device result reach execution_completed by any path?)
# ---------------------------------------------------------------------------


class TestAcceptedStatusAndShapeGaps:
    @pytest.mark.parametrize("result", [
        pytest.param({"executed": True, "status_code": 202}, id="executed-flag"),
        pytest.param({"printed": True, "status_code": 202}, id="printed-flag"),
        pytest.param({"status": "completed", "status_code": 202}, id="success-status"),
        pytest.param({"status_code": 202, "response": {"ok": True}}, id="bare-202"),
        pytest.param({"submitted": True, "status_code": 202}, id="submitted-flag"),
    ])
    def test_a_202_never_classifies_as_success(self, result):
        assert classify_execution_result(result) == RESULT_ACCEPTED

    @pytest.mark.parametrize("result", [
        pytest.param({"status_code": 202, "error": "queue full"}, id="error"),
        pytest.param({"status_code": 202, "executed": False}, id="false-flag"),
        pytest.param({"status_code": 202, "status": "failed"}, id="failure-status"),
    ])
    def test_a_failed_202_is_still_a_failure(self, result):
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_an_unreadable_status_still_outranks_a_202(self):
        result = {"status_code": 202, "status": "jammed"}
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE

    @pytest.mark.parametrize("status", [
        pytest.param(["failed"], id="list"),
        pytest.param({"state": "failed"}, id="dict"),
        pytest.param(0, id="int"),
        pytest.param(False, id="bool"),
    ])
    @pytest.mark.parametrize("flag", ["executed", "printed"])
    def test_a_non_string_status_is_unclassifiable(self, status, flag):
        result = {flag: True, "status": status}
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE

    def test_an_absent_status_is_not_a_non_string_status(self):
        """Positive control: with no status key at all, a completion flag is
        still a success."""
        assert classify_execution_result({"executed": True}) == RESULT_SUCCESS

    def test_an_explicit_null_status_is_unreadable_not_absent(self):
        """CHANGED (r31 astra verdict item 3): `{"executed": True, "status":
        None}` used to be asserted RESULT_SUCCESS here, reading an explicit null
        as "no status".  A present status that cannot be read may be a failure
        in another shape, so it is now unclassifiable (rule 8)."""
        assert classify_execution_result({"executed": True, "status": None}) == RESULT_UNCLASSIFIABLE

    def test_a_202_bundle_never_carries_execution_completed(self):
        bundle = build_evidence_bundle(
            "job-202", {"id": "gh"}, {"executed": True, "status_code": 202}
        )
        assert _event_types(bundle) == [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_PROGRESS]
        assert "execution_completed" not in _bundle_text(bundle)


# ---------------------------------------------------------------------------
# r31 astra verdict (bus #2476), items 1 and 3: the device-body scan must read
# nested and list-shaped failures, a success key must hold the boolean True,
# and a PRESENT but malformed outcome field must never reach a success.
# ---------------------------------------------------------------------------


class TestR31MalformedFieldsAndDeepBodies:
    @pytest.mark.parametrize("status_code", [
        pytest.param("202", id="string-202"),
        pytest.param("0", id="string-0"),
        pytest.param("500", id="string-500"),
        pytest.param(False, id="bool-false"),
        pytest.param(None, id="null"),
        pytest.param(200.0, id="float"),
    ])
    @pytest.mark.parametrize("flag", ["executed", "printed"])
    def test_a_malformed_status_code_never_classifies_as_success(self, flag, status_code):
        result = {flag: True, "status_code": status_code}
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE

    @pytest.mark.parametrize("body", [
        pytest.param({"data": {"error": "jam"}}, id="nested-error"),
        pytest.param({"result": {"success": False}}, id="nested-success-false"),
        pytest.param([{"error": "jam"}], id="error-in-list"),
        pytest.param({"success": "false"}, id="string-false-success"),
        pytest.param({"ok": 0}, id="zero-ok"),
        pytest.param({"succeeded": None}, id="null-succeeded"),
        pytest.param({"status": ["failed"]}, id="status-list"),
        pytest.param({"a": {"b": {"c": {"state": "ABORTED"}}}}, id="deep-state"),
        pytest.param({"jobs": [{"id": 1}, {"id": 2, "status": "error"}]}, id="failure-in-second-item"),
        pytest.param({"raw": "<soap:Envelope><soap:Fault>x</soap:Fault></soap:Envelope>"}, id="nested-soap-fault"),
    ])
    def test_a_2xx_carrying_a_nested_or_malformed_failure_is_a_failure(self, body):
        result = {"executed": True, "status_code": 200, "response": body}
        assert _extract_device_error(body) is not None
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_a_body_too_deep_to_verify_is_a_failure(self):
        body = {"leaf": "ok"}
        for _ in range(20):
            body = {"next": body}
        assert "too deeply nested" in (_extract_device_error(body) or "")
        assert classify_execution_result({"executed": True, "status_code": 200, "response": body}) == RESULT_FAILURE

    def test_a_body_too_large_to_verify_is_a_failure(self):
        body = {"items": [{"n": i} for i in range(6000)]}
        assert "too large" in (_extract_device_error(body) or "")

    @pytest.mark.parametrize("body", [
        pytest.param({"data": {"status": "completed", "errors": []}}, id="empty-errors-list"),
        pytest.param({"data": {"items": [{"name": "x"}], "error": None}}, id="null-error"),
        pytest.param({"ok": True, "state": "done"}, id="true-ok"),
    ])
    def test_benign_nested_bodies_are_not_failures(self, body):
        """Negative control: the deeper scan does not invent failures."""
        assert _extract_device_error(body) is None
        assert classify_execution_result({"executed": True, "status_code": 200, "response": body}) == RESULT_SUCCESS

    def test_existing_top_level_messages_are_unchanged(self):
        """Adapters lift the device's own message verbatim; nested hits add a location."""
        assert _extract_device_error({"error": "E_JAM: carriage jam"}) == "E_JAM: carriage jam"
        assert _extract_device_error({"success": False}) == "device reported success=False"
        assert _extract_device_error({"data": {"error": "jam"}}) == "jam (at data)"


# ---------------------------------------------------------------------------
# JobExecutor._find_device
# ---------------------------------------------------------------------------

class TestTransportFailureSentinel:
    """The classifier-backstop half of #333's class (098af22c), verbatim. Its live-adapter half
    (`test_generic_http_adapter_does_not_claim_executed`, `test_unreachable_device_disputes_end_to_end`)
    drove the adapters and `JobExecutor.execute`, which #454 deletes, so it is not carried."""

    # --- the classifier backstop -------------------------------------------

    def test_status_code_zero_is_a_failure(self):
        """The pre-fix shape: claims executed, but never reached the device."""
        assert classify_execution_result(GH_TRANSPORT_PRE_FIX) == RESULT_FAILURE

    def test_transport_sentinel_outranks_a_claimed_success(self):
        result = {"status": "completed", "status_code": 0, "executed": True}
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_negative_status_code_is_also_a_failure(self):
        assert classify_execution_result({"executed": True, "status_code": -1}) == RESULT_FAILURE

    def test_real_http_status_codes_are_untouched(self):
        assert classify_execution_result(GH_SUCCESS) == RESULT_SUCCESS
        # A real 200 is not the sentinel.  OctoPrint's 2xx is acceptance, not
        # completion (item 5), so its verdict is accepted -- but not failure.
        assert classify_execution_result(OP_ACCEPTED) == RESULT_ACCEPTED

    def test_boolean_status_code_is_not_read_as_the_sentinel(self):
        """`False == 0` in Python -- a bool there is a malformed result, not a
        transport report, so it is not the sentinel (not a failure by rule 4).

        CHANGED (r31 astra verdict item 3): this used to assert RESULT_SUCCESS.
        A present-but-malformed status_code is unreadable, and an unreadable
        outcome field is not evidence that nothing failed, so it now
        classifies as unclassifiable (rule 4c) -- never a success."""
        result = {"printed": True, "status_code": False}
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE
        assert not _is_transport_failure(result)

    def test_failure_reason_names_the_transport_failure(self):
        reason = describe_execution_failure(GH_TRANSPORT_PRE_FIX)
        assert "unreachable" in reason
        assert "status_code=0" in reason


class TestJobExecutorFindDevice:
    def _make_executor(self, devices):
        return JobExecutor(devices=devices, gateway_client=None)

    def test_find_by_device_id(self):
        devices = [{"id": "d1", "protocol": "ipp", "host": "10.0.0.1"}]
        ex = self._make_executor(devices)
        job = {"id": "j1", "deviceId": "d1", "capabilityType": "document-printing"}
        device = ex._find_device(job)
        assert device["id"] == "d1"

    def test_find_by_assigned_devices(self):
        devices = [{"id": "d2", "protocol": "opentrons"}]
        ex = self._make_executor(devices)
        job = {"id": "j1", "assignedDevices": ["d2"]}
        device = ex._find_device(job)
        assert device["id"] == "d2"

    def test_find_by_capability_type(self):
        devices = [{"id": "d3", "protocol": "ipp"}]
        ex = self._make_executor(devices)
        job = {"id": "j1", "capabilityType": "document-printing"}
        device = ex._find_device(job)
        assert device is not None

    def test_returns_none_when_no_match(self):
        ex = self._make_executor([])
        job = {"id": "j1", "capabilityType": "liquid-handler"}
        device = ex._find_device(job)
        assert device is None

    def test_fallback_to_any_device(self):
        devices = [{"id": "dx", "protocol": "generic"}]
        ex = self._make_executor(devices)
        job = {"id": "j1", "capabilityType": "totally-unknown-capability"}
        device = ex._find_device(job)
        # Falls back to any available device
        assert device is not None


# ---------------------------------------------------------------------------
# JobExecutor.execute
# ---------------------------------------------------------------------------

class TestJobExecutorExecute:
    """Every polled job is refused: no device call, no status, no evidence (verdict 68b)."""

    JOBS = [
        ([{"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}],
         {"id": "j1", "capabilityType": "document-printing", "parameters": {"content": "test page"}}),
        ([{"id": "ot1", "protocol": "opentrons", "url": "http://192.168.1.200:31950"}],
         {"id": "j5", "capabilityType": "liquid-handler", "parameters": {"protocolId": "proto-abc"}}),
        ([{"id": "op1", "protocol": "octoprint", "url": "http://10.0.0.20:5000"}],
         {"id": "j6", "capabilityType": "3d-print", "parameters": {"filename": "benchy.gcode"}}),
        ([], {"id": "j2", "capabilityType": "document-printing"}),
    ]

    @pytest.mark.parametrize("devices,job", JOBS)
    def test_refuses_and_reports_nothing(self, devices, job):
        gateway = mock.Mock()
        result = JobExecutor(devices=devices, gateway_client=gateway).execute(job)
        assert result["status"] == "refused" and result["jobId"] == job["id"]
        gateway.update_job_status.assert_not_called()
        gateway.push_evidence.assert_not_called()

    def test_works_without_gateway_client(self):
        result = JobExecutor(devices=[{"id": "p1", "protocol": "ipp"}], gateway_client=None).execute({"id": "j4"})
        assert result["status"] == "refused" and result["jobId"] == "j4"


# ---------------------------------------------------------------------------
# Capability map completeness
# ---------------------------------------------------------------------------

class TestCapabilityMap:
    def test_document_printing_maps_to_ipp(self):
        assert "ipp" in CAPABILITY_PROTOCOL_MAP["document-printing"]
        assert "printer" in CAPABILITY_PROTOCOL_MAP["document-printing"]

    def test_liquid_handler_maps_to_opentrons(self):
        assert "opentrons" in CAPABILITY_PROTOCOL_MAP["liquid-handler"]

    def test_3d_print_maps_to_octoprint(self):
        assert "octoprint" in CAPABILITY_PROTOCOL_MAP["3d-print"]


# ---------------------------------------------------------------------------
# LO-EV-9 (evidence #3219/#3241): every event binds the assignment
# Ported from #420 (fix/pcc-node-evidence-binding @1e261766). Its execute() cases have no
# counterpart: on master execute() refuses every polled job before any evidence exists.
# ---------------------------------------------------------------------------

from pcc_node.job_executor import (  # noqa: E402
    AssignmentBindingError,
    assignment_binding,
    bind_event_payload,
)

UNIT = "0x" + "ab" * 32
NONCE = "0x" + "cd" * 32


class TestEvidenceBindsTheAssignment:
    DEVICE = {"id": "d1", "protocol": "ipp"}

    @pytest.mark.parametrize(
        "result", [GH_SUCCESS, IPP_ACCEPTED, IPP_FAIL_TIMEOUT, {}, None, {"foo": "bar"}]
    )
    def test_every_event_commits_the_pcc_job(self, result):
        bundle = build_evidence_bundle("job-7", self.DEVICE, result)
        assert bundle["events"], "the trail is never empty (execution_started)"
        for event in bundle["events"]:
            assert event["payload"]["jobId"] == "job-7", event["type"]

    def test_unit_fields_are_committed_on_every_event_when_assigned(self):
        binding = {"jobId": "job-7", "settlementUnitId": UNIT, "challengeNonce": NONCE}
        for result in (GH_SUCCESS, IPP_ACCEPTED, IPP_FAIL_TIMEOUT):
            bundle = build_evidence_bundle("job-7", self.DEVICE, result, binding=binding)
            for event in bundle["events"]:
                assert event["payload"]["settlementUnitId"] == UNIT
                assert event["payload"]["challengeNonce"] == NONCE

    def test_without_a_unit_no_event_commits_one(self):
        """spec rule 8: when the subject names no unit, no event may commit one."""
        bundle = build_evidence_bundle("job-7", self.DEVICE, GH_SUCCESS)
        for event in bundle["events"]:
            assert "settlementUnitId" not in event["payload"]
            assert "challengeNonce" not in event["payload"]

    def test_a_binding_for_another_job_is_refused(self):
        with pytest.raises(ValueError):
            build_evidence_bundle("job-7", self.DEVICE, GH_SUCCESS, binding={"jobId": "job-8"})

    def test_a_result_naming_another_job_cannot_reach_payload_job_id(self):
        # A completed payload is the result itself; a device-local "jobId" there
        # would claim another job, so the bundle is refused rather than built.
        with pytest.raises(ValueError, match="payload.jobId"):
            build_evidence_bundle("job-7", self.DEVICE, {**GH_SUCCESS, "jobId": "device-local-1"})
        same = build_evidence_bundle("job-7", self.DEVICE, {**GH_SUCCESS, "jobId": "job-7"})
        assert all(e["payload"]["jobId"] == "job-7" for e in same["events"])

    @pytest.mark.parametrize("field,value", [("settlementUnitId", UNIT), ("challengeNonce", NONCE)])
    def test_a_unit_field_the_assignment_never_named_cannot_reach_the_payload(self, field, value):
        # evidence review of #420, F1 (probe P1): the result carries a unit
        # field, the assignment names none -- refused, never signed through.
        with pytest.raises(ValueError, match="not named by the assignment"):
            build_evidence_bundle("job-1", self.DEVICE, {**GH_SUCCESS, field: value}, binding={"jobId": "job-1"})

    def test_a_result_naming_another_unit_cannot_reach_the_payload(self):
        binding = {"jobId": "job-1", "settlementUnitId": UNIT, "challengeNonce": NONCE}
        with pytest.raises(ValueError, match="payload.settlementUnitId"):
            build_evidence_bundle("job-1", self.DEVICE, {**GH_SUCCESS, "settlementUnitId": "0x" + "ef" * 32},
                                  binding=binding)

    def test_bind_event_payload_wraps_a_non_dict(self):
        assert bind_event_payload("raw", {"jobId": "j"}) == {"result": "raw", "jobId": "j"}

    def test_bind_event_payload_leaves_the_caller_s_payload_alone(self):
        payload = {"level": "submitted"}
        assert bind_event_payload(payload, {"jobId": "j"}) == {"level": "submitted", "jobId": "j"}
        assert payload == {"level": "submitted"}

    def test_assignment_binding_accepts_well_formed_unit_fields(self):
        job = {"id": "job-7", "settlementUnitId": UNIT, "challengeNonce": NONCE, "extra": 1}
        assert assignment_binding(job) == {"jobId": "job-7", "settlementUnitId": UNIT, "challengeNonce": NONCE}
        assert assignment_binding({"id": "job-7"}) == {"jobId": "job-7"}
        bundle = build_evidence_bundle("job-7", self.DEVICE, GH_SUCCESS, binding=assignment_binding(job))
        assert all(e["payload"]["settlementUnitId"] == UNIT for e in bundle["events"])

    @pytest.mark.parametrize(
        "job",
        [
            {},
            {"id": ""},
            {"id": "   "},
            {"id": 42},
            {"id": "j", "settlementUnitId": "0x" + "AB" * 32},
            {"id": "j", "settlementUnitId": "0x" + "ab" * 31},
            {"id": "j", "challengeNonce": "ab" * 32},
            {"id": "j", "challengeNonce": 7},
            # evidence review of #420: F2, half a binding ...
            {"id": "j", "settlementUnitId": UNIT},
            {"id": "j", "challengeNonce": NONCE},
            # ... and F3, an explicit null is not absence (kernel-sdk 400s)
            {"id": "j", "settlementUnitId": None, "challengeNonce": None},
            {"id": "j", "settlementUnitId": UNIT, "challengeNonce": None},
            # and a value with a trailing newline is not 0x + 64 lowercase hex
            {"id": "j", "settlementUnitId": UNIT + "\n", "challengeNonce": NONCE},
        ],
    )
    def test_assignment_binding_refuses_unbindable_assignments(self, job):
        with pytest.raises(AssignmentBindingError):
            assignment_binding(job)

    def test_execute_still_refuses_every_polled_job_before_any_evidence(self):
        """On master execute() refuses a polled job outright (68b): an unbindable one is no exception."""
        gateway = mock.Mock()
        ex = JobExecutor(devices=[{"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}], gateway_client=gateway)
        for job in ({"id": "job-9", "challengeNonce": "0xBAD"}, {"capabilityType": "document-printing"},
                    {"id": "job-10", "settlementUnitId": UNIT, "challengeNonce": NONCE}):
            assert ex.execute(job)["status"] == "refused"
        assert gateway.method_calls == []
