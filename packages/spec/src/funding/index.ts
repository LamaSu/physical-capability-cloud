/**
 * `@pcc/spec/funding`: the buyer-funding SDK for V-next escrows (buyer-funding plan S3.1), for a viem EOA. Author:
 * implementer-bravo (pcc-adk). Uses viem and @pcc/spec's public evidence producers.
 * viem is an optional peer of `@pcc/spec`: install viem ^2 alongside it, or importing this subpath fails with
 * ERR_MODULE_NOT_FOUND.
 *
 *   const prepared = await prepareFunding({ payload, wallet, publicClient, quote: { maxTotalGross }, expect, pins });
 *   const acceptance = await signJobPolicy({ prepared, wallet });   // optional for a payer-sent fund()
 *   const result = await approveAndFund({ prepared, wallet, publicClient });
 *   if (result.outcome !== "committed") { ... }                     // "indeterminate" is NOT success
 *
 * After an indeterminate result, resolve with readFundedState (or wait for the earlier transactions) before retrying:
 * `readFundedState({ publicClient, prepared })` reads the escrow again. A retried approveAndFund refuses
 * PAYER_TX_PENDING, sending nothing, while the payer still has a transaction pending.
 *
 * A gateway (or anything else) never gets the buyer's key: the SDK signs and sends from the caller's own wallet,
 * and only after verifying the payload against caller intent and trusted pins. There is no x402 path: x402 cannot
 * fund a V-next escrow (plan G10).
 * Fix expect in your own submit record, operator choice and payee list before requesting the prepare payload.
 * PCC MVP units bind all three commitments exactly (termsHash, acceptedPolicyDigest and compositionRoots);
 * bind jobPolicyHash as well when you hold it. An MVP integration never passes allowUnchecked.
 * Values come from the caller's own pins;
 * Thursday PRINT uses printUnitThursdayExpectation and economics' PRINT_UNIT_THURSDAY_V1 pins.
 * Its exact payer expectation binds fundingWallet to the wallet passed to prepareFunding. Its termsHash is
 * derived from the funded configs as v2.1 (#8165), carried privately until evidence's public producer (#8168). Never copy
 * values from a payload or gateway response. Outside the MVP, exact-literal "unchecked" waivers require allowUnchecked: true; each is
 * exposed in prepared.unchecked and leaves the terms, evidence policy or composition to the payload's author.
 * Optional expectations bind chainId, unit count, each unit's gross, ordered payouts, composition schema and
 * reclaim floor exactly when supplied. Unless pinned by an optional expectation, the unit count, each g,
 * the payout split and compositionSchemaVersion remain the payload author's choices.
 * Without jobPolicyHash, unbound values remain the payload author's choices,
 * including milestoneIndex, stepId, expiry, policyNonce, each tier within the allowed set outside derive mode, reclaimAt within
 * the permitted window, each unit's feeBps up to maxFeeBps (which fixes f and n), its fee recipient within
 * feeRecipients, and its compositionRoot within compositionRoots. Deriving termsHash binds it to these configs
 * and pins requiredTier and requestedTier to assuranceTier; it does not independently constrain the other choices.
 * Outside derive mode, a mixed tier set hands the choice of release authority to the payload's author, unit by unit:
 * a tier-0 unit releases only on the buyer's approval; a tier-1+ unit releases on
 * the cohort's assertion once its challenge window closes. The buyer can contest it only by posting a bond within
 * that window, which opens an appeal. The unit still releases unless the appeal rules for the buyer, and appeal
 * silence releases. Show prepared.configs to the buyer, or bind jobPolicyHash.
 * These choices are not waivers and do not appear in prepared.unchecked.
 * Every pin, especially the factory, must come from the caller's own trusted configuration,
 * never from the gateway payload or any gateway response.
 */
export { prepareFunding, DEFAULT_MARGIN_SECONDS } from "./prepare.js";
export type { PrepareFundingArgs, PreparedFunding, FundingExpectations, UncheckedFundingField } from "./prepare.js";
export { jobIdHashOf } from "./vnext.js";
export { signJobPolicy } from "./sign.js";
export { approveAndFund, readFundedState, classifyFunding } from "./fund.js";
export type { ApproveAndFundArgs, FundedState, FundedStateKind, FundingOutcome, FundingResult, SendResult } from "./fund.js";
export { FUNDING_PREPARE_SCHEMA } from "./payload.js";
export { FundingRefusal } from "./errors.js";
export type { FundingRefusalCode } from "./errors.js";
export { CIRCLE_USDC } from "./pins.js";
export type { FundingPins } from "./pins.js";
export type { JobPolicyMessage, JobPolicyTypedData, PayoutEntry, UnitConfig } from "./vnext.js";

/** A Thursday PRINT-unit buyer calls printUnitThursdayExpectation and never passes allowUnchecked. */
export { PRINT_UNIT_THURSDAY_V1, RECLAIM_SKEW_SECONDS, printUnitPrincipalWord, printUnitThursdayExpectation } from "./print-unit.js";
export type { PrintUnitThursdayExpectationInput } from "./print-unit.js";
