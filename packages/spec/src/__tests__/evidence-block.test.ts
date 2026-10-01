import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  EVIDENCE_BLOCK_DOMAIN_V2,
  EvidenceBlockInputError,
  SETTLEMENT_UNIT_DOMAIN_V1,
  UNIT_CONTEXT_DOMAIN_V1,
  computeAttestationRoleDigest,
  computeAttestationSetRoot,
  computeEvidenceBlockHash,
  computeKernelSignedEventsRoot,
  computeSessionKeyAuthDigest,
  computeSettlementUnitId,
  computeUnitContextDigest,
  sessionKeyAuthSnapshot,
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

// ── The production-form events root over schema-valid events ──────────────
// Ported from #270's kernel-signed-events-root-golden-vector.cjs, whose root
// the oracle reproduced for its EvidenceBlockV2 builder. The fixture above
// keeps the v2 mirror's inputs, whose Unix-second timestamps are not
// schema-valid; these events are (ISO-8601), so this is the vector a real
// kernel bundle hashes the same way.
describe("kernelSignedEventsRoot — the production-form golden (schema-valid events)", () => {
  const isoEvents: Array<Omit<EvidenceEvent, "id" | "hash">> = [
    { type: "execution_completed", timestamp: "2026-08-20T00:00:00Z", source, payload: { ok: true } },
    { type: "cv_inspection_result", timestamp: "2026-08-20T00:00:05Z", source, payload: { pass: 1, defects: 0 } },
  ];
  const withHashes = (raw: Array<Omit<EvidenceEvent, "id" | "hash">>) =>
    Promise.all(raw.map(async (e) => ({ ...e, id: e.type, hash: await hashEvent(e) })));
  const rootOf = async (raw: Array<Omit<EvidenceEvent, "id" | "hash">>) =>
    taggedDigestToBytes32(await hashBundle(await withHashes(raw)));
  const GOLDEN_ROOT = "0x4e0af964e4e066717998ed7a49bf7c874023bd402b825da22b4dabd70fb6f9fe";

  it("hashEvent → hashBundle → bytes32 reproduces the pinned event hashes and root", async () => {
    const events = await withHashes(isoEvents);
    expect(events.map((e) => e.hash)).toEqual([
      "sha256:f7e78be15fe3bb93c4b9c978431466e1da54879ce49c906489908246661218d0",
      "sha256:55b4abf189904fcc858505142d7317d610c186cffba9e2329b2c7223aa3f761c",
    ]);
    expect(taggedDigestToBytes32(await hashBundle(events))).toBe(GOLDEN_ROOT);
  });

  it("does not depend on event order (hashBundle sorts the tagged hashes)", async () => {
    expect(await rootOf([...isoEvents].reverse())).toBe(GOLDEN_ROOT);
  });

  it("an event's id and hash are outside its preimage (the oracle hashes only type, timestamp, source, payload)", async () => {
    const [first] = await withHashes(isoEvents);
    const carried = { ...first!, id: "transport-id-7", hash: `sha256:${"ee".repeat(32)}` } as EvidenceEvent;
    expect(await hashEvent(carried)).toBe(first!.hash);
  });

  it("moves when the preimage is 0x-tagged, an event is marked simulated, or a payload value changes type", async () => {
    const inner0x = sha(
      canonicalize(isoEvents.map((e) => sha(canonicalize({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload }))).sort()),
    );
    expect(inner0x).not.toBe(GOLDEN_ROOT);
    const simulated = isoEvents.map((e) => ({ ...e, source: { ...e.source, simulated: true } }));
    expect(await rootOf(simulated)).not.toBe(GOLDEN_ROOT);
    // pass:true is not pass:1 — the value the program's field-threshold reads.
    expect(await rootOf([isoEvents[0]!, { ...isoEvents[1]!, payload: { pass: true, defects: 0 } }])).not.toBe(GOLDEN_ROOT);
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

// ── E7 verdict on #361 (round 2) ───────────────────────────────────────────
// Helpers: return the refusal so a test can pin WHICH input was refused (`field`),
// not just that something threw.
function refusalOf(fn: () => unknown): EvidenceBlockInputError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EvidenceBlockInputError);
    return e as EvidenceBlockInputError;
  }
  throw new Error("expected an EvidenceBlockInputError, but the call returned");
}

async function refusalOfAsync(fn: () => Promise<unknown>): Promise<EvidenceBlockInputError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EvidenceBlockInputError);
    return e as EvidenceBlockInputError;
  }
  throw new Error("expected an EvidenceBlockInputError, but the call resolved");
}

