/** Finding 2: exercise the real adapter and its production HTTP transport. */
import { Buffer } from "node:buffer";
import { createServer, type ServerResponse } from "node:http";
import { clearTimeout as realClearTimeout, setImmediate as realImmediate, setTimeout as realTimeout } from "node:timers";
import type { EvidenceEvent } from "@pcc/spec";
import { describe, expect, it, vi } from "vitest";
import { IppAdapter, type IppDiagnostic } from "../adapters/ipp-adapter.js";
import { IPP_OPERATION as OP, decodeIppMessage, type IppMessage } from "../adapters/ipp-codec.js";
import type { IppTransportResult } from "../adapters/ipp-transport.js";
import { deferred, ippResponse, jobResponse, printerResponse } from "./helpers/fake-ipp-printer.js";

type Event = Omit<EvidenceEvent, "id" | "hash">;
type Exchange = { request: IppMessage; response: ServerResponse; closed: Promise<void> };
type Printer = {
  adapter: IppAdapter;
  events: Event[];
  diagnostics: IppDiagnostic[];
  polls: Exchange[];
  firstPoll: Promise<Exchange>;
  nextPoll: () => Promise<Exchange>;
  nextEvent: (type: Event["type"]) => Promise<Event>;
  nextDiagnostic: () => Promise<IppDiagnostic>;
  start: () => ReturnType<IppAdapter["execute"]>;
};
const DOCUMENT = Uint8Array.of(0x25, 0x50, 0x44, 0x46);
const CONFIRM_MS = 200;
const POLL_MS = 50;

function reply(exchange: Exchange, result: IppTransportResult): void {
  if (!result.ok) throw new Error("Loopback printer replies must be encoded IPP answers");
  exchange.response.writeHead(result.httpStatus, {
    "Content-Type": "application/ipp", "Content-Length": String(result.body.byteLength),
  });
  exchange.response.end(Buffer.from(result.body));
}

/** Real I/O keeps running; only the deadline being asserted advances. */
async function flushIo(): Promise<void> {
  await new Promise<void>(resolve => realImmediate(resolve));
  await new Promise<void>(resolve => realImmediate(resolve));
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof realTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = realTimeout(() => reject(new Error("Real loopback I/O or quiesce did not settle")), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) realClearTimeout(timer);
  }
}

