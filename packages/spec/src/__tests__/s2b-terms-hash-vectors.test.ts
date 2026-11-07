/**
 * Ratified termsHash v2.1 vectors, from tmp/vnext-termshash-golden-v1.md.
 * The in-test mirror uses noble keccak and a handwritten ABI layout; it imports
 * no production encoding helper or external mirror. Funded order is load-bearing.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it } from "vitest";
import {
  AcceptedPolicyDigestInputError,
  POLICY_DOMAIN,
  TERMS_DOMAIN,
  computeAcceptedPolicyDigest,
  computeBindingsRoot,
  computeMilestonesRoot,
  computeTermsHash,
  type Bytes32Hex,
  type CanonicalJobTermsV1,
  type CanonicalMilestoneTermsV1,
  type UintInput,
} from "../index.js";

function mirrorHash(bytes: Uint8Array): Bytes32Hex {
  return `0x${Array.from(keccak_256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function mirrorUtf8(value: string): Bytes32Hex {
  return mirrorHash(new TextEncoder().encode(value));
}

function mirrorUint(value: UintInput): Uint8Array {
  let integer = BigInt(value);
  const word = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    word[i] = Number(integer & 0xffn);
    integer >>= 8n;
  }
  return word;
}

function mirrorHex(value: string): Uint8Array {
  const hex = value.slice(2).padStart(64, "0");
  return Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function mirrorWords(words: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 32);
  words.forEach((word, i) => bytes.set(word, i * 32));
  return bytes;
}

function mirrorMilestonesRoot(milestones: readonly CanonicalMilestoneTermsV1[]): Bytes32Hex {
  // ABI for ONE dynamic argument: uint256(0x20), count, then each static tuple.
  return mirrorHash(mirrorWords([
    mirrorUint(32),
    mirrorUint(milestones.length),
    ...milestones.flatMap((milestone) => [
      mirrorUint(milestone.milestoneIndex),
      mirrorHex(milestone.stepId),
      mirrorUint(milestone.amount),
      mirrorUint(milestone.deadline),
    ]),
  ]));
}

function mirrorTermsHash(terms: CanonicalJobTermsV1): Bytes32Hex {
  return mirrorHash(mirrorWords([
    mirrorHex(mirrorUtf8("PCC:vnext:job-terms:v1")),
    mirrorHex(terms.token),
    mirrorUint(terms.assuranceTier),
    mirrorHex(mirrorMilestonesRoot(terms.milestones)),
  ]));
}

const GOLDEN = {
  domain: "0xaf4cf568beb02a9dca015909829c12f5eb22b355111bdf85603e98da8a43c141",
  milestonesRoot: "0xf7147855908c6b7e33a27556c9662c07c15ca6ef4b6bfbccbc8d634634409388",
  termsHash: "0x2cb7a79e45cbb5b78b61dbbcc182b2f27ac7991b055a66ef58457459dc2f4fe6",
} as const;

function goldenTerms(): CanonicalJobTermsV1 {
  return {
    token: "0x00000000000000000000000000000000000005dc",
    assuranceTier: 2,
    // Deliberately UNSORTED indices and STAGGERED deadlines, literally Aug 6's GOLDEN.
    milestones: [
      { milestoneIndex: 1, stepId: mirrorUtf8("golden-step-1"), amount: 600000, deadline: 2000500000 },
      { milestoneIndex: 0, stepId: mirrorUtf8("golden-step-0"), amount: 400000, deadline: 2000000000 },
    ],
  };
}

function replaceFirst(change: Partial<CanonicalMilestoneTermsV1>): CanonicalJobTermsV1 {
  const terms = goldenTerms();
  return { ...terms, milestones: [{ ...terms.milestones[0], ...change }, terms.milestones[1]] };
}

// The exact seven changes in evidence's independent ethers mirror, with values
// pinned independently by this test's handwritten ABI mirror.
const NEGATIVE_PARITY: readonly [string, () => CanonicalJobTermsV1, Bytes32Hex][] = [
  ["reorder funded milestones [1,0] to [0,1]", () => {
    const terms = goldenTerms();
    return { ...terms, milestones: [...terms.milestones].reverse() };
  }, "0x9938b754444b359a47aa853e7f60246f60a69d7928cbff40903f9d65e3c09cc3"],
  ["milestoneIndex at position 0: 1 to 2", () => replaceFirst({ milestoneIndex: 2 }),
    "0x38ca1bf9fe00b429e8d008138b2e59366074a02b4d8d01e5f0e4a209ca7013d2"],
  ["amount at position 0: 600000 to 600001", () => replaceFirst({ amount: 600001 }),
    "0xf4750815c09e73e05ad6fceb7f940c482bc821a898d51605489deda2275030c6"],
  ["stepId at position 0: golden-step-1-x", () => replaceFirst({ stepId: mirrorUtf8("golden-step-1-x") }),
    "0xec9b8fac64d4c25915895fdd68e2ad746b23d937bdb4bea42713497a1e73b64b"],
  ["deadline at position 0: 2000500000 to 2000500001", () => replaceFirst({ deadline: 2000500001 }),
    "0x857530e2116746500894de108b6989f10a9a590183c094f70bbc553339708107"],
  ["assuranceTier: 2 to 3", () => ({ ...goldenTerms(), assuranceTier: 3 }),
    "0x728596d5ef3fe4cf0b279a3ced4a119245aae6b3b40d3cd62dccd97879f1e74e"],
  ["token: 0x05dc to 0x05dd", () => ({ ...goldenTerms(), token: "0x00000000000000000000000000000000000005dd" }),
    "0x922420a27eddfe9ecac1a271501323c0453842a4aa21b1cc1c0d189ab9812376"],
];

describe("termsHash v2.1: ratified Aug-6 GOLDEN and negative parity", () => {
  it("pins TERMS_DOMAIN, milestonesRoot and termsHash literally from the ratified document", () => {
    const terms = goldenTerms();
    expect(TERMS_DOMAIN).toBe(GOLDEN.domain);
    expect(mirrorUtf8("PCC:vnext:job-terms:v1")).toBe(GOLDEN.domain);
    expect(computeMilestonesRoot(terms.milestones)).toBe(GOLDEN.milestonesRoot);
    expect(computeTermsHash(terms)).toBe(GOLDEN.termsHash);
  });

  it.each(NEGATIVE_PARITY)("commits %s", (_label, mutate, expected) => {
    const terms = mutate();
    expect(mirrorTermsHash(terms)).toBe(expected);
    expect(computeTermsHash(terms)).toBe(expected);
    expect(computeTermsHash(terms)).not.toBe(GOLDEN.termsHash);
  });
});

const MIRROR_CASES: readonly [string, () => CanonicalJobTermsV1, Bytes32Hex, Bytes32Hex][] = [
  ["golden (two milestones)", goldenTerms, GOLDEN.milestonesRoot, GOLDEN.termsHash],
  ["one milestone", () => ({ ...goldenTerms(), milestones: [goldenTerms().milestones[0]] }),
    "0x51012cc25f2a40666230c93824727bd9c400ffde33a438b09d724084bbb34e5c",
    "0xa8ccc90c185d0d73aa4f6e4c6dcc1f59552f61e7e90746d3b076f07a7e3ced3d"],
  ["three milestones", () => {
    const terms = goldenTerms();
    return { ...terms, milestones: [...terms.milestones,
      { milestoneIndex: 2, stepId: mirrorUtf8("s2b-three-step-2"), amount: 123456, deadline: 2001000000 }] };
  }, "0x200f13518455da2a26b2c7bf9b83069365958dc2172cb1baae9a872fc2a355b9",
  "0x7dd56933bc53563ea84e0dde381395ad6f90893a327b5b2da7113e0fdd62b693"],
];

describe("termsHash independent noble keccak + handwritten ABI mirror", () => {
  it.each(MIRROR_CASES)("matches the producer for %s", (_label, input, root, termsHash) => {
    const terms = input();
    expect(mirrorMilestonesRoot(terms.milestones)).toBe(root);
    expect(computeMilestonesRoot(terms.milestones)).toBe(root);
    expect(mirrorTermsHash(terms)).toBe(termsHash);
    expect(computeTermsHash(terms)).toBe(termsHash);
  });

  it("admits uint spellings and the uint256/uint64 boundaries without rounding", () => {
    const terms: CanonicalJobTermsV1 = {
      ...goldenTerms(), assuranceTier: "0",
      milestones: [{ milestoneIndex: (1n << 256n) - 1n, stepId: mirrorUtf8("boundary"), amount: "0", deadline: (1n << 64n) - 1n }],
    };
    expect(computeMilestonesRoot(terms.milestones)).toBe(mirrorMilestonesRoot(terms.milestones));
    expect(computeTermsHash(terms)).toBe(mirrorTermsHash(terms));
    const sameIntegers: CanonicalJobTermsV1 = {
      ...terms, assuranceTier: 0n,
      milestones: [{ ...terms.milestones[0], milestoneIndex: ((1n << 256n) - 1n).toString(), amount: 0n,
        deadline: ((1n << 64n) - 1n).toString() }],
    };
    expect(computeTermsHash(sameIntegers)).toBe(computeTermsHash(terms));
    for (const amount of [(1n << 256n) - 1n, (1n << 200n) + 12345n]) {
      const wideAmountTerms = replaceFirst({ amount });
      expect(computeMilestonesRoot(wideAmountTerms.milestones)).toBe(mirrorMilestonesRoot(wideAmountTerms.milestones));
      expect(computeTermsHash(wideAmountTerms)).toBe(mirrorTermsHash(wideAmountTerms));
    }
  });

  it("accepts a shared index or shared stepId when the (milestoneIndex, stepId) pairs differ", () => {
    for (const change of [
      { milestoneIndex: goldenTerms().milestones[1].milestoneIndex },
      { stepId: goldenTerms().milestones[1].stepId },
    ]) {
      const terms = replaceFirst(change);
      expect(computeTermsHash(terms)).toBe(mirrorTermsHash(terms));
    }
  });

  it("hashes frozen inputs in their funded order without mutating them", () => {
    const terms = goldenTerms();
    const milestones = Object.freeze(terms.milestones.map((milestone) => Object.freeze({ ...milestone })));
    const frozen = Object.freeze({ ...terms, milestones });
    expect(computeMilestonesRoot(milestones)).toBe(GOLDEN.milestonesRoot);
    expect(computeTermsHash(frozen)).toBe(GOLDEN.termsHash);
    expect(frozen.milestones.map((milestone) => milestone.milestoneIndex)).toEqual([1, 0]);
  });
});

function expectMilestonesRefused(input: unknown): void {
  const milestones = input as readonly CanonicalMilestoneTermsV1[];
  expect(() => computeMilestonesRoot(milestones)).toThrow(AcceptedPolicyDigestInputError);
  expect(() => computeTermsHash({ ...goldenTerms(), milestones })).toThrow(AcceptedPolicyDigestInputError);
}

describe("termsHash fail-closed validation", () => {
  it("refuses an empty funded milestone list", () => {
    expectMilestonesRefused([]);
  });

  it.each([4, 255, 256, -1, 1.5, "1e0", " 1", "+1"])("refuses invalid assurance tier %s", (assuranceTier) => {
    expect(() => computeTermsHash({ ...goldenTerms(), assuranceTier })).toThrow(AcceptedPolicyDigestInputError);
  });

  const badMilestoneFields: readonly [string, Partial<CanonicalMilestoneTermsV1>][] = [
    ["deadline 2^64", { deadline: 1n << 64n }],
    ["negative deadline", { deadline: -1 }],
    ["fractional deadline", { deadline: 1.5 }],
    ["negative amount", { amount: -1 }],
    ["fractional amount", { amount: 0.5 }],
    ["amount with decimal point", { amount: "0.75" }],
    ["amount with exponent", { amount: "75e4" }],
    ["signed amount", { amount: "+750000" }],
    ["whitespace amount", { amount: " 750000" }],
    ["amount 2^256", { amount: 1n << 256n }],
    ["unsafe number amount", { amount: Number.MAX_SAFE_INTEGER + 1 }],
    ["milestoneIndex 2^256", { milestoneIndex: 1n << 256n }],
    ["negative milestoneIndex", { milestoneIndex: -1 }],
    ["uppercase stepId", { stepId: `0x${"A".repeat(64)}` }],
    ["short stepId", { stepId: "0x12" }],
  ];
  it.each(badMilestoneFields)("refuses %s in both public producers", (_label, change) => {
    expectMilestonesRefused(replaceFirst(change).milestones);
  });

  it.each(["0x12", "0x" + "g".repeat(40), "0x" + "A".repeat(40), "00".repeat(20)])("refuses malformed token %s", (token) => {
    expect(() => computeTermsHash({ ...goldenTerms(), token: token as `0x${string}` })).toThrow(AcceptedPolicyDigestInputError);
  });

  it("refuses an EIP-55 checksummed token with the terms.token field", () => {
    const terms: CanonicalJobTermsV1 = {
      ...goldenTerms(), token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    };
    expect(() => computeTermsHash(terms)).toThrow(AcceptedPolicyDigestInputError);
    expect(() => computeTermsHash(terms)).toThrow(expect.objectContaining({ field: "terms.token" }));
  });

  it("refuses a mixed-case stepId with the milestones[0].stepId field", () => {
    const terms = replaceFirst({ stepId: `0x${"aB".repeat(32)}` });
    expect(() => computeTermsHash(terms)).toThrow(AcceptedPolicyDigestInputError);
    expect(() => computeTermsHash(terms)).toThrow(expect.objectContaining({ field: "milestones[0].stepId" }));
  });

  it("refuses duplicate funded pairs, including equivalent uint spellings, without deduplicating", () => {
    const [first, second] = goldenTerms().milestones;
    expectMilestonesRefused([first, { ...first }]);
    expectMilestonesRefused([first, second, { ...first, milestoneIndex: "1", amount: "600000", deadline: "2000500000" }]);
  });

  it("refuses malformed milestone arrays and objects before invoking caller code", () => {
    let userCodeCalls = 0;
    const original = goldenTerms().milestones[0];
    const accessorList = [original];
    Object.defineProperty(accessorList, "0", { enumerable: true, get() { userCodeCalls++; return original; } });
    const accessorMilestone = { ...original };
    Object.defineProperty(accessorMilestone, "amount", { enumerable: true, get() { userCodeCalls++; return 600000; } });
    const hiddenList = [original];
    Object.defineProperty(hiddenList, "0", { enumerable: false, value: original });
    const sparseList = new Array(1);
    const holeWithExtra = Object.assign(new Array(1), { extra: original });
    const throwingTraps: ProxyHandler<object> = {
      get() { userCodeCalls++; throw new Error("caller get trap ran"); },
      getPrototypeOf() { userCodeCalls++; throw new Error("caller prototype trap ran"); },
      ownKeys() { userCodeCalls++; throw new Error("caller ownKeys trap ran"); },
      getOwnPropertyDescriptor() { userCodeCalls++; throw new Error("caller descriptor trap ran"); },
    };
    const proxyList = new Proxy([original], throwingTraps);
    const proxyMilestone = new Proxy({ ...original }, throwingTraps);
    const revoked = Proxy.revocable([original], {});
    revoked.revoke();
    const inheritedMilestone = Object.create({ ...original }) as CanonicalMilestoneTermsV1;
    const hiddenMilestone = { ...original };
    Object.defineProperty(hiddenMilestone, "amount", { enumerable: false, value: original.amount });
    for (const input of [
      null, {}, "not an array", sparseList, holeWithExtra, hiddenList, accessorList,
      Object.assign([original], { extra: true }), proxyList, revoked.proxy,
      [accessorMilestone], [proxyMilestone], [inheritedMilestone], [hiddenMilestone],
      [null], [[original]], [new Date()], [{ ...original, extra: true }],
    ]) expectMilestonesRefused(input);
    expect(userCodeCalls).toBe(0);
  });

  it("refuses top-level Proxy and accessor terms without invoking caller code", () => {
    let userCodeCalls = 0;
    const terms = goldenTerms();
    const accessor = { ...terms };
    Object.defineProperty(accessor, "milestones", { enumerable: true, get() { userCodeCalls++; return terms.milestones; } });
    const proxy = new Proxy(terms, {
      get() { userCodeCalls++; throw new Error("caller get trap ran"); },
      getPrototypeOf() { userCodeCalls++; throw new Error("caller prototype trap ran"); },
      ownKeys() { userCodeCalls++; throw new Error("caller ownKeys trap ran"); },
      getOwnPropertyDescriptor() { userCodeCalls++; throw new Error("caller descriptor trap ran"); },
    });
    const revoked = Proxy.revocable(terms, {});
    revoked.revoke();
    for (const input of [accessor, proxy, revoked.proxy, { ...terms, extra: true }, Object.create(terms)]) {
      expect(() => computeTermsHash(input as CanonicalJobTermsV1)).toThrow(AcceptedPolicyDigestInputError);
    }
    expect(userCodeCalls).toBe(0);
  });
});

describe("Thursday-shape oracle golden v2 (bus #8239)", () => {
  it("pins the published v2 values through production exports and the in-test mirror", () => {
    // Published VALUES only (bus #8239); the golden file's SHA-256 changes with label edits (bus #8684).
    const expected = {
      termsDomain: "0xaf4cf568beb02a9dca015909829c12f5eb22b355111bdf85603e98da8a43c141",
      policyDomain: "0x8d536e66f7b4f5e2bc52f123fc7589f433a75b2bd4c278bd32651e17e2a8b0e0",
      milestonesRoot: "0x16bb1546dd13804dd874e718b41d1375d606ca1ebe6650a5db23b09a682bedc2",
      termsHash: "0x3f8dbb379a2ff55a557a24aba75661166d03898dec2b0745747b3755d69f64ae",
      // Vector A's subject block is unchanged in v2.
      subjectBlockHash: "0x4f166a59dc4e7f8f805ca04b62005a3aade04ae4202ac936c2749d6355830cdf",
      bindingsRoot: "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd",
      acceptedPolicyDigest: "0x6814b378016fd7f40c1e72aa98187b14656338f002ab2774fa86d9ed9361fe23",
    } as const;
    const terms: CanonicalJobTermsV1 = {
      token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      assuranceTier: 1,
      milestones: [{ milestoneIndex: 0, stepId: `0x${"51".repeat(32)}`, amount: 750000,
        deadline: 1793836800 }], // reclaimAt = build time 1792022400 + 1814400.
    };
    expect(TERMS_DOMAIN).toBe(expected.termsDomain);
    expect(TERMS_DOMAIN).toBe(mirrorUtf8("PCC:vnext:job-terms:v1"));
    expect(POLICY_DOMAIN).toBe(expected.policyDomain);
    expect(POLICY_DOMAIN).toBe(mirrorUtf8("PCC:vnext:accepted-job-policy:v1"));
    const milestonesRoot = computeMilestonesRoot(terms.milestones);
    expect(milestonesRoot).toBe(expected.milestonesRoot);
    expect(milestonesRoot).toBe(mirrorMilestonesRoot(terms.milestones));
    const termsHash = computeTermsHash(terms);
    expect(termsHash).toBe(expected.termsHash);
    expect(termsHash).toBe(mirrorTermsHash(terms));
    const bindingsRoot = computeBindingsRoot([]);
    expect(bindingsRoot).toBe(expected.bindingsRoot);
    expect(bindingsRoot).toBe(mirrorHash(mirrorWords([mirrorUint(32), mirrorUint(0)])));
    const { subjectBlockHash } = expected;
    const acceptedPolicyDigest = computeAcceptedPolicyDigest({ termsHash, subjectBlockHash, bindingsRoot });
    expect(acceptedPolicyDigest).toBe(expected.acceptedPolicyDigest);
    expect(acceptedPolicyDigest).toBe(mirrorHash(mirrorWords([
      mirrorHex(mirrorUtf8("PCC:vnext:accepted-job-policy:v1")), mirrorUint(1),
      mirrorHex(mirrorTermsHash(terms)), mirrorHex(subjectBlockHash), mirrorHex(expected.bindingsRoot),
    ])));
    // #8144 digest, retired: its termsHash input was a file digest.
    const retiredDigest = "0xd85ae6b3c2be54febf8a8297ed23f010019c1ba922f9784a8de24e3e59b6d7ae";
    expect(acceptedPolicyDigest).not.toBe(retiredDigest);
  });
});

describe("evidence-made EXAMPLE (not the oracle's vector) using the ratified termsHash producer", () => {
  it("pins the EXAMPLE termsHash and resulting acceptedPolicyDigest", () => {
    // EXAMPLE only: the real stepId and reclaimAt are per policy. The published oracle
    // golden v2 is pinned in the separate Thursday-shape block above (bus #8239).
    const terms: CanonicalJobTermsV1 = {
      token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", // Base Sepolia Circle USDC
      assuranceTier: 1,
      milestones: [{ milestoneIndex: 0, stepId: mirrorUtf8("s2b-example-print-step"), amount: 750000, deadline: 1762000000 }],
    };
    const subjectBlockHash: Bytes32Hex = "0x4f166a59dc4e7f8f805ca04b62005a3aade04ae4202ac936c2749d6355830cdf";
    const expectedTermsHash: Bytes32Hex = "0x05076e9d36a78540b1157f05772316b539de34e793bea351f79ac7e196ef03e3";
    const expectedDigest: Bytes32Hex = "0x81fcc6a6133f265f845ee663e22997dabac7668107aafaab0c13429d827d0b49";
    expect(terms.milestones[0].stepId).toBe("0x069acf878cbc26dd74471159d7cdc444cd41f8a6f7c50c373ab3acc19b80a7aa");
    expect(computeMilestonesRoot(terms.milestones)).toBe("0xc444cd90019afc1d003f503071d04212877e706fad81da0dda1a2c60a0576e71");
    expect(mirrorTermsHash(terms)).toBe(expectedTermsHash);
    const termsHash = computeTermsHash(terms);
    expect(termsHash).toBe(expectedTermsHash);
    const bindingsRoot = computeBindingsRoot([]);
    expect(bindingsRoot).toBe("0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd");
    const mirrorDigest = mirrorHash(mirrorWords([
      mirrorHex(mirrorUtf8("PCC:vnext:accepted-job-policy:v1")), mirrorUint(1),
      mirrorHex(expectedTermsHash), mirrorHex(subjectBlockHash), mirrorHex(bindingsRoot),
    ]));
    expect(mirrorDigest).toBe(expectedDigest);
    expect(computeAcceptedPolicyDigest({ termsHash, subjectBlockHash, bindingsRoot })).toBe(expectedDigest);
  });
});
