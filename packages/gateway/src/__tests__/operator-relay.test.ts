/**
 * Tests for operator relay endpoints:
 *   GET  /api/operator/jobs
 *   POST /api/operator/evidence
 *   POST /api/operator/heartbeat
 *   POST /api/operator/job-status
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { jobRoutes } from "../routes/jobs.js";
import { kernelRoutes } from "../routes/kernels.js";
import { initStore, closeStore } from "../db.js";

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(kernelRoutes);
  await app.register(jobRoutes);
  await app.register(operatorRelayRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the first kernel ID found in the seeded DB, or null. */
async function getSeededKernelId(app: FastifyInstance): Promise<string | null> {
  const res = await app.inject({ method: "GET", url: "/api/kernels" });
  const body = res.json();
  return body.kernels?.[0]?.id ?? null;
}

/** Returns the first queued job ID for a kernel, or null. */
async function getQueuedJobId(
  app: FastifyInstance,
  kernelId: string,
): Promise<string | null> {
  const res = await app.inject({
    method: "GET",
    url: `/api/jobs?kernelId=${kernelId}&status=queued`,
  });
  const body = res.json();
  return body.jobs?.[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Operator Relay Routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  // ── GET /api/operator/jobs ───────────────────────────────────────

  describe("GET /api/operator/jobs", () => {
    it("requires kernelId query param", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/operator/jobs",
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("kernelId query param required");
    });

    it("returns empty jobs for unknown kernel", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/operator/jobs?kernelId=kernel-unknown-xyz&status=queued",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.jobs).toEqual([]);
    });

    it("returns jobs for known kernel with status filter", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return; // No seed data

      const res = await app.inject({
        method: "GET",
        url: `/api/operator/jobs?kernelId=${kernelId}&status=queued`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.jobs)).toBe(true);
    });

    it("defaults to queued status when omitted", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;

      const res = await app.inject({
        method: "GET",
        url: `/api/operator/jobs?kernelId=${kernelId}`,
      });
      // Should not 400 (status defaulted to "queued")
      expect(res.statusCode).toBe(200);
    });
  });

  // ── POST /api/operator/evidence ─────────────────────────────────

  describe("POST /api/operator/evidence", () => {
    it("requires jobId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        payload: { evidence: { printed: true } },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("jobId required");
    });

    it("requires evidence", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        payload: { jobId: "j-test" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("evidence required");
    });

    it("returns stored:false for unknown job (graceful)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        payload: {
          jobId: "job-totally-unknown-12345",
          kernelId: "kernel-1",
          evidence: { printed: true, returncode: 0 },
          timestamp: Date.now() / 1000,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.stored).toBe(false);
      expect(body.warning).toBe("job_not_found");
    });

    it("stores evidence for known job", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;
      const jobId = await getQueuedJobId(app, kernelId);
      if (!jobId) return;

      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        payload: {
          jobId,
          kernelId,
          evidence: {
            printed: true,
            filepath: "/tmp/test.txt",
            returncode: 0,
            events: [
              { type: "job_started", timestamp: new Date().toISOString() },
              { type: "execution_completed", timestamp: new Date().toISOString() },
            ],
          },
          timestamp: Date.now() / 1000,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.stored).toBe(true);
      expect(body.jobId).toBe(jobId);
      expect(body.bundleId).toBeTruthy();
    });
  });

  // ── POST /api/operator/heartbeat ────────────────────────────────

  describe("POST /api/operator/heartbeat", () => {
    it("requires kernelId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/heartbeat",
        payload: { status: "online" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("kernelId required");
    });

    it("acknowledges heartbeat for known kernel", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;

      const res = await app.inject({
        method: "POST",
        url: "/api/operator/heartbeat",
        payload: {
          kernelId,
          status: "online",
          timestamp: Date.now() / 1000,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.acknowledged).toBe(true);
      expect(body.kernelId).toBe(kernelId);
    });

    it("acknowledges heartbeat with capability announcement", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;

      const res = await app.inject({
        method: "POST",
        url: "/api/operator/heartbeat",
        payload: {
          kernelId,
          status: "online",
          capabilities: [
            { type: "document-printing", deviceId: "printer-1" },
            { type: "visual-inspection", deviceId: "cam-1" },
          ],
          timestamp: Date.now() / 1000,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.capabilitiesReceived).toBe(2);
    });

    it("accepts unknown kernel gracefully (no 404)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/heartbeat",
        payload: {
          kernelId: "kernel-brand-new-unknown",
          status: "online",
        },
      });
      // Should not 404 — pcc-node may heartbeat before registration
      expect(res.statusCode).toBe(200);
    });
  });

  // ── POST /api/operator/job-status ───────────────────────────────

  describe("POST /api/operator/job-status", () => {
    it("requires jobId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/job-status",
        payload: { status: "completed" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("jobId required");
    });

    it("requires status", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/job-status",
        payload: { jobId: "j-1" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("status required");
    });

    it("rejects invalid status values", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/job-status",
        payload: { jobId: "j-1", status: "flying" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("invalid_status");
      expect(body.valid).toContain("completed");
    });

    it("returns updated:false for unknown job (graceful)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/job-status",
        payload: {
          jobId: "job-does-not-exist-xyz",
          status: "completed",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.updated).toBe(false);
      expect(body.warning).toBe("job_not_found");
    });

    it("updates status for known job", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;
      const jobId = await getQueuedJobId(app, kernelId);
      if (!jobId) return;

      const res = await app.inject({
        method: "POST",
        url: "/api/operator/job-status",
        payload: {
          jobId,
          kernelId,
          status: "running",
          metadata: { deviceId: "printer-1" },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.updated).toBe(true);
      expect(body.jobId).toBe(jobId);
      // `running` is a tolerated input alias, normalised to the canonical value.
      expect(body.status).toBe("in_progress");
    });

    it("accepts all canonical statuses plus the `running` alias", async () => {
      const ACCEPTED = [
        "pending", "queued", "in_progress", "paused",
        "completed", "failed", "cancelled",
        "running", // tolerated alias → in_progress
      ];
      for (const status of ACCEPTED) {
        const res = await app.inject({
          method: "POST",
          url: "/api/operator/job-status",
          payload: { jobId: "j-fake-" + status, status },
        });
        // May be 200 with updated:false (unknown job), but must not be 400
        expect(res.statusCode, `status ${status}`).not.toBe(400);
      }
    });
  });
});
