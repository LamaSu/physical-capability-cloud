/**
 * Every adapter's quiesceEvidence() (#502 round 3b): it resolves at once when the adapter
 * has nothing outstanding, only after the last event of the work it was given otherwise
 * (a job's terminal event, a stopped loop, a call in flight), and nothing is emitted after it.
 *
 * Every test runs on the fake clock; HTTP adapters talk to fakes whose responses resolve on
 * microtasks, so the clock alone decides when a poll lands.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";

import { createSensorAdapter } from "../adapter-factory.js";
import { HamiltonAdapter } from "../adapters/hamilton-adapter.js";
import { IppAdapter } from "../adapters/ipp-adapter.js";
import { MockCameraAdapter } from "../adapters/mock-camera.js";
import { MockFDMAdapter } from "../adapters/mock-fdm.js";
import { MockPowerMonitorAdapter } from "../adapters/mock-power-monitor.js";
import { ModbusSensorAdapter } from "../adapters/modbus-sensor-adapter.js";
import { OctoPrintAdapter } from "../adapters/octoprint-adapter.js";
import { OPCUAAdapter } from "../adapters/opcua-adapter.js";
import { OutstandingWork } from "../adapters/outstanding-work.js";
import { PhotoCameraAdapter } from "../adapters/photo-camera-adapter.js";
import { PrinterLogAdapter } from "../adapters/printer-log-adapter.js";
import { SiLAAdapter } from "../adapters/sila/sila-adapter.js";
import type { LogCaptureService } from "../log-capture-service.js";
import { OpentronsMachineAdapter } from "../opentrons/adapter.js";
import type { PhotoCaptureService } from "../photo-capture-service.js";
import { fakeOctoPrintServer, fakeResponse } from "./helpers/fake-octoprint-server.js";

type Emitted = Omit<EvidenceEvent, "id" | "hash">;
interface Hooked {
  onEvidence(callback: (event: Emitted) => void): void;
  quiesceEvidence(): Promise<void>;
}

const KERNEL_ID = "kernel-quiesce-test";
const HASH = `sha256:${"ab".repeat(32)}`;

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Every event the adapter emits, with the fake time it was emitted at. */
function record(adapter: Hooked): Array<{ type: string; at: number; payload: Record<string, unknown> }> {
  const events: Array<{ type: string; at: number; payload: Record<string, unknown> }> = [];
  adapter.onEvidence((e) => events.push({ type: e.type, at: Date.now(), payload: e.payload }));
  return events;
}

/** Ask the adapter to quiesce; note when the hook resolves, and which events it had emitted by then. */
function ask(adapter: Hooked, events: Array<{ type: string }>): { resolved: boolean; at?: number; seen?: string[] } {
  const state: { resolved: boolean; at?: number; seen?: string[] } = { resolved: false };
  void adapter.quiesceEvidence().then(() => {
    state.resolved = true;
    state.at = Date.now();
    state.seen = events.map((e) => e.type);
  });
  return state;
}

/** Whether the hook resolves without the clock moving. */
async function resolvesAtOnce(adapter: Hooked): Promise<boolean> {
  const state = ask(adapter, []);
  await vi.advanceTimersByTimeAsync(0);
  return state.resolved;
}

/** Nothing is emitted, and no request is made, once the clock runs on for a minute. */
async function expectSilenceAfter(events: unknown[], requests?: unknown[]): Promise<void> {
  const emitted = events.length;
  const requested = requests?.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(events.length, "events emitted after the hook resolved").toBe(emitted);
  if (requests) expect(requests.length, "requests made after the hook resolved").toBe(requested);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(0); // times below are from the start of each test
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OutstandingWork", () => {
  it("idle() resolves at once when nothing is outstanding, else when the last piece ends; end() is idempotent; track() ends on settle", async () => {
    const work = new OutstandingWork();
    let first = false;
    void work.idle().then(() => (first = true));
    await Promise.resolve();
    expect(first).toBe(true);

    const end = work.begin();
    const held = deferred();
    const tracked = work.track(held.promise);
    let second = false;
    void work.idle().then(() => (second = true));
    end();
    end(); // idempotent: does not end the tracked promise's count
    await Promise.resolve();
    expect([work.size, second]).toEqual([1, false]);
    held.resolve();
    await tracked;
    await Promise.resolve();
    expect([work.size, second]).toEqual([0, true]);

    const rejected = work.track(Promise.reject(new Error("no")));
    await expect(rejected).rejects.toThrow("no");
    expect(work.size).toBe(0);
  });
});

