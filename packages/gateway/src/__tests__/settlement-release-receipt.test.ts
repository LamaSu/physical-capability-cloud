/**
 * A broadcast is not a release (astra A07b, #385 round 3): SettlementService.releaseMilestone reports a
 * milestone released, and marks its job settled, only when the release transaction's receipt shows
 * success. A reverted release is failed; one whose receipt did not arrive stays submitted, with its hash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OracleAttestation } from "@pcc/contracts";
import { SettlementService, resetSettlementService } from "../services/settlement-service.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { getSettlementFacade } from "../facades/index.js";
import { pipelineTelemetry } from "../telemetry.js";
import { auditService } from "../services/audit-service.js";

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn(),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xrelease", status: "submitted" }),
  waitForReceipt: vi.fn(),
  isWriteEnabled: vi.fn().mockReturnValue(true),
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
}));

const ESCROW = "0xDeAdBeEf00000000000000000000000000000001";
const attestation = { escrowAddress: ESCROW } as unknown as OracleAttestation;

describe("releaseMilestone reports what the chain did, not what was broadcast (astra A07b)", () => {
  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    resetSettlementService();
    getRepos().jobs.insert({ id: "job-rcpt", stepId: "step-rcpt", cwmId: "cwm-rcpt", capabilityId: "cap-nyc-fdm", kernelId: "kernel-nyc", status: "completed", assignedDevices: [], progress: 100 });
  });

  afterEach(() => {
    closeStore();
    resetSettlementService();
    vi.clearAllMocks();
  });

  const release = () => new SettlementService().releaseMilestone("job-rcpt", 0, attestation, ESCROW);
  const jobStatus = () => getRepos().jobs.findById("job-rcpt")!.status;

  it("a reverted release is failed, and the job is not settled", async () => {
    const escrow = await import("../contracts/escrow-client.js");
    vi.mocked(escrow.waitForReceipt).mockResolvedValue({ status: "reverted", blockNumber: 7 });
    const r = await release();
    expect([r.status, r.error, r.txHash]).toEqual(["failed", "release_reverted", "0xrelease"]);
    expect(jobStatus()).toBe("completed");
  });

  it("a release whose receipt did not arrive, or could not be read, stays submitted and the job is not settled", async () => {
    const escrow = await import("../contracts/escrow-client.js");
    const outcomes = [
      () => vi.mocked(escrow.waitForReceipt).mockResolvedValueOnce({ status: "timeout", blockNumber: 0 }),
      () => vi.mocked(escrow.waitForReceipt).mockRejectedValueOnce(new Error("rpc down")),
    ];
    for (const next of outcomes) {
      next();
      const r = await release();
      expect([r.status, r.error, r.txHash]).toEqual(["submitted", "release_unconfirmed", "0xrelease"]);
      expect(jobStatus()).toBe("completed");
    }
  });

  it("a release whose receipt shows success is released, and only then is the job settled", async () => {
    const escrow = await import("../contracts/escrow-client.js");
    vi.mocked(escrow.waitForReceipt).mockResolvedValue({ status: "success", blockNumber: 7 });
    const r = await release();
    expect([r.status, r.txHash]).toEqual(["released", "0xrelease"]);
    expect(escrow.waitForReceipt).toHaveBeenCalledWith("0xrelease");
    expect(jobStatus()).toBe("settled");
  });
});

describe("SettlementFacade.releaseMilestone records a release only on a successful receipt (astra A07c F4)", () => {
  const ADDRESS = "0x00000000000000000000000000000000000e5c01";

  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
  });

  // Only this block's spies are restored: restoring every mock would also wipe the escrow-client module mock.
  let spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    closeStore();
    for (const spy of spies) spy.mockRestore();
    spies = [];
    vi.clearAllMocks();
  });

  /** What the facade announced: completion telemetry and the escrow.released audit event. */
  const announced = () => ({
    completed: vi.mocked(pipelineTelemetry.emit).mock.calls.filter(([, phase, status]) => phase === "settlement_complete" && status === "completed").length,
    released: vi.mocked(auditService.log).mock.calls.filter(([event]) => event.eventType === "escrow.released").length,
  });
  const release = async (receipt: () => void) => {
    spies = [vi.spyOn(pipelineTelemetry, "emit"), vi.spyOn(auditService, "log")];
    receipt();
    return getSettlementFacade().releaseMilestone(ADDRESS, 0, attestation, "operator-1");
  };

  it("an unconfirmed release is submitted, and announces no completion and no release", async () => {
    const escrow = await import("../contracts/escrow-client.js");
    const r = await release(() => vi.mocked(escrow.waitForReceipt).mockResolvedValueOnce({ status: "timeout", blockNumber: 0 }));
    expect(r.success).toBe(true);
    expect((r as { data: { status: string; transactionHash?: string } }).data).toEqual(expect.objectContaining({ status: "submitted", transactionHash: "0xrelease" }));
    expect(announced()).toEqual({ completed: 0, released: 0 });
  });

  it("a reverted release fails, and announces no completion and no release", async () => {
    const escrow = await import("../contracts/escrow-client.js");
    const r = await release(() => vi.mocked(escrow.waitForReceipt).mockResolvedValueOnce({ status: "reverted", blockNumber: 7 }));
    expect(r.success).toBe(false);
    expect((r as { error: { message: string } }).error.message).toMatch(/reverted/);
    expect(announced()).toEqual({ completed: 0, released: 0 });
  });

  it("a release whose receipt shows success is released, and announced once", async () => {
    const escrow = await import("../contracts/escrow-client.js");
    const r = await release(() => vi.mocked(escrow.waitForReceipt).mockResolvedValueOnce({ status: "success", blockNumber: 7 }));
    expect(r.success).toBe(true);
    expect((r as { data: { status: string } }).data.status).toBe("released");
    expect(announced()).toEqual({ completed: 1, released: 1 });
  });
});
