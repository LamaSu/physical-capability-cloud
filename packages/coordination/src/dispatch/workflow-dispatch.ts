/**
 * Workflow dispatch — on approve, dispatch a trivial `@pcc/workflow` run;
 * completion emits an `org.*` event closing the loop. This module owns the
 * ONLY path from "a human approved a queue item" to "something actually
 * runs" — the Brain (brain/supervisor.ts) never calls this directly; it
 * only ever enqueues (see contract (c) below).
 *
 * WHY A SIGNAL, NOT AN INSTANT RETURN: `ApprovedActionWorkflow` performs its
 * one stub step, then durably blocks on {@link ACTION_COMPLETION_SIGNAL}.
 * This vertical slice has no real per-action-type executor wired up (the
 * reaction rule's proposed action is a placeholder `workflowName` + `args`
 * — see reactions/rule-engine.ts), so there is no real external system to
 * report completion yet. Rather than pretend the stub action is
 * instantaneous, the workflow honestly models "dispatched, waiting for the
 * real-world completion source" — the same shape `@pcc/workflow`'s own
 * README example uses (`await ctx.signal('approved')`). A follow-up wires a
 * real completion source (kernel heartbeat, on-chain event, operator
 * confirmation) to call {@link WorkflowDispatcher.acknowledgeCompletion}.
 * This also happens to make "dispatched-but-incomplete" a durable,
 * deterministic state to test against (see
 * src/__tests__/kill-resume.test.ts) rather than a timing race.
 *
 * CONTRACT (c) — Brain -> broker seam: the Brain emits intents into the
 * durable queue (pre-Verdict) and NEVER calls a broker directly for any
 * write/exec/network/credential/settlement action. {@link dispatchViaBroker}
 * (the `WorkflowDispatcherOptions.dispatchViaBroker` seam) is where a real
 * deployment's harness tool-broker would gate this dispatch (action
 * classification, allowlist, audit log — rules/library/security-pipeline.md)
 * BEFORE the local `@pcc/workflow` run starts. No such broker exists inside
 * this vertical slice, so the default implementation ({@link
 * WorkflowDispatcher.localDispatch}) performs the local dispatch directly —
 * the seam is real (swap the option, the call site never changes), just
 * not wired to anything yet.
 *
 * IDEMPOTENCY (the "restart never double-dispatches" requirement): two
 * independent layers, not one:
 *   1. `HumanQueueStore.listApprovedUndispatched()` never returns an item
 *      once `recordDispatch()` has run against it.
 *   2. Even if the process crashes between a successful `engine.start()`
 *      and `recordDispatch()`, `engine.start(..., {findOrCreate:true})`
 *      derives the run id from `(workflowName, canonical(args))`, and args
 *      always embed the queue item id — so a retry after that crash window
 *      finds and RESUMES the same run instead of starting a second one.
 */

import {
  Activity,
  Workflow,
  WorkflowEngine,
  openSqliteStore,
  type WorkflowContext,
  type Store,
  type Result,
} from "@pcc/workflow";

import { HumanQueueStore, type HumanQueueItem } from "../queue/human-queue.js";
import { OrgBus, ORG_SUBJECTS } from "../events/org-bus.js";

export const APPROVED_ACTION_WORKFLOW_NAME = "ApprovedActionWorkflow";
/** Signal name the dispatched workflow durably waits on after its one stub
 *  step. Nothing in this vertical slice sends it automatically — see module
 *  docblock. Tests and any future real completion source deliver it via
 *  {@link WorkflowDispatcher.acknowledgeCompletion}. */
export const ACTION_COMPLETION_SIGNAL = "action-completed";

