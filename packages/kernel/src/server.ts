/**
 * Shop Kernel HTTP Server — Capability API.
 *
 * Exposes the kernel's capabilities to the control plane:
 *   GET  /health           — Heartbeat / liveness
 *   GET  /capabilities     — List capabilities
 *   POST /quote            — Get a price quote for a job
 *   POST /reserve          — Reserve a capability slot
 *   POST /execute          — Start a job on a reserved slot
 *   GET  /jobs/:id         — Get job status
 *   GET  /jobs/:id/evidence — Get evidence bundle for a completed job
 *   POST /handoff          — Initiate custody handoff
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import type { Capability, CapabilitySlot, KernelJob, CustodyEvent, EvidenceBundle } from "@pcc/spec";
import { ids } from "@pcc/spec";
import { EvidenceEmitter } from "./evidence-emitter.js";
import { JobRunner } from "./job-runner.js";
import { MockFDMAdapter } from "./adapters/mock-fdm.js";
import { MockPowerMonitorAdapter } from "./adapters/mock-power-monitor.js";
import { MockCameraAdapter } from "./adapters/mock-camera.js";

const KERNEL_ID = process.env.KERNEL_ID ?? "kernel_dev_001";
const PORT = parseInt(process.env.PORT ?? "3100", 10);

// ---- State (in-memory for v1; swap to SQLite/Postgres later) ----
const capabilities: Capability[] = [];
const jobs: Map<string, KernelJob> = new Map();
const bundles: Map<string, EvidenceBundle> = new Map();
const custodyEvents: Map<string, CustodyEvent[]> = new Map();

// ---- Initialize mock devices ----
const fdm = new MockFDMAdapter("dev_fdm_001", KERNEL_ID, 5_000);
const powerMonitor = new MockPowerMonitorAdapter("dev_power_001", KERNEL_ID);
const camera = new MockCameraAdapter("dev_cam_001", KERNEL_ID);
const evidenceEmitter = new EvidenceEmitter(KERNEL_ID);

// Register a mock capability
capabilities.push({
  id: ids.capability(),
  kernelId: KERNEL_ID,
  type: "fdm",
  name: "Mock Prusa MK4 FDM Printer",
  description: "Simulated FDM printer for development",
  materials: ["pla", "petg", "abs", "tpu"],
  tolerances: { linear: "±0.1mm", surface: "Ra 12.5" },
  envelope: { x: 250, y: 210, z: 210, unit: "mm" },
  assuranceTiers: [0, 1, 2],
  pricing: {
    currency: "USDC",
    baseCost: "2.00",
    perMinute: "0.05",
    perGram: "0.03",
    minimum: "5.00",
  },
  availability: {
    timezone: "America/New_York",
    windows: {
      "1": [{ start: "2026-01-01T08:00:00Z", end: "2026-01-01T22:00:00Z" }],
      "2": [{ start: "2026-01-01T08:00:00Z", end: "2026-01-01T22:00:00Z" }],
      "3": [{ start: "2026-01-01T08:00:00Z", end: "2026-01-01T22:00:00Z" }],
      "4": [{ start: "2026-01-01T08:00:00Z", end: "2026-01-01T22:00:00Z" }],
      "5": [{ start: "2026-01-01T08:00:00Z", end: "2026-01-01T22:00:00Z" }],
    },
  },
  location: { lat: 40.7128, lng: -74.006 },
  queueDepth: 0,
  tags: ["fdm", "prototyping", "pla"],
});

// Listen for finalized bundles
evidenceEmitter.onBundle((bundle) => {
  bundles.set(bundle.jobId, bundle);
  const job = jobs.get(bundle.jobId);
  if (job) {
    job.evidenceBundleId = bundle.id;
    job.status = "awaiting_pickup";
    job.completedAt = new Date().toISOString();
    job.progress = 100;
  }
});

// ---- Server ----
async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.get("/health", async () => ({
    kernelId: KERNEL_ID,
    status: "online",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
    activeJobs: [...jobs.values()].filter((j) => j.status === "executing").length,
  }));

  app.get("/capabilities", async () => ({
    kernelId: KERNEL_ID,
    capabilities,
  }));

  app.post<{ Body: { capabilityId: string; gcodeHash: string; assuranceTier: number; estimatedMinutes?: number } }>(
    "/quote",
    async (request) => {
      const { capabilityId, gcodeHash, assuranceTier, estimatedMinutes } = request.body;
      const cap = capabilities.find((c) => c.id === capabilityId);
      if (!cap) return { error: "Capability not found" };

      const minutes = estimatedMinutes ?? 60;
      const baseCost = parseFloat(cap.pricing.baseCost);
      const perMin = parseFloat(cap.pricing.perMinute ?? "0");
      const total = Math.max(parseFloat(cap.pricing.minimum), baseCost + perMin * minutes);

      return {
        capabilityId,
        quotedPrice: total.toFixed(2),
        currency: cap.pricing.currency,
        estimatedMinutes: minutes,
        assuranceTier,
        validUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
    },
  );

  app.post<{ Body: { capabilityId: string; jobId: string; stepId: string; cwmId: string; gcodeHash: string; assuranceTier: number } }>(
    "/execute",
    async (request) => {
      const { capabilityId, jobId, stepId, cwmId, gcodeHash, assuranceTier } = request.body;

      const job: KernelJob = {
        id: jobId,
        stepId,
        cwmId,
        capabilityId,
        status: "preparing",
        assignedDevices: [fdm.id, powerMonitor.id, camera.id],
        progress: 0,
      };
      jobs.set(jobId, job);

      // Run job asynchronously
      const runner = new JobRunner(fdm, [powerMonitor], camera, evidenceEmitter);
      job.status = "executing";
      job.startedAt = new Date().toISOString();

      runner.run({
        jobId,
        stepId,
        gcodeHash: gcodeHash as any,
        assuranceTier: assuranceTier as any,
      }).then((result) => {
        if (!result.success) {
          job.status = "failed";
          console.error(`Job ${jobId} failed: ${result.error}`);
        }
      }).catch((err) => {
        job.status = "failed";
        console.error(`Job ${jobId} error:`, err);
      });

      return { jobId, status: "executing" };
    },
  );

  app.get<{ Params: { id: string } }>("/jobs/:id", async (request) => {
    const job = jobs.get(request.params.id);
    if (!job) return { error: "Job not found" };
    return job;
  });

  app.get<{ Params: { id: string } }>("/jobs/:id/evidence", async (request) => {
    const bundle = bundles.get(request.params.id);
    if (!bundle) return { error: "Evidence not yet available" };
    return bundle;
  });

  app.post<{ Body: { jobId: string; courierService: string; externalDeliveryId: string } }>(
    "/handoff",
    async (request) => {
      const { jobId, courierService, externalDeliveryId } = request.body;
      const job = jobs.get(jobId);
      if (!job) return { error: "Job not found" };

      const event: CustodyEvent = {
        id: ids.custody(),
        jobId,
        type: "handoff_to_courier",
        timestamp: new Date().toISOString(),
        actor: { type: "kernel", id: KERNEL_ID },
        location: { lat: 40.7128, lng: -74.006 },
        metadata: { courierService, externalDeliveryId },
      };

      const existing = custodyEvents.get(jobId) ?? [];
      existing.push(event);
      custodyEvents.set(jobId, existing);

      job.status = "completed";

      return { custodyEventId: event.id, status: "handed_off" };
    },
  );

  return app;
}

// ---- Start (only when run directly) ----
const isMain = process.argv[1]?.includes("server");
if (isMain) {
  buildServer().then((app) => {
    app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
      console.log(`Shop Kernel ${KERNEL_ID} listening on port ${PORT}`);
    });
  }).catch(console.error);
}

export { buildServer };
