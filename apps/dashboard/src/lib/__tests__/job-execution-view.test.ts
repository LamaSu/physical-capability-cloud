/**
 * JobExecutionDTO presentation (PX-6). The page projects the DTO; these tests pin the
 * wording and color rules so a surface cannot quietly turn completion into payment or
 * evidence into verification.
 */
import { describe, it, expect } from "vitest";
import type { EvidenceAxis, ExecutionPhase, PayoutState, SettlementAxis } from "@pcc/spec";
import {
  NOTICE_TEXT,
  PAYOUT_VIEW,
  PHASE_VIEW,
  evidenceSummaryText,
  payoutBasisText,
  settlementLinkText,
} from "../job-execution-view.js";

const PHASES: ExecutionPhase[] = [
  "pending", "queued", "dispatched", "running", "awaiting_handoff", "paused",
  "completed", "failed", "timed_out", "cancelled", "unknown",
];
const PAYOUTS: PayoutState[] = ["paid", "refunded", "not_paid", "simulated", "unknown"];

describe("phase view", () => {
  it("has a label for every phase", () => {
    for (const p of PHASES) expect(PHASE_VIEW[p]?.label, p).toBeTruthy();
    expect(Object.keys(PHASE_VIEW).sort()).toEqual([...PHASES].sort());
  });

  it("calls completion 'work reported complete', never paid or settled", () => {
    expect(PHASE_VIEW.completed.label).toBe("Work reported complete");
    for (const p of PHASES) expect(PHASE_VIEW[p].label).not.toMatch(/paid|settled|verified/i);
  });

  it("NEGATIVE: an unknown phase never shows a success pulse", () => {
    expect(PHASE_VIEW.unknown.pulse).toBe("offline");
  });
});

describe("payout view", () => {
  it("NEGATIVE: only `paid` is green", () => {
    for (const p of PAYOUTS) {
      expect(PAYOUT_VIEW[p].color, p).toBe(p === "paid" ? "green" : "gray");
    }
  });

  it("says a refund did not pay the operator, and a simulated escrow moved no money", () => {
    expect(PAYOUT_VIEW.refunded.label).toMatch(/operator not paid/);
    expect(PAYOUT_VIEW.simulated.label).toMatch(/no money moved/);
    expect(PAYOUT_VIEW.unknown.label).toMatch(/unknown/i);
  });
});

const settlement = (over: Partial<SettlementAxis>): SettlementAxis => ({
  link: "not_linked",
  linkBasis: null,
  source: "gateway_escrow_record",
  record: null,
  payout: "unknown",
  payoutBasis: null,
  error: null,
  ...over,
});

describe("settlement wording", () => {
  it("names each unusable-link state as what it is", () => {
    expect(settlementLinkText(settlement({ link: "not_linked" }))).toMatch(/No settlement record/);
    expect(settlementLinkText(settlement({ link: "ambiguous" }))).toMatch(/More than one/);
    expect(settlementLinkText(settlement({ link: "unavailable" }))).toMatch(/could not be read/);
  });

  it("explains a step missing from the escrow instead of guessing", () => {
    const text = payoutBasisText(
      settlement({
        link: "linked",
        record: {
          kind: "gateway_escrow_record",
          escrowId: "e",
          contractAddress: "0x1",
          contractVersion: null,
          simulated: false,
          escrow: { sourceStatus: "completed", vocabulary: "escrow_record", tone: "settled", label: "released", known: true },
          milestoneMatch: "step_not_in_escrow",
          milestone: null,
          escrowTotal: { amount: "1", currency: "USDC" },
          createdAt: "2026-09-01T00:00:00Z",
          deadline: "2026-09-02T00:00:00Z",
        },
      }),
    );
    expect(text).toMatch(/no milestone for this job's step/);
  });
});

const evidence = (over: Partial<EvidenceAxis>): EvidenceAxis => ({
  state: "none",
  source: "gateway_evidence_store",
  bundleCount: 0,
  bundles: [],
  truncated: false,
  eventCount: 0,
  fabricatedEventCount: 0,
  latestStoredAt: null,
  error: null,
  ...over,
});

describe("evidence wording", () => {
  it("NEGATIVE: received evidence is labeled not verified", () => {
    expect(evidenceSummaryText(evidence({ state: "received", bundleCount: 2 }))).toBe(
      "2 evidence bundles received (received, not verified).",
    );
  });

  it("NEGATIVE: an unreadable store is not 'no evidence'", () => {
    expect(evidenceSummaryText(evidence({ state: "unavailable", bundleCount: null }))).toBe("Evidence could not be read.");
  });
});

describe("notices", () => {
  it("has text for every notice code", () => {
    for (const code of [
      "job_row_reports_settled",
      "job_row_reports_dispute",
      "fabricated_evidence",
      "simulated_settlement",
      "unknown_execution_status",
    ] as const) {
      expect(NOTICE_TEXT[code], code).toBeTruthy();
    }
  });
});