// `Args` for engine.start<Args extends CanonicalInput, R>() MUST be declared
// with `type X = {...}` — NOT `interface X {...}`. Verified empirically:
// TypeScript's "index signature is missing" check on a CanonicalInput-style
// union member `{ readonly [k: string]: CanonicalInput }` rejects a named
// `interface` (even with only CanonicalInput-compatible properties) but
// accepts a `type` alias object literal. Nested `Record<string, unknown>`
// fields are ALSO rejected (`unknown` isn't a CanonicalInput) — hence
// `argsJson: string` (pre-serialized) instead of a nested args object.
type ApprovedActionArgs = {
  readonly queueItemId: string;
  readonly workflowName: string;
  readonly argsJson: string;
};

export interface ApprovedActionResult {
  queueItemId: string;
  completedAt: string;
  acknowledgedBy?: string;
}

function makePerformActionActivity(store: Store) {
  return Activity.define<readonly [string, string], { performed: true }>({
    name: "perform-approved-action",
    store,
    retryPolicy: { initialIntervalMs: 500, maximumAttempts: 3, nonRetryableErrorPatterns: [] },
    handler: async ([_queueItemId, _argsJson]) => {
      // Stub: no real per-action-type executor exists yet in this slice —
      // see module docblock. The Activity wrapper's own idempotency claim
      // (activity/idempotency-key.ts) already makes even this stub
      // exactly-once per (runId, activityId).
      return { performed: true };
    },
  });
}

class ApprovedActionWorkflow extends Workflow<ApprovedActionArgs, ApprovedActionResult> {
  readonly name = APPROVED_ACTION_WORKFLOW_NAME;
  readonly version = 1;

  async run(ctx: WorkflowContext, args: ApprovedActionArgs): Promise<ApprovedActionResult> {
    await ctx.step("perform-action", () =>
      ctx.activity<readonly [string, string], { performed: true }>(
        "perform-approved-action",
        args.queueItemId,
        args.argsJson,
      ),
    );
    const ack = await ctx.signal<{ acknowledgedBy: string | null }>(ACTION_COMPLETION_SIGNAL);
    return {
      queueItemId: args.queueItemId,
      completedAt: new Date().toISOString(),
      ...(ack.acknowledgedBy !== null ? { acknowledgedBy: ack.acknowledgedBy } : {}),
    };
  }
}

// ── Contract (c) broker seam ───────────────────────────────────────────────

export interface BrokerIntent {
  queueItemId: string;
  action: string;
  args: Record<string, unknown>;
  requiredAuthority: "observe" | "mutate" | "actuate" | "privileged";
}

export type BrokerDispatchFn = (intent: BrokerIntent) => Promise<{ runId: string }>;

// ── Dispatcher ──────────────────────────────────────────────────────────────

export interface WorkflowDispatcherOptions {
  /** Same file path the Brain's HumanQueueStore points at. WAL mode
   *  supports multiple connections to one file — see brain/supervisor.ts
   *  docblock for why this package deliberately shares one file per
   *  deployment rather than accidentally sharing globals. */
  dbPath: string;
  bus?: OrgBus;
  /** Override the contract-(c) broker seam. Defaults to a direct local
   *  `@pcc/workflow` dispatch (see module docblock). */
  dispatchViaBroker?: BrokerDispatchFn;
}

export class WorkflowDispatcher {
  private readonly workflowStore: Store;
  private readonly queue: HumanQueueStore;
  private readonly engine: WorkflowEngine;
  private readonly bus: OrgBus;
  private readonly dispatchViaBroker: BrokerDispatchFn;

  constructor(opts: WorkflowDispatcherOptions) {
    if (!opts.dbPath) throw new Error("WorkflowDispatcher: dbPath is required");
    this.workflowStore = openSqliteStore({ path: opts.dbPath });
    this.queue = new HumanQueueStore({ path: opts.dbPath });
    const performAction = makePerformActionActivity(this.workflowStore);
    this.engine = new WorkflowEngine({
      store: this.workflowStore,
      activities: { "perform-approved-action": performAction },
    });
    this.engine.register(ApprovedActionWorkflow);
    this.bus = opts.bus ?? OrgBus.withInMemoryBackend();
    this.dispatchViaBroker = opts.dispatchViaBroker ?? ((intent) => this.localDispatch(intent));
  }

