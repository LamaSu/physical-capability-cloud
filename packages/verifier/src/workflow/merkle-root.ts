/**
 * Deterministic Merkle root over an ordered list of checkpoint hashes
 * (frozen protocol v3, §3.3 of the §8.5 step-6 build spec; §8.4-B-2).
 *
 * This root is the §8.3 `evidenceRoot` of a FinalMilestonePackage. It is
 * RECOMPUTED by the oracle (step 10) and ANCHORED ON-CHAIN (O5). Any silent
 * divergence between this implementation and the oracle's is a settlement fork,
 * so the rules below are exact and each is documented; do not "optimize" them.
 *
 * ALGORITHM (byte-exact — implementations must agree bit-for-bit):
 *   1. Operate over the checkpoint hashes IN THE GIVEN SEQ ORDER. NEVER sort:
 *      order is part of the chain's meaning (checkpoint 3 following checkpoint 2
 *      is a fact the root commits to). This is the deliberate difference from a
 *      sorted-pair tree (cf. packages/aggregator/src/merkle.ts, which sorts for
 *      OZ-style on-chain proofs — a different contract, keccak + 0x output).
 *   2. LEAVES = the raw 32-byte hash VALUES. Each input string is a
 *      `sha256:<64-hex>` (the prefix is stripped if present) or a bare 64-hex;
 *      it is hex-decoded to a 32-byte Buffer. Each leaf is validated as exactly
 *      64 hex chars → 32 bytes; anything else THROWS (fail closed — a malformed
 *      leaf must never silently truncate into a valid-looking root, which
 *      `Buffer.from(hex, "hex")` would otherwise do).
 *   3. PAIR left-to-right: parent = sha256( left ‖ right ) over the two raw
 *      32-byte buffers concatenated (NOT over their hex strings).
 *   4. ODD node at any level is PROMOTED UNCHANGED to the next level — NO
 *      duplication. This is deliberately NOT Bitcoin-style (which duplicates the
 *      last node) and is therefore immune to the CVE-2012-2459 duplicate-leaf
 *      root-ambiguity class.
 *   5. SINGLE leaf → the root IS that leaf (its 32 bytes, re-encoded as
 *      `sha256:<lower-hex>`). "Unchanged" refers to the 32-byte VALUE, not the
 *      exact input formatting: the prefix is normalized and hex is lower-cased so
 *      a single-leaf root is byte-identical to how the same value appears anywhere
 *      else in the tree.
 *   6. EMPTY input → THROWS. A package with zero checkpoints is invalid
 *      (§8.4-B-1); there is no meaningful root for it.
 *
 * RETURNS `sha256:<hex>` — lower-case hex of the final 32-byte root.
 *
 * PURE: no I/O, deterministic — the same ordered inputs always produce the same
 * root. Beside `sequence-acceptance.ts` under the same "pure logic in verifier,
 * state in gateway" split.
 */

import { createHash } from "node:crypto";

/** Optional `sha256:` prefix followed by exactly 64 hex chars (case-insensitive). */
const LEAF_HASH_RE = /^(?:sha256:)?([0-9a-fA-F]{64})$/;

/**
 * Decode one checkpoint hash string to its raw 32-byte value, failing closed on
 * anything that is not exactly 64 hex chars (optionally `sha256:`-prefixed).
 * The regex guard is load-bearing: `Buffer.from(hex, "hex")` silently drops
 * invalid/odd nibbles, so validation must happen BEFORE the decode.
 */
function decodeLeaf(hash: string): Buffer {
  const match = typeof hash === "string" ? LEAF_HASH_RE.exec(hash) : null;
  if (!match) {
    throw new Error(
      `merkleRoot: malformed leaf hash ${JSON.stringify(hash)} — ` +
        `expected 64 hex chars (optionally "sha256:"-prefixed)`,
    );
  }
  const buf = Buffer.from(match[1], "hex");
  // Defensive belt-and-suspenders: 64 hex chars decode to exactly 32 bytes.
  if (buf.length !== 32) {
    throw new Error(
      `merkleRoot: leaf hash decoded to ${buf.length} bytes, expected 32`,
    );
  }
  return buf;
}

/** sha256 of a raw buffer, returned as a raw 32-byte Buffer (for parent nodes). */
function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

/**
 * Compute the deterministic Merkle root of `hashes` per §3.3 (see file header).
 *
 * @param hashes checkpoint hashes in seq order (NOT sorted).
 * @returns `sha256:<lower-hex>` of the 32-byte root.
 * @throws if `hashes` is empty or any leaf is not a 32-byte hex value.
 */
export function merkleRoot(hashes: string[]): string {
  // Rule 6: empty → invalid package, no root.
  if (hashes.length === 0) {
    throw new Error(
      "merkleRoot: empty checkpoint set — a package with zero checkpoints is invalid (§8.4-B-1)",
    );
  }

  // Rule 2: decode leaves in the GIVEN order (rule 1: never sort).
  let level: Buffer[] = hashes.map(decodeLeaf);

  // Rules 3 + 4: pair left-to-right; promote an odd trailing node unchanged.
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256(Buffer.concat([level[i], level[i + 1]])));
      } else {
        // Odd node promoted UNCHANGED (no duplication).
        next.push(level[i]);
      }
    }
    level = next;
  }

  // Rule 5 (single leaf falls straight through here) + return contract.
  return `sha256:${level[0].toString("hex")}`;
}
