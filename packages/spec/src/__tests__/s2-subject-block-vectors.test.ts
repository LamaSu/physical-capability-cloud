/**
 * Thursday-SHAPE EXAMPLE values only, copied from:
 * pcc-oracle g1/testnet-config @87bc14e, bus #8144,
 * config/testnet/s2-subject-block-thursday-shape-golden.json.
 * These are TEST identities, not a funded unit policy. No oracle code is copied.
 * Bindings = [] was confirmed by economics #8105; termsHash is the #8032 literal.
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

// Every expected golden value is a literal from the cited JSON, independent of
// the producers under test (including the expected S2 field-10 program hash).
const GOLDEN = {
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
  termsHash: "0xf037904088f851954883103836132ab016be7a8b0ff4867a4b7b6463a5e4f6b7",
  subjectBlockHash: "0x4f166a59dc4e7f8f805ca04b62005a3aade04ae4202ac936c2749d6355830cdf",
  bindingsRoot: "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd",
  acceptedPolicyDigest: "0xd85ae6b3c2be54febf8a8297ed23f010019c1ba922f9784a8de24e3e59b6d7ae",
} as const;

function thursdayShape() {
  const payerId = formatOperatorPrincipalId(GOLDEN.chainId, GOLDEN.inputs.payerAddress);
  const operatorId = formatOperatorPrincipalId(GOLDEN.chainId, GOLDEN.inputs.hostAddress);
  const kernelId = GOLDEN.inputs.kernelId;
  const deviceId = formatDevicePrincipalId(GOLDEN.inputs.devicePublicKey);
  const payer = principalTupleWord("operator", payerId);
  const operator = principalTupleWord("operator", operatorId);
  const kernel = principalTupleWord("kernel", kernelId);
  const device = principalTupleWord("device", deviceId);
  const tuple = authorizedTuple(operatorId, kernelId, deviceId);
  const authorizedTuplesRoot = computeAuthorizedTuplesRoot([tuple]);
  const subject: SubjectBlockFields = {
    ...GOLDEN.subjects,
    payer,
    operatorPrincipal: operator,
    operatorSettlementAddress: GOLDEN.inputs.hostAddress,
    authorizedTuplesRoot,
    // ABI field 10 (including SUBJECT_DOMAIN): use S2's public pin as input.
    committedProgramHash: DOCUMENT_PRINT_LEG_PROGRAM_HASH,
  };
  const subjectBlockHash = computeSubjectBlockHash(subject);
  const bindingsRoot = computeBindingsRoot([]);
  const acceptedPolicyDigest = computeAcceptedPolicyDigest({
    termsHash: GOLDEN.termsHash,
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

describe("S2 Thursday subject-block vectors (pcc-oracle @87bc14e, bus #8144)", () => {
  it("pins the principal ids, words, authorized tuple, all 18 fields and policy digest end to end", () => {
    const actual = thursdayShape();
    for (const kind of ["payer", "operator", "kernel", "device"] as const) {
      expect(actual.ids[kind]).toBe(GOLDEN.principals[kind].id);
      expect(actual.words[kind]).toBe(GOLDEN.principals[kind].word);
    }
    expect(actual.tuple).toEqual(GOLDEN.authorizedTuple);
    expect(actual.subject).toEqual(GOLDEN.subjects);
    expect(DOCUMENT_PRINT_LEG_PROGRAM_HASH).toBe(GOLDEN.subjects.committedProgramHash);
    expect(actual.subject.authorizedTuplesRoot).toBe(GOLDEN.subjects.authorizedTuplesRoot);
    expect(actual.subjectBlockHash).toBe(GOLDEN.subjectBlockHash);
    expect(actual.bindingsRoot).toBe(GOLDEN.bindingsRoot);
    expect(actual.acceptedPolicyDigest).toBe(GOLDEN.acceptedPolicyDigest);
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
    ["golden tuple", [GOLDEN.authorizedTuple]],
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
    expect(() => computeAuthorizedTuplesRoot([GOLDEN.authorizedTuple, GOLDEN.authorizedTuple])).toThrow(AcceptedPolicyDigestInputError);
  });

  const malformedWords = [
    ["uppercase hex", "0x" + "A".repeat(64)],
    ["63-hex word", "0x" + "a".repeat(63)],
    ["non-0x word", "a".repeat(64)],
  ] as const;
  it.each(malformedWords)("refuses %s in every position", (_label, value) => {
    for (let position = 0; position < 3; position++) {
      const tuple: [Bytes32Hex, Bytes32Hex, Bytes32Hex] = [...GOLDEN.authorizedTuple];
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
    expect(() => canonicalAuthorizedTuples([GOLDEN.authorizedTuple, [ZERO, ZERO, ZERO], GOLDEN.authorizedTuple])).toThrow(AcceptedPolicyDigestInputError);
  });

  it("canonicalizes an empty list into a new empty array", () => {
    const input: readonly Tuple3[] = [];
    const result = canonicalAuthorizedTuples(input);
    expect(result).toEqual([]);
    expect(result).not.toBe(input);
  });

  it.each([computeAuthorizedTuplesRoot, canonicalAuthorizedTuples])("refuses malformed arrays without invoking input code (%#)", (producer) => {
    const getter = { reads: 0 };
    const accessorTuple = [...GOLDEN.authorizedTuple];
    Object.defineProperty(accessorTuple, "1", { enumerable: true, get() { getter.reads++; return ZERO; } });
    const accessorList = [GOLDEN.authorizedTuple];
    Object.defineProperty(accessorList, "0", { enumerable: true, get() { getter.reads++; return GOLDEN.authorizedTuple; } });
    const shortTuple = [ZERO, ZERO];
    const longTuple = [ZERO, ZERO, ZERO, ZERO];
    const sparseTuple = new Array(3);
    const sparseList = new Array(1);
    const extraList = Object.assign([GOLDEN.authorizedTuple], { extra: true });
    const proxyList = new Proxy([GOLDEN.authorizedTuple], { get() { throw new Error("must not read Proxy"); } });
    const proxyTuple = new Proxy([...GOLDEN.authorizedTuple], { get() { throw new Error("must not read Proxy"); } });
    for (const input of [accessorList, [accessorTuple], [shortTuple], [longTuple], [sparseTuple], sparseList, extraList, proxyList, [proxyTuple]]) {
      expect(() => producer(input as readonly Tuple3[])).toThrow(AcceptedPolicyDigestInputError);
    }
    expect(getter.reads).toBe(0);
  });
});

describe("Thursday single-input negative controls", () => {
  it("changing field 10 changes subjectBlockHash and acceptedPolicyDigest", () => {
    const base = thursdayShape();
    const subjectBlockHash = computeSubjectBlockHash({ ...base.subject, committedProgramHash: ONE });
    expect(subjectBlockHash).not.toBe(base.subjectBlockHash);
    expect(computeAcceptedPolicyDigest({ termsHash: GOLDEN.termsHash, subjectBlockHash, bindingsRoot: base.bindingsRoot })).not.toBe(base.acceptedPolicyDigest);
  });

  it("changing termsHash changes only acceptedPolicyDigest", () => {
    const base = thursdayShape();
    const subjectBlockHash = computeSubjectBlockHash(base.subject);
    const bindingsRoot = computeBindingsRoot([]);
    expect(subjectBlockHash).toBe(base.subjectBlockHash);
    expect(bindingsRoot).toBe(base.bindingsRoot);
    expect(computeAcceptedPolicyDigest({ termsHash: ONE, subjectBlockHash, bindingsRoot })).not.toBe(base.acceptedPolicyDigest);
  });

  it("changing integrityGrade from 0 to 1 changes subjectBlockHash", () => {
    const base = thursdayShape();
    expect(base.subject.integrityGrade).toBe(0);
    expect(computeSubjectBlockHash({ ...base.subject, integrityGrade: 1 })).not.toBe(base.subjectBlockHash);
  });

  it("swapping the kernel and device words changes the tuple root", () => {
    const base = thursdayShape();
    const swapped: Tuple3 = [base.tuple[0], base.tuple[2], base.tuple[1]];
    expect(computeAuthorizedTuplesRoot([swapped])).not.toBe(base.subject.authorizedTuplesRoot);
  });

  it("adding one bindings entry changes bindingsRoot", () => {
    const base = thursdayShape();
    const entry: SubjectBinding = { planUnitKey: ZERO, requirementIdHash: ONE, sourceKind: 0, propositionKind: 0, valueRef: ZERO };
    expect(computeBindingsRoot([entry])).not.toBe(base.bindingsRoot);
  });
});
