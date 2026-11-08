import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachineAdapter } from "../adapter-factory.js";
import type { IppAdapter, IppAdapterConfig } from "../adapters/ipp-adapter.js";
import type { IppTransport } from "../adapters/ipp-transport.js";
import { IPP_OPERATION } from "../adapters/ipp-codec.js";
import { FakeIppPrinter } from "./helpers/fake-ipp-printer.js";

const CONFIG = {
  uri: "ipp://printer.test/ipp/print", mockMode: false, pollIntervalMs: 50,
  requestDeadlineMs: 2222, printJobDeadlineMs: 3333, maxResponseBytes: 4444,
  maxDocumentBytes: 3, documentFormat: "image/png", cancelConfirmMs: 500,
};
const adapters: IppAdapter[] = [];
function make() {
  const adapter = createMachineAdapter({ id: "factory-r2", type: "machine", adapterType: "ipp", config: { kernelId: "factory-kernel", ...CONFIG } }) as IppAdapter;
  adapters.push(adapter);
  return adapter;
}
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.dispose(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("real IPP adapter factory config forwarding", () => {
  it("F13 B2.5: preserves all six nondefault real IPP settings", () => {
    const adapter = make();
    const internal = adapter as unknown as { config: IppAdapterConfig };
    expect(internal.config).toMatchObject({
      requestDeadlineMs: 2222, printJobDeadlineMs: 3333, maxResponseBytes: 4444,
      maxDocumentBytes: 3, documentFormat: "image/png", cancelConfirmMs: 500,
    });
    expect(adapter.source.simulated).toBe(false);
  });

  it("F13 B2.5: forwarded limits and format govern requests through the factory", async () => {
    vi.useFakeTimers();
    const adapter = make();
    const printer = new FakeIppPrinter();
    const internal = adapter as unknown as { ippClient: { config: { transport: IppTransport } } };
    vi.spyOn(internal.ippClient.config, "transport").mockImplementation(printer.transport);
    const oversized = await adapter.execute({ type: "start", payload: { documentData: new Uint8Array(4) } });
    expect(oversized).toEqual({ success: false, message: "documentData exceeds maxDocumentBytes" });
    expect(printer.requests).toEqual([]);
    expect(await adapter.execute({ type: "start", payload: { documentData: new Uint8Array(3) } })).toMatchObject({ success: true, data: { jobId: 77 } });
    const print = printer.operationRequests(IPP_OPERATION.PRINT_JOB)[0];
    const format = print.groups[0].attributes.find(attribute => attribute.name === "document-format");
    expect(format?.values.map(value => Buffer.from(value.bytes).toString("ascii"))).toEqual(["image/png"]);
    expect(printer.transportRequests.map(request => [request.deadlineMs, request.maxResponseBytes])).toEqual([[2222, 4444], [3333, 4444]]);
    await adapter.cancelJob(77);
    const events: string[] = [];
    adapter.onEvidence(event => events.push(event.type));
    await vi.advanceTimersByTimeAsync(499);
    expect(events).not.toContain("execution_failed");
    await vi.advanceTimersByTimeAsync(1);
    expect(events.filter(type => type === "execution_failed")).toHaveLength(1);
    await adapter.quiesceEvidence();
  });
});
