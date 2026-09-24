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

from pcc_plr_sidecar.dispatcher import RPC_ERROR_CODES
from pcc_plr_sidecar.server import Server

FAKE_DIR = Path(__file__).parent / "fake_plr"
PYTHON_DIR = Path(__file__).parent.parent

DECK = {
    "type": "Deck",
    "name": "deck",
    "children": [
        {"type": "TipRack", "name": "tips", "spots": ["A1", "A2"]},
        {"type": "Plate", "name": "src", "wells": {"A1": 150.0}},
        {"type": "Plate", "name": "dst", "wells": {"A1": 0.0}},
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


async def test_init_loads_a_layout_file(fake_plr, tmp_path):
    path = tmp_path / "deck.json"
    path.write_text(json.dumps(DECK))
    s, out = _server()
    resp = await init(s, out, deckLayoutPath=str(path))
    assert resp["result"]["ok"] is True


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


async def test_a_missing_labware_fails_loud_and_changes_nothing(fake_plr):
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
    assert err["data"]["opsCompleted"] == 1
    lh = s.loader.get("lh1").machine
    assert [c[0] for c in lh.calls] == ["setup", "pick_up_tips"]
    assert lh.deck.get_resource("src")["A1"].volume == 150.0


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


async def test_tips_can_be_dropped_into_a_named_spot(fake_plr):
    s, out = _server()
    await init(s, out, deckLayout=DECK)
    resp = await _run(s, out, [TRANSFER[0], {"op": "dropTips", "tipRack": "tips", "tipSpot": "A2", "channel": 0}])
    assert resp["result"]["opCount"] == 2
    lh = s.loader.get("lh1").machine
    assert lh.calls[-1] == ("drop_tips", ["A2"], [0])


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
