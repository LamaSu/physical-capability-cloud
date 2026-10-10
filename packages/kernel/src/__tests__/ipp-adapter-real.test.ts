import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";
import vectors from "./fixtures/ipp-vectors.json" with { type: "json" };
import { IppAdapter, type IppAdapterConfig, type IppDiagnostic } from "../adapters/ipp-adapter.js";
import {
  IPP_OPERATION as OP, IPP_TAG, booleanValue, enumValue, integerValue, keywordValue,
  nameValue, textValue, type IppMessage,
} from "../adapters/ipp-codec.js";
import type { IppTransportResult } from "../adapters/ipp-transport.js";
import { FakeIppPrinter, deferred, ippResponse, jobResponse, printerResponse } from "./helpers/fake-ipp-printer.js";

type Event = Omit<EvidenceEvent, "id" | "hash">;
const URI = "ipp://printer.test/ipp/print";
const adapters: IppAdapter[] = [];
const documentData = Uint8Array.of(0x25, 0x50, 0x44, 0x46);
function make(printer = new FakeIppPrinter(), overrides: Partial<IppAdapterConfig> = {}) {
  const adapter = new IppAdapter("real-ipp", {
    uri: URI, kernelId: "real-kernel", mockMode: false, pollIntervalMs: 50,
    transport: printer.transport, ...overrides,
  });
  adapters.push(adapter);
  const events: Event[] = [];
  const diagnostics: IppDiagnostic[] = [];
  adapter.onEvidence(event => events.push(structuredClone(event)));
  adapter.onDiagnostic(diagnostic => diagnostics.push(structuredClone(diagnostic)));
  return { adapter, printer, events, diagnostics };
}
const start = (adapter: IppAdapter, payload: Record<string, unknown> = {}) => adapter.execute({
  type: "start", payload: { jobName: "test.pdf", documentData, ...payload },
});
const poll = () => vi.advanceTimersByTimeAsync(50);
function failure(kind: "connect" | "deadline" | "io" = "io", sent = true): IppTransportResult {
  return { ok: false, kind, sent, message: "untrusted ipp://user:secret@printer.test/ raw response bytes" };
}
function vectorReply(fixture: { hex: string; httpStatus?: number }, request: IppMessage, input: {
  wrongRequestId?: boolean; keepVersion?: boolean;
} = {}): IppTransportResult {
  const body = Buffer.from(fixture.hex, "hex");
  if (!input.keepVersion) { body[0] = request.version[0]; body[1] = request.version[1]; }
  body.writeInt32BE(request.requestId + (input.wrongRequestId ? 1 : 0), 4);
  return { ok: true, httpStatus: fixture.httpStatus ?? 200, body };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("real-mode construction and submission", () => {
  it.each([
    ["ipps://printer.test/ipp/print", "no insecure TLS option"],
    ["http://printer.test/ipp/print", "ipp://"],
    ["https://printer.test/ipp/print", "ipp://"],
    ["ipp://user:secret@printer.test/ipp/print", "userinfo"],
    ["ipp://@printer.test/ipp/print", "userinfo"],
    ["ipp://printer.test/ipp/print?q=1", "query or fragment"],
    ["ipp://printer.test/ipp/print?", "query or fragment"],
    ["ipp://printer.test/ipp/print#part", "query or fragment"],
    ["ipp://printer.test/ipp/print#", "query or fragment"],
    ["ipp:///ipp/print", "host"],
    ["ipp://printer.test:0/ipp/print", "port"],
    ["ipp://printer.test:70000/ipp/print", "Invalid IPP"],
    ["not a uri", "Invalid IPP"],
    [`ipp://printer.test/${"a".repeat(1024)}`, "1023"],
  ])("A1: validateRealConfig synchronously refuses %s without credential disclosure", (uri, reason) => {
    const printer = new FakeIppPrinter();
    let message = "";
    try { make(printer, { uri }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(reason);
    expect(message).not.toContain("secret");
    expect(message).not.toContain("user:");
    expect(printer.requests).toHaveLength(0);
  });
  for (const key of ["pollIntervalMs", "requestDeadlineMs", "printJobDeadlineMs", "maxResponseBytes", "maxDocumentBytes"] as const) {
    const invalids: unknown[] = [0, -1, 1.5, NaN, Infinity, key === "pollIntervalMs" ? 600001 : 2147483648, "50", true, null];
    if (key === "pollIntervalMs") invalids.push(49);
    it.each(invalids)(`A1: validateRealConfig refuses noninteger/out-of-range ${key}=%s`, number => {
      const printer = new FakeIppPrinter();
      expect(() => make(printer, { [key]: number } as Partial<IppAdapterConfig>)).toThrow(key);
      expect(printer.requests).toHaveLength(0);
    });
  }
  it.each(["", "pdf", "application/", "/pdf", "application/pdf; charset=utf-8", "application/pdf\n", "application/péf", `application/${"a".repeat(255)}`])(
    "A1: validateRealConfig refuses documentFormat %s", documentFormat => {
      expect(() => make(undefined, { documentFormat })).toThrow("documentFormat");
    },
  );
  it("A1: construction marks a real printer simulated:false and performs no I/O", async () => {
    const { adapter, printer } = make(undefined, { pollIntervalMs: 50, requestDeadlineMs: 1, printJobDeadlineMs: 1, maxResponseBytes: 1, maxDocumentBytes: 1 });
    expect(adapter.source.simulated).toBe(false);
    expect(printer.requests).toHaveLength(0);
    await adapter.quiesceEvidence();
  });
  it("A1: omitted settings apply IPP/1.1, default deadlines, default size cap and PDF format", async () => {
    const printer = new FakeIppPrinter();
    const adapter = new IppAdapter("defaults", { uri: "ipp://printer.test", kernelId: "k", transport: printer.transport });
    adapters.push(adapter);
    expect((await start(adapter)).success).toBe(true);
    expect(printer.requests.map(request => request.version)).toEqual([[1, 1], [1, 1]]);
    expect(printer.transportRequests.map(request => [request.port, request.path, request.deadlineMs, request.maxResponseBytes]))
      .toEqual([[631, "/", 15000, 1048576], [631, "/", 120000, 1048576]]);
    const format = printer.requests[1].groups[0].attributes.find(attribute => attribute.name === "document-format")!;
    expect(Buffer.from(format.values[0].bytes).toString()).toBe("application/pdf");
    await vi.advanceTimersByTimeAsync(1999);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(1);
  });
  it("A2: missing and oversized documents are refused before readiness or Print-Job", async () => {
    const { adapter, printer } = make(undefined, { maxDocumentBytes: 3 });
    expect(await adapter.execute({ type: "start" })).toMatchObject({ success: false, message: expect.stringContaining("No documentData") });
    expect(await start(adapter)).toMatchObject({ success: false, message: expect.stringContaining("maxDocumentBytes") });
    expect(printer.requests).toHaveLength(0);
  });
  it.each(["", "a".repeat(256), "é".repeat(128), "test\n.pdf", "test\u007f.pdf", "\ud800", 42, null])(
    "A2: invalid jobName %s is refused before any request", async jobName => {
      const { adapter, printer } = make();
      expect((await start(adapter, { jobName })).success).toBe(false);
      expect(printer.requests).toHaveLength(0);
    },
  );
  it("A2: even an undefined per-start documentFormat is refused and points to config", async () => {
    const { adapter, printer } = make();
    expect(await start(adapter, { documentFormat: undefined })).toMatchObject({ success: false, message: expect.stringContaining("adapter config") });
    expect(printer.requests).toHaveLength(0);
  });
  it("A3/A4: idle readiness sends one Print-Job then emits the unchanged start payload", async () => {
    const { adapter, printer, events } = make();
    expect(await start(adapter, { jobName: "café.pdf" })).toEqual({ success: true, message: "IPP job 77 submitted", data: { jobId: 77 } });
    expect(printer.requests.map(request => request.code)).toEqual([OP.GET_PRINTER_ATTRIBUTES, OP.PRINT_JOB]);
    expect(printer.requests[0].groups[0].attributes.at(-1)?.values.map(value => Buffer.from(value.bytes).toString()))
      .toEqual(["printer-state", "printer-state-reasons", "printer-is-accepting-jobs"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "execution_started", source: { simulated: false }, payload: { ippJobId: 77, jobName: "café.pdf" } });
    await poll();
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(1);
  });
  it.each([
    [4, true, ["none"], "processing another job", true],
    [5, true, ["media-jam-error"], "media-jam-error", false],
    [3, false, ["none"], "not accepting", false],
    [2, true, ["none"], "unknown", false],
  ] as const)("A3: readiness state %s/accepting %s refuses without Print-Job", async (printerState, acceptingJobs, reasons, message, busy) => {
    const printer = new FakeIppPrinter().setHandler(OP.GET_PRINTER_ATTRIBUTES, request => printerResponse(request, { printerState, acceptingJobs, printerStateReasons: [...reasons] }));
    const { adapter } = make(printer);
    const result = await start(adapter);
    expect(result).toMatchObject({ success: false, message: expect.stringContaining(message) });
    expect(result).not.toHaveProperty("data.deviceStateUnknown");
    expect(result).not.toHaveProperty("data.busy");
    if (busy) expect(result).toHaveProperty("busy", true);
    else expect(result).not.toHaveProperty("busy");
    expect(printer.operationRequests(OP.PRINT_JOB)).toHaveLength(0);
  });
  it.each(["transport", "unreadable", "missing-accepting"])("A3: %s readiness is refused without Print-Job or unknown device state", async kind => {
    const printer = new FakeIppPrinter().setHandler(OP.GET_PRINTER_ATTRIBUTES, request => kind === "transport" ? failure() : ippResponse(request, {
      groups: [{ tag: IPP_TAG.PRINTER_ATTRIBUTES, attributes: [
        { name: "printer-state", values: [kind === "unreadable" ? integerValue(3) : enumValue(3)] },
        { name: "printer-state-reasons", values: [keywordValue("none")] },
      ] }],
    }));
    const { adapter } = make(printer);
    expect(await start(adapter)).toMatchObject({ success: false });
    expect(printer.operationRequests(OP.PRINT_JOB)).toHaveLength(0);
  });

  it.each(Object.entries(vectors.print_job_answers))("C5/A4: Print-Job vector %s is submitted exactly once with the required result", async (name, fixture) => {
    const printer = new FakeIppPrinter().setHandler(OP.PRINT_JOB, request => vectorReply(fixture, request));
    const { adapter, events } = make(printer);
    const result = await start(adapter);
    expect(printer.operationRequests(OP.PRINT_JOB)).toHaveLength(1);
    if (name === "ok_77") {
      expect(result).toMatchObject({ success: true, data: { jobId: 77 } });
      expect(events.map(event => event.type)).toEqual(["execution_started"]);
    } else {
      expect(result.success).toBe(false);
      expect(events).toHaveLength(0);
      if (name === "busy_0x0507" || name === "not_accepting_0x0506") {
        expect(result.data).toEqual({ ippStatusCode: name === "busy_0x0507" ? 0x0507 : 0x0506 });
        expect(result.message).toContain(name === "busy_0x0507" ? "server-error-busy" : "server-error-not-accepting-jobs");
      } else expect(result.data).toEqual({ deviceStateUnknown: true });
      if (name === "busy_0x0507") expect(result).toHaveProperty("busy", true);
      expect(result).not.toHaveProperty("data.busy");
    }
  });
  it.each(["sent-connect", "unsent-connect", "deadline", "http", "decode", "version", "request-id"])(
    "A4: Print-Job %s failure is never resent and identifies uncertain submission", async kind => {
      const printer = new FakeIppPrinter().setHandler(OP.PRINT_JOB, request => {
        if (kind === "sent-connect") return failure("connect", true);
        if (kind === "unsent-connect") return failure("connect", false);
        if (kind === "deadline") return failure("deadline", true);
        if (kind === "http") return ippResponse(request, { httpStatus: 303 });
        if (kind === "decode") return { ok: true, httpStatus: 200, body: Uint8Array.of(0xff) };
        if (kind === "version") return ippResponse(request, { version: [1, 0] });
        return ippResponse(request, { requestId: request.requestId + 1 });
      });
      const { adapter, events } = make(printer);
      const result = await start(adapter);
      expect(result.success).toBe(false);
      if (kind === "unsent-connect") expect(result.data).toBeUndefined();
      else expect(result.data).toEqual({ deviceStateUnknown: true });
      expect(printer.operationRequests(OP.PRINT_JOB)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(printer.operationRequests(OP.PRINT_JOB)).toHaveLength(1);
      expect(events).toHaveLength(0);
      expect(result.message).not.toContain("secret");
      expect(result.message).not.toContain("raw response bytes");
      if (kind === "version") {
        expect(result.message).toContain("1.0"); expect(result.message).toContain("1.1");
      }
    },
  );
});

describe("real polling, diagnostics and printer controls", () => {
  it.each(Object.entries(vectors.get_job_attributes_answers))(
    "C4/A5: poll vector %s matches pcc-node's terminal verdict", async (name, fixture) => {
      const printer = new FakeIppPrinter().setHandler(OP.GET_JOB_ATTRIBUTES, request => vectorReply(fixture, request, {
        wrongRequestId: name === "request_id_mismatch", keepVersion: name === "version_3_0",
      }));
      const { adapter, events, diagnostics } = make(printer);
      await start(adapter);
      await poll();
      const terminal = events.filter(event => event.type === "execution_completed" || event.type === "execution_failed");
      if (fixture.pccnodeVerdict === "completed") {
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({ type: "execution_completed", payload: { ippJobId: 77 } });
        expect(terminal[0].payload).toEqual({ ippJobId: 77 });
      } else if (fixture.pccnodeVerdict === "failed" || fixture.pccnodeVerdict === "unobservable") {
        expect(terminal).toHaveLength(1);
        expect(terminal[0].type).toBe("execution_failed");
        if (name === "canceled" || name === "aborted") expect(terminal[0].payload).toEqual({ ippJobId: 77, state: name });
        else expect(terminal[0].payload).toMatchObject({ ippJobId: 77, state: "completed",
          completion: fixture.pccnodeVerdict === "unobservable" ? "unobservable" : name === "completed_with_errors" ? "with-errors" : "stopped",
          jobStateReasons: expect.any(Array),
        });
      } else {
        expect(terminal).toHaveLength(0);
        if (name !== "processing" && name !== "stopped_jam") expect(diagnostics).toHaveLength(1);
      }
      const requests = printer.operationRequests(OP.GET_JOB_ATTRIBUTES).length;
      await poll();
      expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(requests + (terminal.length ? 0 : 1));
    },
  );
  it("A5: states 3, 4 and 5 retain repeated progress events and exact completedSheets payload", async () => {
    const printer = new FakeIppPrinter();
    for (const jobState of [3, 4, 5, 5]) printer.enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState, impressionsCompleted: 1 }));
    const { adapter, events } = make(printer);
    await start(adapter);
    for (let i = 0; i < 4; i += 1) await poll();
    expect(events.slice(1).map(event => ({ type: event.type, payload: event.payload }))).toEqual(Array.from({ length: 4 }, () => ({ type: "execution_progress", payload: { ippJobId: 77, completedSheets: 1 } })));
  });
  it("A5: state 6 emits on entry, changed reasons, and reentry; unreadable reasons are null", async () => {
    const printer = new FakeIppPrinter();
    for (const [jobState, jobStateReasons] of [
      [6, ["media-jam-error"]], [6, ["media-jam-error"]], [6, ["printer-stopped"]],
      [5, ["job-printing"]], [6, ["printer-stopped"]], [6, null], [6, null],
    ] as Array<[number, string[] | null]>) {
      printer.enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState, jobStateReasons, impressionsCompleted: 2 }));
    }
    const { adapter, events } = make(printer);
    await start(adapter);
    for (let i = 0; i < 7; i += 1) await poll();
    expect(events.filter(event => event.payload.jobState === 6).map(event => event.payload)).toEqual([
      { ippJobId: 77, jobState: 6, jobStateReasons: ["media-jam-error"], completedSheets: 2 },
      { ippJobId: 77, jobState: 6, jobStateReasons: ["printer-stopped"], completedSheets: 2 },
      { ippJobId: 77, jobState: 6, jobStateReasons: ["printer-stopped"], completedSheets: 2 },
      { ippJobId: 77, jobState: 6, jobStateReasons: null, completedSheets: 2 },
    ]);
  });
  it("A5/A6: unknown or unreadable job-state emits only a job_unreadable diagnostic and keeps polling", async () => {
    const printer = new FakeIppPrinter();
    printer.enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState: 99 }));
    printer.enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request));
    printer.enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState: 9 }));
    const { adapter, events, diagnostics } = make(printer);
    await start(adapter);
    await poll(); await poll();
    expect(events).toHaveLength(1);
    expect(diagnostics.map(diagnostic => [diagnostic.kind, diagnostic.consecutiveFailures])).toEqual([["job_unreadable", 1], ["job_unreadable", 2]]);
    await poll();
    expect(events.at(-1)?.type).toBe("execution_completed");
    expect(diagnostics.at(-1)).toMatchObject({ kind: "poll_recovered", consecutiveFailures: 0 });
  });
  it("A6: every failed poll emits one diagnostic, never evidence, and recovery is emitted once", async () => {
    const printer = new FakeIppPrinter();
    printer.enqueue(OP.GET_JOB_ATTRIBUTES, failure());
    printer.enqueue(OP.GET_JOB_ATTRIBUTES, request => ippResponse(request, { httpStatus: 404 }));
    printer.enqueue(OP.GET_JOB_ATTRIBUTES, { ok: true, httpStatus: 200, body: Uint8Array.of(0xff) });
    printer.enqueue(OP.GET_JOB_ATTRIBUTES, request => ippResponse(request, { requestId: request.requestId + 1 }));
    printer.enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobId: 78, jobState: 9 }));
    printer.enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState: 5 }));
    printer.enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState: 9 }));
    const { adapter, events, diagnostics } = make(printer);
    const throwingListener = vi.fn(() => { throw new Error("observer threw"); });
    adapter.onDiagnostic(throwingListener);
    const unsubscribed = vi.fn();
    adapter.onDiagnostic(unsubscribed)();
    await start(adapter);
    for (let i = 0; i < 5; i += 1) await poll();
    expect(events).toHaveLength(1);
    expect(diagnostics.map(diagnostic => [diagnostic.kind, diagnostic.failure?.kind, diagnostic.consecutiveFailures])).toEqual([
      ["poll_failed", "io", 1], ["poll_failed", "http", 2], ["poll_failed", "decode", 3],
      ["poll_failed", "request_id", 4], ["poll_failed", "wrong_job", 5],
    ]);
    for (const diagnostic of diagnostics) {
      expect(diagnostic).toMatchObject({ adapterId: "real-ipp", ippJobId: 77, operation: "Get-Job-Attributes", at: expect.any(String) });
      expect(new Date(diagnostic.at).toISOString()).toBe(diagnostic.at);
      expect(diagnostic.message).toMatch(/^[\x20-\x7e]{0,200}$/);
      expect(diagnostic.message).not.toContain(URI);
      expect(diagnostic.message).not.toContain("secret");
      expect(diagnostic.message).not.toContain("raw response bytes");
    }
    await poll(); await poll();
    expect(diagnostics.filter(diagnostic => diagnostic.kind === "poll_recovered")).toHaveLength(1);
    expect(diagnostics.at(-1)?.consecutiveFailures).toBe(0);
    expect(throwingListener).toHaveBeenCalledTimes(6);
    expect(unsubscribed).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("execution_completed");
  });
  it("A7: schedulePoll waits a full interval after a slow poll settles and never overlaps", async () => {
    const answer = deferred<IppTransportResult>();
    let pendingRequest!: IppMessage;
    const printer = new FakeIppPrinter().enqueue(OP.GET_JOB_ATTRIBUTES, request => { pendingRequest = request; return answer.promise; });
    const { adapter } = make(printer);
    await start(adapter);
    await poll();
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(1);
    answer.resolve(jobResponse(pendingRequest, { jobState: 5 }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(49);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(2);
  });
  it("A7: pollInFlight also prevents overlap when a new start replaces a job with a pending poll", async () => {
    const answer = deferred<IppTransportResult>();
    let pendingRequest!: IppMessage;
    const printer = new FakeIppPrinter()
      .enqueue(OP.GET_JOB_ATTRIBUTES, request => { pendingRequest = request; return answer.promise; })
      .enqueue(OP.PRINT_JOB, request => jobResponse(request, { jobId: 77 }))
      .enqueue(OP.PRINT_JOB, request => jobResponse(request, { jobId: 78 }))
      .setHandler(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobId: 78, jobState: 9 }));
    const { adapter, events } = make(printer);
    await start(adapter);
    await poll();
    await start(adapter, { jobName: "replacement.pdf" });
    await vi.advanceTimersByTimeAsync(500);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(1);
    answer.resolve(jobResponse(pendingRequest, { jobId: 77, jobState: 9 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.map(event => event.type)).toEqual(["execution_started", "execution_started"]);
    await vi.advanceTimersByTimeAsync(49);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(2);
    expect(events.at(-1)?.payload).toEqual({ ippJobId: 78 });
    expect(events.at(-1)?.type).toBe("execution_completed");
  });
  it("A8: realCancelJob sends exactly one Cancel-Job and leaves polling to report state 7", async () => {
    const printer = new FakeIppPrinter().enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState: 7 }));
    const { adapter, events } = make(printer);
    await start(adapter);
    await adapter.cancelJob(77);
    expect(printer.operationRequests(OP.CANCEL_JOB)).toHaveLength(1);
    expect(events).toHaveLength(1);
    await poll();
    expect(events.at(-1)).toMatchObject({ type: "execution_failed", payload: { ippJobId: 77, state: "canceled" } });
    expect(events.at(-1)?.payload).toEqual({ ippJobId: 77, state: "canceled" });
    await poll();
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(1);
    await adapter.quiesceEvidence();
  });
  it("A8: a terminal cancel refusal keeps the IPP cancel failed prefix and names its status", async () => {
    const printer = new FakeIppPrinter().enqueue(OP.CANCEL_JOB, request => ippResponse(request, { statusCode: 0x0404 }));
    const { adapter } = make(printer);
    await expect(adapter.cancelJob(77)).rejects.toThrow("IPP cancel failed: IPP client-error-not-possible (0x0404)");
    expect(printer.operationRequests(OP.CANCEL_JOB)).toHaveLength(1);
  });
  it("A8: a purged canceled job is a poll diagnostic rather than invented cancel evidence", async () => {
    const printer = new FakeIppPrinter().setHandler(OP.GET_JOB_ATTRIBUTES, request => ippResponse(request, { statusCode: 0x0406 }));
    const { adapter, events, diagnostics } = make(printer);
    await start(adapter);
    await adapter.cancelJob(77);
    await poll(); await poll();
    expect(events).toHaveLength(1);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ kind: "poll_failed", failure: { kind: "ipp_status", statusCode: 0x0406 } });
    expect(printer.operationRequests(OP.CANCEL_JOB)).toHaveLength(1);
  });
  it.each([0, 0x0401, 0x0402, 0x0403, 0x0501])("A9: pause and resume send once and surface status 0x%s", async statusCode => {
    const printer = new FakeIppPrinter();
    for (const operation of [OP.PAUSE_PRINTER, OP.RESUME_PRINTER]) printer.setHandler(operation, request => ippResponse(request, { statusCode }));
    const { adapter } = make(printer);
    for (const [type, operation] of [["pause", OP.PAUSE_PRINTER], ["resume", OP.RESUME_PRINTER]] as const) {
      const result = await adapter.execute({ type });
      expect(result).toMatchObject({ success: statusCode === 0, data: { ippStatusCode: statusCode } });
      if (statusCode !== 0) expect(result.message).toContain(`0x${statusCode.toString(16).padStart(4, "0")}`);
      expect(printer.operationRequests(operation)).toHaveLength(1);
    }
  });
  it("getCapabilities decodes strict resolution and range TLVs while public query shapes remain stable", async () => {
    const printer = new FakeIppPrinter().setHandler(OP.GET_PRINTER_ATTRIBUTES, request => ippResponse(request, {
      groups: [{ tag: IPP_TAG.PRINTER_ATTRIBUTES, attributes: [
        { name: "printer-state", values: [enumValue(4)] },
        { name: "printer-make-and-model", values: [nameValue("Real Printer")] },
        { name: "color-supported", values: [booleanValue(true)] },
        { name: "sides-supported", values: [keywordValue("one-sided"), keywordValue("two-sided-long-edge")] },
        { name: "media-supported", values: [keywordValue("iso_a4_210x297mm")] },
        { name: "media-type-supported", values: [keywordValue("stationery")] },
        { name: "printer-resolution-supported", values: [
          { tag: 0x32, bytes: Buffer.from("0000012c0000012c03", "hex") },
          { tag: 0x32, bytes: Buffer.from("000000760000007604", "hex") },
        ] },
        { name: "copies-supported", values: [{ tag: 0x33, bytes: Buffer.from("0000000100000063", "hex") }] },
        { name: "pages-per-minute", values: [integerValue(15)] },
        { name: "pages-per-minute-color", values: [integerValue(10)] },
      ] }],
    }));
    const { adapter } = make(printer);
    expect(await adapter.getCapabilities()).toEqual({ makeModel: "Real Printer", printerState: "processing", color: true,
      duplex: true, mediaSizes: ["iso_a4_210x297mm"], resolutions: [300, 300], mediaTypes: ["stationery"],
      copiesSupported: { min: 1, max: 99 }, pagesPerMinute: 15, pagesPerMinuteColor: 10 });
    expect(await adapter.getStatus()).toBe("busy");
    expect(await adapter.getProgress()).toBe(0);
    expect(await adapter.execute({ type: "status" })).toEqual({ success: true, data: { printerState: "processing", makeModel: "Real Printer", jobId: null } });
  });
  it("getProgress queries only the active job and preserves impressions-completed", async () => {
    const printer = new FakeIppPrinter().setHandler(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobState: 5, impressionsCompleted: 3 }));
    const { adapter } = make(printer);
    await start(adapter);
    expect(await adapter.getProgress()).toBe(3);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(1);
  });

  it.each(["transport", "http", "decode", "version", "request-id", "ipp-status"])(
    "A11: every public method and command stays real after %s failures", async kind => {
      const badAnswer = (request: IppMessage): IppTransportResult => {
        if (kind === "transport") return failure();
        if (kind === "http") return ippResponse(request, { httpStatus: 404 });
        if (kind === "decode") return { ok: true, httpStatus: 200, body: Uint8Array.of(0xff) };
        if (kind === "version") return ippResponse(request, { version: [2, 0] });
        if (kind === "request-id") return ippResponse(request, { requestId: request.requestId + 1 });
        return ippResponse(request, { statusCode: 0x0501 });
      };
      const printer = new FakeIppPrinter(badAnswer);
      // Accept one real start so getProgress and stop also take their real device paths.
      printer.enqueue(OP.GET_PRINTER_ATTRIBUTES, request => printerResponse(request));
      printer.enqueue(OP.PRINT_JOB, request => jobResponse(request));
      const { adapter, events } = make(printer);
      const mock = vi.spyOn(adapter as unknown as { executeMock: (command: unknown) => unknown }, "executeMock");
      await start(adapter);
      await poll();
      expect(await adapter.getStatus()).toBe("offline");
      expect(await adapter.getProgress()).toBe(0);
      await expect(adapter.getCapabilities()).rejects.toThrow("IPP Get-Printer-Attributes failed");
      await expect(adapter.cancelJob(77)).rejects.toThrow("IPP cancel failed");
      for (const type of ["start", "pause", "resume", "status", "load_gcode"] as const) {
        const result = await adapter.execute({ type, payload: { jobName: "again.pdf", documentData } });
        expect(JSON.stringify(result)).not.toMatch(/"mock":true|"simulated":true|\(mock\)/);
      }
      await expect(adapter.execute({ type: "stop" })).rejects.toThrow("IPP cancel failed");
      expect(mock).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      for (const event of events) {
        expect(event.source.simulated).toBe(false);
        expect(event.payload).not.toHaveProperty("mock");
        expect(event.payload).not.toHaveProperty("simulated");
      }
      expect(adapter.source.simulated).toBe(false);
      await adapter.dispose();
      await adapter.quiesceEvidence();
    },
  );
});
