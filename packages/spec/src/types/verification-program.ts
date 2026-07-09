/**
 * VerificationProgram — Primitive 5 of RFC-001-work-primitives.
 *
 * Deterministic predicate over (JobSpec, EvidenceStream, WorkProduct,
 * AttestationSet, Registry-via-snapshot) that returns pass/fail/pending.
 * Sealed in the Capability's CSD, anchored on-chain by `programHash`.
 *
 * This file ships the TYPE LAYER and the canonical-hash function. The
 * evaluator (the function that takes a program + context and returns a
 * verdict) lands in `@pcc/spec/eval/verification-program.ts` in the
 * subsequent phase. The shape locked here is the contract.
 *
 * Hash discipline:
 *   programHash = sha256(canonical_json({
 *     version, schemaHash,
 *     stages: [...]   // canonical-keys at all depths
 *   }))
 *
 * publishedAt + label/notes (none here) are NOT in the hash.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "../util/canonical.js";
import { AttestationRoleSchema } from "./attestation.js";

const HEX_HASH = /^0x[a-f0-9]{64}$/i;

// ---------------------------------------------------------------------------
// EventRef — pointer into the EvidenceStream
// ---------------------------------------------------------------------------

export const EventRefSchema = z.object({
  /** Match an event of this type. */
  eventType: z.string().min(1),
  /** -1 = last event of this type, undefined = first. */
  index: z.number().int().optional(),
});
export type EventRef = z.infer<typeof EventRefSchema>;

// ---------------------------------------------------------------------------
// VerificationRule — discriminated union mirroring RateSegment shape
// ---------------------------------------------------------------------------

const ComparisonOpSchema = z.enum(["<", "<=", "=", "!=", ">=", ">"]);
const ReduceOpSchema = z.enum(["min", "max", "sum", "mean", "count"]);

// Existence / counting
const EventPresenceSchema = z.object({
  kind: z.literal("event-presence"),
  eventType: z.string().min(1),
  atLeast: z.number().int().min(0).optional(),
  atMost: z.number().int().min(0).optional(),
});

// Numeric thresholds on payload fields
const FieldThresholdSchema = z.object({
  kind: z.literal("field-threshold"),
  eventRef: EventRefSchema,
  /** JSON pointer into payload, e.g. "/groundOhms". */
  path: z.string().min(1),
  op: ComparisonOpSchema,
  value: z.number(),
});

// Aggregate over a set of events
const AggregateThresholdSchema = z.object({
  kind: z.literal("aggregate-threshold"),
  eventType: z.string().min(1),
  path: z.string().min(1),
  reduce: ReduceOpSchema,
  op: ComparisonOpSchema,
  value: z.number(),
});

// Temporal: ordering + gap
const EventSequenceSchema = z.object({
  kind: z.literal("event-sequence"),
  before: EventRefSchema,
  after: EventRefSchema,
  maxGapSeconds: z.number().int().min(0).optional(),
  minGapSeconds: z.number().int().min(0).optional(),
});

// Spatial: geofence
const GeofenceSchema = z.object({
  kind: z.literal("geofence"),
  eventRef: EventRefSchema,
  /** JSON pointer to {lat, lng} within payload; default to root. */
  pathToLocation: z.string().optional(),
  lat: z.number(),
  lng: z.number(),
  radiusM: z.number().min(0),
});

// Two events stayed close to each other in space
const TraceCoverageSchema = z.object({
  kind: z.literal("trace-coverage"),
  a: EventRefSchema,
  b: EventRefSchema,
  pathA: z.string().min(1),
  pathB: z.string().min(1),
  epsilonM: z.number().min(0),
  minOverlapPct: z.number().min(0).max(100),
});

// Registry membership
const RegistryMembershipSchema = z.object({
  kind: z.literal("registry-membership"),
  eventRef: EventRefSchema,
  path: z.string().min(1),
  registryId: z.string().min(1),
  snapshotHash: z.string().regex(HEX_HASH),
});

// Photo authenticity primitive
const PhotoAuthenticSchema = z.object({
  kind: z.literal("photo-authentic"),
  eventRef: EventRefSchema,
  pHashTolerance: z.number().min(0),
  maxAgeSeconds: z.number().int().min(0),
  requireExif: z.boolean().optional(),
  gpsConsistent: z.boolean().optional(),
});

// WorkProduct gate
const WorkProductRequiredSchema = z.object({
  kind: z.literal("work-product-required"),
  productKind: z.enum(["physical", "digital", "service", "bilateral"]),
  /** Optional details schema to validate against. */
  detailsSchema: z.record(z.unknown()).optional(),
});

// Human attestation gate
const HumanAttestationSchema = z.object({
  kind: z.literal("human-attestation"),
  role: AttestationRoleSchema,
  timeoutSeconds: z.number().int().min(0),
  onTimeout: z.enum(["fail", "escalate"]),
});

