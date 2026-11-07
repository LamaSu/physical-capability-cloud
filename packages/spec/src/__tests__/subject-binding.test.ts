import { describe, it, expect } from "vitest";
import {
  EVIDENCE_SUBJECT_BINDING_CONTRACT,
  verifyEvidenceSubjectBinding,
  type EvidenceSubject,
  type EvidenceSubjectBindingInput,
} from "../evidence/subject-binding.js";
import { computeLogEntryHash } from "../evidence/verifiers/log-chain.js";
import { hashBundle, hashEvent } from "../util/canonical.js";
import type { EvidenceEvent } from "../types/evidence.js";

const JOB_A = "job-subject-a";
const JOB_B = "job-subject-b";
const NODE_A = "kernel-node-a";
const NODE_B = "kernel-node-b";
const OUTPUT = "sha256:" + "5e".repeat(32);

type RawEvent = Omit<EvidenceEvent, "id" | "hash">;

async function seal(raw: RawEvent[]): Promise<EvidenceEvent[]> {
  return Promise.all(
    raw.map(async (e, i) => ({ ...e, id: `ev-${i}`, hash: await hashEvent(e) })),
  );
}

/** Events shaped like kernel-sdk's job-handler: every event names the job and
 *  the kernel (the binding is per event); execution_completed adds the output. */
async function kernelSdkShapedBundle(jobId: string, kernelId: string, outputHash = OUTPUT) {
  const source = { deviceId: kernelId, deviceType: "digital_agent" as const, kernelId };
  const events = await seal([
    {
      type: "gcode_hash_verified",
      timestamp: "2026-09-24T10:00:00.000Z",
      source,
      payload: { jobId, inputHash: "sha256:" + "11".repeat(32), kernelId },
    },
    {
      type: "execution_started",
      timestamp: "2026-09-24T10:00:00.000Z",
      source,
      payload: { jobId, kernelId, stepCount: 0 },
    },
    {
      type: "execution_completed",
      timestamp: "2026-09-24T10:00:05.000Z",
      source,
      payload: { jobId, kernelId, outputHash },
    },
  ]);
  return { events, bundleHash: await hashBundle(events) };
}

const subject = (jobId: string, kernelId: string, outputHash?: string): EvidenceSubject => ({
  jobId,
  kernelId,
  ...(outputHash !== undefined ? { outputHash } : {}),
});

describe("LO-EV-9 evidence subject binding — positive controls", () => {
  it("names its contract", () => {
    expect(EVIDENCE_SUBJECT_BINDING_CONTRACT).toBe("pcc.evidence.subject-binding.v1");
  });

  it("binds a bundle to the job and kernel its events commit", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const r = await verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_A, NODE_A) });
    expect(r.ok).toBe(true);
    // It returns the canonical snapshots of what was hashed, not the caller's objects.
    expect((r as { events: unknown[] }).events).toEqual(JSON.parse(JSON.stringify(b.events)));
    expect((r as { events: unknown[] }).events[0]).not.toBe(b.events[0]);
  });

  it("binds the output when the subject names one", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    expect(
      await verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_A, NODE_A, OUTPUT) }),
    ).toMatchObject({ ok: true });
  });

  it("does not depend on event order (hashBundle sorts the event hashes)", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const reversed = [...b.events].reverse();
    expect(
      await verifyEvidenceSubjectBinding({
        bundleHash: b.bundleHash,
        events: reversed,
        subject: subject(JOB_A, NODE_A),
      }),
    ).toMatchObject({ ok: true });
  });

  it("returns each event's id and the events' order as given: neither is committed (E11b LOW)", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const reordered = b.events.map((e, i) => ({ ...e, id: `relabelled-${i}` })).reverse();
    const r = await verifyEvidenceSubjectBinding({ bundleHash: b.bundleHash, events: reordered, subject: subject(JOB_A, NODE_A) });
    expect(r.ok).toBe(true);
    const events = (r as { events: EvidenceEvent[] }).events;
    // The same signed bundleHash verifies with other ids, in another order, and returns them as given.
    expect(events.map((e) => e.id)).toEqual(reordered.map((e) => e.id));
    expect(events.map((e) => e.hash)).toEqual(reordered.map((e) => e.hash));
    // What the bundle commits is the sorted MULTISET of event hashes: a duplicate changes it.
    expect(events.map((e) => e.hash).sort()).toEqual(b.events.map((e) => e.hash).sort());
    expect(await hashBundle([b.events[0]!, b.events[0]!])).not.toBe(await hashBundle([b.events[0]!]));
  });

  it("reads JSON-round-tripped events (the stored form) the same way", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const stored = JSON.parse(JSON.stringify(b.events)) as unknown[];
    expect(
      await verifyEvidenceSubjectBinding({
        bundleHash: b.bundleHash,
        events: stored,
        subject: subject(JOB_A, NODE_A),
      }),
    ).toMatchObject({ ok: true });
  });
});

