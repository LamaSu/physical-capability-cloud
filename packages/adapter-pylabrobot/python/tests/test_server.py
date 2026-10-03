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


def _line_names(msgs: list[dict]) -> list[str]:
    """A response by its id, a notification by its evidence type."""
    return [m["id"] if "id" in m else m["params"]["type"] for m in msgs]


def test_stop_recording_answers_only_after_every_notification_scheduled_before_it():
    """astra pack 186 (HIGH): notifications are written by detached tasks. Without a barrier
    the answer to evidence.stopRecording can precede the job's own notifications, which then
    reach the TS adapter after its quiesceEvidence() has resolved. A plain test (asyncio.run),
    so it runs without pytest-asyncio."""

    async def scenario() -> tuple[list[str], list[str]]:
        out = CapturingStdout()
        s = Server(stdout=out)
        await s.handle_line(json.dumps({"jsonrpc": "2.0", "id": "1", "method": "backend.init", "params": {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}}}))
        await s.handle_line(json.dumps({"jsonrpc": "2.0", "id": "2", "method": "evidence.startRecording", "params": {"deviceId": "dev-1", "jobId": "job-1"}}))
        await s.handle_line(json.dumps({"jsonrpc": "2.0", "id": "3", "method": "backend.run", "params": {
            "deviceId": "dev-1", "jobId": "job-1", "protocolSource": "inline-ops",
            "protocolInline": [{"op": "aspirate", "well": "A1"}, {"op": "dispense", "well": "B1"}],
        }}))
        # The TS adapter stops the recording as soon as the run has answered.
        await s.handle_line(json.dumps({"jsonrpc": "2.0", "id": "4", "method": "evidence.stopRecording", "params": {"deviceId": "dev-1", "jobId": "job-1"}}))
        by_answer = _line_names(out.pop_messages())
        await asyncio.sleep(0.05)
        after = _line_names(out.pop_messages())
        return by_answer, after

    by_answer, after = asyncio.run(scenario())
    assert after == [], f"written after evidence.stopRecording answered: {after} (lines until then: {by_answer})"
    assert by_answer.index("4") > by_answer.index("aspirate")
    assert by_answer.index("4") > by_answer.index("dispense")


# ── recording windows are attested (astra pack 194) ─────────────────────────


async def _call(s: Server, out: CapturingStdout, id_: str, method: str, params: dict) -> dict:
    await s.handle_line(json.dumps({"jsonrpc": "2.0", "id": id_, "method": method, "params": params}))
    await asyncio.sleep(0)
    msgs = [m for m in out.pop_messages() if m.get("id") == id_]
    return msgs[0]


def test_a_window_is_attested_with_this_process_generation_on_open_and_close():
    async def scenario():
        out = CapturingStdout()
        s = Server(stdout=out)
        init = await _call(s, out, "1", "backend.init", {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}})
        opened = await _call(s, out, "2", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-1"})
        closed = await _call(s, out, "3", "evidence.stopRecording", {"deviceId": "dev-1", "jobId": "job-1"})
        again = await _call(s, out, "4", "evidence.stopRecording", {"deviceId": "dev-1", "jobId": "job-1"})
        return init, opened, closed, again

    init, opened, closed, again = asyncio.run(scenario())
    gen = init["result"]["generation"]
    assert isinstance(gen, str) and len(gen) >= 16
    assert opened["result"]["generation"] == gen and opened["result"]["jobId"] == "job-1"
    assert closed["result"] == {"ok": True, "jobId": "job-1", "opCount": 0, "notified": 0, "failedWrites": 0, "generation": gen}
    # A retried close of the same window answers as the first did.
    assert again["result"] == closed["result"]


def test_closing_a_window_this_process_never_opened_is_refused_with_its_generation():
    async def scenario():
        out = CapturingStdout()
        s = Server(stdout=out)
        await _call(s, out, "1", "backend.init", {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}})
        return await _call(s, out, "2", "evidence.stopRecording", {"deviceId": "dev-1", "jobId": "job-x"}), s.evidence.generation

    answer, gen = asyncio.run(scenario())
    assert answer["error"]["code"] == RPC_ERROR_CODES["NO_RECORDING_WINDOW"]
    assert answer["error"]["data"]["generation"] == gen


