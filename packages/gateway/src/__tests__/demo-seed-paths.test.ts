import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

describe.each([
  ["production", undefined, true],
  ["development", undefined, true],
  ["production", "false", false],
  ["development", "false", false],
  ["production", "true", true],
] as const)("other boot demos with NODE_ENV=%s and PCC_SEED_DATA=%j", (nodeEnv, seed, expected) => {
  let app: FastifyInstance | undefined;
  let closeStore: (() => void) | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("PCC_SEED_DATA", seed ?? "");
    if (seed === undefined) delete process.env.PCC_SEED_DATA;
    vi.stubEnv("DATABASE_URL", "");
    delete process.env.DATABASE_URL;
    vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "");
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("LIT_PROTOCOL_REAL", "false");
  });

  afterEach(async () => {
    try {
      await app?.close();
    } finally {
      app = undefined;
      closeStore?.();
      closeStore = undefined;
      vi.unstubAllEnvs();
    }
  });

  it("applies the override to the demo batch while preserving its default", async () => {
    const { batchTracker } = await import("../services.js");
    expect(batchTracker.getBatchesForJob("job-010").length).toBe(expected ? 1 : 0);
  }, 120_000);

  it("applies the override to the boot request while preserving its default", async () => {
    const db = await import("../db.js");
    closeStore = db.closeStore;
    db.initStore({ seed: false });
    const { requestRoutes } = await import("../routes/requests.js");
    app = Fastify({ logger: false });
    await app.register(requestRoutes);
    await app.ready();
    expect(Boolean(db.getRepos().requests.findById("req-moltpod-001"))).toBe(expected);
  }, 120_000);
});
