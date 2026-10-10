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
  const { FakeIppPrinter, jobResponse, printerResponse } = await import("./helpers/fake-ipp-printer.js");
  const { IPP_OPERATION } = await import("../adapters/ipp-codec.js");
  let jobDoneAt = Number.POSITIVE_INFINITY;
  const printer = new FakeIppPrinter((request) => {
    if (request.code === IPP_OPERATION.PRINT_JOB) {
      jobDoneAt = Date.now() + 5_000;
      return jobResponse(request, { jobId: 77 });
    }
    if (request.code === IPP_OPERATION.GET_JOB_ATTRIBUTES) {
      const done = Date.now() >= jobDoneAt;
      return jobResponse(request, { jobId: 77, jobState: done ? endState : 5, impressionsCompleted: done ? 3 : 1, jobStateReasons: ["job-completed-successfully"] });
    }
    return printerResponse(request);
  });
  return new IppAdapter(id, { uri: "ipp://printer.test/ipp/print", kernelId: KERNEL_ID, mockMode: false, pollIntervalMs: 2_000, transport: printer.transport });
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

  it("(real mode) a slow digest of execution_started still leaves the print's events in the order the printer reported them (N123)", async () => {
    // runPrintJob calls addEvent as each event arrives, without waiting for the one before to be
    // stored. execution_started's digest is held 3 s of the fake clock, past the 2 s poll's
    // progress event: the emitter still stores it first, in the signed bundle too.
    const subtle = globalThis.crypto.subtle;
    const real = subtle.digest.bind(subtle);
    vi.spyOn(subtle, "digest").mockImplementation(((algorithm: Parameters<typeof real>[0], data: Parameters<typeof real>[1]) => {
      const started = new TextDecoder().decode(data as Uint8Array).includes('"type":"execution_started"');
      return started ? new Promise((resolve) => setTimeout(resolve, 3_000)).then(() => real(algorithm, data)) : real(algorithm, data);
    }) as typeof subtle.digest);
    const ipp = await realModePrinter("ipp-bind-slow-start");
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const outcome = runPrintJob({ adapter: ipp, emitter, jobId: "job-ipp-5", jobName: "doc", totalPages: 3, documentData: "%PDF-1.4" }).then(
      (result) => ({ result, rejected: undefined }),
      (err: unknown) => ({ result: undefined, rejected: String(err) }),
    );
    await vi.advanceTimersByTimeAsync(6_000);

    const { result, rejected } = await outcome;
    expect(rejected, "runPrintJob rejected").toBeUndefined();
    expect(result).toMatchObject({ success: true });
    expect(result?.events.map((e) => e.type)).toEqual(PRINTED);
    expect(result?.bundle?.events.map((e) => e.type)).toEqual(PRINTED);
  });
});
