/**
 * What the operator relay (`POST /api/operator/evidence`) commits for a pushed evidence body.
 *
 * The stored `bundleHash` is always a hash the stored content reproduces, or the digest a
 * device signed. It is never made from the bundle's own id, and never a hash of content
 * the gateway does not keep.
 *
 * ONE envelope: the body itself, or its `bundle` wrapper, never both. A `bundle` that is
 * present must be an object, and then no commitment field (`events`, `bundleHash`,
 * `kernelSignature`, `signature`) may also sit at the root. Within the envelope:
 *
 *   event_bundle_hash     `events` is present: it must be a non-empty list of LO-EV events
 *                         (each with a string `type` and `timestamp` and a `source` and
 *                         `payload` object), or the body is refused. Each event is hashed
 *                         at the version its source declares: v1 (`hashEvent`) when
 *                         `source` has no own `writer`, v2 (`hashKernelWrittenEvent`) when
 *                         its own `source.writer` is "kernel". Any other writer is refused.
 *                         Hashing, binding checks, and storage use ONE canonical snapshot
 *                         per event. The bundle hash is `hashBundle` over the selected
 *                         event hashes. A supplied event `hash`, or a supplied or
 *                         device-signed `bundleHash`, must equal the recomputation, or
 *                         the body is refused. Every event must commit THIS job and its
 *                         kernel in the hashed content, checked on that snapshot
 *                         (`payload.jobId` is the job, `source.kernelId` and any
 *                         `payload.kernelId` are the job's kernel), or the body is
 *                         refused (409). The snapshots are stored.
 *   device_signed_document  no `events`, but a device-signed DOCUMENT was captured
 *                         (`extractNodeSignedBundle`), in the form pcc-node's job port signs:
 *                         the digest is `sha256(canonicalize(the envelope minus
 *                         bundleHash and kernelSignature))`. The gateway recomputes it and
 *                         requires it to equal the signed digest (canonical tagged form,
 *                         `sha256:` + 64 lowercase hex). The document must name THIS job
 *                         (`jobId`) and the job's kernel (`kernelId`): a document signed for
 *                         another job or kernel is refused. Nothing verifies the signature here.
 *
 * Anything else is refused:
 *   - a device-signed digest with no document and no events: it names no job, so job A's
 *     signature could be filed under job B (`evidence_not_bound`);
 *   - an unsigned document (the rehearsal daemon's run and log), or pcc-node's current events
 *     without a `source`: the gateway has nowhere to keep such a document, so it stores
 *     nothing rather than a hash nobody can reproduce.
 */
import {
  canonicalize,
  hashBundle,
  hashEvent,
  hashKernelWrittenEvent,
  sha256,
  type EvidenceEvent,
} from "@pcc/spec";
import type { CapturedDeviceBundle } from "./device-evidence-settlement.js";

export type RelayHashModel = "event_bundle_hash" | "device_signed_document";

