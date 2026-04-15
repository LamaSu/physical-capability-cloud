/**
 * WorkflowEngine — orchestrates start / resume / recover / shutdown.
 *
 * See design §5.5 and §8.1.
 *
 * Durability model: step-memoization (Inngest-style).
 *   - Every ctx.step() call looks up (runId, stepId) in step_results.
 *   - On hit, the cached result returns immediately — lambda does NOT run.
 *   - On miss, the lambda runs. On success, result is memoized. On failure,
 *     the error bubbles up through run(). A crash between lambda completion
 *     and memoization is re-tried (at-least-once per step).
 *
 * Signals: single-process in v0.1 — when ctx.signal() awaits, the waiter is
 * registered in an in-memory Map and resolved when engine.signal() is called.
 * A crash drops the waiter and the run transitions to status='paused'; it
 * resumes on the next engine.start()/recover() call that receives the signal.
 */

import { randomUUID } from 'node:crypto';

import type {
  CanonicalInput,
  WorkflowContext,
  Result,
} from '../shared/types.js';
import {
  ActivityFailedError,
  DuplicateRunIdError,
  NotImplementedError,
  err,
  ok,
} from '../shared/types.js';
import { canonicalJSONStrict } from '../shared/canonical-json.js';
import { sha256Hex } from '../shared/hash.js';
import type { Store, WorkflowRunRow } from '../store/types.js';
import type { ActivityDefinition } from '../activity/define.js';
import type { StartWorkflowOptions, WorkflowHandle } from './types.js';
import { Workflow } from './workflow.js';
import { getVersion as getVersionImpl } from '../version/get-version.js';

// ── Engine config ──────────────────────────────────────────────────────────

export interface WorkflowEngineOptions {
  store: Store;
  activities?: Record<string, ActivityDefinition<readonly unknown[], unknown>>;
  /** Actor recorded as the default `actor_id` for engine-originated events. */
  defaultActorId?: string;
}

type Constructor<W extends Workflow<unknown, unknown>> = new () => W;

// ── Internal run state ─────────────────────────────────────────────────────

interface SignalWaiter {
  readonly name: string;
  resolve(payload: CanonicalInput): void;
  reject(e: Error): void;
}

interface RunRuntimeState {
  runId: string;
  handle: WorkflowHandle<unknown>;
  settled: Promise<Result<unknown, Error>>;
  signalQueues: Map<string, CanonicalInput[]>;
  signalWaiters: Map<string, SignalWaiter[]>;
  cancelled: boolean;
}

// ── Engine ─────────────────────────────────────────────────────────────────

export class WorkflowEngine {
  private readonly store: Store;
  private readonly activities: Record<string, ActivityDefinition<readonly unknown[], unknown>>;
  private readonly defaultActorId: string;

  private readonly registry = new Map<string, { ctor: Constructor<Workflow>; version: number }>();
  private readonly running = new Map<string, RunRuntimeState>();

  constructor(opts: WorkflowEngineOptions) {
    if (!opts.store) throw new Error('WorkflowEngine: store is required');
    this.store = opts.store;
    this.activities = opts.activities ?? {};
    this.defaultActorId = opts.defaultActorId ?? 'system';
  }

  /**
   * Register a workflow class so it can be started / resumed.
   * Throws on duplicate name with mismatched version.
   */
  register<W extends Workflow<unknown, unknown>>(ctor: Constructor<W>): void {
    const instance = new ctor();
    const existing = this.registry.get(instance.name);
    if (existing && existing.version !== instance.version) {
      throw new Error(
        `WorkflowEngine.register: '${instance.name}' already registered at version ${existing.version}; cannot re-register at version ${instance.version}`,
      );
    }
    this.registry.set(instance.name, {
      ctor: ctor as unknown as Constructor<Workflow>,
      version: instance.version,
    });
  }

  /**
   * Register an activity after construction (optional — engine accepts the
   * activities map up front, but late registration keeps bootstrap flexible).
   */
  registerActivity(name: string, def: ActivityDefinition<readonly unknown[], unknown>): void {
    this.activities[name] = def;
  }

