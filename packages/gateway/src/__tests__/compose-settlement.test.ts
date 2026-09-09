/**
 * Compose settlement (Lane 2 DRAFT) tests — the per-leg escrow wire.
 *
 * Covers:
 *   - planCompositionLegs: leg↔milestone mapping, per-leg stepId/jobId
 *     bindings, unit conversion, tier clamping, and the two skip reasons
 *     (invalid operator address — incl. graph-search's "" — and zero price).
 *   - createCompositionEscrow (mock mode): plan shape + escrow DB row
 *     (version "v3"), and the no-settleable-legs throw.
 *   - executeComposition integration: settlement plan attached when the flag
 *     is on; FAIL CLOSED (no steps run) when escrow creation fails; and the
 *     regression guard that default behavior (flag off) is byte-identical.
 *
 * Real-chain paths (createEscrowV3 / addMilestone / fund) are exercised by
 * packages/contracts/test/MilestoneEscrowV3.composition.t.sol (forge) — this
 * file stays chain-free.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { keccak256, toBytes } from "viem";
import {
  planCompositionLegs,
  createCompositionEscrow,
  isComposeSettlementEnabled,
  legJobId,
  legStepId,
} from "../services/compose-settlement.js";
import {
  executeComposition,
  _clearComposeForTests,
} from "../routes/compose.js";
import { getRepos } from "../db.js";
import type { ComposeResponse, CompositionStep } from "@pcc/spec";

// ── Fixtures ────────────────────────────────────────────────────────────────

const OP = (n: number): string =>
  `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

function makeStep(
  index: number,
  over: Partial<CompositionStep> = {},
): CompositionStep {
  return {
    index,
    capabilityType: over.capabilityType ?? "3d-printing",
    capabilityId: over.capabilityId ?? `cap-${index}`,
    kernelId: over.kernelId ?? `k-${index}`,
    operatorAddress: over.operatorAddress ?? OP(index + 1),
    estimatedPriceUSD: over.estimatedPriceUSD ?? 10,
    estimatedDurationMs: over.estimatedDurationMs ?? 1_000,
    assuranceTier: over.assuranceTier ?? 1,
    dependsOn: index === 0 ? [] : [index - 1],
    reputation: over.reputation,
  };
}

function makeComposition(steps: CompositionStep[]): ComposeResponse {
  const totalPriceUSD = steps.reduce((s, x) => s + x.estimatedPriceUSD, 0);
  return {
    compositionId: `cmp_test_${Math.random().toString(36).slice(2, 10)}`,
    status: "proposed",
    steps,
    totalPriceUSD,
    totalDurationMs: steps.reduce((s, x) => s + x.estimatedDurationMs, 0),
    effectiveAssuranceTier: 1,
    budgetUSD: 1_000,
    budgetRemainingUSD: 1_000 - totalPriceUSD,
    optimizedFor: "price",
    proposedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  } as ComposeResponse;
}

// ── Env hygiene ─────────────────────────────────────────────────────────────

const SAVED = {
  settlement: process.env.PCC_COMPOSE_SETTLEMENT,
  mock: process.env.MOCK_SETTLEMENT,
  real: process.env.PCC_COMPOSE_EXECUTE_REAL,
};

beforeEach(() => {
  _clearComposeForTests();
  delete process.env.PCC_COMPOSE_SETTLEMENT;
  delete process.env.MOCK_SETTLEMENT; // default = mock ON
  delete process.env.PCC_COMPOSE_EXECUTE_REAL;
});

afterEach(() => {
  if (SAVED.settlement === undefined) delete process.env.PCC_COMPOSE_SETTLEMENT;
  else process.env.PCC_COMPOSE_SETTLEMENT = SAVED.settlement;
  if (SAVED.mock === undefined) delete process.env.MOCK_SETTLEMENT;
  else process.env.MOCK_SETTLEMENT = SAVED.mock;
  if (SAVED.real === undefined) delete process.env.PCC_COMPOSE_EXECUTE_REAL;
  else process.env.PCC_COMPOSE_EXECUTE_REAL = SAVED.real;
});

// ── planCompositionLegs ─────────────────────────────────────────────────────

describe("planCompositionLegs", () => {
  it("maps every settleable step onto a milestone in order", () => {
    const c = makeComposition([
      makeStep(0, { estimatedPriceUSD: 50 }),
      makeStep(1, { estimatedPriceUSD: 30, assuranceTier: 2 }),
      makeStep(2, { estimatedPriceUSD: 20 }),
    ]);
    const { legs, skipped } = planCompositionLegs(c);

    expect(skipped).toEqual([]);
    expect(legs).toHaveLength(3);
    expect(legs.map((l) => l.milestoneIndex)).toEqual([0, 1, 2]);
    expect(legs.map((l) => l.stepIndex)).toEqual([0, 1, 2]);

    // Per-leg bindings — the on-chain replay-guard inputs.
    expect(legs[0]!.jobId).toBe(`${c.compositionId}:0`);
    expect(legs[0]!.stepId).toBe(
      keccak256(toBytes(`${c.compositionId}:0`)),
    );
    expect(legs[1]!.jobId).toBe(legJobId(c.compositionId, 1));
    expect(legs[1]!.stepId).toBe(legStepId(c.compositionId, 1));

    // Each leg pays ITS OWN operator, at its quoted price (USDC 6dp units).
    expect(legs[0]!.operator).toBe(OP(1));
    expect(legs[1]!.operator).toBe(OP(2));
    expect(legs[0]!.amountUnits).toBe((50_000_000).toString());
    expect(legs[2]!.amountUnits).toBe((20_000_000).toString());
    expect(legs[1]!.requiredTier).toBe(2);
  });

  it("skips legs without a valid 0x operator address (graph-search steps)", () => {
    const c = makeComposition([
      makeStep(0),
      // graph-search-planned steps carry operatorAddress "" (compose.ts
      // graphStepToCompositionStep) — unsettleable until operator resolution.
      makeStep(1, { operatorAddress: "" }),
      // email-style operator ids (the scaffold candidate default) are DB
      // agent ids, not on-chain addresses.
      makeStep(2, { operatorAddress: "op_x@example.com" }),
    ]);
    const { legs, skipped } = planCompositionLegs(c);

    expect(legs).toHaveLength(1);
    expect(legs[0]!.stepIndex).toBe(0);
    // milestone indexes stay contiguous over settleable legs only
    expect(legs[0]!.milestoneIndex).toBe(0);
    expect(skipped).toEqual([
      { stepIndex: 1, reason: "no_valid_operator_address" },
      { stepIndex: 2, reason: "no_valid_operator_address" },
    ]);
  });

  it("skips zero/negative-price legs and clamps loose tiers", () => {
    const c = makeComposition([
      makeStep(0, { estimatedPriceUSD: 0 }),
      makeStep(1, { estimatedPriceUSD: 12.345678912, assuranceTier: 9 as never }),
    ]);
    const { legs, skipped } = planCompositionLegs(c);

    expect(skipped).toEqual([{ stepIndex: 0, reason: "zero_or_negative_price" }]);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.requiredTier).toBe(0); // out-of-range never over-reports
    expect(legs[0]!.amountUSD).toBe("12.345679"); // 6dp clamp
    expect(legs[0]!.amountUnits).toBe("12345679");
  });
});

// ── createCompositionEscrow (mock mode) ─────────────────────────────────────

describe("createCompositionEscrow (mock)", () => {
  it("returns a funded mock plan and records the v3 escrow row", async () => {
    const c = makeComposition([makeStep(0), makeStep(1)]);
    const plan = await createCompositionEscrow(c);

    expect(plan.mode).toBe("mock");
    expect(plan.compositionId).toBe(c.compositionId);
    expect(plan.escrowAddress).toMatch(/^mock-escrow-/);
    expect(plan.fundTxHash).toBeNull();
    expect(plan.legs).toHaveLength(2);
    expect(plan.skippedLegs).toEqual([]);
    expect(plan.cwmId).toBe(keccak256(toBytes(`pcc-comp-${c.compositionId}`)));

    // DB row present with V3 dispatch marker — escrow routes/facades pick the
    // V3 write helpers off this column (escrow.ts resolveEscrowVersion).
    const row = getRepos().escrows.findByContractAddress(plan.escrowAddress);
    expect(row).toBeTruthy();
    expect(row!.version).toBe("v3");
    expect(row!.cwmId).toBe(`comp-${c.compositionId}`);
    expect(row!.status).toBe("funded");
  });

  it("throws (fail closed) when no leg is settleable", async () => {
    const c = makeComposition([
      makeStep(0, { operatorAddress: "" }),
      makeStep(1, { estimatedPriceUSD: 0 }),
    ]);
    await expect(createCompositionEscrow(c)).rejects.toThrow(/no settleable legs/);
  });
});

// ── executeComposition integration ──────────────────────────────────────────

describe("executeComposition + settlement flag", () => {
  it("is disabled by default — settlement stays undefined (regression guard)", async () => {
    expect(isComposeSettlementEnabled()).toBe(false);
    const c = makeComposition([makeStep(0), makeStep(1)]);
    const result = await executeComposition(c);

    expect(result.status).toBe("completed");
    expect(result.stepsExecuted).toBe(2);
    expect(result.settlement).toBeUndefined();
  });

  it("attaches the per-leg escrow plan and still runs every step", async () => {
    process.env.PCC_COMPOSE_SETTLEMENT = "true";
    const c = makeComposition([makeStep(0), makeStep(1), makeStep(2)]);
    const result = await executeComposition(c);

    expect(result.status).toBe("completed");
    expect(result.stepsExecuted).toBe(3);
    expect(result.settlement).toBeTruthy();
    expect(result.settlement!.error).toBeNull();
    expect(result.settlement!.plan!.legs).toHaveLength(3);
    expect(result.settlement!.plan!.legs.map((l) => l.milestoneIndex)).toEqual([
      0, 1, 2,
    ]);
    // Leg-to-operator mapping preserved end-to-end.
    expect(result.settlement!.plan!.legs[2]!.operator).toBe(OP(3));
  });

  it("fails CLOSED when escrow creation fails: no steps run, error surfaced", async () => {
    process.env.PCC_COMPOSE_SETTLEMENT = "true";
    // Nothing settleable → createCompositionEscrow throws → execution must
    // not run steps whose pay could not be escrowed.
    const c = makeComposition([makeStep(0, { operatorAddress: "" })]);
    const result = await executeComposition(c);

    expect(result.status).toBe("failed");
    expect(result.stepsExecuted).toBe(0);
    expect(result.failedStepIndex).toBeNull();
    expect(result.deltasApplied).toEqual([]);
    expect(result.settlement!.plan).toBeNull();
    expect(result.settlement!.error).toMatch(/no settleable legs/);
  });
});
