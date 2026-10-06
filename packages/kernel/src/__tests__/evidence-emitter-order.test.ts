/**
 * EvidenceEmitter stores a step's events in the order addEvent is called (N123), and every call it
 * makes goes through a binding it captured when its module loaded (steward #6651, #6668).
 *
 * N123: addEvent used to hash each event with an asynchronous digest (crypto.subtle, through
 * @pcc/spec's hashEvent) before it stored it, so overlapping calls on one step stored in
 * digest-finish order: a slow digest put an event after later ones (refvertical #6343; the IPP
 * binding flakes of #474, #456 and #6307). It now hashes each event at its call, synchronously,
 * with node:crypto's one-shot digest captured at load, and stores it on the step's chain in call
 * order. crypto.subtle.digest is never asked, so these tests replace it with one that holds,
 * fails or forges a digest, and show that it changes nothing.
 *
 * The closed allowlist parses evidence-emitter.ts with the TypeScript compiler and accepts a call
 * only to a load-time capture, a function or class declared in the file, a private member of the
 * emitter, or a callback registered with onBundle. The replacement tests then replace each
 * residual the steward named (Map, Promise, the digest, RegExp, ids, Sentry, the emitter's own
 * properties) during addEvent, getEvents and finalizeBundle.
 */
import { readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as SentryModule from "@sentry/node";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIER_REQUIREMENTS,
  KERNEL_PULL_CAPTURE_TYPES,
  hashBundle,
  hashEvent,
  ids,
  verifyBundleHash,
  verifyEventHash,
  type EvidenceBundle,
  type EvidenceEvent,
  type EvidenceSource,
  type Signature,
} from "@pcc/spec";
import { EvidenceEmitter } from "../evidence-emitter.js";

// A plain function, so vi.restoreAllMocks() leaves it: the emitter takes startSpan once, when it loads.
vi.mock("@sentry/node", () => ({ startSpan: (_options: unknown, callback: () => unknown) => callback() }));

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
 * Replaces crypto.subtle.digest, on crypto.subtle and on its prototype, with one that never finishes
 * the digest of an event whose payload has mark "held", fails the digest of one marked "fails", and
 * forges every other (32 zero bytes). `requested` lists the event types whose digests were asked
 * for: the emitter hashes with the digest it captured at load, so it asks for none. restore() puts
 * the real digest back.
 */
function hostileDigests(): { requested: string[]; restore: () => void } {
  const subtle = globalThis.crypto.subtle;
  const requested: string[] = [];
  const hostile = ((_algorithm: AlgorithmIdentifier, data: BufferSource) => {
    const text = new TextDecoder().decode(data as Uint8Array);
    requested.push(/"type":"([a-z_]+)"/.exec(text)?.[1] ?? "?");
    if (text.includes('"mark":"held"')) return new Promise<ArrayBuffer>(() => {});
    if (text.includes('"mark":"fails"')) return Promise.reject(new Error("digest failed"));
    return Promise.resolve(new ArrayBuffer(32));
  }) as typeof subtle.digest;
  const onInstance = vi.spyOn(subtle, "digest").mockImplementation(hostile);
  const onPrototype = vi.spyOn(Object.getPrototypeOf(subtle) as SubtleCrypto, "digest").mockImplementation(hostile);
  return {
    requested,
    restore: () => {
      onInstance.mockRestore();
      onPrototype.mockRestore();
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
// ["execution_completed","execution_progress"]. The emitter no longer asks crypto.subtle for a
// digest, so the slow one it sets up never runs: the order holds by construction.
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
  it("hashes each event at its call with the digest captured at load: a held, failing or forging crypto.subtle.digest is never asked, and every event stores in call order", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const digests = hostileDigests();
    let results: Array<{ event?: EvidenceEvent; error?: string }> = [];
    const unhandled = await unhandledDuring(async () => {
      const calls = [
        settled(emitter.addEvent(JOB, "s1", raw("execution_started", 0, { mark: "held" }))),
        settled(emitter.addEvent(JOB, "s1", raw("execution_progress", 1, { mark: "fails" }))),
        settled(emitter.addEvent(JOB, "s1", raw("execution_completed", 2))),
      ];
      // Each took its place at its call, and stores on the step's chain after the one before it.
      expect(types(emitter), "stored before the chain ran").toEqual([]);
      results = await Promise.all(calls);
    });
    digests.restore();

    expect(digests.requested, "digests asked of crypto.subtle").toEqual([]);
    expect(unhandled, "rejections no handler took").toEqual([]);
    expect(results.map((r) => r.error)).toEqual([undefined, undefined, undefined]);
    const stored = emitter.getEvents(JOB, "s1");
    expect(stored.map((e) => e.type)).toEqual(["execution_started", "execution_progress", "execution_completed"]);
    // Each call resolves to the event stored in its place, and each stored hash is its own event's.
    expect(results.map((r) => r.event?.id)).toEqual(stored.map((e) => e.id));
    for (const event of stored) expect(await verifyEventHash(event), event.type).toBe(true);
  });

  it("an event the step refuses rejects at once, takes no place, and holds no other event back", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const settledOrder: string[] = [];
    const track = (label: string, call: Promise<EvidenceEvent>) =>
      settled(call).then((result) => {
        settledOrder.push(label);
        return result;
      });
    const first = track("first", emitter.addEvent(JOB, "s1", raw("execution_started", 0)));
    const refused = track("refused", emitter.addEvent(JOB, "s1", raw("execution_progress", 1, { jobId: "another-job" })));
    const third = track("third", emitter.addEvent(JOB, "s1", raw("execution_completed", 2)));

    expect((await refused).error).toBe(`event payload.jobId another-job does not match the step's ${JOB}`);
    expect((await first).error).toBeUndefined();
    expect((await third).error).toBeUndefined();
    // Refused at its call: it settled before the event called ahead of it was stored.
    expect(settledOrder).toEqual(["refused", "first", "third"]);
    expect(types(emitter)).toEqual(["execution_started", "execution_completed"]);
  });

  it("orders each step on its own: cleaning up a step with an add pending fails that add and touches no other step's", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    emitter.registerStep(JOB, "s2", 0);
    const onS1 = settled(emitter.addEvent(JOB, "s1", raw("execution_started", 0)));
    const onS2 = settled(emitter.addEvent(JOB, "s2", raw("execution_started", 1)));
    emitter.cleanup(JOB, "s1");

    expect((await onS1).error).toBe(`step s1 of job ${JOB} was cleaned up before this execution_started event was stored`);
    expect((await onS2).error).toBeUndefined();
    expect(types(emitter, "s2")).toEqual(["execution_started"]);
    expect(types(emitter, "s1")).toEqual([]);
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
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const add = settled(emitter.addEvent(JOB, "s1", raw("execution_completed", 0)));
    const finalizing = settledBundle(emitter.finalizeBundle(JOB, "s1"));
    expect(types(emitter), "stored when finalizeBundle was called").toEqual([]);

    const { bundle, error } = await finalizing;
    expect(error, "finalizeBundle failed").toBeUndefined();
    expect(bundle?.events.map((e) => e.type)).toEqual(["execution_completed"]);
    expect((await add).event?.id).toBe(bundle?.events[0]?.id);
  });

  // An accepted add can fail only one way now: its hash is taken at its call, before it takes a
  // place, so what can still stop it is its step being cleaned up while it waits its turn.
  it("an add accepted before finalizeBundle that cannot be stored, its step cleaned up, leaves no bundle signed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const add = settled(emitter.addEvent(JOB, "s1", raw("execution_completed", 0)));
    const finalizing = settledBundle(emitter.finalizeBundle(JOB, "s1"));
    emitter.cleanup(JOB, "s1");

    expect((await add).error).toBe(`step s1 of job ${JOB} was cleaned up before this execution_completed event was stored`);
    const { bundle, error } = await finalizing;
    expect(bundle, "a bundle signed without the event").toBeUndefined();
    expect(error).toBe(`step s1 of job ${JOB} was cleaned up while its bundle was being finalized`);
  });

  it("registerStep refuses a step whose adds are still pending, so no accepted event is detached", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const pending = settled(emitter.addEvent(JOB, "s1", raw("execution_started", 0)));

    expect(() => emitter.registerStep(JOB, "s1", 0)).toThrow(`registerStep: step s1 of job ${JOB} still has events being stored`);
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
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const pending = settled(emitter.addEvent(JOB, "s1", raw("execution_started", 0)));
    emitter.cleanup(JOB, "s1");

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

  it("Array.prototype.push replaced after load is never handed a stored event, so it cannot change one after hashing (astra pack 277)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const originalPush = Array.prototype.push;
    const captured: Array<Record<string, any>> = [];
    // astra's recipe: a push that keeps every event it is handed, then delegates. Held across the store chain.
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (typeof item === "object" && item !== null && (item as { type?: unknown }).type === "execution_completed" && "hash" in item) {
          originalPush.call(captured, item as Record<string, any>);
        }
      }
      return originalPush.apply(this, items);
    } as typeof Array.prototype.push;
    try {
      await emitter.addEvent(JOB, "s1", raw("execution_completed", 0, { pages: 3 }));
    } finally {
      Array.prototype.push = originalPush;
    }
    for (const event of captured) (event.payload as { pages: number }).pages = 99;
    expect(captured).toEqual([]);
    const stored = emitter.getEvents(JOB, "s1")[0]!;
    expect((stored.payload as { pages: number }).pages).toBe(3);
    expect(await verifyEventHash(stored)).toBe(true);
    // The kernel signs what it hashed: the bundle hash AND each of its events verify.
    const bundle = await emitter.finalizeBundle(JOB, "s1");
    expect(await verifyBundleHash(bundle)).toBe(true);
    expect(await verifyEventHash(bundle.events[0]!)).toBe(true);
  });

});

