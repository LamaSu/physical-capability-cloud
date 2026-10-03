"""Verdict 117b on #471: each finding reproduced at dca69178 first.

- CRITICAL: the client ignored the claim's lease, so a job could outlive it
  while the device kept running;
- CRITICAL: a start request that may have reached the device was reported as
  an ordinary refusal (device_refused:0);
- HIGH: valid evidence from one job could be rewrapped and signed for another;
- MEDIUM: cancel() before run() was erased, a header wait could not be
  cancelled, and one read could overshoot the deadline by a socket timeout;
- MEDIUM: a failure while reading an HTTP error body escaped run();
- MEDIUM: an unsigned extra field rode inside a node-signed bundle;
- MEDIUM: a malformed 200 claim answer crashed claim_next;
- MEDIUM: a record that is not portable JSON (NaN, an integer past 2^53 - 1)
  was signed as canonical text.
"""

import hashlib
import inspect
import json
import socket
import struct
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

nacl_signing = pytest.importorskip("nacl.signing")

from pcc_node.log_capture import LogCapture, canonicalize
from pcc_node.operating import jobport as jobport_mod
from pcc_node.operating.jobport import ClaimedJob, GatewayJobPort
from pcc_node.operating.runtime import AdapterRuntime

KERNEL = "kernel_bench"
JOBS = f"/api/operator/jobs?kernelId={KERNEL}&status=queued"
OPS = {"lab.absorbance": "read_absorbance"}


def _keys():
    sk = nacl_signing.SigningKey.generate()
    return sk.verify_key.encode().hex(), sk.encode().hex()


def _iso(seconds_from_now):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds_from_now)).isoformat().replace("+00:00", "Z")


class Gateway:
    """The accepted claim contract (#4835): claim with a token and a lease, renew, terminal on expiry."""

    def __init__(self, lease_s=60.0, renew=True, claim_answer=None):
        self.jobs = [{"id": "j-1", "capabilityType": "lab.absorbance", "kernelId": KERNEL}]
        self.lease_s = lease_s
        self.renew_ok = renew
        self.claim_answer = claim_answer
        self.calls = []
        self.lock = threading.Lock()

    def __call__(self, method, path, body=None, *, base_url, api_key, **kwargs):
        with self.lock:
            self.calls.append((method, path, body))
        if method == "GET" and path == JOBS:
            return 200, {"jobs": self.jobs}
        if method == "POST" and path.endswith("/claim/renew"):
            if not self.renew_ok:
                return 409, {"error": "lease_expired"}
            return 200, {"renewed": True, "leaseExpiresAt": _iso(self.lease_s)}
        if method == "POST" and path.endswith("/claim"):
            if self.claim_answer is not None:
                return self.claim_answer
            job_id = path.split("/")[4]
            return 200, {"claimed": True, "jobId": job_id, "claimToken": f"tok-{job_id}",
                         "leaseExpiresAt": _iso(self.lease_s)}
        if method == "POST" and path == "/api/operator/evidence":
            return 200, {"stored": True, "jobId": body["jobId"]}
        if method == "POST" and path == "/api/operator/job-status":
            return 200, {"updated": True}
        return 404, {"error": "not found"}

    def renewals(self):
        return [c for c in self.calls if c[1].endswith("/claim/renew")]


def _port(gateway, keys):
    return GatewayJobPort("http://gw.test:4310", "k-operator", KERNEL, OPS, *keys, request=gateway)


class Claim:
    """A stand-in claim for runtime tests: job, kernel, digest, and a lease that holds."""

    def __init__(self, job_id="j-1", token="tok-j-1", alive=True):
        self.job_id, self.kernel_id, self.claim_token = job_id, KERNEL, token
        self._alive = alive

    def lease_alive(self):
        return self._alive


def _run(runtime, operation, params, claim=None):
    """runtime.run, passing the claim when the runtime takes one (it does from round 3)."""
    if "claim" in inspect.signature(runtime.run).parameters:
        return runtime.run(operation, params, claim=claim or Claim())
    return runtime.run(operation, params)


