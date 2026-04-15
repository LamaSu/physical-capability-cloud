import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openSqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/types.js";

describe("IdempotencyStore — claim lifecycle", () => {
  let store: Store;

  beforeEach(() => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
  });
  afterEach(async () => {
    await store.close();
  });

  it("first claim returns 'fresh' with a new processing row", async () => {
    const c = await store.idempotency.claim({
      key: "k-1",
      scope: "http:POST:/fund",
      requestHash: "h-1",
      actorId: "actor",
    });
    expect(c.outcome).toBe("fresh");
    expect(c.row?.status).toBe("processing");
    expect(c.row?.attempt).toBe(1);
  });

  it("claim → complete → second claim returns 'cached'", async () => {
    await store.idempotency.claim({
      key: "k-2",
      scope: "http:POST:/fund",
      requestHash: "h-2",
      actorId: "actor",
    });
    await store.idempotency.complete("k-2", "http:POST:/fund", {
      responseCode: 200,
      responseBody: '{"ok":true}',
    });
    const second = await store.idempotency.claim({
      key: "k-2",
      scope: "http:POST:/fund",
      requestHash: "h-2",
      actorId: "actor",
    });
    expect(second.outcome).toBe("cached");
    expect(second.row?.status).toBe("completed");
    expect(second.row?.responseBody).toBe('{"ok":true}');
  });

  it("claim twice before complete returns 'in_flight'", async () => {
    await store.idempotency.claim({
      key: "k-3",
      scope: "http:POST:/fund",
      requestHash: "h-3",
      actorId: "actor",
    });
    const second = await store.idempotency.claim({
      key: "k-3",
      scope: "http:POST:/fund",
      requestHash: "h-3",
      actorId: "actor",
    });
    expect(second.outcome).toBe("in_flight");
  });

  it("claim with mismatched requestHash returns 'mismatch'", async () => {
    await store.idempotency.claim({
      key: "k-4",
      scope: "http:POST:/fund",
      requestHash: "h-A",
      actorId: "actor",
    });
    const second = await store.idempotency.claim({
      key: "k-4",
      scope: "http:POST:/fund",
      requestHash: "h-B",
      actorId: "actor",
    });
    expect(second.outcome).toBe("mismatch");
  });
});

describe("IdempotencyStore — fail / reclaim / recordTx", () => {
  let store: Store;
  beforeEach(() => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
  });
  afterEach(async () => {
    await store.close();
  });

  it("fail marks the row failed and cached replay returns it", async () => {
    await store.idempotency.claim({
      key: "kf",
      scope: "http:POST:/x",
      requestHash: "h",
      actorId: "a",
    });
    await store.idempotency.fail("kf", "http:POST:/x", { code: 500, body: "boom" });
    const c = await store.idempotency.claim({
      key: "kf",
      scope: "http:POST:/x",
      requestHash: "h",
      actorId: "a",
    });
    expect(c.outcome).toBe("cached");
    expect(c.row?.status).toBe("failed");
    expect(c.row?.responseBody).toBe("boom");
    expect(c.row?.responseCode).toBe(500);
  });

  it("fail twice throws the second time (already failed, not processing)", async () => {
    await store.idempotency.claim({
      key: "kff",
      scope: "http:POST:/x",
      requestHash: "h",
      actorId: "a",
    });
    await store.idempotency.fail("kff", "http:POST:/x", { body: "a" });
    await expect(
      store.idempotency.fail("kff", "http:POST:/x", { body: "b" }),
    ).rejects.toThrow(/not in 'processing'/);
  });

  it("reclaim bumps attempt counter", async () => {
    await store.idempotency.claim({
      key: "kr",
      scope: "onchain:escrow",
      requestHash: "h",
      actorId: "a",
    });
    const reclaimed = await store.idempotency.reclaim("kr", "onchain:escrow");
    expect(reclaimed.attempt).toBe(2);
    const again = await store.idempotency.reclaim("kr", "onchain:escrow");
    expect(again.attempt).toBe(3);
  });

  it("reclaim on missing row throws", async () => {
    await expect(
      store.idempotency.reclaim("missing", "scope"),
    ).rejects.toThrow(/not found/);
  });

  it("recordTx sets onchain_tx_hash without completing", async () => {
    await store.idempotency.claim({
      key: "kt",
      scope: "onchain:escrow",
      requestHash: "h",
      actorId: "a",
    });
    await store.idempotency.recordTx("kt", "onchain:escrow", "0xabc");
    const row = await store.idempotency.lookup("kt", "onchain:escrow");
    expect(row?.onchainTxHash).toBe("0xabc");
    expect(row?.status).toBe("processing");
  });

  it("recordTx on missing row throws", async () => {
    await expect(
      store.idempotency.recordTx("missing", "scope", "0x0"),
    ).rejects.toThrow(/row missing/);
  });
});

