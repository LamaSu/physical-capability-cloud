import { afterEach, describe, expect, it, vi } from "vitest";
import type { IRepositories } from "@pcc/store";

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), sweep: vi.fn(), read: vi.fn() }));
vi.mock("@pcc/demand-intel", () => ({
  DemandAggregator: class { snapshot = mocks.snapshot; },
}));
vi.mock("../db.js", () => ({ getRepos: () => ({}) }));
vi.mock("../services/job-offers-store.js", () => ({
  getJobOffersStore: () => ({ sweep: mocks.sweep }),
}));
vi.mock("../contracts/escrow-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../contracts/escrow-client.js")>(),
  isWriteEnabled: () => true,
  getEscrowStateV2: mocks.read,
}));
import { startDemandSnapshotCron, stopDemandSnapshotCron } from "../routes/admin-demand.js";
import { startJobOffersSweeper, stopJobOffersSweeper } from "../services/job-offers-sweeper.js";
import { startCourierJobsSweeper, stopCourierJobsSweeper } from "../services/courier-jobs-sweeper.js";
import { runKeeperSweep } from "../services/settlement-keeper.js";
import * as toolIndex from "@pcc/tool-index";
import { prewarmToolIndex, _testResetToolIndex } from "../routes/tool-search.js";

const raw = ["Bearer", "n71-round9-wrapper-private-input"].join(" ");
const logger = () => ({ info: vi.fn(), warn: vi.fn() });

afterEach(() => {
  stopDemandSnapshotCron();
  stopJobOffersSweeper();
  stopCourierJobsSweeper();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("N71 r9 custom logger boundaries", () => {
  it("tool-index load failures omit both the path and dependency text", () => {
    const log = logger();
    const load = vi.spyOn(toolIndex, "loadAgentPackage").mockImplementationOnce(() => { throw new Error(raw); });
    _testResetToolIndex();
    try {
      prewarmToolIndex(log);
      expect(load).toHaveBeenCalledOnce();
      expect(log.warn).toHaveBeenCalledWith("[tool-search] load failed: Error");
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain(raw);
    } finally {
      load.mockRestore();
      _testResetToolIndex();
    }
  });

  it("snapshot failures contain a closed error class", () => {
    const log = logger();
    mocks.snapshot.mockImplementation(() => { throw new Error(raw); });
    startDemandSnapshotCron(log);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls.every(([message]) => message.endsWith("failed: Error"))).toBe(true);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(raw);
  });

  it.each([
    ["generic", startJobOffersSweeper],
    ["courier", startCourierJobsSweeper],
  ] as const)("%s sweeper failures contain a closed error class", async (_name, start) => {
    vi.useFakeTimers();
    mocks.sweep.mockRejectedValueOnce(new Error(raw));
    const log = logger();
    start(log);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain("sweep failed: Error");
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(raw);
  });

  it("keeper read failures format both the escrow id and the exception", async () => {
    const log = logger();
    mocks.read.mockRejectedValueOnce(new Error(raw));
    const repos = { escrows: { findAll: () => [{
      id: raw, contractAddress: "0x" + "12".repeat(20), status: "active", version: "v2",
    }] } } as unknown as IRepositories;
    const result = await runKeeperSweep(repos, { logger: log });
    expect(result.readErrors).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain("[invalid id]");
    expect(log.warn.mock.calls[0][0]).toMatch(/: Error$/);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(raw);
  });
});
