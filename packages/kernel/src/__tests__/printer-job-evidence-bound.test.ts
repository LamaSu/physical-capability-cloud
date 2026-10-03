/**
 * N106 (steward #5205): a print's evidence is bound to its own print.
 *
 * runPrintJob (printer-job.ts) registered a listener per print through adapter.onEvidence,
 * which cannot unsubscribe, and ended a print on any execution_completed. Round 2 of #502
 * reproduced three findings in scratch (printer-job-lifetime-repro.txt):
 *   - P1: on one turnkey kernel, print 2's events landed under print 1's step after print 1
 *     returned;
 *   - P2: on a printer that queues jobs, print A finished on print B's completion;
 *   - P3: a print refused as busy kept recording the running print's events after it returned.
 * The same class as #502's findings, from the same code:
 *   - D1: registerStep overwrote an active (jobId, stepId): there was no step lease;
 *   - D2: nothing locked the printer;
 *   - D3: nothing quiesced before finalize;
 *   - D4: a failed print's step was never detached;
 *   - D5: the timeout path never removed its listener.
 * B1 and B2 pin P2's cause, the binding of a print to its device job.
 *
 * Every test asserts the correct behaviour, so at the base (e07d415d) each test that models a
 * defect fails with that defect. The fix reuses #502 round 3b: one evidence session per print
 * (one tap per adapter object, a lock per (kernelId, deviceId), the quiesceEvidence handshake),
 * JobRunner's step lease, and, on top of the lock, the print's own device job id.
 *
 * Every test runs on the fake clock, with hashing moved onto microtasks (as in
 * job-runner-evidence-handoff.test.ts), so the clock alone decides when a print moves on.
 *
 * Astra pack 192 (on a436e592) found two HIGHs in that fix, both pinned below:
 *   - HIGH 1: an event the print accepted but could not record (its hash or its addEvent failed)
 *     was logged and skipped, and the print still signed a bundle without it;
 *   - HIGH 2: every event was queued for recording before it was bound to the print's device job,
 *     so an event that named no job was signed into the print's bundle (B2a pinned that), and an
 *     event of another job was recorded before the print failed.
 * Now only events bound to the print's device job are recorded; an event that names no job is
 * excluded, with a warning; and an event the print could not record fails it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceBundle, EvidenceEvent, EvidenceSource } from "@pcc/spec";

import { IppAdapter, type IppAdapterConfig } from "../adapters/ipp-adapter.js";
import { OutstandingWork } from "../adapters/outstanding-work.js";
import type { MachineAdapter, MachineCommand, MachineCommandResult } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { createIppPrintKernel, runPrintJob } from "../printer-job.js";
import type { PrintJobOptions, PrintJobResult } from "../printer-job.js";

/** A test can hold an event's hashing, as a slow hash would, by returning a promise here. */
const hashing = vi.hoisted(() => ({ gate: null as ((event: unknown) => Promise<void> | undefined) | null }));

// The real hashes run on crypto.subtle, whose callbacks come from real I/O. Hash on a
// microtask instead (still SHA-256 of the canonical form), so a fake-clock test never
// races real time.
vi.mock("@pcc/spec", async (importOriginal) => {
  const spec = await importOriginal<typeof import("@pcc/spec")>();
  const { createHash } = await import("node:crypto");
  const digest = (value: unknown) => `sha256:${createHash("sha256").update(spec.canonicalize(value)).digest("hex")}`;
  return {
    ...spec,
    hashEvent: async (event: unknown) => {
      await hashing.gate?.(event);
      return digest(event);
    },
    hashBundle: async (events: unknown) => digest(events),
  };
});

type Emitted = Omit<EvidenceEvent, "id" | "hash">;

const KERNEL_ID = "kernel-n106";
const SEED = new Uint8Array(32).fill(6);
const ZERO_SIGNER = "0x0000000000000000000000000000000000000000";

/** An emitter with a cheap signer, and every bundle it finalizes. */
function recordingEmitter(): { emitter: EvidenceEmitter; bundles: EvidenceBundle[] } {
  const emitter = new EvidenceEmitter(KERNEL_ID, async (digest) => ({
    signer: ZERO_SIGNER,
    algorithm: "secp256k1",
    value: `sig_${digest.slice(0, 16)}`,
  }));
  const bundles: EvidenceBundle[] = [];
  emitter.onBundle((bundle) => bundles.push(bundle));
  return { emitter, bundles };
}