describe("LO-EV-9 required negatives — replay across job, node and output", () => {
  it("evidence from job A cannot satisfy job B", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_B, NODE_A) })).toEqual({
      ok: false,
      reason: "job-mismatch",
      eventIndex: 0,
    });
  });

  it("evidence for node A cannot be substituted for node B", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_A, NODE_B) })).toEqual({
      ok: false,
      reason: "kernel-mismatch",
      eventIndex: 0,
    });
  });

  it("evidence for output X cannot satisfy output Y", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const other = "sha256:" + "6f".repeat(32);
    expect(
      await verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_A, NODE_A, other) }),
    ).toEqual({ ok: false, reason: "output-mismatch", eventIndex: 2 });
  });

  it("relabelling stored events from job A to job B is caught by the per-event recompute", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    // The relay rewrites the labels but cannot re-sign, so it keeps the hashes.
    const relabelled = b.events.map((e) =>
      e.payload.jobId === undefined ? e : { ...e, payload: { ...e.payload, jobId: JOB_B } },
    );
    expect(
      await verifyEvidenceSubjectBinding({
        bundleHash: b.bundleHash,
        events: relabelled,
        subject: subject(JOB_B, NODE_A),
      }),
    ).toEqual({ ok: false, reason: "event-hash-mismatch", eventIndex: 0 });
  });

  it("relabelled events that are re-hashed no longer open the signed digest", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const rehashed = await seal(
      b.events.map(({ type, timestamp, source, payload }) => ({
        type,
        timestamp,
        source,
        payload: payload.jobId === undefined ? payload : { ...payload, jobId: JOB_B },
      })),
    );
    expect(
      await verifyEvidenceSubjectBinding({
        bundleHash: b.bundleHash,
        events: rehashed,
        subject: subject(JOB_B, NODE_A),
      }),
    ).toEqual({ ok: false, reason: "bundle-hash-mismatch" });
  });

  it("dropping or adding an event breaks the digest", async () => {
    const a = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const extra = (await kernelSdkShapedBundle(JOB_A, NODE_A, "sha256:" + "77".repeat(32))).events[2]!;
    for (const events of [a.events.slice(1), [...a.events, extra]]) {
      expect(
        await verifyEvidenceSubjectBinding({
          bundleHash: a.bundleHash,
          events,
          subject: subject(JOB_A, NODE_A),
        }),
      ).toEqual({ ok: false, reason: "bundle-hash-mismatch" });
    }
  });

  it("a log-chain entryHash cannot stand in for a bundle digest", async () => {
    // The node key signs log entryHashes too, and they are tagged digests, so
    // the signature leg alone cannot tell them from bundle digests.
    const capturedAt = "2026-09-24T10:00:01.000Z";
    const entryHash = await computeLogEntryHash("print started", "octoprint", capturedAt);
    expect(
      await verifyEvidenceSubjectBinding({
        bundleHash: entryHash,
        events: [],
        subject: subject(JOB_A, NODE_A),
      }),
    ).toEqual({ ok: false, reason: "missing-events" });
    const [logEvent] = await seal([
      {
        type: "log_hash_chain_entry",
        timestamp: capturedAt,
        source: { deviceId: "octoprint", deviceType: "controller", kernelId: NODE_A },
        payload: { jobId: JOB_A, entryHash, rawContent: "print started" },
      },
    ]);
    expect(
      await verifyEvidenceSubjectBinding({
        bundleHash: entryHash,
        events: [logEvent],
        subject: subject(JOB_A, NODE_A),
      }),
    ).toEqual({ ok: false, reason: "bundle-hash-mismatch" });
  });
});

