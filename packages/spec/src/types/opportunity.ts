/**
 * OpportunityDTO v0 — the public, policy-safe view of work and demand that an
 * operator can act on (ledger R7/R45, product PX-13). Kits owns this contract;
 * readmodels serves it; operator-ux (Work Inbox), the ADK (onboarding match)
 * and genui (DemandOpportunityCard) consume it.
 *
 * Three kinds, a strict discriminated union (astra pack 112), never blurred:
 *   - funded_offer: work backed by an AUTHORITATIVE funding record. It must name
 *     that record (`fundingRef`) and pin the exact CSD revision; its evidence
 *     requirements are executable (every primitive has a live verifier).
 *   - kit_build_request: a request to build a reusable Capability Kit. Unfunded
 *     unless a funding record binds it; its evidence requirements may include
 *     stub primitives and then say so (`executable: false`).
 *   - demand_aggregate: a banded, k-suppressed count of verified requesters for
 *     a capability type, from the publisher's write-once release ledger. It
 *     carries NO free text: its id and title are derived from the capability,
 *     band and period, and it has no kitRef, location, evidence, deadline,
 *     reward or digest.
 *
 * Parsing never promotes an assertion to fact. `authority` and `fundingRef` are
 * the trusted producer's statements; the producer must re-read the funding
 * record, the capability registry and the release ledger, and consumers must
 * take these DTOs only from that producer's API.
 *
 * `asOf` is the READ time for every kind (an ISO timestamp); it never says when
 * an intent happened (#365 F4). A demand_aggregate's release period must have
 * closed before its asOf.
 *
 * Versioning: pre-release until first merge. These shapes have no deployed
 * producer or consumer yet, so amendment 1 and the pack-112 fixes land under the
 * same literal. After the first merge, EVERY shape or enum change bumps
 * OPPORTUNITY_SCHEMA; the pinned shape fingerprint in kits-contracts.test.ts
 * fails until that is done deliberately (pack 112 MEDIUM 8).
 */

import { z } from "zod";

import type { SHA256, Timestamp } from "./common.js";
import { CsdEvidencePrimitiveRefSchema, type CsdEvidencePrimitiveRef } from "../csd/schema.js";
import { EVIDENCE_PRIMITIVES, type EvidencePrimitiveDef } from "../evidence/primitives.js";
import { CSD_CAPABILITY_URL_PATTERN } from "./capability-kit.js";

export const OPPORTUNITY_SCHEMA = "pcc.opportunity.v0" as const;

/** A closed UTC calendar month, the public demand release unit (painpoints #365). */
export const OPPORTUNITY_RELEASE_PERIOD_PATTERN = /^(20[0-9]{2})-(0[1-9]|1[0-2])$/;

export type OpportunityKind = "funded_offer" | "kit_build_request" | "demand_aggregate";
export type FundingStatus = "funded" | "unfunded";
/** Same bands as painpoints' public aggregate projection (PR #365). */
export type OpportunityDemandBand = "5-9" | "10-24" | "25-99" | "100+";

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IsoTimestamp = z.string().datetime({ offset: true });
const Title = z.string().min(1).max(160).regex(/^[^\n\r]*$/, "single line");
const DemandBandSchema = z.enum(["5-9", "10-24", "25-99", "100+"]);

// ── Evidence primitives ─────────────────────────────────────────────

const PRIMITIVES: ReadonlyMap<string, EvidencePrimitiveDef> = new Map(EVIDENCE_PRIMITIVES.map((p) => [p.id, p]));

/**
 * Check a primitive's params against its minimal JSON-Schema-shaped descriptor:
 * type, enum, items, properties, required and additionalProperties.
 */
export function validatePrimitiveParams(schema: Record<string, unknown>, value: unknown): boolean {
  const type = schema.type;
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) return false;
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array": {
      if (!Array.isArray(value)) return false;
      const items = schema.items as Record<string, unknown> | undefined;
      return items === undefined || value.every((v) => validatePrimitiveParams(items, v));
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const obj = value as Record<string, unknown>;
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      if (required.some((k) => !(k in obj))) return false;
      for (const [k, v] of Object.entries(obj)) {
        const sub = props[k];
        if (sub === undefined) {
          if (schema.additionalProperties === false) return false;
          continue;
        }
        if (!validatePrimitiveParams(sub, v)) return false;
      }
      return true;
    }
    default:
      return true;
  }
}

/** A CSD evidence-primitive ref: an ACTIVE primitive whose params match its descriptor. */
const PrimitiveRefSchema = CsdEvidencePrimitiveRefSchema.strict().superRefine((ref, ctx) => {
  const def = PRIMITIVES.get(ref.id);
  if (!def || def.status !== "active") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `evidence primitive ${ref.id} is unknown or not active` });
    return;
  }
  if (ref.params !== undefined && !validatePrimitiveParams(def.paramsSchema, ref.params)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `params do not match ${ref.id}'s paramsSchema` });
  }
});