/** "type#jobId" for each event: which device job each recorded event belongs to. */
function tags(events: readonly Emitted[]): string[] {
  return events.map((e) => `${e.type}#${String(e.payload.jobId)}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** One physical printer's event stream: every adapter object that wraps it hears every event. */
interface DeviceStream {
  readonly listeners: Array<(event: Emitted) => void>;
  emit(event: Emitted): void;
}

function deviceStream(): DeviceStream {
  const listeners: Array<(event: Emitted) => void> = [];
  return {
    listeners,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

interface TestPrinter extends MachineAdapter {
  /** Every command type sent through this adapter object, in order. */
  readonly commands: string[];
  /** The device job of every start it accepted, in order. */
  readonly jobs: number[];
  /** Deliver an event to every adapter object on the printer, as the printer would. */
  emit(event: Emitted): void;
  /** An event from this printer. */
  event(type: Emitted["type"], payload?: Record<string, unknown>): Emitted;
  /** The printer reports device job `job` complete (default: its latest). */
  complete(job?: number): void;
  /** Resolves once this adapter object has been sent n starts. */
  started(n: number): Promise<void>;
}

/** What an accepting printer does on start: name the next device job and report it started. */
function accept(printer: TestPrinter, job: number): MachineCommandResult {
  printer.jobs.push(job);
  printer.emit(printer.event("execution_started", { jobId: job }));
  return { success: true, message: `job ${job} accepted`, data: { jobId: job } };
}

/**
 * A printer the test drives by hand: each start takes the next device job id (from
 * `firstJob`, default 100), and the test emits what the printer reports.
 */
function testPrinter(
  id: string,
  options: {
    /** The printer the adapter claims. Default: its own, `id`. */
    source?: EvidenceSource;
    /** The printer's event stream. Default: its own. */
    stream?: DeviceStream;
    firstJob?: number;
    /** What its nth start does with device job `job`. Default: accept. */
    start?: (printer: TestPrinter, n: number, job: number) => MachineCommandResult;
    /** Its quiesceEvidence(). Default: resolve at once (it emits inside its calls, or when the test says). */
    quiesceEvidence?: (printer: TestPrinter) => Promise<void>;
  } = {},
): TestPrinter {
  const stream = options.stream ?? deviceStream();
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  let nextJob = options.firstJob ?? 100;
  let starts = 0;
  const printer: TestPrinter = {
    id,
    type: "ipp-2d",
    source: options.source ?? { deviceId: id, deviceType: "controller", kernelId: KERNEL_ID },
    commands: [],
    jobs: [],
    async getStatus() {
      return "busy";
    },
    async getProgress() {
      return 0;
    },
    async execute(command: MachineCommand): Promise<MachineCommandResult> {
      printer.commands.push(command.type);
      if (command.type !== "start") return { success: true, message: `${command.type} acknowledged` };
      starts += 1;
      const job = nextJob++;
      for (const w of waiters) if (w.n <= starts) w.resolve();
      return (options.start ?? ((p, _n, j) => accept(p, j)))(printer, starts, job);
    },
    onEvidence(callback) {
      stream.listeners.push(callback);
    },
    emit(event) {
      stream.emit(event);
    },
    event(type, payload = {}) {
      return { type, timestamp: new Date().toISOString(), source: printer.source, payload };
    },
    complete(job = printer.jobs[printer.jobs.length - 1]) {
      printer.emit(printer.event("execution_completed", { jobId: job, totalPages: 1 }));
    },
    started(n) {
      return new Promise((resolve) => {
        if (starts >= n) resolve();
        else waiters.push({ n, resolve });
      });
    },
    quiesceEvidence() {
      return options.quiesceEvidence ? options.quiesceEvidence(printer) : Promise.resolve();
    },
    async dispose() {},
  };
  return printer;
}

/**
 * A printer that queues jobs: it accepts every start, whoever sends it, and reports device
 * job `job` complete completeAfterMs(job) later. Its hook waits for every job it accepted.
 */
function queuePrinter(id: string, completeAfterMs: (job: number) => number): TestPrinter {
  const work = new OutstandingWork();
  return testPrinter(id, {
    start: (printer, _n, job) => {
      const end = work.begin();
      setTimeout(() => {
        printer.complete(job);
        end();
      }, completeAfterMs(job));
      return accept(printer, job);
    },
    quiesceEvidence: () => work.idle(),
  });
}

/**
 * Settle `promise` on the fake clock: drain the microtasks, then fire the timers one at a
 * time, in order, until it settles. Throws if it is still pending with no timer left to
 * fire (it waits on something the test has not released), or after 1,000 timers.
 *
 * The microtasks are drained before every check (advanceTimersByTimeAsync(0) waits one real
 * macrotask turn): advanceTimersToNextTimerAsync() fires the timers due at the same moment
 * synchronously, so two prints that end together could otherwise be seen with no timer left
 * while the second is still a few microtasks from settling.
 */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let fired = 0; ; fired++) {
    await vi.advanceTimersByTimeAsync(0);
    if (settled) return promise;
    if (vi.getTimerCount() === 0) throw new Error("still pending, and no timer is left to fire");
    if (fired >= 1_000) throw new Error("still pending after 1,000 timers");
    await vi.advanceTimersToNextTimerAsync();
  }
}

/** Whether `promise` has settled, read after the microtasks are drained. */
function watch(promise: Promise<unknown>): { readonly settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

/** The result of a print refused before it started. */
function refused(error: string, busy?: PrintJobResult["busy"]): PrintJobResult {
  return { success: false, events: [], error, ...(busy ? { busy } : {}), durationMs: expect.any(Number) as unknown as number };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  // Dropped events and failed hooks are logged; keep the output readable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  hashing.gate = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The three findings of the round-2 reproduction
// ---------------------------------------------------------------------------

describe("P1: sequential prints on one turnkey kernel", () => {
  it("print 2's events are never recorded under print 1, before or after print 1 returned", async () => {
    const kernel = createIppPrintKernel({ kernelId: KERNEL_ID, deviceId: "ipp-p1", mockMode: true, seed: SEED });
    const one = await drive(kernel.print({ jobId: "print-p1-1", jobName: "one.pdf", totalPages: 2 }));
    const atReturn = tags(kernel.emitter.getEvents("print-p1-1", "print-p1-1"));
    const two = await drive(kernel.print({ jobId: "print-p1-2", jobName: "two.pdf", totalPages: 2 }));
    const after = tags(kernel.emitter.getEvents("print-p1-1", "print-p1-1"));
    await kernel.dispose();

    const job = (n: number) => [`execution_started#${n}`, `execution_progress#${n}`, `execution_progress#${n}`, `execution_completed#${n}`];
    expect.soft(one.success, "print 1 succeeded").toBe(true);
    expect.soft(two.success, "print 2 succeeded").toBe(true);
    expect.soft(tags(one.bundle?.events ?? []), "print 1's bundle").toEqual(job(1000));
    expect.soft(tags(two.bundle?.events ?? []), "print 2's bundle").toEqual(job(1001));
    expect(after, "print 1's step after print 2 ran").toEqual(atReturn);
  });
});