describe("MockFDMAdapter", () => {
  it("resolves at once when idle; after start, only once execution_completed is emitted; nothing after", async () => {
    const fdm = new MockFDMAdapter("fdm-q", KERNEL_ID, 2_000); // 20 ticks of 100 ms
    const events = record(fdm);
    expect(await resolvesAtOnce(fdm)).toBe(true);

    await fdm.execute({ type: "load_gcode", payload: { gcodeHash: HASH } });
    await fdm.execute({ type: "start" });
    const hook = ask(fdm, events);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(hook.resolved, "before the simulated execution completes").toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(hook).toMatchObject({ resolved: true, at: 2_000 });
    expect(hook.seen?.at(-1)).toBe("execution_completed");
    await expectSilenceAfter(events);
  });

  it.each(["pause", "stop"] as const)("resolves once a running execution is stopped by %s, and emits nothing after", async (command) => {
    const fdm = new MockFDMAdapter("fdm-q-stop", KERNEL_ID, 2_000);
    const events = record(fdm);
    await fdm.execute({ type: "load_gcode", payload: { gcodeHash: HASH } });
    await fdm.execute({ type: "start" });
    const hook = ask(fdm, events);
    await vi.advanceTimersByTimeAsync(600);
    expect(hook.resolved).toBe(false);

    await fdm.execute({ type: command });
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.resolved).toBe(true);
    expect(events.map((e) => e.type)).not.toContain("execution_completed");
    await expectSilenceAfter(events);
  });
});

describe("OctoPrintAdapter", () => {
  const realOctoPrint = (id: string) => new OctoPrintAdapter(id, { url: "http://octoprint.test", apiKey: "k", kernelId: KERNEL_ID, pollIntervalMs: 2_000 });

  it("(real mode) resolves only once its poll loop has reported the completion and stopped; no event or poll after", async () => {
    const server = fakeOctoPrintServer(5_000);
    vi.stubGlobal("fetch", server.fetch);
    const octo = realOctoPrint("octo-q");
    const events = record(octo);
    expect(await resolvesAtOnce(octo)).toBe(true);

    await octo.execute({ type: "load_gcode", payload: { filename: "part.gcode" } });
    await octo.execute({ type: "start" }); // the print finishes at t = 5000
    const hook = ask(octo, events);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(hook.resolved, "the printer has finished, but no poll has seen it").toBe(false);
    await vi.advanceTimersByTimeAsync(1); // the poll at 6000

    expect(hook).toMatchObject({ resolved: true, at: 6_000 });
    // Progress at 96% (poll at 4000), then at 100% and the completion (poll at 6000).
    expect(hook.seen).toEqual(["gcode_received", "execution_started", "execution_progress", "execution_progress", "execution_completed"]);
    expect(events.at(-1)?.payload).toMatchObject({ jobName: "part.gcode" });
    await expectSilenceAfter(events, server.requests);
  });

  it("(real mode) a print cancelled at the printer: the loop reports execution_failed, stops, and the hook resolves", async () => {
    const server = fakeOctoPrintServer(5_000);
    vi.stubGlobal("fetch", server.fetch);
    const octo = realOctoPrint("octo-q-cancel");
    const events = record(octo);
    await octo.execute({ type: "load_gcode", payload: { filename: "part.gcode" } });
    await octo.execute({ type: "start" });
    const hook = ask(octo, events);
    await vi.advanceTimersByTimeAsync(2_100); // the poll at 2000 saw it printing
    server.cancel();
    await vi.advanceTimersByTimeAsync(1_899);
    expect(hook.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // the poll at 4000

    expect(hook).toMatchObject({ resolved: true, at: 4_000 });
    expect(events.at(-1)).toMatchObject({ type: "execution_failed", payload: { jobName: "part.gcode", state: "Operational" } });
    await expectSilenceAfter(events, server.requests);
  });

  it("(real mode) waits for a poll still in flight when the loop is stopped", async () => {
    const server = fakeOctoPrintServer(5_000);
    vi.stubGlobal("fetch", server.fetch);
    const octo = realOctoPrint("octo-q-inflight");
    const events = record(octo);
    await octo.execute({ type: "load_gcode", payload: { filename: "part.gcode" } });
    await octo.execute({ type: "start" });
    const release = server.hold("GET /api/printer");
    await vi.advanceTimersByTimeAsync(2_000); // the poll at 2000 is now waiting on the printer
    expect(server.isPending("GET /api/printer")).toBe(true);

    await octo.execute({ type: "stop" }); // the loop is stopped; its poll is not finished
    const hook = ask(octo, events);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hook.resolved, "a poll is in flight").toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.resolved).toBe(true);
    await expectSilenceAfter(events);
  });

  it("(mock mode) resolves at once: it emits only inside its commands", async () => {
    const octo = new OctoPrintAdapter("octo-q-mock", { url: "http://octoprint.test", apiKey: "k", kernelId: KERNEL_ID, mockMode: true });
    const events = record(octo);
    await octo.execute({ type: "load_gcode", payload: { gcodeHash: HASH } });
    await octo.execute({ type: "start" });
    expect(await resolvesAtOnce(octo)).toBe(true);
    await expectSilenceAfter(events);
  });
});

