import { schema, eq, and, sql, asc, count } from "@pcc/store";
import { getStore } from "../db.js";
import { emergencyStopState } from "../routes/device-relay.js";
import { writeJobStatusGuarded } from "./settlement-owned-status.js";
import type { JobHoldFields } from "@pcc/spec";

/**
 * Every undispatched job-row status: queued (relay default, submit, setup and
 * N104 external/queue-only paid routing); pending (real local paid routing and
 * caller-selected relay poll); active (mock local paid routing and relay poll);
 * scheduled (legacy queued-phase rows, caller-selected relay poll).
 * Dispatched/running/terminal rows have already crossed the dispatch boundary.
 */
export const HOLDABLE_JOB_STATUSES = ["queued", "pending", "active", "scheduled"] as const;

const { jobHolds, jobs } = schema;

/** Called inside the same synchronous transaction that engages the stop. */
export function holdUndispatchedJobs(kernelId: string, heldAt: string): void {
  const { db } = getStore();
  const rows = db.select({ id: jobs.id }).from(jobs).where(and(
    eq(jobs.kernelId, kernelId),
    sql`lower(trim(${jobs.status})) IN (${sql.join(HOLDABLE_JOB_STATUSES.map(s => sql`${s}`), sql`, `)})`,
  )).all();
  for (const row of rows) {
    db.insert(jobHolds).values({ jobId: row.id, kernelId, reason: "emergency_stop", heldAt })
      .onConflictDoNothing().run();
  }
}

/** Job creation and a stopped kernel's hold commit together, including paid rows. */
export function createJobWithHold<R extends { id: string; kernelId: string; status: string }, T>(
  row: R, insert: (row: R) => T,
): T {
  return getStore().db.transaction(() => {
    const stopped = emergencyStopState(row.kernelId) === "stopped";
    const created = insert(stopped ? { ...row, status: "queued" } : row);
    if (stopped) {
      getStore().db.insert(jobHolds).values({
        jobId: row.id, kernelId: row.kernelId, reason: "emergency_stop", heldAt: new Date().toISOString(),
      }).run();
    }
    return created;
  });
}

export function isJobHeld(jobId: string): boolean {
  return Boolean(getStore().db.select({ jobId: jobHolds.jobId }).from(jobHolds)
    .where(eq(jobHolds.jobId, jobId)).get());
}

export function jobHoldFields(jobId: string): JobHoldFields {
  return isJobHeld(jobId) ? { held: true, holdReason: "emergency_stop" } : { held: false };
}

/** SQLite binds at most 32766 variables per statement, so a kernel's whole job list is read in chunks. */
const HOLD_LOOKUP_CHUNK = 500;

export function jobHoldFieldsById(ids: string[]): Map<string, ReturnType<typeof jobHoldFields>> {
  const result = new Map(ids.map(id => [id, { held: false } as ReturnType<typeof jobHoldFields>]));
  for (let i = 0; i < ids.length; i += HOLD_LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + HOLD_LOOKUP_CHUNK);
    const rows = getStore().db.select({ jobId: jobHolds.jobId }).from(jobHolds)
      .where(sql`${jobHolds.jobId} IN (${sql.join(chunk.map(id => sql`${id}`), sql`, `)})`).all();
    for (const { jobId } of rows) result.set(jobId, { held: true, holdReason: "emergency_stop" });
  }
  return result;
}

/** Bounded preview with a true total; stable ordering even for a single stop timestamp. */
export function listHeldJobs(kernelId: string) {
  const { db } = getStore();
  const heldCount = db.select({ total: count() }).from(jobHolds).where(eq(jobHolds.kernelId, kernelId)).get()!.total;
  const heldJobs = db.select({ jobId: jobHolds.jobId, capabilityId: jobs.capabilityId, heldAt: jobHolds.heldAt })
    .from(jobHolds).innerJoin(jobs, eq(jobs.id, jobHolds.jobId)).where(eq(jobHolds.kernelId, kernelId))
    .orderBy(asc(jobHolds.heldAt), asc(jobHolds.jobId)).limit(100).all();
  return { heldCount, heldJobs };
}

/** Validate the entire target set before mutating any hold or job. No await in this transaction. */
export function moveHeldJobs(kernelId: string, release?: string[] | "all", cancel: string[] = []) {
  return getStore().db.transaction(() => {
    const { db } = getStore();
    const released: string[] = [];
    const cancelled: string[] = [];
    const refused: Array<{ jobId: string; reason: "settlement_owned_status" | "job_not_found" }> = [];
    const releaseIds = release === "all"
      ? db.select({ jobId: jobHolds.jobId }).from(jobHolds).where(eq(jobHolds.kernelId, kernelId))
        .orderBy(asc(jobHolds.heldAt), asc(jobHolds.jobId)).all().map(row => row.jobId)
      : [...new Set(release ?? [])];
    const cancelIds = [...new Set(cancel)];
    if (cancelIds.some(id => releaseIds.includes(id))) return { kind: "overlap" as const };
    for (const jobId of [...releaseIds, ...cancelIds]) {
      const held = db.select({ kernelId: jobHolds.kernelId }).from(jobHolds).where(eq(jobHolds.jobId, jobId)).get();
      if (!held || held.kernelId !== kernelId) return { kind: "not_held_for_kernel" as const };
    }
    for (const jobId of releaseIds) {
      db.delete(jobHolds).where(and(eq(jobHolds.jobId, jobId), eq(jobHolds.kernelId, kernelId))).run();
      released.push(jobId);
    }
    for (const jobId of cancelIds) {
      const outcome = writeJobStatusGuarded(jobId, "cancelled", undefined, kernelId);
      if (outcome.kind !== "written") {
        refused.push({ jobId, reason: outcome.kind === "not_found" ? "job_not_found" : "settlement_owned_status" });
        continue;
      }
      db.delete(jobHolds).where(and(eq(jobHolds.jobId, jobId), eq(jobHolds.kernelId, kernelId))).run();
      cancelled.push(jobId);
    }
    return { kind: "updated" as const, released, cancelled, refused };
  });
}
