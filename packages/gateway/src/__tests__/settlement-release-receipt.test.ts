/**
 * A broadcast is not a release (astra A07b, #385 round 3): SettlementService.releaseMilestone reports a
 * milestone released, and marks its job settled, only when the release transaction's receipt shows
 * success. A reverted release is failed; one whose receipt did not arrive stays submitted, with its hash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OracleAttestation } from "@pcc/contracts";
import { SettlementService, resetSettlementService } from "../services/settlement-service.js";
import { closeStore, getRepos, initStore } from "../db.js";

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