  /** Start a new workflow run or return an existing handle. */
  async start<Args extends CanonicalInput, R>(
    workflowName: string,
    args: Args,
    opts: StartWorkflowOptions = {},
  ): Promise<WorkflowHandle<R>> {
    const entry = this.registry.get(workflowName);
    if (!entry) {
      throw new Error(`WorkflowEngine.start: workflow '${workflowName}' is not registered`);
    }
    const runArgsCanonical = canonicalJSONStrict(args);
    const runArgsHash = sha256Hex(runArgsCanonical);

    const runId = this.deriveRunId(workflowName, runArgsHash, opts);

    const existing = await this.store.runs.get(runId);
    if (existing) {
      if (existing.runArgsHash !== runArgsHash) {
        throw new DuplicateRunIdError(runId);
      }
      if (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'cancelled') {
        return this.handleForCompletedRun<R>(existing);
      }
      const already = this.running.get(runId);
      if (already) return already.handle as WorkflowHandle<R>;
      // Resume the existing run
      return this.resumeRun<Args, R>(workflowName, args, existing);
    }

    // Fresh creation
    await this.store.runs.create({
      runId,
      workflowName,
      workflowVersion: entry.version,
      runArgsHash,
      runArgs: args,
      ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
      ...(opts.parentRunId !== undefined ? { parentRunId: opts.parentRunId } : {}),
    });

    return this.startFreshRun<Args, R>(workflowName, args, runId, opts);
  }

  /**
   * Resume all incomplete workflow runs — call once at app startup.
   */
  async recover(): Promise<{ resumed: number; failed: number }> {
    const incomplete = await this.store.runs.listIncomplete();
    let resumed = 0;
    let failed = 0;
    for (const run of incomplete) {
      try {
        const entry = this.registry.get(run.workflowName);
        if (!entry) {
          failed++;
          continue;
        }
        if (this.running.has(run.runId)) continue; // already in flight
        await this.resumeRun(run.workflowName, run.runArgs, run);
        resumed++;
      } catch {
        failed++;
      }
    }
    return { resumed, failed };
  }

  /** Wait for all in-flight runs to settle, then release resources. */
  async shutdown(): Promise<void> {
    const settles: Array<Promise<unknown>> = [];
    for (const state of this.running.values()) {
      settles.push(state.settled.catch(() => undefined));
    }
    await Promise.allSettled(settles);
  }

  // ── Handle helpers ──────────────────────────────────────────────────────

  private handleForCompletedRun<R>(row: WorkflowRunRow): WorkflowHandle<R> {
    const store = this.store;
    const engine = this;
    return {
      runId: row.runId,
      async result(): Promise<Result<R, Error>> {
        if (row.status === 'completed') {
          const parsed = row.result !== null ? (JSON.parse(row.result) as R) : (undefined as unknown as R);
          return ok(parsed);
        }
        const message = row.error ?? `workflow run ended with status=${row.status}`;
        return err(new Error(message));
      },
      async signal(): Promise<void> {
        throw new Error(`Cannot signal a ${row.status} workflow run`);
      },
      async cancel(reason?: string): Promise<void> {
        void engine;
        void reason;
      },
      async describe(): Promise<WorkflowRunRow> {
        const fresh = await store.runs.get(row.runId);
        return fresh ?? row;
      },
    };
  }

  // ── Run executors ───────────────────────────────────────────────────────

  private startFreshRun<Args extends CanonicalInput, R>(
    workflowName: string,
    args: Args,
    runId: string,
    opts: StartWorkflowOptions,
  ): WorkflowHandle<R> {
    const entry = this.registry.get(workflowName)!;
    const instance = new entry.ctor() as unknown as Workflow<Args, R>;
    return this.runInternal<Args, R>(runId, instance, args, opts, /*isResume*/ false);
  }

