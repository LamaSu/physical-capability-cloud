/**
 * Kit demand — the demand input for Capability Kit builds (ledger R44 → R7 / R45 / PX-13).
 *
 * Three privacy classes, never merged:
 *   1. First-party intents (`DemandEnvelope`, `intent.*` events) — PRIVATE.
 *   2. Priors (desk research, external complaint corpora) — PRIVATE strategy data.
 *   3. Public opportunity aggregates — produced ONLY by
 *      `toPublicOpportunityAggregate()`: allow-listed fields, banded counts,
 *      suppressed below k distinct verified requesters at or above an evidence
 *      floor, over a window of at least MIN_WINDOW_DAYS.
 *
 * This module holds types and pure functions. The data they describe is
 * private; no real record of it belongs in this public package or its tests.
 */
import { z } from "zod";
import { sha256 as sha256Hash } from "@noble/hashes/sha256";
import { canonicalize } from "../util/canonical.js";
import type { SHA256 } from "./common.js";
import {
  BudgetBandSchema,
  UnmetReasonSchema,
  UrgencyBandSchema,
  type BudgetBand,
  type UnmetReason,
  type UrgencyBand,
} from "./demand.js";

// ── Types ────────────────────────────────────────────────────────

/** How cheaply reusable supply can exist for a capability type. */
export type KitBuildClass =
  | "package" // real adapters exist; the kit is packaging (CSD, evidence profile, test job, deploy recipe)
  | "build" // a new connector is needed
  | "blocked"; // buildable, but per-task economics wait on a roadmap mechanism

/**
 * Demand evidence, by how costly it is to fake. Until the gateway binds keys to
 * verified identity (ledger R28/R29), only `funded` costs a forger real money:
 * `authenticated_order` and `query` both need nothing more than a free API key.
 */
export type DemandEvidenceClass = "query" | "authenticated_order" | "funded";

/** Evidence classes, weakest first. */
export const DEMAND_EVIDENCE_CLASSES: readonly DemandEvidenceClass[] = Object.freeze([
  "query",
  "authenticated_order",
  "funded",
] as const);

/** 0 = query, 1 = authenticated_order, 2 = funded. */
export function evidenceClassRank(c: DemandEvidenceClass): number {
  return DEMAND_EVIDENCE_CLASSES.indexOf(c);
}

export type AssuranceTierKey = "0" | "1" | "2" | "3";

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

type PerClass = Record<DemandEvidenceClass, number>;

