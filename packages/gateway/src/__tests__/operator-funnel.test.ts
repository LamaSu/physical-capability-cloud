/**
 * operator-funnel.test.ts — ADK track item 4 (operator-onboarding funnel).
 *
 * Tests cover:
 *   • recordOperatorStage: flag gate, kernelId validation (format + the
 *     "kernel_dev_001" dev placeholder), once-per-(kernelId,stage) dedup,
 *     the bounded-map eviction path, and each sink (audit/posthog/otel,
 *     all best-effort).
 *   • getOperatorFunnel / getOperatorStagesForKernel read APIs.
 *   • isRealAdapterHealthy — the extracted adapter_ready gating function.
 *   • Call sites via Fastify inject: kernel_created, device_registered,
 *     capability_published, test_job_passed (+ its three exclusions:
 *     deviceless self-attest, omitted/defaulted kernelId, non-completed
 *     status), adapter_ready (mock + generic-http exclusion, a real-adapter
 *     inclusion, and an unresolvable-device exclusion).
 *   • Admin view: 404 flag-off, 403 no-allowlist-in-production, 200 for an
 *     allow-listed operator.
 *
 * Side-effect deps (audit-service, posthog-service) are mocked exactly like
 * funnel-tracker.test.ts. kernel-service is mocked exactly like
 * setup.test.ts (real MockAdapter background timers/fire-and-forget
 * execution are a known source of test-teardown flakiness in this suite) —
 * this also makes the adapter_ready health outcome deterministic and lets
 * us exercise the "real adapter, healthy" recording path in-process, since
 * our new code's gating decision is driven by the DB device row (real),
 * with only the boolean health *result* coming from the mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { KernelConfig } from "@pcc/kernel";

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
    // Mirrors the real service: returns whether the row was written.
    log: (e: Record<string, unknown>) => {
      h.logged.push({ ...e });
      return true;
    },
    // Mirrors AuditService.logOnce: atomic check-then-insert over h.logged,
    // keyed on (eventType, resourceType, resourceId, action) — #469 round 2 R4a.
    logOnce: (e: Record<string, unknown>) => {
      const exists = h.logged.some(
        (r) =>
          r.eventType === e.eventType &&
          r.resourceType === e.resourceType &&
          r.resourceId === e.resourceId &&
          r.action === e.action,
      );
      if (exists) return "exists";
      h.logged.push({ ...e });
      return "written";
    },
    query: (opts: { eventType?: string; resourceType?: string; resourceId?: string }) =>
      h.logged.filter(
        (r) =>
          (!opts?.eventType || r.eventType === opts.eventType) &&
          (!opts?.resourceType || r.resourceType === opts.resourceType) &&
          (!opts?.resourceId || r.resourceId === opts.resourceId),
      ),
    stats: () => [],
  },
}));

vi.mock("../services/posthog-service.js", () => ({
  identifyAgent: (...a: unknown[]) => h.identifySpy(...a),
  trackServerEvent: (...a: unknown[]) => h.trackSpy(...a),
}));

// Mirrors setup.test.ts's kernel-service mock: avoids real MockAdapter
// background timers, and makes submitJob/getJobStatus/checkDeviceHealth
// outcomes controllable per-test.
vi.mock("../services/kernel-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/kernel-service.js")>();

  let _mockReady = false;
  const mockService = {
    submitJob: vi
      .fn()
      .mockResolvedValue({ jobId: "unused", deviceId: "dev-of-machine", status: "accepted" }),
    getJobStatus: vi.fn().mockResolvedValue({ status: "completed", progress: 100 }),
    listDevices: vi.fn().mockResolvedValue([]),
    checkDeviceHealth: vi.fn().mockResolvedValue({ healthy: true, details: "idle" }),
    refreshDeviceFromDb: vi.fn().mockReturnValue({ installed: true }),
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

// Import AFTER the mocks are declared.
import {
  recordOperatorStage,
  getOperatorFunnel,
  getOperatorStagesForKernel,
  __resetOperatorFunnelState,
  OPERATOR_STAGES,
  OPERATOR_FUNNEL_AUDIT_EVENT,
} from "../services/funnel-tracker.js";
import { isRealAdapterHealthy } from "../facades/job.facade.js";
import { kernelRoutes } from "../routes/kernels.js";
import { setupRoutes } from "../routes/setup.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { adminObservabilityRoutes } from "../routes/admin-observability.js";
import { initStore, closeStore } from "../db.js";
import { initKernelService, resetKernelService, _mockService } from "../services/kernel-service.js";

function opFunnelRows(): Array<Record<string, unknown>> {
  return h.logged.filter((r) => r.eventType === OPERATOR_FUNNEL_AUDIT_EVENT);
}

// ── Env isolation ────────────────────────────────────────────────────────
// This file mutates PCC_FUNNEL_ENABLED / PCC_OBSERVABILITY_ADMINS / NODE_ENV
// / PCC_OBSERVABILITY_DEV_OPEN across tests. Capture + restore exactly,
// rather than deleting, so we never leak state into sibling test files that
// may share this worker thread's process.env.
const ORIGINAL_ENV = {
  PCC_FUNNEL_ENABLED: process.env.PCC_FUNNEL_ENABLED,
  PCC_OBSERVABILITY_ADMINS: process.env.PCC_OBSERVABILITY_ADMINS,
  NODE_ENV: process.env.NODE_ENV,
  PCC_OBSERVABILITY_DEV_OPEN: process.env.PCC_OBSERVABILITY_DEV_OPEN,
};
function restoreEnv(): void {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  h.logged.length = 0;
  h.identifySpy.mockClear();
  h.trackSpy.mockClear();
  __resetOperatorFunnelState();
  process.env.PCC_FUNNEL_ENABLED = "true";
});

afterEach(() => {
  restoreEnv();
});

// ── Unit: recordOperatorStage ────────────────────────────────────────────

describe("recordOperatorStage", () => {
  it("is a no-op when the flag is off", () => {
    delete process.env.PCC_FUNNEL_ENABLED;
    expect(recordOperatorStage("kernel-abc", "kernel_created")).toBe(false);
    expect(opFunnelRows()).toHaveLength(0);
    expect(h.trackSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-string kernelId", () => {
    expect(recordOperatorStage(undefined, "kernel_created")).toBe(false);
    expect(recordOperatorStage(123, "kernel_created")).toBe(false);
    expect(recordOperatorStage(null, "kernel_created")).toBe(false);
    expect(recordOperatorStage({ id: "x" }, "kernel_created")).toBe(false);
    expect(opFunnelRows()).toHaveLength(0);
  });

  it("rejects a kernelId with characters outside the documented charset, or too long", () => {
    expect(recordOperatorStage("kernel with spaces", "kernel_created")).toBe(false);
    expect(recordOperatorStage("kernel/../etc", "kernel_created")).toBe(false);
    expect(recordOperatorStage("a".repeat(201), "kernel_created")).toBe(false);
    expect(recordOperatorStage("", "kernel_created")).toBe(false);
    expect(opFunnelRows()).toHaveLength(0);
  });

  it("accepts the documented kernelId charset [A-Za-z0-9:._-]", () => {
    expect(recordOperatorStage("kernel:Foo.bar_baz-9", "kernel_created")).toBe(true);
  });

  it("rejects the kernel_dev_001 dev placeholder", () => {
    expect(recordOperatorStage("kernel_dev_001", "kernel_created")).toBe(false);
    expect(opFunnelRows()).toHaveLength(0);
  });

  it("records once per (kernelId, stage) — the second call is a dedup no-op", () => {
    expect(recordOperatorStage("kernel-dup", "kernel_created")).toBe(true);
    expect(recordOperatorStage("kernel-dup", "kernel_created")).toBe(false);
    expect(opFunnelRows()).toHaveLength(1);
  });

  it("the same kernelId can independently record a different stage", () => {
    expect(recordOperatorStage("kernel-multi", "kernel_created")).toBe(true);
    expect(recordOperatorStage("kernel-multi", "device_registered")).toBe(true);
    expect(opFunnelRows()).toHaveLength(2);
  });

  it("many distinct kernels don't cross-contaminate dedup state", () => {
    for (let i = 0; i < 500; i++) {
      recordOperatorStage(`kernel-bulk-${i}`, "kernel_created");
    }
    // Still deduped for an early kernel...
    expect(recordOperatorStage("kernel-bulk-0", "kernel_created")).toBe(false);
    // ...but a different stage on any kernel still records independently.
    expect(recordOperatorStage("kernel-bulk-499", "device_registered")).toBe(true);
    expect(opFunnelRows().filter((r) => r.action === "kernel_created")).toHaveLength(500);
  });

  it("evicts the oldest kernel once MAX_TRACKED_KERNELS (5000) is exceeded, without writing a duplicate row", () => {
    // Fill exactly to the bound — all still independently deduped.
    for (let i = 0; i < 5000; i++) {
      recordOperatorStage(`kernel-evict-${i}`, "kernel_created");
    }
    // Bound not yet exceeded: the very first kernel is still tracked, so
    // re-recording the same stage is still a dedup no-op.
    expect(recordOperatorStage("kernel-evict-0", "kernel_created")).toBe(false);

    // One more kernel pushes the map past MAX_TRACKED_KERNELS, evicting the
    // OLDEST tracked kernel (kernel-evict-0, the first ever inserted).
    expect(recordOperatorStage("kernel-evict-5000", "kernel_created")).toBe(true);

    // kernel-evict-0's in-memory entry is gone, but its audit row is not, so
    // recording the same (kernelId, stage) again writes no duplicate row
    // (#469 round 1: durable idempotency across eviction).
    expect(recordOperatorStage("kernel-evict-0", "kernel_created")).toBe(false);
    expect(opFunnelRows().filter((r) => r.resourceId === "kernel-evict-0")).toHaveLength(1);
  });

  it("calls the audit sink with the documented eventType/resourceId/action/metadata shape", () => {
    recordOperatorStage("kernel-audit-1", "capability_published", {
      operatorId: "op-1",
      capabilityId: "cap-xyz",
    });
    const rows = opFunnelRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: OPERATOR_FUNNEL_AUDIT_EVENT,
      actor: "op-1",
      resourceType: "kernel",
      resourceId: "kernel-audit-1",
      action: "capability_published",
      metadata: {
        stage: "capability_published",
        kernel_id: "kernel-audit-1",
        device_id: null,
        capability_id: "cap-xyz",
        job_id: null,
      },
    });
  });

  it("defaults actor to 'unknown' when no operatorId is given", () => {
    recordOperatorStage("kernel-audit-2", "kernel_created");
    expect(opFunnelRows()[0].actor).toBe("unknown");
  });

  it("calls trackServerEvent as operator_<stage> with distinctId=kernelId", () => {
    recordOperatorStage("kernel-ph-1", "device_registered", { deviceId: "dev-1" });
    expect(h.trackSpy).toHaveBeenCalledWith(
      "operator_device_registered",
      expect.objectContaining({ kernel_id: "kernel-ph-1", device_id: "dev-1" }),
      "kernel-ph-1",
    );
  });

  it("never throws even if a sink throws (best-effort)", () => {
    h.trackSpy.mockImplementationOnce(() => {
      throw new Error("posthog down");
    });
    expect(() => recordOperatorStage("kernel-safe", "kernel_created")).not.toThrow();
    // The audit row still landed — one sink failing doesn't block the others.
    expect(opFunnelRows()).toHaveLength(1);
  });
});

// ── Unit: getOperatorFunnel / getOperatorStagesForKernel ─────────────────

describe("getOperatorFunnel", () => {
  it("counts distinct kernels per stage, in OPERATOR_STAGES order, with conversion off kernel_created", () => {
    recordOperatorStage("kernel-a", "kernel_created");
    recordOperatorStage("kernel-b", "kernel_created");
    recordOperatorStage("kernel-a", "device_registered");

    const funnel = getOperatorFunnel();
    expect(funnel.map((f) => f.stage)).toEqual(OPERATOR_STAGES);

    const created = funnel.find((f) => f.stage === "kernel_created")!;
    const registered = funnel.find((f) => f.stage === "device_registered")!;
    const adapterReady = funnel.find((f) => f.stage === "adapter_ready")!;
    expect(created.kernels).toBe(2);
    expect(registered.kernels).toBe(1);
    expect(registered.conversion).toBe(0.5);
    expect(adapterReady.kernels).toBe(0);
  });

  it("conversion is null when there are no kernel_created rows", () => {
    recordOperatorStage("kernel-x", "device_registered");
    const registered = getOperatorFunnel().find((f) => f.stage === "device_registered")!;
    expect(registered.conversion).toBeNull();
  });
});

describe("getOperatorStagesForKernel", () => {
  it("returns recorded stages in OPERATOR_STAGES order regardless of recording order", () => {
    recordOperatorStage("kernel-order", "capability_published");
    recordOperatorStage("kernel-order", "kernel_created");
    recordOperatorStage("kernel-order", "device_registered");

    expect(getOperatorStagesForKernel("kernel-order")).toEqual([
      "kernel_created",
      "device_registered",
      "capability_published",
    ]);
  });

  it("returns an empty array for a kernel with no recorded stages", () => {
    expect(getOperatorStagesForKernel("kernel-none")).toEqual([]);
  });
});

// ── Unit: isRealAdapterHealthy gating function ───────────────────────────

describe("isRealAdapterHealthy", () => {
  it("is false when not healthy, regardless of adapter type", () => {
    expect(isRealAdapterHealthy(false, "octoprint")).toBe(false);
  });
  it("is false for the mock adapter", () => {
    expect(isRealAdapterHealthy(true, "mock")).toBe(false);
  });
  it("is false for the generic-http placeholder adapter", () => {
    expect(isRealAdapterHealthy(true, "generic-http")).toBe(false);
  });
  it("is false for a null/undefined/empty adapterType", () => {
    expect(isRealAdapterHealthy(true, null)).toBe(false);
    expect(isRealAdapterHealthy(true, undefined)).toBe(false);
    expect(isRealAdapterHealthy(true, "")).toBe(false);
  });
  it("is true for a real adapter type that is healthy", () => {
    for (const adapterType of ["octoprint", "modbus", "opcua", "sila", "ipp"]) {
      expect(isRealAdapterHealthy(true, adapterType)).toBe(true);
    }
  });
});

// ── Call sites: route-level integration via Fastify inject ───────────────

const mockConfig = { kernelId: "kernel-nyc", mockMode: true, devices: [] } as KernelConfig;
const REAL_ADDR = `0x${"a".repeat(40)}`;

async function buildFullApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  resetKernelService();
  initKernelService(mockConfig);
  // Fresh, known-good defaults each test — a previous test's *Once override
  // is self-consuming, but guard against any persistent .mockResolvedValue.
  _mockService.submitJob.mockResolvedValue({
    jobId: "unused",
    deviceId: "dev-of-machine",
    status: "accepted",
  });
  _mockService.getJobStatus.mockResolvedValue({ status: "completed", progress: 100 });
  _mockService.checkDeviceHealth.mockResolvedValue({ healthy: true, details: "idle" });

  const app = Fastify({ logger: false });
  // An authenticated caller, as apiGate sets it in production. Tests that need an
  // anonymous caller clear it with the x-test-anonymous header.
  app.decorateRequest("operatorId", null);
  app.addHook("onRequest", async (req) => {
    if (req.headers["x-test-anonymous"] !== "1") (req as unknown as { operatorId: string }).operatorId = "op-test";
  });
  await app.register(kernelRoutes);
  await app.register(setupRoutes);
  await app.register(capabilityRoutes);
  await app.register(jobSubmitRoutes);
  await app.ready();
  return app;
}

describe("operator funnel call sites (Fastify inject)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildFullApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetKernelService();
  });

  // ── kernel_created ───────────────────────────────────────────────────

  it("POST /api/kernels records kernel_created on the created kernel's id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: { id: "kernel-of-1", name: "OF Kernel 1", operatorAddress: REAL_ADDR },
    });
    expect(res.statusCode).toBe(201);
    const rows = opFunnelRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resourceId: "kernel-of-1", action: "kernel_created" });
  });

  it("POST /api/kernels does NOT re-record kernel_created on a heartbeat update (created:false)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: { id: "kernel-of-2", name: "OF Kernel 2", operatorAddress: REAL_ADDR },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: { id: "kernel-of-2", name: "OF Kernel 2 renamed", operatorAddress: REAL_ADDR },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(opFunnelRows().filter((r) => r.resourceId === "kernel-of-2")).toHaveLength(1);
  });

  // ── device_registered ────────────────────────────────────────────────

  it("POST /api/setup/register-device records device_registered", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/register-device",
      payload: {
        kernelId: "kernel-nyc",
        deviceId: "dev-of-reg-1",
        type: "machine",
        model: "Test",
        adapterType: "mock",
      },
    });
    expect(res.statusCode).toBe(201);
    const rows = opFunnelRows().filter((r) => r.action === "device_registered");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resourceId: "kernel-nyc" });
    expect((rows[0].metadata as Record<string, unknown>).device_id).toBe("dev-of-reg-1");
  });

  it("POST /api/setup/register-device dedupes device_registered across a create+update pair", async () => {
    const payload = {
      kernelId: "kernel-nyc",
      deviceId: "dev-of-reg-2",
      type: "machine",
      adapterType: "mock",
    };
    await app.inject({ method: "POST", url: "/api/setup/register-device", payload });
    const second = await app.inject({ method: "POST", url: "/api/setup/register-device", payload });
    expect(second.json().action).toBe("updated");
    const rows = opFunnelRows().filter(
      (r) => r.action === "device_registered" && r.resourceId === "kernel-nyc",
    );
    expect(rows).toHaveLength(1);
  });

  // ── capability_published ─────────────────────────────────────────────

  it("POST /api/capabilities records capability_published with the created capability's id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      payload: { kernelId: "kernel-nyc", type: "pizza.order.opfunnel1", name: "Pizza" },
    });
    expect(res.statusCode).toBe(201);
    const capId = res.json().capability.id;
    const rows = opFunnelRows().filter((r) => r.action === "capability_published");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resourceId: "kernel-nyc" });
    expect((rows[0].metadata as Record<string, unknown>).capability_id).toBe(capId);
  });

  it("POST /api/capabilities does not double-record on an update (created:false)", async () => {
    const payload = {
      kernelId: "kernel-nyc",
      id: "cap-of-dup",
      type: "pizza.order.opfunnel2",
      name: "Pizza",
    };
    await app.inject({ method: "POST", url: "/api/capabilities", payload });
    const second = await app.inject({ method: "POST", url: "/api/capabilities", payload });
    expect(second.json().created).toBe(false);
    const rows = opFunnelRows().filter(
      (r) => r.action === "capability_published" && r.resourceId === "kernel-nyc",
    );
    expect(rows).toHaveLength(1);
  });

  // ── test_job_passed ──────────────────────────────────────────────────

  describe("POST /api/setup/test-job", () => {
    it("records test_job_passed for a completed device run with an explicit kernelId", async () => {
      await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: { kernelId: "kernel-nyc", deviceId: "dev-of-machine", type: "machine", model: "Real Printer", adapterType: "octoprint", adapterConfig: { url: "http://192.168.1.50:5000", apiKey: "k" } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-job",
        payload: { kernelId: "kernel-nyc", deviceId: "dev-of-machine" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("completed");
      expect(body.deviceId).toBe("dev-of-machine");

      const rows = opFunnelRows().filter((r) => r.action === "test_job_passed");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ resourceId: "kernel-nyc" });
      expect((rows[0].metadata as Record<string, unknown>).job_id).toBe(body.jobId);
      expect((rows[0].metadata as Record<string, unknown>).device_id).toBe("dev-of-machine");
    });

    it("does NOT record for the deviceless self-attest branch", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-job",
        // No deviceId + a kernel with zero registered devices => deviceless
        // self-attest branch, which returns before the recorder can run.
        payload: { kernelId: "kernel-la" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.deviceId).toBeNull();
      expect(body.evidencePath).toBe("self-attested");
      expect(opFunnelRows().filter((r) => r.action === "test_job_passed")).toHaveLength(0);
    });

    it("does NOT record when kernelId is omitted (falls back to kernel_dev_001)", async () => {
      // Explicit deviceId so this exercises the REAL device path (not the
      // deviceless branch) — isolating the "omitted kernelId" exclusion.
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-job",
        payload: { deviceId: "dev-of-machine" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("completed");
      expect(opFunnelRows().filter((r) => r.action === "test_job_passed")).toHaveLength(0);
    });

    it("does NOT record for a non-completed final status", async () => {
      // Two consecutive "unknown" polls make the route give up and return
      // early with status "unknown" (never "completed").
      _mockService.getJobStatus.mockResolvedValue({ status: "unknown", progress: 0 });
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/test-job",
        payload: { kernelId: "kernel-nyc", deviceId: "dev-of-machine" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("unknown");
      expect(opFunnelRows().filter((r) => r.action === "test_job_passed")).toHaveLength(0);
    });
  });

  // ── adapter_ready ────────────────────────────────────────────────────

  describe("POST /api/devices/:deviceId/health", () => {
    it("does NOT record adapter_ready for a healthy MOCK adapter", async () => {
      await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-nyc",
          deviceId: "dev-of-mock",
          type: "machine",
          model: "Mock Printer",
          adapterType: "mock",
        },
      });

      const res = await app.inject({ method: "POST", url: "/api/devices/dev-of-mock/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json().healthy).toBe(true);
      expect(opFunnelRows().filter((r) => r.action === "adapter_ready")).toHaveLength(0);
    });

    it("does NOT record adapter_ready for a healthy generic-http adapter", async () => {
      await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-nyc",
          deviceId: "dev-of-generic",
          type: "machine",
          model: "Generic",
          adapterType: "generic-http",
        },
      });

      const res = await app.inject({ method: "POST", url: "/api/devices/dev-of-generic/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json().healthy).toBe(true);
      expect(opFunnelRows().filter((r) => r.action === "adapter_ready")).toHaveLength(0);
    });

    it("DOES record adapter_ready for a healthy REAL adapter (octoprint)", async () => {
      await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-nyc",
          deviceId: "dev-of-octoprint",
          type: "machine",
          model: "Real Printer",
          adapterType: "octoprint",
          adapterConfig: { url: "http://192.168.1.50:5000", apiKey: "test-key" },
        },
      });

      const res = await app.inject({ method: "POST", url: "/api/devices/dev-of-octoprint/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json().healthy).toBe(true);

      const rows = opFunnelRows().filter((r) => r.action === "adapter_ready");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ resourceId: "kernel-nyc" });
      expect((rows[0].metadata as Record<string, unknown>).device_id).toBe("dev-of-octoprint");
    });

    it("does NOT record adapter_ready when the device can't be resolved (no DB row)", async () => {
      // Never registered via /api/setup/register-device or /api/devices/register,
      // so repos.kernels.findDeviceById returns undefined — unattributable.
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/dev-never-registered/health",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().healthy).toBe(true); // the mocked KernelService says healthy...
      // ...but with no resolvable kernelId, nothing is recorded.
      expect(opFunnelRows().filter((r) => r.action === "adapter_ready")).toHaveLength(0);
    });

    it("does NOT record adapter_ready when the health check itself is unhealthy", async () => {
      await app.inject({
        method: "POST",
        url: "/api/setup/register-device",
        payload: {
          kernelId: "kernel-nyc",
          deviceId: "dev-of-unhealthy",
          type: "machine",
          model: "Flaky Printer",
          adapterType: "octoprint",
        },
      });
      _mockService.checkDeviceHealth.mockResolvedValueOnce({ healthy: false, details: "timeout" });

      const res = await app.inject({ method: "POST", url: "/api/devices/dev-of-unhealthy/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json().healthy).toBe(false);
      expect(opFunnelRows().filter((r) => r.action === "adapter_ready")).toHaveLength(0);
    });
  });
});

// ── Admin view: GET /api/admin/observability/operator-funnel ────────────

async function buildAdminApp(operatorId: string | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  if (operatorId !== null) {
    app.addHook("onRequest", async (req) => {
      (req as unknown as { operatorId: string }).operatorId = operatorId;
    });
  }
  await app.register(adminObservabilityRoutes);
  await app.ready();
  return app;
}

describe("GET /api/admin/observability/operator-funnel", () => {
  it("404s when PCC_FUNNEL_ENABLED is not 'true'", async () => {
    delete process.env.PCC_FUNNEL_ENABLED;
    const app = await buildAdminApp(null);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/observability/operator-funnel",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_enabled");
    } finally {
      await app.close();
    }
  });

  it("403s without an allowlist in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.PCC_OBSERVABILITY_ADMINS;
    const app = await buildAdminApp(null);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/observability/operator-funnel",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("forbidden");
    } finally {
      await app.close();
    }
  });

  it("403s for an operator NOT in PCC_OBSERVABILITY_ADMINS", async () => {
    process.env.PCC_OBSERVABILITY_ADMINS = "op-admin-1";
    const app = await buildAdminApp("someone-else");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/observability/operator-funnel",
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("200s with the operator in PCC_OBSERVABILITY_ADMINS, returning the funnel shape", async () => {
    process.env.PCC_OBSERVABILITY_ADMINS = "op-admin-1";
    recordOperatorStage("kernel-admin-view", "kernel_created", { operatorId: "op-admin-1" });

    const app = await buildAdminApp("op-admin-1");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/observability/operator-funnel",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.source).toBe("audit_log");
      expect(Array.isArray(body.funnel)).toBe(true);
      expect(body.funnel.map((f: { stage: string }) => f.stage)).toEqual(OPERATOR_STAGES);
      const created = body.funnel.find((f: { stage: string }) => f.stage === "kernel_created");
      expect(created.kernels).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });
});

// ── #469 round-1 regressions ──────────────────────────────────────────────

const OCTO_DEVICE = { type: "machine", model: "Real Printer", adapterType: "octoprint", adapterConfig: { url: "http://192.168.1.50:5000", apiKey: "k" } };

describe("#469 round-1 fixes", () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildFullApp(); });
  afterEach(async () => { await app.close(); closeStore(); resetKernelService(); });

  async function testJob(kernelId: string, deviceId: string, extraHeaders: Record<string, string> = {}) {
    _mockService.submitJob.mockResolvedValue({ jobId: "j", deviceId, status: "accepted" });
    return app.inject({ method: "POST", url: "/api/setup/test-job", headers: extraHeaders, payload: { kernelId, deviceId } });
  }
  const passed = () => opFunnelRows().filter((r) => r.action === "test_job_passed");

  it("F1a: a completed test job on a MOCK device does not count", async () => {
    await app.inject({ method: "POST", url: "/api/setup/register-device", payload: { kernelId: "kernel-nyc", deviceId: "dev-mock-tj", type: "machine", model: "Mock", adapterType: "mock" } });
    await testJob("kernel-nyc", "dev-mock-tj");
    expect(passed()).toHaveLength(0);
  });

  it("F1b: a test job never credits a device of kernel-nyc to the caller-supplied kernel-la", async () => {
    await app.inject({ method: "POST", url: "/api/setup/register-device", payload: { kernelId: "kernel-nyc", deviceId: "dev-a", ...OCTO_DEVICE } });
    await testJob("kernel-la", "dev-a");
    expect(passed()).toHaveLength(0);
  });

  it("F1c: a test job never credits a kernel that does not exist", async () => {
    await app.inject({ method: "POST", url: "/api/setup/register-device", payload: { kernelId: "kernel-nyc", deviceId: "dev-b", ...OCTO_DEVICE } });
    await testJob("kernel-does-not-exist", "dev-b");
    expect(passed()).toHaveLength(0);
  });

  it("F1: a real device of the named kernel still counts, attributed to the operator", async () => {
    await app.inject({ method: "POST", url: "/api/setup/register-device", payload: { kernelId: "kernel-nyc", deviceId: "dev-ok", ...OCTO_DEVICE } });
    await testJob("kernel-nyc", "dev-ok");
    expect(passed()).toHaveLength(1);
    expect(passed()[0]).toMatchObject({ resourceId: "kernel-nyc", actor: "op-test" });
  });

  it("F2: an unauthenticated caller's test job or health check records nothing; an authenticated one is attributed", async () => {
    await app.inject({ method: "POST", url: "/api/setup/register-device", payload: { kernelId: "kernel-nyc", deviceId: "dev-anon", ...OCTO_DEVICE } });
    await testJob("kernel-nyc", "dev-anon", { "x-test-anonymous": "1" });
    await app.inject({ method: "POST", url: "/api/devices/dev-anon/health", headers: { "x-test-anonymous": "1" } });
    expect(passed()).toHaveLength(0);
    expect(opFunnelRows().filter((r) => r.action === "adapter_ready")).toHaveLength(0);
    await app.inject({ method: "POST", url: "/api/devices/dev-anon/health" });
    const ready = opFunnelRows().filter((r) => r.action === "adapter_ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ resourceId: "kernel-nyc", actor: "op-test" });
  });

  it("F3: a device moved to another kernel during the health check is attributed to neither", async () => {
    await app.inject({ method: "POST", url: "/api/setup/register-device", payload: { kernelId: "kernel-nyc", deviceId: "dev-t", ...OCTO_DEVICE } });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    _mockService.checkDeviceHealth.mockImplementationOnce(async () => { await gate; return { healthy: true, details: "idle" }; });
    const pending = app.inject({ method: "POST", url: "/api/devices/dev-t/health" });
    await new Promise((r) => setTimeout(r, 20));
    await app.inject({ method: "POST", url: "/api/setup/register-device", payload: { kernelId: "kernel-la", deviceId: "dev-t", ...OCTO_DEVICE } });
    release();
    expect((await pending).statusCode).toBe(200);
    expect(opFunnelRows().filter((r) => r.action === "adapter_ready")).toHaveLength(0);
  });
});

describe("#469 round-1 fix F4: durable recording", () => {
  it("a failed audit write leaves the stage free to record on the next success", () => {
    const orig = h.logged.push;
    (h.logged as unknown as { push: () => never }).push = () => { throw new Error("audit down"); };
    const first = recordOperatorStage("kernel-audit-fail", "kernel_created");
    (h.logged as unknown as { push: typeof orig }).push = orig;
    expect(first).toBe(false);
    expect(recordOperatorStage("kernel-audit-fail", "kernel_created")).toBe(true);
    expect(opFunnelRows().filter((r) => r.resourceId === "kernel-audit-fail")).toHaveLength(1);
  });

  it("a restart (cleared memory) writes no duplicate row: the audit log is the source of truth", () => {
    expect(recordOperatorStage("kernel-restart", "device_registered")).toBe(true);
    __resetOperatorFunnelState();
    expect(recordOperatorStage("kernel-restart", "device_registered")).toBe(false);
    expect(opFunnelRows().filter((r) => r.resourceId === "kernel-restart")).toHaveLength(1);
  });
});

