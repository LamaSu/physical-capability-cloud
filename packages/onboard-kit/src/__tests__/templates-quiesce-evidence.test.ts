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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold } from "../scaffolder.js";
import type { OnboardConfig } from "../types.js";

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

/** The sensor adapter the scaffolder generates, written to a scratch file and imported. */
async function scaffoldedSensorClass(): Promise<{ Sensor: new (id: string, config: { readingUrl: string; sampleIntervalMs?: number }) => SensorLike; cleanup: () => void }> {
  const config = {
    kernel: { kernelId: "kernel-q", name: "Q", location: { lat: 0, lng: 0 }, walletPrivateKeyEnvVar: "K", gatewayUrl: "http://gw.test", httpPort: 3100 },
    adapters: [{ adapterId: "dev-sensor-q", className: "QSensor", adapterType: "sensor", protocol: "http", connectionString: "http://device.test", deviceType: "sensor", firmwareVersion: "Q-1.0.0" }],
    capabilities: [],
  } as unknown as OnboardConfig;
  const file = scaffold({ config }).files.find((f) => f.path === "src/adapters/q-sensor.ts");
  if (!file) throw new Error("the scaffolder generated no src/adapters/q-sensor.ts");
  const dir = mkdtempSync(join(tmpdir(), "scaffolded-sensor-"));
  const path = join(dir, "q-sensor.ts");
  writeFileSync(path, file.content);
  const mod = (await import(path)) as { QSensor: new (id: string, config: { readingUrl: string; sampleIntervalMs?: number }) => SensorLike };
  return { Sensor: mod.QSensor, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface SensorLike extends Hooked {
  startRecording(jobId: string): Promise<void>;
  stopRecording(): Promise<{ payload: Record<string, unknown> }>;
  onEvidence(callback: (event: { type: string; payload: Record<string, unknown> }) => void): void;
}

/**
 * astra pack 186 (MEDIUM): starting a recording replaces the one running, but a read the old
 * recording started could resume afterwards, append to the new recording's samples, and emit
 * under the old job while the new one records. Job 1's read is held while job 2 starts.
 */
async function replacementLeaks(sensor: SensorLike): Promise<{ summary: Record<string, unknown>; afterJob2: Array<Record<string, unknown>> }> {
  const afterJob2: Array<Record<string, unknown>> = [];
  let job2Started = false;
  sensor.onEvidence((e) => {
    if (job2Started) afterJob2.push(e.payload);
  });
  await sensor.startRecording("job-1");
  await vi.advanceTimersByTimeAsync(1_000); // job 1's first read is in flight, held
  job2Started = true;
  await sensor.startRecording("job-2");
  releaseHeld();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1_000); // job 2's own read
  const summary = (await sensor.stopRecording()).payload;
  await vi.advanceTimersByTimeAsync(0);
  return { summary, afterJob2 };
}

let releaseHeld: () => void = () => {};

/** A device whose first reading (job 1's) is held until released and reads 111; every later one reads 222. */
function stubHeldFirstRead(field: string): void {
  let reads = 0;
  vi.stubGlobal("fetch", async () => {
    reads += 1;
    if (reads === 1) {
      await new Promise<void>((resolve) => (releaseHeld = resolve));
      return respond({ [field]: 111 });
    }
    return respond({ [field]: 222 });
  });
}

describe("astra pack 186 MEDIUM: a replaced recording keeps nothing of the old one", () => {
  it("GenericSensorAdapter: job 1's read, resumed after job 2 started, is in neither job 2's summary nor its window", async () => {
    stubHeldFirstRead("watts");
    const sensor = new GenericSensorAdapter("sensor-replace", {
      readingUrl: "http://device.test/reading",
      kernelId: "kernel-q",
      channel: "power",
      unit: "W",
      sensorType: "power_monitor",
      valueField: "watts",
      sampleIntervalMs: 1_000,
    }) as unknown as SensorLike;
    const { summary, afterJob2 } = await replacementLeaks(sensor);
    expect.soft((summary.samples as Array<{ value: number }>).map((s) => s.value), "job 2's samples").toEqual([222]);
    expect.soft(afterJob2.map((p) => p.jobId), "jobIds emitted after job 2 started").toEqual(["job-2"]);
  });

  it("the scaffolded sensor adapter: the same", async () => {
    stubHeldFirstRead("value");
    const { Sensor, cleanup } = await scaffoldedSensorClass();
    try {
      const sensor = new Sensor("dev-sensor-q", { readingUrl: "http://device.test/reading", sampleIntervalMs: 1_000 });
      const { summary, afterJob2 } = await replacementLeaks(sensor);
      expect.soft((summary.samples as Array<{ value: number }>).map((s) => s.value), "job 2's samples").toEqual([222]);
      expect.soft(afterJob2.map((p) => p.jobId), "jobIds emitted after job 2 started").toEqual(["job-2"]);
    } finally {
      cleanup();
    }
  });
});
