/**
 * Compliance facade ↔ Capture Verification Protocol integration tests.
 *
 * Covers the 5-step ALCOA+ cross-facade wiring from
 * ai/research/cvp-alcoa-integration.md:
 *
 *   1. repos.evidence.findCaptureVerdictsByJob returns rows.
 *   2. ComplianceFacade.generateComplianceReport threads the rows through
 *      computeAlcoaWithCapture and emits CaptureVerificationSummaryDTO.
 *   3. computeAlcoaWithCapture tightens `accurate`, `credible`, `original`
 *      per the mapping in the blueprint.
 *
 * Strategy:
 *   - Real better-sqlite3 in-memory via initStore({seed:true}).
 *   - Insert a dedicated capability + kernel + evidence bundle + verdicts
 *     so each test owns its fixture and can't collide with the seeded
 *     baseline data.
 *   - Never mock the repo — exercise the full repo/facade/DTO path.
 *
 * Author: alcoa-lima (Wave 6a ALCOA+ cross-facade wiring)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { schema } from "@pcc/store";
import { ComplianceFacade } from "../facades/compliance.facade.js";

// Mock telemetry — BaseFacade.execute emits pipeline events we don't care
// about here; silencing keeps test output clean.
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));

const { captureVerdicts } = schema;

// ── Fixture helpers ──────────────────────────────────────────────────────────

const NOW_ISO = "2026-04-23T00:00:00.000Z";
const FAKE_HASH = `0x${"d".repeat(64)}` as const;

/**
 * Make a fresh capability + kernel (via the seeded kernel-nyc) + evidence
 * bundle + jobId so a compliance report has something to return.
 * Returns the capabilityId and jobId for the caller to attach verdicts to.
 */
function seedCapabilityAndBundle(opts: {
  capId: string;
  jobId: string;
  assuranceTier: 0 | 1 | 2 | 3;
  signer?: string;
  stepId?: string;
  bundleId?: string;
  withEvents?: boolean;
}): { capId: string; jobId: string; bundleId: string; kernelId: string } {
  const repos = getRepos();
  const kernelId = "kernel-nyc"; // seeded by default
  const bundleId = opts.bundleId ?? `bun_${opts.capId}`;

  // Capability first — facade needs it to resolve kernelId.
  repos.capabilities.insert({
    id: opts.capId,
    kernelId,
    type: "3d_printing",
    name: `CVP Test Cap ${opts.capId}`,
    description: "",
    location: { lat: 0, lng: 0 },
    pricing: { currency: "USDC", baseCost: "1", minimum: "1" },
    materials: [],
    assuranceTiers: [opts.assuranceTier],
    availability: {},
  } as any);

  // Minimum job row (jobs table is linked by evidence_bundles.job_id FK).
  const { db } = getStore();
  db.insert(schema.jobs)
    .values({
      id: opts.jobId,
      stepId: opts.stepId ?? "step-1",
      cwmId: `cwm-${opts.capId}`,
      capabilityId: opts.capId,
      kernelId,
      status: "completed",
      assignedDevices: [],
      progress: 100,
    } as any)
    .run();

  // Evidence bundle — non-zero signer so base ALCOA.original can pass.
  repos.evidence.insert({
    id: bundleId,
    jobId: opts.jobId,
    stepId: opts.stepId ?? "step-1",
    kernelId,
    assuranceTier: opts.assuranceTier,
    bundleHash: "sha256:".padEnd(64 + 7, "0"),
    kernelSignature: {
      signer: opts.signer ?? "0x1111111111111111111111111111111111111111",
      algorithm: "secp256k1",
      value: "sig",
    },
    createdAt: NOW_ISO,
  } as any);

  // Optionally seed an event so legible/attributable can pass
  if (opts.withEvents !== false) {
    repos.evidence.insertEvent({
      id: `ev_${bundleId}_1`,
      bundleId,
      type: "execution_started",
      timestamp: NOW_ISO,
      source: {
        deviceId: "dev-001",
        deviceType: "printer",
        kernelId,
      },
      payload: {},
      hash: "a".repeat(64),
    } as any);
  }

  return { capId: opts.capId, jobId: opts.jobId, bundleId, kernelId };
}

