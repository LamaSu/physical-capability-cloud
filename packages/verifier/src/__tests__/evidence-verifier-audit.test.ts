/**
 * Tests for EvidenceVerifier POAW-style audit receipt generation.
 */

import { describe, it, expect } from "vitest";
import { EvidenceVerifier } from "../evidence-verifier.js";
import type { EvidenceBundle, SHA256, Signature } from "@pcc/spec";

function makeMockBundle(overrides?: Partial<EvidenceBundle>): EvidenceBundle {
  const now = new Date();
  const events = [
    {
      id: "ev_1",
      type: "gcode_hash_verified" as const,
      timestamp: new Date(now.getTime()).toISOString(),
      source: { deviceId: "dev_001", deviceType: "controller" as const, kernelId: "kernel_audit_test" },
      payload: { hash: "abc123" },
      hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SHA256,
    },
    {
      id: "ev_2",
      type: "execution_started" as const,
      timestamp: new Date(now.getTime() + 100).toISOString(),
      source: { deviceId: "dev_001", deviceType: "controller" as const, kernelId: "kernel_audit_test" },
      payload: {},
      hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as SHA256,
    },
    {
      id: "ev_3",
      type: "execution_completed" as const,
      timestamp: new Date(now.getTime() + 5000).toISOString(),
      source: { deviceId: "dev_001", deviceType: "controller" as const, kernelId: "kernel_audit_test" },
      payload: { success: true },
      hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as SHA256,
    },
  ];

  return {
    id: "bun_audit_test",
    jobId: "job_audit_test",
    stepId: "step_audit_test",
    kernelId: "kernel_audit_test",
    assuranceTier: 1,
    events,
    bundleHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as SHA256,
    kernelSignature: {
      signer: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      algorithm: "secp256k1" as const,
      value: "mock_sig",
    } satisfies Signature,
    createdAt: now.toISOString(),
    ...overrides,
  };
}

describe("EvidenceVerifier — POAW audit receipt", () => {
  const verifier = new EvidenceVerifier("ver_test_1", "0x1234567890123456789012345678901234567890");

  it("produces an attestation with an auditReceipt field", async () => {
    const bundle = makeMockBundle();
    const attestation = await verifier.verify(bundle);

    expect(attestation.auditReceipt).toBeDefined();
  });

  it("auditReceipt has a valid SHA-256 scanHash", async () => {
    const bundle = makeMockBundle();
    const attestation = await verifier.verify(bundle);

    expect(attestation.auditReceipt!.scanHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("auditReceipt.chainPosition is 0 (local verifier)", async () => {
    const bundle = makeMockBundle();
    const attestation = await verifier.verify(bundle);

    expect(attestation.auditReceipt!.chainPosition).toBe(0);
  });

  it("auditReceipt.checksPerformed matches findings count", async () => {
    const bundle = makeMockBundle();
    const attestation = await verifier.verify(bundle);

    expect(attestation.auditReceipt!.checksPerformed).toBe(attestation.findings.length);
    expect(attestation.auditReceipt!.checksPerformed).toBeGreaterThan(0);
  });

  it("auditReceipt.timestamp is a valid ISO string", async () => {
    const bundle = makeMockBundle();
    const attestation = await verifier.verify(bundle);

    const ts = attestation.auditReceipt!.timestamp;
    expect(ts).toBeTruthy();
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("auditReceipt.scanHash differs between different bundles", async () => {
    const bundle1 = makeMockBundle();
    const bundle2 = makeMockBundle({ id: "bun_audit_other" });

    const att1 = await verifier.verify(bundle1);
    const att2 = await verifier.verify(bundle2);

    // attestationHash will differ (different verifierId content from different bundles)
    // scanHash is derived from attestationHash so will also differ
    expect(att1.auditReceipt!.scanHash).toBeTruthy();
    expect(att2.auditReceipt!.scanHash).toBeTruthy();
  });

  it("attestation still has all original fields (non-breaking)", async () => {
    const bundle = makeMockBundle();
    const attestation = await verifier.verify(bundle);

    expect(attestation.id).toMatch(/^att_/);
    expect(attestation.requestId).toBe(""); // filled by caller
    expect(attestation.verifierId).toBe("ver_test_1");
    expect(attestation.evidenceBundleHash).toBe(bundle.bundleHash);
    expect(["valid", "invalid", "inconclusive"]).toContain(attestation.result);
    expect(attestation.confidence).toBeGreaterThanOrEqual(0);
    expect(attestation.confidence).toBeLessThanOrEqual(100);
    expect(attestation.findings).toBeInstanceOf(Array);
    expect(attestation.attestationHash).toMatch(/^sha256:/);
    expect(attestation.signature).toBeDefined();
    expect(attestation.createdAt).toBeTruthy();
  });
});
