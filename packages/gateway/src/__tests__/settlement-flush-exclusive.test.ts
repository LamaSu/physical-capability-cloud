/**
 * Cross-family review r2 of #425 (rm-px3-425-r2-5d2615cd), MEDIUM 2: the page's flush guard is
 * local to one mounted page, and POST /api/settlement/flush had no guard of its own, so two tabs
 * could each start a flush. BatchSettler.settle() snapshots and clears the pending intents, then
 * awaits the queue, so two concurrent flushes split one epoch into inconsistent summaries. The route
 * now refuses a flush while one is running (409 flush_in_progress). Reproduced at 5d2615cd.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const SUMMARY = (epochId: number) => ({
  epochId,
  batches: [{ userOpHash: "0x" + "ab".repeat(32), operationCount: 2, trigger: "manual" }],
  totalIntents: 2,
  byAgent: { a: 2 },
  byOperation: { release: 2 },
  startedAt: 1000,
  completedAt: 1010,
});

const flushMock = vi.fn(async () => SUMMARY(1));

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest123", metadataCid: "bafymeta456" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc789", metadataCid: "bafyencmeta012" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn(),
  releaseMilestone: vi.fn(),
  isWriteEnabled: vi.fn().mockReturnValue(false),
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(true),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
}));
vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(true),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: () => flushMock(),
  getQueueStatus: vi.fn().mockReturnValue({ batchEnabled: true, pending: 2, totalValue: 0n, oldestAge: 0, autoFlush: false }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

vi.setConfig({ testTimeout: 20000 });

let app: FastifyInstance;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  const db = await import("../db.js");
  db.initStore({ seed: true });
  const { settlementRoutes } = await import("../routes/settlement.js");
  app = Fastify({ logger: false });
  await app.register(settlementRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  (await import("../db.js")).closeStore();
});

const flush = () => app.inject({ method: "POST", url: "/api/settlement/flush" });

describe("MEDIUM 2 (review r2 of #425): the gateway runs one flush at a time", () => {
  it("a flush asked for while one is running is 409 flush_in_progress, and nothing is flushed twice", async () => {
    flushMock.mockClear();
    let release!: () => void;
    flushMock.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(SUMMARY(7)))));
    const first = flush();
    await new Promise((r) => setTimeout(r, 25));
    const second = await flush();
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("flush_in_progress");
    release();
    const done = await first;
    expect(done.statusCode).toBe(200);
    expect(done.json().epoch).toBe(7);
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("once a flush ends, successfully or not, the next one runs", async () => {
    flushMock.mockClear();
    flushMock.mockImplementationOnce(async () => {
      throw new Error("bundler unreachable");
    });
    expect((await flush()).statusCode).toBe(502);
    flushMock.mockImplementationOnce(async () => SUMMARY(8));
    const next = await flush();
    expect(next.statusCode).toBe(200);
    expect(next.json().epoch).toBe(8);
  });
});
