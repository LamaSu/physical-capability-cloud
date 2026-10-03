"""R39: the sidecar drives a populated deck, and a missing resource fails loud.

These tests run the real sidecar code against tests/fake_plr, a tiny fake of the
pylabrobot API that records calls and simulates tips and volumes. They check
PCC's own logic: deck loading, op dispatch, evidence, error mapping and stdout
isolation. test_plr_real.py runs the same flow against the genuine library and
skips unless it is installed.
"""

from __future__ import annotations
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from pcc_plr_sidecar.backend_loader import checked_layout
from pcc_plr_sidecar.dispatcher import RPC_ERROR_CODES
from pcc_plr_sidecar.server import Server

FAKE_DIR = Path(__file__).parent / "fake_plr"
PYTHON_DIR = Path(__file__).parent.parent

def _at(x: float) -> dict:
    return {"location": {"x": x, "y": 20, "z": 0, "type": "Coordinate"}, "size_x": 127.76, "size_y": 85.48, "size_z": 14.2}


# The same geometry test_plr_real.py uses on the genuine library: a 600 x 400 deck
# with a tip rack and two plates side by side.
DECK = {
    "type": "Deck",
    "name": "deck",
    "size_x": 600, "size_y": 400, "size_z": 200,
    "children": [
        {"type": "TipRack", "name": "tips", "spots": ["A1", "A2"], **_at(20)},
        {"type": "Plate", "name": "src", "wells": {"A1": 150.0}, **_at(200)},
        {"type": "Plate", "name": "dst", "wells": {"A1": 0.0}, **_at(380)},
    ],
}

TRANSFER = [
    {"op": "pickUpTips", "tipRack": "tips", "tipColumn": 1, "channel": 0},
    {"op": "aspirate", "labwareId": "src", "well": "A1", "volume_uL": 100, "channel": 0},
    {"op": "dispense", "labwareId": "dst", "well": "A1", "volume_uL": 100, "channel": 0},
    {"op": "dropTips", "channel": 0},
]


def _purge_plr_modules() -> None:
    for name in list(sys.modules):
        if name == "pylabrobot" or name.startswith("pylabrobot."):
            del sys.modules[name]


@pytest.fixture
def fake_plr(monkeypatch):
    _purge_plr_modules()
    monkeypatch.syspath_prepend(str(FAKE_DIR))
    import pylabrobot  # the fake

    assert getattr(pylabrobot, "PCC_FAKE", False)
    from pylabrobot.resources import Resource

    Resource.deserialize_calls.clear()
    yield
    _purge_plr_modules()


class Out:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def write(self, s: str) -> None:
        self.lines.extend(p for p in s.split("\n") if p)

    def flush(self) -> None:
        pass

    def messages(self) -> list[dict]:
        return [json.loads(l) for l in self.lines]


async def call(server: Server, out: Out, method: str, params: dict, msg_id: str = "1") -> dict:
    out.lines.clear()
    await server.handle_line(json.dumps({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}))
    return next(m for m in out.messages() if m.get("id") == msg_id)


async def init(server: Server, out: Out, **config) -> dict:
    return await call(server, out, "backend.init", {"deviceId": "lh1", "plrBackend": "chatterbox", "backendConfig": config})


def _server():
    out = Out()
    return Server(stdout=out), out


# ── deck loading ─────────────────────────────────────────────────────────────

async def test_init_without_a_layout_fails_loud_instead_of_using_an_empty_deck(fake_plr):
    s, out = _server()
    resp = await init(s, out)
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]
    assert "deckLayout" in resp["error"]["message"]


