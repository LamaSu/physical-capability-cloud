/**
 * Workflow-layer types.
 *
 * See design §5.5.
 */

import type { CanonicalInput, Result } from '../shared/types.js';
import type { WorkflowRunRow } from '../store/types.js';

/** Options when starting a new (or resuming an existing) workflow run. */
export interface StartWorkflowOptions {
  /** Explicit runId — bypasses deterministic derivation. */
  runId?: string;
  /**
   * If true and `runId` is NOT supplied, the engine derives a deterministic
   * runId from (name, canonical(args)) — passing the same args twice returns
   * the same handle. See design §6.3.
   */
  findOrCreate?: boolean;
  correlationId?: string;
  parentRunId?: string;
  /** Principal that initiated the run; recorded into events as actor_id. */
  actorId?: string;
}

/** External-facing handle to a running (or completed) workflow. */
export interface WorkflowHandle<R> {
  readonly runId: string;
  /** Wait for the workflow to terminate and return its result. */
  result(): Promise<Result<R, Error>>;
  /** Deliver an external signal. */
  signal<T extends CanonicalInput>(name: string, payload: T): Promise<void>;
  /** Cancel the run (idempotent). */
  cancel(reason?: string): Promise<void>;
  /** Read the current WorkflowRunRow without mutating. */
  describe(): Promise<WorkflowRunRow>;
}
