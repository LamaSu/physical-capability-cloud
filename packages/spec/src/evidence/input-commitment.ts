/**
 * The v1 bridge between an exact input's SHA-256 and its funded commitment
 * (#8812/#8815). The commitment is the FUNDED SubjectBlockFields.recipeRef
 * (accepted-policy.ts:494), inside acceptedPolicyDigest, never a CSD binding's
 * params.recipeRef (process.batch_record's paramsSchema). Read it only from
 * the authenticated subjects object; a package echo or another request field
 * is not its authority.
 *
 * recipeRef must be in spec-canonical lowercase, the only form
 * computeSubjectBlockHash admits. A consumer whose subject-block authentication
 * accepts other spellings (the oracle's ethers ABI coder does) lowercases the
 * AUTHENTICATED value once, then calls these functions. The inputHash side is
 * never normalized.
 *
 * There is one committed input per job in v1. A zero recipeRef means there is
 * no commitment. Neither input bytes nor digest spellings are normalized.
 * An older spec verifier ignores subject.inputHash, so the oracle's
 * input.hash_bound verifier remains the authoritative check.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import type { SHA256 } from "../types/common.js";
import { isHex256Digest, isTaggedSha256, uncurryThis } from "../util/primordials.js";
import type { Bytes32Hex } from "./accepted-policy.js";

/**
 * Documents the inputHash spelling only: `sha256:` + exactly 64 lowercase hex
 * digits. RegExp.prototype.compile can replace its matcher at runtime even
 * when frozen (primordials.ts:143-147). Validate with isInputHash or
 * inputHashToRecipeRef.
 */
export const INPUT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/** Validate the canonical inputHash spelling without a mutable RegExp. */
export function isInputHash(value: unknown): value is SHA256 {
  return isTaggedSha256(value);
}

export type InputCommitmentErrorCode =
  | "invalid-input-hash"
  | "invalid-recipe-ref"
  | "missing-input-commitment";

export class InputCommitmentError extends Error {
  readonly code: InputCommitmentErrorCode;

  constructor(code: InputCommitmentErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "InputCommitmentError";
    this.code = code;
  }
}

const ZERO_RECIPE_REF = `0x${"0".repeat(64)}`;
const stringSlice = uncurryThis(String.prototype.slice);

/** SHA-256 of precisely these bytes, with no text, newline or BOM normalization. */
export function inputHashOfBytes(bytes: Uint8Array): SHA256 {
  if (typeof bytes === "string") throw new TypeError("input bytes must be a Uint8Array, not a string");
  return `sha256:${bytesToHex(sha256(bytes))}`;
}

/**
 * Represent a canonical inputHash's same 32 bytes as a recipeRef. Validation
 * uses the existing tagged-digest guard, including its exact length check;
 * caller objects are never coerced and the exported RegExp cannot weaken it.
 */
export function inputHashToRecipeRef(inputHash: unknown): Bytes32Hex {
  if (!isTaggedSha256(inputHash)) {
    throw new InputCommitmentError(
      "invalid-input-hash",
      "inputHash must be sha256: followed by exactly 64 lowercase hex characters",
    );
  }
  return `0x${stringSlice(inputHash, 7)}`;
}

/**
 * Read the FUNDED SubjectBlockFields.recipeRef (accepted-policy.ts:494) only
 * from the authenticated subjects object (#8812/#8815), never a CSD binding's
 * params.recipeRef (process.batch_record's paramsSchema), then fill
 * EvidenceSubject.inputHash through this function. recipeRef must be in
 * spec-canonical lowercase (`0x` + exactly 64 lowercase hex digits), the only
 * form computeSubjectBlockHash admits. A consumer whose subject-block
 * authentication accepts other spellings (the oracle's ethers ABI coder does)
 * lowercases the AUTHENTICATED value once before calling this function. The
 * inputHash side is never normalized.
 *
 * Zero means no input commitment: missing-input-commitment means input.hash_bound
 * is NOT met. Omitting subject.inputHash is no substitute: LO-EV-9 then checks
 * no input.
 */
export function recipeRefToInputHash(recipeRef: unknown): SHA256 {
  if (!isHex256Digest(recipeRef)) {
    throw new InputCommitmentError(
      "invalid-recipe-ref",
      "recipeRef must be 0x followed by exactly 64 lowercase hex characters",
    );
  }
  if (recipeRef === ZERO_RECIPE_REF) {
    throw new InputCommitmentError("missing-input-commitment", "zero recipeRef means no funded input commitment");
  }
  return `sha256:${stringSlice(recipeRef, 2)}`;
}

/**
 * Whether the canonical inputHash equals the nonzero funded recipeRef's 32
 * bytes. Noncanonical values, missing commitments and mismatches return false;
 * this predicate never throws or coerces caller values.
 * recipeRef must be in spec-canonical lowercase, the only form
 * computeSubjectBlockHash admits. A consumer whose subject-block authentication
 * accepts other spellings (the oracle's ethers ABI coder does) lowercases the
 * AUTHENTICATED value once before calling this predicate. The inputHash side
 * is never normalized. Use only the authenticated FUNDED
 * SubjectBlockFields.recipeRef (accepted-policy.ts:494), never a CSD binding's
 * params.recipeRef (process.batch_record's paramsSchema).
 */
export function inputCommitmentMet(recipeRef: unknown, inputHash: unknown): boolean {
  return (
    isHex256Digest(recipeRef) &&
    recipeRef !== ZERO_RECIPE_REF &&
    isTaggedSha256(inputHash) &&
    stringSlice(recipeRef, 2) === stringSlice(inputHash, 7)
  );
}
