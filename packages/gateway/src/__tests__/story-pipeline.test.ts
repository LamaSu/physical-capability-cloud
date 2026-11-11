/**
 * Tests for the automatic Story Protocol IP registration pipeline.
 *
 * Covers:
 *   - CSD publish (POST /api/csd) → auto Story IP registration
 *   - processEvidence → auto Story derivative IP registration
 *   - releaseMilestone → auto Story royalty payment
 *
 * All Story Protocol calls are mocked via vi.mock("@pcc/contracts").
 * DB uses in-memory SQLite.
 * External calls (IPFS, escrow) also mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { csdRoutes, resetCsdRegistry } from "../routes/csd.js";
import { initStore, closeStore } from "../db.js";
import {
  resetSettlementService,
  getSettlementService,
} from "../services/settlement-service.js";
import { pipelineTelemetry } from "../telemetry.js";
import { auditService } from "../services/audit-service.js";
import type { EvidenceBundle } from "@pcc/spec";
import type { OracleAttestation } from "@pcc/contracts";

// ---------------------------------------------------------------------------
// Attestation fixture — required on every release() path
// ---------------------------------------------------------------------------

/** Deterministic test attestation bound to the test escrow address. */
function mkAttestation(
  escrowAddress: `0x${string}` = "0xDeAdBeEf00000000000000000000000000000001",
): OracleAttestation {
  return {
    version: 1,
    escrowAddress,
    jobId: "job-001",
    evidenceHash:
      "0x570b1e0000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
    tier: 0,
    verified: true,
    timestamp: 1700000000n,
    nonce: ("0x" + "d".repeat(64)) as `0x${string}`,
    extraData: "0x" as `0x${string}`,
    signature: "0x" as `0x${string}`,
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the Story IP service from @pcc/contracts
const mockRegisterCapabilityAsIP = vi.fn().mockResolvedValue({
  ipId: "0xmock_ip_id_csd_001",
  nftTokenId: "1234",
  licenseTermsId: "99",
  txHash: "0xmock_reg_tx",
  capabilityId: "test-cap-id",
  csdUrl: "pcc://capabilities/test/v1",
  registeredAt: new Date().toISOString(),
  chain: "story-aeneid",
});

const mockRegisterJobAsDerivative = vi.fn().mockResolvedValue({
  parentIpId: "0xmock_parent_ip",
  childIpId: "0xmock_child_ip_001",
  licenseTokenId: "55",
  jobId: "job-004",
  evidenceBundleHash: "sha256:mock_bundle_hash",
  txHash: "0xmock_deriv_tx",
  linkedAt: new Date().toISOString(),
});

const mockPayJobRoyalty = vi.fn().mockResolvedValue({
  txHash: "0xmock_royalty_tx",
});

const mockGetStoryIPService = vi.fn().mockReturnValue({
  registerCapabilityAsIP: mockRegisterCapabilityAsIP,
  registerJobAsDerivative: mockRegisterJobAsDerivative,
  payJobRoyalty: mockPayJobRoyalty,
});

vi.mock("@pcc/contracts", () => ({
  getStoryIPService: mockGetStoryIPService,
  resetStoryIPService: vi.fn(),
  StoryIPService: vi.fn(),
}));

// Mock the evidence storage (no real IPFS)
vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({
      cid: "bafytest_story",
      metadataCid: "bafymeta_story",
    }),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Mock the on-chain escrow client
vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({
    transactionHash: "0xevidence_tx",
    status: "submitted",
  }),
  releaseMilestone: vi.fn().mockResolvedValue({
    transactionHash: "0xrelease_tx",
    status: "submitted",
  }),
  isWriteEnabled: vi.fn().mockReturnValue(false),
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
}));

