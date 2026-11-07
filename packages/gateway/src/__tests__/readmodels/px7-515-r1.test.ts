/**
 * Cross-family review r1 of #515 (rm-px7-515-r1-9980d85b: CLOSED, with a residual MEDIUM), and a
 * regression of #515's own r3 rule found while fixing it. These tests reproduce both at 716ec7b5
 * (#515 restacked onto #389 @c960a661) and pin the replacement rule:
 *   MEDIUM (residual)  the payout still read milestone words outside the milestone record's own
 *                      vocabulary: escrow FUNDED + milestone SETTLED_RELEASED was `reported_released`
 *                      and SETTLED_REFUNDED was `refunded`, in the job execution read, operator work
 *                      and operator income. Such a word now decides nothing: the payout is `unknown`
 *                      (status_unrecognized).
 *   regression         the vocabulary held only the spec's eight EscrowStatus words, but the gateway's
 *                      own writer puts "pending" in the milestone of an escrow it has not funded
 *                      (paid-job-flow.ts, the V2 path: escrow "created", milestones "pending"). That
 *                      real record read funding `unknown`; it reads `not_held` again.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  buildOperatorIncomeDTO,
  buildOperatorWorkDTO,
  type CapabilityLite,
  type KernelJobSource,
  type OperatorWorkSources,
} from "../../readmodels/operator-work.js";
import { buildSettlementAxis, MILESTONE_WORDS, type JobRow, type SettlementSource } from "../../readmodels/job-execution.js";

const AS_OF = "2026-09-24T12:00:00.000Z";
const NOW = Date.parse(AS_OF);
const K1 = { id: "k-1", name: "Shop One", operatorAddress: "0xAbC", location: { lat: 40.7128, lng: -74.006 } };
const CAPS: CapabilityLite[] = [{ id: "cap-fdm", kernelId: "k-1", type: "fdm", name: "FDM printing" }];

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-x", stepId: "step-x", cwmId: "cwm-x", capabilityId: "cap-fdm", kernelId: "k-1", status: "queued",
    startedAt: "2026-09-20T10:00:00.000Z", completedAt: null, progress: 0, assuranceTier: 1, ...over,
  };
}
const escrow = (over: Record<string, unknown> = {}) => ({
  id: "esc-x", cwmId: "cwm-x", contractAddress: "0x3333333333333333333333333333333333333333", totalAmount: "30.00",
  currency: "USDC", status: "funded", createdAt: AS_OF, deadline: AS_OF, version: "v2", ...over,
});
const milestone = (over: Record<string, unknown> = {}) => ({ id: "ms-x", stepId: "step-x", amount: "12.50", status: "funded", ...over });
const linked = (e = escrow(), ms: unknown[] = [milestone()]): SettlementSource => ({
  link: "linked", basis: "negotiation_session_escrow_address", matches: ["negotiation_session_escrow_address"], escrow: e as any, milestones: ms as any,
});
const axis = (e: string, m: string) => buildSettlementAxis(job(), { ok: true, value: linked(escrow({ status: e }), [milestone({ status: m })]) });
const kj = (e: string, m: string): KernelJobSource =>
  ({ job: job(), settlement: axis(e, m), disputes: { ok: true, value: [] } }) as KernelJobSource;
function sources(jobs: KernelJobSource[]): OperatorWorkSources {
  return {
    kernels: [K1],
    capabilities: { ok: true, value: CAPS },
    kernelJobs: { ok: true, value: jobs },
    approvals: { ok: true, value: [] },
    claimedOffers: { ok: true, value: [] },
    openOffers: { ok: true, value: [] },
  };
}
const workItem = (e: string, m: string) =>
  buildOperatorWorkDTO(sources([kj(e, m)]), AS_OF, { limit: 200, offset: 0, nowMs: NOW }).items[0]!;
const incomeRow = (e: string, m: string) => buildOperatorIncomeDTO(sources([kj(e, m)]), AS_OF).rows[0]!;

/** The payout every reader reports for one escrow word and one milestone word. */
function payouts(e: string, m: string) {
  const a = axis(e, m);
  return { axis: a.payout, reason: a.payoutUnknownReason, work: workItem(e, m).payout, income: incomeRow(e, m).payout };
}

