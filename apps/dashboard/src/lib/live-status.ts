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
 * reachability rule is the same as deriveLiveStatus's.
 */
export function deriveHomeStatus(reads: {
  health: QueryView<{ status: string; commit?: unknown; commitSource?: unknown }>;
  home: QueryView<ProductHomeDTO>;
}): LiveStatus {
  const networkStatus = gatewayConnectivity(reads.health);
  const home = networkStatus === "connected" && reads.home.isSuccess ? reads.home.data : undefined;
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

/** "connected" only after /api/health answered ok; "unknown" until it has answered. */
export function gatewayConnectivity(health: QueryView<{ status: string }>): GatewayConnectivity {
  if (health.isError) return "disconnected";
  if (health.isSuccess) return health.data?.status === "ok" ? "connected" : "disconnected";
  return "unknown";
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
  const networkStatus = gatewayConnectivity(health);
  const reachable = networkStatus === "connected";

  const kernelsOnline =
    reachable && kernels.isSuccess && kernels.data ? kernels.data.filter(isKernelOnline).length : undefined;

  const activeJobs = reachable && jobs.isSuccess && jobs.data ? jobs.data.filter(isActiveJob).length : undefined;
  const activeJobsAtLeast = Boolean(activeJobs !== undefined && jobs.data && mayBeTruncated(jobs.data));

  return { networkStatus, kernelsOnline, activeJobs, activeJobsAtLeast };
}
