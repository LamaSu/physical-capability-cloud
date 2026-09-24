import { describe, it, expect } from "vitest";
import {
  EVIDENCE_SUBJECT_BINDING_CONTRACT,
  verifyEvidenceSubjectBinding,
  type EvidenceSubject,
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

/** Events shaped like kernel-sdk's job-handler: an input commitment that names
 *  only the kernel, execution_started (job + kernel) and execution_completed
 *  (job + kernel + output). */
async function kernelSdkShapedBundle(jobId: string, kernelId: string, outputHash = OUTPUT) {
  const source = { deviceId: kernelId, deviceType: "digital_agent" as const, kernelId };
  const events = await seal([
    {
      type: "gcode_hash_verified",
      timestamp: "2026-09-24T10:00:00.000Z",
      source,
      payload: { inputHash: "sha256:" + "11".repeat(32), kernelId },
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
      eventIndex: 1,
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
    ).toEqual({ ok: false, reason: "event-hash-mismatch", eventIndex: 1 });
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
    ).toEqual({ ok: false, reason: "job-not-committed" });
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
      { type: "temperature_log", timestamp: "t", source: foreign, payload: { celsius: 21.5 } },
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