describe("P2: overlapping prints on a printer that queues jobs", () => {
  it("print A ends on its own device job, never on print B's: B is refused while A holds the printer", async () => {
    // Device job 100 (A's) takes 400 ms; job 101 (B's, if the printer ever gets it) 200 ms.
    const printer = queuePrinter("queue-p2", (job) => (job === 100 ? 400 : 200));
    const { emitter } = recordingEmitter();
    const runA = runPrintJob({ adapter: printer, emitter, jobId: "print-p2-A", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    const b = await drive(runPrintJob({ adapter: printer, emitter, jobId: "print-p2-B", jobName: "b.pdf", totalPages: 1 }));
    const a = await drive(runA);

    expect.soft(b, "print B's result").toEqual(refused("adapter queue-p2 is in use by job print-p2-A", { reason: "adapter", adapterId: "queue-p2", jobId: "print-p2-A" }));
    expect.soft(printer.commands, "commands the printer received").toEqual(["start"]);
    expect.soft(a.success, "print A succeeded").toBe(true);
    expect.soft(tags(a.bundle?.events ?? []), "print A's bundle").toEqual(["execution_started#100", "execution_completed#100"]);
    expect(a.completion?.printerJobId, "print A's printer job").toBe(100);
  });
});

describe("P3: a print refused as busy", () => {
  it("records nothing, before or after it returned, and the running print is unaffected", async () => {
    const kernel = createIppPrintKernel({ kernelId: KERNEL_ID, deviceId: "ipp-p3", mockMode: true, seed: SEED });
    const runA = kernel.print({ jobId: "print-p3-A", jobName: "a.pdf", totalPages: 3 });
    await vi.advanceTimersByTimeAsync(600); // A is printing its first page
    const b = await drive(kernel.print({ jobId: "print-p3-B", jobName: "b.pdf", totalPages: 1 }));
    const bAtReturn = tags(kernel.emitter.getEvents("print-p3-B", "print-p3-B"));
    const a = await drive(runA);
    const bAfter = tags(kernel.emitter.getEvents("print-p3-B", "print-p3-B"));
    await kernel.dispose();

    expect.soft(b, "print B's result").toEqual(refused("adapter ipp-p3 is in use by job print-p3-A", { reason: "adapter", adapterId: "ipp-p3", jobId: "print-p3-A" }));
    expect.soft(bAtReturn, "the refused print's step when it returned").toEqual([]);
    expect.soft(a.success, "print A succeeded").toBe(true);
    expect.soft(tags(a.bundle?.events ?? []), "print A's bundle").toEqual([
      "execution_started#1000",
      "execution_progress#1000",
      "execution_progress#1000",
      "execution_progress#1000",
      "execution_completed#1000",
    ]);
    expect(bAfter, "the refused print's step after print A finished").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The same class as #502's findings
// ---------------------------------------------------------------------------

describe("D1: a duplicate (jobId, stepId) is refused", () => {
  it("a second print of a running step, on another printer and the same emitter, is refused before any command or registerStep; the first print's bundle holds only its own printer's events", async () => {
    const { emitter } = recordingEmitter();
    const registerStep = vi.spyOn(emitter, "registerStep");
    const printerA = testPrinter("dup-d1-A");
    const printerB = testPrinter("dup-d1-B", { firstJob: 200 });
    const runA = runPrintJob({ adapter: printerA, emitter, jobId: "print-d1", jobName: "a.pdf", totalPages: 1 });
    await drive(printerA.started(1));
    const runB = runPrintJob({ adapter: printerB, emitter, jobId: "print-d1", jobName: "b.pdf", totalPages: 1 });
    await vi.advanceTimersByTimeAsync(0);
    printerA.complete(100);
    const a = await drive(runA);
    // At the base, B started device job 200 and waits for it: let it end, so B returns.
    if (printerB.jobs.length > 0) printerB.complete(200);
    const b = await drive(runB);
    const commandsToB = [...printerB.commands];
    // The refusal left print B's printer free: another print runs on it at once.
    const onB = runPrintJob({ adapter: printerB, emitter, jobId: "print-d1-other", jobName: "c.pdf", totalPages: 1 });
    await drive(printerB.started(1));
    printerB.complete();
    const other = await drive(onB);

    expect.soft(b, "print B's result").toEqual(refused("step print-d1 of job print-d1 is already running", { reason: "step", jobId: "print-d1", stepId: "print-d1" }));
    expect.soft(commandsToB, "commands sent to print B's printer").toEqual([]);
    expect.soft(registerStep.mock.calls.map((call) => call[0]), "steps registered").toEqual(["print-d1", "print-d1-other"]);
    expect.soft(a.success, "print A succeeded").toBe(true);
    expect.soft(other.success, "a print on print B's printer, after the refusal").toBe(true);
    expect(a.bundle?.events.map((e) => e.source.deviceId) ?? [], "printers in print A's bundle").toEqual(["dup-d1-A", "dup-d1-A"]);
  });
});

describe("D2: one print at a time on a printer (the lock is the device)", () => {
  it("a second print on a held printer object is refused before any command or registerStep; once the first returned, the next print runs", async () => {
    const printer = testPrinter("held-d2a");
    const { emitter } = recordingEmitter();
    const registerStep = vi.spyOn(emitter, "registerStep");
    const runA = runPrintJob({ adapter: printer, emitter, jobId: "print-d2a-A", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    const runB = runPrintJob({ adapter: printer, emitter, jobId: "print-d2a-B", jobName: "b.pdf", totalPages: 1 });
    await vi.advanceTimersByTimeAsync(0);
    printer.complete(100); // A's device job
    const b = await drive(runB);
    const a = await drive(runA);
    const runC = runPrintJob({ adapter: printer, emitter, jobId: "print-d2a-C", jobName: "c.pdf", totalPages: 1 });
    await drive(printer.started(2));
    printer.complete(101);
    const c = await drive(runC);

    expect.soft(b, "print B's result").toEqual(refused("adapter held-d2a is in use by job print-d2a-A", { reason: "adapter", adapterId: "held-d2a", jobId: "print-d2a-A" }));
    expect.soft(printer.commands, "commands the printer received (A's and C's)").toEqual(["start", "start"]);
    expect.soft(registerStep.mock.calls.map((call) => call[0]), "steps registered").toEqual(["print-d2a-A", "print-d2a-C"]);
    expect.soft(tags(a.bundle?.events ?? []), "print A's bundle").toEqual(["execution_started#100", "execution_completed#100"]);
    expect(tags(c.bundle?.events ?? []), "print C's bundle").toEqual(["execution_started#101", "execution_completed#101"]);
  });

  it("a second adapter object for the same printer (kernelId, deviceId) is refused, and sends the printer nothing", async () => {
    const one = createIppPrintKernel({ kernelId: KERNEL_ID, deviceId: "ipp-d2b", mockMode: true, seed: SEED });
    const two = createIppPrintKernel({ kernelId: KERNEL_ID, deviceId: "ipp-d2b", mockMode: true, seed: SEED });
    const executeTwo = vi.spyOn(two.adapter, "execute");
    const runA = one.print({ jobId: "print-d2b-A", jobName: "a.pdf", totalPages: 1 });
    const b = await drive(two.print({ jobId: "print-d2b-B", jobName: "b.pdf", totalPages: 1 }));
    const a = await drive(runA);
    await one.dispose();
    await two.dispose();

    expect.soft(b, "print B's result").toEqual(refused("adapter ipp-d2b is in use by job print-d2b-A", { reason: "adapter", adapterId: "ipp-d2b", jobId: "print-d2b-A" }));
    expect.soft(executeTwo, "commands sent through the second object").not.toHaveBeenCalled();
    expect.soft(a.success, "print A succeeded").toBe(true);
    expect(tags(a.bundle?.events ?? []), "print A's bundle").toEqual(["execution_started#1000", "execution_progress#1000", "execution_completed#1000"]);
  });

  it("different printers, and one deviceId under two kernelIds, print at once", async () => {
    const kernels = [
      createIppPrintKernel({ kernelId: KERNEL_ID, deviceId: "ipp-d2c-1", mockMode: true, seed: SEED }),
      createIppPrintKernel({ kernelId: KERNEL_ID, deviceId: "ipp-d2c-2", mockMode: true, seed: SEED }),
      createIppPrintKernel({ kernelId: "kernel-n106-other", deviceId: "ipp-d2c-1", mockMode: true, seed: SEED }),
    ];
    const results = await drive(Promise.all(kernels.map((k, i) => k.print({ jobId: `print-d2c-${i}`, jobName: "p.pdf", totalPages: 1 }))));
    for (const k of kernels) await k.dispose();

    expect.soft(results.map((r) => r.success), "every print succeeded").toEqual([true, true, true]);
    expect(
      results.map((r) => [...new Set((r.bundle?.events ?? []).map((e) => `${e.source.kernelId}/${e.source.deviceId}`))]),
      "printers in each bundle",
    ).toEqual([[`${KERNEL_ID}/ipp-d2c-1`], [`${KERNEL_ID}/ipp-d2c-2`], ["kernel-n106-other/ipp-d2c-1"]]);
  });
});

describe("D3: a print quiesces before it finalizes", () => {
  it("the print waits, still recording, for its printer's word that its job's evidence is complete: a late event of its own job is in its bundle", async () => {
    const LATE_MS = 300;
    let owed: Promise<void> = Promise.resolve();
    const printer = testPrinter("late-d3a", { quiesceEvidence: () => owed });
    const { emitter } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-d3a", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    // The printer reports the job complete, and its final sheet count LATE_MS later. Its
    // hook answers only once it has reported that count.
    owed = new Promise<void>((resolve) =>
      setTimeout(() => {
        printer.emit(printer.event("execution_progress", { jobId: 100, completedSheets: 1 }));
        resolve();
      }, LATE_MS),
    );
    printer.complete(100);
    const result = await drive(run);

    expect.soft(result.success, "the print succeeded").toBe(true);
    expect(tags(result.bundle?.events ?? []), "the print's bundle").toEqual(["execution_started#100", "execution_completed#100", "execution_progress#100"]);
  });

  it("a hook that never answers fails the print at the bound, finalizing nothing; the printer stays quiescing, refusing every print before any command, until the hook answers; then the next print runs", async () => {
    const answer = deferred();
    let hook: Promise<void> = answer.promise;
    const printer = testPrinter("stuck-d3b", { quiesceEvidence: () => hook });
    const { emitter, bundles } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-d3b-A", jobName: "a.pdf", totalPages: 1, evidenceQuiesceTimeoutMs: 1_000 } as PrintJobOptions);
    await drive(printer.started(1));
    printer.complete(100);
    const a = await drive(run);
    const stepA = tags(emitter.getEvents("print-d3b-A", "print-d3b-A"));
    // Refused at once, and again an hour later: there is no time-based release.
    const runB = runPrintJob({ adapter: printer, emitter, jobId: "print-d3b-B", jobName: "b.pdf", totalPages: 1 });
    if (printer.jobs.length > 1) printer.complete(); // at the base, B started a job: let it end
    const b = await drive(runB);
    await vi.advanceTimersByTimeAsync(3_600_000);
    const runB2 = runPrintJob({ adapter: printer, emitter, jobId: "print-d3b-B2", jobName: "b.pdf", totalPages: 1 });
    if (printer.jobs.length > 2) printer.complete();
    const b2 = await drive(runB2);
    hook = Promise.resolve();
    answer.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const runC = runPrintJob({ adapter: printer, emitter, jobId: "print-d3b-C", jobName: "c.pdf", totalPages: 1 });
    await vi.advanceTimersByTimeAsync(0);
    printer.complete();
    const c = await drive(runC);

    const quiescing = (jobId: string) => refused("adapter stuck-d3b is still quiescing after job print-d3b-A", { reason: "quiescing", adapterId: "stuck-d3b", jobId: "print-d3b-A" });
    expect.soft(a, "print A's result").toEqual({ success: false, events: [], error: "evidence did not quiesce within 1000 ms", durationMs: expect.any(Number) });
    expect.soft(stepA, "print A's step once it returned").toEqual([]);
    expect.soft(b, "print B, while the hook is pending").toEqual(quiescing("print-d3b-B"));
    expect.soft(b2, "print B2, an hour later").toEqual(quiescing("print-d3b-B2"));
    expect.soft(printer.commands, "commands the printer received (A's and C's)").toEqual(["start", "start"]);
    expect.soft(bundles.map((bundle) => bundle.jobId), "bundles finalized").toEqual(["print-d3b-C"]);
    expect(tags(c.bundle?.events ?? []), "print C's bundle").toEqual(["execution_started#101", "execution_completed#101"]);
  });

  it("the bound defaults to 15 s", async () => {
    const answer = deferred();
    const printer = testPrinter("stuck-d3c", { quiesceEvidence: () => answer.promise });
    const { emitter } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-d3c", jobName: "a.pdf", totalPages: 1 });
    const state = watch(run);
    await drive(printer.started(1));
    printer.complete(100);
    await vi.advanceTimersByTimeAsync(14_999);
    expect.soft(state.settled, "returned 14,999 ms after the completion").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect.soft(state.settled, "returned 15,000 ms after the completion").toBe(true);
    if (!state.settled) answer.resolve();
    expect((await drive(run)).error).toBe("evidence did not quiesce within 15000 ms");
    answer.resolve();
  });

  it("a hook that rejects fails the print with its error, finalizing nothing", async () => {
    const printer = testPrinter("broken-d3d", { quiesceEvidence: () => Promise.reject(new Error("spooler unreachable")) });
    const { emitter, bundles } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-d3d", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    printer.complete(100);
    const result = await drive(run);

    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: "spooler unreachable", durationMs: expect.any(Number) });
    expect(bundles, "bundles finalized").toEqual([]);
  });
});

describe("D4: a failed print's step is detached", () => {
  it("a print its printer reports failed returns no bundle, and its step is empty once it returned", async () => {
    const printer = testPrinter("jam-d4");
    const { emitter, bundles } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-d4", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    printer.emit(printer.event("execution_failed", { jobId: 100, state: "aborted" }));
    const result = await drive(run);

    expect.soft(result, "the print's result").toEqual({
      success: false,
      events: [],
      error: 'printer reported failure: {"jobId":100,"state":"aborted"}',
      durationMs: expect.any(Number),
    });
    expect.soft(bundles, "bundles finalized").toEqual([]);
    expect.soft(vi.getTimerCount(), "timers left pending once it returned").toBe(0);
    expect(tags(emitter.getEvents("print-d4", "print-d4")), "the failed print's step once it returned").toEqual([]);
  });
});

describe("D5: a print that timed out records nothing after it returned", () => {
  it("the printer's later events reach neither its step nor its result", async () => {
    const printer = testPrinter("slow-d5");
    const { emitter } = recordingEmitter();
    const result = await drive(runPrintJob({ adapter: printer, emitter, jobId: "print-d5", jobName: "a.pdf", totalPages: 1, timeoutMs: 1_000 }));
    const atReturn = tags(emitter.getEvents("print-d5", "print-d5"));
    printer.emit(printer.event("execution_progress", { jobId: 100, completedSheets: 1 }));
    printer.complete(100);
    await vi.advanceTimersByTimeAsync(0);

    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: "print job print-d5 timed out after 1000ms", durationMs: expect.any(Number) });
    expect.soft(atReturn, "its step when it returned").toEqual([]);
    expect(tags(emitter.getEvents("print-d5", "print-d5")), "its step after the printer reported").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P2's cause: a print is bound to its device job
// ---------------------------------------------------------------------------

describe("B1 (P2's cause): another device job inside the print's window fails it closed", () => {
  it("a job something else sent the printer while the print runs: the print fails naming that job and finalizes nothing; the printer is free once it has answered", async () => {
    // Device job 100 (the print's) takes 400 ms; job 101 (another client's) 200 ms.
    const printer = queuePrinter("queue-b1a", (job) => (job === 100 ? 400 : 200));
    const { emitter, bundles } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-b1a", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    await vi.advanceTimersByTimeAsync(50);
    await printer.execute({ type: "start", payload: { jobName: "someone-else.pdf" } }); // not through any print
    const result = await drive(run);
    const stepAtReturn = tags(emitter.getEvents("print-b1a", "print-b1a"));
    const next = runPrintJob({ adapter: printer, emitter, jobId: "print-b1a-next", jobName: "b.pdf", totalPages: 1 });
    const n = await drive(next);

    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: expect.stringContaining("device job 101"), durationMs: expect.any(Number) });
    expect.soft(stepAtReturn, "its step once it returned").toEqual([]);
    expect.soft(bundles.map((bundle) => bundle.jobId), "bundles finalized").toEqual(["print-b1a-next"]);
    expect(tags(n.bundle?.events ?? []), "the next print's bundle").toEqual(["execution_started#102", "execution_completed#102"]);
  });

  it("an event of another device job emitted inside start, before the print knows its own job, still fails it closed", async () => {
    const printer = testPrinter("stale-b1b", {
      start: (p, _n, job) => {
        // A stale report of the printer's previous job, then this job's start.
        p.emit(p.event("execution_completed", { jobId: 99, totalPages: 4 }));
        return accept(p, job);
      },
    });
    const { emitter, bundles } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-b1b", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    if (bundles.length === 0) printer.complete(100);
    const result = await drive(run);

    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: expect.stringContaining("device job 99"), durationMs: expect.any(Number) });
    expect(bundles, "bundles finalized").toEqual([]);
  });

  it("an event of another device job while the print quiesces, after its own job ended, still fails it closed", async () => {
    const answer = deferred();
    const printer = testPrinter("late-foreign-b1c", { quiesceEvidence: () => answer.promise });
    const { emitter, bundles } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-b1c", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    printer.complete(100);
    await vi.advanceTimersByTimeAsync(100); // the print waits for its printer's word
    printer.emit(printer.event("execution_started", { jobId: 101 })); // something else's job
    answer.resolve();
    const result = await drive(run);

    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: expect.stringContaining("device job 101"), durationMs: expect.any(Number) });
    expect(bundles, "bundles finalized").toEqual([]);
  });

  it("names the other job even when the printer, busy with it, does not answer within the quiesce bound; the printer stays quiescing until it does", async () => {
    // Device job 100 (the print's) takes 400 ms; job 101 (another client's) 200 ms.
    const printer = queuePrinter("queue-b1d", (job) => (job === 100 ? 400 : 200));
    const { emitter } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-b1d", jobName: "a.pdf", totalPages: 1, evidenceQuiesceTimeoutMs: 100 });
    await drive(printer.started(1));
    await vi.advanceTimersByTimeAsync(50);
    await printer.execute({ type: "start", payload: { jobName: "someone-else.pdf" } }); // not through any print
    const result = await drive(run); // fails at 50 ms; returns at the 100 ms quiesce bound, the printer still busy
    const whileBusy = await drive(runPrintJob({ adapter: printer, emitter, jobId: "print-b1d-next", jobName: "b.pdf", totalPages: 1 }));
    await vi.advanceTimersByTimeAsync(400); // both device jobs have ended, so the hook has answered
    const next = await drive(runPrintJob({ adapter: printer, emitter, jobId: "print-b1d-next", jobName: "b.pdf", totalPages: 1 }));

    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: expect.stringContaining("device job 101"), durationMs: expect.any(Number) });
    expect.soft(whileBusy, "a print while the printer is still busy").toEqual(
      refused("adapter queue-b1d is still quiescing after job print-b1d", { reason: "quiescing", adapterId: "queue-b1d", jobId: "print-b1d" }),
    );
    expect(tags(next.bundle?.events ?? []), "the next print's bundle, once the printer answered").toEqual(["execution_started#102", "execution_completed#102"]);
  });
});

