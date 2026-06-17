/**
 * Kernel staleness rule — single source of truth shared by the kernel and
 * capability populators.
 *
 * Background: an "online" kernel whose heartbeat is older than a threshold is
 * flagged stale, and its listings drop to `available: false`. The bare 5-minute
 * threshold is too aggressive for low-traffic operators who do not run a
 * heartbeat daemon — an operator who onboards and lists a capability silently
 * disappears from buyer-facing results five minutes later.
 *
 * Fix: a kernel that has an active listing (≥1 capability) is "open for
 * business" and gets a much wider keepalive grace before being considered
 * stale. This lets a listed operator stay available without periodic
 * heartbeats (server-side, no operator daemon required). The grace is finite,
 * so a genuinely dead kernel is still flagged eventually. Kernels with no
 * active listing keep the bare 5-minute threshold.
 */

/** Base staleness threshold for an online kernel with no active listing — 5 minutes. */
export const STALE_HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Keepalive grace for an online kernel that has at least one active listing.
 * 24 hours — generous enough that a low-traffic operator stays discoverable
 * between infrequent heartbeats, finite so a long-dead kernel is still flagged.
 */
export const ACTIVE_LISTING_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an online kernel's heartbeat is stale.
 *
 * Only "online" kernels can be stale — offline/maintenance/suspended carry
 * their own status and are never reported stale. A kernel with an active
 * listing uses the wider keepalive grace; otherwise the bare 5-minute
 * threshold applies. A missing heartbeat is treated as infinitely old.
 *
 * @param status            kernel.status
 * @param lastHeartbeat     ISO timestamp of the last heartbeat (null/undefined → infinitely old)
 * @param hasActiveListing  true if the kernel exposes ≥1 capability (an active listing)
 * @param now               current epoch ms (injectable for deterministic tests)
 */
export function isKernelStale(
  status: string | undefined,
  lastHeartbeat: string | null | undefined,
  hasActiveListing: boolean,
  now: number = Date.now(),
): boolean {
  if (status !== "online") return false;
  const heartbeatAge = lastHeartbeat
    ? now - new Date(lastHeartbeat).getTime()
    : Infinity;
  const threshold = hasActiveListing ? ACTIVE_LISTING_GRACE_MS : STALE_HEARTBEAT_MS;
  return heartbeatAge > threshold;
}
