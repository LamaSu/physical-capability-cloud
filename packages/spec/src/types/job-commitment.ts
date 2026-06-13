/**
 * Job commitments + evidence bundles — pre-commit / hash-commit-reveal layer.
 *
 * Before any physical work begins, every party (shop, driver, user) pre-commits:
 *   1. The oracle is notified of the expected events (the `promise` + its
 *      `evidenceRequirements`).
 *   2. Each party places a hash-commitment to a secret (`commitmentHash`) for
 *      later fraud detection — revealed only after the job completes.
 *   3. Each party stakes funds (`stakeUSD`) that are slashed on fraud.
 *   4. Escrow locks once all parties have staked; only then is work dispatched.
 *
 * Evidence is then collected as the work happens. Each `EvidenceBundle` carries
 * an array of typed evidence items so a single shape covers both the shop's
 * single "pizza is ready" bundle and the driver's incremental breadcrumb +
 * delivery-photo bundles.
 *
 * Companion to:
 *   - `/api/demo/orders/*` — order lifecycle (pizza-demo.ts)
 *   - `/api/demo/jobs/*`   — commitments, stakes, evidence, reveals (pizza-oracle.ts)
 *   - `/api/escrow/*`      — real settlement (mocked in the demo)
 */

/** Who/what role a party plays in a job's pre-commit set. */
export type CommitmentPartyRole = "shop" | "driver" | "user" | "oracle";

/**
 * Lifecycle of a single commitment.
 *
 * `pending`   — template generated at pre-commit; party has not staked yet.
 * `committed` — party staked funds + posted its commitmentHash.
 * `revealed`  — party revealed its secret; hash verified (no fraud).
 * `slashed`   — reveal failed verification → fraud; stake forfeited.
 * `released`  — job settled honestly; stake returned / payout made.
 */
export type CommitmentStatus =
  | "pending"
  | "committed"
  | "revealed"
  | "slashed"
  | "released";

/** Kinds of evidence a party can be asked to produce / can submit. */
export type EvidenceKind =
  | "photo"
  | "geolocation"
  | "timestamp"
  | "hash"
  | "attestation";

/**
 * One thing a party promises to prove. The oracle checks submitted evidence
 * against the matching requirement (right kind, inside the geofence, within
 * the time window).
 */
export interface EvidenceRequirement {
  kind: EvidenceKind;
  /** Human-readable: "photo of pizza in box". */
  description: string;
  /** If set, a geolocation evidence item must be within `radiusM` metres. */
  geoConstraint?: { lat: number; lng: number; radiusM: number };
  /** If set, the evidence timestamp must be within `withinSec` of the event. */
  timeConstraint?: { withinSec: number };
}

/**
 * A party's pre-commitment for a job: what it promises to do/produce, the
 * hash it commits to now (reveals later for fraud detection), and the stake it
 * locks behind that promise.
 */
export interface JobCommitment {
  commitmentId: string;
  jobId: string;
  orderId: string;
  /** Who committed (shop slug, driver slug, or user id). */
  partyId: string;
  partyRole: CommitmentPartyRole;
  /** What the party promises to do/produce. */
  promise: {
    description: string;
    evidenceRequirements: EvidenceRequirement[];
    deadlineSec: number;
    priceUSD?: number;
  };
  /**
   * Hash-commit: the party commits to a secret now — `hash(secret + jobId +
   * partyId)` — and reveals it later. A mismatched reveal signals fraud.
   * Empty until the party stakes.
   */
  commitmentHash: string;
  /** Only populated after the party reveals (job complete). */
  revealedSecret?: string;
  /** Escrowed by the party — slashed on fraud, returned on honest completion. */
  stakeUSD: number;
  status: CommitmentStatus;
  createdAt: string;
  /** Set once the party stakes (transitions from template → committed). */
  stakedAt?: string;
  /** Set on reveal / slash / release. */
  resolvedAt?: string;
}

/**
 * A single typed piece of evidence inside a bundle.
 *
 * Named `CommitmentEvidenceItem` (not `EvidenceItem`) to sit alongside the
 * canonical cryptographic-evidence model in `evidence.ts` without clobbering it.
 */
export interface CommitmentEvidenceItem {
  kind: EvidenceKind;
  photoBase64?: string;
  geo?: { lat: number; lng: number; capturedAt: string };
  timestamp?: string;
  hash?: string;
  signature?: string;
  /** Free-form label, e.g. "pickup" vs "delivery" for the driver. */
  label?: string;
}

/**
 * A content-addressed collection of evidence items submitted by one party.
 *
 * Shop bundle:   one `photo` + one `geolocation` + one `timestamp`.
 * Driver bundle: many `geolocation` breadcrumbs (sampled in transit) plus a
 *                `photo` + `timestamp` on pickup and again on delivery.
 *
 * Named `CommitmentEvidenceBundle` (not `EvidenceBundle`) so it does not
 * collide with the canonical cryptographic-evidence bundle in `evidence.ts`.
 * The over-the-wire JSON shape is exactly the spec'd `EvidenceBundle`.
 */
export interface CommitmentEvidenceBundle {
  bundleId: string;
  jobId: string;
  partyId: string;
  evidence: CommitmentEvidenceItem[];
  /** sha256 over the canonicalized evidence array. */
  bundleHash: string;
  createdAt: string;
}
