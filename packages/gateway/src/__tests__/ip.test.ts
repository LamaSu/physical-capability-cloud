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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ipRoutes } from "../routes/ip.js";
import { initStore, closeStore } from "../db.js";
import { resetStoryIPService } from "@pcc/contracts";

// Ensure mock mode for all tests
process.env.STORY_MOCK = "true";

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

  it("returns 200 with txHash and distributed count", async () => {
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

    expect(res.statusCode).toBe(200);
    const body = res.json<{ txHash: string; distributed: number }>();
    expect(body.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(body.distributed).toBe(100);
  });

  it("returns 400 when splits do not sum to 100", async () => {
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

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("splits_must_sum_to_100");
  });

  it("returns 400 when splits array is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/distribute-royalties",
      payload: { ipId, splits: [] },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when ipId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ip/distribute-royalties",
      payload: {
        splits: [{ address: "0xAAAA", role: "designer", percentage: 100, label: "All" }],
      },
    });

    expect(res.statusCode).toBe(400);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ADR-12: extended ContributorRole taxonomy
  //
  // The new 10-value role enum (operator/verifier/insurer/integrator/
  // protocol-author/model-author/dataset-contributor/curator/assembler/
  // network-treasury) must be accepted, and the legacy aliases (`designer`,
  // `network`) must continue to decode without error so older clients keep
  // working. The route's only runtime validation is the sum-to-100 check;
  // these tests pin the contract that role strings are passed through.
  // ─────────────────────────────────────────────────────────────────────────

  it("accepts the ADR-12 contributor-economics-with-ai split (6 new-taxonomy roles)", async () => {
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

    expect(res.statusCode).toBe(200);
    const body = res.json<{ txHash: string; distributed: number }>();
    expect(body.distributed).toBe(100);
  });

  it("backward compat: legacy `designer` role still decodes", async () => {
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

    expect(res.statusCode).toBe(200);
    expect(res.json<{ distributed: number }>().distributed).toBe(100);
  });

  it("backward compat: legacy `network` role (alias for network-treasury) still decodes", async () => {
    // The gateway types splits[].role as ContributorRole, which does NOT
    // include the pre-ADR-12 `network` literal — that string was only ever
    // present in story-defaults.ts and a2a IPRevenueSplitEntry. The route
    // does no runtime enum validation though, so older clients still
    // ship-through. We cast the payload to keep the test honest about what
    // it asserts: runtime tolerance for legacy `network` strings, not type
    // membership.
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

    expect(res.statusCode).toBe(200);
    expect(res.json<{ distributed: number }>().distributed).toBe(100);
  });

  it("accepts insurer and dataset-contributor roles introduced by ADR-12", async () => {
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

    expect(res.statusCode).toBe(200);
    expect(res.json<{ distributed: number }>().distributed).toBe(100);
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

  it("returns 200 with txHash", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/pay`,
      payload: { amount: "500", payerAddress: "0xPAYER" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ txHash: string }>();
    expect(body.txHash).toMatch(/^0x[0-9a-f]+$/i);
  });

  it("returns 400 when amount is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/pay`,
      payload: { payerAddress: "0xPAYER" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when payerAddress is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/pay`,
      payload: { amount: "500" },
    });

    expect(res.statusCode).toBe(400);
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

  it("returns 200 with txHash and claimed amount", async () => {
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

    expect(res.statusCode).toBe(200);
    const body = res.json<{ txHash: string; claimed: string }>();
    expect(body.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(body.claimed).toBe("1000");
  });

  it("returns claimed=0 when vault is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/claim`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ claimed: string }>();
    expect(body.claimed).toBe("0");
  });

  it("accepts optional tokenIds", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/claim`,
      payload: { tokenIds: ["tok1", "tok2"] },
    });

    expect(res.statusCode).toBe(200);
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

  it("reflects payments in revenue snapshot", async () => {
    await app.inject({
      method: "POST",
      url: `/api/ip/${encodeURIComponent(ipId)}/pay`,
      payload: { amount: "250", payerAddress: "0xPAYER" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/ip/${encodeURIComponent(ipId)}/revenue`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ totalRevenue: string }>();
    expect(body.totalRevenue).toBe("250");
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

  it("distribute-royalties persists splits to DB", async () => {
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

    expect(res.statusCode).toBe(200);

    const { getRepos } = await import("../db.js");
    const repos = getRepos();
    const dbSplits = repos.story.findRoyaltySplitsByIp(ipId);
    expect(dbSplits).toHaveLength(2);
    expect(dbSplits.map((s) => s.address)).toContain("0xAAAA");
    expect(dbSplits.map((s) => s.address)).toContain("0xBBBB");
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

  it("claim persists to DB revenue claims", async () => {
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

    expect(claimRes.statusCode).toBe(200);

    const { getRepos } = await import("../db.js");
    const repos = getRepos();
    const claims = repos.story.findRevenueClaimsByIp(ipId);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0].amount).toBe("100");
  });
});
