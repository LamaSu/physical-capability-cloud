/**
 * The values a gateway row may hold, for the row guards in
 * hooks/use-pcc-data.ts (astra 18b F1 and F3). A row with a value outside
 * these makes its whole read unavailable: a page can only count and classify
 * what it recognises, and "bogus" counted as an inactive job is a guess.
 *
 * Each set is what the gateway can actually return, which is wider than what
 * it advertises. Rejecting a value the gateway really writes would turn a
 * working page into an outage, so every entry names where it comes from.
 */

/**
 * GET /api/jobs passes the stored status through (facades/populators/job.populator.ts).
 * - Advertised (config/job-status.ts JOB_STATUSES): pending, queued,
 *   in_progress, paused, completed, failed, cancelled.
 * - Also written, outside that list: executing (services/kernel-service.ts);
 *   evidence_stored, evidence_submitted and settled (services/settlement-service.ts,
 *   routes/paid-job-flow.ts); active (paid-job-flow.ts, a job created under
 *   mock settlement).
 * - Named by the jobs table (db/schema/jobs.ts): preparing,
 *   collecting_evidence, awaiting_pickup.
 * - Read by the job populator: disputed.
 */
export const KNOWN_JOB_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "queued",
  "in_progress",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "executing",
  "evidence_stored",
  "evidence_submitted",
  "settled",
  "active",
  "preparing",
  "collecting_evidence",
  "awaiting_pickup",
  "disputed",
]);

/**
 * GET /api/kernels passes the stored status through (kernel.populator.ts).
 * The kernels table and @pcc/spec name online, offline, maintenance and
 * suspended; services/kernel-ttl-sweeper.ts also writes expired.
 */
export const KNOWN_KERNEL_STATUSES: ReadonlySet<string> = new Set(["online", "offline", "maintenance", "suspended", "expired"]);

/**
 * GET /api/escrow passes the stored status through (settlement.populator.ts).
 * - The escrows table and @pcc/spec's escrow schema name: created, funded,
 *   active, completing, completed, disputed, refunded.
 * - The dashboard's EscrowStatus type (types/dto.ts), which the money badges
 *   classify, also names: pending, released, expired.
 * - Escrow's #462 (N79) adds refund_pending: a chain escrow whose refund is
 *   decided but not yet executed on-chain. It is written to the escrows table
 *   and named in both @pcc/spec vocabularies and the money map (escrow #4544).
 */
export const KNOWN_ESCROW_STATUSES: ReadonlySet<string> = new Set([
  "created",
  "funded",
  "active",
  "completing",
  "completed",
  "disputed",
  "refunded",
  "pending",
  "released",
  "expired",
  "refund_pending",
]);

/** An escrow's currency: the escrows table allows USDC, ETH and DAI (db/schema/settlement.ts). */
export const ESCROW_CURRENCIES: ReadonlySet<string> = new Set(["USDC", "ETH", "DAI"]);

/**
 * A money amount as the gateway stores it: a plain non-negative decimal
 * string, such as "10", "1500.50" or "0.004". No sign, exponent, grouping
 * or leading zeros, so it can be shown digit for digit, never through a float.
 */
const AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function isCanonicalAmount(v: unknown): v is string {
  return typeof v === "string" && AMOUNT.test(v);
}

/** A count: a non-negative safe integer. */
export function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** A finite number in [min, max]. */
export function isInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}
