/**
 * Every IppAdapter event records under the PCC job that drives it (LO-EV-9, #341). The
 * printer's own job number is reported as ippJobId: payload.jobId is reserved for the PCC
 * job, which the emitter commits on every event and refuses to see pre-filled with anything
 * else. A real-mode poll's execution_progress still named the printer's job as jobId, so the
 * emitter refused it, and a real print that reported progress failed (found merging #336
 * into #502).
 *
 * Real mode runs against a fake IPP client on the fake clock, as in
 * adapter-quiesce-evidence.test.ts: the client answers on microtasks, so the clock alone
 * decides when a poll lands.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IppAdapter } from "../adapters/ipp-adapter.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { runPrintJob } from "../printer-job.js";

const KERNEL_ID = "kernel-ipp-binding-test";
const STEP = "step-1";
const PRINTED = ["execution_started", "execution_progress", "execution_progress", "execution_completed"];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * A real-mode adapter whose printer is a fake: its job 77 has printed 1 sheet until 5 s after
 * it was submitted, then reports `endState` (9 completed, 8 aborted) with all 3.
 */
async function realModePrinter(id: string, endState: 8 | 9 = 9): Promise<IppAdapter> {
  const ipp = new IppAdapter(id, { uri: "ipp://printer.test/ipp/print", kernelId: KERNEL_ID, mockMode: false, pollIntervalMs: 2_000 });
  await vi.dynamicImportSettled(); // the optional 'ipp' package is not installed: it routes to mock, then we inject a client
  let jobDoneAt = Number.POSITIVE_INFINITY;
  class Printer {
    execute(op: string, _msg: unknown, _data: unknown, cb: (err: Error | null, res: Record<string, unknown>) => void) {
      if (op === "Print-Job") {
        jobDoneAt = Date.now() + 5_000;
        queueMicrotask(() => cb(null, { "job-attributes-tag": { "job-id": 77 } }));
      } else if (op === "Get-Job-Attributes") {
        const done = Date.now() >= jobDoneAt;
        queueMicrotask(() => cb(null, { "job-attributes-tag": { "job-state": done ? endState : 5, "job-impressions-completed": done ? 3 : 1 } }));
      } else queueMicrotask(() => cb(null, {}));
    }
  }
  Object.assign(ipp, { ippClient: { Printer }, ippAvailable: true });
  return ipp;
}

/**
 * An EvidenceEmitter that records events in the order addEvent is CALLED, which is the order
 * the adapter emitted them. A plain emitter stores an event once its async hash completes, so
 * concurrent addEvent calls can store out of emission order: master's runPrintJob makes such
 * calls, and a slow hash of execution_started reordered its bundle in CI (#474's run). The
 * printer line (#521) records on one ordered chain. These tests check the emission order, so
 * their emitter serializes the calls; a refused event still rejects its own call.
 */
function orderedEmitter(): EvidenceEmitter {
  const emitter = new EvidenceEmitter(KERNEL_ID);
  const add = emitter.addEvent.bind(emitter);
  let chain: Promise<unknown> = Promise.resolve();
  emitter.addEvent = ((jobId, stepId, event) => {
    const recorded = chain.then(() => add(jobId, stepId, event));
    chain = recorded.catch(() => undefined);
    return recorded;
  }) as typeof emitter.addEvent;
  return emitter;
}

describe("IppAdapter events record under the PCC job; the printer's job number is ippJobId (LO-EV-9)", () => {
  it("(real mode) every event of a print records under the PCC job", async () => {
    const ipp = await realModePrinter("ipp-bind-real");
    const emitter = orderedEmitter();
    emitter.registerStep("job-ipp-1", STEP, 0);
    const adds: Array<Promise<unknown>> = [];
    ipp.onEvidence((event) => adds.push(emitter.addEvent("job-ipp-1", STEP, event)));

    expect(await ipp.execute({ type: "start", payload: { documentData: "%PDF-1.4", jobName: "doc" } })).toMatchObject({ success: true });
    await vi.advanceTimersByTimeAsync(6_000); // polls at 2000 and 4000: processing; at 6000: completed

    const refused = (await Promise.allSettled(adds)).flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
    expect(refused, "events the emitter refused").toEqual([]);
    const recorded = emitter.getEvents("job-ipp-1", STEP);
    expect(recorded.map((e) => e.type)).toEqual(PRINTED);
    for (const event of recorded) expect(event.payload, event.type).toMatchObject({ jobId: "job-ipp-1", ippJobId: 77 });
  });

  it("(real mode) runPrintJob completes a print that reports progress, naming the printer's job", async () => {
    const ipp = await realModePrinter("ipp-bind-print");
    const emitter = orderedEmitter();
    // Settled into a value at once, so a rejection is reported here rather than as unhandled.
    const outcome = runPrintJob({ adapter: ipp, emitter, jobId: "job-ipp-2", jobName: "doc", totalPages: 3, documentData: "%PDF-1.4" }).then(
      (result) => ({ result, rejected: undefined }),
      (err: unknown) => ({ result: undefined, rejected: String(err) }),
    );
    await vi.advanceTimersByTimeAsync(6_000);

    const { result, rejected } = await outcome;
    expect(rejected, "runPrintJob rejected").toBeUndefined();
    expect(result?.error).toBeUndefined();
    expect(result).toMatchObject({ success: true, completion: { jobId: "job-ipp-2", printerJobId: 77 } });
    expect(result?.events.map((e) => e.type)).toEqual(PRINTED);
  });

  it("(real mode) a print the printer aborts fails with the printer's reason, its events under the PCC job", async () => {
    const ipp = await realModePrinter("ipp-bind-abort", 8);
    const emitter = orderedEmitter();
    const outcome = runPrintJob({ adapter: ipp, emitter, jobId: "job-ipp-4", jobName: "doc", totalPages: 3, documentData: "%PDF-1.4" }).then(
      (result) => ({ result, rejected: undefined }),
      (err: unknown) => ({ result: undefined, rejected: String(err) }),
    );
    await vi.advanceTimersByTimeAsync(6_000);

    const { result, rejected } = await outcome;
    expect(rejected, "runPrintJob rejected").toBeUndefined();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("printer reported failure") });
    expect(result?.events.map((e) => e.type)).toEqual(["execution_started", "execution_progress", "execution_progress", "execution_failed"]);
    for (const event of result?.events ?? []) expect(event.payload, event.type).toMatchObject({ jobId: "job-ipp-4", ippJobId: 77 });
  });

  it("(mock mode) every event of a print records under the PCC job", async () => {
    const ipp = new IppAdapter("ipp-bind-mock", { uri: "ipp://printer.test/ipp/print", kernelId: KERNEL_ID, mockMode: true });
    const emitter = orderedEmitter();
    emitter.registerStep("job-ipp-3", STEP, 0);
    const adds: Array<Promise<unknown>> = [];
    ipp.onEvidence((event) => adds.push(emitter.addEvent("job-ipp-3", STEP, event)));

    expect(await ipp.execute({ type: "start", payload: { jobName: "doc", totalPages: 2 } })).toMatchObject({ success: true });
    await vi.advanceTimersByTimeAsync(60_000);

    const refused = (await Promise.allSettled(adds)).flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
    expect(refused, "events the emitter refused").toEqual([]);
    const recorded = emitter.getEvents("job-ipp-3", STEP);
    expect(recorded.map((e) => e.type)).toEqual(["execution_started", "execution_progress", "execution_progress", "execution_completed"]);
    for (const event of recorded) expect(event.payload, event.type).toMatchObject({ jobId: "job-ipp-3", ippJobId: expect.any(Number) });
  });
});
