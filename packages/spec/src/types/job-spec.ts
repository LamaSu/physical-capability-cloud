/**
 * JobSpec — Primitive 7 of RFC-001-work-primitives.
 *
 * The bundle. Composes Actor + Capability + WorkSchema + WorkProduct shape +
 * VerificationProgram + DisputeResolver into a single sealed,
 * content-addressed unit. This is what gets escrowed against, what gets
 * signed by buyer + seller, what the oracle reads when deciding release.
 *
 * Hash discipline:
 *   jobSpecHash = sha256(canonical_json({
 *     version, capabilityId, schemaHash, programHash,
 *     params, programOverride: programOverride?.programHash ?? null,
 *     constraints, buyer, seller,
 *     parentJobId ?? null,
 *     cofundedBy: sortedByKey("buyer", cofundedBy ?? []),
 *     resolverId,
 *   }))
 *
 * Signatures (buyerSignature, sellerSignature) sign the hash; not in it.
 * createdAt is metadata, also not in the hash.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "../util/canonical.js";
import { VerificationProgramSchema } from "./verification-program.js";

const HEX_HASH = /^0x[a-f0-9]{64}$/i;
const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE = /^0x[a-fA-F0-9]+$/;

// AssuranceTier inline (common.ts only exports the TS type).
const AssuranceTierSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

const SamplingSchema = z.object({
  selectorRegistryId: z.string().min(1),
  selectorSnapshotHash: z.string().regex(HEX_HASH),
});

const ConstraintsSchema = z.object({
  /** Hard wall-clock after JobSpec sealed. */
  deadlineSeconds: z.number().int().min(0),
  /** Buyer's max budget for this job, in cents. */
  maxBudgetCents: z.number().int().min(0),
  /** Required AssuranceTier — informational at this layer; the actual
   *  tier-correctness is enforced by the VerificationProgram. */
  requiredAssuranceTier: AssuranceTierSchema,
  /** Optional: this job is part of a 1-in-N audit batch. */
  sampling: SamplingSchema.optional(),
});

// ---------------------------------------------------------------------------
// Cofunded buyer
// ---------------------------------------------------------------------------

const CofundedBuyerSchema = z.object({
  buyer: z.string().regex(ETH_ADDRESS),
  amountCents: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// JobSpec (whole)
// ---------------------------------------------------------------------------

export const JobSpecSchema = z.object({
  version: z.number().int().min(1),

  /** What the work is. */
  capabilityId: z.string().min(1),
  schemaHash: z.string().regex(HEX_HASH),
  programHash: z.string().regex(HEX_HASH),

  /** Buyer-side parameters. Validated against the WorkSchema's payload
   *  schemas downstream — schema-validation is not done at JobSpec parse
   *  time so the type stays portable. */
  params: z.record(z.unknown()),

  /** Optional override: a buyer-supplied VerificationProgram that takes
   *  precedence over the Capability's default. Must reference the same
   *  schemaHash; enforced at seal time. */
  programOverride: VerificationProgramSchema.optional(),

  constraints: ConstraintsSchema,

  /** Provenance. */
  buyer: z.string().regex(ETH_ADDRESS),
  buyerSignature: z.string().regex(SIGNATURE),
  /** Assigned operator/contributor. */
  seller: z.string().regex(ETH_ADDRESS),
  /** May be null at creation; filled in when the seller accepts. */
  sellerSignature: z.string().regex(SIGNATURE).nullable(),

  /** Composition. */
  parentJobId: z.string().min(1).optional(),
  cofundedBy: z.array(CofundedBuyerSchema).optional(),
  resolverId: z.string().min(1),

  /** Time of seal. NOT in the hash. */
  createdAt: z.string(),

  /** Self-reference, computed by `computeJobSpecHash`. */
  jobSpecHash: z.string().regex(HEX_HASH),
});
export type JobSpec = z.infer<typeof JobSpecSchema>;

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

/**
 * Compute the content-addressed jobSpecHash. Mirrors the
 * computeScheduleHash / computeWorkSchemaHash convention: signatures and
 * timestamps are excluded; arrays that don't have a natural order
 * (cofundedBy) are sorted before hashing.
 *
 * programOverride is reduced to its programHash before hashing so the
 * JobSpec hash is stable even if the embedded program object is reordered.
 */
export function computeJobSpecHash(
  job:
    | Omit<JobSpec, "jobSpecHash" | "buyerSignature" | "sellerSignature">
    | JobSpec,
): `0x${string}` {
  const sortedCofunded = job.cofundedBy
    ? [...job.cofundedBy].sort((a, b) => a.buyer.localeCompare(b.buyer))
    : null;
  const payload = {
    version: job.version,
    capabilityId: job.capabilityId,
    schemaHash: job.schemaHash,
    programHash: job.programHash,
    params: job.params,
    programOverride: job.programOverride?.programHash ?? null,
    constraints: job.constraints,
    buyer: job.buyer,
    seller: job.seller,
    parentJobId: job.parentJobId ?? null,
    cofundedBy: sortedCofunded,
    resolverId: job.resolverId,
  };
  const canonical = canonicalize(payload);
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Validate a JobSpec is structurally well-formed. Throws on violation.
 *
 * Checks:
 *   - programOverride.schemaHash matches job.schemaHash (when present)
 *   - cofundedBy.amountCents sums to maxBudgetCents (when cofundedBy is set)
 *   - jobSpecHash field, if provided, matches recomputed hash
 */
export function assertJobSpecIsWellFormed(job: JobSpec): void {
  if (job.programOverride) {
    if (
      job.programOverride.schemaHash.toLowerCase() !==
      job.schemaHash.toLowerCase()
    ) {
      throw new Error(
        `JobSpec.programOverride.schemaHash ${job.programOverride.schemaHash} ` +
          `does not match job.schemaHash ${job.schemaHash}`,
      );
    }
  }
  if (job.cofundedBy && job.cofundedBy.length > 0) {
    const sum = job.cofundedBy.reduce((acc, c) => acc + c.amountCents, 0);
    if (sum !== job.constraints.maxBudgetCents) {
      throw new Error(
        `JobSpec.cofundedBy amounts sum to ${sum}, must equal maxBudgetCents ${job.constraints.maxBudgetCents}`,
      );
    }
  }
  const recomputed = computeJobSpecHash(job);
  if (job.jobSpecHash.toLowerCase() !== recomputed.toLowerCase()) {
    throw new Error(
      `JobSpec jobSpecHash mismatch: claimed ${job.jobSpecHash}, recomputed ${recomputed}`,
    );
  }
}