async function withPrinter(cancelStatus: number, run: (printer: Printer) => Promise<void>): Promise<void> {
  const firstPoll = deferred<Exchange>();
  const pollWaiters: Array<(exchange: Exchange) => void> = [];
  const eventWaiters: Array<{ type: Event["type"]; resolve: (event: Event) => void }> = [];
  const diagnosticWaiters: Array<(diagnostic: IppDiagnostic) => void> = [];
  const events: Event[] = [];
  const diagnostics: IppDiagnostic[] = [];
  const polls: Exchange[] = [];
  let printCount = 0;
  let adapter: IppAdapter | undefined;
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => {
      const request = decodeIppMessage(Buffer.concat(chunks));
      const closed = deferred<void>();
      response.socket!.once("close", () => closed.resolve());
      const exchange = { request, response, closed: closed.promise };
      if (request.code === OP.GET_PRINTER_ATTRIBUTES) reply(exchange, printerResponse(request));
      else if (request.code === OP.PRINT_JOB) reply(exchange, jobResponse(request, { jobId: 77 + printCount++ }));
      else if (request.code === OP.CANCEL_JOB) reply(exchange, ippResponse(request, { statusCode: cancelStatus }));
      else if (request.code === OP.GET_JOB_ATTRIBUTES) {
        polls.push(exchange);
        if (polls.length === 1) firstPoll.resolve(exchange);
        pollWaiters.shift()?.(exchange);
        // Deliberately silent until the test answers: no transport seam or fake adapter.
      } else throw new Error(`Unexpected IPP operation ${request.code}`);
    });
  });
  try {
    // EPERM/EACCES remains a visible failure: these cases require real sockets.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback printer has no TCP address");
    adapter = new IppAdapter("terminal-loopback", {
      uri: `ipp://127.0.0.1:${address.port}/ipp/print`, kernelId: "terminal-kernel", mockMode: false,
      pollIntervalMs: POLL_MS, cancelConfirmMs: CONFIRM_MS, requestDeadlineMs: 60_000,
    });
    adapter.onEvidence(event => {
      events.push(structuredClone(event));
      const index = eventWaiters.findIndex(waiter => waiter.type === event.type);
      if (index !== -1) eventWaiters.splice(index, 1)[0].resolve(event);
    });
    adapter.onDiagnostic(diagnostic => {
      diagnostics.push(structuredClone(diagnostic));
      diagnosticWaiters.shift()?.(diagnostic);
    });
    const realAdapter = adapter;
    await run({
      adapter, events, diagnostics, polls, firstPoll: firstPoll.promise,
      nextPoll: () => new Promise(resolve => pollWaiters.push(resolve)),
      nextEvent: type => new Promise(resolve => eventWaiters.push({ type, resolve })),
      nextDiagnostic: () => new Promise(resolve => diagnosticWaiters.push(resolve)),
      start: () => realAdapter.execute({ type: "start", payload: { jobName: "deadline.pdf", documentData: DOCUMENT } }),
    });
  } finally {
    await adapter?.dispose();
    vi.useRealTimers();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function firstRead(printer: Printer): Promise<Exchange> {
  expect(await printer.start()).toMatchObject({ success: true, data: { jobId: 77 } });
  const exchange = await bounded(printer.firstPoll);
  // Print-Job and this poll's crypto.subtle hashing finished before fake time starts.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldClearNativeTimers: true });
  return exchange;
}

async function readProcessing(printer: Printer): Promise<void> {
  const first = await firstRead(printer);
  const observed = printer.nextEvent("execution_progress");
  reply(first, jobResponse(first.request, { jobState: 5, jobStateReasons: ["job-printing", "job-queued"], impressionsCompleted: 1 }));
  await bounded(observed);
  await flushIo();
}

async function silentPoll(printer: Printer): Promise<Exchange> {
  const arriving = printer.nextPoll();
  await vi.advanceTimersByTimeAsync(POLL_MS);
  // Do not advance the terminal deadline while the next read's hash is unresolved.
  return bounded(arriving);
}

function terminalPayload(printer: Printer): unknown[] {
  return printer.events.filter(event => event.type === "execution_failed" || event.type === "execution_completed").map(event => event.payload);
}

async function expectExpiry(printer: Printer, held: Exchange, expected: Record<string, unknown>): Promise<void> {
  let idle = false;
  const quiesce = printer.adapter.quiesceEvidence().then(() => { idle = true; });
  await vi.advanceTimersByTimeAsync(CONFIRM_MS - POLL_MS - 1);
  expect(terminalPayload(printer)).toEqual([]);
  expect(idle).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(terminalPayload(printer)).toEqual([expected]);
  // Removing the poll's AbortSignal strands this work behind its 60-second request deadline.
  await bounded(quiesce);
  expect(idle).toBe(true);
  await bounded(held.closed);
  const pollsAtExpiry = printer.polls.length;
  await vi.advanceTimersByTimeAsync(CONFIRM_MS);
  await flushIo();
  expect(printer.polls).toHaveLength(pollsAtExpiry);
  expect(terminalPayload(printer)).toEqual([expected]);
}

async function expectNextPrint(printer: Printer): Promise<void> {
  expect(await printer.start()).toMatchObject({ success: true, data: { jobId: 78 } });
  const next = await silentPoll(printer);
  const completed = printer.nextEvent("execution_completed");
  reply(next, jobResponse(next.request, { jobId: 78, jobState: 9 }));
  await bounded(completed);
  await bounded(printer.adapter.quiesceEvidence());
  expect(printer.events.filter(event => event.type === "execution_completed").map(event => event.payload)).toEqual([{ ippJobId: 78 }]);
}

describe("real IPP terminal deadline over loopback HTTP", () => {
  it.each([["0x0404", 0x0404], ["0x0406", 0x0406]] as const)("cancel %s then silence aborts polling, fails exactly once, quiesces, and accepts the next print", async (_label, status) => {
    await withPrinter(status, async printer => {
      await readProcessing(printer);
      await expect(printer.adapter.cancelJob(77)).rejects.toThrow();
      const held = await silentPoll(printer);
      await expectExpiry(printer, held, {
        ippJobId: 77, state: "processing", reason: "cancel-unconfirmed",
        jobStateReasons: ["job-printing", "job-queued"], origin: "device",
      });
      await expectNextPrint(printer);
    });
  });

  it("cancel before any state preserves unobservable and empty reasons after silence", async () => {
    await withPrinter(0x0406, async printer => {
      const held = await firstRead(printer);
      await expect(printer.adapter.cancelJob(77)).rejects.toThrow();
      // This poll was already in flight, so the full deadline remains.
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await expectExpiry(printer, held, {
        ippJobId: 77, state: "unobservable", reason: "cancel-unconfirmed", jobStateReasons: [], origin: "device",
      });
      await expectNextPrint(printer);
    });
  });

  it("Get-Job-Attributes 0x0406 without cancel arms job-unobservable and quiesces", async () => {
    await withPrinter(0, async printer => {
      const first = await firstRead(printer);
      const observed = printer.nextDiagnostic();
      reply(first, ippResponse(first.request, { statusCode: 0x0406 }));
      expect((await bounded(observed)).kind).toBe("poll_failed");
      await flushIo();
      const held = await silentPoll(printer);
      await expectExpiry(printer, held, {
        ippJobId: 77, state: "unobservable", reason: "job-unobservable", jobStateReasons: [], origin: "device",
      });
      await expectNextPrint(printer);
    });
  });

  it.each([[7, "canceled"], [8, "aborted"], [9, "completed"]] as const)("state %s with absent reasons arms job-unobservable using the last state keyword", async (state, keyword) => {
    await withPrinter(0, async printer => {
      const first = await firstRead(printer);
      const observed = printer.nextDiagnostic();
      reply(first, jobResponse(first.request, { jobState: state, jobStateReasons: null }));
      expect((await bounded(observed)).kind).toBe("job_unreadable");
      await flushIo();
      const held = await silentPoll(printer);
      await expectExpiry(printer, held, {
        ippJobId: 77, state: keyword, reason: "job-unobservable", jobStateReasons: [], origin: "device",
      });
      await expectNextPrint(printer);
    });
  });

  it("state 9 with 33 reasons is unusable and never signs a truncated reasons array", async () => {
    await withPrinter(0, async printer => {
      const first = await firstRead(printer);
      const observed = printer.nextDiagnostic();
      reply(first, jobResponse(first.request, { jobState: 9, jobStateReasons: Array.from({ length: 33 }, () => "job-completed-successfully") }));
      expect((await bounded(observed)).kind).toBe("job_unreadable");
      await flushIo();
      const held = await silentPoll(printer);
      await expectExpiry(printer, held, {
        ippJobId: 77, state: "completed", reason: "job-unobservable", jobStateReasons: [], origin: "device",
      });
    });
  });

  it("a clean state 9 sent after expiry cannot contradict the terminal failure", async () => {
    await withPrinter(0x0404, async printer => {
      await readProcessing(printer);
      await expect(printer.adapter.cancelJob(77)).rejects.toThrow();
      const held = await silentPoll(printer);
      const expected = {
        ippJobId: 77, state: "processing", reason: "cancel-unconfirmed",
        jobStateReasons: ["job-printing", "job-queued"], origin: "device",
      };
      await expectExpiry(printer, held, expected);
      reply(held, jobResponse(held.request, { jobState: 9, jobStateReasons: ["job-completed-successfully"] }));
      await flushIo();
      expect(terminalPayload(printer)).toEqual([expected]);
      expect(printer.events.filter(event => event.type === "execution_completed")).toEqual([]);
      await expectNextPrint(printer);
    });
  });

  it("later unusable terminal answers do not reset the first deadline", async () => {
    await withPrinter(0, async printer => {
      const first = await firstRead(printer);
      let observed = printer.nextDiagnostic();
      reply(first, jobResponse(first.request, { jobState: 9, jobStateReasons: null }));
      await bounded(observed);
      await flushIo();
      let held = await silentPoll(printer);
      observed = printer.nextDiagnostic();
      reply(held, jobResponse(held.request, { jobState: 8, jobStateReasons: null }));
      await bounded(observed);
      await flushIo();
      held = await silentPoll(printer);
      await vi.advanceTimersByTimeAsync(CONFIRM_MS - 2 * POLL_MS - 1);
      expect(terminalPayload(printer)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(terminalPayload(printer)).toEqual([{
        ippJobId: 77, state: "aborted", reason: "job-unobservable", jobStateReasons: [], origin: "device",
      }]);
      await bounded(printer.adapter.quiesceEvidence());
      await bounded(held.closed);
    });
  });

  it.each([null, ["printer-stopped"]])("state 6 alone does not arm a deadline (reasons %s)", async reasons => {
    await withPrinter(0, async printer => {
      const first = await firstRead(printer);
      const observed = reasons === null ? printer.nextDiagnostic() : printer.nextEvent("execution_progress");
      reply(first, jobResponse(first.request, { jobState: 6, jobStateReasons: reasons }));
      await bounded<Event | IppDiagnostic>(observed);
      await flushIo();
      const held = await silentPoll(printer);
      let idle = false;
      const quiesce = printer.adapter.quiesceEvidence().then(() => { idle = true; });
      await vi.advanceTimersByTimeAsync(2 * CONFIRM_MS);
      expect(terminalPayload(printer)).toEqual([]);
      expect(idle).toBe(false);
      const completed = printer.nextEvent("execution_completed");
      reply(held, jobResponse(held.request, { jobState: 9 }));
      await bounded(completed);
      await bounded(quiesce);
      expect(terminalPayload(printer)).toEqual([{ ippJobId: 77 }]);
    });
  });
});
