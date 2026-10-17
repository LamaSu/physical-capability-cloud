"""Verdict 117c on #471: each finding reproduced at a708c86a first.

- CRITICAL: a 3xx or 4xx answer to a start that was sent was taken as proof the
  device did not start (303 after a processed POST; 409 for a run that exists);
- CRITICAL: a run id that is not valid Unicode crashed run() after the start;
- HIGH: the lease trusted the gateway's absolute expiry against the node's own
  clock, and a renewal that came back late revived a lapsed lease;
- MEDIUM: an injected sleep overshot the deadline, and a cancel during the log
  fetch was swallowed by a run that then reported success;
- MEDIUM: a claim failed for an unusable lease was posted once and forgotten;
- MEDIUM: -0.0 was signed as "0", so a record could be swapped for another.
"""

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

nacl_signing = pytest.importorskip("nacl.signing")

import pcc_node.operating.runtime as runtime_mod
from pcc_node.log_capture import LogCapture
from pcc_node.operating.commitment import record_commitment
from pcc_node.operating.jobport import GatewayJobPort
from pcc_node.operating.runtime import AdapterRuntime

KERNEL = "kernel_bench"
JOBS = f"/api/operator/jobs?kernelId={KERNEL}&status=queued"
OPS = {"lab.absorbance": "read_absorbance"}


def _keys():
    sk = nacl_signing.SigningKey.generate()
    return sk.verify_key.encode().hex(), sk.encode().hex()


def _iso(seconds_from_now):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds_from_now)).isoformat().replace("+00:00", "Z")


class Claim:
    job_id, kernel_id, claim_token = "j-1", KERNEL, "tok-j-1"

    def __init__(self, alive=True):
        self._alive = alive

    def lease_alive(self):
        return self._alive


class Gateway:
    """The accepted claim contract, with a clock that may run ahead of the node's."""

    def __init__(self, lease_s=60.0, skew_s=0.0, renew=(200, None), claim_answer=None, status_answers=None):
        self.jobs = [{"id": "j-1", "capabilityType": "lab.absorbance", "kernelId": KERNEL}]
        self.lease_s, self.skew_s, self.renew = lease_s, skew_s, renew
        self.claim_answer = claim_answer
        self.status_answers = list(status_answers or [])
        self.renew_hold_s = 0.0
        self.calls = []
        self.lock = threading.Lock()

    def lease(self):
        return {"leaseExpiresAt": _iso(self.skew_s + self.lease_s), "leaseSeconds": self.lease_s}

    def __call__(self, method, path, body=None, *, base_url, api_key, **kwargs):
        with self.lock:
            self.calls.append((method, path, body))
        if method == "GET" and path == JOBS:
            return 200, {"jobs": self.jobs}
        if method == "POST" and path.endswith("/claim/renew"):
            time.sleep(self.renew_hold_s)
            code, answer = self.renew
            return code, answer if answer is not None else {"renewed": True, **self.lease()}
        if method == "POST" and path.endswith("/claim"):
            if self.claim_answer is not None:
                return self.claim_answer
            job_id = path.split("/")[4]
            return 200, {"claimed": True, "jobId": job_id, "claimToken": f"tok-{job_id}", **self.lease()}
        if method == "POST" and path == "/api/operator/job-status":
            return self.status_answers.pop(0) if self.status_answers else (200, {"updated": True})
        if method == "POST" and path == "/api/operator/evidence":
            return 200, {"stored": True, "jobId": body["jobId"]}
        return 404, {"error": "not found"}

    def posted(self, path):
        return [c[2] for c in self.calls if c[0] == "POST" and c[1] == path]


def _port(gateway, keys=None):
    return GatewayJobPort("http://gw.test:4310", "k-operator", KERNEL, OPS, *(keys or _keys()), request=gateway)


