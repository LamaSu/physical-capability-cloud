/**
 * Background sweeper for courier-jobs.
 *
 * DEPRECATED in favor of services/job-offers-sweeper.ts. The generic sweeper
 * covers ALL capability types (courier.dispatch, pizza.order, lab.hplc,
 * opentrons.runProtocol, ...) by sweeping the unified JobOffersStore. This
 * file remains as a thin alias so external imports stay source-compatible
 * during the cutover window. Internally we delegate to the generic sweeper.
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
        `[courier-jobs/shim] sweep via generic store: expired=${result.expired} reverified=${result.reverified} autoCancelled=${result.autoCancelled}`,
      );
    }
  } catch (err) {
    logger?.warn?.(
      `[courier-jobs/shim] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Start the courier-jobs background sweeper.
 *
 * Idempotent: a second call is a no-op.
 */
export function startCourierJobsSweeper(
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  if (state.timer) return;
  state.timer = setInterval(() => {
    void runSweep(logger);
  }, SWEEP_INTERVAL_MS);
  state.timer.unref?.();
  logger?.info?.("[courier-jobs] sweeper started (every 60s)");
}

/** Stop the sweeper. Idempotent. */
export function stopCourierJobsSweeper(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}
