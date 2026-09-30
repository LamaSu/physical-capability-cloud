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
 * ONE TRANSACTION PER MILESTONE, so an escrow with several milestones is not atomic on-chain. Two cases leave some
 * milestones Refunded and the rest not, and the outcome is then `incomplete`, naming what was sent and where it
 * stopped:
 *   - a third party attests a remaining milestone between the read and a send (the contract makes that race safe
 *     either way);
 *   - a transaction is dropped.
 * A retry finishes the rest, or refuses it with the reason.
 * The whole sequence runs under the signer lock, so the gateway's own writes cannot interleave with it.
 */
import type { Address, Hex } from "viem";
import {
  getReclaimStateV3,
  getSignerAddress,
  isWriteEnabled,
  reclaimAfterDeadlineV3,
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
      stoppedAt: { index: number; transactionHash: string; receipt: "reverted" | "timeout" };
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
      const { transactionHash } = await reclaimAfterDeadlineV3(index, escrow);
      const receipt = await waitForReceipt(transactionHash as Hex);
      if (receipt.status !== "success") {
        return { outcome: "incomplete", escrow, reclaimed, stoppedAt: { index, transactionHash, receipt: receipt.status } };
      }
      reclaimed.push({ index, transactionHash });
    }
    return { outcome: "reclaimed", escrow, reclaimed, alreadyRefunded: plan.alreadyRefunded };
  });
}
