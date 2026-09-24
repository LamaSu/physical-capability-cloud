import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  EVIDENCE_BLOCK_DOMAIN_V2,
  EvidenceBlockInputError,
  SETTLEMENT_UNIT_DOMAIN_V1,
  UNIT_CONTEXT_DOMAIN_V1,
  computeAttestationSetRoot,
  computeEvidenceBlockHash,
  computeSessionKeyAuthDigest,
  computeSettlementUnitId,
  computeUnitContextDigest,
  taggedDigestToBytes32,
  type AttestationQuorumRole,
} from "../evidence/evidence-block.js";
import { canonicalize, hashBundle, hashEvent } from "../util/canonical.js";
import { computeVerificationProgramHash, type VerificationProgram } from "../types/verification-program.js";
import { computeWorkProductHash, type WorkProduct } from "../types/work-product.js";
import type { EvidenceEvent, SessionKeyAuthorization } from "../types/evidence.js";

// ── The evidence lane's v2 mirror inputs (evidence-block-v2-mirror.cjs on #270) ──
const K = (s: string) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(s))).toString("hex")}`;
const sha = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}`;

const unit = {
  chainId: 8453n,
  escrow: `0x${(0xe5c0f).toString(16).padStart(40, "0")}`,
  jobIdHash: K("golden-job"),
  milestoneIndex: 3n,
  stepId: K("golden-step"),
};
const challengeNonce = K("golden-gateway-nonce");

const source = { deviceId: "dev-golden", deviceType: "controller" as const, kernelId: "kernel-golden-01" };
const rawEvents: Array<Omit<EvidenceEvent, "id" | "hash">> = [
  { type: "execution_completed", timestamp: "1700000000", source, payload: { ok: true } },
  { type: "cv_inspection_result", timestamp: "1700000005", source, payload: { pass: true, defects: 0 } },
];

const sessionKeyAuth = {
  sessionId: "sess-golden",
  parentAgentId: "kernel-golden-01",
  publicKey: "aa".repeat(32),
  issuedAt: 1699999000,
  expiresAt: 1700003600,
  scope: { allowedActions: ["sign-evidence"], contractIds: ["unit-golden"], maxSignatures: 8 },
  parentSignature: "bb".repeat(64),
} as SessionKeyAuthorization;

const attJob = "job-golden";
const roles: AttestationQuorumRole[] = [
  {
    roleId: "inspector",
    minPositive: 2,
    total: 3,
    minScore: 80,
    attestationHashes: [
      sha(canonicalize([attJob, `0x${"11".repeat(20)}`, 92])),
      sha(canonicalize([attJob, `0x${"22".repeat(20)}`, 88])),
    ],
  },
];

const workProduct = {
  kind: "physical",
  jobId: "job-golden",
  capabilityId: "cap-golden",
  schemaHash: K("golden-work-schema"),
  producerAddress: `0x${"33".repeat(20)}`,
  finalizedAt: 1700000006,
  details: { location: { lat: 37.77, lng: -122.42 }, photoBundleCid: "bafyGoldenPhoto" },
} as unknown as WorkProduct;

const program = {
  version: 1,
  schemaHash: K("golden-work-schema"),
  stages: [
    {
      stageId: "settle",
      releaseBps: 10000,
      onTimeout: "refund",
      onFail: "refund",
      predicate: {
        kind: "and",
        children: [
          { kind: "event-presence", eventType: "execution_completed", atLeast: 1 },
          { kind: "field-threshold", eventRef: { eventType: "cv_inspection_result" }, path: "/pass", op: "=", value: 1 },
        ],
      },
    },
  ],
} as unknown as VerificationProgram;

async function goldenRoots() {
  const settlementUnitId = computeSettlementUnitId(unit);
  const events = await Promise.all(rawEvents.map(async (e) => ({ ...e, id: e.type, hash: await hashEvent(e) })));
  return {
    settlementUnitId,
    events,
    unitContextDigest: computeUnitContextDigest({ ...unit, settlementUnitId, challengeNonce }),
    kernelSignedEventsRoot: taggedDigestToBytes32(await hashBundle(events)),
    sessionKeyAuthDigest: computeSessionKeyAuthDigest(sessionKeyAuth),
    attestationSetRoot: computeAttestationSetRoot(attJob, roles),
    workProductRoot: computeWorkProductHash(workProduct),
    programHash: computeVerificationProgramHash(program),
  };
}

