import type { MachineAdapter } from "../adapters/types.js";
import type {
  ClauseId, ClauseStatus, ConformanceProfile, ConformanceTiming, MakeAdapter,
} from "../conformance/clauses.js";
import { FakeDevice, type FakeDeviceOptions } from "./fake-device.js";
import { SHIPPED_DEVICE_FAULTS, withDeviceFault, type ShippedDeviceFault } from "./faults.js";

export interface NegativeControlOptions {
  preset?: "ipp";
  bindingKey?: string;
  /** Includes the started/progress/completed/failed event vocabulary. */
  deviceOptions?: FakeDeviceOptions;
  timing?: Partial<ConformanceTiming>;
}

export interface NegativeControl {
  id: string;
  /** Undefined for the honest baseline. */
  clauseId: ClauseId | undefined;
  fault: ShippedDeviceFault | "modeFlip" | undefined;
  makeAdapter: MakeAdapter;
  profile: ConformanceProfile;
  expected: Record<ClauseId, ClauseStatus>;
}

export interface NegativeControls {
  honest: NegativeControl;
  controls: NegativeControl[];
}

// Fake work finishes synchronously. Generous operation bounds absorb CI stalls;
// short observation windows still cover the queued setImmediate replays.
const defaultTiming: ConformanceTiming = {
  cancelConfirmMs: 100,
  pollMs: 10,
  jobTimeoutMs: 1_000,
  quiesceTimeoutMs: 500,
  settleMs: 25,
};

const faultClauses: Record<ShippedDeviceFault, ClauseId> = {
  emitAfterQuiesce: "C1",
  quiesceEarly: "C1",
  foreignDeviceJob: "C2",
  unboundTerminal: "C2",
  noDeviceJobId: "C2",
  busyWithoutFlag: "C5",
  cancelOtherJob: "C4",
  stopInsteadOfCancel: "C4",
  emitAfterDispose: "C7",
  doubleTerminal: "C3",
  payloadJobId: "C8",
  noCancelJob: "C9",
  acceptsUndeclared: "C10",
};

function passVector(): Record<ClauseId, ClauseStatus> {
  return {
    C1: "pass", C2: "pass", C3: "pass", C4: "pass", C5: "pass",
    C6: "pass", C7: "pass", C8: "pass", C9: "pass", C10: "pass",
  };
}

/** Shared scripting for the generator and the kernel's internal test fixtures. */
export function fakeDeviceConformanceFixture(
  options: NegativeControlOptions = {},
  wrap?: (device: FakeDevice) => MachineAdapter,
) {
  const timing = { ...defaultTiming, ...options.timing };
  const deviceOptions: FakeDeviceOptions = {
    startedEvent: "inside-start",
    ...options.deviceOptions,
    ...(options.preset === undefined ? {} : { preset: options.preset }),
    ...(options.bindingKey === undefined ? {} : { bindingKey: options.bindingKey }),
    cancelConfirmMs: options.deviceOptions?.cancelConfirmMs ?? timing.cancelConfirmMs,
  };
  const ipp = deviceOptions.preset === "ipp";
  const devices = new WeakMap<MachineAdapter, FakeDevice>();
  const made: Array<{ adapter: MachineAdapter; device: FakeDevice }> = [];
  const makeAdapter = (): MachineAdapter => {
    const device = new FakeDevice("conformance-device", "conformance-kernel", deviceOptions);
    const adapter = wrap?.(device) ?? device;
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

/**
 * Self-tests of the local conformance contract, using fresh FakeDevices only.
 * The C6 control changes the profile to real over honestly tagged mock events.
 * No control removes either fabrication signal or certifies physical equipment.
 */
export function generateNegativeControls(options: NegativeControlOptions = {}): NegativeControls {
  const baseline = fakeDeviceConformanceFixture(options);
  const honest: NegativeControl = {
    id: "honest", clauseId: undefined, fault: undefined,
    makeAdapter: baseline.makeAdapter, profile: baseline.profile, expected: passVector(),
  };
  const controls: NegativeControl[] = SHIPPED_DEVICE_FAULTS.map((fault) => {
    const fixture = fakeDeviceConformanceFixture(options, (device) => withDeviceFault(device, fault));
    const clauseId = faultClauses[fault];
    const expected = passVector();
    expected[clauseId] = "fail";
    if (fault === "noCancelJob") expected.C4 = "n/a";
    return { id: fault, clauseId, fault, makeAdapter: fixture.makeAdapter, profile: fixture.profile, expected };
  });
  const modeFlip = fakeDeviceConformanceFixture(options);
  controls.push({
    id: "modeFlip", clauseId: "C6", fault: "modeFlip",
    makeAdapter: modeFlip.makeAdapter,
    profile: { ...modeFlip.profile, mode: "real" },
    expected: { ...passVector(), C6: "fail" },
  });
  return { honest, controls };
}
