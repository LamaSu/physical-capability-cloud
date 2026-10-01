/**
 * Onboarding proof-of-capability evidence (POST /api/onboard/registrations/:id/prove).
 *
 * Bounded validation, header-only image checks, the canonical fabrication
 * screen, the evidence-tier CLAIM, and the canonical evidence record + digest.
 *
 * Everything here is a rejection rule or a digest. Nothing here approves,
 * activates, or grants an assurance tier: /prove evidence is self-asserted and
 * only moves a registration to "reviewing" for an onboarding admin to decide.
 * `evidenceTierClaim` is a description of which self-asserted evidence was
 * present, never an authoritative tier (that comes from the kernel ceiling).
 *
 * Input bounds are checked before anything is decoded: sizes and counts first,
 * then shape, then the base64 decode (at most 5 MiB), then a header-only
 * dimension parse. No image library is used and no pixels are decoded.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { canonicalize, isFabricated, type EvidenceEvent } from "@pcc/spec";
import { LocalBlobBackend, computeCid } from "../services/cid-blob-storage.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Route-level body limit for /prove (the server default is 1 MiB). */
export const PROVE_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
export const PHOTO_MAX_ENCODED_CHARS = 7_000_000;
export const PHOTO_MAX_DECODED_BYTES = 5 * 1024 * 1024;
export const PHOTO_MIN_SIDE_PX = 16;
export const PHOTO_MAX_SIDE_PX = 12_000;
/** Decompression-bomb guard: a header may not claim more pixels than this. */
export const PHOTO_MAX_PIXELS = 50_000_000;
export const EVENTS_MAX_COUNT = 200;
export const EVENT_TYPE_MAX_CHARS = 64;
export const EVENT_TIMESTAMP_MAX_CHARS = 64;
export const EVENTS_MAX_SERIALIZED_BYTES = 256 * 1024;
export const DEVICE_HEALTH_MAX_SERIALIZED_BYTES = 16 * 1024;
export const DEVICE_HEALTH_FIELD_MAX_CHARS = 128;
export const HASH_FIELD_MAX_CHARS = 256;
/** Nesting bound for events / deviceHealth, so canonicalization cannot recurse unboundedly. */
export const EVIDENCE_MAX_DEPTH = 32;
/** Bound on the JPEG marker scan that looks for the SOFn frame header. */
export const JPEG_MAX_MARKERS = 1024;
/**
 * Accepted proofs per registration per window (WP-B round 5, M4). Each one
 * can retain a photo of up to 5 MiB, so this bounds retained-photo growth
 * per registration to 25 MiB an hour.
 */
export const PROOFS_PER_REGISTRATION_PER_WINDOW = 5;
export const PROOF_RATE_WINDOW_MS = 60 * 60 * 1000;

const EVENT_MAX_FUTURE_SKEW_MS = 5_000;
const EVENT_MAX_AGE_MS = 60 * 60 * 1000;

export const COMPLETION_EVENT_TYPES: readonly string[] = [
  "execution_completed",
  "camera_snapshot",
  "power_profile_summary",
];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface EvidenceRejection {
  status: 400 | 413 | 422;
  /** Machine-readable error name. */
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; rejection: EvidenceRejection };

function reject(status: EvidenceRejection["status"], error: string, message: string, details?: Record<string, unknown>): { ok: false; rejection: EvidenceRejection } {
  return { ok: false, rejection: { status, error, message, ...(details ? { details } : {}) } };
}

export type PhotoFormat = "png" | "jpeg" | "webp";

/** One submitted evidence event after shape validation. */
export interface ProveEventInput {
  type: string;
  timestamp: string;
  payload?: Record<string, unknown>;
  source?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ValidatedEvidence {
  bundleHash?: string;
  ipfsCid?: string;
  /** Present-but-empty and absent both yield []. */
  events: ProveEventInput[];
  deviceHealth?: Record<string, unknown>;
  /** Base64 payload with any data: prefix stripped; bounded but not yet decoded. */
  photo?: { base64: string; declaredFormat: PhotoFormat | null; decodedBytes: number };
}

export interface InspectedPhoto {
  bytes: Buffer;
  format: PhotoFormat;
  width: number;
  height: number;
  /** "sha256:<hex>" of the decoded bytes. */
  sha256: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** True if any object/array in `value` sits deeper than `limit` levels. Iterative. */
function exceedsDepth(value: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (typeof v !== "object" || v === null) continue;
    if (depth > limit) return true;
    const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
    for (const child of children) stack.push([child, depth + 1]);
  }
  return false;
}

/**
 * True if `value` contains a number that is not finite (NaN, ±Infinity; JSON
 * like 1e400 parses to Infinity). Such a number canonicalizes as "Infinity"
 * but is stored as null, so the stored record would not re-verify against its
 * digest. Iterative; call it only on a value whose depth is already bounded.
 */
function containsNonFiniteNumber(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return true;
      continue;
    }
    if (typeof v !== "object" || v === null) continue;
    for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) stack.push(child);
  }
  return false;
}

