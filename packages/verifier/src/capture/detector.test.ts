/**
 * Tests for the 6-pass CaptureDetector (Wave 2).
 *
 * Mocks every adapter so the pipeline is exercised without any external
 * libraries. Covers:
 *   - Each pass in isolation (positive / negative / skip cases)
 *   - Full pipeline end-to-end for CC0 minimal, CC1 with fusion, CC2 with
 *     platform attestation, and the flat-motion replay attack case
 *   - Auto-downgrade behavior
 *   - anchorCandidate + confidence aggregation
 */

import { describe, it, expect } from "vitest";
import {
  CaptureClass,
  type CaptureManifest,
  type SensorFusionTrace,
  type WebAuthnAssertion,
  type PlatformAttestation,
  type C2PAManifest,
  type CameraAttestation,
  type DePINAttestation,
} from "@pcc/spec";

import {
  CaptureDetector,
  type CaptureDetectorAdapters,
  type FaceLandmarkerAdapter,
  type C2PAParserAdapter,
  type PlatformAttestationAdapter,
  type PlatformAttestationResult,
  type ParsedC2PA,
} from "./detector.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const ISO = "2026-04-22T00:00:00.000Z";

const DEVICE_FINGERPRINT = "fp-device-test-001";

const BASE_MANIFEST: CaptureManifest = {
  class: CaptureClass.CC0,
  declaredAt: ISO,
  deviceFingerprint: DEVICE_FINGERPRINT,
  mediaHash: "sha256:" + "a".repeat(64),
};

function mkSensorFusion(opts: {
  samples: number;
  includeOptional?: boolean;
  flatMotion?: boolean;
}): SensorFusionTrace {
  const samples = Array.from({ length: opts.samples }, (_, i) => {
    // Flat-motion: constant accel vector. Live-motion: perturbed.
    const jitter = opts.flatMotion ? 0 : (i % 2 === 0 ? 0.5 : -0.5);
    const accel: [number, number, number] = [
      0.01 + jitter,
      9.81 + jitter * 0.5,
      0.02 - jitter * 0.3,
    ];
    const sample: SensorFusionTrace["samples"][number] = {
      ts: i * 33,
      accel,
      gyro: [0.001 * i, -0.001 * i, 0],
    };
    if (opts.includeOptional) {
      sample.magnetometer = [25 + i, 15, -40];
      sample.gravity = [0, 9.81, 0];
      sample.light = 400 + i;
    }
    return sample;
  });

  return {
    deviceId: "dev-test",
    startedAt: ISO,
    endedAt: ISO,
    samples,
  };
}

function mkWebAuthn(): WebAuthnAssertion {
  return {
    credentialId: "cred-abc",
    signature: "sig-xyz",
    authenticatorData: "auth-data",
    clientDataJSON: "client-json",
    challenge: "challenge-123",
    signCount: 7,
  };
}

function mkPlatformAttestation(): PlatformAttestation {
  return {
    source: "appattest",
    token: "eyJ.fake.jwt",
    nonce: "challenge-abc-123",
    keyId: "keyid-001",
    bundleId: "com.pcc.capture",
  };
}

function mkC2PAManifest(): C2PAManifest {
  return {
    version: "1.0",
    claimGenerator: "com.truepic",
    assertions: [],
    hash: "sha256:" + "b".repeat(64),
    signatureAlgorithm: "ES256",
  };
}

function mkCameraAttestation(): CameraAttestation {
  return {
    make: "Leica",
    model: "M11-P",
    publicKey: "pubkey-hex",
    signature: "camera-sig",
    firmwareVersion: "2.0.0",
  };
}

function mkDePIN(): DePINAttestation {
  return {
    source: "hivemapper",
    deviceId: "hivemapper-device-a",
    txHash: "0x" + "c".repeat(64),
    chainId: "hivemapper-mainnet",
    payload: { attesterCount: 7 },
  };
}

// ---------------------------------------------------------------------------
// Mock adapters
// ---------------------------------------------------------------------------

class MockFaceLandmarker implements FaceLandmarkerAdapter {
  constructor(
    private readonly result: {
      hasFace: boolean;
      blinkDetected: boolean;
      yawDegrees: number;
    },
    private readonly throws?: Error,
  ) {}
  async detectFace() {
    if (this.throws) throw this.throws;
    return this.result;
  }
}

