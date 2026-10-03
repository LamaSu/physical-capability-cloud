import { describe, it, expect } from "vitest";
import {
  EVIDENCE_SUMMARY_SCHEMA,
  summarizeEvidence,
  type EvidenceSummaryBundleInput,
} from "../evidence/evidence-summary.js";
import type { EvidenceEvent, EvidenceEventType } from "../types/evidence.js";

const JOB = "job-summary-1";
let seq = 0;

function ev(
  type: EvidenceEventType,
  deviceId: string,
  payload: Record<string, unknown> = {},
  simulated = false,
): EvidenceEvent {
  seq += 1;
  return {
    id: `ev-${seq}`,
    type,
    timestamp: "2026-09-24T12:00:00.000Z",
    source: {
      deviceId,
      deviceType: "controller",
      kernelId: "kernel-1",
      ...(simulated ? { simulated: true } : {}),
    } as EvidenceEvent["source"],
    payload,
    hash: `sha256:${"0".repeat(64)}` as EvidenceEvent["hash"],
  };
}

function bundle(
  over: Partial<EvidenceSummaryBundleInput> & Pick<EvidenceSummaryBundleInput, "events">,
): EvidenceSummaryBundleInput {
  seq += 1;
  return {
    bundleId: `ev-bundle-${seq}`,
    bundleHash: `sha256:${String(seq).padStart(64, "0")}`,
    createdAt: `2026-09-24T12:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    signedBy: "device",
    ...over,
  };
}

const completedEvents = () => [ev("execution_started", "printer-1"), ev("execution_completed", "printer-1")];

describe("EvidenceSummaryV1 — verified is never read from 'evidence exists'", () => {
  it("no bundles -> none", () => {
    const s = summarizeEvidence(JOB, []);
    expect(s).toMatchObject({
      schema: EVIDENCE_SUMMARY_SCHEMA,
      jobId: JOB,
      authentication: "none",
      verifiedStrength: "none",
      outcome: "none",
      outcomeBasis: "none",
      simulated: false,
      lastRecordedAt: null,
      inspect: [],
    });
    expect(s.plainLanguage).toBe("No evidence has been recorded for this job yet.");
  });

  it("a device bundle that was never checked is unverified, and its completion is only claimed", () => {
    const s = summarizeEvidence(JOB, [bundle({ events: completedEvents() })]);
    expect(s).toMatchObject({
      authentication: "unverified",
      verifiedStrength: "none",
      outcome: "completed",
      outcomeBasis: "claimed",
      reasons: ["not-checked"],
    });
    expect(s.plainLanguage).toBe("The provider reports the job finished. This has not been verified.");
    expect(s.inspect[0]).toMatchObject({ signedBy: "device", verified: null, eventCount: 2 });
  });

  it("a device bundle that failed a check is unverified with the check's reason", () => {
    const s = summarizeEvidence(JOB, [
      bundle({ events: completedEvents(), verification: { ok: false, reason: "job-mismatch" } }),
    ]);
    expect(s).toMatchObject({ authentication: "unverified", verifiedStrength: "none", reasons: ["job-mismatch"] });
    expect(s.inspect[0]!.verified).toBe(false);
  });

  it("a gateway record is not device evidence, whatever its events say", () => {
    const s = summarizeEvidence(JOB, [bundle({ signedBy: "gateway", events: completedEvents() })]);
    expect(s).toMatchObject({ authentication: "gateway_record", verifiedStrength: "none", outcomeBasis: "claimed" });
    expect(s.plainLanguage).toBe(
      "PCC recorded this job's activity. The provider has not sent signed device evidence.",
    );
    expect(s.inspect[0]!.verified).toBeNull();
  });

  it("a gateway bundle marked verified still does not count (only device bundles verify)", () => {
    const s = summarizeEvidence(JOB, [
      bundle({ signedBy: "gateway", events: completedEvents(), verification: { ok: true } }),
    ]);
    expect(s.authentication).toBe("gateway_record");
  });
});

describe("EvidenceSummaryV1 — verified evidence", () => {
  it("a verified device completion is device_reported and completed", () => {
    const s = summarizeEvidence(JOB, [bundle({ events: completedEvents(), verification: { ok: true } })]);
    expect(s).toMatchObject({
      authentication: "verified",
      verifiedStrength: "device_reported",
      outcome: "completed",
      outcomeBasis: "verified",
      reasons: [],
    });
    expect(s.plainLanguage).toBe("The machine's signed record shows the job finished.");
  });

  it("a verified accepted-only job is submitted and accepted, never completed", () => {
    const s = summarizeEvidence(JOB, [
      bundle({
        events: [
          ev("execution_started", "printer-1"),
          ev("execution_progress", "printer-1", { level: "submitted" }),
        ],
        verification: { ok: true },
      }),
    ]);
    expect(s).toMatchObject({ verifiedStrength: "submitted", outcome: "accepted" });
    expect(s.plainLanguage).toBe("The machine accepted the job and has not reported finishing.");
  });

  it("an independent inspection across two verified bundles is inspected_output", () => {
    const s = summarizeEvidence(JOB, [
      bundle({ events: completedEvents(), verification: { ok: true } }),
      bundle({ events: [ev("cv_inspection_result", "camera-1", { passed: true })], verification: { ok: true } }),
    ]);
    expect(s.verifiedStrength).toBe("inspected_output");
    expect(s.plainLanguage).toBe("An independent device inspected the output.");
  });

  it("an unverified inspection does not raise the verified strength", () => {
    const s = summarizeEvidence(JOB, [
      bundle({ events: completedEvents(), verification: { ok: true } }),
      bundle({ events: [ev("cv_inspection_result", "camera-1")], verification: { ok: false, reason: "signature-invalid" } }),
    ]);
    expect(s.verifiedStrength).toBe("device_reported");
    expect(s.reasons).toEqual([]);
    expect(s.inspect.map((r) => r.verified)).toEqual([true, false]);
  });

  it("failure outranks completion in the outcome", () => {
    const s = summarizeEvidence(JOB, [
      bundle({
        events: [...completedEvents(), ev("execution_failed", "printer-1")],
        verification: { ok: true },
      }),
    ]);
    expect(s.outcome).toBe("failed");
    expect(s.plainLanguage).toBe("The machine's signed record shows the job failed.");
  });

  it("the outcome comes from verified events only once any are verified", () => {
    const s = summarizeEvidence(JOB, [
      bundle({
        events: [ev("execution_started", "printer-1"), ev("execution_progress", "printer-1")],
        verification: { ok: true },
      }),
      bundle({ events: [ev("execution_completed", "printer-1")] }), // unchecked claim
    ]);
    expect(s).toMatchObject({ outcome: "accepted", outcomeBasis: "verified" });
  });
});

describe("EvidenceSummaryV1 — simulated evidence", () => {
  it("all-simulated evidence says so and proves nothing", () => {
    const s = summarizeEvidence(JOB, [
      bundle({
        events: [ev("execution_completed", "sim-printer", {}, true)],
        verification: { ok: true },
      }),
    ]);
    expect(s).toMatchObject({ simulated: true, verifiedStrength: "none", outcome: "none" });
    expect(s.plainLanguage).toBe("This job's evidence came from a simulator, not real hardware.");
  });

  it("mixed evidence counts only the real part and says the rest was simulated", () => {
    const s = summarizeEvidence(JOB, [
      bundle({
        events: [...completedEvents(), ev("cv_inspection_result", "camera-sim", {}, true)],
        verification: { ok: true },
      }),
    ]);
    expect(s).toMatchObject({ simulated: true, verifiedStrength: "device_reported", outcome: "completed" });
    expect(s.plainLanguage).toBe(
      "The machine's signed record shows the job finished. Some evidence came from a simulator and was not counted.",
    );
  });
});

describe("EvidenceSummaryV1 — raw inspect refs and source time", () => {
  it("keeps every bundle's id and hash and the latest createdAt", () => {
    const a = bundle({ events: completedEvents(), createdAt: "2026-09-24T12:00:01.000Z" });
    const b = bundle({ signedBy: "gateway", events: [], createdAt: "2026-09-24T12:05:00.000Z" });
    const s = summarizeEvidence(JOB, [a, b]);
    expect(s.inspect.map((r) => [r.bundleId, r.bundleHash])).toEqual([
      [a.bundleId, a.bundleHash],
      [b.bundleId, b.bundleHash],
    ]);
    expect(s.lastRecordedAt).toBe("2026-09-24T12:05:00.000Z");
  });
});
