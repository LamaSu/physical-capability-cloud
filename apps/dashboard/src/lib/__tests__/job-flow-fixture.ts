import type { JobExecutionDTO } from "@pcc/spec";

/** Test source data, never imported by the product. */
export function jobFlowFixture(): JobExecutionDTO {
  return {
    schemaId: "pcc.job-execution/v1",
    asOf: "2026-10-14T12:00:00Z",
    job: {
      jobId: "job-print-1", stepId: "step-print-1", capabilityId: "cap-printer-1", kernelId: "kernel-1",
      capabilityType: "3D print", capabilityName: "Print bracket", kernelName: "Workshop",
      contractedTier: 2, createdAt: "2026-10-14T10:00:00Z",
    },
    execution: {
      phase: "failed", sourceStatus: "failed", source: "gateway_job_row", terminal: true,
      progressPercent: null, completedAt: null,
    },
    evidence: {
      state: "received", source: "gateway_evidence_store", bundleCount: 1, eventCount: 2,
      fabricatedEventCount: 0, truncated: false, latestStoredAt: "2026-10-14T11:00:00Z", error: null,
      bundles: [{ bundleId: "bundle-01234567890123456789", stepId: "step-print-1",
        bundleHash: "sha256:012345678901234567890123456789", claimedTier: 2, eventCount: 2,
        fabricatedEventCount: 0, signer: null, storedAt: "2026-10-14T11:00:00Z" }],
    },
    verification: {
      outcome: { state: "not_available", reason: "no_public_outcome_verdict" },
      captureChecks: {
        state: "none", source: "gateway_capture_verdicts", pass: 0, partial: 0, fail: 0,
        unrecognized: 0, latestAt: null, items: [], error: null,
      },
    },
    settlement: {
      link: "not_linked", linkBasis: null, linkMatches: [], source: "gateway_escrow_record",
      record: null, payout: "unknown", payoutBasis: null, payoutUnknownReason: null,
      payoutConfirmation: null, error: null,
    },
    notices: [],
  };
}
