"""r5 Finding 3: a log timeout takes precedence for failed terminal runs too."""

import json

import pytest

from pcc_node.operating import runtime as runtime_mod
from .test_operating_r5_framing import Claim, Clock, ScriptedSockets, START, make_runtime, wire


@pytest.mark.parametrize("terminal", ["succeeded", "failed"])
def test_terminal_record_survives_optional_log_timeout(monkeypatch, terminal):
    clock = Clock()
    runtime = make_runtime(clock, log=True)
    record = {"id": "r", "status": terminal}
    body = json.dumps(record).encode()
    sockets = ScriptedSockets(
        monkeypatch,
        wire(b"Content-Length: " + str(len(START)).encode() + b"\r\n", START),
        wire(b"Content-Length: " + str(len(body)).encode() + b"\r\n", body),
        wire(b"Content-Length: 100\r\nX-R5-Phase: log\r\n", b"unfinished optional log"),
    )
    real_read = runtime_mod._DeviceHTTPResponse.read1

    def read_then_expire(response, amount=-1):
        piece = real_read(response, amount)
        if response.getheader("X-R5-Phase") == "log":
            clock.now = 31.0  # exactly inside the log read, past the 30 s deadline
        return piece

    monkeypatch.setattr(runtime_mod._DeviceHTTPResponse, "read1", read_then_expire)
    result = runtime.run("measure", {}, claim=Claim())
    assert result.ok is False and result.error == "timeout:run_finished", result
    assert result.output == record
    assert result.evidence is not None and result.evidence["record"] == record
    assert [entry["payload"]["source"] for entry in result.evidence["logChain"]] == ["device:run"]
    assert sockets.requests == ["POST /runs HTTP/1.1", "GET /runs/r HTTP/1.1", "GET /runs/r/log HTTP/1.1"]
