/**
 * PUT /api/capabilities/:capId/availability (board N83; rehearsal R0 G11):
 * only the operator of the capability's kernel may set availability. The body
 * is validated strictly, delegate-to-agent is refused, and operator-status
 * stops reporting the availability slot as missing once it is set.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { initStore, closeStore, getRepos } from "../db.js";
import { capabilityAvailabilityRoutes } from "../routes/capability-availability.js";
import { operatorStatusRoutes } from "../routes/operator-status.js";

const OWNER = "owner@kits.test";
const WALLET = "0x282fa9c122b433864f8c8a8f2efe411b52067539";

beforeAll(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  seedKernel("kernel-avail-a", OWNER);
  seedCapability("cap-avail-a", "kernel-avail-a");
  seedCapability("cap-avail-b", "kernel-avail-a");
  seedKernel("kernel-avail-w", WALLET);
  seedCapability("cap-avail-w", "kernel-avail-w");
});

afterAll(() => {
  closeStore();
});

function seedKernel(id: string, operatorAddress: string): void {
  getRepos().kernels.insert({
    id,
    name: `Kernel ${id}`,
    operatorAddress,
    location: { lat: 0, lng: 0 },
    physicalAddress: "1 Test St",
    maxAssuranceTier: 2,
    publicKey: "pk",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "1.0.0",
  } as never);
}

function seedCapability(id: string, kernelId: string): void {
  getRepos().capabilities.insert({
    id,
    kernelId,
    type: "lab.absorbance",
    name: `Cap ${id}`,
    materials: [],
    assuranceTiers: [0, 1],
    pricing: { currency: "USD", baseCost: "25", minimum: "25" },
    availability: {},
    location: { lat: 0, lng: 0 },
  } as never);
}

/** An app with no authenticated principal, as api-gate would leave a public request. */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(capabilityAvailabilityRoutes);
  await app.register(operatorStatusRoutes);
  await app.ready();
  return app;
}

/** An app whose requests carry the principal api-gate attaches (API key or SIWE). */
async function buildAuthedApp(principal: { operatorId?: string; userId?: string }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  app.decorateRequest("userId", null);
  app.addHook("onRequest", async (req) => {
    const r = req as unknown as { operatorId: string | null; userId: string | null };
    r.operatorId = principal.operatorId ?? null;
    r.userId = principal.userId ?? principal.operatorId ?? null;
  });
  await app.register(capabilityAvailabilityRoutes);
  await app.register(operatorStatusRoutes);
  await app.ready();
  return app;
}

const put = (app: FastifyInstance, capId: string, payload: unknown) =>
  app.inject({ method: "PUT", url: `/api/capabilities/${capId}/availability`, payload: payload as object });

const stored = (capId: string) => getRepos().capabilities.findById(capId)?.availability;

