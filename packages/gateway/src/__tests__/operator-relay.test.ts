/**
 * Tests for operator relay endpoints:
 *   GET  /api/operator/jobs
 *   POST /api/operator/evidence
 *   POST /api/operator/heartbeat
 *   POST /api/operator/job-status
 *
 * N85 b: jobs, evidence and job-status are owner-or-admin, like the heartbeat
 * (WP-C). The happy-path and validation cases below therefore send the
 * identity apiGate would attach: the owner of the seeded kernel, via the
 * x-test-operator shim, or the admin secret where there is no kernel owner
 * (an unknown kernel). An unknown JOB is a 404 now, no longer a graceful 200.
 * The negative and ordering cases (a stranger, no identity, a wrong admin
 * secret, an unowned kernel) live in n85-operator-relay-owner.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { jobRoutes } from "../routes/jobs.js";
import { kernelRoutes } from "../routes/kernels.js";
import { initStore, closeStore, getRepos } from "../db.js";

/** A real device-signed (#236) evidence bundle over `bundleHash`, in the wire
 *  form the node produces (hex Ed25519 sig, truncated EVM-looking signer). */
function realDeviceBundle(jobId: string, bundleHash = `sha256:${"ab".repeat(32)}`) {
  const kp = nacl.sign.keyPair();
  const sig = nacl.sign.detached(new TextEncoder().encode(bundleHash), kp.secretKey);
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  return {
    jobId,
    assuranceTier: 2, // node's DECLARED tier — path 1 must NOT trust it (stays 0)
    bundleHash,
    kernelSignature: {
      signer: `0x${hex(kp.publicKey).slice(0, 40)}`,
      algorithm: "ed25519",
      value: hex(sig),
    },
    events: [{ type: "execution_completed", timestamp: new Date().toISOString() }],
  };
}

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  // Identity shim standing in for apiGate, which attaches `operatorId` in
  // production (same pattern as carrier.test.ts). WP-C: operator heartbeats
  // are owner-only, so they are sent as the seeded kernel's owner.
  app.addHook("onRequest", async (req) => {
    const h = req.headers["x-test-operator"];
    if (typeof h === "string" && h) (req as unknown as { operatorId?: string }).operatorId = h;
  });
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

/** The recorded owner (operatorAddress) of a seeded kernel. */
function ownerOf(kernelId: string): string {
  return getRepos().kernels.findById(kernelId)!.operatorAddress;
}

/** The identity shim header: the owner of `kernelId`, as apiGate would attach it. */
function asOwnerOf(kernelId: string): Record<string, string> {
  return { "x-test-operator": ownerOf(kernelId) };
}

/**
 * An authenticated identity that owns NO kernel, for cases answered before any
 * ownership is checked (400 body validation, 404 unknown job or kernel).
 */
const ANY_OPERATOR = { "x-test-operator": "operator-relay-test-nobody@x.test" };

