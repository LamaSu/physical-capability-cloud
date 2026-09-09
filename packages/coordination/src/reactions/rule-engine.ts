/**
 * Reaction rule engine — a minimal declarative `{ match(event) -> action }`
 * registry. Rules observe an `OrgSnapshot` and, when matched, produce a
 * proposed `HumanQueueEnqueueInput` — never an executed action. The Brain
 * supervisor is what turns "matched" into "written to the queue"; rules
 * themselves have no side effects.
 */

import type { OrgSnapshot } from "../snapshot/facade-snapshot.js";
import type { HumanQueueEnqueueInput } from "../queue/human-queue.js";

export interface ReactionContext {
  snapshot: OrgSnapshot;
}

/** What a matched rule proposes — shape-compatible with the human queue's
 *  enqueue input so the supervisor can pass it straight through. */
export type ReactionAction = HumanQueueEnqueueInput;

export interface ReactionRule {
  name: string;
  match(ctx: ReactionContext): boolean;
  action(ctx: ReactionContext): ReactionAction;
}

/** The one concrete rule for this slice: a stale kernel heartbeat proposes a
 *  human-queue item. "Stale" mirrors the gateway's own KernelDTO.isStale
 *  semantics (heartbeat >5min old while online — see root CLAUDE.md §5). */
export const staleKernelRule: ReactionRule = {
  name: "stale-kernel-detected",
  match: (ctx) => ctx.snapshot.staleKernelCount > 0,
  action: (ctx) => ({
    severity: "medium",
    category: "network_issue",
    title: `${ctx.snapshot.staleKernelCount} kernel(s) have a stale heartbeat`,
    details:
      `Snapshot at ${ctx.snapshot.takenAt} found ${ctx.snapshot.staleKernelCount} ` +
      `stale kernel(s) out of ${ctx.snapshot.kernels.length} total.`,
    suggestedFix: "Check kernel connectivity / heartbeat cadence for the affected kernel(s).",
  }),
};

export class ReactionRuleEngine {
  private readonly rules: ReactionRule[] = [];

  register(rule: ReactionRule): void {
    this.rules.push(rule);
  }

  /** Returns one proposed action per matched rule, in registration order. */
  evaluate(ctx: ReactionContext): ReactionAction[] {
    return this.rules.filter((r) => r.match(ctx)).map((r) => r.action(ctx));
  }

  list(): readonly ReactionRule[] {
    return this.rules;
  }
}
