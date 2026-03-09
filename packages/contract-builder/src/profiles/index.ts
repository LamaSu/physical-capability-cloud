/**
 * Profile registry — register and retrieve machine profiles.
 */

import type { MachineProfile, CapabilityType, Id } from "@pcc/spec";
import { prusaMk4Profile } from "./prusa-mk4.js";
import { haasVf2Profile } from "./haas-vf2.js";

const registry = new Map<string, MachineProfile>();

/** Register a machine profile */
export function registerProfile(profile: MachineProfile): void {
  registry.set(profile.id, profile);
}

/** Get a profile by ID */
export function getProfile(id: string): MachineProfile | undefined {
  return registry.get(id);
}

/** Get all profiles for a capability type */
export function getProfilesForType(type: CapabilityType): MachineProfile[] {
  return [...registry.values()].filter((p) => p.capabilityType === type);
}

/** Get all profiles for a specific kernel */
export function getProfilesForKernel(kernelId: Id): MachineProfile[] {
  return [...registry.values()].filter((p) => p.kernelId === kernelId);
}

/** Get all registered profiles */
export function getAllProfiles(): MachineProfile[] {
  return [...registry.values()];
}

// Register built-in profiles
registerProfile(prusaMk4Profile);
registerProfile(haasVf2Profile);
