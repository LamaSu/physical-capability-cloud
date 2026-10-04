/**
 * attempt-analysis.test.ts — agent-onboarding observability, item 10a.
 *
 * All records are synthetic. `now` is always a fixed timestamp — never
 * Date.now() — so every assertion here is deterministic. Covers:
 *
 *   • sessionize: kind filtering, malformed-input safety, out-of-order/dup
 *     seq, finalOutcome (roll-up vs last report), stalled + budgetStop.
 *   • normalizePath / normalizeSummary: the placeholder rules and ordering.
 *   • failureSignature: same-break merging across ids/uuids/numbers, and
 *     divergence on phase/endpoint/status.
 *   • rankSignatures: recency decay and the harness-spread tie-break.
 *   • phaseFunnel: reached/ok/failed/blocked/skipped counts.
 *   • proposalQueue: grouping, routing, dedup and the 5-example cap.
 *   • weeklyDigest: size budget and the no-id/no-email safety property.
 *   • analyzeAttempts: end-to-end composition.
 */

import { describe, it, expect } from "vitest";
import {
  sessionize,
  normalizePath,
  normalizeSummary,
  failureSignature,
  rankSignatures,
  phaseFunnel,
  proposalQueue,
  weeklyDigest,
  analyzeAttempts,
  RUNBOOK_PHASES,
  type AttemptRecord,
  type AttemptAnalysis,
} from "../services/attempt-analysis.js";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

// ── Fixture helpers ──────────────────────────────────────────────────────────

/** A raw (untyped) attempt report, as it would arrive from JSONL storage. */
function mkAttempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "at-1",
    kind: "attempt",
    contract: "attempt.v1",
    sessionId: "11111111-1111-4111-8111-111111111111",
    seq: 0,
    phase: "prerequisites",
    outcome: "ok",
    durationMs: 1000,
    summary: "prerequisites: ok",
    detail: null,
    logs: null,
    phases: null,
    ids: null,
    device: null,
    harness: { name: "claude-code", version: "1.0.0", model: "claude-opus-5-5" },
    pack: { version: "1.0.0", digestPrefix: "abcdef0123456789" },
    env: null,
    tokens: null,
    proposal: null,
    traceId: null,
    createdAt: "2026-09-29T10:00:00.000Z",
    ...overrides,
  };
}

/** A fully-populated, already-normalized AttemptRecord for unit-level tests. */
function mkRecord(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: "at-1",
    sessionId: "s1",
    seq: 0,
    phase: "prerequisites",
    outcome: "ok",
    durationMs: null,
    summary: "",
    detail: null,
    logs: [],
    phases: null,
    ids: null,
    device: null,
    harness: null,
    pack: null,
    env: null,
    tokens: null,
    proposal: null,
    traceId: null,
    createdAt: null,
    ...overrides,
  };
}

// ── sessionize ───────────────────────────────────────────────────────────────

