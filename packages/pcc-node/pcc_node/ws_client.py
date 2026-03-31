"""PCC Gateway client -- HTTP polling transport (zero dependencies).

Uses only stdlib: urllib.request, json, time, threading, logging.

Transport is HTTP long-polling against the /api/operator/* relay endpoints.
This gives us a reliable, zero-dep connection to the gateway that works
through firewalls, proxies, and NAT without needing websocket-client.

Protocol
--------
  poll:        GET  /api/operator/jobs?kernelId=X&status=queued
  status:      PATCH /api/jobs/:jobId/status  (status, metadata)
  evidence:    POST  /api/operator/evidence
  heartbeat:   POST  /api/operator/heartbeat
  announce:    POST  /api/operator/heartbeat  (capabilities field)
"""

import json
import logging
import threading
import time
from typing import Callable, Dict, Any, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import ssl

log = logging.getLogger("pcc-node.ws")

USER_AGENT = "PCC-Node/0.1.0 (https://capability.network)"

# Relaxed SSL context for self-signed certs on local networks
_relaxed_ctx = ssl.create_default_context()
_relaxed_ctx.check_hostname = False
_relaxed_ctx.verify_mode = ssl.CERT_NONE


def _http(
    method: str,
    url: str,
    body: Optional[dict] = None,
    api_key: str = "",
    timeout: int = 30,
) -> tuple:
    """Minimal HTTP helper.  Returns (status_code, parsed_body)."""
    headers = {"User-Agent": USER_AGENT}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout, context=_relaxed_ctx) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                return resp.status, raw
    except HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return e.code, raw
    except (URLError, OSError, Exception) as e:
        return 0, {"error": str(e)}


