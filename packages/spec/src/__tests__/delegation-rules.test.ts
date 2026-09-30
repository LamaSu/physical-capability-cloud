/**
 * Delegation-scope and event-time rules (pcc.evidence.delegation-time-rules.v1).
 * The vectors in evidence/delegation-rules.vectors.json were computed
 * independently (Python datetime), and are what the oracle mirrors.
 */
import { describe, it, expect } from "vitest";
import {
  EVIDENCE_CLOCK_SKEW_SECONDS,
  checkDelegationScope,
  checkEventTimes,
  parseEvidenceTimeBound,
  parseEvidenceTimestamp,
  type DelegationScopeExpectation,
  type EventTimeWindow,
  type EvidenceTimeBounds,
} from "../evidence/delegation-rules.js";
import { verifyEvidenceSubjectBinding } from "../evidence/subject-binding.js";
import { hashBundle, hashEvent } from "../util/canonical.js";
import type { EvidenceEvent } from "../types/evidence.js";
import vectors from "../evidence/delegation-rules.vectors.json" with { type: "json" };

describe("parseEvidenceTimestamp", () => {
  it("reproduces every timestamp vector", () => {
    expect(vectors.skewSeconds).toBe(EVIDENCE_CLOCK_SKEW_SECONDS);
    for (const v of vectors.timestamps) expect(parseEvidenceTimestamp(v.input), v.input).toBe(v.seconds);
  });

  it("refuses non-strings", () => {
    for (const bad of [undefined, null, 1790251200, new Date(0)]) expect(parseEvidenceTimestamp(bad)).toBeNull();
  });
});

describe("parseEvidenceTimeBound (a package's evidenceTimeBounds: decimal Unix seconds)", () => {
  it("reads the canonical golden's form and refuses every other", () => {
    expect(parseEvidenceTimeBound("1699999500")).toBe(1699999500);
    expect(parseEvidenceTimeBound("0")).toBe(0);
    for (const bad of ["", "01", "-1", "1.5", "1e9", " 1", "2026-08-20T00:00:00Z", "9007199254740992", 1699999500, null]) {
      expect(parseEvidenceTimeBound(bad), String(bad)).toBeNull();
    }
  });
});

describe("checkDelegationScope", () => {
  it("reproduces every scope vector", () => {
    for (const v of vectors.scope) {
      const r = checkDelegationScope(v.delegation, v.expected as DelegationScopeExpectation);
      expect(r.ok ? "ok" : r.reason, v.name).toBe(v.result);
    }
  });

  it("refuses a non-object delegation and never throws", () => {
    for (const bad of [null, undefined, "x", 7]) {
      expect(checkDelegationScope(bad, { settlingJobId: "job-1" })).toEqual({ ok: false, reason: "malformed-delegation" });
    }
  });
});

describe("checkEventTimes", () => {
  it("reproduces every time vector", () => {
    for (const v of vectors.times) {
      const events = v.events.map((timestamp) => ({ timestamp }));
      const r = checkEventTimes(events, v.window as EventTimeWindow, (v as { bounds?: EvidenceTimeBounds }).bounds);
      expect(r.ok ? "ok" : r.reason, v.name).toBe(v.result);
      if (!r.ok && "eventIndex" in v) expect(r.eventIndex, v.name).toBe(v.eventIndex);
    }
  });

  it("reads only an own timestamp property", () => {
    const inherited = Object.create({ timestamp: "2026-09-24T11:59:00Z" }) as object;
    const r = checkEventTimes([inherited], { notBefore: 1790247600, notAfter: 1790251200 });
    expect(r).toEqual({ ok: false, reason: "event-time-malformed", eventIndex: 0 });
  });
});