class Device:
    """A scripted device: each handler is (status, headers, body bytes) or a callable that writes itself."""

    def __init__(self, post=None, poll=None, log=None):
        self.requests = []
        dev = self
        default_post = (201, {}, json.dumps({"id": "run-1"}).encode())
        default_poll = (200, {}, json.dumps({"id": "run-1", "status": "succeeded"}).encode())

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _answer(self, spec):
                if callable(spec):
                    return spec(self)
                status, headers, raw = spec
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                dev.requests.append(("POST", self.path))
                self._answer(post or default_post)

            def do_GET(self):
                dev.requests.append(("GET", self.path))
                if self.path.endswith("/log"):
                    return self._answer(log or (200, {}, b"read complete"))
                self._answer(poll or default_poll)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _profile(url, timeout_s=5.0, interval_s=0.05, log=False, refusals=None):
    request = {"method": "POST", "path": "/runs", "body": {"wavelengthNm": "{wavelengthNm}"}}
    if refusals is not None:
        request["refusals"] = refusals
    op = {"request": request, "runId": "id",
          "poll": {"path": "/runs/{runId}", "field": "status", "done": ["succeeded"], "failed": ["failed"],
                   "intervalS": interval_s, "timeoutS": timeout_s}}
    if log:
        op["log"] = {"path": "/runs/{runId}/log"}
    return {"url": url, "status": {"path": "/status", "field": "state", "idle": ["idle"]},
            "operations": {"read_absorbance": op}}


def _run(runtime, claim=None):
    return runtime.run("read_absorbance", {"wavelengthNm": 450}, claim=claim or Claim())


# ── CRITICAL: a 3xx or 4xx after the start was sent ──────────────────────────

@pytest.mark.parametrize("status,headers", [(303, {"Location": "/runs/run-1"}), (302, {"Location": "/elsewhere"}),
                                            (409, {}), (400, {})])
def test_a_non_2xx_answer_to_a_sent_start_is_state_unknown(status, headers):
    dev = Device(post=(status, headers, b"{}"))
    try:
        result = _run(AdapterRuntime.from_profile(_profile(dev.url), *_keys()))
        assert result.ok is False and result.error == f"device_error:{status}:device_state_unknown", result.error
    finally:
        dev.close()


def test_only_a_refusal_the_device_declares_is_clean():
    dev = Device(post=(409, {}, b'{"error": "busy"}'))
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url, refusals=[409]), *_keys())
        result = _run(runtime)
        assert (result.ok, result.error, result.evidence) == (False, "device_refused:409", None)
    finally:
        dev.close()


@pytest.mark.parametrize("refusals", [[303], [500], ["409"], [409, 409], 409, [True]])
def test_a_declared_refusal_must_be_a_4xx_listed_once(refusals):
    with pytest.raises(runtime_mod.BindingError):
        AdapterRuntime.from_profile(_profile("http://127.0.0.1:9", refusals=refusals), *_keys())


# ── CRITICAL: nothing after the start may raise ─────────────────────────────

def test_a_run_id_that_is_not_valid_unicode_is_state_unknown():
    lone = "\\" + "ud800"  # the six ASCII characters of a JSON escape for an unpaired surrogate
    dev = Device(post=(201, {}, ('{"id": "' + lone + '"}').encode()))
    try:
        result = _run(AdapterRuntime.from_profile(_profile(dev.url), *_keys()))  # must not raise
        assert result.ok is False and result.error == "bad_run_id:device_state_unknown", result.error
    finally:
        dev.close()


def test_any_failure_after_the_start_is_state_unknown(monkeypatch):
    dev = Device()
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())

        def broken(template, segment):
            raise RuntimeError("a bug after the device started")

        monkeypatch.setattr(runtime_mod, "_run_path", broken)
        result = _run(runtime)  # must not raise
        assert result.ok is False and result.error.endswith(":device_state_unknown"), result.error
    finally:
        dev.close()


# ── HIGH: the lease ──────────────────────────────────────────────────────────

def test_the_lease_follows_the_gateways_duration_not_the_nodes_clock():
    # The gateway's clock is 10 s ahead of the node's: its 1 s lease looks like 11 s to a node that
    # compares the absolute expiry with its own clock. Renewals fail, so the lease must end on time.
    gw = Gateway(lease_s=1.0, skew_s=10.0, renew=(500, {"error": "busy"}))
    job = _port(gw).claim_next(KERNEL)
    assert job is not None
    time.sleep(1.2)
    assert job.lease_alive() is False, "the node kept a lease the gateway had already ended"


