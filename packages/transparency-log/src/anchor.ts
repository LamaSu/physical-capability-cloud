/**
 * Anchor batch composition.
 *
 * Once per period (default: daily), the operator of the transparency
 * log composes an `AnchorPayload` from the current Merkle root and a
 * batch metadata block. That payload is then submitted to
 * `Anchor.sol::anchor(merkleRoot, batchSize)` on Base.
 *
 * The TS side does NOT submit transactions itself — that's the
 * responsibility of a separate anchor-publisher service. This module
 * only handles payload composition + an in-memory store to support
 * `GET /api/anchor/latest` until the on-chain reader is wired in.
 */

import { z } from "zod";

export const AnchorPayloadSchema = z.object({
  /** Hex-encoded Merkle root (no 0x prefix). 32 bytes / 64 hex chars. */
  merkleRoot: z
    .string()
    .length(64)
    .regex(/^[0-9a-fA-F]+$/, "merkleRoot must be 32-byte hex (64 chars)"),
  /** Number of leaves in the tree at the time the anchor was composed. */
  batchSize: z.number().int().nonnegative(),
  /** ISO-8601 UTC timestamp when this anchor was composed. */
  composedAt: z
    .string()
    .min(1)
    .refine((v) => !Number.isNaN(Date.parse(v)), {
      message: "composedAt must be ISO-8601",
    }),
});

export type AnchorPayload = z.infer<typeof AnchorPayloadSchema>;

export const AnchorRecordSchema = AnchorPayloadSchema.extend({
  /** 0-based monotonically increasing index assigned by the anchor store. */
  index: z.number().int().nonnegative(),
  /** On-chain transaction hash (set after submission); null for pending records. */
  txHash: z
    .string()
    .nullable()
    .refine(
      (v) => v === null || /^0x[0-9a-fA-F]{64}$/.test(v),
      "txHash must be 0x-prefixed 32-byte hex or null",
    ),
});

export type AnchorRecord = z.infer<typeof AnchorRecordSchema>;

/**
 * Compose an anchor payload. Pure function — no I/O.
 *
 * @param merkleRoot Hex-encoded current Merkle root (no 0x prefix expected).
 * @param batchSize  Tree size (leaf count) at composition time.
 * @param timestamp  Optional ISO-8601 timestamp; defaults to `now`.
 */
export function composeAnchor(
  merkleRoot: string,
  batchSize: number,
  timestamp?: string,
): AnchorPayload {
  const root = merkleRoot.startsWith("0x") ? merkleRoot.slice(2) : merkleRoot;
  const composedAt = timestamp ?? new Date().toISOString();
  return AnchorPayloadSchema.parse({
    merkleRoot: root.toLowerCase(),
    batchSize,
    composedAt,
  });
}

/**
 * In-memory anchor store. NOT a database — replace with a Postgres
 * adapter (or chain reader) in a future week.
 */
export class InMemoryAnchorStore {
  private records: AnchorRecord[] = [];

  /** Append a fresh anchor; returns the assigned record. */
  append(payload: AnchorPayload, txHash: string | null = null): AnchorRecord {
    const record = AnchorRecordSchema.parse({
      ...payload,
      index: this.records.length,
      txHash,
    });
    this.records.push(record);
    return record;
  }

  /** Most recently appended record, or null if empty. */
  latest(): AnchorRecord | null {
    if (this.records.length === 0) return null;
    return this.records[this.records.length - 1] ?? null;
  }

  /** Random-access by index. Throws on out-of-range. */
  get(index: number): AnchorRecord {
    const r = this.records[index];
    if (!r) {
      throw new RangeError(
        `InMemoryAnchorStore.get: index ${index} out of range [0, ${this.records.length})`,
      );
    }
    return r;
  }

  /** Total number of records stored. */
  size(): number {
    return this.records.length;
  }

  /** Snapshot all records (defensive copy). */
  list(): AnchorRecord[] {
    return [...this.records];
  }

  /** Reset (test/dev convenience). */
  clear(): void {
    this.records = [];
  }
}
