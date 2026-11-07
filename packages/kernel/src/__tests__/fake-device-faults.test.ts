import { describe, expect, it } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";
import type { MachineAdapter, MachineCommand, MachineCommandResult } from "../adapters/types.js";
import { FakeDevice, type FakeDeviceOptions } from "../testing/fake-device.js";
import { DEVICE_FAULTS, withFault, type DeviceFault } from "./helpers/device-faults.js";

type DeviceEvent = Omit<EvidenceEvent, "id" | "hash">;
const immediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Observation {
  start: MachineCommandResult;
  commands: MachineCommand[];
  cancels: Array<string | number>;
  eventTypes: string[];
  bindingValues: unknown[];
  tags: Array<{ simulated: boolean | undefined; mock: unknown }>;
  payloads: Array<Record<string, unknown>>;
  sources: Array<DeviceEvent["source"]>;
  quiesceOrder: string[];
  eventsAfterQuiesce: number;
  eventsAfterDispose: number;
  status: string;
  progress: number;
  eventsAtCancel?: number;
  statusAtCancel?: string;
}

/** Record every conformance axis, including those a particular fault leaves alone. */
function observe(device: FakeDevice, adapter: MachineAdapter) {
  const events: DeviceEvent[] = [];
  const quiesceOrder: string[] = [];
  let quiesced = false;
  let disposed = false;
  let eventsAfterQuiesce = 0;
  let eventsAfterDispose = 0;
  adapter.onEvidence((event) => {
    events.push(structuredClone(event));
    quiesceOrder.push(`event:${event.type}`);
    if (quiesced) eventsAfterQuiesce++;
    if (disposed) eventsAfterDispose++;
  });
  return {
    events,
    quiesce: () => adapter.quiesceEvidence().then(() => {
      quiesced = true;
      quiesceOrder.push("quiesced");
    }),
    async finish(start: MachineCommandResult, afterDispose?: () => void): Promise<Observation> {
      const status = await adapter.getStatus();
      const progress = await adapter.getProgress();
      await adapter.dispose();
      disposed = true;
      afterDispose?.();
      await immediate();
      return {
        start: structuredClone(start),
        commands: structuredClone(device.commands),
        cancels: [...device.cancels],
        eventTypes: events.map((event) => event.type),
        bindingValues: events.map((event) => event.payload[device.bindingKey]),
        tags: events.map((event) => ({ simulated: event.source.simulated, mock: event.payload.mock })),
        payloads: events.map((event) => event.payload),
        sources: events.map((event) => event.source),
        quiesceOrder,
        eventsAfterQuiesce,
        eventsAfterDispose,
        status,
        progress,
      };
    },
  };
}

async function lifecycle(
  fault?: DeviceFault,
  options: FakeDeviceOptions = {},
  deviceJobId: string | number = "work-1",
): Promise<Observation> {
  const device = new FakeDevice("device-1", "kernel-1", options);
  const adapter = fault ? withFault(device, fault) : device;
  const observed = observe(device, adapter);
  device.scriptStart({ outcome: "accept", deviceJobId });
  const start = await adapter.execute({ type: "start", payload: { nested: { method: "mix" } } });
  device.progress(25, { temperature: 20 });
  const quiescence = observed.quiesce();
  await Promise.resolve();
  await Promise.resolve();
  device.complete({ result: "mixed" });
  await quiescence;
  await immediate();
  return observed.finish(start);
}

async function busy(fault?: DeviceFault): Promise<Observation> {
  const device = new FakeDevice("device-1", "kernel-1");
  const adapter = fault ? withFault(device, fault) : device;
  const observed = observe(device, adapter);
  device.scriptStart({ outcome: "busy" });
  const start = await adapter.execute({ type: "start" });
  await observed.quiesce();
  return observed.finish(start);
}

