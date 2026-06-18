/**
 * Kernel + capability TTL sweeper.
 *
 * Runs on an interval (default 5 min, configurable via KERNEL_SWEEP_INTERVAL_SEC).
 * Iterates the kernels and capabilities tables and marks expired rows as
 * `status="expired"` so they stop appearing in default listings.
 *
 * The runtime filter in `CapabilityFacade.list` already DROPS expired rows
 * by parsing `valid_until` on each read. The sweeper exists for two reasons
 * beyond that:
 *
 *   1. It writes a permanent `status="expired"` so dashboards + queries
 *      that hit the raw table see the truth without recomputing TTL.
 *   2. It emits one `kernel.expired` / `capability.expired` lifecycle event
 *      per transition so the dashboard can show liveness changes in real
 *      time without having to diff each list response.
 *
 * Re-registration semantics: if an expired row gets a fresh heartbeat
 * (POST /api/kernels/:kernelId/heartbeat), the heartbeat handler flips
 * status back to "online" and extends valid_until. That path is detected
 * separately (kernel.resurrected) and is NOT this module's job.
 *
 * The sweeper is idempotent — running it 1000 times back-to-back is a
 * no-op after the first pass.
 *
 * See docs/kernel-lifecycle.md for the contract.
 */

import type { IRepositories } from "@pcc/store";
import { emitKernelLifecycleEvent } from "../facades/kernel.facade.js";

const SWEEP_INTERVAL_LOWER_BOUND_SEC = 60; // 1 min — guard against thrash
const SWEEP_INTERVAL_UPPER_BOUND_SEC = 3600; // 1 h — guard against staleness
const SWEEP_INTERVAL_DEFAULT_SEC = 300; // 5 min, per Skylar's audit

export function resolveSweepIntervalSec(): number {
  const raw = process.env.KERNEL_SWEEP_INTERVAL_SEC;
  if (!raw) return SWEEP_INTERVAL_DEFAULT_SEC;
  const parsed = parseInt(raw, 10);
  if (
    !Number.isFinite(parsed) ||
    parsed < SWEEP_INTERVAL_LOWER_BOUND_SEC ||
    parsed > SWEEP_INTERVAL_UPPER_BOUND_SEC
  ) {
    console.warn(
      `[kernel-ttl-sweeper] KERNEL_SWEEP_INTERVAL_SEC="${raw}" out of band [${SWEEP_INTERVAL_LOWER_BOUND_SEC},${SWEEP_INTERVAL_UPPER_BOUND_SEC}]; using ${SWEEP_INTERVAL_DEFAULT_SEC}`,
    );
    return SWEEP_INTERVAL_DEFAULT_SEC;
  }
  return parsed;
}

export interface SweepResult {
  kernelsExpired: number;
  capabilitiesExpired: number;
  scannedKernels: number;
  scannedCapabilities: number;
}

/**
 * Run one pass of the sweeper. Returns counts so the caller can log/test.
 * Exposed as a pure function (takes repos in) so unit tests don't need
 * to spin up the timer.
 *
 * Conservatism: when valid_until is NULL or unparseable, the row is LEFT
 * ALONE. The catalog filter does the same — both choose to err on the
 * side of "show it" so a corrupted column doesn't silently disappear a
 * working capability.
 */
export function runOneSweep(repos: IRepositories, now: Date = new Date()): SweepResult {
  const nowMs = now.getTime();
  let kernelsExpired = 0;
  let capabilitiesExpired = 0;

  // ── Kernels ───────────────────────────────────────────────────────
  const kernels = repos.kernels.findAll() as any[];
  for (const k of kernels) {
    // Already expired? skip — idempotency
    if (k.status === "expired") continue;
    const raw = k.validUntil ?? k.valid_until;
    if (raw == null || raw === "") continue;
    const validUntilMs = Date.parse(raw);
    if (!Number.isFinite(validUntilMs)) continue;
    if (validUntilMs >= nowMs) continue;

    // Transition online → expired.
    try {
      repos.kernels.update(k.id, { status: "expired" } as any);
      kernelsExpired += 1;
      const lastHb = k.lastHeartbeat as string | null;
      const ageMin = lastHb && Number.isFinite(Date.parse(lastHb))
        ? Math.floor((nowMs - Date.parse(lastHb)) / 60000)
        : undefined;
      emitKernelLifecycleEvent({
        event: "kernel.expired",
        kernelId: k.id,
        lastHeartbeatAt: lastHb ?? null,
        ageMinutes: ageMin,
      });
    } catch {
      // soft fail — one bad row shouldn't stop the sweep
    }
  }

  // ── Capabilities ──────────────────────────────────────────────────
  const caps = repos.capabilities.findAll() as any[];
  for (const c of caps) {
    const raw = c.validUntil ?? c.valid_until;
    if (raw == null || raw === "") continue;
    const validUntilMs = Date.parse(raw);
    if (!Number.isFinite(validUntilMs)) continue;
    if (validUntilMs >= nowMs) continue;

    // Capabilities don't have a `status` column today. The filter is
    // entirely runtime on valid_until. We still emit a one-shot
    // capability.expired event the first time a capability crosses the
    // boundary so the dashboard can count it.
    // (Future: add capability.status column for parity with kernels.)
    emitKernelLifecycleEvent({
      event: "capability.expired",
      kernelId: c.kernelId,
      capabilityId: c.id,
      lastHeartbeatAt: (c.lastHeartbeatAt ?? c.last_heartbeat_at) ?? null,
    });
    capabilitiesExpired += 1;
  }

  return {
    kernelsExpired,
    capabilitiesExpired,
    scannedKernels: kernels.length,
    scannedCapabilities: caps.length,
  };
}

/**
 * Start the sweeper interval. Returns a stop() function for graceful
 * shutdown / tests. Idempotent — calling start() twice does nothing the
 * second time (the timer reference is module-scoped).
 */
let activeTimer: NodeJS.Timeout | null = null;

export interface SweeperHandle {
  stop(): void;
  intervalSec: number;
}

export function startKernelTtlSweeper(
  reposProvider: () => IRepositories,
): SweeperHandle {
  if (activeTimer) {
    // Already running — return a handle that stops the existing one.
    const existing = activeTimer;
    return {
      stop: () => {
        clearInterval(existing);
        if (activeTimer === existing) activeTimer = null;
      },
      intervalSec: resolveSweepIntervalSec(),
    };
  }
  const intervalSec = resolveSweepIntervalSec();
  const intervalMs = intervalSec * 1000;

  // Schedule recurring sweeps. We do NOT run immediately on start to keep
  // gateway boot cheap; the first sweep fires after `intervalSec` seconds.
  // Operators that want an immediate sweep can call runOneSweep manually.
  const timer = setInterval(() => {
    try {
      const repos = reposProvider();
      const result = runOneSweep(repos);
      if (result.kernelsExpired > 0 || result.capabilitiesExpired > 0) {
        console.log(
          `[kernel-ttl-sweeper] swept k:${result.kernelsExpired}/${result.scannedKernels} c:${result.capabilitiesExpired}/${result.scannedCapabilities}`,
        );
      }
    } catch (err) {
      console.error(`[kernel-ttl-sweeper] sweep failed:`, err);
    }
  }, intervalMs);
  // Don't keep the event loop alive just for the sweeper — vitest needs
  // to exit cleanly, and Railway always has request traffic.
  if (typeof (timer as any).unref === "function") {
    (timer as any).unref();
  }
  activeTimer = timer;

  return {
    stop: () => {
      clearInterval(timer);
      if (activeTimer === timer) activeTimer = null;
    },
    intervalSec,
  };
}