def test_closing_another_jobs_window_is_refused_and_leaves_it_open():
    async def scenario():
        out = CapturingStdout()
        s = Server(stdout=out)
        await _call(s, out, "1", "backend.init", {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}})
        await _call(s, out, "2", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-A"})
        answer = await _call(s, out, "3", "evidence.stopRecording", {"deviceId": "dev-1", "jobId": "job-B"})
        return answer, s.evidence.get_window("dev-1")

    answer, window = asyncio.run(scenario())
    assert answer["error"]["code"] == RPC_ERROR_CODES["NO_RECORDING_WINDOW"]
    assert window is not None and window.job_id == "job-A"


def test_a_run_without_its_own_window_is_refused():
    async def scenario():
        out = CapturingStdout()
        s = Server(stdout=out)
        await _call(s, out, "1", "backend.init", {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}})
        ops = [{"op": "aspirate", "well": "A1"}]
        none = await _call(s, out, "2", "backend.run", {"deviceId": "dev-1", "jobId": "job-1", "protocolSource": "inline-ops", "protocolInline": ops})
        await _call(s, out, "3", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-A"})
        other = await _call(s, out, "4", "backend.run", {"deviceId": "dev-1", "jobId": "job-B", "protocolSource": "inline-ops", "protocolInline": ops})
        await asyncio.sleep(0.05)
        return none, other, out.pop_messages()

    none, other, later = asyncio.run(scenario())
    assert none["error"]["code"] == RPC_ERROR_CODES["NO_RECORDING_WINDOW"]
    assert other["error"]["code"] == RPC_ERROR_CODES["NO_RECORDING_WINDOW"]
    assert [m for m in later if m.get("method") == "evidence"] == []


def test_a_restarted_sidecar_attests_nothing_of_the_old_job():
    async def scenario():
        out = CapturingStdout()
        first = Server(stdout=out)
        await _call(first, out, "1", "backend.init", {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}})
        await _call(first, out, "2", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-1"})
        restarted = Server(stdout=out)
        await _call(restarted, out, "3", "backend.init", {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}})
        answer = await _call(restarted, out, "4", "evidence.stopRecording", {"deviceId": "dev-1", "jobId": "job-1"})
        return first.evidence.generation, restarted.evidence.generation, answer

    old_gen, new_gen, answer = asyncio.run(scenario())
    assert old_gen != new_gen
    assert answer["error"]["code"] == RPC_ERROR_CODES["NO_RECORDING_WINDOW"]
    assert answer["error"]["data"]["generation"] == new_gen


# ── one run per device (astra pack 473 (a)) ──────────────────────────────────


