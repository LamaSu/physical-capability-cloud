/**
 * Cross-family review r6 of #403 (rm-f3-403-r6-43ec901a, DO-NOT-SHIP). These tests reproduce its
 * finding at 43ec901a and pin the rule that replaces it: each source of a record is resolved on its
 * own, so a source that names a batch and none of its samples is owned by every job of the batch
 * even when another source of the same record names a sample of that batch.
 *   CRITICAL 1  a rate-of-change or flatline anomaly derived from a batch-level reading and from
 *               tenant A's sample reading of the same batch was owned by tenant A's job alone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../services/posthog-service.js", () => ({ trackServerEvent: vi.fn(), shutdownPostHog: vi.fn() }));

const ADMIN = "f3-r7-admin-key";
const OPERATOR_NYC = "0x1111111111111111111111111111111111111111"; // seeded kernel-nyc operator
const DEVICE = "dev-fdm-prusa-mk4"; // seeded on kernel-nyc
const ADMIN_H = { "x-admin-key": ADMIN };
const TENANT_A_ADMIN = { ...ADMIN_H, "x-test-tenant": "tenant-a" };
const RATE = "r7_rate_channel";
const FLAT = "r7_flat_channel";

let app: FastifyInstance;
let batchId = "";
let aSlotId = "";
let sensorPipeline: typeof import("../../services.js").sensorPipeline;
let recordOwnersOf: typeof import("../../readmodels/job-read-gate.js").recordOwnersOf;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  delete process.env.TENANT_ENFORCE;
  const db = await import("../../db.js");
  db.initStore({ seed: true });
  const { schema, eq } = await import("@pcc/store");
  const store = db.getStore();
  store.db.update(schema.jobs).set({ tenantId: "tenant-a" } as never).where(eq(schema.jobs.id, "job-001")).run();
  store.db.update(schema.jobs).set({ tenantId: "tenant-b" } as never).where(eq(schema.jobs.id, "job-003")).run();

  const services = await import("../../services.js");
  sensorPipeline = services.sensorPipeline;
  ({ recordOwnersOf } = await import("../../readmodels/job-read-gate.js"));
  for (const channel of [RATE, FLAT]) {
    sensorPipeline.registerChannel({
      channel, label: channel, dataType: "scalar", unit: "degC", sampleRateHz: 1, retentionPolicy: "full", evidenceGrade: false,
    } as never);
  }
  // A mixed-tenant batch: tenant A's sample and tenant B's.
  const batch = services.batchTracker.createBatch("kernel-nyc", DEVICE, "cap-nyc-fdm", {});
  aSlotId = (services.batchTracker.addSample(batch.id, { position: "A1", jobId: "job-001", stepId: "step-1", userId: OPERATOR_NYC as never, sampleLabel: "r7-a" } as never) as { id: string }).id;
  services.batchTracker.addSample(batch.id, { position: "A2", jobId: "job-003", stepId: "step-3", userId: OPERATOR_NYC as never, sampleLabel: "r7-b" } as never);
  batchId = batch.id;

  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const tenant = req.headers["x-test-tenant"];
    if (typeof tenant === "string") (req as any).tenantId = tenant;
  });
  const { sensorRoutes } = await import("../../routes/sensors.js");
  await app.register(sensorRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  (await import("../../db.js")).closeStore();
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.TENANT_ENFORCE;
});

const reading = (channel: string, at: number, value: number, sample: boolean) =>
  sensorPipeline.ingest({
    timestamp: new Date(at).toISOString(), kernelId: "kernel-nyc", deviceId: DEVICE, channel, dataType: "scalar", unit: "degC", value,
    batchId, ...(sample ? { jobId: "job-001", sampleId: aSlotId } : {}),
  } as never);

const anomaliesOf = async (headers: Record<string, string>, channel: string, type: string) => {
  const res = await app.inject({ method: "GET", url: "/api/sensors/anomalies", headers });
  expect(res.statusCode).toBe(200);
  return (res.json().anomalies as Array<{ channel: string; type: string }>).filter((a) => a.channel === channel && a.type === type);
};

const asTenantA = async <T>(fn: () => Promise<T>): Promise<T> => {
  process.env.TENANT_ENFORCE = "true";
  try {
    return await fn();
  } finally {
    delete process.env.TENANT_ENFORCE;
  }
};

describe("CRITICAL 1: each source of a record is resolved on its own", () => {
  it("the verdict's reproduction: a rate-of-change anomaly from a batch-level reading and tenant A's sample reading is the whole batch's", async () => {
    const t0 = Date.now() - 10_000;
    reading(RATE, t0, 0, false);
    reading(RATE, t0 + 1000, 5000, true); // 5000/s exceeds the pipeline's 1000/s
    expect(await asTenantA(() => anomaliesOf(TENANT_A_ADMIN, RATE, "rate_of_change"))).toEqual([]);
    expect(await anomaliesOf(ADMIN_H, RATE, "rate_of_change")).toHaveLength(1); // it exists
  });

  it("a flatline anomaly over batch-level readings and tenant A's sample reading is the whole batch's", async () => {
    const t0 = Date.now() - 100_000;
    for (let i = 0; i < 30; i++) reading(FLAT, t0 + i * 1000, 7, false);
    reading(FLAT, t0 + 30_000, 7, true);
    const all = await anomaliesOf(ADMIN_H, FLAT, "flatline");
    expect(all.length).toBeGreaterThan(0);
    expect(await asTenantA(() => anomaliesOf(TENANT_A_ADMIN, FLAT, "flatline"))).toEqual([]);
  });

  it("the resolver: a batch-only source adds every job of its batch beside a sample source of that batch; a sample source alone stays its slot's", () => {
    const mixed = recordOwnersOf({ jobId: "job-001", sources: [{ batchId }, { batchId, sampleId: aSlotId }] });
    expect(new Set(mixed?.jobs)).toEqual(new Set(["job-001", "job-003"]));
    expect(recordOwnersOf({ batchId, sampleId: aSlotId })?.jobs).toEqual(["job-001"]);
    // On the batch's own stream the record itself is tied to the batch: naming its sample at the top keeps it the slot's.
    expect(recordOwnersOf({ sampleId: aSlotId }, { batchId })?.jobs).toEqual(["job-001"]);
    // A sample named only inside a nested object does not cover the batch the record's top names.
    expect(new Set(recordOwnersOf({ batchId, detail: { sampleId: aSlotId } })?.jobs)).toEqual(new Set(["job-001", "job-003"]));
  });
});
