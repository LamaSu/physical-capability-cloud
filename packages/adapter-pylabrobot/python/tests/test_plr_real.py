"""R39 against the genuine pylabrobot library (skipped unless it is installed).

The status board's acceptance for R39: the sidecar drives a populated deck on
LiquidHandlerChatterboxBackend, and a missing resource fails loud. This file
builds a real PLR deck, serializes it (the layout a kit would ship), and drives
it through the sidecar with PLR's own tip and volume tracking switched on.

It skips on machines without pylabrobot (the goal's clean-room rule forbids
fetching it without an operator decision), and it never runs against the
tests/fake_plr stand-in.
"""

from __future__ import annotations
import json
import sys

import pytest

from pcc_plr_sidecar.dispatcher import RPC_ERROR_CODES
from pcc_plr_sidecar.server import Server

if getattr(sys.modules.get("pylabrobot"), "PCC_FAKE", False):
    for _name in [n for n in sys.modules if n == "pylabrobot" or n.startswith("pylabrobot.")]:
        del sys.modules[_name]
plr = pytest.importorskip("pylabrobot")
if getattr(plr, "PCC_FAKE", False):
    pytest.skip("the genuine pylabrobot is not installed (found the test fake)", allow_module_level=True)

from pylabrobot.resources import (  # noqa: E402
    Coordinate,
    Cor_96_wellplate_360ul_Fb,
    Deck,
    opentrons_96_tiprack_300ul,
    set_tip_tracking,
    set_volume_tracking,
)


class Out:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def write(self, s: str) -> None:
        self.lines.extend(p for p in s.split("\n") if p)

    def flush(self) -> None:
        pass


def _layout() -> dict:
    deck = Deck(size_x=600, size_y=400, size_z=200)
    deck.assign_child_resource(opentrons_96_tiprack_300ul("tips"), location=Coordinate(20, 20, 0))
    deck.assign_child_resource(Cor_96_wellplate_360ul_Fb("src"), location=Coordinate(200, 20, 0))
    deck.assign_child_resource(Cor_96_wellplate_360ul_Fb("dst"), location=Coordinate(380, 20, 0))
    return deck.serialize()


async def _call(server: Server, out: Out, method: str, params: dict, msg_id: str) -> dict:
    out.lines.clear()
    await server.handle_line(json.dumps({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}))
    return next(m for m in map(json.loads, out.lines) if m.get("id") == msg_id)


@pytest.fixture
def tracking():
    set_tip_tracking(True)
    set_volume_tracking(True)
    yield
    set_tip_tracking(False)
    set_volume_tracking(False)


async def test_sidecar_drives_a_populated_deck_on_the_chatterbox(tracking):
    out = Out()
    server = Server(stdout=out)
    init = await _call(server, out, "backend.init", {
        "deviceId": "lh1", "plrBackend": "chatterbox", "backendConfig": {"deckLayout": _layout()},
    }, "1")
    assert init["result"]["ok"] is True
    lh = server.loader.get("lh1").machine
    src_well = lh.deck.get_resource("src")["A1"][0]
    dst_well = lh.deck.get_resource("dst")["A1"][0]
    src_well.tracker.set_liquids([(None, 200)])

    run = await _call(server, out, "backend.run", {
        "deviceId": "lh1", "jobId": "job-1", "protocolSource": "inline-ops",
        "protocolInline": [
            {"op": "pickUpTips", "tipRack": "tips", "tipSpot": "A1", "channel": 0},
            {"op": "aspirate", "labwareId": "src", "well": "A1", "volume_uL": 100, "channel": 0},
            {"op": "dispense", "labwareId": "dst", "well": "A1", "volume_uL": 100, "channel": 0},
            {"op": "dropTips", "channel": 0},
        ],
    }, "2")
    assert run["result"]["opCount"] == 4
    assert src_well.tracker.get_used_volume() == pytest.approx(100)
    assert dst_well.tracker.get_used_volume() == pytest.approx(100)


async def test_a_missing_resource_fails_loud_on_the_real_library():
    out = Out()
    server = Server(stdout=out)
    await _call(server, out, "backend.init", {
        "deviceId": "lh1", "plrBackend": "chatterbox", "backendConfig": {"deckLayout": _layout()},
    }, "1")
    run = await _call(server, out, "backend.run", {
        "deviceId": "lh1", "jobId": "job-2", "protocolSource": "inline-ops",
        "protocolInline": [{"op": "aspirate", "labwareId": "no_such_plate", "well": "A1", "volume_uL": 10}],
    }, "2")
    assert run["error"]["code"] == RPC_ERROR_CODES["NON_RETRYABLE"]
    assert run["error"]["data"]["missingResource"] == "no_such_plate"
