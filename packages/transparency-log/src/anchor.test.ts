import { describe, it, expect } from "vitest";
import { composeAnchor, InMemoryAnchorStore, AnchorPayloadSchema } from "./anchor.js";
import { MerkleLog } from "./merkle.js";

describe("Anchor composition + store", () => {
  it("composeAnchor produces a schema-valid payload from a real Merkle root", () => {
    const log = new MerkleLog();
    log.appendLeaf("r1");
    log.appendLeaf("r2");
    log.appendLeaf("r3");
    const root = log.getRoot();

    const payload = composeAnchor(root, log.getTreeSize(), "2026-04-27T12:00:00Z");
    expect(() => AnchorPayloadSchema.parse(payload)).not.toThrow();
    expect(payload.batchSize).toBe(3);
    expect(payload.merkleRoot).toBe(root.toLowerCase());
    expect(payload.composedAt).toBe("2026-04-27T12:00:00Z");

    // 0x prefix is tolerated and stripped.
    const payload2 = composeAnchor("0x" + root, 3);
    expect(payload2.merkleRoot).toBe(root.toLowerCase());
    expect(payload2.merkleRoot.startsWith("0x")).toBe(false);
  });

  it("InMemoryAnchorStore append/latest/get/list roundtrip", () => {
    const store = new InMemoryAnchorStore();
    expect(store.latest()).toBeNull();
    expect(store.size()).toBe(0);

    const log = new MerkleLog();
    log.appendLeaf("a");
    const p1 = composeAnchor(log.getRoot(), log.getTreeSize());
    const r1 = store.append(p1, null);
    expect(r1.index).toBe(0);
    expect(r1.txHash).toBeNull();
    expect(store.size()).toBe(1);

    log.appendLeaf("b");
    const p2 = composeAnchor(log.getRoot(), log.getTreeSize());
    const fakeTx = "0x" + "c".repeat(64);
    const r2 = store.append(p2, fakeTx);
    expect(r2.index).toBe(1);
    expect(r2.txHash).toBe(fakeTx);
    expect(store.latest()?.index).toBe(1);
    expect(store.list().length).toBe(2);

    expect(() => store.get(99)).toThrow(RangeError);
  });
});
