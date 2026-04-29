/**
 * Kernel-side helpers for composing, signing, and verifying centralized
 * settlement receipts.
 *
 * The PCC server (gateway) is the canonical signer of a milestone receipt
 * — it owns the escrow ledger and is the entity whose key is anchored in
 * the daily Merkle root via Anchor.sol. Kernels are NOT expected to sign
 * receipts in the steady state.
 *
 * However, kernels still need to:
 *
 *   1. Compose a receipt payload from the milestone + evidence they
 *      produced, in a form that matches what the server will sign. This
 *      lets a kernel pre-compute the receipt hash for inclusion in its
 *      own evidence bundle, or for a multi-signer aggregation flow.
 *
 *   2. Verify a server-signed receipt that lands back at the kernel,
 *      confirming the gateway settled the milestone correctly.
 *
 *   3. Aggregate signatures from multiple kernels (e.g. multi-instrument
 *      orchestrations, where two kernels co-attest one milestone) into a
 *      single multi-signed receipt bundle.
 *
 * This module is a thin layer over `@pcc/transparency-log` — the heavy
 * lifting (canonicalization, schema validation, Ed25519 ops) lives in
 * that package. We only add kernel-shaped construction helpers and
 * multi-signer aggregation.
 */

import {
  ReceiptPayloadSchema,
  SignedReceiptSchema,
  canonicalize,
  payloadDigest,
  signReceipt,
  verifyReceipt,
  type ReceiptPayload,
  type SignedReceipt,
  type SettlementMode,
} from "@pcc/transparency-log";
import { z } from "zod";

// Re-export the workspace types so kernel SDK consumers don't have to
// pull `@pcc/transparency-log` directly.
export {
  ReceiptPayloadSchema,
  SignedReceiptSchema,
  canonicalize,
  payloadDigest,
  signReceipt,
  verifyReceipt,
};
export type { ReceiptPayload, SignedReceipt, SettlementMode };

// ── Compose ───────────────────────────────────────────────────────────

/**
 * Minimal milestone shape the kernel needs to compose a receipt. Kernel
 * consumers may have richer milestone objects; this is the projection
 * that ends up in the signed payload.
 */
export interface MilestoneInput {
  /** Stable id of the milestone being settled. */
  milestoneId: string;
  /** Capability id (or capability type slug) the milestone fulfilled. */
  capability: string;
  /**
   * Settlement amount in cents. Cents (vs floating-point dollars) keep
   * the canonical encoding deterministic.
   */
  amountCents: number;
  /**
   * Settlement mode this milestone is taking. Default "centralized" —
   * the kernel sees this if the gateway is using the centralized
   * substrate.
   */
  settlementMode?: SettlementMode;
}

/**
 * Evidence projection. The hash is what the on-chain MilestoneEscrow
 * already records as `evidenceBundleHash`; we re-use it here so the
 * receipt and on-chain log agree on the same evidence reference.
 */
export interface EvidenceInput {
  /** Hex-encoded SHA-256 of the canonical evidence bundle. */
  evidenceHash: string;
  /**
   * ISO-8601 UTC timestamp marking when the evidence was finalised
   * (typically the kernel's `bundle.timestamp`).
   */
  timestamp: string;
}

/**
 * Hashed actor identifiers. Hashing is the caller's responsibility —
 * raw email/wallet addresses must NEVER reach this struct. The
 * underlying schema enforces hex-only strings.
 */
export interface SignersInput {
  /** Hashed user (payer) identifier. */
  user: string;
  /** Hashed operator identifier. */
  operator: string;
}

/**
 * Compose a `ReceiptPayload` ready for signing.
 *
 * Determinism: same inputs always produce a payload that, when canonical-
 * ized, yields identical bytes — even if the caller's local objects
 * differ in key order. This is enforced at the canonicalize() layer.
 *
 * @throws if any field fails schema validation (e.g. raw email leaks
 *         past the actorsHashed contract).
 */
export function composeMilestoneReceipt(
  milestone: MilestoneInput,
  evidence: EvidenceInput,
  signers: SignersInput,
): ReceiptPayload {
  const payload: ReceiptPayload = {
    milestoneId: milestone.milestoneId,
    capability: milestone.capability,
    actorsHashed: {
      user: signers.user,
      operator: signers.operator,
    },
    amountCents: milestone.amountCents,
    evidenceHash: evidence.evidenceHash,
    timestamp: evidence.timestamp,
    settlementMode: milestone.settlementMode ?? "centralized",
  };
  // Validate eagerly so callers see the problem at compose time rather
  // than at sign time (where the error would point at canonicalize()).
  return ReceiptPayloadSchema.parse(payload);
}

// ── Server receipt verification ───────────────────────────────────────

/**
 * Result of `verifyServerReceipt`. The boolean is the headline answer;
 * `errors` lists every reason the receipt failed validation, so a kernel
 * can surface a useful diagnostic to the operator.
 */
export interface VerifyServerReceiptResult {
  ok: boolean;
  errors?: string[];
}

/**
 * Verify a server-signed receipt landed back at the kernel. Checks:
 *   - SignedReceipt schema (signature + signerPublicKey hex-shape).
 *   - Ed25519 signature against either an explicit expected key or the
 *     embedded one.
 *   - Expected gateway public key match (when supplied).
 *
 * When `expectedServerPublicKey` is omitted the receipt verifies as a
 * self-attesting bundle — only useful for tests / dev. Production
 * callers should always supply the gateway's known public key.
 *
 * @returns ok=true when ALL checks pass, otherwise ok=false with the
 *          collected `errors` array. Never throws on bad input.
 */
