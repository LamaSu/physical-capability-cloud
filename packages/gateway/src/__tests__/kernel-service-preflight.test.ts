/**
 * KernelService.submitJob — adapter preflight() gate (requirements-gated).
 *
 * The default mock config builds a real MockFDMAdapter (which implements
 * preflight() over a calibrated ResourceTracker) at `dev-test-machine`.
 *
 * Acceptance: a job that declares `requirements` exceeding the adapter's
 * capacity is refused with a typed PreflightRefusedError BEFORE execution;
 * preflight() fires only for requirements-declaring jobs, so a job without
 * `requirements` never calls it and is unaffected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initStore, closeStore } from "../db.js";
import {
  initKernelService,
  resetKernelService,
  getKernelService,
  PreflightRefusedError,
} from "../services/kernel-service.js";
import type { KernelConfig } from "@pcc/kernel";

const mockConfig: KernelConfig = {
  kernelId: "kernel-preflight-001",
  mockMode: true,
  devices: [
    {
      id: "dev-test-machine",
      type: "machine",
      adapterType: "mock",
      config: { kernelId: "kernel-preflight-001", jobDurationMs: 50 },
    },
  ],
};

describe("KernelService.submitJob — preflight() gate", () => {
  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    resetKernelService();
    initKernelService(mockConfig);
  });

  afterEach(() => {
    resetKernelService();
    closeStore();
    vi.restoreAllMocks();
  });

  it("refuses a requirements-declaring job that exceeds adapter capacity (typed error), calling preflight()", async () => {
    const svc = getKernelService();
    const machine = (svc as unknown as { machines: Map<string, { preflight: unknown }> })
      .machines.get("dev-test-machine")!;
    const spy = vi.spyOn(machine as never, "preflight");

    await expect(
      svc.submitJob({
        jobId: "job-pf-refuse",
        stepId: "step-pf",
        // 5000g exceeds the mock printer's 1000g calibrated capacity.
        requirements: { filamentGrams: 5000, buildVolumeMm3: 1000 },
      }),
    ).rejects.toMatchObject({ name: "PreflightRefusedError" });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ requirements: { filamentGrams: 5000, buildVolumeMm3: 1000 } }),
    );
  });

  it("throws a PreflightRefusedError instance (typed, carries a refusal code)", async () => {
    const svc = getKernelService();
    let caught: unknown;
    try {
      await svc.submitJob({
        jobId: "job-pf-typed",
        stepId: "step-pf",
        requirements: { filamentGrams: 5000, buildVolumeMm3: 1000 },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PreflightRefusedError);
    expect((caught as PreflightRefusedError).code).toBeTruthy();
  });

  it("does NOT call preflight() for a job that declares no requirements (unaffected)", async () => {
    const svc = getKernelService();
    const machine = (svc as unknown as { machines: Map<string, { preflight: unknown }> })
      .machines.get("dev-test-machine")!;
    const spy = vi.spyOn(machine as never, "preflight");

    const res = await svc.submitJob({ jobId: "job-pf-none", stepId: "step-pf" });

    expect(res.status).toBe("accepted");
    expect(spy).not.toHaveBeenCalled();
  });

  it("admits a requirements-declaring job that fits capacity (preflight passes)", async () => {
    const svc = getKernelService();
    const machine = (svc as unknown as { machines: Map<string, { preflight: unknown }> })
      .machines.get("dev-test-machine")!;
    const spy = vi.spyOn(machine as never, "preflight");

    const res = await svc.submitJob({
      jobId: "job-pf-ok",
      stepId: "step-pf",
      requirements: { filamentGrams: 100, buildVolumeMm3: 1000 },
    });

    expect(res.status).toBe("accepted");
    expect(spy).toHaveBeenCalledOnce();
  });
});
