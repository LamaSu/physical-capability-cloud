"""R39: the sidecar drives a populated deck, and a missing resource fails loud.

These tests run the real sidecar code against tests/fake_plr, a tiny fake of the
pylabrobot API that records calls and simulates tips and volumes. They check
PCC's own logic: deck loading, op dispatch, evidence, error mapping and stdout
isolation. test_plr_real.py runs the same flow against the genuine library and
skips unless it is installed.
"""

from __future__ import annotations
import contextlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from pcc_plr_sidecar.backend_loader import _robot_serial as real_robot_serial  # before conftest stubs it
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


async def call_run(server: Server, out: Out, params: dict, msg_id: str = "1") -> dict:
    """backend.run as the TS adapter sends it: the job's recording window first. A run
    records only into its own job's window, opened beforehand (#502's evidence model)."""
    await call(server, out, "evidence.startRecording",
               {"deviceId": params["deviceId"], "jobId": params["jobId"]}, msg_id + "w")
    return await call(server, out, "backend.run", params, msg_id)


async def init(server: Server, out: Out, **config) -> dict:
    return await call(server, out, "backend.init", {"deviceId": "lh1", "plrBackend": "chatterbox", "backendConfig": config})


def _server():
    out = Out()
    return Server(stdout=out), out


# The OT-2 every test address reaches unless a test installs its own robots
# (conftest.py answers with it); an ot2 device names it as its robotSerial.
ROBOT = "OT2CEP20200217B03"


