/**
 * OpportunityDTO v0 — the public, policy-safe view of work and demand that an
 * operator can act on (ledger R7/R45, product PX-13). Kits owns this contract;
 * readmodels serves it; operator-ux (Work Inbox), the ADK (onboarding match)
 * and genui (DemandOpportunityCard) consume it.
 *
 * Three kinds, never blurred:
 *   - funded_offer: work backed by a server-verified funding reference (an
 *     escrow bound to the offer). The only kind that may show "funded".
 *   - kit_build_request: a request to build a reusable Capability Kit, usually
 *     from failed discovery. Unfunded until a verified funding reference binds.
 *   - demand_aggregate: a banded, k-suppressed count of verified requesters for
 *     a capability type, from painpoints' public projection. A signal, never
 *     money, and published only once requester identity is bound (R29/N2).
 *
 * `authority` is assigned by the server from the source record, never by the
 * producer of the content. Titles are server-templated: requester free text,
 * requester ids and fine-grained locations never appear.
 *
 * Demand intelligence stays private. A demand_aggregate carries exactly what
 * painpoints' public release publishes: capability type, demand band and the
 * closed release period (YYYY-MM). It is served only from the publisher's
 * write-once release ledger and never computed on read. It carries no raw
 * intents, private priors, requester identities, location, evidence, deadline
 * or pinned contract digest.
 *
 * `asOf` is the READ time for every kind. It never says when an intent
 * happened, so it cannot leak activity timing (#365 finding F4).
 *
 * v0, FROZEN FOR CONSUMERS (steward ruling #3058): adk, readmodels,
 * operator-ux and refvertical build against this shape. Any change needs
 * their ack on the bus first; a breaking change is a new version. Amendment 1
 * (2026-09-29) was acked by readmodels and adk and adds three fields:
 *   - A2: capabilityContractDigest pins the exact CSD revision;
 *   - A3: evidence.requiredPrimitives uses the CSD / EmitterDecl grammar;
 *   - A5: releasePeriod on a demand_aggregate.
 */

import { z } from "zod";

import type { SHA256, Timestamp } from "./common.js";
import { CsdEvidencePrimitiveRefSchema, type CsdEvidencePrimitiveRef } from "../csd/schema.js";
import { EVIDENCE_PRIMITIVES } from "../evidence/primitives.js";
import { CSD_CAPABILITY_URL_PATTERN } from "./capability-kit.js";

/** A closed UTC calendar month, the public demand release unit (painpoints #365). */
export const OPPORTUNITY_RELEASE_PERIOD_PATTERN = /^(20[0-9]{2})-(0[1-9]|1[0-2])$/;

const ACTIVE_PRIMITIVE_IDS: ReadonlySet<string> = new Set(
  EVIDENCE_PRIMITIVES.filter((p) => p.status === "active").map((p) => p.id),
);

export const OPPORTUNITY_SCHEMA = "pcc.opportunity.v0" as const;

export type OpportunityKind = "funded_offer" | "kit_build_request" | "demand_aggregate";
export type FundingStatus = "funded" | "unfunded";
/** Same bands as painpoints' public aggregate projection (PR #365). */
export type OpportunityDemandBand = "5-9" | "10-24" | "25-99" | "100+";

export interface OpportunityReward {
  /** Base units as a decimal string; never a float. */
  amount: string;
  currency: string;
  fundingStatus: FundingStatus;
}

export interface OpportunityDTO {
  schema: typeof OPPORTUNITY_SCHEMA;
  id: string;
  kind: OpportunityKind;
  /** CSD url of the capability the opportunity is for. */
  capabilityType: string;
  /**
   * The exact CSD revision (A2): REQUIRED on a funded funded_offer, since the
   * accepted plan pins it; optional on a kit_build_request (the revision the
   * kit must satisfy); never on a demand_aggregate.
   */
  capabilityContractDigest?: SHA256;
  /** Server-templated from structured fields; never requester free text. */
  title: string;
  reward?: OpportunityReward;
  /**
   * The evidence the work requires (A3): CSD evidence-primitive refs, the same
   * {id, params?, bind?} grammar as a CSD's evidence and setup's EmitterDecl
   * emits[], so supply compares against demand with no mapping table. Each id is
   * an active id in EVIDENCE_PRIMITIVES.
   */
  evidence?: { tier: 0 | 1 | 2 | 3; requiredPrimitives: CsdEvidencePrimitiveRef[] };
  /** Coarse only: an ISO 3166-1 alpha-2 country and, at most, a named region. */
  location?: { country?: string; region?: string };
  deadline?: Timestamp;
  /** demand_aggregate only. */
  demandBand?: OpportunityDemandBand;
  /** demand_aggregate only, and required there (A5): the closed release period, "YYYY-MM". */
  releasePeriod?: string;
  /** The kit that already serves this capability, or null when one must be built. */
  kitRef?: { kitDigest: SHA256; name: string } | null;
  /** Server-assigned from the source record. */
  authority: "authoritative" | "derived_signal";
  /** READ time of this projection. */
  asOf: Timestamp;
}

