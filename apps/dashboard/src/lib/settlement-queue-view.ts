/**
 * The Settlement page's view of the gateway's ERC-4337 batch settlement queue:
 * GET /api/settlement/status, GET /api/settlement/epochs and POST /api/settlement/flush.
 *
 * No fixtures (PX-3). The page used to start from invented numbers (7 pending operations,
 * 342 USDC, three epochs with made-up hashes and agents) and kept them whenever a read
 * failed or the gateway had no epochs yet. Now a read that fails is `unavailable` with the
 * gateway's reason, and an empty epoch history is shown as empty.
 */

import { isAddress } from "viem";

export interface QueueStatus {
  batchEnabled: boolean;
  pending: number;
  /** USDC base units (6 decimals), as an integer string. */
  totalValue: string;
  /**
   * How long the oldest pending operation has waited, in ms. Null when the gateway's clock moved
   * back since it was queued (its age came out negative): the age is then not known (M4).
   */
  oldestAge: number | null;
  /** True when the gateway's answer shows its clock moved back (a negative age). */
  clockAdjusted: boolean;
  autoFlush: boolean;
  smartAccountAddress: string | null;
}

export type FlushTrigger = "manual" | "size" | "age" | "value";

export interface BatchDetail {
  userOpHash: string;
  operationCount: number;
  trigger: FlushTrigger;
}

/** An epoch as the gateway reports it (GET /api/settlement/epochs). */
export interface EpochRecord {
  epochId: number;
  batches: BatchDetail[];
  totalIntents: number;
  byAgent: Record<string, number>;
  byOperation: Record<string, number>;
  startedAt: number;
  completedAt: number;
}

/**
 * An epoch as the page shows it: the record, and its duration when the clock gives one. The
 * bundler stamps both times with Date.now(), so a clock that moved back can make an epoch end
 * "before" it started: then durationMs is null and clockAdjusted is true (M4), and the epoch is
 * still shown.
 */
export interface EpochSummary extends EpochRecord {
  durationMs: number | null;
  clockAdjusted: boolean;
}

export type Read<T> = { state: "loading" } | { state: "read"; value: T } | { state: "unavailable"; reason: string };

export const LOADING = { state: "loading" } as const;

/** What the page says when a request never got an answer. */
export const UNREACHABLE_REASON = "The gateway could not be reached.";
export const UNREACHABLE: Read<never> = { state: "unavailable", reason: UNREACHABLE_REASON };

const SHAPE = "The gateway's answer did not have the expected shape.";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** A count the page can safely display or sum: a non-negative integer within Number's safe range. */
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** The largest time a Date can hold, in ms (ECMAScript: 8.64e15). */
const MAX_DATE_MS = 8.64e15;
/** A time the bundler stamps with Date.now(), or an age measured from one: whole milliseconds,
 * non-negative, and no later than a Date can hold. */
const isTime = (v: unknown): v is number => isCount(v) && v <= MAX_DATE_MS;
/** An age the gateway computed as Date.now() minus a stamp: negative only when its clock moved back. */
const isSignedAge = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= -MAX_DATE_MS && v <= MAX_DATE_MS;
/** A record of per-key counts (byAgent / byOperation): every value is itself a safe count. */
const isCountRecord = (v: unknown): v is Record<string, number> => isObj(v) && Object.values(v).every(isCount);
const FLUSH_TRIGGERS: ReadonlySet<string> = new Set(["manual", "size", "age", "value"]);
const isTrigger = (v: unknown): v is FlushTrigger => typeof v === "string" && FLUSH_TRIGGERS.has(v);
/** An ERC-4337 UserOperation hash from the bundler: 0x + 32 bytes. */
const isUserOpHash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
/** The gateway's own smart-account address shape (a real address, checksum not required). */
const isSmartAccountAddress = (v: unknown): v is string => typeof v === "string" && isAddress(v, { strict: false });
const isBatchDetail = (b: unknown): b is BatchDetail =>
  isObj(b) && isUserOpHash(b.userOpHash) && isCount(b.operationCount) && isTrigger(b.trigger);

/** The refusal's own message when it has one, else the HTTP status. */
function refusalReason(httpStatus: number, body: unknown): string {
  return isObj(body) && typeof body.message === "string" && body.message.trim() !== ""
    ? body.message
    : `The gateway answered HTTP ${httpStatus}.`;
}

