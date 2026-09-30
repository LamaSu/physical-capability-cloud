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

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
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
      payload: {
        kernelId: "kernel-nyc",
        type: "contract.requirements-schema",
        id: "cap-contract-requirements-schema",
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
      payload: {
        kernelId: "kernel-nyc",
        type: "contract.accepted-only",
        id: "cap-contract-accepted-only",
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
    const id = "cap-contract-second-post";
    const first = await app.inject({
      method: "POST",
      url: "/api/capabilities",
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
    const id = "cap-contract-availability-at-create";
    const availability = { mode: "scheduled", timezone: "UTC" };
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities",
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
  it("reports a mismatched kernelId and type instead of hiding them", async () => {
    const app = await buildApp();
    try {
      const first = await app.inject({ method: "POST", url: "/api/capabilities", payload: { id: "cap-x-conflict", kernelId: "kernel-nyc", type: "one" } });
      expect(first.statusCode).toBe(201);
      const second = await app.inject({ method: "POST", url: "/api/capabilities", payload: { id: "cap-x-conflict", kernelId: "kernel-la", type: "two" } });
      expect(second.statusCode).toBe(200);
      expect(second.json().created).toBe(false);
      expect(second.json().ignoredFields).toEqual(expect.arrayContaining(["kernelId", "type"]));
      expect(second.json().conflicts).toEqual(["kernelId", "type"]);
    } finally {
      await app.close();
    }
  });
});
