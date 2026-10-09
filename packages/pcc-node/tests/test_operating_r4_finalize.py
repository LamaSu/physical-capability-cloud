"""ChatGPT r3 finding 3 (MEDIUM, pcc-node 0.1.1 r4): the runtime never returns success after a
timeout, a cancel or a lost lease, and never takes an answer that did not arrive whole for a record.

At e7e6f821:
- a deadline that ran out during the optional log fetch was logged and dropped, and the run
  reported success. #512's da5cfd19 made it ``timeout:run_finished`` (ported here, with its test);
- nothing re-checked control between the device's terminal answer and the success return, so a
  cancel, a lost lease or the deadline that landed while that answer was decoded or the evidence
  was built still returned ok=True. #512's 621bcc42 re-checks at the success gate (ported here,
  with its test_operating_round6.py cases);
- _read_bounded() took an empty read for the end of the answer without asking the watch, so a
  socket the watch shut on a stop read as the device's own end of the answer; and an answer that
  ended before its Content-Length was accepted as whole. Now the watch is checked after every read,
  EOF included, and an answer short of its Content-Length is incomplete (no body), never a record.

Each stop here lands at one exact point (inside the reader's next read, the terminal decode, the
evidence build), and the deadline cases move an injected clock, so no case depends on the machine's
speed. The log-fetch case is the one real-time case: a 2 s stall against a 0.5 s deadline.
"""

import http.client
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

nacl_signing = pytest.importorskip("nacl.signing")

from pcc_node.operating import runtime as runtime_mod
from pcc_node.operating.runtime import AdapterRuntime

KERNEL = "kernel_bench"
RECORD = json.dumps({"id": "run-1", "status": "succeeded"}).encode()
STOPS = ["timeout", "cancelled", "lease_lost"]


def _keys():
    sk = nacl_signing.SigningKey.generate()
    return sk.verify_key.encode().hex(), sk.encode().hex()


class Claim:
    def __init__(self):
        self.job_id, self.kernel_id, self.claim_token = "j-1", KERNEL, "tok-j-1"
        self.alive = True

    def lease_alive(self):
        return self.alive


class Clock:
    """An injected monotonic clock: the deadline passes only when a test moves it."""

    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def _lose(mode, runtime, claim, clock):
    """Lose control of the run: the deadline passes, the run is cancelled, or the lease is lost."""
    if mode == "timeout":
        clock.now += 3600.0
    elif mode == "cancelled":
        runtime.cancel()
    else:
        claim.alive = False


class Device:
    """A generic-HTTP device: POST /runs starts run-1, GET /runs/run-1 answers with a terminal record,
    GET /runs/run-1/log answers with a log. Requests are recorded as (method, path).

    How the record is framed (``poll``): "whole" (its Content-Length), "short" (a Content-Length it
    never reaches, then the device closes), "unframed" (no Content-Length; the device closes after
    it), "unframed-hold" (no Content-Length; the device sends it and holds the connection open),
    "chunk-cut" (chunked; the connection closes inside the chunk). The start answer is "whole" or
    "short" (``start``). The log answers after ``log_hold_s``, if given.
    """

    def __init__(self, poll="whole", start="whole", log_hold_s=None):
        self.requests = []
        self.release = threading.Event()
        dev = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _head(self, code, length=None, chunked=False):
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                if length is not None:
                    self.send_header("Content-Length", str(length))
                if chunked:
                    self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()

            def _write(self, raw):
                try:
                    self.wfile.write(raw)
                    self.wfile.flush()
                except OSError:
                    pass  # the node shut its side of the connection

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                dev.requests.append(("POST", self.path))
                raw = b'{"id": "run-1"}'
                self._head(201, len(raw) + (40 if start == "short" else 0))
                self._write(raw)

            def do_GET(self):
                dev.requests.append(("GET", self.path))
                if self.path.endswith("/log"):
                    if log_hold_s:
                        dev.release.wait(log_hold_s)
                    self._head(200, len(b"read complete"))
                    return self._write(b"read complete")
                if poll == "whole":
                    self._head(200, len(RECORD))
                    self._write(RECORD)
                elif poll == "short":
                    self._head(200, len(RECORD) + 40)
                    self._write(RECORD)
                elif poll == "unframed":
                    self._head(200)
                    self._write(RECORD)
                elif poll == "unframed-hold":
                    self._head(200)
                    self._write(RECORD)
                    dev.release.wait(10)
                elif poll == "chunk-cut":
                    self._head(200, chunked=True)
                    self._write(b"%x\r\n" % (len(RECORD) + 40) + RECORD)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def gets(self):
        return [path for method, path in self.requests if method == "GET"]

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


