/**
 * Tests for operator relay endpoints:
 *   GET  /api/operator/jobs
 *   POST /api/operator/evidence
 *   POST /api/operator/heartbeat
 *   POST /api/operator/job-status
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { jobRoutes } from "../routes/jobs.js";
import { kernelRoutes } from "../routes/kernels.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { canonicalize, hashBundle, hashEvent, sha256, type EvidenceEvent } from "@pcc/spec";

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


/** A real device-signed (#236) evidence bundle in the wire form the node produces (hex Ed25519
 *  sig, truncated EVM-looking signer): LO-EV events, and the bundle hash computed from them and
 *  signed, as kernel-sdk's job-handler does. */
async function realDeviceBundle(jobId: string, kernelId: string) {
  const kp = nacl.sign.keyPair();
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const raw = [
    { type: "execution_completed", timestamp: new Date().toISOString(), source: { deviceId: "printer-1", deviceType: "fdm", kernelId }, payload: { ok: true, jobId } },
  ];
  const events = await Promise.all(raw.map(async (e) => ({ ...e, hash: await hashEvent(e as Omit<EvidenceEvent, "hash" | "id">) })));
  const bundleHash = await hashBundle(events as unknown as EvidenceEvent[]);
  const sig = nacl.sign.detached(new TextEncoder().encode(bundleHash), kp.secretKey);
  return {
    jobId,
    assuranceTier: 2, // node's DECLARED tier — path 1 must NOT trust it (stays 0)
    bundleHash,
    kernelSignature: {
      signer: `0x${hex(kp.publicKey).slice(0, 40)}`,
      algorithm: "ed25519",
      value: hex(sig),
    },
    events,
  };
}

