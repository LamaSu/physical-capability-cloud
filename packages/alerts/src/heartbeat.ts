/**
 * Worker heartbeat tracker.
 *
 * Maintains a Map<worker, lastSeen>. A sweep runs every `sweepIntervalMs`
 * and fires a `critical` alert for any configured worker whose last
 * heartbeat is older than its `maxSilenceMs` grace window. Alerts only
 * fire on the transition from "fresh" to "stale" — no spam every sweep.
 *
 * Author: implementer-alpha
 */

import type { Alert } from "./types.js";
import type { HeartbeatConfig } from "./config.js";

export interface HeartbeatHandle {
  /** Call when a worker heartbeat arrives (e.g. from POST /heartbeat/:worker). */
  record: (worker: string, at?: number) => void;
  /** Snapshot of current worker ages for /health. */
  snapshot: () => Array<{ worker: string; lastSeen: number | null; ageMs: number | null }>;
  /** Exposed for tests. */
  _sweep: () => Promise<void>;
  stop: () => void;
}

export interface StartHeartbeatOptions {
  configs: HeartbeatConfig[];
  onAlert: (alert: Alert) => void | Promise<void>;
  /** Defaults to 60_000. */
  sweepIntervalMs?: number;
  /** Injected for deterministic tests. */
  nowMs?: () => number;
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

export function startHeartbeat(opts: StartHeartbeatOptions): HeartbeatHandle {
  const sweepEveryMs = opts.sweepIntervalMs ?? 60_000;
  const now = opts.nowMs ?? Date.now;
  const scheduler = opts.scheduler ?? {
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };

  // Map of worker -> last-seen epoch ms.
  const lastSeen = new Map<string, number>();
  // Which configured workers are currently considered stale (alert-fired).
  const stale = new Set<string>();
  const knownConfigs = new Map(opts.configs.map((c) => [c.worker, c]));

  function record(worker: string, at?: number): void {
    const ts = at ?? now();
    lastSeen.set(worker, ts);
    // Auto-clear stale flag — a recovery heartbeat means we're healthy again.
    if (stale.has(worker)) {
      stale.delete(worker);
      const cfg = knownConfigs.get(worker);
      if (cfg) {
        void opts.onAlert({
          ts: new Date(ts).toISOString(),
          source: "heartbeat",
          severity: "info",
          title: `worker "${worker}" recovered`,
          body: `Heartbeat received after prior staleness. Grace: ${cfg.maxSilenceMs}ms.`,
          context: { worker, maxSilenceMs: cfg.maxSilenceMs },
        });
      }
    }
  }

  async function sweep(): Promise<void> {
    const nowTs = now();
    for (const [worker, cfg] of knownConfigs) {
      const seen = lastSeen.get(worker);
      if (seen === undefined) {
        // Never seen this worker. Treat as stale after sweep so that a fresh
        // deploy of the alerter doesn't instantly page for workers that
        // haven't had a chance to post yet — we defer one grace window
        // worth from process start is out of scope; just fire once on first
        // sweep to make "never-announced" visible.
        if (!stale.has(worker)) {
          stale.add(worker);
          await opts.onAlert({
            ts: new Date(nowTs).toISOString(),
            source: "heartbeat",
            severity: "critical",
            title: `worker "${worker}" has never heartbeat`,
            body: `No heartbeat seen for configured worker "${worker}". Expected interval < ${cfg.maxSilenceMs}ms.`,
            context: { worker, maxSilenceMs: cfg.maxSilenceMs, lastSeen: null },
          });
        }
        continue;
      }
      const age = nowTs - seen;
      if (age > cfg.maxSilenceMs) {
        if (!stale.has(worker)) {
          stale.add(worker);
          await opts.onAlert({
            ts: new Date(nowTs).toISOString(),
            source: "heartbeat",
            severity: "critical",
            title: `worker "${worker}" silent`,
            body: `No heartbeat for ${age}ms (grace ${cfg.maxSilenceMs}ms).`,
            context: { worker, ageMs: age, maxSilenceMs: cfg.maxSilenceMs, lastSeen: seen },
          });
        }
      }
    }
  }

  const handle = scheduler.setInterval(() => {
    sweep().catch(() => {
      // sweep already emits alerts; swallow programmer errors.
    });
  }, sweepEveryMs);

  return {
    record,
    snapshot(): Array<{ worker: string; lastSeen: number | null; ageMs: number | null }> {
      const nowTs = now();
      return opts.configs.map((cfg) => {
        const seen = lastSeen.get(cfg.worker);
        return {
          worker: cfg.worker,
          lastSeen: seen ?? null,
          ageMs: seen === undefined ? null : nowTs - seen,
        };
      });
    },
    _sweep: sweep,
    stop(): void {
      scheduler.clearInterval(handle);
    },
  };
}
