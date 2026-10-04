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
 * The CLOSED statuses belong to the gateway on EVERY job, paid or not, and a
 * generic writer never moves any job out of them: the statuses only its own
 * writers set (executing, completing, evidence_stored, evidence_submitted,
 * settled; none is in the vocabulary a generic writer may set), and the
 * lifecycle's terminal statuses (completed, failed, cancelled; job-lifecycle.ts),
 * which the local kernel also writes. A re-opened job is queued again, and a
 * remote node can run the same physical job a second time (astra, round 3 of
 * #475). A job can be settled without a session or escrow link, through a
 * configured escrow contract (astra, rounds 1 and 2 of #475), so the link
 * cannot decide. The guard reads the CURRENT status, not the target: a node
 * still finishes its own job (in_progress to completed or failed).
 * Every write is ONE conditional UPDATE, as /complete's claim is, so a status
 * the system sets in between is never overwritten.
 *
 * A job without a settlement record is otherwise unchanged: its node finishes
 * it (adk #452). The
 * system's own writers (the kernel service, the settlement path) write through
 * the repository and are not guarded here. WHO may write a job's status is
 * N85(b), gateway's owner checks in WP-C.
 */
import { schema, eq, and, sql } from "@pcc/store";
import { getRepos, getStore } from "../db.js";

/** Terminal statuses only the settlement path may set on a paid job. */
const TERMINAL = ["completed", "failed", "cancelled"] as const;
/**
 * Statuses a generic writer never moves ANY job out of:
 *  - those only the gateway's own writers set: executing (the local kernel), and
 *    completing, evidence_stored, evidence_submitted and settled (the settlement paths);
 *  - the lifecycle's terminal statuses, completed, failed and cancelled (job-lifecycle.ts),
 *    which the local kernel also writes (kernel-service.ts, routes/setup.ts). Re-opening one
 *    re-queues a job a remote node can run again.
 * The guard reads the CURRENT status, not the target, so a node can still
 * finish its own job (in_progress to completed or failed).
 */
const CLOSED = ["executing", "completing", "evidence_stored", "evidence_submitted", "settled", "completed", "failed", "cancelled"] as const;

type JobRow = NonNullable<ReturnType<ReturnType<typeof getRepos>["jobs"]["findById"]>>;

export type GuardedStatusWrite =
  | { readonly kind: "not_found" }
  | { readonly kind: "refused"; readonly currentStatus: string }
  | { readonly kind: "written"; readonly job: JobRow };

export const SETTLEMENT_OWNED_MESSAGE =
  "A paid job is finished only by its settlement path (PUT /api/jobs/:jobId/complete), and a job the gateway itself is running or settling is written only by the gateway. Progress can be reported on an open paid job.";

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
  const paid = hasSettlementRecord(job);
  if (paid && (TERMINAL as readonly string[]).includes(status)) return { kind: "refused", currentStatus: job.status };
  const owned: readonly string[] = CLOSED;
  const { db } = getStore();
  // The same fields the repository's updateStatus writes.
  const data: { status: string; progress?: number; completedAt?: string } = { status };
  if (progress !== undefined) data.progress = progress;
  if (status === "completed") data.completedAt = new Date().toISOString();
  const written = db
    .update(schema.jobs)
    .set(data)
    .where(
      and(
        eq(schema.jobs.id, jobId),
        sql`${schema.jobs.status} NOT IN (${sql.join(
          owned.map((s) => sql`${s}`),
          sql`, `,
        )})`,
      ),
    )
    .returning()
    .get();
  if (!written) return { kind: "refused", currentStatus: repos.jobs.findById(jobId)?.status ?? job.status };
  return { kind: "written", job: written as JobRow };
}
