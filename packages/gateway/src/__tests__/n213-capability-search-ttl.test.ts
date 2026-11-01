import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { closeStore, getRepos, initStore } from "../db.js";
import { CapabilityFacade } from "../facades/capability.facade.js";
import { capabilityRoutes } from "../routes/capabilities.js";

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));

const visibleIds = ["cap-n213-garbled", "cap-n213-live", "cap-n213-null"];
const allIds = ["cap-n213-expired", ...visibleIds];

describe("N213 capability search TTL", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("DATABASE_URL", ":memory:");
    initStore({ seed: true });

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
    await app.register(capabilityRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    closeStore();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("S1: GET search keeps live, null and garbled rows and excludes expired rows", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/capabilities/search?q=n213ttl",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { id: string }) => item.id).sort()).toEqual(visibleIds);
    expect(body.total).toBe(3);
  });

  it("S2: GET list by type keeps the same three rows and excludes expired rows", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/capabilities?type=n213ttl",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { id: string }) => item.id).sort()).toEqual(visibleIds);
    expect(body.total).toBe(3);
  });

  it("S3: facade search filters by default and returns all four with includeExpired", async () => {
    const facade = new CapabilityFacade();
    const result = await facade.search({ query: "n213ttl" });
    assert(result.success);
    expect(result.data.items.map((item) => item.id).sort()).toEqual(visibleIds);
    expect(result.data.total).toBe(3);

    const includingExpired = await facade.search(
      { query: "n213ttl" },
      { includeExpired: true },
    );
    assert(includingExpired.success);
    expect(includingExpired.data.items.map((item) => item.id).sort()).toEqual(allIds);
    expect(includingExpired.data.total).toBe(4);
  });
});
