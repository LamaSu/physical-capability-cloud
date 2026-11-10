import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as spec from "../index.js";
import { EvidenceEventSchema } from "../schemas/index.js";
import type { EvidenceEvent } from "../types/evidence.js";
import {
  NonCanonicalValueError,
  canonicalize,
  hashEvent,
  hashKernelWrittenEvent,
  verifyEventHash,
} from "../util/canonical.js";

interface EventVector {
  id: string;
  eventHashVersion: 1 | 2;
  canonicalPreimage: string;
  event: EvidenceEvent;
  verified: boolean;
}

const vectors = JSON.parse(
  readFileSync(new URL("../evidence/vectors/event-hash-writer.v2.json", import.meta.url), "utf8"),
) as { contract: string; events: EventVector[]; invalidWriters: EventVector[] };

function eventVector(id: string): EventVector {
  return vectors.events.find((vector) => vector.id === id)!;
}

function eventCopy(id = "kernel-written-v2"): EvidenceEvent {
  return JSON.parse(JSON.stringify(eventVector(id).event)) as EvidenceEvent;
}

/** Independent encoder for these plain-JSON vectors; no shipped canonical/hash helper. */
function nodeCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(nodeCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${nodeCanonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function nodeHash(preimage: string): string {
  return `sha256:${createHash("sha256").update(preimage, "utf8").digest("hex")}`;
}

describe("event hash v2 — kernel writer and immutable v1 bytes", () => {
  it("publishes the writer vectors and the public kernel-internal hasher", () => {
    expect(vectors.contract).toBe("pcc.evidence.event-hash-writer.v2");
    expect(spec.hashKernelWrittenEvent).toBe(hashKernelWrittenEvent);
    expect(vectors.events.map(({ id }) => id)).toEqual([
      "unmarked-v1", "kernel-written-v2", "old-kernel-forgery",
    ]);
    expect(vectors.invalidWriters.map(({ id }) => id)).toEqual(["adapter-writer", "boolean-writer"]);
  });

  for (const vector of [...vectors.events, ...vectors.invalidWriters]) {
    it(`replays ${vector.id} with independent canonical bytes and node:crypto`, async () => {
      const { type, timestamp, source, payload } = vector.event;
      const preimage = vector.eventHashVersion === 2
        ? { type, timestamp, source, payload, eventHashVersion: 2 }
        : { type, timestamp, source, payload };
      expect(nodeCanonical(preimage)).toBe(vector.canonicalPreimage);
      expect(canonicalize(preimage)).toBe(vector.canonicalPreimage);
      expect(nodeHash(vector.canonicalPreimage)).toBe(vector.event.hash);
      expect(await verifyEventHash(vector.event)).toBe(vector.verified);
    });
  }

  it("keeps the unmarked event's exact v1 preimage and digest", async () => {
    const vector = eventVector("unmarked-v1");
    expect(await hashEvent(vector.event)).toBe(vector.event.hash);
    expect(vector.canonicalPreimage).not.toContain("eventHashVersion");
    await expect(hashKernelWrittenEvent(vector.event)).rejects.toThrow("own data property");
  });

  it("authors the marked event only through v2 and refuses it in producer hashEvent", async () => {
    const vector = eventVector("kernel-written-v2");
    expect(await hashKernelWrittenEvent(vector.event)).toBe(vector.event.hash);
    expect(vector.canonicalPreimage).toContain('"eventHashVersion":2');
    await expect(hashEvent(vector.event)).rejects.toThrow("source.writer is reserved for kernel-written events");
  });

  it("refuses an old kernel's v1 hash over the otherwise identical marked bytes", async () => {
    const forgery = eventVector("old-kernel-forgery");
    expect(forgery.event.source).toEqual(eventVector("kernel-written-v2").event.source);
    expect(forgery.event.payload).toEqual(eventVector("kernel-written-v2").event.payload);
    expect(forgery.event.hash).not.toBe(eventVector("kernel-written-v2").event.hash);
    expect(await verifyEventHash(forgery.event)).toBe(false);
    expect(await hashKernelWrittenEvent(forgery.event)).toBe(eventVector("kernel-written-v2").event.hash);
  });

  for (const writer of ["adapter", true, false, undefined, null, 0, "", "Kernel"]) {
    it(`refuses the own writer value ${String(writer)}`, async () => {
      const event = eventCopy();
      Object.defineProperty(event.source, "writer", { value: writer, enumerable: true });
      expect(await verifyEventHash(event)).toBe(false);
      await expect(hashEvent(event)).rejects.toThrow("source.writer is reserved for kernel-written events");
      await expect(hashKernelWrittenEvent(event)).rejects.toThrow("own data property");
    });
  }

  it("refuses an accessor writer without ever invoking the getter", async () => {
    const event = eventCopy();
    let reads = 0;
    Object.defineProperty(event.source, "writer", {
      enumerable: true,
      get() { reads++; return "kernel"; },
    });
    expect(await verifyEventHash(event)).toBe(false);
    await expect(hashEvent(event)).rejects.toThrow("source.writer is reserved for kernel-written events");
    await expect(hashKernelWrittenEvent(event)).rejects.toThrow("own data property");
    expect(reads).toBe(0);
  });

  it("still refuses a non-enumerable kernel marker as non-JSON input", async () => {
    const event = eventCopy();
    Object.defineProperty(event.source, "writer", { value: "kernel", enumerable: false });
    await expect(hashEvent(event)).rejects.toThrow("source.writer is reserved for kernel-written events");
    await expect(hashKernelWrittenEvent(event)).rejects.toBeInstanceOf(NonCanonicalValueError);
    await expect(verifyEventHash(event)).rejects.toBeInstanceOf(NonCanonicalValueError);
  });

  it("refuses an own undefined non-enumerable marker instead of dropping it", async () => {
    const event = eventCopy();
    Object.defineProperty(event.source, "writer", { value: undefined, enumerable: false });
    expect(await verifyEventHash(event)).toBe(false);
    await expect(hashEvent(event)).rejects.toThrow("source.writer is reserved for kernel-written events");
    await expect(hashKernelWrittenEvent(event)).rejects.toThrow("own data property");
  });

  it("does not accept an inherited writer as the own kernel marker", async () => {
    const event = eventCopy("unmarked-v1");
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "writer");
    Object.defineProperty(Object.prototype, "writer", { value: "kernel", configurable: true });
    try {
      expect(await hashEvent(event)).toBe(event.hash);
      expect(await verifyEventHash(event)).toBe(true);
      await expect(hashKernelWrittenEvent(event)).rejects.toThrow("own data property");
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "writer", previous);
      else Reflect.deleteProperty(Object.prototype, "writer");
    }
  });

  for (const operation of [hashEvent, hashKernelWrittenEvent, verifyEventHash]) {
    it(`${operation.name} reads the source once and each own descriptor once`, async () => {
      const event = eventCopy(operation === hashEvent ? "unmarked-v1" : "kernel-written-v2");
      const originalSource = event.source;
      const descriptors = new Map<PropertyKey, number>();
      let sourceReads = 0;
      const source = new Proxy(originalSource, {
        get() { throw new Error("source [[Get]] must never run"); },
        getOwnPropertyDescriptor(target, key) {
          const count = (descriptors.get(key) ?? 0) + 1;
          descriptors.set(key, count);
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (key === "writer" && count > 1) return { value: "adapter", configurable: true, enumerable: true };
          return descriptor;
        },
      });
      Object.defineProperty(event, "source", {
        get() { sourceReads++; return sourceReads === 1 ? source : {}; },
      });
      expect(await operation(event)).toBe(operation === verifyEventHash ? true : event.hash);
      expect(sourceReads).toBe(1);
      expect(descriptors.get("writer")).toBe(1);
      expect([...descriptors.values()].every((count) => count === 1)).toBe(true);
    });
  }

  it("preserves a captured own marker even if a Proxy omits it from ownKeys", async () => {
    const event = eventCopy();
    event.source = new Proxy(event.source, {
      ownKeys(target) { return Reflect.ownKeys(target).filter((key) => key !== "writer"); },
    });
    expect(await hashKernelWrittenEvent(event)).toBe(event.hash);
    expect(await verifyEventHash(event)).toBe(true);
    await expect(hashEvent(event)).rejects.toThrow("source.writer is reserved for kernel-written events");
  });

  it("keeps malformed payload behavior: verifyEventHash rejects with the canonical error", async () => {
    for (const id of ["unmarked-v1", "kernel-written-v2"]) {
      const event = eventCopy(id);
      Object.defineProperty(event.payload, "getter", { enumerable: true, get() { throw new Error("must not run"); } });
      await expect(verifyEventHash(event)).rejects.toBeInstanceOf(NonCanonicalValueError);
    }
  });

  it("preserves a marked event and its verifiable hash through the evidence schema", async () => {
    const event = eventCopy();
    const parsed = EvidenceEventSchema.parse(event);
    expect(parsed).toEqual(event);
    expect(parsed.source.writer).toBe("kernel");
    expect(await verifyEventHash(parsed as EvidenceEvent)).toBe(true);
    for (const writer of ["adapter", true]) {
      expect(EvidenceEventSchema.safeParse({ ...event, source: { ...event.source, writer } }).success).toBe(false);
    }
  });
});
