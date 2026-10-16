/** IPP binding parity: printer-job.ts:35-66, 144-153 and 232-280; payload.jobId stays PCC-owned (LO-EV-9). */
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";
import { isFabricated } from "@pcc/spec";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { makeKernelEd25519Signer, runPrintJob, type PrintJobResult } from "../printer-job.js";
import { FakeDevice, type FakeDeviceOptions } from "../testing/index.js";

const KERNEL = "kernel-fake-device-print-parity";
const DEVICE_JOB = 42;
const devices: FakeDevice[] = [];
let sequence = 0;

afterEach(async () => {
  for (const device of devices.splice(0)) await device.dispose();
});

function fixture(options: FakeDeviceOptions = {}) {
  const id = `fake-device-print-${++sequence}`;
  const device = new FakeDevice(id, KERNEL, { preset: "ipp", ...options });
  devices.push(device);
  const emitted: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
  device.onEvidence((event) => emitted.push(event));
  const signer = makeKernelEd25519Signer(new Uint8Array(32).fill(39));
  const jobId = `pcc-${id}`;
  return {
    device, emitted, jobId,
    options: {
      adapter: device, emitter: new EvidenceEmitter(KERNEL, signer.signFn),
      jobId, jobName: "invoice.pdf", totalPages: 3,
      timeoutMs: 40, cancelWindowMs: 250,
      evidenceQuiesceTimeoutMs: 250, evidenceSettleTimeoutMs: 250,
    },
  };
}

function assertBundle(result: PrintJobResult, types: EvidenceEvent["type"][], jobId: string): void {
  expect(result.bundle).toBeDefined();
  expect(result.events).toEqual(result.bundle!.events);
  expect(result.bundle!.events.map((event) => event.type)).toEqual(types);
  expect(result.bundle!.events.map((event) => event.payload.ippJobId)).toEqual(types.map(() => DEVICE_JOB));
  for (const event of result.bundle!.events) {
    expect(event.payload.jobId).toBe(jobId);
    expect(event.source.simulated).toBe(true);
    expect(event.payload.mock).toBe(true);
    expect(isFabricated(event)).toBe(true);
  }
}

function assertSuccess(result: PrintJobResult, f: ReturnType<typeof fixture>, types: EvidenceEvent["type"][]): void {
  expect(result.success).toBe(true);
  expect(result.failure).toBeUndefined();
  expect(result.cancelRequested).toBeUndefined();
  expect(result.busy).toBeUndefined();
  expect(result.error).toBeUndefined();
  expect(result.completion).toEqual({
    jobId: f.jobId, printerJobId: DEVICE_JOB, pageCount: 3,
    printerId: f.device.id, simulated: true, jobName: "invoice.pdf",
  });
  assertBundle(result, types, f.jobId);
  expect(f.device.cancels).toEqual([]);
}

