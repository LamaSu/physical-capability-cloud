/**
 * Capture Verification Protocol (CVP) — types.
 *
 * Six capture classes CC0..CC5 classify the authenticity of every media
 * capture that can end up on-chain in PCC. Classes are ORTHOGONAL to the
 * existing `assuranceTier` (0..3). A Tier 2 job can be fulfilled by a CC1
 * (browser-signed) or a CC4 (dedicated hardware camera) capture — tier
 * determines *evidence breadth*, class determines *per-frame authenticity*.
 *
 * The final assurance score multiplies a capture-class multiplier into the
 * base score. CC3, CC4, CC5 are neutral (1.0); lower classes apply
 * progressive penalties: CC0=0.70, CC1=0.92, CC2=0.96.
 *
 * See: ai/research/capture-verification-protocol.md §1-§6
 *
 * This file contains types plus a Zod validation schema for `CaptureManifest`
 * (validated at the `/api/capture/upload` boundary). No runtime crypto — safe
 * to import from browser code.
 */

import { z } from "zod";
import type { SHA256, Timestamp } from "./common.js";

// ---------------------------------------------------------------------------
// Capture classes + multipliers
// ---------------------------------------------------------------------------

/**
 * The six capture classes in ascending order of authenticity depth.
 *
 * - CC0 — Unsigned: no cryptographic provenance beyond bearer token.
 * - CC1 — Browser: operator session-key signed + WebAuthn + multi-sensor.
 * - CC2 — Platform: CC1 + Apple/Google hardware attestation.
 * - CC3 — Enclave: signed inside Secure Enclave / StrongBox via C2PA.
 * - CC4 — TrustCam: dedicated hardware camera (Leica, Sony, Nikon, ...).
 * - CC5 — DePIN: hardware already attested on a DePIN chain (Hivemapper, ...).
 *
 * Modeled as a string enum for JSON interoperability and stable storage.
 */
export enum CaptureClass {
  CC0 = "CC0",
  CC1 = "CC1",
  CC2 = "CC2",
  CC3 = "CC3",
  CC4 = "CC4",
  CC5 = "CC5",
}

/**
 * Multipliers applied to the base assurance score per capture class.
 *
 * Rationale (design doc §2):
 * - CC0 (no signature) = significant penalty (0.70).
 * - CC1 (browser-signed) = small penalty (0.92).
 * - CC2 (platform-attested) = tiny penalty (0.96).
 * - CC3+ (enclave / trusted camera / DePIN) = neutral (1.00).
 */
export const CAPTURE_CLASS_MULTIPLIERS: Record<CaptureClass, number> = {
  [CaptureClass.CC0]: 0.70,
  [CaptureClass.CC1]: 0.92,
  [CaptureClass.CC2]: 0.96,
  [CaptureClass.CC3]: 1.00,
  [CaptureClass.CC4]: 1.00,
  [CaptureClass.CC5]: 1.00,
};

// ---------------------------------------------------------------------------
// Sensor fusion (CC1+)
// ---------------------------------------------------------------------------

/**
 * A single multi-sensor sample captured at a point in time.
 *
 * Accelerometer (3-axis), gyroscope (3-axis), and optional magnetometer /
 * gravity / ambient light / distance. Timestamps are relative to the trace
 * start (milliseconds).
 */
export interface SensorFusionSample {
  /** Milliseconds since trace.startedAt */
  ts: number;
  /** Accelerometer (x, y, z) in m/s^2 */
  accel: [number, number, number];
  /** Gyroscope (x, y, z) in rad/s */
  gyro: [number, number, number];
  /** Magnetometer (x, y, z) in microteslas */
  magnetometer?: [number, number, number];
  /** Linearized gravity vector (x, y, z) in m/s^2 */
  gravity?: [number, number, number];
  /** Ambient light in lux */
  light?: number;
  /** Proximity sensor distance in meters (0 = occluded) */
  distance?: number;
}