describe("PUT /api/capabilities/:capId/availability: authorization fails closed", () => {
  it("401 without an authenticated principal (a body field is not identity)", async () => {
    const app = await buildApp();
    const res = await put(app, "cap-avail-a", { mode: "always", operatorId: OWNER });
    expect(res.statusCode).toBe(401);
    expect(stored("cap-avail-a")).toEqual({});
    await app.close();
  });

  it("403 for an authenticated caller who does not operate the capability's kernel", async () => {
    const app = await buildAuthedApp({ operatorId: "mallory@kits.test" });
    const res = await put(app, "cap-avail-a", { mode: "always" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_capability_owner");
    expect(stored("cap-avail-a")).toEqual({});
    await app.close();
  });

  it("404 for an unknown capability", async () => {
    const app = await buildAuthedApp({ operatorId: OWNER });
    const res = await put(app, "cap-does-not-exist", { mode: "always" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("PUT /api/capabilities/:capId/availability: the owner sets it", () => {
  it("stores mode always, and operator-status stops reporting the slot missing", async () => {
    const app = await buildAuthedApp({ operatorId: OWNER });
    const before = await app.inject({ method: "GET", url: `/api/operators/${OWNER}/status` });
    expect(before.statusCode).toBe(200);
    expect(JSON.stringify(before.json().missing)).toMatch(/availability \(slot 4\) — 2\/2/);

    const res = await put(app, "cap-avail-a", { mode: "always" });
    expect(res.statusCode).toBe(200);
    expect(res.json().capability).toEqual({ id: "cap-avail-a", kernelId: "kernel-avail-a", availability: { mode: "always" } });
    expect(stored("cap-avail-a")).toEqual({ mode: "always" });

    const res2 = await put(app, "cap-avail-b", {
      mode: "windows",
      timezone: "America/Los_Angeles",
      windows: [{ start: "09:00", end: "17:00", daysOfWeek: [1, 2, 3, 4, 5] }],
      describe: "Weekdays; ask for weekend runs.",
    });
    expect(res2.statusCode).toBe(200);
    expect(stored("cap-avail-b")).toEqual({
      mode: "windows",
      windows: [{ start: "09:00", end: "17:00", daysOfWeek: [1, 2, 3, 4, 5] }],
      timezone: "America/Los_Angeles",
      describe: "Weekdays; ask for weekend runs.",
    });

    const after = await app.inject({ method: "GET", url: `/api/operators/${OWNER}/status` });
    expect(JSON.stringify(after.json().missing)).not.toMatch(/availability/);
    await app.close();
  });

  it("matches the owner with WP-A's fold (trimmed, case-insensitive)", async () => {
    const app = await buildAuthedApp({ operatorId: "  OWNER@Kits.Test " });
    const res = await put(app, "cap-avail-a", { mode: "manual-claim" });
    expect(res.statusCode).toBe(200);
    expect(stored("cap-avail-a")).toEqual({ mode: "manual-claim" });
    await app.close();
  });

  it("accepts a SIWE wallet principal whose address operates the kernel", async () => {
    const app = await buildAuthedApp({ userId: WALLET.toUpperCase().replace("0X", "0x") });
    const res = await put(app, "cap-avail-w", { mode: "cron", cron: "0 9 * * 1-5", timezone: "UTC" });
    expect(res.statusCode).toBe(200);
    expect(stored("cap-avail-w")).toEqual({ mode: "cron", cron: "0 9 * * 1-5", timezone: "UTC" });
    await app.close();
  });
});

describe("PUT /api/capabilities/:capId/availability: strict body", () => {
  it("refuses delegate-to-agent and any agentEndpoint (the gateway would POST to that URL)", async () => {
    const app = await buildAuthedApp({ operatorId: OWNER });
    const before = stored("cap-avail-a");
    for (const body of [
      { mode: "delegate-to-agent", agentEndpoint: "http://169.254.169.254/latest" },
      { mode: "always", agentEndpoint: "https://agent.example.com/free" },
    ]) {
      const res = await put(app, "cap-avail-a", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error).toBe("unsupported_mode");
    }
    expect(stored("cap-avail-a")).toEqual(before);
    await app.close();
  });

  it("rejects malformed availability and leaves the stored value unchanged", async () => {
    const app = await buildAuthedApp({ operatorId: OWNER });
    const before = stored("cap-avail-b");
    const bad: unknown[] = [
      { mode: "sometimes" },
      { mode: "windows" },
      { mode: "always", windows: [{ start: "09:00", end: "17:00", daysOfWeek: [1] }] },
      { mode: "windows", windows: [{ start: "9:00", end: "17:00", daysOfWeek: [1] }] },
      { mode: "windows", windows: [{ start: "09:00", end: "17:00", daysOfWeek: [7] }] },
      { mode: "windows", windows: [{ start: "2026-10-02T10:00:00Z", end: "2026-10-02T09:00:00Z" }] },
      { mode: "cron", cron: "0 9 * *" },
      { mode: "cron" },
      { mode: "always", timezone: "not a zone!" },
      { mode: "always", smuggled: true },
      null,
    ];
    for (const body of bad) {
      const res = await put(app, "cap-avail-b", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    // A JSON string body (not an object) reaches the schema and is refused too.
    const str = await app.inject({
      method: "PUT",
      url: "/api/capabilities/cap-avail-b/availability",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify("always"),
    });
    expect(str.statusCode).toBe(400);
    expect(stored("cap-avail-b")).toEqual(before);
    await app.close();
  });
});
