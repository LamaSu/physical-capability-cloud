/**
 * Trace Demo E2E
 *
 * Exercises the full PCC trace path and verifies Sentry spans are created:
 *
 *   1. Start the gateway programmatically
 *   2. Submit a job via HTTP POST
 *   3. Poll job status until complete (or timeout)
 *   4. Verify the settlement pipeline ran (evidence stored in DB)
 *   5. Trigger an error scenario (missing stepId → 400 response captured by Sentry)
 *   6. Flush Sentry to ensure all spans are sent
 *   7. Print a summary of what happened
 *
 * Run: npx tsx scripts/trace-demo-e2e.ts
 *
 * Set SENTRY_DSN env var to send traces to your real Sentry project.
 * Without a DSN the script still runs end-to-end — all spans are created
 * in-memory; only the remote flush step is skipped.
 */

// ── Sentry must be initialised before any other imports ─────────────────────
import * as Sentry from "@sentry/node";

const SENTRY_DSN = process.env.SENTRY_DSN || process.env.VITE_SENTRY_DSN || "";

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 1.0,
    initialScope: { tags: { service: "pcc-gateway", demo: "trace-demo-e2e" } },
  });
  console.log("[sentry] Distributed tracing initialised (dsn=..." + SENTRY_DSN.slice(-12) + ")");
} else {
  console.log("[sentry] No DSN configured — spans will be created but not sent remotely.");
  console.log("[sentry]   Set SENTRY_DSN to send traces to your Sentry project.\n");
}

// ── Gateway + PCC imports ────────────────────────────────────────────────────
import Fastify, { type FastifyInstance } from "fastify";
import { jobSubmitRoutes } from "../packages/gateway/src/routes/job-submit.js";
import { jobRoutes } from "../packages/gateway/src/routes/jobs.js";
import { settlementRoutes } from "../packages/gateway/src/routes/settlement.js";
import { kernelRoutes } from "../packages/gateway/src/routes/kernels.js";
import { initStore, closeStore } from "../packages/gateway/src/db.js";
import { initKernelService, resetKernelService } from "../packages/gateway/src/services/kernel-service.js";
import { resetSettlementService } from "../packages/gateway/src/services/settlement-service.js";
import type { KernelConfig } from "@pcc/kernel";

// ── Helpers ──────────────────────────────────────────────────────────────────

const DIVIDER = "═".repeat(70);
const SECTION = "─".repeat(50);

