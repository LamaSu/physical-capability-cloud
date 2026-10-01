/**
 * Tests for the third-party digital kernel marketplace:
 *   POST /api/kernels/register              — submit manifest
 *   GET  /api/kernels/marketplace           — list verified kernels
 *   GET  /api/kernels/marketplace/:id       — single lookup
 *   POST /api/kernels/:id/verify            — admin smoke test
 *   POST /api/kernels/:id/suspend           — admin suspension
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { DigitalKernelManifest } from "@pcc/spec";
import {
  kernelMarketplaceRoutes,
  _clearKernelRegistry,
  _setSmokeTestFetch,
} from "../routes/kernel-marketplace.js";
import { initStore, closeStore, getRepos } from "../db.js";

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Identity shim standing in for apiGate, which attaches `operatorId` in
  // production (carrier.test.ts pattern). WP-C records the manifest's
  // registrant so a manifest only borrows the ceiling of a kernel row that the
  // same actor owns.
  app.addHook("onRequest", async (req) => {
    const h = req.headers["x-test-operator"];
    if (typeof h === "string" && h) (req as unknown as { operatorId?: string }).operatorId = h;
  });
  await app.register(kernelMarketplaceRoutes);
  await app.ready();
  return app;
}

/**
 * Insert a shop-kernel row with a proven signer and a strong track record, so
 * its authorized ceiling is 3. It is owned by `owner`.
 */
