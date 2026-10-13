import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";
import { IppAdapter } from "../adapters/ipp-adapter.js";
import { IPP_OPERATION as OP, type IppMessage } from "../adapters/ipp-codec.js";
import type { IppTransportResult } from "../adapters/ipp-transport.js";
import { FakeIppPrinter, deferred, ippResponse, jobResponse } from "./helpers/fake-ipp-printer.js";

let adapter: IppAdapter;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  await adapter?.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("IPP stop race", () => {
  it("a delayed stop cancel cannot stop polling or evidence for a replacement job", async () => {
    const cancelAnswer = deferred<IppTransportResult>();
    let cancelRequest!: IppMessage;
    const printer = new FakeIppPrinter()
      .enqueue(OP.PRINT_JOB, request => jobResponse(request, { jobId: 77 }))
      .enqueue(OP.PRINT_JOB, request => jobResponse(request, { jobId: 78 }))
      .enqueue(OP.CANCEL_JOB, request => { cancelRequest = request; return cancelAnswer.promise; })
      .enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobId: 77, jobState: 9 }))
      .enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobId: 78, jobState: 5, impressionsCompleted: 1 }))
      .enqueue(OP.GET_JOB_ATTRIBUTES, request => jobResponse(request, { jobId: 78, jobState: 9 }));
    adapter = new IppAdapter("stop-race", {
      uri: "ipp://printer.test/ipp/print", kernelId: "k", pollIntervalMs: 50, transport: printer.transport,
    });
    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence(event => events.push(structuredClone(event)));
    const start = () => adapter.execute({ type: "start", payload: { documentData: Uint8Array.of(0x41) } });

    expect(await start()).toMatchObject({ success: true, data: { jobId: 77 } });
    const stop = adapter.execute({ type: "stop" });
    await vi.advanceTimersByTimeAsync(0);
    expect(printer.operationRequests(OP.CANCEL_JOB)).toHaveLength(1);

    // The first job ends and a new one is accepted while its Cancel-Job reply is held.
    await vi.advanceTimersByTimeAsync(50);
    expect(events.at(-1)).toMatchObject({ type: "execution_completed", payload: { ippJobId: 77 } });
    expect(await start()).toMatchObject({ success: true, data: { jobId: 78 } });
    cancelAnswer.resolve(ippResponse(cancelRequest));
    expect(await stop).toEqual({ success: true, message: "IPP job cancelled" });

    await vi.advanceTimersByTimeAsync(100);
    expect(events.map(event => [event.type, event.payload.ippJobId])).toEqual([
      ["execution_started", 77],
      ["execution_completed", 77],
      ["execution_started", 78],
      ["execution_progress", 78],
      ["execution_completed", 78],
    ]);
    expect(events[3].payload).toEqual({ ippJobId: 78, completedSheets: 1 });
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(3);
    await adapter.quiesceEvidence();
  });
});
