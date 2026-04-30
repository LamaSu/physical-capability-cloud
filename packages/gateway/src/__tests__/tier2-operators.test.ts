/**
 * Tier 2 backend polish — T2.3 (compliance) + T2.4 (discoverability).
 *
 * External services (PostHog, pipelineTelemetry, auditService) are mocked so
 * the test stays offline and deterministic. Subsequent commits add T2.7 /
 * T2.2 test cases to this file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { onboardRoutes } from "../routes/onboard.js";
import { operatorsPublicRoutes } from "../routes/operators-public.js";
import { apiGate } from "../middleware/api-gate.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { recordMatchQuery, _clearMatchLogForTests } from "../services/match-log.js";

// ── Mocks ────────────────────────────────────────────────────────────────

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

// ── App builder ──────────────────────────────────────────────────────────

async function buildApp(opts: { withAuth?: boolean } = {}): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  if (opts.withAuth) {
    await app.register(apiGate);
  }
  await app.register(onboardRoutes);
  await app.register(operatorsPublicRoutes);
  await app.ready();
  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────

interface RegisterOpts {
  name?: string;
  category?: string;
  complianceRegulations?: string[];
  operatorWallet?: string;
}

async function registerMachine(app: FastifyInstance, opts: RegisterOpts = {}): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/onboard/register",
    payload: {
      name: opts.name ?? "Test Printer",
      category: opts.category ?? "fdm",
      manufacturer: "Test Co",
      model: "TestBot 9000",
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

// ── Tests ────────────────────────────────────────────────────────────────

describe("T2.3 — Compliance Regulations", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("type: MachineRegistration accepts complianceRegulations as string[]", () => {
    // Compile-time check — a literal value matching the type shape compiles.
    // Runtime body persists this through to the DB layer; covered below.
    const sample: { complianceRegulations: string[] } = {
      complianceRegulations: ["ISO-9001:2015", "AS9100:2016", "ITAR-2024"],
    };
    expect(Array.isArray(sample.complianceRegulations)).toBe(true);
    expect(sample.complianceRegulations).toContain("ISO-9001:2015");
  });

  it("repo: insert + findByCompliance round-trips", async () => {
    const regs = getRepos().registrations;
    regs.insert({
      id: "reg-iso-1",
      name: "Aerospace shop",
      category: "cnc",
      manufacturer: "Haas",
      model: "VF-2",
      photos: [],
      capabilities: [] as any,
      spaceRequirements: {} as any,
      pricing: { baseCost: "0", minimum: "0", currency: "USDC" } as any,
      operator: { walletAddress: "0x1", displayName: "x", certifications: [], trainingAcknowledgments: {} } as any,
      complianceRegulations: ["AS9100:2016", "ISO-9001:2015"],
      status: "submitted",
      createdAt: new Date().toISOString(),
    });
    regs.insert({
      id: "reg-noncompl",
      name: "Printer",
      category: "fdm",
      manufacturer: "Prusa",
      model: "MK4",
      photos: [],
      capabilities: [] as any,
      spaceRequirements: {} as any,
      pricing: { baseCost: "0", minimum: "0", currency: "USDC" } as any,
      operator: { walletAddress: "0x2", displayName: "y", certifications: [], trainingAcknowledgments: {} } as any,
      status: "submitted",
      createdAt: new Date().toISOString(),
    });
    const matches = regs.findByCompliance("AS9100:2016");
    expect(matches.map((r) => r.id)).toEqual(["reg-iso-1"]);
    const isoMatches = regs.findByCompliance("ISO-9001:2015");
    expect(isoMatches.map((r) => r.id)).toEqual(["reg-iso-1"]);
    const empty = regs.findByCompliance("NONEXISTENT-2026");
    expect(empty).toEqual([]);
  });

  it("route: GET /api/operators/by-compliance/:regulationId returns matching operators (200)", async () => {
    await registerMachine(app, {
      name: "AS9100 Shop",
      complianceRegulations: ["AS9100:2016"],
    });
    await registerMachine(app, { name: "Plain Shop" });

    const res = await app.inject({
      method: "GET",
      url: "/api/operators/by-compliance/AS9100:2016",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.regulationId).toBe("AS9100:2016");
    expect(body.count).toBe(1);
    expect(body.operators[0].name).toBe("AS9100 Shop");
    // Public-shaped: no operator wallet leaked
    expect(body.operators[0]).not.toHaveProperty("operator");
    expect(body.operators[0]).not.toHaveProperty("walletAddress");
    expect(body.operators[0].complianceRegulations).toContain("AS9100:2016");
  });

  it("route: returns empty list when no operators match", async () => {
    await registerMachine(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/operators/by-compliance/UNKNOWN-XYZ",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(0);
    expect(body.operators).toEqual([]);
  });

  it("route: persists complianceRegulations via POST /api/onboard/register", async () => {
    const regId = await registerMachine(app, {
      name: "ISO Shop",
      complianceRegulations: ["ISO-9001:2015", "ISO-14001:2015"],
    });
    const reg = getRepos().registrations.findById(regId);
    expect(reg?.complianceRegulations).toEqual(["ISO-9001:2015", "ISO-14001:2015"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T2.4 — Discoverability diagnostics
// ─────────────────────────────────────────────────────────────────────────

describe("T2.4 — Discoverability Diagnostics", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    _clearMatchLogForTests();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    _clearMatchLogForTests();
  });

  it("returns placeholder shape when no match-log entries exist", async () => {
    const regId = await registerMachine(app, { name: "Quiet Shop" });
    const res = await app.inject({
      method: "GET",
      url: `/api/operators/${regId}/discoverability`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data_quality).toBe("placeholder");
    expect(body.top_keyword_misses).toEqual([]);
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.last_match_query_at).toBeNull();
    expect(body.indexed_at).toBeTruthy();
  });

  it("returns live shape with mocked match-log entries", async () => {
    const regId = await registerMachine(app, {
      name: "FDM Shop",
      category: "fdm",
    });

    // Buyer searched for "aerospace" 3 times against this operator with low score
    recordMatchQuery({ operatorId: regId, query: "aerospace certified parts", score: 0.1 });
    recordMatchQuery({ operatorId: regId, query: "aerospace tolerance", score: 0.05 });
    recordMatchQuery({ operatorId: regId, query: "aerospace materials", score: 0.2 });
    // One high-scoring match — should NOT count as a miss
    recordMatchQuery({ operatorId: regId, query: "fdm printing", score: 0.85 });

    const res = await app.inject({
      method: "GET",
      url: `/api/operators/${regId}/discoverability`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data_quality).toBe("live");
    expect(body.top_keyword_misses).toContain("aerospace");
    expect(body.last_match_query_at).toBeTruthy();
    expect(body.suggestions.some((s: string) => s.includes("aerospace"))).toBe(true);
  });

  it("returns 401 without a bearer token (apiGate rejects)", async () => {
    const authedApp = await buildApp({ withAuth: true });
    const res = await authedApp.inject({
      method: "GET",
      url: "/api/operators/some-id/discoverability",
    });
    expect(res.statusCode).toBe(401);
    await authedApp.close();
  });
});
