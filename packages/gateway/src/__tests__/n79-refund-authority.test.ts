/**
 * N79 x N85 (steward #4218): a status write gives an escrow back only when its writer is entitled to.
 *
 * Run through the real API gate, with real API keys.
 * - The operator relay (POST /api/operator/job-status) has no owner check on master (N85): any authenticated key
 *   can report any job failed. Such a report may mark the job, but it must NOT give the escrow back. Otherwise one
 *   key could refund anyone's escrow and lock the operator out of the payout for good, since every release path
 *   refuses a given-back escrow. The refund on a relay report waits on N85's owner check.
 * - PATCH /api/jobs/:id/status: a buyer must never give the escrow back after execution started. Today the route
 *   refuses every authenticated caller: its owner check compares `job.submittedBy` and `kernel.operatorId`, columns
 *   that don't exist. This pins the OUTCOME, whatever the route admits later.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_auth" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_auth_enc" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

// A production control-plane gateway has no local kernel: jobs dispatch to a remote operator node.
vi.mock("../services/kernel-service.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/kernel-service.js")>();
  return {
    ...actual,
    getKernelService: vi.fn(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    }),
  };
});

import { apiGate } from "../middleware/api-gate.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { jobRoutes } from "../routes/jobs.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema } from "@pcc/store";
import { NON_RELEASABLE_ESCROW_STATUSES } from "../services/escrow-refund.js";

const BUYER = "0x00000000000000000000000000000000000b0b01";

/** A job on a seeded kernel, at `status`, with a negotiated session and a funded mock escrow. */
function seedPaidJob(jobId: string, status: string) {
  const repos = getRepos();
  const capability = repos.capabilities.findAll()[0];
  if (!capability) throw new Error("the seeded store has no capability");
  const kernel = repos.kernels.findById(capability.kernelId);
  if (!kernel) throw new Error("the seeded capability has no kernel");
  const cwmId = `cwm-${jobId}`;
  const now = new Date().toISOString();
  repos.jobs.insert({
    id: jobId,
    stepId: "step-1",
    cwmId,
    capabilityId: capability.id,
    kernelId: kernel.id,
    status,
    assignedDevices: [],
  });
  getStore()
    .db.insert(schema.negotiationSessions)
    .values({
      id: `sess-${jobId}`,
      status: "committed",
      userAgentId: BUYER,
      kernelId: kernel.id,
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
    contractAddress: `mock-escrow-${jobId}`,
    payer: BUYER,
    totalAmount: "10.00",
    currency: "USDC",
    status: "funded",
    createdAt: now,
    deadline: now,
  });
  repos.escrows.insertMilestone({
    id: `ms-${jobId}`,
    escrowId: escrow!.id,
    stepId: "step-1",
    amount: "10.00",
    status: "funded",
    bondAmount: "0",
  });
  return { escrowId: escrow!.id, operatorAddress: kernel.operatorAddress };
}

function expectStillFunded(escrowId: string) {
  const repos = getRepos();
  const escrow = repos.escrows.findById(escrowId)!;
  expect(escrow.status).toBe("funded");
  expect(repos.escrows.findMilestonesByEscrow(escrowId).map((m) => m.status)).toEqual(["funded"]);
  // ...so no release path refuses the operator's payout once the job is put right.
  expect(NON_RELEASABLE_ESCROW_STATUSES.has(escrow.status)).toBe(false);
}

describe("N79 x N85: only a writer entitled to give the escrow back can trigger the refund", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.MOCK_SETTLEMENT = "true";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(apiGate);
    await app.register(operatorRelayRoutes);
    await app.register(jobRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("a relay report from a key that does not operate the job's kernel marks the job but gives nothing back", async () => {
    const { escrowId } = seedPaidJob("job-n85-grief", "in_progress");
    const attacker = provisionApiKey({ operatorId: "operator-attacker" }).rawKey;
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/job-status",
      headers: { authorization: `Bearer ${attacker}` },
      payload: { jobId: "job-n85-grief", status: "failed" },
    });
    // N85 (WP-C's): the relay still accepts a report from any key. The status write is not this PR's to close.
    expect(res.statusCode).toBe(200);
    expectStillFunded(escrowId);
  });

  it("until N85's owner check lands, even the operator's own relay report gives nothing back (the relay can't tell who reports)", async () => {
    const { escrowId, operatorAddress } = seedPaidJob("job-n85-own", "in_progress");
    const owner = provisionApiKey({ operatorId: operatorAddress }).rawKey;
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/job-status",
      headers: { authorization: `Bearer ${owner}` },
      payload: { jobId: "job-n85-own", status: "failed" },
    });
    expect(res.statusCode).toBe(200);
    expect(getRepos().jobs.findById("job-n85-own")?.status).toBe("failed");
    expectStillFunded(escrowId);
  });

  it("a buyer's cancel after execution started never gives the escrow back, whatever PATCH answers", async () => {
    const { escrowId } = seedPaidJob("job-n79-buyer-late", "in_progress");
    const buyer = provisionApiKey({ operatorId: BUYER }).rawKey;
    await app.inject({
      method: "PATCH",
      url: "/api/jobs/job-n79-buyer-late/status",
      headers: { authorization: `Bearer ${buyer}` },
      payload: { status: "cancelled" },
    });
    expectStillFunded(escrowId);
  });
});
