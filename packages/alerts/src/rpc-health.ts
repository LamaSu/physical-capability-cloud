/**
 * RPC health prober.
 *
 * Periodically calls getBlockNumber() against an RPC endpoint and tracks
 * rolling p50/p95 latency. Fires:
 *   - `critical` on any outright probe failure (throw / non-number response)
 *   - `warning` when p95 crosses `p95WarnMs` across `consecutiveWindows`
 *     rolling windows of `windowSize` samples
 *
 * Rationale for the windowed threshold: a single slow probe is meaningless
 * (network jitter), but a sustained p95 regression indicates the RPC is
 * actually degraded. This mirrors the Alertmanager "for: 1m" pattern without
 * the Prometheus dependency.
 *
 * Author: implementer-alpha
 */

import type { Alert, Severity } from "./types.js";
import type { RpcProbeConfig } from "./config.js";

export interface BlockNumberProvider {
  getBlockNumber: () => Promise<bigint | number>;
}
export type BlockNumberProviderFactory = (config: RpcProbeConfig) => BlockNumberProvider;

export interface RpcHealthHandle {
  stop: () => void;
  /** Exposed for tests. */
  _tick: () => Promise<void>;
}

export interface StartRpcHealthOptions {
  config: RpcProbeConfig;
  providerFactory: BlockNumberProviderFactory;
  onAlert: (alert: Alert) => void | Promise<void>;
  /** Injected for deterministic tests. Defaults to setInterval/clearInterval. */
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  /** Injected for deterministic tests. Defaults to performance.now. */
  nowMs?: () => number;
}

/** Compute a quantile from an array of numbers. Returns 0 if empty. */
export function quantile(samples: number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lo = sorted[base] ?? 0;
  const hi = sorted[base + 1] ?? lo;
  return lo + (hi - lo) * rest;
}

export function startRpcHealth(opts: StartRpcHealthOptions): RpcHealthHandle {
  const provider = opts.providerFactory(opts.config);
  const scheduler = opts.scheduler ?? {
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  const now = opts.nowMs ?? (() => performance.now());

  const window: number[] = [];
  let consecutiveBreaches = 0;
  let warningActive = false;

  async function tick(): Promise<void> {
    const started = now();
    try {
      const result = await provider.getBlockNumber();
      if (typeof result !== "bigint" && typeof result !== "number") {
        throw new Error(`unexpected block number type: ${typeof result}`);
      }
      const elapsed = now() - started;
      window.push(elapsed);
      if (window.length > opts.config.windowSize) window.shift();

      if (window.length >= opts.config.windowSize) {
        const p95 = quantile(window, 0.95);
        if (p95 > opts.config.p95WarnMs) {
          consecutiveBreaches++;
          if (consecutiveBreaches >= opts.config.consecutiveWindows && !warningActive) {
            warningActive = true;
            await emit("warning", `${opts.config.label} RPC p95 degraded`, {
              chain: opts.config.chain,
              rpcUrl: opts.config.rpcUrl,
              p50: quantile(window, 0.5),
              p95,
              threshold: opts.config.p95WarnMs,
              consecutiveBreaches,
            });
          }
        } else {
          if (warningActive) {
            warningActive = false;
            await emit("info", `${opts.config.label} RPC latency recovered`, {
              chain: opts.config.chain,
              rpcUrl: opts.config.rpcUrl,
              p50: quantile(window, 0.5),
              p95,
              threshold: opts.config.p95WarnMs,
            });
          }
          consecutiveBreaches = 0;
        }
      }
    } catch (err) {
      await emit("critical", `${opts.config.label} RPC probe failed`, {
        chain: opts.config.chain,
        rpcUrl: opts.config.rpcUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function emit(
    severity: Severity,
    title: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const alert: Alert = {
      ts: new Date().toISOString(),
      source: "rpc-health",
      severity,
      title,
      body: formatBody(title, context),
      context,
    };
    await opts.onAlert(alert);
  }

  const handle = scheduler.setInterval(() => {
    tick().catch(() => {
      // tick() already self-handles errors via emit(). This catch is defense
      // against programmer error.
    });
  }, opts.config.intervalMs);

  return {
    stop(): void {
      scheduler.clearInterval(handle);
    },
    _tick: tick,
  };
}

function formatBody(title: string, ctx: Record<string, unknown>): string {
  const lines = [title];
  for (const [k, v] of Object.entries(ctx)) {
    lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return lines.join("\n");
}