/** The mirror derived its events root over 0x-prefixed event hashes. */
function mirrorEventsRoot(): string {
  return sha(
    canonicalize(
      rawEvents
        .map((e) => sha(canonicalize({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload })))
        .sort(),
    ),
  );
}

describe("EvidenceBlockV1 v2 — reproduces the evidence lane's pinned goldens", () => {
  it("domains", () => {
    expect(EVIDENCE_BLOCK_DOMAIN_V2).toBe("0xf15817db95786e8bbc3156b3e66c9fa7776b2d1233841e8718b9c91fa1c751a0");
    expect(UNIT_CONTEXT_DOMAIN_V1).toBe(K("PCC:vnext:unit-context:v1"));
    expect(SETTLEMENT_UNIT_DOMAIN_V1).toBe(K("PCC:vnext:settlement-unit:v1"));
  });

  it("the settlement unit id matches the escrow's golden and the integrated settlement vector", () => {
    expect(unit.jobIdHash).toBe("0xbd3e925d85926d56eeb490485bfc63b88b28ddfb844807226da638cb46e6e5f0");
    expect(unit.stepId).toBe("0xd84e1f1dce698b3ddaa7e120bb89a540f9bcdd632420311802ac242b3d1d0e67");
    expect(computeSettlementUnitId(unit)).toBe(
      "0x4453a3d232c24342539bc5ae06089f1cf7ccf93f737cffd67cf0a6ea76904ef1",
    );
  });

  it("the block formula reproduces the mirror golden from the mirror's six roots", async () => {
    const r = await goldenRoots();
    expect(
      computeEvidenceBlockHash({ ...r, kernelSignedEventsRoot: mirrorEventsRoot() }),
    ).toBe("0x4605a6e9affa66fd2acd44f5b88d0468f293056573f04e884048f58ba8803a40");
  });
});

describe("EvidenceBlockV1 v2 — the events root is the kernel-signed bundleHash", () => {
  it("the mirror's events root is NOT the digest the kernel signs", async () => {
    const r = await goldenRoots();
    // hashBundle hashes the sorted "sha256:<hex>" event hashes; the mirror
    // hashed "0x<hex>" strings, so its root is not the signed bundleHash.
    expect(mirrorEventsRoot()).not.toBe(r.kernelSignedEventsRoot);
  });

  it("derived from the signed bundleHash, the golden block is 0x854079f7…", async () => {
    const r = await goldenRoots();
    expect(r.kernelSignedEventsRoot).toBe(taggedDigestToBytes32(await hashBundle(r.events)));
    expect(computeEvidenceBlockHash(r)).toBe(
      "0x854079f7d819e2fba76b259a8c61f6ef842b7472088fd5c4948c3c76974b4450",
    );
  });

  it("converts only canonical tagged digests", () => {
    for (const bad of [`0x${"ab".repeat(32)}`, `sha256:${"AB".repeat(32)}`, `sha256:${"ab".repeat(31)}`, "ab".repeat(32)]) {
      expect(() => taggedDigestToBytes32(bad), bad).toThrow(EvidenceBlockInputError);
    }
  });
});