describe("MEDIUM (residual, review r1 of #515): a word outside the milestone's vocabulary decides no payout", () => {
  it("the verdict's trace: escrow FUNDED + milestone SETTLED_RELEASED is unknown, not reported_released", () => {
    expect(payouts("FUNDED", "SETTLED_RELEASED")).toEqual({ axis: "unknown", reason: "status_unrecognized", work: "unknown", income: "unknown" });
    expect(workItem("FUNDED", "SETTLED_RELEASED").pay.funding).toBe("unknown");
  });

  it("milestone SETTLED_REFUNDED is unknown, not refunded", () => {
    expect(payouts("FUNDED", "SETTLED_REFUNDED")).toEqual({ axis: "unknown", reason: "status_unrecognized", work: "unknown", income: "unknown" });
  });

  it("an escrow-only or V-next word in the milestone field is unknown, whatever it would mean on the escrow", () => {
    for (const m of ["REFUND_ALLOCATED", "RELEASE_ALLOCATED", "PRIMARY_ASSERTED", "CHALLENGED", "CREATED", "ACTIVE", "COMPLETING", "EXPIRED"]) {
      expect(payouts("FUNDED", m), m).toEqual({ axis: "unknown", reason: "status_unrecognized", work: "unknown", income: "unknown" });
    }
  });

  it("the milestone's own words still decide (positive control)", () => {
    expect(payouts("FUNDED", "released").axis).toBe("reported_released");
    expect(payouts("FUNDED", "refunded").axis).toBe("refunded");
    for (const m of ["funded", "locked", "releasing", "disputed", "slashed", "unfunded"]) expect(payouts("FUNDED", m).axis, m).toBe("not_paid");
    expect(payouts("FUNDED", "completed")).toMatchObject({ axis: "unknown", reason: "status_ambiguous" });
  });
});

describe("regression (r3 of #389): the gateway writer's own milestone words are milestone words", () => {
  it("the V2 writer's unfunded record (escrow created, milestone pending) reads not_held and not_paid", () => {
    const item = workItem("created", "pending");
    expect(item.pay.funding).toBe("not_held");
    expect(item.payout).toBe("not_paid");
    expect(incomeRow("created", "pending").payout).toBe("not_paid");
  });

  it("evidence_submitted, the writer's other word, is not in the canonical money map: unknown, as before", () => {
    expect(payouts("created", "evidence_submitted")).toEqual({ axis: "unknown", reason: "status_unrecognized", work: "unknown", income: "unknown" });
    expect(workItem("created", "evidence_submitted").pay.funding).toBe("unknown");
  });

  it("every word a gateway writer puts in escrow_milestones.status is in MILESTONE_WORDS", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "__tests__" && name !== "node_modules") walk(p);
        } else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(src);
    const written = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const call of text.matchAll(/updateMilestoneStatus\([^,]+,\s*"([^"]+)"\s*\)/g)) written.add(call[1]!);
      for (const insert of text.matchAll(/insertMilestone\(\{([\s\S]*?)\}\)/g)) {
        const status = /\bstatus:\s*([^\n]+)/.exec(insert[1]!);
        for (const word of status?.[1]!.matchAll(/"([^"]+)"/g) ?? []) written.add(word[1]!);
      }
    }
    // Not vacuous: the scan finds the words paid-job-flow.ts writes today.
    for (const known of ["funded", "pending", "evidence_submitted", "released"]) expect(written, known).toContain(known);
    for (const word of written) expect(MILESTONE_WORDS.has(word.trim().toUpperCase()), word).toBe(true);
  });
});
