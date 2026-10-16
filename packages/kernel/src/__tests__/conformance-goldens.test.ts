import { describe, expect, it } from "vitest";
import { MockFDMAdapter } from "../adapters/mock-fdm.js";
import { IppAdapter } from "../adapters/ipp-adapter.js";
import { runAdapterConformance, type ConformanceProfile } from "../conformance/index.js";

describe("adapter conformance production adapter goldens", () => {
  it("pins the full MockFDMAdapter report, including every fail and n/a reason", async () => {
    const profile: ConformanceProfile = {
      name: "MockFDMAdapter",
      kind: "physical",
      mode: "mock",
      bindingKey: "deviceJobId",
      declaredCommands: ["load_gcode", "start", "pause", "stop", "status"],
      busy: "second-start",
      timing: { cancelConfirmMs: 50, pollMs: 5, jobTimeoutMs: 500, quiesceTimeoutMs: 500, settleMs: 10 },
      async prepareStart(adapter) {
        await adapter.execute({ type: "load_gcode", payload: { gcodeHash: "conformance-gcode" } });
      },
      startCommand: () => ({ type: "start" }),
    };
    const report = await runAdapterConformance(
      () => new MockFDMAdapter("conformance-fdm", "conformance-kernel", 100), profile,
    );
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
            "reason": "Accepted start did not return a device job id.",
            "status": "fail",
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
            "reason": "Adapter has no cancelJob function.",
            "status": "n/a",
            "title": "Job-scoped cancellation",
          },
          {
            "id": "C5",
            "reason": "Second start did not refuse with busy true.",
            "status": "fail",
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
            "reason": "Physical adapter has no cancelJob function.",
            "status": "fail",
            "title": "Physical cancellation support",
          },
          {
            "id": "C10",
            "reason": "Undeclared command refuses silently without changing status.",
            "status": "pass",
            "title": "Undeclared commands",
          },
        ],
        "digest": "sha256:a41efd3f1fffb573664a24d1aea3015eda64e9c83ab55e9f22f627f02a07d1be",
        "profile": {
          "bindingKey": "deviceJobId",
          "busy": "second-start",
          "declaredCommands": [
            "load_gcode",
            "start",
            "pause",
            "stop",
            "status",
          ],
          "kind": "physical",
          "mode": "mock",
          "name": "MockFDMAdapter",
          "terminalEvents": {
            "completed": [
              "execution_completed",
            ],
            "failed": [
              "execution_failed",
            ],
          },
          "timing": {
            "cancelConfirmMs": 50,
            "jobTimeoutMs": 500,
            "pollMs": 5,
            "quiesceTimeoutMs": 500,
            "settleMs": 10,
          },
        },
        "suite": "pcc.adapter-conformance/v1",
      }
    `);
  });

  it("pins the full one-page IppAdapter mock report, including every fail and n/a reason", async () => {
    const profile: ConformanceProfile = {
      name: "IppAdapter mock one page",
      kind: "physical",
      mode: "mock",
      bindingKey: "ippJobId",
      declaredCommands: ["start", "pause", "resume", "stop", "status"],
      busy: "second-start",
      timing: { cancelConfirmMs: 50, pollMs: 5, jobTimeoutMs: 3_000, quiesceTimeoutMs: 3_000, settleMs: 10 },
      startCommand: () => ({ type: "start", payload: { totalPages: 1, jobName: "conformance.pdf" } }),
    };
    const report = await runAdapterConformance(
      () => new IppAdapter("conformance-ipp", {
        uri: "ipp://conformance.invalid/ipp/print", kernelId: "conformance-kernel", mockMode: true,
      }), profile,
    );
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
            "reason": "Undeclared command was not refused.",
            "status": "fail",
            "title": "Undeclared commands",
          },
        ],
        "digest": "sha256:caa72d43ba308cd0a4731fee6228871917ed941150dcfa47d6116f5fe590769d",
        "profile": {
          "bindingKey": "ippJobId",
          "busy": "second-start",
          "declaredCommands": [
            "start",
            "pause",
            "resume",
            "stop",
            "status",
          ],
          "kind": "physical",
          "mode": "mock",
          "name": "IppAdapter mock one page",
          "terminalEvents": {
            "completed": [
              "execution_completed",
            ],
            "failed": [
              "execution_failed",
            ],
          },
          "timing": {
            "cancelConfirmMs": 50,
            "jobTimeoutMs": 3000,
            "pollMs": 5,
            "quiesceTimeoutMs": 3000,
            "settleMs": 10,
          },
        },
        "suite": "pcc.adapter-conformance/v1",
      }
    `);
  }, 30_000);
});
