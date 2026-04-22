/**
 * Tests for the Capture Verification Protocol (CVP) types + schema.
 *
 * Covers:
 *   - Enum integrity: all 6 CaptureClass values present, stable string form.
 *   - Multiplier table: values match design doc §2.
 *   - Zod rejects invalid CaptureManifest payloads.
 *   - Zod accepts a minimal valid payload for each of the 6 classes.
 */

import { describe, it, expect } from "vitest";
import {
  CaptureClass,
  CAPTURE_CLASS_MULTIPLIERS,
  CaptureManifestSchema,
  type CaptureManifest,
} from "./capture.js";

const GOOD_HASH = `sha256:${"a".repeat(64)}` as const;
const NOW = "2026-04-21T00:00:00.000Z";
const LATER = "2026-04-21T00:00:05.000Z";

describe("CaptureClass enum", () => {
  it("contains exactly the 6 CVP classes CC0..CC5", () => {
    const values = Object.values(CaptureClass);
    expect(values).toEqual(["CC0", "CC1", "CC2", "CC3", "CC4", "CC5"]);
  });

  it("has stable string form (value === name)", () => {
    expect(CaptureClass.CC0).toBe("CC0");
    expect(CaptureClass.CC1).toBe("CC1");
    expect(CaptureClass.CC2).toBe("CC2");
    expect(CaptureClass.CC3).toBe("CC3");
    expect(CaptureClass.CC4).toBe("CC4");
    expect(CaptureClass.CC5).toBe("CC5");
  });
});

