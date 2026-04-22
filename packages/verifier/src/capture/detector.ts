/**
 * CaptureDetector — 6-pass multi-modal pan-domain classifier.
 *
 * Receives a `CaptureManifest` plus optional adapter-reported liveness /
 * platform / C2PA / camera / DePIN evidence, and establishes the HIGHEST
 * `CaptureClass` the evidence supports (the "ceiling"). If the operator
 * declared a class higher than the ceiling, the result records an
 * `autoDowngrade` from declared → ceiling.
 *
 * See:
 *   ai/research/capture-verification-protocol.md §4 + §6
 *
 * The six passes, accumulating evidence in ascending-authenticity order:
 *
 *   Pass 1 — Signature Presence  (sets floor class from which signatures exist)
 *   Pass 2 — Nonce Echo          (visual in-scene nonce matches challenge)
 *   Pass 3 — Liveness            (face detection + blink + head-yaw via adapter)
 *   Pass 4 — Multi-sensor Fusion (≥3 concurrent sensor streams present)
 *   Pass 5 — Platform Attestation (Apple/Google hardware-backed token)
 *   Pass 6 — Anti-Spoof Check    (motion-vs-still heuristics + fingerprint)
 *
 * Each pass emits a `DetectionEvidence` row with `pass` (1..6), a `name`, a
 * `positive` flag, and a `confidence` in [0,1]. If a pass's required adapter
 * is missing, the pass is marked SKIP (positive=false, confidence=0) — this
 * is NOT treated as a failure; the ceiling is still raised by any signals
 * that other passes managed to collect.
 *
 * Defensive defaults:
 *   - Missing adapter   → pass = SKIP (no ceiling change, no warning)
 *   - Adapter throws    → pass = FAIL with warning, ceiling not raised
 *   - Absent manifest   → minimum possible ceiling (CC0) always returned
 *
 * This file is pure TypeScript logic. All external capabilities (face
 * landmarker, C2PA parser, platform-attestation verifier, camera
 * attestation verifier, DePIN chain reader) are abstracted behind adapter
 * interfaces so the detector can be tested with mocks and wired to real
 * implementations in later waves.
 */

