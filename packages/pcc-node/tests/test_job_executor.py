"""Tests for JobExecutor: it refuses polled jobs (verdict 68b); lookups and evidence helpers."""

import json
import os
import platform
import subprocess
from datetime import datetime
from unittest import mock

import pytest

from pcc_node.job_executor import (
    JobExecutor,
    build_evidence_bundle,
    CAPABILITY_PROTOCOL_MAP,
)


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