describe("B2 (P2's cause): only the print's own device job ends it", () => {
  // This test pinned that such a completion was recorded into the print's signed bundle
  // ("execution_completed#undefined"). Astra pack 192 HIGH 2 calls that a defect: only events bound
  // to the print's device job are recorded, so it is now excluded from the print's evidence too.
  it("a completion that names no device job neither ends the print nor enters its evidence; its own does, and the completion names that job", async () => {
    const printer = testPrinter("bound-b2a");
    const { emitter } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-b2a", jobName: "a.pdf", totalPages: 1 });
    const state = watch(run);
    await drive(printer.started(1));
    printer.emit(printer.event("execution_completed", { totalPages: 9 })); // names no device job
    await vi.advanceTimersByTimeAsync(100);
    const endedByIt = state.settled;
    printer.complete(100);
    const result = await drive(run);

    expect.soft(endedByIt, "ended by a completion that names no device job").toBe(false);
    expect.soft(result.success, "the print succeeded").toBe(true);
    expect.soft(result.completion, "its completion").toMatchObject({ printerJobId: 100, pageCount: 1 });
    expect(tags(result.bundle?.events ?? []), "the print's bundle").toEqual(["execution_started#100", "execution_completed#100"]);
  });

  it("its own completion, emitted inside start before the print knows its device job, ends it", async () => {
    const printer = testPrinter("fast-b2b", {
      start: (p, _n, job) => {
        const accepted = accept(p, job);
        p.complete(job);
        return accepted;
      },
    });
    const { emitter } = recordingEmitter();
    const result = await drive(runPrintJob({ adapter: printer, emitter, jobId: "print-b2b", jobName: "a.pdf", totalPages: 1 }));

    expect.soft(result.success, "the print succeeded").toBe(true);
    expect.soft(vi.getTimerCount(), "timers left pending once it returned").toBe(0);
    expect(tags(result.bundle?.events ?? []), "the print's bundle").toEqual(["execution_started#100", "execution_completed#100"]);
  });

  it("the IPP mock's start names its device job, and the print's completion is that job", async () => {
    const kernel = createIppPrintKernel({ kernelId: KERNEL_ID, deviceId: "ipp-b2c", mockMode: true, seed: SEED });
    const execute = vi.spyOn(kernel.adapter, "execute");
    const result = await drive(kernel.print({ jobId: "print-b2c", jobName: "a.pdf", totalPages: 1 }));
    const start = await execute.mock.results[0]?.value;
    await kernel.dispose();

    expect.soft(start, "the IPP mock's start result").toEqual({ success: true, message: "Print job 1000 submitted (mock)", data: { jobId: 1000 } });
    expect(result.completion?.printerJobId, "the print's printer job").toBe(1000);
  });

  it("a start that names no device job fails the print closed: the printer's completion is never bundled", async () => {
    const printer = testPrinter("anon-b2d", {
      start: (p, _n, job) => {
        p.jobs.push(job);
        p.emit(p.event("execution_started", { jobId: job }));
        return { success: true, message: "accepted" };
      },
    });
    const { emitter, bundles } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-b2d", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    printer.complete(100);
    const result = await drive(run);

    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: expect.stringContaining("named no device job"), durationMs: expect.any(Number) });
    expect(bundles, "bundles finalized").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Astra pack 192: an event the print could not record fails it, and only bound events are recorded
// ---------------------------------------------------------------------------

/** Make the emitter fail to record every event of `type`: its addEvent rejects, or throws. */
function failToRecord(emitter: EvidenceEmitter, how: "rejects" | "throws", type: Emitted["type"], message: string): void {
  const record = emitter.addEvent.bind(emitter);
  vi.spyOn(emitter, "addEvent").mockImplementation((jobId, stepId, event) => {
    if (event.type !== type) return record(jobId, stepId, event);
    if (how === "throws") throw new Error(message);
    return Promise.reject(new Error(message));
  });
}

/** The error of a print that could not record an event of its own (JobRunner's wording). */
function unrecorded(type: string, error: string): string {
  return `a ${type} event of this job could not be recorded (${error}), so its evidence is incomplete`;
}

/** Watch what a print asks its emitter to record: "type#jobId" of each event, in order. */
function recordsOf(emitter: EvidenceEmitter): () => string[] {
  const addEvent = vi.spyOn(emitter, "addEvent");
  return () => tags(addEvent.mock.calls.map((call) => call[2]));
}

describe("astra pack 192 HIGH 1: an event the print bound but could not record fails it", () => {
  it.each([
    {
      how: "its hash rejects, astra's reproduction",
      id: "hash",
      lose: () => {
        hashing.gate = (event) => ((event as Emitted).type === "execution_completed" ? Promise.reject(new Error("hashEvent rejected")) : undefined);
      },
      error: "hashEvent rejected",
    },
    { how: "addEvent rejects", id: "rejects", lose: (emitter: EvidenceEmitter) => failToRecord(emitter, "rejects", "execution_completed", "storage full"), error: "storage full" },
    { how: "addEvent throws", id: "throws", lose: (emitter: EvidenceEmitter) => failToRecord(emitter, "throws", "execution_completed", "storage full"), error: "storage full" },
  ])("a completion whose recording fails ($how) fails the print: no bundle, no events, and its step is detached", async ({ id, lose, error }) => {
    const printer = testPrinter(`unrecorded-h1a-${id}`);
    const { emitter, bundles } = recordingEmitter();
    lose(emitter);
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-h1a", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    printer.complete(100);
    const result = await drive(run);

    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: unrecorded("execution_completed", error), durationMs: expect.any(Number) });
    expect.soft(bundles, "bundles finalized").toEqual([]);
    expect(tags(emitter.getEvents("print-h1a", "print-h1a")), "its step once it returned").toEqual([]);
  });

  it("names the first event it could not record", async () => {
    hashing.gate = (event) => {
      const { type } = event as Emitted;
      if (type === "execution_started") return Promise.reject(new Error("the start's hash rejected"));
      if (type === "execution_completed") return Promise.reject(new Error("the completion's hash rejected"));
      return undefined;
    };
    const printer = testPrinter("unrecorded-h1b");
    const { emitter, bundles } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-h1b", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    printer.emit(printer.event("execution_progress", { jobId: 100, completedSheets: 1 })); // recorded
    printer.complete(100);
    const result = await drive(run);

    expect.soft(result.error, "the print's error").toBe(unrecorded("execution_started", "the start's hash rejected"));
    expect(bundles, "bundles finalized").toEqual([]);
  });

  it("waits for the chain: a completion whose recording fails only after the print stopped accepting evidence still fails it", async () => {
    // The completion's hash rejects 1 s after it was emitted. The printer answers its hook at
    // once, so by then the window is closed and the print is waiting for its chain to settle.
    hashing.gate = (event) =>
      (event as Emitted).type === "execution_completed"
        ? new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("hash rejected late")), 1_000))
        : undefined;
    const printer = testPrinter("unrecorded-h1c");
    const { emitter, bundles } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-h1c", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    printer.complete(100);
    const result = await drive(run);

    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: unrecorded("execution_completed", "hash rejected late"), durationMs: expect.any(Number) });
    expect(bundles, "bundles finalized").toEqual([]);
  });
});