def _profile(url, timeout_s=30.0, log=False):
    op = {"request": {"method": "POST", "path": "/runs", "body": {"wavelengthNm": "{wavelengthNm}"}}, "runId": "id",
          "poll": {"path": "/runs/{runId}", "field": "status", "done": ["succeeded"], "failed": ["failed"],
                   "intervalS": 0.05, "timeoutS": timeout_s}}
    if log:
        op["log"] = {"path": "/runs/{runId}/log"}
    return {"url": url, "status": {"path": "/status", "field": "state", "idle": ["idle"]},
            "operations": {"read_absorbance": op}}


def _run(runtime, claim=None):
    return runtime.run("read_absorbance", {"wavelengthNm": 450}, claim=claim or Claim())


# ── Framing: an answer that did not arrive whole is no record ────────────────

def test_a_terminal_answer_short_of_its_content_length_is_never_a_success():
    dev = Device(poll="short")
    try:
        result = _run(AdapterRuntime.from_profile(_profile(dev.url, timeout_s=0.5), *_keys()))
    finally:
        dev.close()
    # At e7e6f821 the 38 bytes of a promised 78 were the record, and the run succeeded. Now the cut
    # answer is no answer: the runtime kept polling until the deadline.
    assert result.ok is False and result.error == "timeout:device_state_unknown", result
    assert len(dev.gets()) >= 2


def test_a_start_answer_short_of_its_content_length_is_never_followed():
    dev = Device(start="short")
    try:
        result = _run(AdapterRuntime.from_profile(_profile(dev.url), *_keys()))
    finally:
        dev.close()
    assert result.ok is False and result.error == "no_run_id:device_state_unknown", result
    assert dev.gets() == []


def test_an_answer_the_device_ends_without_a_content_length_is_still_whole():
    # Control: without a Content-Length, the device closing the connection ends the answer.
    dev = Device(poll="unframed")
    try:
        result = _run(AdapterRuntime.from_profile(_profile(dev.url), *_keys()))
    finally:
        dev.close()
    assert result.ok is True and result.error is None, result


def test_a_chunked_answer_cut_inside_a_chunk_is_never_a_success():
    # Control: http.client already refuses a chunk the connection cut short.
    dev = Device(poll="chunk-cut")
    try:
        result = _run(AdapterRuntime.from_profile(_profile(dev.url, timeout_s=0.5), *_keys()))
    finally:
        dev.close()
    assert result.ok is False and result.error == "timeout:device_state_unknown", result


# ── A stop that shuts the socket is not the device's end of the answer ───────

def _lose_when_the_reader_waits_again(monkeypatch, lose):
    """Lose control at one exact point: the reader holds a whole-looking terminal record and calls
    read1 again to wait for the device's end of the answer. That is after its check before the read,
    and before the read the watch ends by shutting the socket, so only a check after it can see the stop."""
    original = http.client.HTTPResponse.read1

    def read1(self, n=-1):
        if getattr(self, "_test_holds_the_record", False):
            lose()
        data = original(self, n)
        if data.endswith(b'"succeeded"}'):
            self._test_holds_the_record = True
        return data

    monkeypatch.setattr(http.client.HTTPResponse, "read1", read1)


