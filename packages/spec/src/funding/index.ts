/**
 * `@pcc/spec/funding`: the buyer-funding SDK for V-next escrows (buyer-funding plan S3.1), for a viem EOA. Author:
 * implementer-bravo (pcc-adk). Self-contained (viem is its only dependency) so it can move into `@pcc/adk`.
 * viem is an optional peer of `@pcc/spec`: install viem ^2 alongside it, or importing this subpath fails with
 * ERR_MODULE_NOT_FOUND.
 *
 *   const prepared = await prepareFunding({ payload, wallet, publicClient, quote: { maxTotalGross }, pins });
 *   const acceptance = await signJobPolicy({ prepared, wallet });   // optional for a payer-sent fund()
 *   const result = await approveAndFund({ prepared, wallet, publicClient });
 *   if (result.outcome !== "committed") { ... }                     // "indeterminate" is NOT success
 *
 * After an indeterminate result, resolve with readFundedState (or wait for the earlier transactions) before retrying:
 * `readFundedState({ publicClient, prepared })` reads the escrow again. A retried approveAndFund refuses
 * PAYER_TX_PENDING, sending nothing, while the payer still has a transaction pending.
 *
 * A gateway (or anything else) never gets the buyer's key: the SDK signs and sends from the caller's own wallet,
 * and only after verifying every term. There is no x402 path: x402 cannot fund a V-next escrow (plan G10).
 */
export { prepareFunding, DEFAULT_MARGIN_SECONDS } from "./prepare.js";
export type { PrepareFundingArgs, PreparedFunding } from "./prepare.js";
export { signJobPolicy } from "./sign.js";
export { approveAndFund, readFundedState, classifyFunding } from "./fund.js";
export type { ApproveAndFundArgs, FundedState, FundedStateKind, FundingOutcome, FundingResult, SendResult } from "./fund.js";
export { FUNDING_PREPARE_SCHEMA } from "./payload.js";
export { FundingRefusal } from "./errors.js";
export type { FundingRefusalCode } from "./errors.js";
export { CIRCLE_USDC } from "./pins.js";
export type { FundingPins } from "./pins.js";
export type { JobPolicyMessage, JobPolicyTypedData, PayoutEntry, UnitConfig } from "./vnext.js";
