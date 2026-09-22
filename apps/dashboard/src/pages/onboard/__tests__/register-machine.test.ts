import { describe, it, expect } from "vitest";
import { describeRegistrationFailure, isNetworkError, registerMachine } from "../register-machine.js";
import type {
  RegisterMachineDeps,
  RegisterMachineInput,
} from "../register-machine.js";
import type {
  GenerateConfigResponse,
  RegisterDeviceResponse,
} from "../../../lib/api.js";

const timestamp = 1_700_000_000_000;
const proposedKernelId = "kernel_precision_mill_01_1700000000000";
const proposedDeviceId = "dev_precision_mill_01_000";

const input: RegisterMachineInput = {
  name: "Precision Mill 01",
  manufacturer: "Acme",
  model: "M1",
  capabilityIds: ["cnc-milling", "drilling"],
};

const generatedConfig: GenerateConfigResponse = {
  config: {
    kernelId: "kernel_server_generated",
    devices: [
      {
        id: "device_config_generated",
        type: "machine",
        adapterType: "mock",
        config: { mockMode: true },
      },
    ],
    mockMode: true,
  },
  envLine: "KERNEL_ID=kernel_server_generated",
  configJson: "{}",
};

const registeredDevice: RegisterDeviceResponse = {
  registered: true,
  device: {
    id: "device_server_confirmed",
    kernelId: "kernel_server_generated",
    type: "machine",
    model: "Acme M1",
    adapterType: "mock",
    status: "idle",
  },
};

function fakeGateway(
  respond: (path: string, body: unknown) => unknown | Promise<unknown>,
) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const deps: RegisterMachineDeps = {
    now: () => timestamp,
    post: async <T>(path: string, body: unknown): Promise<T> => {
      calls.push({ path, body });
      return (await respond(path, body)) as T;
    },
  };

  return { deps, calls };
}

