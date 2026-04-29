/**
 * Ed25519-signed receipts for centralized PCC settlements.
 *
 * Construction goals:
 *  - Deterministic, language-agnostic canonical encoding so two
 *    independent implementations sign the same bytes for the same payload.
 *  - Hash-PII-only: actor identifiers ARE hashed at the call site (the
 *    schema enforces this), never raw email/phone in the signed payload.
 *  - Settlement-mode aware: `settlementMode: "centralized" | "onchain"`
 *    is signed, so a verifier can tell which path the receipt came from
 *    even without on-chain context.
 *
 * The signed bytes are:
 *
 *     canonicalize(payload)  =  utf8( JSON-with-sorted-keys(payload) )
 *
 * JSON sort-keys gives us a stable byte representation across JS, Python,
 * Go, Rust, etc. without needing CBOR or protobuf as a dependency. The
 * downside is float precision; the schema rejects floats so this is fine.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { z } from "zod";

// ── Schema ─────────────────────────────────────────────────────────────

/**
 * Hashed actor identifier — never a raw email/phone number. Caller is
 * expected to compute e.g. SHA-256(emailLowercased || salt) on the
 * server before constructing this struct.
 *
 * The exact hash format is up to the caller, but it must be a hex
 * string (we accept any non-empty hex).
 */
const HashedActorSchema = z
  .string()
  .min(1)
  .regex(/^[0-9a-fA-F]+$/, "actor must be a hex string");

/**
 * Settlement mode — which path produced this receipt.
 *  - "centralized": settled via @pcc/escrow-ledger + transparency log.
 *  - "onchain":     settled via MilestoneEscrow.release() on Base.
 */
export const SettlementModeEnum = z.enum(["centralized", "onchain"]);
export type SettlementMode = z.infer<typeof SettlementModeEnum>;

export const ReceiptPayloadSchema = z.object({
  /** Stable id of the milestone this receipt settles. */
  milestoneId: z.string().min(1),
  /** Capability id (or capability type slug) the milestone fulfills. */
  capability: z.string().min(1),
  /**
   * Hashed actor identifiers. Hashing is the caller's responsibility;
   * the schema only checks that no raw addresses leak through.
   */
  actorsHashed: z.object({
    user: HashedActorSchema,
    operator: HashedActorSchema,
  }),
  /**
   * Cents to keep precision deterministic — JSON's float behavior is
   * the kind of nondeterminism that breaks signatures.
   */
  amountCents: z.number().int().nonnegative(),
  /** Hex-encoded SHA-256 (or similar) of the evidence bundle. */
  evidenceHash: z
    .string()
    .min(1)
    .regex(/^[0-9a-fA-F]+$/, "evidenceHash must be hex"),
  /** ISO-8601 UTC timestamp; second-precision is fine. */
  timestamp: z
    .string()
    .min(1)
    .refine((v) => !Number.isNaN(Date.parse(v)), {
      message: "timestamp must be ISO-8601",
    }),
  settlementMode: SettlementModeEnum,
});

export type ReceiptPayload = z.infer<typeof ReceiptPayloadSchema>;

export const SignedReceiptSchema = z.object({
  payload: ReceiptPayloadSchema,
  /** Ed25519 signature over `canonicalize(payload)`, hex-encoded. */
  signature: z
    .string()
    .length(128)
    .regex(/^[0-9a-fA-F]+$/, "signature must be 64-byte hex (128 chars)"),
  /** Hex-encoded Ed25519 public key the receipt was signed with. */
  signerPublicKey: z
    .string()
    .length(64)
    .regex(/^[0-9a-fA-F]+$/, "signerPublicKey must be 32-byte hex (64 chars)"),
});

export type SignedReceipt = z.infer<typeof SignedReceiptSchema>;

// ── Canonical encoding ────────────────────────────────────────────────

/**
 * Stable JSON encoding: sort keys at every object level. Arrays preserve
 * order. Numbers must be integers (the schema enforces this). Strings
 * encoded as standard JSON strings.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`canonicalJson: non-integer numbers are not permitted (${value})`);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries = keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]));
    return "{" + entries.join(",") + "}";
  }
  throw new Error(`canonicalJson: unsupported value type (${typeof value})`);
}

/** Canonical bytes for a receipt payload (the bytes that get signed). */
export function canonicalize(payload: ReceiptPayload): Uint8Array {
  // Validate first so a tampered payload doesn't slip in via `as any`.
  const parsed = ReceiptPayloadSchema.parse(payload);
  return utf8ToBytes(canonicalJson(parsed));
}

/** SHA-256 digest of the canonical payload (hex-encoded). Useful for evidence references. */
export function payloadDigest(payload: ReceiptPayload): string {
  return bytesToHex(sha256(canonicalize(payload)));
}

// ── Sign / verify ─────────────────────────────────────────────────────

/**
 * Sign a receipt with the given Ed25519 private key (32 bytes).
 *
 * @param payload Validated ReceiptPayload.
 * @param ed25519Priv 32-byte private key (Uint8Array or 64-char hex).
 * @returns SignedReceipt with hex signature + public key.
 */
export function signReceipt(
  payload: ReceiptPayload,
  ed25519Priv: Uint8Array | string,
): SignedReceipt {
  const priv = typeof ed25519Priv === "string" ? hexToBytes(ed25519Priv) : ed25519Priv;
  if (priv.length !== 32) {
    throw new Error(`signReceipt: private key must be 32 bytes, got ${priv.length}`);
  }

  const message = canonicalize(payload);
  const signature = ed25519.sign(message, priv);
  const pub = ed25519.getPublicKey(priv);

  return {
    payload,
    signature: bytesToHex(signature),
    signerPublicKey: bytesToHex(pub),
  };
}

/**
 * Verify a SignedReceipt against an expected Ed25519 public key.
 *
 * @param signed The signed receipt.
 * @param expectedPub 32-byte public key (Uint8Array or 64-char hex). If omitted,
 *                    the receipt's embedded `signerPublicKey` is used (use this
 *                    only if you trust the embedding context).
 * @returns true iff the signature is valid AND (when provided) matches `expectedPub`.
 */
export function verifyReceipt(
  signed: SignedReceipt,
  expectedPub?: Uint8Array | string,
): boolean {
  const parsed = SignedReceiptSchema.safeParse(signed);
  if (!parsed.success) return false;

  const pubHex = parsed.data.signerPublicKey;
  if (expectedPub !== undefined) {
    const expectedHex =
      typeof expectedPub === "string" ? expectedPub.toLowerCase() : bytesToHex(expectedPub);
    if (pubHex.toLowerCase() !== expectedHex) return false;
  }

  try {
    const message = canonicalize(parsed.data.payload);
    const sig = hexToBytes(parsed.data.signature);
    const pub = hexToBytes(pubHex);
    return ed25519.verify(sig, message, pub);
  } catch {
    return false;
  }
}

/** Convenience: generate a fresh Ed25519 keypair (for tests/dev). */
export function generateEd25519Keypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}
