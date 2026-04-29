/**
 * Schemas + types for the centralized escrow ledger.
 *
 * Conventions:
 *  - All amounts are integer cents to avoid floating-point drift.
 *  - All identifiers are opaque strings (UUIDs upstream).
 *  - Timestamps are ISO-8601 UTC strings.
 */

import { z } from "zod";

// Actor: the smallest unit the ledger transacts on. A user, an operator,
// or a session-scoped escrow account can all participate as actors.
export const ActorSchema = z.object({
  id: z.string().min(1),
  /** Free-form classifier — "user", "operator", "escrow", "fee", etc. */
  kind: z.string().min(1),
});
export type Actor = z.infer<typeof ActorSchema>;

export const AmountSchema = z
  .number()
  .int("amounts must be integer cents")
  .nonnegative("amounts cannot be negative");
export type Amount = z.infer<typeof AmountSchema>;

/**
 * Session lifecycle, deliberately mirrored from the centralized state
 * machine in `state-machine.ts`. Duplicated here so consumers that only
 * pull `types` get the union without a circular import.
 */
export const SessionStateSchema = z.enum([
  "created",
  "configuring",
  "quoted",
  "reviewing",
  "committed",
  "executing",
  "settled",
  "cancelled",
  "disputed",
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * Session: minimal record the ledger needs. The full session record (with
 * scheduling, capability, etc.) lives elsewhere; this schema only models
 * the fields the ledger reasons about.
 */
export const SessionSchema = z.object({
  id: z.string().min(1),
  state: SessionStateSchema,
  user: ActorSchema,
  operator: ActorSchema,
  amountCents: AmountSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /** Optional metadata blob; the ledger does not introspect it. */
  metadata: z.record(z.unknown()).optional(),
});
export type Session = z.infer<typeof SessionSchema>;

/** Ledger entry: one atomic accounting line. */
export const LedgerEntryKindSchema = z.enum([
  "deposit",
  "lock",
  "release",
  "refund",
  "withdrawal",
]);
export type LedgerEntryKind = z.infer<typeof LedgerEntryKindSchema>;

export const LedgerEntrySchema = z.object({
  id: z.string().min(1),
  kind: LedgerEntryKindSchema,
  /** Account being credited (positive flow into). */
  to: z.string().min(1),
  /** Account being debited (positive flow out of). null for an external deposit. */
  from: z.string().nullable(),
  amountCents: AmountSchema,
  /** Optional session this entry pertains to. */
  sessionId: z.string().nullable(),
  /** ISO-8601 UTC timestamp. */
  at: z.string().min(1),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** Receipts returned by ledger operations. */
export interface LockReceipt {
  entry: LedgerEntry;
  newBalance: { from: number; escrow: number };
}

export interface ReleaseReceipt {
  entry: LedgerEntry;
  newBalance: { escrow: number; to: number };
}

export interface RefundReceipt {
  entry: LedgerEntry;
  newBalance: { escrow: number; to: number };
}
