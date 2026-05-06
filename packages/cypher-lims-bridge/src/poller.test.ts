import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CypherApiError, type CypherClient } from "./client.js";
import { LimsPoller } from "./poller.js";
import type { CypherLimsRequest } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock CypherClient. */
function makeClient(
  requests: CypherLimsRequest[] = [],
): {
  client: CypherClient;
  listSpy: ReturnType<typeof vi.fn>;
} {
  const listSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, data: requests });
  return {
    client: { listLimsRequests: listSpy } as unknown as CypherClient,
    listSpy,
  };
}

const REQ_A: CypherLimsRequest = {
  _id: "req_aaa",
  requestNumber: "REQ-001",
  workType: "plasmid_prep",
  status: "pending",
};

const REQ_B: CypherLimsRequest = {
  _id: "req_bbb",
  requestNumber: "REQ-002",
  workType: "plasmid_prep",
  status: "pending",
};

// ---------------------------------------------------------------------------
// Constructor tests
// ---------------------------------------------------------------------------
describe("LimsPoller — constructor", () => {
  it("throws when intervalMs < 1000 ms", () => {
    const { client } = makeClient();
    expect(() => new LimsPoller({ client, intervalMs: 500 })).toThrow(
      /intervalMs must be/,
    );
  });

  it("creates without error given valid options", () => {
    const { client } = makeClient();
    expect(() => new LimsPoller({ client, intervalMs: 1000 })).not.toThrow();
  });

  it("isRunning() returns false before start()", () => {
    const { client } = makeClient();
    const poller = new LimsPoller({ client, intervalMs: 1000 });
    expect(poller.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------
describe("LimsPoller — start() / stop()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("start() sets isRunning() to true and emits 'start'", () => {
    const { client } = makeClient();
    const poller = new LimsPoller({ client, intervalMs: 5000 });
    const startEvents: true[] = [];
    poller.on("start", () => startEvents.push(true));
    poller.start();
    expect(poller.isRunning()).toBe(true);
    expect(startEvents).toHaveLength(1);
    poller.stop();
  });

  it("calling start() twice is a no-op (only 1 start event)", () => {
    const { client } = makeClient();
    const poller = new LimsPoller({ client, intervalMs: 5000 });
    const startEvents: true[] = [];
    poller.on("start", () => startEvents.push(true));
    poller.start();
    poller.start();
    expect(startEvents).toHaveLength(1);
    poller.stop();
  });

  it("stop() sets isRunning() to false and emits 'stop'", async () => {
    const { client, listSpy } = makeClient([REQ_A]);
    listSpy.mockResolvedValue({ ok: true, status: 200, data: [REQ_A] });
    const poller = new LimsPoller({ client, intervalMs: 5000 });
    const stopEvents: true[] = [];
    poller.on("stop", () => stopEvents.push(true));
    poller.start();
    await vi.runAllTimersAsync();
    poller.stop();
    expect(poller.isRunning()).toBe(false);
    expect(stopEvents).toHaveLength(1);
  });

  it("calling stop() twice is idempotent", async () => {
    const { client } = makeClient();
    const poller = new LimsPoller({ client, intervalMs: 5000 });
    const stopEvents: true[] = [];
    poller.on("stop", () => stopEvents.push(true));
    poller.start();
    await vi.runAllTimersAsync();
    poller.stop();
    poller.stop();
    expect(stopEvents).toHaveLength(1);
  });

  it("stop() prevents further ticks from firing", async () => {
    const { client, listSpy } = makeClient([REQ_A]);
    const poller = new LimsPoller({ client, intervalMs: 1000 });
    poller.start();
    await vi.runAllTimersAsync();
    poller.stop();
    const callsAfterStop = listSpy.mock.calls.length;
    // Advance timers — no new ticks should fire
    await vi.advanceTimersByTimeAsync(5000);
    expect(listSpy.mock.calls.length).toBe(callsAfterStop);
  });
});

// ---------------------------------------------------------------------------
// First tick calls client.listLimsRequests
// ---------------------------------------------------------------------------
describe("LimsPoller — first tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls client.listLimsRequests on the first tick", async () => {
    const { client, listSpy } = makeClient([REQ_A]);
    const poller = new LimsPoller({ client, intervalMs: 5000 });
    poller.start();
    await vi.runAllTimersAsync();
    expect(listSpy).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("emits 'request-discovered' for each request returned by the first tick", async () => {
    const { client } = makeClient([REQ_A, REQ_B]);
    const poller = new LimsPoller({ client, intervalMs: 5000 });
    const discovered: CypherLimsRequest[] = [];
    poller.on("request-discovered", (req) => discovered.push(req));
    poller.start();
    await vi.runAllTimersAsync();
    expect(discovered).toHaveLength(2);
    expect(discovered.map((r) => r._id)).toEqual(
      expect.arrayContaining(["req_aaa", "req_bbb"]),
    );
    poller.stop();
  });
});

// ---------------------------------------------------------------------------
// Deduplication — already-seen requests not re-emitted
// ---------------------------------------------------------------------------
describe("LimsPoller — deduplication", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT re-emit requests seen on prior ticks", async () => {
    const { client, listSpy } = makeClient([REQ_A]);
    // Both ticks return the same request
    listSpy
      .mockResolvedValueOnce({ ok: true, status: 200, data: [REQ_A] })
      .mockResolvedValueOnce({ ok: true, status: 200, data: [REQ_A] });
    const poller = new LimsPoller({ client, intervalMs: 1000 });
    const discovered: CypherLimsRequest[] = [];
    poller.on("request-discovered", (req) => discovered.push(req));
    poller.start();
    await vi.runAllTimersAsync();
    // Advance by another interval to trigger second tick
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTimersAsync();
    // Only 1 discovery despite 2 ticks
    expect(discovered).toHaveLength(1);
    poller.stop();
  });

  it("seenCount() increments only for new requests", async () => {
    const { client } = makeClient([REQ_A, REQ_B]);
    const poller = new LimsPoller({ client, intervalMs: 5000 });
    poller.start();
    await vi.runAllTimersAsync();
    expect(poller.seenCount()).toBe(2);
    poller.stop();
  });
});