export function statusFromResponse(httpStatus: number, body: unknown): Read<QueueStatus> {
  if (httpStatus < 200 || httpStatus >= 300) return { state: "unavailable", reason: refusalReason(httpStatus, body) };
  if (
    !isObj(body) ||
    typeof body.batchEnabled !== "boolean" ||
    !isCount(body.pending) ||
    typeof body.totalValue !== "string" ||
    !/^\d+$/.test(body.totalValue) ||
    !isSignedAge(body.oldestAge) ||
    typeof body.autoFlush !== "boolean" ||
    !(body.smartAccountAddress === null || isSmartAccountAddress(body.smartAccountAddress))
  ) {
    return { state: "unavailable", reason: SHAPE };
  }
  return {
    state: "read",
    value: {
      batchEnabled: body.batchEnabled,
      pending: body.pending as number,
      totalValue: body.totalValue,
      oldestAge: (body.oldestAge as number) >= 0 ? (body.oldestAge as number) : null,
      clockAdjusted: (body.oldestAge as number) < 0,
      autoFlush: body.autoFlush,
      smartAccountAddress: body.smartAccountAddress as string | null,
    },
  };
}

function isEpoch(e: unknown): e is EpochRecord {
  return (
    isObj(e) &&
    isCount(e.epochId) &&
    Array.isArray(e.batches) &&
    e.batches.every(isBatchDetail) &&
    isCount(e.totalIntents) &&
    isCountRecord(e.byAgent) &&
    isCountRecord(e.byOperation) &&
    isTime(e.startedAt) &&
    isTime(e.completedAt)
  );
}

/** The epoch as the page shows it: an end before the start is a clock that moved back (M4). */
function epochView(e: EpochRecord): EpochSummary {
  const clockAdjusted = e.completedAt < e.startedAt;
  return {
    epochId: e.epochId,
    batches: e.batches,
    totalIntents: e.totalIntents,
    byAgent: e.byAgent,
    byOperation: e.byOperation,
    startedAt: e.startedAt,
    completedAt: e.completedAt,
    durationMs: clockAdjusted ? null : e.completedAt - e.startedAt,
    clockAdjusted,
  };
}

/**
 * Operations per UserOperation across the epochs: the batches' own operationCount over the number
 * of batches. An epoch with no batch adds nothing (summing epochs' totalIntents counted operations
 * that no batch carried). Null when there is no batch at all: no average, never zero.
 */
export function averageOpsPerBatch<E extends Pick<EpochRecord, "batches">>(epochs: readonly E[]): number | null {
  let ops = 0;
  let batches = 0;
  for (const e of epochs) {
    for (const b of e.batches) {
      ops += b.operationCount;
      batches++;
    }
  }
  return batches === 0 ? null : Math.round(ops / batches);
}

/**
 * The operations the epochs' UserOperations carried: the sum of their batches' operationCount
 * (M3). An epoch's totalIntents counts the intents it settled, and an epoch with no batch carried
 * none of them in a UserOperation, so it adds nothing here.
 */
export function operationsInBatches<E extends Pick<EpochRecord, "batches">>(epochs: readonly E[]): number {
  let ops = 0;
  for (const e of epochs) for (const b of e.batches) ops += b.operationCount;
  return ops;
}

/** An empty history is a real answer (no epoch settled since the gateway started). */
export function epochsFromResponse(httpStatus: number, body: unknown): Read<EpochSummary[]> {
  if (httpStatus < 200 || httpStatus >= 300) return { state: "unavailable", reason: refusalReason(httpStatus, body) };
  if (!isObj(body) || !Array.isArray(body.epochs) || !body.epochs.every(isEpoch)) return { state: "unavailable", reason: SHAPE };
  return { state: "read", value: (body.epochs as EpochRecord[]).map(epochView) };
}

/**
 * What the page says after a flush: what the gateway reports it flushed, or its refusal (e.g.
 * batch settlement not configured). A flush hands the epoch's operations to the bundler as
 * UserOperations; its answer carries their hashes, not an on-chain receipt, so the page never
 * calls it settled (#313: accepted is not settled). A 2xx body that does not match the flush
 * contract is never assumed accepted — the page cannot say whether anything was flushed, so it
 * fails closed with the same shape message a malformed status/epochs read uses (H1; r2: every
 * member the route sends is required, not only the counts).
 */
export function flushOutcome(httpStatus: number, body: unknown): { ok: boolean; message: string } {
  if (httpStatus < 200 || httpStatus >= 300) return { ok: false, message: refusalReason(httpStatus, body) };
  // Every member the route always sends must be there and well formed (review r2 of #425, H1):
  // batchDetails (one per batch), byAgent, byOperation and duration. A duration is a signed ms
  // count: the bundler stamps both ends with Date.now(), so a clock that moved back makes it
  // negative (M4).
  if (
    isObj(body) &&
    isCount(body.epoch) &&
    isCount(body.totalIntents) &&
    isCount(body.batches) &&
    Array.isArray(body.batchDetails) &&
    body.batchDetails.length === body.batches &&
    body.batchDetails.every(isBatchDetail) &&
    isCountRecord(body.byAgent) &&
    isCountRecord(body.byOperation) &&
    typeof body.duration === "number" &&
    Number.isSafeInteger(body.duration)
  ) {
    return {
      ok: true,
      message: `The gateway reports epoch ${body.epoch} flushed: ${body.totalIntents} operations in ${body.batches} batch(es).`,
    };
  }
  return { ok: false, message: SHAPE };
}