describe("LO-EV-9 carries the time window (step 10)", () => {
  const JOB = "job-1";
  const KERNEL = "kernel-a";
  const source = { deviceId: "dev-1", deviceType: "machine", kernelId: KERNEL } as EvidenceEvent["source"];
  async function bundleOf(timestamps: string[]) {
    const events: EvidenceEvent[] = [];
    for (const [i, timestamp] of timestamps.entries()) {
      const raw = { type: i === 0 ? "execution_started" : "execution_completed", timestamp, source, payload: { jobId: JOB } } as Omit<EvidenceEvent, "id" | "hash">;
      events.push({ ...raw, id: `e${i}`, hash: await hashEvent(raw) } as EvidenceEvent);
    }
    return { bundleHash: await hashBundle(events), events };
  }
  const window = { notBefore: 1790247600, notAfter: 1790251200 }; // 11:00Z .. 12:00Z on 2026-09-24

  it("binds when every event is inside the window, and ignores time when no window is named", async () => {
    const b = await bundleOf(["2026-09-24T11:10:00Z", "2026-09-24T11:50:00Z"]);
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: { jobId: JOB, kernelId: KERNEL, eventTimeWindow: window } })).toMatchObject({ ok: true });
    const late = await bundleOf(["2026-09-24T11:10:00Z", "2026-09-24T13:00:00Z"]);
    expect(await verifyEvidenceSubjectBinding({ ...late, subject: { jobId: JOB, kernelId: KERNEL } })).toMatchObject({ ok: true });
  });

  it("refuses an event outside the window, and a timestamp that is not RFC 3339", async () => {
    const late = await bundleOf(["2026-09-24T11:10:00Z", "2026-09-24T13:00:00Z"]);
    expect(await verifyEvidenceSubjectBinding({ ...late, subject: { jobId: JOB, kernelId: KERNEL, eventTimeWindow: window } })).toEqual({
      ok: false,
      reason: "event-time-outside-window",
      eventIndex: 1,
    });
    const unix = await bundleOf(["1790248000", "2026-09-24T11:50:00Z"]);
    expect(await verifyEvidenceSubjectBinding({ ...unix, subject: { jobId: JOB, kernelId: KERNEL, eventTimeWindow: window } })).toEqual({
      ok: false,
      reason: "event-time-malformed",
      eventIndex: 0,
    });
  });

  it("a malformed window is a malformed subject", async () => {
    const b = await bundleOf(["2026-09-24T11:10:00Z"]);
    for (const bad of [{ notBefore: 2, notAfter: 1 }, { notBefore: 1.5, notAfter: 2 }, { notBefore: "0", notAfter: 2 }]) {
      expect(
        await verifyEvidenceSubjectBinding({ ...b, subject: { jobId: JOB, kernelId: KERNEL, eventTimeWindow: bad as never } }),
      ).toEqual({ ok: false, reason: "malformed-subject" });
    }
  });
});

describe("the rules read only own data, as they promise (cross-family review E3, finding 2)", () => {
  it("NEGATIVE: a sparse contractIds list is malformed, even when the job sits at a filled index", () => {
    const ids = new Array(2);
    ids[1] = "job-1";
    expect(checkDelegationScope({ scope: { contractIds: ids, maxSignatures: 1 } }, { settlingJobId: "job-1" })).toEqual({
      ok: false,
      reason: "malformed-delegation",
    });
  });

  it("NEGATIVE: a job reachable only through an inherited index is malformed", () => {
    const proto = Object.create(Array.prototype) as Record<number, string>;
    proto[0] = "job-1";
    const ids = Object.setPrototypeOf(new Array(1), proto) as string[];
    expect(Array.isArray(ids)).toBe(true);
    expect(checkDelegationScope({ scope: { contractIds: ids, maxSignatures: 1 } }, { settlingJobId: "job-1" })).toEqual({
      ok: false,
      reason: "malformed-delegation",
    });
  });

  it("NEGATIVE: a negative session-signed event count is refused", () => {
    expect(
      checkDelegationScope({ scope: { contractIds: ["job-1"], maxSignatures: 1 } }, { settlingJobId: "job-1", sessionSignedEventCount: -1 }),
    ).toEqual({ ok: false, reason: "scope-signatures-exhausted" });
  });

  it("NEGATIVE: evidenceTimeBounds inherited from a prototype are malformed", () => {
    const bounds = Object.create({ start: "1700000000", end: "1700000100" }) as EvidenceTimeBounds;
    expect(checkEventTimes([{ timestamp: "2023-11-14T22:13:20Z" }], { notBefore: 1699999000, notAfter: 1700001000 }, bounds)).toEqual({
      ok: false,
      reason: "malformed-time-bounds",
    });
  });
});
