/**
 * Z3 — wizard completion performs REAL backend operations when a store is
 * available: after POST /complete, the reported ids correspond to rows that
 * actually exist (registrations / kernel devices) in the same store the
 * /api/onboard and /api/setup routes read.
 *
 * Separate file from wizard.test.ts on purpose: the gateway db singleton is
 * per-process, and wizard.test.ts pins the storeless (honest-skip) behavior.
 * Vitest isolates test files into separate workers, so both states coexist.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { wizardRoutes, _clearSessionsForTesting } from "../routes/wizard.js";
import { initStore, closeStore, getRepos } from "../db.js";

// ── Helpers ────────────────────────────────────────────────────────────────

async function createSession(app: FastifyInstance, track: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/wizard/sessions",
    payload: { track },
  });
  return res.json().session.id;
}

async function saveStep(
  app: FastifyInstance,
  sessionId: string,
  step: number,
  data: Record<string, unknown>,
): Promise<void> {
  await app.inject({
    method: "PUT",
    url: `/api/wizard/sessions/${sessionId}/steps/${step}`,
    payload: { data },
  });
}

function seedKernel(id: string): void {
  getRepos().kernels.insert({
    id,
    name: `Kernel ${id}`,
    operatorAddress: "op@example.com",
    location: { lat: 0, lng: 0 },
    physicalAddress: "1 Test St",
    maxAssuranceTier: 2,
    publicKey: "pk",
    reputation: 500,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "1.0.0",
  } as never);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Wizard completion with a real store (Z3)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });

    app = Fastify({ logger: false });
    await app.register(wizardRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  beforeEach(() => {
    _clearSessionsForTesting();
  });

  it("machine-onboarding creates a REAL registration row under the reported id", async () => {
    const sessionId = await createSession(app, "machine-onboarding");
    await saveStep(app, sessionId, 0, {
      name: "Prusa MK4",
      category: "3d-printer",
      manufacturer: "Prusa Research",
      model: "MK4",
    });
    for (let i = 1; i < 7; i++) {
      await saveStep(app, sessionId, i, { [`field_${i}`]: `value_${i}` });
    }

    const res = await app.inject({
      method: "POST",
      url: `/api/wizard/sessions/${sessionId}/complete`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.success).toBe(true);
    expect(body.session.status).toBe("completed");

    const step = body.result.executedSteps.find(
      (s: { name: string }) => s.name === "build-registration",
    );
    expect(step.status).toBe("success");
    const regId: string = step.data.registrationId;
    expect(typeof regId).toBe("string");

    // The id is REAL — the row exists in the store the onboard routes read
    const row = getRepos().registrations.findById(regId);
    expect(row).toBeDefined();
    expect(row?.name).toBe("Prusa MK4");
    expect(row?.category).toBe("3d-printer");
    expect(row?.manufacturer).toBe("Prusa Research");
    expect(row?.status).toBe("submitted");
    expect(row?.submittedAt).toBeTruthy();
  });

  it("device-builder registers REAL device rows when the kernel exists", async () => {
    seedKernel("kernel_wiz_devices");

    const sessionId = await createSession(app, "device-builder");
    await saveStep(app, sessionId, 0, { deviceName: "Prusa MK4", deviceType: "machine" });
    await saveStep(app, sessionId, 1, { adapterType: "mock" });
    await saveStep(app, sessionId, 2, { capabilities: ["fdm"] });
    await saveStep(app, sessionId, 3, { connectionTested: true });
    await saveStep(app, sessionId, 4, { kernelId: "kernel_wiz_devices" });

    const res = await app.inject({
      method: "POST",
      url: `/api/wizard/sessions/${sessionId}/complete`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.success).toBe(true);

    const step = body.result.executedSteps.find(
      (s: { name: string }) => s.name === "register-devices",
    );
    expect(step.status).toBe("success");
    expect(body.result.registeredDevices).toHaveLength(1);

    // Each reported id is REAL — the device row exists under the kernel
    for (const deviceId of body.result.registeredDevices as string[]) {
      const device = getRepos().kernels.findDeviceById(deviceId);
      expect(device).toBeDefined();
      expect(device?.kernelId).toBe("kernel_wiz_devices");
      expect(device?.adapterType).toBe("mock");
      expect(device?.model).toBe("Prusa MK4");
    }
  });

  it("device-builder reports skipped (and writes NO rows) when the kernel does not exist", async () => {
    const sessionId = await createSession(app, "device-builder");
    await saveStep(app, sessionId, 0, { deviceName: "Ghost Printer", deviceType: "machine" });
    await saveStep(app, sessionId, 1, { adapterType: "mock" });
    await saveStep(app, sessionId, 2, { capabilities: ["fdm"] });
    await saveStep(app, sessionId, 3, { connectionTested: true });
    await saveStep(app, sessionId, 4, { kernelId: "kernel_ghost_none" });

    const res = await app.inject({
      method: "POST",
      url: `/api/wizard/sessions/${sessionId}/complete`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.success).toBe(true);

    const step = body.result.executedSteps.find(
      (s: { name: string }) => s.name === "register-devices",
    );
    expect(step.status).toBe("skipped");
    expect(step.data.deviceIds).toEqual([]);
    expect(body.result.registeredDevices).toEqual([]);
    // Nothing was written for the ghost kernel
    expect(getRepos().kernels.findDevicesByKernel("kernel_ghost_none")).toEqual([]);
  });

  it("completing twice is rejected, so a registration is only submitted once", async () => {
    const sessionId = await createSession(app, "machine-onboarding");
    await saveStep(app, sessionId, 0, { name: "OnceOnly", category: "custom" });
    for (let i = 1; i < 7; i++) {
      await saveStep(app, sessionId, i, { [`field_${i}`]: i });
    }

    const first = await app.inject({
      method: "POST",
      url: `/api/wizard/sessions/${sessionId}/complete`,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/api/wizard/sessions/${sessionId}/complete`,
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe("already_completed");

    const matching = getRepos()
      .registrations.findAll()
      .filter((r) => r.name === "OnceOnly");
    expect(matching).toHaveLength(1);
  });
});
