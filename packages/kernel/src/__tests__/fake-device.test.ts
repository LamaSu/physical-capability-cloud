/** FakeDevice's public contract: adapters/types.ts, outstanding-work.ts and spec/evidence/is-fabricated.ts. */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EVIDENCE_DEVICE_TYPES, EVIDENCE_EVENT_TYPES, isFabricated, type EvidenceEvent } from "@pcc/spec";
import type { MachineCommand, MachineCommandResult } from "../adapters/types.js";
import { FakeDevice, type FakeDeviceOptions, type FakeDeviceStartOutcome } from "../testing/fake-device.js";

type Emitted = Omit<EvidenceEvent, "id" | "hash">;
const devices: FakeDevice[] = [];
function fixture(options: FakeDeviceOptions = {}) {
  const device = new FakeDevice("generic-device", "generic-kernel", options);
  devices.push(device);
  return device;
}
async function accepted(options: FakeDeviceOptions = {}, id: string | number = "device-42") {
  const device = fixture(options);
  device.scriptStart({ outcome: "accept", deviceJobId: id });
  await device.execute({ type: "start" });
  return device;
}
function tagged(event: Emitted) {
  expect(event.source.simulated, "source tag is independently mandatory").toBe(true);
  expect(event.payload.mock, "payload tag is independently mandatory").toBe(true);
  expect(isFabricated({ ...event, id: "test-event", hash: "sha256:test" })).toBe(true);
}
afterEach(async () => { await Promise.all(devices.splice(0).map((device) => device.dispose())); });

describe("FakeDevice construction", () => {
  it("defaults to a generic controller without printer binding", async () => {
    const device = fixture();
    expect(device.id).toBe("generic-device");
    expect(device.type).toBe("fake-device");
    expect(device.bindingKey).toBe("deviceJobId");
    expect(device.source).toEqual({ deviceId: device.id, kernelId: "generic-kernel", deviceType: "controller", simulated: true });
    expect(await device.getStatus()).toBe("idle");
    expect(await device.getProgress()).toBe(0);
    expect(await device.execute({ type: "status" })).toEqual({ success: true, data: { status: "idle", progress: 0 } });
  });

  it.each(["jobId", "mock", "origin", "", "progress", "state", "reason", "jobStateReasons"])("rejects reserved or empty bindingKey %j", (bindingKey) => {
    expect(() => fixture({ bindingKey })).toThrow();
  });
  it.each(["settlementUnitId", "challengeNonce"])("RV-INFO-B rejects bindingKey %s", (bindingKey) => {
    expect(() => fixture({ bindingKey })).toThrow(`reserved bindingKey: ${bindingKey}`);
  });

  it.each([
    { preset: "unknown" }, { type: "" }, { type: 5 }, { deviceType: "unknown" },
    { bindingKey: 5 }, { startedType: "unknown" }, { progressType: "unknown" },
    { completedType: "unknown" }, { failedType: "unknown" },
    { completedType: "execution_failed" }, { completedType: "execution_started" },
    { failedType: "execution_progress" }, { failedType: "execution_started" },
    { completedType: "execution_progress" },
    { declaredCommands: ["launch"] }, { declaredCommands: "start" },
    { startedEvent: "later" }, { cancelBehavior: "unknown" }, { cancelEventOrder: "later" },
    { cancelConfirmMs: -1 }, { cancelConfirmMs: Number.NaN }, { cancelConfirmMs: Infinity },
    { cancelConfirmMs: 2_147_483_648 }, { cancelConfirmMs: "50" }, { clock: 7 },
    { preset: "ipp", bindingKey: "other" }, { preset: "ipp", type: "other" }, { preset: "ipp", deviceType: "instrument" },
  ])("validates option %j at construction", (options) => {
    expect(() => fixture(options as unknown as FakeDeviceOptions)).toThrow();
  });

  it.each([
    ["startedType", "execution_completed"], ["startedType", "execution_failed"],
    ["progressType", "execution_completed"], ["progressType", "execution_failed"],
  ] as const)("rejects native terminal %s=%s even with custom terminal roles", (role, type) => {
    expect(() => fixture({
      [role]: type, completedType: "batch_session_completed", failedType: "sensor_anomaly_detected",
    })).toThrow(`${role} must not be a native terminal event type`);
  });

  it("accepts every evidence device type and uses capability-specific event roles", async () => {
    for (const deviceType of EVIDENCE_DEVICE_TYPES) expect(fixture({ deviceType }).source.deviceType).toBe(deviceType);
    const device = await accepted({
      type: "liquid-handler", deviceType: "instrument", bindingKey: "runId", startedEvent: "inside-start",
      startedType: "sequence_started", progressType: "batch_sample_result", completedType: "batch_session_completed", failedType: "sensor_anomaly_detected",
    });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    device.progress(35, { sample: "A1" });
    device.complete({ samples: 12 });
    expect(events.map((event) => event.type)).toEqual(["batch_sample_result", "batch_session_completed"]);
    expect(events.map((event) => event.payload.runId)).toEqual(["device-42", "device-42"]);
    events.forEach(tagged);
    expect(await device.getStatus()).toBe("idle");
  });
});

