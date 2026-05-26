/**
 * PyLabRobot adapter types.
 *
 * Local mirror of `@pcc/kernel/adapters/types` (which isn't exported publicly
 * from the kernel package). TypeScript is structural — the adapter class
 * here is assignment-compatible with the kernel's MachineAdapter interface.
 *
 * The kernel re-exports this adapter via
 * `packages/kernel/src/adapters/pylabrobot.ts`, which performs the local
 * import side of the interface satisfaction.
 */

import type { EvidenceEvent, EvidenceEventType, EvidenceSource } from "@pcc/spec";

/** Status a machine adapter can report (mirrors kernel/adapters/types.ts MachineStatus) */
export type MachineStatus = "idle" | "busy" | "error" | "offline" | "maintenance";

/** A command to send to a machine */
export interface MachineCommand {
  type: "load_gcode" | "start" | "pause" | "resume" | "stop" | "status";
  payload?: Record<string, unknown>;
}

/** Result of a machine command */
export interface MachineCommandResult {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

/** Subset of EvidenceEvent emitted from this adapter (no id/hash — assigned by the kernel evidence pipeline) */
export type AdapterEvidenceEvent = Omit<EvidenceEvent, "id" | "hash">;

/** Callback the kernel registers to receive evidence events */
export type EvidenceCallback = (event: AdapterEvidenceEvent) => void;

/**
 * Interface every machine adapter must implement (mirrors kernel's MachineAdapter).
 * Re-declared here so this package doesn't import private kernel paths.
 */
export interface MachineAdapter {
  readonly id: string;
  readonly type:
    | "fdm"
    | "cnc-3axis"
    | "cnc-5axis"
    | "sla"
    | "lathe"
    | "laser-cut"
    | "ipp-2d"
    | "liquid-handler"
    | (string & {});
  readonly source: EvidenceSource;
  getStatus(): Promise<MachineStatus>;
  execute(command: MachineCommand): Promise<MachineCommandResult>;
  getProgress(): Promise<number>;
  onEvidence(callback: EvidenceCallback): void;
  dispose(): Promise<void>;
}

/** Re-exports of spec types this adapter publishes */
export type { EvidenceEvent, EvidenceEventType, EvidenceSource };
