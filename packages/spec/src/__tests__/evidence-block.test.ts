import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
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
import { canonicalize, hashBundle, hashEvent, verifyEventHash } from "../util/canonical.js";
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

// ── E7c helpers: input code that runs during a call must never get to replace a global ──────────────

/**
 * The reviewer's attack: code that replaces Object.freeze with the identity function and queues the
 * restoration for the next microtask, so every freeze that runs in between is a no-op and the events
 * handed back stay mutable. `run()` is what a hostile getter or Proxy trap would call. `restore()` puts
 * the real function back: every test that arms this calls it in a finally, so a failing test cannot
 * leave the sabotage behind.
 */
function freezeSaboteur() {
  const realFreeze = Object.freeze;
  const state = { runs: 0 };
  const install = (fn: unknown) => {
    (Object as unknown as { freeze: unknown }).freeze = fn;
  };
  return {
    state,
    realFreeze,
    run() {
      state.runs++;
      install((o: unknown) => o);
      queueMicrotask(() => install(realFreeze));
    },
    restore() {
      install(realFreeze);
    },
  };
}

/** Whether `root` and every object reachable from it (through own data properties) is frozen. */
function isDeeplyFrozen(root: unknown): boolean {
  const pending: unknown[] = [root];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (!Object.isFrozen(node)) return false;
    for (const key of Reflect.ownKeys(node)) pending.push(Object.getOwnPropertyDescriptor(node, key)?.value);
  }
  return true;
}

