/**
 * Kit demand — the demand input for Capability Kit builds (ledger R44 → R7 / R45 / PX-13).
 *
 * Three privacy classes, never merged:
 *   1. First-party intents (`DemandEnvelope`, `intent.*` events) — PRIVATE.
 *   2. Priors (desk research, external complaint corpora) — PRIVATE strategy data.
 *   3. Public opportunity aggregates — produced ONLY by
 *      `toPublicOpportunityAggregate()`: allow-listed fields, banded counts,
 *      suppressed below k distinct verified requesters.
 *
 * This module holds types and pure functions. The data they describe is
 * private; no real record of it belongs in this public package or its tests.
 */
import { z } from "zod";
import { sha256 as sha256Hash } from "@noble/hashes/sha256";
import { canonicalize } from "../util/canonical.js";
import { BudgetBandSchema, UnmetReasonSchema, type BudgetBand, type UnmetReason } from "./demand.js";

// ── Types ────────────────────────────────────────────────────────

/** How cheaply reusable supply can exist for a capability type. */
export type KitBuildClass =
  | "package" // real adapters exist; the kit is packaging (CSD, evidence profile, test job, deploy recipe)
  | "build" // a new connector is needed
  | "blocked"; // buildable, but per-task economics wait on a roadmap mechanism

/** Demand evidence, ordered by how costly it is to fake (highest first). */
export type DemandEvidenceClass = "funded" | "authenticated_order" | "query";

/** Pointer from a signal to a private prior record (never the record itself). */
export interface KitDemandPriorRef {
  priorId: string;
  source: "desk_research" | "external_corpus";
  /** The prior's demand score (see the private dataset's scoring block) */
  demandScore: number;
  buildClass: KitBuildClass;
  /** Canonical digest of the prior dataset the score came from */
  datasetDigest: string;
}

/** Server-computed unmet demand for one capability key over a window. */
export interface KitDemandInternal {
  /** Unmet intents for this key, computed server-side at first-party capture */
  unmetCount: number;
  /** Distinct SERVER-derived requester identities — never caller-supplied hashes */
  distinctVerifiedRequesters: number;
  byEvidenceClass: Record<DemandEvidenceClass, number>;
  reasonHistogram: Partial<Record<UnmetReason, number>>;
  budgetBandHistogram: Partial<Record<BudgetBand, number>>;
  /** ISO 8601 */
  firstSeen: string;
  /** ISO 8601 */
  lastSeen: string;
}

/** The R44 demand input for one capability key. PRIVATE. */
export interface KitDemandSignal {
  schema: "pcc.kit-demand-signal.v0";
  /** A CSD capability URI, or `proposed:<slug>` for a type with no CSD yet */
  capabilityKey: string;
  internal?: KitDemandInternal;
  prior?: KitDemandPriorRef;
  /** ISO 8601 */
  computedAt: string;
}

// ── Schemas ──────────────────────────────────────────────────────

export const CapabilityKeySchema = z
  .string()
  .regex(
    /^(pcc:\/\/capabilities\/[a-z0-9-]+\/v[0-9]+|proposed:[a-z0-9-]+)$/,
    "Must be a CSD URI (pcc://capabilities/<slug>/v<N>) or proposed:<slug>",
  );

const Count = z.number().int().nonnegative();
const IsoTimestamp = z.string().datetime({ offset: true });

