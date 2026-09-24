"""Tests for JobExecutor and IPP print execution."""

import json
import os
import platform
import re
import subprocess
from datetime import datetime
from pathlib import Path
from unittest import mock
from urllib.error import URLError

import pytest

from pcc_node.job_executor import (
    JobExecutor,
    execute_ipp_print,
    build_evidence_bundle,
    CAPABILITY_PROTOCOL_MAP,
)


# ---------------------------------------------------------------------------
# execute_ipp_print
# ---------------------------------------------------------------------------

class TestExecuteIppPrint:
    def _make_device(self, **kwargs):
        base = {"id": "printer-1", "protocol": "ipp", "host": "192.168.1.100"}
        base.update(kwargs)
        return base

    def _make_job(self, **kwargs):
        base = {
            "id": "job-1",
            "capabilityType": "document-printing",
            "parameters": {"content": "Hello PCC", "filename": "test.txt"},
        }
        base.update(kwargs)
        return base

    def test_creates_temp_file(self):
        device = self._make_device()
        job = self._make_job()
        created_files = []

        original_NamedTemporaryFile = __import__("tempfile").NamedTemporaryFile

        with mock.patch("subprocess.run") as mock_run:
            mock_run.return_value = mock.Mock(
                returncode=0, stdout="request id is printer-1-1", stderr=""
            )
            result = execute_ipp_print(device, job)

        assert "filepath" in result
        # Temp file may still exist or be cleaned up

    def test_linux_uses_lp_command(self):
        device = self._make_device(host="10.0.0.5")
        job = self._make_job()

        with mock.patch("subprocess.run") as mock_run, \
             mock.patch("platform.system", return_value="Linux"):
            mock_run.return_value = mock.Mock(returncode=0, stdout="ok", stderr="")
            result = execute_ipp_print(device, job)

        assert mock_run.called
        cmd = mock_run.call_args[0][0]
        assert cmd[0] == "lp"
        assert "10.0.0.5" in cmd

    def test_windows_uses_notepad(self):
        device = self._make_device()
        job = self._make_job()

        with mock.patch("subprocess.run") as mock_run, \
             mock.patch("platform.system", return_value="Windows"):
            mock_run.return_value = mock.Mock(returncode=0, stdout="", stderr="")
            result = execute_ipp_print(device, job)

        assert mock_run.called
        cmd = mock_run.call_args[0][0]
        assert cmd[0] == "notepad"

    def test_zero_returncode_reports_submitted_not_printed(self):
        """Item 5: `lp` exiting 0 means CUPS QUEUED the job, not that it
        printed -- acceptance, never completion.  (Was: printed is True.)"""
        device = self._make_device()
        job = self._make_job()

        with mock.patch("subprocess.run") as mock_run, \
             mock.patch("platform.system", return_value="Linux"):
            mock_run.return_value = mock.Mock(returncode=0, stdout="request ok", stderr="")
            result = execute_ipp_print(device, job)

        assert result["submitted"] is True
        assert "printed" not in result, "lp exit 0 must never claim the print finished"
        assert result["returncode"] == 0
        assert result["stdout"] == "request ok"
        assert classify_execution_result(result) == RESULT_ACCEPTED

    def test_nonzero_returncode_reports_not_submitted(self):
        device = self._make_device()
        job = self._make_job()

        with mock.patch("subprocess.run") as mock_run, \
             mock.patch("platform.system", return_value="Linux"):
            mock_run.return_value = mock.Mock(returncode=1, stdout="", stderr="lp: error")
            result = execute_ipp_print(device, job)

        assert result["submitted"] is False
        assert "printed" not in result
        assert result["returncode"] == 1
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_handles_timeout(self):
        device = self._make_device()
        job = self._make_job()

        with mock.patch("subprocess.run") as mock_run, \
             mock.patch("platform.system", return_value="Linux"):
            mock_run.side_effect = subprocess.TimeoutExpired(cmd="lp", timeout=30)
            result = execute_ipp_print(device, job)

        assert result["submitted"] is False
        assert "printed" not in result
        assert "timed out" in result.get("error", "")
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_handles_command_not_found(self):
        device = self._make_device()
        job = self._make_job()

        with mock.patch("subprocess.run") as mock_run, \
             mock.patch("platform.system", return_value="Linux"):
            mock_run.side_effect = FileNotFoundError("lp not found")
            result = execute_ipp_print(device, job)

        assert result["submitted"] is False
        assert "printed" not in result
        assert "error" in result
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_uses_default_content_on_missing_params(self):
        device = self._make_device()
        job = {"id": "job-1", "capabilityType": "document-printing", "parameters": {}}

        with mock.patch("subprocess.run") as mock_run, \
             mock.patch("platform.system", return_value="Linux"):
            mock_run.return_value = mock.Mock(returncode=0, stdout="ok", stderr="")
            result = execute_ipp_print(device, job)

        assert "filepath" in result


# ---------------------------------------------------------------------------
# build_evidence_bundle
# ---------------------------------------------------------------------------

class TestBuildEvidenceBundle:
    def test_structure(self):
        device = {"id": "d1", "protocol": "ipp"}
        result = {"printed": True, "returncode": 0}
        bundle = build_evidence_bundle("j1", device, result)

        assert bundle["jobId"] == "j1"
        assert bundle["deviceId"] == "d1"
        assert bundle["result"] == result
        assert "executedAt" in bundle
        assert isinstance(bundle["events"], list)
        assert len(bundle["events"]) == 2

    def test_events_contain_execution_started(self):
        device = {"id": "d1"}
        bundle = build_evidence_bundle("j1", device, {})
        event_types = [e["type"] for e in bundle["events"]]
        assert "execution_started" in event_types
        assert "job_started" not in event_types

    def test_oh1_failure_shaped_result_is_not_execution_completed(self):
        """OH-1 regression net (steward #2060 item 2): a device call that
        returns NORMALLY with a failure-shaped result. RED on master @ 7a864910
        (execution_completed emitted unconditionally), GREEN after the fix."""
        device = {"id": "d1", "protocol": "ipp"}
        result = {"printed": False, "error": "print command timed out"}
        types = [e["type"] for e in build_evidence_bundle("job-oh1", device, result)["events"]]
        assert "execution_failed" in types
        assert "execution_completed" not in types

    def test_custom_events(self):
        device = {"id": "d1"}
        events = [{"type": "custom_event", "timestamp": "now", "payload": {}}]
        bundle = build_evidence_bundle("j1", device, {}, events=events)
        assert len(bundle["events"]) == 1
        assert bundle["events"][0]["type"] == "custom_event"


