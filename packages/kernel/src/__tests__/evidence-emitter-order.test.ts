/**
 * EvidenceEmitter stores a step's events in the order addEvent is called, whatever order their
 * hashes finish in (N123). addEvent hashes each event (hashEvent: an async SHA-256 digest) before
 * it stores it, so overlapping calls on one step used to store in digest-finish order: a slow
 * digest put an event after later ones (refvertical #6343; the IPP binding flakes of #474, #456
 * and #6307). The digests still run concurrently; only the storing waits for the step's earlier
 * events.
 *
 * hashEvent calls crypto.subtle.digest once per event (sha256 in @pcc/spec), so these tests hold
 * back or fail chosen events' digests through a spy on it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyEventHash, type EvidenceEvent, type EvidenceSource } from "@pcc/spec";
import { EvidenceEmitter } from "../evidence-emitter.js";

afterEach(() => vi.restoreAllMocks());

const KERNEL = "kernel-order";
const JOB = "pcc-job-order";
const source: EvidenceSource = { deviceId: "dev-1", deviceType: "machine", kernelId: KERNEL } as EvidenceSource;
const raw = (type: string, second: number, payload: Record<string, unknown> = {}) => ({
  type,
  timestamp: `2026-10-03T12:00:0${second}.000Z`,
  source,
  payload,
}) as never;

/**
 * Holds back the digest of every event whose payload has mark "held" until release(), and fails
 * the digest of every event marked "fails". The other digests run as usual: done() resolves once
 * they have finished and every continuation waiting on them has run. `requested` lists the event
 * types whose digests were asked for, in order.
 */
