"""Tests for JobExecutor and IPP print execution."""

import json
import os
import platform
import subprocess
from datetime import datetime
from unittest import mock

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
