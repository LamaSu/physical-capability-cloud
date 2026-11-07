import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inputHashToRecipeRef, recipeRefToInputHash } from "../evidence/input-commitment.js";
import {
  verifyEvidenceSubjectBinding,
  type EvidenceSubject,
  type EvidenceSubjectBindingResult,
} from "../evidence/subject-binding.js";
import type { EvidenceEvent } from "../types/evidence.js";
import { canonicalize, hashBundle, hashEvent, hashKernelWrittenEvent } from "../util/canonical.js";

const INPUT = `sha256:${"ab".repeat(32)}`;
const OTHER = `sha256:${"cd".repeat(32)}`;
const DEVICE_JOB = "device-job-input";
const SUBJECT: EvidenceSubject = {
  jobId: "job-input",
  kernelId: "kernel-input",
  // Consumers derive this from the authenticated funded subjects, never an event.
  inputHash: recipeRefToInputHash(inputHashToRecipeRef(INPUT)),
};

type EventInput = { type: EvidenceEvent["type"]; payload?: Record<string, unknown>; kernelWritten?: boolean };

async function bundle(inputs: EventInput[]) {
  const events: EvidenceEvent[] = await Promise.all(inputs.map(async ({ type, payload, kernelWritten = type === "method_loaded" }, i) => {
    const raw = {
      type,
      timestamp: "2026-10-15T10:00:00Z",
      source: { kernelId: SUBJECT.kernelId, deviceId: "device-input", deviceType: "controller" as const, ...(kernelWritten ? { writer: "kernel" as const } : {}) },
      payload: { jobId: SUBJECT.jobId, deviceJobId: DEVICE_JOB, ...payload },
    };
    return { ...raw, id: `input-event-${i}`, hash: await (kernelWritten ? hashKernelWrittenEvent(raw) : hashEvent(raw)) };
  }));
  return { events, bundleHash: await hashBundle(events) };
}

async function verify(inputs: EventInput[], subject: EvidenceSubject = SUBJECT) {
  return verifyEvidenceSubjectBinding({ ...await bundle(inputs), subject });
}

