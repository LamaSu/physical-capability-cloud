import { isAddress, type Address, type Hex } from "viem";
import {
  AcceptedPolicyDigestInputError, computeAcceptedPolicyDigest, computeBindingsRoot, computeSubjectBlockHash,
  type SubjectBinding, type SubjectBlockFields,
} from "../evidence/accepted-policy.js";
import { formatOperatorPrincipalId, principalTupleWord } from "../evidence/principal-id.js";
import { refuse } from "./errors.js";
import type { FundingExpectations } from "./prepare.js";
import { MIN_RECLAIM_DELAY } from "./vnext.js";

/** Buyer-submitted UnitConfig reclaim slack, in chain seconds (economics #8089). */
export const RECLAIM_SKEW_SECONDS = 600n;

/**
 * Thursday's single non-composed PRINT unit, from economics' decided
 * terms/print-unit-thursday.v1.json and lane posts #8021, #8026, #8032, #8089, #8095, #8102.
 * The host and funding wallet are buyer inputs; their subject words use evidence's public
 * principal-id v1 producer (#8092, economics #8095). Payout 0 pays that host EOA.
 * requestedTier is 1: terms pin requiredTier 1, and packages/contracts/src/VNextSettlementEscrow.sol:744
 * enforces requiredTier == requestedTier in fund() (also documented by its getter at :1089).
 * authorizedTuplesRoot remains buyer-opaque and unchecked on Thursday: no public root
 * producer exists (economics #8095). It is still included in the accepted-policy digest.
 */
export const PRINT_UNIT_THURSDAY_V1 = Object.freeze({
  /** Keccak of the exact economics terms file bytes (#8032). */
  termsHash: "0xf037904088f851954883103836132ab016be7a8b0ff4867a4b7b6463a5e4f6b7",
  /** Subject-block field 10, S2 programHash @ba992167 (#8021). */
  committedProgramHash: "0x56c1897725442876a5b7adfde81b81c83b9ef09aade75aa3a81a911856330e4a",
  /** This unit is non-composed (#8021). */
  compositionSchemaVersion: 0,
  /** This unit is non-composed (#8021). */
  compositionRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
  /** Terms capability.requiredTier (#8021, #8026). */
  requiredTier: 1,
  /** Required tier 1 (#8021); VNextSettlementEscrow.sol:744 enforces equal requestedTier. */
  requestedTier: 1,
  /** No fee (#8021, #8026). */
  feeBps: 0,
  /** Zero-fee recipient (#8021, #8026). */
  feeRecipient: "0x0000000000000000000000000000000000000000",
  /** Gross USDC base units (#8026). */
  g: 750_000n,
  /** Fee base units: g * feeBps / 10000 (#8026). */
  f: 0n,
  /** Net base units: g - f (#8026). */
  n: 750_000n,
  /** Postage pass-through base units (#8026). */
  passThrough: 250_000n,
  /** First payout: n - passThrough, to the buyer's host EOA (#8026). */
  hostPayoutAmount: 500_000n,
  /** Second payout recipient, after the host (#8026). */
  passThroughRecipient: "0x6463ACd05141c1EF6583E4Fd978FC61Fff4045DC",
  /** Exactly one PRINT unit (#8026). */
  unitCount: 1,
  /** Economics terms network.chainId (#8032). */
  chainId: 84532,
  /** Economics terms network.settlementAsset (#8032). */
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  /** Economics terms network.assetDecimals (#8032). */
  usdcDecimals: 6,
  /** Upper delay bound from economics' terms, applied to fund's UnitConfig (#8089). */
  reclaimDelaySeconds: 1_814_400n,
  /** Existing SDK 10-day MIN; enforce against the submitted UnitConfig (#8089). */
  minReclaimDelaySeconds: MIN_RECLAIM_DELAY,
  /** Named buyer-side reclaim slack (#8089). */
  reclaimSkewSeconds: RECLAIM_SKEW_SECONDS,
  /** This unit admits no subject bindings (#8095, oracle recommendation #8102). */
  bindings: Object.freeze([]) as readonly SubjectBinding[],
  /** Public computeBindingsRoot([]), oracle recommendation #8102. */
  bindingsRoot: "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd",
  /** Every payee-chosen field below is zero for this unit (economics #8095). */
  zeroSubjectFields: Object.freeze({
    childrenRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    expertSetRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    executorSetRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    expectedRecipient: "0x0000000000000000000000000000000000000000000000000000000000000000",
    targetSystemIdentity: "0x0000000000000000000000000000000000000000000000000000000000000000",
    recipeRef: "0x0000000000000000000000000000000000000000000000000000000000000000",
    sampleManifestRef: "0x0000000000000000000000000000000000000000000000000000000000000000",
    operatingEnvelopeHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    expectedRouteArea: "0x0000000000000000000000000000000000000000000000000000000000000000",
    expectedLocationHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    captureNonceAnchor: "0x0000000000000000000000000000000000000000000000000000000000000000",
    challengeAnchor: "0x0000000000000000000000000000000000000000000000000000000000000000",
  }),
  /** Zero for this unit (economics #8095). */
  integrityGrade: 0,
} as const);

