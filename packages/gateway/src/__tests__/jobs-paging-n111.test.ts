import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { getJobFacade } from "../facades/index.js";

/**
 * N111 — GET /api/jobs ignores its limit.
 *
 * jobs.ts types `offset`/`limit` as numbers in the route generic but declares
 * no querystring schema, so Fastify leaves them as raw strings. job.facade.ts
 * then does `jobs.slice(offset, offset + limit)` — since `offset` is a
 * string, `offset + limit` is STRING CONCATENATION, not addition
 * ("10" + "50" = "1050"), and `hasMore: offset + limit < total` compares that
 * concatenated string against a number.
 *
 * Seeding more than 60 jobs is required to observe this: with few jobs,
 * Array.prototype.slice's own numeric coercion of the (wrongly concatenated)
 * end argument just clamps to the array length and the bug is invisible.
 */

const TARGET_TOTAL = 70;

async function buildApp(): Promise<{ app: FastifyInstance; total: number }> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const repos = getRepos();
  const baseline = repos.jobs.findAll().length;

  // Reuse an existing seeded kernel/capability pair (FK-enforced columns) —
  // only the total row count and the paging math matter for this test.
  const toInsert = TARGET_TOTAL - baseline;
  for (let i = 0; i < toInsert; i++) {
    repos.jobs.insert({
      id: `job-paging-n111-${i}`,
      stepId: `step-paging-n111-${i}`,
      cwmId: `cwm-paging-n111-${i}`,
      capabilityId: "cap-nyc-fdm",
      kernelId: "kernel-nyc",
      status: "queued",
      assignedDevices: [],
      progress: 0,
    });
  }
  const total = repos.jobs.findAll().length;

  const app = Fastify({ logger: false });
  await app.register(jobRoutes);
  await app.ready();
  return { app, total };
}

describe("N111 — GET /api/jobs paging", () => {
  let app: FastifyInstance;
  let total: number;

  beforeAll(async () => {
    const built = await buildApp();
    app = built.app;
    total = built.total;
    expect(total).toBeGreaterThan(60);
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("?offset=10&limit=50 returns at most 50 rows, with correct total and hasMore", async () => {
    const res = await app.inject({ method: "GET", url: "/api/jobs?offset=10&limit=50" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(total);
    expect(body.items.length).toBeLessThanOrEqual(50);
    expect(body.hasMore).toBe(body.offset + body.items.length < body.total);
  });

  it("the last page has hasMore false", async () => {
    const lastOffset = Math.max(total - 10, 0);
    const res = await app.inject({ method: "GET", url: `/api/jobs?offset=${lastOffset}&limit=50` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.offset + body.items.length).toBe(total);
    expect(body.hasMore).toBe(false);
  });

  it.each([
    ["non-numeric offset", "/api/jobs?offset=abc"],
    ["non-numeric limit", "/api/jobs?limit=abc"],
    ["negative offset", "/api/jobs?offset=-1"],
    ["zero limit", "/api/jobs?limit=0"],
    ["limit over the 200 bound", "/api/jobs?limit=201"],
  ])("rejects %s with 400", async (_label, url) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
  });

  it("with no query, the route's default still holds (offset=0, limit=50)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/jobs" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(50);
    expect(body.items.length).toBe(50); // total=70 > default limit=50
  });

  it("the facade itself never concatenates: string offset and limit from any caller are read as integers", async () => {
    // The route's schema keeps strings away from this call path; the facade guards its other callers too.
    const result = await getJobFacade().list({}, {}, { offset: "10", limit: "50" } as never);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.items.length).toBeLessThanOrEqual(50);
    expect(result.data.offset).toBe(10);
    expect(result.data.limit).toBe(50);
    expect(result.data.hasMore).toBe(10 + result.data.items.length < result.data.total);
  });

  it("the facade enforces the route's bounds for every caller: limit an integer in 1..200, offset an integer >= 0", async () => {
    // Cross-family review r1 of #535, MEDIUM: a typed non-HTTP caller could pass limit 0 or 201.
    const facade = getJobFacade();
    const page = async (offset: number, limit: number) => {
      const result = await facade.list({}, {}, { offset, limit });
      if (!result.success) throw new Error("list failed");
      return result.data;
    };
    expect((await page(0, 201)).limit).toBe(200);
    expect((await page(0, 1e9)).limit).toBe(200);
    const zero = await page(0, 0);
    expect([zero.limit, zero.items.length]).toEqual([1, 1]);
    const fractional = await page(10.7, 5.9);
    expect([fractional.offset, fractional.limit, fractional.items.length]).toEqual([10, 5, 5]);
  });
});
