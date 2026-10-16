import { describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import type { MachineAdapter } from "../adapters/types.js";
import type { ConformanceProfile } from "../conformance/index.js";
import { runAdapterConformance } from "../conformance/index.js";
import {
  fakeConformanceFixture, faultVector, forwardAdapter, PASS_VECTOR, type DeviceEvent,
} from "./helpers/conformance-fixtures.js";

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Observation exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

const invalidProfiles: Array<{ label: string; field: string; invalid: Record<string, unknown> }> = [
  ...["jobId", "settlementUnitId", "challengeNonce", "mock", "origin"].map((bindingKey) => ({
    label: `reserved binding ${bindingKey}`, field: "bindingKey", invalid: { bindingKey },
  })),
  { label: "commands missing start", field: "declaredCommands", invalid: { declaredCommands: ["stop", "status"] } },
  { label: "duplicate command", field: "declaredCommands", invalid: { declaredCommands: ["start", "start"] } },
  {
    label: "overlapping terminals", field: "terminalEvents overlap",
    invalid: { terminalEvents: { completed: ["batch_session_completed"], failed: ["batch_session_completed"] } },
  },
  {
    label: "completed native failure", field: "terminalEvents overlap",
    invalid: { terminalEvents: { completed: ["execution_failed"], failed: ["sensor_anomaly_detected"] } },
  },
  {
    label: "failed native completion", field: "terminalEvents overlap",
    invalid: { terminalEvents: { completed: ["batch_session_completed"], failed: ["execution_completed"] } },
  },
  ...(["completed", "failed"] as const).flatMap((list) => [
    { label: `empty ${list} terminals`, field: `terminalEvents.${list}`, invalid: {
      terminalEvents: { completed: ["execution_completed"], failed: ["execution_failed"], [list]: [] },
    } },
    { label: `unknown ${list} terminal`, field: `terminalEvents.${list}`, invalid: {
      terminalEvents: { completed: ["execution_completed"], failed: ["execution_failed"], [list]: ["unknown_event"] },
    } },
    { label: `duplicate ${list} terminal`, field: `terminalEvents.${list}`, invalid: {
      terminalEvents: {
        completed: ["execution_completed"], failed: ["execution_failed"],
        [list]: list === "completed" ? ["execution_completed", "execution_completed"] : ["execution_failed", "execution_failed"],
      },
    } },
  ]),
  ...(["prepareStart", "finish"] as const).map((field) => ({
    label: `non-function ${field}`, field, invalid: { [field]: "not a function" },
  })),
];

describe("adapter conformance observations", () => {
  it.each(invalidProfiles)("rejects invalid profile $label before making any adapter", async ({ field, invalid }) => {
    const fixture = fakeConformanceFixture();
    const makeAdapter = vi.fn(fixture.makeAdapter);
    const profile = { ...fixture.profile, ...invalid } as ConformanceProfile;
    const result = runAdapterConformance(makeAdapter, profile);
    await expect(result).rejects.toThrow(new TypeError(`Invalid conformance profile: ${field}`));
    await expect(result).rejects.toMatchObject({ name: "TypeError", message: `Invalid conformance profile: ${field}` });
    expect(makeAdapter).not.toHaveBeenCalled();
  });

  it.each((["cancelConfirmMs", "pollMs", "jobTimeoutMs", "quiesceTimeoutMs", "settleMs"] as const)
    .flatMap((field) => [Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648].map((value) => ({ field, value }))))(
    "rejects invalid profile timing.$field=$value before making any adapter", async ({ field, value }) => {
      const fixture = fakeConformanceFixture();
      const makeAdapter = vi.fn(fixture.makeAdapter);
      fixture.profile.timing[field] = value;
      const result = runAdapterConformance(makeAdapter, fixture.profile);
      await expect(result).rejects.toThrow(new TypeError(`Invalid conformance profile: timing.${field}`));
      await expect(result).rejects.toMatchObject({ name: "TypeError", message: `Invalid conformance profile: timing.${field}` });
      expect(makeAdapter).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid profile timing.cancelWindow before making any adapter", async () => {
    const fixture = fakeConformanceFixture();
    const makeAdapter = vi.fn(fixture.makeAdapter);
    // Each member remains valid by itself; only the combined C4 window overflows.
    fixture.profile.timing.cancelConfirmMs = 2_147_483_647;
    const result = runAdapterConformance(makeAdapter, fixture.profile);
    await expect(result).rejects.toThrow(new TypeError("Invalid conformance profile: timing.cancelWindow"));
    await expect(result).rejects.toMatchObject({ name: "TypeError", message: "Invalid conformance profile: timing.cancelWindow" });
    expect(makeAdapter).not.toHaveBeenCalled();
  });

  it("times out the first factory without waiting for it and disposes its late adapter exactly once", async () => {
    const fixture = fakeConformanceFixture();
    const lateAdapter = fixture.makeAdapter();
    let release!: (adapter: MachineAdapter) => void;
    const delayedFactory = new Promise<MachineAdapter>((resolve) => { release = resolve; });
    let disposed!: () => void;
    const disposalObserved = new Promise<void>((resolve) => { disposed = resolve; });
    const originalDispose = lateAdapter.dispose.bind(lateAdapter);
    const dispose = vi.spyOn(lateAdapter, "dispose").mockImplementation(async () => {
      await originalDispose();
      disposed();
    });
    let calls = 0;
    const makeAdapter = () => ++calls === 1 ? delayedFactory : fixture.makeAdapter();
    const start = performance.now();
    try {
      // The first factory remains unresolved for the entire report. The bound
      // catches a runner that waits for it instead of advancing to fresh adapters.
      const report = await within(runAdapterConformance(makeAdapter, fixture.profile), 1_500);
      expect(performance.now() - start).toBeLessThan(1_500);
      expect(report.clauses.map((row) => row.status)).toEqual(faultVector("C1"));
      expect(report.clauses[0].reason).toBe("Adapter factory timed out.");
      expect(calls).toBe(10);
      expect(dispose).not.toHaveBeenCalled();
    } finally { release(lateAdapter); }
    await within(disposalObserved, 500);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("judges delivery-time snapshots when an adapter mutates each event object in a later tick", async () => {
    const mutated: DeviceEvent[] = [];
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      adapter.onEvidence = (listener) => device.onEvidence((event) => {
        listener(event);
        setImmediate(() => {
          event.payload[device.bindingKey] = "foreign-after-delivery";
          delete event.payload.mock;
          delete event.source.simulated;
          mutated.push(event);
        });
      });
      return adapter;
    } });
    const finish = fixture.profile.finish!;
    fixture.profile.finish = async (adapter, context) => {
      await finish(adapter, context);
      // Ensure mutations of started/progress/terminal objects precede the
      // clause's judgment, so retaining a listener's original object is caught.
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(PASS_VECTOR);
    expect(mutated.length).toBeGreaterThan(0);
    expect(mutated.every((event) => event.payload.deviceJobId === "foreign-after-delivery" &&
      !Object.hasOwn(event.payload, "mock") && !Object.hasOwn(event.source, "simulated"))).toBe(true);
  });
});
