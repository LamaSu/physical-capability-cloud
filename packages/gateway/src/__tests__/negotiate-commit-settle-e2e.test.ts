/**
 * End-to-end integration test for the W10 wiring: negotiate-session
 * commit → SettleableSession registration → centralized-settle gate
 * decision honors the per-capability W7 B fields.
 *
 * What this exercises:
 *
 *   1. POST /api/negotiate/session            (create)
 *   2. POST /api/negotiate/session/:id/quote  (price)
 *   3. POST /api/negotiate/session/:id/review (terms)
 *   4. POST /api/negotiate/session/:id/commit (mints SettleableSession)
 *   5. POST /api/sessions/:id/settle          (reads state.sessions)
 *
 * The load-bearing assertion is that step 4 has snapshotted the capability
 * spec's `requiresApproval` / `approvalThresholdUsd` onto the session,
 * and step 5 sees them via `shouldGateOnApproval`.
 *
 * The DB schema (packages/db/src/schema/capabilities.ts) does NOT yet
 * persist the W2 + W7 B capability fields as columns. To exercise the
 * snapshot flow we mock `repos.capabilities.findByKernel` to surface
 * W7 B fields on the in-memory result. In production this will instead
 * come from a richer capability source (DB schema extension, Capability-
 * Facade, or template lookup) — the negotiate-commit wiring at
 * `packages/gateway/src/routes/negotiation.ts` reads whatever fields
 * are present and snapshots them through unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// JSON.stringify BigInt — necessary because the POST /api/negotiate/session
// response embeds a WorkflowChallenge whose blockNumber/blockTimestamp are
// BigInt, and Fastify's default serializer throws on BigInt. Standard
// library convention is BigInt.prototype.toJSON returning a string.
// Set once at import; safe across the suite.
if (!(BigInt.prototype as { toJSON?: () => string }).toJSON) {
  (BigInt.prototype as { toJSON?: () => string }).toJSON = function () {
    return this.toString();
  };
}

// Auth mock — same pattern as centralized-settle-approval.test.ts.
vi.mock("../auth/siwe-auth.js", () => ({
  resolveSession: vi.fn(),
}));
vi.mock("../auth/api-key-auth.js", () => ({
  resolveApiKey: vi.fn(),
}));

import {
  centralizedSettleRoutes,
  resetCentralizedSettleStateForTests,
} from "../routes/centralized-settle.js";
import {
  approvalRequestRoutes,
  _resetApprovalRequestStoreForTests,
} from "../routes/approval-request.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { streamHub, type StreamEvent } from "../sse/stream-hub.js";
import { resolveApiKey } from "../auth/api-key-auth.js";

const mockApiKey = resolveApiKey as ReturnType<typeof vi.fn>;

// Mock contracts to avoid real on-chain calls during commit.
vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xtest", status: "submitted" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xtest", status: "submitted" }),
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
  flushSettlements: vi.fn().mockResolvedValue({
    epochId: "epoch-1",
    totalIntents: 0,
    batches: [],
    byAgent: {},
    byOperation: {},
    startedAt: 0,
    completedAt: 0,
  }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(centralizedSettleRoutes);
  await app.register(approvalRequestRoutes);
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.ready();
  return app;
}

/**
 * Patch `repos.capabilities.findByKernel` to surface the W2 + W7 B
 * fields on existing seeded capabilities. The snapshot wiring in
 * negotiation.ts reads only the relevant subset, so injecting them via
 * the lookup result is enough to exercise the flow end-to-end.
 *
 * Returns a restore function the caller MUST invoke in afterEach.
 */
function patchCapabilitiesWithW7Fields(
  kernelId: string,
  capabilityType: string,
  w7Fields: {
    requiresApproval?: boolean;
    approvalThresholdUsd?: number;
    settlementMode?: "centralized" | "onchain";
  },
): () => void {
  const repos = getRepos();
  const original = repos.capabilities.findByKernel.bind(repos.capabilities);
  vi.spyOn(repos.capabilities, "findByKernel").mockImplementation((kid: string) => {
    const rows = original(kid);
    if (kid !== kernelId) return rows;
    return rows.map((r) => {
      if (r.type !== capabilityType) return r;
      return {
        ...r,
        ...w7Fields,
      } as typeof r;
    });
  });
  return () => vi.restoreAllMocks();
}

