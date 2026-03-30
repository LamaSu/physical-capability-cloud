/**
 * Tool Manifest Registry
 *
 * Exports bundled tool manifests for known device types.
 * Each manifest declares the tools a device type supports,
 * their categories, and which tools are safe (no scope needed).
 */

import type { DeviceToolManifest } from "../types/device-tools.js";

import opentrons from "./opentrons.tools.json" with { type: "json" };
import octoprint from "./octoprint.tools.json" with { type: "json" };
import generic from "./generic.tools.json" with { type: "json" };

/** All bundled tool manifests, keyed by device type */
export const BUNDLED_MANIFESTS: Record<string, DeviceToolManifest> = {
  opentrons: opentrons as DeviceToolManifest,
  octoprint: octoprint as DeviceToolManifest,
  generic: generic as DeviceToolManifest,
};

/** Get a bundled manifest by device type. Returns null if unknown. */
export function getBundledManifest(deviceType: string): DeviceToolManifest | null {
  return BUNDLED_MANIFESTS[deviceType] ?? null;
}

/** List all known device types that have bundled manifests */
export function listBundledDeviceTypes(): string[] {
  return Object.keys(BUNDLED_MANIFESTS);
}
