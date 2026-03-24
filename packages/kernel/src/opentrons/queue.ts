/**
 * Device Job Queue — mutual exclusion for physical devices.
 *
 * A liquid handler can only run one protocol at a time. This queue
 * ensures incoming jobs don't overlap. Jobs are FIFO-ordered with
 * configurable max depth. Callers get a position and ETA.
 *
 * This is the critical safety layer between the A2A network and
 * the physical device.
 */

import { EventEmitter } from "node:events";

// ── Types ─────────────────────────────────────────────────────────

export interface QueuedJob {
  id: string;
  /** A2A conversation ID for status callbacks */
  conversationId?: string;
  /** Who submitted this job */
  submittedBy: string;
  /** Estimated duration in ms (from quote) */
  estimatedDurationMs: number;
  /** Opaque job payload — adapter interprets this */
  payload: Record<string, unknown>;
  /** When the job was enqueued */
  enqueuedAt: number;
  /** Position in queue at enqueue time */
  position: number;
}

export interface QueueStatus {
  /** Currently executing job (null if idle) */
  active: QueuedJob | null;
  /** Jobs waiting in queue */
  pending: QueuedJob[];
  /** Total queue depth including active */
  depth: number;
  /** Estimated wait time in ms for a new job */
  estimatedWaitMs: number;
  /** Whether the device is locked (job executing) */
  locked: boolean;
}

export interface EnqueueResult {
  accepted: boolean;
  /** Queue position (1-based, 0 = executing immediately) */
  position: number;
  /** Estimated time until this job starts (ms) */
  estimatedWaitMs: number;
  /** Rejection reason if not accepted */
  reason?: string;
  jobId: string;
}

export type QueueEvent =
  | { type: "job_enqueued"; job: QueuedJob; position: number }
  | { type: "job_started"; job: QueuedJob }
  | { type: "job_completed"; jobId: string; durationMs: number }
  | { type: "job_failed"; jobId: string; error: string }
  | { type: "job_rejected"; jobId: string; reason: string }
  | { type: "job_cancelled"; jobId: string };

// ── DeviceQueue ───────────────────────────────────────────────────

export class DeviceQueue extends EventEmitter {
  private queue: QueuedJob[] = [];
  private activeJob: QueuedJob | null = null;
  private locked = false;
  private maxDepth: number;
  private jobCounter = 0;

  /** Callback that actually executes the job on the device. Set by the operator. */
  private executor: ((job: QueuedJob) => Promise<void>) | null = null;

  constructor(maxDepth = 10) {
    super();
    this.maxDepth = maxDepth;
  }

  /** Register the function that runs jobs on the physical device */
  setExecutor(fn: (job: QueuedJob) => Promise<void>): void {
    this.executor = fn;
  }

  /** Enqueue a job. Returns position and ETA, or rejects if full. */
  enqueue(job: Omit<QueuedJob, "enqueuedAt" | "position">): EnqueueResult {
    // Reject if queue is full
    const currentDepth = this.queue.length + (this.locked ? 1 : 0);
    if (currentDepth >= this.maxDepth) {
      const event: QueueEvent = {
        type: "job_rejected",
        jobId: job.id,
        reason: `Queue full (${this.maxDepth} max)`,
      };
      this.emit("queue_event", event);
      return {
        accepted: false,
        position: -1,
        estimatedWaitMs: -1,
        reason: `Queue full (${this.maxDepth} max). Try again later.`,
        jobId: job.id,
      };
    }

    const position = this.queue.length + (this.locked ? 1 : 0);
    const queuedJob: QueuedJob = {
      ...job,
      enqueuedAt: Date.now(),
      position,
    };

    this.queue.push(queuedJob);
    this.jobCounter++;

    const waitMs = this.estimateWaitFor(position);

    const event: QueueEvent = {
      type: "job_enqueued",
      job: queuedJob,
      position,
    };
    this.emit("queue_event", event);

    // If device is idle, start processing immediately
    if (!this.locked) {
      this.processNext();
    }

    return {
      accepted: true,
      position,
      estimatedWaitMs: waitMs,
      jobId: job.id,
    };
  }

  /** Cancel a queued job (not the active one) */
  cancel(jobId: string): boolean {
    const idx = this.queue.findIndex((j) => j.id === jobId);
    if (idx === -1) return false;

    this.queue.splice(idx, 1);
    // Reindex positions
    this.queue.forEach((j, i) => {
      j.position = i + (this.locked ? 1 : 0);
    });

    this.emit("queue_event", { type: "job_cancelled", jobId } as QueueEvent);
    return true;
  }

  /** Get current queue status */
  getStatus(): QueueStatus {
    const pendingDurations = this.queue.reduce(
      (sum, j) => sum + j.estimatedDurationMs,
      0,
    );
    const activeDuration = this.activeJob?.estimatedDurationMs ?? 0;
    const activeElapsed = this.activeJob
      ? Date.now() - (this.activeJob.enqueuedAt)
      : 0;
    const remainingActive = Math.max(0, activeDuration - activeElapsed);

    return {
      active: this.activeJob,
      pending: [...this.queue],
      depth: this.queue.length + (this.locked ? 1 : 0),
      estimatedWaitMs: remainingActive + pendingDurations,
      locked: this.locked,
    };
  }

  /** Get position of a specific job */
  getPosition(jobId: string): number {
    if (this.activeJob?.id === jobId) return 0;
    const idx = this.queue.findIndex((j) => j.id === jobId);
    return idx === -1 ? -1 : idx + 1;
  }

  /** Estimate wait time for a given position */
  private estimateWaitFor(position: number): number {
    let wait = 0;

    // Time remaining on active job
    if (this.activeJob) {
      const elapsed = Date.now() - this.activeJob.enqueuedAt;
      wait += Math.max(0, this.activeJob.estimatedDurationMs - elapsed);
    }

    // Sum of all jobs ahead in queue
    for (let i = 0; i < position - (this.locked ? 1 : 0); i++) {
      if (this.queue[i]) {
        wait += this.queue[i].estimatedDurationMs;
      }
    }

    return wait;
  }

  /** Process the next job in queue (called internally) */
  private async processNext(): Promise<void> {
    if (this.locked || this.queue.length === 0) return;

    const job = this.queue.shift()!;
    this.locked = true;
    this.activeJob = job;

    // Reindex remaining queue
    this.queue.forEach((j, i) => {
      j.position = i + 1;
    });

    this.emit("queue_event", { type: "job_started", job } as QueueEvent);

    const startTime = Date.now();

    try {
      if (this.executor) {
        await this.executor(job);
      }

      const durationMs = Date.now() - startTime;
      this.emit("queue_event", {
        type: "job_completed",
        jobId: job.id,
        durationMs,
      } as QueueEvent);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit("queue_event", {
        type: "job_failed",
        jobId: job.id,
        error,
      } as QueueEvent);
    } finally {
      this.locked = false;
      this.activeJob = null;
      // Process next job if any
      this.processNext();
    }
  }
}