def _robots(monkeypatch, serial_by_host):
    """The robots on the test network: the serial each locator's robot-server reports."""
    from pcc_plr_sidecar import backend_loader

    asked = []

    def robot_serial(host, port):
        asked.append((host, port))
        if host not in serial_by_host:
            raise ValueError(f"no OT-2 answered at {host}:{port}")
        return serial_by_host[host]

    monkeypatch.setattr(backend_loader, "_robot_serial", robot_serial, raising=False)
    return asked


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
    resp = await call_run(s, out, {
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
    return await call_run(s, out, {
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
    other = await asyncio.wait_for(call_run(s, out, {
        "deviceId": "lh2", "jobId": "job-other", "protocolSource": "inline-ops", "protocolInline": [TRANSFER[0]],
    }, "31"), timeout=2.0)
    assert other["result"]["ok"] is True

    release.set()
    result_a = await task_a
    assert result_a["result"]["opCount"] == 4
    assert _calls(s) == ["setup", "pick_up_tips", "aspirate", "dispense", "return_tips"]

    # the lease is released, and the adapter closes A's window (#526: a device holds one
    # window at a time): B can run now
    await call(s, out, "evidence.stopRecording", {"deviceId": "lh1", "jobId": "job-x"}, "22")
    resp_b2 = await call_run(s, out, {
        "deviceId": "lh1", "jobId": "job-b", "protocolSource": "inline-ops", "protocolInline": [TRANSFER[0]],
    }, "21")
    assert resp_b2["result"]["opCount"] == 1, resp_b2


async def test_shutdown_waits_for_the_lease_holder_and_no_second_handle_loads_meanwhile(fake_plr):
    # R39 r3 review (CRIT2): while shutdown waits for a running job, the device's handle stays
    # in place, so a concurrent backend.init cannot build a second handle to the same hardware.
    import asyncio

    s, out = _server()
    await init(s, out, deckLayout=DECK)
    first = s.loader.get("lh1")
    entered, release = _block_pick_up_tips_on(first.machine)
    task_a = asyncio.create_task(_run(s, out, TRANSFER))
    await entered.wait()

    shutdown = asyncio.create_task(call(s, out, "backend.shutdown", {"deviceId": "lh1"}, "50"))
    for _ in range(20):
        await asyncio.sleep(0)
    assert not shutdown.done(), "shutdown did not wait for the lease holder"

    again = await asyncio.wait_for(call(s, out, "backend.init", {
        "deviceId": "lh1", "plrBackend": "chatterbox", "backendConfig": {"deckLayout": DECK},
    }, "51"), timeout=2.0)
    assert "error" in again, again
    assert s.loader.has("lh1") and s.loader.get("lh1") is first

    release.set()
    await asyncio.wait_for(task_a, timeout=2.0)
    await asyncio.wait_for(shutdown, timeout=2.0)
    assert not s.loader.has("lh1")


async def test_two_concurrent_inits_of_one_device_build_one_machine(fake_plr, monkeypatch):
    # R39 r3 review (CRIT2): load() awaits the machine's creation; a second init for the same
    # device in that window must not build a second machine for the same hardware.
    import asyncio
    from pcc_plr_sidecar import backend_loader

    real_create = backend_loader._create_machine
    created = []

    async def slow_create(*args, **kwargs):
        await asyncio.sleep(0)  # a real backend's setup can yield here
        result = await real_create(*args, **kwargs)
        created.append(result[0])
        return result

    monkeypatch.setattr(backend_loader, "_create_machine", slow_create)
    s, out = _server()
    params = {"deviceId": "lh1", "plrBackend": "chatterbox", "backendConfig": {"deckLayout": DECK}}
    first, second = await asyncio.gather(
        call(s, out, "backend.init", params, "60"), call(s, out, "backend.init", params, "61"),
    )
    assert len(created) == 1, f"{len(created)} machines built for one device"
    assert sum("error" in r for r in (first, second)) == 1, (first, second)
    busy = first if "error" in first else second
    assert busy["error"]["code"] == RPC_ERROR_CODES["DEVICE_BUSY"], busy


async def test_shutdown_during_setup_waits_and_no_second_machine_is_built(fake_plr, monkeypatch):
    # R39 r4 (CRIT2): setup is under the lease too. Shutdown waits for it, and a re-init while
    # setup is in flight builds no second machine.
    import asyncio
    from pcc_plr_sidecar import backend_loader

    real_create = backend_loader._create_machine
    machines = []
    setup_entered, setup_release = asyncio.Event(), asyncio.Event()

    async def create(*args, **kwargs):
        result = await real_create(*args, **kwargs)
        machine = result[0]
        machines.append(machine)
        if len(machines) == 1:
            original_setup = machine.setup

            async def blocked_setup(*a, **kw):
                setup_entered.set()
                await setup_release.wait()
                r = original_setup(*a, **kw)
                return (await r) if asyncio.iscoroutine(r) else r

            machine.setup = blocked_setup
        return result

    monkeypatch.setattr(backend_loader, "_create_machine", create)
    s, out = _server()
    params = {"deviceId": "lh1", "plrBackend": "chatterbox", "backendConfig": {"deckLayout": DECK}}
    first = asyncio.create_task(call(s, out, "backend.init", params, "70"))
    await asyncio.wait_for(setup_entered.wait(), timeout=2.0)
    shutdown = asyncio.create_task(call(s, out, "backend.shutdown", {"deviceId": "lh1"}, "71"))
    for _ in range(20):
        await asyncio.sleep(0)
    assert not shutdown.done(), "shutdown stopped the machine while its setup was in flight"
    again = await asyncio.wait_for(call(s, out, "backend.init", params, "72"), timeout=2.0)
    assert "error" in again, again
    assert len(machines) == 1, f"{len(machines)} machines for one device"
    setup_release.set()
    await asyncio.wait_for(first, timeout=2.0)
    await asyncio.wait_for(shutdown, timeout=2.0)


@pytest.mark.parametrize("second_url", ["10.0.0.5", "http://10.0.0.5:31950"])
async def test_two_device_ids_cannot_bind_one_ot2_endpoint(fake_plr, second_url):
    # R39 r4 (CRIT2): exclusivity is the physical robot, not the caller's deviceId.
    s, out = _server()
    a = await call(s, out, "backend.init", {"deviceId": "ot-a", "plrBackend": "ot2", "backendConfig": {
        "ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck")}}, "80")
    assert "error" not in a, a
    b = await call(s, out, "backend.init", {"deviceId": "ot-b", "plrBackend": "ot2", "backendConfig": {
        "ot2Url": second_url, "robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck")}}, "81")
    assert b.get("error", {}).get("code") == RPC_ERROR_CODES["DEVICE_BUSY"], b


async def test_two_sidecars_cannot_drive_one_ot2_until_the_first_lets_go(fake_plr):
    # R39 r4 (CRIT2): two sidecars (two Servers, each its own loader) on one host share an OS lock
    # per robot.
    s1, out1 = _server()
    s2, out2 = _server()
    cfg = {"ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck")}
    a = await call(s1, out1, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": cfg}, "82")
    assert "error" not in a, a
    b = await call(s2, out2, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": cfg}, "83")
    assert b.get("error", {}).get("code") == RPC_ERROR_CODES["DEVICE_BUSY"], b
    await call(s1, out1, "backend.shutdown", {"deviceId": "ot"}, "84")
    c = await call(s2, out2, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": cfg}, "85")
    assert "error" not in c, c


@pytest.mark.parametrize("first,second", [
    ({"host": "10.0.0.5"}, {"host": "10.0.0.5"}),
    ({"url": "http://10.0.0.5:31950"}, {"url": "http://10.0.0.5:31950"}),
    ({"ot2Url": "10.0.0.5"}, {"host": "10.0.0.5"}),
    ({"ot2Url": "10.0.0.5"}, {"url": "10.0.0.5:31950"}),
])
async def test_every_accepted_ot2_address_spelling_is_one_locked_endpoint(fake_plr, first, second):
    # R39 r5 (CRIT2): _create_ot2 accepts ot2Url, host and url; the endpoint lock must too.
    s, out = _server()
    deck = {"robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck")}
    a = await call(s, out, "backend.init", {"deviceId": "ot-a", "plrBackend": "ot2", "backendConfig": {**first, **deck}}, "86")
    assert "error" not in a, a
    b = await call(s, out, "backend.init", {"deviceId": "ot-b", "plrBackend": "ot2", "backendConfig": {**second, **deck}}, "87")
    assert b.get("error", {}).get("code") == RPC_ERROR_CODES["DEVICE_BUSY"], b


async def test_two_sidecars_cannot_drive_one_ot2_named_by_host(fake_plr):
    s1, out1 = _server()
    s2, out2 = _server()
    cfg = {"host": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck")}
    a = await call(s1, out1, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": cfg}, "88")
    assert "error" not in a, a
    b = await call(s2, out2, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": cfg}, "89")
    assert b.get("error", {}).get("code") == RPC_ERROR_CODES["DEVICE_BUSY"], b


# ── R39 r6 (CRIT2): the lock is the robot itself, not a spelling or a directory ──

@pytest.mark.parametrize("knob", ["PCC_PLR_LOCK_DIR", "tempdir"])
async def test_two_sidecars_configured_with_different_lock_dirs_share_one_robots_lock(fake_plr, tmp_path, monkeypatch, knob):
    # R39 r6 (CRIT2): no sidecar setting can split the lock namespace for one robot.
    import tempfile

    _robots(monkeypatch, {"10.0.0.5": ROBOT})
    cfg = {"ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck")}

    def configure(side):
        if knob == "PCC_PLR_LOCK_DIR":
            monkeypatch.setenv("PCC_PLR_LOCK_DIR", str(tmp_path / f"locks-{side}"))
        else:
            monkeypatch.delenv("PCC_PLR_LOCK_DIR", raising=False)
            (tmp_path / f"tmp-{side}").mkdir(exist_ok=True)
            monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / f"tmp-{side}"))

    s1, out1 = _server()
    configure("a")
    a = await call(s1, out1, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": cfg}, "100")
    assert "error" not in a, a
    s2, out2 = _server()
    configure("b")
    b = await call(s2, out2, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": cfg}, "101")
    assert b.get("error", {}).get("code") == RPC_ERROR_CODES["DEVICE_BUSY"], b


@pytest.mark.parametrize("first_host,second_host", [("ot2.local", "10.0.0.5"), ("10.0.0.5", "169.254.10.20")])
async def test_two_locators_of_one_robot_are_one_lock(fake_plr, monkeypatch, first_host, second_host):
    # R39 r6 (CRIT2): a hostname and its IP, or the robot's Wi-Fi and USB addresses, reach one
    # robot, so they are one lock, in one sidecar or two.
    _robots(monkeypatch, {first_host: ROBOT, second_host: ROBOT})
    deck = dict(DECK, type="OTDeck")
    s1, out1 = _server()
    s2, out2 = _server()
    a = await call(s1, out1, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "host": first_host, "robotSerial": ROBOT, "deckLayout": deck}}, "102")
    assert "error" not in a, a
    b = await call(s2, out2, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "host": second_host, "robotSerial": ROBOT, "deckLayout": deck}}, "103")
    assert b.get("error", {}).get("code") == RPC_ERROR_CODES["DEVICE_BUSY"], b
    c = await call(s1, out1, "backend.init", {"deviceId": "ot-2", "plrBackend": "ot2", "backendConfig": {
        "host": second_host, "robotSerial": ROBOT, "deckLayout": deck}}, "104")
    assert c.get("error", {}).get("code") == RPC_ERROR_CODES["DEVICE_BUSY"], c


async def test_an_ot2_device_must_name_its_robot(fake_plr, monkeypatch):
    # R39 r6: no robotSerial, or a malformed one, is refused before any lock, question or build.
    asked = _robots(monkeypatch, {"10.0.0.5": ROBOT})
    deck = dict(DECK, type="OTDeck")
    for bad in (None, "", " " + ROBOT, "OT2/../x", "x" * 65, 17):
        s, out = _server()
        cfg = {"ot2Url": "10.0.0.5", "deckLayout": deck}
        if bad is not None:
            cfg["robotSerial"] = bad
        resp = await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": cfg}, "110")
        assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
        assert "robotSerial" in resp["error"]["message"]
        assert not s.loader.has("ot")
    assert asked == [] and _deserialized(fake_plr) == []
    s, out = _server()  # and nothing was left locked
    ok = await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": deck}}, "111")
    assert "error" not in ok, ok
    assert ok["result"]["metadata"]["robotSerial"] == ROBOT
    assert asked == [("10.0.0.5", 31950)]


async def test_the_robot_at_the_address_must_be_the_configured_robot(fake_plr, monkeypatch):
    # R39 r6: a device configured with another serial for this robot gets its own lock name, but the
    # robot's own answer refuses it, so two configurations of one robot never both drive it.
    _robots(monkeypatch, {"10.0.0.5": ROBOT})
    deck = dict(DECK, type="OTDeck")
    other = {"host": "10.0.0.5", "robotSerial": "OT2CEM20210907A09", "deckLayout": deck}
    s1, out1 = _server()
    wrong = await call(s1, out1, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": other}, "112")
    assert wrong["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], wrong
    assert "reports serial number 'OT2CEP20200217B03'" in wrong["error"]["message"]
    assert not s1.loader.has("ot") and _deserialized(fake_plr) == []
    s2, out2 = _server()
    right = await call(s2, out2, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "host": "10.0.0.5", "robotSerial": ROBOT.lower(), "deckLayout": deck}}, "113")
    assert "error" not in right, right  # serials compare case-insensitively...
    again = await call(s1, out1, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": other}, "114")
    assert again["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], again
    same = await call(s1, out1, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": deck}}, "115")
    assert same["error"]["code"] == RPC_ERROR_CODES["DEVICE_BUSY"], same  # ...and lock as one robot


@pytest.mark.parametrize("failure", ["unreachable", "slow"])
async def test_a_robot_that_cannot_confirm_its_serial_is_never_driven(fake_plr, monkeypatch, failure):
    import time

    from pcc_plr_sidecar import backend_loader

    if failure == "unreachable":
        _robots(monkeypatch, {})
    else:
        monkeypatch.setattr(backend_loader, "ROBOT_IDENTITY_DEADLINE_S", 0.2)
        monkeypatch.setattr(backend_loader, "_robot_serial", lambda host, port: (time.sleep(1.0), ROBOT)[1])
    cfg = {"ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck")}
    s, out = _server()
    started = time.monotonic()
    resp = await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": cfg}, "116")
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    assert time.monotonic() - started < 0.9
    assert not s.loader.has("ot") and _deserialized(fake_plr) == []
    _robots(monkeypatch, {"10.0.0.5": ROBOT})  # its lock was released
    s2, out2 = _server()
    ok = await call(s2, out2, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": cfg}, "117")
    assert "error" not in ok, ok


# The lock namespace is the host's, and it is checked before it is trusted.

def test_the_lock_namespace_refuses_a_symlink_in_its_place(tmp_path, monkeypatch):
    from pcc_plr_sidecar import backend_loader

    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (tmp_path / "ns").symlink_to(elsewhere)
    monkeypatch.setattr(backend_loader, "_LOCK_NAMESPACE", str(tmp_path / "ns"))
    with pytest.raises(backend_loader.DeviceBusy, match="unusable"):
        backend_loader.EndpointLock.acquire("ot2-serial:x")
    assert list(elsewhere.iterdir()) == []


def _install_lock_dir(path, mode=0o700):
    path.mkdir()
    os.chmod(path, mode)
    return path


def test_a_missing_robot_lock_directory_refuses_hardware_and_is_never_created(tmp_path, monkeypatch):
    # R39 r7 (DECISIONS 10:24): the directory comes from the install, never from the first sidecar.
    from pcc_plr_sidecar import backend_loader

    missing = tmp_path / "not-installed"
    monkeypatch.setattr(backend_loader, "_LOCK_NAMESPACE", str(missing))
    with pytest.raises(backend_loader.DeviceBusy, match="comes from the install"):
        backend_loader.EndpointLock.acquire("ot2-serial:x")
    assert not missing.exists()


@pytest.mark.parametrize("mode", [0o777, 0o1777, 0o770, 0o720])
def test_a_robot_lock_directory_others_can_write_is_refused(tmp_path, monkeypatch, mode):
    from pcc_plr_sidecar import backend_loader

    ns = _install_lock_dir(tmp_path / "ns", mode)
    monkeypatch.setattr(backend_loader, "_LOCK_NAMESPACE", str(ns))
    with pytest.raises(backend_loader.DeviceBusy, match="not the install's 0700"):
        backend_loader.EndpointLock.acquire("ot2-serial:x")
    assert list(ns.iterdir()) == []
    import stat as st

    assert st.S_IMODE(ns.stat().st_mode) == mode  # never loosened or tightened by a sidecar


@pytest.mark.parametrize("mode", [0o755, 0o711, 0o1700, 0o750, 0o701])
def test_a_robot_lock_directory_must_be_exactly_the_installs_0700(tmp_path, monkeypatch, mode):
    # astra r7 (MEDIUM): the install prescribes 0700, and any other mode is the wrong mode.
    from pcc_plr_sidecar import backend_loader

    ns = _install_lock_dir(tmp_path / "ns", mode)
    monkeypatch.setattr(backend_loader, "_LOCK_NAMESPACE", str(ns))
    with pytest.raises(backend_loader.DeviceBusy, match="not the install's 0700"):
        backend_loader.EndpointLock.acquire("ot2-serial:x")
    assert list(ns.iterdir()) == []


def test_a_robot_lock_directory_of_another_user_is_refused(tmp_path, monkeypatch):
    from pcc_plr_sidecar import backend_loader

    ns = _install_lock_dir(tmp_path / "ns")
    monkeypatch.setattr(backend_loader, "_LOCK_NAMESPACE", str(ns))
    real_euid = os.geteuid()
    monkeypatch.setattr(os, "geteuid", lambda: real_euid + 1)  # as if another service user ran it
    with pytest.raises(backend_loader.DeviceBusy, match="not owned by this sidecar's service user"):
        backend_loader.EndpointLock.acquire("ot2-serial:x")


def test_lock_files_are_the_service_users_alone(tmp_path, monkeypatch):
    from pcc_plr_sidecar import backend_loader

    ns = _install_lock_dir(tmp_path / "ns")
    monkeypatch.setattr(backend_loader, "_LOCK_NAMESPACE", str(ns))
    old_umask = os.umask(0)
    try:
        lock = backend_loader.EndpointLock.acquire("ot2-serial:x")
    finally:
        os.umask(old_umask)
    try:
        import stat as st

        info = (ns / backend_loader._lock_file_name("ot2-serial:x")).stat()
        assert st.S_IMODE(info.st_mode) == 0o600 and info.st_uid == os.geteuid()
        assert st.S_IMODE(ns.stat().st_mode) == 0o700
    finally:
        lock.release()


def test_an_honest_sidecar_never_unlinks_or_recreates_its_lock_file(tmp_path, monkeypatch):
    # astra r6's unlink/recreate case, kept as an honest-sidecar regression (DECISIONS 10:24): no
    # sidecar removes a lock file, so a released lock and the next holder share one inode, and a
    # second holder can't exist while the first holds it.
    from pcc_plr_sidecar import backend_loader

    key = "ot2-serial:" + ROBOT.casefold()
    path = os.path.join(backend_loader._LOCK_NAMESPACE, backend_loader._lock_file_name(key))
    first = backend_loader.EndpointLock.acquire(key)
    inode = os.stat(path).st_ino
    with pytest.raises(backend_loader.DeviceBusy, match="already driven"):
        backend_loader.EndpointLock.acquire(key)
    first.release()
    assert os.stat(path).st_ino == inode  # still there, the same file
    again = backend_loader.EndpointLock.acquire(key)
    try:
        assert os.stat(path).st_ino == inode
    finally:
        again.release()
    assert os.stat(path).st_ino == inode


def test_a_lock_file_that_is_not_a_regular_file_is_refused_without_hanging(tmp_path, monkeypatch):
    import threading

    from pcc_plr_sidecar import backend_loader

    ns = _install_lock_dir(tmp_path / "ns")
    monkeypatch.setattr(backend_loader, "_LOCK_NAMESPACE", str(ns))
    key = "ot2-serial:x"
    lock_path = ns / backend_loader._lock_file_name(key)
    os.mkfifo(lock_path)
    outcome: list = []

    def acquire():
        try:
            backend_loader.EndpointLock.acquire(key)
            outcome.append("acquired")
        except backend_loader.DeviceBusy as e:
            outcome.append(str(e))

    worker = threading.Thread(target=acquire, daemon=True)
    worker.start()
    worker.join(timeout=5.0)
    assert not worker.is_alive(), "opening a FIFO lock file blocked"
    assert "not a regular file" in outcome[0], outcome
    lock_path.unlink()
    lock_path.symlink_to(tmp_path / "target")
    with pytest.raises(backend_loader.DeviceBusy, match="cannot lock"):
        backend_loader.EndpointLock.acquire(key)
    assert not (tmp_path / "target").exists()


# ── R39 r7 (astra r6): the lock object and the identity can't be substituted ──

async def test_r7_no_job_can_replace_a_running_jobs_window(fake_plr):
    # astra r6 HIGH (merge seam): open A's window, block A inside its run, open B's window,
    # release A: A's operations must stay bound to A.
    import asyncio

    s, out = _server()
    await init(s, out, deckLayout=DECK)
    entered, release = _block_pick_up_tips_on(s.loader.get("lh1").machine)
    task = asyncio.create_task(_run(s, out, TRANSFER))  # job-x
    await asyncio.wait_for(entered.wait(), timeout=2.0)
    await call(s, out, "evidence.startRecording", {"deviceId": "lh1", "jobId": "job-b"}, "122")
    window = s.evidence.get_window("lh1")
    release.set()
    await asyncio.wait_for(task, timeout=2.0)
    assert window is not None and window.job_id == "job-x", window


# ── #526 (sensors) on R39's harness ─────────────────────────────────────────
# #526's test_server.py versions slowed the stub with a __delay_ms op, which R39 refuses (astra r1
# on #378). The same assertions, with the run held inside pick_up_tips instead.

async def test_526_a_second_run_while_one_is_in_flight_on_the_device_is_refused(fake_plr):
    import asyncio

    s, out = _server()
    await init(s, out, deckLayout=DECK)
    entered, release = _block_pick_up_tips_on(s.loader.get("lh1").machine)
    task_a = asyncio.create_task(_run(s, out, TRANSFER))  # job-x
    await asyncio.wait_for(entered.wait(), timeout=2.0)
    second = await asyncio.wait_for(call(s, out, "backend.run", {
        "deviceId": "lh1", "jobId": "job-x", "protocolSource": "inline-ops", "protocolInline": [TRANSFER[0]],
    }, "130"), timeout=2.0)
    assert second["error"]["code"] == RPC_ERROR_CODES["DEVICE_BUSY"], second
    release.set()
    result_a = await asyncio.wait_for(task_a, timeout=2.0)
    assert result_a["result"]["ok"] is True and result_a["result"]["opCount"] == 4


async def test_526_a_running_jobs_window_is_neither_closed_nor_replaced_until_its_run_ends(fake_plr):
    import asyncio

    s, out = _server()
    await init(s, out, deckLayout=DECK)
    entered, release = _block_pick_up_tips_on(s.loader.get("lh1").machine)
    task_a = asyncio.create_task(_run(s, out, TRANSFER))  # job-x
    await asyncio.wait_for(entered.wait(), timeout=2.0)
    close_a = await call(s, out, "evidence.stopRecording", {"deviceId": "lh1", "jobId": "job-x"}, "131")
    open_b = await call(s, out, "evidence.startRecording", {"deviceId": "lh1", "jobId": "job-b"}, "132")
    assert close_a["error"]["code"] == RPC_ERROR_CODES["DEVICE_BUSY"], close_a
    assert open_b["error"]["code"] == RPC_ERROR_CODES["DEVICE_BUSY"], open_b
    release.set()
    await asyncio.wait_for(task_a, timeout=2.0)
    await asyncio_sleep_for_notifications()
    labelled = {m["params"].get("jobId") for m in out.messages() if m.get("method") == "evidence"}
    assert labelled == {"job-x"}, labelled
    after = await call(s, out, "evidence.stopRecording", {"deviceId": "lh1", "jobId": "job-x"}, "133")
    assert after["result"]["jobId"] == "job-x" and after["result"]["opCount"] == 4, after


# The identity check itself (the real _robot_serial, over HTTP on 127.0.0.1).

@contextlib.contextmanager
def _robot_server(routes):
    """An HTTP server on 127.0.0.1 answering routes {path: (status, headers, body)}; it records
    each request's path and headers."""
    import http.server
    import threading

    seen: list = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            seen.append((self.path, dict(self.headers)))
            status, headers, body = routes.get(self.path, (404, {}, b"{}"))
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1], seen
    finally:
        server.shutdown()
        server.server_close()


def _health(**fields) -> tuple:
    return (200, {"Content-Type": "application/json"}, json.dumps(fields).encode())


def test_the_identity_check_reads_the_robot_servers_serial():
    with _robot_server({"/health": _health(name="ot2", robot_serial=ROBOT)}) as (port, seen):
        assert real_robot_serial("127.0.0.1", port) == ROBOT
    assert [path for path, _ in seen] == ["/health"]
    assert seen[0][1].get("Opentrons-Version") == "*"


def test_the_identity_check_falls_back_to_the_update_servers_serial():
    routes = {"/health": _health(robot_serial=None), "/server/update/health": _health(serialNumber=ROBOT)}
    with _robot_server(routes) as (port, seen):
        assert real_robot_serial("127.0.0.1", port) == ROBOT
    assert [path for path, _ in seen] == ["/health", "/server/update/health"]


@pytest.mark.parametrize("routes, why", [
    ({"/health": _health(robot_serial=None), "/server/update/health": _health()}, "reports no serial"),
    ({"/health": _health(robot_serial=None)}, "HTTP 404"),
    ({"/health": _health(robot_serial="OT2 CEP")}, "malformed"),
    ({"/health": _health(robot_serial=17)}, "malformed"),
    ({"/health": (200, {}, b"[]")}, "JSON object"),
    ({"/health": (200, {}, b"not json")}, "did not answer JSON"),
    ({"/health": (200, {}, b"{" + b" " * 70_000 + b"}")}, "more than"),
    ({"/health": (500, {}, b"{}")}, "HTTP 500"),
    ({"/health": (302, {"Location": "/elsewhere"}, b"")}, "HTTP 302"),
])
def test_the_identity_check_refuses_anything_but_one_well_formed_serial(routes, why):
    routes = dict(routes, **{"/elsewhere": _health(robot_serial=ROBOT)})
    with _robot_server(routes) as (port, seen):
        with pytest.raises(ValueError, match=why):
            real_robot_serial("127.0.0.1", port)
    assert "/elsewhere" not in [path for path, _ in seen]  # a redirect is never followed


def test_the_identity_check_never_goes_through_a_proxy(monkeypatch):
    with _robot_server({}) as (proxy_port, proxy_seen):
        for name in ("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"):
            monkeypatch.setenv(name, f"http://127.0.0.1:{proxy_port}")
        for name in ("no_proxy", "NO_PROXY"):
            monkeypatch.delenv(name, raising=False)
        with _robot_server({"/health": _health(robot_serial=ROBOT)}) as (port, seen):
            assert real_robot_serial("127.0.0.1", port) == ROBOT
        assert proxy_seen == [] and [path for path, _ in seen] == ["/health"]


def test_the_identity_check_gives_up_on_a_robot_that_never_answers(monkeypatch):
    import socket

    from pcc_plr_sidecar import backend_loader

    monkeypatch.setattr(backend_loader, "ROBOT_IDENTITY_TIMEOUT_S", 0.3)
    silent = socket.socket()
    silent.bind(("127.0.0.1", 0))
    silent.listen(1)
    try:
        with pytest.raises(ValueError, match="failed"):
            real_robot_serial("127.0.0.1", silent.getsockname()[1])
    finally:
        silent.close()


async def test_tips_can_be_dropped_into_a_named_spot(fake_plr):
    s, out = _server()
    await init(s, out, deckLayout=DECK)
    resp = await _run(s, out, [TRANSFER[0], {"op": "dropTips", "tipRack": "tips", "tipSpot": "A2", "channel": 0}])
    assert resp["result"]["opCount"] == 2
    lh = s.loader.get("lh1").machine
    assert lh.calls[-1] == ("drop_tips", ["A2"], [0])


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
    resp = await call_run(s, out, {
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
        "ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck")}})
    await call(s, out, "evidence.startRecording", {"deviceId": "ot", "jobId": "j"}, "3b")
    run = await call_run(s, out, {
        "deviceId": "ot", "jobId": "j", "protocolSource": "inline-ops", "protocolInline": [TRANSFER[0]]}, "4")
    # never "hardware": no hardware-identity provenance check exists yet (D1 #19).
    assert run["result"]["executionMode"] == "unverified"
    await asyncio_sleep_for_notifications()
    ot_events = [m["params"] for m in out.messages() if m.get("method") == "evidence" and m["params"]["type"] == "pickUpTips"]
    assert len(ot_events) == 1 and ot_events[0]["payload"]["executionMode"] == "unverified"
    assert ot_events[0]["payload"]["mock"] is True  # unverified is never physical evidence either

    s, out = _server()
    await call(s, out, "backend.init", {"deviceId": "st", "plrBackend": "stub", "backendConfig": {}})
    stub = await call_run(s, out, {
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
    resp = await call_run(s, out, {
        "deviceId": "st", "jobId": "j", "protocolSource": "inline-ops", "protocolInline": bad_inline,
    }, "6")
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    await asyncio_sleep_for_notifications()
    assert not any(m.get("method") == "evidence" for m in out.messages())


async def test_a_valid_stub_protocol_still_runs_as_before(fake_plr):
    s, out = await _stub_server()
    resp = await call_run(s, out, {
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
        "ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": layout}})
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


# ── R39 MED8: a TOCTOU gap in the layout-file check ─────────────────────────

async def test_a_symlink_swapped_in_after_the_boundary_check_is_refused_not_read(fake_plr, tmp_path, monkeypatch):
    layouts = tmp_path / "layouts"
    layouts.mkdir()
    inside = layouts / "deck.json"
    inside.write_text(json.dumps(DECK))
    # A distinctly-named, otherwise-valid deck "outside" the allowed directory
    # -- if the TOCTOU gap is open, this is what gets read and loaded, with NO
    # error at all (it's a perfectly valid Deck, just not the checked one).
    outside = tmp_path / "secret.json"
    outside.write_text(json.dumps(dict(DECK, name="leaked-outside-deck", children=[])))

    import os as os_module

    monkeypatch.setenv("PCC_PLR_LAYOUT_DIR", str(layouts))
    expected_real = os_module.path.realpath(str(inside))
    original_realpath = os_module.path.realpath
    state = {"swapped": False}

    def racy_realpath(p, *a, **kw):
        # Resolve exactly as before, then -- as a side effect, simulating a
        # racing process -- swap the checked file for a symlink pointing
        # outside PCC_PLR_LAYOUT_DIR, AFTER the boundary check has already
        # computed its (pre-swap) answer but BEFORE the file is read.
        result = original_realpath(p, *a, **kw)
        if not state["swapped"] and result == expected_real:
            state["swapped"] = True
            inside.unlink()
            inside.symlink_to(outside)
        return result

    monkeypatch.setattr(os_module.path, "realpath", racy_realpath)
    s, out = _server()
    resp = await init(s, out, deckLayoutPath="deck.json")
    assert resp["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    assert _deserialized(fake_plr) == []  # the outside content never reached the deserializer


async def test_a_directory_swapped_for_a_symlink_after_the_boundary_check_is_refused_not_read(fake_plr, tmp_path, monkeypatch):
    # R39 r3 review (MED8): O_NOFOLLOW guards only the LAST component. An intermediate directory
    # swapped for a symlink after the check must not lead the read outside PCC_PLR_LAYOUT_DIR.
    import os as os_module

    layouts = tmp_path / "layouts"
    sub = layouts / "sub"
    sub.mkdir(parents=True)
    inside = sub / "deck.json"
    inside.write_text(json.dumps(DECK))
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "deck.json").write_text(json.dumps(dict(DECK, name="leaked-outside-deck", children=[])))

    monkeypatch.setenv("PCC_PLR_LAYOUT_DIR", str(layouts))
    expected_real = os_module.path.realpath(str(inside))
    original_realpath = os_module.path.realpath
    state = {"swapped": False}

    def racy_realpath(p, *a, **kw):
        result = original_realpath(p, *a, **kw)
        if not state["swapped"] and result == expected_real:
            state["swapped"] = True
            os_module.rename(str(sub), str(tmp_path / "sub-moved"))
            os_module.symlink(str(elsewhere), str(sub))
        return result

    monkeypatch.setattr(os_module.path, "realpath", racy_realpath)
    s, out = _server()
    resp = await init(s, out, deckLayoutPath="sub/deck.json")
    assert resp.get("error", {}).get("code") == RPC_ERROR_CODES["INVALID_PARAMS"], resp
    assert _deserialized(fake_plr) == []


async def test_the_directory_swap_is_refused_where_there_is_no_proc(fake_plr, tmp_path, monkeypatch):
    # R39 r4 (MED8): the same intermediate-directory swap, on a platform without /proc/self/fd.
    import os as os_module

    real_isdir = os_module.path.isdir
    monkeypatch.setattr(os_module.path, "isdir", lambda p: False if str(p).startswith("/proc") else real_isdir(p))
    await test_a_directory_swapped_for_a_symlink_after_the_boundary_check_is_refused_not_read(fake_plr, tmp_path, monkeypatch)


async def test_a_layout_root_swapped_for_a_symlink_after_the_check_is_refused(fake_plr, tmp_path, monkeypatch):
    # R39 r5 (MED8): the anchor itself. PCC_PLR_LAYOUT_DIR renamed away and replaced by a symlink
    # to an outside directory holding the same relative path, after realpath().
    import os as os_module

    layouts = tmp_path / "layouts"
    layouts.mkdir()
    (layouts / "deck.json").write_text(json.dumps(DECK))
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "deck.json").write_text(json.dumps(dict(DECK, name="leaked-outside-deck", children=[])))
    monkeypatch.setenv("PCC_PLR_LAYOUT_DIR", str(layouts))
    expected_real = os_module.path.realpath(str(layouts / "deck.json"))
    original_realpath = os_module.path.realpath
    state = {"swapped": False}

    def racy_realpath(p, *a, **kw):
        result = original_realpath(p, *a, **kw)
        if not state["swapped"] and result == expected_real:
            state["swapped"] = True
            os_module.rename(str(layouts), str(tmp_path / "layouts-moved"))
            os_module.symlink(str(elsewhere), str(layouts))
        return result

    monkeypatch.setattr(os_module.path, "realpath", racy_realpath)
    s, out = _server()
    resp = await init(s, out, deckLayoutPath="deck.json")
    assert resp.get("error", {}).get("code") == RPC_ERROR_CODES["INVALID_PARAMS"], resp
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
            "ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck"), "tracking": tracking}})
        assert hw["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], hw
    for bad in ({"tips": "yes"}, {"speed": True}, ["tips"]):
        s, out = _server()
        assert (await init(s, out, deckLayout=DECK, tracking=bad))["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]



# ── R39 CRIT3: PLR tracking is not process-global across hardware + simulators ─

async def test_loading_a_simulator_cannot_weaken_tracking_while_hardware_is_loaded(fake_plr):
    from pylabrobot.resources import TRACKING

    s, out = _server()
    await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck")}})
    assert TRACKING == {"tips": True, "volume": True}

    weakened = await call(s, out, "backend.init", {"deviceId": "lh1", "plrBackend": "chatterbox", "backendConfig": {
        "deckLayout": DECK, "tracking": {"volume": False}}})
    assert weakened["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"], weakened
    assert not s.loader.has("lh1")  # the simulator never finished loading either
    assert TRACKING == {"tips": True, "volume": True}  # the switches stayed ON

    run = await call_run(s, out, {
        "deviceId": "ot", "jobId": "job-1", "protocolSource": "inline-ops", "protocolInline": [TRANSFER[0]],
    }, "9")
    assert run["result"]["ok"] is True, run  # the ot2 run still sees tracking ON
    assert TRACKING == {"tips": True, "volume": True}


async def test_an_ot2_run_reasserts_tracking_even_if_something_flipped_it(fake_plr):
    from pylabrobot.resources import TRACKING, set_volume_tracking

    s, out = _server()
    await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck")}})
    # Something flipped the global switch between runs (a race, a bug, a future
    # code path -- CRIT3 doesn't need to know what).
    set_volume_tracking(False)
    assert TRACKING["volume"] is False

    run = await call_run(s, out, {
        "deviceId": "ot", "jobId": "job-1", "protocolSource": "inline-ops", "protocolInline": [TRANSFER[0]],
    }, "9")
    assert run["result"]["ok"] is True, run
    assert TRACKING == {"tips": True, "volume": True}  # re-asserted before the run


async def test_an_ot2_run_refuses_if_tracking_cannot_be_verified(fake_plr, monkeypatch):
    import pylabrobot.resources as plr_resources

    s, out = _server()
    await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {
        "ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck")}})
    monkeypatch.setattr(plr_resources, "does_volume_tracking", lambda: False)
    run = await call_run(s, out, {
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
    resp = await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {"ot2Url": url, "robotSerial": ROBOT, "deckLayout": ot_deck}})
    assert "error" not in resp, resp
    backend = s.loader.get("ot").machine.backend
    assert type(backend).__name__ == "OpentronsOT2Backend"
    assert (backend.host, backend.port) == (host, port)


async def test_ot2_needs_a_url_and_an_ot_deck(fake_plr):
    s, out = _server()
    no_url = await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {"robotSerial": ROBOT, "deckLayout": dict(DECK, type="OTDeck")}})
    assert no_url["error"]["code"] == RPC_ERROR_CODES["INVALID_PARAMS"]
    s, out = _server()
    plain = await call(s, out, "backend.init", {"deviceId": "ot", "plrBackend": "ot2", "backendConfig": {"ot2Url": "10.0.0.5", "robotSerial": ROBOT, "deckLayout": DECK}})
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