describe("IdempotencyStore — stuck window reclaim", () => {
  it("zero-ms stuck window immediately reclaims a processing row", async () => {
    // With stuckProcessingHttpMs=0, every re-claim instantly reclaims.
    const store = openSqliteStore({
      path: ":memory:",
      pruneIntervalMs: 0,
      stuckProcessingHttpMs: 0,
    });
    await store.idempotency.claim({
      key: "ks",
      scope: "http:POST:/x",
      requestHash: "h",
      actorId: "a",
    });
    // Wait 1ms so processing_started_at is strictly in the past relative to Date.now().
    await new Promise((r) => setTimeout(r, 2));
    const second = await store.idempotency.claim({
      key: "ks",
      scope: "http:POST:/x",
      requestHash: "h",
      actorId: "a",
    });
    expect(second.outcome).toBe("reclaimed");
    expect(second.newAttempt).toBe(2);
    await store.close();
  });

  it("large stuck window keeps processing row 'in_flight' on re-claim", async () => {
    const store = openSqliteStore({
      path: ":memory:",
      pruneIntervalMs: 0,
      stuckProcessingHttpMs: 60_000,
    });
    await store.idempotency.claim({
      key: "ks2",
      scope: "http:POST:/x",
      requestHash: "h",
      actorId: "a",
    });
    const second = await store.idempotency.claim({
      key: "ks2",
      scope: "http:POST:/x",
      requestHash: "h",
      actorId: "a",
    });
    expect(second.outcome).toBe("in_flight");
    await store.close();
  });
});

describe("IdempotencyStore — TTL prune", () => {
  it("prune deletes rows whose expires_at is in the past", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    // Force a past expiry by overriding expires_at.
    const past = new Date(Date.now() - 60_000).toISOString();
    await store.idempotency.claim({
      key: "kp",
      scope: "http:POST:/x",
      requestHash: "h",
      actorId: "a",
      expiresAtOverride: past,
    });
    const removed = await store.idempotency.prune();
    expect(removed).toBe(1);
    const gone = await store.idempotency.lookup("kp", "http:POST:/x");
    expect(gone).toBeNull();
    await store.close();
  });

  it("prune keeps rows with future expires_at", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    await store.idempotency.claim({
      key: "kp2",
      scope: "http:POST:/x",
      requestHash: "h",
      actorId: "a",
    });
    const removed = await store.idempotency.prune();
    expect(removed).toBe(0);
    await store.close();
  });
});

describe("IdempotencyStore — expires_at policy by scope", () => {
  it("http scope TTL ≈ 24h", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    const c = await store.idempotency.claim({
      key: "kh",
      scope: "http:POST:/x",
      requestHash: "h",
      actorId: "a",
    });
    const diffMs = Date.parse(c.row!.expiresAt) - Date.parse(c.row!.createdAt);
    // ~24h with small tolerance
    expect(diffMs).toBeGreaterThan(23 * 3600 * 1000);
    expect(diffMs).toBeLessThan(25 * 3600 * 1000);
    await store.close();
  });

  it("evidence scope uses sentinel year 9999", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    const c = await store.idempotency.claim({
      key: "ke",
      scope: "evidence:bundle",
      requestHash: "h",
      actorId: "a",
    });
    expect(c.row!.expiresAt.startsWith("9999-")).toBe(true);
    await store.close();
  });
});