class Device:
    """A scripted device. mode: normal, reset_after_post, slow_headers, drip_then_stall, broken_error_body,
    reset_error_body."""

    def __init__(self, mode="normal", run_status="succeeded", hold_s=5.0, lead_s=0.0):
        self.requests = []
        dev = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _body(self, code, obj):
                raw = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                dev.requests.append(("POST", self.path, dict(self.headers)))
                if mode == "reset_after_post":
                    self.connection.shutdown(socket.SHUT_RDWR)  # took the start, answered nothing
                    return
                if mode == "slow_headers":
                    time.sleep(hold_s)
                if mode == "reset_error_body":
                    self.send_response(500)
                    self.send_header("Content-Length", "100")
                    self.end_headers()
                    self.wfile.write(b'{"error":')
                    self.wfile.flush()
                    time.sleep(0.1)
                    self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                    self.connection.close()  # RST: the client's next read raises
                    return
                if mode == "broken_error_body":
                    self.send_response(500)
                    self.send_header("Content-Length", "100")
                    self.end_headers()
                    self.wfile.write(b'{"error":')
                    self.wfile.flush()
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                self._body(201, {"id": "run-1"})

            def do_GET(self):
                dev.requests.append(("GET", self.path, dict(self.headers)))
                if mode == "drip_then_stall":
                    raw = json.dumps({"id": "run-1", "status": run_status}).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.flush()
                    time.sleep(lead_s)  # the first byte arrives just before the run's deadline
                    self.wfile.write(raw[:1])
                    self.wfile.flush()
                    time.sleep(hold_s)
                    return
                self._body(200, {"id": "run-1", "status": run_status})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def posts(self):
        return [r for r in self.requests if r[0] == "POST"]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _profile(url, timeout_s=5.0, interval_s=0.05):
    return {"url": url, "status": {"path": "/status", "field": "state", "idle": ["idle"]},
            "operations": {"read_absorbance": {
                "request": {"method": "POST", "path": "/runs", "body": {"wavelengthNm": "{wavelengthNm}"}},
                "runId": "id",
                "poll": {"path": "/runs/{runId}", "field": "status", "done": ["succeeded"], "failed": ["failed"],
                         "intervalS": interval_s, "timeoutS": timeout_s}}}}


# ── CRITICAL 1: the lease ────────────────────────────────────────────────────

def test_a_claim_keeps_its_lease_renewed():
    gw = Gateway(lease_s=1.5)
    port = _port(gw, _keys())
    job = port.claim_next(KERNEL)
    assert job is not None
    time.sleep(1.2)
    assert gw.renewals(), "the lease was never renewed"
    assert job.lease_alive()
    port.complete(job, passed=False, reason="test")


def test_a_claim_without_a_lease_is_never_run():
    gw = Gateway(claim_answer=(200, {"claimed": True, "jobId": "j-1", "claimToken": "tok-j-1"}))
    port = _port(gw, _keys())
    assert port.claim_next(KERNEL) is None
    # Nor is it stranded: the job this node now holds is failed, with the reason.
    finals = [c[2] for c in gw.calls if c[1] == "/api/operator/job-status"]
    assert finals == [{"jobId": "j-1", "kernelId": KERNEL, "status": "failed", "claimToken": "tok-j-1",
                       "metadata": {"reason": "claim_lease_unusable"}}]


@pytest.mark.parametrize("lease", ["2020-01-01T00:00:00Z", "2026-10-03T00:00:00", "tomorrow", 1234567890])
def test_a_lease_already_over_or_unreadable_is_unusable(lease):
    gw = Gateway(claim_answer=(200, {"claimed": True, "jobId": "j-1", "claimToken": "tok-j-1", "leaseExpiresAt": lease}))
    assert _port(gw, _keys()).claim_next(KERNEL) is None


def test_a_renewal_answered_renewed_false_ends_the_lease():
    gw = Gateway(lease_s=1.2)
    port = _port(gw, _keys())
    job = port.claim_next(KERNEL)
    original = gw.__call__

    def refuse_renewal(method, path, body=None, **kwargs):
        if path.endswith("/claim/renew"):
            gw.calls.append((method, path, body))
            return 200, {"renewed": False}
        return original(method, path, body, **kwargs)

    port._request = refuse_renewal
    deadline = time.monotonic() + 2.0
    while job.lease_alive() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not job.lease_alive() and gw.renewals()


