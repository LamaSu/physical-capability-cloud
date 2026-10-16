import type { MachineAdapter } from "../adapters/types.js";
import type { ConformanceProfile } from "../conformance/index.js";
import { describeAdapterConformance } from "../conformance/vitest.js";
import { FakeDevice } from "../testing/fake-device.js";

const devices = new WeakMap<MachineAdapter, FakeDevice>();
const makeAdapter = (): MachineAdapter => {
  const device = new FakeDevice("vitest-conformance-device", "vitest-conformance-kernel");
  devices.set(device, device);
  return device;
};

const profile: ConformanceProfile = {
  name: "honest FakeDevice through Vitest",
  kind: "physical",
  mode: "mock",
  bindingKey: "deviceJobId",
  declaredCommands: ["start", "stop", "status"],
  busy: "second-start",
  timing: {
    cancelConfirmMs: 20,
    pollMs: 2,
    jobTimeoutMs: 100,
    quiesceTimeoutMs: 50,
    settleMs: 5,
  },
  prepareStart: (adapter) => {
    devices.get(adapter)!.scriptStart({ outcome: "accept", deviceJobId: 41 });
  },
  startCommand: () => ({ type: "start" }),
  finish: (adapter) => { devices.get(adapter)!.complete(); },
};

describeAdapterConformance("describeAdapterConformance honest FakeDevice", makeAdapter, profile);
