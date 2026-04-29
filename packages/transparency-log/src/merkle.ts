/**
 * RFC 6962 / Certificate Transparency-style incremental Merkle tree.
 *
 * Construction notes:
 *  - Hash function: SHA-256 (32-byte output, hex-encoded).
 *  - Leaf hash:  H(0x00 || leaf_data)
 *  - Inner hash: H(0x01 || left || right)
 *  - The 0x00/0x01 domain separation prevents leaf-vs-inner collisions
 *    (this is the core RFC 6962 trick).
 *  - Tree size N is the count of leaves; the tree shape for N leaves is
 *    well-defined: it is the "left-perfect" binary tree, where the left
 *    subtree is the largest power-of-two <= N/2.
 *
 * This implementation stores only the leaf hashes and recomputes the root
 * lazily. For a v1 transparency log running at, say, 10K receipts/day, an
 * append cost of O(log N) per leaf and a recompute cost of O(N) per
 * `getRoot()` call is fine. A snapshot-cached implementation can come later.
 *
 * Public surface intentionally small:
 *   appendLeaf(leaf)         -> { index, treeSize }
 *   getRoot()                -> hex digest (or empty-tree hash)
 *   getProof(index)          -> MerkleProof
 *   verifyProof(leaf, proof, root) -> boolean
 *   serialize()              -> TreeSnapshot (leaves + size)
 *   getTreeSize()            -> number
 */

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

const LEAF_PREFIX = new Uint8Array([0x00]);
const INNER_PREFIX = new Uint8Array([0x01]);

// Empty-tree hash per RFC 6962: SHA-256 of the empty byte string.
const EMPTY_TREE_ROOT = bytesToHex(sha256(new Uint8Array(0)));

export interface MerkleProof {
  /** Leaf index this proof is for (0-based). */
  index: number;
  /** Tree size at the time the proof was generated. */
  treeSize: number;
  /** The leaf's own hash (post-domain-separator), hex-encoded. */
  leafHash: string;
  /** Sibling hashes from leaf to root (bottom-up). Each entry is hex-encoded. */
  siblings: string[];
  /** Root hash this proof should produce. */
  root: string;
}

export interface TreeSnapshot {
  /** Hex-encoded leaf hashes (post-domain-separator). */
  leafHashes: string[];
  /** Tree size N = leafHashes.length. */
  size: number;
}

function concat(a: Uint8Array, b: Uint8Array, c?: Uint8Array): Uint8Array {
  const len = a.length + b.length + (c ? c.length : 0);
  const out = new Uint8Array(len);
  out.set(a, 0);
  out.set(b, a.length);
  if (c) out.set(c, a.length + b.length);
  return out;
}

/**
 * Compute a leaf hash with the RFC 6962 0x00 prefix.
 * Accepts a string (UTF-8 encoded) or raw bytes.
 */
export function hashLeaf(leaf: string | Uint8Array): string {
  const bytes = typeof leaf === "string" ? utf8ToBytes(leaf) : leaf;
  return bytesToHex(sha256(concat(LEAF_PREFIX, bytes)));
}

/** Compute an inner-node hash with the RFC 6962 0x01 prefix. */
export function hashInner(leftHex: string, rightHex: string): string {
  const left = hexToBytes(leftHex);
  const right = hexToBytes(rightHex);
  return bytesToHex(sha256(concat(INNER_PREFIX, left, right)));
}

/**
 * Largest power of two <= n / 2 + 1, matching the RFC 6962 split rule.
 * Equivalently: highest power of two strictly less than n, when n >= 2.
 */
function leftSubtreeSize(n: number): number {
  if (n <= 1) return 0;
  let p = 1;
  while (p * 2 < n) {
    p *= 2;
  }
  return p;
}

/**
 * Compute the Merkle tree hash (MTH) for `leafHashes[start..end)`.
 * Pure recursive evaluation per RFC 6962 section 2.1.
 */
function mth(leafHashes: string[], start: number, end: number): string {
  const n = end - start;
  if (n === 0) return EMPTY_TREE_ROOT;
  if (n === 1) return leafHashes[start]!;

  const k = leftSubtreeSize(n);
  const left = mth(leafHashes, start, start + k);
  const right = mth(leafHashes, start + k, end);
  return hashInner(left, right);
}

/**
 * Compute an inclusion proof for `index` in `leafHashes[start..end)`.
 * Returns the sibling chain bottom-up.
 */
function path(leafHashes: string[], index: number, start: number, end: number): string[] {
  const n = end - start;
  if (n <= 1) return [];

  const k = leftSubtreeSize(n);
  const localIndex = index - start;
  if (localIndex < k) {
    // Leaf is in left subtree; right-subtree root is sibling.
    const sibling = mth(leafHashes, start + k, end);
    return [...path(leafHashes, index, start, start + k), sibling];
  }
  // Leaf is in right subtree; left-subtree root is sibling.
  const sibling = mth(leafHashes, start, start + k);
  return [...path(leafHashes, index, start + k, end), sibling];
}

