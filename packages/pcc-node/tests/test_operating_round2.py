"""Verdict 117 on #471: each test here failed at 697c4c7c, the reviewed SHA.

- CRITICAL: two nodes could both claim one queued job (no atomic claim).
- HIGH: report() signed whatever it was given, and a node could complete a job
  with no runtime evidence behind it.
- MEDIUM: a "." or ".." run id changed the polled path; a poll path could hold
  zero or two {runId}s; a runtime's second job started its chain where the
  first ended; complete() ignored updated:false; a refused claim was never
  retried; device responses had no size or time bound.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

nacl_signing = pytest.importorskip("nacl.signing")

from pcc_node.log_capture import GENESIS, LogCapture, canonicalize
from pcc_node.operating.jobport import ClaimedJob, GatewayJobPort
from pcc_node.operating.runtime import AdapterRuntime, BindingError, OperationBinding

KERNEL = "kernel_bench"
JOBS = f"/api/operator/jobs?kernelId={KERNEL}&status=queued"
STATUS = "/api/operator/job-status"
EVIDENCE = "/api/operator/evidence"
OPS = {"lab.absorbance": "read_absorbance"}


def _keys():
    sk = nacl_signing.SigningKey.generate()
    return sk.verify_key.encode().hex(), sk.encode().hex()


class Gateway:
    """master's relay (job-status always updates) plus the atomic claim route asked of the gateway lane."""

    def __init__(self, jobs=({"id": "j-1", "capabilityType": "lab.absorbance", "kernelId": KERNEL},)):
        self.jobs = [dict(j) for j in jobs]
        self.claimed = {}
        self.lock = threading.Lock()
        self.calls = []
        self.failing_claims = 0  # how many claim attempts (by either route) answer 500 first
        self.evidence_answer = (200, None)
        self.status_answer = (200, {"updated": True})

    def __call__(self, method, path, body=None, *, base_url, api_key, **kwargs):
        self.calls.append((method, path, body))
        if method == "GET" and path == JOBS:
            return 200, {"jobs": [j for j in self.jobs if j["id"] not in self.claimed]}
        if method == "POST" and path.startswith("/api/operator/jobs/") and path.endswith("/claim"):
            if self.failing_claims:
                self.failing_claims -= 1
                return 500, {"error": "busy"}
            job_id = path.split("/")[4]
            with self.lock:
                if job_id in self.claimed:
                    return 409, {"error": "job_not_claimable", "status": "in_progress"}
                self.claimed[job_id] = f"tok-{job_id}"
            return 200, {"claimed": True, "jobId": job_id, "claimToken": f"tok-{job_id}", "leaseExpiresAt": "2026-10-03T00:10:00Z"}
        if method == "POST" and path == STATUS:
            if body.get("status") == "in_progress" and self.failing_claims:
                self.failing_claims -= 1
                return 500, {"error": "busy"}
            return self.status_answer
        if method == "POST" and path == EVIDENCE:
            code, answer = self.evidence_answer
            return code, answer if answer is not None else {"stored": True, "jobId": body["jobId"]}
        return 404, {"error": "not found"}

    def posted(self, path):
        return [b for m, p, b in self.calls if m == "POST" and p == path]


def _port(gateway, keys=None):
    pub, sec = keys or _keys()
    return GatewayJobPort("http://gw.test:4310", "k-operator", KERNEL, OPS, pub, sec, request=gateway)


def _runtime_evidence(pub, sec, operation="read_absorbance", run_id="run-1", record=None):
    """Evidence exactly as AdapterRuntime builds it: one fresh chain, signed by the node key."""
    record = {"status": "succeeded", "result": {"A1": 0.12}} if record is None else record
    capture = LogCapture(pub, sec)
    at = "2026-10-03T00:00:00Z"
    chain = [capture.capture(canonicalize({"operation": operation, "record": record, "runId": run_id}),
                             "device:run", at, entry_id=f"{run_id}:record"),
             capture.capture("450nm read complete", "device:log", at, entry_id=f"{run_id}:log")]
    return {"operation": operation, "runId": run_id, "record": record, "logChain": chain, "signer": capture.signer}


