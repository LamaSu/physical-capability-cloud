/**
 * Tests for evidence/accepted-policy.ts (implementer-uniform).
 *
 * The golden-vector section re-derives the #270 mirror's intermediate sub-root
 * values (authorizedTuplesRoot, expertSetRoot, ...) from its own "golden-*"
 * literals using a small, test-only, pure-JS ABI encoder — NOT the shipped
 * module (computing those sub-roots from raw sets is explicitly out of Layer
 * 1's scope; see the module header in ../evidence/accepted-policy.ts). This
 * avoids hand-transcribing 64-character hex constants: the three PUBLISHED
 * digests below (EXPECT) are copied verbatim from
 * packages/verifier/test-vectors/canonical-acceptedjobpolicy-v1-mirror.cjs on
 * #270 (wt-evidence-270), and are the only "trust me" constants in this file.
 */
import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  AcceptedPolicyDigestInputError,
  POLICY_DOMAIN,
  POLICY_VERSION,
  PLANUNIT_DOMAIN,
  SUBJECT_DOMAIN,
  computeAcceptedPolicyDigest,
  computeBindingsRoot,
  computePlanUnitKey,
  computeSubjectBlockHash,
  type AcceptedPolicyDigestInputs,
  type SubjectBinding,
  type SubjectBlockFields,
} from "../evidence/accepted-policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test-only mirror of canonical-acceptedjobpolicy-v1-mirror.cjs's PRE-digest
// computations (the raw sets -> roots), so the fixtures below are derived, not
// hand-copied. Verified (scratch script, not shipped) to reproduce the
// mirror's published EXPECT constants byte-exact before this file was written.
// ─────────────────────────────────────────────────────────────────────────────
const utf8 = new TextEncoder();
function bytesToHex(b: Uint8Array): `0x${string}` {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as `0x${string}`;
}
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function K(label: string): `0x${string}` {
  return bytesToHex(keccak_256(utf8.encode(label)));
}
function addr(n: bigint): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}
function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
const WORD = 32;
function wordUint(v: bigint): Uint8Array {
  const out = new Uint8Array(WORD);
  let x = v;
  for (let i = WORD - 1; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}
function wordInt(v: bigint): Uint8Array {
  const mod = 1n << 256n;
  return wordUint(((v % mod) + mod) % mod);
}
function wordBytes32(hex: string): Uint8Array {
  return hexToBytes(hex);
}
function wordAddress(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(hexToBytes(hex), 12);
  return out;
}
function abiSingleArray(elements: Uint8Array[][]): Uint8Array {
  const parts = [wordUint(32n), wordUint(BigInt(elements.length))];
  for (const el of elements) for (const w of el) parts.push(w);
  return concatBytes(...parts);
}
function rootOfTuple3Set(tuples: readonly [string, string, string][]): `0x${string}` {
  return bytesToHex(keccak_256(abiSingleArray(tuples.map((t) => t.map(wordBytes32)))));
}
function rootOfBytes32Set(xs: readonly string[]): `0x${string}` {
  return bytesToHex(keccak_256(abiSingleArray(xs.map((x) => [wordBytes32(x)]))));
}
const sortHex = (a: string[]) => [...new Set(a.map((x) => x.toLowerCase()))].sort();
const sortTup = <T>(a: T[]) => [...a].sort((x, y) => (JSON.stringify(x).toLowerCase() < JSON.stringify(y).toLowerCase() ? -1 : 1));

const mirrorPayer = K("golden-payer");
const mirrorOperatorPrincipal = K("golden-operator");
const mirrorOperatorSettlementAddress = addr(0x0a71n);
const mirrorAuthorizedTuples = sortTup<[string, string, string]>([[mirrorOperatorPrincipal, K("golden-kernel"), K("golden-device")]]);
const mirrorAuthorizedTuplesRoot = rootOfTuple3Set(mirrorAuthorizedTuples);
const mirrorExpertSetRoot = rootOfBytes32Set(sortHex([K("golden-expert-1")]));
const mirrorExecutorSetRoot = rootOfBytes32Set(sortHex([K("golden-exec-1")]));
const mirrorExpectedRecipient = K("golden-recipient");
const mirrorTargetSystemIdentity = K("golden-target-system");
const mirrorCommittedProgramHash = K("golden-program");
const mirrorRecipeRef = K("golden-recipe");
const mirrorSampleManifestRef = K("golden-sample-manifest");
const mirrorChildren = sortTup<[string, string]>([[K("golden-child-job"), addr(0xc41dn)]]);
const mirrorChildrenRoot = bytesToHex(keccak_256(abiSingleArray(mirrorChildren.map(([j, e]) => [wordBytes32(j), wordAddress(e)]))));
const mirrorOperatingEnvelopeHash = bytesToHex(
  keccak_256(
    abiSingleArray([
      [wordBytes32(K("power")), wordUint(0n), wordUint(1000n)],
      [wordBytes32(K("temp")), wordUint(0n), wordUint(250n)],
    ]),
  ),
);
const mirrorExpectedRouteArea = K("golden-route-area");
const mirrorExpectedLocationHash = bytesToHex(
  keccak_256(concatBytes(wordInt(377749000n), wordInt(-1224194000n), wordUint(500n), wordUint(1700000000n))),
);
const mirrorCaptureNonceAnchor = K("golden-capture-nonce");
const mirrorChallengeAnchor = K("golden-challenge-anchor");

/** The #270 mirror's golden subject block, as `computeSubjectBlockHash`'s declared input shape. */
const GOLDEN_SUBJECT: SubjectBlockFields = {
  payer: mirrorPayer,
  operatorPrincipal: mirrorOperatorPrincipal,
  operatorSettlementAddress: mirrorOperatorSettlementAddress,
  authorizedTuplesRoot: mirrorAuthorizedTuplesRoot,
  expertSetRoot: mirrorExpertSetRoot,
  executorSetRoot: mirrorExecutorSetRoot,
  expectedRecipient: mirrorExpectedRecipient,
  targetSystemIdentity: mirrorTargetSystemIdentity,
  committedProgramHash: mirrorCommittedProgramHash,
  recipeRef: mirrorRecipeRef,
  sampleManifestRef: mirrorSampleManifestRef,
  childrenRoot: mirrorChildrenRoot,
  operatingEnvelopeHash: mirrorOperatingEnvelopeHash,
  expectedRouteArea: mirrorExpectedRouteArea,
  expectedLocationHash: mirrorExpectedLocationHash,
  captureNonceAnchor: mirrorCaptureNonceAnchor,
  challengeAnchor: mirrorChallengeAnchor,
  integrityGrade: 2,
};

const mirrorPuk0 = bytesToHex(
  keccak_256(concatBytes(wordBytes32(K("PCC:vnext:plan-unit-key:v1")), wordUint(0n), wordUint(0n), wordBytes32(K("golden-step-0")))),
);
const Z32 = `0x${"00".repeat(32)}` as const;
/** The #270 mirror's golden bindings, in its own UNSORTED order (exercises computeBindingsRoot's internal canonical sort). */
const GOLDEN_BINDINGS: SubjectBinding[] = [
  { planUnitKey: mirrorPuk0, requirementIdHash: K("req-approval-payer"), sourceKind: 1, propositionKind: 0, valueRef: mirrorPayer },
  { planUnitKey: mirrorPuk0, requirementIdHash: K("req-target-confirm"), sourceKind: 7, propositionKind: 5, valueRef: mirrorTargetSystemIdentity },
  { planUnitKey: mirrorPuk0, requirementIdHash: K("req-escrow-receipt"), sourceKind: 7, propositionKind: 8, valueRef: mirrorChildren[0]![0] },
  { planUnitKey: mirrorPuk0, requirementIdHash: K("req-envelope"), sourceKind: 6, propositionKind: 13, valueRef: mirrorOperatingEnvelopeHash },
  { planUnitKey: mirrorPuk0, requirementIdHash: K("req-artifact-hash"), sourceKind: 6, propositionKind: 16, valueRef: Z32 },
];
const GOLDEN_TERMS_HASH = "0x2cb7a79e45cbb5b78b61dbbcc182b2f27ac7991b055a66ef58457459dc2f4fe6" as const;

/** Copied verbatim from canonical-acceptedjobpolicy-v1-mirror.cjs's EXPECT block (#270). */
const EXPECT = {
  subjectBlockHash: "0x05fb7b45f6079ca2c82f6b3676e8af2cf98f3322bdc1e64acf0afc2aef2c46c7",
  bindingsRoot: "0x05ce18c90db024fbc9958dcc9939c9d42ce4ba2e60485b3038424007098ec20f",
  acceptedPolicyDigest: "0xa821492ad1c9d685fc794c21485480f01169c2d690d73c86a354143f3f496a41",
} as const;

describe("accepted-policy: #270 golden mirror parity", () => {
  it("computeSubjectBlockHash reproduces the published golden byte-exact", () => {
    const actual = computeSubjectBlockHash(GOLDEN_SUBJECT);
    expect(actual, `subjectBlockHash mismatch: expected ${EXPECT.subjectBlockHash}, got ${actual}`).toBe(EXPECT.subjectBlockHash);
  });

  it("computeBindingsRoot reproduces the published golden byte-exact, and sorts internally", () => {
    const actual = computeBindingsRoot(GOLDEN_BINDINGS);
    expect(actual, `bindingsRoot mismatch: expected ${EXPECT.bindingsRoot}, got ${actual}`).toBe(EXPECT.bindingsRoot);
    const shuffled = [...GOLDEN_BINDINGS].reverse();
    expect(computeBindingsRoot(shuffled), "canonical sort must make caller order irrelevant").toBe(actual);
  });

  it("computeAcceptedPolicyDigest reproduces the published golden byte-exact", () => {
    const subjectBlockHash = computeSubjectBlockHash(GOLDEN_SUBJECT);
    const bindingsRoot = computeBindingsRoot(GOLDEN_BINDINGS);
    const actual = computeAcceptedPolicyDigest({ termsHash: GOLDEN_TERMS_HASH, subjectBlockHash, bindingsRoot });
    expect(actual, `acceptedPolicyDigest mismatch: expected ${EXPECT.acceptedPolicyDigest}, got ${actual}`).toBe(EXPECT.acceptedPolicyDigest);
  });

  it("domain constants match the mirror's keccak(utf8(label)) literals", () => {
    expect(SUBJECT_DOMAIN).toBe(K("PCC:vnext:accepted-policy-subjects:v1"));
    expect(POLICY_DOMAIN).toBe(K("PCC:vnext:accepted-job-policy:v1"));
    expect(PLANUNIT_DOMAIN).toBe(K("PCC:vnext:plan-unit-key:v1"));
    expect(POLICY_VERSION).toBe(1);
  });
});

describe("accepted-policy: binds (negative parity — changing any one input changes the output)", () => {
  it("subjectBlockHash changes when any single subject field changes", () => {
    const base = computeSubjectBlockHash(GOLDEN_SUBJECT);
    for (const key of Object.keys(GOLDEN_SUBJECT) as (keyof SubjectBlockFields)[]) {
      const mutatedValue = key === "integrityGrade" ? 3 : key === "operatorSettlementAddress" ? addr(0xdeadn) : K(`mutated-${key}`);
      const mutated: SubjectBlockFields = { ...GOLDEN_SUBJECT, [key]: mutatedValue };
      expect(computeSubjectBlockHash(mutated), `field ${key} did not bind into subjectBlockHash`).not.toBe(base);
    }
  });

  it("bindingsRoot changes when a binding field changes", () => {
    const base = computeBindingsRoot(GOLDEN_BINDINGS);
    const mutated = GOLDEN_BINDINGS.map((b, i) => (i === 0 ? { ...b, valueRef: K("mutated-value-ref") } : b));
    expect(computeBindingsRoot(mutated)).not.toBe(base);
    const mutatedKind = GOLDEN_BINDINGS.map((b, i) => (i === 1 ? { ...b, sourceKind: 2 } : b));
    expect(computeBindingsRoot(mutatedKind)).not.toBe(base);
  });

  it("acceptedPolicyDigest changes when termsHash, subjectBlockHash, or bindingsRoot changes", () => {
    const subjectBlockHash = computeSubjectBlockHash(GOLDEN_SUBJECT);
    const bindingsRoot = computeBindingsRoot(GOLDEN_BINDINGS);
    const base = computeAcceptedPolicyDigest({ termsHash: GOLDEN_TERMS_HASH, subjectBlockHash, bindingsRoot });
    expect(computeAcceptedPolicyDigest({ termsHash: K("other-terms"), subjectBlockHash, bindingsRoot })).not.toBe(base);
    expect(computeAcceptedPolicyDigest({ termsHash: GOLDEN_TERMS_HASH, subjectBlockHash: K("other-subjects"), bindingsRoot })).not.toBe(base);
    expect(computeAcceptedPolicyDigest({ termsHash: GOLDEN_TERMS_HASH, subjectBlockHash, bindingsRoot: K("other-bindings") })).not.toBe(base);
  });
});

describe("accepted-policy: computePlanUnitKey (chain-independent, evidence #876)", () => {
  it("is deterministic and reproduces the derived golden puk0", () => {
    expect(computePlanUnitKey(0, 0, K("golden-step-0"))).toBe(mirrorPuk0);
    expect(computePlanUnitKey(0, 0, K("golden-step-0"))).toBe(computePlanUnitKey(0, 0, K("golden-step-0")));
  });
  it("binds unitOrdinal (ordinal 0 != ordinal 1 even with identical milestoneIndex/stepId)", () => {
    expect(computePlanUnitKey(1, 0, K("golden-step-0"))).not.toBe(mirrorPuk0);
  });
  it("binds milestoneIndex and stepId too", () => {
    expect(computePlanUnitKey(0, 1, K("golden-step-0"))).not.toBe(mirrorPuk0);
    expect(computePlanUnitKey(0, 0, K("other-step"))).not.toBe(mirrorPuk0);
  });
  it("takes no chainId, address or deal-shaped input at all (signature is (ordinal, milestoneIndex, stepId) only)", () => {
    expect(computePlanUnitKey.length).toBe(3);
  });
});

describe("accepted-policy: pinned input forms are REJECTED, never normalized", () => {
  const bad = (overrides: Partial<SubjectBlockFields>) => ({ ...GOLDEN_SUBJECT, ...overrides }) as SubjectBlockFields;

  it("rejects uppercase hex in a bytes32 field", () => {
    expect(() => computeSubjectBlockHash(bad({ payer: GOLDEN_SUBJECT.payer.toUpperCase().replace("0X", "0x") as `0x${string}` }))).toThrow(
      AcceptedPolicyDigestInputError,
    );
  });
  it("rejects a bytes32 field one hex char short", () => {
    expect(() => computeSubjectBlockHash(bad({ payer: GOLDEN_SUBJECT.payer.slice(0, -1) as `0x${string}` }))).toThrow(AcceptedPolicyDigestInputError);
  });
  it("rejects a bytes32 field one hex char long", () => {
    expect(() => computeSubjectBlockHash(bad({ payer: (GOLDEN_SUBJECT.payer + "0") as `0x${string}` }))).toThrow(AcceptedPolicyDigestInputError);
  });
  it("rejects a bytes32 field missing the 0x prefix", () => {
    expect(() => computeSubjectBlockHash(bad({ payer: GOLDEN_SUBJECT.payer.slice(2) as `0x${string}` }))).toThrow(AcceptedPolicyDigestInputError);
  });
  it("rejects a 40-hex address value placed in a bytes32 slot", () => {
    expect(() => computeSubjectBlockHash(bad({ payer: GOLDEN_SUBJECT.operatorSettlementAddress }))).toThrow(AcceptedPolicyDigestInputError);
  });
  it("rejects a 64-hex bytes32 value placed in the address slot", () => {
    expect(() => computeSubjectBlockHash(bad({ operatorSettlementAddress: GOLDEN_SUBJECT.payer as unknown as `0x${string}` }))).toThrow(
      AcceptedPolicyDigestInputError,
    );
  });
  it("rejects integrityGrade out of uint8 range (256)", () => {
    expect(() => computeSubjectBlockHash(bad({ integrityGrade: 256 }))).toThrow(AcceptedPolicyDigestInputError);
  });
  it("rejects a negative integrityGrade", () => {
    expect(() => computeSubjectBlockHash(bad({ integrityGrade: -1 }))).toThrow(AcceptedPolicyDigestInputError);
  });
  it("rejects negative zero (-0) for integrityGrade", () => {
    expect(() => computeSubjectBlockHash(bad({ integrityGrade: -0 }))).toThrow(AcceptedPolicyDigestInputError);
  });
  it("rejects a non-integer number for integrityGrade", () => {
    expect(() => computeSubjectBlockHash(bad({ integrityGrade: 2.5 }))).toThrow(AcceptedPolicyDigestInputError);
  });
  it("rejects a decimal string with a leading zero for integrityGrade", () => {
    expect(() => computeSubjectBlockHash(bad({ integrityGrade: "02" }))).toThrow(AcceptedPolicyDigestInputError);
  });
  it("accepts integrityGrade as a bigint, a safe number, or a canonical decimal string identically", () => {
    const viaBigint = computeSubjectBlockHash(bad({ integrityGrade: 2n }));
    const viaNumber = computeSubjectBlockHash(bad({ integrityGrade: 2 }));
    const viaString = computeSubjectBlockHash(bad({ integrityGrade: "2" }));
    expect(viaBigint).toBe(viaNumber);
    expect(viaNumber).toBe(viaString);
  });

  it("rejects a duplicate requirementIdHash in bindings (globally unique, sol NO-GO #6)", () => {
    const duplicated = [...GOLDEN_BINDINGS, { ...GOLDEN_BINDINGS[0]!, valueRef: K("different-value-same-requirement") }];
    expect(() => computeBindingsRoot(duplicated)).toThrow(AcceptedPolicyDigestInputError);
  });

  it("accepts an empty bindings array (a well-defined, if unusual, policy)", () => {
    expect(() => computeBindingsRoot([])).not.toThrow();
  });
});

describe("accepted-policy: nothing unknown — exact keys only (the Layer-1 'no deal input' guarantee)", () => {
  it("rejects a subject object carrying an extra deal-shaped key", () => {
    const withDealDigest = { ...GOLDEN_SUBJECT, dealDigest: K("some-deal-digest") } as unknown as SubjectBlockFields;
    expect(() => computeSubjectBlockHash(withDealDigest)).toThrow(AcceptedPolicyDigestInputError);
  });
  it("rejects a subject object missing a required key", () => {
    const { payer: _omit, ...rest } = GOLDEN_SUBJECT;
    expect(() => computeSubjectBlockHash(rest as unknown as SubjectBlockFields)).toThrow(AcceptedPolicyDigestInputError);
  });
  it("rejects a same-COUNT key substitution (an unknown key standing in for a required one, so the key-count check alone would not catch it)", () => {
    const { payer: _omit, ...rest } = GOLDEN_SUBJECT;
    const substituted = { ...rest, dealDigest: K("some-deal-digest") }; // still exactly 18 keys
    expect(Object.keys(substituted).length).toBe(Object.keys(GOLDEN_SUBJECT).length);
    expect(() => computeSubjectBlockHash(substituted as unknown as SubjectBlockFields)).toThrow(AcceptedPolicyDigestInputError);
  });
  it("rejects a binding carrying an extra planId-shaped key", () => {
    const withPlanId = [{ ...GOLDEN_BINDINGS[0]!, planId: "some-plan-id" } as unknown as SubjectBinding, ...GOLDEN_BINDINGS.slice(1)];
    expect(() => computeBindingsRoot(withPlanId)).toThrow(AcceptedPolicyDigestInputError);
  });
  it("rejects digest inputs carrying an extra compositionSection-shaped key", () => {
    const inputs = {
      termsHash: GOLDEN_TERMS_HASH,
      subjectBlockHash: EXPECT.subjectBlockHash,
      bindingsRoot: EXPECT.bindingsRoot,
      compositionSection: "unexpected",
    } as unknown as AcceptedPolicyDigestInputs;
    expect(() => computeAcceptedPolicyDigest(inputs)).toThrow(AcceptedPolicyDigestInputError);
  });

  it("property: a randomized fuzz of extra key names is always rejected, and identical declared fields always hash identically regardless of key insertion order", () => {
    for (let i = 0; i < 25; i++) {
      // Same 18 fields, different insertion order (JS preserves insertion order but our
      // reader goes through Reflect.ownKeys + checkExactKeys, which does not care).
      const reordered = Object.fromEntries(
        [...Object.entries(GOLDEN_SUBJECT)].sort(() => Math.random() - 0.5),
      ) as unknown as SubjectBlockFields;
      expect(computeSubjectBlockHash(reordered)).toBe(computeSubjectBlockHash(GOLDEN_SUBJECT));

      const extraKeyName = `deal-shaped-${Math.random().toString(36).slice(2)}`;
      const withExtra = { ...GOLDEN_SUBJECT, [extraKeyName]: K(extraKeyName) } as unknown as SubjectBlockFields;
      expect(() => computeSubjectBlockHash(withExtra)).toThrow(AcceptedPolicyDigestInputError);
    }
  });
});

describe("accepted-policy: code-running input is refused before it is read (E7c-style guard)", () => {
  it("refuses a Proxy as the subject object", () => {
    const proxied = new Proxy(GOLDEN_SUBJECT, {});
    expect(() => computeSubjectBlockHash(proxied)).toThrow(AcceptedPolicyDigestInputError);
  });
  it("refuses a Proxy as the bindings array", () => {
    const proxied = new Proxy(GOLDEN_BINDINGS, {});
    expect(() => computeBindingsRoot(proxied)).toThrow(AcceptedPolicyDigestInputError);
  });
  it("refuses a Proxy as one bindings array element", () => {
    const withProxyElement = [new Proxy(GOLDEN_BINDINGS[0]!, {}), ...GOLDEN_BINDINGS.slice(1)];
    expect(() => computeBindingsRoot(withProxyElement)).toThrow(AcceptedPolicyDigestInputError);
  });
  it("refuses an accessor (getter) property standing in for a plain field", () => {
    const withGetter: Record<string, unknown> = { ...GOLDEN_SUBJECT };
    Object.defineProperty(withGetter, "payer", { get: () => GOLDEN_SUBJECT.payer, enumerable: true, configurable: true });
    expect(() => computeSubjectBlockHash(withGetter as unknown as SubjectBlockFields)).toThrow(AcceptedPolicyDigestInputError);
  });
  it("refuses a non-enumerable own property standing in for a plain field", () => {
    const withHidden: Record<string, unknown> = { ...GOLDEN_SUBJECT };
    Object.defineProperty(withHidden, "payer", { value: GOLDEN_SUBJECT.payer, enumerable: false, configurable: true });
    expect(() => computeSubjectBlockHash(withHidden as unknown as SubjectBlockFields)).toThrow(AcceptedPolicyDigestInputError);
  });
  it("refuses a non-plain object (a class instance) as the subject", () => {
    class NotPlain {
      payer = GOLDEN_SUBJECT.payer;
    }
    expect(() => computeSubjectBlockHash(Object.assign(new NotPlain(), GOLDEN_SUBJECT) as unknown as SubjectBlockFields)).toThrow(
      AcceptedPolicyDigestInputError,
    );
  });
  it("refuses an array passed where a plain object is expected", () => {
    expect(() => computeSubjectBlockHash([] as unknown as SubjectBlockFields)).toThrow(AcceptedPolicyDigestInputError);
  });
  it("refuses null and primitives where a plain object is expected", () => {
    expect(() => computeSubjectBlockHash(null as unknown as SubjectBlockFields)).toThrow(AcceptedPolicyDigestInputError);
    expect(() => computeSubjectBlockHash("not-an-object" as unknown as SubjectBlockFields)).toThrow(AcceptedPolicyDigestInputError);
  });
  it("accepts a null-prototype object carrying exactly the declared keys (Object.create(null) is PLAIN)", () => {
    const nullProto = Object.assign(Object.create(null), GOLDEN_SUBJECT) as SubjectBlockFields;
    expect(computeSubjectBlockHash(nullProto)).toBe(computeSubjectBlockHash(GOLDEN_SUBJECT));
  });
  it("refuses a non-array, dense-looking object (not Array.isArray) passed as bindings", () => {
    const fakeArray = { 0: GOLDEN_BINDINGS[0], length: 1 };
    expect(() => computeBindingsRoot(fakeArray as unknown as SubjectBinding[])).toThrow(AcceptedPolicyDigestInputError);
  });
  it("refuses a sparse bindings array (a hole)", () => {
    const sparse: SubjectBinding[] = [GOLDEN_BINDINGS[0]!];
    sparse[2] = GOLDEN_BINDINGS[1]!; // index 1 is a hole
    expect(() => computeBindingsRoot(sparse)).toThrow(AcceptedPolicyDigestInputError);
  });

  // ── E12 HIGH (astra r1, 98501e35, SHIP-WITH-FIXES): an indexed getter on a bindings
  // element runs code, and reading it twice can make one admitted array yield two
  // different roots. Reviewer's reproduction, added verbatim first against 98501e35
  // (see /mnt/sparkbulk/tmp/evidence-496-e12-repro-98501e35.txt for the pre-fix run,
  // where this test failed: calls ended at 2, not 0). The fix makes both calls throw
  // instead of returning a root at all, so the assertions below are the POST-FIX
  // expected behavior: both calls throw, and the getter never runs. ──────────────────
  it("E12: refuses an indexed getter standing in for a bindings array element; the getter never runs and the array never yields two roots", () => {
    const bindings = [GOLDEN_BINDINGS[0]!];
    let calls = 0;
    Object.defineProperty(bindings, "0", {
      enumerable: true,
      configurable: true,
      get() {
        calls++;
        return { ...GOLDEN_BINDINGS[0]!, valueRef: K(calls % 2 ? "first" : "second") };
      },
    });
    expect(() => computeBindingsRoot(bindings)).toThrow(AcceptedPolicyDigestInputError);
    expect(() => computeBindingsRoot(bindings)).toThrow(AcceptedPolicyDigestInputError);
    expect(calls).toBe(0);
  });

  it("E12: refuses a hole replaced by an unrelated extra key (own-key count matches, but canonical index 1 is missing)", () => {
    const a: unknown[] = [GOLDEN_BINDINGS[0]!, GOLDEN_BINDINGS[1]!];
    delete a[1];
    (a as Record<string, unknown>).extra = GOLDEN_BINDINGS[1]!;
    expect(Reflect.ownKeys(a).length).toBe(3); // "0", "extra", "length" — same count as a dense length-2 array
    expect(() => computeBindingsRoot(a as unknown as SubjectBinding[])).toThrow(AcceptedPolicyDigestInputError);
  });

  it("E12: a hole backed by a polluted Array.prototype[1], combined with the extra-key count trick, is still refused (prototype values are never read)", () => {
    const a: unknown[] = [GOLDEN_BINDINGS[0]!, GOLDEN_BINDINGS[1]!];
    delete a[1];
    (a as Record<string, unknown>).extra = GOLDEN_BINDINGS[1]!;
    const pollutedProto = Array.prototype as unknown as Record<string, unknown>;
    pollutedProto[1] = { ...GOLDEN_BINDINGS[1]!, valueRef: K("polluted-prototype-value") };
    try {
      expect(() => computeBindingsRoot(a as unknown as SubjectBinding[])).toThrow(AcceptedPolicyDigestInputError);
    } finally {
      delete pollutedProto[1];
    }
  });

  it("E12: the field snapshot is a null-prototype record, so a replaced Map.prototype.get cannot answer a field", () => {
    const original = Map.prototype.get;
    Map.prototype.get = function () {
      return K("forged-by-map-get");
    };
    let root: string;
    let subjectBlockHash: string;
    try {
      root = computeBindingsRoot(GOLDEN_BINDINGS);
      subjectBlockHash = computeSubjectBlockHash(GOLDEN_SUBJECT);
    } finally {
      Map.prototype.get = original;
    }
    expect(root).toBe(EXPECT.bindingsRoot);
    expect(subjectBlockHash).toBe(EXPECT.subjectBlockHash);
  });
});