def test_a_second_jobs_window_is_refused_while_one_is_open_and_the_open_job_keeps_its_ops():
    """A device has one recording window. Opening another job's while one is open used to replace
    it: the first job's later ops were bound to the second job, and its barrier found no window."""

    async def scenario():
        out = CapturingStdout()
        s = Server(stdout=out)
        await _call(s, out, "1", "backend.init", {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}})
        await _call(s, out, "2", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-A"})
        second = await _call(s, out, "3", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-B"})
        ops = [{"op": "aspirate", "well": "A1"}]
        await s.handle_line(json.dumps({"jsonrpc": "2.0", "id": "4", "method": "backend.run", "params": {"deviceId": "dev-1", "jobId": "job-A", "protocolSource": "inline-ops", "protocolInline": ops}}))
        await asyncio.sleep(0.05)
        notes = [m["params"] for m in out.pop_messages() if m.get("method") == "evidence"]
        closed = await _call(s, out, "5", "evidence.stopRecording", {"deviceId": "dev-1", "jobId": "job-A"})
        return second, notes, closed

    second, notes, closed = asyncio.run(scenario())
    assert second["error"]["code"] == RPC_ERROR_CODES["DEVICE_BUSY"]
    assert second["error"]["data"]["jobId"] == "job-A"
    assert [(n["type"], n["jobId"]) for n in notes] == [("aspirate", "job-A")]
    assert closed["result"]["jobId"] == "job-A" and closed["result"]["opCount"] == 1


def test_opening_the_same_jobs_window_again_answers_with_that_window():
    async def scenario():
        out = CapturingStdout()
        s = Server(stdout=out)
        await _call(s, out, "1", "backend.init", {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}})
        first = await _call(s, out, "2", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-A"})
        await asyncio.sleep(0.01)
        again = await _call(s, out, "3", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-A"})
        return first, again

    first, again = asyncio.run(scenario())
    assert again["result"] == first["result"]


def test_a_run_while_another_run_is_in_flight_on_the_device_is_refused():
    """Nothing serialized runs on a device: a second backend.run while one was in flight ran
    at the same time, on the same machine."""

    async def scenario():
        out = CapturingStdout()
        s = Server(stdout=out)
        await _call(s, out, "1", "backend.init", {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}})
        await _call(s, out, "2", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-A"})
        slow = [{"__delay_ms": 200}, {"op": "aspirate", "well": "A1"}]
        first = asyncio.ensure_future(s.handle_line(json.dumps({"jsonrpc": "2.0", "id": "3", "method": "backend.run", "params": {"deviceId": "dev-1", "jobId": "job-A", "protocolSource": "inline-ops", "protocolInline": slow}})))
        await asyncio.sleep(0.05)
        second = await _call(s, out, "4", "backend.run", {"deviceId": "dev-1", "jobId": "job-A", "protocolSource": "inline-ops", "protocolInline": [{"op": "dispense", "well": "B1"}]})
        await first
        await asyncio.sleep(0.05)
        rest = out.pop_messages()
        after = await _call(s, out, "5", "backend.run", {"deviceId": "dev-1", "jobId": "job-A", "protocolSource": "inline-ops", "protocolInline": [{"op": "mix", "well": "C1"}]})
        return second, rest, after

    second, rest, after = asyncio.run(scenario())
    assert second["error"]["code"] == RPC_ERROR_CODES["DEVICE_BUSY"]
    assert [m["params"]["type"] for m in rest if m.get("method") == "evidence"] == ["aspirate"]
    assert [m["result"]["ok"] for m in rest if m.get("id") == "3"] == [True]
    assert after["result"]["ok"] is True


def test_a_running_jobs_window_cannot_be_closed_until_its_run_ends():
    """astra pack 204 (HIGH): a client-side run timeout leaves the sidecar's run going. Its window
    was closed while it ran, so a second job's window could open, and the first run's later ops
    were bound to the second job. While the device runs, closing its window is refused, and the
    first run's ops stay its own."""

    async def scenario():
        out = CapturingStdout()
        s = Server(stdout=out)
        await _call(s, out, "1", "backend.init", {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}})
        await _call(s, out, "2", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-A"})
        slow = [{"__delay_ms": 100}, {"op": "aspirate", "well": "A1"}]
        run_a = asyncio.ensure_future(s.handle_line(json.dumps({"jsonrpc": "2.0", "id": "3", "method": "backend.run", "params": {"deviceId": "dev-1", "jobId": "job-A", "protocolSource": "inline-ops", "protocolInline": slow}})))
        await asyncio.sleep(0.02)
        close_a = await _call(s, out, "4", "evidence.stopRecording", {"deviceId": "dev-1", "jobId": "job-A"})
        open_b = await _call(s, out, "5", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-B"})
        await run_a
        await asyncio.sleep(0.05)
        notes = [m["params"] for m in out.pop_messages() if m.get("method") == "evidence"]
        close_a_after = await _call(s, out, "6", "evidence.stopRecording", {"deviceId": "dev-1", "jobId": "job-A"})
        return close_a, open_b, notes, close_a_after

    close_a, open_b, notes, close_a_after = asyncio.run(scenario())
    assert close_a["error"]["code"] == RPC_ERROR_CODES["DEVICE_BUSY"], f"closing job A's window while it runs: {close_a}"
    assert open_b["error"]["code"] == RPC_ERROR_CODES["DEVICE_BUSY"], f"job B's window while job A's is open: {open_b}"
    assert [(n["type"], n["jobId"]) for n in notes] == [("aspirate", "job-A")]
    assert close_a_after["result"]["jobId"] == "job-A" and close_a_after["result"]["opCount"] == 1


# ── the barrier attests what it sent (refvertical #5668) ────────────────────


class FlakyStdout(CapturingStdout):
    """Captures lines; the first write of a notification of `fail_type` raises."""

    def __init__(self, fail_type: str) -> None:
        super().__init__()
        self.fail_type = fail_type
        self.failed = 0

    def write(self, s: str) -> None:
        for piece in s.split("\n"):
            if piece and self.failed == 0 and json.loads(piece).get("params", {}).get("type") == self.fail_type:
                self.failed += 1
                raise OSError("write failed")
        super().write(s)


def _two_op_job(out: CapturingStdout) -> tuple[dict, list[dict]]:
    async def scenario():
        s = Server(stdout=out)
        await _call(s, out, "1", "backend.init", {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}})
        await _call(s, out, "2", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-1"})
        sent: list[dict] = []
        await s.handle_line(json.dumps({"jsonrpc": "2.0", "id": "3", "method": "backend.run", "params": {
            "deviceId": "dev-1", "jobId": "job-1", "protocolSource": "inline-ops",
            "protocolInline": [{"op": "aspirate", "well": "A1"}, {"op": "dispense", "well": "B1"}],
        }}))
        await s.handle_line(json.dumps({"jsonrpc": "2.0", "id": "4", "method": "evidence.stopRecording", "params": {"deviceId": "dev-1", "jobId": "job-1"}}))
        await asyncio.sleep(0.05)
        msgs = out.pop_messages()
        sent = [m for m in msgs if m.get("method") == "evidence" and m["params"].get("jobId") == "job-1"]
        stop = next(m for m in msgs if m.get("id") == "4")
        return stop, sent

    return asyncio.run(scenario())


def test_the_close_attests_how_many_notifications_its_window_sent():
    stop, sent = _two_op_job(CapturingStdout())
    assert stop["result"]["notified"] == len(sent) == 2
    assert stop["result"]["failedWrites"] == 0


def test_a_notification_whose_write_fails_is_counted_and_attested_never_silently_lost():
    out = FlakyStdout("dispense")
    stop, sent = _two_op_job(out)
    assert out.failed == 1
    assert [m["params"]["type"] for m in sent] == ["aspirate"]
    # The window scheduled two, and one write failed: the TS adapter sees both facts.
    assert stop["result"]["notified"] == 2
    assert stop["result"]["failedWrites"] == 1


def test_a_retried_close_attests_the_same_counts():
    async def scenario():
        out = FlakyStdout("dispense")
        s = Server(stdout=out)
        await _call(s, out, "1", "backend.init", {"deviceId": "dev-1", "plrBackend": "stub", "backendConfig": {}})
        await _call(s, out, "2", "evidence.startRecording", {"deviceId": "dev-1", "jobId": "job-1"})
        await _call(s, out, "3", "backend.run", {"deviceId": "dev-1", "jobId": "job-1", "protocolSource": "inline-ops",
                                                 "protocolInline": [{"op": "aspirate", "well": "A1"}, {"op": "dispense", "well": "B1"}]})
        first = await _call(s, out, "4", "evidence.stopRecording", {"deviceId": "dev-1", "jobId": "job-1"})
        again = await _call(s, out, "5", "evidence.stopRecording", {"deviceId": "dev-1", "jobId": "job-1"})
        return first, again

    first, again = asyncio.run(scenario())
    assert first["result"]["failedWrites"] == 1
    assert again["result"] == first["result"]