/** A Proxy handler whose EVERY trap records its name (and calls `onTrap`), then forwards to the target. A refused Proxy must leave `log` empty. */
function recordingHandler<T extends object = object>(log: string[], onTrap?: (name: string) => void): ProxyHandler<T> {
  const traps = [
    "get",
    "set",
    "has",
    "deleteProperty",
    "defineProperty",
    "getOwnPropertyDescriptor",
    "ownKeys",
    "getPrototypeOf",
    "setPrototypeOf",
    "isExtensible",
    "preventExtensions",
    "apply",
    "construct",
  ] as const;
  const handler: Record<string, unknown> = {};
  for (const name of traps) {
    handler[name] = (...args: unknown[]) => {
      log.push(name);
      onTrap?.(name);
      return (Reflect[name] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return handler as ProxyHandler<T>;
}

/**
 * The reviewer's attack, widened to every global an entry point could have looked up (round 2): code that
 * zeroes Buffer.from's hex words, sorts Array.prototype.sort descending and makes Object.freeze the identity,
 * restored by a microtask. `run()` is what a hostile getter or Proxy trap would call.
 */
function globalsSaboteur() {
  const realFrom = Buffer.from;
  const realSort = Array.prototype.sort;
  const realFreeze = Object.freeze;
  const state = { runs: 0 };
  const restore = () => {
    (Buffer as unknown as { from: unknown }).from = realFrom;
    (Array.prototype as unknown as { sort: unknown }).sort = realSort;
    (Object as unknown as { freeze: unknown }).freeze = realFreeze;
  };
  return {
    state,
    realFrom,
    realSort,
    realFreeze,
    restore,
    run() {
      state.runs++;
      (Buffer as unknown as { from: unknown }).from = (value: unknown, encoding?: string) =>
        (realFrom as (...args: unknown[]) => unknown)(typeof value === "string" && encoding === "hex" ? value.replace(/[0-9a-f]/g, "0") : value, encoding);
      (Array.prototype as unknown as { sort: unknown }).sort = function (this: string[]) {
        return realSort.call(this, (a, b) => (a < b ? 1 : a > b ? -1 : 0));
      };
      (Object as unknown as { freeze: unknown }).freeze = (o: unknown) => o;
      queueMicrotask(restore);
    },
  };
}

/** Run `fn` and report what happened, without a single call that a polluted prototype could intercept (no expect, no array method). */
function settle(fn: () => unknown): { error?: unknown; value?: unknown } {
  try {
    return { value: fn() };
  } catch (error) {
    return { error };
  }
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
    expect((await computeKernelSignedEventsRoot(b)).root).toBe(PINNED_ROOT);
    expect((await computeKernelSignedEventsRoot(b)).root).toBe(taggedDigestToBytes32(b.bundleHash));
  });

  it("an honest bundle over the v2 mirror inputs reproduces the block golden 0x854079f7…", async () => {
    const r = await goldenRoots();
    const { root } = await computeKernelSignedEventsRoot(await honest(rawEvents));
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

  it("refuses an event that is not plain JSON data (cycle, bigint, non-object), naming the member", async () => {
    const b = await honest();
    const cyclic: Record<string, unknown> = { ...b.events[0]! };
    cyclic.self = cyclic;
    const withBigInt = { ...b.events[0]!, payload: { n: 1n } };
    const cases: Array<[unknown, string]> = [
      [cyclic, "events[0].self"],
      [withBigInt, "events[0].payload.n"],
      [null, "events[0]"],
      [42, "events[0]"],
      ["event", "events[0]"],
      [[], "events[0]"],
      [[1, 2], "events[0]"],
      [() => 1, "events[0]"],
    ];
    for (const [bad, field] of cases) {
      const err = await refusalOfAsync(() => computeKernelSignedEventsRoot({ events: [bad as never], bundleHash: b.bundleHash }));
      expect(err.field, String(bad)).toBe(field);
    }
  });

  it("does not depend on event order or on the transport id (neither is in the preimage)", async () => {
    const b = await honest();
    expect((await computeKernelSignedEventsRoot({ events: [...b.events].reverse(), bundleHash: b.bundleHash })).root).toBe(PINNED_ROOT);
    const renamed = b.events.map((e, i) => ({ ...e, id: `transport-${i}` }));
    expect((await computeKernelSignedEventsRoot({ events: renamed, bundleHash: b.bundleHash })).root).toBe(PINNED_ROOT);
  });

  // E7c. This test used to ACCEPT a getter on the bundle and pin that it ran exactly once. That was the
  // hole: a getter runs caller code before any snapshot exists, and that code can swap Object.freeze for
  // one microtask so the events handed back stay mutable (see the reproduction below). The bundle is now
  // read from its own descriptors, never with a [[Get]], and an accessor is refused unread.
  it("refuses a getter on the bundle, for events and for bundleHash, and never runs it", async () => {
    const b = await honest();
    for (const name of ["events", "bundleHash"] as const) {
      let runs = 0;
      const getter = (value: unknown) => ({
        enumerable: true,
        get: () => {
          runs++;
          return value;
        },
      });
      const live = Object.defineProperties(
        {},
        {
          events: name === "events" ? getter(b.events) : { enumerable: true, value: b.events },
          bundleHash: name === "bundleHash" ? getter(b.bundleHash) : { enumerable: true, value: b.bundleHash },
        },
      );
      const err = await refusalOfAsync(() => computeKernelSignedEventsRoot(live as never));
      expect(err.field, name).toBe(name);
      expect(err.message, name).toMatch(/a getter on the bundle runs code/);
      expect(runs, `the ${name} getter must not run`).toBe(0);
    }
  });

  it("(a) the reviewer's reproduction (E7c): an honest bundle behind an events getter that swaps Object.freeze is refused, and the getter never runs", async () => {
    const b = await honest();
    const sab = freezeSaboteur();
    try {
      const bundle = {
        get events() {
          sab.run(); // Object.freeze := identity, restored by a microtask the call would only reach at its first await
          return b.events;
        },
        bundleHash: b.bundleHash,
      };
      const err = await refusalOfAsync(() => computeKernelSignedEventsRoot(bundle as never));
      expect(err.field).toBe("events");
      expect(err.message).toMatch(/a getter on the bundle runs code/);
      expect(sab.state.runs, "the getter must not run").toBe(0);
      expect(Object.freeze, "Object.freeze must be untouched").toBe(sab.realFreeze);
    } finally {
      sab.restore();
    }
    // The same honest bundle as plain data is accepted, and what comes back is frozen at every depth,
    // so the reviewer's step 5 (mutate result.events[0].payload) throws instead of diverging the hash.
    const result = await computeKernelSignedEventsRoot({ events: b.events, bundleHash: b.bundleHash });
    expect(result.root).toBe(PINNED_ROOT);
    expect(isDeeplyFrozen(result)).toBe(true);
    expect(() => {
      (result.events[0]!.payload as { ok: boolean }).ok = false;
    }).toThrow(TypeError);
  });

  it("refuses a getter the bundle inherits from its class, and a property it only inherits or lacks", async () => {
    const b = await honest();
    let runs = 0;
    class Lazy {
      get events() {
        runs++;
        return b.events;
      }
      get bundleHash() {
        runs++;
        return b.bundleHash;
      }
    }
    expect((await refusalOfAsync(() => computeKernelSignedEventsRoot(new Lazy() as never))).field).toBe("events");
    expect(runs, "an inherited getter must not run").toBe(0);
    const inherited = Object.create({ events: b.events, bundleHash: b.bundleHash });
    expect((await refusalOfAsync(() => computeKernelSignedEventsRoot(inherited))).field).toBe("events");
    expect((await refusalOfAsync(() => computeKernelSignedEventsRoot({ bundleHash: b.bundleHash } as never))).field).toBe("events");
    const noHash = await refusalOfAsync(() => computeKernelSignedEventsRoot({ events: b.events } as never));
    expect(noHash.field).toBe("bundleHash");
    expect(noHash.message).toMatch(/own data property/);
  });

  it("still accepts a bundle that holds events and bundleHash as own data properties, however it was built", async () => {
    const b = await honest();
    class Fields {
      events = b.events;
      bundleHash = b.bundleHash;
    }
    const shapes: Array<[string, unknown]> = [
      ["a plain object", { events: b.events, bundleHash: b.bundleHash }],
      ["a frozen object", Object.freeze({ events: b.events, bundleHash: b.bundleHash })],
      ["a null-prototype object", Object.assign(Object.create(null), b)],
      ["a class instance with fields", new Fields()],
      ["non-enumerable own data properties", Object.defineProperties({}, { events: { value: b.events }, bundleHash: { value: b.bundleHash } })],
    ];
    for (const [label, bundle] of shapes) {
      const result = await computeKernelSignedEventsRoot(bundle as never);
      expect(result.root, label).toBe(PINNED_ROOT);
      expect(isDeeplyFrozen(result), label).toBe(true);
    }
  });

  it("an accessor on an event is refused without being invoked: a hash getter that changes its answer cannot split verification from hashing", async () => {
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
    // does not have. The snapshot never runs the getter at all: it refuses the accessor where it
    // stands (it was refused only after one read when the snapshot was a JSON round trip).
    const bundleHash = await hashBundle([{ ...b.events[0]!, hash: fake }, b.events[1]!]);
    const err = await refusalOfAsync(() =>
      computeKernelSignedEventsRoot({ events: [shifty as typeof b.events[0], b.events[1]!], bundleHash }),
    );
    expect(err.field).toBe("events[0].hash");
    expect(err.message).toMatch(/accessor property/);
    expect(reads).toBe(0);
  });

  // E7c. This test used to ACCEPT a Proxy events array and pin that each element was read once through
  // its `get` trap. A trap is caller code that runs before the snapshot exists: it is refused unasked.
  it("refuses an events array that is a Proxy, without running a single trap", async () => {
    const b = await honest();
    const traps: string[] = [];
    const counted = new Proxy([...b.events], recordingHandler(traps));
    const err = await refusalOfAsync(() => computeKernelSignedEventsRoot({ events: counted, bundleHash: b.bundleHash } as never));
    expect(err.field).toBe("events");
    expect(err.message).toMatch(/is a Proxy/);
    expect(traps, "no trap may run").toEqual([]);
  });

  it("refuses an accessor element of the events array without running it", async () => {
    const b = await honest();
    let runs = 0;
    const events = [...b.events];
    Object.defineProperty(events, 1, {
      enumerable: true,
      get: () => {
        runs++;
        return b.events[1];
      },
    });
    const err = await refusalOfAsync(() => computeKernelSignedEventsRoot({ events, bundleHash: b.bundleHash } as never));
    expect(err.field).toBe("events[1]");
    expect(err.message).toMatch(/accessor element/);
    expect(runs, "the element getter must not run").toBe(0);
  });
});

// ── E7b (HIGH): the events are ONE snapshot of plain JSON data, and that snapshot is returned ──
// A JSON.stringify/parse round trip stood in for the snapshot. It ran an attacker's toJSON and
// getters, accepted class instances and normalised NaN to null, so a bundle was verified and
// committed as a PROJECTION of the events submitted. The snapshot is now #359's canonicalSnapshot
// and computeKernelSignedEventsRoot returns it, so a consumer evaluates what was hashed.
describe("E7b — computeKernelSignedEventsRoot verifies, commits and returns one snapshot of plain JSON data", () => {
  type Body = Omit<EvidenceEvent, "id" | "hash">;
  const bodyOf = (payload: unknown): Body =>
    ({ type: "execution_completed", timestamp: "2026-08-20T00:00:00Z", source, payload }) as unknown as Body;
  const refuse = (bundle: unknown) => refusalOfAsync(() => computeKernelSignedEventsRoot(bundle as never));

  /**
   * A bundle whose carried event hash and bundleHash are computed over `preimage`, while the event
   * SUBMITTED carries `submitted` (the same value by default: an honest bundle).
   */
  const bundleOf = async (preimage: unknown, submitted: unknown = preimage) => {
    const hash = await hashEvent(bodyOf(preimage));
    const honestEvent = { ...bodyOf(preimage), id: "e1", hash };
    const bundleHash = await hashBundle([honestEvent]);
    return { honestEvent, bundleHash, bundle: { events: [{ ...bodyOf(submitted), id: "e1", hash }], bundleHash } };
  };

  /** Two events with nested payloads, so copying and freezing are exercised at depth. */
  const twoEvents = async () => {
    const raw: Body[] = [
      bodyOf({ ok: true, nested: { list: [1, 2, { deep: "x" }] } }),
      { ...bodyOf({ pass: 1, defects: 0 }), type: "cv_inspection_result", timestamp: "2026-08-20T00:00:05Z" },
    ];
    const events = await Promise.all(raw.map(async (e, i) => ({ ...e, id: `e${i}`, hash: await hashEvent(e) })));
    return { events, bundleHash: await hashBundle(events) };
  };

  it("(a) refuses a NaN twin that carries the same event hash and bundleHash as a {value: null} event (the reviewer's repro)", async () => {
    const honest = await bundleOf({ value: null });
    const twin = await bundleOf({ value: null }, { value: NaN });
    expect(twin.bundle.events[0]!.hash).toBe(honest.bundle.events[0]!.hash);
    expect(twin.bundle.bundleHash).toBe(honest.bundle.bundleHash);
    // The honest bundle verifies. JSON.stringify turned the twin's NaN into null, so the old round
    // trip verified it too and committed the same root for evidence that never said null.
    expect((await computeKernelSignedEventsRoot(honest.bundle as never)).root).toBe(taggedDigestToBytes32(honest.bundleHash));
    const err = await refuse(twin.bundle);
    expect(err.field).toBe("events[0].payload.value");
    expect(err.message).toMatch(/NaN/);
    // hashEvent has no hash for the twin at all, so it cannot be the event that was hashed.
    await expect(hashEvent(bodyOf({ value: NaN }))).rejects.toThrow(/NaN/);
  });

  it("(a) refuses every other value that JSON cannot carry exactly, naming the member, before any hash is compared", async () => {
    const cases: Array<[string, unknown, string]> = [
      ["Infinity", { value: Infinity }, "events[0].payload.value"],
      ["-Infinity", { value: -Infinity }, "events[0].payload.value"],
      ["an undefined array element (JSON writes null)", { list: [undefined] }, "events[0].payload.list[0]"],
      // eslint-disable-next-line no-sparse-arrays
      ["a hole in a sparse array (JSON writes null)", { list: [, 1] }, "events[0].payload.list[0]"],
      ["a bigint", { n: 1n }, "events[0].payload.n"],
      ["a function", { f: () => 1 }, "events[0].payload.f"],
      ["a symbol value", { s: Symbol("s") }, "events[0].payload.s"],
      ["an integer outside the safe range", { n: 2 ** 53 }, "events[0].payload.n"],
      ["a symbol-keyed property", { [Symbol("k")]: 1 }, "events[0].payload[Symbol(k)]"],
    ];
    for (const [label, submitted, field] of cases) {
      // The carried hashes are those of a stand-in payload: the refusal comes from the snapshot,
      // not from a hash mismatch (which would be reported at events[0].hash).
      const { bundle } = await bundleOf({ stand: "in" }, submitted);
      expect((await refuse(bundle)).field, label).toBe(field);
    }
  });

  it("(a) refuses a hole or an undefined entry in the events array, at its index", async () => {
    const b = await twoEvents();
    // eslint-disable-next-line no-sparse-arrays
    for (const events of [[undefined, b.events[1]], [, b.events[1]]]) {
      expect((await refuse({ events, bundleHash: b.bundleHash })).field).toBe("events[0]");
    }
  });

  it("(b) refuses a toJSON on the event, so the object that was hashed cannot stand in for the one submitted", async () => {
    const { honestEvent, bundleHash } = await bundleOf({ ok: true });
    const forged = { ...bodyOf({ reason: "never hashed" }), id: "e1", hash: honestEvent.hash };
    let calls = 0;
    const toJSON = () => {
      calls++;
      return honestEvent;
    };
    // The old round trip called toJSON and committed honestEvent in place of the object submitted.
    expect((await refuse({ events: [{ ...forged, toJSON }], bundleHash })).field).toBe("events[0].toJSON");
    const hidden = { ...forged };
    Object.defineProperty(hidden, "toJSON", { enumerable: false, value: toJSON });
    expect((await refuse({ events: [hidden], bundleHash })).field).toBe("events[0].toJSON");
    class Forged {
      constructor() {
        Object.assign(this, forged);
      }
      toJSON() {
        return toJSON();
      }
    }
    expect((await refuse({ events: [new Forged()], bundleHash })).field).toBe("events[0]");
    // The same on a payload: JSON would have replaced it with {ok: true}, the hashed payload.
    expect((await refuse((await bundleOf({ ok: true }, { toJSON: () => ({ ok: true }) })).bundle)).field).toBe(
      "events[0].payload.toJSON",
    );
    expect(calls, "no toJSON may run").toBe(0);
  });

  it("(c) refuses an accessor anywhere in an event and never runs it", async () => {
    let reads = 0;
    const accessor = {
      enumerable: true,
      configurable: true,
      get: () => {
        reads++;
        return 1;
      },
    };
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["a payload member", { payload: Object.defineProperty({}, "value", accessor) }, "events[0].payload.value"],
      ["a payload array element", { payload: { list: Object.defineProperty([], 0, accessor) } }, "events[0].payload.list[0]"],
      ["a member of source", { source: Object.defineProperty({ ...source }, "deviceId", accessor) }, "events[0].source.deviceId"],
    ];
    for (const [label, override, field] of cases) {
      // The getter answers 1, which is what the carried hash was computed over: a round trip accepts it.
      const { bundle } = await bundleOf({ value: 1 });
      const err = await refuse({ ...bundle, events: [{ ...bundle.events[0]!, ...override }] });
      expect(err.field, label).toBe(field);
      expect(err.message, label).toMatch(/accessor/);
    }
    expect(reads, "no getter may run").toBe(0);
  });

  it("(d) refuses a class instance and every other non-plain object, wherever it appears", async () => {
    class Payload {
      value = 1;
    }
    const asPayload = await bundleOf({ value: 1 }, new Payload());
    const err = await refuse(asPayload.bundle);
    expect(err.field).toBe("events[0].payload");
    expect(err.message).toMatch(/non-plain object/);

    class Evt {}
    const { bundle } = await bundleOf({ ok: true });
    expect((await refuse({ ...bundle, events: [Object.assign(new Evt(), bundle.events[0])] })).field).toBe("events[0]");

    const odd: Array<[string, unknown]> = [
      ["a Date", new Date(0)],
      ["a Map", new Map()],
      ["a Set", new Set()],
      ["a RegExp", /x/],
      ["a typed array", new Uint8Array(1)],
      ["an Error", new Error("x")],
      ["an object with a substituted prototype", Object.create({ inherited: 1 })],
    ];
    for (const [label, value] of odd) {
      expect((await refuse((await bundleOf({ ok: true }, { odd: value })).bundle)).field, label).toBe("events[0].payload.odd");
    }
  });

  it("(e) refuses an undefined array element; an undefined OBJECT member is omitted, in the hash and in the returned events alike", async () => {
    const { bundle: arrayCase } = await bundleOf({ list: [null] }, { list: [undefined] });
    expect((await refuse(arrayCase)).field).toBe("events[0].payload.list[0]");

    // canonicalize omits an undefined OBJECT member everywhere in the repo (hashEvent and
    // verifyEventHash accept the event with and without it) and JSON transport drops it, so it is
    // absent from the hashed text and from the events handed back. It is not refused: that would
    // take a second read of the input and make this step stricter than verifyEventHash. Pinned so
    // that a change of that policy (a strict mode in canonicalSnapshot) is noticed.
    const { bundle } = await bundleOf({ a: 1, c: {} }, { a: 1, b: undefined, c: { d: undefined } });
    expect(await verifyEventHash(bundle.events[0] as never)).toBe(true);
    expect(Object.keys(bundle.events[0]!.payload)).toEqual(["a", "b", "c"]);
    const result = await computeKernelSignedEventsRoot(bundle as never);
    const payload = result.events[0]!.payload;
    expect(Object.keys(payload)).toEqual(["a", "c"]);
    expect("b" in payload).toBe(false);
    expect(payload).toEqual({ a: 1, c: {} });
    expect(result.root).toBe(taggedDigestToBytes32(bundle.bundleHash));
  });

  describe("(f) the returned events are the verified snapshot", () => {
    it("returns { root, events }: the root is the bundleHash, and events are the submitted events, in the order given", async () => {
      const b = await twoEvents();
      const result = await computeKernelSignedEventsRoot(b);
      expect(Object.keys(result)).toEqual(["root", "events"]);
      expect(result.root).toBe(taggedDigestToBytes32(b.bundleHash));
      expect(result.events).toHaveLength(2);
      for (let i = 0; i < b.events.length; i++) {
        expect(result.events[i]).toEqual(b.events[i]);
        expect(canonicalize(result.events[i])).toBe(canonicalize(b.events[i]));
      }
      const reversed = await computeKernelSignedEventsRoot({ events: [...b.events].reverse(), bundleHash: b.bundleHash });
      expect(reversed.events.map((e) => e.id)).toEqual(["e1", "e0"]);
      expect(reversed.root).toBe(result.root);
    });

    it("hands back copies, not the objects that were passed in", async () => {
      const b = await twoEvents();
      const result = await computeKernelSignedEventsRoot(b);
      for (let i = 0; i < b.events.length; i++) {
        expect(result.events[i]).not.toBe(b.events[i]);
        expect(result.events[i]!.payload).not.toBe(b.events[i]!.payload);
        expect(result.events[i]!.source).not.toBe(b.events[i]!.source);
      }
      expect(result.events).not.toBe(b.events);
    });

    it("the result, the events array and every event are frozen at every depth", async () => {
      const result = await computeKernelSignedEventsRoot(await twoEvents());
      const nested = (result.events[0]!.payload as { nested: { list: unknown[] } }).nested;
      for (const frozen of [result, result.events, result.events[0], result.events[0]!.payload, result.events[0]!.source, nested, nested.list, nested.list[2]]) {
        expect(Object.isFrozen(frozen)).toBe(true);
      }
      expect(() => {
        (result.events[0] as { type: string }).type = "x";
      }).toThrow(TypeError);
      expect(() => {
        (result.events as EvidenceEvent[]).push(result.events[0]!);
      }).toThrow(TypeError);
      expect(() => {
        nested.list.push(3);
      }).toThrow(TypeError);
      expect(() => {
        (nested.list[2] as { deep: string }).deep = "y";
      }).toThrow(TypeError);
      expect(() => {
        (result as { root: string }).root = "0x";
      }).toThrow(TypeError);
    });

    it("does not change when the input is mutated afterwards, and still verifies against the root", async () => {
      const b = await twoEvents();
      const input = structuredClone(b);
      const result = await computeKernelSignedEventsRoot(input);
      const before = result.events.map((e) => canonicalize(e));
      // Everything a caller could do to the objects it passed in after the call returned.
      const first = input.events[0] as unknown as { payload: { ok: boolean; nested: { list: unknown[] } }; hash: string };
      first.payload.ok = false;
      first.payload.nested.list.push(99);
      first.hash = `sha256:${"00".repeat(32)}`;
      input.events[1]!.type = "execution_failed";
      input.events.length = 0;
      input.bundleHash = `sha256:${"11".repeat(32)}` as typeof input.bundleHash;
      expect(result.events.map((e) => canonicalize(e))).toEqual(before);
      // What was returned is what was hashed: re-verifying it reproduces every carried hash and the root.
      for (const e of result.events) expect(await hashEvent(e)).toBe(e.hash);
      expect(taggedDigestToBytes32(await hashBundle([...result.events]))).toBe(result.root);
    });

    it("hands back prototype-less plain data, as canonicalSnapshot documents", async () => {
      const result = await computeKernelSignedEventsRoot(await twoEvents());
      expect(Object.getPrototypeOf(result.events[0])).toBeNull();
      expect(Object.getPrototypeOf(result.events[0]!.payload)).toBeNull();
      expect(Object.getPrototypeOf(result.events[0]!.source)).toBeNull();
      expect(Array.isArray((result.events[0]!.payload as { nested: { list: unknown } }).nested.list)).toBe(true);
    });

    it("accepts every legitimate spelling of the same plain data and returns the same events", async () => {
      const b = await twoEvents();
      const expected = await computeKernelSignedEventsRoot(b);
      const variants: Array<[string, unknown[]]> = [
        ["a frozen event", b.events.map((e) => Object.freeze({ ...e }))],
        ["a structuredClone", b.events.map((e) => structuredClone(e))],
        ["a null-prototype event", b.events.map((e) => Object.assign(Object.create(null), structuredClone(e)))],
      ];
      for (const [label, events] of variants) {
        const result = await computeKernelSignedEventsRoot({ events, bundleHash: b.bundleHash } as never);
        expect(result.root, label).toBe(expected.root);
        expect(result.events, label).toEqual(expected.events);
      }
    });
  });

  // E7c. This test used to ACCEPT a Proxy event and pin that it was read once through its reflection
  // traps, so a shifting answer could not split what was hashed from what was returned. A trap is caller
  // code, and code that runs while the snapshot is made can swap Object.freeze (see the E7c block below):
  // a Proxy is now refused before any trap runs, so there is no second answer to guard against.
  it("(g) refuses a Proxy event before any trap runs, whatever its traps would answer", async () => {
    const b = await twoEvents();
    const first = b.events[0]!;
    const traps: string[] = [];
    let payloadReads = 0;
    const shifting = new Proxy(
      { ...first },
      {
        ...recordingHandler(traps),
        getOwnPropertyDescriptor(target, key) {
          traps.push("getOwnPropertyDescriptor");
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          // From the second read on, payload would answer differently from what was hashed.
          return key === "payload" && ++payloadReads > 1 && descriptor !== undefined
            ? { ...descriptor, value: { ok: false } }
            : descriptor;
        },
      },
    );
    const err = await refusalOfAsync(() =>
      computeKernelSignedEventsRoot({ events: [shifting as never, b.events[1]!], bundleHash: b.bundleHash }),
    );
    expect(err.field).toBe("events[0]");
    expect(err.message).toMatch(/is a Proxy/);
    expect(traps, "no trap may run").toEqual([]);
    expect(payloadReads).toBe(0);
  });

  it("a value nested beyond the engine's recursion limit is refused as an EvidenceBlockInputError, never a RangeError", async () => {
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 100_000; i++) deep = { d: deep };
    const { bundle } = await bundleOf({ stand: "in" }, deep);
    const err = await refuse(bundle);
    expect(err.field).toBe("events[0]");
    expect(err.message).toMatch(/plain JSON tree/);
    // The same value as the event itself.
    expect((await refuse({ ...bundle, events: [deep] })).field).toBe("events[0]");
  });

  it("a refusal names the event and the member, and cannot be used to inject log lines or grow without bound", async () => {
    const hostile = `evil${String.fromCharCode(10)}FORGED LOG LINE${String.fromCharCode(0)}${"k".repeat(5000)}`;
    const { bundle } = await bundleOf({ stand: "in" }, { [hostile]: NaN });
    const err = await refuse(bundle);
    expect(err.field.startsWith("events[0].payload.evil")).toBe(true);
    expect(err.field).not.toMatch(/\p{Cc}/u);
    expect(err.message).not.toMatch(/\p{Cc}/u);
    expect(err.field.length).toBeLessThanOrEqual(203);
    expect(err.message.length).toBeLessThan(700);
    expect(err.message).toMatch(/NaN/);
  });
});

