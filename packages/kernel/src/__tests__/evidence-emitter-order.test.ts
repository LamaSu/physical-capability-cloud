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
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyBundleHash, verifyEventHash, type EvidenceBundle, type EvidenceEvent, type EvidenceSource, type Signature } from "@pcc/spec";
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
  // Each event carries a source: the emitter refuses an event without one (astra pack 273).
  const source = { deviceId: "dev-1", deviceType: "machine", kernelId: "kernel-order" };
  const first = emitter.addEvent("job-1", "step-1", { type: "execution_progress", timestamp: "2026-10-03T00:00:00Z", source, payload: {} } as never);
  const second = emitter.addEvent("job-1", "step-1", { type: "execution_completed", timestamp: "2026-10-03T00:00:01Z", source, payload: {} } as never);
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


/** A signer that waits at a gate: `inside` resolves once it is signing; release() lets it finish. */
function gatedSigner(): { signFn: (data: string) => Promise<Signature>; inside: Promise<void>; release: () => void } {
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signFn = async (data: string): Promise<Signature> => {
    entered();
    await gate;
    return { signer: `0x${"11".repeat(20)}`, algorithm: "secp256k1", value: `sig_${data.slice(0, 16)}` } as Signature;
  };
  return { signFn, inside, release };
}

/** A finalizeBundle call settled into a value at once. */
function settledBundle(call: Promise<EvidenceBundle>): Promise<{ bundle?: EvidenceBundle; error?: string }> {
  return call.then(
    (bundle) => ({ bundle }),
    (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
  );
}

// The step's lifecycle around its chain (astra pack 259): finalizing, registering again, cleaning
// up, and the job/step key.
describe("EvidenceEmitter's step lifecycle around the chain (pack 259)", () => {
  it("finalizeBundle signs one snapshot: its hash covers exactly its events, whatever is added while it signs", async () => {
    const signer = gatedSigner();
    const emitter = new EvidenceEmitter(KERNEL, signer.signFn);
    emitter.registerStep(JOB, "s1", 0);
    await emitter.addEvent(JOB, "s1", raw("execution_started", 0));

    const finalizing = emitter.finalizeBundle(JOB, "s1");
    await signer.inside;
    await emitter.addEvent(JOB, "s1", raw("execution_completed", 1)); // stored while the bundle is being signed
    signer.release();
    const bundle = await finalizing;

    expect(bundle.events.map((e) => e.type)).toEqual(["execution_started"]);
    expect(await verifyBundleHash(bundle), "the bundle hash covers its events").toBe(true);
    expect(types(emitter), "the later event is stored in the step, after the bundle").toEqual(["execution_started", "execution_completed"]);
  });

  it("finalizeBundle signs a detached snapshot: an event changed through the caller's reference while it signs never reaches the bundle", async () => {
    const signer = gatedSigner();
    const emitter = new EvidenceEmitter(KERNEL, signer.signFn);
    emitter.registerStep(JOB, "s1", 0);
    const returned = await emitter.addEvent(JOB, "s1", raw("execution_completed", 0, { pages: 3 }));
    const original = returned.hash;

    const finalizing = emitter.finalizeBundle(JOB, "s1");
    await signer.inside;
    // The caller still holds the event addEvent returned (getEvents() hands out the same one).
    (returned as { hash: string }).hash = `sha256:${"0".repeat(64)}`;
    (returned.payload as { pages: number }).pages = 99;
    signer.release();
    const bundle = await finalizing;

    expect(bundle.events[0]).not.toBe(returned);
    expect(bundle.events[0]?.hash).toBe(original);
    expect((bundle.events[0]?.payload as { pages: number }).pages).toBe(3);
    expect(await verifyBundleHash(bundle), "the bundle hash covers its events").toBe(true);
    expect(await verifyEventHash(bundle.events[0]!), "the event hash covers its content").toBe(true);
  });

  it("stores a detached copy of each event: the emitting adapter changing its payload afterwards changes nothing stored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const reading = { celsius: 21, probe: { id: "p1" } }; // the adapter's own objects
    await emitter.addEvent(JOB, "s1", raw("sensor_data_summary", 0, { reading }));
    reading.celsius = 99;
    reading.probe.id = "p2";

    const bundle = await emitter.finalizeBundle(JOB, "s1");
    expect((bundle.events[0]?.payload as { reading: unknown }).reading).toEqual({ celsius: 21, probe: { id: "p1" } });
    expect(await verifyEventHash(bundle.events[0]!), "the event hash covers its content").toBe(true);
    expect(await verifyBundleHash(bundle)).toBe(true);
  });

  it("hands callers detached copies: changing what addEvent or getEvents returned changes nothing stored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const returned = await emitter.addEvent(JOB, "s1", raw("execution_completed", 0, { pages: 3 }));
    (returned as { hash: string }).hash = `sha256:${"0".repeat(64)}`;
    (returned.payload as { pages: number }).pages = 99;
    const listed = emitter.getEvents(JOB, "s1");
    (listed[0]!.payload as { pages: number }).pages = 98;
    listed.push({ ...listed[0]!, id: "ev_injected" });

    const bundle = await emitter.finalizeBundle(JOB, "s1");
    expect(bundle.events.map((e) => e.id)).toEqual([returned.id]);
    expect((bundle.events[0]?.payload as { pages: number }).pages).toBe(3);
    expect(await verifyEventHash(bundle.events[0]!), "the event hash covers its content").toBe(true);
    expect(await verifyBundleHash(bundle)).toBe(true);
  });

  it("a bundle shares no object with the stored record: changing a returned bundle changes nothing stored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    await emitter.addEvent(JOB, "s1", raw("execution_completed", 0, { pages: 3 }));
    const first = await emitter.finalizeBundle(JOB, "s1");
    (first.events[0]!.payload as { pages: number }).pages = 99;
    (first.events[0] as { hash: string }).hash = `sha256:${"0".repeat(64)}`;

    expect((emitter.getEvents(JOB, "s1")[0]?.payload as { pages: number }).pages).toBe(3);
    const second = await emitter.finalizeBundle(JOB, "s1");
    expect((second.events[0]?.payload as { pages: number }).pages).toBe(3);
    expect(await verifyBundleHash(second)).toBe(true);
    expect(await verifyEventHash(second.events[0]!)).toBe(true);
  });

  it("refuses an event whose hashed fields are not plain JSON data, before it takes a place (packs 265, 273)", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    class Reading {
      celsius = 21;
    }
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    const hidden = {};
    Object.defineProperty(hidden, "x", { value: 1, enumerable: false });
    const refused: Array<[string, Record<string, unknown>, string]> = [
      ["a Date", { at: new Date(0) }, "event.payload.at is not a plain object"],
      ["a Map", { m: new Map([["a", 1]]) }, "event.payload.m is not a plain object"],
      ["a Set", { s: new Set([1]) }, "event.payload.s is not a plain object"],
      ["a typed array", { bytes: new Uint8Array([1, 2]) }, "event.payload.bytes is not a plain object"],
      ["shared memory", { bytes: new Uint8Array(new SharedArrayBuffer(2)) }, "event.payload.bytes is not a plain object"],
      ["a RegExp", { r: /x/ }, "event.payload.r is not a plain object"],
      ["a class instance", { reading: new Reading() }, "event.payload.reading is not a plain object"],
      ["a boxed primitive", { s: new String("x") }, "event.payload.s is not a plain object"],
      ["an undefined element", { list: [1, undefined] }, "event.payload.list[1] is undefined"],
      ["an undefined member (astra pack 273)", { x: undefined }, "event.payload.x is undefined"],
      ["a nested undefined member", { reading: { celsius: undefined } }, "event.payload.reading.celsius is undefined"],
      ["a hole", { list: sparse }, "event.payload.list[1] is a hole"],
      ["a bigint", { n: 1n }, "event.payload.n is a bigint"],
      ["NaN", { x: NaN }, "event.payload.x is NaN"],
      ["Infinity", { x: Infinity }, "event.payload.x is Infinity"],
      ["-Infinity", { x: -Infinity }, "event.payload.x is -Infinity"],
      ["an integer past the safe range (D5)", { n: 2 ** 53 }, "event.payload.n is the integer 9007199254740992, outside the safe range"],
      ["a negative one", { n: -(2 ** 53) }, "event.payload.n is the integer -9007199254740992, outside the safe range"],
      ["a magnitude only an integer has", { n: 6.02e23 }, "event.payload.n is the integer 6.02e+23, outside the safe range"],
      ["a named member on an array", { list: Object.assign([1, 2], { unit: "mm" }) }, "event.payload.list has a member besides its elements"],
      ["a symbol-keyed member", { m: { [Symbol("k")]: 1 } }, "event.payload.m has a symbol-keyed member"],
      ["a non-enumerable member", { m: hidden }, "event.payload.m.x is not enumerable"],
      ["a member named __proto__", { m: JSON.parse('{"__proto__": 1}') }, "event.payload.m has a member named __proto__"],
    ];
    for (const [label, payload, problem] of refused) {
      await expect(emitter.addEvent(JOB, "s1", raw("execution_progress", 0, payload)), label).rejects.toThrow(problem);
    }
    // The four hashed fields: type and timestamp are strings, and source is a plain object, never undefined (astra pack 273).
    const base = raw("execution_progress", 0) as unknown as Record<string, unknown>;
    const roots: Array<[string, Record<string, unknown>, string]> = [
      ["type undefined", { ...base, type: undefined }, "event.type is not a string"],
      ["timestamp undefined", { ...base, timestamp: undefined }, "event.timestamp is not a string"],
      ["source undefined", { ...base, source: undefined }, "event.source is undefined"],
      ["source absent", { type: base.type, timestamp: base.timestamp, payload: {} }, "event.source is undefined"],
      ["source an array", { ...base, source: [] }, "event.source is not an object"],
      ["payload an array", { ...base, payload: [1] }, "event.payload is not an object"],
    ];
    for (const [label, event, problem] of roots) {
      await expect(emitter.addEvent(JOB, "s1", event as never), label).rejects.toThrow(problem);
    }
    // A cycle is refused at the depth cap, never walked forever.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    await expect(emitter.addEvent(JOB, "s1", raw("execution_progress", 0, { cyclic }))).rejects.toThrow("nests deeper than 64");
    // In the source too.
    const fromSource = { ...base, source: { deviceId: "dev-1", at: new Date(0) } };
    await expect(emitter.addEvent(JOB, "s1", fromSource as never)).rejects.toThrow("event.source.at is not a plain object");
    // None took a place: plain data still stores, and the step holds only it.
    const nested = {
      reading: { celsius: 21, probes: [{ id: "p1" }, null, true, "x"] },
      bare: Object.create(null),
      numbers: [2 ** 53 - 1, -(2 ** 53 - 1), 0.5, 1e-300, -0],
    };
    const plain = await emitter.addEvent(JOB, "s1", raw("execution_completed", 1, nested));
    expect(types(emitter)).toEqual(["execution_completed"]);
    expect(await verifyEventHash(plain)).toBe(true);
    // What is stored is what JSON carries: -0 is stored as 0, and a JSON round trip changes nothing.
    expect(Object.is((plain.payload as { numbers: number[] }).numbers[4], 0)).toBe(true);
    expect(JSON.parse(JSON.stringify(emitter.getEvents(JOB, "s1")[0]))).toEqual(emitter.getEvents(JOB, "s1")[0]);
    // An absent or null payload is an empty one, as before.
    const empty = await emitter.addEvent(JOB, "s1", { ...base, payload: null } as never);
    expect(empty.payload).toEqual({ jobId: JOB });
  });

  it("stores only the fields the hash covers: anything else on the event is dropped at the call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const extra = { ...raw("execution_completed", 0, { pages: 3 }), note: "never hashed", id: "ev_chosen", hash: `sha256:${"0".repeat(64)}` };
    const stored = await emitter.addEvent(JOB, "s1", extra as never);
    const fields = ["hash", "id", "payload", "source", "timestamp", "type"];
    expect(Object.keys(stored).sort()).toEqual(fields);
    expect(stored.id).not.toBe("ev_chosen");

    const bundle = await emitter.finalizeBundle(JOB, "s1");
    expect(Object.keys(bundle.events[0]!).sort()).toEqual(fields);
    expect(Object.keys(emitter.getEvents(JOB, "s1")[0]!).sort()).toEqual(fields);
    expect(await verifyEventHash(bundle.events[0]!)).toBe(true);
    expect(await verifyBundleHash(bundle)).toBe(true);
  });

  it("finalizeBundle waits for an add accepted before it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const digests = controlDigests();
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const add = settled(emitter.addEvent(JOB, "s1", raw("execution_completed", 0, { mark: "held" })));
    const finalizing = settledBundle(emitter.finalizeBundle(JOB, "s1"));

    await digests.done();
    digests.release();
    const { bundle, error } = await finalizing;
    expect(error, "finalizeBundle failed").toBeUndefined();
    expect(bundle?.events.map((e) => e.type)).toEqual(["execution_completed"]);
    expect((await add).event?.id).toBe(bundle?.events[0]?.id);
  });

  it("finalizeBundle refuses to sign a step with an accepted add that could not be stored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    controlDigests();
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const failed = await settled(emitter.addEvent(JOB, "s1", raw("execution_progress", 0, { mark: "fails" })));
    const stored = await settled(emitter.addEvent(JOB, "s1", raw("execution_completed", 1)));
    expect([failed.error, stored.error]).toEqual(["digest failed", undefined]);

    const { bundle, error } = await settledBundle(emitter.finalizeBundle(JOB, "s1"));
    expect(bundle, "a bundle signed without the lost event").toBeUndefined();
    expect(error).toBe(`an event of step s1 of job ${JOB} could not be stored (execution_progress: digest failed), so its evidence is incomplete`);
  });

  it("registerStep refuses a step whose adds are still pending, so no accepted event is detached", async () => {
    const digests = controlDigests();
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const pending = settled(emitter.addEvent(JOB, "s1", raw("execution_started", 0, { mark: "held" })));

    expect(() => emitter.registerStep(JOB, "s1", 0)).toThrow(`registerStep: step s1 of job ${JOB} still has events being stored`);
    digests.release();
    expect((await pending).error).toBeUndefined();
    expect(types(emitter)).toEqual(["execution_started"]);
  });

  it("registerStep replaces a step whose adds have all settled (a later run starts a fresh record)", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    await emitter.addEvent(JOB, "s1", raw("execution_started", 0));
    emitter.registerStep(JOB, "s1", 0);
    expect(types(emitter)).toEqual([]);
  });

  it("an add pending when its step is cleaned up fails, and stores nothing", async () => {
    const digests = controlDigests();
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const pending = settled(emitter.addEvent(JOB, "s1", raw("execution_started", 0, { mark: "held" })));
    emitter.cleanup(JOB, "s1");
    digests.release();

    expect((await pending).error).toBe(`step s1 of job ${JOB} was cleaned up before this execution_started event was stored`);
    expect(emitter.getEvents(JOB, "s1")).toEqual([]);
  });

  it("keeps jobs and steps apart whose ids would join to the same job:step string", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep("a:b", "c", 0);
    await expect(emitter.addEvent("a", "b:c", raw("execution_started", 0))).rejects.toThrow("No step registered for a:b:c");

    emitter.registerStep("a", "b:c", 0);
    await emitter.addEvent("a:b", "c", raw("execution_started", 0));
    await emitter.addEvent("a", "b:c", raw("execution_completed", 1));
    expect(emitter.getEvents("a:b", "c").map((e) => [e.type, (e.payload as { jobId: string }).jobId])).toEqual([["execution_started", "a:b"]]);
    expect(emitter.getEvents("a", "b:c").map((e) => [e.type, (e.payload as { jobId: string }).jobId])).toEqual([["execution_completed", "a"]]);
  });
});

