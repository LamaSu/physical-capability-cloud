/**
 * Buyer funding, Stage 2 (research/buyer-funding-plan-20261008.md): the binding rule of a funding
 * verification record, in one place, so that reconcilePaidScope (S2.2) and the funding-status DTO
 * (S2.4) read it the same way (fund-s2 review MEDIUM-1). A record binds to a paid write scope and the
 * escrow row of the scope's job when, checked in this order:
 *   1. an expected chain is given, the one in the pinned V-next deployment record (the steward's
 *      ruling 4): a positive safe integer, or expected_chain_unavailable (reconcilePaidScope's name
 *      for the same case; r3 review LOW-1);
 *   2. it is a well-formed, finalized verification record (isWellFormedFundingRecord), or
 *      record_malformed;
 *   3. it was verified on the expected chain, or record_chain_mismatch;
 *   4. it names the scope, or record_scope_mismatch;
 *   5. its verified payer is the scope's buyer, or record_buyer_not_scope_buyer;
 *   6. the job has an escrow row, or escrow_missing;
 *   7. the row's payer label is the scope's buyer, or escrow_payer_not_buyer;
 *   8. the record's escrow is the row's contract (sameAddress), or record_escrow_not_scope_escrow.
 *
 * None of these reads the escrow row's status: it flips to completed at settlement (paid-job-flow,
 * settlement-keeper), and a binding does not end there. ACTIVATION also needs the row's status to be
 * funded or active, precondition (c), which the verifier (S1.2) sets with the record (the steward's
 * ruling 2): activationRefusal is the binding rule with that status check between checks 7 and 8,
 * the ONE function reconcilePaidScope activates by and the funding-status DTO reads funded_verified by
 * before activation (ruling 1).
 *
 * No mock branch: nothing here reads the settlement mode, and check 8 needs both addresses to be 0x
 * addresses (sameAddress), so a mock row ("mock-escrow-...") never binds to a record and never passes
 * activationRefusal (gateway's condition (iii), accepted in bulletin 7195).
 *
 * Pure: nothing here reads a clock, a database or the environment.
 */
import { sameIdentity } from "../auth/buyer-identity.js";
import { isWellFormedFundingRecord, sameAddress, type FundingVerificationRecord } from "./funding-record-port.js";

/** The scope fields the rule reads. */
export interface BindingScope {
  id: string;
  createdBy: string;
}

/** The escrow row fields the binding rule reads. Its status is not one of them. */
export interface BindingEscrow {
  contractAddress: string;
  payer: string;
}

/** The escrow row fields activationRefusal reads: the binding's, and the status. */
export interface BindingEscrowRow extends BindingEscrow {
  status: string;
}

export type RecordRefusal = "expected_chain_unavailable" | "record_malformed" | "record_chain_mismatch";
export type RecordScopeRefusal = RecordRefusal | "record_scope_mismatch" | "record_buyer_not_scope_buyer";
export type EscrowLabelRefusal = "escrow_missing" | "escrow_payer_not_buyer";
export type EscrowRowRefusal = EscrowLabelRefusal | "escrow_not_funded";
export type RecordEscrowRefusal = "record_escrow_not_scope_escrow";

/** A chain id (EIP-155): a positive safe integer, as a well-formed record carries one. */
export function isChainId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/**
 * Checks 1 to 3, which need no scope: an expected chain is given (`expectedChainId` is a chain id;
 * null when no deployment record is pinned), and `record` is a well-formed, finalized record verified
 * on it; or why not.
 */
export function recordRefusal(record: unknown, expectedChainId: number | null): RecordRefusal | null {
  if (!isChainId(expectedChainId)) return "expected_chain_unavailable";
  if (!isWellFormedFundingRecord(record)) return "record_malformed";
  if (record.chainId !== expectedChainId) return "record_chain_mismatch";
  return null;
}

