/**
 * `@pcc/spec/funding`: the buyer-funding SDK for V-next escrows (buyer-funding plan S3.1). Author:
 * implementer-bravo (pcc-adk). Self-contained (viem is its only dependency) so it can move into `@pcc/adk`.
 */
export { FundingRefusal } from "./errors.js";
export type { FundingRefusalCode } from "./errors.js";
export { CIRCLE_USDC } from "./pins.js";
export type { FundingPins } from "./pins.js";
export type { JobPolicyMessage, JobPolicyTypedData, PayoutEntry, UnitConfig } from "./vnext.js";
