/**
 * Board N34 (reviewer-n34-c): services.ts seeded a demo HPLC batch (Sample Alpha/Beta/Gamma,
 * jobs job-010..012, made-up 0x wallets, a fake sha256 result) into every gateway's batch
 * tracker at import, so GET /api/batches* served it as live data. It is seeded only in demo
 * mode now, and says demo: true in its runConfig.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify from "fastify";

const ENV = ["PCC_DEMO_ROUTES", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

/** A fresh import of services.ts (it seeds at import) behind the real batch routes. */
async function listBatches(env: Partial<Record<(typeof ENV)[number], string>>) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  const { batchRoutes } = await import("../routes/batches.js");
  const app = Fastify({ logger: false });
  await app.register(batchRoutes);
  await app.ready();
  try {
    const list = await app.inject({ method: "GET", url: "/api/batches" });
    const byJob = await app.inject({ method: "GET", url: "/api/batches/by-job/job-010" });
    return { list: list.json().batches as Array<Record<string, any>>, byJob: byJob.json().batches as unknown[] };
  } finally {
    await app.close();
  }
}

const FIXTURE = /Sample (Alpha|Beta|Gamma)|job-01[012]|sha256:abc123def456|0x1234567890abcdef1234567890abcdef12345678/;

describe("N34: the demo HPLC batch", () => {
  it("NEGATIVE: outside demo mode no batch is seeded, so /api/batches serves no fixture", async () => {
    const { list, byJob } = await listBatches({ NODE_ENV: "test" });
    expect(list).toEqual([]);
    expect(byJob).toEqual([]);
    expect(JSON.stringify(list)).not.toMatch(FIXTURE);
  });

  it("NEGATIVE: PCC_DEMO_ROUTES is ignored under NODE_ENV=production", async () => {
    const { list } = await listBatches({ PCC_DEMO_ROUTES: "true", NODE_ENV: "production" });
    expect(list).toEqual([]);
  });

  it("in demo mode the batch is seeded and says demo: true", async () => {
    const { list, byJob } = await listBatches({ PCC_DEMO_ROUTES: "true", NODE_ENV: "test" });
    expect(list).toHaveLength(1);
    expect(list[0]!.runConfig).toMatchObject({ method: "HPLC_RP_C18_gradient_30min", demo: true });
    expect(byJob).toHaveLength(1);
  });

  it("NEGATIVE (F-D, reviewer r1b): a batch seeded while demo was ON stays hidden once demo is toggled OFF in the SAME process", async () => {
    // services.ts seeds the demo batch once, at import, when demo is on. A long-running
    // gateway process does not re-import when an operator flips PCC_DEMO_ROUTES off — so
    // the seeded singleton must recheck demo mode on every READ, not trust the state it
    // was created under.
    for (const k of ENV) delete process.env[k];
    process.env.PCC_DEMO_ROUTES = "true";
    process.env.NODE_ENV = "test";
    vi.resetModules();
    const { batchRoutes } = await import("../routes/batches.js");
    const app = Fastify({ logger: false });
    await app.register(batchRoutes);
    await app.ready();
    try {
      // Confirm it really was seeded (demo on) before flipping anything.
      const seeded = await app.inject({ method: "GET", url: "/api/batches" });
      expect(seeded.json().batches).toHaveLength(1);

      // Flip demo off in this SAME process — no re-import, no fresh module, exactly
      // what an operator toggling the env var (or a per-request demo check) looks like.
      delete process.env.PCC_DEMO_ROUTES;

      const list = await app.inject({ method: "GET", url: "/api/batches" });
      const byJob = await app.inject({ method: "GET", url: "/api/batches/by-job/job-010" });
      expect(list.json().batches, JSON.stringify(list.json())).toEqual([]);
      expect(byJob.json().batches).toEqual([]);
      expect(JSON.stringify(list.json())).not.toMatch(FIXTURE);
    } finally {
      await app.close();
    }
  });

  it("a batch a caller actually created (no demo flag) stays visible regardless of demo mode", async () => {
    for (const k of ENV) delete process.env[k];
    process.env.PCC_DEMO_ROUTES = "true";
    process.env.NODE_ENV = "test";
    vi.resetModules();
    const { batchRoutes } = await import("../routes/batches.js");
    const { batchTracker } = await import("../services.js");
    const app = Fastify({ logger: false });
    await app.register(batchRoutes);
    await app.ready();
    try {
      const real = batchTracker.createBatch("kernel-real", "dev-real-01", "cap-real", {
        method: "REAL_METHOD",
      });
      delete process.env.PCC_DEMO_ROUTES;
      const list = await app.inject({ method: "GET", url: "/api/batches" });
      const ids = (list.json().batches as Array<{ id: string }>).map((b) => b.id);
      expect(ids).toEqual([real.id]);
    } finally {
      await app.close();
    }
  });
});