// -- The closed allowlist (steward #6651, #6668) --

const CAPTURE_BEGIN = "// -- captured when this module loads";
const CAPTURE_END = "// -- end of the load-time captures --";

/** A call outside the allowlist, or a form that calls without a call expression: where, what, and why it is refused. */
interface Violation {
  line: number;
  text: string;
  why: string;
}

/** What the allowlist admits besides rules (a) to (c) of checkAllowlist, by name. */
interface AllowlistRules {
  /** Private fields that may also be assigned in one named method besides the constructor: field -> method. */
  attachedIn: Record<string, string>;
  /** Callees a collaborator supplied (a registered callback): name -> the one method that may call it. */
  collaborators: Record<string, string>;
  /** Captures that make new callables: callable only in the capture block, a constructor, and makerMethods. */
  makers: string[];
  makerMethods: string[];
}

/**
 * The emitter's: the storage service's isReady and archiveBundle are bound when it is attached, and
 * #finalizeBundle calls the callbacks registered with onBundle. uncurryThis and FunctionPrototypeBind
 * make callables, so they run only where a collaborator is taken in.
 */
const EMITTER_RULES: AllowlistRules = {
  attachedIn: { "#storageIsReady": "setStorageService", "#storageArchive": "setStorageService" },
  collaborators: { listener: "#finalizeBundle" },
  makers: ["uncurryThis", "FunctionPrototypeBind"],
  makerMethods: ["setStorageService"],
};

/**
 * The closed allowlist, over the TypeScript syntax tree of `source`. Outside the load-time capture
 * block (the top-level const declarations between the two marker comments, which run once, at load),
 * every call expression, `new` expression and tagged template must target:
 *   (a) a name declared in the capture block;
 *   (b) a function or class declared at the top level of the module;
 *   (c) `this.#name`: a private method of the enclosing class, or a private field assigned only in the
 *       constructor or its initializer (or in the one method `rules.attachedIn` names for it);
 *   or, by name, a collaborator's callback in the one method `rules.collaborators` gives it, and
 *   `super(...)` in a class that extends a capture. Anything else is a violation: a member call
 *   (x.push, map.get, promise.then, regex.test, Captured.call), a computed or parenthesized callee, a
 *   parameter or global called, an import called directly. So is every form that calls without a call
 *   expression: for-of and for-in, spread, array destructuring, instanceof, `in` on a property key, an
 *   await whose operand is not `pinned(...)`, `using`, `yield*`, a decorator and `with`.
 */
