import { describe, expect, it } from "vitest";
import { inputHashToRecipeRef, recipeRefToInputHash } from "../evidence/input-commitment.js";
import {
  verifyEvidenceSubjectBinding,
  type EvidenceSubject,
} from "../evidence/subject-binding.js";
import type { EvidenceEvent } from "../types/evidence.js";
import { hashBundle, hashEvent } from "../util/canonical.js";

const INPUT = `sha256:${"ab".repeat(32)}`;
const OTHER = `sha256:${"cd".repeat(32)}`;
const SUBJECT: EvidenceSubject = {
  jobId: "job-input",
  kernelId: "kernel-input",
  // Consumers derive this from the authenticated funded subjects, never an event.
  inputHash: recipeRefToInputHash(inputHashToRecipeRef(INPUT)),
};

type EventInput = { type: EvidenceEvent["type"]; payload?: Record<string, unknown> };

async function bundle(inputs: EventInput[]) {
  const events: EvidenceEvent[] = await Promise.all(inputs.map(async ({ type, payload }, i) => {
    const raw = {
      type,
      timestamp: "2026-10-15T10:00:00Z",
      source: { kernelId: SUBJECT.kernelId, deviceId: "device-input", deviceType: "controller" as const },
      payload: { jobId: SUBJECT.jobId, ...payload },
    };
    return { ...raw, id: `input-event-${i}`, hash: await hashEvent(raw) };
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
        { type: "method_loaded" },
        { type: "method_loaded", payload: { inputHash: OTHER } },
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
    const b = await bundle([{ type: "method_loaded", payload: { inputHash: INPUT } }]);
    const result = await verifyEvidenceSubjectBinding({ ...b, subject: SUBJECT });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    b.events[0]!.payload.inputHash = OTHER;
    expect(result.events[0]!.payload.inputHash).toBe(INPUT);
    expect(Object.isFrozen(result.events[0]!.payload)).toBe(true);
  });
});
