/** Module-load timer capture mirrors print-host/test/fake-silent-deadline.test.ts. */
import { beforeAll, expect, it, vi } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";
import type { FakeDevice } from "../testing/fake-device.js";

type Emitted = Omit<EvidenceEvent, "id" | "hash">;
let WarmedDevice: typeof FakeDevice;

// Load transforms outside each test's budget; resetModules still re-evaluates
// timer capture in tests that install fake timers before their fresh import.
vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  const module = await import("../testing/fake-device.js");
  WarmedDevice = module.FakeDevice;
}, 30_000);

it("repeated silent cancels retain the first deadline", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  let device: FakeDevice | undefined;
  try {
    const { FakeDevice: ScheduledDevice } = await import("../testing/fake-device.js");
    device = new ScheduledDevice("first-deadline", "timer-kernel", { cancelBehavior: "silent", cancelConfirmMs: 100 });
    device.scriptStart({ outcome: "accept", deviceJobId: 125 });
    await device.execute({ type: "start" });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    let idle = false;
    const quiescent = device.quiesceEvidence().then(() => { idle = true; });
    await device.cancelJob(125);
    await vi.advanceTimersByTimeAsync(60);
    await device.cancelJob(125);
    await vi.advanceTimersByTimeAsync(39);
    expect(events, "the first cancel deadline has not yet elapsed").toHaveLength(0);
    expect(await device.getStatus()).toBe("busy");
    expect(idle).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(events, "a repeated cancel must not extend the first deadline").toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "execution_failed", payload: { deviceJobId: 125, reason: "cancel-unconfirmed", origin: "device" } });
    expect(events[0].source.simulated).toBe(true);
    expect(events[0].payload.mock).toBe(true);
    await quiescent;
    expect(await device.getStatus()).toBe("idle");
    await vi.advanceTimersByTimeAsync(60);
    expect(events, "a repeated cancel must not schedule a second report").toHaveLength(1);
    expect(device.cancels).toEqual([125, 125]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await device?.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  }
});

it.each(["silent", "report"] as const)("dispose clears every captured %s timer and emits nothing", async (cancelBehavior) => {
  vi.resetModules();
  vi.useFakeTimers();
  let device: FakeDevice | undefined;
  try {
    const { FakeDevice: ScheduledDevice } = await import("../testing/fake-device.js");
    device = new ScheduledDevice("disposed-timers", "timer-kernel", { cancelBehavior, cancelEventOrder: "after-resolve", cancelConfirmMs: 100 });
    device.scriptStart({ outcome: "accept", deviceJobId: "active" });
    await device.execute({ type: "start" });
    await device.started();
    const started = expect(device.started()).rejects.toThrow("disposed");
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    await device.cancelJob("active");
    expect(vi.getTimerCount()).toBe(1);
    let idle = false;
    const quiescent = device.quiesceEvidence().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    await device.dispose();
    expect(vi.getTimerCount(), "dispose must clear the timer, not just suppress its callback").toBe(0);
    await quiescent;
    await started;
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
    expect(await device.execute({ type: "start" })).toEqual({ success: false, message: "fake device disposed" });
    expect(device.commands.at(-1)).toEqual({ type: "start" });
  } finally {
    await device?.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  }
});

it("a terminal event clears a pending deadline before the next job", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  let device: FakeDevice | undefined;
  try {
    const { FakeDevice: ScheduledDevice } = await import("../testing/fake-device.js");
    device = new ScheduledDevice("terminal-clears", "timer-kernel", { cancelBehavior: "silent", cancelConfirmMs: 100 });
    device.scriptStart({ outcome: "accept", deviceJobId: "first" });
    await device.execute({ type: "start" });
    await device.cancelJob("first");
    expect(vi.getTimerCount()).toBe(1);
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    device.complete();
    expect(vi.getTimerCount()).toBe(0);
    device.scriptStart({ outcome: "accept", deviceJobId: "second" });
    await device.execute({ type: "start" });
    await vi.advanceTimersByTimeAsync(200);
    expect(events.map((event) => event.payload.deviceJobId)).toEqual(["first"]);
    expect(await device.getStatus()).toBe("busy");
    device.complete();
  } finally {
    await device?.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  }
});

it("faking timers after import does not take control of captured timers", async () => {
  vi.resetModules();
  const { FakeDevice: CapturedDevice } = await import("../testing/fake-device.js");
  vi.useFakeTimers();
  const device = new CapturedDevice("real-captured", "timer-kernel", { cancelBehavior: "silent", cancelConfirmMs: 1 });
  try {
    device.scriptStart({ outcome: "accept", deviceJobId: "real" });
    await device.execute({ type: "start" });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    await device.cancelJob("real");
    expect(vi.getTimerCount()).toBe(0);
    await device.quiesceEvidence();
    expect(events).toHaveLength(1);
  } finally {
    await device.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  }
});


it("warm-up keeps real timer capture while resetModules re-evaluates under fake timers", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const devices: FakeDevice[] = [];
  try {
    const { FakeDevice: FreshDevice } = await import("../testing/fake-device.js");
    const warmed = new WarmedDevice("warmed-capture", "timer-kernel", { cancelBehavior: "silent", cancelConfirmMs: 1 });
    const fresh = new FreshDevice("fresh-capture", "timer-kernel", { cancelBehavior: "silent", cancelConfirmMs: 100 });
    devices.push(warmed, fresh);
    const warmedEvents: Emitted[] = [];
    const freshEvents: Emitted[] = [];
    warmed.onEvidence((event) => warmedEvents.push(event));
    fresh.onEvidence((event) => freshEvents.push(event));
    for (const device of devices) {
      device.scriptStart({ outcome: "accept", deviceJobId: "capture-job" });
      await device.execute({ type: "start" });
      await device.cancelJob("capture-job");
    }
    expect(vi.getTimerCount(), "only the freshly evaluated module belongs to fake timers").toBe(1);
    await warmed.quiesceEvidence();
    expect(warmedEvents).toHaveLength(1);
    expect(freshEvents).toEqual([]);
    expect(await fresh.getStatus()).toBe("busy");
    await vi.advanceTimersByTimeAsync(100);
    await fresh.quiesceEvidence();
    expect(freshEvents).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    for (const device of devices) await device.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  }
});