function checkAllowlist(source: string, rules: AllowlistRules): { violations: Violation[]; captured: string[]; checked: number } {
  const file = ts.createSourceFile("checked.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: Violation[] = [];
  const refuse = (node: ts.Node, why: string): void => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    violations.push({ line, text: node.getText(file).split("\n")[0]!.trim(), why });
  };
  const begin = source.indexOf(CAPTURE_BEGIN);
  const end = source.indexOf(CAPTURE_END);
  if (begin < 0 || end < begin || source.indexOf(CAPTURE_BEGIN, begin + 1) >= 0 || source.indexOf(CAPTURE_END, end + 1) >= 0) {
    return { violations: [{ line: 0, text: "", why: "no single capture block between the two markers" }], captured: [], checked: 0 };
  }
  const inBlock = (node: ts.Node): boolean => node.getStart(file) > begin && node.getEnd() < end;

  const captured = new Set<string>();
  const local = new Set<string>();
  for (const statement of file.statements) {
    if (inBlock(statement)) {
      if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
        refuse(statement, "the capture block holds const declarations only");
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) captured.add(declaration.name.text);
        else refuse(declaration, "a capture binds one name");
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      local.add(statement.name.text);
    }
  }

  // Each class: its private methods, where each private field is assigned, and what it extends.
  interface ClassInfo {
    methods: Set<string>;
    assignedIn: Map<string, Set<string>>;
    heritage: string | null;
  }
  const classes = new Map<ts.Node, ClassInfo>();
  const memberName = (member: ts.ClassElement): string =>
    ts.isConstructorDeclaration(member) ? "constructor" : member.name && (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)) ? member.name.text : "?";
  const isThisPrivate = (node: ts.Node): node is ts.PropertyAccessExpression & { name: ts.PrivateIdentifier } =>
    ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isPrivateIdentifier(node.name);
  for (const statement of file.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const info: ClassInfo = { methods: new Set(), assignedIn: new Map(), heritage: null };
    const extended = statement.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    if (extended && ts.isIdentifier(extended)) info.heritage = extended.text;
    for (const member of statement.members) {
      const name = memberName(member);
      if (ts.isMethodDeclaration(member) && ts.isPrivateIdentifier(member.name)) info.methods.add(member.name.text);
      if (ts.isPropertyDeclaration(member) && ts.isPrivateIdentifier(member.name)) {
        info.assignedIn.set(member.name.text, new Set(member.initializer ? ["constructor"] : []));
      }
      const walk = (node: ts.Node): void => {
        const kind = ts.isBinaryExpression(node) ? node.operatorToken.kind : undefined;
        if (kind !== undefined && kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment) {
          const left = (node as ts.BinaryExpression).left;
          if (isThisPrivate(left)) {
            const sites = info.assignedIn.get(left.name.text) ?? new Set<string>();
            sites.add(name);
            info.assignedIn.set(left.name.text, sites);
          }
        }
        ts.forEachChild(node, walk);
      };
      walk(member);
    }
    classes.set(statement, info);
  }

  const unwrap = (node: ts.Expression): ts.Expression => {
    let target = node;
    while (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target) || ts.isAsExpression(target) || ts.isTypeAssertionExpression(target) || ts.isSatisfiesExpression(target)) {
      target = target.expression;
    }
    return target;
  };
  let checked = 0;
  const checkCallee = (call: ts.Node, callee: ts.Expression, cls: ClassInfo | null, member: string | null): void => {
    checked += 1;
    const target = unwrap(callee);
    if (target.kind === ts.SyntaxKind.SuperKeyword) {
      if (cls?.heritage && captured.has(cls.heritage)) return;
      return refuse(call, "super() of a class that does not extend a capture");
    }
    if (ts.isIdentifier(target)) {
      const name = target.text;
      if (rules.makers.includes(name) && member !== "constructor" && !rules.makerMethods.includes(member ?? "")) {
        return refuse(call, `${name} makes a callable, which only the capture block, a constructor and ${rules.makerMethods.join(", ") || "no method"} may do`);
      }
      if (captured.has(name) || local.has(name)) return;
      if (rules.collaborators[name] !== undefined && rules.collaborators[name] === member) return;
      return refuse(call, "neither a load-time capture nor a function declared in the module");
    }
    if (isThisPrivate(target)) {
      const name = target.name.text;
      if (cls?.methods.has(name)) return;
      const sites = cls?.assignedIn.get(name);
      if (sites && sites.size > 0 && [...sites].every((site) => site === "constructor" || rules.attachedIn[name] === site)) return;
      return refuse(call, "a private field assigned outside the constructor (and its named attach method)");
    }
    return refuse(call, "a member or computed callee, looked up when the call runs");
  };
  const isPinned = (node: ts.Expression): boolean => {
    const target = unwrap(node);
    return ts.isCallExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === "pinned";
  };
  const visit = (node: ts.Node, cls: ClassInfo | null, member: string | null): void => {
    if (inBlock(node)) return;
    if (ts.isImportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isClassDeclaration(node)) cls = classes.get(node) ?? null;
    if (ts.isClassElement(node) && node.parent !== undefined && ts.isClassLike(node.parent)) member = memberName(node);
    if (ts.isCallExpression(node)) checkCallee(node, node.expression, cls, member);
    else if (ts.isNewExpression(node)) {
      checked += 1;
      const target = unwrap(node.expression);
      if (!ts.isIdentifier(target) || !(captured.has(target.text) || local.has(target.text))) refuse(node, "new of neither a capture nor a class declared in the module");
    } else if (ts.isTaggedTemplateExpression(node)) checkCallee(node, node.tag, cls, member);
    else if (ts.isDecorator(node)) refuse(node, "a decorator is a call");
    else if (ts.isForOfStatement(node)) refuse(node, "for-of calls an iterator looked up when it runs");
    else if (ts.isForInStatement(node)) refuse(node, "for-in walks keys a Proxy can trap");
    else if (ts.isSpreadElement(node)) refuse(node, "spread calls an iterator looked up when it runs");
    else if (ts.isSpreadAssignment(node)) refuse(node, "object spread reads through getters and traps");
    else if (ts.isArrayBindingPattern(node)) refuse(node, "array destructuring calls an iterator");
    else if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (kind === ts.SyntaxKind.InstanceOfKeyword) refuse(node, "instanceof calls a Symbol.hasInstance looked up when it runs");
      else if (kind === ts.SyntaxKind.InKeyword && !ts.isPrivateIdentifier(node.left)) refuse(node, "`in` on a property key runs a Proxy trap");
      else if (kind === ts.SyntaxKind.EqualsToken && ts.isArrayLiteralExpression(node.left)) refuse(node, "array destructuring calls an iterator");
    } else if (ts.isAwaitExpression(node)) {
      if (!isPinned(node.expression)) refuse(node, "an await on a promise whose constructor is not pinned looks up then");
    } else if (ts.isYieldExpression(node) && node.asteriskToken) refuse(node, "yield* calls an iterator");
    else if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using) !== 0) refuse(node, "using calls Symbol.dispose");
    else if (ts.isWithStatement(node)) refuse(node, "with looks names up on an object");
    ts.forEachChild(node, (child) => visit(child, cls, member));
  };
  visit(file, null, null);
  return { violations, captured: [...captured], checked };
}

const show = (violations: Violation[]): string[] => violations.map((v) => `line ${v.line}: ${v.text} (${v.why})`);

/**
 * Waits a turn of the event loop, so vitest's runner has chained on the test's promise (its timeout
 * race reads the promise's constructor and calls then) before a test replaces what that uses.
 */
const runnerSettled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What registerStep, addEvent, getEvents and finalizeBundle on one step handed back. */
interface Outcome {
  added: EvidenceEvent;
  listed: EvidenceEvent[];
  bundle: EvidenceBundle;
}

