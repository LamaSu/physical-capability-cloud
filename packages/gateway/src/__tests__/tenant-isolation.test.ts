/**
 * Wave 4.1 — Cross-tenant leak prevention tests for the registration surface.
 *
 * These tests pin down the behavior of the TENANT_ENFORCE feature flag.
 * The repo-layer tri-state semantics live in
 * packages/db/src/__tests__/registrations-tenant.test.ts; here we exercise
 * the route layer end-to-end using fastify.inject().
 *
 * Pattern mirrors tier2-operators.test.ts: a preHandler injects req.tenantId
 * the way the T1.9 tenantContext middleware would after authenticating an
 * API key. We don't run apiGate so the test stays focused on tenant
 * scoping, not auth.
 *
 * The TENANT_ENFORCE flag is read per-call via isTenantEnforceOn() inside
 * tenantOpts(), so we can toggle it via process.env without resetting modules.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { onboardRoutes } from "../routes/onboard.js";
import { operatorsPublicRoutes } from "../routes/operators-public.js";
import { initStore, closeStore, getRepos } from "../db.js";

// External services mocked the same way tier2-operators.test.ts does.
vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));
vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: {
    emit: vi.fn(),
    getTimeline: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({}),
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────

interface BuildOpts {
  /** Inject this tenantId on every request (simulates tenantContext middleware). */
  tenantId?: string | null;
  /** Inject this operatorId so PATCH ownership checks pass. */
  operatorId?: string;
}

async function buildApp(opts: BuildOpts = {}): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    if (opts.tenantId !== undefined) (req as any).tenantId = opts.tenantId;
    if (opts.operatorId) (req as any).operatorId = opts.operatorId;
  });
  await app.register(onboardRoutes);
  await app.register(operatorsPublicRoutes);
  await app.ready();
  return app;
}

interface RegisterOpts {
  name?: string;
  complianceRegulations?: string[];
  operatorWallet?: string;
}

async function registerMachine(app: FastifyInstance, opts: RegisterOpts = {}): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/onboard/register",
    payload: {
      name: opts.name ?? "Test Printer",
      category: "fdm",
      manufacturer: "Test Co",
      model: "TestBot",
      complianceRegulations: opts.complianceRegulations,
      operator: opts.operatorWallet
        ? {
            walletAddress: opts.operatorWallet,
            displayName: "Test Operator",
            certifications: [],
            trainingAcknowledgments: {},
          }
        : undefined,
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().registration.id;
}

