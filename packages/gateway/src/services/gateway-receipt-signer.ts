/**
 * Gateway receipt signer — Ed25519 over the canonical bytes of a GatewayReceipt
 * (§8.3: "gateway-signed ... Ed25519 over canonical bytes, same conventions as
 * #247"). The GatewayReceipt is a TIME-AUTHORITY artifact; the gateway asserts
 * "PCC accepted this checkpoint at acceptedAt" and signs that assertion.
 *
 * Reuses the repo's existing Ed25519 helpers (packages/gateway/src/auth/
 * ed25519.ts — node:crypto, SYNCHRONOUS, raw-32-byte-hex convention) and the
 * canonical-JSON serializer (`canonicalize` from @pcc/spec). SYNCHRONOUS
 * signing matters: the receipt-store signs inside its single-writer critical
 * section, which must contain no `await`.
 *
 * KEY (env vs ephemeral) — mirrors the receipt-signer.ts precedent
 * (getDefaultSignerKey): read a configured key from env, else generate an
 * ephemeral one at process start so tests/dev work with zero config.
 *
 * DELIBERATE ENV CHOICE: the key is read from `PCC_GATEWAY_RECEIPT_PRIVATE_KEY`
 * (a raw 32-byte Ed25519 seed, hex) — NOT `PCC_GATEWAY_PRIVATE_KEY`. The latter
 * is verified to be the secp256k1 EVM settlement key (viem privateKeyToAccount,
 * paid-job-flow.ts). Reusing it as an Ed25519 seed would be cross-algorithm key
 * reuse AND would couple the receipt time-authority to the settlement key —
 * exactly the separation §8.1-#3 asks for (the receipt key's history must be
 * independently tamper-evident). So the receipt key is its own key.
 *
 * TODO (§8.1-#3 / §8.5 step 10 — STATED, NOT BUILT HERE, with reason): receipts
 * make the gateway a time authority, so the receipt-key *history* (rotations)
 * must itself be tamper-evident — published to a transparency log / oracle-
 * attested — else a compromised gateway could retroactively mint "old" receipts
 * under a fabricated prior key. That is a cross-system concern (transparency log
 * + oracle attestation) well beyond this additive mechanism; a single configured
 * gatewayKeyId is used now. Building the transparency log is explicitly out of
 * scope for step 5.
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { canonicalize } from "@pcc/spec";
import {
  generateEd25519Keypair,
  signWithPrivateKeyHex,
  verifyEd25519Signature,
} from "../auth/ed25519.js";

/** An Ed25519 receipt-signing key. Both halves are raw-byte hex (no 0x). */
export interface GatewayReceiptKey {
  /** Stable id recorded as receipt.gatewayKeyId. */
  keyId: string;
  /** Raw 32-byte private seed, hex (64 chars). */
  privateKeyHex: string;
  /** Raw 32-byte public key, hex (64 chars). */
  publicKeyHex: string;
}

/**
 * Derive the raw 32-byte public key (hex) from a raw 32-byte Ed25519 seed (hex),
 * using the same node:crypto SPKI/PKCS8 convention as auth/ed25519.ts.
 */
function publicKeyHexFromSeedHex(seedHex: string): string {
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const pkcs8Der = Buffer.concat([pkcs8Prefix, Buffer.from(seedHex, "hex")]);
  const priv = createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
  const spkiDer = createPublicKey(priv).export({ type: "spki", format: "der" });
  // Strip the 12-byte ASN.1 prefix (Ed25519 SPKI DER is 44 bytes).
  return Buffer.from(spkiDer.subarray(12)).toString("hex");
}

export class GatewayReceiptSigner {
  /** The gatewayKeyId written into every receipt this signer produces. */
  readonly keyId: string;
  /** The raw 32-byte public key (hex) — lets any holder verify a receipt. */
  readonly publicKeyHex: string;
  private readonly privateKeyHex: string;

  constructor(key: GatewayReceiptKey) {
    this.keyId = key.keyId;
    this.publicKeyHex = key.publicKeyHex;
    this.privateKeyHex = key.privateKeyHex;
  }

  /**
   * Sign the canonical bytes of the receipt content (the receipt object WITHOUT
   * its `signature` field). Returns a 128-hex Ed25519 signature. Throws on a
   * bad key (a signing failure must never silently yield an empty signature).
   */
  sign(content: unknown): string {
    const bytes = new TextEncoder().encode(canonicalize(content));
    const sig = signWithPrivateKeyHex(this.privateKeyHex, bytes);
    if (sig === null) {
      throw new Error("gateway receipt signing failed (invalid signing key)");
    }
    return sig;
  }

  /** Verify a signature over the canonical content against this signer's key. */
  verify(content: unknown, signatureHex: string): boolean {
    const bytes = new TextEncoder().encode(canonicalize(content));
    return verifyEd25519Signature(this.publicKeyHex, bytes, signatureHex);
  }
}

/** Cached process-default signer — created once, reused across receipts. */
let processDefaultSigner: GatewayReceiptSigner | null = null;

/**
 * The process-default gateway receipt signer. Reads a raw 32-byte Ed25519 seed
 * from `PCC_GATEWAY_RECEIPT_PRIVATE_KEY` (hex, optional 0x) if present; else
 * generates an ephemeral keypair. keyId is "gw-rcpt-1" for env keys and
 * "gw-rcpt-eph-<8 hex of pubkey>" for ephemerals so they're distinguishable in
 * audit logs. Production deploys MUST set the env var so receipts stay
 * verifiable across restarts.
 */
export function getDefaultGatewayReceiptSigner(): GatewayReceiptSigner {
  if (processDefaultSigner) return processDefaultSigner;
  const envKey = process.env.PCC_GATEWAY_RECEIPT_PRIVATE_KEY;
  if (envKey && /^(0x)?[0-9a-fA-F]{64}$/.test(envKey)) {
    const seed = (envKey.startsWith("0x") ? envKey.slice(2) : envKey).toLowerCase();
    processDefaultSigner = new GatewayReceiptSigner({
      keyId: "gw-rcpt-1",
      privateKeyHex: seed,
      publicKeyHex: publicKeyHexFromSeedHex(seed),
    });
    return processDefaultSigner;
  }
  const kp = generateEd25519Keypair();
  processDefaultSigner = new GatewayReceiptSigner({
    keyId: `gw-rcpt-eph-${kp.publicKeyHex.slice(0, 8)}`,
    privateKeyHex: kp.privateKeyHex,
    publicKeyHex: kp.publicKeyHex,
  });
  return processDefaultSigner;
}
