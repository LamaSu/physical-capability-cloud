"""Guards the committed oracle cross-language fixture (fixtures/ed25519-chain-
fixture.json): it must stay internally valid -- recomputable hashes, a linked
chain, and Python signatures that verify against the embedded publicKey.

This is the Python-side proxy for the wave-2 oracle (TS/@noble) cross-language
check: exactly the three things the oracle's #52 verifier does.
"""

import json
from pathlib import Path

import pytest

from pcc_node.log_capture import GENESIS, compute_entry_hash, _HAS_NACL

_FIX = Path(__file__).resolve().parent / "fixtures" / "ed25519-chain-fixture.json"
ORACLE_GOLDEN = (
    "sha256:c31408369756b766d5ee02b1403cbee4ab64ed39f9c3de0b7bee4605fdf3d9cd"
)


def test_fixture_present():
    assert _FIX.exists(), "run: python tests/gen_chain_fixture.py"


@pytest.mark.skipif(not _HAS_NACL, reason="pynacl required")
def test_chain_fixture_verifies_end_to_end():
    import nacl.signing

    with open(_FIX, encoding="utf-8") as f:
        fixture = json.load(f)

    pub = fixture["publicKey"]
    assert pub.startswith("0x") and len(pub) == 66  # "0x" + 64 hex
    vk = nacl.signing.VerifyKey(bytes.fromhex(pub[2:]))

    events = fixture["events"]
    assert len(events) >= 2

    prev = GENESIS
    for i, ev in enumerate(events):
        assert ev["type"] == "log_hash_chain_entry", f"event {i} wrong type"
        p = ev["payload"]
        # 1. entryHash recomputes from the content fields (canonical parity).
        assert p["entryHash"] == compute_entry_hash(
            p["rawContent"], p["source"], p["capturedAt"]
        ), f"event {i} entryHash mismatch"
        # 2. chain linkage: GENESIS then prior entryHash.
        assert p["previousHash"] == prev, f"event {i} chain link broken"
        prev = p["entryHash"]
        # 3. signer/algorithm + signature over the entryHash STRING (oracle rule).
        ks = p["kernelSignature"]
        assert ks["algorithm"] == "ed25519"
        assert ks["signer"].lower() == pub.lower()
        vk.verify(p["entryHash"].encode("utf-8"), bytes.fromhex(ks["value"]))

    # entry 0 is the oracle's own golden -> the oracle can cross-check it.
    assert events[0]["payload"]["entryHash"] == ORACLE_GOLDEN
