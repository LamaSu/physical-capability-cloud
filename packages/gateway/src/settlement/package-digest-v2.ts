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
 *   canonicalSignatures = refuse a malformed or duplicated set, then sort by signer
 *
 * The malleability closure matters because without it a relayer could reorder,
 * duplicate or re-case signatures and move the digest without changing a single
 * semantic fact, which would let the same evidence produce two different package
 * identities.
 *
 * THE PRODUCER REFUSES; IT DOES NOT REPAIR. The oracle's ingestion canonicalizes
 * the set by dedup-by-signer (first wins) and a lowercased sort (#1368, #1395),
 * and evidence's mirror (`settlement-vector-golden-mirror.cjs`) dedups the same
 * way but keeps each entry's own case. Those repairs close malleability on the
 * CONSUMING side. The producer refuses every input they would repair, so what it
 * emits has exactly one spelling:
 *   - a signer that is not 0x + lowercase hex: no lowercasing (F5, F6);
 *   - a duplicate signer, or a second signature in the same role: no dedup, so a
 *     forged duplicate placed ahead of the real entry cannot win "first wins";
 *   - an entry with any key but signer, scheme, sig, which would move the digest
 *     without changing a fact;
 *   - anything but exactly two entries.
 * The only repair left is the sort, so reordering is a no-op. On every input the
 * producer accepts, the oracle's dedup and lowercasing and the mirror's kept case
 * are no-ops, so producer, oracle and mirror agree.
 *
 * NOT ENFORCED HERE, because the published golden forbids it: the scheme NAMES
 * (secp256k1-eip712 for D1, ed25519-raw32 for D2) and the signer width per scheme.
 * `g2-settlement-vector-golden.json` is the mirror's SAMPLE vector, whose entries
 * are labelled "secp256k1" and "ed25519" (the latter with a 40-digit signer), and
 * its digest must stay byte-identical, so `packageDigestV2Unchecked` has to
 * accept it. `assertMintablePackage` enforces both, and a package that is not
 * mintable never becomes a digest bound to money (`mintablePackageDigest` is
 * the only digest function that takes its word for that, below).
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
 * agree. A validated package body is all strings (`validatePackageBody` refuses a
 * JS number in any scalar slot), so the divergence cannot be reached today. If the
 * schema ever carries a non-integer number, this must be re-confirmed against the
 * oracle before it is trusted, and `assertCanonicalizable` below, which runs on the
 * object about to be hashed, makes that failure loud instead of silent.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "@pcc/spec";
import {
  canonicalSignatures,
  validatePackageBody,
  MintablePackage,
  PackageNotMintableError,
} from "./final-milestone-package-v2.js";

// The signature entry type, its error and its canonicalization live in
// final-milestone-package-v2.ts, so that this module can call validatePackageBody
// without an import cycle. Importers keep importing them from here.
export { canonicalSignatures, InvalidSignatureEntryError } from "./final-milestone-package-v2.js";
export type { PackageSignature } from "./final-milestone-package-v2.js";
export { MintablePackage, PackageNotMintableError } from "./final-milestone-package-v2.js";

/** 0x-prefixed lowercase hex. */
export type Hex = `0x${string}`;

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

/**
 * Walk a value and reject anything the shared canonicalizer would serialize in
 * a way the oracle's canonicalizer might not reproduce byte-for-byte.
 *
 * Fails CLOSED. A money-path digest that two implementations disagree about is
 * worse than no digest at all.
 *
 * A validated package body is all strings, so this cannot fire on one today. It
 * stays as a tripwire on the object that is about to be hashed: if the body schema
 * ever gains a numeric field, the canonicalizer divergence is caught here instead
 * of at the oracle.
 */
export function assertCanonicalizable(value: unknown, path = "$"): void {
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
 *  visible pre-image is nearly impossible to debug across two codebases.
 *
 *  The body is validated FIRST (`validatePackageBody`) and only the validated copy
 *  is hashed: an unknown key, a JS number, a missing field, an empty id, or a hex
 *  field in any spelling but 0x + lowercase hex (an EIP-55 escrow address, say) is
 *  refused with a PackageBodyValidationError instead of becoming a digest. */
export function packageDigestV2PreImage(body: unknown, sigs: unknown): string {
  const valid = validatePackageBody(body);
  assertCanonicalizable(valid, "$.body");
  return canonicalize({
    body: valid,
    [SIGNATURES_KEY]: canonicalSignatures(sigs),
  });
}

/**
 * packageDigestV2Unchecked — SHA-256 over the canonical package, as
 * 0x-prefixed hex. The wire VALUE this computes is still "packageDigestV2" per
 * the oracle's contract (#1368/#1359); "Unchecked" names this IMPLEMENTATION,
 * which is the lenient, sample-compatible path — it accepts any conforming
 * body and any two-entry signature set `canonicalSignatures` accepts (foreign
 * scheme labels, a 40-digit "ed25519" signer, free-text principals), which is
 * exactly what lets it reproduce the published golden
 * (`g2-settlement-vector-golden.json`) byte for byte.
 *
 * NEVER FOR MONEY; VECTORS ONLY. The money-bound digest is
 * `mintablePackageDigest`, below, which only accepts a `MintablePackage` —
 * obtainable solely from `assertMintablePackage`. (F3, cross-family E9: before
 * this split, the lenient digest and the mint guard had no enforced seam —
 * nothing stopped this function from being called directly on a body/
 * signature set `assertMintablePackage` would have refused.)
 *
 * NOTE ON FRAMING: `@pcc/spec`'s `sha256()` returns a `sha256:<hex>`-PREFIXED
 * string, which is the evidence-bundle framing, NOT the on-chain bytes32
 * framing this digest needs. We therefore hash directly here and return
 * `0x<hex>`. Mixing those two framings would produce a value that looks right
 * in logs and fails every on-chain bind.
 */
export function packageDigestV2Unchecked(body: unknown, sigs: unknown): Hex {
  const preImage = packageDigestV2PreImage(body, sigs);
  const hex = createHash("sha256").update(preImage, "utf8").digest("hex");
  return `0x${hex}` as Hex;
}

/**
 * The ONLY money-bound digest (F3, cross-family E9). Takes a `MintablePackage`
 * — the branded, frozen result `assertMintablePackage` returns after verifying
 * D2's signature, the F2 registry binding and the F4 challenge freshness (and,
 * for now, D1's shape only — see the STOP note in `final-milestone-package-v2.ts`
 * above `MINT_SIGNER_PROFILE`) — and hashes it exactly as
 * `packageDigestV2Unchecked` would.
 *
 * A structural fake (`{body, signatures}` built by hand, not through the
 * guard) is never a `MintablePackage`: TypeScript refuses the assignment at
 * compile time (the class has a private field, so it is compared nominally),
 * and the `instanceof` check below refuses it at runtime too, so a caller
 * cannot route around the guard even with a type assertion.
 */
export function mintablePackageDigest(mintable: MintablePackage): Hex {
  if (!(mintable instanceof MintablePackage)) {
    throw new PackageNotMintableError(
      "$",
      "argument is not a MintablePackage produced by assertMintablePackage",
    );
  }
  return packageDigestV2Unchecked(mintable.body, mintable.signatures);
}
