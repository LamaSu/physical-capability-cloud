/**
 * JobRunner's failure paths whatever a collaborator rejects with (the class astra pack 200 found in
 * PrinterLog, on #502's evidence path; steward #5541/#5547). A rejection reason with no text form
 * used to throw inside the catch that turns it into the run's failure: the unrecorded latch was
 * skipped, and run() rejected instead of resolving with its failed JobResult. Every reason now
 * becomes text without throwing (failureText), so the run fails with a result naming what failed,
 * and nothing is left unhandled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceBundle, EvidenceEvent, EvidenceSource, SHA256, Signature } from "@pcc/spec";


import type { CameraAdapter, MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus, SensorAdapter } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner } from "../job-runner.js";
import type { JobResult } from "../job-runner.js";

// Plain functions, not vi.fn(), so vi.restoreAllMocks() cannot strip them.
vi.mock("@sentry/node", () => ({
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
  addBreadcrumb: () => {},
  captureException: () => {},
}));

type Emitted = Omit<EvidenceEvent, "id" | "hash">;
type DeviceType = EvidenceSource["deviceType"];

const KERNEL_ID = "kernel-scope-test";
const STEP = "step-1";
const GUARD_MS = 2_000;
const STILL_PENDING = `run() still pending after ${GUARD_MS} ms`;

function evidence(type: Emitted["type"], deviceId: string, deviceType: DeviceType, payload: Record<string, unknown> = {}): Emitted {
  return { type, timestamp: new Date().toISOString(), source: { deviceId, deviceType, kernelId: KERNEL_ID }, payload };
}

/** The Tier 1 events a machine emits while it loads a job's G-code, tagged with that job's hash. */
function tier1(machineId: string, gcodeHash: string): Emitted[] {
  return [
    evidence("gcode_hash_verified", machineId, "controller", { gcodeHash }),
    evidence("execution_completed", machineId, "controller", { gcodeHash }),
    evidence("power_profile_summary", `${machineId}-power`, "power_monitor", { gcodeHash }),
  ];
}

const gcode = (n: number): SHA256 => `sha256:${n.toString(16).padStart(64, "0")}` as SHA256;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface TestMachine extends MachineAdapter {
  /** Deliver an event to every listener, as the device would. */
  emit(event: Emitted): void;
  /** Every command type this machine was sent, in order. */
  readonly commands: string[];
  /** The command that fails, if any. */
  failing: "load_gcode" | "start" | null;
  /** Progress reported to waitForCompletion. */
  progress: () => number;
  /** Status reported to waitForCompletion while progress is under 100. */
  status: MachineStatus;
  /** Resolves once start has been called n times. */
  started(n: number): Promise<void>;
}