/** UTF-8 size of the JSON serialization, or null if it cannot be serialized (e.g. nesting too deep for the stack). */
function serializedBytes(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
}

const absent = (v: unknown): boolean => v === undefined || v === null;

// ---------------------------------------------------------------------------
// B2 — structural bounds, checked before any decode
// ---------------------------------------------------------------------------

const DATA_URI_PREFIX = /^data:image\/(png|jpeg|webp);base64,/i;
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validate the shape and size of a /prove `evidence` object without decoding
 * anything. `null` and `undefined` fields are treated as absent. Returns the
 * validated fields, or the first rejection.
 */
export function validateEvidenceShape(evidence: unknown): Checked<ValidatedEvidence> {
  if (!isPlainObject(evidence)) {
    return reject(400, "invalid_evidence", "`evidence` must be an object.");
  }
  const out: ValidatedEvidence = { events: [] };

  // bundleHash
  if (!absent(evidence.bundleHash)) {
    const h = evidence.bundleHash;
    if (typeof h !== "string" || h.length > HASH_FIELD_MAX_CHARS || !h.startsWith("sha256:") || h.length < 40) {
      return reject(400, "invalid_bundle_hash",
        `bundleHash must be a string that starts with 'sha256:' and is 40 to ${HASH_FIELD_MAX_CHARS} characters long (e.g. sha256:abc123...).`);
    }
    out.bundleHash = h;
  }

  // ipfsCid
  if (!absent(evidence.ipfsCid)) {
    const c = evidence.ipfsCid;
    if (typeof c !== "string" || c.length === 0 || c.length > HASH_FIELD_MAX_CHARS) {
      return reject(400, "invalid_ipfs_cid", `ipfsCid must be a non-empty string of at most ${HASH_FIELD_MAX_CHARS} characters.`);
    }
    out.ipfsCid = c;
  }

  // events
  if (!absent(evidence.events)) {
    const events = evidence.events;
    if (!Array.isArray(events)) {
      return reject(400, "invalid_events", "events must be an array of event objects.");
    }
    if (events.length > EVENTS_MAX_COUNT) {
      return reject(413, "too_many_events", `At most ${EVENTS_MAX_COUNT} events may be submitted (got ${events.length}).`);
    }
    const size = serializedBytes(events);
    if (size === null) {
      return reject(400, "invalid_events", "events could not be serialized (nesting too deep).");
    }
    if (size > EVENTS_MAX_SERIALIZED_BYTES) {
      return reject(413, "events_too_large", `events may total at most ${EVENTS_MAX_SERIALIZED_BYTES} bytes serialized (got ${size}).`);
    }
    if (exceedsDepth(events, EVIDENCE_MAX_DEPTH)) {
      return reject(400, "invalid_events", `events may be nested at most ${EVIDENCE_MAX_DEPTH} levels deep.`);
    }
    if (containsNonFiniteNumber(events)) {
      return reject(400, "non_finite_number", "events may not contain a number that is not finite (NaN, Infinity or -Infinity, e.g. 1e400).");
    }
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!isPlainObject(ev)) {
        return reject(400, "invalid_event", `Event ${i} must be an object.`, { index: i });
      }
      if (typeof ev.type !== "string" || ev.type.length === 0 || ev.type.length > EVENT_TYPE_MAX_CHARS) {
        return reject(400, "invalid_event", `Event ${i} must have a string type of 1 to ${EVENT_TYPE_MAX_CHARS} characters.`, { index: i });
      }
      if (typeof ev.timestamp !== "string" || ev.timestamp.length > EVENT_TIMESTAMP_MAX_CHARS) {
        return reject(400, "invalid_event_timestamp",
          `Event ${i} must have an ISO timestamp string of at most ${EVENT_TIMESTAMP_MAX_CHARS} characters.`, { index: i });
      }
      if (ev.payload !== undefined && !isPlainObject(ev.payload)) {
        return reject(400, "invalid_event", `Event ${i} payload must be an object.`, { index: i });
      }
      if (ev.source !== undefined && !isPlainObject(ev.source)) {
        return reject(400, "invalid_event", `Event ${i} source must be an object.`, { index: i });
      }
      // The fabrication flags isFabricated reads must be booleans when present:
      // a string "true" or a 1 is ambiguous, and ambiguous input grants nothing.
      const mock = (ev.payload as Record<string, unknown> | undefined)?.mock;
      const simulated = (ev.source as Record<string, unknown> | undefined)?.simulated;
      if ((mock !== undefined && typeof mock !== "boolean") || (simulated !== undefined && typeof simulated !== "boolean")) {
        return reject(422, "ambiguous_fabrication_flag",
          `Event ${i} carries payload.mock or source.simulated with a non-boolean value; these flags must be true or false.`, { index: i });
      }
    }
    out.events = events as ProveEventInput[];
  }

  // deviceHealth
  if (!absent(evidence.deviceHealth)) {
    const dh = evidence.deviceHealth;
    if (!isPlainObject(dh)) {
      return reject(400, "invalid_device_health", "deviceHealth must be an object.");
    }
    const size = serializedBytes(dh);
    if (size === null) {
      return reject(400, "invalid_device_health", "deviceHealth could not be serialized (nesting too deep).");
    }
    if (size > DEVICE_HEALTH_MAX_SERIALIZED_BYTES) {
      return reject(413, "device_health_too_large",
        `deviceHealth may be at most ${DEVICE_HEALTH_MAX_SERIALIZED_BYTES} bytes serialized (got ${size}).`);
    }
    if (exceedsDepth(dh, EVIDENCE_MAX_DEPTH)) {
      return reject(400, "invalid_device_health", `deviceHealth may be nested at most ${EVIDENCE_MAX_DEPTH} levels deep.`);
    }
    if (containsNonFiniteNumber(dh)) {
      return reject(400, "non_finite_number", "deviceHealth may not contain a number that is not finite (NaN, Infinity or -Infinity, e.g. 1e400).");
    }
    for (const field of ["status", "model"] as const) {
      const v = dh[field];
      if (v !== undefined && (typeof v !== "string" || v.length > DEVICE_HEALTH_FIELD_MAX_CHARS)) {
        return reject(400, "invalid_device_health",
          `deviceHealth.${field} must be a string of at most ${DEVICE_HEALTH_FIELD_MAX_CHARS} characters.`);
      }
    }
    out.deviceHealth = dh;
  }

  // photoBase64 — bounded before decode
  if (!absent(evidence.photoBase64)) {
    const raw = evidence.photoBase64;
    if (typeof raw !== "string") {
      return reject(400, "invalid_photo_encoding", "photoBase64 must be a base64 string.");
    }
    let declaredFormat: PhotoFormat | null = null;
    let b64 = raw;
    const prefix = DATA_URI_PREFIX.exec(raw);
    if (prefix) {
      declaredFormat = prefix[1]!.toLowerCase() as PhotoFormat;
      b64 = raw.slice(prefix[0].length);
    }
    if (b64.length > PHOTO_MAX_ENCODED_CHARS) {
      return reject(413, "photo_too_large",
        `photoBase64 may be at most ${PHOTO_MAX_ENCODED_CHARS} base64 characters (got ${b64.length}).`);
    }
    if (b64.length === 0 || b64.length % 4 !== 0 || !STRICT_BASE64.test(b64)) {
      return reject(400, "invalid_photo_encoding",
        "photoBase64 must be standard padded base64 (A-Z a-z 0-9 + /, length a multiple of 4), optionally prefixed with data:image/(png|jpeg|webp);base64,");
    }
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const decodedBytes = (b64.length / 4) * 3 - padding;
    if (decodedBytes > PHOTO_MAX_DECODED_BYTES) {
      return reject(413, "photo_decoded_too_large",
        `The decoded photo may be at most ${PHOTO_MAX_DECODED_BYTES} bytes (got ${decodedBytes}).`);
    }
    out.photo = { base64: b64, declaredFormat, decodedBytes };
  }

  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// B1 — the canonical fabrication screen