/** Server-computed unmet demand for one capability key over a window. */
export interface KitDemandInternal {
  /** The window the counts cover, ISO 8601 */
  windowFrom: string;
  windowTo: string;
  /** Unmet intents for this key, computed server-side at first-party capture */
  unmetCount: number;
  /** Unmet intents per evidence class; sums to unmetCount */
  byEvidenceClass: PerClass;
  /** Distinct SERVER-verified requesters with at least one intent in exactly this class */
  distinctVerifiedRequestersByClass: PerClass;
  /**
   * Distinct SERVER-verified requesters whose strongest intent is at or above
   * this class. Cumulative and exact; the public projection uses it.
   */
  distinctVerifiedRequestersAtOrAbove: PerClass;
  /** Equals distinctVerifiedRequestersAtOrAbove.query */
  distinctVerifiedRequesters: number;
  reasonHistogram: Partial<Record<UnmetReason, number>>;
  budgetBandHistogram: Partial<Record<BudgetBand, number>>;
  urgencyHistogram: Partial<Record<UrgencyBand, number>>;
  /** Only intents that carry an assurance tier are counted; sums to <= unmetCount */
  assuranceTierHistogram: Partial<Record<AssuranceTierKey, number>>;
  /** ISO 3166-1 alpha-2 codes or "unknown"; never finer than country; sums to unmetCount */
  countryHistogram: Record<string, number>;
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

export const DemandEvidenceClassSchema = z.enum(["query", "authenticated_order", "funded"]);

const Count = z.number().int().nonnegative();
const IsoTimestamp = z.string().datetime({ offset: true });
const PerClassSchema = z.object({ query: Count, authenticated_order: Count, funded: Count }).strict();

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
    windowFrom: IsoTimestamp,
    windowTo: IsoTimestamp,
    unmetCount: Count,
    byEvidenceClass: PerClassSchema,
    distinctVerifiedRequestersByClass: PerClassSchema,
    distinctVerifiedRequestersAtOrAbove: PerClassSchema,
    distinctVerifiedRequesters: Count,
    reasonHistogram: z.record(UnmetReasonSchema, Count),
    budgetBandHistogram: z.record(BudgetBandSchema, Count),
    urgencyHistogram: z.record(UrgencyBandSchema, Count),
    assuranceTierHistogram: z.record(z.enum(["0", "1", "2", "3"]), Count),
    countryHistogram: z.record(z.string().regex(/^([A-Z]{2}|unknown)$/), Count),
    firstSeen: IsoTimestamp,
    lastSeen: IsoTimestamp,
  })
  .strict()
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const n = v.unmetCount;
    // Each unmet intent contributes exactly one class, reason, budget band,
    // urgency and country for this key; the tier is present only sometimes.
    if (sumOf(v.byEvidenceClass) !== n) fail("byEvidenceClass must sum to unmetCount");
    if (sumOf(v.reasonHistogram) !== n) fail("reasonHistogram must sum to unmetCount");
    if (sumOf(v.budgetBandHistogram) !== n) fail("budgetBandHistogram must sum to unmetCount");
    if (sumOf(v.urgencyHistogram) !== n) fail("urgencyHistogram must sum to unmetCount");
    if (sumOf(v.countryHistogram) !== n) fail("countryHistogram must sum to unmetCount");
    if (sumOf(v.assuranceTierHistogram) > n) fail("assuranceTierHistogram cannot exceed unmetCount");

    const by = v.distinctVerifiedRequestersByClass;
    const up = v.distinctVerifiedRequestersAtOrAbove;
    for (const c of DEMAND_EVIDENCE_CLASSES) {
      if (by[c] > v.byEvidenceClass[c]) fail(`distinct requesters in ${c} exceed its intents`);
      if (by[c] > up[c]) fail(`distinctVerifiedRequestersByClass.${c} exceeds its at-or-above count`);
    }
    if (!(up.query >= up.authenticated_order && up.authenticated_order >= up.funded)) {
      fail("distinctVerifiedRequestersAtOrAbove must be non-increasing from query to funded");
    }
    if (up.funded !== by.funded) fail("at-or-above funded must equal by-class funded");
    if (up.authenticated_order > by.authenticated_order + by.funded) fail("at-or-above authenticated_order exceeds its union bound");
    if (up.query > by.query + by.authenticated_order + by.funded) fail("at-or-above query exceeds its union bound");
    if (v.distinctVerifiedRequesters !== up.query) fail("distinctVerifiedRequesters must equal at-or-above query");
    if (v.distinctVerifiedRequesters > n) fail("distinctVerifiedRequesters cannot exceed unmetCount");

    const t = (s: string) => Date.parse(s);
    if (!(t(v.windowFrom) <= t(v.firstSeen) && t(v.firstSeen) <= t(v.lastSeen) && t(v.lastSeen) <= t(v.windowTo))) {
      fail("require windowFrom <= firstSeen <= lastSeen <= windowTo");
    }
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

/**
 * `sha256:<hex>` over the canonical JSON of a validated signal. The bytes match
 * the async `sha256(canonicalize(signal))` helper in util/canonical; this one is
 * synchronous so projections and folds need not await.
 */
