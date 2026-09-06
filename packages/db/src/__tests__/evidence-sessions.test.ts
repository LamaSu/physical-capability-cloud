/**
 * Tests for the EvidenceSession persistence layer (§8.5 step 6 / §2.1).
 *
 * Covers: insert/findById round-trip (incl. the JSON sessionKeyAuthorization
 * column round-tripping as an object), the (job, milestone) finders, setStatus,
 * the UNIQUE(job_id, milestone_index) one-session rule (§2.1-4), and that the
 * migration creates the table + its indexes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createStore,
  sql,
  type Store,
  type EvidenceSessionInsert,
} from "../index.js";

function makeRow(
  overrides: Partial<EvidenceSessionInsert> = {},
): EvidenceSessionInsert {
  return {
    sessionId: "sess-1",
    jobId: "job-1",
    milestoneIndex: 0,
    sessionKeyAuthorization: { sessionId: "sess-1", scope: { contractIds: ["job-1"] } },
    notBefore: 1_800_000_000,
    expiresAt: 1_800_003_600,
    evidenceSubmissionDeadline: 1_800_007_200,
    status: "open",
    openedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("EvidenceSessionRepository", () => {
  let store: Store;
  beforeEach(() => {
    store = createStore({ seed: false });
  });
  afterEach(() => {
    store.close();
  });

  it("insert + findById round-trip (JSON column parses to an object)", () => {
    const inserted = store.repos.evidenceSessions.insert(makeRow());
    expect(inserted?.sessionId).toBe("sess-1");
    const found = store.repos.evidenceSessions.findById("sess-1");
    expect(found?.jobId).toBe("job-1");
    expect(found?.milestoneIndex).toBe(0);
    expect(found?.notBefore).toBe(1_800_000_000);
    expect(found?.expiresAt).toBe(1_800_003_600);
    expect(found?.evidenceSubmissionDeadline).toBe(1_800_007_200);
    expect(found?.status).toBe("open");
    // JSON column round-trips as a parsed object, not a string.
    const auth = found?.sessionKeyAuthorization as { scope: { contractIds: string[] } };
    expect(auth.scope.contractIds).toEqual(["job-1"]);
  });

  it("findByJobMilestone returns the single session for a (job, milestone), any status", () => {
    store.repos.evidenceSessions.insert(makeRow({ status: "finalized" }));
    const found = store.repos.evidenceSessions.findByJobMilestone("job-1", 0);
    expect(found?.sessionId).toBe("sess-1");
    expect(found?.status).toBe("finalized");
    expect(store.repos.evidenceSessions.findByJobMilestone("job-1", 9)).toBeUndefined();
  });

  it("findOpenByJobMilestone returns only an open session", () => {
    store.repos.evidenceSessions.insert(makeRow());
    expect(store.repos.evidenceSessions.findOpenByJobMilestone("job-1", 0)?.sessionId).toBe("sess-1");
    store.repos.evidenceSessions.setStatus("sess-1", "finalized");
    expect(store.repos.evidenceSessions.findOpenByJobMilestone("job-1", 0)).toBeUndefined();
    // still findable any-status
    expect(store.repos.evidenceSessions.findByJobMilestone("job-1", 0)?.status).toBe("finalized");
  });

  it("setStatus updates and returns the row", () => {
    store.repos.evidenceSessions.insert(makeRow());
    const updated = store.repos.evidenceSessions.setStatus("sess-1", "finalized");
    expect(updated?.status).toBe("finalized");
    expect(store.repos.evidenceSessions.findById("sess-1")?.status).toBe("finalized");
  });

  it("transitionIfOpen: CAS open→terminal succeeds only from open (round-7 acceptance-guard primitive)", () => {
    store.repos.evidenceSessions.insert(makeRow()); // status "open"
    const won = store.repos.evidenceSessions.transitionIfOpen("sess-1", "terminal_success");
    expect(won?.status).toBe("terminal_success");
    expect(store.repos.evidenceSessions.findById("sess-1")?.status).toBe("terminal_success");
    // A second transition (session no longer open) updates NO row and leaves the status untouched —
    // this is what makes a post-terminal acceptance and a concurrent second terminal lose the race.
    const lost = store.repos.evidenceSessions.transitionIfOpen("sess-1", "terminal_fault");
    expect(lost).toBeUndefined();
    expect(store.repos.evidenceSessions.findById("sess-1")?.status).toBe("terminal_success");
    // Unknown session → undefined (no row matches the WHERE).
    expect(store.repos.evidenceSessions.transitionIfOpen("nope", "terminal_success")).toBeUndefined();
  });

  it("enforces UNIQUE(job_id, milestone_index): a second session for the same (job, milestone) is rejected", () => {
    store.repos.evidenceSessions.insert(makeRow({ sessionId: "sess-1" }));
    // A DIFFERENT sessionId for the SAME (job, milestone) must violate the unique
    // index — the DB fail-closes the one-session-per-(job,milestone) rule (§2.1-4).
    expect(() =>
      store.repos.evidenceSessions.insert(makeRow({ sessionId: "sess-2" })),
    ).toThrow();
    // A different milestone in the same job inserts fine.
    expect(
      store.repos.evidenceSessions.insert(
        makeRow({ sessionId: "sess-1b", milestoneIndex: 1 }),
      )?.milestoneIndex,
    ).toBe(1);
  });

  it("migration creates the evidence_sessions table + its indexes", () => {
    const tables = store.db.all(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='evidence_sessions'`,
    ) as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("evidence_sessions");

    const indexes = store.db.all(
      sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='evidence_sessions' AND name NOT LIKE 'sqlite_%'`,
    ) as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("evidence_sessions_job_idx");
    expect(names).toContain("evidence_sessions_job_milestone_unique");
  });
});
