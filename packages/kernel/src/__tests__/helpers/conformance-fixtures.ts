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
  // Test-only inspection history: one conformance run creates ten adapters.
  // Each test owns its fixture; shipped controls retain devices only weakly.
  const made: Array<{ adapter: MachineAdapter; device: FakeDevice }> = [];
  // Keep arbitrary device behavior available for runner edge tests without
  // exporting the generator's private fixture or its restricted option policy.
  const timing = { cancelConfirmMs: 35, pollMs: 5, jobTimeoutMs: 100, quiesceTimeoutMs: 50, settleMs: 10 };
  const deviceOptions: FakeDeviceOptions = {
    startedEvent: "inside-start",
    ...options.deviceOptions,
    ...(options.preset === undefined ? {} : { preset: options.preset }),
    cancelConfirmMs: options.deviceOptions?.cancelConfirmMs ?? timing.cancelConfirmMs,
  };
  const ipp = deviceOptions.preset === "ipp";
  const devices = new WeakMap<MachineAdapter, FakeDevice>();
  const makeAdapter = (): MachineAdapter => {
    const device = new FakeDevice("conformance-device", "conformance-kernel", deviceOptions);
    const adapter = options.wrap?.(device) ?? (options.fault ? withFault(device, options.fault) : device);
    devices.set(adapter, device);
    made.push({ adapter, device });
    return adapter;
  };
  const profile: ConformanceProfile = {
    name: ipp ? "FakeDevice ipp" : "FakeDevice generic",
    kind: "physical",
    mode: "mock",
    bindingKey: deviceOptions.bindingKey ?? (ipp ? "ippJobId" : "deviceJobId"),
    declaredCommands: [...(deviceOptions.declaredCommands ?? ["start", "stop", "status"])],
    busy: "second-start",
    timing,
    ...(deviceOptions.completedType === undefined && deviceOptions.failedType === undefined ? {} : {
      terminalEvents: {
        completed: [deviceOptions.completedType ?? "execution_completed"],
        failed: [deviceOptions.failedType ?? "execution_failed"],
      },
    }),
    prepareStart(adapter) {
      devices.get(adapter)!.scriptStart({ outcome: "accept", deviceJobId: ipp ? 41 : "device-job-1" });
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
