/**
 * Tests for @pcc/alerts config loader.
 *
 * Author: implementer-alpha
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAlertsConfig, alertsConfigSchema } from "../config.js";

describe("alertsConfigSchema", () => {
  it("accepts an empty object and fills defaults", () => {
    const parsed = alertsConfigSchema.parse({});
    expect(parsed.host).toBe("0.0.0.0");
    expect(parsed.port).toBe(8787);
    expect(parsed.ringBufferSize).toBe(500);
    expect(parsed.chainWatchers).toEqual([]);
    expect(parsed.rpcProbes).toEqual([]);
    expect(parsed.heartbeats).toEqual([]);
    expect(parsed.notifiers).toEqual({});
  });

  it("rejects malformed contract addresses", () => {
    expect(() =>
      alertsConfigSchema.parse({
        chainWatchers: [
          {
            label: "escrow",
            chain: "base-sepolia",
            rpcUrl: "https://sepolia.base.org",
            address: "not-an-address",
            abi: [],
            events: [{ name: "Released" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts a valid contract address and event list", () => {
    const parsed = alertsConfigSchema.parse({
      chainWatchers: [
        {
          label: "escrow",
          chain: "base-sepolia",
          rpcUrl: "https://sepolia.base.org",
          address: "0x10059efeeab1ddf013489e9597a3aec4480d95e1",
          abi: [],
          events: [{ name: "Released", onFire: "info", whitelist: ["0xabc"] }],
        },
      ],
    });
    expect(parsed.chainWatchers).toHaveLength(1);
    expect(parsed.chainWatchers[0]!.events[0]!.whitelistArg).toBe("caller");
  });

  it("fills rpcProbe defaults", () => {
    const parsed = alertsConfigSchema.parse({
      rpcProbes: [
        {
          label: "base",
          rpcUrl: "https://sepolia.base.org",
          chain: "base-sepolia",
        },
      ],
    });
    expect(parsed.rpcProbes[0]!.intervalMs).toBe(30_000);
    expect(parsed.rpcProbes[0]!.p95WarnMs).toBe(2000);
    expect(parsed.rpcProbes[0]!.consecutiveWindows).toBe(3);
    expect(parsed.rpcProbes[0]!.windowSize).toBe(10);
  });

  it("fills heartbeat default grace window to 5 minutes", () => {
    const parsed = alertsConfigSchema.parse({
      heartbeats: [{ worker: "oracle-worker" }],
    });
    expect(parsed.heartbeats[0]!.maxSilenceMs).toBe(300_000);
  });

  it("rejects bad discord webhook URL", () => {
    expect(() =>
      alertsConfigSchema.parse({ notifiers: { discord: { webhookUrl: "not-a-url" } } }),
    ).toThrow();
  });
});

describe("loadAlertsConfig", () => {
  const originalEnv = { ...process.env };
  let tmpDir: string | null = null;

  beforeEach(() => {
    delete process.env.ALERTS_CONFIG;
    delete process.env.ALERTS_CONFIG_FILE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("returns empty defaults when no env set", () => {
    const cfg = loadAlertsConfig();
    expect(cfg.chainWatchers).toEqual([]);
    expect(cfg.rpcProbes).toEqual([]);
    expect(cfg.heartbeats).toEqual([]);
  });

  it("loads inline ALERTS_CONFIG JSON", () => {
    process.env.ALERTS_CONFIG = JSON.stringify({
      port: 9090,
      heartbeats: [{ worker: "ws-1" }],
    });
    const cfg = loadAlertsConfig();
    expect(cfg.port).toBe(9090);
    expect(cfg.heartbeats).toHaveLength(1);
    expect(cfg.heartbeats[0]!.worker).toBe("ws-1");
  });

  it("throws on malformed inline JSON", () => {
    process.env.ALERTS_CONFIG = "{not-json";
    expect(() => loadAlertsConfig()).toThrow(/Failed to parse ALERTS_CONFIG/);
  });

  it("loads ALERTS_CONFIG_FILE", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "alerts-cfg-"));
    const path = join(tmpDir, "alerts.json");
    writeFileSync(path, JSON.stringify({ port: 7777 }));
    process.env.ALERTS_CONFIG_FILE = path;
    const cfg = loadAlertsConfig();
    expect(cfg.port).toBe(7777);
  });

  it("throws a useful error when ALERTS_CONFIG_FILE doesn't exist", () => {
    process.env.ALERTS_CONFIG_FILE = "/nonexistent/path/xyz.json";
    expect(() => loadAlertsConfig()).toThrow(/Failed to read ALERTS_CONFIG_FILE/);
  });

  it("surfaces Zod validation errors from file content", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "alerts-cfg-"));
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, JSON.stringify({ port: -1 }));
    process.env.ALERTS_CONFIG_FILE = path;
    expect(() => loadAlertsConfig()).toThrow();
  });
});
