import {
  EVIDENCE_DEVICE_TYPES,
  EVIDENCE_EVENT_TYPES,
  type EvidenceDeviceType,
  type EvidenceEvent,
  type EvidenceEventType,
  type EvidenceSource,
} from "@pcc/spec";
import { OutstandingWork } from "../adapters/outstanding-work.js";
import type {
  MachineAdapter,
  MachineCommand,
  MachineCommandResult,
  MachineStatus,
} from "../adapters/types.js";

// Capture the scheduler just as print-host/src/testing/fake-machine-adapter.ts
// does: fake timers installed before import own it; later replacements do not.
const capturedSetTimeout = setTimeout;
const capturedClearTimeout = clearTimeout;
const capturedSetImmediate = setImmediate;
const capturedClearImmediate = clearImmediate;

type DeviceJobId = string | number;
type DeviceEvent = Omit<EvidenceEvent, "id" | "hash">;

export interface FakeDeviceOptions {
  preset?: "ipp";
  bindingKey?: string;
  type?: MachineAdapter["type"];
  deviceType?: EvidenceDeviceType;
  startedType?: EvidenceEventType;
  progressType?: EvidenceEventType;
  completedType?: EvidenceEventType;
  failedType?: EvidenceEventType;
  declaredCommands?: readonly MachineCommand["type"][];
  startedEvent?: "none" | "inside-start" | "after-start";
  cancelBehavior?: "report" | "silent" | "refuse" | "throw";
  cancelEventOrder?: "before-resolve" | "after-resolve";
  cancelConfirmMs?: number;
  clock?: () => Date;
}

export type FakeDeviceStartOutcome =
  | { outcome: "accept"; deviceJobId: DeviceJobId }
  | { outcome: "busy" }
  | { outcome: "error"; message: string }
  | { outcome: "throw"; message: string };

const commandTypes = new Set<MachineCommand["type"]>([
  "load_gcode", "start", "pause", "resume", "stop", "status",
]);
const eventTypes = new Set<string>(EVIDENCE_EVENT_TYPES);
const deviceTypes = new Set<string>(EVIDENCE_DEVICE_TYPES);
const deterministicBase = Date.parse("2026-10-09T00:00:00.000Z");

function nonemptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a nonempty string`);
  }
}

function oneOf<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (!values.includes(value as T)) throw new Error(`invalid ${name}`);
  return value as T;
}

/**
 * Scriptable, deliberately fabricated evidence for any MachineAdapter capability.
 *
 * The work counter implements adapters/types.ts:8-23 and outstanding-work.ts:
 * it ends only AFTER terminal listeners have received their evidence. Native
 * execution_completed/execution_failed remain terminal (types.ts:73-77), in
 * addition to the configured terminal roles. Cancellation follows types.ts:57-68.
 *
 * Both fabrication tags are always constructed here, independently: the detector
 * in spec/src/evidence/is-fabricated.ts:32 accepts EITHER tag. Runtime vocabulary
 * comes from spec/src/types/evidence.ts, never a parallel evidence type list.
 *
 * The optional IPP shape follows printer-job.ts:35-66 and :144-153: data.jobId
 * names the device job, payload.ippJobId binds it strictly, and payload.jobId is
 * reserved for the PCC job (LO-EV-9). This fake is available only through the
 * testing subpath; adapter-factory.ts:204-223 must continue to reject its type.
 */
export class FakeDevice implements MachineAdapter {
  readonly type: MachineAdapter["type"];
  readonly source: EvidenceSource;
  readonly bindingKey: string;
  readonly startedType: EvidenceEventType;
  readonly progressType: EvidenceEventType;
  readonly completedType: EvidenceEventType;
  readonly failedType: EvidenceEventType;
  readonly commands: MachineCommand[] = [];
  readonly cancels: DeviceJobId[] = [];

  private readonly kernelId: string;
  private readonly deviceType: EvidenceDeviceType;
  private readonly ipp: boolean;
  private readonly declaredCommands: ReadonlySet<MachineCommand["type"]>;
  private readonly startedEvent: NonNullable<FakeDeviceOptions["startedEvent"]>;
  private readonly cancelBehavior: NonNullable<FakeDeviceOptions["cancelBehavior"]>;
  private readonly cancelEventOrder: NonNullable<FakeDeviceOptions["cancelEventOrder"]>;
  private readonly cancelConfirmMs: number;
  private readonly clock: (() => Date) | undefined;
  private readonly work = new OutstandingWork();
  private readonly starts: FakeDeviceStartOutcome[] = [];
  private readonly listeners = new Set<(event: DeviceEvent) => void>();
  private readonly unobservedStarts: MachineCommand[] = [];
  private readonly startWaiters: Array<{
    resolve: (command: MachineCommand) => void;
    reject: (reason: Error) => void;
  }> = [];
  private status: MachineStatus = "idle";
  private currentProgress = 0;
  private active: { id: DeviceJobId; end: () => void } | undefined;
  private delivering = false;
  private disposed = false;
  private eventNumber = 0;
  private cancelDeadline: ReturnType<typeof setTimeout> | undefined;
  private cancelReport: ReturnType<typeof setImmediate> | undefined;

  constructor(readonly id: string, kernelId: string, options: FakeDeviceOptions = {}) {
    nonemptyString(id, "id");
    nonemptyString(kernelId, "kernelId");
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("options must be an object");
    }
    for (const key of [
      "preset", "bindingKey", "type", "deviceType", "startedType", "progressType",
      "completedType", "failedType", "declaredCommands", "startedEvent",
      "cancelBehavior", "cancelEventOrder", "cancelConfirmMs", "clock",
    ] as const) {
      if (options[key] === null) throw new Error(`invalid ${key}`);
    }
    if (options.preset !== undefined) oneOf(options.preset, ["ipp"], "preset");
    this.ipp = options.preset === "ipp";
    if (this.ipp) {
      for (const [key, expected] of [
        ["bindingKey", "ippJobId"], ["type", "ipp-2d"], ["deviceType", "controller"],
      ] as const) {
        if (options[key] !== undefined && options[key] !== expected) {
          throw new Error(`ipp preset requires ${key} ${expected}`);
        }
      }
    }
    this.bindingKey = options.bindingKey ?? (this.ipp ? "ippJobId" : "deviceJobId");
    nonemptyString(this.bindingKey, "bindingKey");
    if (["jobId", "mock", "origin"].includes(this.bindingKey)) {
      throw new Error(`reserved bindingKey: ${this.bindingKey}`);
    }
    this.type = options.type ?? (this.ipp ? "ipp-2d" : "fake-device");
    nonemptyString(this.type, "type");
    this.deviceType = options.deviceType ?? "controller";
    if (!deviceTypes.has(this.deviceType)) throw new Error("invalid deviceType");
    this.kernelId = kernelId;
    // Public adapter metadata is only a snapshot; emissions use the private identity.
    this.source = Object.freeze({ deviceId: id, deviceType: this.deviceType, kernelId, simulated: true });

    this.startedType = options.startedType ?? "execution_started";
    this.progressType = options.progressType ?? "execution_progress";
    this.completedType = options.completedType ?? "execution_completed";
    this.failedType = options.failedType ?? "execution_failed";
    for (const role of ["startedType", "progressType", "completedType", "failedType"] as const) {
      if (!eventTypes.has(this[role])) throw new Error(`invalid ${role}`);
    }
    for (const role of ["startedType", "progressType"] as const) {
      if (this[role] === "execution_completed" || this[role] === "execution_failed") {
        throw new Error(`${role} must not be a native terminal event type`);
      }
    }
    if (
      this.completedType === this.failedType ||
      [this.startedType, this.progressType].includes(this.completedType) ||
      [this.startedType, this.progressType].includes(this.failedType)
    ) throw new Error("terminal event types must differ from each other and from started/progress types");

    const declared = options.declaredCommands ?? ["start", "stop", "status"];
    if (!Array.isArray(declared) || Array.from(declared).some((type) => !commandTypes.has(type))) {
      throw new Error("invalid declaredCommands");
    }
    this.declaredCommands = new Set(declared);
    this.startedEvent = oneOf(options.startedEvent ?? "none", ["none", "inside-start", "after-start"], "startedEvent");
    this.cancelBehavior = oneOf(options.cancelBehavior ?? "report", ["report", "silent", "refuse", "throw"], "cancelBehavior");
    this.cancelEventOrder = oneOf(options.cancelEventOrder ?? "before-resolve", ["before-resolve", "after-resolve"], "cancelEventOrder");
    this.cancelConfirmMs = options.cancelConfirmMs ?? 50;
    if (
      typeof this.cancelConfirmMs !== "number" || !Number.isFinite(this.cancelConfirmMs) ||
      this.cancelConfirmMs < 0 || this.cancelConfirmMs > 2_147_483_647
    ) throw new Error("invalid cancelConfirmMs");
    if (options.clock !== undefined && typeof options.clock !== "function") throw new Error("invalid clock");
    this.clock = options.clock;
  }

  scriptStart(outcome: FakeDeviceStartOutcome): void {
    if (this.disposed) throw new Error("fake device disposed");
    if (!outcome || typeof outcome !== "object") throw new Error("invalid start outcome");
    oneOf(outcome.outcome, ["accept", "busy", "error", "throw"], "start outcome");
    if (outcome.outcome === "accept") this.validateDeviceJobId(outcome.deviceJobId);
    if ((outcome.outcome === "error" || outcome.outcome === "throw") && typeof outcome.message !== "string") {
      throw new Error("start outcome message must be a string");
    }
    this.starts.push(structuredClone(outcome));
  }

  /** Observe every start command, whether accepted or refused, as print-host's fake does. */
  started(): Promise<MachineCommand> {
    if (this.disposed) return Promise.reject(new Error("fake device disposed"));
    const command = this.unobservedStarts.shift();
    if (command) return Promise.resolve(command);
    return new Promise((resolve, reject) => this.startWaiters.push({ resolve, reject }));
  }

  async getStatus(): Promise<MachineStatus> { return this.status; }
  async getProgress(): Promise<number> { return this.currentProgress; }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    const recorded = structuredClone(command);
    this.commands.push(recorded);
    if (this.disposed) return { success: false, message: "fake device disposed" };
    if (command.type === "start") {
      const observed = structuredClone(recorded);
      const waiter = this.startWaiters.shift();
      if (waiter) waiter.resolve(observed);
      else this.unobservedStarts.push(observed);
    }
    if (!this.declaredCommands.has(command.type)) {
      return { success: false, message: `undeclared command: ${command.type}` };
    }
    if (command.type === "status") {
      return { success: true, data: { status: this.status, progress: this.currentProgress } };
    }
    if (command.type === "stop") {
      if (this.active && !this.delivering) this.fail({ state: "stopped", origin: "device" });
      return { success: true };
    }
    if (command.type !== "start") return { success: true };
    if (this.active) return this.busyResult();
    const outcome = this.starts.shift();
    if (!outcome) return { success: false, message: "no scripted start result" };
    if (outcome.outcome === "busy") {
      this.status = "busy";
      return this.busyResult();
    }
    if (outcome.outcome === "error" || outcome.outcome === "throw") {
      this.status = "error";
      if (outcome.outcome === "throw") throw new Error(outcome.message);
      return { success: false, message: outcome.message };
    }
    this.status = "busy";
    this.currentProgress = 0;
    const job = { id: outcome.deviceJobId, end: this.work.begin() };
    this.active = job;
    if (this.startedEvent === "inside-start") this.emit(this.startedType);
    if (this.startedEvent === "after-start") {
      // Identity, rather than just the id, prevents a reused id from receiving an old callback.
      void Promise.resolve().then(() => {
        if (!this.disposed && this.active === job && !this.delivering) this.emit(this.startedType);
      });
    }
    return {
      success: true,
      data: { jobId: job.id, ...(this.ipp ? { ippJobId: job.id } : {}) },
    };
  }

  /** IPP validation deliberately matches print-host's fake-machine-adapter.ts:130-137. */
  async cancelJob(id: DeviceJobId): Promise<void> {
    let normalized = id;
    if (this.ipp) {
      const numericJobId = Number(id);
      if (
        (typeof id !== "number" && typeof id !== "string") ||
        (typeof id === "string" && !/^[1-9][0-9]*$/.test(id)) ||
        !Number.isSafeInteger(numericJobId) || numericJobId <= 0
      ) throw new Error("cancelJob requires a numeric job id");
      normalized = numericJobId;
    }
    this.cancels.push(normalized);
    const job = this.active;
    if (this.disposed || !job || job.id !== normalized || this.delivering) return;
    if (this.cancelBehavior === "throw") throw new Error("fake device cancel rejected");
    if (this.cancelBehavior === "refuse") return;
    if (this.cancelBehavior === "silent") {
      // The FIRST cancellation bounds the job; later requests never extend it.
      this.cancelDeadline ??= capturedSetTimeout(() => {
        this.cancelDeadline = undefined;
        if (!this.disposed && this.active === job) {
          this.fail({ state: "processing", reason: "cancel-unconfirmed", jobStateReasons: [], origin: "device" });
        }
      }, this.cancelConfirmMs);
      return;
    }
    const reportCanceled = () => {
      if (!this.disposed && this.active === job) this.fail({ state: "canceled", origin: "device" });
    };
    if (this.cancelEventOrder === "after-resolve") {
      this.cancelReport ??= capturedSetImmediate(() => {
        this.cancelReport = undefined;
        reportCanceled();
      });
    } else await Promise.resolve().then(reportCanceled);
  }

  onEvidence(callback: (event: DeviceEvent) => void): void {
    if (!this.disposed) this.listeners.add(callback);
  }

  emit(type: EvidenceEventType, payload: Record<string, unknown> = {}): void {
    const job = this.active;
    if (this.disposed || !job || this.delivering) throw new Error("fake device has no active job");
    if (!eventTypes.has(type)) throw new Error("invalid event type");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload must be an object");
    if (Object.hasOwn(payload, "jobId")) throw new Error("payload.jobId is reserved for the PCC job (LO-EV-9)");
    if (Object.hasOwn(payload, "mock")) throw new Error("payload.mock is reserved for fabrication tagging");
    if (Object.hasOwn(payload, "origin") && payload.origin !== "device") throw new Error("payload.origin must be device");
    if (Object.hasOwn(payload, this.bindingKey) && payload[this.bindingKey] !== job.id) {
      throw new Error("payload names a different device job");
    }
    const failed = type === this.failedType || type === "execution_failed";
    const terminal = failed || type === this.completedType || type === "execution_completed";
    this.delivering = true;
    try {
      const timestamp = this.clock ? this.clock() : new Date(deterministicBase + this.eventNumber);
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) throw new Error("clock must return a valid Date");
      const event: DeviceEvent = {
        type,
        timestamp: timestamp.toISOString(),
        source: { deviceId: this.id, deviceType: this.deviceType, kernelId: this.kernelId, simulated: true },
        payload: { ...structuredClone(payload), [this.bindingKey]: job.id, mock: true, ...(failed ? { origin: "device" } : {}) },
      };
      this.eventNumber += 1;
      if (typeof event.payload.progress === "number") this.currentProgress = event.payload.progress;
      if (type === this.completedType || type === "execution_completed") this.currentProgress = 100;
      for (const callback of [...this.listeners]) {
        if (this.disposed) break;
        callback(structuredClone(event));
      }
    } finally {
      if (terminal) this.finishWork(job);
      this.delivering = false;
    }
  }

  progress(n: number, payload: Record<string, unknown> = {}): void {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100) throw new Error("progress must be between 0 and 100");
    this.emit(this.progressType, { ...payload, progress: n });
  }

  complete(payload: Record<string, unknown> = {}): void { this.emit(this.completedType, payload); }
  fail(payload: Record<string, unknown> = {}): void { this.emit(this.failedType, payload); }

  quiesceEvidence(): Promise<void> { return this.work.idle(); }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.finishWork();
    this.listeners.clear();
    this.starts.length = 0;
    this.unobservedStarts.length = 0;
    for (const waiter of this.startWaiters.splice(0)) waiter.reject(new Error("fake device disposed"));
  }

  private validateDeviceJobId(value: unknown): asserts value is DeviceJobId {
    if (this.ipp) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error("ipp deviceJobId must be a positive safe integer");
      }
    } else if (
      (typeof value !== "string" || value.length === 0) &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) throw new Error("deviceJobId must be a nonempty string or finite number");
  }

  private busyResult(): MachineCommandResult {
    return { success: false, busy: true, message: "device is busy", data: { busy: true, code: "busy" } };
  }

  private finishWork(job = this.active): void {
    if (this.active !== job) return;
    if (this.cancelDeadline !== undefined) capturedClearTimeout(this.cancelDeadline);
    if (this.cancelReport !== undefined) capturedClearImmediate(this.cancelReport);
    this.cancelDeadline = undefined;
    this.cancelReport = undefined;
    this.active = undefined;
    this.status = "idle";
    job?.end();
  }
}
