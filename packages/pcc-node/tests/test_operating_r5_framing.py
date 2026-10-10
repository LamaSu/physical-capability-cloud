"""r5 Finding 2: original HTTP framing must prove a whole, unambiguous answer.

Only socket establishment is replaced. The real HTTP client, parser, bounded
reader and run/follow/evidence path consume bytes, on Python 3.9 and 3.12 alike.
"""

import io
import json

import pytest

from pcc_node.operating import runtime as runtime_mod
from pcc_node.operating.runtime import AdapterRuntime

RECORD = b'{"id":"r","status":"succeeded"}'
START = b'{"id":"r"}'
URL = "http://127.0.0.1:8000"


def wire(headers, body=RECORD):
    return b"HTTP/1.1 200 OK\r\n" + headers + b"Connection: close\r\n\r\n" + body


def chunk(body=RECORD, ending=b"\r\n0\r\n\r\n"):
    return f"{len(body):x}\r\n".encode() + body + ending


LENGTH = str(len(RECORD)).encode()
LONG = str(len(RECORD) + 40).encode()
CHUNKED = b"Transfer-Encoding: chunked\r\n"
INVALID = [
    pytest.param(wire(b"Content-Length: " + LONG + b", " + LONG + b"\r\n"), id="comma-length"),
    pytest.param(wire(b"Content-Length: junk\r\n"), id="nonnumeric-length"),
    pytest.param(wire(b"Content-Length: -1\r\n"), id="negative-length"),
    pytest.param(wire(b"Content-Length: +" + LENGTH + b"\r\n"), id="signed-length"),
    pytest.param(wire(b"Content-Length: 3_1\r\n"), id="underscore-length"),
    pytest.param(wire(b"Content-Length:\r\n"), id="empty-length"),
    pytest.param(wire(b"Content-Length: " + b"9" * 5000 + b"\r\n"), id="discarded-huge-length"),
    pytest.param(wire(b"InvalidHeader\r\nContent-Length: " + LONG + b"\r\n"), id="hidden-length-header"),
    pytest.param(wire(b"Content-Length: " + LENGTH + b"\r\r\nContent-Length: " + LONG + b"\r\n"),
                 id="bare-cr-conflicting-lengths"),
    pytest.param(wire(b"Content-Length: " + LENGTH + b"\r\n\rContent-Length: " + LONG + b"\r\n"),
                 id="cr-led-conflicting-length"),
    pytest.param(wire(b"X-A: 1\r\r\nContent-Length: " + LONG + b"\r\n"), id="bare-cr-hidden-only-length"),
    pytest.param(wire(b"Content-Length: " + LENGTH + b"\r\r\n" + CHUNKED),
                 id="bare-cr-hidden-transfer-encoding"),
    pytest.param(wire(b" X-A: 1\r\nContent-Length: " + LENGTH + b"\r\n"),
                 id="first-header-line-continuation"),
    pytest.param(wire(b"Content-Length: " + LENGTH + b"\r\nContent-Length: " + LONG + b"\r\n"),
                 id="conflicting-lengths"),
    pytest.param(wire(b"Content-Length: " + LONG + b"\r\nContent-Length: " + LENGTH + b"\r\n"),
                 id="conflicting-lengths-reversed"),
    pytest.param(wire(b"Content-Length: " + LENGTH + b"\r\nContent-Length: " + LENGTH + b"\r\n"),
                 id="duplicate-identical-lengths"),
    pytest.param(wire(CHUNKED + b"Content-Length: " + LENGTH + b"\r\n", chunk()), id="te-and-cl"),
    pytest.param(wire(b"Transfer-Encoding: chunked \t\r\nContent-Length: 0\r\n", chunk()),
                 id="chunked-ows-and-zero-length"),
    pytest.param(wire(CHUNKED + CHUNKED, chunk()), id="duplicate-transfer-encoding"),
    pytest.param(wire(CHUNKED, chunk()).replace(b"HTTP/1.1", b"HTTP/1.0", 1), id="http-1.0-chunked"),
    pytest.param(wire(b"Transfer-Encoding: gzip\r\n"), id="unsupported-transfer-encoding"),
    pytest.param(wire(b"Transfer-Encoding: identity\r\n", chunk()), id="identity-with-chunked-body"),
    pytest.param(wire(b"Transfer-Encoding: gzip, chunked\r\n"), id="multiple-transfer-encodings"),
    pytest.param(wire(b"Transfer-Encoding: chunked \t\r\n"), id="chunked-ows-unencoded-body"),
    pytest.param(wire(CHUNKED, b"0x1f\r\n" + RECORD + b"\r\n0\r\n\r\n"), id="0x-chunk-size"),
    pytest.param(wire(CHUNKED, b"+1f\r\n" + RECORD + b"\r\n0\r\n\r\n"), id="plus-chunk-size"),
    pytest.param(wire(CHUNKED, b" 1f\r\n" + RECORD + b"\r\n0\r\n\r\n"), id="space-chunk-size"),
    pytest.param(wire(CHUNKED, b"1_f\r\n" + RECORD + b"\r\n0\r\n\r\n"), id="underscore-chunk-size"),
    pytest.param(wire(CHUNKED, chunk(ending=b"\r\n0")), id="unterminated-zero-line"),
    pytest.param(wire(CHUNKED, chunk(ending=b"\r\n0\r\n")), id="missing-trailer-terminator"),
    pytest.param(wire(CHUNKED, chunk(ending=b"\r\n0\r\nX-Note: yes\r\n")), id="trailer-eof"),
    pytest.param(wire(CHUNKED, chunk(ending=b"\r\n0\r\n" + b"X-T: 1\r\n" * 101 + b"\r\n")),
                 id="101-trailer-lines"),
    pytest.param(wire(CHUNKED, chunk(ending=b"\r\n0\n\n")), id="lf-zero-line"),
    pytest.param(wire(CHUNKED, chunk(ending=b"\r\n0\n\r\n")), id="lf-zero-line-then-crlf"),
    pytest.param(wire(CHUNKED, chunk(ending=b"\r\n0\r\n\n")), id="lf-trailer-terminator"),
    pytest.param(wire(CHUNKED, chunk(ending=b"ZZ0\r\n\r\n")), id="bad-data-chunk-terminator"),
    pytest.param(wire(b"Content-Length: " + LONG + b"\r\n"), id="ordinary-truncation-control"),
    pytest.param(wire(CHUNKED, b"40\r\n" + RECORD), id="truncated-chunk-control"),
]
VALID = [
    pytest.param(wire(b"Content-Length: " + LENGTH + b"\r\n"), id="single-length"),
    pytest.param(wire(b"Content-Length: \t" + LENGTH + b" \t\r\n"), id="length-ows"),
    pytest.param(wire(b""), id="close-delimited"),
    pytest.param(wire(CHUNKED, chunk()), id="chunked"),
    pytest.param(wire(b"Transfer-Encoding: CHUNKED\r\n", chunk()), id="chunked-case"),
    pytest.param(wire(b"Transfer-Encoding: chunked \t\r\n", chunk()), id="chunked-ows"),
    pytest.param(wire(CHUNKED, chunk(ending=b"\r\n0\r\nX-Note: yes\r\n\r\n")), id="chunked-trailer"),
    pytest.param(wire(CHUNKED, chunk(ending=b"\r\n0\r\n" + b"X-T: 1\r\n" * 100 + b"\r\n")),
                 id="100-trailer-lines"),
]


