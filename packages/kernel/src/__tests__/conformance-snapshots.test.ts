import { describe, expect, it } from "vitest";
import type { MachineAdapter } from "../adapters/types.js";
import { runAdapterConformance } from "../conformance/index.js";
import type { FakeDevice } from "../testing/fake-device.js";
import {
  fakeConformanceFixture, faultVector, forwardAdapter, type DeviceEvent,
} from "./helpers/conformance-fixtures.js";

const SNAPSHOT_REASON = "Evidence could not be snapshotted at delivery.";
const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

function unclonableProgress(device: FakeDevice): DeviceEvent {
  return {
    type: "execution_progress",
    timestamp: "2026-10-09T00:00:00.000Z",
    source: { ...device.source },
    payload: { [device.bindingKey]: "device-job-1", mock: true, callback: () => {} },
  };
}

/** Hand the original object directly to listeners, like IPP's emit loop. */
function rawPublisher(adapter: MachineAdapter, device: FakeDevice, swallow = false) {
  const listeners = new Set<(event: DeviceEvent) => void>();
  const errors: unknown[] = [];
  adapter.onEvidence = (listener) => { listeners.add(listener); device.onEvidence(listener); };
  return {
    errors,
    publish(event: DeviceEvent) {
      for (const listener of listeners) {
        if (swallow) {
          try { listener(event); } catch (error) { errors.push(error); }
        } else listener(event);
      }
    },
  };
}

describe("adapter conformance unsnapshotable deliveries", () => {
  it.each([true, false])("records finish evidence without throwing into a publisher (swallow=%s)", async (swallow) => {
    const publishers = new WeakMap<MachineAdapter, ReturnType<typeof rawPublisher>>();
    const caughtByPublisher: unknown[] = [];
    const escaped: unknown[] = [];
    let delivered = 0;
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      publishers.set(adapter, rawPublisher(adapter, device, swallow));
      return adapter;
    } });
    const finish = fixture.profile.finish!;
    fixture.profile.finish = async (adapter, context) => {
      const { device } = fixture.made.find((entry) => entry.adapter === adapter)!;
      const publisher = publishers.get(adapter)!;
      delivered++;
      try { publisher.publish(unclonableProgress(device)); } catch (error) { escaped.push(error); }
      caughtByPublisher.push(...publisher.errors);
      await finish(adapter, context);
    };
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    // Only C1/C2/C3/C6/C8 invoke finish; busy/cancel/dispose probes do not.
    expect(report.clauses.map((row) => row.status)).toEqual([
      "fail", "fail", "fail", "pass", "pass", "fail", "pass", "fail", "pass", "pass",
    ]);
    expect(report.clauses.filter((row) => row.status === "fail").map((row) => row.reason))
      .toEqual(Array.from({ length: 5 }, () => SNAPSHOT_REASON));
    expect(delivered).toBe(5);
    expect(escaped).toEqual([]);
    expect(caughtByPublisher).toEqual([]);
  });

  it("C7 counts unsnapshotable evidence delivered after dispose resolves", async () => {
    let deliveries = 0;
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      const publisher = rawPublisher(adapter, device, true);
      let started = false;
      adapter.execute = async (command) => {
        const result = await device.execute(command);
        if (command.type === "start" && result.success) started = true;
        return result;
      };
      adapter.dispose = async () => {
        await device.dispose();
        if (started) setImmediate(() => { deliveries++; publisher.publish(unclonableProgress(device)); });
      };
      return adapter;
    } });
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    await nextTick();
    expect(report.clauses.map((row) => row.status)).toEqual(faultVector("C7"));
    expect(report.clauses[6].reason).toBe(SNAPSHOT_REASON);
    expect(deliveries).toBe(8);
  });

  it("checks snapshot loss again after cleanup disposal, including clauses without jobs", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      const publisher = rawPublisher(adapter, device, true);
      adapter.dispose = async () => {
        await device.dispose();
        publisher.publish(unclonableProgress(device));
      };
      return adapter;
    } });
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(Array.from({ length: 10 }, () => "fail"));
    expect(report.clauses.map((row) => row.reason)).toEqual(Array.from({ length: 10 }, () => SNAPSHOT_REASON));
  });

  it("C1 counts unsnapshotable evidence after idle quiesce", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      const publisher = rawPublisher(adapter, device, true);
      let quiesces = 0;
      adapter.quiesceEvidence = async () => {
        await device.quiesceEvidence();
        if (++quiesces === 1) setImmediate(() => publisher.publish(unclonableProgress(device)));
      };
      return adapter;
    } });
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(faultVector("C1"));
    expect(report.clauses[0].reason).toBe(SNAPSHOT_REASON);
  });

  it("C10 counts unsnapshotable evidence from an undeclared command", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      const publisher = rawPublisher(adapter, device, true);
      adapter.execute = async (command) => {
        const result = await device.execute(command);
        if (command.type === "load_gcode") publisher.publish(unclonableProgress(device));
        return result;
      };
      return adapter;
    } });
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(faultVector("C10"));
    expect(report.clauses[9].reason).toBe(SNAPSHOT_REASON);
  });
});
