import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_EVENT_TYPES,
  hashEvent,
  hashKernelWrittenEvent,
  verifyEventHash,
  type EvidenceEvent,
  type EvidenceSource,
  type SHA256,
} from "@pcc/spec";
import { EvidenceEmitter } from "../evidence-emitter.js";

type RawEvent = Omit<EvidenceEvent, "id" | "hash">;

interface WriterVector {
  id: string;
  eventHashVersion: number;
  event: EvidenceEvent;
  verified: boolean;
}

interface WriterVectors {
  contract: string;
  events: WriterVector[];
  invalidWriters: WriterVector[];
}

const vectorBytes = readFileSync(
  new URL("../../../spec/src/evidence/vectors/event-hash-writer.v2.json", import.meta.url),
);
const vectors = JSON.parse(vectorBytes.toString("utf8")) as WriterVectors;
const JOB = "job_writer_vector";
const STEP = "s";
const KERNEL = "kernel_writer_vector";
const H = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" as SHA256;

function vector(id: string): WriterVector {
  const found = [...vectors.events, ...vectors.invalidWriters].find((v) => v.id === id);
  if (found === undefined) throw new Error(`missing writer vector ${id}`);
  return found;
}

function withoutIdentity(event: EvidenceEvent): RawEvent {
  const { id: _id, hash: _hash, ...raw } = structuredClone(event);
  return raw;
}

function source(): EvidenceSource {
  return { deviceId: "dev_writer_vector", deviceType: "controller", kernelId: KERNEL };
}

function raw(
  type: EvidenceEvent["type"],
  payload: Record<string, unknown> = {},
  eventSource: EvidenceSource = source(),
): RawEvent {
  return {
    type,
    timestamp: "2026-10-16T08:00:00.000Z",
    source: eventSource,
    payload: { jobId: JOB, ...payload },
  };
}

function setup() {
  const emitter = new EvidenceEmitter(KERNEL);
  emitter.registerStep(JOB, STEP, 0);
  return emitter;
}

