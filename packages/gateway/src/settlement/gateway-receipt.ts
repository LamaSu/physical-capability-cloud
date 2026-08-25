/**
 * GatewayReceiptV1 — the gateway's SIGNED `receivedAt` attestation.
 *
 * The gateway stamps the authoritative receipt time when an evidence package
 * arrives and signs it out-of-band. The oracle recomputes this digest from the
 * receipt fields, verifies the signature, and only then trusts `receivedAt` as
 * the effectiveEvidenceTime UPPER bound (T_hi) — so the oracle never depends on
 * a self-declared device clock.
 *
 * ── OWNERSHIP ────────────────────────────────────────────────────────
 * The ORACLE owns this encoding (it is the oracle's verify input, published at
 * pcc-oracle `src/gateway-receipt.ts` @ 1738586, coord #703). The gateway BUILDS
 * TO IT — gateway #700 asked for the exact struct rather than inventing one, so
 * there is a single definition and no drift. Do not "improve" the field order,
 * the types, or the domain string here; any change must come from the oracle and
 * be re-goldened on both sides.
 *
 * ── CROSS-CONFIRMED ──────────────────────────────────────────────────
 * Verified byte-exact against oracle's published golden (#703) before this file
 * was written, using the same publish→cross-confirm loop that closed termsHash,
 * FinalMilestonePackageV2 and acceptedPolicyDigest:
 *   domain        keccak256("PCC:vnext:gateway-receipt:v1")
 *                 = 0xc6ba37cf35ac305d82792d994f57aaeca940fad501e197ab9057214ff4d67699
 *   receiptDigest = 0xe805d61778bd424deaf8cb7a47240e9982289017e977e4ad45e085280e6e223e
 * Negative parity also confirmed: mutating ANY of the five fields moves the
 * digest, so every field is genuinely bound.
 *
 * ── WHY packageDigest IS IN THE PREIMAGE ─────────────────────────────
 * It binds the receipt to THIS evidence. Without it a receipt would attest only
 * "unit U was received at time T" and could be REPLAYED onto a different package
 * for the same unit. With it, the receipt says "the gateway received THIS
 * package for THIS unit at THIS time".
 *
 * ── INTERIM SEMANTICS — READ THIS BEFORE RELYING ON IT ───────────────
 * This is increment (b) of oracle #654. It provides T_hi ONLY. The
 * anti-backdating lower bound T_lo comes from the per-unit challenge, increment
 * (a), which is NOT shipped here: it requires DURABLE, DB-backed, single-use,
 * expiring per-unit challenge storage. It must NOT reuse the SIWE in-memory
 * nonce Map (`auth/siwe-auth.ts:26`, "ephemeral, no DB persistence needed") —
 * that store is correct for a seconds-long login round-trip but would silently
 * forget every outstanding challenge across a redeploy, and a backdating defence
 * that evaporates on restart is worse than none because it is believed.
 *
 * Until (a) lands the oracle evaluates revocation at the SINGLE POINT
 * `receivedAt` — strictly safe (rejects any key revoked before receipt) at a
 * liveness cost (rejects some legitimate late submissions). That is the oracle's
 * knowing decision as signing-gate owner (#703), stated in the verdict semantics.
 */

import { keccak256, encodeAbiParameters, toBytes, getAddress, type Hex } from "viem";
import { signWithPrivateKeyHex } from "../auth/ed25519.js";

/** keccak256("PCC:vnext:gateway-receipt:v1") — oracle-owned, cross-confirmed. */
export const GATEWAY_RECEIPT_DOMAIN: Hex =
  "0xc6ba37cf35ac305d82792d994f57aaeca940fad501e197ab9057214ff4d67699";

/** uint16 schema version. */
export const GATEWAY_RECEIPT_VERSION = 1;

export interface GatewayReceipt {
  chainId: number;
  escrow: Hex;
  settlementUnitId: Hex;
  /** The FinalMilestonePackageV2 digest received — binds the receipt to THIS evidence. */
  packageDigest: Hex;
  /** uint64 — the gateway's trusted-clock receipt time (Unix seconds). */
  receivedAt: number;
}

/**
 * Recompute the domain from its preimage. Used by the test to prove the pinned
 * constant above is not a transcription error — a mistyped constant would
 * otherwise produce a self-consistent but oracle-incompatible signature.
 */
export function computeGatewayReceiptDomain(): Hex {
  return keccak256(toBytes("PCC:vnext:gateway-receipt:v1"));
}

