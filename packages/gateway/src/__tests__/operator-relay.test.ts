/**
 * Tests for operator relay endpoints:
 *   GET  /api/operator/jobs
 *   POST /api/operator/evidence
 *   POST /api/operator/heartbeat
 *   POST /api/operator/job-status
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { operatorRelayRoutes, NO_DEVICE_SIGNATURE } from "../routes/operator-relay.js";
import { jobRoutes } from "../routes/jobs.js";
import { kernelRoutes } from "../routes/kernels.js";
import { settlementRoutes } from "../routes/settlement.js";
import { buildCanonicalEvidenceEnvelope } from "../services/evidence-envelope.js";
import { isDeviceSignedSignature } from "../services/device-evidence-settlement.js";
import { initStore, closeStore, getRepos } from "../db.js";
import crypto from "node:crypto";

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
  await app.register(kernelRoutes);
  await app.register(jobRoutes);
  await app.register(operatorRelayRoutes);
  // LO-GW-4b: the retrieval side of the round-trip — GET /api/evidence/:hash
  // serves the canonical envelope the relay committed to.
  await app.register(settlementRoutes);
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

    // ── LO-GW-4a: the unsigned path records ABSENCE, never a placeholder ──
    it("records a null signature (not `operator-relay-auto`) for non-bundle evidence", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;
      const jobId = await getQueuedJobId(app, kernelId);
      if (!jobId) return;

      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        payload: { jobId, kernelId, evidence: { printed: true, returncode: 0 } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.stored).toBe(true);
      expect(body.deviceSigned).toBe(false);
      // The RESPONSE reports null — never a signature the gateway does not hold.
      expect(body.kernelSignature).toBeNull();

      const stored = getRepos().evidence.findById(body.bundleId);
      // The invented placeholder is gone. The stored record asserts nothing:
      // no signer named, algorithm "none", empty value (the column is NOT NULL,
      // so absence is recorded inside that constraint — see NO_DEVICE_SIGNATURE).
      expect(stored!.kernelSignature.value).not.toBe("operator-relay-auto");
      expect(stored!.kernelSignature).toEqual({ ...NO_DEVICE_SIGNATURE });
      expect(stored!.kernelSignature.signer).toBe("");
      expect(stored!.assuranceTier).toBe(0);
    });

    // ── LO-GW-4b: the pushed events array is PERSISTED, on both branches ──
    it("persists the pushed events array (unsigned path) — rows > 0", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;
      const jobId = await getQueuedJobId(app, kernelId);
      if (!jobId) return;

      const ts = new Date().toISOString();
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        payload: {
          jobId,
          kernelId,
          evidence: {
            printed: true,
            events: [
              { type: "job_started", timestamp: ts },
              { type: "execution_completed", timestamp: ts, payload: { pagesCount: 1 } },
            ],
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.eventsStored).toBe(2);

      const rows = getRepos().evidence.findEventsByBundle(body.bundleId);
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.type).sort()).toEqual(["execution_completed", "job_started"]);
      // The payload the node pushed survived the round-trip verbatim.
      const completed = rows.find((r) => r.type === "execution_completed")!;
      expect(completed.payload).toEqual({ pagesCount: 1 });
    });

    it("persists the pushed events array on the SIGNED path too", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;
      const jobId = await getQueuedJobId(app, kernelId);
      if (!jobId) return;

      const bundle = realDeviceBundle(jobId);
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        payload: { jobId, kernelId, evidence: bundle },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.deviceSigned).toBe(true);
      expect(body.eventsStored).toBe(1);
      const rows = getRepos().evidence.findEventsByBundle(body.bundleId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.type).toBe("execution_completed");
      // The device's own hash still anchors the signed path (SEAM-2 unchanged).
      expect(body.bundleHash).toBe(bundle.bundleHash);
    });

    it("retrieval returns the SAME BYTES the relay committed to (oracle re-hash verifies)", async () => {
      const kernelId = await getSeededKernelId(app);
      if (!kernelId) return;
      const jobId = await getQueuedJobId(app, kernelId);
      if (!jobId) return;

      const ts = new Date().toISOString();
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        payload: {
          jobId,
          kernelId,
          evidence: { events: [{ type: "execution_completed", timestamp: ts }] },
        },
      });
      expect(res.statusCode).toBe(200);
      const { bundleId, bundleHash } = res.json();

      // The committed hash is content-addressed, not the old `sha256-<uuid>`
      // synthetic string, so it is in a form the oracle's fetch recognises.
      expect(bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);

      // Fetch the bundle back the way the oracle does and re-hash the RAW bytes.
      const got = await app.inject({ method: "GET", url: `/api/evidence/${bundleHash}` });
      expect(got.statusCode).toBe(200);
      const rehashed = `sha256:${crypto.createHash("sha256").update(got.body).digest("hex")}`;
      expect(rehashed).toBe(bundleHash);

      // ...and the served document CONTAINS the events (a doc without them
      // verifies but detects nothing — pcc-oracle PR #15).
      const doc = JSON.parse(got.body);
      expect(doc.id).toBe(bundleId);
      expect(Array.isArray(doc.events)).toBe(true);
      expect(doc.events.length).toBe(1);
      expect(doc.events[0].type).toBe("execution_completed");
    });

    // ── Negative controls: none of these may reach a settle-eligible state ──
    describe("negative controls — unverified relay evidence is never settle-eligible", () => {
      it("an unsigned bundle is not device-signed and cannot anchor settlement", async () => {
        const kernelId = await getSeededKernelId(app);
        if (!kernelId) return;
        const jobId = await getQueuedJobId(app, kernelId);
        if (!jobId) return;

        const res = await app.inject({
          method: "POST",
          url: "/api/operator/evidence",
          payload: { jobId, kernelId, evidence: { printed: true, assuranceTier: 3 } },
        });
        const stored = getRepos().evidence.findById(res.json().bundleId)!;
        // The settlement seam's own predicate — the gate every anchor passes.
        expect(isDeviceSignedSignature(stored.kernelSignature)).toBe(false);
        // The node's self-declared tier 3 is NOT trusted; tier stays at the
        // permissionless floor.
        expect(stored.assuranceTier).toBe(0);
      });

      it("a bundle whose events were dropped cannot serve bytes that re-hash", async () => {
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
            evidence: { events: [{ type: "execution_completed", timestamp: new Date().toISOString() }] },
          },
        });
        const { bundleId, bundleHash } = res.json();
        const stored = getRepos().evidence.findById(bundleId)!;

        // Reconstruct the envelope the OLD behaviour would have served — same
        // bundle row, events discarded. It must NOT re-hash to the committed
        // hash: dropping the events breaks the oracle's byte check, which is
        // exactly why they have to be persisted.
        const withoutEvents = buildCanonicalEvidenceEnvelope(
          {
            id: stored.id,
            jobId: stored.jobId,
            stepId: stored.stepId,
            kernelId: stored.kernelId,
            assuranceTier: stored.assuranceTier,
            createdAt: stored.createdAt,
            kernelSignature: stored.kernelSignature,
          },
          [],
        );
        const rehashed = `sha256:${crypto.createHash("sha256").update(withoutEvents).digest("hex")}`;
        expect(rehashed).not.toBe(bundleHash);
      });

      it("a bundle carrying the legacy placeholder signature is rejected by the seam", async () => {
        const kernelId = await getSeededKernelId(app);
        if (!kernelId) return;
        const jobId = await getQueuedJobId(app, kernelId);
        if (!jobId) return;

        // A node that sends the old placeholder verbatim must not be promoted
        // to device-signed: extractNodeSignedBundle returns null for it.
        const res = await app.inject({
          method: "POST",
          url: "/api/operator/evidence",
          payload: {
            jobId,
            kernelId,
            evidence: {
              bundleHash: `sha256:${"cd".repeat(32)}`,
              kernelSignature: { signer: kernelId, algorithm: "ed25519", value: "operator-relay-auto" },
              events: [{ type: "execution_completed", timestamp: new Date().toISOString() }],
            },
          },
        });
        const body = res.json();
        expect(body.deviceSigned).toBe(false);
        expect(body.kernelSignature).toBeNull();
        const stored = getRepos().evidence.findById(body.bundleId)!;
        expect(stored.kernelSignature.value).not.toBe("operator-relay-auto");
        expect(isDeviceSignedSignature(stored.kernelSignature)).toBe(false);
        // The node-supplied bundleHash is NOT adopted for an unsigned bundle —
        // the committed hash is the gateway's own content hash.
        expect(stored.bundleHash).not.toBe(`sha256:${"cd".repeat(32)}`);
      });
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