describe("LO-EV-9 fail-closed shapes", () => {
  it("rejects a bundle whose events commit no job", async () => {
    const source = { deviceId: NODE_A, deviceType: "controller" as const, kernelId: NODE_A };
    const events = await seal([
      { type: "execution_completed", timestamp: "2026-09-24T10:00:05.000Z", source, payload: { ok: true } },
    ]);
    expect(
      await verifyEvidenceSubjectBinding({
        bundleHash: await hashBundle(events),
        events,
        subject: subject(JOB_A, NODE_A),
      }),
    ).toEqual({ ok: false, reason: "job-not-committed", eventIndex: 0 });
  });

  it("rejects a bundle in which only some events name the job (the binding is per event)", async () => {
    const source = { deviceId: NODE_A, deviceType: "controller" as const, kernelId: NODE_A };
    const events = await seal([
      { type: "execution_started", timestamp: "2026-09-24T10:00:00.000Z", source, payload: { jobId: JOB_A, kernelId: NODE_A } },
      { type: "workflow_step_completed", timestamp: "2026-09-24T10:00:01.000Z", source, payload: { stepId: "s1" } },
    ]);
    expect(
      await verifyEvidenceSubjectBinding({ bundleHash: await hashBundle(events), events, subject: subject(JOB_A, NODE_A) }),
    ).toEqual({ ok: false, reason: "job-not-committed", eventIndex: 1 });
  });

  it("rejects a bundle that commits two jobs", async () => {
    const a = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const b = await kernelSdkShapedBundle(JOB_B, NODE_A);
    const events = [...a.events, b.events[1]!];
    const result = await verifyEvidenceSubjectBinding({
      bundleHash: await hashBundle(events),
      events,
      subject: subject(JOB_A, NODE_A),
    });
    expect(result).toEqual({ ok: false, reason: "job-mismatch", eventIndex: 3 });
  });

  it("does not coerce a non-string jobId", async () => {
    const source = { deviceId: NODE_A, deviceType: "controller" as const, kernelId: NODE_A };
    const events = await seal([
      { type: "execution_started", timestamp: "t", source, payload: { jobId: 42 } },
    ]);
    expect(
      await verifyEvidenceSubjectBinding({
        bundleHash: await hashBundle(events),
        events,
        subject: subject("42", NODE_A),
      }),
    ).toEqual({ ok: false, reason: "job-mismatch", eventIndex: 0 });
  });

  it("rejects an event whose source is another kernel even when its payload names none", async () => {
    const own = { deviceId: NODE_A, deviceType: "controller" as const, kernelId: NODE_A };
    const foreign = { deviceId: "probe-7", deviceType: "temperature_sensor" as const, kernelId: NODE_B };
    const events = await seal([
      { type: "execution_started", timestamp: "t", source: own, payload: { jobId: JOB_A } },
      { type: "temperature_log", timestamp: "t", source: foreign, payload: { jobId: JOB_A, celsius: 21.5 } },
    ]);
    expect(
      await verifyEvidenceSubjectBinding({
        bundleHash: await hashBundle(events),
        events,
        subject: subject(JOB_A, NODE_A),
      }),
    ).toEqual({ ok: false, reason: "kernel-mismatch", eventIndex: 1 });
  });

  it("rejects a payload.kernelId that contradicts the event source", async () => {
    const source = { deviceId: NODE_A, deviceType: "controller" as const, kernelId: NODE_A };
    const events = await seal([
      { type: "execution_started", timestamp: "t", source, payload: { jobId: JOB_A, kernelId: NODE_B } },
    ]);
    expect(
      await verifyEvidenceSubjectBinding({
        bundleHash: await hashBundle(events),
        events,
        subject: subject(JOB_A, NODE_A),
      }),
    ).toEqual({ ok: false, reason: "kernel-mismatch", eventIndex: 0 });
  });

  it("requires an output commitment when the subject names an output", async () => {
    const source = { deviceId: NODE_A, deviceType: "controller" as const, kernelId: NODE_A };
    const events = await seal([
      { type: "execution_started", timestamp: "t", source, payload: { jobId: JOB_A } },
    ]);
    expect(
      await verifyEvidenceSubjectBinding({
        bundleHash: await hashBundle(events),
        events,
        subject: subject(JOB_A, NODE_A, OUTPUT),
      }),
    ).toEqual({ ok: false, reason: "output-not-committed" });
  });

  it("rejects malformed subjects", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const bad: unknown[] = [
      null,
      {},
      { jobId: "", kernelId: NODE_A },
      { jobId: JOB_A, kernelId: "" },
      { jobId: JOB_A, kernelId: NODE_A, outputHash: "" },
      { jobId: 1, kernelId: NODE_A },
    ];
    for (const s of bad) {
      expect(
        await verifyEvidenceSubjectBinding({ ...b, subject: s as EvidenceSubject }),
        JSON.stringify(s),
      ).toEqual({ ok: false, reason: "malformed-subject" });
    }
  });

  it("rejects a non-canonical bundle digest before hashing anything", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const hex = b.bundleHash.slice("sha256:".length);
    for (const form of [`0x${hex}`, hex, b.bundleHash.toUpperCase(), `${b.bundleHash}\n`]) {
      expect(
        await verifyEvidenceSubjectBinding({ ...b, bundleHash: form, subject: subject(JOB_A, NODE_A) }),
        form,
      ).toEqual({ ok: false, reason: "malformed-bundle-hash" });
    }
  });

  it("rejects missing or non-array events", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    for (const events of [[], undefined, null, "events", { 0: b.events[0] }]) {
      expect(
        await verifyEvidenceSubjectBinding({
          bundleHash: b.bundleHash,
          events: events as unknown as unknown[],
          subject: subject(JOB_A, NODE_A),
        }),
      ).toEqual({ ok: false, reason: "missing-events" });
    }
  });

  it("rejects malformed events with the index of the first bad one", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const good = b.events[0]!;
    const mutations: Array<(e: EvidenceEvent) => unknown> = [
      () => null,
      (e) => ({ ...e, type: "" }),
      (e) => ({ ...e, timestamp: 1_700_000_000 }),
      (e) => {
        const { source: _dropped, ...rest } = e;
        return rest;
      },
      (e) => ({ ...e, source: null }),
      (e) => ({ ...e, payload: [] }),
      (e) => ({ ...e, hash: e.hash.slice("sha256:".length) }),
    ];
    for (const mutate of mutations) {
      expect(
        await verifyEvidenceSubjectBinding({
          bundleHash: b.bundleHash,
          events: [good, mutate(b.events[1]!)],
          subject: subject(JOB_A, NODE_A),
        }),
      ).toEqual({ ok: false, reason: "malformed-event", eventIndex: 1 });
    }
  });
});