describe("FakeDevice scripted commands", () => {
  it("scripts accept, busy, error and throw in order, with explicit exhaustion", async () => {
    const device = fixture();
    expect(await device.execute({ type: "start" })).toEqual({ success: false, message: "no scripted start result" });
    device.scriptStart({ outcome: "accept", deviceJobId: "first" });
    device.scriptStart({ outcome: "busy" });
    device.scriptStart({ outcome: "error", message: "motor fault" });
    device.scriptStart({ outcome: "throw", message: "transport fault" });
    expect(await device.execute({ type: "start" })).toEqual({ success: true, data: { jobId: "first" } });
    expect(await device.getStatus()).toBe("busy");
    device.complete();
    expect(await device.execute({ type: "start" })).toEqual({ success: false, busy: true, message: "device is busy", data: { busy: true, code: "busy" } });
    await device.quiesceEvidence();
    expect(await device.execute({ type: "start" })).toEqual({ success: false, message: "motor fault" });
    await expect(device.execute({ type: "start" })).rejects.toThrow("transport fault");
    expect(await device.execute({ type: "start" })).toEqual({ success: false, message: "no scripted start result" });
  });

  it("refuses active starts as busy without consuming the next scripted outcome", async () => {
    const device = await accepted();
    device.scriptStart({ outcome: "accept", deviceJobId: "second" });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    expect(await device.execute({ type: "start" })).toEqual({ success: false, busy: true, message: "device is busy", data: { busy: true, code: "busy" } });
    expect(events).toEqual([]);
    device.complete();
    expect(events[0].payload.deviceJobId).toBe("device-42");
    expect(await device.execute({ type: "start" })).toEqual({ success: true, data: { jobId: "second" } });
  });

  it("records deep command copies and observes starts before and after the waiter", async () => {
    const device = fixture();
    const command: MachineCommand = { type: "start", payload: { nested: { pages: [1, 2] } } };
    const observation = device.started();
    await device.execute(command);
    expect(await observation).toEqual(command);
    (command.payload!.nested as { pages: number[] }).pages.push(3);
    expect(device.commands).toEqual([{ type: "start", payload: { nested: { pages: [1, 2] } } }]);
    await device.execute({ type: "start", payload: { observedLater: true } });
    expect(await device.started()).toEqual({ type: "start", payload: { observedLater: true } });
  });

  it("undeclared commands change neither state, progress, evidence nor start script", async () => {
    const device = fixture({ declaredCommands: ["status", "load_gcode"] });
    device.scriptStart({ outcome: "accept", deviceJobId: "saved" });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    for (const type of ["start", "stop", "pause", "resume"] as const) {
      expect(await device.execute({ type })).toMatchObject({ success: false, message: expect.any(String) });
    }
    expect(device.commands.map((command) => command.type)).toEqual(["start", "stop", "pause", "resume"]);
    expect(await device.getStatus()).toBe("idle");
    expect(await device.getProgress()).toBe(0);
    expect(events).toEqual([]);
    expect(await device.execute({ type: "load_gcode", payload: { content: "any" } })).toEqual({ success: true });
    await device.quiesceEvidence();
  });

  it("an undeclared stop cannot end an active job", async () => {
    const device = await accepted({ declaredCommands: ["start", "status"] });
    expect((await device.execute({ type: "stop" })).success).toBe(false);
    expect(await device.getStatus()).toBe("busy");
    device.progress(27);
    expect(await device.execute({ type: "status" })).toEqual({ success: true, data: { status: "busy", progress: 27 } });
    device.complete();
  });

  it("snapshots options and scripted outcomes against caller mutation", async () => {
    const options: FakeDeviceOptions = { bindingKey: "runId", declaredCommands: ["start", "stop", "status"] };
    const device = fixture(options);
    options.bindingKey = "jobId";
    (options.declaredCommands as MachineCommand["type"][]).splice(0);
    const outcome: FakeDeviceStartOutcome = { outcome: "accept", deviceJobId: "original" };
    device.scriptStart(outcome);
    outcome.deviceJobId = "mutated";
    expect(await device.execute({ type: "start" })).toEqual({ success: true, data: { jobId: "original" } });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    device.complete();
    expect(events[0].payload.runId).toBe("original");
  });

  it.each([null, {}, { outcome: "unknown" }, { outcome: "accept" }, { outcome: "accept", deviceJobId: {} }, { outcome: "accept", deviceJobId: "" }, { outcome: "accept", deviceJobId: NaN }, { outcome: "accept", deviceJobId: Infinity }, { outcome: "error", message: 7 }, { outcome: "throw" }])("rejects malformed scripted outcome %j", (outcome) => {
    expect(() => fixture().scriptStart(outcome as FakeDeviceStartOutcome)).toThrow();
  });
});

