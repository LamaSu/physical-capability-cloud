"""Verdict 117e on #512 (SHIP, one MEDIUM follow-up): reproduced at da5cfd19 first.

- MEDIUM: after the device reports a terminal state, the terminal response is decoded and the log
  and evidence are built outside the request watchdog. A cancel, a lost lease, or the deadline
  landing in that post-I/O window was not noticed, so a run whose control was already lost still
  reported ``ok=True``.

The fix re-checks control at the success gate: a run that lost control between the device finishing
and the result being returned reports ``<reason>:run_finished``, never success.
"""

import json as _json
import pathlib
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

nacl_signing = pytest.importorskip("nacl.signing")

from pcc_node.operating import runtime as runtime_mod
from pcc_node.operating.runtime import AdapterRuntime

KERNEL = "kernel_bench"


def _keys():
    sk = nacl_signing.SigningKey.generate()
    return sk.verify_key.encode().hex(), sk.encode().hex()


class Claim:
    def __init__(self):
        self.job_id, self.kernel_id, self.claim_token = "j-1", KERNEL, "tok-j-1"
        self.alive = True

    def lease_alive(self):
        return self.alive


class Device:
    """POST /runs starts run-1; the first poll already answers `succeeded` (a terminal state)."""

    def __init__(self, state="succeeded"):
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
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self._send(201, b'{"id": "run-1"}')

            def do_GET(self):
                self._send(200, _json.dumps({"id": "run-1", "status": state}).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _profile(url, timeout_s=0.3, interval_s=0.05):
    op = {"request": {"method": "POST", "path": "/runs", "body": {"wavelengthNm": "{wavelengthNm}"}}, "runId": "id",
          "poll": {"path": "/runs/{runId}", "field": "status", "done": ["succeeded"], "failed": ["failed"],
                   "intervalS": interval_s, "timeoutS": timeout_s}}
    return {"url": url, "status": {"path": "/status", "field": "state", "idle": ["idle"]},
            "operations": {"read_absorbance": op}}


class _JsonShim:
    """runtime's json, but a callback fires the instant a terminal response is decoded.

    This is the one unbounded window the verdict named: json.loads runs after the request watchdog
    is already closed, so a cancel, a lost lease or a deadline that lands here is invisible to the
    request itself. dumps is left intact (the start body and the preflight both use it).
    """

    def __init__(self, on_terminal):
        self._on = on_terminal

    def loads(self, s):
        obj = _json.loads(s)
        if isinstance(obj, dict) and obj.get("status") == "succeeded":
            self._on()
        return obj

    def dumps(self, *args, **kwargs):
        return _json.dumps(*args, **kwargs)


@pytest.mark.parametrize("mode", ["timeout", "cancelled", "lease_lost"])
def test_control_lost_while_the_terminal_response_is_finalized_is_not_success(mode, monkeypatch):
    # At da5cfd19 each of these returned ok=True: the device finished, and the loss landed in the
    # decode/log/evidence window that no watchdog covered.
    dev = Device(state="succeeded")
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url, timeout_s=0.3), *_keys())
        claim = Claim()

        def on_terminal():
            if mode == "timeout":
                time.sleep(0.6)  # carries real-monotonic past the 0.3 s deadline
            elif mode == "cancelled":
                runtime.cancel()
            else:
                claim.alive = False

        monkeypatch.setattr(runtime_mod, "json", _JsonShim(on_terminal))
        result = runtime.run("read_absorbance", {"wavelengthNm": 450}, claim=claim)
        assert result.ok is False, result
        assert result.error == f"{mode}:run_finished", result.error
        assert result.evidence is not None  # the finished run's record is still evidence
    finally:
        dev.close()


def test_an_unobstructed_run_still_succeeds():
    # The new gate must not refuse a run that kept control to the end.
    dev = Device(state="succeeded")
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url, timeout_s=5.0), *_keys())
        result = runtime.run("read_absorbance", {"wavelengthNm": 450}, claim=Claim())
        assert result.ok is True, result
        assert result.error is None, result.error
    finally:
        dev.close()
