/**
 * What of a batch a caller may see (F3; cross-family reviews r4 and r5 of #403). A batch is its
 * kernel's record, but each slot is also the record of the job the LIVE batch holds for it, and the
 * batch's other data (its runConfig, its batch-level events) can carry any slot's job. So:
 *
 *   - the batch is sent as a typed projection of the live batch: its own fields and each slot's,
 *     from the spec types, each read once and kept only when it is a string, so no toJSON, getter
 *     or field outside the spec reaches the caller, and what is judged is what is sent;
 *   - a slot is kept only when the caller may read its live job under the tenant-aware job rule;
 *     an admin without a tenant (rule.all) sees every slot;
 *   - the batch is "whole" for the caller when no slot was withheld;
 *   - runConfig is kept only when the batch is whole and the caller may read every job that owns
 *     it (recordOwnersOf); otherwise it is null and runConfigWithheld is true;
 *   - an event is kept only when the caller may read every job that owns it (recordOwnersOf with
 *     the batch's id): a sample event is its slot's live job's, and an event that names none of
 *     the batch's slots is the batch's, owned by every job of the batch.
 */
import type { BatchManifest } from "@pcc/spec";
import { asSent, recordOwnersOf } from "./job-read-gate.js";

/** The caller's job rule for a kernel record's parts (jobPartScopeOf). */
export interface JobPartRule {
  all: boolean;
  keep: (jobId: unknown) => boolean;
}

/** The batch's fields a caller may be sent (BatchManifest), slots and runConfig apart. */
const BATCH_FIELDS = ["id", "kernelId", "deviceId", "capabilityId", "status", "sealedAt", "startedAt", "completedAt", "methodId"] as const;

/** A slot's fields a caller may be sent (SampleSlot). */
const SLOT_FIELDS = [
  "id", "position", "jobId", "stepId", "userId", "sampleLabel", "sampleType", "status",
  "acquisitionStart", "acquisitionEnd", "resultHash", "resultRef",
] as const;

export interface BatchView {
  /** The batch as it is sent to this caller. */
  batch: Record<string, unknown>;
  /** True when the caller sees every slot. */
  whole: boolean;
}

/** The string fields of a live record, each read once. Undefined when it is not an object or a read throws. */
function typedFields(live: unknown, fields: readonly string[]): Record<string, string> | undefined {
  if (live === null || typeof live !== "object" || Array.isArray(live)) return undefined;
  const out: Record<string, string> = {};
  try {
    for (const field of fields) {
      const value = (live as Record<string, unknown>)[field];
      if (typeof value === "string") out[field] = value;
    }
  } catch {
    return undefined;
  }
  return out;
}

const ownersReadable = (record: unknown, rule: JobPartRule, ctx: { batchId?: string } = {}) => {
  const owners = recordOwnersOf(record, ctx);
  return owners !== undefined && owners.jobs.every((jobId) => rule.keep(jobId));
};

/**
 * The live batch as this caller may see it. `slotFilter` narrows the slots further (a job's buyer,
 * by job, sees only that job's slots). Undefined when there is no batch or it has no id.
 */
export function batchViewFor(
  batch: BatchManifest | undefined,
  rule: JobPartRule,
  slotFilter: (slot: Readonly<Record<string, string>>) => boolean = () => true,
): BatchView | undefined {
  const head = typedFields(batch, BATCH_FIELDS);
  if (!batch || !head || !head.id) return undefined;
  let liveSlots: unknown;
  let liveConfig: unknown;
  try {
    liveSlots = batch.slots;
    liveConfig = batch.runConfig;
  } catch {
    return undefined;
  }
  const slots: Record<string, string>[] = [];
  let whole = true;
  for (const live of Array.isArray(liveSlots) ? liveSlots : []) {
    const slot = typedFields(live, SLOT_FIELDS);
    const owned = slot?.jobId !== undefined && slot.jobId.trim() !== "";
    if (slot && (rule.all || (owned && rule.keep(slot.jobId))) && slotFilter(slot)) slots.push(slot);
    else whole = false;
  }
  const config = asSent(liveConfig);
  const shown = config !== undefined && (rule.all || (whole && ownersReadable(config.value, rule)));
  const projected: Record<string, unknown> = { ...head, slots, runConfig: shown ? config.value : null };
  if (!shown && liveConfig !== undefined && liveConfig !== null) projected.runConfigWithheld = true;
  return { batch: projected, whole };
}

/** May this caller see this event (as sent) of the batch `batchId`? */
export function batchEventVisible(event: unknown, batchId: string, rule: JobPartRule): boolean {
  return rule.all || ownersReadable(event, rule, { batchId });
}
