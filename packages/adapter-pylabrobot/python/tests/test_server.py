"""End-to-end Server tests — drives the full JSON-RPC round trip in-process."""

from __future__ import annotations
import asyncio
import json
import io

import pytest

from pcc_plr_sidecar.server import Server
from pcc_plr_sidecar.dispatcher import RPC_ERROR_CODES


class CapturingStdout:
    """A minimal stdout substitute that captures written lines."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def write(self, s: str) -> None:
        # asyncio Server writes one line at a time including the newline
        for piece in s.split("\n"):
            if piece:
                self.lines.append(piece)

    def flush(self) -> None:
        pass

    def pop_messages(self) -> list[dict]:
        msgs = [json.loads(l) for l in self.lines]
        self.lines.clear()
        return msgs


@pytest.fixture
async def server():
    out = CapturingStdout()
    s = Server(stdout=out)
    return s, out


@pytest.mark.asyncio
async def test_handle_line_dispatches_health_ping(server):
    s, out = server
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "1", "method": "health.ping", "params": {},
    }))
    msgs = out.pop_messages()
    assert len(msgs) == 1
    assert msgs[0]["id"] == "1"
    assert msgs[0]["result"]["ok"] is True
    assert msgs[0]["result"]["devices"] == []


@pytest.mark.asyncio
async def test_handle_line_invalid_json_returns_parse_error(server):
    s, out = server
    await s.handle_line("not-json")
    msgs = out.pop_messages()
    assert msgs[0]["error"]["code"] == RPC_ERROR_CODES["PARSE_ERROR"]


@pytest.mark.asyncio
async def test_handle_line_unknown_method_returns_method_not_found(server):
    s, out = server
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "2", "method": "does.not.exist", "params": {},
    }))
    msgs = out.pop_messages()
    assert msgs[0]["error"]["code"] == RPC_ERROR_CODES["METHOD_NOT_FOUND"]


@pytest.mark.asyncio
async def test_handle_line_notification_no_response(server):
    s, out = server
    # No id field — server should not respond
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "method": "health.ping", "params": {},
    }))
    msgs = out.pop_messages()
    assert msgs == []


@pytest.mark.asyncio
async def test_backend_init_run_status_shutdown_round_trip(server):
    s, out = server
    # init
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "1", "method": "backend.init",
        "params": {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {"deckSlots": 11}},
    }))
    msgs = out.pop_messages()
    assert msgs[0]["result"]["ok"] is True
    assert msgs[0]["result"]["plrBackend"] == "stub"
    assert "deckSlots" in str(msgs[0]["result"]["metadata"])

    # start recording, run
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "2", "method": "evidence.startRecording",
        "params": {"deviceId": "dev-1", "jobId": "job-1"},
    }))
    out.pop_messages()

    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "3", "method": "backend.run",
        "params": {
            "deviceId": "dev-1",
            "jobId": "job-1",
            "protocolSource": "inline-ops",
            "protocolInline": [
                {"op": "pickUpTips", "channel": 0},
                {"op": "aspirate", "well": "A1", "volume_uL": 100},
                {"op": "dispense", "well": "B1", "volume_uL": 100},
                {"op": "dropTips", "channel": 0},
            ],
        },
    }))
    # Allow the in-flight emit_atomic_op tasks to run
    await asyncio.sleep(0.05)
    msgs = out.pop_messages()
    # The 4 evidence notifications + the run response
    evidence = [m for m in msgs if m.get("method") == "evidence"]
    response = [m for m in msgs if m.get("id") == "3"]
    assert len(evidence) == 4
    assert response[0]["result"]["ok"] is True
    assert response[0]["result"]["opCount"] == 4

    # status (post-run, should be idle)
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "4", "method": "backend.status",
        "params": {"deviceId": "dev-1"},
    }))
    msgs = out.pop_messages()
    assert msgs[0]["result"]["status"] == "idle"

    # stop recording
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "5", "method": "evidence.stopRecording",
        "params": {"deviceId": "dev-1", "jobId": "job-1"},
    }))
    msgs = out.pop_messages()
    assert msgs[0]["result"]["opCount"] == 4

    # shutdown
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "6", "method": "backend.shutdown",
        "params": {"deviceId": "dev-1"},
    }))
    msgs = out.pop_messages()
    assert msgs[0]["result"]["ok"] is True


@pytest.mark.asyncio
async def test_backend_init_with_invalid_params_returns_INVALID_PARAMS(server):
    s, out = server
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "1", "method": "backend.init",
        "params": {"plrBackend": "stub"},  # missing deviceId
    }))
    msgs = out.pop_messages()
    assert msgs[0]["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]


@pytest.mark.asyncio
async def test_backend_init_with_unknown_backend_returns_INVALID_PARAMS(server):
    s, out = server
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "1", "method": "backend.init",
        "params": {"deviceId": "dev-1", "plrBackend": "does-not-exist", "backendConfig": {}},
    }))
    msgs = out.pop_messages()
    assert msgs[0]["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]


@pytest.mark.asyncio
async def test_backend_status_with_no_device_returns_offline(server):
    s, out = server
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "1", "method": "backend.status",
        "params": {"deviceId": "never-loaded"},
    }))
    msgs = out.pop_messages()
    assert msgs[0]["result"]["status"] == "offline"


@pytest.mark.asyncio
async def test_backend_abort_unsupported_returns_NOT_SUPPORTED(server):
    s, out = server
    # Stub machine doesn't expose abort or stop returning unsupported; the
    # stub *does* have stop(), so this test mutates that.
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "1", "method": "backend.init",
        "params": {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}},
    }))
    out.pop_messages()
    handle = s.loader.get("dev-1")
    # Remove the stop/abort methods on the underlying machine to simulate
    # a backend (like Hamilton STAR via firmware) that doesn't support abort.
    if hasattr(handle.machine, "stop"):
        delattr(type(handle.machine), "stop")
    if hasattr(handle.machine, "abort"):
        delattr(handle.machine, "abort")
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "2", "method": "backend.abort",
        "params": {"deviceId": "dev-1"},
    }))
    msgs = out.pop_messages()
    assert msgs[0]["error"]["code"] == RPC_ERROR_CODES["NOT_SUPPORTED"]


@pytest.mark.asyncio
async def test_calibrate_unsupported_returns_NOT_SUPPORTED(server):
    s, out = server
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "1", "method": "backend.init",
        "params": {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}},
    }))
    out.pop_messages()
    # The stub doesn't expose calibrate
    await s.handle_line(json.dumps({
        "jsonrpc": "2.0", "id": "2", "method": "backend.calibrate",
        "params": {"deviceId": "dev-1", "kind": "deck"},
    }))
    msgs = out.pop_messages()
    assert msgs[0]["error"]["code"] == RPC_ERROR_CODES["NOT_SUPPORTED"]
