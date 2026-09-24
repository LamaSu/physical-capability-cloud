/**
 * ProductHomeDTO (PX-7, shell #2007 / product-steward #2170). The negative tests pin what the
 * home page used to show: invented kernel and job counts, a count of the first page as the
 * total, and a "Total Value Locked" that summed every escrow total (refunded, released and
 * mock escrows included).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { HELD_MILESTONE_STATUSES, NOT_HELD_MILESTONE_STATUSES } from "@pcc/spec";
import {
  buildCapabilities,
  buildEscrowHeld,
  buildJobs,
  buildKernels,
  buildProductHomeDTO,
  type ProductHomeSources,
} from "../../readmodels/product-home.js";

const AS_OF = "2026-09-24T12:00:00.000Z";
const NOW = Date.parse(AS_OF);
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe("kernels", () => {
  it("counts online, stale and other with the kernel read model's own rule", () => {
    const k = buildKernels(
      {
        kernels: [
          { id: "fresh", status: "online", lastHeartbeat: ago(1 * MIN) },
          { id: "old", status: "online", lastHeartbeat: ago(10 * MIN) },
          { id: "listed-old", status: "online", lastHeartbeat: ago(10 * MIN) },
          { id: "never", status: "online", lastHeartbeat: null },
          { id: "off", status: "offline", lastHeartbeat: ago(1 * MIN) },
          { id: "maint", status: "maintenance", lastHeartbeat: null },
        ],
        capabilities: [{ kernelId: "listed-old" }],
      },
      NOW,
    );
    // A kernel that lists a capability gets the longer grace; one with no heartbeat is stale.
    expect(k).toMatchObject({ total: 6, online: 2, stale: 2, other: 2, source: "gateway_kernel_rows" });
    expect(k.rule).toMatch(/5 minutes/);
  });
});

describe("capabilities", () => {
  const kernels = [
    { id: "k-live", status: "online", lastHeartbeat: ago(1 * MIN) },
    // Past the 24-hour listing grace (it lists a capability, so the 5-minute window does not apply).
    { id: "k-stale", status: "online", lastHeartbeat: new Date(NOW - 30 * 3_600_000).toISOString() },
    { id: "k-off", status: "offline", lastHeartbeat: ago(1 * MIN) },
  ];

  it("counts listed capabilities per type, and those on a kernel online by the kernel rule", () => {
    const c = buildCapabilities(
      {
        kernels,
        capabilities: [
          { kernelId: "k-live", type: "3d-printing" },
          { kernelId: "k-live", type: "cnc" },
          { kernelId: "k-stale", type: "3d-printing" },
          { kernelId: "k-off", type: "cnc" },
          { kernelId: "k-gone", type: "cnc" },
          { kernelId: "k-live", type: "  " },
        ],
      },
      NOW,
    );
    expect(c).toMatchObject({ state: "read", total: 6, onOnlineKernels: 3, source: "gateway_capability_rows" });
    expect(c.byType).toEqual([
      { type: "3d-printing", total: 2, onOnlineKernels: 1 },
      { type: "cnc", total: 3, onOnlineKernels: 1 },
      { type: null, total: 1, onOnlineKernels: 1 },
    ]);
  });

  it("NEGATIVE: a capability on a stale, offline or missing kernel is listed but never counted as on an online kernel", () => {
    const c = buildCapabilities(
      { kernels, capabilities: ["k-stale", "k-off", "k-gone"].map((kernelId) => ({ kernelId, type: "cnc" })) },
      NOW,
    );
    expect(c.total).toBe(3);
    expect(c.onOnlineKernels).toBe(0);
  });
});

describe("jobs", () => {
  it("counts by execution phase; active is known and unfinished", () => {
    const j = buildJobs([
      { status: "pending" },
      { status: "queued" },
      { status: "executing" },
      { status: "paused" },
      { status: "completed" },
      { status: "settled" },
      { status: "failed" },
      { status: "done" },
    ]);
    expect(j.total).toBe(8);
    expect(j.active).toBe(4);
    expect(j.byPhase).toMatchObject({ pending: 1, queued: 1, running: 1, paused: 1, completed: 2, failed: 1, unknown: 1 });
  });

  it("NEGATIVE: an undocumented status is unknown and never active", () => {
    const j = buildJobs([{ status: "done" }, { status: "" }, {}]);
    expect(j.active).toBe(0);
    expect(j.byPhase.unknown).toBe(3);
  });
});

describe("escrowHeld", () => {
  const escrows = [
    { id: "e-usdc", contractAddress: "0x3333333333333333333333333333333333333333", currency: "USDC" },
    { id: "e-eur", contractAddress: "0x4444444444444444444444444444444444444444", currency: "EUR" },
    { id: "e-mock", contractAddress: "mock-escrow-abc", currency: "USDC" },
    { id: "e-doge", contractAddress: "0x5555555555555555555555555555555555555555", currency: "DOGE" },
  ];

  it("sums MILESTONE amounts in held states per currency, never escrow totals", () => {
    const h = buildEscrowHeld({
      escrows,
      milestones: [
        { escrowId: "e-usdc", amount: "12.50", status: "funded" },
        { escrowId: "e-usdc", amount: "7.50", status: "locked" },
        { escrowId: "e-usdc", amount: "1.00", status: "releasing" },
        { escrowId: "e-eur", amount: "3.25", status: "disputed" },
      ],
    });
    expect(h.byCurrency).toEqual([
      { currency: "EUR", decimals: 2, amountBaseUnits: "325", milestones: 1 },
      { currency: "USDC", decimals: 6, amountBaseUnits: "21000000", milestones: 3 },
    ]);
    expect(h).toMatchObject({ source: "gateway_escrow_record", confirmation: "record_only" });
  });

  it("NEGATIVE: released, refunded, slashed and never-funded milestones are not held", () => {
    const h = buildEscrowHeld({
      escrows,
      milestones: ["released", "refunded", "slashed", "created", "unfunded", "pending", "SETTLED_RELEASED", "SETTLED_REFUNDED"].map((status) => ({
        escrowId: "e-usdc",
        amount: "100",
        status,
      })),
    });
    expect(h.byCurrency).toEqual([]);
    expect(h.unclassifiedMilestones).toBe(0);
  });

  it("NEGATIVE: a mock escrow is excluded entirely, even with held milestones", () => {
    const h = buildEscrowHeld({ escrows, milestones: [{ escrowId: "e-mock", amount: "500", status: "funded" }] });
    expect(h.byCurrency).toEqual([]);
    expect(h.excludedSimulatedEscrows).toBe(1);
  });

  it("NEGATIVE: an unknown word is unclassified, and an inexact amount or unknown currency is uncounted, never summed", () => {
    const h = buildEscrowHeld({
      escrows,
      milestones: [
        { escrowId: "e-usdc", amount: "5", status: "completed" },
        { escrowId: "e-usdc", amount: "5", status: "mystery" },
        { escrowId: "e-doge", amount: "5", status: "funded" },
        { escrowId: "e-usdc", amount: "0.1234567", status: "funded" },
        { escrowId: "e-missing", amount: "5", status: "funded" },
      ],
    });
    expect(h.byCurrency).toEqual([]);
    expect(h.unclassifiedMilestones).toBe(2);
    expect(h.uncountedMilestones).toBe(3);
  });

  it("the held and not-held word sets are disjoint and published in the DTO", () => {
    const held = new Set(HELD_MILESTONE_STATUSES);
    for (const w of NOT_HELD_MILESTONE_STATUSES) expect(held.has(w), w).toBe(false);
    expect(buildEscrowHeld({ escrows: [], milestones: [] }).heldStatuses).toEqual(HELD_MILESTONE_STATUSES);
  });
});

describe("buildProductHomeDTO", () => {
  const sources = (over: Partial<ProductHomeSources> = {}): ProductHomeSources => ({
    kernels: { ok: true, value: { kernels: [], capabilities: [] } },
    jobs: { ok: true, value: [] },
    escrow: { ok: true, value: { escrows: [], milestones: [] } },
    network: "base-sepolia",
    ...over,
  });

  it("carries the schema id, the read time and the configured network with its chain id", () => {
    const dto = buildProductHomeDTO(sources(), AS_OF);
    expect(dto.schemaId).toBe("pcc.product-home/v1");
    expect(dto.asOf).toBe(AS_OF);
    expect(dto.settlementNetwork).toEqual({ name: "base-sepolia", chainId: 84532, basis: "gateway_config" });
    expect(buildProductHomeDTO(sources({ network: "mystery-net" }), AS_OF).settlementNetwork.chainId).toBeNull();
    expect(buildProductHomeDTO(sources({ network: null }), AS_OF).settlementNetwork.name).toBeNull();
  });

  it("a section the route withholds from this caller is unavailable with the route's reason", () => {
    const dto = buildProductHomeDTO(sources({ escrow: { ok: false, withheld: "no tenant on escrow records" } }), AS_OF);
    expect(dto.escrowHeld).toEqual({ state: "unavailable", reason: "no tenant on escrow records" });
  });

  it("NEGATIVE: a section that could not be read is unavailable with a reason, never zero", () => {
    const dto = buildProductHomeDTO(sources({ kernels: { ok: false }, jobs: { ok: false }, escrow: { ok: false } }), AS_OF);
    for (const section of [dto.kernels, dto.capabilities, dto.jobs, dto.escrowHeld]) {
      expect(section.state).toBe("unavailable");
      expect((section as { reason: string }).reason).toMatch(/could not be read/);
    }
  });
});

describe("GET /api/product/home on a real store", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    const db = await import("../../db.js");
    db.initStore({ seed: true });
    const { productHomeRoutes } = await import("../../routes/product-home.js");
    app = Fastify({ logger: false });
    app.addHook("onRequest", async (req) => {
      const t = req.headers["x-test-tenant"];
      if (typeof t === "string") (req as any).tenantId = t;
    });
    await app.register(productHomeRoutes);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    (await import("../../db.js")).closeStore();
    delete process.env.TENANT_ENFORCE;
  });

  it("answers every section from the gateway's records, no-store", async () => {
    const res = await app.inject({ method: "GET", url: "/api/product/home" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const dto = res.json();
    expect(dto.kernels.state).toBe("read");
    expect(dto.kernels.total).toBeGreaterThan(0);
    expect(dto.capabilities.state).toBe("read");
    expect(dto.capabilities.total).toBeGreaterThan(0);
    expect(dto.capabilities.byType.reduce((n: number, t: { total: number }) => n + t.total, 0)).toBe(dto.capabilities.total);
    expect(dto.jobs.state).toBe("read");
    expect(dto.jobs.total).toBeGreaterThan(0);
    expect(dto.escrowHeld.state).toBe("read");
    expect(dto.settlementNetwork.basis).toBe("gateway_config");
  });

  it("NEGATIVE: under TENANT_ENFORCE escrow is unavailable, and a caller with no tenant gets no job counts", async () => {
    process.env.TENANT_ENFORCE = "true";
    try {
      const none = (await app.inject({ method: "GET", url: "/api/product/home" })).json();
      expect(none.escrowHeld.state).toBe("unavailable");
      expect(none.escrowHeld.reason).toMatch(/no tenant/);
      expect(none.jobs.state).toBe("unavailable");
      expect(none.jobs.reason).toMatch(/no tenant/);
      const withTenant = (await app.inject({ method: "GET", url: "/api/product/home", headers: { "x-test-tenant": "tenant-x" } })).json();
      expect(withTenant.jobs).toMatchObject({ state: "read", total: 0 });
    } finally {
      delete process.env.TENANT_ENFORCE;
    }
  });
});