/**
 * receiptDigest = keccak256(abi.encode(
 *   GATEWAY_RECEIPT_DOMAIN, uint16 v, uint256 chainId, address escrow,
 *   bytes32 settlementUnitId, bytes32 packageDigest, uint64 receivedAt))
 *
 * Field order and widths are the oracle's; they are load-bearing. `abi.encode`
 * (32-byte padded), NOT `encodePacked`.
 */
export function computeGatewayReceiptDigest(r: GatewayReceipt): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint16" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint64" },
      ],
      [
        GATEWAY_RECEIPT_DOMAIN,
        GATEWAY_RECEIPT_VERSION,
        BigInt(r.chainId),
        // NORMALISE ADDRESS CASE BEFORE ENCODING.
        // viem's `address` encoder enforces EIP-55 checksum and REJECTS a
        // mixed-case address that is not correctly checksummed; oracle's
        // ethers-based reference module does not. The published golden escrow
        // is written 0x...0E5C0F, which is NOT its EIP-55 form, so viem threw
        // InvalidAddressError in CI while my ethers-based cross-confirm script
        // accepted it — I verified the algorithm in one library and shipped it
        // in another. The encoded bytes are identical either way (an address is
        // 20 bytes; case is only a checksum representation), so normalising
        // keeps the digest byte-equal to oracle's while accepting any case.
        getAddress(r.escrow.toLowerCase() as Hex),
        r.settlementUnitId,
        r.packageDigest,
        BigInt(r.receivedAt),
      ],
    ),
  );
}

export interface SignedGatewayReceipt {
  receipt: GatewayReceipt;
  receiptDigest: Hex;
  /** ed25519 signature over the 32 digest BYTES (not over its hex text). */
  signature: string;
  /** The gateway public key the oracle verifies against. */
  publicKey: string;
}

/**
 * Signs the raw 32 digest bytes and returns hex. Returns null if it cannot sign.
 */
export type ReceiptSigner = (digestBytes: Uint8Array) => string | null;

export class ReceiptSigningUnavailableError extends Error {
  constructor() {
    super("gateway receipt signer is not configured or failed to sign");
    this.name = "ReceiptSigningUnavailableError";
  }
}

/**
 * Stamp + sign a receipt.
 *
 * ── KEY CUSTODY IS AN OPEN DECISION, DELIBERATELY NOT GUESSED ────────
 * The signer is INJECTED rather than resolved in here, because neither existing
 * gateway primitive is a correct fit and quietly picking one would bury a real
 * decision:
 *   - `auth/ed25519.ts#signWithPrivateKeyHex` is documented "Test/CLI helper
 *     only — the gateway itself never holds long-lived agent private keys". It
 *     is fine for tests and wrong as a money-path production signer.
 *   - `signing-key.ts` holds the A2A AGENT-CARD key
 *     (`PCC_AGENT_CARD_SIGNING_KEY`). Different audience, different rotation
 *     lifecycle; reusing it would silently couple receipt validity to agent-card
 *     key rotation, so an unrelated card rotation would invalidate receipts the
 *     oracle is mid-verifying.
 * So: which key signs gateway receipts, and how it rotates, needs an owner.
 * Until that lands, callers inject; the digest above is already final and
 * cross-confirmed, so nothing downstream is blocked on the custody choice.
 *
 * `receivedAt` is the GATEWAY's clock and must NEVER be taken from the request
 * body — replacing a self-declared time with a trusted one is the entire point.
 * It is a parameter so tests can inject it, but ingestion callers MUST pass
 * their own clock value and never a client-supplied field.
 */
export function signGatewayReceipt(
  receipt: GatewayReceipt,
  signer: ReceiptSigner,
  publicKey: string,
): SignedGatewayReceipt {
  const receiptDigest = computeGatewayReceiptDigest(receipt);
  // Sign the raw 32 bytes, not the "0x…" string, so both sides sign the same
  // preimage regardless of hex casing.
  const signature = signer(toBytes(receiptDigest));
  // Fail closed: an unsigned receipt is worthless to the oracle, and returning
  // one with an empty signature would let it travel and fail confusingly later.
  if (!signature) throw new ReceiptSigningUnavailableError();
  return { receipt, receiptDigest, signature, publicKey };
}

/**
 * Dev/test signer adapter over the raw-seed helper. NOT for production use —
 * see the custody note on `signGatewayReceipt`.
 */
export function devSignerFromPrivateKeyHex(privateKeyHex: string): ReceiptSigner {
  return (digestBytes) => signWithPrivateKeyHex(privateKeyHex, Buffer.from(digestBytes));
}
