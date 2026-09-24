/**
 * What "active job" and "online kernel" mean, in one place.
 *
 * The StatusBar and the Command Center both show these counts. They must
 * never disagree, and neither may count something it cannot classify.
 */

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
 * A kernel is online only if it reports "online" and its heartbeat is fresh.
 * The gateway sets `isStale` when an online kernel has not sent a heartbeat
 * recently (facades/populators/kernel.populator.ts).
 */
export function isKernelOnline(kernel: Pick<KernelDTO, "status" | "isStale">): boolean {
  return kernel.status === "online" && kernel.isStale !== true;
}

/** The parts of a react-query result the status bar reads. */
export interface QueryView<T> {
  data: T | undefined;
  isSuccess: boolean;
  isError: boolean;
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
}

/**
 * Turn the live reads into what the StatusBar shows.
 *
 * A count is shown only when its latest read succeeded AND the gateway is
 * confirmed reachable right now. Otherwise it is left undefined, which the
 * bar renders as unavailable rather than as 0. A count read before an outage
 * is not presented as current. The gateway is "connected" only after
 * /api/health answered ok.
 */
export function deriveLiveStatus(reads: {
  health: QueryView<{ status: string }>;
  kernels: QueryView<KernelDTO[]>;
  jobs: QueryView<JobDTO[]>;
}): LiveStatus {
  const { health, kernels, jobs } = reads;

  let networkStatus: GatewayConnectivity = "unknown";
  if (health.isError) networkStatus = "disconnected";
  else if (health.isSuccess) networkStatus = health.data?.status === "ok" ? "connected" : "disconnected";

  const reachable = networkStatus === "connected";

  const kernelsOnline =
    reachable && kernels.isSuccess && kernels.data ? kernels.data.filter(isKernelOnline).length : undefined;

  const activeJobs = reachable && jobs.isSuccess && jobs.data ? jobs.data.filter(isActiveJob).length : undefined;
  const activeJobsAtLeast = Boolean(activeJobs !== undefined && jobs.data && mayBeTruncated(jobs.data));

  return { networkStatus, kernelsOnline, activeJobs, activeJobsAtLeast };
}