describe("LO-EV-9 evaluates only what it hashed (coord-watch cross-cutting rule)", () => {
  /** A genuine bundle whose events commit the kernel but no job: it must never bind a job. */
  async function uncommittedBundle() {
    const source = { deviceId: NODE_A, deviceType: "digital_agent" as const, kernelId: NODE_A };
    const events = await seal([
      { type: "gcode_hash_verified", timestamp: "2026-09-24T10:00:00.000Z", source, payload: { kernelId: NODE_A } },
    ]);
    return { events, bundleHash: await hashBundle(events) };
  }

  it("baseline: a bundle that commits no job does not bind", async () => {
    const b = await uncommittedBundle();
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_B, NODE_A) })).toMatchObject({
      ok: false,
      reason: "job-not-committed",
    });
  });

  it("a non-enumerable jobId the hash never covered cannot bind a job", async () => {
    const b = await uncommittedBundle();
    Object.defineProperty(b.events[0]!.payload, "jobId", { value: JOB_B, enumerable: false });
    const r = await verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_B, NODE_A) });
    expect(r.ok).toBe(false);
  });

  it("a jobId inherited from the payload's prototype cannot bind a job", async () => {
    const b = await uncommittedBundle();
    const e = b.events[0]!;
    (e as { payload: unknown }).payload = Object.assign(Object.create({ jobId: JOB_B }), e.payload);
    const r = await verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_B, NODE_A) });
    expect(r.ok).toBe(false);
  });

  it("a jobId on a polluted Object.prototype cannot bind a job", async () => {
    const b = await uncommittedBundle();
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.jobId = JOB_B;
    try {
      expect(await verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_B, NODE_A) })).toMatchObject({
        ok: false,
        reason: "job-not-committed",
      });
    } finally {
      delete proto.jobId;
    }
  });

  it("never throws: an event canonicalize cannot hash (a cycle) is malformed-event", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const payload = b.events[1]!.payload as Record<string, unknown>;
    payload.self = payload;
    await expect(verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_A, NODE_A) })).resolves.toEqual({
      ok: false,
      reason: "malformed-event",
      eventIndex: 1,
    });
  });

  it("a getter that answers the hash with job A and the evaluator with job B cannot replay A as B", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    for (const e of b.events) {
      const payload = e.payload as Record<string, unknown>;
      if (payload.jobId === undefined) continue;
      let reads = 0;
      const rest = { ...payload };
      delete rest.jobId;
      (e as { payload: unknown }).payload = Object.defineProperty(rest, "jobId", {
        get: () => (reads++ === 0 ? JOB_A : JOB_B),
        enumerable: true,
      });
    }
    const r = await verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_B, NODE_A) });
    expect(r.ok).toBe(false);
  });
});

