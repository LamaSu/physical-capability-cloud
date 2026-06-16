/**
 * Tests for config resolution. We never touch the user's real
 * ~/.pcc/config.json — homedir() is overridden to a tmp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We need to import the module fresh per test to pick up the mocked homedir.
async function importConfig(): Promise<typeof import("../lib/config.js")> {
  vi.resetModules();
  return await import("../lib/config.js");
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "pcc-onboard-test-"));
  vi.doMock("node:os", async () => {
    const real = await vi.importActual<typeof import("node:os")>("node:os");
    return {
      ...real,
      homedir: () => tmpHome,
    };
  });
});

afterEach(() => {
  vi.doUnmock("node:os");
  if (tmpHome && existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

describe("resolveConfig", () => {
  it("returns defaults when nothing is set", async () => {
    const savedEnv = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PCC_GATEWAY_URL;
    delete process.env.PCC_URL;
    delete process.env.ANTHROPIC_MODEL;
    try {
      const cfg = (await importConfig()).resolveConfig();
      expect(cfg.gatewayUrl).toBe("https://capability.network");
      expect(cfg.model).toBe("claude-sonnet-4-6");
      expect(cfg.persist).toBe(false);
      expect(cfg.anthropicApiKey).toBeUndefined();
    } finally {
      process.env = savedEnv;
    }
  });

  it("prefers flags over env and over file", async () => {
    const { resolveConfig, getConfigPath } = await importConfig();
    mkdirSync(join(tmpHome, ".pcc"), { recursive: true });
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ anthropicApiKey: "file-key", gatewayUrl: "https://file" }),
    );
    process.env.ANTHROPIC_API_KEY = "env-key";
    process.env.PCC_GATEWAY_URL = "https://env";

    try {
      const cfg = resolveConfig({ apiKey: "flag-key", gateway: "https://flag" });
      expect(cfg.anthropicApiKey).toBe("flag-key");
      expect(cfg.gatewayUrl).toBe("https://flag");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.PCC_GATEWAY_URL;
    }
  });

  it("reads PCC_URL as a gateway fallback when PCC_GATEWAY_URL is unset", async () => {
    const { resolveConfig } = await importConfig();
    delete process.env.PCC_GATEWAY_URL;
    process.env.PCC_URL = "https://from-pcc-url";
    try {
      const cfg = resolveConfig();
      expect(cfg.gatewayUrl).toBe("https://from-pcc-url");
    } finally {
      delete process.env.PCC_URL;
    }
  });
});

describe("writeConfigFile", () => {
  it("writes the file but strips persist", async () => {
    const { writeConfigFile, getConfigPath } = await importConfig();
    writeConfigFile({
      anthropicApiKey: "sk-test",
      gatewayUrl: "https://capability.network",
      model: "claude-sonnet-4-6",
      persist: true, // should be stripped from disk
    });
    const path = getConfigPath();
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.anthropicApiKey).toBe("sk-test");
    expect(parsed.persist).toBeUndefined();
  });
});
