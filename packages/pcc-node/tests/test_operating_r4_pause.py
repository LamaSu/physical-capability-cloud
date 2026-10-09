"""ChatGPT r3 finding 5 (MEDIUM, pcc-node 0.1.1 r4): nothing outside the runtime decides how long it
pauses between polls.

At e7e6f821 AdapterRuntime took a ``sleep`` callback and called it for each 20 ms slice of the pause,
but a slice is only as short as the callback makes it: one that sleeps a second when asked for 20 ms
carried a 100 ms operation past its deadline, and nothing could interrupt it. The hook is gone
(#512's da5cfd19); the pause is the runtime's own bounded sleeps, with a stop check between them, so
a cancel, a lost lease or the deadline ends it within a slice.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

nacl_signing = pytest.importorskip("nacl.signing")

from pcc_node.operating.runtime import AdapterRuntime, DeviceStatus, OperationBinding


def _keys():
    sk = nacl_signing.SigningKey.generate()
    return sk.verify_key.encode().hex(), sk.encode().hex()


class Claim:
    def __init__(self):
        self.job_id, self.kernel_id, self.claim_token = "j-1", "kernel_bench", "tok-j-1"
        self.alive = True

    def lease_alive(self):
        return self.alive


class Device:
    """POST /runs starts run-1; every poll answers ``running``. After the first poll is answered,
    ``on_first_poll`` runs 0.2 s later: by then the runtime is pausing before its next poll."""

    def __init__(self, on_first_poll=None):
        self.polls = 0
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
                dev.polls += 1
                self._send(200, json.dumps({"id": "run-1", "status": "running"}).encode())
                if dev.polls == 1 and on_first_poll is not None:
                    threading.Timer(0.2, on_first_poll).start()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _profile(url, timeout_s=30.0, interval_s=5.0):
    op = {"request": {"method": "POST", "path": "/runs", "body": {"wavelengthNm": "{wavelengthNm}"}}, "runId": "id",
          "poll": {"path": "/runs/{runId}", "field": "status", "done": ["succeeded"], "failed": ["failed"],
                   "intervalS": interval_s, "timeoutS": timeout_s}}
    return {"url": url, "status": {"path": "/status", "field": "state", "idle": ["idle"]},
            "operations": {"read_absorbance": op}}


def test_no_sleep_hook_can_be_given_to_the_runtime():
    # Ported from #512's tests/test_operating_round5.py (da5cfd19): at e7e6f821 a hook that ignored
    # its argument (lambda _: time.sleep(1.0)) carried a 0.1 s run a second past its deadline.
    slow = lambda _seconds: time.sleep(1.0)  # noqa: E731
    with pytest.raises(TypeError):
        AdapterRuntime.from_profile(_profile("http://127.0.0.1:9"), *_keys(), sleep=slow)
    status = DeviceStatus.from_dict({"path": "/status", "field": "state", "idle": ["idle"]})
    binding = OperationBinding.from_dict("read_absorbance", _profile("http://127.0.0.1:9")["operations"]["read_absorbance"])
    with pytest.raises(TypeError):
        AdapterRuntime("http://127.0.0.1:9", status, {"read_absorbance": binding}, *_keys(), sleep=slow)


@pytest.mark.parametrize("mode", ["cancelled", "lease_lost"])
def test_a_stop_during_the_pause_between_polls_ends_it_within_a_slice(mode):
    claim, box = Claim(), {}

    def stop():
        if mode == "cancelled":
            box["runtime"].cancel()
        else:
            claim.alive = False

    dev = Device(on_first_poll=stop)
    try:
        box["runtime"] = AdapterRuntime.from_profile(_profile(dev.url, interval_s=5.0), *_keys())
        started = time.monotonic()
        result = box["runtime"].run("read_absorbance", {"wavelengthNm": 450}, claim=claim)
        elapsed = time.monotonic() - started
    finally:
        dev.close()
    # The pause would have lasted 5 s; the stop came 0.2 s into it.
    assert result.ok is False and result.error == f"{mode}:device_state_unknown", result
    assert elapsed < 2.0, f"the pause ran {elapsed:.2f} s past a stop 0.2 s into it"
    assert dev.polls == 1
