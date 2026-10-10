/**
 * Typed refusals of the buyer-funding SDK (`@pcc/spec/funding`). Author: implementer-bravo (pcc-adk).
 *
 * A refusal means nothing was signed or broadcast by the call that threw it. Each code names one check; the
 * check and the plan/contract rule it comes from are listed where it is raised.
 */

export type FundingRefusalCode =
  /** The payload is not the `pcc.vnext.buyer-funding.prepare.v1` shape: a key, type or format is wrong. */
  | "BAD_PAYLOAD"
  /** The caller's independent buyer intent is missing, malformed or lacks an explicit commitment/waiver. No RPC ran. */
  | "BAD_EXPECTATION"
  /** A coherent funding policy disagrees with the caller's independent buyer intent. */
  | "INTENT_MISMATCH"
  /** The payload is an x402 payment (or asks for an EIP-3009/EIP-2612 authorization): never a way to fund (plan G10). */
  | "X402_REFUSED"
  /** The wallet's (or the read client's) chain is not the payload's chain. */
  | "CHAIN_MISMATCH"
  /** A caller-supplied pin is malformed or contradicts a built-in pin. */
  | "PIN_INVALID"
  /** The token is not the pinned USDC for the chain, or the chain has no USDC pin. */
  | "TOKEN_NOT_PINNED"
  /** The factory is not the pinned factory for the chain, or the chain has no factory pin. */
  | "FACTORY_NOT_PINNED"
  /**
   * The pinned factory has no code, its implementation is not the one the policy names, or the code at the escrow is
   * not the EIP-1167 clone of that implementation.
   */
  | "DEPLOYMENT_MISMATCH"
  /** The policy's payer is not the wallet's own address. */
  | "PAYER_NOT_SIGNER"
  /** keccak256(abi.encode(configs)) is not the policy's prePolicyRoot. */
  | "POLICY_ROOT_MISMATCH"
  /**
   * The escrow is not the CREATE2 address of the factory, the policy salt and the implementation's clone, as derived
   * here or as the pinned factory's own `predictEscrow(identity)` answers.
   */
  | "ESCROW_NOT_PREDICTED"
  /** The EIP-712 domain is not the escrow clone's own. */
  | "DOMAIN_MISMATCH"
  /** The typed data is not exactly the JobPolicy the contract verifies. */
  | "TYPED_DATA_MISMATCH"
  /** ΣG is not the sum of the configs' gross amounts. */
  | "TOTAL_GROSS_MISMATCH"
  /** ΣG exceeds the buyer's quote. */
  | "AMOUNT_EXCEEDS_QUOTE"
  /** The approve's spender is not the escrow. */
  | "APPROVE_SPENDER_NOT_ESCROW"
  /** The approve's amount is not exactly ΣG (an unlimited approve included). */
  | "APPROVE_AMOUNT_NOT_TOTAL"
  /** The `fund()` acceptance is not the payer-sent shape for this policy. */
  | "FUND_ARGS_MISMATCH"
  /** The operator signature is missing, malformed, or not over these exact terms. */
  | "OPERATOR_SIGNATURE_INVALID"
  /** The acceptance expires before (or too soon after) the latest block. */
  | "EXPIRY_TOO_SOON"
  /** A unit's reclaim window would not hold at funding time. */
  | "RECLAIM_WINDOW"
  /** The object was not produced by `prepareFunding`. */
  | "NOT_PREPARED"
  /** The wallet produced a signature the contract would not accept (length, v or high s). */
  | "SIGNATURE_NOT_CANONICAL"
  /** The escrow clone does not exist yet (the gateway creates it before prepare returns). */
  | "ESCROW_NOT_CREATED"
  /**
   * The escrow or the job is already funded under some other acceptance, or the escrow reports this policy's hash
   * uncorroborated: its `prePolicyRoot_` is not this policy's, or the pinned factory's `fundedEscrowOf(policyKey)` is
   * not this escrow.
   */
  | "ALREADY_FUNDED"
  /** A chain read the checks depend on failed; the SDK fails closed. */
  | "LIVE_CHECK_FAILED"
  /** The approve simulation reverted; nothing was broadcast. */
  | "SIMULATION_REVERTED"
  /**
   * The payer has a transaction still pending (its nonce at "pending" is above its nonce at "latest"), so an earlier
   * approve or fund() may still land; nothing was sent. After an indeterminate result, resolve with readFundedState
   * (or wait for the earlier transactions) before retrying.
   */
  | "PAYER_TX_PENDING";

export class FundingRefusal extends Error {
  readonly code: FundingRefusalCode;
  readonly detail: string;
  constructor(code: FundingRefusalCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "FundingRefusal";
    this.code = code;
    this.detail = detail;
  }
}

export function refuse(code: FundingRefusalCode, detail: string): never {
  throw new FundingRefusal(code, detail);
}
