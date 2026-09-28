/**
 * Kit demand — the demand input for Capability Kit builds (ledger R44 → R7 / R45 / PX-13).
 *
 * Three privacy classes, never merged:
 *   1. First-party intents (`DemandEnvelope`, `intent.*` events) — PRIVATE.
 *   2. Priors (desk research, external complaint corpora) — PRIVATE strategy data.
 *   3. Public opportunity aggregates — produced ONLY by
 *      `toPublicOpportunityAggregate()` / `buildPublicRelease()` under one fixed
 *      release policy, for a closed UTC calendar month, for publisher-approved
 *      CSD IDs only, labelled by period (never an activity date).
 *
 * This module holds types and pure functions. The data they describe is
 * private; no real record of it belongs in this public package or its tests.
 */
import { z } from "zod";
import { sha256 as sha256Hash } from "@noble/hashes/sha256";
import { canonicalize } from "../util/canonical.js";
import type { SHA256 } from "./common.js";
import {
  CAPABILITY_SLUG_PATTERN,
  CSD_URI_PATTERN,
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

/** The same key forms the lens emits: a CSD URI, or `proposed:` plus a no-CSD slug. */
export const CapabilityKeySchema = z
  .string()
  .refine(
    (k) =>
      CSD_URI_PATTERN.test(k) || (k.startsWith("proposed:") && CAPABILITY_SLUG_PATTERN.test(k.slice("proposed:".length))),
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
  return canonicalDigest(KitDemandSignalSchema.parse(signal));
}

// ── Public projection ────────────────────────────────────────────
//
// PX-13 round-1 review (pack 10) showed that a stateless projection with
// caller-chosen policy and windows is an oracle across calls. The public
// release is therefore FIXED and PERIODIC:
//   - one server-owned release policy: no caller-chosen k, floor or window
//     (finding 1);
//   - canonical, non-overlapping UTC calendar-month periods, released only
//     after the period has closed (finding 2);
//   - only capability IDs the publisher approved: registered CSD URIs, never a
//     proposed or requester-derived label, and never an ID whose slug could
//     carry a date, place code or counter (finding 3);
//   - a period label, never an activity date (finding 4).
// Releasing each period exactly once (a write-once ledger) and any
// cross-release privacy budget belong to the publisher (kits, PX-13).

/** The fixed public release policy. Changing it is a code change, never a parameter. */
export const PUBLIC_RELEASE_POLICY: Readonly<{ k: number; evidenceFloor: DemandEvidenceClass; graceMs: number }> =
  Object.freeze({
    /** Minimum distinct verified requesters at or above the evidence floor */
    k: 5,
    /** Only requesters whose strongest intent is at least this class are counted */
    evidenceFloor: "authenticated_order",
    /** A period becomes releasable only this long after it ends */
    graceMs: 24 * 60 * 60 * 1000,
  });

export type DemandBand = "5-9" | "10-24" | "25-99" | "100+";

const BANDS: ReadonlyArray<readonly [number, DemandBand]> = [
  [100, "100+"],
  [25, "25-99"],
  [10, "10-24"],
  [5, "5-9"],
];

/** A UTC calendar month, "YYYY-MM" (2000-2099). */
export type ReleasePeriod = string;

const PERIOD_PATTERN = /^(20[0-9]{2})-(0[1-9]|1[0-2])$/;

/** The exact window a signal must cover to be released for `period`. Throws if malformed. */
export function releasePeriodWindow(period: ReleasePeriod): { from: string; to: string } {
  const m = PERIOD_PATTERN.exec(period);
  if (!m) throw new Error(`releasePeriodWindow: "${period}" is not a YYYY-MM period`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const start = Date.UTC(year, month - 1, 1);
  const next = Date.UTC(year, month, 1);
  return { from: new Date(start).toISOString(), to: new Date(next - 1).toISOString() };
}

/** When `period` becomes releasable: its end plus the policy's grace. */
function releaseOpensAtMs(period: ReleasePeriod): number {
  return Date.parse(releasePeriodWindow(period).to) + 1 + PUBLIC_RELEASE_POLICY.graceMs;
}

/** True once `period` ended at least the policy's grace ago (by the server clock). */
export function isReleasePeriodClosed(period: ReleasePeriod): boolean {
  return Date.now() >= releaseOpensAtMs(period);
}

const PUBLIC_ID_PATTERN = /^pcc:\/\/capabilities\/([a-z0-9-]{1,40})\/v[0-9]{1,6}$/;

/**
 * Whether a capability ID may appear in a public release at all: a CSD URI
 * whose slug has at most 40 characters, at most 3 hyphens and no run of 4 or
 * more digits, so an approved ID cannot smuggle a date, place code or counter.
 * This is defense in depth behind the publisher's approved set (kits, #3405);
 * the publisher reuses it to exclude and privately log a failing ID.
 */
export function isPublishableCapabilityId(id: string): boolean {
  const m = PUBLIC_ID_PATTERN.exec(id);
  if (m === null) return false;
  const slug = m[1]!;
  return (slug.match(/-/g)?.length ?? 0) <= 3 && !/[0-9]{4}/.test(slug);
}

function assertReleasable(period: ReleasePeriod): { from: string; to: string } {
  const bounds = releasePeriodWindow(period);
  if (!isReleasePeriodClosed(period)) {
    throw new Error(`public release: period ${period} has not closed; only closed periods are released`);
  }
  return bounds;
}

/** The only demand-intelligence shape that may leave the server. */
export interface PublicOpportunityAggregate {
  schema: "pcc.public-opportunity-aggregate.v1";
  /** A publisher-approved, registered CSD URI */
  capabilityType: string;
  /** Banded distinct verified requesters at or above the fixed floor; never exact */
  demandBand: DemandBand;
  /** The fixed evidence floor the band counts (policy, not data) */
  countedEvidence: DemandEvidenceClass;
  /** The closed release period, e.g. "2026-09" */
  period: ReleasePeriod;
}

/**
 * Project one private signal into the public aggregate for a closed release
 * period, or return `null` when it must stay private: a key that is not in
 * the publisher's approved set or fails `isPublishableCapabilityId` (so never
 * `proposed:` or a CSD-shaped label), a prior-only signal, or fewer than the
 * fixed k verified requesters at or above the fixed floor. Throws on misuse: a malformed or still-open period, a
 * signal computed before that period closed or over any window other than
 * exactly that period, or an invalid signal. There is no policy parameter by
 * design.
 */
export function toPublicOpportunityAggregate(
  signal: KitDemandSignal,
  period: ReleasePeriod,
  approvedCapabilityTypes: ReadonlySet<string>,
): PublicOpportunityAggregate | null {
  const bounds = assertReleasable(period);
  const s = KitDemandSignalSchema.parse(signal);
  if (Date.parse(s.computedAt) < releaseOpensAtMs(period)) {
    throw new Error(`public release: signal computed at ${s.computedAt}, before period ${period} closed`);
  }
  if (
    s.internal !== undefined &&
    (Date.parse(s.internal.windowFrom) !== Date.parse(bounds.from) ||
      Date.parse(s.internal.windowTo) !== Date.parse(bounds.to))
  ) {
    throw new Error(
      `public release: signal window ${s.internal.windowFrom}..${s.internal.windowTo} is not release period ${period}`,
    );
  }
  if (!isPublishableCapabilityId(s.capabilityKey)) return null;
  if (!approvedCapabilityTypes.has(s.capabilityKey)) return null;
  if (s.internal === undefined) return null;
  const n = s.internal.distinctVerifiedRequestersAtOrAbove[PUBLIC_RELEASE_POLICY.evidenceFloor];
  if (n < PUBLIC_RELEASE_POLICY.k) return null;
  const band = BANDS.find(([floor]) => n >= floor);
  if (band === undefined) return null;
  return {
    schema: "pcc.public-opportunity-aggregate.v1",
    capabilityType: s.capabilityKey,
    demandBand: band[1],
    countedEvidence: PUBLIC_RELEASE_POLICY.evidenceFloor,
    period,
  };
}

/** One period's public release: the unit a publisher records once in a write-once ledger. */
export interface PublicOpportunityRelease {
  schema: "pcc.public-opportunity-release.v1";
  period: ReleasePeriod;
  policy: { k: number; evidenceFloor: DemandEvidenceClass };
  /** `sha256:<hex>` over the sorted approved set the publisher supplied, so the release records its input */
  approvedSetDigest: SHA256;
  /** Qualifying aggregates only, sorted by capabilityType */
  aggregates: PublicOpportunityAggregate[];
  /** `sha256:<hex>` over the canonical JSON of every field above */
  digest: SHA256;
}

/**
 * Build the public release for a closed period from one signal per capability
 * key. Signals that do not qualify are simply absent. Throws on a duplicate
 * key or on any misuse `toPublicOpportunityAggregate` rejects. Deterministic:
 * the same signals, period and approved set give the same release and digest.
 */
export function buildPublicRelease(
  signals: readonly KitDemandSignal[],
  period: ReleasePeriod,
  approvedCapabilityTypes: ReadonlySet<string>,
): PublicOpportunityRelease {
  assertReleasable(period);
  const seen = new Set<string>();
  const aggregates: PublicOpportunityAggregate[] = [];
  for (const signal of signals) {
    if (seen.has(signal.capabilityKey)) {
      throw new Error(`public release: more than one signal for ${signal.capabilityKey}`);
    }
    seen.add(signal.capabilityKey);
    const aggregate = toPublicOpportunityAggregate(signal, period, approvedCapabilityTypes);
    if (aggregate !== null) aggregates.push(aggregate);
  }
  aggregates.sort((a, b) => byString(a.capabilityType, b.capabilityType));
  const body = {
    schema: "pcc.public-opportunity-release.v1" as const,
    period,
    policy: { k: PUBLIC_RELEASE_POLICY.k, evidenceFloor: PUBLIC_RELEASE_POLICY.evidenceFloor },
    approvedSetDigest: canonicalDigest([...approvedCapabilityTypes].sort(byString)),
    aggregates,
  };
  return { ...body, digest: canonicalDigest(body) };
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalDigest(value: unknown): SHA256 {
  const bytes = sha256Hash(new TextEncoder().encode(canonicalize(value)));
  return `sha256:${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as SHA256;
}