/** True when every referenced primitive has a live verifier, i.e. the requirement can actually be checked. */
export function primitivesAreExecutable(refs: readonly CsdEvidencePrimitiveRef[]): boolean {
  return refs.every((r) => PRIMITIVES.get(r.id)?.verifierStatus === "live");
}

const EvidenceRequirementSchema = z
  .object({
    tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    requiredPrimitives: z.array(PrimitiveRefSchema).max(50),
    /** True only when every primitive has a live verifier (checked below). */
    executable: z.boolean(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.executable !== primitivesAreExecutable(e.requiredPrimitives)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "executable must be true exactly when every required primitive has a live verifier",
      });
    }
  });

export interface OpportunityEvidence {
  tier: 0 | 1 | 2 | 3;
  requiredPrimitives: CsdEvidencePrimitiveRef[];
  executable: boolean;
}

// ── Shared parts ────────────────────────────────────────────────────

export interface OpportunityReward {
  /** Base units as a decimal string; never a float. */
  amount: string;
  currency: string;
  fundingStatus: FundingStatus;
}

const RewardSchema = z
  .object({
    amount: z.string().regex(/^\d+$/, "base units as a decimal string"),
    currency: z.string().min(1).max(20),
    fundingStatus: z.enum(["funded", "unfunded"]),
  })
  .strict();

/** The authoritative funding record a funded opportunity is bound to; the producer re-reads it. */
export interface FundingRef {
  kind: "escrow";
  id: string;
}

export const FundingRefSchema = z
  .object({ kind: z.literal("escrow"), id: z.string().min(1).max(200) })
  .strict();

const LocationSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    region: z.string().min(1).max(80).optional(),
  })
  .strict();

const KitRefSchema = z
  .object({ kitDigest: Sha256Schema, name: z.string().min(1).max(200) })
  .strict();

// ── Demand aggregates: derived id and title ─────────────────────────

const PUBLIC_CAPABILITY = /^pcc:\/\/capabilities\/([a-z0-9-]{1,40})\/v([0-9]{1,6})$/;

/**
 * A capability url that may appear in PUBLIC demand: slug of at most 40
 * characters, at most 3 hyphens and no run of 4+ digits, so an invented slug
 * cannot carry a name, date or place code. The same rule as painpoints'
 * isPublishableCapabilityId (#365).
 */
export function isPublicCapabilityUrl(url: string): boolean {
  const m = PUBLIC_CAPABILITY.exec(url);
  if (!m) return false;
  const slug = m[1]!;
  return (slug.match(/-/g)?.length ?? 0) <= 3 && !/[0-9]{4}/.test(slug);
}

/** The only id a demand_aggregate may carry: derived from its period and capability. */
export function demandAggregateId(releasePeriod: string, capabilityType: string): string {
  const m = PUBLIC_CAPABILITY.exec(capabilityType);
  return m ? `demand:${releasePeriod}:${m[1]}:v${m[2]}` : "";
}

/** The only title a demand_aggregate may carry: derived, never supplied text. */
export function demandAggregateTitle(capabilityType: string, band: OpportunityDemandBand, releasePeriod: string): string {
  const m = PUBLIC_CAPABILITY.exec(capabilityType);
  return m ? `Demand for ${m[1]} v${m[2]}: ${band} verified requesters (${releasePeriod})` : "";
}

/** The first instant after `releasePeriod` (UTC), in ms. */
function periodCloseMs(releasePeriod: string): number {
  const m = OPPORTUNITY_RELEASE_PERIOD_PATTERN.exec(releasePeriod);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]), 1);
}

// ── The three kinds ─────────────────────────────────────────────────

export interface FundedOfferDTO {
  schema: typeof OPPORTUNITY_SCHEMA;
  kind: "funded_offer";
  id: string;
  capabilityType: string;
  /** The exact CSD revision the accepted plan pinned. */
  capabilityContractDigest: SHA256;
  /** Server-templated from structured fields; never requester free text. */
  title: string;
  reward: OpportunityReward & { fundingStatus: "funded" };
  fundingRef: FundingRef;
  evidence?: OpportunityEvidence & { executable: true };
  /** Coarse only: an ISO 3166-1 alpha-2 country and, at most, a named region. */
  location?: { country?: string; region?: string };
  deadline?: Timestamp;
  kitRef?: { kitDigest: SHA256; name: string } | null;
  authority: "authoritative";
  /** READ time of this projection. */
  asOf: Timestamp;
}

export interface KitBuildRequestDTO {
  schema: typeof OPPORTUNITY_SCHEMA;
  kind: "kit_build_request";
  id: string;
  capabilityType: string;
  /** The CSD revision the kit must satisfy, if pinned. */
  capabilityContractDigest?: SHA256;
  title: string;
  reward?: OpportunityReward;
  /** Required when the reward is funded. */
  fundingRef?: FundingRef;
  evidence?: OpportunityEvidence;
  location?: { country?: string; region?: string };
  deadline?: Timestamp;
  /** The kit that already serves this capability, or null when one must be built. */
  kitRef?: { kitDigest: SHA256; name: string } | null;
  authority: "authoritative" | "derived_signal";
  asOf: Timestamp;
}