// ── F1 (HIGH): the events root is recomputed, not trusted ────────────────────
describe("E7 F1 — computeKernelSignedEventsRoot recomputes the bundle instead of trusting carried hashes", () => {
  const raw: Array<Omit<EvidenceEvent, "id" | "hash">> = [
    { type: "execution_completed", timestamp: "2026-08-20T00:00:00Z", source, payload: { ok: true } },
    { type: "cv_inspection_result", timestamp: "2026-08-20T00:00:05Z", source, payload: { pass: 1, defects: 0 } },
  ];
  const PINNED_ROOT = "0x4e0af964e4e066717998ed7a49bf7c874023bd402b825da22b4dabd70fb6f9fe";
  const hashed = (list: Array<Omit<EvidenceEvent, "id" | "hash">>) =>
    Promise.all(list.map(async (e) => ({ ...e, id: e.type, hash: await hashEvent(e) })));
  const honest = async (list = raw) => {
    const events = await hashed(list);
    return { events, bundleHash: await hashBundle(events) };
  };

  it("an honest bundle yields the pinned production-form root, identical to taggedDigestToBytes32(hashBundle)", async () => {
    const b = await honest();
    expect(await computeKernelSignedEventsRoot(b)).toBe(PINNED_ROOT);
    expect(await computeKernelSignedEventsRoot(b)).toBe(taggedDigestToBytes32(b.bundleHash));
  });

  it("an honest bundle over the v2 mirror inputs reproduces the block golden 0x854079f7…", async () => {
    const r = await goldenRoots();
    const root = await computeKernelSignedEventsRoot(await honest(rawEvents));
    expect(root).toBe(r.kernelSignedEventsRoot);
    expect(computeEvidenceBlockHash({ ...r, kernelSignedEventsRoot: root })).toBe(
      "0x854079f7d819e2fba76b259a8c61f6ef842b7472088fd5c4948c3c76974b4450",
    );
  });

  it("refuses two bundles with different payloads that carry the same event hash (the reviewer's repro)", async () => {
    const [first] = await hashed(raw);
    const a = [{ ...first!, payload: { pass: true } }];
    const b = [{ ...first!, payload: { pass: false } }];
    // hashBundle trusts the carried hash, so on their own these two share one root:
    expect(await hashBundle(a)).toBe(await hashBundle(b));
    for (const events of [a, b]) {
      const bundleHash = await hashBundle(events);
      const err = await refusalOfAsync(() => computeKernelSignedEventsRoot({ events, bundleHash }));
      expect(err.field).toBe("events[0].hash");
    }
  });

  it("refuses an event whose payload changed after it was hashed", async () => {
    const b = await honest();
    const events = [b.events[0]!, { ...b.events[1]!, payload: { pass: 1, defects: 7 } }];
    const err = await refusalOfAsync(() => computeKernelSignedEventsRoot({ events, bundleHash: b.bundleHash }));
    expect(err.field).toBe("events[1].hash");
  });

  it("refuses an altered carried event hash, even when bundleHash was recomputed over it", async () => {
    const b = await honest();
    const forged = { ...b.events[0]!, hash: `sha256:${"ee".repeat(32)}` as typeof b.events[0]["hash"] };
    const events = [forged, b.events[1]!];
    const bundleHash = await hashBundle(events);
    const err = await refusalOfAsync(() => computeKernelSignedEventsRoot({ events, bundleHash }));
    expect(err.field).toBe("events[0].hash");
  });

  it("refuses a bundleHash that is not the hash of the events", async () => {
    const b = await honest();
    for (const carried of [`sha256:${"cd".repeat(32)}`, undefined, 7, null]) {
      const err = await refusalOfAsync(() =>
        computeKernelSignedEventsRoot({ events: b.events, bundleHash: carried as never }),
      );
      expect(err.field, String(carried)).toBe("bundleHash");
    }
  });

  it("refuses a partial bundle: an event dropped under the original bundleHash", async () => {
    const b = await honest();
    const err = await refusalOfAsync(() => computeKernelSignedEventsRoot({ events: [b.events[0]!], bundleHash: b.bundleHash }));
    expect(err.field).toBe("bundleHash");
  });

  it("refuses an extra event added under the original bundleHash", async () => {
    const b = await honest();
    const [extra] = await hashed([{ type: "execution_failed", timestamp: "2026-08-20T00:00:09Z", source, payload: { reason: "late" } }]);
    const err = await refusalOfAsync(() =>
      computeKernelSignedEventsRoot({ events: [...b.events, extra!], bundleHash: b.bundleHash }),
    );
    expect(err.field).toBe("bundleHash");
  });

  it("refuses an empty event list, a non-array, and a missing bundle", async () => {
    // An empty list is a self-consistent bundle (sha256 of "[]"), so only the explicit refusal stops it.
    const emptyHash = await hashBundle([]);
    expect((await refusalOfAsync(() => computeKernelSignedEventsRoot({ events: [], bundleHash: emptyHash }))).field).toBe("events");
    for (const events of [undefined, null, "events", { length: 1, 0: {} }]) {
      const err = await refusalOfAsync(() => computeKernelSignedEventsRoot({ events: events as never, bundleHash: emptyHash }));
      expect(err.field, String(events)).toBe("events");
    }
    for (const bundle of [null, undefined, "bundle", 7]) {
      const err = await refusalOfAsync(() => computeKernelSignedEventsRoot(bundle as never));
      expect(err.field, String(bundle)).toBe("bundle");
    }
  });

  it("refuses an event that is not plain JSON data (cycle, bigint, non-object)", async () => {
    const b = await honest();
    const cyclic: Record<string, unknown> = { ...b.events[0]! };
    cyclic.self = cyclic;
    const withBigInt = { ...b.events[0]!, payload: { n: 1n } };
    for (const bad of [cyclic, withBigInt, null, 42, "event", () => 1]) {
      const err = await refusalOfAsync(() => computeKernelSignedEventsRoot({ events: [bad as never], bundleHash: b.bundleHash }));
      expect(err.field, String(bad)).toBe("events[0]");
    }
  });

  it("does not depend on event order or on the transport id (neither is in the preimage)", async () => {
    const b = await honest();
    expect(await computeKernelSignedEventsRoot({ events: [...b.events].reverse(), bundleHash: b.bundleHash })).toBe(PINNED_ROOT);
    const renamed = b.events.map((e, i) => ({ ...e, id: `transport-${i}` }));
    expect(await computeKernelSignedEventsRoot({ events: renamed, bundleHash: b.bundleHash })).toBe(PINNED_ROOT);
  });

  it("reads the bundle's events and bundleHash exactly once each", async () => {
    const b = await honest();
    const reads = { events: 0, bundleHash: 0 };
    const live = {
      get events() {
        reads.events++;
        return b.events;
      },
      get bundleHash() {
        reads.bundleHash++;
        return b.bundleHash;
      },
    };
    expect(await computeKernelSignedEventsRoot(live)).toBe(PINNED_ROOT);
    expect(reads).toEqual({ events: 1, bundleHash: 1 });
  });

  it("reads each event once: a hash getter that changes its answer cannot split verification from hashing", async () => {
    const b = await honest();
    const fake = `sha256:${"fa".repeat(32)}` as typeof b.events[0]["hash"];
    let reads = 0;
    const shifty = {
      ...b.events[0]!,
      get hash() {
        reads++;
        return reads === 1 ? b.events[0]!.hash : fake;
      },
    };
    // The attacker commits bundleHash over the SECOND answer. A live-object implementation
    // verifies the first answer, then hashBundle reads the second, and roots a hash the event
    // does not have. One snapshot read closes that.
    const bundleHash = await hashBundle([{ ...b.events[0]!, hash: fake }, b.events[1]!]);
    const err = await refusalOfAsync(() =>
      computeKernelSignedEventsRoot({ events: [shifty as typeof b.events[0], b.events[1]!], bundleHash }),
    );
    expect(err.field).toBe("bundleHash");
    expect(reads).toBe(1);
  });

  it("reads each element of the events array once", async () => {
    const b = await honest();
    const reads: Record<string, number> = {};
    const counted = new Proxy([...b.events], {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads[key] = (reads[key] ?? 0) + 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(await computeKernelSignedEventsRoot({ events: counted, bundleHash: b.bundleHash })).toBe(PINNED_ROOT);
    expect(reads).toEqual({ "0": 1, "1": 1 });
  });
});

// ── F2 (HIGH): invalid and duplicate quorums are refused ─────────────────────
describe("E7 F2 — the attestation set is validated before it is hashed", () => {
  const H1 = sha("f2-attestation-1");
  const H2 = sha("f2-attestation-2");
  const H3 = sha("f2-attestation-3");
  const okRole = (over: Record<string, unknown> = {}) =>
    ({ roleId: "inspector", minPositive: 1, total: 2, minScore: 50, attestationHashes: [H1], ...over }) as AttestationQuorumRole;
  const refuseSet = (rolesIn: unknown) =>
    refusalOf(() => computeAttestationSetRoot(attJob, rolesIn as AttestationQuorumRole[]));

  it("refuses the reviewer's invalid quorum, and each of its defects on its own", () => {
    const invalid = { roleId: "", minPositive: 2, total: 1, minScore: NaN, attestationHashes: [H1, H1] };
    expect(refuseSet([invalid]).field).toBe("roles[0].roleId");
    expect(refuseSet([okRole({ roleId: "" })]).field).toBe("roles[0].roleId");
    const quorum = refuseSet([okRole({ minPositive: 2, total: 1 })]);
    expect(quorum.field).toBe("roles[0].minPositive");
    expect(quorum.message).toMatch(/must not exceed total/);
    expect(refuseSet([okRole({ minScore: NaN })]).field).toBe("roles[0].minScore");
    const dup = refuseSet([okRole({ attestationHashes: [H1, H1] })]);
    expect(dup.field).toBe("roles[0].attestationHashes");
    expect(dup.message).toMatch(/distinct/);
  });

  it("refuses an empty role set, a non-array set, and a role that is not an object", () => {
    expect(refuseSet([]).field).toBe("roles");
    for (const bad of [undefined, null, "roles", { length: 1, 0: okRole() }]) {
      expect(refuseSet(bad).field, String(bad)).toBe("roles");
    }
    for (const bad of [null, undefined, 3, "role"]) {
      expect(refuseSet([bad]).field, String(bad)).toBe("roles[0]");
    }
  });

  it("refuses an empty role (no attestation hashes) and attestationHashes that is not an array", () => {
    const empty = refuseSet([okRole({ attestationHashes: [] })]);
    expect(empty.field).toBe("roles[0].attestationHashes");
    expect(empty.message).toMatch(/at least one attestation hash/);
    for (const bad of [undefined, null, H1, new Set([H1])]) {
      const err = refuseSet([okRole({ attestationHashes: bad })]);
      expect(err.field, String(bad)).toBe("roles[0].attestationHashes");
      expect(err.message, String(bad)).toMatch(/expected an array/);
    }
  });

  it("refuses two roles with the same roleId, and names the second one", () => {
    const err = refuseSet([okRole(), okRole({ attestationHashes: [H2] })]);
    expect(err.field).toBe("roles[1].roleId");
    expect(err.message).toMatch(/duplicate roleId "inspector"/);
  });

  it("refuses duplicate attestation hashes, but only inside one role", () => {
    const dup = refuseSet([okRole({ total: 3, attestationHashes: [H1, H2, H1] })]);
    expect(dup.field).toBe("roles[0].attestationHashes");
    expect(dup.message).toMatch(/distinct/);
    // distinctness is per role: another role may list the same hash
    expect(() => computeAttestationSetRoot(attJob, [okRole(), okRole({ roleId: "buyer" })])).not.toThrow();
  });

  it("refuses more attestation hashes than total", () => {
    const err = refuseSet([okRole({ minPositive: 1, total: 2, attestationHashes: [H1, H2, H3] })]);
    expect(err.field).toBe("roles[0].attestationHashes");
    expect(err.message).toMatch(/more attestation hashes than total/);
    expect(() => computeAttestationSetRoot(attJob, [okRole({ total: 3, attestationHashes: [H1, H2, H3] })])).not.toThrow();
  });

  it("refuses a malformed attestation hash and names its index", () => {
    for (const bad of [`sha256:${"ab".repeat(32)}`, `0x${"AB".repeat(32)}`, "0x12", 7, null, undefined]) {
      const err = refuseSet([okRole({ attestationHashes: [H1, bad] })]);
      expect(err.field, String(bad)).toBe("roles[0].attestationHashes[1]");
    }
  });

  it("refuses a minPositive that is not a safe integer >= 1", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, "1", null, undefined, -0, 2 ** 53]) {
      expect(refuseSet([okRole({ minPositive: bad })]).field, String(bad)).toBe("roles[0].minPositive");
    }
  });

  it("refuses a total that is not a safe integer >= 1", () => {
    for (const bad of [0, -1, 2.5, NaN, Infinity, "2", null, undefined, -0, 2 ** 53]) {
      expect(refuseSet([okRole({ total: bad })]).field, String(bad)).toBe("roles[0].total");
    }
  });

  it("refuses a minScore that is not a safe integer in [0, 100]", () => {
    for (const bad of [NaN, -1, 101, 50.5, Infinity, "80", null, undefined, -0]) {
      expect(refuseSet([okRole({ minScore: bad })]).field, String(bad)).toBe("roles[0].minScore");
    }
  });

  it("refuses a roleId outside 1-128 printable ASCII characters with no whitespace", () => {
    for (const bad of ["", " ", "in spector", "tab\t", "new\nline", "x".repeat(129), 7, null, undefined, "ünï"]) {
      expect(refuseSet([okRole({ roleId: bad })]).field, JSON.stringify(bad)).toBe("roles[0].roleId");
    }
  });

  it("refuses a job outside 1-128 printable ASCII characters with no whitespace, for the set and for one role", () => {
    for (const bad of ["", " ", "a b", "x".repeat(129), 7, null, undefined]) {
      expect(refusalOf(() => computeAttestationSetRoot(bad as string, [okRole()])).field, JSON.stringify(bad)).toBe("job");
      expect(refusalOf(() => computeAttestationRoleDigest(bad as string, okRole())).field, JSON.stringify(bad)).toBe("job");
    }
  });

  it("accepts the boundary values", () => {
    expect(() => computeAttestationSetRoot(attJob, [okRole({ minPositive: 2, total: 2, attestationHashes: [H1, H2] })])).not.toThrow();
    expect(() => computeAttestationSetRoot(attJob, [okRole({ minScore: 0 })])).not.toThrow();
    expect(() => computeAttestationSetRoot(attJob, [okRole({ minScore: 100 })])).not.toThrow();
    expect(() => computeAttestationSetRoot(attJob, [okRole({ minPositive: 1, total: 1 })])).not.toThrow();
    expect(() => computeAttestationSetRoot(attJob, [okRole({ roleId: "x".repeat(128) })])).not.toThrow();
    expect(() => computeAttestationSetRoot("x".repeat(128), [okRole({ roleId: "qa/lead:1" })])).not.toThrow();
  });

  it("validates a single role the same way, under the field prefix 'role'", () => {
    expect(refusalOf(() => computeAttestationRoleDigest(attJob, okRole({ roleId: "" }))).field).toBe("role.roleId");
    expect(refusalOf(() => computeAttestationRoleDigest(attJob, okRole({ attestationHashes: [] }))).field).toBe("role.attestationHashes");
    const one = okRole();
    expect(computeAttestationSetRoot(attJob, [one])).toBe(sha(canonicalize([computeAttestationRoleDigest(attJob, one)])));
  });

  it("the golden attestation set is still valid and its root is unchanged by validation", () => {
    const direct = sha(canonicalize([computeAttestationRoleDigest(attJob, roles[0]!)]));
    expect(computeAttestationSetRoot(attJob, roles)).toBe(direct);
  });
});