describe("EvidenceEmitter's input boundary runs no adapter code and uses intrinsics captured at load (astra pack 273)", () => {
  it("astra's recipe: a payload getter is refused without running, so it can neither swap structuredClone nor keep a reference into what is stored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const original = globalThis.structuredClone;
    let runs = 0;
    const payload = {};
    Object.defineProperty(payload, "reading", {
      enumerable: true,
      get() {
        runs++;
        globalThis.structuredClone = ((v: unknown) => v) as typeof structuredClone;
        return { celsius: 21 };
      },
    });
    try {
      await expect(emitter.addEvent(JOB, "s1", raw("sensor_data_summary", 0, payload))).rejects.toThrow("event.payload.reading is an accessor");
    } finally {
      globalThis.structuredClone = original;
    }
    expect(runs).toBe(0);
    expect(types(emitter)).toEqual([]);
  });

  it("a getter on the event itself, or a Proxy anywhere, is refused without running it or any trap", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    let runs = 0;
    const event = { ...(raw("execution_progress", 0) as unknown as Record<string, unknown>) };
    Object.defineProperty(event, "payload", { enumerable: true, get: () => (runs++, {}) });
    await expect(emitter.addEvent(JOB, "s1", event as never)).rejects.toThrow("event.payload is an accessor");
    // A handler that is itself a proxy counts every trap the engine looks up.
    const handler = new Proxy({}, { get: () => (runs++, undefined) });
    await expect(emitter.addEvent(JOB, "s1", raw("execution_progress", 0, { reading: new Proxy({ celsius: 21 }, handler) }))).rejects.toThrow(
      "event.payload.reading is a proxy",
    );
    await expect(emitter.addEvent(JOB, "s1", new Proxy(raw("execution_progress", 0) as object, handler) as never)).rejects.toThrow("event is not a plain object");
    expect(runs).toBe(0);
    expect(types(emitter)).toEqual([]);
  });

  it("intrinsics replaced after load change nothing: a Date, NaN, an accessor and a hole are still refused, and plain data still stores", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const saved = {
      getPrototypeOf: Object.getPrototypeOf,
      getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
      ownKeys: Reflect.ownKeys,
      isArray: Array.isArray,
      isFinite: Number.isFinite,
      isSafeInteger: Number.isSafeInteger,
      keys: Object.keys,
      structuredClone: globalThis.structuredClone,
    };
    const getter = {};
    Object.defineProperty(getter, "x", { enumerable: true, get: () => 1 });
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    const calls: Array<Promise<{ event?: EvidenceEvent; error?: string }>> = [];
    try {
      // Each replacement answers what would let the bad input through. The copy runs synchronously inside the
      // call, before addEvent's first await, so every refusal is decided while they are in place.
      Object.getPrototypeOf = (() => Object.prototype) as typeof Object.getPrototypeOf;
      Object.getOwnPropertyDescriptor = ((o: object, k: PropertyKey) => ({
        value: (o as Record<PropertyKey, unknown>)[k],
        writable: true,
        enumerable: true,
        configurable: true,
      })) as typeof Object.getOwnPropertyDescriptor;
      Reflect.ownKeys = ((o: object) => saved.keys(o)) as typeof Reflect.ownKeys;
      Array.isArray = (() => false) as unknown as typeof Array.isArray;
      Number.isFinite = (() => true) as typeof Number.isFinite;
      Number.isSafeInteger = (() => true) as typeof Number.isSafeInteger;
      globalThis.structuredClone = ((v: unknown) => v) as typeof structuredClone;
      calls.push(settled(emitter.addEvent(JOB, "s1", raw("execution_progress", 0, { at: new Date(0) }))));
      calls.push(settled(emitter.addEvent(JOB, "s1", raw("execution_progress", 0, { x: NaN }))));
      calls.push(settled(emitter.addEvent(JOB, "s1", raw("execution_progress", 0, { m: getter }))));
      calls.push(settled(emitter.addEvent(JOB, "s1", raw("execution_progress", 0, { list: sparse }))));
      calls.push(settled(emitter.addEvent(JOB, "s1", raw("execution_completed", 1, { reading: { celsius: 21 } }))));
    } finally {
      Object.getPrototypeOf = saved.getPrototypeOf;
      Object.getOwnPropertyDescriptor = saved.getOwnPropertyDescriptor;
      Reflect.ownKeys = saved.ownKeys;
      Array.isArray = saved.isArray;
      Number.isFinite = saved.isFinite;
      Number.isSafeInteger = saved.isSafeInteger;
      globalThis.structuredClone = saved.structuredClone;
    }
    const outcomes = await Promise.all(calls);
    expect(outcomes.map((o) => o.error ?? "stored")).toEqual([
      expect.stringContaining("event.payload.at is not a plain object"),
      expect.stringContaining("event.payload.x is NaN"),
      expect.stringContaining("event.payload.m.x is an accessor"),
      expect.stringContaining("event.payload.list[1] is a hole"),
      "stored",
    ]);
    expect(types(emitter)).toEqual(["execution_completed"]);
    expect(await verifyEventHash(outcomes[4]!.event!)).toBe(true);
  });

  it("setters and a `get` planted on Object.prototype after load: the copy and the job binding define properties, so no setter runs and nothing is lost", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    let runs = 0;
    const planted = ["jobId", "reading", "celsius"];
    let call: Promise<{ event?: EvidenceEvent; error?: string }>;
    try {
      // A setter would swallow an assigned member; a `get` on Object.prototype would make every ordinary
      // descriptor read as an accessor's. Both are planted only for the synchronous part of the call.
      for (const key of planted) Object.defineProperty(Object.prototype, key, { configurable: true, set: () => void runs++ });
      Object.defineProperty(Object.prototype, "get", { configurable: true, writable: true, value: () => (runs++, undefined) });
      Object.defineProperty(Object.prototype, "settlementUnitId", { configurable: true, get: () => (runs++, `0x${"ab".repeat(32)}`) });
      call = settled(emitter.addEvent(JOB, "s1", raw("execution_completed", 0, { reading: { celsius: 21 } })));
    } finally {
      for (const key of [...planted, "get", "settlementUnitId"]) delete (Object.prototype as Record<string, unknown>)[key];
    }
    const outcome = await call!;
    expect(outcome.error).toBeUndefined();
    expect(runs).toBe(0);
    const stored = emitter.getEvents(JOB, "s1")[0]!;
    expect(stored.payload).toEqual({ reading: { celsius: 21 }, jobId: JOB });
    expect(await verifyEventHash(stored)).toBe(true);
  });

  it("structuredClone replaced after load: getEvents still hands out detached copies, through the clone captured at load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    await emitter.addEvent(JOB, "s1", raw("execution_completed", 0, { pages: 3 }));
    const original = globalThis.structuredClone;
    let listed: EvidenceEvent[] = [];
    try {
      globalThis.structuredClone = ((v: unknown) => v) as typeof structuredClone;
      listed = emitter.getEvents(JOB, "s1");
    } finally {
      globalThis.structuredClone = original;
    }
    (listed[0]!.payload as { pages: number }).pages = 99;
    expect((emitter.getEvents(JOB, "s1")[0]!.payload as { pages: number }).pages).toBe(3);
  });

  it("the emitter calls no clone or reflection intrinsic it did not capture at load (a scan of its source)", () => {
    const source = readFileSync(new URL("../evidence-emitter.ts", import.meta.url), "utf8");
    // Comments out, then every call of an intrinsic the boundary or a copy could reach through a global.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const pattern =
      /\b(structuredClone|Object\.(getPrototypeOf|getOwnPropertyDescriptor|defineProperty|create|keys|entries|values|assign)|Reflect\.ownKeys|Array\.isArray|Number\.is(Finite|Integer|SafeInteger)|types\.isProxy)\s*\(/g;
    expect(code.match(pattern) ?? []).toEqual([]);
    // And the capture itself is there.
    expect(code).toContain("const StructuredClone = globalThis.structuredClone;");
  });
});