// Direct repo insert — doesn't rely on the route layer's tenantId backfill.
function seedRow(opts: {
  id: string;
  tenantId: string | null;
  compliance?: string[];
  operatorWallet?: string;
}) {
  getRepos().registrations.insert({
    id: opts.id,
    name: opts.id,
    category: "fdm",
    manufacturer: "Acme",
    model: "X",
    photos: [],
    capabilities: [] as any,
    spaceRequirements: {} as any,
    pricing: { baseCost: "0", minimum: "0", currency: "USDC" } as any,
    operator: {
      walletAddress: opts.operatorWallet ?? "0x0",
      displayName: "Op",
      certifications: [],
      trainingAcknowledgments: {},
    } as any,
    complianceRegulations: opts.compliance,
    tenantId: opts.tenantId ?? undefined,
    status: "submitted",
    createdAt: new Date().toISOString(),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Wave 4.1 — TENANT_ENFORCE=false (default)", () => {
  let prevEnv: string | undefined;
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    prevEnv = process.env.TENANT_ENFORCE;
    delete process.env.TENANT_ENFORCE;
    app = await buildApp({ tenantId: "alpha" });
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    if (prevEnv !== undefined) process.env.TENANT_ENFORCE = prevEnv;
  });

  it("GET /api/onboard/registrations returns ALL rows regardless of tenant (today's behavior)", async () => {
    seedRow({ id: "reg-a", tenantId: "alpha" });
    seedRow({ id: "reg-b", tenantId: "beta" });
    seedRow({ id: "reg-anon", tenantId: null });

    const res = await app.inject({ method: "GET", url: "/api/onboard/registrations" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // With TENANT_ENFORCE off, alpha sees ALL three rows (today's cross-tenant default).
    expect(body.registrations.map((r: any) => r.id).sort()).toEqual(["reg-a", "reg-anon", "reg-b"]);
  });
});

describe("Wave 4.1 — TENANT_ENFORCE=true", () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    prevEnv = process.env.TENANT_ENFORCE;
    process.env.TENANT_ENFORCE = "true";
  });

  afterEach(() => {
    closeStore();
    if (prevEnv === undefined) delete process.env.TENANT_ENFORCE;
    else process.env.TENANT_ENFORCE = prevEnv;
  });

  it("GET /api/onboard/registrations as alpha returns only alpha rows", async () => {
    const app = await buildApp({ tenantId: "alpha" });
    seedRow({ id: "reg-alpha-1", tenantId: "alpha" });
    seedRow({ id: "reg-beta-1", tenantId: "beta" });
    seedRow({ id: "reg-anon", tenantId: null });

    const res = await app.inject({ method: "GET", url: "/api/onboard/registrations" });
    expect(res.statusCode).toBe(200);
    expect(res.json().registrations.map((r: any) => r.id)).toEqual(["reg-alpha-1"]);
    await app.close();
  });

  it("GET /api/onboard/registrations as anonymous returns only public-discovery (NULL tenant) rows", async () => {
    const app = await buildApp({ tenantId: null });
    seedRow({ id: "reg-alpha-1", tenantId: "alpha" });
    seedRow({ id: "reg-anon", tenantId: null });

    const res = await app.inject({ method: "GET", url: "/api/onboard/registrations" });
    expect(res.statusCode).toBe(200);
    // Anonymous caller sees only the public-discovery row, NOT alpha's row.
    expect(res.json().registrations.map((r: any) => r.id)).toEqual(["reg-anon"]);
    await app.close();
  });

  it("POST /api/onboard/register attaches tenantId from req at insert time", async () => {
    const app = await buildApp({ tenantId: "alpha" });
    const regId = await registerMachine(app, { name: "Alpha-owned" });
    const repos = getRepos();
    const row = repos.registrations.findById(regId);
    expect(row).toBeDefined();
    expect(row!.tenantId).toBe("alpha");
    await app.close();
  });

  it("GET /api/operators/by-compliance/:regulationId scopes to req.tenantId", async () => {
    const app = await buildApp({ tenantId: "alpha" });
    seedRow({ id: "reg-alpha-iso", tenantId: "alpha", compliance: ["ISO-9001:2015"] });
    seedRow({ id: "reg-beta-iso", tenantId: "beta", compliance: ["ISO-9001:2015"] });
    seedRow({ id: "reg-anon-iso", tenantId: null, compliance: ["ISO-9001:2015"] });

    const res = await app.inject({
      method: "GET",
      url: "/api/operators/by-compliance/ISO-9001:2015",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Buyer-alpha sees ONLY their own tenant's compliance-flagged operators.
    expect(body.count).toBe(1);
    expect(body.operators.map((r: any) => r.id)).toEqual(["reg-alpha-iso"]);
    await app.close();
  });

  it("PATCH /api/onboard/registrations/:id ownership check is unchanged regardless of TENANT_ENFORCE", async () => {
    // The PATCH ownership check uses operator.walletAddress, NOT tenantId.
    // Tenant scoping is orthogonal to per-resource ownership: a non-owner
    // caller still gets 403 even when TENANT_ENFORCE is on and the row is
    // in the caller's tenant.
    const ownerWallet = "0xowner000000000000000000000000000000acme";
    const interloperWallet = "0xinterloperaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const app = await buildApp({ tenantId: "alpha", operatorId: interloperWallet });
    seedRow({
      id: "reg-owned",
      tenantId: "alpha",
      operatorWallet: ownerWallet,
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/onboard/registrations/reg-owned`,
      payload: { description: "trying to hijack" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    await app.close();
  });
});
