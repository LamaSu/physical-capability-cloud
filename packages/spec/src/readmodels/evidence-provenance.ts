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
 *     `signature.checked` is false. The signer is shown as stored.
 *   - "archived". No archive CID is stored for any bundle.
 *   - anything about fabricated events except that they exist. They never count toward tier
 *     coverage.
 *
 * integrity: recomputed on read.
 *   - event_bundle_hash is EVIDENCE integrity, the one LO-EV model (what /settle recomputes):
 *     every event hash reproduces from {type, timestamp, source, payload}, and the bundle hash
 *     reproduces from the sorted event hashes.
 *   - gateway_envelope is only the gateway's STORAGE integrity (the envelope its /complete
 *     route hashes): the stored bundle and events are the bytes that were hashed. It is never
 *     evidence integrity.
 *   - no_model_reproduces is not proof of tampering (a device or relay hash has no model here),
 *     and not_recomputable means there are no events to recompute from.
 */

export const EVIDENCE_PROVENANCE_SCHEMA_ID = "pcc.evidence-provenance/v1" as const;

export type EvidenceIntegrityState = "recomputed_match" | "no_model_reproduces" | "not_recomputable";

/** event_bundle_hash: evidence integrity (LO-EV). gateway_envelope: gateway storage integrity only. */
export type EvidenceIntegrityModel = "event_bundle_hash" | "gateway_envelope";

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
    /** Earliest and latest event timestamps, as recorded; null without events. */
    firstAt: string | null;
    lastAt: string | null;
  };
  signature: { signer: string | null; algorithm: string | null; checked: false };
  integrity: { state: EvidenceIntegrityState; model: EvidenceIntegrityModel | null };
  /**
   * Do the recorded NON-fabricated event types include what the claimed tier requires
   * (DEFAULT_TIER_REQUIREMENTS)? Self-reported events, not a verification.
   */
  tierCoverage: {
    state: TierCoverageState;
    /** The claimed tier's required groups; any one type in a group satisfies it. */
    required: string[][];
    /** Required groups that no counted event satisfies. */
    missing: string[][];
    minimumEvents: number | null;
    /** Events counted: all except fabricated ones. */
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
