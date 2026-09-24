/**
 * FinalMilestonePackageV2 — the PRODUCER side of the money-path evidence bind.
 *
 * G2 in the settlement seam. The oracle's ingestion binds
 * `raw.packageHash === packageDigestV2`, and the gateway receipt
 * (`settlement/gateway-receipt.ts`) binds `receipt.packageDigest` to the SAME
 * value as its anti-replay anchor. Both of those already exist and are tested;
 * until this module landed, nothing in the repo actually PRODUCED the value
 * they bind to.
 *
 * The contract (oracle #1368):
 *
 *   packageDigestV2 = SHA-256( JCS( { body, <sigsKey>: canonicalSignatures(sigs) } ) )
 *   canonicalSignatures = dedup-by-signer (FIRST wins) + sort by lowercased signerId
 *
 * The dedup+sort is the malleability closure: without it, a relayer could
 * reorder or duplicate signatures and move the digest without changing a single
 * semantic fact, which would let the same evidence produce two different
 * package identities.
 *
 * WHY THE CANONICALIZER IS IMPORTED, NOT HAND-ROLLED: `packages/spec`'s
 * `canonicalize` is already the repo's serializer for evidence events and
 * bundles, and it is already what capability-contract-identity.ts hashes. Two
 * independent JSON canonicalizers in one money path is how byte-level
 * disagreements are born.
 *
 * KNOWN DIVERGENCE FROM RFC 8785 (documented, not silently accepted): the
 * shared canonicalizer serializes numbers with `String(value)`, which is not
 * RFC 8785's number serialization. For integer and string payloads the two
 * agree. If a package body ever carries a non-integer number, this must be
 * re-confirmed against the oracle before it is trusted. `assertNoFloats` below
 * makes that failure loud instead of silent.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "@pcc/spec";

/** 0x-prefixed lowercase hex. */
export type Hex = `0x${string}`;

/**
 * One signature over a FinalMilestonePackage body.
 *
 * Shape is the ORACLE's (#1395, they own ingestion): `{signer, scheme, sig}`.
 * The signer SET is {operator, kernel} per evidence's frozen profile —
 * D1 = operator secp256k1-EIP712, D2 = kernel ed25519-raw32.
 *
 * `signer` is the dedup key AND the sort key AND is LOWERCASED in the canonical
 * form. Oracle #1395, verbatim: "Do NOT depend on case; changing a signer id's
 * case MUST be a no-op." Signer ids are EIP-55-checksummed addresses in some
 * paths and lowercase in others, so the same address in two spellings is ONE
 * signer; binding the spelling would make identical evidence produce two package
 * identities and fail the packageHash bind at first mint.
 */
export interface PackageSignature {
  signer: string;
  scheme: string;
  sig: string;
  [k: string]: unknown;
}

/** Raised when the body carries a value the canonicalizer cannot be trusted on. */
export class NonCanonicalizableBodyError extends Error {
  constructor(path: string, value: unknown) {
    super(
      `FinalMilestonePackageV2 body is not safely canonicalizable at ${path}: ` +
        `${String(value)}. The shared canonicalizer's number serialization is ` +
        `not RFC 8785 for non-integers; refusing to produce a digest the ` +
        `oracle may not reproduce.`,
    );
    this.name = "NonCanonicalizableBodyError";
  }
}

/** Raised when a signature entry cannot participate in the canonical order. */
export class InvalidSignatureEntryError extends Error {
  constructor(reason: string) {
    super(`Invalid FinalMilestonePackageV2 signature entry: ${reason}`);
    this.name = "InvalidSignatureEntryError";
  }
}

/**
 * Walk the body and reject anything the shared canonicalizer would serialize in
 * a way the oracle's canonicalizer might not reproduce byte-for-byte.
 *
 * Fails CLOSED. A money-path digest that two implementations disagree about is
 * worse than no digest at all.
 */
function assertCanonicalizable(value: unknown, path = "$"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new NonCanonicalizableBodyError(path, value);
    }
    return;
  }
  if (typeof value === "bigint") {
    // bigint would stringify via String() and lose its JSON identity.
    throw new NonCanonicalizableBodyError(path, value);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertCanonicalizable(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertCanonicalizable(v, `${path}.${k}`);
    }
    return;
  }
  throw new NonCanonicalizableBodyError(path, value);
}

/**
 * The malleability closure: dedup by signer (FIRST occurrence wins), then sort
 * by lowercased signerId.
 *
 * Pure — never mutates the caller's array. Returns a new array.
 */
export function canonicalSignatures(
  sigs: readonly PackageSignature[],
): PackageSignature[] {
  if (!Array.isArray(sigs)) {
    throw new InvalidSignatureEntryError("signatures must be an array");
  }

  const seen = new Set<string>();
  const kept: PackageSignature[] = [];

  for (const s of sigs) {
    if (s === null || typeof s !== "object") {
      throw new InvalidSignatureEntryError("entry is not an object");
    }
    if (typeof s.signer !== "string" || s.signer.length === 0) {
      throw new InvalidSignatureEntryError("signer must be a non-empty string");
    }
    const key = s.signer.toLowerCase();
    if (seen.has(key)) continue; // FIRST wins — later duplicates are dropped
    seen.add(key);
    // NORMALIZE the emitted signer to the same lowercased form used for dedup
    // and sorting. Without this the digest would depend on the SPELLING of an
    // address, so the identical package assembled by two services could hash
    // differently — the case-insensitivity the oracle requires (#1395).
    kept.push({ ...s, signer: key });
  }

  // Sort by the SAME lowercased key used for dedup and emission, so no two of
  // the three operations can disagree about signer identity.
  return kept.sort((a, b) =>
    a.signer < b.signer ? -1 : a.signer > b.signer ? 1 : 0,
  );
}

/**
 * The key under which canonical signatures are nested in the hashed object.
 *
 * OPEN QUESTION — asked of the oracle on the bus. Their contract was written as
 * `SHA-256(JCS({body, canonicalSignatures(sigs)}))`, which is shorthand and does
 * not state the literal key name. The key name changes the digest completely, so
 * it is a named constant here rather than an inline string: when the oracle
 * confirms the wire name, exactly one line changes and the golden test re-runs.
 */
export const SIGNATURES_KEY = "signatures" as const;

/** The exact object that gets canonicalized. Exported so tests and the oracle
 *  can diff the PRE-IMAGE, not just the digest — a digest mismatch with no
 *  visible pre-image is nearly impossible to debug across two codebases. */
export function packageDigestV2PreImage(
  body: unknown,
  sigs: readonly PackageSignature[],
): string {
  assertCanonicalizable(body, "$.body");
  return canonicalize({
    body,
    [SIGNATURES_KEY]: canonicalSignatures(sigs),
  });
}

/**
 * packageDigestV2 — SHA-256 over the canonical package, as 0x-prefixed hex.
 *
 * NOTE ON FRAMING: `@pcc/spec`'s `sha256()` returns a `sha256:<hex>`-PREFIXED
 * string, which is the evidence-bundle framing, NOT the on-chain bytes32
 * framing this digest needs. We therefore hash directly here and return
 * `0x<hex>`. Mixing those two framings would produce a value that looks right
 * in logs and fails every on-chain bind.
 */
export function packageDigestV2(
  body: unknown,
  sigs: readonly PackageSignature[],
): Hex {
  const preImage = packageDigestV2PreImage(body, sigs);
  const hex = createHash("sha256").update(preImage, "utf8").digest("hex");
  return `0x${hex}` as Hex;
}
