import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EvidenceStorageService } from "../evidence-storage.js";
import type { EvidenceBundle, EncryptedEvidenceBundle, Address, SHA256, Signature } from "@pcc/spec";

function makeMockBundle(): EvidenceBundle {
  return {
    id: "bun_ipfs_001",
    jobId: "job_ipfs_001",
    stepId: "step_ipfs_001",
    kernelId: "kernel_ipfs_001",
    assuranceTier: 2,
    events: [
      {
        id: "ev_ipfs_001",
        type: "execution_completed",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev_001", deviceType: "controller", kernelId: "kernel_ipfs_001" },
        payload: { success: true, duration: 1800 },
        hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SHA256,
      },
      {
        id: "ev_ipfs_002",
        type: "power_profile_summary",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev_002", deviceType: "power_monitor", kernelId: "kernel_ipfs_001" },
        payload: { avgWatts: 95, peakWatts: 200, durationSeconds: 1800 },
        hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as SHA256,
      },
    ],
    bundleHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as SHA256,
    kernelSignature: {
      signer: "0x0000000000000000000000000000000000000000" as Address,
      algorithm: "secp256k1",
      value: "mock_sig_ipfs",
    } as Signature,
    createdAt: new Date().toISOString(),
  };
}

function makeMockEncryptedBundle(): EncryptedEvidenceBundle {
  return {
    id: "enc_ipfs_001",
    bundleId: "bun_ipfs_001",
    bundleHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as SHA256,
    ciphertext: "bW9ja19jaXBoZXJ0ZXh0",
    iv: "bW9ja19pdg==",
    authTag: "bW9ja19hdXRo",
    encryptedAt: new Date().toISOString(),
    capsules: [
      {
        id: "cap_ipfs_001",
        recipientAddress: "0x1234567890abcdef1234567890abcdef12345678" as Address,
        encryptedKey: "bW9ja19rZXk=",
        ephemeralPublicKey: "bW9ja19lcGhlbWVyYWw=",
        accessLevel: "full",
      },
    ],
  };
}

describe("EvidenceStorageService", () => {
  const service = new EvidenceStorageService();

  beforeAll(async () => {
    await service.init();
  }, 30_000);

  afterAll(async () => {
    await service.stop();
  }, 10_000);

  it("reports ready after init", () => {
    expect(service.isReady()).toBe(true);
  });

  it("archives a bundle and returns CIDs", async () => {
    const bundle = makeMockBundle();
    const result = await service.archiveBundle(bundle);

    expect(result.cid).toBeTruthy();
    expect(result.metadataCid).toBeTruthy();
    // CIDs should be different (different content)
    expect(result.cid).not.toBe(result.metadataCid);
  });

  it("retrieves a bundle by CID and content matches", async () => {
    const bundle = makeMockBundle();
    const { cid } = await service.archiveBundle(bundle);

    const retrieved = await service.retrieveBundle(cid) as EvidenceBundle;

    expect(retrieved.id).toBe(bundle.id);
    expect(retrieved.jobId).toBe(bundle.jobId);
    expect(retrieved.stepId).toBe(bundle.stepId);
    expect(retrieved.kernelId).toBe(bundle.kernelId);
    expect(retrieved.assuranceTier).toBe(bundle.assuranceTier);
    expect(retrieved.bundleHash).toBe(bundle.bundleHash);
    expect(retrieved.events).toHaveLength(2);
    expect(retrieved.events[0].type).toBe("execution_completed");
    expect(retrieved.events[1].type).toBe("power_profile_summary");
  });

  it("retrieves metadata by CID", async () => {
    const bundle = makeMockBundle();
    const { metadataCid } = await service.archiveBundle(bundle);

    const metadata = await service.retrieveBundle(metadataCid) as Record<string, unknown>;

    expect(metadata.bundleId).toBe(bundle.id);
    expect(metadata.jobId).toBe(bundle.jobId);
    expect(metadata.bundleHash).toBe(bundle.bundleHash);
    expect(metadata.eventCount).toBe(2);
    // Metadata should NOT contain full event data
    expect(metadata).not.toHaveProperty("events");
    expect(metadata).not.toHaveProperty("kernelSignature");
  });

  it("archives an encrypted bundle", async () => {
    const encrypted = makeMockEncryptedBundle();
    const result = await service.archiveEncryptedBundle(encrypted);

    expect(result.cid).toBeTruthy();
    expect(result.metadataCid).toBeTruthy();

    // Retrieve and verify
    const retrieved = await service.retrieveBundle(result.cid) as EncryptedEvidenceBundle;
    expect(retrieved.bundleId).toBe(encrypted.bundleId);
    expect(retrieved.ciphertext).toBe(encrypted.ciphertext);
    expect(retrieved.capsules).toHaveLength(1);
  });

  it("encrypted bundle metadata does not leak secrets", async () => {
    const encrypted = makeMockEncryptedBundle();
    const { metadataCid } = await service.archiveEncryptedBundle(encrypted);

    const metadata = await service.retrieveBundle(metadataCid) as Record<string, unknown>;

    expect(metadata.bundleId).toBe(encrypted.bundleId);
    expect(metadata.bundleHash).toBe(encrypted.bundleHash);
    expect(metadata.recipientCount).toBe(1);
    // Must NOT contain ciphertext or keys
    expect(metadata).not.toHaveProperty("ciphertext");
    expect(metadata).not.toHaveProperty("capsules");
    expect(metadata).not.toHaveProperty("iv");
    expect(metadata).not.toHaveProperty("authTag");
  });

  it("produces deterministic CIDs for identical content", async () => {
    const bundle = makeMockBundle();
    const result1 = await service.archiveBundle(bundle);
    const result2 = await service.archiveBundle(bundle);

    expect(result1.cid).toBe(result2.cid);
    expect(result1.metadataCid).toBe(result2.metadataCid);
  });

  it("produces different CIDs for different bundles", async () => {
    const bundle1 = makeMockBundle();
    const bundle2 = makeMockBundle();
    bundle2.id = "bun_ipfs_002";
    bundle2.jobId = "job_ipfs_002";

    const result1 = await service.archiveBundle(bundle1);
    const result2 = await service.archiveBundle(bundle2);

    expect(result1.cid).not.toBe(result2.cid);
  });

  it("throws when not initialized", async () => {
    const uninit = new EvidenceStorageService();
    expect(uninit.isReady()).toBe(false);
    await expect(uninit.archiveBundle(makeMockBundle())).rejects.toThrow("IPFS not initialized");
    await expect(uninit.retrieveBundle("bafkreifoo")).rejects.toThrow("IPFS not initialized");
  });
});