class PCCGatewayClient:
    """Persistent HTTP-polling connection to the PCC gateway.

    Parameters
    ----------
    gateway_url:
        Base URL of the PCC gateway, e.g. ``https://capability.network``.
    api_key:
        Bearer token for auth.
    kernel_id:
        This node's kernel ID.
    on_job:
        Callback invoked for each new job dict fetched from the gateway.
    poll_interval:
        Seconds between poll requests (default 5).
    """

    def __init__(
        self,
        gateway_url: str,
        api_key: str,
        kernel_id: str,
        on_job: Optional[Callable[[Dict], None]] = None,
        poll_interval: float = 5.0,
    ):
        self.gateway_url = gateway_url.rstrip("/")
        self.api_key = api_key
        self.kernel_id = kernel_id
        self.on_job = on_job
        self.poll_interval = poll_interval
        self._running = False
        self._thread: Optional[threading.Thread] = None
        # Track seen job IDs in this session to avoid double-execution
        self._seen_jobs: set = set()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def start(self):
        """Start background polling thread."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._poll_loop,
            name="pcc-poll",
            daemon=True,
        )
        self._thread.start()
        log.info(f"Gateway client started, polling {self.gateway_url} every {self.poll_interval}s")

    def stop(self):
        """Signal the polling thread to stop and wait for it."""
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=self.poll_interval + 2)

    def announce_capabilities(self, capabilities: List[Dict]) -> bool:
        """POST capability announcement to gateway heartbeat endpoint."""
        payload = {
            "kernelId": self.kernel_id,
            "status": "online",
            "capabilities": capabilities,
            "timestamp": time.time(),
        }
        status, resp = self._post("/api/operator/heartbeat", payload)
        if status in (200, 201):
            log.info(f"Announced {len(capabilities)} capabilities")
            return True
        log.warning(f"Capability announce failed HTTP {status}: {resp}")
        return False

    def push_evidence(self, job_id: str, evidence: dict) -> bool:
        """POST evidence bundle for a completed job."""
        payload = {
            "jobId": job_id,
            "kernelId": self.kernel_id,
            "evidence": evidence,
            "timestamp": time.time(),
        }
        status, resp = self._post("/api/operator/evidence", payload)
        if status in (200, 201):
            log.info(f"Evidence pushed for job {job_id}")
            return True
        log.warning(f"Evidence push failed HTTP {status}: {resp}")
        return False

    def update_job_status(
        self,
        job_id: str,
        status: str,
        metadata: Optional[dict] = None,
    ) -> bool:
        """PATCH job status on the gateway."""
        payload: Dict[str, Any] = {"status": status}
        if metadata:
            payload["metadata"] = metadata
        http_status, resp = self._patch(f"/api/jobs/{job_id}/status", payload)
        if http_status in (200, 201):
            log.debug(f"Job {job_id} status -> {status}")
            return True
        # Try the operator relay endpoint as fallback
        fallback_payload = {
            "jobId": job_id,
            "kernelId": self.kernel_id,
            "status": status,
            "metadata": metadata or {},
            "timestamp": time.time(),
        }
        fb_status, _ = self._post("/api/operator/job-status", fallback_payload)
        if fb_status in (200, 201):
            log.debug(f"Job {job_id} status -> {status} (via relay)")
            return True
        log.warning(f"Job status update failed HTTP {http_status}: {resp}")
        return False

    def poll_for_jobs(self) -> List[Dict]:
        """GET /api/operator/jobs?kernelId=X&status=queued.

        Returns list of job dicts (may be empty).
        Falls back to /api/jobs?kernelId=X&status=queued if relay not found.
        """
        url = (
            f"{self.gateway_url}/api/operator/jobs"
            f"?kernelId={self.kernel_id}&status=queued"
        )
        status, data = _http("GET", url, api_key=self.api_key)
        if status == 404:
            # Relay endpoint not yet deployed — fall back to the standard jobs API
            url2 = (
                f"{self.gateway_url}/api/jobs"
                f"?kernelId={self.kernel_id}&status=queued"
            )
            status, data = _http("GET", url2, api_key=self.api_key)

        if status != 200:
            log.debug(f"Poll returned HTTP {status}")
            return []

        if isinstance(data, dict):
            jobs = data.get("jobs", data.get("data", []))
        elif isinstance(data, list):
            jobs = data
        else:
            return []

        # Filter out already-seen jobs to prevent double execution in this session
        new_jobs = [j for j in jobs if j.get("id") not in self._seen_jobs]
        return new_jobs

    def send_heartbeat(self, status_str: str = "online") -> bool:
        """POST heartbeat to keep the kernel marked online."""
        payload = {
            "kernelId": self.kernel_id,
            "status": status_str,
            "timestamp": time.time(),
        }
        http_status, _ = self._post("/api/operator/heartbeat", payload)
        if http_status not in (200, 201):
            # Fall back to the standard kernel heartbeat endpoint
            http_status, _ = self._post(
                f"/api/kernels/{self.kernel_id}/heartbeat",
                {"status": status_str},
            )
        return http_status in (200, 201)

    def mark_job_seen(self, job_id: str):
        """Record a job ID so we don't re-execute it this session."""
        self._seen_jobs.add(job_id)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _poll_loop(self):
        """Background polling loop.  Calls on_job for each new job."""
        while self._running:
            try:
                if self.on_job is not None:
                    jobs = self.poll_for_jobs()
                    for job in jobs:
                        job_id = job.get("id")
                        if job_id:
                            self.mark_job_seen(job_id)
                        try:
                            self.on_job(job)
                        except Exception as e:
                            log.error(f"on_job callback error for {job_id}: {e}")
            except Exception as e:
                log.error(f"Poll loop error: {e}")

            # Interruptible sleep
            deadline = time.time() + self.poll_interval
            while self._running and time.time() < deadline:
                time.sleep(0.25)

    def _url(self, path: str) -> str:
        return f"{self.gateway_url}{path}"

    def _post(self, path: str, body: dict) -> tuple:
        return _http("POST", self._url(path), body=body, api_key=self.api_key)

    def _patch(self, path: str, body: dict) -> tuple:
        return _http("PATCH", self._url(path), body=body, api_key=self.api_key)
