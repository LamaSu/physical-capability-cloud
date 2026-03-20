/**
 * Tests for the job submission API endpoints:
 *   POST /api/jobs/submit
 *   GET  /api/jobs/:jobId/status
 *   POST /api/devices/register
 *   GET  /api/devices/:kernelId
 *   POST /api/devices/:deviceId/health
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { kernelRoutes } from "../routes/kernels.js";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore } from "../db.js";
import { initKernelService, resetKernelService } from "../services/kernel-service.js";
import type { KernelConfig } from "@pcc/kernel";

// ---------------------------------------------------------------------------
// Minimal mock KernelConfig — forces mock mode so no real hardware needed
// ---------------------------------------------------------------------------

const mockConfig: KernelConfig = {
  kernelId: "kernel-test-001",
  mockMode: true,
  devices: [
    {
      id: "dev-test-machine",
      type: "machine",
      adapterType: "mock",
      config: { kernelId: "kernel-test-001", jobDurationMs: 100 },
    },
    {
      id: "dev-test-sensor",
      type: "sensor",
      adapterType: "mock",
      config: { kernelId: "kernel-test-001" },
    },
    {
      id: "dev-test-camera",
      type: "camera",
      adapterType: "mock",
      config: { kernelId: "kernel-test-001" },
    },
  ],
};

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  // Reset and init KernelService with mock config
  resetKernelService();
  initKernelService(mockConfig);

  const app = Fastify({ logger: false });
  await app.register(jobSubmitRoutes);
  await app.register(kernelRoutes);
  await app.register(jobRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Job Submission API", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    resetKernelService();
  });

  // ── POST /api/jobs/submit ────────────────────────────────────────────────

  describe("POST /api/jobs/submit", () => {
    it("accepts a valid job and returns immediately", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit",
        payload: {
          stepId: "step-test-1",
          kernelId: "kernel-nyc",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.jobId).toBeDefined();
      expect(typeof body.jobId).toBe("string");
      expect(body.status).toBe("accepted");
      expect(body.deviceId).toBe("dev-test-machine");
    });

    it("uses provided jobId when given", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit",
        payload: {
          jobId: "job-explicit-id",
          stepId: "step-explicit",
          kernelId: "kernel-nyc",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.jobId).toBe("job-explicit-id");
      expect(body.status).toBe("accepted");
    });

    it("accepts optional assuranceTier and gcodeHash", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit",
        payload: {
          stepId: "step-tier1",
          kernelId: "kernel-nyc",
          assuranceTier: 1,
          gcodeHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("accepted");
    });

    it("returns 400 when stepId is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit",
        payload: {
          kernelId: "kernel-nyc",
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("missing_step_id");
    });

    it("returns 400 when kernelId is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit",
        payload: {
          stepId: "step-no-kernel",
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("missing_kernel_id");
    });

    it("persists submitted job to DB", async () => {
      const jobId = `job-persist-${Date.now()}`;

      await app.inject({
        method: "POST",
        url: "/api/jobs/submit",
        payload: {
          jobId,
          stepId: "step-persist",
          kernelId: "kernel-nyc",
        },
      });

      // Fetch via jobs list route
      const statusRes = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}`,
      });
      expect(statusRes.statusCode).toBe(200);
      const statusBody = statusRes.json();
      expect(statusBody.job).toBeDefined();
      expect(statusBody.job.id).toBe(jobId);
    });
  });

  // ── GET /api/jobs/:jobId/status ──────────────────────────────────────────

  describe("GET /api/jobs/:jobId/status", () => {
    it("returns status for a submitted job", async () => {
      const jobId = `job-status-${Date.now()}`;

      await app.inject({
        method: "POST",
        url: "/api/jobs/submit",
        payload: {
          jobId,
          stepId: "step-status",
          kernelId: "kernel-nyc",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}/status`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.jobId).toBe(jobId);
      expect(body.status).toBeDefined();
      expect(typeof body.progress).toBe("number");
    });

    it("returns 404 for unknown job", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/jobs/job-nonexistent-xyz/status",
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe("not_found");
    });

    it("returns status for existing seed job", async () => {
      // job-001 is seeded by seedJobs
      const res = await app.inject({
        method: "GET",
        url: "/api/jobs/job-001/status",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.jobId).toBe("job-001");
      expect(body.status).toBeDefined();
      expect(typeof body.progress).toBe("number");
    });
  });

  // ── POST /api/devices/register ───────────────────────────────────────────

  describe("POST /api/devices/register", () => {
    it("registers a new device", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/register",
        payload: {
          kernelId: "kernel-nyc",
          id: `dev-new-${Date.now()}`,
          type: "machine",
          model: "Test Printer v1",
          adapterType: "mock",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.device).toBeDefined();
      expect(body.device.kernelId).toBe("kernel-nyc");
      expect(body.device.model).toBe("Test Printer v1");
    });

    it("registers a device with adapter config", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/register",
        payload: {
          kernelId: "kernel-nyc",
          id: `dev-cfg-${Date.now()}`,
          type: "machine",
          model: "OctoPrint Printer",
          adapterType: "octoprint",
          adapterConfig: { url: "http://localhost:5000", apiKey: "test-key" },
          capabilities: ["cap-nyc-fdm"],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.device).toBeDefined();
      expect(body.device.adapterType).toBe("octoprint");
    });

    it("returns 400 for unknown kernel", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/register",
        payload: {
          kernelId: "kernel-doesnotexist",
          id: "dev-orphan",
          type: "machine",
          model: "Orphan",
          adapterType: "mock",
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("kernel_not_found");
    });

    it("returns 400 when required fields are missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/register",
        payload: {
          kernelId: "kernel-nyc",
          // missing id, type, model, adapterType
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("missing_required_fields");
    });

    it("returns 409 for duplicate device id", async () => {
      const id = `dev-dup-${Date.now()}`;
      const payload = {
        kernelId: "kernel-nyc",
        id,
        type: "machine",
        model: "Dup Device",
        adapterType: "mock",
      };

      // First insert — OK
      await app.inject({ method: "POST", url: "/api/devices/register", payload });

      // Second insert — conflict
      const res = await app.inject({ method: "POST", url: "/api/devices/register", payload });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe("device_already_exists");
    });
  });

  // ── GET /api/devices/:kernelId ───────────────────────────────────────────

  describe("GET /api/devices/:kernelId", () => {
    it("returns devices for a kernel", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/devices/kernel-nyc",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.devices)).toBe(true);
      expect(body.devices.length).toBeGreaterThan(0);
    });

    it("returns empty array for kernel with no devices", async () => {
      // kernel-la has no devices in seed
      const res = await app.inject({
        method: "GET",
        url: "/api/devices/kernel-la",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.devices)).toBe(true);
    });

    it("auto-select device: deviceId in response matches mock adapter", async () => {
      const submitRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit",
        payload: {
          stepId: "step-autoselect",
          kernelId: "kernel-nyc",
        },
      });
      const body = submitRes.json();
      // The KernelService should pick the first mock adapter device
      expect(body.deviceId).toBe("dev-test-machine");
    });
  });

  // ── POST /api/devices/:deviceId/health ────────────────────────────────────

  describe("POST /api/devices/:deviceId/health", () => {
    it("returns healthy for a known mock device", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/dev-test-machine/health",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.healthy).toBe("boolean");
      expect(body.details).toBeDefined();
    });

    it("returns unhealthy for unknown device", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/dev-nonexistent/health",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.healthy).toBe(false);
      expect(body.details).toBe("device_not_found");
    });
  });
});