async def test_init_rejects_both_layout_sources_and_a_non_deck_layout(fake_plr, tmp_path):
    s, out = _server()
    both = await init(s, out, deckLayout=DECK, deckLayoutPath=str(tmp_path / "d.json"))
    assert both["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]
    s, out = _server()
    plate = await init(s, out, deckLayout={"type": "Plate", "name": "p", "wells": {}})
    assert plate["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]
    assert "expected Deck" in plate["error"]["message"]


async def test_init_loads_the_declared_deck_as_data(fake_plr):
    from pylabrobot.resources import Resource

    s, out = _server()
    resp = await init(s, out, deckLayout=DECK)
    assert "error" not in resp, resp
    names = [c["name"] for c in resp["result"]["deckSnapshot"]["children"]]
    assert names == ["tips", "src", "dst"]
    assert Resource.deserialize_calls[0]["allow_marshal"] is False
    lh = s.loader.get("lh1").machine
    assert type(lh.backend).__name__ == "LiquidHandlerChatterboxBackend"
    assert lh.calls[0] == ("setup",)


async def test_init_loads_a_layout_file_from_the_layout_directory(fake_plr, tmp_path, monkeypatch):
    monkeypatch.setenv("PCC_PLR_LAYOUT_DIR", str(tmp_path))
    (tmp_path / "deck.json").write_text(json.dumps(DECK))
    for given in (str(tmp_path / "deck.json"), "deck.json"):
        s, out = _server()
        resp = await init(s, out, deckLayoutPath=given)
        assert resp["result"]["ok"] is True, resp


# ── op dispatch ─────────────────────────────────────────────────────────────

async def test_run_drives_the_populated_deck_and_evidence_follows_the_machine(fake_plr):
    s, out = _server()
    await init(s, out, deckLayout=DECK)
    await call(s, out, "evidence.startRecording", {"deviceId": "lh1", "jobId": "job-1"}, "2")
    resp = await call(s, out, "backend.run", {
        "deviceId": "lh1", "jobId": "job-1", "protocolSource": "inline-ops", "protocolInline": TRANSFER,
    }, "3")
    assert resp["result"]["ok"] is True
    assert resp["result"]["opCount"] == 4

    lh = s.loader.get("lh1").machine
    assert [c[0] for c in lh.calls] == ["setup", "pick_up_tips", "aspirate", "dispense", "return_tips"]
    assert lh.deck.get_resource("src")["A1"].volume == 50.0
    assert lh.deck.get_resource("dst")["A1"].volume == 100.0
    assert lh.deck.get_resource("tips")["A1"].has_tip is True  # returned

    await asyncio_sleep_for_notifications()
    # One evidence notification per completed op; its type is the op name (as on the stub path).
    op_names = ("pickUpTips", "aspirate", "dispense", "dropTips")
    ops = [m["params"] for m in out.messages() if m.get("method") == "evidence" and m["params"]["type"] in op_names]
    assert [o["type"] for o in ops] == list(op_names)
    assert all(o["jobId"] == "job-1" for o in ops)
    assert ops[1]["payload"]["labwareId"] == "src" and ops[1]["payload"]["volume_uL"] == 100.0


async def asyncio_sleep_for_notifications() -> None:
    import asyncio

    await asyncio.sleep(0.05)


async def _run(s: Server, out: Out, ops: list, source: str = "inline-ops") -> dict:
    return await call(s, out, "backend.run", {
        "deviceId": "lh1", "jobId": "job-x", "protocolSource": source, "protocolInline": ops,
    }, "9")


async def test_a_missing_labware_anywhere_refuses_the_run_before_anything_moves(fake_plr):
    s, out = _server()
    await init(s, out, deckLayout=DECK)
    resp = await _run(s, out, [
        TRANSFER[0],
        {"op": "aspirate", "labwareId": "no_such_plate", "well": "A1", "volume_uL": 100, "channel": 0},
    ])
    err = resp["error"]
    assert err["code"] == RPC_ERROR_CODES["NON_RETRYABLE"]
    assert err["data"]["missingResource"] == "no_such_plate"
    assert err["data"]["opIndex"] == 1
    assert err["data"]["opsCompleted"] == 0
    lh = s.loader.get("lh1").machine
    assert [c[0] for c in lh.calls] == ["setup"]  # op 0 never ran: the protocol is checked first
    assert lh.deck.get_resource("tips")["A1"].has_tip is True


async def test_a_missing_well_fails_loud(fake_plr):
    s, out = _server()
    await init(s, out, deckLayout=DECK)
    resp = await _run(s, out, [TRANSFER[0], {"op": "aspirate", "labwareId": "src", "well": "Z99", "volume_uL": 10, "channel": 0}])
    assert resp["error"]["code"] == RPC_ERROR_CODES["NON_RETRYABLE"]
    assert resp["error"]["data"]["missingItem"] == "Z99"


async def test_a_plr_error_stops_the_run_with_its_exception_name(fake_plr):
    s, out = _server()
    await init(s, out, deckLayout=DECK)
    resp = await _run(s, out, [TRANSFER[1]])  # aspirate with no tip picked up
    assert resp["error"]["code"] == RPC_ERROR_CODES["NON_RETRYABLE"]
    assert resp["error"]["data"]["plrException"] == "NoTipError"
    assert resp["error"]["data"]["opsCompleted"] == 0


@pytest.mark.parametrize(
    "bad_op",
    [
        {"op": "shake", "seconds": 5},
        {"op": "aspirate", "labwareId": "src", "well": "A1", "volume_uL": 0},
        {"op": "aspirate", "labwareId": "src", "well": "A1", "volume_uL": -5},
        {"op": "aspirate", "labwareId": "src", "well": "A1", "volume_uL": "100"},
        {"op": "aspirate", "labwareId": "src", "well": "A1", "volume_uL": True},
        {"op": "aspirate", "well": "A1", "volume_uL": 10},
        {"op": "pickUpTips", "tipColumn": 1},
        {"op": "pickUpTips", "tipRack": "tips"},
        {"op": "pickUpTips", "tipRack": "tips", "tipColumn": 0},
        {"op": "aspirate", "labwareId": "src", "well": "A1", "volume_uL": 10, "channel": -1},
        "aspirate",
    ],
)
async def test_invalid_ops_are_rejected_before_touching_the_machine(fake_plr, bad_op):
    s, out = _server()
    await init(s, out, deckLayout=DECK)
    resp = await _run(s, out, [bad_op])
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    assert [c[0] for c in s.loader.get("lh1").machine.calls] == ["setup"]


async def test_empty_ops_and_non_inline_sources_fail_loud_on_plr(fake_plr):
    s, out = _server()
    await init(s, out, deckLayout=DECK)
    empty = await _run(s, out, [])
    assert empty["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]
    script = await _run(s, out, TRANSFER, source="plr-script")
    assert script["error"]["code"] == RPC_ERROR_CODES["NOT_SUPPORTED"]
    assert [c[0] for c in s.loader.get("lh1").machine.calls] == ["setup"]



# ── R39 CRIT2: one per-device execution lease ───────────────────────────────

def _block_pick_up_tips_on(machine) -> tuple["asyncio.Event", "asyncio.Event"]:
    """Make ONE specific fake LiquidHandler instance's pick_up_tips wait on an
    Event before doing its work. Scoped to this instance only (an attribute
    set directly on it shadows the class method) -- a different device's
    machine is a different instance and is never touched.

    Returns (entered, release): ``entered`` is set the instant a run is inside
    pick_up_tips (holding the lease, nothing moved yet); set ``release`` to let
    it proceed.
    """
    import asyncio as _asyncio

    entered = _asyncio.Event()
    release = _asyncio.Event()
    original = type(machine).pick_up_tips

    async def blocking(*args, **kwargs):
        entered.set()
        await release.wait()
        return await original(machine, *args, **kwargs)

    machine.pick_up_tips = blocking
    return entered, release


async def test_concurrent_runs_on_one_device_are_serialized_not_interleaved(fake_plr):
    import asyncio

    s, out = _server()
    await init(s, out, deckLayout=DECK)
    entered, release = _block_pick_up_tips_on(s.loader.get("lh1").machine)

    task_a = asyncio.create_task(_run(s, out, TRANSFER))
    await entered.wait()  # job A holds the lease, blocked inside pick_up_tips
    assert _calls(s) == ["setup"]  # not even pick_up_tips has recorded yet

    # B must get DEVICE_BUSY fast -- it must never queue behind A. Bounded by
    # wait_for so a regression (B blocking on the same backend call) fails the
    # test cleanly instead of hanging the whole run. (Same `out`/`s` as task_a:
    # the Server writes only to the `out` it was constructed with -- task_a is
    # dormant here, so there's nothing to interleave with yet.)
    resp_b = await asyncio.wait_for(call(s, out, "backend.run", {
        "deviceId": "lh1", "jobId": "job-b", "protocolSource": "inline-ops", "protocolInline": TRANSFER,
    }, "20"), timeout=2.0)
    assert resp_b["error"]["code"] == RPC_ERROR_CODES["DEVICE_BUSY"], resp_b
    assert _calls(s) == ["setup"]  # B touched nothing: no backend call at all

    # a different device is not blocked
    await call(s, out, "backend.init", {"deviceId": "lh2", "plrBackend": "chatterbox", "backendConfig": {"deckLayout": DECK}}, "30")
    other = await asyncio.wait_for(call(s, out, "backend.run", {
        "deviceId": "lh2", "jobId": "job-other", "protocolSource": "inline-ops", "protocolInline": [TRANSFER[0]],
    }, "31"), timeout=2.0)
    assert other["result"]["ok"] is True

    release.set()
    result_a = await task_a
    assert result_a["result"]["opCount"] == 4
    assert _calls(s) == ["setup", "pick_up_tips", "aspirate", "dispense", "return_tips"]

    # the lease is released: B can run now
    resp_b2 = await call(s, out, "backend.run", {
        "deviceId": "lh1", "jobId": "job-b", "protocolSource": "inline-ops", "protocolInline": [TRANSFER[0]],
    }, "21")
    assert resp_b2["result"]["opCount"] == 1, resp_b2


async def test_evidence_start_recording_refuses_a_different_job_while_the_device_is_busy(fake_plr):
    import asyncio

    s, out = _server()
    await init(s, out, deckLayout=DECK)
    entered, release = _block_pick_up_tips_on(s.loader.get("lh1").machine)
    task_a = asyncio.create_task(_run(s, out, TRANSFER))  # _run always uses jobId "job-x"
    await entered.wait()

    resp = await asyncio.wait_for(
        call(s, out, "evidence.startRecording", {"deviceId": "lh1", "jobId": "job-b"}, "40"), timeout=2.0,
    )
    assert resp["error"]["code"] == RPC_ERROR_CODES["DEVICE_BUSY"], resp

    # the lease holder's own job ("job-x", see _run) may still (re)arm its
    # window without conflict
    own = await asyncio.wait_for(
        call(s, out, "evidence.startRecording", {"deviceId": "lh1", "jobId": "job-x"}, "41"), timeout=2.0,
    )
    assert "error" not in own, own

    release.set()
    await asyncio.wait_for(task_a, timeout=2.0)


async def test_tips_can_be_dropped_into_a_named_spot(fake_plr):
    s, out = _server()
    await init(s, out, deckLayout=DECK)
    resp = await _run(s, out, [TRANSFER[0], {"op": "dropTips", "tipRack": "tips", "tipSpot": "A2", "channel": 0}])
    assert resp["result"]["opCount"] == 2
    lh = s.loader.get("lh1").machine
    assert lh.calls[-1] == ("drop_tips", ["A2"], [0])


# ── R39 HIGH5: completion never outruns the evidence it claims ─────────────

async def test_every_atomic_op_notification_precedes_the_runs_response(fake_plr):
    import asyncio

    s, out = _server()
    # EvidenceHandler captures a bound reference to Server.write_notification
    # at construction time (see Server.__init__), so patching s.write_notification
    # itself would be a no-op for evidence writes -- patch the handler's own
    # writer, which is what emit_atomic_op's scheduled tasks actually call.
    original_writer = s.evidence._writer

    async def tracked_writer(method, params):
        if method == "evidence" and params.get("type") in ("pickUpTips", "aspirate", "dispense", "dropTips"):
            # Force a genuine scheduling checkpoint on every atomic-op write --
            # proves backend.run truly awaits it, not just that the fire-and-
            # forget task object happens to exist.
            await asyncio.sleep(0)
        await original_writer(method, params)

    s.evidence._writer = tracked_writer

    await init(s, out, deckLayout=DECK)
    await call(s, out, "evidence.startRecording", {"deviceId": "lh1", "jobId": "job-1"}, "2")
    resp = await call(s, out, "backend.run", {
        "deviceId": "lh1", "jobId": "job-1", "protocolSource": "inline-ops", "protocolInline": TRANSFER,
    }, "3")
    assert resp["result"]["ok"] is True, resp

    # No asyncio.sleep() needed here: if backend.run didn't drain the writes,
    # this would be flaky/wrong by construction, not just slow.
    messages = out.messages()
    response_index = next(i for i, m in enumerate(messages) if m.get("id") == "3")
    op_names = ("pickUpTips", "aspirate", "dispense", "dropTips")
    before = [
        m["params"]["type"] for m in messages[:response_index]
        if m.get("method") == "evidence" and m["params"]["type"] in op_names
    ]
    after = [
        m for m in messages[response_index + 1:]
        if m.get("method") == "evidence" and m["params"]["type"] in op_names
    ]
    assert before == list(op_names), messages
    assert after == []


async def test_backend_run_does_not_report_success_if_an_evidence_write_fails(fake_plr):
    s, out = _server()
    await init(s, out, deckLayout=DECK)

    async def failing_writer(method, params):
        if method == "evidence":
            raise RuntimeError("stdout pipe broken")

    s.evidence._writer = failing_writer
    resp = await _run(s, out, TRANSFER)
    assert "error" in resp, resp
    assert resp["error"]["code"] == RPC_ERROR_CODES["INTERNAL_ERROR"], resp
    # The physical ops already ran -- draining surfaces the write failure, it
    # doesn't (and can't) undo actuation that already happened.
    lh = s.loader.get("lh1").machine
    assert [c[0] for c in lh.calls] == ["setup", "pick_up_tips", "aspirate", "dispense", "return_tips"]


# ── astra r1 on #378: no op is skipped, and every op is checked before any runs ─

def _calls(s: Server) -> list:
    return [c[0] for c in s.loader.get("lh1").machine.calls]


async def test_a_delay_field_is_refused_and_nothing_moves(fake_plr):
    # The skipped-op bypass: this op used to be skipped (no check, no aspirate) while
    # the run still answered ok.
    s, out = _server()
    await init(s, out, deckLayout=DECK)
    resp = await _run(s, out, [
        TRANSFER[0],
        {"op": "aspirate", "labwareId": "missing", "well": "A1", "volume_uL": 100, "__delay_ms": 1},
    ])
    err = resp["error"]
    assert err["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    assert err["data"]["unknownFields"] == ["__delay_ms"]
    assert (err["data"]["opIndex"], err["data"]["opsCompleted"]) == (1, 0)
    assert _calls(s) == ["setup"]


@pytest.mark.parametrize(
    "extra",
    [{"volume": 10}, {"speed": 3}, {"__proto__": {}}, {"labwareId": "src"}],
)
async def test_any_field_an_op_does_not_take_refuses_the_whole_protocol(fake_plr, extra):
    s, out = _server()
    await init(s, out, deckLayout=DECK)
    ops = [dict(TRANSFER[0]), *TRANSFER[1:]]
    ops[0].update(extra)  # pickUpTips takes no volume, speed or labware
    resp = await _run(s, out, ops)
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    assert _calls(s) == ["setup"]


@pytest.mark.parametrize(
    "bad_op",
    [
        {"op": "aspirate", "labwareId": "src", "well": "A1", "volume_uL": float("inf")},
        {"op": "aspirate", "labwareId": "src", "well": "A1", "volume_uL": float("nan")},
        {"op": "aspirate", "labwareId": "src", "well": "A1", "volume_uL": 1e9},
        {"op": "aspirate", "labwareId": "src", "well": "A1", "volume_uL": 1000.5},
        {"op": "aspirate", "labwareId": "src", "well": "A1", "volume_uL": 10, "channel": 8},
        {"op": "pickUpTips", "tipRack": "tips", "tipSpot": "A1", "tipColumn": 1},
        {"op": "pickUpTips", "tipRack": "src", "tipSpot": "A1"},
        {"op": "aspirate", "labwareId": "tips", "well": "A1", "volume_uL": 10},
        {"op": "dropTips", "tipSpot": "A1"},
    ],
    ids=["inf", "nan", "huge", "over-max", "channel-8-of-8", "spot-and-column",
         "tips-from-a-plate", "liquid-from-a-tip-rack", "spot-without-rack"],
)
async def test_bounds_and_types_are_checked_before_anything_moves(fake_plr, bad_op):
    s, out = _server()
    await init(s, out, deckLayout=DECK)
    resp = await _run(s, out, [TRANSFER[0], bad_op])
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    assert resp["error"]["data"]["opsCompleted"] == 0
    assert _calls(s) == ["setup"]


async def test_the_operator_can_lower_the_volume_bound_and_the_channel_count(fake_plr):
    s, out = _server()
    await init(s, out, deckLayout=DECK, maxVolumeUL=50, numChannels=2)
    over = await _run(s, out, [TRANSFER[0], dict(TRANSFER[1], volume_uL=60)])
    assert over["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]
    channel = await _run(s, out, [dict(TRANSFER[0], channel=2)])
    assert channel["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]
    ok = await _run(s, out, [TRANSFER[0], dict(TRANSFER[1], volume_uL=50)])
    assert ok["result"]["opCount"] == 2
    for bad in ({"maxVolumeUL": 0}, {"maxVolumeUL": 5000}, {"maxVolumeUL": float("inf")}, {"numChannels": 97}):
        s2, out2 = _server()
        assert (await init(s2, out2, deckLayout=DECK, **bad))["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]


async def test_every_result_and_event_says_how_the_ops_were_executed(fake_plr):
    # R39 CRIT1: the backend type never establishes physical execution. Only a
    # known simulator reports "simulated"; a hardware-capable backend (ot2) is
    # "unverified" until a hardware-identity provenance check exists (D1 #19) —
    # never "hardware".
    s, out = _server()
    init_resp = await init(s, out, deckLayout=DECK)
    assert init_resp["result"]["metadata"]["executionMode"] == "simulated"
    await call(s, out, "evidence.startRecording", {"deviceId": "lh1", "jobId": "job-1"}, "2")
    resp = await call(s, out, "backend.run", {
        "deviceId": "lh1", "jobId": "job-1", "protocolSource": "inline-ops", "protocolInline": TRANSFER,
    }, "3")
    assert resp["result"]["executionMode"] == "simulated"
    await asyncio_sleep_for_notifications()
    events = [m["params"] for m in out.messages() if m.get("method") == "evidence"]
    op_events = [e for e in events if e["type"] in ("pickUpTips", "aspirate", "dispense", "dropTips")]
    assert len(op_events) == 4 and all(e["payload"]["executionMode"] == "simulated" for e in op_events)
    assert all(e["payload"]["mock"] is True for e in op_events)  # simulated, never physical evidence

    s, out = _server()
    await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "ot2Url": "10.0.0.5", "deckLayout": dict(DECK, type="OTDeck")}})
    await call(s, out, "evidence.startRecording", {"deviceId": "ot", "jobId": "j"}, "3b")
    run = await call(s, out, "backend.run", {
        "deviceId": "ot", "jobId": "j", "protocolSource": "inline-ops", "protocolInline": [TRANSFER[0]]}, "4")
    # never "hardware": no hardware-identity provenance check exists yet (D1 #19).
    assert run["result"]["executionMode"] == "unverified"
    await asyncio_sleep_for_notifications()
    ot_events = [m["params"] for m in out.messages() if m.get("method") == "evidence" and m["params"]["type"] == "pickUpTips"]
    assert len(ot_events) == 1 and ot_events[0]["payload"]["executionMode"] == "unverified"
    assert ot_events[0]["payload"]["mock"] is True  # unverified is never physical evidence either

    s, out = _server()
    await call(s, out, "backend.init", {"deviceId": "st", "plrBackend": "stub", "backendConfig": {}})
    stub = await call(s, out, "backend.run", {
        "deviceId": "st", "jobId": "j", "protocolSource": "inline-ops", "protocolInline": TRANSFER}, "5")
    assert stub["result"]["executionMode"] == "stub"


# ── R39 MED6: malformed stub input fails loud, never a synthetic noop ───────

async def _stub_server():
    s, out = _server()
    await call(s, out, "backend.init", {"deviceId": "st", "plrBackend": "stub", "backendConfig": {}}, "init")
    return s, out


@pytest.mark.parametrize(
    "bad_inline",
    [None, "not-a-list", 42, {"nope": "wrong-shape"}, [], [{"op": "shake"}], [{"op": "aspirate", "flux": 1}]],
    ids=["null", "string", "number", "dict-without-ops-key", "empty-list", "unknown-op", "unknown-field"],
)
async def test_malformed_or_unknown_stub_ops_fail_loud_with_zero_ops_run(fake_plr, bad_inline):
    s, out = await _stub_server()
    resp = await call(s, out, "backend.run", {
        "deviceId": "st", "jobId": "j", "protocolSource": "inline-ops", "protocolInline": bad_inline,
    }, "6")
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    await asyncio_sleep_for_notifications()
    assert not any(m.get("method") == "evidence" for m in out.messages())


async def test_a_valid_stub_protocol_still_runs_as_before(fake_plr):
    s, out = await _stub_server()
    resp = await call(s, out, "backend.run", {
        "deviceId": "st", "jobId": "j", "protocolSource": "inline-ops",
        "protocolInline": [{"op": "pickUpTips", "channel": 0}, {"op": "aspirate", "well": "A1", "volume_uL": 100}],
    }, "6")
    assert resp["result"]["opCount"] == 2, resp


# ── astra r1 on #378: the layout is checked as data before PLR builds anything ─

def _deserialized(fake) -> list:
    from pylabrobot.resources import Resource

    return Resource.deserialize_calls


def _deep(depth: int) -> list:
    value: list = []
    for _ in range(depth):
        value = [value]
    return value


HOSTILE_LAYOUTS = {
    "unknown-type-nested": dict(DECK, children=[
        dict(DECK["children"][0], extra={"type": "subprocess.Popen", "args": ["id"]}), *DECK["children"][1:]]),
    "unknown-child-type": dict(DECK, children=[{"type": "Popen", "name": "x", **_at(20)}]),
    "dunder-key": dict(DECK, children=[dict(DECK["children"][0], __reduce__=["os.system", "id"]), *DECK["children"][1:]]),
    "too-deep": dict(DECK, junk=_deep(40)),
    "too-many-values": dict(DECK, junk=list(range(120_000))),
    "huge-string": dict(DECK, junk="x" * 5000),
    "non-finite": dict(DECK, size_x=float("inf")),
    "root-is-a-plate": {"type": "Plate", "name": "p", "wells": {}, "size_x": 1, "size_y": 1, "size_z": 1},
    "off-the-deck": dict(DECK, children=[{"type": "Plate", "name": "far", "wells": {}, **_at(590)}]),
    "overlapping": dict(DECK, children=[dict(DECK["children"][1]), dict(DECK["children"][2], name="dst", **_at(250))]),
    "no-size": dict(DECK, children=[{"type": "Plate", "name": "p", "wells": {}, "location": {"x": 1, "y": 1, "z": 0}}]),
}


@pytest.mark.parametrize("name", sorted(HOSTILE_LAYOUTS))
async def test_hostile_inline_layouts_never_reach_the_deserializer(fake_plr, name):
    s, out = _server()
    resp = await init(s, out, deckLayout=HOSTILE_LAYOUTS[name])
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    assert _deserialized(fake_plr) == []


@pytest.mark.parametrize("name", sorted(HOSTILE_LAYOUTS))
async def test_hostile_layout_files_never_reach_the_deserializer(fake_plr, name, tmp_path, monkeypatch):
    monkeypatch.setenv("PCC_PLR_LAYOUT_DIR", str(tmp_path))
    (tmp_path / "deck.json").write_text(json.dumps(HOSTILE_LAYOUTS[name]))
    s, out = _server()
    # An absolute path inside the directory: the file is readable, so only the checks stop it.
    resp = await init(s, out, deckLayoutPath=str(tmp_path / "deck.json"))
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    assert _deserialized(fake_plr) == []


async def test_a_serialized_function_is_stripped_not_deserialized(fake_plr):
    layout = dict(DECK, children=[dict(DECK["children"][1], compute_volume_from_height={
        "type": "function", "code": "e30=", "name": "evil"}), DECK["children"][2]])
    s, out = _server()
    resp = await init(s, out, deckLayout=layout)
    assert resp["result"]["metadata"]["strippedFunctions"] == 1
    sent = _deserialized(fake_plr)[0]
    assert sent["allow_marshal"] is False
    assert sent["data"]["children"][0]["compute_volume_from_height"] is None


# ── R39 MED7: function stripping may not silently change a hardware layout ──

async def test_a_function_bearing_layout_on_ot2_is_refused(fake_plr):
    layout = dict(DECK, type="OTDeck", children=[dict(DECK["children"][1], compute_volume_from_height={
        "type": "function", "code": "e30=", "name": "evil"}), DECK["children"][2]])
    s, out = _server()
    resp = await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "ot2Url": "10.0.0.5", "deckLayout": layout}})
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    # the declared layout is never mutated and then initialized: no deserialize call at all.
    assert _deserialized(fake_plr) == []


async def test_a_function_bearing_layout_on_the_simulator_still_strips_as_before(fake_plr):
    # Documented, logged behavior on simulators only (R39 MED7's narrower half).
    layout = dict(DECK, children=[dict(DECK["children"][1], compute_volume_from_height={
        "type": "function", "code": "e30=", "name": "evil"}), DECK["children"][2]])
    s, out = _server()
    resp = await init(s, out, deckLayout=layout)
    assert resp["result"]["metadata"]["strippedFunctions"] == 1


# ── R39 CRIT4: the geometry guard covers z, rotation and nested children ────

async def test_a_negative_z_is_refused_before_deserialize(fake_plr):
    bad = dict(DECK, children=[
        dict(DECK["children"][0], location=dict(DECK["children"][0]["location"], z=-100)),
        *DECK["children"][1:],
    ])
    s, out = _server()
    resp = await init(s, out, deckLayout=bad)
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    assert _deserialized(fake_plr) == []


async def test_z_beyond_the_decks_height_limit_is_refused(fake_plr):
    bad = dict(DECK, children=[
        dict(DECK["children"][0], location=dict(DECK["children"][0]["location"], z=500)),  # deck size_z is 200
        *DECK["children"][1:],
    ])
    s, out = _server()
    resp = await init(s, out, deckLayout=bad)
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    assert _deserialized(fake_plr) == []


async def test_a_rotated_resource_is_refused(fake_plr):
    bad = dict(DECK, children=[
        dict(DECK["children"][0], rotation={"type": "Rotation", "x": 0, "y": 0, "z": 90}),
        *DECK["children"][1:],
    ])
    s, out = _server()
    resp = await init(s, out, deckLayout=bad)
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    assert _deserialized(fake_plr) == []


def _holder(x: float, y: float, z: float, *, child: dict | None = None) -> dict:
    """A ResourceHolder (e.g. a carrier) big enough to hold one labware item."""
    holder = {
        "type": "ResourceHolder", "name": "holder", "size_x": 50.0, "size_y": 50.0, "size_z": 10.0,
        "location": {"x": x, "y": y, "z": z, "type": "Coordinate"},
    }
    if child is not None:
        holder["children"] = [child]
    return holder


def test_a_nested_child_placed_outside_its_parent_is_refused(fake_plr):
    # checked_layout() directly: the fake deserializer doesn't model
    # ResourceHolder nesting, but the geometry guard runs before deserialize.
    outside_its_parent = {
        "type": "Plate", "name": "nested", "wells": {}, "size_x": 30.0, "size_y": 30.0, "size_z": 5.0,
        "location": {"x": 45.0, "y": 45.0, "z": 0.0, "type": "Coordinate"},  # 45+30=75 > holder's 50
    }
    layout = dict(DECK, children=[_holder(20, 20, 0, child=outside_its_parent)])
    with pytest.raises(ValueError):
        checked_layout(layout, frozenset({"Deck", "OTDeck"}))


def test_a_valid_nested_layout_passes(fake_plr):
    inside_its_parent = {
        "type": "Plate", "name": "nested", "wells": {}, "size_x": 30.0, "size_y": 30.0, "size_z": 5.0,
        "location": {"x": 5.0, "y": 5.0, "z": 0.0, "type": "Coordinate"},
    }
    layout = dict(DECK, children=[_holder(20, 20, 0, child=inside_its_parent)])
    cleaned, stripped = checked_layout(layout, frozenset({"Deck", "OTDeck"}))
    assert stripped == 0
    assert cleaned["children"][0]["children"][0]["name"] == "nested"


async def test_layout_files_must_come_from_the_layout_directory(fake_plr, tmp_path, monkeypatch):
    layouts = tmp_path / "layouts"
    layouts.mkdir()
    (tmp_path / "outside.json").write_text(json.dumps(DECK))
    (layouts / "deck.txt").write_text(json.dumps(DECK))
    (layouts / "big.json").write_text(" " * (5 * 1024 * 1024 + 1))
    (layouts / "link.json").symlink_to(tmp_path / "outside.json")
    s, out = _server()
    no_dir = await init(s, out, deckLayoutPath=str(tmp_path / "outside.json"))
    assert "PCC_PLR_LAYOUT_DIR" in no_dir["error"]["message"]
    monkeypatch.setenv("PCC_PLR_LAYOUT_DIR", str(layouts))
    for given in (str(tmp_path / "outside.json"), "../outside.json", "link.json", "deck.txt", "big.json", "missing.json"):
        s, out = _server()
        resp = await init(s, out, deckLayoutPath=given)
        assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], (given, resp)
    assert _deserialized(fake_plr) == []


