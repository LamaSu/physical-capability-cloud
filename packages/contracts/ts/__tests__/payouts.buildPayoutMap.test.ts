/**
 * buildPayoutMap tests — Wave 3c LicensingEngine extension implementation.
 *
 * Covers:
 *   1. Empty manifest → trivial 100%-operator case
 *   2. Single integrator @ 50bps → operator gets 9950 residual
 *   3. Three contributors summing to 95bps → operator gets 9905 residual
 *   4. Sum exceeds 10000 → throws
 *   5. Each ContributorRole produces the correct keccak256 roleTag
 *   6. Adoption-indexed schedule with jobsPerDay=10 evaluates correctly
 *   7. Constant schedule at any time evaluates to its bps
 *   8. Breakdown has one row per input contributor with bpsRequested+bpsApplied
 */

import { describe, it, expect } from "vitest";
import { keccak256, stringToHex } from "viem";
import {
  computeManifestHash,
  computeScheduleHash,
  type CompositionEntry,
  type CompositionManifest,
  type CompositionRole,
  type RateSchedule,
  type RateScheduleEvaluationContext,
} from "@pcc/spec";
import { buildPayoutMap, ROLE_TAGS, type Payout } from "../index.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const PUBLISHED = "2026-04-22T00:00:00.000Z";
const NOW = 1_700_000_000;
const CAP_IP_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000aaa" as const;

const ZERO_IP_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

