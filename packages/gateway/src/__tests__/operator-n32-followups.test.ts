/**
 * N32 follow-ups to PR #362, from its r2 SHIP verdict
 * (rm-n32-362-r2-7fccd046.astra.verdict.md, "New findings, ranked"):
 *
 *   M1  GET /api/operator/approvals treats an explicitly empty kernelId/status filter as
 *       absent, silently broadening the query (operator.ts:290-328) — unsafe beside the
 *       OT-2 poller, which executes every returned record.
 *   M2  GET /api/operator/certifications says certifications are not recorded and that no
 *       store exists (operator.ts:59-64), but machine registration persistently carries the
 *       registrant's own (unverified) certification claims (db/schema/onboarding.ts:33-44).
 *   M3  POST /api/operator/approvals only casts the body (operator.ts:250-256); it never
 *       validates that capabilityType/kernelId/agentId/parameters are the types the public
 *       contract requires.
 *
 * This file is run FIRST at 7fccd046 (before any fix) to confirm each finding reproduces.
 * L1 (the source-ratchet overclaim) is comment-only and has no test here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq } from "@pcc/store";
import { operatorRoutes } from "../routes/operator.js";
import { initStore, closeStore, getStore, getRepos } from "../db.js";

describe("N32 follow-up M1: GET /api/operator/approvals empty named filters", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(operatorRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  async function submit(kernelId: string, agentId: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/approvals",
      payload: { kernelId, agentId, capabilityType: "fdm", autoApprove: true },
    });
    expect(res.statusCode).toBe(200);
    return res.json().approval as { id: string };
  }

  it("reproduction: an explicitly empty kernelId must not broaden the list to every kernel's approved records", async () => {
    await submit("kernel-nyc", "agent-nyc");
    await submit("kernel-sf", "agent-sf");

    // Verdict's cheapest reproduction: approved records for two kernels; this must be 400,
    // not both records.
    const res = await app.inject({ method: "GET", url: "/api/operator/approvals?kernelId=&status=approved" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_query" });
  });

  it("reproduction: a whitespace-only kernelId is also rejected, not treated as absent or as a literal filter", async () => {
    const res = await app.inject({ method: "GET", url: "/api/operator/approvals?kernelId=%20%20&status=approved" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_query" });
  });

  it("reproduction: an explicitly empty status alone must not broaden the list to every status", async () => {
    const res = await app.inject({ method: "GET", url: "/api/operator/approvals?status=" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_query" });
  });
});

describe("N32 follow-up M2: GET /api/operator/certifications wording", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(operatorRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("reproduction: registration records the registrant's own certification claims, but the 501 claims nothing is recorded", async () => {
    // Mirrors the registration object onboard.ts's POST /api/onboard/register builds
    // (routes/onboard.ts:62-98), inserted directly via the repo to avoid that route's
    // audit/telemetry/posthog side effects.
    const repos = getRepos();
    repos.registrations.insert({
      id: "reg-n32-m2",
      name: "Test Machine",
      category: "fdm",
      manufacturer: "Prusa",
      model: "MK4",
      serialNumber: undefined,
      description: undefined,
      photos: [],
      capabilities: [] as any,
      spaceRequirements: {} as any,
      pricing: { baseCost: "0", minimum: "0", currency: "USDC" } as any,
      operator: {
        walletAddress: "0xoperator",
        displayName: "Test Operator",
        certifications: [
          { id: "cert-1", name: "ISO-9001", issuer: "ISO", issuedAt: "2024-01-01", expiresAt: "2030-01-01", status: "active" },
        ],
        trainingAcknowledgments: {},
      } as any,
      complianceRegulations: undefined,
      tenantId: null,
      status: "submitted",
      createdAt: new Date().toISOString(),
      submittedAt: new Date().toISOString(),
    });

    // The claim really is recorded (db/schema/onboarding.ts:33-44).
    const stored = repos.registrations.findById("reg-n32-m2") as any;
    expect(stored?.operator?.certifications).toHaveLength(1);

    const res = await app.inject({ method: "GET", url: "/api/operator/certifications" });
    expect(res.statusCode).toBe(501);
    const body = res.json();
    expect(body.error).toBe("not_available");
    // The old wording ("not recorded" / "no certification store") contradicts the row
    // above. It must say there is no VERIFIED certification read, not that nothing is
    // stored.
    expect(body.message).toMatch(/verified/i);
    expect(body.message).not.toMatch(/no certification store/i);
  });
});

describe("N32 follow-up M3: POST /api/operator/approvals body type validation", () => {
  let app: FastifyInstance;
  const KERNEL = "kernel-nyc"; // seeded

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(operatorRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  function storedRow(id: string) {
    return getStore().db.select().from(schema.pendingApprovals).where(eq(schema.pendingApprovals.id, id)).get();
  }

  it("reproduction (verdict's cheapest repro): a non-string capabilityType is accepted as 200 instead of rejected as 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/approvals",
      payload: { kernelId: KERNEL, agentId: "agent-m3-captype", capabilityType: { unexpected: true } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reproduction: a rejected capabilityType must not be stored", async () => {
    const before = (await app.inject({ method: "GET", url: `/api/operator/approvals?kernelId=${KERNEL}` })).json().approvals.length;
    const create = await app.inject({
      method: "POST",
      url: "/api/operator/approvals",
      payload: { kernelId: KERNEL, agentId: "agent-m3-captype-2", capabilityType: { unexpected: true } },
    });
    if (create.statusCode === 200) {
      expect(storedRow(create.json().approval.id)).not.toHaveProperty("jobSummary.capabilityType.unexpected");
    }
    const after = (await app.inject({ method: "GET", url: `/api/operator/approvals?kernelId=${KERNEL}` })).json().approvals.length;
    expect(after).toBe(before);
  });

  it("reproduction: a non-string agentId is accepted instead of rejected as 400 (same check as kernelId)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/approvals",
      payload: { kernelId: KERNEL, agentId: 12345, capabilityType: "fdm" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reproduction: a parameters array is accepted instead of rejected as 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/approvals",
      payload: { kernelId: KERNEL, agentId: "agent-m3-params-arr", capabilityType: "fdm", parameters: ["a", "b"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reproduction: an explicit null parameters is silently substituted with {} instead of rejected as 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/approvals",
      payload: { kernelId: KERNEL, agentId: "agent-m3-params-null", capabilityType: "fdm", parameters: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps accepting a valid body unchanged (positive control)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/approvals",
      payload: { kernelId: KERNEL, agentId: "agent-m3-valid", capabilityType: "fdm", parameters: { a: 1 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().approval.jobSummary).toMatchObject({ capabilityType: "fdm", parameters: { a: 1 } });
  });
});
