"""Tests for the OT-2 command-trace producer (R46; evidence #52 command_trace, LO-EV-9).

The commands are shaped like the Opentrons HTTP API's ``GET /runs/{id}/commands``
summaries. The hash goldens at the bottom were computed with the real TypeScript
``hashEvent`` / ``hashBundle`` (packages/spec/src/util/canonical.ts), so a Python/TS
drift fails here.
"""

import json

import pytest

from pcc_node.command_trace import (
    CommandTraceError,
    build_command_trace_events,
    command_log_line,
    fetch_run_commands,
    hash_bundle,
    hash_event,
)
from pcc_node.log_capture import GENESIS, LogCapture, compute_entry_hash, _HAS_NACL

pytestmark = pytest.mark.skipif(not _HAS_NACL, reason="pynacl required")

SEED_HEX = "deadbeef" * 8
JOB = "job-7f3a"
KERNEL = "kernel_mqse6f60_wshx"
DEVICE = "ot2-falling-bush"
PROTOCOL = "sha256:" + "ab" * 32
RUN = "run-1c2d"


def _commands():
    return [
        {
            "id": "cmd-1",
            "key": "k1",
            "commandType": "loadLabware",
            "intent": "protocol",
            "status": "succeeded",
            "params": {"location": {"slotName": "1"}, "loadName": "pcc_carrier_24_tube_2ml_screwcap"},
            "createdAt": "2026-09-24T20:00:00.000Z",
            "startedAt": "2026-09-24T20:00:00.100Z",
            "completedAt": "2026-09-24T20:00:00.200Z",
            "notes": [],
        },
        {
            "id": "cmd-2",
            "key": "k2",
            "commandType": "aspirate",
            "status": "succeeded",
            "params": {"pipetteId": "p300", "labwareId": "carrier", "wellName": "A1", "volume": 100.0, "flowRate": 92.86},
            "createdAt": "2026-09-24T20:00:01.000Z",
            "completedAt": "2026-09-24T20:00:02.500Z",
        },
        {
            "id": "cmd-3",
            "key": "k3",
            "commandType": "dispense",
            "status": "failed",
            "params": {"pipetteId": "p300", "labwareId": "carrier", "wellName": "B1", "volume": 100.0},
            "error": {"errorType": "PipetteNotReady", "detail": "no tip"},
            "createdAt": "2026-09-24T20:00:03.000Z",
        },
    ]


def _capture():
    import nacl.encoding
    import nacl.signing

    pub = nacl.signing.SigningKey(bytes.fromhex(SEED_HEX)).verify_key.encode(nacl.encoding.HexEncoder).decode()
    return LogCapture("0x" + pub, SEED_HEX)


def _build(commands=None, **overrides):
    kwargs = dict(job_id=JOB, kernel_id=KERNEL, device_id=DEVICE, protocol_hash=PROTOCOL, run_id=RUN)
    kwargs.update(overrides)
    return build_command_trace_events(commands if commands is not None else _commands(), _capture(), **kwargs)


# ── fetch_run_commands ──────────────────────────────────────────────────────


class Pages:
    """A fake robot: serves `commands` in pages and records every request."""

    def __init__(self, commands, page=2, total=None, status=200):
        self.commands = commands
        self.page = page
        self.total = len(commands) if total is None else total
        self.status = status
        self.requests = []

    def __call__(self, url, headers):
        self.requests.append((url, headers))
        cursor = int(url.split("cursor=")[1].split("&")[0])
        data = self.commands[cursor : cursor + self.page]
        return self.status, {"data": data, "meta": {"cursor": cursor, "totalLength": self.total}}


def test_fetch_reads_every_page_from_cursor_zero_with_the_api_header():
    robot = Pages(_commands(), page=2)
    got = fetch_run_commands(robot, "http://127.0.0.1:31950/", "run 1/x")
    assert [c["id"] for c in got] == ["cmd-1", "cmd-2", "cmd-3"]
    assert [u for u, _ in robot.requests] == [
        "http://127.0.0.1:31950/runs/run%201%2Fx/commands?cursor=0&pageLength=200",
        "http://127.0.0.1:31950/runs/run%201%2Fx/commands?cursor=2&pageLength=200",
    ]
    assert all(h == {"opentrons-version": "2"} for _, h in robot.requests)


@pytest.mark.parametrize(
    "robot, match",
    [
        (Pages(_commands(), status=500), "HTTP 500"),
        (Pages(_commands(), page=1, total=5), "3 of 5"),
        (Pages(_commands(), page=3, total=2), "more commands than"),
        (Pages(_commands(), total=-1), "totalLength"),
        (Pages(_commands(), total=True), "totalLength"),
        (Pages(_commands()[:1] * 2), "repeats a command id"),
    ],
)
def test_fetch_fails_closed_on_an_incomplete_or_malformed_list(robot, match):
    with pytest.raises(CommandTraceError, match=match):
        fetch_run_commands(robot, "http://127.0.0.1:31950", RUN)


