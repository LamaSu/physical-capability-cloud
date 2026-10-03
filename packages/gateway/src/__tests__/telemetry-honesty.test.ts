/**
 * Reproductions for astra's 408b review (PR #408, SHIP-WITH-FIXES at 8495f87a):
 *
 *   F1 — GET /api/telemetry/system initializes every db.* collection to []
 *        and leaves it that way whether the facade/repo read succeeded empty
 *        or failed outright. The dashboard then can't tell "no kernels" from
 *        "the kernel read failed."
 *   F2 — PipelineTelemetryService.getStats() returns successRate: 0 both
 *        when nothing has finished and when the only terminal result failed.
 *        A failed phase followed by a retry's "started" event has NO
 *        terminal result yet, but the gateway gives the page nothing to
 *        distinguish that from "0% success."
 *
 * These tests encode the honest contract (per-section availability; a
 * terminal-result denominator) and are expected to FAIL against the
 * reviewed code at 8495f87a, before any fix.
 */

import { describe, it, expect, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// Mirrors telemetry-extensions.test.ts: avoid real Sentry/StreamHub side
// effects. BaseFacade (via KernelFacade/JobFacade) also emits through
// pipelineTelemetry, which publishes to streamHub and breadcrumbs to Sentry,
// so these mocks apply to the status-route test below too.
vi.mock("../sentry.js", () => ({
  initSentry: vi.fn(),
  isSentryEnabled: vi.fn().mockReturnValue(false),
  Sentry: {
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
  },
}));

vi.mock("../sse/stream-hub.js", () => ({
  streamHub: {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  },
}));

import { statusRoutes } from "../routes/status.js";
import { PipelineTelemetryService } from "../telemetry.js";

// ---------------------------------------------------------------------------
// F1 — /api/telemetry/system per-section availability
// ---------------------------------------------------------------------------

describe("GET /api/telemetry/system — per-section availability (astra 408b F1)", () => {
  it("reports which sections failed instead of masking every failure as an empty list", async () => {
    // Deliberately do NOT call initStore(): in this test file's isolated
    // module registry, getRepos() throws "Store not initialised". The
    // kernel/job facades catch that (BaseFacade.execute: Result<T>, never
    // throws) and return {success:false}; the route's own repos try/catch
    // catches it for evidence/registrations/capabilities. This is the real
    // failure mode astra's repro describes (kernelFacade.list() -> success:false),
    // reached here without mocking any business logic.
    const app: FastifyInstance = Fastify({ logger: false });
    await app.register(statusRoutes);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/telemetry/system" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { db: Record<string, unknown>; unavailable?: unknown };

    // Today: every collection still defaults to an empty array — indistinguishable
    // from "the report lists no kernels."
    expect(body.db.kernels).toEqual([]);

    // Honest contract: the handler must additively report which sections it
    // could not read, so the page can render "couldn't be read" rather than
    // a confident "lists no kernels."
    expect(Array.isArray(body.unavailable)).toBe(true);
    expect(body.unavailable).toContain("kernels");
    expect(body.unavailable).toContain("jobs");
    expect(body.unavailable).toContain("evidence");
    expect(body.unavailable).toContain("registrations");
    expect(body.unavailable).toContain("capabilities");

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// F2 — PipelineTelemetryService.getStats() terminal-result denominator
// ---------------------------------------------------------------------------

describe("PipelineTelemetryService.getStats() — terminalCount (astra 408b F2)", () => {
  it("a failed phase followed by a retry's 'started' event has no terminal result yet", () => {
    const service = new PipelineTelemetryService();
    // astra's cheapest reproduction: record failed, then started, for one job.
    service.emit("job-retry-1", "job_started", "failed");
    service.emit("job-retry-1", "job_started", "started");

    const stats = service.getStats() as unknown as { terminalCount?: number; successRate: number };

    // Today: successRate is 0 (no completed/failed LAST event — the retry's
    // "started" is last), and nothing in the payload says there were zero
    // terminal results rather than one failed one. The gateway must return
    // the denominator itself so the page never has to guess from byPhase.
    expect(stats.successRate).toBe(0);
    expect(stats.terminalCount).toBe(0);
  });
});
