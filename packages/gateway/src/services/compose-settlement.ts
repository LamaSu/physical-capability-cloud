/**
 * Compose settlement — the per-leg escrow wire for executeComposition (Lane 2).
 *
 * ── DRAFT / PROPOSE — DO NOT ENABLE IN PROD WITHOUT OWNER SIGN-OFF ──────────
 * Escrow shape decided (pending sign-off) in
 * ai/research/industry-pain-points/lane2-escrow-shape-ADR.md — OPTION A:
 * ONE MilestoneEscrowV3 per composition, ONE milestone per composed leg, each
 * leg released independently on ITS OWN evidence through the oracle-attested
 * Mode-B path (Mode-A was removed per settlement-decisions.md D1-D3).
 *
 * What this module does:
 *   1. planCompositionLegs()    — pure: CompositionStep[] → per-leg milestone
 *      specs (operator, amount, stepId/jobId bindings). Legs without a valid
 *      on-chain operator address (e.g. graph-search-planned steps, which carry
 *      operatorAddress "") or with a zero price are SKIPPED with a reason.
 *   2. createCompositionEscrow() — create + fund the per-composition escrow:
 *      createEscrowV3 → addMilestone per leg (each leg's operator is that
 *      milestone's payout recipient) → approve + fund upfront. Mirrors the
 *      proven createJobFromSession V3 ceremony (paid-job-flow.ts) including
 *      withSignerLock serialization and receipt-confirmed writes.
 *   3. settleCompositionLeg()   — per-leg evidence submission (submitEvidenceV3
 *      on the leg's milestoneIndex). Attestation minting + binding + release
 *      ride the EXISTING oracle machinery (verifyWithOracle → submitAttestationV3
 *      → challenge window → release via crank/resume), exactly as the paid-job
 *      /complete handler does for single jobs — but keyed by the leg's index.
 *
 * FLAGGED DEPENDENCY (do not remove this note until resolved): the completion
 * signal that carries (compositionId, stepIndex) from a submitted job back to
 * the gateway — `parameters.__pccStep` + the async completion-time settle —
 * lives on branch feat/composition-preflight-gate and is NOT yet on master.
 * This module wires against that intended signal: once a leg's job COMPLETES
 * (not acks), the completion path should call settleCompositionLeg() with the
 * leg's milestoneIndex and evidence hash. Until that branch lands, nothing
 * auto-invokes leg settlement; the export is the integration point.
 *
 * Replay-guard bindings (verified against MilestoneEscrowV3.sol):
 *   - per-leg stepId  = keccak256("{compositionId}:{stepIndex}") → C2b confines
 *     each attestation to its own leg.
 *   - per-leg jobId   = "{compositionId}:{stepIndex}" → jobIdHash check is a
 *     second, independent cross-leg guard.
 *   - C1 (_attestationUsed) is per-escrow; one escrow per composition means a
 *     UID can release at most one leg, ever. C2a (recipient == escrow) blocks
 *     cross-composition replay.
 */

import crypto from "node:crypto";
import {
  createWalletClient,
  createPublicClient,
  http,
  keccak256,
  toBytes,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getDeployment, getContractAddress } from "@pcc/contracts";
import { MilestoneEscrowV2ABI, MilestoneEscrowV3ABI, MockUSDCABI } from "@pcc/contracts/abi";
import type { ComposeResponse, CompositionStep } from "@pcc/spec";
import { getRepos, initStore } from "../db.js";
import {
  createEscrowV3,
  submitEvidenceV3,
  waitForReceipt,
  resolveMockUSDCAddress,
  isWriteEnabled,
  GAS_LIMITS,
} from "../contracts/escrow-client.js";
import { withSignerLock } from "../contracts/signer-lock.js";

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * Master switch for the compose→escrow wire. Default OFF — executeComposition
 * behaves exactly as before unless a deployment opts in. Kept separate from
 * PCC_COMPOSE_EXECUTE_REAL so the escrow leg can be exercised (mock) in tests
 * without submitting real jobs, and vice versa.
 */
export function isComposeSettlementEnabled(): boolean {
  return process.env.PCC_COMPOSE_SETTLEMENT === "true";
}

/** Same mock semantics as paid-job-flow: mock unless explicitly disabled. */
function isMockSettlement(): boolean {
  return process.env.MOCK_SETTLEMENT !== "false";
}