  /** Resume any incomplete workflow runs from a previous process. Call once
   *  at boot, before `dispatchApproved()`. Safe to call even with nothing to
   *  resume (returns `{resumed: 0, failed: 0}`). */
  async recover(): Promise<{ resumed: number; failed: number }> {
    return this.engine.recover();
  }

  /** Dispatch every approved-but-undispatched queue item. See module
   *  docblock for the two-layer idempotency guarantee. */
  async dispatchApproved(): Promise<Array<{ item: HumanQueueItem; runId: string }>> {
    const approved = this.queue.listApprovedUndispatched();
    const dispatched: Array<{ item: HumanQueueItem; runId: string }> = [];
    for (const item of approved) {
      if (!item.action) continue; // observe-only escalation approved; nothing to dispatch
      const intent: BrokerIntent = {
        queueItemId: item.id,
        action: item.action.workflowName,
        args: item.action.args,
        requiredAuthority: "mutate",
      };
      // eslint-disable-next-line no-await-in-loop -- each dispatch must
      // record before the next begins, or two crash-adjacent items could
      // race on the same tick; sequential is the correct/safe choice here.
      const { runId } = await this.dispatchViaBroker(intent);
      this.queue.recordDispatch(item.id, runId);
      await this.bus.publish(ORG_SUBJECTS.WORKFLOW_DISPATCHED, { queueItemId: item.id, runId });
      dispatched.push({ item, runId });
    }
    return dispatched;
  }

  /** Deliver the completion signal for a dispatched item's workflow run.
   *  Re-derives the same `findOrCreate` args (from the queue item, which
   *  must still carry its original `action`) so this works whether the run
   *  is still in-memory or needs replay-resuming first. */
  async acknowledgeCompletion(queueItemId: string, acknowledgedBy?: string): Promise<void> {
    const item = this.queue.get(queueItemId);
    if (!item || !item.action) {
      throw new Error(`WorkflowDispatcher.acknowledgeCompletion: no dispatchable item ${queueItemId}`);
    }
    const handle = await this.engine.start<ApprovedActionArgs, ApprovedActionResult>(
      APPROVED_ACTION_WORKFLOW_NAME,
      { queueItemId: item.id, workflowName: item.action.workflowName, argsJson: JSON.stringify(item.action.args) },
      { findOrCreate: true },
    );
    await handle.signal(ACTION_COMPLETION_SIGNAL, { acknowledgedBy: acknowledgedBy ?? null });
  }

  /** Default `dispatchViaBroker` — see module docblock "CONTRACT (c)". */
  private async localDispatch(intent: BrokerIntent): Promise<{ runId: string }> {
    const handle = await this.engine.start<ApprovedActionArgs, ApprovedActionResult>(
      APPROVED_ACTION_WORKFLOW_NAME,
      {
        queueItemId: intent.queueItemId,
        workflowName: intent.action,
        argsJson: JSON.stringify(intent.args),
      },
      { findOrCreate: true },
    );
    void handle
      .result()
      .then((result) => this.onWorkflowSettled(intent.queueItemId, handle.runId, result));
    return { runId: handle.runId };
  }

  private async onWorkflowSettled(
    queueItemId: string,
    runId: string,
    result: Result<ApprovedActionResult, Error>,
  ): Promise<void> {
    if (result.ok) {
      this.queue.resolve(queueItemId);
      await this.bus.publish(ORG_SUBJECTS.WORKFLOW_COMPLETED, { queueItemId, runId, result: result.value });
    } else {
      await this.bus.publish(ORG_SUBJECTS.WORKFLOW_COMPLETED, {
        queueItemId,
        runId,
        error: result.error.message,
      });
    }
  }

  close(): void {
    this.queue.close();
    void this.workflowStore.close();
  }
}
