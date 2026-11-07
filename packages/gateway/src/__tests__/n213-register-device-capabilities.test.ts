import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { setupRoutes } from "../routes/setup.js";
import { closeStore, getRepos, initStore } from "../db.js";

const KERNEL_ID = "kernel-n213";
const OWNER = "op-n213";

async function buildApp(): Promise<FastifyInstance> {
  const savedAdminKey = process.env.PCC_ADMIN_KEY;
  const adminKey = randomUUID();
  process.env.PCC_ADMIN_KEY = adminKey;
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  app.decorateRequest("userId", null);
  app.decorateRequest("operatorId", null);
  app.addHook("onRequest", async (req) => {
    const key = req.headers["x-test-key"];
    if (typeof key === "string") {
      (req as { userId?: string }).userId = key;
      (req as { operatorId?: string }).operatorId = key;
      if (key === OWNER) req.headers["x-admin-key"] = adminKey;
    }
  });
  app.addHook("onClose", async () => {
    if (savedAdminKey === undefined) delete process.env.PCC_ADMIN_KEY;
    else process.env.PCC_ADMIN_KEY = savedAdminKey;
  });
  await app.register(setupRoutes);
  await app.ready();
  return app;
}

function seedKernel(): void {
  const now = new Date().toISOString();
  getRepos().kernels.insert({
    id: KERNEL_ID, name: KERNEL_ID, operatorAddress: OWNER,
    location: { lat: 0, lng: 0 }, physicalAddress: "1 Lab St", maxAssuranceTier: 2,
    publicKey: "pk", reputation: 0, totalJobsCompleted: 0, status: "online",
    registeredAt: now, lastHeartbeat: now, version: "1",
  } as never);
}

describe("N213 register-device capability types", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    seedKernel();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  const register = (deviceId: string, capabilities: unknown) => app.inject({
    method: "POST",
    url: "/api/setup/register-device",
    headers: { "x-test-key": OWNER },
    payload: { kernelId: KERNEL_ID, deviceId, type: "machine", adapterType: "mock", capabilities },
  });

  it("T1: stores only non-empty strings from a mixed capabilities array", async () => {
    const response = await register("device-n213-mixed", ["", "n213-fdm", 7]);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ registered: true, action: "created" });

    const capabilities = getRepos().capabilities;
    const rows = capabilities.findByKernel(KERNEL_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "cap-kernel-n213-n213-fdm", type: "n213-fdm" });
    expect(capabilities.findById("cap-kernel-n213-")).toBeUndefined();
    expect(capabilities.findById("cap-kernel-n213-7")).toBeUndefined();
  });

  it("T2: does not iterate a string capabilities value", async () => {
    const response = await register("device-n213-string", "n213");
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ registered: true });

    const capabilities = getRepos().capabilities;
    expect(capabilities.findByKernel(KERNEL_ID)).toHaveLength(0);
    for (const capType of ["n", "2", "1", "3"]) {
      expect(capabilities.findById(`cap-kernel-n213-${capType}`)).toBeUndefined();
    }
  });

  it("T3: stores both valid capability strings unchanged", async () => {
    const response = await register("device-n213-valid", ["n213-a", "n213-b"]);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ registered: true, action: "created" });

    const rows = getRepos().capabilities.findByKernel(KERNEL_ID);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cap-kernel-n213-n213-a", type: "n213-a" }),
      expect.objectContaining({ id: "cap-kernel-n213-n213-b", type: "n213-b" }),
    ]));
  });
});
