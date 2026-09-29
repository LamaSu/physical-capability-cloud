/**
 * What "active job" and "online kernel" mean, in one place.
 *
 * The StatusBar and the Command Center both show these counts. They must
 * never disagree, and neither may count something it cannot classify.
 */

import type { ProductHomeDTO } from "@pcc/spec";
import { configuredNetworkLabel, readSection } from "./product-home.js";
import type { JobDTO, KernelDTO } from "../types/dto.js";

/**
 * Job statuses that count as active: the same set the gateway calls in-flight
 * work in GET /api/agent/me (routes/agent-introspection.ts). A status outside
 * this set, including an unknown one, is not counted as active.
 */
export const ACTIVE_JOB_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "queued",
  "in_progress",
  "paused",
]);

export function isActiveJob(job: Pick<JobDTO, "status">): boolean {
  return ACTIVE_JOB_STATUSES.has(String(job.status));
}

/**
 * GET /api/jobs returns at most this many rows when the caller sets no limit
 * (packages/gateway/src/facades/job.facade.ts), and the route does not report
 * a total. A full page may therefore be truncated, and any count taken from
 * it is a lower bound, not a total.
 */
export const JOBS_PAGE_SIZE = 50;

/** True when a job list came back full, so counts over it are only lower bounds. */
export function mayBeTruncated(rows: readonly unknown[], pageSize: number = JOBS_PAGE_SIZE): boolean {
  return rows.length >= pageSize;
}

/** "12" for an exact count, "12+" for a lower bound. */
export function formatCount(value: number, atLeast: boolean): string {
  return atLeast ? `${value}+` : String(value);
}

/**
 * A kernel is online only if it reports "online" and says its heartbeat is
 * fresh. The gateway always sets `isStale` (facades/populators/kernel.populator.ts),
 * true when an online kernel has not sent a heartbeat recently; a kernel that
 * doesn't say is not counted as fresh.
 */
export function isKernelOnline(kernel: Pick<KernelDTO, "status" | "isStale">): boolean {
  return kernel.status === "online" && kernel.isStale === false;
}

/**
 * The oldest a count may be and still be shown as current. The status bar
 * re-reads its counts every 30 s, so a count older than this missed at least
 * two reads.
 */
export const COUNT_MAX_AGE_MS = 75_000;

/** The parts of a react-query result the status bar reads. */
export interface QueryView<T> {
  data: T | undefined;
  isSuccess: boolean;
  isError: boolean;
  /** When `data` was last read successfully (ms since epoch; 0 if never). */
  dataUpdatedAt: number;
  /** When the latest failed read happened (ms since epoch; 0 if none). */
  errorUpdatedAt: number;
}

export type GatewayConnectivity = "connected" | "disconnected" | "unknown";

/** What the dashboard StatusBar shows, derived from live reads only. */
export interface LiveStatus {
  networkStatus: GatewayConnectivity;
  /** undefined when unknown: loading, or the latest read failed. Never 0 by default. */
  kernelsOnline: number | undefined;
  activeJobs: number | undefined;
  /** activeJobs came from a full, possibly truncated page: a lower bound. */
  activeJobsAtLeast: boolean;
  /** The settlement network the gateway is configured for, labelled as configuration. */
  network?: string;
  /** "build <sha7>" when /api/health reports the commit baked into the image (N5). */
  build?: string;
}

/**
 * The served build, from /api/health (N5, #369): only a full 40-hex commit
 * whose source is the image build. A runtime or unknown commit is not shown.
 */
export function buildLabel(health: QueryView<{ status: string; commit?: unknown; commitSource?: unknown }>): string | undefined {
  const d = health.isSuccess ? health.data : undefined;
  if (!d || d.commitSource !== "image_build" || typeof d.commit !== "string" || !/^[0-9a-f]{40}$/.test(d.commit)) return undefined;
  return `build ${d.commit.slice(0, 7)}`;
}

/**
 * The StatusBar from ProductHomeDTO (readmodels #409): exact counts the gateway
 * made over its own records, not a count over one page. A section the gateway
 * could not read, like a failed read, leaves its count undefined ("—"). The
 * reachability and freshness rules are deriveLiveStatus's (isCurrent).
 */
export function deriveHomeStatus(
  reads: {
    health: QueryView<{ status: string; commit?: unknown; commitSource?: unknown }>;
    home: QueryView<ProductHomeDTO>;
  },
  now: number = Date.now(),
): LiveStatus {
  const networkStatus = gatewayConnectivity(reads.health);
  const home = isCurrent(reads.home, reads.health, now) ? reads.home.data : undefined;
  const kernels = readSection(home?.kernels);
  const jobs = readSection(home?.jobs);
  return {
    networkStatus,
    kernelsOnline: kernels ? kernels.online : undefined,
    activeJobs: jobs ? jobs.active : undefined,
    activeJobsAtLeast: false,
    network: configuredNetworkLabel(home),
    build: networkStatus === "connected" ? buildLabel(reads.health) : undefined,
  };
}

/**
 * Whether a read may be shown as current. All of these must hold:
 * - the gateway is confirmed reachable now;
 * - the read's latest attempt succeeded;
 * - it happened after the gateway's last failed health check;
 * - it is at most COUNT_MAX_AGE_MS old.
 * A recovered health check vouches for the gateway, not for a count cached
 * before the outage.
 */
export function isCurrent<T>(
  q: QueryView<T>,
  health: QueryView<{ status: string }>,
  now: number,
): q is QueryView<T> & { data: T } {
  return (
    gatewayConnectivity(health) === "connected" &&
    q.isSuccess &&
    q.data !== undefined &&
    q.dataUpdatedAt > health.errorUpdatedAt &&
    now - q.dataUpdatedAt <= COUNT_MAX_AGE_MS
  );
}

/** "connected" only after /api/health answered ok; "unknown" until it has answered. */
export function gatewayConnectivity(health: QueryView<{ status: string }>): GatewayConnectivity {
  if (health.isError) return "disconnected";
  if (health.isSuccess) return health.data?.status === "ok" ? "connected" : "disconnected";
  return "unknown";
}

/**
 * Turn the live reads into what the StatusBar shows.
 *
 * A count is shown only when all of these hold:
 * - the gateway is confirmed reachable right now;
 * - the count's latest read succeeded;
 * - that read happened after the gateway's last failed health check;
 * - the read is at most COUNT_MAX_AGE_MS old.
 *
 * Otherwise the count is left undefined, which the bar renders as
 * unavailable rather than as 0. So a count read before an outage is never
 * presented as current, not even once the gateway answers again: the
 * recovered health check vouches for the gateway, not for the count. The
 * gateway is "connected" only after /api/health answered ok.
 */
export function deriveLiveStatus(
  reads: {
    health: QueryView<{ status: string }>;
    kernels: QueryView<KernelDTO[]>;
    jobs: QueryView<JobDTO[]>;
  },
  now: number = Date.now(),
): LiveStatus {
  const { health, kernels, jobs } = reads;
  const networkStatus = gatewayConnectivity(health);
  const kernelsOnline = isCurrent(kernels, health, now) ? kernels.data.filter(isKernelOnline).length : undefined;
  const activeJobs = isCurrent(jobs, health, now) ? jobs.data.filter(isActiveJob).length : undefined;
  const activeJobsAtLeast = Boolean(activeJobs !== undefined && jobs.data && mayBeTruncated(jobs.data));

  return { networkStatus, kernelsOnline, activeJobs, activeJobsAtLeast };
}
