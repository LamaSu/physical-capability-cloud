"""Tests for PCCGatewayClient (HTTP polling transport)."""

import json
import time
import threading
from unittest import mock

import pytest

from pcc_node.ws_client import PCCGatewayClient, _http


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_client(on_job=None):
    return PCCGatewayClient(
        gateway_url="http://pcc-test",
        api_key="test-key",
        kernel_id="kernel-123",
        on_job=on_job,
        poll_interval=0.1,
    )


# ---------------------------------------------------------------------------
# _http helper
# ---------------------------------------------------------------------------

class TestHttpHelper:
    def test_returns_parsed_json(self):
        mock_resp = mock.MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = b'{"ok": true}'
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = mock.Mock(return_value=False)

        with mock.patch("pcc_node.ws_client.urlopen", return_value=mock_resp):
            status, data = _http("GET", "http://test/api")

        assert status == 200
        assert data == {"ok": True}

    def test_returns_raw_string_on_non_json(self):
        mock_resp = mock.MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = b"hello world"
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = mock.Mock(return_value=False)

        with mock.patch("pcc_node.ws_client.urlopen", return_value=mock_resp):
            status, data = _http("GET", "http://test/api")

        assert status == 200
        assert data == "hello world"

    def test_returns_zero_on_connection_error(self):
        from urllib.error import URLError

        with mock.patch("pcc_node.ws_client.urlopen", side_effect=URLError("refused")):
            status, data = _http("GET", "http://test/api")

        assert status == 0
        assert "error" in data

    def test_returns_http_error_status(self):
        from urllib.error import HTTPError

        http_err = HTTPError(
            url="http://test", code=404,
            msg="Not Found", hdrs={}, fp=None
        )
        http_err.read = lambda: b'{"error": "not_found"}'

        with mock.patch("pcc_node.ws_client.urlopen", side_effect=http_err):
            status, data = _http("GET", "http://test/api")

        assert status == 404
        assert data.get("error") == "not_found"


# ---------------------------------------------------------------------------
# PCCGatewayClient.poll_for_jobs
# ---------------------------------------------------------------------------

class TestPollForJobs:
    def test_returns_jobs_list(self):
        client = _make_client()
        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (200, {"jobs": [
                {"id": "j1", "status": "queued", "capabilityType": "document-printing"},
            ]})
            jobs = client.poll_for_jobs()

        assert len(jobs) == 1
        assert jobs[0]["id"] == "j1"

    def test_returns_empty_on_error(self):
        client = _make_client()
        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (500, {"error": "internal"})
            jobs = client.poll_for_jobs()

        assert jobs == []

    def test_falls_back_to_jobs_api_on_404(self):
        """If /api/operator/jobs returns 404, fall back to /api/jobs."""
        client = _make_client()
        call_count = {"n": 0}

        def side_effect(method, url, **kwargs):
            call_count["n"] += 1
            if "operator/jobs" in url:
                return 404, {"error": "not_found"}
            return 200, {"jobs": [{"id": "j2", "status": "queued"}]}

        with mock.patch("pcc_node.ws_client._http", side_effect=side_effect):
            jobs = client.poll_for_jobs()

        assert call_count["n"] == 2
        assert len(jobs) == 1
        assert jobs[0]["id"] == "j2"

    def test_filters_seen_jobs(self):
        """Jobs already seen in this session should not be returned again."""
        client = _make_client()
        client.mark_job_seen("j1")

        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (200, {"jobs": [
                {"id": "j1", "status": "queued"},
                {"id": "j2", "status": "queued"},
            ]})
            jobs = client.poll_for_jobs()

        job_ids = [j["id"] for j in jobs]
        assert "j1" not in job_ids
        assert "j2" in job_ids

    def test_handles_flat_list_response(self):
        client = _make_client()
        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (200, [{"id": "j3", "status": "queued"}])
            jobs = client.poll_for_jobs()

        assert len(jobs) == 1
        assert jobs[0]["id"] == "j3"


# ---------------------------------------------------------------------------
# PCCGatewayClient.update_job_status
# ---------------------------------------------------------------------------

class TestUpdateJobStatus:
    def test_patch_succeeds(self):
        client = _make_client()
        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (200, {"job": {"id": "j1", "status": "running"}})
            result = client.update_job_status("j1", "running")

        assert result is True
        call_args = mock_h.call_args
        assert "PATCH" == call_args[0][0]
        assert "/api/jobs/j1/status" in call_args[0][1]

    def test_falls_back_to_relay_endpoint(self):
        """If PATCH fails, fall back to POST /api/operator/job-status."""
        client = _make_client()
        call_log = []

        def side_effect(method, url, **kwargs):
            call_log.append((method, url))
            if method == "PATCH":
                return 404, {"error": "not_found"}
            return 200, {"updated": True}

        with mock.patch("pcc_node.ws_client._http", side_effect=side_effect):
            result = client.update_job_status("j1", "completed")

        assert result is True
        methods = [c[0] for c in call_log]
        assert "PATCH" in methods
        assert "POST" in methods

    def test_returns_false_on_both_failures(self):
        client = _make_client()
        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (500, {"error": "server error"})
            result = client.update_job_status("j1", "failed")

        assert result is False