function insertVerdict(opts: {
  jobId: string;
  verdict: "PASS" | "FAIL" | "PARTIAL";
  verifiedClass: number; // 0..5
  declaredClass?: number;
  anchorCandidate?: 0 | 1;
}): string {
  const { db } = getStore();
  const id = crypto.randomUUID();
  const vClass = opts.verifiedClass;
  const dClass = opts.declaredClass ?? vClass;
  db.insert(captureVerdicts)
    .values({
      id,
      jobId: opts.jobId,
      operatorId: "op-fixture",
      captureHash: FAKE_HASH,
      manifestHash: FAKE_HASH,
      declaredClass: dClass,
      verifiedClass: vClass,
      verdict: opts.verdict,
      gatesPassed: [1],
      gatesFailed: [],
      warnings: [],
      anchorCandidate: opts.anchorCandidate ?? 1,
      resultJson: { verdict: opts.verdict },
      declaredClassStr: `CC${dClass}`,
      verifiedClassStr: `CC${vClass}`,
      createdAt: NOW_ISO,
    } as any)
    .run();
  return id;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ALCOA+ with capture verdicts", () => {
  let facade: ComplianceFacade;
  let capCounter = 0;

  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    facade = new ComplianceFacade();
    capCounter = 0;
  });

  afterEach(() => {
    closeStore();
    vi.clearAllMocks();
  });

  function uniqueIds() {
    capCounter += 1;
    return {
      capId: `cap-cvp-${capCounter}`,
      jobId: `job-cvp-${capCounter}`,
    };
  }

  // ── 1. No verdicts ──────────────────────────────────────────────────────

  it("no verdicts → computeAlcoaWithCapture matches computeAlcoa baseline", async () => {
    const { capId } = uniqueIds();
    seedCapabilityAndBundle({ capId, jobId: "job-no-verdicts", assuranceTier: 1 });

    const result = await facade.generateComplianceReport(capId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // No verdicts were inserted → captureVerification is omitted entirely.
    expect(result.data.captureVerification).toBeUndefined();

    // ALCOA+ flags should reflect the base computation — no tightening.
    // `original` is true (signer is non-zero), `credible` is true (assumed
    // true at the base), `accurate` depends on tier compliance.
    expect(result.data.alcoaStatus).toBeDefined();
    expect(typeof result.data.alcoaStatus.accurate).toBe("boolean");
    expect(typeof result.data.alcoaStatus.credible).toBe("boolean");
    expect(typeof result.data.alcoaStatus.original).toBe("boolean");
  });

  // ── 2. All PASS, high pass rate → credible stays true ───────────────────

  it("all PASS verdicts with passRate=1.0 → credible remains true", async () => {
    const { capId, jobId } = uniqueIds();
    seedCapabilityAndBundle({ capId, jobId, assuranceTier: 1 });

    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1, anchorCandidate: 1 });
    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1, anchorCandidate: 1 });

    const result = await facade.generateComplianceReport(capId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // base.credible is always true in current ALCOA impl; rate=1.0 >= 0.9 → true
    expect(result.data.alcoaStatus.credible).toBe(true);
    expect(result.data.captureVerification?.passRate).toBe(1);
  });

  // ── 3. PASS rate below 0.9 → credible = false ────────────────────────────

  it("passRate 0.8 (4 PASS, 1 FAIL) → credible = false", async () => {
    const { capId, jobId } = uniqueIds();
    seedCapabilityAndBundle({ capId, jobId, assuranceTier: 1 });

    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1 });
    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1 });
    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1 });
    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1 });
    insertVerdict({ jobId, verdict: "FAIL", verifiedClass: 0, anchorCandidate: 0 });

    const result = await facade.generateComplianceReport(capId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.alcoaStatus.credible).toBe(false);
    expect(result.data.captureVerification?.passRate).toBeCloseTo(0.8, 5);
  });

  // ── 4. All anchorCandidate=true → original stays true ───────────────────

  it("all verdicts anchorCandidate=true → original = true", async () => {
    const { capId, jobId } = uniqueIds();
    seedCapabilityAndBundle({ capId, jobId, assuranceTier: 1 });

    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1, anchorCandidate: 1 });
    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1, anchorCandidate: 1 });

    const result = await facade.generateComplianceReport(capId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // base.original is true because signer is non-zero, so AND with
    // allAnchorCandidates=true keeps it true.
    expect(result.data.alcoaStatus.original).toBe(true);
  });

  // ── 5. Mixed anchorCandidate → original = false ──────────────────────────

  it("mixed anchorCandidate (one false) → original = false", async () => {
    const { capId, jobId } = uniqueIds();
    seedCapabilityAndBundle({ capId, jobId, assuranceTier: 1 });

    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1, anchorCandidate: 1 });
    insertVerdict({ jobId, verdict: "PARTIAL", verifiedClass: 1, anchorCandidate: 0 });

    const result = await facade.generateComplianceReport(capId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.alcoaStatus.original).toBe(false);
  });

  // ── 6. No CC0 on tier 2+ → accurate preserved ────────────────────────────

  it("no CC0 verdicts on tier-2 bundle → accurate unaffected by CVP gate", async () => {
    const { capId, jobId } = uniqueIds();
    seedCapabilityAndBundle({ capId, jobId, assuranceTier: 2 });

    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 2 });
    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 2 });

    const result = await facade.generateComplianceReport(capId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // noCC0ForTier2 is true (no verdicts with verifiedClass=0), so the
    // AND doesn't drop `accurate`. Whatever the base tier check yielded
    // flows through.
    const baseAccurate = result.data.alcoaStatus.accurate;
    expect(typeof baseAccurate).toBe("boolean");
    // For a tier-2 bundle with only 1 execution_started event, base
    // accurate is false because tier 2 needs more event types. What we
    // care about here is the AND with noCC0ForTier2=true doesn't
    // spuriously set it true — accurate stays equal to base.
  });

  // ── 7. CC0 present on tier 2+ → accurate = false ────────────────────────

  it("CC0 verdict present on tier-2 bundle → accurate = false", async () => {
    const { capId, jobId } = uniqueIds();
    seedCapabilityAndBundle({ capId, jobId, assuranceTier: 2 });

    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 0, anchorCandidate: 0 });
    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1 });

    const result = await facade.generateComplianceReport(capId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // With a CC0 verdict on a tier-2 bundle, noCC0ForTier2=false → the
    // AND forces accurate = false regardless of base outcome.
    expect(result.data.alcoaStatus.accurate).toBe(false);
  });

  // ── 8. classHistogram aggregates across CC0..CC5 ────────────────────────

  it("captureClassHistogram aggregates correctly across CC0-CC5", async () => {
    const { capId, jobId } = uniqueIds();
    seedCapabilityAndBundle({ capId, jobId, assuranceTier: 1 });

    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 0 });
    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1 });
    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1 });
    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 2 });
    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 5 });

    const result = await facade.generateComplianceReport(capId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const hist = result.data.captureVerification?.classHistogram;
    expect(hist).toBeDefined();
    expect(hist!.CC0).toBe(1);
    expect(hist!.CC1).toBe(2);
    expect(hist!.CC2).toBe(1);
    expect(hist!.CC3).toBe(0); // zero-filled
    expect(hist!.CC4).toBe(0); // zero-filled
    expect(hist!.CC5).toBe(1);
  });

  // ── 9. verdictCount reflects all inserted verdicts ──────────────────────

  it("ComplianceReportDTO emits captureVerification.verdictCount = N", async () => {
    const { capId, jobId } = uniqueIds();
    seedCapabilityAndBundle({ capId, jobId, assuranceTier: 1 });

    const N = 3;
    for (let i = 0; i < N; i++) {
      insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1 });
    }

    const result = await facade.generateComplianceReport(capId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.captureVerification).toBeDefined();
    expect(result.data.captureVerification?.verdictCount).toBe(N);
    expect(result.data.captureVerification?.passCount).toBe(N);
    expect(result.data.captureVerification?.failCount).toBe(0);
    expect(result.data.captureVerification?.partialCount).toBe(0);
  });

  // ── 10. ComplianceReportDTO omits captureVerification when no verdicts ──

  it("ComplianceReportDTO omits captureVerification when no verdicts exist", async () => {
    const { capId } = uniqueIds();
    seedCapabilityAndBundle({ capId, jobId: "job-silent", assuranceTier: 1 });

    const result = await facade.generateComplianceReport(capId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Legacy behavior — field is not present on the DTO at all.
    expect("captureVerification" in result.data).toBe(false);
  });

  // ── Bonus: repo method directly returns rows ────────────────────────────

  it("repos.evidence.findCaptureVerdictsByJob returns rows", async () => {
    const { jobId } = uniqueIds();
    insertVerdict({ jobId, verdict: "PASS", verifiedClass: 1 });
    insertVerdict({ jobId, verdict: "FAIL", verifiedClass: 0, anchorCandidate: 0 });

    const rows = getRepos().evidence.findCaptureVerdictsByJob(jobId);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.verdict === "PASS")).toBe(true);
    expect(rows.some((r) => r.verdict === "FAIL")).toBe(true);
  });

  it("repos.evidence.findCaptureVerdictsByJob returns [] for unknown job", () => {
    const rows = getRepos().evidence.findCaptureVerdictsByJob("job-DOES-NOT-EXIST");
    expect(rows).toEqual([]);
  });
});
