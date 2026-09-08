"""Tests for JobExecutor and IPP print execution."""

import json
import os
import platform
import subprocess
from datetime import datetime
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

    def test_returns_printed_true_on_success(self):
        device = self._make_device()
        job = self._make_job()

        with mock.patch("subprocess.run") as mock_run, \
             mock.patch("platform.system", return_value="Linux"):
            mock_run.return_value = mock.Mock(returncode=0, stdout="request ok", stderr="")
            result = execute_ipp_print(device, job)

        assert result["printed"] is True
        assert result["returncode"] == 0

    def test_returns_printed_false_on_nonzero_returncode(self):
        device = self._make_device()
        job = self._make_job()

        with mock.patch("subprocess.run") as mock_run, \
             mock.patch("platform.system", return_value="Linux"):
            mock_run.return_value = mock.Mock(returncode=1, stdout="", stderr="lp: error")
            result = execute_ipp_print(device, job)

        assert result["printed"] is False

    def test_handles_timeout(self):
        device = self._make_device()
        job = self._make_job()

        with mock.patch("subprocess.run") as mock_run, \
             mock.patch("platform.system", return_value="Linux"):
            mock_run.side_effect = subprocess.TimeoutExpired(cmd="lp", timeout=30)
            result = execute_ipp_print(device, job)

        assert result["printed"] is False
        assert "timed out" in result.get("error", "")

    def test_handles_command_not_found(self):
        device = self._make_device()
        job = self._make_job()

        with mock.patch("subprocess.run") as mock_run, \
             mock.patch("platform.system", return_value="Linux"):
            mock_run.side_effect = FileNotFoundError("lp not found")
            result = execute_ipp_print(device, job)

        assert result["printed"] is False
        assert "error" in result

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

    def test_events_contain_job_started(self):
        device = {"id": "d1"}
        bundle = build_evidence_bundle("j1", device, {})
        event_types = [e["type"] for e in bundle["events"]]
        assert "job_started" in event_types

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
            mock_ipp.return_value = {"printed": True, "returncode": 0}
            result = ex.execute(job)

        # Gateway should have been called
        gateway.update_job_status.assert_called()
        gateway.push_evidence.assert_called_once()

        # Check status sequence: running then completed
        status_calls = [call[0][1] for call in gateway.update_job_status.call_args_list]
        assert "running" in status_calls
        assert "completed" in status_calls

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
            mock_ipp.return_value = {"printed": True}
            result = ex.execute(job)

        # Should not raise even without gateway
        assert "jobId" in result or "error" in result

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
            mock_op.return_value = {"printed": True, "filename": "benchy.gcode"}
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
    EVENT_JOB_STARTED,
    EVENT_EXECUTION_COMPLETED,
    EVENT_EXECUTION_FAILED,
    EVENT_EXECUTION_UNCLASSIFIED,
    UNCLASSIFIABLE_REASON,
    COMPLETION_FLAG_KEYS,
    ACCEPTANCE_FLAG_KEYS,
)


# --- Censused adapter result shapes ----------------------------------------
# Each mirrors, verbatim, a return statement in pcc_node/job_executor.py.