export const OpportunityDTOSchema = z
  .object({
    schema: z.literal(OPPORTUNITY_SCHEMA),
    id: z.string().min(1),
    kind: z.enum(["funded_offer", "kit_build_request", "demand_aggregate"]),
    capabilityType: z.string().regex(CSD_CAPABILITY_URL_PATTERN),
    capabilityContractDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    title: z.string().min(1).max(160).regex(/^[^\n\r]*$/, "single line"),
    reward: z
      .object({
        amount: z.string().regex(/^\d+$/, "base units as a decimal string"),
        currency: z.string().min(1).max(20),
        fundingStatus: z.enum(["funded", "unfunded"]),
      })
      .strict()
      .optional(),
    evidence: z
      .object({
        tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
        requiredPrimitives: z
          .array(
            CsdEvidencePrimitiveRefSchema.strict().refine((ref) => ACTIVE_PRIMITIVE_IDS.has(ref.id), {
              message: "an evidence primitive id must be active in EVIDENCE_PRIMITIVES",
            }),
          )
          .max(50),
      })
      .strict()
      .optional(),
    location: z
      .object({
        country: z.string().regex(/^[A-Z]{2}$/).optional(),
        region: z.string().min(1).max(80).optional(),
      })
      .strict()
      .optional(),
    deadline: z.string().optional(),
    demandBand: z.enum(["5-9", "10-24", "25-99", "100+"]).optional(),
    releasePeriod: z.string().regex(OPPORTUNITY_RELEASE_PERIOD_PATTERN, "Must be a YYYY-MM period").optional(),
    kitRef: z
      .object({ kitDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), name: z.string().min(1) })
      .strict()
      .nullable()
      .optional(),
    authority: z.enum(["authoritative", "derived_signal"]),
    asOf: z.string().min(1),
  })
  .strict()
  .superRefine((o, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (o.kind === "demand_aggregate") {
      if (!o.demandBand) fail("a demand_aggregate needs a demandBand");
      if (o.reward) fail("a demand_aggregate is a signal and carries no reward");
      if (o.authority !== "derived_signal") fail("a demand_aggregate is a derived_signal");
      // Only painpoints' public projection fields: nothing more specific leaves the server.
      if (o.location) fail("a demand_aggregate carries no location");
      if (o.evidence) fail("a demand_aggregate carries no evidence requirements");
      if (o.deadline) fail("a demand_aggregate carries no deadline");
      if (!o.releasePeriod) fail("a demand_aggregate needs its releasePeriod");
      if (o.capabilityContractDigest) fail("a demand_aggregate carries no pinned contract digest");
    } else {
      if (o.demandBand) fail("only a demand_aggregate carries a demandBand");
      if (o.releasePeriod) fail("only a demand_aggregate carries a releasePeriod");
    }
    if (o.reward?.fundingStatus === "funded") {
      if (o.kind === "demand_aggregate") fail("demand is never funded");
      if (o.authority !== "authoritative") fail("'funded' needs a server-verified (authoritative) source");
    }
    if (o.kind === "funded_offer" && o.reward?.fundingStatus !== "funded") {
      fail("a funded_offer must carry a funded reward");
    }
    if (o.kind === "funded_offer" && o.reward?.fundingStatus === "funded" && !o.capabilityContractDigest) {
      fail("a funded funded_offer must pin the capabilityContractDigest its accepted plan pinned");
    }
  });