/**
 * A full multi-sensor trace covering a capture window.
 *
 * The verifier uses `parallaxScore` (optical-flow vs IMU correlation) and
 * `jerkScore` (derivative of acceleration — real human motion has
 * characteristic jerk signatures; static replay has near-zero jerk) as
 * liveness heuristics.
 */
export interface SensorFusionTrace {
  /** Identifier for the capture device producing this trace */
  deviceId: string;
  /** ISO 8601 timestamp when the trace window opened */
  startedAt: Timestamp;
  /** ISO 8601 timestamp when the trace window closed */
  endedAt: Timestamp;
  /** Ordered sequence of samples within [startedAt, endedAt] */
  samples: SensorFusionSample[];
  /** Optional: cosine similarity of optical-flow vs IMU-derived motion, in [-1, 1] */
  parallaxScore?: number;
  /** Optional: aggregate jerk (derivative of acceleration) score */
  jerkScore?: number;
}

// ---------------------------------------------------------------------------
// WebAuthn (CC1+)
// ---------------------------------------------------------------------------

/**
 * WebAuthn assertion over a capture.
 *
 * clientDataJSON, authenticatorData, and signature are raw WebAuthn
 * response blobs (base64url-encoded strings). `challenge` is the nonce the
 * server expected (also base64url); the verifier checks the blob decodes to
 * the same challenge. `signCount` is the monotonic counter returned by the
 * authenticator.
 */
export interface WebAuthnAssertion {
  /** The credential ID (base64url) the operator registered */
  credentialId: string;
  /** The assertion signature (base64url) */
  signature: string;
  /** The authenticator data blob (base64url) */
  authenticatorData: string;
  /** The client data JSON blob (base64url) */
  clientDataJSON: string;
  /** The challenge (base64url) that should appear inside clientDataJSON */
  challenge: string;
  /** Monotonic signature counter returned by the authenticator */
  signCount: number;
}

// ---------------------------------------------------------------------------
// Platform attestation (CC2+)
// ---------------------------------------------------------------------------

/**
 * Which platform attestation service produced this token.
 *
 * - `appattest`   — Apple App Attest (iOS)
 * - `devicecheck` — Apple DeviceCheck (iOS)
 * - `playintegrity` — Google Play Integrity (Android)
 */
export type PlatformAttestationSource =
  | "appattest"
  | "devicecheck"
  | "playintegrity";

/**
 * A platform hardware-attestation token bound to a capture.
 *
 * The token is opaque at this layer (the verifier parses it per-platform).
 * `nonce` MUST match the capture hash so the attestation is bound to this
 * specific capture and cannot be replayed from a prior capture.
 */
export interface PlatformAttestation {
  /** Which attestation service produced this token */
  source: PlatformAttestationSource;
  /** The raw token (JWT for Apple / signed blob for Google) */
  token: string;
  /** Nonce the attestation covers — typically the capture hash */
  nonce: string;
  /** Optional key identifier (App Attest) */
  keyId?: string;
  /** Optional application bundle identifier (iOS) or package name (Android) */
  bundleId?: string;
}

// ---------------------------------------------------------------------------
// C2PA (CC3+ / CC4+)
// ---------------------------------------------------------------------------

/**
 * A single C2PA assertion within a manifest.
 *
 * C2PA manifests are composed of many assertions (creative work, actions,
 * hardware, exif, thumbnail, ...). The verifier cross-checks well-known
 * labels like `c2pa.actions`, `c2pa.hardware`, `c2pa.claim`.
 */
export interface C2PAAssertion {
  /** Label identifying the assertion type (e.g. "c2pa.actions", "c2pa.hardware") */
  label: string;
  /** Arbitrary JSON payload for this assertion */
  data: unknown;
}

/**
 * A C2PA manifest attached to a capture.
 *
 * The full JUMBF-encoded manifest is hashed into `hash`; the verifier parses
 * the raw manifest externally and only consumes this structured view.
 */
