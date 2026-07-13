/**
 * Tests for the ANP (Agent Network Protocol) discovery surface:
 *   - GET /.well-known/agent-card.json (protocolVersion=1.0)
 *   - GET /.well-known/agent-descriptions (JSON-LD CollectionPage)
 *   - GET /api/kernels/:kernelId/agent-card.json (per-kernel A2A card)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { wellKnownRoutes } from "../routes/well-known.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema } from "@pcc/store";

const { shopKernels, capabilities } = schema;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  // Override the gateway URL so test assertions are deterministic
  process.env.PCC_GATEWAY_URL = "https://test.capability.network";
  initStore({ seed: false });

  // Insert one online kernel and one offline kernel so we can verify
  // the active-kernel filter applied by /.well-known/agent-descriptions.
  const { db } = getStore();
  const now = new Date().toISOString();
  db.insert(shopKernels).values({
    id: "kernel-anp-online",
    name: "ANP Test Kernel (online)",
    operatorAddress: "0xanp",
    location: { lat: 0, lng: 0 },
    physicalAddress: "test",
    maxAssuranceTier: 2,
    publicKey: "anp-pubkey",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: now,
    lastHeartbeat: now,
    version: "1.0.0",
  } as any).run();
  db.insert(shopKernels).values({
    id: "kernel-anp-offline",
    name: "ANP Test Kernel (offline)",
    operatorAddress: "0xanp2",
    location: { lat: 0, lng: 0 },
    physicalAddress: "test",
    maxAssuranceTier: 2,
    publicKey: "anp-pubkey-2",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "offline",
    registeredAt: now,
    lastHeartbeat: now,
    version: "1.0.0",
  } as any).run();
  db.insert(capabilities).values({
    id: "cap-anp-1",
    kernelId: "kernel-anp-online",
    type: "fdm",
    name: "FDM 3D printer",
    description: "Test FDM",
    materials: ["PLA"],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
    location: { lat: 0, lng: 0 },
    queueDepth: 0,
    availability: { timezone: "UTC", windows: {} },
  } as any).run();

  const app = Fastify({ logger: false });
  await app.register(wellKnownRoutes);
  await app.ready();
  return app;
}

describe("ANP discovery surface", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  // ── /.well-known/agent-card.json (protocolVersion bump) ──────────────────

  describe("GET /.well-known/agent-card.json", () => {
    it("returns protocolVersion '1.0' (A2A v1.0 stable)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/agent-card.json",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.protocolVersion).toBe("1.0");
    });

    it("includes CORS wildcard", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/agent-card.json",
      });
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });

    it("maps discovery, hire, and verification to real A2A skills and endpoints", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/agent-card.json",
      });
      const body = res.json();

      expect(body.url).toMatch(/^https:\/\/[^/]+\/a2a\/tasks\/send$/);
      expect(body.supportedInterfaces).toEqual([
        {
          url: body.url,
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
      ]);
      expect(body.capabilities).toMatchObject({
        streaming: false,
        extendedAgentCard: false,
      });
      expect(body.skills.map((skill: { id: string }) => skill.id)).toEqual(
        expect.arrayContaining([
          "discover_capability",
          "hire_capability",
          "verify_evidence",
          "pcc-discover",
          "pcc-submit",
          "pcc-verify",
        ]),
      );
      expect(body["x-pcc-core-skills"]).toMatchObject({
        discover_capability: { a2aSkill: "pcc-discover" },
        hire_capability: { a2aSkill: "pcc-submit" },
        verify_evidence: { a2aSkill: "pcc-verify" },
      });
    });
  });

  // ── /.well-known/agent-descriptions (ANP CollectionPage) ─────────────────

  describe("GET /.well-known/agent-descriptions", () => {
    it("returns status 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/agent-descriptions",
      });
      expect(res.statusCode).toBe(200);
    });

    it("declares CollectionPage type with ActivityStreams context", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/agent-descriptions",
      });
      const body = res.json();
      expect(body.type).toBe("CollectionPage");
      expect(Array.isArray(body["@context"])).toBe(true);
      expect(body["@context"][0]).toBe(
        "https://www.w3.org/ns/activitystreams",
      );
    });

    it("totalItems matches items.length", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/agent-descriptions",
      });
      const body = res.json();
      expect(body.totalItems).toBe(body.items.length);
    });

    it("includes the gateway's own agent-card URL as first item", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/agent-descriptions",
      });
      const body = res.json();
      expect(body.items[0]).toContain("/.well-known/agent-card.json");
    });

    it("includes the online kernel but NOT the offline kernel", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/agent-descriptions",
      });
      const body = res.json();
      const joined = body.items.join("\n");
      expect(joined).toContain("kernel-anp-online");
      expect(joined).not.toContain("kernel-anp-offline");
    });

    it("returns application/ld+json content-type", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/agent-descriptions",
      });
      expect(res.headers["content-type"]).toContain("application/ld+json");
    });

    it("includes Access-Control-Allow-Origin: * header", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/agent-descriptions",
      });
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });

    it("Cache-Control is public, max-age=300 (5 minutes)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/agent-descriptions",
      });
      expect(res.headers["cache-control"]).toBe("public, max-age=300");
    });
  });

  // ── /api/kernels/:kernelId/agent-card.json ───────────────────────────────

  describe("GET /api/kernels/:kernelId/agent-card.json", () => {
    it("returns 200 for an existing kernel", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/kernel-anp-online/agent-card.json",
      });
      expect(res.statusCode).toBe(200);
    });

    it("returns 404 for an unknown kernel", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/does-not-exist/agent-card.json",
      });
      expect(res.statusCode).toBe(404);
    });

    it("returned card declares protocolVersion '1.0'", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/kernel-anp-online/agent-card.json",
      });
      const body = res.json();
      expect(body.protocolVersion).toBe("1.0");
    });

    it("returned card lists the kernel's capability types", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/kernel-anp-online/agent-card.json",
      });
      const body = res.json();
      expect(body["x-pcc-capability-types"]).toContain("fdm");
    });

    it("returned card includes x-pcc-kernel-id matching the path", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/kernel-anp-online/agent-card.json",
      });
      const body = res.json();
      expect(body["x-pcc-kernel-id"]).toBe("kernel-anp-online");
    });

    it("returned card has CORS wildcard header", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/kernel-anp-online/agent-card.json",
      });
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });
});
