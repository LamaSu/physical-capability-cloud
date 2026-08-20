import { describe, it, expect } from "vitest";
import {
  keccakUtf8,
  hexToBytes,
  bytesToHex,
  computeTermsHash,
  computeSubjectBlockHash,
  computeBindingsRoot,
  computeAcceptedPolicyDigest,
  computeOperatingEnvelopeHash,
  computePlanUnitKey,
  buildProjectionRows,
  computeRowsRoot,
  computeProjectionDigest,
  type CanonicalAcceptedJobPolicyV1,
} from "./policy-authenticate.js";

// ---------------------------------------------------------------------------
// BYTE-EXACTNESS PROOF: reproduce evidence's published mirror goldens with our
// own keccak + minimal ABI encoder. If these pass, composition can authenticate
// acceptedPolicyDigest + projectionDigest byte-for-byte (sol f1/f2). Fixture is
// verbatim from canonical-acceptedjobpolicy-v1-mirror.cjs / authoritypolicy-
// projection-v1-mirror.cjs (evidence lane).
// ---------------------------------------------------------------------------

const K = (s: string) => keccakUtf8(s);
const addr = (n: bigint) => hexToBytes("0x" + n.toString(16).padStart(40, "0"));
const Z32 = new Uint8Array(32);

// SubjectSelector u8 kinds (mirror SEL)
const SEL = { NONE: 0, POLICY_PAYER: 1, TARGET_SYSTEM: 5, AUTHORIZED_TUPLE: 6, ORACLE_SELF: 7, CHILD_UNIT: 8, OPERATING_ENVELOPE: 13, CONTENT_ADDR: 16 };

function goldenPolicy(): CanonicalAcceptedJobPolicyV1 {
  const operatorPrincipal = K("golden-operator");
  const childJobId = K("golden-child-job");
  const targetSystemIdentity = K("golden-target-system");
  const payer = K("golden-payer");
  // operatingEnvelopeHash is a computed value that is ALSO used as a binding valueRef (req-envelope):
  // build the policy then reference it — we recompute it here to match the mirror's B('req-envelope', .., operatingEnvelopeHash).
  const operatingEnvelope = [
    { metric: K("power"), min: 0n, max: 1000n },
    { metric: K("temp"), min: 0n, max: 250n },
  ];
  // planUnitKey (evidence #876): golden binding unit = unitOrdinal 0, milestoneIndex 0, stepId K("golden-step-0").
  const puk0 = computePlanUnitKey(0n, 0n, K("golden-step-0"));
  // operatingEnvelopeHash doubles as the req-envelope binding valueRef (mirror B('req-envelope', .., operatingEnvelopeHash)):
  const operatingEnvelopeHash = computeOperatingEnvelopeHash(operatingEnvelope);
  const B = (reqId: string, src: number, prop: number, valueRef: Uint8Array) => ({
    planUnitKey: puk0,
    requirementIdHash: K(reqId),
    sourceKind: src,
    propositionKind: prop,
    valueRef,
  });
  return {
    token: addr(0x5dcn),
    assuranceTier: 2n,
    milestones: [
      { milestoneIndex: 1n, stepId: K("golden-step-1"), amount: 600000n, deadline: 2000500000n },
      { milestoneIndex: 0n, stepId: K("golden-step-0"), amount: 400000n, deadline: 2000000000n },
    ],
    payer,
    operatorPrincipal,
    operatorSettlementAddress: addr(0x0a71n),
    authorizedTuples: [{ operator: operatorPrincipal, kernel: K("golden-kernel"), device: K("golden-device") }],
    approvedExpertSet: [K("golden-expert-1")],
    approvedThirdPartyExecutorSet: [K("golden-exec-1")],
    expectedRecipient: K("golden-recipient"),
    targetSystemIdentity,
    committedProgramHash: K("golden-program"),
    recipeRef: K("golden-recipe"),
    sampleManifestRef: K("golden-sample-manifest"),
    children: [{ childJobId, childEscrow: addr(0xc41dn) }],
    operatingEnvelope,
    expectedRouteArea: K("golden-route-area"),
    expectedLocation: { lat: 377749000n, lng: -1224194000n, radius: 500n, time: 1700000000n },
    captureNonceAnchor: K("golden-capture-nonce"),
    challengeAnchor: K("golden-challenge-anchor"),
    integrityGrade: 2n,
    evidenceSubjectBindings: [
      B("req-approval-payer", SEL.POLICY_PAYER, SEL.NONE, payer),
      B("req-target-confirm", SEL.ORACLE_SELF, SEL.TARGET_SYSTEM, targetSystemIdentity),
      B("req-escrow-receipt", SEL.ORACLE_SELF, SEL.CHILD_UNIT, childJobId),
      B("req-envelope", SEL.AUTHORIZED_TUPLE, SEL.OPERATING_ENVELOPE, operatingEnvelopeHash),
      B("req-artifact-hash", SEL.AUTHORIZED_TUPLE, SEL.CONTENT_ADDR, Z32),
    ],
  };
}

describe("policy-authenticate — byte-exactness vs evidence's published goldens", () => {
  const p = goldenPolicy();

  it("termsHash == published v2.1 golden (superset carry)", () => {
    expect(bytesToHex(computeTermsHash(p))).toBe("0x2cb7a79e45cbb5b78b61dbbcc182b2f27ac7991b055a66ef58457459dc2f4fe6");
  });

  it("subjectBlockHash == evidence golden", () => {
    expect(bytesToHex(computeSubjectBlockHash(p))).toBe("0x05fb7b45f6079ca2c82f6b3676e8af2cf98f3322bdc1e64acf0afc2aef2c46c7");
  });

  it("bindingsRoot == evidence golden 0x05ce18c9.. (planUnitKey binding, #876)", () => {
    expect(bytesToHex(computeBindingsRoot(p.evidenceSubjectBindings))).toBe("0x05ce18c90db024fbc9958dcc9939c9d42ce4ba2e60485b3038424007098ec20f");
  });

  it("acceptedPolicyDigest == evidence golden 0xa821492a.. (planUnitKey, #876 — cycle broken)", () => {
    expect(bytesToHex(computeAcceptedPolicyDigest(p))).toBe("0xa821492ad1c9d685fc794c21485480f01169c2d690d73c86a354143f3f496a41");
  });

  it("projection: 51 rows, rowsRoot + projectionDigest == evidence goldens", () => {
    const rows = buildProjectionRows();
    expect(rows.length).toBe(51);
    expect(bytesToHex(computeRowsRoot(rows))).toBe("0x661a81120ed7ce419ada0091e5a6d4b3923dc1ffa18fc286b3041b85fa7ec68a");
    expect(bytesToHex(computeProjectionDigest(rows))).toBe("0xb044b20b6ea2470f0d80e2fc73651c77a9dfc406707df1dfec460335f5a83900");
  });
});