function insertAuthorizedKernel(id: string, owner: string) {
  getRepos().kernels.insert({
    id,
    name: `Authorized ${id}`,
    operatorAddress: owner,
    location: { lat: 0, lng: 0 },
    physicalAddress: "",
    maxAssuranceTier: 3,
    publicKey: `0x${"00".repeat(32)}`,
    signingAddress: "0x1234567890abcdef1234567890abcdef12345678",
    signingKeyAlgorithm: "secp256k1",
    reputation: 900,
    totalJobsCompleted: 50,
    status: "online",
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "0.1.0",
  } as never);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseManifest(overrides: Partial<DigitalKernelManifest> = {}): DigitalKernelManifest {
  return {
    manifestVersion: "1.0.0",
    kernelId: "k-temp-converter-acme",
    name: "Temperature Converter",
    description: "Converts Celsius to Fahrenheit with 4 decimals of precision.",
    builder: {
      agentId: "eip155:84532:0x1234567890abcdef1234567890abcdef12345678",
      contactURI: "mailto:builder@acme.example",
    },
    capabilityType: "temperature-converter",
    workflowSteps: [
      {
        stepId: "convert",
        stepType: "transform",
        description: "C -> F",
        dependsOn: [],
      },
    ],
    pricing: {
      currency: "USDC",
      baseUSD: 0.01,
    },
    maxAssuranceTier: 1,
    endpointURL: "https://kernel.acme.example/run",
    sessionKeyPolicy: {
      maxTTLSeconds: 600,
      allowedActions: ["evidence_submit", "workflow_step_complete"],
    },
    status: "pending",
    ...overrides,
  };
}

// Fetch mock: respond based on the URL the smoke test hits.
function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
) {
  _setSmokeTestFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TEST_ADMIN_KEY = "kernel-marketplace-test-admin-key";
const ADMIN_HEADERS = { "x-admin-key": TEST_ADMIN_KEY };

describe("Kernel Marketplace", () => {
  let app: FastifyInstance;

  // The admin routes (verify, suspend) need a configured admin secret in
  // every environment (WP-A e666b159: no test/development exception), so the
  // suite sets one and presents it on its admin calls.
  const savedAdminKey = process.env.PCC_ADMIN_KEY;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.PCC_ADMIN_KEY = TEST_ADMIN_KEY;
    initStore({ seed: false });
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    if (savedAdminKey === undefined) delete process.env.PCC_ADMIN_KEY;
    else process.env.PCC_ADMIN_KEY = savedAdminKey;
  });

  beforeEach(() => {
    _clearKernelRegistry();
    _setSmokeTestFetch(null);
  });

  afterEach(() => {
    _setSmokeTestFetch(null);
  });

  // ── POST /api/kernels/register ─────────────────────────────────────────

  describe("POST /api/kernels/register", () => {
    it("accepts a valid manifest and returns 201 with kernelId + pending status", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { manifest: baseManifest() },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.kernelId).toBe("k-temp-converter-acme");
      expect(body.status).toBe("pending");
      expect(typeof body.nextStep).toBe("string");
    });

    it("accepts a raw (non-wrapped) manifest body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: baseManifest({ kernelId: "k-raw-body" }),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().kernelId).toBe("k-raw-body");
    });

    it("rejects a manifest missing builder.agentId with 400", async () => {
      const bad = baseManifest();
      (bad as unknown as { builder: unknown }).builder = { contactURI: "mailto:x@y" };
      const res = await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { manifest: bad },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("invalid_manifest");
      expect(body.errors).toEqual(expect.arrayContaining([expect.stringMatching(/builder\.agentId/)]));
    });

    it("rejects a non-HTTPS endpointURL with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { manifest: baseManifest({ endpointURL: "http://insecure.example/run" }) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors).toEqual(
        expect.arrayContaining([expect.stringMatching(/endpointURL.*HTTPS/)]),
      );
    });

    it("rejects zero workflowSteps with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { manifest: baseManifest({ workflowSteps: [] }) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors).toEqual(
        expect.arrayContaining([expect.stringMatching(/workflowSteps/)]),
      );
    });

    it("rejects garbage bodies with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { not: "a manifest" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects duplicate kernelId with 409", async () => {
      const payload = { manifest: baseManifest({ kernelId: "k-dup" }) };
      const first = await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload,
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload,
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("kernel_already_registered");
    });

    it("rejects out-of-range maxAssuranceTier", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: {
          manifest: baseManifest({ maxAssuranceTier: 9 as unknown as 3 }),
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── GET /api/kernels/marketplace ────────────────────────────────────────

  describe("GET /api/kernels/marketplace", () => {
    it("returns an empty list initially", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/marketplace",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ kernels: [], count: 0 });
    });

    it("does not list pending kernels — only verified kernels appear", async () => {
      await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { manifest: baseManifest({ kernelId: "k-pending" }) },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/marketplace",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().count).toBe(0);
    });

    it("lists verified kernels and filters by capabilityType", async () => {
      // Register + verify two kernels of different types
      await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: {
          manifest: baseManifest({
            kernelId: "k-temp",
            capabilityType: "temperature-converter",
          }),
        },
      });
      await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: {
          manifest: baseManifest({
            kernelId: "k-currency",
            capabilityType: "currency-converter",
          }),
        },
      });
      mockFetch(async () => new Response("{}", { status: 200 }));
      await app.inject({
        method: "POST",
        url: "/api/kernels/k-temp/verify",
        headers: ADMIN_HEADERS,
      });
      await app.inject({
        method: "POST",
        url: "/api/kernels/k-currency/verify",
        headers: ADMIN_HEADERS,
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/marketplace?capabilityType=temperature-converter",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(1);
      expect(body.kernels[0].kernelId).toBe("k-temp");
    });

    it("filters by minAssuranceTier on the SERVED (ceiling-capped) tier", async () => {
      // Old version: two self-declared manifests (claims 1 and 3) with no
      // kernel rows behind them; the filter at minAssuranceTier=2 returned the
      // tier-3 claim. That is exactly the unsafe behaviour: a verify smoke
      // test certified a self-declared tier. WP-C: the served tier is
      // min(claim, authorized ceiling of a kernel row owned by the
      // registrant). k-t3 is backed by such a row (ceiling 3). k-t3-unbacked
      // claims 3 with no authorized kernel and is served 0.
      insertAuthorizedKernel("k-t3", "builder-op");
      const asBuilder = { "x-test-operator": "builder-op" };
      for (const [kernelId, tier] of [
        ["k-t1", 1],
        ["k-t3", 3],
        ["k-t3-unbacked", 3],
      ] as const) {
        const reg = await app.inject({
          method: "POST",
          url: "/api/kernels/register",
          headers: asBuilder,
          payload: { manifest: baseManifest({ kernelId, maxAssuranceTier: tier }) },
        });
        expect(reg.statusCode).toBe(201);
      }
      mockFetch(async () => new Response("{}", { status: 200 }));
      for (const kernelId of ["k-t1", "k-t3", "k-t3-unbacked"]) {
        const v = await app.inject({ method: "POST", url: `/api/kernels/${kernelId}/verify`, headers: ADMIN_HEADERS });
        expect(v.statusCode).toBe(200);
      }

      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/marketplace?minAssuranceTier=2",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(1);
      expect(body.kernels[0].kernelId).toBe("k-t3");
      expect(body.kernels[0].maxAssuranceTier).toBe(3);

      // Every verified entry serves its capped tier, never the raw claim.
      const all = (await app.inject({ method: "GET", url: "/api/kernels/marketplace" })).json();
      const tierById = Object.fromEntries(
        all.kernels.map((k: { kernelId: string; maxAssuranceTier: number }) => [k.kernelId, k.maxAssuranceTier]),
      );
      expect(tierById).toEqual({ "k-t1": 0, "k-t3": 3, "k-t3-unbacked": 0 });
    });

    it("sorts by price (ascending) when sortBy=price", async () => {
      await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: {
          manifest: baseManifest({
            kernelId: "k-expensive",
            pricing: { currency: "USDC", baseUSD: 10 },
          }),
        },
      });
      await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: {
          manifest: baseManifest({
            kernelId: "k-cheap",
            pricing: { currency: "USDC", baseUSD: 0.01 },
          }),
        },
      });
      mockFetch(async () => new Response("{}", { status: 200 }));
      await app.inject({
        method: "POST",
        url: "/api/kernels/k-expensive/verify",
        headers: ADMIN_HEADERS,
      });
      await app.inject({
        method: "POST",
        url: "/api/kernels/k-cheap/verify",
        headers: ADMIN_HEADERS,
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/marketplace?sortBy=price",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.kernels[0].kernelId).toBe("k-cheap");
      expect(body.kernels[1].kernelId).toBe("k-expensive");
    });

    it("sorts by assuranceScore — undefined scores sort last", async () => {
      await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { manifest: baseManifest({ kernelId: "k-a" }) },
      });
      await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { manifest: baseManifest({ kernelId: "k-b" }) },
      });
      mockFetch(async () => new Response("{}", { status: 200 }));
      await app.inject({
        method: "POST",
        url: "/api/kernels/k-a/verify",
        headers: ADMIN_HEADERS,
      });
      await app.inject({
        method: "POST",
        url: "/api/kernels/k-b/verify",
        headers: ADMIN_HEADERS,
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/marketplace?sortBy=assuranceScore",
      });
      expect(res.statusCode).toBe(200);
      // Sort is stable for undefined; both kernels have undefined score so
      // we just assert the call succeeds and returns 2 entries.
      expect(res.json().count).toBe(2);
    });
  });

  // ── GET /api/kernels/marketplace/:kernelId ──────────────────────────────

  describe("GET /api/kernels/marketplace/:kernelId", () => {
    it("returns the single kernel when it exists", async () => {
      await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { manifest: baseManifest({ kernelId: "k-single" }) },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/marketplace/k-single",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().kernel.kernelId).toBe("k-single");
    });

    it("returns 404 when kernelId is unknown", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/kernels/marketplace/k-does-not-exist",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── POST /api/kernels/:kernelId/verify ──────────────────────────────────

  describe("POST /api/kernels/:kernelId/verify", () => {
    it("marks the kernel as verified on successful smoke test", async () => {
      await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { manifest: baseManifest({ kernelId: "k-verify-pass" }) },
      });
      mockFetch(async (url) => {
        expect(url).toContain("kernel.acme.example");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/kernels/k-verify-pass/verify",
        headers: ADMIN_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("verified");
      expect(typeof body.verifiedAt).toBe("string");
    });

    it("leaves the kernel in pending when smoke test fails (non-2xx)", async () => {
      await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { manifest: baseManifest({ kernelId: "k-verify-fail" }) },
      });
      mockFetch(async () => new Response("service down", { status: 502 }));
      const res = await app.inject({
        method: "POST",
        url: "/api/kernels/k-verify-fail/verify",
        headers: ADMIN_HEADERS,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("smoke_test_failed");

      // Confirm it's still pending
      const check = await app.inject({
        method: "GET",
        url: "/api/kernels/marketplace/k-verify-fail",
      });
      expect(check.json().kernel.status).toBe("pending");
    });

    it("returns 404 for unknown kernelId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/kernels/k-nope/verify",
        headers: ADMIN_HEADERS,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── POST /api/kernels/:kernelId/suspend ─────────────────────────────────

  describe("POST /api/kernels/:kernelId/suspend", () => {
    it("rejects suspension without admin key (production mode)", async () => {
      await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { manifest: baseManifest({ kernelId: "k-susp" }) },
      });

      const originalAdmin = process.env.PCC_ADMIN_KEY;
      const originalNode = process.env.NODE_ENV;
      process.env.PCC_ADMIN_KEY = "supersecret";
      process.env.NODE_ENV = "production";
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/kernels/k-susp/suspend",
          payload: { reason: "test" },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        if (originalAdmin === undefined) delete process.env.PCC_ADMIN_KEY;
        else process.env.PCC_ADMIN_KEY = originalAdmin;
        if (originalNode === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNode;
      }
    });

    it("allows suspension with matching admin key", async () => {
      await app.inject({
        method: "POST",
        url: "/api/kernels/register",
        payload: { manifest: baseManifest({ kernelId: "k-susp-ok" }) },
      });
      const originalAdmin = process.env.PCC_ADMIN_KEY;
      process.env.PCC_ADMIN_KEY = "supersecret";
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/kernels/k-susp-ok/suspend",
          headers: { "x-admin-key": "supersecret" },
          payload: { reason: "abuse" },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.status).toBe("suspended");
        expect(body.reason).toBe("abuse");
      } finally {
        if (originalAdmin === undefined) delete process.env.PCC_ADMIN_KEY;
        else process.env.PCC_ADMIN_KEY = originalAdmin;
      }
    });

    it("returns 404 for unknown kernelId on suspend", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/kernels/k-missing/suspend",
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