export interface RelayStoredEvent {
  type: string;
  timestamp: string;
  source: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** Recomputed by the gateway with `hashEvent` (v1) or `hashKernelWrittenEvent` (v2), never taken from the body. */
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
  | { error: "event_writer_invalid"; eventIndex: number }
  | { error: "event_hash_mismatch"; eventIndex: number }
  | { error: "bundle_hash_mismatch" }
  | { error: "bundle_hash_malformed" }
  | { error: "evidence_not_lo_ev" }
  | { error: "evidence_not_canonical" }
  | { error: "evidence_not_bound" }
  | { error: "job_mismatch"; eventIndex?: number }
  | { error: "kernel_mismatch"; eventIndex?: number };

/** The job the evidence is filed under, from the job row: never from the evidence. */
export interface RelayJobContext {
  jobId: string;
  kernelId: string | null;
}

type Result = { ok: true; commitment: RelayEvidenceCommitment } | { ok: false; refusal: RelayEvidenceRefusal };

const TAGGED_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Envelope keys that carry the signature and its metadata, not signed content. An envelope with
 *  nothing else is a bare digest. */
const SIGNATURE_KEYS = new Set(["bundleHash", "kernelSignature", "signature", "assuranceTier", "sessionKeyAuthorization", "kernelSessionPublicKey", "signerPublicKey"]);

/** The fields that commit to evidence content; they may sit at the root or in `bundle`, not both. */
const COMMITMENT_FIELDS = ["events", "bundleHash", "kernelSignature", "signature"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** An own property of a parsed snapshot, never one inherited. */
function own(o: Record<string, unknown>, k: string): unknown {
  return Object.getOwnPropertyDescriptor(o, k)?.value;
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
  job: RelayJobContext,
): Promise<Result> {
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
      const e = raw[i] as Record<string, unknown>;
      // ONE canonical snapshot per event: version selection, hashing, job/kernel
      // checks, and the stored row all use the parsed canonical content.
      let snap: unknown;
      try {
        const canonical = canonicalize({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload });
        snap = JSON.parse(canonical);
      } catch {
        return { ok: false, refusal: { error: "evidence_not_canonical" } };
      }
      if (!isLoEvEvent(snap)) return { ok: false, refusal: { error: "events_malformed", eventIndex: i } };

      // Each event is hashed at the version its source declares; other writers
      // are refused. Presence is an OWN-property check, not a truthiness test.
      const hasWriter = Object.prototype.hasOwnProperty.call(snap.source, "writer");
      if (hasWriter && own(snap.source, "writer") !== "kernel") {
        return { ok: false, refusal: { error: "event_writer_invalid", eventIndex: i } };
      }

      let hash: string;
      try {
        const event = snap as unknown as Omit<EvidenceEvent, "hash" | "id">;
        hash = hasWriter
          ? await hashKernelWrittenEvent(event)
          : await hashEvent(event);
      } catch {
        return { ok: false, refusal: { error: "evidence_not_canonical" } };
      }

      const supplied = e.hash;
      if (supplied !== undefined && supplied !== hash) return { ok: false, refusal: { error: "event_hash_mismatch", eventIndex: i } };
      if (own(snap.payload, "jobId") !== job.jobId) return { ok: false, refusal: { error: "job_mismatch", eventIndex: i } };
      const payloadKernel = own(snap.payload, "kernelId");
      if (job.kernelId === null || own(snap.source, "kernelId") !== job.kernelId || (payloadKernel !== undefined && payloadKernel !== job.kernelId)) {
        return { ok: false, refusal: { error: "kernel_mismatch", eventIndex: i } };
      }
      events.push({ type: snap.type, timestamp: snap.timestamp, source: snap.source, payload: snap.payload, hash });
    }
    const bundleHash = await hashBundle(events as unknown as EvidenceEvent[]);
    const claimed = captured?.bundleHash ?? (typeof b.bundleHash === "string" ? b.bundleHash : undefined);
    if (claimed !== undefined && claimed !== bundleHash) return { ok: false, refusal: { error: "bundle_hash_mismatch" } };
    return { ok: true, commitment: { bundleHash, hashModel: "event_bundle_hash", events } };
  }

  if (captured) {
    // A bare digest names no job: the same signature could be filed under any job of the kernel.
    if (Object.keys(b).every((k) => SIGNATURE_KEYS.has(k))) return { ok: false, refusal: { error: "evidence_not_bound" } };
    // The document must name this job and its kernel, inside the signed content.
    if (typeof b.jobId !== "string" || b.jobId !== job.jobId) return { ok: false, refusal: { error: "job_mismatch" } };
    if (typeof b.kernelId !== "string" || job.kernelId === null || b.kernelId !== job.kernelId) {
      return { ok: false, refusal: { error: "kernel_mismatch" } };
    }
    if (!TAGGED_DIGEST.test(captured.bundleHash)) return { ok: false, refusal: { error: "bundle_hash_malformed" } };
    // pcc-node's job port: sha256 over the canonical document without bundleHash and kernelSignature.
    const { bundleHash: _signed, kernelSignature: _signature, ...document } = b;
    let recomputed: string;
    try {
      recomputed = await sha256(canonicalize(document));
    } catch {
      return { ok: false, refusal: { error: "evidence_not_canonical" } };
    }
    if (recomputed !== captured.bundleHash) return { ok: false, refusal: { error: "bundle_hash_mismatch" } };
    return { ok: true, commitment: { bundleHash: recomputed, hashModel: "device_signed_document", events: [] } };
  }

  return { ok: false, refusal: { error: "evidence_not_lo_ev" } };
}
