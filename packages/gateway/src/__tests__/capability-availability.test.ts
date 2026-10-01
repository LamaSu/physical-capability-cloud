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

const OWNER = "0x2222222222222222222222222222222222222222"; // a wallet: only a SIWE session proves identity (pack 111)
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
    const app = await buildAuthedApp({ userId: OWNER });
    const res = await put(app, "cap-does-not-exist", { mode: "always" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("PUT /api/capabilities/:capId/availability: the owner sets it", () => {
  it("stores mode always, and operator-status stops reporting the slot missing", async () => {
    const app = await buildAuthedApp({ userId: OWNER });
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

  it("matches the owner's EVM address with ASCII hex case-folding only (pack 111 HIGH 2)", async () => {
    const upper = await buildAuthedApp({ userId: "0x" + OWNER.slice(2).toUpperCase() });
    const res = await put(upper, "cap-avail-a", { mode: "manual-claim" });
    expect(res.statusCode).toBe(200);
    expect(stored("cap-avail-a")).toEqual({ mode: "manual-claim" });
    await upper.close();
    for (const lookalike of [` ${OWNER} `, `${OWNER}\u200b`]) {
      const app = await buildAuthedApp({ userId: lookalike });
      const r = await put(app, "cap-avail-a", { mode: "always" });
      expect(r.statusCode, JSON.stringify(lookalike)).toBe(403);
      await app.close();
    }
    expect(stored("cap-avail-a")).toEqual({ mode: "manual-claim" });
  });

  it("a key-authenticated caller gets 403 proven_identity_required even when its operatorId equals the owner", async () => {
    const app = Fastify({ logger: false });
    app.decorateRequest("operatorId", null);
    app.decorateRequest("userId", null);
    app.decorateRequest("apiKeyId", null);
    app.addHook("onRequest", async (req) => {
      const r = req as unknown as { operatorId: string; userId: string; apiKeyId: string };
      r.apiKeyId = "key-1";
      r.operatorId = OWNER;
      r.userId = OWNER;
    });
    await app.register(capabilityAvailabilityRoutes);
    await app.ready();
    const res = await put(app, "cap-avail-a", { mode: "always" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("proven_identity_required");
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
    const app = await buildAuthedApp({ userId: OWNER });
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
    const app = await buildAuthedApp({ userId: OWNER });
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

// ── astra pack 111 findings (reproduced first on 2cc53580) ──────────────────
import { apiGate } from "../middleware/api-gate.js";
import { provisionRoutes } from "../routes/provision.js";

describe("pack 111 HIGH 1: a key minted by public provisioning for the owner's identity cannot write", () => {
  it("the real apiGate + provisioning: the impersonating key gets 403 and changes nothing", async () => {
    seedKernel("kernel-imp-email", "victim@kits.test");
    seedCapability("cap-imp-email", "kernel-imp-email");
    seedKernel("kernel-imp-wallet", "0x1111111111111111111111111111111111111111");
    seedCapability("cap-imp-wallet", "kernel-imp-wallet");
    const app = Fastify({ logger: false });
    await app.register(apiGate);
    await app.register(provisionRoutes);
    await app.register(capabilityAvailabilityRoutes);
    await app.ready();
    try {
      for (const [who, capId] of [
        [{ email: "victim@kits.test" }, "cap-imp-email"],
        [{ walletAddress: "0x1111111111111111111111111111111111111111" }, "cap-imp-wallet"],
      ] as const) {
        const prov = await app.inject({ method: "POST", url: "/api/auth/provision", payload: who });
        if (prov.statusCode < 300) {
          // A key WAS minted for the owner's identity: it still cannot write.
          const key = prov.json().api_key as string;
          const res = await app.inject({
            method: "PUT", url: `/api/capabilities/${capId}/availability`,
            headers: { authorization: `Bearer ${key}` }, payload: { mode: "always" },
          });
          expect(res.statusCode, capId).toBe(403);
          expect(res.json().error).toBe("proven_identity_required");
        } else {
          // WP-A (#326, F3 reserved identities): public provisioning refuses to mint a key
          // for an identity that already owns a kernel (409 identity_claimed), or for a
          // wallet without proof of control. That is stronger than minting a key that then
          // cannot write: no impersonating key exists at all.
          expect([401, 403, 409], JSON.stringify(who)).toContain(prov.statusCode);
          expect(prov.json().api_key, JSON.stringify(who)).toBeUndefined();
        }
        expect(stored(capId)).toEqual({});
      }
    } finally {
      await app.close();
    }
  });
});

describe("pack 111 HIGH 2: a Unicode case-fold lookalike never matches the owner", () => {
  it("a Kelvin-sign principal does not own k@example.com's capability", async () => {
    seedKernel("kernel-kelvin", "k@example.com");
    seedCapability("cap-kelvin", "kernel-kelvin");
    const app = await buildAuthedApp({ userId: "K@example.com" });
    const res = await put(app, "cap-kelvin", { mode: "always" });
    expect(res.statusCode).toBe(403);
    expect(stored("cap-kelvin")).toEqual({});
    await app.close();
  });
});

describe("pack 111 MEDIUM 3: cron and timezone must be real, not just shaped", () => {
  it("refuses a nonexistent timezone and a non-cron five-field string", async () => {
    const app = await buildAuthedApp({ userId: WALLET });
    for (const body of [
      { mode: "cron", cron: "x x x x x", timezone: "UTC" },
      { mode: "cron", cron: "0 9 * * 1-5", timezone: "Mars/Olympus" },
      { mode: "cron", cron: "61 9 * * *" },
      { mode: "cron", cron: "0 24 * * *" },
    ]) {
      const res = await put(app, "cap-avail-w", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    await app.close();
  });
});
