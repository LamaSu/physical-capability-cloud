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
}

/**
 * Turn the live reads into what the StatusBar shows.
 *
 * A count is shown only when its latest read succeeded; otherwise it is left
 * undefined, which the bar renders as unavailable rather than as 0. The
 * gateway is "connected" only after /api/health answered ok.
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

  const kernelsOnline =
    kernels.isSuccess && kernels.data ? kernels.data.filter(isKernelOnline).length : undefined;

  const activeJobs = jobs.isSuccess && jobs.data ? jobs.data.filter(isActiveJob).length : undefined;

  return { networkStatus, kernelsOnline, activeJobs };
}