export interface C2PAManifest {
  /** C2PA manifest version string */
  version: string;
  /** Software / hardware that produced the claim (e.g. "com.truepic", "Leica M11-P") */
  claimGenerator: string;
  /** Parsed assertions in the manifest */
  assertions: C2PAAssertion[];
  /** SHA256 of the canonical manifest bytes */
  hash: SHA256;
  /** Algorithm identifier for the manifest signature (e.g. "ES256", "Ed25519") */
  signatureAlgorithm: string;
  /** Optional — true iff signature verification passed against a trusted root */
  signatureValid?: boolean;
}

// ---------------------------------------------------------------------------
// Camera attestation (CC4+)
// ---------------------------------------------------------------------------

/**
 * Dedicated-hardware camera attestation (Leica, Sony, Nikon, Canon, ...).
 *
 * Each supported camera body holds a per-device signing key in hardware.
 * `publicKey` is the device's public key (hex or base64url); `signature` is
 * the signature over the capture bytes. The C2PA manifest, when present,
 * carries the manufacturer's certificate chain.
 */
export interface CameraAttestation {
  /** Manufacturer (e.g. "Leica", "Sony", "Nikon") */
  make: string;
  /** Camera model (e.g. "M11-P", "A1", "Z9") */
  model: string;
  /** Camera body serial number (kept off-chain; serialHash goes on-chain) */
  serial?: string;
  /** Firmware version at capture time — feeds into CC4 firmware-gate check */
  firmwareVersion?: string;
  /** Device public key (hex or base64url) */
  publicKey: string;
  /** Signature over the capture bytes */
  signature: string;
  /** Optional — attached C2PA manifest produced by the camera */
  c2paManifest?: C2PAManifest;
}

// ---------------------------------------------------------------------------
// DePIN attestation (CC5)
// ---------------------------------------------------------------------------

/**
 * Supported DePIN attestation sources.
 *
 * - `dimo`       — DIMO vehicle telemetry network
 * - `hivemapper` — Hivemapper dashcam / street-mapping
 * - `iotex`      — IoTeX W3bstream
 * - `dephy`      — DePHY decentralized device IDs
 */
export type DePINSource = "dimo" | "hivemapper" | "iotex" | "dephy";

/**
 * Cross-chain proof that a capture is already anchored on a DePIN network.
 *
 * `txHash` and `chainId` pinpoint the DePIN-side commitment. `payload`
 * carries provider-specific metadata (attester count, IPFS CID of the
 * canonical frame, ...).
 */