# ---------------------------------------------------------------------------
# JobExecutor._find_device
# ---------------------------------------------------------------------------

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
    def _make_mock_gateway(self):
        g = mock.Mock()
        g.update_job_status.return_value = True
        g.push_evidence.return_value = True
        return g

    def test_executes_ipp_job_and_reports(self):
        gateway = self._make_mock_gateway()
        devices = [{"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}]
        ex = JobExecutor(devices=devices, gateway_client=gateway)

        job = {
            "id": "j1",
            "capabilityType": "document-printing",
            "parameters": {"content": "test page"},
        }

        with mock.patch("pcc_node.job_executor.execute_ipp_print") as mock_ipp:
            # What the real adapter returns when `lp` exits 0: the job QUEUED.
            mock_ipp.return_value = {"submitted": True, "returncode": 0}
            result = ex.execute(job)

        # Gateway should have been called
        gateway.update_job_status.assert_called()
        gateway.push_evidence.assert_called_once()

        # Check status sequence: running, and nothing terminal after it.
        # (Was: running then completed.  Item 5: a queued print is accepted,
        # not completed, so the job stays running.)
        status_calls = [call[0][1] for call in gateway.update_job_status.call_args_list]
        assert status_calls == ["running"]
        assert "completed" not in status_calls
        assert "failed" not in status_calls

    def test_returns_error_when_no_device(self):
        gateway = self._make_mock_gateway()
        ex = JobExecutor(devices=[], gateway_client=gateway)

        job = {"id": "j2", "capabilityType": "document-printing"}
        result = ex.execute(job)

        assert result["status"] == "failed"
        assert "no_device_found" in result.get("error", "")
        gateway.update_job_status.assert_called_with("j2", "failed", mock.ANY)

    def test_handles_execution_exception(self):
        gateway = self._make_mock_gateway()
        devices = [{"id": "p1", "protocol": "ipp", "host": "x"}]
        ex = JobExecutor(devices=devices, gateway_client=gateway)

        job = {"id": "j3", "capabilityType": "document-printing", "parameters": {}}

        with mock.patch("pcc_node.job_executor.execute_ipp_print") as mock_ipp:
            mock_ipp.side_effect = RuntimeError("device unreachable")
            result = ex.execute(job)

        assert "failed" in str(result.get("status", ""))
        gateway.update_job_status.assert_called()

    def test_works_without_gateway_client(self):
        """JobExecutor should work even without a gateway client (offline mode)."""
        devices = [{"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}]
        ex = JobExecutor(devices=devices, gateway_client=None)

        job = {
            "id": "j4",
            "capabilityType": "document-printing",
            "parameters": {"content": "offline test"},
        }

        with mock.patch("pcc_node.job_executor.execute_ipp_print") as mock_ipp:
            mock_ipp.return_value = {"submitted": True, "returncode": 0}
            result = ex.execute(job)

        # Should not raise even without gateway
        assert "jobId" in result or "error" in result
        # The accepted path runs offline too: progress, never a completion.
        assert [e["type"] for e in result["events"]] == [
            "execution_started", "execution_progress",
        ]

    def test_opentrons_job_routing(self):
        gateway = self._make_mock_gateway()
        devices = [{"id": "ot1", "protocol": "opentrons", "url": "http://192.168.1.200:31950"}]
        ex = JobExecutor(devices=devices, gateway_client=gateway)

        job = {
            "id": "j5",
            "capabilityType": "liquid-handler",
            "parameters": {"protocolId": "proto-abc"},
        }

        with mock.patch("pcc_node.job_executor.JobExecutor._execute_opentrons") as mock_ot:
            mock_ot.return_value = {"runId": "run-1", "submitted": True}
            result = ex.execute(job)

        mock_ot.assert_called_once()

    def test_octoprint_job_routing(self):
        gateway = self._make_mock_gateway()
        devices = [{"id": "op1", "protocol": "octoprint", "url": "http://10.0.0.20:5000"}]
        ex = JobExecutor(devices=devices, gateway_client=gateway)

        job = {
            "id": "j6",
            "capabilityType": "3d-print",
            "parameters": {"filename": "benchy.gcode"},
        }

        with mock.patch("pcc_node.job_executor.JobExecutor._execute_octoprint") as mock_op:
            mock_op.return_value = {"submitted": True, "filename": "benchy.gcode"}
            result = ex.execute(job)

        mock_op.assert_called_once()


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
    UNCLASSIFIABLE_REASON,
    COMPLETION_FLAG_KEYS,
    ACCEPTANCE_FLAG_KEYS,
    _is_transport_failure,
    _extract_device_error,
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
        assert progress["payload"] == {"level": "submitted", "result": result}
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

    def test_explicit_events_override_still_bypasses_classification(self):
        """Caller escape hatch is unchanged -- no classification is applied."""
        events = [{"type": "custom_event", "timestamp": "now", "payload": {}}]
        bundle = build_evidence_bundle("j1", self.DEVICE, IPP_FAIL_TIMEOUT, events=events)
        assert bundle["events"] == events


# ---------------------------------------------------------------------------
# JobExecutor.execute -- reported job status must agree with the event type
# ---------------------------------------------------------------------------

class TestExecuteStatusGating:
    IPP_DEVICE = {"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}
    OT_DEVICE = {"id": "ot1", "protocol": "opentrons", "url": "http://192.168.1.200:31950"}
    OP_DEVICE = {"id": "op1", "protocol": "octoprint", "url": "http://10.0.0.20:5000"}
    GH_DEVICE = {"id": "g1", "protocol": "generic", "url": "http://10.0.0.9"}

    def _gateway(self):
        g = mock.Mock()
        g.update_job_status.return_value = True
        g.push_evidence.return_value = True
        return g

    def _statuses(self, gateway):
        return [call[0][1] for call in gateway.update_job_status.call_args_list]

    def _pushed_bundle(self, gateway):
        assert gateway.push_evidence.called, "evidence was never pushed"
        return gateway.push_evidence.call_args[0][1]

    def _run(self, gateway, device, capability_type, patch_target, result):
        ex = JobExecutor(devices=[device], gateway_client=gateway)
        job = {
            "id": "job-sec10",
            "capabilityType": capability_type,
            "parameters": {"content": "x", "filename": "x.gcode", "protocolId": "p"},
        }
        with mock.patch(patch_target) as patched:
            patched.return_value = result
            return ex.execute(job)

    # --- success -----------------------------------------------------------
    #
    # The ipp and octoprint rows moved to the accepted test below: a queued
    # `lp` job and a started OctoPrint print are acceptance, not completion.

    @pytest.mark.parametrize(
        "device,capability,target,result",
        [
            pytest.param(OT_DEVICE, "liquid-handler",
                         "pcc_node.job_executor.JobExecutor._execute_opentrons", OT_SUCCESS, id="opentrons"),
            pytest.param(GH_DEVICE, "generic",
                         "pcc_node.job_executor.JobExecutor._execute_generic_http", GH_SUCCESS, id="generic-http"),
        ],
    )
    def test_success_reports_completed_and_emits_completed_event(
        self, device, capability, target, result
    ):
        gateway = self._gateway()
        self._run(gateway, device, capability, target, result)

        statuses = self._statuses(gateway)
        assert "completed" in statuses
        assert "failed" not in statuses

        types = _event_types(self._pushed_bundle(gateway))
        assert EVENT_EXECUTION_COMPLETED in types
        assert EVENT_EXECUTION_FAILED not in types

    # --- accepted (must-close item 5) ----------------------------------------

    @pytest.mark.parametrize(
        "device,capability,target,result",
        [
            pytest.param(IPP_DEVICE, "document-printing",
                         "pcc_node.job_executor.execute_ipp_print", IPP_ACCEPTED, id="ipp"),
            pytest.param(OP_DEVICE, "3d-print",
                         "pcc_node.job_executor.JobExecutor._execute_octoprint", OP_ACCEPTED, id="octoprint"),
            pytest.param(GH_DEVICE, "generic",
                         "pcc_node.job_executor.JobExecutor._execute_generic_http", GH_ACCEPTED_202,
                         id="generic-http-202"),
            pytest.param(OT_DEVICE, "liquid-handler",
                         "pcc_node.job_executor.JobExecutor._execute_opentrons", OT_ACCEPTED_ONLY,
                         id="opentrons-accepted-only"),
        ],
    )
    def test_accepted_reports_no_terminal_status(self, device, capability, target, result):
        """The device took the job and has not reported it finished: neither
        'completed' nor 'failed' may be reported, the evidence is still pushed,
        and it carries execution_progress -- never execution_completed."""
        gateway = self._gateway()
        self._run(gateway, device, capability, target, result)

        for call in gateway.update_job_status.call_args_list:
            reported = list(call.args[1:]) + list(call.kwargs.values())
            assert "completed" not in reported, f"accepted job reported completed: {call}"
            assert "failed" not in reported, f"accepted job reported failed: {call}"
        # The only status report is the "running" sent before execution.
        assert gateway.update_job_status.call_args_list == [mock.call("job-sec10", "running")]

        gateway.push_evidence.assert_called_once()
        bundle = self._pushed_bundle(gateway)
        assert _event_types(bundle) == [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_PROGRESS]
        assert "execution_completed" not in _bundle_text(bundle)

    def test_accepted_is_logged_at_info_not_as_a_failure(self, caplog):
        gateway = self._gateway()
        with caplog.at_level(logging.INFO, logger="pcc-node.job-executor"):
            self._run(gateway, self.IPP_DEVICE, "document-printing",
                      "pcc_node.job_executor.execute_ipp_print", IPP_ACCEPTED)

        accepted = [r for r in caplog.records if "accepted by device" in r.getMessage()]
        assert accepted, f"no acceptance log line; records were {[r.getMessage() for r in caplog.records]}"
        assert all(r.levelno == logging.INFO for r in accepted)
        assert "completion not yet observed" in accepted[0].getMessage()
        assert not [r for r in caplog.records if r.levelno >= logging.WARNING]

    # --- failure -----------------------------------------------------------

    @pytest.mark.parametrize("result", [
        pytest.param(IPP_FAIL_RETURNCODE, id="nonzero-returncode"),
        pytest.param(IPP_FAIL_TIMEOUT, id="timeout"),
        pytest.param(IPP_FAIL_NOT_FOUND, id="command-not-found"),
        pytest.param(IPP_FAIL_EXCEPTION, id="generic-exception"),
    ])
    def test_ipp_failure_reports_failed_and_never_completed(self, result):
        gateway = self._gateway()
        self._run(gateway, self.IPP_DEVICE, "document-printing",
                  "pcc_node.job_executor.execute_ipp_print", result)

        statuses = self._statuses(gateway)
        assert "failed" in statuses
        assert "completed" not in statuses

        bundle = self._pushed_bundle(gateway)
        assert EVENT_EXECUTION_FAILED in _event_types(bundle)
        assert "execution_completed" not in _bundle_text(bundle)

    @pytest.mark.parametrize("result", [
        pytest.param(OT_FAIL_UPLOAD, id="upload-failed"),
        pytest.param(OT_FAIL_NO_UPLOAD_ID, id="no-upload-id"),
        pytest.param(OT_FAIL_NO_PROTOCOL_ID, id="no-protocol-id"),
        pytest.param(OT_FAIL_RUN_CREATE, id="run-create-failed"),
        pytest.param(OT_FAIL_RUN_ID_MISSING, id="run-id-missing"),
    ])
    def test_opentrons_failure_reports_failed_and_never_completed(self, result):
        gateway = self._gateway()
        self._run(gateway, self.OT_DEVICE, "liquid-handler",
                  "pcc_node.job_executor.JobExecutor._execute_opentrons", result)

        statuses = self._statuses(gateway)
        assert "failed" in statuses
        assert "completed" not in statuses

        bundle = self._pushed_bundle(gateway)
        assert EVENT_EXECUTION_FAILED in _event_types(bundle)
        assert "execution_completed" not in _bundle_text(bundle)

    @pytest.mark.parametrize("result", [
        pytest.param(OP_FAIL_NO_FILENAME, id="no-filename-error-key"),
        pytest.param(OP_FAIL_BAD_STATUS, id="printed-false-bad-http-status"),
    ])
    def test_octoprint_both_failure_conventions_report_failed(self, result):
        """Octoprint uses an error key on one branch and printed:False on another."""
        gateway = self._gateway()
        self._run(gateway, self.OP_DEVICE, "3d-print",
                  "pcc_node.job_executor.JobExecutor._execute_octoprint", result)

        statuses = self._statuses(gateway)
        assert "failed" in statuses
        assert "completed" not in statuses

        bundle = self._pushed_bundle(gateway)
        assert EVENT_EXECUTION_FAILED in _event_types(bundle)
        assert "execution_completed" not in _bundle_text(bundle)

    @pytest.mark.parametrize("result", [
        pytest.param(GH_FAIL_NO_BASE_URL, id="no-base-url-error-key"),
        pytest.param(GH_FAIL_HTTP_ERROR, id="executed-false-http-503"),
    ])
    def test_generic_http_both_failure_conventions_report_failed(self, result):
        gateway = self._gateway()
        self._run(gateway, self.GH_DEVICE, "generic",
                  "pcc_node.job_executor.JobExecutor._execute_generic_http", result)

        statuses = self._statuses(gateway)
        assert "failed" in statuses
        assert "completed" not in statuses

        bundle = self._pushed_bundle(gateway)
        assert EVENT_EXECUTION_FAILED in _event_types(bundle)
        assert "execution_completed" not in _bundle_text(bundle)

    def test_failure_still_pushes_evidence_so_the_oracle_can_dispute(self):
        gateway = self._gateway()
        self._run(gateway, self.IPP_DEVICE, "document-printing",
                  "pcc_node.job_executor.execute_ipp_print", IPP_FAIL_TIMEOUT)
        gateway.push_evidence.assert_called_once()

    # --- unclassifiable ----------------------------------------------------

    @pytest.mark.parametrize("result", UNCLASSIFIABLE_SHAPES)
    def test_unclassifiable_never_reports_completed(self, result):
        gateway = self._gateway()
        self._run(gateway, self.IPP_DEVICE, "document-printing",
                  "pcc_node.job_executor.execute_ipp_print", result)

        statuses = self._statuses(gateway)
        assert "completed" not in statuses, f"unclassifiable result reported completed: {result!r}"
        assert "failed" in statuses

        bundle = self._pushed_bundle(gateway)
        assert "execution_completed" not in _bundle_text(bundle)

    @pytest.mark.parametrize("result", UNCLASSIFIABLE_SHAPES)
    def test_unclassifiable_status_metadata_names_the_reason(self, result):
        gateway = self._gateway()
        self._run(gateway, self.IPP_DEVICE, "document-printing",
                  "pcc_node.job_executor.execute_ipp_print", result)

        failed_calls = [
            call for call in gateway.update_job_status.call_args_list
            if call[0][1] == "failed"
        ]
        assert failed_calls, "no failed status was reported"
        assert UNCLASSIFIABLE_REASON in json.dumps(failed_calls[-1][0][2], default=str)

    # --- pre-existing failure paths stay correct ---------------------------

    def test_raised_exception_still_reports_failed(self):
        gateway = self._gateway()
        ex = JobExecutor(devices=[self.IPP_DEVICE], gateway_client=gateway)
        job = {"id": "j-raise", "capabilityType": "document-printing", "parameters": {}}

        with mock.patch("pcc_node.job_executor.execute_ipp_print") as mock_ipp:
            mock_ipp.side_effect = RuntimeError("device unreachable")
            result = ex.execute(job)

        assert result["status"] == "failed"
        statuses = self._statuses(gateway)
        assert "failed" in statuses
        assert "completed" not in statuses
        gateway.push_evidence.assert_not_called()

    def test_no_device_found_still_reports_failed(self):
        gateway = self._gateway()
        ex = JobExecutor(devices=[], gateway_client=gateway)
        result = ex.execute({"id": "j-nodev", "capabilityType": "document-printing"})

        assert result["status"] == "failed"
        assert "completed" not in self._statuses(gateway)
        gateway.push_evidence.assert_not_called()

    # --- the cross-cutting negative control --------------------------------

    @pytest.mark.parametrize(
        "result", SUCCESS_SHAPES + FAILURE_SHAPES + UNCLASSIFIABLE_SHAPES
    )
    def test_status_string_and_event_type_never_disagree(self, result):
        """One result -> one verdict. The bundle and the status must agree."""
        gateway = self._gateway()
        self._run(gateway, self.IPP_DEVICE, "document-printing",
                  "pcc_node.job_executor.execute_ipp_print", result)

        statuses = self._statuses(gateway)
        types = _event_types(self._pushed_bundle(gateway))

        completed_event = EVENT_EXECUTION_COMPLETED in types
        completed_status = "completed" in statuses

        assert completed_event == completed_status, (
            f"bundle says completed={completed_event} but status says "
            f"completed={completed_status} for result {result!r}"
        )
        if not completed_event:
            assert "failed" in statuses


# ---------------------------------------------------------------------------
# Transport-failure sentinel (http_util status 0) -- regression lock
#
# `pcc_node.http_util.http` returns status_code 0 when a request never
# completes (connection refused / DNS failure / timeout).  No adapter return
# statement mentions that value, so a census of literal return statements --
# and every fixture hand-copied from one -- cannot contain it.  With
# `"executed": status < 400`, an unreachable generic-HTTP device therefore
# reported executed=True -> execution_completed -> the settlement oracle
# RELEASED the exact failure the contract exists to dispute.
#
# The tests below fake ONLY `urlopen` and let every layer above it run for
# real, so a shape the author did not think an adapter could produce is still
# exercised.  Fixtures test what you imagined; live adapters test what the
# code actually does.
# ---------------------------------------------------------------------------

class TestTransportFailureSentinel:
    TRANSPORT_ERROR = URLError("[Errno 111] Connection refused")

    GH_DEVICE = {"id": "g1", "protocol": "generic-http", "url": "http://10.255.255.1:9"}
    OP_DEVICE = {"id": "op1", "protocol": "octoprint", "url": "http://10.255.255.1:9"}
    OT_DEVICE = {"id": "ot1", "protocol": "opentrons", "url": "http://10.255.255.1:9"}

    def _dead_socket(self):
        """Patch the socket layer only -- http_util, the adapters, the
        classifier and execute() all run for real underneath."""
        return mock.patch("pcc_node.http_util.urlopen", side_effect=self.TRANSPORT_ERROR)

    def _gateway(self):
        g = mock.Mock()
        g.update_job_status.return_value = True
        g.push_evidence.return_value = True
        return g

    def _statuses(self, gateway):
        return [call[0][1] for call in gateway.update_job_status.call_args_list]

    def _execute_live(self, device, capability_type):
        gateway = self._gateway()
        ex = JobExecutor(devices=[device], gateway_client=gateway)
        job = {
            "id": "job-transport",
            "capabilityType": capability_type,
            "parameters": {
                "path": "/execute",
                "filename": "benchy.gcode",
                "protocolId": "proto-abc",
            },
        }
        with self._dead_socket():
            bundle = ex.execute(job)
        return bundle, self._statuses(gateway)

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

    # --- the live adapters --------------------------------------------------

    def test_generic_http_adapter_does_not_claim_executed(self):
        """Directly locks job_executor.py's `200 <= status < 400` band."""
        ex = JobExecutor(devices=[])
        with self._dead_socket():
            result = ex._execute_generic_http(
                self.GH_DEVICE, {"parameters": {"path": "/execute"}}
            )

        assert result["status_code"] == 0
        assert result["executed"] is False, "unreachable device reported as executed"
        assert result["error"], "transport error must surface at the top level"
        assert classify_execution_result(result) == RESULT_FAILURE

    @pytest.mark.parametrize(
        "device,capability",
        [
            pytest.param(GH_DEVICE, "generic", id="generic-http"),
            pytest.param(OP_DEVICE, "3d-print", id="octoprint"),
            pytest.param(OT_DEVICE, "liquid-handler", id="opentrons"),
        ],
    )
    def test_unreachable_device_disputes_end_to_end(self, device, capability):
        """The contract's acceptance vector, driven through the real adapter:
        failed -> execution_failed + no execution_completed -> oracle disputes."""
        bundle, statuses = self._execute_live(device, capability)
        types = _event_types(bundle)

        assert EVENT_EXECUTION_FAILED in types
        assert EVENT_EXECUTION_COMPLETED not in types
        assert "execution_completed" not in _bundle_text(bundle)
        assert "failed" in statuses
        assert "completed" not in statuses


# ---------------------------------------------------------------------------
# Opentrons play action -- the "run created, protocol never started" hole
#
# `_execute_opentrons` makes two calls: POST /runs (create the run) and then
# POST /runs/<id>/actions (play).  Only the play call actually starts the
# protocol, and its return was DISCARDED -- the one discarded http() return in
# the module -- so a rejected or unreachable play still produced
# `submitted: True` -> execution_completed -> golden-v4's
# and(execution_completed present, execution_failed absent) RELEASES.
#
# TestTransportFailureSentinel cannot reach this branch: with every socket
# dead, POST /runs fails first at the `status not in (200, 201)` guard, so
# `test_unreachable_device_disputes_end_to_end[opentrons]` returns through run
# creation and never enters the play branch (locked below by
# test_dead_socket_stops_at_run_creation_not_the_play_action).  The tests here
# keep run creation healthy and break ONLY the play call, and each asserts the
# /actions request was actually issued so the coverage cannot quietly regress
# to the run-creation shortcut again.
#
# As above, only `urlopen` is faked: http_util, the adapter, the classifier and
# execute() all run for real underneath.
# ---------------------------------------------------------------------------

import io  # noqa: E402
from urllib.error import HTTPError  # noqa: E402


class _FakeResponse:
    """Stand-in for urlopen's return value: context manager + read + status."""

    def __init__(self, status, payload):
        self.status = status
        self._raw = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _http_error(code, payload):
    """How a real 4xx/5xx reaches an adapter: urlopen raises HTTPError and
    http_util turns it into (code, parsed_body)."""
    return HTTPError(
        "http://10.255.255.1:31950/runs/run-xyz/actions",
        code,
        "error",
        {},
        io.BytesIO(json.dumps(payload).encode("utf-8")),
    )


class TestOpentronsPlayAction:
    # runPollInterval 0 / runPollTimeout 5 keep the run poll instant in tests;
    # the production defaults are OPENTRONS_RUN_POLL_INTERVAL_S / _TIMEOUT_S.
    OT_DEVICE = {
        "id": "ot1",
        "protocol": "opentrons",
        "url": "http://10.255.255.1:31950",
        "runPollInterval": 0,
        "runPollTimeout": 5,
    }
    RUN_ID = "run-xyz"
    PROTOCOL_ID = "proto-abc"

    # (factory for the play-call outcome, expected error string)
    PLAY_FAILURES = [
        pytest.param(
            lambda: URLError("[Errno 111] Connection refused"),
            "run play failed HTTP 0",
            id="play-transport-dead",
        ),
        pytest.param(
            lambda: _http_error(500, {"message": "run cannot start"}),
            "run play failed HTTP 500",
            id="play-http-500",
        ),
        pytest.param(
            lambda: _http_error(409, {"message": "run is not idle"}),
            "run play failed HTTP 409",
            id="play-http-409",
        ),
    ]

    def _socket(self, make_play_outcome, seen, run_body=None):
        """POST /runs succeeds; POST /runs/<id>/actions does whatever
        `make_play_outcome()` returns (a response) or raises (an exception);
        GET /runs/<id> answers with `run_body` (default: a succeeded run).
        Every requested URL is recorded into `seen`."""
        if run_body is None:
            run_body = {"data": {"id": self.RUN_ID, "status": "succeeded"}}

        def _router(req, *args, **kwargs):
            url = req.full_url
            seen.append(url)
            if url.endswith("/actions"):
                outcome = make_play_outcome()
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome
            if url.endswith("/runs"):
                return _FakeResponse(201, {"data": {"id": self.RUN_ID}})
            if url.endswith(f"/runs/{self.RUN_ID}"):
                return _FakeResponse(200, run_body)
            raise AssertionError(f"unexpected request to {url}")

        return mock.patch("pcc_node.http_util.urlopen", side_effect=_router)

    def _polled(self, seen):
        return [u for u in seen if u.endswith(f"/runs/{self.RUN_ID}")]

    def _job(self):
        return {
            "id": "job-ot-play",
            "capabilityType": "liquid-handler",
            "parameters": {"protocolId": self.PROTOCOL_ID},
        }

    def _gateway(self):
        g = mock.Mock()
        g.update_job_status.return_value = True
        g.push_evidence.return_value = True
        return g

    def _statuses(self, gateway):
        return [call[0][1] for call in gateway.update_job_status.call_args_list]

    def _played(self, seen):
        return [u for u in seen if u.endswith("/actions")]

    # --- the adapter --------------------------------------------------------

    @pytest.mark.parametrize("make_play_outcome,expected_error", PLAY_FAILURES)
    def test_play_failure_never_claims_submitted(self, make_play_outcome, expected_error):
        seen = []
        ex = JobExecutor(devices=[])
        with self._socket(make_play_outcome, seen):
            result = ex._execute_opentrons(self.OT_DEVICE, self._job())

        assert self._played(seen), f"play action never issued; requests were {seen}"
        assert result["submitted"] is False, "a run that never started reported as submitted"
        assert result["error"] == expected_error
        # Forensics: the caller can still find the run that was left un-played.
        assert result["runId"] == self.RUN_ID
        assert result["protocolId"] == self.PROTOCOL_ID
        assert classify_execution_result(result) == RESULT_FAILURE

    @pytest.mark.parametrize("status_code", [200, 201])
    def test_accepted_play_statuses_still_submit(self, status_code):
        """The guard must not turn a run that really started into a dispute."""
        seen = []
        ex = JobExecutor(devices=[])
        with self._socket(lambda: _FakeResponse(status_code, {"data": {"id": "a1"}}), seen):
            result = ex._execute_opentrons(self.OT_DEVICE, self._job())

        assert self._played(seen)
        assert self._polled(seen), "the run was never polled for its outcome"
        assert result["submitted"] is True
        assert result["runStatus"] == "succeeded"
        assert result["status"] == "completed"
        assert "error" not in result
        assert classify_execution_result(result) == RESULT_SUCCESS

    # --- the run's OWN outcome, not just its acceptance ---------------------
    #
    # A play that returns 201 means the protocol STARTED.  A protocol that
    # starts and then fails at step 40 still returned `submitted: True`, so
    # golden-v4's and(execution_completed present, execution_failed absent)
    # RELEASED it.  The adapter now polls GET /runs/<id> to a terminal state
    # and reports that; the tests below drive each terminal branch.

    PLAY_OK = staticmethod(lambda: _FakeResponse(201, {"data": {"id": "a1"}}))

    def _run_outcome(self, run_body, seen):
        ex = JobExecutor(devices=[])
        with self._socket(self.PLAY_OK, seen, run_body=run_body):
            return ex._execute_opentrons(self.OT_DEVICE, self._job())

    @pytest.mark.parametrize("run_status", ["failed", "stopped", "FAILED"])
    def test_terminal_failure_run_status_is_a_failure(self, run_status):
        seen = []
        result = self._run_outcome(
            {"data": {"id": self.RUN_ID, "status": run_status}}, seen
        )

        assert self._polled(seen)
        assert result["runStatus"] == run_status.lower()
        assert result["error"]
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_protocol_errors_in_the_run_body_are_a_failure(self):
        """`data.errors` is the run's own verdict, even before status catches up."""
        seen = []
        result = self._run_outcome(
            {"data": {"id": self.RUN_ID, "errors": [{"detail": "tip pickup failed"}]}},
            seen,
        )

        assert self._polled(seen)
        assert "tip pickup failed" in result["error"]
        assert classify_execution_result(result) == RESULT_FAILURE

    def test_non_terminal_run_never_claims_completion(self):
        """The budget expired with the run still going: outcome unknown.

        `submitted: True` alone is what the pre-fix adapter returned for this
        state; it must settle as neither -- no execution_completed to release on.
        """
        seen = []
        result = self._run_outcome(
            {"data": {"id": self.RUN_ID, "status": "running"}}, seen
        )

        assert self._polled(seen)
        assert result["submitted"] is True
        assert result["status"] == "running"
        assert "error" not in result
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE

    def test_unreadable_run_poll_never_claims_completion(self):
        """A poll that answers with no status at all is not a completion."""
        seen = []
        result = self._run_outcome({"data": {"id": self.RUN_ID}}, seen)

        assert result["runStatus"] == "unknown"
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE

    def test_zero_poll_budget_disables_polling_and_fails_closed(self):
        seen = []
        ex = JobExecutor(devices=[])
        device = {**self.OT_DEVICE, "runPollTimeout": 0}
        with self._socket(self.PLAY_OK, seen):
            result = ex._execute_opentrons(device, self._job())

        assert not self._polled(seen), "polling was disabled but a poll was issued"
        assert result["submitted"] is True
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE

    @pytest.mark.parametrize("run_status", ["failed", "running"])
    def test_non_succeeded_run_never_reports_completed_end_to_end(self, run_status):
        """The acceptance vector for R1: a run that did not succeed must not
        release, whether it failed outright or never finished."""
        seen = []
        gateway = self._gateway()
        ex = JobExecutor(devices=[self.OT_DEVICE], gateway_client=gateway)
        with self._socket(
            self.PLAY_OK, seen, run_body={"data": {"id": self.RUN_ID, "status": run_status}}
        ):
            bundle = ex.execute(self._job())

        types = _event_types(bundle)
        statuses = self._statuses(gateway)

        assert EVENT_EXECUTION_COMPLETED not in types
        assert "execution_completed" not in _bundle_text(bundle)
        assert "completed" not in statuses
        assert "failed" in statuses
        gateway.push_evidence.assert_called_once()

    def test_dead_socket_stops_at_run_creation_not_the_play_action(self):
        """Why this class exists.  With every request dead the adapter returns
        at the run-creation guard, so a dead-socket test can never exercise the
        play branch, whatever its name says."""
        seen = []

        def _all_dead(req, *args, **kwargs):
            seen.append(req.full_url)
            raise URLError("[Errno 111] Connection refused")

        ex = JobExecutor(devices=[])
        with mock.patch("pcc_node.http_util.urlopen", side_effect=_all_dead):
            result = ex._execute_opentrons(self.OT_DEVICE, self._job())

        assert result["error"] == "run creation failed HTTP 0"
        assert not self._played(seen), (
            "run creation no longer short-circuits; the play-branch tests above "
            "are now the only thing covering it -- keep them"
        )

    # --- end to end ---------------------------------------------------------

    @pytest.mark.parametrize("make_play_outcome,expected_error", PLAY_FAILURES)
    def test_play_failure_disputes_end_to_end(self, make_play_outcome, expected_error):
        """The contract's acceptance vector for a protocol that never started:
        failed -> execution_failed + no execution_completed -> oracle disputes."""
        seen = []
        gateway = self._gateway()
        ex = JobExecutor(devices=[self.OT_DEVICE], gateway_client=gateway)
        with self._socket(make_play_outcome, seen):
            bundle = ex.execute(self._job())

        assert self._played(seen), f"play action never issued; requests were {seen}"
        types = _event_types(bundle)
        statuses = self._statuses(gateway)

        assert EVENT_EXECUTION_FAILED in types
        assert EVENT_EXECUTION_COMPLETED not in types
        assert "execution_completed" not in _bundle_text(bundle)
        assert "failed" in statuses
        assert "completed" not in statuses
        # A dispute still needs evidence to dispute ON.
        gateway.push_evidence.assert_called_once()

    def test_successful_play_still_releases_end_to_end(self):
        """Negative control: a healthy run must keep settling."""
        seen = []
        gateway = self._gateway()
        ex = JobExecutor(devices=[self.OT_DEVICE], gateway_client=gateway)
        with self._socket(lambda: _FakeResponse(201, {"data": {"id": "a1"}}), seen):
            bundle = ex.execute(self._job())

        assert self._played(seen)
        types = _event_types(bundle)
        statuses = self._statuses(gateway)

        assert EVENT_EXECUTION_COMPLETED in types
        assert EVENT_EXECUTION_FAILED not in types
        assert "execution_failed" not in _bundle_text(bundle)
        assert "completed" in statuses
        assert "failed" not in statuses


# ---------------------------------------------------------------------------
# Transport succeeds, the DEVICE fails
#
# `_execute_generic_http` derived its success flag from the TRANSPORT alone
# (`executed: 200 <= status < 400`) and lifted a nested error only when
# `status <= 0`.  `_execute_octoprint` did the same against (200, 201, 204).
# So a REACHABLE instrument answering 200 with an error envelope minted
# `executed`/`printed: True` -> execution_completed -> golden-v4's
# and(execution_completed present, execution_failed absent) RELEASED the exact
# failure the contract exists to dispute.
#
# This is the widest path, not an edge: `_execute_on_device` routes every
# protocol that is not ipp/printer/opentrons/octoprint to generic-http --
# modbus, opcua, http, serial, mdns, camera and unknown per discovery.py /
# detect.py, plus anything `_find_device` step 4 drops on an unmapped
# capability.  Transport-succeeds/application-fails is the ordinary instrument
# failure mode for JSON-RPC, SiLA, OPC-UA HTTP bridges, LabVIEW web services
# and most vendor REST; the repo's own executor.py GenericHTTPAdapter returns
# `{"status": status, "result": result}` precisely because the BODY carries the
# outcome, not the status line.
#
# As elsewhere in this file only `urlopen` is faked: http_util, the adapters,
# the classifier and execute() all run for real underneath.
# ---------------------------------------------------------------------------

class _RawResponse:
    """urlopen stand-in that returns a body verbatim (may be non-JSON)."""

    def __init__(self, status, raw):
        self.status = status
        self._raw = raw if isinstance(raw, bytes) else str(raw).encode("utf-8")

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _json_body(payload):
    return json.dumps(payload)


SOAP_FAULT_BODY = (
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
    "<soap:Body><soap:Fault><faultcode>soap:Server</faultcode>"
    "<faultstring>carriage jam; job aborted</faultstring>"
    "</soap:Fault></soap:Body></soap:Envelope>"
)


class TestDeviceReportedFailureInABody:
    GH_DEVICE = {"id": "g1", "protocol": "generic-http", "url": "http://10.0.0.9"}
    OP_DEVICE = {"id": "op1", "protocol": "octoprint", "url": "http://10.0.0.20:5000"}

    # (http status the device answers with, raw body)
    DEVICE_FAILURES = [
        pytest.param(
            200,
            _json_body({"jsonrpc": "2.0", "id": 1,
                        "error": {"code": -32000, "message": "actuator jammed; NOT executed"}}),
            id="jsonrpc-error-200",
        ),
        pytest.param(
            200, _json_body({"status": "error", "message": "sample rack empty"}),
            id="rest-status-error-200",
        ),
        pytest.param(
            200, _json_body({"success": False, "error": "nothing dispensed"}),
            id="success-false-200",
        ),
        pytest.param(200, _json_body({"ok": False}), id="ok-false-200"),
        pytest.param(
            201, _json_body({"errors": ["carriage jam", "job aborted"]}),
            id="errors-list-201",
        ),
        pytest.param(
            204, _json_body({"error": "E_JAM: carriage jam, job aborted"}),
            id="error-204",
        ),
        pytest.param(200, SOAP_FAULT_BODY, id="soap-fault-200"),
        pytest.param(200, "<error>carriage jam</error>", id="xml-error-element-200"),
        # A 3xx sat inside the old `status < 400` band: a redirect nobody
        # followed, so nothing was executed.
        pytest.param(304, "", id="redirect-304"),
    ]

    # Bodies in which the DEVICE states that the work finished.
    DEVICE_SUCCESSES = [
        pytest.param(200, _json_body({"status": "completed"}), id="completed-status-200"),
        pytest.param(200, _json_body({"data": {"state": "done"}}), id="nested-done-200"),
        pytest.param(201, _json_body({"done": True, "jobId": "abc"}), id="done-true-201"),
        pytest.param(200, _json_body({"result": {"status": "SUCCEEDED"}}), id="result-succeeded-200"),
    ]
    # CHANGED (r31 astra verdict item 1): these five bodies used to be
    # DEVICE_SUCCESSES and were asserted to release.  None of them states that
    # the work finished -- {"ok": true} and {"success": true} answer for the
    # REQUEST, a job id is a receipt, and 204/"OK" carry no statement at all --
    # so "2xx and no recognized error" is now unclassifiable and fails closed.
    DEVICE_OPAQUE_2XX = [
        pytest.param(200, _json_body({"ok": True}), id="ok-true-200"),
        pytest.param(200, _json_body({"success": True, "jobId": "abc"}), id="success-true-200"),
        pytest.param(201, _json_body({"jobId": "abc"}), id="opaque-json-201"),
        pytest.param(204, "", id="empty-204"),
        pytest.param(200, "OK", id="plain-text-200"),
    ]

    def _socket(self, status, raw):
        return mock.patch(
            "pcc_node.http_util.urlopen",
            side_effect=lambda req, *a, **k: _RawResponse(status, raw),
        )

    def _gateway(self):
        g = mock.Mock()
        g.update_job_status.return_value = True
        g.push_evidence.return_value = True
        return g

    def _statuses(self, gateway):
        return [call[0][1] for call in gateway.update_job_status.call_args_list]

    def _job(self):
        return {
            "id": "job-body",
            "capabilityType": "generic",
            "parameters": {"path": "/execute", "filename": "benchy.gcode"},
        }

    # --- the adapters -------------------------------------------------------

    @pytest.mark.parametrize("status,raw", DEVICE_FAILURES)
    def test_generic_http_never_claims_executed_on_a_device_failure(self, status, raw):
        ex = JobExecutor(devices=[])
        with self._socket(status, raw):
            result = ex._execute_generic_http(self.GH_DEVICE, self._job())

        assert result["executed"] is False, (
            f"HTTP {status} with a device failure body reported as executed: {result!r}"
        )
        assert result["error"], "the device's own reason must surface at the top level"
        assert classify_execution_result(result) == RESULT_FAILURE

    @pytest.mark.parametrize("status,raw", DEVICE_FAILURES)
    def test_octoprint_never_claims_printed_on_a_device_failure(self, status, raw):
        ex = JobExecutor(devices=[])
        with self._socket(status, raw):
            result = ex._execute_octoprint(self.OP_DEVICE, self._job())

        # The adapter's flag is now the acceptance flag (item 5); it must not
        # even claim the job was accepted, let alone printed.
        assert "printed" not in result, f"octoprint adapter claimed printed: {result!r}"
        assert result["submitted"] is False, (
            f"HTTP {status} with a device failure body reported as submitted: {result!r}"
        )
        assert result["error"]
        assert classify_execution_result(result) == RESULT_FAILURE

    @pytest.mark.parametrize("status,raw", DEVICE_SUCCESSES)
    def test_a_genuine_success_still_succeeds(self, status, raw):
        """Negative control: reading the body must not dispute healthy runs
        whose device says the work finished."""
        ex = JobExecutor(devices=[])
        with self._socket(status, raw):
            result = ex._execute_generic_http(self.GH_DEVICE, self._job())

        assert result["executed"] is True, f"healthy device disputed: {result!r}"
        assert "error" not in result
        assert classify_execution_result(result) == RESULT_SUCCESS

    @pytest.mark.parametrize("status,raw", DEVICE_OPAQUE_2XX)
    def test_a_2xx_without_a_completion_statement_is_not_a_success(self, status, raw):
        """r31 item 1: absence of a recognised error is not completion."""
        ex = JobExecutor(devices=[])
        with self._socket(status, raw):
            result = ex._execute_generic_http(self.GH_DEVICE, self._job())

        assert "executed" not in result and "submitted" not in result, result
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE

    @pytest.mark.parametrize("status", [300, 301, 302, 304, 308])
    def test_success_band_is_2xx_not_sub_400(self, status):
        """Directly locks the band: a 3xx is a redirect, not an execution."""
        ex = JobExecutor(devices=[])
        with self._socket(status, ""):
            result = ex._execute_generic_http(self.GH_DEVICE, self._job())

        assert result["executed"] is False, f"HTTP {status} reported as executed"
        assert classify_execution_result(result) == RESULT_FAILURE

    # --- end to end ---------------------------------------------------------

    @pytest.mark.parametrize("status,raw", DEVICE_FAILURES)
    @pytest.mark.parametrize(
        "device,capability",
        [
            pytest.param(GH_DEVICE, "generic", id="generic-http"),
            pytest.param(OP_DEVICE, "3d-print", id="octoprint"),
        ],
    )
    def test_device_failure_disputes_end_to_end(self, device, capability, status, raw):
        """The contract's acceptance vector for a reachable-but-failed device:
        failed -> execution_failed + no execution_completed -> oracle disputes."""
        gateway = self._gateway()
        ex = JobExecutor(devices=[device], gateway_client=gateway)
        job = {**self._job(), "capabilityType": capability}

        with self._socket(status, raw):
            bundle = ex.execute(job)

        types = _event_types(bundle)
        statuses = self._statuses(gateway)

        assert EVENT_EXECUTION_FAILED in types
        assert EVENT_EXECUTION_COMPLETED not in types
        assert "execution_completed" not in _bundle_text(bundle)
        assert "failed" in statuses
        assert "completed" not in statuses
        gateway.push_evidence.assert_called_once()

    def test_healthy_device_still_releases_end_to_end(self):
        """CHANGED (r31 item 1): the body was {"ok": true}, which no longer
        states completion; a device that says so still releases."""
        gateway = self._gateway()
        ex = JobExecutor(devices=[self.GH_DEVICE], gateway_client=gateway)

        with self._socket(200, _json_body({"status": "completed"})):
            bundle = ex.execute(self._job())

        types = _event_types(bundle)
        statuses = self._statuses(gateway)

        assert EVENT_EXECUTION_COMPLETED in types
        assert EVENT_EXECUTION_FAILED not in types
        assert "execution_failed" not in _bundle_text(bundle)
        assert "completed" in statuses
        assert "failed" not in statuses

    def test_an_opaque_2xx_fails_closed_end_to_end(self):
        """r31 item 1: {"ok": true} used to release; now nothing is claimed
        and the job is reported failed (unclassifiable)."""
        gateway = self._gateway()
        ex = JobExecutor(devices=[self.GH_DEVICE], gateway_client=gateway)

        with self._socket(200, _json_body({"ok": True})):
            bundle = ex.execute(self._job())

        assert EVENT_EXECUTION_COMPLETED not in _event_types(bundle)
        assert "execution_completed" not in _bundle_text(bundle)
        assert self._statuses(gateway) == ["running", "failed"]


# ---------------------------------------------------------------------------
# A dropped 'failed' report is loud, not silent
#
# `update_job_status` returns False after a bare log.warning when the gateway
# rejects the PATCH (ws_client.py:183), and every call site in job_executor.py
# discarded that return.  A dropped 'failed' report leaves the job non-terminal
# upstream -- which matters because the gateway's own completion route is gated
# on the job not already being 'failed'.  These tests lock the ERROR-level
# surfacing; they do NOT claim the hole is closed (a retry/outbox here, or a
# gateway-side change, is what would close it).
# ---------------------------------------------------------------------------

import logging  # noqa: E402


class TestDroppedFailureReportIsSurfaced:
    IPP_DEVICE = {"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}

    def _run(self, result, ack, caplog):
        gateway = mock.Mock()
        gateway.push_evidence.return_value = True
        # The 'running' claim lands (otherwise the job never starts, see
        # TestClaimBeforeSideEffect); `ack` governs the terminal report.
        gateway.update_job_status.side_effect = (
            lambda job_id, status, *rest, **kw: True if status == "running" else ack
        )
        ex = JobExecutor(devices=[self.IPP_DEVICE], gateway_client=gateway)
        job = {"id": "job-ack", "capabilityType": "document-printing", "parameters": {}}

        with mock.patch("pcc_node.job_executor.execute_ipp_print") as patched:
            patched.return_value = result
            with caplog.at_level(logging.ERROR, logger="pcc-node.job-executor"):
                bundle = ex.execute(job)
        return gateway, bundle

    @pytest.mark.parametrize("result", [
        pytest.param(IPP_FAIL_TIMEOUT, id="failure"),
        pytest.param({"foo": "bar"}, id="unclassifiable"),
    ])
    def test_unacknowledged_failure_report_logs_an_error(self, result, caplog):
        self._run(result, ack=False, caplog=caplog)
        errors = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
        assert any("did not acknowledge" in m for m in errors), (
            f"a dropped 'failed' report was silent; error records were {errors}"
        )

    @pytest.mark.parametrize("result", [
        pytest.param(IPP_FAIL_TIMEOUT, id="failure"),
        pytest.param({"foo": "bar"}, id="unclassifiable"),
    ])
    def test_acknowledged_failure_report_is_quiet(self, result, caplog):
        """Negative control: a report that lands must not raise an alarm."""
        self._run(result, ack=True, caplog=caplog)
        assert not [r for r in caplog.records if r.levelno >= logging.ERROR]

    def test_evidence_is_still_pushed_when_the_report_is_dropped(self, caplog):
        gateway, bundle = self._run(IPP_FAIL_TIMEOUT, ack=False, caplog=caplog)
        gateway.push_evidence.assert_called_once()
        assert EVENT_EXECUTION_FAILED in _event_types(bundle)
        assert "execution_completed" not in _bundle_text(bundle)

    def test_a_successful_job_is_unaffected(self, caplog):
        # Was IPP_SUCCESS.  A queued `lp` job is no longer a success (item 5),
        # so a device-reported completion stands in: this control only needs a
        # SUCCESS verdict flowing through execute().
        gateway, bundle = self._run(GH_SUCCESS, ack=True, caplog=caplog)
        statuses = [c[0][1] for c in gateway.update_job_status.call_args_list]
        assert "completed" in statuses
        assert EVENT_EXECUTION_COMPLETED in _event_types(bundle)


# ---------------------------------------------------------------------------
# Acceptance is not completion (evidence contract, must-close item 5)
#
# Evidence has three levels: SUBMITTED (the device accepted the command),
# DEVICE-REPORTED (the device reported the work finished) and INSPECTED-OUTPUT.
# Three adapters minted a COMPLETION flag from what was only acceptance:
#
#   * execute_ipp_print   `printed: returncode == 0` -- but `lp` exits 0 once
#                         CUPS has QUEUED the job ("request id is ..."), before
#                         a sheet is printed.
#   * _execute_octoprint  `printed` from a 2xx to `select + print` -- OctoPrint
#                         accepted the job and started it.
#   * _execute_generic_http  `executed` from ANY clean 2xx, including 202
#                         Accepted (RFC 9110 sec 15.3.3: processing not
#                         completed).
#
# Each became execution_completed, and golden-v4's and(execution_completed
# present, execution_failed absent) RELEASED a job nobody saw finish.  The
# adapters now report `submitted`; the classifier names that ACCEPTED; the
# bundle records it as execution_progress (level "submitted"); and the job is
# left "running" -- neither completed nor failed.
#
# Only the subprocess / socket layer is faked: the adapters, the classifier,
# the evidence builder and execute() all run for real underneath.
# ---------------------------------------------------------------------------

class TestAcceptanceIsNotCompletion:
    IPP_DEVICE = {"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}
    OP_DEVICE = {"id": "op1", "protocol": "octoprint", "url": "http://10.0.0.20:5000"}
    GH_DEVICE = {"id": "g1", "protocol": "generic-http", "url": "http://10.0.0.9"}

    LP_QUEUED = "request id is printer-1-1 (1 file(s))"

    def _gateway(self):
        g = mock.Mock()
        g.update_job_status.return_value = True
        g.push_evidence.return_value = True
        return g

    def _statuses(self, gateway):
        return [call[0][1] for call in gateway.update_job_status.call_args_list]

    def _socket(self, status, raw):
        return mock.patch(
            "pcc_node.http_util.urlopen",
            side_effect=lambda req, *a, **k: _RawResponse(status, raw),
        )

    @staticmethod
    def _discard_spool_file(result):
        """execute_ipp_print writes the document to a temp file it never
        deletes; don't leave one behind per test run."""
        path = result.get("filepath") if isinstance(result, dict) else None
        if path and os.path.exists(path):
            os.unlink(path)

    # --- IPP: the polarity control ------------------------------------------

    @pytest.mark.parametrize("system", ["Linux", "Darwin", "Windows"])
    def test_polarity_control_lp_exit_zero_is_never_a_success(self, system):
        """FAILS if `lp` (or `notepad /p`) exiting 0 is ever classified as
        SUCCESS again -- whether the regression comes back through the
        adapter's flag or through the classifier, since both run for real."""
        job = {"id": "job-lp", "parameters": {"content": "x", "filename": "x.txt"}}
        with mock.patch("subprocess.run") as run, \
             mock.patch("platform.system", return_value=system):
            run.return_value = mock.Mock(returncode=0, stdout=self.LP_QUEUED, stderr="")
            result = execute_ipp_print(self.IPP_DEVICE, job)
        self._discard_spool_file(result)

        assert run.called, "the print command was never issued"
        verdict = classify_execution_result(result)
        assert verdict != RESULT_SUCCESS, (
            f"exit 0 means the job was QUEUED, not printed -- classified as a "
            f"completed print: {result!r}"
        )
        assert verdict == RESULT_ACCEPTED
        assert not [k for k in COMPLETION_FLAG_KEYS if k in result]

    def test_lp_exit_zero_never_releases_end_to_end(self):
        gateway = self._gateway()
        ex = JobExecutor(devices=[self.IPP_DEVICE], gateway_client=gateway)
        job = {
            "id": "job-lp-e2e",
            "capabilityType": "document-printing",
            "parameters": {"content": "x", "filename": "x.txt"},
        }
        with mock.patch("subprocess.run") as run, \
             mock.patch("platform.system", return_value="Linux"):
            run.return_value = mock.Mock(returncode=0, stdout=self.LP_QUEUED, stderr="")
            bundle = ex.execute(job)
        self._discard_spool_file(bundle.get("result"))

        assert run.called
        assert _event_types(bundle) == [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_PROGRESS]
        assert "execution_completed" not in _bundle_text(bundle)
        assert self._statuses(gateway) == ["running"]
        gateway.push_evidence.assert_called_once()
        payload = bundle["events"][1]["payload"]
        assert payload["level"] == "submitted"
        assert payload["result"]["returncode"] == 0
        assert payload["result"]["stdout"] == self.LP_QUEUED

    def test_ipp_fixture_mirrors_the_live_adapter(self):
        job = {"parameters": {"content": "x", "filename": "x.txt"}}
        with mock.patch("subprocess.run") as run, \
             mock.patch("platform.system", return_value="Linux"):
            run.return_value = mock.Mock(
                returncode=0, stdout="request id is printer-1-1", stderr=""
            )
            result = execute_ipp_print({**self.IPP_DEVICE, "model": "Prusa"}, job)
        self._discard_spool_file(result)

        def without_path(d):
            return {k: v for k, v in d.items() if k != "filepath"}

        assert set(result) == set(IPP_ACCEPTED)
        assert without_path(result) == without_path(IPP_ACCEPTED)

    # --- OctoPrint ------------------------------------------------------------

    @pytest.mark.parametrize("status,raw", [
        # 204 No Content is OctoPrint's documented answer to select + print.
        pytest.param(204, "", id="204-no-content"),
        pytest.param(200, _json_body({}), id="200-empty-json"),
        pytest.param(201, _json_body({"name": "benchy.gcode", "origin": "local"}), id="201"),
    ])
    def test_octoprint_2xx_is_accepted_not_printed(self, status, raw):
        ex = JobExecutor(devices=[])
        with self._socket(status, raw):
            result = ex._execute_octoprint(
                self.OP_DEVICE, {"parameters": {"filename": "benchy.gcode"}}
            )

        assert result["submitted"] is True
        assert "printed" not in result, "a started print claimed to be finished"
        assert "error" not in result
        assert result == {**OP_ACCEPTED, "status_code": status}
        assert classify_execution_result(result) == RESULT_ACCEPTED

    def test_octoprint_2xx_never_releases_end_to_end(self):
        gateway = self._gateway()
        ex = JobExecutor(devices=[self.OP_DEVICE], gateway_client=gateway)
        job = {
            "id": "job-op-e2e",
            "capabilityType": "3d-print",
            "parameters": {"filename": "benchy.gcode"},
        }
        with self._socket(204, ""):
            bundle = ex.execute(job)

        assert _event_types(bundle) == [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_PROGRESS]
        assert "execution_completed" not in _bundle_text(bundle)
        assert self._statuses(gateway) == ["running"]
        gateway.push_evidence.assert_called_once()

    # --- generic HTTP: 202 is acceptance, every other 2xx is not --------------

    def test_generic_http_202_is_accepted_not_executed(self):
        ex = JobExecutor(devices=[])
        with self._socket(202, _json_body({"jobId": "abc", "status": "queued"})):
            result = ex._execute_generic_http(self.GH_DEVICE, {"parameters": {"path": "/execute"}})

        assert result == GH_ACCEPTED_202, "fixture no longer mirrors the live adapter"
        assert "executed" not in result
        assert classify_execution_result(result) == RESULT_ACCEPTED

    @pytest.mark.parametrize("raw", [
        pytest.param(_json_body({"error": "queue full; job NOT accepted"}), id="error-key"),
        pytest.param(_json_body({"success": False, "message": "rejected"}), id="success-false"),
        pytest.param(SOAP_FAULT_BODY, id="soap-fault"),
    ])
    def test_generic_http_202_still_lifts_a_body_failure(self, raw):
        """Body-error lifting runs at every status, 202 included."""
        ex = JobExecutor(devices=[])
        with self._socket(202, raw):
            result = ex._execute_generic_http(self.GH_DEVICE, {"parameters": {"path": "/execute"}})

        assert result["submitted"] is False
        assert "executed" not in result
        assert result["error"]
        assert classify_execution_result(result) == RESULT_FAILURE

    @pytest.mark.parametrize("status,raw", [
        pytest.param(200, _json_body({"ok": True}), id="200"),
        pytest.param(201, _json_body({"jobId": "abc"}), id="201"),
        pytest.param(204, "", id="204"),
    ])
    def test_generic_http_other_2xx_needs_a_completion_statement(self, status, raw):
        """CHANGED (r31 astra verdict item 1).  Old name/assertion:
        test_generic_http_other_2xx_is_still_executed_and_a_success asserted
        executed=True and RESULT_SUCCESS for these bodies.  A 2xx whose body
        states no completion is the transport answering, not the device saying
        the work finished, so no flag is claimed and it is unclassifiable."""
        ex = JobExecutor(devices=[])
        with self._socket(status, raw):
            result = ex._execute_generic_http(self.GH_DEVICE, {"parameters": {"path": "/execute"}})

        assert "executed" not in result
        assert "submitted" not in result
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE

    def test_generic_http_2xx_stating_completion_is_executed(self):
        """Positive control for the test above."""
        ex = JobExecutor(devices=[])
        with self._socket(200, _json_body({"status": "completed"})):
            result = ex._execute_generic_http(self.GH_DEVICE, {"parameters": {"path": "/execute"}})

        assert result["executed"] is True
        assert classify_execution_result(result) == RESULT_SUCCESS

    @pytest.mark.parametrize("status,raw,expected_statuses,expected_types", [
        pytest.param(200, _json_body({"jobId": "abc", "status": "completed"}), ["running", "completed"],
                     [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_COMPLETED], id="200-stating-completion-completes"),
        pytest.param(200, _json_body({"jobId": "abc"}), ["running", "failed"],
                     [EVENT_EXECUTION_STARTED], id="200-without-completion-fails-closed"),
        pytest.param(202, _json_body({"jobId": "abc"}), ["running"],
                     [EVENT_EXECUTION_STARTED, EVENT_EXECUTION_PROGRESS], id="202-stays-running"),
    ])
    def test_generic_http_200_completes_but_202_stays_running_end_to_end(
        self, status, raw, expected_statuses, expected_types
    ):
        """CHANGED (r31 item 1): the 200 case used {"jobId": "abc"} and was
        asserted to complete.  It now needs the device's completion statement;
        without one the job fails closed."""
        gateway = self._gateway()
        ex = JobExecutor(devices=[self.GH_DEVICE], gateway_client=gateway)
        job = {"id": "job-gh-e2e", "capabilityType": "generic", "parameters": {"path": "/execute"}}
        with self._socket(status, raw):
            bundle = ex.execute(job)

        assert self._statuses(gateway) == expected_statuses
        assert _event_types(bundle) == expected_types
        gateway.push_evidence.assert_called_once()


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
# Claim before the side effect
#
# For an accepted job 'running' is the only status the node reports.  If that
# claim is dropped the job stays 'queued' upstream, and a restarted daemon
# (whose seen-set is in memory) would dispatch it again: a second physical
# print.  So the node does not start a job whose claim did not land.
# ---------------------------------------------------------------------------


class TestClaimBeforeSideEffect:
    IPP_DEVICE = {"id": "p1", "protocol": "ipp", "host": "10.0.0.1"}
    JOB = {"id": "job-claim", "capabilityType": "document-printing", "parameters": {}}

    def _run(self, claim_ack, caplog):
        gateway = mock.Mock()
        gateway.push_evidence.return_value = True
        gateway.update_job_status.return_value = claim_ack
        ex = JobExecutor(devices=[self.IPP_DEVICE], gateway_client=gateway)
        with mock.patch("pcc_node.job_executor.execute_ipp_print") as patched:
            patched.return_value = IPP_ACCEPTED
            with caplog.at_level(logging.ERROR, logger="pcc-node.job-executor"):
                out = ex.execute(dict(self.JOB))
        return gateway, patched, out

    def test_an_unacknowledged_claim_does_not_start_the_job(self, caplog):
        gateway, adapter, out = self._run(claim_ack=False, caplog=caplog)
        adapter.assert_not_called()
        gateway.push_evidence.assert_not_called()
        assert [c[0][1] for c in gateway.update_job_status.call_args_list] == ["running"]
        gateway.forget_job.assert_called_once_with("job-claim")
        assert out["error"] == "claim_not_acknowledged"
        errors = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
        assert any("did not acknowledge the 'running' claim" in m for m in errors)

    def test_an_acknowledged_claim_starts_the_job(self, caplog):
        """Positive control: the same job runs once the claim lands."""
        gateway, adapter, _ = self._run(claim_ack=True, caplog=caplog)
        adapter.assert_called_once()
        gateway.push_evidence.assert_called_once()
        gateway.forget_job.assert_not_called()
        assert not [r for r in caplog.records if r.levelno >= logging.ERROR]

    def test_no_gateway_means_no_claim_to_wait_for(self):
        ex = JobExecutor(devices=[self.IPP_DEVICE], gateway_client=None)
        with mock.patch("pcc_node.job_executor.execute_ipp_print") as patched:
            patched.return_value = IPP_ACCEPTED
            ex.execute(dict(self.JOB))
        patched.assert_called_once()

    def test_a_forgotten_job_is_polled_again(self):
        from pcc_node.ws_client import PCCGatewayClient

        client = PCCGatewayClient.__new__(PCCGatewayClient)
        client.gateway_url = "http://gw.test"
        client.kernel_id = "k1"
        client.api_key = "test-key"
        client._seen_jobs = set()
        with mock.patch(
            "pcc_node.ws_client._http", return_value=(200, {"jobs": [{"id": "job-claim"}]})
        ):
            client.mark_job_seen("job-claim")
            assert client.poll_for_jobs() == []
            client.forget_job("job-claim")
            assert [j["id"] for j in client.poll_for_jobs()] == ["job-claim"]


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
# r31 astra verdict item 1 (bus #2476): the live generic HTTP adapter against
# every row of the reviewer's table, plus the per-device completion contract.
# ---------------------------------------------------------------------------


class TestR31GenericHttpCompletionContract:
    GH_DEVICE = {"id": "g1", "protocol": "generic-http", "url": "http://10.0.0.9"}

    def _socket(self, status, raw):
        return mock.patch(
            "pcc_node.http_util.urlopen",
            side_effect=lambda req, *a, **k: _RawResponse(status, raw),
        )

    def _run(self, status, raw, device=None):
        ex = JobExecutor(devices=[])
        with self._socket(status, raw):
            return ex._execute_generic_http(device or self.GH_DEVICE, {"parameters": {"path": "/execute"}})

    @pytest.mark.parametrize("raw,expected", [
        pytest.param(_json_body({"status": "queued"}), RESULT_ACCEPTED, id="queued-is-acceptance"),
        pytest.param(_json_body({"submitted": True}), RESULT_ACCEPTED, id="submitted-is-acceptance"),
        pytest.param(_json_body({"data": {"error": "jam"}}), RESULT_FAILURE, id="nested-failure"),
        pytest.param(_json_body({"result": {"success": False}}), RESULT_FAILURE, id="nested-failed-result"),
        pytest.param(_json_body([{"error": "jam"}]), RESULT_FAILURE, id="failure-in-list"),
        pytest.param(_json_body({"status": "jammed"}), RESULT_UNCLASSIFIABLE, id="unknown-status-word"),
        pytest.param(_json_body({}), RESULT_UNCLASSIFIABLE, id="empty-object"),
        pytest.param("null", RESULT_UNCLASSIFIABLE, id="null"),
        pytest.param(_json_body({"success": "false"}), RESULT_FAILURE, id="string-false-success"),
        pytest.param(_json_body({"ok": 0}), RESULT_FAILURE, id="zero-ok"),
        pytest.param(_json_body({"status": ["failed"]}), RESULT_FAILURE, id="status-list"),
        pytest.param(_json_body({"status": "completed", "data": {"state": "queued"}}),
                     RESULT_UNCLASSIFIABLE, id="completion-and-acceptance-conflict"),
        pytest.param(_json_body({"done": "yes"}), RESULT_UNCLASSIFIABLE, id="non-boolean-done"),
        pytest.param(_json_body({"status": None}), RESULT_UNCLASSIFIABLE, id="null-status"),
    ])
    def test_the_reviewers_table_never_reaches_success(self, raw, expected):
        result = self._run(200, raw)
        assert "executed" not in result or result["executed"] is not True, result
        assert classify_execution_result(result) == expected
        bundle = build_evidence_bundle("j", self.GH_DEVICE, result)
        assert EVENT_EXECUTION_COMPLETED not in _event_types(bundle)

    @pytest.mark.parametrize("raw", [
        pytest.param(_json_body({"status": "completed"}), id="completed"),
        pytest.param(_json_body({"state": "FINISHED"}), id="finished-state"),
        pytest.param(_json_body({"payload": {"completed": True}}), id="completed-flag-in-envelope"),
    ])
    def test_a_completion_statement_is_executed(self, raw):
        result = self._run(200, raw)
        assert result["executed"] is True
        assert classify_execution_result(result) == RESULT_SUCCESS

    def test_a_202_stating_completion_is_still_only_accepted(self):
        result = self._run(202, _json_body({"status": "completed"}))
        assert result == {"submitted": True, "status_code": 202,
                          "response": {"status": "completed"}, "device": "http://10.0.0.9"}
        assert classify_execution_result(result) == RESULT_ACCEPTED

    # --- per-device contract ----------------------------------------------------

    CONTRACT_DEVICE = {**GH_DEVICE, "completionField": "result.phase", "completionValues": ["FINISHED"]}

    def test_a_contract_value_is_completion(self):
        result = self._run(200, _json_body({"result": {"phase": "finished"}}), self.CONTRACT_DEVICE)
        assert result["executed"] is True
        assert classify_execution_result(result) == RESULT_SUCCESS

    @pytest.mark.parametrize("raw,expected", [
        pytest.param(_json_body({"result": {"phase": "QUEUED"}}), RESULT_ACCEPTED, id="queued-by-contract"),
        pytest.param(_json_body({"result": {"phase": "HOMING"}}), RESULT_UNCLASSIFIABLE, id="other-value"),
        pytest.param(_json_body({"status": "completed"}), RESULT_UNCLASSIFIABLE,
                     id="default-vocabulary-ignored-under-a-contract"),
        pytest.param(_json_body({"result": "FINISHED"}), RESULT_UNCLASSIFIABLE, id="path-not-traversable"),
    ])
    def test_under_a_contract_nothing_else_is_completion(self, raw, expected):
        result = self._run(200, raw, self.CONTRACT_DEVICE)
        assert "executed" not in result
        assert classify_execution_result(result) == expected

    def test_a_contract_never_overrides_a_failure(self):
        result = self._run(200, _json_body({"result": {"phase": "FINISHED", "error": "tip crash"}}),
                           self.CONTRACT_DEVICE)
        assert result["executed"] is False
        assert classify_execution_result(result) == RESULT_FAILURE

    @pytest.mark.parametrize("field", [None, "", 7])
    def test_an_unusable_contract_is_never_completion(self, field):
        device = {**self.GH_DEVICE, "completionField": field}
        result = self._run(200, _json_body({"status": "completed"}), device)
        assert "executed" not in result
        assert classify_execution_result(result) == RESULT_UNCLASSIFIABLE
