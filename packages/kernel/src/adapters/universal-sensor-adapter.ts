/**
 * Universal Sensor Adapter — extended interface for any device that produces
 * sensor data streams (instruments, probes, PLCs, gateways, etc.).
 */

import type { EvidenceSource, SensorChannelDescriptor } from "@pcc/spec";
import type { EvidenceEvent } from "@pcc/spec";

export interface UniversalSensorAdapter {
  readonly id: string;
  readonly deviceClass: "machine" | "instrument" | "sensor" | "camera" | "controller" | "tee" | "gateway";
  readonly source: EvidenceSource;

  /** Declare data streams this device produces */
  getChannelDescriptors(): SensorChannelDescriptor[];

  /** Standard lifecycle */
  getStatus(): Promise<"idle" | "busy" | "error" | "offline" | "maintenance">;
  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void;
  dispose(): Promise<void>;
}

/** Type guard for universal sensor adapters */
export function isUniversalSensor(adapter: unknown): adapter is UniversalSensorAdapter {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    "getChannelDescriptors" in adapter &&
    typeof (adapter as UniversalSensorAdapter).getChannelDescriptors === "function"
  );
}
