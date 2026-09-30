/**
 * The Settlement page's view of the gateway's ERC-4337 batch settlement queue:
 * GET /api/settlement/status, GET /api/settlement/epochs and POST /api/settlement/flush.
 *
 * No fixtures (PX-3). The page used to start from invented numbers (7 pending operations,
 * 342 USDC, three epochs with made-up hashes and agents) and kept them whenever a read
 * failed or the gateway had no epochs yet. Now a read that fails is `unavailable` with the
 * gateway's reason, and an empty epoch history is shown as empty.
 */

export interface QueueStatus {
  batchEnabled: boolean;
  pending: number;
  /** USDC base units (6 decimals), as an integer string. */
  totalValue: string;
  oldestAge: number;
  autoFlush: boolean;
  smartAccountAddress: string | null;
}

export type FlushTrigger = "manual" | "size" | "age" | "value";

export interface BatchDetail {
  userOpHash: string;
  operationCount: number;
  trigger: FlushTrigger;
}

export interface EpochSummary {
  epochId: number;
  batches: BatchDetail[];
  totalIntents: number;
  byAgent: Record<string, number>;
  byOperation: Record<string, number>;
  startedAt: number;
  completedAt: number;
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
const isTime = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const FLUSH_TRIGGERS: ReadonlySet<string> = new Set(["manual", "size", "age", "value"]);
const isTrigger = (v: unknown): v is FlushTrigger => typeof v === "string" && FLUSH_TRIGGERS.has(v);
/** An ERC-4337 UserOperation hash from the bundler: 0x + 32 bytes. */
const isUserOpHash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
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
    !isTime(body.oldestAge) ||
    typeof body.autoFlush !== "boolean" ||
    !(body.smartAccountAddress === null || typeof body.smartAccountAddress === "string")
  ) {
    return { state: "unavailable", reason: SHAPE };
  }
  return {
    state: "read",
    value: {
      batchEnabled: body.batchEnabled,
      pending: body.pending as number,
      totalValue: body.totalValue,
      oldestAge: body.oldestAge as number,
      autoFlush: body.autoFlush,
      smartAccountAddress: body.smartAccountAddress as string | null,
    },
  };
}

function isEpoch(e: unknown): e is EpochSummary {
  return (
    isObj(e) &&
    isCount(e.epochId) &&
    Array.isArray(e.batches) &&
    e.batches.every((b) => isObj(b) && typeof b.userOpHash === "string" && isCount(b.operationCount) && typeof b.trigger === "string") &&
    isCount(e.totalIntents) &&
    isObj(e.byAgent) &&
    isObj(e.byOperation) &&
    isTime(e.startedAt) &&
    isTime(e.completedAt)
  );
}

/** An empty history is a real answer (no epoch settled since the gateway started). */
export function epochsFromResponse(httpStatus: number, body: unknown): Read<EpochSummary[]> {
  if (httpStatus < 200 || httpStatus >= 300) return { state: "unavailable", reason: refusalReason(httpStatus, body) };
  if (!isObj(body) || !Array.isArray(body.epochs) || !body.epochs.every(isEpoch)) return { state: "unavailable", reason: SHAPE };
  return { state: "read", value: body.epochs };
}

/**
 * What the page says after a flush: what the gateway reports it flushed, or its refusal (e.g.
 * batch settlement not configured). A flush hands the epoch's operations to the bundler as
 * UserOperations; its answer carries their hashes, not an on-chain receipt, so the page never
 * calls it settled (#313: accepted is not settled). A 2xx body that does not match the flush
 * contract is never assumed accepted — the page cannot say whether anything was flushed, so it
 * fails closed with the same shape message a malformed status/epochs read uses (H1).
 */
export function flushOutcome(httpStatus: number, body: unknown): { ok: boolean; message: string } {
  if (httpStatus < 200 || httpStatus >= 300) return { ok: false, message: refusalReason(httpStatus, body) };
  if (
    isObj(body) &&
    isCount(body.epoch) &&
    isCount(body.totalIntents) &&
    isCount(body.batches) &&
    (body.batchDetails === undefined ||
      (Array.isArray(body.batchDetails) && body.batchDetails.length === body.batches && body.batchDetails.every(isBatchDetail)))
  ) {
    return {
      ok: true,
      message: `The gateway reports epoch ${body.epoch} flushed: ${body.totalIntents} operations in ${body.batches} batch(es).`,
    };
  }
  return { ok: false, message: SHAPE };
}

/** The confirmation a manual flush asks for: how many operations, what a flush does, and that it is final. */
export function flushConfirmation(q: QueueStatus): string {
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
export function epochDetailNote(epochs: Read<EpochSummary[]>): string {
  if (epochs.state === "loading") return "Loading…";
  if (epochs.state === "unavailable") return epochs.reason;
  return epochs.value.length > 0 ? "Click an epoch to see breakdown" : "No epoch to show";
}

/** Exact USDC from base units (6 decimals), at least 2 decimals shown; null for anything but an integer string. */
export function formatUsdcBaseUnits(baseUnits: string): string | null {
  if (!/^\d+$/.test(baseUnits)) return null;
  const v = BigInt(baseUnits);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0{1,4}$/, "");
  return `${whole}.${frac.padEnd(2, "0")}`;
}
