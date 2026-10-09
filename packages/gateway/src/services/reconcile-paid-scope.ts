/**
 * Buyer funding, Stage 2 (readmodels; the plan's S2.2 and section 3 step 7,
 * research/buyer-funding-plan-20261008.md): reconcilePaidScope, the one place a paid write scope
 * goes live on its buyer's verified funding of a real escrow.
 *
 * One synchronous SQLite transaction (BEGIN IMMEDIATE; better-sqlite3 runs nothing else on the
 * connection until it ends, and holds the write lock against any other connection):
 *   a. re-read what allows the activation: the scope (not revoked, awaiting_funding, its
 *      pre-activation window still open: a lapsed window answers `expired` and the scope never
 *      activates), the kernel's emergency stop (clear, and its policy readable) and its operator
 *      policy (the buyer is not on the block list; a block list that is present but is not an
 *      array of strings is policy_unavailable, since it cannot show the buyer unblocked). The
 *      block-list read's catch (blockRefusal) is defence in depth and unreachable today:
 *      emergencyStopState reads the same policy row first, on the same connection, and answers
 *      unavailable (policy_unavailable here) when that read throws or the policy is not an object;
 *   b. insert the verification record through the funding-record port, unless the store already
 *      keeps this scope's record of this escrow (the Stage-1 verifier may have stored it first);
 *   c. compare-and-set the scope from awaiting_funding to active, with expiresAt = now +
 *      PAID_SCOPE_TTL_MS: the TTL starts at activation, not at the mint. A compare-and-set that
 *      changes anything but exactly one row throws, the transaction rolls back, and the insert is
 *      undone with it.
 *
 * Binding: the record must name this scope, its verified payer must be the scope's buyer, and its
 * escrow must be the scope's job's escrow (found the way the accept route and the relay find it),
 * whose row passes the same preconditions as at the accept (escrowRowRefusal). These are the binding
 * rule's checks (funding-binding.ts, shared with the funding-status DTO), plus the row's status
 * (funded or active), which only an activation needs. So the same buyer's escrow for another job
 * is refused. One funding activates one scope: a record of an escrow the
 * store already binds to another scope, or for a scope it binds to other funding, is refused. The
 * store sees the escrow address folded to lower case (escrowKey), for the lookup and in the
 * inserted record, so that holds even over a store that matches letter case exactly.
 *
 * Idempotent on (scopeId, escrow): once the scope is active on this escrow's record, a repeat
 * returns that activation (already_active) and inserts nothing and moves no TTL. The answer comes
 * before anything that reads the escrow row, so it still holds after settlement, when the row reads
 * completed (fund-s2 review LOW-3). It needs the record's own checks (well formed, this scope, this
 * buyer), the scope active, and the kept record being this scope's buyer's well-formed record of
 * this escrow. A record for a scope that is active on anything else is refused.
 *
 * Fails closed: no record store (production, until Q9) is funding_record_store_unavailable, and
 * nothing is read or written. The result is a typed discriminated union; nothing reads an error's
 * message, and no request value is written to any log or error.
 */
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import { schema, eq, and } from "@pcc/store";
import { getStore } from "../db.js";
import { emergencyStopState } from "../routes/device-relay.js";
import { recordEscrowRefusal, recordScopeRefusal } from "./funding-binding.js";
import { scopeExpiryMs } from "./scope-expiry.js";
import {
  acceptanceFor,
  escrowForJob,
  escrowRowRefusal,
  PAID_SCOPE_TTL_MS,
  SCOPE_AWAITING_FUNDING,
} from "./scope-acceptance.js";
import {
  escrowKey,
  fundingRecordStore,
  isWellFormedFundingRecord,
  sameAddress,
  type FundingTx,
  type FundingVerificationRecord,
} from "./funding-record-port.js";

const { executionScopes, operatorPolicies } = schema;

/** Every reason reconcilePaidScope refuses, in the order it checks them. */
export const RECONCILE_REFUSALS = [
  /** No record store is configured (production until Q9): nothing can be recorded. */
  "funding_record_store_unavailable",
  /** The record is not a well-formed, finalized verification record. */
  "record_malformed",
  /** The record names another scope. */
  "record_scope_mismatch",
  "scope_not_found",
  /** The record's verified payer is not the scope's buyer. */
  "record_buyer_not_scope_buyer",
  /** The scope's job has no escrow row (no job, no session, no escrow). */
  "escrow_missing",
  /** The escrow row's payer label is not the scope's buyer. */
  "escrow_payer_not_buyer",
  /** The escrow row's status is not funded or active. */
  "escrow_not_funded",
  /** The record's escrow is not the scope's job's escrow (e.g. the same buyer's escrow for another job). */
  "record_escrow_not_scope_escrow",
  /** The store already binds this escrow's funding to another scope. */
  "escrow_bound_to_other_scope",
  /** The store already binds this scope to other funding (another escrow, or a record that is not this buyer's). */
  "scope_bound_to_other_funding",
  /** The scope is live, and not on this escrow's record (a mock-escrow or pre-N133 activation). */
  "scope_active_other_funding",
  "scope_revoked",
  /** Any status but awaiting_funding (or active, above): not accepted yet, rejected, expired, ... */
  "scope_not_awaiting_funding",
  "kernel_emergency_stopped",
  /** The kernel's policy cannot be read, or its block list is not an array of strings: its stop or block list cannot be told. */
  "policy_unavailable",
  /** The buyer is on the kernel's block list. */
  "buyer_blocked",
  /** The compare-and-set changed no row: the transaction rolled back, the record insert with it. */
  "activation_conflict",
] as const;
export type ReconcileRefusal = (typeof RECONCILE_REFUSALS)[number];

