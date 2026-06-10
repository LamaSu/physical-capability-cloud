/**
 * Kernel configuration system.
 *
 * Loads device configuration from environment variables or a JSON config file,
 * then instantiates the appropriate adapters via the AdapterFactory.
 *
 * Priority order:
 *   1. KERNEL_CONFIG env var (JSON string)
 *   2. KERNEL_CONFIG_FILE env var (path to JSON file)
 *   3. Default mock config (for dev)
 */

import { readFileSync } from "node:fs";

/** Type of device this config describes */
export type DeviceRole = "machine" | "sensor" | "camera";

/** Adapter implementation to use for a device */
export type AdapterType =
  | "octoprint"
  | "modbus"
  | "opcua"
  | "sila"
  | "ipp"
  | "opentrons"
  | "hamilton"
  | "trilobio"
  | "generic-http"
  | "mock";

/** Configuration for a single physical device */
export interface DeviceConfig {
  /** Unique device ID within this kernel */
  id: string;
  /** Role of this device in the kernel */
  type: DeviceRole;
  /** Which adapter implementation to use */
  adapterType: AdapterType;
  /** Adapter-specific configuration (passed through to the adapter constructor) */
  config: Record<string, unknown>;
}

/** Top-level kernel configuration */
export interface KernelConfig {
  /** Unique identifier for this kernel instance */
  kernelId: string;
  /** Devices to instantiate on startup */
  devices: DeviceConfig[];
  /** Where to store evidence (default: local) */
  evidenceStorage?: "local" | "ipfs" | "storacha";
  /**
   * Force all adapters into mock mode regardless of adapterType.
   * Useful for CI, demo environments, or when real hardware is unavailable.
   */
  mockMode?: boolean;
}

// ---------------------------------------------------------------------------
// Default config (used when no env vars are set)
// ---------------------------------------------------------------------------

function buildDefaultConfig(): KernelConfig {
  const kernelId = process.env.KERNEL_ID ?? "kernel_dev_001";
  return {
    kernelId,
    mockMode: true,
    devices: [
      {
        id: "dev_fdm_001",
        type: "machine",
        adapterType: "mock",
        config: { kernelId, jobDurationMs: 5000 },
      },
      {
        id: "dev_power_001",
        type: "sensor",
        adapterType: "mock",
        config: { kernelId },
      },
      {
        id: "dev_cam_001",
        type: "camera",
        adapterType: "mock",
        config: { kernelId },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load the kernel configuration from:
 *   1. `KERNEL_CONFIG` env var (JSON string)
 *   2. `KERNEL_CONFIG_FILE` env var (path to JSON file)
 *   3. Default mock config
 *
 * Throws if the JSON is invalid or the file cannot be read.
 */
export function loadKernelConfig(): KernelConfig {
  const inlineJson = process.env.KERNEL_CONFIG;
  if (inlineJson) {
    try {
      const parsed = JSON.parse(inlineJson) as KernelConfig;
      return parsed;
    } catch (err) {
      throw new Error(
        `Failed to parse KERNEL_CONFIG env var as JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const configFile = process.env.KERNEL_CONFIG_FILE;
  if (configFile) {
    try {
      const raw = readFileSync(configFile, "utf-8");
      const parsed = JSON.parse(raw) as KernelConfig;
      return parsed;
    } catch (err) {
      throw new Error(
        `Failed to load KERNEL_CONFIG_FILE "${configFile}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // No env config — use safe mock defaults
  return buildDefaultConfig();
}
