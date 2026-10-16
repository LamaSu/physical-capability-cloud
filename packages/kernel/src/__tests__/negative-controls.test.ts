import { beforeAll, describe, expect, it } from "vitest";
import { isFabricated, type EvidenceEvent } from "@pcc/spec";
import type { MachineAdapter } from "../adapters/types.js";
import {
  CLAUSES, runAdapterConformance, type ClauseId, type ClauseStatus, type ConformanceProfile, type ConformanceReport,
} from "../conformance/index.js";
import {
  generateNegativeControls, SHIPPED_DEVICE_FAULTS,
  type NegativeControl, type NegativeControlOptions, type ShippedDeviceFault,
} from "../testing/index.js";
import { fakeConformanceFixture } from "./helpers/conformance-fixtures.js";

type DeviceEvent = Omit<EvidenceEvent, "id" | "hash">;
type Fault = ShippedDeviceFault | "modeFlip";

// Independent contract oracle: neither targets nor reasons come from the generator.
const faults: Record<Fault, { clauseId: ClauseId; reason: string }> = {
  emitAfterQuiesce: { clauseId: "C1", reason: "Evidence arrived after quiesce resolved." },
  quiesceEarly: { clauseId: "C1", reason: "Quiesce resolved before terminal delivery." },
  foreignDeviceJob: { clauseId: "C2", reason: "Evidence did not strictly bind to the accepted device job id." },
  unboundTerminal: { clauseId: "C2", reason: "Evidence did not strictly bind to the accepted device job id." },
  noDeviceJobId: { clauseId: "C2", reason: "Accepted start did not return a device job id." },
  busyWithoutFlag: { clauseId: "C5", reason: "Second start did not refuse with busy true." },
  cancelOtherJob: { clauseId: "C4", reason: "Foreign cancellation emitted a failed terminal." },
  stopInsteadOfCancel: { clauseId: "C4", reason: "Foreign cancellation emitted a failed terminal." },
  emitAfterDispose: { clauseId: "C7", reason: "Evidence arrived after dispose resolved." },
  doubleTerminal: { clauseId: "C3", reason: "Job did not emit exactly one terminal event." },
  payloadJobId: { clauseId: "C8", reason: "Evidence supplied a foreign PCC job id or a reserved unit field." },
  noCancelJob: { clauseId: "C9", reason: "Physical adapter has no cancelJob function." },
  acceptsUndeclared: { clauseId: "C10", reason: "Undeclared command was not refused." },
  modeFlip: { clauseId: "C6", reason: "Evidence fabrication tags disagree with profile mode." },
};

function contractVector(fault: Fault | undefined): Record<ClauseId, ClauseStatus> {
  return Object.fromEntries(CLAUSES.map(({ id }) => [id,
    fault === "noCancelJob" && id === "C4" ? "n/a"
      : fault !== undefined && id === faults[fault].clauseId ? "fail" : "pass",
  ])) as Record<ClauseId, ClauseStatus>;
}

/** Accept the clause list so additions cannot hide behind today's closed union. */
function assertClauseCoverage(
  clauses: readonly { id: string }[],
  controls: readonly { clauseId: string | undefined }[],
): void {
  const required = new Set(clauses.map(({ id }) => id));
  const covered = new Set(controls.map(({ clauseId }) => clauseId));
  const missing = [...required].filter((id) => !covered.has(id));
  const unexpected = [...covered].filter((id) => id === undefined || !required.has(id));
  if (missing.length || unexpected.length) {
    throw new Error(`Missing controls: ${missing.join(", ")}; unexpected clauses: ${unexpected.join(", ")}`);
  }
}

function generatedEntries() {
  const { honest, controls } = generateNegativeControls();
  return [honest, ...controls];
}

function clauseOutcomes(report: ConformanceReport) {
  return Object.fromEntries(report.clauses.map(({ id, status, reason }) => [id, { status, reason }]));
}

function profileData({ name, kind, mode, bindingKey, declaredCommands, busy, terminalEvents }: ConformanceProfile) {
  return { name, kind, mode, bindingKey, declaredCommands, busy, terminalEvents };
}

interface Delivery {
  event: DeviceEvent;
  afterQuiesce: boolean;
  afterDispose: boolean;
}

interface CapturedAdapter {
  clauseId: ClauseId;
  adapter: MachineAdapter;
  deliveries: Delivery[];
}