async function cancellation(fault?: DeviceFault, useStop = false): Promise<Observation> {
  const device = new FakeDevice("device-1", "kernel-1", { cancelBehavior: useStop ? "refuse" : "report" });
  const adapter = fault ? withFault(device, fault) : device;
  const observed = observe(device, adapter);
  device.scriptStart({ outcome: "accept", deviceJobId: "work-1" });
  const start = await adapter.execute({ type: "start" });
  device.progress(25);
  const quiescence = observed.quiesce();
  await adapter.cancelJob!(useStop ? "work-1" : "other-work");
  const eventsAtCancel = observed.events.length;
  const statusAtCancel = await adapter.getStatus();
  // Give the honest run the same final device event. The only differing
  // observation is whether the cancellation incorrectly caused it early.
  if (statusAtCancel === "busy") device.fail({ state: useStop ? "stopped" : "canceled" });
  await quiescence;
  const result = await observed.finish(start);
  return { ...result, eventsAtCancel, statusAtCancel };
}

function expectSameExcept(actual: Observation, honest: Observation, changed: Array<keyof Observation>): void {
  const actualRest: Partial<Observation> = structuredClone(actual);
  const honestRest: Partial<Observation> = structuredClone(honest);
  for (const key of changed) {
    delete actualRest[key];
    delete honestRest[key];
  }
  expect(actualRest).toEqual(honestRest);
}

function withoutLastEvent(observation: Observation): Observation {
  return {
    ...observation,
    eventTypes: observation.eventTypes.slice(0, -1),
    bindingValues: observation.bindingValues.slice(0, -1),
    tags: observation.tags.slice(0, -1),
    payloads: observation.payloads.slice(0, -1),
    sources: observation.sources.slice(0, -1),
    quiesceOrder: observation.quiesceOrder.slice(0, -1),
  };
}