export type ReconcileResult =
  /** This call made the scope live. `record` is the record kept for it. */
  | {
      kind: "activated";
      scopeId: string;
      escrowAddress: string;
      activatedAt: string;
      expiresAt: string;
      record: FundingVerificationRecord;
    }
  /** The scope was already live on this escrow's record: nothing was written. */
  | { kind: "already_active"; scopeId: string; escrowAddress: string; expiresAt: string; record: FundingVerificationRecord }
  /** Nothing was written. */
  | { kind: "refused"; reason: ReconcileRefusal }
  /** The pre-activation window ended at `windowEndedAt`; the scope never activates. Nothing was written. */
  | { kind: "expired"; scopeId: string; windowEndedAt: string };

/** Thrown inside the transaction when the compare-and-set changes anything but one row. */
class ActivationConflict extends Error {
  constructor() {
    super("activation_conflict");
    this.name = "ActivationConflict";
  }
}

const refused = (reason: ReconcileRefusal): ReconcileResult => ({ kind: "refused", reason });

/**
 * Whether the policy has a block list (blockedAgents present) that is not an array of strings: a
 * string, null, a number, an object, or an array holding anything but strings. Such a list cannot
 * show the buyer unblocked. acceptanceFor (#591's) reads it as "nobody blocked", and the kernel's
 * policy engine reads a string as blocked (a substring match), so the two would disagree.
 */
function malformedBlockList(policy: unknown): boolean {
  const list = typeof policy === "object" && policy !== null ? (policy as Record<string, unknown>).blockedAgents : undefined;
  return list !== undefined && !(Array.isArray(list) && list.every((id) => typeof id === "string"));
}

/**
 * The kernel's block list, read in the transaction: buyer_blocked, policy_unavailable (also for a
 * block list that is present but malformed), or null.
 */
function blockRefusal(tx: FundingTx, kernelId: string, buyer: string): "buyer_blocked" | "policy_unavailable" | null {
  let policy: unknown;
  try {
    const row = tx.select().from(operatorPolicies).where(eq(operatorPolicies.kernelId, kernelId)).get();
    policy = row ? row.policy : DEFAULT_OPERATOR_POLICY;
  } catch {
    // Defence in depth, unreachable today: emergencyStopState reads this row first (module comment).
    return "policy_unavailable";
  }
  if (malformedBlockList(policy)) return "policy_unavailable";
  return acceptanceFor(policy, buyer) === "refused" ? "buyer_blocked" : null;
}

/**
 * Makes scope `scopeId` live on `record`, its buyer's finalized verification of the escrow that pays
 * for it, or says why not. See the module comment for the guarantees.
 */
