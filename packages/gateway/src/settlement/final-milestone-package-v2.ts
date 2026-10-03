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
import {
  canonicalize,
  devicePrincipalMatchesSigner,
  isValidKernelId,
  operatorPrincipalMatchesSigner,
  principalFromRegistry,
} from "@pcc/spec";
import { verifyEd25519Signature } from "../auth/ed25519.js";

export type Hex = `0x${string}`;

/**
 * keccak256("PCC:vnext:evidence-package-sig:v1") = 0x74101076…5685 — evidence
 * schema §3.
 *
 * The suffix is `:v1` on purpose. The "V2" in the name is the raw32 FRAMING
 * (raw32(domain) ‖ u64be(byteLen) ‖ JCS(body)), not the domain suffix. This
 * constant previously hashed ":v2" (0x1e98b1f8…), copied from an evidence
 * golden that had drifted; evidence #1202 / oracle #1414 corrected the wire
 * contract to ":v1". The operator and the kernel sign packageBodyHash, so a
 * producer on ":v2" yields signatures that verify against nothing. The golden
 * test pins the value, not just its shape.
 */
export const SIG_DOMAIN_V2: Hex = keccak256(
  toBytes("PCC:vnext:evidence-package-sig:v1"),
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

// Lowercase only, by REJECTION. Hex case carries no meaning, but it changes the
// canonical bytes, so an EIP-55 checksummed escrow would otherwise produce a
// different packageBodyHash and packageDigestV2 for the same unit. One accepted
// spelling means one digest: a body in any other spelling is refused here with a
// PackageBodyValidationError, never lowercased for the caller, and every hashing
// function (computePackageBodyHash, packageBodyJcs, packageDigestV2) validates
// first. A caller that holds an EIP-55 address lowercases it before it builds
// the body.
const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;
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
function nonEmpty(v: unknown, path: string): string {
  const s = str(v, path);
  if (s.length === 0) throw new PackageBodyValidationError(path, "must not be empty");
  return s;
}
/**
 * Is `s` well-formed UTF-16 (no lone surrogate)? A lone surrogate survives
 * `JSON.stringify` (the shared canonicalizer's string leaf, `util/canonical.ts`)
 * as a `\uXXXX` escape, so the public producer can hash it — but the private
 * Oracle's `jcs()` refuses it (F5, cross-family E9: evidence schema docs §3 vs
 * oracle `oracle-verdict.ts:215-219`). A body that hashes on one side and is
 * refused on the other is a producer bug, not an Oracle bug: refuse it here,
 * before hashing, not after a mint fails downstream.
 */
function isWellFormedUnicode(s: string): boolean {
  const withNativeCheck = s as unknown as { isWellFormed?: () => boolean };
  if (typeof withNativeCheck.isWellFormed === "function") return withNativeCheck.isWellFormed();
  // Fallback for a runtime without String.prototype.isWellFormed (Node < 20):
  // a lone surrogate is a high surrogate not followed by a low one, or a low
  // surrogate not preceded by a high one.
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}
/**
 * A free-text field (`operatorPrincipalId`, `devicePrincipalId`,
 * `tChallengeRef`): non-empty, like every other id, AND well-formed Unicode
 * (F5). The two principal ids and the kernel id are ASCII-restricted
 * elsewhere (`isValidKernelId` here; `parseOperatorPrincipalId` /
 * `parseDevicePrincipalId` at mint time), but at THIS layer
 * `operatorPrincipalId` / `devicePrincipalId` must still accept the golden's
 * free-text sample values ("op-golden"), so this is the one check standing
 * between a lone surrogate and a hash the Oracle cannot reproduce.
 */
function freeText(v: unknown, path: string): string {
  const s = nonEmpty(v, path);
  if (!isWellFormedUnicode(s)) {
    throw new PackageBodyValidationError(
      path,
      "must not contain a lone UTF-16 surrogate (unhashable by the Oracle's canonicalizer)",
    );
  }
  return s;
}
/**
 * A kernel id, by #399's rule (`isValidKernelId`, pcc.evidence.principal-id.v1):
 * 1-128 printable ASCII characters, no space, not starting `eip155:` or `ed25519:`
 * in any ASCII case. It is the same rule `principalTupleWord("kernel", id)` hashes
 * a funded `authorizedTuples` triple under, so every kernel id a package names is
 * one the funded deal can name.
 */
function kernelIdField(v: unknown, path: string): string {
  const s = nonEmpty(v, path);
  if (!isValidKernelId(s)) {
    throw new PackageBodyValidationError(
      path,
      "must be a kernel id: 1-128 printable ASCII characters, no space, not starting " +
        "eip155: or ed25519: (pcc.evidence.principal-id.v1)",
    );
  }
  return s;
}
/**
 * An evidenceTimeBounds end: a decimal string of Unix seconds, kept exactly as
 * given (the canonical settlement-vector golden: "1699999500" / "1700000000").
 * The same grammar as spec `parseEvidenceTimeBound` (#438; bus #3567).
 */
function unixSeconds(v: unknown, path: string): string {
  const s = nonEmpty(v, path);
  if (!/^(0|[1-9][0-9]*)$/.test(s) || !Number.isSafeInteger(Number(s))) {
    throw new PackageBodyValidationError(path, "must be a decimal string of Unix seconds (no sign, no leading zeros)");
  }
  return s;
}
function hex32(v: unknown, path: string): Hex {
  const s = str(v, path);
  if (!HEX32.test(s)) throw new PackageBodyValidationError(path, `expected 0x+64 lowercase hex, got "${s}"`);
  return s as Hex;
}
function addr(v: unknown, path: string): Hex {
  const s = str(v, path);
  if (!ADDR.test(s)) {
    throw new PackageBodyValidationError(path, `expected 0x+40 lowercase hex address, got "${s}"`);
  }
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
function obj(v: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new PackageBodyValidationError(path, "expected an object");
  }
  // An unknown key would be silently dropped from the typed body, so the
  // digest would cover a different object than the one the caller holds.
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  if (extra.length > 0) {
    throw new PackageBodyValidationError(path, `unknown key(s): ${extra.join(", ")}`);
  }
  return v as Record<string, unknown>;
}

/**
 * Validate a body against evidence's pinned schema and return it typed.
 *
 * FAILS CLOSED on every deviation. A body that is wrong in a way we tolerate
 * here becomes a digest the oracle cannot reproduce, discovered at mint. An
 * unknown key is refused, not dropped (the digest would cover a different object
 * than the caller holds), and the kernel id is pinned to #399's rule.
 *
 * NOT checked here, because the published golden forbids it: that
 * `producer.operatorPrincipalId` and `producer.devicePrincipalId` are the pinned
 * `eip155:<chainId>:0x<address>` and `ed25519:0x<key>` forms
 * (`parseOperatorPrincipalId` / `parseDevicePrincipalId`). The golden's body is
 * evidence's SAMPLE vector and carries the free-text ids "op-golden" and
 * "dev-golden", and its hashes must stay byte-identical, so they are only
 * required to be non-empty here. `assertMintablePackage` enforces the pinned forms
 * and binds them to the D1 and D2 signatures and the kernel registry, so a package
 * with free-text principals can be hashed but never minted.
 */
export function validatePackageBody(input: unknown): FinalMilestonePackageV2Body {
  const b = obj(input, "$", [
    "packageSchemaVersion",
    "packageFormat",
    "compositionSchemaVersion",
    "unitBinding",
    "producer",
    "challengeBinding",
    "evidence",
    "evidenceTimeBounds",
  ]);

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

  const ub = obj(b.unitBinding, "$.unitBinding", [
    "chainId",
    "escrow",
    "settlementUnitId",
    "jobIdHash",
    "milestoneIndex",
    "stepId",
    "compositionRoot",
    "acceptedEnvelopeHash",
  ]);
  const pr = obj(b.producer, "$.producer", ["operatorPrincipalId", "kernelId", "devicePrincipalId"]);
  const cb = obj(b.challengeBinding, "$.challengeBinding", ["nonce", "tChallengeRef"]);
  const ev = obj(b.evidence, "$.evidence", ["evidenceBlockHash"]);
  const tb = obj(b.evidenceTimeBounds, "$.evidenceTimeBounds", ["start", "end"]);
  const boundStart = unixSeconds(tb.start, "$.evidenceTimeBounds.start");
  const boundEnd = unixSeconds(tb.end, "$.evidenceTimeBounds.end");
  if (Number(boundStart) > Number(boundEnd)) {
    throw new PackageBodyValidationError("$.evidenceTimeBounds", "start is after end");
  }

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
      operatorPrincipalId: freeText(pr.operatorPrincipalId, "$.producer.operatorPrincipalId"),
      kernelId: kernelIdField(pr.kernelId, "$.producer.kernelId"),
      devicePrincipalId: freeText(pr.devicePrincipalId, "$.producer.devicePrincipalId"),
    },
    challengeBinding: {
      nonce: hex32(cb.nonce, "$.challengeBinding.nonce"),
      tChallengeRef: freeText(cb.tChallengeRef, "$.challengeBinding.tChallengeRef"),
    },
    evidence: {
      evidenceBlockHash: hex32(ev.evidenceBlockHash, "$.evidence.evidenceBlockHash"),
    },
    evidenceTimeBounds: { start: boundStart, end: boundEnd },
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
 *
 * The body is validated FIRST (`validatePackageBody`) and only the validated copy
 * is hashed. Every hex field must be `0x` + lowercase hex of its exact width: a
 * mixed-case or uppercase spelling (an EIP-55 escrow address, say) is refused with
 * a PackageBodyValidationError, never lowercased and never hashed. Hex case carries
 * no meaning but it changes the canonical bytes, so a body that was hashed in two
 * spellings would have two hashes; with one accepted spelling it has one.
 */
export function computePackageBodyHash(body: unknown): Hex {
  const jcs = canonicalize(validatePackageBody(body));
  const jcsBytes = Buffer.from(jcs, "utf8");
  const preImage = Buffer.concat([
    Buffer.from(toBytes(SIG_DOMAIN_V2)), // raw 32 bytes, NOT the hex string
    u64be(jcsBytes.length),
    jcsBytes,
  ]);
  return `0x${createHash("sha256").update(preImage).digest("hex")}` as Hex;
}

/**
 * The JCS pre-image, exposed so a cross-codebase mismatch is diffable. Validated
 * exactly like `computePackageBodyHash`, so what it shows is what gets signed.
 */
export function packageBodyJcs(body: unknown): string {
  return canonicalize(validatePackageBody(body));
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
 * is a launch checklist that gets skipped. It is more than a flag:
 * `assertMintablePackage` refuses a package whose challenge nonce is interim, so
 * nothing is minted on the placeholder, and that fails closed until the durable
 * challenge exists. (The interim value is the all-zero nonce; the check runs on
 * the validated body, so no other spelling of it can get past.)
 */
export const INTERIM_NONCE: Hex = `0x${"00".repeat(32)}` as Hex;
export function isInterimNonce(body: FinalMilestonePackageV2Body): boolean {
  return body.challengeBinding.nonce.toLowerCase() === INTERIM_NONCE;
}

// ── Signature entries ───────────────────────────────────────────────────────
// These live here, and package-digest-v2.ts re-exports them, so that
// packageDigestV2 can call validatePackageBody without an import cycle.

/**
 * One signature over a FinalMilestonePackage body: EXACTLY the keys `signer`,
 * `scheme` and `sig`, each a string. An entry with any other key is refused, not
 * ignored: the digest hashes the whole entry, so an extra key would move it
 * without changing a single fact.
 *
 * Shape is the ORACLE's (#1395, they own ingestion): `{signer, scheme, sig}`.
 * The signer SET is {operator, kernel} per evidence's frozen profile —
 * D1 = operator secp256k1-EIP712, D2 = kernel ed25519-raw32, one signature each.
 *
 * `signer` is the sort key, and it is `0x` + lowercase hex (SIGNER_FORM): any
 * other spelling is REFUSED, never lowercased. Oracle #1395:
 * "Do NOT depend on case; changing a signer id's case MUST be a no-op." Signer
 * ids are EIP-55-checksummed addresses in some paths and lowercase in others, so
 * binding a spelling would make identical evidence produce two package identities
 * and fail the packageHash bind at first mint. The oracle gets its no-op by
 * lowercasing on its own side. The producer gets the same result by accepting ONE
 * spelling and emitting it exactly as given, so the digest it produces is the one
 * the oracle computes.
 *
 * Evidence's mirror (`settlement-vector-golden-mirror.cjs`) dedups on the
 * lowercased signer but keeps each entry's own case. On lowercase input, which is
 * the only input the producer accepts, that is the same string, so producer,
 * oracle and mirror agree on every input the producer accepts.
 */
export interface PackageSignature {
  signer: string;
  scheme: string;
  sig: string;
}

/** Raised when a signature entry cannot participate in the canonical order. */
export class InvalidSignatureEntryError extends Error {
  constructor(reason: string) {
    super(`Invalid FinalMilestonePackageV2 signature entry: ${reason}`);
    this.name = "InvalidSignatureEntryError";
  }
}

/**
 * The two signer forms of the frozen profile, `0x` + LOWERCASE hex only: D1's
 * address (40 digits) and D2's ed25519 public key (64 digits). A signer in any
 * other spelling (uppercase or EIP-55 mixed case, a `0X` prefix, no prefix, any
 * other width, not hex at all) is REFUSED, never normalized: one accepted
 * spelling per signer is what gives one package one digest.
 *
 * The mint guard (`assertMintablePackage`) pins each form to its scheme: 40
 * digits for D1, 64 for D2. This digest-path check cannot: the published golden
 * (`g2-settlement-vector-golden.json`) is a sample set whose entry labelled
 * "ed25519" has a 40-digit signer, and its digest must stay byte-identical.
 */
const SIGNER_FORM = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The keys of a signature entry, sorted and joined: an entry has EXACTLY these. */
const SIGNATURE_ENTRY_KEYS = "scheme,sig,signer";

/** One signature per role of the frozen signer set (D1 operator, D2 kernel). */
const SIGNATURE_COUNT = 2;

/** Builds the error a refusal raises: the digest path and the mint guard each raise their own type. */
type Refuse = (path: string, detail: string) => Error;

/**
 * Read the caller's signature list ONCE into plain local copies, so that whatever
 * is checked afterwards is exactly what is hashed afterwards. The list's length is
 * read once, each index once, and for each entry its three fields once (the keys
 * are enumerated once to prove there are exactly those three). Nothing downstream
 * touches the caller's objects again, so a getter that answers differently the
 * second time, or a caller that mutates an entry between a check and the hash,
 * cannot make validation and hashing disagree.
 *
 * Enforces the shape only: an array of exactly `expected` entries, each an object
 * with exactly the keys signer, scheme, sig. The values come back unchecked.
 */
function copySignatureEntries(
  sigs: unknown,
  expected: number,
  refuse: Refuse,
): Array<{ signer: unknown; scheme: unknown; sig: unknown }> {
  if (!Array.isArray(sigs)) throw refuse("$signatures", "must be an array");
  const count: number = sigs.length;
  if (count !== expected) {
    throw refuse(
      "$signatures",
      `expected exactly ${expected} signatures (one per role: D1 operator, D2 kernel), got ${count}`,
    );
  }
  const copies: Array<{ signer: unknown; scheme: unknown; sig: unknown }> = [];
  for (let i = 0; i < count; i++) {
    const path = `$signatures[${i}]`;
    const entry: unknown = sigs[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw refuse(path, "is not an object");
    }
    if (Object.keys(entry).sort().join(",") !== SIGNATURE_ENTRY_KEYS) {
      throw refuse(path, "must have exactly the keys signer, scheme, sig");
    }
    const { signer, scheme, sig } = entry as Record<string, unknown>;
    copies.push({ signer, scheme, sig });
  }
  return copies;
}

/**
 * The malleability closure, as REFUSALS. It does not repair what it is given: it
 * accepts exactly one shape, and sorts.
 *  - An array of exactly two entries: the signer set is one signature per role.
 *  - Each entry has EXACTLY the keys signer, scheme, sig, all strings, with the
 *    signer pinned to SIGNER_FORM. An unknown key would move the digest without
 *    changing a fact.
 *  - No two entries share a signer, and no two share a scheme (the role). A
 *    duplicate is REFUSED, never deduplicated: under "first wins" a forged
 *    duplicate placed ahead of the real entry would be the one that wins.
 * The only normalization left is the sort by signer, so reordering is a no-op.
 *
 * NOT checked here: that the two schemes are exactly the D1 and D2 names, and the
 * signer width per scheme. The published golden's sample set labels its entries
 * "secp256k1" and "ed25519" (the latter with a 40-digit signer) and its digest
 * must stay byte-identical. `assertMintablePackage` enforces both.
 *
 * Pure: never mutates the caller's array, returns a new one of new entries. Every
 * input field is read once (`copySignatureEntries`), and only the copies are
 * checked, sorted and returned.
 */
export function canonicalSignatures(sigs: unknown): PackageSignature[] {
  const refuse: Refuse = (path, detail) => new InvalidSignatureEntryError(`${path} ${detail}`);
  const entries: PackageSignature[] = [];
  copySignatureEntries(sigs, SIGNATURE_COUNT, refuse).forEach(({ signer, scheme, sig }, i) => {
    const path = `$signatures[${i}]`;
    if (typeof signer !== "string" || !SIGNER_FORM.test(signer)) {
      throw refuse(
        `${path}.signer`,
        "must be 0x + 40 or 64 lowercase hex digits (an address or an ed25519 key); " +
          "any other spelling is refused, never normalized",
      );
    }
    if (typeof scheme !== "string" || scheme.length === 0) {
      throw refuse(`${path}.scheme`, "must be a non-empty string");
    }
    if (typeof sig !== "string" || sig.length === 0) {
      throw refuse(`${path}.sig`, "must be a non-empty string");
    }
    entries.push({ signer, scheme, sig });
  });

  const signers = new Set<string>();
  const roles = new Set<string>();
  for (const e of entries) {
    if (signers.has(e.signer)) {
      throw new InvalidSignatureEntryError("a signer appears twice; duplicates are refused, never deduplicated");
    }
    signers.add(e.signer);
    if (roles.has(e.scheme)) {
      throw new InvalidSignatureEntryError("two signatures in the same role (same scheme); duplicates are refused, never deduplicated");
    }
    roles.add(e.scheme);
  }

  return entries.sort((a, b) => (a.signer < b.signer ? -1 : a.signer > b.signer ? 1 : 0));
}

// ── The mint-time guard ─────────────────────────────────────────────────────

/** Raised when a body + signature set must not be minted into a package. */
export class PackageNotMintableError extends Error {
  constructor(path: string, detail: string) {
    super(`FinalMilestonePackageV2 not mintable at ${path}: ${detail}`);
    this.name = "PackageNotMintableError";
  }
}

/**
 * The frozen signer profile, under the self-describing scheme labels that the
 * evidence schema §3 uses. The label is inside the hashed signature entries, so
 * producer and verifiers need one string, and a bare "secp256k1" would not say
 * raw, EIP-191 or EIP-712. (The published golden's SAMPLE signature set still
 * carries the bare labels "secp256k1" and "ed25519", with a 40-digit "ed25519"
 * signer: it is a digest vector, never a mintable set, which is why this profile
 * is enforced here and not by `packageDigestV2`.)
 *   D1 "secp256k1-eip712" = the operator's EIP-712 signature (signer = 0x +
 *      40-hex address, 65-byte signature);
 *   D2 "ed25519-raw32" = the kernel's ed25519 signature over raw32(packageBodyHash)
 *      — the raw 32 bytes of packageBodyHash, never packageDigestV2 (which embeds
 *      D2 itself) and never the hex string (signer = 0x + 64-hex public key, the
 *      registry's form; 64-byte signature).
 * Lowercase hex only.
 *
 * CROSS-FAMILY E9 (2026-09-24 / adfa2695), D1 STATUS — READ BEFORE TOUCHING D1:
 * D2 above IS cryptographically verified below (ed25519 over
 * raw32(packageBodyHash), via `verifyEd25519Signature`). D1 IS NOT: this guard
 * still only checks D1's SHAPE (signer/sig regex, below) and that the CLAIMED
 * `operatorPrincipalId` matches the CLAIMED D1 signer
 * (`operatorPrincipalMatchesSigner`) — which is self-consistency, not
 * authenticity. A fabricated D1 signature of the right SHAPE over the WRONG
 * (or no) message still passes this guard today.
 *
 * Verifying D1 for real needs the EIP-712 domain + typed-data struct the
 * operator signs. Searched for it in public PCC (2026-10-02) and did not find
 * a byte-exact one:
 *   - evidence schema docs (`~/.claude/shared/vnext-finalmilestonepackage-v2-body-schema.md`
 *     §2) name the domain (`{name:"PCC FinalMilestonePackage", version:"2",
 *     chainId, verifyingContract=escrow}`, no salt) and the struct name
 *     (`FinalMilestonePackageV2{8 unitBinding fields + packageBodyHash}`) in
 *     PROSE, but give no per-field Solidity/ABI type (uint256 vs string, exact
 *     order) — not enough to compute a correct struct hash;
 *   - the V-next escrow Solidity (`packages/contracts/src/libraries/VNextSettlementLib.sol`,
 *     `VNextSettlementEscrowFactory.sol`) defines `JOB_POLICY_TYPEHASH` for
 *     `PolicyIdentity` and the shared EIP-712 domain hashes, but no typehash for
 *     a package/release struct;
 *   - escrow's #367 TS ABI (`packages/contracts/ts/abi/*.ts`, frozen by
 *     "feat/vnext-settlement-abi-freeze") has no TYPEHASH, FinalMilestone,
 *     PackageV2, EIP712 or packageBodyHash reference at all;
 *   - the #270 mirror (`pcc-lanes/wt-evidence-270/packages/verifier/test-vectors/
 *     finalmilestonepackage-v2-preview-mirror.cjs`) only computes
 *     `packageBodyHash`; it has no operator-signature verification.
 * Per the operator's standing rule, a struct guessed from prose here would
 * verify against a type space ONLY this file invented — not what the real
 * operator signer or the private Oracle use — which is worse than an honest
 * gap: it would look fixed while still being bypassable by anyone who reads
 * this file. D1 STOPS here until the authoritative struct is published in
 * public PCC. Tracked in triage-E9-358-fixer-tango.md.
 */
const D1_SCHEME = "secp256k1-eip712";
const D2_SCHEME = "ed25519-raw32";
const MINT_SIGNER_PROFILE: Readonly<Record<string, { signer: RegExp; sig: RegExp; role: string }>> = {
  [D1_SCHEME]: { signer: /^0x[0-9a-f]{40}$/, sig: /^0x[0-9a-f]{130}$/, role: "D1 operator" },
  [D2_SCHEME]: { signer: /^0x[0-9a-f]{64}$/, sig: /^0x[0-9a-f]{128}$/, role: "D2 kernel" },
};

/**
 * One read of the registry's signer into a plain copy: a string stays a string,
 * an object becomes `{algorithm, publicKey, address}` read once each, anything
 * else is passed through (the registry reader refuses it).
 */
function copyRegisteredSigner(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const { algorithm, publicKey, address } = v as Record<string, unknown>;
  return { algorithm, publicKey, address };
}

/**
 * The shape `principalFromRegistry` / `normalizeRegisteredSigner` (`@pcc/spec`)
 * accept. Not re-exported from the package root, so this mirrors it locally;
 * `principalFromRegistry` is the actual authority on acceptable spellings, so an
 * imprecise local type costs nothing at runtime — it only narrows what callers
 * of `KernelRegistryReader` are nudged to return.
 */
export type KernelRegistrySigner =
  | { algorithm: "ed25519"; publicKey: string }
  | { algorithm: "secp256k1"; address: string };

/**
 * F2: the kernel registry, injected. `assertMintablePackage` calls
 * `signerForKernel` with the VALIDATED `producer.kernelId` (never a caller
 * claim) and requires the D2 key to equal what it returns. `null` means "the
 * registry holds no signer for this kernel" and is refused, never treated as
 * "no binding required" — a bare signer argument must never authorize itself.
 * The reader's authority is the CALLER's: the gateway's own kernel registry, or
 * a pinned snapshot verified with #416's `ident.registered_key`. This guard
 * trusts whatever it is given here exactly once (read-once, below) and no more.
 */
export interface KernelRegistryReader {
  signerForKernel(
    kernelId: string,
  ): KernelRegistrySigner | null | Promise<KernelRegistrySigner | null>;
}

/**
 * Refuse anything a real mint must never produce, before any digest exists. The
 * digest path (`canonicalSignatures`) already refuses what the oracle's ingestion
 * would repair (duplicates, case, extra keys); this is the stricter gate for a
 * real mint:
 *  - the body passes `validatePackageBody` (exact keys, lowercase hex, kernel id);
 *  - the challenge nonce is not the interim placeholder, so nothing is minted
 *    until the durable challenge exists (fails closed);
 *  - exactly one D1 and one D2 signature, each with exactly the keys
 *    {signer, scheme, sig}, the profile's exact scheme name and its signer and
 *    signature forms, so no duplicate, extra, relabelled or foreign-scheme entry
 *    can reach the digest;
 *  - the principal ids are the pinned forms (`pcc.evidence.principal-id.v1`)
 *    and bound to those signatures: operatorPrincipalId is
 *    eip155:<unit chainId>:<the D1 signer>, and devicePrincipalId is
 *    ed25519:<the D2 signer>, which must be the key the kernel registry holds
 *    for the VALIDATED producer.kernelId (F2: looked up through
 *    `KernelRegistryReader`, never a bare caller-asserted signer) and never a
 *    key whose secret is public.
 *
 * READ ONCE. Every input is read exactly once into a local copy (the body through
 * `validatePackageBody`'s returned copy, each signature entry's fields and the
 * list's length and indices through `copySignatureEntries`, the registry signer's
 * fields through `copyRegisteredSigner`), and only the copies are checked and
 * hashed. No getter's second answer, and no change the caller makes after a
 * check, can make what was validated differ from what is returned.
 *
 * The registry lookup is async (a real registry is an I/O read), so this
 * function is too.
 *
 * Returns the validated body and the canonical signatures to hash.
 */
export async function assertMintablePackage(
  body: unknown,
  sigs: unknown,
  registry: KernelRegistryReader,
): Promise<{ body: FinalMilestonePackageV2Body; signatures: PackageSignature[] }> {
  const valid = validatePackageBody(body);
  if (isInterimNonce(valid)) {
    throw new PackageNotMintableError(
      "$.challengeBinding.nonce",
      "is the interim placeholder; the durable challenge is not built",
    );
  }
  const refuse: Refuse = (path, detail) => new PackageNotMintableError(path, detail);
  const schemes = new Set<string>();
  const entries: PackageSignature[] = copySignatureEntries(sigs, SIGNATURE_COUNT, refuse).map((c, i) => {
    const path = `$signatures[${i}]`;
    // Own keys only: a scheme named "constructor" or "__proto__" must be a typed refusal, not a crash.
    const profile =
      typeof c.scheme === "string" && Object.hasOwn(MINT_SIGNER_PROFILE, c.scheme)
        ? MINT_SIGNER_PROFILE[c.scheme]
        : undefined;
    if (!profile || typeof c.scheme !== "string") {
      throw refuse(`${path}.scheme`, `must be "${D1_SCHEME}" (D1) or "${D2_SCHEME}" (D2)`);
    }
    if (schemes.has(c.scheme)) {
      throw refuse(`${path}.scheme`, `a second ${profile.role} signature`);
    }
    schemes.add(c.scheme);
    if (typeof c.signer !== "string" || !profile.signer.test(c.signer)) {
      throw refuse(`${path}.signer`, `not a ${profile.role} signer in its lowercase form`);
    }
    if (typeof c.sig !== "string" || !profile.sig.test(c.sig)) {
      throw refuse(`${path}.sig`, `not a ${profile.role} signature`);
    }
    return { signer: c.signer, scheme: c.scheme, sig: c.sig };
  });
  const d1 = entries.find((e) => e.scheme === D1_SCHEME)!;
  const d2 = entries.find((e) => e.scheme === D2_SCHEME)!;
  const chainId = Number(valid.unitBinding.chainId);
  if (!operatorPrincipalMatchesSigner(valid.producer.operatorPrincipalId, d1.signer, chainId)) {
    throw new PackageNotMintableError(
      "$.producer.operatorPrincipalId",
      "must be eip155:<unitBinding.chainId>:<the D1 signer's address> (pcc.evidence.principal-id.v1)",
    );
  }
  if (!devicePrincipalMatchesSigner(valid.producer.devicePrincipalId, d2.signer)) {
    throw new PackageNotMintableError(
      "$.producer.devicePrincipalId",
      "must be ed25519:<the D2 signer's key>, never a key whose secret is public (pcc.evidence.principal-id.v1)",
    );
  }

  // F1 (D2 half): the kernel's ed25519 signature must verify over the raw 32
  // bytes of packageBodyHash — not the hex string, and not packageDigestV2
  // (which would be circular: it embeds this very signature). D1 is NOT
  // cryptographically verified here; see the STOP note above
  // MINT_SIGNER_PROFILE.
  const bodyHashRaw32 = Buffer.from(toBytes(computePackageBodyHash(valid)));
  if (!verifyEd25519Signature(d2.signer, bodyHashRaw32, d2.sig)) {
    throw new PackageNotMintableError(
      `$signatures[${entries.indexOf(d2)}].sig`,
      "D2 ed25519 signature does not verify over raw32(packageBodyHash)",
    );
  }

  // F2: the registry binding is authenticated, keyed by the VALIDATED kernel
  // id — never a caller-asserted signer with no registry lookup at all.
  const registeredSigner = await registry.signerForKernel(valid.producer.kernelId);
  if (registeredSigner === null || registeredSigner === undefined) {
    throw new PackageNotMintableError(
      "$.producer.kernelId",
      "the kernel registry holds no signer for this kernel id",
    );
  }
  if (
    principalFromRegistry(copyRegisteredSigner(registeredSigner), chainId) !==
    valid.producer.devicePrincipalId
  ) {
    throw new PackageNotMintableError(
      "$.producer.devicePrincipalId",
      "is not the key the kernel registry holds for producer.kernelId",
    );
  }
  return { body: valid, signatures: canonicalSignatures(entries) };
}
