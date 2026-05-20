/**
 * Internal demand-intel admin endpoints — auth-gated, NOT public.
 *
 * PCC consumes its own intelligence. These endpoints expose the
 * hourly/daily DemandSnapshots and per-composition drilldowns to
 * authenticated PCC operators on the admin allowlist.
 *
 * Hard rules:
 *   - No public surface. All routes require (a) an authenticated operator
 *     session AND (b) operator on the PCC_DEMAND_ADMINS allowlist.
 *   - No signing. No cross-chain. No oracle interface.
 *   - Snapshots persist via existing materializedViews table (viewType
 *     "demand_snapshot_hour" / "demand_snapshot_day") — no new tables.
 *
 * Endpoints:
 *   GET /api/admin/demand/composites?since=<iso>&limit=50
 *   GET /api/admin/demand/snapshot/:window     (window in {hour, day})
 *   GET /api/admin/demand/status
 *   GET /api/admin/demand/composite/:signature
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { DemandAggregator } from "@pcc/demand-intel";
import type { DemandSnapshot } from "@pcc/spec";
import { getRepos } from "../db.js";

// ── Auth gate ─────────────────────────────────────────────────────────────

/**
 * Returns true if the operator is on the PCC_DEMAND_ADMINS allowlist.
 * Comma-separated env var of operator IDs / wallet addresses (lower-cased).
 *
 * If the env var is empty / unset, NO admin is allowed (closed-by-default).
 * Production must explicitly opt-in operators.
 */
function isDemandAdmin(operatorId: string | undefined | null): boolean {
  if (!operatorId) return false;
  const raw = process.env.PCC_DEMAND_ADMINS ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.has(operatorId.toLowerCase());
}

function requireDemandAdmin(req: FastifyRequest, reply: FastifyReply): string | null {
  const callerId =
    (req as unknown as { operatorId?: string }).operatorId ??
    (req as unknown as { userId?: string }).userId;
  if (!callerId) {
    void reply.status(401).send({ error: "authentication_required" });
    return null;
  }
  if (!isDemandAdmin(callerId)) {
    void reply.status(403).send({
      error: "forbidden",
      message:
        "Demand-intel admin endpoints require operator on PCC_DEMAND_ADMINS allowlist.",
    });
    return null;
  }
  return callerId;
}

// ── Snapshot persistence helpers ──────────────────────────────────────────

const HOUR_VIEW_TYPE = "demand_snapshot_hour";
const DAY_VIEW_TYPE = "demand_snapshot_day";

/** Persist a snapshot via materializedViews (reuses existing table). */
function persistSnapshot(snap: DemandSnapshot): void {
  const repos = getRepos();
  const viewType = snap.window === "hour" ? HOUR_VIEW_TYPE : DAY_VIEW_TYPE;
  const scopeKey = "network"; // global scope for now
  repos.analytics.upsertMaterializedView({
    id: snap.id,
    viewType,
    scopeKey,
    data: snap as unknown as Record<string, unknown>,
    computedAt: snap.computedAt,
    eventCount: snap.totalIntents,
    periodStart: snap.windowStart,
    periodEnd: snap.windowEnd,
  });
}

/** Read the most recent persisted snapshot for a window type. */
function latestSnapshot(window: "hour" | "day"): DemandSnapshot | null {
  const repos = getRepos();
  const viewType = window === "hour" ? HOUR_VIEW_TYPE : DAY_VIEW_TYPE;
  const all = repos.analytics.findAllMaterializedViews();
  const matching = all.filter((v) => v.viewType === viewType);
  if (matching.length === 0) return null;
  matching.sort((a, b) => (b.computedAt > a.computedAt ? 1 : -1));
  const top = matching[0]!;
  return top.data as unknown as DemandSnapshot;
}

// ── Cron state ────────────────────────────────────────────────────────────

interface SnapshotCronState {
  lastHourlyAt: number; // ms epoch
  lastDailyAt: number; // ms epoch
  timer: NodeJS.Timeout | null;
}

const cronState: SnapshotCronState = {
  lastHourlyAt: 0,
  lastDailyAt: 0,
  timer: null,
};

