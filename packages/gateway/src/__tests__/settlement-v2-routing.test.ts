/**
 * Tests for the V2 settlement REST path routing fix.
 *
 * Verifies that SettlementFacade routes each of the three settlement write
 * methods to the correct escrow-client function under PCC_USE_EAS_V2:
 *
 *   submitEvidenceHash:
 *     V1 (default) -> chainSubmitEvidence   (MilestoneEscrowABI)
 *     V2           -> chainSubmitEvidenceV2 (MilestoneEscrowV2ABI)
 *
 *   submitAttestation:
 *     V1 (default) -> chainSubmitAttestation   (MilestoneEscrowABI, bytes32 hash)
 *     V2           -> chainSubmitAttestationV2 (MilestoneEscrowV2ABI, bytes32 EAS UID)
 *
 *   releaseMilestone:
 *     V1 (default) -> chainReleaseMilestone   (MilestoneEscrowABI, idx only)
 *     V2           -> chainReleaseMilestoneV2 (MilestoneEscrowV2ABI, idx only)
 *
 * All chain calls are mocked — no real network traffic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Address } from "viem";

// ---------------------------------------------------------------------------
// Mocks — declared before the module under test is imported.
// ---------------------------------------------------------------------------

const mockIsWriteEnabled = vi.fn().mockReturnValue(true);

const mockSubmitEvidence = vi.fn().mockResolvedValue({
  transactionHash: "0xv1_evidence_tx",
  status: "submitted",
});
const mockSubmitEvidenceV2 = vi.fn().mockResolvedValue({
  transactionHash: "0xv2_evidence_tx",
  status: "submitted",
});
const mockSubmitAttestation = vi.fn().mockResolvedValue({
  transactionHash: "0xv1_attestation_tx",
  status: "submitted",
});
const mockSubmitAttestationV2 = vi.fn().mockResolvedValue({
  transactionHash: "0xv2_attestation_tx",
  status: "submitted",
});
const mockReleaseMilestone = vi.fn().mockResolvedValue({
  transactionHash: "0xv1_release_tx",
  status: "submitted",
});
const mockReleaseMilestoneV2 = vi.fn().mockResolvedValue({
  transactionHash: "0xv2_release_tx",
  status: "submitted",
});

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: mockSubmitEvidence,
  submitEvidenceV2: mockSubmitEvidenceV2,
  submitAttestation: mockSubmitAttestation,
  submitAttestationV2: mockSubmitAttestationV2,
  releaseMilestone: mockReleaseMilestone,
  releaseMilestoneV2: mockReleaseMilestoneV2,
  // Other V1 write operations (not under test here)
  fundEscrow: vi.fn().mockResolvedValue({ transactionHash: "0x0", status: "submitted" }),
  approveToken: vi.fn().mockResolvedValue({ transactionHash: "0x0", status: "submitted" }),
  fileDispute: vi.fn().mockResolvedValue({ transactionHash: "0x0", status: "submitted" }),
  depositBond: vi.fn().mockResolvedValue({ transactionHash: "0x0", status: "submitted" }),
  // Reads
  getEscrowState: vi.fn().mockResolvedValue({}),
  getDispute: vi.fn().mockResolvedValue({}),
  getEvents: vi.fn().mockResolvedValue([]),
  // Write guard — enabled so the facade proceeds to the chain call
  isWriteEnabled: mockIsWriteEnabled,
  getSignerAddress: vi.fn().mockReturnValue("0x3e9cf724f848908fC172a075F3219746126cD319"),
  // Status enum shims
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
  MilestoneStatusV2: { Attested: 4 },
  milestoneStatusV2Name: vi.fn().mockReturnValue("unknown"),
  IEAS_ABI: [],
}));

// Batch settlement (imported transitively by the facade)
vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({}),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn(),
  stopBatchSettlement: vi.fn(),
}));

// Chain client read helpers
vi.mock("../chain-client.js", () => ({
  readEscrow: vi.fn().mockResolvedValue({}),
  getEscrowEvents: vi.fn().mockResolvedValue([]),
  readTokenBalance: vi.fn().mockResolvedValue("0"),
  readTokenAllowance: vi.fn().mockResolvedValue("0"),
  getActiveNetwork: vi.fn().mockReturnValue("base-sepolia"),
}));

// Posthog + audit (non-critical telemetry)
vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
  shutdownPosthog: vi.fn(),
}));
vi.mock("../services/audit-service.js", () => ({
  auditService: { log: vi.fn() },
}));
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));

// SWF accrual stub
vi.mock("../routes/swf.js", () => ({
  swfAccrue: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ESCROW_V2 = "0xbC15763F646dAcb07731eC5AE5df3856974Bb293" as Address;
const EVIDENCE_HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const EAS_UID = ("0x" + "ea".repeat(32)) as `0x${string}`;
const MILESTONE_IDX = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getFacade() {
  // initStore with in-memory DB so repos are available
  const { initStore } = await import("../db.js");
  initStore({ seed: false });
  const { getSettlementFacade } = await import("../facades/index.js");
  return getSettlementFacade();
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("SettlementFacade — V2 routing (PCC_USE_EAS_V2)", () => {
  const ORIG = process.env.PCC_USE_EAS_V2;

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure write is enabled for every test (reset to default after 503 test)
    mockIsWriteEnabled.mockReturnValue(true);
  });

  afterEach(async () => {
    if (ORIG === undefined) delete process.env.PCC_USE_EAS_V2;
    else process.env.PCC_USE_EAS_V2 = ORIG;
    const { closeStore } = await import("../db.js");
    closeStore();
    // Reset module cache so the facade re-reads env on next import
    vi.resetModules();
  });

  // ── submitEvidenceHash ────────────────────────────────────────────────────

  describe("submitEvidenceHash", () => {
    it("routes to chainSubmitEvidence (V1) when PCC_USE_EAS_V2 is unset", async () => {
      delete process.env.PCC_USE_EAS_V2;
      const facade = await getFacade();
      const result = await facade.submitEvidenceHash(
        ESCROW_V2, MILESTONE_IDX, EVIDENCE_HASH,
      );
      expect(result.success).toBe(true);
      expect(mockSubmitEvidence).toHaveBeenCalledOnce();
      expect(mockSubmitEvidenceV2).not.toHaveBeenCalled();
      expect(mockSubmitEvidence).toHaveBeenCalledWith(
        MILESTONE_IDX, EVIDENCE_HASH, ESCROW_V2,
      );
    });

    it("routes to chainSubmitEvidenceV2 (V2 ABI) when PCC_USE_EAS_V2=true", async () => {
      process.env.PCC_USE_EAS_V2 = "true";
      const facade = await getFacade();
      const result = await facade.submitEvidenceHash(
        ESCROW_V2, MILESTONE_IDX, EVIDENCE_HASH,
      );
      expect(result.success).toBe(true);
      expect(mockSubmitEvidenceV2).toHaveBeenCalledOnce();
      expect(mockSubmitEvidence).not.toHaveBeenCalled();
      expect(mockSubmitEvidenceV2).toHaveBeenCalledWith(
        MILESTONE_IDX, EVIDENCE_HASH, ESCROW_V2,
      );
    });
  });

  // ── submitAttestation ────────────────────────────────────────────────────

  describe("submitAttestation", () => {
    it("routes to chainSubmitAttestation (V1) when PCC_USE_EAS_V2 is unset", async () => {
      delete process.env.PCC_USE_EAS_V2;
      const facade = await getFacade();
      const result = await facade.submitAttestation(
        ESCROW_V2, MILESTONE_IDX, EAS_UID,
      );
      expect(result.success).toBe(true);
      expect(mockSubmitAttestation).toHaveBeenCalledOnce();
      expect(mockSubmitAttestationV2).not.toHaveBeenCalled();
      expect(mockSubmitAttestation).toHaveBeenCalledWith(
        MILESTONE_IDX, EAS_UID, ESCROW_V2,
      );
    });

    it("routes to chainSubmitAttestationV2 (EAS UID binding) when PCC_USE_EAS_V2=true", async () => {
      process.env.PCC_USE_EAS_V2 = "true";
      const facade = await getFacade();
      const result = await facade.submitAttestation(
        ESCROW_V2, MILESTONE_IDX, EAS_UID,
      );
      expect(result.success).toBe(true);
      expect(mockSubmitAttestationV2).toHaveBeenCalledOnce();
      expect(mockSubmitAttestation).not.toHaveBeenCalled();
      // V2: submitAttestationV2(milestoneIndex, easUid, contractAddress)
      expect(mockSubmitAttestationV2).toHaveBeenCalledWith(
        MILESTONE_IDX, EAS_UID, ESCROW_V2,
      );
    });

    it("returns 503 when write is disabled regardless of V2 flag", async () => {
      process.env.PCC_USE_EAS_V2 = "true";
      mockIsWriteEnabled.mockReturnValue(false);
      const facade = await getFacade();
      const result = await facade.submitAttestation(
        ESCROW_V2, MILESTONE_IDX, EAS_UID,
      );
      expect(result.success).toBe(false);
      expect((result as any).error.httpStatus).toBe(503);
      expect(mockSubmitAttestationV2).not.toHaveBeenCalled();
      expect(mockSubmitAttestation).not.toHaveBeenCalled();
    });
  });

  // ── releaseMilestone ─────────────────────────────────────────────────────

  describe("releaseMilestone", () => {
    it("routes to chainReleaseMilestone (V1) when PCC_USE_EAS_V2 is unset", async () => {
      delete process.env.PCC_USE_EAS_V2;
      const facade = await getFacade();
      const result = await facade.releaseMilestone(
        ESCROW_V2, MILESTONE_IDX,
      );
      expect(result.success).toBe(true);
      expect(mockReleaseMilestone).toHaveBeenCalledOnce();
      expect(mockReleaseMilestoneV2).not.toHaveBeenCalled();
      expect(mockReleaseMilestone).toHaveBeenCalledWith(
        MILESTONE_IDX, ESCROW_V2,
      );
    });

    it("routes to chainReleaseMilestoneV2 (index-only, V2) when PCC_USE_EAS_V2=true", async () => {
      process.env.PCC_USE_EAS_V2 = "true";
      const facade = await getFacade();
      const result = await facade.releaseMilestone(
        ESCROW_V2, MILESTONE_IDX,
      );
      expect(result.success).toBe(true);
      expect(mockReleaseMilestoneV2).toHaveBeenCalledOnce();
      expect(mockReleaseMilestone).not.toHaveBeenCalled();
      // V2: releaseMilestoneV2(milestoneIndex, contractAddress)
      expect(mockReleaseMilestoneV2).toHaveBeenCalledWith(
        MILESTONE_IDX, ESCROW_V2,
      );
    });
  });
});
