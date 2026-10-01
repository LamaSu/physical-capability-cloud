/**
 * EvidenceProvenanceDTO (PX-7, the charter's EvidenceSummary/ProvenanceDTO): what the gateway can
 * truthfully say about one job's evidence, for ordinary users, with raw inspect pointers.
 * Vocabulary confirmed by the evidence lane (#3346, returns/pcc-evidence-work/
 * readmodels-evidence-summary-answers.md); facts map: returns/pcc-readmodels-work/
 * evidence-facts-map-20260924.md.
 *
 * What it never says:
 *   - "verified". The gateway stores no verifier or oracle verdict, so `verification` is
 *     `no_verdict_recorded` until one is stored. It is never read from a row existing, a count,
 *     or a status such as evidence_submitted.
 *   - "signed" or "authentic". No stored bundle's signature has ever been checked, so
 *     `signature.checked` is false. The signer is shown as stored, except a gateway-created
 *     placeholder — the zero-address signer that PUT /complete writes for events it synthesized,
 *     or the "self-attest"/algorithm:"none" pair the deviceless-kernel setup route writes
 *     (routes/setup.ts) — which is no signature at all: signer and algorithm null.
 *   - "archived". No archive CID is stored for any bundle.
 *   - anything about fabricated or gateway-stamped events except that they exist. Neither counts
 *     toward tier coverage, nor does an event that names no device at all (a missing `source`, or
 *     `source.deviceId` absent/empty): no device reported a gateway-stamped event (source.deviceId
 *     "gateway"; PUT /complete stamps its own events and the caller's body events so), and no
 *     device reported an event that names none.
 *
 * integrity: recomputed on read. Each state names exactly one model, so a surface that reads
 * only `state` cannot mistake storage integrity for evidence integrity (evidence #3680 F3).
 *   - recomputed_match (model event_bundle_hash) is EVIDENCE integrity, the one LO-EV model
 *     (what /settle recomputes): every event hash reproduces from {type, timestamp, source,
 *     payload}, and the bundle hash reproduces from the sorted event hashes.
 *   - storage_envelope_match (model gateway_envelope) is only the gateway's STORAGE integrity
 *     (the envelope its /complete route hashes): the stored bundle and events are the bytes that
 *     were hashed. It is never evidence integrity, and /settle would refuse such a bundle.
 *   - no_model_reproduces is not proof of tampering (a device or relay hash has no model here,
 *     or a stored value cannot be canonicalized), and not_recomputable means there are no events
 *     to recompute from.
 */

export const EVIDENCE_PROVENANCE_SCHEMA_ID = "pcc.evidence-provenance/v1" as const;

export type EvidenceIntegrityState = "recomputed_match" | "storage_envelope_match" | "no_model_reproduces" | "not_recomputable";

/** event_bundle_hash: evidence integrity (LO-EV). gateway_envelope: gateway storage integrity only. */
export type EvidenceIntegrityModel = "event_bundle_hash" | "gateway_envelope";

/** A stored field of an evidence bundle row (`bundle.`) or of one of its events (`event.`). */
export type EvidenceStoredField =
  | "bundle.id"
  | "bundle.jobId"
  | "bundle.stepId"
  | "bundle.kernelId"
  | "bundle.assuranceTier"
  | "bundle.createdAt"
  | "bundle.kernelSignature"
  | "bundle.bundleHash"
  | "event.id"
  | "event.type"
  | "event.timestamp"
  | "event.source"
  | "event.payload"
  | "event.hash";

export const EVIDENCE_STORED_FIELDS: readonly EvidenceStoredField[] = Object.freeze([
  "bundle.id", "bundle.jobId", "bundle.stepId", "bundle.kernelId", "bundle.assuranceTier", "bundle.createdAt",
  "bundle.kernelSignature", "bundle.bundleHash", "event.id", "event.type", "event.timestamp", "event.source",
  "event.payload", "event.hash",
] as const);

/**
 * Which stored fields a model's match vouches for (cross-family review r1b of #441, MEDIUM 2).
 * The LO-EV event hash commits only {type, timestamp, source, payload}, and the bundle hash only
 * the sorted event hashes, so a recomputed_match says nothing about the row's own id, job, step,
 * kernel, claimed tier, time or signature, or an event's id: those are shown as stored. The
 * /complete envelope binds every stored field, but it is storage integrity only.
 */
