import type { JobDTO, KernelDTO } from "../types/dto.js";

/** The job states included in the account read's in-flight work. */
export const ACTIVE_JOB_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "queued",
  "in_progress",
  "paused",
]);

export function isActiveJob(job: Pick<JobDTO, "status">): boolean {
  return ACTIVE_JOB_STATUSES.has(job.status);
}

/** The default number of rows returned by the jobs read. */
export const JOBS_PAGE_SIZE = 50;

/** A full page leaves open whether there are more matching jobs. */
export function mayBeTruncated(rows: readonly unknown[], pageSize = JOBS_PAGE_SIZE): boolean {
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

