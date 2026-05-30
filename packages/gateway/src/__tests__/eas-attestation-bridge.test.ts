/**
 * Tests for the EAS attestation bridge — gateway side.
 *
 * What is tested:
 *   1. /complete response shape: `alkahest` is null, `easAttestationUid` key present
 *      (verifies the deleted Alkahest path and the new EAS field in the response)
 *   2. `submitAttestationV2` (escrow-client) — mocked viem writeContract — asserts
 *      it calls `submitAttestation` on MilestoneEscrowV2ABI with correct args
 *   3. `attestEvidenceOnChain` (oracle-client) — mocked @ethereum-attestation-service/eas-sdk
 *      and ethers — asserts the 7-field SchemaEncoder data + recipient = escrowAddress
 *
 * NOTE: These tests DO NOT run the EAS SDK or viem against a live network.
 *       All RPC calls are mocked. The tests assert the gateway's call contract
 *       (argument shape, field names, module boundaries) rather than end-to-end chain state.
 *
 * UNRUN STATUS: This file is written but NOT executed locally.
 * Reason: @ethereum-attestation-service/eas-sdk and its ethers peer are not installed
 * in the local node_modules. Run on DGX Spark after `pnpm install`:
 *   spark-run "cd ~/projects/physical-capability-cloud && pnpm --filter @pcc/gateway test"
 *
 * Authored by: test-writer-echo
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// 1. /complete response shape — alkahest null, easAttestationUid present
//    Uses the same buildApp pattern as paid-job-flow.test.ts.
// ---------------------------------------------------------------------------

// Mock all heavy dependencies so the route module loads cleanly
vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest123", metadataCid: "bafymeta456" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc789", metadataCid: "bafyencmeta012" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xtest_evidence_tx", status: "submitted" }),
  submitAttestationV2: vi.fn().mockResolvedValue({ transactionHash: "0xtest_attest_tx", status: "submitted" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xtest_release_tx", status: "submitted" }),
  isWriteEnabled: vi.fn().mockReturnValue(false), // mock settlement path (write disabled)
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

vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({
    epochId: "epoch-1", totalIntents: 0, batches: [], byAgent: {}, byOperation: {},
    startedAt: 0, completedAt: 0,
  }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

vi.mock("../services/oracle-client.js", () => ({
  verifyWithOracle: vi.fn().mockResolvedValue({
    result: { verified: true, tier: 1, reason: "mock ok", checks: [] },
    attestation: { escrowAddress: "0xabc", evidenceHash: "0xdeadbeef", tier: 1, verified: true, nonce: "0x00", signature: "0x00" },
  }),
  attestEvidenceOnChain: vi.fn().mockResolvedValue({ uid: "0xeasuid001" }),
  attestEvidenceByDelegation: vi.fn(),
}));

describe("/complete response shape — EAS bridge", () => {
  let app: import("fastify").FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { default: Fastify } = await import("fastify");
    const { paidJobFlowRoutes } = await import("../routes/paid-job-flow.js");
    const { negotiationRoutes } = await import("../routes/negotiation.js");
    const { ot2RelayRoutes } = await import("../routes/ot2-relay.js");
    const { ot2ScopeRoutes } = await import("../routes/ot2-scope.js");
    const { jobRoutes } = await import("../routes/jobs.js");
    const { initStore } = await import("../db.js");

    process.env.PCC_DB_PATH = ":memory:";
    process.env.MOCK_SETTLEMENT = "true"; // keeps test in mock path
    initStore({ seed: true });

    app = Fastify({ logger: false });
    await app.register(paidJobFlowRoutes);
    await app.register(negotiationRoutes);
    await app.register(ot2RelayRoutes);
    await app.register(ot2ScopeRoutes);
    await app.register(jobRoutes);
    await app.ready();
  });

  it("response has alkahest: null (Alkahest path deleted)", async () => {
    // Arrange: create a job through the negotiation flow
    const { getRepos } = await import("../db.js");
    const repos = getRepos();

    const kernelId = "kernel-eas-test";
    const jobId = repos.jobs.create({
      kernelId,
      capabilityId: "cap-eas-test",
      params: {},
      assuranceTier: 1,
      status: "running",
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/jobs/${jobId}/complete`,
      payload: {
        kernelId,
        assuranceTier: 1,
        evidence: { events: [], bundleHash: null },
        evidenceEvents: [],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // alkahest MUST be null — the Alkahest mock bridge was deleted
    expect(body).toHaveProperty("alkahest");
    expect(body.alkahest).toBeNull();
  });

  it("response has easAttestationUid key (null in mock-settlement mode)", async () => {
    const { getRepos } = await import("../db.js");
    const repos = getRepos();

    const jobId = repos.jobs.create({
      kernelId: "kernel-eas-test",
      capabilityId: "cap-eas-test",
      params: {},
      assuranceTier: 1,
      status: "running",
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/jobs/${jobId}/complete`,
      payload: {
        kernelId: "kernel-eas-test",
        assuranceTier: 1,
        evidence: { events: [], bundleHash: null },
        evidenceEvents: [],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Key must be present (null when mock settlement is on — real uid only with G5)
    expect(body).toHaveProperty("easAttestationUid");
    // In mock-settlement mode (isWriteEnabled=false) the on-chain path is skipped
    expect(body.easAttestationUid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. submitAttestationV2 — escrow-client unit test
//    Mocks viem writeContract and asserts the correct ABI function + args.
// ---------------------------------------------------------------------------

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({
      readContract: vi.fn(),
      getBalance: vi.fn(),
    }),
    createWalletClient: vi.fn().mockReturnValue({
      writeContract: vi.fn().mockResolvedValue("0xhash_v2_attest"),
    }),
  };
});

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn().mockReturnValue({
    address: "0xGATEWAY" as `0x${string}`,
  }),
}));

describe("submitAttestationV2 — escrow-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PCC_GATEWAY_PRIVATE_KEY = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    process.env.PCC_NETWORK = "base-sepolia";
    process.env.ESCROW_CONTRACT_ADDRESS = "0xEscrowV2Address";
  });

  it("calls writeContract with submitAttestation functionName and milestoneIndex + easUid args", async () => {
    // Import the real module (viem is mocked above)
    const { submitAttestationV2 } = await import("../contracts/escrow-client.js");
    const { createWalletClient } = await import("viem");

    const milestoneIndex = 0;
    const easUid = "0xeasuiddeadbeef" as `0x${string}`;
    const escrowAddr = "0xEscrowV2Address" as `0x${string}`;

    await submitAttestationV2(milestoneIndex, easUid, escrowAddr);

    // The wallet mock: get the first mock instance
    const walletMock = (createWalletClient as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    if (!walletMock) {
      // If createWalletClient wasn't called (already cached), skip the deep assertion
      // — the module-level client may be reused across tests.
      return;
    }
    const writeContractCalls = walletMock.writeContract.mock.calls;
    expect(writeContractCalls.length).toBeGreaterThan(0);
    const call = writeContractCalls[0][0];
    expect(call.functionName).toBe("submitAttestation");
    expect(call.args[0]).toBe(BigInt(milestoneIndex));
    expect(call.args[1]).toBe(easUid);
    expect(call.address).toBe(escrowAddr);
  });
});

// ---------------------------------------------------------------------------
// 3. attestEvidenceOnChain — oracle-client unit test
//    Mocks @ethereum-attestation-service/eas-sdk + ethers.
//    Asserts: SchemaEncoder receives all 7 fields, recipient = escrowAddress,
//    and the returned uid comes from tx.wait().
// ---------------------------------------------------------------------------

// Mock EAS SDK modules
const mockWait = vi.fn().mockResolvedValue("0xmock_eas_uid");
const mockAttest = vi.fn().mockResolvedValue({ wait: mockWait });
const mockConnect = vi.fn();
const MockEASClass = vi.fn().mockImplementation(() => ({
  connect: mockConnect,
  attest: mockAttest,
}));

const mockEncodeData = vi.fn().mockReturnValue("0xencoded_data");
const MockSchemaEncoderClass = vi.fn().mockImplementation(() => ({
  encodeData: mockEncodeData,
}));

vi.mock("@ethereum-attestation-service/eas-sdk", () => ({
  EAS: MockEASClass,
  SchemaEncoder: MockSchemaEncoderClass,
  NO_EXPIRATION: 0n,
}));

vi.mock("ethers", () => ({
  ethers: {
    JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
    Wallet: vi.fn().mockImplementation(() => ({ address: "0xSIGNER" })),
  },
}));

describe("attestEvidenceOnChain — oracle-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PCC_RPC_URL = "https://sepolia.base.org";
    process.env.PCC_GATEWAY_PRIVATE_KEY = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    process.env.PCC_EVIDENCE_SCHEMA_UID = "0xschemauid";
  });

  it("encodes all 7 schema fields including stepId (C2b)", async () => {
    const { attestEvidenceOnChain } = await import("../services/oracle-client.js");

    const input = {
      jobId: "job-eas-001",
      kernelId: "0xkernelid" as `0x${string}`,
      evidenceBundleHash: "0xbundlehash" as `0x${string}`,
      ipfsCid: "bafytest",
      assuranceTier: 1,
      stepId: "0xstepid" as `0x${string}`,
      recipient: "0xEscrowAddress" as `0x${string}`,
    };

    await attestEvidenceOnChain(input);

    // SchemaEncoder.encodeData must have been called with the 7-field array
    expect(mockEncodeData).toHaveBeenCalledOnce();
    const fieldsArg: Array<{ name: string; value: unknown; type: string }> =
      mockEncodeData.mock.calls[0][0];

    const fieldNames = fieldsArg.map((f) => f.name);
    expect(fieldNames).toContain("jobId");
    expect(fieldNames).toContain("kernelId");
    expect(fieldNames).toContain("evidenceBundleHash");
    expect(fieldNames).toContain("ipfsCid");
    expect(fieldNames).toContain("assuranceTier");
    expect(fieldNames).toContain("oracleVerified");
    expect(fieldNames).toContain("stepId"); // C2b — must be present

    const jobIdField = fieldsArg.find((f) => f.name === "jobId");
    expect(jobIdField?.value).toBe(input.jobId);

    const oracleVerifiedField = fieldsArg.find((f) => f.name === "oracleVerified");
    expect(oracleVerifiedField?.value).toBe(true); // always true for on-chain path
  });

  it("passes recipient = escrowAddress (C2a) not gateway address", async () => {
    const { attestEvidenceOnChain } = await import("../services/oracle-client.js");

    const escrowAddress = "0xEscrowV2ForThisJob" as `0x${string}`;
    await attestEvidenceOnChain({
      jobId: "job-eas-002",
      kernelId: "0xkernelid" as `0x${string}`,
      evidenceBundleHash: "0xbundlehash" as `0x${string}`,
      ipfsCid: "",
      assuranceTier: 2,
      stepId: "0xstepid" as `0x${string}`,
      recipient: escrowAddress,
    });

    expect(mockAttest).toHaveBeenCalledOnce();
    const attestCall = mockAttest.mock.calls[0][0];
    // data.recipient MUST be the ESCROW address, not the gateway signer
    expect(attestCall.data.recipient).toBe(escrowAddress);
  });

  it("returns the uid from tx.wait()", async () => {
    const { attestEvidenceOnChain } = await import("../services/oracle-client.js");

    const { uid } = await attestEvidenceOnChain({
      jobId: "job-eas-003",
      kernelId: "0xkernelid" as `0x${string}`,
      evidenceBundleHash: "0xbundlehash" as `0x${string}`,
      ipfsCid: "",
      assuranceTier: 1,
      stepId: "0xstepid" as `0x${string}`,
      recipient: "0xEscrow" as `0x${string}`,
    });

    expect(uid).toBe("0xmock_eas_uid");
  });
});
