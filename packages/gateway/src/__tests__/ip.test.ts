/**
 * Tests for Story Protocol IP gateway routes.
 *
 * POST /api/ip/register-capability       — register CSD as IP Asset
 * POST /api/ip/register-job-evidence     — register job evidence as derivative
 * POST /api/ip/distribute-royalties      — set revenue splits
 * POST /api/ip/:ipId/pay                 — pay royalty to vault
 * POST /api/ip/:ipId/claim               — claim revenue
 * GET  /api/ip/:ipId/revenue             — revenue snapshot
 * GET  /api/ip/:ipId/lineage             — lineage chain
 * GET  /api/ip/capability/:capabilityId  — get IP for a capability
 * POST /api/ip/:ipId/dispute             — raise dispute
 *
 * All tests use StoryIPService in mock mode (no real chain calls).
 * DB is an in-memory SQLite store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ipRoutes } from "../routes/ip.js";
import { initStore, closeStore } from "../db.js";
import { resetStoryIPService, StoryIPService } from "@pcc/contracts";
import { getRepos } from "../db.js";

// Ensure mock mode for all tests
process.env.STORY_MOCK = "true";

const NOT_EXECUTED_MESSAGE =
  "PCC does not execute Story royalty payments. This route moves no money and records nothing.";
const DISTRIBUTE_501 = { error: "not_executed", operation: "distributeRoyaltyTokens", message: NOT_EXECUTED_MESSAGE };
const SETTLE_501 = { error: "not_executed", operation: "settleRoyalties", message: NOT_EXECUTED_MESSAGE };
const PAY_501 = { error: "not_executed", operation: "payJobRoyalty", message: NOT_EXECUTED_MESSAGE };
const CLAIM_501 = { error: "not_executed", operation: "claimRevenue", message: NOT_EXECUTED_MESSAGE };

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(ipRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const CAPABILITY_BODY = {
  capability: {
    id: "cap-test-001",
    name: "Test CNC Milling",
    type: "cnc-3axis",
    kernelId: "kernel-nyc",
    description: "Test capability",
  },
  designerAddress: "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
  designerName: "Alice",
};

// ---------------------------------------------------------------------------
// POST /api/ip/register-capability
// ---------------------------------------------------------------------------

describe("POST /api/ip/register-capability", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetStoryIPService();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetStoryIPService();
  });

  it("returns 200 with a valid StoryIPRegistration", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: CAPABILITY_BODY,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ registration: Record<string, unknown> }>();
    expect(body.registration).toBeDefined();
    expect(body.registration.ipId).toMatch(/^0x[0-9a-f]+$/i);
    expect(body.registration.capabilityId).toBe("cap-test-001");
    expect(body.registration.txHash).toMatch(/^0x[0-9a-f]+$/i);
  });

  it("returns 400 when capability fields are missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: {
        capability: { name: "Missing id" },
        designerAddress: "0xDEAD",
        designerName: "Alice",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when designerAddress is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: {
        capability: CAPABILITY_BODY.capability,
        designerName: "Alice",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("uses ipfsCid in csdUrl when provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: {
        ...CAPABILITY_BODY,
        ipfsCid: "bafytest123",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ registration: { csdUrl: string } }>();
    expect(body.registration.csdUrl).toBe("ipfs://bafytest123");
  });
});

// ---------------------------------------------------------------------------
// POST /api/ip/register-job-evidence
// ---------------------------------------------------------------------------

describe("POST /api/ip/register-job-evidence", () => {
  let app: FastifyInstance;
  let parentIpId: string;

  beforeEach(async () => {
    resetStoryIPService();
    app = await buildApp();

    // Register a capability first to get a parentIpId
    const regRes = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: CAPABILITY_BODY,
    });
    parentIpId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetStoryIPService();
  });

  it("returns 200 with a valid StoryDerivativeLink", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/register-job-evidence",
      payload: {
        parentIpId,
        jobId: "job-test-001",
        evidenceBundleHash: "sha256:testevidence123",
        operatorAddress: "0xCAFEBABE",
        operatorName: "Bob",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ link: Record<string, unknown> }>();
    expect(body.link).toBeDefined();
    expect(body.link.parentIpId).toBe(parentIpId);
    expect(body.link.childIpId).toMatch(/^0x[0-9a-f]+$/i);
    expect(body.link.jobId).toBe("job-test-001");
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/register-job-evidence",
      payload: {
        parentIpId,
        // missing jobId, evidenceBundleHash, etc.
      },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/ip/distribute-royalties
// ---------------------------------------------------------------------------

describe("POST /api/ip/distribute-royalties", () => {
  let app: FastifyInstance;
  let ipId: string;

  beforeEach(async () => {
    resetStoryIPService();
    app = await buildApp();

    const regRes = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: CAPABILITY_BODY,
    });
    ipId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetStoryIPService();
  });

  it("returns 501 not_executed with txHash and distributed count request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/distribute-royalties",
      payload: {
        ipId,
        splits: [
          { address: "0xAAAA", role: "designer", percentage: 10, label: "Designer" },
          { address: "0xBBBB", role: "operator", percentage: 70, label: "Operator" },
          { address: "0xCCCC", role: "verifier", percentage: 10, label: "Verifier" },
          { address: "0xDDDD", role: "curator", percentage: 10, label: "Network" },
        ],
      },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(DISTRIBUTE_501);
  });

  it("returns 501 not_executed when splits do not sum to 100", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/distribute-royalties",
      payload: {
        ipId,
        splits: [
          { address: "0xAAAA", role: "designer", percentage: 50, label: "Designer" },
          { address: "0xBBBB", role: "operator", percentage: 40, label: "Operator" },
          // sum = 90, not 100
        ],
      },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(DISTRIBUTE_501);
  });

  it("returns 501 not_executed when splits array is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/distribute-royalties",
      payload: { ipId, splits: [] },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(DISTRIBUTE_501);
  });

  it("returns 501 not_executed when ipId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/distribute-royalties",
      payload: {
        splits: [{ address: "0xAAAA", role: "designer", percentage: 100, label: "All" }],
      },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(DISTRIBUTE_501);
  });

  it("returns 501 not_executed for the ADR-12 contributor-economics-with-ai split (6 new-taxonomy roles)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/distribute-royalties",
      payload: {
        ipId,
        splits: [
          { address: "0xAAAA", role: "operator",           percentage: 87, label: "Machine Operator" },
          { address: "0xBBBB", role: "verifier",           percentage:  3, label: "Evidence Verifier" },
          { address: "0xCCCC", role: "protocol-author",    percentage:  2, label: "CSD Author" },
          { address: "0xDDDD", role: "integrator",         percentage:  2, label: "Adapter Integrator" },
          { address: "0xEEEE", role: "model-author",       percentage:  4, label: "Model Author" },
          { address: "0xFFFF", role: "network-treasury",   percentage:  2, label: "Network Treasury" },
        ],
      },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(DISTRIBUTE_501);
  });

  it("returns 501 not_executed for backward compat: legacy `designer` role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/distribute-royalties",
      payload: {
        ipId,
        splits: [
          { address: "0xAAAA", role: "designer", percentage: 10, label: "Designer" },
          { address: "0xBBBB", role: "operator", percentage: 70, label: "Operator" },
          { address: "0xCCCC", role: "verifier", percentage: 10, label: "Verifier" },
          { address: "0xDDDD", role: "curator",  percentage: 10, label: "Curator" },
        ],
      },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(DISTRIBUTE_501);
  });

  it("returns 501 not_executed for backward compat: legacy `network` role (alias for network-treasury)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/distribute-royalties",
      payload: {
        ipId,
        splits: [
          { address: "0xAAAA", role: "operator", percentage: 80, label: "Operator" },
          { address: "0xBBBB", role: "verifier", percentage: 10, label: "Verifier" },
          { address: "0xCCCC", role: "network",  percentage: 10, label: "Protocol Treasury" },
        ],
      } as unknown,
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(DISTRIBUTE_501);
  });

  it("returns 501 not_executed for insurer and dataset-contributor roles introduced by ADR-12", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/distribute-royalties",
      payload: {
        ipId,
        splits: [
          { address: "0xAAAA", role: "operator",            percentage: 85, label: "Operator" },
          { address: "0xBBBB", role: "verifier",            percentage:  3, label: "Verifier" },
          { address: "0xCCCC", role: "insurer",             percentage:  2, label: "Insurer" },
          { address: "0xDDDD", role: "model-author",        percentage:  4, label: "Model Author" },
          { address: "0xEEEE", role: "dataset-contributor", percentage:  3, label: "Dataset Contributor" },
          { address: "0xFFFF", role: "network-treasury",    percentage:  3, label: "Network Treasury" },
        ],
      },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(DISTRIBUTE_501);
  });
});

// ---------------------------------------------------------------------------
// POST /api/ip/:ipId/pay
// ---------------------------------------------------------------------------

describe("POST /api/ip/:ipId/pay", () => {
  let app: FastifyInstance;
  let ipId: string;

  beforeEach(async () => {
    resetStoryIPService();
    app = await buildApp();

    const regRes = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: CAPABILITY_BODY,
    });
    ipId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetStoryIPService();
  });

  it("returns 501 not_executed with txHash request", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/pay`,
      payload: { amount: "500", payerAddress: "0xPAYER" },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(PAY_501);
  });

  it("returns 501 not_executed when amount is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/pay`,
      payload: { payerAddress: "0xPAYER" },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(PAY_501);
  });

  it("returns 501 not_executed when payerAddress is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/pay`,
      payload: { amount: "500" },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(PAY_501);
  });
});

// ---------------------------------------------------------------------------
// POST /api/ip/:ipId/claim
// ---------------------------------------------------------------------------

describe("POST /api/ip/:ipId/claim", () => {
  let app: FastifyInstance;
  let ipId: string;

  beforeEach(async () => {
    resetStoryIPService();
    app = await buildApp();

    const regRes = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: CAPABILITY_BODY,
    });
    ipId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetStoryIPService();
  });

  it("returns 501 not_executed with txHash and claimed amount request", async () => {
    // Pay first so there is something to claim
    await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/pay`,
      payload: { amount: "1000", payerAddress: "0xPAYER" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/claim`,
      payload: {},
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(CLAIM_501);
  });

  it("returns 501 not_executed when vault is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/claim`,
      payload: {},
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(CLAIM_501);
  });

  it("returns 501 not_executed with optional tokenIds", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/claim`,
      payload: { tokenIds: ["tok1", "tok2"] },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(CLAIM_501);
  });
});

// ---------------------------------------------------------------------------
// GET /api/ip/:ipId/revenue
// ---------------------------------------------------------------------------

describe("GET /api/ip/:ipId/revenue", () => {
  let app: FastifyInstance;
  let ipId: string;

  beforeEach(async () => {
    resetStoryIPService();
    app = await buildApp();

    const regRes = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: CAPABILITY_BODY,
    });
    ipId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetStoryIPService();
  });

  it("returns 200 with revenue snapshot", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/ip/${encodeURIComponent(ipId)}/revenue`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      ipId: string;
      vaultAddress: string;
      totalRevenue: string;
      unclaimedRevenue: string;
      tokenHolders: unknown[];
    }>();
    expect(body.ipId).toBe(ipId);
    expect(body.vaultAddress).toMatch(/^0x[0-9a-f]+$/i);
    expect(body.totalRevenue).toBe("0");
    expect(body.unclaimedRevenue).toBe("0");
    expect(Array.isArray(body.tokenHolders)).toBe(true);
  });

  it("refused pay leaves revenue snapshot unchanged", async () => {
    const before = await app.inject({
      method: "GET",
      url: `/api/ip/${encodeURIComponent(ipId)}/revenue`,
    });
    const beforeRevenue = before.json<{ totalRevenue: string }>().totalRevenue;

    const payRes = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/pay`,
      payload: { amount: "250", payerAddress: "0xPAYER" },
    });
    expect(payRes.statusCode).toBe(501);
    expect(payRes.json()).toEqual(PAY_501);

    const res = await app.inject({
      method: "GET",
      url: `/api/ip/${encodeURIComponent(ipId)}/revenue`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ totalRevenue: string }>();
    expect(body.totalRevenue).toBe(beforeRevenue);
    expect(body.totalRevenue).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// GET /api/ip/:ipId/lineage
// ---------------------------------------------------------------------------

describe("GET /api/ip/:ipId/lineage", () => {
  let app: FastifyInstance;
  let ipId: string;

  beforeEach(async () => {
    resetStoryIPService();
    app = await buildApp();

    const regRes = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: CAPABILITY_BODY,
    });
    ipId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetStoryIPService();
  });

  it("returns 200 with empty lineage for a fresh IP", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/ip/${encodeURIComponent(ipId)}/lineage`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ipId: string; ancestors: string[]; descendants: string[] }>();
    expect(body.ipId).toBe(ipId);
    expect(body.ancestors).toEqual([]);
    expect(body.descendants).toEqual([]);
  });

  it("shows descendants after registering a job derivative", async () => {
    const derivRes = await app.inject({
      method: "POST",
      url: "/api/ip/register-job-evidence",
      payload: {
        parentIpId: ipId,
        jobId: "job-lineage-001",
        evidenceBundleHash: "sha256:lineage123",
        operatorAddress: "0xOP",
        operatorName: "Operator",
      },
    });
    const childIpId = derivRes.json<{ link: { childIpId: string } }>().link.childIpId;

    const res = await app.inject({
      method: "GET",
      url: `/api/ip/${encodeURIComponent(ipId)}/lineage`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ descendants: string[] }>();
    expect(body.descendants).toContain(childIpId);
  });
});

// ---------------------------------------------------------------------------
// GET /api/ip/capability/:capabilityId
// ---------------------------------------------------------------------------

describe("GET /api/ip/capability/:capabilityId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetStoryIPService();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetStoryIPService();
  });

  it("returns 404 for an unregistered capability", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/ip/capability/nonexistent-cap",
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("ip_registration_not_found");
  });

  it("returns 200 with registration after registering", async () => {
    await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: CAPABILITY_BODY,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/ip/capability/${encodeURIComponent(CAPABILITY_BODY.capability.id)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ registration: { capabilityId: string } }>();
    expect(body.registration.capabilityId).toBe(CAPABILITY_BODY.capability.id);
  });
});

// ---------------------------------------------------------------------------
// POST /api/ip/:ipId/dispute
// ---------------------------------------------------------------------------

describe("POST /api/ip/:ipId/dispute", () => {
  let app: FastifyInstance;
  let ipId: string;

  beforeEach(async () => {
    resetStoryIPService();
    app = await buildApp();

    const regRes = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: CAPABILITY_BODY,
    });
    ipId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetStoryIPService();
  });

  it("returns 200 with a valid StoryDispute", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/dispute`,
      payload: {
        evidenceHash: "sha256:dispute-evidence-001",
        reason: "Output quality below specification",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ dispute: Record<string, unknown> }>();
    expect(body.dispute).toBeDefined();
    expect(body.dispute.ipId).toBe(ipId);
    expect(body.dispute.status).toBe("pending");
    expect(body.dispute.evidenceHash).toBe("sha256:dispute-evidence-001");
    expect(body.dispute.reason).toBe("Output quality below specification");
  });

  it("returns 400 when evidenceHash is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/dispute`,
      payload: { reason: "Missing evidence hash" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when reason is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/dispute`,
      payload: { evidenceHash: "sha256:test" },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DB persistence checks
// Use seeded kernel/capability IDs so FK constraints are satisfied.
// Seeded: kernelId="kernel-nyc", capabilityId="cap-nyc-fdm"
// ---------------------------------------------------------------------------

const SEEDED_CAPABILITY_BODY = {
  capability: {
    id: "cap-nyc-fdm",       // seeded capability
    name: "FDM 3D Printing",
    type: "fdm-printer",
    kernelId: "kernel-nyc",  // seeded kernel
    description: "Seeded capability for DB persistence tests",
  },
  designerAddress: "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
  designerName: "Alice",
};

describe("IP routes — DB persistence", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetStoryIPService();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetStoryIPService();
  });

  it("register-capability persists to DB (findIpByCapabilityId)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: SEEDED_CAPABILITY_BODY,
    });

    expect(res.statusCode).toBe(200);

    const { getRepos } = await import("../db.js");
    const repos = getRepos();
    const dbReg = repos.story.findIpByCapabilityId(SEEDED_CAPABILITY_BODY.capability.id);
    expect(dbReg).not.toBeNull();
    expect(dbReg?.capabilityId).toBe(SEEDED_CAPABILITY_BODY.capability.id);
  });

  it("distribute-royalties returns 501 and does not persist splits to DB", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: SEEDED_CAPABILITY_BODY,
    });
    const ipId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;

    const splits = [
      { address: "0xAAAA", role: "designer", percentage: 30, label: "Designer" },
      { address: "0xBBBB", role: "operator", percentage: 70, label: "Operator" },
    ];

    const res = await app.inject({
      method: "POST",
      url: "/api/ip/distribute-royalties",
      payload: { ipId, splits },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(DISTRIBUTE_501);

    const repos = getRepos();
    const dbSplits = repos.story.findRoyaltySplitsByIp(ipId);
    expect(dbSplits).toEqual([]);
  });

  it("register-job-evidence persists derivative link to DB", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: SEEDED_CAPABILITY_BODY,
    });
    const ipId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;

    // Use a seeded job ID so the FK constraint is satisfied
    const derivRes = await app.inject({
      method: "POST",
      url: "/api/ip/register-job-evidence",
      payload: {
        parentIpId: ipId,
        jobId: "job-001",  // seeded job ID
        evidenceBundleHash: "sha256:dbpersist",
        operatorAddress: "0xOP",
        operatorName: "Operator",
      },
    });

    expect(derivRes.statusCode).toBe(200);

    const { getRepos } = await import("../db.js");
    const repos = getRepos();
    const links = repos.story.findDerivativeLinksByParent(ipId);
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].parentIpId).toBe(ipId);
  });

  it("claim returns 501 and does not persist to DB revenue claims", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/api/ip/register-capability",
      payload: SEEDED_CAPABILITY_BODY,
    });
    const ipId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;

    await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/pay`,
      payload: { amount: "100", payerAddress: "0xPAYER" },
    });

    const claimRes = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/claim`,
      payload: {},
    });

    expect(claimRes.statusCode).toBe(501);
    expect(claimRes.json()).toEqual(CLAIM_501);

    const repos = getRepos();
    const claims = repos.story.findRevenueClaimsByIp(ipId);
    expect(claims).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C1 (R1) — four money routes refuse in every mode, valid and empty bodies
// ---------------------------------------------------------------------------

describe("C1 (R1) money routes refuse in every mode", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    closeStore();
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    vi.restoreAllMocks();
  });

  const cases: Array<{
    name: string;
    operation: string;
    url: string;
    validBody: Record<string, unknown>;
  }> = [
    {
      name: "distribute-royalties",
      operation: "distributeRoyaltyTokens",
      url: "/api/ip/distribute-royalties",
      validBody: {
        ipId: "0x1111111111111111111111111111111111111111",
        splits: [{ address: "0xAAAA", role: "operator", percentage: 100, label: "Operator" }],
      },
    },
    {
      name: "settle-royalties",
      operation: "settleRoyalties",
      url: "/api/ip/settle-royalties",
      validBody: {
        jobId: "job-001",
        childIpId: "0x2222222222222222222222222222222222222222",
        jobRevenue: "1000000",
        payerAddress: "0xPAYER",
      },
    },
    {
      name: "pay",
      operation: "payJobRoyalty",
      url: "/api/ip/0x3333333333333333333333333333333333333333/pay",
      validBody: { amount: "500", payerAddress: "0xPAYER" },
    },
    {
      name: "claim",
      operation: "claimRevenue",
      url: "/api/ip/0x4444444444444444444444444444444444444444/claim",
      validBody: { tokenIds: ["tok1", "tok2"] },
    },
  ];

  it.each(
    cases.flatMap((c) =>
      [
        { ...c, mode: "mock", bodyLabel: "valid body", body: c.validBody },
        { ...c, mode: "mock", bodyLabel: "empty body", body: {} as Record<string, unknown> },
        { ...c, mode: "real", bodyLabel: "valid body", body: c.validBody },
        { ...c, mode: "real", bodyLabel: "empty body", body: {} as Record<string, unknown> },
      ].map((x) => [x] as const),
    ),
  )(
    "%s %s in %s mode returns 501 not_executed",
    async (c: { name: string; operation: string; url: string; mode: string; bodyLabel: string; body: Record<string, unknown> }) => {
      process.env.STORY_MOCK = c.mode === "mock" ? "true" : "false";
      resetStoryIPService();
      app = await buildApp();

      const res = await app.inject({ method: "POST", url: c.url, payload: c.body });

      expect(res.statusCode).toBe(501);
      expect(res.json()).toEqual({
        error: "not_executed",
        operation: c.operation,
        message: NOT_EXECUTED_MESSAGE,
      });
      expect(res.body).not.toContain("txHash");
      expect(res.json()).not.toHaveProperty("txHash");
    },
  );
});

// ---------------------------------------------------------------------------
// C2 (R1) — refusals write and delete nothing
// ---------------------------------------------------------------------------

describe("C2 (R1) refusals write and delete nothing", () => {
  let app: FastifyInstance;
  const ipId = "0xdeadbeef00000000000000000000000000000001";

  beforeEach(async () => {
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    app = await buildApp();
    const repos = getRepos();
    repos.story.insertIpRegistration({
      ipId,
      nftTokenId: "1",
      licenseTermsId: "1",
      txHash: "0xtx_seed",
      capabilityId: "cap-nyc-fdm",
      csdUrl: "pcc://capabilities/cap-nyc-fdm",
      chain: "story-aeneid",
      registeredAt: new Date().toISOString(),
    });
    repos.story.insertRoyaltySplit({
      id: "split-seeded-1",
      ipId,
      address: "0xAAAA",
      role: "operator",
      percentage: 100,
      label: "Seeded",
    });
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
  });

  it("distribute-royalties refusing leaves seeded split row intact", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/distribute-royalties",
      payload: {
        ipId,
        splits: [{ address: "0xBBBB", role: "operator", percentage: 100, label: "New" }],
      },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(DISTRIBUTE_501);
    const rows = getRepos().story.findRoyaltySplitsByIp(ipId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("split-seeded-1");
    expect(rows[0].address).toBe("0xAAAA");
  });

  it("claim refusing writes no revenue claim", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/claim`,
      payload: {},
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(CLAIM_501);
    expect(getRepos().story.findRevenueClaimsByIp(ipId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C3 (R1) — refusals call no Story service method in either mode
// ---------------------------------------------------------------------------

describe("C3 (R1) refusals call no Story service method", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    closeStore();
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    vi.restoreAllMocks();
  });

  it.each(["true", "false"])(
    "no Story money method is called in STORY_MOCK=%s mode",
    async (storyMock) => {
      process.env.STORY_MOCK = storyMock;
      resetStoryIPService();
      app = await buildApp();

      const distributeSpy = vi.spyOn(StoryIPService.prototype, "distributeRoyaltyTokens");
      const paySpy = vi.spyOn(StoryIPService.prototype, "payJobRoyalty");
      const claimSpy = vi.spyOn(StoryIPService.prototype, "claimRevenue");

      const ipId = "0x5555555555555555555555555555555555555555";
      const results = [
        await app.inject({
          method: "POST",
          url: "/api/ip/distribute-royalties",
          payload: { ipId, splits: [{ address: "0xAAAA", role: "operator", percentage: 100, label: "Operator" }] },
        }),
        await app.inject({
          method: "POST",
          url: "/api/ip/settle-royalties",
          payload: { jobId: "job-001", childIpId: ipId, jobRevenue: "1000", payerAddress: "0xPAYER" },
        }),
        await app.inject({
          method: "POST",
          url: `/api/ip/${encodeURIComponent(ipId)}/pay`,
          payload: { amount: "500", payerAddress: "0xPAYER" },
        }),
        await app.inject({
          method: "POST",
          url: `/api/ip/${encodeURIComponent(ipId)}/claim`,
          payload: {},
        }),
      ];
      for (const res of results) expect(res.statusCode).toBe(501);

      expect(distributeSpy).not.toHaveBeenCalled();
      expect(paySpy).not.toHaveBeenCalled();
      expect(claimSpy).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// C4 (R1) — MOCK_SETTLEMENT does not switch refusals off
// ---------------------------------------------------------------------------

describe("C4 (R1) MOCK_SETTLEMENT does not switch refusals off", () => {
  let app: FastifyInstance | undefined;
  let savedMockSettlement: string | undefined;

  beforeEach(() => {
    savedMockSettlement = process.env.MOCK_SETTLEMENT;
    process.env.MOCK_SETTLEMENT = "true";
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    closeStore();
    if (savedMockSettlement === undefined) delete process.env.MOCK_SETTLEMENT;
    else process.env.MOCK_SETTLEMENT = savedMockSettlement;
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    vi.restoreAllMocks();
  });

  it("all four money routes still refuse with MOCK_SETTLEMENT=true", async () => {
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    app = await buildApp();
    const ipId = "0x6666666666666666666666666666666666666666";

    const checks: Array<["POST", string, Record<string, unknown>, unknown]> = [
      ["POST", "/api/ip/distribute-royalties", { ipId, splits: [{ address: "0xAAAA", role: "operator", percentage: 100, label: "Operator" }] }, DISTRIBUTE_501],
      ["POST", "/api/ip/settle-royalties", { jobId: "job-001", childIpId: ipId, jobRevenue: "1000", payerAddress: "0xPAYER" }, SETTLE_501],
      ["POST", `/api/ip/${encodeURIComponent(ipId)}/pay`, { amount: "500", payerAddress: "0xPAYER" }, PAY_501],
      ["POST", `/api/ip/${encodeURIComponent(ipId)}/claim`, {}, CLAIM_501],
    ];
    for (const [method, url, payload, expected] of checks) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// C5 (R2) — real mode Story refusals become 501 not_executed
// ---------------------------------------------------------------------------

describe("C5 (R2) real mode Story refusals become 501", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    closeStore();
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    vi.restoreAllMocks();
  });

  async function buildRealApp() {
    process.env.STORY_MOCK = "false";
    resetStoryIPService();
    app = await buildApp();
    return app;
  }

  it("register-capability in real mode returns 501 registerCapabilityAsIP", async () => {
    const a = await buildRealApp();
    const res = await a.inject({ method: "POST", url: "/api/ip/register-capability", payload: CAPABILITY_BODY });
    expect(res.statusCode).toBe(501);
    const body = res.json<{ error: string; operation: string; message: string }>();
    expect(body.error).toBe("not_executed");
    expect(body.operation).toBe("registerCapabilityAsIP");
    expect(body.message).toContain("was NOT executed in real mode");
  });

  it("register-job-evidence in real mode returns 501 registerJobAsDerivative", async () => {
    const a = await buildRealApp();
    const res = await a.inject({
      method: "POST",
      url: "/api/ip/register-job-evidence",
      payload: {
        parentIpId: "0x1111111111111111111111111111111111111111",
        jobId: "job-001",
        evidenceBundleHash: "sha256:test",
        operatorAddress: "0xOP",
        operatorName: "Operator",
      },
    });
    expect(res.statusCode).toBe(501);
    const body = res.json<{ error: string; operation: string; message: string }>();
    expect(body.error).toBe("not_executed");
    expect(body.operation).toBe("registerJobAsDerivative");
    expect(body.message).toContain("was NOT executed in real mode");
  });

  it("GET revenue in real mode returns 501 getRevenueSnapshot", async () => {
    const a = await buildRealApp();
    const res = await a.inject({ method: "GET", url: "/api/ip/0x1111111111111111111111111111111111111111/revenue" });
    expect(res.statusCode).toBe(501);
    const body = res.json<{ error: string; operation: string; message: string }>();
    expect(body.error).toBe("not_executed");
    expect(body.operation).toBe("getRevenueSnapshot");
    expect(body.message).toContain("was NOT executed in real mode");
  });

  it("GET lineage in real mode returns 501 getLineage", async () => {
    const a = await buildRealApp();
    const res = await a.inject({ method: "GET", url: "/api/ip/0x1111111111111111111111111111111111111111/lineage" });
    expect(res.statusCode).toBe(501);
    const body = res.json<{ error: string; operation: string; message: string }>();
    expect(body.error).toBe("not_executed");
    expect(body.operation).toBe("getLineage");
    expect(body.message).toContain("was NOT executed in real mode");
  });

  it("GET capability in real mode returns 501 getIPRegistration", async () => {
    const a = await buildRealApp();
    const res = await a.inject({ method: "GET", url: "/api/ip/capability/cap-nyc-fdm" });
    expect(res.statusCode).toBe(501);
    const body = res.json<{ error: string; operation: string; message: string }>();
    expect(body.error).toBe("not_executed");
    expect(body.operation).toBe("getIPRegistration");
    expect(body.message).toContain("was NOT executed in real mode");
  });

  it("POST dispute in real mode returns 501 raiseDispute", async () => {
    const a = await buildRealApp();
    const res = await a.inject({
      method: "POST",
      url: "/api/ip/0x1111111111111111111111111111111111111111/dispute",
      payload: { evidenceHash: "sha256:test", reason: "bad" },
    });
    expect(res.statusCode).toBe(501);
    const body = res.json<{ error: string; operation: string; message: string }>();
    expect(body.error).toBe("not_executed");
    expect(body.operation).toBe("raiseDispute");
    expect(body.message).toContain("was NOT executed in real mode");
  });
});

// ---------------------------------------------------------------------------
// C6 (R2) — isStoryNotExecuted boundary in mock mode
// ---------------------------------------------------------------------------

describe("C6 (R2) isStoryNotExecuted boundary", () => {
  let app: FastifyInstance;
  let ipId: string;

  beforeEach(async () => {
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    app = await buildApp();
    const regRes = await app.inject({ method: "POST", url: "/api/ip/register-capability", payload: CAPABILITY_BODY });
    ipId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    vi.restoreAllMocks();
  });

  it("generic error from getRevenueSnapshot gives 500 revenue_snapshot_failed", async () => {
    vi.spyOn(StoryIPService.prototype, "getRevenueSnapshot").mockRejectedValueOnce(new Error("boom"));
    const res = await app.inject({ method: "GET", url: `/api/ip/${encodeURIComponent(ipId)}/revenue` });
    expect(res.statusCode).toBe(500);
    const body = res.json<{ error: string; message: string }>();
    expect(body.error).toBe("revenue_snapshot_failed");
    expect(body.message).toBe("boom");
  });

  it("generic error from raiseDispute gives 500 raise_dispute_failed", async () => {
    vi.spyOn(StoryIPService.prototype, "raiseDispute").mockRejectedValueOnce(new Error("boom"));
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/dispute`,
      payload: { evidenceHash: "sha256:test", reason: "bad" },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json<{ error: string; message: string }>();
    expect(body.error).toBe("raise_dispute_failed");
    expect(body.message).toBe("boom");
  });

  it("error with code SOMETHING_ELSE gives 500", async () => {
    vi.spyOn(StoryIPService.prototype, "getRevenueSnapshot").mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "SOMETHING_ELSE" }),
    );
    const res = await app.inject({ method: "GET", url: `/api/ip/${encodeURIComponent(ipId)}/revenue` });
    expect(res.statusCode).toBe(500);
    const body = res.json<{ error: string; message: string }>();
    expect(body.error).toBe("revenue_snapshot_failed");
    expect(body.message).toBe("x");
  });

  it("non-instance error with code STORY_NOT_EXECUTED gives 501 with operation null", async () => {
    vi.spyOn(StoryIPService.prototype, "getRevenueSnapshot").mockRejectedValueOnce(
      Object.assign(new Error("y"), { code: "STORY_NOT_EXECUTED" }),
    );
    const res = await app.inject({ method: "GET", url: `/api/ip/${encodeURIComponent(ipId)}/revenue` });
    expect(res.statusCode).toBe(501);
    const body = res.json<{ error: string; operation: unknown; message: string }>();
    expect(body.error).toBe("not_executed");
    expect(body.operation).toBeNull();
    expect(body.message).toBe("y");
  });
});

// ---------------------------------------------------------------------------
// C7 (R3) — Story routes carry simulated: true in mock mode
// ---------------------------------------------------------------------------

describe("C7 (R3) Story routes carry simulated true", () => {
  let app: FastifyInstance;
  let ipId: string;

  beforeEach(async () => {
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    app = await buildApp();
    const regRes = await app.inject({ method: "POST", url: "/api/ip/register-capability", payload: CAPABILITY_BODY });
    ipId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    vi.restoreAllMocks();
  });

  it("register-capability 200 body has simulated true", async () => {
    const res = await app.inject({ method: "POST", url: "/api/ip/register-capability", payload: { ...CAPABILITY_BODY, capability: { ...CAPABILITY_BODY.capability, id: "cap-c7-reg" } } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ simulated: unknown }>().simulated).toBe(true);
  });

  it("register-job-evidence 200 body has simulated true", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/register-job-evidence",
      payload: { parentIpId: ipId, jobId: "job-c7", evidenceBundleHash: "sha256:c7", operatorAddress: "0xOP", operatorName: "Operator" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ simulated: unknown }>().simulated).toBe(true);
  });

  it("revenue 200 body has simulated true", async () => {
    const res = await app.inject({ method: "GET", url: `/api/ip/${encodeURIComponent(ipId)}/revenue` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ simulated: unknown }>().simulated).toBe(true);
  });

  it("lineage 200 body has simulated true", async () => {
    const res = await app.inject({ method: "GET", url: `/api/ip/${encodeURIComponent(ipId)}/lineage` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ simulated: unknown }>().simulated).toBe(true);
  });

  it("dispute 200 body has simulated true", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/dispute`,
      payload: { evidenceHash: "sha256:c7", reason: "bad" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ simulated: unknown }>().simulated).toBe(true);
  });

  it("capability/:capabilityId 200 body has simulated true", async () => {
    const res = await app.inject({ method: "GET", url: `/api/ip/capability/${encodeURIComponent(CAPABILITY_BODY.capability.id)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ simulated: unknown }>().simulated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C8 (R3) — DB fallback carries simulated: true
// ---------------------------------------------------------------------------

describe("C8 (R3) DB fallback carries simulated true", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
  });

  it("DB fallback registration body has simulated true", async () => {
    const ipId = "0xcafef00d00000000000000000000000000000001";
    getRepos().story.insertIpRegistration({
      ipId,
      nftTokenId: "9",
      licenseTermsId: "9",
      txHash: "0xtx_db_fallback",
      capabilityId: "cap-nyc-fdm",
      csdUrl: "pcc://capabilities/cap-nyc-fdm",
      chain: "story-aeneid",
      registeredAt: new Date().toISOString(),
    });

    const res = await app.inject({ method: "GET", url: "/api/ip/capability/cap-nyc-fdm" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ registration: { ipId: string }; simulated: unknown }>();
    expect(body.registration.ipId).toBe(ipId);
    expect(body.simulated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C9 (R3) — LicensingEngine routes carry basis prediction
// ---------------------------------------------------------------------------

describe("C9 (R3) LicensingEngine routes carry basis prediction", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
  });

  const termsBody = (ipId: string) => ({
    ipId,
    designerAddress: "0xDESIGNER",
    autoLicense: {
      minRevSharePercent: 5,
      minAssuranceTier: 0,
      allowedCapabilityTypes: ["fdm-printer"],
      allowedKinds: ["base"],
      cloneThreshold: 0.9,
      derivativeThreshold: 0.9,
      commercialUse: true,
      allowedRegions: ["US"],
    },
    standingOffers: [],
    defaultRevShare: 5,
    allowSubDerivatives: true,
    derivativeDecayRate: 0.5,
  });

  it("set-licensing-terms 200 body has basis prediction and persisted false", async () => {
    const ipId = "0xc901000000000000000000000000000000000001";
    const res = await app.inject({ method: "POST", url: "/api/ip/set-licensing-terms", payload: termsBody(ipId) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ basis: unknown; persisted: unknown }>();
    expect(body.basis).toBe("prediction");
    expect(body.persisted).toBe(false);
  });

  it("licensing-terms 200 body has basis prediction and persisted false", async () => {
    const ipId = "0xc902000000000000000000000000000000000002";
    await app.inject({ method: "POST", url: "/api/ip/set-licensing-terms", payload: termsBody(ipId) });
    const res = await app.inject({ method: "GET", url: `/api/ip/${encodeURIComponent(ipId)}/licensing-terms` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ basis: unknown; persisted: unknown }>();
    expect(body.basis).toBe("prediction");
    expect(body.persisted).toBe(false);
  });

  it("derivative-tree 200 body has basis prediction", async () => {
    const ipId = "0xc903000000000000000000000000000000000003";
    const res = await app.inject({ method: "GET", url: `/api/ip/${encodeURIComponent(ipId)}/derivative-tree` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ basis: unknown }>().basis).toBe("prediction");
  });

  it("royalty-distribution 200 body has basis prediction", async () => {
    const ipId = "0xc904000000000000000000000000000000004";
    const res = await app.inject({ method: "GET", url: `/api/ip/${encodeURIComponent(ipId)}/royalty-distribution?amount=1000000` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ basis: unknown }>().basis).toBe("prediction");
  });
});

// ---------------------------------------------------------------------------
// C10 (R2) — real mode refuses GET capability even when a registration row exists
// ---------------------------------------------------------------------------

describe("C10 (R2) real-mode capability refusal ignores a recorded registration", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    closeStore();
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    vi.restoreAllMocks();
  });

  it("GET capability in real mode returns 501 getIPRegistration with a registration row recorded", async () => {
    process.env.STORY_MOCK = "false";
    resetStoryIPService();
    app = await buildApp();
    const ipId = "0xcafef00d00000000000000000000000000000002";
    getRepos().story.insertIpRegistration({
      ipId,
      nftTokenId: "10",
      licenseTermsId: "10",
      txHash: "0xtx_db_real_mode",
      capabilityId: "cap-nyc-fdm",
      csdUrl: "pcc://capabilities/cap-nyc-fdm",
      chain: "story-aeneid",
      registeredAt: new Date().toISOString(),
    });

    const res = await app.inject({ method: "GET", url: "/api/ip/capability/cap-nyc-fdm" });
    expect(res.statusCode).toBe(501);
    const body = res.json<{ error: string; operation: string; registration?: unknown }>();
    expect(body.error).toBe("not_executed");
    expect(body.operation).toBe("getIPRegistration");
    expect(body.registration).toBeUndefined();
    expect(res.body).not.toContain(ipId);
  });
});

// ---------------------------------------------------------------------------
// C11 (R3) — GET revenue sets its own simulated flag
// ---------------------------------------------------------------------------

describe("C11 (R3) revenue sets its own simulated flag", () => {
  let app: FastifyInstance;
  let ipId: string;

  beforeEach(async () => {
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    app = await buildApp();
    const regRes = await app.inject({ method: "POST", url: "/api/ip/register-capability", payload: CAPABILITY_BODY });
    ipId = regRes.json<{ registration: { ipId: string } }>().registration.ipId;
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    process.env.STORY_MOCK = "true";
    resetStoryIPService();
    vi.restoreAllMocks();
  });

  it("revenue 200 body has simulated true when the service snapshot carries no simulated key", async () => {
    vi.spyOn(StoryIPService.prototype, "getRevenueSnapshot").mockResolvedValueOnce({
      ipId,
      vaultAddress: "0x00000000000000000000000000000000000000ab",
      totalRevenue: "0",
      unclaimedRevenue: "0",
      tokenHolders: [],
      lastPaymentAt: "2026-01-01T00:00:00.000Z",
    } as Awaited<ReturnType<StoryIPService["getRevenueSnapshot"]>>);

    const res = await app.inject({ method: "GET", url: `/api/ip/${encodeURIComponent(ipId)}/revenue` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ipId: string; simulated: unknown }>();
    expect(body.ipId).toBe(ipId);
    expect(body.simulated).toBe(true);
  });
});
