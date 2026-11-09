import * as Sentry from "@sentry/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

const payload = { capabilityId: "signer-capability", jobId: "signer-job", stepId: "signer-step", cwmId: "signer-cwm", gcodeHash: `sha256:${"ab".repeat(32)}`, assuranceTier: 0 };

beforeEach(() => {
  vi.mocked(Sentry.startSpan).mockImplementation((_opts, fn) => fn({} as never));
  vi.stubEnv("KERNEL_CONFIG", "");
  vi.stubEnv("KERNEL_CONFIG_FILE", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("N267 kernel server signer admission", () => {
  it("J4 production execute refuses without creating a job or calling the runner", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { buildServer } = await import("../server.js");
    const { JobRunner } = await import("../job-runner.js");
    const run = vi.spyOn(JobRunner.prototype, "run").mockResolvedValue({ success: true, durationMs: 0 });
    const app = await buildServer();
    try {
      const response = await app.inject({ method: "POST", url: "/execute", payload });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "kernel_signer_required", message: "This kernel server has no signing key, so in production it runs no job." });
      const status = await app.inject({ method: "GET", url: `/jobs/${payload.jobId}` });
      expect(status.json()).toEqual({ error: "Job not found" });
      expect(run).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("J8 importing the server defers invalid config until buildServer", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("KERNEL_CONFIG", "{not json");
    vi.resetModules();
    const imported = import("../server.js");
    await expect(imported).resolves.toHaveProperty("buildServer");
    const { buildServer } = await imported;
    await expect(buildServer()).rejects.toThrow("Failed to parse KERNEL_CONFIG env var as JSON:");
  });

  it("J10 execute outside production starts the runner", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.resetModules();
    const { buildServer } = await import("../server.js");
    const { JobRunner } = await import("../job-runner.js");
    const run = vi.spyOn(JobRunner.prototype, "run").mockResolvedValue({ success: true, durationMs: 0 });
    const app = await buildServer();
    try {
      const response = await app.inject({ method: "POST", url: "/execute", payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ jobId: payload.jobId, status: "executing" });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ jobId: payload.jobId, stepId: payload.stepId }));
    } finally {
      await app.close();
    }
  });
});