// Mock batch settlement
vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({
    epochId: "e1",
    totalIntents: 0,
    batches: [],
    byAgent: {},
    byOperation: {},
    startedAt: 0,
    completedAt: 0,
  }),
  getQueueStatus: vi.fn().mockReturnValue({
    pending: 0,
    totalValue: 0n,
    oldestIntentAge: 0,
  }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_CSD = {
  url: "pcc://capabilities/story-test/v1",
  version: "1.0.0",
  status: "active" as const,
  name: "Story Test Capability",
  description: "Capability for Story Protocol pipeline tests",
  kind: "base" as const,
  baseDefinition: null,
  parameters: [],
  constraints: [],
  pricing: { basePrice: "5.00", currency: "USDC" },
  // Extra fields for Story registration (not part of CSD schema — stripped during parse)
  designerAddress: "0xDESIGNER",
  designerName: "Test Designer",
  commercialRevShare: 5,
};

function makeBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    id: "bundle-story-001",
    jobId: "job-004",
    stepId: "step-4",
    kernelId: "kernel-nyc",
    assuranceTier: 0,
    bundleHash:
      "sha256:story_pipeline_hash_abc123def456abc123def456abc123def456abc123" as `sha256:${string}`,
    kernelSignature: {
      signer: "0x0000000000000000000000000000000000000000" as const,
      algorithm: "secp256k1" as const,
      value: "mock_sig_story",
    },
    createdAt: new Date().toISOString(),
    events: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// App builders
// ---------------------------------------------------------------------------

async function buildCsdApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  resetCsdRegistry();

  const app = Fastify({ logger: false });
  await app.register(csdRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// CSD Publish → Auto IP Registration
// ---------------------------------------------------------------------------

describe("CSD Publish → Auto Story IP Registration", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildCsdApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetCsdRegistry();
  });

  it("POST /api/csd succeeds even when Story registration is not mocked to fail", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/csd",
      payload: VALID_CSD,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ registered: boolean; url: string; storyIpId?: string; storyIpSkipped?: string }>();
    expect(body.registered).toBe(true);
    expect(body.url).toBe("pcc://capabilities/story-test/v1");
    expect(body.storyIpSkipped).toBe("register_via_capability");
  });

  it("POST /api/csd does not call getStoryIPService or registerCapabilityAsIP", async () => {
    await app.inject({
      method: "POST",
      url: "/api/csd",
      payload: VALID_CSD,
    });

    expect(mockGetStoryIPService).not.toHaveBeenCalled();
    expect(mockRegisterCapabilityAsIP).not.toHaveBeenCalled();
  });

  it("POST /api/csd returns no storyIpId and storyIpSkipped register_via_capability", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/csd",
      payload: VALID_CSD,
    });

    const body = res.json<{ storyIpId?: string; storyIpSkipped?: string }>();
    expect(body).not.toHaveProperty("storyIpId");
    expect(body.storyIpId).toBeUndefined();
    expect(body.storyIpSkipped).toBe("register_via_capability");
  });

  it("POST /api/csd succeeds when Story registration would throw and mock is not called", async () => {
    mockRegisterCapabilityAsIP.mockRejectedValueOnce(
      new Error("Story network unavailable"),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/csd",
      payload: VALID_CSD,
    });

    // Primary flow must succeed
    expect(res.statusCode).toBe(200);
    const body = res.json<{ registered: boolean; storyIpId?: string; storyIpSkipped?: string }>();
    expect(body.registered).toBe(true);
    expect(body.storyIpSkipped).toBe("register_via_capability");
    expect(body).not.toHaveProperty("storyIpId");
    expect(mockRegisterCapabilityAsIP).not.toHaveBeenCalled();
    expect(mockGetStoryIPService).not.toHaveBeenCalled();
  });

  it("POST /api/csd returns 400 for invalid CSD regardless of Story service", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/csd",
      payload: { url: "bad", name: "only name" },
    });

    expect(res.statusCode).toBe(400);
    // Story service should not have been called for an invalid CSD
    expect(mockRegisterCapabilityAsIP).not.toHaveBeenCalled();
  });

  it("POST /api/csd with no designerAddress makes no Story call at all", async () => {
    const csdWithoutDesigner = { ...VALID_CSD };
    // Remove designer fields - they come through req.body not the CSD schema
    delete (csdWithoutDesigner as Record<string, unknown>).designerAddress;
    delete (csdWithoutDesigner as Record<string, unknown>).designerName;
    // Use a slightly different url to avoid duplicate error
    (csdWithoutDesigner as Record<string, unknown>).url =
      "pcc://capabilities/story-test-no-designer/v1";

    const res = await app.inject({
      method: "POST",
      url: "/api/csd",
      payload: csdWithoutDesigner,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ storyIpSkipped?: string }>().storyIpSkipped).toBe("register_via_capability");
    expect(mockGetStoryIPService).not.toHaveBeenCalled();
    expect(mockRegisterCapabilityAsIP).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processEvidence → Auto Derivative IP Registration
// ---------------------------------------------------------------------------

describe("processEvidence → Auto Story Derivative IP", () => {
  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    resetSettlementService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeStore();
    resetSettlementService();
  });

  it("calls registerJobAsDerivative when the job has a Story IP registration", async () => {
    // Seed the DB with a Story IP registration for the capability used by job-004
    const { getRepos } = await import("../db.js");
    const repos = getRepos();

    // job-004 has capabilityId "cap-nyc-fdm" (seeded data)
    repos.story.insertIpRegistration({
      ipId: "0xmock_parent_ip",
      nftTokenId: "1",
      licenseTermsId: "1",
      txHash: "0xtx_parent",
      capabilityId: "cap-nyc-fdm",
      csdUrl: "pcc://capabilities/fdm/v2",
      chain: "story-aeneid",
      registeredAt: new Date().toISOString(),
    });

    const service = getSettlementService();
    const bundle = makeBundle();
    const result = await service.processEvidence(bundle, "job-004");

    // Primary flow must succeed
    expect(result.evidenceBundleId).toBe("bundle-story-001");
    expect(result.cid).toBe("bafytest_story");

    // Story derivative registration should have been triggered
    expect(mockGetStoryIPService).toHaveBeenCalled();
    expect(mockRegisterJobAsDerivative).toHaveBeenCalledOnce();
    const [parentIpId, evidence] = mockRegisterJobAsDerivative.mock.calls[0];
    expect(parentIpId).toBe("0xmock_parent_ip");
    expect(evidence.jobId).toBe("job-004");
    expect(evidence.operatorAddress).toBe("0x1111111111111111111111111111111111111111");
  });

  it("does NOT call registerJobAsDerivative when job has no Story IP registration", async () => {
    // No Story IP registration in DB — should skip silently
    const service = getSettlementService();
    const bundle = makeBundle();
    const result = await service.processEvidence(bundle, "job-004");

    expect(result.evidenceBundleId).toBe("bundle-story-001");
    expect(mockRegisterJobAsDerivative).not.toHaveBeenCalled();
  });

  it("processEvidence succeeds even when registerJobAsDerivative throws (best-effort)", async () => {
    const { getRepos } = await import("../db.js");
    const repos = getRepos();

    repos.story.insertIpRegistration({
      ipId: "0xmock_parent_ip_fail",
      nftTokenId: "2",
      licenseTermsId: "2",
      txHash: "0xtx_fail",
      capabilityId: "cap-nyc-fdm",
      csdUrl: "pcc://capabilities/fdm/v2",
      chain: "story-aeneid",
      registeredAt: new Date().toISOString(),
    });

    mockRegisterJobAsDerivative.mockRejectedValueOnce(
      new Error("Story network timeout"),
    );

    const service = getSettlementService();
    const bundle = makeBundle();

    // Must not throw despite Story failure
    const result = await service.processEvidence(bundle, "job-004");
    expect(result.evidenceBundleId).toBe("bundle-story-001");
    // No error in result (Story errors are swallowed)
    expect(result.error).toBeUndefined();
  });

  it("persists derivative link to DB after successful registration", async () => {
    const { getRepos } = await import("../db.js");
    const repos = getRepos();

    repos.story.insertIpRegistration({
      ipId: "0xmock_parent_ip_persist",
      nftTokenId: "3",
      licenseTermsId: "3",
      txHash: "0xtx_persist",
      capabilityId: "cap-nyc-fdm",
      csdUrl: "pcc://capabilities/fdm/v2",
      chain: "story-aeneid",
      registeredAt: new Date().toISOString(),
    });

    mockRegisterJobAsDerivative.mockResolvedValueOnce({
      parentIpId: "0xmock_parent_ip_persist",
      childIpId: "0xmock_child_persist",
      licenseTokenId: "77",
      jobId: "job-004",
      evidenceBundleHash: "sha256:persist_test",
      txHash: "0xderiv_persist",
      linkedAt: new Date().toISOString(),
    });

    const service = getSettlementService();
    await service.processEvidence(makeBundle(), "job-004");

    // Verify derivative link is in DB
    const links = repos.story.findDerivativeLinksByJob("job-004");
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].parentIpId).toBe("0xmock_parent_ip_persist");
    expect(links[0].childIpId).toBe("0xmock_child_persist");
  });
});

