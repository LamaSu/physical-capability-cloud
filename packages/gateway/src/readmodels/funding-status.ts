/**
 * FundingStatusDTO: where a paid write scope's buyer funding stands, for the UI (buyer funding plan
 * S2.4, research/buyer-funding-plan-20261008.md). A pure projection of three sources the caller read,
 * and the expected chain (the pinned V-next deployment record's, paid-scope-activation-terms.ts;
 * null when none is pinned, and then no record binds):
 *   - the scope row (execution_scopes): its status and its own createdAt and expiresAt;
 *   - the funding verification record that names the scope (FundingRecordStore.findByScope), or
 *     null when there is none;
 *   - the escrow row of the scope's job (escrowForJob: contractAddress, payer label, status), or
 *     null when the job has none (no job, no session, or no escrow row).
 *
 * RULES (the readmodels charter):
 *   - One explicit enum. A state is never inferred from a mock escrow, a DB flag or a balance:
 *     funded_verified needs the finalized verification record itself, on the expected chain, BOUND
 *     to this scope, its buyer and its job's escrow row by the rule reconcilePaidScope applies
 *     (services/funding-binding.ts; fund-s2 review MEDIUM-1). Before activation it also needs the
 *     escrow row's status to pass reconcile's precondition, by the same function reconcile activates
 *     by (activationRefusal; the steward's ruling 1). Once live the row's status is not read: it
 *     reads completed after settlement, and the funding that activated the scope stays verified
 *     (R1-a, rowStatusGatesFunding, pending the steward's confirmation).
 *   - A mock escrow never reads funded_verified, whatever the settlement mode: nothing here reads
 *     the mode, and a mock row's "mock-escrow-..." contract is never a 0x address, so no record binds
 *     to it (the steward's condition (iii), bulletin 7195).
 *   - Whatever the sources cannot place fails closed to `unknown`, never to a funded state.
 *   - Timestamps are the sources' own; a value is never filled with "now". `asOf` is when the
 *     caller read the sources, not a change time.
 *   - No mock fallback: a scope that went live on a mock escrow has no record, so it is `unknown`.
 *
 * No route serves this yet (none sits next to an existing readmodels route trivially: a read needs
 * its own object authorization, the buyer, the kernel's operator or the admin), so it is the
 * projection only. It reads no clock, database or environment: the same inputs give the same DTO.
 */
import {
  activationRefusal,
  fundingBindingRefusal,
  type BindingEscrowRow,
  type FundingBindingRefusal,
} from "../services/funding-binding.js";
import type { FundingVerificationRecord } from "../services/funding-record-port.js";
import { scopeExpiryMs } from "../services/scope-expiry.js";

/** Schema id for clients that pin a version. */
export const FUNDING_STATUS_SCHEMA_ID = "pcc.funding-status/v1" as const;

/**
 * How the record stands against the scope and the escrow row of its job: `no_record`, the first
 * binding check that fails (services/funding-binding.ts, checked in this order), or `bound`.
 *
 *   no_record                       no record was given.
 *   record_malformed                the record is not a well-formed, finalized verification record.
 *   record_chain_mismatch           it was verified on another chain than the expected one, or no
 *                                   usable expected chain was given (the steward's ruling 4).
 *   record_scope_mismatch           it names another scope.
 *   record_buyer_not_scope_buyer    its verified payer is not the scope's buyer.
 *   escrow_missing                  the scope's job has no escrow row: never funded_verified.
 *   escrow_payer_not_buyer          the escrow row's payer label is not the scope's buyer.
 *   record_escrow_not_scope_escrow  the record's escrow is not the escrow row's contract (letter case
 *                                   aside): a record of this scope and buyer for another escrow (the
 *                                   review's P7), never funded_verified.
 *   bound                           none of the above: the buyer's funding of the escrow of this
 *                                   scope's job was verified at a finalized block.
 *
 * funded_verified needs `bound` (and, before activation, the escrow row's status: FUNDING_STATES), and
 * only `bound` shows the verification. The members are reconcilePaidScope's refusal names, in the
 * binding rule's order; record_chain_mismatch is the steward's ruling 4's (a 9th member).
 */
export const FUNDING_BINDINGS = [
  "no_record",
  "record_malformed",
  "record_chain_mismatch",
  "record_scope_mismatch",
  "record_buyer_not_scope_buyer",
  "escrow_missing",
  "escrow_payer_not_buyer",
  "record_escrow_not_scope_escrow",
  "bound",
] as const satisfies readonly ("no_record" | FundingBindingRefusal | "bound")[];
export type FundingBinding = (typeof FUNDING_BINDINGS)[number];