/** Compute and persist a snapshot for a window. Best-effort: errors are logged but never thrown. */
function runSnapshot(window: "hour" | "day", logger?: { info: (msg: string) => void; warn: (msg: string) => void }): void {
  try {
    const repos = getRepos();
    const aggregator = new DemandAggregator(repos);
    const snap = aggregator.snapshot(window);
    persistSnapshot(snap);
    logger?.info?.(
      `[demand-intel] persisted ${window} snapshot ${snap.id} (totalIntents=${snap.totalIntents})`,
    );
  } catch (err) {
    logger?.warn?.(
      `[demand-intel] ${window} snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Start the snapshot cron. Polls every 60s. On the first crossing of a new
 * hour or day boundary, computes and persists the snapshot.
 *
 * Idempotent: a second call is a no-op.
 */
export function startDemandSnapshotCron(
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  if (cronState.timer) return;
  // Initial run on boot to bootstrap the latest snapshot
  runSnapshot("hour", logger);
  runSnapshot("day", logger);
  const now = Date.now();
  cronState.lastHourlyAt = now;
  cronState.lastDailyAt = now;

  cronState.timer = setInterval(() => {
    const ts = Date.now();
    // Hour boundary crossed?
    if (Math.floor(ts / 3_600_000) > Math.floor(cronState.lastHourlyAt / 3_600_000)) {
      runSnapshot("hour", logger);
      cronState.lastHourlyAt = ts;
    }
    // Day boundary crossed?
    if (Math.floor(ts / 86_400_000) > Math.floor(cronState.lastDailyAt / 86_400_000)) {
      runSnapshot("day", logger);
      cronState.lastDailyAt = ts;
    }
  }, 60_000);

  // Don't keep the event loop alive in tests
  cronState.timer.unref?.();
}

/** Stop the cron (test cleanup). Idempotent. */
export function stopDemandSnapshotCron(): void {
  if (cronState.timer) {
    clearInterval(cronState.timer);
    cronState.timer = null;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

export async function adminDemandRoutes(app: FastifyInstance) {
  // ── GET /api/admin/demand/composites ────────────────────────────────────
  // Top compositions from the most recent hourly snapshot.
  // Query params:
  //   since=<iso>  - optional; if provided, only return compositions where
  //                   the snapshot windowStart >= since
  //   limit=50     - cap on returned compositions (default 50)
  app.get("/api/admin/demand/composites", async (req, reply) => {
    if (!requireDemandAdmin(req, reply)) return;
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(parseInt(q.limit ?? "50", 10) || 50, 50);
    const since = q.since;

    const latest = latestSnapshot("hour");
    if (!latest) {
      return reply.send({
        compositions: [],
        snapshotId: null,
        windowStart: null,
        windowEnd: null,
        totalIntents: 0,
      });
    }
    if (since && latest.windowStart < since) {
      return reply.send({
        compositions: [],
        snapshotId: latest.id,
        windowStart: latest.windowStart,
        windowEnd: latest.windowEnd,
        totalIntents: 0,
      });
    }
    return reply.send({
      compositions: latest.topCompositions.slice(0, limit),
      snapshotId: latest.id,
      windowStart: latest.windowStart,
      windowEnd: latest.windowEnd,
      totalIntents: latest.totalIntents,
    });
  });

  // ── GET /api/admin/demand/snapshot/:window ─────────────────────────────
  app.get<{ Params: { window: string } }>(
    "/api/admin/demand/snapshot/:window",
    async (req, reply) => {
      if (!requireDemandAdmin(req, reply)) return;
      const w = req.params.window;
      if (w !== "hour" && w !== "day") {
        return reply.status(400).send({
          error: "bad_request",
          message: "window must be 'hour' or 'day'",
        });
      }
      const snap = latestSnapshot(w);
      if (!snap) {
        return reply.status(404).send({ error: "no_snapshot_yet" });
      }
      return reply.send({ snapshot: snap });
    },
  );

  // ── GET /api/admin/demand/status ────────────────────────────────────────
  app.get("/api/admin/demand/status", async (req, reply) => {
    if (!requireDemandAdmin(req, reply)) return;
    const repos = getRepos();
    const hourly = latestSnapshot("hour");
    const daily = latestSnapshot("day");

    // Cheap "totalIntents all time" — count intent.* rows from analytics
    const intentEventTypes = [
      "intent.composite_request",
      "intent.atomic_session",
      "intent.synthetic_query",
    ];
    let totalAllTime = 0;
    let recentEvents = 0;
    const oneMinuteAgo = Date.now() - 60_000;
    for (const et of intentEventTypes) {
      const rows = repos.analytics.findEventsByType(et);
      totalAllTime += rows.length;
      for (const r of rows) {
        if (new Date(r.timestamp).getTime() >= oneMinuteAgo) recentEvents++;
      }
    }

    return reply.send({
      lastHourlySnapshotAt: hourly?.computedAt ?? null,
      lastDailySnapshotAt: daily?.computedAt ?? null,
      totalIntentsCapturedAllTime: totalAllTime,
      ingestRatePerMinute: recentEvents,
    });
  });

  // ── GET /api/admin/demand/composite/:signature ─────────────────────────
  // Drilldown: all intents matching a specific compositionSignature.
  app.get<{ Params: { signature: string } }>(
    "/api/admin/demand/composite/:signature",
    async (req, reply) => {
      if (!requireDemandAdmin(req, reply)) return;
      const sig = req.params.signature;
      if (!/^0x[a-f0-9]{64}$/i.test(sig)) {
        return reply.status(400).send({
          error: "bad_request",
          message: "signature must be 0x followed by 64 hex chars",
        });
      }

      // Walk all intent.* events and filter by payload.compositionSignature
      const repos = getRepos();
      const intentEventTypes = [
        "intent.composite_request",
        "intent.atomic_session",
        "intent.synthetic_query",
      ];
      const envelopes: Array<Record<string, unknown>> = [];
      for (const et of intentEventTypes) {
        const rows = repos.analytics.findEventsByType(et);
        for (const r of rows) {
          const payload = r.payload as unknown as Record<string, unknown> | null;
          if (
            payload &&
            typeof payload.compositionSignature === "string" &&
            payload.compositionSignature.toLowerCase() === sig.toLowerCase()
          ) {
            envelopes.push(payload);
          }
        }
      }
      // Most recent first
      envelopes.sort((a, b) => {
        const ta = String(a.createdAt ?? "");
        const tb = String(b.createdAt ?? "");
        return tb.localeCompare(ta);
      });
      const limited = envelopes.slice(0, 100);
      return reply.send({
        signature: sig,
        envelopes: limited,
        count: limited.length,
        truncated: envelopes.length > 100,
      });
    },
  );
}

// ── Test helper ───────────────────────────────────────────────────────────

/** Used by tests to force a snapshot now without waiting for the cron tick. */
export function _testRunSnapshotNow(window: "hour" | "day"): void {
  runSnapshot(window);
}
