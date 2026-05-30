/**
 * WorkProduct — Primitive 2 of RFC-001-work-primitives.
 *
 * A first-class, typed reference to what was actually produced by a Job.
 * Today this is implicit in EvidenceBundle; promoting it to a primitive
 * lets settlement fire on "the artifact exists and matches the WorkSchema's
 * work-product type" rather than on "evidence bundle is well-formed."
 *
 * Four variants cover all observed personas:
 *   physical  — tangible thing exists, located somewhere
 *   digital   — bytes were produced (file CID + signature)
 *   service   — a state was changed in the world
 *   bilateral — two parties handshake-attested completion
 *
 * Hash discipline:
 *   productHash = sha256(canonical_json({
 *     kind, jobId, capabilityId, schemaHash, finalizedAt, details
 *   }))
 *
 * Signatures (producerSignature, counterpartySignature) are NOT in the hash —
 * they sign the hash, the hash can't include them.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "../util/canonical.js";
import { WorkProductKindSchema } from "./work-schema.js";

const HEX_HASH = /^0x[a-f0-9]{64}$/i;
const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE = /^0x[a-fA-F0-9]+$/;

const WorkProductBaseFields = {
  jobId: z.string().min(1),
  capabilityId: z.string().min(1),
  schemaHash: z.string().regex(HEX_HASH),
  /** Producer's signature over the canonical bytes (= productHash). */
  producerSignature: z.string().regex(SIGNATURE),
  /** Producer's wallet address. Must match the Job's assigned Actor. */
  producerAddress: z.string().regex(ETH_ADDRESS),
  /** Unix seconds. */
  finalizedAt: z.number().int().min(0),
  /** Self-reference, computed by `computeWorkProductHash`. */
  productHash: z.string().regex(HEX_HASH),
} as const;

// ---------------------------------------------------------------------------
// physical — tangible artifact
// ---------------------------------------------------------------------------

export const PhysicalWorkProductSchema = z.object({
  kind: z.literal("physical"),
  ...WorkProductBaseFields,
  details: z.object({
    /** Where the artifact is located. */
    location: z.object({
      lat: z.number(),
      lng: z.number(),
      address: z.string().optional(),
      room: z.string().optional(),
    }),
    /** Optional unique serial / tag the artifact carries. */
    serial: z.string().optional(),
    /** IPFS CID of the producer's "this is what I made" photo bundle. */
    photoBundleCid: z.string().min(1),
    /** Delivery confirmation from a courier or recipient, if applicable. */
    deliveryAttestationId: z.string().optional(),
  }),
});
export type PhysicalWorkProduct = z.infer<typeof PhysicalWorkProductSchema>;

// ---------------------------------------------------------------------------
// digital — bytes were produced
// ---------------------------------------------------------------------------

export const DigitalWorkProductSchema = z.object({
  kind: z.literal("digital"),
  ...WorkProductBaseFields,
  details: z.object({
    /** IPFS CID of the produced bytes. */
    cid: z.string().min(1),
    /** sha256 of the produced bytes (NOT the CID — these may disagree if
     *  the CID's hash function is something other than sha256). */
    contentHash: z.string().regex(HEX_HASH),
    /** MIME type or format identifier. */
    format: z.string().min(1),
    /** Byte size, for sanity-check + storage settlement. */
    sizeBytes: z.number().int().min(0),
  }),
});
export type DigitalWorkProduct = z.infer<typeof DigitalWorkProductSchema>;

// ---------------------------------------------------------------------------
// service — state changed in the world
// ---------------------------------------------------------------------------

export const ServiceWorkProductSchema = z.object({
  kind: z.literal("service"),
  ...WorkProductBaseFields,
  details: z.object({
    /** Free-form description of the state change, validated against the
     *  WorkSchema's workProducts[].detailsSchema for kind=service. */
    stateChange: z.record(z.unknown()),
    /** Optional follow-up: "this state holds true until T". 0 = no claim. */
    holdsUntil: z.number().int().min(0).optional(),
  }),
});
export type ServiceWorkProduct = z.infer<typeof ServiceWorkProductSchema>;

// ---------------------------------------------------------------------------
// bilateral — two-sided handshake
// ---------------------------------------------------------------------------

export const BilateralWorkProductSchema = z.object({
  kind: z.literal("bilateral"),
  ...WorkProductBaseFields,
  details: z.object({
    /** The other party. */
    counterpartyAddress: z.string().regex(ETH_ADDRESS),
    /** Counterparty's signature over the same canonical bytes (productHash). */
    counterpartySignature: z.string().regex(SIGNATURE),
    /** What both parties attested to. Schema-validated downstream. */
    receipt: z.record(z.unknown()),
  }),
});
export type BilateralWorkProduct = z.infer<typeof BilateralWorkProductSchema>;

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const WorkProductSchema = z.discriminatedUnion("kind", [
  PhysicalWorkProductSchema,
  DigitalWorkProductSchema,
  ServiceWorkProductSchema,
  BilateralWorkProductSchema,
]);
export type WorkProduct = z.infer<typeof WorkProductSchema>;

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

/**
 * Compute the content-addressed productHash for a WorkProduct.
 *
 * Excluded fields: producerSignature, productHash, and (for bilateral)
 * counterpartySignature. Signatures sign the hash; the hash can't include
 * them. The contentHash field on `digital` IS included — that's a hash
 * of the produced *bytes*, not of the WorkProduct envelope.
 *
 * Note: this function accepts the input in either pre-hash form (Omit<...,
 * "productHash" | "producerSignature">) or final form. It strips the
 * excluded fields itself, so callers can pass the same object before and
 * after signing.
 */
export function computeWorkProductHash(
  product: Omit<WorkProduct, "productHash" | "producerSignature"> | WorkProduct,
): `0x${string}` {
  const base = {
    kind: product.kind,
    jobId: product.jobId,
    capabilityId: product.capabilityId,
    schemaHash: product.schemaHash,
    producerAddress: product.producerAddress,
    finalizedAt: product.finalizedAt,
    details: stripCounterpartySignature(product),
  };
  const canonical = canonicalize(base);
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `0x${hex}` as `0x${string}`;
}

/**
 * For bilateral WorkProducts, the counterpartySignature signs the productHash
 * — so it must be excluded from the hash itself. For all other kinds this
 * is a passthrough.
 */
function stripCounterpartySignature(
  product: Omit<WorkProduct, "productHash" | "producerSignature"> | WorkProduct,
): Record<string, unknown> {
  if (product.kind !== "bilateral") {
    return product.details as Record<string, unknown>;
  }
  // TS doesn't narrow Omit<WorkProduct, ...> to BilateralWorkProduct here
  // because the discriminant narrowing only fires on the WorkProduct branch
  // of the input union. Cast explicitly.
  const details = product.details as z.infer<
    typeof BilateralWorkProductSchema
  >["details"];
  const { counterpartySignature: _omit, ...rest } = details;
  return rest;
}

/**
 * Validate a WorkProduct is structurally well-formed. Throws on violation.
 */
export function assertWorkProductIsWellFormed(product: WorkProduct): void {
  const recomputed = computeWorkProductHash(product);
  if (product.productHash.toLowerCase() !== recomputed.toLowerCase()) {
    throw new Error(
      `WorkProduct productHash mismatch: claimed ${product.productHash}, recomputed ${recomputed}`,
    );
  }
}