  private resumeRun<Args extends CanonicalInput, R>(
    workflowName: string,
    args: Args,
    row: WorkflowRunRow,
  ): WorkflowHandle<R> {
    const entry = this.registry.get(workflowName)!;
    const instance = new entry.ctor() as unknown as Workflow<Args, R>;
    return this.runInternal<Args, R>(
      row.runId,
      instance,
      args,
      {
        ...(row.correlationId !== null ? { correlationId: row.correlationId } : {}),
        ...(row.parentRunId !== null ? { parentRunId: row.parentRunId } : {}),
      },
      /*isResume*/ true,
    );
  }

  private runInternal<Args extends CanonicalInput, R>(
    runId: string,
    workflow: Workflow<Args, R>,
    args: Args,
    opts: StartWorkflowOptions,
    _isResume: boolean,
  ): WorkflowHandle<R> {
    const signalQueues = new Map<string, CanonicalInput[]>();
    const signalWaiters = new Map<string, { name: string; resolve(p: CanonicalInput): void; reject(e: Error): void }[]>();

    const runtimeState: Partial<RunRuntimeState> = {
      runId,
      signalQueues,
      signalWaiters,
      cancelled: false,
    };

    // Mark run as running now
    const settled: Promise<Result<R, Error>> = (async () => {
      await this.store.runs.updateStatus(runId, 'running');
      try {
        const ctx = this.makeContext(runId, workflow, opts);
        const result = await workflow.run(ctx, args);

        // Memoize final result on run
        await this.store.runs.updateStatus(runId, 'completed', {
          result: safeStringify(result),
        });
        return ok(result);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        if (runtimeState.cancelled) {
          await this.store.runs.updateStatus(runId, 'cancelled', { error: error.message });
        } else {
          await this.store.runs.updateStatus(runId, 'failed', { error: error.message });
        }
        return err(error) as Result<R, Error>;
      } finally {
        this.running.delete(runId);
      }
    })();

    const engine = this;
    const handle: WorkflowHandle<R> = {
      runId,
      async result() {
        return settled;
      },
      async signal(name, payload) {
        await engine.deliverSignal(runId, name, payload);
      },
      async cancel(reason?: string) {
        runtimeState.cancelled = true;
        // Drain waiters so run() can observe cancellation
        for (const waiters of signalWaiters.values()) {
          for (const w of waiters) w.reject(new Error(`WorkflowCancelled: ${reason ?? 'no reason'}`));
        }
        signalWaiters.clear();
      },
      async describe() {
        const row = await engine.store.runs.get(runId);
        if (!row) throw new Error(`WorkflowRun ${runId} not found`);
        return row;
      },
    };

    runtimeState.handle = handle as WorkflowHandle<unknown>;
    runtimeState.settled = settled as unknown as Promise<Result<unknown, Error>>;
    this.running.set(runId, runtimeState as RunRuntimeState);
    return handle;
  }

