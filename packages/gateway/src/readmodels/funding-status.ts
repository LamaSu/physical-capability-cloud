/**
 * FundingStatusDTO: where a paid write scope's buyer funding stands, for the UI (buyer funding plan
 * S2.4, research/buyer-funding-plan-20261008.md). A pure projection of two sources the caller read:
 *   - the scope row (execution_scopes): its status and its own createdAt and expiresAt;
 *   - the funding verification record that names the scope (FundingRecordStore.findByScope), or
 *     null when there is none.
 *
 * RULES (the readmodels charter):
 *   - One explicit enum. A state is never inferred from a mock escrow, a DB flag or a balance:
 *     funded_verified needs the finalized verification record itself.
 *   - Whatever the sources cannot place fails closed to `unknown`, never to a funded state.
 *   - Timestamps are the sources' own; a value is never filled with "now". `asOf` is when the
 *     caller read the sources, not a change time.
 *   - No mock fallback: a scope that went live on a mock escrow has no record, so it is `unknown`.
 *
 * No route serves this yet (none sits next to an existing readmodels route trivially: a read needs
 * its own object authorization, the buyer, the kernel's operator or the admin), so it is the
 * projection only. It reads no clock, database or environment: the same inputs give the same DTO.
 */
import { sameIdentity } from "../auth/buyer-identity.js";
import { isWellFormedFundingRecord, type FundingVerificationRecord } from "../services/funding-record-port.js";

/** Schema id for clients that pin a version. */
export const FUNDING_STATUS_SCHEMA_ID = "pcc.funding-status/v1" as const;

/**
 * The funding states. Exact conditions, evaluated in this order (the first that holds wins); a
 * "well-formed record" passes isWellFormedFundingRecord (so it is finalized), names this scope
 * (record.scopeId === scope.id) and has the scope's buyer as its verified payer.
 *
 *   funded_verified   a well-formed record is present: the buyer's funding of this scope's escrow
 *                     was verified at a finalized block. It stays funded_verified whatever the
 *                     scope's status became since (live, past its TTL, revoked): whether the scope
 *                     may still write is the scope's own status, reported beside it.
 *   unknown           a record is present but is not a well-formed record of this scope and buyer
 *                     (another scope's, another buyer's, malformed, not finalized). It is never
 *                     shown as this scope's funding.
 * With no record:
 *   prepared          status awaiting_acceptance and asOf < expiresAt: minted, and the kernel's
 *                     operator has not accepted it yet, so funding is not asked for (V-next's
 *                     fund() needs the operator's signature first).
 *   awaiting_funding  status awaiting_funding and asOf < expiresAt: accepted; no verification of
 *                     the buyer's funding is recorded.
 *   expired           status awaiting_acceptance or awaiting_funding, and asOf >= expiresAt (or
 *                     either time unreadable): the window to accept and fund lapsed, and the scope
 *                     never goes live (reconcilePaidScope answers expired the same way).
 *   unknown           any other status: active without a record (a mock-escrow or pre-N133
 *                     activation), revoked, rejected, expired (an active scope past its TTL),
 *                     suspended_rogue, or a value this projection does not know.
 *
 *   confirming        RESERVED. It means the buyer's funding transaction is seen and its block is
 *                     not finalized yet. Neither source can say that: a record is written only at
 *                     a finalized block, and an unfinalized observation belongs to the parked
 *                     escrow_funding table (the operator's decision Q9) and the Stage-1 verifier.
 *                     This projection never produces it.
 */
export const FUNDING_STATES = [
  "prepared",
  "awaiting_funding",
  "confirming",
  "funded_verified",
  "expired",
  "unknown",
] as const;
export type FundingState = (typeof FUNDING_STATES)[number];

/** The scope row fields the projection reads. */
export interface FundingScopeRow {
  id: string;
  jobId: string | null;
  createdBy: string;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export interface FundingStatusDTO {
  schemaId: typeof FUNDING_STATUS_SCHEMA_ID;
  /** ISO-8601 UTC: when the caller read the two sources. */
  asOf: string;
  scopeId: string;
  jobId: string | null;
  state: FundingState;
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
  /** The verification that makes the state funded_verified, as recorded. Null in every other state. */
  verification: {
    escrowAddress: string;
    chainId: number;
    blockNumber: string;
    blockHash: string;
    verifierVersion: string;
    verifiedAt: string;
  } | null;
}

/** asOf < expiresAt, both readable. Anything unreadable leaves the window closed. */
function windowOpen(asOf: string, expiresAt: string): boolean {
  return Date.parse(asOf) < Date.parse(expiresAt);
}

/** The funding state of `scope`, given the record that names it (or null). See FUNDING_STATES. */
export function fundingStateOf(scope: FundingScopeRow, record: FundingVerificationRecord | null, asOf: string): FundingState {
  if (record !== null) {
    const ours = isWellFormedFundingRecord(record) && record.scopeId === scope.id && sameIdentity(record.buyer, scope.createdBy);
    return ours ? "funded_verified" : "unknown";
  }
  switch (scope.status) {
    case "awaiting_acceptance":
      return windowOpen(asOf, scope.expiresAt) ? "prepared" : "expired";
    case "awaiting_funding":
      return windowOpen(asOf, scope.expiresAt) ? "awaiting_funding" : "expired";
    default:
      return "unknown";
  }
}

/** The DTO: the state, with the sources' own values beside it. */
export function projectFundingStatus(
  scope: FundingScopeRow,
  record: FundingVerificationRecord | null,
  asOf: string,
): FundingStatusDTO {
  const state = fundingStateOf(scope, record, asOf);
  return {
    schemaId: FUNDING_STATUS_SCHEMA_ID,
    asOf,
    scopeId: scope.id,
    jobId: scope.jobId,
    state,
    scope: { sourceStatus: scope.status, createdAt: scope.createdAt, expiresAt: scope.expiresAt },
    verification:
      state === "funded_verified" && record !== null
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
