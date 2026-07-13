/**
 * Tests for the GatewayReceipt persistence layer (§8.5 step 5 / object §8.3).
 *
 * Covers: insert/findById round-trip, per-job + per-session scoping and order,
 * checkpoint-hash provenance lookup, the per-session last-accepted snapshot,
 * and that the migration creates the table + its indexes.
 *
 * Step-5 hardening (R-14):
 *   - R-14a: body/column integrity is asserted on every full-row read; a divergent
 *     body fails closed (a persisted receipt is a signed artifact).
 *   - R-14c: findAllBySession returns the FULL chain (no silent truncation) where
 *     the capped findBySession would drop receipts.
 *   - R-14b: DB CHECK constraints (seq>=1, session_state_version=seq, accepted_at>0)
 *     reject malformed rows at the storage layer.
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

/**
 * A faithful gateway-receipt insert: the JSON `body` mirrors the scalar columns
 * exactly, the way record() writes it (body === { ...content, signature }), and
 * sessionStateVersion tracks seq (the §8.3 invariant + the DB CHECK). A test may
 * pass an explicit `body` override to craft a divergent (corrupt) row for the
 * assert-on-read tests.
 */
function makeRow(
  overrides: Partial<GatewayReceiptInsert> = {},
): GatewayReceiptInsert {
  const seq = overrides.seq ?? 1;
  const columns: GatewayReceiptInsert = {
    receiptId: "grcpt-sess-1-1",
    gatewayKeyId: "gw-rcpt-test",
    jobId: "job-1",
    sessionId: "sess-1",
    seq,
    checkpointHash: "hash-1",
    previousAcceptedHash: null,
    sessionStateVersion: seq, // §8.3: ssv === seq (also the DB CHECK)
    acceptedAt: 1_800_000_000,
    signature: SIG,
    body: { placeholder: true }, // replaced below unless a body override is given
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
  if (overrides.body === undefined) {
    columns.body = {
      receiptId: columns.receiptId,
      gatewayKeyId: columns.gatewayKeyId,
      jobId: columns.jobId,
      sessionId: columns.sessionId,
      seq: columns.seq,
      checkpointHash: columns.checkpointHash,
      previousAcceptedHash: columns.previousAcceptedHash,
      sessionStateVersion: columns.sessionStateVersion,
      acceptedAt: columns.acceptedAt,
      signature: columns.signature,
    };
  }
  return columns;
}

/**
 * Assert `fn` throws a SQLite CHECK-constraint violation. drizzle-orm wraps the
 * better-sqlite3 error ("Failed to run the query '…'"), so the discriminating
 * signal lives on `error.cause`: code SQLITE_CONSTRAINT_CHECK (verified live).
 * This pins the failure to a CHECK — stronger than a bare `.toThrow()`.
 */
function expectCheckViolation(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, "expected a CHECK-constraint violation to be thrown").toBeDefined();
  const cause = (caught as { cause?: { code?: string; message?: string } }).cause;
  expect(cause?.code).toBe("SQLITE_CONSTRAINT_CHECK");
}

/** A JSON body object matching the columns, then apply divergences for R-14a. */
function bodyFor(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    // body round-trips as a parsed object (JSON column) and mirrors the columns.
    expect((found?.body as { checkpointHash: string }).checkpointHash).toBe("hash-1");
  });

  it("findByJob returns a job's receipts oldest-first by createdAt", () => {
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "r2", seq: 2, checkpointHash: "h2", createdAt: "2026-07-13T00:00:02.000Z" }),
    );
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "r1", seq: 1, checkpointHash: "h1", createdAt: "2026-07-13T00:00:01.000Z" }),
    );
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "r3", jobId: "job-other", sessionId: "sess-other", seq: 1, checkpointHash: "h3", createdAt: "2026-07-13T00:00:03.000Z" }),
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
    // Renamed to UNIQUE in the step-5 hardening; the old non-unique name is gone.
    expect(names).toContain("gateway_receipts_session_seq_unique");
    expect(names).toContain("gateway_receipts_session_checkpoint_unique");
    expect(names).not.toContain("gateway_receipts_session_seq_idx");
  });

  it("enforces UNIQUE(session_id, seq): a different receiptId at the same (session,seq) is rejected by the DB", () => {
    store.repos.gatewayReceipts.insert(makeRow({ receiptId: "grcpt-sess-1-1", seq: 1, checkpointHash: "h1" }));
    // Same (session_id, seq) under a DIFFERENT receipt_id must violate the unique
    // index — the DB enforces one-accept-per-(session,seq) (§8.3) even if app
    // logic somehow constructed a non-deterministic id.
    expect(() =>
      store.repos.gatewayReceipts.insert(
        makeRow({ receiptId: "different-id", seq: 1, checkpointHash: "h1b" }),
      ),
    ).toThrow();
    // A different seq in the same session inserts fine.
    expect(
      store.repos.gatewayReceipts.insert(
        makeRow({ receiptId: "grcpt-sess-1-2", seq: 2, checkpointHash: "h2", previousAcceptedHash: "h1" }),
      )?.seq,
    ).toBe(2);
  });

  it("enforces UNIQUE(session_id, checkpoint_hash): same hash twice in a session is rejected, but recurs across sessions", () => {
    store.repos.gatewayReceipts.insert(makeRow({ receiptId: "grcpt-sess-1-1", seq: 1, checkpointHash: "dup" }));
    // Same (session_id, checkpoint_hash) at a new seq/id → unique violation.
    expect(() =>
      store.repos.gatewayReceipts.insert(
        makeRow({ receiptId: "grcpt-sess-1-2", seq: 2, checkpointHash: "dup", previousAcceptedHash: "dup" }),
      ),
    ).toThrow();
    // The SAME hash in a DIFFERENT session is allowed (constraint is per-session).
    expect(
      store.repos.gatewayReceipts.insert(
        makeRow({ receiptId: "grcpt-sess-2-1", sessionId: "sess-2", seq: 1, checkpointHash: "dup" }),
      )?.checkpointHash,
    ).toBe("dup");
  });
});