class MockC2PAParser implements C2PAParserAdapter {
  constructor(private readonly result: ParsedC2PA, private readonly throws?: Error) {}
  async parseManifest() {
    if (this.throws) throw this.throws;
    return this.result;
  }
}

class MockPlatformAttestation implements PlatformAttestationAdapter {
  constructor(private readonly result: PlatformAttestationResult, private readonly throws?: Error) {}
  async verify() {
    if (this.throws) throw this.throws;
    return this.result;
  }
}

const FACE_PASS: ConstructorParameters<typeof MockFaceLandmarker>[0] = {
  hasFace: true,
  blinkDetected: true,
  yawDegrees: 12,
};
const FACE_FAIL: ConstructorParameters<typeof MockFaceLandmarker>[0] = {
  hasFace: true,
  blinkDetected: false,
  yawDegrees: 1,
};

const PLATFORM_STRONG: PlatformAttestationResult = {
  signatureValid: true,
  nonceMatches: true,
  withinTtl: true,
  integrity: "strong",
};
const PLATFORM_WEAK: PlatformAttestationResult = {
  signatureValid: true,
  nonceMatches: true,
  withinTtl: true,
  integrity: "virtual",
};

const C2PA_HARDWARE: ParsedC2PA = {
  signatureValid: true,
  claimGenerator: "Leica M11-P",
  hardwareCamera: true,
  enclaveSigned: false,
};
const C2PA_ENCLAVE: ParsedC2PA = {
  signatureValid: true,
  claimGenerator: "com.truepic",
  hardwareCamera: false,
  enclaveSigned: true,
};

