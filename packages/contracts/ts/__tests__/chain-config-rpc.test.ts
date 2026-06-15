/**
 * Tests for getRpcUrls — the single source of truth for RPC failover ordering
 * (P2-SCALE feature #2). Pure: reads chain-config + env, returns an ordered,
 * deduped, non-empty URL list.
 */
import { describe, it, expect, afterEach } from "vitest";
import { getRpcUrls } from "../chain-config.js";

const ORIG = { ...process.env };
afterEach(() => {
  for (const k of ["PCC_RPC_URLS", "PCC_RPC_URL"]) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});

describe("getRpcUrls", () => {
  it("returns base-sepolia's configured primary + fallbacks (primary first, deduped)", () => {
    delete process.env.PCC_RPC_URLS;
    delete process.env.PCC_RPC_URL;
    const urls = getRpcUrls("base-sepolia");
    expect(urls[0]).toBe("https://sepolia.base.org");
    expect(urls.length).toBeGreaterThanOrEqual(2); // has fallbacks
    expect(new Set(urls).size).toBe(urls.length); // no duplicates
  });

  it("PCC_RPC_URLS overrides the list entirely (comma-separated, trimmed)", () => {
    process.env.PCC_RPC_URLS = "https://one.example, https://two.example ,https://one.example";
    const urls = getRpcUrls("base-sepolia");
    // Deduped + trimmed; the chain-config defaults are NOT appended.
    expect(urls).toEqual(["https://one.example", "https://two.example"]);
  });

  it("PCC_RPC_URL (single) becomes the primary, then the network fallbacks", () => {
    delete process.env.PCC_RPC_URLS;
    process.env.PCC_RPC_URL = "https://my-private-rpc.example";
    const urls = getRpcUrls("base-sepolia");
    expect(urls[0]).toBe("https://my-private-rpc.example");
    // Network fallbacks still appended (so the override gains failover too).
    expect(urls).toContain("https://base-sepolia-rpc.publicnode.com");
  });

  it("unknown network falls back to the default RPC (never empty)", () => {
    delete process.env.PCC_RPC_URLS;
    delete process.env.PCC_RPC_URL;
    const urls = getRpcUrls("no-such-network");
    expect(urls).toEqual(["https://sepolia.base.org"]);
  });

  it("a single-URL network (localhost) returns just its rpcUrl", () => {
    delete process.env.PCC_RPC_URLS;
    delete process.env.PCC_RPC_URL;
    const urls = getRpcUrls("localhost");
    expect(urls).toEqual(["http://127.0.0.1:8545"]);
  });
});