export function reconcilePaidScope(scopeId: string, record: FundingVerificationRecord): ReconcileResult {
  const store = fundingRecordStore();
  if (!store) return refused("funding_record_store_unavailable");
  // The binding rule's checks 1 and 2 (funding-binding.ts), before any read; check 3 needs the scope.
  if (!isWellFormedFundingRecord(record)) return refused("record_malformed");
  if (record.scopeId !== scopeId) return refused("record_scope_mismatch");
  try {
    return getStore().db.transaction((tx): ReconcileResult => {
      const now = new Date();
      const scope = tx.select().from(executionScopes).where(eq(executionScopes.id, scopeId)).get();
      if (!scope) return refused("scope_not_found");

      // Bound to this scope: the binding rule (funding-binding.ts), shared with the funding-status DTO.
      const recordRefusal = recordScopeRefusal(record, scope);
      if (recordRefusal !== null) return refused(recordRefusal);

      // The record kept for this scope, if any: a conformant store shows finalized records only
      // (ruling 3). It counts as this funding only when it is this buyer's well-formed record of
      // this scope (the binding rule's checks 1 to 3; that it is finalized and names this scope holds
      // by the store's contract, checked again as defence in depth) and of this record's escrow.
      const kept = store.findByScope(tx, scopeId);
      const keptForThis =
        kept !== null && recordScopeRefusal(kept, scope) === null && sameAddress(kept.escrowAddress, record.escrowAddress)
          ? kept
          : null;

      // (d) Idempotent on (scopeId, escrow), ahead of everything that reads the escrow row: once the
      // scope is live on this escrow's record, a repeat is that activation (already_active), whatever
      // the row says now (it reads completed after settlement). Nothing is written, no TTL moves.
      // Every refusal stays on the path below.
      if (scope.status === "active" && keptForThis) {
        return { kind: "already_active", scopeId, escrowAddress: keptForThis.escrowAddress, expiresAt: scope.expiresAt, record: keptForThis };
      }

      // The job's escrow row: escrowForJob reads through the same connection, so inside this transaction.
      const escrow = escrowForJob(scope.jobId);
      const rowRefusal = escrowRowRefusal(escrow, scope.createdBy);
      if (rowRefusal !== null || !escrow) return refused(rowRefusal ?? "escrow_missing");
      const escrowRefusal = recordEscrowRefusal(record, escrow);
      if (escrowRefusal !== null) return refused(escrowRefusal);

      // One funding, one scope. The store sees the escrow address folded (escrowKey), for the lookup
      // and the insert, so a store that matches letter case exactly cannot bind it twice.
      const toKeep: FundingVerificationRecord = { ...record, escrowAddress: escrowKey(record.escrowAddress) };
      const forEscrow = store.findByEscrow(tx, toKeep.escrowAddress);
      if (forEscrow && forEscrow.scopeId !== scopeId) return refused("escrow_bound_to_other_scope");
      if (kept && !keptForThis) return refused("scope_bound_to_other_funding");

      // Live, and not on this escrow's record (a mock-escrow or pre-N133 activation): kept is null
      // here, since a kept record is either this funding (answered above) or refused just above.
      if (scope.status === "active") return refused("scope_active_other_funding");

      // (a) What allows the activation, re-read now.
      if (scope.status === "revoked") return refused("scope_revoked");
      if (scope.status !== SCOPE_AWAITING_FUNDING) return refused("scope_not_awaiting_funding");
      // The window, read fail-closed as the accept route reads it: an unreadable expiresAt is long
      // past (scopeExpiryMs), so it counts as lapsed.
      if (scopeExpiryMs(scope.expiresAt) <= now.getTime()) return { kind: "expired", scopeId, windowEndedAt: scope.expiresAt };
      const stop = emergencyStopState(scope.kernelId);
      if (stop === "stopped") return refused("kernel_emergency_stopped");
      if (stop !== "clear") return refused("policy_unavailable");
      const blocked = blockRefusal(tx, scope.kernelId, scope.createdBy);
      if (blocked !== null) return refused(blocked);

      // (b) The record, in this transaction.
      if (!kept) store.insert(tx, toKeep);

      // (c) The compare-and-set, from the exact row read above; the TTL starts now.
      const expiresAt = new Date(now.getTime() + PAID_SCOPE_TTL_MS).toISOString();
      const { changes } = tx
        .update(executionScopes)
        .set({ status: "active", expiresAt })
        .where(
          and(
            eq(executionScopes.id, scopeId),
            eq(executionScopes.status, SCOPE_AWAITING_FUNDING),
            eq(executionScopes.expiresAt, scope.expiresAt),
          ),
        )
        .run();
      if (changes !== 1) throw new ActivationConflict();
      const activation = kept ?? toKeep;
      return { kind: "activated", scopeId, escrowAddress: activation.escrowAddress, activatedAt: now.toISOString(), expiresAt, record: activation };
    }, { behavior: "immediate" });
  } catch (err) {
    if (err instanceof ActivationConflict) return refused("activation_conflict");
    throw err;
  }
}

/**
 * The accept route's `activation`: a reconcile outcome without its record, which carries the
 * buyer's wallet, the block hash and the verifier's build (fund-s2 review NIT-2). An activation is
 * {kind, activatedAt, expiresAt, escrowAddress}; the other outcomes carry what they need to be read.
 */
export type ReconcileAnswer =
  | { kind: "activated"; activatedAt: string; expiresAt: string; escrowAddress: string }
  | { kind: "already_active"; expiresAt: string; escrowAddress: string }
  | { kind: "refused"; reason: ReconcileRefusal }
  | { kind: "expired"; windowEndedAt: string };

export function reconcileAnswer(result: ReconcileResult): ReconcileAnswer {
  switch (result.kind) {
    case "activated":
      return { kind: "activated", activatedAt: result.activatedAt, expiresAt: result.expiresAt, escrowAddress: result.escrowAddress };
    case "already_active":
      return { kind: "already_active", expiresAt: result.expiresAt, escrowAddress: result.escrowAddress };
    case "refused":
      return { kind: "refused", reason: result.reason };
    case "expired":
      return { kind: "expired", windowEndedAt: result.windowEndedAt };
  }
}

/** The accept route's `fundingRefusal` for a reconcile outcome: null when the scope is live. */
export function reconcileFundingRefusal(result: ReconcileResult): ReconcileRefusal | "scope_expired" | null {
  switch (result.kind) {
    case "activated":
    case "already_active":
      return null;
    case "expired":
      return "scope_expired";
    case "refused":
      return result.reason;
  }
}
