import { describe, it, expect } from "vitest";
import { createAnnouncement, verifyAnnouncementSignature } from "../announcement.js";
import { generateSigningKeyPair } from "@pcc/a2a";

describe("createAnnouncement", () => {
  it("creates a signed announcement with defaults", () => {
    const kp = generateSigningKeyPair();
    const a = createAnnouncement({
      kernelDid: "did:pcc:test-kernel",
      kernelId: "kernel-001",
      capabilities: [{ type: "fdm_print", materials: ["PLA"] }],
      endpoints: [
        { transport: "websocket-direct", url: "wss://k.local:8443", priority: 1 },
      ],
      secretKey: kp.secretKey,
    });

    expect(a.kernelDid).toBe("did:pcc:test-kernel");
    expect(a.kernelId).toBe("kernel-001");
    expect(a.ttlSeconds).toBe(300); // default
    expect(a.signature).toBeTruthy();
    expect(a.timestamp).toBeTruthy();
  });

  it("respects custom ttlSeconds", () => {
    const kp = generateSigningKeyPair();
    const a = createAnnouncement({
      kernelDid: "did:pcc:custom-ttl",
      kernelId: "k",
      capabilities: [],
      endpoints: [],
      ttlSeconds: 600,
      secretKey: kp.secretKey,
    });
    expect(a.ttlSeconds).toBe(600);
  });

  it("produces a verifiable signature", () => {
    const kp = generateSigningKeyPair();
    const a = createAnnouncement({
      kernelDid: "did:pcc:verify-me",
      kernelId: "kernel-002",
      capabilities: [{ type: "laser_cut" }],
      endpoints: [],
      secretKey: kp.secretKey,
    });

    const valid = verifyAnnouncementSignature(a, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("verification fails with wrong public key", () => {
    const kp1 = generateSigningKeyPair();
    const kp2 = generateSigningKeyPair();
    const a = createAnnouncement({
      kernelDid: "did:pcc:wrong-key",
      kernelId: "k",
      capabilities: [],
      endpoints: [],
      secretKey: kp1.secretKey,
    });

    const valid = verifyAnnouncementSignature(a, kp2.publicKey);
    expect(valid).toBe(false);
  });

  it("verification fails if announcement is tampered", () => {
    const kp = generateSigningKeyPair();
    const a = createAnnouncement({
      kernelDid: "did:pcc:tamper",
      kernelId: "k",
      capabilities: [{ type: "fdm_print" }],
      endpoints: [],
      secretKey: kp.secretKey,
    });

    // Tamper
    const tampered = { ...a, kernelId: "tampered" };
    const valid = verifyAnnouncementSignature(tampered, kp.publicKey);
    expect(valid).toBe(false);
  });
});
