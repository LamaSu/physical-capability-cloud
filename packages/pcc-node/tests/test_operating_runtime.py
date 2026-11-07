"""AdapterRuntime: a job never chooses the device request, and evidence is signed or absent."""

import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

nacl_signing = pytest.importorskip("nacl.signing")

from pcc_node import log_capture
from pcc_node.log_capture import LogSigningRefused, compute_entry_hash
from pcc_node.operating.runtime import AdapterRuntime, BindingError, OperationBinding, _check_base_url


def _keys():
    sk = nacl_signing.SigningKey.generate()
    return sk.verify_key.encode().hex(), sk.encode().hex()


class Claim:
    """The claim a run belongs to (verdict 117b): job, kernel, token, and a live lease."""

    job_id, kernel_id, claim_token = "j-1", "kernel_bench", "tok-j-1"

    def lease_alive(self):
        return True


CLAIM = Claim()


class FakeDevice:
    """A generic-HTTP instrument: GET /status, POST /runs, GET /runs/<id>, GET /runs/<id>/log."""

    def __init__(self, states=("running", "succeeded"), run_id="run-1", status="idle", start_status=201, redirect_to=None):
        self.requests = []
        self.states = list(states)
        self.run_id = run_id
        self.status = status
        self.start_status = start_status
        self.redirect_to = redirect_to
        device = self

        class Handler(BaseHTTPRequestHandler):
            def _send(self, code, obj, headers=()):
                raw = obj if isinstance(obj, str) else json.dumps(obj)
                self.send_response(code)
                for k, v in headers:
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(raw.encode())

            def do_GET(self):
                device.requests.append(("GET", self.path, None))
                if self.path == "/status":
                    return self._send(200, {"state": device.status})
                if self.path.endswith("/log"):
                    return self._send(200, "450nm read of A1,A2 complete")
                if self.path.startswith("/runs/"):
                    state = device.states.pop(0) if len(device.states) > 1 else device.states[0]
                    return self._send(200, {"id": device.run_id, "status": state, "result": {"A1": 0.12, "A2": 0.34}})
                return self._send(404, {"error": "not found"})

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"null")
                device.requests.append(("POST", self.path, body))
                if device.redirect_to:
                    return self._send(302, {}, [("Location", device.redirect_to)])
                return self._send(device.start_status, {"id": device.run_id})

            do_PUT = do_POST

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def posts(self):
        return [r for r in self.requests if r[0] != "GET"]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def device():
    d = FakeDevice()
    yield d
    d.close()


def _profile(url, **op_overrides):
    op = {
        "request": {"method": "POST", "path": "/runs",
                    "body": {"wavelengthNm": "{wavelengthNm}", "wells": "{wells}", "plateFormat": "96-well"}},
        "runId": "id",
        "poll": {"path": "/runs/{runId}", "field": "status", "done": ["succeeded"], "failed": ["failed", "stopped"],
                 "intervalS": 0.01, "timeoutS": 5},
        "log": {"path": "/runs/{runId}/log"},
    }
    op.update(op_overrides)
    return {"url": url, "status": {"path": "/status", "field": "state", "idle": ["idle"]},
            "operations": {"read_absorbance": op}}


def _runtime(url, **kwargs):
    pub, sec = _keys()
    return AdapterRuntime.from_profile(_profile(url), pub, sec, **kwargs), pub


class TestSigningIsMandatory:
    def test_no_pynacl_means_no_runtime(self, device, monkeypatch):
        pub, sec = _keys()
        monkeypatch.setattr(log_capture, "_HAS_NACL", False)
        with pytest.raises(LogSigningRefused):
            AdapterRuntime.from_profile(_profile(device.url), pub, sec)

    def test_a_placeholder_key_means_no_runtime(self, device):
        secret = bytes(range(32))
        with pytest.raises(LogSigningRefused):
            AdapterRuntime.from_profile(_profile(device.url), hashlib.sha256(secret).hexdigest(), secret.hex())


