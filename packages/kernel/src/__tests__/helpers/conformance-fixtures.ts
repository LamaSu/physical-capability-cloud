import type { EvidenceEvent } from "@pcc/spec";
import type { MachineAdapter } from "../../adapters/types.js";
import type { ConformanceProfile } from "../../conformance/index.js";
import { FakeDevice, type FakeDeviceOptions } from "../../testing/fake-device.js";
import { withFault, type DeviceFault } from "./device-faults.js";

export type DeviceEvent = Omit<EvidenceEvent, "id" | "hash">;

/** Hooks deliberately resolve the exact returned adapter through a WeakMap. */
export function fakeConformanceFixture(options: {
  preset?: "ipp";
  fault?: DeviceFault;
  deviceOptions?: FakeDeviceOptions;
  wrap?: (device: FakeDevice) => MachineAdapter;
} = {}) {
  const devices = new WeakMap<MachineAdapter, FakeDevice>();
  const made: Array<{ adapter: MachineAdapter; device: FakeDevice }> = [];
  const makeAdapter = (): MachineAdapter => {
    const device = new FakeDevice("conformance-device", "conformance-kernel", {
      ...(options.preset ? { preset: options.preset } : {}),
      startedEvent: "inside-start",
      cancelConfirmMs: 35,
      ...options.deviceOptions,
    });
    const adapter = options.wrap?.(device) ?? (options.fault ? withFault(device, options.fault) : device);
    devices.set(adapter, device);
    made.push({ adapter, device });
    return adapter;
  };
  const profile: ConformanceProfile = {
    name: options.preset ? "FakeDevice ipp" : "FakeDevice generic",
    kind: "physical",
    mode: "mock",
    bindingKey: options.preset ? "ippJobId" : "deviceJobId",
    declaredCommands: ["start", "stop", "status"],
    busy: "second-start",
    timing: {
      cancelConfirmMs: 35,
      pollMs: 5,
      jobTimeoutMs: 100,
      quiesceTimeoutMs: 50,
      settleMs: 10,
    },
    prepareStart(adapter) {
      const device = devices.get(adapter)!;
      device.scriptStart({ outcome: "accept", deviceJobId: options.preset ? 41 : "device-job-1" });
    },
    startCommand: (_adapter, { pccJobId }) => ({ type: "start", payload: { pccJobId } }),
    finish(adapter) {
      const device = devices.get(adapter)!;
      device.progress(25);
      device.complete();
    },
  };
  return { makeAdapter, profile, made };
}

/** A forwarding adapter retains each device method's original receiver. */
export function forwardAdapter(device: FakeDevice): MachineAdapter {
  return {
    id: device.id,
    type: device.type,
    source: device.source,
    execute: (command) => device.execute(command),
    cancelJob: (id) => device.cancelJob(id),
    getStatus: () => device.getStatus(),
    getProgress: () => device.getProgress(),
    onEvidence: (listener) => device.onEvidence(listener),
    quiesceEvidence: () => device.quiesceEvidence(),
    dispose: () => device.dispose(),
  };
}

export function transformEvents(
  device: FakeDevice,
  transform: (event: DeviceEvent) => DeviceEvent,
): MachineAdapter {
  const adapter = forwardAdapter(device);
  adapter.onEvidence = (listener) => device.onEvidence((event) => listener(transform(structuredClone(event))));
  return adapter;
}

export const PASS_VECTOR = Array.from({ length: 10 }, () => "pass");

export function faultVector(clause: string, extra: Record<string, string> = {}): string[] {
  return PASS_VECTOR.map((status, index) => extra[`C${index + 1}`] ?? (`C${index + 1}` === clause ? "fail" : status));
}
