"""ChatGPT r3 finding 4 (MEDIUM, pcc-node 0.1.1 r4): only standard JSON reaches a device.

At e7e6f821 both the runtime's preflight and its transport serialized with json.dumps' defaults, so
a declared slot holding NaN, Infinity or -Infinity passed validation and the device was sent
non-standard JSON. Both now use allow_nan=False (#512's da5cfd19), and the refusal comes before any
connection: the preflight returns ``param_not_json:not_started``, and the transport, if handed such a
body anyway, raises ``body_not_json`` with nothing sent.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

nacl_signing = pytest.importorskip("nacl.signing")

from pcc_node.operating import runtime as runtime_mod
from pcc_node.operating.runtime import AdapterRuntime

NOT_JSON = [float("nan"), float("inf"), float("-inf")]


def _keys():
    sk = nacl_signing.SigningKey.generate()
    return sk.verify_key.encode().hex(), sk.encode().hex()


class Claim:
    job_id, kernel_id, claim_token = "j-1", "kernel_bench", "tok-j-1"

    def lease_alive(self):
        return True


class Device:
    """POST /runs starts run-1 and polls answer succeeded. Every connection the device accepts is
    counted, and every request body it reads is kept."""

    def __init__(self):
        self.bodies = []
        self.connections = 0
        dev = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, code, raw):
                self.send_response(code)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                dev.bodies.append(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                self._send(201, b'{"id": "run-1"}')

            def do_GET(self):
                self._send(200, json.dumps({"id": "run-1", "status": "succeeded"}).encode())

        class Server(ThreadingHTTPServer):
            def verify_request(self, request, client_address):
                dev.connections += 1
                return True

        self.server = Server(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _profile(url):
    op = {"request": {"method": "POST", "path": "/runs", "body": {"wavelengthNm": "{wavelengthNm}"}}, "runId": "id",
          "poll": {"path": "/runs/{runId}", "field": "status", "done": ["succeeded"], "failed": ["failed"],
                   "intervalS": 0.05, "timeoutS": 5.0}}
    return {"url": url, "status": {"path": "/status", "field": "state", "idle": ["idle"]},
            "operations": {"read_absorbance": op}}


@pytest.mark.parametrize("value", NOT_JSON + [[450, float("nan")], {"nm": float("inf")}],
                         ids=["nan", "inf", "-inf", "nested-in-a-list", "nested-in-an-object"])
def test_a_param_that_is_not_json_never_reaches_the_device(value):
    # Ported from #512's tests/test_operating_round5.py (da5cfd19), with the nested cases added.
    dev = Device()
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
        result = runtime.run("read_absorbance", {"wavelengthNm": value}, claim=Claim())
    finally:
        dev.close()
    assert result.ok is False and result.error == "param_not_json:not_started", result
    assert dev.bodies == [] and dev.connections == 0


@pytest.mark.parametrize("value", NOT_JSON, ids=["nan", "inf", "-inf"])
def test_the_transport_refuses_a_body_that_is_not_json_before_connecting(value):
    dev = Device()
    try:
        with pytest.raises(runtime_mod._Abort) as refused:
            runtime_mod._request("POST", dev.url + "/runs", {"wavelengthNm": value},
                                 deadline=time.monotonic() + 5.0, clock=time.monotonic)
    finally:
        dev.close()
    assert refused.value.reason == "body_not_json" and refused.value.sent is False
    assert dev.bodies == [] and dev.connections == 0


def test_a_finite_param_still_reaches_the_device():
    # Control: standard JSON numbers are sent as before.
    dev = Device()
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
        result = runtime.run("read_absorbance", {"wavelengthNm": 450.5}, claim=Claim())
    finally:
        dev.close()
    assert result.ok is True, result
    assert [json.loads(b) for b in dev.bodies] == [{"wavelengthNm": 450.5}]