describe("LO-EV-9 funded input subject binding (#8812/#8815)", () => {
  it("accepts every method_loaded and every other input commitment matching the funded input", async () => {
    expect(await verify([
      { type: "method_loaded", payload: { inputHash: INPUT } },
      { type: "method_loaded", payload: { inputHash: INPUT } },
      { type: "execution_started" },
      { type: "execution_completed", payload: { inputHash: INPUT } },
    ])).toMatchObject({ ok: true });
  });

  it("refuses a zero subject inputHash even when a kernel-written method_loaded commits the same zero", async () => {
    const zeroInputHash = `sha256:${"00".repeat(32)}`;
    expect(await verify([
      { type: "method_loaded", kernelWritten: true, payload: { inputHash: zeroInputHash } },
      { type: "execution_completed" },
    ], { ...SUBJECT, inputHash: zeroInputHash })).toEqual({
      ok: false, reason: "malformed-subject",
    });
  });

  it("requires at least one method_loaded, even when another event commits the input", async () => {
    expect(await verify([
      { type: "execution_completed", payload: { inputHash: INPUT } },
    ])).toEqual({ ok: false, reason: "input-not-committed" });
  });

  it("refuses a method_loaded without inputHash", async () => {
    expect(await verify([{ type: "method_loaded" }])).toEqual({
      ok: false, reason: "input-not-committed", eventIndex: 0,
    });
  });

  it("refuses a missing hash after a matching method_loaded (every load must commit)", async () => {
    expect(await verify([
      { type: "method_loaded", payload: { inputHash: INPUT } },
      { type: "method_loaded" },
    ])).toEqual({ ok: false, reason: "input-not-committed", eventIndex: 1 });
  });

  it("refuses a mismatched method_loaded", async () => {
    expect(await verify([{ type: "method_loaded", payload: { inputHash: OTHER } }])).toEqual({
      ok: false, reason: "input-mismatch", eventIndex: 0,
    });
  });

  it("refuses a second mismatched method_loaded after a matching one", async () => {
    expect(await verify([
      { type: "method_loaded", payload: { inputHash: INPUT } },
      { type: "method_loaded", payload: { inputHash: OTHER } },
    ])).toEqual({ ok: false, reason: "input-mismatch", eventIndex: 1 });
  });

  it("refuses any other event's mismatched inputHash", async () => {
    expect(await verify([
      { type: "method_loaded", payload: { inputHash: INPUT } },
      { type: "execution_completed", payload: { inputHash: OTHER } },
    ])).toEqual({ ok: false, reason: "input-mismatch", eventIndex: 1 });
  });

  it.each([null, 42, {}, "", INPUT.toUpperCase(), ` ${INPUT}`, `${INPUT}\n`, "sha256:abc", `0x${"ab".repeat(32)}`])(
    "refuses malformed subject inputHash %j before checking the bundle",
    async (inputHash) => {
      expect(await verifyEvidenceSubjectBinding({
        bundleHash: "malformed", events: [], subject: { ...SUBJECT, inputHash } as EvidenceSubject,
      })).toEqual({ ok: false, reason: "malformed-subject" });
    },
  );

  it.each([null, 42, "", INPUT.toUpperCase(), `${INPUT}\n`])(
    "refuses noncanonical committed inputHash %j",
    async (inputHash) => {
      expect(await verify([{ type: "method_loaded", payload: { inputHash } }])).toEqual({
        ok: false, reason: "input-mismatch", eventIndex: 0,
      });
    },
  );

  it("adds no input constraint when the subject names none, including legacy malformed content", async () => {
    const legacy = { jobId: SUBJECT.jobId, kernelId: SUBJECT.kernelId };
    for (const subject of [legacy, { ...legacy, inputHash: undefined }]) {
      expect(await verify([
        { type: "method_loaded", kernelWritten: false },
        { type: "method_loaded", kernelWritten: false, payload: { inputHash: OTHER } },
        { type: "execution_completed", payload: { inputHash: "legacy-unchecked-content" } },
      ], subject)).toMatchObject({ ok: true });
      expect(await verify([{ type: "execution_completed" }], subject)).toMatchObject({ ok: true });
    }
  });

  it("does not run a subject inputHash accessor", async () => {
    let reads = 0;
    const subject = Object.defineProperty({ ...SUBJECT }, "inputHash", {
      get() { reads++; throw new Error("must not run"); },
      enumerable: true,
    });
    expect(await verify([{ type: "method_loaded", payload: { inputHash: INPUT } }], subject)).toEqual({
      ok: false, reason: "malformed-subject",
    });
    expect(reads).toBe(0);
  });

  it("does not run a committed inputHash accessor", async () => {
    const b = await bundle([{ type: "method_loaded", payload: { inputHash: INPUT } }]);
    let reads = 0;
    Object.defineProperty(b.events[0]!.payload, "inputHash", {
      get() { reads++; throw new Error("must not run"); },
      enumerable: true,
    });
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: SUBJECT })).toEqual({
      ok: false, reason: "malformed-event", eventIndex: 0,
    });
    expect(reads).toBe(0);
  });

  it("does not treat an uncommitted non-enumerable inputHash as a load commitment", async () => {
    const b = await bundle([{ type: "method_loaded" }]);
    Object.defineProperty(b.events[0]!.payload, "inputHash", { value: INPUT, enumerable: false });
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: SUBJECT })).toEqual({
      ok: false, reason: "input-not-committed", eventIndex: 0,
    });
  });

  it("returns frozen snapshots of matching input commitments", async () => {
    const b = await bundle([
      { type: "method_loaded", payload: { inputHash: INPUT } },
      { type: "execution_completed" },
    ]);
    const result = await verifyEvidenceSubjectBinding({ ...b, subject: SUBJECT });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    b.events[0]!.payload.inputHash = OTHER;
    expect(result.events[0]!.payload.inputHash).toBe(INPUT);
    expect(Object.isFrozen(result.events[0]!.payload)).toBe(true);
  });
});