describe("EvidenceBlockV1 v2 — every input binds, and incoherent units are refused", () => {
  it("mutating any root, or the domain/version, moves the block hash", async () => {
    const r = await goldenRoots();
    const base = computeEvidenceBlockHash(r);
    for (const field of [
      "unitContextDigest",
      "kernelSignedEventsRoot",
      "sessionKeyAuthDigest",
      "attestationSetRoot",
      "workProductRoot",
      "programHash",
    ] as const) {
      expect(computeEvidenceBlockHash({ ...r, [field]: K(`mutant-${field}`) }), field).not.toBe(base);
    }
  });

  it("evidence for unit A does not fit unit B, and a new challenge is a new context", async () => {
    const r = await goldenRoots();
    const otherUnit = { ...unit, milestoneIndex: 1n, stepId: K("golden-step-1") };
    const otherCtx = computeUnitContextDigest({
      ...otherUnit,
      settlementUnitId: computeSettlementUnitId(otherUnit),
      challengeNonce,
    });
    expect(otherCtx).not.toBe(r.unitContextDigest);
    const freshChallenge = computeUnitContextDigest({
      ...unit,
      settlementUnitId: r.settlementUnitId,
      challengeNonce: K("other-nonce"),
    });
    expect(freshChallenge).not.toBe(r.unitContextDigest);
  });

  it("refuses a context whose milestoneIndex or stepId does not derive its settlementUnitId", async () => {
    const r = await goldenRoots();
    for (const swap of [{ milestoneIndex: 2n }, { stepId: K("other-step") }]) {
      expect(() =>
        computeUnitContextDigest({ ...unit, ...swap, settlementUnitId: r.settlementUnitId, challengeNonce }),
      ).toThrow(EvidenceBlockInputError);
    }
  });

  it("relabelling a role or weakening its quorum moves the attestation root", () => {
    const root = computeAttestationSetRoot(attJob, roles);
    expect(computeAttestationSetRoot(attJob, [{ ...roles[0]!, roleId: "buyer" }])).not.toBe(root);
    expect(computeAttestationSetRoot(attJob, [{ ...roles[0]!, minPositive: 1 }])).not.toBe(root);
    expect(computeAttestationSetRoot("another-job", roles)).not.toBe(root);
    // Attestation order does not matter; membership does.
    const reordered = [{ ...roles[0]!, attestationHashes: [...roles[0]!.attestationHashes].reverse() }];
    expect(computeAttestationSetRoot(attJob, reordered)).toBe(root);
  });

  it("the set root does not depend on the order roles are listed in", () => {
    const buyer: AttestationQuorumRole = {
      roleId: "buyer",
      minPositive: 1,
      total: 1,
      minScore: 50,
      attestationHashes: [sha(canonicalize([attJob, `0x${"44".repeat(20)}`, 70]))],
    };
    expect(computeAttestationSetRoot(attJob, [roles[0]!, buyer])).toBe(
      computeAttestationSetRoot(attJob, [buyer, roles[0]!]),
    );
  });
});

describe("EvidenceBlockV1 v2 — input forms are pinned", () => {
  it("refuses a checksummed (mixed-case) escrow address and uppercase hex", () => {
    const checksummed = { ...unit, escrow: "0x00000000000000000000000000000000000E5c0F" };
    expect(() => computeSettlementUnitId(checksummed)).toThrow(EvidenceBlockInputError);
    expect(() => computeSettlementUnitId({ ...unit, stepId: unit.stepId.toUpperCase().replace("0X", "0x") })).toThrow(
      EvidenceBlockInputError,
    );
  });

  it("accepts integers as bigint, safe integer or decimal string, identically", () => {
    const asBig = computeSettlementUnitId(unit);
    expect(computeSettlementUnitId({ ...unit, chainId: 8453, milestoneIndex: 3 })).toBe(asBig);
    expect(computeSettlementUnitId({ ...unit, chainId: "8453", milestoneIndex: "3" })).toBe(asBig);
  });

  it("refuses negative, fractional, non-decimal and oversized integers", () => {
    for (const chainId of [-1, 1.5, "0x2105", "08453", 2n ** 256n] as unknown[]) {
      expect(() => computeSettlementUnitId({ ...unit, chainId: chainId as bigint }), String(chainId)).toThrow(
        EvidenceBlockInputError,
      );
    }
  });

  it("refuses a non-bytes32 root and a malformed attestation hash", async () => {
    const r = await goldenRoots();
    expect(() => computeEvidenceBlockHash({ ...r, programHash: "0x1234" })).toThrow(EvidenceBlockInputError);
    expect(() =>
      computeAttestationSetRoot(attJob, [{ ...roles[0]!, attestationHashes: ["sha256:" + "ab".repeat(32)] }]),
    ).toThrow(EvidenceBlockInputError);
  });
});
