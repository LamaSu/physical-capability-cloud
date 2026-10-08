/**
 * Buyer funding, Stage 2 (research/buyer-funding-plan-20261008.md): the binding rule of a funding
 * verification record, in one place, so that reconcilePaidScope (S2.2) and the funding-status DTO
 * (S2.4) read it the same way (fund-s2 review MEDIUM-1). A record binds to a paid write scope and the
 * escrow row of the scope's job when, checked in this order:
 *   1. it is a well-formed, finalized verification record (isWellFormedFundingRecord), or
 *      record_malformed;
 *   2. it names the scope, or record_scope_mismatch;
 *   3. its verified payer is the scope's buyer, or record_buyer_not_scope_buyer;
 *   4. the job has an escrow row, or escrow_missing;
 *   5. the row's payer label is the scope's buyer, or escrow_payer_not_buyer;
 *   6. the record's escrow is the row's contract (sameAddress), or record_escrow_not_scope_escrow.
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

export type RecordScopeRefusal = "record_malformed" | "record_scope_mismatch" | "record_buyer_not_scope_buyer";
export type EscrowLabelRefusal = "escrow_missing" | "escrow_payer_not_buyer";
export type RecordEscrowRefusal = "record_escrow_not_scope_escrow";

/** Checks 1 to 3: `record` is a well-formed record of `scope` and of its buyer, or why not. */
export function recordScopeRefusal(record: unknown, scope: BindingScope): RecordScopeRefusal | null {
  if (!isWellFormedFundingRecord(record)) return "record_malformed";
  if (record.scopeId !== scope.id) return "record_scope_mismatch";
  if (!sameIdentity(record.buyer, scope.createdBy)) return "record_buyer_not_scope_buyer";
  return null;
}

/** Checks 4 and 5: the job's escrow row exists and its payer label is `buyer`, or why not. */
export function escrowLabelRefusal(escrow: BindingEscrow | null | undefined, buyer: string): EscrowLabelRefusal | null {
  if (!escrow) return "escrow_missing";
  if (!sameIdentity(escrow.payer, buyer)) return "escrow_payer_not_buyer";
  return null;
}

/** Check 6: the record's escrow is the row's contract, in any letter case, or why not. */
export function recordEscrowRefusal(record: FundingVerificationRecord, escrow: BindingEscrow): RecordEscrowRefusal | null {
  return sameAddress(escrow.contractAddress, record.escrowAddress) ? null : "record_escrow_not_scope_escrow";
}