function testMachine(
  id: string,
  options: {
    /** Events emitted during load_gcode. Default: the Tier 1 set for the job's G-code. */
    onLoad?: (machineId: string, gcodeHash: string) => Emitted[];
    /** Hold the nth start (1-based) until its promise resolves. */
    holdStart?: Map<number, Promise<void>>;
  } = {},
): TestMachine {
  const listeners: Array<(event: Emitted) => void> = [];
  const commands: string[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  let starts = 0;
  const machine: TestMachine = {
    id,
    type: "fdm",
    source: { deviceId: id, deviceType: "controller", kernelId: KERNEL_ID },
    commands,
    failing: null,
    progress: () => 100,
    status: "busy",
    async getStatus() {
      return machine.status;
    },
    async getProgress() {
      return machine.progress();
    },
    async execute(command: MachineCommand): Promise<MachineCommandResult> {
      commands.push(command.type);
      if (command.type === "load_gcode") {
        for (const e of (options.onLoad ?? tier1)(id, String(command.payload?.gcodeHash))) machine.emit(e);
      }
      if (command.type === "start") {
        starts += 1;
        for (const w of waiters) if (w.n <= starts) w.resolve();
        await options.holdStart?.get(starts);
      }
      if (machine.failing === command.type) return { success: false, message: `${command.type} refused` };
      return { success: true, message: "ok" };
    },
    onEvidence(callback) {
      listeners.push(callback);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    started(n) {
      return new Promise((resolve) => {
        if (starts >= n) resolve();
        else waiters.push({ n, resolve });
      });
    },
    // It emits inside the command that causes it; an event a test sends through emit()
    // later is one this hook did not cover (a device breaking its contract).
    async quiesceEvidence() {},
    async dispose() {},
  };
  return machine;
}


const REASONS = [
  ["an object with no prototype", () => Object.create(null) as unknown],
  ["an object whose toString throws", () => ({ toString: () => { throw new Error("no text"); } }) as unknown],
  ["an Error whose message getter throws", () => Object.defineProperty(new Error("x"), "message", { get: () => { throw new Error("no message"); } }) as unknown],
] as const;

/** Runs `body`, and collects every rejection Node reports as unhandled meanwhile. */
async function catchingUnhandled<T>(body: () => Promise<T>): Promise<{ value?: T; rejected?: string; unhandled: unknown[] }> {
  const unhandled: unknown[] = [];
  const on = (err: unknown) => void unhandled.push(err);
  process.on("unhandledRejection", on);
  try {
    const value = await body();
    await new Promise((r) => setTimeout(r, 30));
    return { value, unhandled };
  } catch (err) {
    await new Promise((r) => setTimeout(r, 30));
    return { rejected: err instanceof Error ? err.message : "a reason with no text form", unhandled };
  } finally {
    process.off("unhandledRejection", on);
  }
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("JobRunner: a collaborator that rejects with a reason that has no text form", () => {
  // Each case has its own device: a device whose hook rejected stays quiescing, and would refuse the next case's session.
  it.each(REASONS)("addEvent rejects with %s: run() resolves with a failure naming the lost event", async (what, reason) => {
    class FailingEmitter extends EvidenceEmitter {
      override addEvent(jobId: string, stepId: string, rawEvent: Emitted): Promise<EvidenceEvent> {
        if (rawEvent.type === "gcode_received") return Promise.reject(reason());
        return super.addEvent(jobId, stepId, rawEvent);
      }
    }
    const emitter = new FailingEmitter(KERNEL_ID);
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((b) => bundles.push(b));
    const machine = testMachine(`m-ft-add-${what}`, { onLoad: (id, hash) => [evidence("gcode_received", id, "controller", { gcodeHash: hash }), ...tier1(id, hash)] });
    const out = await catchingUnhandled(() => new JobRunner(machine, [], null, emitter).run({ jobId: "job-ft-add", stepId: STEP, gcodeHash: gcode(31), assuranceTier: 1 }));
    expect.soft(out.rejected, "run() rejected").toBeUndefined();
    expect.soft(out.value?.success, "success").toBe(false);
    expect.soft(out.value?.error ?? "", "why").toMatch(/^a gcode_received event of this job could not be recorded \(.+\), so its evidence is incomplete$/);
    expect.soft(out.unhandled.length, "unhandled rejections").toBe(0);
    expect.soft(bundles.length, "bundles").toBe(0);
  });

  it.each(REASONS)("the machine's execute rejects with %s: run() resolves with a failure", async (what, reason) => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine(`m-ft-exec-${what}`);
    machine.execute = async () => Promise.reject(reason());
    const out = await catchingUnhandled(() => new JobRunner(machine, [], null, emitter).run({ jobId: "job-ft-exec", stepId: STEP, gcodeHash: gcode(32), assuranceTier: 1 }));
    expect.soft(out.rejected, "run() rejected").toBeUndefined();
    expect.soft(out.value?.success, "success").toBe(false);
    expect.soft(typeof out.value?.error, "its error is text").toBe("string");
    expect.soft(out.unhandled.length, "unhandled rejections").toBe(0);
  });

  it.each(REASONS)("the machine's quiesceEvidence rejects with %s: run() resolves with a failure, and nothing is left unhandled", async (what, reason) => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine(`m-ft-quiesce-${what}`);
    machine.quiesceEvidence = async () => Promise.reject(reason());
    const out = await catchingUnhandled(() => new JobRunner(machine, [], null, emitter).run({ jobId: "job-ft-quiesce", stepId: STEP, gcodeHash: gcode(33), assuranceTier: 1 }));
    expect.soft(out.rejected, "run() rejected").toBeUndefined();
    expect.soft(out.value?.success, "success").toBe(false);
    expect.soft(out.value?.busy, "refused at open (another case's device)").toBeUndefined();
    expect.soft(out.unhandled.length, "unhandled rejections").toBe(0);
  });

  it.each(REASONS)("a later run on a device whose hook rejected with %s is refused, and the hook asked again leaves nothing unhandled", async (what, reason) => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine(`m-ft-again-${what}`);
    machine.quiesceEvidence = async () => Promise.reject(reason());
    const first = await catchingUnhandled(() => new JobRunner(machine, [], null, emitter).run({ jobId: "job-ft-again-1", stepId: STEP, gcodeHash: gcode(34), assuranceTier: 1 }));
    // The device stays quiescing: the next run is refused, and its hook is asked again (and logged).
    const second = await catchingUnhandled(() => new JobRunner(machine, [], null, emitter).run({ jobId: "job-ft-again-2", stepId: STEP, gcodeHash: gcode(35), assuranceTier: 1 }));
    expect.soft(first.value?.success, "the first run").toBe(false);
    expect.soft(second.rejected, "the second run rejected").toBeUndefined();
    expect.soft(second.value?.busy?.reason, "the second run, refused").toBe("quiescing");
    expect.soft(second.unhandled.length, "unhandled rejections").toBe(0);
    expect.soft(console.error, "the hook's failure, logged").toHaveBeenCalledWith(expect.stringMatching(/could not confirm its evidence is complete: /));
  });
});
