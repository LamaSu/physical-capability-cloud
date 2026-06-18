/**
 * Canonical job-status vocabulary for the PCC gateway.
 *
 * One source of truth shared by every endpoint that validates or emits a job
 * status — PATCH /api/jobs/:id/status, POST /api/operator/job-status, and the
 * WoT Thing Description job-result schema. The API canonicalised on
 * `in_progress`; the agent docs historically advertised `running`, so a client
 * that followed the docs got a 400. We tolerate `running` as an input alias and
 * normalise it to `in_progress`, so doc-following clients keep working while the
 * stored/returned vocabulary stays consistent.
 */

/** The canonical, advertised set of job statuses (the only values we store). */
export const JOB_STATUSES = [
  "pending",
  "queued",
  "in_progress",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Input-only aliases tolerated on write and normalised to a canonical status.
 * Keep these one-directional: we accept the alias but never store or emit it.
 */
const JOB_STATUS_ALIASES: Readonly<Record<string, JobStatus>> = {
  running: "in_progress",
};

const JOB_STATUS_SET: ReadonlySet<string> = new Set(JOB_STATUSES);

/** True when `s` is already a canonical job status. */
export function isJobStatus(s: string): s is JobStatus {
  return JOB_STATUS_SET.has(s);
}

/**
 * Resolve an input status to its canonical form, applying tolerated aliases.
 * Returns null when the value is neither canonical nor a known alias — callers
 * should treat null as a 400 (invalid status).
 */
export function normalizeJobStatus(s: string): JobStatus | null {
  if (JOB_STATUS_SET.has(s)) return s as JobStatus;
  return JOB_STATUS_ALIASES[s] ?? null;
}