# execute_ipp_print
IPP_SUCCESS = {
    "printed": True,
    "filepath": "/tmp/pcc-print.txt",
    "returncode": 0,
    "stdout": "request id is printer-1-1",
    "stderr": "",
    "printer_ip": "10.0.0.1",
    "printer_name": "Prusa",
}
IPP_FAIL_RETURNCODE = {
    "printed": False,
    "filepath": "/tmp/pcc-print.txt",
    "returncode": 1,
    "stdout": "",
    "stderr": "lp: error - no such printer",
    "printer_ip": "10.0.0.1",
    "printer_name": "Prusa",
}
IPP_FAIL_TIMEOUT = {
    "printed": False,
    "filepath": "/tmp/pcc-print.txt",
    "error": "print command timed out",
    "printer_ip": "10.0.0.1",
}
IPP_FAIL_NOT_FOUND = {
    "printed": False,
    "filepath": "/tmp/pcc-print.txt",
    "error": "print command not available: lp not found",
    "printer_ip": "10.0.0.1",
}
IPP_FAIL_EXCEPTION = {
    "printed": False,
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
OP_SUCCESS = {
    "printed": True,
    "filename": "benchy.gcode",
    "status_code": 200,
    "device": "http://10.0.0.20:5000",
}
OP_FAIL_NO_FILENAME = {
    "error": "no_filename",
    "note": "octoprint job requires filename in parameters",
}
OP_FAIL_BAD_STATUS = {
    "printed": False,
    "filename": "benchy.gcode",
    "status_code": 500,
    "device": "http://10.0.0.20:5000",
}
# Transport failure: status 0 falls outside the (200, 201, 204) allowlist.
OP_FAIL_TRANSPORT = {
    "printed": False,
    "filename": "benchy.gcode",
    "status_code": 0,
    "device": "http://10.0.0.20:5000",
    "error": "<urlopen error [Errno 111] Connection refused>",
}
# Reachable printer, transport-level success, DEVICE-level failure: OctoPrint
# answers 204 (in the allowlist) with a jam report.  Captured live -- see
# TestDeviceReportedFailureInABody.
OP_FAIL_ERROR_IN_2XX_BODY = {
    "printed": False,
    "filename": "benchy.gcode",
    "status_code": 200,
    "device": "http://10.0.0.20:5000",
    "error": "E_JAM: carriage jam, job aborted",
}

# JobExecutor._execute_generic_http
GH_SUCCESS = {
    "executed": True,
    "status_code": 200,
    "response": {"ok": True},
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

SUCCESS_SHAPES = [
    pytest.param(IPP_SUCCESS, id="ipp-printed-true"),
    pytest.param(OT_SUCCESS, id="opentrons-submitted-true"),
    pytest.param(OP_SUCCESS, id="octoprint-printed-true"),
    pytest.param(GH_SUCCESS, id="generic-http-executed-true"),
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
    pytest.param(OT_ACCEPTED_ONLY, id="opentrons-accepted-outcome-unknown"),
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
        execution_completed for golden-v4 to release on.
        """
        assert classify_execution_result({flag: True}) == RESULT_UNCLASSIFIABLE

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

    @pytest.mark.parametrize("status_code", [200, 201, 202, 204, 299])
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
        assert types == [EVENT_JOB_STARTED, EVENT_EXECUTION_COMPLETED]
        assert EVENT_EXECUTION_FAILED not in types
        assert EVENT_EXECUTION_FAILED not in _bundle_text(bundle)

    @pytest.mark.parametrize("result", FAILURE_SHAPES)
    def test_failure_emits_execution_failed_and_never_completed(self, result):
        bundle = build_evidence_bundle("j1", self.DEVICE, result)
        types = _event_types(bundle)
        assert types == [EVENT_JOB_STARTED, EVENT_EXECUTION_FAILED]
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
        assert types == [EVENT_JOB_STARTED, EVENT_EXECUTION_UNCLASSIFIED]
        assert "execution_completed" not in _bundle_text(bundle)

    @pytest.mark.parametrize("result", UNCLASSIFIABLE_SHAPES)
    def test_unclassifiable_payload_states_the_reason(self, result):
        bundle = build_evidence_bundle("j1", self.DEVICE, result)
        assert bundle["events"][1]["payload"]["reason"] == UNCLASSIFIABLE_REASON

    def test_job_started_present_for_every_verdict(self):
        for result in (IPP_SUCCESS, IPP_FAIL_TIMEOUT, {}, None, {"foo": "bar"}):
            bundle = build_evidence_bundle("j1", self.DEVICE, result)
            assert EVENT_JOB_STARTED in _event_types(bundle)

    def test_exactly_one_outcome_event_for_every_verdict(self):
        outcome_types = {
            EVENT_EXECUTION_COMPLETED,
            EVENT_EXECUTION_FAILED,
            EVENT_EXECUTION_UNCLASSIFIED,
        }
        for result in (IPP_SUCCESS, IPP_FAIL_TIMEOUT, OP_FAIL_BAD_STATUS, {}, None):
            bundle = build_evidence_bundle("j1", self.DEVICE, result)
            found = [t for t in _event_types(bundle) if t in outcome_types]
            assert len(found) == 1, f"expected 1 outcome event, got {found}"

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

    @pytest.mark.parametrize(
        "device,capability,target,result",
        [
            pytest.param(IPP_DEVICE, "document-printing",
                         "pcc_node.job_executor.execute_ipp_print", IPP_SUCCESS, id="ipp"),
            pytest.param(OT_DEVICE, "liquid-handler",
                         "pcc_node.job_executor.JobExecutor._execute_opentrons", OT_SUCCESS, id="opentrons"),
            pytest.param(OP_DEVICE, "3d-print",
                         "pcc_node.job_executor.JobExecutor._execute_octoprint", OP_SUCCESS, id="octoprint"),
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
        assert classify_execution_result(OP_SUCCESS) == RESULT_SUCCESS

    def test_boolean_status_code_is_not_read_as_the_sentinel(self):
        """`False == 0` in Python -- a bool there is a malformed result, not a
        transport report, so the remaining rules classify it."""
        assert classify_execution_result({"printed": True, "status_code": False}) == RESULT_SUCCESS

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

    DEVICE_SUCCESSES = [
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

        assert result["printed"] is False, (
            f"HTTP {status} with a device failure body reported as printed: {result!r}"
        )
        assert result["error"]
        assert classify_execution_result(result) == RESULT_FAILURE

    @pytest.mark.parametrize("status,raw", DEVICE_SUCCESSES)
    def test_a_genuine_success_still_succeeds(self, status, raw):
        """Negative control: reading the body must not dispute healthy runs."""
        ex = JobExecutor(devices=[])
        with self._socket(status, raw):
            result = ex._execute_generic_http(self.GH_DEVICE, self._job())

        assert result["executed"] is True, f"healthy device disputed: {result!r}"
        assert "error" not in result
        assert classify_execution_result(result) == RESULT_SUCCESS

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
        gateway = self._gateway()
        ex = JobExecutor(devices=[self.GH_DEVICE], gateway_client=gateway)

        with self._socket(200, _json_body({"ok": True})):
            bundle = ex.execute(self._job())

        types = _event_types(bundle)
        statuses = self._statuses(gateway)

        assert EVENT_EXECUTION_COMPLETED in types
        assert EVENT_EXECUTION_FAILED not in types
        assert "execution_failed" not in _bundle_text(bundle)
        assert "completed" in statuses
        assert "failed" not in statuses


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
        gateway.update_job_status.return_value = ack
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
        gateway, bundle = self._run(IPP_SUCCESS, ack=True, caplog=caplog)
        statuses = [c[0][1] for c in gateway.update_job_status.call_args_list]
        assert "completed" in statuses
        assert EVENT_EXECUTION_COMPLETED in _event_types(bundle)
