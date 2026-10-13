import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";
import { IppAdapter, type IppAdapterConfig } from "../adapters/ipp-adapter.js";
import { IPP_OPERATION as OP, type IppMessage } from "../adapters/ipp-codec.js";
import type { IppTransportResult } from "../adapters/ipp-transport.js";
import { FakeIppPrinter, deferred, ippResponse, jobResponse, printerResponse } from "./helpers/fake-ipp-printer.js";

type Event = Omit<EvidenceEvent, "id" | "hash">;
const adapters: IppAdapter[] = [];
const doc = Uint8Array.of(0x41);
function make(printer = new FakeIppPrinter(), config: Partial<IppAdapterConfig> = {}) {
  const adapter = new IppAdapter("r2", { uri: "ipp://printer.test/ipp/print", kernelId: "k", pollIntervalMs: 50, transport: printer.transport, ...config });
  adapters.push(adapter);
  const events: Event[] = [];
  adapter.onEvidence(event => events.push(structuredClone(event)));
  return { adapter, printer, events };
}
const start = (adapter: IppAdapter, payload: Record<string, unknown> = {}) => adapter.execute({ type: "start", payload: { documentData: doc, ...payload } });
const poll = () => vi.advanceTimersByTimeAsync(50);
const flush = async () => { for (let i = 0; i < 20; ++i) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.dispose(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("PR2 round 2 regressions", () => {
  it.each([
    ["job-canceled-by-user", "stopped"], ["job-canceled-by-operator", "stopped"],
    ["aborted-by-system", "stopped"], ["processing-to-stop-point", "stopped"],
    ["job-canceled-at-device", "stopped"], ["completed-with-errors", "with-errors"],
  ])("F1/T3: state 9 %s pins literal ordered reasons and device origin", async (reason, completion) => {
    const reasons = ["job-restartable", reason];
    const { adapter, events } = make(new FakeIppPrinter().setHandler(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState: 9, jobStateReasons: reasons })));
    await start(adapter); await poll();
    expect(events.at(-1)?.type).toBe("execution_failed");
    expect(events.at(-1)?.payload).toEqual({ ippJobId: 77, state: "completed", completion, jobStateReasons: ["job-restartable", reason], origin: "device" });
    await adapter.quiesceEvidence();
  });

  it.each([0x0400, 0x0504, 0x0507, 0x0508].flatMap(code => [[code, false], [code, true]] as const))(
    "F4/T4: Print-Job code %s with job-id %s is uncertain and never busy", async (statusCode, withId) => {
      const printer = new FakeIppPrinter().setHandler(OP.PRINT_JOB, request => withId ? jobResponse(request, { statusCode }) : ippResponse(request, { statusCode }));
      const { adapter, events } = make(printer);
      const result = await start(adapter);
      expect(result.success).toBe(false);
      expect(result.data).toEqual({ ippStatusCode: statusCode, deviceStateUnknown: true });
      expect(result).not.toHaveProperty("busy");
      expect(result.data).not.toHaveProperty("busy");
      expect(printer.operationRequests(OP.PRINT_JOB)).toHaveLength(1);
      expect(events).toEqual([]);
    },
  );

  it("T7: printer readiness busy pins the keyword and has no local busy flag", async () => {
    const { adapter } = make(new FakeIppPrinter().setHandler(OP.GET_PRINTER_ATTRIBUTES, request => printerResponse(request, { printerState: 4 })));
    const result = await start(adapter);
    expect(result).toHaveProperty("busy", true);
    expect(result.data).toEqual({ printerState: "processing" });
  });
  it("T7: only an adapter job in flight reports data.busy and refuses a second start", async () => {
    const { adapter, printer } = make();
    await start(adapter);
    const result = await start(adapter);
    expect(result).toHaveProperty("busy", true);
    expect(result.data).toEqual({ busy: true });
    expect(printer.operationRequests(OP.PRINT_JOB)).toHaveLength(1);
  });

  it.each(["readiness", "submission"])("T7: concurrent start during %s is refused by the adapter reservation", async phase => {
    const answer = deferred<IppTransportResult>(); let request!: IppMessage;
    const printer = new FakeIppPrinter().setHandler(phase === "readiness" ? OP.GET_PRINTER_ATTRIBUTES : OP.PRINT_JOB, input => { request = input; return answer.promise; });
    const { adapter } = make(printer);
    const first = start(adapter); await flush();
    const second = start(adapter); await flush();
    answer.resolve(phase === "readiness" ? printerResponse(request) : jobResponse(request));
    const results = await Promise.all([first, second]);
    expect(results[0].success).toBe(true);
    expect(results[1]).toMatchObject({ success: false, busy: true });
    expect(results[1].data).toEqual({ busy: true });
    expect(printer.operationRequests(OP.PRINT_JOB)).toHaveLength(1);
  });

  it.each(["status", "capabilities", "status-command"])("F5: a pending %s read does not hold evidence quiesce", async kind => {
    const answer = deferred<IppTransportResult>();
    let request!: IppMessage;
    const { adapter } = make(new FakeIppPrinter().setHandler(OP.GET_PRINTER_ATTRIBUTES, input => { request = input; return answer.promise; }));
    const read = kind === "status" ? adapter.getStatus() : kind === "capabilities" ? adapter.getCapabilities() : adapter.execute({ type: "status" });
    await flush();
    let idle = false;
    void adapter.quiesceEvidence().then(() => { idle = true; });
    await flush();
    const wasIdle = idle;
    answer.resolve(printerResponse(request)); await read;
    expect(wasIdle).toBe(true);
  });
  it("F5: pending getProgress does not hold quiesce after the poll reports completion", async () => {
    const answer = deferred<IppTransportResult>();
    let request!: IppMessage;
    const printer = new FakeIppPrinter().enqueue(OP.GET_JOB_ATTRIBUTES, input => { request = input; return answer.promise; })
      .enqueue(OP.GET_JOB_ATTRIBUTES, input => jobResponse(input, { jobState: 9 }));
    const { adapter } = make(printer);
    await start(adapter);
    const read = adapter.getProgress(); await flush(); await poll();
    let idle = false;
    void adapter.quiesceEvidence().then(() => { idle = true; }); await flush();
    const wasIdle = idle;
    answer.resolve(jobResponse(request, { jobState: 5 })); await read;
    expect(wasIdle).toBe(true);
  });

  it.each(["", new Uint8Array(0), Buffer.alloc(0)])("F6: empty document %s sends no readiness or print I/O", async documentData => {
    const { adapter, printer } = make();
    expect(await start(adapter, { documentData })).toMatchObject({ success: false, message: expect.stringContaining("No documentData") });
    expect(printer.requests).toEqual([]);
  });

  it("F7: polling is live before start notification and each throwing evidence listener is contained", async () => {
    const { adapter, printer, events } = make(new FakeIppPrinter().setHandler(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState: 9 })));
    let idleAtStart = false; let timerCountAtStart = 0;
    const thrower = vi.fn((event: Event) => {
      if (event.type === "execution_started") { timerCountAtStart = vi.getTimerCount(); }
      if (event.type === "execution_started") void adapter.quiesceEvidence().then(() => { idleAtStart = true; });
      throw new Error("observer");
    });
    adapter.onEvidence(thrower);
    const afterThrower = vi.fn(); adapter.onEvidence(afterThrower);
    await expect(start(adapter)).resolves.toEqual({ success: true, message: "IPP job 77 submitted", data: { jobId: 77 } });
    await flush(); expect(idleAtStart).toBe(false); expect(timerCountAtStart).toBe(1);
    await poll(); await adapter.quiesceEvidence();
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(1);
    expect(events.map(e => e.type)).toEqual(["execution_started", "execution_completed"]);
    expect(afterThrower).toHaveBeenCalledTimes(2); expect(thrower).toHaveBeenCalledTimes(2);
  });

  it.each([6, 9])("F10: state %s with exactly 32 reasons remains usable", async jobState => {
    const reasons = Array.from({ length: 32 }, () => "job-restartable");
    const { adapter, events } = make(new FakeIppPrinter().setHandler(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState, jobStateReasons: reasons })));
    const diagnostics = vi.fn(); adapter.onDiagnostic(diagnostics);
    await start(adapter); await poll();
    expect(events.map(e => e.type)).toEqual(["execution_started", jobState === 6 ? "execution_progress" : "execution_completed"]);
    expect(events.at(-1)?.payload).toEqual(jobState === 6
      ? { ippJobId: 77, state: "processing-stopped", jobStateReasons: reasons }
      : { ippJobId: 77 });
    expect(diagnostics).not.toHaveBeenCalled();
    if (jobState === 9) await adapter.quiesceEvidence();
  });
  it.each([6, 9])("F10: state %s with 33 reasons is unusable, never truncated evidence", async jobState => {
    const reasons = Array.from({ length: 33 }, () => "job-restartable");
    const { adapter, events } = make(new FakeIppPrinter().setHandler(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState, jobStateReasons: reasons })));
    const diagnostics = vi.fn(); adapter.onDiagnostic(diagnostics);
    await start(adapter); await poll();
    expect(events.map(e => e.type)).toEqual(["execution_started"]);
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ kind: "job_unreadable" }));
  });
  it("R4 F-3: idle readiness with exactly 32 reasons reaches Print-Job", async () => {
    // Kills B2: keywordList's > 32 cap changed to > 31.
    const reasons = Array.from({ length: 32 }, () => "none");
    const { adapter, printer, events } = make(new FakeIppPrinter().setHandler(OP.GET_PRINTER_ATTRIBUTES,
      request => printerResponse(request, { printerState: 3, printerStateReasons: reasons })));
    expect(await start(adapter)).toEqual({ success: true, message: "IPP job 77 submitted", data: { jobId: 77 } });
    expect(printer.operationRequests(OP.PRINT_JOB)).toHaveLength(1);
    expect(events.map(event => event.type)).toEqual(["execution_started"]);
  });
  it("F3/F10: readiness refuses 33 reasons before joining or Print-Job", async () => {
    const { adapter, printer } = make(new FakeIppPrinter().setHandler(OP.GET_PRINTER_ATTRIBUTES, request => printerResponse(request, { printerState: 5, printerStateReasons: Array.from({ length: 33 }, () => "media-jam-error") })));
    expect(await start(adapter)).toMatchObject({ success: false, message: "IPP readiness attributes are unreadable" });
    expect(printer.operationRequests(OP.PRINT_JOB)).toEqual([]);
  });
  it("F9: response cap accepts 16 MiB and refuses more before I/O", () => {
    expect(() => make(undefined, { maxResponseBytes: 16 * 1024 * 1024 })).not.toThrow();
    expect(() => make(undefined, { maxResponseBytes: 16 * 1024 * 1024 + 1 })).toThrow("maxResponseBytes");
  });

  it("F11 A12/A13: nondefault cap and deadlines reach all transport operations", async () => {
    const { adapter, printer } = make(undefined, { maxResponseBytes: 4321, requestDeadlineMs: 2345, printJobDeadlineMs: 3456 });
    await start(adapter); await poll(); await adapter.cancelJob(77);
    expect(printer.transportRequests.map(r => [r.deadlineMs, r.maxResponseBytes])).toEqual([[2345, 4321], [3456, 4321], [2345, 4321], [2345, 4321]]);
  });
  it("F11 A31: terminal recovery survives a throwing diagnostic listener before other listeners", async () => {
    const printer = new FakeIppPrinter().enqueue(OP.GET_JOB_ATTRIBUTES, request => ippResponse(request, { statusCode: 0x0500 }))
      .enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState: 9 }));
    const { adapter, events } = make(printer);
    adapter.onDiagnostic(() => { throw new Error("observer"); });
    const later = vi.fn(); adapter.onDiagnostic(later);
    await start(adapter); await poll(); await poll();
    expect(later.mock.calls.map(c => c[0].kind)).toEqual(["poll_failed", "poll_recovered"]);
    expect(events.map(e => e.type)).toEqual(["execution_started", "execution_completed"]);
    await adapter.quiesceEvidence();
  });
  it("T5: a stale clean terminal poll answer after stop emits nothing", async () => {
    const answer = deferred<IppTransportResult>(); let request!: IppMessage;
    const { adapter, events } = make(new FakeIppPrinter().enqueue(OP.GET_JOB_ATTRIBUTES, input => { request = input; return answer.promise; }));
    await start(adapter); await poll();
    await adapter.execute({ type: "stop" });
    answer.resolve(jobResponse(request, { jobState: 9 })); await flush(); await poll();
    expect(events.map(e => e.type)).toEqual(["execution_started"]);
    await adapter.quiesceEvidence();
  });
  it("T5: Cancel-Job in flight at dispose completes but cannot revive polling or evidence", async () => {
    const answer = deferred<IppTransportResult>(); let request!: IppMessage;
    const { adapter, printer, events } = make(new FakeIppPrinter().enqueue(OP.CANCEL_JOB, input => { request = input; return answer.promise; }));
    await start(adapter);
    const cancel = adapter.cancelJob(77); await flush(); await adapter.dispose();
    let idle = false; void adapter.quiesceEvidence().then(() => { idle = true; }); await flush();
    expect(idle).toBe(false);
    answer.resolve(ippResponse(request)); await cancel; await adapter.quiesceEvidence(); await poll();
    expect(printer.operationRequests(OP.CANCEL_JOB)).toHaveLength(1);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(0);
    expect(events.map(e => e.type)).toEqual(["execution_started"]);
  });

  it.each([0x0404, 0x0406, 0])("F2: cancel answer %s cannot disarm deadline; silence is failed, aborted and fenced", async statusCode => {
    const answer = deferred<IppTransportResult>(); let request!: IppMessage;
    const printer = new FakeIppPrinter().enqueue(OP.GET_JOB_ATTRIBUTES, input => jobResponse(input, { jobState: 5, jobStateReasons: ["job-printing", "job-restartable"] }))
      .enqueue(OP.GET_JOB_ATTRIBUTES, input => { request = input; return answer.promise; })
      .enqueue(OP.CANCEL_JOB, input => ippResponse(input, { statusCode }));
    const { adapter, events } = make(printer, { cancelConfirmMs: 100 });
    await start(adapter); await poll();
    const cancel = adapter.cancelJob(77);
    if (statusCode) await expect(cancel).rejects.toThrow("IPP cancel failed"); else await cancel;
    await poll();
    const signal = printer.transportRequests.at(-1)?.signal;
    let idle = false; void adapter.quiesceEvidence().then(() => { idle = true; });
    await vi.advanceTimersByTimeAsync(49); expect(idle).toBe(false); expect(events.filter(e => e.type === "execution_failed")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(events.at(-1)?.payload).toEqual({ ippJobId: 77, state: "processing", reason: "cancel-unconfirmed", jobStateReasons: ["job-printing", "job-restartable"], origin: "device" });
    expect(signal?.aborted).toBe(true);
    // Injected transport deliberately ignores abort to prove the late-answer fence.
    answer.resolve(jobResponse(request, { jobState: 9 })); await flush();
    await adapter.quiesceEvidence(); expect(idle).toBe(true);
    expect(events.map(e => e.type)).toEqual(["execution_started", "execution_failed"]);
    expect((await start(adapter)).success).toBe(true);
  });
  it.each(["purged", "unusable-7", "unusable-8", "unusable-9"])("F2: %s without cancel arms job-unobservable once", async kind => {
    const printer = new FakeIppPrinter().setHandler(OP.GET_JOB_ATTRIBUTES, request => kind === "purged" ? ippResponse(request, { statusCode: 0x0406 }) : jobResponse(request, { jobState: Number(kind.slice(-1)), jobStateReasons: null }));
    const { adapter, events } = make(printer, { cancelConfirmMs: 100 });
    await start(adapter); await poll(); await poll();
    expect(events.map(e => e.type)).toEqual(["execution_started"]);
    await poll(); await adapter.quiesceEvidence();
    const state = kind === "purged" ? "unobservable" : kind === "unusable-7" ? "canceled" : kind === "unusable-8" ? "aborted" : "completed";
    expect(events.at(-1)?.payload).toEqual({ ippJobId: 77, state, reason: "job-unobservable", jobStateReasons: [], origin: "device" });
    expect(printer.operationRequests(OP.CANCEL_JOB)).toHaveLength(0);
    expect((await start(adapter)).success).toBe(true);
  });
  it("F2: state 6 alone does not arm the terminal deadline", async () => {
    const { adapter, events } = make(new FakeIppPrinter().setHandler(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState: 6, jobStateReasons: null })), { cancelConfirmMs: 100 });
    await start(adapter); await vi.advanceTimersByTimeAsync(500);
    expect(events.map(e => e.type)).toEqual(["execution_started"]);
    let idle = false; void adapter.quiesceEvidence().then(() => { idle = true; }); await flush(); expect(idle).toBe(false);
    await adapter.dispose(); await adapter.quiesceEvidence();
  });
  it("R4 F-6/PD1: repeated purged polls leave no terminal timers after expiry", async () => {
    // Kills M10: removing armTerminalDeadline's terminalTimer !== null guard.
    const { adapter, printer, events } = make(new FakeIppPrinter().setHandler(OP.GET_JOB_ATTRIBUTES,
      request => ippResponse(request, { statusCode: 0x0406 })), { cancelConfirmMs: 200 });
    await start(adapter);
    await vi.advanceTimersByTimeAsync(200);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(4);
    expect(events.filter(event => event.type === "execution_failed")).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(events.filter(event => event.type === "execution_failed").map(event => event.payload)).toEqual([
      { ippJobId: 77, state: "unobservable", reason: "job-unobservable", jobStateReasons: [], origin: "device" },
    ]);
    // Check before advancing again or teardown can hide generation-fenced orphan timers.
    expect(vi.getTimerCount()).toBe(0);
    await adapter.quiesceEvidence();
  });
  it.each([0x0406, 0x0407])("R4 F-8/PD2: gone code %s expires as job-unobservable without cancel", async statusCode => {
    // Kills F8-not-found-only (drop 0x0407) and F8-gone-only (drop 0x0406).
    const { adapter, printer, events } = make(new FakeIppPrinter().setHandler(OP.GET_JOB_ATTRIBUTES,
      request => ippResponse(request, { statusCode })), { cancelConfirmMs: 200 });
    expect((await start(adapter)).success).toBe(true);
    await vi.advanceTimersByTimeAsync(249);
    expect(events.map(event => event.type)).toEqual(["execution_started"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events.map(event => event.type)).toEqual(["execution_started", "execution_failed"]);
    expect(events.at(-1)?.payload).toEqual({ ippJobId: 77, state: "unobservable", reason: "job-unobservable", jobStateReasons: [], origin: "device" });
    await adapter.quiesceEvidence();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.filter(event => event.type === "execution_failed")).toHaveLength(1);
    expect(printer.operationRequests(OP.CANCEL_JOB)).toEqual([]);
    expect((await start(adapter)).success).toBe(true);
  });
  it("F2: the default cancel deadline is 20 seconds and does not wait for a poll tick", async () => {
    const { adapter, events } = make(undefined, { pollIntervalMs: 600000 });
    await start(adapter); await adapter.cancelJob(77);
    await vi.advanceTimersByTimeAsync(19999); expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(events.at(-1)?.payload).toEqual({ ippJobId: 77, state: "unobservable", reason: "cancel-unconfirmed", jobStateReasons: [], origin: "device" });
    await adapter.quiesceEvidence();
  });
  it("F2: repeated cancels retain the first deadline and terminal event is emitted once", async () => {
    const { adapter, events } = make(undefined, { cancelConfirmMs: 100 });
    await start(adapter); await adapter.cancelJob(77); await poll(); await adapter.cancelJob(77); await poll(); await poll();
    expect(events.filter(e => e.type === "execution_failed").map(e => e.payload)).toEqual([{ ippJobId: 77, state: "processing", reason: "cancel-unconfirmed", jobStateReasons: ["job-printing"], origin: "device" }]);
    await adapter.quiesceEvidence();
  });
  it.each([0, -1, 1.5, NaN, Infinity, 2147483648])("F2: invalid cancelConfirmMs %s is refused without I/O", cancelConfirmMs => {
    const printer = new FakeIppPrinter(); expect(() => make(printer, { cancelConfirmMs })).toThrow("cancelConfirmMs"); expect(printer.requests).toEqual([]);
  });

  it.each(["café.pdf", "test\u00a0.pdf", "\u0080", "é".repeat(100)])("F13 G5: nonASCII jobName %s is refused before I/O", async jobName => {
    const { adapter, printer } = make();
    expect(await start(adapter, { jobName })).toMatchObject({ success: false, message: "jobName must be 1-255 printable ASCII characters" });
    expect(printer.requests).toEqual([]);
  });
  it("F13 G5: printable ASCII jobName at both bounds is accepted", async () => {
    for (const jobName of [" ", "A".repeat(255)]) {
      const { adapter, printer } = make();
      expect((await start(adapter, { jobName })).success).toBe(true);
      expect(printer.operationRequests(OP.PRINT_JOB)).toHaveLength(1);
    }
  });
});
