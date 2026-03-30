/**
 * Device Tool Types
 *
 * Generic tool manifest system for any device type.
 * Replaces the hardcoded OT-2 SAFE_TOOLS array with a
 * declarative, per-device-type manifest.
 */

/** Tool operation category — determines auth requirements */
export type DeviceToolCategory = "read" | "safe_control" | "scoped_write" | "privileged";

/** A single tool that a device type exposes */
export interface DeviceTool {
  /** Short name (e.g. "health", "home", "protocol_upload") */
  name: string;
  /** Fully qualified name: {deviceType}.{name} (e.g. "opentrons.health") */
  qualifiedName: string;
  /** Human-readable description */
  description: string;
  /** Operation category — controls auth enforcement */
  category: DeviceToolCategory;
  /** JSON Schema for the tool's input arguments */
  inputSchema: Record<string, unknown>;
}

/** Complete tool manifest for a device type */
export interface DeviceToolManifest {
  /** Device type identifier (e.g. "opentrons", "octoprint", "generic") */
  deviceType: string;
  /** Manifest schema version */
  version: string;
  /** All tools this device type supports */
  tools: DeviceTool[];
  /** Tool names that bypass execution scope (read + safe_control categories) */
  safeTools: string[];
}

/** Every device type MUST support these 3 core platform tools */
export const CORE_PLATFORM_TOOLS = ["health", "status", "evidence_snapshot"] as const;
export type CorePlatformTool = (typeof CORE_PLATFORM_TOOLS)[number];
