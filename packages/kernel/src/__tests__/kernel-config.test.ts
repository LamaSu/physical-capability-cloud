/**
 * Tests for loadKernelConfig() and KernelConfig system.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadKernelConfig } from "../kernel-config.js";
import type { KernelConfig } from "../kernel-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withEnv(key: string, value: string, fn: () => void): void {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

function withoutEnv(key: string, fn: () => void): void {
  const prev = process.env[key];
  delete process.env[key];
  try {
    fn();
  } finally {
    if (prev !== undefined) {
      process.env[key] = prev;
    }
  }
}

// ---------------------------------------------------------------------------
// Default (mock) config
// ---------------------------------------------------------------------------

describe("loadKernelConfig — default config", () => {
  it("returns a valid KernelConfig when no env vars are set", () => {
    withoutEnv("KERNEL_CONFIG", () => {
      withoutEnv("KERNEL_CONFIG_FILE", () => {
        const config = loadKernelConfig();
        expect(config).toBeDefined();
        expect(typeof config.kernelId).toBe("string");
        expect(Array.isArray(config.devices)).toBe(true);
      });
    });
  });

  it("includes at least one mock device by default", () => {
    withoutEnv("KERNEL_CONFIG", () => {
      withoutEnv("KERNEL_CONFIG_FILE", () => {
        const config = loadKernelConfig();
        expect(config.devices.length).toBeGreaterThan(0);
        const hasMock = config.devices.some((d) => d.adapterType === "mock");
        expect(hasMock).toBe(true);
      });
    });
  });

  it("defaults to mockMode: true", () => {
    withoutEnv("KERNEL_CONFIG", () => {
      withoutEnv("KERNEL_CONFIG_FILE", () => {
        const config = loadKernelConfig();
        expect(config.mockMode).toBe(true);
      });
    });
  });

  it("uses KERNEL_ID env var for kernelId if set", () => {
    withoutEnv("KERNEL_CONFIG", () => {
      withoutEnv("KERNEL_CONFIG_FILE", () => {
        withEnv("KERNEL_ID", "kernel_test_xyz", () => {
          const config = loadKernelConfig();
          expect(config.kernelId).toBe("kernel_test_xyz");
        });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// KERNEL_CONFIG env var (inline JSON)
// ---------------------------------------------------------------------------

describe("loadKernelConfig — KERNEL_CONFIG env var", () => {
  const sampleConfig: KernelConfig = {
    kernelId: "kernel_test_001",
    mockMode: false,
    devices: [
      {
        id: "printer_01",
        type: "machine",
        adapterType: "octoprint",
        config: { url: "http://192.168.1.50:5000", apiKey: "abc123", kernelId: "kernel_test_001" },
      },
      {
        id: "sensor_01",
        type: "sensor",
        adapterType: "modbus",
        config: { host: "192.168.1.100", kernelId: "kernel_test_001", registerMap: [] },
      },
    ],
  };

  it("parses a JSON string from KERNEL_CONFIG", () => {
    withEnv("KERNEL_CONFIG", JSON.stringify(sampleConfig), () => {
      const config = loadKernelConfig();
      expect(config.kernelId).toBe("kernel_test_001");
      expect(config.mockMode).toBe(false);
      expect(config.devices).toHaveLength(2);
    });
  });

  it("correctly reads adapterType from env config", () => {
    withEnv("KERNEL_CONFIG", JSON.stringify(sampleConfig), () => {
      const config = loadKernelConfig();
      expect(config.devices[0].adapterType).toBe("octoprint");
      expect(config.devices[1].adapterType).toBe("modbus");
    });
  });

  it("throws on invalid JSON in KERNEL_CONFIG", () => {
    withEnv("KERNEL_CONFIG", "{ this is not valid json", () => {
      expect(() => loadKernelConfig()).toThrow(/KERNEL_CONFIG/);
    });
  });
});

// ---------------------------------------------------------------------------
// KERNEL_CONFIG_FILE env var
// ---------------------------------------------------------------------------

describe("loadKernelConfig — KERNEL_CONFIG_FILE env var", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `pcc-kernel-config-test-${Date.now()}.json`);
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it("reads and parses a JSON file", () => {
    const fileConfig: KernelConfig = {
      kernelId: "kernel_from_file",
      devices: [
        {
          id: "cnc_01",
          type: "machine",
          adapterType: "opcua",
          config: { endpoint: "opc.tcp://192.168.1.200:4840", kernelId: "kernel_from_file", machineType: "cnc-3axis", nodeMap: [] },
        },
      ],
    };
    writeFileSync(tmpFile, JSON.stringify(fileConfig), "utf-8");

    withoutEnv("KERNEL_CONFIG", () => {
      withEnv("KERNEL_CONFIG_FILE", tmpFile, () => {
        const config = loadKernelConfig();
        expect(config.kernelId).toBe("kernel_from_file");
        expect(config.devices[0].adapterType).toBe("opcua");
      });
    });
  });

  it("throws when KERNEL_CONFIG_FILE points to a non-existent file", () => {
    withoutEnv("KERNEL_CONFIG", () => {
      withEnv("KERNEL_CONFIG_FILE", "/nonexistent/path/config.json", () => {
        expect(() => loadKernelConfig()).toThrow(/KERNEL_CONFIG_FILE/);
      });
    });
  });

  it("KERNEL_CONFIG takes precedence over KERNEL_CONFIG_FILE", () => {
    const inlineConfig: KernelConfig = {
      kernelId: "kernel_inline",
      devices: [],
    };
    const fileConfig: KernelConfig = {
      kernelId: "kernel_file",
      devices: [],
    };

    writeFileSync(tmpFile, JSON.stringify(fileConfig), "utf-8");

    withEnv("KERNEL_CONFIG", JSON.stringify(inlineConfig), () => {
      withEnv("KERNEL_CONFIG_FILE", tmpFile, () => {
        const config = loadKernelConfig();
        // Inline JSON should win
        expect(config.kernelId).toBe("kernel_inline");
      });
    });
  });
});

// ---------------------------------------------------------------------------
// DeviceConfig shape validation
// ---------------------------------------------------------------------------

describe("KernelConfig device shapes", () => {
  it("accepts all supported adapterType values", () => {
    const types = ["octoprint", "modbus", "opcua", "sila", "generic-http", "mock"] as const;
    for (const adapterType of types) {
      const cfg: KernelConfig = {
        kernelId: "k1",
        devices: [{ id: "d1", type: "machine", adapterType, config: { kernelId: "k1" } }],
      };
      withEnv("KERNEL_CONFIG", JSON.stringify(cfg), () => {
        const loaded = loadKernelConfig();
        expect(loaded.devices[0].adapterType).toBe(adapterType);
      });
    }
  });

  it("accepts all device role types", () => {
    const roles = ["machine", "sensor", "camera"] as const;
    for (const type of roles) {
      const cfg: KernelConfig = {
        kernelId: "k1",
        devices: [{ id: "d1", type, adapterType: "mock", config: { kernelId: "k1" } }],
      };
      withEnv("KERNEL_CONFIG", JSON.stringify(cfg), () => {
        const loaded = loadKernelConfig();
        expect(loaded.devices[0].type).toBe(type);
      });
    }
  });
});