def test_a_lost_lease_stops_the_run_with_its_state_unknown():
    gw = Gateway(lease_s=1.2, renew=False)
    keys = _keys()
    port = _port(gw, keys)
    dev = Device(run_status="running")
    try:
        job = port.claim_next(KERNEL)
        runtime = AdapterRuntime.from_profile(_profile(dev.url, timeout_s=30), *keys)
        started = time.monotonic()
        result = _run(runtime, "read_absorbance", {"wavelengthNm": 450}, claim=job)
        assert time.monotonic() - started < 3.0, "the run outlived its lease"
        assert result.ok is False and result.error.endswith(":device_state_unknown"), result.error
    finally:
        dev.close()


# ── CRITICAL 2: an ambiguous start ──────────────────────────────────────────

def test_a_start_that_may_have_reached_the_device_is_state_unknown():
    dev = Device(mode="reset_after_post")
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
        result = _run(runtime, "read_absorbance", {"wavelengthNm": 450})
        assert len(dev.posts()) == 1
        assert result.ok is False and result.error.endswith(":device_state_unknown"), result.error
    finally:
        dev.close()


def test_the_start_request_carries_an_idempotency_key_bound_to_the_claim():
    dev = Device()
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
        _run(runtime, "read_absorbance", {"wavelengthNm": 450}, claim=Claim(token="tok-j-1"))
        headers = {k.lower(): v for k, v in dev.posts()[0][2].items()}
        assert headers.get("idempotency-key"), headers
        assert "tok-j-1" not in headers["idempotency-key"]
    finally:
        dev.close()


# ── HIGH: evidence bound to its claim ───────────────────────────────────────

def _signed_evidence(keys, claim, run_id="run-1", record=None):
    record = {"status": "succeeded", "result": {"A1": 0.12}} if record is None else record
    capture = LogCapture(*keys)
    at = "2026-10-03T00:00:00Z"
    committed = {"operation": "read_absorbance", "record": record, "runId": run_id}
    if claim is not None:
        committed.update({"claim": hashlib.sha256(claim.claim_token.encode()).hexdigest(), "jobId": claim.job_id,
                          "kernelId": KERNEL})
    chain = [capture.capture(canonicalize(committed), "device:run", at, entry_id=f"{run_id}:record")]
    return {"operation": "read_absorbance", "runId": run_id, "record": record, "logChain": chain,
            "signer": capture.signer}


def test_evidence_from_one_claim_is_never_signed_for_another():
    keys = _keys()
    gw = Gateway()
    gw.jobs.append({"id": "j-2", "capabilityType": "lab.absorbance", "kernelId": KERNEL})
    port = _port(gw, keys)
    first = port.claim_next(KERNEL)
    second = port.claim_next(KERNEL)
    evidence = None
    for claim in (first, None):  # the shape this version accepts for the first job
        try:
            port._check_evidence(first, _signed_evidence(keys, claim))
            evidence = _signed_evidence(keys, claim)
            break
        except jobport_mod.EvidenceInvalid:
            continue
    assert evidence is not None
    assert port.report(first, evidence).stored is True
    assert port.report(second, evidence).stored is False
    port.complete(first, passed=False, reason="test")
    port.complete(second, passed=False, reason="test")


# ── MEDIUM: cancellation and deadlines ──────────────────────────────────────

def test_a_cancel_before_the_run_is_not_erased_by_it():
    dev = Device()
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
        runtime.cancel()
        result = _run(runtime, "read_absorbance", {"wavelengthNm": 450})
        assert dev.posts() == [], "the start request was sent after cancel()"
        assert result.ok is False and result.error.startswith("cancelled"), result.error
    finally:
        dev.close()


def test_a_header_wait_can_be_cancelled():
    dev = Device(mode="slow_headers", hold_s=6.0)
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url, timeout_s=30), *_keys())
        threading.Timer(0.3, runtime.cancel).start()
        started = time.monotonic()
        result = _run(runtime, "read_absorbance", {"wavelengthNm": 450})
        assert time.monotonic() - started < 2.0, "cancel waited for the device's headers"
        assert result.ok is False and result.error.endswith(":device_state_unknown"), result.error
    finally:
        dev.close()