// ── E7c (HIGH): input that can run code is refused before it is read ─────────────────────────────────
// A getter on the bundle, a Proxy at any depth and an accessor all run CALLER code while the snapshot is
// being made, and that code can replace Object.freeze for one microtask (queueMicrotask restores it): the
// freezes become no-ops, result.events stay mutable, and the events a consumer evaluates are no longer the
// events that were committed (recomputing a mutated event's hash no longer matches the carried hash and
// root). The reviewer's exact reproduction, (a), sits beside "refuses a getter on the bundle" in the F1
// block above. Every such input is refused before it is read, and every function the module calls on the
// input is captured at load, so a global replaced later cannot change the freeze either.
describe("E7c — input that can run code is refused before it is read, and the snapshot freeze cannot be undone", () => {
  type Body = Omit<EvidenceEvent, "id" | "hash">;
  const bodies: Body[] = [
    { type: "execution_completed", timestamp: "2026-10-01T00:00:00Z", source, payload: { ok: true, nested: { list: [1, 2, { deep: "x" }] } } },
    { type: "cv_inspection_result", timestamp: "2026-10-01T00:00:05Z", source, payload: { pass: 1, defects: 0 } },
  ];
  /** An honest bundle: its carried hashes are the true ones, so WITHOUT the refusals every case below would succeed and the attack would work. */
  const honest = async () => {
    const events = await Promise.all(bodies.map(async (e, i) => ({ ...e, id: `e${i}`, hash: await hashEvent(e) })));
    return { events, bundleHash: await hashBundle(events) };
  };
  const refuse = (bundle: unknown) => refusalOfAsync(() => computeKernelSignedEventsRoot(bundle as never));
  const REAL_FREEZE = Object.freeze;
  afterEach(() => {
    const leaked = Object.freeze !== REAL_FREEZE;
    (Object as unknown as { freeze: unknown }).freeze = REAL_FREEZE; // do not poison the tests that follow
    expect(leaked, "a test left Object.freeze replaced").toBe(false);
  });

  it("(b) an events ARRAY that is a Proxy, live or revoked, is refused before a trap can swap Object.freeze", async () => {
    const b = await honest();
    const sab = freezeSaboteur();
    const traps: string[] = [];
    try {
      const events = new Proxy([...b.events], recordingHandler(traps, () => sab.run()));
      const err = await refuse({ events, bundleHash: b.bundleHash });
      expect(err.field).toBe("events");
      expect(err.message).toMatch(/is a Proxy/);
      // Array.isArray throws a TypeError on a revoked Proxy: the Proxy test must come first.
      const revoked = Proxy.revocable([...b.events], {});
      revoked.revoke();
      expect((await refuse({ events: revoked.proxy, bundleHash: b.bundleHash })).field).toBe("events");
      expect(traps, "no trap may run").toEqual([]);
      expect(sab.state.runs, "no trap may run").toBe(0);
    } finally {
      sab.restore();
    }
  });

  it("(c) a Proxy anywhere inside an event is refused before a trap can swap Object.freeze", async () => {
    const b = await honest();
    const sab = freezeSaboteur();
    const traps: string[] = [];
    const proxied = <T extends object>(target: T): T => new Proxy(target, recordingHandler(traps, () => sab.run()));
    type Clone = { payload: { nested: { list: unknown[] } }; source: object } & Record<string, unknown>;
    const first = () => structuredClone(b.events[0]!) as unknown as Clone;
    const second = () => structuredClone(b.events[1]!) as unknown as Clone;
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const cases: Array<[string, () => unknown[], string]> = [
      ["the payload", () => { const e = first(); e.payload = proxied(e.payload); return [e, b.events[1]]; }, "events[0].payload"],
      ["a member three levels down", () => { const e = first(); e.payload.nested.list[2] = proxied(e.payload.nested.list[2] as object); return [e, b.events[1]]; }, "events[0].payload.nested.list[2]"],
      ["an array inside the payload", () => { const e = first(); e.payload.nested.list = proxied(e.payload.nested.list); return [e, b.events[1]]; }, "events[0].payload.nested.list"],
      ["the source", () => { const e = first(); e.source = proxied(e.source); return [e, b.events[1]]; }, "events[0].source"],
      ["the event itself", () => [proxied(first()), b.events[1]], "events[0]"],
      ["the second event's payload", () => { const e = second(); e.payload = proxied(e.payload); return [b.events[0], e]; }, "events[1].payload"],
      ["a callable Proxy", () => { const e = first(); e.payload.nested.list[2] = proxied(function () {}); return [e, b.events[1]]; }, "events[0].payload.nested.list[2]"],
      ["a revoked Proxy", () => { const e = first(); e.payload.nested.list[2] = revoked.proxy; return [e, b.events[1]]; }, "events[0].payload.nested.list[2]"],
    ];
    try {
      for (const [label, build, field] of cases) {
        const err = await refuse({ events: build(), bundleHash: b.bundleHash });
        expect(err.field, label).toBe(field);
        expect(err.message, label).toMatch(/is a Proxy/);
      }
      expect(traps, "no trap may run").toEqual([]);
      expect(sab.state.runs, "no trap may run").toBe(0);
    } finally {
      sab.restore();
    }
  });

  it("(c) a Proxy as the PROTOTYPE of an event or of a payload object is refused without being asked anything", async () => {
    const b = await honest();
    const sab = freezeSaboteur();
    const traps: string[] = [];
    const proxied = () => new Proxy({}, recordingHandler(traps, () => sab.run()));
    try {
      const withProtoPayload = structuredClone(b.events[0]!) as unknown as { payload: object };
      Object.setPrototypeOf(withProtoPayload.payload, proxied());
      const err = await refuse({ events: [withProtoPayload, b.events[1]], bundleHash: b.bundleHash });
      expect(err.field).toBe("events[0].payload");
      expect(err.message).toMatch(/non-plain object/);
      const event = Object.setPrototypeOf(structuredClone(b.events[0]!), proxied());
      expect((await refuse({ events: [event, b.events[1]], bundleHash: b.bundleHash })).field).toBe("events[0]");
      expect(traps, "no trap may run").toEqual([]);
      expect(sab.state.runs, "no trap may run").toBe(0);
    } finally {
      sab.restore();
    }
  });

  it("(d) a bundle that is a Proxy, live or revoked, is refused before a trap can swap Object.freeze", async () => {
    const b = await honest();
    const sab = freezeSaboteur();
    const traps: string[] = [];
    try {
      const bundle = new Proxy({ events: b.events, bundleHash: b.bundleHash }, recordingHandler(traps, () => sab.run()));
      const err = await refuse(bundle);
      expect(err.field).toBe("bundle");
      expect(err.message).toMatch(/is a Proxy/);
      const revoked = Proxy.revocable({ events: b.events, bundleHash: b.bundleHash }, {});
      revoked.revoke();
      expect((await refuse(revoked.proxy)).field).toBe("bundle");
      expect(traps, "no trap may run").toEqual([]);
      expect(sab.state.runs, "no trap may run").toBe(0);
    } finally {
      sab.restore();
    }
  });

  it("(e) a bundleHash getter that swaps Object.freeze is refused, and never runs", async () => {
    const b = await honest();
    const sab = freezeSaboteur();
    try {
      const bundle = {
        events: b.events,
        get bundleHash() {
          sab.run();
          return b.bundleHash;
        },
      };
      const err = await refuse(bundle);
      expect(err.field).toBe("bundleHash");
      expect(err.message).toMatch(/a getter on the bundle runs code/);
      expect(sab.state.runs, "the getter must not run").toBe(0);
    } finally {
      sab.restore();
    }
  });

  it("(f) a caller that replaces Object.freeze for the whole call still gets deeply frozen events: the freeze is a captured reference", async () => {
    const b = await honest();
    const sab = freezeSaboteur();
    let result: Awaited<ReturnType<typeof computeKernelSignedEventsRoot>>;
    try {
      // Replaced before the call and kept replaced across every await in it (the reviewer's attack only
      // replaced it for one microtask; this is the stronger form, which the final freeze would also lose).
      (Object as unknown as { freeze: unknown }).freeze = (o: unknown) => o;
      result = await computeKernelSignedEventsRoot(b as never);
    } finally {
      sab.restore();
    }
    expect(result.root).toBe(taggedDigestToBytes32(b.bundleHash));
    expect(isDeeplyFrozen(result), "the result, its events array and every event at every depth").toBe(true);
    expect(() => {
      (result.events[0]!.payload as { ok: boolean }).ok = false;
    }).toThrow(TypeError);
    for (const e of result.events) expect(await hashEvent(e)).toBe(e.hash);
  });

  it("an accessor in an event is refused before a JSON-type defect that sorts ahead of it, and is never run", async () => {
    const b = await honest();
    let runs = 0;
    const payload: Record<string, unknown> = { a: NaN, z: 1 };
    Object.defineProperty(payload, "z", {
      enumerable: true,
      get: () => {
        runs++;
        return 1;
      },
    });
    const err = await refuse({ events: [{ ...structuredClone(b.events[0]!), payload }, b.events[1]], bundleHash: b.bundleHash });
    // canonicalSnapshot alone reports the NaN first (keys are visited in sorted order): the walk runs first.
    expect(err.field).toBe("events[0].payload.z");
    expect(err.message).toMatch(/accessor property: its getter runs code/);
    expect(runs, "the getter must not run").toBe(0);
  });

  it("a Proxy at the bottom of a very deep event is found without overflowing the stack, and without running a trap", async () => {
    const b = await honest();
    const traps: string[] = [];
    let deep: Record<string, unknown> = { leaf: new Proxy({}, recordingHandler(traps)) };
    for (let i = 0; i < 50_000; i++) deep = { d: deep };
    const err = await refuse({ events: [{ ...structuredClone(b.events[0]!), payload: deep }, b.events[1]], bundleHash: b.bundleHash });
    expect(err.message).toMatch(/is a Proxy/);
    expect(err.field.startsWith("events[0].payload.d.d.d")).toBe(true);
    expect(err.field.length).toBeLessThanOrEqual(203);
    expect(traps, "no trap may run").toEqual([]);
  });

  it("refuses an object canonicalize would refuse as non-plain before its members are looked at", async () => {
    const b = await honest();
    const traps: string[] = [];
    let runs = 0;
    class Holder {
      constructor() {
        Object.defineProperty(this, "x", {
          enumerable: true,
          get: () => {
            runs++;
            return 1;
          },
        });
      }
    }
    class Wrapper {
      member: object = new Proxy({}, recordingHandler(traps));
    }
    class Sub extends Array {}
    const cases: Array<[string, unknown]> = [
      ["a class instance with an accessor member", new Holder()],
      ["a class instance holding a Proxy", new Wrapper()],
      ["an Error", new Error("x")],
      ["a typed array", new Uint8Array(4)],
      ["an Array subclass", Sub.from([1])],
      ["an array with a substituted prototype", Object.setPrototypeOf([1], null)],
    ];
    for (const [label, odd] of cases) {
      const payload = { ok: true, odd };
      const err = await refuse({ events: [{ ...structuredClone(b.events[0]!), payload }, b.events[1]], bundleHash: b.bundleHash });
      expect(err.field, label).toBe("events[0].payload.odd");
      expect(err.message, label).toMatch(/non-plain object|substituted prototype/);
      expect(err.message, `${label}: its members must not be enumerated`).not.toMatch(/accessor|Proxy/);
    }
    expect(runs, "no getter may run").toBe(0);
    expect(traps, "no trap may run").toEqual([]);
  });

  it("walks a shared node once, and leaves a cycle to canonicalSnapshot: neither is refused as code-running", async () => {
    const shared = { k: 1 };
    const body = { ...bodies[0]!, payload: { a: shared, b: shared } };
    const event = { ...body, id: "e0", hash: await hashEvent(body) };
    const bundle = { events: [event], bundleHash: await hashBundle([event]) };
    const result = await computeKernelSignedEventsRoot(bundle as never);
    const payload = result.events[0]!.payload as { a: object; b: object };
    expect(payload.a).toEqual({ k: 1 });
    expect(payload.a).not.toBe(payload.b); // the snapshot holds two copies of what was hashed twice
    const cyclic: Record<string, unknown> = { ...event };
    cyclic.self = cyclic;
    expect((await refuse({ events: [cyclic], bundleHash: bundle.bundleHash })).field).toBe("events[0].self");
  });

  it("calls none of the replaceable intrinsics at call time: each one is a reference captured when the module loaded", async () => {
    const b = await honest();
    const auth = structuredClone(sessionKeyAuth);
    const counts: Record<string, number> = {};
    const restores: Array<() => void> = [];
    const spy = (target: object, name: string, label: string) => {
      const holder = target as Record<string, (...args: unknown[]) => unknown>;
      const real = holder[name]!;
      counts[label] = 0;
      holder[name] = (...args: unknown[]) => {
        counts[label] = counts[label]! + 1;
        return real(...args);
      };
      restores.push(() => {
        holder[name] = real;
      });
    };
    let live: Record<string, number> = {};
    let used: Record<string, number> = {};
    let pending: Promise<unknown> | undefined;
    try {
      spy(Object, "freeze", "Object.freeze");
      spy(Object, "getOwnPropertyDescriptor", "Object.getOwnPropertyDescriptor");
      spy(Object, "getPrototypeOf", "Object.getPrototypeOf");
      spy(Array, "isArray", "Array.isArray");
      spy(Reflect, "ownKeys", "Reflect.ownKeys");
      spy(Reflect, "getOwnPropertyDescriptor", "Reflect.getOwnPropertyDescriptor");
      spy(Reflect, "getPrototypeOf", "Reflect.getPrototypeOf");
      spy(Number, "isSafeInteger", "Number.isSafeInteger");
      spy(utilTypes, "isProxy", "util.types.isProxy");
      // The spies are live: the same calls made through the globals are counted.
      Object.freeze({});
      Object.getOwnPropertyDescriptor({}, "x");
      Object.getPrototypeOf({});
      Array.isArray([]);
      Reflect.ownKeys({});
      Reflect.getOwnPropertyDescriptor({}, "x");
      Reflect.getPrototypeOf({});
      Number.isSafeInteger(1);
      utilTypes.isProxy({});
      live = { ...counts };
      for (const label of Object.keys(counts)) counts[label] = 0;
      // All of this runs synchronously, so nothing else can call an intrinsic in between. The events call
      // runs to its first await: admission, both walks, the snapshots and their freezes.
      pending = computeKernelSignedEventsRoot(b as never);
      sessionKeyAuthSnapshot(auth);
      computeAttestationSetRoot(attJob, roles);
      computeAttestationRoleDigest(attJob, roles[0]!);
      used = { ...counts };
    } finally {
      for (const restore of restores) restore();
    }
    await pending;
    for (const [label, n] of Object.entries(live)) expect(n, `${label}: the spy must be live`).toBeGreaterThan(0);
    expect(used).toEqual(Object.fromEntries(Object.keys(counts).map((label) => [label, 0])));
  });

  it("the integer checks of the unit context use the captured Number.isSafeInteger", () => {
    // @noble/hashes calls Number.isSafeInteger itself (inside keccak), so the calls are compared, not
    // expected to be zero: a number input reaches this module's own check, a bigint input does not, so
    // the two counts are equal exactly when the module's check does not go through the global.
    const holder = Number as unknown as { isSafeInteger: (v: unknown) => boolean };
    const real = holder.isSafeInteger;
    let calls = 0;
    const callsOf = (fn: () => unknown) => {
      calls = 0;
      fn();
      return calls;
    };
    let asBigint: number;
    let asNumber: number;
    try {
      holder.isSafeInteger = (v) => {
        calls++;
        return real(v);
      };
      asBigint = callsOf(() => computeSettlementUnitId(unit));
      asNumber = callsOf(() => computeSettlementUnitId({ ...unit, chainId: 8453, milestoneIndex: 3 }));
    } finally {
      holder.isSafeInteger = real;
    }
    expect(asBigint).toBeGreaterThan(0); // the spy is live: keccak's own check was counted
    expect(asNumber).toBe(asBigint);
  });

  it("a replaced util.types.isProxy does not let a Proxy through: the check is a reference captured at load", async () => {
    const b = await honest();
    const traps: string[] = [];
    const events = new Proxy([...b.events], recordingHandler(traps));
    const holder = utilTypes as unknown as { isProxy: unknown };
    const real = holder.isProxy;
    let pending: Promise<unknown>;
    try {
      holder.isProxy = () => false;
      pending = computeKernelSignedEventsRoot({ events, bundleHash: b.bundleHash } as never);
      pending.catch(() => {}); // the refusal is already settled by now: do not let it be reported as unhandled
    } finally {
      holder.isProxy = real;
    }
    await expect(pending).rejects.toMatchObject({ name: "EvidenceBlockInputError", field: "events" });
    expect(traps, "no trap may run").toEqual([]);
  });

  it("never asks a Proxy that sits in a prototype chain anything: not the bundle's, not the events array's, not an event's", async () => {
    const b = await honest();
    const traps: string[] = [];
    const asProto = () => new Proxy({}, recordingHandler(traps));
    const events = Object.setPrototypeOf([...b.events], asProto());
    const withOwn = Object.setPrototypeOf({ events, bundleHash: b.bundleHash }, asProto());
    const withoutOwn = Object.setPrototypeOf({}, asProto()); // every property would be found only through the Proxy
    const inEvent = [Object.setPrototypeOf(structuredClone(b.events[0]!), asProto()), b.events[1]];
    for (const bundle of [withOwn, withoutOwn, { events: inEvent, bundleHash: b.bundleHash }]) {
      await computeKernelSignedEventsRoot(bundle as never).catch(() => undefined); // accepted or refused: either way, no trap
    }
    expect(traps, "no trap may run").toEqual([]);
  });

  it("judges a property by the fields its descriptor owns, so a polluted Object.prototype cannot turn an accessor into data", async () => {
    // `"value" in descriptor` is also true for a `value` inherited from Object.prototype, so an accessor
    // descriptor would be read as a data property holding the polluter's value. Found by the mutation run.
    const b = await honest();
    let runs = 0;
    const getter = (value: unknown) => ({
      enumerable: true,
      get: () => {
        runs++;
        return value;
      },
    });
    const onBundle = Object.defineProperty({ bundleHash: b.bundleHash }, "events", getter(b.events));
    const payload = Object.defineProperty({}, "z", getter(1));
    const inEvent = { events: [{ ...structuredClone(b.events[0]!), payload }, b.events[1]], bundleHash: b.bundleHash };
    const polluter = Object.prototype as unknown as Record<string, unknown>;
    const settled: Array<Promise<unknown>> = [];
    try {
      polluter.value = b.events; // a perfectly valid events array, from the wrong place
      for (const bundle of [onBundle, inEvent]) {
        const pending = computeKernelSignedEventsRoot(bundle as never); // refused in its synchronous part
        settled.push(pending.then(() => undefined, (error: unknown) => error));
      }
    } finally {
      delete polluter.value;
    }
    const [onBundleError, inEventError] = (await Promise.all(settled)) as [EvidenceBlockInputError, EvidenceBlockInputError];
    expect(onBundleError, "an accessor on the bundle").toBeInstanceOf(EvidenceBlockInputError);
    expect(onBundleError.message).toMatch(/a getter on the bundle runs code/);
    expect(inEventError, "an accessor in an event").toBeInstanceOf(EvidenceBlockInputError);
    expect(inEventError.field).toBe("events[0].payload.z");
    expect(inEventError.message).toMatch(/accessor property: its getter runs code/);
    expect(runs, "no getter may run").toBe(0);
  });
});

