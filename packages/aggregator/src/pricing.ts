/**
 * Pricing helpers for x402 gating.
 *
 * Converts between human-readable USDC decimal strings (as carried on
 * `IndexedTool.pricing.perCallUsdc`) and atomic (6-decimal) string units
 * that x402 protocol payloads expect.
 *
 * Also provides an HMAC "price tag" that the gateway embeds in the
 * `extra` field of every 402 PAYMENT-REQUIRED payload, so the client's
 * retry can be verified to be paying the same price the gateway quoted
 * (defense against price-tampering and pricing-change races between the
 * 402 and the retry — see scope §6.2 + §8.7).
 *
 * Pure functions only — no I/O, no network.
 */

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/** USDC has 6 decimals on every supported chain. */
const USDC_DECIMALS = 6;
const USDC_UNIT = 10 ** USDC_DECIMALS;

/**
 * Convert a decimal USDC string to atomic units.
 *
 * `"0.001"` → `"1000"`, `"1.5"` → `"1500000"`, `"0"` → `"0"`.
 *
 * Returns `"0"` for invalid / negative / non-finite input so the caller
 * can treat unparseable pricing as "free" and bypass the gate.
 */
export function toAtomicUsdc(decimal: string | undefined | null): string {
  if (decimal == null) return "0";
  const trimmed = String(decimal).trim();
  if (trimmed === "") return "0";
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return "0";
  // Math.round avoids the 0.1 + 0.2 floating-point trap for typical USDC
  // pricing strings (which top out at ~$10/call in any realistic scenario).
  return Math.round(n * USDC_UNIT).toString();
}

/**
 * Convert an atomic USDC string back to a 6-decimal-place decimal string.
 *
 * `"1000"` → `"0.001"`, `"1500000"` → `"1.5"`, `"0"` → `"0"`.
 *
 * Used to populate `InvocationReceipt.pricePaidUsdc` after settle.
 */
export function decimalUsdc(atomic: string | undefined | null): string {
  if (atomic == null) return "0";
  const trimmed = String(atomic).trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return "0";
  const n = BigInt(trimmed);
  if (n === 0n) return "0";
  const unit = BigInt(USDC_UNIT);
  const whole = n / unit;
  const frac = n % unit;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

/**
 * Is the given decimal pricing string considered "paid"?
 *
 * Anything that parses to a positive number is paid. Anything else
 * (undefined, "", "0", "0.00", garbage) is free.
 */
export function isPaidPrice(decimal: string | undefined | null): boolean {
  if (decimal == null) return false;
  const n = Number(String(decimal).trim());
  return Number.isFinite(n) && n > 0;
}

/**
 * Fields covered by a price tag HMAC. Canonical key ordering is
 * enforced inside `priceTagHmac` so callers don't need to worry about
 * the field order they pass in.
 */
export interface PriceTagFields {
  toolId: string;
  amount: string; // atomic units
  network: string; // CAIP-2
  payTo: string;
  /** Unix-seconds (string) after which this tag is no longer accepted. */
  validUntil: string;
}

/**
 * Compute an HMAC over the price-tag fields.
 *
 * Output is 32-byte hex (sha256 truncation isn't applied — the full
 * digest is returned for collision-resistance). Caller must use the
 * same `secretHex` for verify.
 */
export function priceTagHmac(
  fields: PriceTagFields,
  secretHex: string,
): string {
  const canonical = canonicalPriceTagBytes(fields);
  const secret = hexToBytes(secretHex);
  const tagBytes = hmac(sha256, secret, canonical);
  return bytesToHex(tagBytes);
}

/**
 * Verify a price tag against the fields it claims to cover.
 *
 * Returns false if:
 *   - the HMAC doesn't match, OR
 *   - the tag has expired (`validUntil < nowSec`).
 *
 * `nowSec` defaults to current process time; tests can pass an explicit
 * value for determinism.
 */
export function verifyPriceTag(
  tag: string,
  fields: PriceTagFields,
  secretHex: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const validUntilNum = Number(fields.validUntil);
  if (!Number.isFinite(validUntilNum)) return false;
  if (validUntilNum < nowSec) return false;
  const expected = priceTagHmac(fields, secretHex);
  return constantTimeEqual(expected, tag);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalPriceTagBytes(fields: PriceTagFields): Uint8Array {
  // Sort keys alphabetically for stable byte-for-byte canonicalization.
  // Plain JSON with sorted keys is sufficient — no separators / spaces.
  const sorted = {
    amount: fields.amount,
    network: fields.network,
    payTo: fields.payTo.toLowerCase(),
    toolId: fields.toolId,
    validUntil: fields.validUntil,
  };
  return new TextEncoder().encode(JSON.stringify(sorted));
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

/** Constant-time string comparison (avoids leaking length via early exit). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