// R-14a ---------------------------------------------------------------------
describe("R-14a — body/column integrity (assert-on-read, fail closed)", () => {
  let store: Store;
  beforeEach(() => {
    store = createStore({ seed: false });
  });
  afterEach(() => {
    store.close();
  });

  it("a consistent round-trip still returns the row (body === columns)", () => {
    store.repos.gatewayReceipts.insert(makeRow({ receiptId: "ok-1", seq: 1, checkpointHash: "h1" }));
    const found = store.repos.gatewayReceipts.findById("ok-1");
    expect(found?.receiptId).toBe("ok-1");
    expect(found?.seq).toBe(1);
    // findAllBySession + findByJob also return the consistent row without throwing.
    expect(store.repos.gatewayReceipts.findAllBySession("sess-1")).toHaveLength(1);
    expect(store.repos.gatewayReceipts.findByJob("job-1")).toHaveLength(1);
  });

  it("findById THROWS naming `seq` when body.seq diverges from the column", () => {
    // Column seq=1, but the persisted body claims seq=999 — corruption of a
    // signed artifact. The write path (insert) does NOT assert; the read does.
    store.repos.gatewayReceipts.insert(
      makeRow({
        receiptId: "diverge-seq",
        seq: 1,
        checkpointHash: "cs",
        body: bodyFor({ receiptId: "diverge-seq", checkpointHash: "cs", seq: 999 }),
      }),
    );
    expect(() => store.repos.gatewayReceipts.findById("diverge-seq")).toThrow(/seq/);
  });

  it("findBySession THROWS naming `checkpointHash` when body.checkpointHash diverges", () => {
    store.repos.gatewayReceipts.insert(
      makeRow({
        receiptId: "diverge-ckpt",
        seq: 1,
        checkpointHash: "real-hash",
        body: bodyFor({ receiptId: "diverge-ckpt", checkpointHash: "FORGED-hash" }),
      }),
    );
    expect(() => store.repos.gatewayReceipts.findBySession("sess-1")).toThrow(/checkpointHash/);
  });

  it("findByCheckpointHash THROWS when body.signature diverges", () => {
    store.repos.gatewayReceipts.insert(
      makeRow({
        receiptId: "diverge-sig",
        seq: 1,
        checkpointHash: "sig-ckpt",
        body: bodyFor({ receiptId: "diverge-sig", checkpointHash: "sig-ckpt", signature: "cd".repeat(64) }),
      }),
    );
    expect(() => store.repos.gatewayReceipts.findByCheckpointHash("sig-ckpt")).toThrow(/signature/);
  });

  it("findAllBySession THROWS when body is MISSING load-bearing fields (the old stub-body shape)", () => {
    // A stub body `{receiptId, anything}` — every field after receiptId is
    // undefined in the body; the first divergence caught is gatewayKeyId.
    store.repos.gatewayReceipts.insert(
      makeRow({
        receiptId: "missing-field",
        seq: 1,
        checkpointHash: "mf",
        body: { receiptId: "missing-field", anything: "goes" },
      }),
    );
    expect(() => store.repos.gatewayReceipts.findAllBySession("sess-1")).toThrow(/gatewayKeyId/);
  });

  it("fails closed when the body is not a JSON object (e.g. an array)", () => {
    store.repos.gatewayReceipts.insert(
      makeRow({ receiptId: "arr-body", seq: 1, checkpointHash: "ab", body: [1, 2, 3] as unknown as object }),
    );
    expect(() => store.repos.gatewayReceipts.findById("arr-body")).toThrow(/not a JSON object/);
  });
});

