/**
 * Background sweeper for job-offers. Runs every 60s in production.
 *
 * Each tick calls store.sweep(), which handles:
 *   • TTL expiry (validUntil past)
 *   • Heartbeat-loss expiry (when requireHeartbeat=true and >5min gap)
 *   • Periodic re-verify against sourceVerifyUrl
 *
 * The sweep itself lives on JobOffersStore so tests can call it
 * deterministically without waiting on the timer.
 *
 * Pattern mirrors startDemandSnapshotCron (admin-demand.ts):
 *   - module-level state with idempotent start
 *   - timer.unref() so tests don't keep the event loop alive
 *   - explicit stop for test cleanup
 */

import { getJobOffersStore } from "./job-offers-store.js";

interface SweeperState {
  timer: NodeJS.Timeout | null;
}

const state: SweeperState = { timer: null };

const SWEEP_INTERVAL_MS = 60 * 1000;

async function runSweep(
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  try {
    const store = getJobOffersStore();
    const result = await store.sweep();
    if (result.expired || result.reverified || result.autoCancelled) {
      logger?.info?.(
        `[job-offers] sweep: expired=${result.expired} reverified=${result.reverified} autoCancelled=${result.autoCancelled}`,
      );
    }
  } catch (err) {
    logger?.warn?.(
      `[job-offers] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Start the job-offers background sweeper.
 *
 * Idempotent: a second call is a no-op.
 */
export function startJobOffersSweeper(
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  if (state.timer) return;
  state.timer = setInterval(() => {
    void runSweep(logger);
  }, SWEEP_INTERVAL_MS);
  state.timer.unref?.();
  logger?.info?.("[job-offers] sweeper started (every 60s)");
}

/** Stop the sweeper. Idempotent. */
export function stopJobOffersSweeper(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}
