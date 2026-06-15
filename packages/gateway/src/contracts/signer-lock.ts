/**
 * Global signer-serialization lock for the gateway's single hot key.
 *
 * P2 (board #126): every on-chain write — createEscrowV2, addMilestone, fund,
 * approve, submitAttestationV2, release, ... — is signed by ONE hot key. Under
 * concurrent requests, each caller reads eth_getTransactionCount("pending") at
 * the SAME value and assigns colliding nonces, so the loser's tx is dropped or
 * replaced and the gateway returns `fast_track_failed`. P0-1's explicit nonce
 * fixed the WITHIN-job ordering (createEscrowV2 -> addMilestone); this serializes
 * signer tx SEQUENCES ACROSS concurrent jobs so two callers can never hold the
 * same nonce window at once.
 *
 * Strategy: an in-process promise-chain mutex. Each signer tx-sequence runs only
 * after the previous one SETTLES — success OR failure (a failure must never wedge
 * the queue). One sequence in flight at a time per process. This trades signer
 * throughput for correctness; at the current single-instance load that is the
 * right trade, and it lets each sequence's explicit/auto nonce resolve against a
 * quiescent chain state.
 *
 * LIMIT: single-process only. If the gateway is ever horizontally scaled with
 * multiple instances sharing ONE signer, this needs an external lock
 * (DB / redis / on-chain mutex). Tracked as the multi-instance follow-up.
 */

let chain: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` with exclusive access to the gateway signer. Concurrent calls queue
 * and execute strictly one-at-a-time, in call order.
 *
 * The queue is failure-isolated: if `fn` rejects, the rejection is re-thrown to
 * THIS caller, but the internal chain advances via a swallowed continuation so
 * the next waiter still runs (a single failed tx-sequence never deadlocks the
 * signer).
 *
 * Usage — wrap a whole tx SEQUENCE (not each individual tx) so a job's nonces
 * stay contiguous and no other job's tx interleaves into the window:
 *
 *   const escrow = await withSignerLock(async () => {
 *     const tx1 = await wallet.writeContract({ ...createEscrowV2 });
 *     await publicClient.waitForTransactionReceipt({ hash: tx1 });
 *     const tx2 = await wallet.writeContract({ ...addMilestone });
 *     await publicClient.waitForTransactionReceipt({ hash: tx2 });
 *     return addr;
 *   });
 */
export function withSignerLock<T>(fn: () => Promise<T>): Promise<T> {
  // Schedule fn to run once the previous holder settles, regardless of its
  // outcome (both handlers are fn, so a prior rejection still releases the lock).
  const result = chain.then(fn, fn);
  // Advance the internal chain on the SETTLED result, swallowing the outcome so
  // a rejection here cannot poison the queue for the next waiter.
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Test-only: reset the internal queue to a resolved promise. Lets unit tests
 * start from a clean lock between cases. No-op effect on production behavior.
 */
export function __resetSignerLockForTests(): void {
  chain = Promise.resolve();
}
