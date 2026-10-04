/**
 * Tests for the paid job flow — end-to-end wiring from discovery through settlement.
 *
 * Flow: DHT discovery -> negotiation -> escrow -> scope -> execution -> evidence -> settlement
 *
 * ALL external calls (IPFS, blockchain) are mocked. No real network traffic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { deviceRelayRoutes } from "../routes/device-relay.js";
import { jobRoutes } from "../routes/jobs.js";
import { operatorRoutes } from "../routes/operator.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { actAsJobParty } from "./helpers/job-read-party.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xtest_release_tx", status: "submitted" }),
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

vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "epoch-1", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

// The PUT /api/jobs/:jobId/complete flow does best-effort IPFS archive +
// Starknet anchor + oracle verification I/O (all mock/fallback here) that can
// exceed vitest's 5s default on constrained/CI machines. Give the suite headroom
// so these I/O-heavy paths don't flake on timing.
vi.setConfig({ testTimeout: 20000 });

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  // Enable mock settlement for testing
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  // Stand-in for apiGate: an API key sets operatorId and userId.
  app.decorateRequest("operatorId", null);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.addHook("onRequest", async (req) => {
    const key = req.headers["x-test-key"];
    if (typeof key === "string") {
      req.operatorId = key;
      req.userId = key as `0x${string}`;
    }
  });
  // Job reads are object-authorized (#382, readmodels F3). This runs after the stand-in above,
  // so a request with x-test-key keeps that operator; one without it reads as the seeded
  // kernel-nyc operator.
  actAsJobParty(app);
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  // The legacy OT-2 relay is retired (N4b-gw); tool calls go through
  // /api/relay/:kernelId as the scope's holder, and every relay call a holder
  // makes is as the PROVEN holder (DECISIONS 00:42 and 00:53; buyer below).
  await app.register(deviceRelayRoutes);
  await app.register(jobRoutes);
  // N133: the kernel operator's decision on a paid job's scope (POST /api/operator/scopes/:scopeId/accept).
  await app.register(operatorRoutes);
  await app.ready();
  return app;
}

/** Headers for a principal, e.g. the buyer agent holding the job's scope. */
const asKey = (id: string) => ({ "x-test-key": id });

// DECISIONS 00:42 (the steward's #6690, f6359711): a scope holder's write tool call needs an
// AUTHENTIC holder, a buyer wallet the caller PROVED that holds the active scope the call names.
// The same address merely claimed through an API key is refused (operator_proof_required).
// DECISIONS 00:53 (#6711) extends the proof to the holder's other relay calls (safe calls, scope
// and result reads), so every relay call a holder makes here is as the proven holder.
//
// buyer(tag) is a buyer agent's wallet, all lowercase: the stand-in gate (actAsJobParty) proves
// a wallet principal lowercased (provenWalletFor), and the relay compares the scope's createdBy
// exactly with the proven wallet (the guard) and with the caller's principal (the handler). The
// job is submitted with userAgentId = that wallet, so the gateway mints the scope for it.
const buyer = (tag: string) => `0x${"b".repeat(40 - tag.length)}${tag}`;
/** The same address on an API key without proof: a claim only. */
const claimedOnly = (wallet: string) => ({ ...asKey(wallet), "x-test-proven-wallet": "none" });

/**
 * The buyer's address merely claimed (an API key, no proof) is refused its scoped write, 403
 * operator_proof_required, and queues and spends nothing: no relay row under the scope, and
 * the scope's command count unchanged.
 */
async function expectClaimedOnlyWriteRefused(
  app: FastifyInstance,
  wallet: string,
  payload: { scopeId: string; toolName: string; args?: Record<string, unknown> },
) {
  const { db } = getStore();
  const rows = () => db.select().from(schema.toolCallRelay).where(eq(schema.toolCallRelay.scopeId, payload.scopeId)).all();
  const spent = () => db.select().from(schema.executionScopes).where(eq(schema.executionScopes.id, payload.scopeId)).get()!.commandCount;
  const rowsBefore = rows().length;
  const spentBefore = spent();
  const res = await app.inject({ method: "POST", url: "/api/relay/kernel-nyc/tool-call", headers: claimedOnly(wallet), payload });
  expect(res.statusCode).toBe(403);
  expect(res.json().reason).toBe("operator_proof_required");
  expect(rows()).toHaveLength(rowsBefore);
  expect(spent()).toBe(spentBefore);
}