/** registerStep, addEvent, getEvents and finalizeBundle on `stepId`, awaiting only the promises the emitter returns. */
async function callsOnStep(emitter: EvidenceEmitter, stepId: string): Promise<Outcome> {
  emitter.registerStep(JOB, stepId, 0);
  const added = await emitter.addEvent(JOB, stepId, raw("execution_completed", 0, { pages: 3 }));
  const listed = emitter.getEvents(JOB, stepId);
  const bundle = await emitter.finalizeBundle(JOB, stepId);
  return { added, listed, bundle };
}

/**
 * With every replacement undone: the step stores exactly the event added, with `payload`; its hash
 * and the bundle's verify against their content (spec's verifiers); and what the calls handed back
 * were detached copies, so changing them changes nothing stored.
 */
async function expectIntact(emitter: EvidenceEmitter, stepId: string, outcome: Outcome, payload: Record<string, unknown> = { pages: 3, jobId: JOB }): Promise<void> {
  const stored = emitter.getEvents(JOB, stepId);
  expect(stored.map((e) => e.payload), "what the step stores").toEqual([payload]);
  expect(await verifyEventHash(stored[0]!), "the stored event's hash covers its content").toBe(true);
  expect(outcome.added, "what addEvent handed back").toEqual(stored[0]);
  expect(outcome.listed, "what getEvents handed back").toEqual(stored);
  expect(outcome.bundle.events, "the bundle's events").toEqual(stored);
  expect(await verifyBundleHash(outcome.bundle), "the bundle hash covers its events").toBe(true);
  (outcome.added.payload as Record<string, unknown>).pages = 97;
  (outcome.listed[0]!.payload as Record<string, unknown>).pages = 98;
  (outcome.bundle.events[0]!.payload as Record<string, unknown>).pages = 99;
  expect(emitter.getEvents(JOB, stepId), "the step, after the copies were changed").toEqual(stored);
  expect((await emitter.finalizeBundle(JOB, stepId)).bundleHash, "a bundle of the step, signed again").toBe(outcome.bundle.bundleHash);
}

/** A step record of the emitter's shape, whose events array the attacker keeps. */
function attackerHeldRecord(): { record: Record<string, unknown>; events: EvidenceEvent[] } {
  const events: EvidenceEvent[] = [];
  return { record: { jobId: JOB, stepId: "s1", events, assuranceTier: 0, unit: undefined, stored: Promise.resolve(), pending: 0, detached: false }, events };
}