export interface DePINAttestation {
  /** Which DePIN network produced this attestation */
  source: DePINSource;
  /** DePIN-side device / kernel identifier */
  deviceId: string;
  /** On-chain transaction that committed the capture */
  txHash: string;
  /** Chain identifier (EVM chain id for EVM chains, network name otherwise) */
  chainId: number | string;
  /** Provider-specific payload (attester set, CIDs, etc.) */
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Capture manifest
// ---------------------------------------------------------------------------

/**
 * The full manifest submitted with every CVP capture.
 *
 * Every capture — from CC0 upward — ships this manifest. Fields not
 * applicable to the declared class are omitted. The canonical JSON hash of
 * this manifest is the `manifestHash` that gets anchored on-chain.
 */
export interface CaptureManifest {
  /** Declared capture class — detector may downgrade if evidence doesn't support */
  class: CaptureClass;
  /** ISO 8601 timestamp the operator claims the capture occurred */
  declaredAt: Timestamp;
  /** Opaque fingerprint identifying the device (kernel id, browser fingerprint, serial hash) */
  deviceFingerprint: string;
  /** SHA256 of the original capture bytes (image or video) */
  mediaHash: SHA256;
  /** CC1+ — multi-sensor trace bound to the capture window */
  sensorFusion?: SensorFusionTrace;
  /** CC1+ — WebAuthn assertion over the capture */
  webAuthnAssertion?: WebAuthnAssertion;
  /** CC2+ — platform hardware attestation */
  platformAttestation?: PlatformAttestation;
  /** CC3+ — attached C2PA manifest */
  c2paManifest?: C2PAManifest;
  /** CC4+ — dedicated-hardware camera attestation */
  camera?: CameraAttestation;
  /** CC5 — DePIN-chain attestation */
  depin?: DePINAttestation;
}

// ---------------------------------------------------------------------------
// Visual nonce + capture-nonce challenge
// ---------------------------------------------------------------------------

/**
 * An in-scene visual nonce the operator must embed in the capture frame.
 *
 * - `qr`      — a QR-encoded hex payload
 * - `color`   — a sequence of HSL tuples displayed on-screen in order
 * - `gesture` — a three-word prompt the operator performs physically
 *
 * The verifier runs a CV pass (CC1+) to confirm the nonce was visually
 * present in the capture.
 */
export interface VisualNonce {
  /** Nonce kind */
  type: "qr" | "color" | "gesture";
  /** Nonce payload — encoding depends on `type` */
  payload: string;
  /** ISO 8601 timestamp the nonce was rendered (server-side issuance time) */
  renderedAt: Timestamp;
}

/**
 * Payload of a capture-nonce challenge (issued by `ChallengeService`).
 *
 * Tightly block-anchored: `blockNumber` / `blockHash` / `blockTimestamp`
 * pin the challenge to a specific EVM block so the operator cannot pre-roll
 * captures against an older challenge. `maxAgeSeconds` caps the validity
 * window (default 120s for captures, strictly tighter than the 600s workflow
 * default).
 */
export interface CaptureNonceChallengePayload {
  /** UUID identifying the challenge */
  challengeId: string;
  /** Contract, capability, or job identifier this challenge binds to */
  scope: string;
  /** The visual nonce the operator must embed in-scene */
  visualNonce: VisualNonce;
  /** EVM block number at challenge issuance */
  blockNumber: number;
  /** 0x-prefixed block hash at issuance */
  blockHash: string;
  /** Block timestamp (unix seconds) at issuance */
  blockTimestamp: number;
  /** EVM chain id */
  chainId: number;
  /** ISO 8601 server-side issuance timestamp */
  issuedAt: Timestamp;
  /** Validity window in seconds — capped at 120 for capture nonces */
  maxAgeSeconds: number;
}

// ---------------------------------------------------------------------------
// Detection output
// ---------------------------------------------------------------------------

/**
 * A single piece of evidence the detector accumulated while classifying.
 *
 * `pass` identifies which detection pass (1 = DePIN, 2 = C2PA hardware,
 * 3 = C2PA enclave, 4 = platform, 5 = browser, 6 = default) produced the
 * evidence. `confidence` is in [0, 1].
 */
export interface DetectionEvidence {
  /** Which detection pass produced this evidence (1..6) */
  pass: 1 | 2 | 3 | 4 | 5 | 6;
  /** Short name of the signal (e.g. "c2pa_leica_root", "session_sig_valid") */
  name: string;
  /** Whether the signal was present / verified (positive) or missing / failed */
  positive: boolean;
  /** Confidence in the signal, 0..1 */
  confidence: number;
  /** Optional structured payload for debugging / UI */
  data?: Record<string, unknown>;
}

/**
 * Result of running the capture detector against an upload.
 *
 * `ceiling` is the highest class supported by the evidence. If the operator
 * declared a higher class than `ceiling`, `autoDowngrade` records the
 * mandatory reduction.
 */
export interface DetectionResult {
  /** Highest class supported by the signals gathered */
  ceiling: CaptureClass;
  /** All evidence rows accumulated during detection */
  evidence: DetectionEvidence[];
  /** Present iff detector downgraded declaredClass to a lower ceiling */
  autoDowngrade?: {
    from: CaptureClass;
    to: CaptureClass;
    reason: string;
  };
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const CaptureClassSchema = z.nativeEnum(CaptureClass);

const SensorFusionSampleSchema = z.object({
  ts: z.number().nonnegative(),
  accel: z.tuple([z.number(), z.number(), z.number()]),
  gyro: z.tuple([z.number(), z.number(), z.number()]),
  magnetometer: z
    .tuple([z.number(), z.number(), z.number()])
    .optional(),
  gravity: z.tuple([z.number(), z.number(), z.number()]).optional(),
  light: z.number().optional(),
  distance: z.number().optional(),
});

const SensorFusionTraceSchema = z.object({
  deviceId: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  samples: z.array(SensorFusionSampleSchema),
  parallaxScore: z.number().min(-1).max(1).optional(),
  jerkScore: z.number().optional(),
});

const WebAuthnAssertionSchema = z.object({
  credentialId: z.string().min(1),
  signature: z.string().min(1),
  authenticatorData: z.string().min(1),
  clientDataJSON: z.string().min(1),
  challenge: z.string().min(1),
  signCount: z.number().int().nonnegative(),
});

const PlatformAttestationSourceSchema = z.enum([
  "appattest",
  "devicecheck",
  "playintegrity",
]);

const PlatformAttestationSchema = z.object({
  source: PlatformAttestationSourceSchema,
  token: z.string().min(1),
  nonce: z.string().min(1),
  keyId: z.string().optional(),
  bundleId: z.string().optional(),
});

const SHA256Schema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "Must be sha256:<64 hex chars>");

const C2PAAssertionSchema = z.object({
  label: z.string().min(1),
  data: z.unknown(),
});

const C2PAManifestSchema = z.object({
  version: z.string().min(1),
  claimGenerator: z.string().min(1),
  assertions: z.array(C2PAAssertionSchema),
  hash: SHA256Schema,
  signatureAlgorithm: z.string().min(1),
  signatureValid: z.boolean().optional(),
});

const CameraAttestationSchema = z.object({
  make: z.string().min(1),
  model: z.string().min(1),
  serial: z.string().optional(),
  firmwareVersion: z.string().optional(),
  publicKey: z.string().min(1),
  signature: z.string().min(1),
  c2paManifest: C2PAManifestSchema.optional(),
});

const DePINSourceSchema = z.enum([
  "dimo",
  "hivemapper",
  "iotex",
  "dephy",
]);

const DePINAttestationSchema = z.object({
  source: DePINSourceSchema,
  deviceId: z.string().min(1),
  txHash: z.string().min(1),
  chainId: z.union([z.number(), z.string()]),
  payload: z.record(z.string(), z.unknown()),
});

/**
 * Zod schema validating a `CaptureManifest` payload at the API boundary.
 *
 * Enforces: the discriminant (`class`), the mandatory hashing fields, and
 * the per-class optional sub-manifests. Unknown fields are stripped by
 * default (zod passthrough NOT enabled).
 *
 * The schema is annotated as `z.ZodType<CaptureManifest>` via an explicit
 * cast rather than a strict generic because Zod's inferred SHA256 string
 * ("string") is not literally assignable to the template-literal alias
 * `SHA256 = \`sha256:\${string}\``. The regex guarantees runtime safety.
 */
export const CaptureManifestSchema: z.ZodType<CaptureManifest> = z.object({
  class: CaptureClassSchema,
  declaredAt: z.string().datetime(),
  deviceFingerprint: z.string().min(1),
  mediaHash: SHA256Schema,
  sensorFusion: SensorFusionTraceSchema.optional(),
  webAuthnAssertion: WebAuthnAssertionSchema.optional(),
  platformAttestation: PlatformAttestationSchema.optional(),
  c2paManifest: C2PAManifestSchema.optional(),
  camera: CameraAttestationSchema.optional(),
  depin: DePINAttestationSchema.optional(),
}) as unknown as z.ZodType<CaptureManifest>;
