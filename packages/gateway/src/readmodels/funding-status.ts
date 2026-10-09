/**
 * FundingStatusDTO: where a paid write scope's buyer funding stands, for the UI (buyer funding plan
 * S2.4, research/buyer-funding-plan-20261008.md). A pure projection of three sources the caller read:
 *   - the scope row (execution_scopes): its status and its own createdAt and expiresAt;
 *   - the funding verification record that names the scope (FundingRecordStore.findByScope), or
 *     null when there is none;
 *   - the escrow row of the scope's job (escrowForJob: contractAddress, payer label, status), or
 *     null when the job has none (no job, no session, or no escrow row).
 *
 * RULES (the readmodels charter):
 *   - One explicit enum. A state is never inferred from a mock escrow, a DB flag or a balance:
 *     funded_verified needs the finalized verification record itself, BOUND to this scope, its buyer
 *     and its job's escrow row by the rule reconcilePaidScope applies (services/funding-binding.ts;
 *     fund-s2 review MEDIUM-1). The escrow row's status is not read: it reads completed after
 *     settlement, and the binding does not end there.
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
  fundingBindingRefusal,
  type BindingEscrow,
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
 * Only `bound` makes the state funded_verified, and only `bound` shows the verification.
 */
export const FUNDING_BINDINGS = [
  "no_record",
  "record_malformed",
  "record_scope_mismatch",
  "record_buyer_not_scope_buyer",
  "escrow_missing",
  "escrow_payer_not_buyer",
  "record_escrow_not_scope_escrow",
  "bound",
] as const satisfies readonly ("no_record" | FundingBindingRefusal | "bound")[];
export type FundingBinding = (typeof FUNDING_BINDINGS)[number];

/**
 * The funding states. Exact conditions; fundingStateOf is the one place that orders them, and the
 * two rules marked PROPOSAL are the lane's, pending the steward's and gateway's ruling (MEDIUM-1).
 *
 * Status awaiting_acceptance or awaiting_funding (before activation), first that holds:
 *   expired           asOf >= expiresAt, or either time unreadable: the window to accept and fund
 *                     lapsed, and the scope never goes live (reconcilePaidScope answers expired the
 *                     same way). PROPOSAL: this holds whatever the record, a bound one included; the
 *                     verification stays visible ("funded, never activated: reclaim after <date>").
 *   funded_verified   the record is bound (the accept, or reconcilePaidScope, can still activate it).
 *   unknown           a record is given that is not bound (`binding` says why).
 *   prepared          no record, status awaiting_acceptance: minted, and the kernel's operator has
 *                     not accepted it yet, so funding is not asked for (V-next's fund() needs the
 *                     operator's signature first).
 *   awaiting_funding  no record, status awaiting_funding: accepted; no verification of the buyer's
 *                     funding is recorded.
 * Any other status:
 *   funded_verified   the record is bound and the status is one a scope reaches only once live
 *                     (ONCE_LIVE: active; expired, an active scope past its TTL; suspended_rogue).
 *                     Whether the scope may still write is its own status, reported beside it.
 *   unknown           anything else: no bound record (a mock-escrow or pre-N133 activation, a record
 *                     that is not bound), or a status this projection does not know. PROPOSAL:
 *                     revoked and rejected (a blocked buyer's scope is minted rejected) are not in
 *                     ONCE_LIVE, so their terminal state wins over a bound record; the verification
 *                     stays visible.
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
  "unknown",
] as const;
export type FundingState = (typeof FUNDING_STATES)[number];

/** Before activation: the scope's expiresAt ends the window in which it may be accepted and funded. */
const PRE_ACTIVATION: ReadonlySet<string> = new Set(["awaiting_acceptance", "awaiting_funding"]);
/**
 * Statuses a scope reaches only once live: GET scope expires an active scope past its TTL, and the
 * heartbeat monitor suspends one. PROPOSAL (MEDIUM-1): revoked and rejected are left out, so on a
 * revoked or rejected scope a bound record reads unknown, its verification still shown.
 */
const ONCE_LIVE: ReadonlySet<string> = new Set(["active", "expired", "suspended_rogue"]);

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
 * status is part of the row but is not read (see the module comment).
 */
export type FundingEscrowRow = (BindingEscrow & { status: string }) | null;

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

/** How `record` stands against `scope` and its job's escrow row `escrow`. See FUNDING_BINDINGS. */
export function fundingBindingOf(scope: FundingScopeRow, record: FundingVerificationRecord | null, escrow: FundingEscrowRow): FundingBinding {
  if (record === null) return "no_record";
  return fundingBindingRefusal(record, scope, escrow) ?? "bound";
}

/** The state from the scope row, the binding and asOf: the precedence, in one place. See FUNDING_STATES. */
function stateOf(scope: FundingScopeRow, binding: FundingBinding, asOf: string): FundingState {
  if (PRE_ACTIVATION.has(scope.status)) {
    // PROPOSAL (MEDIUM-1): a lapsed or unreadable window wins over a bound record.
    if (!windowOpen(asOf, scope.expiresAt)) return "expired";
    if (binding === "bound") return "funded_verified";
    if (binding !== "no_record") return "unknown";
    return scope.status === "awaiting_acceptance" ? "prepared" : "awaiting_funding";
  }
  // PROPOSAL (MEDIUM-1): ONCE_LIVE leaves out revoked and rejected (their terminal state wins).
  return binding === "bound" && ONCE_LIVE.has(scope.status) ? "funded_verified" : "unknown";
}

/** The funding state of `scope`, given the record that names it and its job's escrow row (or nulls). See FUNDING_STATES. */
export function fundingStateOf(
  scope: FundingScopeRow,
  record: FundingVerificationRecord | null,
  escrow: FundingEscrowRow,
  asOf: string,
): FundingState {
  return stateOf(scope, fundingBindingOf(scope, record, escrow), asOf);
}

/** The DTO: the state and the binding, with the sources' own values beside them. */
export function projectFundingStatus(
  scope: FundingScopeRow,
  record: FundingVerificationRecord | null,
  escrow: FundingEscrowRow,
  asOf: string,
): FundingStatusDTO {
  const binding = fundingBindingOf(scope, record, escrow);
  return {
    schemaId: FUNDING_STATUS_SCHEMA_ID,
    asOf,
    scopeId: scope.id,
    jobId: scope.jobId,
    state: stateOf(scope, binding, asOf),
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