// Evidence-vocabulary primitive (evidence-vocabulary v1, §5.3). ONE new rule
// kind; the vocabulary grows in DATA (registry entries in @pcc/spec/evidence),
// never in rule shapes — so RFC-001's union stays small. The four legacy
// authentication-bearing kinds are documented registry aliases of primitive ids
// (photo-authentic ≡ capture.photo_nonced, geofence ≡ telemetry.geofence_event,
// registry-membership ≡ ident.registered_key/attest.credential, human-attestation
// ≡ approval.*/attest.committee).
const PrimitiveRuleSchema = z.object({
  kind: z.literal("primitive"),
  /** Short-form primitive id, e.g. "capture.photo_nonced". */
  id: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  /** Bundle/WorkSchema field carrying the instance. */
  bind: z.string().optional(),
});

// Logical composition — recursive via z.lazy
// Manual type declaration breaks the circular reference between the type and
// the schema (TS2456: VerificationRuleOutput circularly references itself).
type LeafRule =
  | z.infer<typeof EventPresenceSchema>
  | z.infer<typeof FieldThresholdSchema>
  | z.infer<typeof AggregateThresholdSchema>
  | z.infer<typeof EventSequenceSchema>
  | z.infer<typeof GeofenceSchema>
  | z.infer<typeof TraceCoverageSchema>
  | z.infer<typeof RegistryMembershipSchema>
  | z.infer<typeof PhotoAuthenticSchema>
  | z.infer<typeof WorkProductRequiredSchema>
  | z.infer<typeof HumanAttestationSchema>
  | z.infer<typeof PrimitiveRuleSchema>;

export type VerificationRule =
  | LeafRule
  | { kind: "and"; children: VerificationRule[] }
  | { kind: "or"; children: VerificationRule[] }
  | { kind: "not"; child: VerificationRule };

export const VerificationRuleSchema: z.ZodType<VerificationRule> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    EventPresenceSchema,
    FieldThresholdSchema,
    AggregateThresholdSchema,
    EventSequenceSchema,
    GeofenceSchema,
    TraceCoverageSchema,
    RegistryMembershipSchema,
    PhotoAuthenticSchema,
    WorkProductRequiredSchema,
    HumanAttestationSchema,
    PrimitiveRuleSchema,
    z.object({
      kind: z.literal("and"),
      children: z.array(VerificationRuleSchema).min(1),
    }),
    z.object({
      kind: z.literal("or"),
      children: z.array(VerificationRuleSchema).min(1),
    }),
    z.object({
      kind: z.literal("not"),
      child: VerificationRuleSchema,
    }),
  ]),
);

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export const VerificationStageSchema = z.object({
  stageId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/, "lowercase, alphanumeric + dash"),
  predicate: VerificationRuleSchema,
  /** 0..10000; sums to 10000 across all stages of a program. */
  releaseBps: z.number().int().min(0).max(10000),
  /** Wall clock after stage activation. */
  deadlineSeconds: z.number().int().min(0).optional(),
  onTimeout: z.enum(["refund", "arbitrate", "escalate-to-human"]),
  onFail: z.enum(["refund", "arbitrate"]),
});
export type VerificationStage = z.infer<typeof VerificationStageSchema>;

// ---------------------------------------------------------------------------
// Program (whole)
// ---------------------------------------------------------------------------

export const VerificationProgramSchema = z.object({
  version: z.number().int().min(1),
  /** Back-reference to the WorkSchema this program evaluates. */
  schemaHash: z.string().regex(HEX_HASH),
  stages: z.array(VerificationStageSchema).min(1),
  /** Self-reference, computed by `computeVerificationProgramHash`. */
  programHash: z.string().regex(HEX_HASH),
  /** ISO timestamp; NOT in the hash. */
  publishedAt: z.string(),
});
export type VerificationProgram = z.infer<typeof VerificationProgramSchema>;

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

export function computeVerificationProgramHash(
  program: Omit<VerificationProgram, "programHash"> | VerificationProgram,
): `0x${string}` {
  const payload = {
    version: program.version,
    schemaHash: program.schemaHash,
    stages: program.stages,
  };
  const canonical = canonicalize(payload);
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Validate a VerificationProgram is structurally well-formed. Throws on violation.
 *
 * Checks:
 *   - stages' releaseBps sums to exactly 10000 (no payment loss or overdraw)
 *   - stage ids are unique within the program
 *   - programHash, if provided, matches recomputed hash
 */
export function assertVerificationProgramIsWellFormed(
  program: VerificationProgram,
): void {
  const seenStageIds = new Set<string>();
  let totalBps = 0;
  for (const stage of program.stages) {
    if (seenStageIds.has(stage.stageId)) {
      throw new Error(
        `VerificationProgram has duplicate stageId: ${stage.stageId}`,
      );
    }
    seenStageIds.add(stage.stageId);
    totalBps += stage.releaseBps;
  }
  if (totalBps !== 10000) {
    throw new Error(
      `VerificationProgram stages must sum to 10000 bps, got ${totalBps}`,
    );
  }
  const recomputed = computeVerificationProgramHash(program);
  if (program.programHash.toLowerCase() !== recomputed.toLowerCase()) {
    throw new Error(
      `VerificationProgram programHash mismatch: claimed ${program.programHash}, recomputed ${recomputed}`,
    );
  }
}
