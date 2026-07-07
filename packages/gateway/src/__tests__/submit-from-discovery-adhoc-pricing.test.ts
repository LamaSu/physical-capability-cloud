/**
 * Regression test for the ad-hoc capability pricing fix in
 * POST /api/jobs/submit-from-discovery (routes/paid-job-flow.ts).
 *
 * Before this fix, the fast-track endpoint computed its quote via
 * getTemplate(capabilityType)?.basePricingHints?.basePrice, falling back to
 * a hardcoded $10 for ANY type without a built-in @pcc/contract-builder
 * template — silently mispricing every ad-hoc-capability escrow funded
 * through this endpoint. Documented as residual gap #1 in MATCHING-NOTES.md
 * ("the order path must consume [the listing's own price]"), the sibling of
 * the negotiate/session + build/options ad-hoc pricing fix already covered
 * by negotiate-ad-hoc.test.ts.
 *
 * This is a standalone file (not added to paid-job-flow.test.ts) because
 * that file is currently excluded from the default vitest run
 * (vitest.config.ts: "facade rewrite changed route behavior. Tests expect
 * old status/response codes" — pre-existing, unrelated to this fix; verified
 * by temporarily un-excluding it: 3 job-completion/scope assertions fail
 * there independent of this change, 15/18 tests including this fix's
 * behavior pass). Mirrors paid-job-flow.test.ts's buildApp()/mocks exactly
 * so this ad-hoc-pricing regression coverage actually runs in CI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema } from "@pcc/store";

// ---------------------------------------------------------------------------
// Mocks — identical to paid-job-flow.test.ts (all external calls mocked).
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

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.ready();
  return app;
}

describe("POST /api/jobs/submit-from-discovery — ad-hoc capability pricing", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("prices an AD-HOC capability from its own pricingModel, not the $10 fallback", async () => {
    // Register an ad-hoc (non-template) capability on the already-seeded
    // kernel-nyc kernel. "custom-widget-assembly" is not one of the 18
    // built-in @pcc/contract-builder templates.
    const { db } = getStore();
    db.insert(schema.capabilities).values({
      id: "cap-nyc-adhoc-widget",
      kernelId: "kernel-nyc",
      type: "custom-widget-assembly",
      name: "Custom Widget Assembly",
      description: "",
      materials: [],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: "37", minimum: "37" },
      availability: {},
      location: { lat: 0, lng: 0 },
      queueDepth: 0,
    } as any).run();

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: {
        kernelId: "kernel-nyc",
        capabilityType: "custom-widget-assembly",
        userAgentId: "user-agent-adhoc",
      },
    });

    if (res.statusCode !== 201) console.error("[adhoc submit-from-discovery]", res.statusCode, res.body);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.quote.basePrice).toBe("37.00");
    expect(body.quote.currency).toBe("USDC");
    expect(body.escrowStatus).toBe("funded");
  });

  it("returns 4xx (NOT 500, NOT a $10 quote) for a capability type with no template and no registered listing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: {
        kernelId: "kernel-nyc",
        capabilityType: "totally-unregistered-type-xyz",
        userAgentId: "user-agent-missing",
      },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const body = res.json();
    expect(JSON.stringify(body)).toMatch(/template|capability|not.*found|not.*buildable/i);
  });

  it("still handles a known template type (fdm) via the template branch, unaffected by the ad-hoc path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: {
        kernelId: "kernel-nyc",
        capabilityType: "fdm",
        userAgentId: "user-agent-template",
      },
    });

    if (res.statusCode !== 201) console.error("[fdm submit-from-discovery]", res.statusCode, res.body);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.quote).toBeDefined();
    expect(body.escrowStatus).toBe("funded");
  });
});
