/**
 * @pcc/cypher-lims-bridge — LimsPoller
 *
 * Polls Cypher's `/api/lims/requests` endpoint at a configurable cadence and
 * emits a `request-discovered` event for each request that wasn't seen on a
 * prior tick. State is held in memory only — operator restarts re-process the
 * full backlog.
 *
 * Errors are logged via the `error` event but do NOT crash the poller. This
 * matters for long-running operator daemons where a transient Cypher 5xx
 * shouldn't drop the watcher.
 */

import { EventEmitter } from 'node:events';

import type { CypherClient } from './client.js';
import { CypherApiError } from './client.js';
import type { CypherLimsRequest } from './types.js';

export interface LimsPollerOptions {
  client: CypherClient;
  /** Polling interval in milliseconds. Minimum 1000. Default 30000. */
  intervalMs?: number;
  /** Filter requests by Cypher's workType field (e.g. 'plasmid_prep'). */
  workType?: string;
  /** Page size per tick. Default 50. */
  limit?: number;
}

export interface LimsPollerEvents {
  'request-discovered': (req: CypherLimsRequest) => void;
  /** Emitted on every poll tick that returned successfully. */
  poll: (info: { count: number; durationMs: number }) => void;
  error: (err: Error) => void;
  start: () => void;
  stop: () => void;
}

export declare interface LimsPoller {
  on<E extends keyof LimsPollerEvents>(event: E, listener: LimsPollerEvents[E]): this;
  once<E extends keyof LimsPollerEvents>(event: E, listener: LimsPollerEvents[E]): this;
  off<E extends keyof LimsPollerEvents>(event: E, listener: LimsPollerEvents[E]): this;
  emit<E extends keyof LimsPollerEvents>(event: E, ...args: Parameters<LimsPollerEvents[E]>): boolean;
}

const MIN_INTERVAL_MS = 1000;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_LIMIT = 50;

export class LimsPoller extends EventEmitter {
  private readonly client: CypherClient;
  private readonly intervalMs: number;
  private readonly workType: string | undefined;
  private readonly limit: number;
  private readonly seen: Set<string> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private running = false;

  constructor(opts: LimsPollerOptions) {
    super();
    this.client = opts.client;
    const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (interval < MIN_INTERVAL_MS) {
      throw new Error(
        `LimsPoller: intervalMs must be >= ${MIN_INTERVAL_MS} (got ${interval})`,
      );
    }
    this.intervalMs = interval;
    this.workType = opts.workType;
    this.limit = opts.limit ?? DEFAULT_LIMIT;
  }

  /** True iff start() was called and stop() has not been called since. */
  isRunning(): boolean {
    return this.running;
  }

  /** Number of unique request IDs seen across the lifetime of this poller. */
  seenCount(): number {
    return this.seen.size;
  }

  /**
   * Start polling. Performs an immediate first tick (no setInterval delay),
   * then continues every `intervalMs`. Calling start() while already running
   * is a no-op.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.emit('start');
    // Fire-and-forget the first tick so listeners get fast feedback.
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Don't keep the Node event loop alive solely on this timer.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Stop polling. Idempotent — safe to call multiple times. Does NOT clear the
   * `seen` set; restarting a stopped poller will skip already-seen requests.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit('stop');
  }

  /** Force a poll tick now. Useful for tests and operator-triggered refresh. */
  async pollNow(): Promise<void> {
    return this.tick();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------
  private async tick(): Promise<void> {
    // Skip if previous tick is still running (slow Cypher response). Otherwise
    // we'd queue ticks indefinitely under sustained latency.
    if (this.inFlight) return;
    this.inFlight = true;
    const startedAt = Date.now();
    try {
      const res = await this.client.listLimsRequests({
        limit: this.limit,
        workType: this.workType,
      });
      const requests = Array.isArray(res.data) ? res.data : [];
      let newCount = 0;
      for (const req of requests) {
        const id = req._id ?? req.requestNumber;
        if (!id) continue;
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        newCount += 1;
        this.emit('request-discovered', req);
      }
      this.emit('poll', { count: newCount, durationMs: Date.now() - startedAt });
    } catch (err) {
      const wrapped = err instanceof Error
        ? err
        : new CypherApiError('lims_poll_unknown_error', { status: null, path: '/api/lims/requests', body: err });
      this.emit('error', wrapped);
    } finally {
      this.inFlight = false;
    }
  }
}
