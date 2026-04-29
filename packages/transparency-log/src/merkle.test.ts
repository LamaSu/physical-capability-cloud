import { describe, it, expect } from "vitest";
import { MerkleLog, verifyProof, hashLeaf, EMPTY_ROOT } from "./merkle.js";

describe("MerkleLog (RFC 6962)", () => {
  it("appendLeaf + getRoot is deterministic across two independent trees", () => {
    const a = new MerkleLog();
    const b = new MerkleLog();
    const leaves = ["receipt-1", "receipt-2", "receipt-3", "receipt-4"];
    for (const l of leaves) {
      a.appendLeaf(l);
      b.appendLeaf(l);
    }
    expect(a.getRoot()).toBe(b.getRoot());
    expect(a.getTreeSize()).toBe(4);
  });

  it("proof verifies for every leaf in a tree of 5 (non-power-of-two)", () => {
    const log = new MerkleLog();
    const leaves = ["a", "b", "c", "d", "e"];
    for (const l of leaves) log.appendLeaf(l);
    const root = log.getRoot();

    for (let i = 0; i < leaves.length; i++) {
      const proof = log.getProof(i);
      expect(verifyProof(leaves[i]!, proof, root)).toBe(true);
    }
  });

  it("proof FAILS when the leaf is tampered (wrong leaf data, valid path)", () => {
    const log = new MerkleLog();
    for (const l of ["a", "b", "c", "d"]) log.appendLeaf(l);
    const root = log.getRoot();
    const proof = log.getProof(2); // proof for "c"
    expect(verifyProof("c", proof, root)).toBe(true);
    // Same proof but pretend the leaf was "x"
    expect(verifyProof("x", proof, root)).toBe(false);
  });

  it("incremental append: root changes after each append, prior leaves still verifiable in the new tree", () => {
    const log = new MerkleLog();
    const roots: string[] = [];
    const leaves = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];
    for (const l of leaves) {
      log.appendLeaf(l);
      roots.push(log.getRoot());
    }
    // Each append must produce a distinct root (no replays / no flat tree).
    expect(new Set(roots).size).toBe(roots.length);

    // The final tree contains every leaf; all must verify against the final root.
    const finalRoot = log.getRoot();
    for (let i = 0; i < leaves.length; i++) {
      const proof = log.getProof(i);
      expect(verifyProof(leaves[i]!, proof, finalRoot)).toBe(true);
    }
  });

  it("large tree: path length is O(log N) and bounded by ceil(log2(N))", () => {
    const log = new MerkleLog();
    const N = 50; // not a power of two on purpose
    for (let i = 0; i < N; i++) log.appendLeaf(`leaf-${i}`);
    const root = log.getRoot();

    // Pick a few representative indices.
    for (const idx of [0, 7, 24, 49]) {
      const proof = log.getProof(idx);
      // The sibling chain must be at most ceil(log2(N)).
      const maxLen = Math.ceil(Math.log2(N));
      expect(proof.siblings.length).toBeLessThanOrEqual(maxLen);
      expect(verifyProof(`leaf-${idx}`, proof, root)).toBe(true);
    }
  });

  it("empty tree behavior: getRoot returns RFC 6962 empty hash; getProof throws", () => {
    const log = new MerkleLog();
    expect(log.getTreeSize()).toBe(0);
    expect(log.getRoot()).toBe(EMPTY_ROOT);
    expect(() => log.getProof(0)).toThrow(RangeError);

    // hashLeaf is well-defined and stable for an empty/single-byte input.
    expect(hashLeaf("")).toBe(hashLeaf(""));
    expect(hashLeaf("a")).not.toBe(hashLeaf(""));
  });
});
