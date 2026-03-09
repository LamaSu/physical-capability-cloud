import { describe, it, expect } from "vitest";
import { EncryptionService } from "../encryption-service.js";
import type { EvidenceBundle, Address, SHA256, Signature } from "@pcc/spec";

function makeMockBundle(): EvidenceBundle {
  return {
    id: "bun_test_001",
    jobId: "job_test_001",
    stepId: "step_test_001",
    kernelId: "kernel_test_001",
    assuranceTier: 2,
    events: [
      {
        id: "ev_test_001",
        type: "execution_completed",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev_001", deviceType: "controller", kernelId: "kernel_test_001" },
        payload: { success: true, duration: 3600 },
        hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111" as SHA256,
      },
      {
        id: "ev_test_002",
        type: "power_profile_summary",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev_002", deviceType: "power_monitor", kernelId: "kernel_test_001" },
        payload: { avgWatts: 120, peakWatts: 250, durationSeconds: 3600 },
        hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222" as SHA256,
      },
    ],
    bundleHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as SHA256,
    kernelSignature: {
      signer: "0x0000000000000000000000000000000000000000" as Address,
      algorithm: "secp256k1",
      value: "mock_sig",
    } as Signature,
    createdAt: new Date().toISOString(),
  };
}

describe("EncryptionService", () => {
  const service = new EncryptionService();
  const recipient1 = "0x1234567890abcdef1234567890abcdef12345678" as Address;
  const recipient2 = "0xabcdef1234567890abcdef1234567890abcdef12" as Address;

  it("encrypts a bundle and produces ciphertext", async () => {
    const bundle = makeMockBundle();
    const encrypted = await service.encryptBundle(bundle, [recipient1]);

    expect(encrypted.id).toMatch(/^bun_/);
    expect(encrypted.bundleId).toBe(bundle.id);
    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.authTag).toBeTruthy();
    expect(encrypted.capsules).toHaveLength(1);
    expect(encrypted.capsules[0].recipientAddress).toBe(recipient1);
  });

  it("round-trips encrypt and decrypt", async () => {
    const bundle = makeMockBundle();
    const encrypted = await service.encryptBundle(bundle, [recipient1]);
    const capsule = encrypted.capsules[0];

    const decrypted = await service.decryptBundle(encrypted, capsule, "mock_private_key");

    expect(decrypted.id).toBe(bundle.id);
    expect(decrypted.jobId).toBe(bundle.jobId);
    expect(decrypted.events).toHaveLength(2);
    expect(decrypted.events[0].type).toBe("execution_completed");
    expect(decrypted.bundleHash).toBe(bundle.bundleHash);
  });

  it("encrypts for multiple recipients", async () => {
    const bundle = makeMockBundle();
    const encrypted = await service.encryptBundle(bundle, [recipient1, recipient2]);

    expect(encrypted.capsules).toHaveLength(2);
    expect(encrypted.capsules[0].recipientAddress).toBe(recipient1);
    expect(encrypted.capsules[1].recipientAddress).toBe(recipient2);

    // Both recipients can decrypt
    const d1 = await service.decryptBundle(encrypted, encrypted.capsules[0], "key1");
    const d2 = await service.decryptBundle(encrypted, encrypted.capsules[1], "key2");
    expect(d1.id).toBe(bundle.id);
    expect(d2.id).toBe(bundle.id);
  });

  it("produces different ciphertext for different bundles", async () => {
    const bundle1 = makeMockBundle();
    const bundle2 = makeMockBundle();
    bundle2.id = "bun_test_002";
    bundle2.jobId = "job_test_002";

    const enc1 = await service.encryptBundle(bundle1, [recipient1]);
    const enc2 = await service.encryptBundle(bundle2, [recipient1]);

    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(enc1.iv).not.toBe(enc2.iv);
  });

  it("fails to decrypt with tampered ciphertext", async () => {
    const bundle = makeMockBundle();
    const encrypted = await service.encryptBundle(bundle, [recipient1]);

    // Tamper with ciphertext
    const tampered = { ...encrypted, ciphertext: "dGFtcGVyZWQ=" };
    await expect(
      service.decryptBundle(tampered, encrypted.capsules[0], "key"),
    ).rejects.toThrow();
  });

  it("grants access and produces AccessGrant", async () => {
    const aesKey = new Uint8Array(32);
    aesKey.fill(42);
    const grant = await service.grantAccess("bun_test_001", aesKey, recipient2, "selective");

    expect(grant.id).toMatch(/^grt_/);
    expect(grant.bundleId).toBe("bun_test_001");
    expect(grant.grantedTo).toBe(recipient2);
    expect(grant.revoked).toBe(false);
  });

  it("capsules have correct access levels", async () => {
    const bundle = makeMockBundle();
    const encrypted = await service.encryptBundle(bundle, [recipient1]);
    expect(encrypted.capsules[0].accessLevel).toBe("full");
  });
});
