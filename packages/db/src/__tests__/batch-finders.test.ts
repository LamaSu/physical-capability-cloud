/**
 * F1 — real batch finders (N+1 prevention).
 *
 * The facade "batch" helpers previously issued one query per id while their
 * comments claimed to prevent N+1. These repo-level APIs are the real batch
 * primitives: one IN-list query per ≤500 ids.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../index.js";
import { BATCH_CHUNK_SIZE, inChunks } from "../repositories/batch.js";

describe("F1 — batch finders", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ seed: false });
  });

  afterEach(() => {
    store.close();
  });

  const seedKernel = (id: string) =>
    store.repos.kernels.insert({
      id,
      name: `Kernel ${id}`,
      operatorAddress: "op@example.com",
      location: { lat: 0, lng: 0 },
      physicalAddress: "1 Test St",
      maxAssuranceTier: 2,
      publicKey: "pk",
      reputation: 500,
      totalJobsCompleted: 0,
      status: "online",
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      version: "1.0.0",
    } as any);

  const seedCapability = (id: string, kernelId: string) =>
    store.repos.capabilities.insert({
      id,
      kernelId,
      type: "fdm",
      name: `Cap ${id}`,
      materials: [],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: "1.00", minimum: "1.00" },
      availability: {},
      location: { lat: 0, lng: 0 },
      queueDepth: 0,
    } as any);

  const seedEscrowWithMilestones = (id: string, milestoneCount: number) => {
    store.repos.escrows.insert({
      id,
      cwmId: `cwm-${id}`,
      contractAddress: `0x${id}`,
      payer: "payer",
      totalAmount: "10.00",
      currency: "USDC",
      status: "created",
      createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 3600_000).toISOString(),
    } as any);
    for (let i = 0; i < milestoneCount; i++) {
      store.repos.escrows.insertMilestone({
        id: `ms-${id}-${i}`,
        escrowId: id,
        stepId: `step-${i}`,
        amount: "5.00",
        status: "pending",
        bondAmount: "0.00",
      } as any);
    }
  };

  // ── kernels.findByIds ────────────────────────────────────────────────────

  it("kernels.findByIds returns exactly the requested rows", () => {
    seedKernel("k1");
    seedKernel("k2");
    seedKernel("k3");
    const rows = store.repos.kernels.findByIds(["k1", "k3"]);
    expect(rows.map((r) => r.id).sort()).toEqual(["k1", "k3"]);
  });

  it("kernels.findByIds with empty input returns [] without querying", () => {
    expect(store.repos.kernels.findByIds([])).toEqual([]);
  });

  it("kernels.findByIds ignores unknown ids", () => {
    seedKernel("k1");
    const rows = store.repos.kernels.findByIds(["k1", "ghost"]);
    expect(rows.map((r) => r.id)).toEqual(["k1"]);
  });

  // ── capabilities.findByIds ───────────────────────────────────────────────

  it("capabilities.findByIds returns exactly the requested rows", () => {
    seedKernel("k1");
    seedCapability("c1", "k1");
    seedCapability("c2", "k1");
    const rows = store.repos.capabilities.findByIds(["c2"]);
    expect(rows.map((r) => r.id)).toEqual(["c2"]);
  });

  it("capabilities.findByIds with empty input returns []", () => {
    expect(store.repos.capabilities.findByIds([])).toEqual([]);
  });

  // ── escrows.findMilestonesByEscrowIds ────────────────────────────────────

  it("escrows.findMilestonesByEscrowIds returns milestones for the whole id set", () => {
    seedEscrowWithMilestones("esc-a", 2);
    seedEscrowWithMilestones("esc-b", 1);
    seedEscrowWithMilestones("esc-c", 3); // not requested

    const rows = store.repos.escrows.findMilestonesByEscrowIds(["esc-a", "esc-b"]);
    expect(rows).toHaveLength(3);
    const byEscrow = new Map<string, number>();
    for (const ms of rows) byEscrow.set(ms.escrowId, (byEscrow.get(ms.escrowId) ?? 0) + 1);
    expect(byEscrow.get("esc-a")).toBe(2);
    expect(byEscrow.get("esc-b")).toBe(1);
    expect(byEscrow.has("esc-c")).toBe(false);
  });

  it("escrows.findMilestonesByEscrowIds with empty input returns []", () => {
    expect(store.repos.escrows.findMilestonesByEscrowIds([])).toEqual([]);
  });

  // ── chunking (SQLite bound-parameter safety) ─────────────────────────────

  it("inChunks splits inputs larger than the chunk size and concatenates", () => {
    const total = BATCH_CHUNK_SIZE + 7;
    const ids = Array.from({ length: total }, (_, i) => `id-${i}`);
    const seenChunks: number[] = [];
    const out = inChunks(ids, (chunk) => {
      seenChunks.push(chunk.length);
      return chunk;
    });
    expect(out).toEqual(ids);
    expect(seenChunks).toEqual([BATCH_CHUNK_SIZE, 7]);
  });

  it("findByIds works past the chunk boundary against real SQLite", () => {
    // 501 ids, only 2 real rows — exercises the >500 two-query path.
    seedKernel("k-first");
    seedKernel("k-last");
    const ids = ["k-first", ...Array.from({ length: BATCH_CHUNK_SIZE - 1 }, (_, i) => `ghost-${i}`), "k-last"];
    expect(ids.length).toBe(BATCH_CHUNK_SIZE + 1);
    const rows = store.repos.kernels.findByIds(ids);
    expect(rows.map((r) => r.id).sort()).toEqual(["k-first", "k-last"]);
  });
});