// ---------------------------------------------------------------------------
// Error resilience — errors don't crash the poller
// ---------------------------------------------------------------------------
describe("LimsPoller — error resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits 'error' event when client throws, does NOT crash", async () => {
    const listSpy = vi.fn().mockRejectedValue(
      new CypherApiError("network_error", { status: null, path: "/api/lims/requests" }),
    );
    const client = { listLimsRequests: listSpy } as unknown as CypherClient;
    const poller = new LimsPoller({ client, intervalMs: 5000 });
    const errors: Error[] = [];
    poller.on("error", (err) => errors.push(err));
    poller.start();
    await vi.runAllTimersAsync();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    // Poller should still be running after an error
    expect(poller.isRunning()).toBe(true);
    poller.stop();
  });

  it("continues polling after an error (retry next tick)", async () => {
    const listSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ ok: true, status: 200, data: [REQ_A] });
    const client = { listLimsRequests: listSpy } as unknown as CypherClient;
    const poller = new LimsPoller({ client, intervalMs: 1000 });
    const discovered: CypherLimsRequest[] = [];
    poller.on("request-discovered", (req) => discovered.push(req));
    // Suppress unhandled error
    poller.on("error", () => {});
    poller.start();
    await vi.runAllTimersAsync();
    // Advance by interval to trigger second tick
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTimersAsync();
    expect(discovered).toHaveLength(1);
    poller.stop();
  });
});

// ---------------------------------------------------------------------------
// workType is passed to listLimsRequests
// ---------------------------------------------------------------------------
describe("LimsPoller — workType passthrough", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes workType filter to client.listLimsRequests", async () => {
    const { client, listSpy } = makeClient([]);
    const poller = new LimsPoller({
      client,
      intervalMs: 5000,
      workType: "plasmid_prep",
    });
    poller.start();
    await vi.runAllTimersAsync();
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workType: "plasmid_prep" }),
    );
    poller.stop();
  });
});

// ---------------------------------------------------------------------------
// Multiple subscribers
// ---------------------------------------------------------------------------
describe("LimsPoller — multiple subscribers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("multiple listeners on 'request-discovered' all receive the event", async () => {
    const { client } = makeClient([REQ_A]);
    const poller = new LimsPoller({ client, intervalMs: 5000 });
    const received1: string[] = [];
    const received2: string[] = [];
    poller.on("request-discovered", (req) => received1.push(req._id));
    poller.on("request-discovered", (req) => received2.push(req._id));
    poller.start();
    await vi.runAllTimersAsync();
    expect(received1).toEqual(["req_aaa"]);
    expect(received2).toEqual(["req_aaa"]);
    poller.stop();
  });
});

// ---------------------------------------------------------------------------
// pollNow
// ---------------------------------------------------------------------------
describe("LimsPoller — pollNow()", () => {
  it("can be called before start() and triggers a manual tick", async () => {
    const { client, listSpy } = makeClient([REQ_A]);
    const poller = new LimsPoller({ client, intervalMs: 5000 });
    const discovered: string[] = [];
    poller.on("request-discovered", (req) => discovered.push(req._id));
    await poller.pollNow();
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(discovered).toEqual(["req_aaa"]);
  });
});
