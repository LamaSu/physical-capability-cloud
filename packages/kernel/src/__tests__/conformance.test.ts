import { describe, expect, it, vi } from "vitest";
import { canonicalize, sha256 } from "@pcc/spec";
import type { MachineAdapter } from "../adapters/types.js";
import { runAdapterConformance } from "../conformance/index.js";
import { DEVICE_FAULTS, type DeviceFault } from "./helpers/device-faults.js";
import {
  fakeConformanceFixture,
  faultVector,
  forwardAdapter,
  PASS_VECTOR,
  transformEvents,
} from "./helpers/conformance-fixtures.js";

const faultClauses: Record<DeviceFault, string> = {
  emitAfterQuiesce: "C1",
  quiesceEarly: "C1",
  foreignDeviceJob: "C2",
  unboundTerminal: "C2",
  noDeviceJobId: "C2",
  doubleTerminal: "C3",
  cancelOtherJob: "C4",
  stopInsteadOfCancel: "C4",
  busyWithoutFlag: "C5",
  untagged: "C6",
  emitAfterDispose: "C7",
  payloadJobId: "C8",
  noCancelJob: "C9",
  acceptsUndeclared: "C10",
};

const faultReasons: Record<DeviceFault, string> = {
  emitAfterQuiesce: "Evidence arrived after quiesce resolved.",
  quiesceEarly: "Quiesce resolved before terminal delivery.",
  foreignDeviceJob: "Evidence did not strictly bind to the accepted device job id.",
  unboundTerminal: "Evidence did not strictly bind to the accepted device job id.",
  noDeviceJobId: "Accepted start did not return a device job id.",
  doubleTerminal: "Job did not emit exactly one terminal event.",
  cancelOtherJob: "Foreign cancellation emitted a failed terminal.",
  // The fault invokes the inner device's stop, outside the runner's execute spy.
  stopInsteadOfCancel: "Foreign cancellation emitted a failed terminal.",
  busyWithoutFlag: "Second start did not refuse with busy true.",
  untagged: "Evidence fabrication tags disagree with profile mode.",
  emitAfterDispose: "Evidence arrived after dispose resolved.",
  payloadJobId: "Evidence supplied a foreign PCC job id or a reserved unit field.",
  noCancelJob: "Physical adapter has no cancelJob function.",
  acceptsUndeclared: "Undeclared command was not refused.",
};

