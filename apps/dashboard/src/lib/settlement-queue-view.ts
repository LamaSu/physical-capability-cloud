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

export interface BatchDetail {
  userOpHash: string;
  operationCount: number;
  trigger: string;
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
const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isTime = (v: unknown) => typeof v === "number" && Number.isFinite(v);

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

/** What the page says after a flush: the settled epoch, or the gateway's refusal (e.g. batch settlement not configured). */
export function flushOutcome(httpStatus: number, body: unknown): { ok: boolean; message: string } {
  if (httpStatus < 200 || httpStatus >= 300) return { ok: false, message: refusalReason(httpStatus, body) };
  if (isObj(body) && isCount(body.epoch) && isCount(body.totalIntents) && isCount(body.batches)) {
    return { ok: true, message: `Settled epoch ${body.epoch}: ${body.totalIntents} operations in ${body.batches} batch(es).` };
  }
  return { ok: true, message: "The gateway accepted the flush." };
}

/** Exact USDC from base units (6 decimals), at least 2 decimals shown; null for anything but an integer string. */
export function formatUsdcBaseUnits(baseUnits: string): string | null {
  if (!/^\d+$/.test(baseUnits)) return null;
  const v = BigInt(baseUnits);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0{1,4}$/, "");
  return `${whole}.${frac.padEnd(2, "0")}`;
}
