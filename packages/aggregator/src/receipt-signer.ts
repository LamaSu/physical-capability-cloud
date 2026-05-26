/**
 * Receipt signer — HMAC-SHA256 over the canonical pre-CID body of an
 * InvocationReceipt.
 *
 * Phase 1 implements DCC1's HMAC receipt path: PCC holds an in-process
 * symmetric key and signs each receipt. The signature covers the canonical
 * JSON of the receipt MINUS receiptCID and pccSignature (those are
 * computed from the signed body, not part of it).
 *
 * Phase 2+ will additionally support Ed25519 signing for DCC2+ + Sigstore
 * referrer bundles for DCC3+. Keeping the surface narrow now means callers
 * don't have to migrate when those land.
 *
 * Key management Phase 1: read from PCC_AGGREGATOR_HMAC_KEY env var, fall
 * back to an ephemeral key generated at process start. Production deploys
 * MUST set the env var so receipts remain verifiable across restarts.
 *
 * See: ai/research/universal-tool-aggregator-2026-05-23.md §3.2 + §3.4
 */

import type { InvocationReceipt } from "@pcc/spec";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import type { AnchorOutcome, ReceiptAnchorClient } from "./receipt-anchor-client.js";

/** A symmetric receipt-signing key. */
export interface ReceiptSignerKey {
  /** Caller-visible key id (recorded as receipt.pccKeyId). */
  keyId: string;
  /** Raw HMAC secret. Hex-encoded for readability across logs. */
  secretHex: string;
}

/** Cached process-default key — created once, reused across receipts. */
let processDefaultKey: ReceiptSignerKey | null = null;

/**
 * Return the process-default signing key.
 *
 * Reads PCC_AGGREGATOR_HMAC_KEY (32-byte hex) if set; otherwise generates
 * an ephemeral key. The keyId is "pcc-agg-1" for env-provided keys and
 * "pcc-agg-eph-<8 hex>" for ephemerals so they're visually distinguishable
 * in audit logs.
 */
export function getDefaultSignerKey(): ReceiptSignerKey {
  if (processDefaultKey) return processDefaultKey;
  const envKey = process.env.PCC_AGGREGATOR_HMAC_KEY;
  if (envKey && /^[0-9a-fA-F]{64}$/.test(envKey)) {
    processDefaultKey = { keyId: "pcc-agg-1", secretHex: envKey.toLowerCase() };
    return processDefaultKey;
  }
  const bytes = randomBytes(32);
  const hex = bytesToHex(bytes);
  processDefaultKey = {
    keyId: `pcc-agg-eph-${hex.slice(0, 8)}`,
    secretHex: hex,
  };
  return processDefaultKey;
}

/**
 * Compute the canonical JSON body the signature covers.
 *
 * Order of operations:
 *   1. Strip pccSignature + receiptCID (they're computed AFTER signing).
 *   2. Sort keys alphabetically so the byte-for-byte canonical form is
 *      stable across implementations.
 *   3. Serialize.
 */
export function canonicalReceiptBody(
  receipt: Omit<InvocationReceipt, "pccSignature" | "receiptCID">,
): string {
  return JSON.stringify(sortKeysDeep(receipt));
}

/**
 * Sign a receipt (without pccSignature / receiptCID).
 *
 * Returns the augmented receipt with `pccSignature`, `pccKeyId`, and
 * `receiptCID` populated. `receiptCID` is sha256 over the FULL receipt
 * including pccSignature so the CID changes if any byte changes.
 */
export function signReceipt(
  body: Omit<InvocationReceipt, "pccSignature" | "receiptCID" | "pccKeyId">,
  key: ReceiptSignerKey = getDefaultSignerKey(),
): InvocationReceipt {
  const sigBody = canonicalReceiptBody({ ...body, pccKeyId: key.keyId });
  const secretBytes = hexToBytes(key.secretHex);
  const sigBytes = hmac(sha256, secretBytes, new TextEncoder().encode(sigBody));
  const pccSignature = bytesToHex(sigBytes);
  const signed: Omit<InvocationReceipt, "receiptCID"> = {
    ...body,
    pccKeyId: key.keyId,
    pccSignature,
  };
  const cidBytes = sha256(new TextEncoder().encode(JSON.stringify(sortKeysDeep(signed))));
  const receiptCID = `sha256:${bytesToHex(cidBytes)}` as InvocationReceipt["receiptCID"];
  return { ...signed, receiptCID };
}

/**
 * Verify a receipt's HMAC signature. Returns true iff:
 *   - the signature recomputes from the canonical body, AND
 *   - the receiptCID recomputes from the signed body.
 *
 * Does NOT validate semantic correctness (use evaluateReceipt from
 * @pcc/verifier for that).
 */
export function verifyReceiptSignature(
  receipt: InvocationReceipt,
  key: ReceiptSignerKey = getDefaultSignerKey(),
): boolean {
  const { pccSignature, receiptCID, ...rest } = receipt;
  const sigBody = canonicalReceiptBody(rest);
  const secretBytes = hexToBytes(key.secretHex);
  const expected = bytesToHex(
    hmac(sha256, secretBytes, new TextEncoder().encode(sigBody)),
  );
  if (expected !== pccSignature) return false;
  const cidExpected = `sha256:${bytesToHex(
    sha256(new TextEncoder().encode(JSON.stringify(sortKeysDeep({ ...rest, pccSignature })))),
  )}`;
  return cidExpected === receiptCID;
}

/**
 * Phase 2: sign-and-anchor in one call.
 *
 * Signs the receipt, then (if an anchor client is provided AND it's enabled)
 * routes the signed receipt to the on-chain anchor pipeline. Returns the
 * signed receipt plus the anchor outcome so the caller can surface the
 * anchorStatus to its response payload.
 *
 * If `anchor` is omitted (or its client is disabled), this behaves identically
 * to plain `signReceipt` — the caller still gets a usable signed receipt and
 * an `{ mode: "disabled" }` anchor outcome they can ignore.
 *
 * Anchor errors do NOT bubble: a single-anchor RPC failure is surfaced via
 * the `txHashPromise` on the outcome. The caller decides how to handle
 * `pending` -> `failed` transitions.
 */
export function signAndAnchorReceipt(
  body: Omit<InvocationReceipt, "pccSignature" | "receiptCID" | "pccKeyId">,
  options: {
    key?: ReceiptSignerKey;
    anchor?: ReceiptAnchorClient;
  } = {},
): { receipt: InvocationReceipt; anchor: AnchorOutcome } {
  const receipt = signReceipt(body, options.key);
  const anchor = options.anchor
    ? options.anchor.anchorReceipt(receipt)
    : ({ mode: "disabled" } as AnchorOutcome);
  return { receipt, anchor };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively sort object keys alphabetically for deterministic JSON. */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Odd-length hex string");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
