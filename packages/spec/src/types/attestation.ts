/**
 * AttestationSet — Primitive 4 of RFC-001-work-primitives.
 *
 * Generalized N-of-M signature primitive. Today's tier-3 multi-verifier
 * flow is hardcoded; this primitive lifts it into "any Capability can
 * declare 'this job needs M signatures from role set R, with at least N
 * positive (and score ≥ minScore if applicable)'."
 *
 * Used by VerificationProgram predicates of the form
 * `human_attestor(role='inspector', minScore≥4, quorum='2-of-3')`.
 *
 * This file is the TYPE LAYER ONLY. The evaluator (does this AttestationSet
 * satisfy a given AttestationRole?) lives in the verification-program
 * evaluator package, landing in a subsequent phase.
 */

import { z } from "zod";

const HEX_HASH = /^0x[a-f0-9]{64}$/i;
const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE = /^0x[a-fA-F0-9]+$/;

// ---------------------------------------------------------------------------
// AttestationRole — declares "what kind of attestation does this need?"
// ---------------------------------------------------------------------------

const SignersInlineSchema = z.object({
  kind: z.literal("inline"),
  addresses: z.array(z.string().regex(ETH_ADDRESS)).min(1),
});

const SignersRegistrySchema = z.object({
  kind: z.literal("registry"),
  registryId: z.string().min(1),
  /** Pin to a specific snapshot for reproducibility. */
  snapshotHash: z.string().regex(HEX_HASH),
});

export const AttestationRoleSchema = z.object({
  /** Role identifier, e.g. "inspector", "qa-reviewer", "buyer". */
  roleId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_-]*$/, "lowercase, alphanumeric + dash/underscore"),
  /** Which addresses may attest in this role. */
  signers: z.discriminatedUnion("kind", [SignersInlineSchema, SignersRegistrySchema]),
  /** Minimum positive signatures required (N in N-of-M). */
  minPositive: z.number().int().min(1),
  /** Total signers (M in N-of-M). For inline: must equal addresses.length.
   *  For registry: caps how many of the registry's members will be polled. */
  total: z.number().int().min(1),
  /** Optional: each individual attestation's score must be >= this.
   *  null/omitted = thumbs-up only, no score. */
  minScore: z.number().int().min(0).max(100).optional(),
});
export type AttestationRole = z.infer<typeof AttestationRoleSchema>;

// ---------------------------------------------------------------------------
// Individual Attestation
// ---------------------------------------------------------------------------

export const AttestationSchema = z.object({
  jobId: z.string().min(1),
  /** sha256 of (jobId + attestor + score + comment + timestamp). */
  attestationHash: z.string().regex(HEX_HASH),
  attestor: z.string().regex(ETH_ADDRESS),
  /** 0-100; meaning is role-defined. null for thumbs-up-only. */
  score: z.number().int().min(0).max(100).nullable(),
  comment: z.string().max(2000).optional(),
  /** Unix seconds. */
  timestamp: z.number().int().min(0),
  /** Attestor's signature over attestationHash. */
  signature: z.string().regex(SIGNATURE),
});
export type Attestation = z.infer<typeof AttestationSchema>;

// ---------------------------------------------------------------------------
// AttestationSet (whole)
// ---------------------------------------------------------------------------

export const AttestationSetSchema = z.object({
  jobId: z.string().min(1),
  /** Roles required by the VerificationProgram. */
  roles: z.array(AttestationRoleSchema).min(1),
  /** Submitted attestations, indexed by role. */
  byRole: z.record(z.array(AttestationSchema)),
  /** Computed: does this set satisfy all roles' (minPositive, minScore)?
   *  Set by the evaluator, not by the writer. */
  satisfied: z.boolean(),
});
export type AttestationSet = z.infer<typeof AttestationSetSchema>;