# ---------------------------------------------------------------------------
# PCCGatewayClient.push_evidence
# ---------------------------------------------------------------------------

class TestPushEvidence:
    def test_success(self):
        client = _make_client()
        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (200, {"stored": True, "bundleId": "ev-1"})
            result = client.push_evidence("j1", {"result": "printed"})

        assert result is True
        call_args = mock_h.call_args
        assert "/api/operator/evidence" in call_args[0][1]
        body = call_args[1].get("body") or call_args[0][2]
        assert body["jobId"] == "j1"

    def test_failure_returns_false(self):
        client = _make_client()
        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (500, {"error": "failed"})
            result = client.push_evidence("j1", {})

        assert result is False


# ---------------------------------------------------------------------------
# PCCGatewayClient.announce_capabilities
# ---------------------------------------------------------------------------

class TestAnnounceCapabilities:
    def test_sends_heartbeat_with_capabilities(self):
        client = _make_client()
        caps = [{"type": "document-printing", "deviceId": "printer-1"}]

        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (200, {"acknowledged": True})
            result = client.announce_capabilities(caps)

        assert result is True
        call_args = mock_h.call_args
        body = call_args[1].get("body") or call_args[0][2]
        assert body["capabilities"] == caps
        assert body["kernelId"] == "kernel-123"

    def test_returns_false_on_failure(self):
        client = _make_client()
        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (503, {"error": "unavailable"})
            result = client.announce_capabilities([{"type": "x"}])

        assert result is False


# ---------------------------------------------------------------------------
# PCCGatewayClient.send_heartbeat
# ---------------------------------------------------------------------------

class TestSendHeartbeat:
    def test_online_heartbeat(self):
        client = _make_client()
        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (200, {"acknowledged": True})
            result = client.send_heartbeat("online")

        assert result is True

    def test_falls_back_to_kernel_endpoint(self):
        """If /api/operator/heartbeat fails, try /api/kernels/:id/heartbeat."""
        client = _make_client()
        call_log = []

        def side_effect(method, url, **kwargs):
            call_log.append(url)
            if "operator/heartbeat" in url:
                return 404, {"error": "not_found"}
            return 200, {}

        with mock.patch("pcc_node.ws_client._http", side_effect=side_effect):
            result = client.send_heartbeat("online")

        assert result is True
        assert any("kernels" in url for url in call_log)


# ---------------------------------------------------------------------------
# PCCGatewayClient background polling thread
# ---------------------------------------------------------------------------

class TestPollingThread:
    def test_start_stop(self):
        received = []
        client = PCCGatewayClient(
            gateway_url="http://test",
            api_key="k",
            kernel_id="k1",
            on_job=lambda j: received.append(j),
            poll_interval=0.05,
        )

        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (200, {"jobs": [{"id": "jX", "status": "queued"}]})
            client.start()
            time.sleep(0.2)
            client.stop()

        # Should have received at least one job
        assert len(received) >= 1
        assert received[0]["id"] == "jX"

    def test_stop_is_idempotent(self):
        client = _make_client()
        client.stop()  # Should not raise even if not started
        client.start()
        client.stop()
        client.stop()  # Double stop should not raise

    def test_on_job_exception_does_not_crash_loop(self):
        """Errors in the on_job callback must not kill the polling thread."""
        call_count = {"n": 0}

        def bad_job_handler(job):
            call_count["n"] += 1
            raise RuntimeError("intentional error")

        client = PCCGatewayClient(
            gateway_url="http://test",
            api_key="k",
            kernel_id="k1",
            on_job=bad_job_handler,
            poll_interval=0.05,
        )

        with mock.patch("pcc_node.ws_client._http") as mock_h:
            # Return a fresh (unseen) job on each call
            job_id_counter = {"n": 0}
            seen = set()

            def fresh_jobs(method, url, **kwargs):
                if method != "GET":
                    return 200, {}
                job_id_counter["n"] += 1
                jid = f"j{job_id_counter['n']}"
                return 200, {"jobs": [{"id": jid, "status": "queued"}]}

            mock_h.side_effect = fresh_jobs
            client.start()
            time.sleep(0.3)
            client.stop()

        # Loop survived despite callback errors
        assert call_count["n"] >= 1
        assert client._thread is not None
