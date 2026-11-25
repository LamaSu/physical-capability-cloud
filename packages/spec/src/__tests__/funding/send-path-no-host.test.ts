import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as sha3 from "@noble/hashes/sha3";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAddress, zeroAddress, zeroHash, type Address } from "viem";
import * as H from "../../evidence/accepted-policy.js";
import * as evidence from "../../evidence/index.js";
import * as root from "../../index.js";
import * as funding from "../../funding/index.js";
import * as dryH from "../../funding/dry-run-unit.js";
import { formatOperatorPrincipalId, principalTupleWord } from "../../evidence/principal-id.js";

type EvidenceModule = typeof H;
type DryModule = typeof dryH;
let N: EvidenceModule;
let dryN: DryModule;
beforeAll(async () => {
  const realProcess = globalThis.process;
  vi.resetModules();
  vi.stubGlobal("process", { ...realProcess, getBuiltinModule: undefined });
  try {
    N = await import("../../evidence/accepted-policy.js");
    dryN = await import("../../funding/dry-run-unit.js");
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

const OPERATOR: Address = "0x1111111111111111111111111111111111111111";
const WALLET: Address = "0x2222222222222222222222222222222222222222";
const OTHER: Address = "0x0000000000000000000000000000000000000bad";
const ONE = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SUBJECT_HASH = "0x3fe34ba95c62233e0b2f8c96b9d76f7f8f87a88b75faa92b129a7ef7084942d3";
const EMPTY_ROOT = "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd";
const TERMS = "0xabababababababababababababababababababababababababababababababab";
const DIGEST = "0x612f0f1a5714d6b45370bd89b52df1423f14979148f06665becd003abdf1cab1";
const RUNTIME_MESSAGE = "acceptedPolicyDigest input runtime: accepted-policy needs Node's util.types.isProxy (Node >= 20.16 / 22.3) to refuse code-running input; it is unavailable in this runtime";
const EXACT_KEYS_MESSAGE = "BAD_EXPECTATION: acceptedPolicyDigest input subject: expected exactly the keys [payer, operatorPrincipal, operatorSettlementAddress, authorizedTuplesRoot, expertSetRoot, executorSetRoot, expectedRecipient, targetSystemIdentity, committedProgramHash, recipeRef, sampleManifestRef, childrenRoot, operatingEnvelopeHash, expectedRouteArea, expectedLocationHash, captureNonceAnchor, challengeAnchor, integrityGrade]";
const publicWord = (a: Address) => principalTupleWord("operator", formatOperatorPrincipalId(84532, a));
function subjectFor(operator: Address = OPERATOR): H.SubjectBlockFields {
  return {
    payer: publicWord(WALLET), operatorPrincipal: publicWord(operator),
    operatorSettlementAddress: operator.toLowerCase() as Address, authorizedTuplesRoot: ONE,
    committedProgramHash: zeroHash, integrityGrade: 0,
    childrenRoot: zeroHash, expertSetRoot: zeroHash, executorSetRoot: zeroHash,
    expectedRecipient: zeroHash, targetSystemIdentity: zeroHash, recipeRef: zeroHash,
    sampleManifestRef: zeroHash, operatingEnvelopeHash: zeroHash, expectedRouteArea: zeroHash,
    expectedLocationHash: zeroHash, captureNonceAnchor: zeroHash, challengeAnchor: zeroHash,
  };
}
const input = (subject: unknown = subjectFor(), bindings: unknown = [], operator = OPERATOR) => ({
  jobId: "send-path", operator, fundingWallet: WALLET, subject: subject as H.SubjectBlockFields,
  bindings: bindings as H.SubjectBinding[], latestBlockTimestamp: 1_800_000_000n,
});
const GOLDEN = {
  jobId: "send-path", operator: OPERATOR, payer: WALLET, payees: [OPERATOR], maxFeeBps: 0,
  feeRecipients: [zeroAddress], tiers: [1],
  termsHash: { derive: "v2.1", token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", assuranceTier: 1 },
  acceptedPolicyDigest: { subjectBlockHash: SUBJECT_HASH, bindingsRoot: EMPTY_ROOT },
  compositionRoots: [zeroHash], compositionSchemaVersion: 0, unitCount: 1, unitGross: 1_000_000n,
  unitPayouts: [{ recipient: OPERATOR, amount: 1_000_000n }], chainId: 84532n,
  earliestReclaimAt: 1_800_004_500n, latestReclaimAt: 1_800_007_800n,
};
function result(call: () => unknown): unknown {
  try { return { value: call() }; }
  catch (error) {
    const e = error as Error & { code?: string; field?: string };
    return { error: { name: e.name, code: e.code, field: e.field, message: e.message } };
  }
}
const refusal = (code: string, message: string) => ({ error: { name: "FundingRefusal", code, field: undefined, message } });
const bad = (message: string) => refusal("BAD_EXPECTATION", message);
const proxyRefusal = (field: string) => bad(`BAD_EXPECTATION: acceptedPolicyDigest input ${field}: is a Proxy: its traps run code, so it is refused before it is read`);
const binding: H.SubjectBinding = { planUnitKey: ONE, requirementIdHash: ONE, sourceKind: 0, propositionKind: 0, valueRef: ONE };

// These outcomes were recorded from the host instance before changing the send path.
describe("C1b: descriptor admission in both instances", () => {
  const cases: Array<[string, () => ReturnType<typeof input>, unknown]> = [
    ["null prototype", () => input(Object.assign(Object.create(null), subjectFor())), { value: GOLDEN }],
    ["class instance", () => input(Object.assign(new class Subject {}, subjectFor())),
      bad("BAD_EXPECTATION: acceptedPolicyDigest input subject: expected a plain object (not an array, Proxy or class instance)")],
    ["non-enumerable", () => input(Object.defineProperty(subjectFor(), "payer", { enumerable: false })),
      bad("BAD_EXPECTATION: acceptedPolicyDigest input subject.payer: accessor or non-enumerable properties are not accepted; pass plain data")],
    ["extra key", () => input({ ...subjectFor(), extra: true }), bad(EXACT_KEYS_MESSAGE)],
    ["missing key", () => { const s: Partial<H.SubjectBlockFields> = subjectFor(); delete s.payer; return input(s); }, bad(EXACT_KEYS_MESSAGE)],
    ["symbol key", () => { const s: Record<PropertyKey, unknown> = { ...subjectFor() }; delete s.payer; s[Symbol("extra")] = zeroHash; return input(s); },
      bad("BAD_EXPECTATION: acceptedPolicyDigest input subject: unknown key Symbol(extra)")],
    ...[0, 0n, "0"].map((integrityGrade): [string, () => ReturnType<typeof input>, unknown] =>
      [`integrityGrade ${typeof integrityGrade}`, () => input({ ...subjectFor(), integrityGrade }), { value: GOLDEN }]),
    ["sparse bindings", () => input(subjectFor(), Array(1)),
      bad("BAD_EXPECTATION: acceptedPolicyDigest input bindings: expected a dense array with no extra or missing elements")],
    ["one valid binding", () => input(subjectFor(), [binding]),
      refusal("INTENT_MISMATCH", "INTENT_MISMATCH: dry-run bindings must be exactly []; this unit admits no subject bindings")],
  ];
  it.each(cases)("%s", (_name, build, recorded) => {
    expect(result(() => dryH.dryRunUnitTestnetExpectation(build()))).toEqual(recorded);
    expect(result(() => dryN.dryRunUnitTestnetExpectation(build()))).toEqual(recorded);
  });
  it.each(["payer", "operatorSettlementAddress"])("getter on %s never runs", (field) => {
    for (const api of [dryH, dryN]) {
      const getter = vi.fn(() => zeroHash);
      const subject = Object.defineProperty(subjectFor(), field, { enumerable: true, get: getter });
      expect(result(() => api.dryRunUnitTestnetExpectation(input(subject)))).toEqual(bad(
        `BAD_EXPECTATION: acceptedPolicyDigest input subject.${field}: accessor or non-enumerable properties are not accepted; pass plain data`));
      expect(getter).not.toHaveBeenCalled();
    }
  });
  it("accessor binding index never runs", () => {
    for (const api of [dryH, dryN]) {
      const getter = vi.fn(() => binding);
      const bindings = Object.defineProperty([], "0", { enumerable: true, get: getter });
      expect(result(() => api.dryRunUnitTestnetExpectation(input(subjectFor(), bindings)))).toEqual(bad(
        "BAD_EXPECTATION: acceptedPolicyDigest input bindings[0]: is an accessor: a getter runs code, so it is refused before it is read"));
      expect(getter).not.toHaveBeenCalled();
    }
  });
});

describe("C3: public producers still need the host check", () => {
  it.each(["subject", "bindings", "digest"] as const)("%s refuses in N", (kind) => {
    const calls = {
      subject: () => N.computeSubjectBlockHash(subjectFor()), bindings: () => N.computeBindingsRoot([]),
      digest: () => N.computeAcceptedPolicyDigest({ termsHash: TERMS, subjectBlockHash: SUBJECT_HASH, bindingsRoot: EMPTY_ROOT }),
    };
    expect(result(calls[kind])).toEqual({ error: { name: "AcceptedPolicyDigestInputError", code: undefined, field: "runtime", message: RUNTIME_MESSAGE } });
  });
});

function counted<T extends object>(target: T, overrides: ProxyHandler<T> = {}) {
  const traps = {
    get: vi.fn((t: T, key: PropertyKey, receiver: unknown) => Reflect.get(t, key, receiver)),
    getPrototypeOf: vi.fn((t: T) => Reflect.getPrototypeOf(t)),
    ownKeys: vi.fn((t: T) => Reflect.ownKeys(t)),
    getOwnPropertyDescriptor: vi.fn((t: T, key: PropertyKey) => Reflect.getOwnPropertyDescriptor(t, key)),
  };
  return { proxy: new Proxy(target, { ...traps, ...overrides }), traps };
}
describe("C4: Proxy admission and single snapshot use", () => {
  it.each(["subject", "bindings"])("H refuses a Proxy %s before any trap", (kind) => {
    const { proxy, traps } = counted(kind === "subject" ? subjectFor() : []);
    expect(result(() => dryH.dryRunUnitTestnetExpectation(kind === "subject" ? input(proxy) : input(subjectFor(), proxy))))
      .toEqual(proxyRefusal(kind));
    for (const trap of Object.values(traps)) expect(trap).not.toHaveBeenCalled();
  });
  it.each(["subject", "bindings"])("N admits a pass-through Proxy %s without get", (kind) => {
    const { proxy, traps } = counted(kind === "subject" ? subjectFor() : []);
    const value = dryN.dryRunUnitTestnetExpectation(kind === "subject" ? input(proxy) : input(subjectFor(), proxy));
    expect(value).toEqual(GOLDEN);
    expect(value).toEqual(dryH.dryRunUnitTestnetExpectation(input()));
    expect(traps.get).not.toHaveBeenCalled();
    expect(traps.getOwnPropertyDescriptor).toHaveBeenCalled();
  });
  it.each(["L1", "L2", "L3"] as const)("N %s uses the first settlement address throughout", (cell) => {
    const operator = getAddress("0x036cbd53842c5426634e7929541ec2318f3dcf7e");
    const first = cell === "L1" ? OTHER : cell === "L3" ? operator : operator.toLowerCase();
    const later = cell === "L1" ? operator.toLowerCase() : OTHER;
    let reads = 0;
    const descriptor = vi.fn((target: H.SubjectBlockFields, key: PropertyKey) => {
      const value = Reflect.getOwnPropertyDescriptor(target, key);
      return key === "operatorSettlementAddress" ? { ...value, value: ++reads === 1 ? first : later } : value;
    });
    const { proxy, traps } = counted(subjectFor(operator), { getOwnPropertyDescriptor: descriptor });
    const plain = { ...subjectFor(operator), operatorSettlementAddress: first as Address };
    const expected = result(() => dryH.dryRunUnitTestnetExpectation(input(plain, [], operator)));
    if (cell === "L1") expect(expected).toEqual(refusal("INTENT_MISMATCH",
      "INTENT_MISMATCH: dry-run subject.operatorSettlementAddress is 0x0000000000000000000000000000000000000bad; the buyer expects 0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
    else expect(expected).toEqual({ value: {
      ...GOLDEN, operator, payees: [operator], unitPayouts: [{ recipient: operator, amount: 1_000_000n }],
      acceptedPolicyDigest: {
        subjectBlockHash: "0x856fb6f1ffe9977fe9727ff3e19fd9c5657e74f6f9087a23be52a0d3777f4b16",
        bindingsRoot: EMPTY_ROOT,
      },
    } });
    expect(result(() => dryN.dryRunUnitTestnetExpectation(input(proxy, [], operator)))).toEqual(expected);
    expect(traps.get).not.toHaveBeenCalled();
    expect(reads).toBe(2); // One value read and one enumerability check in the admission pass.
  });
  it("N counts the bindings snapshot without reading the caller's length", () => {
    const get = vi.fn((target: unknown[], key: PropertyKey, receiver: unknown) => key === "length" ? 1 : Reflect.get(target, key, receiver));
    const { proxy } = counted([], { get });
    expect(dryN.dryRunUnitTestnetExpectation(input(subjectFor(), proxy))).toEqual(GOLDEN);
    expect(get).not.toHaveBeenCalled();
  });
  it("a revoked Proxy is refused in H and its TypeError propagates unchanged in N", () => {
    const revoked = Proxy.revocable(subjectFor(), {}); revoked.revoke();
    expect(result(() => dryH.dryRunUnitTestnetExpectation(input(revoked.proxy)))).toEqual(proxyRefusal("subject"));
    expect(() => dryN.dryRunUnitTestnetExpectation(input(revoked.proxy))).toThrow(TypeError);
  });
  it("N propagates the exact error thrown by a descriptor trap; H runs no trap", () => {
    const fault = new Error("descriptor trap fault");
    const trap = vi.fn(() => { throw fault; });
    const { proxy } = counted(subjectFor(), { getOwnPropertyDescriptor: trap });
    expect(result(() => dryH.dryRunUnitTestnetExpectation(input(proxy)))).toEqual(proxyRefusal("subject"));
    expect(trap).not.toHaveBeenCalled();
    let caught: unknown;
    try { dryN.dryRunUnitTestnetExpectation(input(proxy)); } catch (error) { caught = error; }
    expect(caught).toBe(fault);
  });
});

describe("C5a: roots words preserve bytes and refusals", () => {
  const roots = { termsHash: TERMS, subjectBlockHash: SUBJECT_HASH, bindingsRoot: EMPTY_ROOT };
  it("has the recorded digest in H and N", () => {
    expect(H.computeAcceptedPolicyDigest(roots)).toBe(DIGEST);
    for (const api of [H, N]) expect(api.acceptedPolicyDigestOfRoots(TERMS, SUBJECT_HASH, EMPTY_ROOT)).toBe(DIGEST);
  });
  const invalid = [
    ["uppercase", "0xABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABAB"],
    ["short", "0x12"], ["non-hex", "0xgggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg"], ["non-string", {}],
  ] as const;
  it.each((Object.keys(roots) as Array<keyof typeof roots>).flatMap((field) => invalid.map(([kind, value]) => ({ field, kind, value }))))(
    "$field $kind", ({ field, value }) => {
      const values = { ...roots, [field]: value };
      const recorded = { error: { name: "AcceptedPolicyDigestInputError", code: undefined, field: `inputs.${field}`,
        message: `acceptedPolicyDigest input inputs.${field}: expected 0x + 64 lowercase hex characters` } };
      expect(result(() => H.computeAcceptedPolicyDigest(values as H.AcceptedPolicyDigestInputs))).toEqual(recorded);
      for (const api of [H, N]) {
        expect(result(() => api.acceptedPolicyDigestOfRoots(values.termsHash, values.subjectBlockHash, values.bindingsRoot))).toEqual(recorded);
      }
    });
});

describe("C6: the evidence module loads with no process global", () => {
  it("loads the module itself in a browser-like VM and hashes the snapshot", () => {
    const source = readFileSync(new URL("../../evidence/accepted-policy.ts", import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    const exports: Record<string, unknown> = {};
    runInNewContext(outputText, {
      exports, process: undefined, Uint8Array, TextEncoder,
      require: (id: string) => { if (id === "@noble/hashes/sha3") return sha3; throw new Error(`unexpected import ${id}`); },
    });
    const api = exports as EvidenceModule;
    expect(api.subjectBlockHashOfSnapshot(api.snapshotSubjectBlock(subjectFor()))).toBe(SUBJECT_HASH);
    expect(result(() => api.computeSubjectBlockHash(subjectFor()))).toEqual({ error: {
      name: "AcceptedPolicyDigestInputError", code: undefined, field: "runtime", message: RUNTIME_MESSAGE,
    } });
  });
});

const INTERNAL = ["SubjectBlockSnapshot", "snapshotSubjectBlock", "subjectBlockHashOfSnapshot", "bindingsRootAndCount", "acceptedPolicyDigestOfRoots"];
const PUBLIC_VALUES = [
  "AcceptedPolicyDigestInputError", "SUBJECT_DOMAIN", "POLICY_DOMAIN", "PLANUNIT_DOMAIN", "TERMS_DOMAIN", "POLICY_VERSION",
  "computeMilestonesRoot", "computeTermsHash", "computeSubjectBlockHash", "computeAuthorizedTuplesRoot",
  "canonicalAuthorizedTuples", "computeBindingsRoot", "computeAcceptedPolicyDigest", "computePlanUnitKey",
] as const;
const PUBLIC_TYPES = ["Bytes32Hex", "AddressHex", "UintInput", "CanonicalMilestoneTermsV1", "CanonicalJobTermsV1", "SubjectBlockFields", "SubjectBinding", "AcceptedPolicyDigestInputs"];
describe("C7: package exports stay unchanged", () => {
  it("keeps all five internal names out of every public entrypoint", () => {
    for (const api of [root, evidence, funding]) for (const name of INTERNAL) expect(api).not.toHaveProperty(name);
    for (const name of PUBLIC_VALUES) {
      expect(root[name]).toBe(H[name]);
      expect(evidence[name]).toBe(H[name]);
    }
  });
  it("names exactly the public value and type declarations in the evidence index", () => {
    const source = readFileSync(new URL("../../evidence/accepted-policy.ts", import.meta.url), "utf8");
    const index = readFileSync(new URL("../../evidence/index.ts", import.meta.url), "utf8");
    const declarations = [...source.matchAll(/^export\s+(?:type|interface|class|const|function)\s+(\w+)/gm)].map((match) => match[1]!);
    expect(declarations.filter((name) => !INTERNAL.includes(name)).sort()).toEqual([...PUBLIC_VALUES, ...PUBLIC_TYPES].sort());
    const lists = [...index.matchAll(/export\s+(type\s+)?\{([^}]+)\}\s+from\s+"\.\/accepted-policy\.js"/g)];
    const names = (isType: boolean) => lists.filter((match) => Boolean(match[1]) === isType).flatMap((match) => match[2]!.split(",").map((name) => name.trim()).filter(Boolean));
    expect(names(false).sort()).toEqual([...PUBLIC_VALUES].sort());
    expect(names(true).sort()).toEqual([...PUBLIC_TYPES].sort());
    expect([...names(false), ...names(true)].sort()).toEqual(declarations.filter((name) => !INTERNAL.includes(name)).sort());
    expect(index).not.toMatch(/export\s+\*\s+from\s+"\.\/accepted-policy\.js"/);
  });
});