export function verifyServerReceipt(
  signed: unknown,
  expectedServerPublicKey?: Uint8Array | string,
): VerifyServerReceiptResult {
  const errors: string[] = [];

  // Schema check first — bail with a clear message if the JSON is malformed.
  const parsed = SignedReceiptSchema.safeParse(signed);
  if (!parsed.success) {
    errors.push(`signed-receipt schema failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return { ok: false, errors };
  }

  // Optional gateway-key match — done before signature so we can emit a
  // distinct error when the caller passes the wrong server.
  if (expectedServerPublicKey !== undefined) {
    const expectedHex =
      typeof expectedServerPublicKey === "string"
        ? expectedServerPublicKey.toLowerCase()
        : Array.from(expectedServerPublicKey)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    if (parsed.data.signerPublicKey.toLowerCase() !== expectedHex) {
      errors.push("signerPublicKey does not match expected server key");
      // Still continue: we want to report multiple errors at once when possible.
    }
  }

  // Signature itself.
  const sigOk = verifyReceipt(parsed.data, expectedServerPublicKey);
  if (!sigOk) {
    errors.push("Ed25519 signature verification failed");
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ── Multi-signer aggregation ──────────────────────────────────────────

/**
 * One signer's contribution to a multi-signed receipt. Each signer
 * signs the SAME canonical payload bytes — that's the property that
 * lets us aggregate into a single bundle without re-signing.
 */
export const ReceiptSignatureSchema = z.object({
  signature: z
    .string()
    .length(128)
    .regex(/^[0-9a-fA-F]+$/, "signature must be 64-byte hex (128 chars)"),
  signerPublicKey: z
    .string()
    .length(64)
    .regex(/^[0-9a-fA-F]+$/, "signerPublicKey must be 32-byte hex (64 chars)"),
});
export type ReceiptSignature = z.infer<typeof ReceiptSignatureSchema>;

/**
 * Multi-signer receipt bundle. Useful for orchestrations where multiple
 * kernels (or kernel + gateway) co-attest the same milestone. Every
 * signature is over the same canonical payload bytes — verifiers can
 * spot-check any one or require N-of-M.
 */
export const MultiSignedReceiptSchema = z.object({
  payload: ReceiptPayloadSchema,
  signatures: z.array(ReceiptSignatureSchema).min(1),
});
export type MultiSignedReceipt = z.infer<typeof MultiSignedReceiptSchema>;

/**
 * Aggregate two or more single-signer receipts (with identical payloads)
 * into a multi-signed bundle.
 *
 * @throws if the input receipts disagree on the payload bytes — the
 *         whole point of aggregation is that they agree.
 */
export function aggregateSignatures(receipts: SignedReceipt[]): MultiSignedReceipt {
  if (receipts.length === 0) {
    throw new Error("aggregateSignatures: at least one receipt required");
  }
  // All receipts must canonicalize to identical bytes; otherwise the
  // signers signed different things.
  const referenceBytes = canonicalize(receipts[0]!.payload);
  for (let i = 1; i < receipts.length; i++) {
    const bytes = canonicalize(receipts[i]!.payload);
    if (
      bytes.length !== referenceBytes.length ||
      !bytes.every((b, j) => b === referenceBytes[j])
    ) {
      throw new Error(
        `aggregateSignatures: payload bytes mismatch at receipt index ${i}; signers must agree on payload`,
      );
    }
  }
  return MultiSignedReceiptSchema.parse({
    payload: receipts[0]!.payload,
    signatures: receipts.map((r) => ({
      signature: r.signature,
      signerPublicKey: r.signerPublicKey,
    })),
  });
}

/**
 * Verify a multi-signed receipt. Every embedded signature must be valid
 * over the bundle's canonical payload.
 *
 * Optionally enforce N-of-M by supplying `requiredSigners` — only
 * receipts including at least one signature from each required key
 * count as verified.
 */
export function verifyMultiSignedReceipt(
  bundle: unknown,
  requiredSigners?: (Uint8Array | string)[],
): VerifyServerReceiptResult {
  const errors: string[] = [];
  const parsed = MultiSignedReceiptSchema.safeParse(bundle);
  if (!parsed.success) {
    errors.push(
      `multi-signed-receipt schema failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
    return { ok: false, errors };
  }
  const { payload, signatures } = parsed.data;

  for (let i = 0; i < signatures.length; i++) {
    const sig = signatures[i]!;
    const ok = verifyReceipt(
      {
        payload,
        signature: sig.signature,
        signerPublicKey: sig.signerPublicKey,
      },
      sig.signerPublicKey,
    );
    if (!ok) {
      errors.push(`signature[${i}] (signer ${sig.signerPublicKey.slice(0, 16)}...) failed verification`);
    }
  }

  if (requiredSigners && requiredSigners.length > 0) {
    const present = new Set(signatures.map((s) => s.signerPublicKey.toLowerCase()));
    for (const req of requiredSigners) {
      const reqHex =
        typeof req === "string"
          ? req.toLowerCase()
          : Array.from(req)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
      if (!present.has(reqHex)) {
        errors.push(`required signer ${reqHex.slice(0, 16)}... missing from bundle`);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
