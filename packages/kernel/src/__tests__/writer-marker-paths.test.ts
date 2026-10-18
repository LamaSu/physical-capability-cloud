import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import {
  compileTierLadder,
  hashEvent,
  verifyBundleHash,
  verifyEventHash,
  type CSD,
  type EvidenceBundle,
  type EvidenceEvent,
  type EvidenceSource,
  type SHA256,
  type TierLadderV1,
} from "@pcc/spec";
import type { MachineAdapter, MachineCommand, MachineCommandResult } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner, type JobConfig, type JobResult } from "../job-runner.js";
import {
  makeKernelEd25519Signer,
  runPrintJob,
  type PrintJobOptions,
  type PrintJobResult,
} from "../printer-job.js";

vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_options: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

type RawEvent = Omit<EvidenceEvent, "id" | "hash">;
const KERNEL = "kernel-writer-paths";
const INPUT = "writer-marker-input";
const H = `sha256:${createHash("sha256").update(INPUT).digest("hex")}` as SHA256;
const OTHER_H = `sha256:${"ab".repeat(32)}` as SHA256;
const UNIT = {
  settlementUnitId: `0x${"a".repeat(64)}`,
  challengeNonce: `0x${"b".repeat(64)}`,
};
const SEED = new Uint8Array(32).fill(45);

const csd = {
  url: "pcc://capabilities/writer-marker-test/v1",
  evidence: {
    tier0: {
      description: "Input proof and completion",
      required: ["method_loaded", "execution_completed"],
      primitives: [{ id: "receipt.kernel_signed", bind: "execution_completed" }],
    },
    tier1: {
      description: "Input proof, completion and instrument",
      required: ["method_loaded", "execution_completed", "instrument_result"],
      primitives: [{ id: "receipt.kernel_signed", bind: "execution_completed" }],
    },
    tier2: {
      description: "Input proof, completion, instrument and calibration",
      required: ["method_loaded", "execution_completed", "instrument_result", "calibration_record"],
      primitives: [{ id: "receipt.kernel_signed", bind: "execution_completed" }],
    },
  },
} as unknown as CSD;

let ladder: TierLadderV1;
beforeAll(async () => {
  vi.useRealTimers();
  ladder = await compileTierLadder(csd);
  expect(ladder.tiers.map((tier) => tier.tier)).toStrictEqual([0, 1, 2]);
});

afterEach(() => {
  vi.useRealTimers();
  // RestoreAllMocks would reset the module's vi.fn Sentry.startSpan implementation,
  // causing every subsequent JobRunner test in this file to skip its callback.
  vi.clearAllMocks();
});

let nextMachine = 0;

class Machine implements MachineAdapter {
  readonly id = `writer-machine-${++nextMachine}`;
  readonly type = "liquid-handler" as const;
  readonly accepts?: readonly MachineCommand["type"][];
  source: EvidenceSource = { deviceId: this.id, deviceType: "controller", kernelId: KERNEL };
  emissionSource?: EvidenceSource;
  deviceJobId = `staged-${this.id}`;
  commands: MachineCommand[] = [];
  listeners: Array<(event: RawEvent) => void> = [];
  progress = 0;
  onPrepare?: (command: MachineCommand) => MachineCommandResult;
  onLoad?: () => void;
  onStart?: () => void;
  afterEmit?: (event: RawEvent) => void;

  constructor(prepare: boolean) {
    if (prepare) this.accepts = ["prepare", "start"];
  }

  emit(type: EvidenceEvent["type"], payload: Record<string, unknown> = {}): RawEvent {
    const event: RawEvent = {
      type,
      timestamp: new Date().toISOString(),
      source: this.emissionSource ?? this.source,
      payload: { deviceJobId: this.deviceJobId, ...payload },
    };
    for (const listener of this.listeners) listener(event);
    this.afterEmit?.(event);
    return event;
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    this.commands.push(command);
    if (command.type === "prepare") {
      return this.onPrepare?.(command) ?? {
        success: true,
        data: {
          jobId: command.payload?.jobId,
          inputHash: command.payload?.inputHash,
          deviceJobId: this.deviceJobId,
        },
      };
    }
    if (command.type === "load_gcode") {
      this.onLoad?.();
      return { success: true };
    }
    if (command.type === "start") {
      if (this.onStart) this.onStart();
      else this.emit("execution_completed");
      this.progress = 100;
    }
    return { success: true };
  }