interface InputBindingVector {
  id: string;
  subject: EvidenceSubject;
  events: EvidenceEvent[];
  eventHashVersions: Array<1 | 2>;
  eventPreimages: string[];
  bundlePreimage: string;
  bundleHash: string;
  expected: EvidenceSubjectBindingResult;
}

const writerVectors = JSON.parse(readFileSync(
  new URL("../evidence/vectors/subject-binding-input-writer.v2.json", import.meta.url), "utf8",
)) as { completionEventTypes: string[]; vectors: InputBindingVector[] };

const inputRuleVectors = JSON.parse(readFileSync(
  new URL("../evidence/vectors/subject-binding-input-rules.v2.json", import.meta.url), "utf8",
)) as { completionEventTypes: string[]; vectors: InputBindingVector[] };

/** Independent fixture encoder: the vectors contain only plain JSON values. */
function nodeCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(nodeCanonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${nodeCanonical(record[key])}`).join(",")}}`;
}

function nodeSha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

describe("LO-EV-9 kernel-written input and device-job vectors (#8973)", () => {
  it("defines execution_completed as the complete completion-event list", () => {
    expect(writerVectors.completionEventTypes).toEqual(["execution_completed"]);
  });

  it.each(writerVectors.vectors)("$id", async (vector) => {
    for (let i = 0; i < vector.events.length; i++) {
      const { type, timestamp, source, payload, hash } = vector.events[i]!;
      const version = vector.eventHashVersions[i];
      const preimage = { type, timestamp, source, payload, ...(version === 2 ? { eventHashVersion: 2 } : {}) };
      expect(nodeCanonical(preimage)).toBe(vector.eventPreimages[i]);
      expect(nodeSha256(vector.eventPreimages[i]!)).toBe(hash);
      expect(canonicalize(preimage)).toBe(vector.eventPreimages[i]);
    }
    expect(nodeCanonical(vector.events.map(({ hash }) => hash).sort())).toBe(vector.bundlePreimage);
    expect(nodeSha256(vector.bundlePreimage)).toBe(vector.bundleHash);
    const result = await verifyEvidenceSubjectBinding(vector);
    if (vector.expected.ok) expect(result).toMatchObject(vector.expected);
    else expect(result).toEqual(vector.expected);
  });

  it.each([undefined, null, 0, "", "adapter", true])("refuses own writer %j before plain-data copying can omit it", async (writer) => {
    const b = await bundle([
      { type: "method_loaded", payload: { inputHash: INPUT } },
      { type: "execution_completed" },
    ]);
    Object.defineProperty(b.events[0]!.source, "writer", { value: writer, enumerable: true, configurable: true });
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: SUBJECT })).toEqual({
      ok: false, reason: "event-writer-invalid", eventIndex: 0,
    });
  });

  it("does not run a source.writer accessor", async () => {
    const b = await bundle([{ type: "method_loaded", payload: { inputHash: INPUT } }]);
    let reads = 0;
    Object.defineProperty(b.events[0]!.source, "writer", {
      get() { reads++; return "kernel"; }, enumerable: true,
    });
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: SUBJECT })).toEqual({
      ok: false, reason: "event-writer-invalid", eventIndex: 0,
    });
    expect(reads).toBe(0);
  });

  it("refuses an accessor writer while Object.prototype.value is kernel, without running its getter", async () => {
    const b = await bundle([
      { type: "method_loaded", payload: { inputHash: INPUT } },
      { type: "execution_completed" },
    ]);
    let reads = 0;
    // Define the accessor before pollution, so its descriptor cannot inherit a value.
    Object.defineProperty(b.events[0]!.source, "writer", {
      get() { reads++; return "kernel"; }, enumerable: true,
    });
    Object.defineProperty(Object.prototype, "value", { value: "kernel", configurable: true });
    let result: EvidenceSubjectBindingResult;
    try {
      result = await verifyEvidenceSubjectBinding({ ...b, subject: SUBJECT });
    } finally {
      delete (Object.prototype as { value?: unknown }).value;
    }
    expect(result).toEqual({ ok: false, reason: "event-writer-invalid", eventIndex: 0 });
    expect(reads).toBe(0);
  });

  it("refuses a source proxy without asking any trap for its marker", async () => {
    const b = await bundle([{ type: "method_loaded", payload: { inputHash: INPUT } }]);
    let traps = 0;
    b.events[0]!.source = new Proxy(b.events[0]!.source, {
      get() { traps++; return "kernel"; },
      getOwnPropertyDescriptor() { traps++; throw new Error("must not run"); },
      ownKeys() { traps++; throw new Error("must not run"); },
      getPrototypeOf() { traps++; throw new Error("must not run"); },
    });
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: SUBJECT })).toEqual({
      ok: false, reason: "malformed-event", eventIndex: 0,
    });
    expect(traps).toBe(0);
  });

  it("refuses a non-enumerable kernel writer that cannot survive canonical JSON", async () => {
    const b = await bundle([{ type: "method_loaded", payload: { inputHash: INPUT } }]);
    Object.defineProperty(b.events[0]!.source, "writer", { value: "kernel", enumerable: false });
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: SUBJECT })).toEqual({
      ok: false, reason: "malformed-event", eventIndex: 0,
    });
  });

  it.each(["method_loaded", "execution_completed"] as const)("does not run %s deviceJobId accessors", async (type) => {
    const b = await bundle([
      { type: "method_loaded", payload: { inputHash: INPUT } },
      { type: "execution_completed" },
    ]);
    const event = b.events.find((e) => e.type === type)!;
    let reads = 0;
    Object.defineProperty(event.payload, "deviceJobId", {
      get() { reads++; return DEVICE_JOB; }, enumerable: true,
    });
    expect(await verifyEvidenceSubjectBinding({ ...b, subject: SUBJECT })).toEqual({
      ok: false, reason: "malformed-event", eventIndex: type === "method_loaded" ? 0 : 1,
    });
    expect(reads).toBe(0);
  });
});