describe("FakeDevice evidence honesty", () => {
  it.each(["id", "bindingKey"] as const)("keeps private emission identity after a cast write to public %s", async (field) => {
    const device = await accepted({ bindingKey: "runId" });
    (device as unknown as Record<string, unknown>)[field] = field === "id" ? "foreign-device" : "jobId";
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    device.progress(1);
    device.complete();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.source.deviceId).toBe("generic-device");
      expect(event.source).toEqual(device.source);
      expect(event.payload.runId).toBe("device-42");
      expect(Object.hasOwn(event.payload, "jobId")).toBe(false);
      tagged(event);
    }
  });

  it("RV-INFO-D isolates nested payloads between progress listeners", async () => {
    const device = await accepted();
    const second: Emitted[] = [];
    device.onEvidence((event) => {
      if (event.type !== "execution_progress") return;
      (event.payload.detail as { pages: number[] }).pages.push(99);
      (event.payload.jobStateReasons as string[]).push("tampered");
    });
    device.onEvidence((event) => second.push(event));
    device.progress(10, { detail: { pages: [1] }, jobStateReasons: [] });
    expect(second[0].payload.detail).toEqual({ pages: [1] });
    expect(second[0].payload.jobStateReasons).toEqual([]);
    device.complete();
  });

  it.each(["jobId", "settlementUnitId", "challengeNonce", "mock"])("RV-orig-half refuses a non-enumerable caller key %s", async (key) => {
    const device = await accepted();
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    const payload = Object.defineProperty({}, key, { value: "reserved", enumerable: false });
    expect(Object.hasOwn(structuredClone(payload), key)).toBe(false);
    expect(() => device.emit("execution_progress", payload)).toThrow(`payload.${key} is reserved`);
    expect(events).toEqual([]);
    expect(await device.getStatus()).toBe("busy");
    device.complete();
  });

  it.each(["jobId", "settlementUnitId", "challengeNonce", "mock"])("a getter cannot hide cloned reserved field %s by deleting the caller's copy", async (key) => {
    const device = await accepted();
    const payload: Record<string, unknown> = { [key]: "reserved" };
    Object.defineProperty(payload, "detail", { enumerable: true, get: () => { delete payload[key]; return "detail"; } });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    expect(() => device.emit("execution_progress", payload)).toThrow();
    expect(events).toEqual([]);
    expect(await device.getStatus()).toBe("busy");
    device.complete();
  });

  it("refuses job re-entry from a payload getter while cloning", async () => {
    const device = await accepted();
    device.scriptStart({ outcome: "accept", deviceJobId: "getter-B" });
    let error: unknown;
    let next: Promise<MachineCommandResult> | undefined;
    const payload = { get detail() {
      try { device.fail(); } catch (caught) { error = caught; }
      next = device.execute({ type: "start" });
      return "detail";
    } };
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    device.emit("execution_progress", payload);
    expect(error).toMatchObject({ message: expect.stringContaining("re-entrant emission refused during delivery") });
    await expect(next).resolves.toMatchObject({ success: false, busy: true });
    expect(events.map((event) => [event.type, event.payload.deviceJobId])).toEqual([["execution_progress", "device-42"]]);
    device.complete();
    expect(await device.execute({ type: "start" })).toEqual({ success: true, data: { jobId: "getter-B" } });
    device.complete();
  });

  it("checks origin on the cloned payload and reads a caller getter only once", async () => {
    const device = await accepted();
    let reads = 0;
    const payload = { get origin() { return ++reads === 1 ? "device" : "kernel"; } };
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    // progress() would spread the getter before emit sees it; failures overwrite
    // origin. A direct nonterminal emit uniquely exercises this clone boundary.
    device.emit("execution_progress", payload);
    expect(reads).toBe(1);
    expect(events[0].payload.origin).toBe("device");
    tagged(events[0]);
    device.complete();
  });

  it("documents and emits the deliberate device-origin stop failure", async () => {
    // The parity exception must stay explicit for consumers of this test fake.
    const source = readFileSync(new URL("../testing/fake-device.ts", import.meta.url), "utf8");
    expect(source).toMatch(/Real adapters end a stopped job silently\.\s*\* FakeDevice deliberately emits a device-origin failure/);
    const device = await accepted();
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    await device.execute({ type: "stop" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "execution_failed", payload: { state: "stopped", origin: "device" } });
    tagged(events[0]);
    expect(await device.getStatus()).toBe("idle");
    await device.quiesceEvidence();
  });

  it("terminal listener errors reach the caller after releasing the job", async () => {
    const device = await accepted();
    const quiescent = device.quiesceEvidence();
    const failure = new Error("terminal listener failed");
    device.onEvidence(() => { throw failure; });
    expect(() => device.complete()).toThrow(failure);
    expect(await device.getStatus()).toBe("idle");
    await expect(quiescent).resolves.toBeUndefined();
  });

  it("ipp start returns both model device-job identifiers", async () => {
    const device = fixture({ preset: "ipp" });
    device.scriptStart({ outcome: "accept", deviceJobId: 46 });
    expect(await device.execute({ type: "start" })).toEqual({ success: true, data: { jobId: 46, ippJobId: 46 } });
    device.complete();
  });

  it.each([-1, 100.01, NaN, Infinity, -Infinity, "50"])("rejects out-of-range progress %s without changing evidence or progress", async (n) => {
    const device = await accepted();
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    expect(() => device.progress(n as number)).toThrow("progress must be between 0 and 100");
    expect(await device.getProgress()).toBe(0);
    expect(events).toEqual([]);
    expect(await device.getStatus()).toBe("busy");
    device.complete();
  });

  it.each(["none", "inside-start", "after-start"] as const)("tags started=%s, progress and completion separately", async (startedEvent) => {
    const device = fixture({ startedEvent });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    device.scriptStart({ outcome: "accept", deviceJobId: "tag-job" });
    const start = device.execute({ type: "start" });
    if (startedEvent === "inside-start") expect(events).toHaveLength(1);
    else expect(events).toHaveLength(0);
    await start;
    await Promise.resolve();
    device.progress(60, { detail: "sample" });
    expect(await device.getProgress()).toBe(60);
    device.complete();
    expect(events.map((event) => event.type)).toEqual([
      ...(startedEvent === "none" ? [] : ["execution_started"]), "execution_progress", "execution_completed",
    ]);
    events.forEach(tagged);
    for (const event of events) expect(event.payload.deviceJobId).toBe("tag-job");
  });

  it.each(["fail", "stop", "report", "silent"] as const)("tags generated %s failures with device origin", async (mode) => {
    const device = await accepted({ cancelBehavior: mode === "silent" ? "silent" : "report", cancelConfirmMs: 1 });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    if (mode === "fail") device.fail({ reason: "scripted" });
    else if (mode === "stop") await device.execute({ type: "stop" });
    else await device.cancelJob("device-42");
    await device.quiesceEvidence();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("execution_failed");
    expect(events[0].payload.origin).toBe("device");
    if (mode === "stop") expect(events[0].payload.state).toBe("stopped");
    if (mode === "report") expect(events[0].payload.state).toBe("canceled");
    if (mode === "silent") expect(events[0].payload.reason).toBe("cancel-unconfirmed");
    events.forEach(tagged);
  });

  it("builds fresh sources and payload copies despite listener and caller mutation", async () => {
    const device = await accepted();
    const events: Emitted[] = [];
    device.onEvidence((event) => {
      events.push(structuredClone(event));
      event.source.simulated = false;
      event.source.deviceId = "corrupted";
      event.payload.mock = false;
      event.payload.deviceJobId = "foreign";
    });
    const payload = { detail: "before" };
    device.progress(1, payload);
    payload.detail = "after";
    expect(() => { device.source.simulated = false; }).toThrow(TypeError);
    expect(() => { device.source.deviceId = "public-source-mutated"; }).toThrow(TypeError);
    expect(device.source.simulated).toBe(true);
    device.progress(2);
    device.complete();
    expect(events).toHaveLength(3);
    expect(events[0].payload.detail).toBe("before");
    for (const event of events) {
      tagged(event);
      expect(event.source.deviceId).toBe("generic-device");
      expect(event.payload.deviceJobId).toBe("device-42");
    }
    expect(events.map((event) => event.timestamp)).toEqual([
      "2026-10-09T00:00:00.000Z", "2026-10-09T00:00:00.001Z", "2026-10-09T00:00:00.002Z",
    ]);
  });

  it.each([
    { jobId: "pcc-job" }, { jobId: undefined },
    { settlementUnitId: "unit" }, { settlementUnitId: undefined }, { challengeNonce: "nonce" }, { challengeNonce: undefined }, { mock: true }, { mock: false }, { origin: "kernel" }, { deviceJobId: "foreign" },
  ])("rejects dishonest caller payload %j without changing the job", async (payload) => {
    const device = await accepted();
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    expect(() => device.emit("execution_progress", payload)).toThrow();
    expect(() => device.complete(payload)).toThrow();
    expect(events).toEqual([]);
    expect(await device.getStatus()).toBe("busy");
    device.complete({ deviceJobId: "device-42", origin: "device" });
    tagged(events[0]);
  });

  it("validates event vocabulary and permits all nonterminal vocabulary types", async () => {
    const device = await accepted();
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    expect(() => device.emit("invented" as Emitted["type"])).toThrow();
    for (const type of EVIDENCE_EVENT_TYPES) {
      if (type !== "execution_completed" && type !== "execution_failed") device.emit(type);
    }
    device.emit("execution_failed");
    expect(events).toHaveLength(EVIDENCE_EVENT_TYPES.length - 1);
    events.forEach(tagged);
    expect(events.at(-1)!.payload.origin).toBe("device");
  });

  it("uses injected clock values", async () => {
    let ticks = 0;
    const device = await accepted({ clock: () => new Date(Date.UTC(2030, 0, 1) + 100 * ticks++) });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    device.progress(50);
    device.complete();
    expect(events.map((event) => event.timestamp)).toEqual(["2030-01-01T00:00:00.000Z", "2030-01-01T00:00:00.100Z"]);
  });
});

