/**
 * FinalMilestonePackageV2 — the typed body and `packageBodyHash` (G2, Step B).
 *
 * Wire contract owner: EVIDENCE `c25c8f97`, pinned at
 * `~/.claude/shared/vnext-finalmilestonepackage-v2-body-schema.md` (2026-08-26,
 * answering gateway #1148). Signer set RATIFIED D1/D2 by sol. Ingestion binds
 * are the ORACLE's (#1359, 914/914).
 *
 * This module owns the BODY and the SIGNING pre-image. `package-digest-v2.ts`
 * owns `packageDigestV2` — the digest over `{body, canonicalSignatures(sigs)}`.
 * They are DIFFERENT hashes with different pre-images and it matters:
 *
 *   packageBodyHash  = SHA-256( raw32(SIG_DOMAIN_V2) ‖ u64be(len) ‖ JCS(body) )
 *                      ^ what the OPERATOR and KERNEL sign
 *   packageDigestV2  = SHA-256( JCS({body, signatures}) )
 *                      ^ what `raw.packageHash` must equal, and what the
 *                        gateway receipt binds as its anti-replay anchor
 *
 * Signing the wrong one of those produces signatures that verify against
 * nothing, at mint time, with real money in the escrow.
 *
 * WHY EVERY SCALAR IS A STRING: evidence's schema specifies decimal strings for
 * all numbers, language-independent under JCS. That is not cosmetic — `chainId`
 * and `milestoneIndex` ride alongside uint256-derived values, and JS numbers
 * silently lose precision above 2^53. Strings also sidestep the fact that the
 * shared canonicalizer's number serialization is not RFC 8785. The validator
 * below REFUSES a JS number in any scalar slot rather than coercing it.
 */

import { createHash } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { canonicalize } from "@pcc/spec";

export type Hex = `0x${string}`;

/** keccak256("PCC:vnext:evidence-package-sig:v2") — evidence schema §3. */
export const SIG_DOMAIN_V2: Hex = keccak256(
  toBytes("PCC:vnext:evidence-package-sig:v2"),
);

/** Fixed literals from the schema. Any drift here is a wire break. */
export const PACKAGE_SCHEMA_VERSION = "FinalMilestonePackageV2" as const;
export const PACKAGE_FORMAT = "2" as const;

/** The 8 fields that bind a package to exactly one settlement unit. */
export interface UnitBinding {
  chainId: string;
  escrow: Hex;
  settlementUnitId: Hex;
  jobIdHash: Hex;
  milestoneIndex: string;
  stepId: Hex;
  compositionRoot: Hex;
  /** == the FUNDED acceptedPolicyDigest (PolicyIdentity idx6). */
  acceptedEnvelopeHash: Hex;
}

export interface FinalMilestonePackageV2Body {
  packageSchemaVersion: typeof PACKAGE_SCHEMA_VERSION;
  packageFormat: typeof PACKAGE_FORMAT;
  /** MUST equal the outer commitment version — the oracle checks equality. */
  compositionSchemaVersion: string;
  unitBinding: UnitBinding;
  producer: {
    operatorPrincipalId: string;
    kernelId: string;
    devicePrincipalId: string;
  };
  challengeBinding: {
    /** Gateway-ISSUED at runtime. See INTERIM note on `isInterimNonce`. */
    nonce: Hex;
    tChallengeRef: string;
  };
  evidence: {
    /** EvidenceBlockV2 — one commitment to the 6 evaluator inputs. */
    evidenceBlockHash: Hex;
  };
  /** CLAIMED-ONLY. May narrow [T_lo,T_hi], never widen. NEVER gates authz. */
  evidenceTimeBounds: { start: string; end: string };
}

export class PackageBodyValidationError extends Error {
  constructor(path: string, detail: string) {
    super(`FinalMilestonePackageV2 body invalid at ${path}: ${detail}`);
    this.name = "PackageBodyValidationError";
  }
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function str(v: unknown, path: string): string {
  if (typeof v !== "string") {
    throw new PackageBodyValidationError(
      path,
      `expected a string, got ${typeof v}. All scalars are strings in this ` +
        `schema — a JS number here would be a precision and canonicalization bug.`,
    );
  }
  return v;
}
function hex32(v: unknown, path: string): Hex {
  const s = str(v, path);
  if (!HEX32.test(s)) throw new PackageBodyValidationError(path, `expected 0x+64hex, got "${s}"`);
  return s as Hex;
}
function addr(v: unknown, path: string): Hex {
  const s = str(v, path);
  if (!ADDR.test(s)) throw new PackageBodyValidationError(path, `expected 0x+40hex address, got "${s}"`);
  return s as Hex;
}
function dec(v: unknown, path: string): string {
  const s = str(v, path);
  if (!DECIMAL.test(s)) {
    throw new PackageBodyValidationError(
      path,
      `expected a decimal string (no sign, no leading zero, no exponent), got "${s}"`,
    );
  }
  return s;
}
function obj(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new PackageBodyValidationError(path, "expected an object");
  }
  return v as Record<string, unknown>;
}

/**
 * Validate a body against evidence's pinned schema and return it typed.
 *
 * FAILS CLOSED on every deviation. A body that is wrong in a way we tolerate
 * here becomes a digest the oracle cannot reproduce, discovered at mint.
 */