export const INTEGRITY_COVERAGE: Readonly<Record<EvidenceIntegrityModel, readonly EvidenceStoredField[]>> = Object.freeze({
  event_bundle_hash: Object.freeze(["event.type", "event.timestamp", "event.source", "event.payload", "event.hash", "bundle.bundleHash"] as const),
  gateway_envelope: EVIDENCE_STORED_FIELDS,
});

interface IntegrityFields {
  /** The stored fields this result vouches for; empty when no model reproduces. */
  covers: readonly EvidenceStoredField[];
  /** Every other stored field: shown as stored, and covered by no hash here. */
  notCovered: readonly EvidenceStoredField[];
}

/** Recomputed integrity: each state pairs with exactly one model (or none), and says what it covers. */
export type EvidenceIntegrity =
  | ({ state: "recomputed_match"; model: "event_bundle_hash" } & IntegrityFields)
  | ({ state: "storage_envelope_match"; model: "gateway_envelope" } & IntegrityFields)
  | ({ state: "no_model_reproduces" | "not_recomputable"; model: null } & IntegrityFields);

export type TierCoverageState = "covers" | "missing" | "unknown_tier";

export interface ProvenanceBundle {
  bundleId: string;
  stepId: string;
  kernelId: string;
  /** When the gateway stored the bundle, as recorded. */
  storedAt: string;
  /** The bundle hash as stored. */
  bundleHash: string;
  /** The assurance tier the producer CLAIMED; null when it is not 0-3. */
  claimedTier: 0 | 1 | 2 | 3 | null;
  events: {
    count: number;
    /** Distinct event types, sorted. */
    types: string[];
    /** Fabricated by design (source.simulated or payload.mock). */
    fabricated: number;
    /** Written by the gateway itself (source.deviceId "gateway"), not by a device. */
    gatewayAuthored: number;
    /**
     * Earliest and latest event timestamps, ordered by the time they parse to and shown as
     * recorded; null without a parseable timestamp.
     */
    firstAt: string | null;
    lastAt: string | null;
  };
  /**
   * As stored; a gateway-created placeholder is no signature (signer and algorithm null): the
   * zero-address signer, or the deviceless-kernel setup route's "self-attest"/"none" pair.
   */
  signature: { signer: string | null; algorithm: string | null; checked: false };
  integrity: EvidenceIntegrity;
  /**
   * Do the recorded event types that a DEVICE reported (neither fabricated, gateway-stamped, nor
   * without a device identity) include what the claimed tier requires
   * (DEFAULT_TIER_REQUIREMENTS)? Self-reported events, not a verification.
   */
  tierCoverage: {
    state: TierCoverageState;
    /** The claimed tier's required groups; any one type in a group satisfies it. */
    required: string[][];
    /** Required groups that no counted event satisfies. */
    missing: string[][];
    minimumEvents: number | null;
    /**
     * Events counted: all except fabricated ones, gateway-stamped ones, and events that name no
     * device at all (a missing `source`, or `source.deviceId` absent/empty) — an event with no
     * device identity is not evidence a device reported it, so it never counts toward coverage,
     * the same as an explicitly gateway-stamped one.
     */
    countedEvents: number;
    basis: "recorded_event_types";
  };
  /** No archive CID is stored for any bundle. */
  archive: { state: "not_recorded" };
  /** METHOD + path of the raw reads. */
  inspect: { envelope: string; events: string };
}

export interface EvidenceProvenanceDTO {
  schemaId: typeof EVIDENCE_PROVENANCE_SCHEMA_ID;
  /** When the gateway read its records (ISO-8601). */
  asOf: string;
  jobId: string;
  /** none: no bundle recorded. unavailable: the evidence store could not be read. */
  state: "none" | "received" | "unavailable";
  reason: string | null;
  /** Newest first. */
  bundles: ProvenanceBundle[];
  counts: { bundles: number; events: number; fabricatedEvents: number; gatewayAuthoredEvents: number } | null;
  verification: { state: "no_verdict_recorded"; reason: string };
  source: "gateway_evidence_store";
}
