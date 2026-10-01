/**
 * G12 — POST /api/capabilities must not silently drop unrecognized top-level
 * body fields. CapabilityFacade.create() only persists the fields of
 * CreateCapabilityInput; anything else (e.g. requirementsSchema) was being
 * accepted with a 201 and then quietly discarded. These tests pin the
 * `ignoredFields` / `hints` / `note` contract added on top of that facade
 * behavior, without changing status codes or any existing response field.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { capabilityRoutes } from "../routes/capabilities.js";
import { initStore, closeStore, getRepos } from "../db.js";

/** Seeded owners (operatorAddress) of kernel-nyc and kernel-la. */
const NYC_OWNER = "0x1111111111111111111111111111111111111111";
const LA_OWNER = "0x3333333333333333333333333333333333333333";
const asNyc = { "x-test-operator": NYC_OWNER };

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  // Identity shim standing in for apiGate (same pattern as
  // capabilities-types-union.test.ts). WP-C: POST /api/capabilities is
  // owner-only (401 without an actor), so every create below is made as the
  // seeded owner of its kernel. (Old: the POST carried no identity and was
  // accepted.) WP-C R5 also derives the id, cap-<kernelId>-<type>; a body id
  // that disagrees is refused with 400, so the ids below are the derived ones.
  app.addHook("onRequest", async (req) => {
    const h = req.headers["x-test-operator"];
    if (typeof h === "string" && h) (req as unknown as { operatorId?: string }).operatorId = h;
  });
  await app.register(capabilityRoutes);
  await app.ready();
  return app;
}

describe("POST /api/capabilities -- create contract (G12)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("a body with requirementsSchema gets 201 plus ignoredFields and the CSD hint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: asNyc,
      payload: {
        kernelId: "kernel-nyc",
        type: "contract.requirements-schema",
        id: "cap-kernel-nyc-contract.requirements-schema",
        requirementsSchema: { type: "object", properties: { qty: { type: "number" } } },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.ignoredFields).toEqual(["requirementsSchema"]);
    expect(body.hints).toEqual([
      "requirementsSchema is not stored on a capability: a capability's typed parameters belong in its CSD (register one with POST /api/csd).",
    ]);
  });

  it("a body with only accepted fields has no ignoredFields key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: asNyc,
      payload: {
        kernelId: "kernel-nyc",
        type: "contract.accepted-only",
        id: "cap-kernel-nyc-contract.accepted-only",
        name: "Accepted Fields Only",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toBe(true);
    expect("ignoredFields" in body).toBe(false);
    expect("hints" in body).toBe(false);
  });

  it("a second POST of the same capability with availability gets 200, created:false, ignoredFields, and the note", async () => {
    const id = "cap-kernel-nyc-contract.second-post";
    const first = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: asNyc,
      payload: {
        kernelId: "kernel-nyc",
        type: "contract.second-post",
        id,
      },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: asNyc,
      payload: {
        kernelId: "kernel-nyc",
        type: "contract.second-post",
        id,
        availability: { mode: "always" },
      },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.created).toBe(false);
    expect(body.ignoredFields).toContain("availability");
    expect(body.note).toBe(
      "This capability already exists; POST /api/capabilities never updates it. To change availability, use PUT /api/capabilities/:id/availability.",
    );
  });

  it("availability sent at FIRST creation is persisted (pins existing create-time behavior)", async () => {
    const id = "cap-kernel-nyc-contract.availability-at-create";
    const availability = { mode: "scheduled", timezone: "UTC" };
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: asNyc,
      payload: {
        kernelId: "kernel-nyc",
        type: "contract.availability-at-create",
        id,
        availability,
      },
    });
    expect(res.statusCode).toBe(201);
    expect("ignoredFields" in res.json()).toBe(false);

    const row = getRepos().capabilities.findById(id);
    expect(row).toBeDefined();
    expect((row as any)?.availability).toEqual(availability);
  });
});

describe("pack 111 MEDIUM 4: a duplicate create reports kernelId/type conflicts as ignored", () => {
  // WP-C R5 changed what is reachable here. The id is DERIVED (cap-<kernelId>-<type>),
  // so a caller can no longer reuse an existing id with a different kernelId/type:
  // that is refused outright (400 capability_id_mismatch), which is stricter than
  // reporting the mismatch as ignored. (Old: the same id with kernel-la/two was a
  // 200 created:false with conflicts [kernelId, type].) Nothing is hidden: the
  // request fails, and the existing row is untouched.
  it("a different kernelId and type under an existing id is refused, never silently ignored", async () => {
    const app = await buildApp();
    try {
      const first = await app.inject({ method: "POST", url: "/api/capabilities", headers: asNyc, payload: { id: "cap-kernel-nyc-one", kernelId: "kernel-nyc", type: "one" } });
      expect(first.statusCode).toBe(201);
      const second = await app.inject({ method: "POST", url: "/api/capabilities", headers: { "x-test-operator": LA_OWNER }, payload: { id: "cap-kernel-nyc-one", kernelId: "kernel-la", type: "two" } });
      expect(second.statusCode).toBe(400);
      expect(second.json().error).toBe("capability_id_mismatch");
      const row = getRepos().capabilities.findById("cap-kernel-nyc-one") as { kernelId?: string; type?: string } | undefined;
      expect(row?.kernelId).toBe("kernel-nyc");
      expect(row?.type).toBe("one");
    } finally {
      await app.close();
    }
  });

  // The conflicts report (N83) is still reachable for a LEGACY row whose stored type
  // differs from the one its id implies: the derived id finds that row, the type
  // disagrees, and the response says so instead of hiding it. kernelId can no longer
  // conflict (a derived id held by another kernel is 409 capability_id_taken).
  it("reports a stored type that differs from the requested one for a legacy row", async () => {
    const app = await buildApp();
    try {
      getRepos().capabilities.insert({
        id: "cap-kernel-nyc-legacy",
        kernelId: "kernel-nyc",
        type: "legacy-stored-type",
        name: "Legacy row",
        description: "Row whose id and stored type disagree",
        materials: [],
        assuranceTiers: [0],
        pricing: { currency: "USDC", baseCost: "0", minimum: "0" },
        availability: {},
        location: { lat: 0, lng: 0 },
      } as any);
      const res = await app.inject({ method: "POST", url: "/api/capabilities", headers: asNyc, payload: { kernelId: "kernel-nyc", type: "legacy" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().created).toBe(false);
      expect(res.json().ignoredFields).toEqual(["type"]);
      expect(res.json().conflicts).toEqual(["type"]);
    } finally {
      await app.close();
    }
  });
});
