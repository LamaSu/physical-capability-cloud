/**
 * Every event the kernel emits names its job, and its settlement unit when the
 * step has one, inside the hashed payload. LO-EV-9 (and the oracle at /settle)
 * bind each event, not the bundle, so a kernel bundle must carry the job on
 * every event to bind at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyEvidenceSubjectBinding, type EvidenceSource } from "@pcc/spec";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { createIppPrintKernel } from "../printer-job.js";

const KERNEL = "kernel-binding";
const JOB = "pcc-job-binding";
const U = "0x" + "03".repeat(32);
const NONCE = "0x" + "a3".repeat(32);
const source: EvidenceSource = { deviceId: "dev-1", deviceType: "machine", kernelId: KERNEL } as EvidenceSource;
const raw = (type: string, payload: Record<string, unknown>) => ({
  type,
  timestamp: "2026-09-24T12:00:00.000Z",
  source,
  payload,
}) as never;

describe("EvidenceEmitter commits the job (and unit) on every event", () => {
  it("stamps payload.jobId on events that do not carry it, and the bundle binds the job", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 1);
    await emitter.addEvent(JOB, "s1", raw("execution_started", { stepCount: 1 }));
    await emitter.addEvent(JOB, "s1", raw("temperature_log", { celsius: 21 }));
    await emitter.addEvent(JOB, "s1", raw("execution_completed", { ok: true }));
    const bundle = await emitter.finalizeBundle(JOB, "s1");
    for (const e of bundle.events) expect(e.payload).toMatchObject({ jobId: JOB });
    const bound = await verifyEvidenceSubjectBinding({
      bundleHash: bundle.bundleHash,
      events: bundle.events,
      subject: { jobId: JOB, kernelId: KERNEL },
    });
    expect(bound.ok).toBe(true);
  });

  it("commits the step's unit and challenge nonce on every event when registered", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 1, { settlementUnitId: U, challengeNonce: NONCE });
    await emitter.addEvent(JOB, "s1", raw("execution_started", {}));
    await emitter.addEvent(JOB, "s1", raw("execution_completed", {}));
    const bundle = await emitter.finalizeBundle(JOB, "s1");
    for (const e of bundle.events) expect(e.payload).toMatchObject({ jobId: JOB, settlementUnitId: U, challengeNonce: NONCE });
    const bound = await verifyEvidenceSubjectBinding({
      bundleHash: bundle.bundleHash,
      events: bundle.events,
      subject: { jobId: JOB, kernelId: KERNEL, settlementUnitId: U, challengeNonce: NONCE },
    });
    expect(bound.ok).toBe(true);
  });

  it("refuses an event that names another job, and a malformed unit", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 1);
    await expect(emitter.addEvent(JOB, "s1", raw("execution_started", { jobId: "pcc-job-other" }))).rejects.toThrow(
      /does not match/,
    );
    expect(() => emitter.registerStep(JOB, "s2", 1, { settlementUnitId: "unit-3", challengeNonce: NONCE })).toThrow();
  });

  it("refuses a unit field on a step that has no unit (the fields are reserved for the binding)", async () => {
    const emitter = new EvidenceEmitter(KERNEL);
    emitter.registerStep(JOB, "s1", 1);
    for (const prefill of [{ settlementUnitId: U }, { challengeNonce: NONCE }]) {
      await expect(emitter.addEvent(JOB, "s1", raw("execution_completed", prefill))).rejects.toThrow(/reserved/);
    }
    // The step's own unit, pre-filled with the same value, is still fine.
    emitter.registerStep(JOB, "s2", 1, { settlementUnitId: U, challengeNonce: NONCE });
    await expect(emitter.addEvent(JOB, "s2", raw("execution_completed", { settlementUnitId: U }))).resolves.toBeDefined();
  });
});

describe("the IPP print path now produces a bundle that binds its PCC job", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a mock print's bundle binds {jobId, kernelId}; the printer's own number rides as ippJobId", async () => {
    const kernel = createIppPrintKernel({
      kernelId: "kernel_print_binding",
      deviceId: "ipp_printer_binding",
      mockMode: true,
      seed: new Uint8Array(32).fill(9),
    });
    const p = kernel.print({ jobId: JOB, jobName: "doc.pdf", totalPages: 1 });
    await vi.advanceTimersByTimeAsync(500 + 1200 + 500);
    const result = await p;
    expect(result.success).toBe(true);
    const bundle = result.bundle!;
    for (const e of bundle.events) expect(e.payload).toMatchObject({ jobId: JOB });
    expect(bundle.events.find((e) => e.type === "execution_started")!.payload).toHaveProperty("ippJobId");
    const bound = await verifyEvidenceSubjectBinding({
      bundleHash: bundle.bundleHash,
      events: bundle.events,
      subject: { jobId: JOB, kernelId: "kernel_print_binding" },
    });
    expect(bound.ok).toBe(true);
    await kernel.dispose();
  });
});
