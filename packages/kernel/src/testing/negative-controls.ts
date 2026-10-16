import type { MachineAdapter } from "../adapters/types.js";
import type {
  ClauseId, ClauseStatus, ConformanceProfile, ConformanceTiming, MakeAdapter,
} from "../conformance/clauses.js";
import { FakeDevice, type FakeDeviceOptions } from "./fake-device.js";
import { SHIPPED_DEVICE_FAULTS, withDeviceFault, type ShippedDeviceFault } from "./faults.js";

export interface NegativeControlOptions {
  preset?: "ipp";
  bindingKey?: string;
  /** Only outcome-neutral metadata, event vocabulary, clock and cancel timing/order; checked at generation. */
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

// Metadata and timestamps do not affect clauses. Event roles are shared with the
// profile; cancellation keeps report behavior and stays inside C4's window.
const neutralDeviceKeys = new Set([
  "type", "deviceType", "startedType", "progressType", "completedType", "failedType",
  "clock", "cancelEventOrder", "cancelConfirmMs",
]);

// Payload fields written by FakeDevice/faults or inspected by the runner must
// never double as job bindings, including the unreachable silent-cancel fields.
// Keep FakeDevice's own jobId/mock/origin restrictions independently enforced.
const payloadKeys = new Set([
  "progress", "state", "reason", "jobStateReasons", "jobId", "mock", "origin",
  "settlementUnitId", "challengeNonce",
]);

function validateBindingKey(bindingKey: unknown): void {
  if (bindingKey === undefined) return;
  if (typeof bindingKey !== "string" || bindingKey.trim().length === 0) {
    throw new TypeError("Invalid negative control bindingKey: must be a nonempty string");
  }
  if (payloadKeys.has(bindingKey)) {
    throw new TypeError(`Invalid negative control bindingKey: ${bindingKey} collides with a payload field`);
  }
}

function validateDeviceOptions(options: NegativeControlOptions): FakeDeviceOptions {
  const device = options.deviceOptions;
  if (device === undefined) return {};
  if (device === null || typeof device !== "object" || Array.isArray(device)) {
    throw new TypeError("Invalid negative control deviceOptions");
  }
  const snapshot: FakeDeviceOptions = {};
  for (const key of Reflect.ownKeys(device)) {
    if (typeof key !== "string" || !neutralDeviceKeys.has(key)) {
      throw new TypeError(`Unsupported negative control deviceOptions key: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(device, key)!;
    if ("get" in descriptor || "set" in descriptor) {
      throw new TypeError(`Unsupported negative control deviceOptions accessor: ${key}`);
    }
    Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true });
  }
  for (const [key, opposite] of [
    ["completedType", "execution_failed"], ["failedType", "execution_completed"],
  ] as const) {
    if (snapshot[key] === opposite) throw new TypeError(`Invalid negative control deviceOptions.${key}`);
  }
  if (snapshot.cancelConfirmMs !== undefined) {
    const timing = { ...defaultTiming, ...options.timing };
    const window = timing.cancelConfirmMs + timing.pollMs + timing.settleMs;
    const ms = snapshot.cancelConfirmMs;
    // The runner installs its timeout before cancellation: leave room before it.
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 ||
        ms > 2_147_483_647 || !(ms < window)) {
      throw new TypeError("Invalid negative control deviceOptions.cancelConfirmMs: must fit inside the profile cancel window");
    }
  }
  return snapshot;
}

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

/** Private scripting for generated controls; inspection fixtures live in tests. */
function fakeDeviceConformanceFixture(
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
  const makeAdapter = (): MachineAdapter => {
    const device = new FakeDevice("conformance-device", "conformance-kernel", deviceOptions);
    const adapter = wrap?.(device) ?? device;
    devices.set(adapter, device);
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
  return { makeAdapter, profile };
}

/**
 * Self-tests of the local conformance contract, using fresh FakeDevices only.
 * The C6 control changes the profile to real over honestly tagged mock events.
 * No control removes either fabrication signal or certifies physical equipment.
 */
export function generateNegativeControls(options: NegativeControlOptions = {}): NegativeControls {
  const bindingKey = options.bindingKey;
  validateBindingKey(bindingKey);
  const deviceOptions = validateDeviceOptions(options);
  const fixtureOptions = { preset: options.preset, bindingKey, deviceOptions, timing: options.timing };
  const baseline = fakeDeviceConformanceFixture(fixtureOptions);
  const honest: NegativeControl = {
    id: "honest", clauseId: undefined, fault: undefined,
    makeAdapter: baseline.makeAdapter, profile: baseline.profile, expected: passVector(),
  };
  const controls: NegativeControl[] = SHIPPED_DEVICE_FAULTS.map((fault) => {
    const fixture = fakeDeviceConformanceFixture(fixtureOptions, (device) => withDeviceFault(device, fault));
    const clauseId = faultClauses[fault];
    const expected = passVector();
    expected[clauseId] = "fail";
    if (fault === "noCancelJob") expected.C4 = "n/a";
    return { id: fault, clauseId, fault, makeAdapter: fixture.makeAdapter, profile: fixture.profile, expected };
  });
  const modeFlip = fakeDeviceConformanceFixture(fixtureOptions);
  controls.push({
    id: "modeFlip", clauseId: "C6", fault: "modeFlip",
    makeAdapter: modeFlip.makeAdapter,
    profile: { ...modeFlip.profile, mode: "real" },
    expected: { ...passVector(), C6: "fail" },
  });
  return { honest, controls };
}