import {
  CaptureClass,
  type CaptureManifest,
  type DetectionEvidence,
  type DetectionResult,
  type PlatformAttestationSource,
  type SensorFusionTrace,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

/**
 * Result of running a face-landmarker pass over captured frame(s).
 *
 * Real implementation (Wave 3) wraps MediaPipe Face Landmarker
 * (Apache-2.0). The detector only consumes these structured booleans +
 * angles, so mock implementations are trivial.
 */
export interface FaceLandmarkerResult {
  /** Whether at least one face was detected in the capture window */
  hasFace: boolean;
  /** Whether a blink was observed (eye-aspect-ratio dip) */
  blinkDetected: boolean;
  /** Maximum observed head-yaw (degrees off neutral pose) */
  yawDegrees: number;
}

/**
 * Adapter for client-side face liveness detection.
 *
 * Used by Pass 3. Real implementation wraps MediaPipe Face Landmarker
 * running on the captured frames. Stub implementations can return
 * deterministic results for tests.
 */
export interface FaceLandmarkerAdapter {
  detectFace(frameBlob: Uint8Array): Promise<FaceLandmarkerResult>;
}

/**
 * Minimal parsed view of a C2PA manifest that the detector cares about.
 *
 * Wraps the heavy `@contentauth/c2pa-node` parse output into a
 * domain-friendly shape. Signature validity + hardware cert fingerprint
 * is what drives CC3/CC4 ceiling in later waves.
 */
export interface ParsedC2PA {
  /** Signature passed cryptographic verification against the trust store */
  signatureValid: boolean;
  /** Claim generator string (e.g. "com.truepic", "Leica M11-P") */
  claimGenerator: string;
  /** True iff the signing cert chains to a known hardware-camera root */
  hardwareCamera: boolean;
  /** True iff the signing cert chains to a known enclave-SDK root (Truepic, ...) */
  enclaveSigned: boolean;
}

/**
 * Adapter for parsing C2PA JUMBF-encoded manifests.
 *
 * Used by Pass 1 when a C2PA manifest is attached. Real implementation
 * (Wave 3) will wrap `@contentauth/c2pa-node` after it passes Gate A.
 */
export interface C2PAParserAdapter {
  parseManifest(bytes: Uint8Array): Promise<ParsedC2PA>;
}

/**
 * Result of verifying a platform-attestation token (App Attest /
 * DeviceCheck / Play Integrity).
 */
export interface PlatformAttestationResult {
  /** Cryptographic signature verification against Apple/Google public keys */
  signatureValid: boolean;
  /** Nonce in attestation matches the expected `challengeId` */
  nonceMatches: boolean;
  /** True iff attestation was signed within the allowed freshness window */
  withinTtl: boolean;
  /** Attestation strength tier — only `strong` fully qualifies for CC2 */
  integrity: "strong" | "standard" | "virtual" | "failed";
}

/**
 * Adapter for verifying platform hardware-attestation tokens.
 *
 * Used by Pass 5. Real implementation wraps
 * `appattest-checker-node` (Apple) + a Play Integrity JWT verifier
 * (Google).
 */
export interface PlatformAttestationAdapter {
  verify(params: {
    source: PlatformAttestationSource;
    token: string;
    expectedNonce: string;
  }): Promise<PlatformAttestationResult>;
}

/**
 * Adapter for verifying dedicated-hardware camera attestations (CC4).
 *
 * Not exercised directly by the 6-pass detector (camera attestation
 * drives ceiling raise to CC4 via Pass 1 + C2PA adapter), but exposed
 * for downstream verifier stages.
 */
export interface CameraAttestationAdapter {
  verify(params: {
    make: string;
    model: string;
    publicKey: string;
    signature: string;
    capturedBytes: Uint8Array;
  }): Promise<{ signatureValid: boolean; firmwareAcceptable: boolean }>;
}

/**
 * Adapter for cross-chain DePIN attestation verification (CC5).
 *
 * Not exercised directly by the detector's 6 passes, but exposed so the
 * verifier stage (Wave 3) can plug in per-provider clients
 * (Hivemapper, DIMO, IoTeX, DePHY).
 */
export interface DePINAttestationAdapter {
  verify(params: {
    source: string;
    txHash: string;
    chainId: number | string;
    expectedCaptureHash: string;
  }): Promise<{
    exists: boolean;
    attesterCount: number;
    hashMatches: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Detector configuration
// ---------------------------------------------------------------------------

/**
 * Adapters the detector optionally consumes. ALL fields are optional —
 * if a given adapter is absent, the passes that depend on it are marked
 * SKIP (not fail).
 */
export interface CaptureDetectorAdapters {
  faceLandmarker?: FaceLandmarkerAdapter;
  c2paParser?: C2PAParserAdapter;
  platformAttestation?: PlatformAttestationAdapter;
  cameraAttestation?: CameraAttestationAdapter;
  depinAttestation?: DePINAttestationAdapter;
}

/**
 * Extra input the detector consumes beyond the `CaptureManifest`.
 *
 * Kept optional so existing callers that only have a manifest can still
 * run the detector (at reduced accuracy — they won't get liveness or
 * C2PA-parse signals).
 */
export interface CaptureDetectionInput {
  /** The capture manifest submitted by the operator */
  manifest: CaptureManifest;
  /** The challenge id this capture claims to answer (for Pass 5 nonce check) */
  challengeId?: string;
  /** The visual nonce payload the server issued (for Pass 2 echo check) */
  expectedVisualNoncePayload?: string;
  /** The visual nonce payload the client claims was embedded (extracted by CV) */
  visualNonceEcho?: string;
  /** Raw captured frame bytes (for face-landmarker pass) */
  frameBlob?: Uint8Array;
  /** Raw C2PA JUMBF manifest bytes (for C2PA parser pass) */
  c2paManifestBytes?: Uint8Array;
  /** Device-fingerprint seen on prior enrollments for this operator */
  knownDeviceFingerprints?: string[];
}

/**
 * Extended detection output exposed by the detector.
 *
 * Extends the spec `DetectionResult` with richer telemetry (declared
 * class, aggregate confidence, anti-spoof warnings, on-chain-anchor
 * candidacy). Spec-level consumers can project down to
 * `DetectionResult` via the fields they already know.
 */
export interface CaptureDetectionResult extends DetectionResult {
  /** What the operator said they were submitting */
  declaredClass: CaptureClass;
  /** Alias of `ceiling` for callers who prefer the task-spec vocabulary */
  detectedCeiling: CaptureClass;
  /** Aggregate detection confidence in [0,1] */
  confidence: number;
  /** Soft warnings (did not fail any pass, but worth logging) */
  warnings: string[];
  /**
   * True iff the verifier should push this capture to on-chain
   * `CaptureClassRegistry`. False when: detected class is CC0 AND no
   * positive signals were collected (pure bytes-only upload).
   */
  anchorCandidate: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rank order from lowest-trust to highest-trust class. */
const CLASS_ORDER: readonly CaptureClass[] = [
  CaptureClass.CC0,
  CaptureClass.CC1,
  CaptureClass.CC2,
  CaptureClass.CC3,
  CaptureClass.CC4,
  CaptureClass.CC5,
];

/** Integer rank of a class so we can compare ceilings with `<`/`>`. */
function classRank(c: CaptureClass): number {
  return CLASS_ORDER.indexOf(c);
}

/** Return the higher (more authentic) of two classes. */
function maxClass(a: CaptureClass, b: CaptureClass): CaptureClass {
  return classRank(a) >= classRank(b) ? a : b;
}

/** Return the lower (more conservative) of two classes. */
function minClass(a: CaptureClass, b: CaptureClass): CaptureClass {
  return classRank(a) <= classRank(b) ? a : b;
}

/** Minimum sensor streams required to treat a trace as fused (Pass 4). */
const MIN_FUSED_STREAMS = 3;

/** Variance threshold under which motion is considered "flat" (replay risk). */
const FLAT_MOTION_VARIANCE = 0.05;

/** Minimum yaw (degrees) to count as real head motion (Pass 3). */
const MIN_HEAD_YAW_DEGREES = 5;

/**
 * Count how many distinct sensor streams a `SensorFusionTrace` carries.
 *
 * Required streams are camera + gyroscope + accelerometer (implicit by
 * the `samples` field being non-empty). Optional streams add to the
 * count when ANY sample has a value for that field:
 *   - magnetometer
 *   - gravity
 *   - ambient light
 *   - distance
 *   - GPS (modeled as the presence of either a `parallaxScore` derived
 *     from optical-flow, counted implicitly by non-empty samples)
 *
 * We do NOT count GPS as a separate stream in this default pipeline —
 * GPS lives on the manifest at a higher layer (not on each sample).
 */
function countSensorStreams(trace: SensorFusionTrace): number {
  if (trace.samples.length === 0) return 0;
  // Camera + accel + gyro are the 3 mandatory baseline streams — present
  // whenever there is at least one sample. Return 3 + optional streams.
  let count = 3;
  const hasMagnetometer = trace.samples.some((s) => s.magnetometer !== undefined);
  const hasGravity = trace.samples.some((s) => s.gravity !== undefined);
  const hasLight = trace.samples.some((s) => s.light !== undefined);
  const hasDistance = trace.samples.some((s) => s.distance !== undefined);
  if (hasMagnetometer) count++;
  if (hasGravity) count++;
  if (hasLight) count++;
  if (hasDistance) count++;
  return count;
}

/**
 * Compute the L2-norm variance of accelerometer magnitude across a trace.
 *
 * Used by Pass 6 as a replay-vs-live heuristic. A tripod-on-screen replay
 * shows near-zero accel variance; a real handheld capture has non-zero
 * human micro-jitter.
 */
function accelVariance(trace: SensorFusionTrace): number {
  if (trace.samples.length < 2) return 0;
  const magnitudes = trace.samples.map((s) => {
    const [x, y, z] = s.accel;
    return Math.sqrt(x * x + y * y + z * z);
  });
  const mean = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
  const variance =
    magnitudes.reduce((sum, m) => sum + (m - mean) ** 2, 0) / magnitudes.length;
  return variance;
}

/** Shorthand for building a skipped evidence row. */
function skipEvidence(
  pass: DetectionEvidence["pass"],
  name: string,
  reason: string,
): DetectionEvidence {
  return {
    pass,
    name,
    positive: false,
    confidence: 0,
    data: { status: "skipped", reason },
  };
}

/** Shorthand for building a positive evidence row. */
function positiveEvidence(
  pass: DetectionEvidence["pass"],
  name: string,
  confidence: number,
  data?: Record<string, unknown>,
): DetectionEvidence {
  return {
    pass,
    name,
    positive: true,
    confidence,
    data,
  };
}

/** Shorthand for building a negative (failed-signal) evidence row. */
function negativeEvidence(
  pass: DetectionEvidence["pass"],
  name: string,
  reason: string,
  data?: Record<string, unknown>,
): DetectionEvidence {
  return {
    pass,
    name,
    positive: false,
    confidence: 0,
    data: { reason, ...data },
  };
}

// ---------------------------------------------------------------------------
// CaptureDetector
// ---------------------------------------------------------------------------

/**
 * Runs the 6-pass detection pipeline against a capture submission.
 *
 * Typical usage (in Wave 3+ gateway wiring):
 * ```
 * const detector = new CaptureDetector({
 *   faceLandmarker, c2paParser, platformAttestation,
 * });
 * const result = await detector.detect({ manifest, challengeId, ... });
 * if (result.autoDowngrade) {
 *   log.info(`CVP: downgraded ${result.declaredClass} → ${result.ceiling}`);
 * }
 * ```
 */
export class CaptureDetector {
  constructor(private readonly adapters: CaptureDetectorAdapters = {}) {}

  async detect(
    input: CaptureDetectionInput,
  ): Promise<CaptureDetectionResult> {
    const { manifest } = input;
    const evidence: DetectionEvidence[] = [];
    const warnings: string[] = [];

    // Start every detection at the unsigned floor (CC0). Each pass may raise.
    let ceiling: CaptureClass = CaptureClass.CC0;

    // -----------------------------------------------------------------------
    // Pass 1 — Signature Presence
    //
    // Walk the manifest for any cryptographic provenance. Each signature
    // type raises the ceiling to the corresponding minimum class. This
    // pass CANNOT fail — it only raises the floor based on what's
    // declared.
    // -----------------------------------------------------------------------
    const p1 = await this.pass1SignaturePresence(input);
    evidence.push(...p1.evidence);
    ceiling = maxClass(ceiling, p1.ceiling);

    // -----------------------------------------------------------------------
    // Pass 2 — Nonce Echo
    //
    // The visual nonce the server issued MUST appear in the capture (CV
    // pass extracts it, caller passes extracted payload as
    // `visualNonceEcho`). If server did not provide `expectedVisualNoncePayload`
    // for this capture, Pass 2 is SKIP.
    // -----------------------------------------------------------------------
    const p2 = this.pass2NonceEcho(input);
    evidence.push(p2);

    // -----------------------------------------------------------------------
    // Pass 3 — Liveness (face-landmarker via adapter)
    //
    // If the client claimed CC1+, demand face + blink + head-yaw from the
    // adapter. Lack of adapter → SKIP (ceiling stays wherever it was).
    // Lack of face-liveness → ceiling capped at CC1 max (floor for
    // browser-signed captures but cannot climb to CC2 on absent liveness).
    // -----------------------------------------------------------------------
    const p3 = await this.pass3Liveness(input);
    evidence.push(p3.evidence);
    if (p3.capAtCC1) {
      // Fallthrough: if a higher-tier signature was already detected
      // (CC3/CC4/CC5 have their own attestation paths and do not need
      // face-liveness to justify ceiling), keep the higher ceiling.
      // Only cap when ceiling is at CC1 or CC2 and liveness is absent.
      if (classRank(ceiling) === classRank(CaptureClass.CC1)) {
        warnings.push(
          "pass3_liveness_absent: CC1 floor held but no face-liveness evidence",
        );
      }
    }

    // -----------------------------------------------------------------------
    // Pass 4 — Multi-sensor Fusion
    //
    // SensorFusionTrace must contain ≥3 concurrent sensor streams
    // (camera + accel + gyro baseline; magnetometer/gravity/light/distance
    // add streams). Below the threshold → ceiling is capped at CC0
    // (even if session signatures exist, the lack of multi-sensor
    // evidence disqualifies CC1+ claims).
    // -----------------------------------------------------------------------
    const p4 = this.pass4MultiSensor(input);
    evidence.push(p4.evidence);
    if (p4.capAtCC0) {
      // Only cap downward when the capture is claiming CC1+ — CC5/CC4/CC3
      // paths have their own evidence chains that don't depend on the
      // phone's sensor fusion.
      if (
        classRank(ceiling) <= classRank(CaptureClass.CC2) &&
        classRank(ceiling) >= classRank(CaptureClass.CC1)
      ) {
        warnings.push(
          `pass4_fusion_insufficient: ceiling capped at CC0 (${p4.evidence.data?.streamCount ?? 0} streams, need ${MIN_FUSED_STREAMS})`,
        );
        ceiling = CaptureClass.CC0;
      }
    }

    // -----------------------------------------------------------------------
    // Pass 5 — Platform Attestation
    //
    // If PlatformAttestation is present, verify: (a) source is one of
    // appattest/devicecheck/playintegrity, (b) nonce matches challengeId,
    // (c) token is within TTL. Success raises ceiling to CC2 minimum.
    // -----------------------------------------------------------------------
    const p5 = await this.pass5PlatformAttestation(input);
    evidence.push(p5.evidence);
    if (p5.raiseCeiling) {
      ceiling = maxClass(ceiling, CaptureClass.CC2);
    }

    // -----------------------------------------------------------------------
    // Pass 6 — Anti-Spoof Check
    //
    // Cross-reference manifest timestamps, device fingerprint stability,
    // motion-vs-still heuristics. Flat motion suggests pre-recorded
    // video → cap ceiling at CC0. Unknown device fingerprint → flag
    // (warning, not rejection).
    // -----------------------------------------------------------------------
    const p6 = this.pass6AntiSpoof(input);
    evidence.push(...p6.evidence);
    for (const w of p6.warnings) warnings.push(w);
    if (p6.capAtCC0) {
      if (classRank(ceiling) > classRank(CaptureClass.CC0)) {
        warnings.push(
          "pass6_flat_motion: suspected replay attack, capping ceiling at CC0",
        );
        ceiling = CaptureClass.CC0;
      }
    }

    // -----------------------------------------------------------------------
    // Final: compute downgrade + confidence + anchor candidacy.
    // -----------------------------------------------------------------------
    const declaredClass = manifest.class;
    const finalCeiling = minClass(declaredClass, ceiling);
    const autoDowngrade =
      classRank(declaredClass) > classRank(ceiling)
        ? {
            from: declaredClass,
            to: finalCeiling,
            reason: `declared ${declaredClass} but ceiling is ${ceiling} — insufficient evidence`,
          }
        : undefined;

    const confidence = aggregateConfidence(evidence);
    const positiveCount = evidence.filter((e) => e.positive).length;
    const anchorCandidate =
      classRank(finalCeiling) > classRank(CaptureClass.CC0) ||
      positiveCount > 0;

    const result: CaptureDetectionResult = {
      ceiling: finalCeiling,
      evidence,
      declaredClass,
      detectedCeiling: finalCeiling,
      confidence,
      warnings,
      anchorCandidate,
    };
    if (autoDowngrade !== undefined) {
      result.autoDowngrade = autoDowngrade;
    }
    return result;
  }

  // =========================================================================
  // Pass implementations
  // =========================================================================

  /**
   * Pass 1 — Signature Presence.
   *
   * Walks the manifest for cryptographic provenance. For each signature
   * type found, emits a positive evidence row and raises the returned
   * ceiling. Order of checks (lowest → highest authenticity):
   *   WebAuthn        → CC1
   *   PlatformAttest  → CC2 (full verification is Pass 5; Pass 1 only
   *                     notes presence)
   *   C2PA enclave    → CC3
   *   C2PA hardware   → CC4
   *   Camera attest   → CC4 (parallel path)
   *   DePIN attest    → CC5
   *
   * If no signatures are present, the returned ceiling is CC0.
   */
  private async pass1SignaturePresence(
    input: CaptureDetectionInput,
  ): Promise<{ evidence: DetectionEvidence[]; ceiling: CaptureClass }> {
    const { manifest } = input;
    const evidence: DetectionEvidence[] = [];
    let ceiling: CaptureClass = CaptureClass.CC0;

    // WebAuthn assertion — CC1 floor.
    if (manifest.webAuthnAssertion) {
      evidence.push(
        positiveEvidence(1, "pass1_webauthn_present", 0.8, {
          credentialId: manifest.webAuthnAssertion.credentialId,
          signCount: manifest.webAuthnAssertion.signCount,
        }),
      );
      ceiling = maxClass(ceiling, CaptureClass.CC1);
    } else {
      evidence.push(skipEvidence(1, "pass1_webauthn_present", "no WebAuthn assertion in manifest"));
    }

    // Platform attestation token — CC2 floor (verification is Pass 5).
    if (manifest.platformAttestation) {
      evidence.push(
        positiveEvidence(1, "pass1_platform_attestation_present", 0.7, {
          source: manifest.platformAttestation.source,
        }),
      );
      ceiling = maxClass(ceiling, CaptureClass.CC2);
    } else {
      evidence.push(
        skipEvidence(
          1,
          "pass1_platform_attestation_present",
          "no platformAttestation in manifest",
        ),
      );
    }

    // C2PA manifest — may raise to CC3 (enclave) or CC4 (hardware camera).
    if (manifest.c2paManifest) {
      if (this.adapters.c2paParser && input.c2paManifestBytes) {
        try {
          const parsed = await this.adapters.c2paParser.parseManifest(
            input.c2paManifestBytes,
          );
          if (parsed.signatureValid && parsed.hardwareCamera) {
            evidence.push(
              positiveEvidence(1, "pass1_c2pa_hardware_camera", 0.95, {
                claimGenerator: parsed.claimGenerator,
              }),
            );
            ceiling = maxClass(ceiling, CaptureClass.CC4);
          } else if (parsed.signatureValid && parsed.enclaveSigned) {
            evidence.push(
              positiveEvidence(1, "pass1_c2pa_enclave", 0.9, {
                claimGenerator: parsed.claimGenerator,
              }),
            );
            ceiling = maxClass(ceiling, CaptureClass.CC3);
          } else if (parsed.signatureValid) {
            evidence.push(
              positiveEvidence(1, "pass1_c2pa_generic", 0.5, {
                claimGenerator: parsed.claimGenerator,
              }),
            );
            // Unknown C2PA signer — do not raise past CC2 on bare signature.
          } else {
            evidence.push(
              negativeEvidence(
                1,
                "pass1_c2pa_signature_invalid",
                "C2PA signature did not verify",
                { claimGenerator: parsed.claimGenerator },
              ),
            );
          }
        } catch (err) {
          evidence.push(
            negativeEvidence(1, "pass1_c2pa_parse_error", String(err)),
          );
        }
      } else {
        // Adapter absent — can only note presence, not verify.
        evidence.push(
          positiveEvidence(1, "pass1_c2pa_manifest_present_unverified", 0.3, {
            claimGenerator: manifest.c2paManifest.claimGenerator,
          }),
        );
      }
    } else {
      evidence.push(
        skipEvidence(1, "pass1_c2pa_manifest", "no C2PA manifest attached"),
      );
    }

    // Camera attestation (CC4 — parallel path to C2PA hardware).
    if (manifest.camera) {
      evidence.push(
        positiveEvidence(1, "pass1_camera_attestation_present", 0.85, {
          make: manifest.camera.make,
          model: manifest.camera.model,
        }),
      );
      ceiling = maxClass(ceiling, CaptureClass.CC4);
    } else {
      evidence.push(
        skipEvidence(1, "pass1_camera_attestation", "no camera attestation"),
      );
    }

    // DePIN attestation — CC5.
    if (manifest.depin) {
      evidence.push(
        positiveEvidence(1, "pass1_depin_attestation_present", 0.9, {
          source: manifest.depin.source,
          chainId: manifest.depin.chainId,
        }),
      );
      ceiling = maxClass(ceiling, CaptureClass.CC5);
    } else {
      evidence.push(
        skipEvidence(1, "pass1_depin_attestation", "no DePIN attestation"),
      );
    }

    return { evidence, ceiling };
  }

  /**
   * Pass 2 — Nonce Echo.
   *
   * The CV pipeline (run upstream of the detector) extracts the visual
   * nonce payload that appeared in the capture frame. This pass checks
   * that the extracted payload matches the server-issued expected
   * payload, byte-for-byte.
   *
   * Both `expectedVisualNoncePayload` and `visualNonceEcho` being absent
   * → SKIP (no claim was made). One absent and the other present →
   * explicit mismatch.
   */
  private pass2NonceEcho(input: CaptureDetectionInput): DetectionEvidence {
    const { expectedVisualNoncePayload, visualNonceEcho } = input;

    if (
      expectedVisualNoncePayload === undefined &&
      visualNonceEcho === undefined
    ) {
      return skipEvidence(
        2,
        "pass2_nonce_echo",
        "no visual nonce claim in this capture",
      );
    }

    if (expectedVisualNoncePayload === undefined) {
      return negativeEvidence(
        2,
        "pass2_nonce_echo",
        "client echoed a nonce but server has no expected payload to compare",
      );
    }

    if (visualNonceEcho === undefined) {
      return negativeEvidence(
        2,
        "pass2_nonce_echo",
        "server expected a nonce echo but none was provided",
      );
    }

    if (expectedVisualNoncePayload === visualNonceEcho) {
      return positiveEvidence(2, "pass2_nonce_echo", 1.0, {
        payloadLength: expectedVisualNoncePayload.length,
      });
    }

    return negativeEvidence(
      2,
      "pass2_nonce_echo",
      "visual nonce echo does not match issued payload",
    );
  }

  /**
   * Pass 3 — Liveness (face landmarker via adapter).
   *
   * Run the face-landmarker adapter on the captured frame blob. Return
   * positive evidence only if ALL of:
   *   - hasFace
   *   - blinkDetected
   *   - |yawDegrees| >= MIN_HEAD_YAW_DEGREES
   *
   * Missing adapter → SKIP (does not cap ceiling). Missing frame → SKIP.
   * Adapter throws → negative evidence + no ceiling change.
   */
  private async pass3Liveness(
    input: CaptureDetectionInput,
  ): Promise<{ evidence: DetectionEvidence; capAtCC1: boolean }> {
    const adapter = this.adapters.faceLandmarker;
    if (!adapter) {
      return {
        evidence: skipEvidence(3, "pass3_liveness", "FaceLandmarkerAdapter not provided"),
        capAtCC1: false,
      };
    }
    if (!input.frameBlob || input.frameBlob.byteLength === 0) {
      return {
        evidence: skipEvidence(3, "pass3_liveness", "no frameBlob provided"),
        capAtCC1: false,
      };
    }

    try {
      const r = await adapter.detectFace(input.frameBlob);
      const yawOk = Math.abs(r.yawDegrees) >= MIN_HEAD_YAW_DEGREES;
      if (r.hasFace && r.blinkDetected && yawOk) {
        return {
          evidence: positiveEvidence(3, "pass3_liveness", 0.9, {
            hasFace: true,
            blinkDetected: true,
            yawDegrees: r.yawDegrees,
          }),
          capAtCC1: false,
        };
      }
      return {
        evidence: negativeEvidence(
          3,
          "pass3_liveness",
          `insufficient liveness (face=${r.hasFace}, blink=${r.blinkDetected}, yaw=${r.yawDegrees})`,
          { hasFace: r.hasFace, blinkDetected: r.blinkDetected, yawDegrees: r.yawDegrees },
        ),
        capAtCC1: true,
      };
    } catch (err) {
      return {
        evidence: negativeEvidence(
          3,
          "pass3_liveness",
          `face-landmarker adapter error: ${String(err)}`,
        ),
        capAtCC1: false,
      };
    }
  }

  /**
   * Pass 4 — Multi-sensor Fusion.
   *
   * Count distinct sensor streams in the manifest's `sensorFusion`
   * trace. Require at least `MIN_FUSED_STREAMS` (=3) concurrent
   * streams. If the trace is missing or under the threshold → SKIP
   * (if absent) or negative + capAtCC0 (if under threshold).
   */
  private pass4MultiSensor(
    input: CaptureDetectionInput,
  ): { evidence: DetectionEvidence; capAtCC0: boolean } {
    const trace = input.manifest.sensorFusion;
    if (!trace) {
      return {
        evidence: skipEvidence(
          4,
          "pass4_sensor_fusion",
          "no sensorFusion trace in manifest",
        ),
        capAtCC0: false,
      };
    }

    const streamCount = countSensorStreams(trace);
    if (streamCount >= MIN_FUSED_STREAMS) {
      return {
        evidence: positiveEvidence(4, "pass4_sensor_fusion", 0.85, {
          streamCount,
          sampleCount: trace.samples.length,
        }),
        capAtCC0: false,
      };
    }
    return {
      evidence: negativeEvidence(
        4,
        "pass4_sensor_fusion",
        `insufficient streams: ${streamCount} (need ${MIN_FUSED_STREAMS})`,
        { streamCount, sampleCount: trace.samples.length },
      ),
      capAtCC0: true,
    };
  }

  /**
   * Pass 5 — Platform Attestation.
   *
   * If a platform attestation is present, call the adapter to verify:
   *   - source is appattest | devicecheck | playintegrity
   *   - nonce matches the current `challengeId`
   *   - token is within TTL
   *
   * Success raises ceiling to CC2 (returned via `raiseCeiling`).
   * Missing adapter but present attestation → informational (Pass 1
   * already noted presence; Pass 5 emits SKIP so we don't
   * double-raise).
   */
  private async pass5PlatformAttestation(
    input: CaptureDetectionInput,
  ): Promise<{ evidence: DetectionEvidence; raiseCeiling: boolean }> {
    const platform = input.manifest.platformAttestation;
    if (!platform) {
      return {
        evidence: skipEvidence(
          5,
          "pass5_platform_attestation",
          "no platformAttestation on manifest",
        ),
        raiseCeiling: false,
      };
    }

    const adapter = this.adapters.platformAttestation;
    if (!adapter) {
      return {
        evidence: skipEvidence(
          5,
          "pass5_platform_attestation",
          "PlatformAttestationAdapter not provided",
        ),
        raiseCeiling: false,
      };
    }

    const expectedNonce = input.challengeId ?? platform.nonce;
    try {
      const r = await adapter.verify({
        source: platform.source,
        token: platform.token,
        expectedNonce,
      });
      if (r.signatureValid && r.nonceMatches && r.withinTtl && r.integrity === "strong") {
        return {
          evidence: positiveEvidence(5, "pass5_platform_attestation", 0.95, {
            source: platform.source,
            integrity: r.integrity,
          }),
          raiseCeiling: true,
        };
      }
      return {
        evidence: negativeEvidence(
          5,
          "pass5_platform_attestation",
          `verification failed: sig=${r.signatureValid} nonce=${r.nonceMatches} ttl=${r.withinTtl} integrity=${r.integrity}`,
          r,
        ),
        raiseCeiling: false,
      };
    } catch (err) {
      return {
        evidence: negativeEvidence(
          5,
          "pass5_platform_attestation",
          `adapter error: ${String(err)}`,
        ),
        raiseCeiling: false,
      };
    }
  }

  /**
   * Pass 6 — Anti-Spoof.
   *
   * Cross-cutting checks:
   *   (a) Motion-vs-still: accel variance on `sensorFusion` must exceed
   *       `FLAT_MOTION_VARIANCE`. Flat motion signals a replay.
   *   (b) Device fingerprint: if `knownDeviceFingerprints` is supplied
   *       and `manifest.deviceFingerprint` is NOT in the list → flag
   *       (warning only, does not cap ceiling).
   *   (c) `jerkScore` (already computed upstream) within [0,1] sanity.
   *       Out of range → warning.
   *
   * Flat motion → capAtCC0 = true (tells the top-level loop to cap).
   * Fingerprint mismatch → warning only (no cap).
   */
  private pass6AntiSpoof(input: CaptureDetectionInput): {
    evidence: DetectionEvidence[];
    warnings: string[];
    capAtCC0: boolean;
  } {
    const evidence: DetectionEvidence[] = [];
    const warnings: string[] = [];
    let capAtCC0 = false;

    // (a) Motion variance check.
    const trace = input.manifest.sensorFusion;
    if (trace && trace.samples.length >= 2) {
      const variance = accelVariance(trace);
      if (variance < FLAT_MOTION_VARIANCE) {
        evidence.push(
          negativeEvidence(
            6,
            "pass6_motion_variance",
            `flat motion (variance=${variance.toFixed(4)} < ${FLAT_MOTION_VARIANCE}) — possible replay`,
            { variance },
          ),
        );
        capAtCC0 = true;
      } else {
        evidence.push(
          positiveEvidence(6, "pass6_motion_variance", 0.7, { variance }),
        );
      }
    } else {
      evidence.push(
        skipEvidence(
          6,
          "pass6_motion_variance",
          "no sensorFusion or <2 samples — cannot compute variance",
        ),
      );
    }

    // (b) Device fingerprint stability.
    if (
      input.knownDeviceFingerprints &&
      input.knownDeviceFingerprints.length > 0
    ) {
      const match = input.knownDeviceFingerprints.includes(
        input.manifest.deviceFingerprint,
      );
      if (match) {
        evidence.push(
          positiveEvidence(6, "pass6_fingerprint_known", 0.6, {
            deviceFingerprint: input.manifest.deviceFingerprint,
          }),
        );
      } else {
        evidence.push(
          negativeEvidence(
            6,
            "pass6_fingerprint_unknown",
            "deviceFingerprint not seen in prior enrollments",
            { deviceFingerprint: input.manifest.deviceFingerprint },
          ),
        );
        warnings.push(
          `pass6_unknown_fingerprint: ${input.manifest.deviceFingerprint} not in known set`,
        );
      }
    } else {
      evidence.push(
        skipEvidence(
          6,
          "pass6_fingerprint_known",
          "no known-fingerprint list provided",
        ),
      );
    }

    // (c) Jerk score sanity (if upstream computed it).
    if (trace?.jerkScore !== undefined) {
      const j = trace.jerkScore;
      if (!Number.isFinite(j)) {
        warnings.push(`pass6_jerk_invalid: jerkScore=${j}`);
        evidence.push(
          negativeEvidence(6, "pass6_jerk_sanity", "jerkScore not finite"),
        );
      } else if (j < 0) {
        warnings.push(`pass6_jerk_negative: jerkScore=${j}`);
        evidence.push(
          negativeEvidence(
            6,
            "pass6_jerk_sanity",
            `negative jerkScore=${j}`,
            { jerkScore: j },
          ),
        );
      } else {
        evidence.push(
          positiveEvidence(6, "pass6_jerk_sanity", 0.5, { jerkScore: j }),
        );
      }
    }

    return { evidence, warnings, capAtCC0 };
  }
}

// ---------------------------------------------------------------------------
// Confidence aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate per-evidence confidence into a single [0,1] scalar.
 *
 * Strategy:
 *   - Ignore SKIPs (they carry no signal).
 *   - Compute mean confidence over positive evidence only.
 *   - If no positive evidence: return 0.
 */
function aggregateConfidence(evidence: readonly DetectionEvidence[]): number {
  const positives = evidence.filter((e) => e.positive);
  if (positives.length === 0) return 0;
  const sum = positives.reduce((acc, e) => acc + e.confidence, 0);
  return Math.min(1, Math.max(0, sum / positives.length));
}
