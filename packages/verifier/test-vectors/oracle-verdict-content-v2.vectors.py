#!/usr/bin/env python3
"""
Independent stdlib cross-check of oracle-verdict-content-v2.vectors.json (the OracleVerdictContent v2
/ dealBinding addendum — evidence lane's ruling on oracle N37, bus #4879). Public test data tooling.

Standard library only (hashlib, json, os, sys), so it runs anywhere; it is NOT wired into CI. It does
NOT import the sibling .cjs generator -- it re-derives everything from the JSON ONLY, independently of
the JS that produced it, the same relationship composition's accepted-deal-v3.vectors.py has to its
sibling .json (this file mirrors that script's shape deliberately):

  * verdictHash = SHA-256(JCS(content)) for the v1, v2-null, and v2-dealBinding fixtures, and for
    every negative vector (each negative carries its own recomputed hash so it is shown to fail for
    its STATED reason, not a coincidental stale-hash mismatch -- the seam's own §17.7 discipline);
  * dependencySetHash re-spelling for composition's node P: the CORRECT preimage (dealDigest embedded
    0x-spelled) recomputes composition's published value byte-for-byte; the WRONG preimage (dealDigest
    left sha256:-spelled -- THE TRAP) recomputes a DIFFERENT, non-matching hash.

JCS here = RFC 8785 restricted to the subset OracleVerdictContent ever carries: null, bool, safe
integer, string, array (order preserved), object (keys sorted). Python's json.dumps(sort_keys=True)
sorts by code point, which equals UTF-16 code-unit order for the printable-ASCII strings this content
uses throughout (hex digests, hex addresses, node ids) -- never a locale compare. Exit status 0 only
if every check passes.
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VECTOR = os.path.join(HERE, "oracle-verdict-content-v2.vectors.json")


def canonical(v):
    """RFC 8785 JCS, restricted subset: keys sorted at every depth, no whitespace, arrays in the
    order given, numbers unquoted. Mirrors the .cjs sibling's canonicalize() and the production
    packages/spec/src/util/canonical.ts#canonicalize."""
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def verdict_hash(content) -> str:
    return "sha256:" + sha256_hex(canonical(content))


failures = []


def check(label, ok, detail=""):
    print(("  ok   " if ok else "  FAIL ") + label + ("" if ok else f"  {detail}"))
    if not ok:
        failures.append(label)


def main():
    v = json.load(open(VECTOR, encoding="utf-8"))

    print("verdictHash recompute (v1 / v2-null / v2-dealBinding)")
    for key in ("v1", "v2Null", "v2DealBinding"):
        entry = v[key]
        got = verdict_hash(entry["content"])
        check(f"{key} verdictHash == stored", got == entry["verdictHash"], got)

    print("key-presence invariant (structural sanity -- the v2 bump's core rule)")
    check("v1 content has NO dealBinding key", "dealBinding" not in v["v1"]["content"])
    check(
        "v2Null content carries dealBinding: null (present, not absent)",
        "dealBinding" in v["v2Null"]["content"] and v["v2Null"]["content"]["dealBinding"] is None,
    )
    check(
        "v2DealBinding content carries a dealBinding object",
        isinstance(v["v2DealBinding"]["content"].get("dealBinding"), dict),
    )

    print("dependencySetHash re-spelling -- THE TRAP, worked over composition's node P")
    d = v["dependencySetHashCheck"]
    correct_preimage = canonical(
        {"domain": "PCC:dependency-set:v1", "dealDigest": d["dealDigest0x"], "nodeId": d["node"], "requires": d["requires"]}
    )
    correct_hash = "0x" + sha256_hex(correct_preimage)
    check("preimageCorrect (JSON) matches the stored preimage string", correct_preimage == d["preimageCorrect"])
    check("recomputed 0x hash matches the stored recompute", correct_hash == d["recomputed0x"], correct_hash)
    check(
        "recomputed 0x hash matches composition's published node-P value (external parity)",
        correct_hash == d["expectedFromComposition0x"],
        correct_hash,
    )

    wrong_preimage = canonical(
        {"domain": "PCC:dependency-set:v1", "dealDigest": d["dealDigestSha256"], "nodeId": d["node"], "requires": d["requires"]}
    )
    wrong_hash = "0x" + sha256_hex(wrong_preimage)
    check("preimageWrongSpelling (JSON) matches the stored preimage string", wrong_preimage == d["preimageWrongSpelling"])
    check("wrong-spelling hash matches the stored recompute", wrong_hash == d["recomputedWrongSpelling0x"], wrong_hash)
    check(
        "wrong-spelling hash != composition's published value (the trap, confirmed)",
        wrong_hash != d["expectedFromComposition0x"],
        wrong_hash,
    )
    check("wrong-spelling hash != the correct recompute", wrong_hash != correct_hash)

    print("negatives: each recomputed independently (must fail for its OWN stated reason)")
    for n in v["negatives"]:
        got = verdict_hash(n["content"])
        check(f"{n['name']}: verdictHash == stored", got == n["verdictHash"], got)
        check(f"{n['name']}: expected.refused is true", n["expected"]["refused"] is True)

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s): " + "; ".join(failures))
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
