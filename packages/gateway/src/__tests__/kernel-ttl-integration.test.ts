/**
 * End-to-end integration test for the kernel + capability TTL flow
 * (feat/ed25519-keys-and-kernel-ttl).
 *
 * Walks the full lifecycle:
 *   1. Register a kernel.
 *   2. Heartbeat with a capability — list shows it.
 *   3. SQL time-travel: set valid_until to 48h ago.
 *   4. Run the sweeper. List excludes the expired capability + kernel.
 *   5. Heartbeat again — sweeper-style resurrection.
 *   6. List shows it again.
 *
 * Uses :memory: SQLite (same pattern as kernel-register-data-bugs.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { kernelRoutes } from "../routes/kernels.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { runOneSweep } from "../services/kernel-ttl-sweeper.js";

// Mock telemetry (used by BaseFacade.execute) — matches the canonical
// pattern in capability-facade.test.ts.
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));

describe("kernel + capability TTL — end-to-end", () => {
  let app: FastifyInstance;
  let kernelId: string;
  let capId: string;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    delete process.env.KERNEL_TTL_HOURS;
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(kernelRoutes);
    await app.register(capabilityRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("step 1: registers a kernel with valid_until populated", async () => {
    kernelId = `kernel_ttl_test_${Date.now()}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id: kernelId,
        name: "TTL-test kernel",
        operatorAddress: "0x" + "a".repeat(40),
        location: { lat: 40.71, lng: -74.0 },
      },
    });
    expect(res.statusCode).toBe(201);
    const row = (getRepos().kernels as any).findById(kernelId);
    expect(row).toBeDefined();
    expect(row.validUntil).toBeTruthy();
    expect(new Date(row.validUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it("step 2: heartbeat with capability appears in default list", async () => {
    const hb = await app.inject({
      method: "POST",
      url: `/api/kernels/${kernelId}/heartbeat`,
      payload: {
        status: "online",
        capabilities: [
          { type: "3d-printing", name: "TTL test cap" },
        ],
      },
    });
    expect(hb.statusCode).toBe(200);
    const hbBody = JSON.parse(hb.body) as {
      acknowledged: boolean;
      validUntil: string;
      resurrected: boolean;
      capabilitiesReceived: number;
    };
    expect(hbBody.acknowledged).toBe(true);
    expect(hbBody.capabilitiesReceived).toBe(1);
    expect(hbBody.resurrected).toBe(false);
    expect(new Date(hbBody.validUntil).getTime()).toBeGreaterThan(Date.now());

    capId = `cap-${kernelId}-3d-printing`;
    const list = await app.inject({ method: "GET", url: "/api/capabilities" });
    expect(list.statusCode).toBe(200);
    const listBody = JSON.parse(list.body) as { items: Array<{ id: string }> };
    expect(listBody.items.some((c) => c.id === capId)).toBe(true);
  });

  it("step 3: time-travel — set valid_until 48h in the past", () => {
    const past = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    (getRepos().kernels as any).update(kernelId, { validUntil: past } as any);
    (getRepos().capabilities as any).update(capId, { validUntil: past } as any);
    // Sanity: raw row reflects the rewrite.
    const row = (getRepos().capabilities as any).findById(capId);
    expect(row.validUntil).toBe(past);
  });

  it("step 4: list excludes expired capability after a sweep", async () => {
    const result = runOneSweep(getRepos());
    // The kernel was online, becomes expired.
    expect(result.kernelsExpired).toBeGreaterThanOrEqual(1);
    // One capability counted as expired.
    expect(result.capabilitiesExpired).toBeGreaterThanOrEqual(1);

    // Default list should now hide the expired cap.
    const list = await app.inject({ method: "GET", url: "/api/capabilities" });
    const body = JSON.parse(list.body) as { items: Array<{ id: string }> };
    expect(body.items.some((c) => c.id === capId)).toBe(false);

    // by-kernel + by-type also hide it.
    const byK = await app.inject({
      method: "GET",
      url: `/api/capabilities/by-kernel/${kernelId}`,
    });
    const byKBody = JSON.parse(byK.body) as { capabilities: Array<{ id: string }> };
    expect(byKBody.capabilities.some((c) => c.id === capId)).toBe(false);
  });

  it("step 5: heartbeat after expiry resurrects the kernel + capability", async () => {
    const hb = await app.inject({
      method: "POST",
      url: `/api/kernels/${kernelId}/heartbeat`,
      payload: {
        status: "online",
        capabilities: [
          { type: "3d-printing", name: "TTL test cap (resurrected)" },
        ],
      },
    });
    expect(hb.statusCode).toBe(200);
    const body = JSON.parse(hb.body) as {
      resurrected: boolean;
      validUntil: string;
    };
    expect(body.resurrected).toBe(true);
    expect(new Date(body.validUntil).getTime()).toBeGreaterThan(Date.now());

    // And the capability is back in the default catalog.
    const list = await app.inject({ method: "GET", url: "/api/capabilities" });
    const listBody = JSON.parse(list.body) as { items: Array<{ id: string }> };
    expect(listBody.items.some((c) => c.id === capId)).toBe(true);
  });
});