/**
 * Incremental Merkle log. Append-only. RFC 6962-compatible.
 */
export class MerkleLog {
  private leafHashes: string[] = [];

  constructor(snapshot?: TreeSnapshot) {
    if (snapshot) {
      this.leafHashes = [...snapshot.leafHashes];
    }
  }

  /** Append a new leaf. Returns its 0-based index and the new tree size. */
  appendLeaf(leaf: string | Uint8Array): { index: number; treeSize: number; leafHash: string } {
    const lh = hashLeaf(leaf);
    const index = this.leafHashes.length;
    this.leafHashes.push(lh);
    return { index, treeSize: this.leafHashes.length, leafHash: lh };
  }

  /** Get the current Merkle root (hex). */
  getRoot(): string {
    return mth(this.leafHashes, 0, this.leafHashes.length);
  }

  /** Number of leaves currently in the tree. */
  getTreeSize(): number {
    return this.leafHashes.length;
  }

  /**
   * Generate an inclusion proof for the leaf at `index` against the current root.
   * Throws if `index` is out of range.
   */
  getProof(index: number): MerkleProof {
    if (index < 0 || index >= this.leafHashes.length) {
      throw new RangeError(
        `MerkleLog.getProof: index ${index} out of range [0, ${this.leafHashes.length})`,
      );
    }
    const siblings = path(this.leafHashes, index, 0, this.leafHashes.length);
    return {
      index,
      treeSize: this.leafHashes.length,
      leafHash: this.leafHashes[index]!,
      siblings,
      root: this.getRoot(),
    };
  }

  /** Snapshot the current tree state (for persistence / restore). */
  serialize(): TreeSnapshot {
    return {
      leafHashes: [...this.leafHashes],
      size: this.leafHashes.length,
    };
  }

  /** Restore a tree from a snapshot (replaces current state). */
  static fromSnapshot(snapshot: TreeSnapshot): MerkleLog {
    return new MerkleLog(snapshot);
  }
}

/**
 * Verify an inclusion proof against an asserted root.
 *
 * Caller must pass the leaf data (NOT the leaf hash) so we can recompute
 * the leaf hash with the 0x00 domain separator and reject any tampered
 * leaf data.
 *
 * @param leaf  The original leaf data (string or bytes).
 * @param proof MerkleProof produced by getProof().
 * @param root  The asserted Merkle root the proof should verify against.
 * @returns true iff (recompute leaf hash → walk siblings → compare root) succeeds.
 */
export function verifyProof(
  leaf: string | Uint8Array,
  proof: MerkleProof,
  root: string,
): boolean {
  if (!proof || proof.index < 0 || proof.treeSize <= 0) return false;
  if (proof.index >= proof.treeSize) return false;

  const expectedLeafHash = hashLeaf(leaf);
  if (expectedLeafHash !== proof.leafHash) return false;

  // The path() recursion produces siblings bottom-up (leaf-adjacent first,
  // root-adjacent last). To verify, we collect the directions in the same
  // top-down recursion order, then walk siblings bottom-up while consuming
  // directions in the same order.
  type Side = "left" | "right";
  const directions: Side[] = [];
  let start = 0;
  let end = proof.treeSize;
  while (end - start > 1) {
    const k = leftSubtreeSize(end - start);
    const splitAbsolute = start + k;
    if (proof.index < splitAbsolute) {
      // current leaf is in the LEFT subtree at this level → sibling is on right
      directions.push("right");
      end = splitAbsolute;
    } else {
      directions.push("left");
      start = splitAbsolute;
    }
  }

  // Sanity: number of directions should match number of siblings.
  if (directions.length !== proof.siblings.length) return false;

  // Now walk bottom-up: directions[directions.length-1] is leaf-adjacent
  // (first level above the leaf), and proof.siblings[0] is also leaf-adjacent.
  let current = proof.leafHash;
  for (let i = 0; i < directions.length; i++) {
    const sibling = proof.siblings[i];
    if (sibling === undefined) return false;
    // The bottom-up direction at level i is directions[directions.length-1-i].
    const dir = directions[directions.length - 1 - i]!;
    if (dir === "right") {
      // sibling is on the right → current is left
      current = hashInner(current, sibling);
    } else {
      current = hashInner(sibling, current);
    }
  }

  return current === root;
}

/** Hex digest of the empty tree (exposed for tests + receipt validation). */
export const EMPTY_ROOT = EMPTY_TREE_ROOT;
