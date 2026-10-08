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
 *     and it is never a mock escrow outside tests or a gateway-funded one. A real escrow counts
 *     only on a finalized verification record of the buyer's funding (buyer funding plan S2.1),
 *     and its scope goes live only through reconcilePaidScope (S2.2, reconcile-paid-scope.ts).
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
import {
  fundingRecordStore,
  isWellFormedFundingRecord,
  sameAddress,
  type FundingVerificationRecord,
} from "./funding-record-port.js";

/** Minted, not live: the kernel's operator accepts it or revokes it. */
export const SCOPE_AWAITING_ACCEPTANCE = "awaiting_acceptance";
/** Accepted, but its escrow is not the buyer's own, real funding. */
export const SCOPE_AWAITING_FUNDING = "awaiting_funding";
/** Its buyer is on the kernel's block list. */
export const SCOPE_REJECTED = "rejected";

/**
 * A paid write scope's lifetime: one hour. createJobFromSession sets expiresAt = mint + this, which
 * for a scope that is not live yet is the window in which it may still be accepted and funded.
 * reconcilePaidScope, which makes a scope live on its buyer's verified funding, sets expiresAt =
 * activation + this: the scope's write time starts when it goes live, not at the mint.
 */
export const PAID_SCOPE_TTL_MS = 60 * 60_000;

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

/** Why an escrow ROW cannot pay for `buyer`'s scope, whatever the chain says, or null. */
export type EscrowRowRefusal = "escrow_missing" | "escrow_payer_not_buyer" | "escrow_not_funded";

/**
 * The escrow row's own preconditions, for a mock and a real escrow alike: it exists, its payer
 * label is the buyer, and its status is funded or active. None of this is proof of funding (the
 * payer column is a label and the status a DB flag); a real escrow needs its verification record
 * besides (buyerFundingVerdict, reconcilePaidScope).
 */
export function escrowRowRefusal(escrow: FundingEscrow | undefined | null, buyer: string): EscrowRowRefusal | null {
  if (!escrow) return "escrow_missing";
  if (!sameIdentity(escrow.payer, buyer)) return "escrow_payer_not_buyer";
  if (escrow.status !== "funded" && escrow.status !== "active") return "escrow_not_funded";
  return null;
}

/** Why an escrow is not the buyer's own, real funding of a scope. */
export type BuyerFundingRefusal =
  | EscrowRowRefusal
  | "mock_escrow"
  | "escrow_not_buyer_funded"
  | "funding_record_scope_mismatch";

/**
 * Whether an escrow is the buyer's own, real funding of a scope, and what proves it:
 *   - mock_funded: a mock escrow, in a test process with mock settlement on (mockFundsWrites);
 *   - record_funded: a real escrow whose finalized verification record (funding-record-port.ts)
 *     names this escrow, this buyer and this scope. The scope goes live on it only through
 *     reconcilePaidScope, which starts its TTL at that activation;
 *   - refused, with the reason.
 */
export type FundingVerdict =
  | { kind: "mock_funded" }
  | { kind: "record_funded"; record: FundingVerificationRecord }
  | { kind: "refused"; reason: BuyerFundingRefusal };

const refusedFunding = (reason: BuyerFundingRefusal): FundingVerdict => ({ kind: "refused", reason });

/**
 * N133 rule 3 for `buyer`'s scope `scopeId`, paid by `escrow`. Every real escrow this gateway
 * creates names the gateway signer as its on-chain payer (V1 createEscrow, V2 createEscrowV2, V3
 * createEscrowV3), V3 mode A funds it from the gateway's own key at creation, and POST
 * /api/escrow/chain/:address/fund funds from the gateway signer too. So a real escrow is the
 * buyer's own funding only on a finalized verification record of it (buyer funding plan S2.1): the
 * one record kept for the escrow, whose verified payer is `buyer` and which names `scopeId`. No
 * record store is configured outside a test process (Q9), so there every real escrow is refused
 * escrow_not_buyer_funded, as before. Without a `scopeId` (the mint, when the scope does not exist
 * yet) no record can name the scope, so a real escrow never passes there. A mock escrow counts
 * only in a test process with mock settlement on (mockFundsWrites; N133 r1, astra HIGH): never in
 * production, and never in a development gateway either. That rule is unchanged.
 */
export function buyerFundingVerdict(
  escrow: FundingEscrow | undefined | null,
  buyer: string,
  scopeId?: string | null,
): FundingVerdict {
  const row = escrowRowRefusal(escrow, buyer);
  if (row !== null || !escrow) return refusedFunding(row ?? "escrow_missing");
  if (escrow.contractAddress.startsWith("mock-escrow-")) {
    return mockFundsWrites() ? { kind: "mock_funded" } : refusedFunding("mock_escrow");
  }
  const store = fundingRecordStore();
  if (!store) return refusedFunding("escrow_not_buyer_funded");
  const record = store.findByEscrow(getStore().db, escrow.contractAddress);
  // A record proves funding only when it is well formed and finalized, is this escrow's (the store
  // answers by escrow; checked again, defence in depth) and its verified payer is this buyer.
  if (
    !record ||
    !isWellFormedFundingRecord(record) ||
    !sameAddress(record.escrowAddress, escrow.contractAddress) ||
    !sameIdentity(record.buyer, buyer)
  ) {
    return refusedFunding("escrow_not_buyer_funded");
  }
  if (typeof scopeId !== "string" || record.scopeId !== scopeId) return refusedFunding("funding_record_scope_mismatch");
  return { kind: "record_funded", record };
}

/**
 * Why `escrow` is not `buyer`'s own, real funding (of scope `scopeId`, when given), or null when it
 * is. The rule is buyerFundingVerdict's.
 */
export function buyerFundingRefusal(
  escrow: FundingEscrow | undefined | null,
  buyer: string,
  scopeId?: string | null,
): BuyerFundingRefusal | null {
  const verdict = buyerFundingVerdict(escrow, buyer, scopeId);
  return verdict.kind === "refused" ? verdict.reason : null;
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

/** The funding verdict for an accepted scope: its job's escrow, its buyer, the scope itself. */
export function scopeFundingVerdict(scope: { id: string; jobId: string | null; createdBy: string }): FundingVerdict {
  return buyerFundingVerdict(escrowForJob(scope.jobId), scope.createdBy, scope.id);
}

/** Why an accepted scope is not paid by its buyer's own, real funding, or null when it is. */
export function scopeFundingRefusal(scope: { id: string; jobId: string | null; createdBy: string }): BuyerFundingRefusal | null {
  const verdict = scopeFundingVerdict(scope);
  return verdict.kind === "refused" ? verdict.reason : null;
}