/** A seeded job with a kernel. A test using it fails, never skips, when the seed has none. */
function seededJob() {
  const job = getRepos().jobs.findAll().find((j) => j.kernelId);
  expect(job, "the seed must hold a job with a kernel").toBeTruthy();
  return job!;
}
const bundlesFor = (jobId: string) => getRepos().evidence.findByJob(jobId).length;

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  app.addHook("onRequest", asN31cAdmin);
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

    it("NEGATIVE (N80, review E4): pcc-node's current events, which carry no source, are refused (422) and not stored", async () => {
      const { id: jobId, kernelId } = seededJob();
      const before = bundlesFor(jobId);

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
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "events_malformed", eventIndex: 0, stored: false, jobId });
      expect(bundlesFor(jobId)).toBe(before);
    });

    // ── SEAM-2 path 1: capture the node's REAL device signature ──────────
    it("captures the node's real device-signed (#236) Ed25519 signature", async () => {
      const { id: jobId, kernelId } = seededJob();

      const bundle = await realDeviceBundle(jobId, kernelId);
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

    it("NEGATIVE (N80, review E4): non-bundle evidence is refused (422), never stored under a hash of content the gateway drops", async () => {
      const { id: jobId, kernelId } = seededJob();
      const before = bundlesFor(jobId);

      const res = await app.inject({
        method: "POST",
        url: "/api/operator/evidence",
        payload: { jobId, kernelId, evidence: { printed: true, returncode: 0 } },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "evidence_not_lo_ev", stored: false, jobId });
      expect(bundlesFor(jobId)).toBe(before);
    });
  });

  // ── N80 (rehearsal R0 G3): stored evidence tells the truth ──────
  describe("POST /api/operator/evidence stores a true hash (N80)", () => {
    it("NEGATIVE (review E4 finding 1): the rehearsal's device document is refused (422), not stored under a hash nobody can reproduce", async () => {
      const job = seededJob();
      const before = bundlesFor(job.id);
      const evidence = { deviceId: "SIM-0001", run: { runId: "run-1", result: { readings: { A1: 0.412 } } } };
      const res = await app.inject({ method: "POST", url: "/api/operator/evidence", payload: { jobId: job.id, kernelId: job.kernelId, evidence } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "evidence_not_lo_ev", stored: false });
      expect(bundlesFor(job.id)).toBe(before);
    });

    it("NEGATIVE (review E4 finding 2): when storing the events fails, the bundle is rolled back, never left without them", async () => {
      const job = seededJob();
      const before = bundlesFor(job.id);
      const src = { deviceId: "reader-1", deviceType: "plate_reader", kernelId: job.kernelId };
      const events = [{ type: "execution_completed", timestamp: "2026-09-29T22:35:01.000Z", source: src, payload: { ok: true, jobId: job.id } }];
      const spy = vi.spyOn(getRepos().evidence, "insertEvents").mockImplementationOnce(() => {
        throw new Error("injected insertEvents failure");
      });
      try {
        const res = await app.inject({ method: "POST", url: "/api/operator/evidence", payload: { jobId: job.id, kernelId: job.kernelId, evidence: { events } } });
        expect(res.json()).toMatchObject({ stored: false, error: "storage_failed" });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      expect(bundlesFor(job.id)).toBe(before);
    });

    it("NEGATIVE (review E4 finding 3): a root bundleHash beside a bundle wrapper is ambiguous (422), never ignored", async () => {
      const job = seededJob();
      const before = bundlesFor(job.id);
      const src = { deviceId: "reader-1", deviceType: "plate_reader", kernelId: job.kernelId };
      const evidence = {
        bundle: { events: [{ type: "execution_completed", timestamp: "2026-09-29T22:35:01.000Z", source: src, payload: {} }] },
        bundleHash: `sha256:${"ab".repeat(32)}`,
      };
      const res = await app.inject({ method: "POST", url: "/api/operator/evidence", payload: { jobId: job.id, kernelId: job.kernelId, evidence } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "ambiguous_envelope", stored: false });
      expect(bundlesFor(job.id)).toBe(before);
    });

    it("LO-EV events are stored with recomputed hashes, and the stored bundle hash reproduces from them", async () => {
      const job = seededJob();
      const src = { deviceId: "reader-1", deviceType: "plate_reader", kernelId: job.kernelId };
      const events = [
        { type: "execution_completed", timestamp: "2026-09-29T22:35:01.000Z", source: src, payload: { ok: true, jobId: job.id } },
        { type: "cv_inspection_result", timestamp: "2026-09-29T22:35:02.000Z", source: src, payload: { passed: true, jobId: job.id } },
      ];
      const res = await app.inject({ method: "POST", url: "/api/operator/evidence", payload: { jobId: job.id, kernelId: job.kernelId, evidence: { events } } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ stored: true, hashModel: "event_bundle_hash", eventsStored: 2, signatureVerified: false });
      const rows = getRepos().evidence.findEventsByBundle(body.bundleId);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.hash).toBe(await hashEvent({ type: row.type, timestamp: row.timestamp, source: row.source, payload: row.payload } as Omit<EvidenceEvent, "hash" | "id">));
      }
      expect(getRepos().evidence.findById(body.bundleId)!.bundleHash).toBe(await hashBundle(rows as unknown as EvidenceEvent[]));
    });

    it("NEGATIVE: an event hash that does not reproduce is refused with 422, and nothing is stored", async () => {
      const job = seededJob();
      const before = bundlesFor(job.id);
      const src = { deviceId: "reader-1", deviceType: "plate_reader", kernelId: job.kernelId };
      const events = [{ type: "execution_completed", timestamp: "2026-09-29T22:35:01.000Z", source: src, payload: {}, hash: `sha256:${"ab".repeat(32)}` }];
      const res = await app.inject({ method: "POST", url: "/api/operator/evidence", payload: { jobId: job.id, kernelId: job.kernelId, evidence: { events } } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "event_hash_mismatch", eventIndex: 0, stored: false });
      expect(bundlesFor(job.id)).toBe(before);
    });

    it("NEGATIVE: evidence naming another kernel than the job's is refused with 409, and nothing is stored", async () => {
      const job = seededJob();
      const before = bundlesFor(job.id);
      const res = await app.inject({ method: "POST", url: "/api/operator/evidence", payload: { jobId: job.id, kernelId: `${job.kernelId}-not-this-job`, evidence: { ok: true } } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("kernel_mismatch");
      expect(bundlesFor(job.id)).toBe(before);
    });
  });

  describe("POST /api/operator/evidence binds a signed document to its job (adk #4322, review 117 on #471)", () => {
    /** #471's wire form (pcc-node jobport.py report()): bundleHash = sha256(canonicalize(the bundle
     *  minus bundleHash and kernelSignature)), and the node signs the UTF-8 bytes of that digest. */
    async function signedDocument(jobId: string, kernelId: string) {
      const kp = nacl.sign.keyPair();
      const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
      const doc: Record<string, unknown> = {
        jobId,
        kernelId,
        operation: "plate_read",
        runId: "run-000003",
        record: { state: "completed", result: { wavelengthNm: 450, readings: { A1: 0.412 } } },
        logChain: [{ seq: 1, entryHash: `sha256:${"cd".repeat(32)}` }],
        signerPublicKey: `0x${hex(kp.publicKey)}`,
      };
      const bundleHash = await sha256(canonicalize(doc));
      const sig = nacl.sign.detached(new TextEncoder().encode(bundleHash), kp.secretKey);
      return { ...doc, bundleHash, kernelSignature: { signer: `0x${hex(kp.publicKey)}`, algorithm: "ed25519", value: hex(sig) } };
    }

    it("NEGATIVE (claim 2): a signed document naming another job is refused (409), and nothing is stored", async () => {
      const job = seededJob();
      const before = bundlesFor(job.id);
      const bundle = await signedDocument(`${job.id}-another-job`, job.kernelId!);
      const res = await app.inject({ method: "POST", url: "/api/operator/evidence", payload: { jobId: job.id, kernelId: job.kernelId, evidence: { bundle } } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "job_mismatch", stored: false });
      expect(bundlesFor(job.id)).toBe(before);
    });

    it("NEGATIVE (claim 2): a signed document naming another kernel than the job's is refused (409), and nothing is stored", async () => {
      const job = seededJob();
      const before = bundlesFor(job.id);
      const bundle = await signedDocument(job.id, `${job.kernelId}-not-this-job`);
      const res = await app.inject({ method: "POST", url: "/api/operator/evidence", payload: { jobId: job.id, kernelId: job.kernelId, evidence: { bundle } } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "kernel_mismatch", stored: false });
      expect(bundlesFor(job.id)).toBe(before);
    });

    it("NEGATIVE (claim 1): a document edited after signing does not reproduce its signed hash (422), and nothing is stored", async () => {
      const job = seededJob();
      const before = bundlesFor(job.id);
      const bundle = await signedDocument(job.id, job.kernelId!);
      const edited = { ...bundle, record: { state: "completed", result: { wavelengthNm: 450, readings: { A1: 0.999 } } } };
      const res = await app.inject({ method: "POST", url: "/api/operator/evidence", payload: { jobId: job.id, kernelId: job.kernelId, evidence: { bundle: edited } } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "bundle_hash_mismatch", stored: false });
      expect(bundlesFor(job.id)).toBe(before);
    });

    it("NEGATIVE (lane-found): job A's signature stripped to a bare digest cannot be filed under job B (422), and nothing is stored", async () => {
      const job = seededJob();
      const before = bundlesFor(job.id);
      const a = await signedDocument(`${job.id}-job-a`, job.kernelId!);
      const bare = { bundleHash: a.bundleHash, kernelSignature: a.kernelSignature };
      const res = await app.inject({ method: "POST", url: "/api/operator/evidence", payload: { jobId: job.id, kernelId: job.kernelId, evidence: { bundle: bare } } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ stored: false });
      expect(bundlesFor(job.id)).toBe(before);
    });

    it("a signed document that names this job and kernel and reproduces its hash is stored as device_signed_document", async () => {
      const job = seededJob();
      const bundle = await signedDocument(job.id, job.kernelId!);
      const res = await app.inject({ method: "POST", url: "/api/operator/evidence", payload: { jobId: job.id, kernelId: job.kernelId, evidence: { bundle } } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ stored: true, hashModel: "device_signed_document", contentHash: bundle.bundleHash, deviceSigned: true, signatureVerified: false });
    });
  });

  describe("POST /api/operator/evidence binds an event bundle to its job and kernel (cross-family review E4b)", () => {
    it("NEGATIVE: a device-signed event bundle for another job is refused (409), and nothing is stored", async () => {
      const job = seededJob();
      const before = bundlesFor(job.id);
      const bundle = await realDeviceBundle(`${job.id}-another-job`, job.kernelId!);
      const res = await app.inject({ method: "POST", url: "/api/operator/evidence", payload: { jobId: job.id, kernelId: job.kernelId, evidence: { bundle: { ...bundle, jobId: job.id } } } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "job_mismatch", stored: false });
      expect(bundlesFor(job.id)).toBe(before);
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
