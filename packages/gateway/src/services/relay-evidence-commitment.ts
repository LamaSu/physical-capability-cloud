/**
 * What the operator relay (`POST /api/operator/evidence`) commits for a pushed evidence body
 * (board N80; rehearsal R0 finding G3).
 *
 * The stored `bundleHash` is always a hash the stored content reproduces, or the digest a
 * device signed. It is never made from the bundle's own id: before N80 the relay stored
 * `sha256-<bundleId>` for any body that was not a device-signed bundle, with no events, so
 * the "hash" committed to nothing that was received. Three models, tried in this order:
 *
 *   event_bundle_hash     the body carries LO-EV events (each with a string `type` and
 *                         `timestamp` and a `source` and `payload` object). Every event hash
 *                         is recomputed (`hashEvent`), and the bundle hash over them
 *                         (`hashBundle`). A supplied event `hash`, or a supplied or
 *                         device-signed `bundleHash`, must equal the recomputation, or the
 *                         body is refused. The events are stored.
 *   device_signed_digest  no LO-EV events, but a device-signed bundle was captured
 *                         (`extractNodeSignedBundle`): the digest the device signed is stored
 *                         as signed, and only in the canonical tagged form (`sha256:` + 64
 *                         lowercase hex). The gateway cannot recompute it, and nothing
 *                         verifies the signature here.
 *   document_sha256       anything else (pcc-node's pushes carry events without `source`, and
 *                         a client may send its own document): the sha256 of the canonical
 *                         JSON of exactly the body received. No events are stored, because
 *                         the body has none in the LO-EV form.
 */
import { canonicalize, hashBundle, hashEvent, sha256, type EvidenceEvent } from "@pcc/spec";
import type { CapturedDeviceBundle } from "./device-evidence-settlement.js";

export type RelayHashModel = "event_bundle_hash" | "device_signed_digest" | "document_sha256";

export interface RelayStoredEvent {
  type: string;
  timestamp: string;
  source: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** Recomputed by the gateway (`hashEvent`), never taken from the body. */
  hash: string;
}

export interface RelayEvidenceCommitment {
  /** `sha256:` + 64 lowercase hex. */
  bundleHash: string;
  hashModel: RelayHashModel;
  /** Only for event_bundle_hash; empty otherwise. */
  events: RelayStoredEvent[];
}

export type RelayEvidenceRefusal =
  | { error: "event_hash_mismatch"; eventIndex: number }
  | { error: "bundle_hash_mismatch" }
  | { error: "bundle_hash_malformed" }
  | { error: "evidence_not_canonical" };

const TAGGED_DIGEST = /^sha256:[0-9a-f]{64}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isLoEvEvent(e: unknown): e is Record<string, unknown> & RelayStoredEvent {
  return (
    isPlainObject(e) &&
    typeof e.type === "string" && e.type !== "" &&
    typeof e.timestamp === "string" && e.timestamp !== "" &&
    isPlainObject(e.source) &&
    isPlainObject(e.payload)
  );
}

export async function commitRelayEvidence(
  evidence: unknown,
  captured: CapturedDeviceBundle | null,
): Promise<{ ok: true; commitment: RelayEvidenceCommitment } | { ok: false; refusal: RelayEvidenceRefusal }> {
  // The same `{ bundle: {...} }` unwrap as extractNodeSignedBundle.
  const root = isPlainObject(evidence) ? evidence : {};
  const b = isPlainObject(root.bundle) ? root.bundle : root;
  const raw = b.events;

  if (Array.isArray(raw) && raw.length > 0 && raw.every(isLoEvEvent)) {
    const events: RelayStoredEvent[] = [];
    for (let i = 0; i < raw.length; i++) {
      const e = raw[i] as Record<string, unknown> & RelayStoredEvent;
      let hash: string;
      try {
        hash = await hashEvent({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload } as unknown as Omit<EvidenceEvent, "hash" | "id">);
      } catch {
        return { ok: false, refusal: { error: "evidence_not_canonical" } };
      }
      if (e.hash !== undefined && e.hash !== hash) return { ok: false, refusal: { error: "event_hash_mismatch", eventIndex: i } };
      events.push({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload, hash });
    }
    const bundleHash = await hashBundle(events as unknown as EvidenceEvent[]);
    const claimed = captured?.bundleHash ?? (typeof b.bundleHash === "string" ? b.bundleHash : undefined);
    if (claimed !== undefined && claimed !== bundleHash) return { ok: false, refusal: { error: "bundle_hash_mismatch" } };
    return { ok: true, commitment: { bundleHash, hashModel: "event_bundle_hash", events } };
  }

  if (captured) {
    if (!TAGGED_DIGEST.test(captured.bundleHash)) return { ok: false, refusal: { error: "bundle_hash_malformed" } };
    return { ok: true, commitment: { bundleHash: captured.bundleHash, hashModel: "device_signed_digest", events: [] } };
  }

  let text: string;
  try {
    text = canonicalize(evidence);
  } catch {
    return { ok: false, refusal: { error: "evidence_not_canonical" } };
  }
  return { ok: true, commitment: { bundleHash: await sha256(text), hashModel: "document_sha256", events: [] } };
}
