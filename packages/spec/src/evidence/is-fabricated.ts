/**
 * Fabricated-evidence predicate — the ONE canonical detector expression.
 *
 * The adapter-honesty lane tags every event produced by a mock/simulated code
 * path so the trust layer can refuse to attest it as real. The tag is dual
 * (either field signals fabrication):
 *
 *   - `source.simulated === true` — per-DEVICE suspenders: set once on the
 *     source of a mock adapter (or an adapter downgraded to mock mode), so it
 *     covers every event from that device, including event types added later.
 *   - `payload.mock === true` — per-EVENT belt: set on an individually
 *     synthesized event (e.g. gateway-synth Path-B events), works with no type
 *     change because `payload` is already `Record<string, unknown>`.
 *
 * Both ride INSIDE the signed payload (`hashEvent` covers `source` + `payload`
 * whole), so the kernel signature and the oracle's re-hash both bind the flag —
 * it cannot be stripped mid-pipeline without invalidating the bundle hash.
 *
 * Every detector site (ALCOA authenticity leg, settlement gate, tier gate,
 * oracle floor) MUST use this exact predicate so the layers agree on what
 * "fabricated" means. Do not re-derive it inline.
 *
 * @see ai/research/evidence-oracle-fabrication-detection-handoff.md §4
 */

import type { EvidenceEvent } from "../types/evidence.js";

/**
 * True iff this single event is fabricated-by-design (mock/simulated), i.e. it
 * is synthesized data rather than a reading from physical hardware.
 */
export function isFabricated(event: EvidenceEvent): boolean {
  return (
    event.source?.simulated === true ||
    (event.payload as Record<string, unknown> | undefined)?.mock === true
  );
}

/**
 * True iff ANY event in the bundle is fabricated-by-design. A bundle is
 * fabricated-by-design if it carries even one simulated/mock event — the
 * whole bundle is then non-authentic for settlement/attestation purposes.
 *
 * Fail-closed: a missing/empty `events` array yields `false` here (nothing to
 * flag), so callers that must fail closed on an ABSENT bundle should check the
 * bundle's presence separately — this predicate only classifies events it can
 * see, and never up-tiers a bundle it cannot read.
 */
export function bundleHasFabricatedEvents(bundle: {
  events?: readonly EvidenceEvent[];
}): boolean {
  return (bundle.events ?? []).some(isFabricated);
}