/**
 * The funding states, in ONE total order over every input (stateOf; the first that holds wins). The
 * inputs: the scope row's status and window (asOf against its expiresAt), the binding (above), and
 * whether reconcilePaidScope could activate on the record (activationRefusal, funding-binding.ts: the
 * binding and the escrow row's status, funded or active). The steward's ruling 1 (bulletin 7191):
 *   1. cancelled         status revoked or rejected (a blocked buyer's scope is minted rejected): the
 *                        scope row is the source, whatever the window, the record or the escrow row.
 *   2. expired           status awaiting_acceptance or awaiting_funding, and asOf >= expiresAt or either
 *                        time unreadable: the window to accept and fund lapsed, and the scope never goes
 *                        live (reconcilePaidScope answers expired the same way). Whatever the record or
 *                        the row.
 *   3. funded_verified   (a) status awaiting_acceptance or awaiting_funding, window open, and
 *                        reconcilePaidScope could activate on the record: it is bound AND the escrow
 *                        row's status is funded or active. This says the funding is verified; whether the
 *                        activation then happens is reconcile's (the stop, the block list) and the
 *                        operator's acceptance, which this projection does not read.
 *                        (b) status active, expired (an active scope past its TTL) or suspended_rogue
 *                        (ONCE_LIVE), and the record is bound, whatever the row's status now (it reads
 *                        completed after settlement). Whether the scope may still write is its own
 *                        status, reported beside it.
 *                        The row's status is read in (a) and not in (b): R1-a, rowStatusGatesFunding.
 *   4. prepared          status awaiting_acceptance, window open, no record: minted, and the kernel's
 *                        operator has not accepted it yet, so funding is not asked for (V-next's fund()
 *                        needs the operator's signature first).
 *   5. awaiting_funding  status awaiting_funding, window open, no record: accepted; no verification of
 *                        the buyer's funding is recorded.
 *   6. unknown           anything else: a record that is not bound (`binding` says why); a bound record
 *                        before activation on an escrow row that is not funded or active (`binding` reads
 *                        bound); no record on a live status (a mock-escrow or pre-N133 activation); a
 *                        status this projection does not know. Never a funded state.
 * `verification` is shown whenever the binding is `bound`, whatever the state: an expired, cancelled
 * or unknown scope's UI can still say "funded, never activated: reclaim after <date>".
 *
 * There is no state for a funding transaction that is seen but not finalized yet: no source can say
 * that (a record is written only at a finalized block), so it is left out until the operator's Q9
 * table gives it one, and added in the change that produces it (the steward's ruling 6).
 */
export const FUNDING_STATES = [
  "prepared",
  "awaiting_funding",
  "funded_verified",
  "expired",
  "cancelled",
  "unknown",
] as const;
export type FundingState = (typeof FUNDING_STATES)[number];

/** Before activation: the scope's expiresAt ends the window in which it may be accepted and funded. */
const PRE_ACTIVATION: ReadonlySet<string> = new Set(["awaiting_acceptance", "awaiting_funding"]);
/** The scope row's own end: revoked by the operator, or minted rejected for a blocked buyer. */
const CANCELLED: ReadonlySet<string> = new Set(["revoked", "rejected"]);
/**
 * Statuses a scope reaches only once live: GET scope expires an active scope past its TTL, and the
 * heartbeat monitor suspends one.
 */
const ONCE_LIVE: ReadonlySet<string> = new Set(["active", "expired", "suspended_rogue"]);

/**
 * R1-a: whether the escrow row's status gates funded_verified for a scope in `scopeStatus`. The lane's
 * reading of ruling 1, PENDING the steward's confirmation (reviewer-hotel's recommendation): only
 * before activation, where reconcilePaidScope's activation reads it (precondition (c)). Once live,
 * reconcile's idempotent answer does not read it either, and the row's later status (completed after
 * settlement) does not undo the verified funding that activated the scope. To read the row's status in
 * every state instead (ruling 1's first bullet read literally), return true here: a bound record on a
 * settled job then reads unknown.
 */
function rowStatusGatesFunding(scopeStatus: string): boolean {
  return PRE_ACTIVATION.has(scopeStatus);
}

