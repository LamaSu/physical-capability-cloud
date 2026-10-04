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

describe("IppAdapter events record under the PCC job; the printer's job number is ippJobId (LO-EV-9)", () => {
  it("(real mode) every event of a print records under the PCC job", async () => {
    const ipp = await realModePrinter("ipp-bind-real");
    const emitter = new EvidenceEmitter(KERNEL_ID);
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
    const emitter = new EvidenceEmitter(KERNEL_ID);
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

  it("(real mode) a print the printer aborts fails on its own device job's execution_failed, with the printer's reason", async () => {
    const ipp = await realModePrinter("ipp-bind-abort", 8);
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const outcome = runPrintJob({ adapter: ipp, emitter, jobId: "job-ipp-4", jobName: "doc", totalPages: 3, documentData: "%PDF-1.4" }).then(
      (result) => ({ result, rejected: undefined }),
      (err: unknown) => ({ result: undefined, rejected: String(err) }),
    );
    await vi.advanceTimersByTimeAsync(6_000);

    const { result, rejected } = await outcome;
    expect(rejected, "runPrintJob rejected").toBeUndefined();
    // It ends on the execution_failed of its own device job, bound by ippJobId. A failed print
    // returns no events (its step is detached).
    expect(result).toEqual({ success: false, events: [], error: 'printer reported failure: {"ippJobId":77,"state":"aborted"}', durationMs: expect.any(Number) });
    expect(console.warn, "an event excluded as naming no device job").not.toHaveBeenCalledWith(expect.stringContaining("names no device job"));
  });

  it("(mock mode) every event of a print records under the PCC job", async () => {
    const ipp = new IppAdapter("ipp-bind-mock", { uri: "ipp://printer.test/ipp/print", kernelId: KERNEL_ID, mockMode: true });
    const emitter = new EvidenceEmitter(KERNEL_ID);
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
