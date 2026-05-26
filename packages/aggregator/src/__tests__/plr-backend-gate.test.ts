/**
 * Tests for plr-backend-gate.ts — feature-flag short-circuit, TTL cache,
 * BackendDisabledError surface, unregistered pass-through.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PLRBackendGate, type PLRRegistryReader } from "../plr-backend-gate.js";
import { BackendDisabledError } from "@pcc/spec";

const MODULE = "pylabrobot.liquid_handling.backends.hamilton.STAR";

function makeMockRegistry(opts: {
  records?: Record<
    string,
    { enabled: boolean; lastEnabledChange?: number; manifestCid?: string } | null
  >;
  authors?: Record<string, string>;
}): { registry: PLRRegistryReader; spies: Record<string, ReturnType<typeof vi.fn>> } {
  const records = opts.records ?? {};
  const authors = opts.authors ?? {};

  const getRecord = vi.fn(async (path: string) => {
    const r = records[path];
    if (r === undefined || r === null) return null;
    return {
      enabled: r.enabled,
      lastEnabledChange: r.lastEnabledChange ?? 1716700000,
      manifestCid: r.manifestCid ?? ("0x" + "0".repeat(64)),
    };
  });
  const isEnabled = vi.fn(async (path: string) => {
    const r = records[path];
    return r !== null && r !== undefined && r.enabled;
  });
  const authorOf = vi.fn(async (path: string) => {
    if (!authors[path]) throw new Error("no author");
    return authors[path];
  });

  return {
    registry: { getRecord, isEnabled, authorOf },
    spies: { getRecord, isEnabled, authorOf },
  };
}

describe("PLRBackendGate", () => {
  let now = 1000000;
  const advance = (ms: number) => {
    now += ms;
  };

  beforeEach(() => {
    now = 1000000;
  });

  it("short-circuits when feature flag is off (does not hit RPC)", async () => {
    const { registry, spies } = makeMockRegistry({});
    const gate = new PLRBackendGate({
      registry,
      enabledOverride: false,
      now: () => now,
    });

    await gate.assertEnabled(MODULE);
    expect(spies.getRecord).not.toHaveBeenCalled();
    expect(await gate.isEnabled(MODULE)).toBe(true);
  });

  it("passes through for unregistered backends when flag is on", async () => {
    const { registry, spies } = makeMockRegistry({});
    const gate = new PLRBackendGate({
      registry,
      enabledOverride: true,
      now: () => now,
    });

    await gate.assertEnabled(MODULE);
    expect(spies.getRecord).toHaveBeenCalledOnce();
  });

  it("throws BackendDisabledError for registered+disabled", async () => {
    const { registry } = makeMockRegistry({
      records: {
        [MODULE]: {
          enabled: false,
          lastEnabledChange: 1716799000,
          manifestCid: "0x" + "f".repeat(64),
        },
      },
      authors: { [MODULE]: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    const gate = new PLRBackendGate({
      registry,
      enabledOverride: true,
      now: () => now,
    });

    await expect(gate.assertEnabled(MODULE)).rejects.toThrow(BackendDisabledError);

    // Verify the thrown error carries all the diagnostic fields.
    try {
      await gate.assertEnabled(MODULE);
    } catch (e) {
      const err = e as BackendDisabledError;
      expect(err.modulePath).toBe(MODULE);
      expect(err.author).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(err.lastEnabledChange).toBe(1716799000);
    }
  });

  it("passes for registered+enabled", async () => {
    const { registry } = makeMockRegistry({
      records: { [MODULE]: { enabled: true } },
      authors: { [MODULE]: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    const gate = new PLRBackendGate({
      registry,
      enabledOverride: true,
      now: () => now,
    });
    await gate.assertEnabled(MODULE);
    expect(await gate.isEnabled(MODULE)).toBe(true);
  });

  it("caches results for TTL period", async () => {
    const { registry, spies } = makeMockRegistry({
      records: { [MODULE]: { enabled: true } },
    });
    const gate = new PLRBackendGate({
      registry,
      enabledOverride: true,
      ttlMs: 60_000,
      now: () => now,
    });

    // First call hits RPC.
    await gate.assertEnabled(MODULE);
    expect(spies.getRecord).toHaveBeenCalledTimes(1);

    // Within TTL — no extra RPC call.
    advance(59_000);
    await gate.assertEnabled(MODULE);
    expect(spies.getRecord).toHaveBeenCalledTimes(1);

    // Past TTL — re-fetch.
    advance(2_000);
    await gate.assertEnabled(MODULE);
    expect(spies.getRecord).toHaveBeenCalledTimes(2);
  });

  it("invalidate() drops a single cache entry", async () => {
    const { registry, spies } = makeMockRegistry({
      records: { [MODULE]: { enabled: true } },
    });
    const gate = new PLRBackendGate({
      registry,
      enabledOverride: true,
      ttlMs: 60_000,
      now: () => now,
    });

    await gate.assertEnabled(MODULE);
    expect(spies.getRecord).toHaveBeenCalledTimes(1);

    gate.invalidate(MODULE);
    await gate.assertEnabled(MODULE);
    expect(spies.getRecord).toHaveBeenCalledTimes(2);
  });

  it("isEnabled returns true for unregistered (registry shows null)", async () => {
    const { registry } = makeMockRegistry({});
    const gate = new PLRBackendGate({
      registry,
      enabledOverride: true,
      now: () => now,
    });
    expect(await gate.isEnabled(MODULE)).toBe(true);
  });

  it("isEnabled returns false for registered+disabled", async () => {
    const { registry } = makeMockRegistry({
      records: { [MODULE]: { enabled: false } },
    });
    const gate = new PLRBackendGate({
      registry,
      enabledOverride: true,
      now: () => now,
    });
    expect(await gate.isEnabled(MODULE)).toBe(false);
  });

  it("tolerates authorOf() reverts (NFT burned scenario)", async () => {
    const { registry } = makeMockRegistry({
      records: { [MODULE]: { enabled: false } },
      // No authors entry → authorOf throws
    });
    const gate = new PLRBackendGate({
      registry,
      enabledOverride: true,
      now: () => now,
    });

    try {
      await gate.assertEnabled(MODULE);
    } catch (e) {
      const err = e as BackendDisabledError;
      expect(err.author).toBeUndefined();
    }
  });

  it("clearCache() drops all entries", async () => {
    const { registry, spies } = makeMockRegistry({
      records: { [MODULE]: { enabled: true } },
    });
    const gate = new PLRBackendGate({
      registry,
      enabledOverride: true,
      ttlMs: 60_000,
      now: () => now,
    });

    await gate.assertEnabled(MODULE);
    expect(spies.getRecord).toHaveBeenCalledTimes(1);

    gate.clearCache();
    await gate.assertEnabled(MODULE);
    expect(spies.getRecord).toHaveBeenCalledTimes(2);
  });
});
