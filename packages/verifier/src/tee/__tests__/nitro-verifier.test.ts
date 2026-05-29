/**
 * Nitro Enclaves attestation verifier tests.
 *
 * Fixture-based — the real COSE/CBOR parser ships behind the
 * `nitroCoseVerify` hook (a wrapper around `enclaver/aws-nitro-enclaves-
 * attestation`); the test mocks it.
 */

import { describe, it, expect } from "vitest";
import { verifyNitroAttestation } from "../nitro-verifier.js";
import type { TeeProfile } from "@pcc/spec";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bin, "binary").toString("base64");
}

const PCR0 = "a".repeat(96);
const PCR1 = "b".repeat(96);

const baseProfile: TeeProfile = {
  vendor: "aws-nitro",
  expectedMeasurement: PCR0,
  expectedPcrs: { "0": PCR0, "1": PCR1 },
  quoteFormat: "nitro-v1",
};

const REPORT_DATA = "f".repeat(128);
const fixtureBytes = new Uint8Array(500); // big enough to pass length check

describe("verifyNitroAttestation — happy path", () => {
  it("PCR match + cert chain valid + user_data match → valid", async () => {
    const res = await verifyNitroAttestation(
      bytesToBase64(fixtureBytes),
      baseProfile,
      REPORT_DATA,
      {
        nitroCoseVerify: async () => ({
          valid: true,
          pcrs: { "0": PCR0, "1": PCR1 },
          userData: REPORT_DATA,
        }),
      },
    );
    expect(res.valid).toBe(true);
    expect(res.certChainValid).toBe(true);
    expect(res.measurementMatch).toBe(true);
    expect(res.measurements.vendor).toBe("aws-nitro");
    expect(res.measurements.observedMeasurement).toBe(PCR0);
  });
});

describe("verifyNitroAttestation — failures", () => {
  it("PCR0 mismatch → invalid", async () => {
    const res = await verifyNitroAttestation(
      bytesToBase64(fixtureBytes),
      baseProfile,
      REPORT_DATA,
      {
        nitroCoseVerify: async () => ({
          valid: true,
          pcrs: { "0": "z".repeat(96), "1": PCR1 },
          userData: REPORT_DATA,
        }),
      },
    );
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/PCR mismatch/);
  });

  it("cose verify returns invalid → invalid", async () => {
    const res = await verifyNitroAttestation(
      bytesToBase64(fixtureBytes),
      baseProfile,
      REPORT_DATA,
      {
        nitroCoseVerify: async () => ({
          valid: false,
          reason: "AWS root cert expired",
        }),
      },
    );
    expect(res.valid).toBe(false);
    expect(res.certChainValid).toBe(false);
  });

  it("user_data mismatch → invalid (replay mitigation)", async () => {
    const res = await verifyNitroAttestation(
      bytesToBase64(fixtureBytes),
      baseProfile,
      REPORT_DATA,
      {
        nitroCoseVerify: async () => ({
          valid: true,
          pcrs: { "0": PCR0, "1": PCR1 },
          userData: "0".repeat(128),
        }),
      },
    );
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/user_data mismatch/);
  });

  it("doc too short → invalid", async () => {
    const tiny = bytesToBase64(new Uint8Array(50));
    const res = await verifyNitroAttestation(tiny, baseProfile, REPORT_DATA);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/too short/);
  });

  it("no nitroCoseVerify wired → invalid", async () => {
    const res = await verifyNitroAttestation(
      bytesToBase64(fixtureBytes),
      baseProfile,
      REPORT_DATA,
    );
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/no nitroCoseVerify backend wired/);
  });
});
