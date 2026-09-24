/**
 * GET /api/kernels: collection-v1 read model plus a read-time `asOf`
 * (genui bus #2231 + #2222).
 *
 * The closed render IR's list binding accepts only collection-v1, meaning a
 * top-level array or `{ items: [...] }`. GET /api/kernels returned only
 * `{ kernels: [...] }`, so a bound kernel list rendered as
 * "unavailable · unexpected response shape". The route now returns the
 * ADDITIVE envelope `{ kernels, items, total, asOf }`:
 *   - `kernels` is unchanged (dashboard useKernels hook, MCP pcc_list_kernels,
 *     agents keep working);
 *   - `items` is the same array under the collection-v1 key;
 *   - `total` is that array's length;
 *   - `asOf` is the ISO-8601 UTC time the gateway READ the state. It is a read
 *     time, never a last-change time such as a heartbeat.
 * A failed read keeps the unchanged `{ error, message }` error path. It is never
 * presented as an (empty) collection, because absence is not evidence.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { kernelRoutes } from "../routes/kernels.js";
import { initStore, closeStore, getRepos } from "../db.js";

interface KernelRow {
  id: string;
  status: string;
}

interface KernelListBody {
  kernels: KernelRow[];
  items: KernelRow[];
  total: number;
  asOf: string;
}

const ENVELOPE_KEYS = ["asOf", "items", "kernels", "total"];
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(kernelRoutes);
  await app.ready();
  return app;
}

async function getList(app: FastifyInstance, url = "/api/kernels") {
  const res = await app.inject({ method: "GET", url });
  return { res, body: res.json() as KernelListBody };
}

describe("GET /api/kernels: collection-v1 envelope { kernels, items, total, asOf }", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns 200 with items as the collection-v1 alias of kernels (same rows, same order)", async () => {
    const { res, body } = await getList(app);
    expect(res.statusCode).toBe(200);
    // Backward compatibility: the legacy key is still there, still an array.
    expect(Array.isArray(body.kernels)).toBe(true);
    // collection-v1: `{ items: [...] }` is what the render IR's list binding reads.
    expect(Array.isArray(body.items)).toBe(true);
    // The seed has kernels, so the equality below compares real rows.
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items).toEqual(body.kernels);
  });

  it("total equals the number of rows returned", async () => {
    const { body } = await getList(app);
    expect(typeof body.total).toBe("number");
    expect(body.total).toBe(body.items.length);
    expect(body.total).toBe(body.kernels.length);
  });

  it("asOf is an ISO-8601 UTC timestamp within 60s of the test's own clock", async () => {
    const { body } = await getList(app);
    expect(typeof body.asOf).toBe("string");
    expect(body.asOf).toMatch(ISO_8601_UTC);
    const asOfMs = Date.parse(body.asOf);
    expect(Number.isFinite(asOfMs)).toBe(true);
    expect(Math.abs(Date.now() - asOfMs)).toBeLessThanOrEqual(60_000);
    // Canonical UTC form (round-trips through Date unchanged).
    expect(new Date(asOfMs).toISOString()).toBe(body.asOf);
  });

  it("asOf is the READ time: it tracks the gateway clock and advances on a re-read of unchanged state", async () => {
    // Only Date is faked. Timers, setImmediate and nextTick stay real so
    // Fastify's inject pipeline is untouched.
    vi.useFakeTimers({ toFake: ["Date"] });

    const firstRead = "2031-02-03T04:05:06.789Z";
    vi.setSystemTime(new Date(firstRead));
    const first = await getList(app);
    expect(first.res.statusCode).toBe(200);
    expect(first.body.asOf).toBe(firstRead);

    const secondRead = "2031-02-03T04:05:16.789Z"; // 10s later, no write in between
    vi.setSystemTime(new Date(secondRead));
    const second = await getList(app);
    expect(second.res.statusCode).toBe(200);
    expect(second.body.asOf).toBe(secondRead);

    // Same state both times (no write happened), yet asOf moved forward. A
    // last-change time (heartbeat, updatedAt) could not do that; a read time must.
    expect(second.body.items.map((k) => k.id)).toEqual(first.body.items.map((k) => k.id));
    expect(Date.parse(second.body.asOf)).toBeGreaterThan(Date.parse(first.body.asOf));
  });

  it("?status= filters kernels and items identically", async () => {
    const all = (await getList(app)).body;
    const statuses = [...new Set(all.kernels.map((k) => k.status))];
    // The seed mixes online and offline kernels, so filtering is observable.
    expect(statuses.length).toBeGreaterThan(1);

    for (const status of statuses) {
      const { res, body } = await getList(app, `/api/kernels?status=${encodeURIComponent(status)}`);
      expect(res.statusCode).toBe(200);
      expect(body.items).toEqual(body.kernels);
      expect(body.total).toBe(body.items.length);
      // Actually filtered: non-empty, strictly fewer than the unfiltered list,
      // every row has the requested status.
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.length).toBeLessThan(all.items.length);
      expect(body.items.every((k) => k.status === status)).toBe(true);
      expect(body.kernels.every((k) => k.status === status)).toBe(true);
      // Exactly the unfiltered rows with that status.
      const expectedIds = all.items.filter((k) => k.status === status).map((k) => k.id).sort();
      expect(body.items.map((k) => k.id).sort()).toEqual(expectedIds);
      expect(body.kernels.map((k) => k.id).sort()).toEqual(expectedIds);
    }
  });

  it("a status that matches no kernel yields empty kernels AND empty items with total 0", async () => {
    const all = (await getList(app)).body;
    const unmatched = "status-that-no-kernel-has";
    expect(all.kernels.some((k) => k.status === unmatched)).toBe(false);

    const { res, body } = await getList(app, `/api/kernels?status=${unmatched}`);
    expect(res.statusCode).toBe(200);
    expect(body.kernels).toEqual([]);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.asOf).toMatch(ISO_8601_UTC);
  });

  it("NEGATIVE: the success envelope exposes no top-level field beyond kernels/items/total/asOf", async () => {
    for (const url of [
      "/api/kernels",
      "/api/kernels?status=online",
      "/api/kernels?status=offline",
      "/api/kernels?status=status-that-no-kernel-has",
    ]) {
      const { res, body } = await getList(app, url);
      expect(res.statusCode, url).toBe(200);
      expect(Object.keys(body).sort(), url).toEqual(ENVELOPE_KEYS);
    }
  });

  it("NEGATIVE: a failed read keeps the unchanged error path and is never presented as an empty collection", async () => {
    vi.spyOn(getRepos().kernels, "findAll").mockImplementationOnce(() => {
      throw new Error("simulated kernel store read failure");
    });

    const res = await app.inject({ method: "GET", url: "/api/kernels" });
    expect(res.statusCode).toBe(500);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("INTERNAL_ERROR");
    expect(body.message).toBe("simulated kernel store read failure");
    // No collection keys at all: an error must not render as "no kernels".
    for (const key of ENVELOPE_KEYS) {
      expect(body, key).not.toHaveProperty(key);
    }

    // The failure was one-shot: the next read succeeds again.
    const recovered = await getList(app);
    expect(recovered.res.statusCode).toBe(200);
    expect(recovered.body.items.length).toBeGreaterThan(0);
  });
});

describe("GET /api/kernels: asOf is captured BEFORE the read", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await app.close();
    closeStore();
  });

  it("a clock that moves during the read does not move asOf (read time, taken first)", async () => {
    const T0 = "2031-02-03T04:05:06.789Z";
    const T1 = "2031-02-03T04:09:06.789Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(T0));
    const repo = getRepos().kernels as unknown as { findAll: (...a: unknown[]) => unknown };
    const real = repo.findAll.bind(repo);
    vi.spyOn(repo, "findAll").mockImplementation((...a: unknown[]) => {
      vi.setSystemTime(new Date(T1)); // the store read "takes" four minutes
      return real(...a);
    });
    const { res, body } = await getList(app);
    expect(res.statusCode).toBe(200);
    expect(body.asOf).toBe(T0);
  });
});