class TestAJobNeverChoosesTheRequest:
    def test_only_template_slots_reach_the_device(self, device):
        runtime, _ = _runtime(device.url)
        params = {"wavelengthNm": 450, "wells": ["A1", "A2"],
                  "method": "DELETE", "path": "/admin", "url": "http://203.0.113.9:1/", "host": "evil.example",
                  "plateFormat": "384-well"}
        result = runtime.run("read_absorbance", params, claim=CLAIM)
        assert result.ok, result.error
        assert device.posts() == [("POST", "/runs", {"wavelengthNm": 450, "wells": ["A1", "A2"], "plateFormat": "96-well"})]
        assert {path for _, path, _ in device.requests} == {"/runs", "/runs/run-1", "/runs/run-1/log"}

    def test_a_missing_slot_leaves_the_device_untouched(self, device):
        runtime, _ = _runtime(device.url)
        result = runtime.run("read_absorbance", {"wavelengthNm": 450}, claim=CLAIM)
        assert (result.ok, result.error) == (False, "param_missing:wells")
        assert device.requests == []

    def test_an_unbound_operation_leaves_the_device_untouched(self, device):
        runtime, _ = _runtime(device.url)
        result = runtime.run("self_destruct", {"wavelengthNm": 450, "wells": ["A1"]}, claim=CLAIM)
        assert (result.ok, result.error) == (False, "unknown_operation:self_destruct")
        assert device.requests == []

    def test_a_redirect_is_never_followed(self, device):
        other = FakeDevice()
        try:
            device.redirect_to = other.url + "/runs"
            runtime, _ = _runtime(device.url)
            result = runtime.run("read_absorbance", {"wavelengthNm": 450, "wells": ["A1"]}, claim=CLAIM)
            # 117c: a 3xx after the start was sent may follow a run that started.
            assert (result.ok, result.error) == (False, "device_error:302:device_state_unknown")
            assert other.requests == []
        finally:
            other.close()

    def test_the_devices_run_id_stays_one_path_segment(self):
        d = FakeDevice(run_id="../admin?x=1")
        try:
            runtime, _ = _runtime(d.url)
            runtime.run("read_absorbance", {"wavelengthNm": 450, "wells": ["A1"]}, claim=CLAIM)
            polled = [path for method, path, _ in d.requests if method == "GET"]
            assert polled and all(p.startswith("/runs/..%2Fadmin%3Fx%3D1") for p in polled)
        finally:
            d.close()


class TestBindingsAreCheckedAtLoad:
    @pytest.mark.parametrize("path", ["runs", "//evil.example/x", "/a/../b", "/runs?x=1", "/r@x", "/runs/{wells}",
                                      "/runs#x", "/a%2e%2e/b", "/a\\b", "http://evil.example/runs", "/runs {x}"])
    def test_unsafe_request_paths_are_refused(self, path):
        with pytest.raises(BindingError):
            OperationBinding.from_dict("op", {"request": {"path": path}, "poll": {"path": "/runs/{runId}", "done": ["ok"]}})

    def test_run_id_is_the_only_placeholder_in_a_poll_path(self):
        with pytest.raises(BindingError):
            OperationBinding.from_dict("op", {"request": {"path": "/runs"}, "poll": {"path": "/runs/{job}", "done": ["ok"]}})

    @pytest.mark.parametrize("url", ["http://127.0.0.1", "ftp://127.0.0.1:21", "http://user:pw@127.0.0.1:80",
                                     "http://127.0.0.1:80/api", "http://127.0.0.1:80?x=1", "127.0.0.1:80", "http://127.0.0.1:99999"])
    def test_device_urls_must_be_scheme_host_and_port(self, url):
        with pytest.raises(BindingError):
            _check_base_url(url)

    def test_a_slot_must_be_a_whole_string(self):
        with pytest.raises(BindingError):
            OperationBinding.from_dict("op", {"request": {"path": "/runs", "body": {"x": "read {wells} now"}},
                                             "poll": {"path": "/runs/{runId}", "done": ["ok"]}})

    def test_only_post_and_put_start_a_run(self):
        with pytest.raises(BindingError):
            OperationBinding.from_dict("op", {"request": {"method": "DELETE", "path": "/runs"},
                                             "poll": {"path": "/runs/{runId}", "done": ["ok"]}})