describe("FakeDevice IPP preset runs the print contract", () => {
  it("success returns bound started, progress and completion evidence", async () => {
    const f = fixture();
    f.device.scriptStart({ outcome: "accept", deviceJobId: DEVICE_JOB });
    const pending = runPrintJob(f.options);
    await f.device.started();
    f.device.emit("execution_started", { totalPages: 3 });
    f.device.progress(50, { currentPage: 1 });
    f.device.complete({ totalPages: 3 });
    const result = await pending;
    assertSuccess(result, f, ["execution_started", "execution_progress", "execution_completed"]);
    expect(f.emitted.map((event) => event.payload.ippJobId)).toEqual([42, 42, 42]);
  });

  it("busy is a device refusal with no evidence or completion", async () => {
    const f = fixture();
    f.device.scriptStart({ outcome: "busy" });
    const result = await runPrintJob(f.options);
    expect(result.success).toBe(false);
    expect(result.failure).toBeUndefined();
    expect(result.cancelRequested).toBeUndefined();
    expect(result.busy).toEqual({ reason: "device", adapterId: f.device.id, jobId: f.jobId });
    expect(result.completion).toBeUndefined();
    expect(result.bundle).toBeUndefined();
    expect(result.events).toEqual([]);
    expect(f.emitted).toEqual([]);
    expect(f.device.cancels).toEqual([]);
    expect(result.error).toBe("device is busy");
  });

  const cancelScenarios = [
    { label: "report before resolve", cancelBehavior: "report", cancelEventOrder: "before-resolve" },
    { label: "report after resolve", cancelBehavior: "report", cancelEventOrder: "after-resolve" },
    { label: "silent confirmation deadline", cancelBehavior: "silent", cancelEventOrder: "before-resolve" },
  ] as const;
  for (const reason of ["timeout", "aborted"] as const) {
    it.each(cancelScenarios)(`${reason} with $label retains a device-origin signed failure`, async (scenario) => {
      const f = fixture({ cancelBehavior: scenario.cancelBehavior, cancelEventOrder: scenario.cancelEventOrder, cancelConfirmMs: 10 });
      f.device.scriptStart({ outcome: "accept", deviceJobId: DEVICE_JOB });
      const controller = new AbortController();
      const pending = runPrintJob({ ...f.options, ...(reason === "aborted" ? { signal: controller.signal } : {}) });
      await f.device.started();
      f.device.emit("execution_started", { totalPages: 3 });
      if (reason === "aborted") controller.abort();
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.failure).toEqual({ kind: reason, origin: "device" });
      expect(result.cancelRequested).toBe(reason);
      expect(result.busy).toBeUndefined();
      expect(result.completion).toBeUndefined();
      expect(result.error).toBe(reason === "timeout"
        ? `print job ${f.jobId} timed out after 40ms` : `print job ${f.jobId} aborted`);
      assertBundle(result, ["execution_started", "execution_failed"], f.jobId);
      expect(result.bundle!.events[1].payload.origin).toBe("device");
      expect(result.bundle!.events[1].payload.state).toBe(scenario.cancelBehavior === "silent" ? "processing" : "canceled");
      if (scenario.cancelBehavior === "silent") {
        expect(result.bundle!.events[1].payload.reason).toBe("cancel-unconfirmed");
      }
      expect(f.device.cancels).toEqual([42]);
    });
  }

  it("inside-start admits the pre-result started event exactly once after the id is known", async () => {
    const f = fixture({ startedEvent: "inside-start" });
    f.device.scriptStart({ outcome: "accept", deviceJobId: DEVICE_JOB });
    const pending = runPrintJob(f.options);
    await f.device.started();
    f.device.complete({ totalPages: 3 });
    assertSuccess(await pending, f, ["execution_started", "execution_completed"]);
    expect(f.emitted.filter((event) => event.type === "execution_started")).toHaveLength(1);
  });
});


describe("FakeDevice listener isolation reaches signed print evidence", () => {
  for (const mutation of ["delete", "false"] as const) {
    for (const timing of ["before tap", "after tap"] as const) {
      it.each(["success", "failure"] as const)(`${mutation} tags and origin ${timing} cannot corrupt %s evidence`, async (outcome) => {
        const f = fixture();
        const tamper = (event: Omit<EvidenceEvent, "id" | "hash">) => {
          if (mutation === "delete") {
            delete event.source.simulated;
            delete event.payload.mock;
            delete event.payload.origin;
          } else {
            event.source.simulated = false;
            event.payload.mock = false;
            event.payload.origin = false;
          }
        };
        const observed: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
        if (timing === "before tap") f.device.onEvidence(tamper);
        f.device.scriptStart({ outcome: "accept", deviceJobId: DEVICE_JOB });
        const pending = runPrintJob({ ...f.options, timeoutMs: 5_000 });
        await f.device.started();
        if (timing === "after tap") f.device.onEvidence(tamper);
        f.device.onEvidence((event) => observed.push(event));
        f.device.progress(50, { origin: "device" });
        if (outcome === "success") f.device.complete({ origin: "device" });
        else f.device.fail({ reason: "paper jam" });
        const result = await pending;
        expect(result.success).toBe(outcome === "success");
        if (outcome === "failure") expect(result.failure).toEqual({ kind: "device_reported", origin: "device" });
        const types: EvidenceEvent["type"][] = ["execution_progress", outcome === "success" ? "execution_completed" : "execution_failed"];
        assertBundle(result, types, f.jobId);
        expect(observed).toHaveLength(2);
        expect(f.emitted).toHaveLength(2);
        for (const event of [...observed, ...f.emitted, ...result.bundle!.events]) {
          expect(event.source.simulated).toBe(true);
          expect(event.payload.mock).toBe(true);
          expect(event.payload.origin).toBe("device");
          expect(isFabricated(event)).toBe(true);
        }
      });
    }
  }
});
