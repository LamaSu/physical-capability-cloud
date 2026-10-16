import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as evidence from "../evidence/index.js";
import {
  INPUT_HASH_RE,
  InputCommitmentError,
  inputCommitmentMet,
  inputHashOfBytes,
  inputHashToRecipeRef,
  recipeRefToInputHash,
  type InputCommitmentErrorCode,
} from "../evidence/input-commitment.js";
import { isHex256Digest } from "../util/primordials.js";

interface InputVector {
  id: string;
  description: string;
  bytesHex: string;
  inputHash: string;
  recipeRef: string;
}
interface RefusalVector {
  id: string;
  value: unknown;
  errorCode: InputCommitmentErrorCode;
}
interface CommitmentPair {
  id: string;
  recipeRef: unknown;
  inputHash: unknown;
  met: boolean;
}

const vectors = JSON.parse(
  readFileSync(new URL("../evidence/vectors/input-commitment.v1.json", import.meta.url), "utf8"),
) as {
  contract: string;
  inputs: InputVector[];
  inputHashToRecipeRefRefusals: RefusalVector[];
  recipeRefToInputHashRefusals: RefusalVector[];
  commitmentPairs: CommitmentPair[];
};

function expectRefusal(f: () => unknown, expectedCode: InputCommitmentErrorCode): void {
  let thrown: unknown;
  try {
    f();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InputCommitmentError);
  expect((thrown as InputCommitmentError).name).toBe("InputCommitmentError");
  expect((thrown as InputCommitmentError).code).toBe(expectedCode);
}

/** Independent Node comparison: no shipped guard or format conversion. */
function nodeCommitmentMet(recipeRef: unknown, inputHash: unknown): boolean {
  if (
    typeof recipeRef !== "string" || recipeRef.length !== 66 || !/^0x[0-9a-f]{64}$/.test(recipeRef) ||
    typeof inputHash !== "string" || inputHash.length !== 71 || !/^sha256:[0-9a-f]{64}$/.test(inputHash)
  ) return false;
  const committed = Buffer.from(recipeRef.slice(2), "hex");
  if (committed.every((byte) => byte === 0)) return false;
  return timingSafeEqual(committed, Buffer.from(inputHash.slice(7), "hex"));
}

/** Independent conversion refusal oracle, using Node's byte decoding/comparison. */
function nodeRefusalCode(direction: "inputHash" | "recipeRef", value: unknown): InputCommitmentErrorCode | null {
  if (direction === "inputHash") {
    if (typeof value !== "string" || value.length !== 71 || !/^sha256:[0-9a-f]{64}$/.test(value)) {
      return "invalid-input-hash";
    }
    const raw = Buffer.from(value.slice(7), "hex");
    return raw.length === 32 && `sha256:${raw.toString("hex")}` === value ? null : "invalid-input-hash";
  }
  if (typeof value !== "string" || value.length !== 66 || !/^0x[0-9a-f]{64}$/.test(value)) {
    return "invalid-recipe-ref";
  }
  const raw = Buffer.from(value.slice(2), "hex");
  if (raw.length !== 32 || `0x${raw.toString("hex")}` !== value) return "invalid-recipe-ref";
  return timingSafeEqual(raw, Buffer.alloc(32)) ? "missing-input-commitment" : null;
}

