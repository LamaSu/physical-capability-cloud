"""The loop with adk's half of item 12: the real AdapterRuntime, ClaimedJob and GatewayJobPort (astra 554 F5, 565 F4).

The device is a plate reader served on 127.0.0.1 by this test, bound with the SIM-PR1 rehearsal
binding plus an identity endpoint for the device lock. The gateway is the port's injected request
function. #471 is on this branch, so nothing here is skipped for a missing module; only a missing
pynacl skips it, as it does #471's own tests.
"""

import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from pcc_node.operating import jobport as jobport_mod
from pcc_node.operating import runtime as runtime_mod
from pcc_node.operating.commitment import idempotency_key

nacl_signing = pytest.importorskip("nacl.signing")

from pcc_node.operating.devicelock import HostDeviceLock  # noqa: E402
from pcc_node.operating.loop import run_once  # noqa: E402
from pcc_node.operating.profile import build_r0_plate_reader_profile  # noqa: E402

OPEN = SimpleNamespace(allows_jobs=lambda: True)
KERNEL = "kernel_seam"


class _PlateReader(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/identity":
            return self._send(200, {"serial": "SEAM-PR-1"})
        if self.path == "/status":
            return self._send(200, {"state": "idle"})
        if self.path == "/runs/run-1":
            return self._send(200, {"runId": "run-1", "state": "succeeded", "result": {"readings": {"A1": 0.5}}})
        if self.path == "/runs/run-1/log":
            return self._send(200, {"entries": ["read A1 at 450 nm"]})
        return self._send(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"null")
        self.server.starts.append((self.path, body, self.headers.get("Idempotency-Key")))
        if self.path == "/runs":
            return self._send(201, {"runId": "run-1", "state": "queued"})
        return self._send(404, {"error": "not_found"})


def _binding(url):
    """The SIM-PR1 rehearsal binding (returns/.../profiles/sim-pr1/.pcc/operations.json), pointed at this test's device."""
    return {
        "url": url,
        "status": {"path": "/status", "field": "state", "idle": ["idle"]},
        "operations": {
            "runPlate": {
                "request": {
                    "method": "POST",
                    "path": "/runs",
                    "body": {"plateFormat": "{plateFormat}", "wavelengthNm": "{wavelengthNm}", "wells": "{wells}"},
                    "refusals": [400, 409, 423],
                },
                "runId": "runId",
                "poll": {"path": "/runs/{runId}", "field": "state", "done": ["succeeded"],
                         "failed": ["failed", "stopped"], "intervalS": 0.05, "timeoutS": 10},
                "log": {"path": "/runs/{runId}/log"},
            }
        },
    }


class _Gateway:
    """The gateway's side of GatewayJobPort: one queued job, its selections, and what the node posts."""

    def __init__(self, selections):
        self.selections = selections
        self.evidence = []
        self.statuses = []

    def __call__(self, method, path, body=None, **_kwargs):
        if method == "GET" and path.startswith("/api/operator/jobs?"):
            return 200, {"jobs": [{"id": "job-1", "capabilityType": "lab.absorbance", "kernelId": KERNEL}]}
        if method == "POST" and path == "/api/operator/jobs/job-1/claim":
            return 200, {"claimed": True, "jobId": "job-1", "claimToken": "tok-1", "leaseSeconds": 60}
        if method == "POST" and path == "/api/operator/jobs/job-1/claim/renew":
            return 200, {"renewed": True, "leaseSeconds": 60}
        if method == "GET" and path == "/api/jobs/job-1/settlement":
            return 200, {"session": {"id": "sess-1"}}
        if method == "GET" and path == "/api/negotiate/session/sess-1":
            return 200, {"session": {"selections": dict(self.selections)}}
        if method == "POST" and path == "/api/operator/evidence":
            self.evidence.append(body)
            return 200, {"stored": True, "jobId": body["jobId"]}
        if method == "POST" and path == "/api/operator/job-status":
            self.statuses.append(body)
            return 200, {"updated": True}
        return 404, {"error": "not_found"}


class LoopWithAdapterRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _PlateReader)
        self.server.starts = []
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        url = "http://127.0.0.1:%d" % self.server.server_address[1]
        signing = nacl_signing.SigningKey.generate()
        self.keys = (signing.verify_key.encode().hex(), signing.encode().hex())
        self.runtime = runtime_mod.AdapterRuntime.from_profile(_binding(url), *self.keys)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.lock = HostDeviceLock(url, serial="SEAM-PR-1", directory=os.path.join(self.tmp.name, "device-locks"))
        self.addCleanup(self.lock.close)

    def _port(self, selections):
        gateway = _Gateway(selections)
        port = jobport_mod.GatewayJobPort("http://127.0.0.1:1", "key", KERNEL, {"lab.absorbance": "runPlate"},
                                          *self.keys, request=gateway)
        return gateway, port

    def test_a_claimed_job_runs_once_on_the_device_and_completes_with_signed_evidence(self):
        gateway, port = self._port({"plateFormat": "96-well", "wavelengthNm": 450, "wells": ["A1"]})
        job = port.claim_next(KERNEL)
        self.assertIsInstance(job, jobport_mod.ClaimedJob)
        outcome = run_once(build_r0_plate_reader_profile(), self.runtime, port, job, gate=OPEN, lock=self.lock)
        self.assertTrue(outcome.passed, outcome.reason)
        self.assertTrue(outcome.completion_accepted)
        starts = self.server.starts
        self.assertEqual([(p, b) for p, b, _ in starts], [("/runs", {"plateFormat": "96-well", "wavelengthNm": 450,
                                                                     "wells": ["A1"]})])
        # The start carried exactly the claim-bound Idempotency-Key, not just some value.
        self.assertEqual(starts[0][2], idempotency_key(job.job_id, job.kernel_id, job.claim_token))
        self.assertEqual(len(gateway.evidence), 1)
        self.assertEqual(gateway.evidence[0]["claimToken"], "tok-1")
        self.assertEqual([(s["status"], s["claimToken"]) for s in gateway.statuses], [("completed", "tok-1")])
        self.assertFalse(job.lease_alive())  # completing ended the claim's lease

    def test_an_out_of_envelope_job_never_reaches_the_device_and_is_failed(self):
        gateway, port = self._port({"plateFormat": "96-well", "wavelengthNm": 500, "wells": ["A1"]})
        job = port.claim_next(KERNEL)
        outcome = run_once(build_r0_plate_reader_profile(), self.runtime, port, job, gate=OPEN, lock=self.lock)
        self.assertFalse(outcome.ran)
        self.assertTrue(outcome.reason.startswith("envelope_violation"), outcome.reason)
        self.assertEqual(self.server.starts, [])
        self.assertEqual(gateway.evidence, [])
        self.assertEqual([s["status"] for s in gateway.statuses], ["failed"])
        self.assertFalse(job.lease_alive())

    def test_a_completed_claim_never_runs_again(self):
        gateway, port = self._port({"plateFormat": "96-well", "wavelengthNm": 450, "wells": ["A1"]})
        job = port.claim_next(KERNEL)
        first = run_once(build_r0_plate_reader_profile(), self.runtime, port, job, gate=OPEN, lock=self.lock)
        second = run_once(build_r0_plate_reader_profile(), self.runtime, port, job, gate=OPEN, lock=self.lock)
        self.assertTrue(first.passed, first.reason)
        # Completing the job ended its claim's lease, so the second attempt holds no claim.
        self.assertEqual((second.ran, second.reason), (False, "no_claim"))
        self.assertEqual(len(self.server.starts), 1)

    def test_a_duplicate_delivery_of_a_live_claim_is_refused_by_the_one_shot_record(self):
        gateway, port = self._port({"plateFormat": "96-well", "wavelengthNm": 450, "wells": ["A1"]})
        job = port.claim_next(KERNEL)
        first = run_once(build_r0_plate_reader_profile(), self.runtime, port, job, gate=OPEN, lock=self.lock)
        # The same claim delivered again with a lease that is still alive: only the record stops it.
        lease = jobport_mod.Lease(job.job_id, 60, time.monotonic(), lambda: ("ok", 60, time.monotonic()))
        self.addCleanup(lease.release)
        again = jobport_mod.ClaimedJob(job_id=job.job_id, operation=job.operation, capability_type=job.capability_type,
                                       claim_token=job.claim_token, kernel_id=job.kernel_id, lease=lease)
        second = run_once(build_r0_plate_reader_profile(), self.runtime, port, again, gate=OPEN, lock=self.lock)
        self.assertTrue(first.passed, first.reason)
        self.assertEqual((second.ran, second.reason), (False, "job_already_run"))
        self.assertEqual(len(self.server.starts), 1)


if __name__ == "__main__":
    unittest.main()