# ── astra r1 on #378: PLR's own tracking is on, and liquids are declared ─────

async def test_tip_and_volume_tracking_are_on_by_default(fake_plr):
    from pylabrobot.resources import TRACKING

    s, out = _server()
    resp = await init(s, out, deckLayout=DECK)
    assert TRACKING == {"tips": True, "volume": True}
    assert resp["result"]["metadata"]["tracking"] == {"tips": True, "volume": True}


async def test_tracking_can_be_switched_off_on_the_simulator_but_not_on_hardware(fake_plr):
    from pylabrobot.resources import TRACKING

    s, out = _server()
    resp = await init(s, out, deckLayout=DECK, tracking={"volume": False})
    assert resp["result"]["metadata"]["tracking"] == {"tips": True, "volume": False}
    assert TRACKING["volume"] is False
    for tracking in ({"tips": False}, {"volume": False}):
        s, out = _server()
        hw = await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
            "ot2Url": "10.0.0.5", "deckLayout": dict(DECK, type="OTDeck"), "tracking": tracking}})
        assert hw["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], hw
    for bad in ({"tips": "yes"}, {"speed": True}, ["tips"]):
        s, out = _server()
        assert (await init(s, out, deckLayout=DECK, tracking=bad))["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]



# ── R39 CRIT3: PLR tracking is not process-global across hardware + simulators ─

async def test_loading_a_simulator_cannot_weaken_tracking_while_hardware_is_loaded(fake_plr):
    from pylabrobot.resources import TRACKING

    s, out = _server()
    await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "ot2Url": "10.0.0.5", "deckLayout": dict(DECK, type="OTDeck")}})
    assert TRACKING == {"tips": True, "volume": True}

    weakened = await call(s, out, "backend.init", {"deviceId": "lh1", "plrBackend": "chatterbox", "backendConfig": {
        "deckLayout": DECK, "tracking": {"volume": False}}})
    assert weakened["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], weakened
    assert not s.loader.has("lh1")  # the simulator never finished loading either
    assert TRACKING == {"tips": True, "volume": True}  # the switches stayed ON

    run = await call(s, out, "backend.run", {
        "deviceId": "ot", "jobId": "job-1", "protocolSource": "inline-ops", "protocolInline": [TRANSFER[0]],
    }, "9")
    assert run["result"]["ok"] is True, run  # the ot2 run still sees tracking ON
    assert TRACKING == {"tips": True, "volume": True}


async def test_an_ot2_run_reasserts_tracking_even_if_something_flipped_it(fake_plr):
    from pylabrobot.resources import TRACKING, set_volume_tracking

    s, out = _server()
    await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "ot2Url": "10.0.0.5", "deckLayout": dict(DECK, type="OTDeck")}})
    # Something flipped the global switch between runs (a race, a bug, a future
    # code path -- CRIT3 doesn't need to know what).
    set_volume_tracking(False)
    assert TRACKING["volume"] is False

    run = await call(s, out, "backend.run", {
        "deviceId": "ot", "jobId": "job-1", "protocolSource": "inline-ops", "protocolInline": [TRANSFER[0]],
    }, "9")
    assert run["result"]["ok"] is True, run
    assert TRACKING == {"tips": True, "volume": True}  # re-asserted before the run