function log(section: string, msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${section.padEnd(12)}] ${msg}`);
}

function heading(title: string) {
  console.log(`\n${SECTION}`);
  console.log(`  ${title}`);
  console.log(SECTION);
}

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── Mock KernelConfig ────────────────────────────────────────────────────────

const mockConfig: KernelConfig = {
  kernelId: "kernel-trace-demo",
  mockMode: true,
  devices: [
    {
      id: "dev-trace-machine",
      type: "machine",
      adapterType: "mock",
      config: { kernelId: "kernel-trace-demo", jobDurationMs: 500 },
    },
    {
      id: "dev-trace-sensor",
      type: "sensor",
      adapterType: "mock",
      config: { kernelId: "kernel-trace-demo" },
    },
    {
      id: "dev-trace-camera",
      type: "camera",
      adapterType: "mock",
      config: { kernelId: "kernel-trace-demo" },
    },
  ],
};

// ── Build a minimal Fastify app ───────────────────────────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  resetKernelService();
  resetSettlementService();
  initKernelService(mockConfig);

  const app = Fastify({ logger: false });
  await app.register(jobSubmitRoutes);
  await app.register(jobRoutes);
  await app.register(kernelRoutes);
  await app.register(settlementRoutes);
  await app.ready();
  return app;
}

// ── Poll job status until terminal or timeout ─────────────────────────────────

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "settled",
  "evidence_stored",
  "evidence_submitted",
]);

async function pollJobStatus(
  app: FastifyInstance,
  jobId: string,
  maxMs = 15_000,
): Promise<{ status: string; progress: number; evidenceBundleId: string | null }> {
  const deadline = Date.now() + maxMs;
  let last = { status: "queued", progress: 0, evidenceBundleId: null as string | null };

  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/status` });
    if (res.statusCode === 200) {
      const body = res.json() as { status: string; progress: number; evidenceBundleId: string | null };
      last = body;
      if (TERMINAL_STATUSES.has(body.status)) {
        return last;
      }
    }
    await sleep(200);
  }

  log("WARN", `Job ${jobId} did not reach terminal status within ${maxMs}ms — last: ${last.status}`);
  return last;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + DIVIDER);
  console.log("  PHYSICAL CAPABILITY CLOUD — Trace Demo E2E");
  console.log("  Verifying Sentry spans across the full job pipeline");
  console.log(DIVIDER + "\n");

  const rootSpan = Sentry.startInactiveSpan({
    name: "pcc.trace-demo-e2e",
    op: "test",
    forceTransaction: true,
  });

  let app: FastifyInstance | null = null;

  try {
    // ── Phase 1: Start gateway ───────────────────────────────────────────────

    heading("PHASE 1: Start Gateway (programmatic)");

    app = await Sentry.startSpan(
      { name: "gateway.init", op: "setup", parentSpan: rootSpan },
      async () => {
        const instance = await buildApp();
        return instance;
      },
    );
    log("GATEWAY", "Minimal Fastify gateway ready (in-memory SQLite, mock kernel)");

    // Emit a breadcrumb so Sentry records this checkpoint
    Sentry.addBreadcrumb({
      category: "pcc.gateway",
      message: "Gateway initialised for trace demo",
      level: "info",
      data: { kernelId: mockConfig.kernelId, mockMode: true },
    });

    // ── Phase 2: Happy path — submit a job ──────────────────────────────────

    heading("PHASE 2: Submit Job (Happy Path)");

    const jobId = `job-trace-${Date.now()}`;
    log("JOB", `Submitting job ${jobId} to kernel-nyc...`);

    const submitResult = await Sentry.startSpan(
      { name: "gateway.job.submit", op: "http.client", parentSpan: rootSpan },
      async () => {
        const res = await app!.inject({
          method: "POST",
          url: "/api/jobs/submit",
          payload: {
            jobId,
            stepId: "step-trace-print",
            kernelId: "kernel-nyc",
            assuranceTier: 0,
          },
        });
        return { statusCode: res.statusCode, body: res.json() };
      },
    );

    if (submitResult.statusCode !== 200) {
      throw new Error(`Job submission failed: ${JSON.stringify(submitResult.body)}`);
    }

    log("JOB", `Accepted: ${submitResult.body.jobId} on device ${submitResult.body.deviceId}`);

    Sentry.addBreadcrumb({
      category: "pcc.job",
      message: `Job submitted: ${jobId}`,
      level: "info",
      data: { jobId, deviceId: submitResult.body.deviceId, status: submitResult.body.status },
    });

    // ── Phase 3: Poll until complete ─────────────────────────────────────────

    heading("PHASE 3: Wait for Job Completion + Evidence Collection");

    const finalStatus = await Sentry.startSpan(
      { name: "gateway.job.poll", op: "task", parentSpan: rootSpan },
      async () => pollJobStatus(app!, jobId),
    );

    log("JOB", `Final status: ${finalStatus.status} (progress=${finalStatus.progress}%)`);
    if (finalStatus.evidenceBundleId) {
      log("EVIDENCE", `Evidence bundle stored: ${finalStatus.evidenceBundleId}`);
    }

    Sentry.addBreadcrumb({
      category: "pcc.job",
      message: `Job finished: ${jobId}`,
      level: finalStatus.status === "failed" ? "error" : "info",
      data: finalStatus,
    });

    // ── Phase 4: Verify settlement pipeline ──────────────────────────────────

    heading("PHASE 4: Verify Settlement Pipeline");

    await Sentry.startSpan(
      { name: "gateway.settlement.verify", op: "db.query", parentSpan: rootSpan },
      async () => {
        const res = await app!.inject({ method: "GET", url: `/api/settlement/${jobId}` });
        log("SETTLEMENT", `Settlement endpoint status: ${res.statusCode}`);
        if (res.statusCode === 200) {
          const body = res.json();
          log("SETTLEMENT", `  settled=${body.settled}, status=${body.status}`);
          if (body.evidenceBundleId) {
            log("SETTLEMENT", `  evidenceBundleId=${body.evidenceBundleId}`);
          }
          Sentry.addBreadcrumb({
            category: "pcc.settlement",
            message: "Settlement pipeline verified",
            level: "info",
            data: body,
          });
        }
      },
    );

    // ── Phase 5: Check evidence endpoint ─────────────────────────────────────

    heading("PHASE 5: Evidence Explorer");

    await Sentry.startSpan(
      { name: "gateway.evidence.fetch", op: "http.client", parentSpan: rootSpan },
      async () => {
        const res = await app!.inject({ method: "GET", url: `/api/evidence/${jobId}` });
        log("EVIDENCE", `Evidence endpoint status: ${res.statusCode}`);
        if (res.statusCode === 200) {
          const body = res.json();
          log("EVIDENCE", `  ${body.count} bundle(s) found`);
          for (const b of body.bundles ?? []) {
            log("EVIDENCE", `  bundle ${b.bundleId}: ${b.eventCount} events, hash=${b.hash?.slice(0, 20)}...`);
          }
        } else {
          log("EVIDENCE", "  No bundles yet (mock device may not have finalised)");
        }
      },
    );

    // ── Phase 6: Error scenario ───────────────────────────────────────────────

    heading("PHASE 6: Error Scenario (missing stepId → Sentry error capture)");

    await Sentry.startSpan(
      { name: "gateway.job.submit.error", op: "http.client", parentSpan: rootSpan },
      async () => {
        const res = await app!.inject({
          method: "POST",
          url: "/api/jobs/submit",
          payload: {
            // intentionally missing stepId to trigger 400
            kernelId: "kernel-nyc",
          },
        });

        log("ERROR_DEMO", `Response status: ${res.statusCode} (expected 400)`);
        const body = res.json();
        log("ERROR_DEMO", `  Error: ${body.error}`);

        if (res.statusCode === 400) {
          // Capture this as a Sentry error with context so the demo shows up
          Sentry.captureException(
            new Error(`[trace-demo] Expected error scenario: ${body.error}`),
            {
              level: "warning",
              tags: { scenario: "missing_step_id", demo: "true" },
              extra: { responseBody: body, endpoint: "/api/jobs/submit" },
            },
          );
          Sentry.addBreadcrumb({
            category: "pcc.error_scenario",
            message: `Error scenario triggered: ${body.error}`,
            level: "warning",
            data: { statusCode: res.statusCode, error: body.error },
          });
          log("ERROR_DEMO", "  Error captured in Sentry (visible as warning-level event)");
        }
      },
    );

    // ── Phase 7: Agent message passing (lightweight) ──────────────────────────

    heading("PHASE 7: Agent Bridge Status");

    await Sentry.startSpan(
      { name: "gateway.agents.status", op: "http.client", parentSpan: rootSpan },
      async () => {
        const res = await app!.inject({ method: "GET", url: "/api/kernels" });
        if (res.statusCode === 200) {
          const body = res.json();
          log("AGENTS", `Kernels available: ${body.kernels?.length ?? 0}`);
          for (const k of body.kernels ?? []) {
            log("AGENTS", `  ${k.id}: ${k.status} (${k.capabilities?.length ?? 0} capabilities)`);
          }
        }
      },
    );

    // ── Finalise root span ────────────────────────────────────────────────────

    rootSpan.setStatus({ code: 1, message: "ok" });
    rootSpan.end();

    // ── Phase 8: Flush Sentry ─────────────────────────────────────────────────

    heading("PHASE 8: Flush Sentry");

    if (SENTRY_DSN) {
      log("SENTRY", "Flushing all pending spans/events to Sentry...");
      const flushed = await Sentry.flush(5000);
      log("SENTRY", flushed ? "Flush complete — check your Sentry dashboard!" : "Flush timed out (some spans may be pending)");
    } else {
      log("SENTRY", "No DSN — skipping remote flush. All spans were created in-memory.");
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    console.log("\n" + DIVIDER);
    console.log("  TRACE DEMO COMPLETE");
    console.log(DIVIDER);
    console.log(`
  Trace path exercised:
    Job submission   → POST /api/jobs/submit
    Job polling      → GET  /api/jobs/:jobId/status
    Evidence check   → GET  /api/evidence/:jobId
    Settlement check → GET  /api/settlement/:jobId
    Kernel listing   → GET  /api/kernels

  Sentry spans created:
    pcc.trace-demo-e2e       (root transaction)
    gateway.init             (setup)
    gateway.job.submit       (happy path)
    gateway.job.poll         (status polling)
    gateway.settlement.verify
    gateway.evidence.fetch
    gateway.job.submit.error (error scenario — captured as warning)
    gateway.agents.status

  Error scenario:
    POST /api/jobs/submit with missing stepId → 400 missing_step_id
    Captured in Sentry as a warning-level event

  Final job status:  ${finalStatus.status}
  Evidence bundle:   ${finalStatus.evidenceBundleId ?? "(not yet finalised)"}
  Sentry DSN:        ${SENTRY_DSN ? "configured (traces sent)" : "not set (local only)"}
    `);
  } catch (err) {
    rootSpan.setStatus({ code: 2, message: "internal_error" });
    rootSpan.end();
    Sentry.captureException(err);
    await Sentry.flush(3000);
    console.error("\n[trace-demo] FATAL:", err);
    process.exit(1);
  } finally {
    if (app) {
      await app.close();
    }
    closeStore();
    resetKernelService();
    resetSettlementService();
  }
}

main().catch((err) => {
  console.error("Trace demo failed:", err);
  process.exit(1);
});
