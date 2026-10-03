/**
 * What of a batch a caller may see (F3; cross-family review r4 of #403). A batch is its kernel's
 * record, but each slot is also the record of the job it names, and the batch's other data (its
 * runConfig, its sample and batch events) can carry any slot's job. So for every caller except an
 * admin without a tenant (rule.all), who sees everything:
 *
 *   - the batch is judged as it is sent (asSent), so a toJSON or a getter cannot make the checked
 *     and the sent forms differ;
 *   - a slot is kept only when it names at least one job, every job it names (at any depth) is one
 *     the caller may read under the tenant-aware job rule, and its bindings are well formed;
 *   - the batch is "whole" for the caller when no slot was withheld;
 *   - runConfig is kept only when the batch is whole and every job it names is readable; otherwise
 *     it is null and runConfigWithheld is true;
 *   - an event is kept only when every job it names is readable, and then: a sample event (it names
 *     its slot) only when that slot was kept, and a batch-level event only when the batch is whole.
 */
import { asSent, recordBindingsOf } from "./job-read-gate.js";

/** The caller's job rule for a kernel record's parts (jobPartScopeOf). */
export interface JobPartRule {
  all: boolean;
  keep: (jobId: unknown) => boolean;
}

/** The events BatchTracker emits (packages/kernel/src/batch-tracker.ts). */
export const BATCH_EVENT_TYPES: ReadonlySet<string> = new Set([
  "batch_created",
  "sample_added",
  "batch_sealed",
  "batch_started",
  "sample_injection_start",
  "sample_acquisition_start",
  "sample_result_available",
  "sample_completed",
  "batch_completed",
]);

export interface BatchView {
  /** The batch as it is sent, projected for the caller. */
  batch: Record<string, unknown>;
  /** True when the caller sees every slot. */
  whole: boolean;
  /** The ids of the slots kept; null when the caller sees everything. */
  keptSlotIds: ReadonlySet<string> | null;
}

const namesOnlyReadable = (value: unknown, rule: JobPartRule) => {
  const bound = recordBindingsOf(value);
  return !bound.malformed && bound.jobs.every((jobId) => rule.keep(jobId));
};

/**
 * The batch as this caller may see it. `slotFilter` narrows the slots further (a job's buyer, by job,
 * sees only that job's slots). Undefined when the batch does not serialize; it is then not sent.
 */
export function batchViewFor(
  batch: unknown,
  rule: JobPartRule,
  slotFilter: (slot: Record<string, unknown>) => boolean = () => true,
): BatchView | undefined {
  const sent = asSent(batch);
  if (!sent || sent.value === null || typeof sent.value !== "object" || Array.isArray(sent.value)) return undefined;
  const plain = sent.value as Record<string, unknown>;
  if (rule.all) return { batch: plain, whole: true, keptSlotIds: null };
  const slots = Array.isArray(plain.slots) ? (plain.slots as unknown[]) : [];
  const kept = slots.filter((slot): slot is Record<string, unknown> => {
    if (slot === null || typeof slot !== "object" || Array.isArray(slot)) return false;
    const bound = recordBindingsOf(slot);
    return (
      !bound.malformed &&
      bound.jobs.length > 0 &&
      bound.jobs.every((jobId) => rule.keep(jobId)) &&
      slotFilter(slot as Record<string, unknown>)
    );
  });
  const whole = kept.length === slots.length;
  const runConfigShown = whole && namesOnlyReadable(plain.runConfig, rule);
  const projected: Record<string, unknown> = { ...plain, slots: kept, runConfig: runConfigShown ? plain.runConfig : null };
  if (!runConfigShown) projected.runConfigWithheld = true;
  return {
    batch: projected,
    whole,
    keptSlotIds: new Set(kept.map((slot) => slot.id).filter((id): id is string => typeof id === "string")),
  };
}

/** May this caller see this event (as sent) of a batch it was allowed to read? */
export function batchEventVisible(event: unknown, view: BatchView, rule: JobPartRule): boolean {
  if (rule.all) return true;
  if (!namesOnlyReadable(event, rule)) return false;
  if (event === null || typeof event !== "object" || Array.isArray(event)) return true;
  const e = event as { type?: unknown; slotId?: unknown };
  if (typeof e.slotId === "string" && e.slotId !== "") return view.keptSlotIds !== null && view.keptSlotIds.has(e.slotId);
  if (typeof e.type === "string" && BATCH_EVENT_TYPES.has(e.type)) return view.whole;
  // Not a batch event (a sensor reading on the batch's topic): the jobs it names decided above.
  return true;
}
