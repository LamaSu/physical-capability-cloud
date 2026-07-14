/**
 * H4 — the gateway receipt signer must FAIL CLOSED in production and identify
 * keys by fingerprint (§8.1-#3 hardening). Covered:
 *   - constructor asserts pubkey ⟺ seed (a mis-paired key is rejected at build)
 *   - production + MISSING key → throws (no ephemeral fallback)
 *   - production + MALFORMED key → throws (no ephemeral fallback)
 *   - production + VALID key → constructs; keyId is the pubkey fingerprint
 *   - env keyId is a fingerprint (two DIFFERENT seeds ⇒ two DIFFERENT keyIds; the
 *     old constant "gw-rcpt-1" is gone)
 *   - non-production + MISSING key → zero-config ephemeral signer (dev/test key-free)
 *   - the process-default signer is cached until reset
 *
 * NODE_ENV + PCC_GATEWAY_RECEIPT_PRIVATE_KEY are saved/restored around every case,
 * and the cached process-default signer is reset via the test-only hook so each
 * case exercises a clean state.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  GatewayReceiptSigner,
  getDefaultGatewayReceiptSigner,
  __resetDefaultGatewayReceiptSigner,
} from "../services/gateway-receipt-signer.js";
import { generateEd25519Keypair } from "../auth/ed25519.js";
import { createHash } from "node:crypto";

const ENV_KEY = "PCC_GATEWAY_RECEIPT_PRIVATE_KEY";

// The expected keyId = the SAME full-sha256 fingerprint the signer computes (round-5: an 8-hex /
// 32-bit prefix was birthday-collision-prone → now `<prefix>-<sha256(pubkey)>`, 256 bits, safe for
// an independent oracle key registry to treat as unique identity).
const fpKeyId = (pubHex: string, prefix = "gw-rcpt"): string =>
  `${prefix}-${createHash("sha256").update(pubHex.replace(/^0x/i, "").toLowerCase(), "utf8").digest("hex")}`;

describe("gateway-receipt-signer — H4 fail-closed + fingerprint keyId + pairing assert", () => {
  let savedNodeEnv: string | undefined;
  let savedKey: string | undefined;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    savedKey = process.env[ENV_KEY];
    __resetDefaultGatewayReceiptSigner();
  });

  afterEach(() => {
    // Restore the process env exactly as it was and clear the cached singleton so
    // no state leaks into another test / file.
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedKey === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedKey;
    __resetDefaultGatewayReceiptSigner();
  });

  // --- constructor pubkey ⟺ seed assertion --------------------------------
  it("constructor accepts a correctly paired key and rejects a mis-paired one", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();

    // Correctly paired → constructs.
    const signer = new GatewayReceiptSigner({
      keyId: "k",
      privateKeyHex: a.privateKeyHex,
      publicKeyHex: a.publicKeyHex,
    });
    expect(signer.publicKeyHex).toBe(a.publicKeyHex);

    // seed A but pubkey B → throws (mis-paired: would sign under A, advertise B).
    expect(
      () =>
        new GatewayReceiptSigner({
          keyId: "k",
          privateKeyHex: a.privateKeyHex,
          publicKeyHex: b.publicKeyHex,
        }),
    ).toThrow(/does not match the private seed|mis-paired/i);
  });

  // --- production fail-closed ---------------------------------------------
  it("production + MISSING key → throws (no ephemeral fallback)", () => {
    process.env.NODE_ENV = "production";
    delete process.env[ENV_KEY];
    __resetDefaultGatewayReceiptSigner();
    expect(() => getDefaultGatewayReceiptSigner()).toThrow(/required in production/i);
  });

  it("production + MALFORMED key → throws (no ephemeral fallback)", () => {
    process.env.NODE_ENV = "production";
    process.env[ENV_KEY] = "not-a-valid-64-hex-seed";
    __resetDefaultGatewayReceiptSigner();
    expect(() => getDefaultGatewayReceiptSigner()).toThrow(/malformed in production/i);
  });

  it("production + VALID key → constructs; keyId is the pubkey fingerprint (gate opens with a real key)", () => {
    const kp = generateEd25519Keypair();
    process.env.NODE_ENV = "production";
    process.env[ENV_KEY] = kp.privateKeyHex;
    __resetDefaultGatewayReceiptSigner();

    const signer = getDefaultGatewayReceiptSigner();
    expect(signer.keyId).toBe(fpKeyId(kp.publicKeyHex));
    expect(signer.publicKeyHex).toBe(kp.publicKeyHex);
    // Round-trip: the env-derived key signs and verifies.
    const content = { hello: "world" };
    expect(signer.verify(content, signer.sign(content))).toBe(true);
  });

  it("production + VALID key with 0x prefix → accepted (normalized) and fingerprinted", () => {
    const kp = generateEd25519Keypair();
    process.env.NODE_ENV = "production";
    process.env[ENV_KEY] = `0x${kp.privateKeyHex}`;
    __resetDefaultGatewayReceiptSigner();

    const signer = getDefaultGatewayReceiptSigner();
    expect(signer.keyId).toBe(fpKeyId(kp.publicKeyHex));
    expect(signer.publicKeyHex).toBe(kp.publicKeyHex);
  });

  // --- keyId is a fingerprint, not a constant -----------------------------
  it("env keyId is a fingerprint of the public key: two DIFFERENT seeds ⇒ two DIFFERENT keyIds", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();

    process.env.NODE_ENV = "production"; // env-key path is identical in prod/dev
    process.env[ENV_KEY] = a.privateKeyHex;
    __resetDefaultGatewayReceiptSigner();
    const idA = getDefaultGatewayReceiptSigner().keyId;

    process.env[ENV_KEY] = b.privateKeyHex;
    __resetDefaultGatewayReceiptSigner();
    const idB = getDefaultGatewayReceiptSigner().keyId;

    expect(idA).toBe(fpKeyId(a.publicKeyHex));
    expect(idB).toBe(fpKeyId(b.publicKeyHex));
    expect(idA).toMatch(/^gw-rcpt-[0-9a-f]{64}$/); // full sha256 (256-bit), not the old 32-bit prefix
    expect(idA).not.toBe(idB); // two DIFFERENT keys can NEVER share a gatewayKeyId
    expect(idA).not.toBe("gw-rcpt-1"); // the old constant keyId is gone
  });

  // --- non-production ephemeral fallback still works -----------------------
  it("non-production + MISSING key → zero-config ephemeral signer (dev/test stays key-free)", () => {
    process.env.NODE_ENV = "development";
    delete process.env[ENV_KEY];
    __resetDefaultGatewayReceiptSigner();

    const signer = getDefaultGatewayReceiptSigner();
    expect(signer.keyId).toMatch(/^gw-rcpt-eph-[0-9a-f]{64}$/);
    // The ephemeral key signs and verifies.
    const content = { a: 1 };
    expect(signer.verify(content, signer.sign(content))).toBe(true);
  });

  it("the process-default signer is cached (same instance until __reset)", () => {
    process.env.NODE_ENV = "development";
    delete process.env[ENV_KEY];
    __resetDefaultGatewayReceiptSigner();

    const s1 = getDefaultGatewayReceiptSigner();
    const s2 = getDefaultGatewayReceiptSigner();
    expect(s2).toBe(s1);

    __resetDefaultGatewayReceiptSigner();
    const s3 = getDefaultGatewayReceiptSigner();
    expect(s3).not.toBe(s1);
  });
});