class TestClaimIsAtomic:
    def test_two_nodes_cannot_both_claim_one_job(self):
        gw = Gateway()
        keys = _keys()
        first, second = _port(gw, keys), _port(gw, keys)
        got = [first.claim_next(KERNEL), second.claim_next(KERNEL)]
        assert sum(job is not None for job in got) == 1, got

    def test_a_claim_carries_its_token_into_evidence_and_the_final_status(self):
        gw = Gateway()
        pub, sec = _keys()
        port = _port(gw, (pub, sec))
        job = port.claim_next(KERNEL)
        port.report(job, _runtime_evidence(pub, sec))
        port.complete(job, passed=True, reason=None)
        assert gw.posted(EVIDENCE)[0]["claimToken"] == "tok-j-1"
        assert gw.posted(STATUS)[-1]["claimToken"] == "tok-j-1"

    def test_a_transiently_refused_claim_is_retried(self):
        gw = Gateway()
        gw.failing_claims = 1
        port = _port(gw)
        assert port.claim_next(KERNEL) is None
        job = port.claim_next(KERNEL)
        assert job is not None and job.job_id == "j-1"


class TestReportChecksBeforeSigning:
    def _claimed(self, gw, keys):
        port = _port(gw, keys)
        return port, port.claim_next(KERNEL)

    @pytest.mark.parametrize("bad", [
        "anything", "no_run_id", "no_record", "empty_chain", "wrong_operation", "foreign_signer",
        "broken_link", "tampered_record", "bad_signature",
    ])
    def test_evidence_it_cannot_check_is_never_signed_or_completed(self, bad):
        gw = Gateway()
        pub, sec = _keys()
        port, job = self._claimed(gw, (pub, sec))
        evidence = _runtime_evidence(pub, sec)
        if bad == "anything":
            evidence = {"anything": 1}
        elif bad == "no_run_id":
            evidence["runId"] = None
        elif bad == "no_record":
            evidence["record"] = None
        elif bad == "empty_chain":
            evidence["logChain"] = []
        elif bad == "wrong_operation":
            evidence = _runtime_evidence(pub, sec, operation="dispense")
        elif bad == "foreign_signer":
            evidence = _runtime_evidence(*_keys())
        elif bad == "broken_link":
            evidence["logChain"][1]["payload"]["previousHash"] = GENESIS
        elif bad == "tampered_record":
            evidence["record"] = {"status": "succeeded", "result": {"A1": 9.99}}
        elif bad == "bad_signature":
            sig = evidence["logChain"][0]["payload"]["kernelSignature"]
            sig["value"] = ("0" if sig["value"][0] != "0" else "1") + sig["value"][1:]
        port.report(job, evidence)
        port.complete(job, passed=True, reason=None)
        assert gw.posted(EVIDENCE) == []
        final = gw.posted(STATUS)[-1]
        assert final["status"] == "failed" and final["metadata"]["reason"].startswith("evidence_invalid"), final

    def test_valid_runtime_evidence_is_signed_with_the_record_as_canonical_text(self):
        gw = Gateway()
        pub, sec = _keys()
        port, job = self._claimed(gw, (pub, sec))
        record = {"status": "succeeded", "result": {"A1": 1.5e-07, "count": 2 ** 60}}
        port.report(job, _runtime_evidence(pub, sec, record=record))
        bundle = gw.posted(EVIDENCE)[0]["evidence"]["bundle"]
        assert bundle["recordCanonical"] == canonicalize(record) and "record" not in bundle
        assert all(not isinstance(v, (int, float)) or isinstance(v, bool) for v in bundle.values())


class TestAcknowledgements:
    def test_complete_reports_an_unapplied_final_status(self):
        gw = Gateway()
        gw.status_answer = (200, {"updated": False})
        pub, sec = _keys()
        port = _port(gw, (pub, sec))
        job = port.claim_next(KERNEL)
        assert port.report(job, _runtime_evidence(pub, sec)).stored is True
        ack = port.complete(job, passed=True, reason=None)
        assert ack.accepted is False and ack.status == "completed"

    def test_report_says_when_evidence_was_not_stored(self):
        gw = Gateway()
        gw.evidence_answer = (200, {"stored": False})
        pub, sec = _keys()
        port = _port(gw, (pub, sec))
        job = port.claim_next(KERNEL)
        ack = port.report(job, _runtime_evidence(pub, sec))
        assert ack.stored is False
        assert port.complete(job, passed=True, reason=None).status == "failed"