/** The admin secret (N85 b: the owner-or-admin relay routes accept it; set around the suite). */
const ADMIN_SECRET = "operator-relay-test-admin-secret";
const asAdmin = { "x-admin-key": ADMIN_SECRET };
const savedAdminKey = process.env.PCC_ADMIN_KEY;

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
    process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    if (savedAdminKey === undefined) delete process.env.PCC_ADMIN_KEY;
    else process.env.PCC_ADMIN_KEY = savedAdminKey;
  });

  // ── GET /api/operator/jobs ───────────────────────────────────────

  describe("GET /api/operator/jobs", () => {
    it("requires kernelId query param", async () => {
      // N85 b: the actor is resolved before the query is validated, so this
      // sends an identity to reach the 400 (with none it is a 401).
      const res = await app.inject({
        method: "GET",
        url: "/api/operator/jobs",
        headers: ANY_OPERATOR,
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("kernelId query param required");

      const anonymous = await app.inject({ method: "GET", url: "/api/operator/jobs" });
      expect(anonymous.statusCode).toBe(401);
    });

    it("returns empty jobs for unknown kernel (the admin; a caller with only an identity gets 404)", async () => {
      // No kernel, no owner: only the admin secret reaches the (empty) listing.
      const res = await app.inject({
        method: "GET",
        url: "/api/operator/jobs?kernelId=kernel-unknown-xyz&status=queued",
        headers: asAdmin,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.jobs).toEqual([]);

      const identified = await app.inject({
        method: "GET",
        url: "/api/operator/jobs?kernelId=kernel-unknown-xyz&status=queued",
        headers: ANY_OPERATOR,
      });
      expect(identified.statusCode).toBe(404);
      expect(identified.json().error).toBe("kernel_not_found");
    });

    it("returns jobs for known kernel with status filter (to its owner)", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return; // No seed data

      const res = await app.inject({
        method: "GET",
        url: `/api/operator/jobs?kernelId=${kernelId}&status=queued`,
        headers: asOwnerOf(kernelId),
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
        headers: asOwnerOf(kernelId),
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
        headers: ANY_OPERATOR,
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
        headers: ANY_OPERATOR,
        payload: { jobId: "j-test" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("evidence required");
    });

    it("returns 404 job_not_found for an unknown job and stores nothing (was a graceful 200 stored:false)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        headers: ANY_OPERATOR,
        payload: {
          jobId: "job-totally-unknown-12345",
          kernelId: "kernel-1",
          evidence: { printed: true, returncode: 0 },
          timestamp: Date.now() / 1000,
        },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe("job_not_found");
      expect(body.stored).toBeUndefined();
      expect(getRepos().evidence.findByJob("job-totally-unknown-12345")).toEqual([]);
    });

    it("stores evidence for known job (sent by its kernel's owner)", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;
      const jobId = await getQueuedJobId(app, kernelId);
      if (!jobId) return;

      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        headers: asOwnerOf(kernelId),
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

    // ── SEAM-2 path 1: capture the node's REAL device signature ──────────
    it("captures the node's real device-signed (#236) Ed25519 signature", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;
      const jobId = await getQueuedJobId(app, kernelId);
      if (!jobId) return;

      const bundle = realDeviceBundle(jobId);
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        headers: asOwnerOf(kernelId),
        payload: { jobId, kernelId, evidence: bundle, timestamp: Date.now() / 1000 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.stored).toBe(true);
      expect(body.deviceSigned).toBe(true);

      // The STORED bundle carries the DEVICE's real signature — not the placeholder.
      const stored = getRepos().evidence.findById(body.bundleId);
      expect(stored).toBeTruthy();
      expect(stored!.kernelSignature.algorithm).toBe("ed25519");
      expect(stored!.kernelSignature.value).toBe(bundle.kernelSignature.value);
      expect(stored!.kernelSignature.value).not.toBe("operator-relay-auto");
      expect(stored!.bundleHash).toBe(bundle.bundleHash);
      // Tier stays 0 (fails closed): the node's declared tier:2 is NOT trusted until
      // the gated #52 verifier confirms the evidence.
      expect(stored!.assuranceTier).toBe(0);
    });

    it("falls back to the placeholder for non-bundle evidence (backward compatible)", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;
      const jobId = await getQueuedJobId(app, kernelId);
      if (!jobId) return;

      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        headers: asOwnerOf(kernelId),
        payload: { jobId, kernelId, evidence: { printed: true, returncode: 0 } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.stored).toBe(true);
      expect(body.deviceSigned).toBe(false);

      const stored = getRepos().evidence.findById(body.bundleId);
      expect(stored!.kernelSignature.value).toBe("operator-relay-auto");
      expect(stored!.assuranceTier).toBe(0);
    });
  });

  // ── POST /api/operator/heartbeat ────────────────────────────────

  describe("POST /api/operator/heartbeat", () => {
    it("requires kernelId", async () => {
      // WP-C steward rule 7: the actor is resolved before the body is
      // validated, so this sends an identity to reach the 400. (Old: sent with
      // no identity and got the 400; with no identity it is now a 401.)
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/heartbeat",
        headers: { "x-test-operator": "0x1111111111111111111111111111111111111111" },
        payload: { status: "online" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("kernelId required");

      const anonymous = await app.inject({
        method: "POST",
        url: "/api/operator/heartbeat",
        payload: { status: "online" },
      });
      expect(anonymous.statusCode).toBe(401);
    });

    it("acknowledges heartbeat for known kernel (sent by its owner)", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;

      const res = await app.inject({
        method: "POST",
        url: "/api/operator/heartbeat",
        headers: { "x-test-operator": ownerOf(kernelId) },
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

    it("acknowledges heartbeat with capability announcement (sent by its owner)", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;

      const res = await app.inject({
        method: "POST",
        url: "/api/operator/heartbeat",
        headers: { "x-test-operator": ownerOf(kernelId) },
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

    it("rejects a heartbeat for an unknown kernel with 404 (register first)", async () => {
      // Old assertion: 200 ("pcc-node may heartbeat before registration"),
      // and a heartbeat carrying capabilities would have inserted catalog rows
      // for a kernel id nobody owns. WP-C: the heartbeat facade requires the
      // kernel to exist. A node registers (POST /api/kernels) with its key
      // and then heartbeats as that owner.
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/heartbeat",
        headers: { "x-test-operator": "0x1111111111111111111111111111111111111111" },
        payload: {
          kernelId: "kernel-brand-new-unknown",
          status: "online",
          capabilities: [{ type: "ghost-capability" }],
        },
      });
      expect(res.statusCode).toBe(404);
      expect(getRepos().capabilities.findById("cap-kernel-brand-new-unknown-ghost-capability")).toBeFalsy();
    });

    it("rejects a heartbeat from a non-owner with 403 not_kernel_owner", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/heartbeat",
        headers: { "x-test-operator": "someone-else" },
        payload: { kernelId, status: "online" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("not_kernel_owner");
    });
  });

  // ── POST /api/operator/job-status ───────────────────────────────

  describe("POST /api/operator/job-status", () => {
    it("requires jobId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/job-status",
        headers: ANY_OPERATOR,
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
        headers: ANY_OPERATOR,
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
        headers: ANY_OPERATOR,
        payload: { jobId: "j-1", status: "flying" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("invalid_status");
      expect(body.valid).toContain("completed");
    });

    it("returns 404 job_not_found for an unknown job (was a graceful 200 updated:false)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/job-status",
        headers: ANY_OPERATOR,
        payload: {
          jobId: "job-does-not-exist-xyz",
          status: "completed",
        },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe("job_not_found");
      expect(body.updated).toBeUndefined();
    });

    it("updates status for known job (sent by its kernel's owner)", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;
      const jobId = await getQueuedJobId(app, kernelId);
      if (!jobId) return;

      const res = await app.inject({
        method: "POST",
        url: "/api/operator/job-status",
        headers: asOwnerOf(kernelId),
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
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;
      const jobId = getRepos().jobs.findByKernel(kernelId)[0]?.id;
      if (!jobId) return;

      const ACCEPTED = [
        "pending", "queued", "in_progress", "paused",
        "completed", "failed", "cancelled",
        "running", // tolerated alias → in_progress
      ];
      for (const status of ACCEPTED) {
        // A REAL job, sent by its kernel's owner (an unknown job is a 404 now,
        // so the old `not 400` on a fake job id would prove nothing).
        const res = await app.inject({
          method: "POST",
          url: "/api/operator/job-status",
          headers: asOwnerOf(kernelId),
          payload: { jobId, status },
        });
        expect(res.statusCode, `status ${status}`).toBe(200);
        // `running` is stored as its canonical form, every other status as itself.
        expect(getRepos().jobs.findById(jobId)?.status, `status ${status}`).toBe(
          status === "running" ? "in_progress" : status,
        );
      }
    });
  });
});