// ---------------------------------------------------------------------------
// releaseMilestone → Auto Story Royalty Payment
// ---------------------------------------------------------------------------

describe("releaseMilestone → Auto Story Royalty Payment", () => {
  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    resetSettlementService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeStore();
    resetSettlementService();
  });

  it("does not call payJobRoyalty when job has a derivative IP link and release succeeds", async () => {
    const escrowMod = await import("../contracts/escrow-client.js");
    vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

    const { getRepos } = await import("../db.js");
    const repos = getRepos();

    // Seed a Story IP registration
    repos.story.insertIpRegistration({
      ipId: "0xparent_ip_royalty",
      nftTokenId: "4",
      licenseTermsId: "4",
      txHash: "0xtx_royalty_parent",
      capabilityId: "cap-nyc-fdm",
      csdUrl: "pcc://capabilities/fdm/v2",
      chain: "story-aeneid",
      registeredAt: new Date().toISOString(),
    });

    // Seed a derivative link for job-001
    repos.story.insertDerivativeLink({
      id: "dl_job001_royalty",
      parentIpId: "0xparent_ip_royalty",
      childIpId: "0xchild_ip_royalty",
      licenseTokenId: "88",
      jobId: "job-001",
      evidenceBundleHash: "sha256:royalty_test",
      txHash: "0xtx_deriv_royalty",
      linkedAt: new Date().toISOString(),
    });

    const service = getSettlementService();
    const result = await service.releaseMilestone(
      "job-001",
      0,
      mkAttestation(),
      "0xDeAdBeEf00000000000000000000000000000001",
    );

    expect(result.status).toBe("released");
    expect(result.txHash).toBe("0xrelease_tx");

    expect(mockPayJobRoyalty).not.toHaveBeenCalled();
  });

  it("does NOT call payJobRoyalty when no derivative IP link exists", async () => {
    const escrowMod = await import("../contracts/escrow-client.js");
    vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

    const service = getSettlementService();
    const result = await service.releaseMilestone(
      "job-001",
      0,
      mkAttestation(),
      "0xDeAdBeEf00000000000000000000000000000001",
    );

    expect(result.status).toBe("released");
    expect(mockPayJobRoyalty).not.toHaveBeenCalled();
  });

  it("releaseMilestone succeeds and does not call payJobRoyalty even when payJobRoyalty would throw", async () => {
    const escrowMod = await import("../contracts/escrow-client.js");
    vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

    const { getRepos } = await import("../db.js");
    const repos = getRepos();

    // Must insert parent IP registration first due to FK constraint
    repos.story.insertIpRegistration({
      ipId: "0xparent_fail",
      nftTokenId: "10",
      licenseTermsId: "10",
      txHash: "0xtx_parent_fail",
      capabilityId: null,
      csdUrl: null,
      chain: "story-aeneid",
      registeredAt: new Date().toISOString(),
    });

    repos.story.insertDerivativeLink({
      id: "dl_job001_royalty_fail",
      parentIpId: "0xparent_fail",
      childIpId: "0xchild_fail",
      licenseTokenId: "99",
      jobId: "job-001",
      evidenceBundleHash: "sha256:royalty_fail",
      txHash: "0xtx_fail",
      linkedAt: new Date().toISOString(),
    });

    mockPayJobRoyalty.mockRejectedValueOnce(
      new Error("Royalty vault not found"),
    );

    const service = getSettlementService();
    const result = await service.releaseMilestone(
      "job-001",
      0,
      mkAttestation(),
      "0xDeAdBeEf00000000000000000000000000000001",
    );

    // Escrow release must succeed; payJobRoyalty is never called
    expect(result.status).toBe("released");
    expect(result.txHash).toBe("0xrelease_tx");
    expect(result.error).toBeUndefined();
    expect(mockPayJobRoyalty).not.toHaveBeenCalled();
  });

  it("releaseMilestone still fails when write is disabled (unrelated to Story)", async () => {
    const escrowMod = await import("../contracts/escrow-client.js");
    vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(false);

    const service = getSettlementService();
    const result = await service.releaseMilestone(
      "job-001",
      0,
      mkAttestation(),
      "0xDeAdBeEf00000000000000000000000000000001",
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("write_disabled");
    // Story royalty should never be called when the release itself failed
    expect(mockPayJobRoyalty).not.toHaveBeenCalled();
  });

  it("does not call payJobRoyalty with STORY_ROYALTY_PERCENT and STORY_MILESTONE_AMOUNT set", async () => {
    const escrowMod = await import("../contracts/escrow-client.js");
    vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

    const { getRepos } = await import("../db.js");
    const repos = getRepos();

    // Must insert parent IP registration first due to FK constraint
    repos.story.insertIpRegistration({
      ipId: "0xparent_pct",
      nftTokenId: "11",
      licenseTermsId: "11",
      txHash: "0xtx_parent_pct",
      capabilityId: null,
      csdUrl: null,
      chain: "story-aeneid",
      registeredAt: new Date().toISOString(),
    });

    repos.story.insertDerivativeLink({
      id: "dl_job001_royalty_pct",
      parentIpId: "0xparent_pct",
      childIpId: "0xchild_pct",
      licenseTokenId: "100",
      jobId: "job-001",
      evidenceBundleHash: "sha256:pct_test",
      txHash: "0xtx_pct",
      linkedAt: new Date().toISOString(),
    });

    process.env.STORY_ROYALTY_PERCENT = "10";
    process.env.STORY_MILESTONE_AMOUNT = "2000000";

    const service = getSettlementService();
    const result = await service.releaseMilestone(
      "job-001",
      0,
      mkAttestation(),
      "0xDeAdBeEf00000000000000000000000000000001",
    );

    expect(result.status).toBe("released");
    expect(mockPayJobRoyalty).not.toHaveBeenCalled();

    // Cleanup env vars
    delete process.env.STORY_ROYALTY_PERCENT;
    delete process.env.STORY_MILESTONE_AMOUNT;
  });
});