describe("LO-EV-9 step 8 r1 input rules and exact device-job vectors (#8815/#8820/#8973/#8979)", () => {
  it("defines execution_completed as the complete completion-event list", () => {
    expect(inputRuleVectors.completionEventTypes).toEqual(["execution_completed"]);
  });

  it.each(inputRuleVectors.vectors)("$id", async (vector) => {
    expect(vector.eventHashVersions).toHaveLength(vector.events.length);
    expect(vector.eventPreimages).toHaveLength(vector.events.length);
    for (let i = 0; i < vector.events.length; i++) {
      const { type, timestamp, source, payload, hash } = vector.events[i]!;
      const version = vector.eventHashVersions[i];
      expect(version).toBe(source.writer === "kernel" ? 2 : 1);
      const preimage = { type, timestamp, source, payload, ...(version === 2 ? { eventHashVersion: 2 } : {}) };
      expect(nodeCanonical(preimage)).toBe(vector.eventPreimages[i]);
      expect(nodeSha256(vector.eventPreimages[i]!)).toBe(hash);
      expect(canonicalize(preimage)).toBe(vector.eventPreimages[i]);
    }
    expect(nodeCanonical(vector.events.map(({ hash }) => hash).sort())).toBe(vector.bundlePreimage);
    expect(nodeSha256(vector.bundlePreimage)).toBe(vector.bundleHash);
    const result = await verifyEvidenceSubjectBinding(vector);
    expect(result.ok ? { ok: true } : result).toEqual(vector.expected);
  });
});
