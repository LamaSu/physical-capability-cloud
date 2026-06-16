/**
 * funnel-tracker.test.ts — observability piece 4.
 *
 * Tests cover:
 *   • detectStage: every stage rule + non-2xx + wrong-method + unknown route.
 *   • funnelEnabled: reads PCC_FUNNEL_ENABLED.
 *   • Plugin end-to-end: a 2xx on a checkpoint route records the stage once
 *     (dedup), identifies on provision, captures per stage, and is read back
 *     by getCohortFunnel / getFunnelForTraceId.
 *   • A failed (5xx) response records nothing.
 *
 * Side-effect deps (auditService, posthog-service) are mocked — we test what
 * the tracker MEANS, not file IO. Mock state via vi.hoisted so the factories
 * are hoist-safe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { traceIdPlugin, TRACE_ID_HEADER } from "../middleware/trace-id.js";

const h = vi.hoisted(() => {
  const logged: Array<Record<string, unknown>> = [];
  return {
    logged,
    identifySpy: vi.fn(),
    trackSpy: vi.fn(),
  };
});

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: (e: Record<string, unknown>) => {
      h.logged.push({ ...e });
    },
    query: (opts: { eventType?: string }) =>
      h.logged.filter((r) => !opts?.eventType || r.eventType === opts.eventType),
    stats: () => [],
  },
}));

vi.mock("../services/posthog-service.js", () => ({
  identifyAgent: (...a: unknown[]) => h.identifySpy(...a),
  trackServerEvent: (...a: unknown[]) => h.trackSpy(...a),
}));

// Import AFTER the mocks are declared.
import {
  detectStage,
  funnelEnabled,
  funnelTrackerPlugin,
  getCohortFunnel,
  getFunnelForTraceId,
  __resetFunnelState,
  ONBOARDING_STAGES,
} from "../services/funnel-tracker.js";

const TRACE = "tr_0123456789abcdef";

describe("detectStage", () => {
  it("maps each onboarding checkpoint on 2xx", () => {
    expect(detectStage("POST", "/api/auth/provision", 201)).toBe("provision");
    expect(detectStage("POST", "/api/onboard/redeem", 200)).toBe("provision");
    expect(detectStage("GET", "/api/capabilities/types", 200)).toBe("discover");
    expect(detectStage("GET", "/api/capabilities/search", 200)).toBe("discover");
    expect(detectStage("POST", "/api/build/contract", 200)).toBe("build");
    expect(detectStage("POST", "/api/escrow/fund", 200)).toBe("fund");
    expect(detectStage("POST", "/api/fiat-ramp/onramp/session", 200)).toBe("fund");
    expect(detectStage("POST", "/api/jobs/submit", 200)).toBe("submit");
    expect(detectStage("POST", "/api/escrow/esc-123/release", 200)).toBe("settle");
  });

  it("returns null for non-2xx, wrong method, or unknown route", () => {
    expect(detectStage("POST", "/api/auth/provision", 500)).toBeNull();
    expect(detectStage("POST", "/api/auth/provision", 401)).toBeNull();
    expect(detectStage("GET", "/api/build/contract", 200)).toBeNull(); // wrong method
    expect(detectStage("POST", "/api/health", 200)).toBeNull(); // not a checkpoint
    expect(detectStage("GET", "/api/escrow/esc-123/release", 200)).toBeNull();
  });
});

describe("funnelEnabled", () => {
  afterEach(() => {
    delete process.env.PCC_FUNNEL_ENABLED;
  });
  it("is true only for exactly 'true'", () => {
    process.env.PCC_FUNNEL_ENABLED = "true";
    expect(funnelEnabled()).toBe(true);
    process.env.PCC_FUNNEL_ENABLED = "1";
    expect(funnelEnabled()).toBe(false);
    delete process.env.PCC_FUNNEL_ENABLED;
    expect(funnelEnabled()).toBe(false);
  });
});

describe("funnelTrackerPlugin (end-to-end)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    h.logged.length = 0;
    h.identifySpy.mockClear();
    h.trackSpy.mockClear();
    __resetFunnelState();
    process.env.PCC_FUNNEL_ENABLED = "true";

    app = Fastify({ logger: false });
    await app.register(traceIdPlugin);
    await app.register(funnelTrackerPlugin);
    // Dummy checkpoint routes (the plugin's onResponse hook is non-encapsulated
    // so it fires for these sibling routes).
    app.post("/api/auth/provision", async () => ({ ok: true }));
    app.get("/api/capabilities/types", async () => ({ types: [] }));
    app.post("/api/build/contract", async (_req, reply) => reply.status(500).send({ error: "boom" }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.PCC_FUNNEL_ENABLED;
  });

  it("records a stage once, identifies on provision, captures per stage", async () => {
    const headers = { [TRACE_ID_HEADER]: TRACE };

    await app.inject({ method: "POST", url: "/api/auth/provision", headers });
    await app.inject({ method: "POST", url: "/api/auth/provision", headers }); // dup
    await app.inject({ method: "GET", url: "/api/capabilities/types", headers });

    const funnelRows = h.logged.filter((r) => r.eventType === "agent.funnel");
    // provision (deduped to 1) + discover = 2 rows
    expect(funnelRows).toHaveLength(2);
    expect(funnelRows.map((r) => r.action).sort()).toEqual(["discover", "provision"]);

    // identify called exactly once (on provision)
    expect(h.identifySpy).toHaveBeenCalledTimes(1);
    expect(h.identifySpy).toHaveBeenCalledWith(TRACE, expect.any(Object));

    // capture called once per recorded stage
    expect(h.trackSpy).toHaveBeenCalledWith("onboarding_provision", expect.any(Object), TRACE);
    expect(h.trackSpy).toHaveBeenCalledWith("onboarding_discover", expect.any(Object), TRACE);
  });

  it("records nothing for a 5xx response", async () => {
    await app.inject({
      method: "POST",
      url: "/api/build/contract",
      headers: { [TRACE_ID_HEADER]: TRACE },
    });
    expect(h.logged.filter((r) => r.eventType === "agent.funnel")).toHaveLength(0);
  });

  it("reads back via getCohortFunnel and getFunnelForTraceId", async () => {
    const headers = { [TRACE_ID_HEADER]: TRACE };
    await app.inject({ method: "POST", url: "/api/auth/provision", headers });
    await app.inject({ method: "GET", url: "/api/capabilities/types", headers });

    const cohort = getCohortFunnel();
    const provision = cohort.find((s) => s.stage === "provision")!;
    const discover = cohort.find((s) => s.stage === "discover")!;
    const settle = cohort.find((s) => s.stage === "settle")!;
    expect(provision.count).toBe(1);
    expect(discover.count).toBe(1);
    expect(discover.conversion).toBe(1); // 1/1
    expect(settle.count).toBe(0);
    expect(cohort.map((s) => s.stage)).toEqual(ONBOARDING_STAGES);

    const journey = getFunnelForTraceId(TRACE);
    expect(journey.map((s) => s.stage)).toEqual(["provision", "discover"]);
  });
});
