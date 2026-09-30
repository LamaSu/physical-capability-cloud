/**
 * N85(a): a paid job's terminal status belongs to its settlement path.
 *
 * A job with a settlement record (a negotiation session bound to it, or an
 * escrow for its workflow) is finished only by PUT /api/jobs/:jobId/complete:
 * evidence, then settlement. The generic status writers (the relay's
 * POST /api/operator/job-status, PATCH /api/jobs/:jobId/status, and the MCP
 * cancel operation, both through JobFacade.updateStatus) may report progress on
 * it, but may not:
 *   - set a terminal status (completed, failed, cancelled). That strands the
 *     settlement, since /complete then refuses, or releases the escrow early;
 *   - write at all once the job is terminal or inside the settlement pipeline.
 *     That would re-open it and let /complete settle it a second time.
 * On a paid job the write is ONE conditional UPDATE, as /complete's claim is, so
 * a completion claimed in between is never overwritten.
 *
 * A job without a settlement record is unchanged: its node finishes it (adk
 * #452). The system's own writers (the kernel service, the settlement path)
 * write through the repository and are not guarded here. WHO may write a job's
 * status is N85(b), gateway's owner checks in WP-C.
 */
import { schema, eq, and, sql } from "@pcc/store";
import { getRepos, getStore } from "../db.js";

/** Terminal statuses only the settlement path may set on a paid job. */
const TERMINAL = ["completed", "failed", "cancelled"] as const;
/** Statuses a generic writer may never move a paid job out of: terminal, or /complete's pipeline. */
const SETTLEMENT_OWNED = ["completing", "evidence_submitted", "settled", "completed", "failed", "cancelled"] as const;

type JobRow = NonNullable<ReturnType<ReturnType<typeof getRepos>["jobs"]["findById"]>>;

export type GuardedStatusWrite =
  | { readonly kind: "not_found" }
  | { readonly kind: "refused"; readonly currentStatus: string }
  | { readonly kind: "written"; readonly job: JobRow };

export const SETTLEMENT_OWNED_MESSAGE =
  "A paid job is finished only by its settlement path (PUT /api/jobs/:jobId/complete). Progress can be reported while it is open.";

/** Whether the job has a settlement record: a negotiation session bound to it, or an escrow for its workflow. */
export function hasSettlementRecord(job: { readonly id: string; readonly cwmId?: string | null }): boolean {
  const { db } = getStore();
  const session = db
    .select({ id: schema.negotiationSessions.id })
    .from(schema.negotiationSessions)
    .where(eq(schema.negotiationSessions.jobId, job.id))
    .get();
  if (session) return true;
  return Boolean(job.cwmId && getRepos().escrows.findByCwm(job.cwmId));
}

/** Write a job's status for a GENERIC writer, under N85(a). */
export function writeJobStatusGuarded(jobId: string, status: string, progress?: number): GuardedStatusWrite {
  const repos = getRepos();
  const job = repos.jobs.findById(jobId);
  if (!job) return { kind: "not_found" };
  if (!hasSettlementRecord(job)) {
    const written = repos.jobs.updateStatus(jobId, status, progress);
    return written ? { kind: "written", job: written } : { kind: "not_found" };
  }
  if ((TERMINAL as readonly string[]).includes(status)) return { kind: "refused", currentStatus: job.status };
  const { db } = getStore();
  const data: { status: string; progress?: number } = { status };
  if (progress !== undefined) data.progress = progress;
  const written = db
    .update(schema.jobs)
    .set(data)
    .where(
      and(
        eq(schema.jobs.id, jobId),
        sql`${schema.jobs.status} NOT IN (${sql.join(
          SETTLEMENT_OWNED.map((s) => sql`${s}`),
          sql`, `,
        )})`,
      ),
    )
    .returning()
    .get();
  if (!written) return { kind: "refused", currentStatus: repos.jobs.findById(jobId)?.status ?? job.status };
  return { kind: "written", job: written as JobRow };
}