/** The confirmation a manual flush asks for: how many operations, what a flush does, and that it is final. */
export function flushConfirmation(q: Pick<QueueStatus, "pending">): string {
  const ops = `${q.pending} pending operation${q.pending === 1 ? "" : "s"}`;
  return (
    `Flush ${ops} now? The gateway submits them to the bundler as batched ERC-4337 UserOperations ` +
    "that act on escrow. A flush cannot be recalled once sent."
  );
}

export type BadgeColor = "teal" | "gold" | "gray";

/**
 * The epoch-list trigger badge: the first batch's trigger, colored — never an invented trigger
 * for an epoch with no batches (M3). A manual flush of an empty queue is a valid epoch (the
 * gateway can produce `batches: []`); it is shown as "no batches" with no trigger, not "manual".
 */
export function triggerBadge(epoch: Pick<EpochSummary, "batches">): { label: string; color: BadgeColor } {
  const trigger = epoch.batches[0]?.trigger;
  if (trigger === undefined) return { label: "no batches", color: "gray" };
  if (trigger === "size") return { label: trigger, color: "teal" };
  if (trigger === "value") return { label: trigger, color: "gold" };
  return { label: trigger, color: "gray" };
}

/**
 * What the epoch-detail panel says when nothing is selected: the read's own reason when the
 * epoch history is not a real answer yet (loading or unavailable — M2), "no epoch" only for a
 * real, empty answer, else a prompt to pick one. A failed or loading read must never look like
 * an empty history.
 */
export function epochDetailNote(epochs: Read<readonly unknown[]>): string {
  if (epochs.state === "loading") return "Loading…";
  if (epochs.state === "unavailable") return epochs.reason;
  return epochs.value.length > 0 ? "Click an epoch to see breakdown" : "No epoch to show";
}

export interface FlushControllerDeps<T> {
  /** Send the flush request and resolve its outcome (never expected to reject in normal use;
   * a rejection — e.g. the fetch itself throwing — is still handled, see onError). */
  post: () => Promise<T>;
  /** The authoritative reload: re-fetch queue status and epoch history after a flush. */
  reload: () => Promise<void>;
  onResult: (result: T) => void;
  onError: (error: unknown) => void;
  /** The authoritative reload failed after a flush (review r2 of #425, M5): say so, never throw. */
  onReloadError: (error: unknown) => void;
  onFlushingChange: (flushing: boolean) => void;
}

export interface FlushController {
  isFlushing: () => boolean;
  /** Attempt a flush. Resolves false without calling `post` if one is already in flight
   * (including its reload) — the synchronous in-flight guard (M5). */
  confirmFlush: () => Promise<boolean>;
}

/**
 * A framework-free controller for the manual-flush flow (M5). Two problems in the old
 * page-level handler: (1) `flushing` was cleared in a `finally` BEFORE awaiting the reload, so
 * `canFlush` was briefly recomputed from the stale, pre-flush queue status — long enough for a
 * second confirm to send a second POST while the first flush's authoritative reload was still
 * in flight; (2) there was no reentrancy guard other than that same (buggy) `flushing` state.
 * This controller sets an in-flight flag SYNCHRONOUSLY before any await, and only clears it
 * after the reload settles — success or failure — so a second confirmFlush() at any point
 * before the reload finishes is a same-tick no-op.
 */
export function createFlushController<T>(deps: FlushControllerDeps<T>): FlushController {
  let flushing = false;
  return {
    isFlushing: () => flushing,
    async confirmFlush() {
      if (flushing) return false;
      flushing = true;
      deps.onFlushingChange(true);
      try {
        deps.onResult(await deps.post());
      } catch (err) {
        deps.onError(err);
      }
      // A failed reload is reported, and the guard still clears: confirmFlush never rejects, so a
      // caller that does not await it leaves no unhandled rejection (review r2 of #425, M5).
      try {
        await deps.reload();
      } catch (err) {
        deps.onReloadError(err);
      } finally {
        flushing = false;
        deps.onFlushingChange(false);
      }
      return true;
    },
  };
}

/** Exact USDC from base units (6 decimals), at least 2 decimals shown; null for anything but an integer string. */
export function formatUsdcBaseUnits(baseUnits: string): string | null {
  if (!/^\d+$/.test(baseUnits)) return null;
  const v = BigInt(baseUnits);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0{1,4}$/, "");
  return `${whole}.${frac.padEnd(2, "0")}`;
}