export function kitDemandSignalDigest(signal: KitDemandSignal): SHA256 {
  const parsed = KitDemandSignalSchema.parse(signal);
  const bytes = sha256Hash(new TextEncoder().encode(canonicalize(parsed)));
  return `sha256:${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as SHA256;
}

// ── Public projection ────────────────────────────────────────────

/** No public aggregate may describe fewer distinct verified requesters than this. */
export const MIN_PUBLIC_K = 5;
/** No public aggregate may cover a window shorter than this many days. */
export const MIN_WINDOW_DAYS = 30;
/** The weakest evidence class a public aggregate may count. */
export const MIN_PUBLIC_EVIDENCE_CLASS: DemandEvidenceClass = "authenticated_order";

export type DemandBand = "5-9" | "10-24" | "25-99" | "100+";

const BANDS: ReadonlyArray<readonly [number, DemandBand]> = [
  [100, "100+"],
  [25, "25-99"],
  [10, "10-24"],
  [5, "5-9"],
];

export interface OpportunityAggregatePolicy {
  /** Minimum distinct verified requesters (>= MIN_PUBLIC_K) */
  k: number;
  /** Count only requesters whose strongest intent is at or above this class (>= MIN_PUBLIC_EVIDENCE_CLASS) */
  minEvidenceClass: DemandEvidenceClass;
  /** Minimum window length in days (>= MIN_WINDOW_DAYS) */
  minWindowDays: number;
}

export const DEFAULT_OPPORTUNITY_POLICY: Readonly<OpportunityAggregatePolicy> = Object.freeze({
  k: MIN_PUBLIC_K,
  minEvidenceClass: MIN_PUBLIC_EVIDENCE_CLASS,
  minWindowDays: MIN_WINDOW_DAYS,
});

/** The only demand-intelligence shape that may leave the server. */
export interface PublicOpportunityAggregate {
  schema: "pcc.public-opportunity-aggregate.v0";
  /** A CSD URI. Proposed types are strategy data and never public. */
  capabilityType: string;
  /** Banded distinct verified requesters at or above `countedEvidence`; never an exact count */
  demandBand: DemandBand;
  /** The evidence floor the band counts (policy, not data) */
  countedEvidence: DemandEvidenceClass;
  /** UTC day (YYYY-MM-DD) of the most recent unmet intent */
  asOf: string;
}

/**
 * Project a private signal into the public aggregate, or return `null` when it
 * must stay private. Returns `null` for:
 *   - prior-only signals (priors are strategy, not demand anyone expressed);
 *   - `proposed:` keys;
 *   - a window shorter than `policy.minWindowDays`;
 *   - fewer than `policy.k` distinct verified requesters whose strongest intent
 *     is at or above `policy.minEvidenceClass`. Volume from one caller, or
 *     query-only demand, never makes a type public.
 * Throws on an invalid signal or on a policy weaker than the floors, so it
 * fails closed. k-anonymity is a privacy floor, not a Sybil control: until
 * R28/R29 bind keys to identity, only `funded` evidence costs a forger money.
 */
export function toPublicOpportunityAggregate(
  signal: KitDemandSignal,
  policy: OpportunityAggregatePolicy = DEFAULT_OPPORTUNITY_POLICY,
): PublicOpportunityAggregate | null {
  if (!Number.isInteger(policy.k) || policy.k < MIN_PUBLIC_K) {
    throw new Error(`toPublicOpportunityAggregate: policy.k must be an integer >= ${MIN_PUBLIC_K}`);
  }
  if (!DEMAND_EVIDENCE_CLASSES.includes(policy.minEvidenceClass)) {
    throw new Error("toPublicOpportunityAggregate: unknown policy.minEvidenceClass");
  }
  if (evidenceClassRank(policy.minEvidenceClass) < evidenceClassRank(MIN_PUBLIC_EVIDENCE_CLASS)) {
    throw new Error(`toPublicOpportunityAggregate: policy.minEvidenceClass must be at least ${MIN_PUBLIC_EVIDENCE_CLASS}`);
  }
  if (!Number.isFinite(policy.minWindowDays) || policy.minWindowDays < MIN_WINDOW_DAYS) {
    throw new Error(`toPublicOpportunityAggregate: policy.minWindowDays must be >= ${MIN_WINDOW_DAYS}`);
  }
  const s = KitDemandSignalSchema.parse(signal);
  if (s.capabilityKey.startsWith("proposed:")) return null;
  if (s.internal === undefined) return null;
  const windowDays = (Date.parse(s.internal.windowTo) - Date.parse(s.internal.windowFrom)) / 86_400_000;
  if (windowDays < policy.minWindowDays) return null;
  const n = s.internal.distinctVerifiedRequestersAtOrAbove[policy.minEvidenceClass];
  if (n < policy.k) return null;
  const band = BANDS.find(([floor]) => n >= floor);
  if (band === undefined) return null;
  return {
    schema: "pcc.public-opportunity-aggregate.v0",
    capabilityType: s.capabilityKey,
    demandBand: band[1],
    countedEvidence: policy.minEvidenceClass,
    asOf: new Date(s.internal.lastSeen).toISOString().slice(0, 10),
  };
}
