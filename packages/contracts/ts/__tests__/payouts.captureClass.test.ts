/**
 * buildPayoutMap captureClass plumbing tests.
 *
 * Verifies that the captureClass dimension on RateScheduleEvaluationContext
 * (added by impl-captureclass-charlie) flows correctly through buildPayoutMap
 * into per-entry RateSchedule evaluation. Three scenarios:
 *
 *   1. Manifest with one capture-class-indexed entry, captureClass=CC3
 *      → emits Payout at byClass[CC3] bps.
 *   2. Same manifest, captureClass omitted (legacy / non-CVP job)
 *      → emits Payout at the schedule's `default` bps.
 *   3. Mixed manifest: one constant entry + one capture-class-indexed entry
 *      → both Payouts emitted with the correct bps; sums to operator
 *      residual correctly.
 */

import { describe, it, expect } from "vitest";
import {
  computeManifestHash,
  computeScheduleHash,
  CaptureClass,
  type CompositionEntry,
  type CompositionManifest,
  type CompositionRole,
  type RateSchedule,
  type RateScheduleEvaluationContext,
} from "@pcc/spec";
import { buildPayoutMap, ROLE_TAGS } from "../index.js";

// ── Fixtures (mirror packages/contracts/ts/__tests__/payouts.buildPayoutMap.test.ts) ──

const PUBLISHED = "2026-04-22T00:00:00.000Z";
const NOW = 1_700_000_000;
const CAP_IP_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000aaa" as const;

