/**
 * Sorted-pair keccak Merkle tree — matches OpenZeppelin's MerkleProof.sol
 * and the verifyInBatch() implementation in ReceiptAnchorRegistry.sol.
 *
 * Used by the anchor batch worker to build a Merkle root from a list of
 * cidHashes, plus to emit per-leaf inclusion proofs so receipts can be
 * verified on-chain via `registry.verifyInBatch(cidHash, root, proof)`.
 *
 * Pure function module, no I/O. Tests live in __tests__/merkle.test.ts.
 *
 * Design doc: ai/scoping/onchain-receipt-anchoring-2026-05-23.md §3.4
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

/** A 32-byte hex string with 0x prefix. */
export type Bytes32Hex = `0x${string}`;

/** Result of building a Merkle tree over an ordered leaf list. */
export interface MerkleTree {
  /** The Merkle root, sorted-pair-keccak style. 0x-prefixed hex. */
  root: Bytes32Hex;
  /** The leaf list as provided (insertion order preserved). */
  leaves: Bytes32Hex[];
  /** Internal: layered hashes, layer 0 = leaves, last layer = [root]. */
  layers: Bytes32Hex[][];
}

/**
 * Build a sorted-pair-keccak Merkle tree from a list of `bytes32` leaves.
 *
 * Algorithm:
 *   - Each layer pairs adjacent nodes and hashes them in sorted order
 *     (`keccak256(min(a,b) || max(a,b))`).
 *   - Odd-count layers carry the last element forward unchanged
 *     (standard OZ behavior).
 *   - Single-leaf "tree" returns the leaf as the root with empty proof.
 *
 * @throws if leaves is empty.
 */
export function buildMerkleTree(leaves: Bytes32Hex[]): MerkleTree {
  if (leaves.length === 0) throw new Error("buildMerkleTree: empty leaves");
  const layer0 = [...leaves];
  const layers: Bytes32Hex[][] = [layer0];

  let current = layer0;
  while (current.length > 1) {
    const next: Bytes32Hex[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      if (i + 1 < current.length) {
        // Standard pair: hash left + right.
        next.push(hashPairSorted(left, current[i + 1]));
      } else {
        // Odd-length layer: last node carries forward unchanged (OZ-style).
        // Verification mirror: `getMerkleProof` emits no sibling for this
        // layer, and the on-chain `verifyInBatch` simply skips the layer.
        next.push(left);
      }
    }
    layers.push(next);
    current = next;
  }
  return { root: current[0], leaves, layers };
}

/**
 * Return the inclusion proof for `leafIndex` in the given tree.
 *
 * The proof is the array of sibling hashes from the leaf up to (but not
 * including) the root. Verifiable by `verifyMerkleProof` (TS) or
 * `ReceiptAnchorRegistry.verifyInBatch` (Solidity).
 *
 * @throws if leafIndex is out of bounds.
 */
export function getMerkleProof(tree: MerkleTree, leafIndex: number): Bytes32Hex[] {
  if (leafIndex < 0 || leafIndex >= tree.leaves.length) {
    throw new Error(`getMerkleProof: index ${leafIndex} out of bounds [0, ${tree.leaves.length})`);
  }
  const proof: Bytes32Hex[] = [];
  let idx = leafIndex;
  // Walk all layers except the root layer.
  for (let layerIdx = 0; layerIdx < tree.layers.length - 1; layerIdx++) {
    const layer = tree.layers[layerIdx];
    // Sibling is the other node in the pair. For odd-length layers, the last
    // node has no sibling (it carries forward unchanged), so we don't push
    // anything for it.
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    if (siblingIdx < layer.length) {
      proof.push(layer[siblingIdx]);
    }
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Verify a Merkle proof (pure TS mirror of ReceiptAnchorRegistry.verifyInBatch).
 */
export function verifyMerkleProof(
  leaf: Bytes32Hex,
  root: Bytes32Hex,
  proof: Bytes32Hex[],
): boolean {
  let computed: Bytes32Hex = leaf;
  for (const sibling of proof) {
    computed = hashPairSorted(computed, sibling);
  }
  return computed === root;
}

/**
 * keccak256(min(a,b) || max(a,b)) — the OZ sorted-pair convention.
 * Inputs and output are 0x-prefixed 32-byte hex.
 */
export function hashPairSorted(a: Bytes32Hex, b: Bytes32Hex): Bytes32Hex {
  // Lexicographic compare on lowercase hex is equivalent to bytewise compare
  // for fixed-length hex strings.
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  const [lo, hi] = al < bl ? [al, bl] : [bl, al];
  const concat = new Uint8Array(64);
  concat.set(hexToBytes(lo.slice(2)), 0);
  concat.set(hexToBytes(hi.slice(2)), 32);
  return `0x${bytesToHex(keccak_256(concat))}` as Bytes32Hex;
}

/**
 * Convert a "sha256:..." receiptCID into a 0x-prefixed 32-byte hex string.
 * The on-chain ReceiptAnchorRegistry stores cidHash as bytes32 — the same 32
 * raw bytes as the sha256 hash. We strip the "sha256:" prefix and prepend
 * "0x".
 *
 * @throws if the cid is not in the expected "sha256:<64 hex>" form.
 */
export function cidToBytes32(cid: string): Bytes32Hex {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(cid);
  if (!match) {
    throw new Error(`cidToBytes32: expected "sha256:<64 hex>", got ${cid}`);
  }
  return `0x${match[1].toLowerCase()}` as Bytes32Hex;
}
