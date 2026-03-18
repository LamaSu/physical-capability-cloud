import { describe, it, expect } from "vitest";
import { validate } from "../validate.js";
import type { OnboardConfig } from "../types.js";

function makeValidConfig(): OnboardConfig {
  return {
    kernel: {
      kernelId: "kernel_test_001",
      name: "Test Workshop",
      location: { lat: 37.77, lng: -122.41 },
      walletPrivateKeyEnvVar: "KERNEL_PRIVATE_KEY",
      gatewayUrl: "http://localhost:3200",
      httpPort: 3100,
    },
    adapters: [
      {
        adapterId: "dev-machine-01",
        className: "TestMachine",
        adapterType: "machine",
        protocol: "http",
        connectionString: "http://localhost:8080",
        deviceType: "controller",
        firmwareVersion: "Test-1.0.0",
        endpoints: [
          { method: "GET", path: "/status", purpose: "status", description: "Status" },
          { method: "POST", path: "/start", purpose: "start", description: "Start" },
        ],
      },
      {
        adapterId: "dev-sensor-01",
        className: "TestSensor",
        adapterType: "sensor",
        protocol: "http",
        connectionString: "http://localhost:9090",
        deviceType: "sensor",
        firmwareVersion: "Sensor-1.0.0",
      },
    ],
    capabilities: [
      {
        type: "fdm",
        name: "Test Printer",
        materials: ["pla", "petg"],
        assuranceTiers: [0, 1],
        pricing: {
          currency: "USDC",
          baseCost: "5.00",
          perMinute: "0.10",
          minimum: "10.00",
        },
        adapterId: "dev-machine-01",
      },
    ],
  };
}

describe("validate", () => {
  it("should pass for a valid configuration", () => {
    const result = validate({ config: makeValidConfig() });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should fail for missing kernel ID", () => {
    const config = makeValidConfig();
    config.kernel.kernelId = "";
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.name.includes("kernelId"))).toBe(true);
  });

  it("should fail for invalid capability type", () => {
    const config = makeValidConfig();
    (config.capabilities[0] as any).type = "invalid-type";
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("Unknown capability type"))).toBe(true);
  });

  it("should fail for invalid currency", () => {
    const config = makeValidConfig();
    (config.capabilities[0].pricing as any).currency = "BTC";
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("Invalid currency"))).toBe(true);
  });

  it("should fail for missing adapters", () => {
    const config = makeValidConfig();
    config.adapters = [];
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("At least one adapter"))).toBe(true);
  });

  it("should fail for duplicate adapter IDs", () => {
    const config = makeValidConfig();
    config.adapters.push({ ...config.adapters[0] });
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("Duplicate adapter ID"))).toBe(true);
  });

  it("should fail for capability referencing non-existent adapter", () => {
    const config = makeValidConfig();
    config.capabilities[0].adapterId = "nonexistent";
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("does not exist"))).toBe(true);
  });

  it("should warn for tier 2 without camera adapter", () => {
    const config = makeValidConfig();
    config.capabilities[0].assuranceTiers = [0, 1, 2] as any;
    const result = validate({ config });
    expect(result.warnings.some(w => w.message.includes("camera adapter"))).toBe(true);
  });

  it("should warn for kernel ID not starting with kernel_", () => {
    const config = makeValidConfig();
    config.kernel.kernelId = "my-shop";
    const result = validate({ config });
    expect(result.warnings.some(w => w.message.includes("kernel_"))).toBe(true);
  });

  it("should fail for out-of-range location", () => {
    const config = makeValidConfig();
    config.kernel.location.lat = 200;
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.name.includes("lat"))).toBe(true);
  });
});