const ADDR = (n: number): `0x${string}` =>
  ("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`;

function constantSchedule(bps: number): RateSchedule {
  const partial = {
    version: 1 as const,
    segments: [
      {
        kind: "constant" as const,
        startTime: 0,
        endTime: null,
        bps,
      },
    ],
    publishedAt: PUBLISHED,
  };
  return {
    ...partial,
    scheduleHash: computeScheduleHash(partial),
  };
}

/**
 * A capture-class-indexed schedule pinning bps for CC3+ and falling back to
 * a smaller `default` for unpinned classes / missing captureClass.
 */
function classIndexedSchedule(args: {
  byClass: Partial<Record<CaptureClass, number>>;
  default: number;
}): RateSchedule {
  const partial = {
    version: 1 as const,
    segments: [
      {
        kind: "capture-class-indexed" as const,
        startTime: 0,
        endTime: null,
        byClass: args.byClass,
        default: args.default,
      },
    ],
    publishedAt: PUBLISHED,
  };
  return {
    ...partial,
    scheduleHash: computeScheduleHash(partial),
  };
}

function makeManifest(
  rows: Array<{
    role: CompositionRole;
    recipient: `0x${string}`;
    schedule: RateSchedule;
    ipId: string;
    groupBps?: number;
  }>,
  capabilityIpId: string = CAP_IP_ID,
): CompositionManifest {
  const entries: CompositionEntry[] = rows.map((r) => ({
    ipId: r.ipId,
    role: r.role,
    contributorAddress: r.recipient,
    rateScheduleHash: r.schedule.scheduleHash,
    ...(r.groupBps !== undefined ? { groupBps: r.groupBps } : {}),
  }));
  const partial = {
    capabilityIpId,
    entries,
    builtAt: PUBLISHED,
  };
  return {
    ...partial,
    manifestHash: computeManifestHash(partial),
  };
}

const ctx = (
  overrides: Partial<RateScheduleEvaluationContext> = {},
): RateScheduleEvaluationContext => ({
  now: NOW,
  jobValueCents: 1000,
  jobsPerDay: 100,
  ...overrides,
});

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("buildPayoutMap — captureClass plumbing", () => {
  it("with captureClass=CC3 evaluates capture-class-indexed schedule correctly", () => {
    const recipient = ADDR(0xc3c3);
    // CC0:50, CC1:100, CC2:150, CC3:300, CC4:400, CC5:500, default:75
    const sched = classIndexedSchedule({
      byClass: { CC0: 50, CC1: 100, CC2: 150, CC3: 300, CC4: 400, CC5: 500 },
      default: 75,
    });
    const manifest = makeManifest([
      {
        role: "verifier",
        recipient,
        schedule: sched,
        ipId: "0xip-cc3",
      },
    ]);
    const byHash = new Map<string, RateSchedule>([
      [sched.scheduleHash, sched],
    ]);

    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 100_000_000n,
      capabilityIpId: CAP_IP_ID,
      compositionManifest: manifest,
      evaluationContext: ctx({ captureClass: CaptureClass.CC3 }),
      scheduleByHash: byHash,
    });

    expect(result.payouts).toHaveLength(1);
    const p = result.payouts[0];
    expect(p.recipient).toBe(recipient);
    expect(p.bps).toBe(300n);
    expect(p.roleTag).toBe(ROLE_TAGS.verifier);
    expect(result.operatorResidualBps).toBe(10000 - 300);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].bpsApplied).toBe(300);
  });

  it("without captureClass falls back to schedule.default bps", () => {
    const recipient = ADDR(0xdef0);
    const sched = classIndexedSchedule({
      byClass: { CC3: 300, CC4: 400, CC5: 500 },
      default: 75,
    });
    const manifest = makeManifest([
      {
        role: "verifier",
        recipient,
        schedule: sched,
        ipId: "0xip-default",
      },
    ]);
    const byHash = new Map<string, RateSchedule>([
      [sched.scheduleHash, sched],
    ]);

    // Note: ctx() omits captureClass entirely (legacy / non-CVP job).
    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 100_000_000n,
      capabilityIpId: CAP_IP_ID,
      compositionManifest: manifest,
      evaluationContext: ctx(),
      scheduleByHash: byHash,
    });

    expect(result.payouts).toHaveLength(1);
    expect(result.payouts[0].bps).toBe(75n);
    expect(result.operatorResidualBps).toBe(10000 - 75);
  });

  it("with captureClass not pinned in byClass falls back to default", () => {
    const recipient = ADDR(0xfa11);
    // Sparse: only CC3+ pinned.
    const sched = classIndexedSchedule({
      byClass: { CC3: 300, CC4: 400, CC5: 500 },
      default: 75,
    });
    const manifest = makeManifest([
      {
        role: "verifier",
        recipient,
        schedule: sched,
        ipId: "0xip-fallback",
      },
    ]);
    const byHash = new Map<string, RateSchedule>([
      [sched.scheduleHash, sched],
    ]);

    // CC0 is supplied but NOT in byClass — must hit `default`.
    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 100_000_000n,
      capabilityIpId: CAP_IP_ID,
      compositionManifest: manifest,
      evaluationContext: ctx({ captureClass: CaptureClass.CC0 }),
      scheduleByHash: byHash,
    });

    expect(result.payouts[0].bps).toBe(75n);
  });

  it("mixed segment kinds (constant + capture-class-indexed) sum correctly", () => {
    // One constant 100bps integrator + one capture-indexed verifier.
    // At captureClass=CC4 the verifier earns 400. Sum = 500. Op residual = 9500.
    const integrator = ADDR(0xa01);
    const verifier = ADDR(0xb02);

    const sIntegrator = constantSchedule(100);
    const sVerifier = classIndexedSchedule({
      byClass: { CC0: 50, CC1: 100, CC2: 150, CC3: 300, CC4: 400, CC5: 500 },
      default: 75,
    });

    const manifest = makeManifest([
      {
        role: "integrator",
        recipient: integrator,
        schedule: sIntegrator,
        ipId: "0xip-integrator-mix",
      },
      {
        role: "verifier",
        recipient: verifier,
        schedule: sVerifier,
        ipId: "0xip-verifier-mix",
      },
    ]);
    const byHash = new Map<string, RateSchedule>([
      [sIntegrator.scheduleHash, sIntegrator],
      [sVerifier.scheduleHash, sVerifier],
    ]);

    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 1_000_000n,
      capabilityIpId: CAP_IP_ID,
      compositionManifest: manifest,
      evaluationContext: ctx({ captureClass: CaptureClass.CC4 }),
      scheduleByHash: byHash,
    });

    expect(result.payouts).toHaveLength(2);
    // Integrator unchanged regardless of captureClass.
    expect(result.payouts[0].recipient).toBe(integrator);
    expect(result.payouts[0].bps).toBe(100n);
    // Verifier uses CC4 → 400.
    expect(result.payouts[1].recipient).toBe(verifier);
    expect(result.payouts[1].bps).toBe(400n);

    expect(result.operatorResidualBps).toBe(10000 - 100 - 400);
  });

  it("same mixed manifest with captureClass=CC0 → verifier earns 50, sum = 150", () => {
    // Sanity check: dropping the captureClass (or supplying a low one) must
    // mean the verifier slot earns less and the operator keeps more.
    const integrator = ADDR(0xa03);
    const verifier = ADDR(0xb04);

    const sIntegrator = constantSchedule(100);
    const sVerifier = classIndexedSchedule({
      byClass: { CC0: 50, CC1: 100, CC2: 150, CC3: 300, CC4: 400, CC5: 500 },
      default: 75,
    });

    const manifest = makeManifest([
      {
        role: "integrator",
        recipient: integrator,
        schedule: sIntegrator,
        ipId: "0xip-integrator-low",
      },
      {
        role: "verifier",
        recipient: verifier,
        schedule: sVerifier,
        ipId: "0xip-verifier-low",
      },
    ]);
    const byHash = new Map<string, RateSchedule>([
      [sIntegrator.scheduleHash, sIntegrator],
      [sVerifier.scheduleHash, sVerifier],
    ]);

    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 1_000_000n,
      capabilityIpId: CAP_IP_ID,
      compositionManifest: manifest,
      evaluationContext: ctx({ captureClass: CaptureClass.CC0 }),
      scheduleByHash: byHash,
    });

    expect(result.payouts).toHaveLength(2);
    expect(result.payouts[1].bps).toBe(50n);
    expect(result.operatorResidualBps).toBe(10000 - 100 - 50);
  });
});