/** Drive a session from CREATED → COMMITTED via the negotiate routes. */
async function commitNegotiation(
  app: FastifyInstance,
  args: { userAgentId: string; kernelId: string; capabilityType: string },
): Promise<{ sessionId: string; commitBody: Record<string, unknown> }> {
  const createRes = await app.inject({
    method: "POST",
    url: "/api/negotiate/session",
    payload: args,
  });
  if (createRes.statusCode !== 200) {
    throw new Error(`create failed: ${createRes.statusCode} ${createRes.body}`);
  }
  const sessionId = (createRes.json() as { session: { id: string } }).session.id;

  const quoteRes = await app.inject({
    method: "POST",
    url: `/api/negotiate/session/${sessionId}/quote`,
  });
  if (quoteRes.statusCode !== 200) {
    throw new Error(`quote failed: ${quoteRes.statusCode} ${quoteRes.body}`);
  }

  const reviewRes = await app.inject({
    method: "POST",
    url: `/api/negotiate/session/${sessionId}/review`,
  });
  if (reviewRes.statusCode !== 200) {
    throw new Error(`review failed: ${reviewRes.statusCode} ${reviewRes.body}`);
  }

  const commitRes = await app.inject({
    method: "POST",
    url: `/api/negotiate/session/${sessionId}/commit`,
  });
  if (commitRes.statusCode !== 200) {
    throw new Error(`commit failed: ${commitRes.statusCode} ${commitRes.body}`);
  }
  return { sessionId, commitBody: commitRes.json() };
}

/** Subscribe to the approval topic and capture events. */
function subscribeApproval(sessionId: string): {
  events: StreamEvent[];
  unsubscribe: () => void;
} {
  const events: StreamEvent[] = [];
  const unsubscribe = streamHub.subscribe(
    [{ type: "approval", id: sessionId }],
    (e) => events.push(e),
  );
  return { events, unsubscribe };
}

describe("Negotiate-commit → settle (W10 e2e)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetCentralizedSettleStateForTests();
    _resetApprovalRequestStoreForTests();
    delete process.env.APPROVAL_TIMEOUT_MS;
    delete process.env.APPROVAL_THRESHOLD_USD;
    mockApiKey.mockReturnValue({ id: "key-1", operatorId: "op-1" });
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    vi.restoreAllMocks();
  });

  it("commit on a capability with requiresApproval=true → settle gate fires (proves W7 B → session → gate loop)", async () => {
    process.env.APPROVAL_TIMEOUT_MS = "20"; // fast timeout — we don't approve
    const restore = patchCapabilitiesWithW7Fields("kernel-nyc", "fdm", {
      requiresApproval: true,
    });

    try {
      const { sessionId } = await commitNegotiation(app, {
        userAgentId: "user-w10-e2e-required",
        kernelId: "kernel-nyc",
        capabilityType: "fdm",
      });

      // Subscribe FIRST so the gate's no_subscriber check passes when
      // settle fires the SSE event.
      const { unsubscribe } = subscribeApproval(sessionId);

      const settleRes = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/settle`,
        payload: {},
      });

      // Gate fired → no decision posted → 408 timeout. The capabilityRequiresApproval
      // snapshot from the negotiate-commit site MUST have made it onto
      // the SettleableSession for the gate to flip on.
      expect(settleRes.statusCode).toBe(408);
      expect(settleRes.json().error).toBe("approval_timeout");

      unsubscribe();
    } finally {
      restore();
    }
  });

  it("commit on a capability with approvalThresholdUsd + amount above threshold → settle gate fires", async () => {
    process.env.APPROVAL_TIMEOUT_MS = "20";
    // The default quote in negotiation.ts uses basePrice from the
    // capability template; for "fdm" the template basePrice is around
    // $5/job (matches cap-nyc-fdm seed pricing.baseCost = "5.00").
    // approvalThresholdUsd = 1 forces "amount above threshold" without
    // having to plumb a custom quantity through the negotiate flow.
    const restore = patchCapabilitiesWithW7Fields("kernel-nyc", "fdm", {
      approvalThresholdUsd: 1,
    });

    try {
      const { sessionId } = await commitNegotiation(app, {
        userAgentId: "user-w10-e2e-threshold",
        kernelId: "kernel-nyc",
        capabilityType: "fdm",
      });

      const { unsubscribe } = subscribeApproval(sessionId);

      const settleRes = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/settle`,
        payload: {},
      });

      // Gate fired due to capabilityApprovalThresholdUsd snapshot →
      // 408 timeout. Proves the threshold field made the spec → session
      // → gate journey.
      expect(settleRes.statusCode).toBe(408);
      expect(settleRes.json().error).toBe("approval_timeout");

      unsubscribe();
    } finally {
      restore();
    }
  });

  it("commit on a capability without W7 B fields → settle proceeds without gate", async () => {
    // No patching — use the seed capability as-is. The seed doesn't
    // surface W7 B fields, so the snapshot makes them undefined on the
    // SettleableSession, the gate hierarchy reads "do not fire", and
    // settle proceeds normally. We're not asserting full 200 happy-path
    // here (escrow funding is a separate concern that v1's centralized
    // substrate tracks via deposit + lock; this e2e doesn't seed those)
    // — just that we DON'T see the gate-fired status codes (408/503/403).

    const { sessionId } = await commitNegotiation(app, {
      userAgentId: "user-w10-e2e-no-gate",
      kernelId: "kernel-nyc",
      capabilityType: "fdm",
    });

    const settleRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/settle`,
      payload: {},
    });

    // Gate did NOT fire. The exact status (200 or 409 escrow_empty)
    // depends on whether the substrate ledger has funds locked; either
    // way it should NOT be a gate-fired status.
    expect([408, 503, 403]).not.toContain(settleRes.statusCode);
  });
});