describe("FakeDevice quiescence and cancellation", () => {
  it("is immediately quiescent while idle", async () => { await fixture().quiesceEvidence(); });

  it.each(["complete", "fail", "stop", "report", "silent"] as const)("refuses re-entry during %s terminal delivery", async (terminal) => {
    const device = await accepted({ cancelBehavior: terminal === "silent" ? "silent" : "report", cancelConfirmMs: 1 });
    const first: Emitted[] = [];
    const second: Emitted[] = [];
    const errors: Array<[string, unknown]> = [];
    let delivered!: () => void;
    const terminalDelivered = new Promise<void>((resolve) => { delivered = resolve; });
    let reentrantStop: Promise<unknown> | undefined;
    let reentrantStart: Promise<MachineCommandResult> | undefined;
    device.scriptStart({ outcome: "accept", deviceJobId: "next-terminal-job" });
    device.onEvidence((event) => {
      first.push(event);
      // Bound a faulty re-entrant emitter so every attempted API can be checked.
      if (first.length > 1) return;
      for (const [api, attempt] of [
        ["emit", () => device.emit("execution_progress")],
        ["progress", () => device.progress(50)],
        ["complete", () => device.complete()],
        ["fail", () => device.fail()],
      ] as const) {
        try { attempt(); errors.push([api, undefined]); }
        catch (error) { errors.push([api, error]); }
      }
      reentrantStop = device.execute({ type: "stop" }).catch((error: unknown) => error);
      reentrantStart = device.execute({ type: "start" });
    });
    device.onEvidence((event) => { second.push(event); delivered(); });
    if (terminal === "complete" || terminal === "fail") device[terminal]();
    else if (terminal === "stop") await device.execute({ type: "stop" });
    else await device.cancelJob("device-42");
    await terminalDelivered;
    expect(errors.map(([api]) => api)).toEqual(["emit", "progress", "complete", "fail"]);
    for (const [api, error] of errors) {
      expect(error, api).toBeInstanceOf(Error);
      expect(error, api).toMatchObject({ message: expect.stringContaining("re-entrant emission refused during delivery") });
    }
    await expect(reentrantStop).resolves.toEqual({ success: true });
    await expect(reentrantStart).resolves.toEqual({ success: false, busy: true, message: "device is busy", data: { busy: true, code: "busy" } });
    const expectedType = terminal === "complete" ? "execution_completed" : "execution_failed";
    expect(first.map((event) => event.type)).toEqual([expectedType]);
    expect(second.map((event) => event.type)).toEqual([expectedType]);
    expect(await device.getStatus()).toBe("idle");
    await expect(device.quiesceEvidence()).resolves.toBeUndefined();
    expect(await device.execute({ type: "start" })).toEqual({ success: true, data: { jobId: "next-terminal-job" } });
    device.complete();
  });

  it.each([false, true])("refuses complete at progress 100 with next start=%s", async (startNext) => {
    const device = await accepted();
    device.scriptStart({ outcome: "accept", deviceJobId: "B" });
    const events: Emitted[] = [];
    const errors: unknown[] = [];
    let next: Promise<MachineCommandResult> | undefined;
    device.onEvidence((event) => {
      if (event.type !== "execution_progress") return;
      try { device.complete(); errors.push(undefined); } catch (error) { errors.push(error); }
      if (startNext) next = device.execute({ type: "start" });
    });
    device.onEvidence((event) => events.push(event));
    device.progress(100);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: expect.stringContaining("re-entrant emission refused during delivery") });
    if (startNext) await expect(next).resolves.toMatchObject({ success: false, busy: true });
    expect(events.map((event) => [event.type, event.payload.deviceJobId])).toEqual([["execution_progress", "device-42"]]);
    expect(await device.getStatus()).toBe("busy");
    device.complete();
    expect(await device.execute({ type: "start" })).toEqual({ success: true, data: { jobId: "B" } });
    device.complete();
  });

  it.each(["progress", "terminal"] as const)("refuses fail and a new job from the %s clock", async (emission) => {
    let device: FakeDevice;
    let reentered = false;
    let error: unknown;
    let next: Promise<MachineCommandResult> | undefined;
    const events: Emitted[] = [];
    device = await accepted({ clock: () => {
      if (!reentered) {
        reentered = true;
        try { device.fail(); } catch (caught) { error = caught; }
        next = device.execute({ type: "start" });
      }
      return new Date("2030-01-01T00:00:00Z");
    } });
    device.scriptStart({ outcome: "accept", deviceJobId: "B" });
    device.onEvidence((event) => events.push(event));
    if (emission === "progress") device.progress(100);
    else device.complete();
    expect(error).toMatchObject({ message: expect.stringContaining("re-entrant emission refused during delivery") });
    await expect(next).resolves.toMatchObject({ success: false, busy: true });
    expect(events.map((event) => [event.type, event.payload.deviceJobId])).toEqual([
      [emission === "progress" ? "execution_progress" : "execution_completed", "device-42"],
    ]);
    if (emission === "progress") device.complete();
    expect(await device.execute({ type: "start" })).toEqual({ success: true, data: { jobId: "B" } });
    expect(await device.getStatus()).toBe("busy");
    device.complete();
  });

  it("refuses all emit APIs during nonterminal delivery", async () => {
    const device = await accepted();
    const errors: unknown[] = [];
    let attempted = false;
    device.onEvidence(() => {
      if (attempted) return;
      attempted = true;
      for (const attempt of [() => device.emit("execution_started"), () => device.progress(1), () => device.complete(), () => device.fail()]) {
        try { attempt(); errors.push(undefined); } catch (error) { errors.push(error); }
      }
    });
    device.progress(100);
    expect(errors).toHaveLength(4);
    for (const error of errors) expect(error).toMatchObject({ message: expect.stringContaining("re-entrant emission refused during delivery") });
    device.complete();
  });

  it("ends the job after stop during nonterminal delivery", async () => {
    const device = await accepted();
    let stop: Promise<MachineCommandResult> | undefined;
    device.onEvidence((event) => { if (event.type === "execution_progress") stop = device.execute({ type: "stop" }); });
    device.progress(100);
    await expect(stop).resolves.toEqual({ success: true });
    expect(await device.getStatus()).toBe("idle");
    await device.quiesceEvidence();
  });

  it("reports a throwing cancellation during nonterminal delivery", async () => {
    const device = await accepted({ cancelBehavior: "throw" });
    let cancel: Promise<unknown> | undefined;
    device.onEvidence(() => { cancel = device.cancelJob("device-42").catch((error: unknown) => error); });
    device.progress(100);
    await expect(cancel).resolves.toMatchObject({ message: "fake device cancel rejected" });
    expect(device.cancels).toEqual(["device-42"]);
    expect(await device.getStatus()).toBe("busy");
    await device.dispose();
  });

  it("stops the current delivery as soon as a listener disposes the device", async () => {
    const device = await accepted();
    const observed: Emitted[] = [];
    device.onEvidence(() => { void device.dispose(); });
    device.onEvidence((event) => observed.push(event));
    device.progress(100);
    expect(observed).toEqual([]);
    await device.quiesceEvidence();
  });

  it("a stale finalizer cannot end the replacement job", async () => {
    const device = await accepted();
    // Exercise this defensive identity boundary directly: public re-entry is also
    // refused, so it must not mask a finalizer that accidentally ends a newer job.
    const lifecycle = device as unknown as {
      active: { id: string | number; end: () => void };
      finishWork: (job: { id: string | number; end: () => void }) => void;
    };
    const old = lifecycle.active;
    device.complete();
    device.scriptStart({ outcome: "accept", deviceJobId: "replacement" });
    await device.execute({ type: "start" });
    let idle = false;
    const quiescent = device.quiesceEvidence().then(() => { idle = true; });
    lifecycle.finishWork(old);
    await Promise.resolve();
    expect(idle).toBe(false);
    expect(await device.getStatus()).toBe("busy");
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    device.complete();
    await quiescent;
    expect(events[0].payload.deviceJobId).toBe("replacement");
  });

  it("RV-finish-order a stale finalizer preserves the replacement's silent deadline", async () => {
    const device = await accepted({ cancelBehavior: "silent", cancelConfirmMs: 5 });
    const lifecycle = device as unknown as {
      active: { id: string | number; end: () => void };
      finishWork: (job: { id: string | number; end: () => void }) => void;
    };
    const old = lifecycle.active;
    device.complete();
    device.scriptStart({ outcome: "accept", deviceJobId: "replacement" });
    await device.execute({ type: "start" });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    let idle = false;
    const quiescent = device.quiesceEvidence().then(() => { idle = true; });
    await device.cancelJob("replacement");
    // Public re-entry cannot replace active work mid-delivery. Exercise this
    // defensive boundary directly, with a timer that belongs to the new job.
    lifecycle.finishWork(old);
    expect(await device.getStatus()).toBe("busy");
    expect(idle).toBe(false);
    await Promise.race([quiescent, new Promise<void>((resolve) => setTimeout(resolve, 200))]);
    expect(events.map((event) => [event.type, event.payload.deviceJobId, event.payload.reason])).toEqual([
      ["execution_failed", "replacement", "cancel-unconfirmed"],
    ]);
    expect(events[0].payload.origin).toBe("device");
    expect(await device.getStatus()).toBe("idle");
    await quiescent;
  });

  it.each(["complete", "fail"] as const)("refuses every emit API after %s without invoking listeners", async (terminal) => {
    const device = await accepted();
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    device[terminal]();
    await device.quiesceEvidence();
    expect(events).toHaveLength(1);
    expect(() => device.emit("execution_progress")).toThrow("no active job");
    expect(() => device.progress(50)).toThrow("no active job");
    expect(() => device.complete()).toThrow("no active job");
    expect(() => device.fail()).toThrow("no active job");
    expect(events).toHaveLength(1);
  });

  it.each(["complete", "fail"] as const)("waits for %s listeners before releasing every quiesce waiter", async (terminal) => {
    const device = await accepted();
    const order: string[] = [];
    const first = device.quiesceEvidence().then(() => order.push("quiesce-1"));
    const second = device.quiesceEvidence().then(() => order.push("quiesce-2"));
    await Promise.resolve();
    expect(order).toEqual([]);
    device.onEvidence((event) => { order.push(event.type); expect(order).not.toContain("quiesce-1"); });
    device[terminal]();
    expect(order).toEqual([terminal === "complete" ? "execution_completed" : "execution_failed"]);
    await Promise.all([first, second]);
    expect(order.slice(1)).toEqual(["quiesce-1", "quiesce-2"]);
    expect(await device.getStatus()).toBe("idle");
    expect(() => device.emit("execution_progress")).toThrow();
    expect(() => device.complete()).toThrow();
    expect(() => device.fail()).toThrow();
  });

  it("keeps quiescence pending until an after-resolve cancel report arrives", async () => {
    const device = await accepted({ cancelEventOrder: "after-resolve" });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    let settled = false;
    const idle = device.quiesceEvidence().then(() => { settled = true; });
    await device.cancelJob("device-42");
    expect(events).toEqual([]);
    expect(settled).toBe(false);
    await idle;
    expect(events).toHaveLength(1);
    tagged(events[0]);
  });

  it("keeps quiescence pending while a silent deadline can still emit", async () => {
    const device = await accepted({ cancelBehavior: "silent", cancelConfirmMs: 10 });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    let settled = false;
    const idle = device.quiesceEvidence().then(() => { settled = true; });
    await device.cancelJob("device-42");
    expect(settled).toBe(false);
    expect(events).toEqual([]);
    await idle;
    expect(events[0].payload.reason).toBe("cancel-unconfirmed");
  });

  it("cancelJob strictly targets only the named device job", async () => {
    const device = await accepted({}, 42);
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    await device.cancelJob("42");
    await device.cancelJob(99);
    expect(device.cancels).toEqual(["42", 99]);
    expect(events).toEqual([]);
    expect(await device.getStatus()).toBe("busy");
    await device.cancelJob(42);
    expect(events).toHaveLength(1);
    expect(events[0].payload.deviceJobId).toBe(42);
  });

  it("records every generic foreign id without applying IPP validation", async () => {
    const device = await accepted({ cancelBehavior: "throw" }, 42);
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    const foreign = ["", NaN, Infinity, -Infinity, "42"];
    for (const id of foreign) await device.cancelJob(id);
    expect(device.cancels).toEqual(foreign);
    expect(events).toEqual([]);
    expect(await device.getStatus()).toBe("busy");
    device.complete();
  });

  it.each(["refuse", "throw"] as const)("cancelBehavior=%s leaves the active job until scripted terminal", async (cancelBehavior) => {
    const device = await accepted({ cancelBehavior });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    if (cancelBehavior === "throw") await expect(device.cancelJob("device-42")).rejects.toThrow();
    else await device.cancelJob("device-42");
    expect(device.cancels).toEqual(["device-42"]);
    expect(events).toEqual([]);
    expect(await device.getStatus()).toBe("busy");
    device.complete();
    await device.quiesceEvidence();
  });

  it("the ipp preset normalizes only the model's valid numeric cancellation ids", async () => {
    const device = await accepted({ preset: "ipp" }, 42);
    expect(device.bindingKey).toBe("ippJobId");
    expect(device.type).toBe("ipp-2d");
    await device.cancelJob("43");
    expect(await device.getStatus()).toBe("busy");
    for (const id of ["0", "01", "1.0", " 42", "42 ", "+42", "4e1", "", -1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, {}]) {
      await expect(device.cancelJob(id as string | number)).rejects.toThrow("cancelJob requires a numeric job id");
    }
    expect(device.cancels).toEqual([43]);
    await device.cancelJob("42");
    expect(device.cancels).toEqual([43, 42]);
    expect(await device.getStatus()).toBe("idle");
    for (const deviceJobId of ["42", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => device.scriptStart({ outcome: "accept", deviceJobId })).toThrow();
    }
  });

  it("dispose releases idle waiters, rejects started waiters and records later refusals", async () => {
    const device = await accepted();
    await device.started();
    const waiter = expect(device.started()).rejects.toThrow("disposed");
    const idle = device.quiesceEvidence();
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    await device.dispose();
    await idle;
    await waiter;
    expect(events).toEqual([]);
    expect(await device.execute({ type: "start", payload: { after: true } })).toEqual({ success: false, message: "fake device disposed" });
    expect(device.commands.at(-1)).toEqual({ type: "start", payload: { after: true } });
    expect(() => device.emit("execution_progress")).toThrow();
    await expect(device.started()).rejects.toThrow("disposed");
    await device.dispose();
  });
});


