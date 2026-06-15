/**
 * Tests for the oracle fetch retry/backoff/timeout wrapper (P2-SCALE feature #2).
 *
 * Drives the exported `fetchWithRetry` with a stubbed global `fetch`. Tiny
 * retryDelayMs keeps the suite fast; we assert attempt counts and the
 * transient-vs-deterministic retry policy.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithRetry } from "../services/oracle-client.js";

function res(status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({}),
    text: async () => "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithRetry", () => {
  it("retries on network errors then succeeds, returning the final response", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(res(200));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchWithRetry("http://oracle/verify", { method: "POST" }, { retries: 2, retryDelayMs: 1 });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on transient HTTP (503) then returns the 200", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchWithRetry("http://oracle/verify", {}, { retries: 2, retryDelayMs: 1 });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 (rate limit)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchWithRetry("http://oracle/verify", {}, { retries: 1, retryDelayMs: 1 });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a deterministic 4xx (returns immediately)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(400));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchWithRetry("http://oracle/verify", {}, { retries: 3, retryDelayMs: 1 });
    expect(r.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries on persistent network errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("http://oracle/verify", {}, { retries: 2, retryDelayMs: 1 }),
    ).rejects.toThrow(/ENOTFOUND/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("aborts a hung request via the per-attempt timeout, then gives up", async () => {
    // fetch that never resolves on its own — only rejects when the abort signal fires.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal!;
          signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("http://oracle/verify", {}, { retries: 1, retryDelayMs: 1, timeoutMs: 5 }),
    ).rejects.toThrow(/abort/i);
    expect(fetchMock).toHaveBeenCalledTimes(2); // timed out twice (initial + 1 retry)
  });
});

describe("verifyWithOracle still works through the retry wrapper", () => {
  it("uses the mock path when no oracle key is configured (no fetch)", async () => {
    const ORIG = process.env.PCC_ORACLE_KEY;
    delete process.env.PCC_ORACLE_KEY;
    vi.resetModules();
    try {
      const { verifyWithOracle } = await import("../services/oracle-client.js");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const out = await verifyWithOracle({
        escrowAddress: "0x0000000000000000000000000000000000000000",
        jobId: "job-x",
        kernelId: "kernel-x",
        evidenceHash: "0x" + "ab".repeat(32),
        assuranceTier: 0,
        chainId: 84532,
      });
      expect(out.result.verified).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled(); // mock path short-circuits before fetch
    } finally {
      if (ORIG === undefined) delete process.env.PCC_ORACLE_KEY;
      else process.env.PCC_ORACLE_KEY = ORIG;
    }
  });
});