describe("astra pack 192 HIGH 2: only events bound to the print's device job are recorded", () => {
  it("an execution_failed that names no device job, after the print started (astra's reproduction), is excluded with a warning: never recorded, never deciding; the print's own completion ends it, and its bundle holds only its job's events", async () => {
    const printer = testPrinter("jobless-h2a");
    const { emitter, bundles } = recordingEmitter();
    const records = recordsOf(emitter);
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-h2a", jobName: "a.pdf", totalPages: 1 });
    const state = watch(run);
    await drive(printer.started(1));
    printer.emit(printer.event("execution_failed", { state: "aborted" })); // names no device job
    await vi.advanceTimersByTimeAsync(100);
    const endedByIt = state.settled;
    printer.complete(100);
    const result = await drive(run);

    expect.soft(endedByIt, "ended by the failure that names no device job").toBe(false);
    expect.soft(result.success, "the print succeeded").toBe(true);
    expect.soft(tags(result.bundle?.events ?? []), "the print's bundle").toEqual(["execution_started#100", "execution_completed#100"]);
    expect.soft(bundles.length, "bundles finalized").toBe(1);
    expect.soft(records(), "events the print recorded").toEqual(["execution_started#100", "execution_completed#100"]);
    expect(console.warn, "the exclusion, logged").toHaveBeenCalledWith(expect.stringContaining("print print-h2a excluded an event that names no device job (execution_failed"));
  });

  it("events emitted inside start wait until start names the device job, then are admitted in the order they arrived: its own recorded, one that names no job excluded", async () => {
    const printer = testPrinter("early-h2b", {
      start: (p, _n, job) => {
        const accepted = accept(p, job); // the job's execution_started
        p.emit(p.event("execution_progress", { state: "warming-up" })); // a device-level report: no job
        p.emit(p.event("execution_progress", { jobId: job, completedSheets: 0 }));
        return accepted;
      },
    });
    const { emitter } = recordingEmitter();
    const records = recordsOf(emitter);
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-h2b", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    printer.complete(100);
    const result = await drive(run);

    expect.soft(result.success, "the print succeeded").toBe(true);
    expect.soft(tags(result.bundle?.events ?? []), "the print's bundle").toEqual(["execution_started#100", "execution_progress#100", "execution_completed#100"]);
    expect(records(), "events the print recorded").toEqual(["execution_started#100", "execution_progress#100", "execution_completed#100"]);
  });

  const FOREIGN: Array<{ when: string; start: (printer: TestPrinter, job: number) => MachineCommandResult; then: (printer: TestPrinter) => void; job: number }> = [
    { when: "after the print started", start: accept, then: (p) => p.emit(p.event("execution_progress", { jobId: 555 })), job: 555 },
    {
      when: "inside start, before the print knows its job",
      start: (p, job) => {
        p.emit(p.event("execution_completed", { jobId: 99, totalPages: 4 })); // a stale report of the printer's previous job
        return accept(p, job);
      },
      then: () => {},
      job: 99,
    },
  ];

  it.each(FOREIGN)("an event of another device job, $when, is never recorded, and the print fails closed", async ({ when, start, then, job }) => {
    const printer = testPrinter(`foreign-h2c-${when.replace(/\W+/g, "-")}`, { start: (p, _n, j) => start(p, j) });
    const { emitter, bundles } = recordingEmitter();
    const records = recordsOf(emitter);
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-h2c", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    then(printer);
    const result = await drive(run);

    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: expect.stringContaining(`device job ${job}`), durationMs: expect.any(Number) });
    expect.soft(bundles, "bundles finalized").toEqual([]);
    expect(records(), "events the print recorded").toEqual(["execution_started#100"]);
  });

  it('binding is strict: an event that names the print\'s device job as another type ("100" for 100) is another job\'s, never recorded, and the print fails closed', async () => {
    const printer = testPrinter("strict-h2d");
    const { emitter, bundles } = recordingEmitter();
    const addEvent = vi.spyOn(emitter, "addEvent");
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-h2d", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    printer.emit(printer.event("execution_completed", { jobId: "100", totalPages: 1 }));
    const result = await drive(run);

    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: expect.stringContaining("something else is driving the printer"), durationMs: expect.any(Number) });
    expect.soft(bundles, "bundles finalized").toEqual([]);
    expect(addEvent.mock.calls.map((call) => call[2].payload.jobId), "the device jobs of the events the print recorded").toEqual([100]);
  });
});