class Device:
    """A scripted generic-HTTP device: answers POST /runs with a run id, polls with a state."""

    def __init__(self, run_id="run-1", poll_body=None, drip=None):
        self.requests = []
        dev = self

        class Handler(BaseHTTPRequestHandler):
            def _send(self, code, raw):
                self.send_response(code)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                if drip:
                    for i in range(len(raw)):
                        self.wfile.write(raw[i:i + 1])
                        self.wfile.flush()
                        time.sleep(drip)
                else:
                    self.wfile.write(raw)

            def do_GET(self):
                dev.requests.append(("GET", self.path))
                body = poll_body if poll_body is not None else json.dumps({"id": run_id, "status": "succeeded"}).encode()
                self._send(200, body)

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                dev.requests.append(("POST", self.path))
                self._send(201, json.dumps({"id": run_id}).encode())

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _profile(url, timeout_s=5, poll_path="/runs/{runId}"):
    return {"url": url, "status": {"path": "/status", "field": "state", "idle": ["idle"]},
            "operations": {"read_absorbance": {
                "request": {"method": "POST", "path": "/runs", "body": {"wavelengthNm": "{wavelengthNm}"}},
                "runId": "id",
                "poll": {"path": poll_path, "field": "status", "done": ["succeeded"], "failed": ["failed"],
                         "intervalS": 0.01, "timeoutS": timeout_s}}}}


class TestRunIdsAndPaths:
    @pytest.mark.parametrize("run_id", [".", ".."])
    def test_a_dot_segment_run_id_is_refused_before_any_poll(self, run_id):
        dev = Device(run_id=run_id)
        try:
            runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
            result = runtime.run("read_absorbance", {"wavelengthNm": 450})
            assert result.ok is False and result.error == "bad_run_id"
            assert [p for m, p in dev.requests if m == "GET"] == []
        finally:
            dev.close()

    @pytest.mark.parametrize("poll_path", ["/runs", "/runs/{runId}/{runId}"])
    def test_a_poll_path_holds_exactly_one_run_id(self, poll_path):
        with pytest.raises(BindingError):
            OperationBinding.from_dict("op", {"request": {"path": "/runs"}, "poll": {"path": poll_path, "done": ["ok"]}})


class TestOneChainPerJob:
    def test_every_job_starts_its_own_chain(self):
        dev = Device()
        try:
            runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
            first = runtime.run("read_absorbance", {"wavelengthNm": 450})
            second = runtime.run("read_absorbance", {"wavelengthNm": 450})
            assert first.ok and second.ok
            assert second.evidence["logChain"][0]["payload"]["previousHash"] == GENESIS
        finally:
            dev.close()


class TestBoundedDeviceIO:
    def test_an_oversized_response_is_refused(self):
        dev = Device(poll_body=b"{" + b" " * (3 << 20) + b"}")
        try:
            runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
            result = runtime.run("read_absorbance", {"wavelengthNm": 450})
            assert result.ok is False and result.error == "device_response_too_large"
        finally:
            dev.close()

    def test_a_dripping_response_cannot_outlast_the_deadline(self):
        dev = Device(poll_body=json.dumps({"id": "run-1", "status": "succeeded"}).encode(), drip=0.2)
        try:
            runtime = AdapterRuntime.from_profile(_profile(dev.url, timeout_s=1), *_keys())
            started = time.monotonic()
            result = runtime.run("read_absorbance", {"wavelengthNm": 450})
            assert time.monotonic() - started < 2.2  # the 1 s deadline, not the device's pace
            assert result.ok is False and result.error.startswith("timeout")
        finally:
            dev.close()

    def test_a_run_can_be_cancelled(self):
        dev = Device(poll_body=json.dumps({"id": "run-1", "status": "running"}).encode())
        try:
            runtime = AdapterRuntime.from_profile(_profile(dev.url, timeout_s=30), *_keys())
            threading.Timer(0.3, runtime.cancel).start()
            started = time.monotonic()
            result = runtime.run("read_absorbance", {"wavelengthNm": 450})
            assert time.monotonic() - started < 5
            assert result.ok is False and result.error == "cancelled:device_state_unknown"
        finally:
            dev.close()
