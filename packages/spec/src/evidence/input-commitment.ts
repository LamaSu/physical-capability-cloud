/**
 * The v1 bridge between an exact input's SHA-256 and its funded commitment
 * (#8812/#8815). The commitment is the FUNDED subject block's `recipeRef`,
 * inside acceptedPolicyDigest. Read it only from the authenticated subjects
 * object; a package echo or another request field is not its authority.
 *
 * There is one committed input per job in v1. A zero recipeRef means there is
 * no commitment. Neither input bytes nor digest spellings are normalized.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import type { SHA256 } from "../types/common.js";
import { isHex256Digest, isTaggedSha256, uncurryThis } from "../util/primordials.js";
import type { Bytes32Hex } from "./accepted-policy.js";

/** The only inputHash spelling: `sha256:` + exactly 64 lowercase hex digits. */
export const INPUT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

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
 * Read the FUNDED subject block's recipeRef only from the authenticated
 * subjects object (#8812/#8815), then fill EvidenceSubject.inputHash through
 * this function. The existing spec bytes32 convention is `0x` + exactly 64
 * lowercase hex digits (`isHex256Digest`); zero means no input commitment.
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
 */
export function inputCommitmentMet(recipeRef: unknown, inputHash: unknown): boolean {
  return (
    isHex256Digest(recipeRef) &&
    recipeRef !== ZERO_RECIPE_REF &&
    isTaggedSha256(inputHash) &&
    stringSlice(recipeRef, 2) === stringSlice(inputHash, 7)
  );
}
