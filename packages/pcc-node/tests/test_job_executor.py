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
OT_SUCCESS = {
    "runId": "run-1",
    "protocolId": "proto-abc",
    "submitted": True,
    "device": "http://192.168.1.200:31950",
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
    pytest.param(OP_FAIL_NO_FILENAME, id="octoprint-no-filename"),
    pytest.param(OP_FAIL_BAD_STATUS, id="octoprint-bad-http-status"),
    pytest.param(GH_FAIL_NO_BASE_URL, id="generic-http-no-base-url"),
    pytest.param(GH_FAIL_HTTP_ERROR, id="generic-http-error-status"),
    pytest.param(GH_FAIL_TRANSPORT, id="generic-http-transport-failure"),
    pytest.param(GH_TRANSPORT_PRE_FIX, id="generic-http-transport-pre-fix-shape"),
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

    @pytest.mark.parametrize("flag", ["printed", "submitted", "executed"])
    def test_boolean_flag_true_is_success(self, flag):
        assert classify_execution_result({flag: True}) == RESULT_SUCCESS

    @pytest.mark.parametrize("flag", ["printed", "submitted", "executed"])
    def test_boolean_flag_false_is_failure(self, flag):
        assert classify_execution_result({flag: False}) == RESULT_FAILURE

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