def test_fetch_fails_closed_when_the_count_changes_mid_read():
    calls = {"n": 0}

    def robot(url, headers):
        calls["n"] += 1
        total = 3 if calls["n"] == 1 else 4
        cursor = int(url.split("cursor=")[1].split("&")[0])
        return 200, {"data": _commands()[cursor : cursor + 2], "meta": {"totalLength": total}}

    with pytest.raises(CommandTraceError, match="changed while it was read"):
        fetch_run_commands(robot, "http://127.0.0.1:31950", RUN)


# ── command_log_line ────────────────────────────────────────────────────────


def test_log_line_is_canonical_and_keeps_only_recorded_fields():
    a = _commands()[0]
    b = dict(reversed(list(a.items())))
    assert command_log_line(a) == command_log_line(b)
    assert json.loads(command_log_line(a)).keys() == {
        "id", "key", "commandType", "intent", "status", "params", "createdAt", "startedAt", "completedAt",
    }


@pytest.mark.parametrize("bad", [None, "x", {"commandType": "home"}, {"id": "c", "commandType": ""}])
def test_log_line_refuses_a_command_without_id_or_type(bad):
    with pytest.raises(CommandTraceError):
        command_log_line(bad)


# ── build_command_trace_events ──────────────────────────────────────────────


def test_events_form_one_signed_chain_in_the_robots_order():
    import nacl.signing

    vk = nacl.signing.SigningKey(bytes.fromhex(SEED_HEX)).verify_key
    events = _build()
    assert [e["payload"]["entryId"] for e in events] == ["cmd-1", "cmd-2", "cmd-3"]
    previous = GENESIS
    for e, command in zip(events, _commands()):
        p = e["payload"]
        assert e["type"] == "log_hash_chain_entry"
        assert p["previousHash"] == previous
        assert p["rawContent"] == command_log_line(command)  # full disclosure
        assert p["entryHash"] == compute_entry_hash(p["rawContent"], p["source"], p["capturedAt"])
        vk.verify(p["entryHash"].encode("utf-8"), bytes.fromhex(p["kernelSignature"]["value"]))
        assert p["kernelSignature"]["algorithm"] == "ed25519"
        previous = p["entryHash"]
    # A command that never completed is timed by its creation.
    assert events[2]["payload"]["capturedAt"] == "2026-09-24T20:00:03.000Z"


def test_every_event_commits_the_job_kernel_and_protocol_and_hashes_itself():
    for e in _build():
        assert e["source"] == {"kernelId": KERNEL, "deviceId": DEVICE}
        assert (e["payload"]["jobId"], e["payload"]["kernelId"], e["payload"]["protocolHash"]) == (JOB, KERNEL, PROTOCOL)
        assert e["payload"]["logKind"] == "command_trace"
        assert e["hash"] == hash_event(e)


def test_changing_any_committed_field_changes_the_event_hash():
    e = _build()[1]
    for path, value in [(("payload", "jobId"), "job-other"), (("source", "kernelId"), "k2"), (("payload", "protocolHash"), "sha256:" + "cd" * 32)]:
        forged = json.loads(json.dumps(e))
        forged[path[0]][path[1]] = value
        assert hash_event(forged) != e["hash"], path


@pytest.mark.parametrize(
    "commands, overrides, match",
    [
        ([], {}, "no commands"),
        ([{"id": "c", "commandType": "home"}], {}, "no completedAt or createdAt"),
        (None, {"job_id": ""}, "job_id"),
        (None, {"protocol_hash": None}, "protocol_hash"),
    ],
)
def test_build_fails_closed(commands, overrides, match):
    with pytest.raises(CommandTraceError, match=match):
        _build(commands, **overrides)


# ── Python/TS parity goldens ────────────────────────────────────────────────
# Computed with packages/spec/src/util/canonical.ts (hashEvent, hashBundle) over the
# fixture below; regenerate if canonical.ts changes.

GOLDEN_EVENT = {
    "type": "log_hash_chain_entry",
    "timestamp": "2026-09-24T20:00:02.500Z",
    "source": {"kernelId": KERNEL, "deviceId": DEVICE},
    "payload": {
        "jobId": JOB,
        "kernelId": KERNEL,
        "protocolHash": PROTOCOL,
        "logKind": "command_trace",
        "runId": RUN,
        "volume": 100.0,
        "flowRate": 92.86,
        "note": "µL \"quoted\"",
    },
}
GOLDEN_EVENT_HASH = "sha256:68277e12fc6c184ef177df34d5507b5f03d6a7512aefc1ca2bee85700b148eea"
GOLDEN_BUNDLE_HASH = "sha256:dcf85cb8829a896ac8b3f67b8990f896a96453747f4a0992ac80d8d086bbd086"


def test_hash_event_matches_the_typescript_golden():
    assert hash_event(GOLDEN_EVENT) == GOLDEN_EVENT_HASH


def test_hash_bundle_matches_the_typescript_golden():
    events = [{"hash": GOLDEN_EVENT_HASH}, {"hash": "sha256:" + "0" * 64}]
    assert hash_bundle(events) == GOLDEN_BUNDLE_HASH
