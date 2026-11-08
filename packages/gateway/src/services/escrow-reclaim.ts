/**
 * N79: the on-chain half of giving back a V3 escrow, the deadline reclaim. A PRIMITIVE: nothing in the gateway calls
 * it yet. The route that may call it is gateway's (owner-or-admin like /complete, counted by the N46 spend guard) and
 * waits on #326 and #453; running it against a real chain is the operator's call. It writes no database row: the
 * caller records the outcome.
 *
 * MilestoneEscrowV3.reclaimAfterDeadline(idx) returns one milestone's amount to the payer. It is payer-only, allowed
 * only from Funded, Locked or Evidenced, and only once block.timestamp >= fundedAt + the reclaim window. An Attested
 * milestone (the operator holds an oracle verdict in its challenge window) can never be clawed back this way: that is
 * the dispute path's. V2 escrows have no such exit (their only refund is resolveDispute), so this is V3 only.
 *
 * ALL OR NOTHING. It sends nothing unless EVERY milestone is either Refunded already or reclaimable now:
 *   - the escrow is funded, and the gateway signer is its payer;
 *   - no milestone is in any other state (Unfunded, Attested, Released, Disputed, Slashed);
 *   - the deadline has passed (fundedAt + the window, at the block the state was read at).
 * Otherwise it refuses and says why (with `dueAt` when it is only early).
 *
 * IDEMPOTENT. A milestone already Refunded is skipped, so a repeat sends only what is left. With nothing left, the
 * outcome is `already_refunded`.
 *
 * ONE TRANSACTION PER MILESTONE, so an escrow with several milestones is not atomic on-chain. When a sequence stops
 * part-way, the outcome is `incomplete`: it names every reclaim that went through and exactly where and why it stopped
 * (astra, #472 F1; #477 round 2). It never throws away that record, not even when the error cannot be printed. Each
 * reclaim is SIGNED locally first, so its hash is known before anything leaves this process. Where it stopped, `receipt`
 * says:
 *   - `not_sent`: preparing or signing failed. Nothing left this process for that milestone (proven).
 *   - `unknown`: the broadcast failed, or the receipt could not be read. The node may have taken the transaction
 *     (a lost response is not proof of absence), so look up the returned `transactionHash`: it may still mine.
 *   - `timeout`: sent, but not confirmed within the wait. It may still mine.
 *   - `reverted`: the transaction executed and reverted. For example, a third party attested that milestone between
 *     the read and the send; the contract makes that race safe either way.
 * A retry finishes the rest, or refuses it with the reason. Refunded milestones are skipped, so a retry never pays a
 * principal twice.
 * The whole sequence runs under the signer lock, so the gateway's own writes cannot interleave with it.
 */
import type { Address, Hex } from "viem";
import {
  broadcastSignedTransaction,
  getReclaimStateV3,
  getSignerAddress,
  isWriteEnabled,
  signReclaimAfterDeadlineV3,
  waitForReceipt,
  type ReclaimStateV3,
} from "../contracts/escrow-client.js";
import { withSignerLock } from "../contracts/signer-lock.js";

/** MilestoneEscrowV3.MilestoneStatus. */
export const V3_MILESTONE_STATUS = {
  Unfunded: 0,
  Funded: 1,
  Locked: 2,
  Evidenced: 3,
  Attested: 4,
  Released: 5,
  Disputed: 6,
  Refunded: 7,
  Slashed: 8,
} as const;

/** The states reclaimAfterDeadline accepts. */
const RECLAIMABLE: ReadonlySet<number> = new Set([
  V3_MILESTONE_STATUS.Funded,
  V3_MILESTONE_STATUS.Locked,
  V3_MILESTONE_STATUS.Evidenced,
]);

export type ReclaimRefusalV3 =
  | { reason: "not_funded" }
  | { reason: "not_payer"; payer: Address }
  | { reason: "no_milestones" }
  | { reason: "not_reclaimable"; milestones: Array<{ index: number; status: number }> }
  | { reason: "not_due"; dueAt: bigint; blockTimestamp: bigint };

export type ReclaimPlanV3 =
  | { action: "send"; toReclaim: number[]; alreadyRefunded: number[]; dueAt: bigint }
  | { action: "done"; alreadyRefunded: number[] }
  | ({ action: "refuse" } & ReclaimRefusalV3);

