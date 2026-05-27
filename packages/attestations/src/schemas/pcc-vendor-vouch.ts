/**
 * PCC Vendor Vouch schema — a vendor attests confidence in another vendor,
 * with an optional free-text note. Forms a peer-to-peer reputation web
 * orthogonal to the centralized assurance tier system.
 *
 * Use cases:
 *  - "I've integrated with this vendor 5 times, no incidents" (high confidence)
 *  - "Met the team at a conference, seemed legitimate" (low confidence)
 *  - "Confirmed shipping address matches their LLC registration" (medium)
 *
 * Schema fields:
 *   - voucher: address (the attester themselves; included for analytics)
 *   - vouched: address (the vendor being vouched for)
 *   - confidence: uint8 (0..100, the voucher's self-rated confidence)
 *   - note: string (free-text rationale)
 */

import { computeSchemaUID } from "../schema-registry.js";
import { ZERO_ADDRESS } from "../constants.js";

export const PCC_VENDOR_VOUCH_SCHEMA =
  "address voucher,address vouched,uint8 confidence,string note";

export const PCC_VENDOR_VOUCH_SCHEMA_UID = computeSchemaUID(
  PCC_VENDOR_VOUCH_SCHEMA,
  ZERO_ADDRESS,
  true,
);

export interface PCCVendorVouchData {
  voucher: `0x${string}`;
  vouched: `0x${string}`;
  /** Voucher's self-rated confidence, 0..100 */
  confidence: number;
  /** Free-text note (can be empty) */
  note: string;
}

export function toPCCVendorVouchFields(
  data: PCCVendorVouchData,
): Record<string, unknown> {
  if (data.confidence < 0 || data.confidence > 100) {
    throw new Error(`Confidence must be 0..100, got ${data.confidence}`);
  }
  if (data.voucher.toLowerCase() === data.vouched.toLowerCase()) {
    throw new Error("Self-vouching is not allowed (voucher === vouched)");
  }
  if (data.vouched.toLowerCase() === ZERO_ADDRESS) {
    throw new Error("Cannot vouch for the zero address");
  }
  return {
    voucher: data.voucher,
    vouched: data.vouched,
    confidence: data.confidence,
    note: data.note,
  };
}
