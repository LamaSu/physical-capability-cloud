/**
 * N79 round 8 (astra pack 126i, verdict DO-NOT-SHIP on 4b24042b).
 *
 * PHASE 1: one test per finding, under "N79 round 8: Phase 1". Each asserts the CORRECT behaviour, so each fails
 * at 4b24042b on the finding's own assertion:
 *
 *   R8-H1a: `sessionKeyAuthorization` is never compared on re-delivery -- a different (or missing) authorization
 *           on an otherwise-identical re-delivery is wrongly accepted as exact, and can reach the chain.
 *   R8-H1b: `sessionKeyAuthorization` is never persisted on a fresh delivery.
 *   R8-H1c: `tenantId` is never backfilled from the authoritative job on a fresh delivery, and never compared on
 *           re-delivery.
 *   R8-M1a: a job-owned V2 escrow row whose `version` column is NULL is misread as V1 by
 *           `verifyDerivedMilestoneOnChain` -- a legitimate V2 producer is refused `evidence_milestone_unbound`.
 *   R8-M1b: the versionless env default is treated as "always v1" -- a producer using
 *           `autoReleaseContractAddress`'s rowless fallback with no `ESCROW_CONTRACT_VERSION` configured gets
 *           `evidence_milestone_unbound` with nothing persisted, instead of a persisted, chain-silent result.
 *   R8-M2:  `recordChainSettlement` never validates individual status VALUES against the version's domain -- an
 *           out-of-domain `releasedStatus` (and matching `statuses`) is treated as a real release.
 *
 * PHASE 2 property tests (P2/P3/P4) follow under "N79 round 8: Phase 2 properties", added once the fix lands —
 * they import `getTableColumns` (added to `@pcc/store` by the fix), so they cannot be declared before Phase 2.
 *
 * The real in-memory store throughout. Only the chain (`../contracts/escrow-client.js`) and evidence storage
 * (`@pcc/kernel/evidence-storage-factory`) are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAddress, keccak256, toBytes, type Hex } from "viem";
import type { EvidenceBundle, SessionKeyAuthorization } from "@pcc/spec";

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_r8", metadataCid: "bafymeta_n79_r8" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc", metadataCid: "bafyencmeta" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../contracts/escrow-client.js")>();
  return {
    ...actual,
    isWriteEnabled: vi.fn(() => false),
    submitEvidence: vi.fn(),
    releaseMilestone: vi.fn(), // N79 round 8, lead review iteration 2, item 4 (releaseMilestone tests)
    getEscrowState: vi.fn(), // V1
    getEscrowStateV2: vi.fn(), // V2
  };
});

import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema, eq, getTableColumns } from "@pcc/store";
import { beginSettlement, endSettlement, recordChainSettlement, type SettlementClaim } from "../services/escrow-refund.js";
import { getSettlementService, resetSettlementService } from "../services/settlement-service.js";
import * as chain from "../contracts/escrow-client.js";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const HASH_A = `sha256:${"a1".repeat(32)}`;

let seq = 0;

/** A job row with NO negotiation session and so NO escrow (`escrowForJob` returns undefined). */
function seedBareJob(): { jobId: string; stepId: string; kernelId: string } {
  const repos = getRepos();
  const n = ++seq;
  const jobId = `job-r8-bare-${n}`;
  const stepId = `step-r8-bare-${n}`;
  const capability = repos.capabilities.findAll()[0]!;
  repos.jobs.insert({
    id: jobId,
    stepId,
    cwmId: `cwm-r8-bare-${n}`,
    capabilityId: capability.id,
    kernelId: capability.kernelId,
    status: "in_progress",
    assignedDevices: [],
  });
  return { jobId, stepId, kernelId: capability.kernelId };
}

/** A job + negotiation session + escrow (+ milestones matching the `step-${i+1}` convention other N79 suites
 *  use), the way the settlement read links them (mirrors r3/r4/r5/r6/r7's `seed()`, `r8`-prefixed so fixtures
 *  never collide across suites). `version` defaults to "v2"; pass `null` for R8-M1a's null-version row, or any
 *  other string for the P2-version "garbage" case. `milestones` defaults to one row ("funded"). */
function seed(opts: { version?: string | null; milestones?: string[] } = {}) {
  const repos = getRepos();
  const n = ++seq;
  const jobId = `job-r8-${n}`;
  const cwmId = `cwm-r8-${n}`;
  const capability = repos.capabilities.findAll()[0]!;
  const now = new Date().toISOString();
  const address = addr(0xd8000 + n);
  repos.jobs.insert({
    id: jobId,
    stepId: "step-1",
    cwmId,
    capabilityId: capability.id,
    kernelId: capability.kernelId,
    status: "in_progress",
    assignedDevices: [],
  });
  getStore()
    .db.insert(schema.negotiationSessions)
    .values({
      id: `sess-r8-${n}`,
      status: "committed",
      userAgentId: "user-r8",
      kernelId: capability.kernelId,
      capabilityType: capability.type,
      operatorConstraints: {},
      jobId,
      cwmId,
      createdAt: now,
      expiresAt: now,
    })
    .run();
  const escrowId = `esc-r8-${n}`;
  repos.escrows.insert({
    id: escrowId,
    cwmId,
    contractAddress: address,
    payer: "0x0000000000000000000000000000000000000001",
    totalAmount: "10.00",
    currency: "USDC",
    status: "funded",
    createdAt: now,
    deadline: now,
    version: (opts.version === undefined ? "v2" : opts.version) as never,
  });
  (opts.milestones ?? ["funded"]).forEach((status, i) => {
    repos.escrows.insertMilestone({ id: `ms-r8-${n}-${i}`, escrowId, stepId: `step-${i + 1}`, amount: "5.00", status, bondAmount: "0" });
  });
  return { jobId, escrowId, address, cwmId };
}

