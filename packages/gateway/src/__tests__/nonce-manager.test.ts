/**
 * Tests for the per-signer nonce manager / sequential tx queue (P2-SCALE).
 *
 * Pure — no chain, no viem. The manager is driven by an injected `fetchPending`
 * so we can assert seeding, monotonic allocation, serialization, success-only
 * advancement, and nonce-error re-seeding deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  NonceManager,
  isNonceError,
  isNonceManagerDisabled,
  getNonceManager,
  resetNonceManagers,
} from "../contracts/nonce-manager.js";

describe("NonceManager", () => {
  it("seeds from chain once and hands out monotonic nonces across a run of successes", async () => {
    const fetchPending = vi.fn(async () => 5);
    const mgr = new NonceManager(fetchPending);

    const seen: number[] = [];
    await mgr.submit(async (n) => { seen.push(n); return "0x1"; });
    await mgr.submit(async (n) => { seen.push(n); return "0x2"; });
    await mgr.submit(async (n) => { seen.push(n); return "0x3"; });

    expect(seen).toEqual([5, 6, 7]);
    // One seed read for the whole run — re-reading per tx IS the race window #145 hit.
    expect(fetchPending).toHaveBeenCalledTimes(1);
    expect(mgr.peek()).toBe(8);
  });

  it("serializes concurrent submits so no two writes share a nonce", async () => {
    const mgr = new NonceManager(async () => 100);
    const order: number[] = [];
    // Fire 5 concurrently; each resolves after a turn of the event loop.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        mgr.submit(async (n) => {
          await Promise.resolve();
          order.push(n);
          return `0x${n}`;
        }),
      ),
    );
    expect(order).toEqual([100, 101, 102, 103, 104]);
    expect(new Set(order).size).toBe(5); // all distinct
  });

  it("does NOT advance the cursor on a non-nonce error (the nonce is reusable)", async () => {
    const mgr = new NonceManager(async () => 3);
    await expect(
      mgr.submit(async () => {
        throw new Error("execution reverted: out of gas");
      }),
    ).rejects.toThrow(/reverted/);

    const seen: number[] = [];
    await mgr.submit(async (n) => { seen.push(n); return "0x"; });
    // 3 was never consumed on-chain (the tx never broadcast) → reused.
    expect(seen).toEqual([3]);
    expect(mgr.peek()).toBe(4);
  });

  it("re-seeds from chain after a nonce error", async () => {
    let seed = 8;
    const fetchPending = vi.fn(async () => seed);
    const mgr = new NonceManager(fetchPending);

    await expect(
      mgr.submit(async () => {
        throw new Error("nonce too low: next nonce 9, tx nonce 8");
      }),
    ).rejects.toThrow();

    // Chain advanced underneath us; the next submit must re-read it.
    seed = 9;
    const seen: number[] = [];
    await mgr.submit(async (n) => { seen.push(n); return "0x"; });

    expect(seen).toEqual([9]);
    expect(fetchPending).toHaveBeenCalledTimes(2);
  });

  it("keeps the queue alive after a rejected submit (one failure doesn't wedge the signer)", async () => {
    const mgr = new NonceManager(async () => 0);
    const results: string[] = [];

    const p1 = mgr.submit(async () => { throw new Error("boom"); }).catch(() => results.push("err"));
    const p2 = mgr.submit(async (n) => { results.push(`ok:${n}`); return "0x"; });
    await Promise.all([p1, p2]);

    expect(results).toContain("err");
    expect(results).toContain("ok:0"); // nonce 0 reused after the non-nonce failure
  });

  it("reset() forces a re-seed on the next submit", async () => {
    const fetchPending = vi.fn(async () => 42);
    const mgr = new NonceManager(fetchPending);
    await mgr.submit(async () => "0x");
    expect(mgr.peek()).toBe(43);
    mgr.reset();
    expect(mgr.peek()).toBeNull();
    await mgr.submit(async () => "0x");
    expect(fetchPending).toHaveBeenCalledTimes(2);
  });
});

describe("isNonceError", () => {
  it("matches common nonce-desync messages (case-insensitive)", () => {
    for (const msg of [
      "nonce too low",
      "Nonce too high",
      "already known",
      "replacement transaction underpriced",
      "invalid nonce",
      "nonce has already been used",
    ]) {
      expect(isNonceError(new Error(msg))).toBe(true);
    }
  });

  it("does NOT match reverts / funds / generic RPC outages", () => {
    expect(isNonceError(new Error("execution reverted"))).toBe(false);
    expect(isNonceError(new Error("insufficient funds for gas"))).toBe(false);
    expect(isNonceError(new Error("fetch failed"))).toBe(false);
  });

  it("digs into nested viem-style error fields (shortMessage / details / cause)", () => {
    const viemish = {
      shortMessage: "An error occurred",
      details: "nonce too low: tx nonce 4, state nonce 5",
      cause: { message: "ignored" },
    };
    expect(isNonceError(viemish)).toBe(true);
  });
});

describe("isNonceManagerDisabled", () => {
  const ORIG = process.env.PCC_NONCE_MANAGER_DISABLED;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.PCC_NONCE_MANAGER_DISABLED;
    else process.env.PCC_NONCE_MANAGER_DISABLED = ORIG;
  });
  it("is false by default and true for truthy flag values", () => {
    delete process.env.PCC_NONCE_MANAGER_DISABLED;
    expect(isNonceManagerDisabled()).toBe(false);
    for (const v of ["true", "1", "yes"]) {
      process.env.PCC_NONCE_MANAGER_DISABLED = v;
      expect(isNonceManagerDisabled()).toBe(true);
    }
    process.env.PCC_NONCE_MANAGER_DISABLED = "false";
    expect(isNonceManagerDisabled()).toBe(false);
  });
});

describe("getNonceManager registry", () => {
  beforeEach(() => resetNonceManagers());

  it("returns the SAME manager per address (case-insensitive) and distinct per signer", () => {
    const a1 = getNonceManager("0xAbC0000000000000000000000000000000000001", async () => 0);
    const a2 = getNonceManager("0xabc0000000000000000000000000000000000001", async () => 999);
    const b = getNonceManager("0x0000000000000000000000000000000000000002", async () => 0);
    expect(a1).toBe(a2); // shared serialization chain for one hot signer
    expect(a1).not.toBe(b);
  });

  it("resetNonceManagers() drops all managers", () => {
    const before = getNonceManager("0x0000000000000000000000000000000000000003", async () => 0);
    resetNonceManagers();
    const after = getNonceManager("0x0000000000000000000000000000000000000003", async () => 0);
    expect(after).not.toBe(before);
  });
});
