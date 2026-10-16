import { describe, expect, it } from "vitest";
import type { EvidenceEventType } from "@pcc/spec";
import type { MachineAdapter, MachineStatus } from "../adapters/types.js";
import { runAdapterConformance } from "../conformance/index.js";
import type { FakeDevice } from "../testing/fake-device.js";
import {
  fakeConformanceFixture, faultVector, forwardAdapter, PASS_VECTOR,
  transformEvents, type DeviceEvent,
} from "./helpers/conformance-fixtures.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function progressEvent(device: FakeDevice, jobId = "device-job-1"): DeviceEvent {
  return {
    type: "execution_progress",
    timestamp: "2026-10-09T00:00:00.000Z",
    source: { ...device.source },
    payload: { [device.bindingKey]: jobId, mock: true },
  };
}

function directPublisher(adapter: MachineAdapter, device: FakeDevice): (event: DeviceEvent) => void {
  const listeners = new Set<(event: DeviceEvent) => void>();
  adapter.onEvidence = (listener) => {
    listeners.add(listener);
    device.onEvidence(listener);
  };
  return (event) => { for (const listener of listeners) listener(structuredClone(event)); };
}

async function expectVector(
  fixture: ReturnType<typeof fakeConformanceFixture>,
  expected: string[],
): Promise<void> {
  const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
  expect(report.clauses.map((row) => row.status)).toEqual(expected);
}