describe("IppAdapter", () => {
  it("(mock mode) resolves only once the job's execution_completed is emitted; nothing after", async () => {
    const ipp = new IppAdapter("ipp-q", { uri: "ipp://printer.test/ipp/print", kernelId: KERNEL_ID, mockMode: true });
    const events = record(ipp);
    expect(await resolvesAtOnce(ipp)).toBe(true);

    await ipp.execute({ type: "start", payload: { totalPages: 3 } }); // pages at 500, 1700, 2900
    const hook = ask(ipp, events);
    await vi.advanceTimersByTimeAsync(2_899);
    expect(hook.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(hook).toMatchObject({ resolved: true, at: 2_900 });
    expect(hook.seen?.at(-1)).toBe("execution_completed");
    await expectSilenceAfter(events);
  });

  // astra pack 185: a page count that is not a positive integer began the job's work and then
  // never ended it (0 or less: the first page returned at once) or never finished (NaN,
  // Infinity: pages forever), so the hook never answered and the device was held for good.
  it.each([
    ["zero", 0],
    ["negative", -2],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("(mock mode) a %s page count is refused before the job is accepted: the hook answers, and nothing runs on", async (_label, totalPages) => {
    const ipp = new IppAdapter("ipp-q-pages", { uri: "ipp://printer.test/ipp/print", kernelId: KERNEL_ID, mockMode: true });
    const events = record(ipp);
    const result = await ipp.execute({ type: "start", payload: { totalPages } });
    expect.soft(result, "start").toMatchObject({ success: false, message: `totalPages must be a positive integer (got ${String(totalPages)})` });
    await vi.advanceTimersByTimeAsync(10_000);
    const hook = ask(ipp, events);
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(hook.resolved, "the hook, 10 s after the start").toBe(true);
    expect.soft(events.map((e) => e.type), "events").toEqual([]);
    expect.soft(vi.getTimerCount(), "timers left").toBe(0);
  });

  // The rest of the fix's domain: these terminate today, but a page count is a positive integer.
  it.each([
    ["fractional", 1.5],
    ["string", "3"],
  ])("(mock mode) a %s page count is refused too; an absent one still defaults to 3 pages", async (_label, totalPages) => {
    const ipp = new IppAdapter("ipp-q-pages-domain", { uri: "ipp://printer.test/ipp/print", kernelId: KERNEL_ID, mockMode: true });
    expect(await ipp.execute({ type: "start", payload: { totalPages } })).toMatchObject({ success: false });
    expect(await ipp.execute({ type: "start" })).toMatchObject({ success: true });
  });

  it("(mock mode) a paused job keeps it pending, since it can be resumed; cancelling it resolves it", async () => {
    const ipp = new IppAdapter("ipp-q-pause", { uri: "ipp://printer.test/ipp/print", kernelId: KERNEL_ID, mockMode: true });
    const events = record(ipp);
    await ipp.execute({ type: "start", payload: { totalPages: 3 } });
    await vi.advanceTimersByTimeAsync(600); // page 1 printed
    await ipp.execute({ type: "pause" });
    const hook = ask(ipp, events);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hook.resolved, "paused").toBe(false);

    await ipp.execute({ type: "stop" });
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.resolved).toBe(true);
    await expectSilenceAfter(events);
  });

  it("(real mode) resolves only once the poll loop has reported the completion and stopped", async () => {
    const ipp = new IppAdapter("ipp-q-real", { uri: "ipp://printer.test/ipp/print", kernelId: KERNEL_ID, mockMode: false, pollIntervalMs: 2_000 });
    await vi.dynamicImportSettled(); // the optional 'ipp' package is not installed: it routes to mock, then we inject a client
    const requests: string[] = [];
    let jobDoneAt = Number.POSITIVE_INFINITY;
    class Printer {
      execute(op: string, _msg: unknown, _data: unknown, cb: (err: Error | null, res: Record<string, unknown>) => void) {
        requests.push(op);
        if (op === "Print-Job") {
          jobDoneAt = Date.now() + 5_000;
          queueMicrotask(() => cb(null, { "job-attributes-tag": { "job-id": 77 } }));
        } else if (op === "Get-Job-Attributes") {
          const done = Date.now() >= jobDoneAt;
          queueMicrotask(() => cb(null, { "job-attributes-tag": { "job-state": done ? 9 : 5, "job-impressions-completed": done ? 3 : 1 } }));
        } else queueMicrotask(() => cb(null, {}));
      }
    }
    Object.assign(ipp, { ippClient: { Printer }, ippAvailable: true });
    const events = record(ipp);

    await ipp.execute({ type: "start", payload: { documentData: "%PDF-1.4", jobName: "doc" } });
    const hook = ask(ipp, events);
    await vi.advanceTimersByTimeAsync(5_999); // polls at 2000 and 4000: processing
    expect(hook.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // the poll at 6000: completed

    expect(hook).toMatchObject({ resolved: true, at: 6_000 });
    expect(hook.seen).toEqual(["execution_started", "execution_progress", "execution_progress", "execution_completed"]);
    await expectSilenceAfter(events, requests);
  });
});

describe("HamiltonAdapter", () => {
  it("(mock mode) resolves only once the run's execution_completed is emitted", async () => {
    const ham = new HamiltonAdapter("ham-q", { url: "http://hamilton.test", username: "u", password: "p", kernelId: KERNEL_ID, mockMode: true, mockRunDurationMs: 2_000 });
    const events = record(ham);
    expect(await resolvesAtOnce(ham)).toBe(true);
    await ham.execute({ type: "load_gcode", payload: { protocolId: "p1" } });
    await ham.execute({ type: "start" });
    const hook = ask(ham, events);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(hook.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(hook).toMatchObject({ resolved: true, at: 2_000 });
    expect(hook.seen?.at(-1)).toBe("execution_completed");
    await expectSilenceAfter(events);
  });

  it.each([
    ["Complete", "execution_completed"],
    ["Error", "execution_failed"],
  ] as const)("(real mode) a run the API reports %s: the loop emits %s, stops, and the hook resolves", async (status, terminal) => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/v1/authenticate") return fakeResponse(200, { token: "t", expiresIn: 60, userId: "u" });
      if (path === "/api/v1/protocols/p1") return fakeResponse(200, { name: "P1" });
      if (path === "/api/v1/protocol-run/create") return fakeResponse(200, { runId: "r1" });
      if (path === "/api/v1/protocol-run") return fakeResponse(200, { status: Date.now() >= 7_000 ? status : "Running" });
      return fakeResponse(404, null);
    });
    const ham = new HamiltonAdapter("ham-q-real", { url: "http://hamilton.test", username: "u", password: "p", kernelId: KERNEL_ID, pollIntervalMs: 3_000 });
    const events = record(ham);
    await ham.execute({ type: "load_gcode", payload: { protocolId: "p1" } });
    await ham.execute({ type: "start" });
    const hook = ask(ham, events);
    await vi.advanceTimersByTimeAsync(8_999); // polls at 3000 and 6000: running
    expect(hook.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // the poll at 9000

    expect(hook).toMatchObject({ resolved: true, at: 9_000 });
    expect(hook.seen?.at(-1)).toBe(terminal);
    await expectSilenceAfter(events, requests);
  });
});

describe("OPCUAAdapter", () => {
  const opcua = (id: string, mockMode: boolean) =>
    new OPCUAAdapter(id, { endpoint: "opc.tcp://cnc.test:4840", kernelId: KERNEL_ID, machineType: "cnc-3axis", nodeMap: [], pollIntervalMs: 100, mockMode });

  it("(mock mode) resolves only once the execution loop has emitted execution_completed and stopped", async () => {
    const cnc = opcua("opcua-q", true);
    const events = record(cnc);
    expect(await resolvesAtOnce(cnc)).toBe(true);
    await cnc.execute({ type: "load_gcode", payload: { filename: "part.nc" } });
    await cnc.execute({ type: "start" }); // +2% per 100 ms: complete at 5000
    const hook = ask(cnc, events);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(hook.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(hook).toMatchObject({ resolved: true, at: 5_000 });
    expect(hook.seen?.at(-1)).toBe("execution_completed");
    await expectSilenceAfter(events);
  });

  it("(real mode) resolves at once: no command acts, and nothing is emitted", async () => {
    const cnc = opcua("opcua-q-real", false);
    const events = record(cnc);
    expect((await cnc.execute({ type: "start" })).success).toBe(false);
    expect(await resolvesAtOnce(cnc)).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("OpentronsMachineAdapter", () => {
  it("(mock mode) resolves only once run_completed is emitted; a second start replaces the first run instead of leaking it", async () => {
    const ot = new OpentronsMachineAdapter("ot2-q", { url: "http://ot2.test:31950", mockMode: true });
    const events = record(ot);
    expect(await resolvesAtOnce(ot)).toBe(true);
    await ot.execute({ type: "load_gcode" });
    await ot.execute({ type: "start" });
    await vi.advanceTimersByTimeAsync(3_000);
    await ot.execute({ type: "start" }); // the second run, at 3000: completes at 13000
    const hook = ask(ot, events);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(hook.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(hook).toMatchObject({ resolved: true, at: 13_000 });
    expect(hook.seen?.filter((t) => t === "run_completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "run_progress")).toHaveLength(3 + 10);
    await expectSilenceAfter(events);
  });

  it("(real mode) waits for a command in flight, which emits before it returns", async () => {
    const upload = deferred();
    vi.stubGlobal("fetch", async (url: string) => {
      if (new URL(url).pathname === "/protocols") {
        await upload.promise;
        return fakeResponse(200, { data: { id: "proto-1" } });
      }
      return fakeResponse(404, null);
    });
    const ot = new OpentronsMachineAdapter("ot2-q-real", { url: "http://ot2.test:31950" });
    const events = record(ot);
    const loading = ot.execute({ type: "load_gcode", payload: { protocolSource: "from opentrons import protocol_api" } });
    const hook = ask(ot, events);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hook.resolved).toBe(false);
    upload.resolve();
    await loading;
    await vi.advanceTimersByTimeAsync(0);
    expect(hook).toMatchObject({ resolved: true, seen: ["protocol_uploaded"] });
    await expectSilenceAfter(events);
  });
});

describe("MockCameraAdapter", () => {
  it("resolves at once when idle, and only after an inspection in flight has emitted its events", async () => {
    const cam = new MockCameraAdapter("cam-q", KERNEL_ID);
    const events = record(cam);
    expect(await resolvesAtOnce(cam)).toBe(true);
    const inspecting = cam.runInspection();
    const hook = ask(cam, events);
    expect(hook.resolved).toBe(false);
    await inspecting;
    await vi.advanceTimersByTimeAsync(0);
    expect(hook).toMatchObject({ resolved: true, seen: ["camera_snapshot", "cv_inspection_result"] });
    await expectSilenceAfter(events);
  });
});

describe("PhotoCameraAdapter", () => {
  it("resolves only after a capture in flight (waiting on the capture service) has emitted camera_snapshot", async () => {
    const captured = deferred<Awaited<ReturnType<PhotoCaptureService["capture"]>>>();
    const service = { capture: () => captured.promise } as unknown as PhotoCaptureService;
    const cam = new PhotoCameraAdapter("photo-q", KERNEL_ID, service);
    const events = record(cam);
    expect(await resolvesAtOnce(cam)).toBe(true);
    cam.setNextCapture(new Uint8Array([1, 2, 3]));
    const capturing = cam.captureSnapshot();
    const hook = ask(cam, events);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hook.resolved).toBe(false);
    captured.resolve({ imageHash: HASH, storageCid: "", rawSizeBytes: 3, exif: {}, antiSpoofScore: 1, antiSpoofChecks: [] } as never);
    await capturing;
    await vi.advanceTimersByTimeAsync(0);
    expect(hook).toMatchObject({ resolved: true, seen: ["camera_snapshot"] });
    await expectSilenceAfter(events);
  });
});

describe("MockPowerMonitorAdapter", () => {
  it("pending while recording; resolves once stopRecording has stopped the sampling and emitted the summary; nothing after", async () => {
    const power = new MockPowerMonitorAdapter("power-q", KERNEL_ID);
    const events = record(power);
    expect(await resolvesAtOnce(power)).toBe(true);
    await power.startRecording("job-q");
    const hook = ask(power, events);
    await vi.advanceTimersByTimeAsync(5_000); // samples at 2000 and 4000
    expect(hook.resolved).toBe(false);
    await power.stopRecording();
    await vi.advanceTimersByTimeAsync(0);
    expect(hook).toMatchObject({ resolved: true, seen: ["power_profile_sample", "power_profile_sample", "power_profile_summary"] });
    await expectSilenceAfter(events);
  });

  it("a second startRecording replaces the first recording instead of leaking its timer", async () => {
    const power = new MockPowerMonitorAdapter("power-q-twice", KERNEL_ID);
    const events = record(power);
    await power.startRecording("job-1");
    await power.startRecording("job-2");
    await power.stopRecording();
    expect(await resolvesAtOnce(power)).toBe(true);
    await expectSilenceAfter(events);
    expect(events.map((e) => e.type)).toEqual(["power_profile_summary"]);
  });
});

describe("ModbusSensorAdapter", () => {
  it("(mock mode) pending while its poll timer runs; resolves once stopRecording stops it; it emits no evidence through onEvidence", async () => {
    const modbus = new ModbusSensorAdapter("modbus-q", {
      host: "plc.test",
      kernelId: KERNEL_ID,
      mockMode: true,
      pollIntervalMs: 500,
      registerMap: [{ channel: "power", label: "Power", address: 0, registerType: "holding", dataType: "float32", unit: "W" }],
    });
    const events = record(modbus);
    expect(await resolvesAtOnce(modbus)).toBe(true);
    await modbus.startRecording("job-q");
    const hook = ask(modbus, events);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(hook.resolved).toBe(false);
    await modbus.stopRecording();
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.resolved).toBe(true);
    await expectSilenceAfter(events);
    expect(events).toEqual([]);
  });
});

describe("PrinterLogAdapter", () => {
  it("waits for a poll the timer started before stopRecording, which emits after stopRecording returned; nothing after", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const timerPoll = deferred();
    let calls = 0;
    const logProvider = async () => {
      calls += 1;
      if (calls === 2) await timerPoll.promise; // the timer's first poll waits on the log source
      return lines.shift() ?? null;
    };
    let n = 0;
    const chain: Array<{ entryHash: string; previousHash: string }> = [];
    const logCapture = {
      reset: () => void (chain.length = 0),
      getChain: () => chain,
      captureEntry: async (rawContent: string) => {
        const entry = { entryId: `e${++n}`, entryHash: `h${n}`, previousHash: `h${n - 1}`, rawContent, capturedAt: new Date().toISOString(), kernelSignature: "sig" };
        chain.push(entry);
        return entry;
      },
    } as unknown as LogCaptureService;
    const log = new PrinterLogAdapter("log-q", KERNEL_ID, logCapture, { pollIntervalMs: 1_000, logProvider });
    const events = record(log);
    expect(await resolvesAtOnce(log)).toBe(true);

    await log.startRecording("job-q"); // polls line 1 at once
    await vi.advanceTimersByTimeAsync(1_000); // the timer's poll is now waiting on the log source
    await log.stopRecording(); // its final poll takes line 2, then it emits the summary and returns
    const hook = ask(log, events);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hook.resolved, "the timer's poll is still in flight").toBe(false);
    timerPoll.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(hook.resolved).toBe(true);
    expect(hook.seen).toEqual(["log_hash_chain_entry", "log_hash_chain_entry", "printer_job_verified", "log_hash_chain_entry"]);
    expect(events.at(-1)?.payload).toMatchObject({ rawContent: "line 3" });
    await expectSilenceAfter(events);
  });
});

describe("SiLA", () => {
  it("SiLAAdapter resolves only after an assay in flight has emitted its events; the factory's sensor shim delegates to it", async () => {
    const sila = new SiLAAdapter({ deviceId: "sila-q", kernelId: KERNEL_ID, mock: true });
    const events = record(sila);
    expect(await resolvesAtOnce(sila)).toBe(true);
    const assay = sila.executeAssay({ assayName: "a", protocolId: "p", plateFormat: 96, sampleCount: 2, replicates: 1, qcCriteria: { maxCV: 20, minR2: 0.5, minZPrime: 0 } });
    const hook = ask(sila, events);
    expect(hook.resolved).toBe(false);
    await assay;
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.resolved).toBe(true);
    expect(hook.seen?.at(-1)).toBe("execution_completed");
    await expectSilenceAfter(events);

    const shim = createSensorAdapter({ id: "sila-shim-q", type: "sensor", adapterType: "sila", config: { mock: true, kernelId: KERNEL_ID } });
    await shim.startRecording("job-q");
    await shim.stopRecording();
    expect(await resolvesAtOnce(shim)).toBe(true);
  });
});