/** Evidence's public principal-id v1 word on chain 84532 (#8092, economics #8095). */
export function printUnitPrincipalWord(address: Address): Hex {
  if (typeof address !== "string" || !isAddress(address, { strict: false })) {
    refuse("BAD_EXPECTATION", "PRINT principal address must be 0x followed by exactly 40 hex digits");
  }
  return principalTupleWord("operator", formatOperatorPrincipalId(PRINT_UNIT_THURSDAY_V1.chainId, address));
}

export interface PrintUnitThursdayExpectationInput {
  jobId: string;
  host: Address;
  fundingWallet: Address;
  /** Full canonical subject block, including the buyer-opaque authorizedTuplesRoot. */
  subject: SubjectBlockFields;
  bindings: readonly SubjectBinding[];
  /** Independently obtained latest chain-block timestamp; never a quote's reclaimAt. */
  latestBlockTimestamp: bigint;
}

/**
 * Fix independent Thursday PRINT buyer intent before prepareFunding. Every refusal is local;
 * the public evidence producers own all hashing. A PRINT buyer never passes allowUnchecked.
 * prepareFunding checks reclaimAt from the actual fund.configs, then rechecks live chain timing.
 */
export function printUnitThursdayExpectation(input: PrintUnitThursdayExpectationInput): FundingExpectations {
  const p = PRINT_UNIT_THURSDAY_V1;
  const { jobId, host, fundingWallet, subject, bindings, latestBlockTimestamp } = input;
  if (typeof jobId !== "string") refuse("BAD_EXPECTATION", "PRINT jobId must be a string");
  const payer = printUnitPrincipalWord(fundingWallet);
  const operatorPrincipal = printUnitPrincipalWord(host);
  const maxDelay = p.reclaimDelaySeconds + RECLAIM_SKEW_SECONDS;
  if (typeof latestBlockTimestamp !== "bigint" || latestBlockTimestamp < 0n || latestBlockTimestamp + maxDelay >= 1n << 256n) {
    refuse("BAD_EXPECTATION", "PRINT latestBlockTimestamp and its reclaim window must fit non-negative uint256 chain seconds");
  }
  try {
    // The public producer first validates the full subject's shape and canonical field spellings.
    const subjectBlockHash = computeSubjectBlockHash(subject);
    const mismatch = (field: string, got: unknown, want: unknown): never =>
      refuse("INTENT_MISMATCH", `PRINT subject.${field} is ${String(got)}; the buyer expects ${String(want)}`);
    if (subject.committedProgramHash !== p.committedProgramHash) mismatch("committedProgramHash", subject.committedProgramHash, p.committedProgramHash);
    if (subject.operatorSettlementAddress.toLowerCase() !== host.toLowerCase()) mismatch("operatorSettlementAddress", subject.operatorSettlementAddress, host);
    if (subject.payer !== payer) mismatch("payer", subject.payer, payer);
    if (subject.operatorPrincipal !== operatorPrincipal) mismatch("operatorPrincipal", subject.operatorPrincipal, operatorPrincipal);
    for (const field of Object.keys(p.zeroSubjectFields) as (keyof typeof p.zeroSubjectFields)[]) {
      if (subject[field] !== p.zeroSubjectFields[field]) mismatch(field, subject[field], p.zeroSubjectFields[field]);
    }
    if (subject.integrityGrade !== 0 && subject.integrityGrade !== 0n && subject.integrityGrade !== "0") mismatch("integrityGrade", subject.integrityGrade, 0);
    // Validate bindings via the public producer even though the only admitted array is empty.
    const bindingsRoot = computeBindingsRoot(bindings);
    if (bindings.length !== 0) refuse("INTENT_MISMATCH", "PRINT bindings must be exactly []; this unit admits no subject bindings");
    const acceptedPolicyDigest = computeAcceptedPolicyDigest({ termsHash: p.termsHash, subjectBlockHash, bindingsRoot });
    return {
      jobId, operator: host, payees: [host, p.passThroughRecipient], maxFeeBps: p.feeBps,
      feeRecipients: [p.feeRecipient], tiers: [p.requestedTier], termsHash: p.termsHash,
      acceptedPolicyDigest, compositionRoots: [p.compositionRoot],
      ...{ compositionSchemaVersion: p.compositionSchemaVersion, unitCount: p.unitCount, unitGross: p.g,
        unitPayouts: [{ recipient: host, amount: p.hostPayoutAmount }, { recipient: p.passThroughRecipient, amount: p.passThrough }],
        chainId: BigInt(p.chainId), earliestReclaimAt: latestBlockTimestamp + MIN_RECLAIM_DELAY },
      latestReclaimAt: latestBlockTimestamp + maxDelay,
    };
  } catch (error) {
    if (error instanceof AcceptedPolicyDigestInputError) refuse("BAD_EXPECTATION", error.message);
    throw error;
  }
}
