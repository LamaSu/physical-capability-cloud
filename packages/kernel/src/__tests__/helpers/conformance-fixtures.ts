import type { EvidenceEvent } from "@pcc/spec";
import type { MachineAdapter } from "../../adapters/types.js";
import { type FakeDevice, type FakeDeviceOptions } from "../../testing/fake-device.js";
import { fakeDeviceConformanceFixture } from "../../testing/negative-controls.js";
import { withFault, type DeviceFault } from "./device-faults.js";

export type DeviceEvent = Omit<EvidenceEvent, "id" | "hash">;

/** Hooks deliberately resolve the exact returned adapter through a WeakMap. */
export function fakeConformanceFixture(options: {
  preset?: "ipp";
  fault?: DeviceFault;
  deviceOptions?: FakeDeviceOptions;
  wrap?: (device: FakeDevice) => MachineAdapter;
} = {}) {
  return fakeDeviceConformanceFixture({
    preset: options.preset,
    deviceOptions: options.deviceOptions,
    // Preserve the existing report goldens and bounded-operation edge tests.
    timing: { cancelConfirmMs: 35, pollMs: 5, jobTimeoutMs: 100, quiesceTimeoutMs: 50, settleMs: 10 },
  }, (device) => options.wrap?.(device) ?? (options.fault ? withFault(device, options.fault) : device));
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