/** A minimal V2-shaped chain read whose one milestone carries `stepId`'s on-chain identity, for
 *  `verifyDerivedMilestoneOnChain`'s pre-submit check. */
function v2StateFor(stepId: string, address: string) {
  return {
    address,
    payer: addr(0xaa),
    arbiter: addr(0xbb),
    token: addr(0xcc),
    cwmId: `0x${"00".repeat(32)}`,
    funded: true,
    totalAmount: "10",
    milestoneCount: 1,
    milestones: [
      {
        stepId: keccak256(toBytes(stepId)),
        operator: addr(0),
        amount: "10",
        operatorBond: "0",
        status: 1,
        statusName: "",
        evidenceBundleHash: `0x${"00".repeat(32)}`,
        verifierAttestationHash: `0x${"00".repeat(32)}`,
        challengeWindowEnd: 0,
        challengeWindowSeconds: 0,
        requiredTier: 0,
        jobIdHash: `0x${"00".repeat(32)}`,
        verifierAttestationUid: `0x${"00".repeat(32)}`,
      },
    ],
  } as never;
}

function sessionKeyAuth(id: string): SessionKeyAuthorization {
  return {
    sessionId: id,
    parentAgentId: "agent-r8-parent",
    publicKey: "ab".repeat(32),
    issuedAt: 1700000000,
    expiresAt: 1700003600,
    scope: { allowedActions: ["submit_evidence"], contractIds: ["cap-r8"], maxSignatures: 1 },
    parentSignature: "cd".repeat(64),
  };
}

function makeBundle(jobId: string, over: Partial<EvidenceBundle> = {}): EvidenceBundle {
  const job = getRepos().jobs.findById(jobId)!;
  return {
    id: "bundle-r8-A",
    jobId,
    stepId: job.stepId,
    kernelId: job.kernelId,
    assuranceTier: 0,
    bundleHash: HASH_A as `sha256:${string}`,
    kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "mock_sig_r8" },
    createdAt: new Date().toISOString(),
    events: [
      {
        id: `ev-r8-${jobId}`,
        type: "execution_started",
        // Fixed (not `new Date().toISOString()`): two independent `makeBundle()` calls for the SAME jobId must
        // produce byte-identical default events, so a re-delivery test that overrides only ONE field (e.g.
        // `sessionKeyAuthorization`) isn't ALSO accidentally an event-timestamp mismatch.
        timestamp: "2026-01-01T00:00:00.000Z",
        source: { deviceId: "dev-r8", deviceType: "controller", kernelId: job.kernelId },
        payload: { message: "Job started" },
        hash: `sha256:${"c3".repeat(32)}` as `sha256:${string}`,
      },
    ],
    ...over,
  };
}

