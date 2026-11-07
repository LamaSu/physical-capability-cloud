/**
 * Unmet-demand lens (ledger R44, D3) — turns server-captured UNMET intents into
 * private `KitDemandSignal` records for pcc-kits.
 *
 * The existing DemandAggregator ranks ALL demand (popularity). This lens ranks
 * only demand PCC could not serve, per capability type, which is the input a
 * kit-build bounty needs. Every rule below defends against a caller forging
 * demand to steer what gets funded:
 *
 *  - Only first-party capture event types are read. `intent.external_ingest`
 *    (caller-asserted envelopes from /api/intents/ingest) is never read.
 *  - An intent counts only if the SERVER marked it unmet: the payload parses
 *    with `ServerCapturedDemandEnvelopeSchema`, `fulfillmentPath` is
 *    "unfulfilled" and `unmet` is non-empty.
 *  - Breadth (`distinctVerifiedRequesters`) counts only PROVEN principals:
 *    rows with `actorType === VERIFIED_ACTOR_TYPE`. Gateway capture (D2, flag
 *    PCC_UNMET_CAPTURE_ENABLED, default OFF) sets it only for a proven wallet
 *    (an /a2a SIWE session, or `req.provenWallet` once gateway binds it) and
 *    records a plain API-key holder as "authenticated_key", which counts as
 *    volume only. With the flag off, every capture point takes its actor from
 *    the request body, so breadth is 0 and nothing can clear the public k.
 *  - `firstSeen` / `lastSeen` come from the row's server timestamp, never from
 *    the envelope's `createdAt`.
 *  - Counting is exact (a Set), not HyperLogLog: the public k threshold must
 *    never be crossed on an estimate.
 *  - A key's form must match its reason (`resolveCapabilityKey`): a CSD-shaped
 *    key never stands for `no_capability_type`, and a caller-supplied
 *    registered set can drop unregistered URIs.
 *  - Evidence classes come from the event type (`SERVER_CAPTURE_EVENT_CLASSES`).
 *    No capture point produces `funded` evidence yet; budget-backed demand
 *    (approved asset-outbound budgets, funded job offers) becomes `funded` only
 *    when the gateway emits it (D2).
 *
 * PRIVATE output. `compute()` takes any window for private analysis; a public
 * release takes only `computeForPeriod()` output, because
 * `toPublicOpportunityAggregate()` / `buildPublicRelease()` (@pcc/spec) refuse
 * any window that is not exactly one closed release period.
 */

import {
  CAPABILITY_SLUG_PATTERN,
  CSD_URI_PATTERN,
  ServerCapturedDemandEnvelopeSchema,
  KitDemandSignalSchema,
  releasePeriodWindow,
  DEMAND_EVIDENCE_CLASSES,
  evidenceClassRank,
  type KitDemandSignal,
  type KitDemandPriorRef,
  type DemandEvidenceClass,
  type UnmetReason,
  type BudgetBand,
  type UrgencyBand,
  type AssuranceTierKey,
  type ReleasePeriod,
} from "@pcc/spec";
import type { IRepositories } from "@pcc/store";

/** `actorType` a first-party capture point sets when it records the authenticated principal. */
export const VERIFIED_ACTOR_TYPE = "authenticated_operator";

/** The only event types this lens reads, and the evidence class each carries. */
export const SERVER_CAPTURE_EVENT_CLASSES: Readonly<Record<string, DemandEvidenceClass>> = Object.freeze({
  "intent.composite_request": "authenticated_order",
  "intent.atomic_session": "authenticated_order",
  "intent.synthetic_query": "query",
});

const COUNTRY = /^([A-Za-z]{2})(-[A-Za-z0-9]{1,3})?$/;

/**
 * Reduce an envelope region to an ISO 3166-1 alpha-2 country, or "unknown".
 * Sub-country detail ("US-CA") is dropped, never kept.
 */
export function normalizeCountry(region: string | undefined): string {
  const m = region === undefined ? null : COUNTRY.exec(region.trim());
  return m ? m[1]!.toUpperCase() : "unknown";
}

/**
 * Map an unmet capability to a signal key, checking the reason FIRST. A type
 * with no CSD (`no_capability_type`) must arrive as a slug and becomes
 * `proposed:<slug>`; a URI-shaped key with that reason is refused, so a
 * requester-derived label cannot pose as a registered type. Every other reason
 * must arrive as a CSD URI, which must be in `registeredCsdUris` when that set
 * is given. Anything else is unresolvable and is dropped (counted in
 * diagnostics).
 */
