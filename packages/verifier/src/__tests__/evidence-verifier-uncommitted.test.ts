/**
 * E11c HIGH (cross-family review of #560): an event's `id` and the order of `events` are NOT committed.
 * The bundle hash commits the sorted multiset of event hashes, and each event hash commits `type`,
 * `timestamp`, `source` and `payload`. So neither may change EvidenceVerifier's signed verdict.
 */
import { describe, it, expect } from "vitest";
import { EvidenceVerifier } from "../evidence-verifier.js";
import { hashBundle, hashEvent } from "@pcc/spec";
import type { DigitalWorkflowStep, EvidenceBundle, EvidenceEvent, SHA256, Signature } from "@pcc/spec";

const source = { deviceId: "dev_uncommitted", deviceType: "controller" as const, kernelId: "kernel_uncommitted" };
type Raw = Omit<EvidenceEvent, "id" | "hash">;
const T = (s: number) => new Date(Date.UTC(2026, 9, 3, 12, 0, s)).toISOString();

async function sealed(raw: Raw, id: string): Promise<EvidenceEvent> {
  return { ...raw, id, hash: (await hashEvent(raw as never)) as SHA256 } as EvidenceEvent;
}

async function bundleOf(events: EvidenceEvent[]): Promise<EvidenceBundle> {
  return {
    id: "bun_uncommitted",
    jobId: "job_uncommitted",
    stepId: "step_uncommitted",
    kernelId: "kernel_uncommitted",
    assuranceTier: 1,
    events,
    bundleHash: (await hashBundle(events as never)) as SHA256,
    kernelSignature: {
      signer: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      algorithm: "secp256k1" as const,
      value: "mock_sig",
    } satisfies Signature,
    createdAt: T(0),
  } as EvidenceBundle;
}

/** What decides the verdict: the result and every finding's check, outcome and severity. */
function verdictOf(a: Awaited<ReturnType<EvidenceVerifier["verify"]>>) {
  return {
    result: a.result,
    findings: a.findings.map((f) => `${f.check}:${f.passed}:${f.severity ?? "-"}`).sort(),
  };
}

const verifier = new EvidenceVerifier("ver_uncommitted", "0x1234567890123456789012345678901234567890");
const steps = [{ stepId: "step-1", stepType: "transform", description: "the one declared step" }] as DigitalWorkflowStep[];

describe("E11c HIGH — an unsigned event id never drives EvidenceVerifier's verdict", () => {
  it("relabelling a step event's id does not cover a declared step: only a committed payload.stepId does", async () => {
    const gcode = await sealed({ type: "gcode_hash_verified", timestamp: T(0), source, payload: { hash: "abc" } }, "ev-gcode");
    const started = await sealed({ type: "execution_started", timestamp: T(1), source, payload: {} }, "ev-start");
    // Everything else in the bundle passes (tier 1's power summary included), so the step alone decides.
    const stepPayload = { durationMs: 10, outputSummary: "transformed ten rows" };
    const stepRaw: Raw = { type: "workflow_step_completed", timestamp: T(3), source, payload: stepPayload };
    const done = await sealed({ type: "execution_completed", timestamp: T(5), source, payload: { success: true } }, "ev-done");
    const power = await sealed({ type: "power_profile_summary", timestamp: T(6), source, payload: { durationSeconds: 4 } }, "ev-power");
    const unrelated = await bundleOf([gcode, started, await sealed(stepRaw, "unrelated"), done, power]);
    const relabelled = await bundleOf([gcode, started, await sealed(stepRaw, "step-1"), done, power]);
    expect(relabelled.bundleHash).toBe(unrelated.bundleHash);
    const a = verdictOf(await verifier.verify(unrelated, { workflowSteps: steps }));
    const b = verdictOf(await verifier.verify(relabelled, { workflowSteps: steps }));
    expect(b, "the same signed bundle, relabelled").toEqual(a);
    expect(a.result, "no committed payload.stepId covers the declared step").toBe("invalid");
    // Positive control: a COMMITTED payload.stepId covers the step, and the bundle is valid.
    const committed = await bundleOf([gcode, started, await sealed({ ...stepRaw, payload: { ...stepPayload, stepId: "step-1" } }, "any"), done, power]);
    const c = await verifier.verify(committed, { workflowSteps: steps });
    expect(c.findings.filter((f) => !f.passed && f.severity === "critical")).toEqual([]);
    expect(c.result).toBe("valid");
  });
});

