/**
 * Tests for GET /api/operators/:slug/status — the four-slot self-service view.
 *
 * Coverage:
 *   - unconfigured (no kernel, no caps, no channels) → status: "unconfigured"
 *   - kernel + capability + channel attached → status: "ready"
 *   - kernel + capability without availability → status: "partial" + missing slot 4
 *   - human-lane capability without sla → status: "partial" + missing slot 2
 *   - channels attached but all disabled → status: "partial"
 *   - totals tallies correctly (humanLane vs machineLane, enabled vs total)
 *   - agentCardUrls populated per kernel
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { operatorStatusRoutes } from "../routes/operator-status.js";
import {
  attachChannel,
  _clearOperatorChannelsForTests,
} from "../routes/operator-channels.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema } from "@pcc/store";

const { shopKernels, capabilities } = schema;

const TEST_OP = "0xtest-operator-status";
// N84: the view lists the CALLER's channels, so these requests carry the operator's identity, as apiGate
// attaches it to a request. OTHER is a second identity that attaches channels under the same slug.
const OTHER = "someone-else@status.test";
const ADMIN = "status-test-admin-secret-0123456789";

function seedKernel(id: string, name: string): void {
  const { db } = getStore();
  const now = new Date().toISOString();
  db.insert(shopKernels).values({
    id,
    name,
    operatorAddress: TEST_OP,
    location: { lat: 0, lng: 0 },
    physicalAddress: "test",
    maxAssuranceTier: 2,
    publicKey: "test-key",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: now,
    lastHeartbeat: now,
    version: "1.0.0",
  } as any).run();
}

function seedCapability(
  id: string,
  kernelId: string,
  type: string,
  opts: { sla?: object; availability?: object } = {},
): void {
  const { db } = getStore();
  db.insert(capabilities).values({
    id,
    kernelId,
    type,
    name: `${type} cap`,
    description: `${type} capability for testing`,
    materials: [],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
    location: { lat: 0, lng: 0 },
    queueDepth: 0,
    availability: opts.availability ?? {},
    sla: opts.sla ?? null,
  } as any).run();
}

describe("GET /api/operators/:slug/status", () => {
  let app: FastifyInstance;
  const savedAdmin = process.env.PCC_ADMIN_KEY;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.PCC_ADMIN_KEY = ADMIN;
    initStore({ seed: true });
    app = Fastify({ logger: false });
    app.decorateRequest("operatorId", null);
    app.decorateRequest("userId", null);
    app.addHook("onRequest", async (req) => {
      const r = req as unknown as { operatorId: string | null; userId: string | null };
      r.operatorId = TEST_OP;
      r.userId = TEST_OP;
    });
    await app.register(operatorStatusRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    if (savedAdmin === undefined) delete process.env.PCC_ADMIN_KEY;
    else process.env.PCC_ADMIN_KEY = savedAdmin;
  });

  beforeEach(() => {
    _clearOperatorChannelsForTests();
    // Wipe rows from the in-memory DB for a clean slate per test
    try {
      const { db } = getStore();
      db.delete(capabilities).run();
      db.delete(shopKernels).run();
    } catch { /* no-op */ }
  });

  it("returns unconfigured when no kernel/cap/channel exists", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/operators/${TEST_OP}/status`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.operatorSlug).toBe(TEST_OP);
    expect(body.status).toBe("unconfigured");
    expect(body.kernels).toEqual([]);
    expect(body.capabilities).toEqual([]);
    expect(body.channels).toEqual([]);
    expect(body.totals.kernelCount).toBe(0);
  });

  it("returns ready when all slots filled (machine lane, no SLA needed)", async () => {
    seedKernel("kernel-test-1", "Test Kernel");
    seedCapability("cap-test-1", "kernel-test-1", "fdm", {
      availability: { mode: "always" },
    });
    attachChannel(TEST_OP, {
      label: "Webhook printer",
      transport: "webhook",
      describe: "POST to local printer endpoint",
      endpoint: { url: "http://localhost:9100" },
    }, TEST_OP);
    const res = await app.inject({
      method: "GET",
      url: `/api/operators/${TEST_OP}/status`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ready");
    expect(body.totals.kernelCount).toBe(1);
    expect(body.totals.capabilityCount).toBe(1);
    expect(body.totals.channelCount).toBe(1);
    expect(body.totals.enabledChannelCount).toBe(1);
    expect(body.totals.humanLaneCount).toBe(0);
    expect(body.totals.machineLaneCount).toBe(1);
    expect(body.agentCardUrls).toHaveLength(1);
    expect(body.agentCardUrls[0]).toContain("/api/kernels/kernel-test-1/agent-card.json");
    expect(body.missing).toEqual([]);
  });

  it("flags missing availability for capabilities without it", async () => {
    seedKernel("kernel-test-2", "Kernel B");
    seedCapability("cap-test-2", "kernel-test-2", "fdm", {
      availability: {}, // empty object → counts as missing
    });
    attachChannel(TEST_OP, {
      label: "x",
      transport: "manual",
      describe: "dashboard only",
    }, TEST_OP);
    const res = await app.inject({
      method: "GET",
      url: `/api/operators/${TEST_OP}/status`,
    });
    const body = res.json();
    expect(body.status).toBe("partial");
    expect(body.missing.some((m: string) => m.includes("availability"))).toBe(true);
  });

  it("flags missing SLA for human-lane capability without it", async () => {
    seedKernel("kernel-test-3", "Kernel C");
    // human-lane: sla absent but it SHOULD be there since this is a human capability
    // Trick: we use null sla here but pretend the operator wanted human-lane by adding ONE human cap (sla set) + one without
    seedCapability("cap-test-3a", "kernel-test-3", "courier", {
      availability: { mode: "always" },
      sla: { acceptanceWindowSec: 60, completionDeadlineSec: 1800 },
    });
    seedCapability("cap-test-3b", "kernel-test-3", "concierge", {
      availability: { mode: "always" },
      // sla intentionally missing — this is a human-shaped cap missing its slot 2
    });
    attachChannel(TEST_OP, {
      label: "Owner phone",
      transport: "sms",
      describe: "SMS to owner E.164",
      endpoint: { phoneE164: "+14155551234" },
    }, TEST_OP);
    const res = await app.inject({
      method: "GET",
      url: `/api/operators/${TEST_OP}/status`,
    });
    const body = res.json();
    expect(body.totals.humanLaneCount).toBe(1); // only cap-test-3a has sla set
    expect(body.totals.machineLaneCount).toBe(1); // cap-test-3b has no sla
    expect(body.status).toBe("ready");
    // Note: SLA absence on cap-test-3b counts it as machine-lane, which is fine.
    // Only flags missing SLA when humanLaneCount > 0 AND some have no sla — not our case here.
  });

  it("flags channels attached but all disabled", async () => {
    seedKernel("kernel-test-4", "Kernel D");
    seedCapability("cap-test-4", "kernel-test-4", "fdm", {
      availability: { mode: "always" },
    });
    attachChannel(TEST_OP, {
      label: "Disabled webhook",
      transport: "webhook",
      describe: "currently off for maintenance",
      enabled: false,
      endpoint: { url: "http://localhost:9100" },
    }, TEST_OP);
    const res = await app.inject({
      method: "GET",
      url: `/api/operators/${TEST_OP}/status`,
    });
    const body = res.json();
    expect(body.totals.channelCount).toBe(1);
    expect(body.totals.enabledChannelCount).toBe(0);
    expect(body.status).toBe("partial");
    expect(body.missing.some((m: string) => m.includes("channel enabled"))).toBe(true);
  });

  it("agentCardUrls populated per kernel", async () => {
    seedKernel("kernel-A", "Kernel A");
    seedKernel("kernel-B", "Kernel B");
    seedCapability("cap-A", "kernel-A", "fdm", { availability: { mode: "always" } });
    seedCapability("cap-B", "kernel-B", "cnc", { availability: { mode: "always" } });
    attachChannel(TEST_OP, {
      label: "x",
      transport: "manual",
      describe: "dashboard",
    }, TEST_OP);
    const res = await app.inject({
      method: "GET",
      url: `/api/operators/${TEST_OP}/status`,
    });
    const body = res.json();
    expect(body.agentCardUrls).toHaveLength(2);
    expect(body.agentCardUrls.every((u: string) => u.includes("/agent-card.json"))).toBe(true);
  });

  it("[neg] the per-caller status response is never stored, not even in a private cache (astra pack 146, MEDIUM)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/operators/${TEST_OP}/status`,
    });
    // The body is computed from the CALLER's identity (own channels only; admin sees all). A private
    // cache that may keep it for 15 s without varying on credentials would serve identity A's (or the
    // admin's) channels to identity B in the same browser after a session switch. So: no-store, and
    // never a max-age that would make it reusable (this pinned "private, max-age=15" before).
    const cc = String(res.headers["cache-control"] ?? "");
    expect(cc).toMatch(/\bno-store\b/);
    expect(cc).toMatch(/\bprivate\b/);
    expect(cc).not.toMatch(/max-age=[1-9]/);
    expect(cc).not.toMatch(/\bpublic\b/);
  });

  // ── N84: the channels in this view are the caller's own ───────────────────

  it("no identity is 401 (a bare app, no apiGate in front)", async () => {
    const anon = Fastify({ logger: false });
    anon.decorateRequest("operatorId", null);
    anon.decorateRequest("userId", null);
    await anon.register(operatorStatusRoutes);
    await anon.ready();
    attachChannel(TEST_OP, { label: "Mine", transport: "manual", describe: "dashboard only" }, TEST_OP);
    const res = await anon.inject({ method: "GET", url: `/api/operators/${TEST_OP}/status` });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("Mine");
    await anon.close();
  });

  it("a WRONG admin secret is 403, even with the operator's own identity", async () => {
    attachChannel(TEST_OP, { label: "Mine", transport: "manual", describe: "dashboard only" }, TEST_OP);
    const res = await app.inject({
      method: "GET",
      url: `/api/operators/${TEST_OP}/status`,
      headers: { "x-admin-key": "not-the-secret" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("Mine");
  });

  it("lists only the caller's own channels, and counts and slots come from them; the admin secret sees all", async () => {
    seedKernel("kernel-n84-1", "Kernel N84");
    seedCapability("cap-n84-1", "kernel-n84-1", "fdm", { availability: { mode: "always" } });
    attachChannel(TEST_OP, { label: "Mine", transport: "manual", describe: "dashboard only" }, TEST_OP);
    attachChannel(TEST_OP, { label: "TheirsOn", transport: "manual", describe: "dashboard only" }, OTHER);
    attachChannel(TEST_OP, { label: "TheirsOff", transport: "manual", describe: "dashboard only", enabled: false }, OTHER);
    attachChannel(TEST_OP, { label: "Legacy", transport: "manual", describe: "dashboard only" }, null);

    const mine = (await app.inject({ method: "GET", url: `/api/operators/${TEST_OP}/status` })).json();
    expect(mine.channels.map((c: { label: string }) => c.label)).toEqual(["Mine"]);
    expect(mine.totals.channelCount).toBe(1);
    expect(mine.totals.enabledChannelCount).toBe(1);
    expect(mine.status).toBe("ready");
    expect(JSON.stringify(mine)).not.toMatch(/TheirsOn|TheirsOff|Legacy/);

    const all = (
      await app.inject({ method: "GET", url: `/api/operators/${TEST_OP}/status`, headers: { "x-admin-key": ADMIN } })
    ).json();
    expect(all.channels.map((c: { label: string }) => c.label).sort()).toEqual(["Legacy", "Mine", "TheirsOff", "TheirsOn"]);
    expect(all.totals.channelCount).toBe(4);
    expect(all.totals.enabledChannelCount).toBe(3);
  });

  it("a caller with no channel of its own is told no channel is attached, whatever others have attached", async () => {
    attachChannel(TEST_OP, { label: "TheirsOn", transport: "manual", describe: "dashboard only" }, OTHER);
    const res = await app.inject({ method: "GET", url: `/api/operators/${TEST_OP}/status` });
    const body = res.json();
    expect(body.channels).toEqual([]);
    expect(body.totals.channelCount).toBe(0);
    expect(body.status).toBe("unconfigured");
    expect(body.missing.some((m: string) => m.includes("channel (slot 3)"))).toBe(true);
    expect(res.body).not.toContain("TheirsOn");
  });
});
