/**
 * N79: the job-level release (SettlementService.releaseMilestone, behind POST /api/settlement/release and the
 * automatic release after a local job's evidence) never releases an escrow the gateway has given back, and never
 * reports its job settled. It checks the job's own escrow and the escrow named by contractAddress, in any letter case.
 *
 * The chain is mocked: a call to the V1 release means the request reached the chain layer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getAddress } from "viem";

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_release" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_release_enc" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../contracts/escrow-client.js")>();
  return {
    ...actual,
    isWriteEnabled: vi.fn(() => true),
    releaseMilestone: vi.fn(async () => ({ transactionHash: "0xrelease-v1" })),
  };
});

import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema } from "@pcc/store";
import { getSettlementService } from "../services/settlement-service.js";
import { settlementRoutes } from "../routes/settlement.js";
import * as chain from "../contracts/escrow-client.js";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const release = vi.mocked(chain.releaseMilestone);

/** A job whose negotiated session links it to an escrow at `contractAddress` with the given status. */
function seedJobWithEscrow(jobId: string, contractAddress: string, escrowStatus: string) {
  const repos = getRepos();
  const capability = repos.capabilities.findAll()[0];
  if (!capability) throw new Error("the seeded store has no capability");
  const cwmId = `cwm-${jobId}`;
  const now = new Date().toISOString();
  repos.jobs.insert({
    id: jobId,
    stepId: "step-1",
    cwmId,
    capabilityId: capability.id,
    kernelId: capability.kernelId,
    status: "failed",
    assignedDevices: [],
  });
  getStore()
    .db.insert(schema.negotiationSessions)
    .values({
      id: `sess-${jobId}`,
      status: "committed",
      userAgentId: "user-n79-release",
      kernelId: capability.kernelId,
      capabilityType: capability.type,
      operatorConstraints: {},
      jobId,
      cwmId,
      createdAt: now,
      expiresAt: now,
    })
    .run();
  const escrow = repos.escrows.insert({
    id: `esc-${jobId}`,
    cwmId,
    contractAddress,
    payer: "0x0000000000000000000000000000000000000001",
    totalAmount: "10.00",
    currency: "USDC",
    status: escrowStatus,
    createdAt: now,
    deadline: now,
    version: "v2",
  });
  repos.escrows.insertMilestone({
    id: `ms-${jobId}`,
    escrowId: escrow!.id,
    stepId: "step-1",
    amount: "10.00",
    status: escrowStatus,
    bondAmount: "0",
  });
}

const attestationFor = (escrowAddress: string) =>
  ({ escrowAddress, evidenceHash: `0x${"cd".repeat(32)}` }) as unknown as Parameters<
    ReturnType<typeof getSettlementService>["releaseMilestone"]
  >[2];

beforeEach(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  release.mockClear();
});

afterEach(() => {
  closeStore();
});

describe("N79: the job-level release refuses an escrow that was given back", () => {
  it("the job's own escrow is refund_pending: nothing is released and the job is not reported settled", async () => {
    const A = addr(0xa001);
    seedJobWithEscrow("job-n79-rel-pending", A, "refund_pending");
    const r = await getSettlementService().releaseMilestone("job-n79-rel-pending", 0, attestationFor(A), A);
    expect(r).toEqual(expect.objectContaining({ status: "failed", error: "escrow_refunded" }));
    expect(release).not.toHaveBeenCalled();
    expect(getRepos().jobs.findById("job-n79-rel-pending")?.status).toBe("failed");
  });

  it("the job's own escrow is refunded and no address is named (the default applies): refused by the job", async () => {
    const A = addr(0xa002);
    seedJobWithEscrow("job-n79-rel-refunded", A, "refunded");
    const saved = process.env.ESCROW_CONTRACT_ADDRESS;
    process.env.ESCROW_CONTRACT_ADDRESS = A;
    try {
      const r = await getSettlementService().releaseMilestone("job-n79-rel-refunded", 0, attestationFor(A));
      expect(r).toEqual(expect.objectContaining({ status: "failed", error: "escrow_refunded" }));
      expect(release).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.ESCROW_CONTRACT_ADDRESS;
      else process.env.ESCROW_CONTRACT_ADDRESS = saved;
    }
  });

  it("the NAMED escrow was given back, even though the job's own is live, and named in lowercase: refused", async () => {
    const LIVE = addr(0xa003);
    const GIVEN_BACK = addr(0xa004);
    seedJobWithEscrow("job-n79-rel-live", LIVE, "funded");
    seedJobWithEscrow("job-n79-rel-other", GIVEN_BACK, "refund_pending");
    const lower = GIVEN_BACK.toLowerCase();
    const r = await getSettlementService().releaseMilestone("job-n79-rel-live", 0, attestationFor(lower), lower);
    expect(r).toEqual(expect.objectContaining({ status: "failed", error: "escrow_refunded" }));
    expect(release).not.toHaveBeenCalled();
  });

  it("the job's OWN escrow was given back, even though the named escrow is live: refused, the job is not settled", async () => {
    const GIVEN_BACK = addr(0xa007);
    const LIVE = addr(0xa008);
    seedJobWithEscrow("job-n79-rel-own", GIVEN_BACK, "refund_pending");
    seedJobWithEscrow("job-n79-rel-bystander", LIVE, "funded");
    const r = await getSettlementService().releaseMilestone("job-n79-rel-own", 0, attestationFor(LIVE), LIVE);
    expect(r).toEqual(expect.objectContaining({ status: "failed", error: "escrow_refunded" }));
    expect(release).not.toHaveBeenCalled();
    expect(getRepos().jobs.findById("job-n79-rel-own")?.status).toBe("failed");
  });

  it("a live escrow is still released (the guard is specific)", async () => {
    const LIVE = addr(0xa005);
    seedJobWithEscrow("job-n79-rel-ok", LIVE, "funded");
    const r = await getSettlementService().releaseMilestone("job-n79-rel-ok", 0, attestationFor(LIVE), LIVE);
    expect(r).toEqual(expect.objectContaining({ status: "released" }));
    expect(release).toHaveBeenCalledTimes(1);
    expect(getRepos().jobs.findById("job-n79-rel-ok")?.status).toBe("settled");
  });

  it("POST /api/settlement/release refuses it at once, without retrying the refusal", async () => {
    const A = addr(0xa006);
    seedJobWithEscrow("job-n79-rel-route", A, "refund_pending");
    const service = getSettlementService();
    const spy = vi.spyOn(service, "releaseMilestone");
    const app: FastifyInstance = Fastify({ logger: false });
    await app.register(settlementRoutes);
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/settlement/release",
        payload: { jobId: "job-n79-rel-route", milestoneIndex: 0, contractAddress: A, attestation: attestationFor(A) },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual(expect.objectContaining({ error: "release_failed", message: "escrow_refunded" }));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      expect(getRepos().jobs.findById("job-n79-rel-route")?.status).toBe("failed");
    } finally {
      spy.mockRestore();
      await app.close();
    }
  });
});