export interface DemandAggregateDTO {
  schema: typeof OPPORTUNITY_SCHEMA;
  kind: "demand_aggregate";
  /** demandAggregateId(releasePeriod, capabilityType); nothing else. */
  id: string;
  capabilityType: string;
  /** demandAggregateTitle(capabilityType, demandBand, releasePeriod); nothing else. */
  title: string;
  demandBand: OpportunityDemandBand;
  /** The closed release period, "YYYY-MM"; it closed before asOf. */
  releasePeriod: string;
  authority: "derived_signal";
  asOf: Timestamp;
}

export type OpportunityDTO = FundedOfferDTO | KitBuildRequestDTO | DemandAggregateDTO;

const FundedOfferSchema = z
  .object({
    schema: z.literal(OPPORTUNITY_SCHEMA),
    kind: z.literal("funded_offer"),
    id: z.string().min(1).max(200),
    capabilityType: z.string().regex(CSD_CAPABILITY_URL_PATTERN),
    capabilityContractDigest: Sha256Schema,
    title: Title,
    reward: RewardSchema.extend({ fundingStatus: z.literal("funded") }).strict(),
    fundingRef: FundingRefSchema,
    evidence: EvidenceRequirementSchema.optional(),
    location: LocationSchema.optional(),
    deadline: IsoTimestamp.optional(),
    kitRef: KitRefSchema.nullable().optional(),
    authority: z.literal("authoritative"),
    asOf: IsoTimestamp,
  })
  .strict();

const KitBuildRequestSchema = z
  .object({
    schema: z.literal(OPPORTUNITY_SCHEMA),
    kind: z.literal("kit_build_request"),
    id: z.string().min(1).max(200),
    capabilityType: z.string().regex(CSD_CAPABILITY_URL_PATTERN),
    capabilityContractDigest: Sha256Schema.optional(),
    title: Title,
    reward: RewardSchema.optional(),
    fundingRef: FundingRefSchema.optional(),
    evidence: EvidenceRequirementSchema.optional(),
    location: LocationSchema.optional(),
    deadline: IsoTimestamp.optional(),
    kitRef: KitRefSchema.nullable().optional(),
    authority: z.enum(["authoritative", "derived_signal"]),
    asOf: IsoTimestamp,
  })
  .strict();

const DemandAggregateSchema = z
  .object({
    schema: z.literal(OPPORTUNITY_SCHEMA),
    kind: z.literal("demand_aggregate"),
    id: z.string().min(1).max(120),
    capabilityType: z.string().regex(CSD_CAPABILITY_URL_PATTERN),
    title: Title,
    demandBand: DemandBandSchema,
    releasePeriod: z.string().regex(OPPORTUNITY_RELEASE_PERIOD_PATTERN, "Must be a YYYY-MM period"),
    authority: z.literal("derived_signal"),
    asOf: IsoTimestamp,
  })
  .strict();

export const OpportunityDTOSchema = z
  .discriminatedUnion("kind", [FundedOfferSchema, KitBuildRequestSchema, DemandAggregateSchema])
  .superRefine((o, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (o.kind === "funded_offer") {
      if (o.evidence && !o.evidence.executable) {
        fail("a funded_offer's evidence requirements must be executable (every primitive live)");
      }
      return;
    }
    if (o.kind === "kit_build_request") {
      if (o.reward?.fundingStatus === "funded") {
        if (o.authority !== "authoritative") fail("'funded' needs a server-verified (authoritative) source");
        if (!o.fundingRef) fail("a funded kit_build_request must name its funding record");
        if (o.evidence && !o.evidence.executable) fail("funded evidence requirements must be executable");
      } else if (o.fundingRef) {
        fail("only a funded opportunity carries a fundingRef");
      }
      return;
    }
    // demand_aggregate: no free text anywhere.
    if (!isPublicCapabilityUrl(o.capabilityType)) {
      fail("a demand_aggregate's capabilityType must be a publishable capability url");
    }
    if (o.id !== demandAggregateId(o.releasePeriod, o.capabilityType)) {
      fail("a demand_aggregate's id is derived: demandAggregateId(releasePeriod, capabilityType)");
    }
    if (o.title !== demandAggregateTitle(o.capabilityType, o.demandBand, o.releasePeriod)) {
      fail("a demand_aggregate's title is derived: demandAggregateTitle(capabilityType, demandBand, releasePeriod)");
    }
    if (!(Date.parse(o.asOf) >= periodCloseMs(o.releasePeriod))) {
      fail("a demand_aggregate's release period must have closed before its asOf");
    }
  });