describe("E11c HIGH — the order of events never drives EvidenceVerifier's verdict", () => {
  it("a completion before the start is judged the same in every order", async () => {
    const gcode = await sealed({ type: "gcode_hash_verified", timestamp: T(0), source, payload: { hash: "abc" } }, "ev-gcode");
    const started = await sealed({ type: "execution_started", timestamp: T(10), source, payload: {} }, "ev-start");
    const early = await sealed({ type: "execution_completed", timestamp: T(5), source, payload: { success: true } }, "ev-early");
    const late = await sealed({ type: "execution_completed", timestamp: T(20), source, payload: { success: true } }, "ev-late");
    const orders = [
      [gcode, started, early, late],
      [gcode, started, late, early],
      [late, early, started, gcode],
    ];
    const verdicts = [];
    for (const events of orders) {
      const bundle = await bundleOf(events);
      verdicts.push({ bundleHash: bundle.bundleHash, ...verdictOf(await verifier.verify(bundle)) });
    }
    expect(verdicts[1]).toEqual(verdicts[0]);
    expect(verdicts[2]).toEqual(verdicts[0]);
    // A completion that precedes a start fails closed, whichever order the events arrive in: the
    // duration check itself fails (not only tier 1's missing power summary).
    expect(verdicts[0]!.result).toBe("invalid");
    expect(verdicts[0]!.findings).toContain("execution_duration_positive:false:critical");
  });

  it("a completion between two starts fails closed in every order (the latest start counts)", async () => {
    const gcode = await sealed({ type: "gcode_hash_verified", timestamp: T(0), source, payload: { hash: "abc" } }, "ev-gcode");
    const first = await sealed({ type: "execution_started", timestamp: T(0), source, payload: { attempt: 1 } }, "ev-s1");
    const second = await sealed({ type: "execution_started", timestamp: T(10), source, payload: { attempt: 2 } }, "ev-s2");
    const done = await sealed({ type: "execution_completed", timestamp: T(5), source, payload: { success: true } }, "ev-done");
    const a = verdictOf(await verifier.verify(await bundleOf([gcode, first, second, done])));
    const b = verdictOf(await verifier.verify(await bundleOf([gcode, second, first, done])));
    expect(b).toEqual(a);
    expect(a.findings).toContain("execution_duration_positive:false:critical");
  });

  it("two power summaries with the same timestamp are told apart by their hash, not their position", async () => {
    const gcode = await sealed({ type: "gcode_hash_verified", timestamp: T(0), source, payload: { hash: "abc" } }, "ev-gcode");
    const started = await sealed({ type: "execution_started", timestamp: T(0), source, payload: {} }, "ev-start");
    const done = await sealed({ type: "execution_completed", timestamp: T(10), source, payload: { success: true } }, "ev-done");
    const p1 = await sealed({ type: "power_profile_summary", timestamp: T(11), source, payload: { durationSeconds: 10 } }, "ev-p1");
    const p2 = await sealed({ type: "power_profile_summary", timestamp: T(11), source, payload: { durationSeconds: 100 } }, "ev-p2");
    const a = verdictOf(await verifier.verify(await bundleOf([gcode, started, done, p1, p2])));
    const b = verdictOf(await verifier.verify(await bundleOf([gcode, started, done, p2, p1])));
    expect(b).toEqual(a);
  });

  it("the power summary checked does not depend on the order of events", async () => {
    const gcode = await sealed({ type: "gcode_hash_verified", timestamp: T(0), source, payload: { hash: "abc" } }, "ev-gcode");
    const started = await sealed({ type: "execution_started", timestamp: T(0), source, payload: {} }, "ev-start");
    const done = await sealed({ type: "execution_completed", timestamp: T(10), source, payload: { success: true } }, "ev-done");
    const consistent = await sealed({ type: "power_profile_summary", timestamp: T(11), source, payload: { durationSeconds: 10 } }, "ev-p1");
    const inconsistent = await sealed({ type: "power_profile_summary", timestamp: T(12), source, payload: { durationSeconds: 100 } }, "ev-p2");
    const a = verdictOf(await verifier.verify(await bundleOf([gcode, started, done, consistent, inconsistent])));
    const b = verdictOf(await verifier.verify(await bundleOf([gcode, started, done, inconsistent, consistent])));
    expect(b).toEqual(a);
  });
});