async def test_an_ot2_run_refuses_if_tracking_cannot_be_verified(fake_plr, monkeypatch):
    import pylabrobot.resources as plr_resources

    s, out = _server()
    await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "ot2Url": "10.0.0.5", "deckLayout": dict(DECK, type="OTDeck")}})
    monkeypatch.setattr(plr_resources, "does_volume_tracking", lambda: False)
    run = await call(s, out, "backend.run", {
        "deviceId": "ot", "jobId": "job-1", "protocolSource": "inline-ops", "protocolInline": [TRANSFER[0]],
    }, "9")
    assert run["error"]["code"] == RPC_ERROR_CODES["NON_RETRYABLE"], run
    ot_machine = s.loader.get("ot").machine
    assert ot_machine.calls == [("setup",)]  # refused before pick_up_tips ran


async def test_initial_liquids_declare_what_the_operator_loaded(fake_plr):
    s, out = _server()
    resp = await init(s, out, deckLayout=DECK, initialLiquids={"src": {"A1": 20}})
    assert resp["result"]["metadata"]["declaredWells"] == 1
    lh = s.loader.get("lh1").machine
    assert lh.deck.get_resource("src")["A1"].volume == 20.0
    short = await _run(s, out, TRANSFER)  # 100 uL from a well holding 20: PLR refuses
    assert short["error"]["data"]["plrException"] == "TooLittleLiquidError"
    for bad in ({"nope": {"A1": 1}}, {"src": {"Z9": 1}}, {"src": {"A1": -1}}, {"src": {"A1": float("inf")}}, {"src": 5}):
        s2, out2 = _server()
        assert (await init(s2, out2, deckLayout=DECK, initialLiquids=bad))["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]


# ── OT-2 via PLR ────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "url, host, port",
    [("http://10.0.0.5:31950", "10.0.0.5", 31950), ("10.0.0.5", "10.0.0.5", 31950), ("http://ot2.local:8080", "ot2.local", 8080)],
)
async def test_ot2_uses_opentrons_ot2_backend_with_host_and_port(fake_plr, url, host, port):
    s, out = _server()
    ot_deck = dict(DECK, type="OTDeck")
    resp = await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {"ot2Url": url, "deckLayout": ot_deck}})
    assert "error" not in resp, resp
    backend = s.loader.get("ot").machine.backend
    assert type(backend).__name__ == "OpentronsOT2Backend"
    assert (backend.host, backend.port) == (host, port)


