import { describe, it, expect, beforeEach } from "vitest";
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  encryptMessage,
  decryptMessage,
  sign,
  verify,
  signAnnouncement,
  verifyAnnouncement,
} from "../crypto.js";
import { canonicalize } from "@pcc/spec";
import { EncryptedBus } from "../encrypted-bus.js";
import type { BusLike } from "../encrypted-bus.js";
import type { A2AMessage } from "../types.js";
import type { CapabilityAnnouncement } from "@pcc/spec";

// ── Helpers ────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    conversationId: `conv_${Math.random().toString(36).slice(2, 8)}`,
    from: "agent_sender",
    to: "agent_receiver",
    intent: { type: "text_message", text: "hello world" },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Key Generation ─────────────────────────────────────────────────

describe("Key generation", () => {
  it("generates Ed25519 signing key pairs", () => {
    const kp = generateSigningKeyPair();
    expect(kp.publicKey).toMatch(/^[0-9a-f]{64}$/);
    // Ed25519 secret keys are 64 bytes (128 hex chars)
    expect(kp.secretKey).toMatch(/^[0-9a-f]{128}$/);
  });

  it("generates X25519 encryption key pairs", () => {
    const kp = generateEncryptionKeyPair();
    // X25519 keys are 32 bytes (64 hex chars)
    expect(kp.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.secretKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique key pairs each time", () => {
    const a = generateEncryptionKeyPair();
    const b = generateEncryptionKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.secretKey).not.toBe(b.secretKey);
  });
});

// ── Encrypt / Decrypt ──────────────────────────────────────────────

describe("encryptMessage / decryptMessage", () => {
  it("roundtrips a message through encrypt → decrypt", () => {
    const alice = generateEncryptionKeyPair();
    const bob = generateEncryptionKeyPair();
    const plaintext = "secret agent data";

    const envelope = encryptMessage(plaintext, bob.publicKey, alice.secretKey);
    expect(envelope.ciphertext).toBeTruthy();
    expect(envelope.nonce).toBeTruthy();
    expect(envelope.ephemeralPublicKey).toBeTruthy();

    // Bob decrypts using Alice's public key
    const decrypted = decryptMessage(envelope, alice.publicKey, bob.secretKey);
    expect(decrypted).toBe(plaintext);
  });

  it("handles unicode and JSON payloads", () => {
    const alice = generateEncryptionKeyPair();
    const bob = generateEncryptionKeyPair();
    const payload = JSON.stringify({ type: "request_quote", data: "3D printing \u2014 PLA" });

    const envelope = encryptMessage(payload, bob.publicKey, alice.secretKey);
    const decrypted = decryptMessage(envelope, alice.publicKey, bob.secretKey);
    expect(decrypted).toBe(payload);
  });

  it("returns null when decrypting with the wrong key", () => {
    const alice = generateEncryptionKeyPair();
    const bob = generateEncryptionKeyPair();
    const eve = generateEncryptionKeyPair();

    const envelope = encryptMessage("secret", bob.publicKey, alice.secretKey);

    // Eve tries to decrypt — should fail
    const decrypted = decryptMessage(envelope, alice.publicKey, eve.secretKey);
    expect(decrypted).toBeNull();
  });

  it("returns null when ciphertext is tampered with", () => {
    const alice = generateEncryptionKeyPair();
    const bob = generateEncryptionKeyPair();

    const envelope = encryptMessage("secret", bob.publicKey, alice.secretKey);

    // Tamper with ciphertext
    const tamperedCiphertext = Buffer.from(envelope.ciphertext, "base64");
    tamperedCiphertext[0] ^= 0xff;
    const tampered = {
      ...envelope,
      ciphertext: tamperedCiphertext.toString("base64"),
    };

    const decrypted = decryptMessage(tampered, alice.publicKey, bob.secretKey);
    expect(decrypted).toBeNull();
  });

  it("ephemeralPublicKey matches the sender's public key", () => {
    const alice = generateEncryptionKeyPair();
    const bob = generateEncryptionKeyPair();

    const envelope = encryptMessage("hello", bob.publicKey, alice.secretKey);
    expect(envelope.ephemeralPublicKey).toBe(alice.publicKey);
  });
});