describe("LO-EV-9 settlement-unit and challenge binding (oracle's milestone replay)", () => {
  const U3 = "0x" + "03".repeat(32);
  const U4 = "0x" + "04".repeat(32);
  const NONCE_3 = "0x" + "a3".repeat(32);
  const NONCE_4 = "0x" + "a4".repeat(32);

  /** kernel-sdk-shaped events for one milestone: started and completed commit the unit and nonce. */
  async function milestoneBundle(unit: string | undefined, nonce: string | undefined) {
    const source = { deviceId: NODE_A, deviceType: "digital_agent" as const, kernelId: NODE_A };
    const unitFields = { ...(unit ? { settlementUnitId: unit } : {}), ...(nonce ? { challengeNonce: nonce } : {}) };
    const events = await seal([
      { type: "execution_started", timestamp: "2026-09-24T10:00:00.000Z", source, payload: { jobId: JOB_A, kernelId: NODE_A, ...unitFields } },
      { type: "execution_completed", timestamp: "2026-09-24T10:00:05.000Z", source, payload: { jobId: JOB_A, kernelId: NODE_A, outputHash: OUTPUT, ...unitFields } },
    ]);
    return { events, bundleHash: await hashBundle(events) };
  }
  const unitSubject = (settlementUnitId?: string, challengeNonce?: string): EvidenceSubject => ({
    jobId: JOB_A,
    kernelId: NODE_A,
    ...(settlementUnitId ? { settlementUnitId } : {}),
    ...(challengeNonce ? { challengeNonce } : {}),
  });

  it("evidence for milestone 3 binds milestone 3", async () => {
    const b = await milestoneBundle(U3, NONCE_3);
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: unitSubject(U3, NONCE_3) })).toMatchObject({ ok: true });
  });

  it("evidence signed for milestone 3 cannot settle milestone 4 of the same job", async () => {
    const b = await milestoneBundle(U3, NONCE_3);
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: unitSubject(U4) })).toEqual({
      ok: false,
      reason: "unit-mismatch",
      eventIndex: 0,
    });
  });

  it("the unit's challenge must match too: a nonce from another unit is refused", async () => {
    const b = await milestoneBundle(U4, NONCE_3);
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: unitSubject(U4, NONCE_4) })).toEqual({
      ok: false,
      reason: "challenge-mismatch",
      eventIndex: 0,
    });
  });

  it("a unit-bound subject refuses evidence that commits no unit or no nonce (fails closed for old producers)", async () => {
    const none = await milestoneBundle(undefined, undefined);
    expect(await verifyEvidenceSubjectBinding({ ...none, subject: unitSubject(U3) })).toEqual({
      ok: false,
      reason: "unit-not-committed",
      eventIndex: 0,
    });
    const unitOnly = await milestoneBundle(U3, undefined);
    expect(await verifyEvidenceSubjectBinding({ ...unitOnly, subject: unitSubject(U3, NONCE_3) })).toEqual({
      ok: false,
      reason: "challenge-not-committed",
      eventIndex: 0,
    });
  });

  it("a unit carried by only some events is refused: the unit scopes every event", async () => {
    const source = { deviceId: NODE_A, deviceType: "digital_agent" as const, kernelId: NODE_A };
    const events = await seal([
      { type: "execution_started", timestamp: "2026-09-24T10:00:00.000Z", source, payload: { jobId: JOB_A, kernelId: NODE_A, settlementUnitId: U3 } },
      { type: "execution_completed", timestamp: "2026-09-24T10:00:05.000Z", source, payload: { jobId: JOB_A, kernelId: NODE_A } },
    ]);
    expect(
      await verifyEvidenceSubjectBinding({ bundleHash: await hashBundle(events), events, subject: unitSubject(U3) }),
    ).toEqual({ ok: false, reason: "unit-not-committed", eventIndex: 1 });
  });

  it("E11 F1: a subject that names no unit refuses evidence scoped to one (the subject /complete and /resume-settlement build)", async () => {
    // Before E11 this returned ok: evidence signed for U3/N3 could anchor whatever
    // milestone a unit-less consumer settles (the legacy routes drive milestone 0).
    const b = await milestoneBundle(U3, NONCE_3);
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: unitSubject() })).toEqual({
      ok: false,
      reason: "unit-not-in-subject",
      eventIndex: 0,
    });
  });

  it("E11 F1: a subject that names the unit but no challenge refuses evidence that carries a challenge", async () => {
    const b = await milestoneBundle(U3, NONCE_3);
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: unitSubject(U3) })).toEqual({
      ok: false,
      reason: "challenge-not-in-subject",
      eventIndex: 0,
    });
  });

  it("E11 F1: a challenge with no unit is refused by a subject that names neither", async () => {
    const b = await milestoneBundle(undefined, NONCE_3);
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: unitSubject() })).toEqual({
      ok: false,
      reason: "challenge-not-in-subject",
      eventIndex: 0,
    });
  });

  it("E11 F1: one unit-scoped event is enough to refuse a unit-less subject", async () => {
    const source = { deviceId: NODE_A, deviceType: "digital_agent" as const, kernelId: NODE_A };
    const events = await seal([
      { type: "execution_started", timestamp: "2026-09-24T10:00:00.000Z", source, payload: { jobId: JOB_A, kernelId: NODE_A } },
      { type: "execution_completed", timestamp: "2026-09-24T10:00:05.000Z", source, payload: { jobId: JOB_A, kernelId: NODE_A, settlementUnitId: U3 } },
    ]);
    expect(
      await verifyEvidenceSubjectBinding({ bundleHash: await hashBundle(events), events, subject: unitSubject() }),
    ).toEqual({ ok: false, reason: "unit-not-in-subject", eventIndex: 1 });
  });

  it("E11 F1: unit-less evidence still binds a unit-less subject (the legacy routes keep settling it)", async () => {
    const b = await milestoneBundle(undefined, undefined);
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: unitSubject() })).toMatchObject({ ok: true });
  });

  it("the subject's unit fields must be 0x + 64 lowercase hex", async () => {
    const b = await milestoneBundle(U3, NONCE_3);
    for (const bad of ["0x" + "AB".repeat(32), U3.slice(2), U3 + "00", ""]) {
      expect(await verifyEvidenceSubjectBinding({ ...b, subject: { ...unitSubject(), settlementUnitId: bad } })).toEqual({
        ok: false,
        reason: "malformed-subject",
      });
    }
    expect(
      await verifyEvidenceSubjectBinding({ ...b, subject: { ...unitSubject(U3), challengeNonce: "nonce-3" } }),
    ).toEqual({ ok: false, reason: "malformed-subject" });
  });
});