/** Decide the reclaim from one read of the escrow's state. Pure: it sends nothing. */
export function planReclaimV3(state: ReclaimStateV3, signer: Address): ReclaimPlanV3 {
  if (!state.funded) return { action: "refuse", reason: "not_funded" };
  if (state.payer.toLowerCase() !== signer.toLowerCase()) {
    return { action: "refuse", reason: "not_payer", payer: state.payer };
  }
  if (state.milestones.length === 0) return { action: "refuse", reason: "no_milestones" };

  const blocking = state.milestones.filter(
    (m) => m.status !== V3_MILESTONE_STATUS.Refunded && !RECLAIMABLE.has(m.status),
  );
  if (blocking.length > 0) {
    return {
      action: "refuse",
      reason: "not_reclaimable",
      milestones: blocking.map(({ index, status }) => ({ index, status })),
    };
  }

  const alreadyRefunded = state.milestones.filter((m) => m.status === V3_MILESTONE_STATUS.Refunded).map((m) => m.index);
  const toReclaim = state.milestones.filter((m) => RECLAIMABLE.has(m.status)).map((m) => m.index);
  if (toReclaim.length === 0) return { action: "done", alreadyRefunded };

  const dueAt = state.fundedAt + state.windowSeconds;
  if (state.blockTimestamp < dueAt) {
    return { action: "refuse", reason: "not_due", dueAt, blockTimestamp: state.blockTimestamp };
  }
  return { action: "send", toReclaim, alreadyRefunded, dueAt };
}

export type ReclaimOutcomeV3 =
  | { outcome: "reclaimed"; escrow: Address; reclaimed: Array<{ index: number; transactionHash: string }>; alreadyRefunded: number[] }
  | { outcome: "already_refunded"; escrow: Address; alreadyRefunded: number[] }
  | ({ outcome: "refused"; escrow: Address } & (ReclaimRefusalV3 | { reason: "write_disabled" }))
  | {
      outcome: "incomplete";
      escrow: Address;
      reclaimed: Array<{ index: number; transactionHash: string }>;
      stoppedAt: {
        index: number;
        /** Absent only when signing itself failed, before broadcast (`not_sent`). Present whenever a
         *  transaction was actually signed, including after a broadcast failure (`unknown`) — the hash is
         *  known locally before the broadcast attempt, so it is never lost by that attempt failing. */
        transactionHash?: string;
        receipt: "not_sent" | "reverted" | "timeout" | "unknown";
        error?: string;
      };
    };

/** A one-line description of any thrown value. It never throws itself: a value that cannot be printed gets a fixed text. */
const messageOf = (e: unknown): string => {
  try {
    if (e instanceof Error) return e.message.split("\n")[0] ?? e.message;
    return String(e);
  } catch {
    return "unprintable error";
  }
};

/**
 * Reclaim every milestone of a V3 escrow whose deadline has passed, from the gateway signer (the payer), all or
 * nothing. See the module comment for the rules. Nothing calls this yet.
 */
export async function reclaimEscrowV3(escrow: Address): Promise<ReclaimOutcomeV3> {
  const signer = isWriteEnabled() ? getSignerAddress() : undefined;
  if (!signer) return { outcome: "refused", escrow, reason: "write_disabled" };

  return withSignerLock(async () => {
    const plan = planReclaimV3(await getReclaimStateV3(escrow), signer);
    if (plan.action === "done") return { outcome: "already_refunded", escrow, alreadyRefunded: plan.alreadyRefunded };
    if (plan.action === "refuse") {
      const { action: _action, ...refusal } = plan;
      return { outcome: "refused", escrow, ...refusal };
    }

    const reclaimed: Array<{ index: number; transactionHash: string }> = [];
    for (const index of plan.toReclaim) {
      let signed: Awaited<ReturnType<typeof signReclaimAfterDeadlineV3>>;
      try {
        signed = await signReclaimAfterDeadlineV3(index, escrow);
      } catch (e) {
        // Preparing or signing failed: nothing left this process for this milestone.
        return { outcome: "incomplete", escrow, reclaimed, stoppedAt: { index, receipt: "not_sent", error: messageOf(e) } };
      }
      const transactionHash: string = signed.transactionHash;
      try {
        await broadcastSignedTransaction(signed.serializedTransaction);
      } catch (e) {
        // The node may have taken it even though the response was lost: indeterminate, with the hash to look up.
        return {
          outcome: "incomplete",
          escrow,
          reclaimed,
          stoppedAt: { index, transactionHash, receipt: "unknown", error: messageOf(e) },
        };
      }
      let receipt: Awaited<ReturnType<typeof waitForReceipt>>;
      try {
        receipt = await waitForReceipt(transactionHash as Hex);
      } catch (e) {
        return {
          outcome: "incomplete",
          escrow,
          reclaimed,
          stoppedAt: { index, transactionHash, receipt: "unknown", error: messageOf(e) },
        };
      }
      if (receipt.status !== "success") {
        return { outcome: "incomplete", escrow, reclaimed, stoppedAt: { index, transactionHash, receipt: receipt.status } };
      }
      reclaimed.push({ index, transactionHash });
    }
    return { outcome: "reclaimed", escrow, reclaimed, alreadyRefunded: plan.alreadyRefunded };
  });
}
