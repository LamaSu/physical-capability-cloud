/**
 * Tests for assertRpcChainId / assertRpcChainIds (security review PR #157 point 2):
 * a paid write must never be broadcast to an RPC on the wrong chain. The check is
 * a preflight the write path awaits (once, cached) before the first settlement tx.
 */
import { describe, it, expect } from "vitest";
import { assertRpcChainId, assertRpcChainIds } from "../contracts/rpc-transport.js";

// Fake fetch returning a canned eth_chainId result (hex). base-sepolia = 84532 = 0x14a34.
function fakeFetch(chainIdHex: string): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async () => ({ json: async () => ({ jsonrpc: "2.0", id: 1, result: chainIdHex }) })) as any;
}
function throwingFetch(): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as any;
}

describe("assertRpcChainId", () => {
  it("returns the chainId when the endpoint matches", async () => {
    const id = await assertRpcChainId("https://ok.example", 84532, { fetchImpl: fakeFetch("0x14a34") });
    expect(id).toBe(84532);
  });

  it("throws when the endpoint is on a different chain (wrong-chain broadcast risk)", async () => {
    await expect(
      assertRpcChainId("https://wrong.example", 84532, { fetchImpl: fakeFetch("0x1") }),
    ).rejects.toThrow(/on chain 1, expected 84532/);
  });

  it("throws when the endpoint is unreachable", async () => {
    await expect(
      assertRpcChainId("https://down.example", 84532, { fetchImpl: throwingFetch() }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("throws when eth_chainId returns no result", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const noResult = (async () => ({ json: async () => ({}) })) as any;
    await expect(
      assertRpcChainId("https://weird.example", 84532, { fetchImpl: noResult }),
    ).rejects.toThrow(/no result/);
  });
});

describe("assertRpcChainIds", () => {
  it("passes when every URL matches (whitespace-trimmed)", async () => {
    await expect(
      assertRpcChainIds(["https://a.example", " https://b.example "], 84532, {
        fetchImpl: fakeFetch("0x14a34"),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects (fails closed) if ANY URL is on the wrong chain", async () => {
    let n = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mixed = (async () => {
      n += 1;
      return { json: async () => ({ result: n === 1 ? "0x14a34" : "0x1" }) };
    }) as any;
    await expect(
      assertRpcChainIds(["https://a.example", "https://b.example"], 84532, { fetchImpl: mixed }),
    ).rejects.toThrow(/expected 84532/);
  });
});
