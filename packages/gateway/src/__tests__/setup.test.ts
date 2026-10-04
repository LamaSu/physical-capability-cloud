/**
 * Tests for the setup API endpoints:
 *   GET  /api/setup/detect
 *   POST /api/setup/generate-config
 *   POST /api/setup/validate
 *   POST /api/setup/register-device
 *   POST /api/setup/test-job
 *   GET  /api/setup/status
 *
 * The test-job tests mock the KernelService to avoid background async timers
 * that can crash the test process during teardown.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { setupRoutes } from "../routes/setup.js";
import { initStore, closeStore, getRepos } from "../db.js";
import * as kernelServiceModule from "../services/kernel-service.js";
import { initKernelService, resetKernelService } from "../services/kernel-service.js";
import type { KernelConfig } from "@pcc/kernel";

// N31c (#575 stack; the steward's #6540): capability create, device registration, the operator
// heartbeat, evidence and job status now take the kernel-ownership guard. This suite tests the
// routes' own logic, so its apps act with the admin key unless a request sets its own.
const N31C_ADMIN = "n31c-test-admin-secret";
const PREV_N31C_ADMIN = process.env.PCC_ADMIN_KEY;
process.env.PCC_ADMIN_KEY = N31C_ADMIN;
afterAll(() => {
  if (PREV_N31C_ADMIN === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = PREV_N31C_ADMIN;
});
const asN31cAdmin = async (req: { headers: Record<string, unknown> }) => {
  if (req.headers["x-admin-key"] === undefined) req.headers["x-admin-key"] = N31C_ADMIN;
};


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
  app.addHook("onRequest", asN31cAdmin);
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

// A kernel owned by OWNER, with one machine device, for the test-job cases.
const OWNER = "op-owner";
function seedKernel(id: string, operatorAddress: string): void {
  const now = new Date().toISOString();
  getRepos().kernels.insert({
    id, name: id, operatorAddress,
    location: { lat: 0, lng: 0 }, physicalAddress: "1 Lab St", maxAssuranceTier: 2,
    publicKey: "pk", reputation: 0, totalJobsCompleted: 0, status: "online",
    registeredAt: now, lastHeartbeat: now, version: "1",
  } as never);
}

function seedDevice(id: string, kernelId: string, adapterType: string): void {
  getRepos().kernels.insertDevice({
    id, kernelId, type: "machine", model: "SIM", firmware: "1.0", status: "idle",
    contributesToCapabilities: [], lastUpdated: new Date().toISOString(), adapterType,
  } as never);
}

function seedOwnedKernelAndDevice(): void {
  // The gateway's in-process KernelService runs kernel "kernel-setup-test"
  // (the mock's kernelId), so test jobs pass only for THAT kernel (N59 F1).
  seedKernel("kernel-setup-test", OWNER);
  seedDevice("dev-owned", "kernel-setup-test", "opentrons"); // a real (non-mock) adapter
  seedDevice("dev-mock", "kernel-setup-test", "mock");       // a simulator -> never passes
  // A second kernel the OWNER also owns, but which THIS gateway does not run.
  seedKernel("kernel-other", OWNER);
  seedDevice("dev-other", "kernel-other", "opentrons");
  // A kernel with a whitespace-only operatorAddress (legacy/corrupt). The owner
  // check runs before the gateway-kernel (F1) check, so this is the F3 gate.
  seedKernel("kernel-ws", "   ");
  seedDevice("dev-ws", "kernel-ws", "opentrons");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Setup API", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    resetKernelService();
  });

  // ── GET /api/setup/detect ────────────────────────────────────────────────

  describe("GET /api/setup/detect", () => {
    it("returns structured detection result", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/setup/detect",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // env vars array
      expect(Array.isArray(body.envVars)).toBe(true);
      expect(body.envVars.length).toBeGreaterThan(0);
      // Each env var has expected shape
      const pcnVar = body.envVars.find((v: { name: string }) => v.name === "PCC_NETWORK");
      expect(pcnVar).toBeDefined();
      expect(typeof pcnVar.set).toBe("boolean");
      expect(pcnVar.category).toBe("chain");

      // db state
      expect(body.db).toBeDefined();
      expect(typeof body.db.kernels).toBe("number");
      expect(typeof body.db.devices).toBe("number");
      expect(typeof body.db.jobs).toBe("number");
      expect(body.db.initialized).toBe(true);

      // kernelService state
      expect(body.kernelService).toBeDefined();
      expect(body.kernelService.ready).toBe(true);
      expect(Array.isArray(body.kernelService.devices)).toBe(true);
      expect(body.kernelService.devices.length).toBe(2);

      // chain, storage, identity
      expect(body.chain).toBeDefined();
      expect(typeof body.chain.connected).toBe("boolean");
      expect(body.storage).toBeDefined();
      expect(body.identity).toBeDefined();
    });

    it("reports DB counts from seeded data", async () => {
      const res = await app.inject({ method: "GET", url: "/api/setup/detect" });
      const body = res.json();
      // Seeded data has at least 1 kernel and several devices
      expect(body.db.kernels).toBeGreaterThan(0);
    });

    it("does not expose sensitive env var values", async () => {
      process.env.PCC_GATEWAY_PRIVATE_KEY = "0xsecret_test_key";
      const res = await app.inject({ method: "GET", url: "/api/setup/detect" });
      const body = res.json();
      const keyVar = body.envVars.find(
        (v: { name: string }) => v.name === "PCC_GATEWAY_PRIVATE_KEY",
      );
      expect(keyVar).toBeDefined();
      expect(keyVar.set).toBe(true);
      expect(keyVar.value).toBeUndefined();
      delete process.env.PCC_GATEWAY_PRIVATE_KEY;
    });
  });

  // ── POST /api/setup/generate-config ──────────────────────────────────────

  describe("POST /api/setup/generate-config", () => {
    it("generates a valid KernelConfig from device descriptions", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/generate-config",
        payload: {
          kernelId: "kernel_my_shop",
          devices: [
            {
              name: "My 3D Printer",
              type: "machine",
              adapterType: "octoprint",
              url: "http://192.168.1.50:5000",
              apiKey: "test-api-key",
            },
            {
              name: "Power Sensor",
              type: "sensor",
              adapterType: "mock",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // config object
      expect(body.config).toBeDefined();
      expect(body.config.kernelId).toBe("kernel_my_shop");
      expect(Array.isArray(body.config.devices)).toBe(true);
      expect(body.config.devices.length).toBe(2);

      // First device — octoprint with URL
      const printer = body.config.devices[0];
      expect(printer.adapterType).toBe("octoprint");
      expect(printer.type).toBe("machine");
      expect(printer.config.url).toBe("http://192.168.1.50:5000");
      expect(printer.config.apiKey).toBe("test-api-key");

      // envLine and configJson
      expect(typeof body.envLine).toBe("string");
      expect(body.envLine).toContain("KERNEL_CONFIG=");
      expect(typeof body.configJson).toBe("string");
    });

    it("auto-generates kernelId when not provided", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/generate-config",
        payload: {
          devices: [{ name: "Mock Machine", type: "machine", adapterType: "mock" }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.config.kernelId).toBe("string");
      expect(body.config.kernelId.length).toBeGreaterThan(0);
    });

    it("supports mockMode flag", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/generate-config",
        payload: {
          kernelId: "kernel_mock",
          mockMode: true,
          devices: [{ name: "Real Printer", type: "machine", adapterType: "octoprint" }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.config.mockMode).toBe(true);
    });

    it("returns 400 when devices is empty", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/generate-config",
        payload: { devices: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("devices_required");
    });

    it("returns 400 when devices is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/generate-config",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("devices_required");
    });

    it("returns 400 for invalid adapterType", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/generate-config",
        payload: {
          devices: [{ name: "Bad Device", type: "machine", adapterType: "nonexistent" }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_adapter_type");
    });

    it("returns 400 for invalid device type", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/generate-config",
        payload: {
          devices: [{ name: "Bad Device", type: "robot", adapterType: "mock" }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_device_type");
    });

    it("configures modbus host/port correctly", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/generate-config",
        payload: {
          devices: [
            {
              name: "CNC Machine",
              type: "machine",
              adapterType: "modbus",
              host: "192.168.1.100",
              port: 502,
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const device = body.config.devices[0];
      expect(device.adapterType).toBe("modbus");
      expect(device.config.host).toBe("192.168.1.100");
      expect(device.config.port).toBe(502);
    });
  });

  // ── POST /api/setup/validate ─────────────────────────────────────────────

  describe("POST /api/setup/validate", () => {
    it("validates a valid config and returns pass checks", async () => {
      const config = JSON.stringify({
        kernelId: "kernel_valid",
        devices: [
          {
            id: "dev_printer_001",
            type: "machine",
            adapterType: "mock",
            config: { kernelId: "kernel_valid" },
          },
        ],
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/setup/validate",
        payload: { config },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(true);
      expect(Array.isArray(body.checks)).toBe(true);
      expect(Array.isArray(body.errors)).toBe(true);
      expect(Array.isArray(body.warnings)).toBe(true);
      expect(body.errors.length).toBe(0);

      const parseCheck = body.checks.find((c: { name: string }) => c.name === "config_parseable");
      expect(parseCheck).toBeDefined();
      expect(parseCheck.status).toBe("pass");
    });

    it("returns fail for invalid JSON", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/validate",
        payload: { config: "this is not json" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(false);
      expect(body.errors.length).toBeGreaterThan(0);
    });

    it("returns fail for config without kernelId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/validate",
        payload: {
          config: JSON.stringify({
            devices: [{ id: "dev1", type: "machine", adapterType: "mock", config: {} }],
          }),
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(false);
      const kernelCheck = body.checks.find((c: { name: string }) => c.name === "kernel_id");
      expect(kernelCheck.status).toBe("fail");
    });

    it("warns when no devices are defined", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/validate",
        payload: {
          config: JSON.stringify({ kernelId: "kernel_no_devices", devices: [] }),
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // warnings about no devices, but otherwise valid
      expect(body.warnings.length).toBeGreaterThan(0);
    });

    it("warns about octoprint device missing apiKey", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/validate",
        payload: {
          config: JSON.stringify({
            kernelId: "kernel_octo",
            devices: [
              {
                id: "dev_octo_001",
                type: "machine",
                adapterType: "octoprint",
                config: { url: "http://192.168.1.50:5000" },
              },
            ],
          }),
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.warnings.length).toBeGreaterThan(0);
      const apiKeyCheck = body.checks.find(
        (c: { name: string }) => c.name === "device:dev_octo_001:apiKey",
      );
      expect(apiKeyCheck).toBeDefined();
      expect(apiKeyCheck.status).toBe("warn");
    });

    it("fails for invalid adapterType in config", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/validate",
        payload: {
          config: JSON.stringify({
            kernelId: "kernel_bad",
            devices: [
              {
                id: "dev_bad_001",
                type: "machine",
                adapterType: "badprotocol",
                config: {},
              },
            ],
          }),
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(false);
      expect(body.errors.length).toBeGreaterThan(0);
    });

    it("uses current KERNEL_CONFIG env var when config not provided", async () => {
      const envConfig = JSON.stringify({
        kernelId: "kernel_from_env",
        devices: [{ id: "dev_env_001", type: "machine", adapterType: "mock", config: {} }],
      });
      process.env.KERNEL_CONFIG = envConfig;

      const res = await app.inject({
        method: "POST",
        url: "/api/setup/validate",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const kernelCheck = body.checks.find((c: { name: string }) => c.name === "kernel_id");
      expect(kernelCheck).toBeDefined();
      expect(kernelCheck.status).toBe("pass");

      delete process.env.KERNEL_CONFIG;
    });
  });

  // ── POST /api/setup/register-device ──────────────────────────────────────

  describe("POST /api/setup/register-device", () => {
    it("registers a device in the DB", async () => {
      const deviceId = `dev-setup-${Date.now()}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-nyc",
          deviceId,
          type: "machine",
          model: "Test Setup Printer",
          adapterType: "mock",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.registered).toBe(true);
      expect(body.action).toBe("created");
      expect(body.device).toBeDefined();
      expect(body.device.id).toBe(deviceId);
      expect(body.device.kernelId).toBe("kernel-nyc");
    });

    it("registers a device with adapterConfig and capabilities", async () => {
      const deviceId = `dev-setup-octo-${Date.now()}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-nyc",
          deviceId,
          type: "machine",
          model: "OctoPrint Ender 3",
          adapterType: "octoprint",
          adapterConfig: { url: "http://192.168.1.50:5000", apiKey: "test-key" },
          capabilities: ["cap-nyc-fdm"],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.device.adapterType).toBe("octoprint");
    });

    it("returns 400 for missing required fields", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: { kernelId: "kernel-nyc" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("missing_required_fields");
    });

    it("returns missing: [\"deviceId\"] when only deviceId is absent", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-nyc",
          type: "machine",
          adapterType: "mock",
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("missing_required_fields");
      expect(body.missing).toEqual(["deviceId"]);
      expect(body.message).toContain("deviceId");
      expect(body.message).toContain("sim-pr1-0001");
    });

    it("lists every missing field, in kernelId/deviceId/type/adapterType order", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: { kernelId: "kernel-nyc" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.missing).toEqual(["deviceId", "type", "adapterType"]);
      expect(body.message).toContain("deviceId");
      expect(body.message).toContain("type");
      expect(body.message).toContain("adapterType");
    });

    it("stores and returns a provided firmware string", async () => {
      const deviceId = `dev-setup-firmware-${Date.now()}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-nyc",
          deviceId,
          type: "machine",
          adapterType: "mock",
          firmware: "1.4.2",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().device.firmware).toBe("1.4.2");
    });

    it('defaults firmware to "unknown" when absent', async () => {
      const deviceId = `dev-setup-no-firmware-${Date.now()}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-nyc",
          deviceId,
          type: "machine",
          adapterType: "mock",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().device.firmware).toBe("unknown");
    });

    it("returns 400 for unknown kernel", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-does-not-exist",
          deviceId: "dev-orphan",
          type: "machine",
          adapterType: "mock",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("kernel_not_found");
    });

    it("returns 400 for invalid adapterType", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-nyc",
          deviceId: "dev-bad-adapter",
          type: "machine",
          adapterType: "invalid_protocol",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_adapter_type");
    });

    it("is idempotent on duplicate deviceId (upsert, no 409)", async () => {
      const deviceId = `dev-dup-setup-${Date.now()}`;
      const payload = {
        kernelId: "kernel-nyc",
        deviceId,
        type: "machine",
        adapterType: "mock",
      };

      const first = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload,
      });
      expect(first.statusCode).toBe(201);
      expect(first.json().action).toBe("created");

      const second = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().action).toBe("updated");
      expect(second.json().registered).toBe(true);
    });

    it("accepts and persists a supply-side emits[] manifest", async () => {
      const deviceId = `dev-emits-${Date.now()}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-nyc",
          deviceId,
          type: "camera",
          model: "Nonce Cam",
          adapterType: "mock",
          emits: [
            { id: "decl.self_attested" },
            {
              id: "capture.photo_nonced",
              params: { media: "photo", minClass: "CC1" },
              bind: "capturePhotoCid",
              via: "captureSnapshot",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const emits = res.json().device.emits;
      expect(Array.isArray(emits)).toBe(true);
      expect(emits.map((e: { id: string }) => e.id)).toContain("capture.photo_nonced");
    });

    it("returns 400 for a malformed emits[] (a decl with no primitive id)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-nyc",
          deviceId: `dev-bad-emits-${Date.now()}`,
          type: "machine",
          adapterType: "mock",
          emits: [{ via: "nope" }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_emits");
    });
  });

  // ── POST /api/setup/test-job ─────────────────────────────────────────────
  // The KernelService is mocked — no real background timers or DB side-effects.

  // N59 / ADK item 8: the test job is owner-gated and honest. It never lands
  // on a mock fallback, and a self-attestation is never a pass.
  describe("POST /api/setup/test-job", () => {
    const _svc = (kernelServiceModule as unknown as { _mockService: {
      hasRunner: ReturnType<typeof vi.fn>;
      getJobStatus: ReturnType<typeof vi.fn>;
      submitJob: ReturnType<typeof vi.fn>;
      jobRanSimulated: ReturnType<typeof vi.fn>;
    } })._mockService;
    const GW_KERNEL = "kernel-setup-test"; // the kernel this gateway's service runs
    const owner = { "x-test-key": OWNER };
    const post = (payload: unknown, headers: Record<string, string> = owner) =>
      app.inject({ method: "POST", url: "/api/setup/test-job", headers, payload });

    beforeAll(() => seedOwnedKernelAndDevice());
    beforeEach(() => {
      _svc.hasRunner.mockReturnValue(true);
      _svc.getJobStatus.mockResolvedValue({ status: "completed", progress: 100 });
      _svc.submitJob.mockResolvedValue({ jobId: "test-job-mock", deviceId: "dev-owned", status: "accepted" });
      _svc.jobRanSimulated.mockReturnValue(false);
    });

    it("requires kernelId", async () => {
      const res = await post({ deviceId: "dev-owned" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "kernel_id_required", ran: false, passed: false });
    });

    it("404s an unregistered kernel", async () => {
      const res = await post({ kernelId: "kernel-ghost", deviceId: "dev-owned" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("kernel_not_found");
    });

    it("403s a caller who is not the kernel operator, and an anonymous caller", async () => {
      const stranger = await post({ kernelId: GW_KERNEL, deviceId: "dev-owned" }, { "x-test-key": "someone-else" });
      expect(stranger.statusCode).toBe(403);
      expect(stranger.json()).toMatchObject({ error: "not_kernel_operator", ran: false, passed: false });
      const anon = await post({ kernelId: GW_KERNEL, deviceId: "dev-owned" }, {});
      expect(anon.statusCode).toBe(403);
    });

    it("403s a whitespace principal against a whitespace/legacy operatorAddress (F3)", async () => {
      // kernel-ws has operatorAddress "   ". A whitespace principal must NOT
      // match it: both normalize to empty (unowned), so the owner check refuses.
      const res = await post({ kernelId: "kernel-ws", deviceId: "dev-ws" }, { "x-test-key": "   " });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("not_kernel_operator");
      expect(_svc.submitJob).not.toHaveBeenCalled();
    });

    it("requires a deviceId, and it must be on the kernel", async () => {
      const missing = await post({ kernelId: GW_KERNEL });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error).toBe("device_id_required");
      const foreign = await post({ kernelId: GW_KERNEL, deviceId: "dev-elsewhere" });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json().error).toBe("device_not_on_kernel");
    });

    it("refuses a kernel this gateway does not run, even for its owner (F1)", async () => {
      // kernel-other is registered and owned by OWNER, but the gateway's service
      // runs kernel-setup-test. A device-id collision must not actuate it.
      const res = await post({ kernelId: "kernel-other", deviceId: "dev-other" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "gateway_does_not_run_this_kernel", ran: false, passed: false });
      expect(_svc.submitJob).not.toHaveBeenCalled();
    });

    it("refuses a device this gateway does not run — never a self-attested pass", async () => {
      _svc.hasRunner.mockReturnValue(false);
      const res = await post({ kernelId: GW_KERNEL, deviceId: "dev-owned" });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body).toMatchObject({ error: "device_not_runnable_here", ran: false, passed: false });
      expect(body.status).not.toBe("completed");
      expect(_svc.submitJob).not.toHaveBeenCalled();
    });

    it("runs the operator's own real device and passes only when the run completes", async () => {
      const res = await post({ kernelId: GW_KERNEL, deviceId: "dev-owned", assuranceTier: 0 });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ deviceId: "dev-owned", status: "completed", ran: true, passed: true, simulated: false });
      expect(body.jobId).toMatch(/^test-job-/);
      expect(typeof body.duration).toBe("number");
    });

    it("never passes a simulated/mock device, even on completed (F2)", async () => {
      // By the device's adapterType "mock"...
      const byType = await post({ kernelId: GW_KERNEL, deviceId: "dev-mock" });
      expect(byType.statusCode).toBe(200);
      expect(byType.json()).toMatchObject({ status: "completed", ran: true, passed: false, simulated: true });
      // ...and by the runner reporting itself simulated, even for a non-mock adapterType.
      _svc.jobRanSimulated.mockReturnValue(true);
      const byRunner = await post({ kernelId: GW_KERNEL, deviceId: "dev-owned" });
      expect(byRunner.json()).toMatchObject({ ran: true, passed: false, simulated: true });
    });

    it("does not pass when the run does not complete", async () => {
      _svc.getJobStatus.mockResolvedValue({ status: "failed", progress: 0 });
      const res = await post({ kernelId: GW_KERNEL, deviceId: "dev-owned" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ran: true, passed: false, status: "failed" });
    });

    it("an uncaught internal error still returns ran/passed (F4)", async () => {
      const spy = vi.spyOn(getRepos().kernels, "findById").mockImplementation(() => {
        throw new Error("db boom");
      });
      try {
        const res = await post({ kernelId: GW_KERNEL, deviceId: "dev-owned" });
        expect(res.statusCode).toBe(500);
        expect(res.json()).toMatchObject({ ran: false, passed: false });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── GET /api/setup/status ────────────────────────────────────────────────

  describe("GET /api/setup/status", () => {
    it("returns overall status and categories", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/setup/status",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(["ready", "partial", "unconfigured"]).toContain(body.overall);
      expect(Array.isArray(body.categories)).toBe(true);
      expect(body.categories.length).toBeGreaterThan(0);
    });

    it("includes all required categories", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/setup/status",
      });
      const body = res.json();
      const categoryNames = body.categories.map((c: { name: string }) => c.name);
      expect(categoryNames).toContain("gateway");
      expect(categoryNames).toContain("database");
      expect(categoryNames).toContain("adapters");
      expect(categoryNames).toContain("chain");
      expect(categoryNames).toContain("storage");
      expect(categoryNames).toContain("identity");
    });

    it("each category has status and details fields", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/setup/status",
      });
      const body = res.json();
      for (const cat of body.categories) {
        expect(["ready", "partial", "unconfigured"]).toContain(cat.status);
        expect(typeof cat.details).toBe("string");
        expect(cat.details.length).toBeGreaterThan(0);
      }
    });

    it("gateway category is always ready", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/setup/status",
      });
      const body = res.json();
      const gateway = body.categories.find((c: { name: string }) => c.name === "gateway");
      expect(gateway).toBeDefined();
      expect(gateway.status).toBe("ready");
    });

    it("database category is ready when seeded data exists", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/setup/status",
      });
      const body = res.json();
      const db = body.categories.find((c: { name: string }) => c.name === "database");
      expect(db).toBeDefined();
      // Seeded with data so should be ready
      expect(db.status).toBe("ready");
    });

    it("adapters category reflects KernelService devices", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/setup/status",
      });
      const body = res.json();
      const adapters = body.categories.find((c: { name: string }) => c.name === "adapters");
      expect(adapters).toBeDefined();
      // All devices are mock so partial expected
      expect(adapters.status).toBe("partial");
    });

    it("chain category is unconfigured without env vars", async () => {
      const savedNetwork = process.env.PCC_NETWORK;
      const savedKey = process.env.PCC_GATEWAY_PRIVATE_KEY;
      const savedEscrow = process.env.ESCROW_CONTRACT_ADDRESS;

      delete process.env.PCC_NETWORK;
      delete process.env.PCC_GATEWAY_PRIVATE_KEY;
      delete process.env.ESCROW_CONTRACT_ADDRESS;

      const res = await app.inject({ method: "GET", url: "/api/setup/status" });
      const body = res.json();
      const chain = body.categories.find((c: { name: string }) => c.name === "chain");
      expect(chain.status).toBe("unconfigured");

      // Restore
      if (savedNetwork) process.env.PCC_NETWORK = savedNetwork;
      if (savedKey) process.env.PCC_GATEWAY_PRIVATE_KEY = savedKey;
      if (savedEscrow) process.env.ESCROW_CONTRACT_ADDRESS = savedEscrow;
    });

    it("overall is partial when some categories are not ready", async () => {
      // With no chain env vars, chain is unconfigured → overall can't be "ready"
      delete process.env.PCC_NETWORK;
      delete process.env.PCC_GATEWAY_PRIVATE_KEY;
      delete process.env.ESCROW_CONTRACT_ADDRESS;

      const res = await app.inject({ method: "GET", url: "/api/setup/status" });
      const body = res.json();
      expect(body.overall).not.toBe("ready");
    });
  });
});

describe("pack 111 MEDIUM 5: register-device with no body gets the missing-fields 400", () => {
  it("an absent body lists all four required fields", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/setup/register-device" });
      expect(res.statusCode).toBe(400);
      expect(res.json().missing).toEqual(["kernelId", "deviceId", "type", "adapterType"]);
    } finally {
      await app.close();
    }
  });
});
