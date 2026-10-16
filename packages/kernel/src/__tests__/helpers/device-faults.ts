import type { MachineAdapter } from "../../adapters/types.js";
import type { FakeDevice } from "../../testing/fake-device.js";
import { withDeviceFault } from "../../testing/faults.js";

export const DEVICE_FAULTS = [
  "emitAfterQuiesce", "quiesceEarly", "foreignDeviceJob", "unboundTerminal",
  "noDeviceJobId", "busyWithoutFlag", "cancelOtherJob", "stopInsteadOfCancel",
  "emitAfterDispose", "untagged",
  "doubleTerminal", "payloadJobId", "noCancelJob", "acceptsUndeclared",
] as const;

export type DeviceFault = typeof DEVICE_FAULTS[number];

/** Only this test helper can remove FakeDevice's two fabrication signals. */
export function withFault(device: FakeDevice, fault: DeviceFault): MachineAdapter {
  if (fault !== "untagged") return withDeviceFault(device, fault);
  return {
    id: device.id,
    type: device.type,
    source: device.source,
    execute: (command) => device.execute(command),
    cancelJob: (id) => device.cancelJob(id),
    getStatus: () => device.getStatus(),
    getProgress: () => device.getProgress(),
    quiesceEvidence: () => device.quiesceEvidence(),
    dispose: () => device.dispose(),
    onEvidence(listener) {
      device.onEvidence((incoming) => {
        const event = structuredClone(incoming);
        delete event.source.simulated;
        delete event.payload.mock;
        listener(event);
      });
    },
  };
}