class ScriptedSockets:
    """In-memory socket interface; HTTPConnection and HTTPResponse stay real."""

    def __init__(self, monkeypatch, *responses):
        self.responses = list(responses)
        self.requests = []
        script = self

        class Socket:
            def __init__(self, raw):
                self.raw = raw

            def makefile(self, *args):
                return io.BytesIO(self.raw)

            def sendall(self, data):
                if data.startswith((b"GET ", b"POST ")):
                    script.requests.append(data.split(b"\r\n", 1)[0].decode())

            def settimeout(self, seconds):
                pass

            def shutdown(self, how):
                pass

            def close(self):
                pass

        def connect(*args):
            assert script.responses, "unexpected extra device request"
            return Socket(script.responses.pop(0))

        monkeypatch.setattr(runtime_mod, "_connect", connect)


@pytest.mark.parametrize("response", INVALID)
def test_invalid_framing_has_no_accepted_body(monkeypatch, response):
    sockets = ScriptedSockets(monkeypatch, response)
    answer = runtime_mod._request("GET", URL + "/runs/r", deadline=30, clock=lambda: 0)
    assert answer.sent is True and answer.status == 200
    assert answer.body is None, answer
    assert sockets.requests == ["GET /runs/r HTTP/1.1"]


class Clock:
    now = 0.0

    def __call__(self):
        return self.now