@pytest.mark.parametrize("mode", STOPS)
def test_a_stop_that_shuts_the_socket_is_not_the_end_of_the_answer(mode, monkeypatch):
    clock, claim, box = Clock(), Claim(), {}
    # The device sends a whole-looking terminal record with no Content-Length and holds the
    # connection open. Control is lost while the reader waits for more; the watch shuts the socket,
    # and that read returns empty, as a device ending its answer would.
    _lose_when_the_reader_waits_again(monkeypatch, lambda: _lose(mode, box["runtime"], claim, clock))
    dev = Device(poll="unframed-hold")
    try:
        box["runtime"] = AdapterRuntime.from_profile(_profile(dev.url), *_keys(), clock=clock)
        started = time.monotonic()
        result = _run(box["runtime"], claim)
        elapsed = time.monotonic() - started
    finally:
        dev.close()
    # At e7e6f821 that empty read ended the answer, and the run succeeded. The answer's end was the
    # node's own shutdown, so the record may be cut: the device's state is unknown, not run_finished.
    assert result.ok is False and result.error == f"{mode}:device_state_unknown", result
    assert dev.gets() == ["/runs/run-1"]
    assert elapsed < 5


# ── The log fetch (#512 da5cfd19) ────────────────────────────────────────────

def test_a_deadline_that_runs_out_during_the_log_fetch_is_not_success():
    # Ported from #512's tests/test_operating_round5.py (da5cfd19): a successful terminal poll, then
    # an optional log that stalls past the deadline.
    dev = Device(poll="whole", log_hold_s=2.0)
    try:
        result = _run(AdapterRuntime.from_profile(_profile(dev.url, timeout_s=0.5, log=True), *_keys()))
    finally:
        dev.close()
    assert result.ok is False and result.error == "timeout:run_finished", result
    assert result.evidence is not None  # the finished run's record is still evidence


# ── The success gate (#512 621bcc42) ────────────────────────────────────────

class _JsonShim:
    """runtime's json, but a callback fires the instant a terminal answer is decoded (ported from #512's
    tests/test_operating_round6.py): the decode runs after the request's watch is closed."""

    def __init__(self, on_terminal):
        self._on = on_terminal

    def loads(self, s):
        obj = json.loads(s)
        if isinstance(obj, dict) and obj.get("status") == "succeeded":
            self._on()
        return obj

    def dumps(self, *args, **kwargs):
        return json.dumps(*args, **kwargs)


@pytest.mark.parametrize("mode", STOPS)
def test_control_lost_while_the_terminal_answer_is_decoded_is_not_success(mode, monkeypatch):
    # Ported from #512's test_operating_round6.py (621bcc42); its timeout case slept 0.6 s past a 0.3 s
    # deadline, and this one moves the injected clock instead.
    dev = Device(poll="whole")
    clock, claim, box = Clock(), Claim(), {}
    try:
        box["runtime"] = AdapterRuntime.from_profile(_profile(dev.url), *_keys(), clock=clock)
        monkeypatch.setattr(runtime_mod, "json", _JsonShim(lambda: _lose(mode, box["runtime"], claim, clock)))
        result = _run(box["runtime"], claim)
    finally:
        dev.close()
    assert result.ok is False and result.error == f"{mode}:run_finished", result
    assert result.evidence is not None  # the finished run's record is still evidence


@pytest.mark.parametrize("mode", STOPS)
def test_control_lost_while_the_evidence_is_built_is_not_success(mode):
    dev = Device(poll="whole")
    clock, claim = Clock(), Claim()
    try:
        runtime = AdapterRuntime.from_profile(_profile(dev.url), *_keys(), clock=clock)
        build = runtime._evidence

        def build_while_control_is_lost(*args):
            _lose(mode, runtime, claim, clock)
            return build(*args)

        runtime._evidence = build_while_control_is_lost
        result = _run(runtime, claim)
    finally:
        dev.close()
    assert result.ok is False and result.error == f"{mode}:run_finished", result
    assert result.evidence is not None and result.evidence["runId"] == "run-1"


def test_an_unobstructed_run_still_succeeds():
    # Ported from #512's test_operating_round6.py: the gate must not refuse a run that kept control.
    dev = Device(poll="whole")
    try:
        result = _run(AdapterRuntime.from_profile(_profile(dev.url), *_keys()))
    finally:
        dev.close()
    assert result.ok is True and result.error is None, result
    assert result.evidence is not None