class TestIdle:
    def test_idle_and_busy(self, device):
        runtime, _ = _runtime(device.url)
        assert runtime.is_idle() is True
        device.status = "busy"
        assert runtime.is_idle() is False
        device.status = "estopped"
        assert runtime.is_idle() is False

    def test_an_unreachable_device_is_not_idle(self, device):
        runtime, _ = _runtime(device.url)
        device.close()
        assert runtime.is_idle() is False


class TestEvidence:
    def test_a_finished_run_returns_signed_entries_that_verify(self, device):
        runtime, pub = _runtime(device.url)
        result = runtime.run("read_absorbance", {"wavelengthNm": 450, "wells": ["A1", "A2"]}, claim=CLAIM)
        assert result.ok and result.output["result"] == {"A1": 0.12, "A2": 0.34}
        chain = result.evidence["logChain"]
        assert [e["payload"]["source"] for e in chain] == ["device:run", "device:log"]
        verify_key = nacl_signing.VerifyKey(bytes.fromhex(pub))
        previous = log_capture.GENESIS
        for event in chain:
            p = event["payload"]
            assert event["type"] == "log_hash_chain_entry"
            assert p["entryHash"] == compute_entry_hash(p["rawContent"], p["source"], p["capturedAt"])
            assert p["previousHash"] == previous
            assert p["kernelSignature"]["signer"] == "0x" + pub
            verify_key.verify(p["entryHash"].encode(), bytes.fromhex(p["kernelSignature"]["value"]))
            previous = p["entryHash"]
        assert json.loads(chain[0]["payload"]["rawContent"])["record"]["result"] == {"A1": 0.12, "A2": 0.34}

    def test_a_failed_run_is_not_ok_but_keeps_its_evidence(self):
        d = FakeDevice(states=("running", "failed"))
        try:
            runtime, _ = _runtime(d.url)
            result = runtime.run("read_absorbance", {"wavelengthNm": 450, "wells": ["A1"]}, claim=CLAIM)
            assert (result.ok, result.error) == (False, "run_failed")
            assert result.evidence["logChain"]
        finally:
            d.close()

    def test_a_run_that_never_ends_times_out(self):
        # A real clock: the watchdog that enforces the deadline reads it from its own thread.
        d = FakeDevice(states=("running",))
        try:
            pub, sec = _keys()
            profile = _profile(d.url)
            profile["operations"]["read_absorbance"]["poll"]["timeoutS"] = 0.5
            runtime = AdapterRuntime.from_profile(profile, pub, sec)
            started = time.monotonic()
            result = runtime.run("read_absorbance", {"wavelengthNm": 450, "wells": ["A1"]}, claim=CLAIM)
            assert (result.ok, result.error) == (False, "timeout:device_state_unknown")
            assert time.monotonic() - started < 2.0
        finally:
            d.close()

    def test_a_refused_start_has_no_evidence(self):
        # A refusal is clean only when the binding declares it (117c): here the device promises 409.
        d = FakeDevice(start_status=409)
        try:
            pub, sec = _keys()
            profile = _profile(d.url)
            profile["operations"]["read_absorbance"]["request"]["refusals"] = [409]
            runtime = AdapterRuntime.from_profile(profile, pub, sec)
            result = runtime.run("read_absorbance", {"wavelengthNm": 450, "wells": ["A1"]}, claim=CLAIM)
            assert (result.ok, result.error, result.evidence) == (False, "device_refused:409", None)
        finally:
            d.close()
