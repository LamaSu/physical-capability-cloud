/**
 * The onboarding templates' quiesceEvidence() (#502 round 3b): at once when the adapter has
 * nothing outstanding; otherwise only after the last event of the work it was given (the
 * loop's terminal event and its stop, a recording's stop and the reads in flight, a capture
 * in flight), and nothing is emitted after it. On the fake clock, with fetch faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenericCameraAdapter } from "../templates/generic-camera-adapter.js";
import { GenericHttpAdapter, type GenericHttpAdapterConfig } from "../templates/generic-http-adapter.js";
import { GenericSensorAdapter } from "../templates/generic-sensor-adapter.js";

interface Hooked {
  onEvidence(callback: (event: { type: string }) => void): void;
  quiesceEvidence(): Promise<void>;
}

function record(adapter: Hooked): string[] {
  const events: string[] = [];
  adapter.onEvidence((e) => events.push(e.type));
  return events;
}

function ask(adapter: Hooked, events: string[]): { resolved: boolean; at?: number; seen?: string[] } {
  const state: { resolved: boolean; at?: number; seen?: string[] } = { resolved: false };
  void adapter.quiesceEvidence().then(() => {
    state.resolved = true;
    state.at = Date.now();
    state.seen = [...events];
  });
  return state;
}

async function resolvesAtOnce(adapter: Hooked): Promise<boolean> {
  const state = ask(adapter, []);
  await vi.advanceTimersByTimeAsync(0);
  return state.resolved;
}

async function expectSilenceAfter(events: string[]): Promise<void> {
  const emitted = events.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(events.length, "events emitted after the hook resolved").toBe(emitted);
}

/** A fetch Response whose body resolves on a microtask. */
const respond = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const httpConfig = (mockMode: boolean): GenericHttpAdapterConfig => ({
  baseUrl: "http://device.test",
  kernelId: "kernel-q",
  machineType: "fdm",
  endpoints: {
    status: { method: "GET", path: "/status" },
    progress: { method: "GET", path: "/progress" },
    loadProgram: { method: "POST", path: "/load" },
    start: { method: "POST", path: "/start" },
    stop: { method: "POST", path: "/stop" },
  },
  statusMapping: { statusField: "state", map: { ready: "idle", running: "busy", error: "error" }, default: "idle" },
  progressMapping: { progressField: "percent" },
  pollIntervalMs: 1_000,
  mockMode,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GenericHttpAdapter", () => {
  it("(mock mode) resolves at once when idle, and after start only once the simulated completion is emitted", async () => {
    const http = new GenericHttpAdapter("http-q", httpConfig(true));
    const events = record(http);
    expect(await resolvesAtOnce(http)).toBe(true);
    await http.execute({ type: "start" }); // +10% per 500 ms: complete at 5000
    const hook = ask(http, events);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(hook.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(hook).toMatchObject({ resolved: true, at: 5_000 });
    expect(hook.seen?.at(-1)).toBe("execution_completed");
    await expectSilenceAfter(events);
  });

  it.each([
    ["reaches 100%", { percent: 100, state: "running" }, "execution_completed"],
    ["reports error", { percent: 40, state: "error" }, "execution_failed"],
  ] as const)("(real mode) resolves only once the poll loop has reported that the device %s, and stopped", async (_how, finalState, terminal) => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push(url);
      const done = Date.now() >= 2_500;
      const body = done ? finalState : { percent: 30, state: "running" };
      return respond(body);
    });
    const http = new GenericHttpAdapter("http-q-real", httpConfig(false));
    const events = record(http);
    await http.execute({ type: "start" });
    const hook = ask(http, events);
    await vi.advanceTimersByTimeAsync(2_999); // polls at 1000 and 2000
    expect(hook.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // the poll at 3000
    expect(hook).toMatchObject({ resolved: true, at: 3_000 });
    expect(hook.seen?.at(-1)).toBe(terminal);
    const polled = requests.length;
    await expectSilenceAfter(events);
    expect(requests.length, "requests after the loop stopped").toBe(polled);
  });
});

describe("GenericSensorAdapter", () => {
  it("pending while recording; resolves once stopRecording has stopped the sampling and the read in flight has emitted", async () => {
    let held: (() => void) | null = null;
    vi.stubGlobal("fetch", async () => {
      if (Date.now() >= 2_000) await new Promise<void>((resolve) => (held = resolve)); // the read at 2000 waits on the device
      return respond({ watts: 120 });
    });
    const sensor = new GenericSensorAdapter("sensor-q", {
      readingUrl: "http://device.test/reading",
      kernelId: "kernel-q",
      channel: "power",
      unit: "W",
      sensorType: "power_monitor",
      valueField: "watts",
      sampleIntervalMs: 1_000,
    });
    const events = record(sensor);
    expect(await resolvesAtOnce(sensor)).toBe(true);
    await sensor.startRecording("job-q");
    await vi.advanceTimersByTimeAsync(2_000); // a sample at 1000; the read at 2000 is in flight
    await sensor.stopRecording();
    const hook = ask(sensor, events);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hook.resolved, "the read the timer started is still in flight").toBe(false);
    held!();
    await vi.advanceTimersByTimeAsync(0);
    expect(hook).toMatchObject({ resolved: true, seen: ["power_profile_sample", "power_profile_sample"] });
    await expectSilenceAfter(events);
  });
});

describe("GenericCameraAdapter", () => {
  it("resolves at once when idle, and only after a capture in flight has emitted camera_snapshot", async () => {
    let answer: (() => void) | null = null;
    vi.stubGlobal("fetch", async () => {
      await new Promise<void>((resolve) => (answer = resolve));
      return respond({ hash: "sha256:abc", url: "https://images.test/abc.png" });
    });
    const camera = new GenericCameraAdapter("camera-q", { captureUrl: "http://device.test/capture", kernelId: "kernel-q", imageHashField: "hash", storageRefField: "url" });
    const events = record(camera);
    expect(await resolvesAtOnce(camera)).toBe(true);
    const capturing = camera.captureSnapshot();
    const hook = ask(camera, events);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hook.resolved).toBe(false);
    answer!();
    await capturing;
    await vi.advanceTimersByTimeAsync(0);
    expect(hook).toMatchObject({ resolved: true, seen: ["camera_snapshot"] });
    await expectSilenceAfter(events);
  });
});