/** Checks 1 to 5: `record` is a well-formed record, on the expected chain, of `scope` and of its buyer, or why not. */
export function recordScopeRefusal(record: unknown, scope: BindingScope, expectedChainId: number | null): RecordScopeRefusal | null {
  const own = recordRefusal(record, expectedChainId);
  if (own !== null) return own;
  const r = record as FundingVerificationRecord;
  if (r.scopeId !== scope.id) return "record_scope_mismatch";
  if (!sameIdentity(r.buyer, scope.createdBy)) return "record_buyer_not_scope_buyer";
  return null;
}

/** Checks 6 and 7: the job's escrow row exists and its payer label is `buyer`, or why not. */
export function escrowLabelRefusal(escrow: BindingEscrow | null | undefined, buyer: string): EscrowLabelRefusal | null {
  if (!escrow) return "escrow_missing";
  if (!sameIdentity(escrow.payer, buyer)) return "escrow_payer_not_buyer";
  return null;
}

/**
 * The escrow row's own preconditions, for a mock and a real escrow alike: checks 6 and 7, then its
 * status is funded or active, precondition (c) (ruling 2). None of this is proof of funding (the payer
 * column is a label and the status a DB flag); a real escrow needs its verification record besides.
 */
export function escrowRowRefusal(escrow: BindingEscrowRow | null | undefined, buyer: string): EscrowRowRefusal | null {
  const label = escrowLabelRefusal(escrow, buyer);
  if (label !== null || !escrow) return label ?? "escrow_missing";
  if (escrow.status !== "funded" && escrow.status !== "active") return "escrow_not_funded";
  return null;
}

/** Check 8: the record's escrow is the row's contract, in any letter case, or why not. */
export function recordEscrowRefusal(record: FundingVerificationRecord, escrow: BindingEscrow): RecordEscrowRefusal | null {
  return sameAddress(escrow.contractAddress, record.escrowAddress) ? null : "record_escrow_not_scope_escrow";
}

export type FundingBindingRefusal = RecordScopeRefusal | EscrowLabelRefusal | RecordEscrowRefusal;

/**
 * The eight checks, in order: null when `record` binds to `scope` and to `escrow`, the escrow row of
 * the scope's job (null or undefined when the job has none), on chain `expectedChainId`, else the
 * first check that fails. reconcilePaidScope runs the same checks one by one, with the escrow row's
 * status (and the kept record) checked between them; the funding-status DTO runs them all here.
 */
export function fundingBindingRefusal(
  record: FundingVerificationRecord,
  scope: BindingScope,
  escrow: BindingEscrow | null | undefined,
  expectedChainId: number | null,
): FundingBindingRefusal | null {
  const own = recordScopeRefusal(record, scope, expectedChainId);
  if (own !== null) return own;
  const labelRefusal = escrowLabelRefusal(escrow, scope.createdBy);
  if (labelRefusal !== null || !escrow) return labelRefusal ?? "escrow_missing";
  return recordEscrowRefusal(record, escrow);
}

export type ActivationRefusal = RecordScopeRefusal | EscrowRowRefusal | RecordEscrowRefusal;

/**
 * Whether `record` can activate `scope` as far as the record, the scope's buyer and its job's escrow
 * row `escrow` say: checks 1 to 7 of the binding rule, then the row's status (funded or active), then
 * check 8; null when all pass, else the first that fails. reconcilePaidScope activates by this and
 * the funding-status DTO reads funded_verified before activation by this (ruling 1), so the two agree.
 * The expected chain is its check 1 (and 3). What it does not cover is reconcile's own: the record
 * store, the post-activation TTL, the scope's status and window, the emergency stop, the block list,
 * and the one-funding-one-scope keys (r3 review NIT-4).
 */
export function activationRefusal(
  record: FundingVerificationRecord,
  scope: BindingScope,
  escrow: BindingEscrowRow | null | undefined,
  expectedChainId: number | null,
): ActivationRefusal | null {
  const own = recordScopeRefusal(record, scope, expectedChainId);
  if (own !== null) return own;
  const rowRefusal = escrowRowRefusal(escrow, scope.createdBy);
  if (rowRefusal !== null || !escrow) return rowRefusal ?? "escrow_missing";
  return recordEscrowRefusal(record, escrow);
}
