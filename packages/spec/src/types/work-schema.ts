/**
 * WorkSchema — Primitive 1 of RFC-001-work-primitives.
 *
 * A WorkSchema declares the evidence vocabulary a Capability uses. Replaces
 * the closed `EvidenceEventType` enum (in evidence.ts) with a per-Capability,
 * content-addressed schema bundle.
 *
 * It names every event type this job emits, gives a JSON Schema for each
 * type's `payload`, and lists the WorkProduct kinds the Capability may
 * produce. Sealed in the Capability's CSD, referenced by `schemaHash`
 * everywhere downstream.
 *
 * Hash discipline:
 *   schemaHash = sha256(canonical_json({
 *     version,
 *     eventTypes: sortedByKey("id", eventTypes),
 *     workProducts: sortedByKey("kind", workProducts),
 *   }))
 *
 * `label`, `notes`, `publishedAt` are NOT in the canonical hash — they are
 * metadata. Mirrors the same convention used by RateSchedule.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "../util/canonical.js";

/** AssuranceTier zod schema. Inlined here because common.ts only exports
 *  the TS union type, not a runtime schema. Must match `AssuranceTier`
 *  in common.ts: 0 | 1 | 2 | 3. */
const AssuranceTierSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

// ---------------------------------------------------------------------------
// JSON Schema (Draft-7 minimal subset that JsonSchema7 supports as `unknown`).
// We intentionally do NOT validate the JSON Schema's own shape here — it's
// the publisher's responsibility, and consumer evaluators are tolerant.
// ---------------------------------------------------------------------------

export const JSONSchemaSchema = z.record(z.unknown());
export type JSONSchema = z.infer<typeof JSONSchemaSchema>;

// ---------------------------------------------------------------------------
// Per-event-type definition
// ---------------------------------------------------------------------------

export const WorkEventTypeDefSchema = z.object({
  /** Lowercase snake_case identifier, scoped to this WorkSchema. */
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "must be lowercase snake_case"),
  /** One-line human description. */
  description: z.string().max(280),
  /** JSON Schema for the event's payload field. */
  payloadSchema: JSONSchemaSchema,
  /** Which AssuranceTiers may use this event type. */
  validTiers: z.array(AssuranceTierSchema).min(1),
  /**
   * If true, payload values must be appendable / monotonic over the job —
   * used for cumulative measures (energy_kwh, harvest_weight_kg). Catches
   * double-count bugs deterministically.
   */
  monotonic: z.boolean().optional(),
});
export type WorkEventTypeDef = z.infer<typeof WorkEventTypeDefSchema>;

// ---------------------------------------------------------------------------
// Per-work-product-kind definition
// ---------------------------------------------------------------------------

export const WorkProductKindSchema = z.enum([
  "physical",
  "digital",
  "service",
  "bilateral",
]);
export type WorkProductKind = z.infer<typeof WorkProductKindSchema>;

export const WorkProductTypeDefSchema = z.object({
  /** Discriminator. A Capability MAY support multiple. */
  kind: WorkProductKindSchema,
  /** JSON Schema for the WorkProduct's `details` field at this kind. */
  detailsSchema: JSONSchemaSchema,
});
export type WorkProductTypeDef = z.infer<typeof WorkProductTypeDefSchema>;

// ---------------------------------------------------------------------------
// WorkSchema (whole)
// ---------------------------------------------------------------------------

export const WorkSchemaSchema = z.object({
  /** Schema version. v=1 is first published. Bumping = a new schemaHash + a
   *  new Capability version. */
  version: z.number().int().min(1),
  /** Human-readable label. NOT load-bearing. */
  label: z.string().min(1).max(120),
  /** Event types this Capability emits. At least one. */
  eventTypes: z.array(WorkEventTypeDefSchema).min(1),
  /** Permitted WorkProduct kinds. At least one. */
  workProducts: z.array(WorkProductTypeDefSchema).min(1),
  /** ISO timestamp of seal. NOT in the canonical hash. */
  publishedAt: z.string(),
  /** Author rationale. NOT load-bearing. */
  notes: z.string().max(1000).optional(),
  /** Self-reference, computed by `computeWorkSchemaHash`. */
  schemaHash: z
    .string()
    .regex(/^0x[a-f0-9]{64}$/i, "schemaHash must be 0x + 64 hex"),
});
export type WorkSchema = z.infer<typeof WorkSchemaSchema>;

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

/**
 * Compute the content-addressed hash for a WorkSchema. Mirrors
 * `computeScheduleHash` in rate-schedule.ts — same canonicalize, same
 * "metadata fields are excluded" convention.
 *
 * Rules:
 *   - eventTypes are sorted by `id` so insertion order doesn't change the hash
 *   - workProducts are sorted by `kind` for the same reason
 *   - label, notes, publishedAt, schemaHash itself are excluded
 */
export function computeWorkSchemaHash(
  schema: Omit<WorkSchema, "schemaHash"> | WorkSchema,
): `0x${string}` {
  const sortedEventTypes = [...schema.eventTypes].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const sortedWorkProducts = [...schema.workProducts].sort((a, b) =>
    a.kind.localeCompare(b.kind),
  );
  const payload = {
    version: schema.version,
    eventTypes: sortedEventTypes,
    workProducts: sortedWorkProducts,
  };
  const canonical = canonicalize(payload);
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Validate a WorkSchema is structurally well-formed. Throws on violation.
 *
 * Checks beyond zod schema:
 *   - No duplicate event-type ids
 *   - No duplicate work-product kinds
 *   - schemaHash field, if provided, matches recomputed hash
 */
export function assertWorkSchemaIsWellFormed(schema: WorkSchema): void {
  const seenEventIds = new Set<string>();
  for (const et of schema.eventTypes) {
    if (seenEventIds.has(et.id)) {
      throw new Error(`WorkSchema has duplicate eventType id: ${et.id}`);
    }
    seenEventIds.add(et.id);
  }
  const seenKinds = new Set<string>();
  for (const wp of schema.workProducts) {
    if (seenKinds.has(wp.kind)) {
      throw new Error(`WorkSchema has duplicate workProduct kind: ${wp.kind}`);
    }
    seenKinds.add(wp.kind);
  }
  const recomputed = computeWorkSchemaHash(schema);
  if (schema.schemaHash.toLowerCase() !== recomputed.toLowerCase()) {
    throw new Error(
      `WorkSchema schemaHash mismatch: claimed ${schema.schemaHash}, recomputed ${recomputed}`,
    );
  }
}
