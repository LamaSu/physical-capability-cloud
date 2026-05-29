import { describe, it, expect } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  hashPairSorted,
  cidToBytes32,
  type Bytes32Hex,
} from "../merkle.js";

const leaf = (s: string): Bytes32Hex => `0x${bytesToHex(keccak_256(new TextEncoder().encode(s)))}` as Bytes32Hex;

describe("hashPairSorted", () => {
  it("is commutative on input order", () => {
    const a = leaf("a");
    const b = leaf("b");
    expect(hashPairSorted(a, b)).toBe(hashPairSorted(b, a));
  });

  it("matches manual sort + concat + keccak", () => {
    const a: Bytes32Hex = "0x" + "11".repeat(32) as Bytes32Hex;
    const b: Bytes32Hex = "0x" + "22".repeat(32) as Bytes32Hex;
    const concat = new Uint8Array(64);
    concat.set(hexToBytes("11".repeat(32)), 0);
    concat.set(hexToBytes("22".repeat(32)), 32);
    const manual: Bytes32Hex = `0x${bytesToHex(keccak_256(concat))}` as Bytes32Hex;
    expect(hashPairSorted(a, b)).toBe(manual);
  });
});

describe("buildMerkleTree", () => {
  it("rejects empty leaves", () => {
    expect(() => buildMerkleTree([])).toThrow(/empty leaves/);
  });

  it("single-leaf tree: root == leaf, proof is empty", () => {
    const l = leaf("only");
    const tree = buildMerkleTree([l]);
    expect(tree.root).toBe(l);
    expect(getMerkleProof(tree, 0)).toEqual([]);
    expect(verifyMerkleProof(l, tree.root, [])).toBe(true);
  });

  it("2-leaf tree: root = hashPairSorted(l0, l1)", () => {
    const l0 = leaf("a");
    const l1 = leaf("b");
    const tree = buildMerkleTree([l0, l1]);
    expect(tree.root).toBe(hashPairSorted(l0, l1));
  });

  it("4-leaf tree: round-trip verify all 4 leaves", () => {
    const ls = [leaf("a"), leaf("b"), leaf("c"), leaf("d")];
    const tree = buildMerkleTree(ls);
    for (let i = 0; i < ls.length; i++) {
      const proof = getMerkleProof(tree, i);
      expect(verifyMerkleProof(ls[i], tree.root, proof)).toBe(true);
    }
  });

  it("odd-count tree: last leaf carries forward (e.g., 3 leaves)", () => {
    const ls = [leaf("a"), leaf("b"), leaf("c")];
    const tree = buildMerkleTree(ls);
    for (let i = 0; i < ls.length; i++) {
      const proof = getMerkleProof(tree, i);
      expect(verifyMerkleProof(ls[i], tree.root, proof)).toBe(true);
    }
  });

  it("tampered leaf fails verification", () => {
    const ls = [leaf("a"), leaf("b"), leaf("c"), leaf("d")];
    const tree = buildMerkleTree(ls);
    const proof = getMerkleProof(tree, 1);
    expect(verifyMerkleProof(leaf("not-b"), tree.root, proof)).toBe(false);
  });

  it("tampered proof fails verification", () => {
    const ls = [leaf("a"), leaf("b"), leaf("c"), leaf("d")];
    const tree = buildMerkleTree(ls);
    const proof = getMerkleProof(tree, 1);
    const tampered = [...proof];
    tampered[0] = leaf("evil");
    expect(verifyMerkleProof(ls[1], tree.root, tampered)).toBe(false);
  });

  it("large tree (256 leaves): round-trip all", () => {
    const ls = Array.from({ length: 256 }, (_, i) => leaf(`leaf-${i}`));
    const tree = buildMerkleTree(ls);
    for (let i = 0; i < ls.length; i += 17) {
      // sample-test every 17th to keep the test snappy
      expect(verifyMerkleProof(ls[i], tree.root, getMerkleProof(tree, i))).toBe(true);
    }
  });

  it("getMerkleProof rejects out-of-bounds index", () => {
    const tree = buildMerkleTree([leaf("a"), leaf("b")]);
    expect(() => getMerkleProof(tree, -1)).toThrow(/out of bounds/);
    expect(() => getMerkleProof(tree, 2)).toThrow(/out of bounds/);
  });
});

describe("cidToBytes32", () => {
  it("strips sha256: prefix and adds 0x", () => {
    const hex = "a".repeat(64);
    expect(cidToBytes32(`sha256:${hex}`)).toBe(`0x${hex}`);
  });

  it("normalizes case to lowercase", () => {
    const hex = "ABCDEF" + "0".repeat(58);
    const got = cidToBytes32(`sha256:${hex}`);
    expect(got).toBe(`0x${hex.toLowerCase()}`);
  });

  it("rejects malformed CIDs", () => {
    expect(() => cidToBytes32("not-a-cid")).toThrow(/expected/);
    expect(() => cidToBytes32("sha256:tooshort")).toThrow(/expected/);
    expect(() => cidToBytes32(`sha256:${"x".repeat(64)}`)).toThrow(/expected/); // x not hex
  });
});
