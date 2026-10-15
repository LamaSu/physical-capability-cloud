import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStore, getRepos } from "../db.js";

// Starting the HTTP listener should not start agents or make chain writes.
vi.mock("../agent-bridge.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agent-bridge.js")>(),
  initAgentBridge: vi.fn(async () => {}),
}));
vi.mock("../contracts/batch-settlement.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../contracts/batch-settlement.js")>(),
  initBatchSettlement: vi.fn(async () => false),
}));

describe("gateway startup configuration", () => {
  let createGateway: typeof import("../server.js")["createGateway"];
  let gateway: Awaited<ReturnType<typeof createGateway>> | undefined;
  let directory: string;

  beforeAll(async () => {
    vi.stubEnv("LIT_PROTOCOL_REAL", "false");
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("VITE_SENTRY_DSN", "");
    vi.stubEnv("POSTHOG_API_KEY", "");
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    ({ createGateway } = await import("../server.js"));
  }, 120_000);

  beforeEach(() => {
    closeStore();
    directory = mkdtempSync(join(tmpdir(), "pcc-gateway-config-"));
    vi.stubEnv("DATABASE_URL", "");
    delete process.env.DATABASE_URL;
    vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "");
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    vi.stubEnv("PCC_DB_PATH", join(directory, "pcc.sqlite"));
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PCC_SEED_DATA", "false");
    vi.stubEnv("PCC_LISTEN_HOST", "127.0.0.1");
    vi.stubEnv("SERVE_DASHBOARD", "false");
    vi.stubEnv("ENABLE_MOCK_STREAMING", "false");
    vi.stubEnv("SETTLEMENT_KEEPER_ENABLED", "false");
    vi.stubEnv("ERC8004_SWEEPER_DISABLED", "true");
  });

  afterEach(async () => {
    try {
      await gateway?.app.close();
    } finally {
      const { stopDemandSnapshotCron } = await import("../routes/admin-demand.js");
      const { stopJobOffersSweeper } = await import("../services/job-offers-sweeper.js");
      const { startKernelTtlSweeper } = await import("../services/kernel-ttl-sweeper.js");
      const { resetKernelService } = await import("../services/kernel-service.js");
      stopDemandSnapshotCron();
      stopJobOffersSweeper();
      startKernelTtlSweeper(() => getRepos()).stop();
      resetKernelService();
      gateway = undefined;
      closeStore();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("passes PCC_LISTEN_HOST to Fastify when starting the gateway", async () => {
    gateway = await createGateway(0);
    const listen = vi.spyOn(gateway.app, "listen")
      .mockResolvedValue("http://127.0.0.1:3200");
    await gateway.start();
    expect(listen).toHaveBeenCalledWith({ port: 0, host: "127.0.0.1" });
  }, 120_000);

  it("ignores HOST when PCC_LISTEN_HOST is set", async () => {
    vi.stubEnv("HOST", "http://ignored.example");
    gateway = await createGateway(0);
    const listen = vi.spyOn(gateway.app, "listen")
      .mockResolvedValue("http://127.0.0.1:3200");
    await gateway.start();
    expect(listen).toHaveBeenCalledWith({ port: 0, host: "127.0.0.1" });
  }, 120_000);

  it("defaults to 0.0.0.0 when only the old HOST is set", async () => {
    vi.stubEnv("HOST", "127.0.0.1");
    vi.stubEnv("PCC_LISTEN_HOST", "");
    delete process.env.PCC_LISTEN_HOST;
    gateway = await createGateway(0);
    const listen = vi.spyOn(gateway.app, "listen")
      .mockResolvedValue("http://0.0.0.0:3200");
    await gateway.start();
    expect(listen).toHaveBeenCalledWith({ port: 0, host: "0.0.0.0" });
  }, 120_000);

  it("binds the real HTTP listener to PCC_LISTEN_HOST", async () => {
    gateway = await createGateway(0);
    await gateway.start();
    expect((gateway.app.server.address() as AddressInfo).address).toBe("127.0.0.1");
  }, 120_000);

  it("does not seed demo kernels in development when PCC_SEED_DATA=false", async () => {
    gateway = await createGateway(0);
    expect(existsSync(join(directory, "pcc.sqlite"))).toBe(true);
    expect(getRepos().kernels.findById("kernel-nyc")).toBeUndefined();
    expect(getRepos().kernels.findAll()).toHaveLength(0);
  }, 120_000);

  it("does not seed demo jobs in development when PCC_SEED_DATA=false", async () => {
    gateway = await createGateway(0);
    expect(existsSync(join(directory, "pcc.sqlite"))).toBe(true);
    expect(getRepos().jobs.findById("job-003")).toBeUndefined();
    expect(getRepos().jobs.findAll()).toHaveLength(0);
  }, 120_000);

  it("production with PCC_SEED_DATA unset seeds nothing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PCC_SEED_DATA", "");
    delete process.env.PCC_SEED_DATA;
    gateway = await createGateway(0);
    expect(getRepos().kernels.findAll()).toHaveLength(0);
    expect(getRepos().jobs.findAll()).toHaveLength(0);
  }, 120_000);

  it("development with PCC_SEED_DATA unset still seeds the demo kernels", async () => {
    vi.stubEnv("PCC_SEED_DATA", "");
    delete process.env.PCC_SEED_DATA;
    gateway = await createGateway(0);
    expect(getRepos().kernels.findById("kernel-nyc")).toBeDefined();
  }, 120_000);

  it("rejects invalid PCC_LISTEN_HOST at startup with the configured value", async () => {
    vi.stubEnv("PCC_LISTEN_HOST", "http://localhost");
    await expect(createGateway(0).then((created) => {
      gateway = created;
    })).rejects.toThrow('Invalid PCC_LISTEN_HOST "http://localhost"');
  }, 120_000);

  it("an invalid listen host fails before the store file is opened", async () => {
    vi.stubEnv("PCC_LISTEN_HOST", "http://localhost");
    await expect(createGateway(0)).rejects.toThrow('Invalid PCC_LISTEN_HOST "http://localhost"');
    expect(existsSync(join(directory, "pcc.sqlite"))).toBe(false);
  }, 120_000);
});