def test_a_renewal_that_comes_back_late_does_not_revive_the_lease():
    # A 4 s lease is good on the node for 3 s. The first renewal goes out at 1.5 s and answers at
    # 3.3 s: after the lease lapsed, though its own term (1.5 + 3 = 4.5 s) has not run out.
    gw = Gateway(lease_s=4.0)
    gw.renew_hold_s = 1.8
    job = _port(gw).claim_next(KERNEL)
    time.sleep(3.6)  # nobody asks lease_alive() while the renewal is out
    assert job.lease_alive() is False, "a late renewal revived a lapsed lease"


# ── MEDIUM: cancellation and the deadline ───────────────────────────────────

def test_the_pause_between_polls_cannot_overshoot_the_deadline():
    # 117d: the runtime takes no sleep hook any more (an arbitrary callable could block); its own
    # pause is sliced and checked against the deadline.
    dev = Device(poll=(200, {}, json.dumps({"id": "run-1", "status": "running"}).encode()))
    try:
        with pytest.raises(TypeError):
            AdapterRuntime.from_profile(_profile(dev.url), *_keys(), sleep=time.sleep)
        runtime = AdapterRuntime.from_profile(_profile(dev.url, timeout_s=0.1, interval_s=0.5), *_keys())
        started = time.monotonic()
        result = _run(runtime)
        assert time.monotonic() - started < 0.35, "the pause outlived the 0.1 s deadline"
        assert result.error.startswith("timeout"), result.error
    finally:
        dev.close()


def test_a_cancel_during_the_log_fetch_is_not_swallowed():
    def withhold(handler):
        time.sleep(3.0)

    dev = Device(log=withhold)
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url, log=True, timeout_s=30), *_keys())
        threading.Timer(0.5, runtime.cancel).start()
        result = _run(runtime)
        assert result.ok is False and result.error.startswith("cancelled"), result.error
    finally:
        dev.close()


# ── MEDIUM: an unusable lease's failure is applied, not just attempted ──────

def test_a_claim_failed_for_its_lease_is_retried_until_the_gateway_applies_it():
    no_lease = (200, {"claimed": True, "jobId": "j-1", "claimToken": "tok-j-1"})
    gw = Gateway(claim_answer=no_lease, status_answers=[(500, {"error": "busy"})])
    port = _port(gw)
    assert port.claim_next(KERNEL) is None
    port.claim_next(KERNEL)  # the next round retries the terminal report it still owes
    reasons = [b["metadata"]["reason"] for b in gw.posted("/api/operator/job-status")]
    assert reasons == ["claim_lease_unusable", "claim_lease_unusable"], reasons


# ── MEDIUM: numbers that do not round-trip ──────────────────────────────────

def test_negative_zero_is_never_signed():
    keys = _keys()
    gw = Gateway()
    port = _port(gw, keys)
    job = port.claim_next(KERNEL)
    record = {"status": "succeeded", "value": -0.0}
    capture = LogCapture(*keys)
    chain = [capture.capture(record_commitment(job.claim_token, job.job_id, KERNEL, "read_absorbance", record, "run-1"),
                             "device:run", "2026-10-03T00:00:00Z", entry_id="run-1:record")]
    evidence = {"operation": "read_absorbance", "runId": "run-1", "record": record, "logChain": chain,
                "signer": capture.signer}
    ack = port.report(job, evidence)
    assert (ack.stored, ack.reason) == (False, "evidence_invalid:record_not_portable"), ack
    port.complete(job, passed=False, reason="test")


def test_the_runtime_gives_no_evidence_for_negative_zero():
    dev = Device(poll=(200, {}, b'{"id": "run-1", "status": "succeeded", "value": -0.0}'))
    try:
        result = _run(AdapterRuntime.from_profile(_profile(dev.url), *_keys()))
        assert (result.ok, result.error, result.evidence) == (False, "record_not_portable", None), result
    finally:
        dev.close()