const ADDR = (n: number): `0x${string}` =>
  ("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`;

/**
 * Build a constant-bps RateSchedule that runs from t=0 to forever.
 * Returns a fully-shaped (hash-included) RateSchedule.
 */
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
 * Build an adoption-indexed schedule that runs from t=0 to forever.
 * bps = clamp(scale / sqrt(jobsPerDay), floorBps, capBps).
 */
function adoptionIndexedSchedule(args: {
  scale: number;
  floorBps: number;
  capBps: number;
}): RateSchedule {
  const partial = {
    version: 1 as const,
    segments: [
      {
        kind: "adoption-indexed" as const,
        startTime: 0,
        endTime: null,
        scale: args.scale,
        floorBps: args.floorBps,
        capBps: args.capBps,
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
 * Assemble a CompositionManifest from a list of (role, recipient, schedule, ipId)
 * tuples. Computes the manifestHash deterministically.
 */
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

// ── Tests ────────────────────────────────────────────────────────────────

describe("buildPayoutMap — case 1: empty manifest", () => {
  it("zero entries → empty payouts, operator gets 10000 bps", () => {
    const manifest = makeManifest([]);
    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 100_000_000n,
      capabilityIpId: CAP_IP_ID,
      compositionManifest: manifest,
      evaluationContext: ctx(),
    });
    expect(result.payouts).toEqual([]);
    expect(result.operatorResidualBps).toBe(10000);
    expect(result.breakdown).toEqual([]);
  });
});

describe("buildPayoutMap — case 2: single integrator @ 50bps", () => {
  it("emits one Payout, operator residual = 9950", () => {
    const integratorAddr = ADDR(1);
    const sched = constantSchedule(50);
    const manifest = makeManifest([
      {
        role: "integrator",
        recipient: integratorAddr,
        schedule: sched,
        ipId: "0xintegrator-ip-001",
      },
    ]);
    const byHash = new Map<string, RateSchedule>([
      [sched.scheduleHash, sched],
    ]);

    const result = buildPayoutMap({
      milestoneIndex: 1,
      jobValue: 100_000_000n,
      capabilityIpId: CAP_IP_ID,
      compositionManifest: manifest,
      evaluationContext: ctx(),
      scheduleByHash: byHash,
    });

    expect(result.payouts).toHaveLength(1);
    const p = result.payouts[0];
    expect(p.recipient).toBe(integratorAddr);
    expect(p.bps).toBe(50n);
    expect(p.roleTag).toBe(ROLE_TAGS.integrator);
    // The entry's ipId is not a 32-byte hash, so the row falls back to the
    // capability ipId.
    expect(p.ipId).toBe(CAP_IP_ID);
    expect(result.operatorResidualBps).toBe(9950);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].bpsApplied).toBe(50);
    expect(result.breakdown[0].bpsRequested).toBe(50);
  });
});

describe("buildPayoutMap — case 3: three contributors summing to 95bps", () => {
  it("emits three Payouts, operator residual = 9905", () => {
    const integrator = ADDR(0xaaa1);
    const protocolAuthor = ADDR(0xaaa2);
    const verifier = ADDR(0xaaa3);

    const sIntegrator = constantSchedule(40);
    const sProtocol = constantSchedule(35);
    const sVerifier = constantSchedule(20);

    const manifest = makeManifest([
      {
        role: "integrator",
        recipient: integrator,
        schedule: sIntegrator,
        ipId: "0xip-integrator",
      },
      {
        role: "protocol-author",
        recipient: protocolAuthor,
        schedule: sProtocol,
        ipId: "0xip-protocol",
      },
      {
        role: "verifier",
        recipient: verifier,
        schedule: sVerifier,
        ipId: "0xip-verifier",
      },
    ]);
    const byHash = new Map<string, RateSchedule>([
      [sIntegrator.scheduleHash, sIntegrator],
      [sProtocol.scheduleHash, sProtocol],
      [sVerifier.scheduleHash, sVerifier],
    ]);

    const result = buildPayoutMap({
      milestoneIndex: 2,
      jobValue: 200_000_000n,
      capabilityIpId: CAP_IP_ID,
      compositionManifest: manifest,
      evaluationContext: ctx(),
      scheduleByHash: byHash,
    });

    expect(result.payouts).toHaveLength(3);
    const sum = result.payouts.reduce((a, p) => a + Number(p.bps), 0);
    expect(sum).toBe(95);
    expect(result.operatorResidualBps).toBe(9905);
    // Each Payout's bps and recipient track the corresponding entry order.
    expect(result.payouts[0].recipient).toBe(integrator);
    expect(result.payouts[0].roleTag).toBe(ROLE_TAGS.integrator);
    expect(result.payouts[1].recipient).toBe(protocolAuthor);
    expect(result.payouts[1].roleTag).toBe(ROLE_TAGS["protocol-author"]);
    expect(result.payouts[2].recipient).toBe(verifier);
    expect(result.payouts[2].roleTag).toBe(ROLE_TAGS.verifier);
  });
});

describe("buildPayoutMap — case 4: over-allocation", () => {
  it("throws when sum of bps exceeds 10000", () => {
    const a = ADDR(0xb01);
    const b = ADDR(0xb02);

    // Two 6000bps contributors → sum = 12000 > 10000.
    const sA = constantSchedule(6000);
    const sB = constantSchedule(6000);

    const manifest = makeManifest([
      { role: "integrator", recipient: a, schedule: sA, ipId: "0xa" },
      { role: "model-author", recipient: b, schedule: sB, ipId: "0xb" },
    ]);
    const byHash = new Map<string, RateSchedule>([
      [sA.scheduleHash, sA],
      [sB.scheduleHash, sB],
    ]);

    expect(() =>
      buildPayoutMap({
        milestoneIndex: 0,
        jobValue: 1_000_000n,
        capabilityIpId: CAP_IP_ID,
        compositionManifest: manifest,
        evaluationContext: ctx(),
        scheduleByHash: byHash,
      }),
    ).toThrow(/exceeds 10000/);
  });
});

describe("buildPayoutMap — case 5: every role produces correct keccak256 roleTag", () => {
  // 10 ROLE_TAGS roles + the special-case "pilot" alias.
  const roleCases: Array<{
    role: CompositionRole;
    expectedTag: `0x${string}`;
  }> = [
    { role: "operator", expectedTag: ROLE_TAGS.operator },
    { role: "verifier", expectedTag: ROLE_TAGS.verifier },
    { role: "insurer", expectedTag: ROLE_TAGS.insurer },
    { role: "integrator", expectedTag: ROLE_TAGS.integrator },
    {
      role: "protocol-author",
      expectedTag: ROLE_TAGS["protocol-author"],
    },
    { role: "model-author", expectedTag: ROLE_TAGS["model-author"] },
    {
      role: "dataset-contributor",
      expectedTag: ROLE_TAGS["dataset-contributor"],
    },
    { role: "pilot", expectedTag: ROLE_TAGS["dataset-contributor"] }, // alias
    { role: "curator", expectedTag: ROLE_TAGS.curator },
    { role: "assembler", expectedTag: ROLE_TAGS.assembler },
    { role: "network-treasury", expectedTag: ROLE_TAGS["network-treasury"] },
  ];

  it.each(roleCases)(
    "$role → matches keccak256(role) (or alias)",
    ({ role, expectedTag }) => {
      const recipient = ADDR(0xc0c0);
      const sched = constantSchedule(10);
      const manifest = makeManifest([
        {
          role,
          recipient,
          schedule: sched,
          ipId: `0xip-${role}`,
        },
      ]);
      const byHash = new Map<string, RateSchedule>([
        [sched.scheduleHash, sched],
      ]);

      const result = buildPayoutMap({
        milestoneIndex: 0,
        jobValue: 1_000_000n,
        capabilityIpId: CAP_IP_ID,
        compositionManifest: manifest,
        evaluationContext: ctx(),
        scheduleByHash: byHash,
      });

      expect(result.payouts).toHaveLength(1);
      expect(result.payouts[0].roleTag).toBe(expectedTag);
    },
  );

  it("matches viem keccak256(stringToHex(role)) reference for canonical roles", () => {
    expect(ROLE_TAGS.operator).toBe(keccak256(stringToHex("operator")));
    expect(ROLE_TAGS.integrator).toBe(keccak256(stringToHex("integrator")));
    expect(ROLE_TAGS["model-author"]).toBe(
      keccak256(stringToHex("model-author")),
    );
  });
});

describe("buildPayoutMap — case 6: adoption-indexed schedule with jobsPerDay=10", () => {
  it("evaluates per the schedule's curve", () => {
    // bps = clamp(1000 / sqrt(jobsPerDay), 50, 500)
    // jobsPerDay=10 → 1000 / 3.162 ≈ 316.23 → rounded to 316 (clamped within [50, 500])
    const sched = adoptionIndexedSchedule({
      scale: 1000,
      floorBps: 50,
      capBps: 500,
    });
    const recipient = ADDR(0xd00d);
    const manifest = makeManifest([
      {
        role: "integrator",
        recipient,
        schedule: sched,
        ipId: "0xip-d",
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
      evaluationContext: ctx({ jobsPerDay: 10 }),
      scheduleByHash: byHash,
    });

    expect(result.payouts).toHaveLength(1);
    // 1000 / sqrt(10) = 316.227766 → Math.round = 316.
    expect(Number(result.payouts[0].bps)).toBe(316);
    expect(result.operatorResidualBps).toBe(10000 - 316);
  });

  it("uses capBps when jobsPerDay is 0 (no jobs)", () => {
    const sched = adoptionIndexedSchedule({
      scale: 1000,
      floorBps: 50,
      capBps: 500,
    });
    const recipient = ADDR(0xd00e);
    const manifest = makeManifest([
      {
        role: "integrator",
        recipient,
        schedule: sched,
        ipId: "0xip-e",
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
      evaluationContext: ctx({ jobsPerDay: 0 }),
      scheduleByHash: byHash,
    });

    expect(Number(result.payouts[0].bps)).toBe(500);
  });
});

describe("buildPayoutMap — case 7: constant schedule at any time → its bps", () => {
  const recipient = ADDR(0xfeed);

  it.each([
    { now: 0, label: "epoch" },
    { now: 1000, label: "1k seconds in" },
    { now: 1_700_000_000, label: "April 2026" },
    { now: 2_000_000_000, label: "May 2033" },
  ])("now=$now ($label) evaluates to schedule bps (250)", ({ now }) => {
    const sched = constantSchedule(250);
    const manifest = makeManifest([
      {
        role: "model-author",
        recipient,
        schedule: sched,
        ipId: "0xip-feed",
      },
    ]);
    const byHash = new Map<string, RateSchedule>([
      [sched.scheduleHash, sched],
    ]);
    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 1_000_000n,
      capabilityIpId: CAP_IP_ID,
      compositionManifest: manifest,
      evaluationContext: ctx({ now }),
      scheduleByHash: byHash,
    });
    expect(Number(result.payouts[0].bps)).toBe(250);
    expect(result.operatorResidualBps).toBe(9750);
  });
});

describe("buildPayoutMap — case 8: breakdown row per input contributor", () => {
  it("produces one breakdown row per CompositionEntry, with bpsRequested + bpsApplied", () => {
    const a = ADDR(0xa1);
    const b = ADDR(0xb1);
    const c = ADDR(0xc1);

    // a: 100bps schedule, no group → applied 100
    // b: 200bps schedule, groupBps 5000 → applied 100 (200 * 5000 / 10000)
    // c: 0bps schedule (covers t<startTime so no bps) → applied 0, included in breakdown

    const sA = constantSchedule(100);
    const sB = constantSchedule(200);
    // schedule that doesn't cover NOW (start far in the future) → 0 bps
    const sC: RateSchedule = (() => {
      const partial = {
        version: 1 as const,
        segments: [
          {
            kind: "constant" as const,
            startTime: NOW + 1_000_000,
            endTime: null,
            bps: 999,
          },
        ],
        publishedAt: PUBLISHED,
      };
      return { ...partial, scheduleHash: computeScheduleHash(partial) };
    })();

    const manifest = makeManifest([
      { role: "integrator", recipient: a, schedule: sA, ipId: "0xa" },
      {
        role: "protocol-author",
        recipient: b,
        schedule: sB,
        ipId: "0xb",
        groupBps: 5000,
      },
      { role: "curator", recipient: c, schedule: sC, ipId: "0xc" },
    ]);

    const byHash = new Map<string, RateSchedule>([
      [sA.scheduleHash, sA],
      [sB.scheduleHash, sB],
      [sC.scheduleHash, sC],
    ]);

    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 1_000_000n,
      capabilityIpId: CAP_IP_ID,
      compositionManifest: manifest,
      evaluationContext: ctx(),
      scheduleByHash: byHash,
    });

    expect(result.breakdown).toHaveLength(3);
    expect(result.breakdown[0]).toMatchObject({
      recipient: a,
      role: "integrator",
      bpsRequested: 100,
      bpsApplied: 100,
    });
    expect(result.breakdown[1]).toMatchObject({
      recipient: b,
      role: "protocol-author",
      bpsRequested: 200,
      bpsApplied: 100,
    });
    expect(result.breakdown[2]).toMatchObject({
      recipient: c,
      role: "curator",
      bpsRequested: 0,
      bpsApplied: 0,
    });

    // Only two Payouts (c was zero, so skipped).
    expect(result.payouts).toHaveLength(2);
    expect(result.operatorResidualBps).toBe(10000 - 100 - 100);
  });
});