async def test_ot2_needs_a_url_and_an_ot_deck(fake_plr):
    s, out = _server()
    no_url = await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {"deckLayout": dict(DECK, type="OTDeck")}})
    assert no_url["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]
    s, out = _server()
    plain = await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {"ot2Url": "10.0.0.5", "deckLayout": DECK}})
    assert plain["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]
    assert "expected OTDeck" in plain["error"]["message"]


# ── stdout isolation (the real entry point, in a subprocess) ────────────────

def test_plr_prints_never_reach_the_json_rpc_channel(tmp_path):
    env = dict(os.environ, PYTHONPATH=os.pathsep.join([str(FAKE_DIR), str(PYTHON_DIR)]), PYTHONDONTWRITEBYTECODE="1")
    proc = subprocess.Popen(
        [sys.executable, "-m", "pcc_plr_sidecar"], cwd=str(tmp_path), env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        request = {"jsonrpc": "2.0", "id": "i1", "method": "backend.init",
                   "params": {"deviceId": "lh1", "plrBackend": "chatterbox", "backendConfig": {"deckLayout": DECK}}}
        proc.stdin.write(json.dumps(request) + "\n")
        proc.stdin.flush()
        stdout_lines = []
        while True:
            line = proc.stdout.readline()
            assert line, "sidecar closed stdout before answering"
            stdout_lines.append(line)
            if json.loads(line).get("id") == "i1":
                break
        rest, err = proc.communicate(timeout=20)  # closes stdin: EOF shuts the sidecar down
    finally:
        if proc.poll() is None:
            proc.kill()
    for line in stdout_lines + [l for l in rest.splitlines() if l.strip()]:
        json.loads(line)  # every stdout line is JSON-RPC
    assert json.loads(stdout_lines[-1])["result"]["ok"] is True
    assert "Setting up the liquid handler." in err  # the print went to stderr
