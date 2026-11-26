"""A halt after a start sends the declared device stop once."""

from pcc_node.operating import devicelock, runtime
from pcc_node.operating.loop import run_once
from pcc_node.operating.profile import build_r0_plate_reader_profile
from pcc_node.operating.runtime import AdapterRuntime
from tests.test_operating_reconcile import Gate, Gateway, binding, keys, make_port


def check_halt(tmp_path, monkeypatch, cause):
    directory = tmp_path / (cause or "passed")
    directory.mkdir(mode=0o700)
    monkeypatch.setattr(devicelock, "DEFAULT_DIRECTORY", str(directory))
    monkeypatch.setattr(devicelock, "read_device_identity", lambda *args, **kwargs: "serial-1")
    key_pair = keys()
    gateway = Gateway()
    port = make_port(gateway, key_pair)
    profile = build_r0_plate_reader_profile(kernel_id="kernel-1", device_id="reader-1")
    now = [0.0]
    inner = AdapterRuntime.from_profile(binding()["device"], *key_pair, clock=lambda: now[0])
    log = []
    job = port.claim_next("kernel-1")
    lock = devicelock.HostDeviceLock(binding()["device"]["url"], serial="serial-1")

    def request(method, url, body=None, **kwargs):
        log.append((method, url, body, kwargs))
        if url.endswith("/status"):
            return runtime._Answer(200, {"state": "idle"}, True)
        if url.endswith("/cancel"):
            assert "stop" not in kwargs and body is None
            assert kwargs["deadline"] == now[0] + 10.0
            return runtime._Answer(200, {}, True)
        if method == "POST":
            return runtime._Answer(201, {"id": "run /one"}, True)
        if cause == "cancelled":
            inner.cancel()
        elif cause == "lease_lost":
            job.lease.release()
        elif cause == "timeout":
            now[0] = 31.0
        return runtime._Answer(200, {"status": "running" if cause else "done"}, True)

    monkeypatch.setattr(runtime, "_request", request)
    try:
        outcome = run_once(profile, inner, port, job, gate=Gate(), lock=lock)
        stops = [entry for entry in log if entry[1].endswith("/cancel")]
        if cause:
            assert len(stops) == 1
            assert stops[0][:3] == ("POST", binding()["device"]["url"] + "/runs/run%20%2Fone/cancel", None)
            assert log.index(stops[0]) > next(i for i, entry in enumerate(log) if entry[0] == "POST")
            assert outcome.reason == cause + ":device_state_unknown"
            completions = [body for method, path, body in gateway.calls if path == "/api/operator/job-status"]
            assert len(completions) == 1
            assert completions[0]["status"] == "failed" and completions[0]["metadata"]["reason"] == outcome.reason
        else:
            assert stops == [] and outcome.passed
        return outcome
    finally:
        job.lease.release()
        lock.close()


def test_SD2_cancel_mid_run_sends_device_stop_once(tmp_path, monkeypatch):
    check_halt(tmp_path, monkeypatch, "cancelled")
    check_halt(tmp_path, monkeypatch, None)


def test_SD2_lost_lease_mid_run_sends_device_stop_once(tmp_path, monkeypatch):
    check_halt(tmp_path, monkeypatch, "lease_lost")
    check_halt(tmp_path, monkeypatch, None)


def test_SD2_deadline_mid_run_sends_device_stop_once(tmp_path, monkeypatch):
    check_halt(tmp_path, monkeypatch, "timeout")
    check_halt(tmp_path, monkeypatch, None)