// ---------------------------------------------------------------------------

/**
 * Adapt a /prove event to the input of `isFabricated` from @pcc/spec.
 *
 * `isFabricated` reads exactly two fields: `source.simulated` and
 * `payload.mock`. A /prove event carries `type`, `timestamp`, `payload` and
 * (optionally) `source`, but none of the EvidenceEvent fields the predicate
 * does not read (`id`, `hash`, the source's device ids). The submitted
 * `source` and `payload` objects are passed through untouched, so the
 * canonical predicate judges exactly what the operator sent.
 */
export function toFabricationScreenInput(ev: ProveEventInput): EvidenceEvent {
  return {
    type: ev.type,
    timestamp: ev.timestamp,
    source: ev.source,
    payload: ev.payload,
  } as unknown as EvidenceEvent;
}

/** Indices of the submitted events that the canonical predicate marks fabricated/simulated. */
export function fabricatedEventIndices(events: readonly ProveEventInput[]): number[] {
  const out: number[] = [];
  events.forEach((ev, i) => {
    if (isFabricated(toFabricationScreenInput(ev))) out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Event timestamps (unchanged rules from the original /prove handler)
// ---------------------------------------------------------------------------

export function checkEventTimestamps(events: readonly ProveEventInput[], nowMs: number): EvidenceRejection | null {
  for (const ev of events) {
    const ts = Date.parse(ev.timestamp);
    if (Number.isNaN(ts)) {
      return { status: 400, error: "invalid_event_timestamp", message: `Event of type "${ev.type}" has an invalid ISO timestamp: "${ev.timestamp}"` };
    }
    if (ts > nowMs + EVENT_MAX_FUTURE_SKEW_MS) {
      return { status: 400, error: "future_event_timestamp", message: `Event of type "${ev.type}" has a timestamp in the future: "${ev.timestamp}"` };
    }
    if (nowMs - ts > EVENT_MAX_AGE_MS) {
      return { status: 400, error: "stale_event_timestamp", message: `Event of type "${ev.type}" is older than 1 hour: "${ev.timestamp}". Submit fresh evidence.` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Image header checks (no pixel decode)
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3), as used by PNG chunks. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Identify PNG / JPEG / WebP by magic bytes; anything else is null. */
export function detectImageFormat(b: Uint8Array): PhotoFormat | null {
  if (b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v)) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  ) return "webp";
  return null;
}

interface Dimensions { width: number; height: number }

/** PNG: the IHDR chunk must come first, be 13 bytes, carry a valid CRC and a legal bit depth / colour type. */
function parsePngHeader(b: Buffer): Dimensions | null {
  if (b.length < 33) return null;
  if (b.readUInt32BE(8) !== 13) return null;
  if (b.toString("latin1", 12, 16) !== "IHDR") return null;
  if (crc32(b.subarray(12, 29)) !== b.readUInt32BE(29)) return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const bitDepth = b[24]!;
  const colorType = b[25]!;
  const legalDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!legalDepths[colorType]?.includes(bitDepth)) return null;
  if (b[26] !== 0 || b[27] !== 0 || (b[28] !== 0 && b[28] !== 1)) return null;
  if (width === 0 || height === 0) return null;
  return { width, height };
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * JPEG: walk the marker segments after SOI until the first SOFn frame header,
 * at most JPEG_MAX_MARKERS segments. Reaching SOS/EOI first, a malformed
 * segment, or running past the buffer is unparseable.
 */
function parseJpegHeader(b: Buffer): Dimensions | null {
  let i = 2; // after SOI (FF D8)
  for (let markers = 0; markers < JPEG_MAX_MARKERS; markers++) {
    if (i >= b.length || b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) return null;
    const marker = b[i]!;
    i++;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda || marker === 0x00) return null; // SOI again, EOI, SOS before SOF, stuffed byte
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue; // RSTn / TEM: no length
    if (i + 2 > b.length) return null;
    const segLen = b.readUInt16BE(i);
    if (segLen < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      // length(2) precision(1) height(2) width(2) components(1)
      if (segLen < 8 || i + 8 > b.length) return null;
      const height = b.readUInt16BE(i + 3);
      const width = b.readUInt16BE(i + 5);
      if (width === 0 || height === 0) return null; // height 0 = defined later by DNL: not determinable from the header
      return { width, height };
    }
    i += segLen;
  }
  return null;
}

/** WebP: the first chunk after "WEBP" must be VP8X, VP8L or VP8 with a well-formed header. */
function parseWebpHeader(b: Buffer): Dimensions | null {
  if (b.length < 20) return null; // RIFF header (12) + first chunk header (8)
  if (b.readUInt32LE(4) < 12) return null; // RIFF size must cover "WEBP" + a chunk header
  const chunk = b.toString("latin1", 12, 16);
  const chunkSize = b.readUInt32LE(16);
  if (chunk === "VP8X") {
    if (chunkSize < 10 || b.length < 30) return null;
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  if (chunk === "VP8L") {
    if (chunkSize < 5 || b.length < 25 || b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") {
    if (chunkSize < 10 || b.length < 30) return null;
    if ((b[20]! & 0x01) !== 0) return null; // must be a key frame
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null; // key-frame start code
    const width = b.readUInt16LE(26) & 0x3fff;
    const height = b.readUInt16LE(28) & 0x3fff;
    if (width === 0 || height === 0) return null;
    return { width, height };
  }
  return null;
}

/** Header-only dimensions for a buffer already identified as `format`, or null if unparseable. */
export function parseImageDimensions(b: Buffer, format: PhotoFormat): Dimensions | null {
  switch (format) {
    case "png": return parsePngHeader(b);
    case "jpeg": return parseJpegHeader(b);
    case "webp": return parseWebpHeader(b);
  }
}

/**
 * Decode a photo that already passed `validateEvidenceShape`, then check its
 * magic bytes and header-declared dimensions. The decode is bounded by the
 * shape check (at most PHOTO_MAX_DECODED_BYTES).
 */
export function inspectPhoto(photo: NonNullable<ValidatedEvidence["photo"]>): Checked<InspectedPhoto> {
  const bytes = Buffer.from(photo.base64, "base64");
  if (bytes.length !== photo.decodedBytes) {
    return reject(400, "invalid_photo_encoding", "photoBase64 did not decode to the expected length.");
  }
  const format = detectImageFormat(bytes);
  if (!format) {
    return reject(422, "unsupported_photo_format", "The photo must be a PNG, JPEG or WebP image.");
  }
  if (photo.declaredFormat && photo.declaredFormat !== format) {
    return reject(422, "photo_type_mismatch", `The data URI declares image/${photo.declaredFormat} but the bytes are ${format}.`);
  }
  const dims = parseImageDimensions(bytes, format);
  if (!dims) {
    return reject(422, "unparseable_photo", `The ${format} header could not be parsed.`);
  }
  const { width, height } = dims;
  if (width < PHOTO_MIN_SIDE_PX || height < PHOTO_MIN_SIDE_PX || width > PHOTO_MAX_SIDE_PX || height > PHOTO_MAX_SIDE_PX) {
    return reject(422, "photo_dimensions_out_of_range",
      `Each side of the photo must be ${PHOTO_MIN_SIDE_PX} to ${PHOTO_MAX_SIDE_PX} px (header claims ${width}x${height}).`,
      { width, height });
  }
  if (width * height > PHOTO_MAX_PIXELS) {
    return reject(422, "photo_too_many_pixels",
      `The photo may have at most ${PHOTO_MAX_PIXELS} pixels (header claims ${width}x${height}).`, { width, height });
  }
  return { ok: true, value: { bytes, format, width, height, sha256: `sha256:${sha256Hex(bytes)}` } };
}

// ---------------------------------------------------------------------------
// Evidence-tier CLAIM (never authority)
// ---------------------------------------------------------------------------

export interface EvidenceSummary {
  proofs: string[];
  warnings: string[];
  evidenceTierClaim: 0 | 1 | 2;
  tierWarning?: string;
}

/**
 * Which self-asserted evidence is present, as proof lines and a 0-2 CLAIM.
 * A photo counts only if it passed every bound and header check (`photo` is
 * the inspected photo, or undefined when none was submitted).
 */
export function summarizeEvidence(ev: ValidatedEvidence, photo: InspectedPhoto | undefined): EvidenceSummary {
  const proofs: string[] = [];
  const warnings: string[] = [];
  const hasEvents = ev.events.length > 0;
  const hasCompletion = ev.events.some((e) => COMPLETION_EVENT_TYPES.includes(e.type));

  if (ev.bundleHash && hasEvents) {
    if (hasCompletion) {
      proofs.push(`evidence_bundle: ${ev.events.length} events, hash=${ev.bundleHash.slice(0, 20)}...`);
    } else {
      warnings.push("Evidence events present but no completion/snapshot event found");
    }
  }
  if (photo) {
    proofs.push(`photo: ${photo.format} ${photo.width}x${photo.height}, ${Math.ceil(photo.bytes.length / 1024)}KB`);
  }
  const status = ev.deviceHealth?.status;
  const model = ev.deviceHealth?.model;
  const hasDeviceHealth = typeof status === "string" && status.length > 0 && typeof model === "string" && model.length > 0;
  if (ev.deviceHealth) {
    if (hasDeviceHealth) proofs.push(`device_health: ${model} status=${status}`);
    else warnings.push("Device health missing status or model");
  }
  if (ev.ipfsCid) proofs.push(`ipfs: ${ev.ipfsCid}`);

  let evidenceTierClaim: 0 | 1 | 2;
  let tierWarning: string | undefined;
  if (photo && hasDeviceHealth && hasEvents) {
    evidenceTierClaim = 2;
  } else if (ev.bundleHash && hasEvents && hasCompletion) {
    evidenceTierClaim = 1;
  } else {
    evidenceTierClaim = 0;
    tierWarning = "Self-attested only — no independent verification";
  }
  return { proofs, warnings, evidenceTierClaim, ...(tierWarning ? { tierWarning } : {}) };
}

// ---------------------------------------------------------------------------
// B4 — canonical evidence record + digest
// ---------------------------------------------------------------------------

export interface OnboardEvidenceRecordV1 {
  version: 1;
  registrationId: string;
  submitterOperatorId: string;
  submittedAt: string;
  photo: null | {
    sha256: string;
    format: PhotoFormat;
    width: number;
    height: number;
    bytes: number;
    /** Where the decoded bytes are retained (content-addressed), or null if not retained. */
    retained: null | { store: "cid-blob-local"; cid: string };
  };
  /** sha256 of canonicalize(events) — keys sorted at every depth, no whitespace. */
  events: null | { sha256: string; count: number };
  deviceHealth: Record<string, unknown> | null;
  bundleHash: string | null;
  ipfsCid: string | null;
  evidenceTierClaim: 0 | 1 | 2;
}

export function eventsDigest(events: readonly ProveEventInput[]): string {
  return `sha256:${sha256Hex(canonicalize(events))}`;
}

export function buildEvidenceRecord(args: {
  registrationId: string;
  submitterOperatorId: string;
  submittedAt: string;
  evidence: ValidatedEvidence;
  photo: InspectedPhoto | undefined;
  photoCid: string | null;
  evidenceTierClaim: 0 | 1 | 2;
}): OnboardEvidenceRecordV1 {
  const { evidence, photo } = args;
  return {
    version: 1,
    registrationId: args.registrationId,
    submitterOperatorId: args.submitterOperatorId,
    submittedAt: args.submittedAt,
    photo: photo
      ? {
          sha256: photo.sha256,
          format: photo.format,
          width: photo.width,
          height: photo.height,
          bytes: photo.bytes.length,
          retained: args.photoCid ? { store: "cid-blob-local", cid: args.photoCid } : null,
        }
      : null,
    events: evidence.events.length > 0 ? { sha256: eventsDigest(evidence.events), count: evidence.events.length } : null,
    deviceHealth: evidence.deviceHealth ?? null,
    bundleHash: evidence.bundleHash ?? null,
    ipfsCid: evidence.ipfsCid ?? null,
    evidenceTierClaim: args.evidenceTierClaim,
  };
}

/** "sha256:<hex>" of the canonical JSON of the record. */
export function evidenceRecordDigest(record: OnboardEvidenceRecordV1): string {
  return `sha256:${sha256Hex(canonicalize(record))}`;
}

/**
 * Prefix of the review record /prove writes into the registration description,
 * for the admin reviewing it. It is a display copy only: no transition trusts
 * anything parsed out of the description. The evidence of record is the
 * latest operator.proof_submitted audit row (routes/onboard.ts).
 */
export const PROOF_RECORD_PREFIX = "PROOF SUBMITTED: ";

// ---------------------------------------------------------------------------
// Reserved description prefixes (WP-B round 5, L1; astra pack 88, Q2)
// ---------------------------------------------------------------------------

/** The reserved prefixes as skeletons: lower-case, with every space removed. */
const RESERVED_SKELETONS = ["proofsubmitted:", "proved:"] as const;
/**
 * How much of a description the reserved-prefix check reads, in code points.
 * Code points, not UTF-16 units: a cut between the two units of a surrogate
 * pair strands a lone surrogate, and astra pack 88 (Q2) hid a reserved prefix
 * behind exactly that (a variation selector split at the boundary).
 */
const RESERVED_SCAN_CODE_POINTS = 1024;

/**
 * What a reader does not see as part of a word: format characters (Cf: zero
 * width, bidi controls, ...), every separator (Z*), controls (Cc), combining
 * marks (M*), lone surrogates (Cs: nothing a reader can tell from a gap or a
 * replacement box), default-ignorable code points (the combining grapheme
 * joiner, variation selectors including U+E0100..U+E01EF, Hangul fillers, ...)
 * and the blank braille pattern.
 */
const INVISIBLE_RE = /[\p{Cf}\p{Z}\p{Cc}\p{M}\p{Cs}\p{Default_Ignorable_Code_Point}\u{2800}]/gu;

/**
 * Look-alikes that NFKC does not fold, for the letters of the reserved words
 * and the colon: Cyrillic, Greek, Coptic, Armenian, Cherokee, Latin small
 * capitals and other homoglyphs, ASCII digits/symbols read as letters, and
 * colon-shaped signs (some are combining marks, so this runs before marks are
 * removed). Lower-case forms: the text is lower-cased first. A targeted list,
 * not the full Unicode TR39 confusables table.
 */
const CONFUSABLE_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ["p", "рρⲣꮲᴘ"],
  ["r", "гʀⲅꭱꮢ"],
  ["o", "оοσօⲟᴏ〇" + "0"],
  ["f", "ϝꜰƒ"],
  ["s", "ѕꜱʂꮪꮥ"],
  ["u", "սυᴜʋ"],
  ["b", "ьвβʙᏼꮟƅ"],
  ["m", "мμᴍꮇⲙ"],
  ["i", "іӏιıɪǀⲓɩ׀ו∣" + "l1|"],
  ["t", "тτᴛꭲⲧ"],
  ["e", "еҽεᴇꭼⲉ℮"],
  ["d", "ԁᴅꭰ"],
  ["v", "ѵνᴠꮩ∨"],
  [":", "։׃∶꞉ː፡᛬ःঃઃఃಃഃඃး"],
];
/**
 * Lisu (U+A4D0..U+A4FF), astra pack 88 Q2. The Fraser alphabet draws many of
 * its letters as Latin capitals, so each letter of the reserved words has a
 * Lisu twin (checked against the glyphs, not against the letter names), and
 * the tone letter U+A4FD is drawn as a colon. Escapes, so a reviewer can see
 * which code point is meant. The block's other letters are mirrored or
 * rotated forms (U+A4D2 PHA, U+A4D5 THA, ...) or look like letters the
 * reserved words do not use; as non-ASCII letters they are caught by the
 * wildcard rule in isReservedDescription.
 */
const LISU_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ["p", "\u{A4D1}"], // PA
  ["r", "\u{A4E3}"], // ZHA
  ["o", "\u{A4F3}"], // O
  ["f", "\u{A4DD}"], // TSA
  ["s", "\u{A4E2}"], // SA
  ["u", "\u{A4F4}"], // U
  ["b", "\u{A4D0}"], // BA
  ["m", "\u{A4DF}"], // MA
  ["i", "\u{A4F2}"], // I
  ["t", "\u{A4D4}"], // TA
  ["e", "\u{A4F0}"], // E
  ["d", "\u{A4D3}"], // DA
  ["v", "\u{A4E6}"], // HA
  [":", "\u{A4FD}"], // TONE MYA JEU
];
const CONFUSABLES: ReadonlyMap<string, string> = new Map(
  [...CONFUSABLE_GROUPS, ...LISU_GROUPS].flatMap(([ascii, lookalikes]) => Array.from(lookalikes, (ch) => [ch, ascii] as const)),
);

/**
 * What `text` reads as, for the reserved-prefix check: NFKC compatibility
 * folding (applied as NFKD, so combining marks come apart from their letters),
 * lower-cased, look-alikes folded to ASCII, then everything invisible removed.
 */
function readingSkeleton(text: string): string {
  let folded = "";
  for (const ch of text.normalize("NFKD").toLowerCase().normalize("NFKD")) folded += CONFUSABLES.get(ch) ?? ch;
  return folded.replace(INVISIBLE_RE, "");
}

/**
 * The first RESERVED_SCAN_CODE_POINTS code points of `text`. A surrogate pair
 * is never cut, so the window never ends in a stranded half of a character.
 */
function scanWindow(text: string): string {
  if (text.length <= RESERVED_SCAN_CODE_POINTS) return text; // at most one code point per UTF-16 unit
  let end = 0;
  for (let n = 0; n < RESERVED_SCAN_CODE_POINTS && end < text.length; n++) {
    end += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
  }
  return text.slice(0, end);
}

const isAsciiLetter = (ch: string): boolean => ch >= "a" && ch <= "z";
const FOREIGN_LETTER_RE = /^\p{L}$/u;
/** A letter outside ASCII that is still there after folding, so the look-alike table does not know it. */
const isForeignLetter = (ch: string): boolean => ch > "\u007f" && FOREIGN_LETTER_RE.test(ch);

/** How many letters each reserved skeleton has (its colon is not one). */
const RESERVED_LETTERS: ReadonlyMap<string, number> = new Map(
  RESERVED_SKELETONS.map((reserved) => [reserved, reserved.replace(/[^a-z]/g, "").length] as const),
);

/**
 * Does `chars` (a skeleton, one code point per element) read as the start of
 * `reserved`?
 *
 * It is compared position by position. A character matches when it equals the
 * reserved one, or, where the reserved one is a letter, when it is a letter
 * outside ASCII that the look-alike table did not fold: a wildcard, because no
 * table lists every look-alike (astra pack 88, Q2). A full-length skeleton
 * must also match at least half of the reserved letters literally, so text in
 * another script never matches. A skeleton shorter than `reserved` (the scan
 * was cut off) cannot show its literal letters yet, so the positions it has
 * only have to be consistent.
 */
function readsAsReserved(chars: readonly string[], reserved: string): boolean {
  const whole = chars.length >= reserved.length;
  const seen = Math.min(chars.length, reserved.length);
  let literal = 0;
  for (let i = 0; i < seen; i++) {
    const ch = chars[i]!;
    const want = reserved[i]!;
    if (ch === want) {
      if (isAsciiLetter(want)) literal++;
    } else if (!(isAsciiLetter(want) && isForeignLetter(ch))) {
      return false;
    }
  }
  return !whole || literal * 2 >= RESERVED_LETTERS.get(reserved)!;
}

/**
 * Descriptions that read like a server-written review record ("PROOF
 * SUBMITTED: ..." or the pre-review "PROVED: ..."), including invisible,
 * spaced-out and look-alike variants. Operators may not write these
 * (/register, PATCH, the onboarding wizard), so an admin never sees an
 * operator's text dressed up as a server record.
 *
 * This is a display guard, not the trust boundary: no transition reads the
 * description, they take the evidence from the audit log. And it is not a
 * complete impersonation check: Unicode has more look-alikes than any table
 * lists, so a non-ASCII letter the table did not fold stands for any letter
 * (readsAsReserved), as long as at least half of the reserved letters are
 * really there. The colon is matched through the table only.
 */
export function isReservedDescription(description: unknown): boolean {
  if (typeof description !== "string") return false;
  const scanned = scanWindow(description);
  const chars = Array.from(readingSkeleton(scanned));
  // The scanned part can end before enough visible characters to rule a
  // reserved prefix out (e.g. after a long run of invisible characters):
  // when more text follows it, anything that could still turn into one is
  // refused.
  const cutOff = scanned.length < description.length;
  return RESERVED_SKELETONS.some((reserved) => (chars.length >= reserved.length || cutOff) && readsAsReserved(chars, reserved));
}

// ---------------------------------------------------------------------------
// Raw photo retention — the existing CID blob store (local backend)
// ---------------------------------------------------------------------------

/**
 * An evidence photo written to private staging (WP-B round 5, M4). It is not
 * visible under its CID until commit(), which /prove calls inside its
 * transition's transaction. So a /prove that fails before that point (a lost
 * CAS, a failed audit write, the proof cap) leaves nothing new in the shared,
 * content-addressed blob store, and nothing ever has to delete a blob there
 * that another request, or an /api/storage upload of the same bytes, may
 * already reference.
 */
export interface StagedPhoto {
  /** CIDv1 (sha-256, raw codec) of the bytes: where commit() places them. */
  readonly cid: string;
  /**
   * Place the staged bytes under their CID, synchronously. Returns true when
   * this call created the blob, false when the CID was already stored (the
   * staged copy is dropped). Throws when the blob cannot be placed; /prove
   * then rolls its transition back.
   */
  commit(): boolean;
  /** Drop the staged bytes without placing them. Best effort; never throws. */
  discard(): void;
}

export interface EvidencePhotoStore {
  /** Write the bytes to private staging (see StagedPhoto). */
  stage(bytes: Uint8Array, mediaType: string): Promise<StagedPhoto>;
}

/** Staging directory under the blob root. CID shards are 2 characters, so it never collides with one. */
export const EVIDENCE_STAGING_DIR = ".staging";

/**
 * Staging + placement on the local backend of the gateway's CID blob store
 * (<root>/<shard>/<cid>). Staging is a uniquely named file in
 * <root>/.staging; placing it is a rename on the same filesystem, so a blob
 * appears under its CID complete or not at all.
 */
function localEvidencePhotoStore(blobs: LocalBlobBackend): EvidencePhotoStore {
  return {
    async stage(bytes) {
      const cid = computeCid(bytes);
      const finalPath = blobs.pathFor(cid);
      const stagingDir = path.join(blobs.root, EVIDENCE_STAGING_DIR);
      await fs.mkdir(stagingDir, { recursive: true });
      const stagingPath = path.join(stagingDir, `${randomUUID()}.part`);
      const drop = () => {
        try {
          rmSync(stagingPath, { force: true });
        } catch {
          // Best effort: a leftover staging file is never visible under a CID.
        }
      };
      try {
        await fs.writeFile(stagingPath, bytes, { flag: "wx" });
      } catch (err) {
        drop();
        throw err;
      }
      return {
        cid,
        commit() {
          if (existsSync(finalPath)) {
            drop();
            return false;
          }
          mkdirSync(path.dirname(finalPath), { recursive: true });
          renameSync(stagingPath, finalPath);
          return true;
        },
        discard: drop,
      };
    },
  };
}

let photoStore: EvidencePhotoStore | null = null;

/**
 * The evidence-photo store: the gateway's CID blob store, local backend
 * (<PCC_BLOB_DIR | ./data/blobs>/<shard>/<cid>). It is deliberately NOT routed
 * to the Storacha/Helia backends that EVIDENCE_STORAGE can select, because
 * those publish content to public IPFS and an onboarding photo is submitted
 * for private review. Retained blobs are not registered in storage_blobs, so
 * GET /api/storage/:cid does not serve them.
 */
export function getEvidencePhotoStore(): EvidencePhotoStore {
  if (!photoStore) photoStore = localEvidencePhotoStore(new LocalBlobBackend());
  return photoStore;
}

/** Test hook: replace (or with null, reset) the evidence-photo store. */
export function setEvidencePhotoStoreForTests(store: EvidencePhotoStore | null): void {
  photoStore = store;
}

export const PHOTO_MEDIA_TYPES: Record<PhotoFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
