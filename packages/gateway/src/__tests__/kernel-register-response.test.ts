import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { kernelRoutes } from "../routes/kernels.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { initStore, closeStore, getRepos } from "../db.js";

/**
 * Discovery-status response shape on /api/kernels.
 *
 * Background: POST /api/kernels returning 201 historically did NOT signal that
 * a kernel-only registration is undiscoverable. Catalog discovery filters on
 * capabilities, not kernels. The route now emits a `discoveryStatus` and
 * `nextStep` hint so operators know they still need to POST /api/capabilities.
 *
 * Three properties under test:
 *   1. Newly POSTed kernel reports kernel-registered-not-discoverable + hint.
 *   2. GET /api/kernels/:id with zero capabilities reports the same status.
 *   3. GET /api/kernels/:id with >=1 capability flips to "discoverable" and
 *      drops the hint.
 *
 * Backwards-compat is asserted by checking existing fields (id, kernel)
 * survived alongside the new ones.
 */

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });

  const app = Fastify({ logger: false });
  await app.register(kernelRoutes);
  await app.register(capabilityRoutes);
  await app.ready();
  return app;
}

describe("POST /api/kernels — discovery status surface", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("returns the new discoveryStatus + nextStep + capabilities fields on 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id: "kernel-discovery-test-1",
        name: "Discovery Test Kernel 1",
        operatorAddress: "0xabc1111111111111111111111111111111111111",
        physicalAddress: "1 Test St",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();

    // ── Backwards compatibility: original fields still present ───────
    expect(body.kernel).toBeDefined();
    expect(body.kernel.id).toBe("kernel-discovery-test-1");
    expect(body.kernel.name).toBe("Discovery Test Kernel 1");

    // ── New: capabilities is an empty array on fresh registration ───
    expect(Array.isArray(body.capabilities)).toBe(true);
    expect(body.capabilities.length).toBe(0);

    // ── New: explicit discovery status ──────────────────────────────
    expect(body.discoveryStatus).toBe("kernel-registered-not-discoverable");

    // ── New: actionable nextStep hint ───────────────────────────────
    expect(body.nextStep).toBeDefined();
    expect(body.nextStep.action).toBe("POST /api/capabilities");
    expect(typeof body.nextStep.explanation).toBe("string");
    expect(body.nextStep.explanation.length).toBeGreaterThan(0);
    // The hint should reference this exact kernelId
    expect(body.nextStep.explanation).toContain("kernel-discovery-test-1");
    expect(body.nextStep.documentationUrl).toBe(
      "/docs/onboarding/capability-registration",
    );
    expect(typeof body.nextStep.exampleCurl).toBe("string");
    expect(body.nextStep.exampleCurl).toContain("POST <gateway>/api/capabilities");
    expect(body.nextStep.exampleCurl).toContain("kernel-discovery-test-1");
  });

  it("auto-generates a kernelId when none is supplied and uses it in the hint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        name: "Auto-ID Kernel",
        operatorAddress: "0xabc2222222222222222222222222222222222222",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();

    expect(typeof body.kernel.id).toBe("string");
    expect(body.kernel.id.length).toBeGreaterThan(0);
    expect(body.discoveryStatus).toBe("kernel-registered-not-discoverable");
    // The hint must thread the auto-generated id through the example.
    expect(body.nextStep.explanation).toContain(body.kernel.id);
    expect(body.nextStep.exampleCurl).toContain(body.kernel.id);
  });

  it("GET /api/kernels/:id of a fresh kernel reports the same not-discoverable status + hint", async () => {
    // Register a kernel first.
    const postRes = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id: "kernel-discovery-get-undiscoverable",
        name: "Undiscoverable Kernel",
        operatorAddress: "0xabc3333333333333333333333333333333333333",
      },
    });
    expect(postRes.statusCode).toBe(201);

    const getRes = await app.inject({
      method: "GET",
      url: "/api/kernels/kernel-discovery-get-undiscoverable",
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();

    expect(body.kernel).toBeDefined();
    expect(body.kernel.id).toBe("kernel-discovery-get-undiscoverable");
    // No capabilities tied yet.
    expect(body.kernel.capabilityCount).toBe(0);
    expect(Array.isArray(body.kernel.capabilities)).toBe(true);
    expect(body.kernel.capabilities.length).toBe(0);
    expect(body.kernel.discoveryStatus).toBe(
      "kernel-registered-not-discoverable",
    );
    expect(body.kernel.nextStep).toBeDefined();
    expect(body.kernel.nextStep.action).toBe("POST /api/capabilities");
  });

  it("GET /api/kernels/:id flips to discoverable once a capability is tied to the kernel", async () => {
    // Register a kernel first.
    const postRes = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id: "kernel-discovery-get-discoverable",
        name: "Discoverable Kernel",
        operatorAddress: "0xabc4444444444444444444444444444444444444",
      },
    });
    expect(postRes.statusCode).toBe(201);

    // Insert a capability directly via the repo. The capability route surface
    // for create is exercised elsewhere; we only need the row to exist so the
    // kernel's discoveryStatus changes.
    const repos = getRepos();
    repos.capabilities.insert({
      id: "cap-discovery-test-1",
      kernelId: "kernel-discovery-get-discoverable",
      type: "pizza.order",
      name: "Carryout Pizza",
      description: "Carryout pizza order at a single store",
      materials: [],
      assuranceTiers: [0, 1],
      pricing: { currency: "USD", baseCost: "0", minimum: "0" },
      availability: {},
      location: { lat: 0, lng: 0 },
    } as any);

    const getRes = await app.inject({
      method: "GET",
      url: "/api/kernels/kernel-discovery-get-discoverable",
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();

    expect(body.kernel.capabilityCount).toBe(1);
    expect(body.kernel.discoveryStatus).toBe("discoverable");
    // When discoverable, the actionable hint is suppressed — there's nothing
    // more to do.
    expect(body.kernel.nextStep).toBeUndefined();
  });
});