/**
 * N133 (the steward's DECISIONS 01:01): a paid job's buyer is the caller's proven wallet, and the
 * write scope its job mints waits for the kernel operator's acceptance unless the kernel's policy
 * accepts the buyer. kernel-nyc's policy is the default (manual), so its proven operator (a request
 * with no x-test-key reads as that operator) accepts the scope here; it goes live on the buyer's own
 * escrow (the mock one, MOCK_SETTLEMENT=true above).
 */
async function acceptScope(app: FastifyInstance, scopeId: string) {
  const res = await app.inject({ method: "POST", url: `/api/operator/scopes/${scopeId}/accept` });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ accepted: true, scopeId, status: "active" });
}

/** The recorded operator of a seeded kernel. */
function operatorOf(kernelId: string): string {
  const row = getStore().db.select().from(schema.shopKernels).where(eq(schema.shopKernels.id, kernelId)).get();
  return row!.operatorAddress;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Paid Job Flow", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /api/jobs/submit-from-discovery
  // ═══════════════════════════════════════════════════════════════════════

  describe("POST /api/jobs/submit-from-discovery", () => {
    it("creates a fast-track job with all pieces wired", async () => {
      // N133: the buyer is the caller's proven wallet, naming itself.
      const wallet = buyer("001");
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          parameters: { volume: 100, tipType: "p300" },
          paymentMethod: "testnet-mock",
          userAgentId: wallet,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();

      // All pieces present
      expect(body.sessionId).toBeDefined();
      expect(body.jobId).toBeDefined();
      expect(body.scopeId).toBeDefined();
      expect(body.escrowId).toBeDefined();
      expect(body.escrowAddress).toBeDefined();
      expect(body.escrowStatus).toBe("funded");
      expect(body.quote).toBeDefined();
      expect(body.contractTerms).toBeDefined();
      expect(body.message).toContain("Fast-track job created");
    });

    it("rejects when required fields are missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          // missing capabilityType and userAgentId
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain("required");
    });

    it("creates a job in 'queued' status (mock settlement, control-plane gateway)", async () => {
      const wallet = buyer("001");
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: wallet,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();

      // SEAM-1: this test app registers no local KernelService, so the gateway is
      // control-plane only — createJobFromSession routes a fresh job to "queued"
      // for a remote operator daemon (which polls status=queued) to pick up. This
      // is the production topology (capability.network holds no local kernel). A
      // gateway WITH a matching local kernel would mark it "active". Either way the
      // escrow is funded — the money-path assertion below is unchanged.
      const repos = getRepos();
      const job = repos.jobs.findById(body.jobId);
      expect(job).toBeDefined();
      expect(job!.status).toBe("queued");
    });

    it("creates an escrow in 'funded' status (mock settlement)", async () => {
      const wallet = buyer("001");
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: wallet,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();

      // Verify escrow in DB
      const repos = getRepos();
      const escrow = repos.escrows.findById(body.escrowId);
      expect(escrow).toBeDefined();
      expect(escrow!.status).toBe("funded");
    });

    // N133 (inverted): under kernel-nyc's default (manual) policy the scope is minted awaiting the
    // kernel operator's acceptance, not active; the operator's acceptance makes it active.
    it("creates an execution scope tied to the job that awaits the kernel operator's acceptance, then is active once accepted", async () => {
      const wallet = buyer("001");
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: wallet,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.scopeStatus).toBe("awaiting_acceptance");

      // Verify scope in DB (read by its proven holder through the device relay)
      const readScope = () =>
        app.inject({
          method: "GET",
          url: `/api/relay/kernel-nyc/scope/${body.scopeId}`,
          headers: asKey(wallet),
        });
      const scopeRes = await readScope();

      expect(scopeRes.statusCode).toBe(200);
      const scope = scopeRes.json();
      expect(scope.status).toBe("awaiting_acceptance");
      expect(scope.jobId).toBe(body.jobId);
      expect(scope.kernelId).toBe("kernel-nyc");
      expect(Array.isArray(scope.allowedTools)).toBe(true);
      expect(scope.allowedTools.length).toBeGreaterThan(0);

      await acceptScope(app, body.scopeId);
      const acceptedRes = await readScope();
      expect(acceptedRes.statusCode).toBe(200);
      expect(acceptedRes.json().status).toBe("active");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Negotiation commit -> paid job wiring
  // ═══════════════════════════════════════════════════════════════════════

  describe("Negotiation COMMITTED -> Job + Escrow + Scope", () => {
    it("creates job, escrow, and scope when session is committed", async () => {
      // N133: the session's buyer is the caller's proven wallet, and only it (or the admin)
      // commits the session, so the buyer drives every step.
      const wallet = buyer("002");
      // Step 1: Create session
      const createRes = await app.inject({
        method: "POST",
        url: "/api/negotiate/session",
        headers: asKey(wallet),
        payload: {
          userAgentId: wallet,
          // negotiation now gates on the kernel actually offering the capability
          // type (checkKernelOffersCapability → 404 otherwise). kernel-nyc offers
          // fdm/laser-cut, not liquid-handler; kernel-nanoclaw is the seeded
          // liquid-handler kernel, so it clears the gate.
          kernelId: "kernel-nanoclaw",
          capabilityType: "liquid-handler",
        },
      });
      expect(createRes.statusCode).toBe(200);
      const { session } = createRes.json();
      const sessionId = session.id;

      // Step 2: Compute quote
      const quoteRes = await app.inject({
        method: "POST",
        url: `/api/negotiate/session/${sessionId}/quote`,
        headers: asKey(wallet),
      });
      expect(quoteRes.statusCode).toBe(200);

      // Step 3: Generate contract terms (review)
      const reviewRes = await app.inject({
        method: "POST",
        url: `/api/negotiate/session/${sessionId}/review`,
        headers: asKey(wallet),
      });
      expect(reviewRes.statusCode).toBe(200);

      // Step 4: Commit
      const commitRes = await app.inject({
        method: "POST",
        url: `/api/negotiate/session/${sessionId}/commit`,
        headers: asKey(wallet),
      });
      expect(commitRes.statusCode).toBe(200);
      const commitBody = commitRes.json();

      // Verify all pieces were created
      expect(commitBody.jobId).toBeDefined();
      expect(commitBody.scopeId).toBeDefined();
      expect(commitBody.escrowId).toBeDefined();
      expect(commitBody.escrowAddress).toBeDefined();
      expect(commitBody.escrowStatus).toBe("funded");
      expect(commitBody.message).toContain("escrow");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PUT /api/jobs/:jobId/complete
  // ═══════════════════════════════════════════════════════════════════════

  describe("PUT /api/jobs/:jobId/complete", () => {
    it("completes a job and settles (mock settlement)", async () => {
      // First create a job via fast-track, for the buyer's wallet
      const wallet = buyer("003");
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: wallet,
        },
      });
      const { jobId, scopeId } = createRes.json();
      await acceptScope(app, scopeId);

      // Simulate some tool calls under the scope: the buyer's proven wallet writes, and the same
      // address only claimed is refused (DECISIONS 00:42).
      const write = { scopeId, toolName: "ot2_aspirate", args: { volume: 100, well: "A1" } };
      await expectClaimedOnlyWriteRefused(app, wallet, write);
      const call = await app.inject({
        method: "POST",
        url: "/api/relay/kernel-nyc/tool-call",
        headers: asKey(wallet),
        payload: write,
      });
      expect(call.statusCode).toBe(201);

      // Complete the job
      const completeRes = await app.inject({
        method: "PUT",
        url: `/api/jobs/${jobId}/complete`,
        payload: {
          evidenceEvents: [
            { type: "photo_captured", payload: { frameId: "frame-001" } },
          ],
        },
      });

      expect(completeRes.statusCode).toBe(200);
      const body = completeRes.json();

      expect(body.jobId).toBe(jobId);
      expect(body.status).toBe("settled");
      expect(body.evidenceBundleId).toBeDefined();
      expect(body.evidenceHash).toMatch(/^sha256:/);
      expect(body.settledAt).toBeDefined();
      expect(body.toolCallsRecorded).toBeGreaterThanOrEqual(1);
      expect(body.message).toContain("settled");
    });

    it("returns 404 for unknown job", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/jobs/nonexistent-job/complete",
        payload: {},
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 409 for already completed job", async () => {
      // Create and complete a job
      const wallet = buyer("004");
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: wallet,
        },
      });
      const { jobId } = createRes.json();

      // Complete once
      await app.inject({
        method: "PUT",
        url: `/api/jobs/${jobId}/complete`,
        payload: {},
      });

      // Try to complete again
      const res = await app.inject({
        method: "PUT",
        url: `/api/jobs/${jobId}/complete`,
        payload: {},
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toContain("already completed");
    });

    it("leaves execution scopes active after completion (revoked at expiry, not on complete)", async () => {
      const wallet = buyer("005");
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: wallet,
        },
      });
      const { jobId, scopeId } = createRes.json();
      await acceptScope(app, scopeId);

      // Complete the job
      await app.inject({
        method: "PUT",
        url: `/api/jobs/${jobId}/complete`,
        payload: {},
      });

      // Deliberate (paid-job-flow.ts §"Execution scopes — left active"): scopes
      // are NOT revoked on job completion; they stay active for follow-up tool
      // calls (camera, diagnostics) until their 1h expiry. completeBody would
      // report scopesRevoked === 0 accordingly.
      const scopeRes = await app.inject({
        method: "GET",
        url: `/api/relay/kernel-nyc/scope/${scopeId}`,
        headers: asKey(wallet),
      });

      expect(scopeRes.statusCode).toBe(200);
      const scope = scopeRes.json();
      expect(scope.status).toBe("active");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/jobs/:jobId/settlement
  // ═══════════════════════════════════════════════════════════════════════

  describe("GET /api/jobs/:jobId/settlement", () => {
    it("returns settlement status for a pending job", async () => {
      const wallet = buyer("006");
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: wallet,
        },
      });
      const { jobId } = createRes.json();

      const res = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}/settlement`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.jobId).toBe(jobId);
      expect(body.status).toBeDefined();
      expect(body.escrowAddress).toBeDefined();
      expect(body.currency).toBe("USDC");
      expect(body.milestones).toBeDefined();
      expect(Array.isArray(body.milestones)).toBe(true);
      expect(body.session).toBeDefined();
    });

    it("NEGATIVE: a mock-settled job reads simulated, never settled or paid (readmodels F1)", async () => {
      // Create and complete
      const wallet = buyer("007");
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: wallet,
        },
      });
      const { jobId } = createRes.json();

      await app.inject({
        method: "PUT",
        url: `/api/jobs/${jobId}/complete`,
        payload: {},
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}/settlement`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      // MOCK_SETTLEMENT writes a mock-escrow- record and marks it released: no real money
      // exists for this job, so it is simulated, whatever the job row says.
      expect(body.status).toBe("simulated");
      expect(body.settled).toBe(false);
      expect(body.paidAmount).toBeNull();
      expect(body.simulated).toBe(true);
      expect(body.evidenceHash).toBeDefined();
      expect(body.evidenceBundleId).toBeDefined();
    });

    it("returns 404 for unknown job", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/jobs/nonexistent-job/settlement",
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Escrow verification in tool relay
  // ═══════════════════════════════════════════════════════════════════════

  describe("Escrow verification on tool calls", () => {
    it("allows tool calls when escrow is funded", async () => {
      const wallet = buyer("008");
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: wallet,
        },
      });
      const { scopeId } = createRes.json();
      await acceptScope(app, scopeId);

      // Tool call should succeed — escrow is mock-funded — from the buyer's proven wallet; the
      // same address only claimed is refused (DECISIONS 00:42).
      const write = { scopeId, toolName: "ot2_aspirate", args: { volume: 50 } };
      await expectClaimedOnlyWriteRefused(app, wallet, write);
      const toolRes = await app.inject({
        method: "POST",
        url: "/api/relay/kernel-nyc/tool-call",
        headers: asKey(wallet),
        payload: write,
      });

      expect(toolRes.statusCode).toBe(201);
    });

    it("allows safe tools regardless of escrow status", async () => {
      const wallet = buyer("009");
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: wallet,
        },
      });
      const { scopeId } = createRes.json();
      // Accepted while the escrow is still funded (N133), so the scope is live.
      await acceptScope(app, scopeId);

      // A safe tool (the relay manifest's "health") works whatever the escrow
      // status, so make the escrow unfunded first.
      const escrowId = createRes.json().escrowId;
      getRepos().escrows.updateStatus(escrowId, "created");
      const toolRes = await app.inject({
        method: "POST",
        url: "/api/relay/kernel-nyc/tool-call",
        headers: asKey(wallet),
        payload: {
          scopeId,
          toolName: "health",
          args: {},
        },
      });

      expect(toolRes.statusCode).toBe(201);
    });

    // Carried over from the retired legacy OT-2 tool-call route (N4b-gw item 1).
    it("refuses a scoped write while the job's escrow is not funded (402), and records the refusal", async () => {
      const wallet = buyer("010");
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: wallet,
        },
      });
      const { scopeId, escrowId } = createRes.json();
      // Accepted while the escrow is still funded (N133), so the scope is live and the relay's
      // escrow gate is what this write meets.
      await acceptScope(app, scopeId);
      getRepos().escrows.updateStatus(escrowId, "created");

      // The buyer's proven wallet passes the relay guard (DECISIONS 00:42), so the escrow gate
      // (escrowRefusal) is what refuses its write.
      const toolRes = await app.inject({
        method: "POST",
        url: "/api/relay/kernel-nyc/tool-call",
        headers: asKey(wallet),
        payload: { scopeId, toolName: "ot2_aspirate", args: { volume: 50 } },
      });

      expect(toolRes.statusCode).toBe(402);
      expect(toolRes.json().reason).toBe("escrow_not_funded");
      expect(toolRes.json().escrowStatus).toBe("created");
      const { db } = getStore();
      const row = db.select().from(schema.toolCallRelay).where(eq(schema.toolCallRelay.id, toolRes.json().callId)).get();
      expect(row!.status).toBe("rejected");
      const scope = db.select().from(schema.executionScopes).where(eq(schema.executionScopes.id, scopeId)).get();
      expect(scope!.commandCount).toBe(0);
    });

    it("refuses a scoped write when the escrow lookup fails (503), instead of letting it through", async () => {
      const wallet = buyer("011");
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: wallet,
        },
      });
      const { scopeId } = createRes.json();
      // Accepted before the escrow store fails (N133: the acceptance reads the escrow too).
      await acceptScope(app, scopeId);
      const spy = vi.spyOn(getRepos().escrows, "findByCwm").mockImplementation(() => {
        throw new Error("escrow store unavailable");
      });

      // The buyer's proven wallet passes the relay guard (DECISIONS 00:42), so a failed escrow
      // lookup is what refuses its write.
      const toolRes = await app.inject({
        method: "POST",
        url: "/api/relay/kernel-nyc/tool-call",
        headers: asKey(wallet),
        payload: { scopeId, toolName: "ot2_aspirate", args: { volume: 50 } },
      });
      spy.mockRestore();

      expect(toolRes.statusCode).toBe(503);
      expect(toolRes.json().error).toBe("escrow_check_unavailable");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // N4b-gw: a relay scope can bind only a job on its own kernel
  // ═══════════════════════════════════════════════════════════════════════

  describe("Relay scope minting and jobs", () => {
    it("refuses an operator binding a scope to a job on another kernel", async () => {
      const wallet = buyer("012");
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: { kernelId: "kernel-nyc", capabilityType: "liquid-handler", userAgentId: wallet },
      });
      const { jobId } = createRes.json();

      const res = await app.inject({
        method: "POST",
        url: "/api/relay/kernel-nanoclaw/scope",
        headers: asKey(operatorOf("kernel-nanoclaw")),
        payload: { createdBy: operatorOf("kernel-nanoclaw"), allowedTools: ["ot2_aspirate"], jobId },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("job_not_on_kernel");
    });

    it("lets the job's own kernel operator bind a scope to it", async () => {
      const wallet = buyer("013");
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: { kernelId: "kernel-nyc", capabilityType: "liquid-handler", userAgentId: wallet },
      });
      const { jobId } = createRes.json();

      const res = await app.inject({
        method: "POST",
        url: "/api/relay/kernel-nyc/scope",
        headers: asKey(operatorOf("kernel-nyc")),
        payload: { createdBy: operatorOf("kernel-nyc"), allowedTools: ["ot2_aspirate"], jobId },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().jobId).toBe(jobId);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Full end-to-end flow
  // ═══════════════════════════════════════════════════════════════════════

  describe("Full end-to-end: discovery -> negotiation -> execution -> settlement", () => {
    it("completes the entire paid job lifecycle", async () => {
      // ── Step 1: Submit from discovery (fast-track) ─────────────────
      const wallet = buyer("e2e");
      const submitRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers: asKey(wallet),
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          parameters: { protocol: "pcr-prep", volume: 50 },
          paymentMethod: "testnet-mock",
          userAgentId: wallet,
        },
      });

      expect(submitRes.statusCode).toBe(201);
      const { jobId, scopeId, escrowId, escrowStatus, scopeStatus } = submitRes.json();
      expect(escrowStatus).toBe("funded");

      // ── Step 1b: The kernel's operator accepts the buyer's scope (N133) ──
      expect(scopeStatus).toBe("awaiting_acceptance");
      await acceptScope(app, scopeId);

      // ── Step 2: Execute tool calls under scope ─────────────────────
      // The buyer's proven wallet writes; the same address only claimed is refused
      // (DECISIONS 00:42).
      const aspirate = { scopeId, toolName: "ot2_aspirate", args: { volume: 50, well: "A1" } };
      await expectClaimedOnlyWriteRefused(app, wallet, aspirate);
      const call1 = await app.inject({
        method: "POST",
        url: "/api/relay/kernel-nyc/tool-call",
        headers: asKey(wallet),
        payload: aspirate,
      });
      expect(call1.statusCode).toBe(201);

      const call2 = await app.inject({
        method: "POST",
        url: "/api/relay/kernel-nyc/tool-call",
        headers: asKey(wallet),
        payload: { scopeId, toolName: "ot2_dispense", args: { volume: 50, well: "B1" } },
      });
      expect(call2.statusCode).toBe(201);

      // ── Step 3: Complete the job ───────────────────────────────────
      const completeRes = await app.inject({
        method: "PUT",
        url: `/api/jobs/${jobId}/complete`,
        payload: {
          evidenceEvents: [
            { type: "photo_captured", payload: { note: "post-dispense photo" } },
          ],
        },
      });

      expect(completeRes.statusCode).toBe(200);
      const completeBody = completeRes.json();
      expect(completeBody.status).toBe("settled");
      expect(completeBody.toolCallsRecorded).toBe(2);
      expect(completeBody.evidenceHash).toMatch(/^sha256:/);
      expect(completeBody.scopesRevoked).toBe(0);

      // ── Step 4: Verify settlement status ───────────────────────────
      const settlementRes = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}/settlement`,
      });

      expect(settlementRes.statusCode).toBe(200);
      const settlement = settlementRes.json();
      // Mock settlement: the mock-escrow record says released, but no real money exists.
      expect(settlement.status).toBe("simulated");
      expect(settlement.settled).toBe(false);
      expect(settlement.paidAmount).toBeNull();
      expect(settlement.evidenceHash).toBeDefined();
      expect(settlement.milestones.length).toBeGreaterThan(0);
      expect(settlement.milestones[0].status).toBe("released");
      expect(settlement.currency).toBe("USDC");

      // ── Step 5: Scope stays active post-completion (revoked at expiry) ──
      // completeBody.scopesRevoked === 0 above already asserts none were revoked.
      const scopeRes = await app.inject({
        method: "GET",
        url: `/api/relay/kernel-nyc/scope/${scopeId}`,
        headers: asKey(wallet),
      });
      expect(scopeRes.statusCode).toBe(200);
      expect(scopeRes.json().status).toBe("active");

      // ── Step 6: Verify job in jobs list ────────────────────────────
      const jobRes = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}`,
      });
      expect(jobRes.statusCode).toBe(200);
      const jobBody = jobRes.json();
      expect(jobBody.job.status).toBe("settled");
      // GET /api/jobs/:jobId returns { job, evidence } — the route lifts the
      // detail DTO's evidenceBundles out to a top-level `evidence` array (not a
      // scalar job.evidenceBundleId). Completion persisted a bundle, so it is
      // non-empty.
      expect(jobBody.evidence.length).toBeGreaterThan(0);
    });
  });
});
