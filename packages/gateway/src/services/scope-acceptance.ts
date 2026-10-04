/**
 * Board N133 (CRITICAL; the steward's DECISIONS 01:01, #6733): when a paid write scope goes live.
 *
 * createJobFromSession mints the scope a paid job's buyer writes under, and since f6359711 its
 * proven holder may actuate the kernel. So the scope is not live (`active`) until two things hold:
 *   - Rule 2, the kernel operator's acceptance, per its policy. An "auto" policy accepts; a
 *     "policy" policy accepts its trusted agents; anything else, a manual policy, a missing or
 *     unreadable one included, waits in `awaiting_acceptance` for the operator's decision (POST
 *     /api/operator/scopes/:scopeId/accept, a decision; refusing it is a revoke). A buyer on the
 *     kernel's block list gets a dead (`rejected`) scope.
 *   - Rule 3, the buyer's own, real funding: the escrow's payer is the buyer and it is funded,
 *     and it is never a mock escrow outside tests or a gateway-funded one.
 * The relay admits only `active` scopes (scopeWriteRefusal, dispatchRefusal, holdsActiveScope,
 * isProvenHolderOfNamedScope), so the states below are refused there without a relay change.
 *
 * The decision is the scope's own state, not a pending_approvals row: every writer of that table
 * must sit in a route behind the kernel-ownership guard (the steward's #6493 (2), the N31 route
 * inventory), and the mint runs for the buyer, who is not the kernel's principal. An approved
 * approval is also a job the OT-2 executor runs (scripts/ot2-agent.py), which a scope is not.
 */
import { getStore, getRepos } from "../db.js";
import { schema, eq } from "@pcc/store";
import { sameIdentity } from "../auth/buyer-identity.js";
import { mockFundsWrites } from "./settlement-mode.js";

/** Minted, not live: the kernel's operator accepts it or revokes it. */
export const SCOPE_AWAITING_ACCEPTANCE = "awaiting_acceptance";
/** Accepted, but its escrow is not the buyer's own, real funding. */
export const SCOPE_AWAITING_FUNDING = "awaiting_funding";
/** Its buyer is on the kernel's block list. */
export const SCOPE_REJECTED = "rejected";

export type Acceptance = "accepted" | "awaiting_operator" | "refused";

/**
 * The kernel operator's acceptance of `buyer`'s scope, per its policy (the approval part of
 * evaluatePolicy: the block list, then the approval mode). Where the policy is silent, missing,
 * malformed or of an unknown mode, nothing is accepted for the operator.
 */
export function acceptanceFor(policy: unknown, buyer: string): Acceptance {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return "awaiting_operator";
  const p = policy as Record<string, unknown>;
  const listed = (list: unknown) => Array.isArray(list) && list.some((id) => sameIdentity(id, buyer));
  if (listed(p.blockedAgents)) return "refused";
  if (p.approvalMode === "auto") return "accepted";
  if (p.approvalMode === "policy" && listed(p.trustedAgents)) return "accepted";
  return "awaiting_operator";
}

/** The escrow fields the funding rule reads. */
export interface FundingEscrow {
  payer: string;
  status: string;
  contractAddress: string;
}

/**
 * Why `escrow` is not `buyer`'s own, real funding, or null when it is. Every real escrow this
 * gateway creates names the gateway signer as its on-chain payer (V1 createEscrow, V2
 * createEscrowV2, V3 createEscrowV3), V3 mode A funds it from the gateway's own key at creation,
 * and POST /api/escrow/chain/:address/fund funds from the gateway signer too. So no real escrow is
 * the buyer's own funding until a path exists in which the buyer's wallet is the payer and funds
 * it; that path must record it and move `awaiting_funding` scopes to `active`. A mock escrow
 * counts only in a test process with mock settlement on (mockFundsWrites; N133 r1, astra HIGH):
 * never in production, and never in a development gateway either.
 */
export function buyerFundingRefusal(escrow: FundingEscrow | undefined | null, buyer: string): string | null {
  if (!escrow) return "escrow_missing";
  if (!sameIdentity(escrow.payer, buyer)) return "escrow_payer_not_buyer";
  if (escrow.status !== "funded" && escrow.status !== "active") return "escrow_not_funded";
  if (escrow.contractAddress.startsWith("mock-escrow-")) return mockFundsWrites() ? null : "mock_escrow";
  return "escrow_not_buyer_funded";
}

/** The escrow a job-bound scope is paid by, found the way the relay's escrowRefusal finds it. */
export function escrowForJob(jobId: string | null | undefined): FundingEscrow | undefined {
  if (!jobId) return undefined;
  const session = getStore()
    .db.select()
    .from(schema.negotiationSessions)
    .where(eq(schema.negotiationSessions.jobId, jobId))
    .get();
  if (!session?.cwmId) return undefined;
  return getRepos().escrows.findByCwm(session.cwmId);
}

/** Why an accepted scope is not paid by its buyer's own, real funding, or null when it is. */
export function scopeFundingRefusal(scope: { jobId: string | null; createdBy: string }): string | null {
  return buyerFundingRefusal(escrowForJob(scope.jobId), scope.createdBy);
}
