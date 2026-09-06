/**
 * Evidence session store (§2.1) — window-from-terms + one-open-session policy.
 *
 * computeWindow: terms-supplied vs env vs hard default; deadline >= expiresAt.
 * open: opened; re-open same delegation -> idempotent; different delegation while
 * open -> session_already_open; open after finalize -> session_finalized.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "@pcc/store";
import {
  EvidenceSessionStore,
  computeWindow,
  evidenceSessionId,
} from "../services/evidence-session-store.js";

const NOW = 1_800_000_000; // Unix seconds

describe("computeWindow (§2.1-3 window-from-terms)", () => {
  const ENV_EXEC = "PCC_EXECUTION_WINDOW_DEFAULT_SECONDS";
  const ENV_DEADLINE = "PCC_EVIDENCE_DEADLINE_DEFAULT_SECONDS";

  beforeEach(() => {
    delete process.env[ENV_EXEC];
    delete process.env[ENV_DEADLINE];
  });
  afterEach(() => {
    delete process.env[ENV_EXEC];
    delete process.env[ENV_DEADLINE];
  });

  it("sources both durations from terms when present", () => {
    const w = computeWindow(
      { executionWindowSeconds: 7200, evidenceDeadlineSeconds: 172_800 },
      NOW,
    );
    expect(w.notBefore).toBe(NOW);
    expect(w.expiresAt).toBe(NOW + 7200);
    expect(w.evidenceSubmissionDeadline).toBe(NOW + 172_800);
    expect(w.evidenceSubmissionDeadline).toBeGreaterThanOrEqual(w.expiresAt);
  });

  it("falls back to env defaults when terms carry no durations", () => {
    process.env[ENV_EXEC] = "1000";
    process.env[ENV_DEADLINE] = "5000";
    const w = computeWindow({}, NOW);
    expect(w.expiresAt).toBe(NOW + 1000);
    expect(w.evidenceSubmissionDeadline).toBe(NOW + 5000);
  });

  it("falls back to hard defaults (3600 / 86400) when neither terms nor env supply durations", () => {
    const w = computeWindow(undefined, NOW);
    expect(w.expiresAt).toBe(NOW + 3600);
    expect(w.evidenceSubmissionDeadline).toBe(NOW + 86_400);
    expect(w.evidenceSubmissionDeadline).toBeGreaterThanOrEqual(w.expiresAt);
  });

  it("clamps the deadline up so it is never before the execution-window close", () => {
    // terms request a deadline SHORTER than the execution window — invalid, clamp up.
    const w = computeWindow(
      { executionWindowSeconds: 3600, evidenceDeadlineSeconds: 60 },
      NOW,
    );
    expect(w.evidenceSubmissionDeadline).toBe(NOW + 3600); // clamped to expiresAt
    expect(w.evidenceSubmissionDeadline).toBeGreaterThanOrEqual(w.expiresAt);
  });

  it("ignores non-positive / non-numeric term durations, falling through to defaults", () => {
    const w = computeWindow(
      { executionWindowSeconds: -5, evidenceDeadlineSeconds: "nope" },
      NOW,
    );
    expect(w.expiresAt).toBe(NOW + 3600);
    expect(w.evidenceSubmissionDeadline).toBe(NOW + 86_400);
  });
});

describe("EvidenceSessionStore.open (§2.1-4 one-open-session)", () => {
  let store: Store;
  let svc: EvidenceSessionStore;

  const jobId = "job-1";
  const mi = 0;
  const window = {
    notBefore: NOW,
    expiresAt: NOW + 3600,
    evidenceSubmissionDeadline: NOW + 86_400,
  };
  const delegation = {
    sessionId: "sk-1",
    scope: { contractIds: [jobId], maxSignatures: 10 },
  };

  beforeEach(() => {
    store = createStore({ seed: false });
    svc = new EvidenceSessionStore({ repo: store.repos.evidenceSessions });
  });
  afterEach(() => store.close());

  function open(overrides: Record<string, unknown> = {}) {
    return svc.open({
      jobId,
      milestoneIndex: mi,
      sessionKeyAuthorization: delegation,
      window,
      now: NOW,
      ...overrides,
    });
  }

  it("opens a new session with the deterministic sessionId evs-<job>-<mi> and the given window", () => {
    const r = open();
    expect(r.status).toBe("opened");
    if (r.status === "opened") {
      expect(r.session.sessionId).toBe("evs-job-1-0");
      expect(r.session.status).toBe("open");
      expect(r.session.notBefore).toBe(NOW);
      expect(r.session.expiresAt).toBe(NOW + 3600);
      expect(r.session.evidenceSubmissionDeadline).toBe(NOW + 86_400);
    }
    expect(evidenceSessionId("job-1", 0)).toBe("evs-job-1-0");
  });

  it("S6-8: records the DELEGATION's session-key id distinctly from the evidence sessionId", () => {
    const r = open();
    expect(r.status).toBe("opened");
    if (r.status === "opened") {
      // The evidence sessionId (PK) is the DERIVED one; the delegation's crypto id is separate.
      expect(r.session.sessionId).toBe("evs-job-1-0");
      expect(r.session.delegationSessionId).toBe("sk-1");
      expect(r.session.sessionId).not.toBe(r.session.delegationSessionId);
    }
    // Persisted on the row — queryable, not buried in the auth JSON.
    expect(store.repos.evidenceSessions.findByJobMilestone(jobId, mi)?.delegationSessionId).toBe(
      "sk-1",
    );
  });

  it("re-open with the SAME delegation is idempotent (stored session returned, still one row)", () => {
    expect(open().status).toBe("opened");
    const second = open();
    expect(second.status).toBe("idempotent");
    if (second.status === "idempotent") {
      expect(second.session.sessionId).toBe("evs-job-1-0");
    }
    // UNIQUE(job_id, milestone_index) guarantees at most one row.
    expect(store.repos.evidenceSessions.findByJobMilestone(jobId, mi)?.sessionId).toBe(
      "evs-job-1-0",
    );
  });

  it("a DIFFERENT delegation while one is open -> conflict session_already_open", () => {
    expect(open().status).toBe("opened");
    const other = open({
      sessionKeyAuthorization: {
        sessionId: "sk-2",
        scope: { contractIds: [jobId], maxSignatures: 5 },
      },
    });
    expect(other.status).toBe("conflict");
    if (other.status === "conflict") expect(other.reason).toBe("session_already_open");
  });

  it("open after the session is finalized -> conflict session_finalized", () => {
    expect(open().status).toBe("opened");
    store.repos.evidenceSessions.setStatus("evs-job-1-0", "finalized");
    const again = open();
    expect(again.status).toBe("conflict");
    if (again.status === "conflict") expect(again.reason).toBe("session_finalized");
  });
});