describe("EvidenceEmitter calls only what it captured at load: the closed allowlist (steward #6651, #6668)", () => {
  it("every call in evidence-emitter.ts targets a load-time capture, a function declared there, a private member, or an onBundle callback", () => {
    const source = readFileSync(new URL("../evidence-emitter.ts", import.meta.url), "utf8");
    const { violations, captured, checked } = checkAllowlist(source, EMITTER_RULES);
    expect(show(violations), "calls outside the allowlist").toEqual([]);
    // The checker saw the file: its capture block, and the calls after it.
    expect(captured).toEqual(
      expect.arrayContaining(["MapPrototypeGet", "MapPrototypeSet", "PromiseCtor", "OneShotHash", "Canonicalize", "IdsEvidence", "IdsBundle", "SentryStartSpan", "StructuredClone", "ObjectDefineProperty"]),
    );
    expect(checked, "calls checked").toBeGreaterThan(100);
  });

  it("refuses every other way to call: a member, computed, parameter or global callee, and the forms that call without a call expression (a self-test)", () => {
    const planted = [
      "x.push(1);",
      "arr.map(f);",
      "this.foo();",
      "map.get(k);",
      "promise.then(f);",
      "regex.test(s);",
      "obj.method();",
      "Captured.call(null, x);",
      'obj["method"]();',
      "(0, obj.method)();",
      "f(x);",
      "x?.();",
      "new Map();",
      "String(x);",
      "f`tagged`;",
      "for (const y of xs) Captured(y);",
      "for (const key in obj) Captured(key);",
      "Captured(...xs);",
      "const copy = [...xs];",
      "const merged = { ...obj };",
      "const [first] = xs;",
      "[x] = xs;",
      "x instanceof Y;",
      '"k" in obj;',
      "await promise;",
      "this.#rebound();",
      "uncurryThis(f);",
    ];
    const head = [
      "// -- captured when this module loads --",
      "const Captured = globalThis.structuredClone;",
      "const uncurryThis = Function.prototype.bind.bind(Function.prototype.call);",
      "// -- end of the load-time captures --",
      "function local(): void {}",
      "function pinned<T>(value: T): T { return value; }",
      "class Local {}",
      "export class Probe {",
      "  #field = Captured;",
      "  #rebound: () => void = local;",
      "  #method(): void {}",
      "  rebind(): void { this.#rebound = local; }",
      "  async probe(x: any, arr: any[], f: any, map: Map<unknown, unknown>, k: unknown, promise: Promise<unknown>, regex: RegExp, s: string, obj: any, xs: any[], Y: any): Promise<void> {",
      "    Captured(x); local(); this.#field(x); this.#method(); new Local(); await pinned(promise); if (#field in obj) local();",
    ];
    const source = [...head, ...planted.map((line) => `    ${line}`), "  }", "}"].join("\n");
    const { violations } = checkAllowlist(source, { attachedIn: {}, collaborators: {}, makers: ["uncurryThis"], makerMethods: [] });
    // Exactly one violation per planted line, at that line, naming what it found there; none for the allowed calls above.
    expect(show(violations).map((v) => v.split(":")[0])).toEqual(planted.map((_, i) => `line ${head.length + 1 + i}`));
    for (let i = 0; i < planted.length; i++) expect(planted[i], show(violations)[i]).toContain(violations[i]!.text);
  });

  it("hashes byte for byte as @pcc/spec's hashEvent and hashBundle do (globals untouched)", async () => {
    const emitter = new EvidenceEmitter(KERNEL, async (data) => ({ signer: `0x${"11".repeat(20)}`, algorithm: "secp256k1", value: `sig_${data.slice(0, 16)}` }) as Signature);
    emitter.registerStep(JOB, "s1", 0);
    const payloads: Array<Record<string, unknown>> = [
      { pages: 3 },
      {},
      { text: "café \u{1F600} 中", lone: "\ud800 and \udfff", escaped: 'quote " backslash \\ newline \n tab \t nul \u0000' },
      { keys: { b: 1, a: 2, B: 3, _: 4, "é": 5, "\u{1F600}": 6, "": 7, "10": 8, "9": 9 } },
      { numbers: [0.5, 1e-300, -0, 2 ** 53 - 1, -(2 ** 53 - 1), -1e-7, 123.456], flags: [true, false, null] },
      { nested: { deep: [[[1]], { x: null, y: [] }] } },
    ];
    const added: EvidenceEvent[] = [];
    for (let i = 0; i < payloads.length; i++) added.push(await emitter.addEvent(JOB, "s1", raw("execution_progress", i, payloads[i])));
    for (const event of added) {
      expect(event.hash, event.timestamp).toBe(await hashEvent({ type: event.type, timestamp: event.timestamp, source: event.source, payload: event.payload }));
    }
    const bundle = await emitter.finalizeBundle(JOB, "s1");
    expect(bundle.bundleHash).toBe(await hashBundle(bundle.events));
    // The bundle hash sorts the event hashes, which these events do not store in sorted order.
    const hashes = bundle.events.map((e) => e.hash);
    expect([...hashes].sort()).not.toEqual(hashes);
  });

  it("Map.prototype.get, set, delete and size replaced after load are never called: no attacker-held record or array is handed an event (steward #6668)", async () => {
    await runnerSettled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    const real = { get: Map.prototype.get, set: Map.prototype.set, delete: Map.prototype.delete, size: Object.getOwnPropertyDescriptor(Map.prototype, "size")! };
    const ours = (key: unknown): boolean => key === JOB || key === "s1" || key === "s2";
    // astra's push recipe, a level up: a get that hands the store a step record whose events array the attacker keeps.
    const attacker = attackerHeldRecord();
    const attackerSteps = new Map<unknown, unknown>([["s1", attacker.record]]);
    const handed: unknown[] = [];
    let calls = 0;
    let outcome: Outcome | undefined;
    try {
      Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
        if (ours(key)) calls++;
        return key === JOB ? attackerSteps : key === "s1" ? attacker.record : real.get.call(this, key);
      };
      Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
        if (ours(key)) {
          calls++;
          handed.push(value);
        }
        return real.set.call(this, key, value);
      };
      Map.prototype.delete = function (this: Map<unknown, unknown>, key: unknown) {
        if (!ours(key)) return real.delete.call(this, key);
        calls++;
        return false;
      };
      // A size that says a job's map is empty when it is not: cleaning up one step would drop the job's others.
      Object.defineProperty(Map.prototype, "size", {
        configurable: true,
        get(this: Map<unknown, unknown>) {
          if (real.get.call(this, "s1") === undefined && real.get.call(this, JOB) === undefined) return real.size.get!.call(this);
          calls++;
          return 0;
        },
      });
      outcome = await callsOnStep(emitter, "s1");
      emitter.registerStep(JOB, "s2", 0);
      emitter.cleanup(JOB, "s2");
    } finally {
      Map.prototype.get = real.get;
      Map.prototype.set = real.set;
      Map.prototype.delete = real.delete;
      Object.defineProperty(Map.prototype, "size", real.size);
    }
    expect(calls, "calls of the replaced get, set, delete and size").toBe(0);
    expect(types(emitter, "s2"), "the step cleaned up").toEqual([]);
    expect(attacker.events, "events handed to the attacker's array").toEqual([]);
    expect(handed, "records handed to the replaced set").toEqual([]);
    await expectIntact(emitter, "s1", outcome!);
  });

  it("Promise.prototype.then, .constructor and Promise[Symbol.species] replaced after load are never consulted: every await is on a promise with its own constructor (steward #6668)", async () => {
    await runnerSettled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    const realThen = Promise.prototype.then;
    const constructorDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, "constructor")!;
    const speciesDescriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species)!;
    const consulted: string[] = [];
    const handed: unknown[] = [];
    // What a then given the chance would do: keep what it is handed, change it, and pass on a forged hash.
    const tamper = (value: unknown): unknown => {
      handed.push(value);
      if (typeof value === "object" && value !== null && "payload" in value) (value as { payload: Record<string, unknown> }).payload.pages = 66;
      return typeof value === "string" && value.startsWith("sha256:") ? `sha256:${"0".repeat(64)}` : value;
    };
    let outcome: Outcome | undefined;
    try {
      Promise.prototype.then = function (this: Promise<unknown>, onFulfilled?: ((value: unknown) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) {
        consulted.push("then");
        return realThen.call(this, (value: unknown) => (onFulfilled ? onFulfilled(tamper(value)) : tamper(value)), onRejected);
      } as typeof Promise.prototype.then;
      // An await on a promise without its own constructor reads this one, finds it is not Promise, and calls then.
      Object.defineProperty(Promise.prototype, "constructor", { configurable: true, get: () => (consulted.push("constructor"), Object) });
      Object.defineProperty(Promise, Symbol.species, { configurable: true, get: () => (consulted.push("species"), Promise) });
      // Inline, not callsOnStep: an async helper's own promise would be awaited here, and read the replaced constructor.
      emitter.registerStep(JOB, "s1", 0);
      const added = await emitter.addEvent(JOB, "s1", raw("execution_completed", 0, { pages: 3 }));
      const listed = emitter.getEvents(JOB, "s1");
      const bundle = await emitter.finalizeBundle(JOB, "s1");
      outcome = { added, listed, bundle };
    } finally {
      Promise.prototype.then = realThen;
      Object.defineProperty(Promise.prototype, "constructor", constructorDescriptor);
      Object.defineProperty(Promise, Symbol.species, speciesDescriptor);
    }
    expect(consulted, "what was consulted on Promise").toEqual([]);
    expect(handed, "values a then was handed").toEqual([]);
    await expectIntact(emitter, "s1", outcome!);
  });

  it("crypto.subtle.digest, node:crypto's hash and createHash, a planted Hash handle and TextEncoder, replaced after load, change no hash: the digest is the one-shot hash captured at load (steward #6668)", async () => {
    await runnerSettled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    const nodeCrypto = createRequire(import.meta.url)("node:crypto") as typeof import("node:crypto");
    const saved = { hash: nodeCrypto.hash, createHash: nodeCrypto.createHash, TextEncoder: globalThis.TextEncoder };
    const probe = nodeCrypto.createHash("sha256");
    const hashPrototype = Object.getPrototypeOf(probe) as object;
    // createHash's wrapper reads its native handle through this symbol: an accessor planted for it forges
    // the digest even when update and digest were captured, which is why the emitter uses the one-shot hash.
    const kHandle = Object.getOwnPropertySymbols(probe).find((symbol) => symbol.description === "kHandle");
    expect(kHandle, "node:crypto's Hash keeps its handle under Symbol(kHandle)").toBeDefined();
    const forged = "0".repeat(64);
    let calls = 0;
    let outcome: Outcome | undefined;
    const digests = hostileDigests();
    try {
      nodeCrypto.hash = ((..._args: unknown[]) => (calls++, forged)) as typeof nodeCrypto.hash;
      nodeCrypto.createHash = ((..._args: unknown[]) => (calls++, { update: () => undefined, digest: () => forged })) as unknown as typeof nodeCrypto.createHash;
      syncBuiltinESMExports();
      Object.defineProperty(hashPrototype, kHandle!, { configurable: true, get: () => (calls++, { update: () => true, digest: () => forged }), set: () => {} });
      globalThis.TextEncoder = class {
        encode(): Uint8Array {
          calls++;
          return new Uint8Array(0);
        }
      } as unknown as typeof TextEncoder;
      outcome = await callsOnStep(emitter, "s1");
    } finally {
      nodeCrypto.hash = saved.hash;
      nodeCrypto.createHash = saved.createHash;
      syncBuiltinESMExports();
      delete (hashPrototype as Record<symbol, unknown>)[kHandle!];
      globalThis.TextEncoder = saved.TextEncoder;
      digests.restore();
    }
    expect(calls, "calls of a replaced digest").toBe(0);
    expect(digests.requested, "digests asked of crypto.subtle").toEqual([]);
    await expectIntact(emitter, "s1", outcome!);
  });

  it("RegExp.prototype.test and exec replaced after load decide nothing: a unit field is checked character by character (steward #6668)", async () => {
    await runnerSettled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    const real = { test: RegExp.prototype.test, exec: RegExp.prototype.exec };
    const unit = { settlementUnitId: `0x${"ab".repeat(32)}`, challengeNonce: `0x${"cd".repeat(32)}` };
    const malformed = [
      { ...unit, settlementUnitId: `0x${"AB".repeat(32)}` },
      { ...unit, challengeNonce: "nonce" },
      { ...unit, settlementUnitId: `${unit.settlementUnitId}\n` },
    ];
    const refusals: string[] = [];
    let calls = 0;
    let outcome: Outcome | undefined;
    try {
      // Every pattern matches: a malformed unit would pass a RegExp check.
      RegExp.prototype.test = () => (calls++, true);
      RegExp.prototype.exec = () => (calls++, [""] as unknown as RegExpExecArray);
      for (const bad of malformed) {
        try {
          emitter.registerStep(JOB, "bad", 0, bad);
        } catch (err) {
          refusals.push((err as Error).message);
        }
      }
      // No pattern matches: a well-formed unit would fail a RegExp check.
      RegExp.prototype.test = () => (calls++, false);
      RegExp.prototype.exec = () => (calls++, null);
      emitter.registerStep(JOB, "s1", 0, unit);
      const added = await emitter.addEvent(JOB, "s1", raw("execution_completed", 0, { pages: 3 }));
      const listed = emitter.getEvents(JOB, "s1");
      const bundle = await emitter.finalizeBundle(JOB, "s1");
      outcome = { added, listed, bundle };
    } finally {
      RegExp.prototype.test = real.test;
      RegExp.prototype.exec = real.exec;
    }
    expect(calls, "calls of the replaced test and exec").toBe(0);
    expect(refusals).toEqual(malformed.map(() => "registerStep: settlementUnitId and challengeNonce must be 0x + 64 lowercase hex"));
    await expectIntact(emitter, "s1", outcome!, { pages: 3, jobId: JOB, ...unit });
  });

  it("@pcc/spec's ids functions replaced after load are never called: ids come from the functions captured at load", async () => {
    await runnerSettled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    const mutable = ids as unknown as Record<"evidence" | "bundle", () => string>;
    const saved = { evidence: mutable.evidence, bundle: mutable.bundle };
    let calls = 0;
    let outcome: Outcome | undefined;
    try {
      mutable.evidence = () => (calls++, "ev_forged");
      mutable.bundle = () => (calls++, "bun_forged");
      outcome = await callsOnStep(emitter, "s1");
    } finally {
      mutable.evidence = saved.evidence;
      mutable.bundle = saved.bundle;
    }
    expect(calls, "calls of the replaced id functions").toBe(0);
    expect(outcome!.added.id).toMatch(/^ev_[0-9a-z]+$/);
    expect(outcome!.added.id).not.toBe("ev_forged");
    expect(outcome!.bundle.id).toMatch(/^bun_[0-9a-z]+$/);
    expect(outcome!.bundle.id).not.toBe("bun_forged");
    await expectIntact(emitter, "s1", outcome!);
  });

  it("Sentry.startSpan replaced after load, and a storage service's methods replaced after it is attached, are never called: the archive runs through what was captured (steward #6668)", async () => {
    await runnerSettled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter(KERNEL);
    const archived: EvidenceBundle[] = [];
    const service = {
      isReady: (): boolean => true,
      archiveBundle: async (bundle: EvidenceBundle) => {
        archived.push(bundle);
        return { cid: "bafy-bundle", metadataCid: "bafy-meta" };
      },
    };
    emitter.setStorageService(service as never);
    const sentry = SentryModule as unknown as { startSpan: (options: unknown, callback: () => unknown) => unknown };
    const savedStartSpan = sentry.startSpan;
    let calls = 0;
    let outcome: Outcome | undefined;
    try {
      sentry.startSpan = () => (calls++, Promise.resolve({ cid: "bafy-forged", metadataCid: "bafy-forged" }));
      service.isReady = () => (calls++, false);
      service.archiveBundle = async () => (calls++, { cid: "bafy-forged", metadataCid: "bafy-forged" });
      outcome = await callsOnStep(emitter, "s1");
    } finally {
      sentry.startSpan = savedStartSpan;
    }
    expect(calls, "calls of the replaced startSpan, isReady and archiveBundle").toBe(0);
    expect(emitter.getLastIpfsResult()).toEqual({ cid: "bafy-bundle", metadataCid: "bafy-meta" });
    expect(archived.map((bundle) => bundle.id), "bundles archived").toEqual([outcome!.bundle.id]);
    expect(emitter.getStorageService()).toBe(service);
    await expectIntact(emitter, "s1", outcome!);
  });

  it("Error, Error[Symbol.hasInstance], WeakSet, Date, String.prototype.slice, console.warn and Function.prototype.bind replaced after load change nothing the emitter reports, signs with or attaches", async () => {
    await runnerSettled();
    const warned: unknown[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warned.push(args[0]));
    // The test-only signer warns through the console.warn the emitter was built with.
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 0);
    const archived: EvidenceBundle[] = [];
    const service = {
      isReady: (): boolean => true,
      archiveBundle: async (bundle: EvidenceBundle) => {
        archived.push(bundle);
        return { cid: "bafy-bundle", metadataCid: "bafy-meta" };
      },
    };
    const RealError = globalThis.Error;
    const RealDate = globalThis.Date;
    const saved = { add: WeakSet.prototype.add, has: WeakSet.prototype.has, toISOString: RealDate.prototype.toISOString, slice: String.prototype.slice, warn: console.warn, bind: Function.prototype.bind };
    let calls = 0;
    let refusal: unknown;
    let outcome: Outcome | undefined;
    try {
      globalThis.Error = class extends RealError {
        constructor(message?: string) {
          calls++;
          super(`forged: ${message}`);
        }
      } as ErrorConstructor;
      // instanceof EvidenceInputError would look this up on Error, through the class's prototype chain.
      Object.defineProperty(RealError, Symbol.hasInstance, { configurable: true, value: () => (calls++, false) });
      WeakSet.prototype.add = function (this: WeakSet<object>) {
        calls++;
        return this;
      };
      WeakSet.prototype.has = () => (calls++, false);
      // It keeps a working now(): spec's id functions look Date.now up when they run (a named residual).
      globalThis.Date = class {
        static now = (): number => RealDate.now();
        constructor() {
          calls++;
        }
      } as unknown as DateConstructor;
      RealDate.prototype.toISOString = () => (calls++, "forged");
      String.prototype.slice = () => (calls++, "forged");
      console.warn = () => void calls++;
      Function.prototype.bind = function () {
        calls++;
        return () => false;
      } as typeof Function.prototype.bind;
      emitter.setStorageService(service as never);
      Function.prototype.bind = saved.bind;
      try {
        await emitter.addEvent(JOB, "s1", raw("execution_progress", 0, { at: new RealDate(0) }));
      } catch (err) {
        refusal = err;
      }
      const added = await emitter.addEvent(JOB, "s1", raw("execution_completed", 0, { pages: 3 }));
      const listed = emitter.getEvents(JOB, "s1");
      const bundle = await emitter.finalizeBundle(JOB, "s1");
      outcome = { added, listed, bundle };
    } finally {
      globalThis.Error = RealError;
      delete (RealError as unknown as Record<symbol, unknown>)[Symbol.hasInstance];
      WeakSet.prototype.add = saved.add;
      WeakSet.prototype.has = saved.has;
      globalThis.Date = RealDate;
      RealDate.prototype.toISOString = saved.toISOString;
      String.prototype.slice = saved.slice;
      console.warn = saved.warn;
      Function.prototype.bind = saved.bind;
    }
    expect(calls, "calls of what was replaced").toBe(0);
    // The input check's refusal, told apart without instanceof, reported with the Error captured at load.
    expect(Object.getPrototypeOf(refusal)).toBe(RealError.prototype);
    expect((refusal as Error).message).toBe("event.payload.at is not a plain object: evidence must be plain JSON data, which its hash commits to faithfully");
    const bundle = outcome!.bundle;
    expect(bundle.kernelSignature.value).toBe(`test_sig_${bundle.bundleHash.slice(0, 16)}`);
    expect(new Date(bundle.createdAt).toISOString()).toBe(bundle.createdAt);
    expect(warned).toEqual([expect.stringContaining("Using test-only signing key")]);
    expect(archived.map((b) => b.id), "bundles archived").toEqual([bundle.id]);
    expect(emitter.getLastIpfsResult()).toEqual({ cid: "bafy-bundle", metadataCid: "bafy-meta" });
    await expectIntact(emitter, "s1", outcome!);
  });

  it("checkTierRequirements answers the same with Array.prototype methods, Set, Object.prototype.hasOwnProperty and spec's exported arrays changed after load", async () => {
    await runnerSettled();
    const emitter = new EvidenceEmitter(KERNEL);
    const event = (type: string, payload: Record<string, unknown> = {}) => ({ id: `ev_${type}`, hash: `sha256:${"a".repeat(64)}`, type, timestamp: "2026-10-04T00:00:00.000Z", source, payload }) as unknown as EvidenceEvent;
    const events = [event("gcode_hash_verified"), event("execution_completed"), event("power_profile_summary"), event("execution_progress", { mock: true })];
    const custom = [{ tier: 1, requiredEventTypes: [["a", "b"], ["gcode_hash_verified"]], minimumEvents: 1, description: "custom" }] as never;
    // Non-camera events only: spec's kernelPullCaptureIssue looks its intrinsics up when it runs (a named residual).
    const ask = () => [
      emitter.checkTierRequirements(events, 1),
      emitter.checkTierRequirements(events, 2),
      emitter.checkTierRequirements(events, 7 as never),
      emitter.checkTierRequirements(events, 1, custom),
    ];
    const clean = ask();
    const methods = ["map", "filter", "flatMap", "some", "includes", "join", "find", "push", "indexOf"] as const;
    const array = Array.prototype as unknown as Record<string, unknown>;
    const savedMethods = methods.map((name) => array[name]);
    const savedIterator = Array.prototype[Symbol.iterator];
    const savedSet = globalThis.Set;
    const savedHasOwn = Object.prototype.hasOwnProperty;
    const savedTypes = [...KERNEL_PULL_CAPTURE_TYPES];
    const tierTwo = DEFAULT_TIER_REQUIREMENTS[2]!;
    const savedTierTwo = { requiredEventTypes: tierTwo.requiredEventTypes, minimumEvents: tierTwo.minimumEvents };
    let calls = 0;
    let hostile: unknown;
    try {
      for (let i = 0; i < methods.length; i++) array[methods[i]!] = () => (calls++, i % 2 === 0 ? [] : true);
      Array.prototype[Symbol.iterator] = function* () {
        calls++;
      } as unknown as typeof Array.prototype[typeof Symbol.iterator];
      globalThis.Set = class {
        constructor() {
          calls++;
        }
        has(): boolean {
          calls++;
          return true;
        }
      } as unknown as SetConstructor;
      Object.prototype.hasOwnProperty = () => (calls++, false);
      // spec's arrays are mutable: a power summary now reads as a camera type, and tier 2, which
      // these events do not meet, asks for nothing.
      (KERNEL_PULL_CAPTURE_TYPES as unknown as string[])[2] = "power_profile_summary";
      tierTwo.requiredEventTypes = [];
      tierTwo.minimumEvents = 0;
      hostile = ask();
    } finally {
      for (let i = 0; i < methods.length; i++) array[methods[i]!] = savedMethods[i];
      Array.prototype[Symbol.iterator] = savedIterator;
      globalThis.Set = savedSet;
      Object.prototype.hasOwnProperty = savedHasOwn;
      (KERNEL_PULL_CAPTURE_TYPES as unknown as string[]).length = savedTypes.length;
      tierTwo.requiredEventTypes = savedTierTwo.requiredEventTypes;
      tierTwo.minimumEvents = savedTierTwo.minimumEvents;
    }
    expect(calls, "calls of what was replaced").toBe(0);
    expect(hostile).toEqual(clean);
    expect(clean.map((answer) => answer.met)).toEqual([true, false, false, false]);
    expect(clean[3]!.missing).toEqual(["Missing one of: a | b"]);
  });

  it("an Object.prototype simulated or mock written after load changes nothing checkTierRequirements counts, and no getter runs; an accessor flag fails closed", () => {
    const emitter = new EvidenceEmitter(KERNEL);
    const event = (type: string, payload: Record<string, unknown> = {}) => ({ id: `ev_${type}`, hash: `sha256:${"a".repeat(64)}`, type, timestamp: "2026-10-04T00:00:00.000Z", source: { ...source }, payload }) as unknown as EvidenceEvent;
    const events = [event("gcode_hash_verified"), event("execution_completed"), event("power_profile_summary")];
    const clean = emitter.checkTierRequirements(events, 1);
    let mocked: unknown;
    let getterRuns = 0;
    let withGetter: unknown;
    try {
      Object.defineProperty(Object.prototype, "mock", { value: true, writable: true, configurable: true, enumerable: false });
      mocked = emitter.checkTierRequirements(events, 1);
    } finally {
      delete (Object.prototype as { mock?: unknown }).mock;
    }
    try {
      Object.defineProperty(Object.prototype, "simulated", { configurable: true, enumerable: false, get: () => (getterRuns++, true) });
      withGetter = emitter.checkTierRequirements(events, 1);
    } finally {
      delete (Object.prototype as { simulated?: unknown }).simulated;
    }
    expect(clean.met).toBe(true);
    expect(mocked).toEqual(clean);
    expect(withGetter).toEqual(clean);
    expect(getterRuns, "getters run on Object.prototype.simulated").toBe(0);
    // An event's own mock flag behind a getter is not data: the event is taken as fabricated, and the getter never runs.
    let ownGetterRuns = 0;
    const accessorMock = event("execution_completed", {});
    Object.defineProperty(accessorMock.payload, "mock", { enumerable: true, get: () => (ownGetterRuns++, false) });
    const answer = emitter.checkTierRequirements([events[0]!, accessorMock, events[2]!], 1);
    expect(answer.met).toBe(false);
    expect(ownGetterRuns).toBe(0);
  });

  it("a hole in a custom requirements list is skipped, as Array.prototype.find skipped it (astra pack 299 MEDIUM)", () => {
    const emitter = new EvidenceEmitter(KERNEL);
    const events = [{ id: "ev_g", hash: `sha256:${"a".repeat(64)}`, type: "gcode_hash_verified", timestamp: "2026-10-04T00:00:00.000Z", source, payload: {} }] as unknown as EvidenceEvent[];
    // Index 0 is a hole; the requirement for tier 1 is at index 1.
    const requirements = [] as unknown[];
    requirements.length = 2;
    requirements[1] = { tier: 1, requiredEventTypes: [["gcode_hash_verified"]], minimumEvents: 1, description: "custom" };
    expect(emitter.checkTierRequirements(events, 1, requirements as never)).toEqual({ met: true, missing: [] });
  });

  it("properties an adapter writes on the emitter change nothing: its state, signer and collaborators are JS private fields (steward #6668)", async () => {
    const signature = { signer: `0x${"11".repeat(20)}`, algorithm: "secp256k1", value: "sig_real" } as Signature;
    const emitter = new EvidenceEmitter(KERNEL, async () => signature);
    const attacker = attackerHeldRecord();
    let calls = 0;
    // The names these had before they were private, as an adapter holding the emitter would write them.
    Object.assign(emitter, {
      kernelId: "kernel-forged",
      stepEvidence: new Map([[JOB, new Map([["s1", attacker.record]])]]),
      step: () => (calls++, attacker.record),
      signFn: async () => (calls++, { ...signature, value: "sig_forged" }),
      _hasRealSignFn: false,
      bundleListeners: [() => void calls++],
      storageService: { isReady: () => (calls++, true), archiveBundle: async () => (calls++, { cid: "bafy-forged", metadataCid: "bafy-forged" }) },
      lastIpfsResult: { cid: "bafy-forged", metadataCid: "bafy-forged" },
    });
    const outcome = await callsOnStep(emitter, "s1");
    expect(calls, "calls of what the adapter wrote").toBe(0);
    expect(attacker.events, "events handed to the attacker's array").toEqual([]);
    expect(outcome.bundle.kernelSignature).toEqual(signature);
    expect(outcome.bundle.kernelId).toBe(KERNEL);
    expect("_testSigned" in outcome.bundle).toBe(false);
    expect(emitter.isTestSigner()).toBe(false);
    expect(emitter.getLastIpfsResult()).toBeUndefined();
    await expectIntact(emitter, "s1", outcome);
  });

  // The residual, named: a promise that fulfils with an object reads that object's `then`. A then planted on
  // Object.prototype is therefore handed what callers receive and what a collaborator resolves with, and can
  // change it; it is never handed what the step stores, and the chain's links fulfil with undefined.
  it("an Object.prototype.then planted after load is handed only what callers and the signer resolve with: what is stored and hashed stays intact", async () => {
    await runnerSettled();
    const signature = { signer: `0x${"11".repeat(20)}`, algorithm: "secp256k1", value: "sig_real" } as Signature;
    const emitter = new EvidenceEmitter(KERNEL, async () => signature);
    emitter.registerStep(JOB, "s1", 0);
    const handed: unknown[] = [];
    const received: unknown[] = [];
    try {
      Object.defineProperty(Object.prototype, "then", {
        configurable: true,
        writable: true,
        value(this: { payload?: Record<string, unknown> }, resolve: (value: unknown) => void) {
          handed.push(this);
          if (this.payload) this.payload.pages = 66;
          resolve("forged");
        },
      });
      received.push(await emitter.addEvent(JOB, "s1", raw("execution_completed", 0, { pages: 3 })));
      received.push(emitter.getEvents(JOB, "s1"));
      received.push(await emitter.finalizeBundle(JOB, "s1"));
    } finally {
      delete (Object.prototype as { then?: unknown }).then;
    }
    // What it was handed: addEvent's copy for its caller, the signer's signature, and finalizeBundle's bundle.
    expect(handed).toHaveLength(3);
    expect(handed[0]).toMatchObject({ type: "execution_completed", payload: { pages: 66, jobId: JOB } });
    expect(handed[1]).toBe(signature);
    expect(handed[2]).toMatchObject({ jobId: JOB, stepId: "s1", kernelId: KERNEL });
    // So the callers were handed what it chose, and the bundle carries the signature it chose.
    expect([received[0], received[2]]).toEqual(["forged", "forged"]);
    expect((handed[2] as EvidenceBundle).kernelSignature).toBe("forged");
    // What the step stores, and every hash, is untouched.
    const stored = emitter.getEvents(JOB, "s1");
    expect(stored.map((e) => e.payload)).toEqual([{ pages: 3, jobId: JOB }]);
    expect(received[1]).toEqual(stored);
    expect(await verifyEventHash(stored[0]!)).toBe(true);
    expect(await verifyBundleHash(handed[2] as EvidenceBundle), "the bundle it was handed still matches its hash").toBe(true);
    const again = await emitter.finalizeBundle(JOB, "s1");
    expect(again.kernelSignature).toEqual(signature);
    expect(again.bundleHash).toBe((handed[2] as EvidenceBundle).bundleHash);
  });
});