export const KitDemandPriorRefSchema = z
  .object({
    priorId: z.string().regex(/^kdp-[a-z0-9-]+$/),
    source: z.enum(["desk_research", "external_corpus"]),
    demandScore: z.number().finite(),
    buildClass: z.enum(["package", "build", "blocked"]),
    datasetDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

function sumOf(values: Record<string, number | undefined>): number {
  return Object.values(values).reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

export const KitDemandInternalSchema = z
  .object({
    unmetCount: Count,
    distinctVerifiedRequesters: Count,
    byEvidenceClass: z
      .object({ funded: Count, authenticated_order: Count, query: Count })
      .strict(),
    reasonHistogram: z.record(UnmetReasonSchema, Count),
    budgetBandHistogram: z.record(BudgetBandSchema, Count),
    firstSeen: IsoTimestamp,
    lastSeen: IsoTimestamp,
  })
  .strict()
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (v.distinctVerifiedRequesters > v.unmetCount) {
      fail("distinctVerifiedRequesters cannot exceed unmetCount");
    }
    // Each unmet intent contributes exactly one evidence class, one reason and
    // one budget band for this key, so every histogram must account for all of them.
    if (sumOf(v.byEvidenceClass) !== v.unmetCount) fail("byEvidenceClass must sum to unmetCount");
    if (sumOf(v.reasonHistogram) !== v.unmetCount) fail("reasonHistogram must sum to unmetCount");
    if (sumOf(v.budgetBandHistogram) !== v.unmetCount) fail("budgetBandHistogram must sum to unmetCount");
    if (Date.parse(v.firstSeen) > Date.parse(v.lastSeen)) fail("firstSeen must not be after lastSeen");
  });

export const KitDemandSignalSchema = z
  .object({
    schema: z.literal("pcc.kit-demand-signal.v0"),
    capabilityKey: CapabilityKeySchema,
    internal: KitDemandInternalSchema.optional(),
    prior: KitDemandPriorRefSchema.optional(),
    computedAt: IsoTimestamp,
  })
  .strict()
  .refine((v) => v.internal !== undefined || v.prior !== undefined, {
    message: "A signal needs internal demand, a prior, or both",
  });

// ── Digest ───────────────────────────────────────────────────────

/** `0x` + SHA-256 over the canonical JSON of a validated signal. */
export function kitDemandSignalDigest(signal: KitDemandSignal): `0x${string}` {
  const parsed = KitDemandSignalSchema.parse(signal);
  const bytes = sha256Hash(new TextEncoder().encode(canonicalize(parsed)));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ── Public projection ────────────────────────────────────────────

/** No public aggregate may ever describe fewer distinct verified requesters than this. */
export const MIN_PUBLIC_K = 5;

export type DemandBand = "5+" | "10+" | "25+" | "50+" | "100+";

const BANDS: ReadonlyArray<readonly [number, DemandBand]> = [
  [100, "100+"],
  [50, "50+"],
  [25, "25+"],
  [10, "10+"],
  [5, "5+"],
];

export interface OpportunityAggregatePolicy {
  /** Minimum distinct verified requesters before a type may appear publicly (>= MIN_PUBLIC_K) */
  k: number;
}

/** The only demand-intelligence shape that may leave the server. */
export interface PublicOpportunityAggregate {
  schema: "pcc.public-opportunity-aggregate.v0";
  /** A CSD URI. Proposed types are strategy data and never public. */
  capabilityType: string;
  /** Banded distinct verified requesters; never an exact count */
  demandBand: DemandBand;
  /** UTC day (YYYY-MM-DD) of the most recent unmet intent */
  asOf: string;
}

/**
 * Project a private signal into the public aggregate, or return `null` when it
 * must stay private. Returns `null` for:
 *   - prior-only signals (priors are strategy, not demand anyone expressed);
 *   - `proposed:` keys;
 *   - fewer than `policy.k` distinct verified requesters. One caller inflating
 *     `unmetCount` never makes a type public.
 * Throws on an invalid signal or a policy below MIN_PUBLIC_K, so it fails closed.
 */
export function toPublicOpportunityAggregate(
  signal: KitDemandSignal,
  policy: OpportunityAggregatePolicy = { k: MIN_PUBLIC_K },
): PublicOpportunityAggregate | null {
  if (!Number.isInteger(policy.k) || policy.k < MIN_PUBLIC_K) {
    throw new Error(`toPublicOpportunityAggregate: policy.k must be an integer >= ${MIN_PUBLIC_K}`);
  }
  const s = KitDemandSignalSchema.parse(signal);
  if (s.capabilityKey.startsWith("proposed:")) return null;
  if (s.internal === undefined) return null;
  const n = s.internal.distinctVerifiedRequesters;
  if (n < policy.k) return null;
  const band = BANDS.find(([floor]) => n >= floor);
  if (band === undefined) return null;
  return {
    schema: "pcc.public-opportunity-aggregate.v0",
    capabilityType: s.capabilityKey,
    demandBand: band[1],
    asOf: new Date(s.internal.lastSeen).toISOString().slice(0, 10),
  };
}
