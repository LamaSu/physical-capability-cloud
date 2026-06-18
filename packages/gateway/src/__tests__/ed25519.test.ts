/**
 * Unit tests for the Ed25519 keypair helpers (feat/ed25519-keys-and-kernel-ttl).
 *
 * Covers:
 *   - keypair generation produces correct-length raw outputs
 *   - sign-then-verify roundtrip succeeds
 *   - verify rejects a tampered message
 *   - verify rejects a tampered signature
 *   - verify rejects malformed public key + signature shapes
 *   - normalizers strip 0x prefix + accept both case
 *
 * Pure unit tests: no DB, no Fastify, no network.
 */

import { describe, it, expect } from "vitest";
import {
  generateEd25519Keypair,
  verifyEd25519Signature,
  normalizePublicKeyHex,
  normalizeSignatureHex,
  signWithPrivateKeyHex,
} from "../auth/ed25519.js";

describe("generateEd25519Keypair", () => {
  it("produces 64-hex-char (32-byte) raw public + private keys", () => {
    const kp = generateEd25519Keypair();
    expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.privateKeyPkcs8B64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("produces distinct keypairs on each call", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
    expect(a.privateKeyHex).not.toBe(b.privateKeyHex);
  });
});

describe("sign + verify roundtrip", () => {
  it("verifies a signature produced by the matching private key", () => {
    const kp = generateEd25519Keypair();
    const message = Buffer.from("the orchestrator scaled the wall");
    const sig = signWithPrivateKeyHex(kp.privateKeyHex, message);
    expect(sig).not.toBeNull();
    expect(sig!.length).toBe(128);

    const ok = verifyEd25519Signature(kp.publicKeyHex, message, sig!);
    expect(ok).toBe(true);
  });

  it("rejects a tampered message", () => {
    const kp = generateEd25519Keypair();
    const original = Buffer.from("authorized: send funds to account-123");
    const tampered = Buffer.from("authorized: send funds to account-999");
    const sig = signWithPrivateKeyHex(kp.privateKeyHex, original);
    expect(sig).not.toBeNull();
    expect(verifyEd25519Signature(kp.publicKeyHex, tampered, sig!)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const kp = generateEd25519Keypair();
    const message = Buffer.from("hello");
    const sig = signWithPrivateKeyHex(kp.privateKeyHex, message)!;
    // Flip the last byte.
    const flipped = sig.slice(0, -2) + (sig.slice(-2) === "ff" ? "fe" : "ff");
    expect(verifyEd25519Signature(kp.publicKeyHex, message, flipped)).toBe(false);
  });

  it("rejects a signature verified against the wrong public key", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    const message = Buffer.from("hello");
    const sig = signWithPrivateKeyHex(a.privateKeyHex, message)!;
    expect(verifyEd25519Signature(b.publicKeyHex, message, sig)).toBe(false);
    // Sanity: it WOULD verify against the original.
    expect(verifyEd25519Signature(a.publicKeyHex, message, sig)).toBe(true);
  });
});

describe("normalizers + input validation", () => {
  it("normalizePublicKeyHex strips 0x prefix + lowercases", () => {
    const kp = generateEd25519Keypair();
    const upper = kp.publicKeyHex.toUpperCase();
    expect(normalizePublicKeyHex(`0x${upper}`)).toBe(kp.publicKeyHex);
    expect(normalizePublicKeyHex(`0X${upper}`)).toBe(kp.publicKeyHex);
    expect(normalizePublicKeyHex(upper)).toBe(kp.publicKeyHex);
  });

  it("normalizePublicKeyHex rejects wrong-length / non-hex inputs", () => {
    expect(normalizePublicKeyHex("not hex")).toBeNull();
    expect(normalizePublicKeyHex("abc")).toBeNull();
    expect(normalizePublicKeyHex("g".repeat(64))).toBeNull();
    expect(normalizePublicKeyHex("a".repeat(63))).toBeNull();
    expect(normalizePublicKeyHex("a".repeat(65))).toBeNull();
    expect(normalizePublicKeyHex("")).toBeNull();
    // @ts-expect-error testing wrong type
    expect(normalizePublicKeyHex(123)).toBeNull();
  });

  it("normalizeSignatureHex requires 128 hex chars", () => {
    expect(normalizeSignatureHex("a".repeat(128))).toBe("a".repeat(128));
    expect(normalizeSignatureHex("a".repeat(127))).toBeNull();
    expect(normalizeSignatureHex("a".repeat(129))).toBeNull();
    expect(normalizeSignatureHex(`0x${"a".repeat(128)}`)).toBe("a".repeat(128));
  });

  it("verify returns false (never throws) on malformed inputs", () => {
    const kp = generateEd25519Keypair();
    const message = Buffer.from("hello");
    const validSig = signWithPrivateKeyHex(kp.privateKeyHex, message)!;
    // Garbage in: still false, not a thrown exception.
    expect(verifyEd25519Signature("not-hex", message, validSig)).toBe(false);
    expect(verifyEd25519Signature(kp.publicKeyHex, message, "not-hex")).toBe(false);
    expect(verifyEd25519Signature("", message, validSig)).toBe(false);
  });
});
