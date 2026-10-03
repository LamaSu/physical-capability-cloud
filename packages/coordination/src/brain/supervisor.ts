/**
 * Brain — the coordination supervisor. An external-scheduler-driven loop
 * (call `tick()` from a cron/setInterval/queue-worker in the consuming app;
 * this package never schedules itself) that:
 *
 *   1. takes a read-only org snapshot (snapshot/facade-snapshot.ts)
 *   2. evaluates reaction rules against it (reactions/rule-engine.ts)
 *   3. enqueues a durable human-queue item for every match (queue/human-queue.ts)
 *   4. publishes org.* events for each step (events/org-bus.ts)
 *
 * DRAFT-FIRST: `tick()` only ever proposes (enqueues). It never dispatches,
 * never calls a broker, never executes a mutate/exec/actuate/privileged
 * action. That is contract (c)'s whole point — see dispatch/workflow-dispatch.ts,
 * which is a SEPARATE unit driven by a human's approval, not by the Brain.
 *
 * KILL SWITCH: either an env var (`PCC_COORDINATION_BRAIN_HALT=1`/`true`) or
 * a sentinel file path. When tripped, `tick()` is a clean no-op — it does not
 * throw, does not touch the snapshot source, does not write to the queue. A
 * process supervisor can flip the env var or touch/remove the sentinel file
 * without restarting anything.
 *
 * OWN SQLITE: the Brain's `dbPath` is a dedicated file for this package,
 * separate from `@pcc/store`'s prod DB and separate from whatever
 * `WORKFLOW_DB_PATH` a gateway/operator-node might use for its own
 * `@pcc/workflow` runs. `dispatch/workflow-dispatch.ts` documents why it
 * points its OWN `@pcc/workflow` store at the SAME file path as this Brain's
 * queue (WAL mode supports multiple connections to one file) — that is a
 * deliberate choice to keep "this deployment's coordination state" in one
 * file, not an accident of shared globals.
 */

import { existsSync } from "node:fs";

import { HumanQueueStore, type HumanQueueItem } from "../queue/human-queue.js";
import { OrgBus, ORG_SUBJECTS } from "../events/org-bus.js";
import { ReactionRuleEngine, staleKernelRule, type ReactionAction } from "../reactions/rule-engine.js";
import {
  StubFacadeSource,
  takeOrgSnapshot,
  type OrgFacadeSource,
  type OrgSnapshot,
} from "../snapshot/facade-snapshot.js";
import { ConsoleAlertChannel, type AlertChannel } from "../alerts/channel.js";

// ── Kill switch ──────────────────────────────────────────────────────────

export const DEFAULT_KILL_SWITCH_ENV_VAR = "PCC_COORDINATION_BRAIN_HALT";

export interface KillSwitchOptions {
  /** Sentinel file: if present, the Brain is halted. Checked on every tick
   *  (not cached), so creating/removing the file takes effect immediately —
   *  no restart needed. Optional; if omitted, only the env var is checked. */
  sentinelPath?: string;
  /** Env var name. Truthy values `'1'` or `'true'` halt the Brain. Default
   *  {@link DEFAULT_KILL_SWITCH_ENV_VAR}. */
  envVar?: string;
}

/** Pure check — no side effects, safe to call every tick. */
export function isKillSwitchTripped(opts: KillSwitchOptions = {}): boolean {
  const envVar = opts.envVar ?? DEFAULT_KILL_SWITCH_ENV_VAR;
  const envVal = process.env[envVar];
  if (envVal === "1" || envVal === "true") return true;
  if (opts.sentinelPath && existsSync(opts.sentinelPath)) return true;
  return false;
}

// ── Brain ────────────────────────────────────────────────────────────────

export interface BrainOptions {
  /** Path to the Brain's own SQLite file. Use a real file path in any
   *  deployment that must survive a restart — ':memory:' only makes sense
   *  for a throwaway single-process test that never simulates a restart. */
  dbPath: string;
  /** Read-only org-state source. Defaults to {@link StubFacadeSource} (no
   *  live gateway wired up yet — see snapshot/facade-snapshot.ts). */
  facadeSource?: OrgFacadeSource;
  /** Org event bus. Defaults to an in-memory backend (single process). */
  bus?: OrgBus;
  /** Reaction rules to evaluate each tick. Defaults to just
   *  {@link staleKernelRule} (the one rule this vertical slice ships). */
  rules?: ReactionRuleEngine;
  /** Where matched-rule alerts are surfaced. Defaults to
   *  {@link ConsoleAlertChannel}. */
  alertChannel?: AlertChannel;
  killSwitch?: KillSwitchOptions;
}

export interface BrainTickResult {
  halted: boolean;
  snapshot: OrgSnapshot | null;
  /** Every item newly enqueued this tick (draft proposals — nothing here
   *  has been approved or dispatched). */
  enqueued: HumanQueueItem[];
}

function defaultReactionRuleEngine(): ReactionRuleEngine {
  const engine = new ReactionRuleEngine();
  engine.register(staleKernelRule);
  return engine;
}

/** Severities that also raise an immediate alert, independent of the
 *  durable queue (the queue is for approval workflows; alerts are for
 *  "a human should notice this right now"). */
const ALERT_ON_SEVERITY = new Set<ReactionAction["severity"]>(["critical", "high"]);

export class Brain {
  readonly queue: HumanQueueStore;
  readonly bus: OrgBus;
  readonly rules: ReactionRuleEngine;
  private readonly facadeSource: OrgFacadeSource;
  private readonly alerts: AlertChannel;
  private readonly killSwitchOpts: KillSwitchOptions;

  constructor(opts: BrainOptions) {
    if (!opts.dbPath) throw new Error("Brain: dbPath is required");
    this.queue = new HumanQueueStore({ path: opts.dbPath });
    this.bus = opts.bus ?? OrgBus.withInMemoryBackend();
    this.rules = opts.rules ?? defaultReactionRuleEngine();
    this.facadeSource = opts.facadeSource ?? new StubFacadeSource();
    this.alerts = opts.alertChannel ?? new ConsoleAlertChannel({ prefix: "brain" });
    this.killSwitchOpts = opts.killSwitch ?? {};
  }

  isHalted(): boolean {
    return isKillSwitchTripped(this.killSwitchOpts);
  }

  /**
   * One external-scheduler-driven cycle: snapshot -> evaluate reactions ->
   * enqueue (draft-first). Never dispatches, never mutates org state.
   * Clean no-op when the kill switch is tripped.
   */
  async tick(): Promise<BrainTickResult> {
    if (this.isHalted()) {
      return { halted: true, snapshot: null, enqueued: [] };
    }

    const snapshot = await takeOrgSnapshot(this.facadeSource);
    await this.bus.publish(ORG_SUBJECTS.SNAPSHOT_TAKEN, snapshot);

    const actions = this.rules.evaluate({ snapshot });
    const enqueued: HumanQueueItem[] = [];
    for (const action of actions) {
      const item = this.queue.enqueue(action);
      enqueued.push(item);
      await this.bus.publish(ORG_SUBJECTS.QUEUE_ITEM_ENQUEUED, item);
      if (ALERT_ON_SEVERITY.has(action.severity)) {
        await this.alerts.send({
          severity: action.severity,
          title: action.title,
          details: action.details,
          at: item.createdAt,
        });
      }
    }
    return { halted: false, snapshot, enqueued };
  }

  /** Release this Brain's SQLite connection. Does NOT close the bus — the
   *  bus may be shared with other components (e.g. a watch/SSE consumer)
   *  that outlive one Brain instance; callers that own the bus close it
   *  themselves. */
  close(): void {
    this.queue.close();
  }
}
