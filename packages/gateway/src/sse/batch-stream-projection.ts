/**
 * N49 F1: the public projection for the SHARED batch stream
 * (/sse/stream/batch/:batchId). That stream fans one payload out to every
 * authenticated subscriber with no per-viewer filtering, so it must carry NO
 * per-sample data (slotId, exact timing, resultHash, resultRef). Only
 * batch-LEVEL events pass, and only their aggregate fields — the same public
 * projection the HTTP batch views use. Per-sample events are available solely
 * through the authenticated, owner-projected HTTP surface (viewEvents).
 *
 * Pure and side-effect free, so it is unit-tested directly.
 */

/** Aggregate fields that may go out on the shared stream, per batch-level type. */
export const PUBLIC_BATCH_STREAM_FIELDS: Record<string, readonly string[]> = {
  batch_sealed: ["slotCount"],
  batch_completed: ["completed", "failed"],
};

export interface BatchStreamEventLike {
  id?: string;
  type: string;
  timestamp?: string;
  batchId: string;
  payload?: Record<string, unknown> | unknown;
}

export interface BatchStreamMessage {
  id?: string;
  type: string;
  timestamp?: string;
  topic: { type: "batch"; id: string };
  payload: Record<string, unknown>;
}

/**
 * The shared-stream message for a batch event, or null when the event must not
 * be broadcast (any per-sample event, or an unlisted type).
 */
export function projectBatchStreamEvent(event: BatchStreamEventLike): BatchStreamMessage | null {
  const fields = PUBLIC_BATCH_STREAM_FIELDS[event.type];
  if (!fields) return null;
  const src = (event.payload ?? {}) as Record<string, unknown>;
  const payload: Record<string, unknown> = { batchId: event.batchId };
  for (const f of fields) if (f in src) payload[f] = src[f];
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    topic: { type: "batch", id: event.batchId },
    payload,
  };
}
