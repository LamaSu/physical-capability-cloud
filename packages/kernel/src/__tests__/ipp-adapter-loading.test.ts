/**
 * The optional-module loading lifecycle no longer exists. These tests preserve
 * its disposal/quiescence guarantees at the actual HTTP request boundaries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IppAdapter } from "../adapters/ipp-adapter.js";
import { IPP_OPERATION } from "../adapters/ipp-codec.js";
import type { IppTransportResult } from "../adapters/ipp-transport.js";
import { FakeIppPrinter, deferred, jobResponse, printerResponse } from "./helpers/fake-ipp-printer.js";

const adapters: IppAdapter[] = [];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function adapter(printer = new FakeIppPrinter()) {
  const value = new IppAdapter("ipp-fence", { uri: "ipp://printer.test/ipp/print", kernelId: "k", mockMode: false, pollIntervalMs: 50, transport: printer.transport });
  adapters.push(value);
  return value;
}
const start = (ipp: IppAdapter) => ipp.execute({ type: "start", payload: { documentData: "%PDF", jobName: "doc" } });
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { for (const ipp of adapters.splice(0)) await ipp.dispose(); vi.useRealTimers(); });

describe("IPP construction and disposal fences (replaces optional-module loading)", () => {
  it("marks real mode immediately, performs no construction I/O, and has no downgrade", async () => {
    const printer = new FakeIppPrinter();
    const ipp = adapter(printer);
    expect(ipp.source.simulated).toBe(false);
    expect(printer.requests).toEqual([]);
    expect(await start(ipp)).toMatchObject({ success: true, data: { jobId: 77 } });
    expect(ipp.source.simulated).toBe(false);
  });

  it("reads status/capabilities and cancels using real operations", async () => {
    const printer = new FakeIppPrinter();
    const ipp = adapter(printer);
    expect(await ipp.getStatus()).toBe("idle");
    expect((await ipp.getCapabilities()).makeModel).toBe("Unknown Printer");
    await ipp.cancelJob(7);
    expect(printer.requests.map(r => r.code)).toEqual([11, 11, 8]);
  });

  it("quiesce waits for a pending start and the entire poll chain, then settles after completion", async () => {
    const printer = new FakeIppPrinter();
    const gate = deferred<IppTransportResult>();
    printer.setHandler(IPP_OPERATION.PRINT_JOB, () => gate.promise);
    printer.setHandler(IPP_OPERATION.GET_JOB_ATTRIBUTES, r => jobResponse(r, { jobState: 9 }));
    const ipp = adapter(printer);
    const events: string[] = [];
    ipp.onEvidence(e => events.push(e.type));
    const pending = start(ipp);
    await flush();
    let quiet = false;
    void ipp.quiesceEvidence().then(() => { quiet = true; });
    expect(quiet).toBe(false);
    gate.resolve(jobResponse(printer.requests[1]));
    await pending;
    await flush();
    expect(quiet).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(quiet).toBe(true);
    expect(events).toEqual(["execution_started", "execution_completed"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toHaveLength(2);
  });

  it("dispose between readiness and Print-Job prevents submission and quiesce settles", async () => {
    const printer = new FakeIppPrinter();
    const gate = deferred<IppTransportResult>();
    printer.setHandler(IPP_OPERATION.GET_PRINTER_ATTRIBUTES, () => gate.promise);
    const ipp = adapter(printer);
    const pending = start(ipp);
    await flush();
    await ipp.dispose();
    gate.resolve(printerResponse(printer.requests[0]));
    expect(await pending).toMatchObject({ success: false, message: expect.stringContaining("disposed") });
    expect(printer.requests.map(r => r.code)).toEqual([11]);
    await ipp.quiesceEvidence();
  });

  it("once disposed, all commands, cancel, and reads start no requests", async () => {
    const printer = new FakeIppPrinter();
    const ipp = adapter(printer);
    await ipp.dispose();
    expect((await start(ipp)).success).toBe(false);
    await expect(ipp.cancelJob(7)).rejects.toThrow("disposed");
    for (const type of ["pause", "resume", "stop", "status", "load_gcode"] as const) expect((await ipp.execute({ type })).success).toBe(false);
    expect(await ipp.getStatus()).toBe("offline");
    expect(await ipp.getProgress()).toBe(0);
    await expect(ipp.getCapabilities()).rejects.toThrow("disposed");
    expect(printer.requests).toEqual([]);
    await ipp.quiesceEvidence();
  });

  it("a Print-Job answer after dispose succeeds unmonitored, starts no polls, and quiesces", async () => {
    const printer = new FakeIppPrinter();
    const gate = deferred<IppTransportResult>();
    printer.setHandler(IPP_OPERATION.PRINT_JOB, () => gate.promise);
    const ipp = adapter(printer);
    const events: unknown[] = [];
    ipp.onEvidence(e => events.push(e));
    const pending = start(ipp);
    await flush();
    await ipp.dispose();
    gate.resolve(jobResponse(printer.requests[1], { jobId: 46 }));
    expect(await pending).toMatchObject({ success: true, data: { jobId: 46, monitored: false }, message: expect.stringContaining("not monitored") });
    await vi.advanceTimersByTimeAsync(200);
    expect(printer.requests.map(r => r.code)).toEqual([11, 2]);
    expect(events).toEqual([]);
    await ipp.quiesceEvidence();
  });

  it("an in-flight poll after dispose emits nothing, schedules nothing, and remains outstanding until its answer", async () => {
    const printer = new FakeIppPrinter();
    const gate = deferred<IppTransportResult>();
    printer.setHandler(IPP_OPERATION.GET_JOB_ATTRIBUTES, () => gate.promise);
    const ipp = adapter(printer);
    const events: string[] = [];
    ipp.onEvidence(e => events.push(e.type));
    await start(ipp);
    await vi.advanceTimersByTimeAsync(50);
    await ipp.dispose();
    let quiet = false;
    void ipp.quiesceEvidence().then(() => { quiet = true; });
    await flush();
    expect(quiet).toBe(false);
    gate.resolve(jobResponse(printer.requests[2], { jobState: 9 }));
    await flush();
    expect(quiet).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(printer.requests).toHaveLength(3);
    expect(events).toEqual(["execution_started"]);
  });

  it("a failed query rejects capabilities and returns offline, never mock data", async () => {
    const printer = new FakeIppPrinter();
    printer.setHandler(IPP_OPERATION.GET_PRINTER_ATTRIBUTES, () => ({ ok: false, kind: "connect", sent: false, message: "refused" }));
    const ipp = adapter(printer);
    await expect(ipp.getCapabilities()).rejects.toThrow("connect");
    expect(await ipp.getStatus()).toBe("offline");
    expect(ipp.source.simulated).toBe(false);
  });
});