describe("sessionize", () => {
  it("ignores records whose kind is not 'attempt'", () => {
    const records = [
      mkAttempt({ seq: 0 }),
      { kind: "pcc_report", sessionId: "11111111-1111-4111-8111-111111111111", seq: 1, summary: "classic report" },
      { sessionId: "11111111-1111-4111-8111-111111111111", seq: 2 }, // no kind at all
    ];
    const sessions = sessionize(records, { now: NOW });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].reports).toHaveLength(1);
    expect(sessions[0].reports[0].seq).toBe(0);
  });

  it("ignores malformed records without throwing", () => {
    const malformed: unknown[] = [
      null,
      undefined,
      42,
      "a string",
      [1, 2, 3],
      {},
      { kind: "attempt" }, // no sessionId
      { kind: "attempt", sessionId: "" }, // empty sessionId
      { kind: "attempt", sessionId: "s1" }, // no seq
      { kind: "attempt", sessionId: "s1", seq: "0" }, // seq not a number
      { kind: "attempt", sessionId: "s1", seq: 1.5 }, // seq not an integer
      { kind: "attempt", sessionId: "s1", seq: 0, logs: "nope", device: "nope", harness: 123, proposal: [] },
    ];
    expect(() => sessionize(malformed, { now: NOW })).not.toThrow();
    const sessions = sessionize(malformed, { now: NOW });
    // Only the last record (seq 0, valid sessionId+seq) survives.
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("s1");
    expect(sessions[0].reports[0].logs).toEqual([]);
    expect(sessions[0].reports[0].device).toBeNull();
    expect(sessions[0].reports[0].harness).toBeNull();
    expect(sessions[0].reports[0].proposal).toBeNull();
  });

  it("orders out-of-order seq and drops duplicate seq, keeping the first stored", () => {
    const sid = "22222222-2222-4222-8222-222222222222";
    const records = [
      mkAttempt({ sessionId: sid, seq: 2, phase: "build", summary: "third" }),
      mkAttempt({ sessionId: sid, seq: 0, phase: "prerequisites", summary: "first" }),
      mkAttempt({ sessionId: sid, seq: 1, phase: "identify", summary: "second (first-stored)" }),
      mkAttempt({ sessionId: sid, seq: 1, phase: "identify", summary: "second (duplicate, must be dropped)" }),
    ];
    const [session] = sessionize(records, { now: NOW });
    expect(session.reports.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(session.reports.map((r) => r.summary)).toEqual(["first", "second (first-stored)", "third"]);
  });

  it("finalOutcome comes from the session roll-up when present, else the last report", () => {
    const sidA = "33333333-3333-4333-8333-333333333333";
    const withRollup = [
      mkAttempt({ sessionId: sidA, seq: 0, phase: "prerequisites", outcome: "ok" }),
      mkAttempt({ sessionId: sidA, seq: 1, phase: "identify", outcome: "failed" }),
      mkAttempt({ sessionId: sidA, seq: 2, phase: "session", outcome: "ok", durationMs: 5000 }),
    ];
    const [sessionA] = sessionize(withRollup, { now: NOW });
    expect(sessionA.finalOutcome).toBe("ok"); // roll-up wins over the failed phase report
    expect(sessionA.lastPhase).toBe("identify"); // last NON-session report
    expect(sessionA.totalDurationMs).toBe(5000); // roll-up's own durationMs

    const sidB = "44444444-4444-4444-8444-444444444444";
    const withoutRollup = [
      mkAttempt({ sessionId: sidB, seq: 0, phase: "prerequisites", outcome: "ok", durationMs: 1000 }),
      mkAttempt({ sessionId: sidB, seq: 1, phase: "identify", outcome: "blocked", durationMs: 2000 }),
    ];
    const [sessionB] = sessionize(withoutRollup, { now: NOW });
    expect(sessionB.finalOutcome).toBe("blocked"); // no roll-up -> last report's outcome
    expect(sessionB.lastPhase).toBe("identify");
    expect(sessionB.totalDurationMs).toBe(3000); // sum of phase durations
  });

  it("flags stalled sessions (no roll-up, quiet for longer than stallMs)", () => {
    const sidStalled = "55555555-5555-4555-8555-555555555555";
    const stalledRecords = [
      mkAttempt({ sessionId: sidStalled, seq: 0, phase: "build", outcome: "in_progress", createdAt: new Date(NOW - 10 * HOUR).toISOString() }),
    ];
    const [stalledSession] = sessionize(stalledRecords, { now: NOW });
    expect(stalledSession.stalled).toBe(true);

    const sidFresh = "66666666-6666-4666-8666-666666666666";
    const freshRecords = [
      mkAttempt({ sessionId: sidFresh, seq: 0, phase: "build", outcome: "in_progress", createdAt: new Date(NOW - 1 * HOUR).toISOString() }),
    ];
    const [freshSession] = sessionize(freshRecords, { now: NOW });
    expect(freshSession.stalled).toBe(false);

    const sidRolledUp = "77777777-7777-4777-8777-777777777777";
    const rolledUpOldRecords = [
      mkAttempt({ sessionId: sidRolledUp, seq: 0, phase: "build", outcome: "ok", createdAt: new Date(NOW - 10 * HOUR).toISOString() }),
      mkAttempt({ sessionId: sidRolledUp, seq: 1, phase: "session", outcome: "ok", createdAt: new Date(NOW - 10 * HOUR).toISOString() }),
    ];
    const [rolledUpSession] = sessionize(rolledUpOldRecords, { now: NOW });
    expect(rolledUpSession.stalled).toBe(false); // a roll-up disqualifies "stalled" regardless of age

    // Custom stallMs override.
    const sidCustom = "88888888-8888-4888-8888-888888888888";
    const customRecords = [
      mkAttempt({ sessionId: sidCustom, seq: 0, phase: "build", outcome: "in_progress", createdAt: new Date(NOW - 1 * HOUR).toISOString() }),
    ];
    const [customSession] = sessionize(customRecords, { now: NOW, stallMs: 30 * 60 * 1000 });
    expect(customSession.stalled).toBe(true); // 1h quiet > 30min custom threshold
  });

  it("flags budgetStop from any report or the roll-up, including the 'budget-stop' spelling", () => {
    const sid = "99999999-9999-4999-8999-999999999999";
    const records = [
      mkAttempt({ sessionId: sid, seq: 0, phase: "build", outcome: "ok" }),
      mkAttempt({ sessionId: sid, seq: 1, phase: "register", outcome: "budget-stop" }), // hyphen spelling
      mkAttempt({ sessionId: sid, seq: 2, phase: "session", outcome: "abandoned" }),
    ];
    const [session] = sessionize(records, { now: NOW });
    expect(session.budgetStop).toBe(true);
    expect(session.reports[1].outcome).toBe("budget_stop"); // normalized

    const sidNo = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const noBudget = [mkAttempt({ sessionId: sidNo, seq: 0, phase: "build", outcome: "ok" })];
    const [sessionNo] = sessionize(noBudget, { now: NOW });
    expect(sessionNo.budgetStop).toBe(false);
  });

  it("collects harness/device/pack and all non-null proposals for the session", () => {
    const sid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const records = [
      mkAttempt({ sessionId: sid, seq: 0, phase: "prerequisites", harness: null, device: null, pack: null }),
      mkAttempt({
        sessionId: sid,
        seq: 1,
        phase: "register",
        harness: { name: "codex", version: "9.9", model: "x" },
        device: { make: "Opentrons", model: "OT-2", class: "lab_instrument" },
        pack: { version: "2.20.0", digestPrefix: "deadbeef01234567" },
        proposal: { target: "runbook", path: "runbook.json#register", text: "Ask earlier" },
      }),
      mkAttempt({
        sessionId: sid,
        seq: 2,
        phase: "session",
        proposal: { target: "docs", path: null, text: "Clarify docs" },
      }),
    ];
    const [session] = sessionize(records, { now: NOW });
    expect(session.harnessName).toBe("codex");
    expect(session.deviceClass).toBe("lab_instrument");
    expect(session.packVersion).toBe("2.20.0");
    expect(session.proposals).toHaveLength(2);
    expect(session.proposals.map((p) => p.target)).toEqual(["runbook", "docs"]);
  });

  it("sorts sessions by lastAt descending", () => {
    const older = mkAttempt({ sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", seq: 0, createdAt: new Date(NOW - 5 * HOUR).toISOString() });
    const newer = mkAttempt({ sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", seq: 0, createdAt: new Date(NOW - 1 * HOUR).toISOString() });
    const sessions = sessionize([older, newer], { now: NOW });
    expect(sessions.map((s) => s.sessionId)).toEqual(["dddddddd-dddd-4ddd-8ddd-dddddddddddd", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
  });
});

// ── normalizePath ────────────────────────────────────────────────────────────

describe("normalizePath", () => {
  it("strips the query string and keeps the leading slash", () => {
    expect(normalizePath("/api/kernels?foo=bar&baz=1")).toBe("/api/kernels");
  });

  it("replaces a UUID segment with :id", () => {
    expect(normalizePath("/api/kernels/6f1c2a4e-8b7d-4c3f-9a21-0d5e6b7c8f90")).toBe("/api/kernels/:id");
  });

  it("replaces a hex run of >=8 chars with :id", () => {
    expect(normalizePath("/api/packs/deadbeef01234567")).toBe("/api/packs/:id");
  });

  it("replaces a pure numeric segment with :id", () => {
    expect(normalizePath("/api/jobs/12345")).toBe("/api/jobs/:id");
  });

  it("replaces an id-like segment (digit + >=6 chars) with :id", () => {
    expect(normalizePath("/api/kernels/kernel_ab12cd")).toBe("/api/kernels/:id");
  });

  it("lowercases the whole path", () => {
    expect(normalizePath("/API/Kernels")).toBe("/api/kernels");
  });

  it("leaves short/non-id segments untouched", () => {
    expect(normalizePath("/api/v2/kernels")).toBe("/api/v2/kernels");
  });
});

// ── normalizeSummary ─────────────────────────────────────────────────────────

describe("normalizeSummary", () => {
  it("lowercases the text", () => {
    expect(normalizeSummary("POST Failed")).toBe("post failed");
  });

  it("replaces a UUID with <uuid> without leaving partial hex fragments", () => {
    expect(normalizeSummary("session 6f1c2a4e-8b7d-4c3f-9a21-0d5e6b7c8f90 failed")).toBe("session <uuid> failed");
  });

  it("replaces a hex run (>=8 chars, contains a letter) with <hex>", () => {
    expect(normalizeSummary("digest deadbeef01234567 mismatch")).toBe("digest <hex> mismatch");
  });

  it("replaces pure-digit runs with <n>, not <hex>", () => {
    expect(normalizeSummary("POST /api/kernels returned 400: missing evidence tier")).toBe(
      "post /api/kernels returned <n>: missing evidence tier",
    );
  });

  it("replaces single/double/backtick-quoted text with <q>", () => {
    expect(normalizeSummary(`field 'evidenceTier' and "device" and \`class\` missing`)).toBe(
      "field <q> and <q> and <q> missing",
    );
  });

  it("collapses whitespace and trims", () => {
    expect(normalizeSummary("  too   much    space  ")).toBe("too much space");
  });

  it("caps at 160 chars", () => {
    const long = "x".repeat(500);
    const out = normalizeSummary(long);
    expect(out.length).toBe(160);
  });
});

// ── failureSignature ─────────────────────────────────────────────────────────

describe("failureSignature", () => {
  it("is null for outcomes that are not failed/blocked/budget_stop", () => {
    for (const outcome of ["ok", "skipped", "in_progress", "unknown", "abandoned"] as const) {
      expect(failureSignature(mkRecord({ outcome, summary: "whatever" }))).toBeNull();
    }
  });

  it("merges the same break across different ids/uuids/numbers", () => {
    const a = mkRecord({
      phase: "register",
      outcome: "failed",
      summary: "POST /api/kernels returned 400: missing evidence tier for kernel 12345678",
      logs: [{ step: 3, method: "post", path: "/api/kernels/11111111-1111-4111-8111-111111111111", status: 400, note: null }],
    });
    const b = mkRecord({
      phase: "register",
      outcome: "failed",
      summary: "POST /api/kernels returned 400: missing evidence tier for kernel 87654321",
      logs: [{ step: 3, method: "post", path: "/api/kernels/22222222-2222-4222-8222-222222222222", status: 400, note: null }],
    });
    const sigA = failureSignature(a);
    const sigB = failureSignature(b);
    expect(sigA).not.toBeNull();
    expect(sigA?.key).toBe(sigB?.key);
    expect(sigA?.template).toBe(sigB?.template);
    expect(sigA?.template).toBe("register/failed POST /api/kernels/:id 400 · post /api/kernels returned <n>: missing evidence tier for kernel <n>");
  });

  it("produces a different key for a different phase", () => {
    const base = mkRecord({ phase: "register", outcome: "failed", summary: "boom" });
    const diffPhase = mkRecord({ phase: "verify", outcome: "failed", summary: "boom" });
    expect(failureSignature(base)?.key).not.toBe(failureSignature(diffPhase)?.key);
  });

  it("produces a different key for a different endpoint", () => {
    const a = mkRecord({
      phase: "register",
      outcome: "failed",
      summary: "boom",
      logs: [{ step: 1, method: "post", path: "/api/kernels", status: 400, note: null }],
    });
    const b = mkRecord({
      phase: "register",
      outcome: "failed",
      summary: "boom",
      logs: [{ step: 1, method: "post", path: "/api/capabilities", status: 400, note: null }],
    });
    expect(failureSignature(a)?.key).not.toBe(failureSignature(b)?.key);
  });

  it("produces a different key for a different status", () => {
    const a = mkRecord({
      phase: "register",
      outcome: "failed",
      summary: "boom",
      logs: [{ step: 1, method: "post", path: "/api/kernels", status: 400, note: null }],
    });
    const b = mkRecord({
      phase: "register",
      outcome: "failed",
      summary: "boom",
      logs: [{ step: 1, method: "post", path: "/api/kernels", status: 404, note: null }],
    });
    expect(failureSignature(a)?.key).not.toBe(failureSignature(b)?.key);
  });

  it("uses the FIRST log entry with status >= 400", () => {
    const rec = mkRecord({
      phase: "register",
      outcome: "failed",
      summary: "boom",
      logs: [
        { step: 1, method: "get", path: "/api/health", status: 200, note: null },
        { step: 2, method: "post", path: "/api/kernels", status: 400, note: null },
        { step: 3, method: "post", path: "/api/kernels/retry", status: 500, note: null },
      ],
    });
    expect(failureSignature(rec)?.template).toContain("POST /api/kernels 400");
  });

  it("handles no bad log entry (template omits the log segment)", () => {
    const rec = mkRecord({ phase: "operate", outcome: "blocked", summary: "device unresponsive", logs: [] });
    expect(failureSignature(rec)?.template).toBe("operate/blocked · device unresponsive");
  });
});

// ── rankSignatures ───────────────────────────────────────────────────────────

describe("rankSignatures", () => {
  function sessionWith(sessionId: string, harnessName: string, createdAt: string, extra: Record<string, unknown> = {}) {
    return mkAttempt({
      sessionId,
      seq: 0,
      phase: "register",
      outcome: "failed",
      summary: "POST /api/kernels returned 400: missing evidence tier",
      harness: { name: harnessName, version: "1.0", model: "m" },
      createdAt,
      ...extra,
    });
  }

  it("ranks a more recent signature above an equally-hit, equally-unrecovered older one", () => {
    const recent = sessionWith("e0000000-0000-4000-8000-000000000001", "claude-code", new Date(NOW - 1 * HOUR).toISOString(), {
      summary: "recent break A", // distinct text -> distinct signature key from the "old" one below
    });
    const old = sessionWith("e0000000-0000-4000-8000-000000000002", "claude-code", new Date(NOW - 30 * 24 * HOUR).toISOString(), {
      summary: "old break B",
    });
    const sessions = sessionize([recent, old], { now: NOW });
    const ranked = rankSignatures(sessions, { now: NOW, halfLifeDays: 7 });
    expect(ranked).toHaveLength(2);
    // Both have sessionsHit=1 and unrecoveredShare=1 (finalOutcome failed) -> recency alone decides.
    expect(ranked[0].exampleSummary).toContain("recent break a");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("breaks a score tie by harness spread (more distinct harnesses ranks first)", () => {
    const createdAt = new Date(NOW - 1 * HOUR).toISOString();
    // Signature A: hit by 2 sessions, both on the same harness.
    const aSession1 = sessionWith("f0000000-0000-4000-8000-00000000000a", "claude-code", createdAt, { summary: "signature alpha" });
    const aSession2 = sessionWith("f0000000-0000-4000-8000-00000000000b", "claude-code", createdAt, { summary: "signature alpha" });
    // Signature B: hit by 2 sessions, on two different harnesses.
    const bSession1 = sessionWith("f0000000-0000-4000-8000-00000000000c", "claude-code", createdAt, { summary: "signature bravo" });
    const bSession2 = sessionWith("f0000000-0000-4000-8000-00000000000d", "codex", createdAt, { summary: "signature bravo" });

    const sessions = sessionize([aSession1, aSession2, bSession1, bSession2], { now: NOW });
    const ranked = rankSignatures(sessions, { now: NOW });
    expect(ranked).toHaveLength(2);
    // Equal sessionsHit (2), equal unrecoveredShare (1), equal lastSeen -> equal score.
    expect(ranked[0].score).toBeCloseTo(ranked[1].score, 10);
    expect(ranked[0].exampleSummary).toContain("signature bravo"); // 2 harnesses ranks first
    expect(ranked[0].harnessNames).toEqual(["claude-code", "codex"]);
    expect(ranked[1].harnessNames).toEqual(["claude-code"]);
  });

  it("breaks a remaining tie by key ascending", () => {
    const createdAt = new Date(NOW - 1 * HOUR).toISOString();
    const recA = mkRecord({ phase: "register", outcome: "failed", summary: "tie one", createdAt });
    const recB = mkRecord({ phase: "verify", outcome: "failed", summary: "tie two", createdAt });
    const sigA = failureSignature(recA)!;
    const sigB = failureSignature(recB)!;
    const [expectedFirstKey, expectedSecondKey] = [sigA.key, sigB.key].sort();

    const sessionA = sessionWith("aa000000-0000-4000-8000-0000000000a1", "claude-code", createdAt, { phase: "register", summary: "tie one" });
    const sessionB = sessionWith("aa000000-0000-4000-8000-0000000000b1", "claude-code", createdAt, { phase: "verify", summary: "tie two" });
    const sessions = sessionize([sessionA, sessionB], { now: NOW });
    const ranked = rankSignatures(sessions, { now: NOW });
    expect(ranked.map((r) => r.key)).toEqual([expectedFirstKey, expectedSecondKey]);
  });

  it("computes sessionsHit, harness/device spread and unrecoveredShare correctly", () => {
    const sid1 = "bb000000-0000-4000-8000-0000000000a1";
    const sid2 = "bb000000-0000-4000-8000-0000000000a2";
    const createdAt = new Date(NOW - 1 * HOUR).toISOString();
    const records = [
      // Session 1: hits the signature, recovers afterwards (finalOutcome ok via roll-up).
      mkAttempt({
        sessionId: sid1,
        seq: 0,
        phase: "register",
        outcome: "failed",
        summary: "POST /api/kernels returned 400: missing evidence tier",
        harness: { name: "claude-code", version: "1", model: "m" },
        device: { make: "m", model: "m", class: "robot" },
        createdAt,
      }),
      mkAttempt({ sessionId: sid1, seq: 1, phase: "session", outcome: "ok", createdAt }),
      // Session 2: hits the same signature, never recovers (no roll-up, finalOutcome = last report = failed).
      mkAttempt({
        sessionId: sid2,
        seq: 0,
        phase: "register",
        outcome: "failed",
        summary: "POST /api/kernels returned 400: missing evidence tier",
        harness: { name: "codex", version: "1", model: "m" },
        device: { make: "m", model: "m", class: "printer" },
        createdAt,
      }),
    ];
    const sessions = sessionize(records, { now: NOW });
    const [ranked] = rankSignatures(sessions, { now: NOW });
    expect(ranked.sessionsHit).toBe(2);
    expect(ranked.harnessNames).toEqual(["claude-code", "codex"]);
    expect(ranked.deviceClasses).toEqual(["printer", "robot"]);
    expect(ranked.unrecoveredShare).toBeCloseTo(0.5, 10); // 1 of 2 sessions unrecovered
  });
});

// ── phaseFunnel ──────────────────────────────────────────────────────────────

describe("phaseFunnel", () => {
  it("counts reached/ok/failed/blocked/skipped by each phase's last report in the session", () => {
    const records = [
      // Session 1: prerequisites ok, identify failed-then-ok (last wins).
      mkAttempt({ sessionId: "c0000000-0000-4000-8000-000000000001", seq: 0, phase: "prerequisites", outcome: "ok" }),
      mkAttempt({ sessionId: "c0000000-0000-4000-8000-000000000001", seq: 1, phase: "identify", outcome: "failed" }),
      mkAttempt({ sessionId: "c0000000-0000-4000-8000-000000000001", seq: 2, phase: "identify", outcome: "ok" }),
      // Session 2: prerequisites blocked, never reaches identify.
      mkAttempt({ sessionId: "c0000000-0000-4000-8000-000000000002", seq: 0, phase: "prerequisites", outcome: "blocked" }),
      // Session 3: prerequisites skipped.
      mkAttempt({ sessionId: "c0000000-0000-4000-8000-000000000003", seq: 0, phase: "prerequisites", outcome: "skipped" }),
    ];
    const sessions = sessionize(records, { now: NOW });
    const funnel = phaseFunnel(sessions);

    expect(funnel.map((r) => r.phase)).toEqual(RUNBOOK_PHASES);

    const prereq = funnel.find((r) => r.phase === "prerequisites")!;
    expect(prereq).toEqual({ phase: "prerequisites", reached: 3, ok: 1, failed: 0, blocked: 1, skipped: 1 });

    const identify = funnel.find((r) => r.phase === "identify")!;
    expect(identify).toEqual({ phase: "identify", reached: 1, ok: 1, failed: 0, blocked: 0, skipped: 0 });

    const build = funnel.find((r) => r.phase === "build")!;
    expect(build).toEqual({ phase: "build", reached: 0, ok: 0, failed: 0, blocked: 0, skipped: 0 });
  });

  it("excludes session and other phases from the funnel", () => {
    const records = [
      mkAttempt({ sessionId: "c0000000-0000-4000-8000-000000000004", seq: 0, phase: "prerequisites", outcome: "ok" }),
      mkAttempt({ sessionId: "c0000000-0000-4000-8000-000000000004", seq: 1, phase: "session", outcome: "ok" }),
      mkAttempt({ sessionId: "c0000000-0000-4000-8000-000000000004", seq: 2, phase: "some-future-phase", outcome: "ok" }), // -> "other"
    ];
    const sessions = sessionize(records, { now: NOW });
    const funnel = phaseFunnel(sessions);
    expect(funnel.some((r) => (r.phase as string) === "session")).toBe(false);
    expect(funnel.some((r) => (r.phase as string) === "other")).toBe(false);
  });
});

// ── proposalQueue ────────────────────────────────────────────────────────────

describe("proposalQueue", () => {
  it("routes each target to its lane", () => {
    const targets: Array<[string, string]> = [
      ["runbook", "adk"],
      ["agent-package", "adk"],
      ["docs", "launch"],
      ["code", "by-path"],
      ["process", "steward"],
      ["other", "steward"],
      ["something-unrecognized", "steward"], // unknown target -> "other" -> steward
    ];
    const records = targets.map(([target], i) =>
      mkAttempt({
        sessionId: `d0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        seq: 0,
        proposal: { target, path: null, text: `idea for ${target}` },
      }),
    );
    const sessions = sessionize(records, { now: NOW });
    const groups = proposalQueue(sessions);

    for (const [target, routeTo] of targets) {
      const expectedTarget = target === "something-unrecognized" ? "other" : target;
      const group = groups.find((g) => g.target === expectedTarget && g.examples.some((e) => e.includes(target)));
      expect(group, `expected a group for target ${target}`).toBeTruthy();
      expect(group!.routeTo).toBe(routeTo);
    }
  });

  it("counts distinct sessions separately from total proposal count", () => {
    const sid = "d1000000-0000-4000-8000-000000000001";
    const records = [
      mkAttempt({ sessionId: sid, seq: 0, proposal: { target: "code", path: "a.ts", text: "fix a" } }),
      mkAttempt({ sessionId: sid, seq: 1, proposal: { target: "code", path: "b.ts", text: "fix b" } }),
    ];
    const sessions = sessionize(records, { now: NOW });
    const [group] = proposalQueue(sessions);
    expect(group.target).toBe("code");
    expect(group.count).toBe(2); // two proposals
    expect(group.sessions).toBe(1); // from one session
  });

  it("dedupes examples case-insensitively and caps at 5, capping each at 200 chars", () => {
    const longText = "y".repeat(250);
    // 6 records, 5 DISTINCT texts (case-insensitively) so the long one still
    // has a slot left after the "do x" duplicate is skipped: Do X, Do Y, Do Z,
    // Do W, longText = 5 distinct -> all kept, none evicted by the 5-cap.
    const texts = ["Do X", "do x", "Do Y", "Do Z", "Do W", longText];
    const records = texts.map((text, i) =>
      mkAttempt({
        sessionId: `d2000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        seq: 0,
        proposal: { target: "process", path: null, text },
      }),
    );
    const sessions = sessionize(records, { now: NOW });
    const [group] = proposalQueue(sessions);
    expect(group.count).toBe(texts.length);
    expect(group.examples.length).toBe(5); // capped, "do x" dedup'd against "Do X"
    expect(group.examples).toContain("Do X");
    expect(group.examples).not.toContain("do x");
    const truncated = group.examples.find((e) => e.startsWith("y"));
    expect(truncated).toBeDefined();
    expect(truncated!.length).toBe(200);
  });

  it("evicts nothing extra when distinct examples exceed 5 (6th distinct text dropped, not truncated one)", () => {
    // 6 fully distinct texts -> only the first 5 encountered are kept.
    const texts = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];
    const records = texts.map((text, i) =>
      mkAttempt({
        sessionId: `d2100000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        seq: 0,
        proposal: { target: "process", path: null, text },
      }),
    );
    const sessions = sessionize(records, { now: NOW });
    const [group] = proposalQueue(sessions);
    expect(group.count).toBe(6);
    expect(group.examples).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
    expect(group.examples).not.toContain("Foxtrot");
  });

  it("orders groups by count descending", () => {
    const records = [
      mkAttempt({ sessionId: "d3000000-0000-4000-8000-000000000001", seq: 0, proposal: { target: "docs", path: null, text: "a" } }),
      mkAttempt({ sessionId: "d3000000-0000-4000-8000-000000000002", seq: 0, proposal: { target: "code", path: null, text: "b" } }),
      mkAttempt({ sessionId: "d3000000-0000-4000-8000-000000000003", seq: 0, proposal: { target: "code", path: null, text: "c" } }),
      mkAttempt({ sessionId: "d3000000-0000-4000-8000-000000000004", seq: 0, proposal: { target: "code", path: null, text: "d" } }),
    ];
    const sessions = sessionize(records, { now: NOW });
    const groups = proposalQueue(sessions);
    expect(groups.map((g) => g.target)).toEqual(["code", "docs"]);
  });
});

// ── weeklyDigest ─────────────────────────────────────────────────────────────

describe("weeklyDigest", () => {
  function bigAnalysis(): AttemptAnalysis {
    const records: Record<string, unknown>[] = [];
    const phases = RUNBOOK_PHASES;
    for (let i = 0; i < 60; i++) {
      const sid = `e${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`;
      const phase = phases[i % phases.length];
      const failing = i % 3 !== 0;
      records.push(
        mkAttempt({
          sessionId: sid,
          seq: 0,
          phase,
          outcome: failing ? "failed" : "ok",
          harness: { name: i % 2 === 0 ? "claude-code" : "codex", version: "1", model: "m" },
          summary: failing
            ? `POST /api/kernels/${1000 + i} returned 400: distinct failure text number ${i} for session`
            : `${phase}: ok`,
          logs: failing ? [{ step: 1, method: "post", path: `/api/kernels/${1000 + i}`, status: 400, note: null }] : null,
          proposal: { target: ["runbook", "docs", "code", "process"][i % 4], path: null, text: `${"z".repeat(210)}-${i}` },
          createdAt: new Date(NOW - (i + 1) * HOUR).toISOString(),
        }),
      );
    }
    return analyzeAttempts(records, { now: NOW });
  }

  it("stays within the 3000-byte budget even for a large analysis", () => {
    const digest = weeklyDigest(bigAnalysis(), { periodLabel: "2026-W39" });
    expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(3000);
    expect(digest.startsWith("# Attempt digest — 2026-W39")).toBe(true);
  });

  /** A letters-only (no digits) token, unique per `n`, immune to every
   * normalizeSummary placeholder rule (no uuid/hex/number shape) so each
   * record below produces a genuinely distinct failure signature. */
  function letterToken(n: number): string {
    let s = "";
    let x = n;
    do {
      s = String.fromCharCode(97 + (x % 26)) + s;
      x = Math.floor(x / 26) - 1;
    } while (x >= 0);
    return "qq" + s; // "qq" prefix: never a valid a-f hex run, never numeric
  }

  it("actually truncates when the top-N rendering exceeds the byte budget", () => {
    const n = 80;
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < n; i++) {
      records.push(
        mkAttempt({
          sessionId: `aa${String(i).padStart(6, "0")}-0000-4000-8000-000000000000`,
          seq: 0,
          phase: RUNBOOK_PHASES[i % RUNBOOK_PHASES.length],
          outcome: "failed",
          harness: { name: i % 2 === 0 ? "claude-code" : "codex", version: "1", model: "m" },
          summary: `distinct unmatched break token ${letterToken(i)} occurred while handling the onboarding request`,
          logs: null,
          createdAt: new Date(NOW - (i + 1) * 60000).toISOString(),
        }),
      );
    }
    const analysis = analyzeAttempts(records, { now: NOW });
    expect(analysis.signatures.length).toBe(n); // every record is its own distinct signature

    const digest = weeklyDigest(analysis, { periodLabel: "stress", topN: n });
    expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(3000);
    const signatureLines = digest.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(signatureLines.length).toBeLessThan(n); // proof truncation actually cut content
  });

  it("contains the period label, funnel table and proposal section", () => {
    const digest = weeklyDigest(bigAnalysis(), { periodLabel: "2026-W39" });
    expect(digest).toContain("2026-W39");
    expect(digest).toContain("## Funnel");
    expect(digest).toContain("## Proposals");
    expect(digest).toContain("## Top signatures");
  });

  it("respects a custom topN", () => {
    const analysis = bigAnalysis();
    const digest = weeklyDigest(analysis, { periodLabel: "p", topN: 2 });
    const signatureLines = digest.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(signatureLines.length).toBeLessThanOrEqual(2);
  });

  it("never contains a sessionId, kernelId, traceId or planted email from the fixtures", () => {
    const plantedEmail = "operator@example.com";
    const sid = "f9999999-9999-4999-8999-999999999999";
    const traceId = "trace-super-secret-12345";
    const records = [
      mkAttempt({
        sessionId: sid,
        seq: 0,
        phase: "register",
        outcome: "failed",
        summary: `POST /api/kernels returned 400: contact ${plantedEmail} for help`,
        ids: { kernelId: "kernel_ab12cd34", capabilityId: null, kitId: null, jobId: null },
        traceId,
        logs: [{ step: 1, method: "post", path: "/api/kernels", status: 400, note: null }],
      }),
    ];
    const analysis = analyzeAttempts(records, { now: NOW });
    const digest = weeklyDigest(analysis, { periodLabel: "safety-check" });

    expect(digest).not.toContain(sid);
    expect(digest).not.toContain("kernel_ab12cd34");
    expect(digest).not.toContain(traceId);
    expect(digest).not.toContain(plantedEmail);
    expect(digest).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("renders '(none)' sections and zero totals for an empty analysis", () => {
    const empty = analyzeAttempts([], { now: NOW });
    const digest = weeklyDigest(empty, { periodLabel: "empty" });
    expect(digest).toContain("Sessions: 0");
    expect(digest).toContain("(no sessions)");
    expect(digest).toContain("(none)");
  });
});

// ── analyzeAttempts (end to end) ─────────────────────────────────────────────

describe("analyzeAttempts", () => {
  it("composes sessionize + rankSignatures + phaseFunnel + proposalQueue + totals", () => {
    const sid1 = "aa111111-1111-4111-8111-111111111111";
    const sid2 = "aa222222-2222-4222-8222-222222222222";
    const createdAt1 = new Date(NOW - 2 * HOUR).toISOString();
    const createdAt2 = new Date(NOW - 1 * HOUR).toISOString();
    const records: Record<string, unknown>[] = [
      mkAttempt({ sessionId: sid1, seq: 0, phase: "prerequisites", outcome: "ok", createdAt: createdAt1, harness: { name: "claude-code", version: "1", model: "m" } }),
      mkAttempt({
        sessionId: sid1,
        seq: 1,
        phase: "register",
        outcome: "failed",
        summary: "POST /api/kernels returned 400: missing evidence tier",
        logs: [{ step: 1, method: "post", path: "/api/kernels", status: 400, note: null }],
        proposal: { target: "runbook", path: "runbook.json#register", text: "Ask for evidence tier earlier" },
        createdAt: createdAt1,
      }),
      mkAttempt({ sessionId: sid1, seq: 2, phase: "session", outcome: "failed", createdAt: createdAt1 }),
      mkAttempt({ sessionId: sid2, seq: 0, phase: "prerequisites", outcome: "ok", createdAt: createdAt2, harness: { name: "codex", version: "1", model: "m" } }),
      mkAttempt({ sessionId: sid2, seq: 1, phase: "session", outcome: "ok", createdAt: createdAt2 }),
      // Noise that must be dropped.
      { kind: "pcc_report", sessionId: sid2, seq: 2, summary: "not an attempt" },
      { kind: "attempt", sessionId: "no-seq" },
    ];

    const analysis = analyzeAttempts(records, { now: NOW });

    const expectedSessions = sessionize(records, { now: NOW });
    const expectedSignatures = rankSignatures(expectedSessions, { now: NOW });
    const expectedFunnel = phaseFunnel(expectedSessions);
    const expectedProposals = proposalQueue(expectedSessions);

    expect(analysis.sessions).toEqual(expectedSessions);
    expect(analysis.signatures).toEqual(expectedSignatures);
    expect(analysis.funnel).toEqual(expectedFunnel);
    expect(analysis.proposals).toEqual(expectedProposals);

    expect(analysis.sessions).toHaveLength(2);
    expect(analysis.totals.sessions).toBe(2);
    expect(analysis.totals.failedOrBlocked).toBe(1);
    expect(analysis.totals.finishedOk).toBe(1);
    expect(analysis.totals.harnessSplit).toEqual({ "claude-code": 1, codex: 1 });
    // One signature: the register/failed phase report. The failed roll-up only
    // restates it, so it is not counted as a second break.
    expect(analysis.signatures).toHaveLength(1);
    expect(analysis.signatures[0].template.startsWith("register/failed")).toBe(true);
    expect(analysis.signatures[0].sessionsHit).toBe(1);
    expect(analysis.proposals).toHaveLength(1);
    expect(analysis.proposals[0].target).toBe("runbook");
    expect(analysis.proposals[0].routeTo).toBe("adk");
  });

  it("returns an empty-but-well-formed analysis for no records", () => {
    const analysis = analyzeAttempts([], { now: NOW });
    expect(analysis.sessions).toEqual([]);
    expect(analysis.signatures).toEqual([]);
    expect(analysis.funnel).toHaveLength(RUNBOOK_PHASES.length);
    expect(analysis.funnel.every((r) => r.reached === 0)).toBe(true);
    expect(analysis.proposals).toEqual([]);
    expect(analysis.totals).toEqual({
      sessions: 0,
      finishedOk: 0,
      failedOrBlocked: 0,
      abandoned: 0,
      budgetStops: 0,
      stalled: 0,
      harnessSplit: {},
    });
  });
});

describe("lane review fixes (painpoints)", () => {
  it("normalizes hostile summaries in linear time (digit runs, long hex, many short runs)", () => {
    // 50k characters: large enough that a quadratic pattern takes seconds while a
    // linear one takes about a millisecond.
    const hostile = [
      "1".repeat(50_000),
      `${"0123456789".repeat(4999)}a`,
      "1234567 ".repeat(6000),
      `${"a1".repeat(25_000)}`,
      `${"'x".repeat(25_000)}`,
    ];
    for (const h of hostile) {
      const t0 = performance.now();
      normalizeSummary(h);
      expect(performance.now() - t0).toBeLessThan(50);
    }
    expect(normalizeSummary("id 12345678 and deadbeef00")).toBe("id <n> and <hex>");
  });

  it("keeps apostrophes inside words and still masks quoted values", () => {
    expect(normalizeSummary("Didn't find the 'kernel_9' key; couldn't retry")).toBe("didn't find the <q> key; couldn't retry");
    expect(normalizeSummary('field "tier" missing')).toBe("field <q> missing");
  });

  it("counts a failed roll-up as a signature only when no phase report failed", () => {
    const at = new Date(NOW - HOUR).toISOString();
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      const sid = `bb00000${i}-0000-4000-8000-00000000000${i}`;
      records.push(mkAttempt({ sessionId: sid, seq: 0, phase: "verify", outcome: "failed", summary: `test job ${i} timed out`, createdAt: at }));
      records.push(mkAttempt({ sessionId: sid, seq: 1, phase: "session", outcome: "failed", summary: "session: failed", createdAt: at }));
    }
    const lonely = "cc000000-0000-4000-8000-000000000000";
    records.push(mkAttempt({ sessionId: lonely, seq: 0, phase: "session", outcome: "abandoned", createdAt: at }));
    const crashed = "dd000000-0000-4000-8000-000000000000";
    records.push(mkAttempt({ sessionId: crashed, seq: 0, phase: "intake", outcome: "ok", createdAt: at }));
    records.push(mkAttempt({ sessionId: crashed, seq: 1, phase: "session", outcome: "failed", summary: "agent crashed during research", createdAt: at }));

    const ranked = rankSignatures(sessionize(records, { now: NOW }), { now: NOW });
    expect(ranked[0].template.startsWith("verify/failed")).toBe(true);
    expect(ranked[0].sessionsHit).toBe(5);
    const rollups = ranked.filter((r) => r.template.startsWith("session/"));
    expect(rollups).toHaveLength(1);
    expect(rollups[0].template).toContain("agent crashed during research");
    expect(rollups[0].sessionsHit).toBe(1);
  });
});