describe("input commitment — exact input bytes and the funded recipeRef", () => {
  it("publishes the v1 vectors and exact inputHash pattern", () => {
    expect(vectors.contract).toBe("pcc.evidence.input-commitment.v1");
    expect(INPUT_HASH_RE.source).toBe("^sha256:[0-9a-f]{64}$");
    expect(INPUT_HASH_RE.flags).toBe("");
    expect(vectors.inputs.map(({ id }) => id)).toEqual(["empty", "abc", "binary-00-ff", "bom-cr-lf-whitespace"]);
  });

  for (const vector of vectors.inputs) {
    it(`matches the ${vector.id} vector and node:crypto independently`, () => {
      const bytes = new Uint8Array(Buffer.from(vector.bytesHex, "hex"));
      const nodeHex = createHash("sha256").update(bytes).digest("hex");
      expect(vector.inputHash).toBe(`sha256:${nodeHex}`);
      expect(vector.recipeRef).toBe(`0x${nodeHex}`);
      expect(inputHashOfBytes(bytes)).toBe(vector.inputHash);
      expect(inputHashToRecipeRef(vector.inputHash)).toBe(vector.recipeRef);
      expect(recipeRefToInputHash(vector.recipeRef)).toBe(vector.inputHash);
      expect(inputCommitmentMet(vector.recipeRef, vector.inputHash)).toBe(true);
      expect(isHex256Digest(vector.recipeRef)).toBe(true);
    });
  }

  it("hashes only the selected Uint8Array view", () => {
    const enclosing = Uint8Array.from([255, 97, 98, 99, 0]);
    expect(inputHashOfBytes(enclosing.subarray(1, 4))).toBe(vectors.inputs[1]!.inputHash);
  });

  it("preserves the BOM, whitespace, CRLF and bare line endings", () => {
    const vector = vectors.inputs.find(({ id }) => id === "bom-cr-lf-whitespace")!;
    const bytes = Buffer.from(vector.bytesHex, "hex");
    const text = bytes.toString("utf8");
    expect(bytes.subarray(0, 3).toString("hex")).toBe("efbbbf");
    expect(text).toContain("\r\n");
    expect(text).toContain("gamma\rdelta");
    for (const normalized of [text.trim(), text.replace(/\r\n?/g, "\n"), text.replace(/^\uFEFF/, "")]) {
      const normalizedBytes = Buffer.from(normalized, "utf8");
      expect(`sha256:${createHash("sha256").update(normalizedBytes).digest("hex")}`).not.toBe(vector.inputHash);
      expect(inputHashOfBytes(normalizedBytes)).not.toBe(vector.inputHash);
    }
    expect(inputHashOfBytes(bytes)).toBe(vector.inputHash);
  });

  for (const vector of vectors.inputHashToRecipeRefRefusals) {
    it(`refuses inputHash ${vector.id} with ${vector.errorCode}`, () => {
      expectRefusal(() => inputHashToRecipeRef(vector.value), vector.errorCode);
      expect(nodeRefusalCode("inputHash", vector.value)).toBe(vector.errorCode);
    });
  }

  for (const vector of vectors.recipeRefToInputHashRefusals) {
    it(`refuses recipeRef ${vector.id} with ${vector.errorCode}`, () => {
      expectRefusal(() => recipeRefToInputHash(vector.value), vector.errorCode);
      expect(nodeRefusalCode("recipeRef", vector.value)).toBe(vector.errorCode);
      expect(isHex256Digest(vector.value)).toBe(vector.id === "zero");
    });
  }

  for (const vector of vectors.commitmentPairs) {
    it(`checks commitment pair ${vector.id} against node:crypto independently`, () => {
      expect(inputCommitmentMet(vector.recipeRef, vector.inputHash)).toBe(vector.met);
      expect(nodeCommitmentMet(vector.recipeRef, vector.inputHash)).toBe(vector.met);
    });
  }

  it("represents an all-zero inputHash but never treats zero recipeRef as a commitment", () => {
    const inputHash = `sha256:${"0".repeat(64)}`;
    const zero = `0x${"0".repeat(64)}`;
    expect(inputHashToRecipeRef(inputHash)).toBe(zero);
    expectRefusal(() => recipeRefToInputHash(zero), "missing-input-commitment");
    expect(inputCommitmentMet(zero, inputHash)).toBe(false);
  });

  it("refuses non-JSON runtime values without invoking caller code", () => {
    let reads = 0;
    const hostile = Object.create(null);
    for (const key of ["toString", "valueOf", Symbol.toPrimitive]) {
      Object.defineProperty(hostile, key, {
        get() { reads++; throw new Error("caller code must not run"); },
      });
    }
    const live = new Proxy({}, { get() { reads++; throw new Error("proxy trap must not run"); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [undefined, Symbol("hash"), 1n, () => "hash", hostile, live, revoked.proxy]) {
      expectRefusal(() => inputHashToRecipeRef(value), "invalid-input-hash");
      expectRefusal(() => recipeRefToInputHash(value), "invalid-recipe-ref");
      expect(inputCommitmentMet(value, vectors.inputs[1]!.inputHash)).toBe(false);
      expect(inputCommitmentMet(vectors.inputs[1]!.recipeRef, value)).toBe(false);
    }
    expect(reads).toBe(0);
  });

  it("exports the helper through the evidence package index", () => {
    expect(evidence.INPUT_HASH_RE).toBe(INPUT_HASH_RE);
    expect(evidence.InputCommitmentError).toBe(InputCommitmentError);
    expect(evidence.inputHashOfBytes).toBe(inputHashOfBytes);
    expect(evidence.inputHashToRecipeRef).toBe(inputHashToRecipeRef);
    expect(evidence.recipeRefToInputHash).toBe(recipeRefToInputHash);
    expect(evidence.inputCommitmentMet).toBe(inputCommitmentMet);
  });
});