describe("CAPTURE_CLASS_MULTIPLIERS", () => {
  it("has an entry for every class", () => {
    const keys = Object.keys(CAPTURE_CLASS_MULTIPLIERS).sort();
    expect(keys).toEqual(["CC0", "CC1", "CC2", "CC3", "CC4", "CC5"]);
  });

  it("matches the design doc values exactly", () => {
    expect(CAPTURE_CLASS_MULTIPLIERS[CaptureClass.CC0]).toBe(0.70);
    expect(CAPTURE_CLASS_MULTIPLIERS[CaptureClass.CC1]).toBe(0.92);
    expect(CAPTURE_CLASS_MULTIPLIERS[CaptureClass.CC2]).toBe(0.96);
    expect(CAPTURE_CLASS_MULTIPLIERS[CaptureClass.CC3]).toBe(1.00);
    expect(CAPTURE_CLASS_MULTIPLIERS[CaptureClass.CC4]).toBe(1.00);
    expect(CAPTURE_CLASS_MULTIPLIERS[CaptureClass.CC5]).toBe(1.00);
  });

  it("is monotonically non-decreasing from CC0 to CC5", () => {
    const order = [
      CaptureClass.CC0,
      CaptureClass.CC1,
      CaptureClass.CC2,
      CaptureClass.CC3,
      CaptureClass.CC4,
      CaptureClass.CC5,
    ];
    for (let i = 1; i < order.length; i++) {
      const prevKey = order[i - 1];
      const currKey = order[i];
      if (prevKey === undefined || currKey === undefined) {
        throw new Error("unreachable");
      }
      const prev = CAPTURE_CLASS_MULTIPLIERS[prevKey];
      const curr = CAPTURE_CLASS_MULTIPLIERS[currKey];
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });
});

describe("CaptureManifestSchema — rejects invalid payloads", () => {
  it("rejects when `class` is missing", () => {
    const bad = {
      declaredAt: NOW,
      deviceFingerprint: "fp-1",
      mediaHash: GOOD_HASH,
    };
    expect(CaptureManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when `class` is not a valid CaptureClass value", () => {
    const bad = {
      class: "CC6",
      declaredAt: NOW,
      deviceFingerprint: "fp-1",
      mediaHash: GOOD_HASH,
    };
    expect(CaptureManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when `mediaHash` is not sha256:<64 hex>", () => {
    const bad = {
      class: CaptureClass.CC0,
      declaredAt: NOW,
      deviceFingerprint: "fp-1",
      mediaHash: "not-a-hash",
    };
    expect(CaptureManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when `declaredAt` is not an ISO 8601 datetime", () => {
    const bad = {
      class: CaptureClass.CC0,
      declaredAt: "yesterday",
      deviceFingerprint: "fp-1",
      mediaHash: GOOD_HASH,
    };
    expect(CaptureManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when `deviceFingerprint` is empty", () => {
    const bad = {
      class: CaptureClass.CC0,
      declaredAt: NOW,
      deviceFingerprint: "",
      mediaHash: GOOD_HASH,
    };
    expect(CaptureManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when sub-manifest discriminants are malformed", () => {
    const bad = {
      class: CaptureClass.CC2,
      declaredAt: NOW,
      deviceFingerprint: "fp-1",
      mediaHash: GOOD_HASH,
      platformAttestation: {
        source: "unknown-source", // not in the enum
        token: "t",
        nonce: "n",
      },
    };
    expect(CaptureManifestSchema.safeParse(bad).success).toBe(false);
  });
});

describe("CaptureManifestSchema — accepts valid payloads for all 6 classes", () => {
  it("accepts a minimal CC0 manifest (no optional fields)", () => {
    const good: CaptureManifest = {
      class: CaptureClass.CC0,
      declaredAt: NOW,
      deviceFingerprint: "fp-cc0",
      mediaHash: GOOD_HASH,
    };
    const parsed = CaptureManifestSchema.safeParse(good);
    expect(parsed.success).toBe(true);
  });

  it("accepts a CC1 manifest with sensorFusion + webAuthn", () => {
    const good: CaptureManifest = {
      class: CaptureClass.CC1,
      declaredAt: NOW,
      deviceFingerprint: "fp-cc1",
      mediaHash: GOOD_HASH,
      sensorFusion: {
        deviceId: "device-1",
        startedAt: NOW,
        endedAt: LATER,
        samples: [
          {
            ts: 0,
            accel: [0.01, 0.02, 9.81],
            gyro: [0.0, 0.0, 0.0],
          },
          {
            ts: 100,
            accel: [0.02, 0.01, 9.80],
            gyro: [0.01, -0.01, 0.0],
          },
        ],
        parallaxScore: 0.82,
        jerkScore: 0.31,
      },
      webAuthnAssertion: {
        credentialId: "cred-1",
        signature: "sig",
        authenticatorData: "authdata",
        clientDataJSON: "client",
        challenge: "chal",
        signCount: 4,
      },
    };
    const parsed = CaptureManifestSchema.safeParse(good);
    expect(parsed.success).toBe(true);
  });

  it("accepts a CC2 manifest with platformAttestation", () => {
    const good: CaptureManifest = {
      class: CaptureClass.CC2,
      declaredAt: NOW,
      deviceFingerprint: "fp-cc2",
      mediaHash: GOOD_HASH,
      platformAttestation: {
        source: "appattest",
        token: "eyJhbGciOi...",
        nonce: GOOD_HASH,
        keyId: "key-abc",
        bundleId: "network.capability.ios",
      },
    };
    const parsed = CaptureManifestSchema.safeParse(good);
    expect(parsed.success).toBe(true);
  });

  it("accepts a CC3 manifest with c2paManifest", () => {
    const good: CaptureManifest = {
      class: CaptureClass.CC3,
      declaredAt: NOW,
      deviceFingerprint: "fp-cc3",
      mediaHash: GOOD_HASH,
      c2paManifest: {
        version: "1.3",
        claimGenerator: "com.truepic",
        assertions: [{ label: "c2pa.actions", data: {} }],
        hash: GOOD_HASH,
        signatureAlgorithm: "ES256",
        signatureValid: true,
      },
    };
    const parsed = CaptureManifestSchema.safeParse(good);
    expect(parsed.success).toBe(true);
  });

  it("accepts a CC4 manifest with camera attestation", () => {
    const good: CaptureManifest = {
      class: CaptureClass.CC4,
      declaredAt: NOW,
      deviceFingerprint: "fp-cc4",
      mediaHash: GOOD_HASH,
      camera: {
        make: "Leica",
        model: "M11-P",
        firmwareVersion: "1.2.0",
        publicKey: "0xfeed",
        signature: "0xdead",
        c2paManifest: {
          version: "1.3",
          claimGenerator: "Leica M11-P",
          assertions: [],
          hash: GOOD_HASH,
          signatureAlgorithm: "Ed25519",
          signatureValid: true,
        },
      },
    };
    const parsed = CaptureManifestSchema.safeParse(good);
    expect(parsed.success).toBe(true);
  });

  it("accepts a CC5 manifest with DePIN attestation", () => {
    const good: CaptureManifest = {
      class: CaptureClass.CC5,
      declaredAt: NOW,
      deviceFingerprint: "fp-cc5",
      mediaHash: GOOD_HASH,
      depin: {
        source: "hivemapper",
        deviceId: "dashcam-1",
        txHash: "0xabc",
        chainId: 1,
        payload: { attesterCount: 5, cid: "bafy..." },
      },
    };
    const parsed = CaptureManifestSchema.safeParse(good);
    expect(parsed.success).toBe(true);
  });
});