describe("FakeDevice test-only fault isolation", () => {
  it("lists exactly the ten conformance faults", () => {
    expect(DEVICE_FAULTS).toEqual([
      "emitAfterQuiesce", "quiesceEarly", "foreignDeviceJob", "unboundTerminal",
      "noDeviceJobId", "busyWithoutFlag", "cancelOtherJob", "stopInsteadOfCancel",
      "emitAfterDispose", "untagged",
    ]);
  });

  it("emitAfterQuiesce adds exactly one bound event after the resolved handshake", async () => {
    const honest = await lifecycle();
    const faulted = await lifecycle("emitAfterQuiesce");
    expect(honest.eventsAfterQuiesce).toBe(0);
    expect(faulted.eventsAfterQuiesce).toBe(1);
    expect(faulted.quiesceOrder.slice(-2)).toEqual(["quiesced", "event:execution_completed"]);
    expect(faulted.bindingValues.at(-1)).toBe("work-1");
    expectSameExcept(withoutLastEvent(faulted), honest, ["eventsAfterQuiesce"]);
  });

  it("emitAfterQuiesce suppresses its deferred replay when disposal intervenes", async () => {
    const run = async (fault?: DeviceFault) => {
      const device = new FakeDevice("device-1", "kernel-1");
      const adapter = fault ? withFault(device, fault) : device;
      const observed = observe(device, adapter);
      device.scriptStart({ outcome: "accept", deviceJobId: "work-1" });
      const start = await adapter.execute({ type: "start" });
      device.complete();
      await observed.quiesce();
      const lateEvents: DeviceEvent[] = [];
      // finish disposes before the queued setImmediate can deliver evidence.
      // A new subscription also detects any stale callback that revives it.
      const observation = await observed.finish(start, () => {
        adapter.onEvidence((event) => lateEvents.push(event));
      });
      return { observation, lateEvents };
    };
    const honest = await run();
    const faulted = await run("emitAfterQuiesce");
    expect(honest.observation.eventsAfterDispose).toBe(0);
    expect(faulted).toEqual(honest);
  });

  it("quiesceEarly changes only handshake ordering while work is active", async () => {
    const honest = await lifecycle();
    const faulted = await lifecycle("quiesceEarly");
    expect(honest.quiesceOrder).toEqual(["event:execution_progress", "event:execution_completed", "quiesced"]);
    expect(faulted.quiesceOrder).toEqual(["event:execution_progress", "quiesced", "event:execution_completed"]);
    expect(faulted.eventsAfterQuiesce).toBe(1);
    expectSameExcept(faulted, honest, ["quiesceOrder", "eventsAfterQuiesce"]);
  });

  it("foreignDeviceJob changes the binding of exactly one event", async () => {
    const honest = await lifecycle();
    const faulted = await lifecycle("foreignDeviceJob");
    expect(faulted.bindingValues).toEqual(["work-1-foreign", "work-1"]);
    const repaired = structuredClone(faulted);
    repaired.bindingValues[0] = "work-1";
    repaired.payloads[0]!.deviceJobId = "work-1";
    expect(repaired).toEqual(honest);
  });

  it("foreignDeviceJob substitutes a distinct numeric identity even at finite-number limits", async () => {
    for (const deviceJobId of [Number.MAX_VALUE, 1]) {
      const honest = await lifecycle(undefined, {}, deviceJobId);
      const faulted = await lifecycle("foreignDeviceJob", {}, deviceJobId);
      expect(faulted.bindingValues[0]).not.toBe(deviceJobId);
      expect(faulted.bindingValues[0]).toBe(deviceJobId === 1 ? 2 : 1);
      const repaired = structuredClone(faulted);
      repaired.bindingValues[0] = deviceJobId;
      repaired.payloads[0]!.deviceJobId = deviceJobId;
      expect(repaired).toEqual(honest);
    }
  });

  it("unboundTerminal removes only the terminal event's binding", async () => {
    const honest = await lifecycle();
    const faulted = await lifecycle("unboundTerminal");
    expect(faulted.bindingValues).toEqual(["work-1", undefined]);
    expect(faulted.payloads[1]).not.toHaveProperty("deviceJobId");
    const repaired = structuredClone(faulted);
    repaired.bindingValues[1] = "work-1";
    repaired.payloads[1]!.deviceJobId = "work-1";
    expect(repaired).toEqual(honest);
  });

  it("noDeviceJobId changes only the accepted start result", async () => {
    const honest = await lifecycle();
    const faulted = await lifecycle("noDeviceJobId");
    expect(honest.start).toEqual({ success: true, data: { jobId: "work-1" } });
    expect(faulted.start).toEqual({ success: true, data: {} });
    expectSameExcept(faulted, honest, ["start"]);
  });

  it("busyWithoutFlag removes both busy flags and preserves the refusal", async () => {
    const honest = await busy();
    const faulted = await busy("busyWithoutFlag");
    expect(honest.start.busy).toBe(true);
    expect(honest.start.data?.busy).toBe(true);
    expect(faulted.start).not.toHaveProperty("busy");
    expect(faulted.start.data).not.toHaveProperty("busy");
    expect(faulted.start).toEqual({ success: false, message: honest.start.message, data: { code: "busy" } });
    expectSameExcept(faulted, honest, ["start"]);
  });

  it("cancelOtherJob changes only the cancellation target and its immediate outcome", async () => {
    const honest = await cancellation();
    const faulted = await cancellation("cancelOtherJob");
    expect(honest.eventsAtCancel).toBe(1);
    expect(honest.statusAtCancel).toBe("busy");
    expect(faulted.eventsAtCancel).toBe(2);
    expect(faulted.statusAtCancel).toBe("idle");
    expect(honest.cancels).toEqual(["other-work"]);
    expect(faulted.cancels).toEqual(["work-1"]);
    expectSameExcept(faulted, honest, ["cancels", "eventsAtCancel", "statusAtCancel"]);
  });

  it("stopInsteadOfCancel changes only the command path and its immediate stop", async () => {
    const honest = await cancellation(undefined, true);
    const faulted = await cancellation("stopInsteadOfCancel", true);
    expect(honest.commands).toEqual([{ type: "start" }]);
    expect(honest.cancels).toEqual(["work-1"]);
    expect(faulted.commands).toEqual([{ type: "start" }, { type: "stop" }]);
    expect(faulted.cancels).toEqual([]);
    expect(honest.eventsAtCancel).toBe(1);
    expect(faulted.eventsAtCancel).toBe(2);
    expect(honest.statusAtCancel).toBe("busy");
    expect(faulted.statusAtCancel).toBe("idle");
    expectSameExcept(faulted, honest, ["commands", "cancels", "eventsAtCancel", "statusAtCancel"]);
  });

  it("emitAfterDispose adds exactly one event after disposal resolves", async () => {
    const honest = await lifecycle();
    const faulted = await lifecycle("emitAfterDispose");
    expect(honest.eventsAfterDispose).toBe(0);
    expect(faulted.eventsAfterDispose).toBe(1);
    expect(faulted.bindingValues.at(-1)).toBe("work-1");
    expectSameExcept(withoutLastEvent(faulted), honest, ["eventsAfterDispose", "eventsAfterQuiesce"]);
  });

  it("emitAfterDispose adds one bound tagged event when start emitted no evidence", async () => {
    const run = async (fault?: DeviceFault): Promise<Observation> => {
      const device = new FakeDevice("device-1", "kernel-1", { preset: "ipp" });
      const adapter = fault ? withFault(device, fault) : device;
      const observed = observe(device, adapter);
      device.scriptStart({ outcome: "accept", deviceJobId: 41 });
      const start = await adapter.execute({ type: "start" });
      expect(observed.events).toEqual([]);
      const quiescence = observed.quiesce();
      const result = await observed.finish(start);
      await quiescence;
      return result;
    };
    const honest = await run();
    const faulted = await run("emitAfterDispose");
    expect(honest.eventsAfterDispose).toBe(0);
    expect(faulted.eventsAfterDispose).toBe(1);
    expect(faulted.eventTypes).toEqual(["execution_progress"]);
    expect(faulted.bindingValues).toEqual([41]);
    expect(faulted.sources[0]!.simulated).toBe(true);
    expect(faulted.payloads[0]!.mock).toBe(true);
    expectSameExcept(withoutLastEvent(faulted), honest, ["eventsAfterDispose", "eventsAfterQuiesce"]);
  });

  it("untagged removes exactly the two independent fabrication signals", async () => {
    const honest = await lifecycle();
    const faulted = await lifecycle("untagged");
    expect(honest.tags).toEqual([{ simulated: true, mock: true }, { simulated: true, mock: true }]);
    expect(faulted.tags).toEqual([{ simulated: undefined, mock: undefined }, { simulated: undefined, mock: undefined }]);
    for (const source of faulted.sources) expect(source).not.toHaveProperty("simulated");
    for (const payload of faulted.payloads) expect(payload).not.toHaveProperty("mock");
    const repaired = structuredClone(faulted);
    repaired.tags = honest.tags;
    for (const source of repaired.sources) source.simulated = true;
    for (const payload of repaired.payloads) payload.mock = true;
    expect(repaired).toEqual(honest);
  });

  it("terminal-role faults honor the configured vocabulary and binding key", async () => {
    const options: FakeDeviceOptions = {
      bindingKey: "operationId",
      startedType: "sequence_started",
      progressType: "batch_sample_result",
      completedType: "batch_session_completed",
      failedType: "sensor_anomaly_detected",
    };
    const honest = await lifecycle(undefined, options);
    const faulted = await lifecycle("unboundTerminal", options);
    expect(honest.eventTypes).toEqual(["batch_sample_result", "batch_session_completed"]);
    expect(faulted.payloads[0]).toHaveProperty("operationId", "work-1");
    expect(faulted.payloads[1]).not.toHaveProperty("operationId");
    const repaired = structuredClone(faulted);
    repaired.bindingValues[1] = "work-1";
    repaired.payloads[1]!.operationId = "work-1";
    expect(repaired).toEqual(honest);
  });
});
