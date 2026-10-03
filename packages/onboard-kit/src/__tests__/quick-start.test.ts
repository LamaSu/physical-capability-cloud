/**
 * quickStart never simulates silently (PX-10).
 *
 * Before: without machineApi it quietly ran a mock machine, sensor and camera;
 * and even WITH machineApi the kernel agent never received the configured
 * adapters, so every job it accepted ran on its own MockFDMAdapter and was
 * signed with the agent's wallet like real evidence.  Now "live" (the
 * default) runs jobs on the configured machine and simulates nothing, and
 * "demo" simulates everything, is tagged, and never talks to a gateway.
 */

import { afterEach, describe, expect, it } from "vitest";
import { quickStart, QuickStartConfigError, type QuickStartConfig } from "../quick-start.js";
import type { GenericHttpAdapterConfig } from "../templates/generic-http-adapter.js";

const KERNEL = "kernel_qs_test";

const machineApi: GenericHttpAdapterConfig = {
  baseUrl: "http://192.0.2.10:8080",
  kernelId: KERNEL,
  machineType: "fdm",
  endpoints: {
    status: { method: "GET", path: "/status" },
    progress: { method: "GET", path: "/progress" },
    loadProgram: { method: "POST", path: "/load" },
    start: { method: "POST", path: "/start" },
    stop: { method: "POST", path: "/stop" },
  },
  statusMapping: { statusField: "state", map: { ready: "idle" }, default: "idle" },
  progressMapping: { progressField: "percent" },
};

const base: QuickStartConfig = {
  kernelId: KERNEL,
  name: "Test Shop",
  location: { lat: 0, lng: 0 },
  capability: {
    type: "fdm",
    name: "Printer",
    materials: ["pla"],
    assuranceTiers: [0],
    pricing: { baseCost: "1.00", perMinute: "0.10", minimum: "1.00" },
  },
};

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

async function start(config: QuickStartConfig) {
  const result = await quickStart(config);
  stops.push(result.stop);
  return { result, agent: result.kernelAgent as any };
}

describe("quickStart refuses a configuration that would run something else", () => {
  it("live mode (the default) needs machineApi", async () => {
    await expect(quickStart(base)).rejects.toThrow(QuickStartConfigError);
    await expect(quickStart(base)).rejects.toThrow(/machineApi.*mode: "demo"/);
  });

  it.each([
    ["machineApi", { machineApi: { ...machineApi, mockMode: true } }],
    ["sensorApi", { machineApi, sensorApi: { readingUrl: "http://192.0.2.11/r", kernelId: KERNEL, channel: "power", unit: "W", sensorType: "power_monitor", valueField: "w", mockMode: true } }],
    ["cameraApi", { machineApi, cameraApi: { captureUrl: "http://192.0.2.12/c", kernelId: KERNEL, imageHashField: "hash", storageRefField: "url", mockMode: true } }],
  ] as const)("live mode refuses %s.mockMode", async (label, extra) => {
    await expect(quickStart({ ...base, ...(extra as any) })).rejects.toThrow(new RegExp(`${label}.mockMode`));
  });

  it("demo mode refuses a gateway: simulated evidence must not reach settlement", async () => {
    await expect(quickStart({ ...base, mode: "demo", gatewayUrl: "https://capability.network" })).rejects.toThrow(
      QuickStartConfigError,
    );
  });

  it("an unknown mode is refused", async () => {
    await expect(quickStart({ ...base, mode: "staging" as any, machineApi })).rejects.toThrow(/mode must be/);
  });
});

describe("live mode runs jobs on the configured machine and simulates nothing", () => {
  it("the kernel agent executes with the configured machine, not its own simulator", async () => {
    const { result, agent } = await start({ ...base, machineApi });
    expect(result.mode).toBe("live");
    expect(agent.machine.id).toBe(`dev_machine_${KERNEL}`);
    expect(agent.machine.constructor.name).not.toBe("MockFDMAdapter");
  });

  it("without a sensor or camera API there is no sensor and no camera", async () => {
    const { agent } = await start({ ...base, machineApi });
    expect(agent.sensors).toEqual([]);
    expect(agent.camera).toBeNull();
  });

  it("a configured camera and sensor are the ones used", async () => {
    const { agent } = await start({
      ...base,
      machineApi,
      sensorApi: { readingUrl: "http://192.0.2.11/r", kernelId: KERNEL, channel: "power", unit: "W", sensorType: "power_monitor", valueField: "w" },
      cameraApi: { captureUrl: "http://192.0.2.12/c", kernelId: KERNEL, imageHashField: "hash", storageRefField: "url" },
    });
    expect(agent.sensors.map((s: any) => s.id)).toEqual([`dev_sensor_${KERNEL}`]);
    expect(agent.camera.id).toBe(`dev_camera_${KERNEL}`);
  });

  it("there is no default gateway: without one nothing settles", async () => {
    const { agent } = await start({ ...base, machineApi });
    expect(agent.settlement).toBeUndefined();
  });

  it("an explicit gateway is used for settlement", async () => {
    const { agent } = await start({ ...base, machineApi, gatewayUrl: "http://192.0.2.20:3200" });
    expect(agent.settlement).toBeDefined();
  });

  it("the capability is not tagged demo", async () => {
    const { result } = await start({ ...base, machineApi });
    expect(result.capability.tags).toBeUndefined();
  });
});

describe("demo mode simulates everything, says so, and never settles", () => {
  it("is tagged demo and reports its mode", async () => {
    const { result } = await start({ ...base, mode: "demo" });
    expect(result.mode).toBe("demo");
    expect(result.capability.tags).toEqual(["demo"]);
  });

  it("runs on the SDK's own simulated devices, with no gateway", async () => {
    const { agent } = await start({ ...base, mode: "demo", machineApi });
    expect(agent.machine.id).toBe(`dev_machine_${KERNEL}`);
    expect(agent.sensors).toHaveLength(1);
    expect(agent.camera).not.toBeNull();
    expect(agent.settlement).toBeUndefined();
  });
});