describe("writer hash vectors and evidence authoring", () => {
  it("V0 pins the exact writer-v2 vector file SHA-256", () => {
    expect(vectors.contract).toBe("pcc.evidence.event-hash-writer.v2");
    expect(createHash("sha256").update(vectorBytes).digest("hex")).toBe(
      "ba18aaa1d21c605b4c26596bd45f4e544fb04dbe5567b590102627f0577980c2",
    );
    expect(vectors.events.map((v) => v.id)).toEqual([
      "unmarked-v1", "kernel-written-v2", "old-kernel-forgery",
    ]);
    expect(vectors.invalidWriters.map((v) => v.id)).toEqual([
      "adapter-writer", "boolean-writer",
    ]);
  });

  it("V1 authors the marked vector under event hash v2", async () => {
    const emitter = setup();
    const expected = vector("kernel-written-v2").event;
    const event = withoutIdentity(expected);
    delete event.source.writer;

    const stored = await emitter.addKernelWrittenEvent(JOB, STEP, event);

    expect(stored.hash).toBe("sha256:13cc420311545cefaa5434d4633a4d083e9e1f82b30b02cb25d5476a6d8aa291");
    expect(stored.hash).toBe(expected.hash);
    expect(stored.source).toStrictEqual(expected.source);
    expect(await verifyEventHash(stored)).toBe(true);
  });

  it("V2 refuses the old kernel's v1-hashed marker as an adapter event", async () => {
    const emitter = setup();
    await expect(
      emitter.addEvent(JOB, STEP, withoutIdentity(vector("old-kernel-forgery").event)),
    ).rejects.toThrow("source.writer is reserved for kernel-written events");
  });

  it("V3 refuses an unmarked input proof before it takes a place", async () => {
    const emitter = setup();
    await expect(
      emitter.addEvent(JOB, STEP, withoutIdentity(vector("unmarked-v1").event)),
    ).rejects.toThrow("a method_loaded carrying inputHash must be kernel-written");
    const stored = await emitter.addEvent(JOB, STEP, raw("execution_completed"));
    expect((await emitter.finalizeBundle(JOB, STEP)).events).toEqual([stored]);
  });

  it("EW1 stamps a fresh source, uses v2, and rejects its own marked bytes through hashEvent", async () => {
    const emitter = setup();
    const inputSource = source();
    const stored = await emitter.addKernelWrittenEvent(
      JOB, STEP, raw("method_loaded", { deviceJobId: "device_job_writer_vector", inputHash: H }, inputSource),
    );

    expect(Object.hasOwn(inputSource, "writer")).toBe(false);
    expect(stored.source).not.toBe(inputSource);
    expect(Object.getOwnPropertyDescriptor(stored.source, "writer")).toStrictEqual({
      value: "kernel",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(stored.hash).toBe(await hashKernelWrittenEvent(withoutIdentity(stored)));
    expect(await verifyEventHash(stored)).toBe(true);
    await expect(hashEvent(withoutIdentity(stored))).rejects.toThrow(
      "source.writer is reserved for kernel-written events",
    );
  });

  it("EW2 overrides a supplied adapter writer rather than spreading it over the kernel marker", async () => {
    const emitter = setup();
    const inputSource = {
      ...source(), writer: "adapter",
    } as unknown as EvidenceSource;

    const stored = await emitter.addKernelWrittenEvent(
      JOB, STEP, raw("method_loaded", { deviceJobId: "dj", inputHash: H }, inputSource),
    );

    expect((inputSource as unknown as { writer: string }).writer).toBe("adapter");
    expect(stored.source.writer).toBe("kernel");
    expect(await verifyEventHash(stored)).toBe(true);
  });

  it.each(EVIDENCE_EVENT_TYPES.filter((type) => type !== "method_loaded"))(
    "EW3 rejects kernel-written type %s",
    async (type) => {
      const emitter = setup();
      await expect(
        emitter.addKernelWrittenEvent(JOB, STEP, raw(type)),
      ).rejects.toThrow("only method_loaded may be kernel-written");
      expect(emitter.getEvents(JOB, STEP)).toEqual([]);
    },
  );

  it("EW4 an E1 refusal takes no place and does not prevent finalization", async () => {
    const emitter = setup();
    await expect(
      emitter.addKernelWrittenEvent(JOB, STEP, raw("execution_progress")),
    ).rejects.toThrow("only method_loaded may be kernel-written");

    const completion = await emitter.addEvent(JOB, STEP, raw("execution_completed"));
    const bundle = await emitter.finalizeBundle(JOB, STEP);
    expect(bundle.events).toHaveLength(1);
    expect(bundle.events[0]).toStrictEqual(completion);
    expect(await verifyEventHash(bundle.events[0]!)).toBe(true);
  });

  const ownWriters: Array<{
    name: string;
    install: (src: EvidenceSource) => void;
  }> = [
    { name: "kernel", install: (src) => { Object.defineProperty(src, "writer", { value: "kernel", enumerable: true, configurable: true }); } },
    { name: "adapter", install: (src) => { Object.defineProperty(src, "writer", { value: "adapter", enumerable: true, configurable: true }); } },
    { name: "boolean", install: (src) => { Object.defineProperty(src, "writer", { value: true, enumerable: true, configurable: true }); } },
    { name: "undefined", install: (src) => { Object.defineProperty(src, "writer", { value: undefined, enumerable: true, configurable: true }); } },
    { name: "accessor", install: (src) => { Object.defineProperty(src, "writer", { get: () => "kernel", enumerable: true, configurable: true }); } },
    { name: "non-enumerable", install: (src) => { Object.defineProperty(src, "writer", { value: "kernel", enumerable: false, configurable: true }); } },
  ];

  it.each(ownWriters)("EW5 addEvent refuses own writer $name and latches the lost hash", async ({ install }) => {
    const emitter = setup();
    const inputSource = source();
    install(inputSource);

    await expect(
      emitter.addEvent(JOB, STEP, raw("execution_completed", {}, inputSource)),
    ).rejects.toThrow("source.writer is reserved for kernel-written events");
    await expect(emitter.finalizeBundle(JOB, STEP)).rejects.toThrow(
      /could not be stored.*source\.writer is reserved for kernel-written events/,
    );
  });

  it.each([
    ["matching", H],
    ["different", `sha256:${"ab".repeat(32)}`],
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["number", 7],
  ])("EW6 an own inputHash of %s is rejected before taking a place", async (_name, inputHash) => {
    const emitter = setup();
    await expect(
      emitter.addEvent(JOB, STEP, raw("method_loaded", { inputHash })),
    ).rejects.toThrow("a method_loaded carrying inputHash must be kernel-written");

    const completion = await emitter.addEvent(JOB, STEP, raw("execution_completed"));
    const bundle = await emitter.finalizeBundle(JOB, STEP);
    expect(bundle.events).toHaveLength(1);
    expect(bundle.events[0]).toStrictEqual(completion);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("EW6b an input proof whose source is %s is refused with E2 before taking a place", async (_name, eventSource) => {
    const emitter = setup();
    const event = { ...raw("method_loaded", { inputHash: H }), source: eventSource as unknown as EvidenceSource };
    await expect(emitter.addEvent(JOB, STEP, event)).rejects.toThrow(
      "a method_loaded carrying inputHash must be kernel-written",
    );

    const completion = await emitter.addEvent(JOB, STEP, raw("execution_completed"));
    const bundle = await emitter.finalizeBundle(JOB, STEP);
    expect(bundle.events).toStrictEqual([completion]);
  });

  it("EW7 retains PyLabRobot's unmarked legacy method_loaded", async () => {
    const emitter = setup();
    const original = raw("method_loaded", { gcodeHash: H, mock: true });

    const stored = await emitter.addEvent(JOB, STEP, original);

    expect(stored.payload).toStrictEqual(original.payload);
    expect(Object.hasOwn(stored.source, "writer")).toBe(false);
    expect(stored.hash).toBe(await hashEvent(withoutIdentity(stored)));
    expect(await verifyEventHash(stored)).toBe(true);
  });

  it("EW8 overwrites supplied id and forged hash with the emitter's own v1 identity", async () => {
    const emitter = setup();
    const forgery = vector("old-kernel-forgery").event;
    // Use a non-input-proof event: a method_loaded carrying inputHash must
    // be rejected by EW6, independently of its supplied id and hash.
    const injected = {
      ...raw("execution_completed"),
      id: forgery.id,
      hash: forgery.hash,
    };

    const stored = await emitter.addEvent(JOB, STEP, injected as unknown as RawEvent);

    expect(stored.id).not.toBe(injected.id);
    expect(stored.hash).not.toBe(injected.hash);
    expect(stored.hash).toBe(await hashEvent(withoutIdentity(stored)));
    expect(await verifyEventHash(stored)).toBe(true);
  });

  it("EW9 shares the ordering and unit commitment chain across v1 and v2", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    const unit = {
      settlementUnitId: `0x${"a".repeat(64)}`,
      challengeNonce: `0x${"b".repeat(64)}`,
    };
    emitter.registerStep(JOB, STEP, 0, unit);

    const first = emitter.addEvent(JOB, STEP, raw("execution_started"));
    const proof = emitter.addKernelWrittenEvent(
      JOB, STEP, raw("method_loaded", { deviceJobId: "dj", inputHash: H }),
    );
    const last = emitter.addEvent(JOB, STEP, raw("execution_completed"));

    await Promise.all([first, proof, last]);
    const bundle = await emitter.finalizeBundle(JOB, STEP);

    expect(bundle.events.map((event) => event.type)).toStrictEqual([
      "execution_started", "method_loaded", "execution_completed",
    ]);
    const written = bundle.events[1]!;
    expect(written.source.writer).toBe("kernel");
    expect(written.payload).toMatchObject({ jobId: JOB, deviceJobId: "dj", inputHash: H, ...unit });
    expect(written.hash).toBe(await hashKernelWrittenEvent(withoutIdentity(written)));
    expect(await verifyEventHash(written)).toBe(true);
    expect(bundle.events[0]!.source.writer).toBeUndefined();
    expect(bundle.events[2]!.source.writer).toBeUndefined();
  });
});
