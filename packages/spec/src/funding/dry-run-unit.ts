import { isAddress, type Address, type Hex } from "viem";
import {
  AcceptedPolicyDigestInputError, computeBindingsRoot, computeSubjectBlockHash,
  type SubjectBinding, type SubjectBlockFields,
} from "../evidence/accepted-policy.js";
import { formatOperatorPrincipalId, principalTupleWord } from "../evidence/principal-id.js";
import { refuse } from "./errors.js";
import type { FundingExpectations } from "./prepare.js";
import { reclaimWindowFor } from "./pins.js";
import { RECLAIM_SKEW_SECONDS } from "./print-unit.js";

/**
 * N145's NS-6 dry run on Base Sepolia only; testnet only (steward #11370 Q1/Q2).
 * One payout leg pays the throwaway operator. Nothing releases: tier 1 needs the
 * primary cohort's SETTLE, and no attestation is requested. The run ends with the
 * payer's reclaimAfterDeadline.
 */
export const DRY_RUN_UNIT_TESTNET_V1 = Object.freeze({
  /** No program (steward #11370 Q2). */
  committedProgramHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  /** Non-composed unit (steward #11370 Q2). */
  compositionSchemaVersion: 0,
  /** Non-composed unit (steward #11370 Q2). */
  compositionRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
  /** Tier 1 (steward #11370 Q2); VNextSettlementEscrow.sol:744 requires equal tiers. */
  requiredTier: 1,
  /** Equal to requiredTier (VNextSettlementEscrow.sol:744; steward #11370 Q2). */
  requestedTier: 1,
  /** No fee (#7972; VNextSettlementLib.sol:600). */
  feeBps: 0,
  /** Zero-fee recipient (#7972; VNextSettlementLib.sol:600). */
  feeRecipient: "0x0000000000000000000000000000000000000000",
  /** Gross USDC base units (steward #11370 Q1/Q2). */
  g: 1_000_000n,
  /** Fee base units: g * feeBps / 10000 (steward #11370 Q1/Q2). */
  f: 0n,
  /** Net base units: g - f (steward #11370 Q1/Q2). */
  n: 1_000_000n,
  /** Exactly one dry-run unit (steward #11370 Q1/Q2). */
  unitCount: 1,
  /** Chain id from packages/contracts/deployments/vnext/base-sepolia/CANONICAL.json. */
  chainId: 84532,
  /** USDC from packages/contracts/deployments/vnext/base-sepolia/CANONICAL.json. */
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  /** Circle USDC base-unit decimals (CANONICAL.json USDC; steward #11370 Q1/Q2). */
  usdcDecimals: 6,
  /** Schedule from packages/contracts/deployments/vnext/base-sepolia/CANONICAL.json. */
  scheduleId: "vnext-testnet-short-v1",
  /** reclaimAt = policy creation + 7,200 s (#7972; steward #11370 Q1/Q2). */
  reclaimDelaySeconds: 7_200n,
  /** Maximum expiry after policy creation (steward #11370 Q1/Q2). */
  maxAcceptanceSeconds: 1_200n,
  /** Buyer reclaim slack shared with PRINT (economics #8089; steward #11370 Q1/Q2). */
  reclaimSkewSeconds: RECLAIM_SKEW_SECONDS,
  /** No subject bindings (steward #11370 Q2). */
  bindings: Object.freeze([]) as readonly SubjectBinding[],
  /** Public computeBindingsRoot([]) (steward #11370 Q2). */
  bindingsRoot: "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd",
  /** Zero subject fields shared with PRINT (steward #11370 Q2). */
  zeroSubjectFields: Object.freeze({
    /** No childrenRoot commitment (steward #11370 Q2). */
    childrenRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    /** No expertSetRoot commitment (steward #11370 Q2). */
    expertSetRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    /** No executorSetRoot commitment (steward #11370 Q2). */
    executorSetRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    /** No expectedRecipient commitment (steward #11370 Q2). */
    expectedRecipient: "0x0000000000000000000000000000000000000000000000000000000000000000",
    /** No targetSystemIdentity commitment (steward #11370 Q2). */
    targetSystemIdentity: "0x0000000000000000000000000000000000000000000000000000000000000000",
    /** No recipeRef commitment (steward #11370 Q2). */
    recipeRef: "0x0000000000000000000000000000000000000000000000000000000000000000",
    /** No sampleManifestRef commitment (steward #11370 Q2). */
    sampleManifestRef: "0x0000000000000000000000000000000000000000000000000000000000000000",
    /** No operatingEnvelopeHash commitment (steward #11370 Q2). */
    operatingEnvelopeHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    /** No expectedRouteArea commitment (steward #11370 Q2). */
    expectedRouteArea: "0x0000000000000000000000000000000000000000000000000000000000000000",
    /** No expectedLocationHash commitment (steward #11370 Q2). */
    expectedLocationHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    /** No captureNonceAnchor commitment (steward #11370 Q2). */
    captureNonceAnchor: "0x0000000000000000000000000000000000000000000000000000000000000000",
    /** No challengeAnchor commitment (steward #11370 Q2). */
    challengeAnchor: "0x0000000000000000000000000000000000000000000000000000000000000000",
  }),
  /** Zero integrity grade (steward #11370 Q2). */
  integrityGrade: 0,
} as const);