describe("N79 round 8: Phase 1 — the review's findings, reproduced", () => {
  let savedEscrowEnv: string | undefined;
  let savedEscrowVerEnv: string | undefined;

  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    resetSettlementService();
    savedEscrowEnv = process.env.ESCROW_CONTRACT_ADDRESS;
    savedEscrowVerEnv = process.env.ESCROW_CONTRACT_VERSION;
    delete process.env.ESCROW_CONTRACT_ADDRESS;
    delete process.env.ESCROW_CONTRACT_VERSION;
    vi.mocked(chain.isWriteEnabled).mockReset().mockReturnValue(false);
    vi.mocked(chain.submitEvidence).mockReset();
    vi.mocked(chain.getEscrowState).mockReset();
    vi.mocked(chain.getEscrowStateV2).mockReset();
  });

  afterEach(() => {
    closeStore();
    resetSettlementService();
    if (savedEscrowEnv === undefined) delete process.env.ESCROW_CONTRACT_ADDRESS;
    else process.env.ESCROW_CONTRACT_ADDRESS = savedEscrowEnv;
    if (savedEscrowVerEnv === undefined) delete process.env.ESCROW_CONTRACT_VERSION;
    else process.env.ESCROW_CONTRACT_VERSION = savedEscrowVerEnv;
  });

  it("R8-H1a (different authorization): a re-delivery with a DIFFERENT sessionKeyAuthorization must conflict, never read as exact", async () => {
    const { jobId, address } = seed();
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr8h1a-diff", status: "submitted" } as never);
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(v2StateFor("step-1", address));

    const bundleId = "bundle-r8-h1a-diff";
    const pinnedCreatedAt = "2026-01-01T00:00:00.000Z";
    const first = makeBundle(jobId, { id: bundleId, createdAt: pinnedCreatedAt, sessionKeyAuthorization: sessionKeyAuth("sess-A") });
    const firstResult = await getSettlementService().processEvidence(first, jobId, { contractAddress: address, milestoneIndex: 0 });
    expect(firstResult.error, "R8-H1a (different) setup").toBeUndefined();
    expect(chain.submitEvidence, "R8-H1a (different) setup chain write").toHaveBeenCalledTimes(1);

    vi.mocked(chain.submitEvidence).mockClear();
    const redelivered = makeBundle(jobId, { id: bundleId, createdAt: pinnedCreatedAt, sessionKeyAuthorization: sessionKeyAuth("sess-B") });
    const result = await getSettlementService().processEvidence(redelivered, jobId, { contractAddress: address, milestoneIndex: 0 });

    expect(result.error, "R8-H1a (different authorization)").toBe("evidence_bundle_conflict");
    expect(chain.submitEvidence, "R8-H1a (different authorization) no chain write").not.toHaveBeenCalled();
    expect(getRepos().jobs.findById(jobId)?.evidenceBundleId, "R8-H1a (different authorization) job pointer unchanged").toBe(bundleId);
  });

  it("R8-H1a (missing authorization): a re-delivery with NO sessionKeyAuthorization must conflict, never read as exact", async () => {
    const { jobId, address } = seed();
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr8h1a-none", status: "submitted" } as never);
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(v2StateFor("step-1", address));

    const bundleId = "bundle-r8-h1a-none";
    const pinnedCreatedAt = "2026-01-01T00:00:00.000Z";
    const first = makeBundle(jobId, { id: bundleId, createdAt: pinnedCreatedAt, sessionKeyAuthorization: sessionKeyAuth("sess-C") });
    const firstResult = await getSettlementService().processEvidence(first, jobId, { contractAddress: address, milestoneIndex: 0 });
    expect(firstResult.error, "R8-H1a (missing) setup").toBeUndefined();

    vi.mocked(chain.submitEvidence).mockClear();
    const redelivered = makeBundle(jobId, { id: bundleId, createdAt: pinnedCreatedAt, sessionKeyAuthorization: undefined });
    const result = await getSettlementService().processEvidence(redelivered, jobId, { contractAddress: address, milestoneIndex: 0 });

    expect(result.error, "R8-H1a (missing authorization)").toBe("evidence_bundle_conflict");
    expect(chain.submitEvidence, "R8-H1a (missing authorization) no chain write").not.toHaveBeenCalled();
    expect(getRepos().jobs.findById(jobId)?.evidenceBundleId, "R8-H1a (missing authorization) job pointer unchanged").toBe(bundleId);
  });

  it("R8-H1b (delegation not persisted): a fresh delivery's stored row must deep-equal the bundle's sessionKeyAuthorization", async () => {
    const { jobId } = seedBareJob();
    const auth = sessionKeyAuth("sess-fresh-A");
    const bundle = makeBundle(jobId, { id: "bundle-r8-h1b", sessionKeyAuthorization: auth });

    const result = await getSettlementService().processEvidence(bundle, jobId);

    expect(result.error, "R8-H1b").toBeUndefined();
    const stored = getRepos().evidence.findById("bundle-r8-h1b");
    expect(stored?.sessionKeyAuthorization, "R8-H1b stored sessionKeyAuthorization").toEqual(auth);
  });

  it("R8-H1c (i): a fresh delivery's stored tenantId comes from the authoritative job, never the bundle", async () => {
    const { jobId } = seedBareJob();
    getRepos().jobs.update(jobId, { tenantId: "tenant-job" });
    const bundle = makeBundle(jobId, { id: "bundle-r8-h1c-i" });

    const result = await getSettlementService().processEvidence(bundle, jobId);

    expect(result.error, "R8-H1c (i)").toBeUndefined();
    const stored = getRepos().evidence.findById("bundle-r8-h1c-i");
    expect(stored?.tenantId, "R8-H1c (i) stored tenantId").toBe("tenant-job");
  });

  it("R8-H1c (ii): a stored row whose tenantId differs from the authoritative job's must conflict on re-delivery", async () => {
    const { jobId } = seedBareJob();
    getRepos().jobs.update(jobId, { tenantId: "tenant-job" });
    const pinnedCreatedAt = "2026-01-01T00:00:00.000Z";
    const bundle = makeBundle(jobId, { id: "bundle-r8-h1c-ii", createdAt: pinnedCreatedAt });
    // A stored row identical to what a fresh delivery of THIS bundle computes today (4b24042b never writes
    // tenantId at all) -- except tenantId, set here to simulate a row backfilled against a DIFFERENT tenant.
    getRepos().evidence.insert({
      id: bundle.id,
      jobId: bundle.jobId,
      stepId: bundle.stepId,
      kernelId: bundle.kernelId,
      assuranceTier: bundle.assuranceTier,
      bundleHash: bundle.bundleHash,
      kernelSignature: bundle.kernelSignature,
      createdAt: bundle.createdAt,
      tenantId: "tenant-other",
    });
    getRepos().evidence.insertEvents(
      bundle.events.map((ev) => ({
        id: ev.id,
        bundleId: bundle.id,
        type: ev.type,
        timestamp: ev.timestamp,
        source: ev.source,
        payload: ev.payload as Record<string, unknown>,
        hash: ev.hash,
      })),
    );

    vi.mocked(chain.submitEvidence).mockClear();
    const result = await getSettlementService().processEvidence(bundle, jobId);

    expect(result.error, "R8-H1c (ii)").toBe("evidence_bundle_conflict");
    expect(chain.submitEvidence, "R8-H1c (ii) no chain write").not.toHaveBeenCalled();
  });

  it("R8-M1a (null-version V2 row): a job-owned escrow row with version=NULL must still be read through V2, not V1", async () => {
    const { jobId, address } = seed({ version: null });
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr8m1a", status: "submitted" } as never);
    vi.mocked(chain.getEscrowState).mockRejectedValue(new Error("R8-M1a: V1 ABI must never be read for this row")); // V1 throws
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(v2StateFor("step-1", address)); // V2 succeeds

    const bundle = makeBundle(jobId, { id: "bundle-r8-m1a" });
    const result = await getSettlementService().processEvidence(bundle, jobId, { contractAddress: address });

    expect(result.error, "R8-M1a").toBeUndefined();
    expect(chain.submitEvidence, "R8-M1a submitted once").toHaveBeenCalledTimes(1);
    expect(vi.mocked(chain.submitEvidence).mock.calls[0]![0], "R8-M1a at the derived index").toBe(0);
  });

  // N79 round 8, lead review iteration 2, item 2: `verifyDerivedMilestoneOnChain` treated the LITERAL string
  // "v1" as the rowless sentinel regardless of where it came from. A row can hold a raw `version` column of
  // "v1" (not through the rowless resolver -- a value resolveEscrowRowVersion maps to UNKNOWN, since it is
  // not null/undefined/"v2"/"v3"), and the row path passed that raw value straight through
  // (`derivedMilestoneEscrowVersion = jobOwnEscrow.version`). The verifier's `escrowVersion === "v1"` check
  // then wrongly matched it and dispatched to V1, instead of refusing.
  it("R8-R2a (raw row version 'v1' must not reach the rowless sentinel): a job-owned row literally holding version='v1' must refuse, never read through V1", async () => {
    const { jobId, address } = seed({ version: "v1" }); // a ROW, not the rowless (no-row) path
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr8r2a", status: "submitted" } as never);
    // V1 WOULD return a matching step if (wrongly) dispatched here -- the bug's exact reproduction.
    vi.mocked(chain.getEscrowState).mockResolvedValue({ milestones: [{ stepId: keccak256(toBytes("step-1")) }] } as never);
    vi.mocked(chain.getEscrowStateV2).mockRejectedValue(new Error("R8-R2a: V2 must never be read for a row holding version='v1'"));

    const bundle = makeBundle(jobId, { id: "bundle-r8-r2a" });
    const result = await getSettlementService().processEvidence(bundle, jobId, { contractAddress: address });

    expect(result.error, "R8-R2a").toBe("evidence_milestone_unbound"); // correct: refuse, not submit
    expect(chain.submitEvidence, "R8-R2a no chain write").not.toHaveBeenCalled();
  });

  // N79 round 8, lead review iteration 2, item 4 (the same P2 property as R8-R2a/the escrow-target checks
  // above, at a sibling call site): `releaseMilestone`'s rowless fallback only fills in `contractAddress` when
  // the caller supplied NONE (`if (!contractAddress) { contractAddress = ... }`) -- a rowless job's CALLER-
  // SUPPLIED address was never compared against anything, so an unrelated escrow's address (belonging to a
  // completely different job) sailed through `givenBackEscrow`/`beginSettlement` and leased/acted on THAT
  // escrow.
  it("R8-R4a (releaseMilestone rowless target): a rowless job with an UNRELATED escrow's address must refuse, never lease or call the chain", async () => {
    const savedAddr = process.env.ESCROW_CONTRACT_ADDRESS;
    const savedVer = process.env.ESCROW_CONTRACT_VERSION;
    delete process.env.ESCROW_CONTRACT_ADDRESS; // no configured rowless default at all
    delete process.env.ESCROW_CONTRACT_VERSION;
    try {
      vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
      const { address: unrelatedAddress } = seed({ status: "funded" }); // a REAL escrow -- a DIFFERENT job's own
      const { jobId: rowlessJobId } = seedBareJob(); // the job under test: no escrow row of its own

      const result = await getSettlementService().releaseMilestone(
        rowlessJobId,
        0,
        { escrowAddress: unrelatedAddress, evidenceHash: `0x${"cd".repeat(32)}` } as never,
        unrelatedAddress,
      );

      expect(result.error, "R8-R4a").toBe("escrow_mismatch");
      expect(chain.releaseMilestone, "R8-R4a no chain call").not.toHaveBeenCalled();
    } finally {
      if (savedAddr === undefined) delete process.env.ESCROW_CONTRACT_ADDRESS;
      else process.env.ESCROW_CONTRACT_ADDRESS = savedAddr;
      if (savedVer === undefined) delete process.env.ESCROW_CONTRACT_VERSION;
      else process.env.ESCROW_CONTRACT_VERSION = savedVer;
    }
  });

  it("R8-M1b (versionless env default refuses a legitimate producer): a rowless job via autoReleaseContractAddress, with ESCROW_CONTRACT_VERSION unset, must persist with no chain call", async () => {
    process.env.ESCROW_CONTRACT_ADDRESS = addr(0xd8fe1);
    delete process.env.ESCROW_CONTRACT_VERSION; // explicit premise of the finding
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.getEscrowState).mockRejectedValue(new Error("R8-M1b: V1 ABI called on a V2-only factory")); // as on a factory

    const { jobId } = seedBareJob();
    const { autoReleaseContractAddress } = await import("../services/kernel-service.js");
    const contractAddress = autoReleaseContractAddress(jobId); // the way the producer calls it

    const bundle = makeBundle(jobId, { id: "bundle-r8-m1b" });
    const result = await getSettlementService().processEvidence(bundle, jobId, { contractAddress });

    expect(result.error, "R8-M1b").toBeUndefined();
    expect(getRepos().evidence.findById("bundle-r8-m1b"), "R8-M1b header persisted").toBeDefined();
    expect(getRepos().evidence.findEventsByBundle("bundle-r8-m1b").length, "R8-M1b events persisted").toBeGreaterThan(0);
    expect(chain.submitEvidence, "R8-M1b no chain call").not.toHaveBeenCalled();
  });

  it("R8-M2 (status domain): an out-of-domain releasedStatus must drift, not complete the escrow (4b24042b API; rewritten against abiVersion in Phase 2)", () => {
    const { escrowId } = seed();
    const begun = beginSettlement({ escrowId });
    if (!("claim" in begun)) throw new Error(`R8-M2: expected an acquired claim, got disposition=${begun.disposition}`);
    const claim: SettlementClaim = begun.claim;
    const matchingStepId = keccak256(toBytes("step-1")) as Hex;
    try {
      // The EXACT 4b24042b call shape (`releasedStatus`), kept here only as the historical repro form — cast
      // through `never` so this file still compiles once Phase 2 changes `ChainSettlementInput` to `abiVersion`.
      const outcome = recordChainSettlement(claim, { stepIds: [matchingStepId], statuses: [999], releasedStatus: 999 } as never);

      expect(outcome, "R8-M2 drifted").toEqual(expect.objectContaining({ ok: false, drifted: true }));
      const row = getRepos().escrows.findMilestonesByEscrow(escrowId)[0]!;
      expect(row.status, "R8-M2 milestone not stamped").not.toBe("released");
      expect(getRepos().escrows.findById(escrowId)!.status, "R8-M2 escrow not completed").not.toBe("completed");
    } finally {
      endSettlement(claim);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 2 helpers
// ---------------------------------------------------------------------------

/** A second, independent bare job/kernel for FK-mutation columns (`jobId`, `kernelId`) — a REAL row, never a
 *  dangling id, so the FK reference stays satisfiable. */
function secondKernelId(tag: string): string {
  const id = `kernel-r8-${tag}`;
  const now = new Date().toISOString();
  getRepos().kernels.insert({
    id,
    name: `kernel ${tag}`,
    operatorAddress: addr(0xb000),
    location: { lat: 0, lng: 0 },
    physicalAddress: "nowhere",
    maxAssuranceTier: 3,
    publicKey: `0xpub-${tag}`,
    status: "online",
    registeredAt: now,
    lastHeartbeat: now,
    version: "1.0.0",
  } as never);
  return id;
}

/** P3 generic (evidenceBundles): a different, valid value for ONE column, given the bundle a fresh delivery
 *  already stored. FK columns point at a second real job/kernel; integers +1; JSON gets a changed field;
 *  nullable columns flip null<->non-null; everything else gets a different literal. Throws for an unhandled
 *  column so a future schema column without a strategy here fails the test loudly, instead of silently
 *  skipping. */
function mutateBundleColumnValue(col: string, bundle: EvidenceBundle, jobId: string): unknown {
  switch (col) {
    case "jobId":
      return seedBareJob().jobId;
    case "stepId":
      return `${bundle.stepId}-mutated`;
    case "kernelId":
      return secondKernelId(`bundlecol-${bundle.id}`);
    case "assuranceTier":
      return (bundle.assuranceTier as number) + 1;
    case "tenantId":
      return (getRepos().jobs.findById(jobId)!.tenantId ?? null) === null ? "tenant-mutated" : null;
    case "bundleHash":
      return `sha256:${"ee".repeat(32)}`;
    case "kernelSignature":
      return { ...bundle.kernelSignature, value: "mutated-sig" };
    case "sessionKeyAuthorization":
      return bundle.sessionKeyAuthorization ? null : sessionKeyAuth("sess-mutated-fallback");
    case "createdAt":
      return "2099-01-01T00:00:00.000Z";
    default:
      throw new Error(`mutateBundleColumnValue: no mutation strategy for evidenceBundles column "${col}" — add one (N79 round 8, P3 "generic per column" requires every column exercised).`);
  }
}

/** P3 generic (evidenceEvents): a different, valid value for ONE column. `bundleId` mutated to a DIFFERENT
 *  bundle id makes the row invisible to `findEventsByBundle(bundle.id)`, drifting the comparison on
 *  cardinality instead of a per-column mismatch — still a conflict, just through a different branch of
 *  `eventsExactMatch`. */
function mutateEventColumnValue(col: string, event: EvidenceBundle["events"][number], bundleId: string): unknown {
  switch (col) {
    case "bundleId":
      return `${bundleId}-other-bundle`;
    case "type":
      return event.type === "execution_started" ? "execution_completed" : "execution_started";
    case "timestamp":
      return "2099-01-01T00:00:00.000Z";
    case "source":
      return { ...event.source, deviceId: "mutated-device" };
    case "payload":
      return { ...(event.payload as Record<string, unknown>), mutated: true };
    case "hash":
      return `sha256:${"ff".repeat(32)}`;
    default:
      throw new Error(`mutateEventColumnValue: no mutation strategy for evidenceEvents column "${col}" — add one (N79 round 8, P3 "generic per column" requires every column exercised).`);
  }
}

describe("N79 round 8: Phase 2 — properties (P2 / P3 / P4)", () => {
  let savedEscrowEnv: string | undefined;
  let savedEscrowVerEnv: string | undefined;

  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    resetSettlementService();
    savedEscrowEnv = process.env.ESCROW_CONTRACT_ADDRESS;
    savedEscrowVerEnv = process.env.ESCROW_CONTRACT_VERSION;
    delete process.env.ESCROW_CONTRACT_ADDRESS;
    delete process.env.ESCROW_CONTRACT_VERSION;
    vi.mocked(chain.isWriteEnabled).mockReset().mockReturnValue(false);
    vi.mocked(chain.submitEvidence).mockReset();
    vi.mocked(chain.getEscrowState).mockReset();
    vi.mocked(chain.getEscrowStateV2).mockReset();
  });

  afterEach(() => {
    closeStore();
    resetSettlementService();
    if (savedEscrowEnv === undefined) delete process.env.ESCROW_CONTRACT_ADDRESS;
    else process.env.ESCROW_CONTRACT_ADDRESS = savedEscrowEnv;
    if (savedEscrowVerEnv === undefined) delete process.env.ESCROW_CONTRACT_VERSION;
    else process.env.ESCROW_CONTRACT_VERSION = savedEscrowVerEnv;
  });

  // ── P3, generic per column ────────────────────────────────────────────────

  it("P3 (generic per column, evidenceBundles): a stored row mutated in ANY ONE column must conflict with a re-delivery of the original bundle", async () => {
    const columns = Object.keys(getTableColumns(schema.evidenceBundles)).filter((c) => c !== "id");
    const exercised = new Set<string>();

    for (const col of columns) {
      const { jobId } = seedBareJob();
      getRepos().jobs.update(jobId, { tenantId: "tenant-p3col" });
      const bundleId = `bundle-r8-p3col-${col}`;
      const auth = sessionKeyAuth(`sess-p3col-${col}`);
      const bundle = makeBundle(jobId, { id: bundleId, sessionKeyAuthorization: auth });

      const firstResult = await getSettlementService().processEvidence(bundle, jobId);
      expect(firstResult.error, `P3col(bundles) setup ${col}`).toBeUndefined();

      const mutatedValue = mutateBundleColumnValue(col, bundle, jobId);
      getStore()
        .db.update(schema.evidenceBundles)
        .set({ [col]: mutatedValue } as never)
        .where(eq(schema.evidenceBundles.id, bundleId))
        .run();

      vi.mocked(chain.submitEvidence).mockClear();
      const result = await getSettlementService().processEvidence(bundle, jobId); // re-deliver the SAME, ORIGINAL bundle

      expect(result.error, `P3col(bundles) ${col}`).toBe("evidence_bundle_conflict");
      expect(chain.submitEvidence, `P3col(bundles) ${col} no chain write`).not.toHaveBeenCalled();
      exercised.add(col);
    }

    // Every column except `id` was exercised — a future column with no mutation strategy above throws (loudly
    // failing this test) rather than silently passing unexercised.
    expect(exercised).toEqual(new Set(columns));
  });

  it("P3 (generic per column, evidenceEvents): a stored event row mutated in ANY ONE column must conflict with a re-delivery of the original bundle", async () => {
    const columns = Object.keys(getTableColumns(schema.evidenceEvents)).filter((c) => c !== "id");
    const exercised = new Set<string>();

    for (const col of columns) {
      const { jobId } = seedBareJob();
      const job = getRepos().jobs.findById(jobId)!;
      const bundleId = `bundle-r8-p3colev-${col}`;
      const eventId = `ev-r8-p3colev-${col}`;
      const eventSeed = {
        id: eventId,
        type: "execution_started" as const,
        timestamp: "2026-01-01T00:00:00.000Z",
        source: { deviceId: "dev-r8-p3colev", deviceType: "controller" as const, kernelId: job.kernelId },
        payload: { n: 1 },
        hash: `sha256:${"ab".repeat(32)}` as `sha256:${string}`,
      };
      const bundle = makeBundle(jobId, { id: bundleId, events: [eventSeed] });

      const firstResult = await getSettlementService().processEvidence(bundle, jobId);
      expect(firstResult.error, `P3colev setup ${col}`).toBeUndefined();

      const mutatedValue = mutateEventColumnValue(col, eventSeed, bundleId);
      getStore()
        .db.update(schema.evidenceEvents)
        .set({ [col]: mutatedValue } as never)
        .where(eq(schema.evidenceEvents.id, eventId))
        .run();

      vi.mocked(chain.submitEvidence).mockClear();
      const result = await getSettlementService().processEvidence(bundle, jobId);

      expect(result.error, `P3colev ${col}`).toBe("evidence_bundle_conflict");
      expect(chain.submitEvidence, `P3colev ${col} no chain write`).not.toHaveBeenCalled();
      exercised.add(col);
    }

    expect(exercised).toEqual(new Set(columns));
  });

  it("P3 (fresh insert writes every computed column): includes sessionKeyAuthorization and the job's tenantId", async () => {
    const { jobId } = seedBareJob();
    getRepos().jobs.update(jobId, { tenantId: "tenant-fresh-insert" });
    const auth = sessionKeyAuth("sess-fresh-insert-all-cols");
    const bundleId = "bundle-r8-p3-fresh-all";
    const bundle = makeBundle(jobId, { id: bundleId, sessionKeyAuthorization: auth });

    const result = await getSettlementService().processEvidence(bundle, jobId);
    expect(result.error, "P3 fresh insert").toBeUndefined();

    const stored = getRepos().evidence.findById(bundleId)! as unknown as Record<string, unknown>;
    const job = getRepos().jobs.findById(jobId)!;
    const columns = Object.keys(getTableColumns(schema.evidenceBundles)).filter((c) => c !== "id");
    for (const col of columns) {
      const expected =
        col === "tenantId"
          ? job.tenantId ?? null
          : col === "sessionKeyAuthorization"
            ? bundle.sessionKeyAuthorization ?? null
            : (bundle as unknown as Record<string, unknown>)[col];
      expect(stored[col], `P3 fresh-insert column ${col}`).toEqual(expected);
    }

    const storedEvents = getRepos().evidence.findEventsByBundle(bundleId);
    expect(storedEvents.length, "P3 fresh-insert event count").toBe(bundle.events.length);
    expect(storedEvents[0]?.source, "P3 fresh-insert event source").toEqual(bundle.events[0]!.source);
    expect(storedEvents[0]?.payload, "P3 fresh-insert event payload").toEqual(bundle.events[0]!.payload);
  });

  // ── Round 7 regression guards ─────────────────────────────────────────────
  // The mutation table (brief's "Verify" section) re-runs round 7's mutants against round 8's rewritten code.
  // UPDATE (lead review iteration 2, addendum): iteration 1's comment here said this mutant ("the index
  // derivation dropped") was not independently caught by n79-r7-review.test.ts, because its ONE assertion that
  // pins the exact `evidence_milestone_mismatch` code (inside the giant "P2: escrow-target and
  // milestone-index refusals" test) never ran -- that test failed earlier, on the unrelated "no-row+env-match"
  // gap. Item 5(ii) of this iteration fixed that gap (added ESCROW_CONTRACT_VERSION="v1" beside the fixture's
  // existing ESCROW_CONTRACT_ADDRESS sets), so the giant test now runs to its end -- and re-applying this
  // mutant confirms its "wrong-supplied-index" sub-case NOW independently catches it too (verified: `expected
  // 'evidence_milestone_unbound' to be 'evidence_milestone_mismatch'`). R7-H1 still only asserts "no chain
  // call" on its own (masked by the redundant fresh pre-submit on-chain re-check when write is enabled), so
  // this guard is KEPT regardless: it isolates the LOCAL derivation+mismatch check alone (write disabled, so
  // Step 3's redundant chain layer never engages), independent of which OTHER test in the suite currently
  // covers the property, and independent of any future gap in that giant test reopening the same blind spot.
  it("R7 regression guard (index derivation): a wrong supplied milestoneIndex for a job-owned escrow must mismatch via LOCAL derivation alone", async () => {
    const { jobId } = seed(); // one milestone at local index 0, stepId "step-1" === job.stepId
    // isWriteEnabled defaults false in this describe's beforeEach -- Step 3's fresh on-chain re-check never
    // runs, so ONLY the bind-first derivation+mismatch check can catch a wrong supplied index here.
    const bundleId = "bundle-r8-r7guard-idx";
    const bundle = makeBundle(jobId, { id: bundleId });
    const result = await getSettlementService().processEvidence(bundle, jobId, { milestoneIndex: 1 }); // wrong: only index 0 exists

    expect(result.error, "R7 regression guard (index derivation)").toBe("evidence_milestone_mismatch");
    expect(getRepos().evidence.findById(bundleId), "R7 regression guard (index derivation) not persisted").toBeUndefined();
  });

  // ── P2-version, parametrized ──────────────────────────────────────────────

  it.each([null, "v2"] as const)("P2-version (job-owned row, version=%s): reads through V2", async (version) => {
    const { jobId, address } = seed({ version });
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xp2v", status: "submitted" } as never);
    vi.mocked(chain.getEscrowState).mockRejectedValue(new Error(`P2-version row=${version}: V1 must never be read for a resolved-v2 row`));
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(v2StateFor("step-1", address));

    const bundle = makeBundle(jobId, { id: `bundle-r8-p2v-${String(version)}` });
    const result = await getSettlementService().processEvidence(bundle, jobId, { contractAddress: address });

    expect(result.error, `P2-version row=${version}`).toBeUndefined();
    expect(chain.submitEvidence, `P2-version row=${version}`).toHaveBeenCalledTimes(1);
  });

  // N79 round 8, lead review iteration 2, item 2: "v1" belongs in this bucket too — a row's RAW column value
  // is never the rowless sentinel (R8-R2a above pins the specific reproduction with V1 mocked to succeed, so
  // this parametrized case is the general property: resolveEscrowRowVersion("v1") is UNKNOWN, same as "v3" and
  // "garbage").
  it.each(["v1", "v3", "garbage"])("P2-version (job-owned row, version=%s): refuses the chain write, no chain call", async (version) => {
    const { jobId, address } = seed({ version });
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockClear();

    const bundle = makeBundle(jobId, { id: `bundle-r8-p2v-${version}` });
    const result = await getSettlementService().processEvidence(bundle, jobId, { contractAddress: address });

    // Step 1 (DB persist) is independent of the pre-chain-write verification refusing: the evidence still
    // lands, only the chain write (and Step 3's own result.error) is refused.
    expect(result.error, `P2-version row=${version}`).toBe("evidence_milestone_unbound");
    expect(chain.submitEvidence, `P2-version row=${version}`).not.toHaveBeenCalled();
    expect(getRepos().evidence.findById(bundle.id), `P2-version row=${version} still persisted`).toBeDefined();
  });

  it.each([undefined, "v2", "v3", "garbage"])(
    "P2-version (rowless, ESCROW_CONTRACT_VERSION=%s): no chain target -- evidence persisted, no chain call, a supplied address still refused",
    async (version) => {
      process.env.ESCROW_CONTRACT_ADDRESS = addr(0xd8f00);
      if (version === undefined) delete process.env.ESCROW_CONTRACT_VERSION;
      else process.env.ESCROW_CONTRACT_VERSION = version;
      vi.mocked(chain.isWriteEnabled).mockReturnValue(true);

      const { jobId } = seedBareJob();
      const bundle = makeBundle(jobId, { id: `bundle-r8-p2v-rowless-${String(version)}` });
      // No contractAddress supplied -- the way the producer calls it once autoReleaseContractAddress resolves none.
      const result = await getSettlementService().processEvidence(bundle, jobId, {});
      expect(result.error, `P2-version rowless version=${version}`).toBeUndefined();
      expect(getRepos().evidence.findById(bundle.id), `P2-version rowless version=${version} persisted`).toBeDefined();
      expect(chain.submitEvidence, `P2-version rowless version=${version} no chain`).not.toHaveBeenCalled();

      // A SUPPLIED address for the SAME rowless job is still refused.
      const bundle2 = makeBundle(jobId, { id: `bundle-r8-p2v-rowless-addr-${String(version)}` });
      const result2 = await getSettlementService().processEvidence(bundle2, jobId, {
        contractAddress: process.env.ESCROW_CONTRACT_ADDRESS,
      });
      expect(result2.error, `P2-version rowless+address version=${version}`).toBe("escrow_mismatch");
    },
  );

  it("P2-version (rowless, ESCROW_CONTRACT_VERSION=v1): the V1 path, as before", async () => {
    process.env.ESCROW_CONTRACT_ADDRESS = addr(0xd8fff);
    process.env.ESCROW_CONTRACT_VERSION = "v1";
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xp2v1", status: "submitted" } as never);

    const { jobId, stepId } = seedBareJob();
    vi.mocked(chain.getEscrowState).mockResolvedValue({
      milestones: [{ stepId: keccak256(toBytes(stepId)) }],
    } as never);
    const bundle = makeBundle(jobId, { id: "bundle-r8-p2v-rowless-v1" });
    const result = await getSettlementService().processEvidence(bundle, jobId, {
      contractAddress: process.env.ESCROW_CONTRACT_ADDRESS,
    });

    expect(result.error, "P2-version rowless v1").toBeUndefined();
    expect(chain.submitEvidence, "P2-version rowless v1").toHaveBeenCalledTimes(1);
  });

  // ── P4-domain, parametrized ────────────────────────────────────────────────

  describe("P4-domain", () => {
    const OUT_OF_DOMAIN = [-1, 9, 999, 2.5, NaN, Infinity];
    const ABI_VERSIONS = ["v1", "v2", "v3"] as const;

    it.each(ABI_VERSIONS.flatMap((v) => OUT_OF_DOMAIN.map((s) => [v, s] as const)))(
      "abiVersion=%s, one out-of-domain status (%s): drifted, nothing written",
      (abiVersion, badStatus) => {
        const { escrowId } = seed();
        const begun = beginSettlement({ escrowId });
        if (!("claim" in begun)) throw new Error(`P4-domain: expected an acquired claim, got disposition=${begun.disposition}`);
        const claim: SettlementClaim = begun.claim;
        const matchingStepId = keccak256(toBytes("step-1")) as Hex;
        try {
          const outcome = recordChainSettlement(claim, { stepIds: [matchingStepId], statuses: [badStatus], abiVersion });
          expect(outcome, `P4-domain ${abiVersion}/${badStatus}`).toEqual(expect.objectContaining({ ok: false, drifted: true }));
          expect(getRepos().escrows.findMilestonesByEscrow(escrowId)[0]!.status, `P4-domain ${abiVersion}/${badStatus}`).not.toBe("released");
          expect(getRepos().escrows.findById(escrowId)!.status, `P4-domain ${abiVersion}/${badStatus} escrow`).not.toBe("completed");
        } finally {
          endSettlement(claim);
        }
      },
    );

    it.each(ABI_VERSIONS)("abiVersion=%s, ALL slots out-of-domain: drifted, nothing written", (abiVersion) => {
      const { escrowId } = seed({ milestones: ["funded", "funded", "funded", "funded", "funded", "funded"] });
      const begun = beginSettlement({ escrowId });
      if (!("claim" in begun)) throw new Error(`P4-domain allslots: expected an acquired claim, got disposition=${begun.disposition}`);
      const claim: SettlementClaim = begun.claim;
      const stepIds = [1, 2, 3, 4, 5, 6].map((n) => keccak256(toBytes(`step-${n}`)) as Hex);
      try {
        const outcome = recordChainSettlement(claim, { stepIds, statuses: OUT_OF_DOMAIN, abiVersion });
        expect(outcome, `P4-domain allslots ${abiVersion}`).toEqual(expect.objectContaining({ ok: false, drifted: true }));
        expect(
          getRepos().escrows.findMilestonesByEscrow(escrowId).every((m) => m.status !== "released"),
          `P4-domain allslots ${abiVersion}`,
        ).toBe(true);
      } finally {
        endSettlement(claim);
      }
    });

    // The M2 property (astra 126i MEDIUM-2's own reproduction, statuses:[999] against a one-row escrow) is the
    // abiVersion="v2"/badStatus=999 case of the first `it.each` above — rewritten against the new API here, as
    // the brief requires; the 4b24042b-shaped form stays ONLY in the Phase 1 repro section.

    it.each(ABI_VERSIONS)("abiVersion=%s sanity: all in-domain Released completes", (abiVersion) => {
      const { escrowId } = seed();
      const begun = beginSettlement({ escrowId });
      if (!("claim" in begun)) throw new Error(`P4-domain sanity: expected an acquired claim, got disposition=${begun.disposition}`);
      const claim: SettlementClaim = begun.claim;
      const matchingStepId = keccak256(toBytes("step-1")) as Hex;
      try {
        // 5 = Released for all three ABIs today (V1/V2/V3 share an identical 0..8 domain) — this sanity case
        // does not assume that; it only exercises whatever abiVersion's OWN Released value resolves to, via
        // the SAME recordChainSettlement call the drift cases above use.
        const outcome = recordChainSettlement(claim, { stepIds: [matchingStepId], statuses: [5], abiVersion });
        expect(outcome, `P4-domain sanity ${abiVersion}`).toEqual(expect.objectContaining({ ok: true, completed: true }));
        expect(getRepos().escrows.findMilestonesByEscrow(escrowId)[0]!.status, `P4-domain sanity ${abiVersion}`).toBe("released");
      } finally {
        endSettlement(claim);
      }
    });

    it("an unknown abiVersion is drift", () => {
      const { escrowId } = seed();
      const begun = beginSettlement({ escrowId });
      if (!("claim" in begun)) throw new Error(`P4-domain unknown: expected an acquired claim, got disposition=${begun.disposition}`);
      const claim: SettlementClaim = begun.claim;
      const matchingStepId = keccak256(toBytes("step-1")) as Hex;
      try {
        const outcome = recordChainSettlement(claim, { stepIds: [matchingStepId], statuses: [5], abiVersion: "v4" } as never);
        expect(outcome).toEqual(expect.objectContaining({ ok: false, drifted: true }));
      } finally {
        endSettlement(claim);
      }
    });
  });
});
