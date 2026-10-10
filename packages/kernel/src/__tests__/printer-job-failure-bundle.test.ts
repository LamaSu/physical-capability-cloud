/**
 * ADK-2 / ADK-5: signed print failures, cancelJob, unit commitments and device busy.
 *
 * Each test names the production expression whose revert defeats its assertion.
 * The fake clock controls all device work; hashes run on microtasks so crypto I/O
 * cannot race that clock. The signer and detached Ed25519 verification are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import type { EvidenceBundle, EvidenceEvent, EvidenceSource } from "@pcc/spec";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { IppAdapter } from "../adapters/ipp-adapter.js";
import { OutstandingWork } from "../adapters/outstanding-work.js";
import type { MachineAdapter, MachineCommand, MachineCommandResult } from "../adapters/types.js";
import {
  createIppPrintKernel,
  makeKernelEd25519Signer,
  runPrintJob,
  type PrintJobOptions,
  type PrintJobResult,
} from "../printer-job.js";

vi.mock("@pcc/spec", async (importOriginal) => {
  const spec = await importOriginal<typeof import("@pcc/spec")>();
  const { createHash } = await import("node:crypto");
  const digest = (value: unknown) => `sha256:${createHash("sha256").update(spec.canonicalize(value)).digest("hex")}`;
  return {
    ...spec,
    hashEvent: async (event: unknown) => digest(event),
    hashBundle: async (events: unknown) => digest(events),
  };
});

type Emitted = Omit<EvidenceEvent, "id" | "hash">;
const KERNEL_ID = "kernel-adk-failure";
const SEED = new Uint8Array(32).fill(23);
const UNIT = { settlementUnitId: `0x${"a".repeat(64)}`, challengeNonce: `0x${"b".repeat(64)}` };
let nextFixture = 0;

interface Printer extends MachineAdapter {
  commands: MachineCommand[];
  cancels: Array<string | number>;
  listeners: Array<(event: Emitted) => void>;
  job: number;
  emit(type: Emitted["type"], payload?: Record<string, unknown>): void;
  later(delay: number, callback: () => void): void;
}

interface PrinterBehavior {
  start?: (printer: Printer) => MachineCommandResult | Promise<MachineCommandResult>;
  cancel?: (printer: Printer, job: string | number) => void | Promise<void>;
  quiesce?: () => Promise<void>;
  source?: EvidenceSource;
}

function fixture(behavior: PrinterBehavior = {}) {
  const id = `adk-printer-${nextFixture++}`;
  const work = new OutstandingWork();
  const signer = makeKernelEd25519Signer(SEED);
  const emitter = new EvidenceEmitter(KERNEL_ID, signer.signFn);
  const printer: Printer = {
    id,
    type: "ipp-2d",
    source: behavior.source ?? { deviceId: id, deviceType: "controller", kernelId: KERNEL_ID },
    commands: [],
    cancels: [],
    listeners: [],
    job: 417,
    async getStatus() { return "busy"; },
    async getProgress() { return 0; },
    async execute(command) {
      printer.commands.push(command);
      if (command.type !== "start") return { success: true, message: "acknowledged" };
      if (behavior.start) return behavior.start(printer);
      printer.emit("execution_started");
      return { success: true, data: { jobId: printer.job } };
    },
    async cancelJob(job) {
      printer.cancels.push(job);
      await behavior.cancel?.(printer, job);
    },
    onEvidence(callback) { printer.listeners.push(callback); },
    emit(type, payload = {}) {
      const event: Emitted = {
        type,
        timestamp: new Date().toISOString(),
        source: printer.source,
        payload: { ippJobId: printer.job, ...payload },
      };
      for (const listener of [...printer.listeners]) listener(event);
    },
    later(delay, callback) {
      const end = work.begin();
      setTimeout(() => {
        try { callback(); } finally { end(); }
      }, delay);
    },
    quiesceEvidence() { return behavior.quiesce ? behavior.quiesce() : work.idle(); },
    async dispose() {},
  };
  const options: PrintJobOptions = {
    adapter: printer,
    emitter,
    jobId: `pcc-${id}`,
    stepId: "print",
    jobName: "invoice.pdf",
    totalPages: 3,
    timeoutMs: 50,
    cancelWindowMs: 30,
    evidenceQuiesceTimeoutMs: 40,
    evidenceSettleTimeoutMs: 40,
  };
  return { printer, emitter, signer, options };
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function signed(result: PrintJobResult, publicKeyHex: string): EvidenceBundle {
  expect(result.bundle).toBeDefined();
  const bundle = result.bundle!;
  expect(bundle.kernelSignature.algorithm).toBe("ed25519");
  expect(nacl.sign.detached.verify(
    new TextEncoder().encode(bundle.bundleHash),
    fromHex(bundle.kernelSignature.value),
    fromHex(publicKeyHex),
  )).toBe(true);
  expect(result.events).toBe(bundle.events);
  return bundle;
}

function eventless(result: PrintJobResult): void {
  expect(result.success).toBe(false);
  expect(result.bundle).toBeUndefined();
  expect(result.failure).toBeUndefined();
  expect(result.events).toEqual([]);
}

async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let count = 0; count < 100; count++) {
    await vi.advanceTimersByTimeAsync(0);
    if (settled) return promise;
    if (vi.getTimerCount() === 0) throw new Error("print pending with no timer left");
    await vi.advanceTimersToNextTimerAsync();
  }
  throw new Error("print pending after 100 timers");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const reportCanceled = (printer: Printer) => {
  printer.later(5, () => printer.emit("execution_failed", { state: "canceled" }));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ADK signed failure bundles and cancel input", () => {
  it("T1: device_reported branch finalizes a signed failure and failed-step cleanup detaches it (printer-job.ts:639 emitter.finalizeBundle)", async () => {
    const f = fixture();
    const pending = runPrintJob(f.options);
    await vi.advanceTimersByTimeAsync(0);
    f.printer.emit("execution_failed", { state: "aborted", message: "paper jam" });
    const result = await drive(pending);
    const bundle = signed(result, f.signer.publicKeyHex);
    expect(result.success).toBe(false);
    expect(result.failure).toEqual({ kind: "device_reported", origin: "device" });
    expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
    expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(false);
    expect(f.emitter.getEvents(f.options.jobId, "print")).toEqual([]);
    expect(f.printer.cancels).toEqual([]);
    expect(result.cancelRequested).toBeUndefined();
  });

  it("T2: timeout sends exactly one cancelJob and signs its device failure (printer-job.ts:586 cancelJob.call)", async () => {
    const f = fixture({ cancel: reportCanceled });
    const result = await drive(runPrintJob(f.options));
    const bundle = signed(result, f.signer.publicKeyHex);
    expect(result.success).toBe(false);
    expect(result.failure).toEqual({ kind: "timeout", origin: "device" });
    expect(result.cancelRequested).toBe("timeout");
    expect(f.printer.cancels).toEqual([f.printer.job]);
    expect(f.printer.commands.map((command) => command.type)).toEqual(["start"]);
    expect(bundle.events.filter((event) => event.type === "execution_failed")).toHaveLength(1);
    expect(bundle.events.find((event) => event.type === "execution_failed")!.payload.state).toBe("canceled");
    expect(f.emitter.getEvents(f.options.jobId, "print")).toEqual([]);
  });

  it("T3: silent cancel produces one bound kernel failure after cancelWindowMs, preserving simulated source (printer-job.ts:599 admit(kernelFailure))", async () => {
    const source: EvidenceSource = { deviceId: "silent-sim", deviceType: "controller", kernelId: "original-kernel", simulated: true };
    const f = fixture({ source });
    const pending = runPrintJob({ ...f.options, ...UNIT });
    await vi.advanceTimersByTimeAsync(50);
    expect(f.printer.cancels).toEqual([f.printer.job]);
    let returned = false;
    void pending.then(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(29);
    expect(returned).toBe(false);
    const result = await drive(pending);
    const bundle = signed(result, f.signer.publicKeyHex);
    expect(result.failure).toEqual({ kind: "timeout", origin: "kernel" });
    expect(result.cancelRequested).toBe("timeout");
    expect(result.durationMs).toBe(80);
    const failures = bundle.events.filter((event) => event.type === "execution_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toEqual({ ippJobId: f.printer.job, reason: "timeout", origin: "kernel", jobId: f.options.jobId, ...UNIT });
    expect(failures[0]!.source).toEqual(source);
    expect(failures[0]!.source.kernelId).toBe(f.printer.source.kernelId);
    expect(failures[0]!.source.simulated).toBe(true);
    expect(failures[0]!.timestamp).toBe(new Date().toISOString());
    for (const event of bundle.events) expect(event.payload).toMatchObject({ jobId: f.options.jobId, ...UNIT });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("T4: no cancelJob fails closed without cancelRequested (printer-job.ts:571 typeof cancelJob)", async () => {
    const f = fixture();
    delete f.printer.cancelJob;
    const result = await drive(runPrintJob(f.options));
    eventless(result);
    expect(result.error).toMatch(/cannot cancel|no cancelJob|cancelJob.*(?:missing|unavailable)/i);
    expect(result.cancelRequested).toBeUndefined();
    expect(f.printer.commands.map((command) => command.type)).toEqual(["start"]);
  });

  it("T5: abort after start cancels promptly and signs the device failure (printer-job.ts:521 signal.addEventListener)", async () => {
    const f = fixture({ cancel: reportCanceled });
    const controller = new AbortController();
    const pending = runPrintJob({ ...f.options, timeoutMs: 10_000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const result = await drive(pending);
    signed(result, f.signer.publicKeyHex);
    expect(result.success).toBe(false);
    expect(result.failure).toEqual({ kind: "aborted", origin: "device" });
    expect(result.cancelRequested).toBe("aborted");
    expect(result.durationMs).toBeLessThan(10_000);
    expect(f.printer.cancels).toEqual([f.printer.job]);
    expect(f.printer.commands.map((command) => command.type)).toEqual(["start"]);
  });

  it("T6: an already-aborted signal refuses before start, registration or session (printer-job.ts:343 signal.aborted preflight)", async () => {
    const f = fixture();
    const registered = vi.spyOn(f.emitter, "registerStep");
    const controller = new AbortController();
    controller.abort();
    const result = await runPrintJob({ ...f.options, signal: controller.signal });
    eventless(result);
    expect(result.error).toMatch(/abort/i);
    expect(f.printer.commands).toEqual([]);
    expect(f.printer.listeners).toEqual([]);
    expect(registered).not.toHaveBeenCalled();
    expect(result.cancelRequested).toBeUndefined();
  });

  it("T7: reusing one signal for five prints leaves zero listeners and no late cancellation (printer-job.ts:704 removeEventListener)", async () => {
    const f = fixture({ start: (printer) => {
      printer.emit("execution_started");
      printer.emit("execution_completed", { totalPages: 3 });
      return { success: true, data: { jobId: printer.job++ } };
    } });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    for (let index = 0; index < 5; index++) {
      const result = await drive(runPrintJob({ ...f.options, jobId: `sequential-${index}`, signal: controller.signal }));
      expect(result.success).toBe(true);
      signed(result, f.signer.publicKeyHex);
      expect(result.cancelRequested).toBeUndefined();
    }
    const additions = added.mock.calls.filter(([type]) => type === "abort");
    const removals = removed.mock.calls.filter(([type]) => type === "abort");
    expect(additions).toHaveLength(5);
    expect(removals).toHaveLength(additions.length);
    for (let index = 0; index < additions.length; index++) expect(removals[index]![1]).toBe(additions[index]![1]);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.printer.cancels).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["execution_completed", "execution_failed"] as const)("T8: every device event commits the unit for %s (printer-job.ts:479 emitter.registerStep unit argument)", async (terminal) => {
    const f = fixture({ start: (printer) => {
      printer.emit("execution_started");
      printer.emit("execution_progress", { totalPages: 3, currentPage: 1 });
      printer.emit(terminal, { totalPages: 3 });
      return { success: true, data: { jobId: printer.job } };
    } });
    const result = await drive(runPrintJob({ ...f.options, ...UNIT }));
    const bundle = signed(result, f.signer.publicKeyHex);
    expect(bundle.events).toHaveLength(3);
    for (const event of bundle.events) expect(event.payload).toMatchObject({ jobId: f.options.jobId, ...UNIT });
  });

  it.each([
    { settlementUnitId: UNIT.settlementUnitId },
    { challengeNonce: UNIT.challengeNonce },
  ])("T8: a lone unit field %j refuses before anything is held (printer-job.ts:340 both-or-neither unit preflight)", async (unit) => {
    const f = fixture();
    const registered = vi.spyOn(f.emitter, "registerStep");
    const result = await runPrintJob({ ...f.options, ...unit });
    eventless(result);
    expect(f.printer.commands).toEqual([]);
    expect(f.printer.listeners).toEqual([]);
    expect(registered).not.toHaveBeenCalled();
  });

  it("T8: uppercase unit hex is refused through registerStep before start (printer-job.ts:479 emitter.registerStep unit argument)", async () => {
    const f = fixture();
    const result = await drive(runPrintJob({ ...f.options, ...UNIT, settlementUnitId: `0x${"A".repeat(64)}` }));
    eventless(result);
    expect(result.error).toContain("64 lowercase hex");
    expect(f.printer.commands).toEqual([]);
    expect(f.emitter.getEvents(f.options.jobId, "print")).toEqual([]);
  });

  it("T9: top-level busy refusal is device busy and records nothing (printer-job.ts:537 startResult.busy)", async () => {
    const f = fixture({ start: () => ({ success: false, busy: true, message: "occupied", data: { busy: false } }) });
    const recorded = vi.spyOn(f.emitter, "addEvent");
    const result = await drive(runPrintJob(f.options));
    eventless(result);
    expect(result.busy).toEqual({ reason: "device", adapterId: f.printer.id, jobId: f.options.jobId });
    expect(recorded).not.toHaveBeenCalled();
    expect(f.printer.cancels).toEqual([]);
    expect(f.emitter.getEvents(f.options.jobId, "print")).toEqual([]);
  });

  it("T9: data.busy alone never classifies a start failure as busy (printer-job.ts:537 startResult.busy)", async () => {
    const f = fixture({ start: () => ({ success: false, message: "document rejected", data: { busy: true } }) });
    const recorded = vi.spyOn(f.emitter, "addEvent");
    const result = await drive(runPrintJob(f.options));
    eventless(result);
    expect(result.busy).toBeUndefined();
    expect(recorded).not.toHaveBeenCalled();
  });

  it.each([
    ["execution_completed", "execution_failed"],
    ["execution_failed", "execution_completed"],
  ] as const)("T10: contradictory terminal order %s then %s signs a contradiction (printer-job.ts:643 completed !== null contradiction verdict)", async (first, second) => {
    const f = fixture({ start: (printer) => {
      printer.emit("execution_started");
      printer.emit(first);
      printer.emit(second);
      return { success: true, data: { jobId: printer.job } };
    } });
    const result = await drive(runPrintJob(f.options));
    const bundle = signed(result, f.signer.publicKeyHex);
    expect(result.success).toBe(false);
    expect(result.failure).toEqual({ kind: "contradiction", origin: "device" });
    expect(bundle.events.filter((event) => event.type === "execution_completed")).toHaveLength(1);
    expect(bundle.events.filter((event) => event.type === "execution_failed")).toHaveLength(1);
    expect(f.emitter.getEvents(f.options.jobId, "print")).toEqual([]);
    expect(result.cancelRequested).toBeUndefined();
  });

  it.each([NaN, -1, 2 ** 31, "1", Symbol("delay")])("T11: invalid cancelWindowMs %s is refused before any hold (printer-job.ts:338 isTimerDelay cancelWindowMs)", async (delay) => {
    const f = fixture();
    const registered = vi.spyOn(f.emitter, "registerStep");
    const result = await runPrintJob({ ...f.options, cancelWindowMs: delay as number });
    eventless(result);
    expect(result.error).toContain("cancelWindowMs");
    expect(f.printer.commands).toEqual([]);
    expect(f.printer.listeners).toEqual([]);
    expect(registered).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("T12: mock cancelJob(activeId) emits exactly one failure before quiesce resolves (ipp-adapter.ts:295 mock cancel emit before cancelMockJob)", async () => {
    const adapter = new IppAdapter("adk-mock-active", { kernelId: KERNEL_ID, uri: "ipp://mock/print", mockMode: true });
    const events: Emitted[] = [];
    const order: string[] = [];
    adapter.onEvidence((event) => { events.push(event); order.push(event.type); });
    const start = await adapter.execute({ type: "start", payload: { jobName: "active.pdf", totalPages: 3 } });
    const job = start.data!.jobId as number;
    const canceled = adapter.cancelJob(job);
    const quiesced = adapter.quiesceEvidence().then(() => { order.push("quiesced"); });
    await Promise.all([canceled, quiesced]);
    await adapter.cancelJob(job);
    await vi.advanceTimersByTimeAsync(5_000);
    const failures = events.filter((event) => event.type === "execution_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toEqual({ ippJobId: job, jobName: "active.pdf", state: "canceled", mock: true });
    expect(failures[0]!.source).toEqual(adapter.source);
    expect(order.indexOf("execution_failed")).toBeLessThan(order.indexOf("quiesced"));
    expect(events.some((event) => event.type === "execution_completed")).toBe(false);
    expect(await adapter.getStatus()).toBe("idle");
    await adapter.dispose();
  });

  it("T12: mock cancelJob(otherId) emits nothing and leaves the active print running (ipp-adapter.ts:292 mock jobId equality)", async () => {
    const adapter = new IppAdapter("adk-mock-other", { kernelId: KERNEL_ID, uri: "ipp://mock/print", mockMode: true });
    const events: Emitted[] = [];
    adapter.onEvidence((event) => events.push(event));
    const start = await adapter.execute({ type: "start", payload: { totalPages: 3 } });
    const job = start.data!.jobId as number;
    const before = events.length;
    await adapter.cancelJob(job + 999);
    expect(events).toHaveLength(before);
    expect(await adapter.getStatus()).toBe("busy");
    const refused = await adapter.execute({ type: "start", payload: { totalPages: 1 } });
    expect(refused).toMatchObject({ success: false, busy: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(events.some((event) => event.type === "execution_progress" && event.payload.ippJobId === job)).toBe(true);
    await adapter.cancelJob(job);
    await adapter.quiesceEvidence();
    await adapter.dispose();
  });

  it("T13: turnkey 3-page mock timeout signs the mock's cancel failure (printer-job.ts:586 cancelJob; ipp-adapter.ts:295 mock cancellation evidence)", async () => {
    const kernel = createIppPrintKernel({ kernelId: KERNEL_ID, deviceId: "adk-turnkey", mockMode: true, seed: SEED });
    const cancel = vi.spyOn(kernel.adapter, "cancelJob");
    const execute = vi.spyOn(kernel.adapter, "execute");
    const result = await drive(kernel.print({ jobId: "turnkey-timeout", jobName: "three.pdf", totalPages: 3, timeoutMs: 600 }));
    const bundle = signed(result, kernel.signer.publicKeyHex);
    expect(result.success).toBe(false);
    expect(result.failure).toEqual({ kind: "timeout", origin: "device" });
    expect(result.cancelRequested).toBe("timeout");
    expect(cancel).toHaveBeenCalledTimes(1);
    const failure = bundle.events.find((event) => event.type === "execution_failed")!;
    expect(failure.payload).toMatchObject({ state: "canceled", mock: true, jobId: "turnkey-timeout" });
    expect(failure.source.simulated).toBe(true);
    expect(cancel).toHaveBeenCalledWith(failure.payload.ippJobId);
    expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(false);
    expect(execute.mock.calls.map(([command]) => command.type)).toEqual(["start"]);
    await kernel.dispose();
  });

  it("T14: completion winning after cancel is a signed success with cancelRequested (printer-job.ts:690 successful cancelRequested return)", async () => {
    const f = fixture({ cancel: (printer) => {
      printer.later(5, () => printer.emit("execution_completed", { totalPages: 3 }));
    } });
    const result = await drive(runPrintJob(f.options));
    const bundle = signed(result, f.signer.publicKeyHex);
    expect(result.success).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.cancelRequested).toBe("timeout");
    expect(f.printer.cancels).toEqual([f.printer.job]);
    expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(true);
    expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(false);
    expect(result.completion?.printerJobId).toBe(f.printer.job);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a rejected cancel keeps its error while accepting the device's terminal evidence (printer-job.ts:583 cancelJob catch continues)", async () => {
    const f = fixture({ cancel: (printer) => {
      reportCanceled(printer);
      throw new Error("cancel transport rejected");
    } });
    const result = await drive(runPrintJob(f.options));
    signed(result, f.signer.publicKeyHex);
    expect(result.failure).toEqual({ kind: "timeout", origin: "device" });
    expect(result.error).toContain("cancel transport rejected");
    expect(f.printer.cancels).toEqual([f.printer.job]);
  });

  it("a rejected silent cancel still synthesizes a signed kernel failure and keeps its error (printer-job.ts:590 cancel window continues after rejection)", async () => {
    const f = fixture({ cancel: () => { throw new Error("cancel offline"); } });
    const result = await drive(runPrintJob(f.options));
    signed(result, f.signer.publicKeyHex);
    expect(result.failure).toEqual({ kind: "timeout", origin: "kernel" });
    expect(result.error).toContain("cancel offline");
    expect(result.events.filter((event) => event.type === "execution_failed")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a pending cancel cannot hold the terminal evidence window forever (printer-job.ts:590 Promise.race decided and cancelExpired)", async () => {
    const cancel = deferred<void>();
    const f = fixture({ cancel: () => cancel.promise, quiesce: () => cancel.promise });
    const result = await drive(runPrintJob(f.options));
    // An in-flight command cannot quiesce; its bounded handshake must fail closed.
    eventless(result);
    expect(result.cancelRequested).toBe("timeout");
    expect(result.durationMs).toBe(120);
    expect(result.error).toContain("quiesce");
    expect(f.printer.cancels).toEqual([f.printer.job]);
    cancel.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failure during post-cancel completion quiesce makes a signed contradiction (printer-job.ts:643 verdict after session.quiesce)", async () => {
    const quiet = deferred<void>();
    const f = fixture({
      cancel: (printer) => { printer.later(5, () => printer.emit("execution_completed", { totalPages: 3 })); },
      quiesce: () => quiet.promise,
    });
    const pending = runPrintJob(f.options);
    await vi.advanceTimersByTimeAsync(55);
    f.printer.emit("execution_failed", { state: "canceled" });
    quiet.resolve();
    const result = await drive(pending);
    const bundle = signed(result, f.signer.publicKeyHex);
    expect(result.success).toBe(false);
    expect(result.failure).toEqual({ kind: "contradiction", origin: "device" });
    expect(result.cancelRequested).toBe("timeout");
    expect(bundle.events.filter((event) => event.type === "execution_completed")).toHaveLength(1);
    expect(bundle.events.filter((event) => event.type === "execution_failed")).toHaveLength(1);
  });

  it("abort while start is in flight waits for its id then cancels immediately (printer-job.ts:554 abort latch checked after start)", async () => {
    const start = deferred<MachineCommandResult>();
    const f = fixture({ start: () => start.promise, cancel: reportCanceled });
    const controller = new AbortController();
    const pending = runPrintJob({ ...f.options, timeoutMs: 10_000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(f.printer.cancels).toEqual([]);
    start.resolve({ success: true, data: { jobId: f.printer.job } });
    const result = await drive(pending);
    signed(result, f.signer.publicKeyHex);
    expect(result.failure).toEqual({ kind: "aborted", origin: "device" });
    expect(result.cancelRequested).toBe("aborted");
    expect(f.printer.cancels).toEqual([f.printer.job]);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it("abort while a refused start is in flight preserves its plain start failure (printer-job.ts:535 startResult.success checked before cancel)", async () => {
    const start = deferred<MachineCommandResult>();
    const f = fixture({ start: () => start.promise });
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const pending = runPrintJob({ ...f.options, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    start.resolve({ success: false, message: "document refused" });
    const result = await drive(pending);
    eventless(result);
    expect(result.error).toContain("document refused");
    expect(result.cancelRequested).toBeUndefined();
    expect(f.printer.cancels).toEqual([]);
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("silent abort commits its distinct kernel reason (printer-job.ts:596 kernel failure reason cancelRequested)", async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = runPrintJob({ ...f.options, ...UNIT, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const result = await drive(pending);
    signed(result, f.signer.publicKeyHex);
    expect(result.failure).toEqual({ kind: "aborted", origin: "kernel" });
    expect(result.events.find((event) => event.type === "execution_failed")!.payload).toEqual({
      ippJobId: f.printer.job, reason: "aborted", origin: "kernel", jobId: f.options.jobId, ...UNIT,
    });
  });

  it("foreign evidence during cancellation remains eventless and is never recorded (printer-job.ts:605 foreignJob fail-closed)", async () => {
    const f = fixture({ cancel: (printer) => {
      printer.later(5, () => printer.emit("execution_failed", { ippJobId: printer.job + 1, state: "canceled" }));
    } });
    const recorded = vi.spyOn(f.emitter, "addEvent");
    const result = await drive(runPrintJob(f.options));
    eventless(result);
    expect(result.cancelRequested).toBe("timeout");
    expect(result.error).toContain("cannot be bound");
    expect(recorded.mock.calls.every(([, , event]) => event.payload.ippJobId === f.printer.job)).toBe(true);
    expect(f.emitter.getEvents(f.options.jobId, "print")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an unrecorded cancellation failure cannot be signed (printer-job.ts:628 unrecorded.first check before finalizeBundle)", async () => {
    const f = fixture({ cancel: reportCanceled });
    const add = f.emitter.addEvent.bind(f.emitter);
    vi.spyOn(f.emitter, "addEvent").mockImplementation((jobId, stepId, event) => {
      if (event.type === "execution_failed") return Promise.reject(new Error("failure store refused"));
      return add(jobId, stepId, event);
    });
    const finalized = vi.spyOn(f.emitter, "finalizeBundle");
    const result = await drive(runPrintJob(f.options));
    eventless(result);
    expect(result.cancelRequested).toBe("timeout");
    expect(result.error).toContain("failure store refused");
    expect(finalized).not.toHaveBeenCalled();
    expect(f.emitter.getEvents(f.options.jobId, "print")).toEqual([]);
  });

  it("quiesce timeout after a device cancellation failure stays eventless (printer-job.ts:613 session.quiesce before finalization)", async () => {
    const quiet = deferred<void>();
    const f = fixture({ cancel: reportCanceled, quiesce: () => quiet.promise });
    const finalized = vi.spyOn(f.emitter, "finalizeBundle");
    const result = await drive(runPrintJob(f.options));
    eventless(result);
    expect(result.cancelRequested).toBe("timeout");
    expect(result.error).toMatch(/quiesce|confirm.*evidence|evidence.*complete/i);
    expect(finalized).not.toHaveBeenCalled();
    expect(f.emitter.getEvents(f.options.jobId, "print")).toEqual([]);
    quiet.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settle timeout after a device cancellation failure stays eventless (printer-job.ts:622 bounded settle before finalization)", async () => {
    const pendingEvent = deferred<EvidenceEvent>();
    const f = fixture({ cancel: reportCanceled });
    const add = f.emitter.addEvent.bind(f.emitter);
    vi.spyOn(f.emitter, "addEvent").mockImplementation((jobId, stepId, event) => {
      if (event.type === "execution_failed") return pendingEvent.promise;
      return add(jobId, stepId, event);
    });
    const finalized = vi.spyOn(f.emitter, "finalizeBundle");
    const result = await drive(runPrintJob(f.options));
    eventless(result);
    expect(result.cancelRequested).toBe("timeout");
    expect(result.error).toMatch(/settl|record/i);
    expect(finalized).not.toHaveBeenCalled();
    expect(f.emitter.getEvents(f.options.jobId, "print")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
