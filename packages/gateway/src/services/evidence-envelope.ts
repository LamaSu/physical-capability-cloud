/**
 * Canonical evidence envelope — the exact bytes `GET /api/evidence/:hash`
 * serves to the verification oracle.
 *
 * The oracle re-hashes the RAW response bytes to the committed evidenceHash
 * and fails closed on mismatch (pcc-oracle evidence-checker.ts,
 * fetchAndVerifyEvidence — "the gateway must serve the EXACT stored bundle
 * bytes"). Two consequences:
 *
 *   1. The serialization must be byte-DETERMINISTIC across the DB round-trip:
 *      canonicalize() (from @pcc/spec, sorted keys / no whitespace) plus an
 *      explicit event sort by id. Drizzle's JSON columns round-trip values
 *      exactly; key order and array order are pinned here.
 *   2. The envelope must CONTAIN the events (source.simulated / payload.mock
 *      ride inside), because the oracle's authenticity-of-origin floor
 *      (pcc-oracle PR #15) reads `bundle.events[]` off the hash-verified
 *      document. A doc without events verifies but detects nothing.
 *
 * `bundleHash` itself is EXCLUDED (a document cannot contain its own hash);
 * `tenantId` is excluded (gateway-internal scoping, not evidence content).
 *
 * Which producers align with this envelope:
 *   - Path-B gateway-synth bundles (paid-job-flow complete) commit
 *     `bundleHash = sha256(<this envelope>)` — raw-byte re-hash VERIFIES.
 *   - Path-A kernel bundles commit `bundleHash = hashBundle(events)` (the
 *     sorted event-HASH array, spec canonical.ts) — a raw-byte re-hash of any
 *     full-bundle document can never match that; the oracle fails closed
 *     (safe). Detection for Path-A via the gateway fetch requires the oracle
 *     to re-verify structurally (recompute event hashes -> hashBundle), which
 *     is oracle-side work — flagged in the handoff (§6, shape/hash-model
 *     conflict ticket). The flags still ride in the served bytes.
 */

import { canonicalize } from "@pcc/spec";

/** Bundle-level fields of the envelope (everything except events). */
export interface EvidenceEnvelopeMeta {
  id: string;
  jobId: string;
  stepId: string;
  kernelId: string;
  assuranceTier: number;
  createdAt: string;
  kernelSignature: unknown;
}

/** One event as it appears in the envelope. */
export interface EvidenceEnvelopeEvent {
  id: string;
  type: string;
  timestamp: string;
  source: unknown;
  payload: unknown;
  hash: string;
}

/**
 * Build the canonical envelope string for a bundle + its events.
 *
 * Events are picked down to the six spec fields (no DB extras like bundleId)
 * and sorted by id — the ONE ordering both the commit side and the serve side
 * agree on, since SQLite row order is otherwise unspecified.
 */
export function buildCanonicalEvidenceEnvelope(
  meta: EvidenceEnvelopeMeta,
  events: EvidenceEnvelopeEvent[],
): string {
  const envelope = {
    id: meta.id,
    jobId: meta.jobId,
    stepId: meta.stepId,
    kernelId: meta.kernelId,
    assuranceTier: meta.assuranceTier,
    createdAt: meta.createdAt,
    kernelSignature: meta.kernelSignature,
    events: events
      .map((e) => ({
        id: e.id,
        type: e.type,
        timestamp: e.timestamp,
        source: e.source,
        payload: e.payload,
        hash: e.hash,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  return canonicalize(envelope);
}

/**
 * True when a route param is hash-shaped (`sha256:<64hex>`, `0x<64hex>`, or
 * bare 64-hex) — i.e. an evidence-hash lookup, not a jobId lookup. Mirrors the
 * oracle's normalizer (evidence-checker.ts normalizeHashHex) so the two sides
 * recognize the same forms.
 */
export function isEvidenceHashForm(param: string): boolean {
  return /^(sha256:|0[xX])?[0-9a-fA-F]{64}$/.test(param.trim());
}