def test_one_stalled_read_cannot_overshoot_the_deadline():
    dev = Device(mode="drip_then_stall", hold_s=8.0, lead_s=1.6)
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url, timeout_s=2.0), *_keys())
        started = time.monotonic()
        result = _run(runtime, "read_absorbance", {"wavelengthNm": 450})
        assert time.monotonic() - started < 2.6, "a stalled read outlived the 2 s deadline"
        assert result.ok is False and result.error.startswith("timeout"), result.error
    finally:
        dev.close()


def test_a_reset_during_an_error_body_is_a_result_not_an_exception():
    dev = Device(mode="reset_error_body")
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
        result = _run(runtime, "read_absorbance", {"wavelengthNm": 450})  # must not raise
        assert result.ok is False
        assert result.error.endswith(":device_state_unknown"), result.error
    finally:
        dev.close()


def test_a_5xx_start_is_state_unknown_not_a_refusal():
    dev = Device(mode="broken_error_body")
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
        result = _run(runtime, "read_absorbance", {"wavelengthNm": 450})
        assert result.ok is False
        assert result.error.endswith(":device_state_unknown"), result.error
    finally:
        dev.close()


# ── MEDIUM: exact evidence, safe claims, portable records ───────────────────

def test_an_unsigned_extra_field_is_never_signed():
    keys = _keys()
    gw = Gateway()
    port = _port(gw, keys)
    job = port.claim_next(KERNEL)
    # Both commitment shapes (round 2's, and round 3's claim-bound one), so either version is judged on this alone.
    shapes = [_signed_evidence(keys, job), _signed_evidence(keys, None)]
    for evidence in shapes:
        evidence["logChain"][0]["payload"]["deviceAttested"] = True
    acks = [port.report(job, evidence) for evidence in shapes]
    assert not any(ack.stored for ack in acks)
    assert not [c for c in gw.calls if c[1] == "/api/operator/evidence"]
    assert acks[0].reason == "evidence_invalid:entry_0_malformed", acks[0].reason
    port.complete(job, passed=False, reason="test")


@pytest.mark.parametrize("answer", [(200, []), (200, "claimed"), (200, None), (200, 7)])
def test_a_malformed_claim_answer_claims_nothing(answer):
    port = _port(Gateway(claim_answer=answer), _keys())
    assert port.claim_next(KERNEL) is None


@pytest.mark.parametrize("record", [{"value": float("nan")}, {"count": 2 ** 53}, {"v": float("inf")}])
def test_a_record_that_is_not_portable_json_is_never_signed(record):
    keys = _keys()
    gw = Gateway()
    port = _port(gw, keys)
    job = port.claim_next(KERNEL)
    acks = [port.report(job, _signed_evidence(keys, claim, record=record)) for claim in (job, None)]
    assert not any(ack.stored for ack in acks)
    assert acks[0].reason == "evidence_invalid:record_not_portable", acks[0].reason
    port.complete(job, passed=False, reason="test")


# ── More of round 3: what the reproductions above don't pin ─────────────────

def test_no_claim_or_a_dead_lease_means_no_start():
    dev = Device()
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
        assert runtime.run("read_absorbance", {"wavelengthNm": 450}, claim=None).error == "no_claim"
        assert _run(runtime, "read_absorbance", {"wavelengthNm": 450}, claim=Claim(alive=False)).error == "lease_lost:not_started"
        assert dev.posts() == []
    finally:
        dev.close()


def test_a_cancel_stops_one_run_only():
    dev = Device()
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
        runtime.cancel()
        assert _run(runtime, "read_absorbance", {"wavelengthNm": 450}).error == "cancelled:not_started"
        assert _run(runtime, "read_absorbance", {"wavelengthNm": 450}).ok is True
        assert len(dev.posts()) == 1
    finally:
        dev.close()


def test_one_run_at_a_time():
    dev = Device(run_status="running")
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url, timeout_s=30), *_keys())
        first = threading.Thread(target=_run, args=(runtime, "read_absorbance", {"wavelengthNm": 450}))
        first.start()
        time.sleep(0.3)
        assert _run(runtime, "read_absorbance", {"wavelengthNm": 450}).error == "busy"
        runtime.cancel()
        first.join(5)
        assert not first.is_alive() and len(dev.posts()) == 1
    finally:
        dev.close()


