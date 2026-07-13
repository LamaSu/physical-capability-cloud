/**
 * Tests for the GatewayReceipt persistence layer (§8.5 step 5 / object §8.3).
 *
 * Covers: insert/findById round-trip, per-job + per-session scoping and order,
 * checkpoint-hash provenance lookup, the per-session last-accepted snapshot,
 * and that the migration creates the table + its indexes.
 *
 * Pure persistence only — the transactional-acceptance invariant is proven in
 * packages/gateway/src/__tests__/gateway-receipt-store.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createStore,
  sql,
  type Store,
  type GatewayReceiptInsert,
} from "../index.js";

const SIG = "ab".repeat(64); // 128 hex chars = a 64-byte Ed25519 signature

function makeRow(
  overrides: Partial<GatewayReceiptInsert> = {},
): GatewayReceiptInsert {
  return {
    receiptId: "grcpt-sess-1-1",
    gatewayKeyId: "gw-rcpt-test",
    jobId: "job-1",
    sessionId: "sess-1",
    seq: 1,
    checkpointHash: "hash-1",
    previousAcceptedHash: null,
    sessionStateVersion: 1,
    acceptedAt: 1_800_000_000,
    signature: SIG,
    body: { receiptId: "grcpt-sess-1-1", anything: "goes" },
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("GatewayReceiptRepository", () => {
  let store: Store;
  beforeEach(() => {
    store = createStore({ seed: false });
  });
  afterEach(() => {
    store.close();
  });

  it("insert + findById round-trip", () => {
    const inserted = store.repos.gatewayReceipts.insert(makeRow());
    expect(inserted?.receiptId).toBe("grcpt-sess-1-1");
    const found = store.repos.gatewayReceipts.findById("grcpt-sess-1-1");
    expect(found?.checkpointHash).toBe("hash-1");
    expect(found?.seq).toBe(1);
    expect(found?.acceptedAt).toBe(1_800_000_000);
    expect(found?.previousAcceptedHash).toBeNull();
    // body round-trips as a parsed object (JSON column).
    expect((found?.body as { anything: string }).anything).toBe("goes");
  });

  it("findByJob returns a job's receipts oldest-first by createdAt", () => {
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "r2", seq: 2, checkpointHash: "h2", createdAt: "2026-07-13T00:00:02.000Z" }),
    );
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "r1", seq: 1, checkpointHash: "h1", createdAt: "2026-07-13T00:00:01.000Z" }),
    );
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "r3", jobId: "job-other", seq: 1, checkpointHash: "h3", createdAt: "2026-07-13T00:00:03.000Z" }),
    );
    const out = store.repos.gatewayReceipts.findByJob("job-1");
    expect(out.map((r) => r.receiptId)).toEqual(["r1", "r2"]);
  });

  it("findBySession returns a session's chain in seq order (ascending)", () => {
    // Insert out of seq order; the repo must return seq-ascending (chain order).
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "r3", seq: 3, checkpointHash: "h3", previousAcceptedHash: "h2" }),
    );
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "r1", seq: 1, checkpointHash: "h1", previousAcceptedHash: null }),
    );
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "r2", seq: 2, checkpointHash: "h2", previousAcceptedHash: "h1" }),
    );
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "other", sessionId: "sess-2", seq: 1, checkpointHash: "x1" }),
    );
    const out = store.repos.gatewayReceipts.findBySession("sess-1");
    expect(out.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(out.map((r) => r.receiptId)).toEqual(["r1", "r2", "r3"]);
  });

  it("findByCheckpointHash resolves the receipt(s) attesting a checkpoint", () => {
    store.repos.gatewayReceipts.insert(makeRow({ receiptId: "r1", checkpointHash: "the-hash" }));
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "r2", seq: 2, checkpointHash: "other-hash", previousAcceptedHash: "the-hash" }),
    );
    const out = store.repos.gatewayReceipts.findByCheckpointHash("the-hash");
    expect(out).toHaveLength(1);
    expect(out[0]?.receiptId).toBe("r1");
    expect(store.repos.gatewayReceipts.findByCheckpointHash("missing")).toEqual([]);
  });

  it("lastAcceptedForSession returns the highest-seq tip", () => {
    store.repos.gatewayReceipts.insert(makeRow({ receiptId: "r1", seq: 1, checkpointHash: "h1" }));
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "r2", seq: 2, checkpointHash: "h2", previousAcceptedHash: "h1" }),
    );
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "r3", seq: 3, checkpointHash: "h3", previousAcceptedHash: "h2" }),
    );
    const snap = store.repos.gatewayReceipts.lastAcceptedForSession("sess-1");
    expect(snap).toEqual({ lastSeq: 3, lastHash: "h3", lastReceiptId: "r3" });
    expect(store.repos.gatewayReceipts.lastAcceptedForSession("nope")).toBeUndefined();
  });

  it("migration creates the gateway_receipts table + its indexes", () => {
    const tables = store.db
      .all(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name='gateway_receipts'`,
      ) as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("gateway_receipts");

    const indexes = store.db
      .all(
        sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='gateway_receipts' AND name NOT LIKE 'sqlite_%'`,
      ) as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("gateway_receipts_job_idx");
    expect(names).toContain("gateway_receipts_session_idx");
    expect(names).toContain("gateway_receipts_checkpoint_idx");
    expect(names).toContain("gateway_receipts_session_seq_idx");
  });
});