describe("E11 F2/F3: one read of every input, no caller code, never throws", () => {
  it("F2: an event.hash getter cannot answer the checks with job B's hashes and the bundle with job A's", async () => {
    // astra's reproduction: genuine A and B bundles of equal length; every B event's
    // hash becomes a getter answering B, B, then A's. Before E11 this returned ok.
    const A = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const B = await kernelSdkShapedBundle(JOB_B, NODE_A);
    let reads = 0;
    const forged = B.events.map((e, i) => {
      let n = 0;
      const { hash: _hash, ...rest } = e;
      return Object.defineProperty({ ...rest }, "hash", {
        enumerable: true,
        get: () => {
          reads++;
          return ++n <= 2 ? e.hash : A.events[i]!.hash;
        },
      });
    });
    expect(
      await verifyEvidenceSubjectBinding({ bundleHash: A.bundleHash, events: forged, subject: subject(JOB_B, NODE_A) }),
    ).toEqual({ ok: false, reason: "malformed-event", eventIndex: 0 });
    expect(reads).toBe(0);
  });

  it("F2: the equivalent Proxy is refused before any of its traps runs", async () => {
    const A = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const B = await kernelSdkShapedBundle(JOB_B, NODE_A);
    let traps = 0;
    const forged = B.events.map((e, i) => {
      let n = 0;
      return new Proxy(e, {
        get(target, key, receiver) {
          traps++;
          if (key === "hash") return ++n <= 2 ? e.hash : A.events[i]!.hash;
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor(target, key) {
          traps++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        ownKeys(target) {
          traps++;
          return Reflect.ownKeys(target);
        },
        getPrototypeOf(target) {
          traps++;
          return Reflect.getPrototypeOf(target);
        },
      });
    });
    expect(
      await verifyEvidenceSubjectBinding({ bundleHash: A.bundleHash, events: forged, subject: subject(JOB_B, NODE_A) }),
    ).toEqual({ ok: false, reason: "malformed-event", eventIndex: 0 });
    expect(traps).toBe(0);
  });

  it("F2: a Proxy or accessor anywhere inside source or payload is refused without running", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    let ran = 0;
    const counting = <T extends object>(o: T): T =>
      new Proxy(o, {
        get(target, key, receiver) {
          ran++;
          return Reflect.get(target, key, receiver);
        },
      });
    const e1 = b.events[1]!;
    const variants: unknown[] = [
      { ...e1, payload: counting(e1.payload) },
      { ...e1, source: counting(e1.source) },
      { ...e1, payload: { ...e1.payload, nested: counting({ x: 1 }) } },
      {
        ...e1,
        payload: Object.defineProperty({ ...e1.payload }, "jobId", {
          enumerable: true,
          get: () => {
            ran++;
            return JOB_A;
          },
        }),
      },
    ];
    for (const variant of variants) {
      expect(
        await verifyEvidenceSubjectBinding({
          bundleHash: b.bundleHash,
          events: [b.events[0], variant, b.events[2]],
          subject: subject(JOB_A, NODE_A),
        }),
      ).toEqual({ ok: false, reason: "malformed-event", eventIndex: 1 });
    }
    expect(ran).toBe(0);
  });

  it("F3: a Proxy whose get('type') throws resolves to malformed-event (astra's reproduction)", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const hostile = new Proxy({}, {
      get(_target, key) {
        if (key === "type") throw new Error("boom");
        return undefined;
      },
    });
    await expect(
      verifyEvidenceSubjectBinding({
        bundleHash: b.bundleHash,
        events: [hostile, ...b.events.slice(1)],
        subject: subject(JOB_A, NODE_A),
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed-event", eventIndex: 0 });
  });

  it("F3: a throwing getter wherever a field is read resolves to the refusal for that part, and never runs", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    let ran = 0;
    const thrower = () => {
      ran++;
      throw new Error("boom");
    };
    const withGetter = <T extends object>(o: T, key: PropertyKey): T =>
      Object.defineProperty({ ...o }, key, { enumerable: true, configurable: true, get: thrower });
    const base = { ...b, subject: subject(JOB_A, NODE_A) };
    const indexedAccessor = Object.defineProperty([...b.events], 1, { enumerable: true, configurable: true, get: thrower });
    const cases: Array<[unknown, Record<string, unknown>]> = [
      [withGetter(base, "subject"), { ok: false, reason: "malformed-subject" }],
      [{ ...base, subject: withGetter(subject(JOB_A, NODE_A), "jobId") }, { ok: false, reason: "malformed-subject" }],
      [{ ...base, subject: withGetter(subject(JOB_A, NODE_A), "settlementUnitId") }, { ok: false, reason: "malformed-subject" }],
      [withGetter(base, "bundleHash"), { ok: false, reason: "malformed-bundle-hash" }],
      [withGetter(base, "events"), { ok: false, reason: "malformed-event" }],
      [{ ...base, events: indexedAccessor }, { ok: false, reason: "malformed-event", eventIndex: 1 }],
      [{ ...base, events: [b.events[0], withGetter(b.events[1]!, "type"), b.events[2]] }, { ok: false, reason: "malformed-event", eventIndex: 1 }],
      [{ ...base, events: [b.events[0], withGetter(b.events[1]!, "hash"), b.events[2]] }, { ok: false, reason: "malformed-event", eventIndex: 1 }],
      [{ ...base, events: [b.events[0], withGetter(b.events[1]!, "id"), b.events[2]] }, { ok: false, reason: "malformed-event", eventIndex: 1 }],
      [
        { ...base, events: [b.events[0], { ...b.events[1]!, payload: withGetter(b.events[1]!.payload, "outputHash") }, b.events[2]] },
        { ok: false, reason: "malformed-event", eventIndex: 1 },
      ],
    ];
    for (const [input, expected] of cases) {
      await expect(verifyEvidenceSubjectBinding(input as EvidenceSubjectBindingInput)).resolves.toEqual(expected);
    }
    expect(ran).toBe(0);
  });

  it("F3: never throws, whatever the input", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const good = subject(JOB_A, NODE_A);
    const holed = [...b.events];
    delete holed[1];
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 200_000; i++) deep = { d: deep };
    const cases: Array<[unknown, Record<string, unknown>]> = [
      [null, { ok: false, reason: "malformed-subject" }],
      [42, { ok: false, reason: "malformed-subject" }],
      [revoked, { ok: false, reason: "malformed-subject" }],
      [new Proxy({ ...b, subject: good }, {}), { ok: false, reason: "malformed-subject" }],
      [{ ...b, subject: new Proxy(good, {}) }, { ok: false, reason: "malformed-subject" }],
      [{ ...b, subject: revoked }, { ok: false, reason: "malformed-subject" }],
      [{ ...b, subject: good, events: new Proxy([...b.events], {}) }, { ok: false, reason: "malformed-event" }],
      [{ ...b, subject: good, events: revoked }, { ok: false, reason: "malformed-event" }],
      [{ ...b, subject: good, events: [revoked] }, { ok: false, reason: "malformed-event", eventIndex: 0 }],
      [{ ...b, subject: good, events: holed }, { ok: false, reason: "malformed-event", eventIndex: 1 }],
      [
        { ...b, subject: good, events: [b.events[0], { ...b.events[1]!, payload: { ...b.events[1]!.payload, deep } }, b.events[2]] },
        { ok: false, reason: "malformed-event", eventIndex: 1 },
      ],
    ];
    for (const [input, expected] of cases) {
      await expect(verifyEvidenceSubjectBinding(input as EvidenceSubjectBindingInput)).resolves.toEqual(expected);
    }
  });

  it("the verified events are frozen copies, and the result is a null-prototype object", async () => {
    const b = await kernelSdkShapedBundle(JOB_A, NODE_A);
    const r = await verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_A, NODE_A) });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(Object.getPrototypeOf(r)).toBeNull();
    expect(Object.isFrozen(r.events)).toBe(true);
    for (let i = 0; i < r.events.length; i++) {
      const e = r.events[i]! as unknown as Record<string, unknown>;
      expect(e).not.toBe(b.events[i]);
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.payload)).toBe(true);
      expect(Object.getPrototypeOf(e.payload)).toBeNull();
    }
    expect(JSON.parse(JSON.stringify(r.events))).toEqual(JSON.parse(JSON.stringify(b.events)));
    const refused = await verifyEvidenceSubjectBinding({ ...b, subject: subject(JOB_B, NODE_A) });
    expect(Object.getPrototypeOf(refused)).toBeNull();
    expect(Object.isFrozen(refused)).toBe(true);
  });
});