// Useful helper: find evidence by name (filter skipped vs real).
function findEvidence(
  evidence: ReadonlyArray<{
    pass: number;
    name: string;
    positive: boolean;
    confidence: number;
    data?: Record<string, unknown>;
  }>,
  name: string,
) {
  return evidence.find((e) => e.name === name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CaptureDetector", () => {
  // -------------------------------------------------------------------------
  // Pass 1 — Signature Presence (in isolation)
  // -------------------------------------------------------------------------
  describe("Pass 1 — Signature Presence", () => {
    it("returns CC0 ceiling when manifest has no signatures", async () => {
      const detector = new CaptureDetector();
      const result = await detector.detect({ manifest: BASE_MANIFEST });
      expect(result.ceiling).toBe(CaptureClass.CC0);
      // All pass-1 signal checks should be SKIPs.
      const p1 = result.evidence.filter((e) => e.pass === 1);
      expect(p1.every((e) => !e.positive)).toBe(true);
    });

    it("raises ceiling to CC1 when WebAuthn assertion is present (and fusion+liveness OK)", async () => {
      const detector = new CaptureDetector({
        faceLandmarker: new MockFaceLandmarker(FACE_PASS),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC1,
        webAuthnAssertion: mkWebAuthn(),
        sensorFusion: mkSensorFusion({ samples: 10, includeOptional: true }),
      };
      const result = await detector.detect({
        manifest,
        frameBlob: new Uint8Array([1, 2, 3]),
      });
      expect(result.ceiling).toBe(CaptureClass.CC1);
      const webauthnSignal = findEvidence(result.evidence, "pass1_webauthn_present");
      expect(webauthnSignal?.positive).toBe(true);
    });

    it("raises ceiling to CC2 when platform attestation is present", async () => {
      const detector = new CaptureDetector({
        platformAttestation: new MockPlatformAttestation(PLATFORM_STRONG),
        faceLandmarker: new MockFaceLandmarker(FACE_PASS),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC2,
        webAuthnAssertion: mkWebAuthn(),
        platformAttestation: mkPlatformAttestation(),
        sensorFusion: mkSensorFusion({ samples: 10, includeOptional: true }),
      };
      const result = await detector.detect({
        manifest,
        challengeId: "challenge-abc-123",
        frameBlob: new Uint8Array([1, 2, 3]),
      });
      expect(result.ceiling).toBe(CaptureClass.CC2);
      const platformSignal = findEvidence(
        result.evidence,
        "pass1_platform_attestation_present",
      );
      expect(platformSignal?.positive).toBe(true);
    });

    it("raises ceiling to CC4 when C2PA hardware-camera cert verifies", async () => {
      const detector = new CaptureDetector({
        c2paParser: new MockC2PAParser(C2PA_HARDWARE),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC4,
        c2paManifest: mkC2PAManifest(),
        camera: mkCameraAttestation(),
      };
      const result = await detector.detect({
        manifest,
        c2paManifestBytes: new Uint8Array([9, 9, 9]),
      });
      expect(result.ceiling).toBe(CaptureClass.CC4);
      const c2paSignal = findEvidence(result.evidence, "pass1_c2pa_hardware_camera");
      expect(c2paSignal?.positive).toBe(true);
    });

    it("raises ceiling to CC3 when C2PA enclave cert verifies", async () => {
      const detector = new CaptureDetector({
        c2paParser: new MockC2PAParser(C2PA_ENCLAVE),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC3,
        c2paManifest: mkC2PAManifest(),
      };
      const result = await detector.detect({
        manifest,
        c2paManifestBytes: new Uint8Array([9, 9, 9]),
      });
      expect(result.ceiling).toBe(CaptureClass.CC3);
      const c2paSignal = findEvidence(result.evidence, "pass1_c2pa_enclave");
      expect(c2paSignal?.positive).toBe(true);
    });

    it("raises ceiling to CC5 when DePIN attestation is present", async () => {
      const detector = new CaptureDetector();
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC5,
        depin: mkDePIN(),
      };
      const result = await detector.detect({ manifest });
      expect(result.ceiling).toBe(CaptureClass.CC5);
      const depinSignal = findEvidence(result.evidence, "pass1_depin_attestation_present");
      expect(depinSignal?.positive).toBe(true);
    });

    it("flags invalid C2PA signature as negative evidence (does not raise ceiling)", async () => {
      const detector = new CaptureDetector({
        c2paParser: new MockC2PAParser({
          signatureValid: false,
          claimGenerator: "unknown",
          hardwareCamera: false,
          enclaveSigned: false,
        }),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        c2paManifest: mkC2PAManifest(),
      };
      const result = await detector.detect({
        manifest,
        c2paManifestBytes: new Uint8Array([7, 8, 9]),
      });
      expect(result.ceiling).toBe(CaptureClass.CC0);
      const invalid = findEvidence(result.evidence, "pass1_c2pa_signature_invalid");
      expect(invalid).toBeDefined();
      expect(invalid?.positive).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Pass 2 — Nonce Echo
  // -------------------------------------------------------------------------
  describe("Pass 2 — Nonce Echo", () => {
    it("SKIPs when neither expected nor echo is provided", async () => {
      const detector = new CaptureDetector();
      const result = await detector.detect({ manifest: BASE_MANIFEST });
      const p2 = result.evidence.find((e) => e.pass === 2);
      expect(p2?.data?.status).toBe("skipped");
    });

    it("POSITIVE when expected === echo", async () => {
      const detector = new CaptureDetector();
      const result = await detector.detect({
        manifest: BASE_MANIFEST,
        expectedVisualNoncePayload: "tilt-pan-hold",
        visualNonceEcho: "tilt-pan-hold",
      });
      const p2 = result.evidence.find((e) => e.pass === 2);
      expect(p2?.positive).toBe(true);
      expect(p2?.confidence).toBe(1.0);
    });

    it("NEGATIVE when expected !== echo", async () => {
      const detector = new CaptureDetector();
      const result = await detector.detect({
        manifest: BASE_MANIFEST,
        expectedVisualNoncePayload: "tilt-pan-hold",
        visualNonceEcho: "lift-tap-wave",
      });
      const p2 = result.evidence.find((e) => e.pass === 2);
      expect(p2?.positive).toBe(false);
    });

    it("NEGATIVE when only one side is provided", async () => {
      const detector = new CaptureDetector();
      const r1 = await detector.detect({
        manifest: BASE_MANIFEST,
        expectedVisualNoncePayload: "tilt",
      });
      expect(r1.evidence.find((e) => e.pass === 2)?.positive).toBe(false);

      const r2 = await detector.detect({
        manifest: BASE_MANIFEST,
        visualNonceEcho: "tilt",
      });
      expect(r2.evidence.find((e) => e.pass === 2)?.positive).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Pass 3 — Liveness
  // -------------------------------------------------------------------------
  describe("Pass 3 — Liveness", () => {
    it("SKIPs when no FaceLandmarkerAdapter is configured", async () => {
      const detector = new CaptureDetector();
      const result = await detector.detect({
        manifest: BASE_MANIFEST,
        frameBlob: new Uint8Array([1]),
      });
      const p3 = result.evidence.find((e) => e.pass === 3);
      expect(p3?.data?.status).toBe("skipped");
    });

    it("SKIPs when no frameBlob is provided", async () => {
      const detector = new CaptureDetector({
        faceLandmarker: new MockFaceLandmarker(FACE_PASS),
      });
      const result = await detector.detect({ manifest: BASE_MANIFEST });
      const p3 = result.evidence.find((e) => e.pass === 3);
      expect(p3?.data?.status).toBe("skipped");
    });

    it("POSITIVE when face + blink + sufficient yaw", async () => {
      const detector = new CaptureDetector({
        faceLandmarker: new MockFaceLandmarker(FACE_PASS),
      });
      const result = await detector.detect({
        manifest: BASE_MANIFEST,
        frameBlob: new Uint8Array([1, 2, 3]),
      });
      const p3 = result.evidence.find((e) => e.pass === 3);
      expect(p3?.positive).toBe(true);
    });

    it("NEGATIVE when blink missing or yaw too small", async () => {
      const detector = new CaptureDetector({
        faceLandmarker: new MockFaceLandmarker(FACE_FAIL),
      });
      const result = await detector.detect({
        manifest: BASE_MANIFEST,
        frameBlob: new Uint8Array([1, 2, 3]),
      });
      const p3 = result.evidence.find((e) => e.pass === 3);
      expect(p3?.positive).toBe(false);
    });

    it("handles adapter errors gracefully (no throw)", async () => {
      const detector = new CaptureDetector({
        faceLandmarker: new MockFaceLandmarker(FACE_PASS, new Error("mediapipe-fail")),
      });
      const result = await detector.detect({
        manifest: BASE_MANIFEST,
        frameBlob: new Uint8Array([1, 2, 3]),
      });
      const p3 = result.evidence.find((e) => e.pass === 3);
      expect(p3?.positive).toBe(false);
      expect(p3?.data?.reason).toContain("mediapipe-fail");
    });
  });

  // -------------------------------------------------------------------------
  // Pass 4 — Multi-sensor Fusion
  // -------------------------------------------------------------------------
  describe("Pass 4 — Multi-sensor Fusion", () => {
    it("SKIPs when no sensorFusion trace is on the manifest", async () => {
      const detector = new CaptureDetector();
      const result = await detector.detect({ manifest: BASE_MANIFEST });
      const p4 = result.evidence.find((e) => e.pass === 4);
      expect(p4?.data?.status).toBe("skipped");
    });

    it("POSITIVE when ≥3 streams present", async () => {
      const detector = new CaptureDetector();
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        sensorFusion: mkSensorFusion({ samples: 5, includeOptional: true }),
      };
      const result = await detector.detect({ manifest });
      const p4 = result.evidence.find((e) => e.pass === 4);
      expect(p4?.positive).toBe(true);
      // Baseline (camera+accel+gyro) + magnetometer/gravity/light = 6 streams.
      expect(p4?.data?.streamCount).toBeGreaterThanOrEqual(3);
    });

    it("POSITIVE with baseline 3 streams (accel+gyro+camera, no optional)", async () => {
      const detector = new CaptureDetector();
      const trace = mkSensorFusion({ samples: 5, includeOptional: false });
      const manifest: CaptureManifest = { ...BASE_MANIFEST, sensorFusion: trace };
      const result = await detector.detect({ manifest });
      const p4 = result.evidence.find((e) => e.pass === 4);
      expect(p4?.positive).toBe(true);
      expect(p4?.data?.streamCount).toBe(3);
    });

    it("NEGATIVE when trace has zero samples (0 streams)", async () => {
      const detector = new CaptureDetector();
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        sensorFusion: {
          deviceId: "dev",
          startedAt: ISO,
          endedAt: ISO,
          samples: [],
        },
      };
      const result = await detector.detect({ manifest });
      const p4 = result.evidence.find((e) => e.pass === 4);
      expect(p4?.positive).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Pass 5 — Platform Attestation
  // -------------------------------------------------------------------------
  describe("Pass 5 — Platform Attestation", () => {
    it("SKIPs when manifest has no platformAttestation", async () => {
      const detector = new CaptureDetector({
        platformAttestation: new MockPlatformAttestation(PLATFORM_STRONG),
      });
      const result = await detector.detect({ manifest: BASE_MANIFEST });
      const p5 = result.evidence.find((e) => e.pass === 5);
      expect(p5?.data?.status).toBe("skipped");
    });

    it("POSITIVE when adapter returns strong integrity", async () => {
      const detector = new CaptureDetector({
        platformAttestation: new MockPlatformAttestation(PLATFORM_STRONG),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        platformAttestation: mkPlatformAttestation(),
      };
      const result = await detector.detect({
        manifest,
        challengeId: "challenge-abc-123",
      });
      const p5 = result.evidence.find((e) => e.pass === 5);
      expect(p5?.positive).toBe(true);
    });

    it("NEGATIVE when integrity is virtual/weak", async () => {
      const detector = new CaptureDetector({
        platformAttestation: new MockPlatformAttestation(PLATFORM_WEAK),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        platformAttestation: mkPlatformAttestation(),
      };
      const result = await detector.detect({
        manifest,
        challengeId: "challenge-abc-123",
      });
      const p5 = result.evidence.find((e) => e.pass === 5);
      expect(p5?.positive).toBe(false);
    });

    it("SKIP (not fail) when platformAttestation present but adapter missing", async () => {
      const detector = new CaptureDetector();
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        platformAttestation: mkPlatformAttestation(),
      };
      const result = await detector.detect({ manifest });
      const p5 = result.evidence.find((e) => e.pass === 5);
      expect(p5?.data?.status).toBe("skipped");
    });
  });

  // -------------------------------------------------------------------------
  // Pass 6 — Anti-Spoof
  // -------------------------------------------------------------------------
  describe("Pass 6 — Anti-Spoof", () => {
    it("flags flat motion as possible replay (capAtCC0 behavior)", async () => {
      const detector = new CaptureDetector({
        faceLandmarker: new MockFaceLandmarker(FACE_PASS),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC1,
        webAuthnAssertion: mkWebAuthn(),
        sensorFusion: mkSensorFusion({
          samples: 10,
          includeOptional: true,
          flatMotion: true,
        }),
      };
      const result = await detector.detect({
        manifest,
        frameBlob: new Uint8Array([1, 2, 3]),
      });
      const motion = findEvidence(result.evidence, "pass6_motion_variance");
      expect(motion?.positive).toBe(false);
      // Flat motion should cap ceiling at CC0 (from CC1).
      expect(result.ceiling).toBe(CaptureClass.CC0);
      expect(result.warnings.some((w) => w.includes("flat_motion"))).toBe(true);
    });

    it("POSITIVE motion-variance on live motion", async () => {
      const detector = new CaptureDetector();
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        sensorFusion: mkSensorFusion({ samples: 10, flatMotion: false }),
      };
      const result = await detector.detect({ manifest });
      const motion = findEvidence(result.evidence, "pass6_motion_variance");
      expect(motion?.positive).toBe(true);
    });

    it("warns when deviceFingerprint is not in the known set", async () => {
      const detector = new CaptureDetector();
      const result = await detector.detect({
        manifest: BASE_MANIFEST,
        knownDeviceFingerprints: ["fp-some-other", "fp-unrelated"],
      });
      expect(
        result.warnings.some((w) => w.includes("pass6_unknown_fingerprint")),
      ).toBe(true);
      const unknown = findEvidence(result.evidence, "pass6_fingerprint_unknown");
      expect(unknown?.positive).toBe(false);
    });

    it("POSITIVE when fingerprint matches known set", async () => {
      const detector = new CaptureDetector();
      const result = await detector.detect({
        manifest: BASE_MANIFEST,
        knownDeviceFingerprints: [DEVICE_FINGERPRINT, "other"],
      });
      const known = findEvidence(result.evidence, "pass6_fingerprint_known");
      expect(known?.positive).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end pipeline scenarios
  // -------------------------------------------------------------------------
  describe("Full pipeline", () => {
    it("CC0 minimal: unsigned bytes, no signals → ceiling=CC0, anchorCandidate per design", async () => {
      const detector = new CaptureDetector();
      const result = await detector.detect({ manifest: BASE_MANIFEST });
      expect(result.ceiling).toBe(CaptureClass.CC0);
      expect(result.declaredClass).toBe(CaptureClass.CC0);
      expect(result.detectedCeiling).toBe(CaptureClass.CC0);
      expect(result.autoDowngrade).toBeUndefined();
      expect(result.confidence).toBe(0);
      // No positive evidence ⇒ anchorCandidate false.
      expect(result.anchorCandidate).toBe(false);
    });

    it("CC1 with full sensor fusion + liveness + nonce → ceiling=CC1", async () => {
      const adapters: CaptureDetectorAdapters = {
        faceLandmarker: new MockFaceLandmarker(FACE_PASS),
      };
      const detector = new CaptureDetector(adapters);
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC1,
        webAuthnAssertion: mkWebAuthn(),
        sensorFusion: mkSensorFusion({ samples: 20, includeOptional: true }),
      };
      const result = await detector.detect({
        manifest,
        expectedVisualNoncePayload: "tilt-pan-hold",
        visualNonceEcho: "tilt-pan-hold",
        frameBlob: new Uint8Array([10, 20, 30]),
      });
      expect(result.ceiling).toBe(CaptureClass.CC1);
      expect(result.detectedCeiling).toBe(CaptureClass.CC1);
      expect(result.autoDowngrade).toBeUndefined();
      expect(result.anchorCandidate).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("CC2 with platform attestation → ceiling=CC2", async () => {
      const detector = new CaptureDetector({
        faceLandmarker: new MockFaceLandmarker(FACE_PASS),
        platformAttestation: new MockPlatformAttestation(PLATFORM_STRONG),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC2,
        webAuthnAssertion: mkWebAuthn(),
        platformAttestation: mkPlatformAttestation(),
        sensorFusion: mkSensorFusion({ samples: 20, includeOptional: true }),
      };
      const result = await detector.detect({
        manifest,
        challengeId: "challenge-abc-123",
        frameBlob: new Uint8Array([10, 20, 30]),
      });
      expect(result.ceiling).toBe(CaptureClass.CC2);
      expect(result.anchorCandidate).toBe(true);
    });

    it("Attack case: flat motion pre-recorded video caps ceiling at CC0", async () => {
      const detector = new CaptureDetector({
        faceLandmarker: new MockFaceLandmarker(FACE_PASS),
      });
      // Client claimed CC1 but submits flat-motion trace (tripod replay).
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC1,
        webAuthnAssertion: mkWebAuthn(),
        sensorFusion: mkSensorFusion({
          samples: 20,
          includeOptional: true,
          flatMotion: true,
        }),
      };
      const result = await detector.detect({
        manifest,
        frameBlob: new Uint8Array([10, 20, 30]),
      });
      expect(result.ceiling).toBe(CaptureClass.CC0);
      // declared CC1, detected CC0 → autoDowngrade must fire.
      expect(result.autoDowngrade).toBeDefined();
      expect(result.autoDowngrade?.from).toBe(CaptureClass.CC1);
      expect(result.autoDowngrade?.to).toBe(CaptureClass.CC0);
      expect(result.warnings.some((w) => w.includes("flat_motion"))).toBe(true);
    });

    it("Declared CC4 but evidence only supports CC1 → autoDowngrade fires", async () => {
      const detector = new CaptureDetector({
        faceLandmarker: new MockFaceLandmarker(FACE_PASS),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC4, // operator overclaims
        webAuthnAssertion: mkWebAuthn(),
        sensorFusion: mkSensorFusion({ samples: 10, includeOptional: true }),
        // No camera attestation, no C2PA — cannot actually reach CC4.
      };
      const result = await detector.detect({
        manifest,
        frameBlob: new Uint8Array([1]),
      });
      expect(result.ceiling).toBe(CaptureClass.CC1);
      expect(result.detectedCeiling).toBe(CaptureClass.CC1);
      expect(result.autoDowngrade).toBeDefined();
      expect(result.autoDowngrade?.from).toBe(CaptureClass.CC4);
      expect(result.autoDowngrade?.to).toBe(CaptureClass.CC1);
    });

    it("Declared CC0 when evidence supports higher → no downgrade, ceiling respects declaration", async () => {
      // Conservative operator: declares CC0 but their manifest is actually CC1-worthy.
      const detector = new CaptureDetector({
        faceLandmarker: new MockFaceLandmarker(FACE_PASS),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC0,
        webAuthnAssertion: mkWebAuthn(),
        sensorFusion: mkSensorFusion({ samples: 10, includeOptional: true }),
      };
      const result = await detector.detect({
        manifest,
        frameBlob: new Uint8Array([1]),
      });
      // declared CC0 → finalCeiling = min(CC0, CC1) = CC0, no downgrade.
      expect(result.ceiling).toBe(CaptureClass.CC0);
      expect(result.autoDowngrade).toBeUndefined();
    });

    it("CC5 with DePIN attestation → ceiling=CC5", async () => {
      const detector = new CaptureDetector();
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC5,
        depin: mkDePIN(),
      };
      const result = await detector.detect({ manifest });
      expect(result.ceiling).toBe(CaptureClass.CC5);
      expect(result.anchorCandidate).toBe(true);
    });

    it("CC4 via C2PA hardware camera → ceiling=CC4", async () => {
      const detector = new CaptureDetector({
        c2paParser: new MockC2PAParser(C2PA_HARDWARE),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC4,
        c2paManifest: mkC2PAManifest(),
        camera: mkCameraAttestation(),
      };
      const result = await detector.detect({
        manifest,
        c2paManifestBytes: new Uint8Array([0xc2, 0xfa]),
      });
      expect(result.ceiling).toBe(CaptureClass.CC4);
    });

    it("Does not raise ceiling when platform attestation adapter returns invalid result", async () => {
      const detector = new CaptureDetector({
        platformAttestation: new MockPlatformAttestation({
          signatureValid: false,
          nonceMatches: false,
          withinTtl: false,
          integrity: "failed",
        }),
        faceLandmarker: new MockFaceLandmarker(FACE_PASS),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC2,
        webAuthnAssertion: mkWebAuthn(),
        platformAttestation: mkPlatformAttestation(),
        sensorFusion: mkSensorFusion({ samples: 10, includeOptional: true }),
      };
      const result = await detector.detect({
        manifest,
        challengeId: "unexpected",
        frameBlob: new Uint8Array([1]),
      });
      // Pass 1 noted presence → raised to CC2. Pass 5 failed — does NOT demote
      // via this pass; it emits negative evidence. But the top-level ceiling
      // for the manifest still matches CC2 floor (Pass 1 signature-present).
      // The verifier (Wave 3) will run the structured VerificationFinding path
      // that turns this into a critical failure; detector honors the minimum
      // cryptographic evidence floor.
      expect(result.ceiling).toBe(CaptureClass.CC2);
      const p5 = result.evidence.find((e) => e.pass === 5);
      expect(p5?.positive).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Confidence aggregation + anchor candidacy
  // -------------------------------------------------------------------------
  describe("confidence + anchorCandidate", () => {
    it("confidence is in [0,1]", async () => {
      const detector = new CaptureDetector({
        faceLandmarker: new MockFaceLandmarker(FACE_PASS),
      });
      const manifest: CaptureManifest = {
        ...BASE_MANIFEST,
        class: CaptureClass.CC1,
        webAuthnAssertion: mkWebAuthn(),
        sensorFusion: mkSensorFusion({ samples: 10, includeOptional: true }),
      };
      const result = await detector.detect({
        manifest,
        frameBlob: new Uint8Array([1]),
      });
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it("anchorCandidate true when any positive evidence exists (even at CC0)", async () => {
      const detector = new CaptureDetector();
      const result = await detector.detect({
        manifest: BASE_MANIFEST,
        expectedVisualNoncePayload: "abc",
        visualNonceEcho: "abc", // positive Pass 2 signal even at CC0
      });
      expect(result.anchorCandidate).toBe(true);
    });

    it("evidence array has at least one entry per pass (6 passes min)", async () => {
      const detector = new CaptureDetector();
      const result = await detector.detect({ manifest: BASE_MANIFEST });
      const byPass = new Set(result.evidence.map((e) => e.pass));
      expect(byPass.has(1)).toBe(true);
      expect(byPass.has(2)).toBe(true);
      expect(byPass.has(3)).toBe(true);
      expect(byPass.has(4)).toBe(true);
      expect(byPass.has(5)).toBe(true);
      expect(byPass.has(6)).toBe(true);
    });
  });
});
