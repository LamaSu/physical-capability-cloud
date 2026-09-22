// A prior version reported success when the gateway was unreachable.
// This module makes "did a server actually confirm this?" an explicit,
// testable decision, separate from generating proposed IDs or rendering UI.

import type {
  GenerateConfigResponse,
  RegisterDeviceResponse,
} from "../../lib/api.js";

export type RegistrationOutcome =
  | { status: "confirmed"; deviceId: string; kernelId: string; confirmedBy: string }
  | { status: "unconfirmed"; deviceId: string; kernelId: string; reason: string }
  | { status: "failed"; errorMessage: string };

export interface RegisterMachineInput {
  name: string;
  manufacturer?: string;
  model?: string;
  capabilityIds: string[];
}

export interface RegisterMachineDeps {
  post: <T>(path: string, body: unknown) => Promise<T>;
  now?: () => number;
}

function getErrorMessage(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    if (
      typeof err === "object" &&
      err !== null &&
      "message" in err &&
      typeof err.message === "string"
    ) {
      return err.message;
    }
    return String(err);
  } catch {
    return "Unknown error";
  }
}

// fetch() reports transport failures as TypeError. The message fallback accepts
// only the exact browser/runtime transport messages: a server rejection that merely
// CONTAINS one of these phrases (e.g. "Kernel 'kernel_networkerror_…' not found" for
// a machine named "NetworkError") must still count as the server answering.
const TRANSPORT_FAILURE_MESSAGE =
  /^(?:typeerror:\s*)?(?:failed to fetch|networkerror when attempting to fetch resource\.?|network request failed|load failed)$/i;

export function isNetworkError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    TRANSPORT_FAILURE_MESSAGE.test(getErrorMessage(err).trim())
  );
}

export function describeRegistrationFailure(errorMessage: string): string | null {
  if (
    /kernel[_ ]not[_ ]found/i.test(errorMessage) ||
    /kernel\s+(['"])[^'"]+\1\s+not\s+found/i.test(errorMessage)
  ) {
    return "The gateway has no registered site (kernel) for this machine yet, so the device could not be attached and nothing was registered.";
  }

  return null;
}

export async function registerMachine(
  input: RegisterMachineInput,
  deps: RegisterMachineDeps,
): Promise<RegistrationOutcome> {
  try {
    const deviceName = input.name || "unnamed-device";
    const slug = deviceName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const proposedKernelId = `kernel_${slug}_${(deps.now ?? Date.now)()}`;
    const proposedDeviceId = `dev_${slug}_000`;
    const model =
      [input.manufacturer, input.model].filter(Boolean).join(" ") || "unknown";

    let kernelId = proposedKernelId;
    let deviceId = proposedDeviceId;
    let firstServerError: string | undefined;

    const recordFailure = (err: unknown) => {
      if (!isNetworkError(err) && firstServerError === undefined) {
        firstServerError = getErrorMessage(err);
      }
    };

    // Generating IDs does not register a device.
    try {
      const generatedConfig = await deps.post<GenerateConfigResponse>(
        "/setup/generate-config",
        {
          kernelId: proposedKernelId,
          devices: [
            {
              name: deviceName,
              type: "machine",
              adapterType: "mock",
            },
          ],
          mockMode: true,
        },
      );
      kernelId = generatedConfig.config.kernelId ?? proposedKernelId;
      deviceId = generatedConfig.config.devices[0]?.id ?? proposedDeviceId;
    } catch (err) {
      kernelId = proposedKernelId;
      deviceId = proposedDeviceId;
      recordFailure(err);
    }

    try {
      const registeredDevice = await deps.post<RegisterDeviceResponse>(
        "/setup/register-device",
        {
          kernelId,
          deviceId,
          type: "machine",
          model,
          adapterType: "mock",
          adapterConfig: { mockMode: true },
          capabilities: input.capabilityIds,
        },
      );

      return {
        status: "confirmed",
        deviceId: registeredDevice?.device?.id ?? deviceId,
        kernelId,
        confirmedBy: "/setup/register-device",
      };
    } catch (err) {
      recordFailure(err);
    }

    // Attempt broader registration only if setup registration did not confirm.
    try {
      const registeredDevice = await deps.post<{ device: unknown }>(
        "/devices/register",
        {
          kernelId,
          id: deviceId,
          type: "machine",
          model,
          adapterType: "mock",
          adapterConfig: { mockMode: true },
          capabilities: input.capabilityIds,
        },
      );
      const device = registeredDevice?.device;

      return {
        status: "confirmed",
        deviceId:
          typeof device === "object" &&
          device !== null &&
          "id" in device &&
          typeof device.id === "string"
            ? device.id
            : deviceId,
        kernelId,
        confirmedBy: "/devices/register",
      };
    } catch (err) {
      recordFailure(err);
    }

    if (firstServerError !== undefined) {
      return { status: "failed", errorMessage: firstServerError };
    }

    return {
      status: "unconfirmed",
      deviceId,
      kernelId,
      reason:
        "The gateway was unreachable during registration; no server confirmed your machine.",
    };
  } catch (err) {
    return { status: "failed", errorMessage: getErrorMessage(err) };
  }
}
