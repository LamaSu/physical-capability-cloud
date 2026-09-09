/**
 * Tests for the CheckpointBody persistence layer (§8.4-B-3 / §2.2 step 7).
 *
 * Covers: insert/findBySessionSeq round-trip (incl. nullable prevCheckpointHash
 * and payload), the payload JSON column round-tripping as an object when revealed,
 * findBySession seq-ascending replay order, the UNIQUE(session_id, seq) rule, and
 * that the migration creates the table + its indexes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createStore,
  sql,
  type Store,
  type CheckpointBodyInsert,
} from "../index.js";

const SIG = "cd".repeat(64); // 128 hex chars = a 64-byte Ed25519 signature

function makeRow(
  overrides: Partial<CheckpointBodyInsert> = {},
): CheckpointBodyInsert {
  return {
    id: "ckpt-sess-1-1",
    sessionId: "sess-1",
    seq: 1,
    jobId: "job-1",
    checkpointHash: "hash-1",
    prevCheckpointHash: null,
    eventsRoot: "sha256:events-1",
    checkpointType: "execution_started",
    deviceCreatedAt: 1_800_000_000,
    signature: SIG,
    payload: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("CheckpointBodyRepository", () => {
  let store: Store;
  beforeEach(() => {
    store = createStore({ seed: false });
  });
  afterEach(() => {
    store.close();
  });

  it("insert + findBySessionSeq round-trip (nullable payload + prevHash)", () => {
    const inserted = store.repos.checkpointBodies.insert(makeRow());
    expect(inserted?.id).toBe("ckpt-sess-1-1");
    const found = store.repos.checkpointBodies.findBySessionSeq("sess-1", 1);
    expect(found?.checkpointHash).toBe("hash-1");
    expect(found?.eventsRoot).toBe("sha256:events-1");
    expect(found?.checkpointType).toBe("execution_started");
    expect(found?.deviceCreatedAt).toBe(1_800_000_000);
    expect(found?.prevCheckpointHash).toBeNull();
    expect(found?.payload).toBeNull();
    expect(store.repos.checkpointBodies.findBySessionSeq("sess-1", 99)).toBeUndefined();
  });

  it("payload JSON column round-trips as a parsed object when revealed", () => {
    store.repos.checkpointBodies.insert(
      makeRow({ payload: { events: [{ type: "x", n: 1 }] } }),
    );
    const found = store.repos.checkpointBodies.findBySessionSeq("sess-1", 1);
    const payload = found?.payload as { events: Array<{ type: string; n: number }> };
    expect(payload.events[0]?.type).toBe("x");
    expect(payload.events[0]?.n).toBe(1);
  });

  it("findBySession returns a session's bodies in seq order (ascending)", () => {
    // Insert out of seq order; the repo must return seq-ascending.
    store.repos.checkpointBodies.insert(
      makeRow({ id: "ckpt-sess-1-3", seq: 3, checkpointHash: "h3", prevCheckpointHash: "h2" }),
    );
    store.repos.checkpointBodies.insert(
      makeRow({ id: "ckpt-sess-1-1", seq: 1, checkpointHash: "h1" }),
    );
    store.repos.checkpointBodies.insert(
      makeRow({ id: "ckpt-sess-1-2", seq: 2, checkpointHash: "h2", prevCheckpointHash: "h1" }),
    );
    store.repos.checkpointBodies.insert(
      makeRow({ id: "ckpt-sess-2-1", sessionId: "sess-2", seq: 1, checkpointHash: "x1" }),
    );
    const out = store.repos.checkpointBodies.findBySession("sess-1");
    expect(out.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(out.map((r) => r.id)).toEqual([
      "ckpt-sess-1-1",
      "ckpt-sess-1-2",
      "ckpt-sess-1-3",
    ]);
  });

  it("enforces UNIQUE(session_id, seq): a second body at the same (session, seq) is rejected", () => {
    store.repos.checkpointBodies.insert(makeRow({ id: "ckpt-sess-1-1", seq: 1 }));
    // Same (session_id, seq) under a different id must violate the unique index.
    expect(() =>
      store.repos.checkpointBodies.insert(
        makeRow({ id: "ckpt-sess-1-1-dup", seq: 1, checkpointHash: "h1b" }),
      ),
    ).toThrow();
    // The same seq in a DIFFERENT session inserts fine (constraint is per-session).
    expect(
      store.repos.checkpointBodies.insert(
        makeRow({ id: "ckpt-sess-2-1", sessionId: "sess-2", seq: 1, checkpointHash: "x1" }),
      )?.seq,
    ).toBe(1);
  });

  it("migration creates the checkpoint_bodies table + its indexes", () => {
    const tables = store.db.all(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoint_bodies'`,
    ) as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("checkpoint_bodies");

    const indexes = store.db.all(
      sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='checkpoint_bodies' AND name NOT LIKE 'sqlite_%'`,
    ) as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("checkpoint_bodies_session_idx");
    expect(names).toContain("checkpoint_bodies_session_seq_unique");
  });
});
