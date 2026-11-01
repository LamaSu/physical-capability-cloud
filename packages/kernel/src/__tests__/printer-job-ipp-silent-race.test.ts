import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { IppAdapter } from "../adapters/ipp-adapter.js";
import { IPP_OPERATION as OP, readInteger } from "../adapters/ipp-codec.js";
import type { IppTransportResult } from "../adapters/ipp-transport.js";
import { DEFAULT_CANCEL_WINDOW_MS, makeKernelEd25519Signer, runPrintJob } from "../printer-job.js";
import { FakeIppPrinter, jobResponse } from "./helpers/fake-ipp-printer.js";

// Match printer-job-failure-bundle.test.ts: hashing settles on promise boundaries
// under fake time, while the bundle still receives a real Ed25519 signature.
vi.mock("@pcc/spec", async (importOriginal) => {
  const spec = await importOriginal<typeof import("@pcc/spec")>();
  const { createHash } = await import("node:crypto");
  const digest = (value: unknown) => `sha256:${createHash("sha256").update(spec.canonicalize(value)).digest("hex")}`;
  return {
    ...spec,
    hashEvent: async (event: unknown) => digest(event),
    hashBundle: async (events: unknown) => digest(events),
  };
});

const adapters: IppAdapter[] = [];

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

async function drive<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  for (let count = 0; count < 100; count++) {
    await vi.advanceTimersByTimeAsync(0);
    if (settled) return pending;
    if (vi.getTimerCount() === 0) throw new Error("print pending with no timer left");
    await vi.advanceTimersToNextTimerAsync();
  }
  throw new Error("print pending after 100 timers");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("#7962 race through runPrintJob", () => {
  it("real defaults sign one device cancel-unconfirmed failure when the printer goes silent after cancel", async () => {
    const kernelId = "kernel-ipp-silent-race";
    const jobId = "pcc-ipp-silent-race";
    const timeoutMs = 2_500;
    const printer = new FakeIppPrinter();
    let silentPollSignal: AbortSignal | undefined;
    printer.setHandler(OP.GET_JOB_ATTRIBUTES, (request, raw) => {
      if (printer.operationRequests(OP.CANCEL_JOB).length === 0) return jobResponse(request, { jobState: 5 });
      // A Cancel-Job acknowledgement is never followed by terminal job-state
      // evidence. The pending poll only settles when the adapter aborts it.
      silentPollSignal = raw.signal;
      return new Promise<IppTransportResult>((resolve) => {
        const aborted = () => resolve({ ok: false, kind: "aborted", sent: true, message: "Silent stub poll aborted" });
        if (raw.signal?.aborted) aborted();
        else raw.signal?.addEventListener("abort", aborted, { once: true });
      });
    });
    // Leave pollIntervalMs and cancelConfirmMs unset: this is the real-mode
    // adapter's production timing, against runPrintJob's default cancel window.
    const adapter = new IppAdapter("ipp-silent-race", { uri: "ipp://printer.test/ipp/print", kernelId, transport: printer.transport });
    adapters.push(adapter);
    const signer = makeKernelEd25519Signer(new Uint8Array(32).fill(23));
    const emitter = new EvidenceEmitter(kernelId, signer.signFn);
    const pending = runPrintJob({
      adapter, emitter, jobId, stepId: "print", jobName: "invoice.pdf",
      totalPages: 1, documentData: Buffer.from("A"), timeoutMs,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(timeoutMs);
    expect(printer.operationRequests(OP.PRINT_JOB)).toHaveLength(1);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(1);
    const cancels = printer.operationRequests(OP.CANCEL_JOB);
    expect(cancels).toHaveLength(1);
    const cancelJobIds = cancels[0].groups.flatMap(group => group.attributes)
      .find(attribute => attribute.name === "job-id")?.values;
    expect(cancelJobIds?.map(readInteger)).toEqual([{ value: 77 }]);

    // Driving the pending result also terminates when a mutated confirmation
    // deadline exceeds the kernel window and produces a second failure.
    const result = await drive(pending);
    expect(result.success).toBe(false);
    expect(result.cancelRequested).toBe("timeout");
    expect(result.error).toContain(`timed out after ${timeoutMs}ms`);
    expect(result.bundle).toBeDefined();
    const bundle = result.bundle!;
    expect(result.events).toBe(bundle.events);
    expect(bundle.events.filter(event => event.type === "execution_failed").map(event => event.payload)).toEqual([
      { ippJobId: 77, state: "processing", reason: "cancel-unconfirmed", jobStateReasons: ["job-printing"], origin: "device", jobId },
    ]);
    expect(bundle.events.filter(event => event.type === "execution_failed" && event.payload.origin === "kernel")).toEqual([]);
    expect(bundle.events.filter(event => event.type === "execution_completed")).toEqual([]);
    expect(result.failure).toEqual({ kind: "timeout", origin: "device" });
    expect(bundle.events.every(event => event.source.simulated === false)).toBe(true);
    expect(bundle.kernelSignature.algorithm).toBe("ed25519");
    expect(nacl.sign.detached.verify(
      new TextEncoder().encode(bundle.bundleHash),
      fromHex(bundle.kernelSignature.value),
      fromHex(signer.publicKeyHex),
    )).toBe(true);
    expect(result.durationMs).toBeLessThan(timeoutMs + DEFAULT_CANCEL_WINDOW_MS);
    expect(printer.operationRequests(OP.CANCEL_JOB)).toHaveLength(1);
    expect(printer.operationRequests(OP.GET_JOB_ATTRIBUTES)).toHaveLength(2);
    expect(silentPollSignal?.aborted).toBe(true);
    expect(emitter.getEvents(jobId, "print")).toEqual([]);
    await vi.advanceTimersByTimeAsync(DEFAULT_CANCEL_WINDOW_MS);
    expect(result.events.filter(event => event.type === "execution_failed")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