// R-14c ---------------------------------------------------------------------
describe("R-14c — findAllBySession returns the full chain (no silent truncation)", () => {
  let store: Store;
  beforeEach(() => {
    store = createStore({ seed: false });
  });
  afterEach(() => {
    store.close();
  });

  it("returns ALL receipts seq-ascending + contiguous 1..N, where findBySession truncates at the cap", () => {
    const N = 1001; // > MAX_LIMIT (1000) so the cap is exposed
    let prev: string | null = null;
    for (let i = 1; i <= N; i++) {
      const hash = `h${i}`;
      store.repos.gatewayReceipts.insert(
        makeRow({
          receiptId: `grcpt-sess-1-${i}`,
          sessionId: "sess-1",
          seq: i, // sessionStateVersion tracks seq via makeRow
          checkpointHash: hash,
          previousAcceptedHash: prev,
        }),
      );
      prev = hash;
    }

    const all = store.repos.gatewayReceipts.findAllBySession("sess-1");
    expect(all).toHaveLength(N);
    // seq-ascending and contiguous 1..N — a full, un-forked chain.
    expect(all.map((r) => r.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    // The capped finder truncates: default = DEFAULT_LIMIT (100); an over-cap
    // request is clamped to MAX_LIMIT (1000). This is the silent-fork risk
    // findAllBySession closes.
    expect(store.repos.gatewayReceipts.findBySession("sess-1")).toHaveLength(100);
    expect(store.repos.gatewayReceipts.findBySession("sess-1", 5000)).toHaveLength(1000);
    expect(all.length).toBeGreaterThan(
      store.repos.gatewayReceipts.findBySession("sess-1", 5000).length,
    );
  });
});

// R-14b ---------------------------------------------------------------------
describe("R-14b — DB CHECK constraints on a fresh table (raw insert bypasses the app layer)", () => {
  let store: Store;
  beforeEach(() => {
    store = createStore({ seed: false });
  });
  afterEach(() => {
    store.close();
  });

  /**
   * Insert straight through the underlying drizzle/sqlite connection, bypassing
   * the repository, so the DB CHECK constraints are hit directly. `body` is a
   * consistent JSON string (never read back through the asserting finder here).
   */
  function rawInsert(vals: {
    receiptId: string;
    seq: number;
    sessionStateVersion: number;
    acceptedAt: number;
    sessionId?: string;
    checkpointHash?: string;
  }) {
    const sessionId = vals.sessionId ?? "sess-1";
    const checkpointHash = vals.checkpointHash ?? "h1";
    const body = JSON.stringify({
      receiptId: vals.receiptId,
      gatewayKeyId: "gw-rcpt-test",
      jobId: "job-1",
      sessionId,
      seq: vals.seq,
      checkpointHash,
      previousAcceptedHash: null,
      sessionStateVersion: vals.sessionStateVersion,
      acceptedAt: vals.acceptedAt,
      signature: SIG,
    });
    return store.db.run(sql`
      INSERT INTO gateway_receipts
        (receipt_id, gateway_key_id, job_id, session_id, seq, checkpoint_hash,
         previous_accepted_hash, session_state_version, accepted_at, signature, body, created_at)
      VALUES (${vals.receiptId}, 'gw-rcpt-test', 'job-1', ${sessionId}, ${vals.seq}, ${checkpointHash},
         NULL, ${vals.sessionStateVersion}, ${vals.acceptedAt}, ${SIG}, ${body}, '2026-07-13T00:00:00.000Z')
    `);
  }

  it("a valid raw insert (seq>=1, ssv=seq, accepted_at>0) succeeds", () => {
    expect(() =>
      rawInsert({ receiptId: "valid", seq: 1, sessionStateVersion: 1, acceptedAt: 1_800_000_000 }),
    ).not.toThrow();
    const rows = store.db.all(sql`SELECT COUNT(*) AS n FROM gateway_receipts`) as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(1);
  });

  it("CHECK(seq >= 1): seq = 0 is rejected", () => {
    // ssv=0 keeps the ssv=seq CHECK satisfied so ONLY seq>=1 is under test.
    expectCheckViolation(() =>
      rawInsert({ receiptId: "seq0", seq: 0, sessionStateVersion: 0, acceptedAt: 1_800_000_000 }),
    );
  });

  it("CHECK(session_state_version = seq): a mismatch is rejected", () => {
    expectCheckViolation(() =>
      rawInsert({ receiptId: "ssv-mismatch", seq: 2, sessionStateVersion: 1, acceptedAt: 1_800_000_000 }),
    );
  });

  it("CHECK(accepted_at > 0): accepted_at = 0 is rejected", () => {
    expectCheckViolation(() =>
      rawInsert({ receiptId: "at0", seq: 1, sessionStateVersion: 1, acceptedAt: 0 }),
    );
  });
});