/** Challenge window per leg (seconds). Default 0 mirrors the tier-0 smoke flow. */
function challengeWindowSeconds(): number {
  const raw = Number(process.env.PCC_COMPOSE_CHALLENGE_WINDOW_SECONDS ?? "0");
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 0;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Store access — booted by server.ts in production; tests lazily initialise an
 * in-memory store on first touch. Mirrors compose.ts's db() helper so this
 * module is call-order-independent under vitest.
 */
function repos() {
  try {
    return getRepos();
  } catch {
    if (
      (process.env.VITEST || process.env.NODE_ENV === "test") &&
      !process.env.PCC_DB_PATH &&
      !process.env.DATABASE_URL
    ) {
      process.env.PCC_DB_PATH = ":memory:";
    }
    initStore({ seed: false });
    return getRepos();
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One composed leg mapped onto one escrow milestone. */
export interface CompositionLegPlan {
  /** CompositionStep.index this leg settles. */
  stepIndex: number;
  /** On-chain milestone index inside the composition escrow (assignment order). */
  milestoneIndex: number;
  /** bytes32 stepId bound on-chain: keccak256("{compositionId}:{stepIndex}"). */
  stepId: `0x${string}`;
  /** jobId bound on-chain as keccak256(bytes(jobId)): "{compositionId}:{stepIndex}". */
  jobId: string;
  /** The leg's payout recipient — the composed step's operator. */
  operator: `0x${string}`;
  /** Quoted price for this leg (USD, decimal string). */
  amountUSD: string;
  /** parseUnits(amountUSD, 6) as string (bigint-safe for JSON persistence). */
  amountUnits: string;
  /** Assurance tier the leg's attestation must report (clamped 0-3). */
  requiredTier: number;
}

/** A leg that could not be given a milestone, and why. */
export interface SkippedLeg {
  stepIndex: number;
  reason: "no_valid_operator_address" | "zero_or_negative_price";
}

/** The full settlement plan produced by createCompositionEscrow(). */
export interface CompositionSettlementPlan {
  compositionId: string;
  /** DB escrow row id (repos.escrows). */
  escrowId: string;
  /** On-chain escrow clone address (or "mock-escrow-…" in mock mode). */
  escrowAddress: string;
  /** bytes32 CWM id bound at escrow creation. */
  cwmId: `0x${string}`;
  mode: "mock" | "v3";
  legs: CompositionLegPlan[];
  skippedLegs: SkippedLeg[];
  /** fund() tx hash (null in mock mode). */
  fundTxHash: string | null;
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

/** Clamp a loose tier value to a valid on-chain AssuranceTier (0-3); never over-report. */
function toTier(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 3 ? n : 0;
}

/** Per-leg jobId — also the string the oracle must attest for this leg. */
export function legJobId(compositionId: string, stepIndex: number): string {
  return `${compositionId}:${stepIndex}`;
}

/** Per-leg bytes32 stepId bound on-chain (C2b confinement). */
export function legStepId(compositionId: string, stepIndex: number): `0x${string}` {
  return keccak256(toBytes(legJobId(compositionId, stepIndex)));
}

/**
 * Map a composition's steps onto per-leg milestone specs.
 *
 * Pure — no chain, no store. Skips (with a recorded reason) any leg that
 * cannot settle on-chain:
 *   - operatorAddress that is not a 0x…40-hex address. Graph-search-planned
 *     steps carry operatorAddress "" (compose.ts graphStepToCompositionStep);
 *     those legs are unsettleable until the execute follow-on resolves the
 *     operator — surfacing them beats silently paying nobody.
 *   - zero/negative quoted price — a milestone with amount 0 secures nothing.
 *
 * milestoneIndex is the position in the RETURNED array (assignment order),
 * which is exactly the on-chain index order addMilestone produces.
 */
export function planCompositionLegs(composition: ComposeResponse): {
  legs: CompositionLegPlan[];
  skipped: SkippedLeg[];
} {
  const legs: CompositionLegPlan[] = [];
  const skipped: SkippedLeg[] = [];

  for (const step of composition.steps as CompositionStep[]) {
    if (!ADDRESS_RE.test(step.operatorAddress ?? "")) {
      skipped.push({ stepIndex: step.index, reason: "no_valid_operator_address" });
      continue;
    }
    const price = Number(step.estimatedPriceUSD);
    if (!Number.isFinite(price) || price <= 0) {
      skipped.push({ stepIndex: step.index, reason: "zero_or_negative_price" });
      continue;
    }

    const amountUSD = price.toFixed(6);
    legs.push({
      stepIndex: step.index,
      milestoneIndex: legs.length,
      stepId: legStepId(composition.compositionId, step.index),
      jobId: legJobId(composition.compositionId, step.index),
      operator: step.operatorAddress as `0x${string}`,
      amountUSD,
      amountUnits: parseUnits(amountUSD, 6).toString(),
      requiredTier: toTier(step.assuranceTier),
    });
  }

  return { legs, skipped };
}

// ---------------------------------------------------------------------------
// Escrow creation (create + addMilestone per leg + fund)
// ---------------------------------------------------------------------------

/**
 * Create and fund the per-composition escrow: one V3 clone, one milestone per
 * settleable leg, funded upfront so each leg is release-ready the moment its
 * evidence + attestation land.
 *
 * Mock mode (MOCK_SETTLEMENT unset / != "false"): no chain writes; returns a
 * mock escrow address and still records the DB row + leg plan, so the rest of
 * the pipeline (and tests) exercise the same shapes.
 *
 * Real mode: mirrors createJobFromSession's V3 ceremony (paid-job-flow.ts):
 *   - payer == arbiter == the gateway signer (it funds and can reclaim).
 *   - factory: MILESTONE_ESCROW_FACTORY_V3 env override, else chain-config
 *     milestoneEscrowFactoryV3 (staging isolation — see ORACLE-TRUST-ARCHITECTURE).
 *   - every write is receipt-confirmed (90s bound) before the next; the whole
 *     sequence is serialized under withSignerLock (shared hot signer).
 *   - THE difference from the single-job flow: each milestone's operator is
 *     that LEG's operator (per-leg payout), not one job-wide payout address.
 *
 * Throws when no leg is settleable, or on any funding-path failure — callers
 * treat a throw as FAIL CLOSED (do not run steps whose pay could not be
 * escrowed).
 */
export async function createCompositionEscrow(
  composition: ComposeResponse,
): Promise<CompositionSettlementPlan> {
  const { legs, skipped } = planCompositionLegs(composition);
  if (legs.length === 0) {
    throw new Error(
      `composition ${composition.compositionId} has no settleable legs ` +
        `(${skipped.length} skipped: ${skipped.map((s) => `${s.stepIndex}:${s.reason}`).join(", ")})`,
    );
  }

  const compositionId = composition.compositionId;
  const escrowId = `esc-${crypto.randomUUID().slice(0, 12)}`;
  const cwmIdBytes = keccak256(toBytes(`pcc-comp-${compositionId}`));
  const now = new Date().toISOString();
  const totalUSD = legs
    .reduce((s, l) => s + Number(l.amountUSD), 0)
    .toFixed(6);

  let escrowAddress: string;
  let fundTxHash: string | null = null;
  let mode: "mock" | "v3";

  if (isMockSettlement()) {
    mode = "mock";
    escrowAddress = `mock-escrow-${Date.now().toString(36)}`;
  } else {
    mode = "v3";
    if (!isWriteEnabled()) {
      throw new Error(
        "PCC_GATEWAY_PRIVATE_KEY required for real composition settlement (MOCK_SETTLEMENT=false)",
      );
    }
    const network = process.env.PCC_NETWORK ?? "base-sepolia";
    const pk = process.env.PCC_GATEWAY_PRIVATE_KEY as `0x${string}`;
    const deployment = getDeployment(network);
    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({
      account,
      chain: deployment.chain,
      transport: http(deployment.rpcUrl),
    });
    const publicClient = createPublicClient({
      chain: deployment.chain,
      transport: http(deployment.rpcUrl),
    });

    const tokenAddr = resolveMockUSDCAddress(network);
    if (!tokenAddr) {
      throw new Error(
        `No MockUSDC token resolvable for network ${network} ` +
          `(no chain-config mockUSDC and MOCK_USDC_ADDRESS env unset)`,
      );
    }
    const factoryAddrV3 =
      (process.env.MILESTONE_ESCROW_FACTORY_V3 as `0x${string}` | undefined) ??
      getContractAddress(network, "milestoneEscrowFactoryV3");

    const totalFundAmount = legs.reduce((s, l) => s + BigInt(l.amountUnits), 0n);
    const windowSeconds = BigInt(challengeWindowSeconds());

    escrowAddress = await withSignerLock(async () => {
      // 1. Mint the escrow clone (factory write + EscrowCreated decode inside).
      const addr = await createEscrowV3(
        account.address, // payer   = gateway signer (funds the composition)
        account.address, // arbiter = gateway signer (dispute resolution — draft)
        tokenAddr,
        cwmIdBytes,
        factoryAddrV3,
      );
      console.log(
        `[compose-settle] created V3 escrow ${addr} for composition ${compositionId} ` +
          `(${legs.length} leg(s), token ${tokenAddr})`,
      );

      // 2. One milestone per leg — the LEG's operator is the payout recipient.
      //    V2 ABI is byte-identical to V3 for addMilestone (7-arg shape); this
      //    mirrors paid-job-flow's proven dispatch.
      for (const leg of legs) {
        const addTx = await walletClient.writeContract({
          address: addr as `0x${string}`,
          abi: MilestoneEscrowV2ABI,
          functionName: "addMilestone",
          args: [
            leg.stepId,
            leg.operator,
            BigInt(leg.amountUnits),
            0n, // operatorBond — bond negotiation is out of scope for the draft
            windowSeconds,
            leg.requiredTier,
            leg.jobId,
          ],
          gas: GAS_LIMITS.addMilestone,
        });
        const addReceipt = await publicClient.waitForTransactionReceipt({
          hash: addTx,
          timeout: 90_000,
        });
        if (addReceipt.status !== "success") {
          throw new Error(
            `composition addMilestone reverted (leg ${leg.stepIndex}, tx=${addTx}, escrow ${addr})`,
          );
        }
        console.log(
          `[compose-settle] leg ${leg.stepIndex} → milestone ${leg.milestoneIndex} ` +
            `operator=${leg.operator} amount=${leg.amountUSD} (tx: ${addTx})`,
        );
      }

      // 3. Fund upfront: approve the escrow for the total, then fund().
      const approveTx = await walletClient.writeContract({
        address: tokenAddr,
        abi: MockUSDCABI,
        functionName: "approve",
        args: [addr as `0x${string}`, totalFundAmount],
        gas: GAS_LIMITS.approve,
      });
      const approveReceipt = await publicClient.waitForTransactionReceipt({
        hash: approveTx,
        timeout: 90_000,
      });
      if (approveReceipt.status !== "success") {
        throw new Error(`composition approve reverted (tx=${approveTx}, escrow ${addr})`);
      }

      const fundTx = await walletClient.writeContract({
        address: addr as `0x${string}`,
        abi: MilestoneEscrowV3ABI,
        functionName: "fund",
        args: [],
        gas: GAS_LIMITS.fund,
      });
      const fundReceipt = await publicClient.waitForTransactionReceipt({
        hash: fundTx,
        timeout: 90_000,
      });
      if (fundReceipt.status !== "success") {
        throw new Error(`composition fund reverted (tx=${fundTx}, escrow ${addr})`);
      }
      fundTxHash = fundTx;
      console.log(
        `[compose-settle] escrow ${addr} funded (${legs.length} leg(s), ${totalFundAmount} base units)`,
      );
      return addr;
    });
  }

  // DB row — same shape createJobFromSession writes, version "v3" so the
  // escrow routes/facades dispatch the V3 write helpers for this address.
  repos().escrows.insert({
    id: escrowId,
    cwmId: `comp-${compositionId}`,
    contractAddress: escrowAddress,
    payer: "compose-engine", // FLAG: requester identity wiring is follow-on
    totalAmount: totalUSD,
    currency: "USDC",
    status: "funded", // both modes fund upfront (mock: nominally)
    createdAt: now,
    deadline: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    version: "v3",
  });

  return {
    compositionId,
    escrowId,
    escrowAddress,
    cwmId: cwmIdBytes,
    mode,
    legs,
    skippedLegs: skipped,
    fundTxHash,
  };
}

// ---------------------------------------------------------------------------
// Per-leg settlement entry point (evidence side)
// ---------------------------------------------------------------------------

/**
 * Submit a completed leg's evidence hash on-chain (V3, the leg's OWN milestone
 * index) and wait for it to mine. This is the first on-chain settlement step
 * for a leg; the remainder — oracle attestation mint (verifyWithOracle with
 * mintEasAttestation + the leg's stepId), submitAttestationV3(milestoneIndex,
 * easUid), challenge window, release — is the existing per-job Mode-B
 * machinery in paid-job-flow's /complete handler, invoked with THIS leg's
 * milestoneIndex instead of the single-job hardcoded 0.
 *
 * NOT auto-invoked yet: the (compositionId, stepIndex) completion signal
 * (`__pccStep`) lands with feat/composition-preflight-gate. See module header.
 *
 * No-op (returns null) in mock mode.
 */
export async function settleCompositionLeg(
  escrowAddress: string,
  milestoneIndex: number,
  evidenceBundleHash: `0x${string}`,
): Promise<{ evidenceTxHash: string; receiptStatus: string } | null> {
  if (isMockSettlement() || !escrowAddress.startsWith("0x")) return null;
  if (!isWriteEnabled()) {
    throw new Error("PCC_GATEWAY_PRIVATE_KEY required to settle a composition leg");
  }
  const res = await submitEvidenceV3(
    milestoneIndex,
    evidenceBundleHash,
    escrowAddress as `0x${string}`,
  );
  const receipt = await waitForReceipt(res.transactionHash as `0x${string}`);
  return { evidenceTxHash: res.transactionHash, receiptStatus: receipt.status };
}
