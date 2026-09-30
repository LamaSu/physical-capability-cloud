/**
 * What the operator relay (`POST /api/operator/evidence`) commits for a pushed evidence body
 * (board N80; rehearsal R0 finding G3; cross-family review E4).
 *
 * The stored `bundleHash` is always a hash the stored content reproduces, or the digest a
 * device signed. It is never made from the bundle's own id (before N80 the relay stored
 * `sha256-<bundleId>` for any body that was not a device-signed bundle), and never a hash of
 * content the gateway does not keep (review E4: a hash of a document it then drops cannot be
 * reproduced by anyone reading the store).
 *
 * ONE envelope: the body itself, or its `bundle` wrapper, never both. A `bundle` that is
 * present must be an object, and then no commitment field (`events`, `bundleHash`,
 * `kernelSignature`, `signature`) may also sit at the root. Within the envelope:
 *
 *   event_bundle_hash     `events` is present: it must be a non-empty list of LO-EV events
 *                         (each with a string `type` and `timestamp` and a `source` and
 *                         `payload` object), or the body is refused. Every event hash is
 *                         recomputed (`hashEvent`), and the bundle hash over them
 *                         (`hashBundle`). A supplied event `hash`, or a supplied or
 *                         device-signed `bundleHash`, must equal the recomputation, or the
 *                         body is refused. The events are stored.
 *   device_signed_digest  no `events`, but a device-signed bundle was captured
 *                         (`extractNodeSignedBundle`): the digest the device signed is stored
 *                         as signed, and only in the canonical tagged form (`sha256:` + 64
 *                         lowercase hex). The gateway cannot recompute it, and nothing
 *                         verifies the signature here.
 *
 * Anything else (a device document, pcc-node's current events without a `source`) is refused:
 * the gateway has nowhere to keep such a document, so it stores nothing rather than a hash
 * nobody can reproduce.
 */
import { hashBundle, hashEvent, type EvidenceEvent } from "@pcc/spec";
import type { CapturedDeviceBundle } from "./device-evidence-settlement.js";

export type RelayHashModel = "event_bundle_hash" | "device_signed_digest";

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
  | { error: "malformed_envelope" }
  | { error: "ambiguous_envelope" }
  | { error: "events_malformed"; eventIndex: number | null }
  | { error: "event_hash_mismatch"; eventIndex: number }
  | { error: "bundle_hash_mismatch" }
  | { error: "bundle_hash_malformed" }
  | { error: "evidence_not_lo_ev" }
  | { error: "evidence_not_canonical" };

type Result = { ok: true; commitment: RelayEvidenceCommitment } | { ok: false; refusal: RelayEvidenceRefusal };

const TAGGED_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The fields that commit to evidence content; they may sit at the root or in `bundle`, not both. */
const COMMITMENT_FIELDS = ["events", "bundleHash", "kernelSignature", "signature"] as const;

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

export async function commitRelayEvidence(evidence: unknown, captured: CapturedDeviceBundle | null): Promise<Result> {
  const root = isPlainObject(evidence) ? evidence : {};
  let b = root;
  if (root.bundle !== undefined) {
    if (!isPlainObject(root.bundle)) return { ok: false, refusal: { error: "malformed_envelope" } };
    if (COMMITMENT_FIELDS.some((f) => root[f] !== undefined)) return { ok: false, refusal: { error: "ambiguous_envelope" } };
    b = root.bundle;
  }

  if (b.events !== undefined) {
    const raw = b.events;
    if (!Array.isArray(raw) || raw.length === 0) return { ok: false, refusal: { error: "events_malformed", eventIndex: null } };
    const bad = raw.findIndex((e) => !isLoEvEvent(e));
    if (bad !== -1) return { ok: false, refusal: { error: "events_malformed", eventIndex: bad } };
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

  return { ok: false, refusal: { error: "evidence_not_lo_ev" } };
}