/**
 * An IppAdapter in real mode over a fake IPP transport (the optional `ipp` package is not installed
 * here). Print-Job names device job `job`; each Get-Job-Attributes poll answers the next of `polls`
 * (RFC 8011 job-state: 5 processing, 8 aborted, 9 completed).
 */
function realModeIpp(id: string, job: number, polls: Array<{ state: number; sheets?: number }>): IppAdapter {
  // Built in mock mode, so it never imports `ipp`; it runs in real mode from here on.
  const config: IppAdapterConfig = { uri: "ipp://printer.test/ipp/print", kernelId: KERNEL_ID, mockMode: true, pollIntervalMs: 100 };
  const adapter = new IppAdapter(id, config);
  config.mockMode = false;
  const answers = [...polls];
  class Printer {
    execute(operation: string, _msg: unknown, _data: unknown, callback: (err: Error | null, res: Record<string, unknown>) => void): void {
      if (operation === "Print-Job") {
        callback(null, { "job-attributes-tag": { "job-id": job } });
        return;
      }
      const next = answers.shift() ?? { state: 5 };
      callback(null, { "job-attributes-tag": { "job-state": next.state, "job-impressions-completed": next.sheets } });
    }
  }
  Object.assign(adapter as unknown as Record<string, unknown>, { ippClient: { Printer }, ippAvailable: true });
  return adapter;
}