  async getStatus() { return "idle" as const; }
  async getProgress() { return this.progress; }
  onEvidence(callback: (event: RawEvent) => void) { this.listeners.push(callback); }
  async quiesceEvidence() {}
  async dispose() {}
}

function machineFixture(prepare: boolean) {
  const machine = new Machine(prepare);
  const signer = makeKernelEd25519Signer(SEED);
  const emitter = new EvidenceEmitter(KERNEL, signer.signFn);
  const bundles: EvidenceBundle[] = [];
  emitter.onBundle((bundle) => bundles.push(bundle));

  const config: JobConfig = {
    jobId: `job-${machine.id}`,
    stepId: "step",
    inputHash: H,
    inputData: INPUT,
    assuranceTier: 0,
    tierLadder: ladder,
  };

  const run = () => new JobRunner(machine, [], null, emitter).run(config);
  return { machine, signer, emitter, bundles, config, run };
}

type MachineFixture = ReturnType<typeof machineFixture>;

function expectNoJobBundle(f: MachineFixture, result: JobResult): void {
  expect(result.success).toBe(false);
  expect(result.bundleId).toBeUndefined();
  expect(result.bundleHash).toBeUndefined();
  expect(result.busy).toBeUndefined();
  expect(f.bundles).toEqual([]);
}

