/**
 * N49 F1: the public projection for the SHARED batch stream
 * (/sse/stream/batch/:batchId). That stream fans one payload out to every
 * authenticated subscriber with no per-viewer filtering, so it must carry NO
 * per-sample data (slotId, exact timing, resultHash, resultRef). Only
 * batch-LEVEL events pass, and only their aggregate fields — the same public
 * projection the HTTP batch views use. Per-sample events are available solely
 * through the authenticated, owner-projected HTTP surface (viewEvents).
 *
 * N49 round 5: this runs at the stream boundary (topic-sse.ts), on every event
 * the batch stream delivers, whoever published it. It therefore has to judge any
 * input without throwing: it is total, and it fails closed.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The shared-stream message for a batch event, or null when the event must not
 * be broadcast (any per-sample event, or an unlisted type).
 */
export function projectBatchStreamEvent(event: BatchStreamEventLike): BatchStreamMessage | null {
  // Own keys only: an event type of "constructor" or "__proto__" is not a listed type.
  if (!Object.hasOwn(PUBLIC_BATCH_STREAM_FIELDS, event.type)) return null;
  const fields = PUBLIC_BATCH_STREAM_FIELDS[event.type];
  // A payload that is not an object (a string, an array, nothing) holds no aggregate fields.
  const src = isRecord(event.payload) ? event.payload : {};
  const payload: Record<string, unknown> = { batchId: event.batchId };
  for (const f of fields) {
    const value = Object.hasOwn(src, f) ? src[f] : undefined;
    // An aggregate is a count. A string, an object or a fraction under a listed
    // name is not one, so it is left out rather than broadcast.
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) payload[f] = value;
  }
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    topic: { type: "batch", id: event.batchId },
    payload,
  };
}