// ── F3 (HIGH): live-object reads ─────────────────────────────────────────────
describe("E7 F3 — roles are read once and the session authorization is a frozen snapshot", () => {
  const H1 = sha("f3-attestation-1");
  const H2 = sha("f3-attestation-2");
  const plainRole = (over: Record<string, unknown> = {}) =>
    ({ roleId: "inspector", minPositive: 1, total: 2, minScore: 50, attestationHashes: [H1], ...over }) as AttestationQuorumRole;
  const digestOf = (role: AttestationQuorumRole) => computeAttestationRoleDigest(attJob, role);

  describe("attestation roles", () => {
    it("a role whose attestationHashes getter changes its answer commits to the first, validated, answer", () => {
      let reads = 0;
      const role = {
        roleId: "inspector",
        minPositive: 1,
        total: 2,
        minScore: 50,
        get attestationHashes() {
          reads++;
          return reads === 1 ? [H1] : ["not-a-hash"];
        },
      } as unknown as AttestationQuorumRole;
      expect(digestOf(role)).toBe(digestOf(plainRole()));
      expect(reads).toBe(1);
    });

    it("a second answer that is itself valid is not committed either", () => {
      let reads = 0;
      const role = {
        roleId: "inspector",
        minPositive: 1,
        total: 2,
        minScore: 50,
        get attestationHashes() {
          reads++;
          return reads === 1 ? [H1] : [H2];
        },
      } as unknown as AttestationQuorumRole;
      const committed = digestOf(role);
      expect(committed).toBe(digestOf(plainRole({ attestationHashes: [H1] })));
      expect(committed).not.toBe(digestOf(plainRole({ attestationHashes: [H2] })));
    });

    it("each element of attestationHashes is read once", () => {
      let reads = 0;
      const hashes: string[] = [];
      Object.defineProperty(hashes, 0, {
        enumerable: true,
        get() {
          return ++reads === 1 ? H1 : "not-a-hash";
        },
      });
      expect(digestOf(plainRole({ attestationHashes: hashes }))).toBe(digestOf(plainRole()));
      expect(reads).toBe(1);
    });

    it("every scalar field of a role is read once, so a later invalid answer is never seen", () => {
      const reads = { roleId: 0, minPositive: 0, total: 0, minScore: 0 };
      const role = {
        get roleId() {
          return ++reads.roleId === 1 ? "inspector" : "";
        },
        get minPositive() {
          return ++reads.minPositive === 1 ? 1 : 0;
        },
        get total() {
          return ++reads.total === 1 ? 2 : 0;
        },
        get minScore() {
          return ++reads.minScore === 1 ? 50 : 999;
        },
        attestationHashes: [H1],
      } as unknown as AttestationQuorumRole;
      expect(digestOf(role)).toBe(digestOf(plainRole()));
      expect(reads).toEqual({ roleId: 1, minPositive: 1, total: 1, minScore: 1 });
    });

    it("the roles array and every role in it are read once", () => {
      const reads: Record<string, number> = {};
      const counted = new Proxy([plainRole(), plainRole({ roleId: "buyer" })], {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads[key] = (reads[key] ?? 0) + 1;
          return Reflect.get(target, key, receiver);
        },
      });
      computeAttestationSetRoot(attJob, counted as AttestationQuorumRole[]);
      expect(reads).toEqual({ "0": 1, "1": 1 });
    });
  });

  describe("session authorization", () => {
    const freshAuth = (): SessionKeyAuthorization => structuredClone(sessionKeyAuth);
    const refuseAuth = (auth: unknown) =>
      refusalOf(() => computeSessionKeyAuthDigest(auth as SessionKeyAuthorization));
    const P = "sessionKeyAuthorization";

    it("the digest is sha256 of the canonical authorization, as the mirror defines it", () => {
      expect(computeSessionKeyAuthDigest(sessionKeyAuth)).toBe(sha(canonicalize(sessionKeyAuth)));
      expect(sessionKeyAuthSnapshot(sessionKeyAuth).digest).toBe(computeSessionKeyAuthDigest(sessionKeyAuth));
    });

    it("returns a deep-frozen plain copy that is not the object passed in", () => {
      const auth = freshAuth();
      const snap = sessionKeyAuthSnapshot(auth);
      expect(snap.value).toEqual(auth);
      expect(snap.value).not.toBe(auth);
      expect(snap.value.scope).not.toBe(auth.scope);
      expect(snap.value.scope.allowedActions).not.toBe(auth.scope.allowedActions);
      expect(snap.value.scope.contractIds).not.toBe(auth.scope.contractIds);
      for (const frozen of [snap, snap.value, snap.value.scope, snap.value.scope.allowedActions, snap.value.scope.contractIds]) {
        expect(Object.isFrozen(frozen)).toBe(true);
      }
      expect(() => {
        (snap.value as { sessionId: string }).sessionId = "x";
      }).toThrow(TypeError);
      expect(() => {
        (snap.value.scope.contractIds as string[]).push("x");
      }).toThrow(TypeError);
    });

    it("the digest is computed over the returned value, and later changes to the original do not reach either", () => {
      const auth = freshAuth();
      const snap = sessionKeyAuthSnapshot(auth);
      expect(sha(canonicalize(snap.value))).toBe(snap.digest);
      auth.sessionId = "changed-after-hashing";
      auth.scope.contractIds.push("added-after-hashing");
      expect(snap.value.sessionId).toBe("sess-golden");
      expect(snap.value.scope.contractIds).toEqual(["unit-golden"]);
      expect(sha(canonicalize(snap.value))).toBe(snap.digest);
      expect(computeSessionKeyAuthDigest(auth)).not.toBe(snap.digest);
    });

    it("snapshotting a snapshot is idempotent", () => {
      const snap = sessionKeyAuthSnapshot(freshAuth());
      expect(sessionKeyAuthSnapshot(snap.value as SessionKeyAuthorization).digest).toBe(snap.digest);
    });

    it("refuses an accessor property without invoking it, at every depth", () => {
      let reads = 0;
      const withGetter = (target: object, key: string) =>
        Object.defineProperty(target, key, {
          enumerable: true,
          configurable: true,
          get() {
            reads++;
            return "x";
          },
        });
      const top = withGetter(freshAuth(), "sessionId");
      expect(refuseAuth(top).field).toBe(`${P}.sessionId`);

      const nested = freshAuth();
      withGetter(nested.scope, "maxSignatures");
      expect(refuseAuth(nested).field).toBe(`${P}.scope.maxSignatures`);

      const element = freshAuth();
      withGetter(element.scope.contractIds, "0");
      expect(refuseAuth(element).field).toBe(`${P}.scope.contractIds[0]`);

      const scopeGetter = freshAuth();
      const realScope = scopeGetter.scope;
      Object.defineProperty(scopeGetter, "scope", {
        enumerable: true,
        get() {
          reads++;
          return realScope;
        },
      });
      expect(refuseAuth(scopeGetter).field).toBe(`${P}.scope`);
      expect(reads).toBe(0);
    });

    it("refuses a Proxy, including one that changes its answers, without running any trap", () => {
      const trapped = () =>
        new Proxy(
          {},
          {
            get(_t, trap) {
              throw new Error(`proxy trap looked up: ${String(trap)}`);
            },
          },
        );
      const proxied = new Proxy(freshAuth(), trapped());
      expect(refuseAuth(proxied).field).toBe(P);
      const scopeProxy = freshAuth();
      (scopeProxy as { scope: unknown }).scope = new Proxy(scopeProxy.scope, trapped());
      expect(refuseAuth(scopeProxy).field).toBe(`${P}.scope`);
      const arrayProxy = freshAuth();
      arrayProxy.scope.allowedActions = new Proxy(arrayProxy.scope.allowedActions, trapped());
      expect(refuseAuth(arrayProxy).field).toBe(`${P}.scope.allowedActions`);
      // The reviewer's shape: a first read that validates and a second that differs.
      let reads = 0;
      const shifting = new Proxy(freshAuth(), {
        get(target, key, receiver) {
          if (key === "publicKey") return ++reads === 1 ? "aa".repeat(32) : "cc".repeat(32);
          return Reflect.get(target, key, receiver);
        },
      });
      expect(refuseAuth(shifting).field).toBe(P);
      expect(reads).toBe(0);
    });

    it("refuses an unknown own key, a symbol key and a non-enumerable field", () => {
      const extra = refuseAuth({ ...freshAuth(), extra: 1 });
      expect(extra.field).toBe(P);
      expect(extra.message).toMatch(/unknown own key "extra"/);
      const scoped = freshAuth();
      (scoped.scope as unknown as Record<string, unknown>).extra = 1;
      expect(refuseAuth(scoped).field).toBe(`${P}.scope`);
      const symbolic = { ...freshAuth(), [Symbol("s")]: 1 };
      expect(refuseAuth(symbolic).message).toMatch(/unknown own key/);
      const hidden = freshAuth();
      Object.defineProperty(hidden, "sessionId", { enumerable: false, value: "sess-golden" });
      const err = refuseAuth(hidden);
      expect(err.field).toBe(`${P}.sessionId`);
      expect(err.message).toMatch(/enumerable/);
    });

    it("refuses anything that is not a plain object, and accepts plain objects from another realm or without a prototype", () => {
      class Klass {
        constructor(init: object) {
          Object.assign(this, init);
        }
      }
      expect(refuseAuth(new Klass(freshAuth())).field).toBe(P);
      for (const bad of [null, undefined, 7, "auth", [], new Map()]) {
        expect(refuseAuth(bad).field, String(bad)).toBe(P);
      }
      const bare = Object.assign(Object.create(null), freshAuth());
      expect(computeSessionKeyAuthDigest(bare)).toBe(computeSessionKeyAuthDigest(sessionKeyAuth));
      const foreign = runInNewContext(`({
        sessionId: "sess-golden", parentAgentId: "kernel-golden-01", publicKey: "${"aa".repeat(32)}",
        issuedAt: 1699999000, expiresAt: 1700003600,
        scope: { allowedActions: ["sign-evidence"], contractIds: ["unit-golden"], maxSignatures: 8 },
        parentSignature: "${"bb".repeat(64)}"
      })`);
      expect(computeSessionKeyAuthDigest(foreign)).toBe(computeSessionKeyAuthDigest(sessionKeyAuth));
    });

    it("refuses a missing required field and names it", () => {
      for (const key of ["sessionId", "parentAgentId", "publicKey", "issuedAt", "expiresAt", "scope", "parentSignature"]) {
        const auth = freshAuth() as unknown as Record<string, unknown>;
        delete auth[key];
        expect(refuseAuth(auth).field, key).toBe(`${P}.${key}`);
      }
      for (const key of ["allowedActions", "contractIds", "maxSignatures"]) {
        const auth = freshAuth();
        delete (auth.scope as unknown as Record<string, unknown>)[key];
        expect(refuseAuth(auth).field, key).toBe(`${P}.scope.${key}`);
      }
    });

    it("refuses wrong types and numbers that are not safe non-negative integers", () => {
      for (const key of ["sessionId", "parentAgentId", "publicKey", "parentSignature"]) {
        for (const bad of ["", 5, null, undefined]) {
          expect(refuseAuth({ ...freshAuth(), [key]: bad }).field, `${key}=${String(bad)}`).toBe(`${P}.${key}`);
        }
      }
      for (const key of ["issuedAt", "expiresAt"]) {
        for (const bad of [-1, 1.5, NaN, Infinity, "1", null, -0, 2 ** 53]) {
          expect(refuseAuth({ ...freshAuth(), [key]: bad }).field, `${key}=${String(bad)}`).toBe(`${P}.${key}`);
        }
      }
      for (const bad of [-1, 1.5, NaN, Infinity, "8", null, -0, 2 ** 53]) {
        const auth = freshAuth();
        (auth.scope as unknown as Record<string, unknown>).maxSignatures = bad;
        expect(refuseAuth(auth).field, `maxSignatures=${String(bad)}`).toBe(`${P}.scope.maxSignatures`);
      }
    });

    it("refuses scope arrays that are not dense plain arrays of strings", () => {
      for (const key of ["allowedActions", "contractIds"] as const) {
        const field = `${P}.scope.${key}`;
        const set = (value: unknown) => {
          const auth = freshAuth();
          (auth.scope as unknown as Record<string, unknown>)[key] = value;
          return refuseAuth(auth);
        };
        for (const bad of ["sign-evidence", null, undefined, {}, { length: 0 }]) {
          expect(set(bad).field, `${key}=${String(bad)}`).toBe(field);
        }
        expect(set([1]).field).toBe(`${field}[0]`);
        expect(set(["a", null]).field).toBe(`${field}[1]`);
        expect(set([, "a"]).message).toMatch(/dense/); // a hole
        const withExtra = ["a"] as string[] & { extra?: number };
        withExtra.extra = 1;
        expect(set(withExtra).message).toMatch(/dense/);
      }
    });

    it("an undefined derivationPath is the same authorization as an absent one; a present one is committed", () => {
      const absent = computeSessionKeyAuthDigest(freshAuth());
      expect(computeSessionKeyAuthDigest({ ...freshAuth(), derivationPath: undefined })).toBe(absent);
      const withPath = sessionKeyAuthSnapshot({ ...freshAuth(), derivationPath: "m/8004'/84532'/1'/0'" });
      expect(withPath.value.derivationPath).toBe("m/8004'/84532'/1'/0'");
      expect(withPath.digest).not.toBe(absent);
      expect(withPath.digest).toBe(sha(canonicalize({ ...sessionKeyAuth, derivationPath: "m/8004'/84532'/1'/0'" })));
      for (const bad of [5, "", null]) {
        expect(refuseAuth({ ...freshAuth(), derivationPath: bad }).field, String(bad)).toBe(`${P}.derivationPath`);
      }
    });
  });
});
