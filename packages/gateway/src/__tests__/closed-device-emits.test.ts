/**
 * N128 r2, finding 2: a device row stored under the open emitter grammar is never served or preserved.
 * The store's kernels repository closes every device row's `emits` (services/closed-device-emits.ts), so
 * setup's re-registration path and the device reads see null for a stored list that doesn't parse.
 *
 * The setup harness (KernelService mock, in-memory store) is the one setup.test.ts uses.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { setupRoutes } from "../routes/setup.js";
import { initStore, closeStore, getRepos } from "../db.js";
import * as kernelServiceModule from "../services/kernel-service.js";
import { initKernelService, resetKernelService } from "../services/kernel-service.js";
import { closeStoredDeviceEmits, closedStoredEmits, withClosedEmits } from "../services/closed-device-emits.js";
import type { KernelConfig } from "@pcc/kernel";

// ---------------------------------------------------------------------------
// Mock the KernelService module to prevent background timer side-effects
// (MockFDMAdapter fire-and-forget jobs cause SIGABRT during test teardown)
// ---------------------------------------------------------------------------

vi.mock("../services/kernel-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/kernel-service.js")>();

  // Default mock state — can be overridden per-test
  let _mockReady = false;
  const _mockDevices = [
    { id: "dev-setup-machine", type: "machine", adapterType: "mock", healthStatus: "healthy" },
    { id: "dev-setup-sensor", type: "sensor", adapterType: "mock", healthStatus: "healthy" },
  ];

  const mockService = {
    kernelId: "kernel-setup-test",
    submitJob: vi
      .fn()
      .mockResolvedValue({ jobId: "test-job-mock", deviceId: "dev-owned", status: "accepted" }),
    getJobStatus: vi.fn().mockResolvedValue({ status: "completed", progress: 100 }),
    listDevices: vi.fn().mockResolvedValue(_mockDevices),
    checkDeviceHealth: vi.fn().mockResolvedValue({ healthy: true, details: "idle" }),
    // test-job (N59): whether a real runner is loaded here, a DB refresh, and
    // whether the loaded runner is a simulator (a mock never passes).
    hasRunner: vi.fn().mockReturnValue(true),
    refreshDeviceFromDb: vi.fn().mockReturnValue({ installed: true }),
    jobRanSimulated: vi.fn().mockReturnValue(false),
  };

  return {
    ...original,
    getKernelService: vi.fn().mockImplementation(() => {
      if (!_mockReady) {
        throw new Error("[kernel-service] Not initialised — call initKernelService() first");
      }
      return mockService;
    }),
    initKernelService: vi.fn().mockImplementation((_config?: unknown) => {
      _mockReady = true;
      return mockService;
    }),
    resetKernelService: vi.fn().mockImplementation(() => {
      _mockReady = false;
    }),
    _mockService: mockService,
  };
});

// ---------------------------------------------------------------------------
// Minimal mock KernelConfig
// ---------------------------------------------------------------------------

const mockConfig: KernelConfig = {
  kernelId: "kernel-setup-test",
  mockMode: true,
  devices: [
    {
      id: "dev-setup-machine",
      type: "machine",
      adapterType: "mock",
      config: { kernelId: "kernel-setup-test", jobDurationMs: 100 },
    },
    {
      id: "dev-setup-sensor",
      type: "sensor",
      adapterType: "mock",
      config: { kernelId: "kernel-setup-test" },
    },
  ],
};

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  resetKernelService();
  initKernelService(mockConfig);

  const app = Fastify({ logger: false });
  // Stand in for apiGate: an x-test-key header names the authenticated caller,
  // as an API key or SIWE session would set req.userId/operatorId in production.
  app.decorateRequest("userId", null);
  app.decorateRequest("operatorId", null);
  app.addHook("onRequest", async (req) => {
    const key = req.headers["x-test-key"];
    if (typeof key === "string") {
      (req as { userId?: string }).userId = key;
      (req as { operatorId?: string }).operatorId = key;
    }
  });
  await app.register(setupRoutes);
  await app.ready();
  return app;
}



// A declaration the open grammar accepted and the closed one refuses: an unknown param key, a free bind and via.
const LEGACY = [{ id: "decl.self_attested", params: { apiKey: "sk_live_x" }, bind: "secret_token", via: "sk_live_x" }];
const CLOSED = [
  { id: "decl.self_attested" },
  { id: "capture.photo_nonced", params: { media: "photo", minClass: "CC1" }, bind: "capturePhotoCid", via: "captureSnapshot" },
];

describe("closedStoredEmits and withClosedEmits", () => {
  it("a closed stored list is served as parsed; an open, malformed or absent one is withheld whole (null)", () => {
    expect(closedStoredEmits(CLOSED)).toEqual(CLOSED);
    expect(closedStoredEmits(LEGACY)).toBeNull();
    expect(closedStoredEmits([...CLOSED, ...LEGACY])).toBeNull();
    for (const bad of [null, undefined, "x", 7, {}, [{ via: "gcode" }]]) expect(closedStoredEmits(bad), JSON.stringify(bad)).toBeNull();
  });

  it("never calls an accessor in a stored value", () => {
    let called = false;
    const params = Object.defineProperty({}, "mode", { enumerable: true, get: () => ((called = true), "plain") });
    expect(closedStoredEmits([{ id: "artifact.hash", params }])).toBeNull();
    expect(called).toBe(false);
  });

  it("withClosedEmits closes a row's own emits and leaves other values alone", () => {
    expect(withClosedEmits({ id: "d", emits: LEGACY })).toEqual({ id: "d", emits: null });
    expect(withClosedEmits({ id: "d", emits: CLOSED })).toEqual({ id: "d", emits: CLOSED });
    expect(withClosedEmits({ id: "d" })).toEqual({ id: "d" });
    expect(withClosedEmits(undefined)).toBeUndefined();
  });

  it("closeStoredDeviceEmits closes sync and async results of every device method", async () => {
    const repo = {
      findDeviceById: () => ({ id: "d", emits: LEGACY }),
      findDevicesByKernel: () => [{ id: "d", emits: LEGACY }, { id: "e", emits: CLOSED }],
      findDevicesByAdapter: async () => [{ id: "d", emits: LEGACY }],
      insertDevice: () => ({ id: "d", emits: LEGACY }),
      updateDevice: async () => ({ id: "d", emits: LEGACY }),
    };
    closeStoredDeviceEmits(repo);
    expect(repo.findDeviceById()).toEqual({ id: "d", emits: null });
    expect(repo.findDevicesByKernel()).toEqual([{ id: "d", emits: null }, { id: "e", emits: CLOSED }]);
    expect(await repo.findDevicesByAdapter()).toEqual([{ id: "d", emits: null }]);
    expect(repo.insertDevice()).toEqual({ id: "d", emits: null });
    expect(await repo.updateDevice()).toEqual({ id: "d", emits: null });
  });
});

describe("the store serves no stored open declaration (astra's reproduction)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    closeStore();
  });

  const seed = (deviceId: string, emits: unknown) =>
    getRepos().kernels.insertDevice({
      id: deviceId, kernelId: "kernel-nyc", type: "machine", model: "SIM", firmware: "1.0", status: "idle",
      contributesToCapabilities: [], lastUpdated: new Date().toISOString(), adapterType: "mock", emits,
    } as never);

  it("re-registering without emits neither returns nor preserves a stored open declaration", async () => {
    const deviceId = "dev-legacy-open-emits";
    expect((seed(deviceId, LEGACY) as { emits?: unknown }).emits).toBeNull();
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/register-device",
      payload: { kernelId: "kernel-nyc", deviceId, type: "machine", adapterType: "mock" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe("updated");
    expect(res.json().device.emits).toBeNull();
    expect(JSON.stringify(res.json())).not.toContain("sk_live_x");
  });

  it("device reads (what GET /api/devices/:kernelId serves) withhold it too, and keep a closed list", () => {
    seed("dev-legacy-read", LEGACY);
    seed("dev-closed-read", CLOSED);
    const rows = getRepos().kernels.findDevicesByKernel("kernel-nyc") as Array<{ id: string; emits?: unknown }>;
    expect(rows.find((d) => d.id === "dev-legacy-read")?.emits).toBeNull();
    expect(rows.find((d) => d.id === "dev-closed-read")?.emits).toEqual(CLOSED);
    expect((getRepos().kernels.findDeviceById("dev-legacy-read") as { emits?: unknown }).emits).toBeNull();
    expect((getRepos().kernels.findDevicesByAdapter("mock") as Array<{ id: string; emits?: unknown }>).find((d) => d.id === "dev-legacy-read")?.emits).toBeNull();
  });

  it("a re-registration that sends closed emits replaces the stored open list", async () => {
    const deviceId = "dev-legacy-replaced";
    seed(deviceId, LEGACY);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/register-device",
      payload: { kernelId: "kernel-nyc", deviceId, type: "machine", adapterType: "mock", emits: CLOSED },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().device.emits).toEqual(CLOSED);
  });
});