function controlDigests(): { release: () => void; done: () => Promise<void>; requested: string[] } {
  const subtle = globalThis.crypto.subtle;
  const real = subtle.digest.bind(subtle);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const others: Array<Promise<unknown>> = [];
  const requested: string[] = [];
  vi.spyOn(subtle, "digest").mockImplementation(((algorithm: Parameters<typeof real>[0], data: Parameters<typeof real>[1]) => {
    const text = new TextDecoder().decode(data as Uint8Array);
    requested.push(/"type":"([a-z_]+)"/.exec(text)?.[1] ?? "?");
    if (text.includes('"mark":"fails"')) return Promise.reject(new Error("digest failed"));
    if (text.includes('"mark":"held"')) return gate.then(() => real(algorithm, data));
    const digest = real(algorithm, data);
    others.push(digest);
    return digest;
  }) as typeof subtle.digest);
  return {
    release,
    requested,
    done: async () => {
      await Promise.allSettled(others);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** An addEvent call settled into a value at once, so a rejection is reported here, never as unhandled. */
function settled(call: Promise<EvidenceEvent>): Promise<{ event?: EvidenceEvent; error?: string }> {
  return call.then(
    (event) => ({ event }),
    (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
  );
}

/** Rejections no handler took while `run` ran (and a turn after). */
async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await run();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return unhandled;
}

const types = (emitter: EvidenceEmitter, stepId = "s1") => emitter.getEvents(JOB, stepId).map((e) => e.type);

// Refvertical's reproduction (#6343), as they wrote it: at master cd9d8770 it recorded
// ["execution_completed","execution_progress"].
it("two overlapping addEvent calls on one step record in call order", async () => {
  const subtle = globalThis.crypto.subtle;
  const real = subtle.digest.bind(subtle);
  let calls = 0;
  vi.spyOn(subtle, "digest").mockImplementation(async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    const mine = ++calls;
    if (mine === 1) await new Promise((resolve) => setTimeout(resolve, 50)); // the first digest is slow
    return real(algorithm, data);
  });
  const emitter = new EvidenceEmitter("kernel-order");
  emitter.registerStep("job-1", "step-1", 0);
  const first = emitter.addEvent("job-1", "step-1", { type: "execution_progress", timestamp: "2026-10-03T00:00:00Z", payload: {} } as never);
  const second = emitter.addEvent("job-1", "step-1", { type: "execution_completed", timestamp: "2026-10-03T00:00:01Z", payload: {} } as never);
  await Promise.all([first, second]);
  expect(emitter.getEvents("job-1", "step-1").map((e) => e.type)).toEqual(["execution_progress", "execution_completed"]);
});

describe("EvidenceEmitter stores a step's events in call order (N123)", () => {
  it("stores nothing ahead of an earlier event whose digest has not finished, then all in call order", async () => {
    const digests = controlDigests();
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const calls = [
      settled(emitter.addEvent(JOB, "s1", raw("execution_started", 0, { mark: "held" }))),
      settled(emitter.addEvent(JOB, "s1", raw("execution_progress", 1))),
      settled(emitter.addEvent(JOB, "s1", raw("execution_completed", 2))),
    ];

    await digests.done(); // the later two digests have finished; the first is still held
    expect(types(emitter), "stored while the first digest was held").toEqual([]);
    // The hashes run concurrently: every digest was asked for at its call, none waits its turn.
    expect(digests.requested).toEqual(["execution_started", "execution_progress", "execution_completed"]);

    digests.release();
    const results = await Promise.all(calls);
    expect(results.map((r) => r.error)).toEqual([undefined, undefined, undefined]);
    const stored = emitter.getEvents(JOB, "s1");
    expect(stored.map((e) => e.type)).toEqual(["execution_started", "execution_progress", "execution_completed"]);
    // Each call resolves to the event stored in its place, and each stored hash is its own event's.
    expect(results.map((r) => r.event?.id)).toEqual(stored.map((e) => e.id));
    for (const event of stored) expect(await verifyEventHash(event), event.type).toBe(true);
  });

  it("an event whose digest fails takes no place, and lets no later event ahead of an earlier one", async () => {
    const digests = controlDigests();
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    let results: Array<{ event?: EvidenceEvent; error?: string }> = [];
    const unhandled = await unhandledDuring(async () => {
      const calls = [
        settled(emitter.addEvent(JOB, "s1", raw("execution_started", 0, { mark: "held" }))),
        settled(emitter.addEvent(JOB, "s1", raw("execution_progress", 1, { mark: "fails" }))),
        settled(emitter.addEvent(JOB, "s1", raw("execution_completed", 2))),
      ];
      await digests.done(); // the second digest has failed and the third has finished; the first is held
      expect(types(emitter), "stored while the first digest was held").toEqual([]);
      digests.release();
      results = await Promise.all(calls);
    });

    expect(unhandled, "rejections no handler took").toEqual([]);
    expect(results.map((r) => r.error)).toEqual([undefined, "digest failed", undefined]);
    expect(types(emitter)).toEqual(["execution_started", "execution_completed"]);
  });

  it("an event the step refuses rejects at once, takes no place, and holds no other event back", async () => {
    const digests = controlDigests();
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const first = settled(emitter.addEvent(JOB, "s1", raw("execution_started", 0, { mark: "held" })));
    const refused = settled(emitter.addEvent(JOB, "s1", raw("execution_progress", 1, { jobId: "another-job" })));
    const third = settled(emitter.addEvent(JOB, "s1", raw("execution_completed", 2)));

    // Refused before its turn: it never waits behind the held digest.
    expect((await refused).error).toBe(`event payload.jobId another-job does not match the step's ${JOB}`);
    await digests.done();
    expect(types(emitter), "stored while the first digest was held").toEqual([]);

    digests.release();
    expect((await first).error).toBeUndefined();
    expect((await third).error).toBeUndefined();
    expect(types(emitter)).toEqual(["execution_started", "execution_completed"]);
  });

  it("orders each step on its own: a held digest on one step holds back no other step's events", async () => {
    const digests = controlDigests();
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    emitter.registerStep(JOB, "s2", 0);
    const held = settled(emitter.addEvent(JOB, "s1", raw("execution_started", 0, { mark: "held" })));
    const other = await settled(emitter.addEvent(JOB, "s2", raw("execution_started", 1)));

    expect(other.error).toBeUndefined();
    expect(types(emitter, "s2")).toEqual(["execution_started"]);
    expect(types(emitter, "s1")).toEqual([]);

    digests.release();
    expect((await held).error).toBeUndefined();
    expect(types(emitter, "s1")).toEqual(["execution_started"]);
  });
});