describe("FakeDevice listener cancellation contract", () => {
  const settle = (work: Promise<void>) => Promise.race([
    work, new Promise<void>((resolve) => setTimeout(resolve, 200)),
  ]);

  it("RV-LOW-A throw-mode cancellation from terminal listeners resolves", async () => {
    for (const terminal of ["complete", "fail"] as const) {
      const device = await accepted({ cancelBehavior: "throw" });
      const events: Emitted[] = [];
      let cancel: Promise<void> | undefined;
      device.onEvidence((event) => {
        events.push(event);
        cancel = device.cancelJob("device-42");
      });
      device[terminal]();
      await expect(cancel, terminal).resolves.toBeUndefined();
      expect(device.cancels).toEqual(["device-42"]);
      expect(events.map((event) => [event.type, event.payload.deviceJobId])).toEqual([
        [terminal === "complete" ? "execution_completed" : "execution_failed", "device-42"],
      ]);
      expect(await device.getStatus()).toBe("idle");
      await expect(device.quiesceEvidence()).resolves.toBeUndefined();
    }
  });

  it.each([
    ["report", "before-resolve"], ["report", "after-resolve"], ["silent", "before-resolve"],
  ] as const)("RV-LOW-A a %s/%s cancel from progress still ends the job", async (cancelBehavior, cancelEventOrder) => {
    const device = await accepted({ cancelBehavior, cancelEventOrder, cancelConfirmMs: 5 });
    const events: Emitted[] = [];
    let cancel: Promise<void> | undefined;
    device.onEvidence((event) => {
      events.push(event);
      if (event.type === "execution_progress") cancel = device.cancelJob("device-42");
    });
    device.progress(50);
    await cancel;
    await settle(device.quiesceEvidence());
    expect(events.map((event) => event.type)).toEqual(["execution_progress", "execution_failed"]);
    expect(events[1].payload.origin).toBe("device");
    expect(await device.getStatus()).toBe("idle");
  });

  it("RV-LOW-A a stop from progress defers until every progress listener returns", async () => {
    const device = await accepted();
    const events: Emitted[] = [];
    let stop: Promise<MachineCommandResult> | undefined;
    device.onEvidence((event) => {
      if (event.type === "execution_progress") stop = device.execute({ type: "stop" });
    });
    device.onEvidence((event) => events.push(event));
    device.progress(50);
    expect(events.map((event) => event.type)).toEqual(["execution_progress"]);
    await expect(stop).resolves.toEqual({ success: true });
    await settle(device.quiesceEvidence());
    expect(events.map((event) => [event.type, event.payload.state])).toEqual([
      ["execution_progress", undefined], ["execution_failed", "stopped"],
    ]);
    expect(events[1].payload.origin).toBe("device");
    expect(await device.getStatus()).toBe("idle");
  });

  it("RV-LOW-A deferred stop cannot stop a replacement job with the same id", async () => {
    const device = await accepted();
    const events: Emitted[] = [];
    let stop: Promise<unknown> | undefined;
    device.onEvidence((event) => {
      events.push(event);
      if (event.type === "execution_progress") {
        // The stop contract has its own success pin; isolate identity here.
        stop = device.execute({ type: "stop" }).catch(() => undefined);
      }
    });
    device.progress(10);
    device.complete();
    device.scriptStart({ outcome: "accept", deviceJobId: "device-42" });
    // execute installs the new job synchronously, before the stop microtask runs.
    const next = device.execute({ type: "start" });
    await stop;
    await expect(next).resolves.toMatchObject({ success: true });
    expect(await device.getStatus()).toBe("busy");
    expect(events.map((event) => event.type)).toEqual(["execution_progress", "execution_completed"]);
    device.complete();
  });
});


describe("FakeDevice terminal clock errors", () => {
  it.each(["throw", "invalid"] as const)("RV-INFO-A a %s clock leaves the terminal job active for retry", async (fault) => {
    let calls = 0;
    const device = await accepted({ clock: () => {
      if (++calls === 1) {
        if (fault === "throw") throw new Error("clock broke");
        return new Date(NaN);
      }
      return new Date(Date.UTC(2030, 0, 1));
    } });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    let idle = false;
    const quiescent = device.quiesceEvidence().then(() => { idle = true; });
    expect(() => device.complete()).toThrow(fault === "throw" ? "clock broke" : "clock must return a valid Date");
    expect(events).toEqual([]);
    expect(await device.getStatus()).toBe("busy");
    expect(idle).toBe(false);
    device.complete();
    await quiescent;
    expect(events.map((event) => event.type)).toEqual(["execution_completed"]);
    expect(await device.getStatus()).toBe("idle");
  });
});