export function resolveCapabilityKey(
  capabilityType: string,
  reason: UnmetReason,
  registeredCsdUris?: ReadonlySet<string>,
): string | null {
  if (reason === "no_capability_type") {
    return CAPABILITY_SLUG_PATTERN.test(capabilityType) ? `proposed:${capabilityType}` : null;
  }
  if (!CSD_URI_PATTERN.test(capabilityType)) return null;
  if (registeredCsdUris !== undefined && !registeredCsdUris.has(capabilityType)) return null;
  return capabilityType;
}

export interface UnmetLensOptions {
  /** Window start, ISO 8601, inclusive */
  from: string;
  /** Window end, ISO 8601, inclusive */
  to: string;
  /** Private priors keyed by capability key (CSD URI or proposed:<slug>) */
  priors?: ReadonlyMap<string, KitDemandPriorRef>;
  /** When given, CSD URIs outside this set are dropped as unresolved */
  registeredCsdUris?: ReadonlySet<string>;
  /** Clock for computedAt (injectable for deterministic tests) */
  now?: () => string;
}

export interface UnmetLensDiagnostics {
  rowsRead: number;
  outsideWindow: number;
  invalidPayload: number;
  notUnmet: number;
  unresolvedCapability: number;
  verifiedRows: number;
}

export interface UnmetLensResult {
  /** One validated signal per capability key, sorted by key */
  signals: KitDemandSignal[];
  diagnostics: UnmetLensDiagnostics;
}

interface Accumulator {
  unmetCount: number;
  byEvidenceClass: Record<DemandEvidenceClass, number>;
  /** Verified principal -> rank of its strongest evidence class for this key */
  strongest: Map<string, number>;
  /** Verified principals seen in each class for this key */
  principalsByClass: Record<DemandEvidenceClass, Set<string>>;
  reasons: Map<UnmetReason, number>;
  bands: Map<BudgetBand, number>;
  urgency: Map<UrgencyBand, number>;
  tiers: Map<AssuranceTierKey, number>;
  countries: Map<string, number>;
  firstSeenMs: number;
  lastSeenMs: number;
}

function increment<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedRecord<K extends string>(map: Map<K, number>): Partial<Record<K, number>> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as Partial<
    Record<K, number>
  >;
}

export class UnmetDemandLens {
  constructor(private readonly repos: Pick<IRepositories, "analytics">) {}