function ownWriter(src: EvidenceSource, value: unknown): void {
  Object.defineProperty(src, "writer", {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function markedEvents(events: EvidenceEvent[]): EvidenceEvent[] {
  return events.filter((event) =>
    event.source !== null &&
    typeof event.source === "object" &&
    Object.getOwnPropertyDescriptor(event.source, "writer") !== undefined);
}

function withoutIdentity(event: EvidenceEvent): RawEvent {
  const { id: _id, hash: _hash, ...raw } = event;
  return raw;
}

function validSignature(bundle: EvidenceBundle, publicKeyHex: string): boolean {
  return nacl.sign.detached.verify(
    new TextEncoder().encode(bundle.bundleHash),
    Buffer.from(bundle.kernelSignature.value, "hex"),
    Buffer.from(publicKeyHex, "hex"),
  );
}

describe("P: JobRunner neutral prepare", () => {
  it.each([
    ["kernel", "kernel"],
    ["own undefined", undefined],
  ])("P-A adapter instrument_result with writer %s fails without a bundle", async (_label, writer) => {
    const f = machineFixture(true);
    f.machine.emissionSource = { ...f.machine.source };
    ownWriter(f.machine.emissionSource, writer);
    f.machine.onStart = () => {
      f.machine.emit("instrument_result");
      f.machine.emit("execution_completed");
    };

    const result = await f.run();
    expectNoJobBundle(f, result);
    expect(result.error).toBe(
      "a instrument_result event of this job could not be recorded " +
      "(source.writer is reserved for kernel-written events), so its evidence is incomplete",
    );
  });

  it("P-A2 rejects an adapter method_loaded with a writer before recording", async () => {
    const f = machineFixture(true);
    f.machine.emissionSource = { ...f.machine.source };
    ownWriter(f.machine.emissionSource, "kernel");
    f.machine.onStart = () => {
      f.machine.emit("method_loaded", { gcodeHash: H });
      // Only the forbidden proof carries writer. A writer-marked completion
      // would trip the lost-event check before the adapter-method check.
      f.machine.emissionSource = undefined;
      f.machine.emit("execution_completed");
    };

    const result = await f.run();
    expectNoJobBundle(f, result);
    expect(result.error).toBe("an adapter emitted method_loaded");
  });

  it("P-B rejects an unmarked adapter input proof on prepare", async () => {
    const f = machineFixture(true);
    const add = vi.spyOn(f.emitter, "addEvent");
    f.machine.onStart = () => {
      f.machine.emit("method_loaded", { inputHash: H });
      f.machine.emit("execution_completed");
    };

    const result = await f.run();
    expectNoJobBundle(f, result);
    expect(result.error).toBe("an adapter emitted method_loaded");
    expect(add.mock.calls.every(([, , event]) => event.type !== "method_loaded")).toBe(true);
  });

  it("P-C1 T1 marks exactly one event, the kernel's method_loaded", async () => {
    const f = machineFixture(true);
    f.machine.onStart = () => {
      for (const type of [
        "execution_started",
        "execution_progress",
        "instrument_result",
        "calibration_record",
        "execution_completed",
      ] as const) {
        f.machine.emit(type);
      }
    };

    const result = await f.run();
    expect(result.success).toBe(true);
    expect(f.bundles).toHaveLength(1);
    const events = f.bundles[0]!.events;
    expect(events.map((event) => event.type)).toStrictEqual([
      "method_loaded",
      "execution_started",
      "execution_progress",
      "instrument_result",
      "calibration_record",
      "execution_completed",
    ]);
    expect(markedEvents(events)).toStrictEqual([events[0]]);
    expect(events[0]!.source.writer).toBe("kernel");
    for (const event of events.slice(1)) {
      expect(Object.hasOwn(event.source, "writer")).toBe(false);
    }
  });

  it("P-C2 uses the v2 digest, keeps other hashes v1, and signs the whole bundle", async () => {
    const f = machineFixture(true);
    f.machine.onStart = () => {
      f.machine.emit("execution_started");
      f.machine.emit("instrument_result");
      f.machine.emit("execution_completed");
    };

    const result = await f.run();
    expect(result.success).toBe(true);
    const bundle = f.bundles[0]!;
    const proof = bundle.events.find((event) => event.type === "method_loaded")!;
    expect(proof.source.writer).toBe("kernel");
    expect(await verifyEventHash(proof)).toBe(true);
    await expect(hashEvent(withoutIdentity(proof))).rejects.toThrow(
      "source.writer is reserved for kernel-written events",
    );
    for (const event of bundle.events.filter((entry) => entry !== proof)) {
      expect(Object.hasOwn(event.source, "writer")).toBe(false);
      expect(event.hash).toBe(await hashEvent(withoutIdentity(event)));
      expect(await verifyEventHash(event)).toBe(true);
    }
    expect(await verifyBundleHash(bundle)).toBe(true);
    expect(bundle.kernelSignature.algorithm).toBe("ed25519");
    expect(validSignature(bundle, f.signer.publicKeyHex)).toBe(true);
  });

  it("P-C3 leaves machine.source writer-free after a successful run", async () => {
    const f = machineFixture(true);
    const initialSource = structuredClone(f.machine.source);
    const result = await f.run();

    expect(result.success).toBe(true);
    expect(f.machine.source).toStrictEqual(initialSource);
    expect(Object.hasOwn(f.machine.source, "writer")).toBe(false);
    expect(f.bundles[0]!.events[0]!.source).not.toBe(f.machine.source);
  });

  it("P-C4 overrides a configured machine writer without marking adapter events", async () => {
    const f = machineFixture(true);
    const cleanSource = { ...f.machine.source };
    ownWriter(f.machine.source, "adapter");
    f.machine.emissionSource = cleanSource;

    const result = await f.run();

    expect(result.success).toBe(true);
    const events = f.bundles[0]!.events;
    expect(markedEvents(events)).toStrictEqual([
      events.find((event) => event.type === "method_loaded"),
    ]);
    expect(events.find((event) => event.type === "method_loaded")!.source.writer).toBe("kernel");
    expect((f.machine.source as unknown as { writer: string }).writer).toBe("adapter");
    for (const event of events) expect(await verifyEventHash(event)).toBe(true);
  });

  it.each([
    ["bare success", (command: MachineCommand, machine: Machine): MachineCommandResult => ({ success: true })],
    ["other hash", (command: MachineCommand, machine: Machine): MachineCommandResult => ({
      success: true,
      data: { jobId: command.payload?.jobId, inputHash: OTHER_H, deviceJobId: machine.deviceJobId },
    })],
    ["empty deviceJobId", (command: MachineCommand, _machine: Machine): MachineCommandResult => ({
      success: true,
      data: { jobId: command.payload?.jobId, inputHash: command.payload?.inputHash, deviceJobId: "" },
    })],
  ] as const)("P-K8 %s never calls the kernel writer before an ack is accepted", async (_name, ack) => {
    const f = machineFixture(true);
    f.machine.onPrepare = (command) => ack(command, f.machine);
    const writer = vi.spyOn(f.emitter, "addKernelWrittenEvent");
    const add = vi.spyOn(f.emitter, "addEvent");

    const result = await f.run();

    expectNoJobBundle(f, result);
    expect(writer).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(f.emitter.getEvents(f.config.jobId, f.config.stepId)).toEqual([]);
    expect(f.machine.commands.map((command) => command.type)).toStrictEqual(["prepare"]);
  });
});

describe("L and PT: JobRunner legacy and adapter pass-through", () => {
  it("L-A rejects a legacy instrument_result carrying an own writer", async () => {
    const f = machineFixture(false);
    ownWriter(f.machine.source, "kernel");
    f.machine.onStart = () => {
      f.machine.emit("instrument_result");
      f.machine.emit("execution_completed");
    };

    const result = await f.run();
    expectNoJobBundle(f, result);
    expect(result.error).toContain(
      "a instrument_result event of this job could not be recorded " +
      "(source.writer is reserved for kernel-written events)",
    );
  });

  it("L-A2 rejects a writer-marked legacy method_loaded without inputHash", async () => {
    const f = machineFixture(false);
    ownWriter(f.machine.source, "kernel");
    f.machine.onStart = () => {
      f.machine.emit("method_loaded", { gcodeHash: H, jobId: f.config.jobId });
      f.machine.emit("execution_completed");
    };

    const result = await f.run();
    expectNoJobBundle(f, result);
    expect(result.error).toContain(
      "a method_loaded event of this job could not be recorded " +
      "(source.writer is reserved for kernel-written events)",
    );
  });

  it("L-B rejects an unmarked method_loaded carrying inputHash", async () => {
    const f = machineFixture(false);
    f.machine.onStart = () => {
      f.machine.emit("method_loaded", { inputHash: H });
      f.machine.emit("execution_completed");
    };

    const result = await f.run();
    expectNoJobBundle(f, result);
    expect(result.error).toBe("an adapter emitted method_loaded");
  });

  it("L-C T2 leaves all legacy evidence unmarked and never calls the kernel writer", async () => {
    const f = machineFixture(false);
    const writer = vi.spyOn(f.emitter, "addKernelWrittenEvent");
    const result = await f.run();

    expect(result.success).toBe(true);
    expect(writer).not.toHaveBeenCalled();
    expect(f.bundles).toHaveLength(1);
    expect(markedEvents(f.bundles[0]!.events)).toEqual([]);
    expect(f.machine.commands.map((command) => command.type)).toStrictEqual(["load_gcode", "start"]);
    for (const event of f.bundles[0]!.events) {
      expect(await verifyEventHash(event)).toBe(true);
    }
  });

  it("PT-A a configured shared source writer fails the PyLabRobot-shaped adapter", async () => {
    const f = machineFixture(false);
    ownWriter(f.machine.source, "adapter");
    f.machine.onStart = () => {
      f.machine.emit("instrument_result", { sample: 1 });
      f.machine.emit("execution_completed");
    };

    const result = await f.run();
    expectNoJobBundle(f, result);
    expect(result.error).toContain("source.writer is reserved for kernel-written events");
  });

  it("PT-B a sidecar-style legacy method_loaded with inputHash is refused", async () => {
    const f = machineFixture(false);
    f.machine.onStart = () => {
      f.machine.emit("method_loaded", {
        jobId: f.config.jobId,
        deviceJobId: f.machine.deviceJobId,
        inputHash: H,
        sidecarType: "method_loaded",
      });
      f.machine.emit("execution_completed");
    };

    const result = await f.run();
    expectNoJobBundle(f, result);
    expect(result.error).toBe("an adapter emitted method_loaded");
  });

  it.each([false, true])(
    "PT-C retains PyLabRobot method_loaded with mock=%s, without writer or inputHash",
    async (mock) => {
      const f = machineFixture(false);
      f.machine.onStart = () => {
        f.machine.emit("method_loaded", {
          jobId: f.config.jobId,
          gcodeHash: H,
          ...(mock ? { mock: true } : {}),
        });
        f.machine.emit("execution_completed");
      };

      const result = await f.run();

      expect(result.success).toBe(true);
      const method = f.bundles[0]!.events.find((event) => event.type === "method_loaded")!;
      expect(Object.hasOwn(method.source, "writer")).toBe(false);
      expect(Object.hasOwn(method.payload, "inputHash")).toBe(false);
      expect(method.payload).toMatchObject({
        jobId: f.config.jobId,
        gcodeHash: H,
        ...(mock ? { mock: true } : {}),
      });
      expect(method.hash).toBe(await hashEvent(withoutIdentity(method)));
      expect(await verifyEventHash(method)).toBe(true);
    },
  );
});

let nextPrinter = 0;

class Printer implements MachineAdapter {
  readonly id = `writer-printer-${++nextPrinter}`;
  readonly type = "ipp-2d" as const;
  source: EvidenceSource = { deviceId: this.id, deviceType: "controller", kernelId: KERNEL };
  listeners: Array<(event: RawEvent) => void> = [];
  commands: MachineCommand[] = [];
  cancels: Array<string | number> = [];
  onStart?: () => void;
  onCancel?: () => void;
  afterEmit?: (event: RawEvent) => void;

  emit(
    type: EvidenceEvent["type"],
    payload: Record<string, unknown> = {},
    bound = true,
    eventSource: EvidenceSource = this.source,
  ): RawEvent {
    const event: RawEvent = {
      type,
      timestamp: new Date().toISOString(),
      source: eventSource,
      payload: { ...(bound ? { ippJobId: "dj-print" } : {}), ...payload },
    };
    for (const listener of this.listeners) listener(event);
    this.afterEmit?.(event);
    return event;
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    this.commands.push(command);
    if (command.type === "start") {
      if (this.onStart) this.onStart();
      else this.emit("execution_completed");
      return { success: true, data: { jobId: "dj-print" } };
    }
    return { success: true };
  }

  async cancelJob(jobId: string | number): Promise<void> {
    this.cancels.push(jobId);
    this.onCancel?.();
  }

  async getStatus() { return "idle" as const; }
  async getProgress() { return 100; }
  onEvidence(callback: (event: RawEvent) => void) { this.listeners.push(callback); }
  async quiesceEvidence() {}
  async dispose() {}
}

function printFixture() {
  const printer = new Printer();
  const signer = makeKernelEd25519Signer(SEED);
  const emitter = new EvidenceEmitter(KERNEL, signer.signFn);
  const bundles: EvidenceBundle[] = [];
  emitter.onBundle((bundle) => bundles.push(bundle));

  const options: PrintJobOptions = {
    adapter: printer,
    emitter,
    jobId: `job-${printer.id}`,
    stepId: "print",
    jobName: "writer-test.pdf",
    totalPages: 1,
    timeoutMs: 50,
    cancelWindowMs: 10,
    evidenceQuiesceTimeoutMs: 50,
    evidenceSettleTimeoutMs: 50,
  };
  const run = (overrides: Partial<PrintJobOptions> = {}) =>
    runPrintJob({ ...options, ...overrides });
  return { printer, emitter, signer, bundles, options, run };
}

type PrintFixture = ReturnType<typeof printFixture>;

function expectNoPrintBundle(f: PrintFixture, result: PrintJobResult): void {
  expect(result.success).toBe(false);
  expect(result.bundle).toBeUndefined();
  expect(result.events).toEqual([]);
  expect(result.failure).toBeUndefined();
  expect(f.bundles).toEqual([]);
}

describe("R and RU: runPrintJob input proof boundaries", () => {
  it("R-A bound completion with writer fails closed with the existing lost-event text", async () => {
    const f = printFixture();
    ownWriter(f.printer.source, "kernel");

    const result = await f.run();

    expectNoPrintBundle(f, result);
    expect(result.error).toBe(
      "a execution_completed event of this job could not be recorded " +
      "(source.writer is reserved for kernel-written events), so its evidence is incomplete",
    );
  });

  it("R-A2 unbound marked evidence is excluded and the print succeeds", async () => {
    const f = printFixture();
    const rogueSource = { ...f.printer.source };
    ownWriter(rogueSource, "kernel");
    f.printer.onStart = () => {
      f.printer.emit("instrument_result", {}, false, rogueSource);
      f.printer.emit("execution_completed");
    };

    const result = await f.run();

    expect(result.success).toBe(true);
    expect(result.bundle?.events.map((event) => event.type)).toStrictEqual([
      "execution_completed",
    ]);
    expect(markedEvents(result.bundle!.events)).toEqual([]);
  });

  it.each([
    { id: "R-B matching hash without unit", inputHash: H, unit: false },
    { id: "R-B own undefined without unit", inputHash: undefined, unit: false },
    { id: "RU-B matching hash with unit", inputHash: H, unit: true },
    { id: "RU-B own undefined with unit", inputHash: undefined, unit: true },
  ])("$id is refused without sending method_loaded to addEvent", async ({ inputHash, unit }) => {
    const f = printFixture();
    const add = vi.spyOn(f.emitter, "addEvent");
    f.printer.onStart = () => {
      // Both arrive inside start, before its device-job id is returned.
      f.printer.emit("method_loaded", { inputHash });
      f.printer.emit("execution_completed");
    };

    const result = await f.run(unit ? UNIT : {});

    expectNoPrintBundle(f, result);
    expect(result.error).toBe("an adapter emitted method_loaded carrying inputHash");
    expect(add.mock.calls.every(([, , event]) => event.type !== "method_loaded")).toBe(true);
    expect(f.printer.commands.map((command) => command.type)).toStrictEqual(["start"]);
  });

  it("R-B2 unbound method_loaded carrying inputHash remains excluded", async () => {
    const f = printFixture();
    f.printer.onStart = () => {
      f.printer.emit("method_loaded", { inputHash: H }, false);
      f.printer.emit("execution_completed");
    };

    const result = await f.run();

    expect(result.success).toBe(true);
    expect(result.bundle?.events.map((event) => event.type)).toStrictEqual([
      "execution_completed",
    ]);
    expect(f.bundles).toHaveLength(1);
  });

  it("R-B3 a bound input proof prevents signing even a device failure bundle", async () => {
    const f = printFixture();
    const add = vi.spyOn(f.emitter, "addEvent");
    f.printer.onStart = () => {
      f.printer.emit("method_loaded", { inputHash: H });
      f.printer.emit("execution_failed", { state: "aborted" });
    };

    const result = await f.run();

    expectNoPrintBundle(f, result);
    expect(result.error).toBe("an adapter emitted method_loaded carrying inputHash");
    expect(add.mock.calls.every(([, , event]) => event.type !== "method_loaded")).toBe(true);
  });

  it.each(["success", "device-failure", "kernel-failure"] as const)(
    "R-C T3 every event in a %s print bundle remains unmarked v1",
    async (mode) => {
      // Real timers are required for this row: crypto and the evidence chain
      // settle on real promises, independent of Vitest's fake clock (F6).
      const f = printFixture();
      if (mode === "device-failure") {
        f.printer.onStart = () => { f.printer.emit("execution_failed", { state: "aborted" }); };
      } else if (mode === "kernel-failure") {
        f.printer.onStart = () => {}; // silent adapter; quiesce resolves in the fixture
      }

      const result = await f.run(mode === "kernel-failure"
        ? { timeoutMs: 25, cancelWindowMs: 25, evidenceSettleTimeoutMs: 15_000 }
        : {});

      expect(f.bundles).toHaveLength(1);
      expect(result.bundle).toBeDefined();
      expect(result.success).toBe(mode === "success");
      if (mode === "kernel-failure") {
        expect(result.failure).toStrictEqual({ kind: "timeout", origin: "kernel" });
        expect(result.cancelRequested).toBe("timeout");
      }
      const bundle = result.bundle!;
      expect(markedEvents(bundle.events)).toEqual([]);
      expect(await verifyBundleHash(bundle)).toBe(true);
      expect(validSignature(bundle, f.signer.publicKeyHex)).toBe(true);
      for (const event of bundle.events) {
        expect(event.hash).toBe(await hashEvent(withoutIdentity(event)));
        expect(await verifyEventHash(event)).toBe(true);
      }
    },
  );
});

describe("PS and RQ: the settled evidence is the final authoring boundary", () => {
  it.each([
    ["PS-P", true],
    ["PS-L", false],
  ] as const)("%s refuses a marker added to the adapter source after recording", async (_id, prepare) => {
    const f = machineFixture(prepare);
    const real = f.emitter.addEvent.bind(f.emitter);
    vi.spyOn(f.emitter, "addEvent").mockImplementation(async (jobId, stepId, event) => {
      const stored = await real(jobId, stepId, event);
      if (event.type === "execution_completed") {
        ownWriter(f.machine.source, "kernel");
      }
      return stored;
    });

    const result = await f.run();

    expectNoJobBundle(f, result);
    expect(result.error).toBe(
      "the bundle would carry a kernel-written marker the kernel did not write",
    );
  });

  it("PS-R refuses a marker added to a bound print event after it was stored", async () => {
    const f = printFixture();
    const real = f.emitter.addEvent.bind(f.emitter);
    vi.spyOn(f.emitter, "addEvent").mockImplementation(async (jobId, stepId, event) => {
      const stored = await real(jobId, stepId, event);
      if (event.type === "execution_completed") {
        ownWriter(f.printer.source, "kernel");
      }
      return stored;
    });

    const result = await f.run();

    expectNoPrintBundle(f, result);
    expect(result.error).toBe(
      "the bundle would carry a kernel-written marker the kernel did not write",
    );
  });

  it("RQ queued mutation into method_loaded plus inputHash reaches the emitter backstop", async () => {
    const f = printFixture();
    f.printer.onStart = () => {}; // No early evidence before start returns its job id.
    f.printer.afterEmit = (event) => {
      if (event.type === "instrument_result") {
        event.type = "method_loaded";
        event.payload.inputHash = H;
      }
    };

    const pending = f.run({ timeoutMs: 5_000 });
    // Give printOnce's await of start its continuation: deviceJob.id is set.
    // admit() then queues the original type before afterEmit changes it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.printer.emit("instrument_result", { sample: 1 });
    f.printer.emit("execution_completed");
    const result = await pending;

    expectNoPrintBundle(f, result);
    expect(result.error).toBe(
      "a method_loaded event of this job could not be recorded " +
      "(a method_loaded carrying inputHash must be kernel-written), so its evidence is incomplete",
    );
  });
});
