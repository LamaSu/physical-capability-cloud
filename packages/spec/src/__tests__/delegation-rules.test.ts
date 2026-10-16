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

describe("checkDelegationScope reads own data only, and never throws (cross-family review E3b, finding M1)", () => {
  const JOB = "job-1";
  const OPERATOR = "eip155:8453:0xabababababababababababababababababababab";
  const expected: DelegationScopeExpectation = { settlingJobId: JOB, operatorPrincipalId: OPERATOR, sessionSignedEventCount: 1 };
  const validScope = () => ({ contractIds: [JOB], maxSignatures: 1 });
  const valid = () => ({ parentAgentId: OPERATOR, scope: validScope() });
  /** An own accessor: reading it throws, and a getter that was called would show in `calls`. */
  const throwing = (calls: { n: number }) => ({
    enumerable: true,
    configurable: true,
    get(): never {
      calls.n += 1;
      throw new Error("boom: a getter ran");
    },
  });

  it("the well-formed delegation is accepted (positive control)", () => {
    expect(checkDelegationScope(valid(), expected)).toEqual({ ok: true });
  });

  it("NEGATIVE: scope and parentAgentId that a prototype supplies are not the delegation's (the review's example)", () => {
    const scope = Object.create({ contractIds: [JOB], maxSignatures: 1 }) as object;
    const delegation = Object.create({ parentAgentId: OPERATOR, scope }) as object;
    expect(checkDelegationScope(delegation, expected)).toEqual({ ok: false, reason: "malformed-delegation" });
  });

  it("NEGATIVE: each of scope, contractIds, maxSignatures and parentAgentId is refused when only inherited", () => {
    // scope inherited, the rest own
    expect(checkDelegationScope(Object.create({ scope: validScope() }, { parentAgentId: { value: OPERATOR, enumerable: true } }), expected)).toEqual({
      ok: false,
      reason: "malformed-delegation",
    });
    // contractIds inherited
    expect(
      checkDelegationScope({ parentAgentId: OPERATOR, scope: Object.create({ contractIds: [JOB] }, { maxSignatures: { value: 1, enumerable: true } }) }, expected),
    ).toEqual({ ok: false, reason: "malformed-delegation" });
    // maxSignatures inherited
    expect(
      checkDelegationScope({ parentAgentId: OPERATOR, scope: Object.create({ maxSignatures: 1 }, { contractIds: { value: [JOB], enumerable: true } }) }, expected),
    ).toEqual({ ok: false, reason: "max-signatures-invalid" });
    // parentAgentId inherited
    expect(checkDelegationScope(Object.create({ parentAgentId: OPERATOR }, { scope: { value: validScope(), enumerable: true } }), expected)).toEqual({
      ok: false,
      reason: "parent-not-operator",
    });
  });

  it("NEGATIVE: a getter on any of the four fields is a refusal, not a throw, and no getter runs", () => {
    const cases: Array<[string, (calls: { n: number }) => unknown, string]> = [
      ["scope", (c) => Object.defineProperty({ parentAgentId: OPERATOR }, "scope", throwing(c)), "malformed-delegation"],
      ["contractIds", (c) => ({ parentAgentId: OPERATOR, scope: Object.defineProperty({ maxSignatures: 1 }, "contractIds", throwing(c)) }), "malformed-delegation"],
      ["maxSignatures", (c) => ({ parentAgentId: OPERATOR, scope: Object.defineProperty({ contractIds: [JOB] }, "maxSignatures", throwing(c)) }), "max-signatures-invalid"],
      ["parentAgentId", (c) => Object.defineProperty({ scope: validScope() }, "parentAgentId", throwing(c)), "parent-not-operator"],
    ];
    for (const [field, build, reason] of cases) {
      const calls = { n: 0 };
      let result: unknown;
      expect(() => (result = checkDelegationScope(build(calls), expected)), field).not.toThrow();
      expect(result, field).toEqual({ ok: false, reason });
      expect(calls.n, `${field}: the getter must not run`).toBe(0);
    }
  });

  it("NEGATIVE: an accessor as a contractIds element, or a trap that throws, is a refusal, not a throw", () => {
    const calls = { n: 0 };
    const ids = [JOB, "job-2"];
    Object.defineProperty(ids, 1, throwing(calls));
    expect(() => checkDelegationScope({ parentAgentId: OPERATOR, scope: { contractIds: ids, maxSignatures: 1 } }, expected)).not.toThrow();
    expect(checkDelegationScope({ parentAgentId: OPERATOR, scope: { contractIds: ids, maxSignatures: 1 } }, expected)).toEqual({
      ok: false,
      reason: "malformed-delegation",
    });
    expect(calls.n).toBe(0);

    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("boom: a trap ran");
        },
        get() {
          throw new Error("boom: a trap ran");
        },
      },
    );
    expect(() => checkDelegationScope(hostile, expected)).not.toThrow();
    expect(checkDelegationScope(hostile, expected)).toEqual({ ok: false, reason: "malformed-delegation" });
  });

  it("reads each field of the delegation exactly once, as stored data: a proxy's [[Get]] is never consulted", () => {
    const log: string[] = [];
    const watch = <T extends object>(label: string, target: T): T =>
      new Proxy(target, {
        get(t, k, r) {
          log.push(`get ${label}.${String(k)}`);
          return Reflect.get(t, k, r);
        },
        getOwnPropertyDescriptor(t, k) {
          log.push(`descriptor ${label}.${String(k)}`);
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
        has(t, k) {
          log.push(`has ${label}.${String(k)}`);
          return Reflect.has(t, k);
        },
      });
    const delegation = watch("delegation", {
      parentAgentId: OPERATOR,
      scope: watch("scope", { contractIds: watch("ids", [JOB, "job-2"]), maxSignatures: 1 }),
    });
    expect(checkDelegationScope(delegation, expected)).toEqual({ ok: true });
    expect([...log].sort()).toEqual([
      "descriptor delegation.parentAgentId",
      "descriptor delegation.scope",
      "descriptor ids.0",
      "descriptor ids.1",
      "descriptor ids.length",
      "descriptor scope.contractIds",
      "descriptor scope.maxSignatures",
    ]);
  });

  it("a value that a proxy answers differently on each read is judged on the one answer it gave", () => {
    // The first descriptor read of maxSignatures says 1 (enough), every later one 0: read once, it is 1.
    let reads = 0;
    const scope = new Proxy(
      { contractIds: [JOB], maxSignatures: 1 },
      {
        getOwnPropertyDescriptor(t, k) {
          const d = Reflect.getOwnPropertyDescriptor(t, k)!;
          return k === "maxSignatures" ? { ...d, value: ++reads === 1 ? 1 : 0 } : d;
        },
      },
    );
    expect(checkDelegationScope({ parentAgentId: OPERATOR, scope }, expected)).toEqual({ ok: true });
    expect(reads).toBe(1);
  });
});

describe("the lockstep vectors pin the count boundary (cross-family review E3b, finding M2)", () => {
  it("with maxSignatures 10: a count of 0 and of 10 are accepted, 11 and -1 are refused", () => {
    const byCount: Record<string, string> = {};
    for (const v of vectors.scope) {
      const count = (v.expected as DelegationScopeExpectation).sessionSignedEventCount;
      const max = (v.delegation as { scope?: { maxSignatures?: unknown } }).scope?.maxSignatures;
      if (count !== undefined && max === 10) byCount[String(count)] = v.result;
    }
    expect(byCount).toEqual({ "0": "ok", "10": "ok", "11": "scope-signatures-exhausted", "-1": "scope-signatures-exhausted" });
  });
});
