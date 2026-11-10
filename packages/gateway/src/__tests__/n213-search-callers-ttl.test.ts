import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { closeStore, getRepos, initStore } from "../db.js";
import { a2aTasksRoutes, __resetA2ATasksForTest } from "../routes/a2a-tasks.js";
import { wellKnownAeoRoutes } from "../routes/well-known-aeo.js";
import { __resetAnonA2aDiscoverForTest } from "../middleware/security-hardening.js";

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));

const visibleIds = ["cap-n213-garbled", "cap-n213-live", "cap-n213-null"];

describe("N213 search()'s other callers drop expired rows", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("DATABASE_URL", ":memory:");
    initStore({ seed: true });
    __resetA2ATasksForTest();
    __resetAnonA2aDiscoverForTest();

    const repos = getRepos();
    const now = new Date();
    const future = new Date(now.getTime() + 3600_000).toISOString();
    repos.kernels.insert({
      id: "kernel-n213ttl",
      name: "n213ttl kernel",
      operatorAddress: "0x213",
      location: { lat: 0, lng: 0 },
      physicalAddress: "test",
      maxAssuranceTier: 0,
      publicKey: "n213ttl-key",
      status: "online",
      registeredAt: now.toISOString(),
      lastHeartbeat: now.toISOString(),
      validUntil: future,
      version: "1.0.0",
    });

    for (const row of [
      { id: "cap-n213-live", validUntil: future },
      { id: "cap-n213-expired", validUntil: "2000-01-01T00:00:00.000Z" },
      { id: "cap-n213-null" },
      { id: "cap-n213-garbled", validUntil: "not-a-date" },
    ]) {
      repos.capabilities.insert({
        ...row,
        kernelId: "kernel-n213ttl",
        type: "n213ttl",
        name: `n213ttl ${row.id}`,
        materials: [],
        assuranceTiers: [0],
        pricing: { currency: "USDC", baseCost: "0", minimum: "0" },
        availability: {},
        location: { lat: 0, lng: 0 },
        queueDepth: 0,
      });
    }

    app = Fastify({ logger: false });
    await app.register(wellKnownAeoRoutes);
    await app.register(a2aTasksRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    closeStore();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("C1: POST /ask returns live, null and garbled, and not expired", async () => {
    const response = await app.inject({ method: "POST", url: "/ask", payload: { query: "n213ttl" } });

    expect(response.statusCode).toBe(200);
    const urls: string[] = response.json().results.map((r: { url: string }) => r.url);
    expect(urls.map((u) => u.slice(u.lastIndexOf("/") + 1)).sort()).toEqual(visibleIds);
  });

  it("C2: anonymous A2A pcc-discover with a query returns the same three, and not expired", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: "n213",
        method: "tasks/send",
        params: { skill: "pcc-discover", params: { query: "n213ttl" } },
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    const text = JSON.stringify(body.result);
    for (const id of visibleIds) expect(text).toContain(id);
    expect(text).not.toContain("cap-n213-expired");
  });
});