// ── Sign / Verify ──────────────────────────────────────────────────

describe("sign / verify", () => {
  it("roundtrips: sign then verify succeeds", () => {
    const kp = generateSigningKeyPair();
    const data = "important message";

    const sig = sign(data, kp.secretKey);
    expect(sig).toBeTruthy();

    const valid = verify(data, sig, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("verify fails with wrong public key", () => {
    const kp1 = generateSigningKeyPair();
    const kp2 = generateSigningKeyPair();
    const data = "important message";

    const sig = sign(data, kp1.secretKey);
    const valid = verify(data, sig, kp2.publicKey);
    expect(valid).toBe(false);
  });

  it("verify fails with tampered data", () => {
    const kp = generateSigningKeyPair();
    const sig = sign("original", kp.secretKey);
    const valid = verify("tampered", sig, kp.publicKey);
    expect(valid).toBe(false);
  });
});

// ── Capability Announcements ───────────────────────────────────────

describe("signAnnouncement / verifyAnnouncement", () => {
  it("signs and verifies a capability announcement", () => {
    const kp = generateSigningKeyPair();

    const announcement: Omit<CapabilityAnnouncement, "signature"> = {
      kernelDid: "did:pcc:kernel-001",
      kernelId: "kernel-001",
      capabilities: [
        { type: "fdm_print", materials: ["PLA", "PETG"], queueDepth: 3 },
      ],
      endpoints: [
        { transport: "websocket-direct", url: "wss://kernel-001.local:8443", priority: 1 },
      ],
      ttlSeconds: 3600,
      timestamp: new Date().toISOString(),
    };

    const sig = signAnnouncement(announcement, kp.secretKey);
    expect(sig).toBeTruthy();

    const signed: CapabilityAnnouncement = { ...announcement, signature: sig };
    const valid = verifyAnnouncement(signed, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("verification fails if announcement is tampered", () => {
    const kp = generateSigningKeyPair();

    const announcement: Omit<CapabilityAnnouncement, "signature"> = {
      kernelDid: "did:pcc:kernel-002",
      kernelId: "kernel-002",
      capabilities: [{ type: "laser_cut" }],
      endpoints: [],
      ttlSeconds: 1800,
      timestamp: new Date().toISOString(),
    };

    const sig = signAnnouncement(announcement, kp.secretKey);
    const signed: CapabilityAnnouncement = {
      ...announcement,
      signature: sig,
      // Tamper: change the kernel ID
      kernelId: "kernel-TAMPERED",
    };

    const valid = verifyAnnouncement(signed, kp.publicKey);
    expect(valid).toBe(false);
  });

  it("verification fails with wrong public key", () => {
    const kp1 = generateSigningKeyPair();
    const kp2 = generateSigningKeyPair();

    const announcement: Omit<CapabilityAnnouncement, "signature"> = {
      kernelDid: "did:pcc:kernel-003",
      kernelId: "kernel-003",
      capabilities: [],
      endpoints: [],
      ttlSeconds: 600,
      timestamp: new Date().toISOString(),
    };

    const sig = signAnnouncement(announcement, kp1.secretKey);
    const signed: CapabilityAnnouncement = { ...announcement, signature: sig };

    const valid = verifyAnnouncement(signed, kp2.publicKey);
    expect(valid).toBe(false);
  });
});

// ── Canonicalization unification (cross-transport signature interop) ─

describe("canonicalization unification (RTP doc 02 open Q1)", () => {
  // Doc 02 open Q1: a2a previously signed over `JSON.stringify(obj, keys.sort())`,
  // which (a) does not recursively sort nested keys and (b) silently DROPS nested-only
  // keys (the array-replacer is applied at every depth). @pcc/spec signs over recursive
  // `canonicalize()` (JCS). They disagreed → cross-transport verify broke. a2a now uses
  // the SAME `canonicalize` as the spec. These tests prove a signature produced via one
  // path verifies via the other, using a NESTED announcement that the old path mangled.
  const nestedAnnouncement: Omit<CapabilityAnnouncement, "signature"> = {
    kernelDid: "did:pcc:kernel-xtransport",
    kernelId: "kernel-xtransport",
    capabilities: [
      { type: "fdm_print", materials: ["PLA", "PETG"], queueDepth: 3 },
      { type: "cnc_mill", materials: ["AL6061"], queueDepth: 0 },
    ],
    endpoints: [
      { transport: "websocket-direct", url: "wss://k.local:8443", priority: 1 },
    ],
    ttlSeconds: 3600,
    timestamp: "2026-06-24T00:00:00Z",
  };

  it("signAnnouncement == sign(canonicalize(obj)) byte-for-byte (same canonical bytes)", () => {
    const kp = generateSigningKeyPair();
    const viaA2a = signAnnouncement(nestedAnnouncement, kp.secretKey);
    // The spec/kernel-sdk path: hash/sign over the recursive canonical JSON.
    const viaSpec = sign(canonicalize(nestedAnnouncement), kp.secretKey);
    expect(viaA2a).toBe(viaSpec);
  });

  it("a signature produced via the SPEC path verifies via the a2a verifyAnnouncement path", () => {
    const kp = generateSigningKeyPair();
    const sig = sign(canonicalize(nestedAnnouncement), kp.secretKey);
    const signed: CapabilityAnnouncement = { ...nestedAnnouncement, signature: sig };
    expect(verifyAnnouncement(signed, kp.publicKey)).toBe(true);
  });

  it("a signature produced via the a2a path verifies via the spec verify(canonicalize()) path", () => {
    const kp = generateSigningKeyPair();
    const sig = signAnnouncement(nestedAnnouncement, kp.secretKey);
    expect(verify(canonicalize(nestedAnnouncement), sig, kp.publicKey)).toBe(true);
  });

  it("the unified canonical form retains nested keys the old array-replacer dropped", () => {
    const canonical = canonicalize(nestedAnnouncement);
    expect(canonical).toContain("materials");
    expect(canonical).toContain("queueDepth");
    expect(canonical).toContain("priority");

    // Demonstrate the bug the fix closes: the old path drops nested-only keys.
    const legacy = JSON.stringify(
      nestedAnnouncement,
      Object.keys(nestedAnnouncement).sort(),
    );
    expect(legacy).not.toContain("materials");
    expect(canonical).not.toBe(legacy);
  });
});

// ── EncryptedBus ───────────────────────────────────────────────────

describe("EncryptedBus", () => {
  let sentMessages: A2AMessage[];
  let subscribedHandlers: Map<string, ((msg: A2AMessage) => void)[]>;
  let mockBus: BusLike;

  beforeEach(() => {
    sentMessages = [];
    subscribedHandlers = new Map();
    mockBus = {
      async send(message: A2AMessage) {
        sentMessages.push(message);
        // Simulate delivery to subscribers
        const handlers = subscribedHandlers.get(message.to) ?? [];
        for (const h of handlers) h(message);
      },
      subscribe(agentId: string, handler: (msg: A2AMessage) => void) {
        const existing = subscribedHandlers.get(agentId) ?? [];
        existing.push(handler);
        subscribedHandlers.set(agentId, existing);
      },
    };
  });

  it("encrypts outgoing messages when peer key is known", async () => {
    const alice = generateEncryptionKeyPair();
    const bob = generateEncryptionKeyPair();

    const peerKeys = new Map([["agent_receiver", bob.publicKey]]);
    const bus = new EncryptedBus(mockBus, alice.secretKey, peerKeys);

    const msg = makeMessage();
    await bus.send(msg);

    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0];
    // The intent should be replaced with a placeholder
    expect(sent.intent.type).toBe("text_message");
    expect(sent.encrypted).toBeDefined();
    expect(sent.encrypted!.ciphertext).toBeTruthy();
  });

  it("sends unencrypted when no peer key exists", async () => {
    const alice = generateEncryptionKeyPair();
    const peerKeys = new Map<string, string>(); // empty
    const bus = new EncryptedBus(mockBus, alice.secretKey, peerKeys);

    const msg = makeMessage();
    await bus.send(msg);

    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0];
    expect(sent.encrypted).toBeUndefined();
    expect(sent.intent).toEqual(msg.intent);
  });

  it("decrypt on receive: encrypted message is decrypted for handler", async () => {
    const alice = generateEncryptionKeyPair();
    const bob = generateEncryptionKeyPair();

    // Alice sends encrypted to Bob
    const alicePeerKeys = new Map([["agent_receiver", bob.publicKey]]);
    const aliceBus = new EncryptedBus(mockBus, alice.secretKey, alicePeerKeys);

    // Bob subscribes through his encrypted bus
    const bobPeerKeys = new Map([["agent_sender", alice.publicKey]]);
    const bobBus = new EncryptedBus(mockBus, bob.secretKey, bobPeerKeys);

    const receivedMessages: A2AMessage[] = [];
    bobBus.subscribe("agent_receiver", (msg) => {
      receivedMessages.push(msg);
    });

    // Alice sends
    const msg = makeMessage({
      from: "agent_sender",
      to: "agent_receiver",
      intent: { type: "text_message", text: "secret handshake" },
    });
    await aliceBus.send(msg);

    // Bob should have received the decrypted message
    expect(receivedMessages).toHaveLength(1);
    const received = receivedMessages[0];
    expect(received.intent.type).toBe("text_message");
    expect((received.intent as { text: string }).text).toBe("secret handshake");
    expect(received.encrypted).toBeUndefined();
  });

  it("passes through unencrypted messages unchanged", async () => {
    const bob = generateEncryptionKeyPair();
    const bobPeerKeys = new Map<string, string>();
    const bobBus = new EncryptedBus(mockBus, bob.secretKey, bobPeerKeys);

    const receivedMessages: A2AMessage[] = [];
    bobBus.subscribe("agent_receiver", (msg) => {
      receivedMessages.push(msg);
    });

    // Simulate direct send through mock bus (no encryption)
    const msg = makeMessage({
      from: "agent_sender",
      to: "agent_receiver",
      intent: { type: "text_message", text: "plain message" },
    });
    await mockBus.send(msg);

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0].intent.type).toBe("text_message");
    expect((receivedMessages[0].intent as { text: string }).text).toBe("plain message");
  });

  it("falls through to raw handler if decryption fails (wrong key)", async () => {
    const alice = generateEncryptionKeyPair();
    const bob = generateEncryptionKeyPair();
    const eve = generateEncryptionKeyPair();

    // Alice sends encrypted to Bob
    const alicePeerKeys = new Map([["agent_receiver", bob.publicKey]]);
    const aliceBus = new EncryptedBus(mockBus, alice.secretKey, alicePeerKeys);

    // Eve subscribes but has wrong key for sender
    const evePeerKeys = new Map([["agent_sender", eve.publicKey]]); // wrong key!
    const eveBus = new EncryptedBus(mockBus, eve.secretKey, evePeerKeys);

    const receivedMessages: A2AMessage[] = [];
    eveBus.subscribe("agent_receiver", (msg) => {
      receivedMessages.push(msg);
    });

    const msg = makeMessage({
      from: "agent_sender",
      to: "agent_receiver",
      intent: { type: "text_message", text: "secret" },
    });
    await aliceBus.send(msg);

    // Eve gets the raw encrypted message (decryption failed)
    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0].encrypted).toBeDefined();
    expect(receivedMessages[0].intent.type).toBe("text_message");
  });
});