/** The scope row fields the projection reads. */
export interface FundingScopeRow {
  id: string;
  jobId: string | null;
  createdBy: string;
  status: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * The escrow row of the scope's job, as escrowForJob returns it, or null when the job has none. Its
 * status is read before activation only (rowStatusGatesFunding).
 */
export type FundingEscrowRow = BindingEscrowRow | null;

export interface FundingStatusDTO {
  schemaId: typeof FUNDING_STATUS_SCHEMA_ID;
  /** ISO-8601 UTC: when the caller read the three sources. */
  asOf: string;
  scopeId: string;
  jobId: string | null;
  state: FundingState;
  /** How the record stands against this scope and its job's escrow row (FUNDING_BINDINGS). */
  binding: FundingBinding;
  /** The scope row, as read. */
  scope: {
    /** execution_scopes.status, unchanged. */
    sourceStatus: string;
    /** When the scope was minted (execution_scopes.created_at). */
    createdAt: string;
    /**
     * execution_scopes.expires_at, unchanged. Before the scope goes live it ends the window in
     * which it may still be accepted and funded (mint + the TTL); once reconcilePaidScope makes it
     * live, it ends the scope's write time (activation + the TTL).
     */
    expiresAt: string;
  };
  /**
   * The verification, as recorded, whenever the record is bound, whatever the state (an expired,
   * revoked or rejected scope included). Null when the binding is anything else.
   */
  verification: {
    escrowAddress: string;
    chainId: number;
    blockNumber: string;
    blockHash: string;
    verifierVersion: string;
    verifiedAt: string;
  } | null;
}

/**
 * asOf < expiresAt, both readable. Anything unreadable leaves the window closed: an unreadable asOf
 * is NaN (every comparison false), and an unreadable expiresAt is long past (scopeExpiryMs, as the
 * accept route and reconcilePaidScope read it).
 */
function windowOpen(asOf: string, expiresAt: string): boolean {
  return Date.parse(asOf) < scopeExpiryMs(expiresAt);
}

/** How `record` stands against `scope`, its job's escrow row `escrow` and chain `expectedChainId`. See FUNDING_BINDINGS. */
export function fundingBindingOf(
  scope: FundingScopeRow,
  record: FundingVerificationRecord | null,
  escrow: FundingEscrowRow,
  expectedChainId: number | null,
): FundingBinding {
  if (record === null) return "no_record";
  return fundingBindingRefusal(record, scope, escrow, expectedChainId) ?? "bound";
}

/**
 * The state from the scope row, the binding, whether reconcile could activate on the record (`ready`)
 * and asOf: the total order, in one place. See FUNDING_STATES.
 */
function stateOf(scope: FundingScopeRow, binding: FundingBinding, ready: boolean, asOf: string): FundingState {
  if (CANCELLED.has(scope.status)) return "cancelled"; // 1
  const beforeActivation = PRE_ACTIVATION.has(scope.status);
  if (beforeActivation && !windowOpen(asOf, scope.expiresAt)) return "expired"; // 2
  const funded = rowStatusGatesFunding(scope.status) ? ready : binding === "bound";
  if (beforeActivation) {
    if (funded) return "funded_verified"; // 3a
    if (binding !== "no_record") return "unknown"; // 6
    return scope.status === "awaiting_acceptance" ? "prepared" : "awaiting_funding"; // 4, 5
  }
  return ONCE_LIVE.has(scope.status) && funded ? "funded_verified" : "unknown"; // 3b, 6
}

/** Whether reconcilePaidScope could activate `scope` on `record` (activationRefusal), as far as the sources say. */
function readyToActivate(
  scope: FundingScopeRow,
  record: FundingVerificationRecord | null,
  escrow: FundingEscrowRow,
  expectedChainId: number | null,
): boolean {
  return record !== null && activationRefusal(record, scope, escrow, expectedChainId) === null;
}

/**
 * The funding state of `scope`, given the record that names it and its job's escrow row (or nulls),
 * and the expected chain. See FUNDING_STATES.
 */
export function fundingStateOf(
  scope: FundingScopeRow,
  record: FundingVerificationRecord | null,
  escrow: FundingEscrowRow,
  expectedChainId: number | null,
  asOf: string,
): FundingState {
  return stateOf(scope, fundingBindingOf(scope, record, escrow, expectedChainId), readyToActivate(scope, record, escrow, expectedChainId), asOf);
}

/** The DTO: the state and the binding, with the sources' own values beside them. */
export function projectFundingStatus(
  scope: FundingScopeRow,
  record: FundingVerificationRecord | null,
  escrow: FundingEscrowRow,
  expectedChainId: number | null,
  asOf: string,
): FundingStatusDTO {
  const binding = fundingBindingOf(scope, record, escrow, expectedChainId);
  return {
    schemaId: FUNDING_STATUS_SCHEMA_ID,
    asOf,
    scopeId: scope.id,
    jobId: scope.jobId,
    state: stateOf(scope, binding, readyToActivate(scope, record, escrow, expectedChainId), asOf),
    binding,
    scope: { sourceStatus: scope.status, createdAt: scope.createdAt, expiresAt: scope.expiresAt },
    verification:
      binding === "bound" && record !== null
        ? {
            escrowAddress: record.escrowAddress,
            chainId: record.chainId,
            blockNumber: record.blockNumber,
            blockHash: record.blockHash,
            verifierVersion: record.verifierVersion,
            verifiedAt: record.verifiedAt,
          }
        : null,
  };
}