// ── Resolver fallbacks (defensive) ───────────────────────────────────────

describe("buildPayoutMap — resolver fallbacks", () => {
  it("falls back to scheduleByIpId when scheduleByHash misses", () => {
    const recipient = ADDR(0xfa11);
    const sched = constantSchedule(75);
    const manifest = makeManifest([
      {
        role: "integrator",
        recipient,
        schedule: sched,
        ipId: "0xip-fallback",
      },
    ]);
    const byIpId = new Map<string, RateSchedule>([
      ["0xip-fallback", sched],
    ]);

    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 1_000_000n,
      capabilityIpId: CAP_IP_ID,
      compositionManifest: manifest,
      evaluationContext: ctx(),
      scheduleByIpId: byIpId,
    });

    expect(result.payouts).toHaveLength(1);
    expect(Number(result.payouts[0].bps)).toBe(75);
  });

  it("emits 0 bps when neither resolver knows the schedule (operator gets 100%)", () => {
    const recipient = ADDR(0xdead);
    const sched = constantSchedule(50);
    const manifest = makeManifest([
      {
        role: "integrator",
        recipient,
        schedule: sched,
        ipId: "0xip-orphan",
      },
    ]);

    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 1_000_000n,
      capabilityIpId: CAP_IP_ID,
      compositionManifest: manifest,
      evaluationContext: ctx(),
      // No resolvers supplied.
    });

    expect(result.payouts).toEqual([]);
    expect(result.operatorResidualBps).toBe(10000);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].bpsApplied).toBe(0);
  });
});

// ── Defensive type echoes (compile-time) ─────────────────────────────────

describe("buildPayoutMap — type echoes", () => {
  it("a Payout literal compiles + matches the expected shape", () => {
    const p: Payout = {
      recipient: ADDR(1),
      bps: 50n,
      roleTag: ROLE_TAGS.integrator,
      ipId: ZERO_IP_ID,
    };
    expect(p.bps).toBe(50n);
  });
});
