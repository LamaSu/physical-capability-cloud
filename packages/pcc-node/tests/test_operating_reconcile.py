"""A previously sent start completes without reading parameters or the device."""

import nacl.signing

from pcc_node.operating import devicelock, runtime
from pcc_node.operating.jobport import GatewayJobPort
from pcc_node.operating.loop import run_once
from pcc_node.operating.profile import build_r0_plate_reader_profile
from pcc_node.operating.runtime import AdapterRuntime


PARAMS = {"plateFormat": "96-well", "wavelengthNm": 450, "wells": "all"}


def keys():
    secret = nacl.signing.SigningKey.generate()
    return secret.verify_key.encode().hex(), secret.encode().hex()


def binding():
    return {
        "deviceId": "reader-1", "serial": "serial-1",
        "capabilityTypes": {"lab.absorbance": "runPlate"},
        "device": {
            "url": "http://127.0.0.1:4310",
            "status": {"path": "/status", "field": "state", "idle": ["idle"]},
            "operations": {"runPlate": {
                "request": {"method": "POST", "path": "/runs", "body": {"params": "{wells}"}},
                "poll": {"path": "/runs/{runId}", "field": "status", "done": ["done"],
                         "failed": ["failed"], "timeoutS": 30},
            }},
            "stop": {"method": "POST", "path": "/runs/{runId}/cancel"},
        },
    }


class Gateway:
    def __init__(self):
        self.calls = []
        self.polls = []

    def __call__(self, method, path, body=None, **kwargs):
        self.calls.append((method, path, body))
        if method == "GET" and path.startswith("/api/operator/jobs?"):
            if self.polls:
                answer = self.polls.pop(0)
                if isinstance(answer, Exception):
                    raise answer
                return answer
            return 200, {"emergencyStop": "clear", "jobs": [
                {"id": "job-1", "capabilityType": "lab.absorbance"}]}
        if path.endswith("/claim"):
            return 200, {"claimed": True, "jobId": path.split("/")[-2], "claimToken": "token-1", "leaseSeconds": 600}
        if path.endswith("/claim/renew"):
            return 200, {"renewed": True, "leaseSeconds": 600}
        if path.endswith("/settlement"):
            return 200, {"session": {"id": "session-1"}}
        if path.startswith("/api/negotiate/session/"):
            return 200, {"session": {"selections": dict(PARAMS)}}
        if path == "/api/operator/evidence":
            return 200, {"stored": True, "jobId": body["jobId"]}
        if path == "/api/operator/job-status":
            return 200, {"updated": True}
        raise AssertionError((method, path, body))


def make_port(gateway, key_pair, **kwargs):
    return GatewayJobPort("https://gateway.example", "key-1", "kernel-1",
                          {"lab.absorbance": "runPlate"}, *key_pair, request=gateway, **kwargs)


class Gate:
    def allows_jobs(self):
        return True


def test_RC1_start_sent_record_reads_nothing_and_completes_once(tmp_path, monkeypatch):
    monkeypatch.setattr(devicelock, "DEFAULT_DIRECTORY", str(tmp_path))
    monkeypatch.setattr(devicelock, "read_device_identity", lambda *args, **kwargs: "serial-1")
    device_log = []

    def request(method, url, body=None, **kwargs):
        device_log.append((method, url, body))
        if url.endswith("/status"):
            return runtime._Answer(200, {"state": "idle"}, True)
        if method == "POST":
            return runtime._Answer(201, {"id": "run-1"}, True)
        return runtime._Answer(200, {"status": "done"}, True)

    monkeypatch.setattr(runtime, "_request", request)
    key_pair = keys()
    gateway = Gateway()
    port = make_port(gateway, key_pair)
    job = port.claim_next("kernel-1")
    lock = devicelock.HostDeviceLock(binding()["device"]["url"], serial="serial-1")
    profile = build_r0_plate_reader_profile(kernel_id="kernel-1", device_id="reader-1")
    inner = AdapterRuntime.from_profile(binding()["device"], *key_pair)
    try:
        lock.reserve("job:job-1")
        lock.mark_start_sent("job:job-1")
        gateway.calls.clear()
        outcome = run_once(profile, inner, port, job, gate=Gate(), lock=lock)
        assert outcome.reason == "job_needs_reconciliation"
        assert device_log == []
        assert len(gateway.calls) == 1
        method, path, body = gateway.calls[0]
        assert (method, path) == ("POST", "/api/operator/job-status")
        assert body["status"] == "failed" and body["metadata"]["reason"] == "job_needs_reconciliation"
        other_gateway = Gateway()
        other_gateway.polls = [(200, {"emergencyStop": "clear", "jobs": [
            {"id": "job-2", "capabilityType": "lab.absorbance"}]})]
        other_port = make_port(other_gateway, key_pair)
        other_job = other_port.claim_next("kernel-1")
        outcome = run_once(profile, inner, other_port, other_job, gate=Gate(), lock=lock)
        assert outcome.passed and device_log
    finally:
        job.lease.release()
        lock.close()