describe("IppAdapter names its device job on every event, so a print excludes none of them (astra pack 192 HIGH 2)", () => {
  it("real mode, over a fake IPP transport: the job's start, progress and completion are all bound and signed", async () => {
    const adapter = realModeIpp("ipp-real-h2", 42, [{ state: 5, sheets: 1 }, { state: 9 }]);
    const { emitter } = recordingEmitter();
    const result = await drive(runPrintJob({ adapter, emitter, jobId: "print-real", jobName: "a.pdf", totalPages: 1, documentData: "%PDF-1.4" }));
    await adapter.dispose();

    expect.soft(result.success, "the print succeeded").toBe(true);
    expect.soft(result.completion?.printerJobId, "the print's printer job").toBe(42);
    expect.soft(tags(result.bundle?.events ?? []), "the print's bundle").toEqual(["execution_started#42", "execution_progress#42", "execution_completed#42"]);
    expect(console.warn, "an exclusion").not.toHaveBeenCalledWith(expect.stringContaining("names no device job"));
  });

  it("real mode: a job the printer aborted ends the print on its own execution_failed", async () => {
    const adapter = realModeIpp("ipp-real-h2-aborted", 43, [{ state: 8 }]);
    const { emitter, bundles } = recordingEmitter();
    const result = await drive(runPrintJob({ adapter, emitter, jobId: "print-real-aborted", jobName: "a.pdf", totalPages: 1, documentData: "%PDF-1.4" }));
    await adapter.dispose();

    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: 'printer reported failure: {"jobId":43,"state":"aborted"}', durationMs: expect.any(Number) });
    expect(bundles, "bundles finalized").toEqual([]);
  });

  it("mock mode: every event the adapter emits for a print is in its bundle, and none is excluded", async () => {
    const kernel = createIppPrintKernel({ kernelId: KERNEL_ID, deviceId: "ipp-mock-h2", mockMode: true, seed: SEED });
    const emitted: Emitted[] = [];
    kernel.adapter.onEvidence((event) => emitted.push(event));
    const result = await drive(kernel.print({ jobId: "print-mock-h2", jobName: "a.pdf", totalPages: 2 }));
    await kernel.dispose();

    expect.soft(tags(emitted), "what the adapter emitted").toEqual(["execution_started#1000", "execution_progress#1000", "execution_progress#1000", "execution_completed#1000"]);
    expect.soft(tags(result.bundle?.events ?? []), "the print's bundle").toEqual(tags(emitted));
    expect(console.warn, "an exclusion").not.toHaveBeenCalledWith(expect.stringContaining("names no device job"));
  });
});

// ---------------------------------------------------------------------------
// The fix's own rules
// ---------------------------------------------------------------------------

describe("every exit releases the printer, the step key and the step", () => {
  const EXITS: Array<{
    exit: string;
    first: (printer: TestPrinter, job: number) => MachineCommandResult;
    then?: (printer: TestPrinter) => void;
    options?: Partial<PrintJobOptions>;
    error: unknown;
  }> = [
    { exit: "the printer refuses the start", first: () => ({ success: false, message: "Printer already processing a job" }), error: "Printer already processing a job" },
    {
      exit: "start throws",
      first: () => {
        throw new Error("spooler crashed");
      },
      error: "spooler crashed",
    },
    { exit: "start names no device job", first: () => ({ success: true, message: "accepted" }), error: expect.stringContaining("named no device job") },
    {
      exit: "the printer reports the job failed",
      first: accept,
      then: (p) => p.emit(p.event("execution_failed", { jobId: 100, state: "aborted" })),
      error: 'printer reported failure: {"jobId":100,"state":"aborted"}',
    },
    { exit: "the print times out", first: accept, options: { timeoutMs: 1_000 }, error: "print job print-exit timed out after 1000ms" },
    {
      exit: "another device job drives the printer",
      first: accept,
      then: (p) => p.emit(p.event("execution_progress", { jobId: 555 })),
      error: expect.stringContaining("device job 555"),
    },
    {
      exit: "an event of the print cannot be recorded",
      first: accept,
      then: (p) => {
        // Only device job 100's completion: the retry's job records normally.
        hashing.gate = (event) => {
          const e = event as Emitted;
          return e.type === "execution_completed" && e.payload.jobId === 100 ? Promise.reject(new Error("hashEvent rejected")) : undefined;
        };
        p.complete(100);
      },
      error: "a execution_completed event of this job could not be recorded (hashEvent rejected), so its evidence is incomplete",
    },
  ];

  it.each(EXITS)("$exit: the print fails, then a retry of its step on the same printer runs", async ({ exit, first, then, options, error }) => {
    const printer = testPrinter(`exit-${exit.replace(/\W+/g, "-")}`, { start: (p, n, job) => (n === 1 ? first(p, job) : accept(p, job)) });
    const { emitter, bundles } = recordingEmitter();
    const job = { adapter: printer, emitter, jobId: "print-exit", jobName: "a.pdf", totalPages: 1 };
    const run = runPrintJob({ ...job, ...options });
    await drive(printer.started(1));
    then?.(printer);
    const failed = await drive(run);
    const stepAtReturn = tags(emitter.getEvents("print-exit", "print-exit"));
    const retry = runPrintJob(job);
    await drive(printer.started(2));
    const retryJob = printer.jobs[printer.jobs.length - 1];
    printer.complete(retryJob);
    const ok = await drive(retry);

    expect.soft(failed, "the failed print's result").toEqual({ success: false, events: [], error, durationMs: expect.any(Number) });
    expect.soft(stepAtReturn, "its step once it returned").toEqual([]);
    expect.soft(ok.success, "the retry succeeded").toBe(true);
    expect.soft(bundles.map((bundle) => bundle.jobId), "bundles finalized").toEqual(["print-exit"]);
    expect(tags(ok.bundle?.events ?? []), "the retry's bundle").toEqual([`execution_started#${retryJob}`, `execution_completed#${retryJob}`]);
  });
});