/** Keep our listener installed across every observation and cleanup boundary. */
async function captureWholeRun(entry: NegativeControl) {
  const captured: CapturedAdapter[] = [];
  const report = await runAdapterConformance(async () => {
    const adapter = await entry.makeAdapter();
    const capture: CapturedAdapter = {
      clauseId: CLAUSES[captured.length].id,
      adapter,
      deliveries: [],
    };
    captured.push(capture);
    let afterQuiesce = false;
    let afterDispose = false;
    adapter.onEvidence((event) => {
      capture.deliveries.push({ event: structuredClone(event), afterQuiesce, afterDispose });
    });
    const execute = adapter.execute.bind(adapter);
    adapter.execute = (command) => {
      if (command.type === "start") afterQuiesce = false;
      return execute(command);
    };
    const quiesce = adapter.quiesceEvidence.bind(adapter);
    adapter.quiesceEvidence = async () => { await quiesce(); afterQuiesce = true; };
    const dispose = adapter.dispose.bind(adapter);
    adapter.dispose = async () => { await dispose(); afterDispose = true; };
    return adapter;
  }, entry.profile);
  // The disposal fault deliberately schedules a delivery after dispose resolves.
  // Drain that turn even for clauses with no runner silence-observation window.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { captured, report };
}

describe("generated adapter conformance negative controls", () => {
  let defaultOutcomes: Map<string, ReturnType<typeof clauseOutcomes>>;
  beforeAll(async () => {
    defaultOutcomes = new Map(await Promise.all(generatedEntries().map(async (entry) => [
      entry.id, clauseOutcomes(await runAdapterConformance(entry.makeAdapter, entry.profile)),
    ] as const)));
  });

  it.each([
    "progress", "state", "reason", "jobStateReasons", "jobId", "mock", "origin",
    "settlementUnitId", "challengeNonce",
  ])("refuses payload collision bindingKey %s at generation", (bindingKey) => {
    expect(() => generateNegativeControls({ bindingKey })).toThrow(new TypeError(
      `Invalid negative control bindingKey: ${bindingKey} collides with a payload field`,
    ));
  });

  it.each(["", "   ", null, 0, true, {}, []])("refuses invalid bindingKey %j at generation", (bindingKey) => {
    expect(() => generateNegativeControls({ bindingKey } as NegativeControlOptions)).toThrow(new TypeError(
      "Invalid negative control bindingKey: must be a nonempty string",
    ));
  });

  it("refuses every delivered payload key except the binding across the whole control set", async () => {
    const entries = generatedEntries();
    const runs = await Promise.all(entries.map(captureWholeRun));
    const deliveredKeys = new Set(runs.flatMap(({ captured }) => captured.flatMap(({ deliveries }) =>
      deliveries.flatMap(({ event }) => Object.keys(event.payload)),
    )));
    const bindingKey = entries[0].profile.bindingKey;
    const otherKeys = [...deliveredKeys].filter((key) => key !== bindingKey);
    // Pin the number of refusal assertions too: skipping a delivered key must fail.
    expect.assertions(otherKeys.length + 2);
    expect(deliveredKeys.has(bindingKey)).toBe(true);
    expect(otherKeys.length).toBeGreaterThan(0);
    for (const key of otherKeys) {
      expect(() => generateNegativeControls({ bindingKey: key })).toThrow(new TypeError(
        `Invalid negative control bindingKey: ${key} collides with a payload field`,
      ));
    }
  });

  it("bindingKey runId preserves the whole control set including honest", async () => {
    const { honest, controls } = generateNegativeControls({ bindingKey: "runId" });
    await Promise.all([honest, ...controls].map(async (entry) => {
      expect(entry.profile.bindingKey).toBe("runId");
      const report = await runAdapterConformance(entry.makeAdapter, entry.profile);
      expect(Object.fromEntries(report.clauses.map(({ id, status }) => [id, status])), entry.id)
        .toEqual(entry.expected);
      expect(entry.expected, entry.id).toEqual(contractVector(entry.fault));
      expect(clauseOutcomes(report), entry.id).toEqual(defaultOutcomes.get(entry.id));
    }));
  });

  it.each([
    ["preset", "ipp"],
    ["bindingKey", "runId"],
    ["declaredCommands", ["load_gcode", "start", "pause", "resume", "stop", "status"]],
    ["startedEvent", "none"],
    ["cancelBehavior", "refuse"],
    ["unknownOption", true],
  ])("refuses deviceOptions key %s at generation", (key, value) => {
    const generate = () => generateNegativeControls({ deviceOptions: { [key]: value } });
    expect(generate).toThrow(TypeError);
    expect(generate).toThrow(key);
  });

  it.each(["cancelBehavior", "declaredCommands", "unknownOption"])(
    "refuses even an undefined deviceOptions key %s", (key) => {
      expect(() => generateNegativeControls({ deviceOptions: { [key]: undefined } }))
        .toThrow(new TypeError(`Unsupported negative control deviceOptions key: ${key}`));
    },
  );

  it.each([Symbol("unknownOption"), "hiddenOption"])("refuses unknown own key %s", (key) => {
    const deviceOptions = Object.defineProperty({}, key, { value: true, enumerable: false });
    expect(() => generateNegativeControls({ deviceOptions }))
      .toThrow(new TypeError(`Unsupported negative control deviceOptions key: ${String(key)}`));
  });

  it.each([
    ["completedType", "execution_failed"], ["failedType", "execution_completed"],
  ] as const)("refuses opposite native terminal role for %s", (key, value) => {
    expect(() => generateNegativeControls({ deviceOptions: { [key]: value } }))
      .toThrow(new TypeError(`Invalid negative control deviceOptions.${key}`));
  });

  it.each(["get", "set"] as const)("refuses deviceOptions completedType %s accessor without calling it", (kind) => {
    let calls = 0;
    const accessor = () => { calls += 1; return "execution_completed"; };
    const deviceOptions = Object.defineProperty({}, "completedType", { [kind]: accessor, enumerable: true });
    expect(() => generateNegativeControls({ deviceOptions })).toThrow(new TypeError(
      "Unsupported negative control deviceOptions accessor: completedType",
    ));
    expect(calls).toBe(0);
  });

  it("snapshots deviceOptions once before building every fixture", () => {
    let reads = 0;
    const deviceOptions = new Proxy({ type: "custom-machine" }, {
      getOwnPropertyDescriptor(target, key) { reads += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
      get() { throw new Error("Caller values must be read through their validated data descriptors"); },
    });
    const { honest, controls } = generateNegativeControls({ deviceOptions });
    expect(controls).toHaveLength(SHIPPED_DEVICE_FAULTS.length + 1);
    expect(honest.profile.name).toBe("FakeDevice generic");
    expect(reads).toBe(1);
  });

  it.each([55, 56, -1, NaN, Infinity, 2_147_483_648])(
    "refuses cancelConfirmMs %s outside the overridden profile cancel window", (cancelConfirmMs) => {
      expect(() => generateNegativeControls({
        timing: { cancelConfirmMs: 40, pollMs: 5, settleMs: 10 },
        deviceOptions: { cancelConfirmMs },
      })).toThrow(new TypeError(
        "Invalid negative control deviceOptions.cancelConfirmMs: must fit inside the profile cancel window",
      ));
    },
  );

  // One complete run per knob value, shared by all vector assertions. Controls
  // run concurrently to bound runtime without shortening observation windows.
  it.each([
    ["type", { type: "custom-machine" }],
    ["deviceType", { deviceType: "camera" }],
    ["startedType", { startedType: "sequence_started" }],
    ["progressType", { progressType: "batch_sample_result" }],
    ["completedType", { completedType: "batch_session_completed" }],
    ["failedType", { failedType: "sensor_anomaly_detected" }],
    ["clock", { clock: () => new Date("2025-01-02T03:04:05.000Z") }],
    ["cancelEventOrder", { cancelEventOrder: "after-resolve" }],
    ["cancelConfirmMs", { cancelConfirmMs: 120 }],
  ] satisfies Array<[string, NonNullable<NegativeControlOptions["deviceOptions"]>]>) (
    "deviceOptions %s preserves the whole control set including honest", async (_key, deviceOptions) => {
      const { honest, controls } = generateNegativeControls({ deviceOptions });
      await Promise.all([honest, ...controls].map(async (entry) => {
        const report = await runAdapterConformance(entry.makeAdapter, entry.profile);
        expect(Object.fromEntries(report.clauses.map(({ id, status }) => [id, status])), entry.id)
          .toEqual(entry.expected);
        expect(entry.expected, entry.id).toEqual(contractVector(entry.fault));
        expect(clauseOutcomes(report), entry.id).toEqual(defaultOutcomes.get(entry.id));
      }));
    },
  );

  it("ships exactly one control per shipped fault plus the honestly tagged mode flip", () => {
    const { honest, controls } = generateNegativeControls();
    expect(controls.map(({ fault }) => fault)).toEqual([...SHIPPED_DEVICE_FAULTS, "modeFlip"]);
    expect(controls).toHaveLength(Object.keys(faults).length);
    expect(new Set([honest, ...controls].map(({ id }) => id)).size).toBe(controls.length + 1);
    expect(honest).toMatchObject({ id: "honest", clauseId: undefined, fault: undefined });
    expect(honest.profile.mode).toBe("mock");
    expect(controls.find(({ fault }) => fault === "modeFlip")?.profile.mode).toBe("real");
  });

  it.each([
    {},
    { preset: "ipp" },
    { bindingKey: "runId" },
    { preset: "ipp", bindingKey: "ippJobId" },
    { bindingKey: "runId", deviceOptions: {
      completedType: "batch_session_completed", failedType: "sensor_anomaly_detected",
    } },
  ] satisfies NegativeControlOptions[])("honest profile data matches the test helper for %j", (options) => {
    const { honest } = generateNegativeControls(options);
    const helper = fakeConformanceFixture({
      preset: options.preset,
      deviceOptions: { ...options.deviceOptions, bindingKey: options.bindingKey },
    });
    expect(profileData(honest.profile)).toEqual(profileData(helper.profile));
  });

  it("profile data comparison detects declaredCommands drift", () => {
    const { honest } = generateNegativeControls();
    expect(profileData(honest.profile)).not.toEqual(profileData({
      ...honest.profile, declaredCommands: ["status"],
    }));
  });

  it.each(generatedEntries().map((entry) => [entry.id, entry] as const))(
    "%s matches all ten expected rows and pins the failing reason",
    async (_id, entry) => {
      const report = await runAdapterConformance(entry.makeAdapter, entry.profile);
      expect(report.clauses.map(({ id }) => id)).toEqual(CLAUSES.map(({ id }) => id));
      const actual = Object.fromEntries(report.clauses.map(({ id, status }) => [id, status]));
      expect(actual).toEqual(entry.expected);
      expect(entry.expected).toEqual(contractVector(entry.fault));
      expect(entry.clauseId).toBe(entry.fault === undefined ? undefined : faults[entry.fault].clauseId);
      expect(report.clauses.filter(({ status }) => status === "fail").map(({ id, reason }) => ({ id, reason })))
        .toEqual(entry.fault === undefined ? [] : [{ id: faults[entry.fault].clauseId, reason: faults[entry.fault].reason }]);
      expect(report.clauses.filter(({ status }) => status === "n/a").map(({ id, reason }) => ({ id, reason })))
        .toEqual(entry.fault === "noCancelJob" ? [{ id: "C4", reason: "Adapter has no cancelJob function." }] : []);
    },
  );

  it("covers exactly every shipped clause", () => {
    const { controls } = generateNegativeControls();
    expect(() => assertClauseCoverage(CLAUSES, controls)).not.toThrow();
    expect(new Set(controls.map(({ clauseId }) => clauseId)))
      .toEqual(new Set(CLAUSES.map(({ id }) => id)));
  });

  it("rejects the coverage mutant that drops C10's control", () => {
    const { controls } = generateNegativeControls();
    expect(() => assertClauseCoverage(CLAUSES, controls.filter(({ clauseId }) => clauseId !== "C10")))
      .toThrow("Missing controls: C10;");
  });

  it("rejects a hypothetical new clause without its own control", () => {
    const { controls } = generateNegativeControls();
    const futureClauses = [...CLAUSES, { id: "C11", title: "A future obligation" }];
    expect(() => assertClauseCoverage(futureClauses, controls))
      .toThrow("Missing controls: C11;");
  });

  it.each(generatedEntries().map((entry) => [entry.id, entry] as const))(
    "retains both fabrication tags on every delivery for %s",
    async (_id, entry) => {
      const { captured, report } = await captureWholeRun(entry);
      expect(Object.fromEntries(report.clauses.map(({ id, status }) => [id, status])))
        .toEqual(contractVector(entry.fault));
      expect(captured).toHaveLength(CLAUSES.length);
      expect(new Set(captured.map(({ adapter }) => adapter)).size).toBe(CLAUSES.length);
      for (const capture of captured) {
        // C9 and C10 intentionally do not start jobs; C4 cannot start without cancelJob.
        if (!["C9", "C10"].includes(capture.clauseId) &&
          !(entry.fault === "noCancelJob" && capture.clauseId === "C4")) {
          expect(capture.deliveries.length, `${entry.id}/${capture.clauseId} must deliver evidence`).toBeGreaterThan(0);
        }
        for (const { event } of capture.deliveries) {
          expect(event.source.simulated, `${entry.id}/${capture.clauseId}: source tag`).toBe(true);
          expect(event.payload.mock, `${entry.id}/${capture.clauseId}: payload tag`).toBe(true);
          expect(isFabricated({ ...event, id: "negative-control-event", hash: "sha256:test" })).toBe(true);
        }
      }
      if (entry.fault === "emitAfterQuiesce") {
        const deliveries = captured.find(({ clauseId }) => clauseId === "C1")!.deliveries;
        const last = deliveries.at(-1)!;
        expect(last.afterQuiesce).toBe(true);
        expect(deliveries.filter(({ event }) => JSON.stringify(event) === JSON.stringify(last.event))).toHaveLength(2);
      }
      if (entry.fault === "doubleTerminal") {
        const terminals = captured.find(({ clauseId }) => clauseId === "C3")!.deliveries
          .filter(({ event }) => event.type === "execution_completed");
        expect(terminals).toHaveLength(2);
        expect(terminals[0].event).toEqual(terminals[1].event);
      }
      if (entry.fault === "emitAfterDispose") {
        const deliveries = captured.find(({ clauseId }) => clauseId === "C7")!.deliveries;
        const replay = deliveries.filter(({ afterDispose }) => afterDispose);
        expect(replay).toHaveLength(1);
        expect(replay[0].event).toEqual(deliveries[0].event);
      }
    },
  );

  it("makes fresh independent FakeDevices for every call and every control", async () => {
    const entries = generatedEntries();
    const adapters: MachineAdapter[] = [];
    try {
      for (const entry of entries) adapters.push(await entry.makeAdapter(), await entry.makeAdapter());
      expect(new Set(adapters).size).toBe(entries.length * 2);
      expect(new Set(adapters.map(({ source }) => source)).size).toBe(entries.length * 2);
      for (const adapter of adapters) expect(await adapter.getStatus()).toBe("idle");
    } finally {
      await Promise.all(adapters.map((adapter) => adapter.dispose()));
    }
  });

  it.each([
    ["ipp", { preset: "ipp" }, "cancelOtherJob", "ippJobId"],
    ["custom binding", { bindingKey: "runId" }, "foreignDeviceJob", "runId"],
    ["custom terminal vocabulary", { deviceOptions: {
      startedType: "sequence_started", progressType: "batch_sample_result",
      completedType: "batch_session_completed", failedType: "sensor_anomaly_detected",
    } }, "doubleTerminal", "deviceJobId"],
  ] as const)("supports %s and explicit timing overrides", async (_label, options, fault, bindingKey) => {
    const timing = { cancelConfirmMs: 120, pollMs: 8, settleMs: 20, quiesceTimeoutMs: 700, jobTimeoutMs: 1_200 };
    const { honest, controls } = generateNegativeControls({ ...options, timing } satisfies NegativeControlOptions);
    const control = controls.find((entry) => entry.fault === fault)!;
    for (const entry of [honest, control]) {
      expect(entry.profile.bindingKey).toBe(bindingKey);
      expect(entry.profile.timing).toEqual(timing);
      const report = await runAdapterConformance(entry.makeAdapter, entry.profile);
      expect(Object.fromEntries(report.clauses.map(({ id, status }) => [id, status])))
        .toEqual(contractVector(entry.fault));
    }
    if ("deviceOptions" in options) {
      expect(honest.profile.terminalEvents).toEqual({
        completed: ["batch_session_completed"], failed: ["sensor_anomaly_detected"],
      });
    }
  });
});