/** Evidence's public principal-id v1 word on chain 84532 (#8092, economics #8095). */
export function dryRunUnitPrincipalWord(address: Address): Hex {
  if (typeof address !== "string" || !isAddress(address, { strict: false })) {
    refuse("BAD_EXPECTATION", "dry-run principal address must be 0x followed by exactly 40 hex digits");
  }
  return principalTupleWord("operator", formatOperatorPrincipalId(DRY_RUN_UNIT_TESTNET_V1.chainId, address));
}

export interface DryRunUnitTestnetExpectationInput {
  jobId: string;
  /** All-lowercase hex or valid EIP-55; any other casing refuses BAD_EXPECTATION before any RPC. */
  operator: Address;
  /**
   * Must be the address of the wallet passed to prepareFunding; the returned `payer` expectation enforces it.
   * All-lowercase hex or valid EIP-55; any other casing refuses BAD_EXPECTATION before any RPC.
   */
  fundingWallet: Address;
  /** Full subject block; hashes are canonical lowercase, settlement address accepts any hex casing. */
  subject: SubjectBlockFields;
  bindings: readonly SubjectBinding[];
  /**
   * Independently obtained latest chain-block timestamp; never a quote's reclaimAt. Take it from the chain
   * after the prepare payload arrives, and no more than RECLAIM_SKEW_SECONDS (600 s) before the operator built
   * the policy. A stale value refuses. A value ahead of the chain widens the reclaim ceiling one for one,
   * bounded only by the live 365 d check.
   */
  latestBlockTimestamp: bigint;
}

/**
 * Fix independent N145 NS-6 dry-run buyer intent before prepareFunding. Every refusal is local;
 * public evidence producers own the subject and bindings roots. A dry-run buyer never passes allowUnchecked.
 * prepareFunding derives ratified v2.1 termsHash from the actual funded configs (#8165), then
 * computes acceptedPolicyDigest with these public roots and rechecks live chain timing.
 */
