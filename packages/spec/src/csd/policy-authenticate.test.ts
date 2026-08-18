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
  const settlementUnitId = hexToBytes("0x4453a3d232c24342539bc5ae06089f1cf7ccf93f737cffd67cf0a6ea76904ef1");
  // operatingEnvelopeHash doubles as the req-envelope binding valueRef (mirror B('req-envelope', .., operatingEnvelopeHash)):
  const operatingEnvelopeHash = computeOperatingEnvelopeHash(operatingEnvelope);
  const B = (reqId: string, src: number, prop: number, valueRef: Uint8Array) => ({
    settlementUnitId,
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

  it("bindingsRoot == evidence golden 0xb0fac971.. (canonical binding-sort, 999e6bdb)", () => {
    expect(bytesToHex(computeBindingsRoot(p.evidenceSubjectBindings))).toBe("0xb0fac97112a3e02d1c80e1017d033fa8d224b4ccf64de25ea5eaa0820ab6a340");
  });

  it("acceptedPolicyDigest == evidence golden 0xe616864b.. (canonical binding-sort, 999e6bdb)", () => {
    expect(bytesToHex(computeAcceptedPolicyDigest(p))).toBe("0xe616864b43af297effb3215ee6ed89bb3d0b19db20226a472a5b6ef216b2a3ee");
  });

  it("projection: 51 rows, rowsRoot + projectionDigest == evidence goldens", () => {
    const rows = buildProjectionRows();
    expect(rows.length).toBe(51);
    expect(bytesToHex(computeRowsRoot(rows))).toBe("0x661a81120ed7ce419ada0091e5a6d4b3923dc1ffa18fc286b3041b85fa7ec68a");
    expect(bytesToHex(computeProjectionDigest(rows))).toBe("0xb044b20b6ea2470f0d80e2fc73651c77a9dfc406707df1dfec460335f5a83900");
  });
});
