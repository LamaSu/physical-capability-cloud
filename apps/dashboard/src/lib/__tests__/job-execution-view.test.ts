/**
 * JobExecutionDTO presentation (PX-6). The page projects the DTO; these tests pin the
 * wording and color rules so a surface cannot quietly turn completion into payment or
 * evidence into verification.
 */
import { describe, it, expect } from "vitest";
import type { EvidenceAxis, ExecutionPhase, MoneyStateView, PayoutState, SettlementAxis } from "@pcc/spec";
import { MONEY_STATUS_MAP } from "@pcc/spec";
import {
  JOB_EXECUTION_REFRESH_MS,
  JOB_EXECUTION_TERMINAL_REFRESH_MS,
  NOTICE_TEXT,
  PAYOUT_VIEW,
  PHASE_VIEW,
  evidenceSummaryText,
  freshness,
  payoutBasisText,
  recordStatusBadge,
  settlementLinkText,
} from "../job-execution-view.js";

const PHASES: ExecutionPhase[] = [
  "pending", "queued", "dispatched", "running", "awaiting_handoff", "paused",
  "completed", "failed", "timed_out", "cancelled", "unknown",
];
const PAYOUTS: PayoutState[] = ["paid", "reported_released", "refunded", "not_paid", "simulated", "unknown"];

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

  it("NEGATIVE (design #2510): no work phase uses a success or animated-online color", () => {
    for (const p of PHASES) {
      expect(["completed", "online"], p).not.toContain(PHASE_VIEW[p].pulse);
    }
  });
});

describe("payout view", () => {
  it("NEGATIVE: only `paid` is green", () => {
    for (const p of PAYOUTS) {
      expect(PAYOUT_VIEW[p].color, p).toBe(p === "paid" ? "green" : "gray");
    }
  });

  it("NEGATIVE (PX-1): a recorded release is gray and says it is not confirmed", () => {
    expect(PAYOUT_VIEW.reported_released.color).toBe("gray");
    expect(PAYOUT_VIEW.reported_released.label).toMatch(/not confirmed/);
    expect(Object.keys(PAYOUT_VIEW).sort()).toEqual([...PAYOUTS].sort());
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
  linkMatches: [],
  source: "gateway_escrow_record",
  record: null,
  payout: "unknown",
  payoutBasis: null,
  payoutConfirmation: null,
  error: null,
  ...over,
});

const view = (sourceStatus: string, tone: MoneyStateView["tone"], label: string | null): MoneyStateView => ({
  sourceStatus,
  vocabulary: "escrow_milestone",
  tone,
  label,
  known: label !== null,
});

describe("record badges (review P1-4)", () => {
  it("NEGATIVE: every recorded status renders neutral, whatever its tone, simulated or not", () => {
    for (const [key, e] of Object.entries(MONEY_STATUS_MAP)) {
      for (const simulated of [false, true]) {
        expect(recordStatusBadge(view(key.toLowerCase(), e.tone, e.label), simulated).color, `${key}/${simulated}`).toBe("gray");
      }
    }
    expect(recordStatusBadge(view("weird", "unknown", null), false)).toEqual({ color: "gray", label: 'unrecognized status "weird"' });
  });

  it("labels a simulated escrow's statuses as simulated", () => {
    expect(recordStatusBadge(view("released", "settled", "payment sent to operator"), true).label).toBe(
      "Simulated: payment sent to operator",
    );
  });
});

describe("freshness (review P2)", () => {
  const t0 = Date.parse("2026-09-24T12:00:00.000Z");
  it("a failed refresh is stale", () => {
    expect(freshness("2026-09-24T12:00:00.000Z", t0, false, true)).toEqual({ stale: true, reason: "refresh_failed" });
  });
  it("a read older than two intervals is stale, for finished jobs too", () => {
    expect(freshness("2026-09-24T12:00:00.000Z", t0 + 2 * JOB_EXECUTION_REFRESH_MS + 1, false, false).reason).toBe("too_old");
    expect(freshness("2026-09-24T12:00:00.000Z", t0 + 2 * JOB_EXECUTION_TERMINAL_REFRESH_MS + 1, true, false).reason).toBe("too_old");
    expect(freshness("2026-09-24T12:00:00.000Z", t0 + JOB_EXECUTION_REFRESH_MS, false, false)).toEqual({ stale: false, reason: null });
  });
  it("an unparseable read time is stale", () => {
    expect(freshness("not a date", t0, false, false).stale).toBe(true);
  });
});

describe("settlement wording", () => {
  it("names each unusable-link state as what it is", () => {
    expect(settlementLinkText(settlement({ link: "not_linked" }))).toMatch(/No settlement record/);
    expect(settlementLinkText(settlement({ link: "ambiguous" }))).toMatch(/More than one/);
    expect(settlementLinkText(settlement({ link: "conflicting" }))).toMatch(/disagree/);
    expect(settlementLinkText(settlement({ link: "unavailable" }))).toMatch(/could not be read/);
  });

  const linkedRecord = (over: Record<string, unknown>) =>
    settlement({
      link: "linked",
      record: {
        kind: "gateway_escrow_record",
        escrowId: "e",
        contractAddress: "0x1",
        contractVersion: null,
        simulated: false,
        escrow: { sourceStatus: "active", vocabulary: "escrow_record", tone: "running", label: "active", known: true },
        milestoneMatch: "exact",
        milestone: null,
        escrowTotal: { amount: "1", currency: "USDC" },
        createdAt: "2026-09-01T00:00:00Z",
        deadline: "2026-09-02T00:00:00Z",
        statusObservedAt: null,
      },
      ...over,
    } as any);

  it("qualifies a recorded release as unconfirmed by any settlement read or chain receipt", () => {
    expect(
      payoutBasisText(linkedRecord({ payout: "reported_released", payoutBasis: "milestone_record", payoutConfirmation: "record_only" })),
    ).toMatch(/No settlement read or chain receipt confirms it/);
  });

  it("says when the milestone and escrow records disagree", () => {
    expect(payoutBasisText(linkedRecord({ payout: "unknown", payoutBasis: "milestone_record" }))).toMatch(/disagree/);
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
          statusObservedAt: null,
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
      "settlement_records_conflict",
      "settlement_link_conflict",
    ] as const) {
      expect(NOTICE_TEXT[code], code).toBeTruthy();
    }
  });
});
