"""Verdict 117d on #471 (SHIP, three MEDIUM follow-ups): each reproduced at 6a4a1ac4 first.

- MEDIUM: an injected sleep hook was an arbitrary blocking callable, so a hook that ignores its
  argument carried a run past its deadline;
- MEDIUM: a deadline that ran out during the optional log fetch was dropped, and the run reported
  success;
- MEDIUM: the "not JSON" preflight let NaN and the infinities through, and the device was sent
  non-standard JSON.

Also here: the runtime looks attributes up only by constant name, so the no-shell guard's rule 7
(a computed getattr can look up anything, verdict 105f) holds for it too.
"""

import ast
import json
import pathlib
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

nacl_signing = pytest.importorskip("nacl.signing")

from pcc_node.operating.runtime import AdapterRuntime

KERNEL = "kernel_bench"
OPERATING = pathlib.Path(__file__).resolve().parents[1] / "pcc_node" / "operating"


def _keys():
    sk = nacl_signing.SigningKey.generate()
    return sk.verify_key.encode().hex(), sk.encode().hex()


class Claim:
    job_id, kernel_id, claim_token = "j-1", KERNEL, "tok-j-1"

    def lease_alive(self):
        return True


class Device:
    """POST /runs starts run-1; polls answer `state`; the log answers after `log_hold_s`."""

    def __init__(self, state="succeeded", log_hold_s=0.0):
        self.bodies = []
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
                if self.path.endswith("/log"):
                    time.sleep(log_hold_s)
                    return self._send(200, b"read complete")
                self._send(200, json.dumps({"id": "run-1", "status": state}).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _profile(url, timeout_s=5.0, interval_s=0.05, log=False):
    op = {"request": {"method": "POST", "path": "/runs", "body": {"wavelengthNm": "{wavelengthNm}"}}, "runId": "id",
          "poll": {"path": "/runs/{runId}", "field": "status", "done": ["succeeded"], "failed": ["failed"],
                   "intervalS": interval_s, "timeoutS": timeout_s}}
    if log:
        op["log"] = {"path": "/runs/{runId}/log"}
    return {"url": url, "status": {"path": "/status", "field": "state", "idle": ["idle"]},
            "operations": {"read_absorbance": op}}


def test_no_sleep_hook_can_carry_a_run_past_its_deadline():
    # At 6a4a1ac4 a hook that ignored its argument (lambda _: time.sleep(1.0)) carried a 0.1 s run
    # past its deadline by a second. The hook is gone: nothing outside the runtime decides its pauses.
    with pytest.raises(TypeError):
        AdapterRuntime.from_profile(_profile("http://127.0.0.1:9"), *_keys(), sleep=lambda _: time.sleep(1.0))


def test_a_deadline_that_runs_out_during_the_log_fetch_is_not_success():
    dev = Device(state="succeeded", log_hold_s=2.0)
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url, timeout_s=0.5, log=True), *_keys())
        result = runtime.run("read_absorbance", {"wavelengthNm": 450}, claim=Claim())
        assert result.ok is False and result.error == "timeout:run_finished", result
        assert result.evidence is not None  # the finished run's record is still evidence
    finally:
        dev.close()


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_a_param_that_is_not_json_never_reaches_the_device(value):
    dev = Device()
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys())
        result = runtime.run("read_absorbance", {"wavelengthNm": value}, claim=Claim())
        assert result.error == "param_not_json:not_started", result.error
        assert dev.bodies == [], dev.bodies
    finally:
        dev.close()


def test_the_runtime_looks_attributes_up_only_by_constant_name():
    computed = []
    for path in sorted(OPERATING.glob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("getattr", "hasattr")
                    and not (len(node.args) >= 2 and isinstance(node.args[1], ast.Constant))):
                computed.append(f"{path.name}:{node.lineno}")
    assert computed == [], computed
