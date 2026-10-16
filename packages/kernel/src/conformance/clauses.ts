import type { EvidenceEventType } from "@pcc/spec";
import type { MachineAdapter, MachineCommand } from "../adapters/types.js";

/** The closed command union in adapters/types.ts:31-34, in contract order. */
export const COMMAND_TYPES = ["load_gcode", "start", "pause", "resume", "stop", "status"] as const satisfies readonly MachineCommand["type"][];

/** Each clause uses a fresh adapter; no clause certifies equipment or network evidence. */
export const CLAUSES = [
  { id: "C1", title: "Quiesce honesty" },
  { id: "C2", title: "Device-job binding" },
  { id: "C3", title: "One terminal per job" },
  { id: "C4", title: "Job-scoped cancellation" },
  { id: "C5", title: "Busy refusal" },
  { id: "C6", title: "Fabrication tags" },
  { id: "C7", title: "Dispose silence" },
  { id: "C8", title: "PCC job fields" },
  { id: "C9", title: "Physical cancellation support" },
  { id: "C10", title: "Undeclared commands" },
] as const;

export type ClauseId = typeof CLAUSES[number]["id"];
export type ClauseStatus = "pass" | "fail" | "n/a";
export interface ConformanceContext { readonly pccJobId: string }
export interface ConformanceTiming {
  cancelConfirmMs: number;
  pollMs: number;
  jobTimeoutMs: number;
  quiesceTimeoutMs: number;
  settleMs: number;
}

/** Serializable test conditions. Timeouts use real timers, in milliseconds. */
export interface ConformanceProfileFields {
  name: string;
  kind: "physical" | "digital";
  mode: "real" | "mock";
  bindingKey: string;
  declaredCommands: readonly MachineCommand["type"][];
  terminalEvents: { completed: readonly EvidenceEventType[]; failed: readonly EvidenceEventType[] };
  timing: ConformanceTiming;
  busy: "second-start" | "none";
}

/**
 * Hooks execute only in the author's/lane's own process, on trusted local code.
 * Preparation happens before the job observation window; startCommand must
 * describe a start that remains running long enough to probe busy and cancel.
 * finish is for scripted devices; autonomous devices need no finish hook.
 * Hooks and adapter identities never enter the report.
 */
export interface ConformanceProfile extends Omit<ConformanceProfileFields, "terminalEvents"> {
  terminalEvents?: ConformanceProfileFields["terminalEvents"];
  prepareStart?: (adapter: MachineAdapter, context: ConformanceContext) => void | Promise<void>;
  startCommand: (adapter: MachineAdapter, context: ConformanceContext) => MachineCommand | Promise<MachineCommand>;
  finish?: (adapter: MachineAdapter, context: ConformanceContext) => void | Promise<void>;
}
export type MakeAdapter = () => MachineAdapter | Promise<MachineAdapter>;