export function validatePackageBody(input: unknown): FinalMilestonePackageV2Body {
  const b = obj(input, "$");

  if (b.packageSchemaVersion !== PACKAGE_SCHEMA_VERSION) {
    throw new PackageBodyValidationError(
      "$.packageSchemaVersion",
      `must be the literal "${PACKAGE_SCHEMA_VERSION}"`,
    );
  }
  if (b.packageFormat !== PACKAGE_FORMAT) {
    throw new PackageBodyValidationError(
      "$.packageFormat",
      `must be the literal "${PACKAGE_FORMAT}" (V1 was "1"; the formats are not interchangeable)`,
    );
  }

  const ub = obj(b.unitBinding, "$.unitBinding");
  const pr = obj(b.producer, "$.producer");
  const cb = obj(b.challengeBinding, "$.challengeBinding");
  const ev = obj(b.evidence, "$.evidence");
  const tb = obj(b.evidenceTimeBounds, "$.evidenceTimeBounds");

  return {
    packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
    packageFormat: PACKAGE_FORMAT,
    compositionSchemaVersion: dec(b.compositionSchemaVersion, "$.compositionSchemaVersion"),
    unitBinding: {
      chainId: dec(ub.chainId, "$.unitBinding.chainId"),
      escrow: addr(ub.escrow, "$.unitBinding.escrow"),
      settlementUnitId: hex32(ub.settlementUnitId, "$.unitBinding.settlementUnitId"),
      jobIdHash: hex32(ub.jobIdHash, "$.unitBinding.jobIdHash"),
      milestoneIndex: dec(ub.milestoneIndex, "$.unitBinding.milestoneIndex"),
      stepId: hex32(ub.stepId, "$.unitBinding.stepId"),
      compositionRoot: hex32(ub.compositionRoot, "$.unitBinding.compositionRoot"),
      acceptedEnvelopeHash: hex32(ub.acceptedEnvelopeHash, "$.unitBinding.acceptedEnvelopeHash"),
    },
    producer: {
      operatorPrincipalId: str(pr.operatorPrincipalId, "$.producer.operatorPrincipalId"),
      kernelId: str(pr.kernelId, "$.producer.kernelId"),
      devicePrincipalId: str(pr.devicePrincipalId, "$.producer.devicePrincipalId"),
    },
    challengeBinding: {
      nonce: hex32(cb.nonce, "$.challengeBinding.nonce"),
      tChallengeRef: str(cb.tChallengeRef, "$.challengeBinding.tChallengeRef"),
    },
    evidence: {
      evidenceBlockHash: hex32(ev.evidenceBlockHash, "$.evidence.evidenceBlockHash"),
    },
    evidenceTimeBounds: {
      start: str(tb.start, "$.evidenceTimeBounds.start"),
      end: str(tb.end, "$.evidenceTimeBounds.end"),
    },
  };
}

/** 8-byte big-endian length prefix. */
function u64be(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/**
 * packageBodyHash — the pre-image the OPERATOR (secp256k1-eip712) and the
 * KERNEL (ed25519-raw32) sign. Evidence schema §3:
 *
 *   SHA-256( raw32(SIG_DOMAIN_V2) ‖ u64be(len(JCS(body))) ‖ JCS(body) )
 *
 * The length prefix is what makes the domain-separated concatenation
 * unambiguous: without it, a crafted body could shift bytes across the
 * boundary and collide with a different (domain, body) pair.
 *
 * `len` is the BYTE length of the UTF-8 JCS encoding, not the JS string length —
 * these differ for any non-ASCII character, and a producer that used `.length`
 * would agree with the oracle on ASCII-only bodies and diverge silently the
 * first time a principalId carried an accent.
 */
export function computePackageBodyHash(body: FinalMilestonePackageV2Body): Hex {
  const jcs = canonicalize(body);
  const jcsBytes = Buffer.from(jcs, "utf8");
  const preImage = Buffer.concat([
    Buffer.from(toBytes(SIG_DOMAIN_V2)), // raw 32 bytes, NOT the hex string
    u64be(jcsBytes.length),
    jcsBytes,
  ]);
  return `0x${createHash("sha256").update(preImage).digest("hex")}` as Hex;
}

/** The JCS pre-image, exposed so a cross-codebase mismatch is diffable. */
export function packageBodyJcs(body: FinalMilestonePackageV2Body): string {
  return canonicalize(body);
}

/**
 * Is this package's challenge nonce the known INTERIM placeholder?
 *
 * Evidence schema §4, open item: `challengeBinding.nonce` is gateway-issued and
 * rides the durable T_lo challenge, which is the gateway's SECOND increment and
 * IS NOT BUILT. Until it ships, `effectiveEvidenceTime` is T_hi-only (the
 * gateway's `receivedAt`) and the nonce is a placeholder.
 *
 * This predicate exists so that fact is queryable in code rather than living
 * only in a doc — a launch checklist that cannot be evaluated programmatically
 * is a launch checklist that gets skipped.
 */
export const INTERIM_NONCE: Hex = `0x${"00".repeat(32)}` as Hex;
export function isInterimNonce(body: FinalMilestonePackageV2Body): boolean {
  return body.challengeBinding.nonce.toLowerCase() === INTERIM_NONCE;
}