export function dryRunUnitTestnetExpectation(input: DryRunUnitTestnetExpectationInput): FundingExpectations {
  const p = DRY_RUN_UNIT_TESTNET_V1;
  const { jobId, operator, fundingWallet, subject, bindings, latestBlockTimestamp } = input;
  if (typeof jobId !== "string") refuse("BAD_EXPECTATION", "dry-run jobId must be a string");
  const payer = dryRunUnitPrincipalWord(fundingWallet);
  const operatorPrincipal = dryRunUnitPrincipalWord(operator);
  const maxDelay = p.reclaimDelaySeconds + p.reclaimSkewSeconds;
  if (typeof latestBlockTimestamp !== "bigint" || latestBlockTimestamp < 0n || latestBlockTimestamp + maxDelay >= 1n << 256n) {
    refuse("BAD_EXPECTATION", "dry-run latestBlockTimestamp and its reclaim window must fit non-negative uint256 chain seconds");
  }
  try {
    // The public producer first validates the full subject's shape and canonical field spellings.
    let subjectBlockHash: Hex;
    try {
      subjectBlockHash = computeSubjectBlockHash(subject);
    } catch (error) {
      // The producer validates the original plain data object before reading address words.
      // Only its address-casing refusal is retried; no accessor or Proxy is copied or read.
      if (!(error instanceof AcceptedPolicyDigestInputError) || error.field !== "subject.operatorSettlementAddress") throw error;
      const settlementAddress = Object.getOwnPropertyDescriptor(subject, "operatorSettlementAddress");
      if (!settlementAddress?.enumerable || !Object.prototype.hasOwnProperty.call(settlementAddress, "value") ||
          typeof settlementAddress.value !== "string" || !isAddress(settlementAddress.value, { strict: false })) throw error;
      subjectBlockHash = computeSubjectBlockHash({ ...subject,
        operatorSettlementAddress: settlementAddress.value.toLowerCase() as Address });
    }
    const mismatch = (field: string, got: unknown, want: unknown): never =>
      refuse("INTENT_MISMATCH", `dry-run subject.${field} is ${String(got)}; the buyer expects ${String(want)}`);
    if (subject.committedProgramHash !== p.committedProgramHash) mismatch("committedProgramHash", subject.committedProgramHash, p.committedProgramHash);
    if (subject.operatorSettlementAddress.toLowerCase() !== operator.toLowerCase()) mismatch("operatorSettlementAddress", subject.operatorSettlementAddress, operator);
    if (subject.payer !== payer) mismatch("payer", subject.payer, payer);
    if (subject.operatorPrincipal !== operatorPrincipal) mismatch("operatorPrincipal", subject.operatorPrincipal, operatorPrincipal);
    for (const field of Object.keys(p.zeroSubjectFields) as (keyof typeof p.zeroSubjectFields)[]) {
      if (subject[field] !== p.zeroSubjectFields[field]) mismatch(field, subject[field], p.zeroSubjectFields[field]);
    }
    if (subject.integrityGrade !== 0 && subject.integrityGrade !== 0n && subject.integrityGrade !== "0") mismatch("integrityGrade", subject.integrityGrade, 0);
    // Validate bindings via the public producer even though the only admitted array is empty.
    const bindingsRoot = computeBindingsRoot(bindings);
    if (bindings.length !== 0) refuse("INTENT_MISMATCH", "dry-run bindings must be exactly []; this unit admits no subject bindings");
    return {
      jobId, operator: operator, payer: fundingWallet, payees: [operator], maxFeeBps: p.feeBps,
      feeRecipients: [p.feeRecipient], tiers: [p.requestedTier],
      termsHash: { derive: "v2.1", token: p.usdc, assuranceTier: p.requiredTier },
      acceptedPolicyDigest: { subjectBlockHash, bindingsRoot }, compositionRoots: [p.compositionRoot],
      compositionSchemaVersion: p.compositionSchemaVersion, unitCount: p.unitCount, unitGross: p.g,
      unitPayouts: [{ recipient: operator, amount: p.n }],
      chainId: BigInt(p.chainId), earliestReclaimAt: latestBlockTimestamp + reclaimWindowFor(BigInt(p.chainId)).min,
      latestReclaimAt: latestBlockTimestamp + maxDelay,
    };
  } catch (error) {
    if (error instanceof AcceptedPolicyDigestInputError) refuse("BAD_EXPECTATION", error.message);
    throw error;
  }
}