describe("adapter conformance", () => {
  it("pins the honest generic FakeDevice full report", async () => {
    const { makeAdapter, profile } = fakeConformanceFixture();
    const report = await runAdapterConformance(makeAdapter, profile);
    expect(report.clauses.map((row) => row.status)).toEqual(PASS_VECTOR);
    expect(report).toMatchInlineSnapshot(`
      {
        "clauses": [
          {
            "id": "C1",
            "reason": "Quiesce waits for terminal delivery and stays silent.",
            "status": "pass",
            "title": "Quiesce honesty",
          },
          {
            "id": "C2",
            "reason": "Start and every job event share the device job id.",
            "status": "pass",
            "title": "Device-job binding",
          },
          {
            "id": "C3",
            "reason": "Job emits one terminal with device origin on failure.",
            "status": "pass",
            "title": "One terminal per job",
          },
          {
            "id": "C4",
            "reason": "Cancellation preserves foreign jobs and confirms its own without stop.",
            "status": "pass",
            "title": "Job-scoped cancellation",
          },
          {
            "id": "C5",
            "reason": "Second start refuses busy without creating another job.",
            "status": "pass",
            "title": "Busy refusal",
          },
          {
            "id": "C6",
            "reason": "Every job event has the profile's fabrication classification.",
            "status": "pass",
            "title": "Fabrication tags",
          },
          {
            "id": "C7",
            "reason": "Dispose stays silent with a job running.",
            "status": "pass",
            "title": "Dispose silence",
          },
          {
            "id": "C8",
            "reason": "Evidence respects PCC job and unit field ownership.",
            "status": "pass",
            "title": "PCC job fields",
          },
          {
            "id": "C9",
            "reason": "Physical adapter provides cancelJob.",
            "status": "pass",
            "title": "Physical cancellation support",
          },
          {
            "id": "C10",
            "reason": "Undeclared command refuses silently without changing status.",
            "status": "pass",
            "title": "Undeclared commands",
          },
        ],
        "digest": "sha256:b7ed2909ca4e895610063631271ebb5a35f2dc8424f8a686867c45a238fdce4e",
        "profile": {
          "bindingKey": "deviceJobId",
          "busy": "second-start",
          "declaredCommands": [
            "start",
            "stop",
            "status",
          ],
          "kind": "physical",
          "mode": "mock",
          "name": "FakeDevice generic",
          "terminalEvents": {
            "completed": [
              "execution_completed",
            ],
            "failed": [
              "execution_failed",
            ],
          },
          "timing": {
            "cancelConfirmMs": 35,
            "jobTimeoutMs": 100,
            "pollMs": 5,
            "quiesceTimeoutMs": 50,
            "settleMs": 10,
          },
        },
        "suite": "pcc.adapter-conformance/v1",
      }
    `);
  });

  it("pins the honest ipp FakeDevice full report", async () => {
    const { makeAdapter, profile } = fakeConformanceFixture({ preset: "ipp" });
    const report = await runAdapterConformance(makeAdapter, profile);
    expect(report.clauses.map((row) => row.status)).toEqual(PASS_VECTOR);
    expect(report).toMatchInlineSnapshot(`
      {
        "clauses": [
          {
            "id": "C1",
            "reason": "Quiesce waits for terminal delivery and stays silent.",
            "status": "pass",
            "title": "Quiesce honesty",
          },
          {
            "id": "C2",
            "reason": "Start and every job event share the device job id.",
            "status": "pass",
            "title": "Device-job binding",
          },
          {
            "id": "C3",
            "reason": "Job emits one terminal with device origin on failure.",
            "status": "pass",
            "title": "One terminal per job",
          },
          {
            "id": "C4",
            "reason": "Cancellation preserves foreign jobs and confirms its own without stop.",
            "status": "pass",
            "title": "Job-scoped cancellation",
          },
          {
            "id": "C5",
            "reason": "Second start refuses busy without creating another job.",
            "status": "pass",
            "title": "Busy refusal",
          },
          {
            "id": "C6",
            "reason": "Every job event has the profile's fabrication classification.",
            "status": "pass",
            "title": "Fabrication tags",
          },
          {
            "id": "C7",
            "reason": "Dispose stays silent with a job running.",
            "status": "pass",
            "title": "Dispose silence",
          },
          {
            "id": "C8",
            "reason": "Evidence respects PCC job and unit field ownership.",
            "status": "pass",
            "title": "PCC job fields",
          },
          {
            "id": "C9",
            "reason": "Physical adapter provides cancelJob.",
            "status": "pass",
            "title": "Physical cancellation support",
          },
          {
            "id": "C10",
            "reason": "Undeclared command refuses silently without changing status.",
            "status": "pass",
            "title": "Undeclared commands",
          },
        ],
        "digest": "sha256:3e0e15aded13cf3f4b0d41fb119e26afadb31025b623f30092516b0b578ef7c8",
        "profile": {
          "bindingKey": "ippJobId",
          "busy": "second-start",
          "declaredCommands": [
            "start",
            "stop",
            "status",
          ],
          "kind": "physical",
          "mode": "mock",
          "name": "FakeDevice ipp",
          "terminalEvents": {
            "completed": [
              "execution_completed",
            ],
            "failed": [
              "execution_failed",
            ],
          },
          "timing": {
            "cancelConfirmMs": 35,
            "jobTimeoutMs": 100,
            "pollMs": 5,
            "quiesceTimeoutMs": 50,
            "settleMs": 10,
          },
        },
        "suite": "pcc.adapter-conformance/v1",
      }
    `);
  });

  it.each(DEVICE_FAULTS.map((fault) => [fault, faultClauses[fault]] as const))(
    "fault %s fails only %s",
    async (fault, clause) => {
      const { makeAdapter, profile } = fakeConformanceFixture({ fault });
      const report = await runAdapterConformance(makeAdapter, profile);
      expect(report.clauses.map((row) => row.status)).toEqual(
        faultVector(clause, fault === "noCancelJob" ? { C4: "n/a" } : {}),
      );
      expect(report.clauses.filter((row) => row.status !== "pass").map(({ id, reason }) => ({ id, reason })))
        .toEqual(fault === "noCancelJob" ? [
          { id: "C4", reason: "Adapter has no cancelJob function." },
          { id: clause, reason: faultReasons[fault] },
        ] : [{ id: clause, reason: faultReasons[fault] }]);
    },
  );

  it("digest is deterministic and pins the reasons without hooks or trust claims", async () => {
    const { makeAdapter, profile } = fakeConformanceFixture();
    const first = await runAdapterConformance(makeAdapter, profile);
    const second = await runAdapterConformance(makeAdapter, profile);
    expect(second).toEqual(first);
    const { digest, ...unsigned } = first;
    expect(digest).toBe(await sha256(canonicalize(unsigned)));
    expect(first).toMatchInlineSnapshot(`
      {
        "clauses": [
          {
            "id": "C1",
            "reason": "Quiesce waits for terminal delivery and stays silent.",
            "status": "pass",
            "title": "Quiesce honesty",
          },
          {
            "id": "C2",
            "reason": "Start and every job event share the device job id.",
            "status": "pass",
            "title": "Device-job binding",
          },
          {
            "id": "C3",
            "reason": "Job emits one terminal with device origin on failure.",
            "status": "pass",
            "title": "One terminal per job",
          },
          {
            "id": "C4",
            "reason": "Cancellation preserves foreign jobs and confirms its own without stop.",
            "status": "pass",
            "title": "Job-scoped cancellation",
          },
          {
            "id": "C5",
            "reason": "Second start refuses busy without creating another job.",
            "status": "pass",
            "title": "Busy refusal",
          },
          {
            "id": "C6",
            "reason": "Every job event has the profile's fabrication classification.",
            "status": "pass",
            "title": "Fabrication tags",
          },
          {
            "id": "C7",
            "reason": "Dispose stays silent with a job running.",
            "status": "pass",
            "title": "Dispose silence",
          },
          {
            "id": "C8",
            "reason": "Evidence respects PCC job and unit field ownership.",
            "status": "pass",
            "title": "PCC job fields",
          },
          {
            "id": "C9",
            "reason": "Physical adapter provides cancelJob.",
            "status": "pass",
            "title": "Physical cancellation support",
          },
          {
            "id": "C10",
            "reason": "Undeclared command refuses silently without changing status.",
            "status": "pass",
            "title": "Undeclared commands",
          },
        ],
        "digest": "sha256:b7ed2909ca4e895610063631271ebb5a35f2dc8424f8a686867c45a238fdce4e",
        "profile": {
          "bindingKey": "deviceJobId",
          "busy": "second-start",
          "declaredCommands": [
            "start",
            "stop",
            "status",
          ],
          "kind": "physical",
          "mode": "mock",
          "name": "FakeDevice generic",
          "terminalEvents": {
            "completed": [
              "execution_completed",
            ],
            "failed": [
              "execution_failed",
            ],
          },
          "timing": {
            "cancelConfirmMs": 35,
            "jobTimeoutMs": 100,
            "pollMs": 5,
            "quiesceTimeoutMs": 50,
            "settleMs": 10,
          },
        },
        "suite": "pcc.adapter-conformance/v1",
      }
    `);
    expect(JSON.stringify(first)).not.toContain(["demon", "strated"].join(""));
    expect(first.profile).not.toHaveProperty("prepareStart");
    expect(first.profile).not.toHaveProperty("startCommand");
    expect(first.profile).not.toHaveProperty("finish");
  });

  it("creates a fresh adapter for every clause and disposes each exactly once", async () => {
    const disposals = new WeakMap<MachineAdapter, MachineAdapter["dispose"]>();
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      const dispose = vi.fn(() => device.dispose());
      adapter.dispose = dispose;
      disposals.set(adapter, dispose);
      return adapter;
    } });
    const report = await runAdapterConformance(async () => fixture.makeAdapter(), fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(PASS_VECTOR);
    expect(fixture.made).toHaveLength(10);
    expect(new Set(fixture.made.map(({ adapter }) => adapter)).size).toBe(10);
    for (const { adapter } of fixture.made) expect(disposals.get(adapter)).toHaveBeenCalledTimes(1);
  });

  it("a never-resolving quiesce fails C1 within its bound and the full run finishes", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      adapter.quiesceEvidence = () => new Promise(() => {});
      return adapter;
    } });
    const started = Date.now();
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses[0].status).toBe("fail");
    expect(report.clauses[0].reason).toMatch(/quiesce.*(?:bound|timeout|timed out)/i);
    expect(report.clauses).toHaveLength(10);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a never-settling start fails C1 within its bound and the full run finishes", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      adapter.execute = (command) => command.type === "start"
        ? new Promise(() => {}) : device.execute(command);
      return adapter;
    } });
    const started = Date.now();
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses[0].status).toBe("fail");
    expect(report.clauses[0].reason).toMatch(/start.*(?:bound|timeout|timed out)/i);
    expect(report.clauses).toHaveLength(10);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a never-settling cancel fails C4 and still disposes every adapter", async () => {
    const dispose = vi.fn();
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      adapter.cancelJob = () => new Promise(() => {});
      adapter.dispose = async () => { dispose(); await device.dispose(); };
      return adapter;
    } });
    const started = Date.now();
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(faultVector("C4"));
    expect(dispose).toHaveBeenCalledTimes(10);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("C4 shares one confirmation deadline between cancel resolution and terminal delivery", async () => {
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      adapter.cancelJob = async (id) => {
        if (id !== "device-job-1") return;
        // A 115ms window must cover both this 80ms call and the following
        // 80ms terminal delay. Giving each operation a fresh window is wrong.
        await new Promise((resolve) => setTimeout(resolve, 80));
        setTimeout(() => {
          void device.getStatus().then((status) => {
            if (status === "busy") device.fail();
          });
        }, 80);
      };
      return adapter;
    } });
    fixture.profile.timing.cancelConfirmMs = 100;
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(faultVector("C4"));
  });

  it("a never-settling dispose fails within its bound and never hangs the run", async () => {
    const dispose = vi.fn();
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      adapter.dispose = async () => {
        dispose();
        await device.dispose();
        await new Promise(() => {});
      };
      return adapter;
    } });
    const started = Date.now();
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.every((row) => row.status === "fail")).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(10);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("disposes every adapter when preparation rejects", async () => {
    const dispose = vi.fn();
    const fixture = fakeConformanceFixture({ wrap(device) {
      const adapter = forwardAdapter(device);
      adapter.dispose = async () => { dispose(); await device.dispose(); };
      return adapter;
    } });
    fixture.profile.prepareStart = async () => { throw new Error("deliberate preparation rejection"); };
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses).toHaveLength(10);
    expect(dispose).toHaveBeenCalledTimes(10);
  });

  it.each([
    ["mock", "payload", "pass"], ["mock", "source", "pass"],
    ["real", "payload", "fail"], ["real", "source", "fail"],
    ["real", "neither", "pass"],
  ] as const)("C6 mode %s uses the canonical predicate for %s-only fabrication", async (mode, tag, status) => {
    const fixture = fakeConformanceFixture({ wrap: (device) => transformEvents(device, (event) => {
      if (tag !== "source") delete event.source.simulated;
      if (tag !== "payload") delete event.payload.mock;
      return event;
    }) });
    fixture.profile.mode = mode;
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    const expected = [...PASS_VECTOR];
    expected[5] = status;
    expect(report.clauses.map((row) => row.status)).toEqual(expected);
  });

  it.each(["settlementUnitId", "challengeNonce"])("C8 refuses adapter-supplied %s", async (field) => {
    const fixture = fakeConformanceFixture({ wrap: (device) => transformEvents(device, (event) => {
      event.payload[field] = "adapter-supplied";
      return event;
    }) });
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(faultVector("C8"));
  });

  it("C8 allows the context PCC job id on events", async () => {
    let currentPccJobId = "";
    const fixture = fakeConformanceFixture({ wrap: (device) => transformEvents(device, (event) => {
      event.payload.jobId = currentPccJobId;
      return event;
    }) });
    fixture.profile.startCommand = (_adapter, { pccJobId }) => {
      currentPccJobId = pccJobId;
      return { type: "start" };
    };
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(PASS_VECTOR);
  });

  it("reports digital cancellation, disabled busy, and all-declared commands as n/a", async () => {
    const fixture = fakeConformanceFixture({ fault: "noCancelJob", deviceOptions: {
      declaredCommands: ["load_gcode", "start", "pause", "resume", "stop", "status"],
    } });
    fixture.profile.kind = "digital";
    fixture.profile.busy = "none";
    fixture.profile.declaredCommands = ["load_gcode", "start", "pause", "resume", "stop", "status"];
    const report = await runAdapterConformance(fixture.makeAdapter, fixture.profile);
    expect(report.clauses.map((row) => row.status)).toEqual(
      PASS_VECTOR.map((status, index) => [3, 4, 8, 9].includes(index) ? "n/a" : status),
    );
  });

  it.each([
    ["name", ""], ["kind", "invalid"], ["mode", "invalid"], ["bindingKey", ""],
    ["declaredCommands", ["invalid"]], ["busy", "invalid"],
    ["timing", { cancelConfirmMs: 5, pollMs: 1, jobTimeoutMs: -1, quiesceTimeoutMs: 5, settleMs: 1 }],
    ["startCommand", undefined],
  ])("rejects invalid profile %s before making any adapter", async (field, value) => {
    const fixture = fakeConformanceFixture();
    const makeAdapter = vi.fn(fixture.makeAdapter);
    const profile = { ...fixture.profile, [field]: value };
    await expect(runAdapterConformance(makeAdapter, profile as typeof fixture.profile)).rejects.toThrow();
    expect(makeAdapter).not.toHaveBeenCalled();
  });
});