  compute(options: UnmetLensOptions): UnmetLensResult {
    const fromMs = Date.parse(options.from);
    const toMs = Date.parse(options.to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs > toMs) {
      throw new Error("UnmetDemandLens: from/to must be ISO timestamps with from <= to");
    }

    const diagnostics: UnmetLensDiagnostics = {
      rowsRead: 0,
      outsideWindow: 0,
      invalidPayload: 0,
      notUnmet: 0,
      unresolvedCapability: 0,
      verifiedRows: 0,
    };
    const accumulators = new Map<string, Accumulator>();

    for (const [eventType, evidenceClass] of Object.entries(SERVER_CAPTURE_EVENT_CLASSES)) {
      for (const row of this.repos.analytics.findEventsByType(eventType)) {
        diagnostics.rowsRead++;
        const ts = Date.parse(row.timestamp);
        if (Number.isNaN(ts) || ts < fromMs || ts > toMs) {
          diagnostics.outsideWindow++;
          continue;
        }
        const parsed = ServerCapturedDemandEnvelopeSchema.safeParse(row.payload);
        if (!parsed.success) {
          diagnostics.invalidPayload++;
          continue;
        }
        const envelope = parsed.data;
        if (envelope.fulfillmentPath !== "unfulfilled" || !envelope.unmet || envelope.unmet.length === 0) {
          diagnostics.notUnmet++;
          continue;
        }
        const principal = row.actorType === VERIFIED_ACTOR_TYPE && row.actorId ? row.actorId : null;
        if (principal !== null) diagnostics.verifiedRows++;

        const keysInIntent = new Set<string>();
        for (const unmet of envelope.unmet) {
          const key = resolveCapabilityKey(unmet.capabilityType, unmet.reason, options.registeredCsdUris);
          if (key === null) {
            diagnostics.unresolvedCapability++;
            continue;
          }
          if (keysInIntent.has(key)) continue; // one count per (intent, key); the first reason wins
          keysInIntent.add(key);

          let acc = accumulators.get(key);
          if (acc === undefined) {
            acc = {
              unmetCount: 0,
              byEvidenceClass: { query: 0, authenticated_order: 0, funded: 0 },
              strongest: new Map(),
              principalsByClass: { query: new Set(), authenticated_order: new Set(), funded: new Set() },
              reasons: new Map(),
              bands: new Map(),
              urgency: new Map(),
              tiers: new Map(),
              countries: new Map(),
              firstSeenMs: ts,
              lastSeenMs: ts,
            };
            accumulators.set(key, acc);
          }
          acc.unmetCount++;
          acc.byEvidenceClass[evidenceClass]++;
          increment(acc.reasons, unmet.reason);
          increment(acc.bands, envelope.budgetBand);
          increment(acc.urgency, envelope.urgencyBand);
          increment(acc.countries, normalizeCountry(envelope.geographicRegion));
          if (envelope.assuranceTier !== undefined) {
            increment(acc.tiers, String(envelope.assuranceTier) as AssuranceTierKey);
          }
          if (principal !== null) {
            acc.principalsByClass[evidenceClass].add(principal);
            const rank = evidenceClassRank(evidenceClass);
            acc.strongest.set(principal, Math.max(acc.strongest.get(principal) ?? -1, rank));
          }
          acc.firstSeenMs = Math.min(acc.firstSeenMs, ts);
          acc.lastSeenMs = Math.max(acc.lastSeenMs, ts);
        }
      }
    }

    const computedAt = options.now ? options.now() : new Date().toISOString();
    const windowFrom = new Date(fromMs).toISOString();
    const windowTo = new Date(toMs).toISOString();
    const keys = new Set<string>([...accumulators.keys(), ...(options.priors?.keys() ?? [])]);
    const signals: KitDemandSignal[] = [];
    for (const key of [...keys].sort()) {
      const acc = accumulators.get(key);
      const prior = options.priors?.get(key);
      let internal: KitDemandSignal["internal"];
      if (acc) {
        const atOrAbove = { query: 0, authenticated_order: 0, funded: 0 };
        for (const rank of acc.strongest.values()) {
          for (const c of DEMAND_EVIDENCE_CLASSES) if (rank >= evidenceClassRank(c)) atOrAbove[c]++;
        }
        internal = {
          windowFrom,
          windowTo,
          unmetCount: acc.unmetCount,
          byEvidenceClass: { ...acc.byEvidenceClass },
          distinctVerifiedRequestersByClass: {
            query: acc.principalsByClass.query.size,
            authenticated_order: acc.principalsByClass.authenticated_order.size,
            funded: acc.principalsByClass.funded.size,
          },
          distinctVerifiedRequestersAtOrAbove: atOrAbove,
          distinctVerifiedRequesters: acc.strongest.size,
          reasonHistogram: sortedRecord(acc.reasons),
          budgetBandHistogram: sortedRecord(acc.bands),
          urgencyHistogram: sortedRecord(acc.urgency),
          assuranceTierHistogram: sortedRecord(acc.tiers),
          countryHistogram: sortedRecord(acc.countries) as Record<string, number>,
          firstSeen: new Date(acc.firstSeenMs).toISOString(),
          lastSeen: new Date(acc.lastSeenMs).toISOString(),
        };
      }
      const candidate: KitDemandSignal = {
        schema: "pcc.kit-demand-signal.v0",
        capabilityKey: key,
        ...(internal ? { internal } : {}),
        ...(prior ? { prior } : {}),
        computedAt,
      };
      // Fail closed: a signal that violates its own schema is a bug, never output.
      signals.push(KitDemandSignalSchema.parse(candidate) as KitDemandSignal);
    }
    return { signals, diagnostics };
  }

  /**
   * Compute over exactly one release period (a UTC calendar month, "YYYY-MM"):
   * the only window a public release accepts.
   */
  computeForPeriod(period: ReleasePeriod, options: Omit<UnmetLensOptions, "from" | "to"> = {}): UnmetLensResult {
    const { from, to } = releasePeriodWindow(period);
    return this.compute({ ...options, from, to });
  }
}
