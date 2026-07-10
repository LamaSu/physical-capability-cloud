"""Deterministic producer fixture for the oracle cross-language #52 test (wave 2).

Runs the pcc-node Ed25519 producer with a HARDCODED seed to emit a chain of
``log_hash_chain_entry`` events that the oracle (TS / @noble) will verify
byte-for-byte:

  - recompute each entryHash from ``{capturedAt, rawContent, source}``
  - check chain linkage (GENESIS, then the prior entryHash)
  - verify each kernelSignature over the entryHash STRING against ``publicKey``

Ed25519 signing is deterministic (RFC 8032 -- no per-signature randomness), so
this fixture is byte-reproducible: re-running regenerates the identical file.

Run:  python packages/pcc-node/tests/gen_chain_fixture.py
"""

import json
import sys
from pathlib import Path

# Ensure the LOCAL package source wins over any pip-installed copy, regardless of
# how this script is invoked (packages/pcc-node is parents[1] of this file).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import nacl.encoding
import nacl.signing

from pcc_node.log_capture import GENESIS, LogCapture

# 32-byte deterministic test seed. NOT a production key -- fixture use only.
SEED_HEX = "deadbeef" * 8

# entry 0 == the oracle's own golden vector (log-chain-parity.test.ts:51), so the
# oracle can additionally assert events[0].entryHash against a value it already
# pins independently of this fixture.
ORACLE_GOLDEN = (
    "sha256:c31408369756b766d5ee02b1403cbee4ab64ed39f9c3de0b7bee4605fdf3d9cd"
)

ENTRIES = [
    {"rawContent": "hello", "source": "cups://job-1", "capturedAt": "2026-07-09T00:00:00.000Z"},
    {"rawContent": "world", "source": "cups://job-1", "capturedAt": "2026-07-09T00:01:00.000Z"},
    # A non-ASCII line proves unicode canonical parity end-to-end through the
    # signature (Python-signed -> noble-verified).
    {"rawContent": "café ☕ 日本語 — naïve", "source": "cups://job-1", "capturedAt": "2026-07-09T00:02:00.000Z"},
]


def build():
    sk = nacl.signing.SigningKey(bytes.fromhex(SEED_HEX))
    pub_hex = sk.verify_key.encode(nacl.encoding.HexEncoder).decode("ascii")
    cap = LogCapture("0x" + pub_hex, SEED_HEX)
    events = [
        cap.capture(e["rawContent"], e["source"], e["capturedAt"], entry_id=f"e{i}")
        for i, e in enumerate(ENTRIES)
    ]
    return {"publicKey": "0x" + pub_hex, "events": events}


def main():
    fixture = build()
    # Self-checks BEFORE writing -- fail closed rather than ship a bad fixture.
    ev0 = fixture["events"][0]["payload"]
    assert ev0["entryHash"] == ORACLE_GOLDEN, f"entry0 != oracle golden: {ev0['entryHash']}"
    assert ev0["previousHash"] == GENESIS

    out = Path(__file__).resolve().parent / "fixtures" / "ed25519-chain-fixture.json"
    out.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("wrote", out)
    print("publicKey", fixture["publicKey"])
    print("events", len(fixture["events"]))
    print("entry0 entryHash", ev0["entryHash"], "== oracle golden OK")


if __name__ == "__main__":
    main()