  private makeContext<Args, R>(
    runId: string,
    workflow: Workflow<Args, R>,
    opts: StartWorkflowOptions,
  ): WorkflowContext {
    const actorId = opts.actorId ?? this.defaultActorId;
    let activityCounter = 0;
    const stepsCalled = new Set<string>();
    const store = this.store;
    const activities = this.activities;
    const engine = this;

    const ctx: WorkflowContext = {
      runId,
      name: workflow.name,
      version: workflow.version,

      async step<T>(id: string, fn: () => Promise<T>): Promise<T> {
        if (stepsCalled.has(id)) {
          throw new Error(
            `WorkflowContext.step: duplicate step id '${id}' in run ${runId}. Use ':<n>' suffix for repeated ids.`,
          );
        }
        stepsCalled.add(id);
        const cached = await store.steps.get(runId, id);
        if (cached) {
          if (cached.status === 'completed' && cached.result !== undefined) {
            return JSON.parse(cached.result) as T;
          }
          if (cached.status === 'failed') {
            const message = cached.error ?? `step '${id}' previously failed`;
            throw new Error(`StepPreviouslyFailed: ${message}`);
          }
        }

        const startedAt = Date.now();
        const sequence = stepsCalled.size;
        try {
          const value = await fn();
          await store.steps.put(runId, id, {
            status: 'completed',
            result: safeStringify(value),
            sequence,
            durationMs: Date.now() - startedAt,
            attempt: 1,
          });
          return value;
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          await store.steps.put(runId, id, {
            status: 'failed',
            error: error.message,
            sequence,
            durationMs: Date.now() - startedAt,
            attempt: 1,
          });
          throw error;
        }
      },

      async activity<A extends readonly unknown[], Rt>(name: string, ...args: A): Promise<Rt> {
        const def = activities[name];
        if (!def) {
          throw new Error(`WorkflowContext.activity: no activity '${name}' registered`);
        }
        activityCounter++;
        const activityId = `${runId}:activity:${activityCounter}`;
        const invocation = (await def.invoke({
          workflowRunId: runId,
          activityId,
          input: args as unknown as readonly unknown[],
          actorId,
          ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
        })) as Result<Rt, Error>;
        if (!invocation.ok) {
          throw new ActivityFailedError(name, def.retryPolicy.maximumAttempts || 1, invocation.error);
        }
        return invocation.value;
      },

      async sleep(id: string, ms: number): Promise<void> {
        void id;
        void ms;
        throw new NotImplementedError(
          'WorkflowContext.sleep',
          'Durable timers land in v0.2 (design §12.6). Use setTimeout inside ctx.step() for non-durable delays.',
        );
      },

      async getVersion(key: string, defaultValue: number, currentValue: number): Promise<number> {
        return getVersionImpl({
          store,
          runId,
          key,
          defaultValue,
          currentValue,
          ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
        });
      },

      async signal<T>(name: string): Promise<T> {
        const state = engine.running.get(runId);
        if (!state) {
          throw new Error(`WorkflowContext.signal: run ${runId} not in running set`);
        }
        const queue = state.signalQueues.get(name);
        if (queue && queue.length > 0) {
          const payload = queue.shift()!;
          return payload as T;
        }
        return new Promise<T>((resolve, reject) => {
          const list = state.signalWaiters.get(name) ?? [];
          list.push({
            name,
            resolve: (p) => resolve(p as T),
            reject,
          });
          state.signalWaiters.set(name, list);
        });
      },
    };

    return ctx;
  }

  private async deliverSignal(runId: string, name: string, payload: CanonicalInput): Promise<void> {
    const state = this.running.get(runId);
    if (!state) {
      // Persist a SignalReceived event so a future recovery can observe it.
      await this.store.events.append({
        eventType: 'WorkflowSignalReceived',
        aggregateType: 'Workflow',
        aggregateId: runId,
        actorType: 'external',
        actorId: this.defaultActorId,
        payload: { name, payload },
      });
      return;
    }

    // Append an event for audit
    await this.store.events.append({
      eventType: 'WorkflowSignalReceived',
      aggregateType: 'Workflow',
      aggregateId: runId,
      actorType: 'external',
      actorId: this.defaultActorId,
      payload: { name, payload },
    });

    const waiters = state.signalWaiters.get(name);
    if (waiters && waiters.length > 0) {
      const w = waiters.shift()!;
      w.resolve(payload);
      return;
    }
    const queue = state.signalQueues.get(name) ?? [];
    queue.push(payload);
    state.signalQueues.set(name, queue);
  }

  // ── Internal: run-id derivation (design §6.3) ───────────────────────────

  private deriveRunId(
    workflowName: string,
    runArgsHash: string,
    opts: StartWorkflowOptions,
  ): string {
    if (opts.runId) return opts.runId;
    if (opts.findOrCreate) {
      return 'run-' + sha256Hex(`${workflowName}|${runArgsHash}`).slice(0, 32);
    }
    return 'run-' + randomUUID();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function safeStringify(value: unknown): string {
  if (value === undefined) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}