def test_a_device_never_reached_is_unreachable_not_unknown():
    dev = Device()
    url = dev.url
    dev.close()  # nothing listens there now
    runtime = AdapterRuntime.from_profile(_profile(url), *_keys())
    assert _run(runtime, "read_absorbance", {"wavelengthNm": 450}).error == "device_unreachable"


def test_the_idempotency_key_is_one_per_claim():
    dev = Device()
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
        for claim in (Claim(token="tok-a"), Claim(token="tok-a"), Claim(job_id="j-2", token="tok-b")):
            assert _run(runtime, "read_absorbance", {"wavelengthNm": 450}, claim=claim).ok
        keys = [{k.lower(): v for k, v in p[2].items()}["idempotency-key"] for p in dev.posts()]
        assert keys[0] == keys[1] != keys[2] and all(len(k) == 64 for k in keys)
    finally:
        dev.close()


@pytest.mark.parametrize("value", [float("nan"), 2 ** 53, chr(0xD800)])
def test_the_runtime_signs_no_record_that_is_not_portable(value):
    dev = Device()
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
        import pcc_node.operating.runtime as runtime_mod
        original = runtime_mod._request

        def odd_poll(method, url, body=None, **kwargs):
            answer = original(method, url, body, **kwargs)
            if method == "GET" and isinstance(answer.body, dict):
                return runtime_mod._Answer(answer.status, {**answer.body, "value": value}, answer.sent)
            return answer

        runtime_mod._request = odd_poll
        try:
            result = _run(runtime, "read_absorbance", {"wavelengthNm": 450})
        finally:
            runtime_mod._request = original
        assert (result.ok, result.error, result.evidence) == (False, "record_not_portable", None)
    finally:
        dev.close()


@pytest.mark.parametrize("where", ["top", "event", "signature", "timestamp", "entryId", "lone surrogate"])
def test_evidence_is_checked_exactly(where):
    keys = _keys()
    gw = Gateway()
    port = _port(gw, keys)
    job = port.claim_next(KERNEL)
    evidence = _signed_evidence(keys, job)
    entry = evidence["logChain"][0]
    if where == "top":
        evidence["verified"] = True
    elif where == "event":
        entry["attested"] = True
    elif where == "signature":
        entry["payload"]["kernelSignature"]["note"] = "trusted"
    elif where == "timestamp":
        entry["timestamp"] = "2030-01-01T00:00:00Z"
    elif where == "entryId":
        entry["payload"]["entryId"] = "other-run:record"
    else:
        evidence["record"] = {"status": "succeeded", "note": chr(0xD800)}
    ack = port.report(job, evidence)
    assert ack.stored is False and ack.reason.startswith("evidence_invalid:"), ack
    assert not [c for c in gw.calls if c[1] == "/api/operator/evidence"]
    port.complete(job, passed=False, reason="test")


def test_a_cancel_as_a_run_finishes_is_never_lost():
    # The cancel lands while the device answers the poll that ends the run: either this run
    # reports it, or the next run refuses. It is never silently dropped.
    holder = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, obj):
            raw = json.dumps(obj).encode()
            self.send_response(200 if self.command == "GET" else 201)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            self._send({"id": "run-1"})

        def do_GET(self):
            if holder.pop("cancel_now", False):
                holder["runtime"].cancel()
            self._send({"id": "run-1", "status": "succeeded"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        runtime = AdapterRuntime.from_profile(_profile(f"http://127.0.0.1:{server.server_port}"), *_keys())
        holder["runtime"], holder["cancel_now"] = runtime, True
        first = _run(runtime, "read_absorbance", {"wavelengthNm": 450})
        second = _run(runtime, "read_absorbance", {"wavelengthNm": 450})
        assert (first.error or "").startswith("cancelled") or second.error == "cancelled:not_started", (first, second)
        assert _run(runtime, "read_absorbance", {"wavelengthNm": 450}).ok  # and then it is spent
    finally:
        server.shutdown()
        server.server_close()