// ---------------------------------------------------------------------------
// N1-N3 (R5) — automatic derivative operator, unrecorded link, labels
// ---------------------------------------------------------------------------

describe("R5 automatic derivative operator and recording", () => {
  let emitSpy: ReturnType<typeof vi.spyOn> | undefined;
  let auditSpy: ReturnType<typeof vi.spyOn> | undefined;
  let insertSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    resetSettlementService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    emitSpy?.mockRestore();
    auditSpy?.mockRestore();
    insertSpy?.mockRestore();
    emitSpy = undefined;
    auditSpy = undefined;
    insertSpy = undefined;
    closeStore();
    resetSettlementService();
  });

  async function seedIpRegistration(ipId = "0xmock_parent_ip_r5") {
    const { getRepos } = await import("../db.js");
    getRepos().story.insertIpRegistration({
      ipId,
      nftTokenId: "1",
      licenseTermsId: "1",
      txHash: "0xtx_parent_r5",
      capabilityId: "cap-nyc-fdm",
      csdUrl: "pcc://capabilities/fdm/v2",
      chain: "story-aeneid",
      registeredAt: new Date().toISOString(),
    });
  }

  it.each(["", "0x0000000000000000000000000000000000000000", "operator-alice"])(
    "N1 ownerless kernel operator %j skips Story derivative with operator_unknown",
    async (operatorValue) => {
      await seedIpRegistration();
      const { getRepos } = await import("../db.js");
      getRepos().kernels.update("kernel-nyc", { operatorAddress: operatorValue });

      emitSpy = vi.spyOn(pipelineTelemetry, "emit");
      auditSpy = vi.spyOn(auditService, "log");

      const service = getSettlementService();
      const result = await service.processEvidence(makeBundle(), "job-004");

      expect(result.evidenceBundleId).toBe("bundle-story-001");
      expect(mockRegisterJobAsDerivative).not.toHaveBeenCalled();

      const skipped = emitSpy.mock.calls.find(
        (c) => c[0] === "job-004" && c[1] === "settlement_claim" && c[2] === "skipped",
      );
      expect(skipped).toBeDefined();
      expect((skipped?.[3] as { metadata?: Record<string, unknown> })?.metadata?.reason).toBe("operator_unknown");

      const storyAudits = auditSpy.mock.calls.filter((c) =>
        String((c[0] as { eventType?: string }).eventType).startsWith("settlement.story_"),
      );
      expect(storyAudits).toEqual([]);
    },
  );

  it("N2 unrecorded derivative link emits failed derivative_unrecorded and audits settlement.story_unrecorded", async () => {
    await seedIpRegistration();
    const { getRepos } = await import("../db.js");
    insertSpy = vi.spyOn(getRepos().story, "insertDerivativeLink").mockImplementation(() => {
      throw new Error("db insert failed");
    });

    emitSpy = vi.spyOn(pipelineTelemetry, "emit");
    auditSpy = vi.spyOn(auditService, "log");

    const service = getSettlementService();
    const result = await service.processEvidence(makeBundle(), "job-004");

    expect(result.evidenceBundleId).toBe("bundle-story-001");
    expect(mockRegisterJobAsDerivative).toHaveBeenCalled();

    const completed = emitSpy.mock.calls.filter(
      (c) => c[0] === "job-004" && c[1] === "settlement_claim" && c[2] === "completed",
    );
    expect(completed).toEqual([]);

    const failed = emitSpy.mock.calls.find(
      (c) => c[0] === "job-004" && c[1] === "settlement_claim" && c[2] === "failed",
    );
    expect(failed).toBeDefined();
    const failedMetadata = (failed?.[3] as { metadata?: Record<string, unknown> })?.metadata;
    expect(failedMetadata?.reason).toBe("derivative_unrecorded");
    expect(failedMetadata?.derivativeIpId).toBeDefined();
    expect(failedMetadata?.parentIpId).toBeDefined();

    const auditCalls = auditSpy.mock.calls.map((c) => c[0] as { eventType: string; metadata?: Record<string, unknown> });
    expect(auditCalls.some((a) => a.eventType === "settlement.story_unrecorded")).toBe(true);
    expect(auditCalls.some((a) => a.eventType === "settlement.story_registered")).toBe(false);
    const unrecorded = auditCalls.find((a) => a.eventType === "settlement.story_unrecorded");
    expect(unrecorded?.metadata?.reason).toBe("derivative_unrecorded");
    expect(unrecorded?.metadata?.derivativeIpId).toBe(failedMetadata?.derivativeIpId);
    expect(unrecorded?.metadata?.parentIpId).toBe(failedMetadata?.parentIpId);
  });

  it("N3 completed telemetry and story_registered audit carry simulated true when mock link is simulated", async () => {
    await seedIpRegistration();
    mockRegisterJobAsDerivative.mockResolvedValueOnce({
      parentIpId: "0xmock_parent_ip_r5",
      childIpId: "0xmock_child_r5",
      licenseTokenId: "55",
      jobId: "job-004",
      evidenceBundleHash: "sha256:mock_bundle_hash",
      txHash: "0xmock_deriv_tx",
      linkedAt: new Date().toISOString(),
      simulated: true,
    });

    emitSpy = vi.spyOn(pipelineTelemetry, "emit");
    auditSpy = vi.spyOn(auditService, "log");

    const service = getSettlementService();
    await service.processEvidence(makeBundle(), "job-004");

    const completed = emitSpy.mock.calls.find(
      (c) => c[0] === "job-004" && c[1] === "settlement_claim" && c[2] === "completed",
    );
    expect(completed).toBeDefined();
    expect((completed?.[3] as { metadata?: Record<string, unknown> })?.metadata?.simulated).toBe(true);

    const audit = auditSpy.mock.calls
      .map((c) => c[0] as { eventType: string; metadata?: Record<string, unknown> })
      .find((a) => a.eventType === "settlement.story_registered");
    expect(audit).toBeDefined();
    expect(audit?.metadata?.simulated).toBe(true);
  });

  it("N3 completed telemetry and story_registered audit carry simulated false when mock link has no simulated key", async () => {
    await seedIpRegistration();
    mockRegisterJobAsDerivative.mockResolvedValueOnce({
      parentIpId: "0xmock_parent_ip_r5",
      childIpId: "0xmock_child_r5_nosim",
      licenseTokenId: "55",
      jobId: "job-004",
      evidenceBundleHash: "sha256:mock_bundle_hash",
      txHash: "0xmock_deriv_tx",
      linkedAt: new Date().toISOString(),
    });

    emitSpy = vi.spyOn(pipelineTelemetry, "emit");
    auditSpy = vi.spyOn(auditService, "log");

    const service = getSettlementService();
    await service.processEvidence(makeBundle(), "job-004");

    const completed = emitSpy.mock.calls.find(
      (c) => c[0] === "job-004" && c[1] === "settlement_claim" && c[2] === "completed",
    );
    expect(completed).toBeDefined();
    expect((completed?.[3] as { metadata?: Record<string, unknown> })?.metadata?.simulated).toBe(false);

    const audit = auditSpy.mock.calls
      .map((c) => c[0] as { eventType: string; metadata?: Record<string, unknown> })
      .find((a) => a.eventType === "settlement.story_registered");
    expect(audit).toBeDefined();
    expect(audit?.metadata?.simulated).toBe(false);
  });
});