describe("the step lease", () => {
  it("is held while a failed print settles, so a print of its step on another printer is refused until the failed print returned", async () => {
    const printer = testPrinter("lease-held");
    const other = testPrinter("lease-other", { firstJob: 300 });
    const { emitter } = recordingEmitter();
    const gate = deferred();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-lease", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    // Hold the hashing of the printer's failure report: the failed print is still settling.
    hashing.gate = (event) => ((event as Emitted).type === "execution_failed" ? gate.promise : undefined);
    printer.emit(printer.event("execution_failed", { jobId: 100, state: "aborted" }));
    await vi.advanceTimersByTimeAsync(0);
    const whileSettling = runPrintJob({ adapter: other, emitter, jobId: "print-lease", jobName: "a.pdf", totalPages: 1 });
    if (other.jobs.length > 0) other.complete(); // at the base it started: let it end
    const refusedRun = await drive(whileSettling);
    gate.resolve();
    const failed = await drive(run);

    expect.soft(refusedRun, "a print of the step while the failed print settles").toEqual(
      refused("step print-lease of job print-lease is already running", { reason: "step", jobId: "print-lease", stepId: "print-lease" }),
    );
    expect.soft(other.commands, "commands sent to the other printer").toEqual([]);
    expect(failed.error, "the failed print's error").toBe('printer reported failure: {"jobId":100,"state":"aborted"}');
  });
});

describe("the settle bound", () => {
  it.each([
    ["2000 ms, as configured", { evidenceSettleTimeoutMs: 2_000 }, 2_000],
    ["30 s by default", {}, 30_000],
  ] as const)("an addEvent that never settles fails the print at %s, once, finalizing nothing", async (_name, options, bound) => {
    const printer = testPrinter(`settle-${bound}`);
    const { emitter, bundles } = recordingEmitter();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-settle", jobName: "a.pdf", totalPages: 1, ...options } as PrintJobOptions);
    const state = watch(run);
    await drive(printer.started(1));
    hashing.gate = (event) => ((event as Emitted).type === "execution_completed" ? new Promise<void>(() => {}) : undefined);
    printer.complete(100);
    await vi.advanceTimersByTimeAsync(bound - 1);
    const early = state.settled;
    await vi.advanceTimersByTimeAsync(1);
    const atBound = state.settled;
    const result = await drive(run);

    expect.soft(early, "returned before the bound").toBe(false);
    expect.soft(atBound, "returned at the bound (and not after a second wait)").toBe(true);
    expect.soft(result, "the print's result").toEqual({ success: false, events: [], error: `evidence recording did not settle within ${bound} ms`, durationMs: expect.any(Number) });
    expect(bundles, "bundles finalized").toEqual([]);
  });
});

describe("closed before it settles", () => {
  it("an event after the printer answered, while the print settles, is in neither its bundle nor its step", async () => {
    const printer = testPrinter("closed-settle");
    const { emitter } = recordingEmitter();
    const gate = deferred();
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-closed", jobName: "a.pdf", totalPages: 1 });
    await drive(printer.started(1));
    // Hold the completion's hashing: the printer has answered at once, and the print is settling.
    hashing.gate = (event) => ((event as Emitted).type === "execution_completed" ? gate.promise : undefined);
    printer.complete(100);
    await vi.advanceTimersByTimeAsync(0);
    printer.emit(printer.event("execution_progress", { jobId: 100, completedSheets: 1 }));
    gate.resolve();
    const result = await drive(run);

    expect.soft(result.success, "the print succeeded").toBe(true);
    expect.soft(tags(result.bundle?.events ?? []), "its bundle").toEqual(["execution_started#100", "execution_completed#100"]);
    expect(tags(emitter.getEvents("print-closed", "print-closed")), "its step").toEqual(["execution_started#100", "execution_completed#100"]);
  });
});

describe("sealed: a failed print never writes an event still queued", () => {
  it("an event queued behind a slow addEvent is not written after the print failed, not even into a later print of its step", async () => {
    const printer = testPrinter("sealed");
    const { emitter } = recordingEmitter();
    const gate = deferred();
    // The print's first event hashes slowly; the printer reports progress behind it, then nothing.
    hashing.gate = (event) => ((event as Emitted).type === "execution_started" && (event as Emitted).payload.jobId === 100 ? gate.promise : undefined);
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-sealed", jobName: "a.pdf", totalPages: 1, timeoutMs: 1_000, evidenceSettleTimeoutMs: 500 } as PrintJobOptions);
    await drive(printer.started(1));
    printer.emit(printer.event("execution_progress", { jobId: 100, completedSheets: 1 }));
    const failed = await drive(run);
    // A later print of the step, on another printer, registers a fresh record.
    const other = testPrinter("sealed-other", { firstJob: 700 });
    const later = runPrintJob({ adapter: other, emitter, jobId: "print-sealed", jobName: "a.pdf", totalPages: 1 });
    await drive(other.started(1));
    gate.resolve(); // the slow hash finishes; what queued behind it must stay unwritten
    await vi.advanceTimersByTimeAsync(0);
    other.complete(700);
    const ok = await drive(later);

    expect.soft(failed, "the failed print's result").toEqual({ success: false, events: [], error: "print job print-sealed timed out after 1000ms", durationMs: expect.any(Number) });
    expect(tags(ok.bundle?.events ?? []), "the later print's bundle").toEqual(["execution_started#700", "execution_completed#700"]);
  });
});

describe("an adapter without quiesceEvidence", () => {
  it.each([
    ["no quiesceEvidence", undefined],
    ["a quiesceEvidence that is not a function", "yes"],
  ])("with %s is refused before any command or registerStep", async (_name, hook) => {
    const printer = testPrinter(`no-hook-${String(hook)}`);
    (printer as unknown as { quiesceEvidence: unknown }).quiesceEvidence = hook;
    const { emitter } = recordingEmitter();
    const registerStep = vi.spyOn(emitter, "registerStep");
    const run = runPrintJob({ adapter: printer, emitter, jobId: "print-nohook", jobName: "a.pdf", totalPages: 1 });
    await vi.advanceTimersByTimeAsync(0);
    if (printer.jobs.length > 0) printer.complete(); // at the base it started: let it end
    const result = await drive(run);

    expect.soft(result, "the print's result").toEqual(refused(`adapter no-hook-${String(hook)} has no quiesceEvidence(), so its evidence cannot be bound to a print`));
    expect.soft(printer.commands, "commands sent").toEqual([]);
    expect(registerStep, "steps registered").not.toHaveBeenCalled();
  });
});

describe("invariants kept", () => {
  it("mock events are still labelled simulated, and every event is bundled exactly as the printer emitted it", async () => {
    const kernel = createIppPrintKernel({ kernelId: KERNEL_ID, deviceId: "ipp-inv", mockMode: true, seed: SEED });
    const emitted: Array<{ event: Emitted; snapshot: string }> = [];
    kernel.adapter.onEvidence((event) => emitted.push({ event, snapshot: JSON.stringify(event) }));
    const result = await drive(kernel.print({ jobId: "print-inv", jobName: "inv.pdf", totalPages: 2 }));
    await kernel.dispose();
    const bundled = result.bundle?.events ?? [];

    expect.soft(result.completion?.simulated, "the completion is labelled simulated").toBe(true);
    expect.soft(bundled.map((e) => [e.source.simulated, e.payload.mock]), "every bundled event is labelled simulated and mock").toEqual(bundled.map(() => [true, true]));
    expect.soft(emitted.map(({ event, snapshot }) => JSON.stringify(event) === snapshot), "emitted events left unmutated").toEqual(emitted.map(() => true));
    expect(bundled.map(({ id: _id, hash: _hash, ...rest }) => rest), "bundled events are the emitted ones").toEqual(emitted.map(({ event }) => event));
  });
});
