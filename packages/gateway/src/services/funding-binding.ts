/**
 * Buyer funding, Stage 2 (research/buyer-funding-plan-20261008.md): the binding rule of a funding
 * verification record, in one place, so that reconcilePaidScope (S2.2) and the funding-status DTO
 * (S2.4) read it the same way (fund-s2 review MEDIUM-1). A record binds to a paid write scope and the
 * escrow row of the scope's job when, checked in this order:
 *   1. it is a well-formed, finalized verification record (isWellFormedFundingRecord), or
 *      record_malformed;
 *   2. it was verified on the expected chain, the one in the pinned V-next deployment record (the
 *      steward's ruling 4), or record_chain_mismatch;
 *   3. it names the scope, or record_scope_mismatch;
 *   4. its verified payer is the scope's buyer, or record_buyer_not_scope_buyer;
 *   5. the job has an escrow row, or escrow_missing;
 *   6. the row's payer label is the scope's buyer, or escrow_payer_not_buyer;
 *   7. the record's escrow is the row's contract (sameAddress), or record_escrow_not_scope_escrow.
 *
 * None of these reads the escrow row's status. It flips to completed at settlement (paid-job-flow,
 * settlement-keeper), and a binding does not end there. To ACTIVATE a scope, reconcilePaidScope also
 * requires the status to be funded or active (escrowRowRefusal); the DTO, which only reports, does not.
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

/** The escrow row fields the rule reads. Its status is not one of them. */
export interface BindingEscrow {
  contractAddress: string;
  payer: string;
}

export type RecordRefusal = "record_malformed" | "record_chain_mismatch";
export type RecordScopeRefusal = RecordRefusal | "record_scope_mismatch" | "record_buyer_not_scope_buyer";
export type EscrowLabelRefusal = "escrow_missing" | "escrow_payer_not_buyer";
export type RecordEscrowRefusal = "record_escrow_not_scope_escrow";

/**
 * Checks 1 and 2, which need no scope: `record` is a well-formed, finalized record verified on chain
 * `expectedChainId`, or why not. A well-formed record's chainId is a positive safe integer, so an
 * expected chain that is not one (null when no deployment record is pinned, NaN, 0, a fraction, a
 * string) matches no record: fail closed.
 */
export function recordRefusal(record: unknown, expectedChainId: number | null): RecordRefusal | null {
  if (!isWellFormedFundingRecord(record)) return "record_malformed";
  if (record.chainId !== expectedChainId) return "record_chain_mismatch";
  return null;
}

/** Checks 1 to 4: `record` is a well-formed record, on the expected chain, of `scope` and of its buyer, or why not. */
export function recordScopeRefusal(record: unknown, scope: BindingScope, expectedChainId: number | null): RecordScopeRefusal | null {
  const own = recordRefusal(record, expectedChainId);
  if (own !== null) return own;
  const r = record as FundingVerificationRecord;
  if (r.scopeId !== scope.id) return "record_scope_mismatch";
  if (!sameIdentity(r.buyer, scope.createdBy)) return "record_buyer_not_scope_buyer";
  return null;
}

/** Checks 5 and 6: the job's escrow row exists and its payer label is `buyer`, or why not. */
export function escrowLabelRefusal(escrow: BindingEscrow | null | undefined, buyer: string): EscrowLabelRefusal | null {
  if (!escrow) return "escrow_missing";
  if (!sameIdentity(escrow.payer, buyer)) return "escrow_payer_not_buyer";
  return null;
}

/** Check 7: the record's escrow is the row's contract, in any letter case, or why not. */
export function recordEscrowRefusal(record: FundingVerificationRecord, escrow: BindingEscrow): RecordEscrowRefusal | null {
  return sameAddress(escrow.contractAddress, record.escrowAddress) ? null : "record_escrow_not_scope_escrow";
}

export type FundingBindingRefusal = RecordScopeRefusal | EscrowLabelRefusal | RecordEscrowRefusal;

/**
 * The seven checks, in order: null when `record` binds to `scope` and to `escrow`, the escrow row of
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