describe("registerMachine", () => {
  it("never confirms registration when every request fails to fetch", async () => {
    // Regression: the previous implementation fabricated success while offline.
    const { deps, calls } = fakeGateway(() => {
      throw new TypeError("Failed to fetch");
    });

    const outcome = await registerMachine(input, deps);

    expect(outcome.status).toBe("unconfirmed");
    expect(outcome.status).not.toBe("confirmed");
    expect(calls.map((call) => call.path)).toEqual([
      "/setup/generate-config",
      "/setup/register-device",
      "/devices/register",
    ]);
  });

  it("carries deterministic proposed IDs and explains gateway unreachability", async () => {
    const { deps } = fakeGateway(() =>
      Promise.reject(new TypeError("Network request failed")),
    );

    const outcome = await registerMachine(input, deps);

    expect(outcome.status).toBe("unconfirmed");
    if (outcome.status !== "unconfirmed") {
      throw new Error("Expected an unconfirmed outcome");
    }
    expect(outcome.deviceId).toBe(proposedDeviceId);
    expect(outcome.kernelId).toBe(proposedKernelId);
    expect(outcome.reason).toMatch(/gateway/i);
    expect(outcome.reason).toMatch(/unreachable/i);
  });

  it("does not count successful config generation as registration confirmation", async () => {
    const { deps } = fakeGateway((path) => {
      if (path === "/setup/generate-config") return generatedConfig;
      throw new TypeError("Failed to fetch");
    });

    const outcome = await registerMachine(input, deps);

    expect(outcome.status).toBe("unconfirmed");
    if (outcome.status !== "unconfirmed") {
      throw new Error("Expected an unconfirmed outcome");
    }
    expect(outcome.deviceId).toBe("device_config_generated");
    expect(outcome.kernelId).toBe("kernel_server_generated");
  });

  it("confirms setup registration using the returned ID and skips broader registration", async () => {
    const { deps, calls } = fakeGateway((path) => {
      if (path === "/setup/generate-config") return generatedConfig;
      if (path === "/setup/register-device") return registeredDevice;
      throw new Error(`Unexpected request: ${path}`);
    });

    const outcome = await registerMachine(input, deps);

    expect(outcome.status).toBe("confirmed");
    if (outcome.status !== "confirmed") {
      throw new Error("Expected a confirmed outcome");
    }
    expect(outcome.confirmedBy).toBe("/setup/register-device");
    expect(outcome.deviceId).toBe("device_server_confirmed");
    expect(outcome.kernelId).toBe("kernel_server_generated");
    expect(calls.map((call) => call.path)).toEqual([
      "/setup/generate-config",
      "/setup/register-device",
    ]);
  });

  it("confirms broader registration after kernel_not_found and preserves request bodies", async () => {
    const { deps, calls } = fakeGateway((path) => {
      if (path === "/setup/generate-config") return generatedConfig;
      if (path === "/setup/register-device") {
        throw new Error("kernel_not_found");
      }
      if (path === "/devices/register") {
        return { device: { id: "device_broader_confirmed" } };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const outcome = await registerMachine(input, deps);

    expect(outcome.status).toBe("confirmed");
    if (outcome.status !== "confirmed") {
      throw new Error("Expected a confirmed outcome");
    }
    expect(outcome.confirmedBy).toBe("/devices/register");
    expect(outcome.deviceId).toBe("device_broader_confirmed");
    expect(outcome.kernelId).toBe("kernel_server_generated");
    expect(calls).toEqual([
      {
        path: "/setup/generate-config",
        body: {
          kernelId: proposedKernelId,
          devices: [
            {
              name: "Precision Mill 01",
              type: "machine",
              adapterType: "mock",
            },
          ],
          mockMode: true,
        },
      },
      {
        path: "/setup/register-device",
        body: {
          kernelId: "kernel_server_generated",
          deviceId: "device_config_generated",
          type: "machine",
          model: "Acme M1",
          adapterType: "mock",
          adapterConfig: { mockMode: true },
          capabilities: ["cnc-milling", "drilling"],
        },
      },
      {
        path: "/devices/register",
        body: {
          kernelId: "kernel_server_generated",
          id: "device_config_generated",
          type: "machine",
          model: "Acme M1",
          adapterType: "mock",
          adapterConfig: { mockMode: true },
          capabilities: ["cnc-milling", "drilling"],
        },
      },
    ]);
  });

  it("surfaces the first server error when both registration endpoints reject", async () => {
    const { deps } = fakeGateway((path) => {
      if (path === "/setup/generate-config") return generatedConfig;
      if (path === "/setup/register-device") {
        throw new Error("kernel_not_found");
      }
      throw new Error("API error: 503");
    });

    const outcome = await registerMachine(input, deps);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") {
      throw new Error("Expected a failed outcome");
    }
    expect(outcome.errorMessage).toBe("kernel_not_found");
  });

  it("preserves a helper server error when subsequent registration calls network-fail", async () => {
    const { deps, calls } = fakeGateway((path) => {
      if (path === "/setup/generate-config") {
        throw new Error("Config generation rejected");
      }
      throw new TypeError("Failed to fetch");
    });

    const outcome = await registerMachine(input, deps);

    expect(outcome).toEqual({
      status: "failed",
      errorMessage: "Config generation rejected",
    });
    expect(calls).toHaveLength(3);
  });

  it("lets a registration confirmation override earlier helper and transport errors", async () => {
    const { deps } = fakeGateway((path) => {
      if (path === "/setup/generate-config") {
        throw new Error("Config generation rejected");
      }
      if (path === "/setup/register-device") {
        throw new TypeError("Failed to fetch");
      }
      return { device: { id: "device_broader_confirmed" } };
    });

    const outcome = await registerMachine(input, deps);

    expect(outcome).toEqual({
      status: "confirmed",
      deviceId: "device_broader_confirmed",
      kernelId: proposedKernelId,
      confirmedBy: "/devices/register",
    });
  });

  it("does not hide a server error containing the bare word fetch", async () => {
    const { deps } = fakeGateway((path) => {
      if (path === "/setup/register-device") {
        throw new Error("could not fetch kernel record");
      }
      throw new TypeError("Failed to fetch");
    });

    const outcome = await registerMachine(input, deps);

    expect(outcome).toEqual({
      status: "failed",
      errorMessage: "could not fetch kernel record",
    });
  });

  it("does not mistake a server rejection that echoes a 'NetworkError' machine name for an outage", async () => {
    // Found in cross-family review: the kernel id is derived from the machine
    // name, so the gateway's own rejection message can contain "networkerror".
    const kernelId = "kernel_networkerror_1700000000000";
    const { deps } = fakeGateway((path) => {
      if (path === "/setup/generate-config") {
        return {
          ...generatedConfig,
          config: { ...generatedConfig.config, kernelId },
        };
      }
      if (path === "/setup/register-device") {
        throw new TypeError("Failed to fetch");
      }
      throw new Error(`Kernel '${kernelId}' not found`);
    });

    const outcome = await registerMachine(
      { ...input, name: "NetworkError" },
      deps,
    );

    expect(outcome).toEqual({
      status: "failed",
      errorMessage: `Kernel '${kernelId}' not found`,
    });
  });

  it("uses the unnamed-device and unknown-model fallbacks", async () => {
    const { deps, calls } = fakeGateway(() => {
      throw new TypeError("Failed to fetch");
    });

    const outcome = await registerMachine(
      { name: "", capabilityIds: [] },
      deps,
    );

    expect(outcome).toEqual({
      status: "unconfirmed",
      deviceId: "dev_unnamed_device_000",
      kernelId: "kernel_unnamed_device_1700000000000",
      reason: expect.stringMatching(/gateway/i),
    });
    expect(calls[0]?.body).toEqual({
      kernelId: "kernel_unnamed_device_1700000000000",
      devices: [
        {
          name: "unnamed-device",
          type: "machine",
          adapterType: "mock",
        },
      ],
      mockMode: true,
    });
    expect(calls[1]?.body).toEqual({
      kernelId: "kernel_unnamed_device_1700000000000",
      deviceId: "dev_unnamed_device_000",
      type: "machine",
      model: "unknown",
      adapterType: "mock",
      adapterConfig: { mockMode: true },
      capabilities: [],
    });
  });

  it.each([
    ["string", "registration denied", "registration denied"],
    ["object", { message: "backend rejected" }, "backend rejected"],
    ["null", null, "null"],
  ])("resolves instead of throwing for a non-Error %s rejection", async (
    _label,
    rejection,
    message,
  ) => {
    const { deps } = fakeGateway(() => Promise.reject(rejection));

    await expect(registerMachine(input, deps)).resolves.toEqual({
      status: "failed",
      errorMessage: message,
    });
  });

  it("resolves even when a rejected value cannot be converted to a string", async () => {
    const rejection = {
      toString() {
        throw new Error("String conversion failed");
      },
    };
    const { deps } = fakeGateway(() => Promise.reject(rejection));

    await expect(registerMachine(input, deps)).resolves.toEqual({
      status: "failed",
      errorMessage: "Unknown error",
    });
  });

  it("resolves a failed outcome if the injected clock throws", async () => {
    const { deps, calls } = fakeGateway(() => {
      throw new Error("Unexpected request");
    });
    deps.now = () => {
      throw new Error("Clock unavailable");
    };

    await expect(registerMachine(input, deps)).resolves.toEqual({
      status: "failed",
      errorMessage: "Clock unavailable",
    });
    expect(calls).toEqual([]);
  });
});

describe("isNetworkError", () => {
  it.each([
    new TypeError("An arbitrary transport failure"),
    new Error("FAILED TO FETCH"),
    new Error("NetworkError when attempting to fetch resource"),
    new Error("Network Request Failed"),
    new Error("LOAD FAILED"),
    "failed to fetch",
    { message: "network request failed" },
  ])("recognizes transport failure %s", (err) => {
    expect(isNetworkError(err)).toBe(true);
  });

  it("does not classify a server message containing fetch as a network error", () => {
    expect(isNetworkError(new Error("could not fetch kernel record"))).toBe(false);
  });

  it.each([
    new Error("Kernel 'kernel_networkerror_1700000000000' not found"),
    new Error("upstream NetworkError while proxying"),
    new Error("device load failed validation"),
  ])("does not classify a server message that merely contains a transport phrase: %s", (err) => {
    expect(isNetworkError(err)).toBe(false);
  });

  it.each([
    new Error("kernel_not_found"),
    new Error("API error: 500"),
    new Error("Permission denied"),
  ])("does not classify server rejection %s as a network error", (err) => {
    expect(isNetworkError(err)).toBe(false);
  });
});

describe("describeRegistrationFailure", () => {
  it.each([
    "kernel_not_found",
    "KERNEL NOT FOUND",
    "Kernel 'kernel_x' not found",
  ])("explains the missing registered site for %s", (errorMessage) => {
    expect(describeRegistrationFailure(errorMessage)).toBe(
      "The gateway has no registered site (kernel) for this machine yet, so the device could not be attached and nothing was registered.",
    );
  });

  it("returns null for unrelated server errors", () => {
    expect(describeRegistrationFailure("API error: 503")).toBeNull();
  });
});