// ── E7c round 2 (HIGH): every public entry point ────────────────────────────────────────────────────
// Round 1 closed the bundle. A role, a unit context, a unit ref, the six roots and the session authorization
// were still read with a [[Get]] (a getter or a Proxy ran caller code, and a polluted Object.prototype could
// supply a missing field), and the digests were computed with Buffer.from, Number, BigInt, regular expressions,
// Array.prototype.sort and Hash.prototype.update looked up at call time: code that ran while an entry point was
// reading could swap one of them and change a digest the producer thinks it computed. Every entry point that
// takes an object or an array now admits it first with the SAME guard as the events (assertNoCodeRunningInput),
// reads its fields from own data descriptors, and encodes and hashes with references captured at load and
// pure loops.
describe("E7c round 2 — every public entry point refuses code-running input and reads from its own descriptors", () => {
  type Holder = Record<string | number, unknown>;
  type Member = { path: string; holder: (input: any) => Holder; key: string | number };
  type Entry = {
    name: string;
    root: string;
    make: () => any;
    call: (input: any) => unknown;
    members: Member[];
    /** A member whose absence is refused: the field a polluted Object.prototype would be asked for. */
    missing: Member;
    /** Whether an unrelated own member of the object is ignored (as it always was): not for arrays, not for the session. */
    extras: boolean;
  };
  const settlementUnitId = computeSettlementUnitId(unit);
  const hashA = sha("round2-a");
  const hashB = sha("round2-b");
  const roleOf = (over: Record<string, unknown> = {}) => ({
    roleId: "inspector",
    minPositive: 1,
    total: 2,
    minScore: 50,
    attestationHashes: [hashA, hashB],
    ...over,
  });
  const rootsOf = () => ({
    unitContextDigest: sha("round2-unit-context"),
    kernelSignedEventsRoot: sha("round2-events"),
    sessionKeyAuthDigest: sha("round2-session"),
    attestationSetRoot: sha("round2-attestations"),
    workProductRoot: sha("round2-work-product"),
    programHash: sha("round2-program"),
  });
  const authOf = () => structuredClone(sessionKeyAuth) as unknown as Holder;
  const ctxOf = () => ({ ...unit, settlementUnitId, challengeNonce });
  const members = (root: string, keys: readonly string[]): Member[] => keys.map((key) => ({ path: `${root}.${key}`, holder: (input) => input, key }));
  const S = "sessionKeyAuthorization";
  const sessionMembers: Member[] = [
    ...members(S, ["sessionId", "parentAgentId", "publicKey", "issuedAt", "expiresAt", "parentSignature", "scope"]),
    { path: `${S}.scope.maxSignatures`, holder: (i) => i.scope, key: "maxSignatures" },
    { path: `${S}.scope.allowedActions`, holder: (i) => i.scope, key: "allowedActions" },
    { path: `${S}.scope.allowedActions[0]`, holder: (i) => i.scope.allowedActions, key: 0 },
    { path: `${S}.scope.contractIds[0]`, holder: (i) => i.scope.contractIds, key: 0 },
  ];
  const entries: Entry[] = [
    {
      name: "computeSettlementUnitId",
      root: "unit",
      make: () => ({ ...unit }),
      call: (input) => computeSettlementUnitId(input),
      members: members("unit", ["chainId", "escrow", "jobIdHash", "milestoneIndex", "stepId"]),
      missing: { path: "unit.chainId", holder: (i) => i, key: "chainId" },
      extras: true,
    },
    {
      name: "computeUnitContextDigest",
      root: "unitContext",
      make: ctxOf,
      call: (input) => computeUnitContextDigest(input),
      members: members("unitContext", ["chainId", "escrow", "settlementUnitId", "jobIdHash", "milestoneIndex", "stepId", "challengeNonce"]),
      missing: { path: "unitContext.challengeNonce", holder: (i) => i, key: "challengeNonce" },
      extras: true,
    },
    {
      name: "computeAttestationRoleDigest",
      root: "role",
      make: () => roleOf(),
      call: (input) => computeAttestationRoleDigest(attJob, input),
      members: [
        ...members("role", ["roleId", "minPositive", "total", "minScore", "attestationHashes"]),
        { path: "role.attestationHashes[1]", holder: (i) => i.attestationHashes, key: 1 },
      ],
      missing: { path: "role.roleId", holder: (i) => i, key: "roleId" },
      extras: true,
    },
    {
      name: "computeAttestationSetRoot",
      root: "roles",
      make: () => [roleOf(), roleOf({ roleId: "buyer" })],
      call: (input) => computeAttestationSetRoot(attJob, input),
      members: [
        { path: "roles[1]", holder: (i) => i, key: 1 },
        { path: "roles[0].roleId", holder: (i) => i[0], key: "roleId" },
        { path: "roles[1].minScore", holder: (i) => i[1], key: "minScore" },
        { path: "roles[0].attestationHashes", holder: (i) => i[0], key: "attestationHashes" },
        { path: "roles[1].attestationHashes[0]", holder: (i) => i[1].attestationHashes, key: 0 },
      ],
      missing: { path: "roles[1].minScore", holder: (i) => i[1], key: "minScore" },
      extras: false,
    },
    {
      name: "computeEvidenceBlockHash",
      root: "roots",
      make: rootsOf,
      call: (input) => computeEvidenceBlockHash(input),
      members: members("roots", ["unitContextDigest", "kernelSignedEventsRoot", "sessionKeyAuthDigest", "attestationSetRoot", "workProductRoot", "programHash"]),
      missing: { path: "roots.programHash", holder: (i) => i, key: "programHash" },
      extras: true,
    },
    {
      name: "sessionKeyAuthSnapshot",
      root: S,
      make: authOf,
      call: (input) => sessionKeyAuthSnapshot(input),
      members: sessionMembers,
      missing: { path: `${S}.sessionId`, holder: (i) => i, key: "sessionId" },
      extras: false,
    },
    {
      name: "computeSessionKeyAuthDigest",
      root: S,
      make: authOf,
      call: (input) => computeSessionKeyAuthDigest(input),
      members: sessionMembers,
      missing: { path: `${S}.sessionId`, holder: (i) => i, key: "sessionId" },
      extras: false,
    },
  ];

  for (const entry of entries) {
    describe(entry.name, () => {
      it("accepts an honest input, plain or without a prototype", () => {
        const honest = entry.call(entry.make());
        const input = entry.make();
        const bare = Array.isArray(input) ? input : Object.assign(Object.create(null), input);
        if (!Array.isArray(input) && entry.root === S) bare.scope = Object.assign(Object.create(null), bare.scope);
        expect(entry.call(bare)).toEqual(honest);
      });

      it("refuses a Proxy as the whole input, live or revoked, without running a trap", () => {
        const traps: string[] = [];
        const err = refusalOf(() => entry.call(new Proxy(entry.make(), recordingHandler(traps))));
        expect(err.field).toBe(entry.root);
        expect(err.message).toMatch(/is a Proxy/);
        const revoked = Proxy.revocable(entry.make(), {});
        revoked.revoke();
        expect(refusalOf(() => entry.call(revoked.proxy)).field).toBe(entry.root);
        expect(traps, "no trap may run").toEqual([]);
      });

      it("refuses a Proxy at every member, naming it, and runs no trap", () => {
        const traps: string[] = [];
        for (const member of entry.members) {
          const input = entry.make();
          const holder = member.holder(input);
          const value = holder[member.key];
          holder[member.key] = new Proxy(typeof value === "object" && value !== null ? value : {}, recordingHandler(traps));
          const err = refusalOf(() => entry.call(input));
          expect(err.field, member.path).toBe(member.path);
          expect(err.message, member.path).toMatch(/is a Proxy/);
        }
        expect(traps, "no trap may run").toEqual([]);
      });

      it("refuses a getter at every member, naming it, and never runs it", () => {
        let runs = 0;
        for (const member of entry.members) {
          const input = entry.make();
          const holder = member.holder(input);
          const value = holder[member.key];
          Object.defineProperty(holder, member.key, {
            enumerable: true,
            configurable: true,
            get: () => {
              runs++;
              return value;
            },
          });
          const err = refusalOf(() => entry.call(input));
          expect(err.field, member.path).toBe(member.path);
          expect(err.message, member.path).toMatch(/accessor property: its getter runs code/);
        }
        expect(runs, "no getter may run").toBe(0);
      });

      it("refuses a getter that swaps Buffer.from, Array.prototype.sort and Object.freeze: none of them is touched", () => {
        const sab = globalsSaboteur();
        try {
          for (const member of entry.members) {
            const input = entry.make();
            const holder = member.holder(input);
            const value = holder[member.key];
            Object.defineProperty(holder, member.key, {
              enumerable: true,
              configurable: true,
              get: () => {
                sab.run();
                return value;
              },
            });
            refusalOf(() => entry.call(input));
          }
          expect(sab.state.runs, "no getter may run").toBe(0);
          expect(Buffer.from).toBe(sab.realFrom);
          expect(Array.prototype.sort).toBe(sab.realSort);
          expect(Object.freeze).toBe(sab.realFreeze);
        } finally {
          sab.restore();
        }
      });

      it("never supplies a missing field from Object.prototype, as an accessor or as data", () => {
        // `chainId` and friends are found by a [[Get]] on the prototype chain: a polluted Object.prototype
        // could run a getter there, or supply a value the caller never gave. Own descriptors only.
        const input = entry.make();
        const holder = entry.missing.holder(input);
        const key = String(entry.missing.key);
        const value = holder[key];
        delete holder[key];
        let runs = 0;
        const polluter = Object.prototype as unknown as Record<string, unknown>;
        let viaAccessor: ReturnType<typeof settle>;
        let viaData: ReturnType<typeof settle>;
        try {
          Object.defineProperty(Object.prototype, key, {
            configurable: true,
            get: () => {
              runs++;
              return value;
            },
          });
          viaAccessor = settle(() => entry.call(input));
        } finally {
          delete polluter[key];
        }
        try {
          Object.defineProperty(Object.prototype, key, { configurable: true, writable: true, value });
          viaData = settle(() => entry.call(input));
        } finally {
          delete polluter[key];
        }
        expect(viaAccessor.error, "an inherited accessor").toBeInstanceOf(EvidenceBlockInputError);
        expect(viaData.error, "an inherited value").toBeInstanceOf(EvidenceBlockInputError);
        expect(runs, "an inherited getter must not run").toBe(0);
      });

      if (!entry.extras) return;

      it("ignores an unrelated own member as it always did, but refuses a Proxy or a getter there too", () => {
        const base = entry.call(entry.make());
        expect(entry.call({ ...entry.make(), extra: { anything: [1, 2, 3] } })).toEqual(base);
        const traps: string[] = [];
        const viaProxy = refusalOf(() => entry.call({ ...entry.make(), extra: new Proxy({}, recordingHandler(traps)) }));
        expect(viaProxy.field).toBe(`${entry.root}.extra`);
        let runs = 0;
        const withGetter = Object.defineProperty(entry.make(), "extra", {
          enumerable: true,
          get: () => {
            runs++;
            return 1;
          },
        });
        expect(refusalOf(() => entry.call(withGetter)).field).toBe(`${entry.root}.extra`);
        expect(traps, "no trap may run").toEqual([]);
        expect(runs, "no getter may run").toBe(0);
      });
    });
  }

  it("refuses an object that is not plain, before reading any of it: a class instance, a Map, a Proxy prototype", () => {
    class Klass {}
    for (const entry of entries) {
      const input = entry.make();
      const traps: string[] = [];
      if (Array.isArray(input)) {
        // The roles array is plain; a role in it is not.
        const err = refusalOf(() => entry.call([Object.assign(new Klass(), input[0]), input[1]]));
        expect(err.field, entry.name).toBe("roles[0]");
        expect(err.message, entry.name).toMatch(/non-plain object/);
        continue;
      }
      const err = refusalOf(() => entry.call(Object.assign(new Klass(), input)));
      expect(err.field, entry.name).toBe(entry.root);
      expect(err.message, entry.name).toMatch(/non-plain object/);
      expect(refusalOf(() => entry.call(Object.assign(new Map(), input))).field, entry.name).toBe(entry.root);
      const hostile = Object.setPrototypeOf(entry.make(), new Proxy({}, recordingHandler(traps)));
      expect(refusalOf(() => entry.call(hostile)).field, entry.name).toBe(entry.root);
      expect(traps, `${entry.name}: no trap may run`).toEqual([]);
    }
  });

  it("refuses an input that is not an object with a typed error, naming the entry point's input", () => {
    for (const bad of [null, undefined, 7, "x"]) {
      expect(refusalOf(() => computeSettlementUnitId(bad as never)).field, String(bad)).toBe("unit");
      expect(refusalOf(() => computeUnitContextDigest(bad as never)).field, String(bad)).toBe("unitContext");
      expect(refusalOf(() => computeEvidenceBlockHash(bad as never)).field, String(bad)).toBe("roots");
      expect(refusalOf(() => computeAttestationRoleDigest(attJob, bad as never)).field, String(bad)).toBe("role");
      expect(refusalOf(() => computeAttestationSetRoot(attJob, bad as never)).field, String(bad)).toBe("roles");
      expect(refusalOf(() => sessionKeyAuthSnapshot(bad as never)).field, String(bad)).toBe(S);
    }
  });

  it("derives every digest without a global or a prototype method the caller can replace", () => {
    // Everything between a validated value and a digest is a pure loop, a captured function or an operator.
    // While Buffer, Array, Set, Map, RegExp, String, Object, Reflect, JSON, Function.prototype and Hash
    // methods all THROW when called, and Number and BigInt cannot be called, every digest is unchanged.
    // (@noble/hashes calls Number.isSafeInteger and typed-array methods itself, inside keccak: not replaced.)
    const unitInput = { ...unit };
    const ctxInput = ctxOf();
    const roleInput = roleOf();
    const rolesInput = [roleOf(), roleOf({ roleId: "buyer" })];
    const rootsInput = rootsOf();
    const authA = authOf();
    const authB = authOf();
    const taggedInput = `sha256:${"ab".repeat(32)}`; // built here: String.prototype.repeat is replaced inside the window
    const computeAll = () => ({
      unitId: computeSettlementUnitId(unitInput),
      context: computeUnitContextDigest(ctxInput),
      role: computeAttestationRoleDigest(attJob, roleInput),
      set: computeAttestationSetRoot(attJob, rolesInput),
      block: computeEvidenceBlockHash(rootsInput),
      sessionDigest: computeSessionKeyAuthDigest(authA as never),
      sessionSnapshot: sessionKeyAuthSnapshot(authB as never).digest,
      tagged: taggedDigestToBytes32(taggedInput),
    });
    const honest = computeAll();
    const hashPrototype = Object.getPrototypeOf(createHash("sha256")) as object;
    const named = (label: string, object: object, keys: readonly PropertyKey[]): Array<[string, object, PropertyKey]> =>
      keys.map((key) => [`${label}.${String(key)}`, object, key]);
    const targets: Array<[string, object, PropertyKey]> = [
      ...named("Buffer", Buffer, ["from", "alloc", "concat"]),
      ...named("Buffer.prototype", Buffer.prototype, ["toString", "slice", "write"]),
      ...named("Uint8Array", Uint8Array, ["from", "of"]),
      ...named("Array.prototype", Array.prototype, [
        "sort", "map", "forEach", "push", "pop", "shift", "unshift", "slice", "splice", "concat", "includes", "indexOf",
        "join", "filter", "reduce", "every", "some", "fill", "reverse", "flat", "at", "keys", "entries", "values", Symbol.iterator,
      ]),
      ...named("Set.prototype", Set.prototype, ["has", "add", "delete", "forEach", "values", "keys", "entries"]),
      ...named("Map.prototype", Map.prototype, ["get", "set", "has", "delete", "forEach"]),
      ...named("RegExp.prototype", RegExp.prototype, ["exec", "test"]),
      ...named("String.prototype", String.prototype, [
        "slice", "charCodeAt", "charAt", "codePointAt", "substring", "substr", "indexOf", "lastIndexOf", "startsWith", "endsWith",
        "includes", "split", "replace", "replaceAll", "match", "padStart", "padEnd", "toLowerCase", "toUpperCase", "trim", "concat",
        "repeat", "at", "localeCompare", "normalize",
      ]),
      ...named("Object", Object, ["is", "keys", "values", "entries", "assign", "fromEntries", "getOwnPropertyNames", "getOwnPropertyDescriptor", "getPrototypeOf", "defineProperty", "freeze", "create"]),
      ...named("Reflect", Reflect, ["ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf", "defineProperty", "get", "has", "apply"]),
      ...named("JSON", JSON, ["stringify", "parse"]),
      ...named("Function.prototype", Function.prototype, ["call", "apply", "bind"]),
      ...named("Hash.prototype", hashPrototype, ["update", "digest", "copy"]),
      ...named("TextEncoder.prototype", TextEncoder.prototype, ["encode"]),
    ];
    const reals = targets.map(([, object, key]) => (object as Record<PropertyKey, unknown>)[key]);
    const globalHolder = globalThis as unknown as Record<string, unknown>;
    const realNumber = globalHolder.Number;
    const realBigInt = globalHolder.BigInt;
    const refuseCall = (label: string) => ({
      apply() {
        throw new Error(`${label} was called`);
      },
    });
    let hostile: ReturnType<typeof computeAll> | undefined;
    let failure: unknown;
    try {
      // Plain indexed loops only: while Array.prototype is replaced, even destructuring and push would throw.
      for (let i = 0; i < targets.length; i++) {
        const label = targets[i]![0];
        (targets[i]![1] as Record<PropertyKey, unknown>)[targets[i]![2]] = () => {
          throw new Error(`${label} was called`);
        };
      }
      globalHolder.Number = new Proxy(realNumber as object, refuseCall("Number"));
      globalHolder.BigInt = new Proxy(realBigInt as object, refuseCall("BigInt"));
      hostile = computeAll();
    } catch (error) {
      failure = error;
    } finally {
      for (let i = 0; i < targets.length; i++) (targets[i]![1] as Record<PropertyKey, unknown>)[targets[i]![2]] = reals[i];
      globalHolder.Number = realNumber;
      globalHolder.BigInt = realBigInt;
    }
    expect(failure, "an entry point looked something up at call time").toBeUndefined();
    expect(hostile).toEqual(honest);
  });

  it("judges every spelling exactly as the regular expressions it replaced did", () => {
    // The checks are char-code loops now, not regular expressions (a RegExp.prototype.exec that was replaced
    // would change what they accept). Compared against the original expressions over strings that differ
    // from a valid one in one position, in length, or in character class.
    const originals = {
      bytes32: /^0x[0-9a-f]{64}$/,
      address: /^0x[0-9a-f]{40}$/,
      decimal: /^(0|[1-9][0-9]*)$/,
      token: /^[\x21-\x7E]{1,128}$/,
      sessionKey: /^[0-9a-f]{64}$/,
      tagged: /^sha256:[0-9a-f]{64}$/,
    };
    const alphabet = ["0", "1", "9", "a", "f", "A", "F", "g", "G", "x", "X", " ", "\n", "\t", "\0", "\x7f", "!", "~", "-", "+", ".", "é", "٣", "０", "z", "\u{1F600}"];
    let state = 987654321;
    const next = (n: number) => (state = (state * 1103515245 + 12345) & 0x7fffffff) % n;
    const mutate = (valid: string): string => {
      const chars = Array.from(valid);
      const kind = next(4);
      if (kind === 0 && chars.length > 0) chars.splice(next(chars.length), 1);
      else if (kind === 1) chars.splice(next(chars.length + 1), 0, alphabet[next(alphabet.length)]!);
      else if (kind >= 2 && chars.length > 0) chars[next(chars.length)] = alphabet[next(alphabet.length)]!;
      return chars.join("");
    };
    const accepts = (call: () => unknown, field: string): boolean => {
      const outcome = settle(call);
      if (outcome.error === undefined) return true;
      expect(outcome.error).toBeInstanceOf(EvidenceBlockInputError);
      expect((outcome.error as EvidenceBlockInputError).field).toBe(field);
      return false;
    };
    const cases: Array<{ name: string; valid: string; regex: RegExp; check: (text: string) => boolean }> = [
      { name: "bytes32", valid: `0x${"ab".repeat(32)}`, regex: originals.bytes32, check: (t) => accepts(() => computeEvidenceBlockHash({ ...rootsOf(), programHash: t }), "programHash") },
      { name: "address", valid: `0x${"cd".repeat(20)}`, regex: originals.address, check: (t) => accepts(() => computeSettlementUnitId({ ...unit, escrow: t }), "escrow") },
      { name: "decimal", valid: "12345", regex: originals.decimal, check: (t) => accepts(() => computeSettlementUnitId({ ...unit, chainId: t }), "chainId") },
      { name: "token", valid: "role-1", regex: originals.token, check: (t) => accepts(() => computeAttestationRoleDigest(attJob, roleOf({ roleId: t })), "role.roleId") },
      { name: "job token", valid: "job-1", regex: originals.token, check: (t) => accepts(() => computeAttestationRoleDigest(t, roleOf()), "job") },
      { name: "session public key", valid: "ab".repeat(32), regex: originals.sessionKey, check: (t) => accepts(() => computeSessionKeyAuthDigest({ ...authOf(), publicKey: t } as never), `${S}.publicKey`) },
      { name: "tagged digest", valid: `sha256:${"ef".repeat(32)}`, regex: originals.tagged, check: (t) => accepts(() => taggedDigestToBytes32(t), "kernelSignedEventsRoot") },
    ];
    for (const { name, valid, regex, check } of cases) {
      expect(check(valid), `${name}: the valid spelling`).toBe(true);
      for (let i = 0; i < 400; i++) {
        const text = mutate(valid);
        expect(check(text), `${name}: ${JSON.stringify(text)}`).toBe(regex.test(text));
      }
    }
    // The edges a regular expression gets from `$` and from the code unit it reads.
    expect(check_(`0x${"ab".repeat(32)}\n`)).toBe(false);
    function check_(text: string): boolean {
      return accepts(() => computeEvidenceBlockHash({ ...rootsOf(), programHash: text }), "programHash");
    }
    for (const decimal of ["0", "7", "18446744073709551615"]) {
      expect(accepts(() => computeSettlementUnitId({ ...unit, chainId: decimal }), "chainId"), decimal).toBe(true);
    }
    for (const decimal of ["", "00", "01", "-1", "+1", "1.0", "1e3", " 1", "1 ", "0x10", "1_0", "٣"]) {
      expect(accepts(() => computeSettlementUnitId({ ...unit, chainId: decimal }), "chainId"), JSON.stringify(decimal)).toBe(false);
    }
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
    for (const bad of [undefined, null, H1]) {
      const err = refuseSet([okRole({ attestationHashes: bad })]);
      expect(err.field, String(bad)).toBe("roles[0].attestationHashes");
      expect(err.message, String(bad)).toMatch(/expected an array/);
    }
    // Round 2 (E7c): a Set is not plain data, so the guard every entry point runs first refuses it, before the type check.
    const asSet = refuseSet([okRole({ attestationHashes: new Set([H1]) })]);
    expect(asSet.field).toBe("roles[0].attestationHashes");
    expect(asSet.message).toMatch(/non-plain object/);
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
// Round 2 (E7c): a role used to be read once through a [[Get]], so a getter or a Proxy ran caller code
// and its FIRST answer was committed. That code runs before anything is digested and can swap
// Buffer.from, Array.prototype.sort or Object.freeze, so what was digested was no longer what the producer
// supplied. Every entry point now admits its input first (assertNoCodeRunningInput) and reads fields from
// own data descriptors: the tests that pinned "read exactly once, first answer committed" expect REFUSAL.
describe("E7 F3 — roles are admitted and read from their own descriptors, and the session authorization is a frozen snapshot", () => {
  const H1 = sha("f3-attestation-1");
  const H2 = sha("f3-attestation-2");
  const plainRole = (over: Record<string, unknown> = {}) =>
    ({ roleId: "inspector", minPositive: 1, total: 2, minScore: 50, attestationHashes: [H1], ...over }) as AttestationQuorumRole;
  const digestOf = (role: AttestationQuorumRole) => computeAttestationRoleDigest(attJob, role);

  describe("attestation roles", () => {
    it("refuses a getter on any field of a role, alone or in a set, and never runs it", () => {
      let runs = 0;
      const fields: Array<[string, unknown]> = [
        ["roleId", "inspector"],
        ["minPositive", 1],
        ["total", 2],
        ["minScore", 50],
        ["attestationHashes", [H1]],
      ];
      for (const [name, value] of fields) {
        // The getter answers differently on a second read: the first answer used to be the one committed.
        let answers = 0;
        const role = Object.defineProperty({ ...plainRole() }, name, {
          enumerable: true,
          get() {
            runs++;
            return ++answers === 1 ? value : H2;
          },
        });
        const alone = refusalOf(() => digestOf(role as AttestationQuorumRole));
        expect(alone.field, name).toBe(`role.${name}`);
        expect(alone.message, name).toMatch(/accessor property: its getter runs code/);
        const inSet = refusalOf(() => computeAttestationSetRoot(attJob, [role as AttestationQuorumRole]));
        expect(inSet.field, name).toBe(`roles[0].${name}`);
      }
      expect(runs, "no getter may run").toBe(0);
    });

    it("refuses an accessor element of attestationHashes without running it", () => {
      let runs = 0;
      const hashes: string[] = [H1];
      Object.defineProperty(hashes, 0, {
        enumerable: true,
        get() {
          runs++;
          return H1;
        },
      });
      const err = refusalOf(() => digestOf(plainRole({ attestationHashes: hashes })));
      expect(err.field).toBe("role.attestationHashes[0]");
      expect(err.message).toMatch(/accessor property: its getter runs code/);
      expect(runs, "the element getter must not run").toBe(0);
    });

    it("refuses a Proxy as the roles array, as a role and as attestationHashes, without running a trap", () => {
      const traps: string[] = [];
      const proxied = <T extends object>(target: T): T => new Proxy(target, recordingHandler(traps));
      expect(refusalOf(() => computeAttestationSetRoot(attJob, proxied([plainRole(), plainRole({ roleId: "buyer" })]))).field).toBe("roles");
      expect(refusalOf(() => computeAttestationSetRoot(attJob, [plainRole(), proxied(plainRole({ roleId: "buyer" }))])).field).toBe("roles[1]");
      expect(refusalOf(() => digestOf(proxied(plainRole()))).field).toBe("role");
      const hashes = refusalOf(() => digestOf(plainRole({ attestationHashes: proxied([H1]) })));
      expect(hashes.field).toBe("role.attestationHashes");
      expect(hashes.message).toMatch(/is a Proxy/);
      expect(traps, "no trap may run").toEqual([]);
    });

    it("sorts the attestation hashes itself, in UTF-16 code-unit order, whatever order they are given in", () => {
      // No Array.prototype.sort is looked up any more: a heapsort over the copy. Compared against the engine's sort.
      const hashes = Array.from({ length: 17 }, (_, i) => sha(`f3-sort-${i}`));
      const expected = (list: string[]) => sha(canonicalize({ roleId: "inspector", minPositive: 1, total: 17, minScore: 50, job: attJob, hashes: [...list].sort() }));
      let state = 12345;
      const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff);
      for (let round = 0; round < 25; round++) {
        const shuffled = [...hashes];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = next() % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        expect(digestOf(plainRole({ total: 17, attestationHashes: shuffled })), `round ${round}`).toBe(expected(hashes));
      }
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
      auth.scope.contractIds.push("zz-added-after-hashing"); // sorts after "unit-golden": still canonical order
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
      // Round 2 (E7c): the shared guard (assertNoCodeRunningInput) refuses these before the session code reads anything.
      const accessor = /accessor property: its getter runs code/;
      const topErr = refuseAuth(withGetter(freshAuth(), "sessionId"));
      expect(topErr.field).toBe(`${P}.sessionId`);
      expect(topErr.message).toMatch(accessor);

      // An optional field must not be dropped as "absent" just because it is an accessor.
      const optionalErr = refuseAuth(withGetter(freshAuth(), "derivationPath"));
      expect(optionalErr.field).toBe(`${P}.derivationPath`);
      expect(optionalErr.message).toMatch(accessor);

      const nested = freshAuth();
      withGetter(nested.scope, "maxSignatures");
      const nestedErr = refuseAuth(nested);
      expect(nestedErr.field).toBe(`${P}.scope.maxSignatures`);
      expect(nestedErr.message).toMatch(accessor);

      const element = freshAuth();
      withGetter(element.scope.contractIds, "0");
      const elementErr = refuseAuth(element);
      expect(elementErr.field).toBe(`${P}.scope.contractIds[0]`);
      expect(elementErr.message).toMatch(accessor);

      const scopeGetter = freshAuth();
      const realScope = scopeGetter.scope;
      Object.defineProperty(scopeGetter, "scope", {
        enumerable: true,
        get() {
          reads++;
          return realScope;
        },
      });
      const scopeErr = refuseAuth(scopeGetter);
      expect(scopeErr.field).toBe(`${P}.scope`);
      expect(scopeErr.message).toMatch(accessor);
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

    // E7c, found while capturing the intrinsics: the plain-object test asked an object's PROTOTYPE for its own
    // prototype, which runs a Proxy prototype's getPrototypeOf trap (code that could swap Object.freeze before
    // the snapshot below is frozen). A Proxy prototype, and a revoked Proxy, are now refused unasked.
    it("refuses an object whose PROTOTYPE is a Proxy, and a revoked Proxy, without running a trap", () => {
      const traps: string[] = [];
      const hostile = Object.setPrototypeOf(freshAuth(), new Proxy({}, recordingHandler(traps)));
      expect(refuseAuth(hostile).field).toBe(P);
      const scope = freshAuth();
      Object.setPrototypeOf(scope.scope, new Proxy({}, recordingHandler(traps)));
      expect(refuseAuth(scope).field).toBe(`${P}.scope`);
      expect(traps, "no trap may run").toEqual([]);
      const revoked = Proxy.revocable(freshAuth(), {});
      revoked.revoke();
      expect(refuseAuth(revoked.proxy).field).toBe(P);
    });

    it("returns a deeply frozen snapshot even when the caller replaces Object.freeze: the freeze is a captured reference", () => {
      const real = Object.freeze;
      let snap: ReturnType<typeof sessionKeyAuthSnapshot>;
      try {
        (Object as unknown as { freeze: unknown }).freeze = (o: unknown) => o;
        snap = sessionKeyAuthSnapshot(freshAuth());
      } finally {
        (Object as unknown as { freeze: unknown }).freeze = real;
      }
      expect(isDeeplyFrozen(snap)).toBe(true);
      expect(snap.digest).toBe(sha(canonicalize(snap.value)));
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
        const err = refuseAuth(auth);
        expect(err.field, key).toBe(`${P}.${key}`);
        expect(err.message, key).toMatch(/is required/);
      }
      for (const key of ["allowedActions", "contractIds", "maxSignatures"]) {
        const auth = freshAuth();
        delete (auth.scope as unknown as Record<string, unknown>)[key];
        const err = refuseAuth(auth);
        expect(err.field, key).toBe(`${P}.scope.${key}`);
        expect(err.message, key).toMatch(/is required/);
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

// ── F4 (MEDIUM): one authorization, one spelling, one digest ─────────────────
describe("E7 F4 — one session authorization has exactly one accepted spelling and one digest", () => {
  const P = "sessionKeyAuthorization";
  const KEY = "aa".repeat(32);
  const SIG = "bb".repeat(64);
  const freshAuth = (): SessionKeyAuthorization => structuredClone(sessionKeyAuth);
  const refuseAuth = (auth: unknown) =>
    refusalOf(() => computeSessionKeyAuthDigest(auth as SessionKeyAuthorization));

  it("the golden spelling (bare lowercase hex) is accepted and keeps the mirror's digest", () => {
    expect(computeSessionKeyAuthDigest(freshAuth())).toBe(sha(canonicalize(sessionKeyAuth)));
  });

  it("refuses the same Ed25519 key with a 0x prefix, in uppercase or in mixed case, so it cannot get a second digest", () => {
    for (const variant of [`0x${KEY}`, `0X${KEY}`, KEY.toUpperCase(), `0x${KEY.toUpperCase()}`, `Aa${KEY.slice(2)}`]) {
      const err = refuseAuth({ ...freshAuth(), publicKey: variant });
      expect(err.field, variant).toBe(`${P}.publicKey`);
      expect(err.message, variant).toMatch(/64 lowercase hex characters with no 0x prefix/);
    }
  });

  it("refuses a publicKey of the wrong length, with non-hex characters, or padded", () => {
    for (const bad of [KEY.slice(1), `${KEY}a`, SIG, "g".repeat(64), ` ${KEY}`, `${KEY}\n`, `${KEY} `]) {
      expect(refuseAuth({ ...freshAuth(), publicKey: bad }).field, JSON.stringify(bad)).toBe(`${P}.publicKey`);
    }
  });

  it("refuses the same parentSignature with a 0x prefix, in uppercase or in mixed case", () => {
    for (const variant of [`0x${SIG}`, `0X${SIG}`, SIG.toUpperCase(), `0x${SIG.toUpperCase()}`, `Bb${SIG.slice(2)}`]) {
      const err = refuseAuth({ ...freshAuth(), parentSignature: variant });
      expect(err.field, variant).toBe(`${P}.parentSignature`);
      expect(err.message, variant).toMatch(/128 lowercase hex characters with no 0x prefix/);
    }
  });

  it("refuses a parentSignature of the wrong length, with non-hex characters, or padded", () => {
    for (const bad of [SIG.slice(1), `${SIG}b`, KEY, "z".repeat(128), ` ${SIG}`, `${SIG}\n`]) {
      expect(refuseAuth({ ...freshAuth(), parentSignature: bad }).field, JSON.stringify(bad)).toBe(`${P}.parentSignature`);
    }
  });

  it("accepts exactly the hex the in-repo producers emit (kernel-sdk and gateway `toHex` over raw bytes)", () => {
    // Same helper as packages/kernel-sdk/src/job-handler.ts:33 and gateway/src/routes/identity-session.ts:20.
    const toHex = (bytes: Uint8Array) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = Uint8Array.from({ length: 32 }, (_, i) => (i % 3 === 0 ? i : 255 - i)); // includes 0x00 and 0xff
    const sig = Uint8Array.from({ length: 64 }, (_, i) => (i * 5) % 256);
    key[0] = 0;
    sig[1] = 255;
    const auth = { ...freshAuth(), publicKey: toHex(key), parentSignature: toHex(sig) };
    expect(auth.publicKey).toMatch(/^00/);
    expect(sessionKeyAuthSnapshot(auth).value.publicKey).toBe(auth.publicKey);
    expect(computeSessionKeyAuthDigest(auth)).toBe(sha(canonicalize(auth)));
  });

  // E7 F4 scope arrays, unblocked by gateway #4670: SessionKeyService.issueSessionKey now builds
  // [...new Set(xs)].sort() before it signs, so every producer emits the canonical form and the
  // arrays are pinned by REJECTION to strictly ascending UTF-16 code-unit order. Nothing is sorted
  // or de-duplicated here: a second spelling of the same permissions would be a second digest.
  describe("scope arrays: strictly ascending in UTF-16 code-unit order, one digest per set of permissions", () => {
    const KEYS = ["allowedActions", "contractIds"] as const;
    const withScope = (key: (typeof KEYS)[number], value: string[]): SessionKeyAuthorization => {
      const auth = freshAuth();
      (auth.scope as unknown as Record<string, unknown>)[key] = value;
      return auth;
    };
    const accepts = (key: (typeof KEYS)[number], value: string[]) => {
      try {
        computeSessionKeyAuthDigest(withScope(key, value));
        return true;
      } catch (e) {
        expect(e).toBeInstanceOf(EvidenceBlockInputError);
        return false;
      }
    };

    it("refuses an unsorted array, naming the first element that breaks the order", () => {
      for (const key of KEYS) {
        const err = refuseAuth(withScope(key, ["b", "a"]));
        expect(err.field, key).toBe(`${P}.scope.${key}[1]`);
        expect(err.message, key).toMatch(/out of order/);
        expect(err.message, key).toMatch(/strictly ascending UTF-16 code-unit order/);
        expect(refuseAuth(withScope(key, ["a", "c", "b"])).field, key).toBe(`${P}.scope.${key}[2]`);
        expect(refuseAuth(withScope(key, ["c", "b", "a"])).field, key).toBe(`${P}.scope.${key}[1]`);
      }
    });

    it("refuses a duplicated array, adjacent or not", () => {
      for (const key of KEYS) {
        const adjacent = refuseAuth(withScope(key, ["a", "a", "b"]));
        expect(adjacent.field, key).toBe(`${P}.scope.${key}[1]`);
        expect(adjacent.message, key).toMatch(/duplicate/);
        expect(refuseAuth(withScope(key, ["a", "a"])).message, key).toMatch(/duplicate/);
        // A duplicate that is not adjacent is out of order as well.
        expect(refuseAuth(withScope(key, ["a", "b", "a"])).field, key).toBe(`${P}.scope.${key}[2]`);
      }
    });

    it("accepts sorted, de-duplicated arrays and commits them exactly as given", () => {
      for (const key of KEYS) {
        const sorted = ["alpha", "beta", "gamma-3"];
        const auth = withScope(key, sorted);
        expect(computeSessionKeyAuthDigest(auth), key).toBe(sha(canonicalize(auth)));
        expect(sessionKeyAuthSnapshot(auth).value.scope[key], key).toEqual(sorted);
      }
      const both = freshAuth();
      both.scope.allowedActions = ["a", "b"];
      both.scope.contractIds = ["x", "y", "z"];
      expect(computeSessionKeyAuthDigest(both)).toBe(sha(canonicalize(both)));
    });

    it("accepts an empty array, for contractIds and for allowedActions", () => {
      for (const key of KEYS) {
        const auth = withScope(key, []);
        expect(computeSessionKeyAuthDigest(auth), key).toBe(sha(canonicalize(auth)));
        expect(sessionKeyAuthSnapshot(auth).value.scope[key], key).toEqual([]);
      }
    });

    it("judges the order by UTF-16 code unit, as the default sort does: not by locale, not by code point", () => {
      for (const key of KEYS) {
        // "Z" (0x5A) sorts before "a" (0x61) by code unit; a locale collation would put "a" first.
        expect(accepts(key, ["Z", "a"]), key).toBe(true);
        expect(accepts(key, ["a", "Z"]), key).toBe(false);
        // A prefix sorts before its extensions, the empty string first, '-' (0x2D) before letters.
        expect(accepts(key, ["", "a", "a-b", "ab"]), key).toBe(true);
        expect(accepts(key, ["ab", "a-b"]), key).toBe(false);
        // An astral character is a surrogate pair (0xD83D 0xDE00): by code unit it sorts BEFORE U+FF5E,
        // by code point it would sort after. The premise is checked, then the pin.
        const astral = String.fromCodePoint(0x1f600);
        const fullwidth = String.fromCharCode(0xff5e);
        expect(astral < fullwidth).toBe(true);
        expect(accepts(key, [astral, fullwidth]), key).toBe(true);
        expect(accepts(key, [fullwidth, astral]), key).toBe(false);
      }
    });

    it("two inputs that differ only in order or in duplicates can no longer both produce a digest", () => {
      // Every array of length 3 to 5 over {a, b, c} that holds all three permissions: the same set in
      // every order and with every repetition. Exactly one is accepted: the canonical form.
      const build = (prefix: string[], length: number): string[][] =>
        prefix.length === length ? [prefix] : ["a", "b", "c"].flatMap((s) => build([...prefix, s], length));
      const candidates = [3, 4, 5].flatMap((length) => build([], length)).filter((c) => new Set(c).size === 3);
      expect(candidates).toHaveLength(6 + 36 + 150);
      for (const key of KEYS) {
        expect(candidates.filter((c) => accepts(key, c)), key).toEqual([["a", "b", "c"]]);
      }
    });
  });
});

// ── F5 (LOW): negative zero ──────────────────────────────────────────────────
describe("E7 F5 — negative zero is not the pinned spelling of zero", () => {
  it("refuses -0 for chainId and for milestoneIndex, naming the field", () => {
    for (const field of ["chainId", "milestoneIndex"] as const) {
      const err = refusalOf(() => computeSettlementUnitId({ ...unit, [field]: -0 }));
      expect(err.field).toBe(field);
      expect(err.message).toMatch(/negative zero/);
    }
  });

  it("refuses -0 in the unit context as well", () => {
    const settlementUnitId = computeSettlementUnitId(unit);
    const err = refusalOf(() => computeUnitContextDigest({ ...unit, chainId: -0, settlementUnitId, challengeNonce }));
    expect(err.field).toBe("chainId");
    expect(err.message).toMatch(/negative zero/);
  });

  it("zero itself is still accepted in every pinned spelling and gives one word", () => {
    const zero = computeSettlementUnitId({ ...unit, milestoneIndex: 0 });
    expect(computeSettlementUnitId({ ...unit, milestoneIndex: 0n })).toBe(zero);
    expect(computeSettlementUnitId({ ...unit, milestoneIndex: "0" })).toBe(zero);
    expect(zero).not.toBe(computeSettlementUnitId({ ...unit, milestoneIndex: 1 }));
  });

  it("the string '-0' is refused as before", () => {
    expect(refusalOf(() => computeSettlementUnitId({ ...unit, milestoneIndex: "-0" })).field).toBe("milestoneIndex");
  });
});

// ── F3 extension, NOT in the verdict: the unit context ──────────────────────
// computeUnitContextDigest read each field to check the settlementUnitId derivation and
// again to hash it, so a getter could pass the check and be committed with other values. It then read
// each field once and committed the first answer. Round 2 (E7c): a getter is caller code, so it is refused
// unread, like every code-running input at every entry point.
describe("E7 F3 extension — the unit context is admitted and read from its own descriptors", () => {
  const FIELDS = ["chainId", "escrow", "settlementUnitId", "jobIdHash", "milestoneIndex", "stepId", "challengeNonce"] as const;

  it("refuses a getter on any field, even one that answers consistently, and never runs it", () => {
    const settlementUnitId = computeSettlementUnitId(unit);
    const plain: Record<string, unknown> = { ...unit, settlementUnitId, challengeNonce };
    let runs = 0;
    for (const field of FIELDS) {
      const ctx = Object.defineProperty({ ...plain }, field, {
        enumerable: true,
        get() {
          runs++;
          return plain[field];
        },
      });
      const err = refusalOf(() => computeUnitContextDigest(ctx as never));
      expect(err.field, field).toBe(`unitContext.${field}`);
      expect(err.message, field).toMatch(/accessor property: its getter runs code/);
    }
    expect(runs, "no getter may run").toBe(0);
    expect(computeUnitContextDigest(plain as never)).toBe(computeUnitContextDigest({ ...plain } as never));
  });

  it("still refuses an incoherent context and a non-object", () => {
    const settlementUnitId = computeSettlementUnitId(unit);
    expect(refusalOf(() => computeUnitContextDigest({ ...unit, milestoneIndex: 2n, settlementUnitId, challengeNonce })).field).toBe(
      "settlementUnitId",
    );
    for (const bad of [null, undefined, 7, "ctx"]) {
      expect(refusalOf(() => computeUnitContextDigest(bad as never)).field, String(bad)).toBe("unitContext");
    }
  });
});

// ── Found by the mutation run: an array whose `length` is not a safe integer ──
// A Proxy over an array passes Array.isArray, and `NaN < 1` is false, so a `count < 1`
// check alone would treat such an array as non-empty, loop zero times and accept an
// EMPTY bundle, role set or hash list. The explicit safe-integer check closes that.
// (E7c: the bundle's events array, and since round 2 the role set and the attestation hashes, are
// refused as a Proxy before their length is asked, so the three cases below hold by that refusal;
// the length checks stay as a second line.)
describe("E7 — an array with a non-integer length is refused, never treated as empty", () => {
  const lying = <T>(items: T[], length: unknown) =>
    new Proxy(items, { get: (target, key, receiver) => (key === "length" ? length : Reflect.get(target, key, receiver)) });
  const ODD_LENGTHS = [NaN, -1, 1.5, "2", undefined, Infinity];
  const H = sha("odd-length-attestation");

  it("bundle events", async () => {
    const emptyHash = await hashBundle([]);
    for (const length of ODD_LENGTHS) {
      const err = await refusalOfAsync(() =>
        computeKernelSignedEventsRoot({ events: lying([], length) as never, bundleHash: emptyHash }),
      );
      expect(err.field, String(length)).toBe("events");
    }
  });

  it("attestation roles", () => {
    const role = { roleId: "inspector", minPositive: 1, total: 2, minScore: 50, attestationHashes: [H] };
    for (const length of ODD_LENGTHS) {
      const err = refusalOf(() => computeAttestationSetRoot(attJob, lying([role], length) as never));
      expect(err.field, String(length)).toBe("roles");
    }
  });

  it("attestation hashes", () => {
    for (const length of ODD_LENGTHS) {
      const role = { roleId: "inspector", minPositive: 1, total: 2, minScore: 50, attestationHashes: lying([H], length) };
      const err = refusalOf(() => computeAttestationSetRoot(attJob, [role as never]));
      expect(err.field, String(length)).toBe("roles[0].attestationHashes");
    }
  });
});
