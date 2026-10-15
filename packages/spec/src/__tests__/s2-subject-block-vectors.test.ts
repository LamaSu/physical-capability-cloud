/**
 * Vector A: historical #8144 EXAMPLE inputs for computeAcceptedPolicyDigest, with
 * Thursday-SHAPE subject values from pcc-oracle g1/testnet-config @87bc14e,
 * config/testnet/s2-subject-block-thursday-shape-golden.json.
 * These are TEST identities, not a funded unit policy. No oracle code is copied.
 * Bindings = [] was confirmed by economics #8105. The 0xf0379040...f6b7 input was
 * #8144's example input; economics SUPERSEDED it as a termsHash in #8165. It is
 * only a terms-file version digest now, NEVER Thursday's termsHash. Vector A
 * remains a valid function vector of computeAcceptedPolicyDigest with unchanged pins.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it } from "vitest";
import {
  AcceptedPolicyDigestInputError,
  DOCUMENT_PRINT_LEG_PROGRAM_HASH,
  authorizedTuple,
  canonicalAuthorizedTuples,
  computeAcceptedPolicyDigest,
  computeAuthorizedTuplesRoot,
  computeBindingsRoot,
  computeSubjectBlockHash,
  formatDevicePrincipalId,
  formatOperatorPrincipalId,
  principalTupleWord,
  type Bytes32Hex,
  type SubjectBinding,
  type SubjectBlockFields,
} from "../index.js";

type Tuple3 = readonly [Bytes32Hex, Bytes32Hex, Bytes32Hex];

// Every expected vector A value is a literal from the cited JSON, independent of
// the producers under test (including the expected S2 field-10 program hash).
const VECTOR_A = {
  chainId: 84532,
  inputs: {
    payerAddress: "0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a",
    hostAddress: "0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb",
    kernelId: "kernel-hp-printer-golden",
    devicePublicKey: "0xd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
  },
  principals: {
    payer: {
      id: "eip155:84532:0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a",
      word: "0x54f869890b644226a289546d7276852783d66fdcd22d16b300bd515b33f1785f",
    },
    operator: {
      id: "eip155:84532:0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb",
      word: "0x2fa2ca73700c6990c982177315e83b6d119eecab8c1e222d821bbca2ec02caec",
    },
    kernel: {
      id: "kernel-hp-printer-golden",
      word: "0x12e00cf7161d9ede970f48c1ca026eb93a84c6a2a75d278d8940dde362cc4d6c",
    },
    device: {
      id: "ed25519:0xd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
      word: "0x000df964c6ff31189689e8b2526a06f587c77479e1313fea366f8cd1137cec2f",
    },
  },
  authorizedTuple: [
    "0x2fa2ca73700c6990c982177315e83b6d119eecab8c1e222d821bbca2ec02caec",
    "0x12e00cf7161d9ede970f48c1ca026eb93a84c6a2a75d278d8940dde362cc4d6c",
    "0x000df964c6ff31189689e8b2526a06f587c77479e1313fea366f8cd1137cec2f",
  ],
  subjects: {
    payer: "0x54f869890b644226a289546d7276852783d66fdcd22d16b300bd515b33f1785f",
    operatorPrincipal: "0x2fa2ca73700c6990c982177315e83b6d119eecab8c1e222d821bbca2ec02caec",
    operatorSettlementAddress: "0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb",
    authorizedTuplesRoot: "0xe6dbca35236d751bea6096dc49501a3d7bc266873563188b5768ba7cb16a7af5",
    expertSetRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    executorSetRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    expectedRecipient: "0x0000000000000000000000000000000000000000000000000000000000000000",
    targetSystemIdentity: "0x0000000000000000000000000000000000000000000000000000000000000000",
    committedProgramHash: "0x56c1897725442876a5b7adfde81b81c83b9ef09aade75aa3a81a911856330e4a",
    recipeRef: "0x0000000000000000000000000000000000000000000000000000000000000000",
    sampleManifestRef: "0x0000000000000000000000000000000000000000000000000000000000000000",
    childrenRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    operatingEnvelopeHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    expectedRouteArea: "0x0000000000000000000000000000000000000000000000000000000000000000",
    expectedLocationHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    captureNonceAnchor: "0x0000000000000000000000000000000000000000000000000000000000000000",
    challengeAnchor: "0x0000000000000000000000000000000000000000000000000000000000000000",
    integrityGrade: 0,
  },
  // Historical function input only: a terms-file version digest, superseded by #8165.
  termsHash: "0xf037904088f851954883103836132ab016be7a8b0ff4867a4b7b6463a5e4f6b7",
  subjectBlockHash: "0x4f166a59dc4e7f8f805ca04b62005a3aade04ae4202ac936c2749d6355830cdf",
  bindingsRoot: "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd",
  acceptedPolicyDigest: "0xd85ae6b3c2be54febf8a8297ed23f010019c1ba922f9784a8de24e3e59b6d7ae",
} as const;

function historicalExampleVectorA() {
  const payerId = formatOperatorPrincipalId(VECTOR_A.chainId, VECTOR_A.inputs.payerAddress);
  const operatorId = formatOperatorPrincipalId(VECTOR_A.chainId, VECTOR_A.inputs.hostAddress);
  const kernelId = VECTOR_A.inputs.kernelId;
  const deviceId = formatDevicePrincipalId(VECTOR_A.inputs.devicePublicKey);
  const payer = principalTupleWord("operator", payerId);
  const operator = principalTupleWord("operator", operatorId);
  const kernel = principalTupleWord("kernel", kernelId);
  const device = principalTupleWord("device", deviceId);
  const tuple = authorizedTuple(operatorId, kernelId, deviceId);
  const authorizedTuplesRoot = computeAuthorizedTuplesRoot([tuple]);
  const subject: SubjectBlockFields = {
    ...VECTOR_A.subjects,
    payer,
    operatorPrincipal: operator,
    operatorSettlementAddress: VECTOR_A.inputs.hostAddress,
    authorizedTuplesRoot,
    // ABI field 10 (including SUBJECT_DOMAIN): use S2's public pin as input.
    committedProgramHash: DOCUMENT_PRINT_LEG_PROGRAM_HASH,
  };
  const subjectBlockHash = computeSubjectBlockHash(subject);
  const bindingsRoot = computeBindingsRoot([]);
  const acceptedPolicyDigest = computeAcceptedPolicyDigest({
    termsHash: VECTOR_A.termsHash,
    subjectBlockHash,
    bindingsRoot,
  });
  return {
    ids: { payer: payerId, operator: operatorId, kernel: kernelId, device: deviceId },
    words: { payer, operator, kernel, device },
    tuple, subject, subjectBlockHash, bindingsRoot, acceptedPolicyDigest,
  };
}

// Local reimplementation of this PUBLIC repo's test mirror:
// accepted-policy.test.ts, abiSingleArray / rootOfTuple3Set / sortTup.
// Independent ABI encoder: one dynamic tuple[] argument, offset, count, words.
function wordUint(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function wordBytes32(hex: Bytes32Hex): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16));
}

function abiSingleArray(elements: readonly (readonly Uint8Array[])[]): Uint8Array {
  const words = [wordUint(32n), wordUint(BigInt(elements.length)), ...elements.flat()];
  const bytes = new Uint8Array(words.length * 32);
  words.forEach((word, i) => bytes.set(word, i * 32));
  return bytes;
}

function rootOfTuple3Set(tuples: readonly Tuple3[]): Bytes32Hex {
  const digest = keccak_256(abiSingleArray(tuples.map((tuple) => tuple.map(wordBytes32))));
  return `0x${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function sortTup(tuples: readonly Tuple3[]): Tuple3[] {
  return [...tuples].sort((a, b) => JSON.stringify(a).toLowerCase() < JSON.stringify(b).toLowerCase() ? -1 : 1);
}

const ZERO: Bytes32Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ONE: Bytes32Hex = "0x0000000000000000000000000000000000000000000000000000000000000001";
const TWO: Bytes32Hex = "0x0000000000000000000000000000000000000000000000000000000000000002";
// Same operator in all three; ties exercise both kernel and device ordering.
const THREE_TUPLES = [[ZERO, ZERO, ONE], [ZERO, ONE, ZERO], [ZERO, ZERO, ZERO]] as const;

describe("S2 historical vector A: #8144 example inputs (#8165 supersedes its termsHash meaning)", () => {
  it("pins vector A principal ids, words, authorized tuple, all 18 fields and the function digest", () => {
    const actual = historicalExampleVectorA();
    for (const kind of ["payer", "operator", "kernel", "device"] as const) {
      expect(actual.ids[kind]).toBe(VECTOR_A.principals[kind].id);
      expect(actual.words[kind]).toBe(VECTOR_A.principals[kind].word);
    }
    expect(actual.tuple).toEqual(VECTOR_A.authorizedTuple);
    expect(actual.subject).toEqual(VECTOR_A.subjects);
    expect(DOCUMENT_PRINT_LEG_PROGRAM_HASH).toBe(VECTOR_A.subjects.committedProgramHash);
    expect(actual.subject.authorizedTuplesRoot).toBe(VECTOR_A.subjects.authorizedTuplesRoot);
    expect(actual.subjectBlockHash).toBe(VECTOR_A.subjectBlockHash);
    expect(actual.bindingsRoot).toBe(VECTOR_A.bindingsRoot);
    expect(actual.acceptedPolicyDigest).toBe(VECTOR_A.acceptedPolicyDigest);
  });

  it("pins economics' principal-id v1 word and rejects the left-padded address encoding (#8095)", () => {
    const address = "0x6463acd05141c1ef6583e4fd978fc61fff4045dc";
    const id = formatOperatorPrincipalId(84532, address);
    expect(id).toBe("eip155:84532:0x6463acd05141c1ef6583e4fd978fc61fff4045dc");
    const word = principalTupleWord("operator", id);
    expect(word).toBe("0x5c7d94f41618b47baed85a60abea9904c04ffafe43edf75dad2739b3a760ac35");
    const paddedAddressWord = "0x0000000000000000000000006463acd05141c1ef6583e4fd978fc61fff4045dc";
    expect(word).not.toBe(paddedAddressWord);
  });
});

describe("authorizedTuplesRoot public producer", () => {
  it.each([
    ["golden tuple", [VECTOR_A.authorizedTuple]],
    ["three sorted tuples", sortTup(THREE_TUPLES)],
    ["empty funded list", []],
  ] as const)("matches the local public test mirror for %s", (_label, tuples) => {
    expect(computeAuthorizedTuplesRoot(tuples)).toBe(rootOfTuple3Set(tuples));
  });

  it("pins the empty root as keccak(offset 0x20 || length 0)", () => {
    expect(computeAuthorizedTuplesRoot([])).toBe("0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd");
  });

  it("refuses unsorted tuples instead of silently sorting", () => {
    const sorted = sortTup(THREE_TUPLES);
    expect(() => computeAuthorizedTuplesRoot([...sorted].reverse())).toThrow(AcceptedPolicyDigestInputError);
  });

  it("refuses duplicate tuples", () => {
    expect(() => computeAuthorizedTuplesRoot([VECTOR_A.authorizedTuple, VECTOR_A.authorizedTuple])).toThrow(AcceptedPolicyDigestInputError);
  });

  const malformedWords = [
    ["uppercase hex", "0x" + "A".repeat(64)],
    ["63-hex word", "0x" + "a".repeat(63)],
    ["non-0x word", "a".repeat(64)],
  ] as const;
  it.each(malformedWords)("refuses %s in every position", (_label, value) => {
    for (let position = 0; position < 3; position++) {
      const tuple: [Bytes32Hex, Bytes32Hex, Bytes32Hex] = [...VECTOR_A.authorizedTuple];
      tuple[position] = value as Bytes32Hex;
      expect(() => computeAuthorizedTuplesRoot([tuple])).toThrow(AcceptedPolicyDigestInputError);
      expect(() => canonicalAuthorizedTuples([tuple])).toThrow(AcceptedPolicyDigestInputError);
    }
  });

  it("canonicalizes lexicographically into a new array without mutating frozen input", () => {
    const input = Object.freeze(THREE_TUPLES.map((tuple) => Object.freeze([...tuple]) as Tuple3));
    const before = input.map((tuple) => [...tuple]);
    const canonical = canonicalAuthorizedTuples(input);
    expect(canonical).toEqual(sortTup(input));
    expect(canonical).not.toBe(input);
    expect(input).toEqual(before);
    expect(computeAuthorizedTuplesRoot(canonical)).toBe(rootOfTuple3Set(sortTup(input)));
  });

  it("orders operator before kernel before device", () => {
    const input: readonly Tuple3[] = [[ONE, ZERO, ZERO], [ZERO, ONE, ZERO], [ZERO, ZERO, TWO], [ZERO, ZERO, ONE]];
    expect(canonicalAuthorizedTuples(input)).toEqual([
      [ZERO, ZERO, ONE], [ZERO, ZERO, TWO], [ZERO, ONE, ZERO], [ONE, ZERO, ZERO],
    ]);
  });

  it("canonicalization refuses non-adjacent duplicates rather than deduplicating", () => {
    expect(() => canonicalAuthorizedTuples([VECTOR_A.authorizedTuple, [ZERO, ZERO, ZERO], VECTOR_A.authorizedTuple])).toThrow(AcceptedPolicyDigestInputError);
  });

  it("canonicalizes an empty list into a new empty array", () => {
    const input: readonly Tuple3[] = [];
    const result = canonicalAuthorizedTuples(input);
    expect(result).toEqual([]);
    expect(result).not.toBe(input);
  });

  it.each([computeAuthorizedTuplesRoot, canonicalAuthorizedTuples])("refuses malformed arrays without invoking input code (%#)", (producer) => {
    const getter = { reads: 0 };
    const accessorTuple = [...VECTOR_A.authorizedTuple];
    Object.defineProperty(accessorTuple, "1", { enumerable: true, get() { getter.reads++; return ZERO; } });
    const accessorList = [VECTOR_A.authorizedTuple];
    Object.defineProperty(accessorList, "0", { enumerable: true, get() { getter.reads++; return VECTOR_A.authorizedTuple; } });
    const shortTuple = [ZERO, ZERO];
    const longTuple = [ZERO, ZERO, ZERO, ZERO];
    const sparseTuple = new Array(3);
    const sparseList = new Array(1);
    const extraList = Object.assign([VECTOR_A.authorizedTuple], { extra: true });
    const proxyList = new Proxy([VECTOR_A.authorizedTuple], { get() { throw new Error("must not read Proxy"); } });
    const proxyTuple = new Proxy([...VECTOR_A.authorizedTuple], { get() { throw new Error("must not read Proxy"); } });
    for (const input of [accessorList, [accessorTuple], [shortTuple], [longTuple], [sparseTuple], sparseList, extraList, proxyList, [proxyTuple]]) {
      expect(() => producer(input as readonly Tuple3[])).toThrow(AcceptedPolicyDigestInputError);
    }
    expect(getter.reads).toBe(0);
  });
});

describe("Historical vector A single-input negative controls", () => {
  it("changing field 10 changes subjectBlockHash and acceptedPolicyDigest", () => {
    const base = historicalExampleVectorA();
    const subjectBlockHash = computeSubjectBlockHash({ ...base.subject, committedProgramHash: ONE });
    expect(subjectBlockHash).not.toBe(base.subjectBlockHash);
    expect(computeAcceptedPolicyDigest({ termsHash: VECTOR_A.termsHash, subjectBlockHash, bindingsRoot: base.bindingsRoot })).not.toBe(base.acceptedPolicyDigest);
  });

  it("changing termsHash changes only acceptedPolicyDigest", () => {
    const base = historicalExampleVectorA();
    const subjectBlockHash = computeSubjectBlockHash(base.subject);
    const bindingsRoot = computeBindingsRoot([]);
    expect(subjectBlockHash).toBe(base.subjectBlockHash);
    expect(bindingsRoot).toBe(base.bindingsRoot);
    expect(computeAcceptedPolicyDigest({ termsHash: ONE, subjectBlockHash, bindingsRoot })).not.toBe(base.acceptedPolicyDigest);
  });

  it("changing integrityGrade from 0 to 1 changes subjectBlockHash", () => {
    const base = historicalExampleVectorA();
    expect(base.subject.integrityGrade).toBe(0);
    expect(computeSubjectBlockHash({ ...base.subject, integrityGrade: 1 })).not.toBe(base.subjectBlockHash);
  });

  it("swapping the kernel and device words changes the tuple root", () => {
    const base = historicalExampleVectorA();
    const swapped: Tuple3 = [base.tuple[0], base.tuple[2], base.tuple[1]];
    expect(computeAuthorizedTuplesRoot([swapped])).not.toBe(base.subject.authorizedTuplesRoot);
  });

  it("adding one bindings entry changes bindingsRoot", () => {
    const base = historicalExampleVectorA();
    const entry: SubjectBinding = { planUnitKey: ZERO, requirementIdHash: ONE, sourceKind: 0, propositionKind: 0, valueRef: ZERO };
    expect(computeBindingsRoot([entry])).not.toBe(base.bindingsRoot);
  });
});