describe("adapter conformance contract edges", () => {
  it("C1 checks silence after the idle quiesce resolution before new work", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      const publish = directPublisher(adapter, device);
      let started = false;
      adapter.execute = async (command) => {
        const result = await device.execute(command);
        if (command.type === "start" && result.success) started = true;
        return result;
      };
      adapter.quiesceEvidence = async () => {
        await device.quiesceEvidence();
        if (!started) setImmediate(() => publish(progressEvent(device)));
      };
      return adapter;
    } });
    await expectVector(fixture, faultVector("C1"));
  });

  it("C1 retains its quiesce-resolution boundary while an asynchronous finish hook waits", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      const publish = directPublisher(adapter, device);
      let started = false;
      let disposed = false;
      adapter.execute = async (command) => {
        const result = await device.execute(command);
        if (command.type === "start" && result.success) started = true;
        return result;
      };
      adapter.quiesceEvidence = async () => {
        await device.quiesceEvidence();
        if (started) setTimeout(() => { if (!disposed) publish(progressEvent(device)); }, 1);
      };
      adapter.dispose = async () => { disposed = true; await device.dispose(); };
      return adapter;
    } });
    const finish = fixture.profile.finish!;
    fixture.profile.finish = async (adapter, context) => {
      await finish(adapter, context);
      await delay(20);
    };
    await expectVector(fixture, faultVector("C1"));
  });

  it("C1 rejects early quiesce when an autonomous terminal is beyond the silence window", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      let terminal: Promise<void> | undefined;
      adapter.execute = async (command) => {
        const result = await device.execute(command);
        if (command.type === "start" && result.success) {
          terminal = delay(120).then(async () => {
            if (await device.getStatus() === "busy") device.complete();
          });
        }
        return result;
      };
      adapter.quiesceEvidence = async () => {};
      // Let even C1's terminal arrive after its silence window, during cleanup.
      adapter.dispose = async () => { await terminal; await device.dispose(); };
      return adapter;
    } });
    fixture.profile.finish = undefined;
    fixture.profile.timing.jobTimeoutMs = 400;
    fixture.profile.timing.quiesceTimeoutMs = 400;
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(faultVector("C1"));
    expect(report.clauses[0].reason).toBe("Quiesce resolved before terminal delivery.");
  });

  it("C4 observes an adapter's own this.execute stop even when foreign cancellation is benign", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      adapter.cancelJob = async function (this: MachineAdapter, jobId) {
        if (jobId === "device-job-1") await this.execute({ type: "stop" });
        else await device.cancelJob(jobId);
      };
      return adapter;
    } });
    await expectVector(fixture, faultVector("C4"));
  });

  it("C7 refuses to claim a running-dispose probe after synchronous completion", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      adapter.execute = async (command) => {
        const result = await device.execute(command);
        if (command.type === "start" && result.success) device.complete();
        return result;
      };
      return adapter;
    } });
    // A device that completes in start cannot exercise the profile's busy or
    // running-dispose probes. Other rows require no scripted finish action.
    fixture.profile.finish = undefined;
    fixture.profile.busy = "none";
    const expected = faultVector("C7", { C5: "n/a" });
    await expectVector(fixture, expected);
  });

  it("C2 strictly distinguishes numeric IPP ids from string evidence ids", async () => {
    const fixture = fakeConformanceFixture({ preset: "ipp", wrap(device) {
      const adapter = transformEvents(device, (event) => {
        event.payload[device.bindingKey] = String(event.payload[device.bindingKey]);
        return event;
      });
      adapter.execute = async (command) => {
        const result = await device.execute(command);
        // Progress during the busy probe also exercises C5's strict id check.
        if (result.busy) device.progress(25);
        return result;
      };
      return adapter;
    } });
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(faultVector("C2", { C5: "fail" }));
    expect(report.clauses[1].reason).toBe("Evidence did not strictly bind to the accepted device job id.");
    expect(report.clauses[4].reason).toBe("Second start emitted evidence for a new device job.");
  });

  it("C4 alone rejects a cancellation failure without device origin", async () => {
    const fixture = fakeConformanceFixture({ wrap: (device) => transformEvents(device, (event) => {
      if (event.type === "execution_failed") delete event.payload.origin;
      return event;
    }) });
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(faultVector("C4"));
    expect(report.clauses[3].reason).toBe("Cancellation failure did not have device origin.");
  });

  it("C3 alone rejects a job's failed terminal without device origin", async () => {
    const fixture = fakeConformanceFixture({ wrap: (device) => transformEvents(device, (event) => {
      if (event.payload.finishFailure === true) delete event.payload.origin;
      return event;
    }) });
    fixture.profile.finish = (adapter) => {
      fixture.made.find((entry) => entry.adapter === adapter)!.device.fail({ finishFailure: true });
    };
    await expectVector(fixture, faultVector("C3"));
  });

  it("C5 rejects a busy refusal that returns a new data.jobId", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      adapter.execute = async (command) => {
        const result = await device.execute(command);
        return result.busy ? { ...result, data: { ...result.data, jobId: "second-job" } } : result;
      };
      return adapter;
    } });
    await expectVector(fixture, faultVector("C5"));
  });

  it("C5 rejects a busy refusal that emits evidence naming a second device job", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      const publish = directPublisher(adapter, device);
      adapter.execute = async (command) => {
        const result = await device.execute(command);
        if (result.busy) publish(progressEvent(device, "second-job"));
        return result;
      };
      return adapter;
    } });
    await expectVector(fixture, faultVector("C5"));
  });

  it("C10 rejects an undeclared refusal that emits evidence", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      const publish = directPublisher(adapter, device);
      adapter.execute = async (command) => {
        const result = await device.execute(command);
        if (command.type === "load_gcode") publish(progressEvent(device));
        return result;
      };
      return adapter;
    } });
    await expectVector(fixture, faultVector("C10"));
  });

  it("C10 rejects an undeclared refusal that changes status", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      let status: MachineStatus | undefined;
      adapter.getStatus = async () => status ?? device.getStatus();
      adapter.execute = async (command) => {
        const result = await device.execute(command);
        if (command.type === "load_gcode") status = "error";
        return result;
      };
      return adapter;
    } });
    await expectVector(fixture, faultVector("C10"));
  });

  it("honors a custom binding and custom terminal vocabulary", async () => {
    const fixture = customTerminalFixture();
    await expectVector(fixture, PASS_VECTOR);
  });

  it.each(["execution_completed", "execution_failed"] as const)(
    "retains the native %s terminal rule with a custom profile", async (terminal) => {
      const fixture = customTerminalFixture();
      fixture.profile.finish = (adapter) => {
        fixture.made.find((entry) => entry.adapter === adapter)!.device.emit(terminal);
      };
      await expectVector(fixture, PASS_VECTOR);
    },
  );

  it("C3 requires device origin on a native failed terminal under a custom profile", async () => {
    const fixture = customTerminalFixture((device) => transformEvents(device, (event) => {
      if (event.payload.finishFailure === true) delete event.payload.origin;
      return event;
    }));
    fixture.profile.finish = (adapter) => {
      fixture.made.find((entry) => entry.adapter === adapter)!.device.emit("execution_failed", { finishFailure: true });
    };
    await expectVector(fixture, faultVector("C3"));
  });
});

function customTerminalFixture(wrap?: (device: FakeDevice) => MachineAdapter) {
  const completed: EvidenceEventType = "batch_session_completed";
  const failed: EvidenceEventType = "sensor_anomaly_detected";
  const fixture = fakeConformanceFixture({
    ...(wrap ? { wrap } : {}),
    deviceOptions: {
      bindingKey: "operationId", startedType: "sequence_started", progressType: "batch_sample_result",
      completedType: completed, failedType: failed,
    },
  });
  fixture.profile.bindingKey = "operationId";
  fixture.profile.terminalEvents = { completed: [completed], failed: [failed] };
  return fixture;
}
