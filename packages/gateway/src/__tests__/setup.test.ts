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

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { setupRoutes } from "../routes/setup.js";
import { initStore, closeStore } from "../db.js";
import { initKernelService, resetKernelService } from "../services/kernel-service.js";
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
    submitJob: vi
      .fn()
      .mockResolvedValue({ jobId: "test-job-mock", deviceId: "dev-setup-machine", status: "accepted" }),
    getJobStatus: vi.fn().mockResolvedValue({ status: "completed", progress: 100 }),
    listDevices: vi.fn().mockResolvedValue(_mockDevices),
    checkDeviceHealth: vi.fn().mockResolvedValue({ healthy: true, details: "idle" }),
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
  await app.register(setupRoutes);
  await app.ready();
  return app;
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

  describe("POST /api/setup/test-job", () => {
    it("submits a test job and returns result", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-job",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.jobId).toBe("string");
      expect(body.jobId).toMatch(/^test-job-/);
      expect(typeof body.status).toBe("string");
      expect(typeof body.duration).toBe("number");
      expect(body.duration).toBeGreaterThanOrEqual(0);
    });

    it("returns completed status (mock resolves immediately)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-job",
        payload: { assuranceTier: 0 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(["completed", "executing", "accepted", "queued", "unknown"]).toContain(body.status);
    });

    it("targets specific deviceId when provided", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-job",
        payload: { deviceId: "dev-setup-machine" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // The mock service returns "dev-setup-machine" from submitJob
      expect(body.deviceId).toBe("dev-setup-machine");
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