class Claim:
    job_id, kernel_id, claim_token = "job-r5", "kernel-r5", "token-r5"

    def lease_alive(self):
        return True


def profile(log=False):
    operation = {
        "request": {"method": "POST", "path": "/runs", "body": {}},
        "runId": "id",
        "poll": {"path": "/runs/{runId}", "field": "status", "done": ["succeeded"],
                 "failed": ["failed"], "intervalS": 0.05, "timeoutS": 30},
    }
    if log:
        operation["log"] = {"path": "/runs/{runId}/log"}
    return {"url": URL, "status": {"path": "/status", "field": "state", "idle": ["idle"]},
            "operations": {"measure": operation}}


def make_runtime(clock, log=False):
    signing = pytest.importorskip("nacl.signing")
    key = signing.SigningKey.generate()
    return AdapterRuntime.from_profile(profile(log), key.verify_key.encode().hex(),
                                       key.encode().hex(), clock=clock)


@pytest.mark.parametrize("response", INVALID)
@pytest.mark.parametrize("phase", ["start", "terminal"])
def test_invalid_framing_never_finishes_a_run(monkeypatch, response, phase):
    clock = Clock()
    runtime = make_runtime(clock)
    first = wire(b"Content-Length: " + str(len(START)).encode() + b"\r\n", START)
    sockets = ScriptedSockets(monkeypatch, *([first, response] if phase == "terminal" else [response]))

    def expire_between_polls(*args):
        clock.now = 31.0

    monkeypatch.setattr(runtime, "_wait", expire_between_polls)
    result = runtime.run("measure", {}, claim=Claim())
    assert result.ok is False, result
    if phase == "terminal":
        assert result.error == "timeout:device_state_unknown", result
        assert result.output == {"id": "r"}
        assert result.evidence["record"] == {"id": "r"}
        assert sockets.requests == ["POST /runs HTTP/1.1", "GET /runs/r HTTP/1.1"]
    else:
        assert result.error == "no_run_id:device_state_unknown", result
        assert result.evidence is None
        assert sockets.requests == ["POST /runs HTTP/1.1"]


@pytest.mark.parametrize("response", VALID)
def test_complete_unambiguous_framing_succeeds(monkeypatch, response):
    runtime = make_runtime(Clock())
    monkeypatch.setattr(runtime, "_wait", lambda *args: pytest.fail("a complete terminal answer should finish"))
    first = wire(b"Content-Length: " + str(len(START)).encode() + b"\r\n", START)
    sockets = ScriptedSockets(monkeypatch, first, response)
    result = runtime.run("measure", {}, claim=Claim())
    assert result.ok is True and result.error is None, result
    assert result.output == json.loads(RECORD)
    assert result.evidence["record"] == json.loads(RECORD)
    assert sockets.requests == ["POST /runs HTTP/1.1", "GET /runs/r HTTP/1.1"]
